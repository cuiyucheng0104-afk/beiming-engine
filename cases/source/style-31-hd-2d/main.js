// 港口集市 — 页面契约：window.render(t) 确定性出帧；window.EV 给混音与拍点核对
import * as THREE from 'three';
import { makePost } from './engine/post_ts.js';
import { DUR, T, shotAt, events } from './timeline.js';
import { buildHarbor, STALL_X } from './engine/harbor.js';
import { drawOverlay, overlayReady } from './engine/ui.js';

const W = 1920, H = 1080, Q = new URLSearchParams(location.search);
const SS = +(Q.get('ss') ?? 2), TILT = !Q.has('notilt');
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('stage').appendChild(renderer.domElement);
renderer.domElement.style.width = W + 'px'; renderer.domElement.style.height = H + 'px';
const camera = new THREE.PerspectiveCamera(34, W / H, .3, 2000);
const set = buildHarbor();
const post = makePost(renderer, set.scene, camera, W, H, { ssaa: SS });
post.bloom.strength = .6; post.bloom.radius = .75; post.bloom.threshold = .85;
const V = post.vig.uniforms;
await overlayReady();

// 声音事件：拍点事件 + 每盏灯的声像（由世界 x 推出）
window.EV = events().map(e => e.type === 'pop' ? { ...e, pan: Math.max(-.8, Math.min(.8, (STALL_X[e.i] + 2) / 12)) } : e);
window.DUR = DUR;
let texts = [];
window.TEXTS = t => { window.render(t); return texts; };
window.render = t => {
  const shot = shotAt(t);
  V.fade.value = 1; V.warm.value = .08; V.sat.value = 1.08; V.amt.value = .6; V.contrast.value = .2;
  set.update(t, shot.id, camera, post);          // 第一遍只为把镜头放好：辉光大小、光柱朝向、精灵朝向都依赖本帧镜头（否则剪切后第一帧用的是上一个机位）
  const st = set.update(t, shot.id, camera, post);
  let ex = 1.1 * (1 + post.flash * .9) * (1 + post.burst * .3);
  if (shot.id === 'light') ex *= 1.12;
  renderer.toneMappingExposure = ex;
  post.bloom.strength = .6 + post.burst * .15 + post.flash * .3;
  if (TILT) { const tl = post.tilt || { c: .45, w: .075 }; post.dof.tiltAmt = tl.amt ?? 17; post.dof.tiltC = tl.c; post.dof.tiltW = tl.w; post.dof.tiltF = tl.f ?? .3; post.dof.maxCoc = Math.max(post.dof.maxCoc, 24); V.sat.value *= 1.14; V.contrast.value = .28; }
  if (Q.has('nodof')) post.dof.maxCoc = 0;
  post.composer.render();
  texts = drawOverlay(t);
  void st;
};
window.READY = true;
