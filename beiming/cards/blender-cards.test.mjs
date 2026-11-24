// 两张 Blender 机制卡（blender.cycles、blender.state-keys）和 Blender 帧源「卡加数据」这条路的自检：
//   一、两张卡的卡文件过契约校验和泄露扫描，校准场景是 calib/ 里真有的，落点、形状、自测和卡目录一致，每份实现只有一个卡入口；
//       现算的本机锁过锁文件的结构和 LK 各条；
//   二、本机有 Blender 时实跑例子片子 film-min 的 s01（一行镜头代码都没有：相机样条 + 两张机制卡 + 自带资产 asset:rtx-card@1）：
//       锁不对各报各的错误码；草稿档抽第 0、90、179 帧出颜色、深度、编号、法线四层，元数据过结构和 M 各条，
//       编号层反算的包围盒对元数据的交并比 ≥ 0.95，主体 kit 的可见比例 > 0.6，相机正对着 kit 的包围盒中心；
//       装载的账写成装载核对记录过契约的校验器；终稿档的采样数取镜头的 tiers.final.samples。
// 没有 Blender 的机器（只跑单元测试的 CI、Windows）第二部分跳过，不算失败。渲染产物在系统临时目录里，跑完删掉。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { eventsTable, shotInput } from '../kernel/eval/input.mjs';
import { BUILTIN_ASSETS, findBlender, loadAssets, loadCards, startSource } from '../sources/blender/host.mjs';
import { verifySampledBboxes } from '../verify/l2.mjs';
import { hashCardContents, resolveParams, scanCardLeaks, validateCard } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEIMING = resolve(HERE, '..');
const BLENDER = findBlender();
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 任务书的表：目录、卡名、校准场景
const CARDS = [
  ['mechanism/blender-cycles', 'blender.cycles', 'probe-gray-chart', 'cycles.py'],
  ['mechanism/blender-state-keys', 'blender.state-keys', 'probe-moving-cube', 'keys.py'],
].map(([dir, id, calibration, entry]) => ({ dir, id, calibration, entry, abs: join(HERE, dir) }));
// 出 s01 要的卡：相机样条（数据层）加两张机制卡；锁里另带三张内建卡（LK5）
const S01_DIRS = ['cards/camera/spline', ...CARDS.map((c) => `cards/${c.dir}`)];
const BUILTIN_DIRS = ['cards/time/timeline', 'cards/time/events', 'cards/time/seeded'];
const FILM = readJson(join(BEIMING, 'kernel/contracts/examples/film-min/film.json'));
const S01 = FILM.shots.find((s) => s.id === 's01');

const contracts = await loadContracts();
const judged = (obj, schema) => {
  const v = contracts.validate(obj, schema ? 'source' : undefined, schema);
  return { schemaErrors: v.schemaErrors, violations: v.violations };
};
const CLEAN = { schemaErrors: [], violations: {} };
const library = await loadCards(S01_DIRS), builtins = await loadCards(BUILTIN_DIRS), assets = await loadAssets();
const filesOf = (abs) => readdirSync(abs, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(abs, join(e.parentPath, e.name)).split(sep).join('/')).sort();

/**
 * 测试照本机锁的写法现算的锁：卡的版本和落点从卡文件读，内容哈希由宿主读卡时算，验证记录取卡文件 status 的第一项；
 * Blender 的版本取 version（实跑时是起来的那个 Blender 的版本），资产的哈希是自带的 rtx-card.json 的内容哈希。
 */
function localLock(version) {
  const shots = Object.fromEntries(FILM.shots.map((s) => [s.id, { shutterSamples: 1 }]));
  return {
    format: 'lock/1.0', issuer: 'local', film: FILM.id, contracts: '0.1.0',
    seeds: { film: 20261121, ...Object.fromEntries(FILM.shots.map((s) => [s.id, s.seed])) },
    shots,
    sources: { blender: { version, host: 'cycles' } },
    cards: Object.fromEntries(Object.entries({ ...builtins, ...library }).map(([name, { card, sha256 }]) => {
      const { level, host, source, gpu } = card.status[0];
      return [name, { version: card.version, impl: [...card.livesIn], sha256, verified: { level, host, source: host === 'cycles' ? version : source, gpu } }];
    })),
    assets: { 'asset:rtx-card@1': assets['asset:rtx-card@1'].sha256 },
    templates: {}, view: {},
  };
}

/** 装载核对记录：cards 从片子描述读（请求），别的照元数据 ext["blender.load"] 里宿主自己记的账抄（自报） */
function loadCheck(input, account) {
  return {
    format: 'load-check/0.1', shot: input.shot.id, build: 'ok', steps: account.steps,
    cards: (input.shot.cards ?? []).map((c) => c.as),
    orderPairs: account.orderPairs, createOrder: account.createOrder, applyOrder: account.applyOrder, metaOrder: account.metaOrder,
    ...(account.camera ? { camera: account.camera } : {}),
  };
}

// ---------- 一、卡文件 ----------

test('两张 Blender 机制卡：各在 cards/mechanism/<目录名>/，带卡文件、入口和自测，落点是 source:blender、宿主是 cycles', () => {
  const found = readdirSync(join(HERE, 'mechanism'), { recursive: true })
    .filter((p) => p.endsWith('card.json'))
    .map((p) => `mechanism/${dirname(p).split(sep).join('/')}`)
    .filter((dir) => dir.startsWith('mechanism/blender-'))
    .sort();
  assert.deepEqual(found, CARDS.map((c) => c.dir).sort());
  for (const c of CARDS) {
    const card = readJson(join(c.abs, 'card.json')), [impl] = card.impl;
    assert.deepEqual([card.id, card.kind, card.version, card.visibleToAgent, card.livesIn, card.impl.length], [c.id, 'mechanism', '1.0.0', true, ['source:blender'], 1], c.dir);
    assert.deepEqual([impl.livesIn, impl.shape, impl.entry, impl.selftest], ['source:blender', 'create', `cards/${c.dir}/${c.entry}`, `cards/${c.dir}/selftest.test.mjs`], c.dir);
    assert.deepEqual(impl.hosts.map((h) => h.host), ['cycles'], c.dir);
    assert.ok(existsSync(join(BEIMING, impl.entry)) && existsSync(join(BEIMING, impl.selftest)), `${c.dir} 的入口和自测文件在`);
    assert.deepEqual(filesOf(c.abs), ['card.json', c.entry, 'selftest.test.mjs'].sort(), `${c.dir} 里没有多余的文件（字节码缓存会改掉内容哈希）`);
  }
});

test('卡文件过契约校验（结构加 CF 各条）和泄露扫描；卡目录下每个文件过泄露扫描', () => {
  for (const c of CARDS) {
    const card = readJson(join(c.abs, 'card.json'));
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, c.dir);
    assert.deepEqual(judged(card), CLEAN, c.dir);
    for (const f of filesOf(c.abs)) assert.deepEqual(scanCardLeaks(readFileSync(join(c.abs, f), 'utf8')), [], `${c.dir}/${f}`);
  }
});

test('校准场景是 calib/ 里真有的那一个；状态里有 reproduced，挂着 cal:<卡名>；参数的默认值过得了自己的检查', () => {
  for (const c of CARDS) {
    const card = readJson(join(c.abs, 'card.json'));
    assert.equal(card.calibration, c.calibration, c.dir);
    assert.equal(readJson(join(BEIMING, 'calib', card.calibration, 'scene.json')).id, card.calibration, c.dir);
    assert.ok(card.status.some((s) => s.level === 'reproduced' && s.host === 'cycles'), c.dir);
    assert.ok(card.exams.includes(`cal:${c.id}`), c.dir);
    assert.deepEqual(Object.keys(resolveParams(card, {})), Object.keys(card.params), c.dir);
  }
  // blender.state-keys 读相机轨道，blender.cycles 交场景线性的颜色
  assert.deepEqual(readJson(join(CARDS[1].abs, 'card.json')).ports.in.map((p) => p.type), ['tracks.camera']);
  assert.deepEqual(readJson(join(CARDS[0].abs, 'card.json')).ports.out.map((p) => p.type), ['scene-linear-rgba']);
});

test('每份实现对外正好一个卡入口 create（CR1），不碰 EEVEE', () => {
  for (const c of CARDS) {
    const text = readFileSync(join(c.abs, c.entry), 'utf8');
    assert.deepEqual([...text.matchAll(/^def (create|evaluate)\(/gm)].map((m) => m[1]), ['create'], c.dir);
    assert.ok(!/EEVEE'/.test(text.replace(/!= 'CYCLES'/g, '')) || c.id === 'blender.cycles', c.dir);
  }
  assert.doesNotMatch(readFileSync(join(CARDS[0].abs, CARDS[0].entry), 'utf8'), /engine = 'BLENDER_EEVEE/);
});

test('卡的内容哈希照锁文件的算法从卡目录的文件算，和宿主读进来的一致；现算的本机锁过锁文件的结构和 LK 各条', () => {
  for (const c of CARDS) {
    const hashes = Object.fromEntries(filesOf(c.abs).map((f) => [f, sha(readFileSync(join(c.abs, f)))]));
    assert.equal(library[c.id].sha256, hashCardContents(hashes), c.dir);
  }
  assert.equal(assets['asset:rtx-card@1'].sha256, `sha256:${sha(readFileSync(BUILTIN_ASSETS['asset:rtx-card@1']))}`);
  assert.deepEqual(judged(localLock('5.2.0')), CLEAN);
});

test('film-min 的 s01 不写一行镜头代码：卡加数据模式、没有 entry，镜头输入过结构', () => {
  assert.deepEqual(judged(FILM), CLEAN);
  assert.deepEqual([S01.source, S01.host, S01.mode, S01.entry, S01.assets, S01.roles], ['blender', 'cycles', 'cards-data', undefined, { kit: 'asset:rtx-card@1' }, { hero: 'kit' }]);
  assert.deepEqual(S01.cards.map((c) => c.use), ['camera.spline@1', 'blender.cycles@1', 'blender.state-keys@1']);
  assert.deepEqual(S01.cards[0].params.keys.map((k) => k.look), ['kit', 'kit']);
  assert.deepEqual(judged(shotInput(FILM, 's01', eventsTable(FILM)), 'shot-input.schema.json'), CLEAN);
});

// ---------- 二、实跑 ----------

/** 读一个层文件，核对字节数和哈希，交回 { w, h, n, data } */
async function readLayer(root, ref, kind) {
  const bytes = await readFile(join(root, ref.file));
  const [h, w, n] = ref.shape;
  assert.equal(bytes.length, h * w * n * 4, `${ref.file} 的字节数`);
  assert.equal(ref.hash, `sha256:${sha(bytes)}`, `${ref.file} 的哈希`);
  assert.deepEqual(judged(ref, 'layer-ref.schema.json'), CLEAN);
  return { w, h, n, data: new (kind === 'u32' ? Uint32Array : Float32Array)(new Uint8Array(bytes).buffer) };
}

describe('Blender 实跑 film-min 的 s01', { concurrency: false }, () => {
  test('锁不对各报各的错误码；草稿档抽三帧出四层，元数据、交并比、可见比例、相机朝向、装载核对记录都对', { skip: !BLENDER && '本机没有 Blender', timeout: 900000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'beiming-blender-cards-'));
    const src = await startSource({ blenderBin: BLENDER, cards: S01_DIRS, limitMs: 600000 });
    try {
      const version = src.caps().version, lock = localLock(version);
      t.diagnostic(`Blender ${version}，后端 ${src.device.backend}${src.device.gpu ? `（${src.device.gpu}）` : ''}`);
      assert.deepEqual(judged(src.caps()), CLEAN);
      assert.deepEqual(src.caps().modes, ['cards-data', 'build-script']);
      const input = shotInput(FILM, 's01', eventsTable(FILM));
      const env = (tier, l = lock) => ({ lock: l, tier, workspace: join(root, tier), filmDir: join(BEIMING, 'kernel/contracts/examples/film-min') });
      const code = (c) => (e) => e.code === c;

      // 锁：没有、错片名、错版本、错卡（内容哈希对不上）、资产哈希对不上
      await assert.rejects(() => src.open(input, env('draft', null)), code('env.lock-required'));
      await assert.rejects(() => src.open(input, env('draft', { ...lock, film: 'f_other' })), code('usage.bad-argument'));
      await assert.rejects(() => src.open(input, env('draft', { ...lock, sources: { blender: { version: `${version}.9`, host: 'cycles' } } })), code('contract.unsupported-input'));
      const tampered = { ...lock, cards: { ...lock.cards, 'blender.state-keys': { ...lock.cards['blender.state-keys'], sha256: sha('别的内容') } } };
      await assert.rejects(() => src.open(input, env('draft', tampered)), code('contract.unsupported-input'));
      await assert.rejects(() => src.open(input, env('draft', { ...lock, assets: { 'asset:rtx-card@1': `sha256:${sha('别的内容')}` } })), code('contract.unsupported-input'));

      const session = await src.open(input, env('draft'));
      const accounts = [];
      try {
        const manifest = session.manifest();
        assert.deepEqual(judged(manifest, 'manifest.schema.json'), CLEAN);
        // 资产别名 kit 是装配体，零件各是一个实体；编号是实体名按字节序排的名次
        assert.deepEqual(manifest, { frames: 180, entities: [
          { id: 1, name: 'kit', class: 'assembly' }, { id: 2, name: 'kit.body', class: 'part' }, { id: 3, name: 'kit.fan_L', class: 'part' }, { id: 4, name: 'kit.fan_R', class: 'part' },
        ] });
        const sampled = [];
        for (const f of [0, 90, 179]) {
          const { meta, layers } = await session.render(f, {}, ['color', 'depth', 'objectId', 'normal', 'meta']);
          assert.deepEqual(judged(meta), CLEAN, `第 ${f} 帧的元数据`);
          assert.deepEqual([meta.film, meta.shot, meta.frame, meta.shotFrame, meta.seed, meta.size, meta.colorRef], [FILM.id, 's01', f, f, S01.seed, [960, 540], 'scene']);
          assert.deepEqual([meta.source.renderer, meta.source.host, meta.source.version, meta.source.tier, meta.source.samples, meta.camera.shutterAngleDeg], ['blender', 'cycles', version, 'draft', S01.tiers.draft.samples, 180]);
          if (src.device.backend !== 'CPU') assert.equal(meta.source.denoise, 'oidn-gpu');
          assert.deepEqual(Object.keys(layers).sort(), ['color', 'depth', 'normal', 'objectId']);
          const color = await readLayer(env('draft').workspace, layers.color, 'f32'), depth = await readLayer(env('draft').workspace, layers.depth, 'f32');
          const ids = await readLayer(env('draft').workspace, layers.objectId, 'u32'), normal = await readLayer(env('draft').workspace, layers.normal, 'f32');
          sampled.push({ frame: f, meta, objectId: { width: ids.w, height: ids.h, data: ids.data } });

          // 颜色层：Cycles 渲成 32 位浮点 EXR 直读，场景线性，都是有限的数；背景对相机不可见，打到 kit 的像素有亮度
          const kit = meta.entities.find((e) => e.name === 'kit');
          // 逐像素只计数，最后一次断言：每个像素都断言一次太慢
          let hit = 0, lit = 0, unit = 0, inRange = 0, finite = 0, empty = 0;
          for (let i = 0; i < ids.data.length; i++) {
            const id = ids.data[i];
            if (Number.isFinite(color.data[i * 4]) && Number.isFinite(color.data[i * 4 + 1]) && Number.isFinite(color.data[i * 4 + 2]) && Number.isFinite(color.data[i * 4 + 3])) finite++;
            const n = Math.hypot(normal.data[i * 3], normal.data[i * 3 + 1], normal.data[i * 3 + 2]);
            if (id === 0) {
              if (depth.data[i] === 1e10 && n === 0) empty++;
              continue;
            }
            hit++;
            if (color.data[i * 4] + color.data[i * 4 + 1] + color.data[i * 4 + 2] > 0) lit++;
            if (Math.abs(n - 1) < 1e-4) unit++;
            if (depth.data[i] >= kit.depth[0] - 1e-4 && depth.data[i] <= kit.depth[1] + 1e-4) inRange++;
          }
          assert.ok(hit > 0.02 * ids.data.length, `第 ${f} 帧 kit 占的像素 ${hit}`);
          assert.deepEqual([lit, unit, inRange], [hit, hit, hit], `第 ${f} 帧：打到 kit 的像素都有亮度、法线长 1、深度落在 kit 的深度范围里`);
          assert.deepEqual([finite, empty], [ids.data.length, ids.data.length - hit], `第 ${f} 帧：颜色都是有限的数，没打到的像素深度 1e10、法线 (0, 0, 0)`);
          assert.equal(color.data[3], 0, '左上角是透明的背景');

          // 主体 kit 的可见比例
          assert.equal(kit.role, 'hero');
          assert.ok(kit.visible > 0.6, `第 ${f} 帧 kit 的可见比例 ${kit.visible}`);
          // look: 'kit'：kit 的世界包围盒中心落在相机的 −Z 轴上（kit 不动，包围盒每帧一样）
          const w = meta.camera.world, c = [0, 1, 2].map((k) => (kit.bbox3d[k] + kit.bbox3d[k + 3]) / 2);
          const d = [c[0] - w[12], c[1] - w[13], c[2] - w[14]];
          const local = [0, 1, 2].map((col) => d[0] * w[col * 4] + d[1] * w[col * 4 + 1] + d[2] * w[col * 4 + 2]);
          assert.ok(local[2] < 0 && Math.hypot(local[0], local[1]) / -local[2] < 1e-6, `第 ${f} 帧 kit 中心在相机空间是 ${local}`);
          accounts.push(meta.ext['blender.load']);
        }

        // 编号层反算的包围盒对元数据的 bbox2d
        const boxes = verifySampledBboxes(sampled);
        t.diagnostic(`抽帧包围盒核对：最小交并比 ${boxes.minIou.toFixed(4)}`);
        assert.deepEqual(boxes.failures, []);
        assert.ok(boxes.ok && boxes.minIou >= 0.95);

        // 装载的账：四步、相机来自 tracks、两张机制卡经 create 装上；写成装载核对记录过契约的校验器
        const account = accounts.at(-1);
        assert.deepEqual(accounts[0], account, '账每帧一样');
        const check = loadCheck(input, account);
        assert.deepEqual(check, {
          format: 'load-check/0.1', shot: 's01', build: 'ok', steps: ['assets', 'tracks', 'create', 'collect'], cards: ['cam', 'cycles', 'keys'],
          orderPairs: [], createOrder: ['cam', 'cycles', 'keys'], applyOrder: ['tracks', 'cycles', 'keys'], metaOrder: ['host'], camera: { tracksHasCamera: true, from: 'tracks' },
        });
        assert.deepEqual(judged(check), CLEAN);
        assert.deepEqual(account.cards.map((r) => [r.as, r.card, r.shape, r.calledVia]), [
          ['cam', 'camera.spline@1', 'evaluate', 'tracks'], ['cycles', 'blender.cycles@1', 'create', 'cards.use'], ['keys', 'blender.state-keys@1', 'create', 'cards.use'],
        ]);
      } finally { await session.close(); }

      // 终稿档：每像素采样数取镜头的 tiers.final.samples，默认启用 OIDN 降噪
      const final = await src.open(input, env('final'));
      try {
        const { meta } = await final.render(90, { scale: 0.25 }, ['color', 'meta']);
        assert.deepEqual(judged(meta), CLEAN);
        assert.deepEqual([meta.source.tier, meta.source.samples], ['final', S01.tiers.final.samples]);
        assert.match(meta.source.denoise ?? '', /^oidn-(gpu|cpu)$/);
      } finally { await final.close(); }
    } finally {
      await src.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
