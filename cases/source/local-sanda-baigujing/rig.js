// 骨骼与合成工具：矩阵、两段 IK、关键帧姿势混合、离布（虚化 / 放大 / 淡出）图层、操纵杆
import { canvas, rivet } from '/styles/shadow-puppet/demo/carve.js';
import { clamp, lerp, eio } from '/core/lib.js';

export const W = 1920, H = 1080;
export const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
export const T = (x, y) => [1, 0, 0, 1, x, y];
export const R = a => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
export const S = (k, ky = k) => [k, 0, 0, ky, 0, 0];
export const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
export const set = (g, M) => g.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
export const camK = C => Math.hypot(C[0], C[1]);
export const camM = ([cx, cy, z], mir = 1) => [z * mir, 0, 0, z, 960 - cx * z * mir, 540 - cy * z];

// 两段 IK：肩 s（世界）→ 目标 p（世界），返回上臂 / 前臂的世界旋转（0 = 下垂，正 = 顺时针）
export function ik(s, p, L1, L2, bend = 1) {
  let dx = p[0] - s[0], dy = p[1] - s[1], d = Math.hypot(dx, dy);
  d = Math.max(Math.abs(L1 - L2) + 1, Math.min(L1 + L2 - .3, d));
  const phi = Math.atan2(dy, dx), al = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const a1 = phi + bend * al, e = [s[0] + Math.cos(a1) * L1, s[1] + Math.sin(a1) * L1];
  const a2 = Math.atan2(p[1] - e[1], p[0] - e[0]);
  return [a1 - Math.PI / 2, a2 - Math.PI / 2];
}

// —— 姿势混合：数字线性、数组逐项、其余在中点切换 ——
export function blend(A, B, u) {
  if (u <= 0) return { ...A }; if (u >= 1) return { ...A, ...B };
  const o = { ...A };
  for (const k of Object.keys(B)) {
    const a = A[k], b = B[k];
    if (typeof b === 'number' && typeof a === 'number' && !k.startsWith('bend')) o[k] = lerp(a, b, u);
    else if (Array.isArray(b) && Array.isArray(a)) o[k] = b.map((v, i) => typeof v === 'number' && typeof a[i] === 'number' ? lerp(a[i], v, u) : (u < .5 ? a[i] : v));
    else o[k] = u < .5 ? (a ?? b) : b;
  }
  return o;
}
// 关键帧：[[t, pose, ease?], ...]，ease(u) 默认 eio；每一帧都在两个关键姿势之间缓动，不会在 if 里跳变
export function keyed(base, keys) {
  const K = []; let cur = { ...base };
  for (const [t, p, e] of keys) { cur = { ...cur, ...p }; K.push([t, cur, e || eio]); }
  return t => {
    if (t <= K[0][0]) return { ...K[0][1] };
    for (let i = 0; i < K.length - 1; i++) {
      const [t0, a] = K[i], [t1, b, e] = K[i + 1];
      if (t < t1) return blend(a, b, e(clamp((t - t0) / (t1 - t0))));
    }
    return { ...K[K.length - 1][1] };
  };
}

// —— 图层：虚化 / 淡出的皮影先画到白底暂存画布，再整体 multiply 回透射率画布 ——
const [scC, scG] = canvas(W, H);
export function layer(tr, fn, { blur = 0, alpha = 1 } = {}) {
  if (alpha <= .002) return;
  if (blur < .35 && alpha > .998) { tr.save(); fn(tr); tr.restore(); return; }
  scG.setTransform(1, 0, 0, 1, 0, 0); scG.globalCompositeOperation = 'source-over'; scG.globalAlpha = 1; scG.filter = 'none';
  scG.fillStyle = '#fff'; scG.fillRect(0, 0, W, H);
  scG.save(); fn(scG); scG.restore();
  tr.save(); tr.setTransform(1, 0, 0, 1, 0, 0); tr.globalCompositeOperation = 'multiply'; tr.globalAlpha = alpha;
  if (blur >= .35) tr.filter = `blur(${blur.toFixed(2)}px)`;
  tr.drawImage(scC, 0, 0); tr.restore();
}
// 离布：绕屏幕点 c 放大 s 倍（皮影被拉向灯，变大变虚）
export function liftM(C, c, s) { return mul([s, 0, 0, s, c[0] * (1 - s), c[1] * (1 - s)], C); }

// —— 操纵杆：离布的竹杆，虚、半透明（屏幕坐标）——
export function drawRods(g, pts, ends, blur = 2.4, alpha = .62, widths) {
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'multiply'; g.filter = `blur(${blur}px)`; g.globalAlpha = alpha;
  pts.forEach((p, i) => {
    const e = ends[i], w = widths ? widths[i] : (i === 0 ? 4.2 : 2.8);
    g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(e[0], e[1]); g.strokeStyle = '#2a1a10'; g.lineWidth = w; g.stroke();
    g.beginPath(); g.arc(p[0], p[1], w * .95, 0, Math.PI * 2); g.fillStyle = '#2a1a10'; g.fill();
  });
  g.restore();
}
// 杆尾：从锚点斜向下方的艺人手里（k = 机位缩放；dir = 皮影朝向）
export const rodEnds = (rods, k, lean = 1) => rods.map((q, j) => [q[0] - (120 - j * 50) * k * lean, q[1] + 760 * k]);
export function rivets(g, pts, k) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); for (const q of pts) rivet(g, q[0], q[1], 3.2 * k); g.restore(); }
