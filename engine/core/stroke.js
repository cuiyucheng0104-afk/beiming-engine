// 北冥引擎 · 手绘笔触：把一串带笔压的中心线点 [x, y, pressure] 变成一条有粗细起伏的墨线轮廓。
// 返回闭合多边形的顶点数组 [[x, y], ...]，交给 Canvas 2D 填充即可。
//
//   size       笔宽（直径，像素）
//   thinning   笔压对粗细的影响：0 = 等宽，1 = 笔压为 0 时线宽收到 0
//   streamline 中心线跟手的迟滞：0 = 紧贴输入点，越大越"稳"、越圆顺
//   start / end { taper: 像素 } 起笔、收笔的出锋长度；不给 taper 时两端是圆头，圆头背向笔触方向
//   只有一个点（或所有点重合）时画一个整圆
//
// brushOutline(points, o) → { outline, spine, length }   毛笔笔画（书法的起收笔），inkStroke 的超集，默认行为与它无关、互不影响：
//   o = { size = 8, thinning = 0.55, streamline = 0.2, spacing, entry, exit, entryLen, exitLen, bulge, wobble, noise }
//   spacing     中心线按弧长重采样的点距（像素，默认 max(0.75, size / 6)），笔毛轨迹因此均匀
//   entry       起笔：'hidden' 藏锋（默认：钝圆的笔头比笔身略鼓，"蚕头"）| 'exposed' 露锋（尖入）| 'round' 圆头
//   exit        收笔：'exposed' 出锋（默认：尖出）| 'return' 回锋（钝收、末端略鼓）| 'press' 顿笔（先按后提，末端短锋）| 'round'
//   entryLen / exitLen   起笔、收笔造型占的长度（像素，默认 size × 1.5 / size × 2.2，两者之和超过笔长时按比例缩短）
//   bulge       蚕头 / 回锋 / 顿笔鼓起的比例（默认 0.14 / 0.14 / 0.35）
//   slant、pressAngle   鼓起偏向"按笔方向"（画面角度，默认 45° 即右下）那一侧的程度（0 对称 … 1 只鼓一侧，默认 0.6）：
//               横画的蚕头与回锋鼓在下侧、竖画鼓在右侧，与楷书的顿笔一致
//   wobble、noise   笔身毛边：半径乘 1 + wobble · noise(弧长 / size, 0)（noise 是 createNoise2D(...)；不给 noise 不起作用）
//   outline     闭合多边形 [[x, y], ...]（交给 Canvas 2D 填充）
//   spine       中心线采样 [{ x, y, r, rl, rr, s, nx, ny }]：平均半径、左右两侧半径、弧长、单位法线（左侧），给飞白、洇墨沿笔势取样
//   length      笔画总长（像素）
//
// 方法出处：参数约定与三条默认公式沿用 perfect-freehand（Steve Ruiz，MIT，github.com/steveruizok/perfect-freehand）的
//   getStroke——中心线迟滞系数 0.15 + 0.85·(1 − streamline)、半径 size·(0.5 − thinning·(0.5 − 笔压))、起笔 u(2 − u) 与
//   收笔 1 − (1 − u)³ 的收锋缓动。去重、笔压平滑、折返切线、端头与轮廓拼接是本文件自己的写法，没有复制该项目的源码
//   （仓库里也没有收录它）。

const EPS = 1e-6;

export function inkStroke(points, { size = 8, thinning = 0.5, streamline = 0.3, start = {}, end = {} } = {}) {
  if (!points.length) return [];
  // 1) 迟滞：每个点向上一个结果点只走一部分，抖动被吃掉
  const k = 0.15 + 0.85 * (1 - streamline);
  const P = [];
  let px = points[0][0], py = points[0][1];
  for (const q of points) {
    px += (q[0] - px) * k; py += (q[1] - py) * k;
    const last = P[P.length - 1];
    if (last && Math.hypot(px - last[0], py - last[1]) < 0.25) { last[2] = Math.max(last[2], q[2] ?? 0.5); continue; }
    P.push([px, py, q[2] ?? 0.5]);
  }
  // 收笔落在最后一个输入点上。平滑点已经与它重合（streamline = 0，或只有一个点）时改写末点、不再追加：
  // 追加的重合点切线为零，末端会捏成一点、圆头方向固定朝 +x，单点笔触也画不成圆
  const lastIn = points[points.length - 1], tail = P[P.length - 1];
  if (Math.hypot(lastIn[0] - tail[0], lastIn[1] - tail[1]) < EPS) {
    tail[0] = lastIn[0]; tail[1] = lastIn[1]; tail[2] = Math.max(tail[2], lastIn[2] ?? 0.5);
  } else {
    P.push([lastIn[0], lastIn[1], lastIn[2] ?? 0.5]);
  }
  const n = P.length;
  if (n === 1) return circle(P[0][0], P[0][1], radius(size, thinning, P[0][2]));

  // 2) 弧长、笔压平滑（笔压不会瞬间跳变）
  const L = [0];
  for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const total = L[n - 1];
  let pr = P[0][2];
  const R = P.map((p, i) => {
    pr += (p[2] - pr) * (i ? 0.35 : 1);
    let r = radius(size, thinning, pr);
    const t0 = start.taper || 0, t1 = end.taper || 0;
    if (t0 > 0) { const u = Math.min(1, L[i] / t0); r *= u * (2 - u); }
    if (t1 > 0) { const u = Math.min(1, (total - L[i]) / t1); r *= 1 - Math.pow(1 - u, 3); }
    return Math.max(r, EPS);
  });

  // 3) 沿法线向两侧偏移
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    let a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    // 前后邻点重合（笔触原路折返）时切线为零：改用单侧邻点，向前或向后找最近的不重合点
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < EPS) [a, b] = chord(P, i);
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    left.push([P[i][0] - ty * R[i], P[i][1] + tx * R[i]]);
    right.push([P[i][0] + ty * R[i], P[i][1] - tx * R[i]]);
  }

  // 4) 两端：有出锋就是尖头，否则补半圆
  const out = [...left];
  if (!(end.taper > 0)) out.push(...arc(P[n - 1], P[n - 2], R[n - 1]));
  out.push(...right.reverse());
  if (!(start.taper > 0)) out.push(...arc(P[0], P[1], R[0]));
  return out;
}

// 第 i 点的单侧弦：先找后面最近的不重合点，没有再找前面的；都没有就返回原点（长度为零）
function chord(P, i) {
  const c = P[i], far = q => Math.hypot(q[0] - c[0], q[1] - c[1]) >= EPS;
  for (let j = i + 1; j < P.length; j++) if (far(P[j])) return [c, P[j]];
  for (let j = i - 1; j >= 0; j--) if (far(P[j])) return [P[j], c];
  return [c, c];
}

function radius(size, thinning, p) {
  return Math.max(size * (0.5 - thinning * (0.5 - p)), size * 0.01);
}

// 以 c 为圆心、从"左侧"转到"右侧"的半圆，方向背离邻点 o
function arc(c, o, r, steps = 10) {
  const dir = Math.atan2(c[1] - o[1], c[0] - o[0]);
  const pts = [];
  for (let s = 1; s < steps; s++) {
    const a = dir + Math.PI / 2 - (Math.PI * s) / steps;
    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return pts;
}

function circle(x, y, r, steps = 16) {
  return Array.from({ length: steps }, (_, s) => {
    const a = (Math.PI * 2 * s) / steps;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r];
  });
}

// ── 毛笔笔画（书法起收笔）────────────────────────────────────────────────
const ss01 = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const ENTRIES = ['hidden', 'exposed', 'round'], EXITS = ['exposed', 'return', 'press', 'round'];

export function brushOutline(points, {
  size = 8, thinning = 0.55, streamline = 0.2, spacing, entry = 'hidden', exit = 'exposed',
  entryLen, exitLen, bulge, slant = 0.6, pressAngle = 45, wobble = 0, noise = null,
} = {}) {
  if (!ENTRIES.includes(entry)) throw new TypeError(`brushOutline：entry 只能是 ${ENTRIES.join(' / ')}，收到 ${JSON.stringify(entry)}`);
  if (!EXITS.includes(exit)) throw new TypeError(`brushOutline：exit 只能是 ${EXITS.join(' / ')}，收到 ${JSON.stringify(exit)}`);
  if (!(size > 0)) throw new TypeError(`brushOutline：size 要是正数，收到 ${size}`);
  if (!points.length) return { outline: [], spine: [], length: 0 };
  // 1) 迟滞平滑（与 inkStroke 同一套系数），末点落在最后一个输入点上
  const k = 0.15 + 0.85 * (1 - streamline);
  const P = [];
  let px = points[0][0], py = points[0][1];
  for (const q of points) {
    px += (q[0] - px) * k; py += (q[1] - py) * k;
    const last = P[P.length - 1];
    if (last && Math.hypot(px - last[0], py - last[1]) < 1e-3) { last[2] = Math.max(last[2], q[2] ?? 0.5); continue; }
    P.push([px, py, q[2] ?? 0.5]);
  }
  const lastIn = points[points.length - 1], tail = P[P.length - 1];
  if (Math.hypot(lastIn[0] - tail[0], lastIn[1] - tail[1]) < 1e-3) { tail[0] = lastIn[0]; tail[1] = lastIn[1]; }
  else P.push([lastIn[0], lastIn[1], lastIn[2] ?? 0.5]);
  if (P.length === 1) {
    const r = radius(size, thinning, P[0][2]);
    return { outline: circle(P[0][0], P[0][1], r), spine: [{ x: P[0][0], y: P[0][1], r, rl: r, rr: r, s: 0, nx: 0, ny: -1 }], length: 0 };
  }
  // 2) 按弧长等距重采样（笔压线性插值）
  const step = spacing ?? Math.max(0.75, size / 6);
  const Q = [P[0].slice()];
  let carry = 0;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = step - carry;
    while (d < L) { const u = d / L; Q.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]); d += step; }
    carry = L - (d - step);
  }
  const end = P[P.length - 1], qEnd = Q[Q.length - 1];
  if (Math.hypot(end[0] - qEnd[0], end[1] - qEnd[1]) > step * 0.25) Q.push(end.slice()); else { qEnd[0] = end[0]; qEnd[1] = end[1]; }
  const n = Q.length;
  const S = [0];
  for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]));
  const total = S[n - 1];
  // 3) 法线（左侧 = 前进方向的逆时针一侧；画布 y 朝下时，向右写的横画左侧在下方）
  const N = [];
  for (let i = 0; i < n; i++) {
    let a = Q[Math.max(0, i - 1)], b = Q[Math.min(n - 1, i + 1)];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < EPS) [a, b] = chord(Q, i);
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; N.push([-ty / l, tx / l]);
  }
  // 4) 半径：笔压平滑 → 起收笔造型 → 毛边。藏锋的笔头、回锋与顿笔的笔尾向"按笔方向"（画面上 pressAngle 度，默认右下 45°）
  //    那一侧鼓出，另一侧收：slant = 0 两侧对称，1 只鼓一侧
  let eL = entryLen ?? size * 1.5, xL = exitLen ?? size * 2.2;
  if (eL + xL > total) { const f = total / (eL + xL); eL *= f; xL *= f; }
  const bIn = bulge ?? 0.14, bOut = bulge ?? (exit === 'press' ? 0.35 : 0.14);
  const pa = pressAngle * Math.PI / 180, pdx = Math.cos(pa), pdy = Math.sin(pa);
  let pr = Q[0][2];
  const RL = [], RR = [];
  for (let i = 0; i < n; i++) {
    pr += (Q[i][2] - pr) * (i ? 0.3 : 1);
    let r = radius(size, thinning, pr), h = 0;
    const u = eL > 0 ? Math.min(1, S[i] / eL) : 1, v = xL > 0 ? Math.min(1, (total - S[i]) / xL) : 1;
    if (entry === 'exposed') r *= u * (2 - u);
    else if (entry === 'hidden') h += bIn * (1 - ss01(u));
    if (exit === 'exposed') r *= 1 - Math.pow(1 - v, 3);
    else if (exit === 'return') h += bOut * (1 - ss01(v));
    else if (exit === 'press') { const tip = 0.22; h += bOut * ss01((1 - v) / 0.75); if (v < tip) r *= 1 - Math.pow(1 - v / tip, 2); }
    if (wobble && noise) r *= 1 + wobble * noise(S[i] / size, 0.37);
    const side = slant * (N[i][0] * pdx + N[i][1] * pdy);          // 左侧朝按笔方向的程度
    RL.push(Math.max(r * (1 + h * (1 + side)), EPS)); RR.push(Math.max(r * (1 + h * (1 - side)), EPS));
  }
  const spine = [], left = [], right = [];
  for (let i = 0; i < n; i++) {
    const [nx, ny] = N[i];
    spine.push({ x: Q[i][0], y: Q[i][1], r: (RL[i] + RR[i]) / 2, rl: RL[i], rr: RR[i], s: S[i], nx, ny });
    left.push([Q[i][0] + nx * RL[i], Q[i][1] + ny * RL[i]]);
    right.push([Q[i][0] - nx * RR[i], Q[i][1] - ny * RR[i]]);
  }
  // 5) 两端：圆头 / 钝头补半圆（两侧半径不等时圆心偏向鼓的一侧），出锋 / 露锋收成一点
  const capAt = i => { const p = spine[i], o = (p.rl - p.rr) / 2; return [p.x + p.nx * o, p.y + p.ny * o]; };
  const out = [...left];
  if (exit === 'round' || exit === 'return') out.push(...arc(capAt(n - 1), Q[n - 2], spine[n - 1].r, 12));
  else out.push([Q[n - 1][0], Q[n - 1][1]]);
  out.push(...right.reverse());
  if (entry === 'round' || entry === 'hidden') out.push(...arc(capAt(0), Q[1], spine[0].r, 12));
  else out.push([Q[0][0], Q[0][1]]);
  return { outline: out, spine, length: total };
}
