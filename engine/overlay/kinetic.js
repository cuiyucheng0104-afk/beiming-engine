// 北冥引擎 · 文字动效：片名、标题、歌词式大字的入场 / 出场，逐字或逐碎片，全部是进度的纯函数，Canvas 2D 画。
// 输入的 glyphs 是排字结果 [{ ch, x, y, w, line, index }]（x 左缘、y 基线，像素）；本模块只消费它，不 import 排字模块。
//   EFFECTS                     名字 → { title: '中文名', per: 'glyph' | 'piece', stagger: 默认错峰, order: 默认次序 }，共 12 个
//   glyphState(name, { i, n, p, seed = 1, phase = 'in' })
//                               → { dx, dy, rot, sx, sy, alpha, blur, ... }，纯函数（无内部状态，可在 Node 里测）。
//                                 p 是这个字（碎片类是这块碎片）自己的局部进度 0..1，phase = 'in' | 'out'；
//                                 出场直接复用入场：phase 'out' 时按 1 - p 取入场状态（p = 0 静止，p = 1 完全离场）。
//                                 dx / dy 单位 em（乘字号得像素），rot 弧度；p = 1（出场 p = 0）回到静止：0 0 0 1 1 alpha 1。
//                                 附加字段：rnd（乱码解析，0..1，用来在这段字自己的字里挑一个；settled 为真时画本字）、glow（霓虹）、reveal（墨洇、擦出，0..1）
//   progressOf({ i, n, p, stagger = 0.5, order = 'forward', seed = 1 })
//                               → 这个字的局部进度：整体进度 p 按错峰与次序分给每个字。次序 forward 顺序 | reverse 倒序 |
//                                 center 中心向外 | random 随机（由 seed 与下标推导）。p = 1 时所有字都到 1
//   quantizeP({ p, dur = 1, hold, fps })  一拍二：把整体进度量化成每 hold 帧一张（用 clock.heldAt）；不传 hold 就是连续运动
//   labelComponents(alpha, W, H, thr = 0) → { labels: Int32Array（0 = 背景，1..count），count }  8 连通域标记（纯函数，可在 Node 里测）
//   splitPieces(ch, font, size) → [{ x, y, w, h, canvas }]   把字栅格化后按连通域拆碎片；x y 是碎片左上角相对「字中心 / 基线」的像素偏移，
//                                 canvas 只有 alpha（黑）；有缓存，键含字、字体、字号（仅浏览器）
//   drawKinetic(ctx, glyphs, { effect, p, phase = 'in', font, size, color, seed = 1, stagger, order, overlay, id,
//                              hold, fps, dur, blur = true })
//                               浏览器里画一帧；给了 overlay（engine/overlay/text.js 的 O）就用 O.rec 记整段文字静止排版的方框，
//                               O.draw 为 false（只量不画）时只记框；blur: false 关掉 ctx.filter（无头软件渲染下 filter 很慢）
// 做法参考 JIZURA（MIT）的 src/11p_enter*.js 里的入场部件分类；代码为本仓库原创，墨洇用 engine/overlay/brush.js 的倒角距离变换做显影。
// 确定性：随机一律由 mulberry / hashi（种子，下标）推导，没有内部状态。

import { clamp, ss, seg, eo, TAU, hashi } from '../core/math.js';
import { heldAt } from '../core/clock.js';
import { chamfer } from './brush.js';

export const EFFECTS = Object.freeze({
  bounce:        { title: '回弹落位', per: 'glyph', stagger: 0.5, order: 'forward' },
  typewriter:    { title: '打字机',   per: 'glyph', stagger: 0.9, order: 'forward' },
  tracking:      { title: '字距收拢', per: 'glyph', stagger: 0,   order: 'forward' },
  flip:          { title: '翻牌',     per: 'glyph', stagger: 0.6, order: 'forward' },
  scramble:      { title: '乱码解析', per: 'glyph', stagger: 0.5, order: 'forward' },
  neon:          { title: '霓虹点亮', per: 'glyph', stagger: 0.6, order: 'random' },
  inkBleed:      { title: '墨洇显影', per: 'glyph', stagger: 0.5, order: 'forward' },
  wave:          { title: '大小波浪', per: 'glyph', stagger: 0.5, order: 'forward' },
  blurFocus:     { title: '模糊对焦', per: 'glyph', stagger: 0.5, order: 'forward' },
  maskWipe:      { title: '遮罩擦出', per: 'glyph', stagger: 0.8, order: 'forward' },
  pieceAssemble: { title: '碎片聚合', per: 'piece', stagger: 0.3, order: 'center' },
  pieceReveal:   { title: '碎片依次显现', per: 'piece', stagger: 0.5, order: 'forward' },
});

const rnd = (seed, i, k) => hashi(Math.imul(seed | 0, 7919) + Math.imul(i, 131) + k * 17 + 1);
const bounceOut = t => {
  t = clamp(t);
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75; }
  if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375; }
  t -= 2.625 / 2.75; return 7.5625 * t * t + 0.984375;
};

// 每个动效：(q, { i, n, seed }) → 偏离静止的部分字段；q 是入场进度（0 起始，1 静止）
const FX = {
  bounce: q => ({ dy: -1.3 * (1 - bounceOut(q)), alpha: clamp(q * 10) }),
  typewriter: q => ({ alpha: q > 0 ? 1 : 0 }),
  tracking: (q, { i, n }) => ({ dx: (i - (n - 1) / 2) * 0.6 * (1 - eo(q)), alpha: ss(seg(q, 0, 0.5)), blur: 0.08 * (1 - q) }),
  flip: q => ({ sy: Math.cos((1 - eo(q)) * Math.PI / 2), alpha: q > 0 ? 1 : 0 }),
  scramble: (q, { i, seed }) => {
    const settled = q >= 0.75;
    return { alpha: q > 0 ? 1 : 0, settled, rnd: settled ? 0 : rnd(seed, i, Math.floor(q * 14)) };
  },
  neon: (q, { i, seed }) => {
    const on = q >= 0.8 ? 1 : rnd(seed, i, Math.floor(q * 16)) > 0.4 ? 1 : 0.15;
    const a = q > 0 ? on : 0;
    return { alpha: a, glow: a };
  },
  inkBleed: q => ({ reveal: q, alpha: ss(seg(q, 0, 0.1)), blur: 0.06 * (1 - q) }),
  wave: (q, { i }) => {
    const w = (1 - q) * Math.sin(q * 9 + i * 0.9), s = 1 + 0.6 * w;
    return { sx: s, sy: s, dy: -0.25 * w, alpha: ss(seg(q, 0, 0.2)) };
  },
  blurFocus: q => ({ blur: 0.3 * (1 - eo(q)), sx: 1 + 0.15 * (1 - q), sy: 1 + 0.15 * (1 - q), alpha: ss(seg(q, 0, 0.6)) }),
  maskWipe: q => ({ reveal: q, alpha: q > 0 ? 1 : 0 }),
  pieceAssemble: (q, { i, seed }) => {
    const a = rnd(seed, i, 1) * TAU, r = 0.9 + rnd(seed, i, 2), pos = 1 - eo(q);
    return { dx: Math.cos(a) * r * pos, dy: Math.sin(a) * r * pos, rot: (rnd(seed, i, 3) - 0.5) * 4 * pos, sx: 1 - 0.5 * pos, sy: 1 - 0.5 * pos, alpha: seg(q, 0, 0.3) };
  },
  pieceReveal: q => {
    const pos = 1 - eo(q), s = 0.4 + 0.6 * eo(q);
    return { dy: -0.35 * pos, sx: s, sy: s, alpha: seg(q, 0, 0.25) };
  },
};

export function glyphState(name, { i = 0, n = 1, p, seed = 1, phase = 'in' }) {
  const f = FX[name];
  if (!f) throw new Error(`glyphState：不认识的动效“${name}”，可用：${Object.keys(EFFECTS).join(' ')}`);
  const q = clamp(phase === 'out' ? 1 - p : p);
  const r = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, alpha: 1, blur: 0, ...f(q, { i, n, seed }) };
  for (const k in r) if (typeof r[k] === 'number') r[k] += 0;   // -0 归一成 0，逐位比较才稳
  return r;
}

export function progressOf({ i, n, p, stagger = 0.5, order = 'forward', seed = 1 }) {
  const s = clamp(stagger, 0, 0.95), c = (n - 1) / 2;
  let pos = 0;
  if (n > 1) {
    if (order === 'reverse') pos = (n - 1 - i) / (n - 1);
    else if (order === 'center') pos = Math.abs(i - c) / c;
    else if (order === 'random') pos = rnd(seed, i, 5);
    else pos = i / (n - 1);
  }
  return clamp((p - pos * s) / (1 - s));
}

export function quantizeP({ p, dur = 1, hold, fps }) {
  if (!hold || p <= 0 || p >= 1) return clamp(p);
  return clamp(heldAt(p * dur, hold, fps) / dur);
}

export function labelComponents(alpha, W, H, thr = 0) {
  const labels = new Int32Array(W * H), stack = [];
  let count = 0;
  for (let s = 0; s < W * H; s++) {
    if (labels[s] || alpha[s] <= thr) continue;
    labels[s] = ++count; stack.push(s);
    while (stack.length) {
      const k = stack.pop(), x = k % W, y = (k / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const m = ny * W + nx;
        if (!labels[m] && alpha[m] > thr) { labels[m] = count; stack.push(m); }
      }
    }
  }
  return { labels, count };
}

// ---- 以下仅浏览器 ----
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };
const rasterize = (ch, font, size) => {
  const W = Math.ceil(size * 1.6), H = Math.ceil(size * 1.6), ox = W / 2, oy = Math.round(size * 1.15);
  const cv = mkCanvas(W, H), c = cv.getContext('2d', { willReadFrequently: true });
  c.font = font; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.fillStyle = '#000'; c.fillText(ch, ox, oy);
  return { cv, c, W, H, ox, oy, data: c.getImageData(0, 0, W, H).data };
};

const pieceCache = new Map();
export function splitPieces(ch, font, size) {
  const key = `${ch}|${font}|${size}`;
  let hit = pieceCache.get(key); if (hit) return hit;
  const { W, H, ox, oy, data } = rasterize(ch, font, size);
  const alpha = new Uint8Array(W * H); for (let k = 0; k < alpha.length; k++) alpha[k] = data[k * 4 + 3];
  const { labels, count } = labelComponents(alpha, W, H);
  const box = Array.from({ length: count }, () => [W, H, -1, -1]);
  for (let k = 0; k < labels.length; k++) if (labels[k]) { const b = box[labels[k] - 1], x = k % W, y = (k / W) | 0; b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  hit = box.map(([x0, y0, x1, y1], li) => {
    const w = x1 - x0 + 1, h = y1 - y0 + 1, canvas = mkCanvas(w, h), c = canvas.getContext('2d'), im = c.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y0 + y) * W + x0 + x; if (labels[k] === li + 1) im.data[(y * w + x) * 4 + 3] = alpha[k]; }
    c.putImageData(im, 0, 0);
    return { x: x0 - ox, y: y0 - oy, w, h, canvas };
  }).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);   // 自上而下，逐碎片显现有个次序
  pieceCache.set(key, hit);
  return hit;
}

const tintCache = new WeakMap();
const tinted = (pieces, color) => {
  let m = tintCache.get(pieces); if (!m) tintCache.set(pieces, m = new Map());
  let t = m.get(color); if (t) return t;
  t = pieces.map(pc => {
    const cv = mkCanvas(pc.w, pc.h), c = cv.getContext('2d');
    c.fillStyle = color; c.fillRect(0, 0, pc.w, pc.h); c.globalCompositeOperation = 'destination-in'; c.drawImage(pc.canvas, 0, 0);
    return cv;
  });
  m.set(color, t); return t;
};

// 墨洇：字形内每个像素到边缘的距离归一化（笔画中心 1，边缘 0）；显影时从笔画中心向外洇开
const inkCache = new Map();
const inkField = (ch, font, size) => {
  const key = `${ch}|${font}|${size}`;
  let e = inkCache.get(key); if (e) return e;
  const { W, H, ox, oy, data } = rasterize(ch, font, size);
  const inside = new Uint8Array(W * H); for (let k = 0; k < inside.length; k++) inside[k] = data[k * 4 + 3] > 127 ? 1 : 0;
  const d = chamfer(inside, W, H); let mx = 1; for (const v of d) mx = Math.max(mx, v);
  const norm = new Float32Array(W * H); for (let k = 0; k < norm.length; k++) norm[k] = inside[k] ? Math.min(1, d[k] / (mx * 0.6)) : 0;
  e = { W, H, ox, oy, norm, data, mask: mkCanvas(W, H), tmp: mkCanvas(W, H) };
  inkCache.set(key, e); return e;
};
const drawInk = (ctx, ch, font, size, color, reveal, alpha) => {
  const e = inkField(ch, font, size), mc = e.mask.getContext('2d'), im = mc.createImageData(e.W, e.H), r = reveal * 1.15;
  for (let k = 0; k < e.norm.length; k++) {
    const a = e.data[k * 4 + 3]; if (!a) continue;
    im.data[k * 4 + 3] = a * clamp((r - (1 - e.norm[k])) / 0.15);
  }
  mc.putImageData(im, 0, 0);
  const tc = e.tmp.getContext('2d'); tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, e.W, e.H);
  tc.fillStyle = color; tc.fillRect(0, 0, e.W, e.H); tc.globalCompositeOperation = 'destination-in'; tc.drawImage(e.mask, 0, 0);
  ctx.globalAlpha *= alpha; ctx.drawImage(e.tmp, -e.ox, -e.oy);
};

export function drawKinetic(ctx, glyphs, { effect, p, phase = 'in', font, size, color = '#fff', seed = 1, stagger, order, overlay, id = 'kinetic', hold, fps, dur, blur = true }) {
  const fx = EFFECTS[effect]; if (!fx) throw new Error(`drawKinetic：不认识的动效“${effect}”`);
  const pp = quantizeP({ p, dur, hold, fps }), st = stagger ?? fx.stagger, od = order ?? fx.order, n = glyphs.length;
  let maxA = 0;
  const draw = !overlay || overlay.draw !== false;
  const pool = [...new Set(glyphs.map(g => g.ch).filter(c => /\S/.test(c)))];   // 乱码只在这段字自己的字里换：一定在作品的字体子集里，不会掉到系统字体
  glyphs.forEach((g, i) => {
    const pi = progressOf({ i, n, p: pp, stagger: st, order: od, seed });
    const s = glyphState(effect, { i, n, p: pi, seed, phase });
    maxA = Math.max(maxA, s.alpha);
    if (!draw || s.alpha <= 0.003 || /^\s*$/.test(g.ch)) return;
    ctx.save();
    ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = color;
    const cx = g.x + g.w / 2;
    if (fx.per === 'piece') {
      const pcs = splitPieces(g.ch, font, size), tint = tinted(pcs, color);
      pcs.forEach((pc, k) => {
        const ps = glyphState(effect, { i: k, n: pcs.length, p: progressOf({ i: k, n: pcs.length, p: pi, stagger: 0.5, order: effect === 'pieceReveal' ? 'forward' : 'random', seed: seed + i }), seed: seed + i, phase });
        if (ps.alpha <= 0.003) return;
        ctx.save();
        ctx.globalAlpha = ps.alpha;
        ctx.translate(cx + pc.x + pc.w / 2 + ps.dx * size, g.y + pc.y + pc.h / 2 + ps.dy * size);
        ctx.rotate(ps.rot); ctx.scale(ps.sx, ps.sy);
        ctx.drawImage(tint[k], -pc.w / 2, -pc.h / 2);
        ctx.restore();
      });
    } else {
      ctx.globalAlpha = s.alpha;
      ctx.translate(cx + s.dx * size, g.y - 0.35 * size + s.dy * size);
      ctx.rotate(s.rot); ctx.scale(s.sx, s.sy); ctx.translate(0, 0.35 * size);
      if (blur && s.blur > 0.004) ctx.filter = `blur(${(s.blur * size).toFixed(2)}px)`;
      if (s.glow) { ctx.shadowColor = color; ctx.shadowBlur = 0.25 * size * s.glow; }
      if (s.reveal !== undefined && effect === 'maskWipe') { ctx.beginPath(); ctx.rect(-g.w / 2 - 2, -size, (g.w + 4) * s.reveal, size * 1.4); ctx.clip(); }
      if (effect === 'inkBleed') drawInk(ctx, g.ch, font, size, color, s.reveal, 1);
      else ctx.fillText(effect === 'scramble' && !s.settled ? pool[Math.floor(s.rnd * pool.length)] : g.ch, 0, 0);
    }
    ctx.restore();
  });
  if (overlay && n) {
    const x0 = Math.min(...glyphs.map(g => g.x)), x1 = Math.max(...glyphs.map(g => g.x + g.w)), ys = glyphs.map(g => g.y);
    overlay.rec(id, glyphs.map(g => g.ch).join(''), x0, Math.min(...ys) - size * 0.9, x1, Math.max(...ys) + size * 0.2, maxA, font);   // 多行时框住所有行
  }
}
