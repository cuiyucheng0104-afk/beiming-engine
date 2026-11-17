// 北冥引擎 · 离屏出片 · 颜色参数换算（engine/look/params.js 的 r187 版：那份顶层 import 了仓库的 three r170，这里用宿主注入的 THREE）。
//   linVec(THREE, v, out?) → 线性 RGB 的 Vector3    srgbVec(THREE, v, out?) → sRGB 分量的 Vector3    vec3Of(THREE, v, out?) → 数或 [r,g,b] 的 Vector3
// v：'#hex' / 0xhex / THREE.Color / [r,g,b]（sRGB 0..1），空值 = 白。
export function toColor(THREE, v, out = new THREE.Color()) {
  if (v === undefined || v === null) return out.setRGB(1, 1, 1);
  if (v.isColor) return out.copy(v);
  if (Array.isArray(v)) return out.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
  return out.set(v);
}
export function linVec(THREE, v, out = new THREE.Vector3()) { const c = toColor(THREE, v); return out.set(c.r, c.g, c.b); }
export function srgbVec(THREE, v, out = new THREE.Vector3()) { const o = {}; toColor(THREE, v).getRGB(o, THREE.SRGBColorSpace); return out.set(o.r, o.g, o.b); }
export function vec3Of(THREE, v, out = new THREE.Vector3()) { return Array.isArray(v) ? out.set(v[0], v[1], v[2]) : out.setScalar(v); }
