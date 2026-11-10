// 毛笔：一笔有起笔、行笔、收笔，有浓淡枯湿；山体的"染"是笔下一片渐淡的水墨。坐标一律是设计坐标，调用方先设好世界变换。
//   prepareStroke(spec) → st      setup 时调用一次：Catmull-Rom 过点平滑 → 每 2.5 设计像素一个采样点；算笔宽、枯湿、行笔速度，
//                                  并把笔分成 lanes 道"笔毛"：每道笔毛沿弧长哪里有墨、哪里断墨（飞白）整条预先排好，逐帧只揭开，不会爬动
//   reveal(st, q) → p             时间 → 写到哪：q（0–1）是这一笔时间窗里过去的比例，返回已写出的弧长比例 p。
//                                  行笔速度由笔压和转折决定（按得重、转折处慢，提得轻处快），所以粗处停得久、细处一掠而过；
//                                  q = 0 时笔已按下（返回起笔那一小段，第一帧就有东西），q = 1 时正好写完
//   drawStroke(g, st, p, o)       把写到 p（0–1，已写出的弧长比例）为止的笔毛画进 g。只画"覆盖"（不透明的墨色），
//                                  浓淡由调用方合成这一层时的 globalAlpha 决定（重叠的笔毛不会叠出条纹）。
//                                  o.boil 一拍二的拍号（笔边轻微"沸腾"）
//   makeMass(st, o) → mass        setup 时调用一次：山体的染（脊线下方自上而下渐淡、带顺坡纹理与水渍，下缘不齐地化进雾里），缓存成位图
//   drawMass(g, mass, r)          r（0–1）：墨从脊线往下渗开的进度；r = 1 时整片落定
//   ridgeAt(st, x) → y            脊线在 x 处的高度
// spec 字段：
//   pts       过点的控制点（设计坐标）。转折处把点排密，转角就尖（山头不圆）
//   width     最粗处笔宽（设计像素）
//   pressure  [[u, p], ...] 沿弧长 u∈[0,1] 的笔压（0–1，单调插值、不过冲）：慢处按下去粗，快处提起来细，转折处顿一下。
//             粗细差要拉开（最细不到最粗的三分之一），远看才不是一根等宽线
//   entry     起笔长度（设计像素）。start 'press'（默认，藏锋）：笔先按下去，笔头圆而略宽（各道笔毛按半圆错开起笔）；
//             start 'tip'（露锋）：笔尖先着纸，在 entry 这段里由细变粗——从别的山后面"冒出来"的脊线用它
//   exit      出锋长度（设计像素）：最后这一段笔宽收到很细，笔毛并拢成尖
//   dry       [[u, d], ...] 沿弧长的枯笔程度（0 湿 → 1 枯）：越枯断墨的笔毛越多，靠边的先断；不给就是湿笔。
//             枯笔放在行笔快的地方（下坡、收笔），和速度对得上
//   lanes     笔毛道数（默认 18）；streak 断墨条纹的长度尺度（设计像素，默认 110：条纹长而连贯，不碎成虚线）
//   turn      转折处减速的强度（默认 1）；seed 噪声种子（每笔不同）
// 方法参考：起收笔、墨分五色、"中心线 × 笔压 × 笔宽噪声 + 若干笔毛，墨量沿笔递减、按长尺度噪声断开"的飞白、一拍二只许笔宽轻微沸腾、
//   "飞白像虚线"的陷阱，见 cases/vendor/lemo-opuscar/styles/ink-wash/STYLE.md §2、§5、§9（lemo-opuscar@bebbbe1，MIT，LemoLab）；
//   本文件是按这些描述自己写的实现，未复制其代码。
import { catmullRom, pointAt } from '../../engine/paint/curve.js';
import { clamp, ss, mulberry, monotone } from '../../engine/core/math.js';
import { createNoise2D } from '../../engine/core/noise.js';
import { canvasFor } from '../../engine/paint/canvas.js';

const STEP = 2.5;
const BANDS = [0.1, 0.3, 0.55, 2];          // 枯湿分档（d 小于哪一档）
const LW = [1.75, 1.3, 0.95, 0.7];           // 各档笔毛线宽（× 笔毛间距）：湿处互相压住成一整片，枯处变细露白

export function prepareStroke(spec) {
  const sp = catmullRom(spec.pts, 14), L = sp.total, n = Math.max(4, Math.ceil(L / STEP));
  const R = mulberry(spec.seed || 1), nz = createNoise2D(R);
  const press = monotone(spec.pressure || [[0, 1], [1, 1]]);
  const dry = spec.dry ? monotone(spec.dry) : () => 0;
  const entry = spec.entry || 0, exit = spec.exit || 0, C = [];
  for (let i = 0; i <= n; i++) {
    const s = L * i / n, q = pointAt(sp, s), u = s / L;
    const head = !entry ? 1 : spec.start === 'tip' ? 0.12 + 0.88 * ss(clamp(s / entry))   // 露锋：笔尖先着纸，越走越粗
      : 1 + 0.22 * (1 - ss(clamp(s / entry)));                                             // 藏锋：笔先按下去，头部略宽
    const tip = exit ? 0.12 + 0.88 * ss(clamp((L - s) / exit)) : 1;            // 出锋收尖
    const pr = clamp(press(u), 0.04, 1);
    const w = spec.width * pr * head * tip * (1 + 0.1 * nz(s / 70, 3.1) + 0.05 * nz(s / 16, 7.7));
    C.push({ x: q[0], y: q[1], s, u, w, pr, dry: clamp(dry(u)) });
  }
  for (let i = 0; i <= n; i++) {
    const a = C[Math.max(0, i - 1)], b = C[Math.min(n, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1;
    C[i].nx = -ty / l; C[i].ny = tx / l;
  }
  // 行笔时间：每走一个采样点花的时间 ∝ 1 / 速度。速度随笔压变（按得重就慢），转折处再慢（顿笔）；
  // 起笔那一小段算"按下去"，在第一帧里一起出现
  const turnK = spec.turn ?? 1, tau = new Float64Array(n + 1);
  const ang = i => { const a = C[Math.max(0, i - 1)], b = C[Math.min(n, i + 1)]; return Math.atan2(b.y - a.y, b.x - a.x); };
  for (let i = 1; i <= n; i++) {
    let d = ang(Math.min(n, i + 3)) - ang(Math.max(0, i - 3));
    d = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));                      // ±3 个采样点里转了多少角度
    const speed = (0.35 + 1.3 * Math.pow(1 - C[i].pr, 1.25)) / (1 + Math.min(3, turnK * 40 * d / (6 * STEP)));
    tau[i] = tau[i - 1] + STEP / speed;
  }
  const press0 = Math.min(n, Math.round((spec.start === 'tip' ? 0 : entry * 0.5) / STEP));
  for (let i = 0; i <= n; i++) tau[i] = Math.max(0, (tau[i] - tau[press0]) / (tau[n] - tau[press0] || 1));
  // 笔毛：每道一个横向位置 o∈(−1, 1)；起笔错开（笔头是斜的），哪里有墨由"枯湿 × 一行长尺度噪声"决定
  const K = spec.lanes || 18, lanes = [], streak = spec.streak || 110;
  // 藏锋的圆头：圆心在起点往里半个笔宽处，半径是那里的半个笔宽（drawStroke 先垫这块实心圆头）
  const cap = spec.start === 'tip' ? null : Math.min(n, Math.round(C[0].w * 0.5 / STEP)), R0 = cap == null ? 0 : C[cap].w * 0.5;
  for (let k = 0; k < K; k++) {
    const o = -0.94 + 1.88 * (k + 0.5) / K + (R() - 0.5) * 0.06;
    // 藏锋：笔头是圆的——每道笔毛从圆头的边界往里一点起笔（靠边的晚起），笔毛的圆端都藏在圆头里，不露出一排圆齿
    const a0 = cap == null ? 0 : Math.min(n - 1, Math.round(((1 - Math.sqrt(1 - o * o)) * R0 + 1.5 + 2.5 * R()) / STEP));
    // 一道笔毛的墨分成若干段 [起, 止, 粗细]：断墨处断开；枯湿换档处也断开，越枯笔毛越细，空隙才露得出来
    const runs = [];
    let a = -1, band = -1;
    for (let i = a0; i <= n; i++) {
      const d = C[i].dry, bd = BANDS.findIndex(x => d < x);
      const ink = d <= 0 || 0.5 + 0.5 * nz(o * 2.3 + k * 0.61 + 50, C[i].s / streak) < 1 - d * (0.85 + 0.55 * Math.abs(o));
      if (a >= 0 && (!ink || bd !== band || i === n)) {
        const b = ink && i === n ? i : i - 1;
        if (b - a >= 2) runs.push([a, b, LW[band]]);
        a = -1;
      }
      if (ink && a < 0) { a = Math.max(a0, i - (band >= 0 && bd !== band ? 1 : 0)); band = bd; }
    }
    lanes.push({ o, k, runs });
  }
  return { spec, C, n, L, lanes, nz, tau, press0, lw: spec.width / K, cap };
}

export function reveal(st, q) {
  const { tau, n, press0 } = st;
  if (q <= 0) return press0 / n;
  if (q >= 1) return 1;
  let lo = press0, hi = n;                                                   // tau 单调不减：二分找 q 落在哪两个采样点之间
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tau[m] < q) lo = m; else hi = m; }
  const u = (q - tau[lo]) / ((tau[hi] - tau[lo]) || 1);
  return (lo + clamp(u)) / n;
}

export function drawStroke(g, st, p, o = {}) {
  if (p <= 0) return;
  const { C, n, nz } = st, boil = o.boil || 0;
  const head = Math.max(2, Math.min(n, Math.round(p * n)));
  g.save();
  g.strokeStyle = g.fillStyle = o.color || '#1b1916'; g.lineCap = 'round'; g.lineJoin = 'round';
  // 藏锋的笔头：先垫一块实心的圆头（比笔毛略收一点），笔毛压在上面——笔头外沿是笔毛的毛边，里面没有一排排圆齿的缝
  if (st.cap != null) {
    const ci = Math.min(st.cap, head), c0 = C[ci], R0 = c0.w * 0.5, m = Math.min(head, ci + Math.round(st.press0 * 1.2));
    const th = Math.atan2(c0.ny, c0.nx), k = 0.48;
    g.globalAlpha = 0.92; g.beginPath();
    for (let j = 0; j <= 16; j++) {      // 后半圆：从 +法向经过笔后方转到 −法向，半径带一点噪声起伏（不是圆规画的）
      const a = th + Math.PI * j / 16, r = R0 * (0.95 + 0.07 * nz(j * 0.7 + 3, 11.3));
      g.lineTo(c0.x + Math.cos(a) * r, c0.y + Math.sin(a) * r);
    }
    for (let i = ci; i <= m; i++) g.lineTo(C[i].x - C[i].nx * C[i].w * k, C[i].y - C[i].ny * C[i].w * k);
    for (let i = m; i >= ci; i--) g.lineTo(C[i].x + C[i].nx * C[i].w * k, C[i].y + C[i].ny * C[i].w * k);
    g.closePath(); g.fill();
  }
  g.globalAlpha = 0.82;                  // 单道笔毛略透：笔心几道叠起来近乎全黑，笔边与枯笔只有一道，自然淡一点、软一点
  for (const lane of st.lanes) {
    // 笔头是圆的：还在纸上的笔头，靠边的笔毛比中间的早停一点（半圆），不是一刀切的平头
    const end = head - (head < n ? Math.round((1 - Math.sqrt(1 - lane.o * lane.o)) * C[head].w * 0.5 / STEP) : 0);
    for (const [a, b0, k] of lane.runs) {
      if (a >= end) break;
      const b = Math.min(b0, end);
      g.beginPath();
      for (let i = a; i <= b; i++) {
        const c = C[i];
        // 笔边的不齐：静态的细抖 + 一拍二换形的轻微沸腾（只动宽度方向，不动笔路）
        const off = (lane.o + 0.05 * nz(lane.k * 1.7 + 9, c.s / 9) + 0.02 * nz(lane.k + 3, boil * 1.3 + c.s / 40)) * c.w * 0.5;
        const x = c.x + c.nx * off, y = c.y + c.ny * off;
        if (i === a) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.lineWidth = st.lw * k;
      g.stroke();
    }
  }
  g.restore();
}

// 脊线高度：按 x 在中心线上插值（山脊大体是 x 的单值函数）
export function ridgeAt(st, x) {
  const { C } = st;
  if (x <= C[0].x) return C[0].y;
  for (let i = 1; i < C.length; i++) {
    if (C[i].x >= x) { const a = C[i - 1], b = C[i], u = (x - a.x) / ((b.x - a.x) || 1); return a.y + (b.y - a.y) * u; }
  }
  return C[C.length - 1].y;
}

// 山体的染：脊线下方一片墨，离脊线越远越淡；下缘按噪声起伏、化进纸里（云雾即留白）
//   o = { base, tone, px, seed, band, rgb }   band：贴着脊线那条更浓的墨带有多宽（0–1，按脊线到下缘的距离算）
//   纹理三层：顺坡拉长的噪声（像笔拖过的皴擦）+ 成团的浓淡 + 细颗粒。
//   顺坡纹理按左右两坡各取一张（方向固定），峰顶附近 ±80 设计像素里交叉淡入淡出：
//   硬切会在峰顶正下方留一条竖缝；改成"旋转坐标轴"又会在过渡区挤出一排竖条纹（离原点越远转得越快），两种都试过
export function makeMass(st, o) {
  const { C } = st, px = o.px, tone = o.tone, band = o.band ?? 0.12;
  const x0 = Math.min(...C.map(c => c.x)), x1 = Math.max(...C.map(c => c.x)), y0 = Math.min(...C.map(c => c.y));
  const top = C.reduce((m, c) => (c.y < m.y ? c : m), C[0]);
  const nz = createNoise2D(mulberry(o.seed || 9)), nz2 = createNoise2D(mulberry((o.seed || 9) + 1));
  const base = x => o.base + 34 * nz2(x / 170, 1.7) + 14 * nz2(x / 47, 5.3);   // 下缘不齐：雾的边不是一条直线
  const yMax = o.base + 50;
  const bw = Math.ceil((x1 - x0) * px), bh = Math.ceil((yMax - y0) * px);
  const cv = document.createElement('canvas'); cv.width = Math.max(1, bw); cv.height = Math.max(1, bh);
  const g = cv.getContext('2d'), im = g.createImageData(cv.width, cv.height), d = im.data;
  const ridge = new Float32Array(cv.width), floor = new Float32Array(cv.width);
  for (let x = 0; x < cv.width; x++) { const dx = x0 + (x + 0.5) / px; ridge[x] = ridgeAt(st, dx); floor[x] = base(dx); }
  const rgb = o.rgb || [27, 25, 22], edge = 80;
  const slopeL = Math.atan2(top.y - C[0].y, top.x - C[0].x), slopeR = Math.atan2(C.at(-1).y - top.y, C.at(-1).x - top.x);
  const cL = Math.cos(slopeL), sL = Math.sin(slopeL), cR = Math.cos(slopeR), sR = Math.sin(slopeR);
  for (let x = 0; x < cv.width; x++) {
    const dx = x0 + (x + 0.5) / px, r = ridge[x], depth = Math.max(1, floor[x] - r);
    const foot = ss(clamp((dx - x0) / edge)) * ss(clamp((x1 - dx) / edge));
    const wR = ss(clamp((dx - top.x) / 160 + 0.5));
    for (let y = 0; y < cv.height; y++) {
      const dy = y0 + (y + 0.5) / px, v = (dy - r) / depth;
      if (v < -0.02 || v > 1) continue;
      const fall = Math.pow(1 - ss(clamp(v)), 1.6) + 0.6 * Math.exp(-Math.max(v, 0) / band) * (1 - ss(clamp(v * 2.5)));
      const streak = (1 - wR) * nz((dx * cL + dy * sL) / 260, (-dx * sL + dy * cL) / 44) + wR * nz((dx * cR + dy * sR) / 260 + 31, (-dx * sR + dy * cR) / 44);
      const tex = 1 + 0.2 * streak + 0.14 * nz(dx / 120, dy / 90) + 0.07 * nz2(dx / 15, dy / 15);
      const a = tone * fall * foot * clamp(tex, 0.35, 1.6) * ss(clamp((v + 0.02) / 0.05));
      if (a <= 0.002) continue;
      const i = (y * cv.width + x) * 4;
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = Math.round(255 * clamp(a));
    }
  }
  g.putImageData(im, 0, 0);
  return { cv, x0, y0, w: x1 - x0, h: yMax - y0, ridge, floor, px };
}

export function drawMass(g, m, r) {
  if (r <= 0) return;
  const alpha = Math.min(1, 0.35 + 0.65 * ss(r));
  if (r >= 1) { g.save(); g.globalAlpha = alpha; g.drawImage(m.cv, m.x0, m.y0, m.w, m.h); g.restore(); return; }
  // 墨从脊线往下渗：只留"脊线以下 r 那么深"以内的部分；渗开的前沿是羽化的（硬裁会像一条投影）
  const M = g.getTransform(), W = g.canvas.width, H = g.canvas.height, k = ss(r), path = new Path2D();
  path.moveTo(m.x0, m.y0 - 20);
  for (let i = 0; i < m.ridge.length; i += 4) {
    const x = m.x0 + (i + 0.5) / m.px, rr = m.ridge[i];
    path.lineTo(x, rr + (m.floor[i] - rr) * k);
  }
  path.lineTo(m.x0 + m.w, m.y0 - 20); path.closePath();
  const tmp = canvasFor('brush.mass', W, H), tg = tmp.getContext('2d');
  const mask = canvasFor('brush.mask', W, H), mg = mask.getContext('2d');
  for (const x of [tg, mg]) { x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.filter = 'none'; x.clearRect(0, 0, W, H); }
  tg.setTransform(M); tg.globalAlpha = alpha; tg.drawImage(m.cv, m.x0, m.y0, m.w, m.h);
  mg.setTransform(M); mg.filter = `blur(${(18 * Math.hypot(M.a, M.b)).toFixed(2)}px)`; mg.fillStyle = '#000'; mg.fill(path);
  tg.setTransform(1, 0, 0, 1, 0, 0); tg.globalAlpha = 1; tg.globalCompositeOperation = 'destination-in'; tg.drawImage(mask, 0, 0);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(tmp, 0, 0); g.restore();
}
