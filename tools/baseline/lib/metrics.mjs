// 北冥仓库 · 像素比对：逐像素差、PSNR、SSIM、差异热图与接触印。纯 JS，不依赖 Python / npm。
//
//   compareImages(a, b) → { identical, pixels, differing, fracDiffer, fracAbove1, fracAbove2, maxDiff, psnr, ssim, ssimRGB }
//     a、b 是 { width, height, rgb }（png.mjs 解出来的 RGB）
//     差值按通道取绝对值，一个像素的差 = 三个通道里最大的那个；fracAbove1 = 差 > 1 级的像素占比
//     psnr：三通道合算 MSE，10·log10(255² / MSE)，完全一致时为 null
//     ssim：每个通道按 x264 / FFmpeg ssim 滤镜的算法（4×4 小块求和、8×8 窗口、步长 4，常数 c1 = (0.01·255)²·64、
//           c2 = (0.03·255)²·64·63）算平均，再取三通道均值
//   judge(stats, tol)    按容差判定：{ ok, reasons[] }
//     tol = { maxFracAbove1?, maxFracAbove2?, maxDiff?, ssimMin?, psnrMin? }（缺省的项不判）
//   diffHeatmap(a, b, { gain })  差异热图：没差的像素是压暗的灰度底图，有差的按差值 × gain 从黄到红
//   contactSheet(rows, { tileW })  接触印：每行 [参照, 当前, 热图] 三张缩到 tileW 宽
//   downscale(img, w)    盒式滤波缩小到宽 w（等比）

export function compareImages(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { identical: false, sizeMismatch: true, sizeA: [a.width, a.height], sizeB: [b.width, b.height] };
  }
  const A = a.rgb, B = b.rgb, n = a.width * a.height;
  let differing = 0, above1 = 0, above2 = 0, maxDiff = 0, sse = 0;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const dr = A[p] - B[p], dg = A[p + 1] - B[p + 1], db = A[p + 2] - B[p + 2];
    if (dr === 0 && dg === 0 && db === 0) continue;
    const m = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
    differing++;
    if (m > 1) above1++;
    if (m > 2) above2++;
    if (m > maxDiff) maxDiff = m;
    sse += dr * dr + dg * dg + db * db;
  }
  if (!differing) return { identical: true, pixels: n, differing: 0, fracDiffer: 0, fracAbove1: 0, fracAbove2: 0, maxDiff: 0, psnr: null, ssim: 1, ssimRGB: [1, 1, 1] };
  const mse = sse / (n * 3);
  const ssimRGB = [0, 1, 2].map(c => ssimPlane(A, B, a.width, a.height, c));
  return {
    identical: false, pixels: n, differing,
    fracDiffer: differing / n, fracAbove1: above1 / n, fracAbove2: above2 / n, maxDiff,
    psnr: round(10 * Math.log10((255 * 255) / mse), 3),
    ssim: round((ssimRGB[0] + ssimRGB[1] + ssimRGB[2]) / 3, 6), ssimRGB: ssimRGB.map(v => round(v, 6)),
  };
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

const C1 = 0.01 * 0.01 * 255 * 255 * 64, C2 = 0.03 * 0.03 * 255 * 255 * 64 * 63;
function ssimPlane(A, B, w, h, c) {
  const bw = w >> 2, bh = h >> 2;
  if (bw < 2 || bh < 2) return 1;
  const s1 = new Float64Array(bw * bh), s2 = new Float64Array(bw * bh), ss = new Float64Array(bw * bh), s12 = new Float64Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let x1 = 0, x2 = 0, xx = 0, x12 = 0;
      for (let y = 0; y < 4; y++) {
        let p = ((by * 4 + y) * w + bx * 4) * 3 + c;
        for (let x = 0; x < 4; x++, p += 3) { const va = A[p], vb = B[p]; x1 += va; x2 += vb; xx += va * va + vb * vb; x12 += va * vb; }
      }
      const k = by * bw + bx;
      s1[k] = x1; s2[k] = x2; ss[k] = xx; s12[k] = x12;
    }
  }
  let total = 0, count = 0;
  for (let by = 0; by < bh - 1; by++) {
    for (let bx = 0; bx < bw - 1; bx++) {
      const k = by * bw + bx, k2 = k + bw;
      const a1 = s1[k] + s1[k + 1] + s1[k2] + s1[k2 + 1], a2 = s2[k] + s2[k + 1] + s2[k2] + s2[k2 + 1];
      const aa = ss[k] + ss[k + 1] + ss[k2] + ss[k2 + 1], a12 = s12[k] + s12[k + 1] + s12[k2] + s12[k2 + 1];
      const vars = aa * 64 - a1 * a1 - a2 * a2, covar = a12 * 64 - a1 * a2;
      total += ((2 * a1 * a2 + C1) * (2 * covar + C2)) / ((a1 * a1 + a2 * a2 + C1) * (vars + C2));
      count++;
    }
  }
  return total / count;
}

export function judge(stats, tol = {}) {
  const reasons = [];
  if (stats.identical) return { ok: true, reasons };
  if (stats.sizeMismatch) return { ok: false, reasons: [`尺寸不同：${stats.sizeA.join('x')} 对 ${stats.sizeB.join('x')}`] };
  const pct = v => `${(v * 100).toFixed(3)}%`;
  if (tol.maxFracAbove1 != null && stats.fracAbove1 > tol.maxFracAbove1) reasons.push(`差 >1 级的像素 ${pct(stats.fracAbove1)}，超过 ${pct(tol.maxFracAbove1)}`);
  if (tol.maxFracAbove2 != null && stats.fracAbove2 > tol.maxFracAbove2) reasons.push(`差 >2 级的像素 ${pct(stats.fracAbove2)}，超过 ${pct(tol.maxFracAbove2)}`);
  if (tol.maxDiff != null && stats.maxDiff > tol.maxDiff) reasons.push(`最大差 ${stats.maxDiff} 级，超过 ${tol.maxDiff}`);
  if (tol.ssimMin != null && stats.ssim < tol.ssimMin) reasons.push(`SSIM ${stats.ssim} 低于 ${tol.ssimMin}`);
  if (tol.psnrMin != null && stats.psnr != null && stats.psnr < tol.psnrMin) reasons.push(`PSNR ${stats.psnr} dB 低于 ${tol.psnrMin}`);
  return { ok: reasons.length === 0, reasons };
}

export function diffHeatmap(a, b, { gain = 8 } = {}) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const out = Buffer.allocUnsafe(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pa = (y * a.width + x) * 3, pb = (y * b.width + x) * 3, o = (y * w + x) * 3;
      const m = Math.max(Math.abs(a.rgb[pa] - b.rgb[pb]), Math.abs(a.rgb[pa + 1] - b.rgb[pb + 1]), Math.abs(a.rgb[pa + 2] - b.rgb[pb + 2]));
      if (m === 0) {
        const l = (b.rgb[pb] * 0.2126 + b.rgb[pb + 1] * 0.7152 + b.rgb[pb + 2] * 0.0722) * 0.28;
        out[o] = out[o + 1] = out[o + 2] = l;
      } else {
        const v = Math.min(1, (m * gain) / 255);
        out[o] = 255; out[o + 1] = Math.round(235 * (1 - v)); out[o + 2] = Math.round(60 * (1 - v));
      }
    }
  }
  return { width: w, height: h, rgb: out };
}

export function downscale(img, tw) {
  const k = Math.max(1, Math.round(img.width / tw));
  const w = Math.floor(img.width / k), h = Math.floor(img.height / k);
  const out = Buffer.allocUnsafe(w * h * 3), area = k * k;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0;
      for (let yy = 0; yy < k; yy++) {
        let p = ((y * k + yy) * img.width + x * k) * 3;
        for (let xx = 0; xx < k; xx++, p += 3) { r += img.rgb[p]; g += img.rgb[p + 1]; bl += img.rgb[p + 2]; }
      }
      const o = (y * w + x) * 3;
      out[o] = r / area; out[o + 1] = g / area; out[o + 2] = bl / area;
    }
  }
  return { width: w, height: h, rgb: out };
}

export function contactSheet(rows, { tileW = 480, gap = 6, bg = [24, 22, 30] } = {}) {
  const scaled = rows.map(r => r.map(img => (img ? downscale(img, tileW) : null)));
  const cols = Math.max(...scaled.map(r => r.length));
  const tw = Math.max(...scaled.flat().filter(Boolean).map(i => i.width));
  const rowH = scaled.map(r => Math.max(...r.filter(Boolean).map(i => i.height)));
  const W = cols * tw + (cols + 1) * gap, H = rowH.reduce((s, v) => s + v, 0) + (rows.length + 1) * gap;
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }
  let y0 = gap;
  scaled.forEach((r, ri) => {
    r.forEach((img, ci) => {
      if (!img) return;
      const x0 = gap + ci * (tw + gap);
      for (let y = 0; y < img.height; y++) img.rgb.copy(rgb, ((y0 + y) * W + x0) * 3, y * img.width * 3, (y + 1) * img.width * 3);
    });
    y0 += rowH[ri] + gap;
  });
  return { width: W, height: H, rgb };
}
