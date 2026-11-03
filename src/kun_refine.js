// 鲲·原版精修（变体「原版精修」）。以 src/kun.js 为底：体量、侧影、骨架、弯曲、眨眼、三渲二色调全部保留，只做两件事——
//   ① 质感再往“像画的”推一档（见 toon_refine.js：色阶更干脆、两色边缘光、锈斑撕边甩点、干笔与颗粒；本文件：苔藓地被 + 多球苔藓团 + 三档斑驳）
//   ② 把最“西方”的元素换成东方的：
//        藤壶 → 玉白鳞点（侧线一串、眼圈一环、吻背一行“珠冠”、胸鳍前缘一排）
//        扇贝 → 祥云纹浮雕（如意云头 + 卷纹 + 拖尾，画在体侧，法线按浮雕坡度扰动，逆光下有亮边 / 暗边）
//        海葵 → 小白花（五瓣，花心点黄），一部分顶在苔藓团上
//        鹿角 / 扇形珊瑚 → 细枝红珊瑚（朱砂色，少而精）
//        长海带 → 短草簇 + 少量细长水草（保留背上“毛茸茸”的侧影）
//        座头鲸头顶疙瘩 → 去掉，吻背改一行玉珠
//        新增：细长龙须两对（一拍三随波摆）、鳃盖弧线（“鱼”的标志）、体侧淡淡的鱼鳞纹、金瞳 + 眼角一抹朱红、
//              背上一棵小迎客松、胸鳍鳍条与浅色扇贝后缘、
//              鳍尖云丝改成两色丝带（飘带）
// 坐标约定与 kun.js 相同：长约 600（米），头朝 +X，上为 +Y，原点在身体中心。
// 接口与 kun.js 相同：createKun(opts) → { group, setPose(ts, o), eyeWorld(target, ref), fitShadow(light, o), outlineMeshes, length, eyeRadius, wisps, uniforms, fins, eyes }
//   另：每个会形变的网格都在 userData.outlineVertex 里带上同样的顶点形变（look.js 的 ID 图用），换进正片只需改 import。
// 动画：setPose(ts) 的 ts 由调用方量化（一拍三：f = Math.round(t*24); ts = Math.floor(f/3)*3/24）。
// 确定性：随机全部来自 mulberry(固定种子)，噪声来自固定种子的单纯形噪声（engine/core/noise.js）；没有 Date.now / Math.random。
import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise3D } from '../engine/core/noise.js';
import { mulberry, monotone, clamp, lerp } from '../engine/core/math.js';
import { makeToonMaterial, bindToon, PALETTE, TOON_PRESETS, TOON_SHARED, tintFrom } from './toon_refine.js';

const TAU = Math.PI * 2;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const UP = new THREE.Vector3(0, 1, 0);

// ───────────────────────── 身体轮廓（与 kun.js 相同：x：-262 尾柄末端 … +300 吻端） ─────────────────────────
const PX = [-262, -240, -200, -150, -90, -30, 40, 110, 170, 215, 250, 275, 292, 300];
const PT = [6.5, 10, 17, 29, 43, 51, 54, 51, 44, 36, 27, 18, 10, 3];
const PB = [-6, -9.5, -16, -27, -40, -51, -59, -63, -61, -54, -43, -32, -20, -9];
const PW = [5.5, 8, 14, 25, 39, 49, 55, 57, 55, 50, 44, 36, 25, 9];
const fT = monotone(PX.map((x, i) => [x, PT[i]])), fB = monotone(PX.map((x, i) => [x, PB[i]])), fW = monotone(PX.map((x, i) => [x, PW[i]]));
const X_TAIL = -262, X_SNOUT = 300;

function ridge(x) {
  let r = 0;
  if (x > -88 && x < -18) r += 12 * Math.pow(1 - (x + 88) / 70, 1.6);
  else if (x <= -88 && x > -106) r += 12 * Math.pow(1 - (-88 - x) / 18, 0.8);
  for (let k = 0; k < 6; k++) { const xk = -120 - k * 17; r += (2.8 - k * 0.32) * Math.exp(-Math.pow((x - xk) / 4.5, 2)); }
  return r;
}
const mouthPhi = x => lerp(-0.66, -0.30, sstep(299, 240, x)) + 0.12 * sstep(240, 226, x);
const sideAngle = (c, s) => { const p = Math.atan2(s, c); return c >= 0 ? p : (p >= 0 ? Math.PI - p : -Math.PI - p); };

function bodyPoint(x, phi, out = new THREE.Vector3()) {
  const yT = fT(x), yB = fB(x), W = fW(x), yc = (yT + yB) / 2, a = (yT - yB) / 2;
  const c = Math.cos(phi), s = Math.sin(phi), e = 2 / (s >= 0 ? 2.25 : 2.75);
  let z = W * Math.sign(c) * Math.pow(Math.abs(c), e);
  let y = yc + a * Math.sign(s) * Math.pow(Math.abs(s), e);
  if (s > 0) y += ridge(x) * Math.pow(s, 18);
  if (x > 200) {
    const ph = sideAngle(c, s), pm = mouthPhi(x);
    const step = (1 - sstep(pm - 0.05, pm + 0.05, ph)) * sstep(200, 228, x) * sstep(301, 290, x) * sstep(-1.45, -1.0, ph);
    const k = 1 + 0.035 * step;
    z *= k; y = yc + (y - yc) * k;
  }
  return out.set(x, y, z);
}
const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _p3 = new THREE.Vector3(), _p4 = new THREE.Vector3();
function bodyNormal(x, phi, out = new THREE.Vector3()) {
  bodyPoint(x + 0.5, phi, _p1); bodyPoint(x - 0.5, phi, _p2); bodyPoint(x, phi + 0.004, _p3); bodyPoint(x, phi - 0.004, _p4);
  return out.copy(_p1.sub(_p2)).cross(_p3.sub(_p4)).normalize();
}

function loftRings(rings, { startCap, endCap, attrs = {} } = {}) {
  const nR = rings.length, nV = rings[0].length;
  const pos = [], idx = [];
  for (const ring of rings) for (const p of ring) pos.push(p.x, p.y, p.z);
  for (let j = 0; j < nR - 1; j++) for (let k = 0; k < nV; k++) {
    const a = j * nV + k, b = (j + 1) * nV + k, c = j * nV + (k + 1) % nV, d = (j + 1) * nV + (k + 1) % nV;
    idx.push(a, b, c, b, d, c);
  }
  const extra = {};
  for (const n in attrs) extra[n] = attrs[n].data.slice();
  const cap = (pt, j, rev, capAttr) => {
    const ci = pos.length / 3; pos.push(pt.x, pt.y, pt.z);
    for (const n in attrs) extra[n].push(...capAttr[n]);
    for (let k = 0; k < nV; k++) { const a = j * nV + k, c = j * nV + (k + 1) % nV; rev ? idx.push(a, c, ci) : idx.push(a, ci, c); }
  };
  if (startCap) cap(startCap.p, 0, true, startCap.attr || {});
  if (endCap) cap(endCap.p, nR - 1, false, endCap.attr || {});
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  for (const n in attrs) g.setAttribute(n, new THREE.Float32BufferAttribute(extra[n], attrs[n].size));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// 身体放样。除 kun.js 的 aLoft 外，另带：
//   aSurf = (弧长坐标 v：从侧线沿表面量到该点，向上为正，单位米；侧别 ±1)——祥云纹、鱼鳞纹在 (x, v) 上画，表面不变形
//   aTanU / aTanV：沿体轴 / 沿 v 增大方向的单位切线（物体空间），给浮雕扰动法线
function buildBody(NU, NV) {
  const rings = [], loft = [], surf = [], tanU = [], tanV = [];
  const q1 = new THREE.Vector3(), q2 = new THREE.Vector3();
  for (let j = 0; j < NU; j++) {
    const u = j / (NU - 1), w = 0.5 - 0.5 * Math.cos(Math.PI * u);
    const x = lerp(X_TAIL, X_SNOUT - 0.4, lerp(u, w, 0.5));
    const ring = [];
    for (let k = 0; k < NV; k++) { const phi = k / NV * TAU; ring.push(bodyPoint(x, phi)); loft.push(x, Math.cos(phi), Math.sin(phi)); }
    rings.push(ring);
    const L = [0];
    for (let k = 1; k <= NV; k++) L[k] = L[k - 1] + ring[k % NV].distanceTo(ring[k - 1]);
    const Ptot = L[NV], half = NV / 2;
    for (let k = 0; k < NV; k++) {
      const phi = k / NV * TAU, c = Math.cos(phi);
      const side = c > 1e-6 ? 1 : c < -1e-6 ? -1 : (k < half ? 1 : 1);
      let v;
      if (side > 0) v = k <= half ? L[k] : L[k] - Ptot;
      else v = L[half] - L[k];
      surf.push(v, side);
      bodyPoint(x + 0.5, phi, q1); bodyPoint(x - 0.5, phi, q2); q1.sub(q2).normalize(); tanU.push(q1.x, q1.y, q1.z);
      bodyPoint(x, phi + side * 0.004, q1); bodyPoint(x, phi - side * 0.004, q2); q1.sub(q2).normalize(); tanV.push(q1.x, q1.y, q1.z);
    }
  }
  const yc = x => (fT(x) + fB(x)) / 2;
  return loftRings(rings, {
    startCap: { p: new THREE.Vector3(X_TAIL - 0.8, yc(X_TAIL), 0), attr: { aLoft: [X_TAIL, 0, 0], aSurf: [0, 1], aTanU: [1, 0, 0], aTanV: [0, 1, 0] } },
    endCap: { p: new THREE.Vector3(X_SNOUT + 0.2, yc(X_SNOUT), 0), attr: { aLoft: [X_SNOUT, 0, 0], aSurf: [0, 1], aTanU: [1, 0, 0], aTanV: [0, 1, 0] } },
    attrs: { aLoft: { data: loft, size: 3 }, aSurf: { data: surf, size: 2 }, aTanU: { data: tanU, size: 3 }, aTanV: { data: tanV, size: 3 } },
  });
}

// 翼型放样（胸鳍、尾鳍）。展向沿 ±Z，弦向沿 X（前缘在 +X），厚度沿 Y。aChord 弦向位置，aSpan 展向位置（0 根 → 1 尖）
function buildWing({ nS, nC, span0, span1, plan, spanOf = t => t }) {
  const rings = [], dir = Math.sign(span1 - span0), chord = [], spanA = [];
  for (let j = 0; j < nS; j++) {
    const t = j / (nS - 1), z = lerp(span0, span1, t), P = plan(t, z);
    const ring = [];
    for (let k = 0; k < nC; k++) {
      const al = k / nC * TAU, cp = (1 - Math.cos(al)) / 2, sg = (Math.sin(al) >= 0 ? 1 : -1) * (dir > 0 ? -1 : 1);
      const h = P.th * 0.5 * 2.6 * Math.sqrt(cp) * (1 - cp);
      ring.push(new THREE.Vector3(P.le - cp * P.c, P.y + sg * h + (P.camber || 0) * Math.sin(Math.PI * cp), z));
      chord.push(cp); spanA.push(spanOf(t));
    }
    rings.push(ring);
  }
  const mid = ring => { const c = new THREE.Vector3(); ring.forEach(p => c.add(p)); return c.multiplyScalar(1 / ring.length); };
  return loftRings(rings, {
    startCap: { p: mid(rings[0]), attr: { aChord: [0.5], aSpan: [spanOf(0)] } }, endCap: { p: mid(rings[nS - 1]), attr: { aChord: [0.5], aSpan: [spanOf(1)] } },
    attrs: { aChord: { data: chord, size: 1 }, aSpan: { data: spanA, size: 1 } },
  });
}

// 胸鳍平面形：保留座头鲸式的修长和后弯（侧影不变），去掉前缘那串疙瘩（座头鲸特征），前缘改成顺滑的弧
const FIN_SPAN = 172;
function finPlan(t) {
  const s = t * FIN_SPAN;
  let c = 44 * (1 - 0.66 * sstep(0.1, 0.92, t));
  if (t > 0.84) c *= Math.sqrt(Math.max(0.0004, 1 - Math.pow((t - 0.84) / 0.16, 2)));
  const le = 14 - 0.1 * s - 22 * t * t + 1.6 * Math.sin(Math.PI * t) * sstep(0.05, 0.3, t);
  return { c, le, th: Math.max(0.6, 0.19 * c), y: -9 * t * t, camber: 2.2 * (1 - t * 0.7) };
}
// 尾鳍平面形：前缘后掠、中缝缺口、尖端尖；后缘去掉锯齿（藤壶附着的那种不规则），改成浅浅的鳍条扇贝
const FLUKE_S = 104;
function flukePlan(t) {
  const a = Math.abs(t);
  const le = -244 - 36 * a * a;
  let c = 46 * (1 - Math.pow(a, 1.7)) + 2;
  c -= 9 * Math.exp(-Math.pow(a / 0.07, 2));
  c += 1.1 * Math.pow(Math.abs(Math.sin(Math.PI * a * 6)), 0.5) * sstep(0.1, 0.3, a) * (1 - sstep(0.85, 1, a));
  return { c, le, th: Math.max(0.5, 0.15 * c), y: 0.6 + 5 * a * a, camber: 0 };
}

// ───────────────────────── 装饰几何（单位尺寸，实例矩阵再缩放；底在 y≈0，法线朝 +Y） ─────────────────────────
// 苔藓团：几个大小不一的鼓包挤在一起，整体扁、底略埋进去
function geoMoss(seed) {
  const R = mulberry(seed), parts = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU + R() * 0.6, rr = i === 0 ? 0 : 0.42 + R() * 0.38, r = i === 0 ? 0.72 : 0.36 + R() * 0.3;
    let g = new THREE.IcosahedronGeometry(r, 1); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g = mergeVertices(g, 1e-4);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      const f = 1 + 0.12 * Math.sin(x * 9.1 + y * 5.3 + i) * Math.sin(z * 7.7 - x * 3.1);
      p.setXYZ(k, x * f, y * f * 0.82, z * f);
    }
    g.translate(Math.cos(a) * rr, (i === 0 ? 0.18 : 0.02 + R() * 0.22), Math.sin(a) * rr);
    parts.push(g.toNonIndexed());
  }
  const g = mergeGeometries(parts); g.computeVertexNormals();
  return g;
}
// 小白花：五瓣（|cos 2.5θ| 起瓣），微微兜起；aHeart 标花心（片元里点黄）
function geoFlower() {
  const R = 5, S = 60, pos = [], heart = [], idx = [];
  for (let i = 0; i <= R; i++) for (let j = 0; j <= S; j++) {
    const r = i / R, th = j / S * TAU, k = 0.4 + 0.6 * Math.pow(Math.abs(Math.cos(2.5 * th)), 0.8);
    const rr = r * k;
    pos.push(rr * Math.cos(th), 0.16 + 0.22 * r - 0.12 * r * r * r, rr * Math.sin(th));
    heart.push(1 - sstep(0.16, 0.3, r));
  }
  for (let i = 0; i < R; i++) for (let j = 0; j < S; j++) { const a = i * (S + 1) + j, b = a + S + 1; idx.push(a, a + 1, b, b, a + 1, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aHeart', new THREE.Float32BufferAttribute(heart, 1));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// 草簇：5~7 片细叶从一点散开，向外弯；position.y 就是高度比例（摆动用）
function geoTuft(seed) {
  const R = mulberry(seed), pos = [], idx = [];
  const nb = 6, SEG = 5;
  for (let b = 0; b < nb; b++) {
    const a = b / nb * TAU + R() * 0.7, lean = 0.25 + R() * 0.45, h = 0.65 + R() * 0.35, w = 0.07 + R() * 0.04;
    const dx = Math.cos(a), dz = Math.sin(a), base = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG, y = h * t, out = lean * t * t * h, ww = w * (1 - t * 0.92);
      const cx = dx * (out + 0.05), cz = dz * (out + 0.05);
      pos.push(cx - dz * ww, y, cz + dx * ww, cx + dz * ww, y, cz - dx * ww);
    }
    for (let s = 0; s < SEG; s++) { const i0 = base + s * 2; idx.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// 细长水草：高 1、底宽 1，向上收窄并略扭（比 kun.js 的海带细一半）
function geoReed() {
  const g = new THREE.PlaneGeometry(1, 1, 1, 9); g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), x = p.getX(i), w = 1 - 0.8 * y, tw = 1.1 * y;
    const xx = x * w;
    p.setXYZ(i, xx * Math.cos(tw), y, xx * Math.sin(tw) + 0.08 * Math.sin(y * 5.0));
  }
  g.deleteAttribute('uv'); g.computeVertexNormals(); return g;
}
// 红珊瑚枝：细、分叉多、末端圆头（中国画里的“珊瑚树”）
function geoCoral(seed) {
  const R = mulberry(seed), parts = [];
  const branch = (base, dir, len, rad, depth) => {
    const g = new THREE.CylinderGeometry(rad * 0.66, rad, len, 6, 1, false);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir)); g.translate(base.x, base.y, base.z);
    parts.push(g.toNonIndexed());
    const tip = base.clone().addScaledVector(dir, len);
    if (depth >= 3) { const s = new THREE.SphereGeometry(rad * 1.05, 7, 5); s.translate(tip.x, tip.y, tip.z); parts.push(s.toNonIndexed()); return; }
    const n = depth === 0 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n + R() * 0.35) * TAU, tilt = 0.35 + R() * 0.55;
      const d = new THREE.Vector3(Math.sin(tilt) * Math.cos(a), Math.cos(tilt), Math.sin(tilt) * Math.sin(a)).lerp(dir, 0.35).normalize();
      branch(tip, d, len * (0.62 + R() * 0.25), rad * 0.68, depth + 1);
    }
  };
  branch(new THREE.Vector3(0, 0, 0), UP.clone(), 0.34, 0.06, 0);
  const g = mergeGeometries(parts); g.deleteAttribute('uv');
  return g;
}
// 玉白鳞点：扁圆的玉片（沿局部 X 略长），顶面微鼓
function geoJade() {
  const g = new THREE.SphereGeometry(1, 18, 8, 0, TAU, 0, Math.PI / 2); g.scale(1.22, 0.4, 1); g.deleteAttribute('uv'); return g;
}
// 小迎客松：S 形树干 + 几根平伸的枝 + 扁平的松针云团。返回 { bark, needle } 两份几何（共用一个实例矩阵）
function geoPine(seed) {
  const R = mulberry(seed), bark = [], needle = [];
  const tube = (pts, r0, r1, seg = 20, rad = 7) => {
    const c = new THREE.CatmullRomCurve3(pts);
    const g = new THREE.TubeGeometry(c, seg, 1, rad, false);
    const p = g.attributes.position, nrm = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const a = Math.floor(i / (rad + 1)) / seg, r = lerp(r0, r1, a) - 1;
      p.setXYZ(i, p.getX(i) + nrm.getX(i) * r, p.getY(i) + nrm.getY(i) * r, p.getZ(i) + nrm.getZ(i) * r);
    }
    g.deleteAttribute('uv'); g.computeVertexNormals();
    return { g: g.toNonIndexed(), c };
  };
  const pad = (cx, cy, cz, rad, flat = 0.36) => {
    const n = 6 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const a = R() * TAU, rr = i === 0 ? 0 : rad * (0.35 + R() * 0.5), r = rad * (i === 0 ? 0.62 : 0.38 + R() * 0.26);
      const s = new THREE.IcosahedronGeometry(r, 1); s.scale(1, flat * (1.6 + R() * 0.5), 1);
      s.translate(cx + Math.cos(a) * rr, cy + (R() - 0.3) * rad * 0.18, cz + Math.sin(a) * rr);
      s.deleteAttribute('uv'); needle.push(s.index ? s.toNonIndexed() : s);
    }
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const trunk = tube([V(0, -4, 0), V(1.6, 5, 0.4), V(-1.4, 12, -0.3), V(1.2, 19, 0.2), V(4.5, 25, 0.5), V(8, 28.5, 0.3)], 2.5, 0.8, 26);
  bark.push(trunk.g);
  const branches = [
    { at: 0.5, d: V(-1, 0.18, 0.25), len: 17, r: 0.95, pad: 6.8 },     // 迎客枝：长长探向一侧
    { at: 0.68, d: V(0.9, 0.3, -0.35), len: 10, r: 0.8, pad: 5.4 },
    { at: 0.84, d: V(-0.3, 0.42, -0.85), len: 8, r: 0.65, pad: 4.6 },
    { at: 0.62, d: V(0.25, 0.25, 0.95), len: 9, r: 0.7, pad: 4.8 },
  ];
  for (const b of branches) {
    const st = trunk.c.getPoint(b.at), d = b.d.clone().normalize();
    const mid = st.clone().addScaledVector(d, b.len * 0.5).add(V(0, 1.2, 0)), end = st.clone().addScaledVector(d, b.len).add(V(0, -0.6 + R(), 0));
    bark.push(tube([st, mid, end], b.r, b.r * 0.4, 12, 6).g);
    pad(end.x, end.y + 0.8, end.z, b.pad);
  }
  const top = trunk.c.getPoint(1);
  pad(top.x, top.y + 1.2, top.z, 6.2, 0.4);
  pad(top.x - 4, top.y - 2.5, top.z + 1.5, 4.2);
  return { bark: mergeGeometries(bark), needle: mergeGeometries(needle) };
}

// ───────────────────────── 弯曲（GLSL 与 JS 一致；与 kun.js 相同） ─────────────────────────
const BEND_GLSL = /* glsl */`
uniform float uKunT, uKunAmp, uKunWave, uKunOmega, uKunHalfL;
float kunDy( float x ) {
  float s = clamp( ( uKunHalfL - x ) / ( 2.0 * uKunHalfL ), 0.0, 1.15 );
  float e = smoothstep( 0.22, 1.0, s );
  return uKunAmp * e * e * sin( 6.2831853 * s * uKunWave - uKunOmega * uKunT );
}
vec2 kunBend( float x ) {
  float d0 = kunDy( x );
  return vec2( d0, atan( ( kunDy( x + 1.0 ) - kunDy( x - 1.0 ) ) * 0.5 ) );
}
vec3 kunBendPos( vec3 p ) {
  vec2 b = kunBend( p.x ); float c = cos( b.y ), s = sin( b.y );
  return vec3( p.x - p.y * s, b.x + p.y * c, p.z );
}
vec3 kunBendNormal( vec3 n, float x ) {
  vec2 b = kunBend( x ); float c = cos( b.y ), s = sin( b.y );
  return vec3( n.x * c - n.y * s, n.x * s + n.y * c, n.z );
}
mat4 kunBendMatrix( mat4 im ) {
  float x0 = im[ 3 ].x;
  vec2 b = kunBend( x0 ); float c = cos( b.y ), s = sin( b.y );
  mat4 R = mat4( c, s, 0.0, 0.0,  -s, c, 0.0, 0.0,  0.0, 0.0, 1.0, 0.0,  0.0, 0.0, 0.0, 1.0 );
  mat4 T1 = mat4( 1.0 ); T1[ 3 ] = vec4( x0, b.x, 0.0, 1.0 );
  mat4 T0 = mat4( 1.0 ); T0[ 3 ] = vec4( - x0, 0.0, 0.0, 1.0 );
  return T1 * R * T0 * im;
}
`;
const INST_BEND_PARS = /* glsl */`
#ifdef USE_INSTANCING
mat4 kunGetIM() { return instanceMatrix; }
mat4 kunIM;
#define instanceMatrix kunIM
#endif
`;
function bendHooks({ bend = true, extraPars = '', extraBegin = '' } = {}) {
  if (!bend) return extraPars || extraBegin ? { vertexPars: extraPars, vertexBegin: extraBegin } : {};
  return {
    vertexPars: BEND_GLSL + INST_BEND_PARS + extraPars,
    vertexMainStart: '#ifdef USE_INSTANCING\nkunIM = kunBendMatrix( kunGetIM() );\n#endif',
    vertexBegin: extraBegin + '\n#ifndef USE_INSTANCING\ntransformed = kunBendPos( transformed );\n#endif',
    vertexNormal: '#ifndef USE_INSTANCING\nobjectNormal = kunBendNormal( objectNormal, position.x );\n#endif',
  };
}
// 给 look.js（正片描边的 ID 图）用的同款顶点形变：head 放在 main 之前，body 放在 <begin_vertex> 之后
function outlineVertexOf(U, { bend = true, pars = '', begin = '', uniforms = {} } = {}) {
  if (!bend && !pars && !begin) return undefined;
  const head = (bend ? BEND_GLSL + INST_BEND_PARS : '') + pars;
  const body = begin + (bend ? '\n#ifdef USE_INSTANCING\nkunIM = kunBendMatrix( kunGetIM() );\n#else\ntransformed = kunBendPos( transformed );\n#endif\n' : '');
  return { head, body, uniforms: { ...U, ...uniforms } };
}

// ───────────────────────── 身体片元：苔藓地被、鱼鳞纹、祥云纹浮雕、嘴线、腹褶、眼周、鳃盖、眼角朱红 ─────────────────────────
const BODY_FRAG_PARS = /* glsl */`
varying vec3 vLoft; varying vec3 vSurf; varying vec3 vTanU; varying vec3 vTanV;
uniform vec4 uKunEye; uniform float uPleatN; uniform vec3 uKunBellyTint;
uniform vec4 uClouds[ 8 ]; uniform float uCloudN;
uniform vec3 uCloudFill, uCloudLine, uCinnabar, uMossCol, uMossLitCol, uMossDarkCol;
uniform float uCloudAmt, uCloudLineAmt, uReliefH, uScaleAmt, uScaleSize, uMossOn, uRedAmt, uGillAmt, uJadeAmt, uJadeH, uJadeBand;
uniform vec3 uJadeCol;
float kSmin( float a, float b, float k ) { float h = clamp( 0.5 + 0.5 * ( b - a ) / k, 0.0, 1.0 ); return mix( b, a, h ) - k * h * ( 1.0 - h ); }
// 阿基米德螺线（r = a + b·θ，θ ∈ [0, turns·2π]，从 rot 角起绕）到点 d 的径向距离
float kSpiral( vec2 d, float a, float b, float turns, float rot ) {
  float r = length( d );
  float th = mod( atan( d.y, d.x ) - rot, 6.2831853 );
  float best = 1e3, tmax = turns * 6.2831853;
  for ( int k = 0; k < 3; k ++ ) {
    float t = th + 6.2831853 * float( k );
    if ( t <= tmax ) best = min( best, abs( r - ( a + b * t ) ) );
  }
  return best;
}
// 鱼鳞格：错位排的圆（行距 0.55、半径 0.64），返回 q 处“最靠前”那片鳞的 (边距 e, 鳞心 bc)
vec3 kScale( vec2 q ) {
  vec2 cell = vec2( floor( q.x ), floor( q.y / 0.55 ) );
  float bestX = -1e9, e = 0.0;
  vec2 bc = vec2( 0.0 );
  for ( int j = -1; j <= 2; j ++ ) for ( int i = -1; i <= 1; i ++ ) {
    float row = cell.y + float( j );
    vec2 c = vec2( cell.x + float( i ) + 0.5 * mod( row, 2.0 ), row * 0.55 );
    float d = length( q - c );
    if ( d < 0.64 && c.x > bestX ) { bestX = c.x; e = 0.64 - d; bc = c; }
  }
  return vec3( e, bc );
}
float kHash( vec2 c ) { return fract( sin( dot( c, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
// 如意云：三个云头（大头在前、两个小头在后上 / 后下）+ 往后拖的尾巴。单位 = 大云头半径；头朝 +x
float kCloudSdf( vec2 p, float tv ) {
  float d0 = length( p ) - 1.0;
  float d1 = length( p - vec2( -0.8, 0.78 ) ) - 0.64;
  float d2 = length( p - vec2( -0.9, -0.7 ) ) - 0.54;
  float tx = clamp( p.x, -6.4, -0.75 );
  float u = clamp( ( -0.75 - tx ) / 5.65, 0.0, 1.0 );
  float fy = tv * ( 0.3 * sin( u * 3.5 + 0.2 ) - 0.06 ) + 0.14 * u;
  float hw = 0.58 * pow( max( 1.0 - u, 1e-4 ), 1.15 ) + 0.012;   // 底数保底：u 舍入到 1 以上时 pow 负数 = NaN（第一轮的竖条就是它）
  float dt = length( vec2( p.x - tx, p.y - fy ) ) - hw;
  return kSmin( kSmin( d0, d1, 0.2 ), kSmin( d2, dt, 0.32 ), 0.22 );
}
`;
const BODY_FRAG_ALBEDO = /* glsl */`
{
  float x = vLoft.x;
  float phi = atan( vLoft.z, vLoft.y );
  float ph = vLoft.y >= 0.0 ? phi : ( phi >= 0.0 ? 3.14159265 - phi : -3.14159265 - phi );
  float sv = vSurf.x;
  vec2 kuv = vec2( x, sv );
  // 手绘抖动：画线用的坐标按墨线时钟（一拍二）轻微扰动
  vec3 jq = vec3( x * 0.06, ph * 4.0, uInkTime * 0.731 );
  float jx = toonNoise( jq ) * 0.6, jp = toonNoise( jq + 19.1 ) * 0.0035;
  // 白腹：腹侧往浅薰衣草色走
  float belly = toonSS( -0.2, -0.7, ph ) * smoothstep( -60.0, 40.0, x );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uKunBellyTint, belly * 0.9 );

  // —— 苔藓地被：顶点权重 + 两层噪声（第二层沿表面竖向拉长 → 往下垂的苔藓舌）——
  float mn = toonNoise( vec3( x * 0.045, sv * 0.08, 3.7 ) ) * 0.2 + toonNoise( vec3( x * 0.19, sv * 0.03, 9.1 ) ) * 0.17;
  float mv = vSurf.z + mn;
  float moss = toonAA( 0.5, mv ) * uMossOn;
  float mossRim = moss * ( 1.0 - toonAA( 0.555, mv ) );
  vec2 rel = vec2( 0.0 ), relJ = vec2( 0.0 );   // 浮雕坡度：祥云纹斜边 / 玉鳞穹顶

  // —— 鱼鳞纹：错位排的圆，取“最靠前”的那片，画它的后缘（凸向尾巴）。很淡，远了自动淡出 ——
  //    其中一部分鳞片是“玉鳞”：玉白色、微微鼓起（法线按鳞片穹顶扰动），沿侧线成簇，像藤壶簇原来的位置感，但读作鳞
  float scaleReg = ( 1.0 - moss ) * toonSS( -18.0, -6.0, sv ) * toonSS( -252.0, -205.0, x ) * toonSS( 184.0, 166.0, x );
  if ( scaleReg > 0.002 ) {
    float ssz = uScaleSize * mix( 0.5, 1.0, toonSS( -258.0, -110.0, x ) );
    vec2 q = kuv / ssz;
    vec3 sc3 = kScale( q );
    float e = sc3.x; vec2 bc = sc3.yz;
    float fq = max( length( fwidth( q ) ), 1e-4 );
    float fade = 1.0 - smoothstep( 0.1, 0.24, fq );
    float ln = 1.0 - smoothstep( 0.065 - fq * 0.6, 0.065 + fq * 0.6, e );
    float hi = ( 1.0 - smoothstep( 0.16 - fq * 0.6, 0.16 + fq * 0.6, e ) ) * ( 1.0 - ln );
    // 玉带：侧线一带的鳞整体泛玉白（远看是一道柔和的浅色腰带），带里零星几簇整片玉鳞（微鼓）
    vec2 bw2 = bc * ssz;   // 鳞心的 (x, v)，米
    float band = toonSS( 13.0, 4.0, abs( bw2.y - 2.5 ) ) * toonSS( -222.0, -175.0, bw2.x ) * toonSS( 184.0, 150.0, bw2.x );
    float jn = toonNoise( vec3( bw2.x * 0.03, bw2.y * 0.05, 5.0 ) );
    float jh = kHash( bc );
    float jade = step( jh, uJadeAmt ) * step( 0.24, jn ) * step( 0.5, band ) * step( -1.0, bw2.y ) * scaleReg;
    float tint = band * uJadeBand * scaleReg;
    vec3 jc = mix( uJadeCol, uJadeCol * vec3( 0.93, 0.98, 0.95 ), step( 0.5, fract( jh * 7.0 ) ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, jc, max( tint, jade ) );
    vec2 dq = q - bc;
    relJ += jade * ( -2.0 * uJadeH * dq / ( 0.64 * 0.64 ) ) / ssz;   // 穹顶：h = H(1 - r²/R²)
    float k = scaleReg * uScaleAmt;
    diffuseColor.rgb *= 1.0 - mix( 0.26 * fade, 0.36, jade ) * ln * k;
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 1.13 + vec3( 0.012, 0.009, 0.0 ), hi * k * 0.75 * fade * ( 1.0 - jade ) );
    toonInk = max( toonInk, ln * jade * 0.18 );
    toonOverlay = vec4( uJadeCol, max( toonOverlay.a, jade * 0.22 * ( 1.0 - ln ) ) );
  }
  // —— 颊鳞：眼后下方一弯小玉鳞（替代原来的藤壶眼圈），内小外大、贴着眼眶 ——
  {
    vec2 eyeC = vec2( uKunEye.x, uKunEye.y * uKunEye.w );
    float csz = 2.1;
    vec2 q = kuv / csz;
    vec3 sc3 = kScale( q );
    vec2 bwc = sc3.yz * csz - eyeC;               // 鳞心相对眼心（米）
    float er = length( bwc ) / uKunEye.z, ea = atan( bwc.y, -bwc.x );   // ea：0 = 正后方，-π/2 = 正下方
    float cres = step( 1.12, er ) * step( er + 0.22 * abs( ea + 0.6 ), 1.5 ) * step( -1.75, ea ) * step( ea, 0.12 );
    float jh = kHash( sc3.yz + 17.0 );
    float jade = step( jh, 0.85 ) * cres * ( 1.0 - moss );
    float fq = max( length( fwidth( q ) ), 1e-4 );
    float ln = 1.0 - smoothstep( 0.07 - fq * 0.6, 0.07 + fq * 0.6, sc3.x );
    vec3 jc = mix( uJadeCol, uJadeCol * vec3( 0.92, 0.97, 0.96 ), step( 0.5, fract( jh * 5.0 ) ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, jc, jade );
    diffuseColor.rgb *= 1.0 - 0.3 * ln * jade;
    relJ += jade * ( -2.0 * uJadeH * 0.2 * ( q - sc3.yz ) / ( 0.64 * 0.64 ) ) / csz;
    toonInk = max( toonInk, ln * jade * 0.25 );
    toonOverlay = vec4( uJadeCol, max( toonOverlay.a, jade * 0.3 * ( 1.0 - ln ) ) );
  }

  // —— 祥云纹浮雕：米金色云底 + 赭色勾边与卷纹；坡度写进 toonRelief，法线钩子据此扰动法线 ——
  float cFill = 0.0, cLine = 0.0;
  for ( int i = 0; i < 8; i ++ ) {
    if ( float( i ) >= uCloudN ) break;
    vec4 C = uClouds[ i ];
    float S = C.z, fl = C.w < 0.0 ? -1.0 : 1.0, tv = abs( C.w );
    vec2 p = ( kuv - C.xy ) / S;
    p.y *= fl;
    if ( p.x < -7.0 || p.x > 1.6 || abs( p.y ) > 1.9 ) continue;
    float sd = kCloudSdf( p, tv );
    float e = 0.035;
    vec2 g = vec2( kCloudSdf( p + vec2( e, 0.0 ), tv ) - kCloudSdf( p - vec2( e, 0.0 ), tv ),
                   kCloudSdf( p + vec2( 0.0, e ), tv ) - kCloudSdf( p - vec2( 0.0, e ), tv ) ) / ( 2.0 * e );
    float fw = max( fwidth( sd ), 1e-4 );
    float fill = 1.0 - smoothstep( -fw, fw, sd );
    float bw = 0.17;
    float tb = clamp( ( sd + bw ) / bw, 0.0, 1.0 );
    float dh = -6.0 * tb * ( 1.0 - tb ) / bw;
    rel += dh * vec2( g.x, g.y * fl ) / S * uReliefH * ( 1.0 - cFill );
    float lw = 0.075;
    float edge = 1.0 - smoothstep( lw - fw, lw + fw, abs( sd + lw * 0.4 ) );
    float c0 = kSpiral( p - vec2( 0.02, -0.05 ), 0.06, 0.088, 1.3, 0.5 );
    float c1 = kSpiral( vec2( p.x + 0.8, -( p.y - 0.78 ) ), 0.05, 0.07, 1.0, 2.4 );
    float c2 = kSpiral( p - vec2( -0.9, -0.7 ), 0.05, 0.058, 1.0, 3.9 );
    float cd = min( c0, min( c1, c2 ) );
    float fcd = max( fwidth( cd ), 1e-4 );
    float curl = ( 1.0 - smoothstep( lw * 0.85 - fcd, lw * 0.85 + fcd, cd ) ) * step( sd, -lw * 0.9 ) * step( -1.75, p.x );
    // 云尾里一道顺势的细线
    float tx = clamp( p.x, -6.4, -0.75 );
    float u = clamp( ( -0.75 - tx ) / 5.65, 0.0, 1.0 );
    float fy = tv * ( 0.3 * sin( u * 3.5 + 0.2 ) - 0.06 ) + 0.14 * u;
    float hw = 0.58 * pow( max( 1.0 - u, 1e-4 ), 1.15 );
    float tl = abs( p.y - fy - hw * 0.18 );
    float ftl = max( fwidth( tl ), 1e-4 );
    float tail = ( 1.0 - smoothstep( lw * 0.6 - ftl, lw * 0.6 + ftl, tl ) ) * step( p.x, -1.55 ) * step( -5.6, p.x ) * step( sd, -lw );
    cFill = max( cFill, fill );
    cLine = max( cLine, max( edge, max( curl, tail * 0.85 ) ) );
  }
  float cMask = 1.0 - moss;
  diffuseColor.rgb = mix( diffuseColor.rgb, uCloudFill, cFill * uCloudAmt * cMask );
  diffuseColor.rgb = mix( diffuseColor.rgb, uCloudLine, cLine * uCloudLineAmt * cMask );
  toonRelief += ( relJ * ( 1.0 - cFill ) + rel ) * cMask;

  // —— 苔藓地被上色（盖在一切之上）：三档斑驳 + 边缘一圈深色 ——
  {
    vec3 Qm = vToonObj * 0.3;
    float m1 = toonNoise( Qm ), m2 = toonNoise( Qm * 2.3 + 5.0 );
    vec3 mc = mix( uMossDarkCol, uMossCol, toonAA( -0.18, m1 ) );
    mc = mix( mc, uMossLitCol, toonAA( 0.3, m2 ) * toonAA( -0.18, m1 ) );
    mc = mix( mc, uMossDarkCol * 0.82, mossRim );
    diffuseColor.rgb = mix( diffuseColor.rgb, mc, moss );
  }

  float fwp = max( fwidth( ph ), 1e-5 );
  // 嘴线
  float pm = mix( -0.66, -0.30, smoothstep( 299.0, 240.0, x ) ) + 0.12 * smoothstep( 240.0, 226.0, x );
  float mouth = ( 1.0 - smoothstep( 0.9 * fwp, 2.1 * fwp, abs( ph + jp * 1.5 - pm ) ) ) * toonSS( 300.5, 297.0, x ) * smoothstep( 224.0, 229.0, x );
  toonInk = max( toonInk, mouth );
  // 腹部褶沟：从下巴到肚脐，越往后越收拢；笔压起伏 + 偶尔断开
  float beta = ph + 1.5707963;
  float psi = min( mix( 0.4, 1.02, smoothstep( -30.0, 160.0, x ) ), pm + 1.5707963 - 0.05 );
  float q = beta / psi * ( uPleatN * 0.5 ) + toonNoise( jq * vec3( 0.6, 1.0, 1.0 ) + 7.7 ) * 0.07;
  float fq2 = max( fwidth( q ), 1e-5 );
  float dq = abs( fract( q + 0.5 ) - 0.5 );
  float inSec = ( 1.0 - smoothstep( 0.9, 1.0, beta / psi ) ) * smoothstep( -32.0, 8.0, x ) * toonSS( 297.0, 272.0, x );
  float press = 0.55 + 0.45 * toonNoise( vec3( x * 0.035, floor( q ) * 3.1, 2.0 ) );
  float brk = toonAA( -0.35, toonNoise( vec3( x * 0.05, floor( q ) * 1.7, 5.0 ) ) );
  float pleat = ( 1.0 - smoothstep( 0.7 * fq2 * press, 1.7 * fq2 * press, dq ) ) * inSec * brk;
  diffuseColor.rgb *= 1.0 - 0.07 * step( 0.5, fract( q * 0.5 ) ) * inSec;
  toonInk = max( toonInk, pleat * 0.55 );
  // 眼周皱纹
  vec2 de = vec2( x + jx - uKunEye.x, ( ph + jp - uKunEye.y ) * uKunEye.w );
  float rr = length( de ) / uKunEye.z + 0.07 * toonNoise( vec3( de * 0.22, 3.0 ) );
  float fr = max( fwidth( rr ), 1e-5 );
  float up = de.y / max( length( de ), 1e-3 );
  float side = de.x / max( length( de ), 1e-3 );
  float arc1 = ( 1.0 - smoothstep( 0.9 * fr, 2.0 * fr, abs( rr - 1.32 ) ) ) * smoothstep( 0.05, 0.45, up ) * toonSS( 0.85, 0.55, abs( side ) );
  float arc2 = ( 1.0 - smoothstep( 0.9 * fr, 2.0 * fr, abs( rr - 1.62 ) ) ) * smoothstep( 0.35, 0.8, up ) * toonSS( 0.6, 0.3, abs( side + 0.15 ) );
  float arc3 = ( 1.0 - smoothstep( 0.9 * fr, 2.0 * fr, abs( rr - 1.25 ) ) ) * toonSS( -0.35, -0.8, up ) * toonSS( 0.7, 0.4, abs( side ) );
  toonInk = max( toonInk, max( arc1, max( arc2 * 0.8, arc3 * 0.7 ) ) );
  // 鳃盖弧：眼后一道大弧（中间粗两头细）——“鱼”的标志，座头鲸没有
  vec2 gq = vec2( x + jx, sv ) - vec2( uKunEye.x + 1.0, -4.0 );
  float gr = length( gq ), ga = atan( gq.y, -gq.x );
  float gArc = toonSS( 1.2, 0.95, abs( ga ) );
  float fgr = max( fwidth( gr ), 1e-4 );
  float gw = max( mix( 0.12, 0.5, toonSS( 1.15, 0.15, abs( ga ) ) ), fgr * mix( 0.6, 1.4, toonSS( 1.15, 0.15, abs( ga ) ) ) ) * ( 0.8 + 0.25 * toonNoise( vec3( ga * 3.0, 1.0, uInkTime * 0.731 ) ) );
  float gill = ( 1.0 - smoothstep( gw - fgr, gw + fgr, abs( gr - 40.0 ) ) ) * gArc * ( 1.0 - moss );
  toonInk = max( toonInk, gill * 0.82 * uGillAmt );
  // 眼角一抹朱红：从眼后角往后上方一笔，头粗尾尖，微弯
  {
    vec2 sa = vec2( -0.98, 0.16 ) * uKunEye.z, sb = vec2( -2.45, 0.62 ) * uKunEye.z;
    vec2 pa = de - sa, ba = sb - sa;
    float hh = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 );
    vec2 perp = normalize( vec2( -ba.y, ba.x ) );
    vec2 Pc = sa + ba * hh + perp * ( 0.14 * uKunEye.z * sin( hh * 3.14159 ) );
    float dst = length( de - Pc );
    float wst = uKunEye.z * ( 0.085 * pow( 1.0 - hh, 1.2 ) * toonSS( 0.0, 0.1, hh ) + 0.004 );
    float fst = max( fwidth( dst ), 1e-4 );
    float red = 1.0 - smoothstep( wst - fst, wst + fst, dst );
    diffuseColor.rgb = mix( diffuseColor.rgb, uCinnabar, red * uRedAmt );
  }
}`;
const BODY_FRAG_NORMAL = /* glsl */`
normal = normalize( normal - ( toonRelief.x * normalize( vTanU ) + toonRelief.y * normalize( vTanV ) ) );
`;

// ───────────────────────── 主体 ─────────────────────────
/**
 * createKun(opts) → { group, setPose(ts, o), eyeWorld(target, ref), fitShadow(light, o), outlineMeshes, length, eyeRadius, wisps, uniforms, fins, eyes, whiskers }
 * opts 与 kun.js 相同：lod（0.1–1）、seed、wisps（鳍尖飘带，默认 true）、blinkPeriod / blinkOffset；
 *   另：pine（背上小迎客松，默认 true）、whiskers（龙须，默认 true）、clouds（祥云纹，默认 true）
 * setPose(ts, { blink, look })、eyeWorld(target, ref)、fitShadow(light, { size }) 与 kun.js 相同
 */
export function createKun(opts = {}) {
  const o = { lod: 1, seed: 20261103, wisps: true, pine: true, whiskers: true, clouds: true, blinkPeriod: 4, blinkOffset: 1.5, ...opts };
  const lod = clamp(o.lod, 0.1, 1);
  const N = n => Math.max(4, Math.round(n * lod));
  const LS = 1 / Math.sqrt(Math.max(lod, 0.2));
  const R = mulberry(o.seed);
  const noise = createNoise3D(mulberry(o.seed + 11));
  const noise2 = createNoise3D(mulberry(o.seed + 23));

  const U = {
    uKunT: { value: 0 }, uKunAmp: { value: 16 }, uKunWave: { value: 0.8 }, uKunOmega: { value: TAU / 5 }, uKunHalfL: { value: 300 },
  };
  const group = new THREE.Group(); group.name = 'kun';
  const outlineMeshes = [];
  const add = (parent, mesh, ov) => { parent.add(mesh); if (ov) mesh.userData.outlineVertex = ov; if (mesh.userData.outline) outlineMeshes.push(mesh); return mesh; };
  const toon = (preset, extra = {}) => makeToonMaterial({ ...TOON_PRESETS[preset], ...extra, uniforms: { ...U, ...(extra.uniforms || {}) } });
  const OV_BEND = outlineVertexOf(U);

  // —— 眼睛参数（两侧对称）——
  const EYE_X = 214, EYE_PH = 0.05, RE = 12;
  const eyeSecR = ((fT(EYE_X) - fB(EYE_X)) / 2 + fW(EYE_X)) / 2;

  // —— 身体 ——
  const NU = Math.round(lerp(90, 230, lod)), NV = Math.round(lerp(56, 128, lod)) & ~1;
  const bodyGeo = buildBody(NU, NV);
  const BELLY = '#9a9cc8';
  // 祥云纹位置（x, v, 云头半径, ±尾巴摆幅；负号 = 上下翻转）。两侧同一套（v 两侧镜像）
  const CLOUDS = o.clouds ? [
    [122, 10, 9.6, 1.0], [28, 16, 9.0, -0.9], [-64, 7, 8.4, 1.1], [-152, 10, 6.9, -1.0], [-214, 4, 4.6, 0.9],
    [203, 27, 4.6, 1.0],
  ] : [];
  const cloudU = Array.from({ length: 8 }, (_, i) => new THREE.Vector4(...(CLOUDS[i] || [0, -9999, 1, 1])));
  const bodyMat = toon('kun', {
    patchScale: 0.019, spotScale: 24,
    uniforms: {
      uKunEye: { value: new THREE.Vector4(EYE_X, EYE_PH, RE, eyeSecR) },
      uPleatN: { value: 26 },
      uKunBellyTint: { value: tintFrom(PALETTE.kunBase, BELLY) },
      uClouds: { value: cloudU }, uCloudN: { value: CLOUDS.length },
      uCloudFill: { value: new THREE.Color(PALETTE.cloudFill) }, uCloudLine: { value: new THREE.Color(PALETTE.cloudLine) }, uCinnabar: { value: new THREE.Color(PALETTE.cinnabar) },
      uMossCol: { value: new THREE.Color(PALETTE.moss) }, uMossLitCol: { value: new THREE.Color(PALETTE.mossLit) }, uMossDarkCol: { value: new THREE.Color(PALETTE.mossDark) },
      uCloudAmt: { value: 0.85 }, uCloudLineAmt: { value: 0.95 }, uReliefH: { value: 1.0 }, uScaleAmt: { value: 1 }, uScaleSize: { value: 7.2 },
      uMossOn: { value: 1 }, uRedAmt: { value: 1 }, uGillAmt: { value: 1 },
      uJadeAmt: { value: 0.62 }, uJadeH: { value: 0.75 }, uJadeBand: { value: 0.26 }, uJadeCol: { value: new THREE.Color(PALETTE.jade) },
    },
    ...bendHooks({
      extraPars: 'attribute vec3 aLoft;\nattribute vec2 aSurf;\nattribute vec3 aTanU;\nattribute vec3 aTanV;\nattribute float aMoss;\nvarying vec3 vLoft;\nvarying vec3 vSurf;\nvarying vec3 vTanU;\nvarying vec3 vTanV;\n',
      extraBegin: 'vLoft = aLoft; vSurf = vec3( aSurf, aMoss ); vTanU = normalMatrix * kunBendNormal( aTanU, position.x ); vTanV = normalMatrix * kunBendNormal( aTanV, position.x );',
    }),
    fragmentPars: BODY_FRAG_PARS, fragmentAlbedo: BODY_FRAG_ALBEDO, fragmentNormal: BODY_FRAG_NORMAL,
  });
  const body = add(group, bindToon(new THREE.Mesh(bodyGeo, bodyMat), bodyMat), OV_BEND);
  body.name = 'kun-body'; body.frustumCulled = false;

  // —— 鳍：鳍条 + 浅色扇贝后缘 + 前缘浅带 + 下表面偏浅 ——
  const finHook = {
    vertexPars: 'attribute float aChord;\nattribute float aSpan;\nvarying float vNy;\nvarying float vChord;\nvarying float vSpan;\n',
    vertexBegin: 'vNy = normal.y; vChord = aChord; vSpan = aSpan;',
    fragmentPars: 'uniform vec3 uFinPale, uFinEdge;\nuniform float uRayN;\nvarying float vNy;\nvarying float vChord;\nvarying float vSpan;\n',
    fragmentAlbedo: /* glsl */`
      {
        float fc = max( fwidth( vChord ), 1e-4 );
        float lead = 1.0 - smoothstep( 0.16 - fc, 0.16 + fc, vChord + toonNoise( vToonObj * 0.12 ) * 0.05 );
        float pale = max( ( 1.0 - smoothstep( -0.35, 0.1, vNy ) ) * 0.55, lead * 0.7 );
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uFinPale, pale );
        // 鳍条：沿展向的细线（按弦向等分，轻微抖），根部淡出
        float rq = vChord * uRayN + toonNoise( vec3( vSpan * 4.0, vChord * 3.0, 1.7 ) ) * 0.22;
        float frq = max( fwidth( rq ), 1e-4 );
        float dr = abs( fract( rq + 0.5 ) - 0.5 );
        float ray = ( 1.0 - smoothstep( 0.07 - frq, 0.07 + frq, dr ) ) * toonSS( 0.04, 0.16, vSpan ) * ( 1.0 - lead ) * ( 1.0 - smoothstep( 0.2, 0.45, frq ) );
        // 浅色后缘：在鳍条之间往里收，成扇贝边
        float edgeT = 0.74 - 0.07 * ( 1.0 - 2.0 * dr );
        float trail = smoothstep( edgeT - fc, edgeT + fc, vChord );
        diffuseColor.rgb = mix( diffuseColor.rgb, mix( diffuseColor.rgb, uFinEdge, 0.55 ), trail );
        diffuseColor.rgb *= 1.0 - 0.24 * ray;
        toonInk = max( toonInk, ( 1.0 - smoothstep( 0.012 - fc, 0.012 + fc, abs( vChord - edgeT ) ) ) * 0.25 * ( 1.0 - smoothstep( 0.2, 0.45, frq ) ) );
      }` };
  const finU = { uFinPale: { value: tintFrom(PALETTE.kunBase, BELLY) }, uFinEdge: { value: new THREE.Color('#D3CBEA') }, uRayN: { value: 9 } };
  const flukeGeo = buildWing({ nS: N(70) + 24, nC: 28, span0: -FLUKE_S, span1: FLUKE_S, plan: t => flukePlan(2 * t - 1), spanOf: t => Math.abs(2 * t - 1) });
  const flukeMat = toon('kun', { side: THREE.DoubleSide, patchScale: 0.05, spotScale: 6, rustAmt: 0.7, uniforms: { ...finU, uRayN: { value: 8 } },
    ...bendHooks({ extraPars: finHook.vertexPars, extraBegin: finHook.vertexBegin }), fragmentPars: finHook.fragmentPars, fragmentAlbedo: finHook.fragmentAlbedo });
  const flukes = add(group, bindToon(new THREE.Mesh(flukeGeo, flukeMat), flukeMat), OV_BEND);
  flukes.name = 'kun-flukes'; flukes.frustumCulled = false;

  // —— 胸鳍（刚体，CPU 摆位；与 kun.js 相同的根部与基向量）——
  const fins = [];
  const finMatBase = { side: THREE.DoubleSide, patchScale: 0.05, spotScale: 10, spotAmt: 0.45, rustAmt: 0.7, cityAmt: 0.6, uniforms: finU };
  for (const side of [1, -1]) {
    const geo = buildWing({ nS: N(64) + 20, nC: 26, span0: 0, span1: side * FIN_SPAN, plan: t => finPlan(t) });
    const mat = toon('kun', { ...finMatBase, vertexPars: finHook.vertexPars, vertexBegin: finHook.vertexBegin, fragmentPars: finHook.fragmentPars, fragmentAlbedo: finHook.fragmentAlbedo });
    const pivot = new THREE.Group(); pivot.name = 'kun-fin-' + (side > 0 ? 'R' : 'L');
    const mesh = add(pivot, bindToon(new THREE.Mesh(geo, mat), mat)); mesh.frustumCulled = false;
    const phR = -0.5, x0 = 150, ph0 = side > 0 ? phR : Math.PI - phR;
    const root = bodyPoint(x0, ph0), nrm = bodyNormal(x0, ph0);
    root.addScaledVector(nrm, -8);
    const out = new THREE.Vector3(0, nrm.y * 0.3, nrm.z).normalize();
    const spanDir = out.clone().multiplyScalar(Math.cos(0.5)).add(new THREE.Vector3(-Math.sin(0.5), 0, 0)).add(new THREE.Vector3(0, -0.24, 0)).normalize();
    const zAxis = spanDir.clone().multiplyScalar(side);
    let xAxis = new THREE.Vector3(1, 0.08, 0);
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
    const baseQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    fins.push({ side, pivot, mesh, root, baseQ, x0 });
    group.add(pivot);
  }

  // —— 眼睛：金瞳（内浅外深、外缘一圈深赭）、横椭圆瞳孔；眼睑结构与 kun.js 相同 ——
  const eyes = [];
  const makeSclera = () => makeToonMaterial({ ...TOON_PRESETS.flower, color: '#EDE3CF', shade1: '#ABA0B6', shade2: '#6B6589', rimAmt: 0.6, cityAmt: 0.8, cityFlat: 0.35,
    uniforms: {
      uIrisA: { value: 0.62 }, uPupilA: { value: 0.23 },
      uIrisCol: { value: new THREE.Color(PALETTE.iris) }, uIrisCol2: { value: new THREE.Color(PALETTE.irisIn) }, uRingCol: { value: new THREE.Color(PALETTE.irisRing) }, uPupilCol: { value: new THREE.Color('#150E1C') },
      uReflCol: { value: new THREE.Color('#c9b8ef') },
      uCatch1: { value: new THREE.Vector4(0, 0, 1, 0.985) }, uCatch2: { value: new THREE.Vector4(0, 0, 1, 0.997) }, uCatchCol: { value: new THREE.Color('#fffaf2') },
      uLidU: { value: new THREE.Vector3(0, 1, 0) }, uLidL: { value: new THREE.Vector3(0, -1, 0) },
    },
    fragmentPars: 'uniform float uIrisA, uPupilA;\nuniform vec3 uIrisCol, uIrisCol2, uRingCol, uPupilCol, uCatchCol, uLidU, uLidL, uReflCol;\nuniform vec4 uCatch1, uCatch2;\n',
    fragmentAlbedo: /* glsl */`
    {
      vec3 d = normalize( vToonObj );
      float ang = acos( clamp( d.z, -1.0, 1.0 ) ) + toonNoise( vec3( d.xy * 6.0, uInkTime * 0.731 ) ) * 0.006;
      float fa = max( fwidth( ang ), 1e-5 );
      float iris = 1.0 - smoothstep( uIrisA - fa, uIrisA + fa, ang );
      float pa = length( vec2( atan( d.x, d.z ) * 0.86, atan( d.y, d.z ) * 1.1 ) );
      float fp = max( fwidth( pa ), 1e-5 );
      float pupil = 1.0 - smoothstep( uPupilA - fp, uPupilA + fp, pa );
      float collar = smoothstep( uIrisA - 0.07 - fa, uIrisA - 0.07 + fa, ang ) * iris;
      float az = atan( d.y, d.x );
      float stri = 0.5 + 0.5 * sin( az * 22.0 + toonNoise( d * 7.0 ) * 3.0 );
      float rad = smoothstep( uPupilA, uIrisA, ang );
      vec3 ic = mix( uIrisCol2, uIrisCol, smoothstep( 0.3, 0.8, rad ) );
      ic = mix( ic, ic * 0.78, step( 0.62, stri ) * rad );
      // 瞳孔外一圈火色（金瞳的“火眼”）
      float fire = ( 1.0 - smoothstep( uPupilA + 0.06 - fa, uPupilA + 0.06 + fa, pa ) ) * ( 1.0 - pupil );
      ic = mix( ic, vec3( 0.95, 0.42, 0.12 ), fire * 0.55 );
      ic = mix( ic, uRingCol, collar );
      diffuseColor.rgb = mix( diffuseColor.rgb, ic, iris );
      diffuseColor.rgb = mix( diffuseColor.rgb, uPupilCol, pupil );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fa, 2.2 * fa, abs( ang - uIrisA ) ) ) * 0.95 );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fp, 1.8 * fp, abs( pa - uPupilA ) ) ) * 0.4 );
      float c1 = dot( d, uCatch1.xyz ), c2 = dot( d, uCatch2.xyz );
      float fc = max( fwidth( c1 ), 1e-5 );
      float k = max( smoothstep( uCatch1.w - fc, uCatch1.w + fc, c1 ), smoothstep( uCatch2.w - fc, uCatch2.w + fc, c2 ) );
      float du = dot( d, uLidU ), dl = dot( d, uLidL ), fd = max( fwidth( du ), 1e-5 );
      float front = smoothstep( 0.1, 0.6, d.z );
      float lash = ( 1.0 - smoothstep( 0.1 * front + 0.02 - fd, 0.1 * front + 0.02 + fd, - du ) ) * front;
      float low = ( 1.0 - smoothstep( 0.03 - fd, 0.03 + fd, - dl ) ) * front;
      toonInk = max( toonInk, max( lash * 0.92, low * 0.6 ) );
      float refl = smoothstep( -0.5, -0.4, du ) * ( 1.0 - smoothstep( -0.3, -0.22, du ) ) * smoothstep( 0.35, 0.75, d.z ) * iris * ( 1.0 - pupil );
      toonOverlay = vec4( uReflCol, refl * 0.3 );
      toonOverlay = mix( toonOverlay, vec4( uCatchCol, 1.0 ), k * ( 1.0 - lash ) );
    }`,
  });
  const lidMat = toon('kun', { objectId: bodyMat.userData.toon.uObjectId.value, patchScale: 0.08, spotScale: 5, rustAmt: 0.6, algaeAmt: 0.3, cityAmt: 0.55, side: THREE.DoubleSide,
    fragmentAlbedo: /* glsl */`
    {
      vec3 d = normalize( vToonObj );
      float e = asin( clamp( abs( d.y ), 0.0, 1.0 ) ), fe = max( fwidth( e ), 1e-5 );
      float front = smoothstep( 0.15, 0.55, d.z );
      float rim = 1.0 - smoothstep( 0.07 - fe, 0.07 + fe, e );
      float fold = ( 1.0 - smoothstep( 0.8 * fe, 1.9 * fe, abs( e - 0.36 ) ) ) * smoothstep( 0.35, 0.7, d.z );
      float fold2 = ( 1.0 - smoothstep( 0.8 * fe, 1.9 * fe, abs( e - 0.66 ) ) ) * smoothstep( 0.5, 0.8, d.z ) * step( 0.0, d.y );
      toonInk = max( toonInk, max( rim * front * 0.85, max( fold * 0.75, fold2 * 0.55 ) ) );
    }` });
  for (const side of [1, -1]) {
    const ph0 = side > 0 ? EYE_PH : Math.PI - EYE_PH;
    const sp = bodyPoint(EYE_X, ph0), n = bodyNormal(EYE_X, ph0);
    const gaze = n.clone().add(new THREE.Vector3(0.22, -0.12, 0)).normalize();
    const zA = gaze, xA = new THREE.Vector3().crossVectors(UP, zA).normalize(), yA = new THREE.Vector3().crossVectors(zA, xA);
    const eg = new THREE.Group(); eg.name = 'kun-eye-' + (side > 0 ? 'R' : 'L');
    eg.position.copy(sp).addScaledVector(n, -0.6 * RE);
    eg.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, zA));
    const scleraMat = makeSclera();
    const ball = add(eg, bindToon(new THREE.Mesh(new THREE.SphereGeometry(RE, 48, 32), scleraMat), scleraMat, { castShadow: false }));
    const lidU = new THREE.Group(), lidL = new THREE.Group();
    const shellU = new THREE.SphereGeometry(RE * 1.07, 40, 12, 0, TAU, 0, Math.PI / 2);
    const shellL = new THREE.SphereGeometry(RE * 1.07, 40, 12, 0, TAU, Math.PI / 2, Math.PI / 2);
    add(lidU, bindToon(new THREE.Mesh(shellU, lidMat), lidMat));
    add(lidL, bindToon(new THREE.Mesh(shellL, lidMat), lidMat));
    eg.add(lidU, lidL);
    group.add(eg);
    eyes.push({ side, group: eg, ball, lidU, lidL, surf: sp, n, mat: scleraMat });
  }

  // —— 散布：在未弯曲的身体上建权重，MeshSurfaceSampler 采样 ——
  const pAttr = bodyGeo.attributes.position, nAttr = bodyGeo.attributes.normal, lAttr = bodyGeo.attributes.aLoft;
  const nv = pAttr.count;
  const W = { wMoss: new Float32Array(nv), wFlower: new Float32Array(nv), wTuft: new Float32Array(nv), wReed: new Float32Array(nv), wCoral: new Float32Array(nv) };
  const mossA = new Float32Array(nv);
  const eyeC = eyes.map(e => e.group.position);
  const P = new THREE.Vector3(), Nn = new THREE.Vector3();
  for (let i = 0; i < nv; i++) {
    P.fromBufferAttribute(pAttr, i); Nn.fromBufferAttribute(nAttr, i);
    const x = P.x, ph = sideAngle(lAttr.getY(i), lAttr.getZ(i));
    const patch = noise(P.x * 0.014, P.y * 0.014, P.z * 0.014) + 0.45 * noise(P.x * 0.04 + 7, P.y * 0.04, P.z * 0.04);
    const xr = sstep(226, 186, x) * sstep(-238, -172, x);
    const nearEye = Math.min(...eyeC.map(c => c.distanceTo(P))) / RE;
    const eyeKeep = sstep(2.6, 3.4, nearEye);
    // 苔藓地被权重：背上为主，边界随噪声起伏（片元里再按 0.5 阈值撕边）
    const dors = sstep(0.12, 0.78, ph + 0.32 * patch);
    // 肋上的苔藓岛：像原版那样一片片垂到体侧（保留“长满了”的侧影），但不下到腹部
    const isl = noise(P.x * 0.022 + 31, P.y * 0.03, P.z * 0.022) + 0.35 * noise(P.x * 0.07, P.y * 0.07 + 13, P.z * 0.07);
    const island = sstep(0.16, 0.42, isl) * sstep(-0.2, 0.08, ph) * sstep(200, 150, x) * sstep(-215, -150, x) * 0.95;
    const m = Math.max(dors, island) * xr * eyeKeep;
    mossA[i] = m;
    const inner = sstep(0.55, 0.9, m);
    W.wMoss[i] = inner * (0.45 + 0.55 * sstep(-0.25, 0.35, patch));
    W.wFlower[i] = inner * (0.35 + 0.65 * sstep(-0.2, 0.4, noise2(P.x * 0.05, P.y * 0.05, P.z * 0.05)));
    W.wTuft[i] = sstep(0.5, 0.8, m) * (0.4 + 0.6 * sstep(-0.1, 0.4, noise2(P.x * 0.03 + 9, P.y * 0.03, P.z * 0.03)));
    W.wReed[i] = sstep(0.75, 1.0, m) * sstep(0.15, 0.5, Nn.y) * sstep(-0.05, 0.35, patch + 0.2 * Nn.y);
    const cn = noise2(P.x * 0.012 + 40, P.y * 0.012, P.z * 0.012);
    W.wCoral[i] = sstep(0.5, 0.8, m) * sstep(-0.1, 0.4, Nn.y) * sstep(0.22, 0.5, cn) * sstep(210, 160, x) * sstep(-200, -150, x);
  }
  bodyGeo.setAttribute('aMoss', new THREE.BufferAttribute(mossA, 1));
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute('position', pAttr); sGeo.setAttribute('normal', nAttr); sGeo.setIndex(bodyGeo.index);
  for (const k in W) sGeo.setAttribute(k, new THREE.BufferAttribute(W[k], 1));
  const samplerMesh = new THREE.Mesh(sGeo);
  const sampler = (wName, seed) => new MeshSurfaceSampler(samplerMesh).setWeightAttribute(wName).setRandomGenerator(mulberry(seed)).build();

  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _c = new THREE.Color();
  const pick = (r, arr) => arr[Math.floor(r * arr.length) % arr.length];
  function place(p, n, { yaw = 0, scale, sink = 0, lean = null }) {
    const up = n.clone();
    if (lean) up.add(lean).normalize();
    _q.setFromUnitVectors(UP, up);
    _q2.setFromAxisAngle(UP, yaw); _q.multiply(_q2);
    const pp = p.clone().addScaledVector(n, -sink);
    return new THREE.Matrix4().compose(pp, _q.clone(), scale);
  }
  // 局部 Y = 法线，局部 X = 体轴方向在切平面上的投影（玉鳞点顺着身体排）
  function placeAligned(p, n, along, scale, sink = 0) {
    const y = n.clone().normalize();
    const x = along.clone().addScaledVector(y, -along.dot(y)).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    const m = new THREE.Matrix4().makeBasis(x, y, z).scale(scale);
    m.setPosition(p.clone().addScaledVector(y, -sink));
    return m;
  }
  function inst(geo, mat, items, name, extraAttr) {
    const m = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((it, i) => { m.setMatrixAt(i, it.m); if (it.c) m.setColorAt(i, _c.set(it.c)); });
    m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (extraAttr) for (const k in extraAttr) geo.setAttribute(k, extraAttr[k]);
    m.frustumCulled = false; m.name = name;
    bindToon(m, mat);
    return m;
  }
  const tp = new THREE.Vector3(), tn = new THREE.Vector3();
  const back = new THREE.Vector3(-1, 0, 0), AX = new THREE.Vector3(1, 0, 0);

  // 苔藓团：多球鼓包，三档斑驳（亮档偏黄绿）；整批同一个描边 ID（只描外轮廓与鼓包间的折痕）
  const MOSS = ['#93BB52', '#86B04C', '#A2C55B', '#7DAA4A', '#B0CE62', '#8FB850', '#9BC156', '#A8C95E'];
  const clumps = [], sM = sampler('wMoss', o.seed + 101);
  const mossGeo = geoMoss(o.seed + 7);
  for (let i = 0; i < N(1500); i++) {
    sM.sample(tp, tn);
    const r = (3.0 + Math.pow(R(), 1.6) * 7.0) * LS;
    clumps.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(r * (0.9 + R() * 0.3), r * (0.75 + R() * 0.45), r * (0.9 + R() * 0.3)), sink: r * 0.3 }), c: pick(R(), MOSS) });
  }
  add(group, inst(mossGeo, toon('moss', { outlineW: 0.4, instanceId: false, ...bendHooks() }), clumps, 'kun-moss'), OV_BEND);

  // 草簇（一拍三摆动）：aSway.xyz = 局部空间里的“向后”方向 × 摆幅，w = 相位
  const swayPars = 'attribute vec4 aSway;\n';
  const swayBegin = /* glsl */`
    {
      float hg = clamp( position.y, 0.0, 1.0 );
      float h2 = hg * hg;
      float sl = length( aSway.xyz );
      vec3 sd = normalize( cross( aSway.xyz, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4 ) ) * sl;
      transformed += aSway.xyz * ( 0.3 + 0.14 * sin( uKunT * 1.9 + aSway.w ) ) * h2 * 0.9;
      transformed += sd * sin( uKunT * 2.6 + aSway.w * 1.3 - hg * 2.4 ) * 0.2 * h2;
      transformed.y -= 0.12 * h2;
    }`;
  const swayInst = (items, sampFn, hOf, wOf, leanK) => {
    const arr = [];
    for (const it of items) {
      _q.setFromRotationMatrix(new THREE.Matrix4().extractRotation(it.m)).invert();
      const lb = back.clone().applyQuaternion(_q); lb.y = 0; if (lb.lengthSq() < 1e-6) lb.set(1, 0, 0); lb.normalize().multiplyScalar(it.h / it.w * leanK);
      arr.push(lb.x, lb.y, lb.z, R() * TAU);
    }
    return new THREE.InstancedBufferAttribute(new Float32Array(arr), 4);
  };
  const TUFT = ['#A3C75A', '#B2D066', '#93BD55', '#BCD46E', '#9CC45C'];
  const tufts = [], sT = sampler('wTuft', o.seed + 202);
  for (let i = 0; i < N(700); i++) {
    sT.sample(tp, tn);
    const h = (5 + Math.pow(R(), 1.3) * 8) * Math.sqrt(LS), w = h * (0.7 + R() * 0.4);
    const m = place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(w, h, w), sink: 0.8, lean: back.clone().multiplyScalar(0.2 + R() * 0.2) });
    tufts.push({ m, c: pick(R(), TUFT), h, w });
  }
  const tuftMat = toon('grass', { side: THREE.DoubleSide, edgeNoise: 0.02, outlineW: 0.3, ...bendHooks({ extraPars: swayPars, extraBegin: swayBegin }) });
  add(group, inst(geoTuft(o.seed + 3), tuftMat, tufts, 'kun-tufts', { aSway: swayInst(tufts, null, null, null, 0.35) }), outlineVertexOf(U, { pars: swayPars, begin: swayBegin }));

  // 细长水草：保留背上那圈“毛茸茸”的侧影，但更细、更少
  const REED = ['#93B865', '#A2C26F', '#86AE60', '#ADC874', '#8DB466'];
  const reeds = [], sR = sampler('wReed', o.seed + 252);
  for (let i = 0; i < N(640); i++) {
    sR.sample(tp, tn);
    const h = 11 + Math.pow(R(), 1.3) * 19, w = (2.2 + R() * 2.2) * Math.sqrt(LS);
    const m = place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(w, h, w), sink: 1.2, lean: back.clone().multiplyScalar(0.3 + R() * 0.3) });
    reeds.push({ m, c: pick(R(), REED), h, w });
  }
  const reedMat = toon('grass', { side: THREE.DoubleSide, edgeNoise: 0.02, outlineW: 0.4, ...bendHooks({ extraPars: swayPars, extraBegin: swayBegin }) });
  add(group, inst(geoReed(), reedMat, reeds, 'kun-reeds', { aSway: swayInst(reeds, null, null, null, 1) }), outlineVertexOf(U, { pars: swayPars, begin: swayBegin }));

  // 小白花：五瓣、花心点黄；大部分顶在苔藓团上
  const FLW = [PALETTE.flower, '#FFF3E2', '#FBE8EE', '#F3EEFF', '#FFFFFF', '#FFF0F2'];
  const flowers = [], sF = sampler('wFlower', o.seed + 303);
  for (let i = 0; i < N(1700); i++) {
    sF.sample(tp, tn);
    const s = (1.2 + R() * 1.5) * Math.sqrt(LS);
    const lift = R() < 0.7 ? (2.5 + R() * 5.5) * LS : 0.3;
    flowers.push({ m: place(tp.clone().addScaledVector(tn, lift), tn, { yaw: R() * TAU, scale: new THREE.Vector3(s, s * (0.8 + R() * 0.4), s), sink: 0.2, lean: new THREE.Vector3((R() - 0.5) * 0.6, 0, (R() - 0.5) * 0.6) }), c: pick(R(), FLW) });
  }
  const flowerMat = toon('flower', { side: THREE.DoubleSide, outlineW: 0.25, uniforms: { uHeart: { value: new THREE.Color(PALETTE.flowerHeart) } },
    ...bendHooks({ extraPars: 'attribute float aHeart;\nvarying float vHeart;\n', extraBegin: 'vHeart = aHeart;' }),
    fragmentPars: 'uniform vec3 uHeart;\nvarying float vHeart;\n', fragmentAlbedo: 'diffuseColor.rgb = mix( diffuseColor.rgb, uHeart, step( 0.5, vHeart ) );' });
  add(group, inst(geoFlower(), flowerMat, flowers, 'kun-flowers'), OV_BEND);

  // 红珊瑚枝：朱砂色，细枝，少而精
  const COR = ['#D8423E', '#E2533F', '#C9373B', '#EA6450', '#D04440'];
  const corals = [], sC = sampler('wCoral', o.seed + 404);
  const coralGeo = geoCoral(o.seed + 1);
  for (let i = 0; i < N(64); i++) {
    sC.sample(tp, tn);
    const s = 12 + R() * 12;
    corals.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(s, s * (0.85 + R() * 0.4), s), sink: 1, lean: back.clone().multiplyScalar(0.12) }), c: pick(R(), COR) });
  }
  const coralMat = toon('coral', { outlineW: 0.75, ...bendHooks({ extraPars: 'varying float vCy;\n', extraBegin: 'vCy = position.y;' }),
    fragmentPars: 'varying float vCy;\n', fragmentAlbedo: 'diffuseColor.rgb *= mix( vec3( 0.86, 0.8, 0.9 ), vec3( 1.22, 1.12, 1.0 ), smoothstep( 0.15, 0.7, vCy ) );' });
  add(group, inst(coralGeo, coralMat, corals, 'kun-corals'), OV_BEND);

  // 玉珠（实例）：只留两处点睛——眼后下方一弯由大到小的珠串（像龙眼下的珠饰，不再是一整圈“舷窗”），吻背一行小珠冠。
  // 体侧的“玉白鳞点”画在身体着色器里（玉鳞，见 BODY_FRAG_ALBEDO），不再用一排铆钉似的实例
  const JADE = [PALETTE.jade, '#EEF2E6', '#DCE8DC', '#F2F0E4', '#E2EBE4'];
  const jades = [];
  const jadeGeo = geoJade();
  for (let x = 291; x > 240;) {                                    // 吻背珠冠：前小后大，间距不匀
    const p = bodyPoint(x, Math.PI / 2), n = bodyNormal(x, Math.PI / 2);
    const s = 0.8 + 0.8 * sstep(292, 248, x) + R() * 0.2;
    jades.push({ m: placeAligned(p, n, AX, new THREE.Vector3(s * 1.1, s, s), 0.25 * s), c: pick(R(), JADE) });
    x -= 5.5 + 2.5 * sstep(292, 248, x) + R() * 1.5;
  }
  const jadeMat = toon('jade', { outlineW: 0.5, ...bendHooks() });
  add(group, inst(jadeGeo, jadeMat, jades, 'kun-jade'), OV_BEND);

  // —— 龙须：两对（长须在上颌前端，短须在下巴），一拍三随波摆，越往梢越甩 ——
  const whiskers = [];
  if (o.whiskers) {
    // 长须从上唇前端（嘴线之上）先往外前探，再顺势后掠成 S 形，梢头上卷一钩（龙须）；短须从下巴垂下
    const WH = [
      { x: 280, ph: -0.36, amp: 12, seed: 0.0, r0: 2.9, r1: 0.5,
        pts: [[0, 0, 0], [4, -5, 8], [0, -14, 16], [-14, -26, 23], [-38, -38, 29], [-70, -46, 33], [-105, -52, 36], [-140, -60, 38], [-172, -72, 39], [-198, -86, 39], [-214, -94, 40], [-226, -93, 42]] },
      { x: 267, ph: -0.9, amp: 7, seed: 1.7, r0: 2.1, r1: 0.45,
        pts: [[0, 0, 0], [2, -6, 4], [-4, -16, 8], [-16, -26, 12], [-34, -34, 15], [-56, -40, 17], [-80, -46, 18], [-100, -54, 18], [-114, -57, 20]] },
    ];
    for (const side of [1, -1]) for (const w of WH) {
      const phi = side > 0 ? w.ph : Math.PI - w.ph;
      const root = bodyPoint(w.x, phi), n = bodyNormal(w.x, phi);
      root.addScaledVector(n, -1.2);
      const pts = w.pts.map(([a, b, c]) => new THREE.Vector3(root.x + a, root.y + b, root.z + side * c));
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      const SEG = 110, RAD = 8;
      const g = new THREE.TubeGeometry(curve, SEG, 1, RAD, false);
      const p = g.attributes.position, nr = g.attributes.normal, along = new Float32Array(p.count);
      for (let i = 0; i < p.count; i++) {
        const a = Math.floor(i / (RAD + 1)) / SEG; along[i] = a;
        const r = lerp(w.r0, w.r1, Math.pow(a, 0.75)) - 1;
        p.setXYZ(i, p.getX(i) + nr.getX(i) * r, p.getY(i) + nr.getY(i) * r, p.getZ(i) + nr.getZ(i) * r);
      }
      g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1)); g.deleteAttribute('uv'); g.computeVertexNormals();
      const whU = { uWhAmp: { value: w.amp }, uWhSeed: { value: w.seed + (side > 0 ? 0.6 : 0) }, uWhSide: { value: side } };
      const whPars = 'attribute float aAlong;\nuniform float uWhAmp, uWhSeed, uWhSide;\nvarying float vAlong;\n';
      const whMove = /* glsl */`
      {
        float al = aAlong;
        float ph = uKunOmega * uKunT + uWhSeed;
        float a1 = pow( al, 1.3 );
        transformed.y += uWhAmp * a1 * sin( ph - al * 5.2 );
        transformed.z += uWhAmp * 0.5 * a1 * sin( ph - al * 4.1 + 1.3 ) * uWhSide;
        transformed.x += uWhAmp * 0.22 * a1 * cos( ph - al * 4.6 );
      }`;
      const mat = toon('whisker', { outlineW: 0.6, uniforms: whU,
        ...bendHooks({ extraPars: whPars, extraBegin: 'vAlong = aAlong;\n' + whMove }),
        fragmentPars: 'varying float vAlong;\n',
        fragmentAlbedo: 'diffuseColor.rgb *= mix( 1.0, 1.06, smoothstep( 0.5, 1.0, vAlong ) );' });
      const mesh = add(group, bindToon(new THREE.Mesh(g, mat), mat), outlineVertexOf(U, { pars: 'attribute float aAlong;\nuniform float uWhAmp, uWhSeed, uWhSide;\n', begin: whMove, uniforms: whU }));
      mesh.name = 'kun-whisker'; mesh.frustumCulled = false;
      whiskers.push(mesh);
    }
  }

  // —— 小迎客松：背上一棵，根扎在苔藓里，松针团一拍三轻摆 ——
  if (o.pine) {
    const { bark, needle } = geoPine(o.seed + 31);
    const px = 28, phi = Math.PI / 2 + 0.16;   // 背中线略偏 -Z 侧（正片主机位看得见）
    const p = bodyPoint(px, phi), n = bodyNormal(px, phi);
    const s = 1.7;
    const im = place(p, n.clone().lerp(UP, 0.6).normalize(), { yaw: 2.1, scale: new THREE.Vector3(s, s, s), sink: 4 });
    const pineSway = /* glsl */`
      {
        float hg = clamp( position.y / 30.0, 0.0, 1.0 );
        transformed.x += 0.9 * hg * hg * sin( uKunT * 1.3 + position.y * 0.05 );
        transformed.z += 0.6 * hg * hg * sin( uKunT * 1.1 + 1.7 );
      }`;
    const barkMat = toon('bark', { outlineW: 0.9, ...bendHooks({ extraBegin: pineSway }) });
    const needleMat = toon('needle', { color: '#4E8456', outlineW: 0.6, ...bendHooks({ extraBegin: pineSway }) });
    const ov = outlineVertexOf(U, { begin: pineSway });
    add(group, inst(bark, barkMat, [{ m: im }], 'kun-pine-bark'), ov);
    add(group, inst(needle, needleMat, [{ m: im }], 'kun-pine-needles'), ov);
  }

  // 鳍尖飘带（挂在鳍的枢轴下，跟鳍一起动；不弯曲）
  const wisps = [];
  for (const f of fins) {
    if (o.wisps) { const w = makeRibbon(f.side, U); f.pivot.add(w); wisps.push(w); }
  }

  // —— 姿态（与 kun.js 相同；胸鳍划水幅度略大，一拍三时动作更读得出）——
  const _v = new THREE.Vector3(), _bq = new THREE.Quaternion(), _sq = new THREE.Quaternion(), _e = new THREE.Euler();
  const jsDy = (x, T) => { const s = clamp((300 - x) / 600, 0, 1.15), e = sstep(0.22, 1, s); return U.uKunAmp.value * e * e * Math.sin(TAU * s * U.uKunWave.value - U.uKunOmega.value * T); };
  const jsBend = (x, T) => [jsDy(x, T), Math.atan((jsDy(x + 1, T) - jsDy(x - 1, T)) / 2)];
  function autoBlink(ts) {
    const l = ((ts - o.blinkOffset) % o.blinkPeriod + o.blinkPeriod) % o.blinkPeriod;
    return l < 0.125 ? 0.6 : l < 0.25 ? 1 : l < 0.375 ? 0.55 : l < 0.5 ? 0.15 : 0;
  }
  const _inv = new THREE.Matrix4(), _tw = new THREE.Vector3();
  function setPose(ts, po = {}) {
    U.uKunT.value = ts;
    for (const f of fins) {
      const [dy, th] = jsBend(f.x0, ts);
      const r = f.root;
      f.pivot.position.set(r.x - r.y * Math.sin(th), dy + r.y * Math.cos(th), r.z);
      const ph = TAU * ts / 5 + (f.side > 0 ? 0 : 0.35);
      _sq.setFromEuler(_e.set(f.side * 0.14 * Math.sin(ph), 0.06 * Math.sin(ph + 1.1), 0));
      _bq.setFromAxisAngle(new THREE.Vector3(0, 0, 1), th);
      f.pivot.quaternion.copy(_bq).multiply(f.baseQ).multiply(_sq);
    }
    const b = po.blink ?? autoBlink(ts);
    for (const e of eyes) {
      e.lidU.rotation.x = lerp(-0.6, 0.03, b);
      e.lidL.rotation.x = lerp(0.48, -0.03, b);
      e.ball.quaternion.identity();
      if (po.look) {
        group.updateWorldMatrix(true, false); e.group.updateWorldMatrix(false, false);
        _tw.copy(po.look).applyMatrix4(_inv.copy(e.group.matrixWorld).invert()).normalize();
        const yaw = clamp(Math.atan2(_tw.x, _tw.z), -0.35, 0.35), pitch = clamp(Math.asin(clamp(_tw.y, -1, 1)), -0.28, 0.28);
        e.ball.quaternion.setFromEuler(_e.set(-pitch, yaw, 0, 'YXZ'));
      }
      const tu = e.mat.userData.toon;
      _q.copy(e.ball.quaternion).invert();
      _v.set(-0.27, 0.24, 0.93).normalize().applyQuaternion(_q);
      tu.uCatch1.value.set(_v.x, _v.y, _v.z, 0.9835);
      _v.set(0.26, -0.2, 0.94).normalize().applyQuaternion(_q);
      tu.uCatch2.value.set(_v.x, _v.y, _v.z, 0.9966);
      const aU = e.lidU.rotation.x, aL = e.lidL.rotation.x;
      tu.uLidU.value.set(0, Math.cos(aU), Math.sin(aU)).applyQuaternion(_q);
      tu.uLidL.value.set(0, -Math.cos(aL), -Math.sin(aL)).applyQuaternion(_q);
    }
  }
  function eyeWorld(target = new THREE.Vector3(), ref = -1) {
    let e = eyes.find(x => x.side === -1);
    if (ref && ref.isVector3) { const a = eyes[0].group.getWorldPosition(new THREE.Vector3()), b2 = eyes[1].group.getWorldPosition(new THREE.Vector3()); e = a.distanceTo(ref) < b2.distanceTo(ref) ? eyes[0] : eyes[1]; }
    else if (ref === 1) e = eyes.find(x => x.side === 1);
    return e.group.getWorldPosition(target);
  }
  function fitShadow(light, { size = 4096, radius = 380 } = {}) {
    group.updateMatrixWorld(true);
    const c = new THREE.Vector3(-10, -5, 0).applyMatrix4(group.matrixWorld);
    const sc = group.matrixWorld.getMaxScaleOnAxis(), R2 = radius * sc;
    const dir = light.position.clone().sub(light.target.position);
    if (dir.lengthSq() < 1e-9) dir.set(0.75, 0.1, 0.65); dir.normalize();
    light.target.position.copy(c); light.target.updateMatrixWorld();
    light.position.copy(c).addScaledVector(dir, R2 * 3);
    const cam = light.shadow.camera;
    Object.assign(cam, { left: -R2, right: R2, top: R2, bottom: -R2, near: R2 * 0.5, far: R2 * 5.5 });
    cam.updateProjectionMatrix();
    if (light.shadow.mapSize.x !== size) { light.shadow.mapSize.set(size, size); light.shadow.map?.dispose(); light.shadow.map = null; }
    light.shadow.normalBias = 1.5 * sc; light.shadow.bias = -0.0005; light.shadow.radius = 2;
    light.castShadow = true;
  }
  setPose(0);
  return { group, setPose, eyeWorld, fitShadow, outlineMeshes, length: 600, eyeRadius: RE, wisps, uniforms: U, fins, eyes, whiskers };
}

// 鳍尖飘带：两色丝带（正面米杏、反面淡紫），沿程扭转、越往后越窄越淡，一拍三起伏；不描边，描边通道里丢弃
function makeRibbon(side, U) {
  const tip = finPlan(0.985), base = new THREE.Vector3(tip.le - tip.c * 0.5, tip.y, side * FIN_SPAN * 0.985);
  const NS = 120, pos = [], al = [], cr = [], idx = [];
  for (let i = 0; i <= NS; i++) {
    const a = i / NS;
    // 中心线：往后拖 230 米，上下一个半 S 弯、向外缓缓飘开（飞天披帛的走势）
    const cx = base.x - a * 230, cy = base.y - a * 22 + Math.sin(a * 6.0 + 0.4) * 16 * Math.pow(a, 0.8), cz = base.z + side * (a * 26 + Math.sin(a * 4.2) * 10 * a);
    const w = lerp(13, 1.2, Math.pow(a, 0.9)) * (0.9 + 0.1 * Math.sin(a * 9));
    const tw = 0.35 + a * 1.6 + 0.35 * Math.sin(a * 5.0);   // 缓扭，正反面交替露出
    const dy = Math.cos(tw), dz = Math.sin(tw) * side;
    for (const s of [-1, 1]) { pos.push(cx, cy + dy * w * s * 0.5, cz + dz * w * s * 0.5); al.push(a); cr.push(s); }
  }
  for (let i = 0; i < NS; i++) { const a = 2 * i; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(al, 1)); g.setAttribute('aCross', new THREE.Float32BufferAttribute(cr, 1));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.ShaderMaterial({
    uniforms: { uKunT: U.uKunT, uToonPass: TOON_SHARED.uToonPass, uA: { value: new THREE.Color('#FFE6D0') }, uB: { value: new THREE.Color('#D2C2F2') }, uEdge: { value: new THREE.Color('#F29A86') } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      uniform float uKunT; attribute float aAlong; attribute float aCross; varying float vA; varying float vC;
      void main() {
        vec3 p = position;
        p.y += sin( uKunT * 2.1 - aAlong * 6.5 ) * 7.0 * aAlong;
        p.z += sin( uKunT * 1.7 - aAlong * 5.0 + 1.0 ) * 5.0 * aAlong;
        vA = aAlong; vC = aCross;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uA, uB, uEdge; uniform float uToonPass; varying float vA; varying float vC;
      void main() {
        if ( uToonPass > 0.5 ) discard;
        float fade = ( 1.0 - smoothstep( 0.55, 1.0, vA ) ) * smoothstep( 0.0, 0.04, vA );
        vec3 c = gl_FrontFacing ? uA : uB;
        float fe = max( fwidth( vC ), 1e-4 );
        float edge = smoothstep( 0.8 - fe, 0.8 + fe, abs( vC ) );   // 两侧一道杏色细边
        c = mix( c, uEdge, edge * 0.7 );
        float a = ( 0.56 + 0.2 * step( 0.45, fade ) ) * step( 0.1, fade );   // 透明度只分两档（像画的纱）
        gl_FragColor = vec4( c, a );
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'kun-ribbon'; mesh.frustumCulled = false; mesh.renderOrder = 2;
  mesh.userData.outline = false; mesh.userData.wisp = true;
  return mesh;
}
