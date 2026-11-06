// 夏帆（少女）：草帽、上身（水手领连衣裙）、手、侧面骑车全身；头部用 head80（同一个头函数画所有镜头）
import { cel, path, poly, ribbon, flutter, line, TAU, rgba, mix, LWK } from './cel.js';
import { head80 } from './head80.js';

// 头部统一参数：长发（披肩发尾随风飘）、无护目镜、无耳机、无发圈
export function head(g, P, o = {}) {
  head80(g, P, { goggles: false, headset: false, tie: false, body: false, tail: { x: o.view === 'side' ? -40 : -46, y: -40, len: 1.05, w: 1.15, n: 5, dy: 9 }, ...o });
}

// 长发后片（头部局部坐标，在 bust 之前画）：从后脑垂到肩后的长发绺，随风向后（局部 -x）飘，和 S3 的散发同一套
export function longBack(g, P, o = {}) {
  const ph = o.ph || 0, wind = o.wind ?? .7, rim = o.rim;
  const st = { s: P.hair.s, h: P.hair.h, l: P.hair.l, lw: 1.5, rim };
  const roots = [[-30, -30], [-52, -12], [-66, 12], [-70, 40], [-62, 66], [-46, 84]];
  for (let k = 0; k < roots.length; k++) {
    const [x, y] = roots[k];
    const ang = Math.PI / 2 + .25 + wind * (.55 + k * .08);   // 向下偏后
    const len = (300 + (k % 3) * 46 - k * 10) * (o.len || 1);
    const sp = flutter(x, y, ang, len, 14, (8 + k * 3) * wind + 3, 1.1, ph * TAU + k * 1.3, -(14 + k * 6) * wind);
    cel(g, ribbon(sp, u => Math.pow(1 - u, .8) * (64 - k * 4) + 1), { ...st, f: k % 2 ? P.hair.s : P.hair.f, so: [-8, -6] });
  }
}

// 分段手臂：上臂 + 肘部弯折 + 前臂画成一整块赛璐璐（外侧肘尖、内侧肘窝线），短袖带水手服袖口；SH 肩点，HA 手腕
export function arm(g, P, SH, HA, o = {}) {
  const l1 = o.l1 ?? 120, l2 = o.l2 ?? 116, rim = o.rim;
  const EL = ik(SH, HA, l1, l2, o.bend ?? 1);
  const nrm = (x, y) => { const d = Math.hypot(x, y) || 1; return [x / d, y / d]; };
  const u1 = nrm(EL[0] - SH[0], EL[1] - SH[1]), u2 = nrm(HA[0] - EL[0], HA[1] - EL[1]);
  const n1 = [-u1[1], u1[0]], n2 = [-u2[1], u2[0]], nb = nrm(n1[0] + n2[0], n1[1] + n2[1]);
  const inner = Math.sign(nb[0] * (u2[0] - u1[0]) + nb[1] * (u2[1] - u1[1])) || 1;   // +nb 侧是不是肘窝
  const at = (c, n, w) => [c[0] + n[0] * w, c[1] + n[1] * w];
  const mid = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const ws = 23, we = 16.5, wf = 15, ww = 11.5;
  const side = s => {   // s = ±1
    const outer = s !== inner;
    const e = at(EL, nb, s * we * (outer ? 1.12 : .82)); if (outer) e.push(1);
    return [at(SH, n1, s * ws), at(mid(SH, EL, .5), n1, s * (ws + we) / 2 * (outer ? 1.02 : .96)), e, at(mid(EL, HA, .4), n2, s * wf), [...at(HA, n2, s * ww), 1]];
  };
  const pts = [...side(1), ...side(-1).reverse()];   // 手腕两点是尖角（被手盖住）
  const sk = { f: P.skin.f, s: P.skin.s, so: o.so || [3, -5], h: P.skin.h, l: P.skin.l, lw: 1.5, rim };
  cel(g, pts, sk);
  const c0 = at(EL, nb, inner * we * .5);
  line(g, [[c0[0] - u1[0] * 9, c0[1] - u1[1] * 9], [c0[0] + u2[0] * 7, c0[1] + u2[1] * 7]], mix(P.skin.l, P.skin.f, .35), 1.1);
  // 短袖（泡泡袖）+ 藏青袖口 + 白线
  const s1 = mid(SH, EL, .46), top = [SH[0] - u1[0] * 22, SH[1] - u1[1] * 22];
  const sl = [at(top, n1, 28), at(mid(top, s1, .5), n1, 36), at(s1, n1, 31), [...at(s1, n1, -31)], at(mid(top, s1, .5), n1, -36), at(top, n1, -28)];
  cel(g, sl, { f: P.dress.f, s: P.dress.s, so: [6, -6], h: P.dress.h, l: P.dress.l, lw: 1.5, rim, clipFn: gg => {
    const c = at(s1, u1, -10), d = at(s1, u1, 4);
    gg.fillStyle = P.collar.f; gg.fill(poly([at(c, n1, 60), at(d, n1, 60), at(d, n1, -60), at(c, n1, -60)]));
    line(gg, [at(at(s1, u1, -5), n1, 60), at(at(s1, u1, -5), n1, -60)], P.dress.f, 2.4);
    line(gg, [at(mid(top, s1, .55), n1, 14), at(mid(top, s1, .9), n1, 10)], rgba(P.dress.l, .45), 1.1);   // 袖褶
  } });
  return EL;
}

// —— 草帽 ——  局部坐标：帽檐中心 (0,0)。q：俯视程度 -1..1（>0 看到帽顶，<0 看到帽里），rot：画面内旋转
export function hat(g, P, o = {}) {
  const q = o.q ?? .22, rot = o.rot || 0, s = o.s || 1, ph = o.ph || 0, wind = o.wind ?? .6, rim = o.rim;
  const aq = Math.abs(q), ry = Math.max(13, 150 * aq), crH = 92 * (1 - aq * .75) + 8;
  g.save(); g.rotate(rot); g.scale(s, s);
  const st = { f: P.straw.f, s: P.straw.s, h: P.straw.h, l: P.straw.l, lw: 2, rim };
  // 丝带尾巴（在帽子后面飘）
  if (o.tails !== false) for (let k = 0; k < 2; k++) {
    const sp = flutter(-60 + k * 10, -crH * .25 * Math.sign(q || 1), Math.PI + .15 - k * .25 + (o.tailAng || 0), 190 - k * 40, 12, 16 + k * 6, 1.3, ph * TAU + k * 1.7, 18 * wind);
    cel(g, ribbon(sp, u => 20 - u * 10 - k * 3), { f: k ? P.ribbon.s : P.ribbon.f, s: P.ribbon.s, so: [0, -6], h: P.ribbon.h, ho: [0, 3], l: P.ribbon.l, lw: 1.6, rim });
  }
  const brim = new Path2D(); brim.ellipse(0, 0, 150, ry, 0, 0, TAU);
  if (q >= 0) {
    // 帽檐（上面），草编纹：同心椭圆细线
    cel(g, brim, { ...st, so: [0, ry * .22], ho: [0, -ry * .1], clipFn: gg => {
      gg.strokeStyle = rgba(P.straw.l, .22); gg.lineWidth = 1.2 * LWK.k;
      for (let k = 1; k < 6; k++) { gg.beginPath(); gg.ellipse(0, 0, 150 * k / 6, ry * k / 6, 0, 0, TAU); gg.stroke(); }
    } });
    // 帽冠
    const cw = 70, cb = ry * .47;
    const crown = path([[-cw, -2, 1], [-cw * .98, -crH * .7], [-cw * .7, -crH], [0, -crH * 1.06], [cw * .7, -crH], [cw * .98, -crH * .7], [cw, -2, 1], [cw * .6, cb * .55], [0, cb * .7], [-cw * .6, cb * .55]], true);
    cel(g, crown, { ...st, so: [10, 4], ho: [-6, -5], clipFn: gg => {
      // 丝带帽箍
      gg.fillStyle = P.ribbon.f; gg.fill(path([[-cw - 4, -crH * .28], [0, -crH * .28 + cb * .7], [cw + 4, -crH * .28], [cw + 4, 4], [0, cb * .75], [-cw - 4, 4]], true));
      gg.fillStyle = P.ribbon.s; gg.fill(path([[cw * .35, -crH * .28 + cb * .4], [cw + 4, -crH * .28], [cw + 4, 4], [cw * .35, cb * .5]], true));
      gg.fillStyle = P.ribbon.h; gg.fillRect(-cw * .7, -crH * .28 + cb * .45, cw * .5, 3);
      gg.strokeStyle = rgba(P.straw.l, .2); gg.lineWidth = 1.2 * LWK.k;
      for (let k = 1; k < 4; k++) { gg.beginPath(); gg.moveTo(-cw, -crH * (.35 + k * .17)); gg.quadraticCurveTo(0, -crH * (.35 + k * .17) + cb * .6, cw, -crH * (.35 + k * .17)); gg.stroke(); }
    } });
    // 蝴蝶结
    if (o.bow !== false) {
      const bx = -cw * .78, by = -crH * .14;
      cel(g, [[bx, by, 1], [bx - 30, by - 22], [bx - 34, by + 14], [bx, by + 4, 1]], { f: P.ribbon.f, s: P.ribbon.s, so: [4, 4], l: P.ribbon.l, lw: 1.5, rim });
      cel(g, [[bx, by, 1], [bx + 22, by - 20], [bx + 26, by + 12], [bx, by + 4, 1]], { f: P.ribbon.f, s: P.ribbon.s, so: [4, 4], l: P.ribbon.l, lw: 1.5, rim });
    }
  } else {
    // 看到帽里：帽檐下面更暗 + 帽冠的洞
    cel(g, brim, { f: P.straw.s, s: mix(P.straw.s, P.straw.l, .3), so: [0, -ry * .2], l: P.straw.l, lw: 2, rim, clipFn: gg => {
      gg.strokeStyle = rgba(P.straw.l, .25); gg.lineWidth = 1.2 * LWK.k;
      for (let k = 2; k < 6; k++) { gg.beginPath(); gg.ellipse(0, 0, 150 * k / 6, ry * k / 6, 0, 0, TAU); gg.stroke(); }
    } });
    const hole = new Path2D(); hole.ellipse(0, 0, 68, ry * .46, 0, 0, TAU);
    cel(g, hole, { f: mix(P.straw.s, P.straw.l, .55), l: P.straw.l, lw: 1.5 });
    g.fillStyle = P.ribbon.s; g.fillRect(-70, -2, 0, 0);
  }
  g.restore();
}

// 戴在头上的草帽（head80 局部坐标），tilt：帽子被风掀起的程度 0..1
export function hatOnHead(g, P, view, o = {}) {
  const lift = o.lift || 0;
  g.save();
  const ox = view === 'side' ? 6 : view === 'front' ? 0 : -6, oy = -62;
  g.translate(ox - lift * 40, oy - lift * 60);
  g.rotate((view === 'side' ? -.08 : -.1) - lift * .5 + (o.mirror ? 0 : 0));
  hat(g, P, { q: (view === 'front' ? .16 : .2) + lift * .3, s: view === 'side' ? .9 : .95, ...o });
  g.restore();
}

// —— 上身（head80 局部坐标，肩线约 y=150）：水手领短袖连衣裙 ——
export function bust(g, P, o = {}) {
  const dx = o.view === 'front' ? 0 : o.view === 'side' ? -30 : -14, dy = o.shoulders || 0, rim = o.rim;
  // 躯干
  cel(g, [[-178 + dx, 360], [-172 + dx, 214 + dy], [-132 + dx, 164 + dy], [-52 + dx, 142 + dy * .5], [44 + dx, 142 + dy * .5], [118 + dx, 160 + dy], [160 + dx, 210 + dy], [166 + dx, 360]],
    { f: P.dress.f, s: P.dress.s, so: [-26, -8], h: P.dress.h, ho: [8, 6], l: P.dress.l, lw: 1.7, rim });
  // 袖口（短袖）
  for (const sx of [-1, 1]) {
    const x0 = sx < 0 ? -172 + dx : 160 + dx;
    cel(g, [[x0, 214 + dy], [x0 + sx * 18, 252 + dy], [x0 + sx * 10, 292], [x0 - sx * 34, 290], [x0 - sx * 30, 230 + dy]], { f: P.dress.f, s: P.dress.s, so: [-sx * 10, -6], l: P.dress.l, lw: 1.5, rim });
  }
  // 水手领（藏青 + 白线），前面 V 字
  const col = [[-150 + dx, 186 + dy], [-60 + dx, 140 + dy * .5], [0 + dx, 146], [46 + dx, 140 + dy * .5], [134 + dx, 184 + dy], [80 + dx, 214], [10 + dx, 262, 1], [-70 + dx, 214]];
  cel(g, col, { f: P.collar.f, s: P.collar.s, so: [-10, -6], h: P.collar.h, l: P.collar.l, lw: 1.6, rim, clipFn: gg => {
    gg.strokeStyle = P.dress.f; gg.lineWidth = 4 * LWK.k;
    gg.stroke(path([[-130 + dx, 188 + dy], [-58 + dx, 156], [-4 + dx, 160], [40 + dx, 154], [112 + dx, 186], [64 + dx, 206], [10 + dx, 246], [-60 + dx, 206]], true));
  } });
  // V 领里面的皮肤
  if (o.neck) {
    // 脖子与 V 领皮肤画成同一块赛璐璐（没有横穿喉咙的接缝线 / 项圈线）；头部用 neck:false，脸盖住脖子上端
    const nk = o.view === 'front' ? [[-26, 60], [26, 60], [29, 136], [48 + dx, 152], [10 + dx, 232, 1], [-28 + dx, 152], [-29, 136]]
      : [[-38, 56], [14, 84], [17, 136], [34 + dx + 14, 152], [10 + dx, 232, 1], [-28 + dx, 152], [-41, 136]];
    cel(g, nk, { f: P.skin.f, s: P.skin.s, l: P.skin.l, lw: 1.1, rim: null,
      sh: [[[-48, 50], [24, 50], [24, 98], [2, 120], [-28, 110], [-48, 92]], [[-28 + dx, 152], [-6 + dx, 150], [10 + dx, 232]]] });
  } else cel(g, [[-28 + dx, 150], [48 + dx, 150], [10 + dx, 230, 1]], { f: P.skin.f, s: P.skin.s, sh: [[[-28 + dx, 150], [48 + dx, 150], [40 + dx, 168], [-20 + dx, 168]]], l: P.skin.l, lw: 1.1 });
  // 领结（深蓝）
  cel(g, [[10 + dx, 232, 1], [-30 + dx, 250], [-22 + dx, 290, 1], [10 + dx, 262], [40 + dx, 290, 1], [48 + dx, 250]], { f: P.collar.f, s: P.collar.s, so: [-4, -4], l: P.collar.l, lw: 1.4 });
}

// —— 手（握东西的手：一块掌 + 拇指 + 并拢的四指），dir: 1 指尖朝右 ——
export function hand(g, P, x, y, ang, s = 1, o = {}) {
  g.save(); g.translate(x, y); g.rotate(ang); g.scale(s, s);
  const st = { f: P.skin.f, s: P.skin.s, so: [-3, 4], h: P.skin.h, l: P.skin.l, lw: 1.3, rim: o.rim };
  cel(g, [[-20, -12], [6, -16], [24, -10], [30, 4], [20, 16], [-4, 18], [-22, 10]], st);         // 掌 + 并拢四指
  line(g, [[6, -6], [24, -2]], mix(P.skin.l, P.skin.f, .4), 1);
  line(g, [[4, 4], [22, 8]], mix(P.skin.l, P.skin.f, .4), 1);
  cel(g, [[-8, -12], [8, -26], [20, -26], [14, -14], [2, -6]], st);                             // 拇指
  g.restore();
}

// 两段 IK：A→B，长度 l1,l2，bend = ±1 选择关节弯曲方向
export function ik(A, B, l1, l2, bend = 1) {
  const dx = B[0] - A[0], dy = B[1] - A[1]; let d = Math.hypot(dx, dy);
  d = Math.min(d, l1 + l2 - .01); d = Math.max(d, Math.abs(l1 - l2) + .01);
  const a = Math.atan2(dy, dx), c = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), th = Math.acos(Math.max(-1, Math.min(1, c)));
  const ang = a - bend * th;
  return [A[0] + Math.cos(ang) * l1, A[1] + Math.sin(ang) * l1];
}
// 圆头锥形肢体
export function limb(a, b, w1, w2) {
  const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, px = -uy, py = ux;
  const r1 = w1 / 2, r2 = w2 / 2, pts = [];
  const cap = (c, r, s) => { const out = []; for (let k = 0; k <= 4; k++) { const an = -Math.PI / 2 + k * Math.PI / 4; const ca = Math.cos(an), sa = Math.sin(an); out.push([c[0] + (ux * ca * s + px * sa * s) * r, c[1] + (uy * ca * s + py * sa * s) * r]); } return out; };
  return cap(b, r2, 1).concat(cap(a, r1, -1));
}

// —— 自行车（侧面，朝右）：原点 = 中轴正下方地面 ——
export const BK = { R: 118, RW: [-238, -118], FW: [236, -118], BB: [0, -112], CR: 54, SEAT: [-74, -342], HT: [168, -340], HTB: [190, -268], GRIP: [124, -398] };
function wheel(g, P, c, ang, speed, rim) {
  const [x, y] = c, R = BK.R;
  g.save(); g.translate(x, y);
  const tire = new Path2D(); tire.arc(0, 0, R, 0, TAU); tire.arc(0, 0, R - 13, 0, TAU, true);
  cel(g, tire, { f: P.tire.f, s: P.tire.s, so: [-6, -8], h: P.tire.h, ho: [3, 4], l: P.tire.l, lw: 2.2, rim });
  const rimP = new Path2D(); rimP.arc(0, 0, R - 13, 0, TAU); rimP.arc(0, 0, R - 20, 0, TAU, true);
  cel(g, rimP, { f: P.chrome.f, s: P.chrome.s, so: [-3, -3], l: P.chrome.l, lw: 1.2 });
  // 辐条：慢速时清楚，快速时变成模糊盘 + 速度弧线
  g.globalAlpha = Math.max(.12, 1 - speed * .85);
  g.strokeStyle = P.chrome.s; g.lineWidth = 1.4 * LWK.k;
  for (let k = 0; k < 18; k++) { const a = ang + k * TAU / 18; g.beginPath(); g.moveTo(Math.cos(a + .3) * 9, Math.sin(a + .3) * 9); g.lineTo(Math.cos(a) * (R - 20), Math.sin(a) * (R - 20)); g.stroke(); }
  g.globalAlpha = 1;
  if (speed > .2) {
    g.fillStyle = rgba(P.chrome.f, .14 * speed); g.beginPath(); g.arc(0, 0, R - 20, 0, TAU); g.fill();
    g.strokeStyle = rgba('#ffffff', .6 * speed); g.lineCap = 'round'; g.lineWidth = 2.6;
    for (let k = 0; k < 3; k++) { const a = -ang * 1.3 + k * 2.1; g.beginPath(); g.arc(0, 0, R - 30 - k * 14, a, a + .8); g.stroke(); }
  }
  const hub = new Path2D(); hub.arc(0, 0, 12, 0, TAU);
  cel(g, hub, { f: P.chrome.f, s: P.chrome.s, so: [-3, -3], l: P.chrome.l, lw: 1.4 });
  g.restore();
}
const tube = (a, b, w) => limb(a, b, w, w);
export function bicycle(g, P, o) {
  const ang = o.wheelA || 0, sp = o.speed ?? .6, rim = o.rim;
  const fr = { f: P.frame.f, s: P.frame.s, so: [-3, -4], h: P.frame.h, ho: [2, 2], l: P.frame.l, lw: 1.8, rim };
  wheel(g, P, BK.RW, ang, sp, rim);
  wheel(g, P, BK.FW, ang + .7, sp, rim);
  // 链条 + 链盘
  line(g, [[BK.BB[0], BK.BB[1] - 30], [BK.RW[0], BK.RW[1] - 14]], P.dark.s, 3);
  line(g, [[BK.BB[0], BK.BB[1] + 30], [BK.RW[0], BK.RW[1] + 14]], P.dark.s, 3);
  // 车架（女式低跨，弯下管）
  cel(g, tube(BK.BB, BK.RW, 14), fr);
  cel(g, tube([-58, -300], BK.RW, 12), fr);
  cel(g, tube(BK.BB, [-60, -300], 20), fr);
  cel(g, path([[BK.HTB[0] - 8, BK.HTB[1] - 10], [110, -190], [20, -120], [4, -100], [18, -132], [118, -206], [BK.HTB[0] + 10, BK.HTB[1] + 8]], true), fr);
  cel(g, tube(BK.HT, BK.HTB, 22), fr);
  // 前叉
  cel(g, tube(BK.HTB, BK.FW, 12), { ...fr, f: P.chrome.f, s: P.chrome.s, h: P.chrome.h, l: P.chrome.l });
  // 挡泥板
  line(g, [[BK.RW[0] - 120, BK.RW[1] + 30], [BK.RW[0] - 90, BK.RW[1] - 85], [BK.RW[0], BK.RW[1] - 130], [BK.RW[0] + 70, BK.RW[1] - 106]], P.chrome.s, 5);
  line(g, [[BK.FW[0] - 60, BK.FW[1] - 112], [BK.FW[0] + 30, BK.FW[1] - 128], [BK.FW[0] + 110, BK.FW[1] - 50]], P.chrome.s, 5);
  // 座管 + 鞍座
  cel(g, tube([-60, -300], [BK.SEAT[0] + 6, BK.SEAT[1] + 12], 10), { ...fr, f: P.chrome.f, s: P.chrome.s, l: P.chrome.l });
  cel(g, [[BK.SEAT[0] - 46, BK.SEAT[1] + 2], [BK.SEAT[0] - 40, BK.SEAT[1] - 16], [BK.SEAT[0] + 30, BK.SEAT[1] - 14], [BK.SEAT[0] + 44, BK.SEAT[1] - 2], [BK.SEAT[0] + 2, BK.SEAT[1] + 14]], { f: P.dark.f, s: P.dark.s, so: [0, -5], h: P.dark.h, ho: [0, 3], l: P.dark.l, lw: 1.6 });
  // 车把（后掠城市把）
  line(g, [BK.HT, [BK.HT[0] + 4, BK.HT[1] - 40], [BK.GRIP[0] + 40, BK.GRIP[1] + 6], BK.GRIP], P.chrome.l, 7);
  line(g, [BK.HT, [BK.HT[0] + 4, BK.HT[1] - 40], [BK.GRIP[0] + 40, BK.GRIP[1] + 6], BK.GRIP], P.chrome.f, 4);
  cel(g, tube([BK.GRIP[0] - 4, BK.GRIP[1]], [BK.GRIP[0] + 22, BK.GRIP[1] + 4], 13), { f: P.dark.f, l: P.dark.l, lw: 1.4 });
  // 前车篮
  const bx = BK.HT[0] + 22, by = BK.HT[1] - 26;
  cel(g, poly([[bx, by], [bx + 120, by - 6], [bx + 108, by + 74], [bx + 12, by + 78]]), { f: P.basket.f, s: P.basket.s, so: [-8, -6], h: P.basket.h, l: P.basket.l, lw: 1.8, rim, clipFn: gg => {
    gg.strokeStyle = rgba(P.basket.l, .45); gg.lineWidth = 1.5 * LWK.k;
    for (let k = 1; k < 5; k++) { gg.beginPath(); gg.moveTo(bx, by + k * 16); gg.lineTo(bx + 120, by + k * 16 - 2); gg.stroke(); }
    for (let k = 1; k < 7; k++) { gg.beginPath(); gg.moveTo(bx + k * 17, by - 4); gg.lineTo(bx + k * 16 + 4, by + 80); gg.stroke(); }
  } });
  // 车灯
  cel(g, poly([[bx + 112, by + 24], [bx + 130, by + 20], [bx + 132, by + 44], [bx + 114, by + 44]]), { f: '#fff6d8', l: P.chrome.l, lw: 1.4 });
}

// —— 侧面骑车全身 ——  o: crank 曲柄角, stand 0..1 站起, turn 0..1 回头, hat 'on'|'lift'|'off', lift 0..1, expr, ph(飘动相位), wind, rim
export function rider(g, P, o) {
  const cr = o.crank || 0, stand = o.stand || 0, rim = o.rim, ph = o.ph || 0, bob = o.bob || 0;
  const L = (a, b, u) => a + (b - a) * u;
  const fd = o.footDown || 0;   // 0..1：停车时滑到座前、近侧脚放到地上撑住
  const hip = [L(L(-66, -12, stand), -40, fd), L(L(-372, -452, stand), -352, fd) + bob];
  const sh = [hip[0] + L(92, 128, stand), hip[1] + L(-210, -184, stand)];
  const neck = [sh[0] + 22, sh[1] - 26];
  const ped = s => [BK.BB[0] + Math.cos(cr + s) * BK.CR, BK.BB[1] + Math.sin(cr + s) * BK.CR];
  const skin = { f: P.skin.f, s: P.skin.s, so: [-4, -6], h: P.skin.h, l: P.skin.l, lw: 1.6, rim };
  const legDraw = (side, far) => {
    const pp = ped(side), down = far ? 0 : fd, p = [L(pp[0], 14, down), L(pp[1], -14, down)], knee = ik(hip, p, 176, 168, -1);
    const sk = far ? { ...skin, f: P.skin.s, s: mix(P.skin.s, P.skin.l, .25), rim: null } : skin;
    cel(g, limb(hip, knee, 52, 40), sk);
    cel(g, limb(knee, p, 38, 26), sk);
    // 袜子 + 运动鞋
    const ang = Math.atan2(p[1] - knee[1], p[0] - knee[0]);
    const so = [knee[0] + (p[0] - knee[0]) * .78, knee[1] + (p[1] - knee[1]) * .78];
    cel(g, limb(so, p, 30, 28), { f: far ? P.sock.s : P.sock.f, l: P.sock.l, lw: 1.4 });
    g.save(); g.translate(p[0], p[1]); g.rotate(L(-.12 + Math.sin(cr + side) * .1, .04, down));
    cel(g, [[-26, -14], [10, -18], [44, -6], [48, 8, 1], [-28, 10, 1]], { f: far ? P.shoe.s : P.shoe.f, s: P.shoe.s, so: [0, -6], l: P.shoe.l, lw: 1.5, rim: far ? null : rim });
    if (!far) { g.fillStyle = P.shoeStripe; g.fill(poly([[-6, -14], [6, -16], [16, 6], [4, 8]])); }
    g.restore();
    // 脚踏板
    cel(g, poly([[pp[0] - 22, pp[1] + 9], [pp[0] + 22, pp[1] + 9], [pp[0] + 22, pp[1] + 16], [pp[0] - 22, pp[1] + 16]]), { f: P.dark.f, l: P.dark.l, lw: 1.2 });
    return knee;
  };
  // 远侧腿（在车架后面）
  g.save(); g.translate(0, 0); legDraw(Math.PI, true); g.restore();
  // 长发在身体后面：由头部函数画；远侧手臂省略（被身体挡住）
  bicycle(g, P, o);
  // 曲柄
  const pn = ped(0); line(g, [BK.BB, pn], P.chrome.s, 9); line(g, [BK.BB, pn], P.chrome.f, 5);
  const kn = legDraw(0, false);
  // 躯干（沿脊柱的局部坐标：u 向上，n 向前）
  const wst = [hip[0] + 14, hip[1] - 50];
  const ux = sh[0] - wst[0], uy = sh[1] - wst[1], ul = Math.hypot(ux, uy), Ux = ux / ul, Uy = uy / ul, Nx = -Uy, Ny = Ux;
  const NX = Ny < 0 ? -Nx : Nx, NY = Ny < 0 ? -Ny : Ny;   // n 朝前（画面右）
  const fx = Nx > 0 ? Nx : -Nx, fy = Nx > 0 ? Ny : -Ny;
  const TP = (a, n) => [wst[0] + Ux * ul * a + fx * n, wst[1] + Uy * ul * a + fy * n];
  const wd = o.wind ?? .8;
  // 裙子：前缘贴着大腿到膝上，后缘在座位后面随风飘
  const kfrac = [hip[0] + (kn[0] - hip[0]) * .82, hip[1] + (kn[1] - hip[1]) * .82];
  const tl = Math.hypot(kn[0] - hip[0], kn[1] - hip[1]), tnx = -(kn[1] - hip[1]) / tl, tny = (kn[0] - hip[0]) / tl;
  const up = tny < 0 ? 1 : -1;
  const kTop = [kfrac[0] + tnx * 26 * up, kfrac[1] + tny * 26 * up], kBot = [kfrac[0] - tnx * 30 * up, kfrac[1] - tny * 30 * up];
  const hem = flutter(hip[0] - 30, hip[1] + 6, Math.PI * .86 - stand * .25, 120 + stand * 30, 9, 9 * wd + 4, 1.5, ph * TAU, -14 * wd);
  cel(g, path([TP(0, 34), kTop, [kTop[0] + 10, (kTop[1] + kBot[1]) / 2, 1], kBot, [hip[0] + 6, hip[1] + 28], ...hem.slice(1).map((p, i) => [p[0], p[1] + 22 + i * 1.5]), [hem[hem.length - 1][0] + 4, hem[hem.length - 1][1] - 16, 1], ...hem.slice(1, -1).reverse().map(p => [p[0], p[1] - 14]), TP(0, -40)], true),
    { f: P.dress.f, s: P.dress.s, so: [8, -12], h: P.dress.h, l: P.dress.l, lw: 1.8, rim, clipFn: gg => { line(gg, [[hip[0] + 30, hip[1] + 4], [kfrac[0] - 30, kfrac[1] + 8]], rgba(P.dress.l, .45), 1.2); line(gg, [hem[2], [hip[0] - 4, hip[1] + 10]], rgba(P.dress.l, .45), 1.2); } });
  // 躯干：背、胸、腰
  cel(g, path([TP(0, -40), TP(.45, -44), TP(.86, -40), TP(1.02, -22), TP(1.04, 4), TP(.95, 22), TP(.74, 42), TP(.58, 38), TP(.38, 30), TP(.12, 33), TP(0, 34)], true),
    { f: P.dress.f, s: P.dress.s, so: [-14, -10], h: P.dress.h, ho: [4, 4], l: P.dress.l, lw: 1.8, rim, clipFn: gg => {
      gg.fillStyle = P.collar.f; gg.fill(path([TP(1.1, -46), TP(1.06, 10), TP(.92, -6), TP(.7, -30), TP(.62, -50)], true));
      line(gg, [TP(.66, -44), TP(.86, -12), TP(1.0, 4)], P.dress.f, 3);
      gg.fillStyle = P.collar.s; gg.fill(path([TP(.9, 18), TP(.78, 40), TP(.7, 30), TP(.86, 12)], true));
      line(gg, [TP(.08, -36), TP(.08, 32)], rgba(P.dress.l, .5), 1.4);
    } });
  // 近侧手臂 → 车把
  const grip = [BK.GRIP[0] + 10, BK.GRIP[1] - 4];
  const elb = ik([sh[0] + 6, sh[1] + 16], grip, 108, 104, 1);
  cel(g, limb([sh[0] + 6, sh[1] + 16], elb, 34, 28), skin);
  cel(g, limb(elb, grip, 28, 22), skin);
  // 短袖
  cel(g, limb([sh[0] - 4, sh[1] + 10], [L(sh[0] + 6, elb[0], .45), L(sh[1] + 16, elb[1], .45)], 50, 42), { f: P.dress.f, s: P.dress.s, so: [-6, -6], l: P.dress.l, lw: 1.6, rim });
  hand(g, P, grip[0] + 4, grip[1] + 2, .1, .9, { rim });
  // 头
  g.save(); g.translate(neck[0] + 4, neck[1] - 46); g.rotate(o.headRot ?? (.08 + stand * .1)); g.scale(.56, .56);
  const turn = o.turn || 0;
  let view = 'side', mir = false;
  if (turn > .66) { view = 'q'; mir = true; } else if (turn > .33) view = 'front';
  if (mir) g.scale(-1, 1);
  head(g, P, { view, expr: o.expr || 'determined', ph, wind: o.hairWind ?? .9, rim, neck: true, neckEnd: 150, tail: { x: view === 'side' ? -40 : -46, y: -40, len: 1.1, w: 1.15, n: 5, dy: 9, ang: mir ? .25 : view === 'front' ? 2.4 : null } });
  if (o.hat !== 'off') hatOnHead(g, P, view, { lift: o.lift || 0, ph, rim: o.hatRim || rim, wind: 1 });
  g.restore();
}
