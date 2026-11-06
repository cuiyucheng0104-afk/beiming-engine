// font.js — 原创可变宽像素字（拉丁、数字、全角标点手绘）+ 中文：子集化 Noto Sans SC 在帧缓冲里二值化成 12 px 点阵
import { C, T, FB } from './px.js';

const G = {};
const def = (ch, ...rows) => { G[ch] = rows; };
// 拉丁大写（原创，cap 7，顶角削一像素）
def('A', '.##.', '#..#', '#..#', '####', '#..#', '#..#', '#..#');
def('C', '.###', '#...', '#...', '#...', '#...', '#...', '.###');
def('D', '###.', '#..#', '#..#', '#..#', '#..#', '#..#', '###.');
def('E', '####', '#...', '#...', '###.', '#...', '#...', '####');
def('H', '#..#', '#..#', '#..#', '####', '#..#', '#..#', '#..#');
def('I', '###', '.#.', '.#.', '.#.', '.#.', '.#.', '###');
def('L', '#...', '#...', '#...', '#...', '#...', '#...', '####');
def('M', '#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#');
def('O', '.##.', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.');
def('P', '###.', '#..#', '#..#', '###.', '#...', '#...', '#...');
def('R', '###.', '#..#', '#..#', '###.', '#.#.', '#..#', '#..#');
def('S', '.###', '#...', '#...', '.##.', '...#', '...#', '###.');
def('T', '###', '.#.', '.#.', '.#.', '.#.', '.#.', '.#.');
def('U', '#..#', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.');
def('V', '#...#', '#...#', '#...#', '.#.#.', '.#.#.', '.#.#.', '..#..');
def('X', '#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#');
def('v', '....', '....', '#..#', '#..#', '#..#', '.##.', '.##.');
def('0', '.##.', '#..#', '#.##', '##.#', '#..#', '#..#', '.##.');
def('1', '.#', '##', '.#', '.#', '.#', '.#', '.#');
def('2', '.##.', '#..#', '...#', '..#.', '.#..', '#...', '####');
def('3', '###.', '...#', '...#', '.##.', '...#', '...#', '###.');
def('4', '..#.', '.##.', '#.#.', '#.#.', '####', '..#.', '..#.');
def('5', '####', '#...', '###.', '...#', '...#', '#..#', '.##.');
def('6', '.##.', '#...', '#...', '###.', '#..#', '#..#', '.##.');
def('7', '####', '...#', '..#.', '..#.', '.#..', '.#..', '.#..');
def('8', '.##.', '#..#', '#..#', '.##.', '#..#', '#..#', '.##.');
def('9', '.##.', '#..#', '#..#', '.###', '...#', '...#', '.##.');
def('!', '#', '#', '#', '#', '#', '.', '#');
def('+', '...', '...', '.#.', '###', '.#.', '...', '...');
def('/', '...#', '...#', '..#.', '.##.', '.#..', '#...', '#...');
def(':', '.', '#', '.', '.', '.', '#', '.');
def('▶', '#..', '##.', '###', '##.', '#..', '...', '...');
def('▼', '.....', '.....', '#####', '.###.', '..#..', '.....', '.....');
// 全角标点（12 宽格，手绘）
const FULL = {
  '！': ['....##......', '....##......', '....##......', '....##......', '....##......', '....##......', '....##......', '............', '....##......', '....##......', '............', '............'],
  '。': ['............', '............', '............', '............', '............', '............', '............', '............', '.##.........', '#..#........', '#..#........', '.##.........'],
  '…': ['............', '............', '............', '............', '............', '............', '............', '............', '##..##..##..', '##..##..##..', '............', '............'],
  '、': ['............', '............', '............', '............', '............', '............', '............', '............', '.#..........', '..#.........', '...#........', '............'],
};
const CJK = new Map();
const isCJK = ch => /[　-鿿＀-￯…]/.test(ch);

// 中文点阵：把字画进 2× 画布，2×2 块取平均再阈值 → 12 px，比直接 12 px 二值化干净
export let CS = 12;   // 中文点阵边长
export async function initCJK(chars, family, weight = 500, thr = .42, size = 12) {
  CS = size; const S2 = size * 2;
  await document.fonts.load(`${weight} ${S2}px ${family}`, chars);
  const cv = document.createElement('canvas'); cv.width = S2 * 2; cv.height = S2 * 2;
  const g = cv.getContext('2d', { willReadFrequently: true });
  for (const ch of new Set(chars)) {
    if (FULL[ch]) continue;
    g.clearRect(0, 0, S2 * 2, S2 * 2); g.fillStyle = '#fff'; g.font = `${weight} ${S2}px ${family}`; g.textBaseline = 'alphabetic';
    g.fillText(ch, 0, Math.round(S2 * .875));
    const a = g.getImageData(0, 0, S2, S2).data, d = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let s = 0; for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += a[((y * 2 + v) * S2 + x * 2 + u) * 4 + 3];
      d[y * size + x] = s / 4 / 255 > thr ? 1 : 0;
    }
    CJK.set(ch, d);
  }
}
for (const [ch, rows] of Object.entries(FULL)) { const d = new Uint8Array(144); rows.forEach((r, y) => { for (let x = 0; x < 12; x++) d[y * 12 + x] = r[x] === '#' ? 1 : 0; }); CJK.set(ch, d); }

export const LINE_H = () => CS + 2;
function adv(ch) { if (ch === ' ') return 4; if (CJK.has(ch) || isCJK(ch)) return CS + 1; const g = G[ch]; return g ? g[0].length + 1 : 4; }
export const textW = s => [...s].reduce((a, ch) => a + adv(ch), 0) - 1;
// 画一个字：返回前进宽度。拉丁字以 12 px 中文格的第 3 行为顶（与中文视觉居中）
function glyph(fb, ch, x, y, col) {
  if (CJK.has(ch)) { const d = CJK.get(ch), n = FULL[ch] ? 12 : CS, oy = FULL[ch] ? CS - 12 : 0; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (d[j * n + i]) fb.px(x + i, y + oy + j, col); return CS + 1; }
  const g = G[ch]; if (!g) return 4;
  g.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '#') fb.px(x + i, y + Math.round((CS - 7) / 2) + j, col); });
  return g[0].length + 1;
}
export function text(fb, s, x, y, col = C.white, shadow = C.night) {
  x = Math.round(x); y = Math.round(y);
  if (shadow != null) { let cx = x; for (const ch of s) cx += glyph(fb, ch, cx + 1, y + 1, shadow); }
  let cx = x; for (const ch of s) cx += glyph(fb, ch, cx, y, col);
}
// 2× 大字：8 邻域墨描边 + 逐行渐变
export function bigText(fb, s, x, y, rows, ink = C.ink, k = 2) {
  const tmp = new FB(textW(s) * k + 4, 12 * k + 4); tmp.clear(T);
  let cx = 2; for (const ch of s) { const w = glyph(tmp, ch, cx, 2, 1); cx += w; }
  // glyph 写进去的是 1×；放大
  const big = new FB(tmp.w * k + 4, tmp.h * k + 4); big.clear(T);
  for (let j = 0; j < tmp.h; j++) for (let i = 0; i < tmp.w; i++) if (tmp.get(i, j) === 1) for (let v = 0; v < k; v++) for (let u = 0; u < k; u++) big.px(i * k + u + 2, j * k + v + 2, 1);
  let y0 = 1e9, y1 = -1; for (let j = 0; j < big.h; j++) for (let i = 0; i < big.w; i++) if (big.get(i, j) === 1) { y0 = Math.min(y0, j); y1 = Math.max(y1, j); }
  const ox = Math.round(x) - 2 * k - 2, oy = Math.round(y) - 2 * k - 2 - 2;
  for (let j = 0; j < big.h; j++) for (let i = 0; i < big.w; i++) {
    if (big.get(i, j) === 1) continue;
    let n = false; for (let v = -1; v <= 1 && !n; v++) for (let u = -1; u <= 1; u++) if (big.get(i + u, j + v) === 1) { n = true; break; }
    if (n) fb.px(ox + i, oy + j, ink);
  }
  for (let j = 0; j < big.h; j++) for (let i = 0; i < big.w; i++) if (big.get(i, j) === 1) {
    const r = rows[Math.min(rows.length - 1, Math.floor((j - y0) / Math.max(1, y1 - y0 + 1) * rows.length))];
    fb.px(ox + i, oy + j, r);
  }
  return { w: big.w, h: big.h, ox, oy };
}
export const bigW = (s, k = 2) => textW(s) * k;
