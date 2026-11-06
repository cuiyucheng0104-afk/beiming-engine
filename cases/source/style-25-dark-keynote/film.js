// film.js — 《Lumen》全部镜头。render(t) 确定性：只依赖 t 与 timeline.js，不读上一帧状态。
import * as E from './engine.js';
import { PAL, W, H, clamp, lerp, seg, ss, eo, ei, eio, back, hash, mulberry, TAU, rgba, mixc, font } from './engine.js';
import { BEAT, BAR, DUR, K, KB, bt, animT, NDOTS, dotNotes, gridTicks, VIEWS } from './timeline.js';
import { monotone } from '/core/lib.js';
export { DUR };

const F = 1 / 24;
const R0 = 280;                     // 主灯半径（世界单位，zoom 1 时 = 像素）
const pow5 = u => 1 - Math.pow(1 - clamp(u), 5);   // 展开：节拍帧已经打开约 80%
const NOTES = dotNotes();

// ── 点阵：向日葵叶序（黄金角），点亮时间来自音符表 ──
const DOTS = [];
for (let i = 0; i < NDOTS; i++) { const r = 0.86 * Math.sqrt((i + 0.5) / NDOTS), a = i * 2.399963 + 0.4; DOTS.push([r * Math.cos(a), r * Math.sin(a)]); }
const LIT_T = new Float64Array(NDOTS).fill(K.snap);
{ let p = 0; for (const n of NOTES) { for (let i = p; i < n.upto; i++) LIT_T[i] = n.t; p = Math.max(p, n.upto); } }
const breath = (t, t0 = K.lit) => 0.5 + 0.5 * Math.cos(TAU * (t - t0) / BAR);

// ── 摄影机（唯一 世界→屏幕） ──
const thetaAt = t => Math.PI + TAU * (0.72 * seg(t, K.traceGo, K.traceEnd) + 0.28 * ss(seg(t, K.traceGo, K.traceEnd)));
const ring = (th, k = 1) => [Math.cos(th) * R0 * k, Math.sin(th) * R0 * k];
const L = Math.log;
const pullBack = monotone([[bt(9), L(2.4)], [bt(10), L(2.0)], [bt(12), L(1.42)], [bt(13.5), L(1.12)], [bt(14.5), L(1.0)]]);
// 一拍甩出的进度（时间→进度）：b14.5 前一帧反向预备 4%，拍点帧已走 8%，前三帧只到 30%，
// 之后加速，落格前过冲 3.5%，b15 那一帧正好落定。三份分身错开半帧/一帧出发，同时落格。
const WHIP0 = K.split - F;
const WHIPK = [[WHIP0, -0.04], [K.split, 0.08], [K.split + F, 0.18], [K.split + 2 * F, 0.30], [K.split + 4 * F, 0.68], [K.split + 6 * F, 1.035], [K.snap - F, 1.02], [K.snap, 1.0]];
const _wq = monotone(WHIPK);
const whipQ = t => (t <= WHIP0 ? WHIPK[0][1] : t >= K.snap ? 1 : _wq(t));
const WHIP_D = { watch: 0, desk: 0.5 * F, phone: F };
const whipQV = (id, t) => { const d = WHIP_D[id] || 0, span = K.snap - WHIP0; return whipQ(WHIP0 + Math.max(0, t - WHIP0 - d) * span / (span - d)); };
const copyA = q => ss(seg(q, 0, 0.3));
let NUM = null;                     // 数字排版（字体加载后测量）
export function layout(g) {
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  const px = 500, tr = -0.045 * px; g.font = font(px, 600, 'disp');
  const text = '0.3 W', ws = [...text].map(c => g.measureText(c).width);
  const total = ws.reduce((a, b) => a + b, 0) + tr * (text.length - 1);
  let x = -total / 2; const chars = [];
  [...text].forEach((c, i) => { chars.push({ c, x, w: ws[i], cx: x + ws[i] / 2 }); x += ws[i] + tr; });
  const base = 150, capH = px * 0.727, ymid = base - capH / 2;
  g.font = font(210, 600, 'ui'); const wmW = g.measureText('Lumen').width;
  g.restore();
  const z0 = chars[0], RF = 190, wmX = z0.cx + RF + 96, gx = (z0.cx - RF + wmX + wmW) / 2;
  NUM = { px, tr, chars, base, capH, ymid, total, RF, lampX: z0.cx, wmX, wmW, gx };
  return NUM;
}
function camAt(t) {
  const N = NUM;
  if (t < K.traceEnd) {
    const th = thetaAt(t) - 0.09, [x, y] = ring(th, 1 - 38 / R0);   // 边缘落在画面上 1/3 与中线之间
    return E.camera({ x, y, zoom: 3.6, rot: -(th + Math.PI / 2) });
  }
  if (t < K.pullEnd) {
    const u = eio(seg(t, K.traceEnd, K.pullEnd)), th = thetaAt(K.traceEnd) - 0.09, [x, y] = ring(th, 1 - 38 / R0);
    const rot0 = -(th + Math.PI / 2), rot1 = -4 * Math.PI;
    return E.camera({ x: lerp(x, 0, u), y: lerp(y, 0, u), zoom: Math.exp(lerp(L(3.6), 0, u)), rot: lerp(rot0, rot1, u) });
  }
  if (t < K.lit) return E.camera({ zoom: lerp(1, 1.04, ss(seg(t, K.pullEnd, K.lit))) });
  if (t < bt(9)) return E.camera({ zoom: Math.exp(lerp(L(1.04), L(2.4), eio(seg(t, K.lit, bt(9))))) });
  if (t < WHIP0) return E.camera({ zoom: Math.exp(pullBack(Math.min(t, K.split))) });
  if (t < K.snap) {   // 一拍甩出：前一帧反向预备，拍点帧起步，带一次过冲
    const q = whipQ(t);
    return E.camera({ x: lerp(0, -180, q), y: lerp(0, 64, q), zoom: Math.exp(lerp(0, L(0.56), q)) });
  }
  if (t < K.crt) {    // 落格后：缓慢横移 + 推近，让三视图读得清
    const u = seg(t, K.snap, K.crt);
    return E.camera({ x: -180 + 90 * u, y: 64, zoom: Math.exp(lerp(L(0.56), L(0.63), eio(seg(t, K.snap + 0.1, K.crt)))) });
  }
  if (t < K.burst) { const u = ss(seg(t, K.crt, K.burst)); return E.camera({ x: lerp(-90, 0, u), y: lerp(64, 0, u), zoom: Math.exp(lerp(L(0.63), 0, u)) }); }
  const x3 = N.chars[2].cx, ym = N.ymid;
  if (t < K.freeze) return E.camera({ zoom: lerp(1, 1.015, seg(t, K.burst, K.freeze)) });
  if (t < K.hit) { const u = eio(seg(t, K.freeze, K.hit)); return E.camera({ x: lerp(0, x3 * 0.8, u), y: lerp(0, ym * 0.6, u), zoom: lerp(1.015, 1.22, u) }); }
  if (t < K.hit + 0.5) { const q = back(seg(t, K.hit - F, K.hit + 0.42), 1.3); return E.camera({ x: lerp(x3 * 0.8, 0, q), y: lerp(ym * 0.6, 0, q), zoom: lerp(1.22, 1.0, q) }); }   // 回弹从落定帧就开始（拍点帧已走约 35%）
  if (t < K.put1) return E.camera({ zoom: lerp(1.0, 1.035, ss(seg(t, K.hit + 0.5, K.put1))) });
  if (t < K.name) return E.camera({ zoom: 1.035 });
  const u = eio(seg(t, K.name, bt(27)));
  return E.camera({ x: lerp(0, N.gx, u), y: 0, zoom: lerp(1.035, 1.0, u) + 0.035 * ss(seg(t, bt(27), DUR)) });
}

// ── 灯（屏幕里的一盏灯：圆形 UI 元素 + 点阵像素光） ──
function drawLamp(g, cx, cy, R, o = {}) {
  const { ta = 0, px = 1, housing = 1, litUntil = -1, allLit = false, br = 1, glowK = 1, unlitA = 0.075, alpha = 1 } = o;
  if (alpha <= 0.001) return 0;
  g.save(); g.globalAlpha *= alpha; const A = g.globalAlpha;
  const lw = 1 / px;
  let nLit = 0; for (let i = 0; i < NDOTS; i++) if (allLit || LIT_T[i] <= litUntil) nLit++;
  const frac = nLit / NDOTS;
  if (frac > 0 && glowK > 0) {   // 舞台上的呼吸光
    g.save(); g.globalCompositeOperation = 'lighter';
    E.glow(g, cx, cy, R * 2.1, PAL.accent, (0.05 + 0.13 * frac) * (0.55 + 0.45 * br) * glowK);
    g.restore();
  }
  if (housing > 0) {
    g.save(); g.globalAlpha *= housing;
    g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = Math.min(80, 40 * R / 280 * px); g.shadowOffsetY = 14 * R / 280 * px;
    const gr = g.createLinearGradient(0, cy - R, 0, cy + R); gr.addColorStop(0, '#272C3A'); gr.addColorStop(0.4, PAL.surf2); gr.addColorStop(1, PAL.surf);
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill(); g.shadowColor = 'transparent';
    g.lineWidth = lw; g.strokeStyle = 'rgba(255,255,255,.12)'; g.stroke();
    g.fillStyle = '#0C0E14'; g.beginPath(); g.arc(cx, cy, R * 0.93, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.stroke();
    g.restore();
  }
  const d = R * 0.0185, minR = 0.9 / px;
  // 未点亮的像素
  g.fillStyle = `rgba(255,255,255,${unlitA})`; g.beginPath();
  for (let i = 0; i < NDOTS; i++) { if (allLit || LIT_T[i] <= litUntil) continue; const [x, y] = DOTS[i]; g.moveTo(cx + x * R + Math.max(d, minR), cy + y * R); g.arc(cx + x * R, cy + y * R, Math.max(d, minR), 0, TAU); }
  g.fill();
  if (!nLit) { g.restore(); return frac; }
  // 点亮的像素：内核 + 辉光（加色）
  const spr = E.sprite(PAL.accent), bk = 0.62 + 0.38 * br;
  g.save(); g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < NDOTS; i++) {
    const lt = allLit ? -1e9 : LIT_T[i]; if (!allLit && lt > litUntil) continue;
    const age = ta - lt, s = age < 0.14 ? back(age / 0.14, 2.2) : 1;
    const [x, y] = DOTS[i], X = cx + x * R, Y = cy + y * R, gs = d * 9 * s * (0.85 + 0.25 * br);
    g.globalAlpha = A * 0.42 * bk * (age < 0.08 ? 1.6 : 1); g.drawImage(spr, X - gs / 2, Y - gs / 2, gs, gs);
  }
  g.restore();
  g.fillStyle = mixc('#FFD9B8', PAL.accent, 0.55); g.beginPath();
  for (let i = 0; i < NDOTS; i++) {
    const lt = allLit ? -1e9 : LIT_T[i]; if (!allLit && lt > litUntil) continue;
    const age = ta - lt, s = age < 0.14 ? back(age / 0.14, 2.2) : 1; const [x, y] = DOTS[i], rr = Math.max(d * 1.05 * s, minR);
    g.moveTo(cx + x * R + rr, cy + y * R); g.arc(cx + x * R, cy + y * R, rr, 0, TAU);
  }
  g.fill();
  // 刚点亮的两帧：白色闪
  g.fillStyle = 'rgba(255,226,200,.85)'; g.beginPath(); let any = false;
  for (let i = 0; i < NDOTS; i++) { if (allLit) break; const age = ta - LIT_T[i]; if (age < 0 || age >= 2 * F) continue; any = true; const [x, y] = DOTS[i]; g.moveTo(cx + x * R + d * 1.4, cy + y * R); g.arc(cx + x * R, cy + y * R, d * 1.4, 0, TAU); }
  if (any) g.fill();
  g.save(); g.globalCompositeOperation = 'lighter'; E.glow(g, cx, cy, R * 0.55, PAL.accent, 0.16 * frac * bk); g.restore();
  g.restore();
  return frac;
}
// 沿边缘走的光（冷白，不是强调色）
function drawTrace(g, cx, cy, R, th0, th1, px, keep = 0.3, headA = 1) {
  if (th1 <= th0) return;
  const lw = 2.4 / px, n = Math.max(8, Math.ceil((th1 - th0) * 40));
  g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
  for (let k = 0; k < n; k++) {
    const a0 = th0 + (th1 - th0) * k / n, a1 = th0 + (th1 - th0) * (k + 1) / n, back_ = th1 - a1;
    const a = keep + (1 - keep) * Math.exp(-back_ / 0.55) * headA;
    g.strokeStyle = rgba(PAL.light, a); g.lineWidth = lw * (1 + 1.2 * Math.exp(-back_ / 0.25) * headA);
    g.beginPath(); g.arc(cx, cy, R, a0, a1 + 0.002); g.stroke();
  }
  if (headA > 0) { const hx = cx + Math.cos(th1) * R, hy = cy + Math.sin(th1) * R; E.glow(g, hx, hy, 100 / px, PAL.light, 0.5 * headA); E.glow(g, hx, hy, 16 / px, '#FFFFFF', 0.9 * headA); }
  g.restore();
}

// ── 三视图窗口 ──
function viewGeom(v) {
  const bar = v.id === 'watch' ? 0 : 76, LR = 0.36 * Math.min(v.w, v.h - bar);
  return { bar, LR, lx: v.x + v.w / 2, ly: v.y + bar + (v.h - bar) / 2 };
}
function viewPose(v, t) {
  const G = viewGeom(v), q = whipQV(v.id, t), m = ss(seg(clamp(q), 0.05, 0.9)), cA = copyA(q);
  const C = [G.lx / 2, G.ly / 2 - 420], bz = (u, a, c, b) => (1 - u) * (1 - u) * a + 2 * (1 - u) * u * c + u * u * b;
  const lx = bz(q, 0, C[0], G.lx), ly = bz(q, 0, C[1], G.ly), LR = lerp(R0, G.LR, m);
  const wx = lerp(lx, v.x + v.w / 2, m) + (G.lx === lx ? 0 : 0), wy = lerp(ly, v.y + v.h / 2, m);
  const ww = lerp(2 * R0, v.w, m), wh = lerp(2 * R0, v.h, m), r = lerp(R0, v.r, m);
  // 落格后窗中心 = 灯中心 + (窗心 − 灯心)
  const cxw = lx + (v.x + v.w / 2 - G.lx) * m, cyw = ly + (v.y + v.h / 2 - G.ly) * m;
  return { ...G, m, q, cA, lx, ly, LR, wx: cxw, wy: cyw, ww, wh, r };
}
function drawView(g, v, t, ta, cam) {
  const P = viewPose(v, t), px = cam.zoom;
  // CRT 压扁：先纵向成一条线，再横向收成一点，点飞向中心
  const cy_ = 1 - ei(seg(t, K.crt, K.crt + 0.1)), cx_ = 1 - eio(seg(t, K.crt + 0.1, K.burst - 2 * F)), mv = eio(seg(t, K.crt + 0.06, K.burst - 2 * F));
  const ox = -P.wx * mv, oy = -P.wy * mv;
  g.save(); g.translate(P.wx + ox, P.wy + oy); g.scale(Math.max(cx_, 0.004), Math.max(cy_, 0.006)); g.translate(-P.wx, -P.wy);
  const x = P.wx - P.ww / 2, y = P.wy - P.wh / 2;
  g.globalAlpha = P.cA;
  if (P.cA > 0.001) E.panel(g, x, y, P.ww, P.wh, { r: P.r, px });
  if (P.bar && P.m > 0) {
    g.save(); g.globalAlpha = P.m * P.cA; const bh = P.bar * P.m;
    g.fillStyle = 'rgba(255,255,255,.025)'; E.rr(g, x + 1, y + 1, P.ww - 2, bh, P.r); g.fill();
    g.fillStyle = PAL.line; g.fillRect(x, y + bh, P.ww, 1 / px);
    g.strokeStyle = PAL.dim; g.lineWidth = 3; g.beginPath(); g.arc(x + 42, y + bh / 2, 13, 0, TAU); g.stroke();   // 产品小字形：一个圆
    g.fillStyle = PAL.text; g.font = font(40, 500, 'ui'); g.letterSpacing = '1px'; g.textBaseline = 'middle'; g.fillText('Lumen', x + 72, y + bh / 2 + 1);
    g.restore();
  }
  // 灯（视图里的）
  g.save(); g.globalAlpha = P.m * P.cA; g.fillStyle = '#0C0E14'; g.beginPath(); g.arc(P.lx, P.ly, P.LR * 1.0, 0, TAU); g.fill(); g.lineWidth = 1 / px; g.strokeStyle = 'rgba(255,255,255,.06)'; g.stroke(); g.restore();
  drawLamp(g, P.lx, P.ly, P.LR * 0.97, { ta, px: px * P.LR / R0, housing: 0, litUntil: ta, allLit: t >= K.snap, br: breath(ta), glowK: 0.8, alpha: P.cA });
  // 标签
  if (P.m > 0) {
    g.save(); g.globalAlpha = P.m * P.cA; g.font = font(64, 500, 'cjk'); g.letterSpacing = '26px'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = mixc(PAL.dim, PAL.text, 0.35);
    g.fillText(v.label, P.wx + 13, P.wy + P.wh / 2 + 112); g.restore();
  }
  g.restore();
  if (cy_ < 1) {   // CRT 线 / 点
    const a = 1 - cy_, lwid = P.ww * cx_ + 10 / px;
    g.save(); g.globalCompositeOperation = 'lighter';
    const gx = P.wx + ox, gy = P.wy + oy;
    g.fillStyle = rgba('#FFE7D6', 0.85 * a); g.fillRect(gx - lwid / 2, gy - 1.5 / px, lwid, 3 / px);
    E.glow(g, gx, gy, (40 + 120 * cx_) / px, PAL.accent, 0.5 * a);
    g.restore();
  }
}

// ── 数字（字形噪声 → 0.3 W） ──
const GL = '0123456789#%/<>+=-×Δ';
const LOCK = [K.lock0, K.lockDot, K.hit, null, K.lockW];
const PUT = [K.put4, K.put3, K.put2, null, K.put1];
const NOISE = (() => { const r = mulberry(25), out = []; for (let j = 0; j < 150; j++) {
  const a = r() * TAU, rad = 0.35 + 0.65 * Math.sqrt(r());
  out.push({ mx: Math.cos(a) * 880 * rad, my: Math.sin(a) * 430 * rad, slot: [0, 1, 2, 2, 2, 4][Math.floor(r() * 6)], sz: 24 + r() * 26, a: 0.16 + r() * 0.34, d: r() * 0.25, s: r() * 1000 });
} return out; })();
function drawNumber(g, t, ta, cam) {
  const N = NUM, px = N.px, open = pow5(seg(t, K.burst - 3 * F, K.burst + 0.1)), sc = lerp(0.03, 1, open);
  g.save(); g.scale(sc, sc);
  const fr = Math.floor(ta * 24);
  // 噪声颗粒：从中心炸开 → 沿同向弧线流回各自的字位 → 落定那一拍被吸进数字
  g.font = font(34, 500, 'mono'); g.textBaseline = 'middle'; g.textAlign = 'center';
  for (let j = 0; j < NOISE.length; j++) {
    const n = NOISE[j], out = eo(seg(ta, K.burst, K.burst + 0.4 + n.d * 0.3));
    let u = seg(ta, K.burst + 0.5 + n.d, K.hit + 0.12); u = u * u * u;
    if (u >= 1) continue;
    const tg = N.chars[n.slot], tx = tg.cx, ty = N.ymid;
    const sx = n.mx * out, sy = n.my * out, cxp = (sx + tx) / 2 - (ty - sy) * 0.35, cyp = (sy + ty) / 2 + (tx - sx) * 0.35;
    const x = (1 - u) * (1 - u) * sx + 2 * (1 - u) * u * cxp + u * u * tx, y = (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * cyp + u * u * ty;
    g.globalAlpha = n.a * (1 - u * 0.6) * open; g.fillStyle = PAL.dim;
    g.font = font(Math.round(n.sz * (1 - 0.6 * u)), 500, 'mono');
    g.fillText(GL[Math.floor(hash(fr * 7.1 + n.s) * GL.length)], x, y);
  }
  g.globalAlpha = 1; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  // 落定后的强调光（呼吸）
  const nLeft = PUT.filter(p => p != null && t < p + 0.13).length;   // 每收起一个字光晕减一档；最后一点（第 415 帧）仍带余光
  if (t >= K.hit) {
    g.save(); g.globalCompositeOperation = 'lighter';
    const c03 = (N.chars[0].x + N.chars[2].x + N.chars[2].w) / 2;
    const k = (0.42 * Math.exp(-(t - K.hit) / 0.45) + 0.12 * (0.6 + 0.4 * breath(t, K.hit))) * (nLeft / 4);
    E.glow(g, c03, N.ymid, 760, PAL.accent, k);
    g.restore();
  }
  g.font = font(px, 600, 'disp');
  N.chars.forEach((ch, i) => {
    if (ch.c === ' ') return;
    const lk = LOCK[i], pt = PUT[i];
    if (t >= pt + 0.13) return;
    const sy = 1 - eo(seg(t, pt - F, pt + 0.06)), sxk = 1 - eo(seg(t, pt + 0.03, pt + 0.11));
    const cyc = N.ymid;
    g.save(); g.translate(ch.cx, cyc); g.scale(Math.max(sxk, 0.01), Math.max(sy, 0.02)); g.translate(-ch.cx, -cyc);
    if (ta < lk) {
      const gch = ch.c === '.' ? '.-+'[Math.floor(hash(fr * 3.3 + i) * 3)] : GL[Math.floor(hash(fr * 13.7 + i * 91.3) * 18)];
      let jx = 0, jy = 0;
      if (ta >= K.lockDot && i === 2) { jx = (hash(fr * 1.7) - 0.5) * 7; jy = (hash(fr * 2.9) - 0.5) * 7; }   // 张力：几像素的颤
      const gw = g.measureText(gch).width;
      for (let k = 0; k < 3; k++) { g.globalAlpha = [0.8, 0.28, 0.12][k]; g.fillStyle = PAL.dim; g.fillText(gch, ch.cx - gw / 2 + jx, N.base - k * px * 0.09 + jy); }
      g.globalAlpha = 1;
    } else {
      const d = ta - lk, dy = d < 0.35 ? -px * 0.1 * Math.exp(-d * 14) * Math.cos(d * 40) : 0;
      const acc = t >= K.hit && i < 3;
      if (acc) { g.shadowColor = rgba(PAL.accent, 0.8); g.shadowBlur = 40 * cam.zoom; }
      g.fillStyle = acc ? PAL.accent : PAL.text; g.fillText(ch.c, ch.x, N.base + dy); g.shadowColor = 'transparent';
      if (acc && t < K.hit + 2 * F) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = t < K.hit + F ? 0.85 : 0.4; g.fillStyle = '#FFFFFF'; g.fillText(ch.c, ch.x, N.base + dy); }
    }
    g.restore();
    if (sy < 1) { const a = 1 - sy; g.save(); g.globalCompositeOperation = 'lighter'; const lwid = ch.w * sxk + 8; g.fillStyle = rgba('#FFE7D6', 0.8 * a); g.fillRect(ch.cx - lwid / 2, cyc - 2, lwid, 4); E.glow(g, ch.cx, cyc, 30 + 80 * sxk, i < 3 ? PAL.accent : PAL.light, 0.5 * a); g.restore(); }
  });
  g.restore();
}

// ── 片尾：小灯 + 字标 ──
function drawName(g, t, cam) {
  const N = NUM, px = cam.zoom, cx = N.lampX, cy = N.ymid;
  if (t < K.name) {   // "0" 收成的最后一个点（CRT-off），下一拍点再展开成灯
    g.save(); g.globalCompositeOperation = 'lighter';
    E.glow(g, cx, cy, 300 / px, PAL.accent, 0.22); E.glow(g, cx, cy, 70 / px, PAL.accent, 0.6);
    g.fillStyle = mixc('#FFD9B8', PAL.accent, 0.35); g.beginPath(); g.arc(cx, cy, 5 / px, 0, TAU); g.fill();
    g.restore(); return;
  }
  const p = seg(t, K.name - 2 * F, K.name + 0.22), R = N.RF * Math.max(0.03, back(p, 1.5));   // 拍点帧已展开约 80%
  drawLamp(g, cx, cy, R, { ta: t, px, housing: 1, allLit: true, br: breath(t, K.name), glowK: 1 });
  const th = Math.PI + TAU * eio(seg(t, K.name, bt(27)));
  if (t > K.name) drawTrace(g, cx, cy, R * 1.0 + 1, Math.PI, th, px, 0.32, 1 - seg(t, bt(27), bt(27) + 0.3));
  // 字标：一道光扫亮
  const [c, gb] = E.buf('wm', W, H); cam.apply(gb);
  gb.font = font(210, 600, 'ui'); gb.fillStyle = PAL.text; gb.textBaseline = 'alphabetic'; gb.letterSpacing = '-4px';
  gb.fillText('Lumen', N.wmX, cy + 76);
  const s0 = cam.proj(N.wmX - 40, cy - 120), s1 = cam.proj(N.wmX + N.wmW + 40, cy + 110);
  E.lightReveal(g, c, seg(t, K.name, K.name + 0.5), { base: 0.05, rect: [s0[0], s0[1], s1[0] - s0[0], s1[1] - s0[1]], soft: 260, band: 90, glint: 0.18 });
  cam.apply(g);
  if (t >= K.label) {
    const q = seg(t, K.label, K.label + 0.22), dy = (1 - back(q, 1.6)) * 18;
    g.save(); g.font = font(46, 500, 'cjk'); g.letterSpacing = '22px'; g.fillStyle = PAL.dim; g.textBaseline = 'alphabetic';
    g.globalAlpha = clamp(q * 4); g.fillText('流明', N.wmX + 10, cy + 176 + dy); g.restore();
  }
}

// ── 整帧 ──
const EPS = 1e-5;   // 拍点时间按 1e-6 s 取整，可能比 f/24 晚半微秒 → 拍点帧会晚一帧。统一加 10 µs，拍点帧即是事件帧
export function renderFilm(g, t) {
  t += EPS;
  if (!NUM) layout(g);
  const ta = animT(t), cam = camAt(t);
  E.stage(g);
  // 网格：吸附那一拍之前不可见；从中心展开，坍缩时收回中心
  if (t >= K.gridGo && t < K.burst) {
    const o = cam.proj(0, 0), rIn = 2300 * eo(seg(t, K.gridGo, K.snap)), rOut = 2300 * (1 - ei(seg(t, bt(17.5), K.burst)));
    E.grid(g, { ox: o[0], oy: o[1], scale: cam.zoom, clipR: Math.min(rIn, rOut) });
  }
  cam.apply(g);
  if (t >= K.traceGo && t < K.lit) {
    // 第 1–3 镜：光描边（光擦亮外壳的边缘）→ 拉远 → 光带揭示
    const [c, gb] = E.buf('lamp', W, H); cam.apply(gb);
    drawLamp(gb, 0, 0, R0, { ta, px: cam.zoom, housing: 1, litUntil: -1, unlitA: 0.09 });
    const th = t < K.traceEnd ? thetaAt(t) : thetaAt(K.traceEnd);
    // 边缘光：只有光走过的那段外壳被擦亮（径向渐变的月牙带）
    const [cm, gm] = E.buf('rimmask', W, H); cam.apply(gm);
    const thE = Math.max(Math.PI + 1e-4, th), fe = 0.32, nS = 10;          // 光头处角向羽化（柔和前沿）
    const f0 = 0.3 * (1 - seg(t, K.traceEnd - 0.35, K.traceEnd)), sA = Math.PI + f0;   // 起点也羽化，圆闭合时合成整环
    const mEnd = t >= K.traceEnd ? thE + 0.01 : thE - fe;
    if (mEnd > sA) { gm.fillStyle = '#000'; gm.beginPath(); gm.moveTo(0, 0); gm.arc(0, 0, R0 * 1.3, sA, mEnd); gm.closePath(); gm.fill(); }
    for (let k = 0; k < nS && f0 > 0.001; k++) {
      const a0 = Math.PI + f0 * k / nS, a1 = Math.min(Math.PI + f0 * (k + 1) / nS, thE - fe); if (a1 <= a0) continue;
      gm.fillStyle = `rgba(0,0,0,${(k + 0.5) / nS})`; gm.beginPath(); gm.moveTo(0, 0); gm.arc(0, 0, R0 * 1.3, a0, a1 + 0.003); gm.closePath(); gm.fill();
    }
    for (let k = 0; k < nS; k++) {
      const a0 = Math.max(Math.PI, thE - fe + fe * k / nS), a1 = Math.max(Math.PI, thE - fe + fe * (k + 1) / nS); if (t >= K.traceEnd) continue; if (a1 <= a0) continue;
      gm.fillStyle = `rgba(0,0,0,${1 - (k + 0.5) / nS})`; gm.beginPath(); gm.moveTo(0, 0); gm.arc(0, 0, R0 * 1.3, a0, a1 + 0.003); gm.closePath(); gm.fill();
    }
    const rg = gm.createRadialGradient(0, 0, R0 * 0.6, 0, 0, R0 * 1.25);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.45, 'rgba(0,0,0,.45)'); rg.addColorStop(0.7, 'rgba(0,0,0,1)'); rg.addColorStop(1, 'rgba(0,0,0,1)');
    gm.globalCompositeOperation = 'destination-in'; gm.fillStyle = rg; gm.fillRect(-R0 * 2, -R0 * 2, R0 * 4, R0 * 4);
    const [cr, gr_] = E.buf('rim', W, H); gr_.drawImage(c, 0, 0);
    gr_.globalCompositeOperation = 'source-atop'; gr_.fillStyle = 'rgba(205,216,255,.22)'; gr_.fillRect(0, 0, W, H);   // 掠射冷光
    gr_.globalCompositeOperation = 'destination-in'; gr_.drawImage(cm, 0, 0);
    const rimK = t < K.pullEnd ? 1 : 1 - seg(t, K.pullEnd, K.revealEnd);
    if (t < K.pullEnd) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 0.05; g.drawImage(c, 0, 0); g.restore(); }
    else E.lightReveal(g, c, seg(t, K.pullEnd, K.revealEnd), { base: 0.05, soft: 320, band: 130, glint: 0.18 });
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 0.9 * rimK; g.drawImage(cr, 0, 0); g.restore();
    cam.apply(g);
    const headA = t < K.traceEnd ? 1 : 1 - seg(t, K.traceEnd, K.traceEnd + 0.4);
    const keep = t < K.pullEnd ? 0.3 : lerp(0.3, 0.12, seg(t, K.pullEnd, K.revealEnd));
    drawTrace(g, 0, 0, R0 + 0.5, Math.PI, th, cam.zoom, keep, headA);
    if (t < 0.5) { const h = cam.proj(...ring(th)); g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter'; E.glow(g, h[0], h[1], 520, PAL.light, 0.32 * Math.exp(-t / 0.22)); g.restore(); cam.apply(g); }   // 点亮的一瞬
  } else if (t >= K.lit && t < WHIP0) {
    // 第 4 镜：点阵生成式累积
    drawLamp(g, 0, 0, R0, { ta, px: cam.zoom, housing: 1, litUntil: ta, br: breath(ta) });
  } else if (t >= WHIP0 && t < K.burst - F) {
    // 第 5–7 镜：分身三视图 → 落格 → CRT 坍缩（原灯在分身出发的头三帧里让位）
    const a0 = 1 - copyA(whipQ(t));
    if (a0 > 0.001) drawLamp(g, 0, 0, R0, { ta, px: cam.zoom, housing: 1, litUntil: ta, br: breath(ta), alpha: a0 });
    for (const v of [VIEWS[2], VIEWS[1], VIEWS[0]]) drawView(g, v, t, ta, cam);
  }
  if (t > K.crt + 0.1 && t < K.burst + 0.15) {   // 三盏灯汇成的一点光：坍缩与炸开之间的桥
    const k = Math.exp(-Math.pow((t - (K.burst - 2 * F)) / 0.07, 2)), o = cam.proj(0, 0);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter';
    E.glow(g, o[0], o[1], 340, PAL.accent, 0.5 * k); E.glow(g, o[0], o[1], 46, '#FFF1E6', 0.95 * k); g.restore(); cam.apply(g);
  }
  if (t >= K.burst - 3 * F && t < K.name) drawNumber(g, t, ta, cam);
  if (t >= K.name - F) drawName(g, t, cam);
  E.vignette(g, 0.52);
}

// ── 画面内文字（readcheck） ──
export function texts(t) {
  if (!NUM) return [];
  t += EPS;
  const cam = camAt(t), out = [], box = (id, text, x0, y0, x1, y1) => { const a = cam.proj(x0, y0), b = cam.proj(x1, y1); out.push({ id, text, x0: a[0], y0: a[1], x1: b[0], y1: b[1] }); };
  if (t >= K.split && t < K.crt) for (const v of VIEWS) {
    const P = viewPose(v, t);
    box('lab_' + v.id, v.label, P.wx - 90, P.wy + P.wh / 2 + 56, P.wx + 116, P.wy + P.wh / 2 + 126);
    if (v.id !== 'watch') box('tit_' + v.id, 'Lumen', P.wx - P.ww / 2 + 24, P.wy - P.wh / 2 + 10, P.wx - P.ww / 2 + 200, P.wy - P.wh / 2 + 66);
  }
  if (t >= K.burst && t < K.put1) box('num', '0.3 W', -NUM.total / 2, NUM.base - NUM.capH - 20, NUM.total / 2, NUM.base + 20);
  if (t >= K.name) box('wm', 'Lumen', NUM.wmX, NUM.ymid - 80, NUM.wmX + NUM.wmW, NUM.ymid + 80);
  if (t >= K.label) box('cn', '流明', NUM.wmX, NUM.ymid + 130, NUM.wmX + 140, NUM.ymid + 190);
  return out;
}

// ── 声音事件（mix.py 读 events.json） ──
export function buildEvents() {
  const ev = [];
  const push = (t, type, o = {}) => ev.push({ t: Math.round(t * 1e6) / 1e6, type, ...o });
  push(K.pulse0, 'pulse0');
  push(K.traceGo, 'trace', { dur: K.traceEnd - K.traceGo });
  push(K.traceEnd, 'close');
  push(K.pullEnd, 'reveal', { dur: K.revealEnd - K.pullEnd });
  push(K.lit, 'lit');
  for (const n of NOTES) push(n.t, 'dot', { n: n.n, inst: n.inst, midi: n.midi, div: n.div });
  gridTicks().forEach((t, i) => push(t, 'gridtick', { i }));
  push(K.split, 'whip', { dur: K.snap - K.split });
  VIEWS.forEach((v, i) => push(K.snap, 'snap', { view: v.id, pan: [-0.45, 0.25, 0.55][i] }));
  push(K.crt, 'crt', { dur: K.burst - K.crt });
  push(K.burst, 'burst');
  for (let b = KB.burst; b < KB.freeze - 1e-9; b += 0.25) if (![KB.lockW, KB.lock0, KB.lockDot].includes(b)) push(bt(b), 'grain');
  push(K.lockW, 'lock', { ch: 'W' }); push(K.lock0, 'lock', { ch: '0' }); push(K.lockDot, 'lock', { ch: '.' });
  push(K.freeze, 'freeze', { until: K.hit });
  push(K.hit, 'hit', { ch: '3' });
  ['W', '3', '.', '0'].forEach((c, i) => push(K['put' + (i + 1)], 'put', { ch: c, i }));
  push(K.name, 'name');
  push(K.name, 'trace2', { dur: bt(27) - K.name });
  push(K.label, 'label');
  push(K.glk1, 'close2');
  push(K.glk2, 'glk');
  return ev.sort((a, b) => a.t - b.t);
}
