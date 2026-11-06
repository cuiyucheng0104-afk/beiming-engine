// 《豹变》D 雾山 · 通用小工具（纯函数，无随机、无时钟）
import * as THREE from 'three';
export { monotone, mulberry } from '/engine/core/math.js';

export const DEG = Math.PI / 180;
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const ss = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export const ss5 = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
export const ei = x => Math.pow(clamp(x), 3);
export const eo = x => 1 - Math.pow(1 - clamp(x), 3);
export const eo4 = x => 1 - Math.pow(1 - clamp(x), 4);
export const eio = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export const eob = x => { x = clamp(x); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };   // ease-out-back
// 整数哈希 → [0,1)
export const hashi = n => { let h = (n | 0) * 374761393 + 668265263; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return (h >>> 0) / 4294967296; };
export const hash2 = (a, b) => hashi((a | 0) * 7919 + (b | 0) * 104729 + 17);
// 一维值噪声（平滑），x 任意实数
export const vn1 = (x, seed = 0) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash2(i, seed), hash2(i + 1, seed), u); };
// 关键帧表 → 分量各自单调插值：keys = [[f, [a,b,c...]], ...]
import { monotone as _mono } from '/engine/core/math.js';
export function track(keys) {
  const n = keys[0][1].length;
  const fs = [...Array(n)].map((_, i) => _mono(keys.map(k => [k[0], k[1][i]])));
  return x => fs.map(g => g(x));
}
// 颜色
export const col = hex => new THREE.Color(hex);
export const lin3 = hex => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };
export function mixHex(a, b, t) { return new THREE.Color(a).lerp(new THREE.Color(b), clamp(t)); }
// 设计坐标（1920×1040）→ 实际像素
export function dx(x, W, K) { return (x - 960) * K + W / 2; }
export function dy(y, K) { return y * K; }

// 相机：Euler YXZ
export function aim(cam, pos, yaw, pitch, roll = 0) {
  cam.position.set(pos[0], pos[1], pos[2]);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(pitch * DEG, yaw * DEG, roll * DEG);
  cam.updateMatrixWorld(true);
}
// 相机看向一点
export function lookAtYP(from, to) {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const yaw = Math.atan2(-d[0], -d[2]) / DEG, pitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) / DEG;
  return [yaw, pitch];
}
// 屏幕（设计像素）+ 深度 → 世界
const _v = new THREE.Vector3();
export function s2w(cam, x, y, D, out = new THREE.Vector3()) {
  const hh = D * Math.tan(cam.fov * DEG / 2), hw = hh * cam.aspect;
  const W = 1040 * cam.aspect;
  return out.set((x - 960) / (W / 2) * hw, (0.5 - y / 1040) * 2 * hh, -D).applyMatrix4(cam.matrixWorld);
}
// 世界 → 屏幕（设计像素，按 1040 高、居中宽）
export function w2s(cam, p) {
  _v.copy(p).applyMatrix4(cam.matrixWorldInverse);
  const z = -_v.z;
  _v.copy(p).project(cam);
  const W = 1040 * cam.aspect;
  return { x: 960 + _v.x * W / 2, y: (0.5 - _v.y * 0.5) * 1040, z };
}
// 射线（设计像素）与水平面 y=Y 的交点
const _r = new THREE.Raycaster(), _n = new THREE.Vector2();
export function hitPlaneY(cam, x, y, Y, out = new THREE.Vector3()) {
  const W = 1040 * cam.aspect;
  _n.set((x - 960) / (W / 2), 1 - y / 1040 * 2);
  _r.setFromCamera(_n, cam);
  const t = (Y - _r.ray.origin.y) / _r.ray.direction.y;
  return out.copy(_r.ray.origin).addScaledVector(_r.ray.direction, t);
}
// 设计像素下，深度 D 处 1 米对应多少像素
export const pxPerM = (cam, D) => 1040 / (2 * D * Math.tan(cam.fov * DEG / 2));
// vFOV（度）← 焦段（36 mm 宽画幅、1.846:1 → 画高 19.5 mm）
export const fovOf = mm => 2 * Math.atan(9.75 / mm) / DEG;
// sRGB 原值（look 输出之后的合成在 sRGB 空间里做，用这个）
export const srgb3 = hex => { const c = new THREE.Color(); c.setStyle(hex, THREE.LinearSRGBColorSpace); return new THREE.Vector3(c.r, c.g, c.b); };
