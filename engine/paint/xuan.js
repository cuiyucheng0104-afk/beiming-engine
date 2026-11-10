// 北冥引擎 · 宣纸（Canvas 2D）：纤维、云絮（纸浆聚散造成的厚薄不均）、帘纹（竹帘的细密横纹与稀疏竖纹）、
// 草屑杂点与纸面细颗粒。不是一层低频色斑——宣纸的质感主要来自细长的纤维和迎光可见的絮。
// 一次生成、调用方自己缓存；同一个种子永远生成同一张纸。tile = true（默认）时四边无缝，可以平铺、可以当后期纸纹。
//
//   xuanPaper(o) → canvas      o：
//     width 1024, height 1024  纸面像素
//     seed 1                   种子
//     tone [242, 235, 219]     纸色（生宣偏暖的米白；熟宣可以更白、絮更弱）
//     scale 1                  纹理尺度：1 = 按 1080 高的画面标定（纤维长、帘纹间距都乘它）；4K 写 2，纸相对画面一样粗细
//     fiber 1                  纤维多少（0 = 不画）；fiberLen [16, 110]：纤维长度范围（像素，乘 scale）
//     floc 1                   云絮的强弱            laid 0.35   帘纹的强弱（0 = 不画）
//     specks 1                 草屑杂点的多少        tooth 1     细颗粒的强弱
//     tile true                四边无缝（纤维越边从对边绕回，絮与帘纹按周期取）
//   xuanFibers(o) → [{ x, y, a, len, bend, w, light, alpha }]   纤维清单（纯函数，Node 可测；xuanPaper 按它画）
//   xuanField(o) → (x, y) => 亮度倍率   絮 + 帘纹 + 细颗粒合起来的逐像素亮度场（纯函数，Node 可测）
// 尺度参考（1080 高）：纤维 16–110 像素长、0.4–1.4 像素宽、约 3700 根，六成略亮于纸面（透光）、其余略暗（树皮纤维），少数成束；
// 云絮的斑块 20–200 像素；帘纹横纹约 7 像素一道、竖纹约 160 像素一道，对比都在 1–2% 之间，远看几乎看不见，近看才有。

import { mulberry, clamp, hashi, TAU } from '../core/math.js';

const DEF = { width: 1024, height: 1024, seed: 1, tone: [242, 235, 219], scale: 1, fiber: 1, fiberLen: [16, 110], floc: 1, laid: 0.35, specks: 1, tooth: 1, tile: true };
const opts = o => {
  const r = { ...DEF, ...o };
  if (!(Number.isInteger(r.width) && r.width > 0 && Number.isInteger(r.height) && r.height > 0)) throw new TypeError(`宣纸：width / height 要是正整数，收到 ${r.width} × ${r.height}`);
  if (!(r.scale > 0)) throw new TypeError(`宣纸：scale 要是正数，收到 ${r.scale}`);
  return r;
};

// 周期值噪声：格点按 (px, py) 取模，平铺无缝；五次插值
const hash3 = (i, j, s) => hashi(i * 73856093 ^ j * 19349663 ^ s * 83492791);
function pnoise(x, y, px, py, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const m = (a, p) => ((a % p) + p) % p;
  const i0 = m(i, px), i1 = m(i + 1, px), j0 = m(j, py), j1 = m(j + 1, py);
  const a = hash3(i0, j0, s), b = hash3(i1, j0, s), c = hash3(i0, j1, s), d = hash3(i1, j1, s);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;   // 0..1
}

export function xuanField(o = {}) {
  const P = opts(o), { width: W, height: H, scale: k, seed } = P;
  const fr = v => v - Math.floor(v);
  // 云絮：三层，斑块约 200 / 60 / 22 像素（乘 scale）。平铺时每层的格数取整到画面宽高（周期 = 宽高），否则不绕回
  const layer = (n, w, i) => {
    if (!P.tile) return { sx: 1 / (n * k), sy: 1 / (n * k), px: 1e9, py: 1e9, w, s: seed * 7 + i * 101 };
    const px = Math.max(1, Math.round(W / (n * k))), py = Math.max(1, Math.round(H / (n * k)));
    return { sx: px / W, sy: py / H, px, py, w, s: seed * 7 + i * 101 };
  };
  const L = [[200, 0.55], [60, 0.3], [22, 0.15]].map(([n, w], i) => layer(n, w, i));
  const G = layer(2.2, 1, 9), CH = layer(90, 1, 21);
  // 帘纹：横纹间距 ~7 像素、竖纹 ~160 像素（乘 scale）；平铺时取能整除宽高的间距。线宽 1.5–2 像素，高斯截面
  const pitch = (n, size) => (P.tile ? size / Math.max(1, Math.round(size / (n * k))) : n * k);
  const ly = pitch(7, H), lx = pitch(160, W), sy = 0.75 * k, sx = 1.1 * k;
  return (x, y) => {
    let f = 0;
    for (const l of L) f += l.w * pnoise(x * l.sx, y * l.sy, l.px, l.py, l.s);
    const floc = (f - 0.5) * 0.08 * P.floc;                                     // 约 ±2.5%
    let laid = 0;
    if (P.laid > 0) {
      const yy = y + 0.6 * k * Math.sin(TAU * x / W * Math.max(1, Math.round(W / (240 * k))));   // 横纹略带波动（平铺时波长整除宽）
      const dy = (fr(yy / ly + 0.5) - 0.5) * ly, dx = (fr(x / lx + 0.5) - 0.5) * lx;
      const chain = 0.3 + 0.7 * pnoise(x / W * CH.px, y * CH.sy, CH.px, CH.py, CH.s);   // 竖纹时隐时现
      laid = -P.laid * (0.035 * Math.exp(-(dy * dy) / (sy * sy)) + 0.05 * chain * Math.exp(-(dx * dx) / (sx * sx))) * (0.5 + f);
    }
    const xi = P.tile ? ((x | 0) % W + W) % W : x | 0, yi = P.tile ? ((y | 0) % H + H) % H : y | 0;
    const g1 = hashi((xi * 92821 + yi * 68917 + seed * 1013) | 0) - 0.5;          // 1 像素颗粒（平铺时按宽高取模）
    const g2 = pnoise(x * G.sx, y * G.sy, G.px, G.py, G.s) - 0.5;               // 2 像素左右的颗粒团
    return 1 + floc + laid + P.tooth * (g1 * 0.018 + g2 * 0.026);
  };
}

export function xuanFibers(o = {}) {
  const P = opts(o), { width: W, height: H, scale: k } = P;
  const R = mulberry((P.seed * 2654435761) | 0);
  const n = Math.round(P.fiber * W * H / (560 * k * k)), out = [];
  const [l0, l1] = P.fiberLen;
  const one = (x, y, a) => {
    const len = k * l0 * Math.pow(l1 / l0, R() * R());                         // 偏短的对数分布：短纤维多、长纤维少
    return { x, y, a, len, bend: (R() - 0.5) * 0.5 * len, w: k * (0.4 + Math.pow(R(), 2) * 1.0), light: R() < 0.62, alpha: 0.06 + Math.pow(R(), 1.4) * 0.2 };
  };
  while (out.length < n) {
    // 方向略偏水平（抄纸时纸浆顺帘流动）：拒绝采样 p(θ) ∝ 1 + 0.45·cos 2θ
    let a;
    do { a = R() * Math.PI; } while (R() * 1.45 > 1 + 0.45 * Math.cos(2 * a));
    const x = R() * W, y = R() * H;
    if (R() < 0.08) {                                                           // 一小束：3–6 根近乎平行的纤维
      const m = 3 + Math.floor(R() * 4);
      for (let j = 0; j < m && out.length < n; j++) out.push(one(x + (R() - 0.5) * 6 * k, y + (R() - 0.5) * 6 * k, a + (R() - 0.5) * 0.25));
    } else out.push(one(x, y, a));
  }
  return out;
}

// 平铺时，离边不到 ext 的东西还要在对边（与对角）再画一次：返回要画的偏移 [[0, 0], …]
function wrapOffsets(x, y, ext, tile, W, H) {
  const offs = [[0, 0]];
  if (!tile) return offs;
  const ox = x < ext ? [W] : x > W - ext ? [-W] : [], oy = y < ext ? [H] : y > H - ext ? [-H] : [];
  for (const a of ox) offs.push([a, 0]);
  for (const b of oy) offs.push([0, b]);
  for (const a of ox) for (const b of oy) offs.push([a, b]);
  return offs;
}

export function xuanPaper(o = {}) {
  const P = opts(o), { width: W, height: H, tone, scale: k } = P;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  // 1) 纸色 × 亮度场（絮、帘纹、颗粒），暖色在暗处略重一点
  const im = g.createImageData(W, H), d = im.data, field = xuanField(P);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = field(x + 0.5, y + 0.5), i = (y * W + x) * 4, warm = v < 1 ? (1 - v) * 0.35 : 0;
    d[i] = clamp(tone[0] * v, 0, 255); d[i + 1] = clamp(tone[1] * (v - warm * 0.02), 0, 255); d[i + 2] = clamp(tone[2] * (v - warm * 0.06), 0, 255); d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  // 2) 纤维：略亮的（透光）与略暗的（树皮），细长、微弯；平铺时越边的从对边再画一次
  if (P.fiber > 0) {
    const lightC = `rgb(255,254,250)`, darkC = `rgb(${tone.map(c => Math.round(c * 0.8)).join(',')})`;
    g.lineCap = 'round';
    for (const f of xuanFibers(P)) {
      const dx = Math.cos(f.a) * f.len / 2, dy = Math.sin(f.a) * f.len / 2, nx = -Math.sin(f.a) * f.bend, ny = Math.cos(f.a) * f.bend;
      g.strokeStyle = f.light ? lightC : darkC; g.globalAlpha = f.alpha; g.lineWidth = f.w;
      for (const [ox, oy] of wrapOffsets(f.x, f.y, f.len / 2 + Math.abs(f.bend) + 2, P.tile, W, H)) {
        g.beginPath(); g.moveTo(f.x - dx + ox, f.y - dy + oy);
        g.quadraticCurveTo(f.x + nx + ox, f.y + ny + oy, f.x + dx + ox, f.y + dy + oy); g.stroke();
      }
    }
    g.globalAlpha = 1;
  }
  // 3) 草屑杂点：少量深色小点与短渣；平铺时越边的和纤维一样从对边再画一次
  if (P.specks > 0) {
    const R = mulberry((P.seed * 40503 + 7) | 0), n = Math.round(P.specks * W * H / 60000);
    for (let i = 0; i < n; i++) {
      const x = R() * W, y = R() * H, r = k * (0.5 + R() * 1.1), long = R() < 0.2, a = R() * TAU;
      g.fillStyle = `rgba(${Math.round(tone[0] * 0.55)},${Math.round(tone[1] * 0.5)},${Math.round(tone[2] * 0.42)},${(0.12 + R() * 0.28).toFixed(3)})`;
      const rx = long ? r * (2.5 + R() * 3) : r, ry = long ? r * 0.45 : r * (0.6 + R() * 0.4);
      for (const [ox, oy] of wrapOffsets(x, y, Math.max(rx, ry) + 2, P.tile, W, H)) {
        g.beginPath(); g.ellipse(x + ox, y + oy, rx, ry, a, 0, TAU); g.fill();
      }
    }
  }
  return cv;
}
