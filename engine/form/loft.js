// 北冥引擎 · 放样：沿主轴 x 由轮廓表（顶线、底线、半宽）定义的长条形体，环带放样成网格，以及按平面形放样的翼 / 鳍。
//   profileBody({ xs, top, bottom, width, exp: [上半, 下半], deform })
//       → { top(x), bottom(x), width(x), mid(x), point(x, phi, out), normal(x, phi, out) }
//       截面是上下两半指数不同的超椭圆；phi：0 = +Z 侧水平，π/2 = 背中线。
//       deform(p) 在出点前改写 p.y / p.z（p 里还有 x、c = cosφ、s = sinφ、yc 截面中心、a 半高、W 半宽、dy / dz 未加中心的超椭圆偏移）
//   sideAngle(c, s)            把左右两侧折到同一侧的侧向角（-π/2 腹中线 … 0 体侧 … π/2 背中线）
//   axisStations(x0, x1, n, k) 主轴上 n 个站位，两端按余弦加密（k = 加密程度，0 均匀）
//   ringsAt(point, xs, nv)     每个站位一圈 nv 个点
//   loftRings(rings, { startCap, endCap, attrs })  环首尾相接的网格；cap = { p, attr }，attrs[名] = { data, size }
//   loftWing({ nS, nC, span0, span1, plan, attrs })  翼型放样：展向沿 Z，弦向沿 X（前缘在 +X），厚度沿 Y；
//       plan(t, z) → { le 前缘 x, c 弦长, th 厚度, y?, camber? }；attrs[名] = { size, at(t, cp, z), start, end }
//   unwrap(body, x0, x1, M)    把放样体表面展开成 (U, s)：U = 沿体侧中线（y = mid、z = width）量的弧长，
//       s = 截面上从体侧中线沿表面量的弧长（向背为正，左右镜像）。主轴每 1 单位一张截面表，每张半圈 M 步（偶数）
//       → { Ux(x), sX(x, ph), xU(U), st(x) 背中线 s, sb(x) 腹中线 |s|, phOfS(x, s), stU, sbU, P(x, ph) → [U, s],
//           ring(x) 截面表, sOf(表, ph), Ucap 吻端封口的 U, smax }
import * as THREE from 'three';
import { monotone, clamp, lerp, TAU } from '../core/math.js';

export const sideAngle = (c, s) => { const p = Math.atan2(s, c); return c >= 0 ? p : (p >= 0 ? Math.PI - p : -Math.PI - p); };

export function profileBody({ xs, top, bottom, width, exp: [eUp, eDown], deform = null }) {
  const curve = ys => monotone(xs.map((x, i) => [x, ys[i]]));
  const fT = curve(top), fB = curve(bottom), fW = curve(width);
  const p = { x: 0, c: 0, s: 0, yc: 0, a: 0, W: 0, dy: 0, dz: 0, y: 0, z: 0 };
  function point(x, phi, out = new THREE.Vector3()) {
    const yT = fT(x), yB = fB(x), W = fW(x), yc = (yT + yB) / 2, a = (yT - yB) / 2;
    const c = Math.cos(phi), s = Math.sin(phi), e = 2 / (s >= 0 ? eUp : eDown);
    const dz = W * Math.sign(c) * Math.pow(Math.abs(c), e), dy = a * Math.sign(s) * Math.pow(Math.abs(s), e);
    p.x = x; p.c = c; p.s = s; p.yc = yc; p.a = a; p.W = W; p.dy = dy; p.dz = dz; p.y = yc + dy; p.z = dz;
    if (deform) deform(p);
    return out.set(x, p.y, p.z);
  }
  const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _p3 = new THREE.Vector3(), _p4 = new THREE.Vector3();
  function normal(x, phi, out = new THREE.Vector3()) {
    point(x + 0.5, phi, _p1); point(x - 0.5, phi, _p2); point(x, phi + 0.004, _p3); point(x, phi - 0.004, _p4);
    return out.copy(_p1.sub(_p2)).cross(_p3.sub(_p4)).normalize();
  }
  return { top: fT, bottom: fB, width: fW, mid: x => (fT(x) + fB(x)) / 2, point, normal };
}

export function axisStations(x0, x1, n, k = 0.5) {
  const xs = [];
  for (let j = 0; j < n; j++) { const u = j / (n - 1), w = 0.5 - 0.5 * Math.cos(Math.PI * u); xs.push(lerp(x0, x1, lerp(u, w, k))); }
  return xs;
}

export function ringsAt(point, xs, nv) {
  return xs.map(x => { const ring = []; for (let k = 0; k < nv; k++) ring.push(point(x, k / nv * TAU)); return ring; });
}

export function loftRings(rings, { startCap, endCap, attrs = {} } = {}) {
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

export const ringCenter = ring => { const c = new THREE.Vector3(); ring.forEach(p => c.add(p)); return c.multiplyScalar(1 / ring.length); };

export function loftWing({ nS, nC, span0, span1, plan, attrs = {} }) {
  const rings = [], dir = Math.sign(span1 - span0), data = {};
  for (const n in attrs) data[n] = [];
  for (let j = 0; j < nS; j++) {
    const t = j / (nS - 1), z = lerp(span0, span1, t), P = plan(t, z);
    const ring = [];
    for (let k = 0; k < nC; k++) {
      const al = k / nC * TAU, cp = (1 - Math.cos(al)) / 2, sg = (Math.sin(al) >= 0 ? 1 : -1) * (dir > 0 ? -1 : 1);
      const h = P.th * 0.5 * 2.6 * Math.sqrt(cp) * (1 - cp);
      ring.push(new THREE.Vector3(P.le - cp * P.c, (P.y ?? 0) + sg * h + (P.camber || 0) * Math.sin(Math.PI * cp), z));
      for (const n in attrs) data[n].push(...attrs[n].at(t, cp, z));
    }
    rings.push(ring);
  }
  const cap = key => { const o = {}; for (const n in attrs) o[n] = attrs[n][key]; return o; };
  const all = {}; for (const n in attrs) all[n] = { data: data[n], size: attrs[n].size };
  return loftRings(rings, { startCap: { p: ringCenter(rings[0]), attr: cap('start') }, endCap: { p: ringCenter(rings[nS - 1]), attr: cap('end') }, attrs: all });
}

export function unwrap(body, x0, x1, M = 160) {
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  function ring(x) {
    const tab = new Float32Array(M + 1);
    body.point(x, -Math.PI / 2, _b); let acc = 0; tab[0] = 0;
    for (let i = 1; i <= M; i++) { body.point(x, -Math.PI / 2 + i * Math.PI / M, _a); acc += _a.distanceTo(_b); tab[i] = acc; _b.copy(_a); }
    const s0 = tab[M / 2];
    for (let i = 0; i <= M; i++) tab[i] -= s0;
    return tab;   // tab[0] = -腹中线弧长，tab[M] = +背中线弧长
  }
  const sOf = (tab, ph) => { const f = clamp((ph + Math.PI / 2) / Math.PI) * M; const i = Math.min(M - 1, Math.floor(f)), t = f - i; return tab[i] + (tab[i + 1] - tab[i]) * t; };
  const xs = [], tabs = [], Us = [];
  let U = 0; const prev = new THREE.Vector3(), cur = new THREE.Vector3();
  for (let x = x0; x <= x1 + 1e-6; x += 1) {
    cur.set(x, body.mid(x), body.width(x));
    if (xs.length) U += cur.distanceTo(prev);
    prev.copy(cur); xs.push(x); tabs.push(ring(x)); Us.push(U);
  }
  const n = xs.length;
  const at = x => { const f = clamp(x - x0, 0, n - 1.0001); const i = Math.floor(f); return [i, f - i]; };
  const Ux = x => { const [i, t] = at(x); return Us[i] + (Us[i + 1] - Us[i]) * t; };
  const sX = (x, ph) => { const [i, t] = at(x); return lerp(sOf(tabs[i], ph), sOf(tabs[i + 1], ph), t); };
  const xU = u => {
    if (u <= Us[0]) return xs[0]; if (u >= Us[n - 1]) return xs[n - 1];
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (Us[m] <= u) lo = m; else hi = m; }
    return xs[lo] + (u - Us[lo]) / (Us[hi] - Us[lo]);
  };
  let smax = 0; for (const t of tabs) smax = Math.max(smax, t[M], -t[0]);
  const st = x => sX(x, Math.PI / 2), sb = x => -sX(x, -Math.PI / 2);
  // s → 侧角（二分，s 关于 ph 单调）
  const phOfS = (x, s) => { let lo = -Math.PI / 2, hi = Math.PI / 2; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (sX(x, m) < s) lo = m; else hi = m; } return (lo + hi) / 2; };
  return { Ux, sX, xU, st, sb, phOfS, stU: u => st(xU(u)), sbU: u => sb(xU(u)), Ucap: Us[n - 1] + body.width(x1) + 0.5, smax, P: (x, ph) => [Ux(x), sX(x, ph)], ring, sOf };
}
