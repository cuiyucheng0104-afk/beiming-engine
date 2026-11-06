// 纸世界的美术：所有纸件都在 Canvas2D 上画，再做成"剪纸"（白边 + 灰纸板切口 + 纸纹）。
// 单位：PX 像素 / 米。墨色深棕，不用黑；一种主色族（暖杏色天幕 + 青绿远山），朱红/金作贯穿色。
export const PX = 5000;
export const INK = '#3A2A20', VERM = '#BE3A2E', GOLD = '#D9A441', CREAM = '#FFF6E6';
const TAU = Math.PI * 2;
export function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function cv(w, h) { const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h); return c; }

// —— 纸纤维纹理 ——
function makeGrain(n, seed) {
  const c = cv(n, n), x = c.getContext('2d'), R = mulberry(seed), img = x.createImageData(n, n), d = img.data;
  for (let i = 0; i < n * n; i++) { const v = R(); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v < .5 ? 0 : 255; d[i * 4 + 3] = Math.abs(v - .5) * 30; }
  x.putImageData(img, 0, 0); x.lineCap = 'round';
  for (let i = 0; i < n * 1.1; i++) {
    const px = R() * n, py = R() * n, a = R() * TAU, l = 4 + R() * 18;
    x.strokeStyle = R() < .5 ? 'rgba(90,70,50,.09)' : 'rgba(255,255,255,.2)'; x.lineWidth = .6 + R() * .8;
    x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + Math.cos(a + .5) * l * .5, py + Math.sin(a + .5) * l * .5, px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
  }
  return c;
}
export const GRAIN = makeGrain(512, 7);
function grainOver(x, w, h, a = .8, mode = 'source-atop') { x.save(); x.globalCompositeOperation = mode; x.globalAlpha = a; x.fillStyle = x.createPattern(GRAIN, 'repeat'); x.fillRect(0, 0, w, h); x.restore(); }
function mottle(x, w, h, seed, amt = .06, n = 60) {
  const R = mulberry(seed);
  for (let i = 0; i < n; i++) { const px = R() * w, py = R() * h, r = (40 + R() * 220) * w / 2400, g = x.createRadialGradient(px, py, 0, px, py, r), dk = R() < .5;
    g.addColorStop(0, dk ? `rgba(120,90,60,${amt * R()})` : `rgba(255,255,255,${amt * 1.4 * R()})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }
}
// 白边 + 灰纸板切口（按剪影膨胀）
export function finishCut(art, border = 22, o = {}) {
  const w = art.width, h = art.height, out = cv(w, h), x = out.getContext('2d');
  const dil = (r, col) => { const c = cv(w, h), y = c.getContext('2d'), n = Math.max(16, Math.round(r * 1.1));
    for (const rr of [r, r * .66, r * .33]) for (let i = 0; i < n; i++) { const a = i / n * TAU; y.drawImage(art, Math.cos(a) * rr, Math.sin(a) * rr); }
    y.globalCompositeOperation = 'source-in'; y.fillStyle = col; y.fillRect(0, 0, w, h); return c; };
  x.drawImage(dil(border + 4, o.edge || '#B4A894'), 0, 3);
  x.drawImage(dil(border, o.paper || '#FFFCF4'), 0, 0);
  x.drawImage(art, 0, 0);
  grainOver(x, w, h, .75);
  return out;
}
function smoothClosed(x, pts) {
  const n = pts.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let m = mid(pts[n - 1], pts[0]); x.moveTo(m[0], m[1]);
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n], mm = mid(p, q); x.quadraticCurveTo(p[0], p[1], mm[0], mm[1]); }
  x.closePath();
}
function inked(x, fill, lw, col = INK) { if (fill) { x.fillStyle = fill; x.fill(); } if (lw) { x.lineWidth = lw; x.strokeStyle = col; x.lineJoin = 'round'; x.lineCap = 'round'; x.stroke(); } }
// 月牙形暗部：在形状里，把偏移后的形状以外的部分涂暗
function crescent(x, path, shade, dx, dy, base) { x.save(); path(); x.clip(); x.fillStyle = shade; x.fillRect(-1e4, -1e4, 3e4, 3e4); x.translate(-dx, -dy); path(); x.fillStyle = base; x.fill(); x.restore(); }

// —— 祥云卷：一团云 + 内卷涡线 ——
function cloudPuff(x, cx, cy, r, fill, line, seed, lw) {
  const R = mulberry(seed), n = 7, pts = [];
  for (let i = 0; i < n; i++) { const a = Math.PI + i / (n - 1) * Math.PI; const rr = r * (.55 + .25 * R()); pts.push([cx + Math.cos(a) * r * 1.25, cy + Math.sin(a) * r * .8, rr]); }
  const path = () => { x.beginPath(); for (const [px, py, rr] of pts) { x.moveTo(px + rr, py); x.arc(px, py, rr, 0, TAU); } x.rect(cx - r * 1.25, cy - r * .1, r * 2.5, r * .5); };
  // 外轮廓：先描粗墨再填色（合并的轮廓）
  x.save(); path(); x.lineWidth = lw * 2; x.strokeStyle = INK; x.lineJoin = 'round'; x.stroke(); x.fillStyle = fill; x.fill(); x.restore();
  // 内卷涡线
  x.save(); x.strokeStyle = line; x.lineWidth = lw * .8; x.lineCap = 'round';
  for (const [px, py, rr] of pts.filter((_, i) => i % 2 === 1)) { x.beginPath(); for (let k = 0; k < 40; k++) { const a = k / 40 * TAU * 1.25, s = rr * .62 * (1 - k / 52); const X = px + Math.cos(a + 1) * s, Y = py + Math.sin(a + 1) * s; k ? x.lineTo(X, Y) : x.moveTo(X, Y); } x.stroke(); }
  x.restore();
}

// —— 天幕（封面内页）：暖杏色纸，朱红日轮，几道薄云 ——
export function backdropArt(Wm, Hm) {
  const w = Wm * PX, h = Hm * PX, c = cv(w, h), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#EFC98F'); g.addColorStop(.55, '#F4DDAF'); g.addColorStop(1, '#F7E8C9');
  x.fillStyle = g; x.fillRect(0, 0, w, h); mottle(x, w, h, 11, .07, 80);
  // 日轮（底边往上 0.19 m，居中）
  const sx = w / 2, sy = h - .19 * PX, sr = .062 * PX;
  x.beginPath(); x.arc(sx, sy, sr * 1.32, 0, TAU); x.fillStyle = 'rgba(232,150,92,.28)'; x.fill();
  x.beginPath(); x.arc(sx, sy, sr, 0, TAU); inked(x, VERM, 14);
  crescent(x, () => { x.beginPath(); x.arc(sx, sy, sr - 7, 0, TAU); }, '#A93127', -sr * .12, -sr * .1, VERM);
  // 薄云带（纸条）
  const R = mulberry(5);
  [[.08, .23, .17], [.62, .27, .2], [.3, .38, .14], [.78, .14, .12]].forEach(([fx, fy, fl], i) => {
    const cx = fx * w, cy = fy * h, L = fl * w, th = .012 * PX;
    x.beginPath(); x.roundRect(cx, cy, L, th, th / 2); inked(x, '#FBEFD9', 8);
    x.beginPath(); x.roundRect(cx + L * .2, cy + th * .9, L * .55, th * .8, th / 2); inked(x, '#F7E4C3', 7);
  });
  // 页边的朱红细框
  x.strokeStyle = VERM; x.lineWidth = 10; x.strokeRect(.012 * PX, .012 * PX, w - .024 * PX, h - .024 * PX);
  x.lineWidth = 3; x.strokeRect(.017 * PX, .017 * PX, w - .034 * PX, h - .034 * PX);
  grainOver(x, w, h, .9);
  // 书沟阴影（底边）
  const gg = x.createLinearGradient(0, h, 0, h - .03 * PX); gg.addColorStop(0, 'rgba(60,40,20,.22)'); gg.addColorStop(1, 'rgba(60,40,20,0)'); x.fillStyle = gg; x.fillRect(0, h - .03 * PX, w, .03 * PX);
  return c;
}

// —— 地面页：浅赭纸，印淡淡的海水纹 ——
export function groundArt(Wm, Dm) {
  const w = Wm * PX, h = Dm * PX, c = cv(w, h), x = c.getContext('2d');
  x.fillStyle = '#EAD7B0'; x.fillRect(0, 0, w, h); mottle(x, w, h, 23, .06, 70);
  x.strokeStyle = 'rgba(176,140,86,.28)'; x.lineWidth = 6;
  const r = .018 * PX;
  for (let row = 0, y = h * .45; y < h + r; row++, y += r * .9) for (let xx = (row % 2) * r; xx < w + r; xx += r * 2) {
    for (let k = 1; k <= 3; k++) { x.beginPath(); x.arc(xx, y, r * k / 3, Math.PI, TAU); x.stroke(); }
  }
  // 远端书沟阴影
  const gg = x.createLinearGradient(0, 0, 0, .03 * PX); gg.addColorStop(0, 'rgba(60,40,20,.25)'); gg.addColorStop(1, 'rgba(60,40,20,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, .03 * PX);
  x.strokeStyle = VERM; x.lineWidth = 8; x.strokeRect(.012 * PX, .012 * PX, w - .024 * PX, h - .024 * PX);
  grainOver(x, w, h, .9);
  return c;
}

// —— 远山（青绿）：三层峰 ——
export function mountainsArt(Wm, Hm) {
  const pad = 40, w = Wm * PX + pad * 2, h = Hm * PX + pad, c = cv(w, h), x = c.getContext('2d');
  const base = h, R = mulberry(31);
  const ridge = (nPk, hMin, hMax, seed) => { const r = mulberry(seed), pts = [[pad, base]]; const step = (w - 2 * pad) / nPk;
    for (let i = 0; i <= nPk; i++) { const px = pad + i * step, top = base - (hMin + (hMax - hMin) * r()) * PX;
      if (i > 0) pts.push([px - step * .5, base - (hMin * .55 + .2 * (hMax - hMin) * r()) * PX]);
      pts.push([px + (r() - .5) * step * .2, top]); }
    pts.push([w - pad, base]); return pts; };
  const layers = [
    { pts: ridge(5, .075, .118, 3), fill: '#8FC4AE', shade: '#73AE97', tip: '#4C8DB0' },
    { pts: ridge(7, .05, .085, 9), fill: '#4C9A86', shade: '#3B826F', tip: '#3A79A0' },
    { pts: ridge(9, .025, .05, 17), fill: '#2F6E64', shade: '#255A52', tip: null },
  ];
  for (const L of layers) {
    const path = () => { x.beginPath(); x.moveTo(L.pts[0][0], L.pts[0][1]);
      for (let i = 1; i < L.pts.length - 1; i++) { const p = L.pts[i], q = L.pts[i + 1]; x.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2); }
      x.lineTo(L.pts[L.pts.length - 1][0], base); x.closePath(); };
    path(); inked(x, L.fill, 0);
    crescent(x, path, L.shade, -26, 10, L.fill);
    if (L.tip) { x.save(); path(); x.clip(); const gg = x.createLinearGradient(0, base - .12 * PX, 0, base - .055 * PX); gg.addColorStop(0, L.tip); gg.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, base); x.restore(); }
    path(); inked(x, null, 12);
  }
  // 山间一抹白云
  cloudPuff(x, w * .26, base - .035 * PX, .02 * PX, CREAM, GOLD, 4, 8);
  cloudPuff(x, w * .74, base - .045 * PX, .018 * PX, CREAM, GOLD, 8, 8);
  return finishCut(c, 24);
}

// —— 云幕侧翼：一摞祥云柱（mirror = 右侧镜像）——
export function wingArt(Wm, Hm, mirror) {
  const pad = 40, w = Wm * PX + pad * 2, h = Hm * PX + pad, c = cv(w, h), x = c.getContext('2d');
  if (mirror) { x.translate(w, 0); x.scale(-1, 1); }
  // 朱红柱身
  const px = w * .42, pw = .016 * PX * Wm / .1;
  x.beginPath(); x.rect(px - pw / 2, .03 * PX, pw, h - .03 * PX); inked(x, VERM, 10);
  x.fillStyle = 'rgba(0,0,0,.12)'; x.fillRect(px + pw * .15, .03 * PX, pw * .35, h - .03 * PX);
  const puffs = [[.5, .86, .036], [.38, .66, .032], [.6, .5, .03], [.42, .3, .027], [.55, .13, .024]];
  const k = Wm / .1;
  puffs.forEach(([fx, fy, r], i) => cloudPuff(x, fx * w, fy * h, r * PX * k, i % 2 ? '#FFF1DC' : CREAM, VERM, 40 + i, 9));
  return finishCut(c, 22);
}

// —— 云层（拉片带出的三层纸云）——
export function cloudBankArt(Wm, Hm, k) {
  const pad = 40, w = Wm * PX + pad * 2, h = Hm * PX + pad, c = cv(w, h), x = c.getContext('2d');
  const fills = ['#FFF8EC', '#F8E4D2', '#EEF0EC'], lines = [GOLD, VERM, '#7FA9B5'];
  const R = mulberry(70 + k), top = .022 * PX;
  const pts = [];
  for (let xx = pad, i = 0; xx < w - pad; i++) { const r = (.016 + .012 * R()) * PX; pts.push([xx + r, top + r * (.7 + .5 * R()), r]); xx += r * 1.5; }
  x.beginPath(); for (const [px, py, r] of pts) { x.moveTo(px + r, py); x.arc(px, py, r, 0, TAU); } x.rect(pad, top + .02 * PX, w - 2 * pad, h);
  x.save(); x.lineWidth = 22; x.strokeStyle = INK; x.lineJoin = 'round'; x.stroke(); x.fillStyle = fills[k]; x.fill(); x.restore();
  x.save(); x.strokeStyle = lines[k]; x.lineWidth = 8; x.lineCap = 'round';
  pts.forEach(([px, py, r], i) => { if (i % 2) return; x.beginPath(); for (let j = 0; j < 36; j++) { const a = j / 36 * TAU * 1.2, s = r * .6 * (1 - j / 46); const X = px + Math.cos(a + 2) * s, Y = py + Math.sin(a + 2) * s; j ? x.lineTo(X, Y) : x.moveTo(X, Y); } x.stroke(); });
  x.restore();
  return finishCut(c, 20);
}

// —— 纸轨：带齿的赭色纸条 ——
export function trackArt(Wm, Hm) {
  const pad = 30, w = Wm * PX + pad * 2, h = Hm * PX + pad * 2, c = cv(w, h), x = c.getContext('2d');
  x.beginPath(); x.roundRect(pad, pad, w - 2 * pad, h - 2 * pad, 18); inked(x, '#C99A4B', 10);
  x.fillStyle = '#A97B35'; x.fillRect(w / 2 - .003 * PX, pad + 20, .006 * PX, h - 2 * pad - 40);
  for (let y = pad + .01 * PX; y < h - pad; y += .0125 * PX) { x.fillStyle = INK; x.fillRect(pad + 14, y, .006 * PX, 6); x.fillRect(w - pad - 14 - .006 * PX, y, .006 * PX, 6); }
  return finishCut(c, 16);
}

// —— 拉片：米白纸条，朱红拉头 + 圆孔 + 箭头 ——
export function tabArt(Wm, Hm) {
  const pad = 30, w = Wm * PX + pad * 2, h = Hm * PX + pad * 2, c = cv(w, h), x = c.getContext('2d');
  x.beginPath(); x.roundRect(pad, pad, w - 2 * pad, h - 2 * pad, 40); inked(x, '#F6EBD4', 9);
  const hh = .028 * PX; x.beginPath(); x.roundRect(pad, h - pad - hh, w - 2 * pad, hh, 40); inked(x, VERM, 9);
  x.beginPath(); x.arc(w / 2, h - pad - hh * .5, .0055 * PX, 0, TAU); x.fillStyle = '#4a3528'; x.fill();
  x.beginPath(); x.moveTo(w / 2, h - pad - hh - .006 * PX); x.lineTo(w / 2 - .007 * PX, h - pad - hh - .016 * PX); x.lineTo(w / 2 + .007 * PX, h - pad - hh - .016 * PX); x.closePath(); x.fillStyle = VERM; x.fill();
  return finishCut(c, 14);
}

// —— 纸条标签（打字）：n = 已打出的字数 ——
export const LPX = 9000;
export function labelArt(c, Wm, Hm, text, n) {
  const pad = 40, w = c.width, h = c.height, x = c.getContext('2d');
  x.clearRect(0, 0, w, h);
  const art = cv(w, h), y = art.getContext('2d');
  y.beginPath(); y.roundRect(pad, pad, w - 2 * pad, h - 2 * pad, 10); inked(y, '#FBF4E4', 9);
  y.strokeStyle = 'rgba(58,42,32,.5)'; y.lineWidth = 3; y.strokeRect(pad + 22, pad + 22, w - 2 * pad - 44, h - 2 * pad - 44);
  const sq = (h - 2 * pad) * .34; y.fillStyle = VERM; y.fillRect(pad + 60, h / 2 - sq / 2, sq, sq);
  const fs = (h - 2 * pad) * .5;
  y.font = `700 ${fs}px NSC`; y.fillStyle = INK; y.textBaseline = 'middle'; y.textAlign = 'left';
  const x0 = pad + 60 + sq + fs * .5, totalW = y.measureText(text).width;
  const span = w - pad - 70 - x0, ls = (span - totalW) / (text.length - 1);
  let xx = x0;
  for (let i = 0; i < text.length; i++) { const cw = y.measureText(text[i]).width; if (i < n) y.fillText(text[i], xx, h / 2 + fs * .04); xx += cw + ls; }
  // 光标（打字时的朱红短竖）
  if (n < text.length && n > 0) { y.fillStyle = VERM; let cx = x0; for (let i = 0; i < n; i++) cx += y.measureText(text[i]).width + ls; y.fillRect(cx, h / 2 - fs * .45, fs * .08, fs * .9); }
  x.drawImage(finishCut(art, 18), 0, 0);
  return { x0, fs };
}

// —— IP 卡片：原图整张印上，外加白边 + 灰切口；纸纹只盖白边 ——
export function cardArt(img, borderFrac = .045) {
  const iw = img.naturalWidth, ih = img.naturalHeight, b = Math.round(Math.min(iw, ih) * borderFrac), e = Math.max(4, Math.round(b * .14));
  const w = iw + 2 * b + 2 * e, h = ih + 2 * b + 2 * e, c = cv(w, h), x = c.getContext('2d');
  x.beginPath(); x.roundRect(0, e * .6, w, h - e * .6, b * .35); x.fillStyle = '#B4A894'; x.fill();         // 灰纸板切口（略偏下 = 厚度）
  x.beginPath(); x.roundRect(e, e * .2, w - 2 * e, h - 2 * e, b * .3); x.fillStyle = '#FFFCF4'; x.fill();      // 白边
  grainOver(x, w, h, .6);
  x.drawImage(img, e + b, e * .2 + b);                                                                       // 原图像素，原尺寸
  return { c, w, h, aspect: w / h, imgRect: [e + b, e * .2 + b, iw, ih] };
}

// —— 浪栏：低矮的海水纹纸栏（群青，呼应书脊布面）——
export function waveBandArt(Wm, Hm) {
  const pad = 40, w = Wm * PX + pad * 2, h = Hm * PX + pad, c = cv(w, h), x = c.getContext('2d');
  const r = .011 * PX, top = pad + r * .9;
  const path = () => { x.beginPath(); x.moveTo(pad, h); x.lineTo(pad, top + r);
    for (let xx = pad; xx < w - pad - 1; xx += r * 2) x.arc(xx + r, top + r, r, Math.PI, 0);
    x.lineTo(w - pad, h); x.closePath(); };
  path(); inked(x, '#2C4F8C', 0);
  x.save(); path(); x.clip();
  for (let row = 0, y = top + r; y < h + r; row++, y += r * .85) for (let xx = pad + (row % 2) * r; xx < w + r; xx += r * 2) {
    x.beginPath(); x.arc(xx + r, y + r * .1, r * .98, Math.PI, 0); x.fillStyle = row % 2 ? '#3A64A8' : '#2C4F8C'; x.fill();
    for (let k = 1; k <= 3; k++) { x.beginPath(); x.arc(xx + r, y + r * .1, r * (k / 3.4), Math.PI, 0); x.strokeStyle = 'rgba(255,248,230,.85)'; x.lineWidth = 5; x.stroke(); }
  }
  x.restore();
  path(); inked(x, null, 11);
  return finishCut(c, 20);
}
