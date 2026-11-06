// 灯塔守夜 · 六幅版画。每个镜头 { id, t0, t1, draw(g, t, lt), events() }
import * as WC from './engine/index.js';
import * as ST from './stage.js';
import * as WD from './world.js';
import { K, T, SHOTS as SH, DUR } from './timeline.js';
import { clamp, lerp, seg, ss, eio, eo, ei, mulberry } from '/core/lib.js';
import { curl, peelState } from './trans.js';

const { W, H, PW, PH, IMG, m, c } = ST;
const PI = Math.PI;
const sh = id => { const s = SH.find(s => s.id === id); return { t0: T(s.b0), t1: T(s.b1) }; };
const bump = (t, a, w) => { const u = (t - a) / w; return Math.exp(-u * u); };
const q12 = t => Math.floor(t * 12 + 1e-6) / 12;          // 二拍（12 fps）
export const SHOTS = [];
const BUF = []; const buf = i => BUF[i] || (BUF[i] = WC.canvas(W, H));

// 共享：宽景的海与天
let SEA = null, SKY = null;
const sea = () => SEA || (SEA = WD.makeSea({ nr: 44, hor: WD.HOR, bot: PH + 30, a0: 1.6, a1: 30, l0: 38, l1: 360, w0: 1.2, w1: 13, seed: 7, sp: .32 }));
const sky = () => SKY || (SKY = WD.makeSky({ n: 7, y0: 18, y1: 300, w0: 5, w1: 17, seed: 21 }));
// 悬崖右缘：每行浪从这里开始（被崖身挡住的部分不刻）
function cliffX(y) { const P = WD.cliffPoly(); let best = -20; for (let i = 0; i < P.length - 1; i++) { const [x0, y0] = P[i], [x1, y1] = P[i + 1]; if ((y - y0) * (y - y1) <= 0 && y1 !== y0) best = Math.max(best, x0 + (x1 - x0) * (y - y0) / (y1 - y0)); } return best; }

// ================================================================== S1 · 黑版上刻出风暴海（版面模式，镜像）
let S1 = null;
function buildS1() {
  if (S1) return S1;
  S1 = { strokes: [], knife: [] };
  const rows = sea(), hero = 21, rnd = mulberry(5);
  const order = rows.map(r => r.k).filter(k => k !== hero).sort((a, b) => Math.abs(a - hero) - Math.abs(b - hero) || a - b);
  const bundles = [[K.knife[3], order.slice(0, 5), 3200], [K.knife[4], order.slice(5, 13), 4000], [K.knife[5], order.slice(13, 23), 5200], [K.knife[6], order.slice(23), 6800]];
  const assign = (list, Ts, xb, v, jit = 0) => { for (const s of list) { const xf = s.p[0]; s.t0 = Ts + (xb - xf) / v + jit; let L = 0; for (let i = 2; i < s.p.length; i += 2) L += Math.hypot(s.p[i] - s.p[i - 2], s.p[i + 1] - s.p[i - 1]); s.dur = Math.max(.03, L / v); } return list; };
  // 主刀：同一道浪峰分三刀（b0, b1, b2），刀尖从版左走到版右
  const hr = rows[hero], xe = cliffX(hr.y0) + 10;
  const cuts = [[K.knife[0], 1708, 1208, .62], [K.knife[1], 1208, 790, .6], [K.knife[2], 790, xe, .5]];
  for (const [Ts, xa, xb2, d] of cuts) {
    const v = (xa - xb2) / d, list = WD.rowStrokes(hr, { t: 0, x0: xb2, x1: xa, desc: true });
    S1.strokes.push(...assign(list, Ts, xa, v));
    S1.knife.push({ t0: Ts, t1: Ts + d, row: hr, xa, xb: xb2 });
  }
  // 成束：越来越快
  for (const [Ts, ks, v] of bundles) {
    ks.forEach((k, i) => {
      const r = rows[k], x0 = cliffX(r.y0) - 4, list = WD.rowStrokes(r, { t: 0, x0, desc: true });
      S1.strokes.push(...assign(list, Ts + i * .028 + rnd() * .015, PW + 60, v));
    });
    const lead = rows[ks[0]], x0 = cliffX(lead.y0);
    S1.knife.push({ t0: Ts, t1: Ts + (PW + 60 - x0) / v, row: lead, xa: PW + 40, xb: x0 });
  }
  // 陆地：保留黑木，只刻刀晕和受光边（与最后一束同时）
  const Wd = WD.buildWide(), Tl = K.knife[6];
  const land = [Wd.cliff, Wd.towerS];
  for (const S of land) { for (const s of [...S.halo, ...S.strokes]) { const c2 = { ...s, t0: Tl + rnd() * .45, dur: .06 + rnd() * .08 }; S1.strokes.push(c2); } }
  // 天：U 刀扫出云带（b4）
  const skyS = WD.skyStrokes(sky(), { desc: true });
  S1.strokes.push(...assign(skyS, K.sky, PW + 60, 5200, 0).map(s => { s.t0 += (s.p[1] - 18) / 300 * .12; return s; }));
  S1.knife.push({ t0: K.sky, t1: K.sky + .36, sky: sky()[1], xa: PW + 40, xb: 0 });
  // 雨：刺刀，三下
  const stabs = WD.stabField(240, [0, 0, PW, WD.HOR + 40], { seed: 33, keep: (x, y) => x > 360 || y < 30, r0: 1.8, r1: 2.6, angle: 1.95 });
  stabs.forEach((s, i) => { s.t0 = K.rain[i % 3] + rnd() * .1; s.dur = .03; });
  S1.strokes.push(...stabs);
  S1.stabPts = [0, 1, 2].map(j => stabs.find((s, i) => i % 3 === j && s.x > 900 && s.x < 1500) || stabs[j]);
  return S1;
}
// 刀在哪里（印刷坐标），down: 1 = 刀在木里
function knifeAt(t) {
  const P = buildS1().knife;
  const pos = (kp, u) => {
    if (kp.sky) { const x = lerp(kp.xa, kp.xb, u), B = kp.sky; return [x, B.y + B.a1 * Math.sin(x * B.f1 + B.p1) + B.a2 * Math.sin(x * B.f2 + B.p2)]; }
    const x = lerp(kp.xa, kp.xb, u); return [x, WD.surf(kp.row, x, 0)];
  };
  for (let i = 0; i < P.length; i++) {
    const kp = P[i];
    if (t >= kp.t0 && t <= kp.t1) { const u = (t - kp.t0) / (kp.t1 - kp.t0), ue = u * (.55 + .45 * u); const p = pos(kp, ue), p2 = pos(kp, Math.min(1, ue + .02)); return { p, a: Math.atan2(p2[1] - p[1], p2[0] - p[0]), down: 1 }; }
    const nx = P[i + 1];
    if (nx && t > kp.t1 && t < nx.t0) { const u = ss((t - kp.t1) / (nx.t0 - kp.t1)), a = pos(kp, 1), b = pos(nx, 0); return { p: [lerp(a[0], b[0], u), lerp(a[1], b[1], u)], a: PI, down: 1 - Math.sin(PI * u) }; }
  }
  const last = P[P.length - 1];
  if (t < P[0].t0) return { p: pos(P[0], 0), a: PI, down: 1 };
  // 刺刀三下，然后抬起离开
  const sp = buildS1().stabPts, end = pos(last, 1);
  const st = K.rain.map((tr, i) => [tr, [sp[i].x, sp[i].y]]);
  let p = end, down = 0;
  for (let i = 0; i < st.length; i++) {
    const [tr, q] = st[i], prev = i ? st[i - 1][1] : end, tp = i ? st[i - 1][0] : last.t1;
    if (t <= tr) { const u = ss(seg(t, tp, tr)); p = [lerp(prev[0], q[0], u), lerp(prev[1], q[1], u)]; down = u > .85 ? (u - .85) / .15 : 0; return { p, a: PI, down }; }
  }
  const tr = K.rain[2], u = seg(t, tr + .05, tr + .6);
  const q = st[2][1]; return { p: [q[0] - 900 * ei(u), q[1] - 500 * ei(u)], a: PI, down: Math.max(0, 1 - seg(t, tr, tr + .08)) };
}
function s1Cam(t) {
  // 3.5× 跟刀：镜头略滞后于刀尖（0.15 s 平滑），刀尖在画面右侧，刚刻出的线横贯画面左侧
  const bxAt = tt => PW - knifeAt(Math.min(tt, K.knife[3])).p[0];
  let bs = 0; for (let i = 0; i < 6; i++) bs += bxAt(t - i * .03); bs /= 6;
  const z0 = 3.5, half = (IMG.x + IMG.w / 2 + 4) / z0, fx = clamp(bs - 60, half, PW - half), fy = 506;
  const u = eio(seg(t, T(2.3), T(4.4)));
  const z = t < T(2.3) ? z0 : lerp(z0, 1.0, u) - .03 * seg(t, T(4.4), T(5));
  return { x: lerp(fx, PW / 2, u), y: lerp(fy, PH / 2, u), z };
}
// 木屑：刀走过时从槽里翻出的浅色木卷，飞起、落在版面上（不印，真实物件）
let CHIPS = null;
function chips() {
  if (CHIPS) return CHIPS;
  const P = buildS1().knife, r = mulberry(12), out = [];
  const pos = (kp, ue) => { const x = lerp(kp.xa, kp.xb, ue); return [x, WD.surf(kp.row, x, 0)]; };
  P.forEach((kp, i) => {
    if (kp.sky || i > 4) return;
    const rate = i < 3 ? 34 : 18;
    for (let ts = kp.t0 + .02; ts < kp.t1; ts += (.6 + .8 * r()) / rate) {
      const u = (ts - kp.t0) / (kp.t1 - kp.t0), ue = u * (.55 + .45 * u), [x, y] = pos(kp, ue);
      const a = -PI / 2 + (r() - .5) * 2.4 - .5;                      // 往上、往刀后（版面坐标里刀往右走）
      out.push({ ts, x: PW - x + (r() - .5) * 3, y: y + (r() - .5) * 3, vx: Math.cos(a) * (40 + 90 * r()) - 30, vy: Math.sin(a) * (40 + 90 * r()), vz: 70 + 110 * r(), sz: 2.2 + 3.2 * r(), sp: (r() - .5) * 26, a0: r() * 6.28, tone: r() });
    }
  });
  CHIPS = out; return out;
}
function drawChips(g, k, t) {
  const G = 900;
  for (const c2 of chips()) {
    const age = t - c2.ts; if (age < 0) continue;
    const tl = 2 * c2.vz / G, tau = Math.min(age, tl), hz = Math.max(0, c2.vz * tau - .5 * G * tau * tau);
    const x = c2.x + c2.vx * tau, y = c2.y + c2.vy * tau, rot = c2.a0 + c2.sp * tau;
    const [sx, sy] = ST.apply(k, x, y), z = k[0], s2 = c2.sz * z;
    // 影子
    g.save(); g.translate(sx + hz * .35 * z, sy + hz * .45 * z); g.rotate(rot); g.fillStyle = `rgba(0,0,0,${.5 - .25 * Math.min(1, hz / 20)})`;
    g.beginPath(); g.ellipse(0, 0, s2 * 1.1, s2 * .55, 0, 0, PI * 2); g.fill(); g.restore();
    // 木卷：浅木色，一侧亮一侧暗
    g.save(); g.translate(sx, sy - hz * .55 * z); g.rotate(rot);
    const L = 150 + 70 * c2.tone | 0;
    g.fillStyle = `rgb(${L + 70},${L + 45},${L + 5})`;
    g.beginPath(); g.moveTo(-s2, -s2 * .3); g.bezierCurveTo(-s2 * .2, -s2 * 1.3, s2 * 1.3, -s2 * .9, s2 * 1.1, s2 * .2);
    g.bezierCurveTo(s2 * .9, s2 * .9, -s2 * .1, s2 * .8, -s2 * .2, s2 * .1); g.bezierCurveTo(s2 * .2, -s2 * .1, s2 * .5, -s2 * .2, s2 * .5, s2 * .1);
    g.bezierCurveTo(s2 * .3, -s2 * .6, -s2 * .5, -s2 * .5, -s2, -s2 * .3); g.closePath(); g.fill();
    g.strokeStyle = `rgba(90,58,28,.7)`; g.lineWidth = Math.max(.8, s2 * .16); g.stroke();
    g.restore();
  }
}
// 版面上的转印底稿：淡粉笔线（刀顺着它刻）
function drawSketch(g, k) {
  const rows = sea(), Wd = WD.buildWide();
  g.save(); g.setTransform(k[0], k[1], k[2], k[3], k[4], k[5]); g.beginPath(); g.rect(0, 0, PW, PH); g.clip(); g.transform(-1, 0, 0, 1, PW, 0);
  g.strokeStyle = 'rgba(232,218,190,.13)'; g.lineWidth = 1.3; g.lineCap = 'round'; g.beginPath();
  rows.forEach((r, i) => { if (i % 3) return; const x0 = cliffX(r.y0); g.moveTo(x0, WD.surf(r, x0, 0)); for (let x = x0; x <= PW; x += 12) g.lineTo(x, WD.surf(r, x, 0) + Math.sin(x * .07 + i) * .8); });
  const C = WD.cliffPoly(); g.moveTo(...C[0]); for (const p of C.slice(1, -1)) g.lineTo(p[0] + 2, p[1] - 1);
  g.moveTo(264, 386); g.lineTo(274, 150); g.lineTo(326, 150); g.lineTo(336, 386); g.moveTo(274, 128); g.lineTo(274, 82); g.lineTo(326, 82); g.lineTo(326, 128);
  for (const B of sky()) { g.moveTo(0, B.y); for (let x = 0; x <= PW; x += 24) g.lineTo(x, B.y + B.a1 * Math.sin(x * B.f1 + B.p1) * .8); }
  g.stroke(); g.restore();
}
// 桌面（不印的部分）：深色木纹
let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  const [cv, q] = WC.canvas(2600, 1600); q.fillStyle = '#1b130d'; q.fillRect(0, 0, 2600, 1600);
  const r = mulberry(4);
  for (let i = 0; i < 260; i++) { const y = r() * 1600, a = .03 + r() * .08; q.strokeStyle = `rgba(${r() < .5 ? '70,48,30' : '8,5,3'},${a})`; q.lineWidth = 1 + r() * 4; q.beginPath(); for (let x = 0; x <= 2600; x += 40) q.lineTo(x, y + Math.sin(x * .002 + i) * 14 + Math.sin(x * .011 + i * 3) * 3); q.stroke(); }
  TABLE = cv; return cv;
}
function drawTable(g, k) {
  const P = [[0, 0], [PW, 0], [PW, PH], [0, PH]].map(([x, y]) => ST.apply(k, x, y));
  g.save(); g.beginPath(); g.rect(-10, -10, W + 20, H + 20); g.moveTo(...P[0]); for (const p of P.slice(1)) g.lineTo(...p); g.closePath(); g.clip('evenodd');
  g.setTransform(k[0], 0, 0, k[0], k[4] - 300 * k[0], k[5] - 300 * k[0]); g.drawImage(table(), 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 22 * k[0]; g.filter = `blur(${12 * k[0]}px)`; g.beginPath(); g.moveTo(P[0][0] + 12, P[0][1] + 12); for (const p of P.slice(1)) g.lineTo(p[0] + 12, p[1] + 12); g.closePath(); g.stroke(); g.filter = 'none';
  g.restore();
  g.strokeStyle = 'rgba(214,190,150,.32)'; g.lineWidth = Math.max(1, 3 * k[0]); g.beginPath(); g.moveTo(...P[3]); g.lineTo(...P[0]); g.lineTo(...P[1]); g.stroke();
}
// 刻刀（真实物件，压在版面上方，不印）
function drawKnife(g, sx, sy, a, z, lift) {
  g.save(); g.translate(sx, sy - lift * 46 * z); g.rotate(a + PI - .62); g.scale(z, z);
  // 影子
  g.save(); g.translate(26 + lift * 30, 30 + lift * 50); g.globalAlpha = .45 - .15 * lift; g.fillStyle = '#000'; g.filter = 'blur(9px)'; g.fillRect(0, -9, 330, 22); g.restore();
  // 刀身（钢）
  let gr = g.createLinearGradient(0, -7, 0, 7); gr.addColorStop(0, '#4a4d50'); gr.addColorStop(.45, '#c9ccd0'); gr.addColorStop(.6, '#7d8186'); gr.addColorStop(1, '#2c2e30');
  g.fillStyle = gr; g.beginPath(); g.moveTo(0, -2); g.lineTo(16, -6); g.lineTo(112, -6.5); g.lineTo(112, 6.5); g.lineTo(16, 6); g.lineTo(0, 2); g.closePath(); g.fill();
  g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(18, -3.2, 92, 1.4);
  // 箍
  gr = g.createLinearGradient(0, -10, 0, 10); gr.addColorStop(0, '#3a2c1c'); gr.addColorStop(.5, '#9a7a4a'); gr.addColorStop(1, '#2a1e12');
  g.fillStyle = gr; g.fillRect(110, -10, 16, 20);
  // 木柄
  gr = g.createLinearGradient(0, -18, 0, 18); gr.addColorStop(0, '#3d2614'); gr.addColorStop(.35, '#a26b3a'); gr.addColorStop(.55, '#8a5530'); gr.addColorStop(1, '#2b190c');
  g.fillStyle = gr; g.beginPath(); g.moveTo(126, -10); g.bezierCurveTo(190, -14, 260, -20, 320, -15); g.bezierCurveTo(340, -13, 342, 13, 320, 15); g.bezierCurveTo(260, 20, 190, 14, 126, 10); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(30,16,6,.35)'; g.lineWidth = 1; for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(140 + i * 8, -6 + i * 2.5); g.bezierCurveTo(200, -9 + i * 3, 260, -12 + i * 4.5, 318, -9 + i * 4.2); g.stroke(); }
  g.restore();
}
SHOTS.push({
  id: 'S1', ...sh('S1'),
  draw(g, t) {
    const S = buildS1(), cam = s1Cam(t);
    const k = ST.beginBlock(cam);
    WC.drawStrokes(m, S.strokes, { t });
    const kn = knifeAt(t);
    if (kn.down > .5) WC.chip(m, { x: kn.p[0], y: kn.p[1], a: kn.a, w: 6 }, 1.2);
    ST.end();
    // 刀：印刷坐标 → 版（镜像）→ 屏幕
    const [sx, sy] = ST.apply(k, PW - kn.p[0], kn.p[1]);
    const shine = kn.down * clamp((cam.z - 1.2) / 1.5) * .42;
    ST.printTo(g, { mode: 'block', sheen: .17, wetX: -1, bk: [k[0], k[4], k[5]], kt: [sx - 150, sy, shine] });
    drawSketch(g, k);
    drawChips(g, k, t);
    drawTable(g, k);
    drawKnife(g, sx, sy, PI - kn.a, cam.z * .9, 1 - kn.down);
  },
  events() {
    const S = buildS1(), ev = [];
    S.knife.slice(0, 3).forEach((kp, i) => { ev.push({ t: kp.t0, type: 'knife_bite', key: `knife.${i}`, v: 1 - i * .1 }); ev.push({ t: kp.t0, type: 'knife_run', dur: kp.t1 - kp.t0, v: .9 }); });
    S.knife.slice(3, 7).forEach((kp, i) => ev.push({ t: kp.t0, type: 'flurry', key: `knife.${i + 3}`, dur: Math.min(.6, kp.t1 - kp.t0 + .12), n: 5 + i * 3 }));
    ev.push({ t: K.sky, type: 'gouge_sky', key: 'sky', dur: .42 });
    K.rain.forEach((tr, i) => ev.push({ t: tr, type: 'stab', key: `rain.${i}`, n: 6 }));
    ev.push({ t: K.rain[2] + .12, type: 'knife_lift' });
    return ev;
  },
});

// ================================================================== S2 · 船在浪里
let S2 = null;
function buildS2() {
  if (S2) return S2;
  S2 = {
    sea: WD.makeSea({ nr: 17, hor: 380, bot: 1010, a0: 6, a1: 62, l0: 110, l1: 640, w0: 1.8, w1: 14, s0: 70, s1: 230, seed: 17, sp: .5 }),
    sky: WD.makeSky({ n: 6, y0: 20, y1: 360, w0: 4, w1: 15, seed: 23 }),
    boat: WD.buildBoat(1),
  };
  S2.brow = S2.sea.reduce((b, r) => Math.abs(r.y0 - 640) < Math.abs(b.y0 - 640) ? r : b, S2.sea[0]);
  return S2;
}
const S2A = t => 1 + .55 * bump(t, K.wave[0], .45) + .75 * bump(t, K.wave[1], .45);
function boatState(t) {
  const S = buildS2(), tq = q12(t), A = S2A(tq), bx = 960;
  const y = WD.surf(S.brow, bx, tq, A) - 30, yl = WD.surf(S.brow, bx - 120, tq, A), yr = WD.surf(S.brow, bx + 120, tq, A);
  let roll = Math.atan2(yr - yl, 240) * .55;
  // 巨浪拍船：先往回一点（预备）→ 猛倾 → 回摆
  for (const tw of K.wave) { const u = tq - tw; if (u > -.12 && u < 1.6) roll += u < 0 ? .04 * (-u / .12) : -.2 * Math.exp(-u * 2.6) * Math.cos(u * 7); }
  return { x: bx, y, roll, A, tq };
}
// 迎面的大浪：一道翻卷的浪头从侧面扫过船；撞上船的那一帧浪顶刻满白，一圈刺刀水花 2 帧炸开再沿抛物线落下
function heroWave(g, t, tw, dir, S, bs) {
  const tb = q12(t), u = (tb - tw) / .55;     // 浪身按二拍重刻（液体的有意沸腾）；水花按一拍
 if (u < -1.6 || u > 2.4) return;
  const xc = 960 - dir * u * 520, hgt = 250 * Math.exp(-u * u * .8), base = 820;
  const crest = []; for (let x = -300; x <= PW + 300; x += 8) { const d = (x - xc) * dir, e = Math.exp(-((d / 260) ** 2)); crest.push([x, base - hgt * e * (1 + .25 * Math.tanh(d / 90))]); }
  if (u < 1.6) {
    g.fillStyle = '#000'; g.beginPath(); g.moveTo(-300, PH + 300); for (const p of crest) g.lineTo(...p); g.lineTo(PW + 300, PH + 300); g.closePath(); g.fill();
    // 浪顶：撞击前后整条浪唇刻满白（宽 U 刀，带少量留黑的木纹线）
    const full = Math.exp(-(((tb - tw) / .2) ** 2)), lipW = 10 + 40 * full;
    const lip = crest.filter(([x, y]) => base - y > 50);
    if (lip.length > 3) {
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(...lip[0]); for (const p of lip) g.lineTo(p[0], p[1] - 2); for (let i = lip.length - 1; i >= 0; i--) { const [x, y] = lip[i], h = (base - y) / hgt; g.lineTo(x + Math.sin(x * .09) * 3, y + lipW * h * (.8 + .4 * Math.sin(x * .031 + tw))); } g.closePath(); g.fill();
      const keep = []; for (let k = 0; k < 3; k++) keep.push(...WC.cutAlong(lip.map(([x, y]) => [x, y + (6 + k * 11) * (.5 + full)]), { w: 1.8, kind: 'k', seg: [40, 120], gap: [10, 40], seed: 950 + k }));
      WC.drawStrokes(g, keep, { color: '#000' });
    }
    const cuts = [];
    for (let k = 0; k < 7; k++) { const off = lipW * .6 + 8 + k * (14 + k * 3), pts = crest.map(([x, y]) => [x, y + off]); cuts.push(...WC.cutAlong(pts, { w: (uu, p) => Math.max(.6, (12 - k * 1.4) * clamp((base - p[1] + 30) / 120)), kind: k < 2 ? 'u' : 'v', seg: [60, 200], gap: [4, 16], seed: 900 + k + Math.floor(tw) * 10 })); }
    WC.drawStrokes(g, cuts, { color: '#fff' });
    const r0 = mulberry(17 + Math.floor(tw * 10)), lp = [];
    for (let i = 0; i < 70; i++) { const d = (r0() - .3) * 300, x = xc + d * dir, y = base - hgt * Math.exp(-((d / 260) ** 2)) - r0() * 30; lp.push([x, y, 2 + r0() * 4]); }
    WC.drawStrokes(g, WC.flecks(lp, { seed: 5, angle: -.5 }), { color: '#fff' });
  }
  // 撞击水花：一圈刺刀点（r 4–8），黑底保证可见；2 帧炸开 → 抛物线下落
  const ut = t - tw; if (ut < 0 || ut > 1.4) return;
  const r = mulberry(31 + Math.floor(tw * 10)), ox = bs.x + dir * 110, oy = bs.y - 30, pts = [];
  const R2 = 2 / 24, N = 44;
  for (let i = 0; i < N; i++) {
    const a = -PI / 2 + dir * .3 + ((i + r()) / N - .5) * 3.1, sp = 360 + r() * 380, rr = 6.5 + r() * 5.5;
    const burst = Math.min(ut, R2) / R2, dist = (60 + sp * .32) * (1 - Math.pow(1 - burst, 2));     // 2 帧内冲到环上
    const tf = Math.max(0, ut - R2), vx = Math.cos(a) * sp * .55, vy = Math.sin(a) * sp * .9;
    const x = ox + Math.cos(a) * dist + vx * tf, y = oy + Math.sin(a) * dist * .8 + vy * tf + 1500 * tf * tf;
    const life = 1 - tf / (.75 + .5 * r()); if (life <= 0) continue;
    pts.push([x, y, rr * (.6 + .4 * life)]);
  }
  g.fillStyle = '#000'; g.beginPath(); for (const [x, y, rr] of pts) { g.moveTo(x + rr * 1.55, y); g.arc(x, y, rr * 1.55, 0, PI * 2); } g.fill();
  WC.drawStrokes(g, WC.flecks(pts, { seed: 7, angle: -.9 }), { color: '#fff' });
}
function s2Cam(t, b) {
  const lb = boatState(t - .14);
  let cam = { x: 950, y: 470 + (lb.y - 610) * .45, z: 1.18, r: lb.roll * .5 };
  const ui = ss(seg(t, K.wave[0], K.wave[0] + .12)); cam.oy = 0;
  for (const tw of K.wave) { const u = t - tw; if (u >= 0 && u < .16) { cam.ox = (u < .04 ? 9 : u < .08 ? -6 : 3); cam.oy = (u < .04 ? -7 : u < .08 ? 4 : -2); } }
  // b8 急推到渔人脸上
  const us = eo(seg(t, K.snap, K.snap + 5 / 24));
  if (us > 0) {
    const cs = Math.cos(b.roll), sn = Math.sin(b.roll), hx = 124, hy = -186;
    const fx = b.x + cs * hx - sn * hy, fy = b.y + sn * hx + cs * hy;
    cam = { x: lerp(cam.x, fx - 60, us), y: lerp(cam.y, fy + 70 - 40 * ss(seg(t, K.creak[2], K.creak[2] + .5)), us), z: lerp(1.18, 2.45, us), r: cam.r * (1 - .5 * us), ox: cam.ox, oy: cam.oy };
  }
  return cam;
}
SHOTS.push({
  id: 'S2', ...sh('S2'),
  draw(g, t, lt) {
    const S = buildS2(), b = boatState(t), tq = b.tq, cam = s2Cam(t, b);
    ST.beginPrint(cam);
    WC.drawStrokes(m, WD.skyStrokes(S.sky, { dx: tq * 70, x0: -300, x1: PW + 300 }), { color: '#fff' });
    WC.drawStrokes(m, WD.rain(t, { n: 150, box: [-300, -200, PW + 300, 700], v: 1500, len: 60, angle: 1.95, w: 2.6, seed: 9 }), { color: '#fff' });
    const back = S.sea.filter(r => r.y0 <= S.brow.y0 + 4), front = S.sea.filter(r => r.y0 > S.brow.y0 + 4);
    for (const r of back) WC.drawStrokes(m, WD.rowStrokes(r, { t: tq, A: b.A, x0: -300, x1: PW + 300 }), { color: '#fff' });
    WC.drawStrokes(m, WD.foam(back, tq, { A: b.A, vmin: .3, k: 1.2, xw: PW + 300 }), { color: '#fff' });
    // 船（局部坐标里刻，阴影线随船动）
    m.save(); m.translate(b.x, b.y); m.rotate(b.roll);
    const look = ss(seg(t, K.creak[2], K.creak[2] + .35));
    WD.drawBoat(m, S.boat, t, { look, sway: Math.sin(q12(t) * 5) * .5 });
    m.restore();
    // 前面的水：水线以下压黑，再刻前排浪
    const wl = []; for (let x = -300; x <= PW + 300; x += 8) wl.push([x, WD.surf(S.brow, x, tq, b.A) + 26]);
    m.fillStyle = '#000'; m.beginPath(); m.moveTo(-300, 2000); for (const p of wl) m.lineTo(...p); m.lineTo(PW + 300, 2000); m.closePath(); m.fill();
    WC.drawStrokes(m, WC.cutAlong(wl, { w: 6, kind: 'u', seg: [60, 180], gap: [4, 14], seed: 31 }), { color: '#fff' });
    for (const r of front) WC.drawStrokes(m, WD.rowStrokes(r, { t: tq, A: b.A, x0: -300, x1: PW + 300 }), { color: '#fff' });
    WC.drawStrokes(m, WD.foam(front, tq, { A: b.A, vmin: 0, k: 1.4, rk: 1.2, xw: PW + 300 }), { color: '#fff' });
    heroWave(m, t, K.wave[0], 1, S, b); heroWave(m, t, K.wave[1], -1, S, b);
    ST.end();
    ST.printTo(g, { inkSeed: 7, jolt: ST.jolt(lt), reg: ST.regJolt(lt) });
  },
  events() {
    return [
      { t: K.cut2, type: 'impression', key: 'cut2', v: 1 },
      ...K.wave.map((tw, i) => ({ t: tw, type: 'wave_crash', key: `wave.${i}`, v: .85 + i * .15 })),
      { t: K.snap, type: 'snap', key: 'snap' },
      ...K.creak.map((tc, i) => ({ t: tc, type: 'creak', key: `creak.${i}`, v: .7 })),
      { t: K.cut2, type: 'storm_bed', dur: K.cut3 - K.cut2 + .3 },
    ];
  },
});

// ================================================================== S3 · 守夜人爬上灯塔，近乎静默；灯亮
let S3 = null;
function buildS3() {
  if (S3) return S3;
  S3 = { sea: WD.makeSea({ nr: 24, hor: 1760, bot: 2650, a0: 1, a1: 14, l0: 40, l1: 260, w0: 1, w1: 7, seed: 27, sp: .2 }), sky: WD.makeSky({ n: 5, y0: 120, y1: 1500, w0: 3, w1: 10, seed: 29 }) };
  const r0 = WD.TW.gal + 40, rr = n => r0 + n * WD.TW.rung;
  S3.rung = rr;
  // 爆开的光：四刀
  const L = WD.LAMP3, rs = [[18, 90, [380, 760], 26], [26, 120, [600, 1150], 20], [36, 150, [850, 1500], 14], [52, 170, [1000, 1900], 9]];
  S3.bursts = rs.map(([n, r0, r1, w], i) => WC.rays(L[0], L[1], { n, r0, r1, w, jit: .7, bend: .03, seed: 60 + i, reveal: { t0: K.burst[i], t1: K.burst[i] + .2, jit: .3 } }));
  return S3;
}
// 守夜人：侧身朝右（面向塔），二拍
function keeperPose(t) {
  const tq = q12(t), r = buildS3().rung, E = K.rung, r0 = r(0);
  const snap = y => r(Math.round((y - r0) / WD.TW.rung));
  const hip0 = r(8) + 30, hipAt = i => hip0 - 108 * i, lead = (side, i) => (i % 2) === side;
  const handT = (s, i) => snap(hipAt(i) - 112 + (lead(s, i) ? -95 : 5));
  const footT = (s, i) => snap(hipAt(i) + (lead(s, i) ? 92 : 148));
  const chain = (f, w0, w1) => { let y = f(0), arc = 0; for (let i = 0; i < E.length; i++) { const u = ss(seg(tq, E[i] + w0, E[i] + w1)); if (u > 0) { y = lerp(f(i), f(i + 1), u); arc = f(i) !== f(i + 1) ? Math.sin(PI * u) : 0; } } return [y, arc]; };
  const [hipY] = chain(hipAt, -.3, .14);
  const hand = s => { const [y, a] = chain(i => handT(s, i), -.3, 0); return [664 + s * 6 - a * 26, y - a * 10]; };
  const foot = s => { const [y, a] = chain(i => footT(s, i), -.04, .16); return [650 + s * 6 - a * 22, y]; };
  const hx = 588;
  let P = { hip: [hx, hipY], sh: [hx + 16, hipY - 112], hL: hand(0), hR: hand(1), fL: foot(0), fR: foot(1), look: .05 };
  // 翻上回廊（b11.25 落脚）
  const ug = ss(seg(tq, K.grate - .3, K.grate));
  if (ug > 0) {
    const G = WD.TW.gal - 2, stand = { hip: [706, G - 152], sh: [712, G - 264], hL: [748, G - 206], hR: [764, G - 238], fL: [690, G], fR: [728, G], look: .12 };
    const mix = (a, b) => [lerp(a[0], b[0], ug), lerp(a[1], b[1], ug) - Math.sin(PI * ug) * 40];
    P = Object.fromEntries(Object.keys(stand).map(k => [k, Array.isArray(stand[k]) ? mix(P[k], stand[k]) : lerp(P[k], stand[k], ug)]));
  }
  // 灯亮：后仰 + 抬手挡光（3 帧），然后放下看着灯
  const ui = tq - K.ignite;
  if (ui >= 0) {
    const fl = ui < 3 / 24 ? ui / (3 / 24) : Math.max(0, 1 - (ui - 3 / 24) / .55), flE = ss(fl);
    P.sh = [P.sh[0] - 26 * flE, P.sh[1] + 6 * flE]; P.hR = [lerp(P.hR[0], P.sh[0] + 40, flE), lerp(P.hR[1], P.sh[1] - 74, flE)]; P.look = lerp(.12, .3, ss(seg(ui, .2, .6)));
    P.lit = 1;
  }
  return P;
}
function drawKeeper(g, P) {
  const lit = P.lit ? [.95, -.3] : [-.85, -.45];
  const legs = [], arms = [];
  for (const [f, bend] of [[P.fL, -1], [P.fR, -1]]) { const [kn, ft] = WD.ik(P.hip, f, 82, 80, bend); legs.push(WD.capsule(P.hip, kn, 23, 19), WD.capsule(kn, ft, 19, 15), [[ft[0] - 16, ft[1] - 14], [ft[0] + 30, ft[1] - 10], [ft[0] + 32, ft[1] + 4], [ft[0] - 16, ft[1] + 4]]); }
  for (const h of [P.hL, P.hR]) { const [el, hd] = WD.ik(P.sh, h, 64, 60, -1); arms.push(WD.capsule(P.sh, el, 19, 16), WD.capsule(el, hd, 16, 13), WD.capsule(hd, hd, 14)); }
  const [hx, hy] = P.hip, [sx, sy] = P.sh;
  const coat = [[hx - 44, hy + 78], [hx - 36, hy - 10], [sx - 38, sy + 6], [sx - 14, sy - 22], [sx + 30, sy - 16], [sx + 38, sy + 24], [hx + 32, hy - 4], [hx + 44, hy + 70]];
  WD.figure(g, [legs[3], legs[4], legs[5], arms[0], arms[1], arms[2]], { halo: 6, lit, cuts: 2, inset: 5, sp: 6, cw: 3 });
  WD.figure(g, [coat], { halo: 7, lit, cuts: 3, inset: 6, sp: 6, cw: 3.4 });
  WD.figure(g, [legs[0], legs[1], legs[2], arms[3], arms[4], arms[5]], { halo: 6, lit, cuts: 2, inset: 5, sp: 6, cw: 3 });
  // 头：帽 + 白脸
  const head = [sx + 12, sy - 56];
  g.fillStyle = '#fff'; g.beginPath(); g.arc(head[0], head[1], 44, 0, PI * 2); g.fill();
  g.fillStyle = '#000'; g.beginPath(); g.arc(head[0], head[1], 37, 0, PI * 2); g.fill();
  WD.face(g, head[0] + 4, head[1] + 4, 29, 1, P.look, { beard: true, brow: P.lit ? .1 : 0 });
  WD.figure(g, [[[head[0] - 34, head[1] - 14], [head[0] - 26, head[1] - 44], [head[0] + 20, head[1] - 46], [head[0] + 30, head[1] - 20], [head[0] + 44, head[1] - 16], [head[0] - 40, head[1] - 10]]], { halo: 4 });
}
function s3Cam(t) {
  // 升降：先跟着守夜人往上（他在画面中部偏下），最后一步越过他升到灯室
  const hip = keeperPose(t).hip[1], w = eio(seg(t, K.rung[1], K.grate + .12));
  let cam = { x: lerp(780, 880, w), y: lerp(hip - 120, 540, w), z: lerp(1.15, 1.2, w) };
  const ui = t - K.ignite;
  if (ui >= 0) { cam.z = 1.2 + .1 * eo(seg(ui, 0, .8)); cam.ox = ui < 1 / 24 ? 7 : ui < 2 / 24 ? -4 : 0; cam.oy = ui < 1 / 24 ? -5 : ui < 2 / 24 ? 3 : 0; }
  return cam;
}
SHOTS.push({
  id: 'S3', ...sh('S3'),
  draw(g, t, lt) {
    const S = buildS3(), tq = q12(t), lit = t >= K.ignite;
    ST.beginPrint(s3Cam(t));
    WC.drawStrokes(m, WD.skyStrokes(S.sky, { dx: tq * 40, wk: .8 }), { color: '#fff' });
    for (const r of S.sea) WC.drawStrokes(m, WD.rowStrokes(r, { t: tq, x0: -200, x1: PW + 200 }), { color: '#fff' });
    WC.drawStrokes(m, WD.rain(t, { n: 120, box: [-200, -200, PW + 200, 2700], v: 1300, len: 46, angle: 1.98, w: 2, seed: 19, keep: (x, y) => !(x > 640 && x < 1160 && y > 250) }), { color: '#fff' });
    WD.drawTower(m, c, { lit: lit ? 1 : 0, glow: lit ? eo(seg(t, K.ignite, K.burst[3] + .2)) : 0 });
    if (lit) {
      for (const B of S.bursts) WC.drawStrokes(m, B, { t, color: '#fff' });
      // 光的红：只在灯芯附近，随刀扩一点
      const R = 120 + 260 * eo(seg(t, K.ignite, K.cut4));
      const gr = c.createRadialGradient(WD.LAMP3[0], WD.LAMP3[1], 10, WD.LAMP3[0], WD.LAMP3[1], R); gr.addColorStop(0, 'rgba(0,0,0,.95)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = gr; c.fillRect(WD.LAMP3[0] - R, WD.LAMP3[1] - R, R * 2, R * 2);
      // 窗棂压回黑（框中框）
      m.fillStyle = '#000'; for (let i = 0; i <= 4; i++) m.fillRect(770 + i * 80, 380, 8, WD.TW.gal - 382); m.fillRect(760, 532, 328, 10);
    }
    drawKeeper(m, keeperPose(t));
    ST.end();
    ST.printTo(g, { inkSeed: 9, jolt: ST.jolt(lt), reg: ST.regJolt(lt) });
  },
  events() {
    return [
      { t: K.cut3, type: 'impression', key: 'cut3', v: .45 },
      ...K.rung.map((tr, i) => ({ t: tr, type: 'rung', key: `rung.${i}`, v: .8 - i * .05 })),
      { t: K.grate, type: 'grate', key: 'grate' },
      { t: K.ignite, type: 'ignite', key: 'ignite' },
      ...K.burst.map((tb, i) => ({ t: tb, type: 'ray', key: `burst.${i}`, v: 1 - i * .12 })),
      { t: K.ignite - .02, type: 'flinch' },
    ];
  },
});

// ================================================================== 宽景（S4–S6 共用）
const BOAT0 = [1380, 590];
let WB = null;
const wideBoats = () => WB || (WB = { dark: WD.buildBoat(.5, { light: WC.light(-.6, -.7, .2), lo: .4 }), lit: WD.buildBoat(.5, { light: WC.light(-.9, -.45, .55), lo: .18 }) });
let WBF = null; const finalBoat = () => WBF || (WBF = WD.buildBoat(.62, { light: WC.light(-.9, -.45, .55), lo: .18 }));
function wideScene(t, o) {
  const tq = q12(t), A = o.A ?? .9;
  // 天、雨（或星）
  WC.drawStrokes(m, WD.skyStrokes(sky(), { dx: o.calm ? 0 : tq * 50, wk: o.skyK ?? 1 }), { color: '#fff' });
  if (o.stars) WC.drawStrokes(m, o.stars, { color: '#fff' });
  else WC.drawStrokes(m, WD.rain(t, { n: 110, box: [-100, -100, PW + 100, WD.HOR + 20], v: 1300, len: 40, angle: 1.95, w: o.rainW ?? 2, seed: 39, keep: (x, y) => x > 380 }), { color: '#fff' });
  // 海：光束里的刀更宽（光是刻出来的）
  const lit = o.beamFn ? (x, y) => 1 + 2.6 * o.beamFn(x, y) * clamp(1.25 - Math.hypot(x - WD.LAMP[0], y - WD.LAMP[1]) / 1900) : null;
  for (const r of sea()) { const L = WD.rowStrokes(r, { t: o.calm ? 2 : tq, A, x0: cliffX(r.y0) - 4, lit }); WC.drawStrokes(m, L, { color: '#fff' }); if (o.collect) o.collect.push(...L); }
  if (!o.calm) WC.drawStrokes(m, WD.foam(sea(), tq, { A, vmin: .6, k: .8 }), { color: '#fff' });
  if (o.beam) WC.drawStrokes(m, o.beam, { t, color: '#fff' });
  WD.drawLand(m, c, { lit: o.lampLit, keeper: 280 });
  // 船：在码头前、压在光束上（光里的黑剪影）
  if (o.boat) {
    const { x, y, roll, lit: bl } = o.boat;
    const BB = o.boat.big ? finalBoat() : bl ? wideBoats().lit : wideBoats().dark, bk = BB.s / .5;
    m.save(); m.translate(x, y); m.rotate(roll); WD.drawBoat(m, BB, t, { flap: o.calm ? 0 : .8, look: 1 }); m.restore();
    const wl = []; for (let xx = x - 170 * bk; xx <= x + 150 * bk; xx += 6) wl.push([xx, y + 36 * bk + Math.sin(xx * .05 + tq * 4) * 2.5]);
    WC.drawStrokes(m, WC.cutAlong(wl, { w: bl ? 5 : 3, kind: 'v', seg: [30, 90], gap: [3, 9], seed: 77 }), { color: '#fff' });
  }
}
const boatWide = t => {
  const tq = q12(t), r = sea()[24];
  if (t < K.boat_lit) return { x: BOAT0[0], y: BOAT0[1] + Math.sin(tq * 4.3) * 7, roll: Math.sin(tq * 3.1) * .1, lit: false };
  const u = seg(t, K.boat_lit, K.dock), e = 1 - Math.pow(1 - u, 2.2);
  const x = lerp(BOAT0[0], 720, e), y = lerp(BOAT0[1], 600, e) + Math.sin(tq * 4.3) * 7 * (1 - e);
  let roll = Math.sin(tq * 3.1) * .1 * (1 - e);
  const ud = t - K.dock; if (ud >= 0) roll += -.06 * Math.exp(-ud * 3) * Math.sin(ud * 14);
  return { x: x + (ud >= 0 && ud < .1 ? -2 : 0), y, roll, lit: true };
};
// ================================================================== S4 · 光束一拍一刀扫过海面
const BEAM_TH = [-.2, .06, .25];
SHOTS.push({
  id: 'S4', ...sh('S4'),
  draw(g, t, lt) {
    let i = 0; for (let j = 0; j < K.beam.length; j++) if (t >= K.beam[j]) i = j;
    const th = BEAM_TH[i], bm = WD.beam(WD.LAMP[0], WD.LAMP[1], th, { n: 15, half: .075, len: 2000, w: 15, seed: 41 + i, t0: K.beam[i], dur: .24 });
    const fB = WD.inBeam(WD.LAMP[0], WD.LAMP[1], th, .075), grow = eo(seg(t, K.beam[i], K.beam[i] + .3));
    const u = eio(seg(t, K.cut4, K.cut4 + 1.3)), up = ss(seg(t, K.cut4 + .8, K.boat_lit));
    const cam = { x: lerp(560, 900, u) + 130 * up, y: lerp(250, 456, u), z: lerp(1.75, 1.0, u) + .04 * up };
    ST.beginPrint(cam);
    wideScene(t, { A: .95, beam: bm, beamFn: (x, y) => fB(x, y) * clamp(grow * 2200 - Math.hypot(x - WD.LAMP[0], y - WD.LAMP[1]) + 1) / 1, boat: boatWide(t), lampLit: true });
    c.fillStyle = 'rgba(0,0,0,1)'; c.beginPath(); c.arc(WD.LAMP[0], WD.LAMP[1], 30, 0, PI * 2); c.fill();
    ST.end();
    ST.printTo(g, { inkSeed: 11, jolt: ST.jolt(lt), reg: ST.regJolt(lt) });
  },
  events() { return [{ t: K.cut4, type: 'impression', key: 'cut4', v: .7 }, ...K.beam.map((tb, i) => ({ t: tb, type: 'beam', key: `beam.${i}`, v: .8 + i * .07 })), { t: K.cut4, type: 'sea_bed', dur: K.peel - K.cut4 }]; },
});

// 红版：每一刀单独上色。d = 离灯芯的距离；铺开前沿速度 VR，回收按反序
const VR = 2300, RT_ON = () => K.boat_lit, RT_OFF = () => K.red_back0;
const h01 = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
function cutRamp(t, d, seed, dmax) {
  const j = h01(seed), dur = .08 + .27 * h01(seed + 3.3);
  const on = RT_ON() + d / VR + j * .06, off = RT_OFF() + (dmax - d) / (dmax / (K.red_back1 - K.red_back0 - .35)) + j * .06;
  return clamp((t - on) / dur) * (1 - clamp((t - off) / dur));
}
function redPlate(t, bm, sea, fB, b) {
  const [lx, ly] = WD.LAMP, dmax = 1900;
  c.lineCap = 'round'; c.lineJoin = 'round';
  // 光束里的 U 刀：沿刀从灯芯往外推进，回收时从外往里收
  const grow = Math.max(0, t - K.boat_lit) * VR, back = t < K.red_back0 ? 1e9 : dmax * (1 - eio(seg(t, K.red_back0, K.red_back1 - .1)));
  for (const s of bm) {
    const p = s.p, n = p.length / 2; let w = 0; for (let i = 0; i < n; i++) w += s.w[i] ?? s.w[0]; w /= n;
    c.strokeStyle = 'rgba(0,0,0,.95)'; c.lineWidth = w + 7; c.beginPath(); let started = false;
    for (let i = 0; i < n; i++) { const x = p[2 * i], y = p[2 * i + 1], d = Math.hypot(x - lx, y - ly); if (d > Math.min(grow, back)) break; started ? c.lineTo(x, y) : c.moveTo(x, y); started = true; }
    c.stroke();
  }
  // 浪刀：光束里的、船周围 270 px 内的才上色，其余保留白
  for (const s of sea) {
    const p = s.p, n = p.length / 2, mx = p[n & ~1], my = p[(n & ~1) + 1];
    const near = clamp(1.25 - Math.hypot(mx - b.x, my - b.y) / 270), wgt = Math.max(fB(mx, my), near);
    if (wgt < .15) continue;
    const d = Math.hypot(mx - lx, my - ly), a = cutRamp(t, d, s.seed, dmax) * Math.min(1, wgt * 1.3);
    if (a <= .01) continue;
    let w = 0; for (let i = 0; i < n; i++) w += s.w[i] ?? s.w[0]; w /= n;
    c.strokeStyle = `rgba(0,0,0,${(.92 * a).toFixed(3)})`; c.lineWidth = w + 6; c.beginPath(); c.moveTo(p[0], p[1]); for (let i = 1; i < n; i++) c.lineTo(p[2 * i], p[2 * i + 1]); c.stroke();
  }
  // 船（受光的船身排线）跟着近浪一起上一点红
  const ab = cutRamp(t, Math.hypot(b.x - lx, b.y - ly), 7, dmax);
  if (ab > 0) { const gr = c.createRadialGradient(b.x, b.y - 40, 10, b.x, b.y - 40, 220); gr.addColorStop(0, `rgba(0,0,0,${.85 * ab})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gr; c.fillRect(b.x - 230, b.y - 270, 460, 460); }
}
// ================================================================== S5 · 照到船：红版铺开又退回，船靠港
function s5Draw(g, t, lt) {
  const b = boatWide(t), th = Math.atan2(b.y - 20 - WD.LAMP[1], b.x - WD.LAMP[0]);
  const bm = WD.beam(WD.LAMP[0], WD.LAMP[1], th, { n: 15, half: .07, len: 2000, w: 15, seed: 51 });
  const fB = WD.inBeam(WD.LAMP[0], WD.LAMP[1], th, .07);
  const up = eio(seg(t, K.boat_lit, K.dock)), ub = eio(seg(t, K.dock, K.red_back1));
  let cam = { x: lerp(1054, b.x + 40, up), y: lerp(456, b.y - 80, up), z: lerp(1.04, 2.1, up) };
  cam = { x: lerp(cam.x, 600, ub), y: lerp(cam.y, 330, ub), z: lerp(cam.z, 1.25, ub) };
  ST.beginPrint(cam);
  const sc = [];
  wideScene(t, { A: lerp(.95, .4, seg(t, K.boat_lit, K.red_back1)), beam: bm, beamFn: fB, boat: b, lampLit: true, rainW: lerp(2, 1, seg(t, K.boat_lit, K.dock)), collect: sc });
  // 唯一的套色：从灯芯沿光束、沿浪刀一刀一刀铺出去（每刀 0.08–0.35 s），峰值只铺光束和船周围的近浪，远海保留白刀；
  // 退回时远处的先收，一刀一刀收回灯芯
  redPlate(t, bm, sc, fB, b);
  c.fillStyle = 'rgba(0,0,0,1)'; c.beginPath(); c.arc(WD.LAMP[0], WD.LAMP[1], 30, 0, PI * 2); c.fill();
  ST.end();
  ST.printTo(g, { inkSeed: 13, jolt: [0, 0], reg: [3, 2] });
}
SHOTS.push({
  id: 'S5', ...sh('S5'),
  draw: s5Draw,
  events() { return [{ t: K.boat_lit, type: 'boat_lit', key: 'boat_lit' }, { t: K.boat_lit, type: 'plate_roll', dur: K.red_full - K.boat_lit, key: 'red' }, { t: K.dock, type: 'dock', key: 'dock' }, { t: K.red_back0, type: 'plate_back', dur: K.red_back1 - K.red_back0 }, { t: K.boat_lit, type: 'oars', dur: K.dock - K.boat_lit }]; },
});

// ================================================================== S6 · 揭纸 → 成品版画
let STARS = null, PAPERTEX = null;
function paperTex() {
  if (PAPERTEX) return PAPERTEX;
  m.setTransform(1, 0, 0, 1, 0, 0); m.fillStyle = '#fff'; m.fillRect(0, 0, W, H); c.clearRect(0, 0, W, H);
  const out = ST.printer().render(ST.M, ST.C, { seed: 5, paper: ST.PAPER });
  const [cv, q] = WC.canvas(); q.drawImage(out, 0, 0); PAPERTEX = cv; return cv;
}
export const CAPTION = '灯塔守夜';
// 成品版画：锁定机位略推近（船与码头往画面中心靠）；雨点变成的星，八颗大的逐颗点亮（各卡 ¼ 拍）
const FCAM = { x: 800, y: 410, z: 1.18 };
let BIGSTARS = null;
function bigStars() {
  if (BIGSTARS) return BIGSTARS;
  const r = mulberry(88), bands = sky(), fB = WD.inBeam(WD.LAMP[0], WD.LAMP[1], .17, .09), cand = [];
  for (let i = 0; i < 3000 && cand.length < 40; i++) {
    const x = 420 + r() * 1150, y = 36 + r() * 270;
    if (fB(x, y) > .02 || Math.hypot(x - WD.LAMP[0], y - WD.LAMP[1]) < 200) continue;
    if (bands.some(B => Math.abs(y - (B.y + B.a1 * Math.sin(x * B.f1 + B.p1) + B.a2 * Math.sin(x * B.f2 + B.p2))) < 11)) continue;
    if (cand.some(([u, v]) => Math.hypot(u - x, v - y) < 125)) continue;
    cand.push([x, y, 7 + r() * 3.5]);
  }
  const pick = cand.slice(0, K.star.length);
  pick.sort((a2, b2) => b2[0] - a2[0]);                    // 先亮的在右边（揭纸从右往左露出成品）
  const rest = pick.slice(2).sort(() => 0).sort((a2, b2) => (h01(a2[0]) - h01(b2[0])));
  BIGSTARS = [...pick.slice(0, 2), ...rest].map((p, i) => ({ x: p[0], y: p[1], r: p[2], t: K.star[i], s: WC.flecks([p], { seed: 300 + i, angle: 1.1 })[0] }));
  return BIGSTARS;
}
function drawBigStars(t) {
  for (const S of bigStars()) {
    const u = t - S.t; if (u < 0) continue;
    const pop = u < 1 / 24 ? 1.5 : u < 2 / 24 ? 1.2 : 1, rr = S.r * .78 * pop;
    m.fillStyle = '#000'; m.beginPath(); m.arc(S.x, S.y, rr * 2.2, 0, PI * 2); m.fill();
    m.fillStyle = '#fff'; m.beginPath(); m.arc(S.x, S.y, rr, 0, PI * 2); m.fill();
    WC.drawStrokes(m, [S.s], { color: '#fff' });
    if (u < 4 / 24) {    // 点亮那一刻：四道细刀的闪
      const L = S.r * (3.4 - u * 10);
      WC.drawStrokes(m, [0, PI / 2].map((a, k) => WC.mkStroke([[S.x - Math.cos(a) * L, S.y - Math.sin(a) * L], [S.x, S.y], [S.x + Math.cos(a) * L, S.y + Math.sin(a) * L]], 2.2, { kind: 'k', seed: 400 + k })), { color: '#fff' });
    }
  }
}
function finalPrint(g, t) {
  STARS = STARS || WD.stabField(170, [380, 0, PW, WD.HOR - 20], { seed: 71, pow: 1.4, r0: 1.4, r1: 2.6, angle: 1.0 });
  ST.beginPrint(FCAM);
  const th = .17, bm = WD.beam(WD.LAMP[0], WD.LAMP[1], th, { n: 15, half: .07, len: 2000, w: 14, seed: 52 });
  wideScene(K.peel, { calm: true, A: .38, skyK: .55, stars: STARS, beam: bm, beamFn: WD.inBeam(WD.LAMP[0], WD.LAMP[1], th, .07), boat: { x: 742, y: 604, roll: 0, lit: true, big: true }, lampLit: true });
  drawBigStars(t);
  c.fillStyle = 'rgba(0,0,0,1)'; c.beginPath(); c.arc(WD.LAMP[0], WD.LAMP[1], 28, 0, PI * 2); c.fill();
  ST.end();
  const a = seg(t, K.caption, K.caption + .1); if (a > 0) ST.caption(CAPTION, a);
  ST.printTo(g, { inkSeed: 15, reg: [3, 2] });
}
SHOTS.push({
  id: 'S6', ...sh('S6'),
  draw(g, t) {
    if (t >= K.peel_end) { finalPrint(g, t); return; }
    // 揭纸：上一张（S5 最后的样子）从右往左揭起，露出成品
    const [fb, fq] = buf(0); s5Draw(fq, K.peel - 1e-4, 1);
    const [bb, bq] = buf(1); bq.drawImage(paperTex(), 0, 0);
    bq.save(); bq.globalCompositeOperation = 'multiply'; bq.globalAlpha = .42; bq.setTransform(-1, 0, 0, 1, W, 0); bq.drawImage(fb, 0, 0); bq.restore();
    finalPrint(g, t);
    const { xf, r } = peelState(seg(t, K.peel, K.peel_end), 210);
    curl(g, fb, bb, xf, r, { F: 2000 });
  },
  events() { return [{ t: K.peel, type: 'peel', key: 'peel', dur: K.peel_end - K.peel }, { t: K.caption, type: 'letterpress', key: 'caption' }, { t: K.peel, type: 'room_bed', dur: DUR - K.peel }, ...K.star.map((ts, i) => ({ t: ts, type: 'star', key: `star.${i}`, v: 1 - i * .06 }))]; },
});
