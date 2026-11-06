// ui.js — 窗口（三层圆角边 + 蓝色 Bayer 底）、顶部消息、指令菜单 + 手形光标、状态窗、对话框、EXP 条
import { W, C, sprFromRows } from './px.js';
import { text, textW, CS } from './font.js';

export function win(fb, x, y, w, h) {
  x = Math.round(x); y = Math.round(y);
  fb.rect(x + 2, y, w - 4, h, C.ink); fb.rect(x, y + 2, w, h - 4, C.ink); fb.rect(x + 1, y + 1, w - 2, h - 2, C.ink);
  fb.rect(x + 2, y + 1, w - 4, h - 2, C.white); fb.rect(x + 1, y + 2, w - 2, h - 4, C.white);
  fb.rect(x + 2, y + 2, w - 4, h - 4, C.silver);
  fb.gradV(x + 3, y + 3, w - 6, h - 6, [C.blue, C.navy, C.navy, C.night]);
  fb.hline(x + 3, x + w - 4, y + 3, C.blue);
}
const HAND = sprFromRows([
  '..kk.......',
  '.kwwk......',
  '.kwwwkkkkk.',
  'kswwwwwwwwk',
  'kswwwkkkkk.',
  'kswwwwk....',
  '.kssssk....',
  '..kkkk.....',
], { k: C.ink, w: C.white, s: C.silver });
export function hand(fb, x, y, bobOn, t) { fb.blit(HAND, x + (bobOn && Math.floor(t * 4) % 2 ? 1 : 0), y); }

// 顶部消息窗：n = 已打出的可见字数（空格不计）
export function topMsg(fb, s, n, dy = 0) {
  const w = Math.max(120, textW(s) + 28), x = Math.round((W - w) / 2), y = 4 + dy, h = CS + 10;
  win(fb, x, y, w, h);
  text(fb, visible(s, n), x + Math.round((w - textW(s)) / 2), y + 5, C.white, C.night);
  return { x0: x + Math.round((w - textW(s)) / 2), y0: y + 5, x1: x + Math.round((w - textW(s)) / 2) + textW(s), y1: y + 5 + CS };
}
export function visible(s, n) { let k = 0, o = ''; for (const ch of s) { if (ch !== ' ') { if (k >= n) break; k++; } o += ch; } return o; }
export const nVis = s => [...s].filter(ch => ch !== ' ').length;

// 指令菜单 2×2
export const MENU = { x: 6, y: 134, w: 116, h: 42, items: ['攻击', '魔法', '对话', '逃跑'] };
export function itemPos(i, dy = 0) { return [MENU.x + 22 + (i % 2) * 48, MENU.y + 6 + Math.floor(i / 2) * 16 + dy]; }
export function menu(fb, dy, sel, cur, bob, t, flash = false) {
  win(fb, MENU.x, MENU.y + dy, MENU.w, MENU.h);
  MENU.items.forEach((s, i) => {
    const [x, y] = itemPos(i, dy);
    const col = i === sel ? (flash ? C.white : C.yellow) : C.white;
    text(fb, s, x, y, col, C.night);
  });
  if (cur != null) { const [x, y] = itemPos(cur, dy); hand(fb, x - 14, y + 3, bob, t); }
}
// 战斗状态窗
export function statusBattle(fb, dy) {
  const x = 126, y = 134 + dy, w = 188, h = 42;
  win(fb, x, y, w, h);
  text(fb, '勇者', x + 10, y + 6, C.white, C.night);
  text(fb, 'Lv 1', x + 50, y + 6, C.silver, C.night);
  text(fb, 'HP', x + 10, y + 23, C.silver, C.night); text(fb, '32/32', x + 30, y + 23, C.white, C.night);
  bar(fb, x + 64, y + 26, 100, 1, C.lime, C.green);
}
export function bar(fb, x, y, w, f, c1, c2) {
  fb.rect(x - 1, y - 1, w + 2, 7, C.ink); fb.rect(x, y, w, 5, C.night);
  const fw = Math.round(w * f); fb.rect(x, y, fw, 2, c1); fb.rect(x, y + 2, fw, 3, c2);
}
// 升级状态窗（EXP）
export function statusExp(fb, dy, lv, f, flash, extra) {
  const x = 6, y = 134 + dy, w = 308, h = 42;
  win(fb, x, y, w, h);
  text(fb, '勇者', x + 12, y + 6, C.white, C.night);
  text(fb, 'Lv ' + lv, x + 52, y + 6, lv > 1 ? C.yellow : C.silver, C.night);
  text(fb, 'EXP', x + 12, y + 24, C.silver, C.night);
  bar(fb, x + 40, y + 26, 150, f, flash ? C.white : C.yellow, flash ? C.white : C.amber);
  if (extra) text(fb, extra, x + 210, y + 6, C.g1, C.night);
}
// 对话框：头像 + 文本（n = 已打出的可见字数）
export function dialog(fb, dy, portrait, s, n, arrow, t) {
  const x = 6, y = 132 + dy, w = 308, h = 44;
  win(fb, x, y, w, h);
  const px = x + 6, py = y + 6;
  fb.rect(px - 1, py - 1, 34, 34, C.ink); fb.gradV(px, py, 32, 32, [C.navy, C.night]);
  fb.blit(portrait, px, py);
  text(fb, '宝箱怪', px + 40, y + 5, C.g1, C.night);
  text(fb, visible(s, n), px + 40, y + 24, C.white, C.night);
  if (arrow && Math.floor(t * 3) % 2 === 0) text(fb, '▼', x + w - 16, y + h - 13, C.white, null);
  return { name: { x0: px + 40, y0: y + 5, x1: px + 40 + textW('宝箱怪'), y1: y + 5 + CS }, line: { x0: px + 40, y0: y + 24, x1: px + 40 + textW(s), y1: y + 24 + CS } };
}
