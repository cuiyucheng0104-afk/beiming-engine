// main.js — 《冷冻柜》：镜头、表演、摄影机、window.EV、window.TEXTS。确定性渲染：只依赖 t。
import { clamp, lerp, seg, ss, eio, eo, ei, back, hash, TAU } from '/core/lib.js';
import * as T from './engine/toon.js';
import { INK, W, H, push, pop, translate, rotate, scale, shape, fillOnly, stroke, ell, rr, rect, dot, text, screenRect, spline } from './engine/toon.js';
import { tall, short, cashier, popsicle, hand, PAL } from './chars.js';
import { aisleBack, targetDoor, doorPanel, vapor, portalRim, universeField, star4, checkoutBack, counter, register, bag, swirl, UP, AP, CP } from './scenes.js';
import { FPS, BF, B, bt, DUR, SHOTS, HIT, SECTIONS } from './timeline.js';

const cv = document.getElementById('c'); T.init(cv); const g = T.g;
const F = b => Math.round(b * BF) / FPS;           // 非拍点拟音也对齐到帧
const tw = t => Math.floor(t * 12 + 1e-6) / 12;    // 角色一拍二（12 fps）

// —— 关键帧插值：keys = [[拍, {属性}], …]，属性向后继承；数字/数组/对象逐项缓动 ——
function resolve(keys) { const out = []; let cur = {}; for (const [b, o] of keys) { cur = deep(cur, o); out.push([b, cur]); } return out; }
function deep(a, b) { const r = { ...a }; for (const k in b) r[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deep(a[k] || {}, b[k]) : b[k]; return r; }
function mix(a, b, u) {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, u);
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => mix(v, b[i], u));
  if (a && b && typeof a === 'object') { const r = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) r[k] = k in a && k in b ? (STEP.has(k) ? (u < 1 ? a[k] : b[k]) : mix(a[k], b[k], u)) : (k in b ? b[k] : a[k]); return r; }
  return u < 1 ? a : b;
}
const STEP = new Set(['face', 'blink', 'helmet']);
function K(tb, R) {
  if (tb <= R[0][0]) return R[0][1];
  for (let i = 0; i < R.length - 1; i++) if (tb < R[i + 1][0]) { const u = eio((tb - R[i][0]) / (R[i + 1][0] - R[i][0])); return mix(R[i][1], R[i + 1][1], u); }
  return R[R.length - 1][1];
}

// —— 世界位置 ——
const FEET = 80, SX = -250, TX = 360, DOOR_C = [0, -355];
// 门的角度（拍）：开门在拍点到达全开；关门在拍点砸上
const OPEN = 1.78;
function doorAng(b) {
  const open = (b0, dur = .3) => { const u = seg(b, b0 - dur, b0); return u <= 0 ? null : OPEN * back(u, 1.2); };
  if (b < 6.7) return 0;
  if (b < HIT.slam1) return open(HIT.open1, .35) ?? 0;
  if (b < 9.6) return 0;
  if (b < HIT.slam2) return open(HIT.open2, .22) ?? 0;
  if (b < 13.72) return 0;
  if (b < HIT.open3) return lerp(0, .32, seg(b, 13.72, 14));        // 裂开一条缝，光漏出来
  return OPEN;
}
const doorShake = (t, b) => { let s = 0; for (const h of [HIT.slam1, HIT.slam2]) { const d = t - bt(h); if (d >= 0 && d < .4) s += 9 * Math.exp(-d * 12) * Math.sin(d * 70); } return s; };

// —— 表演（拍）——
const SH = resolve([
  [0, { face: 1, yOff: 0, x: -205, lean: .08, look: [1, -.1], lid: .1, pupil: 4, mouth: { o: .12, w: .9, sm: .7 }, brow: .6, handR: [112, -170], handL: [92, -230], puff: 0, sq: 1, eyeS: 1, gripR: 0, sweat: 0, jit: [0, 0], legs: [0, 0] }],
  [1.2, { x: -200, sq: .97, handR: [116, -176] }],
  [2.4, { x: -205, sq: 1.02 }],
  [3.4, { x: -250, lean: 0, look: [1, -.5], handR: [100, -120], handL: [-110, -70], mouth: { o: .2, sm: .9 } }],
  [4, { handR: [176, -250], look: [1, -.6], mouth: { o: .45, w: .8, sm: .9 }, brow: .9 }],
  [5, { handR: [120, -100], look: [1, -.2], mouth: { o: .08, sm: .8 } }],
  [5.6, { x: -235, handR: [150, -300], gripR: 0, look: [1, -.7] }],
  [6, { handR: [128, -332], gripR: 1, lean: .05 }],
  [6.7, { lean: -.06, sq: .96 }],
  [7, { handR: [40, -230], gripR: 1, lean: -.18, sq: 1.04, look: [1, -.3], mouth: { o: .6, w: .9, sm: 1 }, brow: 1, eyeS: 1.1 }],
  [7.6, { lean: -.05, sq: 1, gripR: 0, handR: [90, -140] }],
  [8.5, { mouth: { o: .0, sm: -.7 }, brow: -.6, eyeS: 1, look: [1, .1], lid: .25 }],
  [9, { x: -230, handR: [150, -180], gripR: 0, lean: .1, mouth: { o: 0, sm: -.8 }, brow: -.9, lid: .2 }],
  [9.6, { handR: [128, -332], gripR: 1, lean: .02 }],
  [10, { handR: [36, -230], lean: -.2, sq: 1.05, mouth: { o: .5, sm: .9 }, brow: 1, eyeS: 1.08, lid: 0 }],
  [10.5, { lean: -.05, sq: 1, gripR: 0, handR: [90, -150], mouth: { o: .05, sm: -.4 }, brow: -.3, eyeS: 1 }],
  [11, { mouth: { o: .18, w: .7, sm: -.9 }, brow: 1, lid: .05, sweat: 1, look: [.2, .3], jit: [2, 1] }],
  [11.9, { mouth: { o: .1, w: .7, sm: -1 }, look: [1, .1] }],
  [12, { x: -230, handR: [150, -190], gripR: 0, lean: .08, mouth: { o: 0, sm: -.6 }, brow: -.4, sweat: 0, jit: [0, 0], look: [1, 0], lid: .1 }],
  [12.6, { look: [1, -.8], brow: .7, mouth: { o: .05, sm: -.2 } }],
  [13, { puff: 0, look: [1, -.8] }],
  [13.45, { puff: 1, lid: .45, sq: 1.04, handR: [128, -332], gripR: 1, look: [1, -.2], mouth: { o: 0, sm: 0, w: .6 } }],
  [13.75, { puff: .2, lid: 0, handR: [60, -250], lean: -.12, sq: 1 }],
  [14, { puff: 0, handR: [50, -230], gripR: 0, lean: -.1 }],
  [15.99, { face: 1, yOff: 0 }],
  [16, { face: -1, x: 175, yOff: 0, lean: .1, look: [1, -.35], pupil: 2.2, eyeS: 1.14, mouth: { o: .55, w: .75, sm: -.2 }, brow: 1.1, lid: 0, jit: [1.8, 1.2], handR: [118, -118], handL: [-152, -96], gripL: 1, legs: [6, -6] }],
  [18.7, { mouth: { o: .55, w: .75, sm: -.2 } }],
  [18.9, { mouth: { o: 0, w: .6, sm: -.3 } }],
  [19, { sq: .92 }], [19.35, { sq: 1.02 }], [19.6, { sq: 1 }],
  [21, { lean: -.05 }],
  [21.5, { lean: -.3, mouth: { o: .95, w: 1, sm: -.4 }, jit: [5, 4], handR: [120, -230], handL: [-70, -280], gripL: 0, legs: [-30, 10] }],
  [22, { lean: -.2, legs: [30, -20] }],
]);
const TL = resolve([
  [0, { x: 360, lean: 0, lid: .5, look: [-.4, .1], brow: 0, mouth: { o: 0, w: 1, sm: -.1 }, blink: false, tilt: 0, shrug: 0, handR: [46, -248], handL: [-46, -248], scarfWind: [0, 0], antWind: 0, jit: [0, 0], legs: [0, 0] }],
  [1.4, { tilt: .04 }],
  [1.8, { blink: true, mouth: { o: .4, w: .8, sm: 0 }, tilt: -.1, handR: [70, -460] }],
  [2.4, { mouth: { o: 1, w: .9, sm: 0 }, tilt: -.14 }],
  [3.1, { blink: false, mouth: { o: 0, w: 1, sm: -.1 }, tilt: 0, handR: [46, -248] }],
  [3.8, { lid: .5, look: [.8, .2] }],
  [4, { shrug: -.6, lid: .62, look: [.2, .3] }],
  [4.6, { shrug: 0 }],
  [6, { look: [1, .1], lid: .5 }],
  [8, { look: [1, .1] }],
  [8.8, { look: [-.7, .25] }],
  [10, { look: [1, .15] }],
  [12.6, { look: [-.9, 0] }],
  [13, { shrug: 1, handR: [96, -300], handL: [-90, -300], brow: .3, mouth: { o: 0, sm: -.3 } }],
  [13.7, { shrug: 0, handR: [46, -248], handL: [-46, -248], brow: 0, look: [1, .1] }],
  [15.99, { handR: [46, -248], handL: [-46, -248] }],
  [16, { lid: .28, brow: 1, look: [1, -.05], mouth: { o: .12, w: .5, sm: -.2 }, handR: [52, -244], handL: [-44, -246], gripR: 0 }],
  [21, { lean: 0, scarfWind: [0, 0], antWind: 0 }],
  [21.5, { lean: .2, scarfWind: [120, -150], antWind: 30, lid: .1, mouth: { o: .2, w: .5, sm: -.3 }, handR: [90, -330], handL: [80, -380], gripR: 0, jit: [2, 1] }],
  [22, { scarfWind: [220, -300], antWind: 50 }],
]);

// 角色在吸入段（b22→b23）被拉向门心
function sucked(base, tb, sx0, scaleEnd = .22) {
  const k = ei(seg(tb, HIT.lift, HIT.wipe));
  if (k <= 0) return base;
  const x = lerp(base.x, DOOR_C[0], k), y = lerp(base.y, DOOR_C[1] + 120, k);
  return { ...base, x, y, s: lerp(1, scaleEnd, k), stx: 1 + k * 1.1, rot: sx0 * k * 1.4 };
}

// —— 摄影机 ——
const C = (x, y, z, r = 0, sx = 0, sy = 0) => ({ x, y, z, r, sx, sy });
function camera(id, t, b) {
  switch (id) {
    case 'aisle': return C(lerp(-1150, 40, eo(seg(b, 0, 4.2))), -300, .96 + .12 * ss(seg(b, 3.6, 6)));
    case 'door': {
      // 开门 #2 后（b10.75→b11）甩镜向左
      const wp = seg(b, 10.72, 11), wx = -620 * ei(wp);
      return C(10 + wx, -300, 1.22, 0, doorShake(t, b) * 1.6, 0);
    }
    case 'tallCU': return C(354, -470, lerp(2.45, 2.6, seg(b, 8, 9)));
    case 'shortCU': { const u = seg(b, 11, 11.6); return C(-250 - 90 * (1 - eo(u)) + 18 * Math.sin(u * Math.PI) * (1 - u), -70, 2.55); }
    case 'hesitate': return C(20, lerp(-300, -320, ss(seg(b, 12, 14))), lerp(1.22, 1.42, ss(seg(b, 12, 14))), 0, doorShake(t, b) * 1.6, 0);
    case 'insert': { const d = t - bt(HIT.open3), k = 26 * Math.exp(-d * 5); return C(0, -355, lerp(2.9, 3.15, seg(b, 14, 16)), 0, k * Math.sin(d * 63), k * .7 * Math.cos(d * 51)); }
    case 'react': return C(250, -250, 1.72);
    case 'dead': return C(lerp(90, 120, seg(b, 17, 21)), lerp(-330, -350, seg(b, 17, 21)), lerp(1.08, 1.2, seg(b, 17, 21)));
    case 'suck': {
      const u = seg(b, 21, 23), anti = Math.sin(clamp(seg(b, 21, 21.6)) * Math.PI) * .07;
      const z = 1.2 * Math.pow(6.5 / 1.2, ei(u)) - anti;
      const d = t - bt(HIT.inhale), k = 10 * Math.exp(-d * 3);
      return C(lerp(120, DOOR_C[0], ss(u)), lerp(-350, DOOR_C[1], ss(u)), z, ei(u) * .5, k * Math.sin(d * 60), k * Math.cos(d * 47));
    }
    case 'inside': return C(0, 0, lerp(1.05, .86, eo(seg(b, 24, 26.2))), lerp(.32, -.04, eo(seg(b, 24, 26.4))));
    case 'belt': return C(lerp(-170, -90, seg(b, 27, 29)), -210, 1.0);
    case 'scan': return C(300, -195, 2.45);
    case 'end': {
      const u = ss(seg(b, 32, 36.46)), pk = blinkPush(t);
      return C(lerp(620, 330, u) + 260 * pk, lerp(-330, -370, u) + 40 * pk, lerp(1.3, 1.0, u) * (1 + .07 * pk));
    }
  }
  return C(0, -300, 1);
}
// b35 眨眼：2 帧推上去（24 fps，逐帧），再用 ~0.4 s 松回
function blinkPush(t) { const d = t - bt(HIT.blink); if (d < 0) return 0; return d < 2 / FPS ? d / (2 / FPS) : Math.exp(-(d - 2 / FPS) * 5); }
const doorFlash = t => { const d = t - bt(HIT.blink); return d < 0 ? 0 : Math.exp(-d * 4.5); };
function applyCam(c) { T.reset(); translate(W / 2 + c.sx, H / 2 + c.sy); scale(c.z); rotate(c.r); translate(-c.x, -c.y); }

// —— 文字（readcheck）——
let BOXES = [];
function boxOf(x0, y0, x1, y1) { const a = T.tx(x0, y0), b = T.tx(x1, y1), c = T.tx(x0, y1), d = T.tx(x1, y0); const xs = [a[0], b[0], c[0], d[0]], ys = [a[1], b[1], c[1], d[1]]; return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; }

// —— 场景绘制 ——
function shotAt(b) { let s = SHOTS[0]; for (const x of SHOTS) if (b >= x[0] - 1e-9) s = x; return s; }

function drawSign(t) {
  const sw = Math.sin(t * 2.2) * .03;
  // 吊牌挂在 x=-440、底边 y≈-569：在 door / hesitate / dead 三个双人机位里整块都在画内（四边留 ≥40 px），不再被画框切成半截字
  const SY = 355;
  push(); translate(-440, -1020); rotate(sw);
  stroke([[-100, 0], [-100, SY]], 4); stroke([[100, 0], [100, SY]], 4);
  shape(rr(-150, SY, 300, 96, 18), { fill: AP.sign, lw: 7, shade: () => fillOnly(rect(-160, SY + 72, 320, 30), '#e2cc96', { boil: .3 }) });
  text('冷冻食品', 0, SY + 50, { font: '900 58px "Noto Sans SC"', fill: INK });
  BOXES.push({ id: 'sign', text: '冷冻食品', ...boxOf(-150, SY, 150, SY + 96) });
  pop();
}

function tallPose(tb) { const p = K(tb, TL); return { ...p, face: -1, y: FEET }; }
function shortPose(tb) {
  const p = K(tb, SH); const jit = p.jit || [0, 0], f = Math.floor(tb * BF / 2);
  return { ...p, y: FEET + (p.yOff || 0), jit: [(hash(f * 1.3) - .5) * 2 * jit[0], (hash(f * 2.7) - .5) * 2 * jit[1]] };
}
function withJit(p, tb) { const j = p.jit || [0, 0], f = Math.floor(tb * BF / 2); return { ...p, jit: [(hash(f * 3.1 + 7) - .5) * 2 * j[0], (hash(f * 1.9 + 2) - .5) * 2 * j[1]] }; }

// 冷冻柜走廊里的所有镜头
function aisleScene(t, b, id) {
  const tb = tw(t) / B;              // 角色时间（12 fps）
  const cam = camera(id, t, b);
  applyCam(cam);
  aisleBack(t, { camx: cam.x });
  if (id === 'suck') { push(); drawSignNoBox(t); pop(); } else drawSign(t);
  const ang = doorAng(b);
  const uni = b >= HIT.open3 - .3;
  const inner = targetDoor(t, ang, uni ? 'universe' : 'ice', { spin: id === 'suck' ? ei(seg(b, 21, 23)) * 3 : 0 });
  const glowK = uni ? (b < HIT.open3 ? seg(b, 13.72, 14) * .6 : 1) : 0;
  if (glowK > 0) portalRim(id === 'dead' ? bt(HIT.cut1) : t, glowK, { drips: id !== 'dead' });
  doorPanel(ang, doorShake(t, b));
  // 矮胖贴着玻璃哈出的雾（一拍二地一大一小）
  if (b < 3.4) { const br = .8 + .25 * Math.sin(tw(t) * 7); shape(T.ell(-100, -96, 46 * br, 34 * br, 20), { fill: `rgba(255,255,255,${.7 * (1 - seg(b, 2.6, 3.4))})`, lw: 4, line: 'rgba(160,170,190,.6)' }); }
  // 冷气
  if (!uni) { if (b >= HIT.open1 - .3 && b < HIT.slam1) vapor(t, bt(HIT.open1) - .1); if (b >= HIT.open2 - .2 && b < HIT.slam2) vapor(t, bt(HIT.open2) - .08); }
  // 角色
  let sp = shortPose(tb), tp = withJit(tallPose(tb), tb);
  if (id === 'suck') { sp = sucked(sp, tb, 1); tp = sucked(tp, tb, -1, .2); }
  if (id === 'suck' && tb >= HIT.lift) { tall(tp); short(sp); } else { tall(tp); short(sp); }
  // 冰青平涂洗色（门开着时）
  if (glowK > 0) { screenRect(UP.glow, .055 * glowK); }
  if (id === 'suck') windLines(t, b);
  // 冷场时把光固定（冻住）
  return cam;
}
function drawSignNoBox(t) { const save = BOXES.length; drawSign(t); BOXES.length = save; }

// 宇宙内部
function insideScene(t, b) {
  const cam = camera('inside', t, b); applyCam(cam);
  universeField(t, 0, 0, 900, { spin: (t - bt(HIT.inside)) * .25 });
  const tb = tw(t) / B, d = tw(t) - bt(HIT.inside);
  const frozen = b >= HIT.freeze;
  const spit = ei(seg(tb, HIT.spit, HIT.land));
  // 位置
  const tpos = [lerp(-560, -190, eo(seg(tb, 24, 25))), lerp(-360, -30, eo(seg(tb, 24, 25)))];
  const spos = [lerp(560, 200, eo(seg(tb, 24, 25))), lerp(320, 40, eo(seg(tb, 24, 25)))];
  if (!frozen) {
    // 冻结前：冰屑向身体汇聚
    const conv = seg(tb, 24.6, 25);
    tall({ ...TALLSCREAM, x: tpos[0], y: tpos[1] + 300, s: .85, rot: d * 2.6, face: -1 });
    short({ ...SHORTSCREAM(tb), x: spos[0], y: spos[1] + 132, s: 1.05, rot: -d * 3.2, face: 1 });
    if (conv > 0) for (const [p, n] of [[tpos, 0], [spos, 1]]) for (let i = 0; i < 8; i++) {
      const a = i / 8 * TAU + n, r = lerp(320, 70, conv);
      const px = p[0] + Math.cos(a) * r, py = p[1] + Math.sin(a) * r;
      shape([[px, py - 18], [px + 12, py + 10], [px - 12, py + 10]], { fill: '#e9e6fb', lw: 4 });
    }
  } else {
    const k = tb - HIT.freeze, sq = 1 + .22 * Math.exp(-k * 5) * Math.cos(k * 14);
    const bob = Math.sin(t * 3) * 10, sc = lerp(1.55, 5.5, spit);
    const rotT = lerp(-.25 + Math.sin(t * 2) * .05, -.05, spit), rotS = lerp(.3 - Math.sin(t * 2.3) * .05, .05, spit);
    const tP = [lerp(tpos[0], -260, spit), lerp(tpos[1] + bob, 60, spit)], sP = [lerp(spos[0], 260, spit), lerp(spos[1] - bob, 60, spit)];
    // 冻结瞬间：白色平涂冲击环
    const fl = seg(tb, HIT.freeze, HIT.freeze + .6);
    if (fl < 1) for (const [p, n] of [[tpos, 0], [spos, 1]]) for (let i = 0; i < 10; i++) {
      const a = i / 10 * TAU + n * .3, r0 = 150 + fl * 260, r1 = r0 + 70 * (1 - fl);
      shape([[p[0] + Math.cos(a - .06) * r0, p[1] + Math.sin(a - .06) * r0], [p[0] + Math.cos(a) * r1, p[1] + Math.sin(a) * r1], [p[0] + Math.cos(a + .06) * r0, p[1] + Math.sin(a + .06) * r0]], { fill: '#ffffff', lw: 4 });
    }
    push(); translate(tP[0], tP[1]); scale(sc * sq, sc / sq); popsicle(0, 0, rotT, 1.05, () => insideTall(false), { crack: 1 }); pop();
    push(); translate(sP[0], sP[1]); scale(sc / sq, sc * sq); popsicle(0, 0, rotS, 1.05, () => insideShort(), { crack: 1 }); pop();
  }
  // 速度线（弹出时）
  if (spit > 0) speedLines(t, spit);
  return cam;
}
const TALLSCREAM = { lid: .5, look: [1, 0], brow: 1, mouth: { o: .15, w: .5, sm: -.3 }, handR: [100, -380], handL: [-100, -360], scarfWind: [-120, -200], antWind: -30, shrug: .4 };
const SHORTSCREAM = tb => ({ lid: 0, pupil: 2, eyeS: 1.15, look: [0, -.3], brow: 1.2, mouth: { o: .95, w: 1, sm: -.4 }, handR: [150, -260], handL: [-150, -250], jit: [(hash(Math.floor(tb * 6.5)) - .5) * 8, 0], sweat: 1 });
// 冰棍里的角色（冰块中心为原点，冰块之外被裁掉）
function insideTall(blink) {
  const P = T.shape(T.rr(-75, -105, 150, 210, 46), { stroke: false });
  T.g.save(); T.g.clip(P);
  fillOnly(T.rect(-200, -200, 400, 400), '#c9c3ea', { boil: .2 });
  push(); scale(.6); tall({ x: 0, y: 531, face: -1, lid: .55, blink, look: [1, .05], brow: 0, mouth: { o: 0, sm: -.15 }, handR: [46, -248], handL: [-46, -248] }); pop();
  T.g.restore();
}
function insideShort() {
  const P = T.shape(T.rr(-75, -105, 150, 210, 46), { stroke: false });
  T.g.save(); T.g.clip(P);
  fillOnly(T.rect(-200, -200, 400, 400), '#f1c9bd', { boil: .2 });
  push(); scale(.6); short({ x: 0, y: 160, face: 1, lid: 0, pupil: 2, eyeS: 1.15, look: [0, -.3], brow: 1.2, mouth: { o: .95, w: 1, sm: -.4 }, handR: [150, -260], handL: [-150, -250] }); pop();
  T.g.restore();
}
function windLines(t, b) {
  const k = seg(b, 21, 22.2); if (k <= 0) return;
  const c = T.tx(DOOR_C[0], DOOR_C[1]);
  g.setTransform(1, 0, 0, 1, 0, 0); const save = T.getM(); T.reset();
  for (let i = 0; i < 26; i++) {
    const a = hash(i * 2.9) * TAU, ph = ((t * 2.4 + hash(i * 5.1)) % 1);
    const r0 = lerp(1300, 140, ph), r1 = r0 + 160 + 200 * k;
    stroke([[c[0] + Math.cos(a) * r0, c[1] + Math.sin(a) * r0], [c[0] + Math.cos(a) * r1, c[1] + Math.sin(a) * r1]], 6, { line: `rgba(255,255,255,${.8 * k * (1 - ph * .5)})`, boil: .3 });
  }
  T.setM(save);
}
function speedLines(t, k) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  T.reset();
  for (let i = 0; i < 22; i++) {
    const a = hash(i * 3.3) * TAU, r0 = 300 + hash(i * 1.1) * 300 + (1 - k) * 200, r1 = r0 + 260 + k * 300;
    stroke([[W / 2 + Math.cos(a) * r0, H / 2 + Math.sin(a) * r0], [W / 2 + Math.cos(a) * r1, H / 2 + Math.sin(a) * r1]], 7, { line: 'rgba(255,255,255,.85)' });
  }
}

// 收银台
const CASH = { x: 470, y: 0 };
const POP_W = 150, POP_H = 210;
function checkoutScene(t, b, id) {
  const cam = camera(id, t, b); applyCam(cam);
  checkoutBack(t, { flash: id === 'end' ? doorFlash(t) : 0 });
  const tb = tw(t) / B;
  const beltOff = Math.max(0, tw(t) - bt(HIT.land)) * 140;
  counter(t, beltOff);
  // 收银机屏幕
  const reg = register(t, 0);
  // 收银员表演
  const chew = Math.sin(tw(t) * TAU * 1.6), base = { ...CASH, lid: .58, look: [-.6, .2], chew, gripR: 0 };
  let cp = { ...base };
  // 冰棍
  const land = HIT.land;
  if (id === 'belt') {
    const L = (k) => { const tl = bt(land) + k * .25, d = Math.max(0, tw(t) - tl); return { x: -820 + k * 330 + d * 140, bounce: -Math.abs(Math.sin(d * 18)) * 40 * Math.exp(-d * 7), on: tw(t) >= tl - 1e-6 }; };
    const p1 = L(0), p2 = L(1);
    // 收银员伸手去拿第一根（b28.3→b29）
    const reach = ss(seg(tb, 28.2, 29));
    cp = { ...cp, look: lerp(-.6, -1, reach) > -1 ? [-.9, .5] : [-1, .5], handR: [lerp(150, p2.x - CASH.x + 80, reach * 0), -10], handL: [lerp(-150, p1.x - CASH.x + 40, reach), lerp(-10, -60, reach)], gripL: reach > .9 ? 1 : 0 };
    cashier(cp);
    if (p2.on) popsicle(p2.x, -46 - 76 + p2.bounce, -Math.PI / 2, 1, () => insideTall(false));
    if (p1.on) popsicle(p1.x, -46 - 76 + p1.bounce, -Math.PI / 2, 1, () => insideShort());
    if (reach > .9) hand(p1.x + 40, -60, Math.PI, 24, PAL.cSkin, { grip: 1 });
  } else if (id === 'scan') {
    // 拿着冰棍从左到右划过扫码玻璃：b30 第一根过红线，b31 第二根过红线
    const cross = 285;
    const path = (b0) => { const u = (tb - b0); return lerp(cross - 120, cross + 120, clamp((u + .5) / 1)); };
    const first = tb < 30.55;
    const px = first ? path(30) : path(31), py = -215 - 40 * Math.sin(clamp(first ? tb - 29.5 : tb - 30.5) * Math.PI) * .4;
    const vis = first ? tb >= 29 : tb >= 30.5 && tb < 31.7;
    const handAt = [px + 6, py + POP_H / 2 + 80];
    // 冰棍还没拿起的那两帧：袖子只伸到空手所在处（不让袖子越过手）
    cp = vis ? { ...cp, look: [-.8, .4], handL: [handAt[0] - CASH.x, handAt[1]], hideHandL: true }
             : { ...cp, look: [-.8, .4], handL: [handAt[0] + 120 - CASH.x, handAt[1]], hideHandL: false, gripL: 0 };
    cashier(cp);
    // 红光闪（哔）
    for (const hb of [HIT.beep1, HIT.beep2]) { const d = t - bt(hb); if (d >= 0 && d < .25) { const k = 1 - d / .25; fillOnly([[178, -40], [392, -40], [402, -6], [168, -6]], `rgba(255,120,110,${.55 * k})`, { boil: .3 }); stroke([[cross - 120, -24], [cross + 120, -24]], 5, { line: '#ffe1dc', boil: .2 }); for (const s of [-1, 1]) stroke([[cross, -40], [cross + s * 120, -330]], 4, { line: `rgba(255,59,48,${.9 * k})`, boil: .2 }); } }
    if (vis) {
      popsicle(px, py, first ? .04 : -.03, 1, first ? () => insideShort() : () => insideTall(false));
      hand(handAt[0], handAt[1] - 30, -Math.PI / 2, 26, PAL.cSkin, { grip: 1 });
    }
  } else { // end
    const gum = seg(tb, 33, HIT.pop), popd = tb >= HIT.pop;
    cp = { ...cp, look: [.1, .1], gum: popd ? 0 : gum, pop: popd ? 1 : 0, chew: popd ? chew : (gum > 0 ? 0 : chew), handR: [120, -10], handL: [-140, -10] };
    cashier(cp);
    // 袋子里的两根冰棍
    const blink = tb >= HIT.blink && tb < HIT.blink + .35;
    popsicle(1135, -318, .12, 1.15, () => insideShort());
    popsicle(1030, -340, -.1, 1.15, () => insideTall(blink));
    bag(1090, -24, true);
    if (blink) { const k = 1 - (tb - HIT.blink) / .35; star4(985, -430, 26 + 22 * k, '#ffffff'); star4(1062, -262, 12 + 10 * k, '#ffffff'); }
    // 屏幕：合计 ¥5.00（12 fps 步进弹出）
    const st = Math.floor((t - bt(HIT.total)) * 12 + 1e-6);
    if (st >= 0) {
      const sc = [.4, 1.25, .92, 1.04, 1][Math.min(st, 4)];
      push(); translate(reg.sx, reg.sy); scale(sc);
      text('合计', -82, 2, { font: '900 40px "Noto Sans SC"', fill: CP.amber });
      text('¥5.00', 40, 4, { font: '400 68px "VT323"', fill: CP.amber });
      pop();
      BOXES.push({ id: 'total', text: '合计 ¥5.00', ...boxOf(reg.sx - 140, reg.sy - 50, reg.sx + 140, reg.sy + 50) });
    }
  }
  return cam;
}

// —— 主渲染 ——
function render(t) {
  t = clamp(t, 0, DUR - 1e-6);
  T.frame(t); BOXES = [];
  const b = t / B, [b0, id] = shotAt(b);
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#efe2c4'; g.fillRect(0, 0, W, H);
  if (['aisle', 'door', 'tallCU', 'shortCU', 'hesitate', 'insert', 'react', 'dead', 'suck'].includes(id)) aisleScene(t, b, id);
  else if (id === 'wipe') {
    const u = seg(b, HIT.wipe, HIT.inside), c = u < .5 ? eo(u * 2) : 1 - ei((u - .5) * 2);
    if (u < .5) { aisleScene(t, b, 'suck'); } else insideScene(t, b);
    T.reset(); swirl(Math.max(c, .001), -t * 9);
  }
  else if (id === 'inside') insideScene(t, b);
  else checkoutScene(t, b, id);
  // 甩镜速度线
  if (id === 'door' && b > 10.72) { T.reset(); const k = seg(b, 10.72, 11); for (let i = 0; i < 26; i++) { const y = hash(i * 7.7) * H, x = hash(i * 3.1) * W; stroke([[x - 300 * k, y], [x + 300 * k, y]], 8, { line: 'rgba(27,20,34,.55)', boil: .2 }); } }
  if (id === 'shortCU' && b < 11.25) { T.reset(); const k = 1 - seg(b, 11, 11.25); for (let i = 0; i < 20; i++) { const y = hash(i * 5.7) * H, x = hash(i * 2.1) * W; stroke([[x - 260 * k, y], [x + 260 * k, y]], 8, { line: `rgba(27,20,34,${.5 * k})`, boil: .2 }); } }
}

// —— 事件（拟音 + 拍点）——
const EV = [];
const cue = (name, b, extra = {}) => EV.push({ t: bt(b), type: name, beat: b, cue: true, ...extra });
const fx = (name, b, extra = {}) => EV.push({ t: F(b), type: name, beat: b, ...extra });
EV.push({ t: 0, type: 'meta', B, BF, FPS, dur: DUR, hit: HIT, sections: SECTIONS, shots: SHOTS });
for (const [b, id] of SHOTS) if (b > 0) cue('cut', b, { shot: id });
fx('glass_squeak', .4); fx('glass_squeak', 1.3); fx('yawn', 1.8); cue('point', HIT.point); fx('sigh', 4.05);
fx('step', 5.2); fx('step', 5.55);
cue('grab', HIT.grab); cue('door_open', HIT.open1); fx('vapor', 7.1);
cue('cut_tall', HIT.cutTall); fx('eye_slide', 8.75);
cue('slam', HIT.slam1); fx('grab', 9.6); cue('door_open', HIT.open2, { fast: 1 }); fx('vapor', 10.05);
cue('whip', HIT.whip); fx('whimper', 11.1);
cue('slam', HIT.slam2); cue('shrug', HIT.shrug); fx('inhale_small', 13.0); fx('grab', 13.45); fx('creak', 13.72);
cue('door_open_big', HIT.open3); cue('react', HIT.react);
cue('music_cut', HIT.cut1); cue('gulp', HIT.gulp);
cue('suck', HIT.inhale); cue('lift', HIT.lift); fx('stretch', 22.1);
cue('swirl', HIT.wipe); cue('tumble', HIT.inside); fx('scream_squeak', 24.2);
fx('ice_form', 24.45); cue('freeze', HIT.freeze); cue('spit', HIT.spit);
cue('land', HIT.land); EV.push({ t: bt(HIT.land) + .25, type: 'land2', beat: HIT.land + .25 * 24 / BF });
cue('music_cut', HIT.cut2); fx('chew', 27.6); fx('chew', 28.2); fx('reach', 28.3); cue('pickup', HIT.pickup);
cue('beep', HIT.beep1); fx('swipe', 30.6); cue('beep', HIT.beep2); fx('set_down', 31.6);
cue('total', HIT.total); cue('laugh', HIT.laugh); fx('bubble', 33); cue('pop', HIT.pop); cue('blink', HIT.blink);
fx('chew', 32.6); fx('chew', 33.0); fx('chew', 34.6); fx('chew', 35.4);
EV.sort((a, b) => a.t - b.t);

window.DUR = DUR; window.EV = EV; window.render = render;
window.TEXTS = (t) => BOXES.map(x => ({ ...x }));
document.fonts.load('900 58px "Noto Sans SC"', '冷冻食品合计').then(() => document.fonts.load('400 78px "VT323"', '¥5.00')).then(() => document.fonts.ready).then(() => { render(0); window.READY = true; });
