// src/girl.js — 镜头 B「她」：林潮逆光侧脸剪影 + AI 眼镜（人物层）
//
// 画在透明 2D canvas 上，tl = 镜头内时间 0–2 秒（对应全局 3.00–5.00）。
//   · 角色动画一拍二：所有姿态（发丝、手、呼吸、抬头）只在 floor(tl*12)/12 上取值，墨线抖动也按这个步进换形；
//   · 镜片倒影里的鲲一拍三：floor(tl*8)/8（和镜头 C 里的鲲一致）；
//   · 镜头缓推、镜片内缘光、粉色天光的明暗属于「光与镜头」，24 fps 平滑。
// 画法：深蓝紫平涂剪影（2–3 档）+ 偏移法求出的硬边边缘光（粉金，只出现在挨着天空的轮廓上）+ 天顶冷边
//      + engine/core/stroke.js 手绘墨线（有粗细、按一拍二抖动）+ 水彩斑驳纹理。
// 形状全部是手工设计的贝塞尔曲线。单位 mH = 头高（头顶到下巴）的千分之一；「头部局部」坐标：
//   x 朝脸的前方（画面右），y 向下，眉骨最前点约在 (0, 410)。
//   画的是「侧过来约 15°」的近侧脸：近侧镜片在眼前，远侧镜片因为镜框弧度只从鼻梁前探出窄窄一条。
// 眼镜外形照AI 眼镜产品图：方框略圆角、上框略粗；镜腿粗而平直（内藏电池与扬声器）；
//   摄像头在镜框正面外侧上角（铰链前）；不画任何 logo。
// 确定性：不用 Date.now / 无种子随机；噪声来自 engine/core 的单纯形噪声与 mulberry 固定种子。
//
// 导出（给合成代理）：
//   drawGirl(ctx, tl, w, h, opts)      人物层（透明底）。opts：
//       cam      默认 girlCamera(tl)（匀速缓推 6.5%）；false = 不推；或 {zoom, fx, fy}
//       glow     false = 不画镜片内缘光；reflect false = 不画镜片倒影
//       wrap     光包裹强度，默认 0.42（0 关）；wrapStops 光包裹颜色 [[0,'#B9A9EC'],[0.55,'#F4B0B6'],[1,'#FFC490']]
//       halo     逆光辉光强度，默认 0.5（合成里 bloom 很强时调小或 0）；debug true = 标锚点
//   drawGirlMotes(ctx, tl, w, h, opts) 逆光里漂浮的光尘（环境层，24 fps 平滑），建议画在人物层后面
//   girlCamera(tl) → {zoom, fx, fy}    推荐镜头；背景用同一个 zoom × 视差系数（天空 0.25–0.35）
//   girlAnchors(tl, w, h, opts)        镜片、摄像头、触点、鼻尖、下巴、耳朵的画面坐标
//   glowLevel(tl)                      镜片内缘光强度 0–1（给音效、bloom 对齐用）
//   GIRL_SHOT / GIRL_PAL               镜头时间常量 / 色板

import { inkStroke } from '../engine/core/stroke.js';
import { createNoise2D } from '../engine/core/noise.js';
import { mulberry, clamp, lerp, seg, ss, ei } from '../engine/core/math.js';

// ───────────────────────── 色板 ─────────────────────────
export const GIRL_PAL = {
  skin: '#343D69',      // 脸、脖子：逆光暗面平涂（一档）
  skinDeep: '#2A3059',  // 下颌下、耳甲腔、眼窝（二档）
  hair: '#252A51',
  hairLift: '#3B4579',  // 发流线
  cloth: '#1D2445',     // 深蓝工作服
  clothLift: '#3A4474',
  vest: '#B84B25',      // 荧光橙救生衣（背光面，压暗）
  vestDeep: '#A2401F',
  vestRim: '#FFB27A',
  frame: '#181A35',     // 镜框：亮面黑
  hand: '#3E4878',
  rim: '#FFD3B0',       // 粉金边缘光
  rimHot: '#FFF3E8',    // 边缘光最亮的芯
  skyRim: '#9A8FDA',    // 天顶冷光
  ink: '#2A2D52',       // 墨线（深蓝灰，不用纯黑）
  glow: '#9FE8FF',      // 镜片内缘柔光
  kun: '#272B53',       // 倒影里的鲲
};
const PAL = GIRL_PAL;

// ───────────────────────── 镜头参数 ─────────────────────────
export const GIRL_SHOT = {
  start: 3.0,              // 全局起点
  dur: 2.0,                // 镜头长度
  touch: 0.55,             // 镜片内缘光亮起；指腹在一拍二的 0.50 那一拍（全局 3.50–3.58）已贴上镜腿
  reflection: [0.8, 2.0],  // 镜片倒影：粉色天光 + 鲲的暗影从右向左
};
const SCALE = 0.68;                 // 头高 = 画面高 × SCALE
const PIV_H = [-430, 800];          // 颈部转轴（头部局部 mH）
const PIV_S = [0.385, 0.655];       // 转轴在画面上的位置（占宽、高的比例）
const TILT0 = -13.5;                // 基础仰角（度，负 = 下巴抬起）
const LIGHT = norm([1, 0.14]);      // 主光（破晓地平线）在画面里的方向：从右、略偏下
const SKY = norm([-0.12, -1]);      // 天顶冷光方向

// ───────────────────────── 小工具 ─────────────────────────
const D2R = Math.PI / 180;
function norm(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
const q12 = t => Math.floor(t * 12 + 1e-6) / 12;   // 一拍二
const q8 = t => Math.floor(t * 8 + 1e-6) / 8;      // 一拍三
// 仿射矩阵 [a,b,c,d,e,f]，与 canvas setTransform 同序
const M = {
  mul: (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]],
  t: (x, y) => [1, 0, 0, 1, x, y],
  s: (k) => [k, 0, 0, k, 0, 0],
  r: (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; },
  ap: (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]],
};
const chain = (...ms) => ms.reduce((a, b) => M.mul(a, b));

// 噪声：每个用途一个独立的固定种子
const nHair = createNoise2D(mulberry(31013));
const nInk = createNoise2D(mulberry(52511));
const nTex = createNoise2D(mulberry(70117));
const nPap = createNoise2D(mulberry(80021));

// ── 路径：只支持绝对坐标 M L C Q Z ──
function P(str) {
  const tk = str.match(/[MLCQZ]|-?\d*\.?\d+/gi); const out = []; let i = 0, c = 'M';
  while (i < tk.length) {
    const t = tk[i];
    if (/^[MLCQZ]$/i.test(t)) { c = t.toUpperCase(); i++; if (c === 'Z') { out.push(['Z']); continue; } }
    const n = c === 'C' ? 6 : c === 'Q' ? 4 : 2, v = [c];
    for (let k = 0; k < n; k++) v.push(+tk[i++]);
    out.push(v); if (c === 'M') c = 'L';
  }
  return out;
}
// 路径整体缩放（设计时微调大小用）
const scaleAt = (cmds, cx, cy, s) => cmds.map(c => c[0] === 'Z' ? c : [c[0], ...c.slice(1).map((v, i) => i % 2 ? cy + (v - cy) * s : cx + (v - cx) * s)]);
// 把路径的所有点（含控制点）映射到画面：def 是可选的局部形变（风吹头发）
function X(cmds, m, def) {
  return cmds.map(c => {
    if (c[0] === 'Z') return c;
    const o = [c[0]];
    for (let k = 1; k < c.length; k += 2) { const p = M.ap(m, def ? def(c[k], c[k + 1]) : [c[k], c[k + 1]]); o.push(p[0], p[1]); }
    return o;
  });
}
function path2d(cmds, p = new Path2D()) {
  for (const c of cmds) {
    if (c[0] === 'M') p.moveTo(c[1], c[2]);
    else if (c[0] === 'L') p.lineTo(c[1], c[2]);
    else if (c[0] === 'C') p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else if (c[0] === 'Q') p.quadraticCurveTo(c[1], c[2], c[3], c[4]);
    else p.closePath();
  }
  return p;
}
// 采样成折线（画面像素空间里每 step 像素一个点），每个子路径一条
function sample(cmds, step = 3) {
  const polys = []; let cur = null, x = 0, y = 0, sx = 0, sy = 0;
  for (const c of cmds) {
    if (c[0] === 'M') { cur = [[c[1], c[2]]]; polys.push(cur); x = sx = c[1]; y = sy = c[2]; continue; }
    if (!cur) { cur = [[x, y]]; polys.push(cur); }
    if (c[0] === 'L' || c[0] === 'Z') {
      const ex = c[0] === 'Z' ? sx : c[1], ey = c[0] === 'Z' ? sy : c[2];
      const n = Math.max(1, Math.ceil(Math.hypot(ex - x, ey - y) / step));
      for (let i = 1; i <= n; i++) cur.push([x + (ex - x) * i / n, y + (ey - y) * i / n]);
      x = ex; y = ey;
    } else if (c[0] === 'C') {
      const L = Math.hypot(c[1] - x, c[2] - y) + Math.hypot(c[3] - c[1], c[4] - c[2]) + Math.hypot(c[5] - c[3], c[6] - c[4]);
      const n = Math.max(2, Math.ceil(L / step));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
        cur.push([a * x + b * c[1] + d * c[3] + e * c[5], a * y + b * c[2] + d * c[4] + e * c[6]]);
      }
      x = c[5]; y = c[6];
    } else if (c[0] === 'Q') {
      const L = Math.hypot(c[1] - x, c[2] - y) + Math.hypot(c[3] - c[1], c[4] - c[2]);
      const n = Math.max(2, Math.ceil(L / step));
      for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; cur.push([u * u * x + 2 * u * t * c[1] + t * t * c[3], u * u * y + 2 * u * t * c[2] + t * t * c[4]]); }
      x = c[3]; y = c[4];
    }
  }
  return polys;
}
// 点列 → 平滑闭合路径（中点二次贝塞尔）
function smoothClosed(pts, p = new Path2D()) {
  const n = pts.length; if (n < 3) return p;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const m0 = mid(pts[n - 1], pts[0]); p.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n], m = mid(a, b); p.quadraticCurveTo(a[0], a[1], m[0], m[1]); }
  p.closePath(); return p;
}
const polyCmds = pts => [['M', pts[0][0], pts[0][1]], ...pts.slice(1).map(p => ['L', p[0], p[1]]), ['Z']];

// ── 画布缓存（按尺寸复用）──
const pool = new Map();
let DPR = 1;   // drawGirl 每次调用时更新
function canvasFor(key, w, h) {
  let c = pool.get(key);
  if (!c || c.width !== w || c.height !== h) { c = document.createElement('canvas'); c.width = w; c.height = h; pool.set(key, c); }
  return c;
}

// ───────────────────────── 形状（头部局部 mH）─────────────────────────
// 脸 + 颅骨（颅骨部分被头发盖住）。轮廓：额 → 眉骨 → 鼻根 → 鼻梁 → 鼻尖 → 人中 → 唇 → 颏 → 下颌下 → 喉
const HEAD = P(`
M -60 215
C -38 262 -16 318 -8 360
C -3 384 0 398 -1 412
C -4 428 -14 440 -17 452
C -14 482 8 534 44 584
C 60 604 76 618 84 630
C 89 640 86 652 75 657
C 63 661 48 660 38 666
C 40 684 45 700 50 712
C 55 721 55 734 46 741
C 42 744 39 746 36 747
C 42 753 46 763 44 775
C 42 785 33 791 22 798
C 16 805 17 816 22 830
C 28 846 28 864 16 880
C 4 895 -14 903 -38 906
C -90 912 -150 924 -196 940
C -211 946 -219 957 -222 976
C -300 1000 -560 950 -660 880
C -760 780 -885 620 -880 400
C -875 170 -660 -2 -400 0
C -250 2 -100 80 -60 215 Z`);
// 脸部轮廓墨线（分三笔，起收笔带锥形，像手画）
const INK_FACE = [
  P(`M -52 232 C -38 262 -16 318 -8 360 C -3 384 0 398 -1 412 C -4 428 -14 440 -17 452 C -14 482 8 534 44 584 C 60 604 76 618 84 630 C 89 640 86 652 75 657`),
  P(`M 80 655 C 63 661 48 660 38 666 C 40 684 45 700 50 712 C 55 721 55 734 46 741 C 42 744 39 746 36 747 C 42 753 46 763 44 775 C 42 785 33 791 22 798 C 16 805 17 816 22 830 C 28 846 28 864 16 880 C 4 895 -14 903 -38 906`),
  P(`M 0 898 C -38 906 -90 912 -150 924 C -175 930 -196 940 -208 948 C -216 955 -220 964 -222 976`),
];
// 下颌线以下的二档阴影（脖子、下颌底面）
const JAW_SHADE = P(`M -38 900 C -150 882 -330 842 -468 796 C -520 778 -540 734 -548 676 L -720 740 L -720 1300 L -200 1300 L -204 952 C -150 932 -90 912 -38 900 Z`);
// 眼窝阴影
const EYE_SHADE = P(`M -30 436 C -70 428 -120 434 -150 452 C -160 476 -150 506 -120 516 C -90 522 -55 511 -40 494 C -30 478 -24 452 -30 436 Z`);
// 胸锁乳突肌一笔（颈侧暗线）
const NECK_LINE = P(`M -540 742 C -470 842 -380 942 -300 1060`);

// 耳朵（近侧，按 0.86 缩小）
const EAR_C = [-580, 530], ES = 0.86;
const EAR = scaleAt(P(`
M -505 548
C -512 500 -514 452 -530 418
C -545 390 -575 380 -603 390
C -642 404 -662 448 -656 500
C -650 556 -626 590 -610 626
C -598 655 -582 680 -558 676
C -536 672 -522 650 -516 622
C -512 600 -506 576 -505 548 Z`), ...EAR_C, ES);
const EAR_CONCHA = scaleAt(P(`M -532 470 C -562 455 -598 470 -606 510 C -612 548 -598 580 -578 598 C -560 612 -538 600 -532 575 C -526 548 -522 500 -532 470 Z`), ...EAR_C, ES);
// 耳轮外沿一圈（盖住镜腿末端：镜腿从耳轮下面穿到耳后）
const EAR_HELIX = scaleAt(P(`M -528 422 C -545 390 -575 380 -603 390 C -642 404 -662 448 -656 500 C -652 540 -642 568 -628 596 L -606 586 C -622 556 -632 528 -634 498 C -638 456 -622 422 -598 413 C -578 406 -558 412 -544 432 Z`), ...EAR_C, ES);
const INK_EAR = [
  scaleAt(P(`M -506 560 C -512 500 -514 452 -530 418 C -545 390 -575 380 -603 390 C -642 404 -662 448 -656 500 C -650 556 -626 590 -610 626 C -598 655 -582 680 -558 676 C -536 672 -522 650 -516 622`), ...EAR_C, ES),
  scaleAt(P(`M -548 446 C -585 438 -620 466 -622 512 C -624 548 -608 574 -592 590`), ...EAR_C, ES),
];

// 头发底块：盖住颅骨；轮廓大部分被发簇盖住，只有前额发际和耳后一段露在外面
const HAIR_BASE = P(`
M -52 236
C -64 160 -118 66 -220 14
C -360 -46 -580 -58 -740 2
C -880 62 -956 230 -962 400
C -968 470 -976 522 -1004 562
C -972 566 -948 578 -932 596
C -950 628 -962 662 -980 690
C -950 694 -926 704 -906 722
C -914 762 -930 800 -956 834
C -918 828 -884 826 -860 836
C -858 862 -854 890 -846 912
C -822 896 -796 886 -772 884
C -766 904 -760 926 -748 946
C -720 914 -690 878 -664 840
C -648 790 -634 700 -626 620
C -616 520 -602 452 -577 422
C -560 408 -540 410 -520 412
C -440 412 -300 410 -176 404
C -150 372 -128 336 -100 302
C -80 280 -60 262 -52 236 Z`);
// 发流线（顺着往后梳的方向）
const HAIR_FLOW = [
  P(`M -90 168 C -170 70 -330 10 -520 -2 C -640 -8 -730 26 -790 76`),
  P(`M -150 210 C -260 140 -420 112 -570 128 C -690 142 -780 202 -838 270`),
  P(`M -250 262 C -360 232 -500 238 -620 282 C -720 320 -800 400 -850 490`),
  P(`M -390 334 C -480 334 -580 366 -650 432 C -720 498 -780 596 -810 694`),
];
// 发簇：r 根部，a 方向（度：0 朝前，180 朝后，90 向下），len 长，w 根宽，b 总弯曲，fl 发梢回勾，
//       amp 飘动幅度，f 飘动频率，ph 相位，thin 细发丝
const CLUMPS = [
  // 刘海：被迎面的风吹得向后上方掀起
  { r: [-66, 226], a: 238, len: 150, w: 60, b: -44, fl: -8, amp: 10, f: 1.30, ph: 0.12 },
  { r: [-104, 160], a: 222, len: 205, w: 64, b: -32, fl: -10, amp: 11, f: 1.15, ph: 0.41 },
  { r: [-170, 100], a: 207, len: 230, w: 60, b: -20, fl: -8, amp: 12, f: 1.05, ph: 0.77 },
  // 鬓上：盖住太阳穴、顺风往耳后梳
  { r: [-130, 318], a: 190, len: 270, w: 58, b: 10, fl: -10, amp: 7, f: 1.10, ph: 0.95 },
  { r: [-240, 252], a: 186, len: 300, w: 62, b: 8, fl: -12, amp: 8, f: 1.25, ph: 1.02 },
  // 头顶
  { r: [-300, 26], a: 196, len: 225, w: 58, b: -12, fl: 18, amp: 12, f: 1.20, ph: 1.13 },
  { r: [-480, -14], a: 190, len: 220, w: 56, b: -8, fl: 16, amp: 13, f: 1.35, ph: 1.49 },
  // 后脑：短发发梢顺风后掠，一簇压一簇
  { r: [-700, 28], a: 183, len: 210, w: 70, b: 10, fl: -22, amp: 11, f: 1.10, ph: 1.83 },
  { r: [-880, 250], a: 178, len: 165, w: 74, b: 16, fl: -26, amp: 13, f: 1.25, ph: 2.19 },
  { r: [-930, 470], a: 172, len: 120, w: 58, b: 18, fl: -24, amp: 15, f: 1.40, ph: 2.57 },
  // 鬓角：一绺垂在耳前，从镜腿下面钻出来
  { r: [-468, 420], a: 100, len: 165, w: 32, b: 26, fl: 16, amp: 10, f: 1.40, ph: 4.41 },
  // 细发丝（迎光最亮的几根）
  { r: [-600, 4], a: 190, len: 260, w: 9, b: -34, fl: 0, amp: 22, f: 1.05, ph: 4.79, thin: true },
  { r: [-930, 430], a: 178, len: 190, w: 8, b: 40, fl: 0, amp: 26, f: 1.15, ph: 5.17, thin: true },
  { r: [-150, 110], a: 216, len: 220, w: 7, b: -46, fl: 0, amp: 20, f: 1.30, ph: 5.53, thin: true },
  { r: [-900, 690], a: 166, len: 170, w: 7, b: 44, fl: 0, amp: 26, f: 0.95, ph: 5.91, thin: true },
];

// 迎光的细发丝：从前额发际和头顶前半长出来，向后上方飘，被逆光照成亮金色细线
const GLINTS = [
  { r: [-62, 214], a: 262, len: 120, b: -52, amp: 22, f: 1.6, ph: 0.3 },
  { r: [-84, 156], a: 250, len: 170, b: -44, amp: 20, f: 1.4, ph: 0.9 },
  { r: [-112, 112], a: 240, len: 150, b: -46, amp: 24, f: 1.7, ph: 1.4 },
  { r: [-146, 74], a: 232, len: 210, b: -34, amp: 18, f: 1.2, ph: 2.0 },
  { r: [-214, 22], a: 222, len: 230, b: -28, amp: 20, f: 1.5, ph: 2.6 },
  { r: [-270, 0], a: 216, len: 180, b: -34, amp: 22, f: 1.8, ph: 3.1 },
  { r: [-340, -26], a: 210, len: 240, b: -22, amp: 18, f: 1.3, ph: 3.7 },
  { r: [-460, -48], a: 204, len: 260, b: -16, amp: 20, f: 1.1, ph: 4.2 },
  { r: [-180, 50], a: 236, len: 160, b: -50, amp: 26, f: 1.9, ph: 4.8 },
];
function glintLine(s, tq, wind) {
  const N = 14, segL = s.len * (1 + 0.1 * wind) / N, pts = []; let x = s.r[0], y = s.r[1];
  for (let i = 0; i <= N; i++) {
    const u = i / N, wav = nHair(s.ph * 5.3 + u * 1.5 - tq * s.f * 1.8, s.ph * 2.1 + 40);
    const ang = (s.a + s.b * u + s.amp * (0.6 + 0.6 * wind) * u * wav) * D2R;
    pts.push([x, y]); x += Math.cos(ang) * segL; y += Math.sin(ang) * segL;
  }
  return pts;
}

// 眼睛（近侧，在镜片后面）：上睑睫毛线、下睑、睫毛
const EYE_UPPER = P(`M -124 486 C -114 472 -98 464 -82 463 C -76 463 -72 465 -68 468`);
const EYE_LOWER = P(`M -120 490 C -110 498 -94 501 -80 498`);
const LASHES = [P(`M -71 466 C -67 460 -63 456 -56 454`), P(`M -77 465 C -74 458 -71 453 -65 449`), P(`M -85 465 C -84 458 -82 453 -77 448`)];
const IRIS = [-82, 479];
const FAR_LASH = P(`M -12 470 C 0 464 14 462 28 464`);
const FAR_LASHES = [P(`M 20 463 C 27 456 33 453 41 452`)];

// ── AI 眼镜（近侧脸投影）──
// 近侧镜框：上框略粗；外侧能看到端头的侧面（铰链接镜腿处）
const NEAR_FRAME = P(`
M -10 402
C -36 397 -66 395 -92 396
L -118 398
C -125 399 -129 404 -129 410
L -129 438
C -129 443 -127 446 -122 448
C -116 486 -112 528 -109 558
C -107 585 -97 596 -80 596
C -60 598 -42 597 -29 593
C -16 588 -11 579 -11 566
L -6 427
C -5 412 -6 404 -10 402 Z`);
// 近侧镜片
const NEAR_LENS = P(`
M -18 413
C -40 409 -64 407 -80 407
C -92 407 -97 414 -98 425
L -101 554
C -102 573 -94 586 -79 587
C -62 589 -44 589 -32 585
C -21 581 -17 572 -17 559
L -12 428
C -11 418 -13 413 -18 413 Z`);
// 镜腿：粗而平直（内藏电池），末端从耳轮下面穿过
const TEMPLE = P(`
M -120 399
C -250 403 -420 410 -566 417
C -573 418 -577 423 -576 430
L -575 441
C -575 446 -571 448 -566 448
C -420 445 -250 441 -122 441 Z`);
const HINGE = P(`M -129 404 L -129 438`);
// 鼻梁架（跨过鼻梁，接远侧镜框）
const BRIDGE = P(`M -7 407 C -1 404 5 404 11 406 L 12 424 C 6 423 0 423 -6 426 Z`);
// 远侧镜框与镜片：镜框有弧度，远侧镜片转得更偏，只剩窄窄一条从鼻梁前探出
const FAR_FRAME = P(`
M 12 404
C 22 401 36 401 43 404
C 47 406 48 411 48 418
L 50 564
C 50 579 45 586 36 587
C 26 588 17 587 12 583
C 8 580 7 573 7 564
L 5 425
C 5 412 7 405 12 404 Z`);
const FAR_LENS = P(`
M 16 414
C 24 412 32 412 37 414
C 40 415 41 419 41 425
L 43 558
C 43 570 40 576 34 577
C 28 578 22 578 18 575
C 15 573 14 568 14 560
L 12 427
C 12 419 13 415 16 414 Z`);
const CAM_C = [-100, 401];          // 摄像头：镜框正面外侧上角
const TOUCH_AT = [-292, 434];       // 食指指腹压在镜腿侧面下半（铰链后约三分之一处，触控区）

// ── 手（右手手背朝镜头：食指伸直点在镜腿上，其余三指顺势微屈成扇形）──
// 手部局部：原点 = 食指指尖，y 朝手腕（向下）
// 轮廓顺序：指尖 → 食指外沿 → 虎口 → 拇指 → 手腕 → 小指侧 → 小指/无名指/中指弯起的三个指节 → 食指内沿
const H_HAND = P(`
M 0 -2
C 9 -2 17 6 17 22
C 18 58 21 84 21 102
C 21 132 23 172 24 198
C 25 216 25 232 25 248
C 26 290 28 322 30 345
C 31 370 34 396 38 410
C 44 400 52 380 60 364
C 66 354 76 348 84 356
C 92 380 90 420 84 470
C 76 540 56 600 40 646
L -150 648
C -160 570 -172 480 -173 362
C -172 342 -166 328 -154 322
C -144 318 -134 322 -131 330
C -130 314 -122 300 -108 298
C -96 296 -84 304 -80 316
C -78 298 -68 286 -54 286
C -40 286 -30 292 -25 300
C -24 262 -23 224 -22 198
C -21 162 -19 124 -19 102
C -18 70 -17 40 -17 22
C -17 6 -9 -2 0 -2 Z`);
const H_LINES = [   // 指缝、指节纹、拇指根
  P(`M -80 316 C -82 332 -84 346 -86 360`), P(`M -131 330 C -133 344 -134 356 -135 370`), P(`M -25 300 C -24 316 -23 330 -22 344`),
  P(`M -10 96 C -4 100 4 100 10 96`), P(`M -12 196 C -5 201 5 201 12 196`),
  P(`M 38 410 C 34 450 32 490 30 530`),
];
const SLEEVE = P(`M 60 614 C 74 700 84 860 88 1500 L -216 1500 C -210 860 -198 700 -182 622 C -110 604 -10 602 60 614 Z`);
const CUFF = P(`M -184 664 C -100 646 0 644 66 654`);

// ── 衣服（身体局部，不随头仰）──
const JACKET = P(`
M -214 1136
C -330 1114 -560 1074 -718 1032
C -730 1078 -740 1128 -748 1178
C -880 1234 -1100 1288 -1420 1378
L -1420 1800
L -176 1800
C -182 1560 -196 1330 -214 1136 Z`);
const COLLAR_LINE = P(`M -228 1244 C -360 1230 -560 1208 -744 1180`);
const VEST = P(`
M -284 1222
C -470 1196 -720 1194 -960 1258
C -1004 1270 -1036 1290 -1060 1314
L -1160 1800
L -232 1800
C -252 1600 -270 1400 -284 1222 Z`);
const VEST_SEAM = P(`M -292 1290 C -470 1266 -720 1264 -968 1326`);

// 倒影里的鲲（侧影，身长约 1100，原点在身体中段，鼻尖朝左 —— 它在镜片里从右向左游）
const KUN = P(`
M -500 10
C -495 -30 -460 -62 -400 -80
C -300 -108 -120 -118 60 -104
C 200 -92 330 -64 420 -36
C 450 -27 470 -22 488 -20
C 520 -60 560 -110 610 -140
C 600 -100 600 -60 612 -30
C 626 -8 628 8 614 28
C 602 60 604 110 618 150
C 566 120 520 70 490 26
C 440 40 330 70 180 88
C 40 104 -140 112 -300 96
C -400 86 -460 64 -488 40
C -498 30 -501 20 -500 10 Z
M -290 70
C -250 140 -160 250 -40 320
C -16 334 -2 322 -22 304
C -110 228 -186 140 -220 76 Z`);

// ───────────────────────── 镜头与布局 ─────────────────────────
// 推荐镜头：匀速缓推（非变焦），焦点在近侧镜片；24 fps 平滑，不量化。
// 合成代理给背景时，用同一个 zoom 乘一个视差系数（天空约 0.25–0.35）即可。
export function girlCamera(tl) {
  const u = clamp(tl / GIRL_SHOT.dur);
  return { zoom: 1 + 0.065 * u, fx: 0.497, fy: 0.44 };   // fx/fy：推进焦点（占画面宽高的比例）
}

function rig(tl, w, h, opts) {
  const tq = q12(tl);                                    // 一拍二时钟
  const k = SCALE * h / 1000;                            // mH → 像素
  const cam = opts.cam === false ? { zoom: 1, fx: 0.5, fy: 0.5 } : (opts.cam || girlCamera(tl));
  const C = chain(M.t(cam.fx * w, cam.fy * h), M.s(cam.zoom), M.t(-cam.fx * w, -cam.fy * h));
  const breath = Math.sin(tq / 3.3 * Math.PI * 2 + 0.6) * 4;      // mH
  const lookUp = ss(seg(tq, 1.0, 1.85));                           // 暗影划过时再微微抬头
  const tilt = (TILT0 - 2.4 * lookUp + 0.4 * Math.sin(tq * 2.1)) * D2R;
  const pv = [PIV_S[0] * w, PIV_S[1] * h];
  const body = chain(C, M.t(pv[0], pv[1]), M.s(k), M.t(-PIV_H[0], -PIV_H[1] + breath));
  const head = chain(C, M.t(pv[0], pv[1]), M.s(k), M.r(tilt), M.t(-PIV_H[0], -PIV_H[1] + breath * 0.8));
  const px = k * cam.zoom;                                         // 1 mH 在画面里的像素数
  // 手：0.12 从画面下方抬起 → 0.42 悬停 → 0.50 指腹贴上镜腿（一拍二的这一拍覆盖全局 3.50–3.58，含 3.55）
  //     → 0.55 镜片内缘光亮起 → 0.95 起放下 → 1.42 出画
  const rise = ss(seg(tq, 0.12, 0.42)), reach = ss(seg(tq, 0.42, 0.5)), down = ei(seg(tq, 0.95, 1.42));
  const press = tq >= 0.5 && tq < 0.67 ? 1 : 0;                   // 触碰时指尖轻压一下（一拍二下就是两拍）
  const dy = lerp(920, 40, rise) - 40 * reach - 4 * press + 940 * down;
  const hand = {
    on: tq > 0.13 && tq < 1.42,
    m: chain(head, M.t(TOUCH_AT[0] + 50 * (1 - rise) - 40 * down, TOUCH_AT[1] + dy),
      M.r((5 + 12 * (1 - rise) - 8 * down) * D2R)),
  };
  return { tq, tl, k, px, cam, C, body, head, hand, tilt, w, h };
}

// 主要锚点的画面坐标（给合成代理对齐光效、景深焦点用）
export function girlAnchors(tl, w, h, opts = {}) {
  const R = rig(tl, w, h, opts);
  const c = (m, p) => M.ap(m, p);
  return {
    nearLens: c(R.head, [-58, 498]), farLens: c(R.head, [27, 496]), camera: c(R.head, CAM_C),
    touch: c(R.head, TOUCH_AT), noseTip: c(R.head, [86, 642]), chin: c(R.head, [22, 860]), ear: c(R.head, EAR_C),
    px: R.px,
  };
}

// ───────────────────────── 绘制零件 ─────────────────────────
// 偏移法边缘光：形状 − 朝光反方向平移后的形状 = 迎光一侧的一条硬边光带。
//   o.spread：再加左右各偏 spread 度的两道（面光源），凸起处（鼻尖、唇、下巴）的光带自然更宽；
//   o.occ：遮挡物（例如头发挨着脸的一边不该有天光边）——迎光一侧被它挡住的地方不出光；
//   o.mask：在光带上再做一次 destination-in（渐隐）；o.blur：整体模糊（做内渗光）。
function rimPass(g, path, dir, d, color, o = {}) {
  const W = g.canvas.width, H = g.canvas.height, T = g.getTransform();
  const A = canvasFor('rimA', W, H), a = A.getContext('2d');
  const B = canvasFor('rimB', W, H), b = B.getContext('2d');
  a.setTransform(1, 0, 0, 1, 0, 0); a.globalCompositeOperation = 'source-over'; a.clearRect(0, 0, W, H);
  const dirs = o.spread ? [[0, 1], [-o.spread, 0.75], [o.spread, 0.75]] : [[0, 1]];
  for (const [ang, f] of dirs) {
    const c = Math.cos(ang * D2R), s = Math.sin(ang * D2R);
    const dx = (dir[0] * c - dir[1] * s) * d * f, dy = (dir[0] * s + dir[1] * c) * d * f;
    b.setTransform(1, 0, 0, 1, 0, 0); b.globalCompositeOperation = 'source-over'; b.clearRect(0, 0, W, H);
    b.setTransform(T); b.fillStyle = color; b.fill(path);
    b.globalCompositeOperation = 'destination-out'; b.translate(-dx, -dy); b.fill(path); if (o.occ) b.fill(o.occ);
    a.setTransform(1, 0, 0, 1, 0, 0); a.drawImage(B, 0, 0);
  }
  if (o.mask) { a.setTransform(T); a.globalCompositeOperation = 'destination-in'; o.mask(a); a.globalCompositeOperation = 'source-over'; }
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = o.alpha ?? 1;
  if (o.blur > 0) g.filter = `blur(${o.blur * DPR}px)`;
  g.drawImage(A, 0, 0); g.restore();
}
// 软的内渗光：光带模糊后限制在形状内部，像逆光从边缘渗进来
function rimBleed(g, path, dir, d, color, o) {
  g.save(); g.clip(path); rimPass(g, path, dir, d, color, o); g.restore();
}
// 竖向渐隐遮罩：在 m 坐标系里从 y0（全亮）到 y1（全隐）
const fadeMask = (m, y0, y1) => fadeAlong(m, [0, y0], [0, y1]);
const fadeAlong = (m, q0, q1) => a => {
  const p0 = M.ap(m, q0), p1 = M.ap(m, q1);
  const gr = a.createLinearGradient(p0[0], p0[1], p1[0], p1[1]); gr.addColorStop(0, '#000'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  a.save(); a.setTransform(1, 0, 0, 1, 0, 0); a.fillStyle = gr; a.fillRect(0, 0, a.canvas.width, a.canvas.height); a.restore();
};

// 手绘墨线（engine/core/stroke.js）：有粗细起伏；每一拍二换一次抖动形状
function ink(g, poly, o, R) {
  if (!poly || poly.length < 3) return;
  const pts = [poly[0]]; let acc = 0;                 // 等距重采样（约 3 像素）
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i]; acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc >= 3 || i === poly.length - 1) { pts.push(b); acc = 0; }
  }
  const n = pts.length; if (n < 3) return;
  const st = Math.floor(R.tq * 12 + 1e-6), sd = o.seed || 0, jit = (o.jit ?? 0.7) * R.h / 1040 * R.cam.zoom;
  const pp = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const j = jit * nInk(i * 0.05 + sd * 3.7, st * 1.37 + sd);
    const pr = clamp(0.52 + 0.36 * nInk(i * 0.022 + sd * 5.1, 9.3 + sd) + 0.1 * nInk(i * 0.09, st * 0.71 + sd * 2), 0.06, 1);
    pp.push([pts[i][0] - ty * j, pts[i][1] + tx * j, pr]);
  }
  const size = (o.size || 2.6) * R.h / 1040 * R.cam.zoom;
  const ol = inkStroke(pp, {
    size, thinning: o.thin ?? 0.62, smoothing: 0.62, streamline: 0.16, simulatePressure: false, last: true,
    start: { taper: (o.t0 ?? 7) * size, cap: true }, end: { taper: (o.t1 ?? 7) * size, cap: true },
  });
  g.globalAlpha = o.alpha ?? 1; g.fillStyle = o.color || PAL.ink; g.fill(smoothClosed(ol)); g.globalAlpha = 1;
}
const inkPath = (g, cmds, o, R) => { for (const pl of sample(cmds, 2.5)) ink(g, pl, o, R); };

// 发簇：沿方向积分出中心线（带沿发丝传播的飘动波和发梢回勾），宽度从根部收成尖
function clumpPoly(s, tq, wind) {
  const N = 20, segL = s.len * (1 + 0.06 * wind) / N, C = [];
  let x = s.r[0], y = s.r[1];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const wav = nHair(s.ph * 7.1 + u * 1.2 - tq * s.f * 1.6, s.ph * 3.3 + tq * 0.35);
    const ang = (s.a + s.b * u + (s.fl || 0) * ss(seg(u, 0.55, 1)) + s.amp * (0.5 + 0.6 * wind) * u * wav) * D2R;
    C.push([x, y, ang]); x += Math.cos(ang) * segL; y += Math.sin(ang) * segL;
  }
  const Lp = [], Rp = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, [px, py, a] = C[i];
    const bulge = s.thin ? 1 : 1 + 0.14 * Math.sin(Math.min(1, u * 1.8) * Math.PI);
    const wv = s.w * 0.5 * Math.pow(1 - u, s.thin ? 0.75 : 1.45) * bulge;
    const nx = -Math.sin(a), ny = Math.cos(a);
    Lp.push([px + nx * wv * 1.08, py + ny * wv * 1.08]); Rp.push([px - nx * wv * 0.92, py - ny * wv * 0.92]);
  }
  return Lp.concat(Rp.reverse());
}
// 风吹后脑的头发底块：越靠后、越靠下越自由
function hairDeform(tq, wind) {
  return (x, y) => {
    const free = ss(seg(-x, 600, 960)) * (0.35 + 0.65 * ss(seg(y, 80, 860)));
    const crown = ss(seg(-y, -10, -75)) * 0.55;
    const kk = free + crown; if (kk <= 0) return [x, y];
    const tip = ss(seg(y, 520, 900)) * ss(seg(-x, 640, 900));      // 发梢更自由
    const n1 = nHair(y * 0.004 + 3.1, tq * 1.6), n2 = nHair(x * 0.004 - 5.7, tq * 2.0 + 4), n3 = nHair(y * 0.011 - 2.2, tq * 2.3 + 9);
    return [x - kk * (10 + 10 * wind + 7 * n1) - tip * (18 + 22 * wind + 12 * n3), y + kk * (7 * n2 - 4 * wind) - tip * (14 * wind + 8 * n2)];
  };
}
// 水彩斑驳纹理（一次生成，低分辨率放大成柔和斑块）+ 纸纹
let TEX = null;
function texture() {
  if (TEX) return TEX;
  const W = 480, H = 260, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), im = g.createImageData(W, H), d = im.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W * 4.2, v = y / H * 2.3;
    let f = 0, a = 1, s = 1; for (let o = 0; o < 4; o++) { f += a * nTex(u * s, v * s); a *= 0.5; s *= 2.1; }
    const pap = nPap(x * 0.9, y * 0.9) * 0.5 + nPap(x * 0.31 + 50, y * 0.31) * 0.5;   // 细纸纹
    const i = (y * W + x) * 4, v2 = f * 0.8 + pap * 0.35;
    if (v2 > 0) { d[i] = 104; d[i + 1] = 110; d[i + 2] = 170; d[i + 3] = Math.min(255, v2 * 120); }
    else { d[i] = 20; d[i + 1] = 22; d[i + 2] = 52; d[i + 3] = Math.min(255, -v2 * 140); }
  }
  g.putImageData(im, 0, 0); TEX = c; return c;
}
function applyTexture(g, alpha, clip) {
  g.save(); if (clip) g.clip(clip);
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop'; g.globalAlpha = alpha;
  g.imageSmoothingEnabled = true; g.drawImage(texture(), 0, 0, g.canvas.width, g.canvas.height); g.restore();
}

// ───────────────────────── 主函数 ─────────────────────────
// drawGirl(ctx, tl, w, h, opts)
//   ctx  目标 2D 上下文（透明画布，用户空间尺寸 w×h；已有的变换会被沿用）
//   tl   镜头内时间 0–2 秒（全局 3.00–5.00）
//   opts.cam     镜头：默认 girlCamera(tl) 缓推；传 false 关掉；也可传 {zoom, fx, fy}
//   opts.glow    false 时不画镜片内缘光
//   opts.reflect false 时不画镜片倒影
//   opts.debug   true 时标出锚点
export function drawGirl(ctx, tl, w, h, opts = {}) {
  DPR = ctx.canvas.width / w;   // 画布比 w 大时（原生 4K），画布滤镜的模糊半径要乘它（滤镜长度不随变换缩放）
  const R = rig(tl, w, h, opts);
  const { head, body, hand, tq, px } = R;
  const T0 = ctx.getTransform();
  const L1 = canvasFor('L1', ctx.canvas.width, ctx.canvas.height), g = L1.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.filter = 'none';
  g.clearRect(0, 0, L1.width, L1.height); g.setTransform(T0);

  const wind = 0.45 + 0.75 * ss(seg(tq, 0.8, 1.15)) * (1 - 0.5 * ss(seg(tq, 1.6, 2.0)));   // 暗影掠过时起一阵风
  const rimD = 8 * px, hot = 2.6 * px, bleedBlur = 6 * px / 0.707;

  // ── 1. 皮肤：头 + 脖子 ──
  const headC = X(HEAD, head);
  const throat = M.ap(head, [-222, 976]), nape = M.ap(head, [-655, 880]);
  const cf = M.ap(body, [-236, 1192]), cb = M.ap(body, [-700, 1080]);
  const c1 = M.ap(head, [-224, 1046]), c2 = M.ap(body, [-232, 1140]);
  const neckC = [['M', ...throat], ['C', ...c1, ...c2, ...cf], ['L', ...M.ap(body, [-240, 1500])], ['L', ...M.ap(body, [-700, 1500])], ['L', ...cb], ['L', ...nape], ['Z']];
  const skin = path2d(headC); path2d(neckC, skin);
  g.fillStyle = PAL.skin; g.fill(skin);
  g.save(); g.clip(skin);
  g.fillStyle = PAL.skinDeep; g.fill(path2d(X(JAW_SHADE, head)));
  g.globalAlpha = 0.55; g.fillStyle = PAL.skinDeep; g.fill(path2d(X(EYE_SHADE, head)));
  g.globalAlpha = 1; g.restore();
  const neckFade = fadeMask(body, 1060, 1230);
  rimBleed(g, skin, LIGHT, rimD * 2.6, PAL.rim, { alpha: 0.3, blur: bleedBlur, mask: neckFade });
  rimPass(g, skin, LIGHT, rimD, PAL.rim, { spread: 24, mask: neckFade });
  rimPass(g, skin, LIGHT, hot, PAL.rimHot, { spread: 24, alpha: 0.9, mask: neckFade });
  inkPath(g, X(NECK_LINE, head), { size: 1.6, alpha: 0.5, seed: 41, t0: 12, t1: 10 }, R);
  INK_FACE.forEach((f, i) => inkPath(g, X(f, head), { size: 2.5, seed: 3 + i, t0: 5, t1: 6 }, R));
  inkPath(g, neckC.slice(0, 2), { size: 2.3, seed: 9, t0: 4, t1: 9 }, R);

  // ── 2. 衣服：深蓝工作服领口 + 荧光橙救生衣边 ──
  const jacket = path2d(X(JACKET, body));
  g.fillStyle = PAL.cloth; g.fill(jacket);
  rimPass(g, jacket, SKY, 5 * px, PAL.clothLift, { alpha: 0.9 });
  rimPass(g, jacket, LIGHT, 7 * px, '#E9B69C', { alpha: 0.85, spread: 20 });
  inkPath(g, X(COLLAR_LINE, body), { size: 1.9, seed: 51, alpha: 0.9 }, R);
  const vest = path2d(X(VEST, body));
  g.fillStyle = PAL.vest; g.fill(vest);
  g.save(); g.clip(vest); g.globalAlpha = 0.85; g.fillStyle = PAL.vestDeep;
  g.fill(path2d(X(P(`M -980 1330 C -720 1272 -470 1272 -282 1300 L -240 1800 L -1200 1800 Z`), body))); g.restore();
  rimPass(g, vest, LIGHT, 10 * px, PAL.vestRim, { spread: 20 });
  rimPass(g, vest, LIGHT, 3 * px, '#FFE5CC', { alpha: 0.9 });
  rimPass(g, vest, SKY, 5 * px, '#F08C5E', { alpha: 0.85 });
  inkPath(g, X(VEST, body), { size: 2.2, seed: 57 }, R);
  inkPath(g, X(VEST_SEAM, body), { size: 1.5, seed: 58, alpha: 0.7 }, R);
  inkPath(g, X(JACKET, body), { size: 2.2, seed: 59 }, R);

  // ── 3. 头发 ──
  const hdef = hairDeform(tq, wind);
  const baseC = X(HAIR_BASE, head, hdef);
  const hair = path2d(baseC);
  const clumps = CLUMPS.map(s => clumpPoly(s, tq, wind).map(p => M.ap(head, p)));
  clumps.forEach(cp => smoothClosed(cp, hair));
  g.fillStyle = PAL.hair; g.fill(hair);
  g.save(); g.clip(hair);
  HAIR_FLOW.forEach((f, i) => inkPath(g, X(f, head, hdef), { size: 2.0, color: PAL.hairLift, alpha: 0.7, seed: 70 + i, t0: 10, t1: 14 }, R));
  g.restore();
  const hairFront = fadeAlong(head, [-260, 0], [-520, 0]);
  rimBleed(g, hair, LIGHT, rimD * 2, PAL.rim, { alpha: 0.22, blur: bleedBlur * 0.8, occ: skin, mask: hairFront });
  rimPass(g, hair, SKY, 6 * px, PAL.skyRim, { alpha: 0.75, occ: skin });
  rimPass(g, hair, LIGHT, rimD * 0.9, PAL.rim, { spread: 22, occ: skin, mask: hairFront });
  rimPass(g, hair, LIGHT, hot * 0.9, PAL.rimHot, { alpha: 0.85, occ: skin, mask: hairFront });
  // 发簇轮廓墨线：底块只描露在外面的前额发际，发簇各自描边
  clumps.forEach((cp, i) => ink(g, sample(polyCmds(cp), 2.5)[0], { size: CLUMPS[i].thin ? 1.2 : 2.1, seed: 90 + i, t0: 6, t1: 6 }, R));
  // 迎光细发丝：暖金色，带一点辉光
  g.save(); g.shadowColor = PAL.rim; g.shadowBlur = 5 * px;
  GLINTS.forEach((s, i) => {
    const pl = glintLine(s, tq, wind).map(p => M.ap(head, hdef(p[0], p[1])));
    const warm = clamp((s.r[0] + 480) / 300);
    ink(g, pl, { size: 1.25, thin: 0.45, seed: 300 + i, t0: 2, t1: 14, jit: 0.25, color: warm > 0.5 ? '#FFDCC2' : '#E6D8F4', alpha: 0.55 + 0.4 * warm }, R);
  });
  g.restore();
  inkPath(g, X(P(`M -40 300 C -48 262 -56 240 -58 228 C -66 170 -100 100 -150 60`), head, hdef), { size: 2.2, seed: 89, t0: 6, t1: 10 }, R);

  // ── 4. 耳朵（盖在头发上；镜腿稍后从耳轮下穿过）──
  const ear = path2d(X(EAR, head));
  g.fillStyle = PAL.skin; g.fill(ear);
  g.fillStyle = PAL.skinDeep; g.fill(path2d(X(EAR_CONCHA, head)));
  rimPass(g, ear, SKY, 4 * px, PAL.skyRim, { alpha: 0.5 });
  inkPath(g, X(INK_EAR[1], head), { size: 1.5, seed: 101, alpha: 0.85 }, R);

  // ── 5. 眼睛（镜片后面；逆光里只剩睫毛线和一点眼神光）──
  inkPath(g, X(EYE_UPPER, head), { size: 3.4, seed: 111, t0: 3, t1: 1.5, color: '#181C3E', thin: 0.4 }, R);
  inkPath(g, X(EYE_LOWER, head), { size: 1.3, seed: 112, color: '#181C3E', alpha: 0.75 }, R);
  LASHES.forEach((l, i) => inkPath(g, X(l, head), { size: 1.6, seed: 113 + i, t0: 1, t1: 4, color: '#181C3E' }, R));
  { const c = M.ap(head, IRIS), r = 13 * px;
    g.fillStyle = '#161A3A'; g.beginPath(); g.ellipse(c[0], c[1], r * 0.55, r, R.tilt, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#FFE9F2'; g.globalAlpha = 0.85; g.beginPath(); g.arc(c[0] + 1.5 * px, c[1] - 4 * px, 2.2 * px, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }

  // ── 6. 天顶环境光（上亮下暗）+ 斑驳纹理（只作用于以上人物部分）──
  { const a0 = M.ap(head, [0, -60]), a1 = M.ap(body, [0, 1300]);
    const ag = g.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
    ag.addColorStop(0, 'rgba(120,128,206,0.20)'); ag.addColorStop(0.45, 'rgba(120,128,206,0)'); ag.addColorStop(0.75, 'rgba(14,16,44,0)'); ag.addColorStop(1, 'rgba(14,16,44,0.32)');
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop'; g.fillStyle = ag;
    g.setTransform(T0); g.fillRect(-w, -h, 3 * w, 3 * h); g.restore(); }
  applyTexture(g, 0.32);

  // ── 7. 远侧镜框（在脸后面：先画到 L0，再用 destination-over 垫到底下）──
  const nearLensC = X(NEAR_LENS, head), nearLens = path2d(nearLensC);
  const farLens = path2d(X(FAR_LENS, head));
  {
    const L0 = canvasFor('L0', L1.width, L1.height), f = L0.getContext('2d');
    f.setTransform(1, 0, 0, 1, 0, 0); f.globalCompositeOperation = 'source-over'; f.clearRect(0, 0, L0.width, L0.height); f.setTransform(T0);
    inkPath(f, X(FAR_LASH, head), { size: 2.2, seed: 119, t0: 1, t1: 3, color: '#1A1E40' }, R);
    FAR_LASHES.forEach((l, i) => inkPath(f, X(l, head), { size: 1.4, seed: 120 + i, t0: 1, t1: 4, color: '#1A1E40' }, R));
    if (opts.reflect !== false) lensReflection(f, farLens, R, 1);
    const fr = path2d(X(FAR_FRAME, head)); path2d(X(FAR_LENS, head), fr);
    f.fillStyle = PAL.frame; f.fill(fr, 'evenodd');
    rimPass(f, fr, LIGHT, 3.6 * px, '#FFE4CF', { alpha: 0.95 });
    rimPass(f, fr, SKY, 2.6 * px, '#CFC7F2', { alpha: 0.7 });
    if (opts.glow !== false) lensGlowLine(f, farLens, R, 0.5);
    inkPath(f, X(FAR_FRAME, head), { size: 1.8, seed: 121, t0: 2, t1: 2 }, R);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-over'; g.drawImage(L0, 0, 0); g.restore();
  }

  // ── 8. 近侧：镜片倒影、镜腿、镜框、摄像头 ──
  if (opts.reflect !== false) lensReflection(g, nearLens, R, 0);
  const templeC = X(TEMPLE, head), temple = path2d(templeC);
  g.fillStyle = PAL.frame; g.fill(temple);
  rimPass(g, temple, SKY, 3 * px, '#D9D2F7', { alpha: 0.85 });
  rimPass(g, temple, LIGHT, 2.4 * px, '#FFE2CC', { alpha: 0.45 });
  inkPath(g, templeC, { size: 1.8, seed: 131, t0: 3, t1: 3 }, R);
  // 耳轮外沿盖住镜腿末端
  const helix = path2d(X(EAR_HELIX, head));
  g.fillStyle = PAL.skin; g.fill(helix);
  applyTexture(g, 0.32, helix);
  rimPass(g, helix, SKY, 4 * px, PAL.skyRim, { alpha: 0.5 });
  inkPath(g, X(INK_EAR[0], head), { size: 2.1, seed: 102, t0: 4, t1: 6 }, R);
  // 近侧镜框（含端头）
  const nf = path2d(X(NEAR_FRAME, head)); path2d(nearLensC, nf);
  g.fillStyle = PAL.frame; g.fill(nf, 'evenodd');
  rimPass(g, nf, LIGHT, 3.6 * px, '#FFE4CF', { alpha: 0.95 });
  rimPass(g, nf, SKY, 2.6 * px, '#CFC7F2', { alpha: 0.6 });
  inkPath(g, X(NEAR_FRAME, head), { size: 1.9, seed: 141, t0: 3, t1: 3 }, R);
  inkPath(g, nearLensC, { size: 1.2, seed: 142, alpha: 0.75 }, R);
  inkPath(g, X(HINGE, head), { size: 1.2, seed: 143, color: '#3C4170', t0: 1, t1: 1 }, R);
  const br = path2d(X(BRIDGE, head)); g.fillStyle = PAL.frame; g.fill(br); rimPass(g, br, LIGHT, 2.6 * px, '#FFE4CF', { alpha: 0.9 });
  // 摄像头：镜框正面外侧上角一个小圆窗（侧看成窄椭圆），玻璃里一点天光
  { const c = M.ap(head, CAM_C), r = 7 * px;
    g.fillStyle = '#0C0E26'; g.beginPath(); g.ellipse(c[0], c[1], r * 0.5, r, R.tilt, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#555B8E'; g.lineWidth = Math.max(1, 1.1 * px); g.stroke();
    g.fillStyle = '#F7DCEA'; g.globalAlpha = 0.9; g.beginPath(); g.arc(c[0] + 0.8 * px, c[1] - 2.2 * px, 1.5 * px, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
  if (opts.glow !== false) lensGlowLine(g, nearLens, R, 1);

  // ── 9. 手（最近，单独一层：有自己的纹理）──
  if (hand.on) drawHand(g, R, T0);

  if ((opts.wrap ?? 0.42) > 0) lightWrap(g, L1, R, opts.wrap ?? 0.42, opts.wrapStops);

  // ── 10. 逆光辉光（halo）：迎光边的光带模糊后垫到人物底下，只在剪影外的天空里看得到 ──
  //        合成代理若自己做 bloom，可以传 opts.halo 调小（0 关掉）
  const halo = opts.halo ?? 0.5;
  if (halo > 0) {
    const Hc = canvasFor('halo', L1.width, L1.height), hq = Hc.getContext('2d');
    hq.setTransform(1, 0, 0, 1, 0, 0); hq.globalCompositeOperation = 'source-over'; hq.globalAlpha = 1; hq.filter = 'none';
    hq.clearRect(0, 0, Hc.width, Hc.height); hq.setTransform(T0);
    rimPass(hq, skin, LIGHT, rimD * 1.6, PAL.rim, { spread: 24, mask: neckFade });
    rimPass(hq, hair, LIGHT, rimD * 1.4, PAL.rim, { spread: 22, occ: skin, mask: hairFront });
    const dpr = L1.width / w;
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-over';
    g.globalAlpha = halo; g.filter = `blur(${12 * px / 0.707 * dpr}px)`; g.drawImage(Hc, 0, 0);
    g.globalAlpha = halo * 0.55; g.filter = `blur(${34 * px / 0.707 * dpr}px)`; g.drawImage(Hc, 0, 0);
    g.restore();
  }
  if (opts.debug) debugMarks(g, R);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(L1, 0, 0); ctx.restore();
}

// 漂浮光尘（逆光里的水汽/尘埃），环境元素：24 fps 平滑，不量化。确定性：位置来自固定种子 + 时间。
const MOTES = (() => { const r = mulberry(61001), a = [];
  for (let i = 0; i < 26; i++) a.push({ x: 0.35 + r() * 0.75, y: 0.05 + r() * 0.85, s: 1.2 + r() * r() * 3.6, vx: 0.018 + r() * 0.03, vy: (r() - 0.6) * 0.012, ph: r() * 6.28, d: 0.4 + r() * 0.6 });
  return a; })();
export function drawGirlMotes(ctx, tl, w, h, opts = {}) {
  const cam = opts.cam === false ? { zoom: 1, fx: 0.5, fy: 0.5 } : (opts.cam || girlCamera(tl));
  ctx.save();
  for (const m of MOTES) {
    const z = 1 + (cam.zoom - 1) * (0.6 + m.d);                       // 近的尘埃推进更明显
    let x = ((m.x - (m.vx * m.d) * (tl + 3) * 1.6) % 1.1 + 1.1) % 1.1 - 0.05, y = m.y + m.vy * tl + 0.006 * Math.sin(tl * 2.1 + m.ph);
    x = cam.fx + (x - cam.fx) * z; y = cam.fy + (y - cam.fy) * z;
    const tw = 0.55 + 0.45 * Math.sin(tl * 3.3 + m.ph * 3);
    const r = m.s * h / 1040 * (0.7 + 0.5 * m.d);
    const gr = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * 3.2);
    gr.addColorStop(0, `rgba(255,244,232,${0.85 * tw})`); gr.addColorStop(0.35, `rgba(255,214,186,${0.35 * tw})`); gr.addColorStop(1, 'rgba(255,214,186,0)');
    ctx.fillStyle = gr; ctx.fillRect(x * w - r * 3.2, y * h - r * 3.2, r * 6.4, r * 6.4);
  }
  ctx.restore();
}

// 光包裹（light wrap）：用整层人物的 alpha 做遮罩，外沿一圈渗进天空色；画面底边被裁的衣服处不做
function lightWrap(g, L1, R, amt, stops) {
  const W = L1.width, H = L1.height, Wc = canvasFor('wrap', W, H), q = Wc.getContext('2d');
  const r = 9 * R.px / 0.707 * (W / (R.w || W));
  q.setTransform(1, 0, 0, 1, 0, 0); q.globalCompositeOperation = 'source-over'; q.globalAlpha = 1; q.filter = 'none';
  q.clearRect(0, 0, W, H); q.drawImage(L1, 0, 0);
  q.globalCompositeOperation = 'source-in';
  const gr = q.createLinearGradient(0, 0, 0, H);
  (stops || [[0, '#B9A9EC'], [0.55, '#F4B0B6'], [1, '#FFC490']]).forEach(([o, c]) => gr.addColorStop(o, c));
  q.fillStyle = gr; q.fillRect(0, 0, W, H);
  q.globalCompositeOperation = 'destination-out'; q.filter = `blur(${r}px)`; q.drawImage(L1, 0, 0); q.filter = 'none';
  const fb = q.createLinearGradient(0, H - 90 * H / 1040, 0, H); fb.addColorStop(0, 'rgba(0,0,0,0)'); fb.addColorStop(0.6, '#000');
  q.fillStyle = fb; q.fillRect(0, 0, W, H);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop'; g.globalAlpha = amt; g.drawImage(Wc, 0, 0); g.restore();
}

// 触碰后的镜片内缘光（平滑）：70 ms 亮起，0.5 s 内回落到常亮的 42%
export function glowLevel(tl) {
  const t = tl - GIRL_SHOT.touch;
  if (t < 0) return 0;
  return ss(clamp(t / 0.07)) * lerp(1, 0.42, ss(clamp((t - 0.1) / 0.5)));
}
function lensGlowLine(g, lens, R, gain) {
  const a = glowLevel(R.tl) * gain; if (a <= 0.003) return;
  const px = R.px, t = R.tl - GIRL_SHOT.touch;
  g.save(); g.clip(lens);
  const flash = 0.32 * gain * ss(clamp(t / 0.04)) * Math.exp(-Math.max(0, t - 0.04) / 0.12);
  if (flash > 0.004) { g.globalAlpha = flash; g.fillStyle = PAL.glow; g.fill(lens); }
  g.globalAlpha = a;
  g.shadowColor = PAL.glow; g.shadowBlur = 16 * px; g.strokeStyle = PAL.glow; g.lineWidth = 6 * px; g.stroke(lens);
  g.shadowBlur = 5 * px; g.strokeStyle = '#E9FCFF'; g.lineWidth = 2.6 * px; g.stroke(lens);
  g.restore();
}

// 镜片倒影：天光渐变（0.8 后转成粉色天光）+ 鲲的暗影从右向左（一拍三）+ 表面高光
function lensReflection(g, lens, R, far) {
  const tl = R.tl, px = R.px, head = R.head;
  const pink = ss(seg(tl, 0.8, 1.15));
  const base = lerp(0.24, 0.74, pink);
  const top = M.ap(head, [0, 405]), bot = M.ap(head, [0, 595]);
  g.save(); g.clip(lens);
  const gr = g.createLinearGradient(top[0], top[1], bot[0], bot[1]);
  gr.addColorStop(0, '#9C8FD8'); gr.addColorStop(0.42, '#F2A0A6'); gr.addColorStop(0.78, '#FFB26B'); gr.addColorStop(1, '#FFD9B8');
  g.globalAlpha = base; g.fillStyle = gr; g.fill(lens);
  // 鲲的暗影：一拍三。0.80 鼻尖进入远侧镜片 → 2.0 尾鳍正扫过近侧镜片
  const kt = q8(tl), s = 0.3;
  if (kt >= 0.8) {
    const u = clamp((kt - 0.8) / 1.2);
    const cx = lerp(43 + 500 * s, -55 - 600 * s, u);
    const km = chain(head, M.t(cx, 492 - 10 * u), M.r(-0.05 + 0.04 * u), M.s(s));
    g.globalAlpha = 0.92 * (0.6 + 0.4 * pink);
    g.filter = `blur(${Math.max(0.6, 1.0 * px) * DPR}px)`;
    g.fillStyle = PAL.kun; g.fill(path2d(X(KUN, km)));
    g.filter = 'none';
  }
  // 表面：边缘菲涅尔提亮 + 上角一小道锐利高光
  g.globalAlpha = 0.18 + 0.2 * pink; g.strokeStyle = '#FFE9F0'; g.lineWidth = 6 * px; g.filter = `blur(${2.5 * px * DPR}px)`; g.stroke(lens); g.filter = 'none';
  const h0 = M.ap(head, far ? [20, 430] : [-88, 426]), h1 = M.ap(head, far ? [40, 520] : [-30, 540]);
  const hg = g.createLinearGradient(h0[0], h0[1], h1[0], h1[1]);
  hg.addColorStop(0, 'rgba(255,246,250,0)'); hg.addColorStop(0.3, 'rgba(255,246,250,0.0)'); hg.addColorStop(0.38, 'rgba(255,246,250,0.42)');
  hg.addColorStop(0.47, 'rgba(255,246,250,0.12)'); hg.addColorStop(0.53, 'rgba(255,246,250,0.3)'); hg.addColorStop(0.6, 'rgba(255,246,250,0)'); hg.addColorStop(1, 'rgba(255,246,250,0)');
  g.globalAlpha = 0.55 + 0.45 * pink; g.fillStyle = hg; g.fill(lens);
  g.restore();
}

function drawHand(g, R, T0) {
  const m = R.hand.m, px = R.px;
  const L2 = canvasFor('L2', g.canvas.width, g.canvas.height), h = L2.getContext('2d');
  h.setTransform(1, 0, 0, 1, 0, 0); h.globalCompositeOperation = 'source-over'; h.globalAlpha = 1; h.clearRect(0, 0, L2.width, L2.height); h.setTransform(T0);
  // 袖口（深蓝工作服）
  const sleeve = path2d(X(SLEEVE, m));
  h.fillStyle = PAL.cloth; h.fill(sleeve);
  rimPass(h, sleeve, LIGHT, 7 * px, '#E9B69C', { alpha: 0.8 });
  const handC = X(H_HAND, m), all = path2d(handC);
  h.fillStyle = PAL.hand; h.fill(all);
  h.save(); h.clip(all);                                  // 手背下半渐入暗部
  const a = M.ap(m, [0, 400]), b = M.ap(m, [0, 700]);
  const sg = h.createLinearGradient(a[0], a[1], b[0], b[1]); sg.addColorStop(0, 'rgba(36,41,80,0)'); sg.addColorStop(1, 'rgba(36,41,80,0.8)');
  h.fillStyle = sg; h.fill(all); h.restore();
  rimBleed(h, all, LIGHT, 16 * px, PAL.rim, { alpha: 0.26, blur: 5 * px / 0.707 });
  rimPass(h, all, LIGHT, 7.5 * px, PAL.rim, { spread: 24 });
  rimPass(h, all, LIGHT, 2.6 * px, PAL.rimHot, { alpha: 0.9 });
  rimPass(h, all, SKY, 4 * px, PAL.skyRim, { alpha: 0.45 });
  const gl = glowLevel(R.tl);                             // 指尖挨着镜腿：染一点镜片的青光
  if (gl > 0) { const tip = M.ap(m, [0, 10]); const rg = h.createRadialGradient(tip[0], tip[1], 0, tip[0], tip[1], 36 * px);
    rg.addColorStop(0, `rgba(159,232,255,${0.4 * gl})`); rg.addColorStop(1, 'rgba(159,232,255,0)');
    h.save(); h.clip(all); h.fillStyle = rg; h.fillRect(tip[0] - 40 * px, tip[1] - 40 * px, 80 * px, 80 * px); h.restore(); }
  applyTexture(h, 0.3);
  inkPath(h, handC, { size: 2.1, seed: 231, t0: 2, t1: 2 }, R);
  H_LINES.forEach((p, i) => inkPath(h, X(p, m), { size: i >= 3 && i <= 4 ? 1.0 : 1.4, seed: 250 + i, alpha: 0.7, t0: 5, t1: 5 }, R));
  inkPath(h, X(SLEEVE, m), { size: 2.0, seed: 260 }, R);
  inkPath(h, X(CUFF, m), { size: 1.5, seed: 261, alpha: 0.8 }, R);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(L2, 0, 0); g.restore();
}

function debugMarks(g, R) {
  const pts = { lensN: [-58, 498], lensF: [27, 496], cam: CAM_C, touch: TOUCH_AT, pivot: PIV_H, nose: [86, 642], chin: [24, 880], ear: EAR_C };
  g.save(); g.font = '12px sans-serif';
  for (const [k, p] of Object.entries(pts)) { const s = M.ap(R.head, p); g.fillStyle = '#0f0'; g.fillRect(s[0] - 3, s[1] - 3, 6, 6); g.fillText(k, s[0] + 5, s[1] - 5); }
  g.restore();
}
