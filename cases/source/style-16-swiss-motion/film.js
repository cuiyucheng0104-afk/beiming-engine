// TEMPO · 节拍 —— render(t) 确定性绘制（无随机、无时钟、无帧间状态）
import { E8, E16, DUR, colX, rowY, T, DOT, TXT } from './timeline.js';

const C = { page: '#EAE9E5', paper: '#FFFFFF', ink: '#111111', red: '#E30613', grid: '#DDDCD7', gridPage: '#CFCEC9', ghost: '#C4C3BE' };
const FAM = 'Archivo, NotoSC';

// —— 两条曲线：精确缓动 cubic-bezier(.7,0,.2,1) 与线性 ——
function cubicBezier(x1, y1, x2, y2) {
  const bx = u => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const by = u => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  return t => {
    if (t <= 0) return 0; if (t >= 1) return 1;
    let lo = 0, hi = 1, u = t;
    for (let i = 0; i < 40; i++) { const x = bx(u); if (Math.abs(x - t) < 1e-7) break; if (x < t) lo = u; else hi = u; u = (lo + hi) / 2; }
    return by(u);
  };
}
const E = cubicBezier(.7, 0, .2, 1);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, p) => a + (b - a) * p;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const snap = (t, t1, d) => E(seg(t, t1 - d, t1));          // 提前 d 开始，落在 t1

// —— 2D 相机矩阵 [a,b,c,d,e,f] ——
const I = [1, 0, 0, 1, 0, 0];
function cam(ax, ay, cx, cy, s, r) { const co = Math.cos(r) * s, si = Math.sin(r) * s; return [co, si, -si, co, ax - (co * cx - si * cy), ay - (si * cx + co * cy)]; }
function mul(M, N) { return [M[0] * N[0] + M[2] * N[1], M[1] * N[0] + M[3] * N[1], M[0] * N[2] + M[2] * N[3], M[1] * N[2] + M[3] * N[3], M[0] * N[4] + M[2] * N[5] + M[4], M[1] * N[4] + M[3] * N[5] + M[5]]; }
function inv(M) { const [a, b, c, d, e, f] = M, k = a * d - b * c, ia = d / k, ib = -b / k, ic = -c / k, id = a / k; return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)]; }
const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const scl = M => Math.hypot(M[0], M[1]);
const lerpM = (M, N, p) => M.map((v, i) => lerp(v, N[i], p));
const setM = (g, M) => g.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);

function font(g, w, size) { g.font = `${w} ${size}px ${FAM}`; g.letterSpacing = size >= 90 ? `${(-size * 0.02).toFixed(2)}px` : '0px'; }

// —— 量字（init 时一次）——
const D = {};            // 数字 1–4：asc/abl/abr（每 1 px 字号）
const W = {};            // TEMPO 单词的世界坐标几何
export function init(g) {
  font(g, 800, 1000);
  for (const ch of '1234') { const m = g.measureText(ch); D[ch] = { asc: m.actualBoundingBoxAscent / 1000, abl: m.actualBoundingBoxLeft / 1000, abr: m.actualBoundingBoxRight / 1000 }; }
  font(g, 800, 100);
  const word = TXT.word, xs = [], box = [];
  for (let i = 0; i < word.length; i++) {
    xs.push(g.measureText(word.slice(0, i)).width);
    const m = g.measureText(word[i]); box.push([m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent]);
  }
  const ink0 = xs[0] - box[0][0], ink1 = xs[4] + box[4][1];
  const F = 100 * 1728 / (ink1 - ink0), k = F / 100;
  font(g, 800, F);                       // 在真实字号下再量一次（letterSpacing 与字号成比例）
  const capH = g.measureText('T').actualBoundingBoxAscent, BY = 540 + capH / 2;
  W.F = F; W.capH = capH; W.BY = BY; W.letters = [];
  for (let i = 0; i < word.length; i++) {
    const X = 96 + (xs[i] - ink0) * k, [l, r, a, d] = box[i].map(v => v * k);
    W.letters.push({ ch: word[i], X, x0: X - l, x1: X + r, top: BY - a, bot: BY + d });
  }
  const O = W.letters[4]; W.O = [(O.x0 + O.x1) / 2, (O.top + O.bot) / 2]; W.rO = 0.6 * Math.max(O.x1 - O.x0, O.bot - O.top);
  W.mTop = Math.min(...W.letters.map(L => L.top)) - 6; W.mBot = Math.max(...W.letters.map(L => L.bot)) + 6;
  build();
}

// —— 由几何推出的常量 ——
const CELL = k => ({ x: colX(3 * k), base: rowY(k) + 444, capH: 444 });
const CAMC = () => cam(366, 540, 960, 540, 0.5, Math.PI / 2);                  // 旋转后的书脊页
const BIG = { x: colX(4), base: 996, capH: 912 };                              // 加速段巨大数字
const FOC = [1520, 996];                                                       // 推进的不动点（数字右下角）
const PW = 414, PH = 736, PY = 172, PX = k => 96 + (k - 1) * (PW + 24);        // 四联海报（最终坐标）
const K0 = 1000 / PH, P4C = [PX(4) + PW / 2, 540];
let SP, PCAM, DOTP, PULLC;
function cellBox(k) { const c = CELL(k), ch = String(k + 1), F = c.capH / D[ch].asc; return [c.x, c.base - c.capH, c.x + (D[ch].abl + D[ch].abr) * F, c.base]; }
function build() {
  // 阶梯拉出的取景中心：每一级都把刚落下的那一格完整框进来（边距 28），旧的格子可以被画框裁掉
  PULLC = T.pull.map(([, s], i) => {
    if (i === 0) return [96 + 0.35 * 444, rowY(0) + 222];
    if (i === 4) return [960, 540];
    const [, , xR, yB] = cellBox(i), m = 28;
    return [Math.max(xR + m - 960 / s, (96 + xR) / 2), Math.max(yB + m - 540 / s, (84 + yB) / 2)];
  });
  SP = 0.30 * PW / W.capH;
  PCAM = k => cam(PX(k) + 20 + SP * W.capH / 2, PY + 20 + 864 * SP, 960, 540, SP, Math.PI / 2);
  const P3 = ap(CAMC(), W.O[0], W.O[1]);
  DOTP = DOT.map(k => k[1] === null ? [k[0], P3[0], P3[1], W.rO * 0.5] : k);
}

// —— 相机轨道 ——
function camA(t) {                    // 第 1 小节阶梯拉出
  const ks = T.pull; let s = ks[0][1], c = PULLC[0];
  for (let i = 1; i < ks.length; i++) { const p = snap(t, ks[i][0], E8); s = lerp(s, ks[i][1], p); c = [lerp(c[0], PULLC[i][0], p), lerp(c[1], PULLC[i][1], p)]; }
  return { A: [960, 540], c, s, r: 0 };
}
function camB(t) {                    // 按字母硬摇
  let st = { A: [960, 540], c: [960, 540], s: 1, r: 0 };
  T.pans.forEach((tl, i) => {
    const L = W.letters[i], p = snap(t, tl, E8);
    st = { A: [960, 540], c: [lerp(st.c[0], (L.x0 + L.x1) / 2, p), 540], s: lerp(st.s, 1.6, p), r: 0 };
  });
  return st;
}
function camParams(t) {
  if (t < 2) return camA(t);
  let st = camB(t);
  if (t >= T.rot[0]) {
    const p = E(seg(t, T.rot[0], T.rot[1]));
    st = { A: [lerp(960, 366, p), 540], c: [lerp(st.c[0], 960, p), 540], s: lerp(1.6, 0.5, p), r: lerp(0, Math.PI / 2, p) };
  }
  return st;
}
function cam2(t) {                    // 推进到一个模块（屏幕层）
  let k = 1;
  for (const [a, b, s] of T.push) k = lerp(k, s, E(seg(t, a, b)));
  return cam(FOC[0], FOC[1], FOC[0], FOC[1], k, 0);
}
function cam3(t) {                    // 海报段：先框住第 4 张，再拉出成四联
  const p = E(seg(t, T.pullOut[0], T.pullOut[1]));
  return cam(lerp(960, P4C[0], p), 540, P4C[0], 540, lerp(K0, 1, p), 0);
}
const pReflow = (t, i) => E(seg(t, T.reflow[i] - E16, T.reflow[i]));
function worldM(t) {
  if (t >= T.dotLand) {
    const c3a = cam3(T.dotLand), from = mul(inv(c3a), CAMC());
    return mul(cam3(t), lerpM(from, PCAM(4), pReflow(t, 0)));
  }
  const p = camParams(t), M = cam(p.A[0], p.A[1], p.c[0], p.c[1], p.s, p.r);
  return t >= 10 && t < 12.5 ? mul(cam2(t), M) : M;
}

// —— 红点 ——
function dotAt(t) {
  if (t < T.dotIn) return null;
  if (t >= T.dotLand) { const M = worldM(t), [x, y] = ap(M, W.O[0], W.O[1]); return [x, y, W.rO * scl(M)]; }
  for (let i = 1; i < DOTP.length; i++) if (t <= DOTP[i][0]) {
    const a = DOTP[i - 1], b = DOTP[i], p = seg(t, a[0], b[0]);     // 线性，不吸附
    return [lerp(a[1], b[1], p), lerp(a[2], b[2], p), lerp(a[3], b[3], p)];
  }
  return null;
}

// —— 绘制工具 ——
function digitSeq(t, seq) {           // [[t,ch],...] → {cur, prev, p}；退出向上、进入自下
  let cur = null, prev = null, p = 1;
  for (let i = 0; i < seq.length; i++) {
    const [ti, ch] = seq[i], gap = i ? ti - seq[i - 1][0] : 0.5, d = gap >= 0.5 ? E8 : E16;
    if (t < ti - d) break;
    prev = cur; cur = ch; p = snap(t, ti, d);
    if (p < 1) break;
  }
  return { cur, prev: p < 1 ? prev : null, p };
}
function drawDigit(g, ch, xL, base, capH, dy = 0, sy = 1, col = C.ink) {
  const F = capH / D[ch].asc; font(g, 800, F); g.fillStyle = col;
  if (sy !== 1) { const mid = base - capH / 2; g.save(); g.translate(0, mid); g.scale(1, sy); g.translate(0, -mid); }
  g.fillText(ch, xL + D[ch].abl * F, base + dy);
  if (sy !== 1) g.restore();
}
function digitBox(g, seqState, xL, base, capH) {   // 在裁切框里换数
  const { cur, prev, p } = seqState; if (!cur) return;
  const H = capH * 1.2;
  g.save(); g.beginPath(); g.rect(xL - capH, base - capH - 2, capH * 3, capH + 4); g.clip();
  if (prev) drawDigit(g, prev, xL, base, capH, -p * H);
  drawDigit(g, cur, xL, base, capH, (1 - p) * H);
  g.restore();
}
function riseText(g, s, x, y, size, w, pIn, pOut = 0, color = C.ink) {
  if (pIn <= 0 || pOut >= 1) return;
  font(g, w, size); const tw = g.measureText(s).width;
  g.save(); g.beginPath(); g.rect(x - 2, y - size * 1.05, tw + 6, size * 1.35); g.clip();
  g.fillStyle = color; g.fillText(s, x, y + (1 - pIn) * size * 1.3 - pOut * size * 1.3);
  g.restore();
}
function hline(g, x, y, len, p, w = 1) { if (p <= 0) return; g.fillStyle = C.ink; g.fillRect(x, y, len * p, w); }

// —— 第 1–2 小节：1-2-3-4 阶梯。第 1 小节每拍落下一格（镜头同拍拉出一级）；
// 正在发声的那一拍是墨色，其余退成浅灰（第二声部）；第 2 小节墨色沿阶梯每拍前进一格，像步进音序器 ——
const INK = [[0, 0], [0.5, 1], [1, 2], [1.5, 3], [2, 0], [2.5, 1], [3, 2], [3.5, 3]];   // [落点, 格]
function drawStair(g, t, sy) {
  for (let k = 0; k < 4; k++) {
    const c = CELL(k), ch = String(k + 1), ta = T.count[k];
    if (t < ta - E8) continue;
    if (sy !== 1) { drawDigit(g, ch, c.x, c.base, c.capH, 0, sy, k === 3 ? C.ink : C.ghost); continue; }
    if (t < ta) {                                   // 第一次出现：墨色数字从格子底边裁切升起
      const p = snap(t, ta, E8);
      g.save(); g.beginPath(); g.rect(c.x - c.capH, c.base - c.capH - 2, c.capH * 3, c.capH + 4); g.clip();
      drawDigit(g, ch, c.x, c.base, c.capH, (1 - p) * c.capH * 1.2); g.restore(); continue;
    }
    drawDigit(g, ch, c.x, c.base, c.capH, 0, 1, C.ghost);
    for (let j = 0; j < INK.length; j++) {
      if (INK[j][1] !== k) continue;
      const ts = INK[j][0], te = j + 1 < INK.length ? INK[j + 1][0] : Infinity;
      if (t < ts - E8 || t >= te) continue;
      const pin = ts === ta ? 1 : snap(t, ts, E8), pout = te === Infinity ? 0 : snap(t, te, E8);
      if (pin <= 0 || pout >= 1) continue;
      const top = c.base - c.capH - 4, H = c.capH + 8, y0 = top + H * (1 - pin), y1 = top + H * (1 - pout);   // 进：自下擦上；出：向上收走
      if (y1 <= y0) continue;
      g.save(); g.beginPath(); g.rect(c.x - c.capH, y0, c.capH * 3, y1 - y0); g.clip();
      drawDigit(g, ch, c.x, c.base, c.capH); g.restore();
    }
  }
}

// —— 网格（世界坐标，周期延伸；第 1 小节按距离由近及远线性生长）——
function drawGrid(g, M, t, color = C.grid) {
  const Mi = inv(M), cs = [ap(Mi, 0, 0), ap(Mi, 1920, 0), ap(Mi, 0, 1080), ap(Mi, 1920, 1080)];
  const xmin = Math.min(...cs.map(c => c[0])), xmax = Math.max(...cs.map(c => c[0])), ymin = Math.min(...cs.map(c => c[1])), ymax = Math.max(...cs.map(c => c[1]));
  setM(g, M); g.fillStyle = color; const lw = 1 / scl(M);
  const ax = 96 + 0.35 * 444, ay = rowY(0) + 222, grow = t < 2, V = 4000;
  const len = (d, per) => { const ts = E16 * Math.min(7, Math.floor(d / per)); return grow ? Math.max(0, t - ts) * V : 1e6; };
  for (let k = Math.floor((xmin - 96) / 146) - 1; k <= Math.ceil((xmax - 96) / 146) + 1; k++) for (const x of [colX(k), colX(k) + 122]) {
    const L = len(Math.abs(x - ax), 146); if (L <= 0) continue;
    const y0 = Math.max(ymin, ay - L), y1 = Math.min(ymax, ay + L); if (y1 > y0) g.fillRect(x - lw / 2, y0, lw, y1 - y0);
  }
  for (let k = Math.floor((ymin - 84) / 156) - 1; k <= Math.ceil((ymax - 84) / 156) + 1; k++) for (const y of [rowY(k), rowY(k) + 132]) {
    const L = len(Math.abs(y - ay), 156); if (L <= 0) continue;
    const x0 = Math.max(xmin, ax - L), x1 = Math.min(xmax, ax + L); if (x1 > x0) g.fillRect(x0, y - lw / 2, x1 - x0, lw);
  }
}

// —— TEMPO：每个字母 2×4 模块，上半在第一拍、下半在第二拍 ——
// r: 0 顶行 … 3 底行。底行先落（L），第 2 行 L+16 分，第 1 行 L+0.5，顶行 L+0.5+16 分
function drawWord(g, M, t, full = false) {
  setM(g, M); font(g, 800, W.F); g.fillStyle = C.ink;
  const mh = (W.mBot - W.mTop) / 4, ov = 0.75 / scl(M);
  W.letters.forEach((L, i) => {
    const done = full || t >= T.letters[i] + 0.5 + E16;
    if (done) { g.fillText(L.ch, L.X, W.BY); return; }
    const bw = (L.x1 - L.x0 + 12) / 2, bx = L.x0 - 6;
    for (let r = 0; r < 4; r++) {
      const land = [T.letters[i], T.letters[i] + E16, T.letters[i] + 0.5, T.letters[i] + 0.5 + E16][r];   // 顶行先落：T 的横画第一拍就读得出
      const p = snap(t, land, E16); if (p <= 0) continue;
      const off = (1 - p) * mh, y = W.mTop + r * mh;
      for (let c = 0; c < 2; c++) {
        const x = bx + c * bw;
        g.save(); g.beginPath(); g.rect(x - ov, y - ov, bw + 2 * ov, mh + 2 * ov); g.clip();
        g.beginPath(); g.rect(x - ov, y + off - ov, bw + 2 * ov, mh + 2 * ov); g.clip();
        g.fillText(L.ch, L.X, W.BY + off); g.restore();
      }
    }
  });
}

// —— 海报（最终坐标）——
const POST = { title: [170, 74, 34, 700], date: [170, 110, 22, 500], venue: [170, 136, 14, 500], num: [170, 716, 420] };
function posterXY(t, k, u, v) { return ap(cam3(t), PX(k) + u, PY + v); }
function drawPosterStatic(g, t, k, clipH) {     // 第 1–3 张：同一程序生成，无红点
  const c3 = cam3(t), s = scl(c3), [x0, y0] = ap(c3, PX(k), PY), w = PW * s, h = PH * s * clipH;
  if (h <= 0.5) return;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.beginPath(); g.rect(x0, y0, w, h); g.clip();
  g.fillStyle = C.paper; g.fillRect(x0, y0, w, PH * s);
  const M = mul(c3, PCAM(k)); drawGrid(g, M, 99); drawWord(g, M, 99, true);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const [nx, nb] = posterXY(t, k, POST.num[0], POST.num[1]); drawDigit(g, String(k), nx, nb, POST.num[2] * s);
  for (const key of ['title', 'date', 'venue']) { const [u, v, size, wt] = POST[key], [x, y] = posterXY(t, k, u, v); font(g, wt, size * s); g.fillStyle = C.ink; g.fillText(TXT[key], x, y); }
  g.restore();
}

// —— 页边文字（原始文案；结尾重排进海报）——
const HUD = {
  title: { s: () => TXT.title, x: 96, y: 52, size: 19, w: 700, poster: 'title' },
  bpm: { s: () => TXT.bpm, x: colX(3), y: 52, size: 19, w: 500 },
  date: { s: () => TXT.date, x: colX(8), y: 1058, size: 19, w: 500, poster: 'date' },
  venue: { s: () => TXT.venue, x: colX(10), y: 1058, size: 19, w: 500, poster: 'venue' },
};
const NOTE_Y = [760, 812, 864, 916], RO_Y = 656;     // RO_Y：红点读数行（注释列上方两行）
function hudPos(t, h) {             // → [x, y, size]
  if (!h.poster || t < T.reflow[2] - E16) return [h.x, h.y, h.size];
  const [u, v, size] = POST[h.poster], [tx, ty] = posterXY(t, 4, u, v), s = scl(cam3(t)), p = pReflow(t, 2);
  return [lerp(h.x, tx, p), lerp(h.y, ty, p), lerp(h.size, size * s, p)];
}
function notePos(t, i) {
  const p = E(seg(t, T.pullOut[0], T.pullOut[1]));
  return [lerp(colX(10), PX(i + 1), p), lerp(NOTE_Y[i], 966, p)];
}

// ================= 每一帧 =================
export function renderFilm(g, t) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over';
  g.fillStyle = C.page; g.fillRect(0, 0, 1920, 1080);
  const M = worldM(t);

  // 1) 纸 + 网格
  let paperRect = null;                 // 屏幕坐标的四角（用于裁切）
  if (t < T.rot[0]) { g.fillStyle = C.paper; g.fillRect(0, 0, 1920, 1080); drawGrid(g, M, t); }
  else {
    let poly;
    if (t < T.dotLand) {
      const p = E(seg(t, T.rot[0], T.rot[1])), big = [-4000, -4000, 5920, 5080];
      const r = [lerp(big[0], 0, p), lerp(big[1], 0, p), lerp(big[2], 1920, p), lerp(big[3], 1080, p)];
      poly = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map(q => ap(M, q[0], q[1]));
    } else {
      const p = pReflow(t, 0), c3 = cam3(t), [a0, b0] = ap(c3, PX(4), PY), [a1, b1] = ap(c3, PX(4) + PW, PY + PH);
      const r = [lerp(96, a0, p), lerp(60, b0, p), lerp(636, a1, p), lerp(1020, b1, p)];
      poly = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
    }
    paperRect = poly;
    g.setTransform(1, 0, 0, 1, 0, 0); g.beginPath(); poly.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.closePath();
    g.fillStyle = C.paper; g.fill();
    g.save(); g.clip(); drawGrid(g, M, t); g.restore();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);

  // 2) 另外三张海报（只在拉出镜头里画）
  if (t >= T.pullOut[0]) T.posters.forEach((tl, j) => drawPosterStatic(g, t, 3 - j, E(seg(t, tl - E8, tl))));

  // 3) 红点（在所有黑色元素之下：黑字压在红上 = 叠印）
  const dot = dotAt(t);
  if (dot) { g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = C.red; g.beginPath(); g.arc(dot[0], dot[1], dot[2], 0, Math.PI * 2); g.fill(); }

  // 4) 世界层黑色：第 1–2 小节的数字、knife、TEMPO
  if (t < T.knife[2]) {
    setM(g, M);
    const sy = t < T.knife[1] ? 1 : 1 - E(seg(t, T.knife[1], T.knife[2]));
    drawStair(g, t, sy);
    if (t >= T.knife[0]) {          // knife：沿对角线划过四个数字
      const ctr = k => { const c = CELL(k), ch = String(k + 1); return [c.x + (D[ch].abr + D[ch].abl) * c.capH / D[ch].asc / 2, c.base - c.capH / 2]; };
      const a = ctr(0), b = ctr(3), L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      const p0 = [a[0] - u[0] * 260, a[1] - u[1] * 260], p1 = [b[0] + u[0] * 260, b[1] + u[1] * 260];
      const h = seg(t, T.knife[0], T.knife[1]), tl = seg(t, T.knife[1], T.knife[2]);
      const s0 = [lerp(p0[0], p1[0], tl), lerp(p0[1], p1[1], tl)], s1 = [lerp(p0[0], p1[0], h), lerp(p0[1], p1[1], h)];
      g.strokeStyle = C.ink; g.lineWidth = 2 / scl(M); g.beginPath(); g.moveTo(s0[0], s0[1]); g.lineTo(s1[0], s1[1]); g.stroke();
    }
  }
  if (t >= T.letters[0] - E16) drawWord(g, M, t);
  g.setTransform(1, 0, 0, 1, 0, 0);

  // 5) 巨大数字（加速段起；结尾重排进第 4 张海报并被纸边裁切）
  if (t >= T.big[0][0] - E8) {
    if (t < T.dotLand) {
      setM(g, t < 12.5 ? cam2(t) : I);
      const pOut = snap(t, T.dotLand, E8);          // 红点落地那一拍，巨大的 4 向上离开裁切框，给重排让路
      if (pOut <= 0) digitBox(g, digitSeq(t, T.big), BIG.x, BIG.base, BIG.capH);
      else {
        g.save(); g.beginPath(); g.rect(BIG.x - BIG.capH, BIG.base - BIG.capH - 2, BIG.capH * 3, BIG.capH + 4); g.clip();
        drawDigit(g, '4', BIG.x, BIG.base, BIG.capH, -pOut * BIG.capH * 1.2); g.restore();
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
    } else if (t >= T.reflow[1] - E16) {            // 书脊落定之后，4 在海报框里自下裁切升起
      const p = pReflow(t, 1), h = POST.num[2] * scl(cam3(t)), [tx, tb] = posterXY(t, 4, POST.num[0], POST.num[1]);
      g.save();
      if (paperRect) { g.beginPath(); paperRect.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.closePath(); g.clip(); }
      g.beginPath(); g.rect(tx - h, tb - h - 2, h * 3, h + 4); g.clip();
      drawDigit(g, '4', tx, tb, h, (1 - p) * h * 1.2); g.restore();
    }
  }

  // 6) 页边文字
  const pH = snap(t, T.hud, E16);
  hline(g, 96, 26, 1728, seg(t, T.hud - E8, T.hud)); hline(g, 96, 1030, 1728, seg(t, T.hud - E8, T.hud));
  for (const key in HUD) { const h = HUD[key], [x, y, size] = hudPos(t, h); riseText(g, h.s(), x, y, size, h.w, pH); }
  // 小节计数（12–17 冻结在 07：系统停摆时例外在拍子之外）
  const bar = t < 12 ? Math.floor(t / 2) + 1 : t < 17 ? 7 : t < 18 ? 9 : 10;
  const barT = t < 12 ? Math.floor(t / 2) * 2 : t < 17 ? 12 : t < 18 ? 17 : 18;
  riseText(g, TXT.barLabel, colX(10), 52, 19, 500, pH);
  if (t >= T.hud - E16) {
    const pb = barT >= 2 ? snap(t, barT, E16) : 1, prevBar = bar === 9 ? 7 : bar - 1, cur = String(bar).padStart(2, '0') + ' / 10';
    if (pb < 1 && barT > 2) riseText(g, String(prevBar).padStart(2, '0') + ' / 10', colX(10) + 48, 52, 19, 500, 1, pb);
    riseText(g, cur, colX(10) + 48, 52, 19, 500, barT > 2 ? pb : pH);
  }
  // 左下拍点方块
  if (t >= T.hud - E16) {
    let act = -1;
    if (t < 9) act = Math.floor(t / 0.5) % 4;
    else if (t < 12) { const s = digitSeq(t, T.big); act = s.cur ? +s.cur - 1 : 3; }
    else if (t < 17) act = 3; else if (t < 18) act = Math.floor((t - 17) / 0.5) % 4;
    for (let k = 0; k < 4; k++) {
      const x = 96 + k * 22, y = 1040, on = t >= 18 || k === act;
      g.fillStyle = C.ink; if (on) g.fillRect(x, y, 14, 14 * pH); else { g.fillRect(x, y, 14, 1); g.fillRect(x, y + 13, 14, 1); g.fillRect(x, y, 1, 14); g.fillRect(x + 13, y, 1, 14); }
    }
  }
  // 右栏注释（加速段）→ 结尾移到四张海报下面
  T.notes.forEach((tn, i) => {
    if (t < tn - E8) return;
    const [x, y] = notePos(t, i);
    hline(g, x, y - 26, 228, seg(t, tn - E8, tn));
    riseText(g, TXT.notes[i], x, y, 19, 500, snap(t, tn, E16));
  });
  // "休止"：全停时出现，红点落地时被 knife cut
  if (t >= T.rest - E16 && t < T.restCut[2]) {
    const sy = t < T.restCut[1] ? 1 : 1 - E(seg(t, T.restCut[1], T.restCut[2]));
    if (sy === 1) riseText(g, TXT.rest, colX(10), 120, 30, 700, snap(t, T.rest, E16));
    else { g.save(); g.translate(0, 110); g.scale(1, sy); g.translate(0, -110); font(g, 700, 30); g.fillStyle = C.ink; g.fillText(TXT.rest, colX(10), 120); g.restore(); }
    if (t >= T.restCut[0]) { const h = seg(t, T.restCut[0], T.restCut[1]), tl = seg(t, T.restCut[1], T.restCut[2]); g.fillStyle = C.ink; g.fillRect(colX(10) - 20 + tl * 110, 109, (h - tl) * 110, 2); }
  }

  // 7) 红点读数（例外：数值不是整数）。放在右栏注释列上方的固定注释行里（亮底、19 px），数值跟着红点实时走；
  //    红点中心画一个细十字，标出读数量的是哪一点。红点落地时和"休止"一起被 knife cut
  if (dot && t < T.restCut[2]) {
    const lt = Math.min(t, T.dotLand), d0 = dotAt(lt), col = (d0[0] - 96) / 146, row = (d0[1] - 84) / 156;
    const x = colX(10), y1 = RO_Y, y2 = RO_Y + 26, pin = snap(t, T.dotIn + E16, E16);
    const sy = t < T.restCut[1] ? 1 : 1 - E(seg(t, T.restCut[1], T.restCut[2])), mid = RO_Y - 2;
    g.save();
    if (sy !== 1) { g.translate(0, mid); g.scale(1, sy); g.translate(0, -mid); }
    hline(g, x, y1 - 26, 228, seg(t, T.dotIn, T.dotIn + E16));
    riseText(g, `${TXT.except} · ${TXT.off}`, x, y1, 19, 700, pin);
    riseText(g, `${TXT.colw} ${col.toFixed(2)}    ${TXT.roww} ${row.toFixed(2)}`, x, y2, 19, 500, pin);
    g.restore();
    if (t >= T.restCut[0]) { const h = seg(t, T.restCut[0], T.restCut[1]), tl = seg(t, T.restCut[1], T.restCut[2]); g.fillStyle = C.ink; g.fillRect(x - 20 + tl * 270, mid - 1, (h - tl) * 270, 2); }
    if (t < T.dotLand) { g.fillStyle = C.ink; g.fillRect(dot[0] - 20, dot[1] - 1, 40, 2); g.fillRect(dot[0] - 1, dot[1] - 20, 2, 40); }
  }
}

// —— 可读性检查用：每个可见文字的屏幕框 ——
export function texts(t) {
  const out = [], cvs = document.createElement('canvas').getContext('2d');
  const box = (id, s, x, y, size, w) => { font(cvs, w, size); out.push({ id, text: s, x0: x, y0: y - size, x1: x + cvs.measureText(s).width, y1: y + size * 0.25 }); };
  if (t >= T.hud) for (const key in HUD) { const h = HUD[key], [x, y, size] = hudPos(t, h); box(key, h.s(), x, y, size, h.w); }
  T.notes.forEach((tn, i) => { if (t >= tn) { const [x, y] = notePos(t, i); box('note' + i, TXT.notes[i], x, y, 19, 500); } });
  if (t >= T.rest && t < T.restCut[1]) box('rest', TXT.rest, colX(10), 120, 30, 700);
  if (t >= 12) {                       // 书脊 TEMPO（推进结束后才完整入画）
    const M = worldM(t), q = [[96, W.mTop], [1824, W.mTop], [96, W.mBot], [1824, W.mBot]].map(p => ap(M, p[0], p[1]));
    out.push({ id: 'word', text: TXT.word, x0: Math.min(...q.map(p => p[0])), y0: Math.min(...q.map(p => p[1])), x1: Math.max(...q.map(p => p[0])), y1: Math.max(...q.map(p => p[1])) });
  }
  return out;
}

// —— 拟音/核对事件（window.EV）——
export function buildEvents() {
  const ev = [], add = (t, type, o = {}) => ev.push({ t: +t.toFixed(6), type, snap: o.exc ? 0 : 1, ...o });
  // 第 1 小节
  T.count.forEach((tc, i) => add(tc, 'thunk', { g: i ? 0.8 : 1 }));
  T.pull.slice(1).forEach(([tp]) => add(tp, 'slide', { d: E8 }));
  for (let k = 0; k < 8; k++) add(k * E16, 'tss', { g: 1 - k * 0.07 });
  // 第 2 小节
  add(T.hud, 'type', { g: 0.8 }); add(T.hop[0], 'thunk', { g: 0.7 });
  T.hop.slice(1).forEach((th, i) => add(th, 'block', { p: 1 + 0.12 * (i + 1) }));
  add(T.knife[1], 'knife', { d: T.knife[1] - T.knife[0] }); add(T.knife[2], 'collapse');
  // TEMPO
  T.pans.forEach(tp => add(tp, 'slide', { d: E8, g: 0.7 }));
  T.letters.forEach((L, i) => { add(L, 'clack', { big: 1, i }); add(L + E16, 'clack', { i }); add(L + 0.5, 'clack', { big: 1, i }); add(L + 0.5 + E16, 'clack', { i }); });
  add(T.rot[1], 'slide', { d: T.rot[1] - T.rot[0], g: 1.2 }); add(T.rot[1], 'paper');
  // 加速
  T.big.forEach(([tb], i) => add(tb, 'thunk', { g: i < 4 ? 1 : i < 8 ? 0.85 : 0.75, big: 1 }));
  T.push.forEach(([a, b]) => add(b, 'slide', { d: b - a, g: 0.9 }));
  T.notes.forEach(tn => add(tn, 'type', { g: 0.7 }));
  add(T.stop, 'stop');
  // 例外
  add(T.dotIn, 'felt', { g: 1, first: 1 }); add(T.dotIn + E16, 'readout', { g: 0.5 });
  for (const e of touches()) add(e.t, 'touch', { exc: 1, i: e.i });
  add(T.dotLand, 'felt', { g: 0.8 }); add(T.restCut[1], 'knife', { d: E8, g: 0.6 }); add(T.restCut[2], 'collapse', { g: 0.6 });
  // 锁版
  add(T.reflow[0], 'block', { p: 1.0 }); add(T.reflow[1], 'block', { p: 0.9 }); add(T.reflow[1], 'snick'); add(T.reflow[2], 'block', { p: 1.2 });
  T.posters.forEach(tp => add(tp, 'paper', { g: 0.8 }));
  add(T.pullOut[1], 'slide', { d: T.pullOut[1] - T.pullOut[0], g: 1.1 }); add(T.lock, 'stamp');
  for (let b = 4; b <= 10; b += 2) add(b, 'tick', { g: 0.5 });        // 小节计数翻页（12 由全停那一下盖住）
  add(17, 'tick', { g: 0.5 }); add(18, 'tick', { g: 0.5 });
  ev.push({ t: T.dotIn, type: 'dotpath', snap: 0, pts: DOTP });
  ev.sort((a, b) => a.t - b.t);
  return ev;
}
function touches() {                    // 红点第一次碰到每个元素的时刻（例外：不卡拍）
  const els = [];
  T.notes.forEach((tn, i) => els.push([colX(10) - 2, NOTE_Y[i] - 26, colX(10) + 230, NOTE_Y[i] + 6]));
  const d4 = D['4'], F4 = BIG.capH / d4.asc; els.push([BIG.x, BIG.base - BIG.capH, BIG.x + (d4.abr + d4.abl) * F4, BIG.base]);
  const M = CAMC();
  W.letters.forEach(L => { const a = ap(M, L.x0, L.top), b = ap(M, L.x1, L.bot); els.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]); });
  const hit = new Array(els.length).fill(false), out = [];
  for (let t = T.dotIn; t < T.dotLand; t += 0.001) {
    const d = dotAt(t); if (!d) continue;
    els.forEach((r, i) => {
      if (hit[i]) return;
      const nx = clamp(d[0], r[0], r[2]), ny = clamp(d[1], r[1], r[3]);
      if (Math.hypot(d[0] - nx, d[1] - ny) < d[2]) { hit[i] = true; out.push({ t, i }); }
    });
  }
  return out.filter(e => e.t > T.dotIn + 0.05);
}
export { DUR };
