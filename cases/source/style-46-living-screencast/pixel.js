// 像素层：卡片长出的腿、手、眼睛和道具，全部落在同一张 7px 方格上（随相机缩放，边缘锐利）。
export const PX = 7, ORANGE = '#FF6A1F', ORANGE_D = '#C9470C', EYE = '#2A140A';

// 用方格画一组像素：cells = [[c, r, colour]]，(x0, y0) 为网格原点（世界坐标）
function cellsSvg(cells, x0, y0, px = PX, op = 1) {
  if (!cells.length) return '';
  let minc = Infinity, minr = Infinity, maxc = -Infinity, maxr = -Infinity;
  for (const [c, r] of cells) { minc = Math.min(minc, c); minr = Math.min(minr, r); maxc = Math.max(maxc, c); maxr = Math.max(maxr, r); }
  const W = maxc - minc + 1, H = maxr - minr + 1;
  let s = ''; for (const [c, r, col] of cells) s += `<rect x="${c - minc}" y="${r - minr}" width="1.03" height="1.03" fill="${col}"/>`;
  return `<svg class="px" viewBox="0 0 ${W} ${H}" width="${W * px}" height="${H * px}" style="left:${x0 + minc * px}px;top:${y0 + minr * px}px;opacity:${op}" shape-rendering="crispEdges">${s}</svg>`;
}
export const pixart = (rows, x, y, pal, px = PX, op = 1) => {
  const cells = []; rows.forEach((row, r) => [...row].forEach((ch, c) => { if (pal[ch]) cells.push([c, r, pal[ch]]); }));
  return cellsSvg(cells, x, y, px, op);
};

// 眼睛：6×6 方格的「脸」（就是复选框）
const EYES = {
  n: [[1, 2], [1, 3], [4, 2], [4, 3]], l: [[0, 2], [0, 3], [3, 2], [3, 3]], r: [[2, 2], [2, 3], [5, 2], [5, 3]],
  u: [[1, 1], [1, 2], [4, 1], [4, 2]], d: [[1, 3], [1, 4], [4, 3], [4, 4]], wide: [[1, 1], [1, 2], [1, 3], [4, 1], [4, 2], [4, 3]],
  blink: [[1, 3], [4, 3]], shut: [[0, 3], [1, 3], [4, 3], [5, 3]], happy: [[0, 3], [1, 2], [2, 3], [3, 3], [4, 2], [5, 3]],
  dizzy: [[0, 1], [2, 1], [1, 2], [0, 3], [2, 3], [3, 1], [5, 1], [4, 2], [3, 3], [5, 3]],
  ul: [[0, 1], [0, 2], [3, 1], [3, 2]],
};
export function face(fx, fy, eyes = 'n', mouth = false) {
  const cells = (EYES[eyes] || EYES.n).map(([c, r]) => [c, r, EYE]);
  if (mouth) cells.push([2, 5, EYE], [3, 5, EYE]);
  // 脸本身是橙色方块（6×6），眼睛压在上面
  const bg = []; for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) bg.push([c, r, r === 5 ? ORANGE_D : ORANGE]);
  return cellsSvg(bg, fx, fy) + cellsSvg(cells, fx, fy);
}

// 腿：从卡片底边往下长；(x, y) 为腿的上端中心；n = 腿长格数；pose: stand / walkA / walkB / tuck / sit；dir: 1 朝右 -1 朝左
export function leg(x, y, n, pose, dir = 1) {
  const cells = [], put = (c, r, col = ORANGE) => cells.push([c, r, col]), X0 = x - PX, Y0 = y;
  if (pose === 'none') return '';
  if (pose === 'sit') { for (let c = -1; c < 3; c++) put(c, 0, ORANGE_D); return cellsSvg(cells, X0, Y0); }
  if (pose === 'tuck') { put(0, 0); put(1, 0); put(0, 1); put(1, 1); put(dir > 0 ? 2 : -1, 1, ORANGE_D); put(dir > 0 ? 3 : -2, 1, ORANGE_D); return cellsSvg(cells, X0, Y0); }
  let len = n, kick = 0;
  if (pose === 'walkA') { len = n; kick = 1; } if (pose === 'walkB') { len = n - 1; kick = -1; }
  for (let r = 0; r < len; r++) { const sh = pose === 'stand' ? 0 : Math.round(kick * r / Math.max(1, len - 1)); put(sh, r); put(sh + 1, r); }
  const fs = pose === 'stand' ? 0 : kick;   // 脚掌朝向前方
  for (let c = 0; c < 3; c++) put(fs + (dir > 0 ? c : 1 - c), len, ORANGE_D);
  return cellsSvg(cells, X0, Y0);
}
// 手臂：从卡片侧边伸出；side -1 左 / 1 右；pose: down / up / out / flail
export function arm(x, y, side, pose, ph = 0) {
  const cells = [], put = (c, r, col = ORANGE) => cells.push([c * side, r, col]);
  if (pose === 'none') return '';
  if (pose === 'flail') pose = ph % 2 ? 'up' : 'out';
  if (pose === 'down') { put(0, 0); put(1, 1); put(1, 2); put(1, 3, ORANGE_D); put(2, 3, ORANGE_D); }
  if (pose === 'out') { put(0, 0); put(1, 0); put(2, 0); put(3, -1, ORANGE_D); put(3, 0, ORANGE_D); }
  if (pose === 'up') { put(0, 0); put(1, -1); put(1, -2); put(1, -3); put(1, -4, ORANGE_D); put(2, -4, ORANGE_D); }
  return cellsSvg(cells, side > 0 ? x : x - PX, y);
}

export const BANG = (x, y, op = 1) => pixart(['.kkk.', 'koook', 'koook', 'koook', '.kok.', '.kok.', '..k..', '.....', '.kok.', '..k..'], x, y, { k: EYE, o: '#FFD23F' }, PX, op);
export const SWEAT = (x, y, op = 1) => pixart(['..b', '.bb', 'bbb', 'bbw', '.b.'], x, y, { b: '#5AA9F0', w: '#D8EEFF' }, PX, op);
export const ZED = (x, y, s = 1, op = 1) => pixart(['zzzz', '..z.', '.z..', 'zzzz'], x, y, { z: ORANGE }, PX * s, op);
export const SPARK = (x, y, col = '#FFD23F', op = 1) => pixart(['..y..', '..y..', 'yy.yy', '..y..', '..y..'], x - 2.5 * PX, y - 2.5 * PX, { y: col }, PX, op);

// 落地尘土：k 0→1 向两侧散开
export function dust(x, y, k, seed = 1, n = 8) {
  if (k <= 0 || k >= 1) return ''; let s = '';
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1, j = (i >> 1) + 1, e = 1 - (1 - k) * (1 - k);
    const dx = side * (40 + j * 34 + ((seed * 7 + i * 13) % 11)) * e, dy = -(10 + j * 7) * Math.sin(Math.PI * k * .9);
    const sz = Math.round(PX * (1 - k * .6));
    s += `<div class="dp" style="left:${Math.round((x + dx) / PX) * PX}px;top:${Math.round((y + dy) / PX) * PX - sz}px;width:${sz}px;height:${sz}px;opacity:${1 - k}"></div>`;
  }
  return s;
}
// 像素爆散（挣脱的瞬间）
export function burst(x, y, k, seed = 3, n = 18) {
  if (k <= 0 || k >= 1) return ''; let s = '';
  for (let i = 0; i < n; i++) {
    const a = ((seed * 97 + i * 61) % 360) / 180 * Math.PI, r = (40 + ((i * 37 + seed) % 90)) * (1 - (1 - k) ** 3), sz = PX * (i % 3 ? 1 : 2) * (1 - k * .5);
    s += `<div class="bp" style="left:${Math.round((x + Math.cos(a) * r) / PX) * PX}px;top:${Math.round((y + Math.sin(a) * r * .8) / PX) * PX}px;width:${sz}px;height:${sz}px;background:${i % 4 ? ORANGE : '#FFD23F'};opacity:${1 - k * k}"></div>`;
  }
  return s;
}
// 速度线
export function speed(x, y, dirx, diry, k, n = 5) {
  if (k <= 0 || k >= 1) return ''; let s = '';
  const L = Math.hypot(dirx, diry) || 1, ux = dirx / L, uy = diry / L;
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * 22, len = (5 + (i % 2) * 4) * PX, bx = x - ux * (280 + i * 18) - uy * off, by = y - uy * (280 + i * 18) + ux * off;
    s += `<div class="sl" style="left:${Math.round(bx / PX) * PX}px;top:${Math.round(by / PX) * PX}px;width:${len}px;height:${PX}px;transform:rotate(${Math.atan2(uy, ux)}rad);opacity:${(1 - k) * .75}"></div>`;
  }
  return s;
}
