// 《按一下》的全部运动：纯函数，浏览器（render）和 node（tools/cuecheck.mjs）共用。不依赖 three。
import { DIMS } from './dims.js';
import { T, UP, UPDUR, LAND, DOWNDUR, GAP } from './timeline.js';
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const ss = t => { t = clamp(t); return t * t * (3 - 2 * t); };
const eio = t => { t = clamp(t); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const ei = t => Math.pow(clamp(t), 3);
const C = DIMS.cam, Pl = DIMS.plunger;
export const LIFT = 24;
export const FIN = { front: -113, spring: -47, refill: -8, rear: 47, cam: 98, plunger: 112 };
// ---------- 机构：按一下 ----------
// 一次按压：tp 开始下压，tk 到底（咔），td 锁定（哒）。返回位移（负 = 朝笔尖）与该次按压的进度 0..1（凸轮转角用）
export function click(t, tp, tk, td, from, to) {
  if (t < tp) return [from, 0];
  if (t < tk) return [lerp(from, -Pl.stroke, ei(seg(t, tp, tk)) ** .8), 0];
  const r0 = td - .12;
  if (t < r0) return [-Pl.stroke, 0];
  if (t < td) { const k = ei(seg(t, r0, td)); return [lerp(-Pl.stroke, to, k), k]; }
  const k = seg(t, td, td + .08); return [to + .25 * Math.sin(Math.PI * k) * (1 - k), 1];   // 锁定处一点点真实的回弹（0.25 mm）
}
export function mech(t) {
  if (t < 15) return click(t, T.press1, T.ka1, T.da1, 0, -Pl.latch);
  if (t < T.press2) return [0, 0];
  return click(t, T.press2, T.ka2, T.da2, 0, -Pl.latch);
}
// 凸轮转角：每次锁定转一齿（45°）；缝内 14/15/16 各转一齿
const STEP = Math.PI * 2 / C.teeth;
export function camAngle(t) {
  let a = 0;
  a += STEP * mech(Math.min(t, 14.9))[1];
  for (const tt of T.teeth) { const k = seg(t, tt - .1, tt); a += STEP * (k < 1 ? ei(k) : 1); }
  if (t >= T.press2) a = 4 * STEP + STEP * mech(t)[1];
  return a;
}

// ---------- 爆炸：每个零件的位移 ----------
const pop = x => 1 - Math.pow(1 - ss(x), 3);      // 平稳起步、快速中段、长收尾
const PH = { plunger: 0, cam: .9, rear: 1.7, front: 2.6, spring: 3.4, refill: 4.3 };
function openE(k, t) { const u = seg(t, UP[k], UP[k] + UPDUR); return [pop(seg(u, 0, .85)), pop(seg(u, .12, 1))]; }
function closeE(k, t) { const d = seg(t, LAND[k] - DOWNDUR, LAND[k]); return [eio(seg(d, .3, 1)), eio(seg(d, 0, .72))]; }
const still = t => 1 - seg(t, 12.6, 13.0) + seg(t, 17.0, 17.4);   // 微距段零件完全静止
export function partState(k, t) {
  const [ox, oy] = openE(k, t), [cx, cy] = closeE(k, t);
  const ex = ox * (1 - cx), ey = oy * (1 - cy);
  const [m] = mech(t);
  const mm = (k === 'plunger' || k === 'cam' || k === 'refill') ? m : 0;
  let dx = mm * (1 - ex) + FIN[k] * ex;
  if (k === 'plunger') dx += GAP.extra * eio(seg(t, GAP.open[0], GAP.open[1])) * (1 - eio(seg(t, GAP.close[0], GAP.close[1])));
  const fl = ex * ey * clamp(still(t)) * .8 * Math.sin(t * 2.2 + PH[k]);
  return { dx, dy: LIFT * ey + fl, ex, ey, m: mm };
}
export function springLength(t) {
  const s = partState('spring', t), r = partState('refill', t);
  const comp = 12 + r.m;                      // 装配时：前杆台阶 x=8 到笔芯台肩 x=20+位移
  return lerp(comp, DIMS.spring.free, s.ex);
}
