// 《积木小屋变船》—— 积木玩具风格样片
import * as THREE from 'three';
import { makePost } from '/core/three/post.js';
import { clamp, seg, eio, eo, ei, ss, lerp, hash } from '/core/lib.js';
import { BRICK, PLATE } from './bricks.js';
import { DUR, B, HIT, BUILD, SHOTS, BPM, shotAt, shotSpan, q, qr, qa } from './timeline.js';
import { buildSet, CUP, LAMP } from './set.js';
import { makeWater, makeSplash } from './water.js';
import { makeHouse, RAFT, BOAT_YAW } from './house.js';
import { makeFigure, walkPose, mixPose, HIP } from './figure.js';

const W = 1920, H = 1080, V = (x, y, z) => new THREE.Vector3(x, y, z);
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(2); renderer.setSize(W, H);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, W / H, .5, 4000);
const post = makePost(renderer, scene, camera, W, H, { ssaa: 2, ao: true, aoRadius: 3.0, aoThickness: 3, aoAmt: .9 });
post.bloom.strength = .12; post.bloom.threshold = 1.3;
Object.assign(post.vig.uniforms, {});
post.vig.uniforms.amt.value = .34; post.vig.uniforms.warm.value = -.35; post.vig.uniforms.contrast.value = .26; post.vig.uniforms.sat.value = 1.1;

await document.fonts.load('200px "ZCOOL KuaiLe"', '家');
const set = await buildSet(scene);
const water = makeWater(scene, set.cup);
const splash = makeSplash(scene, water.splashMat);
const house = makeHouse(scene);
const fig = makeFigure(); scene.add(fig.root);

// —— 船的运动：b29 小人跳上船（船身一沉），b30/32/34 三桨，每桨一次前冲 ——
const tHop = B(HIT.hop), strokes = HIT.row.map(B);
const boatS = t => { let s = 0; for (const c of strokes) s += 6.4 * eo(seg(t, c, c + .75)); s += Math.max(0, t - strokes[0]) * 1.4; return s; };   // 每桨约 6 个凸点 + 滑行：船真的在水面上往前走
house.setBoatXf(t0 => {
  const t = q(t0);
  if (t < tHop) return { p: V(0, .1, 0), yaw: BOAT_YAW, roll: 0 };
  const d = t - tHop, dip = -.22 * Math.exp(-d * 5) * Math.cos(d * 14), s = boatS(t);
  return { p: V(-s, .1 + dip + Math.sin(t * 3.3) * .04, s * .06), yaw: BOAT_YAW - s * .006, roll: .05 * Math.exp(-d * 3) * Math.sin(d * 11) + Math.sin(t * 2.4) * .012, pitch: 0 };
});
const boatM = t => { const x = house.boatXf(t); return new THREE.Matrix4().compose(x.p, new THREE.Quaternion().setFromEuler(new THREE.Euler(x.pitch ?? 0, x.yaw, x.roll ?? 0, 'YXZ')), V(1, 1, 1)); };
const boatLocal = (t, x, y, z) => V(x, y, z).applyMatrix4(boatM(t));

// —— 小人的表演 ——
const DOOR = V(0, PLATE, .2), OUT = [V(0, PLATE, 1.7), V(0, PLATE, 3.2), V(0, 0, 4.8)];
const RAFT_TOP = .08 + PLATE + .02;
const RAFT_SPOT = V(RAFT.x + .5, RAFT_TOP, RAFT.z - .3);
const toCup = Math.atan2(CUP.x - OUT[2].x, CUP.z - OUT[2].z);
const toBoat = Math.atan2(0 - RAFT_SPOT.x, 0 - RAFT_SPOT.z);
const stepIn = (t, t0, t1) => ss(seg(q(t), t0, t1));
let FIG_ANCH = null;
function figAt(t0) {
  if (!FIG_ANCH) FIG_ANCH = [...new Set([...[HIT.step1, HIT.step2, HIT.step3, HIT.stretch, HIT.bump, HIT.wobble, HIT.cupLand, HIT.wave, HIT.raft, HIT.silence, HIT.drip, HIT.chord, 28.5, HIT.hop, ...HIT.row, 35, HIT.end].map(B), ...BUILD.map(([b]) => B(b)), ...BUILD.map(([, ids]) => house.byId[ids[0]].fly)])].sort((a, b) => a - b);
  const t = qa(t0, FIG_ANCH);
  let P = { x: DOOR.x, y: DOOR.y, z: DOOR.z, ry: 0, brow: .3, mouth: 1, blink: Math.floor(t * 12) % 41 === 0 };
  const put = (p, ry) => { P.x = p.x; P.y = p.y; P.z = p.z; if (ry !== undefined) P.ry = ry; };
  let paddle = 'slot';
  if (t < B(HIT.step1) - .3) { P.look = Math.sin(t * 1.3) * .15; P.armL = [0, .08]; P.armR = [0, .08]; }
  else if (t < B(HIT.step3)) {   // 三步出门，每步落在拍上
    const ts = [B(HIT.step1), B(HIT.step2), B(HIT.step3)];
    let i = ts.findIndex(x => t < x); if (i < 0) i = 2;
    const a = i === 0 ? DOOR : OUT[i - 1], b = OUT[i], u = clamp((t - (ts[i] - .3)) / .3);
    put(a.clone().lerp(b, u)); P.y += Math.sin(u * Math.PI) * .35;
    Object.assign(P, walkPose(u * Math.PI * (i % 2 ? -1 : 1), .5));
  } else if (t < B(HIT.bump)) {   // 伸懒腰：预备（下蹲）→ V 字 → 停住
    put(OUT[2], 0);
    const pre = seg(t, B(HIT.stretch) - .42, B(HIT.stretch) - .17), up = seg(t, B(HIT.stretch) - .17, B(HIT.stretch));
    P.bob = -.18 * Math.sin(pre * Math.PI * .5) * (1 - up);
    const arm = lerp(lerp(.08, -.15, pre), 2.55, eo(up));
    P.armL = [lerp(0, .25, pre) * (1 - up), arm]; P.armR = [lerp(0, .25, pre) * (1 - up), arm];
    P.nod = lerp(0, -.25, eo(up)); P.brow = lerp(.3, 1, up); P.mouth = lerp(1, 1.4, up);
    if (up >= 1) P.y += Math.sin(seg(t, B(HIT.stretch), B(HIT.stretch) + .25) * Math.PI) * .25;
  } else if (t < B(HIT.wave)) {   // 桌震：吓一跳 → 回头看杯子 → 双臂上举惊慌
    put(OUT[2], 0);
    const u = seg(t, B(HIT.bump), B(HIT.bump) + .25); P.y += Math.sin(u * Math.PI) * .7;
    const look = ss(seg(t, B(HIT.wobble) - .2, B(HIT.wobble) + .1));
    P.ry = lerp(0, toCup * .45, look); P.look = lerp(0, toCup * .4, look); P.nod = -.15 * look;
    const al = ss(seg(t, B(HIT.cupLand) - .17, B(HIT.cupLand)));
    P.armL = [lerp(-.2, -.25, al), lerp(.35, 2.9, al)]; P.armR = [lerp(-.2, -.25, al), lerp(.35, 2.9, al)];
    P.brow = lerp(-.6, -1, al); P.mouth = lerp(.6, -.9, al);
  } else if (t < B(HIT.raft)) {   // 被浪抛起：一个后空翻，落到木筏上坐下
    const u = clamp((t - B(HIT.wave)) / (B(HIT.raft) - B(HIT.wave)));
    const p = OUT[2].clone().lerp(RAFT_SPOT, u); p.y += Math.sin(u * Math.PI) * 9;
    put(p, lerp(toCup * .45, toBoat - .3, u)); P.rx = -u * Math.PI * 2;
    P.armL = [-.3, 2.6 - u * 1.4]; P.armR = [-.3, 2.6 - u * 1.4]; P.legs = [-.5 * Math.sin(u * 7), .5 * Math.sin(u * 7)];
    P.brow = -1; P.mouth = -1; P.sit = ss(seg(u, .7, 1));
  } else if (t < B(HIT.first) - .6) {   // 坐在木筏上发愣；静默里慢慢抬头看那堆零件
    put(RAFT_SPOT, toBoat - .3); P.sit = 1 - ss(seg(t, B(HIT.drip) - .1, B(HIT.drip) + .25));
    const d = t - B(HIT.raft);
    P.tilt = .18 * Math.exp(-d * 2) * Math.sin(d * 16); P.nod = lerp(.35, -.05, ss(seg(t, B(HIT.silence), B(HIT.drip))));
    P.look = lerp(-.4, .2, ss(seg(t, B(HIT.silence) + .2, B(HIT.drip)))); P.armL = [-.25, .12]; P.armR = [-.25, .12];
    P.brow = lerp(-1, -.3, seg(t, B(HIT.silence), B(HIT.drip))); P.mouth = lerp(-.8, .2, seg(t, B(HIT.silence), B(HIT.drip)));
    P.ry = lerp(toBoat - .3, toBoat, ss(seg(t, B(HIT.drip), B(HIT.drip) + .3)));
  } else if (t < B(HIT.chord)) {   // 指挥：每一次零件起飞，一只手臂指向它的落点；越来越快
    put(RAFT_SPOT, toBoat); P.brow = .6; P.mouth = 1.2; P.nod = -.12;
    let arm = 0, last = null, li = 0;
    BUILD.forEach(([b, ids], i) => { const p = house.byId[ids[0]]; if (t >= p.fly - .12) { last = p; li = i; } });
    if (last) {
      const u = seg(t, last.fly - .12, last.fly + .05), dn = seg(t, last.land, last.land + .2);
      const pt = lerp(0, 1, eo(u)) * (1 - dn * .6);
      const side = li % 2 ? 'armL' : 'armR', other = li % 2 ? 'armR' : 'armL';
      P[side] = [-1.55 * pt, .25 + .2 * pt]; P[other] = [-.1, .15];
      if (t > B(26)) { P[other] = [-1.2 * pt, .4]; }
    } else { P.armL = [-.2, .12]; P.armR = [-.2, .12]; }
    const bt = (t - B(HIT.first)) / (60 / BPM); P.bob = t > B(22) ? Math.abs(Math.sin(bt * Math.PI)) * .14 : 0;
    P.look = Math.sin(t * 2.1) * .12;
  } else if (t < tHop) {   // 船成了：V 字欢呼 → 下蹲 → 跳
    put(RAFT_SPOT, toBoat);
    const v = eo(seg(t, B(HIT.chord), B(HIT.chord) + .15)), pre = seg(t, B(28.5), tHop - .25), jump = seg(t, tHop - .25, tHop);
    P.armL = [0, 2.6 * v * (1 - pre)]; P.armR = [0, 2.6 * v * (1 - pre)]; P.brow = 1; P.mouth = 1.5; P.nod = -.25 * v;
    P.bob = -.25 * Math.sin(pre * Math.PI * .5);
    if (jump > 0) {
      const seat = boatLocal(tHop, -3.5, PLATE + 3 * BRICK + .02, 0);
      const p = RAFT_SPOT.clone().lerp(seat, jump); p.y += Math.sin(jump * Math.PI) * 5;
      put(p, lerp(toBoat, -Math.PI / 2, jump)); P.armL = [-.6, 1.5]; P.armR = [-.6, 1.5]; P.legs = [.5, -.4]; P.sit = jump;
    }
  } else {   // 坐在船尾划桨（独木舟式单桨，右舷 = 镜头这一侧）
    const seat = boatLocal(t, -3.5, PLATE + 3 * BRICK + .02, 0), x = house.boatXf(t);
    put(seat, x.yaw - Math.PI * 1.5); P.rz = x.roll ?? 0; P.sit = 1; P.brow = .5; P.mouth = 1.1;
    paddle = t < tHop + .25 ? 'grab' : 'hands';
    let ph = -1; for (const c of strokes) if (t >= c - .35) ph = (t - (c - .35)) / (2 * 60 / BPM);
    if (t < strokes[0] - .35) ph = -1;
    const pull = ph < 0 ? 0 : ph < .2 ? -ss(ph / .2) * .1 : ph < .55 ? ss((ph - .2) / .35) : 1 - ss((ph - .55) / .45);
    const reach = ph < 0 ? .2 : 1 - pull;
    P.armL = [lerp(-.6, -1.55, reach), .1]; P.armR = [lerp(-.6, -1.55, reach), .1];
    P.lean = lerp(-.1, .25, reach); P.nod = -.1;
    P.stroke = ph < 0 ? -1 : clamp(ph);
    if (t > B(35)) { P.look = lerp(0, -.6, ss(seg(t, B(35), B(36)))); }
  }
  return { P, paddle };
}

// 船桨（台阶板）在手里：一端在两手之间，另一端插进镜头这一侧的水里
const paddleP = house.byId.step;
const _a = V(0, 0, 0), _b = V(0, 0, 0);
function placePaddle(t, A) {
  if (A.paddle === 'slot') return;
  fig.root.updateMatrixWorld(true);
  fig.arms[0].hand.getWorldPosition(_a); fig.arms[1].hand.getWorldPosition(_b);
  const hands = _a.clone().add(_b).multiplyScalar(.5);
  const ph = A.P.stroke ?? -1, x = house.boatXf(t);
  const fwd = V(Math.cos(x.yaw), 0, -Math.sin(x.yaw)), out = V(0, 0, 1);   // 船头方向、右舷（+z 世界）
  let tip;
  if (ph < 0) tip = hands.clone().addScaledVector(fwd, .6).addScaledVector(out, 2.2).add(V(0, -2.6, 0));
  else {
    const pull = ph < .2 ? 0 : ph < .55 ? ss((ph - .2) / .35) : 1, lift = ph > .55 ? Math.sin(seg(ph, .55, 1) * Math.PI) * 1.6 : 0;
    tip = hands.clone().addScaledVector(fwd, lerp(2.4, -2.8, pull)).addScaledVector(out, 2.4).add(V(0, -3.4 + lift, 0));
  }
  const dir = tip.clone().sub(hands).normalize();
  const m = paddleP.m, grab = A.paddle === 'grab' ? seg(q(t), tHop, tHop + .25) : 1;
  const center = hands.clone().addScaledVector(dir, 1.4);
  const qq = new THREE.Quaternion().setFromUnitVectors(V(1, 0, 0), dir);
  m.position.lerp(center.clone().sub(V(0, .2, 0).applyQuaternion(qq)), grab);
  m.quaternion.slerp(qq, grab);
}

// —— 相机 ——
const shakeV = (t, amt) => { const f = Math.floor(t * 24); return V(hash(f) - .5, hash(f + 99) - .5, hash(f + 7) - .5).multiplyScalar(amt); };
const lerpV = (a, b, u) => a.clone().lerp(b, u);
function cam(t) {
  const st = shotAt(t), [t0, t1] = shotSpan(st), u = seg(t, t0, t1);
  let pos, look, fov = 34, focus, aper = 800, span = 34;
  const figHead = fig.root.position.clone().add(V(0, 3.8, 0));
  switch (st.name) {
    case 'rack': {   // 低机位微距：焦点从远处的茶杯拉到「家」字砖
      pos = lerpV(V(-8.5, 2.3, 17.5), V(-7.2, 2.6, 14.6), eio(u)); look = lerpV(V(4, 4.6, -6), V(2.2, 4.8, -3), eio(u)); fov = 30;
      const r = ss(seg(t, B(1), B(HIT.focus))), fc = V(CUP.x, 4, CUP.z), ft = V(0, 6.1, 2.2);
      const dc = pos.distanceTo(fc), dt = pos.distanceTo(ft);
      post.dof.focus = 1 / lerp(1 / dc, 1 / dt, r); focus = null; aper = 1100; break;
    }
    case 'door': {   // 小人视线高度，横移跟拍
      pos = lerpV(V(-6.5, 2.2, 15.5), V(4.5, 2.5, 15.5), eio(u)); look = V(figHead.x * .5 + lerp(-1, 2.5, u), 4.2, figHead.z * .5 + 1); fov = 36;
      focus = figHead; aper = 750; break;
    }
    case 'tip': {    // 桌震手持 + 摇镜跟着杯子倒下
      const tipU = ss(seg(t, B(HIT.wobble), B(HIT.cupLand) + .2));
      pos = V(17, 8.5, 19); look = lerpV(V(7, 4.2, -6), V(1, 2.6, 0), tipU); fov = 40;
      const sh = Math.exp(-Math.max(0, t - B(HIT.bump)) * 6) * 1.1 + (t > B(HIT.cupLand) ? Math.exp(-(t - B(HIT.cupLand)) * 8) * .5 : 0);
      pos.add(shakeV(t, sh)); look.add(shakeV(t + 3, sh * .6));
      focus = lerpV(V(CUP.x, 4, CUP.z), V(2, 2, 0), tipU); aper = 700; span = 40; break;
    }
    case 'wave': {   // 全景低角度：崩塌，冲击抖动渐衰 + 缓拉
      pos = lerpV(V(7, 3.6, 26), V(9, 4.6, 31), eo(u)); look = V(-3.5, 3, 2.5); fov = 42;
      const sh = Math.exp(-Math.max(0, t - B(HIT.wave)) * 4) * 1.3; pos.add(shakeV(t, sh)); look.add(shakeV(t + 5, sh * .5));
      focus = V(-3, 2, 3); aper = 650; span = 45; break;
    }
    case 'alone': {  // 静默：低角度大全景，小人在左下角
      pos = V(15, 1.1, 30); look = V(.4, 6.4, 1); fov = 40;   /* 低机位、上仰：地平线压到下三分之一，小人落在左下三分点 */ focus = RAFT_SPOT.clone().add(V(0, 2, 0)); aper = 520; span = 50; break;
    }
    case 'orbit': {  // 环绕拼船：从右前方绕到正前方
      const a = lerp(.95, -.12, eio(u)), r = lerp(19, 17.5, u), c = V(-1.2, 2.6, 0);
      pos = V(c.x + Math.sin(a) * r, lerp(7.5, 6.2, u), c.z + Math.cos(a) * r); look = V(lerp(-2.2, -5.4, eio(u)), 3.0, lerp(1.2, 2.6, eio(u))); fov = lerp(40, 42, u);   // 指挥的小人始终整个在左三分之一里，不被画框切半
      focus = V(0, 3, 0); aper = 700; span = 34; break;
    }
    default: {       // 跟拍 → 摇臂上升拉远：整张书桌
      const bp = house.boatXf(t).p, w = eio(seg(t, B(31), B(HIT.end)));
      // 侧向跟拍但只跟一半：船从画面右侧往左驶过，镜头朝前方（-x，水洼边）留出空间
      const near = V(bp.x * .5 + 1.2, bp.y + 4.8, bp.z + 19.5), far = V(34, 165, 205);
      const nearL = V(bp.x * .5 - 2.6, bp.y + 3.6, bp.z), farL = V(-16, 24, -22);
      pos = near.clone().lerp(far, w); pos.y = lerp(near.y, far.y, Math.pow(w, .8));
      look = nearL.clone().lerp(farL, ss(w)); fov = lerp(38, 36, w);
      focus = lerpV(bp.clone().add(V(0, 3, 0)), V(-10, 0, -8), w); aper = lerp(700, 380, w); span = lerp(34, 120, w);
      if (t > B(HIT.end)) { const d = t - B(HIT.end); pos.lerp(look, .045 * d * ss(clamp(d / .35))); }   // 停住后极缓推进，不留死帧
    }
  }
  camera.position.copy(pos); camera.fov = fov; camera.updateProjectionMatrix(); camera.lookAt(look);
  const fc = focus || look;
  if (focus) post.dof.focus = camera.position.distanceTo(focus);
  post.dof.aper = aper; post.dof.maxCoc = 16;
  const k = set.key; k.target.position.copy(fc); k.position.copy(fc).add(V(-60, 110, 50)); k.target.updateMatrixWorld();
  Object.assign(k.shadow.camera, { left: -span, right: span, top: span, bottom: -span }); k.shadow.camera.updateProjectionMatrix();
}

// —— 水花 ——
const SPL = [];
SPL.push({ t0: tHop, x: 0, z: 2.6, n: 10, r: 1.6 });
for (const c of strokes) SPL.push({ t0: c, x: 0, z: 0, n: 9, r: 1.3, stroke: true });

function render(t) {
  const A = figAt(t);
  fig.root.visible = true; fig.pose(A.P);
  house.update(t, { houseShake: t >= B(HIT.bump) && t < B(HIT.bump) + .3 ? .12 * (1 - seg(t, B(HIT.bump), B(HIT.bump) + .3)) * (Math.floor(t * 12) % 2 ? 1 : -1) : 0 });
  placePaddle(t, A);
  water.update(t);
  // 桨入水点：桨尖位置（第一帧）
  splash.update(t, SPL.map(s => s.stroke ? { ...s, ...strokePt(s.t0) } : s));
  cam(t);
  post.composer.render();
}
function strokePt(t0) { const bp = house.boatXf(t0); return { x: bp.p.x - 1.5, z: bp.p.z + 3.4 }; }

// —— 声音与拍点事件（mix.py / cuecheck.py 读取） ——
function events() {
  const ev = [], add = (type, t, o = {}) => ev.push({ type, t: +t.toFixed(4), ...o });
  const grid = []; for (let b = 0; b <= 40; b += .25) grid.push([b, B(b)]);
  ev.push({ type: 'grid', t: 0, bpm: BPM, grid });
  for (const s of SHOTS) add('cut', B(s.b0), { id: s.id, beat: s.b0 });
  add('step', B(HIT.step1), { v: .7, beat: HIT.step1 }); add('step', B(HIT.step2), { v: .75, beat: HIT.step2 }); add('step', B(HIT.step3), { v: .8, beat: HIT.step3 });
  add('creak', B(HIT.stretch), { v: .35, beat: HIT.stretch });
  add('bump', B(HIT.bump), { beat: HIT.bump });
  add('clink', B(HIT.wobble), { v: .8, beat: HIT.wobble }); add('clink', B(HIT.wobble) + 4 / 24, { v: .45 });
  add('scrape', B(HIT.tip), { v: .6, beat: HIT.tip });
  add('cupland', B(HIT.cupLand), { beat: HIT.cupLand }); add('gush', B(HIT.cupLand), { d: 2.6 });
  add('crash', B(HIT.wave), { beat: HIT.wave }); add('whoosh', B(HIT.wave) + .05, { v: .6, d: .5 });
  for (const im of house.impacts) if (im.t < B(HIT.silence) - .05) add('clack', im.t, { v: .35 + im.v * .6 });
  add('land', B(HIT.raft), { beat: HIT.raft });
  add('drip', B(HIT.drip), { beat: HIT.drip });
  BUILD.forEach(([b, ids]) => {
    const p = house.byId[ids[0]];
    add('whoosh', p.fly, { v: b === 18 ? .25 : .32, d: Math.max(.2, p.land - p.fly) });
    add('click', B(b), { beat: b, v: b === 18 ? 1.25 : .95, n: ids.length, final: b === HIT.chord, id: ids[0] });
  });
  add('ding', B(HIT.chord), { beat: HIT.chord });
  add('whoosh', tHop - .25, { v: .4, d: .3 }); add('hopland', tHop, { beat: HIT.hop });
  add('click', tHop + 6 / 24, { v: .5, n: 1, id: 'paddle-grab' });
  for (const [i, c] of strokes.entries()) add('stroke', c, { beat: HIT.row[i] });
  add('end', B(HIT.end), { beat: HIT.end });
  return ev.sort((a, b) => a.t - b.t);
}
// 画面实测的视觉事件时刻（逐帧求值真实状态函数，不是照抄拍点）
function visualHits() {
  const out = [];
  for (const [b, ids] of BUILD) out.push({ name: `build:${ids[0]}`, beat: b, tv: house.landedFrame(ids[0]) });
  const first = (pred, f0, f1) => { for (let f = f0; f < f1; f++) if (pred(f / 24)) return f / 24; return null; };
  const LIE = water.cupAngle(B(HIT.cupLand) + 2);
  out.push({ name: 'cupland', beat: HIT.cupLand, tv: first(t => water.cupAngle(t) >= LIE - .1, Math.floor(B(HIT.tip) * 24), 200) });
  out.push({ name: 'stretch', beat: HIT.stretch, tv: first(t => (figAt(t).P.armL?.[1] ?? 0) > 2.5, Math.floor(B(6.5) * 24), 120) });
  for (const [k, b] of [[0, HIT.step1], [1, HIT.step2], [2, HIT.step3]]) out.push({ name: `step${k + 1}`, beat: b, tv: first(t => { const P = figAt(t).P; return Math.abs(P.z - OUT[k].z) < .02; }, Math.floor((B(b) - .4) * 24), Math.floor((B(b) + .4) * 24)) });
  out.push({ name: 'raft', beat: HIT.raft, tv: first(t => figAt(t).P.sit >= .999 && t > B(HIT.wave), Math.floor(B(HIT.wave) * 24), 260) });
  out.push({ name: 'hop', beat: HIT.hop, tv: first(t => figAt(t).paddle !== 'slot', Math.floor(B(28) * 24), 420) });
  for (const s of SHOTS) out.push({ name: `cut:${s.id}`, beat: s.b0, tv: first(t => shotAt(t) === s, 0, Math.ceil(DUR * 24)) });
  return out;
}

window.render = render; window.DUR = DUR;
const VH = visualHits();
window.EV = events().concat(VH.map(v => ({ type: 'vhit', t: v.tv ?? -1, name: v.name, beat: v.beat })));
window.TEXTS = () => [];
window.DBG = { camera, fig, house, water, post, figAt };
render(parseFloat(new URLSearchParams(location.search).get('t') ?? '1'));
window.READY = true;
