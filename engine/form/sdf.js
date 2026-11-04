// 北冥引擎 · 距离场：把画布上画的蒙版变成有符号距离（纹样凹凸、离缘距离都从它来）。
// 距离变换用 Felzenszwalb & Huttenlocher 的线性时间算法（平方欧氏，先列后行）。
//   edt2d(grid, w, h)                       原地：grid 里 0 = 目标、极大 = 背景 → 到最近目标的平方距离
//   sdfFromImage(img, W, H, ch, K, R, crop) RGBA 像素的第 ch 通道（抗锯齿边当亚像素用）→ Float32 有符号距离
//       单位 = 像素 / K（K 是每单位的像素数）；外正内负，截到 ±R；crop = true 时只在有内容的包围盒（外扩 R）里算
//   blur5(a, W, H)                          原地 1-4-6-4-1 可分离模糊（抹掉覆盖率在等值线上留下的亚像素梳齿）
//   shapeInside(shape, K, pad, R)           THREE.Shape 栅格化 → 形内到边缘的距离（形外为 0）
//       → { de: Float32Array, W, H, x0, y0 }：像素 (x, y) 中心在形状坐标 (x0 + (x + 0.5) / K, y0 + (y + 0.5) / K)
import { clamp } from '../core/math.js';

const INF = 1e20;

function edt1d(f, d, v, z, n) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const r = v[k]; d[q] = (q - r) * (q - r) + f[r]; }
}

export function edt2d(grid, w, h) {
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = grid[y * w + x]; edt1d(f, d, v, z, h); for (let y = 0; y < h; y++) grid[y * w + x] = d[y]; }
  for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) f[x] = grid[o + x]; edt1d(f, d, v, z, w); for (let x = 0; x < w; x++) grid[o + x] = d[x]; }
}

export function sdfFromImage(img, W, H, ch, K, Rr, cropToContent = false) {
  const out = new Float32Array(W * H).fill(Rr);
  let x0 = 0, y0 = 0, x1 = W, y1 = H;
  if (cropToContent) {
    x0 = W; y0 = H; x1 = 0; y1 = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (img[(y * W + x) * 4 + ch] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < x0) return out;
    const pad = Math.ceil(Rr * K) + 2;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W, x1 + pad + 1); y1 = Math.min(H, y1 + pad + 1);
  }
  const w = x1 - x0, h = y1 - y0, go = new Float32Array(w * h), gi = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = img[((y + y0) * W + x + x0) * 4 + ch] / 255, i = y * w + x;
    if (a >= 0.999) { go[i] = 0; gi[i] = INF; } else if (a <= 0.001) { go[i] = INF; gi[i] = 0; }
    else { go[i] = Math.max(0, 0.5 - a) ** 2; gi[i] = Math.max(0, a - 0.5) ** 2; }
  }
  edt2d(go, w, h); edt2d(gi, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; out[(y + y0) * W + x + x0] = clamp((Math.sqrt(go[i]) - Math.sqrt(gi[i])) / K, -Rr, Rr); }
  return out;
}

export function blur5(a, W, H) {
  const t = new Float32Array(a.length);
  for (let y = 0; y < H; y++) { const o = y * W; for (let x = 0; x < W; x++) { const xm2 = Math.max(0, x - 2), xm1 = Math.max(0, x - 1), xp1 = Math.min(W - 1, x + 1), xp2 = Math.min(W - 1, x + 2); t[o + x] = (a[o + xm2] + 4 * a[o + xm1] + 6 * a[o + x] + 4 * a[o + xp1] + a[o + xp2]) / 16; } }
  for (let y = 0; y < H; y++) { const ym2 = Math.max(0, y - 2) * W, ym1 = Math.max(0, y - 1) * W, yp1 = Math.min(H - 1, y + 1) * W, yp2 = Math.min(H - 1, y + 2) * W, o = y * W; for (let x = 0; x < W; x++) a[o + x] = (t[ym2 + x] + 4 * t[ym1 + x] + 6 * t[o + x] + 4 * t[yp1 + x] + t[yp2 + x]) / 16; }
  return a;
}

export function shapeInside(shape, K, pad, Rr) {
  const pts = shape.getPoints(48);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const W = Math.ceil((x1 - x0) * K), H = Math.ceil((y1 - y0) * K);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.setTransform(K, 0, 0, K, -x0 * K, -y0 * K);
  g.fillStyle = '#fff'; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.fill();
  const d = sdfFromImage(g.getImageData(0, 0, W, H).data, W, H, 0, K, Rr);
  const de = new Float32Array(W * H);
  for (let i = 0; i < de.length; i++) de[i] = Math.max(0, -d[i]);
  return { de, W, H, x0, y0, cv };
}
