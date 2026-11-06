// 《种子扫描》场面调度：一切时间来自 timeline.js；render(t) 确定性。
import { Holo, drawScanPlane, drawPad, makeCamera } from './engine/holo.js';
import * as U from './engine/hud.js';
import { T as HT, BEAT, DUR, FPS } from './timeline.js';
import { TREE, RINGS, LOCK_SHELL, ringR, ringLift } from './model.js';

const W = 1920, H = 1080, HUE = 168, ACC = 36;
const TH = U.theme(HUE, ACC);
TH.bg1 = `hsl(${HUE + 6},62%,10.5%)`;
const clamp = U.clamp, lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const ss = t => { t = clamp(t); return t * t * (3 - 2 * t); };
const eo = t => 1 - Math.pow(1 - clamp(t), 3);
const ei = t => Math.pow(clamp(t), 3);
const eio = t => { t = clamp(t); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const sine = t => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t));
const lg = (a, b, u) => Math.exp(lerp(Math.log(a), Math.log(b), u));
const hash = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
const F = n => n / FPS;   // 帧 → 秒
const CJK = 'NotoSC';
const fUI = (w, px) => `${w} ${px}px Rajdhani, ${CJK}`;
const fMono = px => `${px}px ShareTechMono, ${CJK}`;

// ---------- 时间函数 ----------
const S_MIN = 0.008;                     // 发芽前树的缩放（15 cm 的幼苗）
const treeScale = t => t < HT.land ? S_MIN : lg(S_MIN, 1, sine(seg(t, HT.land, 6.6)));
// 种子悬浮高度：读完（B4）后用两拍缓动落到投影台中心（B6 落地，速度不为零 → 落地那一帧接闷击）
const SEED_Y0 = 0.03, seedY0 = SEED_Y0 + 0.0012 * Math.sin(HT.sprout * 2.4);
const fallEase = u => { u = clamp(u); return u * u * (2 - u); };
const seedY = t => t < HT.sprout ? SEED_Y0 + 0.0012 * Math.sin(t * 2.4) : seedY0 * (1 - fallEase(seg(t, HT.sprout, HT.land)));
const frontRoots = t => lerp(0, 1.02, ss(seg(t, HT.land, HT.chip2)));
const frontTree = t => t < HT.land + F(3) ? -1 : lerp(0, 1.0, sine(seg(t, HT.land + F(3), HT.chip3)));
const planeY = t => { const f = frontTree(t); return f < 0 ? 0 : f * TREE.height * treeScale(t); };
const frontLeaves = t => lerp(0.38, 1.0, ss(seg(t, 5.0, HT.chip4)));
// 冻结（13.75–15.0）：投影台、点阵、滚动乱码都停住
const tFrozen = t => t < HT.freeze ? t : t < HT.open ? HT.freeze : t - (HT.open - HT.freeze);

// ---------- 摄影机 ----------
const mixCam = (A, B, w) => ({
  target: A.target.map((x, i) => lerp(x, B.target[i], w)),
  yaw: lerp(A.yaw, B.yaw, w), pitch: lerp(A.pitch, B.pitch, w), dist: lg(A.dist, B.dist, w),
  cx: lerp(A.cx, B.cx, w), cy: lerp(A.cy, B.cy, w), fov: 0.6,
});
const FALL_LAG = 0.4;   // 下落时镜头只跟一部分 → 种子在画面里明显往下落
const DIST_K = 1.15;    // 下落中轻拉远，之后一直保持
const camSeed = t => ({ target: [0, seedY(t) + 0.013, 0], yaw: 0.62 + 0.1 * seg(t, 0, HT.sprout), pitch: 0.13, dist: lg(0.088, 0.074, ss(seg(t, 0, HT.sprout))), cx: 960, cy: 560, fov: 0.6 });
function camGrow(t) {
  // 镜头跟着「已扫描出的部分」走：视场高 ≈ 1.35 × 可见高度（种子 → 幼苗 → 大树，连续对数拉远）
  const sc = treeScale(t), fT = Math.max(0, frontTree(t)), fR = frontRoots(t);
  const up = fT * TREE.height * sc, down = 0.55 * fR * TREE.rootDepth * sc;
  const hv = Math.hypot(0.034, up + down), dist = 2.18 * hv * DIST_K * lerp(1, 1.04, seg(t, 6.6, HT.whip));
  const u = seg(Math.log(dist), Math.log(0.074), Math.log(46));
  const lagY = FALL_LAG * seedY0 * (1 - ss(seg(t, HT.land, HT.land + 0.8)));
  return { target: [0, seedY(t) + 0.013 + lagY + (up - down) / 2 + 0.05 * up * (1 - seg(t, 6.0, 7.0)), 0], yaw: 0.72 + 0.62 * sine(seg(t, HT.sprout, HT.whip)), pitch: lerp(0.17, 0.30, ss(seg(t, HT.land, 7.4))), dist, cx: lerp(960, 1010, u), cy: lerp(560, 540, u), fov: 0.6 };
}
// 下落（B4–B6）：镜头轻拉远、微俯，目标只跟 60 % → 种子从画面中心落向下方的投影台
function camFall(t) {
  const u = seg(t, HT.sprout, HT.land), w = sine(u);
  const dist = lg(0.074, 0.074 * DIST_K, w), uu = seg(Math.log(dist), Math.log(0.074), Math.log(46));
  return { target: [0, lerp(seedY0 + 0.013, 0.013 + FALL_LAG * seedY0, w), 0], yaw: 0.72 + 0.62 * sine(seg(t, HT.sprout, HT.whip)), pitch: lerp(0.13, 0.17, w), dist, cx: lerp(960, 1010, uu), cy: lerp(560, 540, uu), fov: 0.6 };
}
const lockYaw = t => 1.95 + 0.6 * sine(seg(t, 8.5, HT.close)) + 0.05 * seg(t, HT.close, HT.open);
function camLock(t) {
  const d = t < HT.close ? lg(4.6, 3.7, ss(seg(t, 8.5, HT.close))) : lg(3.7, 3.45, seg(t, HT.close, HT.open));
  return { target: [0, lerp(1.42, 1.95, ss(seg(t, 9.6, 11.2))) - 0.3 * ss(seg(t, HT.close, HT.close + 1.0)), 0], yaw: lockYaw(t), pitch: lerp(0.5, 0.42, ss(seg(t, 8.5, HT.open))), dist: d, cx: W * 0.40, cy: H * 0.56, fov: 0.6 };
}
const camFinal = t => ({ target: [0, 7.8, 0], yaw: lockYaw(HT.open) + 0.3 + 0.07 * seg(t, HT.open, DUR), pitch: 0.07, dist: lg(42, 40.5, seg(t, 17.9, DUR)), cx: W * 0.44, cy: H * 0.52, fov: 0.6 });
const WHIP = [HT.whip, HT.whip + 1.0];
export function camAt(t) {
  if (t < HT.sprout) return camSeed(t);
  if (t < HT.land) return camFall(t);
  if (t < WHIP[0]) return camGrow(t);
  if (t < WHIP[1]) return mixCam(camGrow(t), camLock(t), eio(seg(t, WHIP[0], WHIP[1])));
  if (t < HT.open) return camLock(t);
  // 揭示：拉远先快后慢（对数距离 ease-out），目标高度随距离走，主体始终在画面中线附近
  const A = camLock(HT.open), Bf = camFinal(t), u = seg(t, HT.open, 17.9), w = eo(u);
  const dist = lg(A.dist, Bf.dist, w), k = (dist - A.dist) / (Bf.dist - A.dist);
  return { target: [0, lerp(A.target[1], Bf.target[1], k), 0], yaw: lerp(A.yaw, Bf.yaw, sine(u)), pitch: lerp(A.pitch, Bf.pitch, ss(u)), dist, cx: lerp(A.cx, Bf.cx, ss(u)), cy: lerp(A.cy, Bf.cy, ss(u)), fov: 0.6 };
}
const whipK = t => (t > WHIP[0] && t < WHIP[1]) ? Math.sin(Math.PI * seg(t, WHIP[0], WHIP[1])) : 0;

// ---------- 状态 ----------
function explodeAt(t) {
  const ex = {};
  const close = 1 - ei(seg(t, HT.close, HT.close + 0.3));
  RINGS.forEach((_, i) => { const t0 = HT.explode + F(3) * i; ex['ring' + i] = eo(seg(t, t0, t0 + BEAT)) * close; });
  { const t0 = HT.explode + F(3) * RINGS.length; ex.bark = eo(seg(t, t0, t0 + BEAT)) * close; }
  const kc = eo(seg(t, HT.explode, HT.explode + BEAT * 0.9)) * close;
  ex.crown = kc; ex.leaves = kc; ex.trunkUp = kc; ex.mains = kc; ex.subs = kc;
  ex.pith = ex.ring0;   // 髓心不动（爆炸向量为 0），只借这个系数发热
  return ex;
}

// ---------- 文字记录（readcheck 用） ----------
let REC = null;
const rec = (id, text, x0, y0, x1, y1) => { if (REC) REC.push({ id, text, x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) }); };

const CHIPS = [
  { label: '物种', value: '栎属', unit: '', t: HT.chip1 },
  { label: '根深', value: '4.2', unit: 'M', t: HT.chip2 },
  { label: '树高', value: '18.6', unit: 'M', t: HT.chip3 },
  { label: '冠幅', value: '14.0', unit: 'M', t: HT.chip4 },
  { label: '含水率', value: '42.6', unit: '%', t: HT.close + 0.35, from: HT.close },
];
const RAIL_X = 112, railY = i => 318 + i * 104;
const CARD = { x: 1250, y: 214, w: 470 }, AGE = { x: 1250, y: 560, w: 470 };

export function makeFilm(tree, seed) {
  const holo = new Holo(W, H), holoS = new Holo(W, H);
  // 结尾的新种子：在结尾机位下，选树冠右上轮廓上最外侧的枝端，让它不被枝叶淹没
  {
    const Cf = makeCamera(camFinal(DUR), W, H), p = new Float32Array(3); let bs = -1e9;
    for (const tp of tree.tips) { Cf.project(tp[0], tp[1], tp[2], p); const sc = (p[0] - W * 0.44) - 0.35 * p[1]; if (sc > bs) { bs = sc; tree.echo = tp; } }
  }
  const acc = mk(W, H), sub = mk(W, H);

  function scene(ctx, t) {
    const cam = camAt(t), tf = tFrozen(t), s = treeScale(t), C = makeCamera(cam, W, H);
    const frame = Math.round(t * FPS);
    // 背景：点阵随镜头视差
    U.background(ctx, W, H, TH, { px: -cam.yaw * 380, py: cam.pitch * 260, cx: cam.cx, cy: cam.cy });
    // 投影台（随树缩放）
    const padPulse = t >= HT.beam ? seg(t, HT.beam, HT.beam + 1.2) : (t >= HT.land && t < HT.land + 0.8 ? seg(t, HT.land, HT.land + 0.8) : 0);
    drawPad(ctx, cam, W, H, { hue: HUE, R: 6.7 * s, rot: tf * 0.12, alpha: t < 0.3 ? 0.4 + 2 * t : 1, pulse: padPulse < 1 ? padPulse : 0 });
    // 光束（高潮后，只此一次）
    const beamA = seg(t, HT.beam, HT.beam + 0.6);
    if (beamA > 0) U.beam(ctx, TH, C.project, beamA * 0.9, t, { r0: 7.0, r1: 6.3, y1: 19.6 });
    // 树
    const ex = explodeAt(t);
    const focusK = t < HT.lock ? 0 : t < HT.open ? ss(seg(t, HT.lock, HT.lock + 0.4)) : 1 - ss(seg(t, HT.open, HT.open + 0.8));
    const solid = t < HT.open ? 0 : lerp(0, 0.85, eo(seg(t, HT.open, HT.open + 0.5))) * lerp(1, 0.82, seg(t, 16, 18));
    const wave = t >= HT.open && t < HT.crown + 0.3 ? { y: lerp(-0.5, TREE.height + 0.6, seg(t, HT.open, HT.crown)), w: 0.9 } : null;
    const leavesHot = (t >= HT.chip4 && t < HT.chip4 + F(3)) || (t >= HT.crown && t < HT.crown + F(3));
    const sliceFlash = (t >= HT.lock && t < HT.lock + F(3)) ? 1 : 0;
    const fogR = cam.dist * 0.5 + 0.02;
    const tgtK = (ex['ring' + LOCK_SHELL] || 0) >= 0.98 ? 1 : 0, tgtHot = tgtK && t < HT.close ? 1 : 0;
    const tgtDim = {}; if (tgtHot) RINGS.forEach((_, i) => { if (i !== LOCK_SHELL) tgtDim['ring' + i] = 0.7; });
    const grow = { roots: frontRoots(t), trunk: frontTree(t), slice: frontTree(t), crown: frontTree(t), leaves: Math.min(frontTree(t), frontLeaves(t)) };
    const info = holo.draw(ctx, tree, cam, {
      hue: HUE, scale: s, grow, growBand: 0.035, explode: ex, solid, wave,
      // 截面是 9 层同心壳叠在一起：实体面只给 15 %、光波不加面亮度、只有最外一圈树皮在波前 0.2 m 内发近白 → 不会糊成白色实心饼
      solidPart: { slice: 0.15 }, waveFillPart: { slice: 0 }, waveBandPart: { slice: 0, bark: 0.22 },
      focus: focusK > 0 ? 'slice' : null, dim: lerp(1, 0.28, focusK),
      gainPart: { roots: 0.62, slice: t < HT.whip ? 0.55 : t < HT.open ? lerp(0.55, 1, seg(t, HT.whip, HT.box)) : lerp(0.72, 0.62, ss(seg(t, HT.open, HT.open + 0.25))) },
      // 爆炸期间：目标年轮 R-087 热边、其余年轮层压到 70 % → 一眼读出「被拆开的是哪一层」
      hotPiece: { ['ring' + LOCK_SHELL]: tgtHot }, gainPiece: tgtDim,
      hotPart: { leaves: leavesHot ? 1 : 0 }, flash: { slice: sliceFlash },
      fog: [cam.dist - fogR, cam.dist + fogR], scanOffset: frame,
      lineWidth: 1.3 * (t >= HT.open ? lerp(1.5, 1.12, ss(seg(t, HT.open, HT.open + 1.2))) : 1),
      glow: t >= HT.open ? lerp(1.5, 1, seg(t, HT.open, HT.open + 1)) : 1,
    });
    // 爆炸装配轴（CAD 爆炸图语法）：髓心向上的虚线轴 + 每层一个刻度 → 读成「沿树干轴向分层抬起」
    const exK = ex.ring0 || 0;
    if (exK > 0.02 && t < HT.close + 0.3) {
      const p0 = new Float32Array(3), p1 = new Float32Array(3), y0 = TREE.sliceY1 - 0.1, y1 = TREE.sliceY1 + ringLift(0) * exK + 0.35;
      C.project(0, y0, 0, p0); C.project(0, y1, 0, p1);
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]); ctx.lineDashOffset = -frame * 1.5; ctx.strokeStyle = TH.line(0.55 * exK);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke(); ctx.setLineDash([]);
      RINGS.forEach((_, i) => {
        const k = ex['ring' + i] || 0; if (k < 0.05) return;
        C.project(0, TREE.sliceY1 + ringLift(i) * k, 0, p0);
        const L = i === LOCK_SHELL && tgtHot ? 16 : 8;
        ctx.strokeStyle = i === LOCK_SHELL && tgtHot ? TH.hi(0.9) : TH.line(0.7 * k);
        ctx.beginPath(); ctx.moveTo(p0[0] - L, p0[1]); ctx.lineTo(p0[0] + L, p0[1]); ctx.stroke();
      });
      ctx.restore();
    }
    // 扫描平面（生长段）
    const fT = frontTree(t);
    if (t >= HT.land && t < HT.chip3 + 0.5 && fT >= 0) {
      const y = fT * TREE.height * s, a = 1 - seg(t, HT.chip3, HT.chip3 + 0.5);
      drawScanPlane(ctx, cam, W, H, y, { hue: HUE, r: 6.2 * s * (0.35 + 0.65 * Math.sin(Math.min(1, fT * 1.6) * Math.PI / 2)), rot: tf * 0.4, alpha: a });
    }
    // 种子：点云 → 扫描线读出 → 实心线框缓动落到投影台中心 → 上行扫描平面把它擦除、转成根与树干
    const sy = seedY(t);
    const fS = t < HT.scan ? 0 : t < HT.sprout ? seg(t, HT.scan, HT.sprout) : 2;
    const SEED_H = 0.026, erase = t < HT.land ? Infinity : 1 - planeY(t) / SEED_H;   // 生长键 g =（顶 − y）/ 高：只留扫描平面以上的部分
    if (erase > 0) {
      const ignite = seg(t, 0, 0.35);
      holoS.draw(ctx, seed, cam, {
        hue: HUE, offset: [0, sy, 0], grow: { seed: t < HT.scan ? -1 : t < HT.sprout ? fS * 1.0001 : erase }, growBand: 0.07,
        points: { seed: t < HT.sprout ? lerp(0.15, 0.75, seg(t, 0.15, 1.1)) * ignite : 0.75 * (1 - seg(t, HT.sprout, HT.sprout + BEAT)) },
        fog: [cam.dist - Math.max(0.02, fogR), cam.dist + Math.max(0.02, fogR)],
        hotPart: { seed: (t >= HT.sprout && t < HT.sprout + F(3)) || (t >= HT.land && t < HT.land + F(1)) ? 1 : 0 },
      });
    }
    // 开场热点：B0 亮起
    if (t < 0.9) {
      const p = new Float32Array(3); C.project(0, sy + 0.011, 0, p);
      const k = seg(t, 0, 0.5), a = 1 - seg(t, 0.35, 0.9);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], 90 * (0.4 + k));
      g.addColorStop(0, TH.hi(0.95 * a)); g.addColorStop(0.15, TH.line(0.5 * a)); g.addColorStop(1, TH.line(0));
      ctx.fillStyle = g; ctx.fillRect(p[0] - 200, p[1] - 200, 400, 400);
      ctx.strokeStyle = TH.hi(0.8 * a); ctx.lineWidth = 1.5;
      const L = 30 + 60 * eo(k);
      ctx.beginPath(); ctx.moveTo(p[0] - L, p[1]); ctx.lineTo(p[0] + L, p[1]); ctx.moveTo(p[0], p[1] - L); ctx.lineTo(p[0], p[1] + L); ctx.stroke();
      ctx.restore();
    }
    // 种子扫描环（1.25–2.5）
    if (t >= HT.scan && t < HT.sprout) {
      const y = sy + 0.026 * (1 - fS);
      drawScanPlane(ctx, cam, W, H, y, { hue: HUE, r: 0.0125, rot: t * 1.2, alpha: 0.9 });
    }
    // 树冠闪烁 + 新种子（结尾）
    if (t >= HT.crown) {
      const k = 1 - seg(t, HT.crown, HT.crown + 1.2), p = new Float32Array(3);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      tree.tips.forEach((tp, i) => {
        if (hash(i * 7.3) > 0.45) return;
        const tw = Math.max(0, Math.sin((t - HT.crown) * 9 + i * 2.1)) * k;
        if (tw <= 0.02) return;
        C.project(tp[0], tp[1], tp[2], p); ctx.fillStyle = TH.hi(tw); ctx.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
      });
      ctx.restore();
    }
    if (t >= HT.echo) {
      const e = tree.echo, p = new Float32Array(3); C.project(e[0], e[1] - 0.05, e[2], p);
      const k = seg(t, HT.echo, HT.echo + 0.6);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], 80);
      g.addColorStop(0, TH.hi(1)); g.addColorStop(0.12, TH.hi(0.7)); g.addColorStop(0.3, TH.line(0.35)); g.addColorStop(1, TH.line(0));
      ctx.fillStyle = g; ctx.fillRect(p[0] - 90, p[1] - 90, 180, 180);
      ctx.fillStyle = TH.hi(1); ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1.8;
      for (const d of [0, 0.25]) { const kk = clamp(k - d); if (kk <= 0 || kk >= 1) continue; ctx.strokeStyle = TH.hi(0.9 * (1 - kk)); ctx.beginPath(); ctx.arc(p[0], p[1], 10 + 70 * eo(kk), 0, Math.PI * 2); ctx.stroke(); }
      ctx.strokeStyle = TH.hi(0.85); ctx.lineWidth = 1.5; const r = lerp(40, 22, eo(seg(t, HT.echo, HT.echo + 0.2)));
      U.corners(ctx, p[0] - r, p[1] - r, p[0] + r, p[1] + r, 6);
      ctx.restore();
    }
    return { info, cam, C, ex };
  }

  function hud(ctx, t, st) {
    const tf = tFrozen(t), frame = Math.round(tf * FPS), { info, cam, C, ex } = st;
    const hudA = seg(t, HT.hud - F(2), HT.hud + F(3));
    if (hudA > 0) {
      // 角括号卡入：从放大 4% 收到原位
      const k = eo(seg(t, HT.hud - F(2), HT.hud + F(4)));
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(lerp(1.04, 1, k), lerp(1.04, 1, k)); ctx.translate(-W / 2, -H / 2);
      U.chrome(ctx, W, H, TH, { alpha: hudA, px: -cam.yaw * 520 });
      ctx.restore();
      titleBlock(ctx, t, frame, hudA);
      statusLine(ctx, t, frame, hudA);
      telemetry(ctx, t, cam, hudA);
    }
    // 数据片栏
    CHIPS.forEach((c, i) => chipAt(ctx, c, i, t, frame));
    // 目标框
    if (t >= HT.box && t < HT.ageRoll + 0.65) {
      const bb = info.bbox.slice;
      const k = seg(t, HT.box, HT.box + 0.3), lockK = eo(seg(t, HT.lock - 0.2, HT.lock));
      const a = 1 - seg(t, HT.ageRoll + 0.35, HT.ageRoll + 0.65);
      const flash = t >= HT.lock && t < HT.lock + F(3);
      if (bb) {
        U.targetBox(ctx, TH, bb, k, { lockK, flash, tag: '锁定', alpha: a, pad: 22 });
        if (lockK > 0.8 && a > 0.6) rec('tag', '锁定', bb[0] - 22, bb[1] - 22 - 34, bb[0] + 60, bb[1] - 22);
      }
    }
    // 引线 + 含水率卡
    const cardA = t < HT.close ? 1 : 1 - seg(t, HT.close, HT.close + 0.35);
    if (t >= HT.lock && cardA > 0) {
      const anc = ringAnchor(C, cam, ex, t);
      const to = [CARD.x - 24, CARD.y + 34];
      const elbow = [Math.min(anc[0] + Math.abs(to[1] - anc[1]) * 0.7, to[0] - 60), to[1]];
      const prog = eo(seg(t, HT.lock, HT.leader));
      const pulse = t >= HT.moist && t < HT.moist + 0.5 ? seg(t, HT.moist, HT.moist + 0.5) : 0;
      U.leader(ctx, TH, [anc[0], anc[1]], elbow, to, prog, { alpha: cardA, pulse });
      const reveal = seg(t, HT.leader, HT.leader + 0.4);
      const roll = seg(t, HT.explode, HT.moist);
      U.specCard(ctx, TH, CARD.x, CARD.y, { label: '含水率', value: '42.6', unit: '%', detail: '年轮 R-087' },
        { reveal, roll, detail: seg(t, HT.leader + 0.2, HT.leader + 0.6), frame, flash: t >= HT.moist && t < HT.moist + F(1) }, { w: CARD.w, alpha: cardA, index: '01', big: 120 });
      if (reveal >= 1 && cardA >= 1) {
        rec('cardLabel', '含水率', CARD.x, CARD.y, CARD.x + CARD.w, CARD.y + 44);
        rec('cardDetail', '年轮 R-087', CARD.x, CARD.y + 160, CARD.x + CARD.w, CARD.y + 210);
      }
      if (roll >= 1 && cardA > 0.5) rec('moist', '42.6 %', CARD.x, CARD.y + 48, CARD.x + CARD.w, CARD.y + 150);
    }
    // 树龄大数
    if (t >= HT.ageRoll) ageCard(ctx, t, frame);
  }

  function ringAnchor(C, cam, ex, t) {
    const a = cam.yaw + 0.55, r = ringR(RINGS[LOCK_SHELL]);
    const y = TREE.sliceY1 + ringLift(LOCK_SHELL) * (ex['ring' + LOCK_SHELL] || 0);
    const p = new Float32Array(3); C.project(Math.sin(a) * r, y, Math.cos(a) * r, p);
    return [p[0], p[1]];
  }

  function titleBlock(ctx, t, frame, a) {
    const x = 92, y = 92, k = seg(t, HT.hud, HT.hud + 0.4);
    U.plate(ctx, TH, x - 18, y - 18, 400, 74, a);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = fUI(500, 30); ctx.letterSpacing = '4px'; ctx.fillStyle = TH.hi(0.95 * a);
    const s1 = '种子扫描';
    ctx.fillText(k >= 1 ? s1 : U.rollText(s1, k * 1.2, frame, 5), x, y + 26);
    const w1 = ctx.measureText(s1).width;
    ctx.font = fMono(20); ctx.letterSpacing = '1px'; ctx.fillStyle = TH.line(0.8 * a);
    ctx.fillText(k >= 1 ? '// 样本 07' : U.rollText('// 样本 07', k * 1.3, frame, 9), x + w1 + 14, y + 25);
    ctx.font = fMono(16); ctx.fillStyle = TH.dim(0.8 * a);
    ctx.fillText('QUERCUS · HOLO-SCAN 3.2', x, y + 48);
    ctx.restore();
    if (k >= 1) rec('title', '种子扫描 // 样本 07', x, y, x + 380, y + 30);
  }

  function statusLine(ctx, t, frame, a) {
    let lab, val = '';
    if (t < HT.whip) {
      lab = '扫描中';
      if (t < HT.sprout) val = String(Math.round(100 * seg(t, HT.scan, HT.sprout))).padStart(3, '0') + '%';
      else val = 'H ' + (frontTree(t) < 0 ? 0 : frontTree(t) * TREE.height).toFixed(1) + ' M';
    } else if (t < HT.explode) { lab = '目标锁定'; val = t >= HT.lock ? '1/1' : '—/1'; }
    else if (t < HT.open) { lab = '解算中'; val = U.rollText('0000', 0.1, frame, 4); }
    else { lab = '完成'; val = '120 年'; }
    const x1 = W - 92;
    ctx.save(); ctx.textBaseline = 'alphabetic';
    ctx.font = fMono(20); const vw = ctx.measureText(val).width;
    ctx.font = fUI(600, 24); ctx.letterSpacing = '3px'; const lw = ctx.measureText(lab).width;
    const wTot = lw + vw + 46;
    U.plate(ctx, TH, x1 - wTot - 4, 74, wTot + 22, 50, a);
    ctx.globalCompositeOperation = 'lighter'; ctx.textAlign = 'left';
    const live = t >= HT.open ? TH.acc(0.95 * a) : TH.hi(0.92 * a);
    ctx.fillStyle = TH.line(0.9 * a); ctx.beginPath(); ctx.arc(x1 - wTot + 12, 99, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = TH.hi(0.92 * a); ctx.fillText(lab, x1 - wTot + 26, 108);
    ctx.font = fMono(20); ctx.letterSpacing = '1px'; ctx.fillStyle = live; ctx.fillText(val, x1 - vw, 107);
    ctx.restore();
    rec('status', lab, x1 - wTot, 80, x1 - vw - 8, 118);
  }

  function telemetry(ctx, t, cam, a) {
    const s = treeScale(t), fieldH = 2 * cam.dist * Math.tan(0.3);
    const e = makeCamera(cam, W, H).eye;
    const tx = `X ${e[0].toFixed(3)}  Y ${e[1].toFixed(3)}  Z ${e[2].toFixed(3)}   FOV 34°`;
    const fh = fieldH < 1 ? (fieldH * 100).toFixed(1) + ' CM' : fieldH.toFixed(1) + ' M';
    const zoom = '×' + (fieldH / 0.0457).toFixed(fieldH < 0.5 ? 2 : 0);
    ctx.save(); ctx.textBaseline = 'alphabetic';
    U.plate(ctx, TH, 74, H - 128, 560, 46, a * 0.9);
    U.plate(ctx, TH, W - 74 - 470, H - 128, 470, 46, a * 0.9);
    ctx.globalCompositeOperation = 'lighter';
    ctx.font = fMono(18); ctx.fillStyle = TH.dim(0.95 * a); ctx.textAlign = 'left';
    ctx.fillText(tx, 92, H - 98);
    ctx.textAlign = 'right'; ctx.fillStyle = TH.line(0.9 * a);
    ctx.fillText(`视场 ${fh}   ${zoom}`, W - 92, H - 98);
    // 尺度标尺（视场高 → 竖直刻度）
    const rx = W - 92 - 380, ry = H - 112;
    ctx.strokeStyle = TH.dim(0.6 * a); ctx.lineWidth = 1; ctx.beginPath();
    const ph = (Math.log10(fieldH) % 1 + 1) % 1;
    for (let i = 0; i < 12; i++) { const x = rx - 20 - i * 14 - ph * 14; if (x < rx - 190) continue; ctx.moveTo(x, ry + 6); ctx.lineTo(x, ry + (i % 5 ? 12 : 18)); }
    ctx.stroke();
    ctx.restore();
    void s;
  }

  function chipAt(ctx, c, i, t, frame) {
    const t0 = (c.from ?? c.t - 0.3);
    if (t < t0) return;
    const k = seg(t, t0, c.t);
    const locked = t >= c.t || c.from != null;
    const x = lerp(RAIL_X + 34, RAIL_X, eo(k)), y = railY(i), a = clamp(k * 1.6);
    const flash = t >= c.t && t < c.t + F(1);
    const val = locked ? c.value : U.rollText(c.value, k * 1.1, frame, 31 + i);
    chipDraw(ctx, x, y, { label: c.label, value: val, unit: c.unit }, a, { index: String(i + 1).padStart(2, '0'), locked, flash });
    if (c.from != null) { rec('moist', '42.6 %', RAIL_X + 200, y, RAIL_X + 376, y + 50); rec('chip' + i, c.label, RAIL_X + 40, y, RAIL_X + 180, y + 50); }
    else if (locked) rec('chip' + i, `${c.label} ${c.value} ${c.unit}`.trim(), RAIL_X - 16, y - 16, RAIL_X + 376, y + 56);
  }

  function chipDraw(ctx, x, y, c, a, o) {
    const w = 360;
    U.plate(ctx, TH, x - 16, y - 16, w + 32, 72, a);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = TH.line(0.5 * a); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke();
    ctx.fillStyle = TH.line(0.9 * a); ctx.fillRect(x, y - 2, 14, 4);
    ctx.textAlign = 'left'; ctx.font = fMono(18); ctx.fillStyle = TH.dim(0.9 * a); ctx.fillText(o.index, x, y + 34);
    ctx.font = fUI(500, 24); ctx.letterSpacing = '3px'; ctx.fillStyle = TH.line(0.95 * a); ctx.fillText(c.label, x + 40, y + 34);
    ctx.letterSpacing = '0px';
    const col = o.flash ? TH.hi(a) : o.locked ? TH.acc(0.98 * a) : TH.line(0.75 * a);
    ctx.textAlign = 'right'; ctx.font = fUI(500, 18); const uw = c.unit ? ctx.measureText(c.unit).width + 8 : 0;
    ctx.fillStyle = col; if (c.unit) ctx.fillText(c.unit, x + w, y + 36);
    ctx.font = fUI(400, 40); ctx.textAlign = 'left';
    const isCJK = /[一-鿿]/.test(c.value);
    if (isCJK) { ctx.font = fUI(500, 30); ctx.letterSpacing = '4px'; }
    const vw = ctx.measureText(c.value).width;
    ctx.fillStyle = col;
    if (isCJK) ctx.fillText(c.value, x + w - uw - vw, y + 36);
    else { const adv = ctx.measureText('0').width; U.monoText(ctx, c.value, x + w - uw - monoW(c.value, adv, ctx), y + 38, adv); }
    ctx.restore();
  }
  const monoW = (s, adv, ctx) => { let w = 0; for (const ch of s) w += (ch === '.' || ch === ' ') ? ctx.measureText(ch).width * 1.1 : adv; return w; };

  function ageCard(ctx, t, frame) {
    const x = AGE.x, y = AGE.y, w = AGE.w, rv = eo(seg(t, HT.ageRoll, HT.ageRoll + 0.4));
    const frozen = t >= HT.freeze && t < HT.open, locked = t >= HT.open;
    const flash = t >= HT.open && t < HT.open + F(1);
    U.plate(ctx, TH, x - 22, y - 20, (w + 44) * rv, 300, clamp(rv * 2));
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.strokeStyle = TH.line(0.9); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w * rv, y); ctx.stroke();
    ctx.fillStyle = TH.line(0.9); ctx.fillRect(x, y - 3, 34 * rv, 6);
    ctx.font = fMono(20); ctx.fillStyle = TH.dim(0.95 * rv); ctx.fillText('02', x, y + 36);
    ctx.font = fUI(500, 30); ctx.letterSpacing = '6px'; ctx.fillStyle = TH.hi(0.95 * clamp(rv * 2 - 0.6)); ctx.fillText('树龄', x + 52, y + 38);
    ctx.letterSpacing = '0px';
    // 大数：滚动乱码 → 冻结变暗 → 定格琥珀
    ctx.font = fUI(300, 196);
    const adv = ctx.measureText('0').width * 1.02;
    const v = locked ? '120' : U.rollText('120', frozen ? 0.1 : 0.1, frozen ? Math.round(HT.freeze * FPS) : frame, 17);
    const dimK = frozen ? 0.42 : 0.85;
    ctx.fillStyle = flash ? TH.hi(1) : locked ? TH.acc(1) : TH.line(dimK * rv);
    const vy = y + 48 + 196 * 0.8;
    const vw = U.monoText(ctx, v, x - 6, vy, adv);
    ctx.font = fUI(500, 58); ctx.fillStyle = locked ? TH.acc(0.95) : TH.line(0.5 * rv);
    ctx.fillText('年', x + vw + 14, vy);
    // 进度条：滚动时填充，冻结时停在 92%，定格时补满
    const pr = locked ? 1 : 0.92 * seg(tFrozen(t), HT.ageRoll, HT.freeze);
    ctx.fillStyle = TH.dim(0.35); ctx.fillRect(x, vy + 18, w, 2);
    ctx.fillStyle = locked ? TH.acc(0.95) : TH.line(0.9); ctx.fillRect(x, vy + 18, w * pr, 2);
    if (locked) {
      const dk = seg(t, HT.open + 0.25, HT.open + 0.7);
      ctx.font = fUI(500, 24); ctx.letterSpacing = '3px'; ctx.fillStyle = TH.line(0.85 * clamp(dk * 2));
      const d = '胸高截面 · 年轮计数';
      ctx.fillText(dk >= 1 ? d : U.rollText(d, dk * 1.3, frame, 23), x, vy + 56);
      if (dk >= 1) rec('ageDetail', d, x, vy + 30, x + w, vy + 64);
      rec('age', '120 年', x, y + 48, x + w, vy + 10);
    }
    ctx.restore();
    if (rv >= 1) rec('ageLabel', '树龄', x + 52, y + 10, x + 160, y + 44);
  }

  function render(ctx, t) {
    const wk = whipK(t);
    let st;
    if (wk > 0.05) {
      // 甩镜内的真实运动模糊：5 个子帧、180° 快门（1/48 s）；HUD 只画一次，保持清晰
      const N = 5, sh = 1 / 48, a = acc.getContext('2d'), sg = sub.getContext('2d');
      a.globalAlpha = 1; a.globalCompositeOperation = 'source-over';
      for (let k = 0; k < N; k++) {
        const tk = t + (k / (N - 1) - 0.5) * sh;
        sg.setTransform(1, 0, 0, 1, 0, 0); sg.globalCompositeOperation = 'source-over'; sg.globalAlpha = 1;
        const s2 = scene(sg, tk); if (k === (N - 1) / 2) st = s2;
        a.globalAlpha = 1 / (k + 1); a.drawImage(sub, 0, 0);
      }
      ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(acc, 0, 0); ctx.restore();
    } else st = scene(ctx, t);
    U.vignette(ctx, W, H, 0.55);
    hud(ctx, t, st);
    // 全片唯一一次故障：120 年定格的 3 帧
    if (t >= HT.open && t < HT.open + F(3)) U.glitch(ctx, W, H, 1 - (t - HT.open) / F(3) * 0.5, Math.round(t * FPS));
  }

  function texts(ctx, t) { REC = []; render(ctx, t); const r = REC; REC = null; return r; }

  // ---------- 声音 / 拍点事件 ----------
  function events() {
    const E = [], ev = (t, type, o = {}) => E.push({ t: +t.toFixed(6), type, ...o });
    ev(HT.ignite, 'ignite', { key: 'ignite' });
    ev(0.12, 'dots', { t1: HT.scan });
    ev(HT.hud, 'hud', { key: 'hud' });
    ev(HT.scan, 'scanline', { key: 'scan', t1: HT.sprout });
    ev(HT.sprout, 'sprout', { key: 'sprout' });
    ev(HT.sprout, 'fall', { t1: HT.land });
    ev(HT.land, 'land', { key: 'land' });
    ev(HT.land, 'roots', { t1: HT.chip2 });
    ev(HT.land + F(3), 'plane', { t1: HT.chip3 });
    CHIPS.slice(0, 4).forEach((c, i) => { ev(c.t - 0.3, 'chipIn', { i }); ev(c.t, 'chip', { key: 'chip' + (i + 1), i }); });
    ev(HT.chip4, 'leaves');
    // 生长调内碎响：扫描前沿每过一段就响一声（落在十六分网格上）
    for (let b = 6 * 4 + 1; b < 11 * 4; b++) { const tb = b * BEAT / 4; if (tb > HT.land && tb < HT.chip4) ev(tb, 'grow', { n: b }); }
    ev(HT.whip, 'whip', { key: 'whip', d: WHIP[1] - WHIP[0] });
    ev(HT.box, 'box', { key: 'box' });
    ev(HT.lock, 'lock', { key: 'lock' });
    ev(HT.lock, 'leaderRun', { d: HT.leader - HT.lock });
    ev(HT.leader, 'card', { key: 'leader' });
    ev(HT.explode, 'explode', { key: 'explode' });
    RINGS.forEach((_, i) => ev(HT.explode + F(3) * i, 'layer', { i }));
    ev(HT.explode + F(3) * RINGS.length, 'layer', { i: RINGS.length });
    ev(HT.explode, 'roll', { t1: HT.moist, kind: 'moist' });
    ev(HT.ageRoll, 'roll', { t1: HT.freeze, kind: 'age', key: 'ageRoll' });
    ev(HT.ageRoll + 0.35, 'boxOut');
    ev(HT.moist, 'moist', { key: 'moist' });
    ev(HT.close, 'close', { key: 'close' });
    ev(HT.close + 0.35, 'chip', { i: 4 });
    ev(HT.freeze, 'freeze', { key: 'freeze' });
    ev(HT.open, 'open', { key: 'open' });
    ev(HT.open, 'glitch', { d: F(3) });
    ev(HT.open, 'wave', { t1: HT.crown });
    ev(HT.beam, 'beam', { key: 'beam' });
    ev(HT.crown, 'crown', { key: 'crown' });
    ev(HT.echo, 'echo', { key: 'echo' });
    return E.sort((a, b) => a.t - b.t);
  }
  return { render, texts, events };
}
function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
