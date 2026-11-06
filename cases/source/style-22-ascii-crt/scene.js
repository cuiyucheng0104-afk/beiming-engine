// 世界与"底片"：海、鲸、水花、水柱都先以灰度画进与字格严格对齐的离屏底片（每格 3×3 采样），再逐格挑字。
// R = 琥珀亮度，G = 冰青亮度。世界单位：字格 40px 时的屏幕像素（z = s/40）。
import { b, CUE } from './timeline.js';
export const W = 1920, MAIN_H = 930, CY = 465;     // 主画区（LOG 条以上）
export const SS = 3;                                // 每格采样
export const S0 = 40;                               // z=1 时的字格边长
const clamp = (x, a = 0, c = 1) => Math.max(a, Math.min(c, x));
export const seg = (t, a, c) => clamp((t - a) / (c - a));
export const ss = t => { t = clamp(t); return t * t * (3 - 2 * t); };
export const eio = t => { t = clamp(t); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
export const eo = t => 1 - Math.pow(1 - clamp(t), 3);
export const ei = t => Math.pow(clamp(t), 2.2);
export const lerp = (a, c, t) => a + (c - a) * t;
export const lerpLog = (a, c, t) => Math.exp(lerp(Math.log(a), Math.log(c), t));
export const hsh = (a, c = 0) => { let h = Math.sin(a * 127.1 + c * 311.7) * 43758.5453; return h - Math.floor(h); };

// —— 浪的时间：成海期间冻结、停顿时几乎停住 ——
export function tw(t) {
  if (t < b(CUE.sea)) return b(CUE.sea);
  return b(CUE.sea) + (Math.min(t, b(CUE.drop)) - b(CUE.sea)) + .12 * (clamp(t, b(CUE.drop), b(CUE.breach)) - b(CUE.drop)) + Math.max(0, t - b(CUE.breach));
}
export function surfaceY(x, T) {
  const v = 92 * Math.sin(.0062 * x + 1.15 * T) + 38 * Math.sin(.0141 * x + 1.9 * T + 1.7) + 15 * Math.sin(.033 * x + 3.1 * T + .4);
  return v - .0032 * v * v;                       // 浪峰尖、浪谷平
}

// —— S5 大浪：b12.5 在右侧隆起，高出海面 2–3 倍，向左卷着滚过画面，b15 浪唇砸下、b16 前塌成碎沫 ——
export const WAVE = { rise: 12.5, full: 13.2, crash: 15, gone: 16 };
export function bigWave(t, c) {
  const t0 = b(WAVE.rise), t1 = b(WAVE.gone); if (t < t0 || t >= t1) return null;
  const u = seg(t, t0, t1);
  const xs = lerp(1820, 120, u);                           // 屏幕 x：右 → 左，匀速滚过
  const xc = c.x + (xs - W / 2) / c.z;
  const up = ss(seg(t, t0, b(WAVE.full))), down = ss(seg(t, b(WAVE.crash), t1));
  const A = 205 * up * (1 - .85 * down);                    // 浪峰高出平均海面
  const curl = ss(seg(t, b(12.9), b(14.2))) * (1 - down);    // 浪唇向左卷出的程度
  const fall = ss(seg(t, b(14.3), b(WAVE.crash)));   // 浪唇砸下
  const cu = seg(t, b(WAVE.crash), t1);                   // 砸下后的线性进度：白沫在 b15 那一帧炸开
  return { xc, A, curl, fall, down, cu, u };
}
function waveLift(x, bw) {
  if (!bw) return 0;
  const d = x - bw.xc;
  const k = d < 0 ? Math.exp(-Math.pow(d / (95 + 140 * bw.down), 2)) : Math.exp(-Math.pow(d / 420, 2));   // 前坡陡、后坡缓
  return -bw.A * k;
}

// —— 鲸的轨迹（世界坐标；th 为俯仰，负 = 抬头） ——
export function whale(t) {
  const B = CUE; let x = 600, y = 1750, th = -.04, em = 0;
  if (t >= b(B.pull0)) {
    const u = seg(t, b(B.pull0), b(B.drop));
    x = lerp(600, 1300, eo(u)); y = lerp(1750, 1350, ss(u)); em = eo(seg(t, b(16.5), b(20.5)));
  }
  if (t >= b(B.drop)) { const u = seg(t, b(B.drop), b(B.breach)); x = 1300; y = lerp(1350, 1200, ei(u)); th = lerp(-.04, -.38, ss(u)); em = 1; }
  if (t >= b(B.breach)) { const u = seg(t, b(B.breach), b(B.apex)); x = lerp(1300, 1500, eo(u)); y = lerp(1200, -620, eo(u)); th = lerp(-.38, -1.05, eo(u)); }
  if (t >= b(B.apex)) { const u = seg(t, b(B.apex), b(27.5)); x = lerp(1500, 1520, u); y = lerp(-620, -540, ss(u)); th = lerp(-1.05, -1.15, u); }
  if (t >= b(27.5)) { const u = seg(t, b(27.5), b(B.land)); x = lerp(1520, 1300, u); y = lerp(-540, 380, ei(u)); th = lerp(-1.15, -2.35, ss(u)); }
  if (t >= b(B.land)) { const u = seg(t, b(B.land), b(33)); x = lerp(1300, 1120, u); y = lerp(380, 1300, eo(u)) + 260 * ss(seg(t, b(31), b(35))); th = lerp(-2.35, -2.9, eo(u)); em = lerp(1, .3, ss(seg(t, b(B.land), b(31)))) * lerp(1, .4, ss(seg(t, b(31), b(34.5)))); }
  // 胸鳍：破水后在 b25–b26 向外张开成两只长白翼，落水后收拢
  const fin = t < b(B.breach) ? 0 : t < b(B.land) ? ss(seg(t, b(24.6), b(25.8))) : lerp(1, 0, ss(seg(t, b(B.land), b(30.5))));
  return { x, y, th, em, fin, L: 2000 };
}
// 鲸局部点 → 世界
export function wpt(w, lx, ly) {
  const c = Math.cos(w.th), s = Math.sin(w.th);
  return [w.x + (lx * c - ly * s) * w.L, w.y + (lx * s + ly * c) * w.L];
}
export const BLOWHOLE = [.25, -.125];   // 与 paintWhale 的 y 向 1.4 倍一致：喷气孔在背上

// —— 摄影机（网格字号）：s = 字格边长，z = s/40 ——
const END = { x: 1250, y: 250, s: 15 };
export function cam(t) {
  const B = CUE;
  let x = 0, y = 100, s = 40;
  if (t >= b(B.sea)) x = lerp(0, 700, seg(t, b(B.sea), b(B.pull0)));
  if (t >= b(B.pull0)) { const u = seg(t, b(B.pull0), b(B.drop)); s = lerpLog(40, 11, eio(u)); y = lerp(100, 964, eio(u)); x = lerp(700, 1300, eo(u)); }
  if (t >= b(B.drop)) { x = 1300; y = 964; s = 11; }
  if (t >= b(B.breach)) {
    const w = whale(t), f = ss(seg(t, b(B.breach), b(24.9)));
    const up = ss(seg(t, b(25.4), b(27.4)));
    s = lerpLog(11, 17, eo(seg(t, b(B.breach), b(B.apex)))) * (1 - .15 * up);
    y = lerp(964, w.y - 240 - 380 * up, f); x = lerp(1300, w.x - 40, f);
  }
  if (t >= b(B.cyan)) {
    const w0 = cam(b(B.cyan) - 1e-6), u = eio(seg(t, b(B.cyan), b(29.5)));
    x = lerp(w0.x, END.x, u); y = lerp(w0.y, END.y, u); s = lerpLog(w0.s, END.s, u);
  }
  return { x, y, s, z: s / S0 };
}
export function camEnd() { return { ...END, z: END.s / S0 }; }
// 网格：格线穿过屏幕中心
export function grid(c) {
  const s = c.s, nL = Math.ceil((W / 2) / s), nT = Math.ceil((CY) / s);
  const gx0 = W / 2 - nL * s, gy0 = CY - nT * s;
  return { s, gx0, gy0, cols: 2 * nL, rows: Math.ceil((MAIN_H - gy0) / s) };
}
export const w2s = (c, wx, wy) => [W / 2 + (wx - c.x) * c.z, CY + (wy - c.y) * c.z];

// —— 鲸的轮廓（局部坐标，体长 1，头朝 +x，y 向下） ——
const TOP = [[.5, .004], [.47, -.03], [.42, -.055], [.33, -.078], [.25, -.088], [.15, -.095], [.04, -.096], [-.06, -.09], [-.1, -.104], [-.115, -.122], [-.13, -.088], [-.2, -.068], [-.28, -.045], [-.36, -.026], [-.405, -.018]];
const FLUKE = [[-.43, -.024], [-.48, -.034], [-.53, -.05], [-.565, -.052], [-.545, -.028], [-.52, -.008], [-.535, .012], [-.565, .03], [-.53, .03], [-.48, .022], [-.43, .022]];
const BOT = [[-.405, .02], [-.36, .03], [-.28, .05], [-.18, .075], [-.06, .1], [.06, .112], [.18, .108], [.28, .095], [.36, .075], [.43, .05], [.48, .025]];
const FIN = [[.27, .06], [.2, .1], [.12, .15], [.04, .2], [-.02, .225], [-.035, .21], [0, .18], [.07, .14], [.13, .1], [.18, .075]];
function poly(g, P) { g.beginPath(); P.forEach(([x, y], k) => k ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); }
const BODY = [...TOP, ...FLUKE, ...BOT];
const R = v => `rgb(${Math.round(clamp(v) * 255)},0,0)`;
const G = v => `rgb(0,${Math.round(clamp(v) * 255)},0)`;

function finPoly(g, w, a, far) {
  // 胸鳍绕鳍根转：a=0 贴着腹侧向后；a=1 张开（近侧向腹外，远侧从背后探出）
  g.translate(.25, .07); g.rotate(far ? lerp(0, 1.5, a) : lerp(0, -1.3, a)); g.translate(-.25, -.07);
  const L = far ? 1 - .2 * a : 1 + .05 * a; g.translate(.25, .07); g.scale(L, L); g.translate(-.25, -.07);
  poly(g, FIN);
}
function paintWhale(g, w, k = 1) {
  g.save(); g.translate(w.x, w.y); g.rotate(w.th); g.scale(w.L, w.L * 1.4);
  const fa = w.fin || 0;
  // 身体：背部亮、腹部暗（光从上方，背光侧只剩稀疏的点）
  poly(g, BODY); g.fillStyle = R(.5 * k); g.fill();
  g.save(); poly(g, BODY); g.clip();
  const gr = g.createLinearGradient(0, -.1, 0, .12); gr.addColorStop(0, R(.98 * k)); gr.addColorStop(.18, R(.7 * k)); gr.addColorStop(.45, R(.36 * k)); gr.addColorStop(.75, R(.2 * k)); gr.addColorStop(1, R(.12 * k));
  g.fillStyle = gr; g.fillRect(-.6, -.2, 1.2, .4);
  // 腹褶：一组从下巴到肚脐的暗线
  g.strokeStyle = R(0); g.lineWidth = .007;
  for (let n = 0; n < 5; n++) { const o = n * .014; g.beginPath(); g.moveTo(.45, .035 + o * .4); g.quadraticCurveTo(.3, .07 + o, .02, .085 + o); g.stroke(); }
  g.restore();
  // 背脊亮边（把鲸与暗水分开）
  g.beginPath(); TOP.forEach(([x, y], n) => n ? g.lineTo(x, y) : g.moveTo(x, y)); g.strokeStyle = R(1 * k); g.lineWidth = .016; g.stroke();
  // 嘴线、眼
  g.beginPath(); g.moveTo(.5, .006); g.quadraticCurveTo(.42, .03, .33, .04); g.strokeStyle = R(0); g.lineWidth = .01; g.stroke();
  g.beginPath(); g.arc(.315, .03, .02, 0, 7); g.fillStyle = R(1 * k); g.fill();
  g.beginPath(); g.arc(.315, .03, .011, 0, 7); g.fillStyle = R(0); g.fill();
  // 近侧长白胸鳍（座头鲸的辨识点）：先描一圈黑缝，再填白、再描亮边，鳍和鲸身之间留出一格空
  g.save(); finPoly(g, w, fa, 0);
  g.strokeStyle = R(0); g.lineWidth = .016 + .012 * fa; g.stroke();
  g.fillStyle = R((.82 + .16 * fa) * k); g.fill();
  g.strokeStyle = R(1 * k); g.lineWidth = .007; g.stroke();
  g.restore();
  g.restore();
}

// 水花：确定性的水滴群（抛物线），t0 起飞
function splash(g, t, t0, x0, n, seed, spread, up, k = 1) {
  const tau = t - t0; if (tau < 0 || tau > 1.6) return;
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const r1 = hsh(i, seed), r2 = hsh(seed, i * 1.3), r3 = hsh(i * .7 + seed, 9);
    const vx = (r1 - .5) * spread, vy = -(up * (.45 + .55 * r2)), gv = 2600;
    const px = x0 + (r3 - .5) * 260 + vx * tau, py = vy * tau + .5 * gv * tau * tau;
    if (py > 40) continue;
    const a = (1 - tau / 1.6) * (.6 + .4 * r3) * k;
    g.beginPath(); g.arc(px, py, 14 + 24 * r2, 0, 7); g.fillStyle = R(a); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
}

// 水柱（顶点喷出，强拍时变冰青）：返回世界坐标几何以便取粒子源
export function spout(t) {
  const t0 = b(CUE.apex); if (t < t0) return null;
  const w = whale(t0 + Math.min(t - t0, b(2))), [bx, by] = wpt(w, ...BLOWHOLE);
  const h = 1050 * eo(seg(t, t0, b(27.4)));
  // 喷口朝背侧（鲸几乎直立时朝左上），水柱离开头顶后再被重力拉成向上张开的扇
  const dx = Math.sin(w.th), dy = -Math.cos(w.th), n = Math.hypot(dx * .55, dy * .55 - .45);
  return { bx, by, h, ux: dx * .55 / n, uy: (dy * .55 - .45) / n };
}
function paintSpout(g, t) {
  const sp = spout(t); if (!sp) return;
  const cyan = t >= b(CUE.cyan), fade = cyan ? 1 - seg(t, b(CUE.cyan), b(CUE.cyan) + .3) : 1;
  if (fade <= 0) return;
  const C = cyan ? G : R, { bx, by, h } = sp;
  const grow = h / 1050, age = t - b(CUE.apex);
  g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
  // 喷泉：从背侧的喷气孔斜着喷出，根部与头顶隔开一段空（不粘成一根棒）；一束细水柱从窄口张开成扇，彼此留缝
  const { ux, uy } = sp, px0 = -uy, py0 = ux;                     // 扇面的横向
  const gap = 170, H = h, NJ = 9;
  const ox = bx + ux * gap, oy = by + uy * gap;
  for (let n = 0; n < NJ; n++) {
    const f = n / (NJ - 1) - .5, r = hsh(n, 41);
    const len = H * (.8 + .2 * Math.cos(f * 2.6)) * (.92 + .08 * r);
    const fan = f * (.8 + .2 * r) * H * .95;
    const steps = 14;
    const P = u => { const a = Math.pow(u, 1.35); return [ox + f * 40 * px0 + ux * len * u + px0 * fan * a, oy + f * 40 * py0 + uy * len * u + py0 * fan * a + 120 * u * u]; };
    for (let q = 0; q < steps; q++) {
      const u0 = q / steps, u1 = (q + 1) / steps;
      if (hsh(n * 7 + q, 3) < .16 && u0 > .25) continue;   // 水柱里断开的小缝
      const [ax, ay] = P(u0), [cx, cy] = P(u1);
      const core = Math.abs(f) < .2 ? 1 : .72;
      g.strokeStyle = C(core * (.95 - .3 * u0) * fade); g.lineWidth = (12 + 20 * Math.sin(Math.PI * Math.min(1, u0 * 1.4))) * Math.max(.5, grow);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(cx, cy); g.stroke();
    }
  }
  // 顶冠：水柱到顶后散成飞沫，向两侧翻落（越外越稀越暗，只剩低墨量的点）
  const crown = clamp((grow - .6) / .4);
  if (crown > 0) for (let i = 0; i < 150; i++) {
    const r1 = hsh(i, 7), r2 = hsh(i, 11), r3 = hsh(i, 13), side = r1 < .5 ? -1 : 1;
    const ang = (.12 + .8 * r2) * side, sp2 = H * (.1 + .4 * r3) * (.35 + .65 * crown);
    const tt = clamp(age * .8 + r1 * .3 - .15, 0, 1.4);
    const hx = ox + ux * H * (.82 + .1 * r2), hy = oy + uy * H * (.82 + .1 * r2) + 120;
    const px = hx + side * H * .18 * r3 + Math.sin(ang) * sp2 * (.6 + tt * .5);
    const py = hy - Math.cos(ang) * sp2 * .7 + 520 * tt * tt * (.3 + .7 * r3);
    const dim = (.62 - .42 * r3 - .15 * Math.abs(Math.sin(ang))) * fade;
    g.beginPath(); g.arc(px, py, 7 + 7 * r2, 0, 7); g.fillStyle = C(dim); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
}

// 卷浪：浪唇从浪峰向左伸出、下垂、末端内卷；唇下是空的管腔（负空间）；浪尖的沫是稀疏的暗点，被风吹向左上
function paintCurl(g, bw, sy, T) {
  const cx = bw.xc, cy = sy(cx), L = 370 * bw.curl, drop = 100 + 240 * bw.fall;
  if (L > 8) {
    const pts = [];
    for (let k = 0; k <= 16; k++) {
      const s = k / 16, ang = s * (1.2 + 1.6 * bw.fall);
      pts.push([cx - L * Math.sin(ang * .9) * (1 - .25 * s), cy + 10 + drop * (1 - Math.cos(ang)) * .85 + 20 * s]);
    }
    // 唇下压暗（管腔）：先挖空，再画浪唇
    g.save(); g.globalCompositeOperation = 'source-over';
    const gr = g.createRadialGradient(cx - L * .4, cy + drop * .55, 0, cx - L * .4, cy + drop * .55, L * .55);
    gr.addColorStop(0, R(0)); gr.addColorStop(.7, 'rgba(0,0,0,.8)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx - L * .4, cy + drop * .55, L * .55, 0, 7); g.fill();
    g.restore();
    for (let k = 0; k < 16; k++) {
      const s = k / 16;
      g.strokeStyle = R(1 - .35 * s); g.lineWidth = 64 - 40 * s;
      g.beginPath(); g.moveTo(...pts[k]); g.lineTo(...pts[k + 1]); g.stroke();
    }
    g.globalCompositeOperation = 'lighter';
    // 浪尖碎沫：沿唇稀疏散开、往左上被吹走
    for (let i = 0; i < 70; i++) {
      const r1 = hsh(i, 21), r2 = hsh(i, 23), r3 = hsh(i, 29);
      const k = Math.floor(r1 * 16), [px, py] = pts[k];
      const blow = 40 + 170 * r2 * (.4 + bw.curl);
      g.beginPath(); g.arc(px - blow * .8 + 30 * Math.sin(T * 3 + i), py - blow * .35 - 30 * r3, 8 + 7 * r3, 0, 7);
      g.fillStyle = R(.3 + .25 * r3); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }
  // 塌下来的那一下：一片向左炸开的白沫
  if (bw.cu > 0) {
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 90; i++) {
      const r1 = hsh(i, 31), r2 = hsh(i, 37), r3 = hsh(i, 41);
      const e = eo(bw.cu), px = cx - 60 - 460 * r1 * (.25 + .75 * e), py = sy(px) - 40 - 260 * r2 * e * (1 - .55 * bw.cu * bw.cu);
      g.beginPath(); g.arc(px, py, 9 + 9 * r3, 0, 7); g.fillStyle = R((.8 - .4 * r2) * (1 - .7 * bw.cu)); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }
}

// —— 画一帧底片 ——
export function paintNeg(g, t, c, gd) {
  const k = SS / gd.s;                          // 屏幕像素 → 底片像素
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  g.fillStyle = '#000'; g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  // 世界 → 底片
  const zk = c.z * k;
  g.setTransform(zk, 0, 0, zk, (W / 2 - gd.gx0 - c.x * c.z) * k, (CY - gd.gy0 - c.y * c.z) * k);
  const T = tw(t), xl = c.x - (W / 2) / c.z - 200, xr = c.x + (W / 2) / c.z + 200, yb = c.y + CY / c.z + 400;
  const w = whale(t);
  // 破水时水面被推起
  const bulge = x => {
    let d = 0;
    const u1 = seg(t, b(CUE.breach) - .05, b(CUE.breach) + 1.4); if (u1 > 0 && u1 < 1) d -= 160 * Math.sin(Math.PI * u1) * Math.exp(-Math.pow((x - 1330) / 380, 2));
    const u2 = seg(t, b(CUE.land), b(CUE.land) + 1.6); if (u2 > 0 && u2 < 1) d += 120 * Math.sin(Math.PI * u2) * Math.exp(-Math.pow((x - 1100) / 520, 2)) * Math.cos((x - 1100) / 90 - u2 * 9);
    return d;
  };
  const bw = bigWave(t, c);
  const calm = x => bw ? 1 - .7 * Math.exp(-Math.pow((x - bw.xc) / 700, 2)) * Math.min(1, bw.A / 200) : 1;   // 大浪近旁的小浪压平，大浪才显得高
  const sy = x => surfaceY(x, T) * calm(x) + bulge(x) + waveLift(x, bw);
  const step = 24;
  // 海体：越深越暗越稀
  g.beginPath(); g.moveTo(xl, yb);
  for (let x = xl; x <= xr + step; x += step) g.lineTo(x, sy(x));
  g.lineTo(xr + step, yb); g.closePath();
  const gr = g.createLinearGradient(0, -40, 0, 2600);
  [[0, .7], [.012, .42], [.03, .22], [.07, .12], [.14, .065], [.25, .035], [.4, .012], [.5, 0], [1, 0]].forEach(([o, v]) => gr.addColorStop(o, R(v)));
  g.fillStyle = gr; g.fill();
  // 水下的卷浪纹：与水面平行、向左卷动的亮纹
  g.globalCompositeOperation = 'lighter';
  for (let n = 1; n <= 7; n++) {
    g.beginPath();
    for (let x = xl; x <= xr; x += step) { const y = surfaceY(x - n * 41, T * .82 + n * .6) + n * 62 + 16 * Math.sin(.006 * x - T * 1.1 + n); x === xl ? g.moveTo(x, y) : g.lineTo(x, y); }
    g.strokeStyle = R(.46 * (1 - n / 9)); g.lineWidth = 22 - n; g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  // 鲸（水下部分被水吞掉一部分亮度，越深越暗）
  if (w.em > 0) {
    const depthK = clamp(1 - Math.max(0, w.y - 300) / 2600);
    g.save(); g.beginPath(); g.moveTo(xl, yb); for (let x = xl; x <= xr + step; x += step) g.lineTo(x, sy(x)); g.lineTo(xr + step, yb); g.closePath(); g.clip();
    g.globalAlpha = clamp(.95 * w.em * (.5 + .5 * depthK)); paintWhale(g, w, 1); g.restore(); g.globalAlpha = 1;
    g.save(); g.beginPath(); g.moveTo(xl, -6000); for (let x = xl; x <= xr + step; x += step) g.lineTo(x, sy(x)); g.lineTo(xr + step, -6000); g.closePath(); g.clip();
    paintWhale(g, w, 1); g.restore();
  }
  // 浪尖白沫
  g.beginPath(); for (let x = xl; x <= xr + step; x += step) { const y = sy(x); x === xl ? g.moveTo(x, y) : g.lineTo(x, y); }
  g.strokeStyle = R(1); g.lineWidth = 22; g.stroke();
  g.globalCompositeOperation = 'lighter';
  for (let x = Math.floor(xl / 90) * 90; x <= xr; x += 90) {      // 浪峰处的碎沫
    const y = sy(x), y2 = sy(x + 12), y0 = sy(x - 12);
    if (y < y0 && y < y2 && y < -60) { for (let q = 0; q < 4; q++) { g.beginPath(); g.arc(x + (hsh(x, q) - .5) * 70, y - 24 - 40 * hsh(q, x), 16 + 10 * q, 0, 7); g.fillStyle = R(.6 - .1 * q); g.fill(); } }
  }
  g.globalCompositeOperation = 'source-over';
  if (bw) paintCurl(g, bw, sy, T);
  // 破水与落水的水花
  splash(g, t, b(CUE.breach), 1330, 70, 3, 1300, 2100);
  splash(g, t, b(CUE.land), 1050, 110, 9, 2600, 2400);
  paintSpout(g, t);
  g.setTransform(1, 0, 0, 1, 0, 0);
}
