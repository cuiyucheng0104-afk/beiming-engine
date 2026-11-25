import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cutGhost, lumaPercentile, LUMA_GHOST_METRICS, runLumaGhostMetric } from './index.mjs';
import * as observe from '../index.mjs';

function gray(width, height, fn, frame) {
  return { width, height, frame, data: Uint8Array.from({ length: width * height }, (_, i) => fn(i % width, Math.floor(i / width))) };
}
const flat = (v, frame) => gray(256, 1, () => v, frame);
const near = (actual, expected, eps = 1e-12) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≠ ${expected} ± ${eps}`);
const bad = e => e instanceof RangeError && e.code === 'usage.bad-argument';

test('O9 两级导出和冻结登记表，接受可选 metric 前缀', () => {
  for (const [name, fn] of [['cut.ghost', cutGhost], ['luma.percentile', lumaPercentile]]) {
    assert.equal(LUMA_GHOST_METRICS[name], fn);
    assert.equal(observe[fn.name], fn);
    for (const prefix of ['', 'metric:']) {
      assert.deepEqual(runLumaGhostMetric(prefix + name, [flat(42)], { cuts: [] }), fn([flat(42)], { cuts: [] }));
    }
  }
  assert.equal(observe.runLumaGhostMetric, runLumaGhostMetric);
  assert.equal(observe.LUMA_GHOST_METRICS, LUMA_GHOST_METRICS);
  assert.ok(Object.isFrozen(LUMA_GHOST_METRICS));
  assert.throws(() => runLumaGhostMetric('constructor', []), bad);
});

test('亮度按像素 nearest-rank：梯度/全暗/爆白、整片而非各帧均值；显式与自动切点', () => {
  const frames = [flat(0, 40), gray(256, 1, x => x, 41), flat(255, 42), flat(0, 43)];
  const r = lumaPercentile(frames, { cuts: [43, 42, 43] });
  assert.deepEqual(r.perFrame.map(s => s.code8), [[0, 0, 0], [2, 127, 253], [255, 255, 255], [0, 0, 0]]
    .map(([p01, p50, p99]) => ({ p01, p50, p99 })));
  assert.deepEqual(r.summary, { p01: 0, p50: 0, p99: 1, code8: { p01: 0, p50: 0, p99: 255 } });
  assert.equal(r.metric, 'metric:luma.percentile'); assert.equal(r.unit, 'normalized'); assert.equal(r.value, 1);
  assert.deepEqual(r.crossCutExposureDelta, [
    { cutFrame: 42, beforeP50: 127 / 255, afterP50: 1, deltaP50: 1 - 127 / 255, deltaP99: 1 - 253 / 255 },
    { cutFrame: 43, beforeP50: 1, afterP50: 0, deltaP50: -1, deltaP99: -1 },
  ]);
  assert.equal(r.maxCrossCutDeltaP50, 1); assert.equal(r.maxCrossCutDeltaP99, 1);
  assert.deepEqual(r, lumaPercentile(frames, { cuts: [42, 43] }));
  assert.deepEqual(lumaPercentile(frames).crossCutExposureDelta.map(c => c.cutFrame), [41, 42, 43]);
  assert.deepEqual(lumaPercentile(frames, { cuts: [] }).crossCutExposureDelta, []);
});

test('RGB/RGBA 使用 Rec.709 而非平均分量；浮点归一化不先舍入到 8 位，alpha 不参加统计', () => {
  const rgb = { width: 1, height: 1, channels: 3, data: Uint8Array.of(0, 255, 0) };
  const rgba = { width: 1, height: 1, data: Float32Array.of(1, 0, 0, 0) };
  const f = { width: 1, height: 1, data: Float32Array.of(0.497) };
  const r = lumaPercentile([rgb, rgba, f]);
  near(r.perFrame[0].p50, 0.7152); near(r.perFrame[1].p50, 0.2126);
  assert.equal(r.perFrame[2].p99, f.data[0]); assert.equal(r.summary.p50, f.data[0]);
  assert.equal(r.perFrame[2].code8.p99, f.data[0] * 255);
});

test('缺帧不挪用邻帧，低对比无证据不能当成零重影，显式空切表不自动补切', () => {
  const frames = [flat(0, 5), flat(100, 7), flat(99, 8), flat(101, 9)];
  const opts = { cuts: [5, 7, 8, 9, 12] };
  const r = cutGhost(frames, opts);
  assert.deepEqual(r.perCut.map(c => c.status), ['missing-frames', 'missing-frames', 'low-contrast', 'missing-frames', 'missing-frames']);
  assert.equal(r.value, null); assert.equal(r.hasGhost, null); assert.deepEqual(r.ghostFrames, []);
  for (const c of r.perCut) { assert.equal(c.ghostEnergy, null); assert.equal(c.hasGhost, null); }
  assert.deepEqual(lumaPercentile(frames, opts).missingCutFrames, [5, 7, 12]);
  assert.deepEqual(cutGhost(frames, { cuts: [] }).ghostFrames, []);
});

test('非空、尺寸、通道、样本、帧号与选项校验', () => {
  const f = flat(0);
  for (const input of [null, '', '   ', [], Array(2), [f, { ...f, width: 1 }], [{ ...f, data: [] }],
    [{ ...f, channels: 3 }], [{ ...f, width: 0 }], [f, gray(128, 2, () => 0)], [{ ...f, frame: -1 }],
    [flat(0, 5), flat(0, 5)], ...[NaN, Infinity, 1.1, -1].map(v => [{ width: 1, height: 1, data: Float32Array.of(v) }])]) {
    for (const fn of [cutGhost, lumaPercentile]) assert.throws(() => fn(input, { cuts: [] }), bad);
  }
  for (const opts of [null, { typo: true }, { cuts: 1 }, { cuts: [-1] }, { cuts: Array(1) }, { cutThreshold: 2 }]) {
    assert.throws(() => lumaPercentile([f], opts), bad);
  }
  for (const opts of [{}, { cuts: [], threshold: null }, { cuts: [], minCutDiff: NaN }]) assert.throws(() => cutGhost([f], opts), bad);
});

test('硬切静态/正常后镜平移无重影；前镜 20%/40% 曝光只报混叠的首帧', () => {
  const w = 40, h = 32;
  const old = gray(w, h, (x, y) => (x * 17 + y * 23) % 173);
  const fresh = gray(w, h, (x, y) => 45 + (x * 43 + y * 11) % 200);
  const shifted = gray(w, h, (x, y) => fresh.data[y * w + (x + 1) % w]);
  const mixed = alpha => ({ ...fresh, data: Uint8Array.from(fresh.data, (v, i) => Math.round((1 - alpha) * v + alpha * old.data[i])) });
  const frames = [old, fresh, fresh, old, fresh, shifted, old, mixed(0.2), fresh, old, mixed(0.4), fresh];
  const opts = { cuts: [1, 4, 7, 10] }, r = cutGhost(frames, opts);
  assert.equal(r.hasGhost, true); assert.deepEqual(r.ghostFrames, [7, 10]);
  assert.deepEqual(r.perCut.map(c => c.hasGhost), [false, false, true, true]);
  near(r.perCut[0].ghostEnergy, 0); near(r.perCut[1].ghostEnergy, 0);
  for (const [i, alpha] of [[2, 0.2], [3, 0.4]]) near(r.perCut[i].ghostEnergy, alpha, 0.005);
  assert.deepEqual(cutGhost(frames, opts), r);
  assert.deepEqual(cutGhost(frames, { ...opts, threshold: 0.3 }).ghostFrames, [10]);
  // 阈值本身可判，不能因码值先除以 255、再加不同次而抖到另一侧。
  for (const width of [3, 63, 257]) {
    const edge = cutGhost([20, 190, 220].map(v => gray(width, 1, () => v)), { cuts: [1] });
    assert.equal(edge.value, 0.15); assert.equal(edge.hasGhost, true);
  }
});

test('视频：缺 ffmpeg 有结构化读数，解码错误不能误报缺工具', async () => {
  const path = process.env.PATH;
  try {
    process.env.PATH = '';
    for (const fn of [cutGhost, lumaPercentile]) {
      const r = await fn('missing.mkv', { cuts: [2] });
      assert.equal(r.value, null); assert.equal(r.status, 'tool-missing');
      assert.deepEqual(r.details, { code: 'tool-missing', tool: 'ffmpeg' });
    }
  } finally { process.env.PATH = path; }
});

test('lavfi 生成无损灰度短片：跨 pipe 分块解码，干净硬切 vs 20% 混叠', async t => {
  if (spawnSync('ffmpeg', ['-version']).error?.code === 'ENOENT') return t.skip('环境缺少 ffmpeg');
  const dir = mkdtempSync(join(tmpdir(), 'observe-luma-ghost-'));
  try {
    await assert.rejects(lumaPercentile(join(dir, 'absent.mkv')), /ffmpeg:/);
    for (const [name, first, alpha] of [['clean', 220, 0], ['blend', 180, 0.2]]) {
      const file = join(dir, `${name}.mkv`);
      const generate = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
        `nullsrc=s=384x256:r=5:d=1,format=gray,geq=lum='if(lt(N,2),20,if(eq(N,2),${first},220))'`, '-c:v', 'ffv1', file]);
      assert.equal(generate.status, 0, generate.stderr?.toString());
      const opts = { cuts: [2] }, l = await lumaPercentile(file, opts), g = await cutGhost(file, opts);
      assert.deepEqual(l.perFrame.map(s => s.code8.p50), [20, 20, first, 220, 220]);
      near(l.maxCrossCutDeltaP99, (first - 20) / 255);
      assert.deepEqual(g.ghostFrames, alpha ? [2] : []); near(g.perCut[0].ghostEnergy, alpha, 1e-9);
      assert.deepEqual(await cutGhost(file, opts), g);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
