// 风车的一天 — 低多边形等距小岛
import * as THREE from 'three';
import { clamp, seg, ss, eio, eo, lerp, monotone, hash, TAU } from '/core/lib.js';
import { DUR, T, BEAT, b, SKY, shotAt, AZ0, FPS, WIN_BEATS, WIN_NOTES, STAR_BEATS, STAR_NOTES, TITLE, TITLE_BEATS, TITLE_NOTES, BPM } from './timeline.js';
import { makePost } from './post.js';
import { makeSea } from './sea.js';
import { buildWorld } from './world.js';

const W = innerWidth || 1920, H = innerHeight || 1080, QS = new URLSearchParams(location.search);
const SSAA = +(QS.get('ssaa') ?? 2);
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-10, 10, 5, -5, 1, 1600);
const post = makePost(renderer, scene, camera, W, H, { ssaa: SSAA, aoRadius: .7, aoScale: 1.5, aoThickness: 1 });
post.bloom.threshold = .95; post.bloom.radius = .55;

const sea = makeSea(scene);
const world = buildWorld(scene);
sea.drawShallow(world.blobs);

const hemi = new THREE.HemisphereLight('#eef6fb', '#c6b89c', 1.1); scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff6e8', 2.6); sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -.0006; sun.shadow.normalBias = .02; sun.shadow.radius = 3;
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 140 }); sun.shadow.camera.updateProjectionMatrix();
scene.add(sun, sun.target);

// —— 天色 ——
const C = h => new THREE.Color(h);
const SK = SKY.map(k => ({ t: k[0], zen: C(k[1]), hor: C(k[2]), deep: C(k[3]), shal: C(k[4]), sun: C(k[5]), sunI: k[6], hs: C(k[7]), hg: C(k[8]), hI: k[9], el: k[10], az: k[11], night: k[12] }));
function skyAt(t) {
  let i = 0; while (i < SK.length - 2 && t > SK[i + 1].t) i++;
  const a = SK[i], c = SK[i + 1], u = ss(seg(t, a.t, c.t)), o = {};
  for (const k of ['zen', 'hor', 'deep', 'shal', 'sun', 'hs', 'hg']) o[k] = a[k].clone().lerp(c[k], u);
  for (const k of ['sunI', 'hI', 'el', 'az', 'night']) o[k] = lerp(a[k], c[k], u);
  return o;
}

// —— 转台：速度曲线 v(u) ∝ u^1.1 (1-u)^2.1 → 先加速、后长减速，在 T.stop 精确停住 ——
const TT = (() => { const N = 2000, a = new Float64Array(N + 1); for (let i = 1; i <= N; i++) { const u = (i - .5) / N; a[i] = a[i - 1] + Math.pow(u, 1.1) * Math.pow(1 - u, 2.1); } for (let i = 0; i <= N; i++) a[i] /= a[N]; return u => { const x = clamp(u) * N, i = Math.min(N - 1, Math.floor(x)); return lerp(a[i], a[i + 1], x - i); }; })();
export function turnAz(t) {
  if (t < T.turn0) return 32 + 8 * eo(seg(t, 0, T.turn0));
  if (t < T.stop) return AZ0 + 360 * TT(seg(t, T.turn0, T.stop));
  const s = t - T.stop; return AZ0 + 360 - 1.4 * Math.sin(s * 9) * Math.exp(-s * 5);   // 刹停的回弹
}

const DEG = Math.PI / 180;
let CAM = {};
const millTop = () => { const p = new THREE.Vector3(); world.mill.hub.getWorldPosition(p); return p; };
const HUB = millTop();
const END_FH = 16;          // 结尾大全景的视锥高（原 20：小岛太小、细节不可读）
// 转台中段一次景别呼吸：拉开到全景 → 正午推近到中全景 → 黄昏再拉开（不切镜，转台照转）
const dayFh = monotone([[0, 4.3], [.7, 4.5], [3.7, 13.4], [b(10), 11.2], [b(14), 13.7], [10, 14]]);
// 夜：推镜在屏息段不完全停死，留一点余推（减速的尾巴），静止画面不会像冻帧
const pushK = monotone([[T.stop, 0], [b(20), 0], [T.breath, 1], [T.lamp, 1.055]]);
function cam(t) {
  const [t0, t1, name] = shotAt(t);
  let tg, az, el, fh, hzA = .1, hzB = .52, tiltB = .3;
  if (name === 'day') {
    const k = ss(seg(t, .5, 3.7));
    tg = [lerp(HUB.x, .3, k), lerp(HUB.y + .05, .7, k), lerp(HUB.z, .1, k)];
    az = turnAz(t); el = lerp(24, 32, ss(seg(t, .3, 3.7))); fh = dayFh(t);
    tiltB = lerp(.2, .3, k);
  } else if (name === 'night') {
    const k = pushK(t);
    tg = [lerp(.3, .55, k), lerp(.7, 1.15, k), lerp(.1, .55, k)];
    az = turnAz(t); el = lerp(32, 30, k); fh = lerp(14, 9.2, k);
  } else {
    const L = world.lampWorld, u = seg(t, T.lamp + .3, DUR - .15), z = eio(u), zz = Math.pow(z, 1.25);
    tg = [lerp(L.x, .2, z), lerp(L.y - .35, 2.75, z), lerp(L.z, .1, z)];
    az = AZ0 + 12 * ss(seg(t, T.lamp, DUR)); el = lerp(30, 15, ss(u)); fh = 3.5 * Math.pow(END_FH / 3.5, zz);
    hzA = lerp(.1, -.02, z); hzB = lerp(.52, .3, z); tiltB = lerp(.22, .4, z);
  }
  const D = Math.max(300, fh * 3), ce = Math.cos(el * DEG);
  camera.position.set(tg[0] + D * ce * Math.sin(az * DEG), tg[1] + D * Math.sin(el * DEG), tg[2] + D * ce * Math.cos(az * DEG));
  camera.up.set(0, 1, 0); camera.lookAt(tg[0], tg[1], tg[2]);
  const fw = fh * W / H; camera.left = -fw / 2; camera.right = fw / 2; camera.top = fh / 2; camera.bottom = -fh / 2; camera.near = 1; camera.far = D + fh * 5 + 800; camera.updateProjectionMatrix();
  const cot = 1 / Math.tan(el * DEG);
  post.comp.camDist.value = D; post.comp.hz0.value = hzA * fh * cot; post.comp.hz1.value = hzB * fh * cot;
  post.tilt.fy.value = .5; post.tilt.band.value = tiltB;
  CAM = { tg, az, el, fh, name };
}

// —— 2D 层：亮星闪光、标题 ——
const ov = document.getElementById('ov'), g = ov.getContext('2d');
const TY = 250;                                        // 标题基线（上三分之一）
const STARS2D = [[0.205, 0.30], [0.80, 0.16], [0.335, 0.11], [0.70, 0.40], [0.12, 0.13]];
function sparkle(x, y, s, a) {
  g.save(); g.globalAlpha = a; g.globalCompositeOperation = 'lighter';
  const gr = g.createRadialGradient(x, y, 0, x, y, s * 3.2); gr.addColorStop(0, 'rgba(255,240,205,.9)'); gr.addColorStop(.25, 'rgba(255,220,160,.25)'); gr.addColorStop(1, 'rgba(255,210,150,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, s * 3.2, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,248,228,1)'; g.beginPath();   // 四角星：平面多边形，和世界的面片一致
  for (let i = 0; i < 8; i++) { const r = i % 2 ? s * .22 : s * (i % 4 ? 1.0 : 1.35), a2 = i * Math.PI / 4 - Math.PI / 2; const px = x + Math.cos(a2) * r, py = y + Math.sin(a2) * r; i ? g.lineTo(px, py) : g.moveTo(px, py); }
  g.closePath(); g.fill(); g.restore();
}
function hexIcon(x, y, s, top) {
  const P = a => [x + Math.cos(a) * s, y + Math.sin(a) * s * .58];
  const pts = [0, 1, 2, 3, 4, 5].map(i => P(i * Math.PI / 3)); const dy = s * .55;
  g.save();
  g.fillStyle = '#7d6a8a'; g.beginPath(); g.moveTo(...pts[0]); [0, 1, 2, 3].forEach(i => g.lineTo(pts[i][0], pts[i][1] + dy)); g.lineTo(...pts[3]); g.closePath(); g.fill();
  g.fillStyle = '#5f4f72'; g.beginPath(); g.moveTo(...pts[0]); g.lineTo(pts[0][0], pts[0][1] + dy); g.lineTo(pts[1][0], pts[1][1] + dy); g.lineTo(...pts[1]); g.closePath(); g.fill();
  g.fillStyle = top; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(...p) : g.moveTo(...p)); g.closePath(); g.fill();
  g.restore();
}
// 标题字：从水线下升起（三次缓动 0.28 s）→ 阻尼正弦过冲；事件时刻 = 第一次回到基线（落定）
const RISE = .28;
const EPS = 1e-6;
const letterOff = (t, te) => { const s = t - (te - RISE); if (s < -EPS) return null; return s < RISE - EPS ? 120 * Math.pow(1 - s / RISE, 3) : -Math.sin(Math.max(0, s - RISE) * 15) * Math.exp(-Math.max(0, s - RISE) * 7) * 12; };
const SUB = 'A DAY OF THE WINDMILL', SUB_T = b(26 + 2 / 3);
function titleLayout() {
  g.font = '300 92px "Noto Sans SC"'; const tr = 46;
  const ws = [...TITLE].map(ch => g.measureText(ch).width), tot = ws.reduce((x, y) => x + y, 0) + tr * (TITLE.length - 1);
  let cx = W / 2 - tot / 2; const pos = []; ws.forEach((w, i) => { pos.push(cx); cx += w + tr; });
  return { pos, tot };
}
function hud(t) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.shadowBlur = 0; g.shadowOffsetY = 0; g.clearRect(0, 0, W, H);
  if (QS.get('nohud')) return;
  // 亮星
  STAR_BEATS.forEach((n, i) => { const te = b(n), s = Math.max(0, t - te); if (t + EPS < te) return; const [fx, fy] = STARS2D[i];
    const pop = 1 + .6 * Math.exp(-s * 9) * Math.cos(s * 24), tw = .82 + .18 * Math.sin(t * 3.1 + i * 2.3);
    sparkle(fx * W, fy * H, 13 * pop * tw, 1); });
  // 标题
  const t0 = b(TITLE_BEATS[0]) - RISE;
  if (t >= T.lamp + .05) {
    const { pos, tot } = titleLayout();
    g.save(); g.beginPath(); g.rect(0, 0, W, TY + 16); g.clip();
    g.font = '300 92px "Noto Sans SC"'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    [...TITLE].forEach((ch, i) => { const off = letterOff(t, b(TITLE_BEATS[i])); if (off === null) return;
      g.shadowColor = 'rgba(14,22,60,.55)'; g.shadowBlur = 20; g.shadowOffsetY = 5; g.fillStyle = '#fff6e6'; g.fillText(ch, pos[i], TY + off); });
    g.restore();
    // 水线 + 破水涟漪
    const wl = ss(seg(t, T.lamp + .05, T.lamp + .35));   // 水线先于第一个字铺开
    g.save(); g.strokeStyle = 'rgba(255,240,220,.55)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(W / 2 - (tot / 2 + 40) * wl, TY + 26); g.lineTo(W / 2 + (tot / 2 + 40) * wl, TY + 26); g.stroke();
    [...TITLE].forEach((ch, i) => { const te = b(TITLE_BEATS[i]), s = t - (te - RISE * .55); if (s < 0 || s > .7) return; const cx = pos[i] + 46;
      g.globalAlpha = (1 - s / .7) * .8; g.beginPath(); g.ellipse(cx, TY + 26, 20 + s * 110, 3 + s * 12, 0, 0, TAU); g.stroke(); });
    g.restore();
    // 副标题 + 六角瓦片图标
    const sa = ss(seg(t, SUB_T, SUB_T + .5));
    if (sa > 0) { g.save(); g.globalAlpha = sa; g.font = '300 30px "Josefin Sans"'; g.fillStyle = 'rgba(255,240,222,.9)'; g.shadowColor = 'rgba(14,22,60,.5)'; g.shadowBlur = 10; g.textBaseline = 'middle';
      const tr = 9, ws = [...SUB].map(ch => g.measureText(ch).width), tot2 = ws.reduce((x, y) => x + y, 0) + tr * (SUB.length - 1); let cx = W / 2 - tot2 / 2 + 22;
      hexIcon(cx - 34, TY + 76, 13, '#ffc676'); [...SUB].forEach((ch, i) => { g.fillText(ch, cx, TY + 80); cx += ws[i] + tr; }); g.restore(); }
  }
}
window.TEXTS = t => {
  const out = []; const t0 = b(TITLE_BEATS[0]) - RISE;
  if (t >= t0) { const { tot } = titleLayout(); out.push({ id: 'title', text: TITLE, x0: W / 2 - tot / 2, y0: TY - 90, x1: W / 2 + tot / 2, y1: TY + 30 }); }
  if (t >= SUB_T) out.push({ id: 'sub', text: SUB, x0: W / 2 - 260, y0: TY + 60, x1: W / 2 + 300, y1: TY + 100 });
  return out;
};

// —— 渲染 ——
function render(t) {
  const sk = skyAt(t);
  cam(t);
  world.S.updateMatrixWorld(true);
  const night = sk.night, amp = 1 + night * .3;
  sea.U.uTime.value = t; sea.U.uAmp.value = amp; sea.U.uDeep.value.copy(sk.deep); sea.U.uShal.value.copy(sk.shal);
  sea.U.uFoam.value.set(night > .5 ? '#9fb0e0' : '#ffffff');
  hemi.color.copy(sk.hs); hemi.groundColor.copy(sk.hg); hemi.intensity = sk.hI;
  const se = sk.el * DEG, sa = sk.az * DEG;
  sun.color.copy(sk.sun); sun.intensity = sk.sunI;
  sun.target.position.set(0, 0, 0); sun.position.set(Math.cos(se) * Math.sin(sa) * 60, Math.sin(se) * 60, Math.cos(se) * Math.cos(sa) * 60);
  post.comp.zen.value.copy(sk.zen); post.comp.hor.value.copy(sk.hor);
  // 星：入夜后极少数先出现，顶灯亮后逐颗布满
  post.comp.stars.value = t < T.lamp ? .12 * ss(seg(t, b(19), T.breath)) : lerp(.12, 1, ss(seg(t, T.lamp + .2, DUR - .6)));
  post.comp.starOff.value = CAM.az / 60; post.comp.time.value = t;
  const gd = post.grade;
  gd.sat.value = lerp(1.05, 1.1, night); gd.contrast.value = lerp(.06, .12, night); gd.lift.value.setRGB(lerp(.018, .012, night), lerp(.016, .016, night), lerp(.024, .045, night));
  gd.vig.value = lerp(.16, .3, night);
  post.bloom.strength = lerp(.22, .55, night);
  { const f = new THREE.Vector3(); camera.getWorldDirection(f); const fl = Math.hypot(f.x, f.z) || 1; sea.U.uFwd.value.set(f.x / fl, f.z / fl); sea.U.uTgt.value.set(CAM.tg[0], CAM.tg[2]); sea.U.uSpanF.value = CAM.fh / Math.tan(CAM.el * DEG) * .5; sea.U.uNight.value = night;
    sea.U.uCam.value.set(-f.x / fl, -f.z / fl); }
  world.update(t, { night, amp });
  const LL = world.LEVEL.lampLevel(t); sea.U.uLamp.value.set(world.lampWorld.x, world.lampWorld.z, 0, Math.min(1, LL) * .9);
  post.composer.render();
  hud(t);
}

// —— 事件（拟音 + 配乐 + 核对）——
function events() {
  const ev = [];
  const E = (t, type, o = {}) => ev.push({ t: +t.toFixed(6), type, ...o });
  E(0, 'amb', { what: 'waves', d: DUR }); E(0, 'amb', { what: 'wind', d: DUR });
  E(T.stop + 1, 'amb', { what: 'crickets', d: DUR - T.stop - 1 });
  E(T.sunHit, 'sunhit'); E(T.turn0, 'turn'); E(T.noon, 'noon'); E(T.stop, 'stop'); E(T.breath, 'breath'); E(T.final, 'final');
  E(T.lamp, 'lamp', { cut: true }); E(T.lamp, 'millstart');
  world.creaks.forEach(c => E(c, 'creak', { night: c > T.stop }));
  // 鸟鸣：鸟在画面里的时段，按拍点附近排列
  [1.25, 1.56, 2.19, 3.44, 4.38, 5.63, 6.88, 8.13].forEach((x, i) => E(x, 'bird', { k: i }));
  world.wins.forEach((w, i) => E(w.t, 'win', { i, note: w.note, beat: WIN_BEATS[i] }));
  STAR_BEATS.forEach((n, i) => E(b(n), 'star', { i, note: STAR_NOTES[i], beat: n }));
  TITLE_BEATS.forEach((n, i) => E(b(n), 'letter', { i, ch: TITLE[i], note: TITLE_NOTES[i], beat: n }));
  E(SUB_T, 'sub'); E(T.lamp + .05, 'waterline');
  ev.push({ t: 0, type: 'meta', bpm: BPM, beat: BEAT, fps: FPS, T });
  return ev.sort((a, c) => a.t - c.t);
}
// 核对用：返回画面状态（不渲染）
window.PROBE = t => {
  const s = t - (T.lamp);
  return { az: turnAz(t), ang: world.angAt(t), wins: world.wins.map(w => world.LEVEL.winLevel(t, w.t)), lamp: world.LEVEL.lampLevel(t), shot: shotAt(t)[2],
    letters: TITLE_BEATS.map(n => letterOff(t, b(n))), stars: STAR_BEATS.map(n => t + EPS >= b(n) ? 1 : 0) };
};
window.render = render; window.DUR = DUR; window.EV = events(); window.DBG = { camera, world, post, scene, sun, hemi, cam };
await document.fonts.load('300 92px "Noto Sans SC"', TITLE); await document.fonts.load('300 30px "Josefin Sans"', SUB);
render(parseFloat(QS.get('t') ?? '6'));
window.READY = true;
