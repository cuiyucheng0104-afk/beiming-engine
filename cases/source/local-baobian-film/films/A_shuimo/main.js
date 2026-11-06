// 《豹变》A 水墨 · 入口：加载、分镜调度、每帧合成与后期参数（DESIGN 4.0 总时间表）
// 页面约定：window.DUR = 30；window.render(t) 是 t 的纯函数；贴图、字体、着色器全部就绪后 window.READY = true
import * as THREE from 'three';
THREE.ColorManagement.enabled = false;
import { U, K, W, H, DW, DH, clamp, lerp, seg, ss, ss5, eo, ei, PAL, COL, mixPal, setPal, setFog, mix3, css, monotone, mulberry, hashi, fbm1, vnoise1 } from './lib/core.js';
import { createInkLook, NCAP, NLEAF, NSL } from './lib/inklook.js';
import { stroke, wobbleLine, drawSubtitle, inkBrush } from './lib/draw2d.js';
import { buildCliff, RIDGE_Y } from './shots/cliff.js';
import { buildRoom, SUB } from './shots/room.js';
import { buildMarket } from './shots/market.js';
import { buildSky, DOT_F } from './shots/sky.js';

const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);
const look = createInkLook(renderer, W, H);
const over = look.over, sub = look.sub;

// ───────── 贴图 ─────────
const loader = new THREE.TextureLoader();
async function loadTex(file) {
  const t = await loader.loadAsync(`./assets/${file}.png`);
  t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
  return t;
}
const FILES = {
  cub: 'cub_sit_v2', pose1: 'cub_poses_v2_pose1', pose2: 'cub_poses_v2_pose2', pose3: 'cub_poses_v2_pose3', pose4: 'cub_poses_v2_pose4', head: 'cub_head_cu',
  luSit: 'luwei_sit_back', walk1: 'luwei_walk_d1', walk2: 'luwei_walk_d2', walk3: 'luwei_walk_d3', ots: 'luwei_ots',
  hTweezers: 'hand_s1_tweezers', hPalm: 'hand_s1_palm', hReach: 'hand_s1_reach', hPinch: 'hand_s1_pinch',
  hTwo: 'hands_c5', hSeller: 'hands_c6', handRain: 'hand_rain_cu_right',
  crowd: 'market_crowd', woodcut: 'woodcut_leopard', scroll: 'scroll_mid', cliffWall: 'cliff_wall', peakRock: 'peak_rock', pineS5: 'pine_s5', pineS2: 'pine_s2', maskGold: 'mask_gold_v3', marketFg: 'market_fg',
};
const tex = {};
await Promise.all(Object.entries(FILES).map(async ([k, f]) => { tex[k] = await loadTex(f); }));
const man = Object.fromEntries((await (await fetch('./assets/manifest.json')).json()).map(e => [e.id, e]));

// ───────── 字体：字幕马善政楷书（"豹""变"在 80K 下也认得出）；书页「革」同 ─────────
const fMS = new FontFace('BBMS', 'url(/fonts/MaShanZheng-baobian.woff2)');
await fMS.load();
document.fonts.add(fMS);
await document.fonts.ready;

const ctx = { tex, man, look, over, renderer };
const cliff = buildCliff(ctx);
const room = buildRoom(ctx);
const market = buildMarket(ctx);
const sky = buildSky(ctx);

// ───────── 后期参数（DESIGN 3.3 各段参数表） ─────────
const LK = {
  S1: { bleedR: 2.5, bleedA: 0.45, wsSig: 4, wsS: 0.35, inkG: 0.05, paper: 0.07, vig: 0.12, grain: 0.020, sat: 0.85, warm: 0.15, soft: 0.12 },
  T1: { bleedR: 3.5, bleedA: 0.60, wsSig: 5, wsS: 0.45, inkG: 0.08, paper: 0.07, vig: 0.10, grain: 0.020, sat: 0.80, warm: 0.15, soft: 0.12 },
  S2: { bleedR: 3.5, bleedA: 0.60, wsSig: 5, wsS: 0.45, inkG: 0.07, paper: 0.07, vig: 0.10, grain: 0.020, sat: 0.80, warm: -0.08, soft: 0.12 },
  S3: { bleedR: 3.2, bleedA: 0.52, wsSig: 4, wsS: 0.36, inkG: 0.06, paper: 0.06, vig: 0.14, grain: 0.025, sat: 0.92, warm: 0.02, soft: 0.10 },   // 返修第 3 轮：集市也吃足洇与水渍边（和书中世界同一套墨）
  S4: { bleedR: 3.5, bleedA: 0.60, wsSig: 5, wsS: 0.50, inkG: 0.08, paper: 0.07, vig: 0.10, grain: 0.020, sat: 0.82, warm: -0.08, soft: 0.12 },
  S5: { bleedR: 3.5, bleedA: 0.55, wsSig: 5, wsS: 0.45, inkG: 0.07, paper: 0.07, vig: 0.08, grain: 0.018, sat: 1.0, warm: 0.0, soft: 0.12 },   // 返修第 3 轮（style-16）：长卷的赭与花青不再被后期去饱和吃掉
  T2: { bleedR: 3.0, bleedA: 0.50, wsSig: 4, wsS: 0.40, inkG: 0.06, paper: 0.06, vig: 0.12, grain: 0.018, sat: 0.90, warm: 0.0, soft: 0.10 },
  S6: { bleedR: 2.5, bleedA: 0.45, wsSig: 4, wsS: 0.35, inkG: 0.05, paper: 0.07, vig: 0.12, grain: 0.020, sat: 0.85, warm: 0.15, soft: 0.12 },
};
const mixLK = (a, b, k) => Object.fromEntries(Object.keys(a).map(n => [n, lerp(a[n], b[n], clamp(k))]));
function paperParams(p) {
  if (!p) return { paperOff: [0, 0], paperSc: 1 };
  const ax = p.x, ay = DH - p.y, rx = p.rx, ry = DH - p.ry, s = p.s;
  return { paperOff: [ax - s * rx, ay - s * ry], paperSc: s };
}
const FOG_S2 = { density: 0.010, start: 6, max: 0.92, base: -1.5, falloff: 4 };

// ═════════ T1：墨从六爻洇开（按覆盖率反推半径）→ 六道浓墨线弯成山脊 → 横缝显山（DESIGN 5.1，返修版） ═════════
let CAP94 = null, CAP98 = null;
function capsAt(fq) { room.T1({ f: Math.round(fq), fr: fq }); return room.barCapsules(); }
// 覆盖率目标：f95 20% → f98 52% → f101 84% → f103 99% → f104 起 100%
// 返修 w3（qa2-01 / v3-06）：原来 f104 才 92%、f110 才盖满，剩下没盖住的那块正好在画底正中（离六道线最远），
//   f104 初九那道线变细上移时露出来，透出书页的暖纸、再变成雾崖的冷白、f109 才合上（穿帮）。现在 f104 起整屏都在墨下，
//   墨下的换场（书页 → 雾崖）挪到 f103–f106 做完，f107 起横缝显山时露出来的只有雾崖
const COV = monotone([[94, 0], [95, 0.20], [98, 0.52], [101, 0.84], [102, 0.94], [103, 0.99], [103.5, 1]]);   // 103.5：t = 104/24 这类时刻浮点乘回去是 103.99999，也要算盖满
// 墨晕覆盖：按当前这一刻六道线（爻条投影）的胶囊距离场取分位，反推墨晕半径（覆盖率与目标一致）
function covTable(caps) {
  const ds = [];
  for (let j = 0; j < 66; j++) for (let i = 0; i < 120; i++) {
    const x = (i + 0.5) * DW / 120, y = (j + 0.5) * DH / 66;
    let d = 1e9;
    for (const c of caps) { const ax = c.a[0], ay = c.a[1], bx = c.b[0], by = c.b[1]; const px = x - ax, py = y - ay, qx = bx - ax, qy = by - ay; const h = clamp((px * qx + py * qy) / Math.max(qx * qx + qy * qy, 1e-4)); d = Math.min(d, Math.hypot(px - qx * h, py - qy * h) - 14); }
    ds.push(d);
  }
  return ds.sort((a, b) => a - b);
}
let DQ98 = null;
const T1R = (fr, DQ) => { if (fr < 94) return 0; const c = COV(fr); if (c >= 0.9995) return DQ[DQ.length - 1] + 400; return Math.max(1, DQ[Math.min(DQ.length - 1, Math.floor(c * DQ.length))]) + (fr > 108 ? (fr - 108) * 120 : 0); };
// 返修第 3 轮（v1-02）：墨晕与六道线都"印在书页上"，跟着俯冲的机位一起走（不再定格在 f94 的屏幕位置）；f96–f100 缓缓停住（停在 f98 的样子），之后原地化开、弯成山
const tauOf = fr => fr <= 96 ? fr : fr >= 100 ? 98 : 96 + 4 * ((fr - 96) / 4 - ((fr - 96) / 4) ** 2 / 2);
// 返修第 3 轮（v2-08）：显山横缝改成缓起缓收（ss），开启段 f107–f118，最快的一帧也只开约 100 px，不再一帧张开六成画高
const Q0 = 107, Q1 = 118;
const T1Q = fr => fr < Q0 ? 0 : 720 * ss(seg(fr, Q0, Q1));
const T1LAM = fr => fr < 100 ? 30 * Math.pow(3, seg(fr, 94, 100)) : 90 * Math.pow(170 / 90, seg(fr, 100, 108));   // 心浓边淡的衰减长度随墨洇开变长
// 返修第 3 轮（v1-02 ②）：墨吞没以后（f99–f105）整片化淡到"重—淡"，六道焦墨线压在上面一直看得清
const T1DMAX = fr => lerp(0.95, 0.52, ss(seg(fr, 99, 105)));
function yaoLines(caps) {
  const L = [];
  for (let k = 0; k < 6; k++) {
    const cs = caps.filter(c => c.k === k);
    if (cs.length === 1) L.push({ k, a: cs[0].a, b: cs[0].b, w: [cs[0].wA, cs[0].wB], gapA: null, gapB: null, depth: cs[0].depth });
    else { const [l, r] = cs[0].a[0] < cs[1].a[0] ? cs : [cs[1], cs[0]]; L.push({ k, a: l.a, b: r.b, gapA: l.b, gapB: r.a, w: [l.wA, l.wB, r.wA, r.wB], depth: l.depth }); }
  }
  return L;
}
// 六道浓墨线（返修第 3 轮 v1-02 ①）：f92–f95 先按爻条投影的四个角起笔——同位置、两端各自同宽（近宽远窄）、两端平齐，盖在 3D 爻条上淡入，
//   f95 爻条撤掉（被同形的线整个盖住，看不出换了一样东西）；f95–f101 才慢慢变成起笔重、收笔出锋、粗细起伏的毛笔线；
//   f98 前线一直跟着爻条的投影走（不再停在 f94 的屏幕位置、f96 跳回去），f98–f108 原地弯成山脊顶线
//   base[i]：kT = 0 时每点的直径（爻条投影宽）；th：kT = 1 时的笔宽
// 返修 w3（v3-05）：① 线宽沿线用平滑噪声起伏 ±30%（不再按 9 段阶梯跳），起笔一段按笔加重、收笔出锋；
//   ② 墨吞没以后线还宽的那几帧（f99–f110）加飞白：一束束顺笔画、两头收尖的淡墨细丝，外加两三片软边淡一档的"浓淡不匀"；
//   ③ 与 3D 爻条重叠的那几帧（kT = 0）不画外晕；线宽、线长的收缩见 drawYaoLines（qa2-08）
function brushPath(g, pts, th, c3, alpha, seed, kT, base, dry = 0, lp1 = c3, lp3 = c3) {
  const n = pts.length, cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const tot = cum[n - 1] || 1;
  const prOf = u => clamp(0.70 + 0.30 * fbm1(u * 5.5 + seed * 1.7, 900 + seed, 3) + 0.10 * Math.sin(u * 2.3 + seed) + 0.30 * Math.exp(-(((u - 0.035) / 0.05) ** 2)), 0.40, 1.30);
  const R = pts.map((p, i) => { const u = cum[i] / tot; return lerp(base[i] / 2, th * (0.25 + 0.5 * prOf(u)), kT); });
  const S = Math.max(...R, 0.5) * 1.001;
  const P3 = pts.map((p, i) => [p[0], p[1], R[i] / S]);
  inkBrush(g, P3, S, c3, alpha, seed, { t0: Math.max(0.5, th * 0.6 * kT), t1: Math.max(0.5, th * 3.0 * kT), thinning: 1, streamline: 0.3 * kT, rough: Math.max(0.8, S * 0.06 * (0.3 + 0.7 * kT)), endA: lerp(1, 0.72, kT), halo: kT, bleed: 1.6 * kT });
  // 枯笔透空（飞白）：墨吞没以后（dry 从 f99 到 f102 起来）、线还宽（> 14 设计像素）的时候。飞白是一束束顺笔画的细丝（1–3 设计像素宽、两头收尖），
  //   用淡墨色画在浓墨带上（不挖洞：挖洞会透出还没盖住的书页）；多在收笔那一半和两侧边上；浓淡不匀是两三片边很软、淡一档的墨
  const wide = dry * clamp((S * 2 - 14) / 36);
  if (wide <= 0.01 || n < 3) return;
  const nrm = pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)]; const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; });
  const atU = (u, off) => { const x = clamp(u) * tot; let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m; else hi = m; } const k = (x - cum[lo]) / Math.max(cum[hi] - cum[lo], 1e-3); const px = lerp(pts[lo][0], pts[hi][0], k), py = lerp(pts[lo][1], pts[hi][1], k), r = lerp(R[lo], R[hi], k), nx = lerp(nrm[lo][0], nrm[hi][0], k), ny = lerp(nrm[lo][1], nrm[hi][1], k); return [px + nx * r * off, py + ny * r * off]; };
  const sc = Math.abs(g.getTransform().a) || 1;
  g.save();
  g.filter = `blur(${(Math.max(2, S * 0.30) * sc).toFixed(2)}px)`;
  for (let j = 0; j < 3; j++) {                                       // 浓淡不匀：软边、淡一档的长块
    const h = k => hashi(seed * 211 + j * 19 + k * 5);
    const u0 = 0.12 + 0.62 * h(1), u1 = Math.min(0.95, u0 + 0.10 + 0.18 * h(2)), off = (h(3) - 0.5) * 0.7;
    const P = []; for (let k = 0; k <= 16; k++) { const [x, y] = atU(lerp(u0, u1, k / 16), off); P.push([x, y, 0.4 + 0.6 * Math.sin(Math.PI * k / 16)]); }
    stroke(g, P, S * (0.6 + 0.4 * h(4)), css(lp3, (0.16 + 0.10 * h(5)) * wide), { t0: S * 2, t1: S * 3, thinning: 0.6 });
  }
  g.filter = `blur(${(0.45 * sc).toFixed(2)}px)`;
  const NB = 2 + Math.round(3 * clamp((S * 2 - 14) / 60));             // 飞白：2–5 束，每束 4–8 根
  for (let bI = 0; bI < NB; bI++) {
    const h = k => hashi(seed * 131 + bI * 17 + k * 7);
    const sgn = h(1) < 0.5 ? -1 : 1, off0 = sgn * (0.25 + 0.55 * Math.pow(h(2), 0.7));
    const u0 = 0.22 + 0.62 * Math.pow(h(3), 0.6), len = 0.05 + 0.14 * h(4);
    const nH = 4 + Math.floor(5 * h(5));
    for (let j = 0; j < nH; j++) {
      const hh = k => hashi(seed * 977 + bI * 131 + j * 29 + k * 3);
      const off = off0 + (j - nH / 2) * (0.035 + 0.03 * hh(1)), uA = u0 + 0.04 * (hh(2) - 0.5), uB = Math.min(0.98, uA + len * (0.5 + 0.7 * hh(3)));
      const lw = 0.9 + 2.0 * hh(4), al = (0.30 + 0.45 * hh(5)) * wide;
      const P = []; for (let k = 0; k <= 20; k++) { const [x, y] = atU(lerp(uA, uB, k / 20), off + 0.02 * (k / 20 - 0.5) * (hh(6) - 0.5)); P.push([x, y, 0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, k / 20 * 1.1))]); }
      stroke(g, P, lw, css(lp1, al), { t0: lw * 6, t1: lw * 14, thinning: 0.6 });
    }
  }
  g.restore();
}
// 屏幕 x 处某重山的顶线 y（按折线插值）
function polyY(poly, x) {
  const n = poly.length;
  if (x <= poly[0][0]) return poly[0][1];
  if (x >= poly[n - 1][0]) return poly[n - 1][1];
  let lo = 0, hi = n - 1;                                  // 返修 w3：折线点加密到上千个，改二分查找
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (poly[m][0] < x) lo = m; else hi = m; }
  const a = poly[lo], b = poly[hi]; return lerp(a[1], b[1], (x - a[0]) / Math.max(b[0] - a[0], 1e-3));
}
let capsNow = null;
const lineSrc = fr => (fr < 100 && capsNow) ? capsNow : CAP98;
function drawYaoLines(g, fr, pal6, amp) {
  if (fr < 91.5 || fr >= 117) return;
  const src = yaoLines(lineSrc(fr));
  const u = ss(seg(fr, 98, 108)), fade = (1 - ss(seg(fr, 111, 117))) * ss(seg(fr, 91.5, 94.5));
  if (fade <= 0) return;
  cliff.camS2(fr);
  const cl = p => [clamp(p[0], -300, 2220), clamp(p[1], -60, 1100)];
  const RID = [0, 1, 2, 3, 4, 5].map(k => cliff.ridgePolyline(k, amp, 480));
  const kT = ss(seg(fr, 95, 101));
  for (const ln of src) {
    const ridge = cliff.ridgePolyline(ln.k, amp, 1200);              // 返修 w3（v3-05）：72 点 → 1200 点（屏幕上每段约 4 px，读不出直段和折角）
    // 线的墨色：先是浓墨；弯成山的过程中（f100–f108）近浓远淡，f108–f114 换成那重山顶线自己的墨
    const ridgeInk = pal6[ln.k < 2 ? 3 : 2];
    const c0 = mix3(mix3(pal6[4], pal6[5], 0.6), mix3(pal6[3], pal6[4], 0.5), ss(seg(fr, 100, 108)) * ln.k / 5);
    const c3 = mix3(c0, ridgeInk, ss(seg(fr, 108, 114)));
    const al = 0.97 * fade;
    const straight = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
    // 返修 w3（qa2-08）：和 3D 爻条叠着淡入的那几帧（f91.5–f95），线比爻条投影窄一成、两头各缩进 13%，整条藏在爻条的实墨里
    //   （爻条两头约两成是斜刀和飞白，线若同长同宽，平头会从刀口外、飞白缝里露出一截灰边，读成双边）；f95 爻条撤掉后 4 帧内长回全宽全长
    const gw = ss(seg(fr, 95, 99)), wf = lerp(0.90, 1, gw), ins = lerp(0.13, 0, gw);
    const inset = (a, b) => [[lerp(a[0], b[0], ins), lerp(a[1], b[1], ins)], [lerp(b[0], a[0], ins), lerp(b[1], a[1], ins)]];
    const sg = (a, b, side, w0, w1) => { const [a2, b2] = inset(cl(a), cl(b)); return [a2, b2, side, w0 * wf, w1 * wf]; };
    const segs = ln.gapA ? [sg(ln.a, ln.gapA, 0, ln.w[0], ln.w[1]), sg(ln.gapB, ln.b, 1, ln.w[2], ln.w[3])] : [sg(ln.a, ln.b, -1, ln.w[0], ln.w[1])];
    segs.forEach(([a, b, side, w0, w1], si) => {
      const th = lerp(0.86 * (w0 + w1) / 2, 9.5 - 0.9 * ln.k, u) * (1 - 0.35 * ss(seg(fr, 106, 112)));   // 弯成山时近粗远细
      let rs = ridge;
      if (side >= 0) { const gxS = (ln.k === 1 ? 1280 : 1420); rs = ridge.filter(p => side === 0 ? p[0] < gxS - 40 : p[0] > gxS + 40); }
      const M = rs.length;
      if (M < 2) return;
      const pts = [], base = [];
      for (let i = 0; i < M; i++) { const t = i / (M - 1); const s = straight(a, b, t); pts.push([lerp(s[0], rs[i][0], u), lerp(s[1], rs[i][1], u)]); base.push(lerp(w0, w1, t)); }
      // 弯成山以后，被近处山头挡住的那几段不画（近山在前）：按可见段分笔
      const vis = pts.map(p => u < 0.6 || ln.k === 0 || !RID.slice(0, ln.k).some(R => polyY(R, p[0]) < p[1] - 3));
      let run = [], rb = [];
      const flush = (si2) => { if (run.length > 2) brushPath(g, run, th, c3, al, ln.k * 3 + si + 1 + si2 * 7, kT, rb, ss(seg(fr, 99, 102)) * (1 - ss(seg(fr, 106, 110))), mix3(pal6[1], pal6[2], 0.45), pal6[3]); run = []; rb = []; };
      pts.forEach((p, i) => { if (vis[i]) { run.push(p); rb.push(base[i]); } else flush(i); });
      flush(99);
    });
  }
}
// 当前六道线（直线近似）的胶囊：墨的浓处跟着线走
function lineCaps(fr) {
  const u = ss(seg(fr, 98, 108)), out = [];
  cliff.camS2(fr);
  for (const ln of yaoLines(lineSrc(fr))) {
    const ty = cliff.ridgeLineY(ln.k);
    const A = [lerp(ln.a[0], -90, u), lerp(ln.a[1], ty, u)], B = [lerp(ln.b[0], 2010, u), lerp(ln.b[1], ty, u)];
    if (ln.gapA) {
      const gc = ln.k === 1 ? 1280 : 1420;
      out.push([A, [lerp(ln.gapA[0], gc - 40, u), lerp(ln.gapA[1], ty, u)]], [[lerp(ln.gapB[0], gc + 40, u), lerp(ln.gapB[1], ty, u)], B]);
    } else out.push([A, B]);
  }
  return out;
}
function setT1Comp(fr, pal6) {
  const CU = look.CU;
  const caps = lineSrc(fr);
  CU.uT1.value.set(1, T1R(fr, fr < 100 ? covTable(caps) : DQ98), T1Q(fr), ss(seg(fr, 116, 124)));
  caps.forEach((c, i) => { if (i < NCAP) CU.uCap.value[i].set(c.a[0], c.a[1], c.b[0], c.b[1]); });
  const l2 = lineCaps(fr);
  l2.forEach(([a, b], i) => { if (i < NCAP) CU.uCap2.value[i].set(a[0], a[1], b[0], b[1]); });
  CU.uCapR.value.set(14, lerp(0.38, 0.62, ss(seg(fr, 101, 106))), T1DMAX(fr), T1LAM(fr));   // 纸路少而碎，墨吞没以后（f101–f106）基本收掉（不读成等高线）
  CU.uT1X.value.set(0.25, 0.22, 1, 0);
}
// 潮线：退墨边界扫过某重山顶线的那一刻起，8 帧内衰减（Q(f) = 720·ss((f−107)/11)，按 ss 的反函数求那一帧）
const ssInv = y => 0.5 - Math.sin(Math.asin(clamp(1 - 2 * y, -1, 1)) / 3);
function tides(fr) {
  cliff.camS2(fr);
  return RIDGE_Y.map((_, k) => {
    const y = cliff.ridgeLineY(k), need = Math.abs(y - 425);
    const uu = need / 720; if (uu >= 1) return 0;
    const f0 = Q0 + (Q1 - Q0) * ssInv(uu);
    return fr < f0 ? 0 : Math.exp(-(fr - f0) / 3.2) * (fr < f0 + 8 ? 1 : 0.6);
  });
}

// ═════════ T2 匹配：光带在豹眼里起、在镜片上收；两边亮点钉在 P = (650, 372) ═════════
const PEYE = [650, 372];
// S6 眼镜（参考帧 f645 的设计像素）：镜腿从耳后 (516,331) 到铰链 H (642,364)；镜框弧从 H 起笔、经过 P，露 110°
const GL = { ear: [518, 331], hinge: [647, 392], c: [697, 392], r: 50, a0: 180, a1: 300 };
function xfPt(xf, p) { return [xf.o1[0] + (p[0] - xf.o0[0]) * xf.s, xf.o1[1] + (p[1] - xf.o0[1]) * xf.s]; }
function setBand(fr, onLens, xfS) {
  const CU = look.CU;
  const n = [0.81915, 0.57358];
  const Pp = onLens ? xfPt(xfS, PEYE) : PEYE;
  const s0 = Pp[0] * n[0] + Pp[1] * n[1];
  if (fr >= 640 && fr < 650) {
    const pos = s0 + 18 * (fr - 643);
    CU.uBand.value.set(1, pos, onLens ? 18 : 8, (onLens ? 0.70 : 0.78) * (1 - ss(seg(fr, 647, 650))));   // 返修 w3（v3-01）：眼里只是一道纸色细条（宽 8K），镜片上宽一些
    const lc = onLens ? xfPt(xfS, GL.c) : [0, 0];
    CU.uBandR.value.set(onLens, lc[0], lc[1], GL.r * (onLens ? xfS.s : 1));
  }
  let fl = 0;
  if (fr < 645) fl = ss(seg(fr, 641, 644)); else fl = 1 - eo(seg(fr, 645, 652));
  if (fl > 0) {
    if (!onLens) CU.uFlare.value.set(PEYE[0] - 75 * 0.36, PEYE[1] - 75 * 0.40, 0, 0.12 * fl);   // 返修 w3（v3-01）：豹眼一闪不再是锐利的四芒白点——高光那块留纸略张大，外加一层很淡的软晕
    else CU.uFlare.value.set(Pp[0], Pp[1], 0.70 * fl, 0.30 * fl);
  }
}
function drawGlassesS6(g, pal, fr, xfS) {
  const a = 1;                                   // 返修 w3（qa2-07）：眼镜不再在叠加层上单独淡出——叠加层也进退墨，跟画面同一个 τ 褪（浓墨的镜框最后褪）
  const E = xfPt(xfS, GL.ear), Hh = xfPt(xfS, GL.hinge), C = xfPt(xfS, GL.c), R = GL.r * xfS.s;
  g.save(); g.globalAlpha = a;
  stroke(g, wobbleLine(E, Hh, 16, 5, 0.4, [0.5, 0.9, 0.8]), 2.8, css(pal[4], 0.92), { t0: 4, t1: 1 });
  const pts = [];
  for (let i = 0; i <= 24; i++) { const th = (GL.a0 + (GL.a1 - GL.a0) * i / 24) * Math.PI / 180; pts.push([C[0] + R * Math.cos(th), C[1] + R * Math.sin(th), i < 3 ? 0.9 : 1 - 0.5 * i / 24]); }
  stroke(g, pts, 2.8, css(pal[4], 0.92), { t0: 2, t1: 16 });
  g.globalAlpha = a * 0.30; g.strokeStyle = css(pal[3], 1); g.lineWidth = 1.4;           // 镜框其余部分：极淡一圈，读得出是圆镜片
  g.beginPath(); g.arc(C[0], C[1], R, (GL.a1 + 8) * Math.PI / 180, (GL.a0 + 352) * Math.PI / 180); g.stroke();
  g.restore();
  look.CU.uLens.value.set(C[0], C[1], R * 0.97, 0.09 * a);
}
// 字幕：马善政楷书竖排两列；f672 起每字错开 2 帧显影
// 返修 w3（qa2-06）：起点不动（28.00 s），每字显影 6 帧 → 4 帧，f690 出齐（原 f692）；画面退墨压到 f713–f717、字幕 f716–f719 淡出（都在最后 0.3 s 里），
//   八个字完整可读从约 0.95 s 拉到约 1.1 s（f690–f716）
const SUB_F = [672, 674, 676, 678, 680, 682, 684, 686];
function drawSubs(g, fr, pal) {
  if (fr < 672) return false;
  const a = 0.90 * (1 - ss(seg(fr, 716, 719)));
  if (a <= 0) return false;
  const prog = SUB_F.map(f0 => ss(seg(fr, f0, f0 + 4)));
  drawSubtitle(g, [...'君子豹变'], SUB.x[0], SUB.y, SUB.size, SUB.step, prog.slice(0, 4), PAL.real[5], a);
  drawSubtitle(g, [...'其文蔚也'], SUB.x[1], SUB.y, SUB.size, SUB.step, prog.slice(4), PAL.real[5], a);
  return true;
}
// S6 叶影与光斑的布局（返修第 2 轮 style-06 / story-09：倒过来做——先铺叶荫，光斑是叶荫里漏下来的空洞）
// 返修 w3（v3-02 ③ / qa2-04）：叶荫改成一枝枝叶子的影子——每枝一根看不见的细枝，叶子两两错开长在枝上（尖椭圆、长短宽窄各不同），
//   一片片淡墨相互叠墨：叶子叠得多处深一档、枝与枝之间偶尔露出受光的衬衫，叶形看得出来；衬衫上 7 枝（叶荫盖住大半个肩背）、书与双手 2 枝（淡一些）、前臂几片。
//   光斑只落在叶荫够深（至少两层叶子）的地方：衬衫 ≤ 16 个大而暖，书与手上 ≤ 6 个稀而淡；大小按对数正态、形状各自拉长
const S6L = (() => {
  const rnd = mulberry(66067), logn = (m, sd) => m * Math.exp(sd * Math.sqrt(-2 * Math.log(Math.max(1e-6, rnd()))) * Math.cos(2 * Math.PI * rnd()));
  const leaves = [], spots = [];
  const spray = (bx, by, th, len, n, lay, rr, str) => {
    const dx = Math.cos(th), dy = Math.sin(th), bend = (rnd() - 0.5) * 0.6;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.6) / n, side = k % 2 ? 1 : -1;
      const a = th + bend * t, px = bx + dx * len * t + Math.cos(a + Math.PI / 2) * len * 0.06 * Math.sin(t * 3), py = by + dy * len * t + Math.sin(a + Math.PI / 2) * len * 0.06 * Math.sin(t * 3);
      const la = a + side * (0.55 + 0.45 * rnd()) * (1 - 0.35 * t), r = rr * (0.70 + 0.55 * rnd()) * (1 - 0.25 * t);
      leaves.push({ x: px + Math.cos(la) * r * 0.85, y: py + Math.sin(la) * r * 0.85, r, ang: la, asp: 0.30 + 0.16 * rnd(), lay, str: str * (0.85 + 0.3 * rnd()) });
    }
    leaves.push({ x: bx + dx * len * 1.05, y: by + dy * len * 1.05, r: rr * 0.8, ang: th + bend, asp: 0.34, lay, str });   // 枝梢一片
  };
  // 肩背衬衫：五枝，从左上、右上往下斜着垂进来，枝与枝之间露出受光的衬衫
  spray(-80, 420, 0.50, 640, 16, 'shirt', 80, 0.30);
  spray(200, 430, 0.95, 640, 16, 'shirt', 76, 0.30);
  spray(520, 450, 1.85, 580, 14, 'shirt', 72, 0.30);
  spray(-60, 700, 0.20, 620, 14, 'shirt', 78, 0.30);
  spray(380, 640, 1.30, 480, 12, 'shirt', 70, 0.28);
  spray(100, 880, -0.15, 580, 13, 'shirt', 74, 0.30);
  spray(660, 760, 2.45, 440, 10, 'shirt', 66, 0.28);
  // 书与双手：两枝（淡一些），前臂几片
  spray(1040, 560, 0.70, 330, 9, 'book', 44, 0.20);
  spray(1470, 600, 2.30, 300, 8, 'book', 40, 0.18);
  for (let i = 0; i < 4; i++) leaves.push({ x: 1010 + i * 120 + (rnd() - 0.5) * 40, y: 915 + (rnd() - 0.5) * 70, r: 48 + rnd() * 16, ang: 0.4 + (rnd() - 0.5) * 1.2, asp: 0.34 + 0.1 * rnd(), lay: 'book', str: 0.20 });
  const shadeAt = (x, y, lay) => {
    let T = 1;
    for (const L of leaves) {
      if (L.lay !== lay) continue;
      const dx = x - L.x, dy = y - L.y, ca = Math.cos(L.ang), sa = Math.sin(L.ang);
      const ex = (ca * dx + sa * dy) / L.r, ey = (-sa * dx + ca * dy) / L.r;
      const hw = L.asp * Math.pow(Math.max(1 - ex * ex, 0), 0.72);
      if (hw - Math.abs(ey) > 0.04) T *= 1 - L.str;
    }
    return 1 - T;
  };
  const place = (lay, n, box, med, sq, str, minShade) => {
    for (let it = 0, made = 0; it < 4000 && made < n; it++) {
      const x = box[0] + rnd() * (box[2] - box[0]), y = box[1] + rnd() * (box[3] - box[1]), R = clamp(logn(med, 0.42), 11, 54);
      if (shadeAt(x, y, lay) < minShade || spots.some(S => Math.hypot(S.x - x, (S.y - y) / S.sq) < (S.R + R) * 1.25)) continue;
      spots.push({ x, y, R, sq, str, lay }); made++;
    }
  };
  place('shirt', 18, [30, 480, 700, 1030], 38, 1, 1, 0.48);
  place('book', 4, [960, 860, 1380, 1010], 22, 0.75, 0.85, 0.30);
  place('book', 2, [1080, 610, 1440, 840], 14, 0.60, 0.40, 0.30);
  return { leaves: leaves.slice(0, NLEAF), spots: spots.slice(0, NSL) };
})();
function setS6Light(fr, xf, tip) {
  const CU = look.CU;
  CU.uLeaf.value.set(1, 1.0, U.uT.value * 0.4, Math.sin(2 * Math.PI * U.uT.value / 2.5));
  S6L.leaves.forEach((L, i) => { const x = xf[L.lay], p = xfPt(x, [L.x, L.y]); CU.uLeafB.value[i].set(p[0], p[1], L.r * x.s, L.ang); CU.uLeafC.value[i].set(L.str, L.asp, 0, 0); });
  CU.uNLeaf.value = S6L.leaves.length;
  S6L.spots.forEach((S, i) => { const x = xf[S.lay], p = xfPt(x, [S.x, S.y]); CU.uSpotL.value[i].set(p[0], p[1], S.R * x.s, S.sq); CU.uSpotF.value[i].set(1, 500 + i * 7, 2 + Math.floor(hashi(i * 13 + 2) * 3), S.str); });
  CU.uNSpotL.value = S6L.spots.length;
  if (fr >= 670) CU.uLight2.value.set(tip[0], tip[1], 26 * xf.book.s, clamp((fr - 670) / 12));
}
function clearCanvas(g) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.filter = 'none'; g.globalAlpha = 1;
  g.globalCompositeOperation = 'copy'; g.fillStyle = 'rgba(0,0,0,0)'; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = 'rgba(0,0,0,0.004)'; g.fillRect(0, 0, 1, 1);
  g.setTransform(K, 0, 0, K, 0, 0);
}
// ───────── 每帧 ─────────
function frame(t) {
  t = clamp(t, 0, 30);
  U.uT.value = t;
  const fr = Math.min(719.999, t * 24), f = Math.min(719, Math.round(t * 24));
  look.resetComp();
  clearCanvas(over); clearCanvas(sub);
  const CU = look.CU;
  let lp = LK.S2, paper = null, pal = PAL.cliff, hasSub = false;

  if (f < 82) {                                        // ── S1 修复室（主观俯拍一镜）
    pal = PAL.real; setPal(pal); setFog(null);
    const r = room.S1({ f, fr, t, over });
    look.world('A', room.scene, r.cam, U.uPal.value[0].toArray());
    paper = r.paper; lp = LK.S1;
    CU.uWin.value.set(1, 1, 0.04, t * 0.05);
    if (fr >= 68) CU.uArcs.value.set(0.55 * ss(seg(fr, 68, 72)) * (1 - ss(seg(fr, 74, 86))), 0, 0, 0);
    if (fr >= 62 && fr <= 72 && r.glassAt) {             // 镜片一闪：先映一道暗影托底，再一颗四芒留白星光扫过
      const pk = fr <= 67 ? ss(seg(fr, 63, 67)) : 1 - ss(seg(fr, 67, 71));
      CU.uGlintL.value.set(r.glassAt[0], r.glassAt[1], (r.glassR || 46) * 0.95, 0.13 * ss(seg(fr, 62, 65)) * (1 - ss(seg(fr, 69, 72))));
      CU.uGlint.value.set(r.glassAt[0] - 6, r.glassAt[1] - 4, 52, 0.9 * pk);
    }
    if (fr < 8) CU.uFadeP.value = 1 - ss(fr / 8);
  } else if (f < 114) {                                // ── T1 六爻化六重山（墨晕 f94 起）
    const k = ss(seg(fr, 94, 106));
    pal = mixPal(PAL.real, PAL.cliff, k); setPal(pal);
    lp = mixLK(LK.T1, { ...LK.T1, warm: -0.08 }, k);
    const amp = ss(seg(fr, 102, 112));
    if (f < 108) {
      setFog(null);
      // 返修第 2 轮（v1-02）：f92–f96 爻条与 2D 线交叉溶解（同位置、同宽），不再一帧换掉
      const r = room.T1({ f, fr, t, barOp: fr < 95 ? 1 : 0, shOp: 1 - ss(seg(fr, 93, 98)) });
      look.world('A', room.scene, r.cam, U.uPal.value[0].toArray());
      paper = r.paper;
      if (fr < 100) capsNow = fr <= 96 ? room.barCapsules() : capsAt(tauOf(fr));   // 渲完这一帧的书页之后再取（取 τ 时刻的机位不影响已渲的画面）
      CU.uArcs.value.set(0.55 * (1 - ss(seg(fr, 74, 86))), 0, 0, 0);
      CU.uWin.value.set(1, 1 - k, 0.04 * (1 - k), t * 0.05);
    }
    if (f >= 103) {
      setFog(FOG_S2);
      const r2 = cliff.S2({ f, fr, t, over: null, pal, amp, tide: tides(fr), rainOp: 0 });
      look.world(f < 108 ? 'B' : 'A', cliff.scene, r2.cam, U.uPal.value[0].toArray());
      if (f < 108) CU.uMixB.value = ss(seg(fr, 103, 106)); else paper = r2.paper;   // 返修 w3（qa2-01）：墨下换场 f103–f106 做完（此时整屏已在墨下）
      cliff.fgMask(look.world, r2.cam);
      CU.uLineM.value = ss(seg(fr, 108, 114));            // 崖显出来以后，线才落到崖后面
    }
    if (fr >= 94) setT1Comp(fr, pal);
    drawYaoLines(over, fr, pal, amp);
  } else if (f < 266) {                                // ── S2 南山雾崖（一镜）
    pal = PAL.cliff; setPal(pal); setFog(FOG_S2);
    const amp = ss(seg(fr, 102, 112));
    const r = cliff.S2({ f, fr, t, over, pal, amp, tide: tides(fr), rainOp: ss(seg(fr, 116, 126)) });
    look.world('A', cliff.scene, r.cam, U.uPal.value[0].toArray());
    paper = r.paper; lp = LK.S2;
    CU.uExpo.value = r.expo;
    if (fr < 124) {
      setT1Comp(fr, pal);
      if (fr < 118) {
        cliff.fgMask(look.world, r.cam); CU.uLineM.value = ss(seg(fr, 108, 114));
        clearCanvas(over); drawYaoLines(over, fr, pal, amp);
        cliff.rain(over, fr, 0, 0, ss(seg(fr, 116, 126)));
      }
    }
  } else if (f < 324) {                               // ── S3a–S3c 面具集市（快切、手持）
    pal = PAL.market; setPal(pal); setFog(null);
    const r = f < 292 ? market.S3a({ f, fr, t }) : f < 308 ? market.S3b({ f, fr, t }) : market.S3c({ f, fr, t });
    look.world('A', market.scene, r.cam, U.uPal.value[0].toArray());
    lp = LK.S3;
  } else if (f < 355) {                                // ── S3d 眼孔推进 → 墨晕回到雾崖（分支按整数帧，避开相机贴着面具平面的那一瞬）
    lp = mixLK(LK.S3, LK.S4, ss(seg(fr, 342, 352)));
    if (f < 347) {
      pal = PAL.market; setPal(pal); setFog(null);
      const r = market.S3d({ f, fr, t });
      look.world('A', market.scene, r.cam, U.uPal.value[0].toArray());
      if (fr >= 326) {
        setPal(PAL.cliff); setFog(FOG_S2);
        const r4 = cliff.S4({ f, fr, t, over: null, pal: PAL.cliff });
        look.world('B', cliff.scene, r4.cam, PAL.cliff[0]);
        setPal(PAL.market); setFog(null);
        look.world('M', market.portalScene, r.cam, [0, 0, 0]);
        CU.uPortal.value = 1;
      }
      // 返修第 3 轮（v2-01）：墨从眼孔边往外洇（f341–f346）改用 T1 那套墨晕着色器——眼孔解析距离场驱动，花椰菜边、心浓边淡、前沿深一阶、纸路、墨粒，
      //   只洇在面具上（门户遮罩 b 通道）、不进眼孔；不再用平滑渐变（8 位量化出色带）
      if (r.ink > 0) {
        const u = r.ink;
        CU.uT1Out.value = 1;
        CU.uT1.value.set(1, 6 + 520 * Math.pow(u, 1.35), 0, 0);
        CU.uCapR.value.set(0, 1.2, lerp(0.97, 0.90, u), lerp(60, 240, u));       // 不留纸路（眼孔墨晕里纸路会读成等高线）
        CU.uT1X.value.set(0.24, 0, 0, 0.56);
      }
      // 四周残墨在穿过面具平面之前就已经在（f343 起），与 f347 之后的残墨同一套墨团、同一位置：穿孔那一刀前后墨不跳
      if (fr >= 343) CU.uRim.value.set(0.9 * ss(seg(fr, 343, 346.5)), 0, 0, 0);
    } else {
      pal = PAL.cliff; setPal(pal); setFog(FOG_S2);
      const r = cliff.S4({ f, fr, t, over, pal });
      look.worldSplit('A', cliff.scene, r.cam, U.uPal.value[0].toArray(), r.blurSig);
      paper = r.paper;
      CU.uRim.value.set(1 - ss(seg(fr, 347, 355)), 0, 0, 0);
    }
  } else if (f < 504) {                                // ── S4 豹变（一镜；近景真虚焦）
    const k = ss(seg(fr, 444, 490));
    pal = mixPal(PAL.cliff, PAL.s4, k); setPal(pal);
    setFog({ ...FOG_S2, density: lerp(0.010, 0.004, ss(seg(fr, 444, 470))) });
    const r = cliff.S4({ f, fr, t, over, pal });
    look.worldSplit('A', cliff.scene, r.cam, U.uPal.value[0].toArray(), r.blurSig);
    paper = r.paper; lp = mixLK(LK.S4, { ...LK.S4, warm: 0.04 }, k);
  } else if (f < 637) {                               // ── S5 一跃·逍遥（f565–f575 近云后两个世界按遮挡溶解：崖顶 → 长卷）
    pal = PAL.scroll; setPal(pal);
    setFog({ density: 0.006, start: 10, max: 0.95, base: -20, falloff: 14 });
    let r;
    if (fr < 565) { r = sky.S5peak({ f, fr, t }); look.world('A', r.scene, r.cam, U.uPal.value[0].toArray()); }
    else if (fr >= 575) { r = sky.S5scroll({ f, fr, t }); look.world('A', r.scene, r.cam, U.uPal.value[0].toArray()); }
    else {
      const ra = sky.S5peak({ f, fr, t }); look.world('A', ra.scene, ra.cam, U.uPal.value[0].toArray());
      r = sky.S5scroll({ f, fr, t }); look.world('B', r.scene, r.cam, U.uPal.value[0].toArray());
      sky.cloudMask(look.world, fr);
      CU.uMixM.value.set(1, seg(fr, 565, 575), 0, 0);
    }
    paper = r.paper;
    const bl = Math.exp(-(((fr - 570) / 7) ** 2));
    lp = { ...LK.S5, bleedR: lerp(3.5, 6.0, bl), bleedA: lerp(0.55, 0.70, bl) };
    // 尾迹墨点：返修第 3 轮（v2-04）改在世界里按深度画（sky.js placeDots），合成里不再叠
  } else if (f < 645) {                                // ── T2a 豹眼（代码眼：平涂琥珀 + 纸色高光；光带从左上扫向右下）
    pal = PAL.scroll; setPal(pal); setFog(null);
    const r = sky.T2a({ f, fr, t });
    look.world('A', r.scene, r.cam, U.uPal.value[0].toArray());
    lp = LK.T2;
    const ir = 75 * lerp(1, 1.03, ss(seg(fr, 637, 645)));
    const bright = ss(seg(fr, 639, 642));
    CU.uEye.value.set(1, ir, lerp(0.42, 0.34, ss(seg(fr, 641, 645))), bright);
    CU.uEyeP.value.set(650, 372, ir * 1.30, ir * 0.86);
    CU.uEye2.value.set(r.far[0], r.far[1], 0, 1);
    // 远眼：原画（A03）里是一只侧过去的窄眼（眼眶半长 58、半宽 25 图像素，长轴偏竖直 9°），代码眼照它的形状摆，免得横着的宽眼盖不住原画、上头露出一截琥珀
    CU.uEye2B.value.set(-0.15, 0.989, (ir * 1.30) / (58 * r.s), (ir * 0.86) / (25 * r.s));
    CU.uEye2C.value.set(-8, -30, 0, 0);
    CU.uIris.value.set(...COL.amber);
    setBand(fr, 0, null);
  } else {                                             // ── S6 回现实（过肩一镜；含 T2b 镜光 f645–f652；f655–f690 推近右手）
    pal = PAL.real; setPal(pal); setFog(null);
    const r = room.S6({ f, fr, t });
    look.world('A', room.scene, r.cam, U.uPal.value[0].toArray());
    paper = r.paper; lp = LK.S6;
    const xf = room.layerXf(r.cam);
    setBand(fr, 1, xf.shirt);
    setS6Light(fr, xf, room.tipS6(r.cam));
    drawGlassesS6(over, pal, fr, xf.shirt);
    hasSub = drawSubs(sub, fr, pal);
    if (fr >= 713) CU.uRev.value.set(1, 1.30 * ss(seg(fr, 713, 717)), 0, 0);   // 返修 w3（qa2-06）：退墨压到最后 0.3 s（f713–f717）
  }

  look.finish({ ...lp, over: true, sub: hasSub, seed: f, ...paperParams(paper) });
}

CAP98 = capsAt(98);
DQ98 = covTable(CAP98);

// 资产参考稿模式（只在 ?guide=1 时启用，成片不走这里）：t = 1 崖体、2 S2 松枝、3 崖顶石峰、4 崖顶松；按投影机位、16:9 渲平滑明暗的素描稿
const GUIDE = new URLSearchParams(location.search).get('guide');
function guideFrame(t) {
  const k = Math.round(t);
  if (k <= 2) { setPal(PAL.cliff); setFog(null); cliff.guide(renderer, k === 1 ? 'cliff' : 'pine2'); }
  else { setPal(PAL.scroll); setFog(null); sky.guide(renderer, k === 3 ? 'peak' : 'pine5'); }
}

window.DUR = 30;
window.render = GUIDE ? guideFrame : frame;
window.TEXTS = t => { const f = Math.round(t * 24); return f >= 672 && f < 719 ? ['君子豹变', '其文蔚也'] : []; };
if (!GUIDE) {
  for (const t of [0.5, 2.0, 3.6, 4.1, 4.6, 5.5, 8, 10.8, 11.6, 12.6, 13.2, 14.0, 14.5, 15.0, 16.5, 18.0, 19.5, 20.8, 21.8, 23.5, 23.6, 24.0, 25.0, 26.4, 26.7, 26.9, 27.6, 28.6, 29.3, 29.9]) frame(t);
  frame(0);
}
window.READY = true;
