// scenes.js — 世界：超市冷冻柜走廊、目标柜门（冰淇淋 / 冰冻宇宙）、宇宙内部、收银台、旋涡划像
import { clamp, lerp, hash, vnoise, TAU } from '/core/lib.js';
import { INK, W, H, g, push, pop, translate, rotate, scale, shape, fillOnly, stroke, ell, arc, spline, rr, rect, quad, dot, text, screenRect, bands, tx, S } from './engine/toon.js';
import { tub, popsicle, PAL } from './chars.js';

// 超市（可疑地正常）：米色/浅棕/灰绿/奶油
export const AP = {
  wall: '#efe2c4', wall2: '#e4d3ae', ceil: '#e9dcbc', light: '#fffbe9', frame: '#f6f2e8', frameS: '#d9d2c2', header: '#f1ebdc', stripe: '#a9b393',
  glass: '#d6dbe0', frost: '#eef1f4', frostS: '#c3c9d1', handle: '#a9adb6', kick: '#8b8577', floor: '#d6c49e', floorL: '#c8b48c', floorH: '#e2d3b2',
  sign: '#f4e3b8', inside: '#e2e6ea', insideS: '#c9cfd6', shelf: '#9aa0aa',
  pink: '#f0a3b8', pinkS: '#d27f97', brown: '#9b6441', brownS: '#7a4a2f', mint: '#a9d3b4', mintS: '#86b392', lidP: '#f7c7d3', lidB: '#c58b62', lidM: '#cfe7d5',
};
// 冰冻宇宙：紫黑 + 金星点；冰青辉光只属于这里
export const UP = { bg0: '#140b2b', bg1: '#1e1240', bg2: '#2a1857', gold: '#f4c95d', pale: '#fff1c4', glow: '#5ff0ff', glowL: '#c8fbff', core: '#effeff', crystal: 'rgba(95,240,255,.16)' };

const DOOR_W = 300, DOOR_TOP = -660, DOOR_BOT = -50;

// —— 走廊背景（不含目标柜门）——
export function aisleBack(t, { camx = 0, frozenGlow = 0 } = {}) {
  fillOnly(rect(-6000, -2200, 12000, 1500), AP.wall, { boil: 0 });
  fillOnly(rect(-6000, -2200, 12000, 1180), AP.ceil, { boil: 0 });
  stroke([[-6000, -1020], [6000, -1020]], 5);
  // 日光灯
  for (let k = -8; k <= 8; k++) { const x = k * 720 + 120; shape(rr(x - 200, -990, 400, 30, 10), { fill: AP.light, lw: 5 }); fillOnly(rect(x - 200, -950, 400, 6), 'rgba(255,255,255,.0)'); }
  // 冷柜顶部灯箱
  shape(rect(-6000, -760, 12000, 86), { fill: AP.header, lw: 6, shade: () => fillOnly(rect(-6000, -704, 12000, 14), AP.stripe, { boil: .3 }) });
  // 门（k≠0）
  for (let k = -10; k <= 10; k++) { if (k === 0) continue; closedDoor(k * 320 - DOOR_W / 2, k); }
  // 门框立柱
  for (let k = -10; k <= 10; k++) shape(rect(k * 320 - 170, DOOR_TOP - 14, 20, DOOR_BOT - DOOR_TOP + 28), { fill: AP.frame, lw: 5 });
  // 底部踢脚板
  shape(rect(-6000, DOOR_BOT, 12000, 50), { fill: AP.kick, lw: 6 });
  for (let k = -30; k <= 30; k++) stroke([[k * 200 - 60, -26], [k * 200 + 60, -26]], 4);
  // 地面：平涂色带 + 透视地砖线
  fillOnly(rect(-6000, 0, 12000, 1400), AP.floor, { boil: 0 });
  fillOnly(rect(-6000, 0, 12000, 46), AP.floorH, { boil: 0 });
  for (const y of [46, 130, 250, 420]) stroke([[-6000, y], [6000, y]], 4, { line: AP.floorL, boil: .3 });
  for (let k = -24; k <= 24; k++) { const x = k * 260; stroke([[x, 0], [x + (x - camx) * .9, 700]], 4, { line: AP.floorL, boil: .3 }); }
}
function closedDoor(x0, k) {
  shape(rect(x0, DOOR_TOP, DOOR_W, DOOR_BOT - DOOR_TOP), { fill: AP.frame, lw: 6 });
  shape(rect(x0 + 22, DOOR_TOP + 24, DOOR_W - 44, DOOR_BOT - DOOR_TOP - 48), { fill: AP.glass, lw: 5, shade: () => frostOn(x0 + 22, DOOR_TOP + 24, DOOR_W - 44, DOOR_BOT - DOOR_TOP - 48, k) });
  shape(rr(x0 + 30, -440, 16, 230, 8), { fill: AP.handle, lw: 5 });
}
// 结霜：底部和角落的浅色硬边块 + 斜高光
function frostOn(x, y, w, h, seed) {
  fillOnly(spline([[x - 10, y + h * .55], [x + w * .3, y + h * .62 + hash(seed) * 30], [x + w * .6, y + h * .7], [x + w + 10, y + h * .58], [x + w + 10, y + h + 10], [x - 10, y + h + 10]]), AP.frost, { boil: .5 });
  fillOnly(spline([[x - 10, y - 10], [x + w * .42, y - 10], [x + w * .2, y + h * .14], [x - 10, y + h * .22]]), AP.frost, { boil: .5 });
  fillOnly([[x + w * .55, y], [x + w * .7, y], [x + w * .2, y + h], [x + w * .05, y + h]], 'rgba(255,255,255,.45)', { boil: .3 });
  for (let i = 0; i < 6; i++) dot(x + hash(seed * 3 + i) * w, y + h * .5 + hash(seed * 7 + i) * h * .4, 3, 'rgba(255,255,255,.9)');
}

// —— 目标柜门 ——
// ang：0 关 … 1.75 开（铰链在右侧 x=+150）；content: 'ice' | 'universe'；u：宇宙参数
export function targetDoor(t, ang, content, u = {}) {
  const x0 = -DOOR_W / 2, x1 = DOOR_W / 2;
  // 门洞（内部）
  shape(rect(x0, DOOR_TOP, DOOR_W, DOOR_BOT - DOOR_TOP), { fill: AP.frame, lw: 6 });
  const ix = x0 + 16, iy = DOOR_TOP + 16, iw = DOOR_W - 32, ih = DOOR_BOT - DOOR_TOP - 32;
  if (ang > .01) {
    if (content === 'universe') universeInside(t, ix, iy, iw, ih, u);
    else iceInside(t, ix, iy, iw, ih);
  }
  return { ix, iy, iw, ih };
}
// 门板（在角色之后画还是之前画由调用者决定；这里画在门洞之上）
export function doorPanel(ang, shake = 0) {
  const xh = DOOR_W / 2, w = DOOR_W, c = Math.cos(ang), s = Math.sin(ang);
  const xf = xh - w * c + .14 * w * s + shake, grow = 1 + .16 * s;
  const yc = (DOOR_TOP + DOOR_BOT) / 2, hh = (DOOR_BOT - DOOR_TOP) / 2;
  const q = (u, v) => { const x = lerp(xf, xh, u), gr = lerp(grow, 1, u); return [x, yc + v * hh * gr]; };
  const front = c > 0;
  shape([q(0, -1), q(1, -1), q(1, 1), q(0, 1)], { fill: front ? AP.frame : AP.frameS, lw: 6 });
  // 玻璃
  const gl = [q(.075, -.92), q(.925, -.92), q(.925, .92), q(.075, .92)];
  shape(gl, { fill: front ? AP.glass : '#c7cdd4', lw: 5, shade: () => {
    if (front) { const a = q(.075, -.92), b = q(.925, .92); frostOn(Math.min(a[0], b[0]), a[1], Math.abs(b[0] - a[0]), b[1] - a[1], 0); }
  } });
  // 把手（自由边一侧）
  if (Math.abs(xh - xf) > 30) { const h0 = q(.1, -.12), h1 = q(.1, .33), hw = 16 * Math.max(.3, Math.abs(c)); shape(rr(h0[0] - (front ? 0 : hw), h0[1], hw, h1[1] - h0[1], 8), { fill: AP.handle, lw: 5 }); }
  return { handle: q(.1, .1) };
}

// 冰淇淋货架
function iceInside(t, x, y, w, h) {
  shape(rect(x, y, w, h), { fill: AP.inside, lw: 5, shade: () => fillOnly(rect(x + w * .72, y, w * .3, h), AP.insideS, { boil: .3 }) });
  const rows = [y + h * .3, y + h * .62, y + h * .94];
  const cols = [[AP.pink, AP.pinkS, AP.lidP], [AP.brown, AP.brownS, AP.lidB], [AP.mint, AP.mintS, AP.lidM]];
  rows.forEach((ry, r) => {
    stroke([[x, ry + 4], [x + w, ry + 4]], 5, { line: AP.shelf });
    for (let k = 0; k < 3; k++) { const c = cols[(k + r) % 3]; tub(x + 44 + k * 90, ry, 78, 92, c[0], c[1], c[2]); }
  });
}
// 冷气：从门洞底部滚出的白色团
export function vapor(t, t0, amount = 1) {
  const age = t - t0; if (age < 0 || amount <= 0) return;
  // 冷气：几团多瓣的云，从门洞底部溢出、贴地向外滚，逐渐变淡
  for (let k = 0; k < 7; k++) {
    const a = age - k * .05; if (a < 0) continue;
    const life = clamp(1 - a / 1.8); if (life <= 0) continue;
    const dir = (hash(k + 1) - .5) * 2, sp = Math.min(a, .9);
    const px = dir * 60 + dir * sp * 260, py = -70 + Math.min(a * 260, 110) - k * 6;
    const r = (34 + hash(k + 9) * 22) * (1 + sp * .9);
    const lobes = []; for (let i = 0; i < 9; i++) { const b = i / 9 * TAU, w = 1 + .28 * Math.sin(i * 2.7 + k + a * 3); lobes.push([px + Math.cos(b) * r * 1.5 * w, py + Math.sin(b) * r * .62 * w - (Math.sin(b) < 0 ? r * .25 : 0)]); }
    shape(spline(lobes), { fill: `rgba(255,255,255,${.78 * life * amount})`, lw: 4, line: `rgba(160,170,190,${.9 * life * amount})` });
  }
}
// 冰冻的宇宙（门洞里）
function universeInside(t, x, y, w, h, u) {
  const P = shape(rect(x, y, w, h), { fill: UP.bg0, lw: 5, stroke: false });
  g.save(); g.clip(P);
  universeField(t, x + w / 2, y + h * .48, Math.max(w, h) * .62, u);
  g.restore();
}
// 宇宙图案（可用于门洞和宇宙内部）：cx,cy 中心，R 半径，u.spin 旋转（冻住时为 0）
export function universeField(t, cx, cy, R, u = {}) {
  const spin = u.spin || 0;
  bandsAt(cx, cy, R);
  // 星点
  for (let i = 0; i < 140; i++) {
    const a = hash(i * 1.7) * TAU, r = Math.sqrt(hash(i * 3.1)) * R * 1.4;
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r * .9, s2 = 2 + hash(i) * 3.5;
    if (i % 9 === 0) star4(px, py, s2 * 3, i % 2 ? UP.pale : UP.gold);
    else dot(px, py, s2 * .7, i % 3 ? UP.pale : UP.gold);
  }
  // 冻在冰里的小行星（带环）和彗星
  push(); translate(cx - R * .55, cy - R * .5);
  shape(ell(0, 0, R * .1, R * .1, 24), { fill: '#e98f5e', lw: 6, shade: () => fillOnly(ell(R * .06, R * .04, R * .07, R * .1, 16), '#c06a3d', { boil: .3 }) });
  stroke(arc(0, 0, R * .18, R * .05, -.3, Math.PI + .3, 20), 6, { line: INK });
  pop();
  push(); translate(cx + R * .55, cy + R * .45); rotate(-.6);
  shape(spline([[-R * .2, -6], [0, -R * .03], [R * .04, 0], [0, R * .03], [-R * .2, 6]]), { fill: UP.pale, lw: 5 });
  pop();
  // 旋涡星系：3 条金色旋臂 + 冰青白的核
  for (let arm = 0; arm < 4; arm++) {
    const pts = [];
    for (let i = 0; i <= 26; i++) { const k = i / 26, a = arm * TAU / 4 + k * 4.6 + spin, r = R * (.05 + k * .78); pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * .62]); }
    const pts2 = pts.slice().reverse().map(([px, py], i) => { const k = 1 - i / 26, a = arm * TAU / 4 + k * 4.6 + spin + .42 * (1 - k * .6); const r = R * (.05 + k * .78); return [cx + Math.cos(a) * r, cy + Math.sin(a) * r * .62]; });
    shape([...pts, ...pts2], { fill: arm % 2 ? '#3c2a86' : '#4a2f99', lw: 5 });
    for (let i = 3; i < 26; i += 2) dot(pts[i][0], pts[i][1], 4 + (i % 4), i % 4 ? UP.gold : UP.pale);
  }
  fillOnly(ell(cx, cy, R * .2, R * .14, 30), 'rgba(200,251,255,.28)', { boil: .3 });
  shape(ell(cx, cy, R * .09, R * .065, 30), { fill: UP.core, lw: 6 });
  // 冰晶：大块多边形碎片，半透明冰青
  for (let i = 0; i < 7; i++) {
    const a = hash(i * 5.3) * TAU, r = R * (.25 + hash(i * 2.2) * .7), px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r * .8;
    const s = R * (.12 + hash(i * 8.1) * .14), rot0 = hash(i * 4.4) * TAU;
    const pts = []; for (let k = 0; k < 6; k++) { const b = rot0 + k / 6 * TAU, rr2 = s * (k % 2 ? .62 : 1); pts.push([px + Math.cos(b) * rr2, py + Math.sin(b) * rr2]); }
    shape(pts, { fill: UP.crystal, lw: 4, line: 'rgba(200,251,255,.85)' });
    stroke([[pts[0][0], pts[0][1]], [px, py], [pts[3][0], pts[3][1]]], 3, { line: 'rgba(200,251,255,.6)' });
  }
}
function bandsAt(cx, cy, R) {
  const cols = [UP.bg0, UP.bg1, UP.bg2, UP.bg1, UP.bg0];
  for (let i = 0; i < 5; i++) fillOnly(rect(cx - R * 3, cy - R * 1.6 + i * R * .64, R * 6, R * .66), cols[i], { boil: 0 });
}
export function star4(x, y, s, col) {
  shape([[x, y - s], [x + s * .25, y - s * .25], [x + s, y], [x + s * .25, y + s * .25], [x, y + s], [x - s * .25, y + s * .25], [x - s, y], [x - s * .25, y - s * .25]], { fill: col, lw: 3 });
}

// 门洞周围的辉光：疙瘩状冰青边框 + 冰柱 + 绕行冰屑 + 两圈平涂半透明环
export function portalRim(t, k = 1, { drips = true } = {}) {
  if (k <= 0) return;
  const x0 = -DOOR_W / 2 - 6, y0 = DOOR_TOP - 6, w = DOOR_W + 12, h = DOOR_BOT - DOOR_TOP + 12;
  for (const [pad, a] of [[90, .09], [44, .15]]) fillOnly(rr(x0 - pad, y0 - pad, w + pad * 2, h + pad * 2, 60), `rgba(95,240,255,${a * k})`, { boil: .4 });
  // 疙瘩边：沿矩形周长取点，法向加噪声
  const pts = [], outer = [], n = 64;
  const per = (i) => { const L = 2 * (w + h), d = i / n * L; if (d < w) return [x0 + d, y0, 0, -1]; if (d < w + h) return [x0 + w, y0 + d - w, 1, 0]; if (d < 2 * w + h) return [x0 + w - (d - w - h), y0 + h, 0, 1]; return [x0, y0 + h - (d - 2 * w - h), -1, 0]; };
  for (let i = 0; i < n; i++) { const [px, py, nx, ny] = per(i), b = 14 + vnoise(i * .7 + 3) * 22; outer.push([px + nx * b * k, py + ny * b * k]); pts.push([px - nx * 6, py - ny * 6]); }
  const ring = [...outer, outer[0], ...pts.slice().reverse(), pts[pts.length - 1]];
  shape(ring, { fill: UP.glow, lw: 7 });
  // 冰柱
  for (let i = 0; i < 6; i++) {
    const ix = x0 + 30 + i * (w - 60) / 5, L = 34 + hash(i * 2.7) * 40;
    shape([[ix - 12, y0 + 10], [ix + 12, y0 + 10], [ix + 2, y0 + 10 + L]], { fill: UP.glowL, lw: 5 });
    if (drips) { const ph = ((t * .7 + hash(i * 9.1)) % 1); if (i % 2 === 0) shape(ell(ix + 2, y0 + 16 + L + ph * 120, 5, 8, 10), { fill: UP.glowL, lw: 4 }); }
  }
  // 绕行冰屑（逐帧，24 fps）
  for (let i = 0; i < 7; i++) {
    const a = t * 1.3 + i / 7 * TAU, rx = w * .62, ry = h * .55;
    const px = Math.cos(a) * rx, py = (y0 + h / 2) + Math.sin(a) * ry;
    snowflake(px, py, 9 + (i % 3) * 3, a * 2);
  }
}
function snowflake(x, y, s, a) {
  push(); translate(x, y); rotate(a);
  for (let k = 0; k < 3; k++) { const b = k * Math.PI / 3; stroke([[Math.cos(b) * -s, Math.sin(b) * -s], [Math.cos(b) * s, Math.sin(b) * s]], 5, { line: UP.glowL }); }
  pop();
}

// —— 收银台 ——
export const CP = { wall: '#eadbb9', wall2: '#dccaa2', counter: '#b89c72', counterS: '#9a805a', top: '#d7c39b', belt: '#5b5850', beltL: '#76736a', glassS: '#2f2b36', reg: '#cfc6b0', regS: '#ada48e', scr: '#2a1d10', amber: '#ffb547', red: '#ff3b30', bag: '#c9a877', bagS: '#a9895a' };
export function checkoutBack(t, { glowDoor = 1, flash = 0 } = {}) {
  fillOnly(rect(-5000, -2400, 10000, 2400), CP.wall, { boil: 0 });
  fillOnly(rect(-5000, -1300, 10000, 160), CP.wall2, { boil: 0 });
  // 远处的走廊窗口：小号的冷冻柜一排，一扇门还亮着冰青光（回扣）
  const wx = -1150, wy = -900, ww = 1150, wh = 600;
  shape(rect(wx, wy, ww, wh), { fill: AP.wall, lw: 6, shade: () => {
    push(); translate(wx + ww * .5, wy + wh * .82); scale(.36);
    shape(rect(-3000, -760, 6000, 86), { fill: AP.header, lw: 6 });
    for (let k = -6; k <= 6; k++) {
      const x0 = k * 320 - 150;
      shape(rect(x0, DOOR_TOP, DOOR_W, DOOR_BOT - DOOR_TOP), { fill: AP.frame, lw: 6 });
      if (k === 3) continue;     // 那扇门最后画（光环要压在相邻门上）；k=3 靠窗右侧，后拉时最先露出来
      shape(rect(x0 + 22, DOOR_TOP + 24, DOOR_W - 44, DOOR_BOT - DOOR_TOP - 48), { fill: AP.glass, lw: 5 });
    }
    fillOnly(rect(-3000, DOOR_BOT, 6000, 900), AP.floor, { boil: 0 });
    // 仍然开着的那扇门：和开场同一个装置——冰青疙瘩边 + 两圈半透明光环 + 缓慢旋转的旋臂 + 绕行冰屑；flash 时整体提亮一下
    push(); translate(3 * 320, 0);
    targetDoor(t, 1, 'universe', { spin: t * .55 });
    portalRim(t, glowDoor * (1 + 1.3 * flash), { drips: false });
    if (flash > 0) fillOnly(rr(-DOOR_W / 2 - 40, DOOR_TOP - 40, DOOR_W + 80, DOOR_BOT - DOOR_TOP + 80, 40), `rgba(200,251,255,${.75 * flash})`, { boil: .3 });
    pop();
    pop();
  } });
  // 天花灯
  for (let k = -5; k <= 5; k++) shape(rr(k * 800 - 180, -1220, 360, 28, 10), { fill: AP.light, lw: 5 });
}
export function counter(t, beltOff) {
  // 柜台正面
  shape(rect(-5000, 0, 10000, 900), { fill: CP.counter, lw: 7, shade: () => { fillOnly(rect(-5000, 0, 10000, 40), CP.counterS, { boil: .3 }); for (let k = -10; k <= 10; k++) fillOnly(rect(k * 420, 90, 12, 900), CP.counterS, { boil: .3 }); } });
  shape(rect(-5000, -24, 10000, 24), { fill: CP.top, lw: 6 });
  // 传送带
  shape(rr(-1500, -46, 1650, 40, 18), { fill: CP.belt, lw: 6, shade: () => { for (let k = -2; k < 40; k++) { const x = -1500 + ((k * 70 + beltOff) % 2800); fillOnly(rect(x, -46, 14, 40), CP.beltL, { boil: .2 }); } } });
  // 扫码玻璃
  shape([[178, -40], [392, -40], [402, -6], [168, -6]], { fill: CP.glassS, lw: 6, shade: () => {
    stroke([[200, -34], [370, -12]], 3, { line: CP.red, boil: .2 }); stroke([[200, -12], [370, -34]], 3, { line: CP.red, boil: .2 });
  } });
}
// 收银机（显示屏 on：0..1 弹出，按 12 fps 步进由调用者控制）
export function register(t, on) {
  shape(rr(560, -190, 270, 170, 14), { fill: CP.reg, lw: 7, shade: () => fillOnly(rect(740, -200, 100, 200), CP.regS, { boil: .3 }) });
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) shape(rr(586 + c * 40, -160 + r * 36, 30, 26, 6), { fill: r === 2 && c === 3 ? '#d98a5e' : '#eee6d2', lw: 4 });
  shape(rect(690, -330, 26, 140), { fill: CP.regS, lw: 6 });
  shape(rr(560, -470, 330, 150, 16), { fill: '#3a3640', lw: 7 });
  shape(rr(580, -452, 290, 114, 10), { fill: CP.scr, lw: 5 });
  return { sx: 725, sy: -395 };
}
export function bag(x, y, front) {
  shape([[x - 110, y - 230], [x + 110, y - 230], [x + 124, y], [x - 124, y]], { fill: CP.bag, lw: 7, shade: () => fillOnly(rect(x + 40, y - 240, 100, 260), CP.bagS, { boil: .3 }) });
  stroke([[x - 110, y - 210], [x + 110, y - 210]], 4);
}

// —— 旋涡划像（屏幕空间，逐帧）—— c：覆盖率 0..1，rot：旋转
export function swirl(c, rot) {
  if (c <= 0) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  push(); const saveM = null;
  const cx = W / 2, cy = H / 2, R = 1400, n = 6;
  for (let k = 0; k < n; k++) {
    const pts = [], half = (TAU / n / 2) * clamp(c * 1.08);
    for (let i = 0; i <= 30; i++) { const r = i / 30 * R, a = rot + k * TAU / n + r * .0042 - half; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    for (let i = 30; i >= 0; i--) { const r = i / 30 * R, a = rot + k * TAU / n + r * .0042 + half; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    shape(pts, { fill: k % 2 ? UP.glow : '#3c2a86', lw: 8 });
  }
  if (c > .2) shape(ell(cx, cy, 90 * c, 90 * c, 30), { fill: UP.core, lw: 7 });
  pop();
}
