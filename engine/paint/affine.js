// 北冥引擎 · 2D 仿射矩阵：[a, b, c, d, e, f]，与 Canvas 2D 的 setTransform 同序。
//   mul(m, n)              m·n（先作用 n，再作用 m）
//   translate(x, y) / scale(k) / rotate(弧度)
//   chain(m1, m2, ...)     依次相乘：chain(A, B, C) = A·B·C
//   zoomAt(x, y, k)        以 (x, y) 为中心缩放 k 倍（推镜）
//   apply(m, [x, y])       → [x', y']

export const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = k => [k, 0, 0, k, 0, 0];
export const rotate = a => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
export const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const chain = (...ms) => ms.reduce((a, b) => mul(a, b));
export const zoomAt = (x, y, k) => chain(translate(x, y), scale(k), translate(-x, -y));
