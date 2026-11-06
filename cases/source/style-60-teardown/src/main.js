// 《按一下》render(t)：一切都是 t 的函数，确定性，无随机、无时钟。
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { makePost } from '/core/three/post.js';
import { clamp, lerp, seg, track } from '/core/lib.js';
import { DIMS, AXIS_Y, lathe, crown, springGeometry, clipGeometry, profiles } from './pen.js';
import { drawOverlay, overlayTexts } from './overlay.js';
import * as TL from './timeline.js';

const { T, DUR, UP, UPDUR, LAND, DOWNDUR, GAP, CAM, PARTS } = TL;
const W = 1920, H = 1080;
const Q = new URLSearchParams(location.search);

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(2); renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .95;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.VSMShadowMap;
document.getElementById('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, W / H, .4, 4000);
const post = makePost(renderer, scene, camera, W, H, { ssaa: 2, ao: false });
post.bloom.strength = .22; post.bloom.radius = .45; post.bloom.threshold = 1.7;
post.vig.uniforms.amt.value = .34; post.vig.uniforms.contrast.value = .08; post.vig.uniforms.warm.value = .1;
{
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const g = c.getContext('2d');
  const gr = g.createRadialGradient(960, 470, 60, 960, 540, 1250);
  gr.addColorStop(0, '#36383c'); gr.addColorStop(.45, '#232528'); gr.addColorStop(1, '#0c0d0f');
  g.fillStyle = gr; g.fillRect(0, 0, 1920, 1080);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; scene.background = t;
}
const hdr = await new RGBELoader().loadAsync('/core/assets/polyhaven/photo_studio_loft_hall_2k.hdr');
hdr.mapping = THREE.EquirectangularReflectionMapping;
scene.environment = new THREE.PMREMGenerator(renderer).fromEquirectangular(hdr).texture;
scene.environmentIntensity = .42; scene.environmentRotation = new THREE.Euler(0, 1.2, 0);
RectAreaLightUniformsLib.init();
const key = new THREE.DirectionalLight('#fff1e2', 1.6);
key.castShadow = true; key.shadow.mapSize.set(4096, 4096);
Object.assign(key.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 20, far: 1400 });
key.shadow.bias = -.0004; key.shadow.normalBias = .05; key.shadow.radius = 14; key.shadow.blurSamples = 24;
scene.add(key, key.target);
const rim = new THREE.RectAreaLight('#dfe9ff', 5.0, 300, 60); scene.add(rim);
const top = new THREE.RectAreaLight('#ffffff', .5, 300, 300); scene.add(top);
const gapLight = new THREE.RectAreaLight('#ffe6cc', 0, 14, 14); scene.add(gapLight);   // 缝内的实用补光
scene.add(new THREE.HemisphereLight('#c9d3e0', '#1a1712', .14));

// ---------- materials ----------
const M = {
  shell: new THREE.MeshPhysicalMaterial({ color: '#e7e3da', roughness: .5, clearcoat: .45, clearcoatRoughness: .35, sheen: .2, sheenColor: '#ffffff' }),
  grip: new THREE.MeshPhysicalMaterial({ color: '#4b4f55', roughness: .86, sheen: .3, sheenRoughness: .9, sheenColor: '#9aa0a8' }),
  chrome: new THREE.MeshStandardMaterial({ color: '#d6d9de', roughness: .16, metalness: 1 }),
  steel: new THREE.MeshStandardMaterial({ color: '#c3c7cc', roughness: .3, metalness: 1 }),
  brass: new THREE.MeshStandardMaterial({ color: '#c79f58', roughness: .32, metalness: 1 }),
  dark: new THREE.MeshPhysicalMaterial({ color: '#3a3c40', roughness: .55, clearcoat: .2 }),
  cam: new THREE.MeshPhysicalMaterial({ color: '#ef6a36', roughness: .48, clearcoat: .25, clearcoatRoughness: .4 }),
  pom: new THREE.MeshPhysicalMaterial({ color: '#f0eee8', roughness: .42, clearcoat: .2 }),
};
const sh = m => { m.castShadow = true; m.receiveShadow = true; return m; };
const PR = profiles();
const part = {}; for (const k of PARTS) { part[k] = new THREE.Group(); scene.add(part[k]); }
part.front.add(sh(new THREE.Mesh(lathe(PR.front), M.shell)), sh(new THREE.Mesh(lathe(PR.thread, 96, false), M.shell)), sh(new THREE.Mesh(lathe(PR.grip, 96, false), M.grip)));
part.rear.add(sh(new THREE.Mesh(lathe(PR.rear), M.shell)), sh(new THREE.Mesh(lathe(PR.ring), M.chrome)), sh(new THREE.Mesh(clipGeometry(), M.chrome)));
part.refill.add(sh(new THREE.Mesh(lathe(PR.tube, 48), M.brass)), sh(new THREE.Mesh(lathe(PR.tip, 48), M.steel)), sh(new THREE.Mesh(lathe(PR.collar, 48), M.dark)));
{ const ball = sh(new THREE.Mesh(new THREE.SphereGeometry(DIMS.refill.ball, 24, 16), M.chrome)); ball.position.x = DIMS.refill.x0 + DIMS.refill.ball; part.refill.add(ball); }
const camSpin = new THREE.Group(); part.cam.add(camSpin);
const C = DIMS.cam;
camSpin.add(sh(new THREE.Mesh(lathe(PR.cam, 64), M.cam)), sh(new THREE.Mesh(crown(C.base, C.rIn, C.r, C.teeth, C.toothH, 1, 0), M.cam)));
for (let i = 0; i < 4; i++) {
  const r = new THREE.Mesh(new THREE.BoxGeometry(7, .6, .9), M.cam); const f = i / 4 * Math.PI * 2 + Math.PI / 8;
  r.position.set(C.x0 + .5 + 3.5, (C.r + .2) * Math.cos(f), (C.r + .2) * Math.sin(f)); r.rotation.x = f; camSpin.add(sh(r));
}
const Pl = DIMS.plunger;
part.plunger.add(sh(new THREE.Mesh(lathe(PR.plunger, 64), M.chrome)), sh(new THREE.Mesh(crown(Pl.base, 1.6, 3.1, C.teeth, C.toothH, -1, Math.PI / C.teeth), M.pom)));
let springLen = -1, springMesh = null;
function setSpring(len) {
  const L = Math.round(len * 50) / 50; if (L === springLen) return;
  if (springMesh) { part.spring.remove(springMesh); springMesh.geometry.dispose(); }
  springMesh = sh(new THREE.Mesh(springGeometry(L), M.steel)); part.spring.add(springMesh); springLen = L;
}
for (const k of (Q.get('hide') || '').split(',').filter(Boolean)) (part[k] || {}).visible = false;   // 调试用
const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.ShadowMaterial({ color: '#000000', opacity: .42 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; if (!Q.has('nofloor')) scene.add(floor);

import { mech, camAngle, partState, springLength, FIN } from './motion.js';
const ST = {};
function pose(t) {
  for (const k of PARTS) {
    const s = partState(k, t); ST[k] = s;
    part[k].position.set(s.dx, AXIS_Y + s.dy, 0);
  }
  part.spring.position.x = DIMS.spring.seat + ST.spring.dx;
  setSpring(springLength(t));
  camSpin.rotation.x = camAngle(t); ST.camRot = camSpin.rotation.x;   // 缝内标签的锚点跟着齿转
}
// 世界坐标：零件 k 上的局部点（装配坐标）
const tmp = new THREE.Vector3();
export function worldOf(k, x, y, z) { const p = part[k].position; return new THREE.Vector3(x + p.x, y + p.y, z + p.z); }

// ---------- 镜头 ----------
const camTrack = track(CAM.map(([t, e, g, f]) => [t, [...e, ...g, f]]));
function setCamera(t) {
  const [ex, ey, ez, tx, ty, tz, fov] = camTrack(t);
  camera.position.set(ex, ey, ez); camera.fov = fov; camera.lookAt(tx, ty, tz); camera.updateProjectionMatrix();
  const dist = Math.hypot(ex - tx, ey - ty, ez - tz);
  post.dof.focus = dist; post.dof.aper = 520; post.dof.maxCoc = 14;
  const A = Math.atan2(ex - tx, ez - tz), la = A - .9;
  key.position.set(tx - 260 * Math.sin(la), 420, tz + 260 * Math.cos(la) + 120); key.target.position.set(tx, 0, tz);
  rim.position.set(tx + 220 * Math.sin(A + 2.7), 140, tz + 220 * Math.cos(A + 2.7)); rim.lookAt(tx, 20, tz);
  top.position.set(tx, 380, tz); top.lookAt(tx, 0, tz);
  // 缝内补光：从缝的上方斜照凸轮齿面
  const gi = seg(t, 13.4, 14.0) * (1 - seg(t, 17.0, 17.5));
  gapLight.intensity = 6 * gi;
  const cx = ST.cam ? ST.cam.dx : 0, cy = ST.cam ? ST.cam.dy : 0;
  gapLight.position.set(C.base + cx + 13, AXIS_Y + cy + 9, 6); gapLight.lookAt(C.base + cx, AXIS_Y + cy, 0);
  return dist;
}

// ---------- 声音事件（window.EV） ----------
const EV = [];
EV.push({ t: T.press1, type: 'pressStart', x: 146 }, { t: T.ka1, type: 'ka', x: 146 }, { t: T.da1, type: 'da', x: 0 });
EV.push({ t: T.ka1, type: 'whip' }, { t: T.da1, type: 'pullback' });
for (const k of PARTS) EV.push({ t: UP[k], type: 'lift', part: k, x: (FIN[k] + 75) });
for (const k of PARTS) EV.push({ t: LAND[k], type: 'land', part: k });
T.labels.forEach((t, i) => EV.push({ t, type: 'label', n: i }));
T.dims.forEach((t, i) => EV.push({ t, type: 'dim', n: i }));
EV.push({ t: T.stab, type: 'stab' }, { t: T.hush, type: 'dive' });
T.teeth.forEach((t, i) => EV.push({ t, type: 'tooth', n: i }));
EV.push({ t: T.gapNote, type: 'note' }, { t: T.pull, type: 'pull' });
EV.push({ t: T.press2, type: 'pressStart', x: 146 }, { t: T.ka2, type: 'ka', x: 146 }, { t: T.da2, type: 'da', x: 0, final: true });
EV.push({ t: T.ka2, type: 'whip' });   // 18.5–19.0 镜头急摇追到笔尖（回声开头的横移）
EV.sort((a, b) => a.t - b.t);
window.EV = EV; window.DUR = DUR;

// ---------- frame ----------
await document.fonts.ready;
window.render = t => {
  pose(t);
  // 零件抬离地面越高，地面阴影越软越淡（半影随高度变宽），避免悬浮时的块状硬影
  const lift = ST.cam ? ST.cam.ey : 0;
  key.shadow.radius = 14 + 42 * lift; key.shadow.blurSamples = 24 + Math.round(8 * lift);
  floor.material.opacity = .42 - .1 * lift;
  setCamera(t);
  post.composer.render();
  drawOverlay(t, camera, { worldOf, ST, springLen, W, H });
};
window.TEXTS = () => overlayTexts();
window.DBG = t => { pose(t); const c = camTrack(t); return { cam: c.map(v => +v.toFixed(1)), st: Object.fromEntries(PARTS.map(k => [k, [+ST[k].dx.toFixed(2), +ST[k].dy.toFixed(2)]])), spring: springLen, rot: +(camAngle(t) * 180 / Math.PI).toFixed(1) }; };
window.render(Number(Q.get('t') || 0));
window.READY = true;
