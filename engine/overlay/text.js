// 北冥引擎 · 显示层的字与线：字体加载、量字、带暗晕与辉光的字和描线、半透明卡片，以及文字方框记录（给 window.TEXTS 查字）。
// 同一套布局代码可以"画"也可以"只量不画"：O.collect(fn) 期间所有画法函数直接返回，只有 O.rec 记下方框。
//   loadFonts([[family, url, weight], ...])   全部加载并加入 document.fonts（返回 Promise）。字体先登记进 document.fonts 再开始下载，
//                                             所以下载期间 document.fonts.check(该字体) 是 false，调用方能据此等它就绪；
//                                             url 按 CSS 字符串写进 src，含括号、引号、空格的路径也能用
//   fontSpec(weight, px, families)            → CSS font 串，例如 '400 25.00px "A", "B", sans-serif'
//   rgba([r, g, b], a)                        → CSS 颜色串（a 夹到 0..1）
//   measure(str, font, ls = 0)                → { w, asc, desc }：左对齐、字母基线，ls 是字距（像素）
//   measureContext()                          量字用的离屏 2D 上下文（不改调用方 ctx 的状态）
//   createOverlay(theme) → O                  theme = { ink, glow, halo, fill }（RGB 数组），可随时换 O.theme
//     O.draw                                  false = 只量不画
//     O.glowText(ctx, str, x, y, font, rgb, a, S, { ls, glow, halo })
//                                             先画一层模糊暗晕托底（halo，亮背景上也看得清），再画带细辉光（glow）的字；S = 画面高 / 1040
//     O.glowStroke(ctx, path, rgb, a, lineWidth, S, glow)   path = ctx => void，圆头圆角的辉光描线
//     O.card(ctx, x, y, w, h, r, a, S)        半透明暗底 + 细辉光描边的圆角卡片
//     O.rec(id, text, x0, y0, x1, y1, a)      记一个文字方框（a > 0.02 才算看得见）
//     O.collect(fn)                           以"只量不画"跑 fn，返回期间记下的方框 [{ id, text, x0, y0, x1, y1 }]

import { clamp } from '../core/math.js';
import { roundRect } from './widgets.js';

const cssString = v => `"${String(v).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ')}"`;

export async function loadFonts(list) {
  await Promise.all(list.map(async ([fam, url, weight]) => {
    const f = new FontFace(fam, `url(${cssString(url)})`, { weight, display: 'block' });
    document.fonts.add(f);
    try { await f.load(); } catch (e) { document.fonts.delete(f); throw new Error(`字体加载失败：${fam}（${url}）：${e && e.message || e}`); }
  }));
  await document.fonts.ready;
}

export const fontSpec = (wt, px, families) => `${wt} ${px.toFixed(2)}px ${families.map(f => `"${f}"`).join(', ')}, sans-serif`;
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a).toFixed(4)})`;

let mc = null;
export const measureContext = () => (mc ??= document.createElement('canvas').getContext('2d'));
export function measure(str, f, ls = 0) {
  const ctx = measureContext();
  ctx.font = f; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; if ('letterSpacing' in ctx) ctx.letterSpacing = `${ls}px`;
  const m = ctx.measureText(str);
  return { w: m.width, asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent };
}

export function createOverlay(theme) {
  const O = { theme, draw: true, out: null };
  O.glowText = (ctx, str, x, y, f, col, a, S, { ls = 0, glow = 0.55, halo = 0.3 } = {}) => {
    if (!O.draw || a <= 0.003) return;
    const th = O.theme;
    ctx.save();
    ctx.font = f; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; if ('letterSpacing' in ctx) ctx.letterSpacing = `${ls}px`;
    if (halo > 0) { ctx.filter = `blur(${(4.5 * S).toFixed(2)}px)`; ctx.fillStyle = rgba(th.halo, halo * a); ctx.fillText(str, x, y + 1 * S); ctx.filter = 'none'; }
    ctx.shadowColor = rgba(th.glow, glow * a); ctx.shadowBlur = 7 * S;
    ctx.fillStyle = rgba(col, a); ctx.fillText(str, x, y);
    ctx.restore();
  };
  O.glowStroke = (ctx, path, col, a, lw, S, glow = 0.6) => {
    if (!O.draw || a <= 0.003) return;
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lw;
    ctx.shadowColor = rgba(O.theme.glow, glow * a); ctx.shadowBlur = 8 * S;
    ctx.strokeStyle = rgba(col, a); ctx.beginPath(); path(ctx); ctx.stroke();
    ctx.restore();
  };
  O.card = (ctx, x, y, w, h, r, a, S) => {
    if (!O.draw || a <= 0.003) return;
    ctx.save();
    ctx.fillStyle = rgba(O.theme.fill, 0.36 * a); ctx.beginPath(); roundRect(ctx, x, y, w, h, r); ctx.fill();
    ctx.restore();
    O.glowStroke(ctx, c => roundRect(c, x, y, w, h, r), O.theme.ink, 0.78 * a, 1.6 * S, S, 0.45);
  };
  O.rec = (id, text, x0, y0, x1, y1, a) => {
    if (O.out && a > 0.02) O.out.push({ id, text, x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) });
  };
  O.collect = fn => {
    const out = []; O.draw = false; O.out = out;
    try { fn(); } finally { O.draw = true; O.out = null; }
    return out;
  };
  return O;
}
