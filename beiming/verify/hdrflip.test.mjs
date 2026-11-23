import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeExr } from './exr/exr.mjs';
import * as verify from './index.mjs';

// 官方 flip-evaluator==1.7 (Andersson et al., HPG 2021, BSD-3) 实测参考真值向量
// Case 1 (32x32 HDR 斜坡 + 太阳高光圆盘): mean = 0.2974036931991577, startExposure = -1.5509709119796753, stopExposure = 0.7468792796134949, numExposures = 3
// Case 2 (32x32 暗场零中位数 + 局部高光位移, v1.7 median=0 分支): mean = 0.08365276455879211, startExposure = -0.46425142884254456, stopExposure = 24.083297729492188, numExposures = 25
// Case 3 (37x23 非方形伪随机 HDR, 含负值, 像素数为奇数): mean = 0.15749846398830414, startExposure = -3.0631322860717773, stopExposure = 0.9255223870277405, numExposures = 4

test('V17-1 两张相同 HDR 图像（含高动态范围与全零黑图）HDR-FLIP 恒等于 0', () => {
  assert.equal(typeof verify.hdrFlip, 'function', 'beiming/verify/index.mjs 必须导出 hdrFlip');
  const w = 24, h = 16;
  const img = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    img[i * 3] = (i % w) * 0.5;
    img[i * 3 + 1] = Math.floor(i / w) * 0.25;
    img[i * 3 + 2] = i === 100 ? 12.0 : 0.05;
  }
  const same = verify.hdrFlip({ width: w, height: h, data: img, channels: 3 }, { width: w, height: h, data: new Float32Array(img), channels: 3 });
  assert.equal(same.metric, 'metric:image.hdrflip');
  assert.equal(same.value, 0);
  assert.ok(same.errorMap instanceof Float32Array);
  assert.equal(same.errorMap.length, w * h);
  assert.ok(same.errorMap.every((v) => v === 0));

  const zero = new Float32Array(w * h * 3);
  const sameZero = verify.hdrFlip({ width: w, height: h, data: zero, channels: 3 }, { width: w, height: h, data: zero, channels: 3 });
  assert.equal(sameZero.value, 0);
});

test('V17-2 对齐官方 flip-evaluator v1.7 真值一：HDR 斜坡加太阳圆盘平均值误差 <= 1e-4', () => {
  const w = 32, h = 32;
  const ref = new Float32Array(w * h * 3);
  const tst = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 3;
      const inDisk = (x - 16) ** 2 + (y - 16) ** 2 <= 36;
      const r = inDisk ? 8.0 : (x / (w - 1)) * 4.0;
      const g = inDisk ? 6.0 : (y / (h - 1)) * 2.0;
      const b = inDisk ? 3.0 : 0.25;
      ref[idx] = r; ref[idx + 1] = g; ref[idx + 2] = b;
      tst[idx] = Math.fround(r * Math.fround(1.12));
      tst[idx + 1] = Math.fround(g * Math.fround(1.12));
      tst[idx + 2] = Math.fround(Math.fround(b * Math.fround(1.12)) + Math.fround(0.08));
    }
  }
  const res = verify.hdrFlip({ width: w, height: h, data: ref, channels: 3 }, { width: w, height: h, data: tst, channels: 3 });
  assert.equal(res.details.numExposures, 3);
  assert.ok(Math.abs(res.details.startExposure - (-1.5509709119796753)) <= 1e-4, `startExposure=${res.details.startExposure}`);
  assert.ok(Math.abs(res.details.stopExposure - 0.7468792796134949) <= 1e-4, `stopExposure=${res.details.stopExposure}`);
  assert.ok(Math.abs(res.value - 0.2974036931991577) <= 1e-4, `HDR-FLIP mean=${res.value}, expected=0.29740369`);
  assert.ok(Math.abs(res.errorMap[0] - 0.32486921548843384) <= 5e-4, `p(0,0)=${res.errorMap[0]}`);
  assert.ok(Math.abs(res.errorMap[16 * w + 16] - 0.11778046935796738) <= 5e-4, `p(16,16)=${res.errorMap[16 * w + 16]}`);
});

test('V17-3 对齐官方 flip-evaluator v1.7 真值二：零中位亮度暗场高光位移平均值误差 <= 1e-4 且支持 EXR 输入', () => {
  const w = 32, h = 32;
  const refR = new Float32Array(w * h), refG = new Float32Array(w * h), refB = new Float32Array(w * h), refA = new Float32Array(w * h).fill(1);
  const tstR = new Float32Array(w * h), tstG = new Float32Array(w * h), tstB = new Float32Array(w * h), tstA = new Float32Array(w * h).fill(1);
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) {
    const i = y * w + x;
    refR[i] = 5.0; refG[i] = 2.5; refB[i] = 1.0;
  }
  for (let y = 13; y < 21; y++) for (let x = 12; x < 20; x++) {
    const i = y * w + x;
    tstR[i] = 4.5; tstG[i] = 2.5; tstB[i] = 1.2;
  }
  const exrRef = writeExr({ width: w, height: h, channels: { 'color.R': refR, 'color.G': refG, 'color.B': refB, 'color.A': refA } });
  const exrTst = writeExr({ width: w, height: h, channels: { 'color.R': tstR, 'color.G': tstG, 'color.B': tstB, 'color.A': tstA } });

  const res = verify.hdrFlip(exrRef, exrTst);
  assert.equal(res.details.numExposures, 25);
  assert.ok(Math.abs(res.value - 0.08365276455879211) <= 1e-4, `HDR-FLIP mean=${res.value}, expected=0.08365276`);
});

test('V17-4 对齐官方 flip-evaluator v1.7 真值三：非方形、奇数像素数、含负值的伪随机 HDR 图', () => {
  const w = 37, h = 23;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const ref = new Float32Array(w * h * 3), tst = new Float32Array(w * h * 3);
  for (let i = 0; i < ref.length; i++) {
    ref[i] = Math.exp(rnd() * 8 - 5) - 0.01;
    tst[i] = ref[i] * (0.8 + 0.4 * rnd()) + (rnd() < 0.02 ? 3 : 0);
  }
  assert.ok(ref.some((v) => v < 0), '样本必须含负值，才量得到钳零');
  const res = verify.hdrFlip({ width: w, height: h, data: ref }, { width: w, height: h, data: tst });
  assert.equal(res.details.numExposures, 4);
  assert.ok(Math.abs(res.details.startExposure - (-3.0631322860717773)) <= 1e-4, `startExposure=${res.details.startExposure}`);
  assert.ok(Math.abs(res.details.stopExposure - 0.9255223870277405) <= 1e-4, `stopExposure=${res.details.stopExposure}`);
  assert.ok(Math.abs(res.value - 0.15749846398830414) <= 1e-4, `HDR-FLIP mean=${res.value}`);
  // 两个不对称位置的像素，行列写反就对不上。
  assert.ok(Math.abs(res.errorMap[20 * w + 5] - 0.15018709003925323) <= 5e-4, `p(5,20)=${res.errorMap[20 * w + 5]}`);
  assert.ok(Math.abs(res.errorMap[2 * w + 30] - 0.16345961391925812) <= 5e-4, `p(30,2)=${res.errorMap[2 * w + 30]}`);
  const { min, max, p50, p95 } = res.details;
  assert.ok(min >= 0 && min <= p50 && p50 <= p95 && p95 <= max && max <= 1, JSON.stringify(res.details));
  assert.equal(res.unit, 'flip');
  assert.equal(res.details.tonemapper, 'aces');
  assert.equal(res.details.ppd, 67.02064514160156);
});

test('V17-5 四通道、无前缀 R/G/B 的 EXR 文件路径与三通道数组结果一致', () => {
  const w = 9, h = 7, n = w * h;
  const rgb = (k) => Float32Array.from({ length: n * 3 }, (_, i) => ((i * 37 + k) % 23) / 5);
  const ref = rgb(0), tst = rgb(4);
  const base = verify.hdrFlip({ width: w, height: h, data: ref }, { width: w, height: h, data: tst });
  assert.ok(base.value > 0);

  const rgba = (src) => Float32Array.from({ length: n * 4 }, (_, i) => (i % 4 === 3 ? 0.5 : src[(i >> 2) * 3 + (i % 4)]));
  const four = verify.hdrFlip({ width: w, height: h, data: rgba(ref), channels: 4 }, { width: w, height: h, data: rgba(tst), channels: 4 });
  assert.deepEqual(four.errorMap, base.errorMap);

  const plane = (src, c) => Float32Array.from({ length: n }, (_, i) => src[i * 3 + c]);
  const exr = (src) => writeExr({ width: w, height: h, compression: 2, channels: { R: plane(src, 0), G: plane(src, 1), B: plane(src, 2) } });
  const dir = mkdtempSync(join(tmpdir(), 'hdrflip-'));
  try {
    writeFileSync(join(dir, 'ref.exr'), exr(ref));
    const mixed = verify.hdrFlip(join(dir, 'ref.exr'), new Uint8Array(exr(tst)));
    assert.deepEqual(mixed.errorMap, base.errorMap);
    assert.equal(mixed.value, base.value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V17-6 全黑参考图对非黑图给出有限的大误差，异常入参报错而不是返回 NaN', () => {
  const w = 8, h = 6, n = w * h;
  const img = (v) => ({ width: w, height: h, data: new Float32Array(n * 3).fill(v) });
  const dark = verify.hdrFlip(img(0), img(0.5));
  assert.ok(Number.isFinite(dark.value) && dark.value > 0.5, `全黑对中灰=${dark.value}`);
  assert.ok(Number.isFinite(dark.details.startExposure) && dark.details.numExposures === 2);

  const bad = (reference, test, options) => assert.throws(() => verify.hdrFlip(reference, test, options), RangeError);
  bad(img(1), { width: w, height: h + 1, data: new Float32Array(w * (h + 1) * 3) });
  bad({ width: -w, height: h, data: new Float32Array(n * 3) }, img(1));
  bad({ width: w, height: 0, data: new Float32Array(0) }, img(1));
  bad({ width: 4.5, height: h, data: new Float32Array(27 * 3) }, img(1));
  bad(img(1), { width: w, height: h, data: new Float32Array(n * 3 - 1) });
  bad(img(1), { width: w, height: h, data: new Float32Array(n * 2), channels: 2 });
  bad(img(1), { width: w, height: h, data: new Float64Array(n * 3) });
  bad(img(1), img(NaN));
  bad(img(Infinity), img(1));
  bad(img(1), null);
  bad('', img(1));
  bad(img(1), img(1), null);
  bad(img(1), img(1), 67);
  bad(img(1), img(1), { ppd: 0 });
  bad(img(1), img(1), { ppd: -10 });
  bad(img(1), img(1), { ppd: NaN });
  bad(img(1), img(1), { tonemapper: 'reinhard' });
  const depthOnly = writeExr({ width: w, height: h, channels: { 'depth.Z': new Float32Array(n) } });
  bad(depthOnly, depthOnly);
});
