// 第 4 关 · 中国水墨：宣纸 + 湿墨层（模糊淡墨、边缘积墨）+ 干墨层（飞白笔触）+ 唯一朱砂点
import { canvas, paperRice, stepF, W, H } from './media.js';
import { clamp, lerp, eo, ei, eio, vnoise, hash, mulberry, TAU } from '/core/lib.js';

const WET = canvas(), wt = WET.getContext('2d'), DRY = canvas(), dr = DRY.getContext('2d');
export const VERM = '#d63a2a';
let R = mulberry(3);
// 干笔：多根"鬃毛"平行细线，按噪声断开（飞白）
export function brush(g, pts, w = 18, a = .9, dryness = .35) {
  const n = Math.max(5, Math.round(w / 2.2));
  g.save(); g.lineCap = 'round'; g.strokeStyle = `rgba(22,20,24,${a})`;
  for (let k = 0; k < n; k++) {
    const o = (k / (n - 1) - .5) * w, seed = R() * 100;
    g.lineWidth = 1.6 + R() * 2.2; g.beginPath(); let on = false;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
      const taper = Math.sin(Math.PI * clamp((i + .5) / (pts.length - 1) * .9 + .05));
      const gap = vnoise(seed + i * .9) < dryness * (Math.abs(o) / w * 2 + .3);
      const px = x0 + nx * o * taper, py = y0 + ny * o * taper;
      if (gap) { on = false; continue; }
      if (!on) { g.moveTo(px, py); on = true; } g.lineTo(x1 + nx * o * taper, y1 + ny * o * taper);
    }
    g.stroke();
  }
  g.restore();
}
// 湿墨：模糊淡墨团 + 边缘积墨
export function wash(g, path, a = .25, blur = 10, edge = .18) {
  g.save(); g.filter = `blur(${blur}px)`; g.fillStyle = `rgba(30,28,34,${a})`; g.beginPath(); path(g); g.fill();
  if (edge) { g.lineWidth = 6; g.strokeStyle = `rgba(30,28,34,${edge})`; g.stroke(); }
  g.restore();
}
const arcPts = (cx, cy, r, a0, a1, n = 18, wob = 0) => [...Array(n + 1)].map((_, i) => { const a = lerp(a0, a1, i / n), rr = r * (1 + wob * (R() - .5)); return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]; });
const line = (x0, y0, x1, y1, n = 8, wob = 2) => [...Array(n + 1)].map((_, i) => [lerp(x0, x1, i / n) + (R() - .5) * wob, lerp(y0, y1, i / n) + (R() - .5) * wob]);

// 水墨小豆子：x,y 脚底；st {crouch, jump, reach 0..1 (右手伸向 tx,ty), tx, ty, dark}
export function heroInk(st) {
  const { x } = st, y = st.y - (st.jump || 0), cr = st.crouch || 0, s = st.s || 1;
  for (const g of [wt, dr]) { g.save(); g.translate(x, y); g.scale(s, s); }
  const hy = -360 + cr * 60;
  // 身体（淡墨袍）
  wash(wt, c => { c.moveTo(-70, hy + 100); c.quadraticCurveTo(-120, -40, -95, -20); c.lineTo(95, -20); c.quadraticCurveTo(120, -40, 70, hy + 100); c.closePath(); }, .32, 6, .3);
  brush(dr, [[-62, hy + 96], [-96, hy + 170], [-112, -110], [-100, -24]], 26, .9, .3);
  brush(dr, [[62, hy + 96], [98, hy + 170], [114, -110], [100, -24]], 26, .9, .3);
  brush(dr, line(-100, -24, 100, -24, 8, 4), 14, .7, .5);
  // 腿
  brush(dr, line(-36, -24, -40 - cr * 20, 0, 4), 14, .9, .2); brush(dr, line(36, -24, 40 + cr * 20, 0, 4), 14, .9, .2);
  // 手臂：右手可伸向开关
  const rx = lerp(130, (st.tx - x) / s, st.reach || 0), ry = lerp(hy + 220, (st.ty - y) / s, st.reach || 0);
  brush(dr, [[70, hy + 120], [lerp(120, rx * .6, st.reach || 0), lerp(hy + 170, ry * .7 + hy * .3, st.reach || 0)], [rx, ry]], 22, .92, .2);
  brush(dr, [[-70, hy + 120], [-120, hy + 190 - cr * 40], [-130, hy + 240 - cr * 60]], 22, .92, .2);
  for (const [px, py] of [[rx, ry], [-130, hy + 240 - cr * 60]]) wash(wt, c => c.arc(px, py, 20, 0, TAU), .55, 2, .3);
  // 头
  wash(wt, c => c.arc(0, hy, 92, 0, TAU), .08, 4, .12);
  brush(dr, arcPts(0, hy, 92, -.4, TAU - .6, 22, .04), 13, .95, .3);
  // 帽：墨线勾 + 朱砂（唯一颜色）
  wt.save(); wt.filter = 'blur(2px)'; wt.fillStyle = 'rgba(214,58,42,.75)'; wt.beginPath(); wt.moveTo(-96, hy - 22); wt.bezierCurveTo(-96, hy - 138, 96, hy - 138, 96, hy - 22); wt.closePath(); wt.fill(); wt.restore();
  brush(dr, [[-98, hy - 20], [-80, hy - 92], [0, hy - 118], [80, hy - 92], [98, hy - 20]], 11, .8, .35);
  brush(dr, line(-100, hy - 22, 100, hy - 22, 8, 3), 12, .9, .3);
  // 眼
  for (const sg of [-1, 1]) { dr.fillStyle = 'rgba(20,18,22,.95)'; dr.beginPath(); dr.ellipse(sg * 32, hy + 18, 10, st.squint ? 4 : 13, 0, 0, TAU); dr.fill(); }
  for (const g of [wt, dr]) g.restore();
  return { hx: x, hy: y + hy * s, s };
}
// 朱砂绒球（在墨晕之上再画一次，夜里也看得见）
export function pompom(out, x, y, r = 30) { out.save(); out.fillStyle = VERM; out.beginPath(); for (let i = 0; i <= 24; i++) { const a = i / 24 * TAU, rr = r * (1 + .1 * vnoise(i * 1.7)); out.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } out.fill(); out.restore(); }

// 墨晕：从 (x,y) 扩散，三圈色阶 + 毛边 + 放射飞白；k 0..1
export function flood(g, x, y, k, maxR = 2300, seed = 0) {
  if (k <= 0) return;
  const Rr = maxR * eo(k);
  const blob = (r, s) => c => { for (let i = 0; i <= 160; i++) { const a = i / 160 * TAU, rr = r * (1 + .07 * (vnoise(a * 5 + s) - .5) * 2 + .025 * Math.sin(a * 23 + s)); i ? c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.closePath(); };
  g.save();
  g.filter = 'blur(14px)'; g.fillStyle = 'rgba(28,26,34,.22)'; g.beginPath(); blob(Rr * 1.06, seed + 3)(g); g.fill();
  g.filter = 'blur(4px)'; g.fillStyle = 'rgba(24,22,30,.5)'; g.beginPath(); blob(Rr, seed)(g); g.fill();
  g.lineWidth = 18; g.strokeStyle = 'rgba(10,10,14,.45)'; g.stroke();          // 边缘积墨
  g.filter = 'none'; g.fillStyle = 'rgba(16,15,20,.28)'; g.beginPath(); blob(Rr * .82, seed + 7)(g); g.fill();
  g.restore();
  // 放射飞白
  R = mulberry(500 + seed);
  for (let i = 0; i < 18; i++) { const a = i / 18 * TAU + R() * .2, r0 = Rr * .3, r1 = Rr * (.85 + R() * .2); brush(g, line(x + Math.cos(a) * r0, y + Math.sin(a) * r0, x + Math.cos(a) * r1, y + Math.sin(a) * r1, 6, 4), 20, .25, .5); }
}

// 房间（亮灯状态）；可指定只画右半（BOSS）
export function room(g, { lampSwing = 0, switchOn = true, sw = [1500, 470], winX = 300, lampX = 1000, bed = true } = {}) {
  // 墙面淡墨（灯周围留白）
  g.save(); const gr = g.createRadialGradient(lampX, 330, 120, lampX, 330, 1100); gr.addColorStop(0, 'rgba(30,28,34,0)'); gr.addColorStop(1, 'rgba(30,28,34,.22)'); g.fillStyle = gr; g.fillRect(0, 0, W, H); g.restore();
  // 地板线
  brush(g, line(-20, 860, 1940, 850, 14, 5), 22, .8, .35);
  wash(g, c => c.rect(0, 860, W, 260), .12, 12, 0);
  // 窗 + 月
  wash(g, c => c.rect(winX, 170, 380, 330), .16, 8, .1);
  brush(g, line(winX, 170, winX + 380, 170, 6), 14, .85); brush(g, line(winX, 500, winX + 380, 500, 6), 14, .85);
  brush(g, line(winX, 170, winX, 500, 6), 14, .85); brush(g, line(winX + 380, 170, winX + 380, 500, 6), 14, .85); brush(g, line(winX + 190, 170, winX + 190, 500, 6), 9, .7);
  // 床
  if (bed) { wash(g, c => c.roundRect(80, 700, 620, 170, 40), .3, 6, .25);
  brush(g, [[90, 720], [300, 690], [520, 705], [700, 690]], 18, .8);
  wash(g, c => c.ellipse(220, 690, 110, 46, 0, 0, TAU), .12, 5, .2); }
  // 吊灯
  const lx = lampX + Math.sin(lampSwing) * 30;
  brush(g, line(lampX, -20, lx, 250, 6, 1), 6, .9, .1);
  wash(g, c => { c.moveTo(lx - 50, 250); c.lineTo(lx + 50, 250); c.lineTo(lx + 100, 340); c.lineTo(lx - 100, 340); c.closePath(); }, .5, 3, .4);
  brush(g, line(lx - 100, 340, lx + 100, 340, 6, 1), 10, .9);
  // 开关
  const [sx, sy] = sw;
  wash(g, c => c.roundRect(sx - 40, sy - 60, 80, 120, 10), .14, 3, .2);
  brush(g, [[sx - 40, sy - 60], [sx + 40, sy - 60], [sx + 40, sy + 60], [sx - 40, sy + 60], [sx - 40, sy - 60]], 9, .9, .15);
  brush(g, switchOn ? line(sx, sy + 4, sx, sy - 34, 3, 0) : line(sx, sy - 4, sx, sy + 34, 3, 0), 16, .95, 0);
}
export function moon(out, x, y, r, glow = 1) {
  out.save(); out.globalAlpha = .5 * glow; out.filter = 'blur(26px)'; out.fillStyle = '#f4ecd8'; out.beginPath(); out.arc(x, y, r * 1.6, 0, TAU); out.fill(); out.restore();
  out.save(); out.fillStyle = '#f7f0de'; out.beginPath(); out.arc(x, y, r, 0, TAU); out.fill();
  out.globalCompositeOperation = 'source-atop'; out.fillStyle = 'rgba(40,36,40,.9)'; out.beginPath(); out.arc(x + r * .45, y - r * .2, r * .9, 0, TAU); out.fill(); out.restore();
}
export function inkLayers() { return { wt, dr }; }
export function clearInk() { for (const g of [wt, dr]) { g.setTransform(1, 0, 0, 1, 0, 0); g.filter = 'none'; g.clearRect(0, 0, W, H); } }
export function printInk(out, paper = true) { if (paper) out.drawImage(paperRice(), 0, 0); out.save(); out.globalCompositeOperation = 'multiply'; out.drawImage(WET, 0, 0); out.drawImage(DRY, 0, 0); out.restore(); }

// 第 4 关时间线（fpb = 10）
export function game4(out, lf, fpb) {
  clearInk(); R = mulberry(10 + Math.floor(lf / 2));
  const sf = stepF(lf, fpb, 2), b = sf / fpb, tb = lf / fpb;   // 角色 12fps
  const slapB = 2, SW = [1530, 430];
  let crouch = 0, jump = 0, reach = 0, squint = false;
  if (b >= 1 && b < 1.6) crouch = eo((b - 1) / .6);
  else if (b >= 1.6 && b < slapB) { const u = (b - 1.6) / .4; crouch = 1 - eo(u * 2); jump = eo(u) * 150; reach = eo(u); }
  else if (b >= slapB) { const u = b - slapB; jump = 150 * (1 - ei(clamp(u / .9))); reach = 1 - eio(clamp((u - .3) / .5)); squint = u < .3; crouch = u > .9 ? .3 * (1 - clamp((u - .9) * 4)) : 0; }
  const k = tb >= slapB ? clamp(.16 + (tb - slapB) / 1.0) : 0;      // 墨晕：拍点那一帧就起墨（不等下一帧），一拍铺满
  const camY = jump * .35, punch = tb >= slapB ? 1 + .06 * Math.exp(-(tb - slapB) * 5) : 1;
  for (const g of [wt, dr]) { g.translate(960, 540); g.scale(punch, punch); g.translate(-960, -540 + camY); }
  room(wt, { sw: SW, lampSwing: tb >= slapB ? Math.sin((tb - slapB) * 9) * .5 * Math.exp(-(tb - slapB) * 2) : Math.sin(tb * 2) * .1, switchOn: tb < slapB });
  const h = heroInk({ x: 1290, y: 900, s: 1.22, crouch, jump, reach, tx: SW[0] - 6, ty: SW[1] - 10, squint });
  flood(dr, SW[0], SW[1], k, 2300, 1);
  out.save(); printInk(out); out.restore();
  if (tb >= slapB) { out.save(); out.globalCompositeOperation = 'multiply'; out.fillStyle = `rgba(70,64,78,${.55 * (1 - k * .5)})`; out.fillRect(0, 0, W, H); out.restore(); }   // 灯一灭整屋立刻暗一档
  // 夜里还看得见的：月亮、眼睛、朱砂点
  out.save(); out.translate(960, 540); out.scale(punch, punch); out.translate(-960, -540 + camY);
  const night = clamp(k * 1.6 - .3);
  if (night > 0) {
    moon(out, 395, 300, 62, night);
    out.globalAlpha = night; out.fillStyle = '#f7f0de';
    for (const sg of [-1, 1]) { out.beginPath(); out.ellipse(h.hx + sg * 32 * h.s, h.hy + 18 * h.s, 9 * h.s, (squint ? 4 : 12) * h.s, 0, 0, TAU); out.fill(); }
    out.globalAlpha = 1;
  }
  pompom(out, h.hx, h.hy - 122 * h.s, 26 * h.s);
  out.restore();
}
