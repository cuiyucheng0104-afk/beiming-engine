// 北冥引擎 · 小道具几何：单位尺寸（底在 y≈0、朝上为 +Y），交给实例矩阵缩放摆位。随机只来自 mulberry(种子)。
//   clump({ a1, a2, flat })          凹凸的团（二十面体细分两次，顶点按两层正弦起伏推拉，再压扁）
//   moundCluster(seed)              几个大小不一的鼓包挤成一团（整体扁、底略埋）
//   barnacle()                      火山口形：11 棱、口沿内收、棱片不规则
//   scallop()                       带放射肋的扇面穹顶 + 小耳朵
//   petalDisc({ rings, segs, lobes, base, amp, sharp, height(r), attrs })  极坐标花盘：半径按 |cos(瓣数·θ)| 起瓣，
//       高度 height(r)；attrs[名] = r => 值（逐顶点一维属性）。返回带索引的几何体
//   flowerHead({ disc, stalk: { r0, r1, h, y }, bud: { r, y } })  花盘 + 可选短柱、花苞；y 是中心高度（短柱缺省 h/2 = 底在 0，
//       花苞缺省 disc.height(0) = 花心）；花盘带 attrs 时短柱和花苞补同名属性（取花心 r = 0 的值），合并不会因属性不齐失败
//   petalFan({ petals, petal: rgb, heart: rgb })  五瓣扇形小片 + 花心（顶点色）
//   branchCoral(seed, { fan, ... })  分叉珊瑚：fan = false 立体分叉；true 枝条压在一个平面里成扇
//   dome(ws, hs, [sx, sy, sz], keepUV)  半球压扁（疙瘩、玉片）
//   flake(seed)                     不规则六边薄片
//   card(kind, NA, NC)              沿 +X 0..1、横向 ±Z、法线 +Y 的卡片：'round' 覆羽 / 鳞形，'long' 飞羽，'flame' 火焰舌；带 aCard = (u, v)
//   boatHull(L, B, H, draft)        船身：俯视船头尖（+X）、船尾方，挤出高 H，船底收窄；水线在 y = 0（吃水 draft）
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry, lerp, ss, seg, TAU } from '../core/math.js';

const sstep = (a, b, x) => ss(seg(x, a, b));
const UP = new THREE.Vector3(0, 1, 0);

export function clump({ a1 = 0.13, a2 = 0.07, flat = 0.8 } = {}) {
  let g = new THREE.IcosahedronGeometry(1, 2); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g = mergeVertices(g, 1e-4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + a1 * Math.sin(x * 5.1 + y * 3.7) * Math.sin(z * 4.3 - x * 2.1) + a2 * Math.sin(y * 9.3 + z * 7.1);
    p.setXYZ(i, x * k, y * k * flat, z * k);
  }
  g.computeVertexNormals(); return g;
}

export function moundCluster(seed) {
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

export function barnacle() {
  const pts = [[1, 0], [0.98, 0.1], [0.84, 0.36], [0.64, 0.58], [0.5, 0.66], [0.43, 0.64], [0.36, 0.5], [0.22, 0.42], [0.001, 0.4]].map(([x, y]) => new THREE.Vector2(x, y));
  let g = new THREE.LatheGeometry(pts, 11);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x);
    const k = 1 + 0.08 * Math.sin(a * 5 + 1.3) + 0.05 * Math.sin(a * 3 - 0.4);
    p.setXYZ(i, x * k, y * (1 + 0.08 * Math.sin(a * 4 + 0.7)), z * k);
  }
  g.computeVertexNormals();
  return g;
}

export function scallop() {
  const R = 10, S = 20, pos = [], idx = [];
  for (let i = 0; i <= R; i++) for (let j = 0; j <= S; j++) {
    const r = i / R, th = lerp(-1.25, 1.25, j / S);
    const rib = 0.05 * Math.pow(Math.abs(Math.cos(th * 9 / 1.25 * Math.PI / 2)), 0.6) * r;
    pos.push(r * Math.sin(th), 0.28 * (1 - r * r) + rib + 0.02, r * Math.cos(th) - 0.45);
  }
  for (let i = 0; i < R; i++) for (let j = 0; j < S; j++) { const a = i * (S + 1) + j, b = a + S + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const ear = new THREE.BoxGeometry(0.5, 0.08, 0.16); ear.translate(0, 0.04, -0.47); ear.deleteAttribute('uv');
  return mergeGeometries([g.toNonIndexed(), ear.toNonIndexed()]);
}

export function petalDisc({ rings, segs, lobes, base, amp, sharp, height, attrs = {} }) {
  const pos = [], idx = [], extra = {};
  for (const n in attrs) extra[n] = [];
  for (let i = 0; i <= rings; i++) for (let j = 0; j <= segs; j++) {
    const r = i / rings, th = j / segs * TAU, k = base + amp * Math.pow(Math.abs(Math.cos(lobes * th)), sharp);
    pos.push(r * k * Math.cos(th), height(r), r * k * Math.sin(th));
    for (const n in attrs) extra[n].push(attrs[n](r));
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) { const a = i * (segs + 1) + j, b = a + segs + 1; idx.push(a, a + 1, b, b, a + 1, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  for (const n in attrs) g.setAttribute(n, new THREE.Float32BufferAttribute(extra[n], 1));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export function flowerHead({ disc, stalk = null, bud = null }) {
  const parts = [petalDisc(disc).toNonIndexed()];
  // mergeGeometries 要求各部分属性一致：花盘的逐顶点属性给短柱、花苞补上花心处的值
  const fill = g => {
    for (const n in disc.attrs || {}) g.setAttribute(n, new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(disc.attrs[n](0)), 1));
    return g;
  };
  if (stalk) { const s = new THREE.CylinderGeometry(stalk.r0, stalk.r1, stalk.h, 8, 1, true); s.translate(0, stalk.y ?? stalk.h / 2, 0); s.deleteAttribute('uv'); parts.push(fill(s.toNonIndexed())); }
  if (bud) { const b = new THREE.SphereGeometry(bud.r, 8, 6); b.translate(0, bud.y ?? disc.height(0), 0); b.deleteAttribute('uv'); parts.push(fill(b.toNonIndexed())); }
  const g = mergeGeometries(parts);
  if (!g) throw new Error('flowerHead：花盘、短柱、花苞的顶点属性对不上，合并失败');
  return g;
}

export function petalFan({ petals = 5, petal, heart }) {
  const pos = [], col = [];
  for (let k = 0; k < petals; k++) {
    const a0 = k / petals * TAU;
    const nseg = 6;
    for (let j = 0; j < nseg; j++) {
      const t0 = j / nseg, t1 = (j + 1) / nseg;
      const pt = t => { const a = a0 + (t - 0.5) * 1.05, r = 0.95 * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.85)) * 0.35 + 0.62; return [Math.cos(a) * r, 0.1 + 0.18 * r * r, Math.sin(a) * r]; };
      const c0 = [0, 0.08, 0];
      const p0 = pt(t0), p1 = pt(t1);
      pos.push(...c0, ...p1, ...p0); col.push(...petal, ...petal, ...petal);
    }
  }
  for (let k = 0; k < 8; k++) {
    const a0 = k / 8 * TAU, a1 = (k + 1) / 8 * TAU, r = 0.24;
    pos.push(0, 0.2, 0, Math.cos(a1) * r, 0.14, Math.sin(a1) * r, Math.cos(a0) * r, 0.14, Math.sin(a0) * r); col.push(...heart, ...heart, ...heart);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
  return g;
}

// 立体分叉：每级 fork[级 0 / 其后] 根，绕主枝随机方位、倾角 tilt[0] + R·tilt[1]，再朝父枝方向收拢 follow；
// 枝长 × (lenK[0] + R·lenK[1])、半径 × radK；到 depth 级在梢上放一颗 tip 倍半径的圆头
export function branchCoral(seed, { fan = false, taper = 0.62, depth = fan ? 3 : 2, tip = 0.95, fork = fan ? [4, 3] : [5, 2], spread = 0.3,
  tilt = [0.4, 0.5], follow = 0.3, lenK = [0.64, 0.22], radK = 0.7, len = fan ? 0.3 : 0.36, rad = fan ? 0.07 : 0.1 } = {}) {
  const R = mulberry(seed), parts = [];
  const branch = (base, dir, len, rad, d) => {
    const g = new THREE.CylinderGeometry(rad * taper, rad, len, 6, 1, false);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir)); g.translate(base.x, base.y, base.z);
    parts.push(g.toNonIndexed());
    const end = base.clone().addScaledVector(dir, len);
    if (d >= depth) { const s = new THREE.SphereGeometry(rad * tip, 7, 5); s.translate(end.x, end.y, end.z); parts.push(s.toNonIndexed()); return; }
    const n = d === 0 ? fork[0] : fork[1];
    for (let i = 0; i < n; i++) {
      let v;
      if (fan) { const a = lerp(-0.9, 0.9, (i + 0.5) / n) + (R() - 0.5) * 0.25; v = new THREE.Vector3(Math.sin(a), Math.cos(a), (R() - 0.5) * 0.12).lerp(dir, follow).normalize(); }
      else { const a = (i / n + R() * spread) * TAU, tl = tilt[0] + R() * tilt[1]; v = new THREE.Vector3(Math.sin(tl) * Math.cos(a), Math.cos(tl), Math.sin(tl) * Math.sin(a)).lerp(dir, follow).normalize(); }
      branch(end, v, len * (lenK[0] + R() * lenK[1]), rad * radK, d + 1);
    }
  };
  branch(new THREE.Vector3(0, 0, 0), UP.clone(), len, rad, 0);
  const g = mergeGeometries(parts); g.deleteAttribute('uv');
  return g;
}

export function dome(ws, hs, [sx, sy, sz], keepUV = true) {
  const g = new THREE.SphereGeometry(1, ws, hs, 0, TAU, 0, Math.PI / 2); g.scale(sx, sy, sz);
  if (!keepUV) g.deleteAttribute('uv');
  return g;
}

export function flake(seed) {
  const R = mulberry(seed), pts = [];
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + (R() - 0.5) * 0.5, r = 0.75 + R() * 0.35; pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r)); }
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.14, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); g.deleteAttribute('uv');
  return g;
}

function cardShape(kind, u, vn) {
  if (kind === 'round') {
    const hw = 0.5 * (u < 0.55 ? 0.42 + 0.58 * Math.sin(Math.PI / 2 * u / 0.55) : Math.sqrt(Math.max(0, 1 - Math.pow((u - 0.55) / 0.45, 2))));
    return [u, 0.17 * (1 - vn * vn) * (0.35 + 0.65 * u) - 0.14 * u * u, vn * hw];
  }
  // long：羽柄细，羽片长，梢圆中带尖，略向下弯
  const base = 0.3 + 0.7 * Math.pow(sstep(0, 0.16, u), 0.7);
  const tip = u > 0.66 ? Math.pow(Math.max(0, 1 - Math.pow((u - 0.66) / 0.34, 2)), 0.62) : 1;
  const hw = 0.5 * base * tip;
  return [u, 0.12 * (1 - vn * vn) - 0.22 * u * u, vn * hw];
}
export function card(kind, NA, NC) {
  const pos = [], cd = [], idx = [];
  if (kind === 'flame') {
    // 中心线：航向角 h（从卡片 +X 转向 +Z），积分得位置；宽度向梢收尖（先外伸，再后掠，梢部回挑）
    const cl = [], hs = []; let x = 0, z = 0;
    for (let i = 0; i <= NA; i++) {
      const u = i / NA, h = 0.22 + 1.55 * Math.pow(u, 1.35) - 1.35 * sstep(0.6, 1.0, u);
      cl.push([x, z]); hs.push(h);
      x += Math.cos(h) / NA; z += Math.sin(h) / NA;
    }
    for (let i = 0; i <= NA; i++) {
      const u = i / NA, h = hs[i], nx = -Math.sin(h), nz = Math.cos(h);
      const hw = 0.21 * Math.pow(1 - u, 0.75) * (0.55 + 0.45 * sstep(0, 0.2, u));
      for (let j = 0; j < NC; j++) {
        const vn = -1 + 2 * j / (NC - 1);
        pos.push(cl[i][0] + nx * vn * hw, 0.05 * (1 - vn * vn), cl[i][1] + nz * vn * hw); cd.push(u, vn);
      }
    }
  } else {
    for (let i = 0; i <= NA; i++) for (let j = 0; j < NC; j++) {
      const u = i / NA, vn = -1 + 2 * j / (NC - 1), P = cardShape(kind, u, vn);
      pos.push(P[0], P[1], P[2]); cd.push(u, vn);
    }
  }
  for (let i = 0; i < NA; i++) for (let j = 0; j < NC - 1; j++) {
    const a = i * NC + j, b = a + NC;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCard', new THREE.Float32BufferAttribute(cd, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export function boatHull(L, B, Hh, draft = 1) {
  const s = new THREE.Shape();
  const h = B / 2;
  s.moveTo(-L / 2, -h * 0.92);
  s.lineTo(L * 0.22, -h);
  s.quadraticCurveTo(L * 0.44, -h * 0.75, L / 2, 0);
  s.quadraticCurveTo(L * 0.44, h * 0.75, L * 0.22, h);
  s.lineTo(-L / 2, h * 0.92);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: Hh, bevelEnabled: false, curveSegments: 10 });
  g.rotateX(-Math.PI / 2);          // 挤出方向 z → y
  const p = g.attributes.position;  // 船底收窄一点（侧面略斜）
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < 0.01) { p.setX(i, p.getX(i) * 0.97); p.setZ(i, p.getZ(i) * 0.86); } }
  g.translate(0, -draft, 0);
  g.computeVertexNormals();
  return g;
}
