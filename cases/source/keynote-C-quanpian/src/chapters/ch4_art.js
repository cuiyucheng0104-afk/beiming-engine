// 第四章 新作品 · 纸件美术（Canvas2D，5000 像素/米，与开头 art.js 同一套墨线 + 月牙暗部 + 白边切口 + 纸纹）。
// 只画纸世界的布景（夜空背板、青瓷地面、纸塔、弧轨、窗棂、森林、折扇、标题牌）；IP 图一律由 kit.card 整张印成卡片，不在这里画。
import * as A from '../art.js';
import { font } from '../shared/kit.js';

export const PX = A.PX, INK = A.INK, VERM = A.VERM, GOLD = A.GOLD;
const TAU = Math.PI * 2, cv = A.cv, mulberry = A.mulberry;
export const PW = .48 - .008, PD = .28 - .006;          // 书页尺寸（= world.js）

function inked(x, fill, lw, col = INK) { if (fill) { x.fillStyle = fill; x.fill(); } if (lw) { x.lineWidth = lw; x.strokeStyle = col; x.lineJoin = 'round'; x.lineCap = 'round'; x.stroke(); } }
function grain(x, w, h, a = .8) { x.save(); x.globalCompositeOperation = 'source-atop'; x.globalAlpha = a; x.fillStyle = x.createPattern(A.GRAIN, 'repeat'); x.fillRect(0, 0, w, h); x.restore(); }
function mottle(x, w, h, seed, amt = .06, n = 60, dark = 'rgba(20,30,40,', light = 'rgba(255,255,255,') {
  const R = mulberry(seed);
  for (let i = 0; i < n; i++) { const px = R() * w, py = R() * h, r = (40 + R() * 220) * w / 2400, g = x.createRadialGradient(px, py, 0, px, py, r), dk = R() < .5;
    g.addColorStop(0, dk ? `${dark}${amt * R()})` : `${light}${amt * 1.2 * R()})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }
}
// 月牙暗部：形状内，偏移后的形状以外涂暗
function crescent(x, path, shade, dx, dy, base) { x.save(); path(); x.clip(); x.fillStyle = shade; x.fillRect(-1e4, -1e4, 3e4, 3e4); x.translate(-dx, -dy); path(); x.fillStyle = base; x.fill(); x.restore(); }
const wob = (R, a) => (R() - .5) * a;

// ———————————————— 背板：奇谭夜（深靛青夜空 + 金线星宿 + 浅青祥云纸条 + 远山）————————————————
// 画布下沿 = 书脊一侧
export function backdropArt() {
  const w = Math.round(PW * PX), h = Math.round(PD * PX), c = cv(w, h), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#16283B'); g.addColorStop(.55, '#203F52'); g.addColorStop(1, '#2F5A63');
  x.fillStyle = g; x.fillRect(0, 0, w, h); mottle(x, w, h, 61, .09, 90, 'rgba(5,10,20,', 'rgba(150,200,210,');
  const R = mulberry(17);
  // 金线星宿：几组星点用细金线连起来
  const groups = [[[.08, .12], [.15, .2], [.22, .14], [.27, .24]], [[.62, .1], [.7, .17], [.78, .11], [.86, .19], [.9, .3]], [[.36, .3], [.44, .26], [.5, .34]]];
  x.strokeStyle = 'rgba(217,164,65,.55)'; x.lineWidth = 4;
  for (const gp of groups) { x.beginPath(); gp.forEach(([fx, fy], i) => { const px = fx * w, py = fy * h; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); }
  for (const gp of groups) for (const [fx, fy] of gp) { x.beginPath(); x.arc(fx * w, fy * h, 11, 0, TAU); inked(x, '#E8BE62', 4, 'rgba(58,42,32,.8)'); }
  for (let i = 0; i < 70; i++) { const px = R() * w, py = R() * h * .62, r = 2 + R() * 4.5; x.beginPath(); x.arc(px, py, r, 0, TAU); x.fillStyle = `rgba(240,215,150,${.35 + R() * .5})`; x.fill(); }
  // 浅青祥云纸条
  [[.05, .42, .2], [.55, .46, .24], [.3, .55, .16], [.74, .36, .14]].forEach(([fx, fy, fl], i) => {
    const cx = fx * w, cy = fy * h, L = fl * w, th = .011 * PX;
    x.beginPath(); x.roundRect(cx, cy, L, th, th / 2); inked(x, '#8FB8B3', 8);
    x.beginPath(); x.roundRect(cx + L * .25, cy + th * .95, L * .5, th * .75, th / 2); inked(x, '#6E9B98', 7);
    // 云头一卷
    x.beginPath(); x.arc(cx + (i % 2 ? L : 0), cy + th / 2, th * .9, 0, TAU); inked(x, '#8FB8B3', 8);
    x.beginPath(); x.arc(cx + (i % 2 ? L : 0), cy + th / 2, th * .45, 0, TAU * .8); x.strokeStyle = INK; x.lineWidth = 5; x.stroke();
  });
  // 远山：两道剪影，靠书脊（画布下沿）
  const ridge = (base, amp, col, seed, lw) => { const r = mulberry(seed); x.beginPath(); x.moveTo(-20, h + 20); x.lineTo(-20, base);
    let px = -20; while (px < w + 40) { const nx = px + (90 + r() * 160), top = base - amp * (.4 + r() * .6); x.quadraticCurveTo((px + nx) / 2, top, nx, base - amp * .15 * r()); px = nx; }
    x.lineTo(w + 40, h + 20); x.closePath(); inked(x, col, lw); };
  ridge(h * .8, h * .14, '#1B3343', 3, 9);
  ridge(h * .9, h * .1, '#142837', 9, 9);
  x.strokeStyle = VERM; x.lineWidth = 10; x.strokeRect(.012 * PX, .012 * PX, w - .024 * PX, h - .024 * PX);
  x.lineWidth = 3; x.strokeRect(.017 * PX, .017 * PX, w - .034 * PX, h - .034 * PX);
  grain(x, w, h, .9);
  const gg = x.createLinearGradient(0, h, 0, h - .03 * PX); gg.addColorStop(0, 'rgba(0,0,0,.35)'); gg.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gg; x.fillRect(0, h - .03 * PX, w, .03 * PX);
  return c;
}

// ———————————————— 地面页：淡青瓷纸 + 金色同心水纹（以塔为心）+ 切缝 ————————————————
// 画布上沿 = 书脊一侧；u = (x + PW/2)·PX，v = (z + PD/2)·PX
export function floorArt({ tower, slits }) {
  const w = Math.round(PW * PX), h = Math.round(PD * PX), c = cv(w, h), x = c.getContext('2d');
  x.fillStyle = '#D6E0D0'; x.fillRect(0, 0, w, h); mottle(x, w, h, 71, .07, 80, 'rgba(60,80,70,', 'rgba(255,255,255,');
  const U = xm => (xm + PW / 2) * PX, V = zm => (zm + PD / 2) * PX;
  const cx = U(tower[0]), cy = V(tower[1]);
  x.save(); x.strokeStyle = 'rgba(176,138,60,.42)'; x.lineWidth = 6;
  for (let k = 1; k <= 9; k++) { x.beginPath(); x.ellipse(cx, cy, k * .026 * PX, k * .026 * PX * .62, 0, 0, TAU); x.stroke(); }
  x.restore();
  // 切缝：深色细缝 + 下唇一道亮边
  for (const [x0, x1, z] of slits) { const a = U(x0), b = U(x1), y = V(z);
    x.fillStyle = 'rgba(70,82,74,.26)'; x.fillRect(a, y - 1.5, b - a, 3); x.fillStyle = 'rgba(255,255,255,.28)'; x.fillRect(a, y + 1.5, b - a, 2); }
  const gg = x.createLinearGradient(0, 0, 0, .03 * PX); gg.addColorStop(0, 'rgba(30,40,40,.3)'); gg.addColorStop(1, 'rgba(30,40,40,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, .03 * PX);
  x.strokeStyle = VERM; x.lineWidth = 8; x.strokeRect(.012 * PX, .012 * PX, w - .024 * PX, h - .024 * PX);
  grain(x, w, h, .9);
  return c;
}

// ———————————————— 纸塔一层：白墙、朱红立柱、深靛瓦檐（飞檐上翘）、金色窗框 ————————————————
// spec: { ww 墙宽, h 总高, roof: [檐底, 檐顶], ow 檐宽, wins: [{x, y, s}], kind: 'base'|'body'|'top' }
// 返回整张已切边的画布（底边 = 地面，无下边距）与尺寸（米）
export function tierArt(spec, seed = 1) {
  const pad = 40, ow = spec.ow, W = Math.round(ow * PX + 2 * pad), H = Math.round(spec.h * PX + pad), c = cv(W, H), x = c.getContext('2d');
  const X = m => W / 2 + m * PX, Y = m => H - m * PX, R = mulberry(seed);
  const [r0, r1] = spec.roof, wall1 = r0 + (r1 - r0) * .25;
  const wallTop = spec.kind === 'top' ? spec.wallTop : wall1;
  const wallBot = spec.kind === 'top' ? spec.wallBot : 0;
  // 墙
  const wallPath = () => { x.beginPath(); x.moveTo(X(-spec.ww / 2), Y(wallBot)); x.lineTo(X(-spec.ww / 2 + .001), Y(wallTop)); x.lineTo(X(spec.ww / 2 - .001), Y(wallTop)); x.lineTo(X(spec.ww / 2), Y(wallBot)); x.closePath(); };
  crescent(x, wallPath, '#D8CBB0', -.006 * PX, 0, '#F2E9D6'); wallPath(); inked(x, null, 9);
  // 墙面纸纹横线（砖缝感）
  x.save(); wallPath(); x.clip(); x.strokeStyle = 'rgba(120,100,70,.13)'; x.lineWidth = 3;
  for (let y = wallBot + .008; y < wallTop; y += .009) { x.beginPath(); x.moveTo(X(-spec.ww / 2), Y(y)); x.lineTo(X(spec.ww / 2), Y(y)); x.stroke(); }
  x.restore();
  if (spec.kind === 'base') {   // 台基：石阶 + 栏杆
    x.beginPath(); x.rect(X(-spec.ww / 2), Y(.011), spec.ww * PX, .011 * PX); inked(x, '#C9BC9F', 8);
    x.beginPath(); x.rect(X(-spec.ww / 2 + .008), Y(.019), (spec.ww - .016) * PX, .008 * PX); inked(x, '#DCD0B6', 7);
    for (let px = -spec.ww / 2 + .014; px < spec.ww / 2 - .01; px += .0125) { x.beginPath(); x.rect(X(px), Y(.03), .0035 * PX, .011 * PX); inked(x, VERM, 5); }
    x.beginPath(); x.rect(X(-spec.ww / 2 + .01), Y(.032), (spec.ww - .02) * PX, .0028 * PX); inked(x, VERM, 5);
  }
  // 立柱（朱红）
  for (const cxm of spec.cols || []) { x.beginPath(); x.rect(X(cxm - .003), Y(wallTop), .006 * PX, (wallTop - wallBot) * PX); inked(x, VERM, 6); }
  // 窗框（金）+ 窗洞（深）
  for (const wn of spec.wins || []) {
    const s = wn.s / 2 + .004;
    x.beginPath(); x.roundRect(X(wn.x - s), Y(wn.y + s), 2 * s * PX, 2 * s * PX, 14); inked(x, GOLD, 9);
    x.beginPath(); x.rect(X(wn.x - s + .003), Y(wn.y + s - .003), (2 * s - .006) * PX, (2 * s - .006) * PX); inked(x, '#17222C', 5);
    // 窗下小檐
    x.beginPath(); x.moveTo(X(wn.x - s - .004), Y(wn.y - s)); x.lineTo(X(wn.x + s + .004), Y(wn.y - s)); x.lineTo(X(wn.x + s), Y(wn.y - s - .003)); x.lineTo(X(wn.x - s), Y(wn.y - s - .003)); x.closePath(); inked(x, '#22384A', 6);
  }
  // 瓦檐：两端飞檐上翘
  const eave = (y0, y1, wE, wTop) => {
    const lift = (y1 - y0) * .55;
    const path = () => { x.beginPath();
      x.moveTo(X(-wE / 2), Y(y0 + lift));
      x.quadraticCurveTo(X(-wE / 2 + .012), Y(y0 - .0005), X(-wE / 2 + .03), Y(y0));
      x.lineTo(X(wE / 2 - .03), Y(y0));
      x.quadraticCurveTo(X(wE / 2 - .012), Y(y0 - .0005), X(wE / 2), Y(y0 + lift));
      x.quadraticCurveTo(X(wE / 2 - .016), Y(y0 + lift * .55), X(wTop / 2), Y(y1));
      x.lineTo(X(-wTop / 2), Y(y1));
      x.quadraticCurveTo(X(-wE / 2 + .016), Y(y0 + lift * .55), X(-wE / 2), Y(y0 + lift));
      x.closePath(); };
    crescent(x, path, '#172836', 0, .0025 * PX, '#2A465A'); path(); inked(x, null, 9);
    // 瓦垄
    x.save(); path(); x.clip(); x.strokeStyle = 'rgba(160,190,200,.28)'; x.lineWidth = 4;
    for (let px = -wE / 2 + .01; px < wE / 2; px += .0075) { x.beginPath(); x.moveTo(X(px * .7), Y(y1)); x.lineTo(X(px), Y(y0)); x.stroke(); }
    x.restore();
    // 檐口金线 + 翘角小铃
    x.beginPath(); x.moveTo(X(-wE / 2 + .03), Y(y0 + .0012)); x.lineTo(X(wE / 2 - .03), Y(y0 + .0012)); x.strokeStyle = GOLD; x.lineWidth = 6; x.stroke();
    for (const s of [-1, 1]) { x.beginPath(); x.arc(X(s * (wE / 2 - .002)), Y(y0 + lift - .004), .0028 * PX, 0, TAU); inked(x, GOLD, 5); }
  };
  if (spec.kind === 'top') {
    eave(r0, r1, ow, spec.ww * .35);
    // 塔刹：金杆 + 三道相轮 + 朱红宝珠
    const sp = spec.spire;
    x.beginPath(); x.rect(X(-.0018), Y(sp[1]), .0036 * PX, (sp[1] - r1 + .002) * PX); inked(x, GOLD, 5);
    for (let k = 0; k < 3; k++) { const yy = r1 + .006 + k * .0055, ww = .012 - k * .0025; x.beginPath(); x.ellipse(X(0), Y(yy), ww / 2 * PX, .0016 * PX, 0, 0, TAU); inked(x, GOLD, 5); }
    x.beginPath(); x.arc(X(0), Y(sp[1] - .004), .0052 * PX, 0, TAU); inked(x, VERM, 7);
    x.beginPath(); x.arc(X(-.0016), Y(sp[1] - .0025), .0015 * PX, 0, TAU); x.fillStyle = 'rgba(255,230,200,.8)'; x.fill();
  } else eave(r0, r1, ow, spec.ww * .92);
  grain(x, W, H, .7);
  return { c: A.finishCut(c, 20), w: W / PX, h: H / PX };
}
// 把一张画布左右对半切开（V 形折页的两翼，中缝不留白边）
export function halves(c) {
  const hw = Math.floor(c.width / 2), L = cv(hw, c.height), Rr = cv(c.width - hw, c.height);
  L.getContext('2d').drawImage(c, 0, 0); Rr.getContext('2d').drawImage(c, -hw, 0);
  return [L, Rr];
}

// ———————————————— 弧形纸轨（开头赭色带齿纸轨的弧形版本）+ 两条支腿 ————————————————
// 轨道中线：P(φ) = (a·cosφ, y0 + b·sinφ)，φ ∈ [φ1, φ0]
export function railArt(G) {
  const pad = 40, W = Math.round((2 * G.a + .03) * PX + 2 * pad), H = Math.round((G.y0 + G.b + .02) * PX + pad), c = cv(W, H), x = c.getContext('2d');
  const X = m => W / 2 + m * PX, Y = m => H - m * PX, hw = G.rw / 2;
  const P = (phi, off = 0) => { const px = G.a * Math.cos(phi), py = G.y0 + G.b * Math.sin(phi), tx = -G.a * Math.sin(phi), ty = G.b * Math.cos(phi), L = Math.hypot(tx, ty);
    return [px + off * ty / L, py - off * tx / L]; };   // 法线 = 切线顺时针转 90°（向外）
  // 支腿
  for (const phi of [G.phi0, G.phi1]) { const [px, py] = P(phi); x.beginPath(); x.rect(X(px - .003), Y(py), .006 * PX, py * PX); inked(x, '#A97B35', 7); }
  const N = 120, band = () => { x.beginPath();
    for (let i = 0; i <= N; i++) { const [px, py] = P(G.phi0 + (G.phi1 - G.phi0) * i / N, hw); i ? x.lineTo(X(px), Y(py)) : x.moveTo(X(px), Y(py)); }
    for (let i = N; i >= 0; i--) { const [px, py] = P(G.phi0 + (G.phi1 - G.phi0) * i / N, -hw); x.lineTo(X(px), Y(py)); }
    x.closePath(); };
  band(); inked(x, '#C99A4B', 10);
  // 中缝 + 两侧齿
  x.beginPath(); for (let i = 0; i <= N; i++) { const [px, py] = P(G.phi0 + (G.phi1 - G.phi0) * i / N); i ? x.lineTo(X(px), Y(py)) : x.moveTo(X(px), Y(py)); }
  x.strokeStyle = '#A97B35'; x.lineWidth = .0035 * PX; x.stroke();
  const len = G.len, nT = Math.floor(len / .0125);
  for (let k = 1; k < nT; k++) { const phi = G.phiAt(k / nT); for (const s of [1, -1]) { const [a1, b1] = P(phi, s * hw * .55), [a2, b2] = P(phi, s * hw * .92); x.beginPath(); x.moveTo(X(a1), Y(b1)); x.lineTo(X(a2), Y(b2)); x.strokeStyle = INK; x.lineWidth = 6; x.stroke(); } }
  grain(x, W, H, .7);
  return { c: A.finishCut(c, 16), w: W / PX, h: H / PX };
}

// ———————————————— 窗棂小门（朱红框 + 金色回纹棂格）————————————————
export function shutterArt(wm, hm, side) {
  const pad = 24, W = Math.round(wm * PX + 2 * pad), H = Math.round(hm * PX + 2 * pad), c = cv(W, H), x = c.getContext('2d');
  x.beginPath(); x.roundRect(pad, pad, W - 2 * pad, H - 2 * pad, 6); inked(x, VERM, 7);
  const ix = pad + 16, iy = pad + 16, iw = W - 2 * pad - 32, ih = H - 2 * pad - 32;
  x.beginPath(); x.rect(ix, iy, iw, ih); inked(x, '#7E2219', 4);
  x.strokeStyle = GOLD; x.lineWidth = 5;
  const n = 4, cell = ih / n;
  for (let k = 0; k < n; k++) { const y = iy + k * cell, m = cell * .22; x.strokeRect(ix + m, y + m, iw - 2 * m, cell - 2 * m); x.strokeRect(ix + m * 2.2, y + m * 2.2, iw - 4.4 * m, cell - 4.4 * m); }
  x.beginPath(); x.arc(side < 0 ? W - pad - 10 : pad + 10, H / 2, 7, 0, TAU); inked(x, GOLD, 3);
  grain(x, W, H, .6);
  return { c: A.finishCut(c, 10), w: W / PX, h: H / PX };
}

export function shutterBackArt(wm, hm) {
  const pad = 24, W = Math.round(wm * PX + 2 * pad), H = Math.round(hm * PX + 2 * pad), c = cv(W, H), x = c.getContext('2d');
  x.beginPath(); x.roundRect(pad, pad, W - 2 * pad, H - 2 * pad, 6); inked(x, '#A8352A', 7);
  x.strokeStyle = 'rgba(217,164,65,.8)'; x.lineWidth = 4; x.strokeRect(pad + 18, pad + 18, W - 2 * pad - 36, H - 2 * pad - 36);
  grain(x, W, H, .6);
  return { c: A.finishCut(c, 10), w: W / PX, h: H / PX };
}
// ———————————————— 片名小纸签（窗下，向下翻出）————————————————
export function tagArt(str, sizeM = .0074) {
  const fs = sizeM * PX, m = cv(10, 10).getContext('2d'); m.font = font('SCM', fs);
  const tw = m.measureText(str).width, pad = 22, W = Math.round(tw + fs * 1.2 + 2 * pad), H = Math.round(fs * 1.7 + 2 * pad), c = cv(W, H), x = c.getContext('2d');
  x.beginPath(); x.roundRect(pad, pad, W - 2 * pad, H - 2 * pad, 8); inked(x, '#FBF4E4', 6);
  x.font = font('SCM', fs); x.fillStyle = INK; x.textBaseline = 'middle'; x.textAlign = 'center'; x.fillText(str, W / 2, H / 2 + fs * .05);
  const out = A.finishCut(c, 12);
  return { c: out, w: W / PX, h: H / PX, rect: [W / 2 - tw / 2, H / 2 - fs * .55, tw, fs * 1.1] };
}

// ———————————————— 标题牌（米白纸板 + 墨框 + 朱红小方块 + 标题 + 小字）————————————————
// 返回 { c, w, h, draw(o) }；draw({ title, sub, subFrac, stamp }) 重画（只在内容变了时调用）；rects = 文字在画布上的像素框
export function placard(wm, hm) {
  const pad = 36, W = Math.round(wm * PX + 2 * pad), H = Math.round(hm * PX + 2 * pad), c = cv(W, H);
  const tfs = .0165 * PX, sfs = .0079 * PX, x0 = pad + .016 * PX + .0075 * PX;
  const rects = {};
  function draw({ title, sub, subFrac = 1, titleFrac = 1, stamp = null }) {
    const art = cv(W, H), y = art.getContext('2d');
    y.beginPath(); y.roundRect(pad, pad, W - 2 * pad, H - 2 * pad, 16); inked(y, '#FBF4E4', 9);
    y.strokeStyle = 'rgba(58,42,32,.5)'; y.lineWidth = 3; y.strokeRect(pad + 20, pad + 20, W - 2 * pad - 40, H - 2 * pad - 40);
    const sq = tfs * .42, ty = pad + .019 * PX;
    y.fillStyle = VERM; y.fillRect(pad + .009 * PX, ty - sq / 2, sq, sq);
    y.font = font('SC', tfs); y.fillStyle = INK; y.textBaseline = 'middle'; y.textAlign = 'left';
    const tw = y.measureText(title).width; rects.title = [x0, ty - tfs * .58, tw, tfs * 1.16];
    if (titleFrac >= 1) y.fillText(title, x0, ty + tfs * .04);
    else if (titleFrac > 0) { y.save(); y.beginPath(); y.rect(x0 - 4, ty - tfs, (tw + 8) * titleFrac, tfs * 2); y.clip(); y.fillText(title, x0, ty + tfs * .04); y.restore(); }   // 返修：换字时先擦掉、再一起打新字
    // 细分隔线
    y.fillStyle = 'rgba(58,42,32,.35)'; y.fillRect(x0, pad + .031 * PX, W - pad - x0 - .01 * PX, 3);
    if (sub) {
      const sy = pad + .0405 * PX; y.font = font('SCM', sfs); y.fillStyle = '#4A3A2E';
      const sw = y.measureText(sub).width;
      y.save(); y.beginPath(); y.rect(x0 - 4, sy - sfs, (sw + 8) * subFrac, sfs * 2); y.clip(); y.fillText(sub, x0, sy + sfs * .04); y.restore();
      rects.sub = [x0, sy - sfs * .6, sw, sfs * 1.2];
    } else rects.sub = null;
    if (stamp) {   // 朱红「2」章：方章 + 反白数字，紧跟标题之后
      const s = tfs * 1.12 * stamp.scale, cx = x0 + tw + tfs * .55 + s / 2, cy = ty;
      y.save(); y.translate(cx, cy); y.rotate(-.06); y.globalAlpha = stamp.alpha;
      y.beginPath(); y.roundRect(-s / 2, -s / 2, s, s, s * .12); y.fillStyle = VERM; y.fill();
      y.font = `800 ${s * .82}px InterF`; y.fillStyle = '#FBF4E4'; y.textAlign = 'center'; y.textBaseline = 'middle'; y.fillText(stamp.text, 0, s * .04);
      y.restore();
      rects.title = [x0, ty - tfs * .62, tw + tfs * .55 + tfs * 1.12, tfs * 1.24];
    }
    y.save(); y.globalCompositeOperation = 'source-atop'; y.globalAlpha = .55; y.fillStyle = y.createPattern(A.GRAIN, 'repeat'); y.fillRect(0, 0, W, H); y.restore();
    const x = c.getContext('2d'); x.clearRect(0, 0, W, H); x.drawImage(A.finishCut(art, 14), 0, 0);
  }
  return { c, w: W / PX, h: H / PX, W, H, draw, rects };
}

// ———————————————— 纸森林（浪浪山）：起伏山脊 + 层叠松林 ————————————————
function pine(x, cx, by, hm, col, shade, R) {
  const hp = hm * PX, wp = hp * (.42 + R() * .1), tiers = 3;
  const path = () => { x.beginPath(); x.moveTo(cx, by - hp);
    for (let k = 0; k < tiers; k++) { const f = (k + 1) / tiers, yy = by - hp + hp * .92 * f, ww = wp * (.45 + .55 * f); x.lineTo(cx + ww / 2, yy); x.lineTo(cx + ww * .18, yy - hp * .1); }
    for (let k = tiers - 1; k >= 0; k--) { const f = (k + 1) / tiers, yy = by - hp + hp * .92 * f, ww = wp * (.45 + .55 * f); x.lineTo(cx - ww * .18, yy - hp * .1); x.lineTo(cx - ww / 2, yy); }
    x.closePath(); };
  crescent(x, path, shade, -wp * .14, 0, col); path(); inked(x, null, 7);
  x.beginPath(); x.rect(cx - 5, by - hp * .08, 10, hp * .1); inked(x, '#5B4130', 4);
}
// kind: 'far' | 'mid' | 'front'；span: [x0, x1]（米，相对本层原点）；返回 { c, w, h, ax }
export function forestArt(kind, x0, x1, hm, seed) {
  const pad = 40, W = Math.round((x1 - x0) * PX + 2 * pad), H = Math.round(hm * PX + pad), c = cv(W, H), x = c.getContext('2d'), R = mulberry(seed);
  const X = m => pad + (m - x0) * PX, base = H;
  const P = { far: ['#2E5E49', '#22493A', '#295744', '#1D4234'], mid: ['#447F55', '#356A47', '#3E7650', '#2F6142'], front: ['#7DAA5E', '#62904A', '#8DB86B', '#6E9C53'] }[kind];
  if (kind !== 'front') {
    // 浪形山脊（"浪浪"）
    const ridgeH = hm * (kind === 'far' ? .62 : .5);
    const path = () => { x.beginPath(); x.moveTo(X(x0), base); x.lineTo(X(x0), base - ridgeH * PX * .55);
      const n = kind === 'far' ? 5 : 3, step = (x1 - x0) / n;
      for (let i = 0; i < n; i++) { const a = x0 + i * step, b = a + step, top = ridgeH * (.75 + R() * .25); x.bezierCurveTo(X(a + step * .3), base - top * PX, X(b - step * .3), base - top * PX, X(b), base - ridgeH * PX * (.45 + R() * .2)); }
      x.lineTo(X(x1), base); x.closePath(); };
    crescent(x, path, P[1], -.006 * PX, -.004 * PX, P[0]); path(); inked(x, null, 9);
    // 山脊上的浪纹
    x.save(); path(); x.clip(); x.strokeStyle = 'rgba(255,255,230,.18)'; x.lineWidth = 5;
    for (let k = 0; k < 4; k++) { x.beginPath(); const yy = base - ridgeH * PX * (.18 + k * .14); for (let xx = X(x0); xx < X(x1); xx += .018 * PX) { x.moveTo(xx, yy); x.quadraticCurveTo(xx + .009 * PX, yy - .006 * PX, xx + .018 * PX, yy); } x.stroke(); }
    x.restore();
    // 松林
    const nP = Math.round((x1 - x0) / (kind === 'far' ? .021 : .017));
    for (let i = 0; i < nP; i++) { const px = x0 + (i + .5 + wob(R, .6)) * (x1 - x0) / nP, hh = hm * (kind === 'far' ? .55 + R() * .45 : .6 + R() * .4); pine(x, X(px), base - (kind === 'far' ? ridgeH * PX * (.1 + R() * .25) : 0), hh, P[2], P[3], R); }
  } else {
    // 前景草丛：一排圆润草团 + 草叶
    const path = () => { x.beginPath(); x.moveTo(X(x0), base); let px = x0; while (px < x1) { const nx = Math.min(x1, px + .012 + R() * .014), top = hm * (.55 + R() * .45); x.quadraticCurveTo(X((px + nx) / 2), base - top * PX * 1.3, X(nx), base - hm * PX * .25); px = nx; } x.lineTo(X(x1), base); x.closePath(); };
    crescent(x, path, P[1], -.004 * PX, -.003 * PX, P[0]); path(); inked(x, null, 8);
    x.strokeStyle = 'rgba(40,70,30,.6)'; x.lineWidth = 5;
    for (let i = 0; i < (x1 - x0) / .006; i++) { const px = X(x0 + R() * (x1 - x0)), hh = hm * PX * (.3 + R() * .4); x.beginPath(); x.moveTo(px, base - 4); x.quadraticCurveTo(px + wob(R, 30), base - hh * .6, px + wob(R, 40), base - hh); x.stroke(); }
    // 几朵小花（金、朱红）
    for (let i = 0; i < (x1 - x0) / .03; i++) { const px = X(x0 + R() * (x1 - x0)), py = base - hm * PX * (.35 + R() * .3); x.beginPath(); x.arc(px, py, .0018 * PX, 0, TAU); inked(x, R() < .5 ? GOLD : '#E07A5F', 4); }
  }
  grain(x, W, H, .7);
  return { c: A.finishCut(c, 20), w: W / PX, h: H / PX, ax: (0 - x0 + pad / PX) / (W / PX) };
}

// ———————————————— 折扇扇骨（燃比娃身后的光芒）：朱红 / 金，盖一层宣纸纤维 ————————————————
export function bladeArt(Lm, Wm, k, xuan) {
  const pad = 26, W = Math.round(Wm * PX + 2 * pad), H = Math.round(Lm * PX + pad * 2), c = cv(W, H), x = c.getContext('2d');
  const cx = W / 2, top = pad, bot = H - pad, hw = Wm * PX / 2;
  const path = () => { x.beginPath(); x.moveTo(cx - hw * .16, bot); x.bezierCurveTo(cx - hw * .3, bot - (bot - top) * .4, cx - hw * 1.0, top + (bot - top) * .25, cx - hw * .82, top + hw * .5);
    x.quadraticCurveTo(cx, top - hw * .25, cx + hw * .82, top + hw * .5); x.bezierCurveTo(cx + hw * 1.0, top + (bot - top) * .25, cx + hw * .3, bot - (bot - top) * .4, cx + hw * .16, bot); x.closePath(); };
  const base = k % 2 ? '#D9A441' : VERM, shade = k % 2 ? '#B9822B' : '#9E2D23';
  const g = x.createLinearGradient(0, bot, 0, top); g.addColorStop(0, shade); g.addColorStop(.55, base); g.addColorStop(1, k % 2 ? '#F2CF7A' : '#D9573F');
  crescent(x, path, shade, -hw * .25, 0, base);
  x.save(); path(); x.clip(); x.globalAlpha = .75; x.fillStyle = g; x.fillRect(0, 0, W, H); x.globalAlpha = 1;
  if (xuan) { x.globalCompositeOperation = 'multiply'; x.globalAlpha = .55; const s = W / 700; x.drawImage(xuan, (k * 137) % 900, (k * 211) % 900, 700, 700 * H / W, 0, 0, W, H); x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; void s; }
  x.restore();
  path(); inked(x, null, 7);
  x.beginPath(); x.moveTo(cx, bot - 4); x.lineTo(cx, top + hw * .6); x.strokeStyle = k % 2 ? 'rgba(120,70,20,.6)' : 'rgba(255,215,140,.7)'; x.lineWidth = 4; x.stroke();
  return { c: A.finishCut(c, 10), w: W / PX, h: H / PX, padM: pad / PX };
}
