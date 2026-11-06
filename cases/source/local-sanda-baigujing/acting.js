// 表演：每个角色一条关键帧轨（keyed：姿势之间缓动，不在 if 里跳变）+ 手颤、步态、离布 / 压布
import { keyed } from './rig.js';
import { T } from './story.js';
import { groundY } from './scenery.js';
import { soleY } from './wukong.js';
import { clamp, lerp, seg, ss, eio, eo, ei, vnoise } from '/core/lib.js';

const L = t => t, EI = u => u * u, EO = u => 1 - (1 - u) * (1 - u);
export const TX = 540, WX = 820;

// ================= 悟空 =================
const WB = { x: WX, air: 0, free: 0, fy: 0, rot: 0, lean: .05, head: -.04, lF: [-.14, .18], lB: [.16, .12], fT: [30, 88], bT: [-22, 96], bendF: 1, bendB: 1, hF: 0, hB: 0, handF: 'fist', handB: 'fist', sLen: 0, sa: -1.45, sf: .5, tw: 0, twoHand: .22, flip: 1, sc: 1, vis: 1, lift: 0, cloud: 0, tens: 1 };
const STAND = { lean: .05, head: -.04, lF: [-.14, .18], lB: [.16, .12], fT: [30, 88], bT: [-22, 96], hF: 0, hB: 0, handF: 'fist', handB: 'fist', tw: 0 };
const SHADE = { lean: .14, head: -.1, lF: [-.4, .55], lB: [.38, .4], fT: [38, -90], hF: -1.62, handF: 'flat', bT: [-34, 62], bendF: -1 };
const BOW = { lean: .5, head: .32, lF: [-.3, .35], lB: [.25, .2], fT: [40, 34], bT: [44, 40], hF: -1.3, hB: -1.3, handF: 'fist', handB: 'flat', bendF: 1, bendB: 1 };
const CROUCH = { lean: .32, head: -.25, lF: [-1.05, 1.65], lB: [-.25, 1.5], fT: [44, 46], bT: [-30, 56] };
const JUMP = { lean: -.05, head: -.3, lF: [-1.25, 1.75], lB: [-.6, 1.4], fT: [52, -36], bT: [-44, 18], hF: -1, handF: 'flat' };
const READY = { lean: .12, head: -.02, lF: [-.5, .6], lB: [.45, .3], fT: [46, 32], hF: -.25, sa: -.55, sf: .42, sLen: 300, tw: 1, twoHand: .2, bT: [-10, 80], bendF: 1, bendB: 1 };
const LOOSE = { lean: .06, head: -.04, lF: [-.2, .25], lB: [.2, .15], fT: [40, 60], hF: -.1, sa: -1.5, sf: .55, sLen: 300, tw: 0, bT: [-22, 94] };
const WIND = { lean: -.14, head: -.12, lF: [-.35, .4], lB: [.35, .25], fT: [-4, -110], hF: .3, sa: -2.5, sf: .4, tw: 1, twoHand: .22 };
const STRIKE = { lean: .38, head: .1, lF: [-.95, 1.0], lB: [.8, .15], fT: [74, 24], hF: -.2, sa: .5, sf: .4, tw: 1, twoHand: .24 };
const FOLLOW = { lean: .3, head: .05, lF: [-.85, .9], lB: [.7, .2], fT: [66, 44], hF: -.1, sa: .85, sf: .4, tw: 1 };
const KNEEL = { lF: [-1.45, 1.5], lB: [.05, 1.62], lean: .12, head: .16, fT: [36, 62], bT: [22, 70], tw: 0 };
const KOW = { lF: [-1.45, 1.5], lB: [.05, 1.62], lean: 1.12, head: .45, fT: [74, 104], bT: [64, 108], hF: -1.2, hB: -1.2, handF: 'flat', handB: 'flat' };
const EAR = { fT: [-16, -70], hF: -2.4, handF: 'grip', bendF: -1 };
const CLUTCH = { fT: [-2, -84], bT: [-18, -90], hF: -2.6, hB: -2.6, handF: 'flat', handB: 'flat', lean: .42, head: .3, lF: [-.75, 1.2], lB: [.25, .9], bendF: -1, bendB: -1 };
const PLEAD = { lean: .18, head: .08, fT: [62, 18], bT: [52, 30], hF: -1.3, hB: -1.2, handF: 'flat', handB: 'flat', lF: [-.25, .3], lB: [.2, .15], bendF: 1, bendB: 1 };
const eyeLook = { lean: .16, head: -.1, fT: [52, 30], hF: -1.2, handF: 'flat', bT: [-16, 84], lF: [-.45, .55], lB: [.4, .3] };

const bows = T.bows.flatMap(b => [[b, { ...KNEEL, lean: .2, head: .2 }], [b + .38, KOW, EI], [b + .66, KOW], [b + 1.2, { ...KNEEL, lean: .18, head: .22 }]]);
const wkTrack = keyed(WB, [
  [0, { ...SHADE }], [9.2, { head: -.2 }], [10.2, { head: -.02 }],
  [10.9, { ...STAND }], [11.1, { flip: -1 }], [11.35, { ...BOW, flip: -1 }], [11.9, BOW], [12.3, { ...STAND, flip: -1 }], [12.45, { flip: 1 }],
  [12.6, { ...STAND }], [13.2, CROUCH], [13.55, { ...JUMP, air: 190 }, EO], [13.9, { air: 250, cloud: 1 }], [14.9, { air: 330, lift: 1, x: 900 }, EI],
  [15.0, { vis: 0 }], [22.2, { vis: 0, lift: 1, x: 700, air: 300, cloud: 1, ...JUMP }],
  // 回来：驾云压布
  [22.25, { vis: 1, lift: 1, x: 700, air: 300, cloud: 1, ...JUMP }], [22.85, { lift: 0, x: 860, air: 40 }, EO], [22.95, { air: 0, cloud: 0, ...CROUCH }], [23.35, { ...STAND, lean: .1 }],
  [23.5, eyeLook], [24.5, eyeLook], [26.3, { ...eyeLook, ...EAR, handF: 'grip' }], [26.8, { ...EAR, handF: 'grip' }],
  [26.95, { sLen: 20, sa: -.9, fT: [30, -30], hF: -.6 }], [27.3, { ...READY }, EO],
  // 第一打
  [27.6, READY], [28.15, WIND], [28.4, { x: 930, ...WIND, lean: 0 }], [28.55, STRIKE, EI], [29.0, FOLLOW], [29.6, { ...READY, x: 930 }],
  // 斥责：转身、跪
  [31.1, { ...LOOSE, x: 930 }], [31.2, { flip: -1 }], [31.9, { ...LOOSE, flip: -1 }], [32.4, { ...KNEEL, sa: -1.5, sLen: 300, tw: 0, fT: [30, 40], hF: -.2 }], [34.9, { ...KNEEL, sa: -1.5, fT: [30, 40] }],
  [35.5, { ...LOOSE, flip: -1 }], [35.65, { flip: 1 }], [36.0, { ...LOOSE, x: 900 }],
  // 老妇
  [38.6, { ...LOOSE, head: -.08 }], [40.3, { ...READY, head: -.1 }], [40.55, { ...WIND, x: 920 }], [41.05, { ...WIND, x: 1000, lean: 0 }], [41.3, STRIKE, EI], [41.7, FOLLOW], [42.3, { ...LOOSE, x: 1000 }],
  // 紧箍咒：棒收回耳中，抱头，打滚
  [42.7, { ...LOOSE, ...EAR, sLen: 300, sa: -1.2 }], [42.95, { sLen: 0 }], [43.3, { ...CLUTCH, x: 990 }], [43.7, { ...CLUTCH, x: 975, lean: .6 }], [44.0, { ...CLUTCH, x: 965, lean: .8 }],
  [44.3, { free: 1, fy: 0, rot: -1.2, lF: [-1.8, 2.4], lB: [-1.5, 2.4], lean: .7, x: 940 }],
  [46.6, { free: 1, rot: -Math.PI * 4, x: 800, lF: [-1.8, 2.4], lB: [-1.5, 2.4], lean: .7 }, L],
  [46.9, { ...CLUTCH, ...KNEEL, fT: [-2, -84], bT: [-18, -90], hF: -2.6, hB: -2.6, handF: 'flat', handB: 'flat', bendF: -1, bendB: -1, free: 0, rot: -Math.PI * 4, lean: .5, head: .35 }],
  [47.8, { lean: .45 }], [48.1, { ...KNEEL, lean: .25, head: .3, rot: -Math.PI * 4 }], [48.9, { ...STAND, x: 820, rot: -Math.PI * 4 }],
  // 老翁：再掏棒
  [50.2, { ...STAND, ...EAR, handF: 'grip' }], [50.55, { ...EAR }], [50.65, { sLen: 20, sa: -.9, fT: [30, -30], hF: -.6 }], [51.0, { ...READY, x: 860 }, EO],
  [53.1, { ...READY, x: 860 }], [53.25, { ...READY, lean: .2, head: -.1 }], [54.0, { ...READY, lean: .14, head: -.04 }],
  // 静场：回头望师父，再转回，缓缓举棒
  [54.25, { ...LOOSE, x: 860 }], [54.45, { flip: -1 }], [55.1, { flip: -1, head: .12 }], [55.3, { flip: 1, head: 0 }], [55.8, { ...READY, x: 860 }], [57.2, { ...WIND, x: 860 }],
  [57.55, { ...WIND, x: 870 }], [57.95, { ...WIND, x: 960, lean: 0 }], [58.1, STRIKE, EI], [58.6, FOLLOW], [59.5, { ...LOOSE, x: 740 }], [60.0, { ...LOOSE, x: 740 }],
  [61.6, { ...LOOSE, ...EAR, sLen: 300, sa: -1.2 }], [61.9, { sLen: 0, ...STAND }],
  [62.4, { ...STAND, x: 780 }], [62.6, { flip: -1 }], [63.0, { ...PLEAD, flip: -1 }], [64.4, { ...PLEAD, flip: -1, lean: .22 }], [65.0, { ...STAND, flip: -1, head: .15 }],
  [66.8, { ...STAND, flip: -1, head: .2, x: 840 }], [67.8, { x: 780 }], [70.9, { ...STAND, x: 780, head: .22 }],
  // 拜别
  [71.5, { ...KNEEL, flip: -1 }], ...bows, [76.5, { ...KNEEL, lean: .15 }], [77.0, { ...STAND, head: .05 }], [77.5, { ...STAND }], [77.7, { flip: 1 }],
  [78.0, CROUCH], [78.35, { ...JUMP, air: 200, cloud: 1 }, EO], [79.4, { air: 360, lift: 1, x: 960 }, EI], [79.45, { vis: 0 }]
]);
export function wkPose(t) {
  const p = wkTrack(t);
  if (Math.abs(p.flip) < .05) p.flip = p.flip < 0 ? -.05 : .05;
  const gy = groundY(p.x) + 3;
  const yPlant = gy - soleY(p) - p.air, yFree = gy - 122 - p.air;
  p.y = lerp(yPlant, yFree, p.free);
  // 手颤：低频噪声（张力时 ×1.8）；紧箍咒时剧烈抖
  const tens = (t > T.raise[0] && t < T.hit3) ? 1.9 : (t > T.spell[0] + .4 && t < T.spell[1] ? 2.6 : 1);
  p.x += (vnoise(t * 2.1) - .5) * 3 * tens; p.y += (vnoise(t * 2.7 + 9) - .5) * 2.4 * tens; p.rot += (vnoise(t * 1.7 + 4) - .5) * .018 * tens;
  p.staff = p.sLen > 3 ? { a: p.sa, f: p.sf, len: p.sLen } : null;
  return p;
}

// ================= 唐僧 =================
const TB = { x: TX, rot: 0, lean: 0, head: 0, fT: [16, 96], bT: [-12, 98], bendF: 1, bendB: 1, hF: 0, hB: 0, handF: 'fist', handB: 'fist', flip: 1, sc: 1, paper: 0, swF: 0, swB: 0 };
const TREST = { lean: 0, head: 0, fT: [16, 96], bT: [-12, 98], hF: 0, hB: 0, handF: 'fist', handB: 'fist' };
const HESHI = { fT: [50, -26], bT: [58, -20], handF: 'flat', handB: 'flat', hF: -3.0, hB: -3.0, head: .14, lean: .06, bendF: 1, bendB: 1 };
const SHOCK = { lean: -.12, head: -.16, fT: [44, -2], hF: -1.3, handF: 'flat', bT: [-16, 90] };
const POINT = { lean: .1, head: .02, fT: [104, -16], hF: -1.5, handF: 'point', bT: [-14, 94] };
const tsTrack = keyed(TB, [
  [0, TREST], [11.3, TREST], [11.6, { head: .12 }], [12.0, { head: 0 }],
  [20.2, TREST], [20.8, HESHI], [22.9, HESHI], [23.3, { ...HESHI, lean: -.03, head: -.02 }], [24.3, TREST],
  [28.5, TREST], [28.75, SHOCK, EO], [30.6, SHOCK], [31.0, { ...TREST, head: .05 }], [31.6, { ...POINT, x: 610 }], [34.8, { ...POINT, x: 610 }], [35.4, { ...TREST, x: 610 }],
  [36.8, { ...TREST, x: 600 }], [41.25, TREST], [41.5, SHOCK, EO], [42.4, SHOCK],
  [42.8, { ...HESHI, head: .2 }], [47.6, { ...HESHI, head: .2 }], [48.1, TREST],
  [58.05, TREST], [58.3, SHOCK, EO], [59.6, SHOCK], [60.4, { ...TREST, head: .22 }], [62.8, { ...TREST, head: .22 }], [63.4, { ...TREST, head: -.12, lean: -.04 }],
  [65.5, { ...TREST, head: -.1 }], [66.1, { fT: [62, 18], hF: -1.3, handF: 'flat', paper: 1, head: 0 }], [66.5, { paper: 1 }], [66.6, { paper: 0 }],
  [67.9, { ...TREST, head: -.05 }], [68.15, { fT: [70, -26], hF: -1.2, handF: 'flat' }, EO], [68.3, { flip: 1 }], [68.5, { flip: -1 }], [69.0, { ...TREST, flip: -1, head: -.1 }],
  [79.7, { ...TREST, flip: -1, head: -.1 }], [79.9, { flip: 1 }], [80.2, { head: 0 }], [80.9, { head: .26, lean: .04 }]
]);
export function tsPose(t) {
  const p = tsTrack(t);
  if (Math.abs(p.flip) < .05) p.flip = p.flip < 0 ? -.05 : .05;
  // 垂袖随手臂运动滞后摆动（确定性：用 0.12 s 前的姿势做差）
  const q = tsTrack(t - .12);
  p.swF = clamp((q.fT[0] - p.fT[0]) * .006 + (q.fT[1] - p.fT[1]) * .004, -.5, .5); p.swB = clamp((q.bT[0] - p.bT[0]) * .006, -.4, .4);
  const tens = t > 31.6 && t < 34.9 ? 2.2 : 1;
  p.x += (vnoise(t * 1.9 + 20) - .5) * 2.6 * tens; p.rot += (vnoise(t * 1.5 + 24) - .5) * .014 * tens;
  if (t > 31.6 && t < 34.9) p.fT = [p.fT[0] + (vnoise(t * 9) - .5) * 5, p.fT[1] + (vnoise(t * 8 + 3) - .5) * 5];
  p.y = groundY(p.x) + 2;
  return p;
}

// ================= 白骨精三变 =================
function walker(track, t, seed, bobA = 3) {
  const p = track(t);
  if (Math.abs(p.flip) < .05) p.flip = -.05;
  const v = Math.abs(track(t).x - track(t - .06).x) / .06, w = clamp(v / 60);
  p.y = groundY(p.x) + 2 - Math.abs(Math.sin(t * 11 + seed)) * bobA * w;
  p.rot += Math.sin(t * 11 + seed) * .025 * w + (vnoise(t * 1.8 + seed) - .5) * .016;
  p.x += (vnoise(t * 2 + seed) - .5) * 2.4;
  return p;
}
const GB0 = { x: 1420, flip: -1, rot: 0, lean: 0, head: 0, fT: [36, 52], bT: [-16, 96], hF: 0, hB: 0, handF: 'fist', handB: 'fist', fall: 0, fallDir: 1, basketA: 0, vis: 0, lift: 0 };
const girlTrack = keyed(GB0, [
  [17.35, { vis: 0, lift: 1 }], [17.4, { vis: 1, lift: 1 }], [17.95, { lift: 0 }, EO],
  [18.1, {}], [20.6, { x: 1178 }, L], [21.1, { x: 1130, fT: [48, 30], basketA: .12, head: .08 }, L], [21.3, { x: 1110 }, EO], [22.9, { fT: [48, 30] }], [23.3, { lean: -.06, head: -.04, fT: [40, 44] }],
  [27.5, { lean: -.06 }], [27.9, { lean: -.14, head: -.12, fT: [26, 50] }], [28.55, {}], [29.15, { fall: 1 }, EI],
  [35.1, { lift: 0 }], [35.7, { lift: 1 }, EI], [35.75, { vis: 0 }]
]);
export const girlPose = t => walker(girlTrack, t, 1, 2.5);
const CB0 = { x: 1500, flip: -1, rot: 0, lean: .32, head: -.2, fT: [34, 70], bT: [-14, 86], hF: 0, hB: 0, handF: 'fist', handB: 'fist', fall: 0, fallDir: 1, caneA: 1.35, caneLen: 180, vis: 0, lift: 0 };
const croneTrack = keyed(CB0, [
  [36.35, { vis: 0, lift: 1 }], [36.4, { vis: 1, lift: 1 }], [36.95, { lift: 0 }, EO],
  [37.0, {}], [38.4, { x: 1348 }, L], [38.9, { x: 1294, bT: [36, -62], hB: -2.3, handB: 'flat', head: .1, lean: .38 }, L], [39.4, { x: 1240 }, EO], [40.2, { bT: [36, -62] }],
  [40.7, { bT: [-14, 86], hB: 0, handB: 'fist', lean: .12, head: -.25 }], [41.3, {}], [41.85, { fall: 1 }, EI],
  [47.9, { lift: 0 }], [48.5, { lift: 1 }, EI], [48.55, { vis: 0 }]
]);
export const cronePose = t => { const p = walker(croneTrack, t, 3, 4); p.caneA = 1.35 + Math.sin(t * 5.5) * .08 * clamp((t - 37) * 3) * (1 - clamp((t - 39.4) * 3)); return p; };
const EB0 = { x: 1480, flip: -1, rot: 0, lean: .04, head: -.02, fT: [30, 40], bT: [-12, 88], hF: 0, hB: 0, handF: 'fist', handB: 'fist', fall: 0, fallDir: 1, caneA: 1.48, caneLen: 205, vis: 0, lift: 0 };
const elderTrack = keyed(EB0, [
  [49.15, { vis: 0, lift: 1 }], [49.2, { vis: 1, lift: 1 }], [49.75, { lift: 0 }, EO],
  [49.8, {}], [52.4, { x: 1200 }], [52.7, { bT: [44, 20], hB: -1.3, handB: 'flat', head: -.08 }], [53.8, { bT: [40, 26] }], [54.2, { bT: [-12, 88], hB: 0, handB: 'fist', head: 0 }],
  [57.4, {}], [57.8, { lean: -.1, head: -.14 }]
]);
export const elderPose = t => walker(elderTrack, t, 5, 2);

// ================= 离布 / 压布：lift 0..1 → 放大、虚化、淡出 =================
export const liftFx = (lift, k = 1) => ({ s: 1 + lift * 1.6, blur: lift * 32 * k, alpha: 1 - ei(lift) * .98 });
