// src/girl.js — 镜头 B「她」：林潮逆光侧脸剪影 + AI 眼镜（人物层）
//
// 画在透明 2D canvas 上，tl = 镜头内时间 0–2 秒（对应全局 3.00–5.00）。
//   · 角色动画一拍二：所有姿态（发丝、手、呼吸、抬头）只在 snapTime(tl, 12) 上取值，墨线抖动也按这个步进换形；
//   · 镜片倒影里的鲲一拍三：snapTime(tl, 8)（和镜头 C 里的鲲一致）；
//     drawGirl 只拿到连续的 tl，所以用 engine/core/clock.js 的 snapTime（带 1e-6 防抖，整帧时刻与按帧号量化结果相同）；
//   · 镜头缓推、镜片内缘光、粉色天光的明暗属于「光与镜头」，24 fps 平滑。
// 画法：深蓝紫平涂剪影（2–3 档）+ 偏移法求出的硬边边缘光（粉金，只出现在挨着天空的轮廓上）+ 天顶冷边
//      + 手绘墨线（有粗细、按一拍二抖动）+ 水彩斑驳纹理。通用画法都在 engine/paint/（路径、轮廓光、墨线、
//      发簇、纹理、离屏层），这里只留角色的形状、色板、动作时间线和绘制顺序。
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
//   glowLevel(tl)                      镜片内缘光强度 0–1（给音效、bloom 对齐用）
//   GIRL_SHOT / GIRL_PAL               镜头时间常量（起点、长度取自 src/timeline.js）/ 色板
// 像素换算：w×h 是用户空间（设计尺寸），画布可以更大（原生 4K 时 2 倍，调用方先 setTransform）。
//   路径、线宽跟着变换走；画布滤镜的模糊半径和 shadowBlur 不随变换缩放，都要乘 DPR（= 画布宽 / w）。

import { createNoise2D } from '../engine/core/noise.js';
import { mulberry, clamp, lerp, seg, ss, ei } from '../engine/core/math.js';
import { tick, snapTime } from '../engine/core/clock.js';
import { TIMELINE, DESIGN } from './timeline.js';
import * as M from '../engine/paint/affine.js';
import { parsePath as P, mapPath as X, toPath2D as path2d, scalePath, samplePath, polyPath, smoothClosed } from '../engine/paint/path.js';
import { canvasFor, clearLayer, blit } from '../engine/paint/canvas.js';
import { rimPass, rimBleed, fadeAlong, lightWrap, glowBehind, glassSheen } from '../engine/paint/light.js';
import { createInk } from '../engine/paint/ink.js';
import { washTexture, washOver } from '../engine/paint/wash.js';
import { strandSpine, strandOutline } from '../engine/paint/strand.js';

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
  start: TIMELINE.B,                // 全局起点（镜头 B 开始）
  dur: TIMELINE.C - TIMELINE.B,     // 镜头长度（到镜头 C 开始；设计稿 2 秒，下面的动作时间按它写）
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
const q12 = t => snapTime(t, 12);   // 一拍二
const q8 = t => snapTime(t, 8);     // 一拍三

// 噪声：每个用途一个独立的固定种子
const nHair = createNoise2D(mulberry(31013));
const nInk = createNoise2D(mulberry(52511));
const nTex = createNoise2D(mulberry(70117));
const nPap = createNoise2D(mulberry(80021));

let DPR = 1;   // drawGirl 每次调用时更新：画布像素 / 用户空间像素

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
const EAR = scalePath(P(`
M -505 548
C -512 500 -514 452 -530 418
C -545 390 -575 380 -603 390
C -642 404 -662 448 -656 500
C -650 556 -626 590 -610 626
C -598 655 -582 680 -558 676
C -536 672 -522 650 -516 622
C -512 600 -506 576 -505 548 Z`), ...EAR_C, ES);
const EAR_CONCHA = scalePath(P(`M -532 470 C -562 455 -598 470 -606 510 C -612 548 -598 580 -578 598 C -560 612 -538 600 -532 575 C -526 548 -522 500 -532 470 Z`), ...EAR_C, ES);
// 耳轮外沿一圈（盖住镜腿末端：镜腿从耳轮下面穿到耳后）
const EAR_HELIX = scalePath(P(`M -528 422 C -545 390 -575 380 -603 390 C -642 404 -662 448 -656 500 C -652 540 -642 568 -628 596 L -606 586 C -622 556 -632 528 -634 498 C -638 456 -622 422 -598 413 C -578 406 -558 412 -544 432 Z`), ...EAR_C, ES);
const INK_EAR = [
  scalePath(P(`M -506 560 C -512 500 -514 452 -530 418 C -545 390 -575 380 -603 390 C -642 404 -662 448 -656 500 C -650 556 -626 590 -610 626 C -598 655 -582 680 -558 676 C -536 672 -522 650 -516 622`), ...EAR_C, ES),
  scalePath(P(`M -548 446 C -585 438 -620 466 -622 512 C -624 548 -608 574 -592 590`), ...EAR_C, ES),
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
// 摆动场（engine/paint/strand.js）：发簇粗、摆得慢、带梢部回勾；迎光细丝更轻、被风拉得更长
const CLUMP_SWAY = { n: 20, stretch: 0.06, wave: [7.1, 1.2, 1.6], drift: [3.3, 0.35, 0], sway: 0.5 };
const GLINT_SWAY = { n: 14, stretch: 0.1, wave: [5.3, 1.5, 1.8], drift: [2.1, 0, 40], sway: 0.6 };

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
  const C = M.zoomAt(cam.fx * w, cam.fy * h, cam.zoom);
  const breath = Math.sin(tq / 3.3 * Math.PI * 2 + 0.6) * 4;      // mH
  const lookUp = ss(seg(tq, 1.0, 1.85));                           // 暗影划过时再微微抬头
  const tilt = (TILT0 - 2.4 * lookUp + 0.4 * Math.sin(tq * 2.1)) * D2R;
  const pv = [PIV_S[0] * w, PIV_S[1] * h];
  const body = M.chain(C, M.translate(pv[0], pv[1]), M.scale(k), M.translate(-PIV_H[0], -PIV_H[1] + breath));
  const head = M.chain(C, M.translate(pv[0], pv[1]), M.scale(k), M.rotate(tilt), M.translate(-PIV_H[0], -PIV_H[1] + breath * 0.8));
  const px = k * cam.zoom;                                         // 1 mH 在画面里的像素数
  // 手：0.12 从画面下方抬起 → 0.42 悬停 → 0.50 指腹贴上镜腿（一拍二的这一拍覆盖全局 3.50–3.58，含 3.55）
  //     → 0.55 镜片内缘光亮起 → 0.95 起放下 → 1.42 出画
  const rise = ss(seg(tq, 0.12, 0.42)), reach = ss(seg(tq, 0.42, 0.5)), down = ei(seg(tq, 0.95, 1.42));
  const press = tq >= 0.5 && tq < 0.67 ? 1 : 0;                   // 触碰时指尖轻压一下：一拍二的 0.50、0.58、0.67 三拍（全局 3.50–3.71，成片如此）
  const dy = lerp(920, 40, rise) - 40 * reach - 4 * press + 940 * down;
  const hand = {
    on: tq > 0.13 && tq < 1.42,
    m: M.chain(head, M.translate(TOUCH_AT[0] + 50 * (1 - rise) - 40 * down, TOUCH_AT[1] + dy),
      M.rotate((5 + 12 * (1 - rise) - 8 * down) * D2R)),
  };
  return { tq, tl, k, px, cam, C, body, head, hand, tilt, w, h };
}

// ───────────────────────── 绘制零件 ─────────────────────────
// 竖向渐隐遮罩：在 m 坐标系里从 y0（全亮）到 y1（全隐）
const fadeMask = (m, y0, y1) => fadeAlong(m, [0, y0], [0, y1]);

// 手绘墨线（engine/paint/ink.js）：线宽以 1040 高的画面为准，随镜头推进变粗；每一拍二换一次抖动形状
const brush = createInk(nInk);
const inkOpts = (o, R) => ({ color: PAL.ink, ...o, step: tick(R.tq, 12), px: v => v * R.h / 1040 * R.cam.zoom });
const ink = (g, poly, o, R) => brush.line(g, poly, inkOpts(o, R));
const inkPath = (g, cmds, o, R) => brush.path(g, cmds, inkOpts(o, R));

// 发簇：中心线带沿发丝传播的飘动波和发梢回勾，宽度从根部收成尖
const clumpPoly = (s, tq, wind) => strandOutline(strandSpine(s, tq, wind, nHair, CLUMP_SWAY), s);
const glintLine = (s, tq, wind) => strandSpine(s, tq, wind, nHair, GLINT_SWAY);
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
// 水彩斑驳纹理（engine/paint/wash.js，一次生成）：亮处偏冷紫、暗处深蓝
let TEX = null;
const texture = () => TEX ??= washTexture({ blotch: nTex, grain: nPap, light: [104, 110, 170], dark: [20, 22, 52] });
const applyTexture = (g, alpha, clip) => washOver(g, texture(), alpha, clip);

// ───────────────────────── 主函数 ─────────────────────────
// drawGirl(ctx, tl, w, h, opts)
//   ctx  目标 2D 上下文（透明画布，用户空间尺寸 w×h；已有的变换会被沿用）
//   tl   镜头内时间 0–2 秒（全局 3.00–5.00）
//   opts.cam     镜头：默认 girlCamera(tl) 缓推；传 false 关掉；也可传 {zoom, fx, fy}
//   opts.glow    false 时不画镜片内缘光
//   opts.reflect false 时不画镜片倒影
//   opts.debug   true 时标出锚点
export function drawGirl(ctx, tl, w, h, opts = {}) {
  DPR = ctx.canvas.width / w;   // 画布比 w 大时（原生 4K），滤镜模糊半径和 shadowBlur 都要乘它（两者都不随变换缩放）
  const R = rig(tl, w, h, opts);
  const { head, body, hand, tq, px } = R;
  const T0 = ctx.getTransform();
  const L1 = canvasFor('girl.L1', ctx.canvas.width, ctx.canvas.height), g = L1.getContext('2d');
  clearLayer(g, T0);

  const wind = 0.45 + 0.75 * ss(seg(tq, 0.8, 1.15)) * (1 - 0.5 * ss(seg(tq, 1.6, 2.0)));   // 暗影掠过时起一阵风
  const rimD = 8 * px, hot = 2.6 * px, bleedBlur = 6 * px / 0.707;

  // ── 1. 皮肤：头 + 脖子 ──
  const headC = X(HEAD, head);
  const throat = M.apply(head, [-222, 976]), nape = M.apply(head, [-655, 880]);
  const cf = M.apply(body, [-236, 1192]), cb = M.apply(body, [-700, 1080]);
  const c1 = M.apply(head, [-224, 1046]), c2 = M.apply(body, [-232, 1140]);
  const neckC = [['M', ...throat], ['C', ...c1, ...c2, ...cf], ['L', ...M.apply(body, [-240, 1500])], ['L', ...M.apply(body, [-700, 1500])], ['L', ...cb], ['L', ...nape], ['Z']];
  const skin = path2d(headC); path2d(neckC, skin);
  g.fillStyle = PAL.skin; g.fill(skin);
  g.save(); g.clip(skin);
  g.fillStyle = PAL.skinDeep; g.fill(path2d(X(JAW_SHADE, head)));
  g.globalAlpha = 0.55; g.fillStyle = PAL.skinDeep; g.fill(path2d(X(EYE_SHADE, head)));
  g.globalAlpha = 1; g.restore();
  const neckFade = fadeMask(body, 1060, 1230);
  rimBleed(g, skin, LIGHT, rimD * 2.6, PAL.rim, { alpha: 0.3, blur: bleedBlur * DPR, mask: neckFade });
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
  const clumps = CLUMPS.map(s => clumpPoly(s, tq, wind).map(p => M.apply(head, p)));
  clumps.forEach(cp => smoothClosed(cp, hair));
  g.fillStyle = PAL.hair; g.fill(hair);
  g.save(); g.clip(hair);
  HAIR_FLOW.forEach((f, i) => inkPath(g, X(f, head, hdef), { size: 2.0, color: PAL.hairLift, alpha: 0.7, seed: 70 + i, t0: 10, t1: 14 }, R));
  g.restore();
  const hairFront = fadeAlong(head, [-260, 0], [-520, 0]);
  rimBleed(g, hair, LIGHT, rimD * 2, PAL.rim, { alpha: 0.22, blur: bleedBlur * 0.8 * DPR, occ: skin, mask: hairFront });
  rimPass(g, hair, SKY, 6 * px, PAL.skyRim, { alpha: 0.75, occ: skin });
  rimPass(g, hair, LIGHT, rimD * 0.9, PAL.rim, { spread: 22, occ: skin, mask: hairFront });
  rimPass(g, hair, LIGHT, hot * 0.9, PAL.rimHot, { alpha: 0.85, occ: skin, mask: hairFront });
  // 发簇轮廓墨线：底块只描露在外面的前额发际，发簇各自描边
  clumps.forEach((cp, i) => ink(g, samplePath(polyPath(cp), 2.5)[0], { size: CLUMPS[i].thin ? 1.2 : 2.1, seed: 90 + i, t0: 6, t1: 6 }, R));
  // 迎光细发丝：暖金色，带一点辉光
  g.save(); g.shadowColor = PAL.rim; g.shadowBlur = 5 * px * DPR;
  GLINTS.forEach((s, i) => {
    const pl = glintLine(s, tq, wind).map(p => M.apply(head, hdef(p[0], p[1])));
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
  { const c = M.apply(head, IRIS), r = 13 * px;
    g.fillStyle = '#161A3A'; g.beginPath(); g.ellipse(c[0], c[1], r * 0.55, r, R.tilt, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#FFE9F2'; g.globalAlpha = 0.85; g.beginPath(); g.arc(c[0] + 1.5 * px, c[1] - 4 * px, 2.2 * px, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }

  // ── 6. 天顶环境光（上亮下暗）+ 斑驳纹理（只作用于以上人物部分）──
  { const a0 = M.apply(head, [0, -60]), a1 = M.apply(body, [0, 1300]);
    const ag = g.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
    ag.addColorStop(0, 'rgba(120,128,206,0.20)'); ag.addColorStop(0.45, 'rgba(120,128,206,0)'); ag.addColorStop(0.75, 'rgba(14,16,44,0)'); ag.addColorStop(1, 'rgba(14,16,44,0.32)');
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop'; g.fillStyle = ag;
    g.setTransform(T0); g.fillRect(-w, -h, 3 * w, 3 * h); g.restore(); }
  applyTexture(g, 0.32);

  // ── 7. 远侧镜框（在脸后面：先画到 L0，再用 destination-over 垫到底下）──
  const nearLensC = X(NEAR_LENS, head), nearLens = path2d(nearLensC);
  const farLens = path2d(X(FAR_LENS, head));
  {
    const L0 = canvasFor('girl.L0', L1.width, L1.height), f = L0.getContext('2d');
    clearLayer(f, T0);
    inkPath(f, X(FAR_LASH, head), { size: 2.2, seed: 119, t0: 1, t1: 3, color: '#1A1E40' }, R);
    FAR_LASHES.forEach((l, i) => inkPath(f, X(l, head), { size: 1.4, seed: 120 + i, t0: 1, t1: 4, color: '#1A1E40' }, R));
    if (opts.reflect !== false) lensReflection(f, farLens, R, 1);
    const fr = path2d(X(FAR_FRAME, head)); path2d(X(FAR_LENS, head), fr);
    f.fillStyle = PAL.frame; f.fill(fr, 'evenodd');
    rimPass(f, fr, LIGHT, 3.6 * px, '#FFE4CF', { alpha: 0.95 });
    rimPass(f, fr, SKY, 2.6 * px, '#CFC7F2', { alpha: 0.7 });
    if (opts.glow !== false) lensGlowLine(f, farLens, R, 0.5);
    inkPath(f, X(FAR_FRAME, head), { size: 1.8, seed: 121, t0: 2, t1: 2 }, R);
    blit(g, L0, 'destination-over');
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
  { const c = M.apply(head, CAM_C), r = 7 * px;
    g.fillStyle = '#0C0E26'; g.beginPath(); g.ellipse(c[0], c[1], r * 0.5, r, R.tilt, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#555B8E'; g.lineWidth = Math.max(1, 1.1 * px); g.stroke();
    g.fillStyle = '#F7DCEA'; g.globalAlpha = 0.9; g.beginPath(); g.arc(c[0] + 0.8 * px, c[1] - 2.2 * px, 1.5 * px, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
  if (opts.glow !== false) lensGlowLine(g, nearLens, R, 1);

  // ── 9. 手（最近，单独一层：有自己的纹理）──
  if (hand.on) drawHand(g, R, T0);

  // 光包裹：外沿一圈渗进天空色；画面底边被裁的衣服处不做
  const wrap = opts.wrap ?? 0.42;
  if (wrap > 0) lightWrap(g, L1, { amount: wrap, radius: 9 * R.px / 0.707 * (L1.width / (R.w || L1.width)),
    stops: opts.wrapStops || [[0, '#B9A9EC'], [0.55, '#F4B0B6'], [1, '#FFC490']], foot: 90 * L1.height / 1040 });

  // ── 10. 逆光辉光（halo）：迎光边的光带模糊后垫到人物底下，只在剪影外的天空里看得到 ──
  //        合成代理若自己做 bloom，可以传 opts.halo 调小（0 关掉）
  const halo = opts.halo ?? 0.5;
  if (halo > 0) {
    const Hc = canvasFor('girl.halo', L1.width, L1.height), hq = Hc.getContext('2d');
    clearLayer(hq, T0);
    rimPass(hq, skin, LIGHT, rimD * 1.6, PAL.rim, { spread: 24, mask: neckFade });
    rimPass(hq, hair, LIGHT, rimD * 1.4, PAL.rim, { spread: 22, occ: skin, mask: hairFront });
    glowBehind(g, Hc, [[halo, 12 * px / 0.707 * DPR], [halo * 0.55, 34 * px / 0.707 * DPR]]);
  }
  if (opts.debug) debugMarks(g, R);
  blit(ctx, L1);
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
    // 漂移相位按设计稿的全局秒（镜头 B 从 DESIGN.B = 3.0 起）：镜头起点改了，光尘跟着镜头整体平移
    let x = ((m.x - (m.vx * m.d) * (tl + DESIGN.B) * 1.6) % 1.1 + 1.1) % 1.1 - 0.05, y = m.y + m.vy * tl + 0.006 * Math.sin(tl * 2.1 + m.ph);
    x = cam.fx + (x - cam.fx) * z; y = cam.fy + (y - cam.fy) * z;
    const tw = 0.55 + 0.45 * Math.sin(tl * 3.3 + m.ph * 3);
    const r = m.s * h / 1040 * (0.7 + 0.5 * m.d);
    const gr = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * 3.2);
    gr.addColorStop(0, `rgba(255,244,232,${0.85 * tw})`); gr.addColorStop(0.35, `rgba(255,214,186,${0.35 * tw})`); gr.addColorStop(1, 'rgba(255,214,186,0)');
    ctx.fillStyle = gr; ctx.fillRect(x * w - r * 3.2, y * h - r * 3.2, r * 6.4, r * 6.4);
  }
  ctx.restore();
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
  g.shadowColor = PAL.glow; g.shadowBlur = 16 * px * DPR; g.strokeStyle = PAL.glow; g.lineWidth = 6 * px; g.stroke(lens);   // shadowBlur 是画布像素
  g.shadowBlur = 5 * px * DPR; g.strokeStyle = '#E9FCFF'; g.lineWidth = 2.6 * px; g.stroke(lens);
  g.restore();
}

// 镜片倒影：天光渐变（0.8 后转成粉色天光）+ 鲲的暗影从右向左（一拍三）+ 表面高光
function lensReflection(g, lens, R, far) {
  const tl = R.tl, px = R.px, head = R.head;
  const pink = ss(seg(tl, 0.8, 1.15));
  const base = lerp(0.24, 0.74, pink);
  const top = M.apply(head, [0, 405]), bot = M.apply(head, [0, 595]);
  g.save(); g.clip(lens);
  const gr = g.createLinearGradient(top[0], top[1], bot[0], bot[1]);
  gr.addColorStop(0, '#9C8FD8'); gr.addColorStop(0.42, '#F2A0A6'); gr.addColorStop(0.78, '#FFB26B'); gr.addColorStop(1, '#FFD9B8');
  g.globalAlpha = base; g.fillStyle = gr; g.fill(lens);
  // 鲲的暗影：一拍三。0.80 鼻尖进入远侧镜片 → 2.0 尾鳍正扫过近侧镜片
  const kt = q8(tl), s = 0.3;
  if (kt >= 0.8) {
    const u = clamp((kt - 0.8) / 1.2);
    const cx = lerp(43 + 500 * s, -55 - 600 * s, u);
    const km = M.chain(head, M.translate(cx, 492 - 10 * u), M.rotate(-0.05 + 0.04 * u), M.scale(s));
    g.globalAlpha = 0.92 * (0.6 + 0.4 * pink);
    g.filter = `blur(${Math.max(0.6, 1.0 * px) * DPR}px)`;
    g.fillStyle = PAL.kun; g.fill(path2d(X(KUN, km)));
    g.filter = 'none';
  }
  // 表面：边缘菲涅尔提亮 + 上角一小道锐利高光
  glassSheen(g, lens, M.apply(head, far ? [20, 430] : [-88, 426]), M.apply(head, far ? [40, 520] : [-30, 540]), {
    edge: 0.18 + 0.2 * pink, edgeColor: '#FFE9F0', width: 6 * px, blur: 2.5 * px * DPR, streak: 0.55 + 0.45 * pink, tint: [255, 246, 250] });
  g.restore();
}

function drawHand(g, R, T0) {
  const m = R.hand.m, px = R.px;
  const L2 = canvasFor('girl.L2', g.canvas.width, g.canvas.height), h = L2.getContext('2d');
  clearLayer(h, T0);
  // 袖口（深蓝工作服）
  const sleeve = path2d(X(SLEEVE, m));
  h.fillStyle = PAL.cloth; h.fill(sleeve);
  rimPass(h, sleeve, LIGHT, 7 * px, '#E9B69C', { alpha: 0.8 });
  const handC = X(H_HAND, m), all = path2d(handC);
  h.fillStyle = PAL.hand; h.fill(all);
  h.save(); h.clip(all);                                  // 手背下半渐入暗部
  const a = M.apply(m, [0, 400]), b = M.apply(m, [0, 700]);
  const sg = h.createLinearGradient(a[0], a[1], b[0], b[1]); sg.addColorStop(0, 'rgba(36,41,80,0)'); sg.addColorStop(1, 'rgba(36,41,80,0.8)');
  h.fillStyle = sg; h.fill(all); h.restore();
  rimBleed(h, all, LIGHT, 16 * px, PAL.rim, { alpha: 0.26, blur: 5 * px / 0.707 * DPR });
  rimPass(h, all, LIGHT, 7.5 * px, PAL.rim, { spread: 24 });
  rimPass(h, all, LIGHT, 2.6 * px, PAL.rimHot, { alpha: 0.9 });
  rimPass(h, all, SKY, 4 * px, PAL.skyRim, { alpha: 0.45 });
  const gl = glowLevel(R.tl);                             // 指尖挨着镜腿：染一点镜片的青光
  if (gl > 0) { const tip = M.apply(m, [0, 10]); const rg = h.createRadialGradient(tip[0], tip[1], 0, tip[0], tip[1], 36 * px);
    rg.addColorStop(0, `rgba(159,232,255,${0.4 * gl})`); rg.addColorStop(1, 'rgba(159,232,255,0)');
    h.save(); h.clip(all); h.fillStyle = rg; h.fillRect(tip[0] - 40 * px, tip[1] - 40 * px, 80 * px, 80 * px); h.restore(); }
  applyTexture(h, 0.3);
  inkPath(h, handC, { size: 2.1, seed: 231, t0: 2, t1: 2 }, R);
  H_LINES.forEach((p, i) => inkPath(h, X(p, m), { size: i >= 3 && i <= 4 ? 1.0 : 1.4, seed: 250 + i, alpha: 0.7, t0: 5, t1: 5 }, R));
  inkPath(h, X(SLEEVE, m), { size: 2.0, seed: 260 }, R);
  inkPath(h, X(CUFF, m), { size: 1.5, seed: 261, alpha: 0.8 }, R);
  blit(g, L2);
}

function debugMarks(g, R) {
  const pts = { lensN: [-58, 498], lensF: [27, 496], cam: CAM_C, touch: TOUCH_AT, pivot: PIV_H, nose: [86, 642], chin: [24, 880], ear: EAR_C };
  g.save(); g.font = '12px sans-serif';
  for (const [k, p] of Object.entries(pts)) { const s = M.apply(R.head, p); g.fillStyle = '#0f0'; g.fillRect(s[0] - 3, s[1] - 3, 6, 6); g.fillText(k, s[0] + 5, s[1] - 5); }
  g.restore();
}
