// 《追帽子》角色与道具（全部原创）。数值是印片密度（0 黑 → 1 白）。
// 绅士用 engine/figure.js 的 2.5D 人偶；礼帽、猴子、狗、电车、梯子、墙都是独立绘制的调子形体，交给 Redraw 上墨。
import { form, stroke, catmull, grey, pathOf, ellipsePts, rectPts } from './engine/ink.js';
import { torsoPoint } from './engine/figure.js';
import { PROFILE_ADULT } from './engine/heads.js';
import { headShape } from './headshape.js';

const lerp = (a, b, t) => a + (b - a) * t;
const loop = (pts, n = 5) => catmull(pts, true, n);
export const HAT_RED = '#8e1f1c';

// ---------------- 绅士：长礼服（燕尾下摆）、条纹裤、白翼领、深色领巾、上翘八字胡 ----------------
export const GENT = {
  name: 'Gent', body: 'adult', line: .03,
  skin: { v: .82 }, handW: .32, neckW: .38,
  leg: { v: .56, w: [.56, .44, .38], folds: true, gap: 5 },
  shoe: { v: .08 },
  arm: { v: .14, w: [.42, .36, .31], sleeve: 1 },
  torso: { v: .14, grad: .2 },
  torsoW: 1.02, torsoD: 1.05,
  skirt: { front: false, v: .12, top: 1.25, len: 3.0, wz: .78, fx: -.32, hemW: 1.15 },
  torsoDetail(g, J, pr, s, lw) {
    if (s < 14 || pr.cy < -.3) return;
    const T = (xf, y, xs) => torsoPoint(J, pr, xf, y, xs);
    // 白衬衫胸前 V 区 + 背心纽扣 + 怀表链
    const v = [T(-.28, 2.32, .16), T(0, 1.5, .44), T(.28, 2.32, .32), T(.1, 2.38, .26), T(-.1, 2.38, .12)];
    form(g, loop(v, 3), { v: .93, line: lw * .8, grad: .1, seed: 236 });
    stroke(g, [T(0, 1.5, .44), T(.02, .9, .42)], lw * .8, { seed: 237 });
    for (let i = 0; i < 3; i++) { const q = T(.04, 1.42 - i * .18, .45); g.fillStyle = grey(.7); g.beginPath(); g.arc(q[0], q[1], s * .022, 0, 7); g.fill(); }
    const w0 = T(.05, 1.25, .44), w1 = T(-.3, 1.12, .32), w2 = T(-.42, 1.26, .14);
    stroke(g, catmull([w0, [lerp(w0[0], w1[0], .5), lerp(w0[1], w1[1], .5) + s * .06], w1, w2], false, 5), lw * .55, { color: grey(.86), seed: 238, alpha: .9 });
  },
  collar(g, J, pr, s, lw) {
    const T = (xf, y, xs) => torsoPoint(J, pr, xf, y, xs);
    if (pr.cy > -.3) {   // 深色领巾结
      const k = T(0, 2.3, .22);
      const knot = loop([[k[0] - s * .1, k[1] - s * .06], [k[0] + s * .1, k[1] - s * .06], [k[0] + s * .08, k[1] + s * .12], [k[0] - s * .08, k[1] + s * .12]], 4);
      form(g, knot, { v: .1, line: lw * .8, hatch: .3, seed: 241 });
    }
    const c = loop([T(-.25, 2.32, -.2), T(-.06, 2.3, .16), T(0, 2.44, .24), T(.06, 2.3, .22), T(.25, 2.32, .26), T(.23, 2.52, .22), T(0, 2.48, -.02), T(-.23, 2.52, -.22)], 4);
    form(g, c, { v: .95, line: lw * .85, grad: .14, hatch: 0, seed: 243 });
  },
  head: {
    skin: .84, jaw: 1.04, chinW: .48, brow: 2.3, lip: .38, profile: PROFILE_ADULT, nose: 1.08,
    hair(g, H) {   // 油亮的背头（中分），深色发块 + 几道梳痕
      const F = [[-.36, -.06], [-.38, -.3], [-.26, -.46], [0, -.52], [.26, -.46], [.38, -.3], [.36, -.06], [.31, -.22], [.18, -.3], [.02, -.33], [-.16, -.3], [-.31, -.22]];
      const Pp = [[-.4, .16], [-.45, -.12], [-.33, -.43], [-.05, -.53], [.2, -.48], [.33, -.35], [.31, -.27], [.2, -.32], [.1, -.26], [0, -.16], [-.06, .02], [-.22, .18]];
      const B = [[-.36, .1], [-.4, -.2], [-.28, -.44], [0, -.52], [.28, -.44], [.4, -.2], [.36, .1], [.25, .2], [.12, .23], [0, .24], [-.12, .23], [-.25, .2]];
      form(g, loop(headShape(H, F, Pp, B)), { v: .1, line: H.lw * .8, grad: .12, hatch: .2, seed: 211 });
      for (let i = 0; i < 6; i++) { const u = i / 5, a = headShape(H, [[lerp(-.28, .28, u), -.44]], [[lerp(-.3, .18, u), -.46]])[0], b = headShape(H, [[lerp(-.32, .32, u), -.2]], [[lerp(-.4, -.05, u), -.1 + u * .04]])[0]; stroke(g, [a, b], H.lw * .4, { color: grey(.5), seed: 212 + i, alpha: .7 }); }
    },
    beard(g, H) {   // 上翘八字胡
      const pts = headShape(H, [[-.27, .14], [-.14, .19], [0, .18], [.14, .19], [.27, .14], [.22, .22], [.1, .24], [0, .22], [-.1, .24], [-.22, .22]],
        [[.16, .2], [.3, .17], [.42, .18], [.47, .17], [.53, .1], [.5, .2], [.44, .24], [.36, .23], [.26, .25], [.15, .25]]);
      form(g, loop(pts, 4), { v: .1, line: H.lw * .8, hatch: .4, seed: 411 });
    },
  },
};

// ---------------- 礼帽（侧面）：cx,cy = 帽檐中心；w = 帽檐宽；rot 弧度；band 红色写进色彩遮罩 ----------------
export function drawTopHat(g, cx, cy, w, rot = 0, mask = null, flip = 1) {
  const draw = (c, isMask) => {
    c.save(); c.translate(cx, cy); c.rotate(rot); c.scale(flip, 1);
    const cw = w * .64, ch = w * .82;
    const crown = [[-cw * .5, 0], [-cw * .47, -ch * .5], [-cw * .54, -ch], [cw * .54, -ch], [cw * .47, -ch * .5], [cw * .5, 0]];
    const brim = loop([[-w * .5, w * .02], [-w * .56, -w * .07], [-w * .44, -w * .03], [0, -w * .015], [w * .44, -w * .03], [w * .56, -w * .07], [w * .5, w * .02], [0, w * .07]], 4);
    const band = [[-cw * .5, -w * .02], [cw * .5, -w * .02], [cw * .485, -ch * .22], [-cw * .485, -ch * .22]];
    if (isMask) { pathOf(c, band); c.fillStyle = HAT_RED; c.fill(); c.restore(); return; }
    form(c, crown, { v: .1, line: w * .028, grad: .3, seed: 501, cyl: 0, cylK: .25 });
    // 丝光高光（礼帽的标志）
    c.fillStyle = grey(.55, .55); c.beginPath(); c.moveTo(-cw * .3, -ch * .95); c.lineTo(-cw * .18, -ch * .95); c.lineTo(-cw * .14, -ch * .28); c.lineTo(-cw * .26, -ch * .28); c.fill();
    form(c, band, { v: .3, line: w * .02, grad: .1, seed: 502 });
    form(c, [[-cw * .54, -ch], [cw * .54, -ch], [cw * .5, -ch * 1.04], [-cw * .5, -ch * 1.04]], { v: .2, line: w * .02, seed: 503 });
    form(c, brim, { v: .08, line: w * .028, grad: .2, seed: 504 });
    c.restore();
  };
  draw(g, false); if (mask) draw(mask, true);
}
export const HAT_H = w => w * .82;     // 帽冠高

// ---------------- 小猴子（卷尾猴）：x,y = 脚底中心；s = 身高(px)；o = {look, armUp, sit, blink} ----------------
export function drawMonkey(g, x, y, s, o = {}) {
  g.save(); g.translate(x, y);
  const k = s / 100, sit = o.sit ?? 0, f = o.face ?? 1;
  const hy = -78 * k + sit * 14 * k;       // 头中心
  // 毛边：把平滑轮廓逐点往外推出一簇簇短毛（雕版里毛皮靠轮廓的锯齿来读）
  const fur = (pts, amp, seed) => { const n = pts.length; let cx = 0, cy = 0; for (const [px, py] of pts) { cx += px; cy += py; } cx /= n; cy /= n;
    return pts.map(([px, py], i) => { const dx = px - cx, dy = py - cy, l = Math.hypot(dx, dy) || 1, a = (i % 3 === 1 ? 1 : i % 3 === 2 ? .35 : 0) * amp * (.6 + .4 * Math.sin(i * 1.7 + seed)); return [px + dx / l * a, py + dy / l * a]; }); };
  // 毛向：沿形体往下梳的短弧线（深色毛上的一层排线），只在暗面加交叉排线
  const furTex = (seed, dir = 1, n = 14, len = 9) => (c, pts) => {
    const [x0, y0, x1, y1] = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
    c.save(); pathOf(c, pts); c.clip();
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const u = (i + .5 + Math.sin(seed + i * 3.1 + j * 1.3) * .35) / n, v = (j + .5 + Math.cos(seed + j * 2.3 + i) * .35) / n;
      const px = lerp(x0, x1, u), py = lerp(y0, y1, v), sk = (u - .5) * .9 * dir;
      stroke(c, [[px, py], [px + sk * len * k * .4, py + len * k * .5], [px + sk * len * k, py + len * k]], 1.1 * k, { color: grey(.08), seed: seed + i * n + j, alpha: .55 });
    }
    hatchDark(c, pts, seed);
    c.restore();
  };
  const hatchDark = (c, pts, seed) => {   // 暗面 45° 排线 + 交叉
    const [x0, y0, x1, y1] = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
    c.save(); pathOf(c, pts); c.clip();
    const gr = c.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, 'rgba(21,18,15,0)'); gr.addColorStop(.45, 'rgba(21,18,15,0)'); gr.addColorStop(1, 'rgba(21,18,15,.75)');
    c.strokeStyle = gr; c.lineWidth = 1.3 * k; c.beginPath();
    const r = Math.hypot(x1 - x0, y1 - y0);
    for (let d = -r; d < r; d += 3.2 * k) { c.moveTo(x0 + d, y0); c.lineTo(x0 + d + r, y0 + r); c.moveTo(x1 - d, y0); c.lineTo(x1 - d - r, y0 + r); }
    c.stroke(); c.restore();
  };
  // 尾巴：S 形卷到身后（深色 + 一道受光的细线）
  const tail = catmull([[-14 * k * f, -20 * k], [-46 * k * f, -14 * k], [-58 * k * f, -44 * k], [-44 * k * f, -64 * k], [-30 * k * f, -56 * k]], false, 8);
  stroke(g, tail, 7 * k, { seed: 601 }); stroke(g, tail.map(([a, b]) => [a + 1.6 * k, b - 1.6 * k]), 1.4 * k, { color: grey(.5), seed: 609, alpha: .8 });
  // 腿（蹲）
  for (const sx of [-1, 1]) form(g, fur(loop([[sx * 6 * k, -30 * k], [sx * 22 * k, -22 * k], [sx * 20 * k, -2 * k], [sx * 10 * k, 0], [sx * 4 * k, -12 * k]], 4), 1.6 * k, 602 + sx), { v: .3, line: 2 * k, grad: .3, seed: 602 + sx, cyl: Math.PI / 2, cylK: .25, texture: furTex(602 + sx, sx, 6, 7) });
  // 身体：毛边 + 圆柱明暗 + 梳毛线；小背心（马甲）
  const body = fur(loop([[-17 * k, -62 * k], [17 * k, -62 * k], [22 * k, -38 * k], [16 * k, -18 * k], [-16 * k, -18 * k], [-22 * k, -38 * k]], 5), 2 * k, 604);
  form(g, body, { v: .36, line: 2.2 * k, grad: .32, seed: 604, shade: 6 * k, cyl: Math.PI / 2, cylK: .3, texture: furTex(604, 1, 12, 8) });
  for (const [sx, sd] of [[-1, 605], [1, 606]]) {
    const vest = loop([[sx * 15 * k, -60 * k], [sx * 4 * k, -60 * k], [sx * 6 * k, -30 * k], [sx * 16 * k, -32 * k]], 3);
    form(g, vest, { v: sx < 0 ? .84 : .7, line: 1.6 * k, grad: .25, seed: sd, cyl: Math.PI / 2, cylK: .22, shade: 3 * k });
    stroke(g, [[sx * 7 * k, -56 * k], [sx * 13 * k, -50 * k]], 1.2 * k, { color: grey(.35), seed: sd + 20 });          // 翻领折线
    stroke(g, [[sx * 8 * k, -40 * k], [sx * 14 * k, -36 * k]], 1 * k, { color: grey(.4), seed: sd + 21, alpha: .7 });  // 衣褶
  }
  for (let i = 0; i < 3; i++) { g.fillStyle = grey(.12); g.beginPath(); g.arc(-6.5 * k, (-52 + i * 7) * k, 1.3 * k, 0, 7); g.fill(); }
  // 手臂：o.armUp 0..1（0 下垂，1 举过头顶托帽）；o.armR 右臂单独（致意）。粗墨线 + 一道受光的细线 + 带指节的手
  const arm = (sx, up) => {
    const sh = [sx * 18 * k, -58 * k], a = lerp(.35, -2.6, up) * sx, el = [sh[0] + Math.sin(a) * 22 * k * sx * sx, sh[1] + Math.cos(a) * 22 * k];
    const a2 = lerp(.1, -2.9, up) * sx, hd = [el[0] + Math.sin(a2) * 22 * k * sx * sx, el[1] + Math.cos(a2) * 22 * k];
    stroke(g, [sh, el, hd], 10 * k, { seed: 610 + sx });
    stroke(g, [[sh[0] - 2 * k * sx, sh[1] + 1 * k], [el[0] - 2.4 * k * sx, el[1]], [hd[0] - 2 * k * sx, hd[1] - 2 * k]], 1.3 * k, { color: grey(.48), seed: 614 + sx, alpha: .75 });
    form(g, ellipsePts(hd[0], hd[1], 5.5 * k, 5 * k, 0, 12), { v: .62, line: 1.4 * k, grad: .3, seed: 612 + sx, shade: 1.5 * k });
    for (let i = -1; i <= 1; i++) stroke(g, [[hd[0] + i * 2.2 * k, hd[1] + 1 * k], [hd[0] + i * 2.6 * k, hd[1] + 5 * k]], .9 * k, { color: grey(.25), seed: 616 + i });
    return hd;
  };
  const hL = arm(-1, o.armUp ?? 0), hR = arm(1, o.armR ?? o.armUp ?? 0);
  // 耳：外圈深、内耳浅、耳轮一道暗线
  for (const sx of [-1, 1]) {
    form(g, ellipsePts(sx * 21 * k, hy - 2 * k, 7.5 * k, 8.5 * k, 0, 14), { v: .5, line: 1.6 * k, grad: .3, seed: 620 + sx, shade: 2 * k });
    form(g, ellipsePts(sx * 21.5 * k, hy - 1.5 * k, 4.5 * k, 5.5 * k, 0, 12), { v: .74, line: 0, grad: .2, seed: 626 + sx });
    stroke(g, catmull([[sx * 19 * k, hy - 6 * k], [sx * 23 * k, hy - 4 * k], [sx * 22 * k, hy + 2 * k]], false, 4), 1 * k, { color: grey(.3), seed: 628 + sx });
  }
  // 头：毛边深色头 + 圆柱明暗 + 梳毛
  const head = fur(ellipsePts(0, hy, 20 * k, 19 * k, 0, 30), 1.8 * k, 622);
  form(g, head, { v: .3, line: 2.2 * k, grad: .32, seed: 622, shade: 4 * k, cyl: Math.PI / 2, cylK: .28, texture: furTex(622, 1, 9, 6) });
  const lx = (o.look ?? [0, 0])[0] * 3 * k, ly = (o.look ?? [0, 0])[1] * 2 * k;
  // 面具脸：中灰带受光渐变 + 暗面阴影；吻部凸起更亮
  const face = loop([[-13 * k, hy - 8 * k], [0, hy - 12 * k], [13 * k, hy - 8 * k], [14 * k, hy + 6 * k], [7 * k, hy + 15 * k], [-7 * k, hy + 15 * k], [-14 * k, hy + 6 * k]], 4);
  form(g, face, { v: .7, line: 1.6 * k, grad: .26, seed: 623, shade: 3.5 * k });
  form(g, ellipsePts(0, hy + 9 * k, 8.5 * k, 6 * k, 0, 18), { v: .82, line: 1 * k, grad: .2, seed: 629, shade: 2 * k });
  // 眼窝（暗）+ 眉骨一道墨线 + 眼下皱纹
  for (const sx of [-1, 1]) {
    form(g, ellipsePts(sx * 6 * k, hy - 1 * k, 5.2 * k, 4.6 * k, 0, 14), { v: .5, line: 0, grad: .2, seed: 630 + sx });
    stroke(g, catmull([[sx * 1.5 * k, hy - 6 * k], [sx * 6 * k, hy - 7.6 * k], [sx * 11 * k, hy - 5.4 * k]], false, 4), 1.6 * k, { color: grey(.15), seed: 632 + sx });
    stroke(g, catmull([[sx * 3 * k, hy + 4.4 * k], [sx * 6.5 * k, hy + 5.4 * k], [sx * 10 * k, hy + 3.8 * k]], false, 4), .9 * k, { color: grey(.35), seed: 634 + sx, alpha: .7 });
  }
  // 眼睛（大、亮、看观众）
  const blink = o.blink ?? 0;
  for (const sx of [-1, 1]) {
    g.fillStyle = grey(.06);
    g.beginPath(); g.ellipse(sx * 6 * k + lx, hy - 1 * k + ly, 3.2 * k, 3.6 * k * (1 - blink * .9), 0, 0, 7); g.fill();
    g.fillStyle = grey(.95); g.beginPath(); g.arc(sx * 6 * k + lx + 1 * k, hy - 2.2 * k + ly, .9 * k, 0, 7); g.fill();
  }
  // 鼻孔 + 嘴
  for (const sx of [-1, 1]) { g.fillStyle = grey(.12); g.beginPath(); g.ellipse(sx * 1.6 * k, hy + 7 * k, .9 * k, .6 * k, sx * .4, 0, 7); g.fill(); }
  stroke(g, [[-3 * k, hy + 6 * k], [0, hy + 5 * k], [3 * k, hy + 6 * k]], .9 * k, { seed: 624, color: grey(.35) });
  stroke(g, catmull([[-5 * k, hy + 11 * k], [0, hy + 12.5 * k + (o.smile ?? 0) * 2 * k], [5 * k, hy + 11 * k]], false, 4), 1.4 * k, { seed: 625 });
  g.restore();
  return { head: [x, y + hy], top: [x, y + hy - 18 * k], handL: [x + hL[0], y + hL[1]], handR: [x + hR[0], y + hR[1]] };
}

// ---------------- 斗牛犬：x = 胸前，y = 地面；dir 朝向；ph 奔跑相位；o = {sleep, bark} ----------------
export function drawDog(g, x, y, s, dir = 1, ph = 0, o = {}) {
  g.save(); g.translate(x, y); g.scale(dir, 1);
  const k = s / 100, run = o.run ?? 0, sleep = o.sleep ?? 0, a = ph * Math.PI * 2;
  const bob = -Math.abs(Math.sin(a)) * 8 * k * run;
  g.translate(0, bob + sleep * 24 * k);
  // 腿：奔跑时前后腿交替伸展
  const leg = (hx, phase, front) => {
    const sw = Math.sin(a + phase) * run, hip = [hx, -46 * k];
    const kn = [hx + sw * 16 * k, -24 * k + Math.max(0, -sw) * 6 * k];
    const ft = [hx + sw * 30 * k * (front ? 1 : .8) + (front ? 4 : -4) * k, sleep ? -6 * k : 0 - Math.max(0, Math.cos(a + phase)) * 10 * k * run];
    stroke(g, [hip, kn, ft], 12 * k, { seed: 700 + hx });
  };
  if (!sleep) { leg(-50 * k, Math.PI, false); leg(20 * k, 0, true); }
  // 身体：桶形
  form(g, loop([[-70 * k, -70 * k], [-20 * k, -82 * k], [24 * k, -80 * k], [40 * k, -62 * k], [32 * k, -36 * k], [-10 * k, -32 * k], [-62 * k, -38 * k], [-76 * k, -54 * k]], 5), { v: .74, line: 2.4 * k, grad: .25, seed: 710, shade: 7 * k });
  // 斑块
  form(g, ellipsePts(-40 * k, -60 * k, 18 * k, 13 * k, .2, 14), { v: .22, line: 0, seed: 711 });
  if (!sleep) { leg(-36 * k, Math.PI + .6, false); leg(32 * k, .6, true); }
  else for (const lx of [-50, 20]) stroke(g, [[lx * k, -36 * k], [lx * k + 26 * k, -30 * k]], 11 * k, { seed: 712 + lx });
  // 尾巴
  stroke(g, catmull([[-74 * k, -62 * k], [-88 * k, -76 * k - run * 8 * k], [-84 * k, -90 * k]], false, 5), 6 * k, { seed: 713 });
  // 头：宽下巴、垂耳；bark 0..1 张嘴
  const bark = o.bark ?? 0, hx = 50 * k, hy = -70 * k + sleep * 20 * k;
  form(g, loop([[hx - 16 * k, hy - 26 * k], [hx + 18 * k, hy - 30 * k], [hx + 38 * k, hy - 14 * k], [hx + 40 * k, hy + 6 * k], [hx + 20 * k, hy + 18 * k], [hx - 10 * k, hy + 16 * k], [hx - 22 * k, hy - 4 * k]], 5), { v: .78, line: 2.4 * k, grad: .2, seed: 720 });
  form(g, loop([[hx - 14 * k, hy - 26 * k], [hx + 2 * k, hy - 30 * k], [hx - 2 * k, hy - 6 * k], [hx - 16 * k, hy - 10 * k]], 4), { v: .2, line: 1.8 * k, seed: 721 });   // 垂耳
  // 下颚（张开）
  g.save(); g.translate(hx + 8 * k, hy + 10 * k); g.rotate(bark * .55);
  form(g, loop([[-14 * k, 0], [32 * k, -2 * k], [30 * k, 10 * k], [-8 * k, 12 * k]], 4), { v: .7, line: 2 * k, seed: 722 });
  if (bark > .2) for (let i = 0; i < 3; i++) { g.fillStyle = grey(.95); g.beginPath(); g.moveTo((4 + i * 9) * k, -1 * k); g.lineTo((8 + i * 9) * k, -6 * k); g.lineTo((12 + i * 9) * k, -1 * k); g.fill(); }
  g.restore();
  if (bark > .2) { form(g, loop([[hx + 14 * k, hy + 6 * k], [hx + 38 * k, hy + 4 * k], [hx + 34 * k, hy + 14 * k + bark * 12 * k], [hx + 14 * k, hy + 14 * k]], 3), { v: .12, line: 0, seed: 723 }); }
  // 鼻、眼
  form(g, ellipsePts(hx + 37 * k, hy - 6 * k, 6 * k, 5 * k, 0, 10), { v: .06, line: 1.4 * k, seed: 724 });
  if (sleep > .5) stroke(g, [[hx + 12 * k, hy - 12 * k], [hx + 22 * k, hy - 11 * k]], 2.4 * k, { seed: 725 });
  else { g.fillStyle = grey(.05); g.beginPath(); g.arc(hx + 18 * k, hy - 13 * k, 3.6 * k, 0, 7); g.fill(); stroke(g, [[hx + 10 * k, hy - 22 * k], [hx + 26 * k, hy - 18 * k]], 3 * k, { seed: 726 }); }
  // 项圈
  stroke(g, [[hx - 18 * k, hy - 2 * k], [hx - 10 * k, hy + 18 * k]], 5 * k, { color: grey(.15), seed: 727 });
  g.restore();
}

// ---------------- 1920s 有轨电车（侧面，朝右）：x = 车头最前端；yb = 轨面；L = 车长 ----------------
export function drawTram(g, x, yb, L, H = 560, wheelRot = 0) {
  const x0 = x - L, top = yb - H;
  // 集电杆 → 架空线
  stroke(g, [[x0 + L * .35, top + 6], [x0 + L * .78, top - 120]], 5, { seed: 801 });
  form(g, ellipsePts(x0 + L * .78, top - 122, 9, 6, 0, 10), { v: .2, line: 1.6, seed: 802 });
  // 车顶
  form(g, [[x0 + 30, top + 26], [x - 40, top + 26], [x - 70, top - 4], [x0 + 60, top - 4]], { v: .3, line: 2.6, grad: .15, seed: 803 });
  // 车身上部（浅色）+ 窗
  form(g, [[x0, top + 26], [x - 10, top + 26], [x + 6, top + 120], [x + 6, top + H * .5], [x0, top + H * .5]], { v: .78, line: 2.8, grad: .16, seed: 804, shade: 10 });
  const nw = Math.max(3, Math.round(L / 150));
  for (let i = 0; i < nw; i++) {
    const wx = x0 + 40 + i * (L - 150) / nw, ww = (L - 150) / nw - 26;
    form(g, rectPts(wx, top + 60, ww, H * .5 - 90), { v: .2, line: 2, grad: .25, seed: 810 + i });
    g.fillStyle = grey(.6, .4); g.beginPath(); g.moveTo(wx + 4, top + 64); g.lineTo(wx + ww * .5, top + 64); g.lineTo(wx + 4, top + 64 + (H * .5 - 90) * .6); g.fill();
  }
  // 车头挡风窗 + 车头灯
  form(g, [[x - 96, top + 60], [x - 26, top + 60], [x - 8, top + H * .5 - 30], [x - 96, top + H * .5 - 30]], { v: .24, line: 2, grad: .2, seed: 820 });
  // 车身下部（浅灰涂装腰板，深色镶边：让站在车前的深色礼服永远压在浅底上）+ 装饰线
  form(g, [[x0, top + H * .5], [x + 6, top + H * .5], [x + 10, yb - 70], [x0, yb - 70]], { v: .64, line: 2.8, grad: .18, seed: 821, shade: 8 });
  form(g, [[x0, top + H * .5], [x + 6, top + H * .5], [x + 6, top + H * .5 + 16], [x0, top + H * .5 + 16]], { v: .2, line: 1.6, seed: 829 });
  form(g, [[x0, yb - 92], [x + 9, yb - 92], [x + 10, yb - 70], [x0, yb - 70]], { v: .2, line: 1.6, seed: 828 });
  stroke(g, [[x0 + 10, top + H * .5 + 34], [x - 6, top + H * .5 + 34]], 2.4, { color: grey(.35), seed: 822 });
  for (let i = 1; i < 6; i++) { const px = x0 + i * L / 6; stroke(g, [[px, top + H * .5 + 40], [px, yb - 100]], 2, { color: grey(.4), seed: 823 + i }); }
  form(g, ellipsePts(x + 4, top + H * .5 + 70, 20, 20, 0, 16), { v: .95, line: 2.4, seed: 824 });
  // 排障器
  form(g, [[x - 20, yb - 70], [x + 30, yb - 18], [x + 30, yb - 6], [x - 30, yb - 6]], { v: .16, line: 2.2, seed: 825 });
  for (let k = 0; k < 5; k++) stroke(g, [[x - 20 + k * 9, yb - 66 + k * 9], [x - 26 + k * 10, yb - 8]], 1.6, { color: grey(.5), seed: 826 + k });
  // 车轮
  for (const wx of [x0 + L * .22, x0 + L * .78]) for (const dx of [-60, 60]) {
    const cx = wx + dx, cy = yb - 34;
    form(g, ellipsePts(cx, cy, 34, 34, 0, 18), { v: .12, line: 2.2, seed: 830 });
    for (let k = 0; k < 6; k++) { const a = wheelRot + k * Math.PI / 3; stroke(g, [[cx, cy], [cx + Math.cos(a) * 28, cy + Math.sin(a) * 28]], 2.2, { color: grey(.55), seed: 840 + k }); }
  }
  // 车号牌
  form(g, rectPts(x - 140, top + 30, 70, 26), { v: .92, line: 1.6, seed: 850 });
  g.save(); g.fillStyle = grey(.08); g.font = '900 22px "Noto Serif SC", serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.restore();
}

// ---------------- 木梯：底端 (bx,by) 到顶端 (tx,ty)；宽 w ----------------
export function drawLadder(g, bx, by, tx, ty, w = 70, rungs = 7) {
  const dx = tx - bx, dy = ty - by, L = Math.hypot(dx, dy), nx = -dy / L * w / 2, ny = dx / L * w / 2;
  for (const sgn of [-1, 1]) {
    const a = [bx + nx * sgn, by + ny * sgn], b = [tx + nx * sgn, ty + ny * sgn];
    form(g, [[a[0] - 6, a[1]], [a[0] + 6, a[1]], [b[0] + 6, b[1]], [b[0] - 6, b[1]]], { v: .62, line: 2.2, grad: .2, seed: 900 + sgn });
  }
  for (let i = 1; i <= rungs; i++) {
    const u = i / (rungs + .6), c = [bx + dx * u, by + dy * u];
    stroke(g, [[c[0] - nx, c[1] - ny], [c[0] + nx, c[1] + ny]], 6, { color: grey(.4), seed: 910 + i });
  }
}
export const ladderPt = (bx, by, tx, ty, u) => [bx + (tx - bx) * u, by + (ty - by) * u];

// ---------------- 砖墙墩（正面）：x0..x1，顶 top，地面 yb ----------------
export function drawWall(g, x0, x1, top, yb, seed = 3) {
  form(g, [[x0, top], [x1, top], [x1, yb], [x0, yb]], { v: .58, line: 2.6, grad: .14, seed, shade: 10 });
  g.strokeStyle = grey(.4, .55); g.lineWidth = 1.4;
  for (let yy = top + 34, r = 0; yy < yb - 4; yy += 30, r++) {
    g.beginPath(); g.moveTo(x0, yy); g.lineTo(x1, yy); g.stroke();
    for (let xx = x0 + (r % 2 ? 0 : 32); xx < x1; xx += 64) { g.beginPath(); g.moveTo(xx, yy); g.lineTo(xx, yy + 30); g.stroke(); }
  }
  form(g, [[x0 - 16, top - 18], [x1 + 16, top - 18], [x1 + 16, top + 6], [x0 - 16, top + 6]], { v: .76, line: 2.2, seed: seed + 1, shade: 5 });   // 墙帽
}

// ---------------- 狗屋 ----------------
export function drawKennel(g, x, yb, w = 220, h = 180) {
  form(g, [[x, yb], [x + w, yb], [x + w, yb - h * .62], [x + w / 2, yb - h], [x, yb - h * .62]], { v: .5, line: 2.4, grad: .2, seed: 950, shade: 8 });
  form(g, [[x - 14, yb - h * .6], [x + w / 2, yb - h - 14], [x + w + 14, yb - h * .6], [x + w + 4, yb - h * .55], [x + w / 2, yb - h + 2], [x - 4, yb - h * .55]], { v: .25, line: 2, seed: 951 });
  form(g, loop([[x + w * .3, yb], [x + w * .3, yb - h * .4], [x + w * .5, yb - h * .55], [x + w * .7, yb - h * .4], [x + w * .7, yb]], 5), { v: .08, line: 2, seed: 952 });
  for (let k = 1; k < 4; k++) stroke(g, [[x + 4, yb - k * h * .16], [x + w - 4, yb - k * h * .16]], 1.4, { seed: 953 + k, alpha: .6 });
}
