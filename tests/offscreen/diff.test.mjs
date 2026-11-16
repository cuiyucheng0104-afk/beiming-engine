// 离屏出片 · 像素对比与质量门（engine/offscreen/diff.mjs）：纯函数，不需要 GPU。
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRgba, meetsGate } from '../../engine/offscreen/diff.mjs';

const solid = (n, v) => { const b = new Uint8Array(n * 4); for (let i = 0; i < n; i++) b.set([v, v, v, 255], i * 4); return b; };

test('diffRgba：逐字节相同 → identical，PSNR 无穷', () => {
  const r = diffRgba(solid(4, 10), solid(4, 10), { width: 2, height: 2 });
  assert.deepEqual([r.identical, r.differPixels, r.bigPixels, r.maxDelta, r.psnr], [true, 0, 0, 0, Infinity]);
});

test('diffRgba：一个像素差 3 级 → 1 个不同、0 个大差、最大差 3', () => {
  const a = solid(4, 10), b = solid(4, 10); b[0] = 13;
  const r = diffRgba(a, b, { width: 2, height: 2 });
  assert.deepEqual([r.identical, r.differPixels, r.bigPixels, r.maxDelta], [false, 1, 0, 3]);
  assert.ok(Number.isFinite(r.psnr) && r.psnr > 40);
});

test('diffRgba：差 5 级算大差；alpha 不参与比较', () => {
  const a = solid(4, 10), b = solid(4, 10); b[4] = 15; b[3] = 0;
  const r = diffRgba(a, b, { width: 2, height: 2 });
  assert.deepEqual([r.differPixels, r.bigPixels, r.maxDelta], [1, 1, 5]);
});

test('diffRgba：字节数与宽高不符抛 RangeError', () => {
  assert.throws(() => diffRgba(solid(4, 0), solid(3, 0), { width: 2, height: 2 }), RangeError);
});

test('meetsGate：PSNR 够且大差像素少 → 通过；否则写明原因', () => {
  assert.deepEqual(meetsGate({ pixels: 1e6, bigPixels: 10, psnr: 60 }), { ok: true, reasons: [] });
  const low = meetsGate({ pixels: 1e6, bigPixels: 0, psnr: 40 });
  assert.equal(low.ok, false); assert.match(low.reasons[0], /PSNR 40\.0 dB 低于 50 dB/);
  const big = meetsGate({ pixels: 1000, bigPixels: 5, psnr: 60 });
  assert.equal(big.ok, false); assert.match(big.reasons[0], /差 5 级以上的像素占 0\.500%/);
});
