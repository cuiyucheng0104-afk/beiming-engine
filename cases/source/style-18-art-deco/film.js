// 《落成之夜》画面：render(t) 完全由 t 决定（无 Math.random / Date.now）。
// 时间全部来自 timeline.js（拍），世界 → 屏幕只经过一个针孔相机（cam）。
import * as D from './engine/deco.js';
import * as TY from './engine/type.js';
import { B, DUR, HIT, FLOORS, SPARKS } from './timeline.js';
const { C, clamp, lerp, seg, ss, eio, eo, ei, hash, mix, rgba, gline, glow, sparkle, toPath, goldGrad } = D;
export { DUR };
const W = 1920, H = 1080, TAU = Math.PI * 2, PI = Math.PI;
const bt = b => b * B;
// 色板：暖漆黑 / 金 / 象牙 + 唯一强调色珊瑚 + 次要宝蓝
const K = {
  coral: '#e8553e', coralL: '#ff9a78', coralD: '#6e1d12',
  sapph: '#1f3e7a', sapphD: '#0b1730', sapphL: '#4467a6',
  lac: '#0b0805', lac2: '#17110a', wall: '#100b07',
  skyTop: '#0a0705', skyMid: '#120d0a', skyHor: '#112039',
};
const CJK = "'ZCOOL XiaoWei'";

// ---------------- 针孔相机（世界：x 右，y 上，z 前，单位米） ----------------
function cam({ x = 0, y = 1.6, z = 0, pitch = 0, f = 1000, ox = W / 2, oy = H / 2 } = {}) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const view = (X, Y, Z) => { const dx = X - x, dy = Y - y, dz = Z - z; return [dx, dy * cp - dz * sp, dy * sp + dz * cp]; };
  const proj = v => [ox + v[0] * f / v[2], oy - v[1] * f / v[2]];
  const P = (X, Y, Z) => { const v = view(X, Y, Z); return proj([v[0], v[1], Math.max(v[2], .01)]); };
  const depth = (X, Y, Z) => view(X, Y, Z)[2];
  const scaleAt = (X, Y, Z) => f / Math.max(depth(X, Y, Z), .01);
  // 无穷远方向（仰角 e，方位 a）
  const dirP = (e, a = 0) => P(x + Math.sin(a) * Math.cos(e) * 1e5, y + Math.sin(e) * 1e5, z + Math.cos(a) * Math.cos(e) * 1e5);
  return { x, y, z, pitch, f, ox, oy, view, proj, P, depth, scaleAt, dirP };
}
const NEAR = .08;
function runs3(c, pts) {               // 3D 折线 → 近裁剪后的 2D 段
  const out = []; let cur = []; let pv = null;
  for (const p of pts) {
    const v = c.view(p[0], p[1], p[2]);
    if (pv) {
      const ai = pv[2] > NEAR, bi = v[2] > NEAR;
      if (ai && bi) { if (!cur.length) cur.push(c.proj(pv)); cur.push(c.proj(v)); }
      else if (ai !== bi) {
        const k = (pv[2] - NEAR) / (pv[2] - v[2]), m = [lerp(pv[0], v[0], k), lerp(pv[1], v[1], k), NEAR];
        if (ai) { if (!cur.length) cur.push(c.proj(pv)); cur.push(c.proj(m)); out.push(cur); cur = []; }
        else cur = [c.proj(m), c.proj(v)];
      }
    }
    pv = v;
  }
  if (cur.length > 1) out.push(cur);
  return out;
}
function poly3(c, pts) {               // 3D 多边形 → 近裁剪后的 2D 多边形
  const V = pts.map(p => c.view(p[0], p[1], p[2])), out = [];
  for (let i = 0; i < V.length; i++) {
    const a = V[i], b = V[(i + 1) % V.length], ai = a[2] > NEAR, bi = b[2] > NEAR;
    if (ai) out.push(a);
    if (ai !== bi) { const k = (a[2] - NEAR) / (a[2] - b[2]); out.push([lerp(a[0], b[0], k), lerp(a[1], b[1], k), NEAR]); }
  }
  return out.length >= 3 ? out.map(v => c.proj(v)) : null;
}
const len3 = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]); return L; };
function part3(pts, f) {               // 3D 折线前段（金线自绘）
  if (f >= 1) return pts; if (f <= 0) return [pts[0], pts[0]];
  const L = len3(pts) * f; let acc = 0; const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (acc + d >= L) { const k = (L - acc) / (d || 1); out.push([lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]); return out; }
    acc += d; out.push(b);
  }
  return out;
}
function gl3(g, c, pts, o = {}) { const p = o.part3 != null ? part3(pts, o.part3) : pts; for (const r of runs3(c, p)) gline(g, r, o); }
function fill3(g, c, pts, style, alpha = 1) { const q = poly3(c, pts); if (!q) return null; g.save(); g.globalAlpha *= alpha; g.fillStyle = style; g.fill(toPath(q, true)); g.restore(); return q; }
function bbox(q) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [x, y] of q) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; }
function air3(g, c, pts, o, alpha = 1) {   // 硬边 + 喷枪渐变（光从左上）
  const q = poly3(c, pts); if (!q) return null;
  g.save(); g.globalAlpha *= alpha; D.airbrush(g, q, { dir: -2.3, ...o }); g.restore(); return q;
}

// ---------------- 小部件 ----------------
function ignite(t, t0, fl = .18) { if (t < t0) return 0; const d = t - t0; let v = d < fl ? 1 + .6 * (1 - d / fl) : 1; if (d < .04) v *= .3 + .7 * d / .04; return v; }
function bulb(g, x, y, r, v, color = null) {
  if (r < .6) return;
  g.beginPath(); g.arc(x, y, r * 1.3, 0, TAU); g.fillStyle = '#2a1d0c'; g.fill();
  g.lineWidth = Math.max(1, r * .22); g.strokeStyle = v > .05 ? C.gold2 : '#7a5e2a'; g.stroke();
  if (v <= .02) {
    const gr = g.createRadialGradient(x - r * .35, y - r * .35, 0, x, y, r); gr.addColorStop(0, '#4a3a2c'); gr.addColorStop(.5, '#1c1510'); gr.addColorStop(1, '#0b0806');
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = gr; g.fill(); return;
  }
  const vv = clamp(v, 0, 1.6), m = Math.min(1, vv), rgb = color ? hexRGB(color) : C.bulbGlow;
  g.save(); g.globalCompositeOperation = 'lighter';
  const hr = r * (3.4 + 2 * Math.max(0, vv - 1));
  const gr = g.createRadialGradient(x, y, 0, x, y, hr); gr.addColorStop(0, `rgba(${rgb},${.55 * m})`); gr.addColorStop(.35, `rgba(${rgb},${.16 * m})`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(x - hr, y - hr, hr * 2, hr * 2); g.restore();
  const cr = g.createRadialGradient(x, y, 0, x, y, r), core = color ? mix(color, '#ffffff', .7) : C.bulbCore, mid = color || C.bulb;
  cr.addColorStop(0, core); cr.addColorStop(.55, mix('#3a2a18', mid, m)); cr.addColorStop(1, mix('#1a120a', mix(mid, '#b06a20', .5), m));
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = cr; g.fill();
}
function hexRGB(h) { const n = parseInt(h.slice(1), 16); return `${n >> 16 & 255},${n >> 8 & 255},${n & 255}`; }
function plaquePts(cx, cy, w, h, step = .18) {
  const hw = w / 2, hh = h / 2, s = h * step;
  return [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy - hh + s], [cx + hw + s, cy - hh + s], [cx + hw + s, cy - hh + 2 * s], [cx + hw + 2 * s, cy - hh + 2 * s],
  [cx + hw + 2 * s, cy + hh - 2 * s], [cx + hw + s, cy + hh - 2 * s], [cx + hw + s, cy + hh - s], [cx + hw, cy + hh - s], [cx + hw, cy + hh],
  [cx - hw, cy + hh], [cx - hw, cy + hh - s], [cx - hw - s, cy + hh - s], [cx - hw - s, cy + hh - 2 * s], [cx - hw - 2 * s, cy + hh - 2 * s],
  [cx - hw - 2 * s, cy - hh + 2 * s], [cx - hw - s, cy - hh + 2 * s], [cx - hw - s, cy - hh + s], [cx - hw, cy - hh + s], [cx - hw, cy - hh]];
}
// 中心展开的漆黑铭牌（标题、字幕、转场同一语法：点 → 发丝线 → 上下分开 → 字升起）
function plaque(g, text, cx, cy, size, p, { font = CJK, track = .25, glowK = 1, sheen = .4 } = {}) {
  if (p <= 0) return;
  g.save(); g.font = `${size}px ${font}`; if ('letterSpacing' in g) g.letterSpacing = `${size * track}px`;
  const tw = g.measureText(text).width; g.restore();
  const Wd = tw + size * 1.6, Ht = size * 1.55;
  const lineP = ss(seg(p, 0, .35)), open = eio(seg(p, .2, .62)), txt = ss(seg(p, .45, .9));
  if (open < .98) { glow(g, cx, cy, size * 3 * lineP, '#ffcf7a', .3 * glowK * (1 - open)); gline(g, [[cx - Wd * .55 * lineP, cy], [cx + Wd * .55 * lineP, cy]], { w: 2, glow: .7 * (1 - open) }); }
  if (open > 0) {
    const hh = Ht / 2 * open, pts = plaquePts(cx, cy, Wd, hh * 2, .16);
    const gr = g.createLinearGradient(0, cy - hh, 0, cy + hh); gr.addColorStop(0, '#1a140c'); gr.addColorStop(.5, '#050403'); gr.addColorStop(1, '#1a140c');
    g.fillStyle = gr; g.fill(toPath(pts, true));
    gline(g, pts, { w: Math.max(1.4, size * .045), closed: true, bb: [cx - Wd / 2, cy - hh, cx + Wd / 2, cy + hh], sheen });
    if (hh > 10) gline(g, plaquePts(cx, cy, Wd - size * .3, hh * 2 - size * .3, .16), { w: Math.max(.8, size * .018), closed: true, bb: [cx - Wd / 2, cy - hh, cx + Wd / 2, cy + hh], sheen: sheen + .2 });
  }
  if (txt > 0) {
    g.save(); const hh = Ht / 2 * open; g.beginPath(); g.rect(cx - Wd, cy - hh + 2, Wd * 2, Math.max(0, hh * 2 - 4)); g.clip();
    g.font = `${size}px ${font}`; if ('letterSpacing' in g) g.letterSpacing = `${size * track}px`;
    g.textBaseline = 'middle'; g.textAlign = 'left';
    const x0 = cx - (tw - size * track) / 2, y = cy + size * .04 + (1 - txt) * size * .5;
    g.globalAlpha *= txt; g.fillStyle = 'rgba(0,0,0,.6)'; g.fillText(text, x0 + size * .03, y + size * .04);
    g.fillStyle = mix(C.ivory, '#ffffff', .1); g.fillText(text, x0, y);
    g.restore();
  }
  return { w: Wd, h: Ht };
}

// ---------------- 天空 / 城市 ----------------
function sky(g, c, { lift = 1, burst = null } = {}) {
  const hz = c.dirP(0)[1];                       // 地平线在屏幕上的 y
  const top = c.dirP(1.2)[1];
  const gr = g.createLinearGradient(0, Math.min(top, hz - 10), 0, hz);
  gr.addColorStop(0, K.skyTop); gr.addColorStop(.5, K.skyMid); gr.addColorStop(.92, mix(K.skyMid, K.skyHor, .35)); gr.addColorStop(1, K.skyHor);   // 暖漆黑为主，只在地平线留一条深宝蓝
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  if (hz < H) { const g2 = g.createLinearGradient(0, hz, 0, hz + 400); g2.addColorStop(0, '#15110d'); g2.addColorStop(1, '#0a0705'); g.fillStyle = g2; g.fillRect(0, hz, W, H - hz); }
  // 极淡的日芒楔（装饰底纹，也避免全黑帧）
  const sb = c.dirP(.9);
  D.sunburst(g, sb[0], sb[1], { rays: 56, r0: 0, r1: 2600, mode: 'wedges', colorA: `rgba(201,162,75,${.035 * lift})` });
  // 星：固定在无穷远的方向上，随俯仰移动
  for (let i = 0; i < 140; i++) {
    const a = (hash(i * 3.7) - .5) * 1.6, e = .03 + hash(i * 9.1) * 1.1;
    const p = c.dirP(e, a); if (p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H) continue;
    const tw = .5 + .5 * Math.sin(i * 1.7 + 0);
    if (i % 9 === 0) sparkle(g, p[0], p[1], 5 + 4 * hash(i), { alpha: .5 + .3 * tw, glow: 1 });
    else { g.fillStyle = `rgba(242,232,213,${.25 + .35 * hash(i * 2.3)})`; g.fillRect(p[0], p[1], 1.6, 1.6); }
  }
}
// 远处城市：对称成对的阶梯塔剪影（金色楼冠线 + 亮窗），塔顶高出视平线
const CITY = [[260, 2500, 235, 64, 3, 1], [560, 2700, 120, 110, 2, 0], [880, 2300, 175, 78, 3, 1], [1250, 2600, 95, 120, 2, 0], [1650, 2400, 150, 86, 3, 0], [2100, 2800, 70, 130, 2, 0]]
  .map(([x, z, h, w, st, sp]) => ({ x, z, h, w, st, sp }));
function city(g, c, eye) {
  for (const sgn of [-1, 1]) for (const T of CITY) {
    const x = sgn * T.x, top = eye + T.h, bot = -170, z = T.z, sh = T.h * .06;
    const pts = [[x - T.w / 2, bot, z]]; let hw = T.w / 2, yy = top - T.st * sh;
    pts.push([x - hw, yy, z]);
    for (let k = 0; k < T.st; k++) { hw *= .72; pts.push([x - hw / .72, yy, z], [x - hw, yy, z]); yy += sh; pts.push([x - hw, yy, z]); }
    const R = pts.slice(1).reverse().map(([px, py, pz]) => [2 * x - px, py, pz]);
    const poly = pts.concat(R).concat([[x + T.w / 2, bot, z]]);
    const q = air3(g, c, poly, { base: '#15100b', dark: '#060403', light: '#2b2116' }); if (!q) continue;
    gl3(g, c, poly.slice(1, -1), { w: 1, alpha: .35 });
    if (T.sp) gl3(g, c, [[x, top, z], [x, top + T.h * .25, z]], { w: 1.4, alpha: .8 });
    for (let k = 0; k < 30; k++) { const wy = top - T.st * sh - 6 - Math.floor(hash(k * 1.7 + T.x) * 30) * 8, wx = x + (Math.floor(hash(k * 3.1 + T.z) * 5) - 2) * T.w * .16; if (hash(k * 5.7 + T.x) > .45) { const p = c.P(wx, wy, z); g.fillStyle = 'rgba(255,214,140,.6)'; g.fillRect(p[0] - 1, p[1], 2.4, 3.2); } }
    const cp = c.P(x, top + 2, z); glow(g, cp[0], cp[1], 40, '#ffd28a', .18);
  }
  // 城市的地平光
  const hz = c.P(0, -170, 1400)[1];
  const gr = g.createLinearGradient(0, hz - 120, 0, hz + 40); gr.addColorStop(0, 'rgba(255,190,110,0)'); gr.addColorStop(1, 'rgba(255,190,110,.10)'); g.fillStyle = gr; g.fillRect(0, hz - 120, W, 160);
}

// ======================= 镜头 1：金线刻塔（b0–b10） =======================
const TW = { shaft: { w: 22, y0: 0, y1: 100, z: 70 }, sb: [{ w: 17, y0: 100, y1: 118, z: 73 }, { w: 12, y0: 118, y1: 132, z: 76 }, { w: 7.5, y0: 132, y1: 142, z: 79 }], crown: { y: 142, z: 79, r: 7.5 }, spire: [149.5, 178] };
const AXIS = [[0, 0, 70], [0, 100, 70], [0, 100, 73], [0, 118, 73], [0, 118, 76], [0, 132, 76], [0, 132, 79], [0, 178, 79]];
const axisFrac = b => Math.pow(seg(b, 0, 4), 2.1);           // 单簧管滑音：先慢后快，落在 b4
function axisTip(b) { const p = part3(AXIS, axisFrac(b)); return p[p.length - 1]; }
function towerCam(b) {
  let y = 1.6, z = 0, pitch, f;
  if (b < 4) {
    const u = eio(seg(b, 0, 4)); f = lerp(1150, 640, u); pitch = lerp(.12, .6, u);
    const tip = axisTip(b), ang = Math.atan2(tip[1] - y, tip[2] - z), hv = Math.atan(540 / f);
    pitch = Math.max(pitch, ang - hv * .85);
  } else if (b < 8) { const u = ss(seg(b, 4, 8)); f = lerp(640, 700, u); pitch = lerp(.6, .66, u); z = lerp(0, 5, u); }
  else { const u = eio(seg(b, 8, 10)); y = lerp(1.6, 144.6, u); z = lerp(5, 55, u); pitch = lerp(.66, 0, u); f = lerp(700, 1590, u); }
  return cam({ y, z, pitch, f });
}
function boxFace(w, y0, y1, z) { return [[-w, y0, z], [w, y0, z], [w, y1, z], [-w, y1, z]]; }
function shotTower(g, t) {
  const b = t / B, c = towerCam(b);
  sky(g, c, { lift: 1 });
  // 两侧对称的旧楼（暗，已存在的城市）
  for (const s of [-1, 1]) for (const [x0, x1, h, z] of [[30, 58, 78, 96], [60, 96, 112, 120], [100, 150, 64, 110]]) {
    const pts = [[s * x0, 0, z], [s * x0, h, z], [s * (x0 + 4), h, z], [s * (x0 + 4), h + 6, z], [s * (x1 - 4), h + 6, z], [s * (x1 - 4), h, z], [s * x1, h, z], [s * x1, 0, z]];
    air3(g, c, pts, { base: '#17110b', dark: '#070504', light: '#2f2417', dir: s < 0 ? -2.3 : -.84 });
    for (let k = 0; k < 40; k++) { const wx = s * lerp(x0 + 3, x1 - 3, hash(k * 1.3 + x0)), wy = 4 + hash(k * 7.1 + h) * (h - 8); if (hash(k * 3.3 + z) > .6) { const p = c.P(wx, wy, z), sc = c.scaleAt(wx, wy, z); g.fillStyle = 'rgba(255,210,140,.42)'; g.fillRect(p[0], p[1], Math.max(1.5, sc * 1.2), Math.max(2, sc * 1.8)); } }
  }
  // 探照灯（b4 随立面展开一起合闸）
  const sl = ignite(t, bt(HIT.unfold), .25);
  if (sl > 0) for (const s of [-1, 1]) {
    const a = c.P(s * 80, 0, 100), bq = c.P(0, 150, 79), ang = Math.atan2(bq[1] - a[1], bq[0] - a[0]);
    D.beam(g, a[0], a[1], ang + s * .03 * Math.sin(t * 1.3), 2600, 900, .09 * Math.min(1.3, sl), '#f2e6c4');
  }
  // 街面透视线（从中心向两侧）
  const gp = eo(seg(b, 0, 1.4));
  for (const x of [2.5, 7, 13, 22, 36, 60]) for (const s of [-1, 1]) gl3(g, c, [[s * x, 0, 70], [s * x * .35, 0, 8]], { w: 1.2, part3: gp, alpha: .55 });
  for (const z of [62, 52, 40, 28]) gl3(g, c, [[0, 0, z], [65, 0, z]], { w: 1, part3: gp, alpha: .35 }), gl3(g, c, [[0, 0, z], [-65, 0, z]], { w: 1, part3: gp, alpha: .35 });
  gl3(g, c, [[0, 0, 70], [200, 0, 70]], { w: 2.2, part3: eo(seg(b, 0, 1.2)), glow: .5 }); gl3(g, c, [[0, 0, 70], [-200, 0, 70]], { w: 2.2, part3: eo(seg(b, 0, 1.2)), glow: .5 });

  // ---- 塔身：由远及近（楼冠 → 退台 → 主干） ----
  const cr = TW.crown;
  const fillC = ss(seg(b, 9.5, 10));
  // 楼冠：半圆扇面，射线 中→两侧（b8, 8.5, 9, 9.5）
  if (b > 7.6) {
    const N = 9, ra = k => PI / 2 + (k - 4) * (PI / 9);
    const landB = k => [HIT.ray0, HIT.ray1, HIT.ray2, HIT.ray3, HIT.ray3][Math.abs(k - 4)];
    if (fillC > 0) { const fanPts = [[-cr.r, cr.y, cr.z]]; for (let i = 0; i <= 32; i++) { const a = PI - PI * i / 32; fanPts.push([Math.cos(a) * cr.r, cr.y + Math.sin(a) * cr.r, cr.z]); } air3(g, c, fanPts, { base: mix(K.sapph, K.lac, .35), dark: K.sapphD, light: K.sapph, rim: 2 }, fillC); }
    for (let k = 0; k < N; k++) {
      const lb = landB(k), p = eo(seg(b, lb - .35, lb)); if (p <= 0) continue;
      const a = ra(k), pts = [[Math.cos(a) * 1.2, cr.y + Math.sin(a) * 1.2, cr.z], [Math.cos(a) * cr.r, cr.y + Math.sin(a) * cr.r, cr.z]];
      gl3(g, c, pts, { w: 3, part3: p, glow: .9 * (1 - seg(b, lb, lb + .8)) + .2 });
      if (p >= 1) { const tp = c.P(...pts[1]), fl = 1 - seg(b, lb, lb + .4); if (fl > 0) { glow(g, tp[0], tp[1], 220 * fl, '#ffe2a0', .6 * fl); sparkle(g, tp[0], tp[1], 60 * fl, { alpha: fl }); } }
    }
    const ap = eo(seg(b, HIT.ray3 - .35, HIT.ray3));
    if (ap > 0) for (const rr of [cr.r, cr.r * .62, 1.2]) { const arc = []; for (let i = 0; i <= 40; i++) { const a = PI / 2 + (i / 40 - .5) * PI; arc.push([Math.cos(a) * rr, cr.y + Math.sin(a) * rr, cr.z]); } const mid = 20; gl3(g, c, arc.slice(mid).reverse().concat([]).reverse(), { w: 2.2, part3: ap }); gl3(g, c, arc.slice(0, mid + 1).reverse(), { w: 2.2, part3: ap }); }
    // 塔尖
    const spP = eo(seg(b, HIT.ray3 - .2, HIT.ray3 + .3));
    if (spP > 0) { gl3(g, c, [[0, TW.spire[0], cr.z], [0, TW.spire[1], cr.z]], { w: 3.2, part3: spP, glow: .6 }); if (spP >= 1) { const tp = c.P(0, TW.spire[1], cr.z); sparkle(g, tp[0], tp[1], 26 + 8 * Math.sin(t * 9), { alpha: .9 }); } }
  }
  // 三级退台：落在 b5 / b6 / b7
  for (let i = 2; i >= 0; i--) {
    const S = TW.sb[i], lb = [HIT.step1, HIT.step2, HIT.step3][i];
    const p = eio(seg(b, lb - .42, lb)); if (p <= 0) continue;
    const fl = ss(seg(b, lb, lb + .5));
    if (fl > 0) air3(g, c, boxFace(S.w, S.y0, S.y1, S.z), { base: '#1b140c', dark: '#070504', light: '#43321b', rim: 2.5 }, fl);
    // 退台轮廓：从中轴顶边向两侧，再落到底
    for (const s of [-1, 1]) gl3(g, c, [[0, S.y1, S.z], [s * S.w, S.y1, S.z], [s * S.w, S.y0, S.z]], { w: 2.8, part3: p, glow: .8 * (1 - seg(b, lb, lb + .6)) + .15 });
    if (p >= 1) {
      // 壁柱 + 扇形纹 + 人字纹
      for (const x of [S.w * .5, S.w * .8]) for (const s of [-1, 1]) gl3(g, c, [[s * x, S.y0, S.z], [s * x, S.y1 - 1.2, S.z]], { w: 1.4, part3: ss(seg(b, lb, lb + .4)) });
      const fp = ss(seg(b, lb, lb + .35));
      const fr = Math.min(S.w * .45, (S.y1 - S.y0) * .55);
      for (let k = 0; k <= 6; k++) { const a = PI * k / 6; gl3(g, c, [[0, S.y0 + 1, S.z], [Math.cos(a) * fr * fp, S.y0 + 1 + Math.sin(a) * fr * fp, S.z]], { w: 1.4 }); }
      const ch = []; for (let k = 0; k <= 10; k++) ch.push([-S.w + k * S.w / 5, S.y1 - 1.2 - (k % 2) * 1.2, S.z]);
      gl3(g, c, ch, { w: 1.2, part3: fp });
      const flash = 1 - seg(b, lb, lb + .4); if (flash > 0) { const q = c.P(0, S.y1, S.z); glow(g, q[0], q[1], 260 * flash + 60, '#ffd27a', .5 * flash); }
    }
  }
  // 主干
  const S = TW.shaft, up = eo(seg(b, HIT.unfold, HIT.unfold + .75)), sfill = ss(seg(b, 4.2, 5.2));
  if (sfill > 0) air3(g, c, boxFace(S.w, S.y0, S.y1, S.z), { base: '#18110b', dark: '#060403', light: '#3d2d19', rim: 3 }, sfill);
  // 侧翼裙楼
  if (sfill > 0) for (const s of [-1, 1]) air3(g, c, [[s * 22, 0, 74], [s * 34, 0, 74], [s * 34, 40, 74], [s * 30, 40, 74], [s * 30, 46, 74], [s * 22, 46, 74]], { base: '#150f0a', dark: '#050403', light: '#33261a', rim: 2 }, sfill);
  // 窗：自下而上一排排亮起（b4.3 → b8）
  if (sfill > 0) {
    const cols = [-19, -14, -8, -2.4, 2.4, 8, 14, 19];
    for (let r = 0; r < 22; r++) {
      const y = 5 + r * 4.2;
      for (let k = 0; k < cols.length; k++) {
        const x = cols[k], hk = hash(r * 13.1 + Math.abs(x) * 1.7), on = ignite(t, bt(4.3 + y / 100 * 3.4 + hk * .25), .15) * (hk > .22 ? 1 : 0);
        const q = poly3(c, [[x - 1.6, y, 70], [x + 1.6, y, 70], [x + 1.6, y + 2.4, 70], [x - 1.6, y + 2.4, 70]]); if (!q) continue;
        g.globalAlpha = sfill; g.fillStyle = on > 0 ? `rgba(255,${200 + 30 * Math.min(1, on - .4)},140,${.32 + .45 * Math.min(1, on)})` : 'rgba(54,41,26,.55)'; g.fill(toPath(q, true)); g.globalAlpha = 1;
      }
    }
  }
  // 主干轮廓：自中轴顶边向两侧展开，再落地（b4 起）
  if (up > 0) {
    for (const s of [-1, 1]) {
      gl3(g, c, [[0, S.y1, S.z], [s * S.w, S.y1, S.z], [s * S.w, 0, S.z]], { w: 3.2, part3: up, glow: .9 * (1 - seg(b, 4, 5)) + .15 });
      gl3(g, c, [[s * 22, 46, 74], [s * 30, 46, 74], [s * 30, 40, 74], [s * 34, 40, 74], [s * 34, 0, 74]], { w: 2.2, part3: up });
      for (const [x, d] of [[5.2, 0], [11, .12], [16.8, .24]]) gl3(g, c, [[s * x, 0, S.z], [s * x, S.y1, S.z]], { w: 1.6, part3: eo(seg(b, 4 + d, 4.9 + d)) });
    }
    // 顶部人字纹带 + 腰线
    const cp = ss(seg(b, 4.5, 5.2));
    if (cp > 0) { const ch = []; for (let k = 0; k <= 22; k++) ch.push([-22 + k * 2, 97 - (k % 2) * 2, 70]); gl3(g, c, ch, { w: 1.4, part3: cp }); gl3(g, c, [[-22, 94, 70], [22, 94, 70]], { w: 1.4, part3: cp }); gl3(g, c, [[-22, 46, 70], [22, 46, 70]], { w: 1.2, part3: cp, alpha: .8 }); }
    // 入口阶梯拱
    const arch = D.stepArchPts(0, 0, 12, 15, { steps: 3, crown: 'round' }).map(([x, y]) => [x, -y, 69.9]);
    air3(g, c, arch, { base: '#2a1a10', dark: '#0a0604', light: '#5a3a1c' }, sfill);
    gl3(g, c, arch, { w: 2.4, part3: up });
  }
  // 中轴金线（b0 → b4，跟单簧管滑音）
  const af = axisFrac(b);
  if (af > 0) {
    gl3(g, c, AXIS, { w: 3.4, part3: af, glow: 1 });
    if (af < 1) { const tp = c.P(...axisTip(b)); sparkle(g, tp[0], tp[1], 40, { alpha: 1 }); glow(g, tp[0], tp[1], 160, '#ffd890', .55); }
  }
  // 珊瑚色的光（主角）：b0 在地基点燃；b8 起随升降镜头沿中轴上升
  const ig = ignite(t, 0, .3);
  const ly = b < 8 ? 3.2 : lerp(3.2, 142, eio(seg(b, 8, 10)));
  const lp = c.P(0, ly, 69.6);
  glow(g, lp[0], lp[1], 260 * (.6 + .4 * Math.min(1.5, ig)), K.coral, .55);
  D.drawShape(g, D.starPts(lp[0], lp[1], 26 * Math.min(1.6, ig) + 4, .22), { color: K.coral, lw: 1.6 });
  if (b > 8.2 && b < 9.9) D.speedLines(g, lp[0], lp[1] + 30, PI / 2, { n: 5, len: 320 * Math.sin(PI * seg(b, 8.2, 9.9)), spread: 70, w: 4, color: K.coralL, seed: 4 });
  D.vignette(g, W, H, .5);
}

// ======================= 顶层大堂 / 门 / 天台（b10–b46，一条连续镜头） =======================
const WZ = 8, DY = 5.75, DR = .75;                 // 墙面 z、表盘中心高度与半径（米）
const DOOR = { w: 1.3, h: 3.4 };
const FW = { x: 0, y: 1.7 + 450 * Math.tan(.42), z: 450 };   // 烟花中心（远空）
const fAng = k => PI - PI * (.05 + .9 * k / 10);  // 第 k 格（世界 y 向上：π=左，0=右）
function floorPos(t) {     // 指针连续位置 0..10（机械缓动 + 落定回弹）
  let p = 0;
  for (let k = 1; k < FLOORS.length; k++) {
    const te = bt(FLOORS[k][0]), tp = bt(FLOORS[k - 1][0]), d = Math.min(.17, (te - tp) * .7);
    if (t >= te - d) { p = k - 1 + eio(seg(t, te - d, te)); if (t > te) p += .07 * Math.exp(-(t - te) / .06) * Math.sin((t - te) / .06 * 2.4); }
  }
  return p;
}
function tickKick(t) { let k = 0; for (let i = 1; i < FLOORS.length; i++) { const te = bt(FLOORS[i][0]); if (t >= te - 1e-6) k += Math.exp(-(t - te) / .07) * .025 * (i === 10 ? 3 : 1); } return k; }
// 火箭（b29 → b32）：头部仰角按拍推进，镜头仰摇跟随；路径是天台中轴 → 远空烟花中心的一条直线
const DOLLY0 = 25.5;            // 推轨穿门起点（拍）：门先开到位，再推进，铭牌多留一拍
const RK = { P0: [0, 1.15, WZ + 14], yc: 1.7, zc: WZ + 3.2 };
const rkE0 = Math.atan2(RK.P0[1] - RK.yc, RK.P0[2] - RK.zc), rkE1 = Math.atan2(FW.y - RK.yc, FW.z - RK.zc);
const rkAt = u => [lerp(RK.P0[0], FW.x, u), lerp(RK.P0[1], FW.y, u), lerp(RK.P0[2], FW.z, u)];
function rkU(b) {             // 拍 → 路径参数 u（0..1）：仰角先快后慢地爬到烟花中心
  const s = seg(b, HIT.rocket, HIT.burst1); if (s >= 1) return 1;
  const e = lerp(rkE0, rkE1, 1 - Math.pow(1 - s, 3.5)), te = Math.tan(e);   // 起飞猛、越高越慢
  const dy = FW.y - RK.P0[1], dz = FW.z - RK.P0[2];
  return clamp((te * (RK.P0[2] - RK.zc) - (RK.P0[1] - RK.yc)) / (dy - te * dz));
}
const rkElev = b => { const p = rkAt(rkU(b)); return Math.atan2(p[1] - RK.yc, p[2] - RK.zc); };
function hallCam(t) {
  const b = t / B;
  let y = DY + .3, z, f = 1200, pitch = 0;
  if (b < HIT.ding - 1e-6) {
    const u = seg(b, 10, 20); z = WZ - lerp(2.1, 1.55, Math.pow(u, 1.6)) + tickKick(t);
  } else if (b < 24.5) {
    // 叮：到顶那一帧镜头被顶一下（顿推），随即降 + 拉开露出门楣与铭牌“天台”（b20 → b21.5）
    const d = t - bt(HIT.ding), u = eio(seg(b, HIT.ding, 21.5)), uy = 1 - Math.pow(1 - seg(b, HIT.ding, 21.5), 2.2);
    y = lerp(DY + .3, 2.35, uy); z = lerp(WZ - 1.55, WZ - 4.7, u) + .16 * Math.exp(-d / .07) + tickKick(t) * (1 - u); f = lerp(1200, 1000, u);
    // 门闩两响：镜头被震一下
    for (const lb of [HIT.latch1, HIT.latch2]) if (b > lb) z += .04 * Math.exp(-(t - bt(lb)) / .06) * Math.cos((t - bt(lb)) * 70);
  } else {
    // 穿门：慢起步并略仰（让铭牌多留半拍），b28 前到达天台；随后仰摇跟火箭（b28–b32）；高潮中拉开（b32–b40）；最后略俯下看到栏杆与城市（b40–b46）
    const u = seg(b, DOLLY0, 28), e = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    y = lerp(2.35, 1.7, ss(u)); z = lerp(WZ - 4.7, WZ + 3.2, e); f = 1000;
    pitch = lerp(0, .14, ss(seg(b, DOLLY0, 27.5)));
    if (b > 28) {
      const base = .14;
      const follow = b > HIT.rocket ? Math.max(base, rkElev(b) - .18) : base;
      pitch = lerp(follow, .42, ss(seg(b, 31, 32))); f = lerp(1000, 900, eio(seg(b, 28, 32)));
    }
    if (b > 32) { f = lerp(900, 760, eio(seg(b, 32, 40))); }
    if (b > 40) { pitch = lerp(.42, .34, eio(seg(b, 40, 45))); f = lerp(760, 720, eio(seg(b, 40, 45))); }
    // 第一朵烟花的冲击：轻微震动
    if (b > 32) pitch += .006 * Math.exp(-(t - bt(32)) / .12) * Math.sin((t - bt(32)) * 55);
  }
  return cam({ y, z, pitch, f });
}
// —— 天台（门后：活的镜头）——
function terrace(g, c, t) {
  const b = t / B;
  sky(g, c, { lift: 1 });
  // 城市探照灯
  for (const s of [-1, 1]) {
    const a = c.P(s * 520, -150, 1700), tgt = b > 32 ? 1 : 0;
    const sw = Math.sin(t * .7 + (s > 0 ? 0 : 1.2)) * .18 * (1 - tgt * ss(seg(b, 32, 34)));
    const aim = c.P(FW.x, FW.y, FW.z), ang = Math.atan2(aim[1] - a[1], aim[0] - a[0]) + s * .12 + sw;
    D.beam(g, a[0], a[1], ang, 3200, 700, .07, '#e9e0c6');
  }
  city(g, c, 1.7);
  // 天台地面：大理石格（漆黑/宝蓝）+ 金缝
  for (let zi = 0; zi < 14; zi++) for (let xi = -9; xi < 9; xi++) {
    const z0 = WZ + zi, x0 = xi;
    const q = poly3(c, [[x0, 0, z0], [x0 + 1, 0, z0], [x0 + 1, 0, z0 + 1], [x0, 0, z0 + 1]]); if (!q) continue;
    g.fillStyle = (xi + zi) % 2 ? '#0d0a08' : '#18120b'; g.fill(toPath(q, true));
  }
  for (let zi = 0; zi <= 14; zi++) gl3(g, c, [[-9, 0, WZ + zi], [9, 0, WZ + zi]], { w: 1, alpha: .45 });
  for (let xi = -9; xi <= 9; xi++) gl3(g, c, [[xi, 0, WZ], [xi, 0, WZ + 14]], { w: 1, alpha: .45 });
  // 烟花映在地面上
  if (b > 32) { const p = c.P(0, 0, WZ + 9), k = Math.exp(-(t - bt(32)) / 1.5) * .6 + .25; glow(g, p[0], p[1], 900, '#ffcf7a', .25 * k, .25); }
  // 两座灯塔（对称框住中轴）
  for (const s of [-1, 1]) {
    const x = s * 6.2, z = WZ + 12.5;
    air3(g, c, [[x - .45, 0, z], [x + .45, 0, z], [x + .3, 4.2, z], [x - .3, 4.2, z]], { base: '#1c150d', dark: '#070504', light: '#43321b', rim: 2 });
    gl3(g, c, [[x - .45, 0, z], [x - .3, 4.2, z], [x + .3, 4.2, z], [x + .45, 0, z]], { w: 1.6 });
    const fanP = []; for (let i = 0; i <= 16; i++) { const a = PI * i / 16; fanP.push([x + Math.cos(a) * .7, 4.2 + Math.sin(a) * .7, z]); }
    gl3(g, c, fanP, { w: 1.8 });
    for (let i = 0; i <= 6; i++) { const a = PI * i / 6; gl3(g, c, [[x, 4.2, z], [x + Math.cos(a) * .7, 4.2 + Math.sin(a) * .7, z]], { w: 1.1 }); }
    const lp = c.P(x, 4.55, z); glow(g, lp[0], lp[1], 140, '#ffd28a', .45);
  }
  // 栏杆：阶梯立柱 + 顶栏一排灯泡（收尾时全亮）
  const PZ = WZ + 14;
  air3(g, c, [[-9, 0, PZ], [9, 0, PZ], [9, .95, PZ], [-9, .95, PZ]], { base: '#1b1610', dark: '#070504', light: '#3a2c1a', rim: 2 });
  gl3(g, c, [[-9, .95, PZ], [9, .95, PZ]], { w: 2.4 }); gl3(g, c, [[-9, .8, PZ], [9, .8, PZ]], { w: 1.2 });
  for (let i = -5; i <= 5; i++) {
    const x = i * 1.6;
    gl3(g, c, [[x - .14, 0, PZ - .01], [x - .14, 1.1, PZ - .01], [x - .07, 1.1, PZ - .01], [x - .07, 1.2, PZ - .01], [x + .07, 1.2, PZ - .01], [x + .07, 1.1, PZ - .01], [x + .14, 1.1, PZ - .01], [x + .14, 0, PZ - .01]], { w: 1.6 });
    const ch = []; for (let k = 0; k <= 6; k++) ch.push([x + .2 + k * .2, .6 - (k % 2) * .25, PZ - .01]); if (i < 5) gl3(g, c, ch, { w: 1 });
  }
  const fin = bt(HIT.final);
  for (let i = 0; i <= 44; i++) {
    const x = -8.8 + i * .4, p = c.P(x, 1.0, PZ - .02), r = c.scaleAt(x, 1, PZ) * .06;
    let v = ignite(t, fin + Math.abs(i - 22) * .0) ;
    if (t > fin + .5) { const ph = ((Math.abs(i - 22) - (t - fin - .5) * 18) % 6 + 6) % 6; v = ph < 1.5 ? 1.25 : .7; }
    bulb(g, p[0], p[1], r, v);
  }
}
// —— 大堂墙面（表盘 + 门洞 + 门） ——
function wallPolyHole(c) {
  const outer = poly3(c, [[-7, 0, WZ], [7, 0, WZ], [7, 7.6, WZ], [-7, 7.6, WZ]]);
  const hole = poly3(c, [[-DOOR.w, 0, WZ], [DOOR.w, 0, WZ], [DOOR.w, DOOR.h, WZ], [-DOOR.w, DOOR.h, WZ]]);
  return { outer, hole };
}
function leafPts(side, th, u, v) { const hx = side * DOOR.w; return [hx - side * u * Math.cos(th), v, WZ + u * Math.sin(th)]; }
function drawLeaf(g, c, t, side, th, rattle) {
  const L = (u, v) => leafPts(side, th, u, v), Wd = DOOR.w, Hd = DOOR.h;
  const face = [L(0, 0), L(Wd, 0), L(Wd, Hd), L(0, Hd)];
  const q = poly3(c, face); if (!q) return;
  const shade = clamp(th / 1.7);
  D.airbrush(g, q, { base: mix(K.sapph, '#0b0805', .7 + .25 * shade), dark: '#050608', light: mix(K.sapph, '#0b0805', .5 + shade * .4), dir: side < 0 ? -2.3 : -.84 });
  gl3(g, c, [L(0, 0), L(0, Hd), L(Wd, Hd), L(Wd, 0), L(0, 0)], { w: 2.4 });
  gl3(g, c, [L(.1, .1), L(.1, Hd - .1), L(Wd - .06, Hd - .1), L(Wd - .06, .1), L(.1, .1)], { w: 1.1 });
  // 半个日芒：两扇门合起来是一个完整日芒，中心在门缝上
  const cy = 1.95, R = 1.12;
  for (let k = 0; k <= 9; k++) { const a = PI / 2 * k / 9; gl3(g, c, [L(Wd - Math.cos(a) * .18, cy + Math.sin(a) * .18), L(Wd - Math.cos(a) * R, cy + Math.sin(a) * R)], { w: k % 3 === 0 ? 1.6 : 1 }); }
  for (const rr of [.18, .62, R]) { const arc = []; for (let k = 0; k <= 14; k++) { const a = PI / 2 * k / 14; arc.push(L(Wd - Math.cos(a) * rr, cy + Math.sin(a) * rr)); } gl3(g, c, arc, { w: 1.6 }); }
  // 下部人字纹
  for (let r = 0; r < 4; r++) { const ch = []; for (let k = 0; k <= 6; k++) ch.push(L(.2 + k * (Wd - .3) / 6, .4 + r * .26 + (k % 2) * .13)); gl3(g, c, ch, { w: 1.2 }); }
  // 门把手
  gl3(g, c, [L(Wd - .1, 1.05), L(Wd - .1, 1.55)], { w: 4 });
}
function hall(g, c, t) {
  const b = t / B;
  // 门的开合角度：b24 起机械开启，b26 到底回弹
  let th = 0;
  if (b >= HIT.doorsOpen) { { const u = seg(b, HIT.doorsOpen, HIT.doorsStop); th = 1.78 * (1 - Math.pow(1 - u, 2.6)); } if (b > HIT.doorsStop) th += .07 * Math.exp(-(t - bt(HIT.doorsStop)) / .09) * -Math.sin((t - bt(HIT.doorsStop)) * 34); }
  let rattle = 0; for (const lb of [HIT.latch1, HIT.latch2]) if (b > lb) rattle += .012 * Math.exp(-(t - bt(lb)) / .05) * Math.sin((t - bt(lb)) * 90);
  th = Math.max(0, th + rattle * (b < HIT.doorsOpen ? 1 : 0));
  // 1) 门后的天台（活的镜头，不是平涂内景）
  terrace(g, c, t);
  // 2) 门扇（开启后在墙后面）
  for (const s of [-1, 1]) drawLeaf(g, c, t, s, th, rattle);
  // 门缝透光（珊瑚）：两次闩响一次比一次亮，开门瞬间溢出
  const leak = (b >= HIT.latch1 ? .35 * (1 + 2.5 * Math.exp(-(t - bt(HIT.latch1)) / .1)) : 0) + (b >= HIT.latch2 ? .45 * (1 + 2.5 * Math.exp(-(t - bt(HIT.latch2)) / .1)) : 0);
  if (leak > 0 && th < .3) {
    const a = c.P(0, 0, WZ), bq = c.P(0, DOOR.h, WZ), mx = (a[0] + bq[0]) / 2;
    g.save(); g.globalCompositeOperation = 'lighter';
    const gr = g.createLinearGradient(mx - 60, 0, mx + 60, 0); gr.addColorStop(0, rgba(K.coral, 0)); gr.addColorStop(.5, rgba(K.coral, .55 * leak)); gr.addColorStop(1, rgba(K.coral, 0));
    g.fillStyle = gr; g.fillRect(mx - 60, bq[1], 120, a[1] - bq[1]);
    g.fillStyle = rgba(K.coralL, Math.min(1, leak)); g.fillRect(mx - 1.5, bq[1], 3, a[1] - bq[1]); g.restore();
  }
  if (b >= HIT.doorsOpen && b < HIT.doorsOpen + 1.5) { const f = Math.exp(-(t - bt(HIT.doorsOpen)) / .2), q = c.P(0, DOOR.h / 2, WZ); glow(g, q[0], q[1], 900, '#ffe6b8', .5 * f, 1.2); }
  // 3) 墙（带门洞）
  const { outer, hole } = wallPolyHole(c);
  if (outer) {
    const p = new Path2D(); p.addPath(toPath(outer, true)); if (hole) p.addPath(toPath(hole, true));
    const [x0, y0, x1, y1] = bbox(outer);
    const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, '#0c0806'); gr.addColorStop(.6, '#15100a'); gr.addColorStop(1, '#0a0705');
    g.fillStyle = gr; g.fill(p, 'evenodd');
    // 壁灯光池
    for (const s of [-1, 1]) { const q = c.P(s * 3.1, 2.9, WZ); glow(g, q[0], q[1] - 80, c.scaleAt(0, 0, WZ) * 1.6, '#ffc870', .32, 1.5); }
  }
  // 壁柱（凹槽）+ 檐口人字纹
  for (const s of [-1, 1]) {
    for (const x of [2.3, 2.45, 2.6]) gl3(g, c, [[s * x, 0, WZ], [s * x, 7.0, WZ]], { w: x === 2.45 ? 2 : 1.2 });
    for (const x of [4.2, 4.35]) gl3(g, c, [[s * x, 0, WZ], [s * x, 7.0, WZ]], { w: 1.4 });
    gl3(g, c, [[s * 2.2, 7.0, WZ], [s * 2.2, 7.25, WZ], [s * 2.7, 7.25, WZ], [s * 2.7, 7.0, WZ]], { w: 1.6 });
    // 扇形壁灯
    const sx = s * 3.1; const fan = []; for (let i = 0; i <= 14; i++) { const a = PI + PI * i / 14; fan.push([sx + Math.cos(a) * .35, 2.75 - Math.sin(a) * .35 * -1 + 0, WZ]); }
    const fp = []; for (let i = 0; i <= 14; i++) { const a = PI * i / 14; fp.push([sx + Math.cos(a) * .35, 2.6 + Math.sin(a) * .45, WZ]); }
    air3(g, c, fp, { base: '#c9a24b', dark: '#6f5220', light: '#fff4d2' }); gl3(g, c, fp, { w: 1.4 });
    for (let i = 1; i < 6; i++) { const a = PI * i / 6; gl3(g, c, [[sx, 2.6, WZ], [sx + Math.cos(a) * .35, 2.6 + Math.sin(a) * .45, WZ]], { w: 1, color: '#6f5220' }); }
  }
  const chev = []; for (let k = 0; k <= 28; k++) chev.push([-7 + k * .5, 7.05 + (k % 2) * .22, WZ]); gl3(g, c, chev, { w: 1.4 }); gl3(g, c, [[-7, 6.95, WZ], [7, 6.95, WZ]], { w: 2 });
  // 门框：三层阶梯拱，包住门与扇形门楣
  for (let i = 0; i < 3; i++) {
    const off = .1 + i * .13, pts = D.stepArchPts(0, 0, DOOR.w * 2 + off * 2, DOOR.h + DOOR.w + off * 1.2, { steps: 2, stepW: .1, stepH: .14, crown: 'round' }).map(([x, y]) => [x, -y, WZ]);
    gl3(g, c, pts, { w: i === 0 ? 2.6 : 1.4 });
  }
  // 扇形门楣（日芒）+ 铭牌“天台”
  const tc = [0, DOOR.h, WZ];
  const fanPts = [[-DOOR.w, DOOR.h, WZ]]; for (let i = 0; i <= 32; i++) { const a = PI - PI * i / 32; fanPts.push([Math.cos(a) * DOOR.w, DOOR.h + Math.sin(a) * DOOR.w, WZ]); }
  air3(g, c, fanPts, { base: '#16120f', dark: '#060403', light: '#2e2418' });
  for (let k = 0; k <= 16; k++) { const a = PI * k / 16; gl3(g, c, [[Math.cos(a) * .5, DOOR.h + Math.sin(a) * .5, WZ], [Math.cos(a) * 1.22, DOOR.h + Math.sin(a) * 1.22, WZ]], { w: k % 4 === 0 ? 1.8 : 1 }); }
  gl3(g, c, fanPts.slice(1), { w: 2.2 }); gl3(g, c, [[-DOOR.w, DOOR.h, WZ], [DOOR.w, DOOR.h, WZ]], { w: 2.6 });
  { const half = []; for (let i = 0; i <= 24; i++) { const a = PI - PI * i / 24; half.push([Math.cos(a) * .5, DOOR.h + Math.sin(a) * .5, WZ]); } gl3(g, c, half, { w: 1.6 }); }
  const pc = c.P(0, DOOR.h + .25, WZ), ps = c.scaleAt(0, DOOR.h, WZ);
  plaque(g, '天台', pc[0], pc[1], ps * .2, 1, { sheen: .45 });
  // 表盘背后的墙面日芒 + 两侧凹槽金带
  { const dc = c.P(0, DY, WZ), ds = c.scaleAt(0, DY, WZ);
    D.sunburst(g, dc[0], dc[1], { rays: 64, r0: DR * 1.3 * ds, r1: 2.6 * ds, a0: PI, a1: TAU, mode: 'lines', w: 1.2, alpha: .35 });
    D.sunburst(g, dc[0], dc[1], { rays: 32, r0: DR * 1.3 * ds, r1: 2.6 * ds, a0: PI, a1: TAU, mode: 'wedges', colorA: 'rgba(201,162,75,.05)' });
    for (const sg of [-1, 1]) for (const [x, w] of [[1.5, 1.2], [1.58, 2.2], [1.66, 1.2]]) gl3(g, c, [[sg * x, 4.75, WZ], [sg * x, 7.0, WZ]], { w });
    gl3(g, c, [[-1.66, 4.75, WZ], [1.66, 4.75, WZ]], { w: 2 }); gl3(g, c, [[-1.66, 4.85, WZ], [1.66, 4.85, WZ]], { w: 1 }); }
  // 4) 表盘（楼层指示器）
  dialDraw(g, c, t);
  // 5) 大堂地面（墙前）
  for (let zi = 0; zi < 8; zi++) for (let xi = -7; xi < 7; xi++) {
    const q = poly3(c, [[xi, 0, zi], [xi + 1, 0, zi], [xi + 1, 0, zi + 1], [xi, 0, zi + 1]]); if (!q) continue;
    g.fillStyle = (xi + zi) % 2 ? '#0e0a07' : '#1a130b'; g.fill(toPath(q, true));
  }
  for (let zi = 0; zi <= 8; zi++) gl3(g, c, [[-7, 0, zi], [7, 0, zi]], { w: 1, alpha: .5 });
  for (let xi = -7; xi <= 7; xi++) gl3(g, c, [[xi, 0, 0], [xi, 0, WZ]], { w: 1, alpha: .5 });
  // 门缝光在地面上的反射
  if (leak > 0 && th < .3) { const p = c.P(0, 0, WZ - 1.2); glow(g, p[0], p[1], 400, K.coral, .25 * leak, .25); }
  if (th > 0) { const p = c.P(0, 0, WZ - 1.0); glow(g, p[0], p[1], 700 * clamp(th), '#ffd9a0', .18 * clamp(th), .3); }
}
function dialDraw(g, c, t) {
  const b = t / B, ctr = c.P(0, DY, WZ), s = c.scaleAt(0, DY, WZ), R = DR * s;
  if (ctr[1] + R * 1.6 < -50) return;
  const [cx, cy] = ctr;
  // 外壳：阶梯半圆，漆黑，喷枪 + 金边
  const hous = []; for (let i = 0; i <= 48; i++) { const a = PI - PI * i / 48; hous.push([cx + Math.cos(a) * R * 1.22, cy - Math.sin(a) * R * 1.22]); }
  hous.push([cx + R * 1.22, cy + R * .16], [cx + R * 1.32, cy + R * .16], [cx + R * 1.32, cy + R * .3], [cx - R * 1.32, cy + R * .3], [cx - R * 1.32, cy + R * .16], [cx - R * 1.22, cy + R * .16]);
  D.airbrush(g, hous, { base: '#1d160d', dark: '#050403', light: '#3e2d16', rim: 2 });
  gline(g, hous, { w: 2.8, closed: true });
  gline(g, D.arcPts(cx, cy, R * 1.1, PI, TAU, 60), { w: 1.2 });
  D.sunburst(g, cx, cy, { rays: 44, r0: R * .2, r1: R * 1.05, a0: PI, a1: TAU, mode: 'wedges', colorA: 'rgba(201,162,75,.07)' });
  const pos = floorPos(t), lit = Math.round(clamp(pos, 0, 10));
  // 外圈灯泡：每格亮一组（4 颗）
  for (let i = 0; i < 44; i++) {
    const a = PI + PI * (i + .5) / 44, grp = Math.floor(i / 4), te = bt(FLOORS[grp][0]);
    let v = ignite(t, te);
    if (t >= bt(HIT.ding) - 1e-6) { const ph = ((i - (t - bt(HIT.ding)) * 26) % 5 + 5) % 5; v = (ph < 1.6 ? 1.3 : .75) + .4 * Math.exp(-(t - bt(HIT.ding)) / .15); }
    bulb(g, cx + Math.cos(a) * R * 1.16, cy + Math.sin(a) * R * 1.16, R * .028, v);
  }
  // 刻度
  for (let i = 0; i <= 40; i++) { const a = PI + PI * (.05 + .9 * i / 40), big = i % 4 === 0; gline(g, [[cx + Math.cos(a) * R * (big ? .78 : .84), cy + Math.sin(a) * R * (big ? .78 : .84)], [cx + Math.cos(a) * R * .92, cy + Math.sin(a) * R * .92]], { w: big ? 2 : 1 }); }
  // 楼层章（每格一圈小灯）
  for (let k = 0; k < FLOORS.length; k++) {
    const a = fAng(k), mx = cx + Math.cos(a) * R * .68, my = cy - Math.sin(a) * R * .68, mr = R * (k === 10 ? .1 : .078);
    const te = bt(FLOORS[k][0]), on = ignite(t, te), here = k === lit ? 1 : 0;
    if (on > 0) glow(g, mx, my, mr * 3.2, k === 10 ? K.coral : '#ffcf7a', .4 * Math.min(1.4, on) * (.5 + .5 * here));
    g.beginPath(); g.arc(mx, my, mr, 0, TAU); g.fillStyle = on > 0 ? '#2a1d0e' : '#0b0806'; g.fill();
    gline(g, D.arcPts(mx, my, mr, 0, TAU, 40), { w: 2 });
    for (let j = 0; j < 10; j++) { const aa = j / 10 * TAU; bulb(g, mx + Math.cos(aa) * mr * 1.3, my + Math.sin(aa) * mr * 1.3, R * .01, on > 0 ? (here ? on : .55) : 0); }
    const lab = FLOORS[k][1], cj = lab === '顶';
    g.save(); g.font = cj ? `${mr * 1.2}px ${CJK}` : `${mr * (lab.length > 1 ? 1.05 : 1.25)}px Italiana`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = on > 0 ? (here ? '#fff6dc' : C.ivoryD) : goldGrad(g, mx - mr, my - mr, mx + mr, my + mr, { sheen: .4 });
    g.fillText(lab, mx, my + mr * (cj ? .02 : .06)); g.restore();
  }
  // 指针：金色，珊瑚尖（那束光）
  const a = fAng(pos), tip = [cx + Math.cos(a) * R * .55, cy - Math.sin(a) * R * .55];
  const n1 = [cx + Math.cos(a + PI / 2) * R * .04, cy - Math.sin(a + PI / 2) * R * .04], n2 = [cx + Math.cos(a - PI / 2) * R * .04, cy - Math.sin(a - PI / 2) * R * .04], tail = [cx - Math.cos(a) * R * .14, cy + Math.sin(a) * R * .14];
  g.save(); g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 8; g.shadowOffsetY = 4;
  g.beginPath(); g.moveTo(...n1); g.lineTo(...tip); g.lineTo(...n2); g.lineTo(...tail); g.closePath(); g.fillStyle = goldGrad(g, cx - R, cy - R, cx + R, cy, { sheen: .55 }); g.fill(); g.restore();
  const mid = [lerp(cx, tip[0], .62), lerp(cy, tip[1], .62)];
  D.drawShape(g, [[mid[0] + Math.cos(a + PI / 2) * R * .03, mid[1] - Math.sin(a + PI / 2) * R * .03], tip, [mid[0] + Math.cos(a - PI / 2) * R * .03, mid[1] - Math.sin(a - PI / 2) * R * .03]], { color: K.coral, lw: 1.4 });
  glow(g, tip[0], tip[1], R * .3, K.coral, .45);
  g.beginPath(); g.arc(cx, cy, R * .08, 0, TAU); g.fillStyle = goldGrad(g, cx - R * .08, cy - R * .08, cx + R * .08, cy + R * .08, { sheen: .3 }); g.fill();
  D.sunburst(g, cx, cy, { rays: 11, r0: R * .1, r1: R * .3, a0: PI * 1.1, a1: PI * 1.9, mode: 'lines', w: 1.4, alpha: .8 });
  // 到顶：一记闪光
  if (t >= bt(HIT.ding) - 1e-6) { const fl = Math.exp(-(t - bt(HIT.ding)) / .18); glow(g, cx, cy, R * 2.4, '#ffe0a0', .45 * fl); }
}
// —— 机械万花筒烟花 ——
function rayBurst(g, x, y, R, age, { rays = 12, rot = 0, coral = false, fanK = .26, alpha = 1, mirror = 1, petals = true } = {}) {
  if (age < 0) return;
  const grow = eo(clamp((age + .07) / .45)), flash = Math.exp(-age / .22), aa = alpha * (1 - .35 * ss(clamp((age - .6) / 2.5)));
  if (flash > .02) glow(g, x, y, R * (1.2 + 1.5 * (1 - flash)), coral ? K.coral : '#ffd890', .55 * flash * alpha);
  g.save(); g.globalAlpha *= aa;
  for (let k = 0; k < rays; k++) {
    const a = rot + k * TAU / rays, long = k % 2 === 0, re = R * (long ? 1 : .7) * grow, r0 = R * .14;
    const p0 = [x + Math.cos(a) * r0, y + Math.sin(a) * r0], p1 = [x + Math.cos(a) * re, y + Math.sin(a) * re];
    gline(g, [p0, p1], { w: long ? Math.max(2, R * .022) : Math.max(1.2, R * .013), glow: .5 * flash + .15, bb: [x - R, y - R, x + R, y + R] });
    if (long && grow > .9) {
      if (petals) { const fo = ss(clamp((age - .12) / .35)); D.fan(g, p1[0], p1[1], R * fanK * fo, { a0: a - PI / 2, a1: a + PI / 2, ribs: 5, open: fo, fill: C.gold1, ring: .3 }); }
      sparkle(g, p1[0] + Math.cos(a) * R * .1, p1[1] + Math.sin(a) * R * .1, R * .12 * (.7 + .3 * Math.sin(age * 9 + k)), { alpha: .9 });
    } else if (!long && grow > .9) sparkle(g, p1[0], p1[1], R * .07, { alpha: .8 });
  }
  g.restore();
  // 核心
  if (coral) { D.drawShape(g, D.starPts(x, y, R * .16 * (.9 + .1 * Math.sin(age * 7)), .3, rot * 0, 4), { color: K.coral, lw: 1.6 }); glow(g, x, y, R * .5, K.coral, .5); }
  else { g.beginPath(); g.arc(x, y, R * .08, 0, TAU); g.fillStyle = goldGrad(g, x - R * .08, y - R * .08, x + R * .08, y + R * .08); g.fill(); }
}
const STEPS = [...SPARKS, HIT.lock];        // 8 步棘轮：每个八分音符一步
function ratchet(t, total) {                // 机械步进：每步在拍点上落定
  let r = 0;
  for (const sb of STEPS) { const te = bt(sb), d = .16; r += total / STEPS.length * eio(seg(t, te - d, te)); }
  const last = bt(HIT.lock); if (t > last) r += total * .012 * Math.exp(-(t - last) / .08) * Math.sin((t - last) * 50);
  return r;
}
function kaleido(g, c, t) {
  const b = t / B; if (b < HIT.burst1 - .01) return;
  const cp = c.P(FW.x, FW.y, FW.z), k = c.scaleAt(FW.x, FW.y, FW.z) / (900 / Math.hypot(FW.y - 1.7, FW.z - (WZ + 3.2)));
  const [x, y] = cp, U = k;                  // U：参考尺度下 1 像素
  const t1 = bt(HIT.burst1), t2 = bt(HIT.burst2), t3 = bt(HIT.burst3), tl = bt(HIT.lock);
  const lockP = ss(seg(t, tl, tl + .6));
  const R1 = 235 * U, R2 = 285 * U, R3 = 450 * U;
  // 背景：烟花把夜空照亮
  { const age = t - t1; if (age >= -1e-6 && age < 1.2) glow(g, x, y, 1500 * U, '#ffe6b0', .55 * Math.exp(-age / .14)); }   // 第一朵炸开那一帧：整片夜空一闪
  glow(g, x, y, 1300 * U, '#3b2a12', .35 * ss(seg(b, 32, 33)));
  // 锁定后的徽章底：日芒楔 + 同心阶梯环（从顶端中轴向两侧绘出）
  if (lockP > 0) {
    D.sunburst(g, x, y, { rays: 48, r0: R1 * .7, r1: R3 * 1.02, mode: 'wedges', colorA: `rgba(201,162,75,${.12 * lockP})` });
    for (const [rr, w] of [[R1 * .7, 2.4], [R2 * .86, 1.4], [R2 * 1.14, 2.4], [R3 * .8, 1.2], [R3 * 1.02, 3]]) {
      const arcL = D.arcPts(x, y, rr, -PI / 2, -PI / 2 - PI, 64), arcR = D.arcPts(x, y, rr, -PI / 2, PI / 2, 64);
      gline(g, arcL, { w, part: lockP, glow: .4 * (1 - lockP) }); gline(g, arcR, { w, part: lockP, glow: .4 * (1 - lockP) });
    }
  }
  // 机械网：连接各元素的金线（旋转时形变，锁定时成正十二角星）
  const rho1 = ratchet(t, PI / 6), rho2 = ratchet(t, PI / 3), rho3 = ratchet(t, PI / 6);
  const P2 = [], P3 = [];
  for (let i = 0; i < 6; i++) { const a = -PI / 2 + i * PI / 3 + (i % 2 ? -1 : 1) * rho2; P2.push([x + Math.cos(a) * R2, y + Math.sin(a) * R2, a, i]); }
  for (let i = 0; i < 12; i++) { const a = -PI / 2 + PI / 12 + i * PI / 6 - (i % 2 ? -1 : 1) * rho3; P3.push([x + Math.cos(a) * R3, y + Math.sin(a) * R3, a, i]); }
  const netP = ss(seg(b, HIT.burst3, HIT.burst3 + 1));
  if (netP > 0) {
    const star = []; for (let i = 0; i < 12; i++) { star.push([P3[i][0], P3[i][1]]); const j = Math.floor(i / 2); star.push([P2[(j + (i % 2)) % 6][0], P2[(j + (i % 2)) % 6][1]]); }
    gline(g, star, { w: 1.4, closed: true, part: netP, alpha: .8 });
  }
  // 第三朵（外圈 12，b36）
  for (const [px, py, a, i] of P3) rayBurst(g, px, py, 74 * U, t - t3, { rays: 8, rot: a + (i % 2 ? -1 : 1) * rho3 * 2, fanK: .0, petals: false, mirror: i % 2 ? -1 : 1, alpha: 1 - .3 * lockP });
  // 第二朵（中圈 6，b34）
  for (const [px, py, a, i] of P2) rayBurst(g, px, py, 128 * U, t - t2, { rays: 10, rot: a + (i % 2 ? -1 : 1) * rho2, fanK: .24, petals: false, mirror: i % 2 ? -1 : 1, alpha: 1 - .25 * lockP });
  // 第一朵（中心，b32）
  rayBurst(g, x, y, R1, t - t1, { rays: 12, rot: -PI / 2 + rho1, coral: true, fanK: .22, alpha: 1 - .45 * lockP, petals: true });
  // 星火：每个八分音符一记（满）
  for (const sb of STEPS) { const ts = bt(sb); if (t >= ts && t < ts + .3) { const f = Math.pow(1 - (t - ts) / .3, 1.5); for (const [px, py] of (sb * 2 % 2 ? P2.concat(P3.filter((_, j) => j % 2)) : P3)) { glow(g, px, py, 110 * U * f, '#ffe2a0', .55 * f); sparkle(g, px, py, 75 * U * f, { alpha: f }); } } }
  // 锁定：1929 + 铭牌“落成之夜”
  if (b >= HIT.lock) {
    const lk = t - tl;
    // 中心漆黑横牌（阶梯两端），1929 从中线升起
    const open = eio(clamp(lk / .35)), bw = 700 * U, bh = 250 * U * open;
    if (bh > 1) {
      const pts = plaquePts(x, y, bw, bh, .14);
      const gr = g.createLinearGradient(0, y - bh / 2, 0, y + bh / 2); gr.addColorStop(0, '#1a140c'); gr.addColorStop(.5, '#040302'); gr.addColorStop(1, '#1a140c');
      g.fillStyle = gr; g.fill(toPath(pts, true));
      const sh = lerp(-.2, 1.2, seg(b, HIT.sheen, HIT.sheen + 1.2));
      gline(g, pts, { w: 3, closed: true, bb: [x - bw / 2, y - bh, x + bw / 2, y + bh], sheen: b > HIT.sheen ? sh : .35 });
      if (bh > 20) gline(g, plaquePts(x, y, bw - 26 * U, bh - 26 * U, .14), { w: 1.3, closed: true, bb: [x - bw / 2, y - bh, x + bw / 2, y + bh], sheen: .55 });
    }
    if (bh > 1) { const jy = y - bh / 2, jr = 26 * U * open; glow(g, x, jy, jr * 4, K.coral, .45); D.drawShape(g, [[x, jy - jr], [x + jr * .75, jy], [x, jy + jr], [x - jr * .75, jy]], { color: K.coral, lw: 1.6 }); }
    if (lk < .3) { const f = 1 - lk / .3; gline(g, [[x - bw * .7 * (1 - f * .3), y], [x + bw * .7 * (1 - f * .3), y]], { w: 3, glow: f }); glow(g, x, y, 500 * U, '#ffe0a0', .6 * f); }
    const tx = ss(clamp((lk - .15) / .4));
    if (tx > 0) {
      g.save(); g.beginPath(); g.rect(x - bw, y - bh / 2 + 3, bw * 2, Math.max(0, bh - 6)); g.clip();
      const sh = b > HIT.sheen ? lerp(-.25, 1.25, seg(b, HIT.sheen, HIT.sheen + 1.3)) : .3;
      TY.goldText(g, '1929', x, y + 76 * U + (1 - tx) * 130 * U, { size: 200 * U, font: 'Italiana', sy: 1.18, track: 26 * U, sheen: sh, alpha: tx });
      g.restore();
      // 光泽扫过：一道斜向高光
      if (b > HIT.sheen && b < HIT.sheen + 1.4) {
        const u = seg(b, HIT.sheen, HIT.sheen + 1.3), sx = lerp(x - bw * .6, x + bw * .6, eio(u));
        g.save(); g.beginPath(); g.rect(x - bw / 2, y - bh / 2, bw, bh); g.clip(); g.globalCompositeOperation = 'lighter';
        const gr = g.createLinearGradient(sx - 90 * U, 0, sx + 90 * U, 0); gr.addColorStop(0, 'rgba(255,240,200,0)'); gr.addColorStop(.5, `rgba(255,244,214,${.35 * Math.sin(PI * u)})`); gr.addColorStop(1, 'rgba(255,240,200,0)');
        g.fillStyle = gr; g.translate(sx, y); g.transform(1, 0, -.35, 1, 0, 0); g.translate(-sx, -y); g.fillRect(sx - 120 * U, y - bh, 240 * U, bh * 2); g.restore();
        sparkle(g, sx + 40 * U, y - 70 * U, 46 * U * Math.sin(PI * u), { alpha: .95 });
      }
    }
    plaque(g, '落成之夜', x, y + 222 * U, 78 * U, clamp(lk / .9), { sheen: b > HIT.sheen ? lerp(-.2, 1.2, seg(b, HIT.sheen + .3, HIT.sheen + 1.5)) : .4 });
    // 徽章上的灯泡花环（收尾时全亮）
    const fin = bt(HIT.final);
    for (let i = 0; i < 48; i++) {
      const a = -PI / 2 + i * TAU / 48, bx = x + Math.cos(a) * R3 * .9, by = y + Math.sin(a) * R3 * .9;
      let v = t > fin ? ignite(t, fin) : .0;
      if (t > fin + .5) { const ph = ((i - (t - fin - .5) * 20) % 6 + 6) % 6; v = ph < 1.5 ? 1.25 : .75; }
      bulb(g, bx, by, 7 * U, v);
    }
    if (t > fin) { const f = Math.exp(-(t - fin) / .25); glow(g, x, y, 900 * U, '#ffe6b0', .4 * f); }
  }
}
// —— 火箭（b28.4 引信 → b29 升空 → b32 炸开）：珊瑚头 + 沿中轴生长的金色尾迹（呼应镜 1 的中轴刻线） ——
function rocket(g, c, t) {
  const b = t / B, t32 = bt(HIT.burst1);
  if (b < 28.4 || t > t32 + .4) return;
  const base = c.P(...RK.P0);
  if (b < HIT.rocket) {        // 引信：栏杆中轴上的一粒火星
    const fl = .7 + .3 * Math.sin(t * 61) * Math.sin(t * 23);
    glow(g, base[0], base[1], 70 * fl, K.coral, .5); sparkle(g, base[0], base[1], 14 + 6 * fl, { alpha: .9 });
    return;
  }
  const u = rkU(b), head = c.P(...rkAt(u));
  const fade = t > t32 ? 1 - (t - t32) / .4 : 1;            // 炸开后尾迹在 0.4 s 内自下而上熄灭
  const lo = t > t32 ? ss((t - t32) / .4) : 0;
  const tail = rkAt(lo * u), tp = c.P(...tail);
  // 金色尾迹（整条，从栏杆到火箭头）
  glow(g, (tp[0] + head[0]) / 2, (tp[1] + head[1]) / 2, 80, '#ffcf7a', .22 * fade, Math.max(1, Math.abs(tp[1] - head[1]) / 150));
  gline(g, [tp, head], { w: 7, glow: 1 * fade, alpha: fade });
  // 珊瑚色内芯：靠近火箭头的一段更热
  const hotK = Math.max(lo * u, u * .55), hot = c.P(...rkAt(hotK));
  gline(g, [hot, head], { w: 4.5, color: K.coral, glow: 1 * fade, alpha: fade });
  g.save(); g.globalAlpha *= fade; g.globalCompositeOperation = 'lighter';
  const gr = g.createLinearGradient(0, hot[1], 0, head[1]); gr.addColorStop(0, rgba(K.coral, 0)); gr.addColorStop(1, rgba(K.coralL, .9));
  g.fillStyle = gr; g.fillRect(head[0] - 7, head[1], 14, hot[1] - head[1]); g.restore();
  // 尾迹上的火星：沿尾迹向下飘落
  for (let i = 0; i < 14; i++) {
    const k = ((i / 14 + t * .9) % 1), p = c.P(...rkAt(lerp(lo * u, u, k)));
    sparkle(g, p[0] + Math.sin(i * 2.3 + t * 17) * 7, p[1], (6 + 10 * k) * fade, { alpha: (.35 + .55 * k) * fade });
  }
  if (t > t32) return;
  // 火箭头：珊瑚四角星 + 光晕（那束光）
  glow(g, head[0], head[1], 190, K.coral, .8);
  D.drawShape(g, D.starPts(head[0], head[1], 34 + 7 * Math.sin(t * 40), .25), { color: K.coral, lw: 1.6 });
  // 发射：栏杆上的一闪
  const f0 = Math.exp(-(t - bt(HIT.rocket)) / .12); if (f0 > .02) { glow(g, base[0], base[1], 260 * f0, '#ffd890', .6 * f0); sparkle(g, base[0], base[1], 60 * f0, { alpha: f0 }); }
}
function shotHall(g, t) {
  const c = hallCam(t);
  hall(g, c, t);
  rocket(g, c, t);
  kaleido(g, c, t);
  D.vignette(g, W, H, .45);
}

// ======================= 总装 =======================
export function renderFilm(g, t) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.fillStyle = K.lac; g.fillRect(0, 0, W, H);
  if (t < bt(HIT.cutDial)) shotTower(g, t); else shotHall(g, t);
}
// 拟音 / 音乐事件（mix.py 读 events.json）
export function events() {
  const E = [], add = (b, type, o = {}) => E.push({ t: +bt(b).toFixed(6), b, type, ...o });
  add(HIT.ignite, 'ignite'); add(0, 'scribe', { b1: 4 });
  add(HIT.unfold, 'unfold'); add(HIT.unfold, 'switch');
  [HIT.step1, HIT.step2, HIT.step3].forEach((b, i) => add(b, 'stamp', { i }));
  [HIT.ray0, HIT.ray1, HIT.ray2, HIT.ray3].forEach((b, i) => add(b, 'ray', { i }));
  add(8, 'crane', { b1: 10 }); add(HIT.cutDial, 'cut');
  FLOORS.forEach(([b, lab], i) => add(b, 'floor', { i, lab }));
  add(HIT.ding, 'ding'); add(HIT.ding, 'pull', { b1: 21.5 });
  add(HIT.latch1, 'latch', { i: 0 }); add(HIT.latch2, 'latch', { i: 1 });
  add(HIT.doorsOpen, 'doors'); add(DOLLY0, 'dolly', { b1: 28 }); add(HIT.doorsStop, 'doorstop');
  add(HIT.cutoff, 'cutoff'); add(28.4, 'fuse'); add(HIT.rocket, 'rocket', { b1: HIT.burst1 });
  [HIT.burst1, HIT.burst2, HIT.burst3].forEach((b, i) => add(b, 'burst', { i }));
  SPARKS.forEach((b, i) => add(b, 'spark', { i }));
  add(HIT.lock, 'lock'); add(HIT.lock, 'plaque'); add(HIT.sheen, 'sheen'); add(HIT.final, 'final'); add(HIT.final + .5, 'chase');
  return E;
}
// 画面内文字（readcheck）
export function texts(t) {
  const out = [], b = t / B;
  const inFrame = q => q[0] >= 0 && q[1] >= 0 && q[2] <= W && q[3] <= H;
  if (b >= HIT.cutDial) {
    const c = hallCam(t);
    const ctr = c.P(0, DY, WZ), s = c.scaleAt(0, DY, WZ), R = DR * s;
    const q = [ctr[0] - R * .75, ctr[1] - R * .75, ctr[0] + R * .75, ctr[1] + R * .1];
    if (q[3] > 0 && q[1] < H && c.depth(0, DY, WZ) > .2) out.push({ id: 'dial', text: FLOORS.map(f => f[1]).join(' '), x0: q[0], y0: q[1], x1: q[2], y1: q[3] });
    const pc = c.P(0, DOOR.h + .25, WZ), ps = c.scaleAt(0, DOOR.h, WZ);
    const pq = [pc[0] - ps * .45, pc[1] - ps * .16, pc[0] + ps * .45, pc[1] + ps * .16];
    if (c.depth(0, DOOR.h, WZ) > .2 && pq[3] > 0 && pq[1] < H && pq[0] < W && pq[2] > 0) out.push({ id: 'tiantai', text: '天台', x0: pq[0], y0: pq[1], x1: pq[2], y1: pq[3] });
    if (b >= HIT.lock) {
      const cp = c.P(FW.x, FW.y, FW.z), U = c.scaleAt(FW.x, FW.y, FW.z) / (900 / Math.hypot(FW.y - 1.7, FW.z - (WZ + 3.2)));
      out.push({ id: 'year', text: '1929', x0: cp[0] - 260 * U, y0: cp[1] - 110 * U, x1: cp[0] + 260 * U, y1: cp[1] + 110 * U });
      out.push({ id: 'title', text: '落成之夜', x0: cp[0] - 260 * U, y0: cp[1] + 160 * U, x1: cp[0] + 260 * U, y1: cp[1] + 285 * U });
    }
  }
  return out;
}
