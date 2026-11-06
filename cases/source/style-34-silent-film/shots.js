// 《追帽子》镜头：调子绘画（灰度），之后由 Redraw 上墨。全部由时间 T（手摇采样后的全片时间）决定，无状态。
// 一镜到底 oner() 用一个"世界 → 胶片"相机函数；光圈、跟拍都走它。
import { drawFigure, P0, mixPose, runPose, walkPose, runBob, walkBob, solve, projector, BODY } from './engine/figure.js';
import { form, stroke, catmull, grey, ellipsePts, rectPts } from './engine/ink.js';
import { sky, house, street, contactShadow, rnd } from './sets.js';
import { GENT, drawTopHat, drawMonkey, drawDog, drawTram, drawLadder, ladderPt, drawWall, drawKennel } from './chars.js';
import { HIT, SEC, at } from './timeline.js';
import { clamp, lerp, ss, eo, ei, seg, monotone, track } from '/core/lib.js';

export const FW = 1440, FH = 1080;
const EXPR = {
  deadpan: { open: .8, brow: 0, look: [0, 0] },
  polite: { open: .5, brow: .3, browA: -.3, smile: .5, look: [-.2, 0] },
  alarm: { open: 1.4, brow: 1.3, browA: .5, mouthOpen: .5, mouthW: .7 },
  up: { open: 1.0, brow: .6, look: [.3, -.8] },
  grim: { open: .65, brow: .4, browA: .5, smile: -.2 },
};
const withE = (p, e) => { p.expr = { ...e }; return p; };
// 关键帧姿势插值：keys = [[t, pose], …]，ease 默认 ss；pose 可为函数(t)
function poseAt(T, keys, ease = ss) {
  if (T <= keys[0][0]) return typeof keys[0][1] === 'function' ? keys[0][1](T) : keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [a, pa] = keys[i], [b, pb] = keys[i + 1];
    if (T < b) { const A = typeof pa === 'function' ? pa(T) : pa, B = typeof pb === 'function' ? pb(T) : pb; return mixPose(A, B, ease((T - a) / (b - a))); }
  }
  const l = keys[keys.length - 1][1]; return typeof l === 'function' ? l(T) : l;
}

// ---------------- 绅士的姿势 ----------------
const P = {
  walk: ph => withE(walkPose(ph), EXPR.deadpan),
  tip: () => { const p = P0(); p.lean = -.04; p.nod = -.08; p.headTurn = -.7; p.aR = { fl: 2.0, abd: 1.05, el: .75, wr: .2, hand: 'grip' }; p.aL = { fl: .05, abd: .05, el: .3, wr: .1, hand: 'relax' }; return withE(p, EXPR.polite); },
  empty: () => { const p = P0(); p.lean = -.12; p.nod = -.32; p.headTurn = -.2; p.aR = { fl: 2.2, abd: 1.0, el: .5, wr: .2, hand: 'open' }; p.aL = { fl: .1, abd: .2, el: .5, wr: .1, hand: 'open' }; return withE(p, EXPR.up); },
  take: () => { const p = P0(); p.lean = .05; p.nod = .1; p.headTurn = .25; p.aR = { fl: 1.4, abd: .6, el: 1.2, wr: 0, hand: 'open' }; p.aL = { fl: .6, abd: .4, el: 1.2, wr: 0, hand: 'open' }; p.L.knee = .3; p.R.knee = .2; return withE(p, EXPR.alarm); },
  crouch: () => { const p = P0(); p.lean = .45; p.nod = .1; p.aL = { fl: -.6, abd: .15, el: 1.0, wr: 0, hand: 'fist' }; p.aR = { fl: .7, abd: .15, el: 1.3, wr: 0, hand: 'fist' }; p.L = { hip: .9, abd: .05, knee: 1.25, ankle: .35 }; p.R = { hip: .2, abd: .05, knee: 1.1, ankle: .6 }; return withE(p, EXPR.grim); },
  run: (ph, k = 1) => withE(runPose(ph, k), EXPR.grim),
  reachLow: () => { const p = runPose(.3, .6); p.lean = .55; p.nod = .2; p.aR = { fl: 1.1, abd: .1, el: .2, wr: 0, hand: 'open' }; return withE(p, EXPR.grim); },
  bell: () => { const p = runPose(.1, .4); p.lean = .2; p.headTurn = -1.25; p.nod = -.05; p.aR = { fl: .9, abd: .2, el: .6, wr: 0, hand: 'open' }; return withE(p, EXPR.alarm); },
  hop: () => { const p = P0(); p.lean = -.25; p.nod = -.1; p.headTurn = -.6; p.L = { hip: 1.2, abd: .05, knee: 1.8, ankle: .3 }; p.R = { hip: .8, abd: .05, knee: 1.5, ankle: .3 }; p.aL = { fl: 1.9, abd: .7, el: .5, wr: 0, hand: 'open' }; p.aR = { fl: 2.0, abd: .8, el: .5, wr: 0, hand: 'open' }; return withE(p, EXPR.alarm); },
  stiff: () => { const p = P0(); p.lean = -.14; p.nod = -.12; p.headTurn = -.5; p.L = { hip: 0, abd: 0, knee: 0, ankle: 0 }; p.R = { hip: 0, abd: 0, knee: 0, ankle: 0 }; p.aL = { fl: -.05, abd: .02, el: 0, wr: 0, hand: 'open' }; p.aR = { fl: -.05, abd: .02, el: 0, wr: 0, hand: 'open' }; p.flutter = 1; return withE(p, { ...EXPR.alarm, open: 1.2 }); },
  lookUp: () => { const p = P0(); p.lean = -.1; p.nod = -.35; p.headTurn = .1; p.aR = { fl: .9, abd: .3, el: 1.2, wr: 0, hand: 'open' }; return withE(p, EXPR.up); },
  climb: k => { const p = P0(); const s = Math.sin(k * Math.PI); p.lean = .22; p.nod = -.25;
    p.L = { hip: 1.15 * (.5 + .5 * s), abd: .05, knee: 1.6 * (.5 + .5 * s), ankle: .2 }; p.R = { hip: 1.15 * (.5 - .5 * s), abd: .05, knee: 1.6 * (.5 - .5 * s), ankle: .2 };
    p.aL = { fl: 2.5 + .3 * s, abd: .12, el: .5, wr: 0, hand: 'grip' }; p.aR = { fl: 2.5 - .3 * s, abd: .12, el: .5, wr: 0, hand: 'grip' }; return withE(p, EXPR.up); },
  reach: () => { const p = P0(); p.lean = .3; p.nod = -.3; p.L = { hip: .9, abd: .05, knee: 1.3, ankle: .2 }; p.R = { hip: .1, abd: .05, knee: .3, ankle: .2 }; p.aL = { fl: 2.4, abd: .12, el: .6, wr: 0, hand: 'grip' }; p.aR = { fl: 2.75, abd: .25, el: .05, wr: .1, hand: 'open' }; return withE(p, EXPR.up); },
  grabbed: () => { const p = P.reach(); p.aR.hand = 'fist'; p.nod = -.15; p.expr = { ...EXPR.deadpan, look: [.4, -.2] }; return p; },
  wobble: ph => { const p = P0(); const s = Math.sin(ph * Math.PI * 2); p.lean = .1 * s; p.nod = -.1; p.L = { hip: .8, abd: .05, knee: 1.2, ankle: .2 }; p.R = { hip: .1, abd: .05, knee: .2, ankle: .2 };
    p.aL = { fl: 1.6 + 1.1 * s, abd: .9, el: .3, wr: 0, hand: 'open' }; p.aR = { fl: 1.6 - 1.1 * s, abd: .9, el: .3, wr: 0, hand: 'open' }; return withE(p, EXPR.alarm); },
  fly: () => { const p = P0(); p.lean = .1; p.nod = -.2; p.L = { hip: .6, abd: .5, knee: .9, ankle: 0 }; p.R = { hip: -.3, abd: .5, knee: .5, ankle: 0 }; p.aL = { fl: 1.6, abd: 1.4, el: .2, wr: 0, hand: 'open' }; p.aR = { fl: 1.6, abd: 1.4, el: .2, wr: 0, hand: 'open' }; p.flutter = 1; return withE(p, EXPR.alarm); },
  land: () => { const p = P.crouch(); p.lean = .35; p.aL = { fl: .3, abd: .5, el: .4, wr: 0, hand: 'open' }; p.aR = { fl: .3, abd: .5, el: .4, wr: 0, hand: 'open' }; return withE(p, EXPR.deadpan); },
  lookBack: () => { const p = P0(); p.lean = -.05; p.headTurn = -1.3; p.nod = .05; p.L.knee = .3; p.R.knee = .2; p.aR = { fl: 1.3, abd: .5, el: 1.3, wr: 0, hand: 'open' }; p.aL = { fl: 1.1, abd: .5, el: 1.3, wr: 0, hand: 'open' }; return withE(p, EXPR.alarm); },
};

// ---------------- 世界布局（世界像素） ----------------
export const WY = { sw: 900, lane: 1012, base: 772 };
const S_G = 60;                                     // 绅士：每头 60 世界像素（7.5 头 ≈ 450）
const LAD = { bx: 1770, by: 900, tx: 1985, ty: 440 };   // 梯子靠墙（静止时）
const WALL = { x0: 1990, x1: 2270, top: 420 };
const KEN = { x: 2290, w: 200 };
const T_NM = HIT.nearMiss, TRAM_V = 2400, TRAM_L = 1000;
const tramFront = T => 1440 + (T - T_NM) * TRAM_V;         // b4 时车头正到他刚离开的位置
const HAT_W = 58;

// 绅士位置（x, 脚底 y）
const GX = monotone([[0, 330], [1.0, 470], [1.5, 515], [2.0, 540], [HIT.run, 545], [HIT.tramIn, 1370], [HIT.tramIn + .2, 1395], [T_NM - .1, 1400], [T_NM, 1352], [HIT.hatWall, 1352], [HIT.rung1 - .05, 1735]]);
// near-miss：他从车道里向镜头一侧（近处路面 FRONT）跳开，电车贴着他的背扫过——人始终在电车前面、看得见；车尾过后再跳回人行道
const FRONT = 1150;
const GY = monotone([[0, WY.sw], [HIT.curb + .2, WY.sw], [HIT.tramIn, WY.lane - 8], [T_NM - .1, WY.lane - 8], [T_NM, FRONT], [HIT.tramOut + .05, FRONT], [HIT.hatWall - .1, WY.sw], [9, WY.sw]]);
const gentFront = T => T > T_NM - .1 && T < HIT.hatWall && GY(T) > WY.lane + 20;
// 爬梯：脚踩的梯段 u（0 底 → 1 顶）
const CLIMB_U = monotone([[HIT.rung1 - .05, 0], [HIT.rung1, .13], [HIT.rung2, .3], [HIT.rung3, .47], [HIT.grab, .52]]);
// 梯子相对墙的角度（0 = 靠墙静止；1 = 竖直）
function ladderTilt(T) {
  if (T < HIT.grab) return 0;
  if (T < HIT.wobble) return ss((T - HIT.grab) / (HIT.wobble - HIT.grab));           // 他伸手太猛，梯子离墙立起
  if (T < HIT.wobble + .22) return 1 + Math.sin((T - HIT.wobble) / .22 * Math.PI * 2) * .18 * (1 - (T - HIT.wobble) / .3);   // 前后晃
  if (T < HIT.wobble + .3) return lerp(1, -.05, ei((T - HIT.wobble - .22) / .08));      // 猛地拍回墙上
  return 0;
}
function ladderTop(T) {
  const k = ladderTilt(T), L = Math.hypot(LAD.tx - LAD.bx, LAD.ty - LAD.by), a0 = Math.atan2(LAD.tx - LAD.bx, LAD.by - LAD.ty), a = a0 * (1 - k);
  return [LAD.bx + Math.sin(a) * L, LAD.by - Math.cos(a) * L];
}
const T_FLING = HIT.wobble + .3;
// 小巷落点与追逐
const LAND_X = 2650;
const CHASE_V = 1350;
function gentChaseX(T) { return T < HIT.crank ? LAND_X + Math.max(0, T - HIT.bark - .25) * 60 : LAND_X + 25 + (T - HIT.crank) * CHASE_V + Math.pow(Math.max(0, T - HIT.crank), 2) * 120; }
function dogX(T) { return T < HIT.bark ? KEN.x + 230 : T < HIT.crank ? KEN.x + 230 + ss((T - HIT.bark) / (HIT.crank - HIT.bark)) * 120 : gentChaseX(T) - 210 + Math.sin((T - HIT.crank) * 9) * 25; }

// ---------------- 帽子 ----------------
// 返回 {mode:'head'|'hand'|'free', x, y(帽檐中心), rot}
function hatState(T) {
  if (T < HIT.tip - .15) return { mode: 'head' };
  if (T < HIT.gust) return { mode: 'hand' };
  const R = HAT_W * .41;
  if (T < HIT.land) {                                              // 被风从手里卷起，翻滚落地
    const u = (T - HIT.gust) / (HIT.land - HIT.gust), h0 = tipHand(), x = lerp(h0[0], 900, u), y = lerp(h0[1], WY.sw - 4, u * u) - Math.sin(u * Math.PI) * 120;
    return { mode: 'free', x, y, rot: u * 7.5 };
  }
  if (T < HIT.curb) { const x = lerp(900, 1440, (T - HIT.land) / (HIT.curb - HIT.land)); return { mode: 'free', x, y: WY.sw - 4 - Math.abs(Math.sin(x / 70)) * 16, rot: 7.5 + (x - 900) / R }; }
  const flick = T_NM + (1650 - 1440) / TRAM_V;                      // 车头排障器碰到帽子的时刻
  if (T < flick) {                                                  // 滚下路沿、滚到轨上停住
    const u = clamp((T - HIT.curb) / (HIT.tramIn + .15 - HIT.curb)), x = lerp(1440, 1650, eo(u)), drop = ss(clamp((T - HIT.curb) / .12));
    return { mode: 'free', x, y: lerp(WY.sw - 4, WY.lane - 6, drop) - Math.sin(clamp((T - HIT.curb) / .25) * Math.PI) * 30, rot: 7.5 + 540 / R + (x - 1440) / R + Math.sin(Math.max(0, T - HIT.tramIn) * 30) * .05 * (1 - u) };
  }
  if (T < HIT.hatWall) {                                            // 被电车掀起，越过车顶落上墙头
    const u = (T - flick) / (HIT.hatWall - flick), v = 1 - (1 - u) * (1 - u), x = lerp(1650, 2070, u), y = (1 - v) * (1 - v) * (WY.lane - 6) + 2 * v * (1 - v) * -260 + v * v * (WALL.top - 18);
    return { mode: 'free', x, y, rot: 7.5 + 750 / R + u * 9 };
  }
  const hop = HIT.grab - .125;                                      // 手合上前 3 帧，帽子跳走
  const restRot = Math.round((7.5 + 750 / R + 9) / (Math.PI * 2)) * Math.PI * 2;
  if (T < hop) return { mode: 'free', x: 2070, y: WALL.top - 18, rot: restRot + Math.sin(Math.max(0, T - HIT.rung3) * 26) * .08 };
  const LANDH = HIT.fall;
  if (T < LANDH) { const u = (T - hop) / (LANDH - hop), x = lerp(2070, 2960, u), y = lerp(WALL.top - 18, WY.sw - 4, u * u) - Math.sin(u * Math.PI) * 120; return { mode: 'free', x, y, rot: restRot + u * 6 }; }
  const x = T < HIT.crank ? 2960 + (T - LANDH) * 160 : 2960 + (HIT.crank - LANDH) * 160 + (T - HIT.crank) * 1650;
  return { mode: 'free', x, y: WY.sw - 4 - Math.abs(Math.sin(x / 60)) * 14, rot: restRot + 6 + (x - 2960) / R };
}

// ---------------- 相机（世界 → 胶片） ----------------
const CAM = track([
  [0, [540, 590, 1.38]], [1.0, [640, 588, 1.38]], [2.0, [720, 595, 1.3]], [HIT.run, [760, 605, 1.2]],
  [HIT.curb, [1200, 640, .86]], [HIT.tramIn, [1330, 650, .82]], [HIT.hatWall - .1, [1330, 650, .82]],   // 锁定大全景
  [HIT.rung1, [1640, 600, .92]], [HIT.rung3, [1880, 470, 1.06]], [HIT.wobble, [1920, 450, 1.06]],      // 横摇 + 升降
  [T_FLING, [2050, 470, .98]], [HIT.fall, [2480, 600, .95]], [HIT.crank, [2580, 615, 1.0]],
]);
export function camAt(T) {
  if (T >= HIT.crank) { const c = CAM(HIT.crank); return [Math.max(c[0], gentChaseX(T) + 60), 615, 1.0]; }   // 快速跟拍
  return CAM(T);
}
export const w2f = (T, x, y) => { const [cx, cy, z] = camAt(T); return [(x - cx) * z + FW / 2, (y - cy) * z + FH / 2]; };

// ---------------- 一镜到底：0 → 9.583 ----------------
export function oner(g, m, T) {
  const [cx, cy, z] = camAt(T);
  const setCam = (c, par = 1) => c.setTransform(z, 0, 0, z, FW / 2 - cx * par * z, FH / 2 - cy * z);
  setCam(m);
  // 天空
  g.setTransform(1, 0, 0, 1, 0, 0); sky(g, FW, FH * .7, 3, .92);
  // 远景屋顶（视差 .55）
  setCam(g, .55);
  for (let i = -2; i < 14; i++) { const x = i * 360 - 300, h = 380 + rnd(i, 4) * 160; form(g, rectPts(x, WY.base - 120 - h, 330, h + 40), { v: .8 + rnd(i, 2) * .08, line: 1.6, grad: .06, seed: 30 + i }); }
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = 'rgba(240,236,228,.45)'; g.fillRect(0, 0, FW, FH);   // 空气透视
  setCam(g);
  // 街边楼房（到墙为止）
  for (let i = 0; i < 8; i++) { const x = -420 + i * 300; if (x > WALL.x0 - 60) break; facade(g, x, 290, WY.base, i); }
  // 小巷后墙与后屋
  form(g, rectPts(WALL.x1, 420, 6000, WY.base - 420), { v: .46, line: 2.2, grad: .12, seed: 70 });
  g.strokeStyle = grey(.32, .5); g.lineWidth = 1.4; for (let yy = 450; yy < WY.base; yy += 34) { g.beginPath(); g.moveTo(WALL.x1, yy); g.lineTo(WALL.x1 + 6000, yy); g.stroke(); }
  for (let i = 0; i < 12; i++) { const x = WALL.x1 + 260 + i * 520; form(g, rectPts(x, 520, 90, 140), { v: .2, line: 2, grad: .2, seed: 71 + i }); stroke(g, [[x - 40, 470 + (i % 2) * 20], [x + 520 - 40, 470 + ((i + 1) % 2) * 20]], 1.6, { seed: 90 + i }); }
  // 人行道 + 路沿
  form(g, [[-1200, WY.base], [WALL.x0, WY.base], [WALL.x0, WY.sw + 6], [-1200, WY.sw + 6]], { v: .74, line: 2, grad: .08, seed: 81 });
  for (let x = -1200; x < WALL.x0; x += 150) stroke(g, [[x, WY.base], [x + 30, WY.sw + 6]], 1.2, { seed: 83, alpha: .5 });
  form(g, [[-1200, WY.sw + 6], [WALL.x0, WY.sw + 6], [WALL.x0, WY.sw + 34], [-1200, WY.sw + 34]], { v: .5, line: 2, seed: 82 });
  // 车道（卵石 + 轨道）
  g.save(); g.beginPath(); g.rect(-1200, WY.sw + 34, WALL.x0 + 1200, 600); g.clip(); g.translate(-1200, 0); street(g, WALL.x0 + 1200, WY.sw + 34, 1260, 0, 9, .58); g.restore();
  for (const ry of [WY.lane - 4, WY.lane + 44]) { form(g, [[-1200, ry], [WALL.x0, ry], [WALL.x0, ry + 9], [-1200, ry + 9]], { v: .88, line: 1.4, seed: 85 }); }
  // 小巷地面
  form(g, [[WALL.x0, WY.base], [WALL.x1 + 6000, WY.base], [WALL.x1 + 6000, 1300], [WALL.x0, 1300]], { v: .6, line: 0, seed: 86 });
  g.save(); g.beginPath(); g.rect(WALL.x1, WY.base, 6000, 600); g.clip(); g.translate(WALL.x1, 0); street(g, 6000, WY.base + 4, 1260, 0, 13, .56); g.restore();
  // 架空电车线
  stroke(g, [[-1200, 322], [WALL.x0 - 10, 322]], 2.2, { seed: 87 });
  // 墙墩 + 狗屋
  drawWall(g, WALL.x0, WALL.x1, WALL.top, WY.sw + 10);
  drawKennel(g, KEN.x, WY.sw - 30, KEN.w, 170);

  // 梯子
  const [ltx, lty] = ladderTop(T);
  drawLadder(g, LAD.bx, LAD.by, ltx, lty, 78, 8);

  // 帽子（在路上/墙上时画在人后面）
  const hs = hatState(T);
  const drawHatFree = () => { if (hs.mode !== 'free') return; setCam(m); contactShadow(g, hs.x, Math.max(hs.y, WY.sw) + 4, HAT_W * .6, 6, .25 * clamp(1 - (WY.sw - hs.y) / 300)); drawTopHat(g, hs.x, hs.y, HAT_W, hs.rot, m); };

  // 狗
  const dx = dogX(T), dogSleep = T < HIT.bark ? 1 : 0;
  const dogBark = T >= HIT.bark && T < HIT.crank ? Math.abs(Math.sin((T - HIT.bark) * 22)) : T >= HIT.crank ? .5 + .5 * Math.sin(T * 30) : 0;
  const dogHop = T >= HIT.bark && T < HIT.bark + .25 ? Math.sin((T - HIT.bark) / .25 * Math.PI) * 50 : 0;
  contactShadow(g, dx - 20, WY.sw + 4, 110, 10, .3);
  drawDog(g, dx, WY.sw - dogHop, 165, 1, T >= HIT.crank ? (T - HIT.crank) * 4.2 : 0, { sleep: dogSleep, bark: dogBark, run: T >= HIT.crank ? 1 : 0 });
  if (dogSleep) { g.save(); g.fillStyle = grey(.2); g.font = 'italic 900 34px serif'; g.globalAlpha = .7; g.fillText('z', dx + 40, WY.sw - 150 - (T * 40 % 40)); g.restore(); }

  const flick = T_NM + (1650 - 1440) / TRAM_V, hatOverTram = T > flick && T < HIT.hatWall;
  if (!hatOverTram) drawHatFree();

  // 绅士（near-miss 时他在电车前面：后画）
  if (!gentFront(T)) drawGent(g, m, T, hs);

  // 电车（前景车道，盖过他）
  const tf = tramFront(T);
  if (tf > -200 && tf - TRAM_L < WALL.x0 + 400 && T > HIT.tramIn - .4) {
    const lean = T < T_NM ? 0 : 0;
    contactShadow(g, tf - TRAM_L / 2, WY.lane + 40, TRAM_L * .55, 14, .35);
    drawTram(g, tf, WY.lane + 40, TRAM_L, 590, (tf / 34) % (Math.PI * 2));
    // 速度线（车尾的风）
    for (let k = 0; k < 5; k++) { const yy = WY.lane - 450 + k * 95; stroke(g, [[tf - TRAM_L - 40 - k * 30, yy], [tf - TRAM_L - 260 - k * 50, yy + 6]], 2, { seed: 860 + k, alpha: .55 }); }
    occlude(m, [[tf - TRAM_L, WY.lane + 40 - 600], [tf + 34, WY.lane + 40 - 600], [tf + 34, WY.lane + 60], [tf - TRAM_L, WY.lane + 60]]);
  }
  if (hatOverTram) drawHatFree();
  if (gentFront(T)) drawGent(g, m, T, hs);
  // 前景：小巷里的晾衣杆/木桩（视差 1.5，快速掠过）
  if (T > HIT.crank - .05) {
    const par = 1.6; g.setTransform(z, 0, 0, z, FW / 2 - cx * par * z, FH / 2 - cy * z); m.setTransform(z, 0, 0, z, FW / 2 - cx * par * z, FH / 2 - cy * z);
    for (let i = 0; i < 40; i++) { const x = 2900 * par + i * 1100; if (Math.abs(x - cx * par) > 1400) continue;
      const post = [[x - 18, 1300], [x + 18, 1300], [x + 14, 80], [x - 14, 80]];
      form(g, post, { v: .14, line: 2.4, grad: .2, seed: 880 + i, cyl: -Math.PI / 2 }); form(g, [[x - 26, 80], [x + 26, 80], [x + 22, 60], [x - 22, 60]], { v: .2, line: 2, seed: 881 }); occlude(m, post); }
  }
  g.setTransform(1, 0, 0, 1, 0, 0); m.setTransform(1, 0, 0, 1, 0, 0);
}

// 街面楼房：上层两排窗（高于人头），底层是浅色粉墙 + 一扇门，让深色礼服和礼帽永远压在浅墙上
function facade(g, x, w, yb, i) {
  const top = yb - 600 - rnd(i, 5) * 60, v = .74 + rnd(i, 3) * .12;
  form(g, [[x, top], [x + w, top], [x + w, yb], [x, yb]], { v, line: 2.4, grad: .1, seed: 50 + i });
  form(g, [[x - 14, top - 10], [x + w + 14, top - 10], [x + w + 6, top - 70], [x + 6, top - 70]], { v: .32, line: 2.2, seed: 60 + i, shade: 5 });
  form(g, rectPts(x - 16, top - 12, w + 32, 12), { v: .5, line: 1.6, seed: 61 + i });
  for (let r = 0; r < 2; r++) for (let k = 0; k < 2; k++) {
    const wx = x + w * (.25 + k * .5) - 26, wy = top + 40 + r * 120;
    form(g, rectPts(wx - 5, wy - 5, 62, 96), { v: .86, line: 1.4, seed: 62 + i * 9 + r * 2 + k });
    form(g, rectPts(wx, wy, 52, 86), { v: .2, line: 1.4, grad: .2, seed: 63 + i * 9 + r * 2 + k });
    stroke(g, [[wx + 26, wy], [wx + 26, wy + 86]], 2, { color: grey(.84), seed: 64 }); stroke(g, [[wx, wy + 40], [wx + 52, wy + 40]], 2, { color: grey(.84), seed: 65 });
  }
  stroke(g, [[x, top + 290], [x + w, top + 290]], 3, { color: grey(v - .2), seed: 66 + i });          // 腰线
  const dx = x + w * (.25 + rnd(i, 1) * .5) - 36;
  form(g, rectPts(dx, yb - 170, 72, 170), { v: .36, line: 2.2, grad: .15, seed: 67 + i, shade: 6 });
  form(g, [[dx - 8, yb - 178], [dx + 80, yb - 178], [dx + 80, yb - 170], [dx - 8, yb - 170]], { v: .8, line: 1.6, seed: 68 + i });
  form(g, rectPts(x, yb - 40, w, 40), { v: v - .14, line: 1.4, seed: 69 + i });                      // 勒脚
}

// 遮罩遮挡：前景物体挡住帽带时，把色彩遮罩擦掉
function occlude(m, pts) { m.save(); m.globalCompositeOperation = 'destination-out'; m.beginPath(); m.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) m.lineTo(p[0], p[1]); m.closePath(); m.fillStyle = '#000'; m.fill(); m.restore(); }
// 致意时右手的位置（世界坐标）：风从这里把帽子卷走
let _tip = null;
function tipHand() {
  if (_tip) return _tip;
  const pose = P.tip(), J = solve(pose, BODY.adult), L = J.legs;
  const low = Math.min(L.L.sole[1], L.R.sole[1], L.L.toe[1], L.R.toe[1], L.L.heel[1], L.R.heel[1]);
  const pr = projector(GX(HIT.gust), GY(HIT.gust) + low * S_G, S_G, 75), h = pr.P(J.arms.R.hand);
  return (_tip = [h[0] + 4, h[1] - 6]);
}

function drawGent(g, m, T, hs) {
  let x, ground, pose, yaw = 90, rotAbout = 0, pelvis = null;
  if (T < HIT.run) {
    x = GX(T); ground = GY(T);
    const ph = T / 1.0 + .25;
    pose = poseAt(T, [[0, P.walk], [HIT.tip - .2, P.walk], [HIT.tip, P.tip()], [HIT.gust - .02, P.tip()], [HIT.gust + .12, P.empty()], [HIT.land - .08, P.empty()],
      [HIT.land, P.take()], [HIT.land + .2, P.take()], [HIT.run, P.crouch()]], t => (t >= 0 && t < 1 ? ss(t) : t));
    if (T >= HIT.land - .08 && T < HIT.land) pose = P.empty();                  // 两帧回头：故意的突变
    yaw = T < HIT.tip - .2 ? 90 : T < HIT.gust + .3 ? 75 : 90;
    ground += T < HIT.tip - .2 ? walkBob(ph, S_G) * .4 : 0;
    if (T < HIT.tip - .2) pose = P.walk(ph);
  } else if (T < HIT.rung1 - .05) {
    x = GX(T); ground = GY(T);
    const ph = (T - HIT.run) * 2.4 + .25;
    pose = poseAt(T, [[HIT.run, P.crouch()], [HIT.run + .12, P.run(ph)], [HIT.curb, P.run(ph)], [HIT.tramIn - .1, P.reachLow()], [HIT.tramIn + .15, P.bell()], [T_NM - .1, P.bell()], [T_NM - .03, P.hop()], [T_NM + .05, P.stiff()],
      [HIT.tramOut + .1, P.stiff()], [HIT.hatWall - .15, P.lookUp()], [HIT.hatWall + .05, P.lookUp()], [HIT.hatWall + .15, P.run(ph)], [HIT.rung1, P.run(ph)]], t => ss(t));
    if (T > HIT.run + .12 && T < HIT.curb + .1) pose = P.run(ph);
    if (T > HIT.hatWall + .15) pose = P.run(ph);
    if (T >= T_NM - .1 && T < T_NM) ground -= Math.sin((T - T_NM + .1) / .1 * Math.PI) * 60;
    { const a = HIT.tramOut + .05, b = HIT.hatWall - .1; if (T > a && T < b) ground -= Math.sin((T - a) / (b - a) * Math.PI) * 45; }   // 跳回人行道
    ground += (T > HIT.run + .12 && T < HIT.tramIn - .1) || T > HIT.hatWall + .15 ? runBob(ph, S_G) * .3 : 0;
  } else if (T < T_FLING) {
    // 爬梯 / 伸手 / 晃
    const [ltx, lty] = ladderTop(T), u = CLIMB_U(Math.min(T, HIT.grab));
    const foot = ladderPt(LAD.bx, LAD.by, ltx, lty, u);
    x = foot[0] - 24; ground = foot[1];
    const k = (T - HIT.rung1) / (HIT.rung2 - HIT.rung1);
    pose = poseAt(T, [[HIT.rung1 - .05, P.climb(0)], [HIT.rung1, P.climb(0)], [HIT.rung2, P.climb(1)], [HIT.rung3, P.climb(0)], [HIT.grab - .12, P.reach()], [HIT.grab, P.grabbed()], [HIT.wobble, P.grabbed()], [HIT.wobble + .06, t => P.wobble((t - HIT.wobble) * 4)], [T_FLING, t => P.wobble((t - HIT.wobble) * 4)]]);
    if (T >= HIT.wobble + .06) pose = P.wobble((T - HIT.wobble) * 4);
  } else if (T < HIT.fall) {
    // 被梯子弹过墙：抛物线 + 翻转
    const u = (T - T_FLING) / (HIT.fall - T_FLING), [ltx, lty] = ladderTop(T_FLING - .001);
    const sx = ltx - 40, sy = lty + 240;
    x = lerp(sx, LAND_X, u); ground = lerp(sy, WY.sw, u * u) - Math.sin(u * Math.PI) * 300; pose = P.fly(); rotAbout = u * 1.1;
  } else {
    x = gentChaseX(T); ground = WY.sw;
    if (T < HIT.crank) {
      pose = poseAt(T, [[HIT.fall, P.land()], [HIT.bark - .05, P.land()], [HIT.bark + .05, P.lookBack()], [HIT.crank - .1, P.lookBack()], [HIT.crank, P.run(0)]]);
      if (T >= HIT.bark && T < HIT.bark + .084) pose = P.land();                 // 两帧回头
    } else {
      const ph = (T - HIT.crank) * 2.4 + .25;
      pose = P.run(ph, 1.15); pose.headTurn = -.5 + Math.sin(ph * 3) * .2; pose.expr = { ...EXPR.alarm };
      ground += runBob(ph, S_G) * .5;
    }
  }
  // 帽子在头上 / 在手里
  const hatProp = (g2, J, pr) => {
    if (hs.mode === 'head') { const h = pr.P(J.head), roll = J.headRoll * (pr.sy >= 0 ? 1 : -1); drawTopHat(g2, h[0] + Math.sin(roll) * S_G * .32, h[1] - S_G * .32, HAT_W, roll, m); }
  };
  const props = {
    holdR: (g2, wr, hd) => { if (hs.mode === 'hand') { const hx = hd[0], hy = hd[1]; drawTopHat(g2, hx + 4, hy - 6, HAT_W, -.25, m); } },
  };
  g.save(); m.save();
  if (rotAbout) { const px = x, py = ground - S_G * 3.6; for (const c of [g, m]) { c.translate(px, py); c.rotate(rotAbout); c.translate(-px, -py); } }
  if (T < HIT.rung1) contactShadow(g, x, ground + 4, 70, 9, .28);
  const r = drawFigure(g, GENT, { x, ground, scale: S_G, yaw, pose, t: T, props });
  hatProp(g, r.J, r.pr);
  g.restore(); m.restore();
}

// ---------------- 光圈镜头：小巷石板上的帽子 → 小猴子 ----------------
const RV = { hx: 720, hy: 760, hw: 380 };
const REV = HIT.reveal, LOOK = HIT.look;
export function revealCam(T) {     // 缓推 1.0 → 1.16；揭晓时跟着猴子起身上摇
  const z = lerp(1.0, 1.16, ss((T - HIT.silence) / (SEC.REVEAL.t1 - HIT.silence)));
  const cy = lerp(RV.hy - 170, RV.hy - 360, ss((T - REV) / .4));
  return [RV.hx, cy, T >= HIT.bow ? 1.16 : z];
}
export const r2f = (T, x, y) => { const [cx, cy, z] = revealCam(T); return [(x - cx) * z + FW / 2, (y - cy) * z + FH / 2]; };
// 光圈追踪目标（胶片坐标）

function monkeyState(T) {
  // 帽子：静置 → 一抖 → 猴子从帽子里站起来（帽子太大，扣到眼睛）→ 看观众时把帽檐推上去 → 结尾举帽致意
  let hatY = RV.hy, hatRot = 0, rise = 0, armR = 0, push = 0, look = [0, 0], blink = 0, smile = 0, lift = 0;
  if (T < REV) {
    if (T > HIT.twitch && T < HIT.twitch + .2) { const u = (T - HIT.twitch) / .2; hatY -= Math.sin(u * Math.PI) * 16; hatRot = Math.sin(u * Math.PI * 2) * .06; }
  } else if (T < HIT.bow) {
    rise = eo(clamp((T - REV) / .2));
    push = ss((T - LOOK + .12) / .2);                                  // 推帽檐
    armR = push * (1 - ss((T - LOOK - .35) / .25)) * .55;
    look = T < LOOK ? [.6, -.2] : [0, .25]; smile = T > LOOK ? .8 : 0;
    blink = T > LOOK + .5 && T < LOOK + .58 ? 1 : 0;
  } else {
    rise = 1; push = 1; look = [0, .25]; smile = 1;
    const u = clamp((T - HIT.bow) / .3); armR = Math.sin(u * Math.PI * .5); lift = armR;   // 右手举帽致意
  }
  const msz = 470, standY = RV.hy + 4, k = msz / 100, faceY = standY - 78 * k;
  const brimOn = standY - 96 * k + lerp(118, 46, push) - lift * 90;   // 帽檐高度：扣到眼睛 → 推到额头 → 举起
  return { hatY, hatRot, rise, armR, push, look, blink, smile, lift, msz, standY, faceY, brimOn };
}
export function irisTarget(T) {
  const M = monkeyState(T);
  if (!M.rise) return r2f(T, RV.hx, M.hatY - 150);
  const endK = ss((T - HIT.bow - .25) / (HIT.irisShut - HIT.bow - .25));
  return r2f(T, RV.hx + M.lift * 46, lerp(M.faceY - 60, M.brimOn - 40, endK));
}

export function irisShot(g, m, T) {
  const [cx, cy, z] = revealCam(T);
  g.setTransform(z, 0, 0, z, FW / 2 - cx * z, FH / 2 - cy * z); m.setTransform(z, 0, 0, z, FW / 2 - cx * z, FH / 2 - cy * z);
  // 小巷一角：砖墙 + 排水管 + 石板地
  form(g, rectPts(-400, -300, 2300, 960), { v: .55, line: 0, grad: .12, seed: 960 });
  g.strokeStyle = grey(.38, .55); g.lineWidth = 2;
  for (let yy = -300, r = 0; yy < 660; yy += 46, r++) { g.beginPath(); g.moveTo(-400, yy); g.lineTo(1900, yy); g.stroke(); for (let xx = -400 + (r % 2 ? 0 : 50); xx < 1900; xx += 100) { g.beginPath(); g.moveTo(xx, yy); g.lineTo(xx, yy + 46); g.stroke(); } }
  form(g, [[1080, -300], [1120, -300], [1120, 660], [1080, 660]], { v: .3, line: 2.2, seed: 961, cyl: 0 });
  form(g, rectPts(250, 120, 220, 300), { v: .82, line: 2, grad: .1, seed: 962, shade: 6 });     // 墙上旧告示（无字，只有几道墨线）
  for (let k = 0; k < 5; k++) stroke(g, [[280, 170 + k * 46], [440 - (k % 2) * 40, 170 + k * 46]], 4, { color: grey(.35), seed: 963 + k });
  g.save(); g.beginPath(); g.rect(-400, 640, 2300, 900); g.clip(); g.translate(-400, 0); street(g, 2300, 650, 1400, 0, 17, .62); g.restore();
  const M = monkeyState(T);
  contactShadow(g, RV.hx, RV.hy + 6, RV.hw * .62, 18, .35);
  if (!M.rise) { drawTopHat(g, RV.hx, M.hatY, RV.hw, M.hatRot, m); return; }
  // 猴子从帽子底下弹起：起身过程中帽子跟着头顶上去
  const sy = lerp(RV.hy + 300, M.standY, M.rise);
  drawMonkey(g, RV.hx, sy, M.msz, { look: M.look, blink: M.blink, smile: M.smile, armUp: 0, armR: M.armR });
  const brim = lerp(RV.hy, M.brimOn, M.rise);
  drawTopHat(g, RV.hx + M.lift * 46, brim, RV.hw, -M.lift * .32 - M.push * .06 + (1 - M.rise) * .1, m);
}
