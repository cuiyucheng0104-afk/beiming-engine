// 喜鹊角色：粗墨线、平涂、浅色腹部、蓝绿本地色；头部一套 rig（setFace 式参数），身体正面 3/4 姿势
import { C, ink, ell, halftone, lerp, clamp, TAU, boil, smooth } from './draw.js';

// 喜鹊本体。pose: {open, wide, lookX, lookY, beak, tilt, puff, sq, hold(纸页是否在嘴里), blinkHappy}
export function magpie(ctx, pose, T) {
  const { open = 1, wide = 0, lookX = 0, lookY = 0, beak = 0, tilt = 0, puff = 0, sq = 1, hold = true, breathe = 0 } = pose;
  ctx.save();
  ctx.scale(1 / sq, sq);
  // 尾巴（身后，斜向右下）
  ink(ctx, [[40, -230], [92, -250], [300, -40], [318, 8], [282, 20], [236, -6], [30, -170]], { fill: C.teal, lw: 7, salt: 1, clipFn: () => {
    halftone(ctx, { x0: 20, y0: -260, w: 320, h: 300, step: 16, angle: 60, color: C.navy, mul: true, f: (x, y) => .25 + .6 * clamp((x - 120) / 200) });
  } });
  ink(ctx, [[150, -110], [300, -40], [318, 8], [282, 20], [210, -40]], { fill: C.navy, lw: 6, salt: 2 });
  // 腿与爪
  ctx.strokeStyle = C.navy; ctx.lineCap = 'round';
  for (const [x0, x1] of [[-34, -40], [26, 30]]) {
    ink(ctx, [[x0, -175], [x0 + 2, -90], [x1, -6]], { stroke: C.navy, lw: 11, closed: false, salt: x0 });
    for (const dx of [-38, -12, 14]) ink(ctx, [[x1, -4], [x1 + dx, 4]], { stroke: C.navy, lw: 9, closed: false, curve: false, salt: x0 + dx });
    ink(ctx, [[x1, -4], [x1 + 22, -12]], { stroke: C.navy, lw: 8, closed: false, curve: false, salt: x0 + 5 });
  }
  // 身体（黑）+ 白腹 + 呼吸
  const by = -300 - breathe * 3, bs = 1 + puff * .06;
  ctx.save(); ctx.translate(0, by); ctx.scale(bs, bs * (1 + breathe * .012));
  ink(ctx, ell(0, 0, 136, 176, 16, .2), { fill: C.navy, lw: 7, salt: 3 });
  ink(ctx, ell(-28, 62, 88, 112, 14, .2), { fill: C.white, lw: 0, salt: 4, clipFn: () => {
    halftone(ctx, { x0: -130, y0: -60, w: 210, h: 250, step: 15, angle: 20, color: C.cobalt, mul: true, k: .6, f: (x, y) => .55 * clamp((x + 20) / 110) * clamp((y + 10) / 160) + .12 });
  } });
  // 翅膀（蓝绿光泽 + 白色肩羽 + 黑色飞羽）
  ink(ctx, [[64, -126], [128, -100], [160, 0], [150, 120], [108, 168], [84, 120], [62, 0]], { fill: C.teal, lw: 7, salt: 5, clipFn: () => {
    halftone(ctx, { x0: 50, y0: -140, w: 130, h: 320, step: 16, angle: 75, color: C.navy, mul: true, f: (x, y) => clamp((y - 40) / 120) * .95 });
  } });
  ink(ctx, [[70, -118], [118, -98], [124, -40], [86, -30]], { fill: C.white, lw: 6, salt: 6 });
  ctx.restore();
  // 头（绕颈部旋转）
  ctx.save(); ctx.translate(-14, -436); ctx.rotate(tilt * Math.PI / 180); ctx.translate(14, 436);
  ink(ctx, ell(-30, -504, 96, 90, 14, -.1), { fill: C.navy, lw: 7, salt: 7 });
  // 喙：上喙 + 下喙（beak 0..1 张开）
  const lo = beak * 34;
  ink(ctx, [[-104, -490], [-150, -478 + lo * .5], [-210, -470 + lo], [-108, -462]], { fill: C.navy, lw: 6, salt: 8, curve: false });
  ink(ctx, [[-108, -530], [-160, -512], [-224, -488], [-104, -486]], { fill: C.navy, lw: 6, salt: 9, curve: false });
  ctx.strokeStyle = C.white; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-122, -518); ctx.lineTo(-180, -502); ctx.stroke();
  // 眼：白色眼圈 + 墨色瞳孔 + 两个高光；open = 睁开程度
  const ex = -66, ey = -524, er = 25 * (1 + wide * .22);
  ctx.save();
  ctx.beginPath(); ctx.ellipse(ex, ey, er, er * 1.1, 0, 0, TAU); ctx.fillStyle = C.white; ctx.fill();
  ctx.clip();
  const pr = 14 * (1 - wide * .25);
  ctx.beginPath(); ctx.ellipse(ex - 5 + lookX * 7, ey + 2 + lookY * 7, pr, pr * 1.18, 0, 0, TAU); ctx.fillStyle = C.navy; ctx.fill();
  ctx.fillStyle = C.white; ctx.beginPath(); ctx.arc(ex - 9 + lookX * 7, ey - 5 + lookY * 7, 4.5, 0, TAU); ctx.arc(ex - 1 + lookX * 7, ey + 7 + lookY * 7, 2.2, 0, TAU); ctx.fill();
  // 眼睑（深墨，从上往下盖）
  const lid = 1 - clamp(open);
  if (lid > 0) { ctx.fillStyle = C.navy; ctx.fillRect(ex - 40, ey - 40, 80, 80 * lid * .55 + 12 * lid); }
  ctx.restore();
  ctx.beginPath(); ctx.ellipse(ex, ey, er, er * 1.1, 0, 0, TAU); ctx.strokeStyle = C.navy; ctx.lineWidth = 5; ctx.stroke();
  if (open < .15) { ctx.beginPath(); ctx.moveTo(ex - er, ey + 2); ctx.quadraticCurveTo(ex, ey + 14, ex + er, ey + 2); ctx.strokeStyle = C.white; ctx.lineWidth = 5; ctx.stroke(); }
  ctx.restore();
  ctx.restore();
}
// 喙尖在喜鹊局部坐标中的位置（纸页夹持点）
export const BEAK_TIP = [-200, -478];
