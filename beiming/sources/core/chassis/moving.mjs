// 北冥 · scenepack.mjs 的 movingPack（会动的板加不动的墙）在 JS 里的双精度几何，给 motion、读回、逐帧推进三份测试照场景规格
// 自己求交、自己投影。相机的基照内核（path/src/scene.rs 的 camera_data：前 = M(0,0,-1)，上 = M(0,1,0)，右 = 前 × 上，
// 再上 = 右 × 前），像素中心的射线照内核辅助样本那一条（shaders/integrator.wgsl 的 aux_sample）。矩阵都是列主序 16 个数。
import { IDENTITY, MOVING } from './scenepack.mjs';

/** 包里存的是 32 位浮点：解析值用同样的数 */
export const f32s = m => m.map(Math.fround);
/** a × b */
export const mul = (a, b) => Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].reduce((s, k) => s + a[k * 4 + (i % 4)] * b[Math.floor(i / 4) * 4 + k], 0));
export const rotateY = a => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
export const rotateX = a => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
export const point = (m, p) => [0, 1, 2].map(c => m[c] * p[0] + m[4 + c] * p[1] + m[8 + c] * p[2] + m[12 + c]);
const vector = (m, v) => [0, 1, 2].map(c => m[c] * v[0] + m[4 + c] * v[1] + m[8 + c] * v[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = v => { const l = Math.hypot(...v); return v.map(x => x / l); };

/** 仿射矩阵的逆（左上 3×3 求逆，平移跟着变） */
export function inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const r = [e * i - f * h, -(b * i - c * h), b * f - c * e, -(d * i - f * g), a * i - c * g, -(a * f - c * d), d * h - e * g, -(a * h - b * g), a * e - b * d].map(x => x / det);
  const inv = [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1];
  const t = point(inv, m.slice(12, 15));
  return [...inv.slice(0, 12), -t[0], -t[1], -t[2], 1];
}

/** 相机矩阵 m 在 w×h 画面上的相机（fovY 取 MOVING.fovY 存成 32 位之后的值） */
export function camera(m, w, h) {
  const fwd = unit(vector(m, [0, 0, -1]));
  const right = unit(cross(fwd, unit(vector(m, [0, 1, 0]))));
  return { pos: m.slice(12, 15), fwd, right, up: cross(right, fwd), tan: Math.tan(Math.fround(MOVING.fovY) / 2), w, h };
}

/** 世界坐标的点投到画面上（像素，原点左上、y 向下） */
export function screen(c, x) {
  const d = [0, 1, 2].map(k => x[k] - c.pos[k]), z = dot(d, c.fwd);
  return [(dot(d, c.right) / (z * c.tan * (c.w / c.h)) + 1) * 0.5 * c.w, (1 - dot(d, c.up) / (z * c.tan)) * 0.5 * c.h];
}

/** spec（movingPack 的 board、camera）第 k 帧的两个物体：[{ id, half, z, m }]，网格在自己坐标里 z 平面上、半边长 half */
export const objects = (spec, k) => [
  { id: 1, half: MOVING.board, z: 0, m: f32s(spec.board(k)) },
  { id: 2, half: MOVING.wall, z: Math.fround(MOVING.wallAt), m: IDENTITY },
];

/**
 * 像素 (i, j) 中心那条射线：打到哪个物体（最近的）、命中点在网格自己坐标里的位置；离哪个物体的边不到 margin 米的像素
 * 两边都可能，返回 null。什么都没打到也返回 null（movingPack 的墙铺满画面，不会出现）。
 */
export function hit(c, objs, i, j, margin) {
  const ndc = [(i + 0.5) / c.w * 2 - 1, 1 - (j + 0.5) / c.h * 2];
  const d = [0, 1, 2].map(k => c.fwd[k] + c.right[k] * ndc[0] * c.tan * (c.w / c.h) + c.up[k] * ndc[1] * c.tan);
  let best = null;
  for (const o of objs) {
    const inv = inverse(o.m);
    const [ol, dl] = [point(inv, c.pos), vector(inv, d)];
    const t = (o.z - ol[2]) / dl[2];
    if (!(t > 0)) continue;
    const p = [ol[0] + t * dl[0], ol[1] + t * dl[1], o.z];
    const edge = o.half - Math.max(Math.abs(p[0]), Math.abs(p[1]));
    if (Math.abs(edge) < margin) return null;
    if (edge > 0 && (!best || t < best.t)) best = { t, id: o.id, local: p };
  }
  return best;
}
