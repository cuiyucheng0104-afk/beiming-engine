// 北冥引擎 · 离屏出片 · 像素对比与质量门（纯函数）：预览对出片的同帧对拍用它判定（docs/offscreen/README.md 第 4 节）。
//   diffRgba(a, b, { width, height }) → { pixels, identical, differPixels, bigPixels, maxDelta, psnr }
//       a、b 是 RGBA8（每像素 4 字节）；只比 RGB，alpha 不参与。differPixels：任一通道不同的像素数；
//       bigPixels：任一通道差 ≥ 5 级的像素数；maxDelta：最大单通道差；psnr：三通道合并的 PSNR（dB），完全相同时是 Infinity。
//       字节数不等于 width × height × 4 → RangeError
//   meetsGate(stats, { minPsnr = 50, maxBigFraction = 0.001 }) → { ok, reasons }   reasons 是不通过的原因（中文）
export const BIG_DELTA = 5;

export function diffRgba(a, b, { width, height }) {
  const pixels = width * height;
  if (a.length !== pixels * 4 || b.length !== pixels * 4) {
    throw new RangeError(`像素字节数应为 ${pixels * 4}（${width}×${height}×4），收到 ${a.length} 与 ${b.length}`);
  }
  let differPixels = 0, bigPixels = 0, maxDelta = 0, se = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]), dg = Math.abs(a[i + 1] - b[i + 1]), db = Math.abs(a[i + 2] - b[i + 2]);
    const m = Math.max(dr, dg, db);
    if (m) { differPixels++; if (m >= BIG_DELTA) bigPixels++; if (m > maxDelta) maxDelta = m; se += dr * dr + dg * dg + db * db; }
  }
  const mse = se / (pixels * 3);
  return { pixels, identical: differPixels === 0, differPixels, bigPixels, maxDelta, psnr: mse ? 10 * Math.log10((255 * 255) / mse) : Infinity };
}

export function meetsGate(stats, { minPsnr = 50, maxBigFraction = 0.001 } = {}) {
  const reasons = [];
  if (stats.psnr < minPsnr) reasons.push(`PSNR ${stats.psnr.toFixed(1)} dB 低于 ${minPsnr} dB`);
  const frac = stats.bigPixels / stats.pixels;
  if (frac > maxBigFraction) reasons.push(`差 ${BIG_DELTA} 级以上的像素占 ${(frac * 100).toFixed(3)}%，超过 ${(maxBigFraction * 100).toFixed(3)}%`);
  return { ok: reasons.length === 0, reasons };
}
