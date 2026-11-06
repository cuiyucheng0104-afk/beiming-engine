// 瑞士段：书封上的版面（Canvas2D，逻辑 1920×1080，按 S 倍绘制）。
// 12 栏 × 6 行模块网格；数字切口升起、在拍上落定；第 3 小节数字依网格收拢成底部数字条，标题从切口升起。
import { T, NUMS, TITLE, E8 } from './timeline.js';

export const PAPER = '#EFEBE3', INK = '#141414', SIGNAL = '#BE3A2E', GRID = '#C4BDB0', GRID2 = '#A9A193';
export const ML = 96, MT = 96, CW = 122, GUT = 24, RH = 128, W = 1920, H = 1080;
export const colX = i => ML + i * (CW + GUT);
export const rowY = j => MT + j * (RH + GUT);
const BOTTOM = H - MT;   // 984

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a));
function cubicBezier(x1, y1, x2, y2) {
  const bx = u => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const by = u => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  return t => { if (t <= 0) return 0; if (t >= 1) return 1; let lo = 0, hi = 1, u = t;
    for (let i = 0; i < 40; i++) { const x = bx(u); if (Math.abs(x - t) < 1e-7) break; if (x < t) lo = u; else hi = u; u = (lo + hi) / 2; } return by(u); };
}
export const E = cubicBezier(.7, 0, .2, 1);            // 全片唯一的精确缓动
const snap = (t, t1, d = E8) => E(seg(t, t1 - d, t1));

const NUMFONT = s => `800 ${s}px Inter`;
const TFONT = s => `700 ${s}px NSC`;
let L = null;   // 版面（字体加载后量一次）

function metrics(x, font, text) {
  x.font = font; const m = x.measureText(text);
  return { w: m.actualBoundingBoxRight + m.actualBoundingBoxLeft, lb: m.actualBoundingBoxLeft, asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent };
}
// 字号让字宽恰好等于给定宽度（光学齐左：减去左侧空白）
function fitW(x, text, width, fontFn) { const m = metrics(x, fontFn(100), text); return 100 * width / m.w; }

export function layout(x) {
  const A = [], B = [];
  // —— A：落定时的版面（极端尺度对比）——
  const s1960 = fitW(x, '1960', colX(7) - GUT - ML, NUMFONT);
  const s25 = fitW(x, '25', W - ML - colX(6), NUMFONT);
  const s477 = fitW(x, '477', colX(4) - GUT - ML, NUMFONT);
  const sSmall = 132;
  const at = (text, size, cx, base) => { const m = metrics(x, NUMFONT(size), text); return { size, x: cx - m.lb * -1 * 0 + (-m.lb), base, w: m.w, asc: m.asc, desc: m.desc, lb: m.lb }; };
  // 1960：左上，字顶贴上边距
  { const m = metrics(x, NUMFONT(s1960), '1960'); A.push({ size: s1960, x: ML + m.lb, base: MT + m.asc, m }); }
  // 25：右下，朱红，最大
  { const m = metrics(x, NUMFONT(s25), '25'); A.push({ size: s25, x: colX(6) + m.lb, base: BOTTOM, m }); }
  // 477：左中
  { const m = metrics(x, NUMFONT(s477), '477'); A.push({ size: s477, x: ML + m.lb, base: rowY(3) + RH, m }); }
  // 8 9 12：左下一行小号
  [[3, 0], [4, 1], [5, 2]].forEach(([k, c]) => { const m = metrics(x, NUMFONT(sSmall), NUMS[k]); A.push({ size: sSmall, x: colX(c) + m.lb, base: BOTTOM, m }); });
  // —— B：收拢后的底部数字条 ——
  // 每个数字占 2 栏模块，齐左于第 0/2/4/6/8/10 栏；字号让「1960」恰好填满一个模块
  const sRow = fitW(x, '1960', 2 * CW - GUT * 2, NUMFONT);
  // 数字条的槽位按"起点从左到右"排（1960 477 8 9 12 25）：收拢时所有数字同向右移或下落，路径互不交叉；朱红 25 收在最右端
  const SLOT = [0, 5, 1, 2, 3, 4];
  NUMS.forEach((n, k) => { const m = metrics(x, NUMFONT(sRow), n); B.push({ size: sRow, x: colX(2 * SLOT[k]) + m.lb, base: BOTTOM, m }); });
  // 标题：上美影 IP 全景，字顶贴上边距，宽度到第 10 栏末
  const gap = .26, words = TITLE;
  const tw = s => words.reduce((a, w, i) => a + metrics(x, TFONT(s), w).w, 0) + gap * s * (words.length - 1);
  const ts = 100 * (colX(10) + CW - ML) / tw(100);
  const tm = words.map(w => metrics(x, TFONT(ts), w));
  const asc = Math.max(...tm.map(m => m.asc));
  let px = ML; const tWords = [];
  tm.forEach((m, i) => { tWords.push({ text: words[i], x: px + m.lb, base: MT + asc, m, size: ts }); px += m.w + gap * ts; });
  // 数字条上方的细线、标题下方的粗墨条（非文字的版面元素）
  const rowTop = BOTTOM - B[0].m.asc - GUT;
  L = { A, B, tWords, ts, rowTop, barY: MT + asc + GUT * 2 };
  return L;
}

// 画面里每段文字在版面坐标里的框（readcheck 用）
export function coverTexts(t) {
  if (!L) return [];
  const out = [];
  NUMS.forEach((n, k) => {
    const tk = T.nums[k]; if (t < tk - E8) return;
    const s = numState(t, k); out.push({ id: 'num' + k, text: n, x0: s.x - s.m.lb * s.k, y0: s.base - s.m.asc * s.k, x1: s.x - s.m.lb * s.k + s.m.w * s.k, y1: s.base + s.m.desc * s.k });
  });
  if (t >= T.title[0] - E8) {
    const a = L.tWords[0], z = L.tWords[2];
    out.push({ id: 'title', text: TITLE.join(' '), x0: a.x - a.m.lb, y0: a.base - Math.max(...L.tWords.map(w => w.m.asc)), x1: z.x - z.m.lb + z.m.w, y1: a.base + Math.max(...L.tWords.map(w => w.m.desc)) });
  }
  return out;
}

export const REFLOW_LAG = [5 / 30, -2 / 30, 0, 0, 0, 0];   // 1960 25 477 8 9 12（逐帧穷举得到：收拢全程两两最小间距 ≥ 6 px）
// 数字 k 在时间 t 的位置与比例（k = 字号 / A 字号）
function numState(t, k) {
  const a = L.A[k], b = L.B[k];
  let p;
  let ps;
  // 起步错开（终点不变）：1960 晚 5 帧压下来（等 477 先让路）；25 早 2 帧起步，始终走在 12 前面 → 收拢途中互不相压
  const t0 = T.reflow0 + REFLOW_LAG[k];
  if (k === 1) { p = seg(t, t0, T.reflow25); ps = E(seg(t, t0, T.reflow)); }   // 25：例外——位置线性、晚一个十六分到位（字号与大家同时收好，免得压字）
  else p = ps = E(seg(t, t0, T.reflow));
  const size = lerp(a.size, b.size, ps);
  return { x: lerp(a.x, b.x, p), base: lerp(a.base, b.base, p), size, k: size / a.size, m: a.m, p };
}

export function drawCover(x, t, S = 2) {
  x.setTransform(S, 0, 0, S, 0, 0);
  x.fillStyle = PAPER; x.fillRect(0, 0, W, H);
  // —— 网格线：先横后竖，线性生长 ——
  x.lineWidth = 1.5; x.strokeStyle = GRID;
  const hy = [0, 1, 2, 3, 4, 5].map(j => rowY(j)).concat([BOTTOM]);
  hy.forEach((y, i) => { const p = seg(t, T.hLines[i] - 1 / 30, T.hLines[i] - 1 / 30 + T.lineDur); if (p <= 0) return;
    x.beginPath(); x.moveTo(ML - 24, y + .5); x.lineTo(ML - 24 + (W - 2 * ML + 48) * p, y + .5); x.stroke(); });
  const vx = Array.from({ length: 12 }, (_, i) => colX(i)).concat([W - ML]);
  vx.forEach((xx, i) => { const p = seg(t, T.vLines[i] - 1 / 30, T.vLines[i] - 1 / 30 + T.lineDur); if (p <= 0) return;
    x.beginPath(); x.moveTo(xx + .5, MT - 24); x.lineTo(xx + .5, MT - 24 + (H - 2 * MT + 48) * p); x.stroke(); });
  // 模块角上的小刻度（印刷的套准标记感，非文字）
  const pk = seg(t, T.vLines[12], T.vLines[12] + E8);
  if (pk > 0) { x.strokeStyle = GRID2; x.lineWidth = 2;
    for (const [cx, cy] of [[ML - 24, MT - 24], [W - ML + 24, MT - 24], [ML - 24, H - MT + 24], [W - ML + 24, H - MT + 24]]) {
      const l = 18 * pk; x.beginPath(); x.moveTo(cx - l, cy); x.lineTo(cx + l, cy); x.moveTo(cx, cy - l); x.lineTo(cx, cy + l); x.stroke(); } }

  // —— 数字条上方的细线（收拢时线性画出）——
  const pr = seg(t, T.reflow, T.reflow + E8);
  if (pr > 0) { x.fillStyle = INK; x.fillRect(ML, L.rowTop, (W - 2 * ML) * pr, 2); }
  // —— 标题下的粗墨条（标题落定后从左画到右）——
  const pb = seg(t, T.title[2], T.title[2] + E8);
  if (pb > 0) { x.fillStyle = INK; x.fillRect(ML, L.barY, (colX(10) + CW - ML) * pb, 14); }

  // —— 数字 ——
  x.textBaseline = 'alphabetic'; x.textAlign = 'left';
  NUMS.forEach((n, k) => {
    const tk = T.nums[k]; if (t < tk - E8) return;
    const s = numState(t, k), a = L.A[k];
    x.save();
    x.translate(s.x, s.base); x.scale(s.k, s.k);
    if (t < tk) {   // 切口升起：从基线下方升到位，落在拍上
      const p = snap(t, tk), h = a.m.asc + a.m.desc;
      x.beginPath(); x.rect(-a.m.lb - 4, -a.m.asc - 2, a.m.w + 8, h + 4); x.clip();
      x.translate(0, (1 - p) * (h + 6));
    }
    x.font = NUMFONT(a.size); x.fillStyle = k === 1 ? SIGNAL : INK;
    x.fillText(n, 0, 0);
    x.restore();
  });
  // —— 标题 ——
  L.tWords.forEach((w, i) => {
    const tk = T.title[i]; if (t < tk - E8) return;
    x.save(); x.translate(w.x, w.base);
    if (t < tk) { const p = snap(t, tk), h = w.m.asc + w.m.desc;
      x.beginPath(); x.rect(-w.m.lb - 4, -w.m.asc - 4, w.m.w + 8, h + 8); x.clip(); x.translate(0, (1 - p) * (h + 10)); }
    x.font = TFONT(w.size); x.fillStyle = INK; x.fillText(w.text, 0, 0);
    x.restore();
  });
  x.setTransform(1, 0, 0, 1, 0, 0);
}

// 对拍检查用：各元素的切口升起进度（1 = 落定）
export function coverState(t) {
  return { nums: T.nums.map(tk => snap(t, tk)), title: T.title.map(tk => snap(t, tk)), reflow: E(seg(t, T.reflow0, T.reflow)), reflow25: seg(t, T.reflow0, T.reflow25) };
}
