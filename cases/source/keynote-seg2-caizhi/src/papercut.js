// 剪纸：窗形剪线（海棠角 + 如意顶，锯齿刃口）、铁剪刀、窗扇（16 条带假透视翻折）、碎纸。
import { cv } from './assets.js';
import { clamp, lerp, mulberry, vnoise } from '/core/lib.js';
import { rosettePath } from './seal.js';

// 剪刀路线（局部坐标，窗心为原点）：左上 → 上边（如意顶）→ 右边 → 下边 → 左下；左边不剪，是合页折痕
export function windowRoute(hw, hh, c = 34, bump = 46) {
  const P = [];
  const arc = (cx, cy, a0, a1) => { for (let i = 0; i <= 14; i++) { const a = lerp(a0, a1, i / 14); P.push([cx + Math.cos(a) * c, cy + Math.sin(a) * c]); } };
  const line = (x0, y0, x1, y1, n) => { for (let i = 1; i <= n; i++) P.push([lerp(x0, x1, i / n), lerp(y0, y1, i / n)]); };
  // 左上海棠角（以角点为圆心的凹弧）
  arc(-hw, -hh, Math.PI / 2, 0);
  line(-hw + c, -hh, -78, -hh, 12);
  // 如意顶：两段弧线鼓起
  for (let i = 1; i <= 30; i++) { const u = i / 30, x = lerp(-78, 78, u), k = Math.sin(Math.PI * u); P.push([x, -hh - bump * Math.pow(k, .8) + 10 * Math.sin(Math.PI * 3 * u) * k]); }
  line(78, -hh, hw - c, -hh, 12);
  arc(hw, -hh, Math.PI, Math.PI / 2);
  line(hw, -hh + c, hw, hh - c, 40);
  arc(hw, hh, -Math.PI / 2, -Math.PI);
  line(hw - c, hh, -hw + c, hh, 30);
  arc(-hw, hh, 0, -Math.PI / 2);
  // 等弧长重采样
  const acc = [0]; for (let i = 1; i < P.length; i++) acc.push(acc[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = acc[acc.length - 1], ds = 1.5, R = [];
  for (let s = 0, j = 0; s <= L; s += ds) { while (j < acc.length - 2 && acc[j + 1] < s) j++; const u = (s - acc[j]) / ((acc[j + 1] - acc[j]) || 1); R.push([lerp(P[j][0], P[j + 1][0], u), lerp(P[j][1], P[j + 1][1], u)]); }
  const at = s => { const i = clamp(s / ds, 0, R.length - 1), k = Math.min(R.length - 2, Math.floor(i)), f = i - k; const a = R[k], b = R[k + 1]; const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1; return { x: lerp(a[0], b[0], f), y: lerp(a[1], b[1], f), tx: tx / l, ty: ty / l }; };
  return { pts: R, L, at, ds, hw, hh };
}

// 窗洞路径（闭合，含合页边）
export function holePath(g, W, ox, oy) {
  g.moveTo(ox + W.pts[0][0], oy + W.pts[0][1]);
  for (const p of W.pts) g.lineTo(ox + p[0], oy + p[1]);
  g.closePath();
}

// 剪缝：锯齿刃口，画到弧长 s
export function drawCut(g, W, ox, oy, s, color, width = 1.6) {
  if (s <= 0) return;
  g.beginPath();
  const n = Math.min(W.pts.length, Math.floor(s / W.ds) + 1);
  for (let i = 0; i < n; i++) {
    const p = W.pts[i], q = W.pts[Math.min(W.pts.length - 1, i + 1)], tx = q[0] - p[0], ty = q[1] - p[1], l = Math.hypot(tx, ty) || 1;
    const z = ((i % 6) < 3 ? 1 : -1) * 2.6;      // 锯齿（刃口 9px 一齿）
    const x = ox + p[0] - ty / l * z, y = oy + p[1] + tx / l * z;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'miter'; g.stroke();
}

// 窗扇贴图：正面（红纸，淡折痕）与背面（浅一档的红，团花镂空）
export function flapCanvases(W, redTex) {
  const w = W.hw * 2 + 4, h = W.hh * 2 + 70, ox = W.hw + 2, oy = W.hh + 60;
  const mk = back => {
    const c = cv(w, h), g = c.getContext('2d');
    g.save(); g.beginPath(); holePath(g, W, ox, oy); g.clip();
    g.drawImage(redTex, 400, 300, w, h, 0, 0, w, h);
    if (back) { g.globalCompositeOperation = 'screen'; g.fillStyle = 'rgba(78,30,18,1)'; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'source-over'; }
    // 阴刻内框线
    g.strokeStyle = back ? 'rgba(120,10,10,.55)' : 'rgba(90,0,0,.35)'; g.lineWidth = 2; g.save(); g.translate(ox, oy); g.scale(.9, .93); g.translate(-ox, -oy); g.beginPath(); holePath(g, W, ox, oy); g.stroke(); g.restore();
    if (back) {   // 团花镂空（只在翻过来后看见）
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineWidth = 7; g.lineCap = 'round';
      rosettePath(g, ox, oy - 20, W.hw * .62); g.fill('evenodd');
      g.lineWidth = 3; g.beginPath(); g.arc(ox, oy - 20, W.hw * .74, 0, 7); g.stroke();
      for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; g.beginPath(); g.ellipse(ox + Math.cos(a) * W.hw * .84, oy - 20 + Math.sin(a) * W.hw * .84, 9, 4, a, 0, 7); g.fill(); }
      for (const sy of [-1, 1]) for (let i = 0; i < 7; i++) { g.beginPath(); g.ellipse(ox - W.hw * .55 + i * W.hw * .183, oy + sy * W.hh * .78, 7, 13, 0, 0, 7); g.fill(); }
      g.globalCompositeOperation = 'source-over';
    }
    g.restore();
    return c;
  };
  return { front: mk(false), back: mk(true), w, h, ox, oy };
}

// 窗扇翻折：合页在 x=-hw（局部）。theta 0（闭合）→ π（向左平铺在纸上，露背面）
let FT = null;
export function drawFlap(g, F, W, cx, cy, theta, lift = 0) {
  const N = 16, sw = (W.hw * 2) / N, hingeX = cx - W.hw;
  const c = Math.cos(theta), sn = Math.sin(theta), back = c < 0;
  const img = back ? F.back : F.front;
  // 阴影（随抬起变大）
  const sh = clamp(sn + lift);
  if (sh > .01) {
    g.save(); g.globalAlpha = .28 * sh; g.fillStyle = '#300'; g.filter = `blur(${(4 + 14 * sh).toFixed(1)}px)`;
    const wx = W.hw * 2 * Math.abs(c);
    g.fillRect(back ? hingeX - wx + 10 * sh : hingeX + 10 * sh, cy - W.hh + 12 * sh, wx, W.hh * 2); g.restore();
  }
  // 先画进临时画布（只有窗扇像素），再按条带压暗，最后贴回
  const TW = Math.ceil(W.hw * 4 + 80), TH = Math.ceil(F.h * 1.4), tox = TW / 2, toy = TH / 2;
  if (!FT || FT.width !== TW || FT.height !== TH) FT = cv(TW, TH);
  const t = FT.getContext('2d'); t.setTransform(1, 0, 0, 1, 0, 0); t.clearRect(0, 0, TW, TH);
  for (let i = 0; i < N; i++) {
    const u0 = i * sw, u1 = (i + 1) * sw;
    const x0 = tox + u0 * c, x1 = tox + u1 * c;
    const hgt = (u0 + u1) / 2 / (W.hw * 2) * sn;
    const sy = 1 + .28 * hgt;
    const dark = back ? .8 + .2 * (1 - sn) : 1 - .38 * sn;
    const srcX = F.ox - W.hw + u0;
    const dx = Math.min(x0, x1), dw = Math.max(.6, Math.abs(x1 - x0) + .6);
    t.save(); t.translate(0, toy); t.scale(1, sy); t.translate(0, -toy - lift * 6 * hgt);
    t.globalCompositeOperation = 'source-over'; t.drawImage(img, srcX, 0, sw, F.h, dx, toy - F.oy + (cy - cy), dw, F.h);
    if (dark < .999) { t.globalCompositeOperation = 'source-atop'; t.fillStyle = `rgba(30,0,0,${(1 - dark).toFixed(3)})`; t.fillRect(dx, toy - F.oy, dw, F.h); }
    t.restore();
  }
  t.globalCompositeOperation = 'source-over';
  g.drawImage(FT, hingeX - tox, cy - toy);
}

// 铁剪刀（世界中的屏幕坐标）：刀尖朝前进方向，铆钉在剪点后方；open 0..1
export function drawScissors(g, x, y, tx, ty, open, lift = 0) {
  const a = Math.atan2(ty, tx), sp = .03 + .2 * open;
  g.save(); g.translate(x, y); g.rotate(a); g.scale(1.9, 1.9);
  // 投影
  g.save(); g.translate(10 + lift * 18, 12 + lift * 18); g.globalAlpha = .26; g.filter = 'blur(5px)'; scissorShape(g, sp, '#000', '#000'); g.restore();
  g.translate(-lift * 4, -lift * 6); g.scale(1 + lift * .08, 1 + lift * .08);
  scissorShape(g, sp, '#2a2a2d', '#6d6f75');
  g.restore();
}
function scissorShape(g, sp, body, hi) {
  const piv = -30;   // 铆钉在剪点后 30px（局部单位）
  for (const s of [-1, 1]) {
    g.save(); g.translate(piv, 0); g.rotate(s * sp);
    // 刀身：厚背、薄刃、尖头
    g.beginPath(); g.moveTo(-6, -s * 1); g.lineTo(62, -s * .4); g.quadraticCurveTo(80, s * .5, 86, s * 1.5);
    g.quadraticCurveTo(58, s * 9, 12, s * 12); g.lineTo(-6, s * 10); g.closePath();
    g.fillStyle = body; g.fill();
    g.strokeStyle = hi; g.lineWidth = 1.1; g.beginPath(); g.moveTo(0, s * 1.6); g.lineTo(70, s * 1.2); g.stroke();
    // 柄：向外撇开，末端一个椭圆环
    g.beginPath(); g.moveTo(-6, s * 5); g.quadraticCurveTo(-22, s * 11, -34, s * 19); g.lineWidth = 8; g.strokeStyle = body; g.lineCap = 'round'; g.stroke();
    g.beginPath(); g.ellipse(-50, s * 28, 18, 12, s * .55, 0, 7); g.lineWidth = 7; g.stroke();
    g.strokeStyle = hi; g.lineWidth = 1; g.beginPath(); g.ellipse(-50, s * 28, 18, 12, s * .55, Math.PI * 1.1, Math.PI * 1.6); g.stroke();
    g.restore();
  }
  g.beginPath(); g.arc(piv, 0, 3.6, 0, 7); g.fillStyle = hi; g.fill();
  g.beginPath(); g.arc(piv, 0, 1.6, 0, 7); g.fillStyle = body; g.fill();
}

// 碎纸片形状
export function scrapShape(g, size, seed) {
  const R = mulberry(seed); g.beginPath();
  const n = 5 + (R() * 3 | 0);
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, r = size * (.45 + .55 * R()) * (i % 2 ? .55 : 1); i ? g.lineTo(Math.cos(a) * r * 1.4, Math.sin(a) * r * .7) : g.moveTo(Math.cos(a) * r * 1.4, Math.sin(a) * r * .7); }
  g.closePath();
}
