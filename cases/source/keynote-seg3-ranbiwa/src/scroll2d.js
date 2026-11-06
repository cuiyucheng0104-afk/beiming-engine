// 手卷世界的 2D 绘制。世界坐标 = px（A11–A12 镜头 1:1），y 向下，手卷画芯带 y∈[-540,540]。
// 每次绘制输出两张图：A = 反照率（纸在白光下的样子），E = 自发光（背光透过纸的光）。屏幕 = A×室内光 + E。
import { clamp, lerp, seg, ss, eo, ei, mulberry, hash, vnoise, monotone, TAU } from '/core/lib.js';
import { T, b, BEAT, CAM_KEYS, CAM_C, DRIFT } from './timeline.js';

export const G = -4300, WP = 2340, HP = 1480, BAND = 540;   // 书脊（左右页分界）、页面尺寸（世界 px）
const camF = monotone(CAM_KEYS);
export function camX(t) {
  if (t < T.black) return camF(t);
  if (t < T.burst) return lerp(camF(T.black), CAM_C, ss((t - T.black) / BEAT));   // 黑拍里移动（看不见）
  return CAM_C - DRIFT * (t - T.burst);
}
export function shake(t) {
  const u = t - T.burst; if (u < 0 || u > .7) return [0, 0];
  const a = 9 * Math.exp(-u / .11);
  return [a * (vnoise(u * 38 + 3) * 2 - 1), a * .7 * (vnoise(u * 41 + 17) * 2 - 1)];
}

let IMG = null;
export function initScroll(imgs) { IMG = imgs; }

// —— 颜色 ——
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgb = (c, k = 1, a = 1) => { const [r, g, bb] = typeof c === 'string' ? hex(c) : c; return `rgba(${Math.round(clamp(r * k, 0, 255))},${Math.round(clamp(g * k, 0, 255))},${Math.round(clamp(bb * k, 0, 255))},${a})`; };
const mix = (c1, c2, u) => { const a = hex(c1), q = hex(c2); return [0, 1, 2].map(i => a[i] + (q[i] - a[i]) * u); };

// —— 点亮曲线 ——
export function ignite(t, t0, dur = .26) { if (t < t0) return 0; const u = (t - t0) / dur; if (u >= 1) return 1 + .04 * Math.exp(-(u - 1) * 3); return eo(u) * (1 + .12 * Math.sin(u * Math.PI)); }
const flick = (t, s) => 1 + .045 * Math.sin(7.3 * t + s) * Math.sin(3.1 * t + s * 1.7);

// —— 纸雕形状（Path2D，世界坐标，按 key 缓存）——
const PC = new Map();
const cached = (k, fn) => { if (!PC.has(k)) PC.set(k, fn()); return PC.get(k); };
function ridge(x0, x1, base, amp, seed, yb, smooth = 1) {
  const p = new Path2D(); p.moveTo(x0 - 10, yb);
  for (let x = x0 - 10; x <= x1 + 10; x += 6) {
    const n = vnoise((x + seed * 997) / (260 * smooth)) * .62 + vnoise((x + seed * 331) / (95 * smooth)) * .28 + vnoise((x + seed * 73) / 31) * .1 / smooth;
    p.lineTo(x, base - amp * Math.pow(n, 1.6) * 1.6);
  }
  p.lineTo(x1 + 10, yb); p.closePath(); return p;
}
function cloud(p, cx, cy, s, fl = 1) {
  const c = (x, y, r) => { p.moveTo(cx + fl * x * s + r * s, cy + y * s); p.arc(cx + fl * x * s, cy + y * s, r * s, 0, TAU); };
  c(-58, 6, 34); c(-12, -14, 46); c(40, 0, 36); c(78, 12, 22); c(-92, 16, 18);
  // 卷尾
  p.moveTo(cx + fl * 90 * s, cy + 26 * s);
  p.bezierCurveTo(cx + fl * 150 * s, cy + 30 * s, cx + fl * 185 * s, cy + 6 * s, cx + fl * 210 * s, cy + 24 * s);
  p.bezierCurveTo(cx + fl * 190 * s, cy + 34 * s, cx + fl * 150 * s, cy + 44 * s, cx + fl * 80 * s, cy + 40 * s); p.closePath();
  // 卷头的小圈
  c(-118, -18, 15); c(-130, -42, 9);
}
function waves(x0, x1, top, yb, seed) {
  const p = new Path2D(), R = mulberry(seed); p.moveTo(x0 - 10, yb); p.lineTo(x0 - 10, top + 40);
  let x = x0 - 10;
  while (x < x1 + 10) {
    const w = 110 + R() * 70, h = 50 + R() * 50, y = top + R() * 50;
    p.bezierCurveTo(x + w * .25, y + 10, x + w * .45, y - h, x + w * .78, y - h * .7);
    p.bezierCurveTo(x + w * .95, y - h * .55, x + w * .9, y - h * .1, x + w * .72, y - h * .2);
    p.bezierCurveTo(x + w * .8, y + 6, x + w * .95, y + 30, x + w, y + 32);
    x += w;
  }
  p.lineTo(x1 + 10, yb); p.closePath();
  // 浪花圈
  const R2 = mulberry(seed + 1);
  for (let i = 0; i < (x1 - x0) / 120; i++) { const cx = x0 + R2() * (x1 - x0), cy = top + 60 + R2() * 80, r = 6 + R2() * 9; p.moveTo(cx + r, cy); p.arc(cx, cy, r, 0, TAU); }
  return p;
}
function trees(x0, x1, base, seed, hmin, hmax) {
  const p = new Path2D(), R = mulberry(seed);
  p.moveTo(x0 - 10, base + 300); p.lineTo(x0 - 10, base);
  let x = x0;
  while (x < x1) {
    const h = hmin + R() * (hmax - hmin), w = h * (.32 + R() * .12);
    if (R() < .62) {   // 松
      p.lineTo(x, base);
      for (let k = 0; k < 4; k++) { const yy = base - h * (k / 4), ww = w * (1 - k / 5.2); p.lineTo(x + w / 2 - ww / 2, yy); p.lineTo(x + w / 2 - ww * .18, yy - h * .2); }
      p.lineTo(x + w / 2, base - h);
      for (let k = 3; k >= 0; k--) { const yy = base - h * (k / 4), ww = w * (1 - k / 5.2); p.lineTo(x + w / 2 + ww * .18, yy - h * .2); p.lineTo(x + w / 2 + ww / 2, yy); }
      p.lineTo(x + w, base);
    } else {           // 圆冠树
      p.lineTo(x + w * .45, base); p.lineTo(x + w * .45, base - h * .45);
      const r = w * .62; p.arc(x + w / 2, base - h * .45 - r * .8, r, Math.PI * .62, Math.PI * 2.38);
      p.lineTo(x + w * .55, base);
    }
    x += w * (.7 + R() * .5);
  }
  p.lineTo(x1 + 10, base); p.lineTo(x1 + 10, base + 300); p.closePath(); return p;
}
function ferns(x0, x1, top, yb, seed) {
  const p = new Path2D(), R = mulberry(seed); p.moveTo(x0 - 10, yb);
  for (let x = x0 - 10; x < x1 + 10; x += 16 + R() * 18) {
    const h = 40 + R() * 90, lean = (R() - .5) * 40;
    p.lineTo(x, top + 80); p.quadraticCurveTo(x + lean * .3, top + 80 - h * .6, x + lean, top + 80 - h); p.quadraticCurveTo(x + 6 + lean * .3, top + 80 - h * .5, x + 12, top + 80);
  }
  p.lineTo(x1 + 10, yb); p.closePath(); return p;
}
function flames(x0, x1, base, hmax, seed, yb) {
  const p = new Path2D(), R = mulberry(seed); p.moveTo(x0 - 10, yb); p.lineTo(x0 - 10, base);
  let x = x0 - 10;
  while (x < x1 + 10) {
    const w = 50 + R() * 60, h = hmax * (.35 + R() * .65), sw = (R() - .5) * w * 1.2;
    p.bezierCurveTo(x + w * .2, base - h * .35, x + w * .3 + sw * .5, base - h * .75, x + w * .5 + sw, base - h);
    p.bezierCurveTo(x + w * .55 + sw * .3, base - h * .6, x + w * .85, base - h * .3, x + w, base);
    x += w * .85;
  }
  p.lineTo(x1 + 10, yb); p.closePath(); return p;
}
const rectP = (x0, y0, x1, y1) => { const p = new Path2D(); p.rect(x0, y0, x1 - x0, y1 - y0); return p; };
function frameP(x0, y0, x1, y1, w, holes = []) {
  const p = new Path2D(); p.rect(x0, y0, x1 - x0, y1 - y0);
  for (const [a, bb, c, d] of [[x0 + w, y0 + w, x1 - w, y1 - w], ...holes]) { p.moveTo(a, bb); p.lineTo(a, d); p.lineTo(c, d); p.lineTo(c, bb); p.closePath(); }
  return p;
}

// 一层纸：软影+下沿暗带，上沿亮边，平色本体
function paper(ctx, path, o) {
  ctx.save();
  if (o.sh > 0) { ctx.shadowColor = `rgba(0,0,0,${o.sh})`; ctx.shadowBlur = o.blur ?? 16; ctx.shadowOffsetY = o.sdy ?? 9; ctx.shadowOffsetX = o.sdx ?? 0; }
  ctx.fillStyle = o.dark; ctx.translate(0, 3); ctx.fill(path, o.rule || 'nonzero'); ctx.restore();
  if (o.rim) { ctx.save(); ctx.translate(0, -2.5); ctx.fillStyle = o.rim; ctx.fill(path, o.rule || 'nonzero'); ctx.restore(); }
  ctx.fillStyle = o.body; ctx.fill(path, o.rule || 'nonzero');
}

// —— 灯箱定义 ——
const LIGHT = '#ffd9a0';   // 暖金背光
export const BOX = {
  A: { x0: -3020, x1: -990, y0: -400, y1: 400, fr: 24, div: [-1972, -1948] },
  B: { x0: -4210, x1: -3110, y0: -400, y1: 400, fr: 24 },
  C: { x0: -6120, x1: -4820, y0: -400, y1: 400, fr: 24 },
};
export const WIN = {
  whale: { cx: -1530, cy: -20, w: 700, h: 394, img: 'whale', key: () => T.whale },
  w0: { cx: -2110, cy: -70, w: 210, h: 210, img: 'w0', key: () => T.win[0], label: '如何成为三条龙' },
  w1: { cx: -2355, cy: -70, w: 210, h: 210, img: 'w1', key: () => T.win[1], label: '耳中人' },
  w2: { cx: -2600, cy: -70, w: 210, h: 210, img: 'w2', key: () => T.win[2], label: '小雪' },
  w3: { cx: -2845, cy: -70, w: 210, h: 210, img: 'w3', key: () => T.win[3], label: '大贵人' },
  lls: { cx: -3700, cy: -30, w: 720, h: 379, img: 'lls', key: () => T.llsWin },
  rbw: { cx: -5470, cy: -40, w: 760, h: 428, img: 'rbw', key: () => T.burst },
};
// 文字（id, 文本, 世界框, 出现时刻）——给 TEXTS/readcheck 用
export const TXT = [];
const titleCol = (id, text, cx, y0, size, keys) => TXT.push({ id, text, kind: 'title', cx, y0, size, keys, x0: cx - size / 2, x1: cx + size / 2, y1: y0 + size * text.length });
titleCol('t_zgqt', '中国奇谭', -1085, -300, 70, () => T.whaleTitle);
titleCol('t_lls', '浪浪山小妖怪', -3195, -330, 60, () => [T.llsTitle]);
titleCol('t_rbw', '燃比娃', -5985, -290, 80, () => T.rbwTitle);
const slip = (id, text, cx, cy, size, key, red) => { const w = measureW(text, size) + size * 1.4; TXT.push({ id, text, kind: 'slip', cx, cy, size, key, red, x0: cx - w / 2, x1: cx + w / 2, y0: cy - size * .95, y1: cy + size * .95 }); };
function measureW(text, size) { let w = 0; for (const ch of text) w += /[\x20-\x7e]/.test(ch) ? size * .56 : size; return w; }
for (const k of ['w0', 'w1', 'w2', 'w3']) slip('s_' + k, WIN[k].label, WIN[k].cx, WIN[k].cy + WIN[k].h / 2 + 46, 25, WIN[k].key);
slip('s_9', '9 部｜12 位导演｜2026.1.1', -2478, 250, 27, () => T.slip9, '9');
slip('s_lls', '2025.8.2', -3700, 238, 27, () => T.llsSlip);
slip('s_rbw', '宣纸手绘｜2026.4.28 内地公映', -5470, 258, 27, () => T.rbwSlip);

// —— 绘制入口 ——
// region: [rx, ry, rw, rh] 世界矩形；canvas 尺寸 = rw×rh（1:1）
// o: { t, cam (视差用的镜头 x), relit (页面模式：A、B 灯箱全亮), wantA (是否画反照率) }
export function drawWorld(A, E, region, o) {
  const [rx, ry, rw, rh] = region, t = o.t;
  for (const c of [A, E]) { if (!c) continue; c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none'; c.shadowColor = 'rgba(0,0,0,0)'; c.setTransform(1, 0, 0, 1, -rx, -ry); }
  E.fillStyle = '#000'; E.fillRect(rx, ry, rw, rh);
  const inR = (x0, x1, y0 = -1e9, y1 = 1e9) => x1 > rx && x0 < rx + rw && y1 > ry && y0 < ry + rh;
  if (A) drawPaperA(A, rx, ry, rw, rh);
  // 灯箱整体亮度（A、B 在 b24 熄灭；页面模式全亮）
  const offAB = !o.relit && t >= T.black ? 0 : 1;
  const L = {
    A: o.relit ? 1 : offAB * Math.max(ignite(t, T.L1) * .9, 0),
    B: o.relit ? 1 : offAB * ignite(t, T.forest),
    C: ignite(t, T.burst, .2),
  };
  // 溢光（把纸面从黑里照出来）
  spill(E, rx, ry, rw, rh, L, t, inR);
  if (inR(-930, 3000)) drawCurtain(A, E, t, o);
  if (inR(BOX.A.x0 - 60, BOX.A.x1 + 60)) drawBoxA(A, E, t, o, offAB);
  if (inR(BOX.B.x0 - 60, BOX.B.x1 + 60)) drawBoxB(A, E, t, o, offAB);
  if (inR(BOX.C.x0 - 900, BOX.C.x1 + 900)) drawBoxC(A, E, t, o);
}

let tmp = null;
function spill(E, rx, ry, rw, rh, L, t, inR) {
  const list = [];
  const fl = flick(t, 1.3);
  if (L.A > 0 && inR(BOX.A.x0 - 700, BOX.A.x1 + 700)) list.push([(BOX.A.x0 + BOX.A.x1) / 2, 0, 1250, LIGHT, .30 * L.A * fl]);
  if (L.B > 0 && inR(BOX.B.x0 - 700, BOX.B.x1 + 700)) list.push([(BOX.B.x0 + BOX.B.x1) / 2, 0, 900, '#e9e0a8', .26 * L.B * fl]);
  if (L.C > 0 && inR(BOX.C.x0 - 900, BOX.C.x1 + 900)) { const k = .34 * L.C * burstEnv(t); list.push([BOX.C.x0 + 250, -120, 950, '#ff6a3c', k]); list.push([BOX.C.x1 - 250, 80, 950, '#5a8cff', k * .9]); }
  if (!list.length) return;
  if (!tmp || tmp.width !== rw || tmp.height !== rh) { tmp = document.createElement('canvas'); tmp.width = rw; tmp.height = rh; }
  const x = tmp.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-over'; x.fillStyle = '#000'; x.fillRect(0, 0, rw, rh);
  x.setTransform(1, 0, 0, 1, -rx, -ry); x.globalCompositeOperation = 'lighter';
  for (const [cx, cy, r, col, k] of list) { const g = x.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, rgb(col, k)); g.addColorStop(.45, rgb(col, k * .45)); g.addColorStop(1, 'rgba(0,0,0,1)'); x.fillStyle = g; x.fillRect(cx - r, cy - r, 2 * r, 2 * r); }
  x.globalCompositeOperation = 'multiply'; x.fillStyle = PAT.paper(x); x.fillRect(rx, ry, rw, rh);
  E.save(); E.setTransform(1, 0, 0, 1, 0, 0); E.globalCompositeOperation = 'lighter'; E.drawImage(tmp, 0, 0); E.restore();
}

// —— 纸与装裱 ——
const PAT = {
  _c: new Map(),
  wm: new WeakMap(),
  get(ctx, key, img, sc) { let m = this.wm.get(ctx); if (!m) this.wm.set(ctx, m = {}); if (!m[key]) { m[key] = ctx.createPattern(img, 'repeat'); m[key].setTransform(new DOMMatrix().scale(sc)); } return m[key]; },
  paper(ctx) { return this.get(ctx, 'paper', IMG.paper, 1.3); },
  back(ctx) { return this.get(ctx, 'back', IMG.paperBack, 1.1); },
  silk(ctx) { return this.get(ctx, 'silk', IMG.silk, .9); },
  curtain(ctx) { return this.get(ctx, 'curtain', IMG.curtainTile, 1); },
};
function drawPaperA(A, rx, ry, rw, rh) {
  A.fillStyle = PAT.silk(A); A.fillRect(rx, ry, rw, rh);
  A.fillStyle = 'rgba(214,196,160,.18)'; A.fillRect(rx, ry, rw, rh);
  A.fillStyle = PAT.paper(A); A.fillRect(rx, -BAND, rw, 2 * BAND);
  // 隔水与画芯边线
  A.fillStyle = '#cdbb94'; A.fillRect(rx, -BAND - 16, rw, 10); A.fillRect(rx, BAND + 6, rw, 10);
  A.fillStyle = 'rgba(70,50,30,.55)'; A.fillRect(rx, -BAND - 2, rw, 2); A.fillRect(rx, BAND, rw, 2);
}

// —— 棉布幕（承接片段二）——
function drawCurtain(A, E, t, o) {
  const x0 = -930, x1 = 3200, y0 = -BAND, y1 = BAND;
  if (A) { A.fillStyle = PAT.curtain(A); A.fillRect(x0, y0, x1 - x0, y1 - y0); }
  let k = 0;
  if (!o.relit) {
    if (t < T.snuff) k = flick(t * 1.7, .4) * (1 + .05 * Math.sin(t * 23) * Math.sin(t * 9.1));
    else { const u = t - T.snuff; k = Math.exp(-u / .085) * (u < .06 ? 1 + 2.2 * u : 1); if (u > .5) k = 0; }
  }
  if (k > .002) {
    const g = E.createRadialGradient(1150, 60, 30, 1150, 60, 1650);
    g.addColorStop(0, rgb('#fff0c8', k)); g.addColorStop(.18, rgb('#ffd08a', k)); g.addColorStop(.55, rgb('#b8682a', k)); g.addColorStop(1, rgb('#2a1206', k));
    E.fillStyle = g; E.fillRect(x0, y0, x1 - x0, y1 - y0);
    E.save(); E.globalCompositeOperation = 'multiply'; E.fillStyle = PAT.curtain(E); E.fillRect(x0, y0, x1 - x0, y1 - y0); E.restore();
  }
  // 幕框
  if (A) { A.fillStyle = '#3a2a1c'; A.fillRect(x0 - 22, y0, 22, y1 - y0); }
  E.fillStyle = rgb('#ffb060', k * .12); E.fillRect(x0 - 22, y0, 22, y1 - y0);
}

// —— 通用：灯箱框、窗口、标题、题签 ——
function boxFrame(A, E, bx, lit, extraHoles = []) {
  const p = cached('frame' + bx.x0, () => {
    const p = new Path2D(); p.rect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0);
    p.rect(bx.x0 + bx.fr, bx.y0 + bx.fr, bx.x1 - bx.x0 - 2 * bx.fr, bx.y1 - bx.y0 - 2 * bx.fr); return p;
  });
  if (A) { A.fillStyle = '#24170f'; A.fill(p, 'evenodd'); A.strokeStyle = 'rgba(160,120,80,.35)'; A.lineWidth = 2; A.strokeRect(bx.x0 + 1, bx.y0 + 1, bx.x1 - bx.x0 - 2, bx.y1 - bx.y0 - 2); }
  E.fillStyle = '#000'; E.fill(p, 'evenodd');
  if (bx.div) { if (A) { A.fillStyle = '#24170f'; A.fillRect(bx.div[0], bx.y0, bx.div[1] - bx.div[0], bx.y1 - bx.y0); } E.fillStyle = '#000'; E.fillRect(bx.div[0], bx.y0, bx.div[1] - bx.div[0], bx.y1 - bx.y0); }
  // 框内沿被灯照亮的一线
  if (lit > 0) { E.strokeStyle = rgb(LIGHT, .22 * lit); E.lineWidth = 2; E.strokeRect(bx.x0 + bx.fr - 1, bx.y0 + bx.fr - 1, bx.x1 - bx.x0 - 2 * bx.fr + 2, bx.y1 - bx.y0 - 2 * bx.fr + 2); }
}
function clipInner(ctx, bx) { ctx.save(); ctx.beginPath(); ctx.rect(bx.x0 + bx.fr, bx.y0 + bx.fr, bx.x1 - bx.x0 - 2 * bx.fr, bx.y1 - bx.y0 - 2 * bx.fr); ctx.clip(); }
// 图片窗口：卡纸窗框 + 原图（E 里按背光亮度整体明暗，不改像素）
function windowFrame(A, E, w, lit, ox, emi = 1) {
  const fw = Math.max(10, Math.round(w.w * .022)), x0 = w.cx - w.w / 2, y0 = w.cy - w.h / 2;
  const fp = cached('wf' + w.img, () => { const p = new Path2D(); p.rect(x0 - fw, y0 - fw, w.w + 2 * fw, w.h + 2 * fw); p.rect(x0, y0, w.w, w.h); return p; });
  const img = IMG[w.img];
  for (const c of [A, E]) if (c) { c.save(); c.translate(ox, 0); }
  if (A) {
    paper(A, fp, { body: '#2b2a3a', rim: '#6b6a7a', dark: '#0e0d14', sh: .35, rule: 'evenodd' });
    A.drawImage(img, x0, y0, w.w, w.h);
  }
  E.save(); E.shadowColor = 'rgba(0,0,0,.55)'; E.shadowBlur = 18; E.shadowOffsetY = 10; E.fillStyle = '#000'; E.fillRect(x0 - fw, y0 - fw, w.w + 2 * fw, w.h + 2 * fw); E.restore();
  if (lit > 0) {
    E.save(); E.globalAlpha = clamp(lit * emi, 0, 1); E.drawImage(img, x0, y0, w.w, w.h); E.restore();
    E.strokeStyle = rgb(LIGHT, .35 * clamp(lit, 0, 1)); E.lineWidth = 2; E.strokeRect(x0 - fw + 1, y0 - fw + 1, w.w + 2 * fw - 2, w.h + 2 * fw - 2);
  }
  for (const c of [A, E]) if (c) c.restore();
}
function glyphs(A, E, tx, lit, col, glow) {
  // tx: 标题列；lit: 每字亮度数组
  const s = tx.size;
  [...tx.text].forEach((ch, i) => {
    const y = tx.y0 + s * (i + .5);
    if (A) { A.font = `${s}px MSZ`; A.textAlign = 'center'; A.textBaseline = 'middle'; A.fillStyle = '#d9cfb8'; A.fillText(ch, tx.cx, y); }
    const k = lit[Math.min(i, lit.length - 1)];
    E.font = `${s}px MSZ`; E.textAlign = 'center'; E.textBaseline = 'middle';
    if (k > 0) { E.save(); E.shadowColor = rgb(glow, Math.min(1, k)); E.shadowBlur = 22; E.fillStyle = rgb(col, Math.min(1.1, k)); E.fillText(ch, tx.cx, y); E.restore(); }
  });
}
function titleCard(A, E, tx, body, bodyE) {
  const pad = tx.size * .22, p = cached('tc' + tx.id, () => rectP(tx.x0 - pad, tx.y0 - pad * 1.6, tx.x1 + pad, tx.y1 + pad * 1.6));
  if (A) paper(A, p, { body, rim: rgb(body, 1.6), dark: rgb(body, .5), sh: .4 });
  paper(E, p, { body: bodyE, rim: rgb(LIGHT, .25), dark: '#000', sh: .5 });
}
// 题签：从左端"写"出来（0.2 s），在拍上写满
function slipAt(A, E, s, t, k, relit, off = 1) {
  if (relit) return slipDraw(A, E, s, 1, 1);
  const g = clamp((t - (k - .2)) / .2); if (g <= 0 || off <= 0) return;
  slipDraw(A, E, s, off * (1 + .25 * Math.exp(-Math.max(0, t - k) / .15)), eo(g));
}
function slipDraw(A, E, s, lit, grow = 1) {
  if (grow < 1) { for (const c of [A, E]) if (c) { c.save(); c.beginPath(); c.rect(s.x0 - 20, s.y0 - 30, (s.x1 - s.x0 + 40) * grow, s.y1 - s.y0 + 60); c.clip(); } }
  slipDraw0(A, E, s, lit);
  if (grow < 1) for (const c of [A, E]) if (c) c.restore();
}
function slipDraw0(A, E, s, lit) {
  const p = cached('sl' + s.id, () => rectP(s.x0, s.y0, s.x1, s.y1));
  const draw = (ctx, paperCol, ink, red) => {
    ctx.font = `500 ${s.size}px NSC`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let x = s.cx - measureW(s.text, s.size) / 2;
    for (const ch of s.text) { const w = /[\x20-\x7e]/.test(ch) ? s.size * .56 : s.size; ctx.fillStyle = s.red && ch === s.red ? red : ink; ctx.fillText(ch, x + (w - ctx.measureText(ch).width) / 2, s.cy + 1); x += w; }
  };
  if (A) { paper(A, p, { body: '#efe6d0', rim: '#fff8e6', dark: '#8a7a60', sh: .35 }); A.save(); A.globalAlpha = .25; A.fillStyle = PAT.paper(A); A.fill(p); A.restore(); draw(A, '#efe6d0', '#5A534A', '#BE3A2E'); }
  if (lit > 0) {
    const k = clamp(lit, 0, 1.05) * .92;
    paper(E, p, { body: rgb('#f3e3bd', k), rim: rgb('#fff4d8', k), dark: '#000', sh: .5 });
    E.save(); E.globalCompositeOperation = 'multiply'; E.globalAlpha = .35; E.fillStyle = PAT.back(E); E.fill(p); E.restore();
    draw(E, null, rgb('#3a3128', k * .9), rgb('#9a2a20', k * 1.1));
  } else { E.fillStyle = '#000'; E.fill(p); }
}

// —— 灯箱 A：中国奇谭（鲸鱼）+ 中国奇谭2（四窗）——
function drawBoxA(A, E, t, o, off) {
  const bx = BOX.A, cx = (bx.x0 + bx.x1) / 2, par = d => (o.relit ? 0 : (o.cam - cx) * d);
  const lt = (k, d = .26) => o.relit ? 1 : off * ignite(t, k, d);
  const fl = flick(t, 2.1);
  const l1 = lt(T.L1) * fl, l2 = lt(T.L2), l3 = lt(T.L3), l4 = lt(T.L4);
  for (const c of [A, E]) if (c) clipInner(c, bx);
  // 天幕（背光面板）
  if (A) { A.fillStyle = '#cdd6e8'; A.fillRect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0); }
  E.fillStyle = rgb('#101c44', l1); E.fillRect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0);
  if (l1 > 0) {
    E.save(); E.globalCompositeOperation = 'lighter';
    for (const [lx, ly, r, k] of [[-1500, 40, 760, 1], [-2480, 10, 700, .85]]) {
      const g = E.createRadialGradient(lx + par(.02), ly, 0, lx + par(.02), ly, r); g.addColorStop(0, rgb('#c8d4f0', .95 * k * l1)); g.addColorStop(.5, rgb('#5a74b8', .6 * k * l1)); g.addColorStop(1, 'rgba(0,0,0,0)');
      E.fillStyle = g; E.fillRect(lx - r + par(.02), ly - r, 2 * r, 2 * r);
    }
    E.restore();
  }
  // 月（天幕上的孔）
  const mx = -1262 + par(.03), my = -292;
  if (A) { A.fillStyle = '#f2ead6'; A.beginPath(); A.arc(mx, my, 50, 0, TAU); A.fill(); }
  if (l2 > 0) {
    E.save(); E.globalCompositeOperation = 'lighter'; const g = E.createRadialGradient(mx, my, 40, mx, my, 190); g.addColorStop(0, rgb('#ffe9b8', .55 * l2)); g.addColorStop(1, 'rgba(0,0,0,0)'); E.fillStyle = g; E.fillRect(mx - 190, my - 190, 380, 380); E.restore();
    E.fillStyle = rgb('#fff3d2', Math.min(1.08, l2)); E.beginPath(); E.arc(mx, my, 50, 0, TAU); E.fill();
  }
  // 远山
  E.save(); E.translate(par(.05), 0); if (A) { A.save(); A.translate(par(.05), 0); }
  const pM = cached('A_m', () => ridge(bx.x0, bx.x1, 120, 150, 3, bx.y1 + 20));
  if (A) paper(A, pM, { body: '#9eafd0', rim: '#d6e0f2', dark: '#6f80a8', sh: .25 });
  paper(E, pM, { body: rgb('#5a72a6', l1), rim: rgb(LIGHT, .55 * l1), dark: rgb('#1a2650', l1), sh: .45 });
  E.restore(); if (A) A.restore();
  // 祥云
  E.save(); E.translate(par(.08), 0); if (A) { A.save(); A.translate(par(.08), 0); }
  const pC = cached('A_c', () => { const p = new Path2D(); for (const [x, y, s, f] of [[-2010, -300, 1, 1], [-1370, -230, .75, -1], [-2730, -290, .95, -1], [-2260, -170, .6, 1], [-1110, -120, .7, 1], [-2930, -120, .6, 1], [-1700, 250, .7, -1], [-2550, 210, .55, 1]]) cloud(p, x, y, s, f); return p; });
  if (A) paper(A, pC, { body: '#7088ba', rim: '#b8c8e8', dark: '#4a5f90', sh: .3 });
  paper(E, pC, { body: rgb('#3b5592', l3 * fl), rim: rgb(LIGHT, .7 * l3), dark: rgb('#0c1430', l3), sh: .5 });
  E.restore(); if (A) A.restore();
  // 图片窗（中层）
  const ow = par(.11);
  windowFrame(A, E, WIN.whale, o.relit ? 1 : off * ignite(t, T.whale, .32) * fl, ow);
  for (const k of ['w0', 'w1', 'w2', 'w3']) windowFrame(A, E, WIN[k], o.relit ? 1 : off * ignite(t, WIN[k].key(), .22) * fl, ow);
  // 前景水浪 + 标题卡（前层）
  E.save(); E.translate(par(.16), 0); if (A) { A.save(); A.translate(par(.16), 0); }
  const pW = cached('A_w', () => waves(bx.x0, bx.x1, 285, bx.y1 + 20, 11));
  if (A) paper(A, pW, { body: '#1e2b52', rim: '#5d6f9c', dark: '#0c1228', sh: .45 });
  paper(E, pW, { body: rgb('#0a1230', l4), rim: rgb(LIGHT, .85 * l4), dark: '#000', sh: .6 });
  const tz = TXT.find(x => x.id === 't_zgqt');
  titleCard(A, E, tz, '#1b2546', rgb('#070b1c', 1));
  glyphs(A, E, tz, o.relit ? [1, 1, 1, 1] : T.whaleTitle.map(k => off * ignite(t, k, .18)), '#ffe2ad', '#ffb760');
  E.restore(); if (A) A.restore();
  // 题签（最前）
  E.save(); E.translate(par(.18), 0); if (A) { A.save(); A.translate(par(.18), 0); }
  for (const k of ['w0', 'w1', 'w2', 'w3']) slipAt(A, E, TXT.find(x => x.id === 's_' + k), t, WIN[k].key(), o.relit, off);
  slipAt(A, E, TXT.find(x => x.id === 's_9'), t, T.slip9, o.relit, off);
  E.restore(); if (A) A.restore();
  // 灯箱内的纸浆纹（只在纸层上，图片已画过但被前层盖住的部分不受影响：纹理只乘在天幕与纸层区域，窗口单独再画一次）
  for (const c of [A, E]) if (c) c.restore();
  boxFrame(A, E, bx, l1);
}

// —— 灯箱 B：浪浪山 ——
function drawBoxB(A, E, t, o, off) {
  const bx = BOX.B, cx = (bx.x0 + bx.x1) / 2, par = d => (o.relit ? 0 : (o.cam - cx) * d);
  const lt = (k, d = .26) => o.relit ? 1 : off * ignite(t, k, d);
  const fl = flick(t, 4.2), l0 = lt(T.forest) * fl, l1 = lt(T.forest + .12), l2 = lt(T.forest + .24);
  for (const c of [A, E]) if (c) clipInner(c, bx);
  if (A) { A.fillStyle = '#e2e6cf'; A.fillRect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0); }
  E.fillStyle = rgb('#0e2216', l0); E.fillRect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0);
  if (l0 > 0) { E.save(); E.globalCompositeOperation = 'lighter'; const g = E.createRadialGradient(-3700 + par(.02), -40, 0, -3700 + par(.02), -40, 720); g.addColorStop(0, rgb('#e8e4b0', .95 * l0)); g.addColorStop(.55, rgb('#6f8a52', .55 * l0)); g.addColorStop(1, 'rgba(0,0,0,0)'); E.fillStyle = g; E.fillRect(-4420, -760, 1440, 1440); E.restore(); }
  // 浪浪的远山
  E.save(); E.translate(par(.05), 0); if (A) { A.save(); A.translate(par(.05), 0); }
  const pM = cached('B_m', () => ridge(bx.x0, bx.x1, 40, 170, 21, bx.y1 + 20, 1.8));
  if (A) paper(A, pM, { body: '#aabd9f', rim: '#dbe6cf', dark: '#7d9172', sh: .25 });
  paper(E, pM, { body: rgb('#6c8c5e', l0), rim: rgb(LIGHT, .55 * l0), dark: rgb('#1c2c18', l0), sh: .45 });
  E.restore(); if (A) A.restore();
  // 中林
  E.save(); E.translate(par(.09), 0); if (A) { A.save(); A.translate(par(.09), 0); }
  const pT = cached('B_t', () => trees(bx.x0 - 20, bx.x1 + 20, 230, 33, 130, 260));
  if (A) paper(A, pT, { body: '#5b7a55', rim: '#9fbe92', dark: '#3a5236', sh: .3 });
  paper(E, pT, { body: rgb('#2c4a2e', l1 * fl), rim: rgb(LIGHT, .75 * l1), dark: rgb('#06100a', l1), sh: .5 });
  E.restore(); if (A) A.restore();
  windowFrame(A, E, WIN.lls, o.relit ? 1 : off * ignite(t, T.llsWin, .32) * fl, par(.11));
  // 前景草 + 标题卡
  E.save(); E.translate(par(.16), 0); if (A) { A.save(); A.translate(par(.16), 0); }
  const pF = cached('B_f', () => ferns(bx.x0, bx.x1, 270, bx.y1 + 20, 41));
  if (A) paper(A, pF, { body: '#203022', rim: '#5f7a5c', dark: '#0d150e', sh: .45 });
  paper(E, pF, { body: rgb('#07110a', l2), rim: rgb(LIGHT, .8 * l2), dark: '#000', sh: .6 });
  const tl = TXT.find(x => x.id === 't_lls');
  titleCard(A, E, tl, '#1d2a1e', '#050a06');
  glyphs(A, E, tl, [o.relit ? 1 : off * ignite(t, T.llsTitle, .2)], '#f6ecb8', '#e8c860');
  E.restore(); if (A) A.restore();
  E.save(); E.translate(par(.18), 0); if (A) { A.save(); A.translate(par(.18), 0); }
  slipAt(A, E, TXT.find(x => x.id === 's_lls'), t, T.llsSlip, o.relit, off);
  E.restore(); if (A) A.restore();
  for (const c of [A, E]) if (c) c.restore();
  boxFrame(A, E, bx, l0);
}

// —— 灯箱 C：燃比娃 ——
export function burstEnv(t) {
  const u = t - T.burst; if (u < 0) return 0;
  let k = .32 + .68 * Math.exp(-u / .55) + .5 * Math.exp(-u / .12);
  for (const p of T.pulse) { const v = t - p; if (v >= 0) k += .35 * Math.exp(-v / .45); }
  return k;
}
function drawBoxC(A, E, t, o) {
  const bx = BOX.C, w = WIN.rbw, cx = (bx.x0 + bx.x1) / 2, par = d => (o.cam - cx) * d;
  const on = ignite(t, T.burst, .12), env = burstEnv(t), fl = flick(t, 6.6) * (1 + .06 * Math.sin(t * 17) * Math.sin(t * 5.3));
  const l1 = ignite(t, T.burst + .08, .2), l2 = ignite(t, T.burst + .16, .2);
  for (const c of [A, E]) if (c) clipInner(c, bx);
  if (A) { A.fillStyle = '#dccbb6'; A.fillRect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0); }
  E.fillStyle = '#000'; E.fillRect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0);
  if (on > 0) {
    const k = on * fl * Math.min(1.25, .55 + .45 * env);
    const g = E.createLinearGradient(bx.x0, 0, bx.x1, 0); g.addColorStop(0, rgb('#ff4a26', k)); g.addColorStop(.42, rgb('#ffb070', k)); g.addColorStop(.58, rgb('#a8c0ff', k)); g.addColorStop(1, rgb('#2a5cff', k));
    E.fillStyle = g; E.fillRect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0);
    const g2 = E.createLinearGradient(0, bx.y0, 0, bx.y1); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,.55)'); E.fillStyle = g2; E.fillRect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0);
  }
  // 群山
  E.save(); E.translate(par(.05), 0); if (A) { A.save(); A.translate(par(.05), 0); }
  const pM = cached('C_m', () => ridge(bx.x0, bx.x1, 140, 260, 57, bx.y1 + 20, .8));
  if (A) paper(A, pM, { body: '#8c5a4a', rim: '#caa08a', dark: '#5a3226', sh: .3 });
  paper(E, pM, { body: rgb('#4a1a24', l1 * fl), rim: rgb('#ffb070', .8 * l1), dark: '#000', sh: .55 });
  E.restore(); if (A) A.restore();
  // 窗：宣纸被光烧透
  rbwWindow(A, E, t, w, par(.11));
  // 火舌（前层）+ 标题卡
  E.save(); E.translate(par(.16), 0); if (A) { A.save(); A.translate(par(.16), 0); }
  const pF = cached('C_f', () => { const p = flames(bx.x0, bx.x1, 330, 170, 77, bx.y1 + 20); return p; });
  const pS = cached('C_s', () => { const p = new Path2D(); cloud(p, -6010, -330, .8, 1); cloud(p, -4950, -340, .75, -1); return p; });
  if (A) { paper(A, pF, { body: '#3a1a14', rim: '#a8664a', dark: '#1a0a06', sh: .45 }); paper(A, pS, { body: '#3a1a14', rim: '#a8664a', dark: '#1a0a06', sh: .45 }); }
  paper(E, pF, { body: rgb('#160606', l2), rim: rgb('#ff9a50', 1.0 * l2 * fl), dark: '#000', sh: .65 });
  paper(E, pS, { body: rgb('#100408', l2), rim: rgb('#7aa0ff', .8 * l2), dark: '#000', sh: .6 });
  const tr = TXT.find(x => x.id === 't_rbw');
  titleCard(A, E, tr, '#2a1410', '#060202');
  glyphs(A, E, tr, T.rbwTitle.map(k => ignite(t, k, .16)), '#ffc49a', '#ff5a2a');
  E.restore(); if (A) A.restore();
  E.save(); E.translate(par(.18), 0); if (A) { A.save(); A.translate(par(.18), 0); }
  slipAt(A, E, TXT.find(x => x.id === 's_rbw'), t, T.rbwSlip, false, 1);
  E.restore(); if (A) A.restore();
  for (const c of [A, E]) if (c) c.restore();
  boxFrame(A, E, bx, on);
  // 迸出的红蓝光 + 火星（窗口外，不碰原图）
  if (on > 0) rays(E, t, w, par(.11), env);
}
const BURN = 0.5;   // 烧透用时
function burnPath(w, ox, R) {
  const p = new Path2D(), n = 72;
  for (let i = 0; i <= n; i++) { const a = i / n * TAU, rr = R * (1 + .16 * (vnoise(i * .37 + 5) - .5) + .08 * (vnoise(i * 1.3 + 9) - .5)); const x = w.cx + ox + Math.cos(a) * rr * 1.18, y = w.cy + Math.sin(a) * rr * .82; i ? p.lineTo(x, y) : p.moveTo(x, y); }
  p.closePath(); return p;
}
function rbwWindow(A, E, t, w, ox) {
  for (const c of [A, E]) if (c) { c.save(); c.translate(ox, 0); }
  rbwWindow0(A, E, t, w);
  for (const c of [A, E]) if (c) c.restore();
}
function rbwWindow0(A, E, t, w) {
  const ox = 0, x0 = w.cx - w.w / 2, y0 = w.cy - w.h / 2, fw = 16, img = IMG.rbw;
  const fp = cached('wfr', () => { const p = new Path2D(); p.rect(x0 - fw, y0 - fw, w.w + 2 * fw, w.h + 2 * fw); p.rect(x0, y0, w.w, w.h); return p; });
  if (A) { paper(A, fp, { body: '#2a1a16', rim: '#7a5a4a', dark: '#0e0806', sh: .35, rule: 'evenodd' }); A.drawImage(img, x0, y0, w.w, w.h); }
  E.save(); E.shadowColor = 'rgba(0,0,0,.6)'; E.shadowBlur = 18; E.shadowOffsetY = 10; E.fillStyle = '#000'; E.fillRect(x0 - fw, y0 - fw, w.w + 2 * fw, w.h + 2 * fw); E.restore();
  const u = t - T.burst; if (u < 0) return;
  const full = Math.hypot(w.w, w.h) * .62, R = full * eo(clamp(u / BURN)) * 1.02;
  const lit = clamp(ignite(t, T.burst, .1), 0, 1);
  E.save(); E.beginPath(); E.rect(x0, y0, w.w, w.h); E.clip();
  if (u < BURN + .05) {
    // 未烧到的宣纸：背光透亮
    const k = (.75 + .5 * Math.min(1, u / .12)) * lit;
    E.fillStyle = rgb('#fff1d6', k); E.fillRect(x0, y0, w.w, w.h);
    E.globalCompositeOperation = 'multiply'; E.fillStyle = PAT.back(E); E.fillRect(x0, y0, w.w, w.h); E.globalCompositeOperation = 'source-over';
    const bp = burnPath(w, ox, R);
    E.save(); E.clip(bp); E.drawImage(img, x0, y0, w.w, w.h); E.restore();
    // 烧透的边缘（只在边缘这一圈，0.5 s 内消失）
    E.save(); E.globalCompositeOperation = 'lighter'; E.lineJoin = 'round';
    E.strokeStyle = rgb('#ff8a3a', .9); E.lineWidth = 34; E.shadowColor = '#ff6020'; E.shadowBlur = 30; E.stroke(bp);
    E.strokeStyle = rgb('#fff0c0', .95); E.lineWidth = 9; E.shadowBlur = 0; E.stroke(bp); E.restore();
  } else {
    E.drawImage(img, x0, y0, w.w, w.h);   // 原图，原样
  }
  E.restore();
  E.strokeStyle = rgb('#ffb880', .4); E.lineWidth = 2; E.strokeRect(x0 - fw + 1, y0 - fw + 1, w.w + 2 * fw - 2, w.h + 2 * fw - 2);
}
function rays(E, t, w, ox, env) {
  const cx = w.cx + ox, cy = w.cy, x0 = cx - w.w / 2 - 16, y0 = cy - w.h / 2 - 16, W = w.w + 32, H = w.h + 32;
  E.save();
  E.beginPath(); E.rect(-1e5, -1e5, 2e5, 2e5); E.rect(x0, y0, W, H); E.clip('evenodd');
  E.globalCompositeOperation = 'lighter';
  const R = mulberry(901), u = t - T.burst;
  for (let i = 0; i < 46; i++) {
    const a = R() * TAU, len = 500 + R() * 900, wd = .012 + R() * .03, ph = R() * 6;
    const vert = Math.abs(Math.sin(a)) > Math.abs(Math.cos(a)) * .8;   // 上下红、左右蓝（随原图的 X 构图）
    const col = vert ? '#ff5a30' : '#4a7aff';
    const k = env * (.10 + .08 * Math.sin(t * 2.1 + ph)) * (u < .4 ? 1 + 1.6 * (1 - u / .4) : 1);
    const L = len * (.7 + .3 * Math.min(1, u / .25));
    const g = E.createLinearGradient(cx, cy, cx + Math.cos(a) * L, cy + Math.sin(a) * L); g.addColorStop(0, rgb(col, k * 1.4)); g.addColorStop(.35, rgb(col, k * .7)); g.addColorStop(1, 'rgba(0,0,0,0)');
    E.fillStyle = g; E.beginPath(); E.moveTo(cx, cy); E.lineTo(cx + Math.cos(a - wd) * L, cy + Math.sin(a - wd) * L); E.lineTo(cx + Math.cos(a + wd) * L, cy + Math.sin(a + wd) * L); E.closePath(); E.fill();
  }
  // 火星
  for (let i = 0; i < 110; i++) {
    const r1 = hash(i * 3.1 + 1), r2 = hash(i * 7.7 + 2), r3 = hash(i * 1.9 + 3), r4 = hash(i * 5.3 + 4);
    const born = (r1 * 6.5) - (i < 40 ? 6.5 * r1 : 0), life = 1.4 + r2 * 2.2;
    const age = u - born; if (age < 0 || age > life) continue;
    const side = r3 < .5 ? -1 : 1, sx = cx + side * (W / 2 + 10 + r4 * 120) * (r3 < .2 || r3 > .8 ? 1 : (r4 * 2 - 1)), sy = (r3 < .2 || r3 > .8) ? cy + (r4 - .5) * H : cy + H / 2 + 8;
    const vy = -(70 + r2 * 140), x = sx + Math.sin(age * (1.5 + r1 * 2) + i) * 22 + side * age * 18, y = sy + vy * age - 30 * age * age * (r4 - .3);
    const k = Math.sin(Math.PI * age / life) * (.7 + .3 * Math.sin(t * 13 + i)) * Math.min(1.4, env);
    const s = 1.6 + r4 * 3.2;
    const gg = E.createRadialGradient(x, y, 0, x, y, s * 4); gg.addColorStop(0, rgb('#ffd890', k)); gg.addColorStop(.3, rgb('#ff7a30', k * .6)); gg.addColorStop(1, 'rgba(0,0,0,0)');
    E.fillStyle = gg; E.fillRect(x - s * 4, y - s * 4, s * 8, s * 8);
  }
  E.restore();
}

// —— 屏幕上的文字框（A11–A12），给 TEXTS ——
export function textsAt(t, cam, sh) {
  const out = [];
  for (const x of TXT) {
    let on;
    if (x.kind === 'title') { const ks = x.keys(); on = t >= ks[ks.length - 1] + .2; }
    else on = t >= x.key();
    if (!on) continue;
    const box = x.id.match(/zgqt|w\d|s_9/) ? 'A' : x.id.match(/lls/) ? 'B' : 'C';
    if (box !== 'C' && t >= T.black) continue;
    if (box === 'C' && t < T.burst) continue;
    const pd = x.kind === 'title' ? .16 : .18, bcx = (BOX[box].x0 + BOX[box].x1) / 2, ox = (cam - bcx) * pd;
    const sx = c => c - cam + 960 + ox + sh[0], sy = c => c + 540 + sh[1];
    out.push({ id: x.id, text: x.text, x0: sx(x.x0), y0: sy(x.y0), x1: sx(x.x1), y1: sy(x.y1) });
  }
  return out;
}
