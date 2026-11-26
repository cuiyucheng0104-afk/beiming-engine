// 自动参考指标（计划书 7.3：只写进结果 JSON，不直接计分，供评审校准）。
//
//   seamDeltaE   相邻镜头接缝：切点前一帧与后一帧按 16×9 分块取平均色，逐块 ΔE00 的中位数
//                （DF-M「第 2 镜和第 1 镜接不上」的客观读数；大于约 10 通常一眼可见）
//   paletteDeltaE 色板差：成片与基线关键帧各做 k=6 的 Lab k-means，成片每个色心到基线最近色心的 ΔE00 中位数
//   lineCoverage 墨线覆盖率：亮度比 5×5 邻域最大值低 25 以上、且本身偏暗（L* < 45）的像素占比
//   grainEnergy  纸纹与颗粒的高频能量：原尺寸中心 256×256 区域亮度的平均 |拉普拉斯|
// 颜色换算：sRGB（D65）→ 线性 → XYZ → CIELAB；ΔE00 按 CIE 2000 公式（Sharma 等 2005 的实现说明）。
// 接口：srgbToLab、deltaE00、blockColors、seamDeltaE、kmeansLab、paletteDeltaE、lineCoverage、grainEnergy

const lin = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (t * 24389 / 27 + 16) / 116);

export function srgbToLab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = d => (d * Math.PI) / 180;
const deg = r => (r * 180) / Math.PI;

/** CIEDE2000 色差。 */
export function deltaE00([L1, a1, b1], [L2, a2, b2]) {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (b, a) => { if (a === 0 && b === 0) return 0; const v = deg(Math.atan2(b, a)); return v >= 0 ? v : v + 360; };
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2; else hbp = (h1p + h2p) / 2; }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.20 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (v, d = 2) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

/** 把 RGB 图分成 cols×rows 块，返回每块平均色的 Lab。 */
export function blockColors(img, cols = 16, rows = 9) {
  const out = [];
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const x0 = Math.floor((bx * img.width) / cols), x1 = Math.floor(((bx + 1) * img.width) / cols);
      const y0 = Math.floor((by * img.height) / rows), y1 = Math.floor(((by + 1) * img.height) / rows);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * 3; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
      out.push(srgbToLab(r / n, g / n, b / n));
    }
  }
  return out;
}

export function seamDeltaE(before, after) {
  const a = blockColors(before), b = blockColors(after);
  return round(median(a.map((lab, i) => deltaE00(lab, b[i]))));
}

/** 确定性 k-means（按亮度排序后等距取初值），返回色心与占比。 */
export function kmeansLab(samples, k = 6, iterations = 12) {
  if (samples.length < k) return samples.map(s => ({ lab: s, share: 1 / samples.length }));
  const sorted = [...samples].sort((p, q) => p[0] - q[0]);
  let centers = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) * sorted.length) / k)]);
  let assign = new Array(samples.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    assign = samples.map(s => { let best = 0, bd = Infinity; centers.forEach((c, j) => { const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2; if (d < bd) { bd = d; best = j; } }); return best; });
    centers = centers.map((c, j) => {
      const m = samples.filter((_, i) => assign[i] === j);
      return m.length ? [0, 1, 2].map(ch => m.reduce((s, p) => s + p[ch], 0) / m.length) : c;
    });
  }
  return centers.map((lab, j) => ({ lab: lab.map(v => round(v, 2)), share: round(assign.filter(a => a === j).length / samples.length, 3) }));
}

export function labSamples(img, step = 4) {
  const out = [];
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) { const i = (y * img.width + x) * 3; out.push(srgbToLab(img.data[i], img.data[i + 1], img.data[i + 2])); }
  return out;
}

export function paletteDeltaE(filmImages, baseImages) {
  const fp = kmeansLab(filmImages.flatMap(img => labSamples(img)));
  const bp = kmeansLab(baseImages.flatMap(img => labSamples(img)));
  return { median: round(median(fp.map(c => Math.min(...bp.map(b => deltaE00(c.lab, b.lab)))))), film: fp, baseline: bp };
}

const luma = (img, i) => {
  const [L] = srgbToLab(img.data[i], img.data[i + 1], img.data[i + 2]);
  return L;
};

export function lineCoverage(img) {
  const { width: w, height: h } = img;
  const L = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) L[p] = luma(img, p * 3);
  let hits = 0, n = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      let max = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) max = Math.max(max, L[(y + dy) * w + x + dx]);
      const v = L[y * w + x];
      if (max - v > 25 && v < 45) hits++;
      n++;
    }
  }
  return round(n ? hits / n : 0, 4);
}

export function grainEnergy(img, size = 256) {
  const { width: w, height: h } = img;
  const s = Math.min(size, w - 2, h - 2);
  const x0 = Math.floor((w - s) / 2), y0 = Math.floor((h - s) / 2);
  let sum = 0, n = 0;
  const Y = (x, y) => { const i = (y * w + x) * 3; return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]; };
  for (let y = y0 + 1; y < y0 + s - 1; y++) {
    for (let x = x0 + 1; x < x0 + s - 1; x++) { sum += Math.abs(4 * Y(x, y) - Y(x - 1, y) - Y(x + 1, y) - Y(x, y - 1) - Y(x, y + 1)); n++; }
  }
  return round(n ? sum / n : 0, 3);
}

export { median, round };
