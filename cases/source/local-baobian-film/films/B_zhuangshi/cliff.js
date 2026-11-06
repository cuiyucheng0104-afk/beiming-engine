// cliff.js — 场景 Y：南山雾崖（S2、S4a–c 豹变特写一镜、S4d 第七天雾散；也作 T1 / S3d 的门户内容）
// 远 → 近：天幕 → 七日（剪纸圆）→ 六道叠晕远脊 → 谷雾 2 → 鹿群 → 谷雾 1 → 崖后雾 → 崖与洞底板 → 3D 虬松 →
//          陆蔚坐背 → 灰豹 → 3D 前缘长石 / 巨石 → 前雾 →（叠加层）雨。
import * as THREE from 'three';
import { makeToonMaterial, bindToon } from '/films/_lib/toon.js';
import {
  W, H, K, SHARED, lin, lin3, GLSL_COMMON, cardMat, card, putCard, putScreen, makeSprite, placeSprite, setRot, clearDeform,
  DEG, clamp, lerp, seg, ss, ss5, eio, eo, hashi, aimCamera, screenToWorld, project, mulberry, fseg, qbez, tcOf, THICK_FS,
} from './lib.js';
import { makeLeo, setSpots } from './leo.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const FPX85 = 520 / Math.tan(13.09 / 2 * DEG);     // 4533
const FPX50 = 520 / Math.tan(22.07 / 2 * DEG);     // 2666

// ───────────────────────── 卡片着色器 ─────────────────────────
export const SKY_FS = /* glsl */`
uniform vec3 uTop, uHor, uLow; uniform vec3 uTop2, uMid2, uHor2; uniform float uClear, uHorY;
void main(){
  float y = gl_FragCoord.y / uRes.y;                 // 0 下 1 上
  float hy = 1. - uHorY / 1040.;
  vec3 a = mix(uLow, uHor, smoothstep(0., hy, y));
  a = mix(a, uTop, smoothstep(hy, 1., y));
  vec3 b = mix(uHor2, uMid2, smoothstep(hy, hy + .25, y));
  b = mix(b, uTop2, smoothstep(hy + .2, 1., y));
  b = mix(uHor2, b, step(hy - .02, y)) ;
  vec3 c = mix(a, b, uClear);
  vec2 p = gl_FragCoord.xy / uK;
  c *= 1. + .02 * (bbFbm(p / 220.) - .5) * 2.;
  float fl = bbFbm(p / 30. + 7.3);
  float m = smoothstep(.735, .75, fl);
  c = mix(c, mix(c, vec3(.8069, .7230, .5647), .18), m * .6);
  gl_FragColor = vec4(c, 1.);
}`;
export const SUN_FS = /* glsl */`
uniform vec3 uCol, uRing; uniform float uA, uGold, uHalo; uniform float uSeed;
void main(){
  vec2 q = (vUv - .5) * 2.;                     // 卡片 = 2.2 倍日径（留给头光）
  q *= 1.6 + uHalo * 0.;
  float r = length(q), th = atan(q.y, q.x);
  float wob = 1. + .010 * (sin(th * 7. + uSeed) + .6 * sin(th * 13. + uSeed * 2.1)) * (1. - uGold);
  float R = 1. * wob;
  float aa = fwidth(r) * 1.2;
  float disk = 1. - smoothstep(R - aa, R + aa, r);
  vec3 c = mix(uCol, uRing, smoothstep(R * .97 - aa, R * .97 + aa, r));
  if (uGold > .5) c = mix(uCol, uRing, smoothstep(.86 - aa, .86 + aa, r));
  float a = disk;
  // 头光三环（fix1，style-13）：环间过渡 ±0.07R、由内向外 α 0.85 → 0.35 渐淡、总 α 0.6——读成一圈光，不是三个靶环
  if (uHalo > 0.) {
    vec3 h1 = vec3(.7991, .5520, .4793), h2 = vec3(.4020, .3916, .4287), h3 = vec3(.3467, .5647, .7305);
    float w = .55 / 3., e = .07;
    float k1 = smoothstep(1.02 - e, 1.02 + e, r) * (1. - smoothstep(1.05 + w - e, 1.05 + w + e, r));
    float k2 = smoothstep(1.05 + w - e, 1.05 + w + e, r) * (1. - smoothstep(1.05 + 2. * w - e, 1.05 + 2. * w + e, r));
    float k3 = smoothstep(1.05 + 2. * w - e, 1.05 + 2. * w + e, r) * (1. - smoothstep(1.6 - .12, 1.6 + .06, r));
    float ks = max(k1 + k2 + k3, 1e-4);
    vec3 hc = (h1 * k1 + h2 * k2 + h3 * k3) / ks;
    float ha = (k1 * .85 + k2 * .60 + k3 * .35) * .70 * uHalo;
    c = mix(hc, c, disk); a = max(a, ha);
  }
  gl_FragColor = vec4(c, a * uA);
}`;
// ⑩ 叠晕山（uHard = 1：ref_00 式硬边叠晕——每层平涂、层顶一线亮、逐层压暗 ×uBandK，第 5 层起是核色）
export const RIDGE_FS = /* glsl */`
uniform vec4 uPk[10]; uniform float uNpk; uniform vec2 uSize; uniform float uBase, uBW, uSeedR;
uniform vec3 uC, uEdge, uCore, uMist; uniform vec3 uRimC; uniform float uRimA, uRimW, uFadeTop, uFadeBot, uClear, uOp, uSpr, uHard, uBandK, uPlat;
float hProf(float x){
  float h = 0.;
  for (int k = 0; k < 10; k++) {
    if (float(k) >= uNpk) break; vec4 P = uPk[k]; float sx = abs(x - P.x) / P.y; if (sx >= 1.) continue;
    float v = P.w > 0. ? P.z * pow(1. - sx * sx, P.w + .4) : P.z * pow(1. - sx, -P.w);     // 馒头峰圆顶 / 笋峰尖顶
    h = max(h, v);
  }
  if (uPlat > 0.) h -= max(h - uPlat, 0.) * .92;              // 顶上压出一块坐台（S5a 主峰）
  return uBase + h + 3. * (bbFbm(vec2(x * .01, uSeedR)) - .5);
}
vec3 bandC(float k){ return k >= 4. ? uCore : uEdge * pow(uBandK, k); }
void main(){
  vec2 px = vUv * uSize;
  float h = hProf(px.x);
  float dq = h - px.y;                           // 山内深度（像素）
  float aa = fwidth(px.y) * 1.5;
  float inside = smoothstep(-aa, aa, dq);
  if (inside <= 0.) discard;
  float q = dq / uBW + mix(.35, .14, uHard) * (bbFbm(px * .02 + uSeedR) - .5);
  float k = floor(q), tt = fract(q);
  vec3 bc = mix(uEdge, uC, clamp(k / 3., 0., 1.));
  vec3 c = mix(mix(uEdge, bc, .35), bc, smoothstep(0., 1., tt));
  if (k >= 4.) c = uCore;
  if (uHard > .5) {
    float aq = max(fwidth(q), 1e-4) * 1.2;
    vec3 base = bandC(k), lip = k < 4. ? base * 1.12 : base;
    c = mix(lip, base, smoothstep(.22 - aq, .22 + aq, tt));
    c = mix(bandC(max(k - 1., 0.)), c, smoothstep(0., aq, tt) * step(.5, k) + step(k, .5));
  }
  // 带内斑驳（干笔）
  c *= 1. + mix(.03, .02, uHard) * (bbFbm(px * .05 + uSeedR * 3.) - .5);
  // 脊线金边（T1 金线化进远山）
  float rim = (1. - smoothstep(uRimW - 1.4, uRimW, dq)) * uRimA;
  c = mix(c, uRimC, rim);
  // 层底压雾（空气透视）
  float fog = smoothstep(uFadeTop, uFadeBot, (uSize.y - px.y) / uSize.y);
  c = mix(c, uMist, fog * (1. - .35 * uClear));
  float spr = uSpr < 0. ? 1. : bbSpread(gl_FragCoord.xy / uK, uSpr);
  gl_FragColor = vec4(c, inside * uOp * spr);
}`;
// ⑨ 雾带：上沿云头扇贝起伏 + 亮边，下沿软淡出
export const MIST_FS = /* glsl */`
uniform vec2 uSize; uniform float uA, uDrift, uSeedM, uSplit, uSink, uSoftTop, uBump, uCell;
uniform vec3 uCol, uColB, uRim;
void main(){
  vec2 px = vUv * uSize;
  px.y += uSink;
  float cx = uSize.x * .5;
  float side = px.x < cx ? -1. : 1.;
  // 左右拉开的雾：分开处是不规则的云头边（fbm + 扇贝），不是一条竖直的直边
  float ex = uSplit + 90. * (bbFbm(vec2(px.y * .006, uSeedM + 5.)) - .5) * 2. + 34. * sin(px.y * .021 + uSeedM * 3.);
  float gap = uSplit > .5 ? smoothstep(0., 150., abs(px.x - cx) - ex) : 1.;
  float x = px.x - side * uSplit + uDrift;
  // 上沿：不规则的软云头（两种尺度的起伏 + 随机相位的圆鼓包）
  float e = 16. * (bbFbm(vec2(x * .005, uSeedM)) - .5) * 2. + 7. * (bbFbm(vec2(x * .018, uSeedM + 3.)) - .5) * 2.;
  float cell = floor(x / uCell), fx = fract(x / uCell);
  float bump = uBump * (.5 + bbH1(cell * 3.1 + uSeedM)) * sqrt(max(1. - pow(fx * 2. - 1., 2.), 0.));
  float top = uSize.y - 40. - 1.5 * uBump + e + bump;
  float d = px.y - top;
  float soft = 9. + 8. * bbFbm(vec2(x * .01, 7.)) + uSoftTop;
  float inside = 1. - smoothstep(-soft, soft * .5, d);
  float bot = smoothstep(0., min(140., uSize.y * .7), px.y);
  float n = .80 + .20 * bbFbm(vec2(x * .003, px.y * .01 + uSeedM));
  float rim = (1. - smoothstep(2., 14., -d)) * inside;
  vec3 c = mix(uColB, uCol, smoothstep(0., uSize.y * .8, px.y));
  c = mix(c, uRim, rim * .45);
  gl_FragColor = vec4(c, uA * inside * bot * n * gap);
}`;
// 底板（崖与洞）：带调色；uOlive 把受光处的冷灰往橄榄苔黄推（天书奇谭的橄榄色族，style-17）；
// uFlatMoss 把放大后自带高光的蓝苔点压成平涂小色点（style-23）
const PLATE_FS = /* glsl */`
uniform sampler2D map; uniform vec3 uTint; uniform float uSat, uA, uOlive, uFlatMoss;
void main(){
  vec4 c = texture2D(map, vUv);
  vec3 col = c.rgb;
  float l = bbLum(col);
  // fix2（style-17）：最暗处由蓝石板 #313C4A 推到天书奇谭的青黑 #1D3738（线性乘 .42/.88/.62）
  col = mix(col, col * vec3(.42, .88, .62), (1. - smoothstep(.03, .09, l)) * min(uOlive / .8, 1.));
  col = mix(vec3(l), col, uSat) * uTint;
  float blu = smoothstep(.06, .14, col.b - col.r) * smoothstep(.10, .20, col.b);
  col = mix(col, vec3(.0137, .0999, .2462) * (.9 + .2 * smoothstep(.2, .5, l)), blu * uFlatMoss * .75);
  // 受光的层顶往橄榄苔黄推（R 提、B 压，色相落到 80–110°）；斑块状、不整片
  float om = smoothstep(.15, .30, l) * (.45 + .55 * smoothstep(.38, .62, bbFbm(vUv * vec2(7., 4.) + 2.3))) * (1. - blu);
  col = mix(col, col * vec3(1.55, 1.12, .62), om * uOlive);
  // 中间调往灰绿偏一点（受光层顶之外的大块石面不再是一色冷灰蓝）
  float mt = smoothstep(.035, .09, l) * (1. - smoothstep(.16, .30, l)) * (.35 + .65 * smoothstep(.40, .66, bbFbm(vUv * vec2(5., 3.) + 8.1))) * (1. - blu);
  col = mix(col, col * vec3(1.16, 1.07, .74), mt * uOlive * .75);
  gl_FragColor = vec4(col, c.a * uA);
}`;
// 前缘崖面（fix2，style-06 按 DESIGN 风险 #4 降级）：3D 长石 / 巨石读成 CG"石饼"，两轮都没救回来，停用。
// 换成一块手绘崖面：代理网格按 S2 参考机位 cam0 投影铺（顶边贴着 A17 平台前沿、和底板同一深度，向下逐渐前凸，保留一点真实视差），
// 内容全在 cam0 的设计像素里由着色器画。不受光、不描线，和 A17 的平台是同一块石头（ref_08）。
// fix3（v2-02）：fix2 的崖面读成"浮空薄石板"（前缘只有约 120 px、下沿一条清楚的波浪剪影贴着白雾；
//   13 px 一格的密排尖齿；灰紫收尖笔读成冰溜子；右端被直斜线切出楔形尖角）。改成：
//   ① 崖体往下延伸：左段不画下沿剪影，约 y 985 起在 80 px 里用 fbm 打散、同时褪向雾色，淡进前雾；
//      只有右端悬挑（x ≳ 1150）露出下沿，一簇长短悬殊的钟乳挂在悬挑下（数量约为 fix2 的一半）。
//   ② 披麻皴：主笔格宽 32 px、宽 6–16 px、深青 / 青灰 / 中灰绿深浅混合，约 35% 的格子空着；收笔不收尖，按飞白淡出；
//      灰紫收尖笔换成比底色略亮、不收尖的竖向干笔（α ≤ 0.35）；底色再加几块大的柔和深浅（水粉斑驳）。
//   ③ 右端岩角：带 fbm 起伏的圆钝角（圆角半径 50 px），不再是直斜线切出的楔形。
const LEDGE_FS = /* glsl */`
uniform vec4 uRect;
uniform sampler2D uFaceTex;
uniform vec3 uFace0, uFace1, uFaceLo, uFaceMid, uShade, uDeep, uLav, uOl, uRim, uMist, uTint;
uniform float uSat, uA;
float rimY(float x){
  float y = 841. - 26. * smoothstep(1050., 1330., x) - 12. * smoothstep(1320., 1395., x);
  return y + 3. * (bbFbm(vec2(x * .011, 1.7)) - .5) * 2.;
}
float hangW(float x){ return smoothstep(1100., 1250., x); }                 // 悬挑段权重（右端）
float hangBot(float x){                                                      // 悬挑段下沿（剪影）
  return 932. - 26. * smoothstep(1240., 1385., x) + 9. * (bbFbm(vec2(x * .017, 3.1)) - .5) * 2. + 4. * sin(x * .047 + 1.);
}
float fadeY(float x){ return 985. + 24. * (bbFbm(vec2(x * .0045, 6.3)) - .5) * 2.; }   // 左段淡进雾的起点
float edgeX(float y){                                                        // 右端岩面：略向里收、带 fbm 起伏；顶上倒一点角
  return 1394. - .12 * max(y - 806., 0.) - 9. * (1. - smoothstep(800., 836., y)) + 7. * (bbFbm(vec2(y * .021, 8.7)) - .5) * 2.;
}
vec4 lgOver(vec4 d, vec3 c, float a){ return vec4(c * a + d.rgb * (1. - a), a + d.a * (1. - a)); }
void main(){
  vec2 p = vec2(uRect.x + vUv.x * uRect.z, uRect.y + (1. - vUv.y) * uRect.w);
  float aa = max(fwidth(p.x), 1e-3) * 1.1;
  float rt = rimY(p.x), hw = hangW(p.x), hb = hangBot(p.x);
  // 下沿：左段 fadeY 起 80 px 打散淡出；悬挑段是清楚的剪影（宽度 0）
  float b0 = mix(fadeY(p.x), hb, hw), bw = mix(80., 0., hw);
  float nf = (bbFbm(vec2(p.x * .022, p.y * .016) + 4.2) - .5) * 2.;
  float yb = p.y + 30. * nf * (1. - hw);
  float fade = 1. - smoothstep(b0 - aa * 1.5, b0 + bw + aa * 1.5, yb);
  // 右端圆钝岩角：下沿与右缘按半径 50 px 的圆角相交
  float inR = 1.;
  if (p.x > 1250.) {
    vec2 dq = vec2(p.y - hb, p.x - edgeX(p.y)) + 50.;
    float dC = length(max(dq, 0.)) + min(max(dq.x, dq.y), 0.) - 50.;
    inR = 1. - smoothstep(-aa * 1.5, aa * 1.5, dC);
  }
  float inF = smoothstep(rt - aa, rt + aa, p.y) * fade * inR;
  vec4 acc = vec4(0.);
  float span = max(b0 + .5 * bw - rt, 40.);
  if (inF > 0.) {
    float v = clamp((p.y - rt) / span, 0., 1.2);
    // 崖面本体（fix3）：A20 手绘崖面（Magpie 按 ref_08 / ref_10 / A17 出图：大笔披麻、深青凹处、灰绿 / 灰紫脊、柔和过渡），
    // 按 cam0 设计像素铺（图像 1 px ≈ 0.90 设计 px，图顶从平台前沿往下 48 px 起、贴着 rimY 走）；
    // 亮度映到本片灰绿色板（深青 → 青灰 → 灰绿 → 浅灰绿），再保留三成原色（凹处的青、脊上的灰紫）
    vec2 ti = vec2((p.x + 220.) / .90 + 60., 48. + (p.y - rt) / .90);
    vec3 tx = texture2D(uFaceTex, vec2(ti.x / 2172., 1. - ti.y / 724.)).rgb;
    float ls = pow(max(bbLum(tx), 0.), 1. / 2.2);
    float tt = clamp((ls - .20) / .52, 0., 1.);
    // 色板（style-17：S2 的橄榄 / 苔黄色族要保住）：最暗一档深青，其余落在橄榄灰绿里
    vec3 ramp = tt < .20 ? mix(uDeep, uShade, tt / .20) : (tt < .46 ? mix(uShade, uFaceMid, (tt - .20) / .26) : (tt < .76 ? mix(uFaceMid, uFace0, (tt - .46) / .30) : mix(uFace0, uFaceLo, (tt - .76) / .24)));
    vec3 c = mix(ramp, tx, .10) * vec3(1.03, 1.01, .90);     // 只留一成原色（凹处的青、脊上的灰紫），再压一点蓝，落在橄榄灰绿色族里
    // 往下发亮（雾气），几块大的柔和深浅
    c = mix(c, uFaceLo, smoothstep(.60, 1.05, v) * .35);
    // 受光的脊上带一点苔黄：跟着贴图的亮处走，上部多、往下少（不再画一排竖向飞白条——那会读成挂着的流苏）
    float ol = smoothstep(.55, .85, tt) * (1. - smoothstep(.10, .60, v)) * (.5 + .5 * smoothstep(.40, .65, bbFbm(vec2(p.x * .006, p.y * .01) + 11.)));
    c = mix(c, uOl, ol * .45);
    // 平台前沿下一道深青暗带（不规则下沿）
    float sh = 1. - smoothstep(0., 8. + 12. * bbFbm(vec2(p.x * .018, 5.)), p.y - rt);
    c = mix(c, uShade, sh * .50);
    vec4 f = vec4(c, 1.);
    // 悬挑段下沿的暗面：钟乳从这里长出来，上沿不规则
    float ub = (12. + 14. * bbVN(vec2(p.x * .05, 2.2)));
    // w3（v3-01）：暗面的明暗噪声原来 x 向频率 .30（约 3 px 一格），放大看像梳齿 / 条形码；改成低频 fbm，读成一块不规则的暗面
    float under = smoothstep(hb - ub - 3., hb - ub + 3., p.y) * (.50 + .25 * smoothstep(.30, .70, bbFbm(vec2(p.x * .05, p.y * .03) + 2.3))) * hw;
    f.rgb = mix(f.rgb, mix(uShade, uDeep, .35), under);
    float lip = (1. - smoothstep(1.2, 3.2 + 2.5 * bbVN(vec2(p.x * .04, 1.)), p.y - rt)) * step(rt - aa, p.y);
    f.rgb = mix(f.rgb, uRim, lip * .9);
    // 往下褪向雾色（空气透视），左段在打散区里一路褪到雾色
    f.rgb = mix(f.rgb, uMist * vec3(1.02, 1., .95), smoothstep(b0 - 70., b0 + bw, p.y) * .40 * (1. - hw));
    acc = lgOver(acc, f.rgb, inF);
  }
  // 钟乳：只在右端悬挑下面挂一簇，长短悬殊（数量约为 fix2 的一半）
  // w3（v3-01）：原来是笔直、等宽收尖的几何尖锥，最长两根并排像针 / 冰锥。改成 ref_08 那种从暗面里长出来的墨挂：
  //   ① 粗细不一：宽度上叠 1–2 个鼓包 / 缩颈（1 + .3·sin(9t + id)）；② 略弯：横向摆幅 6–10 px（随长度增大）；
  //   ③ 根部并进暗面：根宽 ×1.6、起点高低不齐，颜色与暗面同色；④ 尖端 10 px 内淡到 α0.6；
  //   ⑤ 长的只许挂在双号格（相邻两格不会同时出长钟乳），长度封顶约 150 px
  if (p.x > 1170.) {
    float cw = 19.;
    float ci = floor(p.x / cw);
    for (int dc = -2; dc <= 2; dc++) {
      float cc = ci + float(dc), id = cc * 1.37 + 500.;
      float h1 = bbH1(id), h2 = bbH1(id * 1.9 + 1.), h3 = bbH1(id * 2.7 + 2.), h4 = bbH1(id * 3.3 + 3.);
      float xs = (cc + .2 + .6 * h2) * cw;
      if (xs < 1205. || h1 > .74) continue;
      if (xs > edgeX(hangBot(xs)) - 46.) continue;                       // 圆角处不挂
      float y0 = hangBot(xs) - 12. - 7. * h2;                           // 根从暗面里起，高低不齐
      bool lng = h3 > .50 && mod(cc, 2.) < .5;
      float Ld = lng ? 85. + 65. * (h3 - .50) / .50 : 14. + 42. * h3 / .50;           // 长的 85–150 px，短的 14–56 px
      float w0 = (lng ? 5.0 : 3.0) + 3.0 * h4;
      float t = (p.y - y0) / Ld;
      if (t < 0. || t > 1.) continue;
      float sw = (lng ? 6. + 4. * h4 : 2.5 + 2. * h4);
      float xc = xs + sw * sin(t * 2.0 + id) * t;
      float hwd = w0 * pow(1. - t, 1.05) * (1. + .30 * sin(9. * t + id * 2.3)) * (1. + .60 * (1. - smoothstep(0., .20, t)));
      // 根部 14 px 内从暗面里渐显（不留一道横平的上沿），尖端 10 px 内淡到 α0.6
      float cv = (1. - smoothstep(-aa, aa, abs(p.x - xc) - hwd)) * mix(1., .6, smoothstep(Ld - 10., Ld, p.y - y0))
               * smoothstep(0., 14. + 6. * h4, p.y - y0 + 3. * sin(p.x * .45 + id));
      vec3 col = mix(mix(uShade, uDeep, .35), mix(uDeep, uFace1, .45), smoothstep(.15, 1., t));
      col = mix(col, uRim, (1. - smoothstep(0., hwd * .45 + 1., abs(p.x - (xc - hwd * .55)))) * .18 * smoothstep(.10, .35, t) * (1. - t));
      acc = lgOver(acc, col, cv);
    }
  }
  if (acc.a < .002) discard;
  vec3 col = acc.rgb / max(acc.a, 1e-4);
  float l = bbLum(col); col = mix(vec3(l), col, uSat) * uTint;
  gl_FragColor = vec4(col, acc.a * uA);
}`;
// ③ 松针扇（天书奇谭的松：扇形针簇从枝梢向上外放射，深靛心、只有梢头发亮，一簇簇叠成平台；main-03 / style-10）
export const DISC_FS = /* glsl */`
uniform float uSeed, uRot, uBri, uFog, uN; uniform vec3 uFogC;
void main(){
  vec2 uv = (vUv - .5) * 2.;                     // 卡片 [-1,1]²，扇根在下方
  vec2 d = uv - vec2(0., -.86);
  float r = length(d) / 1.74;                    // 0 扇根 → 1 扇缘
  float a = atan(d.x, d.y);                      // 0 = 正上
  float hw = 1.08 + .14 * (bbH1(uSeed * 7.1) - .5);     // 半张角（约 ±62°），两侧往上斜，底边不再是一条平线
  float e = abs(a) / hw;
  if (e > 1.06 || r > 1.02) discard;
  float s = (a / hw * .5 + .5) * uN + uRot;
  float w = abs(fract(s) - .5) * 2.;
  float k = floor(s);
  float len = .70 + .30 * bbH1(k + uSeed * 31.);
  float rim = len * (1. - .14 * e * e);
  float aa = fwidth(r) * 1.5;
  float spoke = (1. - smoothstep(.16, .34, w)) * (1. - smoothstep(rim - .05, rim, r)) * smoothstep(.10, .20, r);
  // 实心的深靛扇心：扇贝边，只占里面一半多一点
  float bodyR = rim * (.50 + .10 * bbH1(k * 1.7 + uSeed)) + .03 * sin(a * 9. + uSeed);
  float body = (1. - smoothstep(bodyR - aa - .02, bodyR + aa + .02, r)) * (1. - smoothstep(.86, 1.0, e)) * smoothstep(.02, .08, r);
  vec3 H = vec3(.0060, .0296, .0382), M = vec3(.0395, .0896, .1529), T = vec3(.1590, .3712, .3515);   // 心 #113037、中 #39556C、梢 #6FA3A0
  vec3 c = mix(H, M, smoothstep(.45, .80, r));
  c = mix(c, T, spoke * smoothstep(.72, .90, r));
  c *= uBri;
  c = mix(c, uFogC, uFog);
  float alpha = max(body, spoke);
  if (alpha < .01) discard;
  gl_FragColor = vec4(c, alpha);
}`;

// ───────────────────────── 岩石：层纹 + 苔点（①）、松干 ─────────────────────────
export const ROCK_ALBEDO = /* glsl */`
{ vec3 P = vToonObj;
  // 竖向挂笔：拉长的深青笔触（天书奇谭崖下的垂笔），每一列长短不同（0.3–1.0），越往下越密
  float colI = floor(P.x * 26. + P.z * 9.);
  float lenK = .3 + .7 * fract(sin(colI * 12.9898 + 4.1) * 43758.5453);
  float st = toonNoise(vec3(P.x * 26. + P.z * 9., P.y * 2.6 / lenK, 3.1)) + .5 * toonNoise(vec3(P.x * 61., P.y * 5.2 / lenK, 7.7));
  float down = clamp((uTopY - P.y) / .40, 0., 1.);
  float stroke = smoothstep(.18 - .25 * down, .48 - .25 * down, st);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(.48, .62, .60), stroke * (.36 + .25 * down));
  // 弱层纹（同色深一档的断续层缘线）
  float s = P.y * 9. + .9 * toonFbm(P * vec3(1.1, 2.2, 1.1));
  float band = fract(s), aa = max(fwidth(s), 1e-4);
  diffuseColor.rgb *= mix(1.07, .89, band);
  toonInk = max(toonInk, (1. - smoothstep(0., .06 + aa, band)) * .42 * step(.3, toonNoise(P * 3.3) + .5));
  // 受光的上半部：一层苔黄干笔（#979672，fbm 阈值块，约 10–15%）
  float mo = smoothstep(.50, .60, toonFbm(P * vec3(3.2, 5.5, 3.2) + 1.7)) * (1. - .6 * down) * smoothstep(-.3, .3, normalize(vNormal).y);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.3095, .3050, .1683), mo * .85);
  // 顶缘一串蓝色苔点
  float moss = smoothstep(.55, .62, toonNoise(P * 30.)) * smoothstep(uTopY - .06, uTopY, P.y);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.028, .107, .323), moss);
  // 越往下越暗一点（不再压成深石板）
  diffuseColor.rgb *= mix(1.0, .88, down); }`;
function rockMat(c, s1, s2, topY) {
  return makeToonMaterial({
    color: c, shade1: s1, shade2: s2, step1: 0.58, feather1: 0.03, step2: 0.34, feather2: 0.03,
    edgeNoise: 0.05, edgeNoiseScale: 1.6, rimAmt: 0, rimLitAmt: 0, cityAmt: 0, skyAmt: 0, fog: false,
    inkColor: '#1E3444', fragmentPars: 'uniform float uTopY;', fragmentAlbedo: ROCK_ALBEDO,
    uniforms: { uTopY: { value: topY } },
  });
}
function bind(mesh, w, a) { bindToon(mesh, mesh.material, { castShadow: false, receiveShadow: false, outline: true }); mesh.userData.outlineWidth = w; mesh.userData.outlineAlpha = a; return mesh; }

// 渐细的管（松干）
function taperTube(points, r0, r1, seg = 64, rad = 7, knots = []) {
  const curve = new THREE.CatmullRomCurve3(points);
  const frames = curve.computeFrenetFrames(seg, false);
  const pos = [], idx = [], uv = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg, p = curve.getPointAt(u), N = frames.normals[i], B = frames.binormals[i];
    // 虬曲：半径起伏 ±25%，加几个疙瘩（局部 +30%）
    let r = lerp(r0, r1, Math.pow(u, 0.8)) * (1 + 0.25 * Math.sin(u * 23.0 + 0.7) * (1 - 0.6 * u) + 0.08 * Math.sin(u * 61.0));
    for (const kn of knots) r *= 1 + 0.30 * Math.exp(-Math.pow((u - kn) / 0.025, 2));
    for (let j = 0; j <= rad; j++) {
      const a = j / rad * Math.PI * 2;
      pos.push(p.x + r * (Math.cos(a) * N.x + Math.sin(a) * B.x), p.y + r * (Math.cos(a) * N.y + Math.sin(a) * B.y), p.z + r * (Math.cos(a) * N.z + Math.sin(a) * B.z));
      uv.push(u, j / rad);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < rad; j++) {
    const a = i * (rad + 1) + j, b = a + rad + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.computeVertexNormals();
  return { g, curve };
}

export function buildCliff({ tex }) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(13.09, W / H, 0.02, 4000);
  const cam0 = new THREE.PerspectiveCamera(13.09, W / H, 0.02, 4000);
  aimCamera(cam0, new THREE.Vector3(0.20, 0.56, 9.8), 0, 0);
  const S2W = (x, y, D) => screenToWorld(cam0, W, H, x * K, y * K, D);
  const add = o => { scene.add(o); return o; };

  // —— 天幕 ——
  const skyMat = cardMat(SKY_FS, {
    uTop: { value: lin('#BCD9DE') }, uHor: { value: lin('#E3EFEB') }, uLow: { value: lin('#D9E6E1') },
    uTop2: { value: lin('#6FA6CD') }, uMid2: { value: lin('#A9D3E1') }, uHor2: { value: lin('#D5EFFA') }, uClear: { value: 0 }, uHorY: { value: 520 },
  });
  const sky = add(card(skyMat, -10));

  // —— 七日 ——
  const SUN_COL = ['#C2553A', '#C9735A', '#CF8E78', '#D3A595', '#D5B8AD', '#D4C6C0', '#D0CDCA'];
  const SUN_A = [0.95, 0.85, 0.74, 0.62, 0.50, 0.38, 0.26];
  const suns = SUN_COL.map((c, i) => {
    const m = cardMat(SUN_FS, { uCol: { value: lin(c) }, uRing: { value: lin(c).multiplyScalar(0.78) }, uA: { value: 0 }, uGold: { value: 0 }, uHalo: { value: 0 }, uSeed: { value: i * 1.7 } });
    const s = add(card(m, 1)); s.visible = false; return s;
  });
  const SUN_D = 460, SP0 = [1900, 560], SP1 = [1560, -152.5], SP2 = [1380, 545];
  const sunAt = (s, x, y, dpx) => { putCard(s, cam0, x, y, dpx * 1.6, dpx * 1.6, SUN_D); };

  // —— 六道远脊 ——
  const RC = ['#CFD8B6', '#BFCAA0', '#AFBD90', '#9FB081', '#8FA274', '#7F9369'];   // fix2（style-17）：再往天书奇谭的灰绿 / 橄榄色族推一档（fix1 #D2DDCC…#7F9A82 仍偏青）
  // fix1：最远一道脊顶压到 y 516–524，和 T1 的屏幕金线对齐到 ±3 px（tech-01）；
  //       卡片加宽到 4400 px、居中摆，S4 换 50 mm 后右缘不再露出卡片硬边（tech-05）
  const RZ = [-320, -240, -180, -130, -90, -60], RTOP = [524, 536, 554, 572, 590, 608];
  const RID_W = 4400;
  const ridges = RC.map((c, i) => {
    const R = mulberry(500 + i * 17);
    const wpx = RID_W, hpx = 560, top = RTOP[i];
    const n = Math.min(10, 6 + Math.floor(R() * 5));
    const pk = [];
    for (let k = 0; k < 10; k++) {
      const sun = R() < 0.25 && i > 2;
      const x = 120 + (k + 0.3 + R() * 0.5) / n * (wpx - 240);
      const w = sun ? 120 + R() * 70 : 200 + R() * 260;
      const Hh = i === 0 ? 3 + R() * 5 : (i < 2 ? 10 + R() * 16 : 20 + R() * (24 + i * 7)) * (sun ? 1.25 : 1);
      pk.push(new THREE.Vector4(x, w, Hh, sun ? 1.3 : 1.6 + R() * 0.6));
    }
    const col = lin(c);
    const m = cardMat(RIDGE_FS, {
      uPk: { value: pk }, uNpk: { value: n }, uSize: { value: new THREE.Vector2(wpx, hpx) }, uBase: { value: hpx - 112 }, uBW: { value: 7 + i * 2.2 }, uSeedR: { value: i * 3.3 },
      uC: { value: col.clone().multiplyScalar(0.93) }, uEdge: { value: col.clone().lerp(lin('#F0F2E4'), 0.35) }, uCore: { value: col.clone().multiplyScalar(0.82) }, uMist: { value: lin('#E4F0EC') },
      uRimC: { value: lin('#E2B93B') }, uRimA: { value: 0 }, uFadeTop: { value: 0.36 }, uFadeBot: { value: 0.80 }, uClear: { value: 0 }, uOp: { value: 1 }, uSpr: { value: -1 }, uHard: { value: 0 }, uBandK: { value: 0.88 }, uRimW: { value: 2.6 }, uPlat: { value: 0 },
    });
    const r = add(card(m, 2 + i * 0.05));
    r.userData.base = { col, i };
    return r;
  });
  // 卡片中心：脊顶基线在卡片自上而下 112 px 处
  ridges.forEach((r, i) => putCard(r, cam0, 960, RTOP[i] - 112 + 280, RID_W, 560, 9.8 - RZ[i]));

  // —— 雾带 ——
  const mist = (name, z, y0, y1, A, order, cols = {}) => {
    const D = 9.8 - z, wpx = cols.w || 5200, hpx = (y1 - y0) + 60 + 1.5 * (cols.bump ?? 11);
    const m = cardMat(MIST_FS, {
      uSize: { value: new THREE.Vector2(wpx, hpx) }, uA: { value: A }, uDrift: { value: 0 }, uSeedM: { value: z * 0.37 + (cols.seed || 0) }, uSplit: { value: 0 }, uSink: { value: 0 }, uSoftTop: { value: cols.soft || 0 },
      uBump: { value: cols.bump ?? 11 }, uCell: { value: cols.cell ?? 160 },
      uCol: { value: lin(cols.c || '#E4F0EC') }, uColB: { value: lin(cols.b || '#B9CDC3') }, uRim: { value: lin(cols.rim || '#F2F8F5') },
    });
    const c = add(card(m, order));
    putCard(c, cam0, 960, (y0 + y1) / 2 + 10, wpx, hpx, D);
    c.userData.m = { D, A };
    return c;
  };
  const mist2 = mist('mist2', -45, 600, 700, 0.60, 3);
  const mist1 = mist('mist1', -25, 650, 760, 0.75, 4);
  const mistC = mist('mistC', -3, 690, 805, 0.50, 5);
  // 前雾：压在崖缘长石下面的一层雾海（下沿浓，长石的钟乳尖插进雾里，不再露出亮底，tech-12）
  const mistF = mist('mistF', 1.5, 1004, 1320, 0.74, 12, { bump: 16, soft: 8 });   // fix2：前雾下移约 45 px、变淡，钟乳尖露出来再进雾（style-06 ③）
  // S4d 雾散（story-06 / style-12）：三条前后错开、上沿是扇贝云头的软雾带（不再是一整幅矩形雾幕），
  // 雾色比天色亮一点；雾散时各自从中线向两侧拉开（分开处是不规则云头边），同时下沉淡出
  const VEIL_C = { c: '#EEF4EE', b: '#D6E4DE', rim: '#FBFDFB', bump: 30, cell: 180, soft: 60 };
  const veils = [
    mist('veilA', 2.0, 230, 520, 0.40, 12.4, { ...VEIL_C, seed: 1.3 }),
    mist('veilB', 1.2, 420, 760, 0.52, 12.45, { ...VEIL_C, seed: 4.1 }),
    mist('veilC', 0.6, 640, 1060, 0.60, 12.5, { ...VEIL_C, seed: 7.7 }),
  ];
  for (const v of veils) v.visible = false;

  // —— 鹿群（A18）：放大到约 85 px 高、暖赭身色（在冷雾里看得见），走在谷雾 1 上沿（story-04）——
  const DEER = tex.manifest.A18.锚点;
  const deer = [];
  for (let i = 0; i < 5; i++) {
    const sp = makeSprite(tex.deer_walk, { order: 3.7, lineCol: '#4A3420', noMask: false });
    sp.U.uTint.value.set(0.50, 0.30, 0.125);
    add(sp.group); deer.push(sp);
  }
  const DEER_POSE = DEER.poses.map(p => ({ crop: [(p.bbox_px[0] - 6) / 1507, (p.bbox_px[1] - 6) / 591, (p.bbox_px[2] + 6) / 1507, (p.bbox_px[3] + 6) / 591], pivot: p.foot_pivot_px }));
  const DEER_D = 9.8 + 40;

  // —— 崖与洞（A17）——
  const plateMat = cardMat(PLATE_FS, { map: { value: tex.cliff_cave }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uSat: { value: 1 }, uA: { value: 1 }, uOlive: { value: 1.0 }, uFlatMoss: { value: 0 } });
  const plate = add(card(plateMat, 6));
  putCard(plate, cam0, 887 - 160, 443.5 - 10, 1774, 887, 9.8 + 1.6);

  // —— 平台地面（与底板里画的平台同色同笔触；远端淡出、右端是崖缘）——
  const groundMat = cardMat(/* glsl */`
    uniform vec3 uG0, uG1, uG2, uG3; uniform vec4 uB; uniform float uWarm, uOn;
    void main(){
      vec3 P = vWorld;
      float a = smoothstep(uB.z, uB.z + .45, P.z) * uOn;
      if (a <= 0.) discard;
      float ex = uB.y + .05 * (bbFbm(vec2(P.z * 3., 1.)) - .5);
      a *= 1. - smoothstep(ex - .012, ex + .012, P.x);
      float ez = uB.w + .04 * (bbFbm(vec2(P.x * 2.5, 3.)) - .5);
      a *= 1. - smoothstep(ez - .010, ez + .010, P.z);
      // 平台石面：橄榄灰绿底 + 大块水粉斑驳（各向同性）+ 深一档的石斑 + 稀疏蓝苔点；越远越淡（压进雾色）
      float n1 = bbFbm(P.xz * 1.6);
      float n2 = bbFbm(P.xz * 5.5 + 4.);
      vec3 c = mix(uG1, uG2, smoothstep(.30, .75, n1));
      c = mix(c, uG3, smoothstep(.60, .78, bbFbm(P.xz * 3.1 + 7.)) * .45);
      c = mix(c, uG0, smoothstep(.64, .80, n2) * .55);
      // fix2（v1-04）：蓝苔点改成每格一个哈希圆点（原来是值噪声的方格阈值，放大后成了蓝方块）；降饱和到 #2E5F86、α0.55、密度减半
      { vec2 g = P.xz * 22., ci = floor(g); vec2 jt = vec2(bbH2(ci + 31.), bbH2(ci + 57.)) - .5;
        float dd = length(fract(g) - .5 - jt * .45), fw = fwidth(dd) * 1.2;
        float dm = (1. - smoothstep(.22 - fw, .22 + fw, dd)) * step(bbH2(ci + 9.), .11) * smoothstep(.55, .70, n2);
        c = mix(c, vec3(.0273, .1144, .2384), dm * .55); }
      float far = smoothstep(.3, -1.0, P.z);
      c = mix(c, vec3(.7758, .8550, .8228), far * .45);
      c = mix(c, c * vec3(1.06, 1.03, .92), uWarm);
      gl_FragColor = vec4(c, a);
    }`, { uG0: { value: lin('#6E7E70') }, uG1: { value: lin('#B2BC9C') }, uG2: { value: lin('#C2C8A6') }, uG3: { value: lin('#C9C99E') }, uB: { value: new THREE.Vector4(-2.9, 1.09, -1.05, 2.4) }, uWarm: { value: 0 }, uOn: { value: 0 } }, { side: THREE.DoubleSide });
  const ground = add(card(groundMat, 6.5));
  ground.rotation.x = -Math.PI / 2; ground.position.set(-0.9, -0.004, 0.7); ground.scale.set(4.2, 3.7, 1);

  // —— 3D 虬松（虬曲：半径起伏 ±25%、4 个疙瘩，干笔斑驳加重，颜色压暗一档，style-10）——
  const trunkPts = [[-1.85, 0.80, -1.25], [-1.65, 1.22, -1.25], [-1.34, 1.44, -1.28], [-0.87, 1.56, -1.28], [-0.39, 1.54, -1.25], [0.00, 1.41, -1.22], [0.30, 1.46, -1.20]].map(p => new THREE.Vector3(...p));
  const pineMat = makeToonMaterial({ color: '#625767', shade1: '#43404F', shade2: '#2E2B36', step1: 0.55, feather1: 0.025, step2: 0.30, feather2: 0.025,
    edgeNoise: 0.06, edgeNoiseScale: 2.5, dabAmt: 0.6, dabScale: 6, rimAmt: 0, rimLitAmt: 0, cityAmt: 0, skyAmt: 0, fog: false, inkColor: '#1E3444' });
  const trunk = taperTube(trunkPts, 0.10, 0.03, 96, 9, [0.12, 0.31, 0.55, 0.78]);
  const trunkM = add(bind(new THREE.Mesh(trunk.g, pineMat), 0.9, 0.7));
  const branchA = taperTube([trunk.curve.getPointAt(0.42), new THREE.Vector3(-0.62, 1.72, -1.30), new THREE.Vector3(-0.42, 1.86, -1.30), new THREE.Vector3(-0.20, 1.90, -1.28)], 0.04, 0.012, 32, 7, [0.45]);
  const branchB = taperTube([trunk.curve.getPointAt(0.70), new THREE.Vector3(-0.08, 1.62, -1.20), new THREE.Vector3(0.10, 1.72, -1.18), new THREE.Vector3(0.34, 1.70, -1.16)], 0.035, 0.012, 32, 7, [0.5]);
  const branchAM = add(bind(new THREE.Mesh(branchA.g, pineMat), 0.9, 0.7));
  const branchBM = add(bind(new THREE.Mesh(branchB.g, pineMat), 0.9, 0.7));
  // 松针扇：每簇一排 4–7 把扇（间距约 1.1 个扇宽，叠压 40–60%），上方再错开半格一排 3 把，叠成平台（main-03 / style-10）
  const discs = [];
  const clusters = [
    { c: trunk.curve.getPointAt(0.22), n: 5, w: 0.30, dy: 0.05 }, { c: trunk.curve.getPointAt(0.50), n: 7, w: 0.42, dy: 0.07 },
    { c: branchA.curve.getPointAt(0.95), n: 6, w: 0.34, dy: 0.04 }, { c: trunk.curve.getPointAt(0.80), n: 6, w: 0.36, dy: 0.04 },
    { c: branchB.curve.getPointAt(0.96), n: 6, w: 0.32, dy: 0.04 }, { c: trunk.curve.getPointAt(0.99), n: 4, w: 0.22, dy: 0.02 },
  ];
  let di = 0;
  const addFan = (p, d, R, tier) => {
    const m = cardMat(DISC_FS, { uSeed: { value: di }, uRot: { value: R() }, uBri: { value: 0.80 + R() * 0.32 }, uFog: { value: 0 }, uFogC: { value: lin('#C9DCD6') }, uN: { value: 18 + Math.floor(R() * 13) } }, { side: THREE.DoubleSide });
    const disc = add(card(m, 6.4 + p.z * 0.01 + tier * 0.002 + di * 0.0001));
    disc.position.copy(p); disc.scale.set(d * 1.30, d * 0.75, 1);
    discs.push(disc); di++;
  };
  for (const cl of clusters) {
    const R0 = mulberry(880 + di * 3);
    const d0 = 0.22 + R0() * 0.08;
    for (let k = 0; k < cl.n; k++) {
      const R = mulberry(900 + di * 7);
      const d = d0 * (0.85 + R() * 0.3);
      const u = cl.n > 1 ? k / (cl.n - 1) - 0.5 : 0;
      const span = (cl.n - 1) * d0 * 1.30 * 0.62;      // 扇宽 1.3·d，间距约 0.62 个扇宽 → 叠压约 40%
      const p = cl.c.clone().add(new THREE.Vector3(u * span + (R() - 0.5) * 0.03, cl.dy + (R() - 0.4) * 0.06 - Math.abs(u) * 0.07, (R() - 0.5) * 0.10 + 0.06));
      addFan(p, d, R, 0);
    }
    for (let k = 0; k < 3; k++) {
      const R = mulberry(1900 + di * 5);
      const d = d0 * (0.70 + R() * 0.2);
      const p = cl.c.clone().add(new THREE.Vector3((k - 1 + 0.5 * (R() - 0.5)) * d0 * 0.75, cl.dy + 0.07, (R() - 0.5) * 0.08 + 0.02));
      addFan(p, d, R, -1);
    }
  }
  // —— 陆蔚坐背（A07）——
  const A07 = tex.manifest.A07.锚点;
  const lw = makeSprite(tex.lw_sit_back, { order: 8, lineCol: '#2E2420', frag: THICK_FS, uniforms: { uThick: { value: 2.6 } } });   // 屏幕上约 2.7 px 的墨线（style-14 ②）
  add(lw.group);
  // fix2（style-14）：A07 重出后按"人形外接框高 386 px、底轴心落在 (1179, 792)"摆（和原契约 x≈1075–1365、y≈406–792 一致）
  const LW_D = 9.8 + 0.35, LW_BBH = 386, LW_PX = 1179, LW_Y1 = 792;
  const LW_PPM = (A07.bbox_px[3] - A07.bbox_px[1]) / (LW_BBH * LW_D / FPX85);
  const LW_P = S2W(LW_PX, LW_Y1, LW_D);
  // —— 灰豹（A01 蹲）/ 坐（A02）：fix1 新幼豹；S2 契约改为 x≈470–1030、着地线 y≈790 ——
  const A01 = tex.manifest.A01.锚点, A02 = tex.manifest.A02.锚点;
  const crouch = makeLeo(tex.leo_crouch, A01, { order: 9, spotScale: 1.15 });
  const sit = makeLeo(tex.leo_sit, A02, { order: 9, spotScale: 1.15 });
  add(crouch.group); add(sit.group);
  const BB = A01.bbox_px;
  const LEO_D = 9.8, LEO_S = 560 / (BB[2] - BB[0]);      // 屏幕像素 / 图像像素
  const LEO_PPM = 1 / (LEO_S * LEO_D / FPX85);
  const FOOT = A01.foot_pivot_px;
  const LEO_P = S2W(470 + (FOOT[0] - BB[0]) * LEO_S, 790 - (BB[3] - FOOT[1]) * LEO_S, LEO_D);
  const Q0 = new THREE.Quaternion();
  placeSprite(crouch, LEO_P, Q0, FOOT, LEO_PPM);
  const SIT_PPM = LEO_PPM * (A02.scale.px_per_m / A01.scale.px_per_m);
  placeSprite(sit, LEO_P, Q0, A02.foot_pivot_px, SIT_PPM);
  const BODY_L = Math.hypot(A01.nose_tip_px[0] - A01.tail_root_px[0], A01.nose_tip_px[1] - A01.tail_root_px[1]);   // 鼻尖→尾根（像素）
  // 环 0 的世界位置 P0
  const pxToWorld = (sp, px, out = new THREE.Vector3()) => {
    const c = sp.crop, cw = (c.z - c.x) * sp.img.x, ch = (c.w - c.y) * sp.img.y;
    out.set((px[0] - c.x * sp.img.x) / cw - 0.5, 0.5 - (px[1] - c.y * sp.img.y) / ch, 0);
    return out.applyMatrix4(sp.group.matrixWorld);
  };
  const P0 = pxToWorld(crouch, A01.spots[0].px);

  // —— 前缘崖面（fix2，style-06）：手绘崖面卡片（LEDGE_FS），3D 长石 / 巨石停用 ——
  // 代理网格：cam0 设计像素矩形 x −220…1500、y 800…1150；顶边在底板深度（11.4），往下逐渐前凸到 10.9（真实视差，S2 横移时下部比顶边多滑约 5 px）
  const LG = { x0: -220, y0: 800, w: 1720, h: 350 };
  const ledgeGeo = (() => {
    const nx = 48, ny = 14, pos = [], uv = [], idx = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const u = i / nx, v = j / ny;      // v = 0 顶
      const D = 11.4 - 0.5 * ss(clamp((v - 0.12) / 0.88));
      const P = S2W(LG.x0 + u * LG.w, LG.y0 + v * LG.h, D);
      pos.push(P.x, P.y, P.z); uv.push(u, 1 - v);
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + nx + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    return g;
  })();
  const ledgeMat = cardMat(LEDGE_FS, {
    uRect: { value: new THREE.Vector4(LG.x0, LG.y0, LG.w, LG.h) }, uFaceTex: { value: tex.ledge_face },
    uFace0: { value: lin('#7B886E') }, uFace1: { value: lin('#7D876F') }, uFaceLo: { value: lin('#A4AC92') }, uFaceMid: { value: lin('#5D6A4E') }, uShade: { value: lin('#2D4645') },
    uDeep: { value: lin('#1D3738') }, uLav: { value: lin('#A2A8B6') }, uOl: { value: lin('#979672') }, uRim: { value: lin('#BCC6A6') }, uMist: { value: lin('#C9D8D4') },
    uTint: { value: new THREE.Vector3(1, 1, 1) }, uSat: { value: 1 }, uA: { value: 1 },
  }, { side: THREE.DoubleSide });
  const ledge = add(card(ledgeMat, 6.1, ledgeGeo));
  // 松干的根（fix2，v1-08）：从画左外的崖壁里横着长出来，接进原来的干基（原干基是平切的管口，悬在崖前）
  const rootPts = [[-2.85, 0.60, -1.36], [-2.35, 0.64, -1.31], [-2.02, 0.71, -1.27], [-1.85, 0.80, -1.25], [-1.79, 0.97, -1.25]].map(p => new THREE.Vector3(...p));
  const root = taperTube(rootPts, 0.16, 0.125, 48, 9, [0.35, 0.62]);
  const rootM = add(bind(new THREE.Mesh(root.g, pineMat), 0.9, 0.7));
  const LINE_OBJS = [trunkM, branchAM, branchBM, rootM];
  for (const o of LINE_OBJS) o.userData.baseAlpha = o.userData.outlineAlpha;

  // —— 陆蔚的手（S4a，A12）——
  const A12 = tex.manifest.A12.锚点;
  const INKH = {
    pars: /* glsl */`uniform vec4 uInk; uniform vec2 uInkS; uniform float uInkA;`,
    body: /* glsl */`
      if (uInk.z > 0.) {
        vec2 p = (vPx - uInk.xy) / uInk.z;
        if (dot(p, p) < 7.5) {
          vec4 ik = bbInkSmudge(p, 1., uInkA, uInk.w, .55, uInkS.y);
          col = mix(col, ik.rgb, ik.a * uInkS.x);
        }
      }`,
  };
  const A12dir = Math.atan2(A12.wrist.px[1] - A12.index_tip.px[1], A12.wrist.px[0] - A12.index_tip.px[0]);
  const hand = makeSprite(tex.hand_side, { order: 14, frag: INKH, lineCol: '#2E2420', uniforms: { uInk: { value: new THREE.Vector4(A12.ink_index_A.px[0], A12.ink_index_A.px[1], A12.ink_index_A.r_px * 1.25, -18 * DEG) }, uInkS: { value: new THREE.Vector2(1, 0) }, uInkA: { value: A12dir } } });
  add(hand.group);
  // 袖子向右延伸到画外：把 crop 拉到图像右边以外，片元按最后一列内容取样（见 lib 的 uClampU）
  hand.crop.set(0, 0, 1.6, 1);
  hand.U.uClamp.value.set(1950 / 1968, 1);
  const HAND_PPM = 8900;

  // —— 每帧 ——
  function hideVar() {
    suns.forEach((s, i) => {   // 七日：S4d 会把第七日改成金日，这里每帧还原（render(t) 不依赖上一帧）
      s.visible = false; const U = s.material.uniforms;
      U.uCol.value.copy(lin(SUN_COL[i])); U.uRing.value.copy(lin(SUN_COL[i]).multiplyScalar(0.78)); U.uGold.value = 0; U.uHalo.value = 0; U.uA.value = 0;
    });
    for (const d of deer) d.group.visible = false;
    hand.group.visible = false; sit.group.visible = false; crouch.group.visible = true; lw.group.visible = true;
    clearDeform(crouch); clearDeform(sit); clearDeform(lw);
    crouch.U.uBlink.value = 0; crouch.U.uErase.value.z = 0; crouch.U.uSplash.value.set(0, 0, 0, 0);
    for (let i = 0; i < 18; i++) { crouch.U.uSpS.value[i].y = 1.35; sit.U.uSpS.value[i].y = 1.35; }
    sit.U.uErase.value.z = 0;
    skyMat.uniforms.uClear.value = 0;
    for (const r of ridges) { r.material.uniforms.uRimA.value = 0; r.material.uniforms.uRimW.value = 2.6; r.material.uniforms.uClear.value = 0; const b = r.userData.base; r.material.uniforms.uC.value.copy(b.col).multiplyScalar(0.93); r.material.uniforms.uCore.value.copy(b.col).multiplyScalar(0.82); r.material.uniforms.uEdge.value.copy(b.col).lerp(lin('#F0F2E4'), 0.35); }
    for (const m of [mist2, mist1, mistC, mistF]) { m.visible = true; m.material.uniforms.uSplit.value = 0; m.material.uniforms.uSink.value = 0; m.material.uniforms.uA.value = m.userData.m.A; }
    for (const v of veils) { v.visible = false; v.material.uniforms.uSplit.value = 0; v.material.uniforms.uSink.value = 0; }
    for (const o of LINE_OBJS) o.userData.outlineAlpha = o.userData.baseAlpha;
    plateMat.uniforms.uTint.value.set(1, 1, 1); plateMat.uniforms.uSat.value = 1; plateMat.uniforms.uFlatMoss.value = 0;
    ledge.visible = true; ledgeMat.uniforms.uTint.value.set(1, 1, 1);
    groundMat.uniforms.uWarm.value = 0; groundMat.uniforms.uOn.value = 0;
  }
  function common(t) {
    putScreen(sky, cam, 3000, 1.05);
    sky.renderOrder = -10;
    // 雾漂
    const drift = (m, v) => { m.material.uniforms.uDrift.value = v * FPX85 / m.userData.m.D * t; };
    drift(mist2, -0.05); drift(mist1, -0.08); drift(mistC, 0.10); drift(mistF, 0.12);
    crouch.U.uLeoT.value = t;
  }
  // 豹（S2–S4）：呼吸、尾 —— 一拍二（形变区：0 尾、1 耳、2 头颈；耳先转、再随头颈一起转）
  function leoIdle(sp, an, tc, fi) {
    const reg = an.regions;
    const br = reg['呼吸区'];
    sp.U.uBre.value.set(...br.rect_px); sp.U.uBreP.value.set(br.pivot_y_px ?? an.foot_pivot_px[1], 0.012 * Math.sin(tc / 2.2 * Math.PI * 2), br.feather_px);
    const tl = reg['尾区'];
    setRot(sp, 0, tl.pivot_px, 6 * DEG * Math.sin(tc / 3.2 * Math.PI * 2), tl.rect_px, tl.feather_px);
  }
  // 斑：湿墨斑 → 晕开 → 收紧 → 点亮（按 tc）
  // fix1：环 0 收紧放慢（f398–f420），点亮 f420–f426；其余 17 枚分 4 组（4/4/4/5）依次起（f430 / f436 / f442 / f448，组内相隔 1 帧），
  //       每枚 晕开 4 → 收紧 4 → 点亮 2 帧；最后一枚 f462 亮完，f462–f470 让完整的豹静 8 帧再切 S4d（story-05）
  const GROUP_START = [430, 436, 442, 448];
  const spotStart = j => { const g = j <= 4 ? 0 : j <= 8 ? 1 : j <= 12 ? 2 : 3; const first = [1, 5, 9, 13][g]; return GROUP_START[g] + (j - first); };
  function spotPhases(fc) {
    const ph = new Array(18).fill(-1);
    ph[0] = -9;
    if (fc >= 374) ph[0] = fc < 377 ? 0 : fc < 398 ? (fc - 377) / 21 : fc < 420 ? 1 + (fc - 398) / 22 : fc < 426 ? 2 + (fc - 420) / 6 : 3;
    for (let j = 1; j < 18; j++) {
      const s = spotStart(j);
      if (fc >= s) ph[j] = fc < s + 4 ? (fc - s) / 4 : fc < s + 8 ? 1 + (fc - s - 4) / 4 : fc < s + 10 ? 2 + (fc - s - 8) / 2 : 3;
    }
    return ph;
  }
  const _q = new THREE.Quaternion();
  const camS2 = f => {
    let x = 0.20, y = 0.56, z;
    if (f < 139) z = Math.exp(lerp(Math.log(13.0), Math.log(10.9), clamp((f - 116) / 23)));
    else if (f < 163) z = lerp(10.9, 9.8, eo((f - 139) / 24));
    else { const u = ss5((f - 163) / 97); z = 9.8; x = lerp(0.20, 0.45, u); y = lerp(0.56, 0.58, u); }
    cam.fov = 13.09; cam.updateProjectionMatrix();
    aimCamera(cam, new THREE.Vector3(x, y, z), 0, 0);
  };
  // S4 机位（fix1，main-02）：S4a 手的近景 C0 → 随墨滴下降、同时沿 A 的视线后拉到 d = 2.0 的中近景
  //   （豹背、肩、颈、耳、头都在画里，先交代"这是豹背"）→ S4b 晕开时推进到 d ≈ 1.0 的特写（耳朵留在右上角）
  //   → S4c 后拉到 d ≈ 2.75 的中景看一枚枚点亮。全程 P0 在 A（f374 起）。
  const offA = d => new THREE.Vector3(-(1188 - 960) / FPX50 * d, (592 - 520) / FPX50 * d, d);
  const C0 = P0.clone().add(offA(1.05)).add(new THREE.Vector3(0, 0.35, 0));
  const HAND_D = 0.6;
  const F0 = C0.clone().sub(offA(HAND_D));
  // w3（v3-02）：墨滴脱落那一刻（f359，机位还在 C0、手的一拍二抖动取 f2 = 358）指尖下缘接触点的屏幕位置——
  //   F0 正好投在 A，手精灵与像面平行，图像 1 px = FPX50 / (HAND_D · HAND_PPM) 屏幕 px；脱落后的墨滴路径从这里起算
  const C359 = (() => {
    const sH = FPX50 / (HAND_D * HAND_PPM), jit = (hashi(358) - 0.5) * 0.0008;
    return [1188 + jit * FPX50 / HAND_D + (A12.drop_spawn.px[0] - A12.ink_index_A.px[0]) * sH,
      592 - 0.5 * jit * FPX50 / HAND_D + (A12.drop_spawn.px[1] - A12.ink_index_A.px[1]) * sH];
  })();
  const dS4 = f => {
    if (f < 374) return 1.05 + 0.95 * ss(fseg(f, 360, 374));
    if (f < 430) return Math.exp(lerp(Math.log(2.0), Math.log(1.0), ss(fseg(f, 374, 404))) + lerp(0, Math.log(0.96), fseg(f, 404, 430)));
    return Math.exp(lerp(Math.log(0.96), Math.log(2.6), ss(fseg(f, 433, 449))) + lerp(0, Math.log(1.06), fseg(f, 449, 470)));
  };
  const camS4 = f => {
    cam.fov = 22.07; cam.updateProjectionMatrix();
    let pos;
    if (f < 360) pos = C0.clone();
    else { const u = clamp((f - 360) / 14); pos = P0.clone().add(offA(dS4(f))).add(new THREE.Vector3(0, f < 374 ? 0.35 * (1 - u * u) : 0, 0)); }
    aimCamera(cam, pos, 0, 0);
    return pos;
  };
  // 屏幕点（设计像素）
  const scr = p => { const s = project(cam, W, H, p); return [s.x / K, s.y / K, s.z]; };
  const spotWorld = (sp, i) => pxToWorld(sp, sp.leo.spots[i].px);
  const REG = A01.regions;

  const api = {
    scene, cam, P0,
    // ── S2 ──
    updateS2(t) {
      hideVar();
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1), tc = f2 / 24;
      camS2(f); common(t);
      for (const d of discs) d.material.uniforms.uFog.value = 0.12;
      // 七日
      for (let i = 0; i < 7; i++) {
        const st = 148 + 16 * i;
        if (f < st) continue;
        let u = ss((f - st) / 22), a = SUN_A[i];
        if (i === 6) { u = 0.45 * ss(clamp((f - st) / 14)); a *= 1 - seg(f, 250, 258); }
        else if (f > st + 22) continue;
        const [x, y] = qbez(SP0, SP1, SP2, u);
        suns[i].visible = a > 0.002; suns[i].material.uniforms.uA.value = a;
        sunAt(suns[i], x, y, 110);
      }
      // 谷雾逐日变浓
      mist2.material.uniforms.uA.value = lerp(0.60, 0.75, fseg(f, 150, 258));
      mist1.material.uniforms.uA.value = lerp(0.75, 0.85, fseg(f, 150, 258));
      // 金线化进远山：最远一道脊线金边 f139 前是金（门户里接住屏幕金线，宽度相同 5 px），f139–f170 收细并褪回雾色
      ridges[0].material.uniforms.uRimA.value = 1 - fseg(f, 139, 170);
      ridges[0].material.uniforms.uRimW.value = lerp(5.0, 2.6, fseg(f, 139, 150));
      ridges[0].material.uniforms.uRimC.value.copy(lin('#E2B93B')).lerp(lin('#E3EFEB'), fseg(f, 139, 170));
      // 鹿群（story-04 / story-11）：f165（6.88 s 强音）由右缘入画，向左走过人与豹之间的空当（位移只在偶数帧更新，两张走姿每 6 帧换）；
      //   f175（7.31 s）领头那只停步、仰头望崖，鹿群一起停 12 帧，再走
      if (f >= 160) {
        const walked = Math.max(Math.min(f2, 175) - 165, -6) + Math.max(0, f2 - 187);
        const stop = f2 >= 175 && f2 < 187;
        for (let i = 0; i < 5; i++) {
          const sp = deer[i];
          const x = 1960 - 11 * walked + i * 118, y = 642 + (i % 2) * 5;
          if (x > 2080 || x < 960) continue;
          const pose = stop ? 0 : Math.floor((f2 + i * 3) / 6) % 2;
          const P = DEER_POSE[pose];
          sp.crop.set(...P.crop);
          const D = DEER_D + (i % 2) * 1.5;
          const Pw = S2W(x, y, D);
          placeSprite(sp, Pw, Q0, P.pivot, 1 / (85 / 575 * D / FPX85));
          clearDeform(sp);
          if (stop && i === 0) { sp.U.uLean.value = -5 * DEG * ss(clamp((f2 - 175) / 4)) * (1 - ss(clamp((f2 - 183) / 4))); sp.U.uGlo.value.set(P.pivot[0], P.pivot[1], 1, 1); }
          sp.group.visible = true;
        }
      }
      // 陆蔚：静坐，肩部呼吸；f240 头微侧向豹 2°
      lw.group.visible = true;
      placeSprite(lw, LW_P, Q0, A07.bottom_pivot_px, LW_PPM);
      const lwr = A07.regions;
      lw.U.uBre.value.set(...lwr['肩部呼吸区'].rect_px); lw.U.uBreP.value.set(lwr['肩部呼吸区'].pivot_y_px, 0.006 * Math.sin(tc / 3 * Math.PI * 2), 60);
      setRot(lw, 0, lwr['头区'].pivot_px, -2 * DEG * ss(fseg(f2, 240, 248)), lwr['头区'].rect_px, 30);
      // 灰豹：f175 看见鹿——耳朵一抖、头朝鹿转 7°、眼睁着盯住；f199–f211 慢慢转回；f213–f227 慢慢闭眼（看见了也不动）
      crouch.group.visible = true;
      leoIdle(crouch, A01, tc, fi);
      const look = ss(fseg(f2, 175, 181)) * (1 - ss(fseg(f2, 199, 211)));
      setRot(crouch, 2, REG['头颈区'].pivot_px, 7 * DEG * look, REG['头颈区'].rect_px, REG['头颈区'].feather_px);
      const ear = (f2 >= 174 && f2 < 178) || (f2 >= 222 && f2 < 224);
      if (ear) setRot(crouch, 1, REG['耳区'].pivot_px, -12 * DEG, REG['耳区'].rect_px, REG['耳区'].feather_px);
      const blink = (b) => { const d = f2 - b; return d >= 0 && d < 4 ? [0.6, 1, 1, 0.5][d] : 0; };
      const close = f2 < 213 ? 0 : f2 < 217 ? (f2 - 213) / 4 : f2 < 223 ? 1 : f2 < 227 ? 1 - (f2 - 223) / 4 : 0;
      crouch.U.uBlink.value = Math.max(blink(238), close);
      setSpots(crouch, [-9, ...new Array(17).fill(-1)]);
      return { pan: (cam.position.x - 0.20) * FPX85, rain: 1, rainT: t, len: 1, near: 0 };
    },
    // ── S4a–c ──
    updateS4(t) {
      hideVar();
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1), tc = f2 / 24;
      const pos = camS4(f); common(t);
      for (const d of discs) d.material.uniforms.uFog.value = 0.10;
      groundMat.uniforms.uOn.value = 1;
      plateMat.uniforms.uFlatMoss.value = 1;
      ledge.visible = false;      // S4a–c 近景里崖面在画外（被平台地面挡住），不画
      for (let i = 0; i < 7; i++) suns[i].visible = false;
      crouch.group.visible = true;
      leoIdle(crouch, A01, tc, fi);
      // 斑
      setSpots(crouch, spotPhases(f2));
      for (let j = 1; j < 18; j++) crouch.U.uSpS.value[j].y = 1.12;     // 其余斑晕开上限 1.12R，相邻斑不叠成泥团（style-22）
      crouch.U.uSplash.value.set(f >= 374 ? 1 : 0, f >= 374 ? 1 - ss(fseg(f, 398, 414)) : 0, 0, 0);
      // 身色由灰变奶：以 P0 为圆心径向擦除（f432–f456 完成）
      if (f2 >= 432) crouch.U.uErase.value.set(A01.spots[0].px[0], A01.spots[0].px[1], 1.35 * BODY_L * ss(fseg(f2, 432, 456)), BODY_L);
      // f452 抬头（颈部 −6°）
      setRot(crouch, 2, REG['头颈区'].pivot_px, -6 * DEG * ss(fseg(f2, 452, 458)), REG['头颈区'].rect_px, REG['头颈区'].feather_px);
      // 陆蔚坐背
      // w3（v3-03）：原来 f >= 446 才显示，后拉中他在 f446 一帧里已有约 100 px 冒在右缘内；提前到 f440（那时还在右缘以外），随后拉自然滑进来
      lw.group.visible = f >= 439.5;
      placeSprite(lw, LW_P, Q0, A07.bottom_pivot_px, LW_PPM);
      // 手（S4a）：食指尖墨渍在 A；雨冲淡墨渍
      if (f < 374) {
        hand.group.visible = true;
        const jit = (hashi(f2) - 0.5) * 0.0008;
        // 墨滴脱落后手收回、往上出画（机位同时后拉，不然手会缩小留在画里、露出袖口的平头）
        const wd = ss(fseg(f2, 362, 372));
        const Ph = F0.clone().add(new THREE.Vector3(jit + 0.12 * wd, jit * 0.5 + 0.45 * wd, 0));
        placeSprite(hand, Ph, Q0, A12.ink_index_A.px, HAND_PPM);
        const wash = fseg(f, 351, 360);
        hand.U.uInkS.value.set(lerp(0.93, 0.50, wash) / 0.93, wash);
      }
      // 雨
      const slowA = 356 / 24, slowB = 374 / 24;
      const rainT = t < slowA ? t : t < slowB ? slowA + 0.15 * (t - slowA) : slowA + 0.15 * (slowB - slowA) + (t - slowB);
      const slow = f >= 356 && f < 374;
      return {
        pan: cam.position.x * FPX50, rain: (f < 374 ? 1 : 1 - seg(f, 430, 460)), rainT, len: slow ? 0.25 : (f < 374 ? 1.2 : 1), near: f < 374 ? 1 : 0, f, fi, f2,
        A: scr(P0), F: scr(F0), cam: pos, d: dS4(f),
      };
    },
    // ── S4d（f470 起）：同 S2 构图；雾带一层层从中线向两侧拉开（云头边）、下沉淡出；天转晴、第七日亮出 ──
    updateS4d(t) {
      hideVar();
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1), tc = f2 / 24;
      const u = ss5(fseg(f, 470, 496));
      cam.fov = 13.09; cam.updateProjectionMatrix();
      aimCamera(cam, new THREE.Vector3(lerp(0.45, 0.40, u), lerp(0.58, 0.62, u), lerp(9.80, 9.20, u)), 0, 0);
      common(t);
      for (const d of discs) d.material.uniforms.uFog.value = lerp(0.14, 0.04, ss(fseg(f, 470, 488)));
      groundMat.uniforms.uWarm.value = ss(fseg(f, 470, 488));
      // 天幕：雾色 → 晴空；远脊变清
      const cl = ss(fseg(f, 470, 490));
      skyMat.uniforms.uClear.value = cl;
      for (const r of ridges) {
        const b = r.userData.base, U = r.material.uniforms;
        const c2 = b.i === 5 ? lin('#6E8C7A') : (() => { const c = b.col.clone(); const hsl = {}; c.getHSL(hsl); c.setHSL(hsl.h, Math.min(1, hsl.s * 1.15 + 0.03), hsl.l * 0.97); return c; })();
        const cc = b.col.clone().lerp(c2, cl);
        U.uC.value.copy(cc).multiplyScalar(0.93); U.uCore.value.copy(cc).multiplyScalar(0.82); U.uEdge.value.copy(cc).lerp(lin('#EEF5F1'), 0.35 * (1 - cl * 0.5));
        U.uClear.value = cl;
      }
      plateMat.uniforms.uTint.value.set(lerp(1, 1.04, cl), lerp(1, 1.01, cl), lerp(1, 0.95, cl));
      ledgeMat.uniforms.uTint.value.copy(plateMat.uniforms.uTint.value);
      // 第七日：在 S2 被雾吞没的同一点亮出（金日 + 头光三环）
      const s7 = suns[6];
      s7.visible = true;
      const sat = ss(fseg(f, 474, 488));
      s7.material.uniforms.uCol.value.copy(lin('#D0CDCA')).lerp(lin('#EABA29'), sat);
      s7.material.uniforms.uRing.value.copy(lin('#D0CDCA').multiplyScalar(0.8)).lerp(lin('#D49232'), sat);
      s7.material.uniforms.uA.value = lerp(0.3, 1, sat); s7.material.uniforms.uGold.value = 1; s7.material.uniforms.uHalo.value = sat;
      sunAt(s7, 1626, 204, 150);
      // 雾散：三条雾带从中线向两侧拉开（各自速度不同）、下沉并淡出；前雾与崖后雾同样分开；谷雾下沉淡出
      const VA = [0.40, 0.52, 0.60];
      let fogK = 0;
      veils.forEach((v, k) => {
        const s0 = 470 + k * 2, op = eio(fseg(f, s0, s0 + 16));
        v.visible = op < 0.999;
        const U = v.material.uniforms;
        U.uSplit.value = lerp(0, 1500 + 200 * k, op); U.uSink.value = -50 * op; U.uA.value = VA[k] * (1 - ss(fseg(f, s0 + 6, s0 + 18)));
        U.uDrift.value = 0;
        fogK = Math.max(fogK, U.uA.value * (1 - op));
      });
      const op = eio(fseg(f, 470, 486));
      mistF.material.uniforms.uSplit.value = 1100 * op; mistC.material.uniforms.uSplit.value = 800 * op;
      mistF.material.uniforms.uA.value = 0.80 * (1 - 0.5 * op); mistC.material.uniforms.uA.value = 0.5 * (1 - 0.4 * op);
      const sk = fseg(f, 470, 488);
      mist1.material.uniforms.uSink.value = 40 * sk; mist2.material.uniforms.uSink.value = 40 * sk;
      mist1.material.uniforms.uA.value = 0.85 * (1 - sk); mist2.material.uniforms.uA.value = 0.75 * (1 - sk);
      // 被雾盖住的 3D 松干、巨石、长石：描线跟着雾的浓度淡掉（不再浮在雾面上，tech-07）
      for (const o of LINE_OBJS) o.userData.outlineAlpha = o.userData.baseAlpha * (1 - 0.95 * clamp(fogK / 0.6));
      // 豹：全身奶金 + 18 环斑；f484 预备压扁，f486 换坐姿
      // fix3（self-06）：f486 加一张"起身"中间张——坐姿图以足底为轴压扁到 0.80、横向 1.04、向前剪切 0.20（脚不动、头往前低）、
      //   头颈再低 8°：头先落在蹲姿与坐姿的中间（世界里约 (0.62, 0.71) m，蹲姿眼 (0.80, 0.35)、坐姿眼 (0.44, 0.88)），
      //   f488 坐直并拉长 104%，f490 回 100%——由一次硬跳拆成三步
      const useSit = f2 >= 486;
      const inb = f2 >= 486 && f2 < 488;
      const INB = { sx: 1.04, sy: 0.80, k: 0.20 };
      crouch.group.visible = !useSit; sit.group.visible = useSit;
      const L = useSit ? sit : crouch, an = useSit ? A02 : A01;
      L.U.uErase.value.set(an.spots[0].px[0], an.spots[0].px[1], 9000, 60); setSpots(L, new Array(18).fill(3));
      L.U.uLeoT.value = t;
      if (!useSit) {
        leoIdle(crouch, A01, tc, fi);
        setRot(crouch, 2, REG['头颈区'].pivot_px, -6 * DEG, REG['头颈区'].rect_px, REG['头颈区'].feather_px);
        if (f2 >= 484) crouch.U.uGlo.value.set(A01.foot_pivot_px[0], A01.foot_pivot_px[1], 1, 0.96);
      } else {
        const st = inb ? INB.sy : f2 < 490 ? 1.04 : 1;
        sit.U.uGlo.value.set(A02.foot_pivot_px[0], A02.foot_pivot_px[1], inb ? INB.sx : 1, st);
        sit.U.uShear.value.set(A02.foot_pivot_px[1], inb ? INB.k : 0);
        if (inb) { const hr = A02.regions['头颈区']; setRot(sit, 2, hr.pivot_px, 8 * DEG, hr.rect_px, hr.feather_px); }
        const br = A02.regions['呼吸区'];
        sit.U.uBre.value.set(...br.rect_px); sit.U.uBreP.value.set(br.pivot_y_px, 0.008 * Math.sin(tc / 2.2 * Math.PI * 2), br.feather_px);
      }
      // 陆蔚 f490 头微抬 2°
      placeSprite(lw, LW_P, Q0, A07.bottom_pivot_px, LW_PPM);
      setRot(lw, 0, A07.regions['头区'].pivot_px, -2 * DEG * ss(fseg(f2, 490, 496)) - 2 * DEG, A07.regions['头区'].rect_px, 30);
      // f478–f494：18 枚环斑按点亮顺序每 0.85 帧闪一次（雾散开后）
      const gl = [];
      for (let i = 0; i < 18; i++) {
        const fs = 478 + i * 0.85;
        if (f >= fs && f < fs + 2) {
          let px = L.leo.spots[i].px;
          if (inb) { const P = A02.foot_pivot_px, x1 = px[0] + (P[1] - px[1]) * INB.k; px = [P[0] + (x1 - P[0]) * INB.sx, P[1] + (px[1] - P[1]) * INB.sy]; }   // 中间张：闪点跟着剪切 / 压扁走
          gl.push([...scr(pxToWorld(L, px)).slice(0, 2), 18, 1 - (f - fs) / 2]);
        }
      }
      return { pan: 0, rain: 0, rainT: t, len: 1, near: 0, glints: gl };
    },
    // 叠加层：雨
    rain(ov, ci) {
      if (!ci || !(ci.rain > 0)) return;
      ov.U.uRain.value.set(ci.rain, ci.rainT, ci.len ?? 1, ci.near ?? 0);
      ov.U.uRainPan.value = ci.pan || 0;
      ov.U.uRainNearLen.value = ci.near ? 90 : 70;
    },
    // S4 叠加层：金环缩回、水珠 / 墨滴、皇冠溅、雨打水花、环 0 的闪
    fxS4(ov, ci) {
      api.rain(ov, ci);
      const f = ci.f, A = [1188, 592];
      if (f < 351.5) {
        // 金环：眼孔形 → 圆，屏幕中心 → A，半径 1100 → 指尖墨渍（对数），f348–f351 金 → 墨
        const u = clamp((f - 343) / 8);
        const e = ss(u);
        const Rend = A12.ink_index_A.r_px * 1.2 * 0.84 * FPX50 / (HAND_D * HAND_PPM);
        const R = Math.exp(lerp(Math.log(1100), Math.log(Rend), 1 - Math.pow(1 - u, 2.2)));
        ov.U.uRingA.value.set(lerp(960, A[0], e), lerp(520, A[1], e), R, e);
        ov.U.uRingB.value.set(6, 1 - ss(fseg(f, 350, 352)), fseg(f, 348, 351));
      }
      // 雨打手背：f352、f355、f358 三处小溅
      if (f >= 352 && f < 362) {
        const hs = [[352, 1380, 560], [355, 1520, 548], [358, 1290, 575]];
        let k = 0;
        for (const [fh, x, y] of hs) { const pr = (f - fh) / 4; if (pr > 0 && pr < 1 && k < 6) ov.U.uHit.value[k++].set(x, y, pr, 9); }
      }
      // 墨滴（story-17 → w3 v3-02 / qa2-04）：
      //   f351–f359 挂在指尖下缘（接触点 C = A12 的 drop_spawn，按手精灵当帧的实际位置投影）长大，尖顶藏进指尖、按手的 alpha 遮掉；
      //   f359–f362 往下坠、拉长，和指尖之间连一道"颈"（中段最细、两端略粗）；f362 手跟着机位上收的同一帧颈断开，
      //   上下两截各用 2 帧缩回（上截缩回指尖、下截缩回墨滴），不留悬空短线；
      //   f362–f374 墨滴自由下落（镜头随降），从挂着的位置平滑移到落点 A，半径 13 → 15 px（拉到中景后不再显小）；
      //   f374 落背那一帧压扁成一摊，f374–f377 一圈深色冲击环往外一冲，皇冠溅放大到 1.2 倍以上
      if (f >= 351 && f < 374.5) {
        // 手只在 f < 374 时摆（updateS4）；f374 起不读它的矩阵（不然就依赖上一次渲染的状态）
        const handOn = f < 374;
        let C = C359;
        if (handOn) {
          hand.group.updateMatrixWorld(true);
          C = scr(pxToWorld(hand, A12.drop_spawn.px));
          const S0 = scr(pxToWorld(hand, [0, 0])), Sx = scr(pxToWorld(hand, [1000, 0])), Sy = scr(pxToWorld(hand, [0, 600]));
          ov.U.uHandTex.value = tex.hand_side; ov.U.uHandOn.value = 1;
          ov.U.uHandMap.value.set(S0[0], S0[1], 1000 / (Sx[0] - S0[0]), 600 / (Sy[1] - S0[1]));
        }
        const grow = eo(fseg(f, 351, 359));
        const r0 = 13 * Math.max(grow, 0.05);
        const hang = (cx, cy, r) => [cx, cy + 1.6 * r - 0.30 * r];          // 挂着：尖顶往指尖里藏 0.3 r
        let Dc, r = r0, stretch = 1;
        if (f < 359) Dc = hang(C[0], C[1], r0);
        else {
          // 脱落后的路径：f359 的挂点 → 落点（墨滴底贴着 A），平滑过渡；f359–f362 先往下坠一点（拉出颈）
          const H0p = hang(C359[0], C359[1], 13);
          const r1 = lerp(13, 15, ss(fseg(f, 362, 373)));
          r = r1;
          const land = [A[0], A[1] - r1 * 0.85];
          const e = ss(fseg(f, 361, 374));
          const sag = 10 * Math.sin(Math.PI * clamp((f - 359) / 6)) * (1 - e);
          Dc = [lerp(H0p[0], land[0], e), lerp(H0p[1], land[1], e) + sag];
          stretch = f < 362 ? lerp(1, 1.25, ss(fseg(f, 359, 361))) : lerp(1.25, 1, ss(fseg(f, 362, 364)));
        }
        // 落背那一帧（f374）：压扁成一摊（宽 1.35 倍、高 0.45 倍），底边仍在 A
        if (f >= 373.5) { r = 15 * 1.35; stretch = 0.45; Dc = [A[0], A[1] - r * stretch * 0.9]; }
        ov.U.uDrop.value.set(Dc[0], Dc[1], r, 1);
        ov.U.uDropB.value.set(stretch, 0.9, f >= 373.5 ? 0 : 1);       // 压扁那一帧不要高光点（不然一圈墨环 + 墨摊 + 白点读成一只眼）
        ov.U.uDropT.value.set(0, 0);
        // 颈：墨滴顶（稍微伸进墨滴里）→ 指尖接触点（稍微伸进指尖里，靠手的 alpha 遮掉）。
        //   断开按整帧号判（f362 断、f363 缩一半、f364 没了），不用连续 f 和整数比——整帧时刻 i/24 乘回去会差 1e-5 帧
        const fiD = Math.round(f);
        if (f >= 359.3 && fiD <= 363) {
          const top = [Dc[0], Dc[1] - 1.6 * r * stretch + 3];
          const tip = [C[0], C[1] - 3];
          const conn = ss(fseg(f, 359.3, 360));
          ov.U.uNeckA.value.set(top[0], top[1], tip[0], tip[1]);
          ov.U.uNeckB.value.set(3.2, 2.6, lerp(2.4, 1.1, ss(fseg(f, 359.5, 361.5))), conn);
          if (fiD >= 362) {
            const k = fiD === 362 ? 1 : 0.45;
            ov.U.uNeckC.value.set(0.40 * k, 0.30 * k, 1);      // 上截（挂在指尖上）、下截（墨滴顶）各自缩回
          }
        }
      }
      // 皇冠溅（f374–f380）：w3（qa2-04）放大到 1.2 倍以上（原来按机位远近缩到 0.75，溅点只有 4–6 px）
      if (f >= 374 && f < 380) ov.U.uCrown.value.set(A[0], A[1], (f - 374) / 6, clamp(2.4 / ci.d, 1.2, 1.45));
      // 落背冲击环（只在 f374 一帧）：深色、线宽起伏、偶有断口，和压扁的墨摊一起交代"落上去了"，下一帧交给皇冠溅
      if (f >= 373.5 && f < 374.5) ov.U.uImpact.value.set(A[0], A[1] - 2, 22, 0.88), ov.U.uImpactW.value = 2.8;
      // 雨打豹背：环附近每 6 帧一个水花
      if (f >= 380 && f < 462) {
        const n = Math.floor(f / 6), pr = (f - n * 6) / 2;
        if (pr < 1) { const R = mulberry(n * 13 + 5); ov.U.uHit.value[0].set(A[0] + (R() - 0.5) * 520, A[1] + (R() - 0.5) * 300, pr, 4); }
      }
      // 环 0 点亮后的一粒白色小闪（f426–f428）
      if (f >= 426 && f < 428) ov.glint(A[0], A[1], 40, 1 - (f - 426) / 2);
      // S4c 其余 17 枚点亮时各自小闪
      for (let j = 1; j < 18; j++) {
        const s = spotStart(j) + 10;
        if (f >= s && f < s + 2) { const p = scr(spotWorld(crouch, j)); ov.glint(p[0], p[1], 14, 0.8 * (1 - (f - s) / 2)); }
      }
    },
    fxS4d(ov, ci) {
      api.rain(ov, ci);
      for (const g of ci.glints || []) ov.glint(...g);
    },
  };
  return api;
}
