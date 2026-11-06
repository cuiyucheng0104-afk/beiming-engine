// 第 3 关 · 孔版网印：粉 / 蓝两块版各自一张密度画布（实地或网点），正片叠底套印 + 错位 + 缺墨颗粒
import { canvas, paperRiso, risoGrain, stepF, W, H } from './media.js';
import { clamp, lerp, eo, eio, hash, TAU } from '/core/lib.js';

export const PINK = '#ff48b0', BLUE = '#0078bf';
const PK = canvas(), pk = PK.getContext('2d'), BL = canvas(), bl = BL.getContext('2d');
function dotPattern(ctx, col, d, ang) { // 网点图案：格 10px，半径 ∝ √密度
  const cv = canvas(10, 10), g = cv.getContext('2d'); g.fillStyle = col; g.beginPath(); g.arc(5, 5, Math.min(7.2, 5.64 * Math.sqrt(d)), 0, TAU); g.fill();
  const p = ctx.createPattern(cv, 'repeat'); p.setTransform(new DOMMatrix().rotateSelf(ang)); return p;
}
const PAT = {};
export function tint(plate, d) { const key = plate + d; if (PAT[key]) return PAT[key];
  const ctx = plate === 'p' ? pk : bl; return PAT[key] = dotPattern(ctx, plate === 'p' ? PINK : BLUE, d, plate === 'p' ? 15 : 75); }
export const plates = () => ({ pk, bl });
export function clearPlates() { for (const g of [pk, bl]) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.clearRect(0, 0, W, H); } }
// 挖空（纸白）：两块版同时擦掉
export function knock(path) { for (const g of [pk, bl]) { g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); path(g); g.fill(); g.restore(); } }
export function fillP(g, path, style) { g.beginPath(); path(g); g.fillStyle = style; g.fill(); }
export function strokeP(g, path, style, w) { g.beginPath(); path(g); g.strokeStyle = style; g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(); }
// 合成到输出：纸 → 叠印两版（各带固定错位）
export function printPlates(out, mis = [7, -5], { paper = true, mode = 'multiply' } = {}) {
  for (const g of [pk, bl]) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-out'; g.globalAlpha = .55; g.drawImage(risoGrain(), 0, 0); g.restore(); }
  if (paper) out.drawImage(paperRiso(), 0, 0);
  out.save(); out.globalCompositeOperation = mode;
  out.drawImage(PK, 0, 0); out.drawImage(BL, mis[0], mis[1]);
  out.restore();
}

// 全身小豆子（BOSS 用）：x,y = 脚底；arms: {l:[x,y], r:[x,y]} 手的位置（相对肩）
export function heroRisoBody(x, y, s, arms, face = 'o') {
  for (const g of [pk, bl]) { g.save(); g.translate(x, y); g.scale(s, s); }
  const P = (path, st, plate) => fillP(plate === 'p' ? pk : bl, path, st);
  // 腿
  for (const sg of [-1, 1]) { P(c => c.roundRect(sg * 40 - 18, -110, 36, 100, 14), BLUE, 'b'); P(c => c.ellipse(sg * 46, -12, 42, 20, 0, 0, TAU), PINK, 'p'); }
  // 身体（蓝 60%）
  P(c => c.roundRect(-90, -300, 180, 210, 56), tint('b', .6), 'b');
  strokeP(bl, c => c.roundRect(-90, -300, 180, 210, 56), BLUE, 10);
  // 手臂
  for (const [sg, h] of [[-1, arms.l], [1, arms.r]]) {
    strokeP(bl, c => { c.moveTo(sg * 76, -270); c.quadraticCurveTo(sg * 76 + (h[0] - sg * 76) * .4, -270 + (h[1] + 270) * .1 - 40, h[0], h[1]); }, BLUE, 26);
    P(c => c.arc(h[0], h[1], 30, 0, TAU), tint('p', .45), 'p'); strokeP(bl, c => c.arc(h[0], h[1], 30, 0, TAU), BLUE, 8);
  }
  // 头
  P(c => c.arc(0, -400, 110, 0, TAU), tint('p', .25), 'p'); strokeP(bl, c => c.arc(0, -400, 110, 0, TAU), BLUE, 11);
  // 红帽（粉色实地）+ 白边 + 绒球
  P(c => { c.moveTo(-116, -420); c.bezierCurveTo(-116, -560, 116, -560, 116, -420); c.closePath(); }, PINK, 'p');
  P(c => c.arc(0, -548, 30, 0, TAU), PINK, 'p');
  for (const g of [pk, bl]) { g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.roundRect(-120, -440, 240, 36, 16); g.fill(); g.restore(); }
  strokeP(bl, c => c.roundRect(-120, -440, 240, 36, 16), BLUE, 7);
  // 脸
  for (const sg of [-1, 1]) P(c => c.arc(sg * 40, -380, 13, 0, TAU), BLUE, 'b');
  if (face === 'o') P(c => c.ellipse(0, -330, 16, 20, 0, 0, TAU), BLUE, 'b');
  else strokeP(bl, c => c.arc(0, -350, 30, .3, Math.PI - .3), BLUE, 9);
  P(c => { c.arc(-70, -350, 18, 0, TAU); c.arc(70, -350, 18, 0, TAU); }, tint('p', .7), 'p');
  for (const g of [pk, bl]) g.restore();
}

const FOAM = [...Array(40)].map((_, i) => ({ a: hash(i * 2.3) * TAU, r: .55 + hash(i * 5.1) * .5, s: 16 + hash(i * 9.7) * 34, k: Math.floor(hash(i * 3.3) * 4) }));

// 第 3 关：刷牙特写
export function game3(out, lf, fpb) {
  clearPlates();
  const sf = stepF(lf, fpb, 3), b = sf / fpb, tb = lf / fpb;
  const zoom = lerp(1, 1.09, eio(tb / 6)), rot = lerp(-.018, .018, eio(tb / 6));
  for (const g of [pk, bl]) { g.translate(960, 600); g.rotate(rot); g.scale(zoom, zoom); g.translate(-960, -600); }
  // 浴室瓷砖（蓝 25% 网点 + 蓝线）
  fillP(bl, c => c.rect(-100, -100, 2120, 1280), tint('b', .18), 'b');
  bl.save(); bl.strokeStyle = BLUE; bl.lineWidth = 5; bl.beginPath(); for (let x = -100; x < 2100; x += 150) { bl.moveTo(x, -100); bl.lineTo(x, 1200); } for (let y = -40; y < 1200; y += 150) { bl.moveTo(-100, y); bl.lineTo(2100, y); } bl.stroke(); bl.restore();
  // 头（粉 25%）——挖白光晕把人物从背景里托出来
  knock(c => c.arc(960, 700, 520, 0, TAU));
  fillP(pk, c => c.arc(960, 700, 490, 0, TAU), tint('p', .28));
  strokeP(bl, c => c.arc(960, 700, 490, 0, TAU), BLUE, 14);
  // 红帽
  const hat = c => { c.moveTo(380, 330); c.bezierCurveTo(420, -160, 1500, -160, 1540, 330); c.closePath(); };
  knock(hat);
  fillP(pk, hat, PINK);
  knock(c => c.roundRect(360, 260, 1200, 96, 40));
  fillP(bl, c => c.roundRect(360, 260, 1200, 96, 40), tint('b', .3)); strokeP(bl, c => c.roundRect(360, 260, 1200, 96, 40), BLUE, 10);
  for (let x = 420; x < 1520; x += 60) strokeP(pk, c => { c.moveTo(x, 70 + Math.abs(x - 960) * .25); c.lineTo(x + 20, 250); }, PINK, 6);
  // 眼睛：刷牙时眯成弯；闪光时睁大
  const shine = b >= 5, sOpen = shine ? 1 : 0;
  for (const sg of [-1, 1]) {
    const ex = 960 + sg * 210, ey = 470;
    if (sOpen) { fillP(bl, c => c.ellipse(ex, ey, 34, 46, 0, 0, TAU), BLUE); knock(c => c.arc(ex + 10, ey - 16, 12, 0, TAU)); }
    else strokeP(bl, c => c.arc(ex, ey + 26, 46, Math.PI + .35, -.35), BLUE, 20);
    fillP(pk, c => c.ellipse(ex + sg * 70, 600, 70, 46, 0, 0, TAU), tint('p', .75));
  }
  // 嘴（大笑 D 形）
  const mouth = c => { c.moveTo(680, 640); c.quadraticCurveTo(960, 640, 1240, 640); c.quadraticCurveTo(1220, 950, 960, 960); c.quadraticCurveTo(700, 950, 680, 640); c.closePath(); };
  fillP(bl, mouth, tint('b', .85)); fillP(pk, mouth, tint('p', .6));
  fillP(pk, c => c.ellipse(960, 900, 170, 60, 0, 0, TAU), PINK);            // 舌头
  // 牙齿：挖白 + 蓝线分隔
  knock(c => c.roundRect(720, 648, 480, 92, 22));
  for (let x = 780; x < 1200; x += 60) strokeP(bl, c => { c.moveTo(x, 652); c.lineTo(x, 734); }, BLUE, 5);
  strokeP(bl, c => c.roundRect(720, 648, 480, 92, 22), BLUE, 8);
  strokeP(bl, mouth, BLUE, 14);
  // 泡沫：每刷一下多一圈
  const strokes = clamp(Math.floor(tb + 1e-6), 0, 4);
  const foamN = shine ? 40 * (1 - clamp((tb - 5) * 2.5)) : strokes * 9;
  for (let i = 0; i < foamN; i++) { const f = FOAM[i], bx = 960 + Math.cos(f.a) * 330 * f.r, by = 790 + Math.sin(f.a) * 190 * f.r, s = f.s * (1 + .08 * Math.sin(lf * .7 + i));
    knock(c => c.arc(bx, by, s, 0, TAU)); strokeP(i % 2 ? bl : pk, c => c.arc(bx, by, s, 0, TAU), i % 2 ? BLUE : PINK, 5); }
  // 牙刷：每拍到达一端（逐帧动），进场 b0.55→b1
  let bx;
  if (tb < .55) bx = 2300; else if (tb < 1) bx = lerp(2300, 1130, eo((tb - .55) / .45));
  else { const k = Math.floor(tb), fr = lf - k * fpb, from = k % 2 ? 1130 : 790, to = k % 2 ? 790 : 1130;
    const u = k >= 4 ? 1 : clamp((fr - (fpb - 4)) / 4); bx = tb >= 4.6 ? lerp(from, 2300, eio(clamp((tb - 4.6) / .4))) : lerp(from, to, eio(u)); if (k >= 5) bx = 2300; }
  const by = 700;
  if (bx < 2200) {
    strokeP(bl, c => { c.moveTo(bx + 60, by); c.lineTo(bx + 900, by + 300); }, BLUE, 56);
    fillP(pk, c => c.roundRect(bx - 110, by - 30, 200, 60, 20), PINK);
    for (let k = 0; k < 9; k++) strokeP(pk, c => { c.moveTo(bx - 95 + k * 22, by - 30); c.lineTo(bx - 95 + k * 22, by - 92); }, PINK, 12);
    fillP(pk, c => c.arc(bx + 640, by + 210, 110, 0, TAU), tint('p', .45)); strokeP(bl, c => c.arc(bx + 640, by + 210, 110, 0, TAU), BLUE, 12);
  }
  // 闪光 ✦
  let mis = [7, -5];
  if (shine) { const k = clamp((tb - 5) * 3); mis = [lerp(26, 7, eo(k)), lerp(-16, -5, eo(k))];
    for (const [sx, sy, r] of [[800, 690, 120], [1130, 660, 90], [990, 600, 60]]) { const rr = r * (.6 + .4 * eo(k));
      const st = c => { for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, q = i % 2 ? rr * .22 : rr; i ? c.lineTo(sx + Math.cos(a) * q, sy + Math.sin(a) * q) : c.moveTo(sx + Math.cos(a) * q, sy + Math.sin(a) * q); } c.closePath(); };
      knock(c => c.arc(sx, sy, rr * .5, 0, TAU)); fillP(bl, st, BLUE); fillP(pk, c => c.arc(sx, sy, rr * .18, 0, TAU), PINK); } }
  printPlates(out, mis);
}
