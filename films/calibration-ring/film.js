// 校准环：同一轮廓、屏幕锚点与时间轴驱动平面图和三维工位。
import * as THREE from '../../node_modules/three/build/three.module.js';
import { pageTiming } from '../../engine/production/timeline.js';

const response = await fetch('./film.json');
const timing = pageTiming(await response.json());
const fps = window.__RENDER?.fps ?? timing.fps;
const frameScale = fps / timing.fps;
const cue = id => Math.round(timing.event(id).frame * frameScale);
const align = cue('align');
const handoff = cue('handoff');
const seat = cue('seat');
const confirm = cue('confirm');
const last = Math.round(timing.frameCount * frameScale) - 1;
const control = new URLSearchParams(location.search).get('variant') === 'unmatched';

const W = 1920;
const H = 1080;
const gold = '#f6b761';
const { innerWidth: width, innerHeight: height } = window;
const scale = Math.min(width / W, height / H);
const offsetX = (width - W * scale) / 2;
const offsetY = (height - H * scale) / 2;
const board = document.querySelector('#board');
board.width = width;
board.height = height;
const ctx = board.getContext('2d', { alpha: false, willReadFrequently: true });
ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(width, height);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
const ringRadius = 1;
const innerRadius = 0.66;

// 轮缘的一处凹口贯穿两种媒介，是方向标记。两种画法共用这一轮廓。
const rim = Array.from({ length: 160 }, (_, i) => {
  const a = i * Math.PI / 80;
  const r = Math.abs(a - 1.1) < 0.115 ? 0.88 : ringRadius;
  return new THREE.Vector2(r * Math.cos(a), r * Math.sin(a));
});
const shape = new THREE.Shape(rim);
const hole = new THREE.Path();
hole.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
shape.holes.push(hole);
const depth = 0.34;
const metalFace = new THREE.MeshBasicMaterial({ color: gold });
const metalEdge = new THREE.MeshBasicMaterial({ color: '#a96239' });
const volume = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 80 });
volume.translate(0, 0, -depth);
const ring = new THREE.Mesh(volume, [metalFace, metalEdge]);
scene.add(ring);

const table = new THREE.Group();
scene.add(table);
const tableMaterials = [];
function mount(geometry, color, x, y, z) {
  const material = new THREE.MeshBasicMaterial({ color, transparent: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  tableMaterials.push(material);
  table.add(mesh);
  return mesh;
}
mount(new THREE.BoxGeometry(3.9, 2.75, 0.22), '#142831', 0, 0, -0.84);
mount(new THREE.BoxGeometry(3.83, 2.67, 0.07), '#38565e', 0, 0, -0.7);
const seatSurface = mount(new THREE.CylinderGeometry(1.17, 1.2, 0.22, 96), '#213e46', 0, 0, -0.58);
seatSurface.rotation.x = Math.PI / 2;
for (const x of [-1.52, 1.52]) {
  for (const y of [-1, 1]) {
    const pin = mount(new THREE.CylinderGeometry(0.075, 0.075, 0.045, 16), '#769492', x, y, -0.64);
    pin.rotation.x = Math.PI / 2;
  }
}
const lamp = mount(new THREE.BoxGeometry(0.16, 0.18, 0.03), '#607678', 1.49, 0, -0.65);
const lampOff = new THREE.Color('#607678');
const lampOn = new THREE.Color('#8ff5d1');

const clamp = x => Math.max(0, Math.min(1, x));
const progress = (frame, start, end) => clamp((frame - start) / Math.max(1, end - start));
const ease = x => x * x * (3 - 2 * x);
const mix = (a, b, p) => a + (b - a) * p;
function phase(frame) {
  const travel = progress(frame, 0, last);
  const reveal = ease(progress(frame, handoff, seat));
  const settle = ease(progress(frame, seat, last));
  const mismatch = control && frame >= handoff ? 1 - reveal : 0;
  return {
    x: W * (0.37 + 0.25 * ease(travel)) + 196 * mismatch,
    y: H * (0.52 + 0.064 * reveal),
    size: mix(170, 262, ease(travel)) * (1 + 0.26 * mismatch) * (1 - 0.12 * settle),
    turn: mix(-0.6, 0.46, ease(travel)),
    tilt: 0.94 * reveal - 0.14 * settle,
    reveal,
    lift: mix(0.56, -0.13, reveal),
    signal: ease(progress(frame, confirm, last)),
    scan: ease(progress(frame, align, handoff)),
  };
}

const background = ctx.createRadialGradient(W * 0.5, H * 0.48, 40, W * 0.5, H * 0.48, 1000);
background.addColorStop(0, '#29404a');
background.addColorStop(1, '#101c25');

function drawBoard(state) {
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#314953';
  ctx.beginPath();
  for (let x = 96; x < W - 85; x += 48) {
    ctx.moveTo(x, 114); ctx.lineTo(x, H - 114);
  }
  for (let y = 114; y < H - 105; y += 48) {
    ctx.moveTo(96, y); ctx.lineTo(W - 96, y);
  }
  ctx.stroke();
  ctx.strokeStyle = '#66828a';
  ctx.lineWidth = 2;
  ctx.strokeRect(96, 114, W - 192, H - 228);
  ctx.beginPath();
  for (let x = 120; x < W - 96; x += 24) {
    const mark = x % 120 === 0 ? 15 : 6;
    ctx.moveTo(x, 114); ctx.lineTo(x, 114 + mark);
    ctx.moveTo(x, H - 114); ctx.lineTo(x, H - 114 - mark);
  }
  ctx.stroke();

  // 两个固定标尺提供空间参照。扫描线收拢后让出视线给工位。
  ctx.strokeStyle = '#80a19e';
  ctx.beginPath();
  ctx.moveTo(153, 235); ctx.lineTo(153, 354); ctx.lineTo(222, 354);
  ctx.moveTo(1767, 845); ctx.lineTo(1767, 726); ctx.lineTo(1698, 726);
  ctx.stroke();
  const scanEnd = mix(1310, 1540, state.scan + 0.5 * state.reveal);
  ctx.fillStyle = '#759e9f';
  ctx.fillRect(160, 803, scanEnd - 160, 3);
  ctx.fillRect(scanEnd, 797, 3, 15);
  ctx.strokeStyle = 'rgba(122, 161, 161, 0.3)';
  ctx.beginPath();
  ctx.moveTo(scanEnd, 797); ctx.lineTo(scanEnd, 443);
  ctx.stroke();

  const lights = ['#607678', '#607678', '#607678'];
  if (state.scan > 0.5) lights[0] = '#9fc7c1';
  if (state.reveal > 0.5) lights[1] = '#9fc7c1';
  if (state.signal > 0.5) lights[2] = '#8ff5d1';
  lights.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(160 + i * 22, 903, 10, 10);
  });
}

function drawDiagram(state) {
  ctx.save();
  ctx.translate(state.x, state.y);
  ctx.rotate(-state.turn);
  ctx.scale(state.size, -state.size);
  ctx.beginPath();
  for (const point of rim) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.moveTo(innerRadius, 0);
  ctx.arc(0, 0, innerRadius, 0, Math.PI * 2);
  ctx.fillStyle = gold;
  ctx.fill('evenodd');
  ctx.restore();
}

function drawVolume(state) {
  ring.position.z = state.lift;
  ring.rotation.z = state.turn;
  const focalLength = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const distance = focalLength / (state.size * scale);
  camera.position.set(0, -distance * Math.sin(state.tilt), state.lift + distance * Math.cos(state.tilt));
  camera.lookAt(0, 0, state.lift);
  // 朝向与景深由 3D 相机给出，投影中心沿交接前的屏幕轨迹继续走。
  camera.updateProjectionMatrix();
  camera.projectionMatrix.elements[8] = 1 - 2 * (offsetX + state.x * scale) / width;
  camera.projectionMatrix.elements[9] = 2 * (offsetY + state.y * scale) / height - 1;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  table.visible = state.reveal > 0;
  for (const material of tableMaterials) material.opacity = Math.min(1, state.reveal * 2.5);
  lamp.material.color.copy(lampOff).lerp(lampOn, state.signal);
  renderer.render(scene, camera);
  // 先合入同一张 2D 底板，再交给浏览器截图。两层使用同一帧的像素。
  ctx.save();
  ctx.resetTransform();
  ctx.drawImage(renderer.domElement, 0, 0);
  ctx.restore();
}

function render(t) {
  const frame = Math.min(last, Math.max(0, Math.floor(t * fps + 1e-7)));
  const state = phase(frame);
  drawBoard(state);
  if (frame < handoff) {
    drawDiagram(state);
  } else {
    drawVolume(state);
  }
}

Object.assign(window, { DUR: timing.DUR, FPS: fps, render, TEXTS: () => [], EV: timing.events });
render(0);
window.READY = true;
