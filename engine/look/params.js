// 北冥引擎 · 后期参数小工具：颜色换算、标量/三通道、每帧参数与默认值的合并。
//
//   toColor(v, out?)   '#hex' / 0xhex / THREE.Color / [r,g,b]（sRGB 0..1）→ THREE.Color；空值 = 白
//   linVec(v, out?)    → 线性 RGB 的 Vector3
//   srgbVec(v, out?)   → sRGB 分量的 Vector3
//   vec3Of(v, out?)    数或 [r,g,b] → Vector3
//   mergeParam(v, def) false/null = 关（null）；undefined/true = 默认的拷贝；数 = 原样；对象 = 覆盖默认里的同名字段

import * as THREE from 'three';

const _c = new THREE.Color();

export function toColor(v, out = new THREE.Color()) {
  if (v === undefined || v === null) return out.setRGB(1, 1, 1);
  if (v.isColor) return out.copy(v);
  if (Array.isArray(v)) return out.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
  return out.set(v);
}
export function linVec(v, out = new THREE.Vector3()) { toColor(v, _c); return out.set(_c.r, _c.g, _c.b); }
export function srgbVec(v, out = new THREE.Vector3()) { toColor(v, _c); const o = {}; _c.getRGB(o, THREE.SRGBColorSpace); return out.set(o.r, o.g, o.b); }
export function vec3Of(v, out = new THREE.Vector3()) { return Array.isArray(v) ? out.set(v[0], v[1], v[2]) : out.setScalar(v); }

export function mergeParam(v, def) {
  if (v === false || v === null) return null;
  if (v === undefined || v === true) return def ? { ...def } : null;
  if (typeof v === 'number') return v;
  return { ...(def || {}), ...v };
}
