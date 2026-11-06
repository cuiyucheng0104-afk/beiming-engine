// 《纸龙》全部纸艺绘制：城堡、士兵、吊桥、拉片、纸龙、烟花、页面。Canvas2D，统一墨色描边 + 新月阴影 + 白边卡纸。
import { mulberry, TAU, clamp, lerp } from './lib.js';
import { cv, finishCut, sh, blob, smoothClosed, smoothOpen, crescent, paperFill, INK, GRAIN, rr } from './paper.js';

export const LW = 9, LW2 = 5;
export const PPM = 5200;                         // 静态道具：每米像素
export const C = {
  sky0: '#8fd0f2', sky1: '#d8f1f6', hill: '#a6d98a', hillS: '#7fbf66', hill2: '#8fcf72', hill2S: '#6cb055',
  stone: '#f3e2bd', stoneS: '#d8bd8c', roof: '#e5533d', roofS: '#b93a2c', gold: '#ffcf3f', goldS: '#e0a52a',
  wood: '#b0703e', woodS: '#87502a', moat: '#5fb4e6', grass: '#9fd57a',
  nsky0: '#141c45', nsky1: '#3b4c88', nhill: '#3e4180', nhillS: '#2d2e60', nstone: '#7b8bbd', nstoneS: '#5e6c9d',
  nroof: '#8f3d63', nroofS: '#6c2a4a', win: '#ffd76a',
  red: '#e8412f', redS: '#b82c22', belly: '#ffd24a', bellyS: '#e9a92c',
};

export function cut(wm, hm, draw, o = {}) {
  const pad = o.pad ?? 30, w = Math.ceil(wm * PPM) + pad * 2, h = Math.ceil(hm * PPM) + pad * 2;
  const c = cv(w, h), x = c.getContext('2d'); x.translate(pad, pad);
  draw(x, w - pad * 2, h - pad * 2);
  const out = o.raw ? c : finishCut(c, o.border ?? 14, o);
  return { c: out, w: w / PPM, h: h / PPM, ax: o.ax ?? .5, ay: o.ay ?? 1 - pad / h, pad };
}

// ---------- 山丘 ----------
export function hill(wm, hm, col, shade, seed, o = {}) {
  return cut(wm, hm, (x, W, H) => {
    const R = mulberry(seed), n = o.bumps ?? 3, pts = [[0, H]];
    for (let i = 0; i <= n * 2; i++) { const u = i / (n * 2), top = i % 2 === 0 ? (.25 + R() * .45) : (.05 + R() * .2); pts.push([u * W, H * (i % 2 ? top : top + .1) + (i === 0 || i === n * 2 ? H * .35 : 0)]); }
    pts.push([W, H]);
    const path = () => { x.beginPath(); x.moveTo(0, H + 40); x.lineTo(pts[1][0], pts[1][1]); smoothOpen(x, pts.slice(1, -1), false); x.lineTo(W, H + 40); x.closePath(); };
    crescent(x, path, shade, 40, 30, col); path(); sh(x, null, LW);
    x.strokeStyle = shade; x.lineWidth = 6; x.lineCap = 'round';
    for (let i = 0; i < 9; i++) { const px = W * (.08 + R() * .84), py = H * (.5 + R() * .4); x.beginPath(); x.moveTo(px - 14, py); x.lineTo(px - 6, py - 22); x.moveTo(px, py); x.lineTo(px + 2, py - 30); x.moveTo(px + 12, py); x.lineTo(px + 12, py - 20); x.stroke(); }
    if (o.stars) { x.fillStyle = 'rgba(255,240,190,.5)'; for (let i = 0; i < 10; i++) { x.beginPath(); x.arc(W * (.1 + R() * .8), H * (.55 + R() * .35), 5 + R() * 4, 0, TAU); x.fill(); } }
  });
}

// ---------- 城堡部件 ----------
function bricks(x, W, H, y0, col, seed, rows = 7) {
  const R = mulberry(seed); x.strokeStyle = col; x.lineWidth = 4; x.lineCap = 'round';
  for (let i = 0; i < rows * 2; i++) { const px = W * (.1 + R() * .8), py = y0 + (H - y0) * (.08 + R() * .85), l = 26 + R() * 30; x.beginPath(); x.moveTo(px, py); x.lineTo(px + l, py); x.stroke(); x.beginPath(); x.moveTo(px + l + 8, py - 18); x.lineTo(px + l + 8, py); x.stroke(); }
}
function windowArch(x, cx, cy, w, h, glow) {
  x.beginPath(); x.moveTo(cx - w / 2, cy + h / 2); x.lineTo(cx - w / 2, cy - h / 2 + w / 2); x.arc(cx, cy - h / 2 + w / 2, w / 2, Math.PI, 0); x.lineTo(cx + w / 2, cy + h / 2); x.closePath();
  sh(x, glow ? C.win : '#4a3a5a', LW2 + 1);
  if (glow) { x.beginPath(); x.moveTo(cx, cy - h / 2 + 6); x.lineTo(cx, cy + h / 2); x.moveTo(cx - w / 2, cy + 4); x.lineTo(cx + w / 2, cy + 4); x.lineWidth = 4; x.strokeStyle = '#d99a3a'; x.stroke(); }
}
function coneRoof(x, cx, by, w, h, col, shade) {
  const path = () => { x.beginPath(); x.moveTo(cx - w / 2 - 14, by); x.quadraticCurveTo(cx - w * .2, by - h * .45, cx, by - h); x.quadraticCurveTo(cx + w * .2, by - h * .45, cx + w / 2 + 14, by); x.quadraticCurveTo(cx, by + 22, cx - w / 2 - 14, by); x.closePath(); };
  crescent(x, path, shade, 30, 0, col); path(); sh(x, null, LW);
  x.strokeStyle = shade; x.lineWidth = 4; for (let i = 1; i < 4; i++) { const yy = by - h * i * .22; x.beginPath(); x.moveTo(cx - w * (.5 - i * .11), yy + 8); x.quadraticCurveTo(cx, yy + 18, cx + w * (.5 - i * .11), yy + 8); x.stroke(); }
}
// 塔楼（含尖顶，无旗——旗是单独会抖的卡片）
export function tower(wm, hm, night, seed) {
  return cut(wm, hm, (x, W, H) => {
    const st = night ? C.nstone : C.stone, ss = night ? C.nstoneS : C.stoneS, rf = night ? C.nroof : C.roof, rs = night ? C.nroofS : C.roofS;
    const bodyTop = H * .42, bw = W * .74, cx = W / 2;
    const body = () => { x.beginPath(); x.moveTo(cx - bw / 2, H); x.lineTo(cx - bw / 2, bodyTop); x.lineTo(cx + bw / 2, bodyTop); x.lineTo(cx + bw / 2, H); x.closePath(); };
    crescent(x, body, ss, 46, 0, st); body(); sh(x, null, LW);
    bricks(x, bw, H, bodyTop + 40, ss, seed);
    // 檐口
    rr(x, cx - bw / 2 - 18, bodyTop - 26, bw + 36, 40, 10); sh(x, st, LW);
    coneRoof(x, cx, bodyTop - 24, bw, H * .4, rf, rs);
    windowArch(x, cx, bodyTop + (H - bodyTop) * .32, bw * .26, bw * .42, night);
    windowArch(x, cx, bodyTop + (H - bodyTop) * .66, bw * .2, bw * .32, night);
  });
}
// 主楼
export function keep(wm, hm, night) {
  return cut(wm, hm, (x, W, H) => {
    const st = night ? C.nstone : C.stone, ss = night ? C.nstoneS : C.stoneS, rf = night ? C.nroof : C.roof, rs = night ? C.nroofS : C.roofS;
    const top = H * .36, bw = W * .8, cx = W / 2, l = cx - bw / 2, r = cx + bw / 2, cr = 46;
    const body = () => {
      x.beginPath(); x.moveTo(l, H); x.lineTo(l, top);
      const n = 7; for (let i = 0; i < n; i++) { const a = l + bw * i / n, b = l + bw * (i + .5) / n; x.lineTo(a, top - cr); x.lineTo(b, top - cr); x.lineTo(b, top); x.lineTo(l + bw * (i + 1) / n, top); }
      x.lineTo(r, top - cr); x.lineTo(r, H); x.closePath();
    };
    crescent(x, body, ss, 50, 0, st); body(); sh(x, null, LW);
    bricks(x, bw, H, top + 40, ss, 3, 9);
    // 中央小阁楼 + 尖顶
    const tw = bw * .34, tt = top - H * .1;
    const tb = () => { x.beginPath(); x.rect(cx - tw / 2, tt, tw, top - cr - tt + 4); };
    crescent(x, tb, ss, 26, 0, st); tb(); sh(x, null, LW);
    coneRoof(x, cx, tt + 6, tw, H * .3, rf, rs);
    windowArch(x, cx, tt + (top - cr - tt) * .55, tw * .34, tw * .5, night);
    for (const k of [-1, 1]) windowArch(x, cx + k * bw * .27, top + (H - top) * .32, bw * .1, bw * .17, night);
    windowArch(x, cx, top + (H - top) * .3, bw * .12, bw * .2, night);
  });
}
// 城墙（带城门洞 + 牌匾）
export function wall(wm, hm, night, gateW) {
  return cut(wm, hm, (x, W, H) => {
    const st = night ? C.nstone : C.stone, ss = night ? C.nstoneS : C.stoneS, cr = 50, top = cr + 4, cx = W / 2;
    const gw = gateW * PPM, gh = H * .62;
    const body = () => {
      x.beginPath(); x.moveTo(0, H); x.lineTo(0, top);
      const n = 11; for (let i = 0; i < n; i++) { const a = W * i / n, b = W * (i + .5) / n; x.lineTo(a, top - cr); x.lineTo(b, top - cr); x.lineTo(b, top); x.lineTo(W * (i + 1) / n, top); }
      x.lineTo(W, top - cr); x.lineTo(W, H); x.closePath();
    };
    crescent(x, body, ss, 0, -30, st); body(); sh(x, null, LW);
    bricks(x, W, H, top + 30, ss, 9, 12);
    // 门洞
    x.beginPath(); x.moveTo(cx - gw / 2, H); x.lineTo(cx - gw / 2, H - gh + gw / 2); x.arc(cx, H - gh + gw / 2, gw / 2, Math.PI, 0); x.lineTo(cx + gw / 2, H); x.closePath();
    sh(x, night ? '#1d1838' : '#4b3328', LW);
    // 门洞拱石
    x.beginPath(); x.arc(cx, H - gh + gw / 2, gw / 2 + 22, Math.PI * 1.02, -Math.PI * .02); x.lineWidth = 36; x.strokeStyle = ss; x.stroke();
    x.beginPath(); x.arc(cx, H - gh + gw / 2, gw / 2 + 40, Math.PI * 1.02, -Math.PI * .02); x.lineWidth = LW2; x.strokeStyle = INK; x.stroke();
    // 牌匾「龙城」
    const pw = gw * 1.25, ph = gw * .5, py = H - gh - ph - 70;
    rr(x, cx - pw / 2, py, pw, ph, 16); sh(x, night ? '#5a2a40' : '#c23a2c', LW);
    rr(x, cx - pw / 2 + 14, py + 14, pw - 28, ph - 28, 10); x.lineWidth = 5; x.strokeStyle = C.gold; x.stroke();
    x.fillStyle = C.gold; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `400 ${Math.round(ph * .66)}px "ZCOOL KuaiLe"`;
    x.fillText('龙城', cx, py + ph * .56);
  });
}
// 吊桥（竖直时：底边 = 铰链）
export function bridge(wm, hm) {
  return cut(wm, hm, (x, W, H) => {
    const p = () => { rr(x, 0, 0, W, H, 18); };
    crescent(x, p, C.woodS, 22, 0, C.wood); p(); sh(x, null, LW);
    x.strokeStyle = C.woodS; x.lineWidth = 5; for (let i = 1; i < 6; i++) { x.beginPath(); x.moveTo(W * i / 6, 14); x.lineTo(W * i / 6, H - 14); x.stroke(); }
    for (const yy of [H * .18, H * .82]) { rr(x, 8, yy - 14, W - 16, 28, 8); sh(x, '#6d6a72', LW2); for (let i = 0; i < 4; i++) { x.beginPath(); x.arc(30 + i * (W - 60) / 3, yy, 7, 0, TAU); x.fillStyle = '#c9c4cf'; x.fill(); } }
    for (const xx of [W * .12, W * .88]) { x.beginPath(); x.arc(xx, 30, 16, 0, TAU); sh(x, '#8d8a93', LW2); }
  }, { ay: 1 - 30 / (Math.ceil(hm * PPM) + 60) });
}
// 小旗（左端 = 旗杆）
export function flag(wm, hm, col) {
  return cut(wm, hm, (x, W, H) => {
    x.beginPath(); x.moveTo(10, H); x.lineTo(10, 0); x.lineWidth = 9; x.strokeStyle = INK; x.stroke();
    const f = () => { x.beginPath(); x.moveTo(12, 6); x.quadraticCurveTo(W * .5, -10, W, H * .22); x.quadraticCurveTo(W * .55, H * .3, W * .9, H * .5); x.quadraticCurveTo(W * .5, H * .44, 12, H * .5); x.closePath(); };
    crescent(x, f, 'rgba(0,0,0,.18)', 0, 18, col); f(); sh(x, null, LW2 + 1);
  }, { ax: 30 / (Math.ceil(wm * PPM) + 60), border: 12 });
}
// 护城河波浪条
export function waves(wm, hm, col, dark, seed, n = 8) {
  return cut(wm, hm, (x, W, H) => {
    const R = mulberry(seed);
    const p = () => { x.beginPath(); x.moveTo(0, H); x.lineTo(0, H * .5); for (let i = 0; i < n; i++) { const a = W * i / n, b = W * (i + 1) / n; x.quadraticCurveTo((a + b) / 2, H * (.0 + R() * .2), b, H * .5); } x.lineTo(W, H); x.closePath(); };
    crescent(x, p, dark, 0, 24, col); p(); sh(x, null, LW2 + 2);
    x.strokeStyle = 'rgba(255,255,255,.7)'; x.lineWidth = 6; x.lineCap = 'round';
    for (let i = 0; i < n; i++) { const a = W * (i + .3) / n; x.beginPath(); x.moveTo(a, H * .55); x.quadraticCurveTo(a + W / n * .2, H * .45, a + W / n * .4, H * .55); x.stroke(); }
  }, { border: 12 });
}
export function bush(wm, hm, col, shade, seed, dots) {
  return cut(wm, hm, (x, W, H) => {
    const path = () => mulberrySeedPath(x, W, H, seed, 4);
    crescent(x, path, shade, 30, 24, col); path(); sh(x, null, LW);
    if (dots) { const Rd = mulberry(seed + 9); for (let i = 0; i < 9; i++) { x.beginPath(); x.arc(W * (.12 + Rd() * .76), H * (.3 + Rd() * .55), 10, 0, TAU); sh(x, dots, 4); } }
  });
}
function mulberrySeedPath(x, W, H, seed, k) {
  const R = mulberry(seed); x.beginPath(); x.moveTo(0, H);
  for (let i = 0; i <= k; i++) { const cx = W * (i + .5) / (k + 1), r = W / (k + 1) * (.78 + R() * .22); const cy = H - r * .85 - R() * H * .18; x.arc(cx, Math.max(r, cy), r, Math.PI, 0); }
  x.lineTo(W, H); x.closePath();
}
export function flower(hm, petal, seed) {
  return cut(hm * .6, hm, (x, W, H) => {
    x.beginPath(); x.moveTo(W / 2, H); x.quadraticCurveTo(W * .4, H * .6, W / 2, H * .35); x.lineWidth = 8; x.strokeStyle = '#3f8f3a'; x.stroke();
    x.beginPath(); x.ellipse(W * .32, H * .7, W * .2, W * .1, -.6, 0, TAU); sh(x, '#5cbf4a', LW2);
    for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; x.beginPath(); x.arc(W / 2 + Math.cos(a) * W * .2, H * .3 + Math.sin(a) * W * .2, W * .17, 0, TAU); sh(x, petal, LW2); }
    x.beginPath(); x.arc(W / 2, H * .3, W * .13, 0, TAU); sh(x, '#ffd23f', LW2);
  }, { border: 12 });
}

// ---------- 纸士兵 ----------
export const SOL_W = 360, SOL_H = 900;
export function soldier(hm, coat = '#d8423a', seed = 1) {
  return cut(hm * .42, hm, (x, W, H) => {
    const s = W / 360; x.scale(s, s); const w = 360, h = H / s;
    // 长矛
    x.beginPath(); x.moveTo(300, h); x.lineTo(300, 70); x.lineWidth = 12; x.strokeStyle = '#7a4a2a'; x.stroke(); x.lineWidth = LW2; x.strokeStyle = INK;
    x.beginPath(); x.moveTo(300, 20); x.lineTo(322, 80); x.lineTo(278, 80); x.closePath(); sh(x, C.gold, LW2);
    // 腿
    for (const lx of [130, 205]) { rr(x, lx, h * .7, 56, h * .27, 14); sh(x, '#2f4f9a', LW2 + 1); rr(x, lx - 8, h - 50, 72, 50, 18); sh(x, '#2b1f1a', LW2); }
    // 身体
    const body = () => { rr(x, 92, h * .4, 196, h * .34, 40); };
    crescent(x, body, '#a92f28', 28, 0, coat); body(); sh(x, null, LW);
    x.beginPath(); x.moveTo(105, h * .43); x.lineTo(270, h * .7); x.moveTo(275, h * .43); x.lineTo(110, h * .7); x.lineWidth = 16; x.strokeStyle = '#fff6e6'; x.stroke();
    for (let i = 0; i < 3; i++) { x.beginPath(); x.arc(190, h * (.47 + i * .08), 8, 0, TAU); x.fillStyle = C.gold; x.fill(); }
    // 手臂（握矛）
    rr(x, 262, h * .43, 44, h * .2, 20); sh(x, coat, LW2 + 1); x.beginPath(); x.arc(296, h * .62, 22, 0, TAU); sh(x, '#ffe2bd', LW2);
    rr(x, 72, h * .43, 44, h * .25, 20); sh(x, coat, LW2 + 1); x.beginPath(); x.arc(94, h * .69, 22, 0, TAU); sh(x, '#ffe2bd', LW2);
    // 头
    const hd = () => { x.beginPath(); x.ellipse(190, h * .33, 74, 70, 0, 0, TAU); };
    crescent(x, hd, '#f3c393', 16, 12, '#ffe2bd'); hd(); sh(x, null, LW);
    x.fillStyle = INK; for (const ex of [162, 218]) { x.beginPath(); x.ellipse(ex, h * .33, 9, 14, 0, 0, TAU); x.fill(); }
    x.beginPath(); x.ellipse(146, h * .365, 14, 9, 0, 0, TAU); x.fillStyle = 'rgba(255,110,110,.5)'; x.fill(); x.beginPath(); x.ellipse(234, h * .365, 14, 9, 0, 0, TAU); x.fill();
    x.beginPath(); x.moveTo(172, h * .375); x.quadraticCurveTo(190, h * .395, 208, h * .375); x.lineWidth = 6; x.strokeStyle = INK; x.lineCap = 'round'; x.stroke();
    // 高帽 + 羽
    const hat = () => { x.beginPath(); x.moveTo(118, h * .29); x.lineTo(128, h * .1); x.quadraticCurveTo(190, h * .06, 252, h * .1); x.lineTo(262, h * .29); x.closePath(); };
    crescent(x, hat, '#14204a', 20, 0, '#24336e'); hat(); sh(x, null, LW);
    rr(x, 112, h * .27, 156, 30, 10); sh(x, C.gold, LW2);
    blob(x, 200, h * .07, 30, 46, .1, seed); sh(x, '#fff6e6', LW2);
  }, { border: 14 });
}

// ---------- 拉片 ----------
export function pullTab(wm, hm) {
  return cut(wm, hm, (x, W, H) => {
    const p = () => { x.beginPath(); x.moveTo(0, H * .15); x.lineTo(W * .72, H * .15); x.quadraticCurveTo(W, H * .15, W, H * .5); x.quadraticCurveTo(W, H * .85, W * .72, H * .85); x.lineTo(0, H * .85); x.closePath(); };
    crescent(x, p, '#c73a30', 0, 18, C.red); p(); sh(x, null, LW);
    x.save(); x.translate(W * .72, H * .5); x.rotate(-Math.PI / 2); x.fillStyle = '#fff6e6'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `400 ${Math.round(H * .56)}px "ZCOOL KuaiLe"`; x.fillText('拉', 0, 4); x.restore();
    x.beginPath(); x.moveTo(W * .12, H * .5); x.lineTo(W * .46, H * .5); x.moveTo(W * .36, H * .36); x.lineTo(W * .48, H * .5); x.lineTo(W * .36, H * .64); x.lineWidth = 10; x.strokeStyle = '#fff6e6'; x.lineCap = 'round'; x.lineJoin = 'round'; x.stroke();
  }, { border: 12, ax: 0, ay: .5 });
}

// ---------- 月亮（竹签上） ----------
export function moonStick(rm, stickm) {
  return cut(rm * 2.2, rm * 2.2 + stickm, (x, W, H) => {
    const r = rm * PPM, cx = W / 2, cy = r * 1.1;
    x.fillStyle = '#c9a26a'; x.fillRect(cx - 9, cy, 18, H - cy); x.strokeStyle = INK; x.lineWidth = LW2; x.strokeRect(cx - 9, cy, 18, H - cy);
    const p = () => { x.beginPath(); x.arc(cx, cy, r, 0, TAU); };
    crescent(x, p, '#f2c24a', -r * .25, -r * .2, '#fff1b0'); p(); sh(x, null, LW);
    x.fillStyle = 'rgba(220,170,70,.5)'; for (const [a, b, s] of [[-.3, -.2, .18], [.25, .2, .13], [.1, -.45, .1]]) { x.beginPath(); x.arc(cx + a * r, cy + b * r, s * r, 0, TAU); x.fill(); }
    x.fillStyle = INK; x.beginPath(); x.ellipse(cx - r * .25, cy - r * .05, 9, 14, 0, 0, TAU); x.fill(); x.beginPath(); x.ellipse(cx + r * .2, cy - r * .05, 9, 14, 0, 0, TAU); x.fill();
    x.beginPath(); x.moveTo(cx - r * .14, cy + r * .2); x.quadraticCurveTo(cx, cy + r * .32, cx + r * .1, cy + r * .2); x.lineWidth = 6; x.strokeStyle = INK; x.stroke();
  }, { border: 12 });
}

// ---------- 纸烟花 ----------
export function burst(rm, cols, seed, rays = 14) {
  return cut(rm * 2, rm * 2, (x, W, H) => {
    const R = mulberry(seed), cx = W / 2, cy = H / 2, r = W / 2;
    for (let i = 0; i < rays; i++) {
      const a = i / rays * TAU + R() * .1, col = cols[i % cols.length], l = r * (.78 + R() * .22);
      x.save(); x.translate(cx, cy); x.rotate(a);
      x.beginPath(); x.moveTo(r * .16, -r * .045); x.lineTo(l * .86, -r * .02); x.lineTo(l * .86, r * .02); x.lineTo(r * .16, r * .045); x.closePath(); sh(x, col, LW2 + 1);
      x.beginPath(); for (let k = 0; k < 10; k++) { const aa = k / 10 * TAU, rr2 = k % 2 ? r * .045 : r * .1; x.lineTo(l * .9 + Math.cos(aa) * rr2, Math.sin(aa) * rr2); } x.closePath(); sh(x, cols[(i + 1) % cols.length], LW2);
      x.restore();
    }
    x.beginPath(); for (let k = 0; k < 16; k++) { const aa = k / 16 * TAU, rr2 = k % 2 ? r * .1 : r * .2; x.lineTo(cx + Math.cos(aa) * rr2, cy + Math.sin(aa) * rr2); } x.closePath(); sh(x, '#fff3b0', LW);
  }, { border: 12, ay: .5 });
}
export function sparkCard(rm, col) {
  return cut(rm * 2, rm * 2, (x, W, H) => {
    const cx = W / 2, cy = H / 2, r = W / 2;
    x.beginPath(); for (let k = 0; k < 10; k++) { const aa = k / 10 * TAU - Math.PI / 2, rr2 = k % 2 ? r * .42 : r; x.lineTo(cx + Math.cos(aa) * rr2, cy + Math.sin(aa) * rr2); } x.closePath(); sh(x, col, LW2 + 1);
  }, { border: 10, ay: .5 });
}

// ---------- 纸龙 ----------
// 头（侧面，朝 +x）。p = {mouth 0..1, look [-1..1, -1..1], blink 0..1}
export const DH_W = 1000, DH_H = 760;
export function drawDragonHead(x, p = {}) {
  const { mouth = 0, look = [0, 0], blink = 0 } = p;
  x.clearRect(0, 0, DH_W, DH_H);
  const Wc = cv(DH_W, DH_H), a = Wc.getContext('2d');
  a.translate(40, 40); a.lineJoin = 'round'; a.lineCap = 'round';
  // 鬃毛（金色火焰形）
  const mane = () => { a.beginPath(); a.moveTo(250, 120); for (let i = 0; i < 6; i++) { const ang = Math.PI * (.95 + i * .13); a.quadraticCurveTo(230 + Math.cos(ang - .2) * 260, 340 + Math.sin(ang - .2) * 260, 230 + Math.cos(ang) * (300 + (i % 2) * 40), 340 + Math.sin(ang) * (300 + (i % 2) * 40)); a.lineTo(230 + Math.cos(ang + .08) * 170, 340 + Math.sin(ang + .08) * 170); } a.lineTo(120, 600); a.closePath(); };
  crescent(a, mane, C.goldS, 20, 26, C.gold); mane(); sh(a, null, LW);
  // 角
  for (const [bx, by, k] of [[330, 150, 1], [270, 170, .8]]) { a.beginPath(); a.moveTo(bx, by); a.quadraticCurveTo(bx - 60 * k, by - 120 * k, bx - 170 * k, by - 150 * k); a.quadraticCurveTo(bx - 90 * k, by - 80 * k, bx - 40 * k, by + 20); a.closePath(); sh(a, '#fff1c8', LW2 + 2); a.beginPath(); a.moveTo(bx - 30 * k, by - 40 * k); a.lineTo(bx - 60 * k, by - 30 * k); a.moveTo(bx - 70 * k, by - 80 * k); a.lineTo(bx - 100 * k, by - 70 * k); a.lineWidth = 4; a.strokeStyle = '#c9a36a'; a.stroke(); }
  // 下颌（张嘴时下转）
  const jo = mouth * .55;
  a.save(); a.translate(330, 450); a.rotate(jo);
  const jaw = () => { a.beginPath(); a.moveTo(0, -30); a.quadraticCurveTo(220, -20, 470, 0); a.quadraticCurveTo(500, 40, 450, 70); a.quadraticCurveTo(220, 110, -20, 80); a.closePath(); };
  crescent(a, jaw, C.bellyS, 0, -24, C.belly); jaw(); sh(a, null, LW);
  for (let i = 0; i < 4; i++) { a.beginPath(); a.moveTo(190 + i * 70, -14); a.lineTo(212 + i * 70, -56); a.lineTo(234 + i * 70, -12); a.closePath(); sh(a, '#fffdf2', 4); }
  a.restore();
  if (mouth > .05) { a.save(); a.beginPath(); a.moveTo(340, 430); a.quadraticCurveTo(600, 420 + mouth * 60, 790, 440 + mouth * 160); a.lineTo(760, 470 + mouth * 220); a.quadraticCurveTo(560, 460 + mouth * 150, 340, 470); a.closePath(); a.fillStyle = '#7a1f22'; a.fill(); a.restore(); }
  // 头 + 上颌
  const head = () => { a.beginPath(); a.moveTo(140, 300); a.quadraticCurveTo(200, 150, 380, 170); a.quadraticCurveTo(520, 180, 620, 260); a.quadraticCurveTo(760, 280, 860, 330); a.quadraticCurveTo(920, 380, 880, 430); a.quadraticCurveTo(700, 450, 520, 445); a.quadraticCurveTo(330, 470, 220, 520); a.quadraticCurveTo(110, 470, 140, 300); a.closePath(); };
  crescent(a, head, C.redS, 0, 40, C.red); head(); sh(a, null, LW + 1);
  // 上牙
  for (let i = 0; i < 4; i++) { a.beginPath(); a.moveTo(560 + i * 80, 438); a.lineTo(582 + i * 80, 482); a.lineTo(604 + i * 80, 436); a.closePath(); sh(a, '#fffdf2', 4); }
  // 鼻孔 + 鼻头
  a.beginPath(); a.ellipse(845, 345, 26, 18, -.3, 0, TAU); sh(a, C.redS, LW2); a.beginPath(); a.ellipse(845, 345, 9, 7, -.3, 0, TAU); a.fillStyle = INK; a.fill();
  // 金色鳞纹 + 眉
  a.strokeStyle = C.gold; a.lineWidth = 9; for (let i = 0; i < 3; i++) { a.beginPath(); a.arc(250 + i * 70, 400, 34, Math.PI * 1.1, Math.PI * 1.9); a.stroke(); }
  // 胡须（卷）
  a.lineWidth = 8; a.strokeStyle = INK;
  a.beginPath(); a.moveTo(830, 380); a.bezierCurveTo(900, 420, 960, 360, 940, 300); a.bezierCurveTo(925, 260, 880, 290, 905, 315); a.stroke();
  a.beginPath(); a.moveTo(800, 395); a.bezierCurveTo(840, 470, 760, 520, 720, 480); a.stroke();
  // 眼睛（大、朝镜头时瞳孔偏移）
  const ex = 470, ey = 285;
  a.beginPath(); a.ellipse(ex, ey, 92, 86, 0, 0, TAU); sh(a, '#fffdf7', LW);
  if (blink > .6) { a.beginPath(); a.moveTo(ex - 80, ey + 6); a.quadraticCurveTo(ex, ey + 50, ex + 80, ey + 6); a.lineWidth = 12; a.strokeStyle = INK; a.stroke(); a.beginPath(); a.ellipse(ex, ey, 92, 86, 0, Math.PI * 1.02, Math.PI * 1.98); a.fillStyle = C.red; a.fill(); a.lineWidth = LW; a.stroke(); }
  else {
    const lx = ex + look[0] * 30, ly = ey + look[1] * 26, k = 1 - blink;
    a.beginPath(); a.ellipse(lx, ly, 50, 58 * k, 0, 0, TAU); a.fillStyle = INK; a.fill();
    a.beginPath(); a.ellipse(lx - 16, ly - 22 * k, 16, 20 * k, -.2, 0, TAU); a.fillStyle = '#fff'; a.fill();
    a.beginPath(); a.ellipse(lx + 18, ly + 22 * k, 7, 9 * k, 0, 0, TAU); a.fill();
  }
  a.beginPath(); a.moveTo(ex - 100, ey - 110); a.quadraticCurveTo(ex, ey - 150, ex + 110, ey - 96); a.lineWidth = 16; a.strokeStyle = C.gold; a.stroke(); a.lineWidth = 6; a.strokeStyle = INK; a.stroke();
  x.drawImage(finishCut(Wc, 16), 0, 0);
}
// 身体一节（中心锚点）：k = 0..1 从颈到尾逐渐变细；leg 是否带爪
export function dragonSeg(lenm, hm, k, leg, seed) {
  return cut(lenm, hm * 1.5, (x, W, H) => {
    const bh = H / 1.5 * (1 - k * .45), cy = H * .55, R = mulberry(seed);
    // 背鳍
    const fin = () => { x.beginPath(); x.moveTo(-10, cy - bh * .4); for (let i = 0; i < 3; i++) { const a = W * i / 3, b = W * (i + 1) / 3; x.lineTo((a + b) / 2 - 8, cy - bh * .5 - bh * (.55 + R() * .2)); x.lineTo(b, cy - bh * .42); } x.lineTo(W + 10, cy); x.lineTo(-10, cy); x.closePath(); };
    crescent(x, fin, C.goldS, 14, 0, C.gold); fin(); sh(x, null, LW2 + 2);
    if (leg) { // 小爪
      x.beginPath(); x.moveTo(W * .35, cy + bh * .3); x.quadraticCurveTo(W * .3, cy + bh * .95, W * .2, cy + bh * 1.05); x.lineTo(W * .62, cy + bh * 1.02); x.quadraticCurveTo(W * .55, cy + bh * .8, W * .62, cy + bh * .3); x.closePath(); sh(x, C.red, LW2 + 2);
      for (let i = 0; i < 3; i++) { x.beginPath(); x.moveTo(W * (.24 + i * .14), cy + bh * 1.03); x.lineTo(W * (.2 + i * .14), cy + bh * 1.22); x.lineWidth = 9; x.strokeStyle = '#fff1c8'; x.stroke(); x.lineWidth = 3; x.strokeStyle = INK; x.stroke(); }
    }
    const body = () => { x.beginPath(); x.ellipse(W / 2, cy, W * .56, bh / 2, 0, 0, TAU); };
    crescent(x, body, C.redS, 0, bh * .14, C.red);
    x.save(); body(); x.clip(); x.fillStyle = C.belly; x.fillRect(-20, cy + bh * .16, W + 40, bh); x.strokeStyle = C.bellyS; x.lineWidth = 5; for (let i = 0; i < 4; i++) { x.beginPath(); x.moveTo(W * (i + .5) / 4, cy + bh * .18); x.lineTo(W * (i + .5) / 4, cy + bh * .6); x.stroke(); } x.restore();
    body(); sh(x, null, LW);
    x.strokeStyle = C.gold; x.lineWidth = 7; for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { x.beginPath(); x.arc(W * (.2 + i * .3 + j * .15), cy - bh * .18 + j * bh * .16, bh * .14, Math.PI * .1, Math.PI * .9); x.stroke(); }
  }, { border: 14, ay: .55 });
}
export function dragonTail(lenm, hm) {
  return cut(lenm, hm * 2, (x, W, H) => {
    const cy = H * .55, bh = H / 2 * .5;
    const tuft = () => { x.beginPath(); x.moveTo(W * .1, cy); x.quadraticCurveTo(W * .3, cy - H * .5, W * .02, cy - H * .52); x.quadraticCurveTo(W * .25, cy - H * .25, -10, cy - H * .2); x.quadraticCurveTo(W * .18, cy - H * .05, -16, cy + H * .1); x.quadraticCurveTo(W * .2, cy + H * .16, W * .1, cy + H * .35); x.quadraticCurveTo(W * .3, cy + H * .2, W * .35, cy); x.closePath(); };
    crescent(x, tuft, C.goldS, 14, 10, C.gold); tuft(); sh(x, null, LW);
    const body = () => { x.beginPath(); x.moveTo(W, cy - bh * .5); x.quadraticCurveTo(W * .5, cy - bh * .5, W * .2, cy); x.quadraticCurveTo(W * .5, cy + bh * .5, W, cy + bh * .5); x.closePath(); };
    crescent(x, body, C.redS, 0, 10, C.red); body(); sh(x, null, LW);
  }, { border: 14, ax: .92, ay: .55 });
}
// 小纸翼（铰链在底边）
export function dragonWing(wm, hm) {
  return cut(wm, hm, (x, W, H) => {
    const p = () => { x.beginPath(); x.moveTo(0, H); x.quadraticCurveTo(W * .1, H * .2, W * .55, 0); x.quadraticCurveTo(W * .5, H * .3, W * .78, H * .28); x.quadraticCurveTo(W * .7, H * .55, W, H * .6); x.quadraticCurveTo(W * .8, H * .85, W * .9, H); x.closePath(); };
    crescent(x, p, '#d9e9f2', 0, 20, '#fff7e8'); p(); sh(x, null, LW2 + 2);
    x.strokeStyle = '#c9a36a'; x.lineWidth = 5; x.beginPath(); x.moveTo(W * .1, H); x.lineTo(W * .52, H * .08); x.moveTo(W * .2, H); x.lineTo(W * .74, H * .32); x.moveTo(W * .35, H); x.lineTo(W * .92, H * .64); x.stroke();
  }, { border: 12 });
}

// ---------- 页面（2048 × 1396） ----------
export const PW = 2048, PH = 1396;
export const BWm = .44, BDm = .30;
export const gx = xm => (xm / BWm + .5) * PW, gz = zm => zm / BDm * PH;
function page(fn, ga = .7) { const c = cv(PW, PH), x = c.getContext('2d'); fn(x); x.save(); x.globalAlpha = ga; x.fillStyle = x.createPattern(GRAIN, 'repeat'); x.fillRect(0, 0, PW, PH); x.restore(); return c; }
function grad(x, stops) { const g = x.createLinearGradient(0, 0, 0, PH); stops.forEach(([o, c]) => g.addColorStop(o, c)); x.fillStyle = g; x.fillRect(0, 0, PW, PH); }
function clouds(x, seed, col, n, y0, y1) { const R = mulberry(seed); for (let i = 0; i < n; i++) { const cx = R() * PW, cy = PH * (y0 + R() * (y1 - y0)), w = 180 + R() * 260; x.fillStyle = col; for (let k = 0; k < 5; k++) { x.beginPath(); x.ellipse(cx + (k - 2) * w * .22, cy - Math.sin(k / 4 * Math.PI) * w * .12, w * .2, w * .13, 0, 0, TAU); x.fill(); } } }
function mountains(x, col, seed, base, amp) { const R = mulberry(seed); x.beginPath(); x.moveTo(0, PH); x.lineTo(0, PH * base); for (let i = 0; i <= 8; i++) x.lineTo(PW * i / 8, PH * (base - amp * (i % 2 ? .9 + R() * .3 : .2 + R() * .3))); x.lineTo(PW, PH); x.closePath(); x.fillStyle = col; x.fill(); }
export function pages() {
  const P = {};
  P.skyDay = page(x => { grad(x, [[0, '#7cc4ee'], [.72, C.sky1], [1, '#eef8e8']]); clouds(x, 3, 'rgba(255,255,255,.6)', 7, .1, .5); mountains(x, 'rgba(150,200,190,.55)', 4, .95, .18); });
  P.groundDay = page(x => {
    grad(x, [[0, '#8ccb6b'], [1, '#a4d97f']]);
    // 护城河
    x.fillStyle = '#4c9fd6'; x.beginPath(); x.moveTo(0, gz(.108)); for (let i = 0; i <= 16; i++) x.lineTo(PW * i / 16, gz(.108) + Math.sin(i * 1.7) * 8); for (let i = 16; i >= 0; i--) x.lineTo(PW * i / 16, gz(.146) + Math.sin(i * 1.3) * 8); x.closePath(); x.fill();
    x.strokeStyle = 'rgba(255,255,255,.5)'; x.lineWidth = 6; for (let i = 0; i < 22; i++) { const px = PW * i / 22 + 20; x.beginPath(); x.moveTo(px, gz(.127)); x.quadraticCurveTo(px + 22, gz(.122), px + 44, gz(.127)); x.stroke(); }
    // 石板路
    x.fillStyle = '#ecd49a'; x.beginPath(); x.moveTo(gx(-.022), gz(.146)); x.lineTo(gx(.022), gz(.146)); x.lineTo(gx(.05), gz(.3)); x.lineTo(gx(-.05), gz(.3)); x.closePath(); x.fill();
    const R = mulberry(5); for (let i = 0; i < 160; i++) { x.beginPath(); x.arc(R() * PW, R() * PH, 5 + R() * 5, 0, TAU); x.fillStyle = ['#ffffff', '#ffe066', '#ff9ec1'][i % 3]; x.fill(); }
  });
  P.skyNight = page(x => {
    grad(x, [[0, C.nsky0], [.7, '#2c3a75'], [1, C.nsky1]]);
    const R = mulberry(21); for (let i = 0; i < 240; i++) { x.beginPath(); x.arc(R() * PW, R() * PH * .85, .8 + R() * 2.6, 0, TAU); x.fillStyle = `rgba(255,248,220,${.3 + R() * .6})`; x.fill(); }
    x.save(); x.globalAlpha = .12; x.fillStyle = '#c8d4ff'; x.beginPath(); x.ellipse(PW * .5, PH * .35, PW * .6, 90, -.2, 0, TAU); x.fill(); x.restore();
    mountains(x, 'rgba(40,50,100,.8)', 8, .95, .16);
  }, .3);
  P.groundNight = page(x => {
    grad(x, [[0, '#26345f'], [1, '#33437a']]);
    x.fillStyle = '#1d2c58'; x.beginPath(); x.moveTo(0, gz(.108)); for (let i = 0; i <= 16; i++) x.lineTo(PW * i / 16, gz(.108) + Math.sin(i * 1.7) * 8); for (let i = 16; i >= 0; i--) x.lineTo(PW * i / 16, gz(.146) + Math.sin(i * 1.3) * 8); x.closePath(); x.fill();
    const R = mulberry(15); for (let i = 0; i < 120; i++) { x.beginPath(); x.arc(R() * PW, R() * PH, 2 + R() * 4, 0, TAU); x.fillStyle = `rgba(255,236,160,${.25 + R() * .4})`; x.fill(); }
  }, .3);
  return P;
}
