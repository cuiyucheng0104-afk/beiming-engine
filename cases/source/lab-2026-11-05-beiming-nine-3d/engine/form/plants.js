// 北冥引擎 · 植物几何：单位尺寸（根在原点、向上 +Y，叶片另有约定），交给实例矩阵或烘焙矩阵摆位。随机只来自 mulberry(种子)。
//   blade({ taper, twist, wave, keepUV })  一条飘带叶：高 1、底宽 1，向上收窄、扭转、略弯（海带、水草）；position.y 即高度比例
//   tuft(seed)                       草簇：6 片细叶从一点散开、向外弯
//   fern()                           小蕨：拱起的叶轴 + 两侧逐渐变短的羽片
//   strands()                        垂下的细带（-Y 方向），一长两短
//   pineTree(seed)                   虬曲的干 + 几层平顶针叶团，高约 1；aPart：0 干枝，1 针叶
//   leaf({ L, W, nU, nV, droop, cup, curl, wave, rootW, asym, twist, seed })
//       一片叶 / 鳍片：局部 X 沿长、Y 横向、Z 法向，根在原点；aFin = (u 根→尖, v 横向 -1..1, 该处半宽)，aFinN = 扑动方向（初值 +Z）
//   bakeLeaf(g, m)                   把叶片烘到矩阵 m 里，aFinN 一起转过去
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry, lerp, TAU } from '../core/math.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export function blade({ taper = 0.62, twist = 0.9, wave = 0.06, keepUV = true } = {}) {
  const g = new THREE.PlaneGeometry(1, 1, 1, 9); g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), x = p.getX(i), w = 1 - taper * y, tw = twist * y;
    const xx = x * w;
    p.setXYZ(i, xx * Math.cos(tw), y, xx * Math.sin(tw) + wave * Math.sin(y * 5.0));
  }
  if (!keepUV) g.deleteAttribute('uv');
  g.computeVertexNormals(); return g;
}

export function tuft(seed) {
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

export function fern() {
  const pos = [], NP = 9, axis = t => new THREE.Vector3(0, t * 0.95, -0.34 * t * t);
  const tan = t => new THREE.Vector3(0, 0.95, -0.68 * t).normalize();
  const quad = (a, b, c, d) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  for (let i = 0; i < 12; i++) {             // 叶轴：细条
    const t0 = i / 12, t1 = (i + 1) / 12, w0 = 0.022 * (1 - t0) + 0.006, w1 = 0.022 * (1 - t1) + 0.006;
    const a = axis(t0), b = axis(t1);
    quad(a.clone().add(new THREE.Vector3(-w0, 0, 0)), a.clone().add(new THREE.Vector3(w0, 0, 0)), b.clone().add(new THREE.Vector3(w1, 0, 0)), b.clone().add(new THREE.Vector3(-w1, 0, 0)));
  }
  for (let i = 0; i < NP; i++) {             // 羽片：窄三角，尖朝外上
    const t = 0.12 + 0.82 * i / (NP - 1), L = 0.36 * Math.pow(1 - t, 0.7) + 0.05, Wd = 0.075 * (1 - t * 0.5);
    const c = axis(t), tg = tan(t);
    for (const sd of [-1, 1]) {
      const out = new THREE.Vector3(sd, 0.35, 0).normalize();
      const tip = c.clone().addScaledVector(out, L).addScaledVector(tg, L * 0.35);
      const b0 = c.clone().addScaledVector(tg, -Wd * 0.5), b1 = c.clone().addScaledVector(tg, Wd * 0.5);
      const mid = c.clone().addScaledVector(out, L * 0.55).addScaledVector(tg, L * 0.18 + Wd * 0.35);
      const mid2 = c.clone().addScaledVector(out, L * 0.55).addScaledVector(tg, L * 0.18 - Wd * 0.35);
      quad(b0, mid2, mid, b1); pos.push(mid2.x, mid2.y, mid2.z, tip.x, tip.y, tip.z, mid.x, mid.y, mid.z);
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return g;
}

export function strands() {
  const pos = [];
  const strand = (ox, oz, len, w, ph) => {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const P = t => [ox + 0.08 * Math.sin(t * 7 + ph) * t, -t * len, oz + 0.05 * Math.cos(t * 5 + ph) * t];
      const w0 = w * (1 - 0.75 * t0), w1 = w * (1 - 0.75 * t1);
      const a = P(t0), b = P(t1);
      pos.push(a[0] - w0, a[1], a[2], a[0] + w0, a[1], a[2], b[0] + w1, b[1], b[2], a[0] - w0, a[1], a[2], b[0] + w1, b[1], b[2], b[0] - w1, b[1], b[2]);
    }
  };
  strand(0, 0, 1, 0.12, 0); strand(0.1, 0.06, 0.6, 0.08, 1.7); strand(-0.09, -0.05, 0.45, 0.07, 3.1);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return g;
}

export function pineTree(seed) {
  const R = mulberry(seed), parts = [];
  const ph1 = R() * TAU, ph2 = R() * TAU, bend = 0.1 + R() * 0.12;
  const trunk = t => V3(bend * Math.sin(t * 2.6 + ph1) * t + 0.05 * t, t * 0.78, 0.07 * Math.sin(t * 3.3 + ph2) * t);
  const tube = (curve, r0, r1, part) => {
    const g = new THREE.TubeGeometry(curve, 10, 1, 6, false);
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const sg = Math.floor(i / 7), t = sg / 10, c = curve.getPoint(t), r = lerp(r0, r1, t);
      p.setXYZ(i, c.x + n.getX(i) * r, c.y + n.getY(i) * r, c.z + n.getZ(i) * r);
    }
    g.deleteAttribute('uv'); g.computeVertexNormals();
    const a = new Float32Array(p.count).fill(part); g.setAttribute('aPart', new THREE.BufferAttribute(a, 1));
    parts.push(g.toNonIndexed());
  };
  const tc = new THREE.CatmullRomCurve3([0, 0.25, 0.5, 0.75, 1].map(trunk));
  tube(tc, 0.05, 0.022, 0);
  const pad = (c, sx, sy, sz) => {
    let g = new THREE.IcosahedronGeometry(1, 2); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g = mergeVertices(g, 1e-4);
    const p = g.attributes.position, ps = R() * 10;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.12 * Math.sin(x * 6 + z * 5 + ps) + 0.06 * Math.sin(x * 13 - z * 11);
      if (y < 0) y *= 0.45;                                        // 底平、顶拱：一层层的松针
      p.setXYZ(i, c.x + x * sx * k, c.y + y * sy, c.z + z * sz * k);
    }
    g.computeVertexNormals();
    const a = new Float32Array(p.count).fill(1); g.setAttribute('aPart', new THREE.BufferAttribute(a, 1));
    parts.push(g.toNonIndexed());
  };
  const top = trunk(1);
  pad(top.clone().add(V3(0, 0.08, 0)), 0.3, 0.1, 0.24);
  const nb = 3 + Math.floor(R() * 2);
  for (let b = 0; b < nb; b++) {
    const t = 0.42 + b / nb * 0.5 + R() * 0.06, base = trunk(t);
    const a = R() * TAU, len = 0.2 + R() * 0.2 * (1 - t * 0.4);
    const end = base.clone().add(V3(Math.cos(a) * len, 0.05 + R() * 0.08, Math.sin(a) * len * 0.75));
    const mid = base.clone().lerp(end, 0.5).add(V3(0, 0.04, 0));
    tube(new THREE.CatmullRomCurve3([base, mid, end]), 0.024, 0.012, 0);
    pad(end.clone().add(V3(0, 0.03, 0)), 0.2 + R() * 0.08, 0.075, 0.16 + R() * 0.06);
  }
  return mergeGeometries(parts);
}

export function leaf({ L, W, nU = 30, nV = 12, droop = 0.06, cup = 0.1, curl = 0.08, wave = 0.06, rootW = 0.22, asym = 0.18, twist = 0, seed = 1 }) {
  const R = mulberry(seed), ph = R() * TAU;
  const pos = [], fin = [], idx = [];
  for (let i = 0; i <= nU; i++) {
    const u = i / nU;
    const w = W * (Math.pow(Math.sin(Math.PI * Math.pow(u, 0.6)), 0.85) + rootW * (1 - u) * (1 - u));
    for (let j = 0; j <= nV; j++) {
      const v = j / nV * 2 - 1;
      const full = Math.sign(v) === (asym >= 0 ? -1 : 1);          // asym > 0：-Y 侧饱满；< 0：+Y 侧饱满
      let wv = w * (full ? 1 + Math.abs(asym) : 1 - Math.abs(asym) * 0.5);
      if (full) wv *= 1 + wave * Math.sin(u * 8 * Math.PI + ph) * Math.min(1, u * 3);
      const y0 = v * wv, z0 = cup * W * (v * v - 0.35) * Math.sin(Math.PI * Math.min(1, u * 1.15));
      const ta = twist * u, ct = Math.cos(ta), st = Math.sin(ta);
      const y = y0 * ct - z0 * st + curl * L * u * u * u;
      const z = y0 * st + z0 * ct + droop * L * u * u;
      pos.push(u * L, y, z); fin.push(u, v, Math.max(0.01, wv));
    }
  }
  for (let i = 0; i < nU; i++) for (let j = 0; j < nV; j++) { const a = i * (nV + 1) + j, b = a + nV + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFin', new THREE.Float32BufferAttribute(fin, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const n = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < n.length; i += 3) n[i + 2] = 1;
  g.setAttribute('aFinN', new THREE.BufferAttribute(n, 3));
  return g;
}

export function bakeLeaf(g, m) {
  g.applyMatrix4(m);
  const n = g.attributes.aFinN, nm = new THREE.Matrix3().getNormalMatrix(m), t = V3();
  for (let i = 0; i < n.count; i++) { t.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); n.setXYZ(i, t.x, t.y, t.z); }
  return g;
}
