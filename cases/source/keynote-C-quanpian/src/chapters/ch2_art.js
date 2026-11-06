// 第二章 角色叙事 · 纸件美术（Canvas2D）。只画纸：背板、地面、纸浪、夜云、屋檐、月亮、日芒、字牌、转盘面。
// 约定同开头 art.js：PX = 5000 像素/米；墨色深棕、粗描边 + 细线、单一月牙暗部；白边切口由 kit.piece / kit.vfold 加（finishCut）。
// 不画任何清单外的文字：字牌只接收 TEXT.ch2.* 传进来的字符串。
import { PX, INK, VERM, GOLD, CREAM, cv, mulberry, GRAIN } from '../art.js';

const TAU = Math.PI * 2;
export const TPX = 9000;   // 字牌画布像素/米（字要锐利）

function grainOver(x, w, h, a = .85) { x.save(); x.globalCompositeOperation = 'source-atop'; x.globalAlpha = a; x.fillStyle = x.createPattern(GRAIN, 'repeat'); x.fillRect(0, 0, w, h); x.restore(); }
function mottle(x, w, h, seed, amt = .06, n = 70, dark = 'rgba(120,90,60,A)', light = 'rgba(255,255,255,A)') {
  const R = mulberry(seed);
  for (let i = 0; i < n; i++) { const px = R() * w, py = R() * h, r = (40 + R() * 220) * w / 2400, g = x.createRadialGradient(px, py, 0, px, py, r), dk = R() < .5;
    g.addColorStop(0, (dk ? dark : light).replace('A', (amt * (dk ? 1 : 1.4) * R()).toFixed(3))); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }
}
function inked(x, fill, lw, col = INK) { if (fill) { x.fillStyle = fill; x.fill(); } if (lw) { x.lineWidth = lw; x.strokeStyle = col; x.lineJoin = 'round'; x.lineCap = 'round'; x.stroke(); } }
function crescent(x, path, shade, dx, dy, base) { x.save(); path(); x.clip(); x.fillStyle = shade; x.fillRect(-1e4, -1e4, 3e4, 3e4); x.translate(-dx, -dy); path(); x.fillStyle = base; x.fill(); x.restore(); }
function frame(x, w, h, col = VERM) { x.strokeStyle = col; x.lineWidth = 10; x.strokeRect(.012 * PX, .012 * PX, w - .024 * PX, h - .024 * PX); x.lineWidth = 3; x.strokeRect(.017 * PX, .017 * PX, w - .034 * PX, h - .034 * PX); }
function gutter(x, w, h, atTop, a = .25) {   // 书沟阴影（地面页上沿 / 背板下沿 = 书脊一侧）
  const d = .03 * PX, g = atTop ? x.createLinearGradient(0, 0, 0, d) : x.createLinearGradient(0, h, 0, h - d);
  g.addColorStop(0, `rgba(40,28,16,${a})`); g.addColorStop(1, 'rgba(40,28,16,0)'); x.fillStyle = g; x.fillRect(0, atTop ? 0 : h - d, w, d);
}
// 祥云卷（同开头的语法：合并轮廓粗墨 + 内卷涡线）
function puffRow(x, x0, x1, top, rMin, rMax, seed, fill, line, lw = 18) {
  const R = mulberry(seed), pts = [];
  for (let xx = x0, i = 0; xx < x1; i++) { const r = (rMin + (rMax - rMin) * R()) * PX; pts.push([xx + r * .9, top + r * (.75 + .4 * R()), r]); xx += r * 1.45; }
  return pts;
}

// ———————————————— 2a：日芒（朱红 / 金放射纸芒，中空） ————————————————
export function sunburstArt(r0, r1, n = 18) {
  const pad = 40, R = r1 * PX, w = 2 * R + 2 * pad, c = cv(w, w), x = c.getContext('2d'), cx = w / 2;
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU, da = TAU / n * .36, long = i % 2 ? .82 : 1;
    const rr = (r0 + (r1 - r0) * long) * PX;
    x.beginPath(); x.moveTo(cx + Math.cos(a - da) * r0 * PX, cx + Math.sin(a - da) * r0 * PX);
    x.lineTo(cx + Math.cos(a) * rr, cx + Math.sin(a) * rr);
    x.lineTo(cx + Math.cos(a + da) * r0 * PX, cx + Math.sin(a + da) * r0 * PX);
    x.arc(cx, cx, r0 * PX, a + da, a - da, true); x.closePath();
    const path = () => { x.beginPath(); x.moveTo(cx + Math.cos(a - da) * r0 * PX, cx + Math.sin(a - da) * r0 * PX); x.lineTo(cx + Math.cos(a) * rr, cx + Math.sin(a) * rr); x.lineTo(cx + Math.cos(a + da) * r0 * PX, cx + Math.sin(a + da) * r0 * PX); x.closePath(); };
    const base = i % 2 ? GOLD : VERM, shade = i % 2 ? '#B9832C' : '#A93127';
    path(); inked(x, base, 0); crescent(x, path, shade, Math.cos(a + 1.6) * 14, Math.sin(a + 1.6) * 14, base); path(); inked(x, null, 9);
  }
  // 内圈细环（压住芒根）
  x.beginPath(); x.arc(cx, cx, r0 * PX + 6, 0, TAU); x.lineWidth = 12; x.strokeStyle = INK; x.stroke();
  return c;
}

// ———————————————— 2b：群青海 ————————————————
export function seaBackArt(Wm, Hm) {
  const w = Wm * PX, h = Hm * PX, c = cv(w, h), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#F3D9A6'); g.addColorStop(.55, '#F6E6C4'); g.addColorStop(1, '#F1E9D3');
  x.fillStyle = g; x.fillRect(0, 0, w, h); mottle(x, w, h, 41, .07, 80);
  // 远岛（青绿，两侧低矮）
  const isl = (cx, cw, ch, fill, shade, seed) => { const R = mulberry(seed), base = h - .065 * PX, pts = [[cx - cw / 2, base]];
    for (let i = 1; i < 6; i++) pts.push([cx - cw / 2 + cw * i / 6, base - ch * (.45 + .55 * Math.sin(Math.PI * i / 6)) * (.8 + .3 * R())]);
    pts.push([cx + cw / 2, base]);
    const path = () => { x.beginPath(); x.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length - 1; i++) { const p = pts[i], q = pts[i + 1]; x.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2); } x.lineTo(pts[pts.length - 1][0], base); x.closePath(); };
    path(); inked(x, fill, 0); crescent(x, path, shade, -20, 8, fill); path(); inked(x, null, 10); };
  isl(w * .16, .16 * PX, .05 * PX, '#8FC4AE', '#73AE97', 3); isl(w * .86, .13 * PX, .042 * PX, '#8FC4AE', '#73AE97', 7);
  isl(w * .3, .1 * PX, .03 * PX, '#4C9A86', '#3B826F', 11);
  // 远海一条（深蓝纸条）
  x.beginPath(); x.rect(0, h - .07 * PX, w, .07 * PX); inked(x, '#3A64A8', 0);
  x.strokeStyle = 'rgba(255,248,230,.75)'; x.lineWidth = 5;
  for (let row = 0; row < 3; row++) for (let xx = (row % 2) * 60; xx < w; xx += 120) { x.beginPath(); x.arc(xx, h - .055 * PX + row * .018 * PX, 40, Math.PI * 1.1, Math.PI * 1.9); x.stroke(); }
  x.beginPath(); x.moveTo(0, h - .07 * PX); x.lineTo(w, h - .07 * PX); x.lineWidth = 10; x.strokeStyle = INK; x.stroke();
  // 薄云纸条
  [[.06, .2, .16], [.6, .14, .2], [.34, .3, .12], [.78, .34, .1]].forEach(([fx, fy, fl]) => {
    const cx = fx * w, cy = fy * h, L = fl * w, th = .011 * PX;
    x.beginPath(); x.roundRect(cx, cy, L, th, th / 2); inked(x, '#FBF1DC', 8);
    x.beginPath(); x.roundRect(cx + L * .25, cy + th * .9, L * .5, th * .75, th / 2); inked(x, '#F4E2C0', 7);
  });
  frame(x, w, h); grainOver(x, w, h); gutter(x, w, h, false, .22);
  return c;
}
export function seaFloorArt(Wm, Dm) {
  const w = Wm * PX, h = Dm * PX, c = cv(w, h), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#2E5A8E'); g.addColorStop(1, '#3E73A6'); x.fillStyle = g; x.fillRect(0, 0, w, h);
  mottle(x, w, h, 57, .08, 60, 'rgba(10,25,60,A)', 'rgba(220,235,255,A)');
  const r = .02 * PX;   // 青海波
  for (let row = 0, y = -r * .4; y < h + r; row++, y += r * .55) for (let xx = (row % 2) * r; xx < w + r; xx += r * 2) {
    x.beginPath(); x.arc(xx, y + r, r, Math.PI, TAU); x.lineTo(xx + r, y + r * 1.6); x.lineTo(xx - r, y + r * 1.6); x.closePath(); x.fillStyle = row % 2 ? '#34639A' : '#2F5B90'; x.fill();
    for (let k = 1; k <= 3; k++) { x.beginPath(); x.arc(xx, y + r, r * (k / 3.3), Math.PI, TAU); x.strokeStyle = 'rgba(232,240,250,.42)'; x.lineWidth = 4; x.stroke(); }
  }
  grainOver(x, w, h); gutter(x, w, h, true, .3); frame(x, w, h, GOLD);
  return c;
}
// 纸浪：一排卷浪（浪头卷起 + 浪花白线），k = 0 后 / 1 中 / 2 前
export function waveArt(Wm, Hm, k) {
  const pad = 40, w = Wm * PX + pad * 2, h = Hm * PX + pad, c = cv(w, h), x = c.getContext('2d');
  const fills = ['#2C4F8C', '#3A64A8', '#4F86BE'], shades = ['#223F72', '#2E5290', '#3C6EA4'], R = mulberry(90 + k);
  const n = [6, 7, 8][k], step = (w - 2 * pad) / n, base = h;
  const crest = []; for (let i = 0; i < n; i++) crest.push([pad + step * (i + .5) + (R() - .5) * step * .15, pad + (R() * .25) * (h - pad), step * (.42 + .08 * R())]);
  const path = () => { x.beginPath(); x.moveTo(pad, base); x.lineTo(pad, crest[0][1] + crest[0][2] * .9);
    for (const [cx, cy, r] of crest) { x.quadraticCurveTo(cx - r * .9, cy + r * .2, cx - r * .15, cy); x.quadraticCurveTo(cx + r * .55, cy - r * .05, cx + r * .62, cy + r * .45);
      x.quadraticCurveTo(cx + r * .5, cy + r * .9, cx + r * .95, cy + r * .95); }
    x.lineTo(w - pad, base); x.closePath(); };
  path(); inked(x, fills[k], 0); crescent(x, path, shades[k], -22, 12, fills[k]);
  // 浪花：每个浪头一道卷曲白线 + 一排浪点
  x.save(); path(); x.clip();
  for (const [cx, cy, r] of crest) {
    x.beginPath(); for (let j = 0; j < 40; j++) { const a = Math.PI * 1.15 + j / 40 * TAU * .85, s = r * .38 * (1 - j / 60); const X = cx + r * .2 + Math.cos(a) * s, Y = cy + r * .42 + Math.sin(a) * s; j ? x.lineTo(X, Y) : x.moveTo(X, Y); }
    x.lineWidth = 9; x.strokeStyle = CREAM; x.lineCap = 'round'; x.stroke();
    for (let j = 0; j < 3; j++) { x.beginPath(); x.arc(cx - r * (.35 + .22 * j), cy + r * (.55 + .16 * j), r * (.18 - .03 * j), Math.PI, TAU); x.lineWidth = 6; x.strokeStyle = 'rgba(255,248,230,.85)'; x.stroke(); }
  }
  x.restore();
  path(); inked(x, null, 12);
  return c;
}

// ———————————————— 2c：靛蓝夜 ————————————————
export function nightBackArt(Wm, Hm) {
  const w = Wm * PX, h = Hm * PX, c = cv(w, h), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1B2340'); g.addColorStop(.6, '#2A3760'); g.addColorStop(1, '#3B4A74');
  x.fillStyle = g; x.fillRect(0, 0, w, h); mottle(x, w, h, 63, .08, 70, 'rgba(5,8,20,A)', 'rgba(170,190,240,A)');
  // 星：小四角星 + 点（奶油 / 金）
  const R = mulberry(77);
  for (let i = 0; i < 46; i++) {
    const px = R() * w, py = R() * h * .72, s = (.0018 + R() * .004) * PX, col = R() < .3 ? GOLD : '#F4ECD2';
    if (R() < .4) { x.beginPath(); for (let k = 0; k < 8; k++) { const a = k / 8 * TAU, rr = k % 2 ? s * .32 : s; x.lineTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr); } x.closePath(); x.fillStyle = col; x.fill(); }
    else { x.beginPath(); x.arc(px, py, s * .35, 0, TAU); x.fillStyle = col; x.fill(); }
  }
  // 月亮的纸槽（竖直的切口，月亮沿它上升）
  const sx = w / 2 + .1 * PX; x.beginPath(); x.roundRect(sx - .003 * PX, h - .2 * PX, .006 * PX, .19 * PX, .003 * PX); x.fillStyle = 'rgba(8,10,24,.55)'; x.fill();
  frame(x, w, h, '#8D7A55'); grainOver(x, w, h, .7); gutter(x, w, h, false, .35);
  return c;
}
export function nightFloorArt(Wm, Dm) {
  const w = Wm * PX, h = Dm * PX, c = cv(w, h), x = c.getContext('2d');
  x.fillStyle = '#3C4766'; x.fillRect(0, 0, w, h); mottle(x, w, h, 81, .08, 60, 'rgba(10,12,30,A)', 'rgba(200,210,240,A)');
  // 石板路：错缝的圆角方块
  const bw = .03 * PX, bh = .018 * PX, R = mulberry(5);
  for (let row = 0, y = 0; y < h; row++, y += bh) for (let xx = -(row % 2) * bw / 2; xx < w; xx += bw) {
    x.beginPath(); x.roundRect(xx + 5, y + 5, bw - 10, bh - 10, 14); { const v = R() * 14; x.fillStyle = `rgb(${66 + v},${76 + v},${106 + v})`; }; x.fill();
    x.lineWidth = 3; x.strokeStyle = 'rgba(20,22,40,.5)'; x.stroke();
  }
  grainOver(x, w, h, .75); gutter(x, w, h, true, .35); frame(x, w, h, '#8D7A55');
  return c;
}
// 夜云折页（深靛云带 + 银灰涡线）；底部实心到 solid 米以上，保证月亮在后面藏得住
export function nightCloudArt(Wm, Hm, solid) {
  const pad = 40, w = Wm * PX + pad * 2, h = Hm * PX + pad, c = cv(w, h), x = c.getContext('2d');
  const top = h - solid * PX, pts = puffRow(x, pad, w - pad - .02 * PX, top - .028 * PX, .016, .026, 33);
  x.beginPath(); for (const [px, py, r] of pts) { x.moveTo(px + r, py); x.arc(px, py, r, 0, TAU); } x.rect(pad, top, w - 2 * pad, h - top);
  x.save(); x.lineWidth = 22; x.strokeStyle = INK; x.lineJoin = 'round'; x.stroke(); x.fillStyle = '#34416A'; x.fill(); x.restore();
  x.save(); x.strokeStyle = '#9FB2D8'; x.lineWidth = 8; x.lineCap = 'round';
  pts.forEach(([px, py, r], i) => { if (i % 2) return; x.beginPath(); for (let j = 0; j < 36; j++) { const a = j / 36 * TAU * 1.2, s = r * .6 * (1 - j / 46); const X = px + Math.cos(a + 2) * s, Y = py + Math.sin(a + 2) * s; j ? x.lineTo(X, Y) : x.moveTo(X, Y); } x.stroke(); });
  x.restore();
  return c;
}
// 屋檐剪影（深靛黑瓦顶、翘檐，暖黄小窗）——没有人、没有字
export function roofsArt(Wm, Hm) {
  const pad = 40, w = Wm * PX + pad * 2, h = Hm * PX + pad, c = cv(w, h), x = c.getContext('2d'), R = mulberry(19);
  const houses = []; let xx = pad;
  while (xx < w - pad - .02 * PX) { const hw = (.045 + R() * .035) * PX, hh = (.028 + R() * .028) * PX; houses.push([xx, Math.min(hw, w - pad - xx), hh]); xx += hw * (.82 + R() * .1); }
  for (const [x0, hw, hh] of houses) {
    const wallTop = h - hh, roofH = hh * .42, eave = hw * .09;
    // 墙
    x.beginPath(); x.rect(x0 + eave, wallTop, hw - 2 * eave, hh); inked(x, '#2B3354', 9);
    // 窗（暖黄）
    const nw = Math.max(1, Math.floor((hw - 2 * eave) / (.018 * PX)));
    for (let i = 0; i < nw; i++) if (R() < .6) { const wx = x0 + eave + (i + .5) * (hw - 2 * eave) / nw - .004 * PX, wy = wallTop + hh * .35; x.beginPath(); x.roundRect(wx, wy, .008 * PX, .011 * PX, 6); inked(x, '#F2C46A', 5); }
    // 翘檐瓦顶
    x.beginPath(); x.moveTo(x0 - eave * .6, wallTop - roofH * .05); x.quadraticCurveTo(x0 + eave, wallTop + roofH * .05, x0 + hw * .2, wallTop - roofH * .55);
    x.lineTo(x0 + hw * .8, wallTop - roofH * .55); x.quadraticCurveTo(x0 + hw - eave, wallTop + roofH * .05, x0 + hw + eave * .6, wallTop - roofH * .05);
    x.lineTo(x0 + hw - eave, wallTop + roofH * .2); x.lineTo(x0 + eave, wallTop + roofH * .2); x.closePath(); inked(x, '#1E2440', 10);
    x.strokeStyle = 'rgba(160,180,220,.35)'; x.lineWidth = 4; for (let k = 1; k < 4; k++) { x.beginPath(); x.moveTo(x0 + hw * .2, wallTop - roofH * .55 + k * roofH * .17); x.lineTo(x0 + hw * .8, wallTop - roofH * .55 + k * roofH * .17); x.stroke(); }
  }
  return c;
}
// 纸月亮：奶油色圆盘 + 灰蓝斑 + 月牙暗部
export function moonArt(r) {
  const pad = 40, R0 = r * PX, w = 2 * R0 + 2 * pad, c = cv(w, w), x = c.getContext('2d'), cx = w / 2;
  const path = () => { x.beginPath(); x.arc(cx, cx, R0, 0, TAU); };
  path(); inked(x, '#F6F0DA', 0);
  const RR = mulberry(12); x.save(); path(); x.clip();
  for (let i = 0; i < 14; i++) { const a = RR() * TAU, d = Math.sqrt(RR()) * R0 * .82, rr = R0 * (.04 + RR() * .1); x.beginPath(); x.arc(cx + Math.cos(a) * d, cx + Math.sin(a) * d, rr, 0, TAU); x.fillStyle = 'rgba(176,168,140,.22)'; x.fill(); x.lineWidth = 3; x.strokeStyle = 'rgba(140,132,110,.25)'; x.stroke(); }
  x.restore();
  x.save(); path(); x.clip(); x.beginPath(); x.rect(-1e4, -1e4, 3e4, 3e4); x.arc(cx - R0 * .14, cx + R0 * .1, R0, 0, TAU); x.fillStyle = 'rgba(150,160,185,.38)'; x.fill('evenodd'); x.restore();
  path(); inked(x, null, 12);
  return c;
}

// ———————————————— 2d：暖黄晴 ————————————————
export function sunnyBackArt(Wm, Hm) {
  const w = Wm * PX, h = Hm * PX, c = cv(w, h), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#F5D98E'); g.addColorStop(.6, '#F8E8B8'); g.addColorStop(1, '#F7EED6');
  x.fillStyle = g; x.fillRect(0, 0, w, h); mottle(x, w, h, 91, .07, 80);
  // 同心圆弧（像唱片纹 / 年轮：成长）
  const cx = w / 2, cy = h + .02 * PX;
  for (let k = 0; k < 9; k++) { x.beginPath(); x.arc(cx, cy, (.07 + k * .028) * PX, Math.PI, TAU); x.lineWidth = k % 3 === 0 ? 10 : 5; x.strokeStyle = k % 3 === 0 ? 'rgba(190,58,46,.5)' : 'rgba(170,120,50,.28)'; x.stroke(); }
  // 纸屑小图案（朱红三角、青绿圆点、金色短条）
  const R = mulberry(23);
  for (let i = 0; i < 34; i++) {
    const px = R() * w, py = R() * h * .8, s = (.004 + R() * .004) * PX, k = i % 3, a = R() * TAU;
    x.save(); x.translate(px, py); x.rotate(a); x.beginPath();
    if (k === 0) { x.moveTo(0, -s); x.lineTo(s * .9, s * .6); x.lineTo(-s * .9, s * .6); x.closePath(); inked(x, VERM, 5); }
    else if (k === 1) { x.arc(0, 0, s * .6, 0, TAU); inked(x, '#4C9A86', 5); }
    else { x.roundRect(-s, -s * .25, 2 * s, s * .5, s * .25); inked(x, GOLD, 5); }
    x.restore();
  }
  frame(x, w, h); grainOver(x, w, h); gutter(x, w, h, false, .22);
  return c;
}
export function sunnyFloorArt(Wm, Dm) {
  const w = Wm * PX, h = Dm * PX, c = cv(w, h), x = c.getContext('2d');
  x.fillStyle = '#E6E3BE'; x.fillRect(0, 0, w, h); mottle(x, w, h, 101, .07, 70);
  // 细格子（绘本桌布）
  x.strokeStyle = 'rgba(76,154,134,.22)'; x.lineWidth = 5;
  for (let xx = 0; xx < w; xx += .02 * PX) { x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx, h); x.stroke(); }
  for (let y = 0; y < h; y += .02 * PX) { x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); }
  // 转盘下的圆形压痕
  const cx = w / 2, cy = (.137 - .03) * PX; x.beginPath(); x.arc(cx, cy, .104 * PX, 0, TAU); x.fillStyle = 'rgba(90,70,40,.12)'; x.fill();
  grainOver(x, w, h); gutter(x, w, h, true, .28); frame(x, w, h);
  return c;
}
// 转盘面：米白圆盘，朱红 / 金扇区，外圈棘齿刻度
export function turntableTopArt(r) {
  const S = 2048, c = cv(S, S), x = c.getContext('2d'), cx = S / 2, R = S / 2 - 8;
  x.beginPath(); x.arc(cx, cx, R, 0, TAU); x.fillStyle = '#FBF4E4'; x.fill();
  for (let i = 0; i < 8; i++) { x.beginPath(); x.moveTo(cx, cx); x.arc(cx, cx, R * .78, i / 8 * TAU, (i + 1) / 8 * TAU); x.closePath(); x.fillStyle = i % 2 ? 'rgba(217,164,65,.55)' : 'rgba(190,58,46,.55)'; x.fill(); }
  x.beginPath(); x.arc(cx, cx, R * .78, 0, TAU); x.lineWidth = 10; x.strokeStyle = INK; x.stroke();
  for (let i = 0; i < 48; i++) { const a = i / 48 * TAU, r0 = R * (i % 4 ? .86 : .82); x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * R * .95, cx + Math.sin(a) * R * .95); x.lineWidth = i % 4 ? 5 : 10; x.strokeStyle = INK; x.stroke(); }
  x.beginPath(); x.arc(cx, cx, R * .1, 0, TAU); inked(x, VERM, 8);
  x.beginPath(); x.arc(cx, cx, R, 0, TAU); x.lineWidth = 14; x.strokeStyle = INK; x.stroke();
  grainOver(x, S, S, .7);
  return c;
}

// ———————————————— 字牌：米白纸板，大字 + 小字（只接收白名单字符串） ————————————————
export function plateArt(title, sub, { wM = .13, hM = sub ? .05 : .034, tSize = .022, sSize = .0088, font } = {}) {
  const pad = 40, W = wM * TPX + 2 * pad, H = hM * TPX + 2 * pad, c = cv(W, H), x = c.getContext('2d');
  x.beginPath(); x.roundRect(pad, pad, W - 2 * pad, H - 2 * pad, 26); inked(x, '#FBF4E4', 11);
  x.strokeStyle = 'rgba(58,42,32,.45)'; x.lineWidth = 3; x.beginPath(); x.roundRect(pad + 24, pad + 24, W - 2 * pad - 48, H - 2 * pad - 48, 14); x.stroke();
  const tf = tSize * TPX, sf = sSize * TPX;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = font('SC', tf); const tw = x.measureText(title).width;
  const ty = sub ? pad + (H - 2 * pad) * .38 : H / 2 + tf * .03;
  // 朱红小方块（开头标签的句首记号）
  const sq = tf * .3; x.fillStyle = VERM; x.fillRect(W / 2 - tw / 2 - sq * 1.9, ty - sq / 2, sq, sq);
  x.fillStyle = INK; x.font = font('SC', tf); x.fillText(title, W / 2 + sq * .2, ty);
  if (sub) {
    x.fillStyle = 'rgba(58,42,32,.5)'; x.fillRect(W / 2 - tf * .9, pad + (H - 2 * pad) * .64, tf * 1.8, 3);
    x.fillStyle = '#5A4636'; x.font = font('SCM', sf); x.fillText(sub, W / 2, pad + (H - 2 * pad) * .8);
  }
  return c;
}
