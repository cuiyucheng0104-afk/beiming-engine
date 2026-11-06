// scenes.js — 地牢横版（三层视差 + 火把索引步进光）与战斗背景
import { W, H, C, T, LIGHT, DARK, bayer, hash, mod, clamp } from './px.js';

export const FLOOR_Y = 134, FEET_Y = 156;
export const WORLD_W = 600;

// 火把：火焰形状 3 帧（12 fps 调色板循环）
const FLAME = [
  ['..y..', '.yYy.', '.yYa.', 'aYYa.', 'aaYao', '.oao.'],
  ['.y...', '.yy..', '.yYy.', 'aYYya', 'aYYao', '.oao.'],
  ['...y.', '..yy.', '.yYy.', '.yYYa', 'oaYaa', '.oao.'],
];
const FMAP = { y: C.yellow, Y: C.white, a: C.amber, o: C.orange };
function torch(fb, x, y, t, k = 0) {
  fb.rect(x - 1, y + 5, 3, 2, C.dbrown); fb.rect(x, y + 7, 1, 4, C.umber); fb.px(x - 2, y + 5, C.umber); fb.px(x + 2, y + 5, C.umber);
  const f = FLAME[mod(Math.floor(t * 12) + k, 3)];
  f.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] !== '.') fb.px(x - 2 + i, y - 1 + j, FMAP[r[i]]); });
}
// 索引步进光：内圈两步、外圈一步，Bayer 边缘
export function lightPass(fb, lights, y0 = 0, y1 = H) {
  for (const L of lights) {
    const r = L.r, r2 = r * r;
    for (let y = Math.max(y0, Math.floor(L.y - r)); y < Math.min(y1, L.y + r); y++) for (let x = Math.max(0, Math.floor(L.x - r)); x < Math.min(W, L.x + r); x++) {
      const d2 = (x - L.x) ** 2 + ((y - L.y) * 1.15) ** 2; if (d2 > r2) continue;
      const v = 1 - Math.sqrt(d2) / r, i = y * W + x, c = fb.d[i];
      if (c >= 32) continue;
      if (v > .55 + bayer(x, y) * .25) fb.d[i] = LIGHT[LIGHT[c]];
      else if (v > bayer(x, y) * .45) fb.d[i] = LIGHT[c];
    }
  }
}
function bricks(fb, ox, y0, y1, base = C.dslate, hi = C.slate, lo = C.night, mortar = C.ink, x0 = 0, x1 = W) {
  for (let y = y0; y < y1; y++) {
    const row = Math.floor(y / 8), ry = mod(y, 8);
    for (let x = x0; x < x1; x++) {
      const wx = x + ox + (row % 2 ? 8 : 0), bx = mod(wx, 16), id = Math.floor(wx / 16) * 31 + row * 17;
      let c = base;
      if (ry === 7 || bx === 15) c = mortar;
      else if (ry === 0) c = hi;
      else if (ry === 6 || bx === 14) c = lo;
      else if (hash(id, 3) < .18 && (bx + ry) % 5 === 0) c = lo;
      fb.px(x, y, c);
    }
  }
}
// 天花板黑暗：Bayer 由黑渐入
function ceiling(fb, y0, y1) { for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) { const v = (y - y0) / (y1 - y0); if (bayer(x, y) > v) fb.px(x, y, C.ink); else if (bayer(x, y) > v * 1.6 - .3) fb.px(x, y, DARK[fb.get(x, y)]); } }

// —— 地牢（横版）——
// camX = 屏幕左缘的世界 x；t 秒
export function dungeon(fb, camX, t, opts = {}) {
  const wx = Math.round(camX * .75);                       // 墙层视差
  bricks(fb, wx, 0, FLOOR_Y);
  // 壁柱 + 拱龛（墙层）
  const torches = [];
  for (let k = -1; k < 8; k++) {
    const px = k * 112 - wx + 20;
    if (px > W + 40 || px < -60) continue;
    // 拱龛：深色凹进 + 拱顶
    const ax = px + 40, aw = 36;
    for (let y = 46; y < FLOOR_Y; y++) for (let x = ax; x < ax + aw; x++) {
      const cx = x - ax - aw / 2, top = 46 + (aw / 2) - Math.sqrt(Math.max(0, (aw / 2) ** 2 - cx * cx));
      if (y < top) continue;
      const depth = Math.min(1, (y - top) / 30);
      fb.px(x, y, bayer(x, y) < .55 + depth * .3 ? C.ink : C.night);
      if (y === Math.ceil(top) || y === Math.ceil(top) + 1) fb.px(x, y, C.slate);
    }
    // 壁柱
    for (let y = 18; y < FLOOR_Y; y++) for (let x = px; x < px + 14; x++) { const i = x - px; fb.px(x, y, i === 0 ? C.steel : i < 3 ? C.slate : i > 11 ? C.night : C.dslate); }
    fb.rect(px - 2, 18, 18, 4, C.slate); fb.hline(px - 2, px + 15, 18, C.steel); fb.hline(px - 2, px + 15, 21, C.night);
    torches.push({ x: px + 7, y: 64, k });
  }
  ceiling(fb, 0, 34);
  // 地面（伪透视石板，视差 1×）
  const vx = W / 2;
  for (let y = FLOOR_Y; y < H; y++) {
    const z = (y - FLOOR_Y) / (H - FLOOR_Y), sc = .55 + z * 1.1, rowI = Math.floor(Math.pow(z, .7) * 5), rz = Math.pow(z, .7) * 5 - rowI;
    for (let x = 0; x < W; x++) {
      const wxx = (x - vx) / sc + vx + camX, j = mod(wxx + (rowI % 2) * 14, 28);
      let c = C.dslate;
      if (rz < .12 / (1 + rowI * .3)) c = C.night;
      else if (j < 1.4 / sc) c = C.night;
      else if (rz < .3) c = C.slate;
      if (hash(Math.floor(wxx / 28), rowI, 7) < .25 && c === C.dslate) c = bayer(x, y) < .3 ? C.night : c;
      fb.px(x, y, c);
    }
  }
  fb.hline(0, W - 1, FLOOR_Y, C.steel); fb.hline(0, W - 1, FLOOR_Y + 1, C.slate);
  // 火把光（墙 + 地面）
  const fl = mod(Math.floor(t * 12), 4);
  lightPass(fb, torches.map(o => ({ x: o.x, y: o.y + 2, r: 30 + [0, 2, 1, 3][mod(fl + o.k, 4)] })), 0, H);
  for (const o of torches) torch(fb, o.x, o.y, t, o.k);
  // 水滴
  for (const d of (opts.drips || [])) {
    const s = t - d.t0; if (s < -0.6 || s > .35) continue;
    const dx = Math.round(d.wx * .75 - wx);
    if (s < 0) { if (s > -.6) fb.px(dx, 34, C.cyan); continue; }
    const y = 34 + Math.round(.5 * 600 * s * s);
    if (y < FLOOR_Y + 6) { fb.px(dx, y, C.cyan); fb.px(dx, y - 1, C.blue); }
    else { const k = Math.floor((s - Math.sqrt((FLOOR_Y + 6 - 34) / 300)) * 24); if (k < 4) { fb.px(dx - 1 - k, FLOOR_Y + 5 - (k >> 1), C.cyan); fb.px(dx + 1 + k, FLOOR_Y + 5 - (k >> 1), C.cyan); } }
  }
  return torches;
}
// 前景柱（1.35× 视差，暗剪影）
export function fgPillars(fb, camX, xs = [150, 520]) {
  for (const w of xs) {
    const x0 = Math.round(w - camX * 1.35);
    if (x0 > W || x0 < -30) continue;
    for (let y = 0; y < H; y++) for (let x = x0; x < x0 + 24; x++) { const i = x - x0; fb.px(x, y, i === 1 ? C.night : (i > 20 && bayer(x, y) < .5) ? C.night : C.ink); }
    fb.rect(x0 - 3, H - 14, 30, 14, C.ink); fb.hline(x0 - 3, x0 + 26, H - 14, C.night);
  }
}

// —— 战斗背景 ——
export const BAT = { mimicX: 82, heroX: 240, feet: 124 };
export function battleBG(fb, t, ox = 0) {
  bricks(fb, -ox, 0, 92, C.night, C.dslate, C.ink, C.ink);
  ceiling(fb, 0, 40);
  // 远处两只火把 + 光
  const tor = [{ x: 30 + ox, y: 46, k: 0 }, { x: 290 + ox, y: 46, k: 2 }];
  // 地面透视
  const vx = 160 + ox, vy = 30;
  for (let y = 92; y < H; y++) {
    const z = (y - vy) / (H - vy), wz = 1 / z;
    for (let x = 0; x < W; x++) {
      const u = (x - vx) * wz, gx = mod(u, 34), gz = mod(wz * 30, 10);
      let c = (y - 92) < 3 ? C.slate : C.dslate;
      if (gx < 1.3 * wz || gz < .55 * wz * wz * .4 + .35) c = C.night;
      const edge = Math.abs(x - vx) / 160 + (1 - (y - 92) / 88) * .2;
      if (bayer(x, y) < (edge - .7) * 1.2) c = C.night;
      fb.px(x, y, c);
    }
  }
  fb.hline(0, W - 1, 92, C.steel);
  const fl = mod(Math.floor(t * 12), 4);
  lightPass(fb, tor.map(o => ({ x: o.x, y: o.y + 2, r: 26 + [0, 2, 1, 3][mod(fl + o.k, 4)] })), 0, H);
  for (const o of tor) torch(fb, o.x, o.y, t, o.k);
}
export function shadow(fb, cx, y, rx, ry = 3) {
  for (let j = -ry; j <= ry; j++) for (let i = -rx; i <= rx; i++) if ((i / rx) ** 2 + (j / ry) ** 2 <= 1) { const c = fb.get(cx + i, y + j); if (c !== T && c < 32) fb.px(cx + i, y + j, bayer(cx + i, y + j) < .6 ? C.ink : DARK[c]); }
}
