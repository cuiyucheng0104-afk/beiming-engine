// 《豹变》A 水墨 · 公共件：设计尺寸与 K 缩放、色板、缓动、整数哈希、按屏幕摆放的工具、全片共享的 uniform
// 约定：
//   · 设计画面 1920×1040，所有屏幕量写成"设计像素"，真正画到屏幕时乘 K = H/1040（门禁 G5）
//   · 色板一律 sRGB 0..1，全片在"显示空间"里合成（关掉 three 的色彩管理），墨的叠加与 Canvas 2D 同一口径
//   · 这里没有任何随机数与时钟读取；随机一律用整数哈希或带种子的 mulberry
import * as THREE from 'three';

export const DW = 1920, DH = 1040;
export const W = innerWidth, H = innerHeight, K = H / DH;
export const DEG = Math.PI / 180;

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const ss = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export const ss5 = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
export const ei = x => Math.pow(clamp(x), 3);
export const eo = x => 1 - Math.pow(1 - clamp(x), 3);
export const eio = x => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(2 - 2 * x, 3) / 2; };
export const ei2 = x => Math.pow(clamp(x), 2);
export const eo2 = x => 1 - Math.pow(1 - clamp(x), 2);

// 整数哈希 → [0,1)
export const hashi = n => { let h = (n | 0) * 374761393 + 668265263; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
export const hash2 = (a, b) => hashi(Math.imul(a | 0, 7919) + Math.imul(b | 0, 104729) + 13);
export const hash3 = (a, b, c) => hashi(Math.imul(a | 0, 7919) + Math.imul(b | 0, 104729) + Math.imul(c | 0, 31337) + 101);

// 带种子的伪随机（Mulberry32）
export function mulberry(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 一维值噪声（确定性，相位按种子）
export function vnoise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash2(i, seed), hash2(i + 1, seed), u) * 2 - 1;
}

// 关键帧折线 / 单调样条（Fritsch–Carlson）：keys = [[t, v], ...]
export function monotone(keys) {
  const n = keys.length, X = keys.map(k => k[0]), Y = keys.map(k => k[1]);
  if (n === 1) return () => Y[0];
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((Y[i + 1] - Y[i]) / (X[i + 1] - X[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], r = a * a + b * b;
    if (r > 9) { const k = 3 / Math.sqrt(r); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return t => {
    if (t <= X[0]) return Y[0];
    if (t >= X[n - 1]) return Y[n - 1];
    let i = 0; while (t > X[i + 1]) i++;
    const h = X[i + 1] - X[i], u = (t - X[i]) / h, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * Y[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * Y[i + 1] + (u3 - u2) * h * m[i + 1];
  };
}
// 多段缓动：keys = [[f, v, ease], ...]，从上一个键到这一个键用 ease
export function keyed(keys) {
  return f => {
    if (f <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (f <= keys[i][0]) {
        const [f0, v0] = keys[i - 1], [f1, v1, e] = keys[i];
        const u = (e || ss)((f - f0) / (f1 - f0));
        return Array.isArray(v0) ? v0.map((a, j) => lerp(a, v1[j], u)) : lerp(v0, v1, u);
      }
    }
    return keys[keys.length - 1][1];
  };
}

// ───────── 颜色 ─────────
export function hex3(h) { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
export const hexv = h => new THREE.Vector3(...hex3(h));
export const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const css = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

// 墨六阶：纸 清 淡 重 浓 焦（DESIGN 第二节）
export const PAL = {
  real: ['#E3D9C4', '#C9BDA5', '#A0927C', '#6D604F', '#3E352C', '#1F1A15'].map(hex3),
  cliff: ['#D3DCE0', '#B5C3C9', '#929FA3', '#5E6C70', '#2F3B3E', '#0E131A'].map(hex3),   // 返修：纸、清两阶向山水情的青灰偏 3–4%（墨阶不变）
  market: ['#D8D6CD', '#BDBAB0', '#9C988D', '#6B665C', '#3A372F', '#1C1A16'].map(hex3),
  s4: ['#E2E0D4', '#BCC4C2', '#929FA3', '#5B686C', '#2E383D', '#12161B'].map(hex3),
  scroll: ['#DFE3DC', '#BAC6C6', '#8F9C9E', '#4A5C63', '#2B363D', '#10151B'].map(hex3),
};
export const COL = Object.fromEntries(Object.entries({
  ochreL: '#CDAE84', ochreM: '#A9875C', ochreD: '#7B5C3D', skin: '#D9B78F', gambogeLight: '#E9D6A2', lensLight: '#F3EDE0',
  page: '#E8DFCB', patch: '#F1EADA', patchInk: '#15120F',
  indigoL: '#A7B6BD', indigoM: '#6E838C', furOchreGrey: '#A39886', wetSpot: '#4C565C', sunPale: '#E8DAB2', amber: '#D9973E',
  gold: '#C29A4B', goldL: '#E0C27E', goldD: '#87672C', goldLeaf: '#F0DA98', cinnabar: '#8A3F30', cinnabarL: '#B8735D',
  spotCore: '#B49A6F', furOchre: '#C8AC82', inkDrop: '#101318', hiWhite: '#E8E9E3', dawn: '#E9DDB4', amberB: '#F2C266',
  sIndigoL: '#A8B9BE', sIndigoM: '#7A919A', sOchreL: '#C8AC82', sOchreM: '#9F8259', zenith: '#C3CDD0',
}).map(([k, v]) => [k, hex3(v)]));
export const mixPal = (a, b, t) => a.map((c, i) => mix3(c, b[i], t));

// ───────── 全片共享 uniform（所有自写材质引用同一批对象，改一处全场生效） ─────────
export const U = {
  uPal: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector3()) },
  uFogA: { value: new THREE.Vector4(0, 0, 0, 0) },   // 密度、起始距离、最大浓度、开关
  uFogB: { value: new THREE.Vector4(0, 0, 0, 0) },   // 基准高度、高度衰减、—、—
  uK: { value: K },
  uT: { value: 0 },
  uF: { value: 0 },
};
let curPal = PAL.real;
export function setPal(p) { curPal = p; p.forEach((c, i) => U.uPal.value[i].set(c[0], c[1], c[2])); }
export const pal = () => curPal;
export function setFog(o) {
  if (!o) { U.uFogA.value.set(0, 0, 0, 0); return; }
  U.uFogA.value.set(o.density ?? 0.01, o.start ?? 0, o.max ?? 1, 1);
  U.uFogB.value.set(o.base ?? 0, o.falloff ?? 0, 0, 0);
}

// ───────── 按"参考机位下的屏幕位置 + 深度"摆放（设计像素） ─────────
export function placeOnScreen(mesh, cam, cx, cy, wpx, D, hpx) {
  const hh = D * Math.tan(cam.fov * DEG / 2), hw = hh * cam.aspect;
  const x = (cx / DW - 0.5) * 2 * hw, y = (0.5 - cy / DH) * 2 * hh;
  const w = wpx / DW * 2 * hw, h = hpx !== undefined ? hpx / DH * 2 * hh : w / (mesh.userData.aspect || 1);
  mesh.position.set(x, y, -D).applyMatrix4(cam.matrixWorld);
  cam.getWorldQuaternion(mesh.quaternion);
  mesh.scale.set(w, h, 1);
  return mesh;
}
export function screenToWorld(cam, cx, cy, D, out = new THREE.Vector3()) {
  const hh = D * Math.tan(cam.fov * DEG / 2), hw = hh * cam.aspect;
  return out.set((cx / DW - 0.5) * 2 * hw, (0.5 - cy / DH) * 2 * hh, -D).applyMatrix4(cam.matrixWorld);
}
const _pv = new THREE.Vector3(), _pc = new THREE.Vector3();
export function project(cam, p) {
  _pc.copy(p).applyMatrix4(cam.matrixWorldInverse);
  _pv.copy(p).project(cam);
  return { x: (_pv.x * 0.5 + 0.5) * DW, y: (0.5 - _pv.y * 0.5) * DH, z: -_pc.z };
}
// 相机：先偏航后俯仰（YXZ）
export function aim(cam, pos, yaw, pitch, roll = 0) {
  cam.position.copy(pos); cam.rotation.order = 'YXZ'; cam.rotation.set(pitch, yaw, roll); cam.updateMatrixWorld(true);
}
export function lookAt(cam, pos, target, roll = 0) {
  cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(target);
  if (roll) cam.rotateZ(roll);
  cam.updateMatrixWorld(true);
}
// 设计像素焦距
export const fpx = fovDeg => (DH / 2) / Math.tan(fovDeg * DEG / 2);

// 按构图目标摆相机：让世界点 target 落在设计像素 (sx, sy)、沿视线深度 dist，朝向由 yaw / pitch / roll（YXZ）给定
const _fw = new THREE.Vector3(), _rt = new THREE.Vector3(), _up = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
export function frameAt(cam, target, sx, sy, dist, yaw, pitch, roll = 0) {
  _e.set(pitch, yaw, roll, 'YXZ'); _q.setFromEuler(_e);
  _fw.set(0, 0, -1).applyQuaternion(_q); _rt.set(1, 0, 0).applyQuaternion(_q); _up.set(0, 1, 0).applyQuaternion(_q);
  const f = fpx(cam.fov), dx = (sx - DW / 2) / f * dist, dy = (sy - DH / 2) / f * dist;
  cam.position.copy(target).addScaledVector(_fw, -dist).addScaledVector(_rt, -dx).addScaledVector(_up, dy);
  cam.quaternion.copy(_q); cam.rotation.setFromQuaternion(_q, 'YXZ');
  cam.updateMatrixWorld(true);
  return cam;
}
// 一维 fbm / 脊状 fbm（确定性，按种子），返回约 [-1,1] / [0,1]
export function fbm1(x, seed = 0, oct = 4) { let a = 0, m = 0.5, s = 0; for (let i = 0; i < oct; i++) { a += m * vnoise1(x, seed + i * 31); s += m; x = x * 2.03 + 17.1; m *= 0.5; } return a / s; }
export function ridged1(x, seed = 0, oct = 3) { let a = 0, m = 0.5, s = 0; for (let i = 0; i < oct; i++) { const n = 1 - Math.abs(vnoise1(x, seed + i * 57)); a += m * n * n; s += m; x = x * 2.1 + 5.3; m *= 0.5; } return a / s; }
// 二维值噪声与 fbm（JS 侧，给几何位移用；确定性）
export function vnoise2(x, y, seed = 0) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash3(i, j, seed), b = hash3(i + 1, j, seed), c = hash3(i, j + 1, seed), d = hash3(i + 1, j + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}
export function fbm2(x, y, seed = 0, oct = 4) { let a = 0, m = 0.5, s = 0; for (let i = 0; i < oct; i++) { a += m * vnoise2(x, y, seed + i * 101); s += m; x = x * 2.03 + 17.1; y = y * 2.03 + 9.3; m *= 0.5; } return a / s; }
export function vnoise3(x, y, z, seed = 0) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const h = (a, b, c) => hashi(Math.imul(a | 0, 7919) + Math.imul(b | 0, 104729) + Math.imul(c | 0, 31337) + Math.imul(seed | 0, 4271) + 101);
  const x00 = lerp(h(i, j, k), h(i + 1, j, k), u), x10 = lerp(h(i, j + 1, k), h(i + 1, j + 1, k), u);
  const x01 = lerp(h(i, j, k + 1), h(i + 1, j, k + 1), u), x11 = lerp(h(i, j + 1, k + 1), h(i + 1, j + 1, k + 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}
export function fbm3(x, y, z, seed = 0, oct = 4) { let a = 0, m = 0.5, s = 0; for (let i = 0; i < oct; i++) { a += m * vnoise3(x, y, z, seed + i * 101); s += m; x = x * 2.03 + 17.1; y = y * 2.03 + 9.3; z = z * 2.03 + 4.7; m *= 0.5; } return a / s; }
export function ridged3(x, y, z, seed = 0, oct = 3) { let a = 0, m = 0.5, s = 0; for (let i = 0; i < oct; i++) { const n = 1 - Math.abs(vnoise3(x, y, z, seed + i * 57)); a += m * n * n; s += m; x *= 2.1; y *= 2.1; z *= 2.1; m *= 0.5; } return a / s; }

// 读一张图的 alpha（加载时一次，算斑点区域等）
export function alphaOf(img) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const a = new Uint8Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return { w: c.width, h: c.height, a, at(x, y) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0; return this.a[y * this.w + x] / 255; } };
}
export function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
