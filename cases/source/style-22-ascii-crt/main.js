// whale.exe —— render(t) 画第 t 秒；window.EV 导出拟音/拍点事件；window.TEXTS 供 readcheck。
import * as TL from './timeline.js';
import { W, H, initTerm, glyphL, glyphC, line, cols, inverse, cursor, makeRamp, pick, AT } from './term.js';
import { makeCRT } from './crt.js';
import { MAIN_H, CY, SS, cam, camEnd, grid, paintNeg, whale, wpt, spout, surfaceY, tw, w2s, seg, ss, eio, eo, ei, lerp, hsh } from './scene.js';

const { b, fb, CUE } = TL;
const out = document.getElementById('c');
const crt = makeCRT(out);
const scene = document.createElement('canvas'); scene.width = W; scene.height = H;
const g = scene.getContext('2d');
const neg = document.createElement('canvas'); neg.width = 540; neg.height = 270;
const ng = neg.getContext('2d', { willReadFrequently: true });
await initTerm();
const Q = new URLSearchParams(location.search);
const clamp = (x, a = 0, c = 1) => Math.max(a, Math.min(c, x));
const TAU = .1;                                         // 余辉
const decay = (t, t0) => t < t0 ? 1 : Math.exp(-(t - t0) / TAU);
const blink = (t, t0, period = TL.BEAT) => { if (t < t0) return 1; const ph = (t - t0) % period; return ph < period / 2 ? 1 : decay(ph, period / 2); };

function begin() { g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'lighter'; }
function blackRect(x, y, w, h) { g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(x, y, w, h); g.globalCompositeOperation = 'lighter'; }

const EV = [];
const ev = (t, type, o = {}) => EV.push({ t: +t.toFixed(5), type, ...o });
for (const [k, v] of Object.entries(CUE)) ev(b(v), 'cue', { name: k, beat: v });

// ======================= 1. 终端（标题格）：$ ./whale.exe 与句子 =======================
const PROMPT = '$ ', CMD = './whale.exe', SENT = '海很深 鲸在唱歌';
const RAMP = makeRamp(SENT);
function termView(t) {
  const cw = lerp(75, 88, eio(seg(t, b(CUE.enter), b(CUE.shatter))));
  const PX = W / 2, PY = 520;
  return { cw, x0: PX - 7.5 * cw, y1: PY - cw, y0: PY - 3 * cw };
}
const KEYT = TL.TYPING.map(([ch, bt]) => ({ ch, t: fb(bt), bt }));
KEYT.forEach(k => ev(k.t, k.ch === '.' || k.ch === '/' ? 'keyLight' : 'key', { beat: k.bt }));
ev(b(CUE.enter), 'enter', { beat: CUE.enter });
const SENT_T = [...SENT].map((ch, k) => fb(CUE.out0 + k * TL.OUT_DT));
[...SENT].forEach((ch, k) => { if (ch !== ' ') ev(SENT_T[k], 'tty', { beat: CUE.out0 + k * TL.OUT_DT }); });
const typedN = t => KEYT.filter(k => t >= k.t).length;

function sTerm(t, fade = 1) {
  const v = termView(t), cw = v.cw;
  const pa = (t < b(CUE.shatter) ? 1 : decay(t, b(CUE.shatter))) * fade;
  const n = typedN(t), txt = PROMPT + CMD.slice(0, n);
  line(g, txt, v.x0, v.y0, cw, .95 * pa);
  // 光标：敲字时常亮，停顿时按拍闪
  if (t < b(CUE.enter)) {
    const last = n ? KEYT[n - 1].t : 0;
    const on = t < b(CUE.type0) ? blink(t, 0) : (t - last < TL.BEAT * .5 ? 1 : blink(t, last + TL.BEAT * .5));
    cursor(g, v.x0 + cols(txt) * cw, v.y0, cw, .9 * on);
  } else if (t < b(CUE.shatter)) {
    const k = SENT_T.filter(x => t >= x).length, s = [...SENT].slice(0, k).join('');
    if (t < b(CUE.shatter)) srcSentence(t, v, k);
    cursor(g, v.x0 + cols(s) * cw, v.y1, cw, .9 * blink(t, b(6)));        // 打完后按拍闪（翻转都落在 8 分网格上）
  }
}
// 句子的字（亮着；碎裂后随字粒被"用掉"而变暗）
const SRC = []; { let col = 0; [...SENT].forEach((ch, k) => { if (ch !== ' ') SRC.push({ k, ch, col }); col += ch === ' ' ? 1 : 2; }); }
function srcSentence(t, v, k = 99) {
  for (const s of SRC) {
    if (s.k >= k) continue;
    let a = 1;
    if (t >= b(CUE.shatter) && FALL) {
      const left = s.deps.length ? s.deps.filter(d => d > t).length / s.deps.length : 0;
      const lastDep = s.deps.length ? s.deps[s.deps.length - 1] : b(CUE.shatter) + .4;
      a = t < lastDep ? .3 + .7 * left : decay(t, lastDep);
    }
    const sp = seg(t, b(CUE.shatter), b(CUE.shatter) + .35);
    const jx = sp > 0 && sp < 1 ? (hsh(s.k, Math.floor(t * 24)) - .5) * 10 * sp : 0;
    glyphC(g, s.ch, v.x0 + s.col * v.cw + jx, v.y1, v.cw * 2, a, 0, 1);
    if (sp > 0 && sp < 1) glyphC(g, s.ch, v.x0 + s.col * v.cw - jx, v.y1 + sp * 30, v.cw * 2, .4 * (1 - sp) * a, 0, 1);
  }
}

// ======================= 2. 底片 → 字格 =======================
function cellsAt(t, c) {
  const gd = grid(c);
  const aw = gd.cols * SS, ah = gd.rows * SS;
  if (neg.width < aw || neg.height < ah) { neg.width = Math.max(neg.width, aw); neg.height = Math.max(neg.height, ah); }
  paintNeg(ng, t, c, gd);
  const d = ng.getImageData(0, 0, aw, ah).data;
  const A = new Float32Array(gd.cols * gd.rows), E = new Float32Array(gd.cols * gd.rows), n = SS * SS * 255;
  for (let j = 0; j < gd.rows; j++) for (let i = 0; i < gd.cols; i++) {
    let r = 0, gg = 0;
    for (let v = 0; v < SS; v++) { let o = ((j * SS + v) * aw + i * SS) * 4; for (let u = 0; u < SS; u++, o += 4) { r += d[o]; gg += d[o + 1]; } }
    A[j * gd.cols + i] = r / n; E[j * gd.cols + i] = gg / n;
  }
  // 局部反差 m + k·(m − 邻域均值)：轮廓边缘更亮（落到粗体档），紧贴亮面的暗侧更暗（落到稀疏档/空格）
  const A2 = new Float32Array(A.length), cw = gd.cols, KC = .7;
  for (let j = 0; j < gd.rows; j++) for (let i = 0; i < cw; i++) {
    const id = j * cw + i, m = A[id]; if (m <= 0) continue;
    let sm = 0, nn = 0;
    for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) { const jj = j + v, ii = i + u; if (jj < 0 || ii < 0 || jj >= gd.rows || ii >= cw) continue; sm += A[jj * cw + ii]; nn++; }
    A2[id] = Math.max(0, Math.min(1.15, m + KC * (m - sm / nn)));
  }
  return { gd, A: A2, E };
}
// 墨量阶梯：L < .3 的暗部只留稀疏的最低墨量字（有序抖动决定留不留，多数是空格）；中段按墨量挑字；最亮处与轮廓用粗体
const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + .5) / 16);
const LOW = RAMP.filter(q => q.ch !== ' ').slice(0, 2);
const lvl = (L, i, j) => {
  if (L < .06) return null;
  if (L < .3) {
    let h = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453; h -= Math.floor(h);
    if ((L - .06) / .24 * .8 < .6 * BAY[(j & 3) * 4 + (i & 3)] + .4 * h) return null;
    return LOW[(i * 7 + j * 3) % LOW.length];
  }
  const q = pick(RAMP, Math.min(1, Math.pow(L, 1.15)), i, j); return q.ch === ' ' ? null : q;
};
function drawCells(C, t, filt = null, cyanMap = null) {
  const { gd, A, E } = C, s = gd.s;
  for (let j = 0; j < gd.rows; j++) {
    const y = gd.gy0 + j * s; if (y > MAIN_H - s * .4) break;
    for (let i = 0; i < gd.cols; i++) {
      const id = j * gd.cols + i;
      if (filt && !filt(i, j, id)) continue;
      const x = gd.gx0 + i * s;
      let cy = cyanMap ? cyanMap.get(id) : undefined;
      if (cy !== undefined && t >= cy) {          // 落定的冰青字：颜色不再收回
        const q = lvl(Math.max(.4, A[id] + E[id]), i, j); if (q) glyphC(g, q.ch, x, y, s, q.a * (1 + .9 * Math.exp(-(t - cy) / .12)), 1, q.bold);
        continue;
      }
      const a = A[id], e = E[id];
      if (e > a && e > .05) { const q = lvl(e, i, j); if (q) glyphC(g, q.ch, x, y, s, q.a, 1, q.bold); continue; }
      const q = lvl(a, i, j); if (q) glyphC(g, q.ch, x, y, s, q.a, 0, q.bold);
    }
  }
}

// ======================= 3. 原生招式①：句子碎成字粒落成海 =======================
let FALL = null;
function buildFall() {
  const t1 = b(CUE.sea), c = cam(t1), C = cellsAt(t1, c), { gd } = C;
  const v = termView(b(CUE.shatter)), parts = new Map(), list = [];
  const surfS = w2s(c, 0, 0)[1];
  for (let j = 0; j < gd.rows; j++) for (let i = 0; i < gd.cols; i++) {
    const Y = gd.gy0 + (j + .5) * gd.s, X = gd.gx0 + (i + .5) * gd.s; if (Y > MAIN_H - gd.s * .4) continue;
    const id = j * gd.cols + i, q = lvl(C.A[id], i, j); if (!q) continue;
    const srcs = SRC.filter(s => s.ch === q.ch);
    const s = srcs.reduce((bst, o) => Math.abs(v.x0 + (o.col + 1) * v.cw - X) + hsh(i, j) * 500 < Math.abs(v.x0 + (bst.col + 1) * v.cw - X) + hsh(j, i) * 500 ? o : bst, srcs[0]);
    const r = hsh(i * 3.1, j * 1.7), d = clamp((Y - surfS) / (MAIN_H - surfS));
    const arr = b(CUE.shatter) + .35 + .66 * (1 - d) + .06 * r;
    const dep = Math.max(b(CUE.shatter) + .03 * hsh(j, i * 2.3), arr - (.5 + .25 * r));
    const sx = v.x0 + s.col * v.cw + v.cw * (.25 + 1.5 * hsh(i, j * 5.1)), sy = v.y1 + v.cw * (.3 + 1.4 * hsh(j * 2.7, i));
    const p = { id, i, j, X, Y, q, s, sx, sy, arr, dep, fly: arr - dep };
    parts.set(id, p); list.push(p);
  }
  for (const s of SRC) s.deps = list.filter(p => p.s === s).map(p => p.dep).sort((x, y) => x - y);
  const bins = new Map(); list.forEach(p => { const k = Math.round(p.arr * 48) / 48; bins.set(k, (bins.get(k) || 0) + 1); });
  [...bins].sort((x, y) => x[0] - y[0]).forEach(([t, n]) => ev(t, 'land', { n }));
  FALL = { parts, list };
}
function sFall(t) {
  const c = cam(t), C = cellsAt(b(CUE.sea), cam(b(CUE.sea)));
  drawCells(C, t, (i, j, id) => { const p = FALL.parts.get(id); return p && t >= p.arr; });
  for (const p of FALL.list) {
    if (t < p.dep) continue;
    if (t >= p.arr) {           // 落地闪
      const fl = .9 * Math.exp(-(t - p.arr) / .12); if (fl > .02) glyphC(g, p.q.ch, p.X - C.gd.s / 2, p.Y - C.gd.s / 2, C.gd.s, p.q.a * fl, 0, p.q.bold);
      continue;
    }
    const u = clamp((t - p.dep) / p.fly);
    const x = lerp(p.sx, p.X, ss(u)), y = lerp(p.sy, p.Y, u * (.6 + .4 * u)), sz = lerp(20, C.gd.s, ss(Math.min(1, u * 2.2)));
    glyphC(g, p.q.ch, x - sz / 2, y - sz / 2, sz, p.q.a * Math.min(1, u / .15) * .95, 0, p.q.bold);
  }
}

// ======================= 4. 原生招式③：水柱变冰青，炸成满屏字，落回海里留下 =======================
let BURST = null;
function buildBurst() {
  const tL = b(30.5), cE = camEnd(), C = cellsAt(tL, cE), { gd } = C;
  const surfS = w2s(cE, cE.x, 0)[1];
  const tgt = [];
  for (let j = 0; j < gd.rows; j++) for (let i = 0; i < gd.cols; i++) {
    const Y = gd.gy0 + (j + .5) * gd.s, X = gd.gx0 + (i + .5) * gd.s; if (Y > MAIN_H - gd.s) continue;
    const id = j * gd.cols + i;
    if (C.A[id] < .12 || Y < surfS - 70 || Y > surfS + 170) continue;   // 只落在海带里，不落到水下的鲸影上
    const pr = 1 - (Y - surfS + 70) / 420;          // 越靠近水面越密
    if (hsh(i * 1.37, j * 2.11) > .25 + .6 * pr) continue;
    tgt.push({ id, i, j, X, Y, q: lvl(Math.max(.4, C.A[id]), i, j) });
  }
  const t0 = b(CUE.cyan), c0 = cam(t0), sp = spout(t0), cyanMap = new Map(), parts = [];
  tgt.forEach((T, n) => {
    const r = hsh(n, 1.1), r2 = hsh(n, 2.2), r3 = hsh(n, 3.3), r4 = hsh(n, 4.4);
    const [sx, sy] = w2s(c0, sp.bx + sp.ux * sp.h * .9 * r2 + (r - .5) * (50 + 130 * r2), sp.by + sp.uy * sp.h * .9 * r2);
    const ax = 70 + 1780 * r3, ay = 40 + 820 * r4 * r4 * .9 + 30 * r;
    const dep = t0 + .015 + .16 * r2;
    const arr = b(29.4) + .15 + 1.55 * hsh(n, 5.5) * (.4 + .6 * (1 - (T.Y - surfS + 70) / 420));
    parts.push({ ...T, sx, sy, ax, ay, dep, mid: dep + .5 + .1 * r, arr, sz: 24 + 14 * r });
    cyanMap.set(T.id, arr);
  });
  const bins = new Map(); parts.forEach(p => { const k = Math.round(p.arr * 48) / 48; bins.set(k, (bins.get(k) || 0) + 1); });
  [...bins].sort((x, y) => x[0] - y[0]).forEach(([t, n]) => ev(t, 'settle', { n }));
  BURST = { parts, cyanMap };
}
function sBurst(t) {
  for (const p of BURST.parts) {
    if (t < p.dep || t >= p.arr) continue;
    let x, y, sz;
    if (t < p.mid) { const u = (t - p.dep) / (p.mid - p.dep); x = lerp(p.sx, p.ax, eo(u)); y = lerp(p.sy, p.ay, eo(u)); sz = lerp(8, p.sz, eo(u)); }
    else { const u = (t - p.mid) / (p.arr - p.mid); x = lerp(p.ax, p.X, ss(u)); y = lerp(p.ay, p.Y, Math.pow(u, 1.7)); sz = lerp(p.sz, 15, ss(u)); }
    const a = Math.min(1, (t - p.dep) / .12) * (p.q ? p.q.a : .7);
    glyphC(g, p.q ? p.q.ch : '海', x - sz / 2, y - sz / 2, sz, a, 1, p.q ? p.q.bold : 0);
  }
}

// ======================= 5. LOG 条（不随网格缩放的状态行） =======================
const STRIP = { y: 978, cw: 22, x: 150 };
const LOGTXT = 'exited 0';
const LOG_T = [...LOGTXT].map((ch, k) => fb(CUE.log + k * TL.LOG_DT));
[...LOGTXT].forEach((ch, k) => { if (ch !== ' ') ev(LOG_T[k], 'tick', { beat: CUE.log + k * TL.LOG_DT }); });
// 进度：每拍一格，停顿时卡在 85%，破水、顶点、变青三拍补满
const progress = t => {
  const bt = t / TL.BEAT;
  let n = bt < 5 ? 0 : Math.min(17, Math.floor(bt - 4));
  if (bt >= 24) n = 18; if (bt >= 26) n = 19; if (bt >= 28) n = 20;
  return n;
};
for (let k = 5; k <= 21; k++) ev(b(k), 'ratchet', { beat: k });
const fmtT = t => { const s = Math.floor(t), c = Math.floor((t - s) * 100); return `T+00:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`; };
function sStrip(t) {
  blackRect(0, MAIN_H, W, H - MAIN_H);
  const cw = STRIP.cw, y = STRIP.y, x = STRIP.x;
  for (let i = 0; i < 102; i++) glyphL(g, '-', 140 + i * 16, 932, 16, .2);
  if (t < b(CUE.enter)) {
    inverse(g, ' tty0 ', x, y, cw, .8);
    cursor(g, x + 7 * cw, y, cw, .85 * blink(t, .3));
  } else if (t < b(CUE.log)) {
    inverse(g, ' 运行 ', x, y, cw, .8);
    line(g, 'whale.exe', x + 7 * cw, y, cw, .85);
    const n = progress(t), bar = '[' + '#'.repeat(n) + '.'.repeat(20 - n) + ']';
    line(g, bar, x + 18 * cw, y, cw, .75);
    line(g, String(n * 5).padStart(3, ' ') + '%', x + 41 * cw, y, cw, .75);
    if (t >= b(CUE.drop) && t < b(CUE.breach)) cursor(g, x + 46 * cw, y, cw, .85 * blink(t, b(CUE.drop)));
  } else {
    inverse(g, ' 退出 ', x, y, cw, .8);
    line(g, 'whale.exe', x + 7 * cw, y, cw, .85);
    const k = LOG_T.filter(z => t >= z).length;
    line(g, LOGTXT.slice(0, k), x + 17 * cw, y, cw, 1.0);
    cursor(g, x + (17 + k) * cw, y, cw, .85 * (t < b(CUE.bel) ? 1 : blink(t, b(CUE.bel))));
  }
  line(g, fmtT(Math.min(t, b(CUE.off))), 1770 - 10 * cw, y, cw, .5);
}

// ======================= 6. 声音事件（无画面对应的段落事件） =======================
ev(0, 'relay'); ev(0.02, 'degauss');
ev(b(CUE.shatter), 'shatter', { beat: CUE.shatter });
ev(b(CUE.shatter), 'seaIn');
ev(b(CUE.pull0), 'zoomOut', { d: b(6) });
ev(b(CUE.song), 'song');
ev(b(CUE.drop), 'drop');
ev(b(CUE.breach), 'breach'); ev(b(CUE.apex), 'spout'); ev(b(CUE.cyan), 'burst'); ev(b(CUE.land), 'slam');
ev(b(CUE.bel), 'bel'); ev(b(CUE.off), 'poweroff');
// S5 大浪：隆起（b12.5，八分音符反拍）→ 浪唇砸下（b15 强拍）；胸鳍张开（b25）；鲸沉入水下（b30 起的气泡）
ev(b(12.5), 'waveRise', { d: b(2.5) }); ev(b(15), 'waveCrash', { beat: 15 });
ev(b(25), 'finFlap', { beat: 25 }); ev(b(30), 'sink', { d: b(3) });

// ======================= 7. render =======================
function camFor(t) { return cam(t); }
const DUR = TL.DUR;
window.render = t => {
  begin();
  if (t < b(CUE.shatter) + 1.2) sTerm(t);
  if (t >= b(CUE.shatter) && t < b(CUE.sea)) {
    if (!FALL) buildFall();
    sFall(t);
    srcSentence(t, termView(t));
  } else if (t >= b(CUE.sea)) {
    const c = camFor(t), C = cellsAt(t, c);
    drawCells(C, t, null, t >= b(29) ? BURST.cyanMap : null);
    if (t >= b(CUE.cyan) && t < b(32)) sBurst(t);
  }
  sStrip(t);
  // CRT：开机点→线→面；关机面→线→点，亮点余辉
  const power = lerp(.03, 1, seg(t, 0, .42));
  const off = seg(t, b(CUE.off) - 1 / 24, b(CUE.dot));
  const expo = t < b(CUE.dot) ? 1 : Math.max(.3, Math.exp(-(t - b(CUE.dot)) / 1.2));
  const jolt = t >= b(CUE.breach) ? .016 * Math.exp(-(t - b(CUE.breach)) / .18) : 0;
  const jolt2 = t >= b(CUE.cyan) ? .02 * Math.exp(-(t - b(CUE.cyan)) / .2) * Math.cos((t - b(CUE.cyan)) * 40) : 0;
  const ghost = 0;                                   // 余辉按 STYLE（τ≈0.1 s）已由收缩本身体现，不留长残影
  const flash = t < .42 ? .07 * Math.sin(Math.PI * seg(t, 0, .42)) + .02 : .02 * Math.exp(-(t - .42) / .2);   // 开机时光栅轻微泛光
  crt.render(scene, Math.round(t * 24), { power, off, expo, zoom: 1 + jolt + jolt2, earthSat: 1, ghost, flash });
};
buildFall(); buildBurst();
EV.sort((x, y) => x.t - y.t);
window.DUR = DUR; window.EV = EV;
window.TEXTS = t => {
  const T = [];
  if (t >= KEYT[0].t && t < b(CUE.shatter)) { const v = termView(t); T.push({ id: 'cmd', text: PROMPT + CMD, x0: v.x0, y0: v.y0, x1: v.x0 + 13 * v.cw, y1: v.y0 + 2 * v.cw }); }
  if (t >= SENT_T[0] && t < b(CUE.shatter)) { const v = termView(t); T.push({ id: 'sent', text: SENT, x0: v.x0, y0: v.y1, x1: v.x0 + 15 * v.cw, y1: v.y1 + 2 * v.cw }); }
  const sy = STRIP.y, cw = STRIP.cw;
  if (t >= .3 && t < b(CUE.enter)) T.push({ id: 'tag', text: 'tty0', x0: 150, y0: sy, x1: 150 + 6 * cw, y1: sy + 2 * cw });
  else if (t >= b(CUE.enter) && t < b(CUE.off)) {
    T.push({ id: 'state', text: t < b(CUE.log) ? '运行' : '退出', x0: 150, y0: sy, x1: 150 + 6 * cw, y1: sy + 2 * cw });
    T.push({ id: 'name', text: 'whale.exe', x0: 150 + 7 * cw, y0: sy, x1: 150 + 16 * cw, y1: sy + 2 * cw });
    if (t >= b(CUE.log)) T.push({ id: 'exit', text: LOGTXT, x0: 150 + 17 * cw, y0: sy, x1: 150 + 25 * cw, y1: sy + 2 * cw });
  }
  return T;
};
if (Q.has('t')) window.render(+Q.get('t'));
window.RAMP = RAMP.map(l => l.ch + l.a + ':' + l.v.toFixed(3)).join(' ');
window.READY = true;
