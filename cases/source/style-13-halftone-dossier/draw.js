// 半调案卷：通用绘制工具（Canvas 2D，全部确定性）
import { clamp, lerp, seg, eo, ei, mulberry, hash, TAU } from '/core/lib.js';
export { clamp, lerp, seg, eo, ei, mulberry, hash, TAU };

export const W = 1920, H = 1080;
// 纸底 + 一种深墨 + 四种专色；teal 只属于喜鹊
export const C = {
  paper: '#efe4cc', card: '#f9f1de', white: '#fbf7ec',
  navy: '#1d2a4a', cobalt: '#2f5fb3', yellow: '#f2b631', red: '#d6402f',
  teal: '#2a8c86',
};
export const F = {
  serif: '"SerifSC"', sans: '"SansSC"', bagel: '"Bagel"', mono: '"Mono"', hand: '"Kuaile"',
};
export const font = (size, fam, w = 900) => `${w} ${size}px ${fam}`;

// —— 缓动 ——
export const back = (t, s = 1.9) => { t = clamp(t) - 1; return 1 + t * t * ((s + 1) * t + s); };
export const eio = t => { t = clamp(t); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
export const ss = t => { t = clamp(t); return t * t * (3 - 2 * t); };
// 撞击后的阻尼回弹：a = 撞击后经过的秒数
export const wob = (a, k = .22, f = 24, d = 9) => a < 0 ? 0 : k * Math.exp(-a * d) * Math.cos(a * f);
export const rng = s => mulberry(s | 0);

// —— 文字登记（readcheck 用）：记录屏幕坐标下的文字框 ——
export const TXT = [];
export function regText(ctx, id, text, x0, y0, x1, y1) {
  const m = ctx.getTransform();
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
  TXT.push({ id, text, x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) });
}

// —— 半调：旋转网格上的圆点，一条 path；半径 = 密度 × 步长 × k ——
export function halftone(ctx, { x0 = 0, y0 = 0, w = W, h = H, step = 22, angle = 15, color, f, k = .68, mul = false, max = 1.12 }) {
  const a = angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const cx = x0 + w / 2, cy = y0 + h / 2, n = Math.ceil(Math.hypot(w, h) / step / 2) + 1;
  ctx.beginPath();
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const u = i * step, v = j * step, x = cx + u * ca - v * sa, y = cy + u * sa + v * ca;
    if (x < x0 - step || x > x0 + w + step || y < y0 - step || y > y0 + h + step) continue;
    const s = Math.min(max, f(x, y)); if (s < .05) continue;
    const r = s * step * k; ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU);
  }
  const op = ctx.globalCompositeOperation; if (mul) ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = color; ctx.fill(); ctx.globalCompositeOperation = op;
}
export const radial = (cx, cy, R, pw = 1.2, g = 1) => (x, y) => g * Math.pow(clamp(1 - Math.hypot(x - cx, y - cy) / R), pw);
export const ramp = (y0, y1, a = 0, b = 1, pw = 1) => (x, y) => lerp(a, b, Math.pow(clamp((y - y0) / (y1 - y0)), pw));
export const edgeF = (cx, cy, R, pw = 1.6, g = 1.3) => (x, y) => g * Math.pow(clamp(Math.hypot((x - cx) * .78, y - cy) / R - .35), pw);

// —— 线条抖动（只用于角色与道具）：点列按 10 fps 换种子 ——
export let BOIL = 0;
export const setBoil = t => { BOIL = Math.floor(t * 10 + 1e-6); };
export function boil(pts, amp = 2.2, salt = 0) {
  return pts.map(([x, y], i) => [x + (hash(i * 7.13 + BOIL * 31.7 + salt) - .5) * 2 * amp, y + (hash(i * 3.71 + BOIL * 17.3 + salt + 9) - .5) * 2 * amp]);
}
// Catmull-Rom → 贝塞尔的平滑闭合/开放路径
export function smooth(ctx, pts, closed = true, ten = .5) {
  const n = pts.length; if (n < 2) return;
  const P = i => closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)];
  ctx.moveTo(pts[0][0], pts[0][1]);
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) * ten / 3, p1[1] + (p2[1] - p0[1]) * ten / 3, p2[0] - (p3[0] - p1[0]) * ten / 3, p2[1] - (p3[1] - p1[1]) * ten / 3, p2[0], p2[1]);
  }
  if (closed) ctx.closePath();
}
export function poly(ctx, pts, closed = true) { ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); if (closed) ctx.closePath(); }
export const ell = (cx, cy, rx, ry, n = 14, rot = 0, ph = 0) => Array.from({ length: n }, (_, i) => {
  const a = ph + i / n * TAU, x = Math.cos(a) * rx, y = Math.sin(a) * ry, c = Math.cos(rot), s = Math.sin(rot);
  return [cx + x * c - y * s, cy + x * s + y * c];
});
export const rectPts = (x, y, w, h, n = 3) => {   // 带中间点的矩形（让抖动沿边分布）
  const out = [], cs = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  for (let k = 0; k < 4; k++) { const a = cs[k], b = cs[(k + 1) % 4]; for (let i = 0; i < n; i++) out.push([lerp(a[0], b[0], i / n), lerp(a[1], b[1], i / n)]); }
  return out;
};
// 平涂 + 粗墨线的形状
export function ink(ctx, pts, { fill, stroke = C.navy, lw = 7, amp = 2.2, salt = 0, curve = true, closed = true, clipFn = null } = {}) {
  const P = amp ? boil(pts, amp, salt) : pts;
  ctx.beginPath(); curve ? smooth(ctx, P, closed) : poly(ctx, P, closed);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (clipFn) { ctx.save(); ctx.clip(); clipFn(); ctx.restore(); ctx.beginPath(); curve ? smooth(ctx, P, closed) : poly(ctx, P, closed); }
  if (stroke && lw) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(); }
}

// —— 带错版阴影的文字 ——
export function shadowText(ctx, str, x, y, size, fam, { color = C.navy, shadow = C.cobalt, dx = 8, dy = 8, align = 'left', w = 900, stroke = null, sw = 0 } = {}) {
  ctx.font = font(size, fam, w); ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  if (shadow) { const op = ctx.globalCompositeOperation; ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = shadow; ctx.fillText(str, x + dx, y + dy); ctx.globalCompositeOperation = op; }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.lineJoin = 'round'; ctx.strokeText(str, x, y); }
  ctx.fillStyle = color; ctx.fillText(str, x, y);
}
// 逐字弹入：第 i 个字在 tLand + i·stagger 落定，之前 0.18 s 从上方落下，落定后体积守恒的挤压回弹
export function popText(ctx, id, str, x, y, size, fam, t, tLand, { stagger = 1 / 15, drop = 80, color = C.navy, shadow = C.cobalt, dx = 8, dy = 8, w = 900, stroke = null, sw = 0, colors = null } = {}) {
  if (t < tLand - .18) return null;
  ctx.font = font(size, fam, w); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const chars = [...str]; let pen = x; const total = ctx.measureText(str).width;
  chars.forEach((ch, i) => {
    const adv = ctx.measureText(ch).width, tl = tLand + i * stagger, a = t - tl;
    if (a >= -.18) {
      const fall = a < 0 ? Math.pow(-a / .18, 2) * drop : 0;
      const sq = 1 - wob(a, .26, 26, 8);
      ctx.save(); ctx.translate(pen + adv / 2, y - fall); ctx.scale(1 / sq, sq);
      shadowText(ctx, ch, -adv / 2, 0, size, fam, { color: colors ? colors[i] || color : color, shadow, dx, dy, w, stroke, sw });
      ctx.restore();
    }
    pen += adv;
  });
  regText(ctx, id, str, x, y - size * .9, x + total, y + size * .15);
  return total;
}

// —— 说明条：深墨圆角药丸 + 钴蓝偏移阴影，纸色字，关键词黄色 ——
export function captionBar(ctx, id, parts, cx, cy, size, t, tHit) {
  if (t < tHit - .2) return;
  ctx.font = font(size, F.sans); const ws = parts.map(([s]) => ctx.measureText(s).width), tw = ws.reduce((a, b) => a + b, 0);
  const padX = 36, h = size * 1.75, p = seg(t, tHit - .2, tHit), a = t - tHit;
  const s = (a < 0 ? lerp(.55, 1, eo(p)) : 1 + wob(a, .07, 22, 8)), rot = a < 0 ? -3 * (1 - p) : -.6;
  ctx.save(); ctx.translate(cx, cy + (a < 0 ? 50 * (1 - eo(p)) : 0)); ctx.rotate(rot * Math.PI / 180); ctx.scale(s, s);
  const rr = (x, y, w, hh, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, hh, r); };
  ctx.globalCompositeOperation = 'multiply'; rr(-tw / 2 - padX + 9, -h / 2 + 9, tw + padX * 2, h, 18); ctx.fillStyle = C.cobalt; ctx.fill();
  ctx.globalCompositeOperation = 'source-over'; rr(-tw / 2 - padX, -h / 2, tw + padX * 2, h, 18); ctx.fillStyle = C.navy; ctx.fill();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; let pen = -tw / 2;
  parts.forEach(([str, col], i) => { ctx.fillStyle = col || C.paper; ctx.fillText(str, pen, size * .04); pen += ws[i]; });
  regText(ctx, id, parts.map(p => p[0]).join(''), -tw / 2, -size * .6, tw / 2, size * .6);
  ctx.restore();
}

// —— 印章：双圆角框 + 粗黑字，经过墨粒与位移，边缘粗糙、墨色斑驳（只建一次） ——
export function buildStamp(str, size, color = C.red, seed = 5) {
  const cv = document.createElement('canvas'), g = cv.getContext('2d');
  g.font = font(size, F.sans); const tw = g.measureText(str).width;
  const padX = size * .32, padY = size * .2, bw = size * .075, w = Math.ceil(tw + padX * 2 + bw * 2 + 20), h = Math.ceil(size * 1.1 + padY * 2 + bw * 2 + 20);
  cv.width = w; cv.height = h;
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = bw;
  g.beginPath(); g.roundRect(10 + bw / 2, 10 + bw / 2, w - 20 - bw, h - 20 - bw, size * .14); g.stroke();
  g.lineWidth = bw * .38; g.beginPath(); g.roundRect(10 + bw * 2.1, 10 + bw * 2.1, w - 20 - bw * 4.2, h - 20 - bw * 4.2, size * .07); g.stroke();
  g.font = font(size, F.sans); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(str, w / 2, h / 2 + size * .04);
  const src = g.getImageData(0, 0, w, h), out = g.createImageData(w, h), r = rng(seed);
  // 低频位移场 + 细墨粒
  const gw = 24, gx = Math.ceil(w / gw) + 2, gy = Math.ceil(h / gw) + 2, DX = [], DY = [];
  for (let i = 0; i < gx * gy; i++) { DX.push((r() - .5) * 7); DY.push((r() - .5) * 7); }
  const samp = (A, x, y) => { const i = Math.floor(x / gw), j = Math.floor(y / gw), fx = x / gw - i, fy = y / gw - j, k = j * gx + i; return lerp(lerp(A[k], A[k + 1], fx), lerp(A[k + gx], A[k + gx + 1], fx), fy); };
  const big = []; for (let i = 0; i < gx * gy; i++) big.push(r());
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.round(x + samp(DX, x, y)), sy = Math.round(y + samp(DY, x, y));
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    const si = (sy * w + sx) * 4, a = src.data[si + 3]; if (!a) continue;
    const mott = samp(big, x * 2.3 % (w - gw), y * 2.3 % (h - gw)), grain = r();
    let k = grain < .07 ? 0 : grain < .16 ? .45 : 1; k *= mott < .22 ? .55 : 1;
    const o = (y * w + x) * 4; out.data[o] = src.data[si]; out.data[o + 1] = src.data[si + 1]; out.data[o + 2] = src.data[si + 2]; out.data[o + 3] = a * k;
  }
  g.clearRect(0, 0, w, h); g.putImageData(out, 0, 0);
  return { cv, w, h, tw };
}
// 砸印：撞击前 0.09 s 从 2.6× 落到 1×（ease-in），之后 5% 阻尼回弹；93% 不透明
export function drawStamp(ctx, S, id, text, x, y, rot, t, tHit, scale = 1) {
  if (t < tHit - .09) return;
  const p = seg(t, tHit - .09, tHit), a = Math.max(0, t - tHit);
  const s = lerp(2.6, 1, ei(p)) * (1 + .05 * Math.sin(a * 30) * Math.exp(-a * 9)) * scale;
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot * Math.PI / 180); ctx.scale(s, s);
  ctx.globalAlpha = p < 1 ? .35 + .58 * p : .93; ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(S.cv, -S.w / 2, -S.h / 2); ctx.restore();
  if (a > 0) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot * Math.PI / 180); ctx.scale(scale, scale); regText(ctx, id, text, -S.tw / 2, -S.h * .3, S.tw / 2, S.h * .3); ctx.restore(); }
}

// —— 网点擦除：80 px 网格，0.44 s，对角延迟；切点时刻所有圆点都完全覆盖 ——
export function dotWipe(ctx, t, cut, color) {
  const u = (t - cut + .22) / .44; if (u <= 0 || u >= 1) return false;
  ctx.beginPath();
  for (let y = 0; y <= H + 80; y += 80) for (let x = 0; x <= W + 80; x += 80) {
    // 斜向延迟 0.44、单点寿命 0.56：只有切点那一帧 100% 覆盖（前后一帧约 96%，再往外 81%/55%），长满立刻缩回
    const d = (x / W * .6 + y / H * .4) * .44, p = clamp((u - d) / .56);
    const r = 66 * clamp(Math.sin(p * Math.PI) * 2.1); if (r < .5) continue;
    ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU);
  }
  ctx.fillStyle = color; ctx.fill(); return true;
}

// —— 纸层（只建一次，正片叠底盖在一切之上）——
export function buildPaper(cv) {
  const ctx = cv.getContext('2d'), r = rng(3);
  const small = document.createElement('canvas'); small.width = 96; small.height = 54;
  const sg = small.getContext('2d'), sim = sg.createImageData(96, 54);
  for (let i = 0; i < sim.data.length; i += 4) { const v = 241 + r() * 14; sim.data[i] = v; sim.data[i + 1] = v - 1; sim.data[i + 2] = v - 4; sim.data[i + 3] = 255; }
  sg.putImageData(sim, 0, 0); ctx.imageSmoothingEnabled = true; ctx.drawImage(small, 0, 0, W, H);
  const base = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < base.data.length; i += 4) {
    const n = (r() - .5) * 24;
    base.data[i] = clamp(base.data[i] + n + 1, 0, 255); base.data[i + 1] = clamp(base.data[i + 1] + n, 0, 255); base.data[i + 2] = clamp(base.data[i + 2] + n - 5, 0, 255);
  }
  ctx.putImageData(base, 0, 0);
  const gr = ctx.createRadialGradient(960, 540, 420, 960, 540, 1180);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(120,96,70,0.34)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(130,110,90,0.16)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(958, 0); ctx.lineTo(963, H); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(962, 0); ctx.lineTo(967, H); ctx.stroke();
}
// 印刷灰尘：每 2 帧换一次种子
export function drawGrain(cv, frame, dark) {
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, W, H);
  const r = rng(1000 + Math.floor(frame / 2));
  ctx.fillStyle = dark ? 'rgba(239,228,204,0.30)' : 'rgba(255,249,236,0.75)';
  ctx.beginPath(); for (let i = 0; i < 480; i++) { const x = r() * W, y = r() * H, s = .6 + r() * 1.7; ctx.moveTo(x + s, y); ctx.arc(x, y, s, 0, TAU); } ctx.fill();
  ctx.fillStyle = 'rgba(29,42,74,0.28)';
  ctx.beginPath(); for (let i = 0; i < 90; i++) { const x = r() * W, y = r() * H, s = .6 + r() * 1.3; ctx.moveTo(x + s, y); ctx.arc(x, y, s, 0, TAU); } ctx.fill();
}
// 墨粒蒙版（吃掉一点角色/道具的平涂）
export function buildGrainMask() {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512; const g = cv.getContext('2d'), r = rng(77);
  g.fillStyle = '#000'; g.beginPath();
  for (let i = 0; i < 2600; i++) { const x = r() * 512, y = r() * 512, s = .5 + r() * 1.4; g.moveTo(x + s, y); g.arc(x, y, s, 0, TAU); }
  g.fill(); return cv;
}

// —— 半调填充的字形精灵：平涂 + 裁在字形里的深墨半调，另附错版阴影剪影 ——
export function glyphSprite(str, size, fam, { fill, dot = C.navy, step = 22, angle = 45, f = () => .5, k = .68, res = 1, w = 400, shadow = C.cobalt } = {}) {
  const mk = () => document.createElement('canvas');
  const cv = mk(), g = cv.getContext('2d'); g.font = `${w} ${size}px ${fam}`;
  const m = g.measureText(str), asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent, wid = m.width, pad = 24;
  const ww = wid + pad * 2, hh = asc + desc + pad * 2;
  cv.width = Math.ceil(ww * res); cv.height = Math.ceil(hh * res);
  g.scale(res, res); g.font = `${w} ${size}px ${fam}`; g.textBaseline = 'alphabetic'; g.fillStyle = fill; g.fillText(str, pad, pad + asc);
  g.globalCompositeOperation = 'source-atop'; halftone(g, { x0: 0, y0: 0, w: ww, h: hh, step, angle, color: dot, f, k });
  const sh = mk(); sh.width = cv.width; sh.height = cv.height; const sg = sh.getContext('2d');
  sg.drawImage(cv, 0, 0); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = shadow; sg.fillRect(0, 0, sh.width, sh.height);
  return { cv, sh, w: ww, h: hh, ax: pad, ay: pad + asc, res, wid, asc, desc };
}
// 以字形的基线左端为锚点画精灵（cx = 是否以字宽中心为锚）
export function drawGlyph(ctx, S, x, y, s = 1, { dx = 10, dy = 10, center = false } = {}) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); if (center) ctx.translate(-S.wid / 2, 0);
  const op = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(S.sh, -S.ax + dx, -S.ay + dy, S.w, S.h);
  ctx.globalCompositeOperation = op; ctx.drawImage(S.cv, -S.ax, -S.ay, S.w, S.h); ctx.restore();
}
// 被撕下的第 13 页：夹持点（右上角）在精灵局部 (0,0)
export function buildPage(res = 3.5) {
  const cv = document.createElement('canvas'), g = cv.getContext('2d');
  const ox = 180, oy = 16, ww = 200, hh = 290; cv.width = ww * res; cv.height = hh * res; g.scale(res, res); g.translate(ox, oy);
  const pts = [[-6, -6], [-150, 2], [-158, 70], [-150, 130], [-161, 196], [-148, 246], [-60, 254], [-42, 240], [-24, 256], [6, 246], [10, 150], [2, 70]];
  g.beginPath(); poly(g, pts); g.fillStyle = C.white; g.fill();
  g.save(); g.clip();
  halftone(g, { x0: -170, y0: -10, w: 190, h: 280, step: 13, angle: 45, color: C.cobalt, k: .62, f: (x, y) => .14 + .55 * clamp((y - 110) / 150) });
  g.fillStyle = C.navy; for (let i = 0; i < 4; i++) g.fillRect(-136, 22 + i * 15, 118 - (i % 2) * 34, 5);
  for (let i = 0; i < 3; i++) g.fillRect(-136, 218 + i * 11, 106 - i * 24, 4);
  const S = glyphSprite('13', 124, F.bagel, { fill: C.yellow, step: 11, angle: 45, f: (x, y) => .25 + .55 * clamp(y / 150), res });
  drawGlyph(g, S, -72, 196, 1, { dx: 5, dy: 5, center: true });
  g.restore();
  g.beginPath(); poly(g, pts); g.strokeStyle = C.navy; g.lineWidth = 5; g.lineJoin = 'round'; g.stroke();
  return { cv, ox, oy, w: ww, h: hh, res, numBox: [-140, 100, -4, 200] };
}
export function drawPage(ctx, P, x, y, rot, s = 1) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot * Math.PI / 180); ctx.scale(s, s);
  ctx.drawImage(P.cv, -P.ox, -P.oy, P.w, P.h); ctx.restore();
}
