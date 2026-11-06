// 冰淇淋车 · 孟菲斯微缩景观。一个连续镜头：车开进方糖广场 → 车停一蹲一弹，广场随波浪起伏 → 剖开车厢看流水线
// → 侧板合上、全曲停、车身蓄力 → 巨型冰淇淋从车顶弹出 → "今日限定"→ 画框收成圆窗。
// 页面契约（core/README.md）：window.READY、window.render(t)、window.DUR、window.EV、window.TEXTS(t)。所有时间来自 timeline.js。
import * as THREE from 'three';
import { Diorama, setSeason, setHalftone, setNight, flat, mesh, box, rng, FRAME, INK } from './memphis.js';
import { person, walk } from './people.js';
import { FPS, BEAT, b, CUE, DUR, TRUCK_STOP, WAVE_V, WAVE_STEP, WAVES } from './timeline.js';
import { LINES, CALLOUTS } from './texts.js';

const dio = new Diorama(document.getElementById('gl'), document.getElementById('c').getContext('2d'));
const W = new THREE.Group(); dio.scene.add(W);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const c01 = (x) => Math.max(0, Math.min(1, x));
const seg = (t, a, c) => c01((t - a) / (c - a));
const sm = (x) => { x = c01(x); return x * x * (3 - 2 * x); };
const io = (x) => { x = c01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const eo = (x) => 1 - Math.pow(1 - c01(x), 3);
const ei = (x) => Math.pow(c01(x), 2.4);
const backOut = (x, s = 1.9) => { x = c01(x) - 1; return 1 + x * x * ((s + 1) * x + s); };
const lerp = (a, c, u) => a + (c - a) * u;
const R = rng(71), rr = (a, c) => a + (c - a) * R();
const cache = new Map();
const M = (hex, o = {}) => { const k = hex + JSON.stringify(o); if (!cache.has(k)) cache.set(k, flat(hex, o)); return cache.get(k); };
const NO = (m) => { m.userData.noOutline = true; m.castShadow = false; return m; };

// 蹲-弹：T 之前 ant 秒蹲下（预备），T 松开，阻尼回弹（过冲）。返回 y 缩放的偏差（0 = 原样）
function sq(t, T, amp, ant = 0.16, per = 0.27, tau = 0.2) {
  if (t < T - ant) return 0;
  if (t < T) return -amp * sm((t - T + ant) / ant);
  const u = t - T; return -amp * Math.cos(2 * Math.PI * u / per) * Math.exp(-u / tau);
}

// ---------- 地面、道路、人行道 ----------
mesh(new THREE.PlaneGeometry(500, 500).rotateX(-Math.PI / 2), M('#9DE8A6', { pat: 1, patCol: '#7DDC8C', patScale: 2.4 }), 0, 0, 0, W).castShadow = false;
mesh(box(240, 0.1, 6.4), M('#D9CCF5', { pat: 1, patCol: '#C9B8F0', patScale: 1.6 }), 0, 0, 16.2, W).castShadow = false;
for (let x = -118; x < 118; x += 4.5) mesh(box(2.2, 0.02, 0.3), M('#FFFFFF'), x, 0.1, 16.2, W).castShadow = false;
mesh(box(240, 0.06, 0.5), M('#FFFFFF', { pat: 4, patCol: '#FF7EB3', patScale: 0.9 }), 0, 0.1, 19.6, W).castShadow = false;
mesh(box(60, 0.16, 3.0), M('#FFE6BD', { pat: 1, patCol: '#FFD39A', patScale: 0.7 }), 0, 0, 11.5, W).castShadow = false;
mesh(box(60, 0.22, 0.35), M('#FFFFFF', { pat: 4, patCol: '#5CC8FF', patScale: 0.9 }), 0, 0, 13.0, W).castShadow = false;

// ---------- 广场：18×12 块 2 m 地砖，四种状态，三圈波浪各换一次 ----------
const TILE_STATES = [
  [['#FFF3DA', '#FFE1A8'], ['#FFD9C2', '#FFC6A6']],   // 0 安静的奶油色
  [['#FF7EB3', '#FFC2DA'], ['#FFD234', '#FFF3A6']],   // 1 粉 + 黄
  [['#5CC8FF', '#B5E7FB'], ['#5EDFB0', '#C8F5E4']],   // 2 天蓝 + 薄荷
  [['#B9A0FF', '#E2D6FF'], ['#FFFFFF', '#FF9EC8']],   // 3 丁香紫 + 白粉条
];
const tileA = flat(TILE_STATES[0][0][0], { pat: 1, patCol: TILE_STATES[0][0][1], patScale: 0.5, col2: TILE_STATES[1][0][0], patCol2: TILE_STATES[1][0][1] });
const tileB = flat(TILE_STATES[0][1][0], { pat: 2, patCol: TILE_STATES[0][1][1], patScale: 0.7, col2: TILE_STATES[1][1][0], patCol2: TILE_STATES[1][1][1] });
const FOUNT = [0, -2.5];
const TILES = [];
const tileGeo = box(2, 0.2, 2);
for (let i = 0; i < 18; i++) for (let j = 0; j < 12; j++) {
  const x = -17 + i * 2, z = -13 + j * 2;
  if (Math.hypot(x - FOUNT[0], z - FOUNT[1]) < 4.9) continue;
  const m = mesh(tileGeo, (i + j) % 2 ? tileA : tileB, x, 0, z, W);
  TILES.push({ m, d: Math.hypot(x - TRUCK_STOP[0], z - TRUCK_STOP[1]) });
}
const onPlaza = (x, z) => x > -18 && x < 18 && z > -14 && z < 10;
// 波浪的地面起伏：先微微下沉（预备），隆起，再小小回落
function waveH(t, d) {
  let h = 0;
  for (const w of WAVES) {
    const u = t - (b(w) + d / WAVE_V);
    if (u < -0.2 || u > 0.7) continue;
    h += 1.05 * Math.exp(-(((u - 0.08) / 0.1) ** 2)) - 0.18 * Math.exp(-(((u + 0.05) / 0.045) ** 2)) - 0.22 * Math.exp(-(((u - 0.33) / 0.08) ** 2));
  }
  return h;
}
const dTruck = (x, z) => Math.hypot(x - TRUCK_STOP[0], z - TRUCK_STOP[1]);
// 道具沿径向吸附到 8 分音符圆环上：波浪正好在 8 分音符上打到它
function snap(x, z) {
  const dx = x - TRUCK_STOP[0], dz = z - TRUCK_STOP[1], d = Math.hypot(dx, dz);
  const k = Math.max(1, Math.round(d / WAVE_STEP)), s = k * WAVE_STEP / d;
  return [TRUCK_STOP[0] + dx * s, TRUCK_STOP[1] + dz * s, k * WAVE_STEP];
}
const PROPS = [];
function prop(g, amp, size, hop = 0) {
  const [x, z, d] = snap(g.position.x, g.position.z); g.position.x = x; g.position.z = z;
  const p = { g, d, amp, size, hop, x, z, base: g.position.y, plaza: onPlaza(x, z) }; PROPS.push(p); return p;
}

// ---------- 喷泉（大块安静的蓝） ----------
const fount = new THREE.Group(); fount.position.set(FOUNT[0], 0, FOUNT[1]); W.add(fount);
mesh(new THREE.CylinderGeometry(4.5, 4.5, 0.62, 56, 1, true).translate(0, 0.31, 0), M('#5EDFB0', { pat: 4, patCol: '#FFFFFF', patScale: 0.5 }), 0, 0, 0, fount);
mesh(new THREE.RingGeometry(3.9, 4.5, 56).rotateX(-Math.PI / 2), M('#FFFFFF', { pat: 1, patCol: '#FF9EC8', patScale: 0.32 }), 0, 0.62, 0, fount);
const inner = M('#3FA2E2', { lit: true }); inner.side = THREE.BackSide;
mesh(new THREE.CylinderGeometry(3.9, 3.9, 0.62, 56, 1, true).translate(0, 0.31, 0), inner, 0, 0, 0, fount);
mesh(new THREE.CircleGeometry(3.9, 56).rotateX(-Math.PI / 2), M('#72C9F3', { pat: 1, patCol: '#B5E7FB', patScale: 0.8 }), 0, 0.45, 0, fount).castShadow = false;
mesh(new THREE.CylinderGeometry(0.7, 0.9, 1.0, 24), M('#FFD234', { pat: 6, patCol: '#FF7EB3', patScale: 0.3 }), 0, 0.5, 0, fount);
const JETS = [0, 1, 2, 3].map((i) => NO(mesh(new THREE.SphereGeometry(0.42 - i * 0.07, 16, 12), M('#FFFFFF', { lit: true }), 0, 1.3 + i * 0.6, 0, fount)));
const RIPS = [0, 1, 2].map(() => NO(mesh(new THREE.RingGeometry(0.92, 1.0, 48).rotateX(-Math.PI / 2), M('#FFFFFF', { lit: true, shadow: false }), 0, 0.47, 0, fount)));
const pFount = prop(fount, 0.12, 'l');

// ---------- 树（五种树冠） ----------
const TRUNK = M('#A8705A');
const lt = (hex, k) => '#' + new THREE.Color(hex).lerp(new THREE.Color('#FFFFFF'), k).getHexString();
function tree(x, z, kind, col, pc, s = 1) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s); W.add(g);
  const main = M(col, { pat: 1, patCol: pc, patScale: 0.7 }), hi = M(lt(col, 0.3), { pat: 1, patCol: lt(pc, 0.25), patScale: 0.55 });
  const th = kind === 'column' ? 1.5 : 2.1;
  mesh(new THREE.CylinderGeometry(0.2, 0.36, th, 8).translate(0, th / 2, 0), TRUNK, 0, 0, 0, g);
  const br = mesh(new THREE.CylinderGeometry(0.08, 0.12, 1.0, 6).translate(0, 0.5, 0), TRUNK, 0.05, th * 0.55, 0, g); br.rotation.z = -0.75;
  const c = new THREE.Group(); c.position.y = th; g.add(c);
  const L = (geo, mat, px, py, pz) => mesh(geo, mat, px, py, pz, c);
  if (kind === 'cloud') {
    for (const [dx, dy, dz, r] of [[0, 1.7, 0, 1.45], [1.15, 1.05, 0.35, 1.1], [-1.05, 1.15, -0.3, 1.15], [0.25, 2.5, -0.35, 1.0], [-0.4, 1.0, 0.95, 0.95]]) L(new THREE.SphereGeometry(r, 18, 12), main, dx, dy, dz);
    for (const [dx, dy, dz, r] of [[-0.75, 2.35, 0.6, 0.62], [-1.45, 1.6, 0.5, 0.5]]) L(new THREE.SphereGeometry(r, 14, 10), hi, dx, dy, dz);
  }
  if (kind === 'round') { L(new THREE.SphereGeometry(1.85, 22, 14).scale(1, 0.92, 1), main, 0, 1.5, 0); L(new THREE.SphereGeometry(0.85, 14, 10), hi, -0.85, 2.3, 0.78); L(new THREE.SphereGeometry(0.52, 12, 8), hi, -1.48, 1.55, 0.6); }
  if (kind === 'egg') { L(new THREE.SphereGeometry(1.45, 18, 12).scale(0.85, 1.35, 0.85), main, 0, 1.8, 0); L(new THREE.SphereGeometry(0.6, 14, 10).scale(0.85, 1.25, 0.85), hi, -0.55, 2.5, 0.5); }
  if (kind === 'cone') { for (const [r, h, y] of [[1.9, 2.0, 0.9], [1.5, 1.8, 2.0], [1.05, 1.6, 3.0]]) L(new THREE.ConeGeometry(r, h, 18), main, 0, y, 0); L(new THREE.SphereGeometry(0.3, 10, 8), hi, 0, 3.85, 0); }
  if (kind === 'column') { L(new THREE.CapsuleGeometry(0.9, 2.6, 6, 14), main, 0, 2.0, 0); L(new THREE.CapsuleGeometry(0.38, 1.3, 6, 10), hi, -0.55, 2.6, 0.45); }
  const p = prop(g, 0.2, 'm'); p.crown = c; p.ph = R() * 6.28; return p;
}
const TREES = [
  tree(-16.5, -12, 'cloud', '#FF9EC8', '#FF7FAA', 1.05), tree(16.5, -12, 'round', '#FFD234', '#F3B51A', 1.0),
  tree(-21.5, 2, 'cone', '#2FCB7A', '#1FA862', 1.0), tree(21.5, 3, 'egg', '#FF6F61', '#E8463C', 1.05),
  tree(-9, -18, 'column', '#14B8A0', '#0E9A86', 1.0), tree(9.5, -18, 'cloud', '#B9A0FF', '#9C86E0', 1.0),
  tree(-26, -8, 'round', '#5EDFB0', '#3CBE7E', 1.1), tree(26, -9, 'cone', '#FF9C6B', '#FF7A45', 1.1),
  tree(-27, 8, 'egg', '#FFD234', '#F3B51A', 1.0), tree(27.5, 8.5, 'column', '#FF7EB3', '#FF5A9A', 1.0),
  tree(-35, -2, 'cloud', '#2FCB7A', '#1FA862', 1.1), tree(35, -3, 'round', '#FF9EC8', '#FF7FAA', 1.15),
];

// ---------- 长椅、路灯、雕塑 ----------
function bench(x, z, col, pc) {
  const g = new THREE.Group(); g.position.set(x, 0, z); W.add(g);
  const c = M(col, { pat: 4, patCol: pc, patScale: 0.35 }), leg = M('#4A4468');
  mesh(box(2.6, 0.18, 0.8), c, 0, 0.6, 0, g); mesh(box(2.6, 0.6, 0.16), c, 0, 0.85, -0.38, g);
  for (const s of [-1, 1]) mesh(box(0.16, 0.6, 0.7), leg, s * 1.05, 0, 0, g);
  const p = prop(g, 0.28, 's', 0.6);
  g.rotation.y = Math.atan2(FOUNT[0] - p.x, FOUNT[1] - p.z);
  return p;
}
bench(-8, 5.5, '#2F5BFF', '#5CC8FF'); bench(8, 5.5, '#FF5A5F', '#FFB0B2'); bench(-8.5, -10.5, '#FFD234', '#FFFFFF'); bench(8.5, -10.5, '#B9A0FF', '#FFFFFF');
function lamp(x, z) {
  const g = new THREE.Group(); g.position.set(x, 0, z); W.add(g);
  mesh(new THREE.CylinderGeometry(0.16, 0.24, 4.2, 10).translate(0, 2.1, 0), M('#2F5BFF', { pat: 6, patCol: '#5CC8FF', patScale: 0.4 }), 0, 0, 0, g);
  mesh(new THREE.SphereGeometry(0.5, 16, 12), M('#FFF3A6', { pat: 1, patCol: '#FFFFFF', patScale: 0.2 }), 0, 4.5, 0, g);
  return prop(g, 0.22, 's', 0.4);
}
lamp(-14, 8.5); lamp(14, 8.5); lamp(-14.5, -9); lamp(14.5, -9);
{ // 粉色半拱 + 斑点
  const g = new THREE.Group(); g.position.set(-11.5, 0, -3.5); W.add(g);
  mesh(new THREE.TorusGeometry(2.2, 0.55, 14, 36, Math.PI), M('#FF7EB3', { pat: 1, patCol: '#FFFFFF', patScale: 0.35 }), 0, 0, 0, g);
  prop(g, 0.18, 'm');
}
{ // 条纹柱顶黄球
  const g = new THREE.Group(); g.position.set(11.5, 0, -3.5); W.add(g);
  mesh(new THREE.CylinderGeometry(0.55, 0.55, 3.2, 20).translate(0, 1.6, 0), M('#FFFFFF', { pat: 6, patCol: '#2F5BFF', patScale: 0.45 }), 0, 0, 0, g);
  mesh(new THREE.SphereGeometry(1.0, 20, 14), M('#FFD234', { pat: 1, patCol: '#FFF3A6', patScale: 0.3 }), 0, 4.1, 0, g);
  prop(g, 0.2, 'm', 0.5);
}
{ // 薄荷色锯齿矮墙
  const g = new THREE.Group(); g.position.set(0, 0, -11.5); W.add(g);
  for (let i = 0; i < 6; i++) { const m = mesh(box(1.5, 1.0 + (i % 2) * 0.8, 0.5), M(i % 2 ? '#5EDFB0' : '#2F5BFF', { pat: 3, patCol: '#FFFFFF', patScale: 0.5 }), -3.75 + i * 1.5, 0, 0, g); }
  prop(g, 0.16, 'm');
}

// ---------- 北面一排小楼 ----------
const WALLS = ['#FFEFA8', '#FFB8D9', '#5EDFB0', '#B9A0FF', '#FF9C6B', '#5CC8FF'];
const ROOFS = ['#FF5A5F', '#2F5BFF', '#FFD234', '#14B8A0', '#FF7EB3', '#4A4468'];
[[-30, 9, 7.5], [-19, 10, 10.5], [-8, 9, 8], [3, 10, 11.5], [14, 9, 8.5], [25, 10, 10], [36, 9, 7]].forEach(([x, w, h], i) => {
  const g = new THREE.Group(); g.position.set(x, 0, -26); W.add(g);
  mesh(box(w + 0.6, 0.5, 7.2), M('#FFFFFF', { pat: 6, patCol: '#E2D6FF', patScale: 0.3 }), 0, 0, 0, g);
  mesh(box(w, h, 6.4), M(WALLS[i % 6], { pat: i % 2 ? 4 : 1, patCol: lt(WALLS[i % 6], 0.45), patScale: i % 2 ? 0.7 : 0.6, win: true, y0: 0.5, y1: h + 0.5, seed: i }), 0, 0.5, 0, g);
  mesh(box(w + 0.8, 0.6, 7.0), M(ROOFS[i % 6], { pat: 1, patCol: lt(ROOFS[i % 6], 0.4), patScale: 0.5 }), 0, h + 0.5, 0, g);
  const aw = mesh(box(w * 0.7, 0.12, 1.4), M('#FFFFFF', { pat: 4, patCol: ROOFS[(i + 2) % 6], patScale: 0.5 }), 0, 3.4, 3.7, g); aw.rotation.x = 0.28;
  if (i % 2 === 0) mesh(new THREE.SphereGeometry(0.9, 16, 12), M(ROOFS[(i + 3) % 6], { pat: 1, patCol: '#FFFFFF', patScale: 0.25 }), w * 0.25, h + 1.6, 0, g);
  else mesh(new THREE.ConeGeometry(1.0, 1.8, 4), M(WALLS[(i + 2) % 6], { pat: 2, patCol: '#FFFFFF', patScale: 0.3 }), -w * 0.25, h + 1.9, 0, g);
  prop(g, 0.07, 'b');
});

// ---------- 远处的行人（只做装饰） ----------
const WALKERS = [
  { col: '#FF5A5F', hat: '#FFD234', r: 7.4, ph: 0.3, sp: 0.16 }, { col: '#2F5BFF', hat: null, r: 7.8, ph: 2.4, sp: -0.14 },
  { col: '#FFD234', hat: '#FF7EB3', r: 11.5, ph: 4.0, sp: 0.1 }, { col: '#14B8A0', hat: '#FFFFFF', r: 12.2, ph: 1.2, sp: -0.09 },
  { col: '#B9A0FF', hat: null, r: 9.6, ph: 5.3, sp: 0.12 },
].map((o) => ({ ...o, p: person(W, o) }));

// ---------- 冰淇淋车 ----------
const TG = new THREE.Group(); W.add(TG);                 // 车（x 向前）
const SUS = new THREE.Group(); SUS.position.y = 0.55; TG.add(SUS);   // 悬挂以上（蹲-弹、点头都作用在这里）
const BODYX = -0.75;                                      // 车厢中心相对车的 x
const PINK = M('#FF7EB3', { pat: 4, patCol: '#FFA6CB', patScale: 0.55 });
mesh(box(7.4, 0.45, 2.6), M('#4A4468'), 0, 0, 0, SUS);
// 驾驶室
mesh(box(1.5, 2.0, 2.5), M('#FFD234', { pat: 1, patCol: '#FFF3A6', patScale: 0.3 }), 2.95, 0.45, 0, SUS);
mesh(box(1.3, 0.25, 2.3), M('#FF5A5F'), 2.85, 2.45, 0, SUS);
mesh(box(0.05, 0.75, 2.1), M('#BFE4FF', { lit: true }), 3.71, 1.55, 0, SUS);
mesh(box(0.9, 0.7, 0.04), M('#BFE4FF', { lit: true }), 2.9, 1.5, 1.26, SUS);
mesh(box(0.9, 0.7, 0.04), M('#BFE4FF', { lit: true }), 2.9, 1.5, -1.26, SUS);
mesh(new THREE.SphereGeometry(0.22, 12, 10), M('#FFFFFF', { lit: true }), 3.72, 0.85, 0.85, SUS);
mesh(new THREE.SphereGeometry(0.22, 12, 10), M('#FFFFFF', { lit: true }), 3.72, 0.85, -0.85, SUS);
mesh(box(0.25, 0.3, 2.7), M('#FFFFFF', { pat: 6, patCol: '#2F5BFF', patScale: 0.12 }), 3.75, 0.25, 0, SUS);
// 车厢：地板、远墙、后墙、隔墙、车顶（车顶不投影，剖开时里面不被整片罩黑）
const INNER = { shadow: true };
mesh(box(5.9, 0.25, 2.5), M('#FFFFFF', { pat: 1, patCol: '#FFC2DA', patScale: 0.3, ...INNER }), BODYX, 0.45, 0, SUS);
mesh(box(5.9, 2.4, 0.15), M('#FFF1F7', { pat: 3, patCol: '#FFC2DA', patScale: 0.45, ...INNER }), BODYX, 0.7, -1.175, SUS);
mesh(box(5.9, 2.4, 0.04), PINK, BODYX, 0.7, -1.27, SUS);
mesh(box(0.15, 2.4, 2.5), M('#E2D6FF', { pat: 1, patCol: '#FFFFFF', patScale: 0.3 }), BODYX - 2.875, 0.7, 0, SUS);
mesh(box(0.15, 2.4, 2.5), M('#E2D6FF', { pat: 1, patCol: '#FFFFFF', patScale: 0.3 }), BODYX + 2.875, 0.7, 0, SUS);
mesh(box(0.04, 2.4, 2.6), PINK, BODYX - 2.97, 0.7, 0, SUS);
const roof = mesh(box(6.1, 0.28, 2.7), M('#5EDFB0', { pat: 1, patCol: '#C8F5E4', patScale: 0.45 }), BODYX, 3.1, 0, SUS); roof.castShadow = false;
const ROOFTOP = 0.55 + 3.38;
// 剖切面（STYLE §8：剖面一律画成带剖面线的平色，深一级）
const CUT = M('#C9B8F0', { pat: 5, patCol: '#25214A', patScale: 0.22, lit: true });
mesh(box(5.9, 0.25, 0.02), CUT, BODYX, 0.45, 1.26, SUS);
mesh(box(0.15, 2.4, 0.02), CUT, BODYX - 2.875, 0.7, 1.26, SUS);
mesh(box(0.15, 2.4, 0.02), CUT, BODYX + 2.875, 0.7, 1.26, SUS);
mesh(box(5.9, 0.14, 0.02), CUT, BODYX, 2.96, 1.26, SUS);
// 车顶喇叭（八音盒小调从这里放出来）
const horn = new THREE.Group(); horn.position.set(BODYX + 2.4, 3.38, 0); SUS.add(horn);
mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.5, 8).translate(0, 0.25, 0), M('#4A4468'), 0, 0, 0, horn);
const hornBell = mesh(new THREE.ConeGeometry(0.42, 0.8, 18, 1, true).rotateZ(Math.PI / 2), M('#FFD234', { pat: 6, patCol: '#FF5A5F', patScale: 0.15 }), 0.25, 0.65, 0, horn);
hornBell.material.side = THREE.DoubleSide;
// 车顶天窗两扇（弹出时翻开）
const FLAPS = [-1, 1].map((s) => {
  const h = new THREE.Group(); h.position.set(BODYX + s * 1.3, 3.38, 0); SUS.add(h);
  mesh(box(1.3, 0.12, 2.0), M('#FFD234', { pat: 2, patCol: '#FFFFFF', patScale: 0.3 }), -s * 0.65, 0, 0, h);
  return { h, s };
});
// 轮子
const WHEELS = [[-2.5, 1.3], [-2.5, -1.3], [2.6, 1.3], [2.6, -1.3]].map(([x, z]) => {
  const g = new THREE.Group(); g.position.set(x, 0.55, z); TG.add(g);
  mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.42, 22).rotateX(Math.PI / 2), M('#2B2840'), 0, 0, 0, g);
  mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.46, 16).rotateX(Math.PI / 2), M('#FFFFFF'), 0, 0, 0, g);
  mesh(box(0.5, 0.1, 0.5).translate(0, -0.05, 0), M('#FF5A5F'), 0, 0, 0, g);
  return g;
});
// 近侧侧板（剖开时两步走：先外移，再升出画面）
const PANEL = new THREE.Group(); SUS.add(PANEL);
mesh(box(5.9, 2.65, 0.15), PINK, BODYX, 0.45, 1.2, PANEL);
mesh(box(1.9, 1.15, 0.05), M('#25214A'), BODYX + 0.9, 1.55, 1.29, PANEL);
mesh(box(1.72, 0.98, 0.05), M('#BFE4FF', { lit: true }), BODYX + 0.9, 1.635, 1.31, PANEL);
const awn = mesh(box(2.3, 0.08, 0.8), M('#FFFFFF', { pat: 4, patCol: '#FF5A5F', patScale: 0.35 }), BODYX + 0.9, 2.82, 1.62, PANEL); awn.rotation.x = 0.3;
{ // 车身画的甜筒徽记
  const sh = new THREE.Shape(); sh.moveTo(-0.45, 0.25); sh.lineTo(0.45, 0.25); sh.lineTo(0, -0.75); sh.closePath();
  mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.04, bevelEnabled: false }), M('#F2B35A', { pat: 2, patCol: '#D98E3A', patScale: 0.12, lit: true }), BODYX - 1.6, 2.0, 1.28, PANEL);
  mesh(new THREE.CircleGeometry(0.5, 28), M('#FFFFFF', { pat: 1, patCol: '#FF9EC8', patScale: 0.12, lit: true }), BODYX - 1.6, 2.55, 1.315, PANEL);
  mesh(new THREE.CircleGeometry(0.16, 20), M('#FF5A5F', { lit: true }), BODYX - 1.6, 3.05, 1.32, PANEL);
}

// ---------- 车厢里：①奶油桶 ②甜筒接料 ③撒糖 ----------
const IN = new THREE.Group(); SUS.add(IN);
const TANKX = -2.75, NOZX = -1.45, SHAKX = -0.05, ENDX = 1.3, BELTY = 1.45;
{ // 奶油桶：后半个桶壳（剖开）+ 半圆柱奶油（剖面线）
  const shell = M('#5CC8FF', { pat: 6, patCol: '#B5E7FB', patScale: 0.25 }); shell.side = THREE.DoubleSide;
  mesh(new THREE.CylinderGeometry(0.66, 0.66, 1.7, 28, 1, true, Math.PI / 2, Math.PI).translate(0, 0.85, 0), shell, TANKX, 0.7, 0, IN);
  for (const s of [-1, 1]) mesh(box(0.06, 1.7, 0.06), CUT, TANKX + s * 0.66, 0.7, 0, IN);
  mesh(box(1.5, 0.12, 0.12), CUT, TANKX, 2.4, 0.0, IN);
  mesh(box(0.7, 0.4, 0.5), M('#4A4468'), TANKX, 2.52, -0.3, IN);
}
const half = new THREE.Shape(); half.absarc(0, 0, 0.6, Math.PI, 2 * Math.PI, false); half.closePath();
const CREAM = mesh(new THREE.ExtrudeGeometry(half, { depth: 1.1, bevelEnabled: false, curveSegments: 24 }).rotateX(-Math.PI / 2), M('#FFF7EC', { pat: 5, patCol: '#FFB8D9', patScale: 0.18 }), TANKX, 0.75, 0, IN);
const LUMPS = [0, 1, 2, 3].map((i) => mesh(new THREE.SphereGeometry(0.16, 12, 8).scale(1, 0.6, 1), M('#FFB8D9', { pat: 1, patCol: '#FFFFFF', patScale: 0.08 }), TANKX, 1.85, -0.3, IN));
const pipe = new THREE.CatmullRomCurve3([V3(TANKX, 2.4, -0.3), V3(TANKX, 2.95, -0.25), V3(-2.2, 3.0, 0.05), V3(NOZX, 2.95, 0.25), V3(NOZX, 2.75, 0.3)]);
mesh(new THREE.TubeGeometry(pipe, 40, 0.09, 10), M('#2F5BFF', { pat: 6, patCol: '#5CC8FF', patScale: 0.15 }), 0, 0, 0, IN);
const NOZ = mesh(new THREE.ConeGeometry(0.2, 0.36, 8).rotateX(Math.PI), M('#E2D6FF', { pat: 4, patCol: '#FFFFFF', patScale: 0.08 }), NOZX, 2.62, 0.3, IN);
// 传送带
mesh(box(4.6, 0.18, 0.9), M('#4A4468', { pat: 4, patCol: '#6B6390', patScale: 0.3 }), -0.1, BELTY - 0.18, 0.3, IN);
for (const x of [-2.1, 1.9]) mesh(box(0.2, BELTY - 0.88, 0.7), M('#B9A0FF'), x, 0.7, 0.3, IN);
const SLATS = Array.from({ length: 12 }, () => mesh(box(0.1, 0.03, 0.86), M('#8D86C0'), 0, BELTY, 0.3, IN));
// 撒糖罐（吊在顶上）
const JAR = new THREE.Group(); JAR.position.set(SHAKX, 3.08, 0.3); IN.add(JAR);
mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.35, 6).translate(0, -0.17, 0), M('#4A4468'), 0, 0, 0, JAR);
mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 18).translate(0, -0.6, 0), M('#FFD234', { pat: 6, patCol: '#FF5A5F', patScale: 0.1 }), 0, 0, 0, JAR);
mesh(new THREE.CylinderGeometry(0.18, 0.24, 0.12, 18).translate(0, -0.91, 0), M('#FFFFFF', { pat: 1, patCol: '#FF5A5F', patScale: 0.05 }), 0, 0, 0, JAR);
// 收尾小台
mesh(new THREE.CylinderGeometry(0.35, 0.42, 0.25, 20), M('#FF9C6B', { pat: 1, patCol: '#FFFFFF', patScale: 0.12 }), ENDX, BELTY, 0.3, IN);
// 小甜筒 + 螺旋奶油（挤出时 drawRange 增长）+ 糖针
const CONE = new THREE.Group(); IN.add(CONE);
const WAFFLE = M('#F2B35A', { pat: 2, patCol: '#D98E3A', patScale: 0.1 });
mesh(new THREE.ConeGeometry(0.3, 0.72, 20).rotateX(Math.PI).translate(0, 0.36, 0), WAFFLE, 0, 0, 0, CONE);
mesh(new THREE.CylinderGeometry(0.32, 0.3, 0.08, 20), M('#E9A04E'), 0, 0.72, 0, CONE);
const helix = new THREE.Curve(); helix.getPoint = (s, tgt = new THREE.Vector3()) => { const a = s * Math.PI * 2 * 3.1, r = 0.25 * (1 - s * 0.82); return tgt.set(Math.cos(a) * r, 0.82 + s * 0.6, Math.sin(a) * r); };
const swGeo = new THREE.TubeGeometry(helix, 240, 0.12, 10); const SW_N = swGeo.index.count;
const SWIRL = mesh(swGeo, M('#FFB8D9', { pat: 1, patCol: '#FFFFFF', patScale: 0.07 }), 0, 0, 0, CONE);
const SPR_C = ['#FF5A5F', '#2F5BFF', '#FFD234', '#5EDFB0', '#FFFFFF', '#B9A0FF'];
const SPR = Array.from({ length: 34 }, (_, i) => {
  const s = 0.15 + 0.8 * R(), a = R() * 6.28, r = 0.25 * (1 - s * 0.82) + 0.12;
  const land = V3(Math.cos(a) * r * 0.9, 0.82 + s * 0.6 + 0.08, Math.sin(a) * r * 0.9);
  const m = NO(mesh(new THREE.CapsuleGeometry(0.022, 0.07, 2, 6), M(SPR_C[i % 6], { lit: true, shadow: false }), 0, 0, 0, CONE));
  m.rotation.set(R() * 3, R() * 3, R() * 3);
  return { m, land, t0: b(CUE.sprinkle) + 0.04 + i * 0.022, x0: (R() - 0.5) * 0.25, z0: (R() - 0.5) * 0.25 };
});

// ---------- 巨型冰淇淋（车顶弹出） ----------
const GC = new THREE.Group(); GC.position.set(BODYX, 3.38, 0); SUS.add(GC);
mesh(new THREE.ConeGeometry(2.0, 3.8, 32).rotateX(Math.PI).translate(0, 1.6, 0), M('#F2B35A', { pat: 2, patCol: '#D98E3A', patScale: 0.42 }), 0, 0, 0, GC);
mesh(new THREE.CylinderGeometry(2.15, 2.0, 0.42, 32), M('#E9A04E', { pat: 5, patCol: '#C97B2E', patScale: 0.25 }), 0, 3.6, 0, GC);
const prof = []; const tiers = [[3.8, 2.35], [5.0, 1.9], [6.1, 1.42], [7.0, 0.95], [7.7, 0.15]];
for (let i = 0; i <= 60; i++) {
  const y = 3.8 + i / 60 * 3.9;
  let r = 0; for (let k = 0; k < tiers.length - 1; k++) { const [y0, r0] = tiers[k], [y1, r1] = tiers[k + 1]; if (y >= y0 && y <= y1) { const u = (y - y0) / (y1 - y0); r = lerp(r0, r1, u) + Math.sin(u * Math.PI) * 0.32 * (1 - k * 0.18); } }
  prof.push(new THREE.Vector2(Math.max(r, 0.02), y));
}
prof.unshift(new THREE.Vector2(0.01, 3.8));
const GSW = mesh(new THREE.LatheGeometry(prof, 48), M('#FF9EC8', { pat: 1, patCol: '#FFFFFF', patScale: 0.42 }), 0, 0, 0, GC);
mesh(new THREE.SphereGeometry(0.62, 22, 16), M('#FF5A5F', { pat: 1, patCol: '#FFB0B2', patScale: 0.18 }), 0.08, 8.15, 0.05, GC);
const stem = mesh(new THREE.CapsuleGeometry(0.09, 0.7, 4, 8), M('#2FCB7A'), 0.25, 8.85, 0, GC); stem.rotation.z = -0.4;
for (let i = 0; i < 46; i++) {
  const yy = 4.0 + R() * 3.3, a = R() * 6.28; let r = 0;
  for (const v of prof) if (v.y <= yy) r = v.x;
  const m = NO(mesh(new THREE.CapsuleGeometry(0.075, 0.26, 2, 6), M(SPR_C[i % 6], { lit: true, shadow: false }), Math.cos(a) * (r + 0.02), yy, Math.sin(a) * (r + 0.02), GC));
  m.rotation.set(R() * 3, R() * 3, R() * 3);
}
// 弹出后的糖针雨（无描边粒子）
const RAIN = Array.from({ length: 70 }, (_, i) => {
  const m = NO(mesh(new THREE.CapsuleGeometry(0.09, 0.32, 2, 6), M(SPR_C[i % 6], { lit: true, shadow: false }), 0, -50, 0, W));
  const a = R() * 6.28, sp = 5 + R() * 9;
  return { m, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp * 0.7, vy: 9 + R() * 8, rx: R() * 9, ry: R() * 9, t0: b(CUE.pop) + R() * 0.15 };
});

// ---------- 时间函数 ----------
const V0 = 18, TB = b(CUE.truckBrake), TS = b(CUE.truckStop), XS = TRUCK_STOP[0] - BODYX;
function truckX(t) {
  const brakeD = V0 * (TS - TB) / 2;
  if (t >= TS) return XS;
  if (t >= TB) { const u = t - TB, T = TS - TB; return XS - brakeD + V0 * u - V0 * u * u / (2 * T); }
  return XS - brakeD - V0 * (TB - t);
}
const truckSpeed = (t) => t >= TS ? 0 : t >= TB ? V0 * (1 - (t - TB) / (TS - TB)) : V0;
function truckSY(t) {   // 车身 y 缩放
  let d = sq(t, TS, 0.14, 0.4) + sq(t, b(CUE.horn), 0.07) + sq(t, b(CUE.lidOut), 0.05);
  const s0 = b(CUE.squatStart), s1 = b(CUE.pop);
  if (t >= s0 && t < s1) d += -0.3 * io(seg(t, s0, b(CUE.squatDeep))) + (t > b(28.5) ? 0.004 * Math.sin(t * 190) * seg(t, b(28.5), s1) : 0);
  if (t >= s1) { const u = t - s1; d += -0.3 * Math.cos(2 * Math.PI * u / 0.32) * Math.exp(-u / 0.24); }
  return 1 + d;
}
function truckPitch(t) {  // 刹车点头
  if (t < TB) return 0;
  if (t < TS) return -0.05 * sm(seg(t, TB, TB + 0.3));
  const u = t - TS; return -0.05 * Math.cos(2 * Math.PI * u / 0.42) * Math.exp(-u / 0.26);
}
function panelPos(t) {     // [z 外移, y 升起]
  const out = 0.7 * (eo(seg(t, b(CUE.lidOut) - 0.12, b(CUE.lidOut) + 0.18)) - sm(seg(t, b(CUE.lidIn) - 0.2, b(CUE.lidIn))));
  const up = 7.5 * (ei(seg(t, b(CUE.lidUp), b(CUE.lidUp) + 0.55)) - eo(seg(t, b(CUE.lidDown) - 0.25, b(CUE.lidDown) + 0.25)));
  return [Math.max(0, out), Math.max(0, up)];
}
function coneX(t) {
  const k = [[b(CUE.cone) - 0.5, -2.05], [b(CUE.cone), NOZX], [b(CUE.sprinkle) - 0.5, NOZX], [b(CUE.sprinkle), SHAKX], [b(CUE.finished) - 0.5, SHAKX], [b(CUE.finished), ENDX]];
  if (t <= k[0][0]) return k[0][1];
  for (let i = 0; i < k.length - 1; i++) if (t < k[i + 1][0]) { const u = (t - k[i][0]) / (k[i + 1][0] - k[i][0]); return lerp(k[i][1], k[i + 1][1], k[i][1] === k[i + 1][1] ? 0 : io(u)); }
  return k[k.length - 1][1];
}
const swirlFill = (t) => eo(seg(t, b(CUE.cone) + 0.05, b(CUE.cone) + 1.35));
function gcScale(t) {     // 巨型冰淇淋：弹出 + 两次回弹
  const T = b(CUE.pop); if (t < T - 1e-6) return [0, 0];
  const u = Math.max(0, t - T);
  const s = 1 - 0.88 * Math.cos(2 * Math.PI * u / 0.5) * Math.exp(-u / 0.26);
  const d = sq(t, b(CUE.bounce1), 0.16, 0.18, 0.3, 0.22) + sq(t, b(CUE.bounce2), 0.12, 0.18, 0.3, 0.22);
  const sy = s * (1 + d), sx = s / Math.sqrt(Math.max(0.3, 1 + d));
  return [sx, sy];
}
const flapA = (t) => (Math.PI * 0.62) * eo(seg(t, b(CUE.pop), b(CUE.pop) + 0.12));

// ---------- 相机：一个连续镜头，七段运镜 ----------
const sph = (az, el, D) => V3(Math.sin(az) * Math.cos(el) * D, Math.sin(el) * D, Math.cos(az) * Math.cos(el) * D);
const DEG = Math.PI / 180;
const BX = TRUCK_STOP[0];   // 车厢中心 x
const lookLat = (t) => {    // 横移：沿剖面从奶油桶到成品台
  const k = [[b(15.5), BX + TANKX - BODYX + 0.3], [b(16.6), BX + TANKX - BODYX + 0.4], [b(18.2), BX + NOZX - BODYX], [b(20.2), BX + SHAKX - BODYX], [b(22.3), BX + ENDX - BODYX - 0.2], [b(25), BX + ENDX - BODYX - 0.5]];
  if (t <= k[0][0]) return k[0][1];
  for (let i = 0; i < k.length - 1; i++) if (t < k[i + 1][0]) return lerp(k[i][1], k[i + 1][1], io((t - k[i][0]) / (k[i + 1][0] - k[i][0])));
  return k[k.length - 1][1];
};
function shot(t) {          // → { look, az, el, D }
  // 返修：跟车段最后 1 s 机位向车靠近（D 75→62、看点向车偏），b6 刹停点头时车身更大、"车是波浪的起因"更好读；
  // 环绕段前半再退回 70，把两圈波浪覆盖全场的画面让出来（距离、看点都连续，无跳变）
  if (t < b(6)) { const u = t / b(6), v = sm(seg(t, b(4), b(6))); return { look: V3(-18 + 17.4 * sm(u), 0, 4 + 5 * v), az: 20 * DEG, el: 32 * DEG, D: lerp(80, 75, u) - 13 * v }; }
  if (t < b(12.5)) { const u = io(seg(t, b(6), b(12.5))), w = sm(seg(t, b(6.5), b(10))); return { look: V3(lerp(-0.6, 0, w), 0, lerp(9, 2, w)), az: lerp(20, 4, u) * DEG, el: lerp(32, 30, u) * DEG, D: lerp(62, 70, w) }; }
  const CUTL = (x) => V3(x, 2.45, TRUCK_STOP[1] + 0.3), CUTA = { az: 6 * DEG, el: 15 * DEG, D: 9.6 };
  if (t < b(15.5)) { const u = io(seg(t, b(12.5), b(15.5))); const A = { look: V3(0, 0, 2), az: 4 * DEG, el: 30 * DEG, D: 70 };
    return { look: A.look.clone().lerp(CUTL(lookLat(t)), u), az: lerp(A.az, CUTA.az, u), el: lerp(A.el, CUTA.el, Math.pow(u, 0.7)), D: Math.exp(lerp(Math.log(A.D), Math.log(CUTA.D), u)) }; }
  if (t < b(26)) return { look: CUTL(lookLat(t)), az: CUTA.az, el: CUTA.el, D: CUTA.D };
  // 静默：先轻轻退出来把整辆车（侧板已合上）放进画面，再极慢推近，看它一点点蹲紧
  const silL = V3(BX + 0.3, 2.1, TRUCK_STOP[1]);
  if (t < b(30)) {
    const u1 = io(seg(t, b(26), b(27.5))), u2 = io(seg(t, b(27.5), b(30)));
    return { look: CUTL(lookLat(t)).lerp(silL, u1), az: (lerp(6, 11, u1) + 2 * u2) * DEG, el: lerp(15, 12, u1) * DEG, D: lerp(CUTA.D, 14, u1) - 1.8 * u2 };
  }
  // 弹出：升降 + 急拉远（前 0.2 s 就把整支冰淇淋放进画面），然后锁定微漂
  const popL = V3(BX, 5.6, TRUCK_STOP[1] - 0.5);
  if (t < b(32.5)) { const x = seg(t, b(30), b(32.5)), u = 1 - Math.pow(1 - x, 4); const lk = silL.clone().lerp(popL, u); lk.y += Math.max(0, gcScale(t)[1] - 0.8) * 6; return { look: lk, az: lerp(13, 16, u) * DEG, el: lerp(12, 15, u) * DEG, D: lerp(12.2, 40, u) }; }
  const u = sm(seg(t, b(32.5), DUR)); const lk = popL.clone(); lk.y += Math.max(0, gcScale(t)[1] - 0.8) * 6;   // 返修：与上一段同一个"骑过冲"项，b32.5 交接处连续
  return { look: lk, az: lerp(16, 23, u) * DEG, el: 15 * DEG, D: lerp(40, 37.5, u) };
}
// 返修：弹出后头几帧冰淇淋球顶曾被画框上沿裁掉。巨型冰淇淋顶点挂一个锚点；弹出窗口里若顶点高过画框上沿（留 50 px），
// 先把机位连同看点升高到刚好放得下（升降），若升高后车身离开画框下沿，再加大距离（拉远），取能同时放下"整辆车 + 整支冰淇淋"的最小距离。
// 升高量与距离都是时间的连续函数，镜头仍是一条连续的"骑过冲"升降 + 拉远，不会跳。
const GTOP = new THREE.Object3D(); GTOP.position.set(0, 9.3, 0); GC.add(GTOP);
const GROUND = V3(BX, 0, TRUCK_STOP[1] + 1.0);
function setCam(t) {
  const s = shot(t);
  const apply = () => {
    dio.cam.fov = 30; dio.cam.position.copy(s.look).add(sph(s.az, s.el, s.D)); dio.cam.up.set(0, 1, 0); dio.cam.lookAt(s.look);
    dio.cam.setViewOffset(1920, 1080, 0, 1080 / 2 - FRAME.cy, 1920, 1080);   // 看点落在画框中心（画框略高于画面中心）
    dio.cam.updateProjectionMatrix(); dio.cam.updateMatrixWorld();
  };
  apply();
  if (t >= b(CUE.pop) && GC.visible) {          // 弹出之后一直生效（窗口若在 b32.5 截断，第二次回弹的约束会在交接处突然松开而跳一下）
    const top = GTOP.getWorldPosition(V3(0, 0, 0)), yMax = FRAME.cy - FRAME.hh + 50, yMin = FRAME.cy + FRAME.hh - 30;
    const yOf = (p) => { const v = p.clone().project(dio.cam); return (1 - v.y) / 2 * 1080; };
    if (yOf(top) < yMax) {
      const y0 = s.look.y, D0 = s.D;
      const lift = (D) => {          // 距离 D 下放得下顶点所需的最小升高量
        s.D = D; s.look.y = y0; apply(); if (yOf(top) >= yMax) return 0;
        let lo = 0, hi = 12; for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; s.look.y = y0 + m; apply(); if (yOf(top) < yMax) lo = m; else hi = m; }
        s.look.y = y0 + hi; apply(); return hi;
      };
      lift(D0);
      if (yOf(GROUND) > yMin) {      // 车被挤出下沿 → 找最小的拉远距离
        let lo = D0, hi = D0 * 4;
        for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; lift(m); if (yOf(GROUND) > yMin) lo = m; else hi = m; }
        lift(hi);
      }
    }
  }
  return s;
}
const toScreen = (p) => { const v = p.clone().project(dio.cam); return [(v.x + 1) / 2 * 1920, (1 - v.y) / 2 * 1080]; };

// ---------- 摆好时刻 t 的世界 ----------
function place(t) {
  // 波浪颜色：第 i 圈正在走 → 圈内是新状态
  let wi = 0; for (const w of WAVES) if (t >= b(w)) wi++;
  const sA = TILE_STATES[Math.max(0, wi - 1)], sB = TILE_STATES[Math.min(TILE_STATES.length - 1, Math.max(1, wi))];
  const cur = wi === 0 ? TILE_STATES[0] : sA, nxt = wi === 0 ? TILE_STATES[1] : sB;
  for (const [m, k] of [[tileA, 0], [tileB, 1]]) { m.uniforms.uCol.value.set(cur[k][0]); m.uniforms.uPatCol.value.set(cur[k][1]); m.uniforms.uCol2.value.set(nxt[k][0]); m.uniforms.uPatCol2.value.set(nxt[k][1]); }
  setSeason(TRUCK_STOP[0], TRUCK_STOP[1], wi === 0 ? -1 : WAVE_V * (t - b(WAVES[wi - 1])));
  for (const T of TILES) T.m.position.y = waveH(t, T.d);
  // 道具：每圈波浪在 8 分音符上打到它
  for (const p of PROPS) {
    let d = 0; for (const w of WAVES) d += sq(t, b(w) + p.d / WAVE_V, p.amp);
    const sy = 1 + d, sxz = 1 / Math.sqrt(Math.max(0.4, sy));
    const base = p.g === fount ? 1 : (p.g.scale.x && p.s0) || 1;
    p.s0 = p.s0 || p.g.scale.x;
    p.g.scale.set(p.s0 * sxz, p.s0 * sy, p.s0 * sxz);
    p.g.position.y = (p.plaza ? waveH(t, p.d) : 0) + Math.max(0, d) * p.hop;
  }
  for (const tr of TREES) tr.crown.rotation.z = 0.025 * Math.sin(t * 1.3 + tr.ph);
  // 喷泉
  JETS.forEach((j, i) => { j.position.y = 1.2 + i * 0.62 + 0.12 * Math.sin(t * 7 + i * 1.7); j.scale.setScalar(1 + 0.08 * Math.sin(t * 9 + i)); });
  RIPS.forEach((r, i) => { const u = ((t * 0.55 + i / 3) % 1); r.scale.setScalar(1 + u * 2.6); r.visible = u < 0.92; });
  // 行人
  for (const w of WALKERS) {
    const a = w.ph + t * w.sp * 6.28 * 0.25, x = FOUNT[0] + Math.cos(a) * w.r, z = FOUNT[1] + Math.sin(a) * w.r * 0.8;
    const dir = Math.atan2(Math.cos(a) * w.r * 0.8 * Math.sign(w.sp), -Math.sin(a) * w.r * Math.sign(w.sp));
    walk(w.p, x, z, dir, t * 7 + w.ph);
    w.p.g.position.y += onPlaza(x, z) ? waveH(t, dTruck(x, z)) : 0;
  }
  // 车
  const tx = truckX(t); TG.position.set(tx, 0, TRUCK_STOP[1]);
  for (const wh of WHEELS) wh.rotation.z = -(tx - XS) / 0.55;
  const sy = truckSY(t); SUS.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy)); SUS.rotation.z = truckPitch(t);
  horn.rotation.z = 0.06 * Math.sin(t * 11) * (t < TS ? 1 : 0) + (sq(t, b(CUE.horn), 0.5) * 0.3);
  hornBell.scale.setScalar(1 + Math.max(0, -sq(t, b(CUE.horn), 0.25)));
  const [pz, py] = panelPos(t); PANEL.position.set(0, py, pz); PANEL.visible = py < 7.2;
  IN.visible = pz > 0.01 || py > 0.01;
  // 奶油桶搅拌
  const churn = seg(t, b(CUE.cream) - 0.1, b(CUE.cream) + 0.3) * (1 - 0.7 * seg(t, b(23), b(25)));
  const ang = 9 * Math.max(0, t - b(CUE.cream)) * churn + 0.4;
  LUMPS.forEach((l, i) => { const a = ang + i * Math.PI / 2; l.position.set(BODYX * 0 + TANKX + Math.cos(a) * 0.36, 1.86 + 0.04 * Math.sin(ang * 2 + i), -0.18 + Math.sin(a) * 0.3 * 0.6 - 0.1); });
  CREAM.scale.y = 1 + 0.04 * Math.sin(ang * 1.5) * churn + sq(t, b(CUE.cream), 0.12);
  // 传送带板条跟着甜筒走
  const cx = coneX(t);
  SLATS.forEach((s, i) => { s.position.x = -2.3 + (((i * 0.38 + (cx + 2.05)) % 4.4) + 4.4) % 4.4; });
  CONE.position.set(cx, BELTY, 0.3);
  const cs = 1 + sq(t, b(CUE.cone), 0.12) + sq(t, b(CUE.sprinkle), 0.1) + sq(t, b(CUE.finished), 0.16);
  CONE.scale.set(1 / Math.sqrt(cs), cs, 1 / Math.sqrt(cs));
  CONE.position.y = BELTY + Math.max(0, cs - 1) * 0.8;
  swGeo.setDrawRange(0, Math.floor(SW_N * swirlFill(t) / 60) * 60);
  SWIRL.visible = swirlFill(t) > 0.002;
  NOZ.scale.set(1, 1 + 0.25 * Math.sin(Math.PI * seg(t, b(CUE.cone), b(CUE.cone) + 1.35)), 1);
  // 撒糖罐摇晃 + 糖针落下
  const js = seg(t, b(CUE.sprinkle) - 0.05, b(CUE.sprinkle) + 0.9);
  JAR.rotation.z = (js > 0 && js < 1 ? 0.35 * Math.sin(js * Math.PI * 7) * (1 - js) : 0) + sq(t, b(CUE.sprinkle), 0.0);
  JAR.scale.y = 1 + sq(t, b(CUE.sprinkle), 0.2);
  for (const s of SPR) {
    const u = t - s.t0, fallT = 0.32;
    if (u < 0) { s.m.visible = false; continue; }
    s.m.visible = true;
    if (u < fallT) { const k = u / fallT; s.m.position.set(lerp(s.x0, s.land.x, k), lerp(3.08 - 0.95 - BELTY, s.land.y, k * k), lerp(s.z0, s.land.z, k)); }
    else s.m.position.copy(s.land);
  }
  // 车顶天窗 + 巨型冰淇淋
  for (const f of FLAPS) f.h.rotation.z = f.s * flapA(t);
  const [gx, gy] = gcScale(t); GC.visible = gy > 0.01; GC.scale.set(gx / (1 / Math.sqrt(sy)), gy / sy, gx / (1 / Math.sqrt(sy)));
  // 糖针雨
  for (const r of RAIN) {
    const u = t - r.t0; if (u < 0) { r.m.visible = false; continue; }
    const y = 9.5 + r.vy * u - 9.8 * u * u;
    r.m.visible = y > 0.15;
    r.m.position.set(BX + r.vx * u, Math.max(0.15, y), TRUCK_STOP[1] + r.vz * u); r.m.rotation.set(r.rx * u, r.ry * u, 0);
  }
}

// ---------- 画面内文字 ----------
const textAlpha = (t) => Math.min(sm(seg(t, 0.55, 1.35)), 1 - sm(seg(t, b(CUE.close), b(CUE.close) + 1.1)));
const CO = [   // callout：锚点（车内本地坐标）、出现拍、消失拍、偏移、颜色
  { key: 'cream', at: () => V3(TANKX, 2.05, 0.1), on: CUE.cream, off: CUE.calloutsOut, dx: -40, dy: -205, col: '#5CC8FF' },
  { key: 'cone', at: () => V3(NOZX, 2.2, 0.3), on: CUE.cone, off: CUE.calloutsOut, dx: 10, dy: -235, col: '#FF7EB3' },
  { key: 'sprinkle', at: () => V3(SHAKX, 2.5, 0.3), on: CUE.sprinkle, off: CUE.calloutsOut, dx: 70, dy: -190, col: '#FFD234' },
];
const coAlpha = (t, c) => (t < b(c.on) ? 0 : 1) * (1 - sm(seg(t, b(c.off), b(c.off) + 0.3)));
const coScale = (t, c) => backOut(seg(t, b(c.on), b(c.on) + 0.28));
function pillDims(g, zh, en, big) {
  g.save(); g.font = big ? '800 52px SC, IT' : '600 30px SC, IT'; const wz = g.measureText(zh).width;
  g.font = big ? '800 17px IT' : '600 13px IT'; g.letterSpacing = big ? '3px' : '2px'; const we = g.measureText(en).width; g.restore();
  const w = Math.max(wz, we) + (big ? 70 : 96), h = big ? 112 : 74; return { w, h, wz, we };
}
function drawCallout(g, ax, ay, px, py, zh, en, num, col, a, s, big) {
  if (a <= 0 || s <= 0) return;
  const { w, h } = pillDims(g, zh, en, big);
  g.save(); g.globalAlpha = a;
  // 引线 + 锚点
  const ex = lerp(ax, px, Math.min(1, s)), ey = lerp(ay, py + h / 2, Math.min(1, s));
  g.strokeStyle = INK; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath(); g.moveTo(ax, ay); g.lineTo(ex, ey); g.stroke();
  g.fillStyle = col; g.beginPath(); g.arc(ax, ay, 9, 0, 7); g.fill(); g.stroke();
  g.translate(px, py + h / 2); g.scale(s, s); g.translate(-px, -(py + h / 2));
  const x0 = px - w / 2, y0 = py, r = h / 2;
  const rr_ = (ox, oy) => { g.beginPath(); g.moveTo(x0 + r + ox, y0 + oy); g.arcTo(x0 + w + ox, y0 + oy, x0 + w + ox, y0 + h + oy, r); g.arcTo(x0 + w + ox, y0 + h + oy, x0 + ox, y0 + h + oy, r); g.arcTo(x0 + ox, y0 + h + oy, x0 + ox, y0 + oy, r); g.arcTo(x0 + ox, y0 + oy, x0 + w + ox, y0 + oy, r); g.closePath(); };
  g.fillStyle = big ? '#FF7EB3' : '#B9A0FF'; rr_(7, 7); g.fill();                              // 硬投影（紫）
  g.fillStyle = big ? '#FFD234' : '#FFFFFF'; rr_(0, 0); g.fill(); g.lineWidth = 3; g.strokeStyle = INK; g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = INK;
  const cxText = big ? px : px + 18;
  if (num) { g.fillStyle = col; g.beginPath(); g.arc(x0 + 38, y0 + h / 2, 21, 0, 7); g.fill(); g.lineWidth = 2.5; g.stroke(); g.fillStyle = INK; g.font = '800 24px IT'; g.fillText(num, x0 + 38, y0 + h / 2 + 8.5); }
  g.fillStyle = INK; g.font = big ? '800 52px SC, IT' : '600 30px SC, IT'; g.fillText(zh, cxText, y0 + (big ? 62 : 39));
  g.font = big ? '800 17px IT' : '600 13px IT'; g.letterSpacing = big ? '3px' : '2px'; g.fillStyle = big ? '#25214A' : '#6B6390'; g.fillText(en, cxText, y0 + (big ? 92 : 60));
  if (big) {  // 孟菲斯小装饰：蓝锯齿 + 粉三角
    g.letterSpacing = '0px'; g.strokeStyle = '#2F5BFF'; g.lineWidth = 4; g.beginPath(); for (let i = 0; i <= 6; i++) g.lineTo(x0 + w - 70 + i * 11, y0 - 16 + (i % 2) * 10); g.stroke();
    g.fillStyle = '#FF5A5F'; g.beginPath(); g.moveTo(x0 + 10, y0 + h + 8); g.lineTo(x0 + 34, y0 + h + 30); g.lineTo(x0 - 4, y0 + h + 34); g.closePath(); g.fill(); g.lineWidth = 2.5; g.strokeStyle = INK; g.stroke();
  }
  g.restore();
}
const localToWorld = (v) => { SUS.updateMatrixWorld(true); return v.clone().applyMatrix4(SUS.matrixWorld); };
function calloutLayout(t) {
  const out = [];
  for (const c of CO) {
    const a = coAlpha(t, c); if (a <= 0) continue;
    const [ax, ay] = toScreen(localToWorld(c.at()));
    out.push({ c, a, s: coScale(t, c), ax, ay, px: ax + c.dx, py: ay + c.dy, zh: CALLOUTS[c.key][0], en: CALLOUTS[c.key][1], num: CALLOUTS[c.key][2], big: false });
  }
  if (t >= b(CUE.callout)) {
    const [ax, ay] = toScreen(localToWorld(V3(BODYX + 1.25, ROOFTOP - 0.55 + 6.0, 0.9)));
    out.push({ c: { col: '#FF5A5F' }, a: 1, s: backOut(seg(t, b(CUE.callout), b(CUE.callout) + 0.32), 2.2), ax, ay, px: ax + 250, py: ay - 175, zh: CALLOUTS.today[0], en: CALLOUTS.today[1], num: '', big: true });
  }
  return out;
}

// ---------- 渲染 ----------
setHalftone(1); setNight(0);
function grow(t) {
  if (t < b(2)) return 1400 * (0.2 + 0.8 * Math.pow(seg(t, 0, b(2)), 0.75));   // 返修：第 0 帧画框已有约 20% 的开口，不出空白首帧
  if (t > b(CUE.close)) return lerp(1400, 470, io(seg(t, b(CUE.close), DUR - 0.05)));
  return 1e9;
}
function render(t) {
  const f = Math.round(t * FPS);
  place(t);
  const s = setCam(t);
  dio.fitShadow(V3(s.look.x, 0, s.look.z), Math.max(14, Math.min(64, s.D * 0.75)));
  dio.render(t, f, { grow: grow(t), text: LINES, textAlpha: textAlpha(t) });
  const g = dio.ctx;
  for (const L of calloutLayout(t)) drawCallout(g, L.ax, L.ay, L.px, L.py, L.zh, L.en, L.num, L.c.col, L.a, L.s, L.big);
}
// 所有屏幕文字及其像素框，供 core/render/readcheck.mjs
function TEXTS(t) {
  const out = [];
  if (textAlpha(t) > 0) {
    const g = dio.ctx, y0 = FRAME.cy + FRAME.hh + 64;
    const tb = (id, text, font, dy, size) => { g.save(); g.font = font; const w = g.measureText(text).width; g.restore(); out.push({ id, text, x0: 960 - w / 2, x1: 960 + w / 2, y0: y0 + dy - size, y1: y0 + dy + size * 0.3 }); };
    tb('l1', LINES[0], '600 25px IT, SC', 34, 25); tb('l2', LINES[1], '400 18px IT, SC', 64, 18); tb('l3', LINES[2], '400 15px PM, SC', 91, 15);
  }
  place(t); setCam(t);
  for (const L of calloutLayout(t)) {
    const d = pillDims(dio.ctx, L.zh, L.en, L.big);
    out.push({ id: 'co-' + L.zh, text: L.zh, x0: L.px - d.w / 2, x1: L.px + d.w / 2, y0: L.py, y1: L.py + d.h * 0.62 });
    out.push({ id: 'coen-' + L.en, text: L.en, x0: L.px - d.w / 2, x1: L.px + d.w / 2, y0: L.py + d.h * 0.62, y1: L.py + d.h });
  }
  return out;
}

// ---------- 事件（拟音 + 拍点核对），全部由时间函数推出 ----------
const EV = [];
const panAt = (t, p) => { place(t); setCam(t); const [x] = toScreen(p); return Math.max(-0.9, Math.min(0.9, (x - 960) / 960)); };
const ev = (t, type, o = {}) => EV.push({ t: +t.toFixed(6), type, ...o });
ev(0, 'grid', { bpm: 60 / BEAT, beat: BEAT, bar0: b(6), dur: DUR, fps: FPS });
for (const [k, v] of Object.entries(CUE)) ev(b(v), 'cue', { name: k, beat: v });
ev(0, 'frame_open', { hit: true });
for (let t = 0; t < TS + 0.3;) { const sp = truckSpeed(t); ev(t, 'engine', { v: 0.4 + 0.6 * sp / V0, pan: panAt(t, V3(truckX(t) + 2.5, 1, TRUCK_STOP[1])) }); t += 1 / (9 + sp * 0.9); }
ev(TB, 'brake', { d: TS - TB, hit: true, pan: panAt(TB + 0.5, V3(truckX(TB + 0.5), 1, TRUCK_STOP[1])) });
ev(TS, 'sq', { size: 'truck', hit: true, pan: panAt(TS, V3(BX, 2, TRUCK_STOP[1])) });
ev(TS, 'nod', { hit: true, pan: panAt(TS, V3(BX, 2, TRUCK_STOP[1])) });
ev(b(CUE.horn), 'horn', { hit: true, pan: panAt(b(CUE.horn), V3(BX + 1.6, 4, TRUCK_STOP[1])) });
for (const w of WAVES) ev(b(w), 'wave', { d: 1.9, hit: true, pan: 0 });
for (const w of WAVES) for (const p of PROPS) {
  const T = b(w) + p.d / WAVE_V;
  if (T < DUR - 0.3) ev(T, 'sq', { size: p.size, hit: true, pan: panAt(T, V3(p.x, 1, p.z)) });
}
const PT = V3(BX, 2, TRUCK_STOP[1]);
ev(b(CUE.lidOut), 'latch', { hit: true, pan: panAt(b(CUE.lidOut), PT) });
ev(b(CUE.lidUp), 'lift', { hit: true, pan: 0 });
ev(b(CUE.cream), 'motor', { d: b(25) - b(CUE.cream), hit: true, pan: panAt(b(CUE.cream), V3(BX + TANKX - BODYX, 2, 16)) });
for (const k of ['cream', 'cone', 'sprinkle']) ev(b(CUE[k]), 'callout', { hit: true, pan: panAt(b(CUE[k]) + 0.1, V3(BX + (k === 'cream' ? TANKX : k === 'cone' ? NOZX : SHAKX) - BODYX, 2, 16)) });
for (const k of ['cone', 'sprinkle', 'finished']) ev(b(CUE[k]) - 0.5, 'belt', { d: 0.5, pan: panAt(b(CUE[k]) - 0.25, V3(BX, 1.5, 16)) });
for (const k of ['cone', 'sprinkle', 'finished']) ev(b(CUE[k]), 'clack', { hit: true, pan: panAt(b(CUE[k]), V3(BX + coneX(b(CUE[k])) - BODYX, 1.5, 16)) });
ev(b(CUE.cone) + 0.05, 'extrude', { d: 1.3, pan: panAt(b(CUE.cone) + 0.5, V3(BX + NOZX - BODYX, 2, 16)) });
ev(b(CUE.sprinkle), 'shake', { d: 0.9, hit: true, pan: panAt(b(CUE.sprinkle) + 0.2, V3(BX + SHAKX - BODYX, 2.5, 16)) });
for (const s of SPR) ev(s.t0 + 0.32, 'tick', { v: 0.5 + 0.5 * R(), pan: panAt(b(CUE.sprinkle) + 0.4, V3(BX + SHAKX - BODYX, 2.5, 16)) });
ev(b(CUE.finished), 'ding', { hit: true, pan: panAt(b(CUE.finished), V3(BX + ENDX - BODYX, 2, 16)) });
ev(b(CUE.lidDown) - 0.25, 'lower', { d: 0.5, pan: 0 });
ev(b(CUE.lidIn), 'clunk', { hit: true, pan: 0 });
for (const x of [27, 27.5, 28, 28.5, 29]) ev(b(x), 'creak', { v: 0.8 - (x - 27) * 0.22, hit: true, pan: 0 });
ev(b(CUE.squatStart), 'spring_wind', { d: b(CUE.squatDeep) - b(CUE.squatStart), pan: 0 });
ev(b(CUE.pop), 'bigpop', { hit: true, pan: 0 });
ev(b(CUE.bounce1), 'sq', { size: 'giant', hit: true, pan: 0 }); ev(b(CUE.bounce2), 'sq', { size: 'giant', hit: true, pan: 0 });
for (const r of RAIN) { const T = r.t0 + (r.vy + Math.sqrt(r.vy * r.vy + 4 * 4.9 * 9.35)) / 9.8; if (T < DUR) ev(T, 'patter', { pan: Math.max(-0.8, Math.min(0.8, r.vx / 14)) }); }
ev(b(CUE.callout), 'bigcallout', { hit: true, pan: 0.25 });
ev(b(CUE.close), 'frame_close', { d: DUR - b(CUE.close), hit: true });

window.DUR = DUR;
window.EV = EV.sort((a, c) => a.t - c.t);
window.render = render;
window.TEXTS = TEXTS;
await Promise.all(['600 25px IT', '400 18px IT', '600 25px SC', '400 18px SC', '400 15px PM', '800 52px SC', '600 30px SC', '800 17px IT', '600 13px IT', '800 24px IT'].map((f) => document.fonts.load(f, '冰淇淋 Aa')));
render(0);
window.READY = true;
