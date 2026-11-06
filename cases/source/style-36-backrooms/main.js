// 《交接录像》—— three.js 场景（720×540，4:3）→ GTAO + 物理景深（对焦搜寻）+ 泛光 → VHS 摄像机通道 → 1920×1080（柱状框）
import * as THREE from 'three';
import { makePost } from '/core/three/post.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { clamp, seg, ss, lerp, hash, vnoise, env } from '/core/lib.js';
import * as TL from './timeline.js';
import { buildWorld, buildProps, updateLights, U, PLATE_YOU } from './world.js';
import { VHS } from './vhs.js';
import { drawOSD } from './osd.js';

const { T, B, bt, DUR, POS, YAW, PITCH, CAMH, FOV, FOCUS, APER, FEAR, HOLD, gait, clock, battery } = TL;
const Q = new URLSearchParams(location.search), RAW = Q.has('raw');
await document.fonts.load("900 40px 'Noto Sans SC'"); await document.fonts.load("500 40px 'Noto Sans SC'");

const W = 1920, H = 1080, SW = 720, SH = 540;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 0.85;
document.getElementById('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0, 0, 0);
const camera = new THREE.PerspectiveCamera(40, 4 / 3, .03, 160); camera.rotation.order = 'YXZ';
const post = makePost(renderer, scene, camera, SW, SH, { ssaa: 1, ao: true, aoRadius: .55, aoThickness: 1.2, aoScale: 1.6, aoAmt: .75 });
post.bloom.strength = .5; post.bloom.radius = .55; post.bloom.threshold = 1.1;
post.vig.uniforms.amt.value = 0; post.vig.uniforms.contrast.value = 0; post.vig.uniforms.sat.value = 1;
post.dof.maxCoc = 14;
const osdCv = document.createElement('canvas'); osdCv.width = SW; osdCv.height = SH;
const osdTex = new THREE.CanvasTexture(osdCv); osdTex.minFilter = osdTex.magFilter = THREE.LinearFilter; osdTex.generateMipmaps = false;
const vhs = new ShaderPass(VHS);
vhs.uniforms.tOSD.value = osdTex; vhs.uniforms.res.value = [W, H]; vhs.uniforms.src.value = [SW, SH];
if (RAW) { const u = vhs.uniforms; u.sharp.value = 0; u.lumaW.value = .3; u.chromaW.value = .01; u.chromaShift.value = 0; u.gain.value = 0; u.jitter.value = 0; u.barrel.value = 0; u.dropout.value = 0; u.smear.value = 0; }
post.composer.addPass(vhs);

const world = buildWorld(scene);
const props = buildProps(scene);

// —— 灯：远处一盏闪（b2）、头顶附近闪（b10）、撕裂后全部重新打火（b16） ——
const blink = (t, a, segs) => segs.some(([s, e]) => t >= a + s && t < a + e);
function gLight(t) {
  if (t >= T.impact && t < T.impact + .6) {          // 齐打火：先过曝的一闪，再两下抖动，然后稳住
    const d = t - T.impact;
    if (d < 2 / 24) return 1.55;
    if (d < 4 / 24) return .35;
    if (d < 6 / 24) return 1.25;
    if (d < 7 / 24) return .6;
    return 1 + .25 * Math.exp(-(d - 7 / 24) / .12);
  }
  return 1;
}
function lightExtra(L, t) {
  let k = 1;
  if (Math.abs(L.x - 0.05) < .3 && Math.abs(L.z + 16.5) < .3 && blink(t, T.flickFar, [[0, .1], [.17, .24], [.3, .34]])) k = .02;
  if (t >= T.flickNear && t < T.flickNear + .3 && Math.abs(L.x) < 3 && Math.abs(L.z - TL.ZN) < 4.5) {
    const d = t - T.flickNear; k = d < .1 ? .03 : d < .16 ? .7 : d < .2 ? .05 : .55 + .45 * seg(d, .2, .3);
  }
  return k;
}
// 红色占用灯：随灯管齐打火一起亮，但它是最后一个稳定的——b16.5、b16.75 各断一次，b17 稳住
function lampK(t) {
  if (t < T.impact) return 0;
  const f = (t - T.impact) * 24;
  if (f < 2) return 1.6; if (f < 4) return 0; if (f < 6) return 1.25; if (f < 7) return .1;
  const o1 = bt(TL.CUE.lampOff[0]), o2 = bt(TL.CUE.lampOff[1]), lk = bt(TL.CUE.lampLock);
  if (t < o1) return .8;
  if (t < o1 + 2 / 24) return 0;
  if (t < o2) return .9;
  if (t < o2 + 2 / 24) return .04;
  if (t < lk) return .55;
  return 1;
}
function nearDark(t) {     // 头顶灯闪的画面整体亮度（供自动曝光的滞后使用）
  const d = t - T.flickNear; if (d < 0 || d > .3) return 0;
  return d < .1 ? .85 : d < .16 ? .2 : d < .2 ? .8 : .3 * (1 - seg(d, .2, .3));
}
function darkMem(t) { let s = 0, w = 0; for (let k = 0; k < 40; k++) { const d = k * .03, e = Math.exp(-d / .45); s += nearDark(t - d) * e; w += e; } return s / w; }

// —— 手持 ——
const nz = (t, f, s) => vnoise(t * f + s * 17.3) - .5;
const doorSec = t => env(t, T.turnD - .2, T.tear + .2, .2, .05);   // 甩镜段：偏航不加噪声，保证门过画心卡在拍上
function camPose(t) {
  const [x, z] = POS(t); let yaw = YAW(t), pitch = PITCH(t), roll = 0;
  const { amp, ph } = gait(t), fear = FEAR(t), hold = HOLD(t), yn = 1 - doorSec(t);
  let y = 1.56 + CAMH(t);
  y += .032 * amp * (Math.abs(Math.sin(ph)) - .6);
  const sway = .018 * amp * Math.sin(ph);
  const br = Math.sin(t * Math.PI * 2 * (.27 + .25 * fear));
  pitch += (nz(t, 1.1, 1) * .014 + nz(t, 3.7, 2) * .005 * (1 + 2 * fear) + nz(t, 9.5, 3) * .0022 * fear + br * .005) * hold;
  yaw += (nz(t, .9, 4) * .016 + nz(t, 3.3, 5) * .005 * (1 + 2 * fear) + .011 * amp * Math.sin(ph)) * hold * yn;
  roll = (nz(t, .6, 6) * .03 + .014 * amp * Math.sin(ph) + nz(t, 7, 7) * .003 * fear) * hold + .01;
  y += br * .005 * hold;
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  return { x: x + rx * sway * hold, y, z: z + rz * sway * hold, yaw, pitch, roll };
}

// —— 画面 ——
function render(t) {
  const frozen = t >= T.tear && t < T.impact;
  const tv = frozen ? T.tear : t;
  const cp = camPose(tv);
  camera.position.set(cp.x, cp.y, cp.z); camera.rotation.set(cp.pitch, cp.yaw, cp.roll);
  const hf = FOV(tv) * Math.PI / 180; camera.fov = 2 * Math.atan(Math.tan(hf / 2) / (4 / 3)) * 180 / Math.PI; camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const g = gLight(tv);
  updateLights(tv, g, lightExtra);
  const lk = lampK(tv);
  props.lamp.material.uniforms.emit.value = 20.0 * lk;                       // 远过泛光阈值（纯红亮度低，必须推得很高）
  props.halo.material.color.setRGB(1.0, .07, .03).multiplyScalar(.55 * lk);  // 墙面上的红晕
  U.uExitI.value = 1.05 * lk;
  U.uFogG.value = .35 + .65 * Math.min(g, 1.2);
  scene.background.copy(U.uFogCol.value).multiplyScalar(U.uFogG.value * .15);
  world.trofMat.uniforms.uEmit.value = 5.0;
  post.dof.focus = FOCUS(tv); post.dof.aper = APER(tv);
  // VHS
  const u = vhs.uniforms, dm = darkMem(tv);
  u.frame.value = Math.floor(t * 30);            // 磁带噪声按 30 fps 走
  const awb = ss(seg(t, 0, 1.6));
  const awb2 = t >= T.impact ? Math.exp(-(t - T.impact) / .9) : 0;   // 换了地方，白平衡重新找
  u.tint.value = [lerp(.8, 1.0, awb) * (1 + .05 * awb2), lerp(.93, 1.0, awb), lerp(1.4, .95, awb) * (1 + .04 * Math.sin(t * .31)) * (1 - .12 * awb2)];
  const over = t >= T.impact ? .55 * Math.exp(-(t - T.impact) / .45) : 0;   // 自动曝光滞后：灯全亮时先过曝
  u.expo.value = (1 + .45 * dm + over) * (0.97 + .03 * Math.sin(t * .47));
  u.gain.value = .032 + .08 * dm + .025 * seg(FOV(tv), 52, 26) + .012 * FEAR(tv);
  let track = 0, roll = 0;
  if (t < .5) { const k = 1 - seg(t, 0, .5); track = k; roll = k * k * .35; }
  if (frozen) { track = 1; roll = (hash(Math.floor(t * 30) * .7) - .5) * .1; }
  if (t >= T.impact && t < T.impact + .12) track = Math.max(track, .55 * (1 - seg(t, T.impact, T.impact + .12)));
  if (t >= T.reset && t < T.reset + 3 / 24) { track = Math.max(track, .6); roll = .015; }
  u.track.value = track; u.roll.value = roll; u.off.value = 0;
  drawOSD(osdCv, {
    hide: false, t, rec: !(t >= T.reset && t < T.reset + .25 && Math.floor(t * 16) % 2),
    clock: clock(t), date: 'OCT.31.1996', bat: battery(t), batBlink: false,
  });
  osdTex.needsUpdate = true;
  U.uTime.value = t;
  post.composer.render();
}

// —— 事件 → events.json（拟音、配乐全部从这里取时间） ——
const EV = [];
const add = (type, beat, o = {}) => EV.push({ t: bt(beat), beat, type, ...o });
const C = TL.CUE;
add('recOn', C.recOn); add('af', C.afLock0, { v: .8 }); add('rustle', C.pan[0], { v: .5, d: 2.4 });
C.chime.forEach((b, i) => add('chime', b, { n: i, flat: 0 }));
add('flick', C.flickFar, { far: 1 });
C.steps.forEach((b, i) => add('step', b, { v: .7 + .1 * (i % 2) }));
add('afSlip', C.afSlip); C.afHunt.forEach(b => add('af', b, { v: .7 })); add('af', C.afLock1, { v: 1 });
add('rustle', C.turnN[0], { v: .8, d: .8 }); add('af', C.turnN[1], { v: 1 });
add('holdBreath', C.hold[0], { d: bt(C.hold[1]) - bt(C.hold[0]) });
add('flick', C.flickNear, { far: 0 });
add('rustle', C.turnD, { v: 1, d: .8 });
C.doors.forEach((b, i) => add('door', b, { n: i }));
add('tear', C.tear, { d: bt(C.impact) - bt(C.tear) });
add('impact', C.impact); add('restrike', C.impact);
C.lampOff.forEach((b, i) => add('lamp', b, { n: i, lock: 0 })); add('lamp', C.lampLock, { n: 2, lock: 1 });
add('zoom', C.zoom[0], { d: bt(C.zoom[1]) - bt(C.zoom[0]) });
add('af', C.afBlur, { v: .7 }); add('af', C.afOver, { v: .7 }); add('af', C.afLock2, { v: 1 });
add('reset', C.reset);
C.chimeFlat.forEach((b, i) => add('chime', b, { n: i, flat: 1 }));
add('end', C.end);
EV.sort((a, b) => a.t - b.t);

// —— 画面实测的视觉事件（拍点核对用）：直接从机位/对焦/磁带函数里量出来，不抄 CUE ——
function visCheck() {
  const out = [], dt = 1 / 48000;
  const find = (a, b, f) => { for (let t = a; t <= b; t += dt) if (f(t)) return t; return null; };
  // 脚落地：手持颠簸的最低点
  for (const b of C.steps) {
    let best = null, bv = 1e9;
    for (let t = bt(b) - .3; t <= bt(b) + .3; t += dt) { const { amp, ph } = gait(t); const v = amp * Math.abs(Math.sin(ph)); if (amp > .05 && v < bv) { bv = v; best = t; } }
    out.push({ what: '脚落地', beat: b, t: best });
  }
  // 门过画心：机位偏航（含手持）穿过该门方向
  C.doors.forEach((b, i) => {
    const target = TL.DOOR_YAW[i];
    const t = find(bt(b) - .25, bt(b) + .25, s => camPose(s).yaw <= target);
    out.push({ what: `第${i + 1}扇门过画心`, beat: b, t });
  });
  // 告示落定：偏航到达 π/2 且手持冻结
  out.push({ what: '告示落定', beat: C.turnN[1], t: find(bt(8.5), bt(9.5), s => YAW(s) >= Math.PI / 2 - 1e-9) });
  // 对焦锁定：对焦距离的局部极值/到达目标
  const lockAt = (b, f) => out.push({ what: '对焦锁定', beat: b, t: find(bt(b) - .3, bt(b) + .3, s => Math.abs(FOCUS(s) - f) < 1e-7) });
  lockAt(C.afLock0, .84); lockAt(C.afLock1, 7); lockAt(C.afLock2, 7.9);
  out.push({ what: '磁带撕裂（画面冻结）', beat: C.tear, t: find(bt(14), bt(15), s => s >= T.tear) });
  out.push({ what: '画面恢复/灯齐亮', beat: C.impact, t: find(bt(15.5), bt(16.5), s => gLight(s) > 1.5) });
  C.lampOff.forEach(b => out.push({ what: '红灯断火', beat: b, t: find(bt(b) - .08, bt(b) + .1, s => lampK(s) < .05) }));
  out.push({ what: '红灯稳定（最后一个）', beat: C.lampLock, t: find(bt(C.lampLock) - .08, bt(C.lampLock) + .1, s => lampK(s) === 1) });
  out.push({ what: '时间码归零', beat: C.reset, t: find(bt(19.5), bt(20.5), s => clock(s) === '00:00:00') });
  out.push({ what: '头顶灯闪', beat: C.flickNear, t: find(bt(9.5), bt(10.5), s => lightExtra({ x: .05, z: TL.ZN }, s) < .1) });
  out.push({ what: '远处灯闪', beat: C.flickFar, t: find(bt(C.flickFar) - .5, bt(C.flickFar) + .5, s => lightExtra({ x: .05, z: -16.5 }, s) < .1) });
  return out;
}

window.TEXTS = t => {
  const r = [];
  r.push({ id: 'rec', text: 'REC', x0: 300, y0: 70, x1: 520, y1: 160 });
  r.push({ id: 'date', text: 'OCT.31.1996', x0: 1300, y0: 900, x1: 1620, y1: 1000 });
  // 告示与门牌：用世界坐标投影求屏幕框（4:3 区域在 x∈[240,1680]）
  const proj = (p) => { const v = new THREE.Vector3(...p).project(camera); return [240 + (v.x * .5 + .5) * 1440, (1 - (v.y * .5 + .5)) * 1080, v.z]; };
  const box = (id, text, pts) => {
    const ps = pts.map(proj); if (ps.some(p => p[2] > 1 || p[2] < -1)) return;
    const xs = ps.map(p => p[0]), ys = ps.map(p => p[1]);
    if (Math.max(...ys) - Math.min(...ys) < 90 || Math.max(...xs) - Math.min(...xs) < 90) return;   // 太小或斜到读不出的字不算可读文字（走廊远景里斜看的告示）
    r.push({ id, text, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  };
  const frozen = t >= T.tear && t < T.impact, tv = frozen ? T.tear : t;
  const cp = camPose(tv); camera.position.set(cp.x, cp.y, cp.z); camera.rotation.set(cp.pitch, cp.yaw, cp.roll);
  const hf = FOV(tv) * Math.PI / 180; camera.fov = 2 * Math.atan(Math.tan(hf / 2) / (4 / 3)) * 180 / Math.PI; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  if (frozen) return r;   // 撕裂中不可读
  const nx = TL.NOTICE.x + .082, ny = TL.NOTICE.y, nzz = TL.NOTICE.z;
  // 告示正文「不要数门」区块（纸面上 y 从 +0.08 到 -0.11，横向 ±0.15）
  if (t < T.impact) box('notice', '不要数门', [[nx, ny + .13, nzz - .02], [nx, ny + .13, nzz + .16], [nx, ny - .055, nzz - .02], [nx, ny - .055, nzz + .16]]);
  if (t >= T.impact) { const dx = TL.ENDDOOR.x, dz = TL.ENDDOOR.z + .12; const p = PLATE_YOU / 2; box('plate', '你', [[dx - p, 1.56 + p, dz], [dx + p, 1.56 + p, dz], [dx - p, 1.56 - p, dz], [dx + p, 1.56 - p, dz]]); }
  return r.filter(b => b.x0 >= 240 && b.x1 <= 1680 && b.y0 >= 0 && b.y1 <= 1080);
};

window.DUR = DUR; window.EV = EV; window.render = render; window.VIS = visCheck;
window.dbg = { camera, scene, post, vhs, U, props, camPose, TL };
render(0);
window.READY = true;
