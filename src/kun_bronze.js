// 青铜古鲲（变体「青铜古鲲」）：沉睡三千年的商周青铜器活了过来。
// 形体：石斑鱼式的大头、下撇的阔口、厚唇；尾柄收细、尾鳍开叉；背上四五片、腹下若干「礼器刃」式的鳍（戈形，后缘带云纹卷钩）。
// 纹样：身体按 (U, s) 展开——U = 沿体侧中线量的弧长，s = 截面上离体侧中线的弧长（左右镜像，两侧纹样对称）。
//       用 Canvas2D 在展开图上画凸起纹带（云雷纹、回纹带、鳞纹、饕餮面、臣字目、眉、角、唇、鳃盖线、扉棱）、
//       绿松石镶嵌区、玉、刻槽，再用 EDT（Felzenszwalb 线性时间距离变换）转成有符号距离场，打成一张 RGBA 纹理：
//         · CPU：顶点按纹样高度沿法线位移（侧影上能看到浮雕起伏）
//         · GPU：同一高度函数做屏幕导数凹凸（纹带一侧受光、一侧压暗）；纹带两沿画抖动墨线；绿松石马赛克、玉、铜锈、紫锈、地衣
//       鳍：THREE.Shape 挤出成带倒角的厚片；鳍面纹样用「离外缘的距离场」现算（外圈纹带、绿松石通道、内圈纹带、阿基米德旋涡）。
// 坐标：鲲局部空间，长约 600，头朝 +X，上为 +Y，原点在身体中心（与 kun.js 相同，换进正片只改 import）。
// 动画：setPose(ts) 的 ts 由调用方量化（一拍三：f = Math.round(t*24); ts = Math.floor(f/3)*3/24）。
//       脊柱行波在 GPU 顶点着色器里做：竖向起伏 + 横向摆尾（鱼是左右摆；鲲在天上也要上下起伏，两个分量错相位）。
//       身体、鳍逐顶点弯；植被按实例原点整体跟着弯；鳍另有绕根部的摆动（uFinAng），垂苔、蕨叶自己飘。
// 确定性：随机全部来自 mulberry(固定种子)、单纯形噪声(固定种子)；没有 Date.now / Math.random。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise3D } from '../engine/core/noise.js';
import { mulberry, clamp, lerp, ss, seg, TAU } from '../engine/core/math.js';
import { profileBody, sideAngle, axisStations, ringsAt, loftRings, unwrap } from '../engine/form/loft.js';
import { pitchYawWave } from '../engine/form/bend.js';
import { clump, petalFan } from '../engine/form/props.js';
import { fern, strands } from '../engine/form/plants.js';
import { samplersOn, placeOnSurface as place, pickFrom as pick, instanced } from '../engine/form/scatter.js';
import { autoBlink, poseEyes, pickEye, mountEyes, lidShells, eyeFrame } from '../engine/form/eye.js';
import { sdfFromImage, blur5, shapeInside } from '../engine/form/sdf.js';
import { catmull, spiral as curlPts, withSpiral as withCurl, squareSpiral as rectSpiral, pathShape as shapeFrom } from '../engine/form/curves.js';
import { makeBronzeToon, bindBronze, BRONZE, BRONZE_PRESETS } from './toon_bronze.js';

const sstep = (a, b, x) => ss(seg(x, a, b));
const UP = new THREE.Vector3(0, 1, 0);

// ───────────────────────── 身体轮廓（x：-192 尾柄末端 … +303 吻端） ─────────────────────────
const X_TAIL = -192, X_SNOUT = 306;
// 头：额头到吻端是一条斜直的坡（楔形吻），下颌厚重圆鼓（石斑鱼 / 青铜鱼形器的「大头阔口」）
const PX = [-192, -175, -150, -115, -70, -20, 30, 80, 130, 170, 205, 235, 260, 280, 294, 302, 306];
const PT = [25, 27, 32, 42, 56, 68, 78, 85, 87, 84, 71, 58, 45, 34, 25, 15, 5];              // 顶线 y
const PB = [-24, -26, -31, -41, -55, -68, -80, -88, -91, -91, -87, -79, -67, -53, -39, -24, -7];  // 底线 y
const PW = [11, 13, 17, 25, 34, 42, 49, 54, 56, 56, 53, 47, 40, 31, 21, 12, 3];              // 半宽 z
// 放样体（未弯曲、未位移）。phi：0 = +Z 侧水平，π/2 = 背中线。截面是上下两半不同指数的超椭圆（像铸件，略方），头部按 headBulge 鼓起
const body = profileBody({
  xs: PX, top: PT, bottom: PB, width: PW, exp: [2.35, 2.6],
  deform(p) { const k = 1 + headBulge(p.x, sideAngle(p.c, p.s)); p.y = p.yc + p.dy * k; p.z = p.dz * k; },
});
const { top: fT, bottom: fB, width: fW, mid: yMid, point: bodyPoint, normal: bodyNormal } = body;
// 头部鼓包（截面半径的相对增量）：眼球所在的圆鼓、眼上的眉弓、颊部
function headBulge(x, ph) {
  if (x < 140) return 0;
  const ex = (x - EYE_X) / 24, ep = (ph - EYE_PH) / 0.3;
  const bx = (x - EYE_X + 4) / 30, bp = (ph - EYE_PH - 0.28) / 0.13;
  const cx = (x - 232) / 26, cp = (ph + 0.06) / 0.22;
  return 0.055 * Math.exp(-(ex * ex + ep * ep)) + 0.07 * Math.exp(-(bx * bx + bp * bp)) + 0.03 * Math.exp(-(cx * cx + cp * cp));
}
// 侧角 ph：把左右两侧折到同一侧（-π/2 腹中线 … 0 体侧中线 … π/2 背中线），见 engine/form/loft.js 的 sideAngle
const phiOf = (ph, side) => side > 0 ? ph : Math.PI - ph;
// 嘴线（侧角，越往后越往下撇）：吻端 -0.03 → 嘴角（x≈203）-0.23
const MOUTH_X0 = 212;
const mouthPh = x => -0.02 - 0.22 * Math.pow(clamp((X_SNOUT - x) / (X_SNOUT - MOUTH_X0)), 1.7);
// 眼（白玉眼，大而突出）
const EYE_X = 196, EYE_PH = 0.36, RE = 15;

// ───────────────────────── (U, s) 展开参数：engine/form/loft.js 的 unwrap（U = 沿体侧中线的弧长，s = 截面上离体侧中线的弧长） ─────────────────────────
const buildParam = () => unwrap(body, X_TAIL, X_SNOUT);
// 距离变换、模糊：engine/form/sdf.js；画纹样用的折线（样条、圆旋涡、方旋涡）：engine/form/curves.js

// ───────────────────────── 身体纹样（展开图） ─────────────────────────
function drawBodyPattern(PRM, K) {
  const Umax = PRM.Ucap + 2, smax = PRM.smax + 2;
  const W = Math.ceil(Umax * K), H = Math.ceil(2 * smax * K);
  const mk = () => {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.setTransform(K, 0, 0, -K, 0, smax * K);
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.miterLimit = 6;
    return { cv, g };
  };
  const band = mk(), zone = mk(), jade = mk(), groove = mk();
  const P = PRM.P, st = PRM.st, sb = PRM.sb, xU = PRM.xU, Ux = PRM.Ux;
  const line = (G, pts, w, cap = 'butt', join = 'miter', close = false) => {
    if (pts.length < 2) return;
    const g = G.g; g.lineWidth = w; g.lineCap = cap; g.lineJoin = join;
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); if (close) g.closePath(); g.stroke();
  };
  const fill = (G, pts) => { const g = G.g; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); g.fill(); };
  const disc = (G, cx, cy, r) => { const g = G.g; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill(); };
  const ring = (G, cx, cy, r, w) => { const g = G.g; g.lineWidth = w; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke(); };
  const bodyCurve = (xp, per = 10) => catmull(xp.map(([x, ph]) => P(x, ph)), per);
  const along = (x0, x1, f, step = 1.5) => { const pts = []; const n = Math.max(2, Math.ceil(Math.abs(x1 - x0) / step)); for (let i = 0; i <= n; i++) { const x = lerp(x0, x1, i / n); pts.push([Ux(x), f(x)]); } return pts; };
  const feat = {};

  // —— 纹饰带的分界（弦纹）——
  const F1 = 0.43, F2 = 0.40, F3 = 0.8;
  const XA = -178, XB = 130;
  const BB = 3.6;   // 弦纹带宽
  const b1 = x => F1 * st(x), b2 = x => -F2 * sb(x), b3 = x => F3 * st(x);
  line(band, along(XA, XB, b1), BB); line(band, along(XA, XB, b2), BB); line(band, along(XA - 4, XB + 8, b3), BB);
  line(band, along(-186, 176, x => -sb(x)), 4.6);                                       // 腹中线（龙骨）

  // —— 主纹饰带：大方旋涡（雷纹），一挂一立交替；第三格嵌玉璧。绿松石只嵌在旋涡的芯里（外圈留青铜）——
  const cells = [];
  {
    let u1 = Ux(XB) - BB * 0.5, idx = 0;
    const uA = Ux(XA) + 4;
    while (u1 > uA + 12) {
      const xc0 = xU(u1 - 25), top = b1(xc0), bot = b2(xc0), Hh = top - bot;
      let w = clamp((idx === 0 ? 1.1 : 0.92) * Hh, 16, 100);
      if (u1 - w < uA) w = u1 - uA;
      if (w < 14) break;
      const u0 = u1 - w, xc = xU((u0 + u1) / 2);
      cells.push({ u0, u1, top: b1(xc), bot: b2(xc), idx, xc });
      const pr = clamp((b1(xc) - b2(xc)) / 8.6, 4.8, 9.6);
      u1 = u0 - pr * 0.58; idx++;
    }
  }
  for (const c of cells) {
    const Hh = c.top - c.bot, pr = clamp(Hh / 8.6, 4.8, 9.6), bw = pr * 0.44;
    const L = c.u0 + bw / 2, Rr = c.u1 - bw / 2;
    if (c.idx === 2) {   // 玉璧：圆环形的白玉，璧孔里嵌绿松石；外框纹带
      line(band, [[L, c.bot], [L, c.top]], bw); line(band, [[Rr, c.bot], [Rr, c.top]], bw);
      const uc = (c.u0 + c.u1) / 2, sc = (c.top + c.bot) / 2, ro = Math.min(c.u1 - c.u0, Hh) * 0.36, ri = ro * 0.36;
      jade.g.beginPath(); jade.g.arc(uc, sc, ro, 0, TAU); jade.g.arc(uc, sc, ri, 0, TAU, true); jade.g.fill('evenodd');
      disc(zone, uc, sc, ri + 0.5);
      ring(band, uc, sc, ro + bw * 0.9, bw * 0.75);
      feat.bi = { uc, sc, ro, ri };
      continue;
    }
    const hang = c.idx % 2 === 1, flip = (c.idx >> 1) % 2 === 1;
    let pts = rectSpiral(L, Rr, c.bot + pr, c.top, pr);                     // 挂式：从上边框垂下
    let zb = [L + pr, Rr - pr, c.bot + 2 * pr, c.top - 2 * pr];             // 旋涡芯（第二圈以内）
    if (!hang) { pts = pts.map(([u, s]) => [u, c.top + c.bot - s]); zb = [zb[0], zb[1], c.top + c.bot - zb[3], c.top + c.bot - zb[2]]; }
    if (flip) { pts = pts.map(([u, s]) => [c.u0 + c.u1 - u, s]); zb = [c.u0 + c.u1 - zb[1], c.u0 + c.u1 - zb[0], zb[2], zb[3]]; }
    line(band, pts, bw);
    if (zb[1] - zb[0] > pr && zb[3] - zb[2] > pr * 0.5) zone.g.fillRect(zb[0] - bw * 0.3, zb[2] - bw * 0.3, zb[1] - zb[0] + bw * 0.6, zb[3] - zb[2] + bw * 0.6);
  }

  // —— 上纹饰带：小回纹（不镶嵌，凹槽里长苔藓）——
  {
    let u1 = Ux(XB - 4), idx = 0; const uA = Ux(XA) + 3;
    while (u1 > uA + 8) {
      const xc0 = xU(u1 - 12), Hh = b3(xc0) - b1(xc0);
      let w = clamp(0.86 * Hh, 10, 52); if (u1 - w < uA) w = u1 - uA; if (w < 9) break;
      const u0 = u1 - w, xc = xU((u0 + u1) / 2), top = b3(xc), bot = b1(xc), pr = clamp((top - bot) / 6.2, 3.8, 7.2), bw = pr * 0.44;
      let pts = rectSpiral(u0 + bw / 2, u1 - bw / 2, bot + pr, top, pr);
      if (idx % 2 === 1) pts = pts.map(([u, s]) => [u0 + u1 - u, top + bot - s]);   // 隔一个转 180°
      line(band, pts, bw);
      u1 = u0 - pr * 0.56; idx++;
    }
  }

  // —— 下纹饰带：鳞纹（叠瓦式半圆，凸面朝尾）——
  {
    const xFront = 122, xBack = -172;
    let u = Ux(xFront), col = 0;
    while (u > Ux(xBack)) {
      const x = xU(u), sbx = sb(x), r = clamp(0.085 * sbx, 3.6, 9.5), top = b2(x) - BB * 0.5 - 0.4, bot = -sbx + 2.4, ds = 2 * r;
      const off = col % 2 ? r : 0;
      for (let sC = top - r - off; sC - r * 0.3 > bot; sC -= ds) {
        const pts = []; for (let k = 0; k <= 20; k++) { const a = Math.PI / 2 + Math.PI * k / 20; pts.push([u + r * Math.cos(a), sC + r * Math.sin(a)]); }
        line(band, pts, clamp(r * 0.3, 1.4, 3.0), 'round', 'round');
      }
      u -= r; col++;
    }
  }

  // —— 头：鳃盖线、臣字目、眉角、鼻卷、颊旋、唇、颌旋、额上小玉目、扉棱 ——
  const gill = bodyCurve([[156, 1.42], [145, 1.02], [137, 0.52], [134, 0.0], [136, -0.5], [144, -0.98], [158, -1.4]]);
  line(band, gill, 5.6, 'round', 'round');
  line(groove, bodyCurve([[139, 0.92], [132, 0.45], [129, 0.0], [131, -0.45], [138, -0.88]]).map(([u, s]) => [u - 6, s]), 2.2, 'round', 'round');
  const [Ue, se] = P(EYE_X, EYE_PH);
  feat.eye = [Ue, se];
  {
    // 臣字目：杏仁形眼眶，两角尖；前角向前下勾卷，后角拖长向后上卷
    const a = 1.5 * RE, b = 1.08 * RE, eyeRing = [];
    for (let i = 0; i < 72; i++) { const t = i / 72 * TAU, c = Math.cos(t), sn = Math.sin(t); eyeRing.push([Ue + a * c, se + b * Math.sign(sn) * Math.pow(Math.abs(sn), 1.0) * (1 - 0.32 * c * c)]); }
    line(band, eyeRing, 4.6, 'round', 'miter', true);
    line(band, withCurl(catmull([[Ue + a - 1, se], [Ue + a + 8, se - 2], [Ue + a + 13, se - 9]], 6), [Ue + a + 7, se - 12], 1.1), 4.0, 'round', 'round');
    line(band, withCurl(catmull([[Ue - a + 1, se], [Ue - a - 13, se + 1], [Ue - a - 27, se + 5]], 6), [Ue - a - 30, se + 14], 1.35), 4.4, 'round', 'round');
    // 眉：粗，从前上方拱过眼，向后上方卷成大旋涡（像牛角）
    const browPath = catmull([[Ue + a * 1.05, se + b * 0.5], [Ue + a * 0.5, se + b + 8], [Ue - a * 0.2, se + b + 11], [Ue - a - 7, se + b + 6]], 8);
    line(band, withCurl(browPath, [Ue - a - 13, se + b + 17], 1.45), 5.6, 'round', 'round');
    const lower = []; for (let i = 0; i <= 26; i++) { const t = Math.PI * 0.06 + Math.PI * 0.88 * i / 26; lower.push([Ue + a * Math.cos(t), se + b * Math.sin(t) * (1 - 0.32 * Math.cos(t) ** 2)]); }
    fill(zone, browPath.concat(lower));                                    // 眉与眼眶之间：月牙形镶绿松石
    disc(zone, Ue - a - 13, se + b + 17, 9);                              // 眉角旋涡芯
    // 鼻卷：吻背上一对向前卷的云纹（饕餮的鼻翼）
    const [Un, sn] = P(282, 0.5);
    line(band, withCurl(catmull([[Ue + a * 0.5, se + b + 8], [Un - 22, sn + 6], [Un - 4, sn + 7], [Un + 5, sn - 1]], 8), [Un - 2, sn - 2], 1.3), 4.4, 'round', 'round');
    disc(zone, Un - 2, sn - 2, 6.5);
    // 颊：眼下、嘴角上方一个大云纹旋涡，尾巴接到嘴角
    const [Uc, sc] = P(236, -0.02);
    const [Um, sm] = P(MOUTH_X0 + 1, mouthPh(MOUTH_X0 + 1));
    line(band, withCurl(catmull([[Um - 3, sm + 6], [Uc - 15, sc - 3], [Uc - 5, sc + 13], [Uc + 11, sc + 6]], 8), [Uc, sc + 1], 1.55), 4.4, 'round', 'round');
    disc(zone, Uc, sc + 1, 10.5);
    feat.cheek = [Uc, sc];
    // 颌：沿下颌一条带，往后下卷进喉部
    const jaw = []; for (let x = 298; x >= 222; x -= 4) jaw.push(P(x, mouthPh(x) - 0.36 - 0.07 * sstep(298, 222, x)));
    const [Uj, sj] = P(206, -0.88);
    line(band, withCurl(catmull(jaw, 6), [Uj, sj], 1.45), 4.6, 'round', 'round');
    disc(zone, Uj, sj, 8);
    // 鳃盖：一个大云纹旋涡，尾巴接到鳃盖线上
    const [Uo, so] = P(162, -0.2);
    const [Ug, sg] = P(138, 0.25);
    line(band, withCurl(catmull([[Ug + 3, sg], [Uo + 4, so + 26], [Uo + 21, so + 8]], 8), [Uo + 2, so + 2], 1.55), 4.6, 'round', 'round');
    disc(zone, Uo + 2, so + 2, 11);
    // 下颌：两个小卷
    for (const [xx, pp] of [[262, -0.62], [240, -0.7]]) { const [Uk, sk] = P(xx, pp); line(band, curlPts(Uk, sk, 5.5, 1.3, 1, 1.0), 3.2, 'round', 'round'); }
    // 鳃盖内侧再一道弦纹（双线鳃盖）
    line(band, bodyCurve([[148, 0.86], [143, 0.45], [141, 0.0], [143, -0.45], [149, -0.86]]), 3.0, 'round', 'round');
    // 下颌一排乳钉（商周青铜鼎上常见的乳钉纹）
    for (let x = 290; x > 226; x -= 9.5) { const [Ub, sbb] = P(x, mouthPh(x) - 0.62 - 0.05 * sstep(290, 226, x)); disc(band, Ub, sbb, 2.5); }
    // 额上小玉目（饕餮的第二只眼）+ 一圈纹带
    const [Uf, sf] = P(258, 0.74);
    disc(jade, Uf, sf, 3.6); ring(band, Uf, sf, 6.4, 2.8);
  }
  // 嘴：刻槽 + 上下厚唇一圈（嘴角圆收）
  {
    const m = []; for (let x = X_SNOUT + 0.5; x >= MOUTH_X0; x -= 2) m.push(P(x, mouthPh(x)));
    line(groove, m, 3.0, 'round', 'round');
    const off = 5.4, up = m.map(([u, s]) => [u, s + off]), dn = m.map(([u, s]) => [u, s - off]).reverse();
    const [ue, sE] = m[m.length - 1], arc = [];
    for (let k = 1; k < 12; k++) { const t = Math.PI / 2 + Math.PI * k / 12; arc.push([ue + off * Math.cos(t), sE + off * Math.sin(t)]); }
    line(band, up.concat(arc, dn), 5.4, 'round', 'round');
    feat.mouth = m;
  }
  // 头顶扉棱：背中线上一节一节的脊（只在头部，身体背上让给苔藓和背鳍）
  for (let x = 290; x > 156; x -= 17) line(band, along(x, x - 12, xx => st(xx), 1), 6.4);
  // 尾柄：一圈弦纹收口
  line(band, bodyCurve([[-182, 1.5], [-182, 0], [-182, -1.5]], 6), 3.2);

  // 读回像素 → 有符号距离场
  const img = c => c.g.getImageData(0, 0, W, H).data;
  const Rr = 6;
  const dBand = blur5(sdfFromImage(img(band), W, H, 0, K, Rr), W, H);
  const dZone = blur5(sdfFromImage(img(zone), W, H, 0, K, Rr), W, H);
  const dJade = blur5(sdfFromImage(img(jade), W, H, 0, K, Rr, true), W, H);
  const dGroove = blur5(sdfFromImage(img(groove), W, H, 0, K, Rr, true), W, H);
  // 半精度浮点（8 位量化会让凹凸在纹带边上起梳齿状的条纹）
  const tex = new Uint16Array(W * H * 4), toH = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < W * H; i++) { tex[i * 4] = toH(dBand[i]); tex[i * 4 + 1] = toH(dZone[i]); tex[i * 4 + 2] = toH(dJade[i]); tex[i * 4 + 3] = toH(dGroove[i]); }
  const sample = (arr, u, s) => {
    const fx = u * K - 0.5, fy = (smax - s) * K - 0.5;
    const x0 = clamp(Math.floor(fx), 0, W - 2), y0 = clamp(Math.floor(fy), 0, H - 2), tx = clamp(fx - x0), ty = clamp(fy - y0);
    const i = y0 * W + x0;
    return lerp(lerp(arr[i], arr[i + 1], tx), lerp(arr[i + W], arr[i + W + 1], tx), ty);
  };
  return { W, H, K, Umax, smax, Rr, tex, dBand, dZone, dJade, dGroove, sample, feat, canvases: { band: band.cv, zone: zone.cv, jade: jade.cv, groove: groove.cv } };
}
// 纹样高度：GPU 凹凸用 HB…（坡宽约 2 米）；CPU 顶点位移用更缓更低的同形函数（只为侧影起伏，网格采样不出台阶）
const HB = 2.1, HI = 0.7, HJ = 1.3, HG = 2.6;
function heightOf(dB, dZ, dJ, dG) {
  let h = 1.7 * sstep(1.5, -1.5, dB);
  h -= HI * sstep(0.8, -0.8, dZ) * sstep(-1.2, 1.2, dB);
  h += HJ * sstep(1.2, -1.0, dJ);
  h -= 2.0 * sstep(1.3, -1.0, dG);
  return h;
}

// ───────────────────────── 弯曲（GLSL 与 JS 一致）：竖向 + 横向两个分量 ─────────────────────────
const WAVE = pitchYawWave('kun', { e0: 0.2, sMax: 1.15 });
// finFlap：鳍先绕自己的根部转（uFinAng），再跟着脊柱弯
function bendHooks({ extraPars = '', extraBegin = '', extraNormal = '', finFlap = false } = {}) {
  return WAVE.hooks({
    extraPars: (finFlap ? FIN_FLAP_GLSL : '') + extraPars, extraBegin, preBend: finFlap ? 'transformed = finFlap( transformed );\n' : '',
    extraNormal: extraNormal + (finFlap ? 'objectNormal = finFlapN( objectNormal );\n' : ''), normalX: finFlap ? 'finFlap( position ).x' : 'position.x',
  });
}
// 鳍绕根部转（Rodrigues）：aPiv.xyz 转轴上一点，aPiv.w 鳍号，aAx 转轴方向
const FIN_FLAP_GLSL = /* glsl */`
attribute vec4 aPiv; attribute vec3 aAx;
uniform float uFinAng[ 16 ];
vec3 finRot( vec3 v, vec3 ax, float a ) { float c = cos( a ), s = sin( a ); return v * c + cross( ax, v ) * s + ax * dot( ax, v ) * ( 1.0 - c ); }
vec3 finFlap( vec3 p ) { return finRot( p - aPiv.xyz, aAx, uFinAng[ int( aPiv.w + 0.5 ) ] ) + aPiv.xyz; }
vec3 finFlapN( vec3 n ) { return finRot( n, aAx, uFinAng[ int( aPiv.w + 0.5 ) ] ); }
`;
// ───────────────────────── 身体材质（纹样、凹凸、墨线） ─────────────────────────
const BODY_FRAG_PARS = /* glsl */`
uniform sampler2D uPat;
uniform vec4 uPatXf;          // x = K/宽像素，y = K/高像素，z = smax，w = 距离编码范围
uniform vec3 uBzBand, uBzCopper, uBzChannel, uBzDark, uBzBloom, uBzRust, uBzCuprite;
uniform vec3 uBzTq1, uBzTq2, uBzTq3, uBzGrout, uBzJade, uBzJade2, uBzLichen, uBzLichen2;
uniform vec4 uBzH;            // 凸带高、镶嵌凹、玉凸、刻槽深
uniform float uBzBump;
varying vec2 vUV;
vec4 bzTex( vec2 uv ) { return texture2D( uPat, vec2( uv.x * uPatXf.x, ( uPatXf.z - uv.y ) * uPatXf.y ) ); }
vec4 bzDec( vec4 t ) { return t; }   // 纹理里直接存米制距离（半精度浮点）
float bzHeight( vec4 d ) {
  float h = uBzH.x * toonSS( 1.0, -1.0, d.x );
  h -= uBzH.y * toonSS( 0.5, -0.5, d.y ) * toonSS( -1.0, 1.0, d.x );
  h += uBzH.z * toonSS( 0.9, -0.7, d.z );
  h -= uBzH.w * toonSS( 0.9, -0.7, d.w );
  return h;
}
// 共用：铜锈斑驳（物体空间、硬边分档）→ 返回底色；带 = 凸起纹带蒙版，inl = 镶嵌，jad = 玉
vec3 bzPatina( vec3 base, vec3 Pobj, float band, float inl, float jad, float dBand ) {
  vec3 Pn = Pobj * 0.021;
  vec3 wq = vec3( toonNoise( Pn * 0.7 + 3.1 ), toonNoise( Pn * 0.7 + 9.4 ), toonNoise( Pn * 0.7 + 4.2 ) );
  float n1 = toonFbm( Pn + wq * 0.8 ), n2 = toonFbm( Pn * 1.9 + 21.0 - wq * 0.5 ), n3 = toonFbm( Pn * 2.3 + 47.0 + wq );
  float a1 = max( fwidth( n1 ), 1e-4 ), a2 = max( fwidth( n2 ), 1e-4 ), a3 = max( fwidth( n3 ), 1e-4 );
  float bloom = smoothstep( 0.12 - a1, 0.12 + a1, n1 );
  vec3 c = mix( base, uBzBloom, bloom * 0.45 );
  c = mix( c, uBzDark, smoothstep( 0.22 - a2, 0.22 + a2, n2 ) * 0.5 );
  vec3 bc = mix( uBzBand, uBzBloom, bloom * 0.35 );
  float worn = smoothstep( -1.1, -0.5, dBand ) * smoothstep( -0.1, 0.3, n2 + 0.15 );
  bc = mix( bc, uBzCopper, worn * 0.6 );
  c = mix( c, bc, band );
  float rust = smoothstep( 0.34 - a3, 0.34 + a3, n3 ), core = smoothstep( 0.5 - a3, 0.5 + a3, n3 );
  c = mix( c, uBzRust, rust * 0.6 * ( 1.0 - inl ) * ( 1.0 - jad ) );
  c = mix( c, uBzRust * vec3( 0.62, 0.56, 0.7 ), core * 0.5 * ( 1.0 - inl ) * ( 1.0 - jad ) );
  float n4 = toonFbm( Pn * 0.9 + 83.0 - wq * 0.6 ), a4 = max( fwidth( n4 ), 1e-4 );
  c = mix( c, mix( c, uBzCuprite, 0.5 ), smoothstep( 0.24 - a4, 0.24 + a4, n4 ) * ( 1.0 - inl ) * ( 1.0 - jad ) * 0.75 );
  float nS = toonNoise( Pobj * 0.16 + wq * 2.0 + 57.0 ), aS = max( fwidth( nS ), 1e-4 );
  c = mix( c, uBzCuprite, smoothstep( 0.62 - aS, 0.62 + aS, nS ) * 0.6 * ( 1.0 - inl ) * ( 1.0 - jad ) );
  return c;
}
vec3 bzMosaic( vec2 uv, float px ) {
  vec3 tv = bzVor( uv / 2.3 );
  vec3 tq = mix( uBzTq1, uBzTq2, step( 0.6, tv.z ) ); tq = mix( tq, uBzTq3, step( 0.86, tv.z ) );
  float ga = max( fwidth( tv.y - tv.x ), 1e-4 );
  float grout = ( 1.0 - smoothstep( 0.07, 0.07 + 1.3 * ga, tv.y - tv.x ) ) * smoothstep( 0.42, 0.16, px );
  return mix( tq, uBzGrout, grout * 0.75 );
}
`;
const BODY_ALBEDO = /* glsl */`
vec2 bzUV = vUV;
vec4 bzD = bzDec( bzTex( bzUV ) );
float bzPx = max( length( fwidth( bzUV ) ) * 0.7071, 1e-4 );     // 每个渲染像素多少米
{
  float aa = 0.6 * bzPx;
  float band = 1.0 - smoothstep( -aa, aa, bzD.x );
  float zone = 1.0 - smoothstep( -aa, aa, bzD.y );
  float inl = zone * ( 1.0 - band );
  float jad = 1.0 - smoothstep( -aa, aa, bzD.z );
  float grv = 1.0 - smoothstep( -aa, aa, bzD.w );
  vec3 c = bzPatina( diffuseColor.rgb, vToonObj, band, inl, jad, bzD.x );
  // 纹带脚下的凹缝：压深一点（苔藓就长在这里）
  float foot = smoothstep( 1.6, 0.4, bzD.x ) * ( 1.0 - band ) * ( 1.0 - inl );
  c = mix( c, uBzChannel, foot * 0.4 );
  // 地衣：小玫瑰形斑
  vec3 lv = bzVor( bzUV / 6.5 + 17.0 );
  float lr = 0.2 + 0.16 * fract( lv.z * 7.31 ), lw2 = toonNoise( vec3( bzUV * 1.3, 2.0 ) ) * 0.09, la = max( fwidth( lv.x + lw2 ), 1e-4 );
  float lich = ( 1.0 - smoothstep( lr - la, lr + la, lv.x + lw2 ) ) * step( lv.z, 0.24 ) * ( 1.0 - band ) * ( 1.0 - inl ) * ( 1.0 - jad );
  lich *= smoothstep( -0.05, 0.25, toonNoise( vToonObj * 0.028 + 5.0 ) ) * smoothstep( 1.0, 0.5, bzPx );
  c = mix( c, mix( uBzLichen2, uBzLichen, smoothstep( lr * 0.2, lr * 0.8, lv.x ) ), lich * 0.85 );
  // 绿松石马赛克
  c = mix( c, bzMosaic( bzUV, bzPx ), inl );
  // 玉：温润的乳白，带一点青
  vec3 jc = mix( uBzJade, uBzJade2, smoothstep( -0.2, 0.5, toonNoise( vec3( bzUV * 0.22, 3.0 ) ) ) * 0.6 );
  c = mix( c, jc, jad );
  c = mix( c, uBzChannel * 0.5, grv );
  diffuseColor.rgb = c;
  // 墨线（按墨线时钟抖动，一拍二）：纹带两沿、玉边、刻槽
  vec3 jq = vec3( bzUV * 0.32, uInkTime * 0.731 );
  float jit = toonNoise( jq ) * 0.16;
  float lw = 1.3 * bzPx;
  float fade = smoothstep( 1.6, 0.75, bzPx );
  float inkB = 1.0 - smoothstep( 0.5 * lw, 1.5 * lw, abs( bzD.x + jit ) );
  float inkJ = 1.0 - smoothstep( 0.5 * lw, 1.5 * lw, abs( bzD.z + jit ) );
  float inkG = 1.0 - smoothstep( 0.9 * lw, 2.2 * lw, abs( bzD.w + jit * 0.5 ) );
  toonInk = max( toonInk, max( inkB * 0.82, max( inkJ * 0.75, inkG ) ) * fade );
  toonLift = max( inl * 0.4, jad * 0.38 );
}
`;
const BODY_NORMAL = /* glsl */`
{
  toonPassN = normal; toonPassUse = 1.0;
  toonRimN = normal; toonRimUse = 1.0;
  float e = 0.5;
  float hx1 = bzHeight( bzDec( bzTex( bzUV + vec2( e, 0.0 ) ) ) ), hx0 = bzHeight( bzDec( bzTex( bzUV - vec2( e, 0.0 ) ) ) );
  float hy1 = bzHeight( bzDec( bzTex( bzUV + vec2( 0.0, e ) ) ) ), hy0 = bzHeight( bzDec( bzTex( bzUV - vec2( 0.0, e ) ) ) );
  vec2 g = vec2( hx1 - hx0, hy1 - hy0 ) / ( 2.0 * e );
  vec2 dHdxy = vec2( dot( g, dFdx( bzUV ) ), dot( g, dFdy( bzUV ) ) ) * uBzBump;
  normal = bzPerturb( - vViewPosition, normal, dHdxy, faceDirection );
}
`;

// ───────────────────────── 鳍：形状、距离场、材质 ─────────────────────────
// 路径（单位：米）。'M' 起点，'C' 三次贝塞尔，'L' 直线。根部埋进身体
const FIN_PATHS = {
  // 背鳍：戈刃 / 火舌形——前缘一条长弧向后上扬，刃尖朝后，后缘再出一个尖钩（归一化：高 1）
  dorsal: [['M', 0.05, -0.22], ['C', 0.12, 0.26, 0.04, 0.7, -0.28, 0.95], ['C', -0.44, 1.07, -0.7, 1.1, -0.98, 1.0],
    ['C', -0.78, 0.93, -0.62, 0.84, -0.58, 0.71], ['C', -0.56, 0.61, -0.62, 0.53, -0.84, 0.48],
    ['C', -0.66, 0.43, -0.55, 0.36, -0.53, 0.24], ['C', -0.51, 0.1, -0.55, -0.06, -0.6, -0.22], ['L', 0.05, -0.22]],
  // 胸鳍：长刃，前缘后掠，刃尖朝后下，后缘一个尖钩（单位米，长约 130）
  pectoral: [['M', 7, 19], ['C', -22, 27, -66, 22, -106, 2], ['C', -116, -4, -126, -14, -132, -28], ['C', -118, -24, -106, -21, -98, -23],
    ['C', -92, -26, -94, -33, -110, -44], ['C', -92, -42, -80, -38, -72, -38],
    ['C', -56, -37, -44, -33, -36, -29], ['C', -22, -25, -8, -23, 7, -21], ['L', 7, 19]],
  // 腹鳍 / 臀鳍：向下后方的小刃，刃尖朝后，后缘一个尖钩（归一化：高 1）
  ventral: [['M', 0.07, 0.12], ['C', 0.1, -0.26, -0.04, -0.66, -0.36, -0.9], ['C', -0.5, -1.0, -0.72, -1.04, -0.98, -1.0],
    ['C', -0.8, -0.92, -0.68, -0.82, -0.64, -0.7], ['C', -0.62, -0.62, -0.68, -0.54, -0.86, -0.48],
    ['C', -0.68, -0.4, -0.58, -0.3, -0.56, -0.16], ['C', -0.56, -0.06, -0.58, 0.04, -0.6, 0.12], ['L', 0.07, 0.12]],
  // 尾鳍：开叉两叶，下叶略大；上叶前缘近根处一个尖钩，叶尖朝后
  caudal: [['M', 6, 25], ['C', -2, 34, -4, 44, -12, 50], ['C', -16, 54, -26, 56, -32, 56], ['C', -26, 52, -24, 48, -24, 44],
    ['C', -38, 64, -46, 84, -62, 100], ['C', -74, 110, -90, 116, -110, 117], ['C', -95, 106, -86, 96, -84, 86],
    ['C', -81, 70, -75, 38, -62, -5], ['C', -76, -40, -100, -94, -132, -136], ['C', -112, -134, -94, -128, -82, -116],
    ['C', -58, -90, -28, -50, 6, -25], ['L', 6, 25]],
};
// 鳍的离缘距离场：形状栅格化 → EDT（内部） → HalfFloat 单通道纹理。另找最深点放旋涡（尾鳍上下两叶各一个）
function finField(shape, { K = 6, twoLobes = false } = {}) {
  const { de, W, H, x0, y0, cv } = shapeInside(shape, K, 3, 40);
  const data = new Uint16Array(W * H);
  let best = [-1, 0, 0], best2 = [-1, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, d = de[i];
    data[i] = THREE.DataUtils.toHalfFloat(d);
    const px = x0 + (x + 0.5) / K, py = y0 + (y + 0.5) / K;
    if (twoLobes && py < -20) { if (d > best2[0]) best2 = [d, px, py]; }
    else if (!twoLobes || py > 20) { if (d > best[0]) best = [d, px, py]; }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  return { tex, x0, y0, W, H, K, cv, xf: new THREE.Vector4(x0, y0, K / W, K / H), deep: best, deep2: best2 };
}
const FIN_FRAG_PARS = /* glsl */`
uniform sampler2D uFinTex; uniform vec4 uFinXf, uFinSp1, uFinSp2; uniform float uFinB2;
varying vec2 vFuv; varying float vCap;
float finDE( vec2 p ) { return texture2D( uFinTex, ( p - uFinXf.xy ) * uFinXf.zw ).r; }
float finSpiral( vec2 p, vec4 sp ) {
  if ( sp.z <= 0.0 ) return 99.0;
  vec2 q = p - sp.xy; float r = length( q ), a = atan( q.y, q.x );
  float k = r + sp.w * a / 6.2831853;
  float d = abs( mod( k, sp.w ) - 0.5 * sp.w ) - 0.22 * sp.w;
  return max( max( d, r - sp.z ), 1.0 - r );
}
float finBandD( vec2 p, float de ) {
  float b1 = abs( de - 3.2 ) - 1.2;
  float b2 = uFinB2 > 0.5 ? abs( de - 9.2 ) - 1.1 : 99.0;
  return min( min( b1, b2 ), min( finSpiral( p, uFinSp1 ), finSpiral( p, uFinSp2 ) ) );
}
float finZoneD( vec2 p, float de ) {
  float z = uFinB2 > 0.5 ? max( 4.3 - de, de - 8.1 ) : 99.0;
  if ( uFinSp1.z > 0.0 ) z = min( z, length( p - uFinSp1.xy ) - uFinSp1.z - 0.6 );
  if ( uFinSp2.z > 0.0 ) z = min( z, length( p - uFinSp2.xy ) - uFinSp2.z - 0.6 );
  return z;
}
float finH( vec2 p ) {
  float de = finDE( p );
  float bd = finBandD( p, de ), zd = finZoneD( p, de );
  return uBzH.x * 0.8 * toonSS( 0.7, -0.7, bd ) - uBzH.y * toonSS( 0.4, -0.4, zd ) * toonSS( -0.7, 0.7, bd );
}
`;
const FIN_ALBEDO = /* glsl */`
vec2 fp = vFuv;
float fpx = max( length( fwidth( fp ) ) * 0.7071, 1e-4 );
float fcap = smoothstep( 0.55, 0.85, vCap );
{
  float de = finDE( fp );
  float bd = finBandD( fp, de ), zd = finZoneD( fp, de );
  float aa = 0.6 * fpx;
  float band = ( 1.0 - smoothstep( -aa, aa, bd ) ) * fcap;
  float inl = ( 1.0 - smoothstep( -aa, aa, zd ) ) * ( 1.0 - band ) * fcap;
  vec3 c = bzPatina( diffuseColor.rgb, vToonObj, band, inl, 0.0, bd );
  float foot = smoothstep( 1.4, 0.3, bd ) * ( 1.0 - band ) * ( 1.0 - inl ) * fcap;
  c = mix( c, uBzChannel, foot * 0.5 );
  c = mix( c, bzMosaic( fp, fpx ), inl );
  // 刃口（侧壁）：磨亮的铜，逆光里像一圈金边
  c = mix( c, uBzCopper * 1.12, ( 1.0 - fcap ) * 0.92 );
  diffuseColor.rgb = c;
  float jit = toonNoise( vec3( fp * 0.32, uInkTime * 0.731 ) ) * 0.14;
  float lw = 1.3 * fpx, fade = smoothstep( 1.6, 0.75, fpx );
  float ink = ( 1.0 - smoothstep( 0.5 * lw, 1.5 * lw, abs( bd + jit ) ) ) * fcap;
  toonInk = max( toonInk, ink * 0.82 * fade );
  toonLift = max( inl * 0.4, ( 1.0 - fcap ) * 0.55 );
}
`;
const FIN_NORMAL = /* glsl */`
{
  toonPassN = normal; toonPassUse = 1.0;
  toonRimN = normal; toonRimUse = 1.0;
  float e = 0.3;
  vec2 g = vec2( finH( fp + vec2( e, 0.0 ) ) - finH( fp - vec2( e, 0.0 ) ), finH( fp + vec2( 0.0, e ) ) - finH( fp - vec2( 0.0, e ) ) ) / ( 2.0 * e );
  vec2 dHdxy = vec2( dot( g, dFdx( fp ) ), dot( g, dFdy( fp ) ) ) * uBzBump * fcap;
  normal = bzPerturb( - vViewPosition, normal, dHdxy, faceDirection );
}
`;

// ───────────────────────── 植被几何（单位尺寸，实例矩阵再缩放）：engine/form/props.js、plants.js ─────────────────────────
const geoClump = () => clump({ a1: 0.14, a2: 0.08, flat: 0.78 });
// 小白花：五瓣（每瓣是扇形小片，略上翘）+ 花心（淡黄，顶点色）
const geoFlower = () => petalFan({ petal: [1, 1, 1], heart: [1.0, 0.86, 0.5] });
const CATCH_REST = [[-0.27, 0.25, 0.93, 0.984], [0.25, -0.2, 0.95, 0.9965]];

// ───────────────────────── 主体 ─────────────────────────
/**
 * createKun(opts) → { group, setPose(ts, o), eyeWorld(target, ref), fitShadow(light, o), outlineMeshes, length, eyeRadius, wisps, uniforms, fins, eyes, debug }
 * 与 kun.js 的 createKun 接口一致（wisps 恒为空数组：青铜鲲不拖云丝）。
 * opts.lod   0.1–1：网格密度、纹样分辨率、植被数量的倍率（大远景 0.35–0.5）
 * opts.seed  散布种子（默认 20261103）
 * opts.blinkPeriod / blinkOffset：自动眨眼的周期 / 首次时刻（秒，默认 4 / 1.5）
 * setPose(ts, { blink, look })：blink 0 睁 → 1 闭（不给就按周期自动眨）；look 为世界坐标 Vector3，玉眼转向它（限幅）
 * eyeWorld(target, ref)：ref = 相机位置（取近的那只眼）/ 1（+Z 侧）/ -1（-Z 侧，默认）
 * fitShadow(light, { size })：把主光阴影相机罩到鲲身上（方向不变）
 * uniforms.uKunAmp / uKunAmpZ / uKunWave / uKunOmega：竖向波幅、横向波幅（米）、波数、角频率
 */
export function createKun(opts = {}) {
  const o = { lod: 1, seed: 20261103, blinkPeriod: 4, blinkOffset: 1.5, ...opts };
  const lod = clamp(o.lod, 0.1, 1);
  const N = n => Math.max(4, Math.round(n * lod));
  const LS = 1 / Math.sqrt(Math.max(lod, 0.2));
  const R = mulberry(o.seed);
  const noise = createNoise3D(mulberry(o.seed + 11)), noise2 = createNoise3D(mulberry(o.seed + 23));
  const tm = {}, T0 = performance.now(), mark = k => { tm[k] = Math.round(performance.now() - T0); };

  const U = {
    uKunT: { value: 0 }, uKunAmp: { value: 13 }, uKunAmpZ: { value: 24 }, uKunWave: { value: 0.8 }, uKunOmega: { value: TAU / 5 }, uKunHalfL: { value: 300 }, uKunPhZ: { value: 1.3 },
    uFinAng: { value: new Array(16).fill(0) },
  };
  const group = new THREE.Group(); group.name = 'kun-bronze';
  const outlineMeshes = [];
  const add = (parent, mesh) => { parent.add(mesh); if (mesh.userData.outline) outlineMeshes.push(mesh); return mesh; };

  // —— 展开参数 + 纹样距离场 ——
  const PRM = buildParam(); mark('param');
  const PAT = drawBodyPattern(PRM, lod >= 0.6 ? 5 : lod >= 0.35 ? 3.5 : 2.5); mark('pattern');
  const patTex = new THREE.DataTexture(PAT.tex, PAT.W, PAT.H, THREE.RGBAFormat, THREE.HalfFloatType);
  patTex.magFilter = THREE.LinearFilter; patTex.minFilter = THREE.LinearMipmapLinearFilter; patTex.generateMipmaps = true; patTex.anisotropy = 4; patTex.needsUpdate = true;
  const sampleD = (u, s) => [PAT.sample(PAT.dBand, u, s), PAT.sample(PAT.dZone, u, s), PAT.sample(PAT.dJade, u, s), PAT.sample(PAT.dGroove, u, s)];

  const bzU = {
    uBzBand: { value: new THREE.Color(BRONZE.band) }, uBzCopper: { value: new THREE.Color(BRONZE.copper) }, uBzChannel: { value: new THREE.Color(BRONZE.channel) },
    uBzDark: { value: new THREE.Color(BRONZE.dark) }, uBzBloom: { value: new THREE.Color(BRONZE.bloom) }, uBzRust: { value: new THREE.Color(BRONZE.rust) }, uBzCuprite: { value: new THREE.Color(BRONZE.cuprite) },
    uBzTq1: { value: new THREE.Color(BRONZE.tq1) }, uBzTq2: { value: new THREE.Color(BRONZE.tq2) }, uBzTq3: { value: new THREE.Color(BRONZE.tq3) }, uBzGrout: { value: new THREE.Color(BRONZE.grout) },
    uBzJade: { value: new THREE.Color(BRONZE.jade) }, uBzJade2: { value: new THREE.Color(BRONZE.jade2) }, uBzLichen: { value: new THREE.Color(BRONZE.lichen) }, uBzLichen2: { value: new THREE.Color(BRONZE.lichen2) },
    uBzH: { value: new THREE.Vector4(HB, HI, HJ, HG) }, uBzBump: { value: 1 },
  };

  // —— 身体：放样（两端加密）→ 法线 → 按纹样高度沿法线位移（法线保留原样，浮雕的明暗交给片元凹凸）——
  const NU = Math.round(lerp(150, 620, lod)), NV = Math.round(lerp(96, 380, lod)) & ~1;
  const bodyGeo = (() => {
    const xs = axisStations(X_TAIL, X_SNOUT - 0.3, NU, 0.45), uvs = [];
    for (const x of xs) {
      const tab = PRM.ring(x), Ux = PRM.Ux(x);
      for (let k = 0; k < NV; k++) { const phi = k / NV * TAU; uvs.push(Ux, PRM.sOf(tab, sideAngle(Math.cos(phi), Math.sin(phi)))); }
    }
    const g = loftRings(ringsAt(bodyPoint, xs, NV), {
      startCap: { p: new THREE.Vector3(X_TAIL - 0.6, yMid(X_TAIL), 0), attr: { aUV: [-0.5, 0] } },
      endCap: { p: new THREE.Vector3(X_SNOUT + 0.2, yMid(X_SNOUT), 0), attr: { aUV: [PRM.Ucap, 0] } },
      attrs: { aUV: { data: uvs, size: 2 } },
    });
    const P = g.attributes.position, Nn = g.attributes.normal, A = g.attributes.aUV;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), d = sampleD(A.getX(i), A.getY(i));
      const h = heightOf(d[0], d[1], d[2], d[3]) * sstep(X_TAIL, X_TAIL + 5, x) * sstep(X_SNOUT, X_SNOUT - 4, x);
      P.setXYZ(i, x + Nn.getX(i) * h, P.getY(i) + Nn.getY(i) * h, P.getZ(i) + Nn.getZ(i) * h);
    }
    return g;
  })();
  mark('body');
  const bodyMat = makeBronzeToon({
    uniforms: { ...U, ...bzU, uPat: { value: patTex }, uPatXf: { value: new THREE.Vector4(PAT.K / PAT.W, PAT.K / PAT.H, PAT.smax, PAT.Rr) } },
    ...bendHooks({ extraPars: 'attribute vec2 aUV;\nvarying vec2 vUV;\n', extraBegin: 'vUV = aUV;' }),
    fragmentPars: BODY_FRAG_PARS, fragmentAlbedo: BODY_ALBEDO, fragmentNormal: BODY_NORMAL,
  });
  const body = add(group, bindBronze(new THREE.Mesh(bodyGeo, bodyMat), bodyMat));
  body.name = 'kun-body'; body.frustumCulled = false;

  // —— 鳍：每类一个合并网格（同一张离缘距离场），逐顶点弯 + 绕根部摆 ——
  const finTypes = {};
  const finMat = (FF, b2, sp1, sp2) => makeBronzeToon({
    side: THREE.DoubleSide,
    uniforms: { ...U, ...bzU, uFinTex: { value: FF.tex }, uFinXf: { value: FF.xf }, uFinSp1: { value: sp1 }, uFinSp2: { value: sp2 }, uFinB2: { value: b2 ? 1 : 0 } },
    ...bendHooks({ finFlap: true, extraPars: 'attribute vec2 aFuv;\nattribute float aCap;\nvarying vec2 vFuv;\nvarying float vCap;\n', extraBegin: 'vFuv = aFuv; vCap = aCap;' }),
    fragmentPars: BODY_FRAG_PARS + FIN_FRAG_PARS, fragmentAlbedo: FIN_ALBEDO, fragmentNormal: FIN_NORMAL,
  });
  // 一片鳍：挤出 → 记下形状坐标与正反面标记 → 摆到鲲空间（基 = ex, ey, ez，原点 o）→ 写转轴
  function finGeo(shape, thick, basis, origin, pivot, axis, fi) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: 1.1, bevelSize: 0.9, bevelSegments: 2, curveSegments: 14, steps: 1 });
    g.translate(0, 0, -thick / 2); g.deleteAttribute('uv'); g.computeVertexNormals();
    const p = g.attributes.position, n = g.attributes.normal, cnt = p.count;
    const fuv = new Float32Array(cnt * 2), cap = new Float32Array(cnt), piv = new Float32Array(cnt * 4), ax = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) { fuv[i * 2] = p.getX(i); fuv[i * 2 + 1] = p.getY(i); cap[i] = Math.abs(n.getZ(i)); }
    const m = new THREE.Matrix4().makeBasis(basis[0], basis[1], basis[2]).setPosition(origin);
    g.applyMatrix4(m);
    for (let i = 0; i < cnt; i++) { piv.set([pivot.x, pivot.y, pivot.z, fi], i * 4); ax.set([axis.x, axis.y, axis.z], i * 3); }
    g.setAttribute('aFuv', new THREE.BufferAttribute(fuv, 2)); g.setAttribute('aCap', new THREE.BufferAttribute(cap, 1));
    g.setAttribute('aPiv', new THREE.BufferAttribute(piv, 4)); g.setAttribute('aAx', new THREE.BufferAttribute(ax, 3));
    return g;
  }
  const spiralFor = (FF, deep, scale = 1) => { const r = (deep[0] - 11.5) * scale; return r > 3.5 ? new THREE.Vector4(deep[1], deep[2], r, clamp(r / 2.3, 3.6, 6.2)) : new THREE.Vector4(0, 0, 0, 1); };
  const finMeshes = [];
  // 背鳍 ×5（同一形状按高度缩放：纹样随之缩放，所以按形状坐标归一化成单位 1 再缩放网格）
  {
    const H0 = 60, shp = shapeFrom(FIN_PATHS.dorsal, H0, H0), FF = finField(shp);
    const list = [{ x: 118, h: 72 }, { x: 52, h: 64 }, { x: -8, h: 54 }, { x: -62, h: 44 }, { x: -110, h: 32 }];
    const geos = list.map((f, i) => {
      const sc = f.h / H0, L = 0.65 * f.h, xb = f.x - L;
      const ang = Math.atan2(fT(xb) - fT(f.x), -L) + Math.PI;   // 底线贴着背线
      const ex = new THREE.Vector3(Math.cos(ang), Math.sin(ang), 0), ey = new THREE.Vector3(-Math.sin(ang), Math.cos(ang), 0), ez = new THREE.Vector3(0, 0, 1);
      const org = new THREE.Vector3(f.x, fT(f.x) - 1.5, 0);
      const g = finGeo(shp, 4.2 / sc, [ex.clone().multiplyScalar(sc), ey.clone().multiplyScalar(sc), ez.clone().multiplyScalar(sc)], org, org, ex, 1 + i);
      return g;
    });
    finTypes.dorsal = { FF, list };
    const mat = finMat(FF, true, spiralFor(FF, FF.deep), new THREE.Vector4(0, 0, 0, 1));
    const mesh = add(group, bindBronze(new THREE.Mesh(mergeGeometries(geos), mat), mat)); mesh.name = 'kun-dorsal-fins'; mesh.frustumCulled = false; finMeshes.push(mesh);
  }
  // 臀鳍 ×2（腹中线，向下后）+ 腹鳍一对（喉下，略外撇）
  {
    const H0 = 44, shp = shapeFrom(FIN_PATHS.ventral, H0, H0), FF = finField(shp);
    const geos = [];
    [{ x: -66, h: 46, fi: 6 }, { x: -118, h: 32, fi: 7 }].forEach(f => {
      const sc = f.h / H0, org = new THREE.Vector3(f.x, fB(f.x) + 1.5, 0);
      const ex = new THREE.Vector3(1, 0, 0), ey = new THREE.Vector3(0, 1, 0), ez = new THREE.Vector3(0, 0, 1);
      geos.push(finGeo(shp, 3.8 / sc, [ex.clone().multiplyScalar(sc), ey.clone().multiplyScalar(sc), ez.clone().multiplyScalar(sc)], org, org, ex, f.fi));
    });
    for (const side of [1, -1]) {
      const h = 54, sc = h / H0, ph = -1.15, x0 = 170;
      const root = bodyPoint(x0, phiOf(ph, side)), nrm = bodyNormal(x0, phiOf(ph, side));
      root.addScaledVector(nrm, -3);
      const spl = 0.72 * side;                                             // 外撇，仰拍时能看到鳍面而不是一条板边
      const ex = new THREE.Vector3(1, 0, 0), ey = new THREE.Vector3(0, Math.cos(spl), -Math.sin(spl)), ez = new THREE.Vector3().crossVectors(ex, ey);
      geos.push(finGeo(shp, 3.4 / sc, [ex.clone().multiplyScalar(sc), ey.clone().multiplyScalar(sc), ez.clone().multiplyScalar(sc)], root, root, ex, side > 0 ? 8 : 9));
    }
    const mat = finMat(FF, true, spiralFor(FF, FF.deep, 0.9), new THREE.Vector4(0, 0, 0, 1));
    const mesh = add(group, bindBronze(new THREE.Mesh(mergeGeometries(geos), mat), mat)); mesh.name = 'kun-ventral-fins'; mesh.frustumCulled = false; finMeshes.push(mesh);
    finTypes.ventral = { FF };
  }
  // 胸鳍一对：贴着体侧向后下方伸出，外撇约 25°
  const pecRoots = [];
  {
    const shp = shapeFrom(FIN_PATHS.pectoral), FF = finField(shp);
    const geos = [];
    for (const side of [1, -1]) {
      const x0 = 128, ph = -0.55;
      const root = bodyPoint(x0, phiOf(ph, side)), nrm = bodyNormal(x0, phiOf(ph, side));
      root.addScaledVector(nrm, -6);
      const ex = new THREE.Vector3(1, 0.6, 0).normalize();                  // 刃向后下方伸出，刃尖露出腹线
      const ez0 = new THREE.Vector3(0, -0.3, side).normalize();
      const ey = new THREE.Vector3().crossVectors(ez0, ex).normalize(), ez = new THREE.Vector3().crossVectors(ex, ey).normalize();
      const axis = ey.clone().multiplyScalar(0.75).addScaledVector(ez, 0.66 * side).normalize();
      geos.push(finGeo(shp, 3.6, [ex, ey, ez], root, root, axis, side > 0 ? 10 : 11));
      pecRoots.push({ side, root: root.clone() });
    }
    const mat = finMat(FF, true, spiralFor(FF, FF.deep), new THREE.Vector4(0, 0, 0, 1));
    const mesh = add(group, bindBronze(new THREE.Mesh(mergeGeometries(geos), mat), mat)); mesh.name = 'kun-pectoral-fins'; mesh.frustumCulled = false; finMeshes.push(mesh);
    finTypes.pectoral = { FF };
  }
  // 尾鳍：竖直的厚片，接在尾柄末端（逐顶点弯，自然跟着摆）
  {
    const shp = shapeFrom(FIN_PATHS.caudal), FF = finField(shp, { twoLobes: true });
    const org = new THREE.Vector3(X_TAIL + 6, yMid(X_TAIL + 6), 0);
    const g = finGeo(shp, 5, [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)], org, org, new THREE.Vector3(0, 1, 0), 0);
    const mat = finMat(FF, true, spiralFor(FF, FF.deep, 0.95), spiralFor(FF, FF.deep2, 0.95));
    const mesh = add(group, bindBronze(new THREE.Mesh(g, mat), mat)); mesh.name = 'kun-caudal-fin'; mesh.frustumCulled = false; finMeshes.push(mesh);
    finTypes.caudal = { FF };
  }
  mark('fins');

  // —— 眼睛：白玉眼珠 + 青铜眼睑（头部不弯，CPU 摆位）——
  const jadeEyeMat = () => makeBronzeToon({ ...BRONZE_PRESETS.jade,
    uniforms: {
      uIrisA: { value: 0.6 }, uPupilA: { value: 0.22 },
      uIrisCol: { value: new THREE.Color('#bcd2bc') }, uPupilCol: { value: new THREE.Color('#4d6b66') }, uJade2: { value: new THREE.Color('#e2e6d0') },
      uSkyRefl: { value: new THREE.Color('#c6b8ee') }, uCityRefl: { value: new THREE.Color('#ffc58e') },
      uCatch1: { value: new THREE.Vector4(0, 0, 1, 0.985) }, uCatch2: { value: new THREE.Vector4(0, 0, 1, 0.997) }, uCatchCol: { value: new THREE.Color('#fffdf6') },
      uLidU: { value: new THREE.Vector3(0, 1, 0) }, uLidL: { value: new THREE.Vector3(0, -1, 0) },
    },
    fragmentPars: 'uniform float uIrisA, uPupilA;\nuniform vec3 uIrisCol, uPupilCol, uJade2, uCatchCol, uLidU, uLidL, uSkyRefl, uCityRefl;\nuniform vec4 uCatch1, uCatch2;\n',
    fragmentAlbedo: /* glsl */`
    {
      vec3 d = normalize( vToonObj );
      float ang = acos( clamp( d.z, -1.0, 1.0 ) ) + toonNoise( vec3( d.xy * 6.0, uInkTime * 0.731 ) ) * 0.006;
      float fa = max( fwidth( ang ), 1e-5 );
      vec3 c = diffuseColor.rgb;
      float cot = toonNoise( d * 3.2 + 3.0 ) + 0.5 * toonNoise( d * 8.0 + 1.0 );        // 玉料里的棉絮
      float fc = max( fwidth( cot ), 1e-4 );
      c = mix( c, uJade2, smoothstep( 0.22 - fc, 0.22 + fc, cot ) * 0.6 );
      float iris = 1.0 - smoothstep( uIrisA - fa, uIrisA + fa, ang );
      float inner = smoothstep( uIrisA * 0.58 - fa, uIrisA * 0.58 + fa, ang );
      c = mix( c, uIrisCol, iris * 0.85 );                                               // 青玉色的「肉」（像一枚玉璧）
      c = mix( c, uIrisCol * vec3( 0.86, 0.92, 0.88 ), iris * inner * 0.6 );
      float pupil = 1.0 - smoothstep( uPupilA - fa, uPupilA + fa, ang );
      c = mix( c, uPupilCol, pupil );
      diffuseColor.rgb = c;
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fa, 2.0 * fa, abs( ang - uIrisA ) ) ) * 0.9 );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fa, 1.6 * fa, abs( ang - uIrisA * 0.58 ) ) ) * 0.45 );   // 刻出来的一道同心圈
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fa, 1.7 * fa, abs( ang - uPupilA ) ) ) * 0.7 );
      float c1 = dot( d, uCatch1.xyz ), c2 = dot( d, uCatch2.xyz ), fcc = max( fwidth( c1 ), 1e-5 );
      float k = max( smoothstep( uCatch1.w - fcc, uCatch1.w + fcc, c1 ), smoothstep( uCatch2.w - fcc, uCatch2.w + fcc, c2 ) );
      float du = dot( d, uLidU ), dl = dot( d, uLidL ), fd = max( fwidth( du ), 1e-5 );
      float front = smoothstep( 0.1, 0.6, d.z );
      float lash = ( 1.0 - smoothstep( 0.1 * front + 0.02 - fd, 0.1 * front + 0.02 + fd, - du ) ) * front;
      float low = ( 1.0 - smoothstep( 0.03 - fd, 0.03 + fd, - dl ) ) * front;
      toonInk = max( toonInk, max( lash * 0.7, low * 0.5 ) );
      // 倒影：上沿一道薰衣草色天光、下沿一道杏色城市光（固定在眼窝坐标）
      float sky = smoothstep( -0.48, -0.38, du ) * ( 1.0 - smoothstep( -0.26, -0.18, du ) ) * smoothstep( 0.3, 0.7, d.z );
      float city = smoothstep( -0.46, -0.36, dl ) * ( 1.0 - smoothstep( -0.24, -0.16, dl ) ) * smoothstep( 0.3, 0.7, d.z );
      toonOverlay = vec4( uSkyRefl, sky * 0.32 );
      toonOverlay = mix( toonOverlay, vec4( uCityRefl, 0.38 ), city );
      toonOverlay = mix( toonOverlay, vec4( uCatchCol, 1.0 ), k * ( 1.0 - lash ) );
      toonLift = 0.6;
    }`,
  });
  const lidMat = makeBronzeToon({ side: THREE.DoubleSide, rustAmt: 0.5, rustThr: 0.15, algaeAmt: 0.5, algaeThr: 0.2, patchScale: 0.08, uniforms: { ...bzU },
    fragmentAlbedo: /* glsl */`
    {
      vec3 d = normalize( vToonObj );
      float e = asin( clamp( abs( d.y ), 0.0, 1.0 ) ), fe = max( fwidth( e ), 1e-5 );
      float front = smoothstep( 0.15, 0.55, d.z );
      float rim = 1.0 - smoothstep( 0.08 - fe, 0.08 + fe, e );
      diffuseColor.rgb = mix( diffuseColor.rgb, uBzCopper, rim * front * 0.7 );          // 睑缘磨亮
      float fold = ( 1.0 - smoothstep( 0.8 * fe, 1.9 * fe, abs( e - 0.34 ) ) ) * smoothstep( 0.35, 0.7, d.z );
      float fold2 = ( 1.0 - smoothstep( 0.8 * fe, 1.9 * fe, abs( e - 0.62 ) ) ) * smoothstep( 0.5, 0.8, d.z ) * step( 0.0, d.y );
      float edge = ( 1.0 - smoothstep( 0.8 * fe, 1.9 * fe, abs( e - 0.008 ) ) ) * front;
      toonInk = max( toonInk, max( edge * 0.9, max( fold * 0.7, fold2 * 0.5 ) ) );
    }`,
    fragmentPars: 'uniform vec3 uBzCopper;\n' });
  const eyes = mountEyes({ point: bodyPoint, normal: bodyNormal, x: EYE_X, ph: EYE_PH, inset: 0.56 * RE, gaze: [0.3, -0.06], parent: group, build: (side, eg) => {
    eg.name = 'kun-eye-' + (side > 0 ? 'R' : 'L');
    const mat = jadeEyeMat();
    const ball = add(eg, bindBronze(new THREE.Mesh(new THREE.SphereGeometry(RE, 56, 36), mat), mat, { castShadow: false }));
    const lidU = new THREE.Group(), lidL = new THREE.Group(), [shellU, shellL] = lidShells(RE * 1.045, 48, 14);
    add(lidU, bindBronze(new THREE.Mesh(shellU, lidMat), lidMat, { castShadow: false }));
    add(lidL, bindBronze(new THREE.Mesh(shellL, lidMat), lidMat, { castShadow: false }));
    eg.add(lidU, lidL);
    return { ball, lidU, lidL, mat, frame: eyeFrame(mat.userData.toon) };
  } });

  // —— 植被散布：权重按纹样（纹带脚下的凹缝、背上、鳍根）与朝向算，MeshSurfaceSampler 采样 ——
  const pA = bodyGeo.attributes.position, nA = bodyGeo.attributes.normal, uvA = bodyGeo.attributes.aUV, nv = pA.count;
  const Wt = { wMoss: new Float32Array(nv), wFlower: new Float32Array(nv), wFern: new Float32Array(nv), wCrev: new Float32Array(nv) };
  const eyeC = eyes.map(e => e.group.position);
  const Pp = new THREE.Vector3(), Nq = new THREE.Vector3();
  const finX = [118, 52, -8, -62, -110], finH = [72, 64, 54, 44, 32];
  for (let i = 0; i < nv; i++) {
    Pp.fromBufferAttribute(pA, i); Nq.fromBufferAttribute(nA, i);
    const x = Pp.x, u = uvA.getX(i), s = uvA.getY(i), d = sampleD(u, s);
    const st = PRM.st(x), sb = PRM.sb(x), up = s / Math.max(st, 1);
    const patch = noise(Pp.x * 0.016, Pp.y * 0.016, Pp.z * 0.016) + 0.45 * noise(Pp.x * 0.045 + 7, Pp.y * 0.045, Pp.z * 0.045);
    const nearEye = Math.min(...eyeC.map(c => c.distanceTo(Pp))) / RE;
    const keep = sstep(2.3, 3.0, nearEye) * sstep(0.2, 1.2, d[2]) * sstep(0.4, 1.4, d[3]) * sstep(X_TAIL + 2, X_TAIL + 10, x);
    const back = sstep(0.62, 0.86, up) * sstep(0.0, 0.3, Nq.y);                                   // 背上：苔藓毯
    const foot = sstep(0.05, 0.6, d[0]) * sstep(2.4, 1.1, d[0]) * sstep(-0.2, 0.6, d[1]);          // 纹带脚下、不在镶嵌区
    let finBase = 0; finX.forEach((fx, k) => { finBase = Math.max(finBase, sstep(0.48 * finH[k], 0.18 * finH[k], Math.abs(x - (fx - 0.3 * finH[k]))) * sstep(0.7, 0.9, up)); });
    const headTop = sstep(150, 175, x) * sstep(300, 270, x) * sstep(0.55, 0.85, up) * sstep(0.1, 0.4, Nq.y);
    const lowerKeep = sstep(-0.2, 0.25, Nq.y + 0.25);
    const upper = sstep(0.12, 0.4, up);
    Wt.wMoss[i] = keep * (back * sstep(-0.25, 0.2, patch + 0.15) * 1.6 + finBase * 1.2 + headTop * sstep(0.0, 0.3, patch));
    Wt.wFlower[i] = keep * (back * 1.2 + headTop) * sstep(-0.05, 0.3, patch) * (0.35 + 0.65 * sstep(-0.2, 0.35, noise2(Pp.x * 0.05, Pp.y * 0.05, Pp.z * 0.05)));
    Wt.wCrev[i] = keep * foot * lowerKeep * sstep(-0.35, 0.1, up) * sstep(0.62, 0.45, up) * sstep(0.1, 0.4, patch + 0.1 * noise2(Pp.x * 0.08, Pp.y * 0.08, Pp.z * 0.08));
    Wt.wFern[i] = keep * (back * 0.6 + finBase * 1.5 + foot * 0.15 * sstep(0.3, 0.5, up)) * sstep(0.15, 0.4, noise2(Pp.x * 0.03 + 40, Pp.y * 0.03, Pp.z * 0.03)) * sstep(250, 235, x);
  }
  const sampler = samplersOn(bodyGeo, Wt);
  const inst = (geo, mat, items, name) => instanced(geo, mat, items, name, { bind: bindBronze });
  const tp = new THREE.Vector3(), tn = new THREE.Vector3();
  const back = new THREE.Vector3(-1, 0, 0);

  // 苔藓团：一团团重叠的小球，亮黄绿
  const clumps = [], sM = sampler('wMoss', o.seed + 101);
  for (let i = 0; i < N(3400); i++) {
    sM.sample(tp, tn);
    const r = (3.2 + Math.pow(R(), 1.4) * 9.5) * LS;
    clumps.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(r * (0.9 + R() * 0.35), r * (0.6 + R() * 0.45), r * (0.9 + R() * 0.35)), sink: r * 0.36 }), c: pick(R(), BRONZE.moss) });
  }
  // 鳍根与尾鳍根上补几团（背鳍底线附近）
  for (const [k, fx] of finX.entries()) {
    const h = finH[k], L = 0.65 * h;
    for (let j = 0; j < N(26); j++) {
      const x = fx - R() * L * 0.95, side = R() < 0.5 ? 1 : -1, ph = 1.5708 - (0.04 + R() * 0.2);
      const p = bodyPoint(x, phiOf(ph, side)), n = bodyNormal(x, phiOf(ph, side)), r = (2.2 + R() * 3.4) * LS;
      clumps.push({ m: place(p, n, { yaw: R() * TAU, scale: new THREE.Vector3(r, r * 0.75, r), sink: r * 0.3 }), c: pick(R(), BRONZE.moss) });
    }
  }
  for (let j = 0; j < N(40); j++) {   // 尾柄背上到尾鳍根
    const x = X_TAIL + 4 + R() * 30, side = R() < 0.5 ? 1 : -1, ph = 1.5708 - R() * 0.5;
    const p = bodyPoint(x, phiOf(ph, side)), n = bodyNormal(x, phiOf(ph, side)), r = (1.8 + R() * 2.6) * LS;
    clumps.push({ m: place(p, n, { yaw: R() * TAU, scale: new THREE.Vector3(r, r * 0.75, r), sink: r * 0.3 }), c: pick(R(), BRONZE.moss) });
  }
  // 纹样缝里的小园子：两三团贴着缝的小苔藓，上面顶几朵小白花，偶尔一棵小蕨（「纹样缝隙里长满苔藓和小白花」）
  const gardens = [], sC = sampler('wCrev', o.seed + 202);
  for (let i = 0; i < N(115); i++) {
    sC.sample(tp, tn);
    const g = { p: tp.clone(), n: tn.clone(), k: [] };
    const nC = 2 + Math.floor(R() * 3);
    for (let j = 0; j < nC; j++) {
      const r = (1.8 + R() * 2.4) * LS, off = new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(5).projectOnPlane(tn);
      const p = tp.clone().add(off);
      clumps.push({ m: place(p, tn, { yaw: R() * TAU, scale: new THREE.Vector3(r * 1.15, r * 0.7, r * 1.15), sink: r * 0.3 }), c: pick(R(), BRONZE.moss) });
      g.k.push([p, r]);
    }
    gardens.push(g);
  }
  // 眉弓上一小片（眼睛特写里能看到苔藓和小白花）
  const browGarden = [];
  for (let j = 0; j < 9; j++) {
    const x = EYE_X - 6 - R() * 26, ph = EYE_PH + 0.42 + R() * 0.16, side = R() < 0.5 ? 1 : -1;
    const p = bodyPoint(x, phiOf(ph, side)), n = bodyNormal(x, phiOf(ph, side)), r = (1.8 + R() * 2.6) * LS;
    clumps.push({ m: place(p, n, { yaw: R() * TAU, scale: new THREE.Vector3(r * 1.1, r * 0.75, r * 1.1), sink: r * 0.3 }), c: pick(R(), BRONZE.moss) });
    browGarden.push([p, n, r]);
  }
  const mossMat = makeBronzeToon({ ...BRONZE_PRESETS.moss, outlineW: 0.45, instanceId: false, uniforms: { ...U }, ...bendHooks() });
  add(group, inst(geoClump(), mossMat, clumps, 'kun-moss'));

  // 小白花：多数顶在苔藓团上
  const flowers = [], sF = sampler('wFlower', o.seed + 303);
  const tA = new THREE.Vector3(), tB = new THREE.Vector3();
  for (let i = 0; i < N(560); i++) {
    sF.sample(tp, tn);
    tA.set(1, 0, 0).cross(tn); if (tA.lengthSq() < 1e-4) tA.set(0, 0, 1); tA.normalize(); tB.crossVectors(tn, tA);
    const nC = 3 + Math.floor(R() * 5), rad = (2.5 + R() * 4) * Math.sqrt(LS), lift0 = R() < 0.8 ? (3 + R() * 5.5) * LS : 0.5;
    for (let j = 0; j < nC; j++) {
      const a = R() * TAU, rr = rad * Math.sqrt(R()), s = (1.7 + R() * 1.7) * Math.sqrt(LS);
      const p = tp.clone().addScaledVector(tA, Math.cos(a) * rr).addScaledVector(tB, Math.sin(a) * rr).addScaledVector(tn, lift0 + R() * 1.5);
      flowers.push({ m: place(p, tn, { yaw: R() * TAU, scale: new THREE.Vector3(s, s, s), sink: 0.15 }), c: pick(R(), BRONZE.flower) });
    }
  }
  for (const g of gardens) for (const [p, r] of g.k) {                 // 缝里小园子的花：顶在小苔藓团上
    const nF = 1 + Math.floor(R() * 2.6);
    for (let j = 0; j < nF; j++) {
      const s = (1.4 + R() * 1.3) * Math.sqrt(LS), q = p.clone().addScaledVector(g.n, r * (0.35 + R() * 0.3)).add(new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(r * 1.2).projectOnPlane(g.n));
      flowers.push({ m: place(q, g.n, { yaw: R() * TAU, scale: new THREE.Vector3(s, s, s), sink: 0 }), c: pick(R(), BRONZE.flower) });
    }
  }
  for (const [p, n, r] of browGarden) for (let j = 0; j < 2; j++) {
    const s = (1.3 + R() * 1.1) * Math.sqrt(LS), q = p.clone().addScaledVector(n, r * 0.45).add(new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(r).projectOnPlane(n));
    flowers.push({ m: place(q, n, { yaw: R() * TAU, scale: new THREE.Vector3(s, s, s), sink: 0 }), c: pick(R(), BRONZE.flower) });
  }
  const flowerMat = makeBronzeToon({ ...BRONZE_PRESETS.flower, vertexColors: true, side: THREE.DoubleSide, outlineW: 0.5, uniforms: { ...U }, ...bendHooks() });
  add(group, inst(geoFlower(), flowerMat, flowers, 'kun-flowers'));

  // 小蕨：从缝里、鳍根斜着长出来，叶尖向后（一拍三轻摆）
  const ferns = [], sFe = sampler('wFern', o.seed + 404);
  for (let i = 0; i < N(260); i++) {
    sFe.sample(tp, tn);
    const h = (11 + Math.pow(R(), 1.2) * 20) * Math.sqrt(LS);
    ferns.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(h * (0.9 + R() * 0.3), h, h), sink: 0.8, lean: back.clone().multiplyScalar(0.2 + R() * 0.35) }), c: pick(R(), BRONZE.fern) });
  }
  for (const g of gardens) if (R() < 0.22) {                            // 缝里偶尔一棵小蕨
    const h = (7 + R() * 8) * Math.sqrt(LS);
    ferns.push({ m: place(g.p, g.n, { yaw: R() * TAU, scale: new THREE.Vector3(h, h, h), sink: 0.5, lean: back.clone().multiplyScalar(0.3) }), c: pick(R(), BRONZE.fern) });
  }
  const swayBegin = (amp, freq) => /* glsl */`
  {
    float hg = clamp( position.y, 0.0, 1.2 ), h2 = hg * hg;
    float ph = float( gl_InstanceID ) * 1.618;
    transformed.x += sin( uKunT * ${freq} + ph ) * ${amp} * h2;
    transformed.z += cos( uKunT * ${freq} * 0.8 + ph * 1.3 ) * ${amp} * 0.6 * h2;
  }`;
  const fernMat = makeBronzeToon({ ...BRONZE_PRESETS.fern, side: THREE.DoubleSide, outlineW: 0.7, uniforms: { ...U }, ...bendHooks({ extraBegin: swayBegin('0.1', '2.3') }) });
  add(group, inst(fern(), fernMat, ferns, 'kun-ferns'));

  // 垂苔：从下唇、下颌、鳃盖下沿垂下来（局部 -Y 永远朝下）
  const hangs = [];
  const hangAt = (x, ph, side, len) => {
    const p = bodyPoint(x, phiOf(ph, side)), n = bodyNormal(x, phiOf(ph, side));
    const m = new THREE.Matrix4().compose(p.addScaledVector(n, -0.6), new THREE.Quaternion().setFromAxisAngle(UP, R() * TAU), new THREE.Vector3(len * 0.9, len, len * 0.9));
    hangs.push({ m, c: pick(R(), BRONZE.moss) });
  };
  for (const side of [1, -1]) {
    for (let x = 300; x > MOUTH_X0 + 6; x -= 1.6 + R() * 2.2) if (noise2(x * 0.06, side, 3) > -0.3) hangAt(x, mouthPh(x) - 0.12, side, 7 + Math.pow(R(), 1.3) * 18);   // 下唇
    for (let x = 296; x > 222; x -= 2.5 + R() * 3) if (noise2(x * 0.05, side, 9) > -0.05) hangAt(x, mouthPh(x) - 0.47 - 0.07 * sstep(298, 222, x), side, 6 + R() * 13);   // 颌带下沿
    for (let k = 0; k < N(22); k++) { const ph = -0.2 - R() * 0.9, x = 146 + Math.abs(ph) * 12 + R() * 4; hangAt(x, ph, side, 5 + R() * 11); }               // 鳃盖下沿
    for (let x = 112; x > -150; x -= 3 + R() * 6) if (noise(x * 0.03, side * 3, 1) > -0.05) hangAt(x, PRM.phOfS(x, 0.64 * PRM.st(x)), side, 4 + R() * 11);   // 背上苔藓毯的下沿
  }
  const hangMat = makeBronzeToon({ ...BRONZE_PRESETS.moss, side: THREE.DoubleSide, outlineW: 0.55, dabAmt: 0.1, uniforms: { ...U },
    ...bendHooks({ extraBegin: /* glsl */`
    {
      float hg = clamp( - position.y, 0.0, 1.0 ), h2 = hg * hg;
      float ph = float( gl_InstanceID ) * 2.399;
      transformed.x += sin( uKunT * 2.0 + ph ) * 0.16 * h2;
      transformed.z += cos( uKunT * 1.7 + ph * 1.3 ) * 0.12 * h2;
    }` }) });
  add(group, inst(strands(), hangMat, hangs, 'kun-hanging-moss'));
  mark('plants');

  // —— 姿态 ——
  function setPose(ts, po = {}) {
    U.uKunT.value = ts;
    const w = U.uKunOmega.value, A = U.uFinAng.value;
    for (let i = 0; i < 5; i++) A[1 + i] = 0.085 * Math.sin(w * ts - 0.9 * i);               // 背鳍：一片接一片向后传的侧摆
    A[6] = 0.1 * Math.sin(w * ts - 3.2); A[7] = 0.1 * Math.sin(w * ts - 4.0);              // 臀鳍
    A[8] = 0.13 * Math.sin(w * ts + 0.9); A[9] = -0.13 * Math.sin(w * ts + 0.9);           // 腹鳍（左右对称开合）
    A[10] = 0.2 * Math.sin(w * ts + 0.4); A[11] = -0.2 * Math.sin(w * ts + 0.4);           // 胸鳍：划水
    // 看镜头时高光跟着视线方向（眼窝坐标）偏左上一点 → 总在看到的瞳孔左上方；不看时固定在眼窝坐标
    poseEyes(eyes, po.blink ?? autoBlink(ts, o.blinkPeriod, o.blinkOffset), po.look, group, {
      lidU: [-0.5, 0.03], lidL: [0.66, -0.03], yaw: 0.32, pitch: 0.26,
      catches: (e, v) => {
        if (!v) return CATCH_REST;
        const sx = e.side > 0 ? 1 : -1;
        return [[v.x + 0.24 * sx, v.y + 0.3, v.z, 0.9905], [v.x - 0.2 * sx, v.y - 0.22, v.z, 0.9976]];
      },
    });
  }
  const eyeWorld = (target, ref) => pickEye(eyes, target, ref);
  function fitShadow(light, { size = 4096, radius = 400 } = {}) {
    group.updateMatrixWorld(true);
    const c = new THREE.Vector3(-5, -5, 0).applyMatrix4(group.matrixWorld);
    const sc = group.matrixWorld.getMaxScaleOnAxis(), Rr = radius * sc;
    const dir = light.position.clone().sub(light.target.position);
    if (dir.lengthSq() < 1e-9) dir.set(0.75, 0.1, 0.65); dir.normalize();
    light.target.position.copy(c); light.target.updateMatrixWorld();
    light.position.copy(c).addScaledVector(dir, Rr * 3);
    const cam = light.shadow.camera;
    Object.assign(cam, { left: -Rr, right: Rr, top: Rr, bottom: -Rr, near: Rr * 0.5, far: Rr * 5.5 });
    cam.updateProjectionMatrix();
    if (light.shadow.mapSize.x !== size) { light.shadow.mapSize.set(size, size); light.shadow.map?.dispose(); light.shadow.map = null; }
    light.shadow.normalBias = 1.5 * sc; light.shadow.bias = -0.0005; light.shadow.radius = 2;
    light.castShadow = true;
  }
  setPose(0);
  mark('done');
  const debug = { timings: tm, pattern: PAT.canvases, finFields: Object.fromEntries(Object.entries(finTypes).map(([k, v]) => [k, v.FF.cv])), PRM, PAT,
    counts: { clumps: clumps.length, flowers: flowers.length, ferns: ferns.length, hangs: hangs.length, gardens: gardens.length, bodyVerts: nv } };
  void pecRoots;
  return { group, setPose, eyeWorld, fitShadow, outlineMeshes, length: 600, eyeRadius: RE, wisps: [], uniforms: U, fins: finMeshes, eyes, debug };
}
