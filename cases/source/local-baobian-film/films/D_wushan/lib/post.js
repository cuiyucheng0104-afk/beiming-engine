// 《豹变》D 雾山 · look 之后的两道合成
//   ① 镜头后期 shotPost：雨（三层、读场景深度做遮挡）、溅水、光束 + 浮尘、上帝光、近视虚焦 + 镜片圈、角落湿墨光 / 金色预兆
//   ② 总合成 final：两个镜头的转场（墨甩划像 / 眼孔 / 洇墨化开）、星芒 G、纸纤维闪、题字（逐字洇出）、
//      2D 叠加层（Canvas：墨甩笔身、墨滴、鹤……）、淡入淡出
// 所有屏幕空间量都按 K = H/1040 缩放（坐标先换成设计像素再算）。
import * as THREE from 'three';
import { GLSL, VS_FS } from './glsl.js';
import { srgb3 } from './util.js';

const DESIGN = /* glsl */`
uniform vec2 uRes; uniform float uK;
vec2 dpx(){ return vec2((gl_FragCoord.x - uRes.x * .5) / uK + 960., (uRes.y - gl_FragCoord.y) / uK); }   // 设计像素（y 向下）
`;

const POST_FS = /* glsl */`
#include <packing>
${GLSL}
${DESIGN}
uniform sampler2D tColor, tDepth;
uniform float uNear, uFar;
// 雨
uniform float uRain, uRainT, uRainTilt, uRainLen, uRainA, uRainW;
uniform vec3 uRainD;
uniform float uSplash, uSplashT, uSplashNear;
// 光束、浮尘
uniform float uBeam, uDust, uDustT, uDustAll; uniform vec2 uDustPar; uniform vec3 uBeamCol;
uniform float uBeamAng; uniform vec2 uBeamO; uniform float uCold;
// 上帝光
uniform float uGod; uniform vec2 uGodPos; uniform vec3 uGodCol; uniform float uGodThr;
// 近视虚焦 + 镜片圈
uniform float uMyo; uniform vec4 uLens; uniform float uLensA;
// 角落：左上湿墨光、右侧金色预兆
uniform float uWetInk, uGoldOmen;
// 整体
uniform float uExpo; uniform vec3 uMul; uniform vec2 uMBlur; uniform float uWhite; uniform vec3 uWhiteC;
varying vec2 vUv;

float viewZ(vec2 uv){ float d = texture2D(tDepth, uv).x; return d >= .9999999 ? 1e6 : -perspectiveDepthToViewZ(d, uNear, uFar); }

// 一层雨：p 设计像素
float rainLayer(vec2 p, float len, float wid, float spd, float seed, float dens){
  float tl = tan(uRainTilt);
  vec2 q = vec2(p.x + p.y * tl, p.y);
  float colW = 22.;
  float ci = floor(q.x / colW);
  float hc = hI1(int(ci), uint(seed));
  if (hc > dens) return 0.;
  float period = len * (2.6 + 5.5 * hI1(int(ci), uint(seed) + 7u));
  float ph = hI1(int(ci), uint(seed) + 3u) * period;
  float y = q.y - uRainT * spd - ph;
  float k = floor(y / period);
  float ly = y - k * period;                       // 0..period，ly < len 在雨丝里（头在下）
  float jx = hI(ivec2(int(ci), int(k)), uint(seed) + 11u);
  float x0 = ci * colW + 2. + jx * (colW - 4.);
  float dxp = abs(q.x - x0);
  float w = wid * .5;
  float across = 1. - smoothstep(w * .4, w + .6, dxp);
  float along = smoothstep(0., len * .25, ly) * (1. - smoothstep(len * .8, len, ly));
  float on = step(ly, len);
  float br = .55 + .45 * hI(ivec2(int(ci), int(k)), uint(seed) + 19u);
  return across * along * on * br;
}

void main(){
  vec2 p = dpx();
  vec3 c = texture2D(tColor, vUv).rgb;
  // 甩镜的方向模糊（设计像素）
  if (length(uMBlur) > .5) {
    // 32 采样，起始偏移按像素哈希抖动（不出一级级的台阶）
    float jit = hash12(floor(gl_FragCoord.xy)) - .5;
    vec3 acc = vec3(0.); for (int i = 0; i < 32; i++) { float k = ((float(i) + .5 + jit) / 32. - .5); acc += texture2D(tColor, vUv + vec2(uMBlur.x, -uMBlur.y) * k * uK / uRes).rgb; }
    c = acc / 32.;
  }
  float z = viewZ(vUv);
  // 近视虚焦：圈外糊、压暗 10%
  if (uMyo > 0.) {
    vec2 d = p - uLens.xy;
    float inside = 1. - smoothstep(uLens.z - 30., uLens.z + 30., length(d));
    float amt = uMyo * (1. - inside);
    if (amt > .001) {
      vec3 b = vec3(0.); float tw = 0.;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.39996; float r = (float(i) + .5) / 12.;
        vec2 o = vec2(cos(a), sin(a)) * sqrt(r) * 6. * uK / uRes;
        b += texture2D(tColor, vUv + o).rgb; tw += 1.;
      }
      c = mix(c, b / tw * .9, amt);
    }
  }
  // 镜片圈（look 之后，暗金 + 高光，糊边）
  if (uLensA > 0.) {
    float r = length(p - uLens.xy);
    float band = 1. - smoothstep(0., uLens.w * .5 + 18., abs(r - uLens.z));
    float hl = 1. - smoothstep(0., uLens.w * .18 + 6., abs(r - uLens.z + uLens.w * .2));
    c = mix(c, vec3(.42, .29, .13) * .55, band * uLensA * .9);
    c += vec3(.79, .64, .29) * hl * uLensA * .5;
  }
  // 上帝光：从太阳屏幕位置 16 采样径向模糊（阈值后的亮度），加色
  if (uGod > 0.) {
    vec2 sp = vec2((uGodPos.x - 960.) * uK + uRes.x * .5, uRes.y - uGodPos.y * uK) / uRes;
    vec2 dv = (vUv - sp);
    vec3 acc = vec3(0.); float wsum = 0.;
    for (int i = 0; i < 16; i++) {
      float t = float(i) / 16.;
      vec2 uv = vUv - dv * t * .72;
      vec3 s = texture2D(tColor, uv).rgb;
      float l = lumS(s);
      float zz = viewZ(uv);
      float m = smoothstep(uGodThr, uGodThr + .12, l) * step(800., zz);
      acc += m * (1. - t); wsum += 1. - t;
    }
    float fall = exp(-length(dv * vec2(uRes.x / uRes.y, 1.)) * 1.6);
    c += uGodCol * (acc / wsum) * uGod * fall;
  }
  // 光束（左上斜下）+ 浮尘
  float beam = 0.;
  if (uBeam > 0. || uDust > 0.) {
    vec2 dir = vec2(cos(uBeamAng), sin(uBeamAng));      // 光的走向（设计像素，y 向下）
    vec2 nrm = vec2(-dir.y, dir.x);
    float sx = dot(p - uBeamO, nrm), sy = dot(p - uBeamO, dir);
    float b = 0.;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float cen = -260. + fi * 230. + 40. * sin(fi * 2.1);
      float hw = 45. + 85. * hI1(i, 5u);
      float s = 1. - smoothstep(hw * .55, hw, abs(sx - cen));
      float brk = .55 + .45 * fbm3o(vec2(sy * .004 + fi * 3.1, sx * .002));
      b += s * brk * (.12 + .10 * hI1(i, 9u));
    }
    beam = b;
    // 返修 2（style-20）：暖光冷影——窗光光束以外、离画面中心远的地方（桌面远端、书沟外、画边）压成冷暗（#1B2420 一族，乘法约 0.6）
    if (uCold > 0.) { float sh = (1. - smoothstep(.02, .16, b)) * smoothstep(.2, .95, length((p - vec2(980., 640.)) / vec2(1050., 640.)));
      c *= mix(vec3(1.), vec3(.56, .64, .66), sh * uCold); }
    c += uBeamCol * b * uBeam;
    if (uDust > 0.) {
      float dsum = 0.;
      for (int L = 0; L < 3; L++) {
        float fl = float(L);
        float cell = 64. - fl * 12.;
        vec2 q = p + uDustPar * (.5 + fl * .55) + vec2(10. * sin(uDustT * .7 + fl), uDustT * 6. * (1. + fl * .3));
        vec2 gi = floor(q / cell);
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          ivec2 g = ivec2(gi) + ivec2(i, j);
          float h0 = hI(g, uint(31 + L));
          if (h0 > .38) continue;
          vec2 cp = (vec2(g) + vec2(hI(g, uint(41 + L)), hI(g, uint(51 + L)))) * cell;
          cp.x += 6. * sin(uDustT * (.9 + h0) + h0 * 30.);
          float rad = 1.5 + 3.5 * pow(hI(g, uint(61 + L)), 2.2);
          float dd = length(q - cp);
          dsum += (1. - smoothstep(rad * .45, rad, dd)) * (.5 + .5 * h0 * 2.6);
        }
      }
      c += vec3(1., .906, .69) * dsum * .6 * uDust * max(smoothstep(.04, .2, beam), uDustAll * smoothstep(25., 90., viewZ(vUv)) * smoothstep(.42, .62, dot(c, vec3(.2126, .7152, .0722))));   // 返修 4（v3-10）：浮尘只浮在亮的金雾、辉光里（场景亮度 ≥ 0.45），暗天上不落   // 返修 3：uDustAll = 1 时浮尘不限在光束里，只浮在远处的金雾前（#13），近处暗岩上不落
    }
  }
  // 角落预兆
  if (uWetInk > 0.) { float m = 1. - smoothstep(0., 160., p.y + p.x * .15); c = mix(c, vec3(.03, .045, .045), m * uWetInk * .6); }
  if (uGoldOmen > 0.) { float m = smoothstep(1200., 1920., p.x) * (1. - smoothstep(250., 900., abs(p.y - 560.))); c = mix(c, vec3(.902, .663, .29), m * uGoldOmen * .12 * 6.); }
  // 雨：三层，只画在比该层名义深度更远的像素上
  if (uRain > 0.) {
    float r = 0.;
    r += rainLayer(p, 26. * uRainLen, 1.0 * uRainW, 1100., 101., .55 * uRain) * .16 * step(uRainD.z, z);
    r += rainLayer(p, 48. * uRainLen, 1.3 * uRainW, 1700., 202., .42 * uRain) * .22 * step(uRainD.y, z);
    r += rainLayer(p, 80. * uRainLen, 1.8 * uRainW, 2600., 303., .30 * uRain) * .30 * step(uRainD.x, z);
    r *= uRainA;
    c = mix(c, vec3(.863, .902, .882), clamp(r, 0., 1.));
  }
  // 溅水：2 帧小水冠，落在平台、手背、豹背上
  if (uSplash > 0.) {
    float cell = 90.;
    vec2 gi = floor(p / cell);
    float slot = floor(uSplashT * 12.);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      ivec2 g = ivec2(gi) + ivec2(i, j);
      float h = hI(g + ivec2(int(slot) * 7, 0), 77u);
      if (h > uSplash) continue;
      vec2 cp = (vec2(g) + vec2(hI(g + ivec2(int(slot), 3), 78u), hI(g + ivec2(3, int(slot)), 79u))) * cell;
      vec2 cuv = vec2(((cp.x - 960.) * uK + uRes.x * .5) / uRes.x, 1. - cp.y * uK / uRes.y);
      float zz = viewZ(cuv);
      if (zz > 60. || zz < uSplashNear) continue;              // 洞口暗拱（离镜头 0.5–2 m）上不溅水
      vec2 d = p - cp; float s = 3. + 3. * h / max(uSplash, 1e-3);
      float ang = atan(-d.y, d.x);
      float rr = length(d);
      float spokes = pow(max(cos(ang * 2.5 + 1.), 0.), 6.) * step(0., -d.y + 1.);
      float crown = spokes * (1. - smoothstep(s * .3, s, abs(rr - s * .9))) + (1. - smoothstep(.0, 1.6, rr)) * .8;
      c = mix(c, vec3(.86, .9, .88), clamp(crown, 0., 1.) * .55);
    }
  }
  c = c * uMul * uExpo;
  if (uWhite > 0.) c = mix(c, uWhiteC * (.96 + .08 * fbm2(p * .004)), uWhite);
  gl_FragColor = vec4(c, 1.);
}`;

const FINAL_FS = /* glsl */`
${GLSL}
${DESIGN}
uniform sampler2D tA, tB, tOv, tTxt, tLeo;
uniform float uMode, uOvOn, uLeoM;
// 墨甩划像
uniform vec4 uWipe;     // 起点 xy, 方向角, 笔头进度（沿方向的设计像素）
uniform vec4 uWipe2;    // 笔头速度（px/帧）, 初始半宽, 外扩速度（px/帧）, 边缘噪声
uniform float uWipeSpd, uWipeAll, uInkAng, uWipeTR; uniform vec3 uInk;
uniform float uOvDiss, uBorder;
uniform vec4 uTrail[48]; uniform vec2 uTrailB[48]; uniform float uTrailN;
// 眼孔
uniform vec4 uHole;     // 中心 xy（设计像素）, 半长, 半宽
uniform float uHoleTilt, uHoleOn, uHoleRim;
// 化开
uniform float uTau;
// 星芒
uniform vec3 uStar;     // 位置 xy, 包络
uniform float uStarS, uStarGlow; uniform vec3 uStarCore, uStarHalo, uStarRing;
// 纤维闪
uniform float uFiber;
// 五爻横带（返修 3，T1）：y 中心, 粗, 不透明度, 金（设计像素）
uniform vec4 uYao[5]; uniform float uYaoOn, uYaoT, uYaoX1; uniform vec2 uYaoGap;   // 六二的断口：中心 x、半宽
// 淡入淡出
uniform float uFadeBlack, uFadePaper, uExpo;
// 题字
uniform vec4 uChar[8];  // 中心 x, 顶 y, 字号, 显出进度
uniform float uCharBlur[8];
uniform float uTxtOn, uTxtA, uGlowOn;
varying vec2 vUv;

vec3 paperTex(vec2 p){
  float f1 = vnoise2(vec2(p.x * .35, p.y * .02)) , f2 = vnoise2(vec2(p.x * 1.4, p.y * .09) + 11.), f3 = vnoise2(p * .6 + 3.);
  float v = .5 + .22 * (f1 - .5) + .16 * (f2 - .5) + .10 * (f3 - .5) + .06 * (hash12(floor(p)) - .5);
  return vec3(v);
}
float almond(vec2 p){
  vec2 d = p - uHole.xy; float ct = cos(uHoleTilt), st = sin(uHoleTilt);
  d = vec2(ct * d.x + st * d.y, -st * d.x + ct * d.y);
  float x = d.x / uHole.z, y = d.y / uHole.w;
  if (abs(x) >= 1.) return length(vec2((abs(x) - 1.) * uHole.z, y * uHole.w));   // 两个尖角之外：到尖的距离
  float lim = pow(1. - x * x, .75);
  return (abs(y) - lim) * uHole.w;   // 有符号距离（近似，设计像素）
}
void main(){
  vec2 p = dpx();
  vec3 a = texture2D(tA, vUv).rgb;
  vec3 c = a;
  if (uMode > .5 && uMode < 1.5) {
    // 墨甩：笔头扫过之后，新场景从墨里长出来（从笔路往外洇开，约 4 帧铺满）
    vec2 dir = vec2(cos(uWipe.z), sin(uWipe.z));
    vec2 dp = p - uWipe.xy;
    float s = dot(dp, dir), dist = abs(dp.x * dir.y - dp.y * dir.x);
    float passed = uWipe.w - s;
    float since = passed / max(uWipe2.x, 1.);
    vec3 b = texture2D(tB, vUv).rgb;
    float tint = exp(-max(since, 0.) / 3.);
    b = mix(b, uInk, tint * .85);
    float reach = uWipe2.y + max(since, 0.) * uWipe2.z;
    float nn = (fbm2(p * .006) - .5) * uWipe2.w + (fbm2(p * .03) - .5) * uWipe2.w * .35;
    float m = step(0., passed) * (1. - smoothstep(reach - 40., reach + 40., dist + nn));
    // 兜底：f262–f266 剩下离笔路最远的角落（右上角）也按噪声边洇满，f265 前整屏都是集市
    float nn2 = fbm2(p * .0045 + 3.);
    m = max(m, 1. - smoothstep(uWipeAll * 1.25 - .15, uWipeAll * 1.25, nn2));
    // 返修 2（tech-09）：右上角离笔路最远，f256–f259 从画角往里洇一块集市（噪声边），笔画完时右上角已经不是 #04 的天了
    float trd = length((p - vec2(1920., 0.)) / vec2(820., 560.)) + (nn2 - .5) * .45;
    m = max(m, 1. - smoothstep(uWipeTR - .08, uWipeTR + .08, trd));
    c = mix(a, b, m);
  } else if (uMode > 1.5 && uMode < 2.5) {
    vec3 b = texture2D(tB, vUv).rgb;
    float sd = almond(p);
    float m = 1. - smoothstep(-1.2, 1.2, sd);
    c = mix(a, b, m * uHoleOn);
    // 眼孔边：金线 + 内侧暗线
    float g = 1. - smoothstep(0., 2.2, abs(sd - 1.5));
    float dk = 1. - smoothstep(0., 1.6, abs(sd + 1.2));
    c = mix(c, vec3(.949, .784, .376), g * uHoleRim);
    c = mix(c, vec3(.086, .043, .008), dk * uHoleRim * .8);
  } else if (uMode > 2.5) {
    // 洇墨化开：n < τ 显示长卷。斑块大、少、边柔；自右向左推进（手卷的读法）；边带是暖墨色、压暗 25%，沿梯度洇开
    float n = .6 * (.65 * fbm2(p * .0022) + .35 * fbm2(p * .009)) + .4 * (1. - p.x / 1920.);
    float e = 3.;
    float nx = .6 * (.65 * fbm2((p + vec2(e, 0.)) * .0022) + .35 * fbm2((p + vec2(e, 0.)) * .009)) + .4 * (1. - (p.x + e) / 1920.);
    float ny = .6 * (.65 * fbm2((p + vec2(0., e)) * .0022) + .35 * fbm2((p + vec2(0., e)) * .009)) + .4 * (1. - p.x / 1920.);
    vec2 gdir = normalize(vec2(nx - n, ny - n) + 1e-6);
    float band = 1. - smoothstep(0., .022, abs(n - uTau));          // 洇开的边：一道窄的潮线（不是一大片烟）
    float leo = uLeoM > .5 ? texture2D(tLeo, vUv).a : 0.;
    vec2 push = vec2(gdir.x, -gdir.y) * 6. * uK / uRes * band * smoothstep(0., .03, uTau - n + .03) * (1. - leo);
    vec3 a2 = texture2D(tA, vUv + push).rgb;
    vec3 b = texture2D(tB, vUv).rgb;
    float m = 1. - smoothstep(uTau - .012, uTau + .012, n);
    c = mix(a2, b, m);
    // 返修 4（v3-09）：潮线只压在山上（画面里有色、偏暗的地方），天上（接近卷纸色的亮处）只留极淡一线，不再是灰褐脏斑
    float onPaper = smoothstep(.62, .78, dot(c, vec3(.2126, .7152, .0722))) * (1. - smoothstep(.05, .14, max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b))));
    c = mix(c, c * vec3(.8, .78, .74) + vec3(.227, .196, .149) * .05, band * (1. - leo) * (1. - .85 * onPaper));
    c = mix(c, a, leo);         // 豹不参与化开：豹身上没有墨影、没有双轮廓
  }
  // 纤维闪（T1 换景）：有纹理的暖白
  if (uFiber > 0.) {
    float f1 = vnoise2(vec2(p.x * .012, p.y * .18)), f2 = vnoise2(vec2(p.x * .05, p.y * .6) + 7.), f3 = vnoise2(p * .03 + 2.);
    vec3 pc = vec3(.89, .835, .72) * (.82 + .22 * f1 + .12 * f2 + .1 * f3);
    c = mix(c, pc, uFiber);
  }
  // 五爻横带（T1）：奶白的撕边云带，上沿一线金，中线残留一线墨芯；六二中间断开。跨过纤维闪的切点
  if (uYaoOn > 0.) {
    for (int k = 0; k < 5; k++) {
      vec4 b = uYao[k]; if (b.z <= .001) continue;
      float fk = float(k), th = b.y;
      // 云带：中线低频起伏，上沿利（干笔撕边）、下沿软（化开），横向几处断续变薄（ref_07 的云带）
      float wob = (vnoise2(vec2(p.x * .0028 + fk * 3.1, uYaoT * .3 + fk)) - .5) * th * .9;
      float thin = .72 + .5 * vnoise2(vec2(p.x * .006 + fk * 5.3, 2.));
      float tornT = ((vnoise2(vec2(p.x * .028, fk * 7.3)) - .5) * .34 + (vnoise2(vec2(p.x * .075, fk * 2.1)) - .5) * .08) * th;
      float dy = p.y - (b.x + wob);
      float hT = th * .5 * thin;
      float top = -hT + tornT, bot = hT * 1.1;
      float body = smoothstep(top - 1.2, top + 1.8, dy) * (1. - smoothstep(bot * .35, bot, dy));
      body *= smoothstep(-160., 60., p.x) * (1. - smoothstep(uYaoX1 - 220., uYaoX1, p.x));   // 拉平时右端收在近崖之前（横带在远处，不压到近处的崖面上）
      if (k == 1) { float gx = abs(p.x - uYaoGap.x) - uYaoGap.y * (1. + .3 * (vnoise2(vec2(p.y * .06, 3.)) - .5)); body *= smoothstep(-10., 10., gx); }
      body *= b.z;
      float yr = (dy - top) / max(bot - top, 1.);                       // 0 = 上沿，1 = 下沿
      float goldUp = (1. - smoothstep(.12, .42, yr)) * body;          // 上沿约三成是金（和书页上浮起的那一画同一个配色）
      float core = (1. - smoothstep(0., 3.5, abs(yr - .55) * (bot - top))) * body * .14;
      c = mix(c, vec3(.953, .925, .855), body * .9);
      c = mix(c, vec3(.94, .70, .24), clamp(goldUp * (.62 + .3 * b.w) + body * b.w * .4, 0., 1.));
      c = mix(c, vec3(.16, .14, .12), core * (1. - b.w));
    }
  }
  // 题字背后的柔光
  if (uGlowOn > 0.) {
    vec2 d = (p - vec2(1610., 240.)) / vec2(230., 270.);
    float m = (1. - smoothstep(.55, 1., length(d))) * uGlowOn;
    if (m > .001) {
      vec3 bl = vec3(0.);
      for (int i = 0; i < 12; i++) { float an = float(i) * 2.39996; float r = sqrt((float(i) + .5) / 12.); bl += texture2D(tA, vUv + vec2(cos(an), sin(an)) * r * 14. * uK / uRes).rgb; }
      bl /= 12.;
      c = mix(c, min(bl * 1.15, vec3(1.)), m);
    }
  }
  c *= uExpo;
  // 尾迹：豹斑墨点的弧线（母题，同一个 rosette；刚落时带金光）
  if (uTrailN > 0.) {
    for (int i = 0; i < 48; i++) {
      if (float(i) >= uTrailN) break;
      vec4 tr = uTrail[i]; vec2 tb = uTrailB[i];
      vec2 q = (p - tr.xy) / tr.z;
      if (dot(q, q) > 2.) continue;
      float aa = 1. / tr.z;
      // 返修 3（v2-09 / story-18）：尾迹大斑不再是线条利落的 C 形图标环——湿墨洇开的软边（crisp 0.55）、轮廓更不正，外面一圈很淡的洇晕
      // 返修 4（qa2-14 / story-18）：湿墨环斑——环宽收到 0.35、墨量 0.75、软一点（crisp 0.45），环心 = 背景 × 0.9（去掉土黄心），外圈一道淡洇晕
      vec2 r = tb.y > .5 ? rosette(q, tr.w, .6, 0., 0., .5, .3, aa) : rosette(q, tr.w, .45, 1., 3. + mod(tr.w, 3.), .35, .3, aa + .04);
      float halo = (1. - smoothstep(.8, 1.4, length(q) * (1. + .25 * (vnoise2(q * 2.3 + tr.w) - .5)))) * (1. - r.x) * step(tb.y, .5);
      c = mix(c, c * vec3(.78, .82, .84), halo * .25);
      // 返修 3（v2-09）：金光只沿环的外缘走一线（不再整枚是金环）
      float rim = smoothstep(.74, .93, length(q)) * (1. - step(.5, tb.y) * .6);
      vec3 ink = mix(vec3(.118, .141, .149), vec3(.95, .80, .42), tb.x * rim);
      c = mix(c, ink, r.x * .75);
      c = mix(c, c * .9, r.y * (1. - r.x) * step(tb.y, .5));
    }
  }
  // 裱边（#15）：上下各 52·K，绫面 + 极淡织纹，内沿 2·K 金线
  if (uBorder > 0.) {
    float hgt = 52. * uBorder;
    float yb = min(p.y, 1040. - p.y);
    float weave = .94 + .06 * (vnoise2(p * vec2(.7, .2)) * .5 + vnoise2(p * vec2(.2, .8)) * .5);
    // 绫面织锦纹：回纹一样的方折（对比约 7%）
    vec2 gq = fract(p / 26.) - .5; float meander = step(.3, max(abs(gq.x), abs(gq.y))) * step(max(abs(gq.x), abs(gq.y)), .42) + step(abs(gq.x), .06) * step(abs(gq.y), .3);
    vec3 silk = vec3(.133, .204, .227) * weave * (1. + .07 * meander);
    // 画心边缘一点不齐 + 一线投影；绫和画心之间一条 6·K 的浅色隔水
    float edgeJ = (vnoise2(vec2(p.x * .05, step(520., p.y))) - .5) * 1.6;
    float hb = hgt - 6. * uBorder + edgeJ;
    float inB = 1. - smoothstep(hb - .8, hb + .8, yb);
    float sep = (1. - smoothstep(hgt - .8, hgt + .8, yb)) * (1. - inB);
    float shadow = (1. - smoothstep(0., 5., yb - hgt)) * step(hgt, yb) * step(1., hgt);
    c *= 1. - .18 * shadow;
    c = mix(c, silk, inB);
    c = mix(c, vec3(.788, .725, .541), sep);
    float gl = (1. - smoothstep(0., 1.2, abs(yb - hb + 1.))) * step(1., hgt);
    c = mix(c, vec3(.788, .635, .29), gl * inB);
  }
  // 2D 叠加层（预乘 alpha；墨甩化开时按噪声阈值退掉）
  if (uOvOn > .5) {
    vec4 o = texture2D(tOv, vUv);
    vec3 pp = paperTex(p);
    if (uOvDiss > 0.) {
      // 退墨：沿笔向拉长 4 倍的噪声做阈值，边是硬的墨边，内侧留一道潮线（不是软边黑团）
      vec2 dd = vec2(cos(uInkAng), sin(uInkAng)); vec2 q = vec2(dot(p, dd), dot(p, vec2(-dd.y, dd.x)));
      float n = fbm2(vec2(q.x * .0021, q.y * .0084)) * .7 + fbm2(vec2(q.x * .011, q.y * .044) + 5.) * .3;
      float k = smoothstep(uOvDiss - .012, uOvDiss + .012, n);
      float tide = (1. - smoothstep(.0, .035, n - uOvDiss)) * k;
      o *= k; o.rgb *= 1. - .3 * tide;
    }
    o.rgb *= .97 + .06 * (pp.r - .5) * 2.;           // 墨是不透明的实墨：上面最多留极淡的纸纹
    c = c * (1. - o.a) + o.rgb;
  }
  // 淡入（墨黑）、淡出（纸白，纸纹保持全强度）——在题字之前，题字最后才消失
  if (uFadeBlack > 0.) c = mix(c, vec3(.055, .07, .063), uFadeBlack);
  if (uFadePaper > 0.) { vec3 pw = vec3(.949, .922, .867) * (.93 + .14 * paperTex(p * 1.3).r); c = mix(c, pw, uFadePaper); }
  // 星芒 G（look 之后单独叠，切点两边一致）
  if (uStar.z > 0.) {
    vec2 d = (p - uStar.xy) / uStarS;
    float r = length(d);
    float core = 1. - smoothstep(5., 10., r);
    float halo = exp(-r * r / (46. * 46.)) * .5 + exp(-r * r / (110. * 110.)) * .18;
    float hx = (1. - smoothstep(.4, 2.2, abs(d.y))) * max(1. - abs(d.x) / 260., 0.) * (1. + 1.5 * exp(-abs(d.x) / 40.));
    float vy = (1. - smoothstep(.3, 1.8, abs(d.x))) * max(1. - abs(d.y) / 87., 0.) * (1. + exp(-abs(d.y) / 25.));
    float ring = (1. - smoothstep(0., 1.4, abs(r - 34.))) * .6;
    vec3 add = uStarCore * core + uStarHalo * halo + uStarCore * (hx + vy * .8) + uStarRing * ring;
    c += add * uStar.z;
    // 切点两边用同一团光盖住（P* 周围曝到约 70%）
    if (uStarGlow > 0.) { vec2 dg = (p - uStar.xy) / vec2(260., 190.); c += mix(uStarHalo, uStarCore, .5) * exp(-dot(dg, dg)) * uStarGlow; }
  }
  // 题字：竖排两列，逐字洇出
  if (uTxtOn > 0.) {
    float ink = 0., halo = 0.;
    for (int i = 0; i < 8; i++) {
      vec4 ch = uChar[i];
      if (ch.w <= 0.) continue;
      vec2 q = (p - vec2(ch.x - ch.z * .5, ch.y)) / ch.z;     // 字格 0..1
      if (q.x < -.15 || q.y < -.15 || q.x > 1.15 || q.y > 1.15) continue;
      vec2 cell = vec2((float(i) + q.x) / 8., 1. - q.y);
      vec4 t = texture2D(tTxt, clamp(cell, vec2(float(i) / 8. + .001, .001), vec2((float(i) + 1.) / 8. - .001, .999)));
      float inside = step(0., q.x) * step(0., q.y) * step(q.x, 1.) * step(q.y, 1.);
      float sharp = t.r * inside, soft = t.g * inside;
      float rev = ch.w;
      float dist = length(q - .5) / .72 + (vnoise2(q * 7. + float(i) * 3.1) - .5) * .35;
      float m = 1. - smoothstep(rev * 1.25 - .12, rev * 1.25, dist);
      float bl = uCharBlur[i];
      float body = mix(sharp, soft, bl * .65) * m;
      float dry = 1. - .08 * smoothstep(.5, .8, vnoise2(q * 34. + float(i)));
      ink = max(ink, body * dry);
      halo = max(halo, soft * m * .25);
    }
    float A = clamp(max(ink * .92, halo), 0., 1.) * uTxtA;
    c = mix(c, vec3(.118, .102, .086), A);
  }
  gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
}`;

export function createPost(renderer, W, H) {
  const K = H / 1040;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mesh = new THREE.Mesh(geo); mesh.frustumCulled = false;
  const V2 = () => new THREE.Vector2(), V3 = (...a) => new THREE.Vector3(...a), V4 = () => new THREE.Vector4();
  const pu = {
    tColor: { value: null }, tDepth: { value: null }, uNear: { value: .1 }, uFar: { value: 1000 }, uRes: { value: new THREE.Vector2(W, H) }, uK: { value: K },
    uRain: { value: 0 }, uRainT: { value: 0 }, uRainTilt: { value: .17 }, uRainLen: { value: 1 }, uRainA: { value: 1 }, uRainW: { value: 1 }, uRainD: { value: V3(2, 6, 15) },
    uSplash: { value: 0 }, uSplashT: { value: 0 }, uSplashNear: { value: .2 },
    uBeam: { value: 0 }, uDust: { value: 0 }, uDustT: { value: 0 }, uDustAll: { value: 0 }, uDustPar: { value: V2() }, uBeamCol: { value: srgb3('#FFD98A') }, uBeamAng: { value: 28 * Math.PI / 180 }, uBeamO: { value: new THREE.Vector2(200, 0) }, uCold: { value: 0 },
    uGod: { value: 0 }, uGodPos: { value: V2() }, uGodCol: { value: srgb3('#FFE2A0') }, uGodThr: { value: .72 },
    uMyo: { value: 0 }, uLens: { value: V4() }, uLensA: { value: 0 },
    uWetInk: { value: 0 }, uGoldOmen: { value: 0 }, uExpo: { value: 1 }, uMul: { value: V3(1, 1, 1) }, uMBlur: { value: V2() }, uWhite: { value: 0 }, uWhiteC: { value: V3(.953, .945, .902) },
  };
  const postMat = new THREE.ShaderMaterial({ uniforms: pu, vertexShader: VS_FS, fragmentShader: POST_FS, depthTest: false, depthWrite: false });
  const fu = {
    tA: { value: null }, tB: { value: null }, tOv: { value: null }, tTxt: { value: null }, tLeo: { value: null }, uLeoM: { value: 0 }, uRes: { value: new THREE.Vector2(W, H) }, uK: { value: K },
    uMode: { value: 0 }, uOvOn: { value: 0 }, uWipe: { value: V4() }, uWipe2: { value: V4() }, uWipeSpd: { value: 100 }, uWipeAll: { value: 0 }, uWipeTR: { value: 0 }, uInkAng: { value: 0 }, uOvDiss: { value: 0 }, uBorder: { value: 0 },
    uTrail: { value: [...Array(48)].map(V4) }, uTrailB: { value: [...Array(48)].map(V2) }, uTrailN: { value: 0 }, uInk: { value: srgb3('#17201F') },
    uHole: { value: V4() }, uHoleTilt: { value: 0 }, uHoleOn: { value: 0 }, uHoleRim: { value: 0 }, uTau: { value: -1 },
    uStar: { value: V3(0, 0, 0) }, uStarS: { value: 1 }, uStarGlow: { value: 0 }, uStarCore: { value: srgb3('#FFF4D6') }, uStarHalo: { value: srgb3('#FFC860') }, uStarRing: { value: srgb3('#FFE3A0') },
    uFiber: { value: 0 }, uYao: { value: [...Array(5)].map(V4) }, uYaoOn: { value: 0 }, uYaoT: { value: 0 }, uYaoX1: { value: 2080 }, uYaoGap: { value: V2() }, uFadeBlack: { value: 0 }, uFadePaper: { value: 0 }, uExpo: { value: 1 },
    uChar: { value: [...Array(8)].map(V4) }, uCharBlur: { value: new Array(8).fill(0) }, uTxtOn: { value: 0 }, uTxtA: { value: 1 }, uGlowOn: { value: 0 },
  };
  const finMat = new THREE.ShaderMaterial({ uniforms: fu, vertexShader: VS_FS, fragmentShader: FINAL_FS, depthTest: false, depthWrite: false });
  const draw = (mat, target) => { mesh.material = mat; renderer.setRenderTarget(target); renderer.render(mesh, cam); };
  const POST_DEF = Object.fromEntries(Object.entries(pu).map(([k, v]) => [k, v.value && v.value.clone ? v.value.clone() : v.value]));
  const FIN_DEF = Object.fromEntries(Object.entries(fu).map(([k, v]) => [k, Array.isArray(v.value) ? v.value.map(x => x.clone ? x.clone() : x) : (v.value && v.value.clone ? v.value.clone() : v.value)]));
  const assign = (u, def, p) => {
    for (const k in def) {
      if (k.startsWith('t')) continue;
      const d = def[k];
      if (Array.isArray(d)) { u[k].value.forEach((x, i) => { if (x.copy) x.copy(d[i]); else u[k].value[i] = d[i]; }); }
      else if (d && d.copy) u[k].value.copy(d); else u[k].value = d;
    }
    for (const k in p) {
      if (!u[k]) continue;
      const v = p[k];
      if (Array.isArray(v) && u[k].value && u[k].value.set && !Array.isArray(u[k].value)) u[k].value.set(...v);
      else if (Array.isArray(v) && Array.isArray(u[k].value)) v.forEach((x, i) => { if (Array.isArray(x)) u[k].value[i].set(...x); else u[k].value[i] = x; });
      else if (v && v.isColor) u[k].value.set(v.r, v.g, v.b);
      else u[k].value = v;
    }
  };
  return {
    post(tColor, tDepth, camera, p, target) {
      assign(pu, POST_DEF, p);
      pu.tColor.value = tColor; pu.tDepth.value = tDepth; pu.uNear.value = camera.near; pu.uFar.value = camera.far;
      draw(postMat, target);
    },
    final(tA, tB, tOv, tTxt, p, tLeo = null) {
      assign(fu, FIN_DEF, p);
      fu.tA.value = tA; fu.tB.value = tB || tA; fu.tOv.value = tOv; fu.tTxt.value = tTxt; fu.tLeo.value = tLeo || tA;
      draw(finMat, null);
    },
  };
}
