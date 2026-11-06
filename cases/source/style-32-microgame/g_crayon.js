// 第 1 关 · 蜡笔绘本：蜡层 = 颜色 × 压力，最后与纸齿 destination-in（蜡只沾在纸的凸起处）
import { canvas, tooth, paperCrayon, stepF, W, H } from './media.js';
import { clamp, lerp, eo, ei, eio, back, mulberry, TAU } from '/core/lib.js';

const WAX = canvas(), wx = WAX.getContext('2d');
const CR = { red: '#d9342b', redD: '#a51f1a', blue: '#3c6fd1', sky: '#8fc3ec', green: '#4fae4a', greenD: '#2f7d35', brown: '#8a5a2b', yellow: '#f7c531', orange: '#f08a24', skin: '#f6c8a0', ink: '#2b2a6b', white: '#fffdf4' };

let R = mulberry(1);
const j = (a = 1) => (R() - .5) * 2 * a;
// 蜡笔填色：先薄涂一层，再用锯齿排线（排线会略出边）
export function cfill(c, path, col, bb, { ang = .6, gap = 13, w = 12, a = .9, base = .5, over = 6 } = {}) {
  c.save(); c.beginPath(); path(c); c.globalAlpha = base; c.fillStyle = col; c.fill();
  c.clip(); c.globalAlpha = a; c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round';
  const [x0, y0, x1, y1] = bb, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, L = Math.hypot(x1 - x0, y1 - y0) / 2 + over;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  c.beginPath();
  for (let k = -L; k <= L; k += gap) {
    const px = cx - sa * k, py = cy + ca * k;
    c.moveTo(px - ca * L + j(3), py - sa * L + j(3));
    c.lineTo(px + ca * L + j(3), py + sa * L + j(3));
  }
  c.stroke(); c.restore();
}
// 蜡笔描边：三遍抖动
export function cline(c, path, col = CR.ink, w = 7) {
  c.save(); c.strokeStyle = col; c.lineCap = 'round'; c.lineJoin = 'round';
  for (let p = 0; p < 3; p++) { c.save(); c.translate(j(2.2), j(2.2)); c.globalAlpha = .55; c.lineWidth = w * (1 - p * .2); c.beginPath(); path(c); c.stroke(); c.restore(); }
  c.restore();
}
const C = (x, y, r) => c => c.arc(x, y, r, 0, TAU);
const E = (x, y, rx, ry) => c => c.ellipse(x, y, rx, ry, 0, 0, TAU);

// 小豆子（蜡笔版）。p = {x, y(脚底), run 0..1 跑步相位, lean, crouch, jump, arms:'basket'|'up'|'side', eyes:'dot'|'happy'|'up', basketApple}
export function heroCrayon(c, p) {
  const { x } = p, y = p.y - (p.jump || 0), cr = p.crouch || 0, s = p.s || 1;
  c.save(); c.translate(x, y); c.scale(s, s); c.rotate(p.lean || 0);
  const leg = p.run ? Math.sin(p.run * TAU) : 0;
  // 腿 + 鞋
  for (const [sg, ph] of [[-1, leg], [1, -leg]]) {
    const lx = sg * 34 + ph * 26, ly = 0;
    cline(c, cc => { cc.moveTo(sg * 30, -60 + cr * 10); cc.lineTo(lx, ly - 18); }, CR.ink, 16);
    cfill(c, E(lx + 10 * sg, ly - 10, 34, 16), CR.brown, [lx - 40, ly - 30, lx + 50, ly + 10], { gap: 10, w: 9 });
    cline(c, E(lx + 10 * sg, ly - 10, 34, 16));
  }
  // 身体（蓝色背带裤）
  const by = -60 + cr * 14, bh = 190 - cr * 20;
  const body = cc => cc.roundRect(-78, by - bh, 156, bh, 46);
  cfill(c, body, CR.blue, [-80, by - bh, 80, by], { ang: -.5 });
  cline(c, body);
  // 手臂
  const arms = p.arms || 'side', ay = by - bh + 40, hy0 = by - bh - 82, bky = hy0 - 200;
  const hands = arms === 'up' ? [[-120, ay - 150], [120, ay - 150]] : arms === 'basket' ? [[-104, bky + 30], [104, bky + 30]] : [[-120, ay + 70], [120, ay + 70]];
  for (const [hx, hy] of hands) { const sg = Math.sign(hx);
    cline(c, cc => { cc.moveTo(sg * 66, ay); cc.quadraticCurveTo(sg * 150, (ay + hy) / 2, hx, hy); }, CR.ink, 14);
    cfill(c, C(hx, hy, 20), CR.skin, [hx - 22, hy - 22, hx + 22, hy + 22], { gap: 8, w: 8 }); cline(c, C(hx, hy, 20), CR.ink, 5);
  }
  // 头
  const hy = by - bh - 82;
  cfill(c, C(0, hy, 92), CR.skin, [-94, hy - 94, 94, hy + 94], { ang: 1.1, a: .7 });
  cline(c, C(0, hy, 92));
  // 红帽 + 绒球（跨画材标记）
  const cap = cc => { cc.moveTo(-96, hy - 18); cc.bezierCurveTo(-96, hy - 140, 96, hy - 140, 96, hy - 18); cc.closePath(); };
  cfill(c, cap, CR.red, [-100, hy - 130, 100, hy - 10], { ang: .2, gap: 11 });
  cline(c, cap);
  cfill(c, cc => cc.roundRect(-100, hy - 36, 200, 34, 14), CR.white, [-100, hy - 36, 100, hy], { gap: 9, w: 9, a: .7, base: .8 });
  cline(c, cc => cc.roundRect(-100, hy - 36, 200, 34, 14), CR.ink, 5);
  cfill(c, C(0, hy - 128, 26), CR.red, [-28, hy - 156, 28, hy - 100], { gap: 8, w: 9 }); cline(c, C(0, hy - 128, 26), CR.ink, 5);
  // 脸
  const e = p.eyes || 'dot', ey = hy + 18;
  c.save(); c.fillStyle = CR.ink; c.strokeStyle = CR.ink; c.lineWidth = 8; c.lineCap = 'round';
  for (const sg of [-1, 1]) {
    if (e === 'happy') { c.beginPath(); c.arc(sg * 34, ey + 8, 14, Math.PI + .4, -.4); c.stroke(); }
    else { const oy = e === 'up' ? -10 : 0; c.beginPath(); c.arc(sg * 34 + j(1), ey + oy + j(1), 11, 0, TAU); c.fill(); }
  }
  c.beginPath(); if (p.mouth === 'o') { c.arc(0, ey + 46, 13, 0, TAU); } else c.arc(0, ey + 30, 26, .3, Math.PI - .3); c.stroke();
  c.fillStyle = 'rgba(240,120,110,.5)'; c.beginPath(); c.arc(-62, ey + 30, 14, 0, TAU); c.arc(62, ey + 30, 14, 0, TAU); c.fill();
  c.restore();
  // 篮子
  if (arms === 'basket') {
    const q = bky, bk = cc => { cc.moveTo(-110, q - 6); cc.lineTo(110, q - 6); cc.lineTo(80, q + 66); cc.lineTo(-80, q + 66); cc.closePath(); };
    if (p.basketApple) { apple(c, 0, q - 20 - (p.pop || 0), 1.05, (p.pop || 0) * .01); }
    cfill(c, bk, CR.orange, [-110, q - 6, 110, q + 66], { ang: .8, gap: 12 });
    cfill(c, bk, CR.brown, [-110, q - 6, 110, q + 66], { ang: -.8, gap: 18, w: 7, base: 0 });
    cline(c, bk);
  }
  c.restore();
}
export function apple(c, x, y, s = 1, rot = 0) {
  c.save(); c.translate(x, y); c.rotate(rot); c.scale(s, s);
  cline(c, cc => { cc.moveTo(0, -30); cc.lineTo(4, -52); }, CR.brown, 8);
  cfill(c, cc => cc.ellipse(16, -48, 18, 9, -.5, 0, TAU), CR.green, [-2, -60, 36, -36], { gap: 7, w: 7 });
  const body = cc => { cc.moveTo(0, -24); cc.bezierCurveTo(30, -44, 52, -10, 34, 20); cc.bezierCurveTo(22, 40, 6, 36, 0, 30); cc.bezierCurveTo(-6, 36, -22, 40, -34, 20); cc.bezierCurveTo(-52, -10, -30, -44, 0, -24); };
  cfill(c, body, CR.red, [-52, -44, 52, 40], { gap: 9, w: 9, base: .7 });
  cline(c, body, CR.ink, 6);
  c.fillStyle = 'rgba(255,253,244,.8)'; c.beginPath(); c.ellipse(-16, -10, 7, 12, .4, 0, TAU); c.fill();
  c.restore();
}

// 场景（可单独用于 BOSS 左半）：{t, shake, appleState:{x,y,rot,on}, hero, sunY, half}
export function sceneCrayon(out, st) {
  R = mulberry(1000 + (st.boil | 0));
  const c = wx; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
  c.save(); if (st.cam) c.translate(st.cam, 0);
  // 天空（浅蓝长排线，绕开太阳）
  cfill(c, cc => cc.rect(-200, -50, 2400, 900), CR.sky, [-200, -50, 2200, 850], { ang: -.35, gap: 22, w: 14, a: .55, base: .18, over: 0 });
  // 太阳
  const sy = st.sunY ?? 190;
  c.save(); c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.arc(1600, sy, 150, 0, TAU); c.fill(); c.restore();
  cfill(c, C(1600, sy, 110), CR.yellow, [1490, sy - 110, 1710, sy + 110], { gap: 11 });
  cline(c, C(1600, sy, 110), CR.orange, 8);
  for (let i = 0; i < 10; i++) { const a = i * TAU / 10 + (st.t || 0) * .3; cline(c, cc => { cc.moveTo(1600 + Math.cos(a) * 135, sy + Math.sin(a) * 135); cc.lineTo(1600 + Math.cos(a) * 185, sy + Math.sin(a) * 185); }, CR.orange, 10); }
  // 地面（山坡）
  const hill = cc => { cc.moveTo(-200, 860); cc.bezierCurveTo(400, 780, 1100, 820, 2200, 790); cc.lineTo(2200, 1200); cc.lineTo(-200, 1200); cc.closePath(); };
  cfill(c, hill, CR.green, [-200, 780, 2200, 1200], { ang: -.15, gap: 14 });
  cline(c, cc => { cc.moveTo(-200, 860); cc.bezierCurveTo(400, 780, 1100, 820, 2200, 790); }, CR.greenD, 8);
  for (let i = 0; i < 14; i++) { const gx = 80 + i * 140 + (i % 3) * 20, gy = 900 + (i % 4) * 40; cline(c, cc => { cc.moveTo(gx, gy); cc.lineTo(gx - 8, gy - 24); cc.moveTo(gx + 10, gy); cc.lineTo(gx + 14, gy - 28); }, CR.greenD, 5); }
  // 苹果树
  const sh = st.shake || 0, tx = 680;
  const trunk = cc => { cc.moveTo(tx - 50, 850); cc.lineTo(tx - 30, 430); cc.lineTo(tx + 30, 430); cc.lineTo(tx + 55, 850); cc.closePath(); };
  cfill(c, trunk, CR.brown, [tx - 60, 420, tx + 60, 850], { ang: 1.4, gap: 11 }); cline(c, trunk);
  c.save(); c.translate(tx, 430); c.rotate(Math.sin(sh * 30) * .04 * sh); c.translate(-tx, -430);
  const can = cc => { for (const [ox, oy, r] of [[0, -110, 200], [-170, -20, 150], [170, -20, 160], [-90, 70, 140], [100, 70, 150]]) { cc.moveTo(tx + ox + r, 330 + oy); cc.arc(tx + ox, 330 + oy, r, 0, TAU); } };
  cfill(c, can, CR.green, [tx - 330, 60, tx + 340, 560], { ang: .9, gap: 13 });
  cfill(c, cc => cc.arc(tx + 60, 420, 200, 0, TAU), CR.greenD, [tx - 140, 220, tx + 260, 620], { ang: -.7, gap: 16, w: 9, base: 0, a: .5 });
  cline(c, can, CR.greenD, 8);
  for (const [ax, ay] of [[tx - 160, 260], [tx + 40, 180], [tx - 60, 400], [tx + 180, 320]]) apple(c, ax, ay, .8);
  c.restore();
  const A = st.appleState; if (A && A.on) apple(c, A.x, A.y, A.s || 1.05, A.rot || 0);
  if (st.hero) heroCrayon(c, st.hero);
  if (st.extra) st.extra(c);
  c.restore();
  // 纸齿：蜡只留在凸起处
  c.save(); c.globalCompositeOperation = 'destination-in'; c.drawImage(tooth(), 0, 0); c.restore();
  out.drawImage(paperCrayon(), 0, 0);
  out.drawImage(WAX, 0, 0);
}

// 第 1 关时间线（lf = 段内帧，fpb = 11）
export function game1(out, lf, fpb) {
  const sf = stepF(lf, fpb, 3), b = sf / fpb, bt = lf / fpb;       // 角色 8fps；镜头逐帧
  const drop = 2, catchB = 4, BKY = 905 - 60 - 190 - 82 - 200 - 20;   // 篮中苹果的高度
  // 苹果
  let A = { on: true, x: 900, y: 175, rot: 0, s: 1.05 };
  if (b < drop) A.rot = b >= 1 ? Math.sin((b - 1) * 26) * .3 * (b - 1) : 0;
  else if (b < catchB) { const u = (b - drop) / (catchB - drop); A.y = 175 + (BKY - 175) * u * u; A.rot = u * 1.2; }
  // 小豆子
  const runA = 2, runB = 3.5;
  const u = clamp((b - runA) / (runB - runA));
  let hx = lerp(1420, 900, eo(u)), run = b >= runA && b < runB ? (sf - runA * fpb) / 3 * .5 + .25 : 0, lean = b >= runA && b < runB ? -.12 : (b >= runB && b < catchB ? .08 * (1 - (b - runB) / .5) : 0);
  let crouch = b >= 1 && b < 2 ? .6 * Math.sin(Math.PI * (b - 1)) : 0, jump = 0, eyes = b >= 1 && b < catchB ? 'up' : 'dot', mouth = b >= 1 && b < catchB ? 'o' : 'smile';
  let arms = b < 1 ? 'side' : 'basket';
  if (b >= catchB) { const k = b - catchB; crouch = k < .35 ? .9 * (1 - k / .35) : 0; eyes = 'happy'; mouth = 'smile';
    if (k >= 1) { jump = Math.sin(Math.PI * clamp(k - 1)) * 120; } }
  const basketApple = b >= catchB;
  if (basketApple) A.on = false;
  const cam = -(hx - 1100) * .18;            // 跟拍横移
  sceneCrayon(out, { t: lf / 24, boil: Math.floor(lf / 2), cam, appleState: A, sunY: 220 - lf * .6, shake: b >= 1 && b < drop ? 1 : 0,
    hero: { x: hx, y: 905, run, lean, crouch, jump, eyes, mouth, arms, basketApple } });
}
