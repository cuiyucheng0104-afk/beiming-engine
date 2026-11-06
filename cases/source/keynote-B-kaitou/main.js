// 方案 B《片库之夜》20 秒开头：render(t) 只依赖 t（确定性）；所有时刻与位置来自 timeline.js。
// 世界坐标 = 看片台上的像素；一台 2D 镜头；台面、物件、批注、放大镜都走同一个 world→screen。
// IP 图规则：只用 drawImage 做等比缩放/平移（入场时整体刚体旋转，落定归 0°），不加滤镜、不改色、不抠图；放大镜内为同一像素的 1.6× 等比放大。
import * as T from './timeline.js';
import { clamp, lerp, seg, ss, eio, eo, ei, mulberry, hash, vnoise } from '/core/lib.js';

const { W, H, FPS, g, fq, frameOf, TABLE, NT, tubeY, LAMP_ORDER, LAMP_T, FLICK, PREHEAT, SLIDE, IMG, DEER_HEAD, LOUPE,
  CARDS, PENCIL_LYING, STACK, TITLE, TAG, PAPER, NUM, FIELD, TAPS, NDOTS, T477, TCLU, TNAMES, NAME_GAP, NAME_DUR, NOTE,
  TMERGE, OUTLINE, GNAME, TALLY, GROUPS, REGIONS, CLUSTERS, GROUP_C, CAPTION, SLEEVES, SLEEVE, sleeveFrom, CAM, PANS } = T;

const VERM = '#BE3A2E', INK = '#15171A', INK2 = '#2B2723', BLUE = '#2F5D8A', BLUE_D = '#1E3550', RED = '#A8283A';
const DEG = Math.PI / 180;

// ───────── 资源 ─────────
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('missing ' + src)); i.src = src; });
const [deerI, wukI, heiI, huluI, deskI, mottleI, fibreI] = await Promise.all(
  ['material/p01_jiuselu.png', 'material/p02_sunwukong.png', 'material/p02_heimao.png', 'material/p02_hulu.png',
    'material/desk.jpg', 'material/mottle.png', 'material/fibre.png'].map(loadImg));
await Promise.all([
  document.fonts.load('40px MaShanZheng', '孙悟空是分类'), document.fonts.load('700 40px NotoSansSC', '上美影角色'),
  document.fonts.load('400 40px NotoSansSC', '内容来源'), document.fonts.load('800 40px InterX', '0123456789')]);

const bmp = (im, w) => createImageBitmap(im, { resizeWidth: Math.round(w), resizeHeight: Math.round(w * im.height / im.width), resizeQuality: 'high' });
const deerB = await bmp(deerI, 1520);                                   // 2× 显示尺寸（供放大镜 1.6× 取样）
const posters = { p02_sunwukong: wukI, p02_heimao: heiI, p02_hulu: huluI };
const posterB = {};
for (const k in posters) posterB[k] = await bmp(posters[k], 2 * SLEEVE.ih * posters[k].width / posters[k].height);

const cv = document.getElementById('c'), X = cv.getContext('2d');
const mkC = (w, h) => { const c = new OffscreenCanvas(w, h); return [c, c.getContext('2d')]; };
const [OC, O] = mkC(W, H), [MC, M] = mkC(W, H), [SC, S] = mkC(W, H), [AC, A] = mkC(W, H);

// ───────── 看片台亮度场 ─────────
const TW = Math.round((TABLE.x1 - TABLE.x0) / 4), TH = Math.round((TABLE.y1 - TABLE.y0) / 4);
const SP = (TABLE.y1 - TABLE.y0) / NT, SIG = .72 * SP;
const band = (y, i) => { const d = (y - tubeY(i)) / SIG, d2 = (y - tubeY(i)) / (SIG * .3); return .94 * Math.exp(-.5 * d * d) + .06 * Math.exp(-.5 * d2 * d2); };
// 全亮时每一行的总和（含两端外侧的镜像灯管，让台边不暗）；部分亮时 = 亮着的灯管 / 全亮
const SFULL = new Float32Array(Math.round((TABLE.y1 - TABLE.y0) / 4));
for (let y = 0; y < SFULL.length; y++) { const wy = TABLE.y0 + (y + .5) * 4; let s = 0; for (let i = -2; i < NT + 2; i++) s += band(wy, i); SFULL[y] = s; }
const fx = new Float32Array(TW);
for (let x = 0; x < TW; x++) { const wx = TABLE.x0 + (x + .5) * 4; fx[x] = ss(seg(wx, TABLE.x0 + 10, TABLE.x0 + 260)) * ss(seg(wx, TABLE.x1 - 10, TABLE.x1 - 260)) * .25 + .75 * ss(seg(wx, TABLE.x0 + 10, TABLE.x0 + 90)) * ss(seg(wx, TABLE.x1 - 10, TABLE.x1 - 90)); }
const mottle = (() => {
  const [c, q] = mkC(TW, TH); q.drawImage(mottleI, 0, 0, TW, TH);
  const d = q.getImageData(0, 0, TW, TH).data, m = new Float32Array(TW * TH);
  for (let i = 0; i < TW * TH; i++) m[i] = (d[i * 4] - 128) / 32;
  return m;
})();
const [TEX, TQ] = mkC(TW, TH), [TEXL, TQL] = mkC(TW, TH);
const TID = TQ.createImageData(TW, TH), TIDL = TQL.createImageData(TW, TH);
const BASE = [236, 241, 247];

function lampLevel(i, t) {
  const k = LAMP_ORDER.indexOf(i), t0 = LAMP_T[k];
  if (t < t0 - 1e-6) return 0;
  const f = Math.floor((t - t0) * FPS + 1e-4), F = FLICK[k];
  return f < F.length ? F[f] : 1;
}
function preheat(i, t) {
  const k = LAMP_ORDER.indexOf(i), t0 = LAMP_T[k];
  if (t < t0 - PREHEAT || t > t0 + FLICK[k].length / FPS) return 0;
  return t < t0 ? seg(t, t0 - PREHEAT, t0) * .8 : (1 - lampLevel(i, t)) * .7;
}
const STABLE_T = Math.max(...LAMP_T.map((t0, k) => t0 + FLICK[k].length / FPS)) + .01;
let texKey = -1, avgLit = 0;
function buildTable(t) {
  const key = t >= STABLE_T ? 1e9 : Math.round(t * FPS * 8);
  if (key === texKey) return; texKey = key;
  const lev = [], ph = [];
  for (let i = 0; i < NT; i++) { lev.push(t >= STABLE_T ? 1 : lampLevel(i, t)); ph.push(t >= STABLE_T ? 0 : preheat(i, t)); }
  const Lrow = new Float32Array(TH);
  let sum = 0;
  for (let y = 0; y < TH; y++) { const wy = TABLE.y0 + (y + .5) * 4; let s = 0; for (let i = -2; i < NT + 2; i++) { const l = lev[Math.min(NT - 1, Math.max(0, i))]; if (l > 0) s += l * band(wy, i) * (i < 0 || i >= NT ? .9 : 1); } Lrow[y] = s / SFULL[y] * (1 + .02 * Math.cos(2 * Math.PI * (wy - tubeY(0)) / SP)); sum += Math.min(1, Lrow[y]); }
  avgLit = sum / TH;
  const d = TID.data, dl = TIDL.data;
  for (let y = 0; y < TH; y++) {
    const wy = TABLE.y0 + (y + .5) * 4, Ly = Lrow[y];
    for (let x = 0; x < TW; x++) {
      const p = y * TW + x, L = Ly * fx[x], m = 1 + .013 * mottle[p] * Math.min(1, L * 2);
      let r = BASE[0] * L * m, gg = BASE[1] * L * m, b = BASE[2] * L * m;
      const o = p * 4;
      d[o] = r > 255 ? 255 : r; d[o + 1] = gg > 255 ? 255 : gg; d[o + 2] = b > 255 ? 255 : b; d[o + 3] = 255;
      const l = Math.min(255, L * 255); dl[o] = dl[o + 1] = dl[o + 2] = l; dl[o + 3] = 255;
    }
  }
  // 灯丝预热：灯管两端微橙
  for (let i = 0; i < NT; i++) if (ph[i] > 0) {
    const cy = (tubeY(i) - TABLE.y0) / 4;
    for (const ex of [TABLE.x0 + 70, TABLE.x1 - 70]) {
      const cx = (ex - TABLE.x0) / 4;
      for (let y = Math.max(0, Math.floor(cy - 14)); y < Math.min(TH, cy + 14); y++) for (let x = Math.max(0, Math.floor(cx - 24)); x < Math.min(TW, cx + 24); x++) {
        const k = ph[i] * Math.exp(-(((x - cx) / 11) ** 2 + ((y - cy) / 5) ** 2)), o = (y * TW + x) * 4;
        d[o] = Math.min(255, d[o] + 255 * k); d[o + 1] = Math.min(255, d[o + 1] + 120 * k); d[o + 2] = Math.min(255, d[o + 2] + 40 * k);
      }
    }
  }
  TQ.putImageData(TID, 0, 0); TQL.putImageData(TIDL, 0, 0);
}

// ───────── 镜头 ─────────
function camAt(t) {
  if (t <= CAM[0].t) return [...CAM[0].c];
  for (let i = 0; i < CAM.length - 1; i++) {
    const A0 = CAM[i], B1 = CAM[i + 1];
    if (t <= B1.t) {
      const u = clamp((t - A0.t) / (B1.t - A0.t)), e = B1.ease;
      const k = e === 'eio' || e === 'pan' ? eio(u) : e === 'eo' ? eo(u) : e === 'ss' ? ss(u) : u;
      const c = A0.c.map((v, j) => lerp(v, B1.c[j], k));
      if (e === 'pan') c[2] -= B1.dip * Math.sin(Math.PI * u) ** 1.5;
      return c;
    }
  }
  return [...CAM[CAM.length - 1].c];
}
const setCam = (q, c) => { q.setTransform(1, 0, 0, 1, 0, 0); q.translate(W / 2, H / 2); q.rotate(c[3] * DEG); q.scale(c[2], c[2]); q.translate(-c[0], -c[1]); };
const w2s = (c, x, y) => { const z = c[2], r = c[3] * DEG, dx = (x - c[0]) * z, dy = (y - c[1]) * z; return [W / 2 + dx * Math.cos(r) - dy * Math.sin(r), H / 2 + dx * Math.sin(r) + dy * Math.cos(r)]; };

// ───────── 纹理与笔迹工具 ─────────
const grainTile = (() => { const [c, q] = mkC(128, 128), id = q.createImageData(128, 128), R = mulberry(77);
  for (let i = 0; i < 128 * 128; i++) { const v = R(); id.data[i * 4 + 3] = v < .5 ? 0 : (v - .5) * 2 * 150; } q.putImageData(id, 0, 0); return c; })();
const fibrePat = O.createPattern(fibreI, 'repeat');
const txtCache = new Map();
function handImg(text, size, color, font = 'MaShanZheng', weight = '', scale = 2) {
  const key = [text, size, color, font, weight, scale].join('|');
  if (txtCache.has(key)) return txtCache.get(key);
  const m = new OffscreenCanvas(8, 8).getContext('2d'); m.font = `${weight} ${size * scale}px ${font}`;
  const w = Math.ceil(m.measureText(text).width + size * scale * .7), h = Math.ceil(size * scale * 1.6);
  const [c, q] = mkC(w, h); q.font = m.font; q.fillStyle = color;
  let x = size * scale * .3; const R = mulberry(text.length * 131 + size * 7 + text.charCodeAt(0));
  for (const ch of text) { const lat = /[A-Za-z]/.test(ch); q.font = lat ? `700 ${size * scale * .9}px NotoSansSC` : m.font; q.save(); q.translate(x, h * .74 + (R() - .5) * size * scale * .06); q.rotate((R() - .5) * .07); if (lat) q.transform(1, 0, -.12, 1, 0, 0); q.fillText(ch, 0, 0); if (size < 32) { q.lineWidth = size * scale * .025; q.strokeStyle = color; q.strokeText(ch, 0, 0); } q.restore(); x += q.measureText(ch).width * (ch === ' ' ? .6 : 1) + (lat ? size * scale * .04 : 0); }
  q.globalCompositeOperation = 'destination-out'; q.fillStyle = q.createPattern(grainTile, 'repeat'); q.fillRect(0, 0, w, h);
  const r = { c, w: w / scale, h: h / scale, pad: size * .3, base: h * .74 / scale, tw: (x - size * scale * .3) / scale };
  txtCache.set(key, r); return r;
}
function handText(q, text, x, y, o = {}) {
  const { size = 26, color = BLUE, progress = 1, alpha = 1 } = o;
  const im = handImg(text, size, color), left = x, pr = clamp(progress);
  if (pr <= 0) return [left, y];
  q.save(); q.globalAlpha *= alpha; q.beginPath(); q.rect(left - im.pad, y - im.base, im.pad + im.tw * pr + (pr >= 1 ? im.pad : 0), im.h); q.clip();
  q.drawImage(im.c, left - im.pad, y - im.base, im.w, im.h); q.restore();
  const f = pr * im.tw; return [left + f, y - size * (.3 + .2 * Math.sin(f * .5))];
}
function sansText(q, text, x, y, o = {}) {      // 正文：Noto Sans SC，自引线侧擦入
  const { size = 30, weight = 700, color = INK, progress = 1, align = 'left', from = 'left', font = 'NotoSansSC', alpha = 1 } = o;
  q.save(); q.font = `${weight} ${size}px ${font}`; q.textBaseline = 'alphabetic';
  const w = q.measureText(text).width, left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x, pr = clamp(progress);
  if (pr <= 0) { q.restore(); return w; }
  q.beginPath();
  if (from === 'left') q.rect(left - 4, y - size * 1.2, (w + 8) * pr, size * 1.6); else q.rect(left - 4 + (w + 8) * (1 - pr), y - size * 1.2, (w + 8) * pr, size * 1.6);
  q.clip(); q.globalAlpha *= alpha; q.fillStyle = color; q.fillText(text, left, y); q.restore();
  return w;
}
function resample(pts, step = 2.5) {
  const out = [pts[0]], len = [0]; let L = 0;
  for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i], d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) { out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]); L += d / n; len.push(L); } }
  return { pts: out, len, total: L };
}
function pencilStroke(q, pts, o = {}) {
  const { color = BLUE, width = 2.4, progress = 1, seed = 1, wobble = .5, passes = 2, alpha = .9, grain = .45 } = o;
  if (progress <= 0) return pts[0];
  const R = resample(pts), n = R.pts.length, end = R.total * clamp(progress);
  const P2 = R.pts.map((p, i) => { const a = R.pts[Math.max(0, i - 1)], b = R.pts[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const w = (vnoise(R.len[i] * .02 + seed * 13.1) - .5) * 2 * wobble * width; return [p[0] - dy / l * w, p[1] + dx / l * w]; });
  const a0 = q.globalAlpha; let tip = P2[0];
  q.save(); q.lineCap = 'round'; q.strokeStyle = color;
  for (let pass = 0; pass < passes; pass++) {
    const off = pass ? (hash(seed + pass) - .5) * width * .6 : 0;
    for (let i = 1; i < n; i++) {
      if (R.len[i - 1] > end) break;
      q.globalAlpha = a0 * alpha * (1 - grain * hash(i * 1.7 + seed * 31 + pass * 7)) * (pass ? .45 : 1);
      q.lineWidth = width * (pass ? .6 : 1);
      let [bx, by] = P2[i];
      if (R.len[i] > end) { const [ax, ay] = P2[i - 1], k = (end - R.len[i - 1]) / (R.len[i] - R.len[i - 1]); bx = ax + (bx - ax) * k; by = ay + (by - ay) * k; }
      q.beginPath(); q.moveTo(P2[i - 1][0] + off, P2[i - 1][1] + off); q.lineTo(bx + off, by + off); q.stroke(); tip = [bx, by];
    }
  }
  q.restore(); q.globalAlpha = a0; return tip;
}
const loopPath = (cx, cy, rx, ry, seed, turns = 1.1, a0 = -2.3, sq = 0) => Array.from({ length: 90 }, (_, i) => {
  const a = a0 + turns * Math.PI * 2 * i / 89, w = 1 + (vnoise(i * .15 + seed * 7) - .5) * .07 + i / 89 * .05;
  const c = Math.cos(a), s = Math.sin(a), p = 2 / (2 + sq * 6);                           // sq>0：更方的超椭圆
  return [cx + rx * w * Math.sign(c) * Math.abs(c) ** p, cy + ry * w * Math.sign(s) * Math.abs(s) ** p];
});

// ───────── 数据：477 个点 ─────────
const DOTS = (() => {
  const R = mulberry(477), out = [];
  const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  const mx = 50, my = 40;
  TAPS.forEach((tp, k) => {
    const cx = lerp(FIELD.x0 + mx, FIELD.x1 - mx, (halton(k + 3, 2) + R() * .12) % 1), cy = lerp(FIELD.y0 + my, FIELD.y1 - my, (halton(k + 3, 3) + R() * .12) % 1);
    tp.cx = cx; tp.cy = cy;
    const sig = tp.n === 1 ? 0 : 14 * Math.sqrt(tp.n) + 8;
    for (let j = 0; j < tp.n; j++) {
      let x = cx, y = cy;
      if (j > 0 || tp.n > 1) { const u = Math.max(1e-6, R()), v = R(), r = Math.sqrt(-2 * Math.log(u)) * sig; x += r * Math.cos(6.2832 * v); y += r * Math.sin(6.2832 * v) * .85; }
      x = clamp(x, FIELD.x0 + 8, FIELD.x1 - 8); y = clamp(y, FIELD.y0 + 8, FIELD.y1 - 8);
      out.push({ x, y, tap: k, frame: tp.frame, t: tp.t, big: tp.n });
    }
  });
  // 就近分配到 25 簇：每簇 19 个，剩下 2 个就近进 20
  const NC = CLUSTERS.length, cap = new Array(NC).fill(0), pairs = [];
  out.forEach((d, i) => CLUSTERS.forEach((c, j) => pairs.push([Math.hypot(d.x - c.x, d.y - c.y), i, j])));
  pairs.sort((a, b) => a[0] - b[0]);
  for (const lim of [19, 20]) for (const [, i, j] of pairs) if (out[i].cl === undefined && cap[j] < lim) { out[i].cl = j; out[i].rank = cap[j]++; }
  // 漂移：远的先动；落点用葵花序排布
  out.forEach((d, i) => {
    const c = CLUSTERS[d.cl], a = d.rank * 2.39996, r = 5.9 * Math.sqrt(d.rank + .6);
    d.ox = Math.cos(a) * r; d.oy = Math.sin(a) * r;
    const dist = Math.hypot(d.x - c.x - d.ox, d.y - c.y - d.oy);
    d.delay = clamp(.42 - dist / 1400 * .42 + (hash(i * 3.1) - .5) * .12, 0, .5); d.bend = (hash(i * 7.7) - .5) * 70;
  });
  return out;
})();
console.assert(DOTS.length === 477, 'dots ' + DOTS.length);

function clusterPos(j, t) {
  const c = CLUSTERS[j], k = eio(seg(t, TMERGE, TMERGE + .38)) * T.MERGE_K, gc = GROUP_C[c.gi];
  return [c.x + (gc[0] - c.x) * k, c.y + (gc[1] - c.y) * k];
}
function dotPos(d, t) {
  if (t < T477) return [d.x, d.y];
  const [cx, cy] = clusterPos(d.cl, t), tx = cx + d.ox, ty = cy + d.oy;
  if (t >= TCLU) {
    const dt = t - TCLU, dx = tx - d.x, dy = ty - d.y, l = Math.hypot(dx, dy) || 1, w = 4.5 * Math.exp(-dt / .07) * Math.sin(dt * 45);
    return [tx + dx / l * w, ty + dy / l * w];
  }
  const u = seg(t, T477 + d.delay, TCLU), p = u ** 2.1, dx = tx - d.x, dy = ty - d.y, l = Math.hypot(dx, dy) || 1, b = Math.sin(Math.PI * p) * d.bend;
  return [d.x + dx * p - dy / l * b, d.y + dy * p + dx / l * b];
}

// ───────── 物件绘制 ─────────
function rrect(q, x, y, w, h, r) { q.beginPath(); q.roundRect(x, y, w, h, r); }
function drawDesk(q) {
  q.save(); q.globalAlpha = .12 + .78 * avgLit; q.drawImage(deskI, TABLE.x0 - 2400, TABLE.y0 - 1500, (TABLE.x1 - TABLE.x0) + 4800, (TABLE.y1 - TABLE.y0) + 3000); q.restore();
  // 台面的光溢到桌上
  if (avgLit > 0) { q.save(); q.globalCompositeOperation = 'lighter'; q.shadowColor = `rgba(200,215,235,${.32 * avgLit})`; q.shadowBlur = 260 * .6; q.fillStyle = `rgba(200,215,235,${.32 * avgLit})`;
    q.fillRect(TABLE.x0, TABLE.y0, TABLE.x1 - TABLE.x0, TABLE.y1 - TABLE.y0); q.restore(); }
}
function drawTable(q) {
  const r = TABLE.rim;
  q.save();
  rrect(q, TABLE.x0 - r, TABLE.y0 - r, TABLE.x1 - TABLE.x0 + 2 * r, TABLE.y1 - TABLE.y0 + 2 * r, 18);
  const k = .1 + .9 * avgLit, al = q.createLinearGradient(0, TABLE.y0 - r, 0, TABLE.y1 + r);
  al.addColorStop(0, `rgb(${70 + 95 * k},${72 + 97 * k},${76 + 100 * k})`); al.addColorStop(.5, `rgb(${40 + 80 * k},${42 + 82 * k},${46 + 85 * k})`); al.addColorStop(1, `rgb(${60 + 90 * k},${62 + 92 * k},${66 + 95 * k})`);
  q.fillStyle = al; q.fill();
  q.imageSmoothingQuality = 'high'; q.drawImage(TEX, TABLE.x0, TABLE.y0, TABLE.x1 - TABLE.x0, TABLE.y1 - TABLE.y0);
  q.strokeStyle = `rgba(0,0,0,${.35 * k})`; q.lineWidth = 3; q.strokeRect(TABLE.x0, TABLE.y0, TABLE.x1 - TABLE.x0, TABLE.y1 - TABLE.y0);
  q.restore();
}
function drawPaper(q) {
  const { x0, y0, x1, y1 } = PAPER, w = x1 - x0, h = y1 - y0;
  q.save(); q.translate(x0, y0); q.rotate(-.4 * DEG);
  q.fillStyle = '#F1E9D6'; q.fillRect(0, 0, w, h);
  q.globalCompositeOperation = 'overlay'; q.globalAlpha = .22; q.fillStyle = fibrePat; q.fillRect(0, 0, w, h);
  q.globalCompositeOperation = 'source-over'; q.globalAlpha = 1;
  // 背光下纸边更亮更暖
  for (const [gx, gy, gw, gh, d] of [[0, 0, w, 40, 'v'], [0, h - 40, w, 40, 'v2'], [0, 0, 40, h, 'h'], [w - 40, 0, 40, h, 'h2']]) {
    const gr = d[0] === 'v' ? q.createLinearGradient(0, gy + (d === 'v' ? 0 : 40), 0, gy + (d === 'v' ? 40 : 0)) : q.createLinearGradient(gx + (d === 'h' ? 0 : 40), 0, gx + (d === 'h' ? 40 : 0), 0);
    gr.addColorStop(0, 'rgba(255,246,222,.75)'); gr.addColorStop(1, 'rgba(255,246,222,0)'); q.fillStyle = gr; q.fillRect(gx, gy, gw, gh);
  }
  q.fillStyle = 'rgba(150,130,100,.22)';
  for (let y = 40; y < h - 20; y += 40) for (let x = 40; x < w - 20; x += 40) q.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
  q.restore();
}
function drawCards(q) {
  for (const [i, c] of CARDS.entries()) {
    q.save(); q.translate(c.cx, c.cy); q.rotate(c.rot * DEG);
    q.fillStyle = i ? '#F5F0E4' : '#EEE7D6'; q.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    q.strokeStyle = 'rgba(200,70,70,.55)'; q.lineWidth = 2; q.beginPath(); q.moveTo(-c.w / 2, -c.h / 2 + 46); q.lineTo(c.w / 2, -c.h / 2 + 46); q.stroke();
    q.strokeStyle = 'rgba(90,130,190,.35)'; q.lineWidth = 1.4;
    for (let y = -c.h / 2 + 78; y < c.h / 2 - 8; y += 30) { q.beginPath(); q.moveTo(-c.w / 2, y); q.lineTo(c.w / 2, y); q.stroke(); }
    q.strokeStyle = 'rgba(255,250,235,.8)'; q.lineWidth = 4; q.strokeRect(-c.w / 2 + 2, -c.h / 2 + 2, c.w - 4, c.h - 4);
    q.restore();
  }
}
function drawLyingPencil(q) {
  const p = PENCIL_LYING; q.save(); q.translate(p.x, p.y); q.rotate(p.rot * DEG);
  q.fillStyle = '#26282B'; q.beginPath(); q.moveTo(-p.len / 2, -9); q.lineTo(p.len / 2 - 60, -9); q.lineTo(p.len / 2, 0); q.lineTo(p.len / 2 - 60, 9); q.lineTo(-p.len / 2, 9); q.closePath(); q.fill();
  q.fillStyle = 'rgba(255,255,255,.08)'; q.fillRect(-p.len / 2, -9, p.len - 60, 3);
  q.fillStyle = '#3A3C40'; q.fillRect(-p.len / 2 - 30, -9, 30, 18);
  q.restore();
}
function drawStack(q) {
  const s = STACK;
  for (let i = 0; i < s.n; i++) { q.save(); q.translate(s.cx + i * 6 - 10, s.cy - i * 5); q.rotate((i - 1.5) * 1.3 * DEG);
    q.fillStyle = 'rgba(205,210,216,.42)'; q.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
    q.strokeStyle = 'rgba(120,126,134,.6)'; q.lineWidth = 2; q.strokeRect(-s.w / 2, -s.h / 2, s.w, s.h);
    q.fillStyle = 'rgba(238,232,218,.95)'; q.fillRect(-s.w / 2 + 4, -s.h / 2 + 4, s.w - 8, 26); q.restore(); }
}
function slidePose(t) {
  if (t >= SLIDE.t1) { const dt = t - SLIDE.t1, rc = 3 * Math.exp(-dt / .05) * Math.sin(dt * 70); return [SLIDE.cx - rc, SLIDE.cy, 0, 1]; }
  if (t < SLIDE.t0) return null;
  const u = seg(t, SLIDE.t0, SLIDE.t1), p = 1 - (1 - u) ** 1.7, [fx0, fy0, fr] = SLIDE.from;
  return [lerp(fx0, SLIDE.cx, p), lerp(fy0, SLIDE.cy, p), fr * (1 - p), 1];
}
function drawMount(q, t) {
  const P = slidePose(t); if (!P) return;
  const w = SLIDE.iw + 2 * SLIDE.bx, h = SLIDE.ih + 2 * SLIDE.by;
  q.save(); q.translate(P[0], P[1]); q.rotate(P[2] * DEG);
  rrect(q, -w / 2, -h / 2, w, h, 14); q.fillStyle = '#8E9298'; q.fill();
  q.strokeStyle = 'rgba(255,255,255,.18)'; q.lineWidth = 3; q.stroke();
  q.fillStyle = 'rgba(0,0,0,.12)'; q.fillRect(-w / 2 + 14, h / 2 - 22, w - 28, 6);
  // 窗口：比画面大 5 px，露出透光的亮边
  q.fillStyle = '#FBFDFF'; q.fillRect(-SLIDE.iw / 2 - 5, -SLIDE.ih / 2 - 5, SLIDE.iw + 10, SLIDE.ih + 10);
  q.restore();
}
function drawSlideImage(q, t) {
  const P = slidePose(t); if (!P) return;
  q.save(); q.translate(P[0], P[1]); q.rotate(P[2] * DEG); q.imageSmoothingQuality = 'high';
  q.drawImage(deerB, -SLIDE.iw / 2, -SLIDE.ih / 2, SLIDE.iw, SLIDE.ih); q.restore();
}
function sleevePose(s, t) {
  const fly0 = s.land - SLEEVE.fly;
  if (t < fly0) return null;
  const tgt = [s.cx, SLEEVE.cy], L = [s.cx + SLEEVE.land[0], SLEEVE.cy + SLEEVE.land[1]];
  if (t < s.land) {
    const u = seg(t, fly0, s.land), p = 1 - (1 - u) ** 1.4, F = sleeveFrom(SLEEVES.indexOf(s));
    return { x: lerp(F[0], L[0], p), y: lerp(F[1], L[1], p), rot: lerp(-7, -1.6, p), sc: lerp(1.16, 1, u * u), air: 1 - u };
  }
  const u = seg(t, s.land, s.land + s.settle), p = 1 - (1 - u) ** 2.6;
  return { x: lerp(L[0], tgt[0], p), y: lerp(L[1], tgt[1], p), rot: -1.6 * (1 - p), sc: 1, air: 0 };
}
const sleeveDims = s => { const im = posters[s.img], iw = SLEEVE.ih * im.width / im.height; return { iw, ih: SLEEVE.ih, w: iw + 2 * SLEEVE.side, h: SLEEVE.ih + SLEEVE.top + SLEEVE.bot }; };
function drawSleeveBody(q, t) {
  for (const s of SLEEVES) {
    const P = sleevePose(s, t); if (!P) continue; const D = sleeveDims(s);
    q.save(); q.translate(P.x, P.y); q.rotate(P.rot * DEG); q.scale(P.sc, P.sc);
    const x0 = -D.w / 2, y0 = -D.h / 2;
    if (P.air > 0) { q.save(); q.filter = `blur(${8 + 20 * P.air}px)`; q.fillStyle = `rgba(20,24,30,${.18 * P.air + .05})`; q.fillRect(x0 + 18 * P.air, y0 + 26 * P.air, D.w, D.h); q.restore(); }
    q.fillStyle = 'rgba(214,220,228,.55)'; q.fillRect(x0, y0, D.w, D.h);
    q.strokeStyle = 'rgba(110,118,128,.75)'; q.lineWidth = 2.2; q.strokeRect(x0, y0, D.w, D.h);
    q.fillStyle = 'rgba(244,238,224,.97)'; q.fillRect(x0 + 10, y0 + 10, D.w - 20, SLEEVE.top - 22);   // 空白纸签
    q.strokeStyle = 'rgba(160,150,130,.6)'; q.lineWidth = 1; q.strokeRect(x0 + 10, y0 + 10, D.w - 20, SLEEVE.top - 22);
    q.restore();
  }
}
function drawSleeveImages(q, t) {
  for (const s of SLEEVES) {
    const P = sleevePose(s, t); if (!P) continue; const D = sleeveDims(s);
    q.save(); q.translate(P.x, P.y); q.rotate(P.rot * DEG); q.scale(P.sc, P.sc); q.imageSmoothingQuality = 'high';
    const x0 = -D.w / 2 + SLEEVE.side, y0 = -D.h / 2 + SLEEVE.top;
    q.drawImage(posterB[s.img], x0, y0, D.iw, D.ih);
    // 聚酯套的边缘高光只画在图外
    q.strokeStyle = 'rgba(255,255,255,.55)'; q.lineWidth = 2; q.strokeRect(-D.w / 2 + 3, -D.h / 2 + 3, D.w - 6, D.h - 6);
    q.restore();
  }
}
function loupePos(t) { const u = eio(seg(t, LOUPE.t0, LOUPE.t1)); return [lerp(LOUPE.park[0], DEER_HEAD[0], u), lerp(LOUPE.park[1], DEER_HEAD[1], u)]; }

// ───────── 批注层 ─────────
function drawSlideLabels(q, t) {
  if (t >= TITLE.t) {
    const u = seg(t, TITLE.t, TITLE.t + .18), [ax, ay] = TITLE.anchor;
    q.save(); q.fillStyle = INK; q.beginPath(); q.arc(ax, ay, 5, 0, 7); q.fill();
    q.strokeStyle = INK; q.lineWidth = 1.6; q.beginPath(); q.arc(ax, ay, 11, 0, 7); q.globalAlpha = u; q.stroke(); q.globalAlpha = 1;
    q.lineWidth = 2; q.beginPath(); q.moveTo(ax - 12, ay); q.lineTo(lerp(ax - 12, TITLE.x + 14, eo(u)), ay); q.stroke(); q.restore();
    sansText(q, '上美影 IP 全景', TITLE.x, TITLE.y, { size: 62, weight: 700, color: INK, align: 'right', from: 'right', progress: eo(seg(t, TITLE.t, TITLE.t + .4)) });
  }
  if (t >= TITLE.sub) sansText(q, '内容资源概念发布｜内部沟通', TITLE.x, TITLE.y + 50, { size: 27, weight: 400, color: '#3A3F46', align: 'right', from: 'right', progress: eo(seg(t, TITLE.sub, TITLE.sub + .4)) });
  if (t >= TAG.t) {
    const u = eo(seg(t, TAG.t, TAG.t + .16)), txt = '来源：上影元官网｜口径 2026-10-31';
    q.save(); q.font = '400 19px NotoSansSC'; const w = q.measureText(txt).width + 26;
    q.translate(TAG.x - w / 2, TAG.y + 18 - 6 * (1 - u)); q.globalAlpha = u;
    rrect(q, -w / 2, -18, w, 36, 4); q.fillStyle = 'rgba(14,15,17,.80)'; q.fill();
    q.fillStyle = '#9AA0A8'; q.fillRect(-w / 2, -18, 3, 36);
    q.fillStyle = '#F2F3F5'; q.textBaseline = 'middle'; q.fillText(txt, -w / 2 + 14, 1); q.restore();
  }
}
const fv = t => Math.round(t * FPS + 1e-6);   // 当前帧号（画面事件按帧出现）
// 分类名：基准 28 px，超出本列可用宽度时等比缩小（返修：「没头脑和不高兴」不再压到右侧点簇）
const NAME_PX = 28;
const nameSize = c => { const im = handImg(c.name, NAME_PX, BLUE_D); return im.tw > c.maxW ? NAME_PX * c.maxW / im.tw : NAME_PX; };
// 正字划记：第 i 条记录 = 第 floor(i/5) 个「正」的第 i%5 笔；同一下铅笔点的多条记录在到下一下之前依次补完
const ZHENG = [[[.08, .12], [.92, .1]], [[.52, .12], [.53, .9]], [[.55, .5], [.84, .49]], [[.2, .47], [.21, .9]], [[.03, .92], [.97, .9]]];
const TALLY_T = (() => { const out = []; TAPS.forEach((tp, k) => { const nx = k < TAPS.length - 1 ? TAPS[k + 1].t : T477, span = Math.min(.3, nx - tp.t) * .85;
  for (let j = 0; j < tp.n; j++) out.push(tp.t + span * j / tp.n); }); return out; })();
function drawTally(q, t) {
  const Z = TALLY.size;
  q.save(); q.lineCap = 'round'; q.lineJoin = 'round';
  for (const pass of [0, 1]) {
    q.beginPath();
    for (let i = 0; i < TALLY_T.length; i++) {
      if (t < TALLY_T[i]) break;
      const gl = Math.floor(i / 5), st = i % 5, col = gl % TALLY.cols, row = Math.floor(gl / TALLY.cols);
      const ox = TALLY.x0 + col * TALLY.cw + (hash(gl * 2.3) - .5) * 4, oy = TALLY.y0 + row * TALLY.ch + (hash(gl * 5.1) - .5) * 5;
      const sc = Z * (.88 + .16 * hash(gl * 3.7)), rot = (hash(gl * 8.3) - .5) * .14, cr = Math.cos(rot), sr = Math.sin(rot);
      const [[ax, ay], [bx, by]] = ZHENG[st], j = k => (hash(i * 9.7 + k) - .5) * .11;
      const u = clamp((t - TALLY_T[i]) / .05);                       // 一笔 0.05 s 画完
      const ex = ax + (bx - ax) * u, ey = ay + (by - ay) * u, off = pass ? .9 : 0;
      const P = (x, y) => [ox + ((x - .5) * cr - (y - .5) * sr + .5) * sc + off, oy + ((x - .5) * sr + (y - .5) * cr + .5) * sc];
      q.moveTo(...P(ax + j(1), ay + j(2))); q.lineTo(...P(ex + j(3), ey + j(4)));
    }
    q.lineWidth = pass ? 1.1 : 2.1; q.strokeStyle = pass ? 'rgba(30,53,80,.26)' : 'rgba(30,53,80,.62)'; q.stroke();
  }
  q.restore();
}
function drawData(q, t) {
  if (t < TAPS[0].t - .5 || t > 18.6) return;
  const F = fv(t);
  // 点
  let count = 0;
  q.save();
  for (const d of DOTS) {
    if (F < d.frame) continue; count++;
    const a = (F - d.frame) / FPS + (t - F / FPS), [x, y] = dotPos(d, t);
    const pop = a < .2 ? 1 + .6 * Math.sin(clamp(a / .2) * Math.PI) * (1 - a / .2 * .4) : 1;
    if (d.big <= 5 && a < .55 && t < T477) { const k = a / .55; q.strokeStyle = BLUE; q.globalAlpha = (1 - k) * .5; q.lineWidth = 1.3; q.beginPath(); q.arc(x, y, 6 * (1.2 + k * 2.6), 0, 7); q.stroke(); q.globalAlpha = 1; }
    q.beginPath(); q.arc(x, y, 5.3 * pop, 0, 7); q.fillStyle = BLUE; q.fill(); q.lineWidth = 1.1; q.strokeStyle = BLUE_D; q.stroke();
  }
  q.restore();
  // 纸边的铅笔正字划记：每条记录一笔，五笔一个「正」（不出现中间数字）
  drawTally(q, t);
  // 大号数字：g26 第 477 个点落下后「477」整体落下（墨色→朱红）→ g28 翻成 25
  if (F >= frameOf(T477)) {
    q.save(); q.beginPath(); q.rect(NUM.x - 30, NUM.y - NUM.size * .86, 520, NUM.size * 1.0); q.clip();
    q.font = `800 ${NUM.size}px InterX`; q.textBaseline = 'alphabetic';
    const flip = t >= TCLU ? eo(clamp((F - frameOf(TCLU) + 1) / 4)) : 0;
    if (flip < 1) {
      const a = t - T477, slam = 1 + .16 * Math.exp(-a / .045) + .05 * Math.exp(-a / .09) * Math.cos(a * 30);
      const red = clamp(a / .13), col = `rgb(${Math.round(lerp(43, 190, red))},${Math.round(lerp(39, 58, red))},${Math.round(lerp(35, 46, red))})`;
      q.save(); q.globalAlpha = (1 - flip) * clamp(.35 + a * 30); q.translate(NUM.x, NUM.y - flip * NUM.size * .9); q.scale(slam, slam); q.fillStyle = col; q.fillText('477', 0, 0); q.restore();
    }
    if (flip > 0) { q.fillStyle = VERM; q.fillText('25', NUM.x, NUM.y + (1 - flip) * NUM.size * .9); }
    q.restore();
  }
  // 分类名（蓝铅笔），并组时随簇移动
  if (t >= TNAMES) CLUSTERS.forEach((c, j) => {
    const t0 = fq(TNAMES + j * NAME_GAP); if (t < t0) return;
    const [x, y] = clusterPos(j, t);
    handText(q, c.name, x + 34, y + 10, { size: nameSize(c), color: BLUE_D, progress: seg(t, t0, t0 + NAME_DUR) });
  });
  // 红铅笔：圈住 25，写批注
  if (t >= NOTE.ring) pencilStroke(q, loopPath(NUM.x + 128, NUM.y - 72, 178, 104, 3, 1.12, -2.6), { color: RED, width: 3.2, progress: eo(seg(t, NOTE.ring, NOTE.ring + .22)), seed: 5 });
  if (t >= NOTE.t0) {
    const u = seg(t, NOTE.t0, NOTE.t1);
    handText(q, '是分类，', NUM.x + 4, NUM.y + 112, { size: 46, color: RED, progress: clamp(u / .42) });
    handText(q, '不是 IP 数', NUM.x + 4, NUM.y + 172, { size: 46, color: RED, progress: clamp((u - .42) / .58) });
  }
  // 四组轮廓与组名
  OUTLINE.forEach((o, gi) => {
    if (t < o.t) return;
    const [x0, y0, x1, y1] = REGIONS[gi], cx = (x0 + x1) / 2 + (GROUP_C[gi][0] - (x0 + x1) / 2) * .13, cy = (y0 + y1) / 2 + (GROUP_C[gi][1] - (y0 + y1) / 2) * .13;
    pencilStroke(q, loopPath(cx, cy, (x1 - x0) / 2 * .95, (y1 - y0) / 2 * .97, 11 + gi, 1.06, -2.5 + gi * .4, .55), { color: BLUE, width: 2.8, progress: eo(seg(t, o.t, o.t + o.dur)), seed: 9 + gi });
    handText(q, GROUPS[gi].name, x0 + 40, y0 + 64, { size: 39, color: BLUE, progress: seg(t, o.t + GNAME.d0, o.t + GNAME.d1) });
  });
}
function drawCaption(q, t) {
  if (t < CAPTION.t) return;
  sansText(q, '角色，是进入内容的入口', CAPTION.x, CAPTION.y, { size: 58, weight: 700, color: INK, align: 'center', from: 'left', progress: eo(seg(t, CAPTION.t, CAPTION.t + .42)) });
}

// ───────── 一个世界（不含放大镜与手中铅笔） ─────────
function drawScene(q, c, t) {
  q.setTransform(1, 0, 0, 1, 0, 0); q.fillStyle = '#050506'; q.fillRect(0, 0, W, H);
  setCam(q, c); drawDesk(q); drawTable(q);
  // 透光/不透明物件：画在 O 层，再乘以台面亮度场（只在这一层；IP 图不经过）
  O.setTransform(1, 0, 0, 1, 0, 0); O.clearRect(0, 0, W, H); setCam(O, c);
  drawPaper(O); drawCards(O); drawLyingPencil(O); drawStack(O); drawMount(O, t); drawSleeveBody(O, t);
  if (t < STABLE_T) {
    M.setTransform(1, 0, 0, 1, 0, 0); M.clearRect(0, 0, W, H); M.drawImage(OC, 0, 0);
    O.save(); O.globalCompositeOperation = 'multiply'; O.drawImage(TEXL, TABLE.x0, TABLE.y0, TABLE.x1 - TABLE.x0, TABLE.y1 - TABLE.y0);
    O.setTransform(1, 0, 0, 1, 0, 0); O.globalCompositeOperation = 'destination-in'; O.drawImage(MC, 0, 0); O.restore();
  }
  q.setTransform(1, 0, 0, 1, 0, 0); q.drawImage(OC, 0, 0);
  setCam(q, c);
  drawSlideImage(q, t); drawSleeveImages(q, t);
  drawSlideLabels(q, t); drawData(q, t); drawCaption(q, t);
}

// ───────── 放大镜 ─────────
const BARREL = .02;                                  // 镜内边缘桶形畸变（只作用于光学放大层）
const [LC, LQ] = mkC(480, 480);
let lensID = null;
function drawLoupe(q, c, t) {
  const P = loupePos(t), [sx, sy] = w2s(c, P[0], P[1]), z = c[2], r = LOUPE.r * z, sk = 40 * z, lit = avgLit;
  if (sx < -r - sk - 60 || sx > W + r + sk + 60 || sy < -r - sk - 60 || sy > H + r + sk + 60) return;
  q.setTransform(1, 0, 0, 1, 0, 0);
  // 接触阴影：偏右下，软（房间顶光；台面背光下阴影很淡）
  q.save(); q.filter = `blur(${(9 * z).toFixed(1)}px)`; q.strokeStyle = `rgba(22,26,34,${(.12 + .26 * lit).toFixed(3)})`; q.lineWidth = sk * .95;
  q.beginPath(); q.arc(sx + 10 * z, sy + 15 * z, r + sk * .52, 0, 7); q.stroke(); q.restore();
  // 亚克力裙边：半透明（约 0.5），被台面从下方照亮，外沿一圈亮边
  q.save(); q.beginPath(); q.arc(sx, sy, r + sk, 0, 7); q.arc(sx, sy, r, 0, 7, true);
  const gr = q.createRadialGradient(sx, sy, r, sx, sy, r + sk);
  gr.addColorStop(0, `rgba(150,162,178,${(.5 * lit).toFixed(3)})`); gr.addColorStop(.6, `rgba(196,207,221,${(.46 * lit).toFixed(3)})`); gr.addColorStop(1, `rgba(222,232,244,${(.52 * lit).toFixed(3)})`);
  q.fillStyle = gr; q.fill('evenodd');
  q.lineWidth = 2.6 * z; q.strokeStyle = `rgba(255,255,255,${(.92 * lit).toFixed(3)})`; q.beginPath(); q.arc(sx, sy, r + sk - 1.4 * z, 0, 7); q.stroke();
  q.lineWidth = 1.2 * z; q.strokeStyle = `rgba(110,120,136,${(.45 * lit).toFixed(3)})`; q.beginPath(); q.arc(sx, sy, r + sk - 5 * z, 0, 7); q.stroke();
  q.restore();
  // 镜内：同一世界的 1.6× 等比放大，再加约 2% 的边缘桶形畸变（像素重映射，只在镜内）
  const zz = z * LOUPE.mag, cc = [P[0] - (sx - W / 2) / zz, P[1] - (sy - H / 2) / zz, zz, 0];
  drawScene(S, cc, t);
  const Rb = Math.ceil(r * (1 + BARREL) + 3), bx = Math.round(sx) - Rb, by = Math.round(sy) - Rb, D = 2 * Rb;
  if (D <= 480) {
    const src = S.getImageData(bx, by, D, D), sd = src.data;
    if (!lensID || lensID.width !== D) lensID = LQ.createImageData(D, D);
    const od = lensID.data, cx0 = sx - bx, cy0 = sy - by, ir2 = 1 / (r * r);
    for (let py = 0; py < D; py++) for (let px = 0; px < D; px++) {
      const dx = px + .5 - cx0, dy = py + .5 - cy0, q2 = (dx * dx + dy * dy) * ir2, o = (py * D + px) * 4;
      if (q2 > 1.05) { od[o + 3] = 0; continue; }
      const f = 1 + BARREL * q2, fx = cx0 + dx * f - .5, fy = cy0 + dy * f - .5;
      const x0 = Math.max(0, Math.min(D - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(D - 2, Math.floor(fy))), ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
      const i00 = (y0 * D + x0) * 4, i10 = i00 + 4, i01 = i00 + D * 4, i11 = i01 + 4;
      for (let ch = 0; ch < 4; ch++) od[o + ch] = (sd[i00 + ch] * (1 - ax) + sd[i10 + ch] * ax) * (1 - ay) + (sd[i01 + ch] * (1 - ax) + sd[i11 + ch] * ax) * ay;
    }
    LQ.putImageData(lensID, 0, 0);
    q.save(); q.beginPath(); q.arc(sx, sy, r, 0, 7); q.clip(); q.drawImage(LC, 0, 0, D, D, bx, by, D, D); q.restore();
  } else { q.save(); q.beginPath(); q.arc(sx, sy, r, 0, 7); q.clip(); q.drawImage(SC, 0, 0); q.restore(); }
  // 镜圈：黑色金属圈 + 左上一处斜向高光 + 右下弱反光
  q.save(); q.lineWidth = 15 * z; q.strokeStyle = '#121315'; q.beginPath(); q.arc(sx, sy, r + 7 * z, 0, 7); q.stroke();
  q.lineCap = 'round';
  q.lineWidth = 9 * z; q.strokeStyle = 'rgba(255,255,255,.14)'; q.beginPath(); q.arc(sx, sy, r + 7 * z, Math.PI * 1.08, Math.PI * 1.46); q.stroke();
  q.lineWidth = 3.2 * z; q.strokeStyle = 'rgba(255,255,255,.78)'; q.beginPath(); q.arc(sx, sy, r + 6 * z, Math.PI * 1.16, Math.PI * 1.36); q.stroke();
  q.lineWidth = 2 * z; q.strokeStyle = 'rgba(255,255,255,.3)'; q.beginPath(); q.arc(sx, sy, r + 8 * z, Math.PI * .18, Math.PI * .3); q.stroke();
  q.lineWidth = 1.4 * z; q.strokeStyle = 'rgba(255,255,255,.28)'; q.beginPath(); q.arc(sx, sy, r - .8 * z, Math.PI * 1.1, Math.PI * 1.5); q.stroke();
  q.restore();
}

// ───────── 手中的红蓝铅笔（屏幕空间） ─────────
function pencilBody(q, end) {
  const Lg = 16, Lw = 58, Wd = 24, len = 1400;
  const cA = end === 'red' ? RED : BLUE, cB = end === 'red' ? BLUE : RED;
  q.fillStyle = cA; q.fillRect(Lg + Lw - 2, -Wd / 2, len * .5, Wd); q.fillStyle = cB; q.fillRect(Lg + Lw - 2 + len * .5, -Wd / 2, len * .5, Wd);
  q.fillStyle = 'rgba(255,255,255,.2)'; q.fillRect(Lg + Lw - 2, -Wd / 2 + 3, len, 5); q.fillStyle = 'rgba(0,0,0,.18)'; q.fillRect(Lg + Lw - 2, Wd / 2 - 6, len, 6);
  q.fillStyle = '#E3C79C'; q.beginPath(); q.moveTo(Lg * .9, -3.2); q.lineTo(Lg + Lw, -Wd / 2);
  for (let i = 0; i <= 6; i++) q.lineTo(Lg + Lw + (i % 2 ? 5 : 0), -Wd / 2 + Wd * i / 6); q.lineTo(Lg * .9, 3.2); q.closePath(); q.fill();
  q.fillStyle = end === 'red' ? '#8E2232' : '#274E75'; q.beginPath(); q.moveTo(0, 0); q.lineTo(Lg, -3.6); q.lineTo(Lg, 3.6); q.closePath(); q.fill();
}
function pencilState(t) {
  // 返回 { tip:[world], lift, end } 或 null
  const T0 = TAPS[0].t, TL = TAPS[TAPS.length - 1].t;
  const off = [FIELD.x1 + 420, FIELD.y1 + 380];
  if (t >= T0 - .55 && t < T0) { const u = eo(seg(t, T0 - .55, T0)); return { tip: [lerp(off[0], TAPS[0].cx, u), lerp(off[1], TAPS[0].cy, u)], lift: (1 - u) * 1.2, end: 'blue' }; }
  if (t >= T0 && t < TL) {
    let k = 0; while (k < TAPS.length - 1 && t >= TAPS[k + 1].t) k++;
    const a = TAPS[k], b = TAPS[k + 1], u = (t - a.t) / (b.t - a.t), gap = b.t - a.t;
    const p = eio(clamp((u - .08) / .8)), h = clamp(gap * 1.6, .18, .9);
    const jit = (hash(k * 5.3) - .5) * 4;
    return { tip: [lerp(a.cx, b.cx, p) + jit, lerp(a.cy, b.cy, p)], lift: Math.sin(Math.PI * clamp(u * 1.08)) * h, end: 'blue' };
  }
  if (t >= TL && t < TL + .7) { const u = ei(seg(t, TL + .05, TL + .7)), a = TAPS[TAPS.length - 1]; return { tip: [lerp(a.cx, off[0], u), lerp(a.cy, off[1], u)], lift: Math.min(1, u * 3) * .9 + Math.sin(Math.PI * clamp((t - TL) / .1)) * .2, end: 'blue' }; }
  // 红芯：圈 25、写批注、离开
  const ringC = [NUM.x + 128, NUM.y - 72], rin = NOTE.ring - .3;
  if (t >= rin && t < NOTE.ring) { const u = eo(seg(t, rin, NOTE.ring)), p0 = loopPath(ringC[0], ringC[1], 178, 104, 3, 1.12, -2.6)[0]; return { tip: [lerp(off[0] - 900, p0[0], u), lerp(off[1], p0[1], u)], lift: (1 - u), end: 'red' }; }
  if (t >= NOTE.ring && t < NOTE.ring + .22) { const pts = loopPath(ringC[0], ringC[1], 178, 104, 3, 1.12, -2.6), R = resample(pts), L = R.total * eo(seg(t, NOTE.ring, NOTE.ring + .22)); let i = 0; while (i < R.len.length - 1 && R.len[i] < L) i++; return { tip: R.pts[i], lift: 0, end: 'red' }; }
  if (t >= NOTE.ring + .22 && t < NOTE.t0) { const u = eio(seg(t, NOTE.ring + .22, NOTE.t0)), a = loopPath(ringC[0], ringC[1], 178, 104, 3, 1.12, -2.6).at(-1), b = [NUM.x + 12, NUM.y + 112 - 18]; return { tip: [lerp(a[0], b[0], u), lerp(a[1], b[1], u)], lift: Math.sin(Math.PI * u) * .4, end: 'red' }; }
  if (t >= NOTE.t0 && t < NOTE.t1) {
    const u = seg(t, NOTE.t0, NOTE.t1), l1 = u < .42, im = handImg(l1 ? '是分类，' : '不是 IP 数', 46, RED), pr = l1 ? u / .42 : (u - .42) / .58;
    const f = pr * im.tw, y = NUM.y + (l1 ? 112 : 172);
    return { tip: [NUM.x + 4 + f, y - 46 * (.3 + .2 * Math.sin(f * .5))], lift: 0, end: 'red' };
  }
  if (t >= NOTE.t1 && t < NOTE.t1 + .6) { const u = ei(seg(t, NOTE.t1, NOTE.t1 + .6)), a = [NUM.x + 260, NUM.y + 160]; return { tip: [lerp(a[0], off[0] - 600, u), lerp(a[1], off[1] + 200, u)], lift: Math.min(1, u * 3) * .9, end: 'red' }; }
  return null;
}
function drawHandPencil(q, c, t) {
  const st = pencilState(t); if (!st) return;
  const [sx, sy] = w2s(c, st.tip[0], st.tip[1]), s = c[2] * .95, lz = 1 + st.lift * .3, ang = .64;
  q.save(); q.setTransform(1, 0, 0, 1, 0, 0);
  // 影子：随抬笔变远变软
  const sh = 3 + st.lift * 60 * s;
  q.save(); q.filter = `blur(${(2 + st.lift * 14).toFixed(1)}px)`; q.globalAlpha = .2 - st.lift * .07;
  q.translate(sx + sh * .8, sy + sh * 1.1); q.rotate(ang); q.scale(s * lz, s * lz); q.fillStyle = 'rgb(70,50,30)';
  q.fillRect(0, -12, 1474, 24); q.restore();
  q.translate(sx, sy); q.rotate(ang); q.scale(s * lz, s * lz); pencilBody(q, st.end);
  q.restore();
}

// ───────── 一帧 ─────────
function frame(q, t) {
  buildTable(t);
  const c = camAt(t);
  drawScene(q, c, t);
  drawLoupe(q, c, t);
  drawHandPencil(q, c, t);
  // 轻暗角
  q.setTransform(1, 0, 0, 1, 0, 0);
  const vg = q.createRadialGradient(W / 2, H / 2, H * .45, W / 2, H / 2, H * 1.05);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.22)'); q.fillStyle = vg; q.fillRect(0, 0, W, H);
}
const inPan = t => PANS.some(([a, b]) => t > a + .02 && t < b - .02);
window.render = t => {
  if (!inPan(t)) { frame(X, t); return; }
  // 平移时的运动模糊：半个快门（1/60 s）内按屏幕速度取 4–20 个子采样平均
  const c0 = camAt(t - 1 / 120), c1 = camAt(t + 1 / 120), sp = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) * (c0[2] + c1[2]) / 2 + Math.abs(c1[2] - c0[2]) * 900;
  const N = clamp(Math.ceil(sp / 2.5), 4, 20);
  for (let j = 0; j < N; j++) {
    const tj = t + (j / (N - 1) - .5) / 60;
    frame(A, tj);
    X.setTransform(1, 0, 0, 1, 0, 0); X.globalAlpha = 1 / (j + 1); X.drawImage(AC, 0, 0); X.globalAlpha = 1;
  }
};

// ───────── 事件表（声音与对拍自检用） ─────────
const EV = [{ t: 0, type: 'grid', bpm: T.BPM, beat: T.B }];
LAMP_T.forEach((t, k) => EV.push({ t, type: 'lamp', k, tube: LAMP_ORDER[k], flick: FLICK[k], visual: true }));
EV.push({ t: SLIDE.t0, type: 'slide_move', t1: SLIDE.t1 }, { t: SLIDE.t1, type: 'slide', visual: true });
EV.push({ t: TITLE.t, type: 'label', what: 'title' }, { t: TITLE.sub, type: 'label', what: 'sub' }, { t: TAG.t, type: 'label', what: 'tag' });
EV.push({ t: LOUPE.t0, type: 'loupe_move', t1: LOUPE.t1 }, { t: LOUPE.t1, type: 'loupe' });
PANS.forEach(([a, b], k) => EV.push({ t: a, type: 'pan', t1: b, dir: k ? 1 : -1 }));
TAPS.forEach(tp => EV.push({ t: tp.t, type: 'tap', i: tp.i, n: tp.n, beat: tp.beat, frame: tp.frame, visual: true, grid: true }));
EV.push({ t: T477, type: 'n477', visual: true }, { t: T477, type: 'swarm', t1: TCLU }, { t: T.TREST, type: 'rest' }, { t: TCLU, type: 'clu', visual: true });
CLUSTERS.forEach((c, j) => EV.push({ t: fq(TNAMES + j * NAME_GAP), type: 'name', i: j, dur: NAME_DUR }));
EV.push({ t: NOTE.ring, type: 'ring', dur: .22 }, { t: NOTE.t0, type: 'note', t1: NOTE.t1 });
EV.push({ t: TMERGE, type: 'merge', visual: true });
OUTLINE.forEach((o, k) => EV.push({ t: o.t, type: 'outline', k, dur: o.dur, visual: true }));
EV.push({ t: CAPTION.t, type: 'caption' });
SLEEVES.forEach((s, k) => EV.push({ t: s.land - SLEEVE.fly, type: 'sleeve_fly', k, t1: s.land }, { t: s.land, type: 'sleeve', k, settle: s.settle, visual: true }));
EV.forEach(e => { if (e.frame === undefined) e.frame = frameOf(e.t); });
EV.sort((a, b) => a.t - b.t);
window.EV = EV;
window.DUR = T.DUR;
window.READY = true;
