// BOSS · 混合规则：左半蜡笔（苹果树）+ 右半水墨（卧室开关），撕纸缝拼接；网印小豆子剪贴在中间；像素雨云客串撞树
import { canvas, W, H } from './media.js';
import { sceneCrayon, apple, cline } from './g_crayon.js';
import { clearInk, inkLayers, room, flood, printInk, moon, brush } from './g_ink.js';
import { clearPlates, heroRisoBody, printPlates, PINK, BLUE } from './g_riso.js';
import { pixelOverlay, cloudPixel } from './g_pixel.js';
import { clamp, lerp, eo, ei, eio, back, mulberry, hash, TAU } from '/core/lib.js';

const LEFT = canvas(), lg = LEFT.getContext('2d'), RIGHT = canvas(), rg = RIGHT.getContext('2d');
const SEAM = [...Array(28)].map((_, i) => [960 + (hash(i * 4.7) - .5) * 46, i / 27 * 1120 - 20]);
const seamPath = (c, side, dx = 0) => { // side -1 左半，1 右半
  c.beginPath(); c.moveTo(side < 0 ? -50 : 1970, -20); for (const [x, y] of SEAM) c.lineTo(x + dx, y); c.lineTo(side < 0 ? -50 : 1970, 1100); c.closePath(); };
export const BSW = [1250, 520];          // 开关位置
const HX = 1010, HY = 975;               // 小豆子脚底

// lf: 段内帧（可为负：-6..0 两半从画外撞进来）
export function boss(out, lf, fpb) {
  const tb = lf / fpb;
  // —— 左半：蜡笔 ——
  lg.setTransform(1, 0, 0, 1, 0, 0); lg.clearRect(0, 0, W, H);
  const dropB = 2, catchB = 3, slapB = 4;
  // 目标苹果挂在伸出树冠的枝头（画布 x 1075 → 屏幕 875），比别的苹果大，下落路径在空白天空里
  const AX = 860, AY = 262;
  const A = { on: tb < dropB, x: AX + 200, y: AY, rot: tb >= 1.6 ? Math.sin(lf * 1.3) * .25 : 0, s: 1.35 };
  const shake = tb >= dropB && tb < dropB + .8 ? 1 - (tb - dropB) / .8 : 0;
  sceneCrayon(lg, { t: lf / 24, boil: Math.floor((lf + 400) / 2), cam: -200, appleState: A, sunY: 180, shake,
    extra: c => cline(c, cc => { cc.moveTo(930, 330); cc.quadraticCurveTo(1010, 250, AX + 200 + 4, AY - 50); }, '#8a5a2b', 14) });
  // —— 右半：水墨卧室（亮着灯）——
  clearInk(); const { wt, dr } = inkLayers();
  room(wt, { sw: BSW, winX: 1440, lampX: 1150, bed: false, switchOn: tb < slapB, lampSwing: Math.sin(lf * .2) * .1 });
  rg.setTransform(1, 0, 0, 1, 0, 0); rg.clearRect(0, 0, W, H); printInk(rg);
  // —— 拼接（撞入）——
  const slide = lf < 0 ? ei(clamp((lf + 6) / 6)) : 1, off = (1 - slide) * 1000;
  if (lf >= 0) { out.save(); out.fillStyle = '#2a0f5c'; out.fillRect(0, 0, W, H); out.restore(); }
  out.save(); out.translate(-off, 0); seamPath(out, -1); out.clip(); out.drawImage(LEFT, 0, 0); out.restore();
  out.save(); out.translate(off, 0); seamPath(out, 1); out.clip(); out.drawImage(RIGHT, 0, 0); out.restore();
  // 撕纸白边
  out.save(); out.lineJoin = 'round'; out.strokeStyle = '#fbf6ea'; out.lineWidth = 16; out.beginPath(); for (const [x, y] of SEAM) out.lineTo(x, y); if (slide >= 1) out.stroke();
  out.strokeStyle = 'rgba(60,40,30,.35)'; out.lineWidth = 3; out.stroke(); out.restore();
  if (lf < 1) return;
  // —— 像素雨云：C1 从左上飘进，C2 撞树 ——
  const cu = clamp((tb - 1) / 1), cxB = lerp(-22, 12, ei(cu)) - (tb >= 2 ? 2 * Math.exp(-(tb - 2) * 4) : 0), cyB = 27 + Math.round(Math.sin(lf * .5));
  pixelOverlay(out, L => cloudPixel(L, cxB, cyB, { grin: tb >= 2 }));
  // —— 网印小豆子：C0.5 落下，C1 着地 ——
  const fall = clamp((tb - .4) / .6), land = tb >= 1 ? Math.exp(-(tb - 1) * 6) : 0;
  const hy = lerp(-700, HY, ei(fall));
  const L0 = [-140, -150], R0 = [140, -150], Lc = [AX - HX + 5, 470 - HY], Rs = [BSW[0] - HX - 10, BSW[1] - HY + 20];
  const lk = eio(clamp((tb - 2.2) / .8)), rk = eio(clamp((tb - 3.25) / .75));
  const arms = { l: [lerp(L0[0], Lc[0], lk), lerp(L0[1], Lc[1], lk)], r: [lerp(R0[0], Rs[0], rk), lerp(R0[1], Rs[1], rk)] };
  if (tb >= catchB) { const d = Math.exp(-(tb - catchB) * 8); arms.l = [Lc[0], Lc[1] + 30 * d]; }
  // 剪贴纸白底
  out.save(); out.translate(HX, hy); out.scale(1, 1 - land * .12); out.translate(0, 0);
  out.fillStyle = '#fbf6ea'; out.strokeStyle = '#fbf6ea'; out.lineCap = 'round'; out.lineJoin = 'round';
  out.beginPath(); out.arc(0, -400, 140, 0, TAU); out.arc(0, -548, 52, 0, TAU); out.fill();
  out.beginPath(); out.roundRect(-112, -320, 224, 330, 60); out.fill();
  out.lineWidth = 80; for (const h of [arms.l, arms.r]) { out.beginPath(); out.moveTo(Math.sign(h[0]) * 76, -270); out.lineTo(h[0], h[1]); out.stroke(); }
  out.shadowColor = 'rgba(0,0,0,.25)'; out.restore();
  clearPlates();
  heroRisoBody(HX, hy, 1, arms, tb >= slapB ? 'smile' : 'o');
  printPlates(out, [6, -4], { paper: false });
  if (tb >= dropB && tb < catchB) { const u = (tb - dropB) / (catchB - dropB), ex = HX + Lc[0], ey = HY + Lc[1] - 40;
    const ax = lerp(AX, ex, u), ay = lerp(AY, ey, u * u);
    out.save(); out.strokeStyle = '#2b2a6b'; out.lineWidth = 7; out.lineCap = 'round'; out.globalAlpha = .7;   // 蜡笔速度线
    for (const dx of [-26, 0, 26]) { out.beginPath(); out.moveTo(ax + dx, ay - 70 - u * 60); out.lineTo(ax + dx * .8, ay - 60); out.stroke(); } out.restore();
    apple(out, ax, ay, 1.35, u * 2); }
  if (tb >= catchB && tb < slapB + 1.2) apple(out, HX + arms.l[0], hy + arms.l[1] - 40, 1.35, .3);
  // —— 拍开关：墨晕吞没两半 ——
  if (tb >= slapB) {
    clearInk(); const k = clamp(.16 + (tb - slapB) / 1.05);   // 拍点那一帧就起墨
    flood(inkLayers().dr, BSW[0], BSW[1], k, 2400, 9);
    printInk(out, false);
    out.save(); out.globalCompositeOperation = 'multiply'; out.fillStyle = `rgba(70,64,78,${.55 * (1 - k * .5)})`; out.fillRect(0, 0, W, H); out.restore();   // 灯灭：整屏立刻暗一档
    const night = clamp(k * 1.6 - .3);
    if (night > 0) {
      moon(out, 1640, 330, 70, night);
      out.save(); out.globalAlpha = night; out.fillStyle = '#f7f0de'; for (const sg of [-1, 1]) { out.beginPath(); out.arc(HX + sg * 40, hy - 380, 12, 0, TAU); out.fill(); } out.restore();
      // 苹果在夜里发光（蜡笔红）
      out.save(); out.globalAlpha = night * .5; out.filter = 'blur(20px)'; out.fillStyle = '#ff6a3a'; out.beginPath(); out.arc(HX + arms.l[0], hy + arms.l[1] - 40, 70, 0, TAU); out.fill(); out.restore();
      apple(out, HX + arms.l[0], hy + arms.l[1] - 40, 1.35, .3);
    }
    // 粉色绒球 + 帽在夜里仍然亮
    out.save(); out.fillStyle = PINK; out.globalCompositeOperation = 'source-over'; out.beginPath(); out.arc(HX, hy - 548, 30, 0, TAU); out.fill(); out.restore();
  }
}
