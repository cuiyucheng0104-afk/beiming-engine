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

test('C6-1 Red: cards.sweepCard 按参数轴笛卡尔积返回「参数值对量测值」表且严格 <= 800 token', async () => {
  assert.equal(typeof cards.sweepCard, 'function');
  assert.equal(cards.SWEEP_TOKEN_LIMIT, 800);
  const res = await cards.sweepCard(
    TITLE_CARD,
    {
      axes: ['heightFrac=0.08,0.12,0.16'],
      baseParams: { text: 'RTX 5090' },
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
    { frames: Array(7).fill(0) }, { times: Array(1) }, { frames: [0.5] }, { times: [Infinity] },
    { metrics: Array(1) }, { metrics: [] },
    { params: { enter: ['event(start)'] }, events: [{ kind: 'named', id: 'start' }] },
  ].map(patch => ({ ...request, ...patch, ...(Object.hasOwn(patch, 'axes') ? { params: undefined } : {}) }))];
  for (const req of invalid) assert.equal((await cards.sweepCard(TITLE_CARD, req, options)).error?.code, 'usage.bad-argument');
  for (const keys of [null, 1n, NaN, new Map(), new Date(), [{ pos: Array(3) }], [{ f: null }]]) {
    const res = await cards.sweepCard(CAMERA, { params: { keys: [CAMERA.params.keys.default, keys] }, metrics: ['value'] }, options);
    assert.equal(res.error?.code, 'usage.bad-argument');
  }
  assert.equal(calls, 0);
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

test('缺指标、非有限读数和坏像素返回结构化错误', async () => {
  for (const output of [{}, { readings: { psnr: NaN } }, { psnr: Infinity },
    { rgb: Uint8Array.of(0, 0, 0), width: 1, height: 1 },
    { rgb: new Float32Array(3), referenceRgb: Float32Array.of(0, 0, NaN), width: 1, height: 1 },
    { rgb: new Float32Array(2), referenceRgb: new Float32Array(2), width: 1, height: 1 }]) {
    const res = await cards.sweepCard(TITLE_CARD, { ...request, metrics: ['psnr'] }, { evaluateCell: () => output });
    assert.equal(res.error?.code, 'contract.missing-metric');
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
  assert.equal(failed.error.code, 'contract.budget-exceeded');
  assert.ok(cards.estimateTokens(failed) <= 800);
});

test('保留已有文件并拒绝目标或上级目录中的符号链接', async (t) => {
  const root = directory(t), other = directory(t);
  const file = path.join(other, 'cells.json');
  const foreign = '{"format":"cards-sweep/0.1","note":"其他工具的数据"}';
  fs.writeFileSync(file, foreign);
  fs.writeFileSync(path.join(other, 'keep'), '保留');
  fs.symlinkSync(other, path.join(root, 'link'), 'dir');
  for (const outDir of [other, path.join(root, 'link', 'sub')]) {
    assert.equal((await cards.sweepCard(TITLE_CARD, { ...request, outDir }, evaluate)).ok, false);
  }
  assert.equal(fs.existsSync(path.join(other, 'sub')), false);
  fs.symlinkSync(file, path.join(root, 'cells.json'));
  assert.equal((await cards.sweepCard(TITLE_CARD, { ...request, outDir: root }, evaluate)).ok, false);
  assert.deepEqual(fs.readdirSync(other).sort(), ['cells.json', 'keep']);
  assert.equal(fs.readFileSync(file, 'utf8'), foreign);
});
