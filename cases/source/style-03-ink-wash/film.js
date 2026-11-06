// 《鹤出留白》画面：render(t) 只依赖 t（无随机、无帧间状态）。时间全部来自 timeline.js。
import { mk, draw, blot, mass, TONE } from './engine/ink.js';
import { ridgeFn, mountainLayer, cun, vn2, ripple } from './engine/land.js';
import { crane, silhouette, feather, POSE, mix, withWing, VERM } from './engine/crane.js';
import { write, sealLines } from './engine/glyph.js';
import { graphStroke, drawGraphStroke } from './engine/sidebrush.js';
import { FPS, bf, bt, F, T, HIT, WINGBEATS, INSCR, STROKE_IN, BEATF, DUR } from './timeline.js';
import { clamp, lerp, ss, eio, eo, ei, mulberry, spring } from '/core/lib.js';

const cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function wlayer(x0, y0, w, h) {
  const wet = cv(w, h), dry = cv(w, h);
  const L = { x0, y0, w, h, wet, dry, ink: { wet: wet.getContext('2d'), dry: dry.getContext('2d') } };
  for (const c of [L.ink.wet, L.ink.dry]) c.setTransform(1, 0, 0, 1, -x0, -y0);
  return L;
}
const xfOf = cam => ({ s: cam.z, tx: 960 - cam.x * cam.z, ty: 540 - cam.y * cam.z });
function blit(A, L, cam, am = 1, which = ['wet', 'dry']) {
  const { s, tx, ty } = xfOf(cam);
  for (const k of which) { const c = A.ink[k]; c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = am; c.drawImage(L[k], L.x0 * s + tx, L.y0 * s + ty, L.w * s, L.h * s); c.restore(); }
}
const fr = t => Math.round(t * FPS);           // 时间 → 帧号
const segF = (f, a, b) => clamp((f - a) / (b - a));

// ───────────── 世界：昼 ─────────────
const PEAKS = [[3760, 400, 300], [3420, 300, 240], [4300, 250, 330], [2980, 190, 300], [4620, 160, 220]];
const ridge1 = ridgeFn(PEAKS, 800, 5, 30);                    // 第一笔：山脊
const ridgeFar = ridgeFn([[4600, 220, 260], [4050, 270, 230], [3400, 300, 240], [2800, 230, 250]], 700, 9, 34);
const FALLX = 3330;
const CRANE0 = [2150, 560];                                   // 生鹤处（鹤身中心）
const BIRTH_S = 1.35;
let LAY = null;

function build() {
  LAY = {};
  // 远山（清墨，无皴）
  LAY.far = wlayer(2300, 0, 2700, 1080);
  LAY.far.ink.wet.drawImage(mountainLayer({ W: 2700, H: 1080, x0: 2300, ridge: ridgeFar, depth: 220, tone: .15, rim: .5, rimW: 22, mist: .9, seed: 9, xmask: x => clamp((x - 2450) / 300) * clamp((4950 - x) / 300) }), 2300, 0);
  for (const c of [LAY.far.ink.wet]) { c.save(); c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.moveTo(2300, 1100); for (let x = 2300; x <= 5000; x += 10) c.lineTo(x, ridge1(x) - 6); c.lineTo(5000, 1100); c.closePath(); c.filter = 'blur(10px)'; c.fill(); c.restore(); }
  LAY.farClip = c => { c.beginPath(); c.moveTo(2300, 1100); for (let x = 2300; x <= 5000; x += 10) c.lineTo(x, ridge1(x) - 30); c.lineTo(5000, 1100); c.closePath(); };
  // 近山山体（淡墨 + 披麻皴），山脊那一笔另画
  LAY.near = wlayer(2300, 0, 2700, 1080);
  LAY.near.ink.wet.drawImage(mountainLayer({ W: 2700, H: 1080, x0: 2300, ridge: x => ridge1(x) + 6, depth: 420, tone: .55, rim: .2, rimW: 22, mist: .55, seed: 5, xmask: x => clamp((x - 2560) / 200) * clamp((4760 - x) / 180) }), 2300, 0);
  cun(LAY.near.ink, { x0: 2700, x1: 4600, ridge: ridge1, tone: .34, cun: 2.0, moss: 0, seed: 5, cunLen: 1.5, cunDepth: 2.2, cunW: 1.2 });
  // 第一笔（山脊）：一笔浓墨，侧锋，墨重的一侧朝上
  const pts = [];
  for (let x = 4700; x >= 2560; x -= 40) { const u = (4700 - x) / 2140, h = clamp((800 - ridge1(x)) / 400); pts.push([x, ridge1(x) + 4, (.35 + .85 * Math.pow(h, 1.3)) * (u > .92 ? 1 - (u - .92) * 9 : 1) * (u < .03 ? .5 + u * 16 : 1)]); }
  // 旧版（平行条纹，弃用）：LAY.ridgeS = mk(pts, { w: 84, tone: .92, darkDir: [0, -1], side: .9, dry: .34, wet: .45, brWet: true, body: 1, prof: 'even', rough: .25, nb: 60, seed: 11, per: 3 });
  LAY.ridgeG = graphStroke(smoothCurve(ridge1, 2400, 4900, 40, 4), 4700, 2560, { w: x => 80 * (.3 + .95 * Math.pow(clamp((800 - ridge1(x)) / 400), 1.8)), ymin: 280, ymax: 900, seed: 11 });
  // 第二笔：远山清墨轮廓
  const fp = []; for (let x = 4750; x >= 2650; x -= 70) fp.push([x, ridgeFar(x) + 3, .9]);
  LAY.farS = mk(fp, { w: 26, tone: .3, darkDir: [0, -1], side: .7, dry: .5, wet: .8, brWet: true, body: .5, prof: 'tip', seed: 23, per: 4 });
  // 飞白瀑布：一笔干笔下拖 + 一笔细
  const y0 = ridge1(FALLX) + 14;
  LAY.fallS = [mk([[FALLX, y0, 1], [FALLX + 6, y0 + 160, 1], [FALLX + 2, y0 + 330, .9], [FALLX + 12, 960, .5]], { w: 46, tone: .8, dry: .8, wet: .1, prof: 'even', rough: .2, nb: 40, seed: 31 }),
    mk([[FALLX - 40, y0 + 30, .9], [FALLX - 34, y0 + 200, 1], [FALLX - 38, 900, .4]], { w: 16, tone: .7, dry: .72, wet: .1, prof: 'tip', nb: 18, seed: 32 })];
  // 苔点
  LAY.moss = [[3920, 1], [3180, 2], [4380, 3]].map(([x, i]) => ({ x, y: ridge1(x) - 2, i }));
  // —— 飞越段的视差层 ——
  const rFar2 = ridgeFn([[1900, 260, 220], [1300, 320, 260], [600, 280, 240], [0, 330, 260], [-700, 260, 240]], 640, 41, 30);
  LAY.far2 = wlayer(-1200, 0, 3800, 1080);
  LAY.far2.ink.wet.drawImage(mountainLayer({ W: 3800, H: 1080, x0: -1200, ridge: rFar2, depth: 240, tone: .14, rim: .5, rimW: 22, mist: .9, seed: 41, xmask: x => clamp((2350 - x) / 400) }), -1200, 0);
  LAY.rMid2 = ridgeFn([[1560, 380, 300], [1180, 520, 230], [960, 330, 200], [520, 300, 330], [160, 470, 240], [-60, 360, 220], [-520, 260, 360], [-900, 410, 260]], 860, 47, 40);
  LAY.mid2 = wlayer(-1500, 0, 4000, 1080);
  LAY.mid2.ink.wet.drawImage(mountainLayer({ W: 4000, H: 1080, x0: -1500, ridge: LAY.rMid2, depth: 380, tone: .4, rim: .8, rimW: 15, mist: .85, seed: 47, xmask: x => clamp((2300 - x) / 300) }), -1500, 0);
  cun(LAY.mid2.ink, { x0: -1400, x1: 2100, ridge: LAY.rMid2, tone: .34, cun: 1.4, moss: 1.3, seed: 47, cunLen: 1.1 });
  // 山腰瀑布（第二道）
  const fx2 = 950, fy2 = LAY.rMid2(fx2) + 10;
  for (const c of [LAY.mid2.ink.wet]) { c.save(); c.globalCompositeOperation = 'destination-out'; const g = c.createLinearGradient(fx2 - 22, 0, fx2 + 22, 0); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(.5, 'rgba(0,0,0,.95)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(fx2 - 22, fy2, 44, 600); c.restore(); }
  // —— 夜 ——
  buildNight();
}

// 把带细碎起伏的山脊函数按 step 取样，再用 Catmull-Rom 连成一条顺滑的笔路
function smoothCurve(f, a, b, step, dy = 0) {
  const ys = []; for (let x = a; x <= b + step; x += step) ys.push(f(x) + dy);
  return x => { const i = clamp((x - a) / step, 0, ys.length - 2.001), j = Math.floor(i), t = i - j;
    const p0 = ys[Math.max(0, j - 1)], p1 = ys[j], p2 = ys[j + 1], p3 = ys[Math.min(ys.length - 1, j + 2)];
    return .5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t); };
}

// 昼的相机
function dayCam(t) {
  const f = t * FPS;
  if (t < T.pan) { const u = eio(t / T.pan); return { x: 3600, y: 540 + 6 * u, z: 1 + .06 * u }; }
  const pan = eio(segF(t, T.pan, T.pan + 1.25));
  let x = lerp(3600, CRANE0[0], pan), y = 546, z = 1.06;
  const push = eio(segF(t, 5.35, 7.35)); z = lerp(1.06, 1.6, push); y = lerp(546, 540, push);
  const tilt = eio(segF(t, bt(9.25), bt(10))); y = lerp(y, 400, tilt); z = lerp(z, 1.45, tilt);
  z += .05 * segF(t, T.hush, T.cry);                                   // 静默里的极慢推近
  if (t >= T.cry) {
    // 跟拍：速度随节拍加快，墨滴后减速到停
    const v = tt => tt < T.drop ? lerp(250, 1350, Math.pow(segF(tt, T.cry, T.drop), 1.3)) : 1350 * Math.pow(1 - segF(tt, T.drop, T.drop + .6), 2.2);
    let dist = 0; const n = 60, a = T.cry, b = Math.min(t, T.full);
    for (let i = 0; i < n; i++) dist += v(a + (b - a) * (i + .5) / n) * (b - a) / n;
    x = CRANE0[0] - dist;
    const o = eio(segF(t, T.cry, T.cry + 1.1)); y = lerp(400, 540, o); z = lerp(1.5, 1.0, o);
    z += .14 * eio(segF(t, T.drop, T.full));                           // 推进墨晕
  }
  return { x, y, z };
}
const parCam = (cam, f, X0 = CRANE0[0]) => ({ x: X0 + (cam.x - X0) * f, y: 540 + (cam.y - 540) * f, z: 1 + (cam.z - 1) * f });

// 屏幕空间的柔和遮罩：world 中心、半径 R、噪声边（四分之一分辨率）
const MW = 480, MH = 270; let MK = null;
function bloomMask(cam, c, R, nscale = .0035) {
  if (!MK) MK = cv(MW, MH);
  const { s, tx, ty } = xfOf(cam), cx = MK.getContext('2d'), im = cx.createImageData(MW, MH);
  for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) {
    const wx = (i * 4 + 2 - tx) / s, wy = (j * 4 + 2 - ty) / s;
    const d = Math.hypot(wx - c[0], (wy - c[1]) * 1.25);
    const n = vn2(wx * nscale + 3, wy * nscale) * .55 + vn2(wx * nscale * 4, wy * nscale * 4 + 7) * .3 + vn2(wx * .05, wy * .05) * .15;
    im.data[(j * MW + i) * 4 + 3] = clamp((R - d * (.62 + .8 * n)) / (R * .08 + 8)) * 255;
  }
  cx.putImageData(im, 0, 0); return MK;
}
function maskedBlit(A, TMP, L, cam, mask, which = ['wet', 'dry'], am = 1) {
  const { s, tx, ty } = xfOf(cam);
  for (const k of which) {
    const c = TMP.ink[k]; c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.clearRect(0, 0, 1920, 1080);
    c.drawImage(L[k], L.x0 * s + tx, L.y0 * s + ty, L.w * s, L.h * s);
    c.globalCompositeOperation = 'destination-in';
    if (typeof mask === 'function') mask(c); else c.drawImage(mask, 0, 0, 1920, 1080);
    c.globalCompositeOperation = 'source-over';
    const d = A.ink[k]; d.save(); d.setTransform(1, 0, 0, 1, 0, 0); d.globalAlpha = am; d.drawImage(TMP[k], 0, 0); d.restore();
  }
}
// 淡墨烘天（生鹤处）：一张缓存的整幅湿墨，按墨晕遮罩长出来
function washLayer() {
  const W = 2400, H = 1300, x0 = CRANE0[0] - 1200, y0 = -100, L = wlayer(x0, y0, W, H);
  const c = L.ink.wet, im = c.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = x + x0, wy = y + y0, dx = (wx - CRANE0[0]) / 980, dy = (wy - (CRANE0[1] - 40)) / 560;
    const r = Math.sqrt(dx * dx + dy * dy), n = vn2(wx * .004, wy * .004) * .6 + vn2(wx * .016 + 5, wy * .016) * .3 + vn2(wx * .06, wy * .06) * .1;
    const a = .2 * clamp(1.15 - r * (.75 + .55 * n)) * (.82 + .36 * vn2(wx * .01 + 9, wy * .02));
    im.data[(y * W + x) * 4 + 3] = clamp(a) * 255;
  }
  c.putImageData(im, 0, 0);
  return L;
}

// ───────────── 鹤的状态 ─────────────
function flapPose(f, base, beats, up = 74, down = -14) {
  // 下扑最低点落在每个拍点；一拍二：只在"距上一拍偶数帧"处换画稿
  let i = 0; while (i < beats.length - 1 && bf(beats[i + 1]) <= f) i++;
  const b0 = bf(beats[i]), b1 = i + 1 < beats.length ? bf(beats[i + 1]) : b0 + 20;
  const q = b0 + Math.floor((f - b0) / 2) * 2;
  const ph = clamp((q - b0) / (b1 - b0));                             // 0 = 最低点 → .55 = 最高 → 1 = 最低
  const a = ph < .55 ? lerp(down, up, ss(ph / .55)) : lerp(up, down, ei((ph - .55) / .45) * .6 + ss((ph - .55) / .45) * .4);
  return { pose: withWing(base, a), ph, k: Math.floor(q / 2) };
}

function craneDay(t) {
  // 生鹤 + 起飞（世界坐标）
  const f = Math.floor(t * FPS / 2) * 2;                               // 一拍二
  const f1 = t * FPS;
  const on = (b, n) => segF(f1, bf(b) - 1, bf(b) + n);     // 落笔帧就见墨
  const prog = { body: segF(f1, bf(6) + 3, bf(6) + 14), legs: segF(f1, bf(6) + 8, bf(6) + 16), wing1: on(7, 5), wing2: on(7.5, 5), neck: on(8, 5), crown: f1 >= bf(8.5) ? .6 + .4 * segF(f1, bf(8.5), bf(8.5) + 3) : 0 };
  let pose = POSE.display, x = CRANE0[0], y = CRANE0[1];
  // 生鹤时翼缓缓张开（呼吸）
  pose = withWing(pose, 50 + 8 * Math.sin(f / FPS * 2.4));
  if (f >= bf(8.5)) pose = mix(pose, POSE.raise, ss(segF(f, bf(8.5) + 2, bf(9))));   // 预备：举翼
  if (f >= bf(9)) pose = mix(POSE.raise, POSE.lift, back2(segF(f, bf(9), bf(9.5))));  // 下扑
  if (f >= bf(9.5)) {                                                                 // 离地：再上扑
    const u = segF(f, bf(9.5), bf(10));
    pose = mix(POSE.lift, mix(POSE.raise, POSE.fly, .5), ss(u * 1.4));
    const v = segF(f1, bf(9.5) - 3, bf(10) - 1);
    y = CRANE0[1] - 820 * ei(v) - 40 * v; x = CRANE0[0] - 160 * v * v;
  }
  return { space: 'world', x, y, s: BIRTH_S, pose, k: f / 2, prog, show: f1 >= bf(6) + 4 && f1 < bf(10) };
}
function back2(u) { return ss(u); }

// 飞行中的鹤（屏幕坐标），从 b11 起
const SS = 3.3;   // 飞越段鹤的屏幕尺寸（翼举起时约占画高 0.4）
function craneFly(t) {
  const f1 = t * FPS;
  const fp = flapPose(f1, POSE.fly, WINGBEATS.concat([19, 20]), 70, -50), { k, ph } = fp;
  // 侧面看，翼放平时是朝向镜头的（透视缩短），不是向后平伸压在身上：翼长随 |sin 翼角| 缩短
  const pose = { ...fp.pose, wl: .5 + .5 * Math.pow(Math.abs(Math.sin(fp.pose.wa * Math.PI / 180)), .8) };   // 下扑最低点：翼垂到身下（不再与身体、尾羽叠成一团）
  const e = eo(segF(t, T.cry, bt(12)));
  let x = lerp(2020, 1120, e), y = 420;
  x -= 90 * segF(t, bt(12), T.drop);
  x = lerp(x, 900, ss(segF(t, T.drop, T.full)));
  y = lerp(420, 400, ss(segF(t, T.drop, T.full)));
  y += -16 * Math.sin(ph * Math.PI * 2 + .6);                        // 下扑抬升
  return { space: 'screen', x, y, s: SS, pose, k };
}

// ───────────── 夜 ─────────────
const MOON = [1290, 250, 104];
const NCAM0 = { x: 840, y: 470, z: 1.45 };
const ridgeN = x => ridge1(x * .9 + 3000) * .55 + 340;             // 开场那道山脊在月下重现（同一函数，压低）
const ridgeNF = ridgeFn([[120, 120, 260], [560, 170, 240], [980, 110, 300], [1520, 190, 280], [1980, 140, 240]], 640, 61, 20);   // 月下远山
let NIGHT = null;
function buildNight() {
  NIGHT = {};
  const W = 2160, H = 1240, x0 = -120, y0 = -80;
  NIGHT.sky = wlayer(x0, y0, W, H);
  const c = NIGHT.sky.ink.wet, im = c.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = x + x0, wy = y + y0;
    const dm = Math.hypot(wx - MOON[0], wy - MOON[1]) / MOON[2];
    const cloud = vn2(wx * .0025, wy * .006) * .6 + vn2(wx * .01 + 3, wy * .02) * .3 + vn2(wx * .04, wy * .05) * .1;
    // 远淡近浓：天顶重（≈.6），往地平线一路淡到清墨（≈.12）
    let a = lerp(.62, .12, Math.pow(clamp((wy + 80) / 700), .85)) * (.8 + .4 * cloud);
    a *= lerp(.35, 1, clamp((dm - 1) / 1.6));                                                             // 月晕
    a *= smoothE(dm, .985, 1.03);                                                                          // 月：纸白
    // 山脚下一条留白的雾带（纸白），雾带以下是极淡的地气
    const band = smoothE(wy, 760, 830) * (1 - smoothE(wy, 930, 1040));
    const bandN = clamp(band * (1.15 + .5 * (vn2(wx * .004 + 7, 1.7) - .5)));
    a = a * (1 - bandN) + (wy > 880 ? .1 * smoothE(wy, 960, 1160) * (.7 + .6 * cloud) : 0);
    im.data[(y * W + x) * 4 + 3] = clamp(a) * 255;
  }
  c.putImageData(im, 0, 0);
  // 远山：清墨一抹，在主山之后（远淡）
  NIGHT.far = wlayer(x0, y0, W, H);
  NIGHT.far.ink.wet.drawImage(mountainLayer({ W, H, x0, ridge: x => ridgeNF(x) - y0, depth: 190, tone: .2, rim: .45, rimW: 16, mist: .95, seed: 61 }), x0, y0);
  NIGHT.ridge = wlayer(x0, y0, W, H);
  NIGHT.ridge.ink.wet.drawImage(mountainLayer({ W, H: H, x0, ridge: x => ridgeN(x) - y0, depth: 300, tone: .66, rim: 1, rimW: 14, mist: .5, seed: 5, xmask: x => clamp((x - 860) / 260) }), x0, y0);
  cun(NIGHT.ridge.ink, { x0: 980, x1: 2000, ridge: ridgeN, tone: .4, cun: 1.1, moss: 1.2, seed: 15, cunLen: .8 });
  // 雾带：远山与主山的山脚都化进同一条留白
  for (const L of [NIGHT.far, NIGHT.ridge]) for (const c of [L.ink.wet, L.ink.dry]) {
    c.save(); c.globalCompositeOperation = 'destination-out';
    const g = c.createLinearGradient(0, 750, 0, 1060); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(.3, 'rgba(0,0,0,.97)'); g.addColorStop(.6, 'rgba(0,0,0,.97)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(x0, 750, W, 310); c.restore();
  }
  // 松枝：一笔写就（自左缘入）
  NIGHT.branchPts = [[-90, 760, 1.2], [60, 712, 1.25], [190, 700, .85], [300, 662, 1.05], [420, 664, .75], [540, 636, .95], [660, 630, .7], [760, 618, .8], [880, 596, .5], [960, 604, .22]];
  NIGHT.branch = mk(NIGHT.branchPts, { w: 40, tone: TONE.jiao, darkDir: [0, 1], side: .85, dry: .52, wet: .4, brWet: true, body: .75, prof: 'press', rough: .3, nb: 50, seed: 71, per: 6 });
  NIGHT.twig = mk([[400, 662, .9], [450, 620, .75], [520, 590, .6], [575, 548, .25]], { w: 15, tone: .88, dry: .55, wet: .3, prof: 'nail', seed: 72 });
  NIGHT.needles = [[120, 700, 1.3], [575, 545, 1.15], [900, 592, 1.2], [300, 650, .95], [470, 610, .8]];
}
function smoothE(x, a, b) { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); }
function branchY(x) {
  const P = NIGHT.branch.P; let best = P[0];
  for (const p of P) if (Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
  return best[1];
}
function nightCam(t) {
  const u = eio(segF(t, 15.55, DUR));
  return { x: lerp(NCAM0.x, 960, u), y: lerp(NCAM0.y, 540, u), z: lerp(NCAM0.z, 1, u) };
}
const LANDX = 724;
function craneNight(t) {
  const f1 = t * FPS, fq = Math.floor(f1 / 2) * 2;
  const cam = nightCam(t);
  const toW = (sx, sy) => [(sx - 960) / cam.z + cam.x, (sy - 540) / cam.z + cam.y];
  const fly = craneFly(Math.min(t, T.full));
  const land = bf(HIT.land);
  // 落点：脚落在松枝上
  const feetW = [LANDX, branchY(LANDX)];
  const s1 = 1.55;
  const standBody = footToBody(POSE.stand, feetW, s1);
  let pose, x, y, s, k = fq / 2;
  if (f1 < bf(19)) {
    const p0 = toW(fly.x, fly.y);
    return { space: 'world', x: p0[0], y: p0[1], s: SS / NCAM0.z, pose: fly.pose, k: fly.k, cam };
  }
  if (f1 < land) {
    const u = segF(f1, bf(19), land);
    const p0 = toW(fly.x, fly.y), s0 = SS / NCAM0.z;
    const brakeBody = footToBody(POSE.brake, [feetW[0] + 10, feetW[1] - 6], s1);
    const e = ss(u);
    x = lerp(p0[0], brakeBody[0], e) + 40 * Math.sin(u * Math.PI); y = lerp(p0[1], brakeBody[1], e) - 70 * Math.sin(u * Math.PI);
    s = lerp(s0, s1, e);
    const fp = flapPose(f1, POSE.fly, [19, 20, 21], 80, -26).pose;
    pose = mix(fp, POSE.brake, ss(segF(fq, bf(20) + 2, land - 2)));
  } else {
    // 触枝：收翼、身体下沉再回弹（跟随动作）
    const u = segF(fq, land, land + 16);
    pose = mix(POSE.brake, POSE.stand, ss(u));
    s = s1;
    const dip = Math.sin(clamp((f1 - land) / 10) * Math.PI) * 9 * (1 - clamp((f1 - land) / 20));
    [x, y] = footToBody(pose, feetW, s1);
    y += dip;
    if (fq >= bf(22) + 6) pose = mix(POSE.stand, POSE.look, eio(segF(fq, bf(22) + 6, bf(22.5))));
    if (fq >= bf(23)) pose = mix(POSE.look, POSE.lookdown, eio(segF(fq, bf(23), bf(23) + 10)));   // 末拍：低头一敛（随末音落下）
  }
  return { space: 'world', x, y, s, pose, k, cam };
}
// 由脚位反推鹤身中心
function footToBody(pose, feet, s) {
  const c = Math.cos(pose.pitch * Math.PI / 180), sn = Math.sin(pose.pitch * Math.PI / 180), p = pose.legs[0][2];
  return [feet[0] - (p[0] * c - p[1] * sn) * s, feet[1] - (p[0] * sn + p[1] * c) * s];
}

// ───────────── 印章「墨戏」 ─────────────
// 印位（世界坐标）：题款列正下方，边长 88（旧版 64 的 1.4 倍；题款整列上移 28，印落在山脊之上的空白里）
const SEAL = [1012 + (96 - 88) / 2, 140 + 4 * 102 + 0, 88];
function seal(c, x, y, S, am) {
  if (am <= 0) return;
  c.save(); c.translate(x, y);
  c.beginPath();
  for (let i = 0; i < 40; i++) {
    const tt = i / 40 * 4, side = Math.floor(tt), u = tt - side; let px, py;
    if (side === 0) { px = u * S; py = 0; } else if (side === 1) { px = S; py = u * S; } else if (side === 2) { px = S - u * S; py = S; } else { px = 0; py = S - u * S; }
    px += (vn2(i * 1.3, 2) - .5) * S * .03; py += (vn2(i * 1.3, 9) - .5) * S * .03; i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.closePath(); c.fillStyle = `rgba(${VERM.join(',')},${clamp(am)})`; c.fill();
  c.globalCompositeOperation = 'destination-out'; c.strokeStyle = '#000'; c.fillStyle = '#000';
  // 白文：两字右起——墨（右）戏（左），各占半幅竖长格；字线等宽、粗（1080p 下约 6 px），刀口略有起伏
  const pad = .1 * S, cw = (S - 2 * pad - .05 * S) / 2, ch = S - 2 * pad;
  for (const [chr, ox] of [['墨', pad + cw + .05 * S], ['戏', pad]]) sealLines(c, chr, ox, pad, cw, ch, S * .056);
  // 印泥颗粒与边口残损
  for (let i = 0; i < 90; i++) { const a = vn2(i * 3.7, 1), b = vn2(i * 2.9, 5); c.globalAlpha = .35 + .65 * vn2(i, 3); c.beginPath(); c.arc(a * S, b * S, S * (.004 + .009 * vn2(i * 5.3, 7)), 0, 7); c.fill(); }
  for (let i = 0; i < 6; i++) { const e = vn2(i * 7.1, 2), side = i % 4; const px = side === 0 ? e * S : side === 1 ? S : side === 2 ? e * S : 0, py = side === 0 ? 0 : side === 1 ? e * S : side === 2 ? S : e * S; c.globalAlpha = .9; c.beginPath(); c.arc(px, py, S * (.012 + .02 * vn2(i, 11)), 0, 7); c.fill(); }
  c.restore();
}

// ───────────── 每帧 ─────────────
let WASH = null;
export function init() { build(); WASH = washLayer(); }

function drawCrane(Lr, st, xf, cut = null) {
  const L = Lr.ink;
  if (st.space === 'screen') for (const c of [L.wet, L.dry, L.col]) c.setTransform(1, 0, 0, 1, 0, 0);
  else for (const c of [L.wet, L.dry, L.col]) c.setTransform(xf.s, 0, 0, xf.s, xf.tx, xf.ty);
  // 先从背景里"留"出鹤身（空即是物）
  for (const c of [L.wet, L.dry]) {
    c.save(); c.globalCompositeOperation = 'destination-out'; c.filter = `blur(${Math.round(3 * (st.space === 'screen' ? 1 : xf.s))}px)`; c.fillStyle = '#000'; c.strokeStyle = '#000';
    silhouette(c, st.x, st.y, st.s, st.pose);
    if (cut) cut(c);
    c.restore();
  }
  return crane(L, st.x, st.y, st.s, st.pose, { k: st.k, prog: st.prog });
}

function renderDay(A, t, TMP, o = {}) {
  const f = t * FPS, cam = dayCam(t), xf = xfOf(cam), L = A.ink;
  // 开场：纸先被清水润过（几处极淡的水痕，随后被第一笔吃进去）
  if (cam.x > 1200) {
    A.xf(xf.s, xf.tx, xf.ty);
    const R = mulberry(3), k = 1 - .6 * segF(f, bf(1), bf(1) + 24);
    for (let i = 0; i < 7; i++) {
      const x = 2750 + R() * 1800, y = 500 + R() * 220, r = 120 + R() * 220, c = L.wet;
      c.save(); c.translate(x, y); c.scale(1, .32 + R() * .2); const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, `rgba(0,0,0,${.05 * k})`); g.addColorStop(.75, `rgba(0,0,0,${.035 * k})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.beginPath(); c.arc(0, 0, r, 0, 7); c.fill(); c.restore();
    }
  }
  // 远山：第二笔之后从山脊往下化开
  const farU = segF(f, bf(2) - 3, bf(2) + 22);
  if (farU > 0 && cam.x > 1200) maskedBlit(A, TMP, LAY.far, cam, c => { const y = xf.ty + xf.s * lerp(380, 1150, eo(farU)); const g = c.createLinearGradient(0, y - 160 * xf.s, 0, y); g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(0, 0, 1920, 1080); }, ['wet']);
  // 近山山体：第一笔收笔（b1）后向下渗开；瀑布处留白
  const bodyU = segF(f, bf(1), bf(1) + 30);
  const fallU = segF(f, bf(3) - 1, bf(3) + 15);
  if (bodyU > 0 && cam.x > 1200) maskedBlit(A, TMP, LAY.near, cam, c => {
    const y = xf.ty + xf.s * lerp(330, 1180, Math.pow(eo(bodyU), .8)); const g = c.createLinearGradient(0, y - 220 * xf.s, 0, y);
    g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(0, 0, 1920, 1080);
    if (fallU > 0) {   // 飞白瀑布：水即纸白
      c.globalCompositeOperation = 'destination-out';
      const x = FALLX * xf.s + xf.tx, y0 = (ridge1(FALLX) + 10) * xf.s + xf.ty, y1 = y0 + (980 - ridge1(FALLX)) * xf.s * eo(fallU);
      const gg = c.createLinearGradient(x - 34 * xf.s, 0, x + 34 * xf.s, 0); gg.addColorStop(0, 'rgba(0,0,0,0)'); gg.addColorStop(.5, '#000'); gg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = gg; c.fillRect(x - 34 * xf.s, y0, 68 * xf.s, y1 - y0); c.globalCompositeOperation = 'destination-in';
    }
  }, ['wet']);
  A.xf(xf.s, xf.tx, xf.ty);
  if (cam.x > 1200) {
    // 第一笔：0.583 s 入画，b1 收笔（几帧扫过全幅）
    const p2 = segF(f, bf(2) - 4, bf(2));
    if (p2 > 0) {
      for (const k of ['wet', 'dry']) { const c = TMP.ink[k]; c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.clearRect(0, 0, 1920, 1080); c.setTransform(xf.s, 0, 0, xf.s, xf.tx, xf.ty); }
      draw(TMP.ink, LAY.farS, p2, .9);
      for (const k of ['wet', 'dry']) { const c = TMP.ink[k]; c.globalCompositeOperation = 'destination-out'; c.globalAlpha = 1; c.fillStyle = '#000'; LAY.farClip(c); c.fill();   /* 填充色必须不透明：draw() 留下的是半透明渐变，旧版因此没剪干净，远山线压到了近山前面 */ c.globalCompositeOperation = 'source-over'; const d = L[k]; d.save(); d.setTransform(1, 0, 0, 1, 0, 0); d.drawImage(TMP[k], 0, 0); d.restore(); }
    }
    const p1 = segF(f, STROKE_IN * FPS, bf(1));
    // 行笔先慢后快：藏锋起笔、中段加速，出锋一甩正落在拍 1（收笔帧 = 鼓点）
    if (p1 > 0) drawGraphStroke(L, LAY.ridgeG, Math.pow(p1, 2.6));
    if (fallU > 0) { draw(L, LAY.fallS[0], fallU); draw(L, LAY.fallS[1], segF(f, bf(3) + 2, bf(3) + 14)); }
    // 苔点：三拍点
    [HIT.moss1, HIT.moss2, HIT.moss3].forEach((b, i) => {
      const u = segF(f, bf(b) - 1, bf(b) + 2); if (u <= 0) return;
      const m = LAY.moss[i], R = mulberry(90 + i);
      for (let k = 0; k < 4; k++) blot(L.wet, m.x + (R() - .5) * 26, m.y + (R() - .5) * 8, (3.5 + R() * 4) * (.5 + .5 * u), .95, R() * 3, .6 + R() * .3, i * 9 + k);
    });
  }
  // 飞越段视差层
  if (t > T.cry) {
    const pf = parCam(cam, .35), pm = parCam(cam, .7);
    const fade = ss(clamp((CRANE0[0] - 40 - cam.x) / 700));
    blit(A, LAY.far2, pf, fade, ['wet']);
    blit(A, LAY.mid2, pm, fade);
    A.xf(xf.s, xf.tx, xf.ty);
  }
  // 生鹤：淡墨烘天，按墨晕长出
  const washU = segF(f, bf(6) - 1, bf(6) + 20);
  if (washU > 0) {
    const M = bloomMask(cam, [CRANE0[0], CRANE0[1] - 30], 40 + 1250 * eo(washU), .004);
    const washFade = 1 - ss(segF(t, T.cry, T.cry + .9));
    if (washFade > 0) maskedBlit(A, TMP, WASH, cam, c => {
      c.drawImage(M, 0, 0, 1920, 1080);
      c.globalCompositeOperation = 'destination-out'; c.setTransform(xf.s, 0, 0, xf.s, xf.tx, xf.ty); c.filter = `blur(${Math.round(8 * xf.s)}px)`; c.fillStyle = '#000'; c.strokeStyle = '#000';
      c.globalAlpha = .88; silhouette(c, CRANE0[0], CRANE0[1], BIRTH_S, withWing(POSE.display, 54)); c.globalAlpha = 1; c.filter = 'none'; c.setTransform(1, 0, 0, 1, 0, 0);
    }, ['wet'], washFade);
    // 留白鹤形的湿边：鹤飞走后，淡墨在空白边缘积起一圈（墨去纸现，不是剪出来的洞）
    const ringU = ss(segF(f, bf(9.5), bf(10) + 4)) * washFade;
    if (ringU > 0) {
      A.xf(xf.s, xf.tx, xf.ty); const c = L.wet, sil = withWing(POSE.display, 54);
      c.save(); c.fillStyle = '#000'; c.strokeStyle = '#000';
      c.filter = `blur(${Math.round(11 * xf.s)}px)`; c.globalAlpha = .17 * ringU; silhouette(c, CRANE0[0], CRANE0[1], BIRTH_S * 1.04, sil);
      c.globalCompositeOperation = 'destination-out'; c.filter = `blur(${Math.round(5 * xf.s)}px)`; c.globalAlpha = .8 * ringU; silhouette(c, CRANE0[0] + 2, CRANE0[1] + 1, BIRTH_S * .97, sil);
      c.restore();
    }
  }
  // 鹤
  if (t < T.cry) {
    const st = craneDay(t);
    if (st.show) drawCrane(A, st, xf);
    // 起飞的水圈
    // 落羽
    if (f >= bf(9.5) + 2) {
      const u = (f - bf(9.5) - 2) / FPS;
      A.xf(xf.s, xf.tx, xf.ty);
      feather(L, CRANE0[0] + 40 + 34 * Math.sin(u * 2.6), CRANE0[1] - 120 + 58 * u + 6 * Math.sin(u * 5.2), 2.1, .35 * Math.sin(u * 2.6 + .8));
    }
  } else {
    // 飞越：屏幕空间
    const st = craneFly(t);
    drawCrane(A, st, xf);
    if (t < T.cry + 1.4) {
      const u = (f - bf(9.5) - 2) / FPS; A.xf(xf.s, xf.tx, xf.ty);
      feather(L, CRANE0[0] + 40 + 34 * Math.sin(u * 2.6), CRANE0[1] - 120 + 58 * u + 6 * Math.sin(u * 5.2), 2.1, .35 * Math.sin(u * 2.6 + .8), 1 - segF(t, T.cry, T.cry + 1.4));
    }
  }
  // 墨滴：自画外落下（b16 落纸），落点在世界里
  const dropW = dropWorld();
  const fallT = .26;
  if (t >= T.drop - fallT && t < T.drop) {
    const u = (t - (T.drop - fallT)) / fallT; A.xf(xf.s, xf.tx, xf.ty);
    const top = cam.y - 560 / cam.z, y = lerp(top, dropW[1], u * u);
    L.wet.globalAlpha = .95; L.wet.fillStyle = '#000'; L.wet.beginPath(); L.wet.ellipse(dropW[0], y, 9, 13 + 16 * u, 0, 0, 7); L.wet.fill(); L.wet.globalAlpha = 1;
    draw(L, mk([[dropW[0], y - 140 * u - 10], [dropW[0], y - 10]], { w: 4, tone: .4, dry: .6, prof: 'tip', seed: 9 }), 1, .6);
  }
  if (t >= T.drop) {
    const u = segF(t, T.drop, T.drop + .5); A.xf(xf.s, xf.tx, xf.ty);
    const R = mulberry(77);
    for (let i = 0; i < 14; i++) { const a = R() * 6.28, d = (10 + R() * 70) * eo(u); blot(L.wet, dropW[0] + Math.cos(a) * d, dropW[1] + Math.sin(a) * d * .6, (5 + R() * 22) * (.3 + .7 * eo(u)), .7, R() * 3, .6 + R() * .4, i + 5); }
    for (let i = 0; i < 10; i++) { const a = R() * 6.28, d = (60 + R() * 140) * eo(segF(t, T.drop, T.drop + .12)); blot(L.dry, dropW[0] + Math.cos(a) * d, dropW[1] + Math.sin(a) * d * .5, 1.5 + R() * 3, .85, 0, 1, i + 40); }
  }
  return { cam };
}
let DROPW = null;
function dropWorld() {
  if (DROPW) return DROPW;
  const cam = dayCam(T.drop);
  return (DROPW = [(700 - 960) / cam.z + cam.x, (610 - 540) / cam.z + cam.y]);
}

function renderNight(A, t, TMP) {
  const f = t * FPS, cam = nightCam(t), xf = xfOf(cam), L = A.ink;
  blit(A, NIGHT.sky, cam, 1, ['wet']);
  blit(A, NIGHT.far, cam, 1, ['wet']);
  blit(A, NIGHT.ridge, cam);
  A.xf(xf.s, xf.tx, xf.ty);
  // 一笔松枝（b20 起笔）
  const pb = segF(f, bf(20) - 1, bf(20) + 8);
  if (pb > 0) draw(L, NIGHT.branch, pb);
  const pt = segF(f, bf(20) + 6, bf(20) + 10); if (pt > 0) draw(L, NIGHT.twig, pt);
  NIGHT.needles.forEach(([x, y, k], i) => {
    const u = segF(f, bf(20) + 7 + i * 2, bf(20) + 11 + i * 2); if (u <= 0) return;
    // 落枝时松针随枝一颤
    const shake = f > bf(21) ? Math.sin((f - bf(21)) * .9) * 4 * Math.exp(-(f - bf(21)) / 8) : 0;
    for (let layer = 0; layer < 2; layer++) {
      const n = 15, rr = (layer ? 44 : 60) * k;
      for (let j = 0; j < n; j++) {
        const a = -Math.PI / 2 + (j / (n - 1) - .5) * 2.9 + (layer ? .1 : 0);
        const c0 = [x, y + shake + (layer ? 4 : 0)], c1 = [c0[0] + Math.cos(a) * rr, c0[1] + Math.sin(a) * rr * .42 + rr * .1];
        draw(L, mk([c0, c1], { w: 2.6, tone: layer ? .85 : .55, dry: .4, wet: .3, prof: 'tip', seed: 800 + i * 40 + layer * 20 + j }), clamp(u * 1.5 - j * .03));
      }
      blot(L.wet, x, y - 6, 34 * k, .14 * u, 0, .3, i);
    }
  });
  // 鹤
  const st = craneNight(t);
  drawCrane(A, st, xf);
  A.xf(xf.s, xf.tx, xf.ty);
  // 题款「鹤出留白」：竖排，逐字书写
  const CH = ['鹤', '出', '留', '白'], X = 1012, Y0 = 140, SZ = 96, GAP = 102;
  CH.forEach((ch, i) => {
    const [a, b] = INSCR[i], u = segF(f, a, b); if (u <= 0) return;
    write(L, TMP, ch, [X, Y0 + i * GAP, SZ], u, xf, { seed: 5 + i });
  });
  A.xf(xf.s, xf.tx, xf.ty);
  // 钤印（b22）
  if (f >= bf(HIT.seal)) {
    const u = segF(f, bf(HIT.seal), bf(HIT.seal) + 2);
    const S = SEAL[2] * (1.1 - .1 * u);
    A.cc.save(); A.cc.setTransform(xf.s, 0, 0, xf.s, xf.tx, xf.ty); seal(A.cc, SEAL[0] - (S - SEAL[2]) / 2, SEAL[1] - (S - SEAL[2]) / 2, S, .5 + .5 * u); A.cc.restore();
  }
  return { cam };
}

export function textsAt(t) {
  const f = t * FPS; if (f < INSCR[0][0]) return [];
  const cam = nightCam(t), xf = xfOf(cam), X = 1012, Y0 = 140, SZ = 96, GAP = 102;
  const S = v => v * xf.s;
  const out = [{ id: 'tiba', text: '鹤出留白', x0: S(X) + xf.tx, y0: S(Y0) + xf.ty, x1: S(X + SZ) + xf.tx, y1: S(Y0 + 3 * GAP + SZ) + xf.ty }];
  if (f >= bf(HIT.seal)) out.push({ id: 'seal', text: '墨戏', x0: S(SEAL[0]) + xf.tx, y0: S(SEAL[1]) + xf.ty, x1: S(SEAL[0] + SEAL[2]) + xf.tx, y1: S(SEAL[1] + SEAL[2]) + xf.ty });
  return out;
}

export function frame(t, A, B, TMP) {
  if (t < T.drop) { const o = renderDay(A, t, TMP); return comp(o.cam); }
  if (t < T.full) {
    const oa = renderDay(A, t, TMP), ob = renderNight(B, t, TMP);
    // 墨晕：落点随世界移动，晕内是月夜
    const cam = oa.cam, d = dropWorld(), cx = (d[0] - cam.x) * cam.z + 960, cy = (d[1] - cam.y) * cam.z + 540;
    const u = segF(t, T.drop, T.full);
    const R = 24 + 160 * eo(clamp(u * 4)) + 1060 * Math.pow(u, 1.7);
    // 夜里也有同一只鹤（屏幕坐标），保证穿过晕线时连续
    return { ...comp(cam), paperB: paperOf(ob.cam), bleedB: 5 * ob.cam.z, rimB: .85, trans: [cx, cy, Math.min(R, 2500), 1] };
  }
  const o = renderNight(A, t, TMP); return comp(o.cam);
}
const paperOf = cam => [cam.x * cam.z - 960, cam.y * cam.z - 540, cam.z];
const comp = cam => ({ paper: paperOf(cam), bleed: 4.5 * cam.z, rim: .85, vig: .2, warm: .5 });

export function events() {
  const E = [], b = k => bt(k);
  const ev = (type, beat, extra = {}) => E.push({ t: b(beat), beat, type, ...extra });
  E.push({ t: STROKE_IN - .02, type: 'brushair', dur: bt(1) - STROKE_IN + .02, gain: 1 });
  ev('strokehit', HIT.stroke); ev('bleed', HIT.stroke, { dur: 1.3, gain: .6 });
  ev('brush', HIT.far, { dur: .2, gain: .45 }); ev('bleed', HIT.far, { dur: 1.0, gain: .3 });
  ev('dryfall', HIT.fall, { dur: .62 });
  ev('moss', HIT.moss1); ev('moss', HIT.moss2); ev('moss', HIT.moss3);
  ev('wash', HIT.wash, { dur: 1.0 });
  E.push({ t: F(bf(6) + 4), type: 'brush', dur: .42, gain: .3 });
  ev('brush', HIT.wing1, { dur: .25, gain: .6 }); ev('brush', HIT.wing2, { dur: .25, gain: .55 });
  ev('brush', HIT.neck, { dur: .25, gain: .5 }); ev('crowndot', HIT.crown);
  ev('wingup', HIT.raise); ev('flap', HIT.leap, { gain: 1 }); ev('ripple', HIT.leap); ev('flap', 9.8, { gain: .6 });
  E.push({ type: 'silence', t0: b(HIT.hush), t1: b(HIT.cry) });
  WINGBEATS.forEach(k => ev('wingbeat', k, { gain: k === 11 ? 1 : .55 + .05 * (k - 11) }));
  E.push({ t: T.drop - .26, type: 'dropfall', dur: .26 });
  ev('drop', HIT.drop); ev('spread', HIT.drop, { dur: T.full - T.drop });
  ev('wingbeat', 19, { gain: .45 }); ev('wingbeat', 20, { gain: .45 });
  ev('branch', HIT.branch, { dur: .36 });
  [0, 1, 2, 3].forEach(i => E.push({ t: F(bf(20) + 8 + i * 2), type: 'needle', gain: .35 }));
  E.push({ t: F(bf(20) + 4), type: 'brake', dur: bt(21) - F(bf(20) + 4) });
  ev('land', HIT.land); ev('creak', HIT.land); E.push({ t: F(bf(21) + 6), type: 'ruffle', dur: .5 });
  INSCR.forEach(([a, c], i) => E.push({ t: F(a), type: 'write', dur: F(c - a), gain: .5 }));
  ev('seal', HIT.seal);
  E.push({ t: F(bf(22) + 6), type: 'turn', dur: F(bf(22.5) - bf(22) - 6) });
  ev('camera', HIT.pan); ev('lookmoon', HIT.turn); ev('settle', HIT.last, { dur: .45 });
  E.push({ type: 'amb', kind: 'air', t0: 0, t1: b(HIT.hush) });
  E.push({ type: 'amb', kind: 'water', t0: b(HIT.fall), t1: b(6.5) });
  E.push({ type: 'amb', kind: 'wind', t0: b(HIT.cry), t1: T.full + .3 });
  E.push({ type: 'amb', kind: 'night', t0: T.drop + .5, t1: DUR });
  return E;
}
