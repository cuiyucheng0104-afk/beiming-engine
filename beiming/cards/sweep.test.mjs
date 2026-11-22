import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cards from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TITLE_CARD = JSON.parse(fs.readFileSync(path.join(HERE, 'two-d/overlay-title/card.json'), 'utf8'));

test('C6-1 cards.sweepCard 按参数轴笛卡尔积返回「参数值对量测值」表且严格 <= 800 token', async () => {
  assert.equal(typeof cards.sweepCard, 'function');
  assert.equal(cards.SWEEP_TOKEN_LIMIT, 800);
  const res = await cards.sweepCard(
    TITLE_CARD,
    {
      axes: ['heightFrac=0.08,0.12,0.16'],
      baseParams: { text: 'RTX 5090', heightFrac: 0.2 },
      metrics: ['lumaMean', 'contrast'],
    },
    {
      evaluateCell: ({ resolvedParams }) => ({
        readings: {
          lumaMean: resolvedParams.heightFrac * 2,
          contrast: resolvedParams.heightFrac * 5,
        },
      }),
    },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.columns, ['heightFrac', 'lumaMean', 'contrast']);
  assert.equal(res.rows.length, 3);
  assert.ok(cards.estimateTokens(res) <= 800);
  assert.deepEqual(res.rows, [[0.08, 0.16, 0.4], [0.12, 0.24, 0.6], [0.16, 0.32, 0.8]]);
});

const CAMERA = JSON.parse(fs.readFileSync(path.join(HERE, 'camera/spline/card.json'), 'utf8'));
const request = { params: { distance: [1] }, metrics: ['value'] };
const evaluate = { evaluateCell: () => ({ value: 1 }) };
const hash = (data) => createHash('sha256').update(data).digest('hex');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cards-sweep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('字符串轴保留复合 JSON 的分隔与转义，坏写法带用法错误码', () => {
  assert.deepEqual(cards.parseSweepAxis('keys=[1,2],[3,4]'), { param: 'keys', values: [[1, 2], [3, 4]] });
  assert.deepEqual(cards.parseSweepAxis('text="a,b","c]"').values, ['a,b', 'c]']);
  for (const spec of ['', '=1', 'x=', 'x=[1,2', 'x=1]', 'x=1,', 'x=1,,2', 'x=no', 'x=null']) {
    assert.throws(() => cards.parseSweepAxis(spec), { code: 'usage.bad-argument' });
  }
});

test('双轴逐格按同样的时刻求值，区分给定参数、默认值与解析后的事件帧', async () => {
  const calls = [];
  const res = await cards.sweepCard(TITLE_CARD, {
    axes: [{ param: 'distance', values: [1, 2] }, { param: 'enter', values: ['event(start)', 22] }],
    baseParams: { text: 'TEST' }, events: [{ kind: 'named', id: 'start', frame: 20 }], shotIn: 10,
    frames: [0, 12], metrics: ['f'],
  }, { async evaluateCell({ card, params, resolvedParams, cellIndex, frame }) {
    assert.equal(card.id, TITLE_CARD.id);
    assert.equal(params.text, 'TEST');
    assert.equal(resolvedParams.heightFrac, 0.12);
    calls.push([cellIndex, frame, resolvedParams.enter]);
    return { readings: { f: frame }, f: -1 };
  } });
  assert.equal(res.card, 'overlay.title@1');
  assert.deepEqual(res.columns, ['distance', 'enter', 'frame', 'f']);
  assert.deepEqual(calls, [[0, 0, 10], [0, 12, 10], [1, 0, 12], [1, 12, 12], [2, 0, 10], [2, 12, 10], [3, 0, 12], [3, 12, 12]]);
  assert.deepEqual(res.rows.at(-1), [2, 22, 12, 12]);
  assert.equal(res.truncated, false);
});

test('数据层 camera.spline 直跑，按秒选帧并从轨道读取数值', async () => {
  const res = await cards.sweepCard(CAMERA, { params: { fovDeg: [30, 60] }, times: [0, 0.5], fps: 24,
    baseParams: { keys: [{ f: 0, pos: [0, 0, 1], look: [0, 0, 0] }, { f: 12, pos: [0, 0, 2], look: [0, 0, 0] }] },
    metrics: ['camera.fovDeg', 'camera.pos.2'] });
  assert.deepEqual(res.rows, [[30, 0, 30, 1], [30, 0.5, 30, 2], [60, 0, 60, 1], [60, 0.5, 60, 2]]);
  assert.equal((await cards.sweepCard(TITLE_CARD, request)).error.code, 'usage.bad-argument');

  const defaults = await cards.sweepCard(CAMERA, { params: { fovDeg: [45] }, metrics: ['camera.pos.2'] });
  assert.deepEqual(defaults.rows, [[45, 1]]);
});

test('数据卡入口在装载前核对卡目录', async () => {
  const entry = '../escape.mjs';
  const card = { ...CAMERA, files: { entry }, impl: [{ ...CAMERA.impl[0], entry }] };
  const res = await cards.sweepCard(card, { params: { fovDeg: [45] }, metrics: ['camera.fovDeg'] });
  assert.equal(res.ok, false);
  assert.deepEqual(res.error, { code: 'usage.bad-argument', message: '此卡需要提供 evaluateCell' });
});

test('无效请求在第一个求值前拒绝，含第 64 格越界与 data 内的非法值', async () => {
  assert.equal(cards.MAX_SWEEP_CELLS, 64);
  assert.equal(cards.MAX_SWEEP_TIMES, 6);
  let calls = 0;
  const options = { evaluateCell() { calls++; return { value: 0 }; } };
  const invalid = [null, new Date(), new Map(), ...[
    { params: {} }, { axes: [] }, { axes: [new Date()] }, { axes: Array(1) }, { params: new Map() },
    { params: { missing: [1] } }, { baseParams: { missing: 1 } }, { baseParams: new Date() }, { baseParams: null },
    { axes: ['distance=1', 'distance=2'] }, { params: { distance: [] } }, { params: { distance: Array(1) } },
    { params: { distance: [null] } }, { params: { distance: [1n] } }, { params: { distance: [NaN] } },
    { params: { distance: Array(65).fill(1) } }, { params: { distance: [...Array(63).fill(1), 51] } },
    { params: { distance: Array(9).fill(1), settleFrames: Array(8).fill(0) } },
    { params: { distance: Array(5).fill(1), settleFrames: Array(13).fill(0) } },
    { frames: Array(7).fill(0) }, { times: Array(1) }, { frames: [0.5] }, { times: [Infinity] },
    { metrics: Array(1) }, { metrics: [] },
    { params: { enter: ['event(start)'] }, events: [{ kind: 'named', id: 'start' }] },
  ].map(patch => ({ ...request, ...patch, ...(Object.hasOwn(patch, 'axes') ? { params: undefined } : {}) }))];
  for (const req of invalid) {
    const res = await cards.sweepCard(TITLE_CARD, req, options);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'usage.bad-argument');
  }
  for (const keys of [null, 1n, NaN, new Map(), new Date(), [{ pos: Array(3) }], [{ f: null }]]) {
    const res = await cards.sweepCard(CAMERA, { params: { keys: [CAMERA.params.keys.default, keys] }, metrics: ['value'] }, options);
    assert.equal(res.error?.code, 'usage.bad-argument');
  }
  assert.equal(calls, 0);
});

test('data 的显式取值与默认值均在第一格前按卡目录的 schema 校验', async () => {
  const valid = CAMERA.params.keys.default;
  const invalid = [{ ...valid[0], f: -1 }];
  let calls = 0;
  const opts = { evaluateCell() { calls++; return { value: 1 }; } };
  const badDefault = { ...CAMERA, params: { ...CAMERA.params, keys: { ...CAMERA.params.keys, default: invalid } } };
  for (const [card, params] of [[CAMERA, { keys: [valid, invalid] }], [badDefault, { fovDeg: [30] }]]) {
    const res = await cards.sweepCard(card, { params, metrics: ['value'] }, opts);
    assert.equal(res.error?.code, 'usage.bad-argument');
    assert.equal(calls, 0);
  }
});

test('浮点曝光按比例改变亮度，差异指标区分完全相同和不同的帧', async () => {
  const metrics = ['lumaMean', 'lumaP50', 'lumaP95', 'lumaP99', 'contrast', 'psnr', 'ssim', 'maxDiff'];
  const res = await cards.sweepCard(TITLE_CARD, { params: { distance: [0.5, 1, 1.5] }, metrics }, {
    evaluateCell({ params }) {
      const referenceRgb = Float32Array.of(0, 0, 0, 0.5, 0.5, 0.5);
      return { width: 2, height: 1, referenceRgb, rgb: referenceRgb.map(v => v * params.distance) };
    },
  });
  assert.deepEqual(res.rows.map(r => r.slice(1, 6)), [[0.125, 0, 0.25, 0.25, 0.25], [0.25, 0, 0.5, 0.5, 0.5], [0.375, 0, 0.75, 0.75, 0.75]]);
  assert.deepEqual(res.rows[1].slice(-3), [99, 1, 0]);
  assert.ok(Math.abs(res.rows[0][6] - 15.0515) < 0.001);
  assert.ok(res.rows[0][7] < 1 && res.rows[2][7] < 1);
  assert.equal(res.rows[0][8], 0.25);
});

test('RGBA8 忽略透明度，按通道统计压死与溢出', async () => {
  const res = await cards.sweepCard(TITLE_CARD, { ...request, metrics: ['lumaMin', 'lumaMax', 'lumaP05', 'highlightClipRatio', 'shadowCrushRatio'] },
    { evaluateCell: () => ({ channels: 4, width: 2, height: 1, rgb: Uint8Array.of(0, 0, 0, 255, 255, 0, 0, 0) }) });
  assert.deepEqual(res.rows, [[1, 0, 0.2126, 0, 0.5, 0.5]]);
});

test('两张反相棋盘字节帧的均值与方差相同，结构相反', async () => {
  const rgb = Uint8Array.from([0, 128, 128, 0].flatMap(v => [v, v, v]));
  const res = await cards.sweepCard(TITLE_CARD, { ...request, metrics: ['psnr', 'ssim', 'maxDiff'] }, {
    evaluateCell: () => ({ width: 2, height: 2, rgb, referenceRgb: rgb.map(v => 128 - v) }),
  });
  assert.deepEqual(res.rows, [[1, 5.9866, -0.9858, 0.502]]);
});

test('100 级灰阶按最近秩 P95 和 P05 计算对比度', async () => {
  const rgb = Uint8Array.from({ length: 300 }, (_, i) => Math.floor(i / 3));
  const res = await cards.sweepCard(TITLE_CARD, { ...request, metrics: ['lumaP95', 'lumaP99', 'contrast'] }, {
    evaluateCell: () => ({ width: 100, height: 1, rgb }),
  });
  const p05 = 4 / 255, p95 = 94 / 255;
  assert.deepEqual(res.rows, [[1, 0.3686, 0.3843, Number((p95 - p05).toFixed(4))]]);
});

test('缺指标、非有限读数和坏像素返回结构化错误', async () => {
  for (const output of [{}, { readings: { psnr: NaN } }, { psnr: Infinity },
    { rgb: Uint8Array.of(0, 0, 0), width: 1, height: 1 },
    { rgb: new Float32Array(3), referenceRgb: Float32Array.of(0, 0, NaN), width: 1, height: 1 },
    { rgb: new Float32Array(2), referenceRgb: new Float32Array(2), width: 1, height: 1 }]) {
    const res = await cards.sweepCard(TITLE_CARD, { ...request, metrics: ['psnr'] }, { evaluateCell: () => output });
    assert.equal(res.error?.code, 'contract.bad-value');
  }
});

test('384 行保留完整确定性产物，响应含产物引用仍不超过 800 字节', async (t) => {
  const outDir = directory(t);
  const metrics = ['a', 'b', 'c', 'd', 'e', 'f'];
  const req = { params: { settleFrames: Array.from({ length: 64 }, (_, i) => i) }, frames: [0, 1, 2, 3, 4, 5], metrics, outDir };
  const options = { evaluateCell: ({ frame, cellIndex }) => Object.fromEntries(metrics.map((m, i) => [m, frame + cellIndex / (i + 1)])) };
  const res = await cards.sweepCard(TITLE_CARD, req, options);
  assert.equal(res.totalCells, 384);
  assert.equal(res.truncated, true);
  assert.equal(res.omittedRows, 384 - res.rows.length);
  assert.ok(res.rows.length > 0 && cards.estimateTokens(res) <= 800);
  const bytes = fs.readFileSync(path.resolve(outDir, res.artifacts.cellsPath));
  assert.equal(res.artifacts.sha256, hash(bytes));
  const full = JSON.parse(bytes);
  assert.equal(full.rows.length, 384);
  assert.deepEqual(full.columns, res.columns);
  assert.equal(full.cells.length, 64);
  const { sha256, ...last } = full.cells.at(-1);
  assert.equal(last.params.settleFrames, 63);
  assert.equal(last.samples.at(-1).frame, 5);
  assert.equal(last.samples.at(-1).readings.f, 15.5);
  assert.equal(sha256, hash(JSON.stringify(last)));
  assert.deepEqual(await cards.sweepCard(TITLE_CARD, req, options), res);
});

test('超长 Unicode 值按字节截断，列名超预算返回短错误', async () => {
  const value = '片'.repeat(500);
  const res = await cards.sweepCard(TITLE_CARD, { params: { text: [value] }, metrics: ['value'] }, evaluate);
  assert.equal(res.omittedRows, 1);
  assert.ok(cards.estimateTokens(res) <= 800);
  const failed = await cards.sweepCard(TITLE_CARD, { ...request, metrics: [value] }, { evaluateCell: () => ({ [value]: 1 }) });
  assert.equal(failed.error.code, 'contract.bad-value');
  assert.ok(cards.estimateTokens(failed) <= 800);
});

test('完整表恰好 800 字节时保留最后一行，801 字节时省略', async () => {
  const run = text => cards.sweepCard(TITLE_CARD, { ...request, params: { text: [text] } }, evaluate);
  const size = cards.estimateTokens(await run(''));
  const exact = 'x'.repeat(800 - size);
  const fits = await run(exact);
  assert.deepEqual(fits.rows, [[exact, 1]]);
  assert.equal(cards.estimateTokens(fits), 800);
  const over = await run(exact + 'x');
  assert.equal(over.truncated, true);
  assert.equal(over.omittedRows, 1);
  assert.deepEqual(over.rows, []);
  assert.ok(cards.estimateTokens(over) <= 800);
});

test('回调的长异常返回登记码和有界诊断', async () => {
  const res = await cards.sweepCard(TITLE_CARD, request, { evaluateCell() { throw new Error('坏\u0000'.repeat(500)); } });
  assert.equal(res.error.code, 'contract.bad-value');
  assert.match(res.error.message, /^evaluateCell failed: 坏/);
  assert.ok(cards.estimateTokens(res) <= 800);
});

test('保留已有文件并拒绝目标或上级目录中的符号链接', async (t) => {
  const root = directory(t), other = directory(t);
  const file = path.join(other, 'cells.json');
  const foreign = '{"format":"cards-sweep/0.1","note":"其他工具的数据"}';
  fs.writeFileSync(file, foreign);
  fs.writeFileSync(path.join(other, 'keep'), '保留');
  fs.symlinkSync(other, path.join(root, 'link'), 'dir');
  let calls = 0;
  const options = { evaluateCell() { calls++; return { value: 0 }; } };
  for (const [outDir, code] of [[other, 'contract.bad-value'], [path.join(root, 'link'), 'usage.bad-argument'],
    [path.join(root, 'link', 'sub'), 'usage.bad-argument'], [path.join(other, 'keep', 'sub'), 'usage.bad-argument']]) {
    const res = await cards.sweepCard(TITLE_CARD, { ...request, outDir }, options);
    assert.equal(res.error?.code, code);
  }
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(other, 'sub')), false);
  fs.symlinkSync(file, path.join(root, 'cells.json'));
  assert.equal((await cards.sweepCard(TITLE_CARD, { ...request, outDir: root }, evaluate)).ok, false);
  assert.deepEqual(fs.readdirSync(other).sort(), ['cells.json', 'keep']);
  assert.equal(fs.readFileSync(file, 'utf8'), foreign);
});

test('cells.json 链接即使指向完整扫参产物，也在求值前拒绝', async t => {
  const root = directory(t), other = directory(t);
  assert.equal((await cards.sweepCard(TITLE_CARD, { ...request, outDir: other }, evaluate)).ok, true);
  const target = path.join(other, 'cells.json');
  const bytes = fs.readFileSync(target);
  const link = path.join(root, 'cells.json');
  fs.symlinkSync(target, link);
  let calls = 0;
  const res = await cards.sweepCard(TITLE_CARD, { ...request, outDir: root }, {
    evaluateCell() { calls++; return { value: 2 }; },
  });
  assert.equal(res.error?.code, 'usage.bad-argument');
  assert.equal(calls, 0);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test('无硬链接卷通过排他复制发布，重复运行可替换自己的产物', async t => {
  const root = directory(t);
  let code;
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error(), { code }); });
  const copy = t.mock.method(fs, 'copyFileSync');
  for (code of ['ENOTSUP', 'EPERM', 'EXDEV', 'ENOSYS']) {
    const req = { ...request, outDir: path.join(root, code) };
    for (const value of [1, 2]) {
      const res = await cards.sweepCard(TITLE_CARD, req, { evaluateCell: () => ({ value }) });
      assert.equal(res.ok, true, JSON.stringify(res));
      const bytes = fs.readFileSync(path.join(req.outDir, 'cells.json'));
      assert.equal(hash(bytes), res.artifacts.sha256);
      assert.deepEqual(JSON.parse(bytes).rows, [[1, value]]);
      assert.deepEqual(fs.readdirSync(req.outDir), ['cells.json']);
    }
  }
  assert.ok(copy.mock.callCount() >= 4);
  assert.ok(copy.mock.calls.every(c => c.arguments[2] === fs.constants.COPYFILE_EXCL));
});

test('文件系统错误不暴露绝对路径', async t => {
  const root = directory(t);
  const req = { ...request, outDir: path.join(root, 'x'.repeat(300)) };
  let calls = 0;
  const res = await cards.sweepCard(TITLE_CARD, req, { evaluateCell() { calls++; return { value: 0 }; } });
  assert.equal(calls, 0);
  assert.equal(res.error?.code, 'usage.bad-argument');
  assert.ok(!res.error.message.includes(root));
  assert.ok(cards.estimateTokens(res) <= 800);
});

test('C6-R2-Red: outDir 前置校验（非法 outDir 求值 0 次，未 realpath 的 os.tmpdir()/sub 正常落盘）且错误码全部来自 errors.json', async () => {
  const os = await import('node:os');
  const ERRORS = new Set(JSON.parse(fs.readFileSync(path.join(HERE, '../kernel/contracts/errors/errors.json'), 'utf8')).codes.map((c) => c.code));
  let calls = 0;
  const badOut = await cards.sweepCard(TITLE_CARD, { params: { settleFrames: [0, 1] }, metrics: ['a'], outDir: '' }, {
    evaluateCell: () => { calls += 1; return { a: 1 }; },
  });
  assert.equal(badOut.ok, false);
  assert.equal(calls, 0, '非法 outDir 必须在 0 次求值前拒绝');
  assert.ok(ERRORS.has(badOut.error.code), `unregistered code: ${badOut.error.code}`);

  const rawTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-c6-rawtmp-'));
  try {
    const okTmp = await cards.sweepCard(TITLE_CARD, { params: { settleFrames: [0, 1] }, metrics: ['a'], outDir: path.join(rawTmp, 'nested') }, {
      evaluateCell: ({ resolvedParams }) => ({ a: resolvedParams.settleFrames }),
    });
    assert.equal(okTmp.ok, true, JSON.stringify(okTmp));
    assert.ok(fs.existsSync(path.join(rawTmp, 'nested', 'cells.json')));
  } finally {
    fs.rmSync(rawTmp, { recursive: true, force: true });
  }

  const missingMetric = await cards.sweepCard(TITLE_CARD, { params: { settleFrames: [0] }, metrics: ['missing'] }, { evaluateCell: () => ({ a: 1 }) });
  assert.equal(missingMetric.ok, false);
  assert.ok(ERRORS.has(missingMetric.error.code), `unregistered code: ${missingMetric.error.code}`);
  const hugeCol = '片'.repeat(500);
  const budgetErr = await cards.sweepCard(TITLE_CARD, { params: { settleFrames: [0] }, metrics: [hugeCol] }, { evaluateCell: () => ({ [hugeCol]: 1 }) });
  assert.equal(budgetErr.ok, false);
  assert.ok(ERRORS.has(budgetErr.error.code), `unregistered code: ${budgetErr.error.code}`);
});
