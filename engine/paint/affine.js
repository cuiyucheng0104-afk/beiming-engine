// 北冥引擎 · 2D 仿射矩阵：[a, b, c, d, e, f]，与 Canvas 2D 的 setTransform 同序。
//   mul(m, n)              m·n（先作用 n，再作用 m）
//   translate(x, y) / scale(k) / rotate(弧度)
//   chain(m1, m2, ...)     依次相乘：chain(A, B, C) = A·B·C
//   zoomAt(x, y, k)        以 (x, y) 为中心缩放 k 倍（推镜）
//   apply(m, [x, y])       → [x', y']
//   asMatrix(m)            → [a, b, c, d, e, f]：数组（含类型化数组）原样返回；DOMMatrix（ctx.getTransform() 的结果）
//                            或 { a, b, c, d, e, f } 取出六个数；别的类型直接报错。mul / apply 的参数两种都收。

export function asMatrix(m) {
  if (m && m.length >= 6) return m;
  if (m && typeof m.a === 'number' && typeof m.f === 'number') return [m.a, m.b, m.c, m.d, m.e, m.f];
  throw new TypeError(`矩阵要么是 [a, b, c, d, e, f] 数组，要么是 DOMMatrix：${m}`);
}
const M6 = m => (m.length >= 6 ? m : asMatrix(m));

export const mul = (m, n) => { m = M6(m); n = M6(n); return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; };
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = k => [k, 0, 0, k, 0, 0];
export const rotate = a => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
export const apply = (m, p) => { m = M6(m); return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; };
export const chain = (...ms) => ms.reduce((a, b) => mul(a, b));
export const zoomAt = (x, y, k) => chain(translate(x, y), scale(k), translate(-x, -y));
