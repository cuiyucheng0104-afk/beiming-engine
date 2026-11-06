// 《豹变》A 水墨 · 修复室：S1（主观俯拍一镜）、T1 前半（六爻浮起、俯冲）、S6（过肩一镜）共用一张桌、一本 3D 书
//   3D：书桌平面（两三层淡赭 / 淡墨洗染 + 枯笔木纹 + 砚台墨块）、两叠书页、两张弯曲页面（共用一张 2600×1720 的页面画布）、八根爻条（T1 浮起，薄片）
//   2D：陆蔚右手 A06-S1a–d（S1）、后脑肩臂 A11 与双手 A06-5（S6，钉在世界里）；镊子、眼镜、卦画、「革」、木刻、补纸都画在画布上
import * as THREE from 'three';
import {
  U, K, DW, DH, DEG, clamp, lerp, seg, ss, ss5, eo, ei, hashi, hash2, mulberry, monotone, PAL, COL,
  placeOnScreen, screenToWorld, project, lookAt, frameAt, fpx, vnoise1, fbm1, fbm2, css, mix3, inPoly,
} from '../lib/core.js';
import { NOISE, PALETTE } from '../lib/glsl.js';
import { canvasPlane } from '../lib/inkwash.js';
import { sprite, setHandle, clearHandles, setBreath, setSpots } from '../lib/sprite.js';
import { drawTweezers, drawGlasses, stroke, wobbleLine, freshClear, wetBlob, blobPath } from '../lib/draw2d.js';
import { drawRosette } from '../lib/rosette2d.js';
import { placeImg } from './cliff.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const PW = 0.218, PH = 0.288;
const CW = 2600, CH = 1720, PXM = CW / (2 * PW);
export const pageY = xn => 0.010 + 0.008 * (1 - Math.exp(-xn / 0.18)) - 0.002 * xn * xn;
const toCanvas = (x, z) => [(x + PW) * PXM, (z + PH / 2) * (CH / PH)];
export const HEX = { cx: -0.105, cz: -0.035, step: 0.0143, len: 0.083, thick: 0.0072, half: 0.034, gap: 0.015, yin: [false, true, false, false, false, true] };
export const yaoZ = k => HEX.cz + (2.5 - k) * HEX.step;
const WOOD = { cx: 0.104, cz: -0.018, w: 0.166 };
export const SUB = { x: [1716, 1606], y: 236, size: 80, step: 90 };     // 字幕：右列「君子豹变」、左列「其文蔚也」（S6 机位下的设计像素）

// ───────── 页面、桌面材质：画布贴图；书页受光两档（纸 / 清）+ 交界一道水渍边 ─────────
const PAGE_VS = /* glsl */`varying vec2 vUv; varying vec3 vW; varying float vXn; attribute float aXn;
void main(){ vUv = uv; vXn = aXn; vec4 wp = modelMatrix * vec4(position, 1.); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const PAGE_FS = /* glsl */`
${NOISE}
${PALETTE}
uniform sampler2D map; uniform float uLod, uGut, uWarmL;
varying vec2 vUv; varying vec3 vW; varying float vXn;
// 一道洗染的边：v 是"进洗染的深度"（任意单位），返回 (覆盖, 水渍边)；边约 1 个屏幕像素软，水渍边往里 rimPx 设计像素褪掉
vec2 washE(float v, float rimPx){
  float dpx = v / max(fwidth(v), 1e-6), sp = 1. + 4.5 * uLod;          // uLod > 0（S1 戴眼镜前近视发虚）时边跟着画布贴图一起发软
  float m = smoothstep(-sp, sp, dpx);
  return vec2(m, m * exp(-max(dpx, 0.) / (rimPx * uK + 2. * uLod * uK)));
}
void main(){
  vec3 c = texture(map, vUv, uLod).rgb;
  if (uGut > 0.) {
    // 返修 w3（v3-02 ②）：书沟原来是一道平滑的喷枪渐变。改成两阶洗染：外一阶"清"、贴书脊一阶"淡"，
    //   边沿顺着书脊方向不规则起伏，各带一道 2–3K 的水渍深边，里面有颗粒（同书中世界一套笔墨）
    float z = vW.z;
    float x = vXn + .016 * (vn2(vec2(z * 48., 1.), 21u) - .5) + .007 * (vn2(vec2(z * 210., 2.), 22u) - .5);
    vec2 g1 = washE(.135 - x + .010 * (vn2(vec2(z * 23., 5.), 24u) - .5), 2.6);
    vec2 g2 = washE(.052 - x + .006 * (vn2(vec2(z * 31., 7.), 25u) - .5), 2.2);
    float gr = 1. + (.16 * vn2(gl_FragCoord.xy / uK / 1.5, 26u) - .08) * (1. - .7 * clamp(uLod, 0., 1.));
    c *= 1. - uGut * gr * (.042 * g1.x + .046 * g2.x + .030 * g1.y + .036 * g2.y);
  }
  gl_FragColor = vec4(c, 1.);
}`;
function pageMat(tex, o = {}) {
  return new THREE.ShaderMaterial({ uniforms: { uPal: U.uPal, uK: U.uK, uT: U.uT, map: { value: tex }, uLod: { value: 0 }, uGut: { value: o.gut ?? 1 }, uWarmL: { value: o.warm ?? 0.03 } },
    vertexShader: PAGE_VS, fragmentShader: PAGE_FS, side: THREE.DoubleSide });
}
// 返修 w3（v3-02）：桌面改成按桌面坐标（米）逐像素算的水墨（原来是放大后发虚的画布贴图 + 模糊滤镜，读成喷枪渐变、平涂数码插画）：
//   ① 砚台（S1 左上压一角的重墨）：焦墨圆角块（外沿约 6K 的洇边、一两处枯笔透空）+ 湿的重墨砚堂（自带水渍深边）+ 一小汪焦墨墨池 + 一道留白月牙，
//      往左下落一层两阶淡墨影（带水渍边），不再有一圈灰晕；
//   ② 书下的淡墨影、桌面几层淡赭 / 淡墨大洗染：都是有清楚水渍边的块（顺木纹方向拉长），不是模糊的渐变；
//   ③ 桌面远处的暗部（S6 画面顶上、往右上加重）一块两阶淡墨洗染；字幕底下那块桌面留纸；
//   ④ 细枯笔木纹（顺 x 方向的断续细丝）；画布贴图只留原来的枯笔木纹
const DESK_FS = /* glsl */`
${NOISE}
${PALETTE}
uniform sampler2D map; uniform float uLod;
uniform vec4 uStone;   // 砚台中心 x z、半长、半宽（米）
uniform vec4 uStoneB;  // 砚台转角（弧度）
uniform vec4 uBook;    // 书下淡墨影的外框：x0 z0 x1 z1（米）
uniform vec4 uSubB;    // 字幕底下留纸的桌面框：x0 z0 x1 z1
uniform vec4 uFarW;    // 桌面远处暗部：起 z、过渡（米）、量、往右加重的起点 x
uniform vec3 uOchre;
varying vec2 vUv; varying vec3 vW; varying float vXn;
vec2 washE(float v, float rimPx){
  float dpx = v / max(fwidth(v), 1e-6), sp = 1. + 4.5 * uLod;          // uLod > 0（S1 戴眼镜前近视发虚）时边跟着画布贴图一起发软
  float m = smoothstep(-sp, sp, dpx);
  return vec2(m, m * exp(-max(dpx, 0.) / (rimPx * uK + 2. * uLod * uK)));
}
vec3 tintBy(vec3 c, vec3 col, float a){ return c * mix(vec3(1.), col / max(uPal[0], vec3(.01)), clamp(a, 0., 1.)); }
void main(){
  vec3 c = texture(map, vUv, uLod).rgb;
  vec2 P = vW.xz;
  vec2 q = gl_FragCoord.xy / uK;
  float gr = 1. + (.20 * vn2(q / 1.5, 61u) - .10) * (1. - .7 * clamp(uLod, 0., 1.));   // 颜料颗粒（屏幕原生分辨率；近视发虚时淡掉）
  // 字幕底下那块桌面：洗染往外让开（边是软的、不规则的，不是一个方框）
  vec2 sc = (uSubB.xy + uSubB.zw) * .5, sh = (uSubB.zw - uSubB.xy) * .5;
  vec2 sdd = abs(P - sc) - sh;
  float sbd = length(max(sdd, 0.)) + min(max(sdd.x, sdd.y), 0.) + .03 * fbm2(P * 9., 60u);
  float inSub = 1. - smoothstep(-.02, .05, sbd);
  float subK = 1. - .80 * inSub;
  // 桌面大洗染：几块大的淡赭、一层淡墨（略顺木纹方向），边上清楚的水渍深边；形状按域扭曲，不出长直边
  {
    vec2 pw = P + .16 * vec2(fbm2(P * 1.3 + 2.2, 62u), fbm2(P * 1.3 + 7.9, 63u));
    vec2 w1 = washE(fbm2(pw * vec2(1.15, 1.9) + vec2(3.7, 1.1), 64u) - .10, 3.4);
    c = tintBy(c, uOchre, subK * (.20 * w1.x + .18 * w1.y) * gr);
    vec2 w2 = washE(fbm2(pw * vec2(1.9, 2.9) + vec2(9.3, 2.2), 65u) - .26, 2.8);
    c = tintBy(c, uOchre, subK * (.15 * w2.x + .15 * w2.y) * gr);
    vec2 w3 = washE(fbm2(pw * vec2(1.6, 2.6) + vec2(-5.1, 7.7), 66u) - .32, 2.6);
    c = tintBy(c, uPal[2], subK * (.10 * w3.x + .13 * w3.y) * gr);
  }
  // 细枯笔木纹：顺 x 的断续细丝，只在几处成片
  {
    float st = vn2(vec2(P.x * 7. + 3.1 * fbm2(P * vec2(.8, 6.), 67u), P.y * 190.), 68u);
    float br = smoothstep(.55, .80, vn2(vec2(P.x * 3.2, P.y * 14.), 69u));
    c = tintBy(c, uPal[3], subK * .055 * smoothstep(.78, .90, st) * br * gr);
  }
  // 书下一层两阶淡墨影（往左、往近处偏一点：窗在右上），带水渍边
  {
    vec2 cc = (uBook.xy + uBook.zw) * .5, hh = (uBook.zw - uBook.xy) * .5;
    vec2 d = abs(P - cc) - hh;
    float sd = length(max(d, 0.)) + min(max(d.x, d.y), 0.);
    sd += .004 * (vn2(P * 140., 71u) - .5) + .0025 * (vn2(P * 520., 72u) - .5);
    vec2 s1 = washE(-sd, 2.4), s2 = washE(-(sd + .010), 2.0);
    c = tintBy(c, uPal[2], (.26 * s1.x + .22 * s1.y + .14 * s2.x + .16 * s2.y) * gr);
  }
  // 桌面远处的暗部：两阶淡墨洗染，往右上加重；边沿不规则、带水渍边、有一两处枯笔透空
  if (uFarW.z > 0.) {
    float v = (uFarW.x - P.y) / uFarW.y + .70 * fbm2(vec2(P.x * 2.0, P.y * 3.4), 73u) + .22 * fbm2(P * 11., 74u);
    float rk = smoothstep(uFarW.w, uFarW.w + .55, P.x);
    vec2 f1 = washE(v, 3.0), f2 = washE(v - .9 - .5 * fbm2(P * vec2(3., 7.), 75u), 2.6);
    float dry = smoothstep(.66, .86, vn2(vec2(P.x * 5., P.y * 40.), 76u)) * smoothstep(.4, .7, vn2(P * 4., 77u)) * .55;
    c = tintBy(c, uPal[2], uFarW.z * subK * (.45 + .55 * rk) * ((.44 * f1.x + .26 * f1.y) * (1. - dry) + .30 * f2.x * rk + .20 * f2.y * rk) * gr);
  }
  // 砚台
  {
    vec2 so = P - uStone.xy; float ca = cos(uStoneB.x), sa = sin(uStoneB.x);
    vec2 sl = vec2(ca * so.x + sa * so.y, -sa * so.x + ca * so.y) / uStone.zw;
    {                                                                          // 影：往左下（−x、+z）落一层，两阶淡墨、水渍边
      vec2 so2 = so + vec2(.022, -.030);
      vec2 sh = vec2(ca * so2.x + sa * so2.y, -sa * so2.x + ca * so2.y) / (uStone.zw * vec2(1.08, 1.14));
      float r = pow(pow(abs(sh.x), 3.) + pow(abs(sh.y), 3.), 1. / 3.);
      float v = 1. - r + .05 * (vn2(sh * 3., 81u) - .5) + .02 * (vn2(sh * 11., 82u) - .5);
      vec2 a1 = washE(v, 2.4), a2 = washE(v - .16, 2.0);
      c = tintBy(c, uPal[2], (.34 * a1.x + .24 * a1.y + .18 * a2.x) * gr);
    }
    float r = pow(pow(abs(sl.x), 3.2) + pow(abs(sl.y), 3.2), 1. / 3.2);
    float bl = .035 * (vn2(sl * 2.6, 83u) - .5) + .022 * (vn2(P * 300., 84u) - .5) + .012 * (vn2(P * 900., 85u) - .5);   // 外沿洇边：桌面上约 2 mm 的花椰菜细边
    vec2 body = washE(1. - r + bl, 3.0);
    if (body.x > 0.) {
      float Db = .90 + .05 * (vn2(sl * 3.4, 86u) - .5) + .06 * body.y;          // 焦墨块：外沿更深一道
      Db -= .10 * smoothstep(.55, .85, vn2(vec2(sl.x * 2.2, sl.y * 18.), 87u)) * smoothstep(.55, .95, r);   // 外沿一两处枯笔透空
      vec2 pc = (sl - vec2(-.12, .06)) / vec2(.58, .50);                        // 砚堂：块里一片湿的重墨（偏一侧），自带水渍深边，湿墨浓淡不匀
      float rp = pow(pow(abs(pc.x), 2.6) + pow(abs(pc.y), 2.6), 1. / 2.6);
      vec2 pool = washE(1. - rp + .03 * (vn2(pc * 4., 88u) - .5), 2.2);
      float wet = .58 + .16 * fbm2(pc * 2.3 + 1.7, 89u) + .06 * (vn2(pc * 9., 92u) - .5);
      wet -= .10 * smoothstep(.15, .45, fbm2(pc * 1.6 + 5.3, 93u)) * (1. - pool.y);   // 一两处水色化开的淡块（回流）
      float D = mix(Db, wet + .20 * pool.y, pool.x);
      vec2 wc = (sl - vec2(.50, -.06)) / vec2(.20, .26);                        // 墨池：砚堂的一头一小汪焦墨
      vec2 well = washE(1. - length(wc) + .06 * (vn2(wc * 3., 90u) - .5), 1.6);
      D = mix(D, .97, well.x);
      vec2 m0 = (sl - vec2(-.16, .02)) / vec2(.58, .48), m1 = (sl - vec2(-.11, .10)) / vec2(.58, .48);   // 留白月牙：砚堂上沿一道湿面反光，中间断一下
      float cr = (1. - smoothstep(.97, 1.0, length(m0))) * smoothstep(.97, 1.02, length(m1)) * step(m0.y, -.05) * step(-.82, m0.x) * step(m0.x, .55);
      cr *= 1. - .85 * smoothstep(.45, .60, vn2(vec2(m0.x * 5., 1.), 91u));
      D = mix(D, .02, cr * pool.x * .92);
      c = mix(c, rampS(D) * gr * 1.04, body.x);
    }
  }
  gl_FragColor = vec4(c, 1.);
}`;
// 爻条：薄片（没有侧面），焦墨；木刻边缘噪声 + 沿长度的飞白；延展段飞白更多
const BAR_VS = /* glsl */`varying vec2 vUv; varying vec3 vP; uniform float uStretch;
void main(){ vUv = uv; vec3 p = position; p.x *= uStretch; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.); }`;
const BAR_FS = /* glsl */`
${NOISE}
${PALETTE}
uniform float uStretch, uSeed, uOp;
varying vec2 vUv; varying vec3 vP;
// 返修第 2 轮（v1-07）：条边是木刻刀口——大体平直，偶尔崩掉一小块（不是整齐的锯齿）；飞白是沿笔画方向的细长透空丝（枯笔），不是圆点
// 返修第 3 轮（v1-07）：刀口不再是一排细密的小锯齿——长边大体平直、只有很缓的起伏，隔一段崩掉一小块（大小不一），两头是斜着下的刀
// 返修 w3（v3-07 / qa2-08）：原来刀口、飞白都是 alpha 硬阈值（discard，没有抗锯齿：长斜边上一路 1 px 阶梯、外侧一圈点状毛边，俯冲时沿边爬动）。
//   刀口与延展段的飞白：在像素里取 8 个子采样点各判一次"在不在墨里"，覆盖率 = 在墨里的比例（8× 超采样），正常混合；
//   条身上顺笔画的飞白丝本来就是软的，按约 2 个屏幕像素的过渡给覆盖率（见下面 main()）
float barIn(vec2 q){
  float side = q.y < .5 ? 0. : 1.;
  float chip = smoothstep(.83, .97, vn2(vec2(q.x * 15. + uSeed * 7., side * 5. + uSeed), 31u)) * (.35 + .45 * vn2(vec2(q.x * 40., side + uSeed), 36u));
  float e = min(min(q.x, 1. - q.x) * 8. + (q.y - .5) * .10 * (hS(uSeed, 3.) - .5), min(q.y, 1. - q.y) * 2.2);
  float nz = (vn2(vec2(q.x * 11., side * 3. + uSeed * 13.), 32u) - .5) * .08 + (vn2(vec2(q.x * 46., side * 5. + uSeed), 37u) - .5) * .025;
  if (e + nz - chip < .05) return 0.;
  float ext = smoothstep(.5 / uStretch, .5 / uStretch + .03, abs(q.x - .5));
  float fw = fbm2(vec2(q.x * 40., q.y * 3.) + uSeed * 7., 33u);
  if (ext > 0. && fw > .15 - .55 * (1. - ext)) return 0.;
  return 1.;
}
float barCov(vec2 q, vec2 dx, vec2 dy, float fine){
  float A = 0.;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    vec2 o = vec2(fract(fi * .618034 + .19) - .5, (fi + .5) / 8. - .5);   // 每行一个、横向错开的 8 点（旋转网格）
    A += barIn(q + o.x * dx + o.y * dy);
  }
  A /= 8.;
  // 飞白（顺笔画的细长透空丝）是软的：按约 2 个屏幕像素的过渡给覆盖率（比一个像素还细的丝只淡一点，不再碎成一串亮点）
  float dry = vn2(vec2(q.x * 2.4 + uSeed, q.y * 9.), 34u) * .70 + vn2(vec2(q.x * 6. + uSeed * 3., q.y * 17.), 35u) * .30;
  float dthr = .84 - .34 * smoothstep(.28, .5, abs(q.x - .5)) + (1. - fine) * 2.;
  float dw = 1.2 * fwidth(dry) + 1e-4;
  return A * (1. - smoothstep(dthr - dw, dthr + dw, dry));
}
void main(){
  vec2 q = vUv;
  float fine = 1. - smoothstep(.25, .55, fwidth(q.y) * 17.);              // 远看（丝比两个像素还细）时不透空，免得糊成灰条
  vec2 dx = dFdx(q), dy = dFdy(q);
  // 原来是压扁的盒子，上下两面（v 镜像）叠在一起，墨是两张图样的并集：单面以后照样取两张图样的并集，书页上的爻条读起来和原来一样实
  float A1 = barCov(q, dx, dy, fine), A2 = barCov(vec2(q.x, 1. - q.y), vec2(dx.x, -dx.y), vec2(dy.x, -dy.y), fine);
  float A = 1. - (1. - A1) * (1. - A2);
  if (A < .01) discard;
  float side = q.y < .5 ? 0. : 1.;
  float nz = (vn2(vec2(q.x * 11., side * 3. + uSeed * 13.), 32u) - .5) * .08;
  gl_FragColor = vec4(mix(uPal[5], uPal[4], .18 * nz), uOp * A);
}`;

export function buildRoom(ctx) {
  const { tex, man } = ctx;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.002, 50);
  const C1 = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.002, 50);
  lookAt(C1, V3(0.035, 0.40, 0.255), V3(0.02, 0, -0.005));
  const W = PAL.real;
  const rayToY = (c, sx, sy, y) => { const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2((sx / DW) * 2 - 1, -(sy / DH) * 2 + 1), c); const t = (y - r.ray.origin.y) / r.ray.direction.y; return r.ray.origin.clone().addScaledVector(r.ray.direction, t); };

  // ───────── S6 机位（先定下来：桌面画布要在字幕底下留一块干净的纸） ─────────
  const cam6 = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.01, 50);
  const PAGE_R = V3(0.112, 0.016, 0.004);
  const RH_W = V3(0.118, 0.03, 0.035);                  // 右手大致的世界位置（S6 推近的目标）

  // ───────── 桌面：画布只画枯笔木纹；洗染、书下淡墨影、砚台、远处暗部由 DESK_FS 逐像素画（返修 w3） ─────────
  const DESK = { w: 1.6, z0: -1.2, z1: 0.5, cw: 2048 };
  DESK.d = DESK.z1 - DESK.z0; DESK.ch = Math.round(DESK.cw * DESK.d / DESK.w);
  const deskPx = (x, z) => [(x + DESK.w / 2) / DESK.w * DESK.cw, (z - DESK.z0) / DESK.d * DESK.ch];
  const inkstone = rayToY(C1, 118, 178, 0);
  function deskCanvas() {
    const c = document.createElement('canvas'); c.width = DESK.cw; c.height = DESK.ch;
    const g = c.getContext('2d');
    g.fillStyle = css(W[0]); g.fillRect(0, 0, DESK.cw, DESK.ch);
    const rnd = mulberry(4401);
    // 字幕底下（S6）留一块干净的纸：木纹压到 0.3 倍
    camS6(680);
    const sub = [rayToY(cam6, SUB.x[1] - 70, SUB.y - 30, 0), rayToY(cam6, SUB.x[0] + 70, SUB.y + 4 * SUB.step + 40, 0)].map(p => deskPx(p.x, p.z));
    const subBox = [Math.min(sub[0][0], sub[1][0]) - 30, Math.min(sub[0][1], sub[1][1]) - 30, Math.max(sub[0][0], sub[1][0]) + 30, Math.max(sub[0][1], sub[1][1]) + 30];
    const inSub = (x, y) => x > subBox[0] && x < subBox[2] && y > subBox[1] && y < subBox[3];
    // 返修 w3（v3-02）：三层大洗染、书下淡墨影、砚台都改由桌面着色器（DESK_FS）按桌面坐标逐像素画（清楚的水渍边，不再是模糊滤镜的喷枪渐变）
    // 木纹：枯笔，宽 6–14K，沿长度粗细与透空变化、偶尔断开
    for (let i = 0; i < 46; i++) {
      const y = rnd() * DESK.ch, x0 = -100 + rnd() * DESK.cw * 0.7, len = 400 + rnd() * 1100, w0 = 5 + rnd() * 9, sd = i * 7 + 3;
      const sub3 = 22;
      for (let k = 0; k < sub3; k++) {
        const u0 = k / sub3, u1 = (k + 1) / sub3;
        if (vnoise1(u0 * 5 + sd, sd) > 0.55) continue;                         // 断开
        const xa = x0 + len * u0, xb = x0 + len * u1, ya = y + Math.sin(u0 * 4 + i) * 6, yb = y + Math.sin(u1 * 4 + i) * 6;
        const w = w0 * (0.55 + 0.45 * Math.sin(u0 * 3.1)) * (0.8 + 0.4 * vnoise1(u0 * 9 + sd, sd + 1));
        let a = (0.05 + 0.06 * rnd()) * (0.6 + 0.4 * vnoise1(u0 * 7 + sd, sd + 2));
        if (inSub((xa + xb) / 2, (ya + yb) / 2)) a *= 0.3;
        g.strokeStyle = css(W[3], a); g.lineWidth = w; g.lineCap = 'round';
        g.beginPath(); g.moveTo(xa, ya); g.lineTo(xb, yb); g.stroke();
        for (let j = 0; j < 3; j++) { g.strokeStyle = css(W[0], 0.35); g.lineWidth = 0.8; const oy = (rnd() - 0.5) * w * 0.7; g.beginPath(); g.moveTo(xa, ya + oy); g.lineTo(xb, yb + oy); g.stroke(); }   // 枯笔里透出的纸丝
      }
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t;
  }
  const deskTex = deskCanvas();
  // 字幕底下（S6）留纸的桌面框、桌面远处暗部的起点（S6 画面顶上 y≈175 一线），都按 S6 机位反算到桌面坐标
  camS6(680);
  const subW = [rayToY(cam6, SUB.x[1] - 90, SUB.y - 40, 0), rayToY(cam6, SUB.x[0] + 90, SUB.y + 4 * SUB.step + 50, 0)];
  camS6(645);
  const farZ = rayToY(cam6, 1650, 190, 0).z, farX = rayToY(cam6, 900, 120, 0).x;
  const deskMat = new THREE.ShaderMaterial({ uniforms: {
      uPal: U.uPal, uK: U.uK, uT: U.uT, map: { value: deskTex }, uLod: { value: 0 },
      uStone: { value: new THREE.Vector4(inkstone.x, inkstone.z, 0.12, 0.081) }, uStoneB: { value: new THREE.Vector4(-0.12, 0, 0, 0) },
      uBook: { value: new THREE.Vector4(-PW - 0.016, -PH / 2 - 0.008, PW + 0.006, PH / 2 + 0.022) },
      uSubB: { value: new THREE.Vector4(Math.min(subW[0].x, subW[1].x), Math.min(subW[0].z, subW[1].z), Math.max(subW[0].x, subW[1].x), Math.max(subW[0].z, subW[1].z)) },
      uFarW: { value: new THREE.Vector4(farZ, 0.06, 1, farX) }, uOchre: { value: new THREE.Vector3(...COL.ochreL) } },
    vertexShader: PAGE_VS, fragmentShader: DESK_FS, side: THREE.DoubleSide });
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(DESK.w, DESK.d), deskMat);
  desk.geometry.setAttribute('aXn', new THREE.BufferAttribute(new Float32Array(desk.geometry.attributes.position.count).fill(9), 1));
  desk.rotation.x = -Math.PI / 2; desk.position.z = (DESK.z0 + DESK.z1) / 2; scene.add(desk);

  // ───────── 页面画布：两页一张 ─────────
  const wood = tex.woodcut.image, wS = WOOD.w * PXM / wood.width;
  const woodAt = (ix, iy) => { const [cx, cy] = toCanvas(WOOD.cx, WOOD.cz); return [cx + (ix - wood.width / 2) * wS, cy + (iy - wood.height / 2) * wS]; };
  const patchPoly = man.A09['锚点'].polys.patch_flank.map(([x, y]) => woodAt(x, y));
  // 木刻"刻本化"：阈值 → 闭运算把小虚线圈填成实心刀刻块 → 按噪声随机腐蚀 / 膨胀 1–2 px（刀口崩缺）→ 边缘 0.6 px 抖动 → 印刷压力不匀
  const woodInk = (() => {
    const c = document.createElement('canvas'); c.width = wood.width; c.height = wood.height; const g = c.getContext('2d');
    g.drawImage(wood, 0, 0); const d = g.getImageData(0, 0, c.width, c.height), a = d.data;
    const Wd = c.width, Hd = c.height, N = Wd * Hd;
    let A = new Float32Array(N);
    for (let i = 0; i < N; i++) { const L = (0.2126 * a[i * 4] + 0.7152 * a[i * 4 + 1] + 0.0722 * a[i * 4 + 2]) / 255; A[i] = clamp((0.80 - L) / 0.45); }
    const morph = (src, r, mx) => {
      const tmp = new Float32Array(N), out = new Float32Array(N);
      for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) { let v = mx ? 0 : 1; for (let k = -r; k <= r; k++) { const xx = Math.min(Wd - 1, Math.max(0, x + k)); const s = src[y * Wd + xx]; v = mx ? Math.max(v, s) : Math.min(v, s); } tmp[y * Wd + x] = v; }
      for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) { let v = mx ? 0 : 1; for (let k = -r; k <= r; k++) { const yy = Math.min(Hd - 1, Math.max(0, y + k)); const s = tmp[yy * Wd + x]; v = mx ? Math.max(v, s) : Math.min(v, s); } out[y * Wd + x] = v; }
      return out;
    };
    let closed = morph(morph(A, 1, true), 1, false);                 // 返修第 2 轮：新 A09 自带刀口崩缺，只做 1 px 闭运算（不再把断口连死）
    // 小虚线圈的圈心填成实心刀刻块：找出被墨围住的小块纸（面积 < 1400 px）填墨；身体里的大块纸不动
    {
      const lab = new Int32Array(N).fill(-1), q = new Int32Array(N);
      let id = 0;
      for (let st = 0; st < N; st++) {
        if (lab[st] >= 0 || closed[st] > 0.5) continue;
        let h = 0, t = 0; q[t++] = st; lab[st] = id; let touch = false;
        while (h < t) { const i = q[h++], x = i % Wd, y = (i / Wd) | 0; if (x === 0 || y === 0 || x === Wd - 1 || y === Hd - 1) touch = true;
          for (const j of [i - 1, i + 1, i - Wd, i + Wd]) { if (j < 0 || j >= N || lab[j] >= 0 || closed[j] > 0.5) continue; if ((j % Wd === 0 && i % Wd === Wd - 1) || (i % Wd === 0 && j % Wd === Wd - 1)) continue; lab[j] = id; q[t++] = j; } }
        if (!touch && t < 1400) for (let k = 0; k < t; k++) closed[q[k]] = 0.92;
        id++;
      }
    }
    const dil = morph(closed, 1, true), ero = morph(closed, 1, false);
    for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
      const i = y * Wd + x;
      const n = vnoise1(x / 7 + y * 0.013, 11) * 0.5 + vnoise1(y / 6 + x * 0.017, 12) * 0.5;
      let v = n > 0.45 ? ero[i] : n < -0.45 ? dil[i] : closed[i];
      const pr = 0.85 + 0.15 * (0.5 + 0.5 * vnoise1(x / 90 + y / 140, 13));
      v = clamp(v * 1.1) * pr;
      a[i * 4] = W[5][0] * 255; a[i * 4 + 1] = W[5][1] * 255; a[i * 4 + 2] = W[5][2] * 255; a[i * 4 + 3] = 255 * Math.pow(v, 0.8) * 0.94;
    }
    g.putImageData(d, 0, 0); return c;
  })();
  // 毛笔线：有起笔收笔，粗细 ±20%
  const brushLine = (g, x0, y0, x1, y1, w, col, seed) => {
    const pts = wobbleLine([x0, y0], [x1, y1], 30, seed, 1.0, [0.55, 1, 0.7]).map((p, i, arr) => [p[0], p[1], p[2] * (0.85 + 0.3 * (0.5 + 0.5 * vnoise1(i * 0.37 + seed, seed)))]);
    stroke(g, pts, w, col, { t0: w * 2, t1: w * 4, thinning: 0.45 });
  };
  function pageCanvas(mode) {   // mode: 's1g' 眼镜、无镊子；'s1gt' 眼镜 + 镊子；'s1t' 镊子；'s6' 补齐
    const c = document.createElement('canvas'); c.width = CW; c.height = CH;
    const g = c.getContext('2d');
    g.fillStyle = css(COL.page); g.fillRect(0, 0, CW, CH);
    const rnd = mulberry(5101);
    // 返修 w3（v3-02）：旧书页不再是一片均匀的浅米色——每页两三块大的淡赭水渍（贴着页边、书脚，边上一道清楚的潮线），
    //   霉斑也改成边清楚、边深心浅的小水渍（原来是 3 px 模糊的软边，放大后像喷枪）
    const blob = (x, y, r, sq, seed, fillA, rimA, rimW) => {
      const pts = []; for (let k = 0; k < 96; k++) { const a = k / 96 * 6.283; const rr = r * (1 + 0.26 * fbm1(Math.cos(a) * 1.3 + Math.sin(a) * 0.6 + seed, 40 + seed) + 0.10 * fbm1(a * 3 + seed, 50 + seed)); pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * sq]); }
      const path = () => { g.beginPath(); pts.forEach(([px, py], k) => k ? g.lineTo(px, py) : g.moveTo(px, py)); g.closePath(); };
      path(); g.fillStyle = css(COL.ochreL, fillA); g.fill();
      g.save(); path(); g.clip(); path(); g.filter = 'blur(1.2px)'; g.strokeStyle = css(COL.ochreM, rimA); g.lineWidth = rimW; g.stroke(); g.restore();   // 潮线只往里积（边深心浅）
    };
    for (const [x, y, r, sq] of [[160, 1560, 420, 0.55], [1180, 170, 330, 0.60], [2500, 1580, 380, 0.55], [1420, 1640, 300, 0.45], [2480, 260, 260, 0.70]]) blob(x, y, r, sq, Math.round(x + y), 0.065, 0.19, 8);
    for (let i = 0; i < 7; i++) {
      const x = rnd() * CW, y = rnd() * CH, r = 50 + rnd() * 120, ph = rnd() * 9;
      blob(x, y, r, 0.8, i * 13 + Math.round(ph), 0.06 + 0.04 * rnd(), 0.16, 5 + rnd() * 5);
    }
    // 版框双线 + 竖界栏：毛笔线（不写字）
    for (const side of [0, 1]) {
      const x0 = side * CW / 2 + 110, x1 = side * CW / 2 + CW / 2 - 110, y0 = 150, y1 = CH - 160, sd = side * 40;
      const col = css(W[3], 0.62), col2 = css(W[3], 0.40);
      brushLine(g, x0, y0, x1, y0, 7.5, col, sd + 1); brushLine(g, x1, y0, x1, y1, 7.5, col, sd + 2); brushLine(g, x1, y1, x0, y1, 7.5, col, sd + 3); brushLine(g, x0, y1, x0, y0, 7.5, col, sd + 4);
      brushLine(g, x0 + 18, y0 + 18, x1 - 18, y0 + 18, 2.8, col2, sd + 5); brushLine(g, x1 - 18, y0 + 18, x1 - 18, y1 - 18, 2.8, col2, sd + 6); brushLine(g, x1 - 18, y1 - 18, x0 + 18, y1 - 18, 2.8, col2, sd + 7); brushLine(g, x0 + 18, y1 - 18, x0 + 18, y0 + 18, 2.8, col2, sd + 8);
      for (let k = 1; k < 10; k++) { const x = x0 + 18 + (x1 - x0 - 36) * k / 10; brushLine(g, x, y0 + 20, x, y1 - 20, 2.2, css(W[2], 0.28), sd + 10 + k); }
    }
    for (let k = 0; k < 6; k++) {                        // 返修第 3 轮（v1-07）：爻条印在纸上的那一圈洇（约 2–3K，淡墨，压在条下只露出边上一线；浮起后和印痕一起留在页上）
      const [cx, cy] = toCanvas(HEX.cx, yaoZ(k)), L = HEX.len * PXM, T = HEX.thick * PXM;
      const segsI = HEX.yin[k] ? [[cx - HEX.gap * PXM / 2 - HEX.half * PXM / 2, HEX.half * PXM], [cx + HEX.gap * PXM / 2 + HEX.half * PXM / 2, HEX.half * PXM]] : [[cx, L]];
      for (const [x, len] of segsI) {                    // 超椭圆（指数 10）≈ 圆角长条，比条本身每边大 3 px，边上带一点噪声
        g.save(); g.filter = 'blur(5px)'; g.beginPath();
        const a = len / 2 + 3, b = T / 2 + 3;
        for (let j = 0; j <= 160; j++) { const th = j / 160 * 2 * Math.PI, c = Math.cos(th), sn = Math.sin(th), r = 1 + 0.02 * vnoise1(j * 0.31 + k * 7 + x * 0.01, 905);
          g.lineTo(x + a * r * Math.sign(c) * Math.pow(Math.abs(c), 0.2), cy + b * r * Math.sign(sn) * Math.pow(Math.abs(sn), 0.2)); }
        g.closePath(); g.fillStyle = css(W[3], 0.30); g.fill(); g.restore();
      }
    }
    for (let k = 0; k < 6; k++) {                        // 爻浮起后页面上留下的淡墨印痕：边软、刷印不匀（不是硬矩形）
      const [cx, cy] = toCanvas(HEX.cx, yaoZ(k)), L = HEX.len * PXM, T = HEX.thick * PXM;
      const segsI = HEX.yin[k] ? [[cx - HEX.gap * PXM / 2 - HEX.half * PXM / 2, HEX.half * PXM], [cx + HEX.gap * PXM / 2 + HEX.half * PXM / 2, HEX.half * PXM]] : [[cx, L]];
      for (const [x, len] of segsI) {
        g.save(); g.filter = 'blur(4px)';
        for (let j = 0; j < 7; j++) { const yy = cy - T / 2 + T * (j + 0.5) / 7; stroke(g, [[x - len / 2, yy, 0.8], [x, yy + (rnd() - 0.5) * 3, 1], [x + len / 2, yy, 0.7]], T / 7 * 1.4, css(W[4], 0.07 + 0.06 * rnd()), { t0: 10, t1: 30 }); }
        g.restore();
      }
    }
    if (mode !== 's6') {                                 // 「革」：S1 交代过了，S6 机位远、斜，不再画（小字会糊成乱码）
      const [cx, cy] = toCanvas(HEX.cx, HEX.cz - 0.060);
      g.font = `${Math.round(0.0175 * PXM)}px BBMS`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = css(W[5], 0.9); g.fillText('革', cx, cy);
    }
    { const [x0, y0] = woodAt(0, 0); g.drawImage(woodInk, x0, y0, wood.width * wS, wood.height * wS); }
    g.save();
    g.beginPath(); patchPoly.forEach(([x, y], i) => { const jx = x + (hash2(i, 77) - 0.5) * 6, jy = y + (hash2(i, 78) - 0.5) * 6; i ? g.lineTo(jx, jy) : g.moveTo(jx, jy); }); g.closePath();
    g.fillStyle = css(COL.patch); g.fill();
    g.strokeStyle = css(COL.ochreL, 0.35); g.lineWidth = 4; g.stroke();
    g.strokeStyle = css(W[1], 0.35); g.lineWidth = 1.5; g.setLineDash([3, 5]); g.stroke(); g.setLineDash([]);
    g.restore();
    const pc = patchPoly.reduce((a, p) => [a[0] + p[0] / patchPoly.length, a[1] + p[1] / patchPoly.length], [0, 0]);
    const spotsS1 = [[-0.20, -0.05], [0.18, 0.18]];
    const spotsS6 = [[-0.20, -0.05], [0.18, 0.18], [-0.45, 0.15], [0.42, -0.12], [0.02, -0.30], [0.05, 0.28], [-0.10, 0.40], [0.32, 0.38]];
    const bw = Math.max(...patchPoly.map(p => p[0])) - Math.min(...patchPoly.map(p => p[0])), bh = Math.max(...patchPoly.map(p => p[1])) - Math.min(...patchPoly.map(p => p[1]));
    const RR = 0.0050 * PXM;
    (mode === 's6' ? spotsS6 : spotsS1).forEach(([u, v], i) => drawRosette(g, pc[0] + u * bw * 0.9, pc[1] + v * bh * 0.9, RR * (0.92 + 0.16 * hash2(i, 5)), 700 + i, css(COL.patchInk), 0.95));
    if (mode === 's1g' || mode === 's1gt') {
      const p = rayToY(C1, 1450, 215, 0.016);
      const [gx, gy] = toCanvas(p.x, p.z);
      drawGlasses(g, gx, gy, 0.0155 * PXM, -0.06, 0, W.slice(1), W[0], COL.lensLight, 0);
    }
    if (mode === 's1gt' || mode === 's1t') {             // 镊子放在右页下方（画内）
      const p = rayToY(C1, 1560, 812, 0.0155);
      const [tx, ty] = toCanvas(p.x, p.z);
      drawTweezers(g, tx, ty, 194 * DEG, 0.075 * PXM, W[4]);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  }
  const pageTex = { s1g: pageCanvas('s1g'), s1gt: pageCanvas('s1gt'), s1t: pageCanvas('s1t'), s6: pageCanvas('s6') };
  const pageMatA = pageMat(pageTex.s1g);
  for (const side of [-1, 1]) {
    const nx = 48, nz = 32, pos = [], uv = [], xn = [], idx = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const u = i / nx, x = side < 0 ? -PW + u * PW : u * PW, z = -PH / 2 + j / nz * PH;
      const d = Math.abs(x) / PW; pos.push(x, pageY(d), z); uv.push((x + PW) / (2 * PW), 1 - j / nz); xn.push(d);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    gg.setAttribute('aXn', new THREE.Float32BufferAttribute(xn, 1)); gg.setIndex(idx); gg.computeVertexNormals();
    scene.add(new THREE.Mesh(gg, pageMatA));
    const stack = new THREE.Mesh(new THREE.BoxGeometry(PW, 0.0095, PH), stackMat());
    stack.position.set(side * PW / 2, 0.0048, 0); scene.add(stack);
  }

  // ───────── 八根爻条（T1 浮起）：薄片，投影是同形淡墨晕（边上一道深边） ─────────
  const bars = [];
  const barG = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);   // 返修 w3（v3-07）：只要顶面一片（原来是压扁的盒子：上下两面叠着混合，四个侧面成了亚像素细条，透出一圈亮细线）
  for (let k = 0; k < 6; k++) {
    const segs = HEX.yin[k] ? [[-(HEX.gap / 2 + HEX.half / 2), HEX.half], [HEX.gap / 2 + HEX.half / 2, HEX.half]] : [[0, HEX.len]];
    for (const [dx, len] of segs) {
      const m = new THREE.Mesh(barG, new THREE.ShaderMaterial({ uniforms: { uPal: U.uPal, uStretch: { value: 1 }, uSeed: { value: bars.length + 1 }, uOp: { value: 1 } },
        vertexShader: BAR_VS, fragmentShader: BAR_FS, side: THREE.DoubleSide, transparent: true }));
      m.scale.set(len, 0.00004, HEX.thick);
      const x = HEX.cx + dx, z = yaoZ(k), y = pageY(Math.abs(x) / PW) + 0.0007;
      m.position.set(x, y, z); m.userData = { k, x0: x, y0: y, z0: z, len, dx };
      m.renderOrder = 3;
      scene.add(m); bars.push(m);
    }
  }
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 96; const g = c.getContext('2d');
    g.filter = 'blur(10px)'; g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(30, 30, 196, 36);
    g.filter = 'blur(2.5px)'; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 4; g.strokeRect(34, 34, 188, 28);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t;
  })();
  const shadows = bars.map(b => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0, depthWrite: false, color: 0x3a3026 }));
    m.rotation.x = -Math.PI / 2; m.renderOrder = 2; scene.add(m); return m;
  });

  // ───────── S1 的手（A06-S1a–d），B 类合成；线条加浓加粗、肤色内缩 ─────────
  const H = {};
  for (const [k, id, file] of [['tw', 'A06-S1a', 'hTweezers'], ['palm', 'A06-S1b', 'hPalm'], ['reach', 'A06-S1c', 'hReach'], ['pinch', 'A06-S1d', 'hPinch']]) {
    const m = sprite(tex[file], man[id], { order: 20, depthTest: false, a0: 0.32, a1: 0.82, erode: 3, rimInk: [2.6, 4.2] });
    m.material.uniforms.uLi.value = 0.46; m.material.uniforms.uLine.value.set(1, 1.7, 4.2, 0.80);
    m.visible = false; scene.add(m);
    H[k] = { m, a: man[id]['锚点'], w: tex[file].image.width, h: tex[file].image.height };
  }
  const held = canvasPlane(512, 300, { order: 19, depthTest: false, fogMul: 0, mip: true }); held.mesh.visible = false; scene.add(held.mesh);

  // ───────── S6：后脑肩臂 A11、双手 A06-5、袖筒（代码补到画底）——都钉在世界里（相机推近时有真视差） ─────────
  // A11 的底边是裁切边：把最下面几行往下拉长 420 px，衬衫与手臂一直延到画外（推近时底边不再露出来）
  const OTS_EXT = 420, OTS_H = 1079 + OTS_EXT;
  const otsTex = (() => {
    const im = tex.ots.image, c = document.createElement('canvas'); c.width = 704; c.height = OTS_H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
    // 返修第 2 轮（v1-05）：往下补长不再拉伸最后几行（那样轮廓会变成一根细直的双线）：里面平铺衬衫的纸色，
    //   右缘轮廓照原线的斜率、粗细与墨色接着往下写（和原线重叠一段接成一笔），两道衣褶顺着原方向再出一截、收笔
    const px = g.getImageData(0, 1066, 704, 1).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let x = 40; x < 600; x++) { if (px[x * 4 + 3] > 250) { r += px[x * 4]; gg += px[x * 4 + 1]; b += px[x * 4 + 2]; n++; } }
    const shirt = `rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})`, shirt0 = `rgba(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)},0)`;
    const cx = y => 677 + 0.236 * (y - 1078) + 0.00006 * (y - 1078) ** 2;
    { // 衣褶在接缝前就淡掉（不在接缝处被一刀切断）：原图最下 60 行里，轮廓以内渐渐盖上衬衫的纸色
      const gr = g.createLinearGradient(0, 1016, 0, 1078); gr.addColorStop(0, shirt0); gr.addColorStop(1, shirt);
      g.save(); g.beginPath(); g.moveTo(0, 1016); for (let y = 1016; y <= 1080; y += 8) g.lineTo(cx(y) - 9, y); g.lineTo(0, 1080); g.closePath(); g.clip();
      g.fillStyle = gr; g.fillRect(0, 1016, 704, 64); g.restore();
    }
    g.fillStyle = shirt; g.beginPath(); g.moveTo(0, 1074); for (let y = 1074; y <= OTS_H; y += 20) g.lineTo(cx(y) - 3, y); g.lineTo(0, OTS_H); g.closePath(); g.fill();
    const lineC = css(PAL.real[3], 0.86);
    const pts = []; for (let y = 1040, i = 0; y <= OTS_H; y += 24, i++) pts.push([cx(y) - 1.5, y, 0.85 + 0.25 * vnoise1(i * 0.7, 71)]);
    stroke(g, pts, 6.4, lineC, { t0: 2, t1: 60, thinning: 0.35 });
    for (const [x0, y0, dx, dy] of [[420, 1079, -40, 64], [395, 1079, -22, 52]]) stroke(g, [[x0 + dx * 0.15, y0 - dy * 0.15, 0.8], [x0 + dx * 0.6, y0 + dy * 0.6, 0.55], [x0 + dx, y0 + dy, 0.15]], 5, css(PAL.real[2], 0.55), { t0: 1, t1: 20 });
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8;
    return t;
  })();
  const ots = sprite(otsTex, man.A11, { order: 22, depthTest: false, a0: 0.30, a1: 0.80, erode: 2.5, rimInk: [3.0, 4.6] });
  ots.material.uniforms.uLi.value = 0.20; ots.visible = false; scene.add(ots);
  const two = sprite(tex.hTwo, man.A06, { order: 21, depthTest: false, a0: 0.32, a1: 0.82, erode: 2, rimInk: [2.6, 4.2] });
  two.material.uniforms.uLi.value = 0.42; two.material.uniforms.uLp.value = 0.93; two.material.uniforms.uLine.value.set(1, 1.6, 4, 0.80);
  two.visible = false; scene.add(two);
  // 返修第 3 轮（v1-05）：手图袖口 y 298 以下（参差的裁切残边、左边那块浅色毛片）淡掉，化进下面接着画的袖筒
  two.material.uniforms.uFadeB.value.set(297, 313);
  const SLV_H = 980, SLV_W = 1240, SLV_OX = 640;          // 画布往左多留 640 px：袖筒往左下出画时不被画布边切断
  const sleeves = canvasPlane(SLV_W, SLV_H, { order: 20.9, depthTest: false, fogMul: 0, mip: true }); sleeves.mesh.visible = false; scene.add(sleeves.mesh);
  {
    const g = sleeves.ctx; g.clearRect(0, 0, SLV_W, SLV_H); g.translate(SLV_OX, 0);
    // 返修第 2 轮（v1-05）：袖筒照 A06 的画法——前臂往肘部渐宽、略带弯；两侧轮廓是有粗细起伏的毛笔线，从袖口下面淡入（不再在接缝处冒出深色小三角）；
    //   衣褶是袖口下几道短而弯的斜笔、肘部再一两道，不再是一排平行长直线
    // 袖筒从手图袖口还不透明的那一截（y 318，左 25–153、右 382–517）下面起笔，层序在手图之下：袖口线收笔的地方由袖筒的线接着往下走
    // 返修第 3 轮（v1-05）：袖筒的起笔两角对准手图袖口在 y 330 那一行的轮廓（左 20–160、右 381–512，按 alpha 量的），
    //   手图袖口最下面那截参差的边（y 342 起）淡掉，袖筒的两侧墨线从顶上就起笔，接住手图袖口的轮廓线（不再露出浅色的直角和小三角）
    //   （手图左袖口 y 300 以下往左多出一块参差的浅色"毛片"（出图裁切的残边），所以从 y 290 就接：手图 y 298–312 淡掉，袖筒从 y 290 起、宽度对准 y 290 那一行的袖口）
    const sl = [[[47, 290], [160, 290], [-0.60, 1], 1.38, 11], [[395, 290], [518, 290], [-0.47, 1], 1.28, 23]];
    sl.forEach(([a, b, d, wid, sd]) => {
      const n = Math.hypot(d[0], d[1]), dx = d[0] / n, dy = d[1] / n, L = 720;
      const w0 = b[0] - a[0], w1 = w0 * wid;
      // 中线：从袖口中点竖直往下起（与手图里袖口那一截同向），前 30% 慢慢弯到前臂方向，再带一点弧；两侧边按当地法线偏移半宽
      //   → 起笔那一端正好是一条水平线，与手图袖口在 y 330 的宽度一致（藏在不透明的袖口下面）
      const NS = 48, C = [], T = [], HW = [];
      let px = (a[0] + b[0]) / 2, py = a[1];
      for (let i = 0; i <= NS; i++) {
        const u = i / NS, k = ss(Math.min(1, u / 0.30));
        let tx = lerp(0, dx, k), ty = lerp(1, dy, k); const tl = Math.hypot(tx, ty); tx /= tl; ty /= tl;
        const bow = 26 * Math.sin(Math.PI * u) * (sd > 15 ? -1 : 1) * ss(Math.min(1, u / 0.3));
        C.push([px + (-ty) * bow, py + tx * bow]); T.push([tx, ty]); HW.push(lerp(w0, w1, Math.pow(u, 0.8)) / 2);
        px += tx * L / NS; py += ty * L / NS;
      }
      const at = u => { const x = clamp(u) * NS, i = Math.min(NS - 1, Math.floor(x)), f = x - i; const m = (A, B) => [lerp(A[0], B[0], f), lerp(A[1], B[1], f)]; return { c: m(C[i], C[i + 1]), t: m(T[i], T[i + 1]), h: lerp(HW[i], HW[i + 1], f) }; };
      const side = (u, s) => { const q = at(u); return [q.c[0] + s * (-q.t[1]) * q.h, q.c[1] + s * q.t[0] * q.h]; };   // s = +1：a 那一侧（左），−1：b 那一侧（右）
      const edgeA = [], edgeB = [];
      for (let i = 0; i <= NS; i++) { edgeA.push(side(i / NS, 1)); edgeB.push(side(i / NS, -1)); }
      const tubePath = () => { g.beginPath(); edgeA.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); for (let i = edgeB.length - 1; i >= 0; i--) g.lineTo(edgeB[i][0], edgeB[i][1]); g.closePath(); };
      tubePath(); g.fillStyle = css(mix3(W[0], W[1], 0.28)); g.fill();       // 返修第 3 轮（v1-05）：袖筒底色压到与手图袖口同一调子（接缝处不再一亮一暗）
      g.save(); tubePath(); g.clip();
      const mA = side(0.5, 1), mB = side(0.5, -1);
      const gr = g.createLinearGradient(mA[0], mA[1], mB[0], mB[1]); gr.addColorStop(0, css(COL.ochreL, 0.14)); gr.addColorStop(0.5, css(COL.ochreL, 0.03)); gr.addColorStop(1, css(W[2], 0.12));
      g.fillStyle = gr; g.fillRect(-SLV_OX, 0, SLV_W, SLV_H);
      // 受暗的一侧一层淡墨洗染（有体积，不是一根白管子）
      g.filter = 'blur(10px)'; g.strokeStyle = css(W[2], 0.20); g.lineWidth = w0 * 0.42; g.beginPath(); edgeB.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.filter = 'none';
      g.restore();
      const press = (pts, k0) => pts.map((p, i) => [p[0], p[1], clamp(0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, i / (pts.length - 1) * 1.2)) * (0.8 + 0.4 * vnoise1(i * 0.6 + k0, k0)), 0.2, 1.1)]);
      stroke(g, press(edgeA, sd), 3.2, css(W[4], 0.84), { t0: 10, t1: 6, thinning: 0.6 });
      stroke(g, press(edgeB, sd + 5), 2.6, css(W[4], 0.80), { t0: 12, t1: 6, thinning: 0.6 });
      // 衣褶：袖口下几道短斜笔（长短、弯度各不同），肘部一两道
      for (const [u0, len, sideK, bend] of [[0.03, 0.08, -0.10, 5], [0.10, 0.12, -0.25, 7], [0.16, 0.08, 0.20, -6], [0.24, 0.10, -0.05, 5], [0.38, 0.11, 0.25, -6], [0.47, 0.09, -0.20, 5], [0.62, 0.14, 0.15, -8], [0.78, 0.10, -0.10, 6]]) {
        const q0 = at(u0), q1 = at(u0 + len);
        const off = (q, k) => [q.c[0] + (-q.t[1]) * q.h * k, q.c[1] + q.t[0] * q.h * k];
        const p0 = off(q0, -sideK * 2), p2 = off(q1, -(sideK * 2 - 0.35));
        const nn = [-(q0.t[1] + q1.t[1]) / 2, (q0.t[0] + q1.t[0]) / 2];
        const p1 = [(p0[0] + p2[0]) / 2 - nn[0] * bend, (p0[1] + p2[1]) / 2 - nn[1] * bend];
        stroke(g, [[p0[0], p0[1], 0.3], [p1[0], p1[1], 0.9], [p2[0], p2[1], 0.25]], 2.2, css(W[3], 0.50), { t0: 10, t1: 18 });
      }
    });
    sleeves.tex.needsUpdate = true;
  }

  // ───────── 相机 ─────────
  const HEXC = V3(HEX.cx, 0.017, HEX.cz);
  function camS1(fr) {
    let p, tgt;
    if (fr <= 60) { const u = ss5(fr / 60); p = V3(lerp(0.035, 0.025, u), lerp(0.40, 0.385, u), lerp(0.255, 0.240, u)); tgt = V3(0.02, 0, -0.005); }
    else if (fr <= 81) { const u = ei(seg(fr, 60, 81)) * 0.75 + ss(seg(fr, 60, 81)) * 0.25; p = V3(lerp(0.025, -0.07, u), lerp(0.385, 0.26, u), lerp(0.240, 0.135, u)); tgt = V3(lerp(0.02, HEXC.x, u), lerp(0, HEXC.y, u), lerp(-0.005, HEXC.z, u)); }
    else {
      const P = [[81, -0.07, 0.26, 0.135], [94, -0.095, 0.10, 0.03], [102, -0.104, 0.046, -0.018], [110, -0.106, 0.040, -0.026]];
      const fx = monotone(P.map(a => [a[0], a[1]])), fy = monotone(P.map(a => [a[0], a[2]])), fz = monotone(P.map(a => [a[0], a[3]]));
      p = V3(fx(fr), fy(fr), fz(fr)); tgt = HEXC.clone();
    }
    const t = fr / 24, w = fr < 82 ? 1 : 0;
    p.x += 0.0015 * vnoise1(t / 1.7 * 2, 91) * w; p.y += 0.001 * vnoise1(t / 1.7 * 2 + 5, 92) * w;
    lookAt(cam, p, tgt);
    return cam;
  }
  function placeHand(hk, sx, sy, s, rot = 0, feat = 'index_tip') {
    const h = H[hk], a = h.a.points[feat];
    const m = h.m; m.visible = true;
    clearHandles(m);
    if (rot) setHandle(m, 0, { c: a, r0: 4000, r1: 4001, pivot: a, ang: rot * DEG });
    placeImg(m, cam, h.w, h.h, a[0], a[1], sx, sy, s, 0.25);
    return m;
  }
  const S1_SCALE = 0.9;
  // DESIGN 4.1 动画表（一拍二）；f22–f30 去放镊子的落点挪到画内（右页下方 (1560, 812)），f32 落下
  const KEY = [
    [0, 'tw', 'tweezer_tip', 1352, 552, 0], [8, 'tw', 'tweezer_tip', 1352, 558, 0], [10, 'tw', 'tweezer_tip', 1351, 548, 0], [14, 'tw', 'tweezer_tip', 1354, 557, 0],
    [16, 'tw', 'tweezer_tip', 1352, 549, 0], [20, 'tw', 'tweezer_tip', 1353, 556, 0], [22, 'tw', 'tweezer_tip', 1360, 560, 0],
    [24, 'tw', 'tweezer_tip', 1420, 640, -3], [26, 'tw', 'tweezer_tip', 1480, 720, -4], [28, 'tw', 'tweezer_tip', 1520, 780, -5], [30, 'tw', 'tweezer_tip', 1540, 806, -5],
    [32, 'reach', 'lead_tip', 1560, 650, -4],
    [34, 'palm', 'index_pad', 1470, 560, -8], [36, 'palm', 'index_pad', 1468, 556, -8], [38, 'palm', 'index_pad', 1470, 560, -8], [40, 'palm', 'index_pad', 1468, 556, -8],
    [42, 'palm', 'index_pad', 1470, 560, -8], [44, 'palm', 'index_pad', 1472, 562, -8],
    [46, 'reach', 'lead_tip', 1520, 470, -6], [48, 'reach', 'lead_tip', 1500, 360, -8], [50, 'reach', 'lead_tip', 1478, 262, -8],
    [52, 'pinch', 'pinch', 1452, 236, -6], [54, 'pinch', 'pinch', 1448, 218, -6], [56, 'pinch', 'pinch', 1440, 190, -7], [58, 'pinch', 'pinch', 1428, 160, -8],
    [60, 'pinch', 'pinch', 1414, 150, -9], [62, 'pinch', 'pinch', 1400, 118, -10], [64, 'pinch', 'pinch', 1386, 86, -11], [66, 'pinch', 'pinch', 1370, 48, -12],
    [68, 'pinch', 'pinch', 1346, -16, -13], [70, 'pinch', 'pinch', 1312, -110, -14],
  ];
  const keyAt = f2 => { let k = KEY[0]; for (const e of KEY) if (e[0] <= f2) k = e; return k; };

  function S1(st) {
    const { f, fr } = st;
    camS1(fr);
    const f2 = Math.floor(f / 2) * 2;
    for (const k in H) H[k].m.visible = false;
    held.mesh.visible = false;
    ots.visible = false; two.visible = false; sleeves.mesh.visible = false;
    pageMatA.uniforms.map.value = f < 32 ? pageTex.s1g : f < 52 ? pageTex.s1gt : pageTex.s1t;
    const lod = 1.25 * (1 - ss(seg(fr, 66, 74)));
    pageMatA.uniforms.uLod.value = lod; deskMat.uniforms.uLod.value = lod;
    bars.forEach((b, i) => { b.visible = true; b.material.uniforms.uStretch.value = 1; b.material.uniforms.uOp.value = 1; b.position.set(b.userData.x0, b.userData.y0, b.userData.z0); b.rotation.set(0, 0, 0); shadows[i].material.opacity = 0; });
    let anchor = null;
    if (f <= 70) {
      const [, hk, feat, sx, sy, rot] = keyAt(f2);
      const m = placeHand(hk, sx, sy, S1_SCALE, rot, feat);
      const u = m.material.uniforms, a = H[hk].a.points;
      const sp = [];
      const pad = a.index_pad || a.index_tip || a.lead_tip || a.index_tip_lifted;
      if (hk === 'palm') { sp.push({ x: pad[0] - 2, y: pad[1] + 14, R: 27 / S1_SCALE, seed: 7, mode: 0, prog: 1, op: 1 }); sp.push({ x: a.thumb_tip[0] - 6, y: a.thumb_tip[1] + 12, R: 12 / S1_SCALE, seed: 8, mode: 0, prog: 1, op: 0.95 }); }
      else if (hk === 'tw') sp.push({ x: a.index_tip[0] + 10, y: a.index_tip[1] + 8, R: 15 / S1_SCALE, seed: 7, mode: 0, prog: 1, op: 0.95 });
      else if (hk === 'pinch') sp.push({ x: a.index_tip_lifted[0] + 4, y: a.index_tip_lifted[1] + 18, R: 16 / S1_SCALE, seed: 7, mode: 0, prog: 1, op: 0.95 });
      else if (hk === 'reach') sp.push({ x: a.lead_tip[0] + 16, y: a.lead_tip[1] + 10, R: 14 / S1_SCALE, seed: 7, mode: 0, prog: 1, op: 0.9 });
      if (hk === 'palm' && (f2 === 36 || f2 === 40)) setHandle(m, 1, { c: a.thumb_tip, r0: 30, r1: 90, tr: [-4 / S1_SCALE, 4 / S1_SCALE] });
      setSpots(m, sp);
      u.uSpInk.value.set(...COL.patchInk);
      anchor = { hk, sx: keyAt(f2)[3], sy: keyAt(f2)[4] };
      if (hk === 'pinch' && st.over) {
        const tilt = ss(seg(f2, 52, 66)), k = keyAt(f2), th = rot * DEG;
        const q0 = [a.rod_end[0] - a.pinch[0], a.rod_end[1] - a.pinch[1]];
        const re = [k[3] + (Math.cos(th) * q0[0] - Math.sin(th) * q0[1]) * S1_SCALE, k[4] + (Math.sin(th) * q0[0] + Math.cos(th) * q0[1]) * S1_SCALE];
        const dir = [Math.cos(th + Math.PI), Math.sin(th + Math.PI)];
        const R = 52, droop = 0.30 * (1 - tilt) + 0.12;
        const hinge = [re[0] + dir[0] * 105, re[1] + dir[1] * 105 + 40 * droop];
        const ang = Math.atan2(-dir[1], -dir[0]) + droop * 0.5;
        const cx = hinge[0] - 2.15 * R * Math.cos(ang), cy = hinge[1] - 2.15 * R * Math.sin(ang);
        const g = st.over; g.save();
        drawGlasses(g, cx, cy, R, ang, tilt * 0.62, W.slice(1), W[0], COL.lensLight, 0, true);
        const ov = [re[0] - dir[0] * 26, re[1] - dir[1] * 26];
        stroke(g, [[hinge[0], hinge[1], 0.7], [(hinge[0] + re[0]) / 2, (hinge[1] + re[1]) / 2 - 5, 0.7], [re[0], re[1], 0.55], [ov[0], ov[1], 0.4]], 2.4, css(W[4], 0.92), { t0: 2, t1: 10 });
        g.restore();
        st.glassAt = [cx + 1.12 * R * Math.cos(ang), cy + 1.12 * R * Math.sin(ang)];
        st.glassR = R * (1 - 0.3 * tilt * 0.62);
      }
    }
    return { cam, anchor, glassAt: st.glassAt, glassR: st.glassR, paper: paperAnchor(cam) };
  }

  // T1：f82–f107 书页这一半（爻条浮起、投影、延展）；hideBars：2D 线接手后（f96 起）不再画 3D 爻条（只留一种轮廓）
  function T1(st) {
    const { f, fr } = st;
    camS1(fr);
    for (const k in H) H[k].m.visible = false;
    held.mesh.visible = false; ots.visible = false; two.visible = false; sleeves.mesh.visible = false;
    pageMatA.uniforms.map.value = pageTex.s1t;
    pageMatA.uniforms.uLod.value = 0; deskMat.uniforms.uLod.value = 0;
    const str = 1 + 1.3 * ss5(seg(fr, 92, 104));
    bars.forEach((b, i) => {
      const k = b.userData.k, f0 = 82 + 2 * k, u = eo(seg(fr, f0, f0 + 6));
      const h = (k === 4 ? 0.0085 : 0.004 + 0.003 * k) * u;           // 九五略低一些：上六两段之间的缺口不被它填上
      b.position.set(b.userData.x0 + b.userData.dx * (str - 1), b.userData.y0 + h, b.userData.z0);
      b.rotation.x = (-4 + 1.5 * k) * DEG * u;
      b.material.uniforms.uStretch.value = str;
      const bo = st.barOp ?? 1;
      b.visible = bo > 0.01; b.material.uniforms.uOp.value = bo;
      const sh = shadows[i];
      sh.position.set(b.position.x + h * 0.5, b.userData.y0 + 0.0002, b.position.z + h * 0.5);
      sh.scale.set(b.userData.len * str * 1.25, HEX.thick * 2.4 * (1 + h / 0.012), 1);
      sh.material.opacity = 0.20 * u * (st.shOp ?? st.barOp ?? 1);
    });
    return { cam, paper: paperAnchor(cam) };
  }
  const _a = V3(0, 0, 0), _b = V3(0, 0, 0);
  // 每根爻条在当前机位下的屏幕投影：中线两端 a、b，以及两端各自的投影宽（返修第 3 轮 v1-02：2D 线按投影的四个角起笔，同宽同位置）
  function barCapsules() {
    const T = HEX.thick / 2, side = V3(0, 0, 0);
    return bars.map(b => {
      const L = b.userData.len * b.material.uniforms.uStretch.value / 2;
      _a.set(-L, 0, 0); _b.set(L, 0, 0);
      b.updateMatrixWorld(true);
      const pa = _a.clone().applyQuaternion(b.quaternion).add(b.position), pb = _b.clone().applyQuaternion(b.quaternion).add(b.position);
      const A = project(cam, pa), B = project(cam, pb);
      const ok = A.z > 0.003 && B.z > 0.003;
      side.set(0, 0, T).applyQuaternion(b.quaternion);
      const wOf = p => { const p1 = project(cam, p.clone().add(side)), p0 = project(cam, p.clone().sub(side)); return { w: Math.hypot(p1.x - p0.x, p1.y - p0.y), c: [(p0.x + p1.x) / 2, (p0.y + p1.y) / 2] }; };
      const ea = wOf(pa), eb = wOf(pb);
      return { a: ea.c, b: eb.c, wA: ea.w, wB: eb.w, ok, k: b.userData.k, depth: (A.z + B.z) / 2 };
    });
  }

  // ───────── S6：过肩（相机在右肩后，vfov 36°）；f655–f690 向右手推近约 15% ─────────
  function camS6(fr) {
    const u = ss5(seg(fr, 645, 719)), k = ss(seg(fr, 655, 690));
    const tgt = PAGE_R.clone().lerp(RH_W, 0.50 * k);
    frameAt(cam6, tgt, lerp(1180, 1285, k), lerp(760, 800, k), (0.80 - 0.02 * u) * (1 - 0.15 * k), (18 - 1.0 * u) * DEG, -41 * DEG);   // 返修第 3 轮（story-09）：向右手推近 15%，同时整幅往右下让一点（后脑、右耳、肩上的光斑留在画里）
    cam6.position.x += 0.012 * u;
    cam6.updateMatrixWorld(true);
    return cam6;
  }
  // 参考帧（f645）里按屏幕摆好，之后钉在世界里
  const A11 = man.A11['锚点'];
  camS6(645);
  placeImg(ots, cam6, 704, OTS_H, A11.points.ear_center[0], A11.points.ear_center[1], 520, 330, 1.0, 0.35); ots.updateMatrixWorld(true);
  const HS = 0.62, HA = [1252, 778];
  placeImg(two, cam6, 541, 387, 270, 194, HA[0], HA[1], HS, 0.74); two.updateMatrixWorld(true);
  placeImg(sleeves.mesh, cam6, SLV_W, SLV_H, 270 + SLV_OX, 194, HA[0], HA[1], HS, 0.7405); sleeves.mesh.updateMatrixWorld(true);
  for (const m of [ots, two, sleeves.mesh]) m.matrixAutoUpdate = false;
  const EAR_W = V3((A11.points.ear_center[0] / 704 - 0.5), (0.5 - A11.points.ear_center[1] / OTS_H), 0).applyMatrix4(ots.matrixWorld);
  const TIP_W = V3(359 / 541 - 0.5, 0.5 - 49 / 387, 0).applyMatrix4(two.matrixWorld);
  function S6(st) {
    const { f, fr } = st;
    const c = camS6(fr);
    for (const k in H) H[k].m.visible = false;
    held.mesh.visible = false;
    pageMatA.uniforms.map.value = pageTex.s6;
    pageMatA.uniforms.uLod.value = 0; deskMat.uniforms.uLod.value = 0;
    bars.forEach((b, i) => { b.visible = true; b.material.uniforms.uStretch.value = 1; b.material.uniforms.uOp.value = 1; b.position.set(b.userData.x0, b.userData.y0, b.userData.z0); b.rotation.set(0, 0, 0); shadows[i].material.opacity = 0; });
    const t2 = Math.floor(f / 2) * 2 / 24;
    ots.visible = true; two.visible = true; sleeves.mesh.visible = true;
    const br = Math.sin(2 * Math.PI * t2 / 4.2);
    setBreath(ots, 1079, 1 + 0.002 * br, 1 + 0.005 * br, 352);
    // 右手持镊：f656–f700 一次看得懂的"夹起—放下"（一拍二，位移 10–20K）
    clearHandles(two);
    const f2 = Math.floor(f / 2) * 2;
    const lift = ss(seg(f2, 656, 668)) * (1 - ss(seg(f2, 684, 698)));
    const slide = ss(seg(f2, 668, 684));
    const dx = 16 * slide + 3 * Math.sin(f2 * 0.9) * lift, dy = -14 * lift + 2 * slide, ang = 4 * lift;
    setHandle(two, 0, { c: [360, 70], r0: 120, r1: 240, pivot: [400, 260], ang: ang * DEG, tr: [dx / HS, dy / HS] });
    // 返修第 3 轮（story-09）：指尖那一圈光跟着手走——按同一个控制柄算出食指尖（图 359, 49）这一帧的位移
    { const a = ang * DEG, qx = 359 - 400, qy = 49 - 260; tipD[0] = Math.cos(a) * qx - Math.sin(a) * qy - qx + dx / HS; tipD[1] = Math.sin(a) * qx + Math.cos(a) * qy - qy + dy / HS; }
    return { cam: c, paper: paperAnchor6(c) };
  }
  // S6 指尖（右手食指尖）在当前机位下的屏幕位置（随手的挪动）
  const tipD = [0, 0];
  const tipS6 = (c = cam6) => { const w = V3((359 + tipD[0]) / 541 - 0.5, 0.5 - (49 + tipD[1]) / 387, 0).applyMatrix4(two.matrixWorld); const p = project(c, w); return [p.x, p.y]; };
  // 屏幕层的世界钉：book（书与手、桌）/ shirt（肩背衬衫）两层各自的平移缩放（参考帧 f645 → 当前帧）
  camS6(645); const LAY0 = { book: project(cam6, PAGE_R), book2: project(cam6, PAGE_R.clone().add(V3(0.1, 0, 0))), shirt: project(cam6, EAR_W) };
  function layerXf(c) {
    const b = project(c, PAGE_R), b2 = project(c, PAGE_R.clone().add(V3(0.1, 0, 0))), s = project(c, EAR_W);
    const sb = Math.hypot(b2.x - b.x, b2.y - b.y) / Math.hypot(LAY0.book2.x - LAY0.book.x, LAY0.book2.y - LAY0.book.y);
    return { book: { o0: [LAY0.book.x, LAY0.book.y], o1: [b.x, b.y], s: sb }, shirt: { o0: [LAY0.shirt.x, LAY0.shirt.y], o1: [s.x, s.y], s: LAY0.shirt.z / s.z } };
  }

  const PREF1 = project(C1, HEXC);
  function paperAnchor(c) { const p = project(c, HEXC); return { x: p.x, y: p.y, rx: PREF1.x, ry: PREF1.y, s: clamp(Math.pow(PREF1.z / Math.max(p.z, 0.01), 0.5), 0.5, 3) }; }
  camS6(645); const PREF6 = project(cam6, PAGE_R);
  function paperAnchor6(c) { const p = project(c, PAGE_R); return { x: p.x, y: p.y, rx: PREF6.x, ry: PREF6.y, s: PREF6.z / Math.max(p.z, 0.01) }; }

  return { scene, cam, cam6, C1, S1, T1, S6, barCapsules, camS1, camS6, tipS6, layerXf, bars, H, clear: () => U.uPal.value[0] };
}

function stackMat() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 64; const g = c.getContext('2d');
  g.fillStyle = css(COL.page); g.fillRect(0, 0, 16, 64);
  for (let y = 2; y < 64; y += 3) { g.fillStyle = css(PAL.real[2], 0.25); g.fillRect(0, y, 16, 1); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
  return new THREE.MeshBasicMaterial({ map: t });
}
