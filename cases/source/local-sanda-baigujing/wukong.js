// 孙悟空皮影：头（开脸猴面 + 金箍 + 金睛）、锁子黄金甲、虎皮裙、两段腿（大腿 / 小腿连靴）、两臂、金箍棒；三根操纵杆
// 侧身朝右。坐标单位 = 幕布 px（机位 1×），枢轴在原点；旋转正 = 顺时针；腿 / 臂 0 = 自然下垂，负 = 向前（右）
import { piece, drawPiece, fill, cut, cutLine, ink, within, smooth, poly, scalesOpen, lattice, coin, cloud, beads, beadLine, plum, meander, DYE } from '/styles/shadow-puppet/demo/carve.js';
import { mul, T, R, S, ap, set, ik, camK } from './rig.js';
import { lerp } from '/core/lib.js';

const HK = 1.22;
export const WJ = { neck: [6, -108], shF: [15, -95], shB: [-2, -99], rod: [5, -104], hipF: [9, 20], hipB: [-8, 18], knee: [0, 84], elbow: [0, 52], wrist: [0, 46], eye: [22 * HK, -50 * HK], band: [-6 * HK, -70 * HK] };
export const WL = { UA: 52, FA: 46, HANDR: 12, THIGH: 84, SHIN: 110 };
const FUR = '#c98a26', TIGER = '#d88a24';

function head() {
  return piece([-56 * HK, -112 * HK, 50 * HK, 12 * HK], g => {
    g.scale(HK, HK);
    // 毛发：后脑与鬓毛一整片（金褐），刻短毛缝
    const fur = q => poly(q, [[18, -73], [16, -84], [9, -79], [5, -95], [-3, -84], [-11, -99], [-17, -85], [-28, -95], [-30, -79], [-42, -80], [-38, -66], [-48, -58], [-40, -48], [-49, -36], [-38, -30], [-43, -16], [-30, -14], [-30, -2], [-16, -4], [-9, 4], [0, -2], [8, 4], [4, -10], [2, -22], [0, -36], [2, -52], [6, -64]]);
    fill(g, FUR, fur);
    within(g, fur, () => {
      for (let k = 0; k < 26; k++) { const a = -Math.PI * .05 - k / 26 * Math.PI * 1.25, r0 = 16, r1 = 34; cutLine(g, 1.1, q => { q.moveTo(-14 + Math.cos(a) * r0, -46 + Math.sin(a) * r0 * 1.2); q.lineTo(-14 + Math.cos(a) * r1, -46 + Math.sin(a) * r1 * 1.2); }); }
      cloud(g, -20, -46, 7, 1, 1.3, -1); plum(g, -28, -22, 3);
    });
    ink(g, 1.8, fur);
    // 耳
    const ear = q => smooth(q, [[-6, -58], [-17, -60], [-22, -48], [-17, -36], [-7, -38], [-10, -48]]);
    fill(g, DYE.skin, ear); cutLine(g, 1.3, q => { q.moveTo(-10, -55); q.quadraticCurveTo(-19, -49, -12, -41); }); ink(g, 1.6, ear);
    // 开脸：脸部不上色（镂空透光），只留轮廓、眉、眼、鼻、嘴的细皮线
    ink(g, 2.4, q => { smooth(q, [[4, -66], [18, -70], [27, -64], [33, -56], [31, -48], [36, -44], [41, -36], [40, -30], [37, -25], [30, -21], [26, -14], [16, -8], [6, -8]], false); });
    ink(g, 1.3, q => { q.moveTo(6, -64); q.bezierCurveTo(2, -50, 2, -30, 7, -10); });
    // 红桃脸（眼周一块朱红，中间挖出大眼孔）
    const peach = q => smooth(q, [[10, -62], [22, -63], [32, -57], [31, -47], [26, -40], [17, -38], [9, -44], [7, -54]]);
    fill(g, DYE.red, peach);
    cut(g, q => { q.ellipse(22, -50, 8.2, 7.4, 0, 0, Math.PI * 2); });
    cutLine(g, 1.1, q => { q.moveTo(12, -41); q.quadraticCurveTo(18, -37, 26, -40); });
    ink(g, 1.5, peach);
    // 金睛：金色瞳仁（半透明，灯亮时发金光）+ 墨圈 + 瞳点
    const iris = q => { q.arc(22.5, -50, 5, 0, Math.PI * 2); };
    fill(g, DYE.yellow, iris); ink(g, 1.8, q => { q.ellipse(22, -50, 8.2, 7.4, 0, 0, Math.PI * 2); });
    g.beginPath(); g.arc(24, -50, 1.9, 0, Math.PI * 2); g.fillStyle = DYE.ink; g.fill();
    // 雷公眉：粗墨眉，眉尾上挑
    fill(g, DYE.ink, q => smooth(q, [[8, -60], [16, -64.5], [26, -64], [34, -58.5], [32, -56], [24, -60], [15, -60], [9, -57]]));
    ink(g, 1, q => { q.moveTo(14, -67); q.quadraticCurveTo(22, -71, 30, -66); q.moveTo(17, -69.5); q.quadraticCurveTo(22, -72, 27, -69.5); });
    // 猴嘴：浅皮色吻部 + 鼻孔 + 上翘的嘴线
    const muz = q => smooth(q, [[31, -44], [38, -38], [40, -30], [36, -24], [28, -19], [20, -20], [18, -28], [24, -36]]);
    fill(g, DYE.skin, muz); within(g, muz, () => { cutLine(g, 1, q => { q.moveTo(26, -34); q.quadraticCurveTo(30, -32, 33, -35); }); });
    ink(g, 1.5, muz);
    g.beginPath(); g.ellipse(36.5, -35, 1.6, 1.1, .5, 0, Math.PI * 2); g.fillStyle = DYE.ink; g.fill();
    ink(g, 1.8, q => { q.moveTo(39, -28); q.quadraticCurveTo(32, -26, 25, -27); q.quadraticCurveTo(22, -28, 21, -31); });
    cut(g, q => { q.rect(31, -28.2, 2.2, 2.4); q.rect(27.4, -27.6, 2.2, 2.4); });
    // 腮毛一圈（下巴下的小簇）
    const ruff = q => poly(q, [[4, -10], [9, -3], [14, -9], [19, -1], [23, -10], [27, -5], [28, -15], [18, -9], [8, -11]]);
    fill(g, FUR, ruff); ink(g, 1.1, ruff);
    // 金箍：一道金环 + 联珠孔 + 额前两个卷云头
    const band = q => smooth(q, [[-40, -64], [-18, -70], [4, -74], [22, -76], [24, -69], [4, -67], [-18, -63], [-39, -57]]);
    fill(g, DYE.yellow, band); within(g, band, () => beadLine(g, -34, -62, 18, -72, 1.25, 5.5)); ink(g, 1.6, band);
    for (const [x, y, f] of [[22, -79, 1], [13, -80, -1]]) { const cu = q => q.arc(x, y, 5, 0, Math.PI * 2); fill(g, DYE.yellow, cu); cloud(g, x, y, 3.6, 0, 1.1, f); ink(g, 1.2, cu); }
  }, { seed: 31, ss: 5.5 });
}
function chest() {
  const body = q => smooth(q, [[-22, 4], [-26, -36], [-28, -70], [-22, -92], [-9, -106], [5, -110], [17, -106], [27, -95], [33, -78], [34, -56], [30, -30], [24, 4]]);
  return piece([-36, -124, 44, 10], g => {
    fill(g, DYE.yellow, body);
    // 锁子甲：密集小圆孔（环环相扣）
    within(g, body, () => { const pts = []; for (let y = -84, r = 0; y < -14; y += 5.2, r++) for (let x = -30 + (r % 2) * 2.8; x < 38; x += 5.6) pts.push([x, y]); beads(g, pts, 1.75); });
    ink(g, 2.2, q => { q.moveTo(-26, -48); q.quadraticCurveTo(4, -40, 34, -48); });
    // 护心镜
    const mir = q => q.arc(18, -62, 11, 0, Math.PI * 2);
    fill(g, DYE.gold, mir); cut(g, q => { q.arc(18, -62, 8.5, 0, Math.PI * 2); q.arc(18, -62, 6, 0, Math.PI * 2, true); }, 'nonzero'); cloud(g, 18, -62, 4.2, 0, 1.1); ink(g, 1.5, mir);
    // 红云肩
    const cc = q => smooth(q, [[-24, -92], [-28, -82], [-18, -76], [-9, -84], [1, -74], [11, -84], [21, -76], [31, -86], [32, -98], [18, -110], [2, -115], [-14, -110]]);
    fill(g, DYE.teal, cc);
    within(g, cc, () => { ink(g, 4.5, cc, DYE.yellow); for (const [x, y, f] of [[-17, -88, 1], [2, -88, -1], [20, -90, 1]]) cloud(g, x, y, 5, 1.1, 1.3, f); lattice(g, -10, -112, 24, -96, 6.5, 1.5); });
    ink(g, 1.5, cc);
    // 腰带（绿）+ 古钱孔
    const belt = q => poly(q, [[-24, -14], [27, -14], [26, 4], [-23, 4]]);
    fill(g, DYE.green, belt); within(g, belt, () => { for (let x = -18; x < 22; x += 9) coin(g, x, -5, 3.4); }); ink(g, 1.5, belt);
    ink(g, 2.2, body);
  }, { seed: 32 });
}
function skirt() {
  const sk = q => smooth(q, [[-25, -6], [26, -6], [33, 26], [40, 62], [30, 72], [19, 63], [8, 74], [-4, 64], [-16, 74], [-27, 64], [-33, 28]]);
  return piece([-40, -10, 46, 80], g => {
    fill(g, TIGER, sk);
    within(g, sk, () => {
      // 虎纹：墨色锥形条
      for (const [x, y, a, l] of [[-22, 8, .3, 26], [-8, 4, .15, 30], [7, 6, -.1, 28], [21, 10, -.35, 26], [-26, 38, .5, 22], [-12, 36, .25, 30], [4, 40, 0, 30], [19, 42, -.3, 26], [32, 44, -.5, 18]]) {
        const c = Math.cos(a), s = Math.sin(a);
        fill(g, DYE.ink, q => { q.moveTo(x, y); q.quadraticCurveTo(x + s * l * .5 + c * 5, y + c * l * .5, x + s * l, y + c * l); q.quadraticCurveTo(x + s * l * .5 - c * 1.5, y + c * l * .5, x, y); });
      }
      for (let k = 0; k < 40; k++) { const x = -30 + (k * 37 % 64), y = 2 + (k * 23 % 60); cutLine(g, .8, q => { q.moveTo(x, y); q.lineTo(x + 2, y + 5); }); }
    });
    ink(g, 1.8, sk);
  }, { seed: 33 });
}
function thigh() {
  const tr = q => smooth(q, [[-14, -6], [13, -6], [15, 36], [12, 80], [-11, 82], [-15, 38]]);
  return piece([-20, -12, 20, 92], g => {
    fill(g, DYE.jade, tr); within(g, tr, () => lattice(g, -18, -6, 18, 84, 8.5, 1.6));
    fill(g, DYE.jade, q => q.arc(0, 78, 11, 0, 7)); cloud(g, 0, 78, 7.5, .5, 1.4); ink(g, 1.3, q => q.arc(0, 78, 11, 0, 7));
    ink(g, 1.8, tr);
  }, { seed: 34 });
}
function shin() {
  return piece([-22, -12, 46, 116], g => {
    const tr = q => smooth(q, [[-11, -8], [11, -8], [13, 30], [-12, 30]]);
    fill(g, DYE.jade, tr); within(g, tr, () => lattice(g, -14, -8, 14, 30, 8.5, 1.6)); ink(g, 1.6, tr);
    // 步云履：墨色高靴 + 云头 + 翘头
    const boot = q => smooth(q, [[-12, 24], [12, 22], [13, 52], [14, 74], [24, 82], [34, 86], [39, 81], [41, 89], [36, 96], [-14, 96], [-14, 58]]);
    fill(g, DYE.ink, boot);
    within(g, boot, () => { cloud(g, 0, 42, 6.5, .3, 1.5); cloud(g, 0, 70, 5, 2.4, 1.3, -1); cutLine(g, 1.2, q => { q.moveTo(-12, 29); q.lineTo(12, 27); }); cutLine(g, 1.1, q => { q.moveTo(8, 82); q.quadraticCurveTo(20, 80, 34, 88); }); beadLine(g, -8, 56, 8, 55, 1.2, 4.5); });
    ink(g, 1.2, boot, '#000');
    const sole = q => poly(q, [[-16, 95], [40, 93], [39, 99], [37, 110], [-14, 112], [-16, 104]]);
    fill(g, DYE.white, sole);
    within(g, sole, () => { cutLine(g, 1.3, q => { q.moveTo(-14, 100); q.lineTo(38, 98.5); }); for (let x = -10; x < 36; x += 6.5) cut(g, q => { q.ellipse(x, 105.5, 1.9, 2.8, 0, 0, 7); }); });
    ink(g, 1.6, sole);
  }, { seed: 35 });
}
function upperArm() {
  const sl = q => smooth(q, [[-12, 0], [12, 0], [11, 50], [-10, 50]]);
  return piece([-26, -26, 26, 66], g => {
    fill(g, DYE.red, sl); fill(g, DYE.red, q => q.arc(0, 55, 9.5, 0, Math.PI * 2));
    within(g, sl, () => { cloud(g, 0, 22, 6, 0, 1.3); cloud(g, -1, 40, 4.5, 2, 1.2, -1); beadLine(g, -8, 8, 8, 8, 1.2, 4); });
    ink(g, 1.6, sl); ink(g, 1.4, q => q.arc(0, 55, 9.5, 0, Math.PI * 2));
    const gd = q => smooth(q, [[-15, -8], [-5, -17], [10, -16], [17, -5], [12, 8], [0, 12], [-13, 6]]);
    fill(g, DYE.yellow, gd); cloud(g, 1, -3, 5.5, 0, 1.3);
    within(g, gd, () => { const pts = []; for (let k = 0; k < 10; k++) { const a = .2 + k / 9 * 2.6; pts.push([Math.cos(a) * 11.5, -3 + Math.sin(a) * 10]); } beads(g, pts, 1.3); });
    ink(g, 1.6, gd);
  }, { seed: 36 });
}
function foreArm() {
  return piece([-13, -12, 13, 56], g => {
    fill(g, DYE.red, q => q.arc(0, 0, 8.5, 0, Math.PI * 2)); ink(g, 1.3, q => q.arc(0, 0, 8.5, 0, Math.PI * 2));
    const cf = q => smooth(q, [[-10, -2], [10, -2], [9, 30], [-8, 30]]);
    fill(g, DYE.red, cf); within(g, cf, () => { cloud(g, 0, 14, 5, .4, 1.2); }); ink(g, 1.5, cf);
    const br = q => poly(q, [[-9, 27], [9, 27], [8, 50], [-8, 50]]);
    fill(g, DYE.yellow, br); within(g, br, () => lattice(g, -10, 27, 10, 50, 6.5, 1.4)); ink(g, 1.4, br);
  }, { seed: 37 });
}
function hand(kind) {
  const K = 1.12;
  return piece([-18, -6, 24, 34], g => {
    g.scale(K, K);
    let f;
    if (kind === 'grip') f = q => smooth(q, [[-7, -1], [7, -1], [11, 7], [11, 17], [5, 22], [-5, 21], [-9, 12]]);
    else if (kind === 'flat') f = q => smooth(q, [[-7, -1], [7, -1], [9, 10], [10, 22], [7, 28], [3, 26], [2, 18], [-4, 24], [-8, 14]]);   // 立掌（搭凉棚 / 行礼）
    else f = q => smooth(q, [[-7, -1], [7, -1], [12, 8], [13, 16], [8, 21], [-2, 22], [-8, 14]]);
    fill(g, DYE.skin, f);
    if (kind === 'grip') { cut(g, q => { q.ellipse(1.5, 12.5, 2.6, 3.4, 0, 0, Math.PI * 2); }); for (const y of [9, 13.5, 18]) cutLine(g, .8, q => { q.moveTo(5, y); q.lineTo(10, y + .5); }); }
    else if (kind === 'flat') { for (const y of [12, 17]) cutLine(g, .8, q => { q.moveTo(-5, y); q.lineTo(6, y - 1); }); }
    else { cutLine(g, .8, q => { q.moveTo(3, 7); q.quadraticCurveTo(9, 10, 8, 17); }); cutLine(g, .8, q => { q.moveTo(-2, 12); q.lineTo(4, 18); }); }
    // 猴手的毛：腕上一圈短毛
    ink(g, 1, q => { for (let x = -6; x <= 6; x += 3) { q.moveTo(x, 0); q.lineTo(x + 1, -4); } }, FUR);
    ink(g, 1.5, f);
  }, { seed: 38 });
}
let P = null;
export function build() {
  if (P) return P;
  P = { head: head(), chest: chest(), skirt: skirt(), thigh: thigh(), shin: shin(), ua: upperArm(), fa: foreArm(), grip: hand('grip'), fist: hand('fist'), flat: hand('flat') };
  return P;
}

// —— 金箍棒（世界坐标里画）：G = 握点，a = 方向，len，f = 握点在棒上的位置（0..1）——
export function drawStaff(g, K, G, a, len = 300, f = .5, w = 7) {
  const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux, L = len * K, h = w * K / 2;
  const P0 = [G[0] - ux * L * f, G[1] - uy * L * f], P1 = [G[0] + ux * L * (1 - f), G[1] + uy * L * (1 - f)];
  set(g, [1, 0, 0, 1, 0, 0]);
  const bar = (s0, s1, col) => { const a0 = [P0[0] + ux * L * s0, P0[1] + uy * L * s0], a1 = [P0[0] + ux * L * s1, P0[1] + uy * L * s1];
    g.beginPath(); g.moveTo(a0[0] + nx * h, a0[1] + ny * h); g.lineTo(a1[0] + nx * h, a1[1] + ny * h); g.lineTo(a1[0] - nx * h, a1[1] - ny * h); g.lineTo(a0[0] - nx * h, a0[1] - ny * h); g.closePath();
    g.fillStyle = col; g.fill(); g.strokeStyle = DYE.ink; g.lineWidth = 1.2 * K; g.stroke(); };
  bar(.1, .9, DYE.crim);
  bar(0, .1, DYE.yellow); bar(.9, 1, DYE.yellow);
  // 金箍：两端的环 + 棒身的回纹缝
  g.strokeStyle = DYE.ink; g.lineWidth = 1.1 * K;
  for (const s of [.035, .07, .93, .965]) { const c = [P0[0] + ux * L * s, P0[1] + uy * L * s]; g.beginPath(); g.moveTo(c[0] + nx * h, c[1] + ny * h); g.lineTo(c[0] - nx * h, c[1] - ny * h); g.stroke(); }
  for (let s = .16; s < .86; s += .045) { const c = [P0[0] + ux * L * s, P0[1] + uy * L * s]; g.beginPath(); g.arc(c[0], c[1], h * .42, 0, Math.PI * 2); g.fillStyle = '#e8c890'; g.fill(); }
  return [P0, P1];
}

// ================= 姿势 → 透射率画布 =================
// pose: {x,y 腰（世界）, rot, lean 上身前俯, head, lF:[髋,膝], lB:[髋,膝], fT/bT 手目标（相对肩，胸局部）, bendF/bendB, hF/hB 手腕,
//        handF/handB 'grip'|'fist'|'flat', staff:{a,f,len}|null, twoHand 0..1（后手握棒的位置）, plant 自动落地（地面 y）, flip, sc}
export const WREST = { x: 0, y: 0, rot: 0, lean: 0, head: 0, lF: [-.08, .06], lB: [.1, .04], fT: [14, 96], bT: [-6, 100], bendF: 1, bendB: 1, hF: 0, hB: 0, handF: 'grip', handB: 'fist', staff: null, twoHand: 0, flip: 1, sc: 1 };
function legM(Wp, hip, [a, b]) { const Mt = mul(Wp, mul(T(...hip), R(a))), Ms = mul(Mt, mul(T(...WJ.knee), R(b))); return [Mt, Ms]; }
export function soleY(p) {      // 两只靴底在世界里的最低点（腰坐标系 → 世界）
  const MW = mul(T(0, 0), mul(S(p.flip * p.sc, p.sc), R(p.rot)));
  let m = -1e9;
  for (const [hip, l] of [[WJ.hipF, p.lF], [WJ.hipB, p.lB]]) { const [, Ms] = legM(MW, hip, l); for (const q of [[-14, 110], [36, 108]]) m = Math.max(m, ap(Ms, ...q)[1]); }
  return m;
}
export function solve(pose) {
  const p = { ...WREST, ...pose };
  if (p.plant != null) p.y = p.plant - soleY(p);
  const MW = mul(T(p.x, p.y), mul(S(p.flip * p.sc, p.sc), R(p.rot)));
  const MC = mul(MW, R(p.lean));
  const [aF1, aF2] = ik(WJ.shF, [WJ.shF[0] + p.fT[0], WJ.shF[1] + p.fT[1]], WL.UA, WL.FA + WL.HANDR, p.bendF);
  let bT = p.bT;
  const S0 = { p, MW, MC, aF1, aF2 };
  // 双手握棒：后手目标 = 棒上一点（先求前手握点，再换算到胸局部）
  if (p.staff && (p.tw ?? (p.twoHand > 0 ? 1 : 0)) > 0) {
    const tw = p.tw ?? 1;
    const Mh = mul(mul(mul(MC, mul(T(...WJ.shF), R(aF1))), mul(T(...WJ.elbow), R(aF2 - aF1))), mul(T(...WJ.wrist), R(p.hF)));
    const G = ap(Mh, 1.7 * 1.12, 14.4 * 1.12), sa = p.staff.a * p.flip + (p.flip < 0 ? Math.PI : 0);
    const d = p.staff.len * p.sc * (p.twoHand - p.staff.f), q = [G[0] + Math.cos(sa) * d, G[1] + Math.sin(sa) * d];
    // 世界 → 胸局部
    const [a, b, c, dd, e, f] = MC, det = a * dd - b * c, lx = (dd * (q[0] - e) - c * (q[1] - f)) / det, ly = (-b * (q[0] - e) + a * (q[1] - f)) / det;
    bT = [lerp(p.bT[0], lx - WJ.shB[0], tw), lerp(p.bT[1], ly - WJ.shB[1], tw)];
  }
  const [aB1, aB2] = ik(WJ.shB, [WJ.shB[0] + bT[0], WJ.shB[1] + bT[1]], WL.UA, WL.FA + WL.HANDR, p.bendB);
  return { ...S0, aB1, aB2 };
}
export function drawWukong(g, Cam, pose, opt = {}) {
  const P = build(), S0 = solve(pose), { p } = S0, K = camK(Cam) * p.sc;
  const W = mul(Cam, S0.MW), C = mul(Cam, S0.MC);
  const Msk = W;
  const [MtB, MsB] = legM(W, WJ.hipB, p.lB), [MtF, MsF] = legM(W, WJ.hipF, p.lF);
  const Mhead = mul(C, mul(T(...WJ.neck), R(p.head)));
  const arm = (sh, a1, a2, hA) => { const Mu = mul(C, mul(T(...WJ[sh]), R(a1))), Mf = mul(Mu, mul(T(...WJ.elbow), R(a2 - a1))), Mh = mul(Mf, mul(T(...WJ.wrist), R(hA || 0))); return [Mu, Mf, Mh]; };
  const [MuB, MfB, MhB] = arm('shB', S0.aB1, S0.aB2, p.hB), [MuF, MfF, MhF] = arm('shF', S0.aF1, S0.aF2, p.hF);
  const dp = (M, pc) => { set(g, M); drawPiece(g, pc); };
  g.save(); g.globalCompositeOperation = 'multiply';
  dp(MuB, P.ua); dp(MfB, P.fa); dp(MhB, P[p.staff && (p.tw ?? 1) > .5 ? 'grip' : p.handB]);
  dp(MtB, P.thigh); dp(MsB, P.shin); dp(MtF, P.thigh); dp(MsF, P.shin);
  dp(Msk, P.skirt); dp(C, P.chest); dp(Mhead, P.head);
  dp(MuF, P.ua); dp(MfF, P.fa);
  let staffEnds = null;
  if (p.staff) {
    const G = ap(MhF, 1.7 * 1.12, 14.4 * 1.12), sa = p.staff.a * p.flip + (p.flip < 0 ? Math.PI : 0);
    staffEnds = drawStaff(g, K, G, sa, p.staff.len, p.staff.f);
  }
  dp(MhF, P[p.staff ? 'grip' : p.handF]);
  g.restore();
  const riv = [ap(C, ...WJ.neck), ap(C, ...WJ.shB), ap(C, ...WJ.shF), ap(W, 0, 0), ap(W, ...WJ.hipB), ap(W, ...WJ.hipF), ap(MtB, ...WJ.knee), ap(MtF, ...WJ.knee), ap(MuB, ...WJ.elbow), ap(MfB, ...WJ.wrist), ap(MuF, ...WJ.elbow), ap(MfF, ...WJ.wrist)];
  const rods = [ap(C, ...WJ.rod), ap(MhB, 0, 8), ap(MhF, 0, 8)];
  return { rods, riv, K, eye: ap(Mhead, ...WJ.eye), band: ap(Mhead, ...WJ.band), headC: ap(Mhead, 4, -50 * HK), staffEnds, feet: [ap(MsB, 10, 108), ap(MsF, 10, 108)] };
}
