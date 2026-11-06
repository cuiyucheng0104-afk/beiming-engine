// 写意白鹤（丹顶鹤）：鹤身留纸白，只用几笔淡墨勾背腹；两笔浓墨翼羽 + 焦墨飞羽指；一笔焦墨长颈；一点朱红丹顶。
// 局部坐标：鹤身中心为原点，头朝 -x，单位 100 ≈ 身长。pose 是一组可插值的数（关键帧之间只插值，不在 if 里切姿势）。
import { mk, draw, blot, TONE } from './ink.js';
import { clamp, lerp, vnoise } from '/core/lib.js';

export const VERM = [176, 46, 34];
const D2R = Math.PI / 180;
const NECKP = u => Math.min(1, .62 + u / .07 * .38) * (1 - .42 * u) * Math.min(1, (1 - u) / .06 * .5 + .5);   // 颈：按下起笔 → 渐提 → 收

// —— 姿势库 ——（neck：颈 4 点；hd：喙方向角，180=朝左；legs：[髋, 膝, 足]×2；wa：近翼角，fold：收翼 0..1）
const P = (o) => o;
export const POSE = {
  fly: P({ pitch: 0, wa: 10, fold: 0, wl: 1, neck: [[-40, -8], [-70, -15], [-100, -15], [-121, -10]], hd: 184,
    legs: [[[30, 8], [62, 12], [118, 15]], [[28, 10], [60, 15], [114, 20]]], tail: 18 }),
  stand: P({ pitch: -12, wa: -20, fold: 1, wl: 1, neck: [[-38, -14], [-56, -55], [-38, -90], [-50, -108]], hd: 186,
    legs: [[[6, 14], [14, 56], [4, 98]], [[0, 14], [2, 56], [-14, 97]]], tail: 40 }),
  display: P({ pitch: -16, wa: 58, fold: .15, wl: .92, neck: [[-38, -14], [-60, -50], [-50, -86], [-64, -100]], hd: 196,
    legs: [[[6, 14], [14, 56], [4, 98]], [[0, 14], [2, 56], [-14, 97]]], tail: 38 }),
  raise: P({ pitch: -20, wa: 92, fold: 0, wl: 1, neck: [[-38, -14], [-62, -46], [-58, -84], [-74, -96]], hd: 200,
    legs: [[[6, 14], [18, 52], [4, 92]], [[0, 14], [6, 52], [-14, 92]]], tail: 34 }),
  lift: P({ pitch: -24, wa: -46, fold: 0, wl: 1, neck: [[-38, -12], [-66, -36], [-86, -58], [-104, -66]], hd: 198,
    legs: [[[16, 12], [40, 34], [52, 82]], [[12, 14], [34, 38], [42, 86]]], tail: 26 }),
  brake: P({ pitch: -30, wa: 112, fold: 0, wl: 1.05, neck: [[-38, -14], [-62, -40], [-82, -56], [-100, -60]], hd: 192,
    legs: [[[5, 14], [-6, 50], [-26, 88]], [[0, 14], [-12, 48], [-36, 84]]], tail: 30 }),
  lookdown: P({ pitch: -8, wa: -20, fold: 1, wl: 1, neck: [[-38, -14], [-46, -56], [-22, -88], [4, -94]], hd: -22,
    legs: [[[6, 14], [14, 56], [4, 98]], [[0, 14], [2, 56], [-14, 97]]], tail: 42 }),
  look: P({ pitch: -10, wa: -20, fold: 1, wl: 1, neck: [[-38, -14], [-48, -60], [-24, -96], [2, -106]], hd: -8,
    legs: [[[6, 14], [14, 56], [4, 98]], [[0, 14], [2, 56], [-14, 97]]], tail: 40 }),
};
const lp2 = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
export function mix(A, B, u) {
  u = clamp(u);
  return {
    pitch: lerp(A.pitch, B.pitch, u), wa: lerp(A.wa, B.wa, u), fold: lerp(A.fold, B.fold, u), wl: lerp(A.wl, B.wl, u),
    neck: A.neck.map((p, i) => lp2(p, B.neck[i], u)), hd: lerp(A.hd, B.hd, u), tail: lerp(A.tail, B.tail, u),
    legs: A.legs.map((L, i) => L.map((p, j) => lp2(p, B.legs[i][j], u))),
  };
}
export const withWing = (p, wa) => ({ ...p, wa });

// 局部 → 世界
function xform(x, y, s, dir, pitch) {
  const c = Math.cos(pitch * D2R), sn = Math.sin(pitch * D2R);
  return p => { const px = p[0], py = p[1]; const rx = px * c - py * sn, ry = px * sn + py * c; return [x + rx * s * dir, y + ry * s, p[2] ?? 1]; };
}

// 翼：翼局部坐标（u 沿翼展，v 沿翼弦向后缘），转到身体坐标
function wingPts(pose, far) {
  const sh = far ? [-2, -14] : [-8, -10];
  const fold = pose.fold, a = (pose.wa + (far ? 14 : 0)) * D2R;
  const span = (far ? .82 : 1) * pose.wl * lerp(1, .52, fold);
  // 收翼时翼展方向贴着身体向后
  const ang = lerp(a, 4 * D2R, fold);
  const ux = Math.cos(ang), uy = -Math.sin(ang);          // 翼展方向（a=0 向后，a=90 向上）
  const vx = -uy, vy = ux;                                // 弦向（指向后缘）
  const chord = lerp(1, .6, fold);
  const W = (u, v) => [sh[0] + (ux * u + vx * v * chord) * span, sh[1] + (uy * u + vy * v * chord) * span];
  return { W, span, chord, ux, uy, vx, vy };
}

// 剪影（用于从淡墨天色里"留"出鹤身）：c 已设好世界变换
export function silhouette(c, x, y, s, pose, dir = 1) {
  const T = xform(x, y, s, dir, pose.pitch);
  c.beginPath();
  const N = 22;
  for (let i = 0; i <= N; i++) { const t = i / N * Math.PI * 2; const p = T([4 + Math.cos(t) * 50, 1 + Math.sin(t) * 19]); i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]); }
  c.fill();
  for (const far of [true, false]) {
    const { W } = wingPts(pose, far);
    const poly = [[0, 0], [45, -6], [95, -2], [128, 6], [104, 30], [62, 42], [22, 40], [0, 26]].map(q => T(W(q[0], q[1])));
    c.beginPath(); poly.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); c.fill();
  }
  const nk = pose.neck.map(T);
  c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = 16 * s; c.beginPath(); nk.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.stroke();
  const h = nk[3]; c.beginPath(); c.arc(h[0], h[1], 11 * s, 0, 7); c.fill();
}

// 画鹤。prog：各笔画的完成度（生鹤时按笔序出现），缺省全画；k：画稿序号（一拍二，用于极轻的"沸"）
export function crane(L, x, y, s, pose, o = {}) {
  const dir = o.dir ?? 1, k = o.k ?? 0, am = o.am ?? 1, pr = o.prog || {};
  const g = (n) => pr[n] ?? 1;
  const T = xform(x, y, s, dir, pose.pitch);
  const boil = (k % 3) * .7;
  const S = (pts, opt, p = 1, a = am) => { if (p > 0) draw(L, mk(pts.map(T), { ...opt, w: opt.w * s, boil }), p, a); };
  // 远翼（淡，在身后）
  const wing = (far, pw, pf) => {
    const { W } = wingPts(pose, far);
    const q0 = T(W(60, 12)), q1 = T(W(60, 42)), dd = [q1[0] - q0[0], q1[1] - q0[1]];   // 世界坐标里的后缘方向（墨重的一侧）
    const tone = far ? .55 : 1;
    // 前缘：一笔淡墨
    S([[2, 2], [45, -6, 1.1], [95, -2, .9], [126, 6, .5]].map(q => [...W(q[0], q[1]), q[2] ?? 1]), { w: 5, tone: TONE.dan * tone * 1.2, dry: .4, wet: .6, prof: 'tip', seed: 301 + far }, pw);
    // 覆羽：极淡的一抹（白翼要有体积）
    S([[8, 12, .7], [50, 12, 1], [96, 10, .8], [118, 12, .3]].map(q => [...W(q[0], q[1]), q[2]]), { w: 16, tone: .1 * tone, darkDir: [-dd[0], -dd[1]], side: .6, dry: .3, wet: .9, brWet: true, body: .7, prof: 'lens', seed: 305 + far }, pw);
    // 两笔浓墨：次级飞羽（翼后缘的大块黑）——带墨的侧锋，墨色自带轮廓
    S([[16, 36, .8], [50, 39, 1.1], [86, 31, 1.0], [110, 24, .6]].map(q => [...W(q[0], q[1]), q[2]]), { w: 13 * pose.wl, tone: TONE.nong * tone, darkDir: dd, side: .85, dry: .42, wet: .5, prof: 'robe', seed: 311 + far, brWet: true, body: .9 }, pf);
    // 初级飞羽"指"：焦墨，5 根
    if (pf > 0) for (let i = 0; i < 5; i++) {
      const u = 98 + i * 7, v0 = 4 + i * 5, len = 30 - i * 3;
      const a = W(u, v0), b = W(u + len, v0 + 4 + i * 2.2), mpt = W(u + len * .55, v0 + 1 + i);
      S([[...a, 1], [...mpt, .9], [...b, .3]], { w: 6.5, tone: TONE.jiao * tone, dry: .42, wet: .3, prof: 'nail', seed: 330 + i + far * 10 }, clamp(pf * 1.6 - .6 - i * .08));
    }
    // 后缘锯齿：几根短羽
    if (pf > 0 && !far) for (let i = 0; i < 4; i++) {
      const u = 22 + i * 20; const a = W(u, 38), b = W(u + 6, 50);
      S([[...a, 1], [...b, .3]], { w: 6, tone: TONE.zhong, dry: .5, prof: 'tip', seed: 360 + i }, clamp(pf * 1.4 - .4));
    }
  };
  // 鹤身的淡墨托底：白身本是留白，四周（尤其腹下）垫一层由淡到清的渐变墨块，再把身子挖回纸白——留白有了边界
  const bw = (o.bellyWash ?? .3) * g('body');
  if (bw > .01) {
    const ell = (cx, cy, rx, ry) => { const q = []; for (let i = 0; i < 36; i++) { const t = i / 36 * Math.PI * 2; q.push(T([cx + Math.cos(t) * rx * (1 + .05 * Math.sin(t * 3 + 1)), cy + Math.sin(t) * ry])); } return q; };
    const path = (c, q) => { c.beginPath(); q.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); };
    const c = L.wet; c.save();
    const a = T([4, -26]), b = T([4, 34]), gr = c.createLinearGradient(a[0], a[1], b[0], b[1]);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(.35, `rgba(0,0,0,${bw * .45})`); gr.addColorStop(.8, `rgba(0,0,0,${bw})`); gr.addColorStop(1, `rgba(0,0,0,${bw * .55})`);
    c.fillStyle = gr; path(c, ell(4, 5, 64, 30)); c.fill();
    // 颈根到胸前也托一点，颈与身连成一体
    const nk0 = pose.neck[0], nk1 = pose.neck[1], na = T(nk0), nb = T(lp2(nk0, nk1, .6));
    c.strokeStyle = `rgba(0,0,0,${bw * .5})`; c.lineCap = 'round'; c.lineWidth = 24 * s; c.beginPath(); c.moveTo(na[0], na[1]); c.lineTo(nb[0], nb[1]); c.stroke();
    // 挖回纸白（边缘柔，像墨在湿纸上自己让开）
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000'; c.filter = `blur(${Math.max(1, Math.round(2.5 * s * (o.zs ?? 1)))}px)`;
    path(c, ell(3, -1, 49, 17)); c.fill();
    const nc = T(lp2(nk0, nk1, .1)); c.lineWidth = 11 * s; c.beginPath(); c.moveTo(nc[0], nc[1]); c.lineTo(...T(lp2(nk0, nk1, .5)).slice(0, 2)); c.stroke();
    c.restore();
  }
  wing(true, g('wing2') * (o.farWing ?? 1), g('wing2') * (o.farWing ?? 1));
  // 鹤身：背线（清墨，暗面朝上）+ 腹线（淡墨，暗面朝下），中间留白
  S([[-44, -10, .6], [-15, -19, 1], [22, -18, 1], [46, -10, .6]], { w: 7, tone: .26, darkDir: [0, -1], side: .7, dry: .4, wet: .7, prof: 'tip', seed: 201 }, g('body'));
  S([[-36, 8, .5], [-5, 18, 1], [30, 16, 1], [52, 6, .5]], { w: 8, tone: .3, darkDir: [0, 1], side: .75, dry: .45, wet: .75, prof: 'tip', seed: 202 }, g('body'));
  // 尾羽（黑色三级飞羽，下垂/后拖）
  const ta = pose.tail * D2R;
  for (let i = 0; i < 3; i++) {
    const b0 = [40 + i * 3, -6 + i * 4], len = 34 - i * 4, an = ta + (i - 1) * .2;
    S([[...b0, 1], [b0[0] + Math.cos(an) * len * .55, b0[1] + Math.sin(an) * len * .55, .9], [b0[0] + Math.cos(an) * len, b0[1] + Math.sin(an) * len, .25]], { w: 9, tone: TONE.nong, dry: .38, wet: .5, prof: 'nail', seed: 220 + i }, g('wing1'));
  }
  // 腿：焦墨细线，膝反折
  for (let i = 0; i < 2; i++) {
    const [h, kn, f] = pose.legs[i];
    S([[...h, .8], [...kn, 1], [...f, .7]], { w: 2.6, tone: i ? TONE.zhong : TONE.nong, dry: .35, wet: .2, prof: 'even', rough: .05, seed: 240 + i }, g('legs'));
    if (g('legs') >= 1) { const ff = T(f); const d2 = T([f[0] - 9, f[1] + 1]); draw(L, mk([ff, d2], { w: 2.2 * s, tone: TONE.nong, dry: .3, prof: 'tip', seed: 250 + i }), 1, am); }
  }
  // 近翼
  wing(false, g('wing1'), g('wing1'));
  // 颈：一笔焦墨（颈根留白一小段）
  const nk = pose.neck;
  // 颈根粗、近头处收细（一笔由按到提），墨重的一侧在颈背
  S([[...lp2(nk[0], nk[1], .3), 1.25], [...nk[1], 1.1], [...nk[2], .85], [...lp2(nk[2], nk[3], .72), .58]], { w: 11, tone: TONE.jiao, dry: .26, wet: .35, prof: NECKP, rough: .08, seed: 260 }, g('neck'));
  // 头：白，额前一点焦墨，喙用重墨
  if (g('neck') >= .98) {
    const hd = nk[3], ha = pose.hd * D2R, bx = Math.cos(ha), by = -Math.sin(ha);
    const h = T(hd), tip = T([hd[0] + bx * 30, hd[1] + by * 30]), mid = T([hd[0] + bx * 14, hd[1] + by * 14 + 1]);
    draw(L, mk([T([hd[0] + bx * 6, hd[1] + by * 6 - 2]), mid, tip], { w: 4.2 * s, tone: TONE.zhong, dry: .3, prof: 'nail', seed: 270 + k % 2 }), 1, am);
    blot(L.dry, ...T([hd[0] + bx * 3, hd[1] + by * 3 - 3]).slice(0, 2), 2.1 * s, .9 * am, 0, 1, 7);  // 眼
    draw(L, mk([T([hd[0] - bx * 9, hd[1] - by * 9 + 3]), T([hd[0] + bx * 4, hd[1] + by * 4 + 7])], { w: 4 * s, tone: TONE.jiao, dry: .3, prof: 'lens', seed: 275 }), 1, am * .9);   // 面颊黑
    // 后脑淡线
    draw(L, mk([T([hd[0] + bx * 2 - by * 6, hd[1] + by * 2 - 9]), T([hd[0] - bx * 9, hd[1] - by * 9 - 4])], { w: 2.4 * s, tone: TONE.dan, dry: .4, prof: 'tip', seed: 276 }), 1, am);
    // 丹顶：一点朱红（col 层）
    const cr = g('crown');
    if (cr > 0 && L.col) {
      const p = T([hd[0] - bx * 1, hd[1] - by * 1 - 6.5]);
      const c = L.col; c.save(); c.globalAlpha = clamp(am * cr) * .95; c.fillStyle = `rgb(${VERM.join(',')})`;
      c.beginPath(); c.ellipse(p[0], p[1], 4.2 * s * (.4 + .6 * cr), 2.9 * s * (.4 + .6 * cr), -pose.pitch * Math.PI / 180, 0, 7); c.fill(); c.restore();
    }
  }
  return { head: T(nk[3]), body: T([0, 0]), feet: T(pose.legs[0][2]) };
}

// 一根羽毛（静默里飘落的那根）：白羽 + 焦墨羽尖
export function feather(L, x, y, s, ang, am = 1) {
  if (am <= 0) return;
  const c = Math.cos(ang), sn = Math.sin(ang), T = p => [x + (p[0] * c - p[1] * sn) * s, y + (p[0] * sn + p[1] * c) * s, p[2] ?? 1];
  draw(L, mk([[-44, -2, .3], [-10, -9, 1], [26, -7, .3]].map(T), { w: 2.4 * s, tone: .4, dry: .45, prof: 'tip', seed: 401 }), 1, am);
  draw(L, mk([[-44, 2, .3], [-8, 12, 1], [22, 9, .3]].map(T), { w: 3 * s, tone: .34, dry: .5, prof: 'lens', seed: 402 }), 1, am);
  draw(L, mk([[-56, 1, .8], [-6, 1, .9], [30, -1, .3]].map(T), { w: 1.6 * s, tone: TONE.zhong, dry: .3, prof: 'tip', seed: 403 }), 1, am);
  draw(L, mk([[16, -4, .8], [28, 0, 1], [36, 4, .2]].map(T), { w: 9 * s, tone: TONE.nong, dry: .4, prof: 'lens', seed: 405 }), 1, am);
}
