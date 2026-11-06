// 《纸龙》主程序：场景 + 编排 + 机位 + 声音事件 + window.render(t)（确定性）
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp, lerp, seg, ss, eio, eo, ei, back, TAU, mulberry, track, spring } from './lib.js';
import * as A from './art.js';
import { cv } from './paper.js';
import { makeBook, coverCanvases, texOf, BW, BD, PG } from './book.js';
import { buildSets, updatePops, rise } from './sets.js';
import { cutMesh, particles } from './cutmesh.js';
import { makeDragon, makePath, orient, card } from './dragon.js';
import { makePost } from './post.js';
import { SECS, DUR, T, B, CUTS, FPS } from './timeline.js';

const W = innerWidth || 1920, H = innerHeight || 1080;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setSize(W, H); renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(30, W / H, .004, 30);
const post = makePost(renderer, scene, cam, W, H);

// ---------- 素材 ----------
await document.fonts.load('900 40px "Noto Serif SC"', '纸龙');
await document.fonts.load('400 40px "ZCOOL KuaiLe"', '龙城纸拉');
if (!document.fonts.check('400 40px "ZCOOL KuaiLe"', '龙城')) throw new Error('ZCOOL KuaiLe 未加载');
const AS = '/core/assets/polyhaven/';
const hdr = await new RGBELoader().loadAsync(AS + 'lythwood_lounge_2k.hdr'); hdr.mapping = THREE.EquirectangularReflectionMapping;
scene.environment = hdr; scene.background = hdr; scene.backgroundBlurriness = .25;
const YAW = parseFloat(new URLSearchParams(location.search).get('yaw') || '4.2');
scene.backgroundRotation.set(0, YAW, 0); scene.environmentRotation.set(0, YAW, 0);
const tl = new THREE.TextureLoader();
const wt = n => { const t = tl.load(AS + `walnut_${n}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2.2, 1.4); t.anisotropy = 12; return t; };
const wdiff = wt('diff'); wdiff.colorSpace = THREE.SRGBColorSpace;
const desk = new THREE.Mesh(new THREE.BoxGeometry(2.6, .04, 1.7), new THREE.MeshStandardMaterial({ map: wdiff, normalMap: wt('nor'), roughnessMap: wt('rough'), color: '#c9a88a', envMapIntensity: .8 }));
desk.position.set(0, -.02, .25); desk.receiveShadow = true; scene.add(desk);
const gl = new GLTFLoader();
async function prop(name, x, z, s, ry) { const m = (await gl.loadAsync(AS + `${name}/${name}.gltf`)).scene; m.position.set(x, 0, z); m.scale.setScalar(s); m.rotation.y = ry; m.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; }); scene.add(m); return m; }
const lamp = await prop('desk_lamp_arm_01', -.347, .51, .55, -.76);
lamp.traverse(o => { if (o.isMesh && o.material.name.includes('light')) { o.material = o.material.clone(); o.material.emissive = new THREE.Color('#ffd9a0'); o.material.emissiveIntensity = 6; } });
const tea = await prop('tea_set_01', 0, 0, 1, 0);
{ const keep = { tea_set_01_cup_small_01: [.36, .46, 2.2], tea_set_01_saucer_circular_04: [.36, .46, 0] }, dead = [];
  tea.traverse(o => { if (!o.name.startsWith('tea_set_01_')) return; const k = keep[o.name]; if (!k) { if (o.isMesh) dead.push(o); } else { o.position.x = k[0]; o.position.z = k[1]; o.rotation.y = k[2]; } });
  dead.forEach(o => o.parent && o.parent.remove(o));
  tea.traverse(o => { if (o.name === 'tea_set_01_cup_small_01') o.position.y += .012; }); }
{ // 铅笔（程序建模）
  const g = new THREE.Group(), M = (c, r = .6, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(.0038, .0038, .15, 6), M('#d8423a', .5)), wood = new THREE.Mesh(new THREE.CylinderGeometry(.0038, .0008, .018, 6), M('#e8c79a', .8));
  const lead = new THREE.Mesh(new THREE.CylinderGeometry(.0008, .0001, .004, 6), M('#333', .4)), ferr = new THREE.Mesh(new THREE.CylinderGeometry(.004, .004, .012, 12), M('#c9b46a', .3, 1));
  wood.position.y = .084; lead.position.y = .095; ferr.position.y = -.081; g.add(body, wood, lead, ferr); g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  g.rotation.set(0, -.4, Math.PI / 2); g.position.set(.3, .0038, .38); scene.add(g);
}

// ---------- 书 ----------
const iconC = cv(A.DH_W, A.DH_H); A.drawDragonHead(iconC.getContext('2d'), { look: [.4, .1] });
const cover = coverCanvases((x, px, py, w, h) => x.drawImage(iconC, px - w * .02, py - h * .12, w * 1.05, h * 1.12));
const book = makeBook(cover); scene.add(book.root);
const P = A.pages(), PT = {}; for (const k in P) PT[k] = texOf(P[k]);
const { L: POPS, ex: EX } = buildSets(book);
const S = book.stage;

// ---------- 纸龙 ----------
const dragon = makeDragon(.042); S.add(dragon.root);
const G = .0; // 页缝位置
// 盘旋收尾停在页面自由边前方（z > BD），身体留在页外，翻页时不会穿过纸页
const HEAD = [
  [5.0, [.19, -.42, .006]], [T.rustle, [.19, -.075, .006]], [T.headOut, [.19, -.012, .007]],
  [T.emerge, [.17, .1, .034]], [8.9, [.05, .2, .03]], [9.4, [-.14, .17, .05]], [9.9, [-.23, .1, .2]], [10.4, [-.14, .048, .318]],
  [T.stop, [-.04, .032, .316]], [T.blink, [-.04, .032, .316]], [T.blink + .05, [-.04, .032, .316]],
];
// ---- 叼页角：咬合点 G(t)（stage 坐标）。11.42–11.68 页缘一小块卷起迎上龙嘴，11.7 合嘴咬住，12.0 起整页随咬合点翻起 ----
const LEAF_A = T.turn, LEAF_B = T.leafDown;
const XG = .004, E0 = new THREE.Vector3(XG, .0009, BD - .002), GG = new THREE.Vector3(XG, .021, BD + .003), TN0 = new THREE.Vector3(1, -.15, 0).normalize();
function leafU(t) { const x = seg(t, LEAF_A, LEAF_B); return 1 - Math.pow(1 - x, 1.8); }   // 12.0 猛地一扯（与全片最重要的那一声同拍），落页前减速
const TONGUE_A = T.blink + .02, TONGUE_B = T.grab - .02;
function gHold(t) { return GG.clone().add(new THREE.Vector3(0, .009, .002).multiplyScalar(ss(seg(t, T.grab + .05, LEAF_A)))); }
const G0 = gHold(LEAF_A), D0 = G0.clone().sub(E0);
function grabPoint(t, out = new THREE.Vector3()) {
  if (t < LEAF_A) { if (t < T.grab) return out.copy(E0).lerp(GG, ss(seg(t, TONGUE_A, TONGUE_B))); return out.copy(gHold(t)); }
  const u = leafU(t), e = book.leafEdge(u), k = Math.pow(1 - u, 2);
  return out.set(XG + D0.x * k, e[0] + D0.y * k, e[1] + D0.z * k);
}
// 页缘被拎起的位移（setLeaf 的 pinch）
function pinchAt(t) {
  if (t < TONGUE_A || t >= LEAF_B) return null;
  const g = grabPoint(t), u = t < LEAF_A ? 0 : leafU(t), e = book.leafEdge(u);
  return { xg: XG, d: [g.x - XG, g.y - e[0], g.z - e[1]] };
}
// 叼着页走时头的朝向：先朝 +x（侧脸对特写镜头），12.0 起转向咬合点的运动方向（侧机位里是侧影）
const gA = new THREE.Vector3(), gB = new THREE.Vector3();
function holdDir(t, out = new THREE.Vector3()) {
  const b = ss(seg(t, LEAF_A, LEAF_A + .14));
  if (b <= 0) return out.copy(TN0);
  grabPoint(Math.min(t + .03, LEAF_B), gA); grabPoint(Math.max(t - .03, LEAF_A), gB);
  const d = gA.sub(gB); if (d.lengthSq() < 1e-10) d.set(0, 1, 0); d.normalize();
  return out.copy(TN0).lerp(d, b).normalize();
}
const MOUTH = .04;
for (let i = 0; ; i++) {
  let tt = T.grab - .02 + i / 60; if (tt > LEAF_B - 1e-4) tt = LEAF_B;
  const g = grabPoint(Math.max(tt, T.grab)), d = holdDir(tt);
  HEAD.push([tt, [g.x - d.x * MOUTH, g.y - d.y * MOUTH, g.z - d.z * MOUTH]]); if (tt === LEAF_B) break;
}
// 之后俯冲到夜色城堡上空；收尾钻回页缝
const PERCH = [.0, .145, .11];
HEAD.push([13.6, [-.17, .21, .06]], [13.95, [-.11, .155, .105]], [T.fw1, PERCH], [T.fold, PERCH], [17.2, [.09, .08, .06]], [T.dive, [.115, -.03, .006]], [T.shut, [.115, -.42, .006]], [DUR, [.115, -.5, .006]]);
const HP = makePath(HEAD, 5.0, DUR);
const headV = new THREE.Vector3(), tA = new THREE.Vector3(), tB = new THREE.Vector3();
function tangentAt(s, out) { HP.at(s + .004, tA); HP.at(s - .004, tB); out.copy(tA).sub(tB); if (out.lengthSq() < 1e-10) out.set(1, 0, 0); return out.normalize(); }
function breath(t) { let m = 0; for (const k of [T.fw1, T.fw2, T.fw3, T.fw4]) m = Math.max(m, seg(t, k - .12, k) * (1 - seg(t, k + .1, k + .4))); return m; }
function dragonPose(t) {
  let blink = 0; const bk = (a) => Math.max(0, 1 - Math.abs(t - a) / .08);
  blink = Math.max(bk(T.blink), bk(9.2), bk(15.3));
  const look = t > T.stop - .2 && t < T.blink + .06 ? [ss(seg(t, T.stop - .2, T.stop + .2)) * -.6, .1] : t >= T.blink + .06 && t < LEAF_B ? [.55, .5] : (t > T.fw1 - .5 && t < T.fold ? [.5, -.7] : [.6, 0]);
  const bite = t < TONGUE_A ? 0 : t < T.grab - .03 ? .62 * ss(seg(t, TONGUE_A, TONGUE_A + .12)) : t < LEAF_B ? .62 * (1 - ss(seg(t, T.grab - .03, T.grab))) + .06 : .5 * Math.sin(Math.PI * seg(t, LEAF_B, LEAF_B + .3));
  const mouth = Math.max(breath(t), bite, t > T.emerge - .2 && t < T.emerge + .3 ? .7 * Math.sin(seg(t, T.emerge - .2, T.emerge + .3) * Math.PI) : 0);
  return { blink, look, mouth };
}

// ---------- 烟花 ----------
const FW = [
  { t: T.fw1, b: T.bw1, p: [.12, .23, .06], r: .062, cols: ['#ff5a4a', '#ffcf3f'], sd: 1 },
  { t: T.fw2, b: T.bw2, p: [-.02, .27, .045], r: .062, cols: ['#7fe0c0', '#ff8fc8'], sd: 2 },
  { t: T.fw3, b: T.bw3, p: [.17, .275, .035], r: .066, cols: ['#ffcf3f', '#ffffff', '#5ac8ff'], sd: 3 },
  { t: T.fw4, b: T.bw4, p: [.07, .235, .085], r: .1, cols: ['#ff5a4a', '#ffcf3f', '#7fe0c0', '#ff8fc8'], sd: 4 },
];
for (const f of FW) { f.g = new THREE.Group(); f.g.add(cutMesh(A.burst(f.r, f.cols, f.sd, f.r > .06 ? 18 : 14), { shadow: true })); S.add(f.g); f.g.visible = false;
  f.rk = new THREE.Group(); f.rk.add(cutMesh(A.sparkCard(.006, f.cols[0]))); S.add(f.rk); f.rk.visible = false; }
const fwFrom = new THREE.Vector3(...PERCH).add(new THREE.Vector3(.03, .03, 0));
function fwState(f, t) {
  const fly = seg(t, f.t, f.b), k = (t - f.b);
  const from = fwFrom, to = new THREE.Vector3(...f.p);
  const rk = { vis: t >= f.t && t < f.b, pos: from.clone().lerp(to, eo(fly)).add(new THREE.Vector3(0, Math.sin(fly * Math.PI) * .02, 0)) };
  const sc = back(seg(k, 0, .32), 1.6), fall = Math.max(0, k - .45);
  const bs = { vis: k >= 0 && k < 1.0, s: Math.max(.001, sc * (1 - ss(seg(k, .55, 1.0)))), pos: to.clone().add(new THREE.Vector3(Math.sin(fall * 4) * .006, -fall * fall * .07, 0)), rz: k * .5 + Math.sin(fall * 5) * .25 * seg(k, .5, 1), rx: Math.sin(fall * 3.3) * .5 * seg(k, .5, 1.2) };
  return { rk, bs };
}

// ---------- 灯光 ----------
const lampHead = new THREE.Vector3(-.28, .375, .44);
const spot = new THREE.SpotLight('#fff0dc', 0, 3, .75, .55, 2); spot.position.copy(lampHead); spot.target.position.set(.02, 0, .15);
spot.castShadow = true; spot.shadow.mapSize.set(4096, 4096); spot.shadow.bias = -.00006; spot.shadow.normalBias = .0004; spot.shadow.radius = 5; spot.shadow.camera.near = .05; spot.shadow.camera.far = 2;
scene.add(spot, spot.target);
const bulb = new THREE.PointLight('#ffcf94', 0, .6, 2); bulb.position.copy(lampHead).add(new THREE.Vector3(0, -.02, 0)); scene.add(bulb);
const sun = new THREE.DirectionalLight('#fff3e0', 0); sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -.00008; sun.shadow.normalBias = .0003; sun.shadow.radius = 4;
Object.assign(sun.shadow.camera, { left: -.3, right: .3, top: .3, bottom: -.3, near: .1, far: 3 }); sun.target.position.set(0, .05, .12); scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight('#cfe6ff', '#caa27a', 0); scene.add(hemi);
function lightsAt(t) {
  const open = seg(t, .6, 2.4) * (1 - seg(t, T.fold, T.shut));
  const night = ss(seg(t, T.turn + .4, T.leafDown + .2));
  return {
    sunI: open * (2.4 - night * 1.95), sunCol: new THREE.Color('#fff3e0').lerp(new THREE.Color('#8fa6ff'), night),
    lampI: 1.0 - open * .55 + night * .05, hemiI: .15 + open * (.5 - night * .3), envI: .42 - open * (.06 + night * .16), night: night * (1 - seg(t, T.fold, T.shut)),
  };
}

// ---------- 粒子：彩纸屑 + 光点 ----------
function spriteTex(fn, n = 64) { const c = cv(n, n), x = c.getContext('2d'); fn(x, n); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }
const glowTex = spriteTex((x, n) => { const g = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.3, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, n, n); });
const quad = new THREE.PlaneGeometry(1, 1), camQ = new THREE.Quaternion();
const addMat = (map, col) => new THREE.MeshBasicMaterial({ map, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
function billboard(fn) { return (i, t) => { const p = fn(i, t); if (p) { const e = new THREE.Euler().setFromQuaternion(camQ); p.rx = e.x; p.ry = e.y; p.rz = e.z; } return p; }; }
const PS = [];
// 台灯光束里的尘埃（世界坐标）
PS.push(particles(quad, addMat(glowTex, new THREE.Color(1.1, .95, .7)), 70, billboard((i, t) => {
  const R = mulberry(i * 7 + 1), u = R(), v = R(), w = R(), sp = .004 + R() * .006;
  return { x: lerp(-.34, .1, u) + Math.sin(t * .3 + i) * .02, y: .02 + ((v * .38 + t * sp) % .38), z: lerp(.1, .6, w) + Math.cos(t * .23 + i) * .02, s: (.0014 + R() * .002) * (.5 + .5 * Math.sin(t * 1.3 + i * 2)) * (1 - seg(t, T.turn, T.turn + 1) * .6) };
})));
scene.add(PS[0]);
// 烟花：彩纸屑（stage 坐标）
const confCols = ['#ff5a5a', '#ffd23f', '#5ac8ff', '#7ee07a', '#ff8fd0', '#ffffff'];
const conf = particles(new THREE.PlaneGeometry(.0028, .0018), new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: .8, emissive: new THREE.Color(.25, .25, .25) }), 200, (i, t) => {
  const f = FW[i % 4], R = mulberry(i * 11 + 2), k = t - f.b, life = 1.1 + R() * .7; if (k < 0 || k > life) return null;
  if (t > T.shut - .35) return null; const a = R() * TAU, sp = (.05 + R() * .07) * (f.r / .045), vx = Math.cos(a) * sp, vy = Math.sin(a) * sp + .02, g = .14, tt = k, dr = Math.exp(-tt * 2.2);
  return { x: f.p[0] + vx * (1 - dr) / 2.2 + Math.sin(tt * 6 + i) * .004, y: f.p[1] + vy * (1 - dr) / 2.2 - g * tt * tt * .5, z: f.p[2] + (R() - .5) * .02, rx: tt * 9 + i, ry: tt * 7, rz: tt * 5, s: 1, col: new THREE.Color(confCols[i % confCols.length]) };
});
conf.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(200 * 3).fill(1), 3); S.add(conf); PS.push(conf);
const sparks = particles(quad, addMat(glowTex, new THREE.Color(1.6, 1.3, .7)), 80, billboard((i, t) => {
  const f = FW[i % 4], R = mulberry(i * 5 + 3), k = t - f.b - R() * .25; if (k < 0 || k > .6) return null;
  const a = R() * TAU, r = f.r * (.6 + R() * .7) * eo(k / .6);
  return { x: f.p[0] + Math.cos(a) * r, y: f.p[1] + Math.sin(a) * r, z: f.p[2] + .004, s: .012 * Math.sin(k / .6 * Math.PI) * (.5 + R()) };
}));
S.add(sparks); PS.push(sparks);
// 火箭拖尾
const trail = particles(quad, addMat(glowTex, new THREE.Color(2.2, 1.6, .7)), 48, billboard((i, t) => {
  const f = FW[i % 4], j = (i / 4) | 0, tt = t - j * .022; if (tt < f.t || tt > f.b) return null;
  const p = fwState(f, tt).rk.pos; return { x: p.x, y: p.y, z: p.z, s: .007 * (1 - j / 12) * (1 - seg(t, f.b, f.b + .1)) };
}));
S.add(trail); PS.push(trail);
// 翻页 / 合书带起的纸屑气流
const puff = particles(new THREE.PlaneGeometry(.003, .002), new THREE.MeshStandardMaterial({ color: '#f3ead6', side: THREE.DoubleSide, roughness: .9 }), 30, (i, t) => {
  const R = mulberry(i * 3 + 9), k = t - T.shut; if (k < 0 || k > 1.2) return null;
  return { x: lerp(-.2, .24, R()), y: PG * 2 + k * (.03 + R() * .03) - k * k * .03, z: lerp(-.02, .3, R()) + (R() - .5) * k * .05, rx: k * 8 + i, ry: k * 6, rz: k * 3, s: 1 - seg(k, .8, 1.2) };
});
scene.add(puff); PS.push(puff);

// 合书后露出的龙尾尖（世界坐标）
const tailTip = new THREE.Group(); { const it = A.dragonTail(.03, .014), m = card(it.c, it.h, it.ax, it.ay).mesh; m.rotation.y = Math.PI; tailTip.add(m); } scene.add(tailTip);

// ---------- 机位 ----------
// [t, px,py,pz, tx,ty,tz, fov, aper]（世界坐标；stage y + PG = 世界 y）
const SH = [
  [[0.0, .3, .42, .92, .0, .03, .14, 32, 3.0], [1.2, .2, .32, .78, .0, .05, .12, 32, 2.8], [CUTS[1], .1, .23, .64, .0, .07, .1, 30, 2.6]],
  [[CUTS[1], .085, .17, .53, .02, .05, .16, 32, 2.4], [CUTS[2], .075, .158, .5, .02, .05, .16, 32, 2.4]],
  [[CUTS[2], -.15, .042, .31, -.09, .045, .19, 30, 2.3], [CUTS[3], .02, .042, .33, .08, .045, .19, 30, 2.3]],
  [[CUTS[3], .25, .035, .27, .17, .055, .02, 34, 2.6], [T.emerge, .27, .065, .36, .12, .1, .04, 36, 2.8], [9.4, .12, .2, .58, .0, .12, .1, 36, 3.2], [CUTS[4], -.1, .15, .56, -.04, .08, .2, 34, 3.0]],
  [[CUTS[4], .045, .062, .47, -.014, .05, .316, 30, 2.4], [T.blink, .04, .064, .44, -.012, .047, .316, 30, 2.4], [T.grab, .034, .068, .415, -.004, .034, .312, 30, 2.4], [CUTS[5], .032, .068, .41, -.002, .036, .312, 30, 2.4]],
  [[CUTS[5], .4, .12, .34, .0, .075, .21, 34, 2.4], [12.6, .5, .22, .52, .0, .13, .15, 36, 2.6], [T.leafDown, .34, .3, .8, .0, .15, .1, 36, 2.8], [CUTS[6], .1, .27, .8, -.02, .17, .08, 36, 2.8]],
  [[CUTS[6], .05, .1, .4, .04, .19, .07, 36, 2.8], [CUTS[7], .06, .17, .58, .04, .2, .06, 36, 3.2]],
  [[CUTS[7], .05, .25, .7, .0, .1, .12, 34, 3.2], [T.dive, .22, .17, .4, .13, .09, .04, 32, 3.0], [CUTS[8], .31, .25, .55, .12, .04, .07, 32, 3.0]],
  [[CUTS[8], .37, .1, -.2, .13, .014, .01, 30, 3.0], [DUR, .33, .085, -.16, .13, .014, .01, 30, 3.0]],
];
const SHOTS = SH.map(keys => ({ t0: keys[0][0], f: track(keys.map(k => [k[0], k.slice(1)])) }));
function camAt(t) { let s = SHOTS[0]; for (const X of SHOTS) if (t >= X.t0) s = X; const v = s.f(t); return { pos: new THREE.Vector3(v[0], v[1], v[2]), tgt: new THREE.Vector3(v[3], v[4], v[5]), fov: v[6], aper: v[7] }; }
// S3 横移：离镜头太近的前景小花整镜不出现（否则虚化成一大块，盖住士兵）
const S3_HIDE = [];
for (const r of EX.flowers.concat([EX.bushL])) {
  let dmin = 9; const p = new THREE.Vector3(r.g.position.x, PG + .012, r.g.position.z);
  for (let t = CUTS[2]; t <= CUTS[3]; t += .05) dmin = Math.min(dmin, camAt(t).pos.distanceTo(p));
  if (dmin < .1) S3_HIDE.push(r);
}

// ---------- 声音事件（mix.py 读 events.json） ----------
const EV = [];
const ev = (t, type, o = {}) => EV.push({ t, type, ...o });
ev(T.creak, 'creak'); ev(T.coverUp, 'swish'); ev(T.popHills, 'pop', { p: .8 }); ev(T.popTowers, 'pop', { p: 1 }); ev(T.popKeep, 'popbig');
ev(T.popWall, 'pop', { p: 1.15 }); ev(T.popFront, 'pop', { p: 1.3 }); ev(T.popFront + .15, 'pop', { p: 1.45 }); ev(T.popFront + .3, 'pop', { p: 1.6 });
ev(T.flags, 'flutter'); ev(T.tab, 'tab'); ev(B('castle', 2.25), 'chain', { d: T.bridgeLand - B('castle', 2.25) - .1 }); ev(T.bridgeLand, 'thump');
for (let b = 5; b < 16; b++) { const t = B('castle', b); if (t >= T.stop) break; ev(t, 'tap', { g: t < CUTS[3] ? 1 : .45 }); }
ev(B('castle', 7.5), 'rustle', { d: 1.2 }); ev(T.headOut, 'crease'); ev(T.emerge, 'swoosh');
for (let b = 2.5; b < 6; b += .5) ev(B('dragon', b), 'flap');
ev(T.stop, 'settle'); ev(T.blink, 'tick'); ev(T.grab, 'nibble');
ev(T.turn, 'page'); ev(T.nightHills, 'pop', { p: .75 }); ev(T.leafDown, 'leafland'); ev(T.leafDown, 'popbig', { g: .7 }); ev(T.nightFront, 'pop', { p: 1.2 }); ev(T.moon, 'moon');
for (const k of [1, 2, 3, 4]) { ev(T['fw' + k], 'launch', { k }); ev(T['bw' + k], 'burst', { k, big: k === 4 }); }
ev(T.fold, 'fold'); ev(B('close', 1 / 3), 'fold', { g: .7 }); ev(T.dive, 'dive'); ev(B('close', 4 / 3), 'swish', { g: .8 }); ev(T.shut, 'close'); ev(T.tailIn, 'tailin');
EV.sort((a, b) => a.t - b.t);
window.EV = EV; window.DUR = DUR; window.TL = { SECS, T, CUTS, FPS };

// ---------- render ----------
const camLocal = new THREE.Vector3(), segP = new THREE.Vector3(), segT = new THREE.Vector3(), tmpW = new THREE.Vector3();
window.render = function (t) {
  // 书：开、合
  const op = eio(seg(t, T.creak, T.coverUp + .6)) * (1 - eio(seg(t, T.shut - .75, T.shut)));
  const wob = t < T.creak ? Math.sin(t * 50) * .003 * seg(t, .2, T.creak) : 0;
  book.setOpen(Math.PI / 2 * op + wob + Math.sin(seg(t, T.coverUp + .5, T.coverUp + 1.1) * Math.PI) * -.03 + Math.sin(seg(t, T.shut, T.shut + .25) * Math.PI) * .01);
  const leafVis = t >= TONGUE_A && t < LEAF_B;
  const night = t >= TONGUE_A;      // 页缘一被拎起，下面露出的就是下一个跨页
  book.groundMat.map = night ? PT.groundNight : PT.groundDay; book.groundMat.needsUpdate = true;
  book.backMat.map = t >= LEAF_B ? PT.skyNight : PT.skyDay; book.backMat.needsUpdate = true;
  const u = t < LEAF_A ? 0 : leafU(t);
  if (leafVis) {
    book.leafFront.material.map = PT.groundDay; book.leafBack.material.map = PT.skyNight;
    book.leafFront.material.emissiveMap = PT.groundDay; book.leafBack.material.emissiveMap = PT.skyNight; book.leafFront.material.needsUpdate = book.leafBack.material.needsUpdate = true;
    // 平躺/立定时与地页、背板完全一致（无自发光），翻动途中补一点光，免得背光面发黑
    book.leafFront.material.emissiveIntensity = book.leafBack.material.emissiveIntensity = Math.sin(Math.PI * u);
  }
  book.setLeaf(u, pinchAt(t), leafVis);
  updatePops(POPS, t);
  const inS3 = t >= CUTS[2] && t < CUTS[3];
  if (inS3) for (const r of S3_HIDE) r.g.visible = false;   // 横移镜头里它们离镜头只有几厘米，会糊满一角
  // 白天机关
  for (const r of EX.towers) r.flag.scale.x = .25 + .75 * back(seg(t, T.flags - .25, T.flags + .1), 2), r.flag.rotation.z = Math.sin(t * 5 + r.g.position.x * 30) * .05;
  EX.keep.flag.scale.x = .25 + .75 * back(seg(t, T.flags - .2, T.flags + .15), 2); EX.keep.flag.rotation.z = Math.sin(t * 4.3) * .05;
  const tab = eio(seg(t, T.tab, T.tab + .3)) - ss(seg(t, T.turn - .05, T.turn + .15)) * 0;
  EX.tab.position.z = .228 + .03 * tab; EX.tab.visible = EX.slot.visible = t < TONGUE_A && !inS3;
  const lb = seg(t, T.tab + .05, T.bridgeLand), bounce = t > T.bridgeLand ? Math.abs(Math.sin((t - T.bridgeLand) / .12 * Math.PI)) * Math.exp(-(t - T.bridgeLand) * 9) * .13 : 0;
  EX.bridge.rotation.x = (Math.PI / 2) * (lb * lb * (1.6 - .6 * lb)) - bounce;
  // 铁链：城墙两侧挂点 → 桥面末端
  EX.wall.g.updateMatrixWorld(true);
  for (let i = 0; i < 2; i++) {
    const sx = i ? 1 : -1, a = new THREE.Vector3(sx * .015, .046, .0008), bpt = new THREE.Vector3(sx * .015, EX.bridgeLen * .92, 0);
    EX.wall.g.localToWorld(a); EX.bridge.localToWorld(bpt); S.worldToLocal(a); S.worldToLocal(bpt);
    const ch = EX.chains[i], d = bpt.clone().sub(a); ch.position.copy(a); ch.scale.set(1, d.length(), 1); ch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); ch.visible = EX.wall.g.visible && t > 2.6;
  }
  // 士兵：拉片带动前后摆，拍点处到达极点
  const tsw = Math.min(t, T.stop), sway = ss(seg(t, T.bridgeLand, T.sway1)) * Math.cos(Math.PI * (tsw - T.sway1) / .6) * .26;
  EX.soldiers.forEach((r, i) => { r.m.rotation.x = sway * (i % 2 ? -1 : 1); });
  // 月亮竹签
  // 月亮竹签是"最后一张还立着的卡"：其余夜景先折倒，它一直立到封面压下来，随封面同角度平躺
  EX.moon.visible = t > T.leafDown - .3 && t < T.shut + .02;
  EX.moon.position.y = lerp(-.2, -.02, rise(t, T.moon, .7));
  EX.moon.rotation.x = Math.PI / 2 * eio(seg(t, T.shut - .75, T.shut));
  EX.moon.children[0].rotation.z = Math.sin(t * 1.4) * .03;

  // 机位（先算，纸龙朝向要用）
  const Cm = camAt(t);
  cam.position.copy(Cm.pos); cam.fov = Cm.fov; cam.lookAt(Cm.tgt); cam.updateProjectionMatrix(); cam.updateMatrixWorld(); camQ.copy(cam.quaternion);
  camLocal.copy(Cm.pos).sub(new THREE.Vector3(0, PG, 0));

  // 纸龙
  const sH = HP.sAt(t);
  dragon.root.visible = t > 6.8 && t < T.shut + .2;
  if (dragon.root.visible) {
    const pose = dragonPose(t); dragon.pose(pose);
    HP.at(sH, headV); tangentAt(sH, segT);
    // 头的前进方向：翻页、停顿、放烟花时改为固定朝向
    const biting = t >= T.grab - .02 && t < LEAF_B;
    const hold = Math.max(seg(t, T.grab - .35, T.grab) * (1 - seg(t, LEAF_B, LEAF_B + .25)), 0);
    if (biting) holdDir(t, segT); else if (hold > 0) segT.lerp(TN0, hold).normalize();
    const fire = seg(t, T.fw1 - .5, T.fw1 - .1) * (1 - seg(t, T.fold, T.fold + .2));
    if (fire > 0) { const rec = breath(t); segT.lerp(new THREE.Vector3(.55, .83 - rec * .25, 0).normalize(), fire).normalize(); }
    const bob = (t > T.stop && t < T.grab) ? Math.sin((t - T.stop) * 5) * .0012 : 0;
    orient(dragon.headG, headV.clone().add(new THREE.Vector3(0, bob, 0)), segT, camLocal, .75);
    if (biting) {   // 咬合点精确落在纸页被拎起的那一点上：按实际嘴位修正一次
      S.updateMatrixWorld(true); const m = dragon.mouth(new THREE.Vector3()); S.worldToLocal(m);
      dragon.headG.position.add(grabPoint(t).sub(m));
    }
    const wcam = .7;
    for (let i = 0; i < dragon.segs.length; i++) {
      const sg = dragon.segs[i], s = sH - sg.d; HP.at(s, segP); tangentAt(s, segT);
      // 身体起伏波（飞行时）
      const wave = Math.sin(s * 70 - t * 9) * .003 * seg(t, T.emerge - .3, T.emerge) * (1 - seg(t, T.stop - .3, T.stop + .3) * .7);
      segP.y += wave; orient(sg.g, segP, segT, camLocal, wcam);
      sg.g.visible = segP.y > -.03;
    }
    { const s = sH - dragon.TAIL_D; HP.at(s, segP); tangentAt(s, segT); orient(dragon.tailG, segP, segT, camLocal, wcam); dragon.tailG.visible = segP.y > -.03; }
    dragon.headG.visible = headV.y > -.05;
    const fl = Math.sin(t * Math.PI / .3 * 1) ; const flapping = seg(t, T.emerge - .2, T.emerge) * (1 - seg(t, T.stop - .2, T.stop)) + seg(t, LEAF_B, LEAF_B + .2) * (1 - seg(t, T.fw1, T.fw1 + .3));
    const fa = .35 + flapping * .55 * (.5 + .5 * Math.cos((t - T.emerge) * Math.PI / .3));
    dragon.wingNG.rotation.x = -fa; dragon.wingFG.rotation.x = fa;
  }
  // 烟花
  for (const f of FW) {
    const st = fwState(f, t);
    f.rk.visible = st.rk.vis; if (st.rk.vis) { f.rk.position.copy(st.rk.pos); f.rk.rotation.z = t * 8; }
    f.g.visible = st.bs.vis; if (st.bs.vis) { f.g.position.copy(st.bs.pos); f.g.scale.setScalar(st.bs.s); f.g.rotation.set(st.bs.rx, 0, st.bs.rz); }
  }
  // 龙尾尖：合书后从书侧露出，最后一拍缩回
  tailTip.visible = t > T.shut - .05 && t < T.tailIn + .25;
  const tin = eio(seg(t, T.tailIn - .1, T.tailIn + .05));
  tailTip.position.set(BW / 2 + .004 - tin * .03, PG + .0004, .012); tailTip.rotation.set(-Math.PI / 2 * 0, 0, Math.sin(t * 9) * .12 * (1 - tin));

  // 灯光
  const Lt = lightsAt(t);
  sun.intensity = Lt.sunI; sun.color.copy(Lt.sunCol); sun.position.set(-.35, .55, .75);
  spot.intensity = Lt.lampI * 2.2; bulb.intensity = Lt.lampI * .35; hemi.intensity = Lt.hemiI;
  scene.environmentIntensity = Lt.envI; scene.backgroundIntensity = (.6 + Lt.envI * .4) * (1 - Lt.night * .45);
  post.dof.focus = Cm.pos.distanceTo(Cm.tgt); post.dof.aper = Cm.aper; post.dof.maxCoc = 14;
  post.vig.uniforms.fade.value = 1; post.vig.uniforms.warm.value = .12;
  let bl = 0; for (const f of FW) bl = Math.max(bl, Math.exp(-Math.max(0, t - f.b) * 3) * (t >= f.b ? 1 : 0));
  post.bloom.strength = .2 + bl * .22 - Lt.night * .06; post.bloom.threshold = 1.6 + Lt.night * .9;
  for (const p of PS) p.userData.update(t);
  scene.updateMatrixWorld(true);
  post.composer.render();
};
window.DBG = { book, dragon, cam, camAt, HP };
window.render(0);
window.READY = true;
