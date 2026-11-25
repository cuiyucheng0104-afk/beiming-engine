// M3 O13：看板「核心对 Cycles」行（1..8 级阶梯门控聚合、判红/unset 自动退级、速度比与硬件口径强制校验、HTML 渲染与 CLI 每日自动更新）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FILM_TYPES, appendBoardHistory, buildBoard, renderBoardHtml } from './board.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = join(HERE, 'board.mjs');
const AS_OF = '2026-11-25';
const isBadArgument = (e) => e.code === 'usage.bad-argument' && e.exitCode === 2 && (e instanceof TypeError || e instanceof RangeError);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

const runCli = (args) => {
  const res = spawnSync(process.execPath, [BOARD_CLI, ...args], { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
};

const makeSpeed = (overrides = {}) => ({
  coreMs: 500,
  cyclesMs: 2000,
  gpu: 'RTX 5090',
  samples: 256,
  resolution: [1920, 1080],
  ...overrides,
});

const makeGates = (statuses) => statuses.map((status, idx) => ({
  level: idx + 1,
  status,
  gateId: `gate.level${idx + 1}`,
}));

/* ---------------- 测试 1：阶梯连续过级与自动退级 ---------------- */

test('O13-1：零态输出、连续过级 L1→L2→L3、L3 判红/unset 自动退回 L2、L1 fail 退回 0、缺级不跳级与多文件聚合', () => {
  // 未传 coreVsCycles 时保持旧快照键兼容，静态页照常渲染零态
  const omittedBoard = buildBoard({ asOf: AS_OF });
  assert.equal(Object.hasOwn(omittedBoard, 'coreVsCycles'), false);
  const omittedHtml = renderBoardHtml(omittedBoard);
  assert.ok(omittedHtml.includes('<h2>核心对 Cycles</h2>') && omittedHtml.includes('L0 / L8') && omittedHtml.includes('暂无核心对 Cycles 门控读数'));

  // 空数组与空 entries 输出深冻结安全零态
  for (const input of [{ asOf: AS_OF, coreVsCycles: [] }, { asOf: AS_OF, coreVsCycles: { entries: [] } }]) {
    const board = buildBoard(input);
    assert.ok(Object.isFrozen(board.coreVsCycles));
    assert.ok(Object.isFrozen(board.coreVsCycles.overall));
    assert.ok(Object.isFrozen(board.coreVsCycles.byFilmType));
    assert.ok(Object.isFrozen(board.coreVsCycles.scenes));
    assert.equal(board.coreVsCycles.maxLevel, 8);
    assert.deepEqual(board.coreVsCycles.overall, { maxPassedLevel: 0, sceneCount: 0, blockedCount: 0, speedCount: 0 });
    assert.deepEqual(Object.keys(board.coreVsCycles.byFilmType), ['motion-explainer', 'hard-surface', 'toon', 'realtime-3d']);
    for (const { id, label } of FILM_TYPES) {
      assert.ok(Object.isFrozen(board.coreVsCycles.byFilmType[id]));
      assert.deepEqual(board.coreVsCycles.byFilmType[id], { label, maxPassedLevel: 0, sceneCount: 0, blockedCount: 0 });
    }
    assert.deepEqual(board.coreVsCycles.scenes, []);
  }

  // 连续通过 L1 → L2 → L3：passedLevel = 3，无阻塞
  const pass3 = buildBoard({
    asOf: AS_OF,
    coreVsCycles: {
      entries: [
        {
          filmType: 'hard-surface',
          scene: 'chassis-head',
          gates: [
            { level: 1, status: 'pass', gateId: 'level1.fncheck' },
            { level: 2, status: 'pass', gateId: 'level2.furnace-metal' },
            { level: 2, status: 'pass', gateId: 'level2.analytic' },
            { level: 3, status: 'pass', gateId: 'v19.floorgate', metric: 'seedVsSeedFlipMean', value: 0.012, threshold: 0.025 },
          ],
          speed: makeSpeed(),
        },
      ],
    },
  });
  assert.equal(pass3.coreVsCycles.scenes.length, 1);
  assert.equal(pass3.coreVsCycles.scenes[0].passedLevel, 3);
  assert.equal(pass3.coreVsCycles.scenes[0].blockedAtLevel, null);
  assert.equal(pass3.coreVsCycles.scenes[0].blockedReason, null);
  assert.deepEqual(pass3.coreVsCycles.byFilmType['hard-surface'], {
    label: '硬表面与写实',
    maxPassedLevel: 3,
    sceneCount: 1,
    blockedCount: 0,
  });
  assert.deepEqual(pass3.coreVsCycles.overall, { maxPassedLevel: 3, sceneCount: 1, blockedCount: 0, speedCount: 1 });

  // L3 判红（即使 L3 有另一道门通过、甚至 L4 也通过）自动退回 L2，并标注 blockedAtLevel=3 / blockedReason='fail'
  const fail3 = buildBoard({
    asOf: AS_OF,
    coreVsCycles: [
      {
        filmType: 'hard-surface',
        scene: 'chassis-head',
        gates: [
          { level: 1, status: 'pass', gateId: 'level1.fncheck' },
          { level: 2, status: 'pass', gateId: 'level2.furnace-metal' },
          { level: 3, status: 'pass', gateId: 'v19.welch' },
          { level: 3, status: 'fail', gateId: 'v19.floorgate', metric: 'seedVsSeedFlipMean', value: 0.04, threshold: 0.025 },
          { level: 4, status: 'pass', gateId: 'v19.level4-bevel' },
        ],
      },
    ],
  });
  assert.equal(fail3.coreVsCycles.scenes[0].passedLevel, 2);
  assert.equal(fail3.coreVsCycles.scenes[0].blockedAtLevel, 3);
  assert.equal(fail3.coreVsCycles.scenes[0].blockedReason, 'fail');
  assert.deepEqual(fail3.coreVsCycles.byFilmType['hard-surface'], {
    label: '硬表面与写实',
    maxPassedLevel: 2,
    sceneCount: 1,
    blockedCount: 1,
  });

  // L3 为 unset（例如参考包 floor 未填全）同样不判过，自动退回 L2 并标注 blockedReason='unset'
  const unset3 = buildBoard({
    asOf: AS_OF,
    coreVsCycles: [
      {
        filmType: 'hard-surface',
        scene: 'chassis-head',
        gates: [
          { level: 1, status: 'pass', gateId: 'level1.fncheck' },
          { level: 2, status: 'pass', gateId: 'level2.furnace-metal' },
          { level: 3, status: 'unset', gateId: 'v19.floorgate', metric: 'seedVsSeedFlipMean', value: 0.01 },
        ],
      },
    ],
  });
  assert.equal(unset3.coreVsCycles.scenes[0].passedLevel, 2);
  assert.equal(unset3.coreVsCycles.scenes[0].blockedAtLevel, 3);
  assert.equal(unset3.coreVsCycles.scenes[0].blockedReason, 'unset');

  // L3 同时有 fail 和 unset 时，fail 优先
  const failAndUnset3 = buildBoard({
    asOf: AS_OF,
    coreVsCycles: [
      {
        filmType: 'hard-surface',
        scene: 'chassis-head',
        gates: [
          { level: 1, status: 'pass' },
          { level: 2, status: 'pass' },
          { level: 3, status: 'unset', gateId: 'g.unset' },
          { level: 3, status: 'fail', gateId: 'g.fail' },
        ],
      },
    ],
  });
  assert.equal(failAndUnset3.coreVsCycles.scenes[0].passedLevel, 2);
  assert.equal(failAndUnset3.coreVsCycles.scenes[0].blockedAtLevel, 3);
  assert.equal(failAndUnset3.coreVsCycles.scenes[0].blockedReason, 'fail');

  // L1 fail 直接退回 0
  const fail1 = buildBoard({
    asOf: AS_OF,
    coreVsCycles: [
      {
        filmType: 'toon',
        scene: 'ink-sphere',
        gates: [
          { level: 1, status: 'fail', gateId: 'level1.fncheck' },
          { level: 2, status: 'pass', gateId: 'level2.analytic' },
        ],
      },
    ],
  });
  assert.equal(fail1.coreVsCycles.scenes[0].passedLevel, 0);
  assert.equal(fail1.coreVsCycles.scenes[0].blockedAtLevel, 1);
  assert.equal(fail1.coreVsCycles.scenes[0].blockedReason, 'fail');

  // 缺级（L1 pass、L3 pass、L2 缺席）绝不跳级，停在 L1 并标 blockedAtLevel=2 / blockedReason='missing'
  const skip2 = buildBoard({
    asOf: AS_OF,
    coreVsCycles: [
      {
        filmType: 'motion-explainer',
        scene: 'title-card',
        gates: [
          { level: 1, status: 'pass' },
          { level: 3, status: 'pass' },
        ],
      },
    ],
  });
  assert.equal(skip2.coreVsCycles.scenes[0].passedLevel, 1);
  assert.equal(skip2.coreVsCycles.scenes[0].blockedAtLevel, 2);
  assert.equal(skip2.coreVsCycles.scenes[0].blockedReason, 'missing');

  // 空门数组：passedLevel=0，blockedAtLevel=1，blockedReason='missing'；L1..L8 全过：passedLevel=8，无阻塞
  // 且同一 (filmType, scene) 拆成 G 组与 V19 两条记录时可正确聚合，多场景按 (filmType, scene) 稳定排序
  const multi = buildBoard({
    asOf: AS_OF,
    coreVsCycles: [
      { filmType: 'toon', scene: 'z-scene', gates: [] },
      { filmType: 'realtime-3d', scene: 'arena', gates: makeGates(Array(8).fill('pass')) },
      { filmType: 'hard-surface', scene: 'arm', gates: [{ level: 3, status: 'pass', gateId: 'v19.floorgate' }] },
      {
        filmType: 'hard-surface',
        scene: 'arm',
        gates: [{ level: 1, status: 'pass', gateId: 'g.l1' }, { level: 2, status: 'pass', gateId: 'g.l2' }],
        speed: makeSpeed({ coreMs: 250, cyclesMs: 1000 }),
      },
    ],
  });
  assert.deepEqual(
    multi.coreVsCycles.scenes.map((s) => `${s.filmType}/${s.scene}:${s.passedLevel}`),
    ['hard-surface/arm:3', 'realtime-3d/arena:8', 'toon/z-scene:0'],
  );
  assert.equal(multi.coreVsCycles.scenes[1].blockedAtLevel, null);
  assert.equal(multi.coreVsCycles.scenes[1].blockedReason, null);
  assert.equal(multi.coreVsCycles.scenes[2].blockedAtLevel, 1);
  assert.equal(multi.coreVsCycles.scenes[2].blockedReason, 'missing');
  assert.deepEqual(multi.coreVsCycles.overall, { maxPassedLevel: 8, sceneCount: 3, blockedCount: 1, speedCount: 1 });
});

/* ---------------- 测试 2：自报拒收/忽略、速度比硬件口径、Proxy/泄露/防篡改 ---------------- */

test('O13-2：忽略自报 passedLevel，强制校验速度比与硬件口径，拒收 Proxy/本机路径/泄露/原型污染与快照篡改', () => {
  // 自报 passedLevel=7 必须被忽略，严格按 gates 计算为 1
  const selfReported = buildBoard({
    asOf: AS_OF,
    coreVsCycles: [
      {
        filmType: 'hard-surface',
        scene: 'bolt-rig',
        passedLevel: 7,
        gates: [
          { level: 1, status: 'pass' },
          { level: 2, status: 'fail' },
        ],
        speed: makeSpeed({ coreMs: 400, cyclesMs: 1600, gpu: 'RTX 5090', samples: 256, resolution: [1920, 1080] }),
      },
    ],
  });
  const s = selfReported.coreVsCycles.scenes[0];
  assert.equal(s.passedLevel, 1);
  assert.equal(s.blockedAtLevel, 2);
  assert.equal(s.blockedReason, 'fail');
  near(s.speed.speedRatio, 4);
  near(s.speed.coreOverCyclesRatio, 0.25);
  assert.equal(s.speed.gpu, 'RTX 5090');
  assert.equal(s.speed.samples, 256);
  assert.deepEqual(s.speed.resolution, [1920, 1080]);

  // 仅自报 passedLevel 而缺少 gates 必须拒收
  assert.throws(
    () => buildBoard({ asOf: AS_OF, coreVsCycles: [{ filmType: 'hard-surface', scene: 'no-gates', passedLevel: 5 }] }),
    isBadArgument,
  );

  // 各类非法入参：缺失硬件口径、非正数、非法分辨率、非法级别/状态、Proxy、取值器、稀疏数组、本机路径、私有标记
  let traps = 0;
  const proxied = (target) => new Proxy(target, new Proxy({}, { get: () => { traps += 1; return undefined; } }));
  const sparseGates = [{ level: 1, status: 'pass' }, , { level: 2, status: 'pass' }]; // eslint-disable-line no-sparse-arrays
  const getterSpeed = { coreMs: 100, cyclesMs: 200, samples: 64, resolution: [1280, 720] };
  Object.defineProperty(getterSpeed, 'gpu', { enumerable: true, get() { traps += 1; return 'RTX 5090'; } });
  const localPosixPath = ['', 'Users', 'demo', 'scene'].join('/');
  const localHomePath = ['', 'home', 'demo', 'gpu'].join('/');
  const privateLabUri = ['lab', '://private/result'].join('');

  const validGates = [{ level: 1, status: 'pass' }];
  const badInputs = [
    { coreVsCycles: null },
    { coreVsCycles: 'bad' },
    { coreVsCycles: {} },
    { coreVsCycles: { entries: null } },
    { coreVsCycles: { entries: [], passedLevel: 5 } },
    { coreVsCycles: [null] },
    { coreVsCycles: [{ filmType: 'live-action', scene: 's', gates: validGates }] },
    { coreVsCycles: [{ filmType: 'toon', scene: '', gates: validGates }] },
    { coreVsCycles: [{ filmType: 'toon', scene: '   ', gates: validGates }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: null }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: sparseGates }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: [{ level: 0, status: 'pass' }] }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: [{ level: 9, status: 'pass' }] }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: [{ level: 1.5, status: 'pass' }] }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: [{ level: 1, status: 'PASS' }] }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: [{ level: 1, status: 'skip' }] }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: [{ level: 1, status: 'pass', gateId: '' }] }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: [{ level: 1, status: 'pass', value: '0.1' }] }] },
    // speed 缺任一项或非法数值
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: null }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ gpu: undefined }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ gpu: '' }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ gpu: '   ' }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ samples: undefined }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ samples: 0 }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ samples: -16 }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ samples: 16.5 }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ resolution: undefined }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ resolution: [1920] }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ resolution: [1920, 1080, 1] }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ resolution: [0, 1080] }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ resolution: [1920, -1] }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ resolution: [1920.5, 1080] }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ coreMs: 0 }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ coreMs: -10 }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ cyclesMs: 0 }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ cyclesMs: -1 }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ coreMs: 1e-308, cyclesMs: 1e308 }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: { ...makeSpeed(), speedRatio: 999 } }] },
    // 同一场景互相冲突的两份 speed 拒收
    {
      coreVsCycles: [
        { filmType: 'toon', scene: 's', gates: [{ level: 1, status: 'pass', gateId: 'g1' }], speed: makeSpeed({ coreMs: 100 }) },
        { filmType: 'toon', scene: 's', gates: [{ level: 2, status: 'pass', gateId: 'g2' }], speed: makeSpeed({ coreMs: 200 }) },
      ],
    },
    // 同一场景同一级别重复 gateId 拒收
    {
      coreVsCycles: [
        { filmType: 'toon', scene: 's', gates: [{ level: 1, status: 'pass', gateId: 'dup' }, { level: 1, status: 'fail', gateId: 'dup' }] },
      ],
    },
    // Proxy / getter / 本机路径 / 私有标记
    { coreVsCycles: proxied([]) },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: getterSpeed }] },
    { coreVsCycles: [{ filmType: 'toon', scene: localPosixPath, gates: validGates }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: validGates, speed: makeSpeed({ gpu: localHomePath }) }] },
    { coreVsCycles: [{ filmType: 'toon', scene: 's', gates: [{ level: 1, status: 'pass', note: privateLabUri }] }] },
  ];
  for (const [i, extra] of badInputs.entries()) {
    assert.throws(() => buildBoard({ asOf: AS_OF, ...extra }), isBadArgument, `O13 负例第 ${i} 个`);
  }
  assert.equal(traps, 0);

  // __proto__ 注入拒收
  const protoPayload = JSON.parse(`{"asOf":"${AS_OF}","coreVsCycles":[{"filmType":"toon","scene":"s","gates":[{"level":1,"status":"pass"}],"__proto__":{"o13Polluted":1}}]}`);
  assert.throws(() => buildBoard(protoPayload), isBadArgument);
  assert.equal({}.o13Polluted, undefined);

  // Object.prototype 挂上 O13 相关键的 getter/setter 时，三个公开函数零陷阱
  const protoKeys = [
    'coreVsCycles', 'entries', 'scene', 'gates', 'level', 'status', 'gateId', 'metric', 'value', 'threshold',
    'passedLevel', 'blockedAtLevel', 'blockedReason', 'speed', 'coreMs', 'cyclesMs', 'speedRatio', 'coreOverCyclesRatio',
    'gpu', 'samples', 'resolution', 'scenes', 'maxLevel', 'maxPassedLevel', 'sceneCount', 'blockedCount', 'speedCount', 'filmTypeLabel',
  ];
  let protoTraps = 0;
  try {
    for (const key of protoKeys) {
      Object.defineProperty(Object.prototype, key, {
        __proto__: null,
        configurable: true,
        get() { protoTraps += 1; return []; },
        set() { protoTraps += 1; },
      });
    }
    const clean = buildBoard({
      asOf: AS_OF,
      coreVsCycles: [{ filmType: 'hard-surface', scene: 'demo', gates: [{ level: 1, status: 'pass' }], speed: makeSpeed() }],
    });
    assert.equal(clean.coreVsCycles.scenes[0].passedLevel, 1);
    assert.ok(renderBoardHtml(clean).includes('核心对 Cycles'));
    assert.equal(appendBoardHistory([], clean).length, 1);
  } finally {
    for (const key of protoKeys) delete Object.prototype[key];
  }
  assert.equal(protoTraps, 0);

  // 旧快照（未含 coreVsCycles）兼容 renderBoardHtml 与 appendBoardHistory
  const legacyBoard = JSON.parse(JSON.stringify(selfReported));
  delete legacyBoard.coreVsCycles;
  assert.ok(renderBoardHtml(legacyBoard).includes('<h2>核心对 Cycles</h2>'));
  assert.equal(appendBoardHistory([], legacyBoard).length, 1);

  // 手工篡改快照 coreVsCycles 在 renderBoardHtml 与 appendBoardHistory 均被拒收
  const clone = () => JSON.parse(JSON.stringify(selfReported));
  const tamperedSnapshots = [
    (() => { const b = clone(); b.coreVsCycles = null; return b; })(),
    (() => { const b = clone(); b.coreVsCycles.maxLevel = 5; return b; })(),
    (() => { const b = clone(); b.coreVsCycles.extra = 1; return b; })(),
    (() => { const b = clone(); b.coreVsCycles.scenes[0].passedLevel = 2; return b; })(),
    (() => { const b = clone(); b.coreVsCycles.scenes[0].blockedAtLevel = null; b.coreVsCycles.scenes[0].blockedReason = null; return b; })(),
    (() => { const b = clone(); b.coreVsCycles.scenes[0].speed.speedRatio = 99; return b; })(),
    (() => { const b = clone(); b.coreVsCycles.scenes[0].speed.coreOverCyclesRatio = 0.99; return b; })(),
    (() => { const b = clone(); b.coreVsCycles.byFilmType['hard-surface'].maxPassedLevel = 8; return b; })(),
    (() => { const b = clone(); b.coreVsCycles.overall.blockedCount = 0; return b; })(),
    (() => { const b = clone(); b.coreVsCycles.byFilmType.toon.label = '<script>x</script>'; return b; })(),
  ];
  for (const [i, tampered] of tamperedSnapshots.entries()) {
    assert.throws(() => renderBoardHtml(tampered), isBadArgument, `renderBoardHtml 篡改第 ${i} 个`);
    assert.throws(() => appendBoardHistory([], tampered), isBadArgument, `appendBoardHistory 篡改第 ${i} 个`);
  }
});

/* ---------------- 测试 3：HTML 渲染与 XSS 转义 ---------------- */

test('O13-3：renderBoardHtml 正确输出「核心对 Cycles」行、阶梯级数、退级提示与显卡/采样数/分辨率，且 XSS 转义安全', () => {
  const xssScene = 'head<script>alert(1)</script>"&\'';
  const xssGpu = 'RTX 5090 <img src=x onerror=alert(2)>';
  const board = buildBoard({
    asOf: AS_OF,
    coreVsCycles: [
      {
        filmType: 'hard-surface',
        scene: xssScene,
        gates: [
          { level: 1, status: 'pass', gateId: 'level1.fncheck' },
          { level: 2, status: 'pass', gateId: 'level2.furnace-metal' },
          { level: 3, status: 'fail', gateId: 'v19.floorgate' },
        ],
        speed: makeSpeed({ coreMs: 500, cyclesMs: 1500, gpu: xssGpu, samples: 256, resolution: [1920, 1080] }),
      },
      {
        filmType: 'toon',
        scene: 'cell-fox',
        gates: [
          { level: 1, status: 'pass' },
          { level: 2, status: 'pass' },
          { level: 3, status: 'unset' },
        ],
      },
    ],
  });

  const html = renderBoardHtml(board);
  assert.ok(html.includes('<h2>核心对 Cycles</h2>'));
  assert.ok(html.includes('L2 / L8'));
  assert.ok(html.includes('L3 判红退级（退回 L2）'));
  assert.ok(html.includes('L3 未定线退级（退回 L2）'));
  assert.ok(html.includes('3x'));
  assert.ok(html.includes('0.33x'));
  assert.ok(html.includes('256 spp'));
  assert.ok(html.includes('1920×1080'));
  assert.ok(html.includes('RTX 5090 &lt;img src=x onerror=alert(2)&gt;'));
  assert.ok(html.includes('head&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;'));
  assert.ok(!/<script/i.test(html), 'HTML 不得包含未转义的 script 标签');
  assert.ok(!/<img/i.test(html), 'HTML 不得包含未转义的 img 标签');

  // 历史行不破坏旧格式
  const hist = appendBoardHistory([], board);
  assert.equal(hist.length, 1);
  assert.equal(Object.hasOwn(hist[0], 'coreVsCycles'), false);
});

/* ---------------- 测试 4：CLI 端到端连续两天运行自动更新与退级 ---------------- */

test('O13-4：CLI board.mjs build --core-vs-cycles <dir/file> 连续两天自动聚合更新（第 1 天 L3 → 第 2 天 L3 判红退回 L2）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'beiming-o13-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const outDir = join(dir, 'board-out');
  const cvcDir = join(dir, 'core-vs-cycles');
  mkdirSync(cvcDir, { recursive: true });

  // G 组结果文件（L1 + L2 + 同场景同采样速度比）
  const gGroupFile = join(cvcDir, 'g-group.json');
  writeFileSync(gGroupFile, JSON.stringify({
    entries: [
      {
        filmType: 'hard-surface',
        scene: 'chassis-head',
        gates: [
          { level: 1, status: 'pass', gateId: 'level1.fncheck' },
          { level: 2, status: 'pass', gateId: 'level2.furnace-metal' },
        ],
        speed: makeSpeed({ coreMs: 800, cyclesMs: 2400, gpu: 'RTX 5090', samples: 256, resolution: [1920, 1080] }),
      },
    ],
  }, null, 2));

  // V19 结果文件：第 1 天 L3 门通过
  const v19File = join(cvcDir, 'v19-floorgate.json');
  writeFileSync(v19File, JSON.stringify({
    filmType: 'hard-surface',
    scene: 'chassis-head',
    gates: [
      { level: 3, status: 'pass', gateId: 'v19.floorgate', metric: 'seedVsSeedFlipMean', value: 0.015, threshold: 0.025 },
    ],
  }, null, 2));

  // 第 1 天跑看板
  const day1 = runCli(['build', '--as-of', '2026-11-24', '--out-dir', outDir, '--core-vs-cycles', cvcDir]);
  assert.equal(day1.code, 0, day1.stderr);
  const board1 = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8'));
  const html1 = readFileSync(join(outDir, 'index.html'), 'utf8');
  const hist1 = JSON.parse(readFileSync(join(outDir, 'history.json'), 'utf8'));
  assert.equal(board1.coreVsCycles.scenes.length, 1);
  assert.equal(board1.coreVsCycles.scenes[0].passedLevel, 3);
  assert.equal(board1.coreVsCycles.scenes[0].blockedAtLevel, null);
  assert.equal(board1.coreVsCycles.scenes[0].speed.gpu, 'RTX 5090');
  assert.ok(html1.includes('<h2>核心对 Cycles</h2>'));
  assert.ok(html1.includes('L3 / L8'));
  assert.ok(html1.includes('RTX 5090') && html1.includes('256 spp') && html1.includes('1920×1080'));
  assert.equal(hist1.length, 1);
  assert.equal(hist1[0].asOf, '2026-11-24');
  assert.equal(Object.hasOwn(hist1[0], 'coreVsCycles'), false);

  // 第 2 天 V19 结果文件更新：L3 门判红
  writeFileSync(v19File, JSON.stringify({
    filmType: 'hard-surface',
    scene: 'chassis-head',
    gates: [
      { level: 3, status: 'fail', gateId: 'v19.floorgate', metric: 'seedVsSeedFlipMean', value: 0.042, threshold: 0.025 },
    ],
  }, null, 2));

  const day2 = runCli(['build', '--as-of', '2026-11-25', '--out-dir', outDir, '--core-vs-cycles', cvcDir]);
  assert.equal(day2.code, 0, day2.stderr);
  const board2 = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8'));
  const html2 = readFileSync(join(outDir, 'index.html'), 'utf8');
  const hist2 = JSON.parse(readFileSync(join(outDir, 'history.json'), 'utf8'));
  assert.equal(board2.coreVsCycles.scenes[0].passedLevel, 2);
  assert.equal(board2.coreVsCycles.scenes[0].blockedAtLevel, 3);
  assert.equal(board2.coreVsCycles.scenes[0].blockedReason, 'fail');
  assert.equal(board2.coreVsCycles.byFilmType['hard-surface'].maxPassedLevel, 2);
  assert.equal(board2.coreVsCycles.byFilmType['hard-surface'].blockedCount, 1);
  assert.ok(html2.includes('L2 / L8'));
  assert.ok(html2.includes('L3 判红退级（退回 L2）'));
  assert.equal(hist2.length, 2);
  assert.deepEqual(hist2.map((r) => r.asOf), ['2026-11-24', '2026-11-25']);

  // 单文件模式 --core-vs-cycles <file.json> 同样可用
  const singleFile = join(dir, 'single.json');
  writeFileSync(singleFile, JSON.stringify([
    {
      filmType: 'toon',
      scene: 'fox',
      gates: [{ level: 1, status: 'pass' }],
      speed: makeSpeed({ coreMs: 100, cyclesMs: 500, gpu: 'RTX 4090', samples: 64, resolution: [1280, 720] }),
    },
  ]));
  const singleOut = join(dir, 'single-out');
  const singleRes = runCli(['build', '--as-of', '2026-11-25', '--out-dir', singleOut, '--core-vs-cycles', singleFile]);
  assert.equal(singleRes.code, 0, singleRes.stderr);
  const singleBoard = JSON.parse(readFileSync(join(singleOut, 'board.json'), 'utf8'));
  assert.equal(singleBoard.coreVsCycles.scenes[0].passedLevel, 1);
  assert.equal(singleBoard.coreVsCycles.scenes[0].speed.gpu, 'RTX 4090');

  // 负例：CLI --core-vs-cycles 缺硬件口径或路径不存在退出 2，且不泄露本机路径
  const badFile = join(dir, 'bad.json');
  writeFileSync(badFile, JSON.stringify([{ filmType: 'toon', scene: 'bad', gates: [{ level: 1, status: 'pass' }], speed: { coreMs: 100, cyclesMs: 200 } }]));
  const badRes = runCli(['build', '--as-of', '2026-11-25', '--out-dir', join(dir, 'bad-out'), '--core-vs-cycles', badFile]);
  assert.equal(badRes.code, 2);

  const missingPath = ['', 'Users', 'secret-user', 'missing-cvc.json'].join('/');
  const missingRes = runCli(['build', '--as-of', '2026-11-25', '--out-dir', join(dir, 'miss-out'), '--core-vs-cycles', missingPath]);
  assert.equal(missingRes.code, 2);
  assert.ok(!missingRes.stderr.includes('secret-user'), 'CLI 报错不得回显本机路径');

  // --extra 透传 coreVsCycles 与 --core-vs-cycles 冲突检测
  const extraFile = join(dir, 'extra-cvc.json');
  writeFileSync(extraFile, JSON.stringify({
    coreVsCycles: [{ filmType: 'motion-explainer', scene: 'deck', gates: [{ level: 1, status: 'pass' }] }],
  }));
  const extraRes = runCli(['build', '--as-of', '2026-11-25', '--out-dir', join(dir, 'extra-out'), '--extra', extraFile]);
  assert.equal(extraRes.code, 0, extraRes.stderr);
  const extraBoard = JSON.parse(readFileSync(join(dir, 'extra-out', 'board.json'), 'utf8'));
  assert.equal(extraBoard.coreVsCycles.scenes[0].passedLevel, 1);

  const conflictRes = runCli([
    'build', '--as-of', '2026-11-25', '--out-dir', join(dir, 'conflict-out'),
    '--extra', extraFile, '--core-vs-cycles', singleFile,
  ]);
  assert.equal(conflictRes.code, 2);
});
