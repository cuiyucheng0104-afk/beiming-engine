// 程序化模型：橡子（种子）与 120 岁的橡树（单位：米，y 向上）。确定性（mulberry 种子）。
// 树按 TREE 中的数值归一：树高 18.6 m、冠幅 14.0 m、根深 4.2 m；胸高 1.3 m 处的树干截面拆成年轮层。
import { prepModel } from './engine/holo.js';

export const TREE = { height: 18.6, crown: 14.0, rootDepth: 4.2, R: 0.52, sliceY0: 1.1, sliceY1: 1.5, step: 0.16 };
// 年轮层：每层代表到第 n 圈为止的木材（从髓心往外），第 6 层 = 第 87 圈（锁定目标）
export const RINGS = [12, 26, 41, 57, 72, 87, 103, 120];
export const LOCK_SHELL = 5;
export const ringLift = i => TREE.step * (RINGS.length - i);   // 第 i 层年轮的爆炸抬升量（米）
export const ringR = n => TREE.R * (1 - Math.exp(-n / 70)) / (1 - Math.exp(-120 / 70));

function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const TAU = Math.PI * 2;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

class Builder {
  constructor() { this.v = []; this.e = []; this.q = []; }
  pt(p) { this.v.push(p[0], p[1], p[2]); return this.v.length / 3 - 1; }
  edge(a, b) { this.e.push(a, b); }
  // 管：沿路径的环 + 纵线（平行移动标架），返回首环中心
  tube(path, radii, segs, o = {}) {
    const n = path.length, rings = [];
    let T = nrm(sub(path[1], path[0]));
    let N = Math.abs(T[1]) < 0.9 ? nrm(cross(T, [0, 1, 0])) : nrm(cross(T, [1, 0, 0]));
    for (let i = 0; i < n; i++) {
      const Ti = nrm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]));
      N = nrm(sub(N, mul(Ti, dot(N, Ti)))); T = Ti;
      const B = cross(T, N), ring = [];
      for (let s = 0; s < segs; s++) {
        const th = s / segs * TAU + (o.twist || 0) * i;
        ring.push(this.pt(add(path[i], add(mul(N, Math.cos(th) * radii[i]), mul(B, Math.sin(th) * radii[i])))));
      }
      rings.push(ring);
    }
    const every = o.longEvery || 1;
    for (let i = 0; i < n; i++) {
      if (!o.skipRing || i % o.skipRing === 0 || i === n - 1) for (let s = 0; s < segs; s++) this.edge(rings[i][s], rings[i][(s + 1) % segs]);
      if (i < n - 1) for (let s = 0; s < segs; s++) {
        if (s % every === 0) this.edge(rings[i][s], rings[i + 1][s]);
        this.q.push(rings[i][s], rings[i][(s + 1) % segs], rings[i + 1][(s + 1) % segs], rings[i + 1][s]);
      }
    }
    if (o.capTip) { const c = this.pt(path[n - 1]); for (let s = 0; s < segs; s += 2) this.edge(rings[n - 1][s], c); }
    return rings;
  }
  poly(pts) { let p = this.pt(pts[0]); for (let i = 1; i < pts.length; i++) { const q = this.pt(pts[i]); this.edge(p, q); p = q; } }
  circle(c, r, y, segs) {
    const ids = []; for (let s = 0; s < segs; s++) { const th = s / segs * TAU; ids.push(this.pt([c[0] + Math.cos(th) * r, y, c[2] + Math.sin(th) * r])); }
    for (let s = 0; s < segs; s++) this.edge(ids[s], ids[(s + 1) % segs]);
    return ids;
  }
  piece(id, o = {}) { return { id, v: this.v, e: this.e, q: this.q, ...o }; }
}

const bez = (p0, p1, p2, u) => add(add(mul(p0, (1 - u) * (1 - u)), mul(p1, 2 * u * (1 - u))), mul(p2, u * u));
const curve = (p0, p1, p2, n) => Array.from({ length: n }, (_, i) => bez(p0, p1, p2, i / (n - 1)));

export function buildTree() {
  const rnd = mulberry(5207);
  const { R, sliceY0, sliceY1, step } = TREE;
  const trunkR = y => R * (1 - 0.052 * Math.max(0, y - 1.3)) + 0.34 * Math.exp(-y / 0.32);
  const trunkX = y => y < 2 ? [0, y, 0] : [0.18 * Math.sin((y - 2) * 0.33), y, 0.1 * Math.sin((y - 2) * 0.21)];
  const parts = [];

  // —— 根系 ——
  {
    const b = new Builder();
    const tap = []; for (let i = 0; i <= 6; i++) { const u = i / 6; tap.push([0.06 * Math.sin(u * 5), -u * 4.2, 0.05 * Math.cos(u * 4)]); }
    b.tube(tap, tap.map((_, i) => 0.3 * (1 - i / 6) + 0.025), 8, { longEvery: 2 });
    for (let k = 0; k < 7; k++) {
      const a = k * 2.39996 + 0.4, L = 3.2 + rnd() * 2.6, d = 0.6 + rnd() * 1.4;
      const dir = [Math.cos(a), 0, Math.sin(a)];
      const p0 = [dir[0] * 0.25, -0.15, dir[2] * 0.25];
      const p2 = add(mul(dir, L), [0, -d, 0]);
      const p1 = add(mul(dir, L * 0.45), [0, -d * 0.25, 0]);
      const path = curve(p0, p1, p2, 6);
      b.tube(path, path.map((_, i) => 0.17 * (1 - i / 6) + 0.02), 6, { longEvery: 2 });
      for (let j = 0; j < 3; j++) {
        const u = 0.35 + j * 0.22, s = bez(p0, p1, p2, u), side = (j % 2 ? 1 : -1) * (0.7 + rnd() * 0.5);
        const sd = nrm([Math.cos(a + side), -0.35 - rnd() * 0.4, Math.sin(a + side)]), l2 = 1.0 + rnd() * 1.1;
        b.poly([s, add(s, mul(sd, l2 * 0.5)), add(add(s, mul(sd, l2)), [0, -0.25, 0])]);
      }
    }
    const pc = b.piece('roots');
    pc.g = []; for (let i = 1; i < pc.v.length; i += 3) pc.g.push(-pc.v[i] / 4.2);
    parts.push({ id: 'roots', anchor: [0, -2, 0], pieces: [pc] });
  }

  // —— 树干下段（含根颈喇叭） ——
  {
    const b = new Builder();
    const ys = [0, 0.08, 0.2, 0.38, 0.62, 0.86, sliceY0];
    const path = ys.map(trunkX);
    b.tube(path, ys.map(trunkR), 22, { longEvery: 1 });
    parts.push({ id: 'trunk', anchor: [0, 0.6, R], pieces: [b.piece('trunk')] });
  }

  // —— 胸高截面：年轮层 + 树皮 + 髓心 ——
  {
    const pieces = [];
    RINGS.forEach((n, i) => {
      const b = new Builder(), r = ringR(n), segs = Math.max(20, Math.round(10 + r * 70));
      const top = b.circle([0, 0, 0], r, sliceY1, segs), bot = b.circle([0, 0, 0], r, sliceY0, segs);
      const vk = 8 + (i % 2) * 4;
      for (let s = 0; s < segs; s += Math.round(segs / vk)) { b.edge(top[s], bot[s]); }
      for (let s = 0; s < segs; s++) b.q.push(top[s], top[(s + 1) % segs], bot[(s + 1) % segs], bot[s]);
      // 每层上表面的细年轮（3 条，表示这一层所含的多圈）
      const n0 = i ? RINGS[i - 1] : 0;
      for (let k = 1; k <= 2; k++) { const rr = ringR(n0 + (n - n0) * k / 3); b.circle([0, 0, 0], rr, sliceY1, Math.max(16, segs - 6)); }
      // 局部爆炸：沿树干轴 +Y 等距抬起、保持原半径；外层抬得少、内层抬得多 → 阶梯塔（每层上表面的年轮都露出来）
      // 爆炸时每层压扁成 0.08 m 的薄片（以上表面为基准），层间留 0.08 m 的缝 → 一层层浮起的年轮片，读得清
      pieces.push(b.piece('ring' + i, { explode: [0, step * (RINGS.length - i), 0], ring: n, squash: [sliceY1, 0.8] }));
    });
    { // 树皮：外壳 + 纵向裂纹
      const b = new Builder(), r = R * 1.05, segs = 44;
      const top = b.circle([0, 0, 0], r, sliceY1, segs), mid = b.circle([0, 0, 0], r, (sliceY0 + sliceY1) / 2, segs), bot = b.circle([0, 0, 0], r, sliceY0, segs);
      for (let s = 0; s < segs; s += 2) { b.edge(top[s], mid[(s + 1) % segs]); b.edge(mid[(s + 1) % segs], bot[s]); }
      for (let s = 0; s < segs; s++) { b.q.push(top[s], top[(s + 1) % segs], mid[(s + 1) % segs], mid[s]); b.q.push(mid[s], mid[(s + 1) % segs], bot[(s + 1) % segs], bot[s]); }
      pieces.push(b.piece('bark', { explode: [0, 0, 0] }));   // 树皮作为底座外套留在原位
    }
    { // 髓心：留在原位、发热
      const b = new Builder(), r = 0.035;
      const top = b.circle([0, 0, 0], r, sliceY1, 10), bot = b.circle([0, 0, 0], r, sliceY0, 10);
      for (let s = 0; s < 10; s += 2) b.edge(top[s], bot[s]);
      // 木射线：上表面从髓心向外的放射短线
      for (let s = 0; s < 16; s++) { const th = s / 16 * TAU; b.poly([[Math.cos(th) * r, sliceY1, Math.sin(th) * r], [Math.cos(th) * ringR(12) * 0.95, sliceY1, Math.sin(th) * ringR(12) * 0.95]]); }
      pieces.push(b.piece('pith', { hot: true, box: false }));
    }
    parts.push({ id: 'slice', anchor: [0, sliceY1, ringR(87)], pieces });
  }

  // —— 树冠：上段树干 + 主枝 + 次枝 + 细枝 ——
  const crownPieces = [], leafB = new Builder(), tips = [];
  const up = step * (RINGS.length + 2);
  {
    const b = new Builder();
    const ys = []; for (let y = sliceY1; y <= 9.01; y += 0.5) ys.push(y);
    const path = ys.map(trunkX);
    b.tube(path, ys.map(trunkR), 16, { longEvery: 1 });
    crownPieces.push(b.piece('trunkUp', { explode: [0, up, 0] }));
  }
  {
    const b = new Builder(), sb = new Builder();
    const mains = [];
    for (let i = 0; i < 8; i++) {
      const leader = i === 7;
      const hb = leader ? 9 : 4.3 + i * 0.68, a = i * 2.39996 + 0.9;
      const e = leader ? 1.35 : 0.5 + rnd() * 0.3 + i * 0.05, L = leader ? 6.2 : 7.6 - i * 0.32;
      const dir = [Math.cos(a), 0, Math.sin(a)];
      const p0 = trunkX(hb);
      const p1 = add(p0, add(mul(dir, Math.cos(e) * L * 0.5), [0, Math.sin(e) * L * 0.5, 0]));
      const p2 = add(p0, add(mul(dir, Math.cos(e) * L * 0.92), [0, Math.sin(e) * L + L * 0.28, 0]));
      const path = curve(p0, p1, p2, 7), r0 = leader ? 0.28 : 0.27 - i * 0.014;
      b.tube(path, path.map((_, k) => r0 * (1 - k / 7 * 0.8)), 8, { longEvery: 1, capTip: true });
      mains.push({ p0, p1, p2, a });
    }
    for (const m of mains) for (let j = 0; j < 5; j++) {
      const u = 0.32 + j * 0.15 + rnd() * 0.05, s = bez(m.p0, m.p1, m.p2, u);
      const tg = nrm(sub(bez(m.p0, m.p1, m.p2, u + 0.02), s));
      const side = (j % 2 ? 1 : -1) * (0.55 + rnd() * 0.4), aa = m.a + side;
      const d = nrm(add(mul(tg, 0.4), [Math.cos(aa) * 0.8, 0.55 + rnd() * 0.3, Math.sin(aa) * 0.8]));
      const L = 2.4 + rnd() * 1.3;
      const q2 = add(s, mul(d, L)), q1 = add(s, add(mul(d, L * 0.5), [0, -0.15, 0]));
      const path = curve(s, q1, q2, 4);
      sb.tube(path, path.map((_, k) => 0.075 * (1 - k / 4 * 0.7)), 5, { longEvery: 1 });
      for (let k = 0; k < 3; k++) {
        const w = 0.55 + k * 0.2, t0 = bez(s, q1, q2, w);
        const ta = aa + (k - 1) * 0.9 + rnd() * 0.3;
        const td = nrm([Math.cos(ta), 0.7 + rnd() * 0.5, Math.sin(ta)]), tl = 1.0 + rnd() * 0.7;
        const t1 = add(t0, mul(td, tl * 0.55)), t2 = add(add(t0, mul(td, tl)), [0, 0.15, 0]);
        sb.poly([t0, t1, t2]);
        tips.push(t2);
        // 叶簇：5 片菱形叶围绕枝端
        for (let l = 0; l < 6; l++) {
          const la = ta + l * 1.047 + rnd() * 0.4, ld = nrm([Math.cos(la), 0.15 + rnd() * 0.6, Math.sin(la)]), ls = 0.5 + rnd() * 0.25;
          const base = add(t2, mul(ld, 0.04)), tip = add(base, mul(ld, ls));
          const side2 = mul(nrm(cross(ld, [0, 1, 0.2])), ls * 0.28), mid = add(base, mul(ld, ls * 0.45));
          const A = leafB.pt(base), Bq = leafB.pt(add(mid, side2)), Cq = leafB.pt(tip), D = leafB.pt(sub(mid, side2));
          leafB.edge(A, Bq); leafB.edge(Bq, Cq); leafB.edge(Cq, D); leafB.edge(D, A); leafB.edge(A, Cq);
          leafB.q.push(A, Bq, Cq, D);
        }
      }
    }
    crownPieces.push(b.piece('mains', { explode: [0, up, 0] }));
    crownPieces.push(sb.piece('subs', { explode: [0, up, 0] }));
  }
  const leaves = leafB.piece('leaves', { explode: [0, up, 0] });

  // —— 归一：树高 18.6 m、冠幅 14.0 m（只对枝叶做，树干保持真实半径） ——
  let ymax = -1e9, rmax = 0;
  for (const pc of [...crownPieces, leaves]) for (let i = 0; i < pc.v.length; i += 3) { ymax = Math.max(ymax, pc.v[i + 1]); rmax = Math.max(rmax, Math.hypot(pc.v[i], pc.v[i + 2])); }
  const ky = (TREE.height - sliceY1) / (ymax - sliceY1), kr = (TREE.crown / 2) / rmax;
  const norm = (arr, xz) => { for (let i = 0; i < arr.length; i += 3) { if (xz) { arr[i] *= kr; arr[i + 2] *= kr; } arr[i + 1] = sliceY1 + (arr[i + 1] - sliceY1) * ky; } };
  for (const pc of crownPieces) norm(pc.v, pc.id !== 'trunkUp');
  norm(leaves.v, true);
  for (const t of tips) { t[0] *= kr; t[2] *= kr; t[1] = sliceY1 + (t[1] - sliceY1) * ky; }
  // 生长键：高度 / 树高（扫描平面向上）
  const keyUp = pc => { pc.g = []; for (let i = 1; i < pc.v.length; i += 3) pc.g.push(pc.v[i] / TREE.height); };
  for (const P of parts) for (const pc of P.pieces) if (!pc.g) keyUp(pc);
  for (const pc of crownPieces) keyUp(pc);
  keyUp(leaves);
  parts.push({ id: 'crown', anchor: [0, 9, 0], pieces: crownPieces });
  parts.push({ id: 'leaves', anchor: [0, 15, 0], pieces: [leaves] });
  const m = prepModel({ name: 'oak', parts });
  // 树冠里的一颗新橡子（结尾呼应）：取最靠近相机一侧、偏上的枝端
  let best = tips[0], bs = -1e9;
  for (const t of tips) { const s = t[1] * 0.6 + t[2] * 1.0 + t[0] * 0.4; if (s > bs) { bs = s; best = t; } }
  m.echo = best; m.tips = tips;
  return m;
}

// 橡子：车削体（坚果）+ 壳斗（菱形鳞片网格）+ 果柄。总高 0.026 m。生长键：自上而下（扫描线下行）
export function buildSeed() {
  const H = 0.026, b = new Builder(), segs = 20;
  const prof = [];
  for (let i = 0; i <= 12; i++) {
    const u = i / 12, y = u * 0.0205;
    const w = Math.min(1, u / 0.72), r = 0.0086 * Math.sqrt(Math.max(0, 1 - Math.pow(1 - w, 2))) * (0.25 + 0.75 * Math.pow(w, 0.35)) * (u > 0.72 ? 1 - (u - 0.72) * 0.3 : 1);
    prof.push([y, Math.max(r, 0.0004)]);
  }
  const rings = prof.map(([y, r]) => { const ids = []; for (let s = 0; s < segs; s++) { const th = s / segs * TAU; ids.push(b.pt([Math.cos(th) * r, y, Math.sin(th) * r])); } return ids; });
  rings.forEach((ring, i) => { if (i > 0) for (let s = 0; s < segs; s++) b.edge(ring[s], ring[(s + 1) % segs]); });
  for (let i = 0; i < rings.length - 1; i++) for (let s = 0; s < segs; s++) { if (s % 2 === 0) b.edge(rings[i][s], rings[i + 1][s]); b.q.push(rings[i][s], rings[i][(s + 1) % segs], rings[i + 1][(s + 1) % segs], rings[i + 1][s]); }
  // 壳斗：碗形，鳞片 = 两组螺旋线
  const cup = []; const cr = 5;
  for (let i = 0; i <= cr; i++) { const u = i / cr, y = 0.0168 + u * 0.0072, r = 0.0089 * Math.cos(u * 1.3) + 0.0005; cup.push([y, r]); }
  const cupR = cup.map(([y, r]) => { const ids = []; for (let s = 0; s < 24; s++) { const th = s / 24 * TAU; ids.push(b.pt([Math.cos(th) * r, y, Math.sin(th) * r])); } return ids; });
  cupR.forEach(ring => { for (let s = 0; s < 24; s++) b.edge(ring[s], ring[(s + 1) % 24]); });
  for (let i = 0; i < cr; i++) for (let s = 0; s < 24; s++) { b.edge(cupR[i][s], cupR[i + 1][(s + 1) % 24]); b.edge(cupR[i][(s + 1) % 24], cupR[i + 1][s]); b.q.push(cupR[i][s], cupR[i][(s + 1) % 24], cupR[i + 1][(s + 1) % 24], cupR[i + 1][s]); }
  // 果柄
  const st = [[0, 0.024, 0], [0.0004, 0.0262, 0.0002]];
  b.tube(st, [0.0011, 0.0008], 6);
  const pc = b.piece('seed');
  pc.g = []; for (let i = 1; i < pc.v.length; i += 3) pc.g.push((H - pc.v[i]) / H);
  return prepModel({ name: 'acorn', parts: [{ id: 'seed', anchor: [0, 0.012, 0.0083], pieces: [pc] }] });
}
