// toonmat.js — C 奇谭的 3D 卡通材质（自写 ShaderMaterial；参数含义对应 DESIGN 3.2 的 toon 预设）
// 分阶作用在 hl = 0.5·N·L + 0.5 上；交界软（feather .06–.14，模仿喷枪过渡）；fresnel 暗边（软陶感）；接触 AO；
// 物体空间噪声：交界扰动、斑驳、等值线皴纹、竖向干笔；两套色板按翻色前沿 uWipeX（屏幕设计像素）混合；手写 FogExp2。
// 所有噪声是坐标的纯函数；闪烁类效果用 uTc（一拍二时间）做种子。
import * as THREE from 'three';
import { GLSL_COMMON, lin3 } from './util.js';

// 全片共享：翻色前沿、K、开门遮罩（修复室）
export const SHARED = {
  uWipeX: { value: 1e5 }, uK: { value: 1 }, uTc: { value: 0 },
  uDoor: { value: new THREE.Vector4(0, 0, 1, 0) },     // w, v0, v1, on   （左页 UV 空间的门洞）
  uDap: { value: new THREE.Vector4(0, 0, 0, 0) },      // on, m, leaf, _
  uPool: { value: new THREE.Vector4(0, 0, 1, 0) },     // 修复室窗光光池：中心 x、z、半径、强度（0 = 关）
  uDapW: { value: Array.from({ length: 6 }, () => new THREE.Vector4(9, 9, .01, .01)) },   // 世界光斑：x, z, rx, rz
  uFogHi: { value: new THREE.Vector4(0, 0, 0, 0) },    // 第 3 轮（v2-06）：T1 俯冲高处时，雾色换成天穹下半的颜色（rgb 线性，w = 混合量；每帧由镜头设）
  uDapWP: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
};

export const GLSL_3D = /* glsl */`
float h31(ivec3 p, uint s){ return float(pcgh(uint(p.x) + pcgh(uint(p.y) + pcgh(uint(p.z) + s)))) * (1.0 / 4294967295.0); }
float vn3(vec3 x, uint s){
  ivec3 i = ivec3(floor(x)); vec3 f = fract(x); vec3 u = f * f * (3. - 2. * f);
  float a = h31(i, s), b = h31(i + ivec3(1, 0, 0), s), c = h31(i + ivec3(0, 1, 0), s), d = h31(i + ivec3(1, 1, 0), s);
  float e = h31(i + ivec3(0, 0, 1), s), g = h31(i + ivec3(1, 0, 1), s), h = h31(i + ivec3(0, 1, 1), s), k = h31(i + ivec3(1, 1, 1), s);
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float fbm3d(vec3 p, uint s){ float a = 0., m = .5; for (int i = 0; i < 3; i++) { a += m * vn3(p, s + uint(i) * 31u); p = p * 2.07 + vec3(5.1, 1.7, 9.3); m *= .5; } return a / .875 - .5; }
`;

const VS = /* glsl */`
varying vec3 vW, vN, vO; varying float vVZ;
uniform float uSway; uniform vec3 uSwayPivot;
void main(){
  vec4 p = vec4(position, 1.);
  vec3 n = normal;
#ifdef USE_INSTANCING
  p = instanceMatrix * p; n = mat3(instanceMatrix) * n;
#endif
  vO = position;
  vec4 w = modelMatrix * p;
  vW = w.xyz; vN = normalize(mat3(modelMatrix) * n);
  vec4 mv = viewMatrix * w; vVZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FS = /* glsl */`
${GLSL_COMMON}
${GLSL_3D}
uniform vec3 uBase, uS1, uS2, uBaseB, uS1B, uS2B;
uniform float uWipeOn, uWipeX, uK, uMixB, uTc;
uniform float uStep1, uF1, uStep2, uF2;
uniform vec3 uLightW;
uniform vec3 uRimC; uniform float uRimAmt, uRimIn, uRimPow;
uniform vec3 uRimLitC; uniform float uRimLitAmt, uRimLitIn;
uniform vec3 uSkyC; uniform float uSkyAmt;
uniform float uFres, uAO, uFloorY, uAOR;
uniform float uEdgeN, uEdgeNS, uDab, uDabS, uStrata, uStrataF, uDry, uDabDark, uStrataLit;
uniform vec3 uTopC, uTopC2; uniform float uTopAmt;
uniform vec3 uFogC, uFogCB; uniform float uFogD, uFogMax; uniform vec4 uFogHi;
uniform vec3 uEmis; uniform float uOpacity;
uniform vec3 uWetC; uniform float uWetAmt;
uniform vec3 uSpecC; uniform float uSpec, uSpecPow;
uniform float uWood;
uniform vec4 uDoor; uniform float uDoorCut;
uniform vec4 uDap; uniform vec4 uPool;
uniform vec3 uTint, uPaintMean; uniform sampler2D tPaint; uniform float uPaintAmt, uPaintS, uWarmLit, uTopPatch, uPaintAlways; uniform vec4 uPaintR;
uniform vec3 uTipC; uniform float uTipAmt;
uniform vec3 uGrad;   // 喷枪式竖向渐变：y 低、y 高、强度（越往下越暗）
varying vec3 vW, vN, vO; varying float vVZ;
#ifdef BIND
// 第 4 轮（qa2-06 / main3-02）：线装书。mode 1 = 合着的一册（盒体半尺寸 h，书脊在 +z）：软封面（磁青纸）、四眼订线、书脊两角包角、题签（不写字）；
//   mode 2 = 摊开那本的半边书块：底下 1.1 mm 是和书块一样大的软封面（不外伸），书沟两端（书脊一侧）包角 + 绕过书根的订线。
//   返回覆盖色（未受光）和覆盖量；受光的三阶明暗在外面统一乘。
uniform vec4 uBindA; uniform vec3 uBindCov, uBindSilk, uBindThr;
vec4 bindCol(vec3 o){
  float mode = uBindA.x; vec3 h = uBindA.yzw;
  float tw = .00065;
  vec3 cov = uBindCov * (.93 + .1 * vnoise(o.xz * 700. + o.y * 300., 71u));
  if (mode < 1.5) {
    float ax = abs(o.x), zs = h.z - o.z;
    float lid = step(h.y - 3e-4, abs(o.y));
    if (lid > .5) {
      vec3 c = cov;
      c = mix(c, uBindSilk * (.9 + .15 * vnoise(o.xz * 2400., 72u)), step(h.x - .014, ax) * step(zs, .014));
      if (o.y > 0.) {
        vec2 q = vec2(o.x - (h.x - .075), o.z + h.z - .021);
        float sl = step(abs(q.x), .055) * step(abs(q.y), .012), inner = step(abs(q.x), .0532) * step(abs(q.y), .0102);
        c = mix(c, vec3(.60, .53, .38) * (.95 + .08 * vnoise(o.xz * 1800., 73u)), sl);
        c = mix(c, vec3(.30, .25, .17), (sl - inner) * .55);
      }
      float th = 1. - sst(tw * .5, tw * 1.5, abs(zs - .0085));
      for (int i = 0; i < 4; i++) { float xi = (float(i) - 1.5) * h.x * .52; th = max(th, (1. - sst(tw * .5, tw * 1.5, abs(o.x - xi))) * step(zs, .0085 + tw)); }
      return vec4(mix(c, uBindThr, th), 1.);
    }
    float band = step(h.y - .0008, abs(o.y));
    if (zs < 3e-4) {
      vec3 c = mix(vec3(.50, .44, .29), cov, band);
      c = mix(c, uBindSilk, step(h.x - .014, ax));
      float th = 0.;
      for (int i = 0; i < 4; i++) { float xi = (float(i) - 1.5) * h.x * .52; th = max(th, 1. - sst(tw * .5, tw * 1.5, abs(o.x - xi))); }
      return vec4(mix(c, uBindThr, th), 1.);
    }
    return vec4(cov, band);
  }
  float bot = 1. - sst(h.x + .0011, h.x + .0015, o.y);
  float endF = step(.1033, abs(o.z)), gx = abs(o.x);
  if (endF > .5 && gx < .0095) {
    vec3 c = uBindSilk * (.92 + .16 * vnoise(vec2(o.x, o.y) * 2400., 74u));
    float th = 1. - sst(tw * .45, tw * 1.3, abs(gx - .0052));
    return vec4(mix(c, uBindThr, th * .85), 1.);
  }
  return vec4(cov, bot);
}
#endif
float doorM(vec2 xz){
  vec2 uv = vec2((xz.x + .15) / .15, (xz.y + .105) / .21);
  if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) return 0.;
  float nv = .04 * fbm(vec2(uv.x * 18., 3.7), 62u);   // 返修 tech-12：门洞上下边也有毛边
  float vin = sst(uDoor.y - .02, uDoor.y, uv.y + nv) * (1. - sst(uDoor.z, uDoor.z + .02, uv.y - nv));
  return sst(-.015, .015, uDoor.x - abs(uv.x - .5) + .04 * fbm(uv * 18., 61u)) * vin;
}
// 修复室光斑（世界空间，沿窗光方向投到桌面 / 书上）
uniform vec4 uDapW[6]; uniform vec4 uDapWP[6];
float dappleW(vec3 w){
  float L = 0.;
  for (int j = 0; j < 6; j++) {
    vec2 c = uDapW[j].xy; vec2 r = uDapW[j].zw;
    vec2 d = (w.xz - c) / r;
    float e = 1. - sst(.86, 1., length(d));
    vec2 m = motif((w.xz - c) / (r.x * .8), uDapWP[j], 5., .15, .85);   // 第 4 轮（zs-01）：落定后读成豹斑——环边收清、斑心只亮一层
    L = max(L, mix(e, m.x + .2 * m.y, uDap.y));
  }
  float leaf = sst(-.08, .28, fbm(w.xz * 30., 43u)) * .6 + sst(-.05, .3, fbm(w.xz * 95. + 3.1, 44u)) * .45;
  return L * (1. - uDap.z * clamp(leaf, 0., .85));
}
// 借底板的笔触（返修 style-04 第 2 轮）：取 A19 主峰崖面那一块（干笔皴擦最密的地方），镜像平铺、三向投影；
// 用"局部 / 大尺度模糊"的比值只借笔触和冷暖起伏，不借底板自己的明暗
vec3 paintRel(vec2 p){
  vec2 m = abs(fract(p * .5) * 2. - 1.);
  vec2 uv = uPaintR.xy + m * uPaintR.zw;
  vec3 a = texture2D(tPaint, uv).rgb;
  if (uPaintMean.x > 0.) return pow(a / uPaintMean, vec3(.75));   // 整张笔触贴图：除以全图平均色，保留冷暖和笔触的明暗
  vec3 b = textureLod(tPaint, uv, 5.).rgb;
  return a / max(b, vec3(.015));
}
void main(){
  if (uDoorCut > .5 && uDoor.w > .5 && vW.y < .0175 && doorM(vW.xz) > .5) discard;
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(uLightW);
  float wm = uMixB;
  vec2 dp = vec2(gl_FragCoord.x / uK, 1040. - gl_FragCoord.y / uK);
  if (uWipeOn > .5) wm = max(wm, sst(-50., 50., wipeD(dp, uWipeX)));   // 第 4 轮（qa2-07）：前沿形状见 util.js wipeD
  vec3 base = mix(uBase, uBaseB, wm), s1 = mix(uS1, uS1B, wm), s2 = mix(uS2, uS2B, wm);
  float en = fbm3d(vO * uEdgeNS, 3u) * 2. * uEdgeN;
  float hl = .5 * dot(N, L) + .5 + en;
  float m1 = clamp((uStep1 - hl) / uF1 + .5, 0., 1.);
  float m2 = clamp((uStep2 - hl) / uF2 + .5, 0., 1.);
  vec3 col = mix(base, mix(s1, s2, m2), m1);
  float bindA = 0.;
#ifdef BIND
  { vec4 bc = bindCol(vO); float tone = mix(1., mix(.60, .38, m2), m1); col = mix(col, bc.rgb * tone, bc.a); bindA = bc.a; }
#endif
  // 彩态的冷暖（返修 style-04 第 2 轮）：A19 的受光面偏橄榄金、背光面偏青蓝；前景跟底板同一套冷暖
  if (uWarmLit > 0. && wm > 0.) {
    col = mix(col, col * vec3(1.22, 1.10, .74), wm * uWarmLit * sst(.55, .82, hl));
    col = mix(col, col * vec3(.84, .97, 1.14), wm * uWarmLit * (1. - sst(.3, .55, hl)));
  }
  if (uWood > 0.) { float g = fbm3d(vO * vec3(.3, 6., 6.) * 3., 15u); float b = floor((g + .5) * 3.) / 3.; col *= 1. + uWood * (b - .5); }
  if (uDab > 0.) { float d1 = vn3(vO * uDabS, 7u), d2 = vn3(vO * uDabS * 2.3 + 17., 8u); float q = .55 * sst(.48, .58, d1) + .45 * sst(.52, .62, d2); float dw = mix(1., m1, uDabDark); col *= mix(1., mix(1. - uDab, 1. + .7 * uDab, q), dw); }
  if (uStrata > 0.) { float f = fract(vO.y * uStrataF + .6 * 2. * fbm3d(vO * vec3(.5, .15, .5), 9u)); float ln = 1. - sst(.0, .045, min(f, 1. - f)); ln *= mix(1., sst(.58, .68, hl), uStrataLit) * (1. - bindA); col *= 1. - .18 * ln * uStrata / .35 * (1. - wm * .6); }
  if (uDry > 0.) {
    // 彩态竖向干笔皴（返修 style-04）：系数 ×0.75 → ×0.6，多两个八度
    float d = fbm3d(vO * vec3(5., .45, 5.), 19u) + .5 * fbm3d(vO * vec3(14., 1., 14.), 20u) + .3 * fbm3d(vO * vec3(30., 2.2, 30.), 26u) + .18 * fbm3d(vO * vec3(62., 4.5, 62.), 27u);
    col *= mix(1., mix(1., .6, sst(.12, .24, d)), wm * min(uDry, 1.));
    // 苔点：A19 里同一组色 #2C3333 / #445654，4–8K 的小点，只在朝上、朝外的面
    if (uDry > 1.) {
      float mq = vn3(vO * 70., 21u), mz = vn3(vO * 31. + 4., 28u);
      float moss = sst(.86, .9, mq) * sst(.35, .6, mz) * sst(.2, .6, N.y + .45);
      col = mix(col, mix(vec3(.0252, .0331, .0331), vec3(.0595, .0932, .0880), sst(.4, .7, vn3(vO * 12., 29u))), moss * wm * .55);
    }
  }
  if (uTopAmt > 0.) {
    float up = sst(.5, .75, N.y); float q = sst(.35, .65, vn3(vO * 2.2, 23u));
    // 地面横扫的干笔（返修 style-04）：沿 x 拉长的条带，方向和底板的斜向笔触一致；金草斑驳加强（.22 → .35）
    vec3 bp = vec3(vO.x * .9 + vO.z * .35, vO.y, vO.z * 7.5 - vO.x * 1.2);
    float st = vn3(bp * vec3(3., 1., 5.), 25u) * .6 + vn3(bp * vec3(7., 1., 13.), 30u) * .4;
    float sweep = sst(.42, .62, st);
    vec3 topc = mix(uTopC, uTopC2, sst(.55, .8, vn3(vO * 5.1, 24u)));
    topc *= mix(.72, 1.14, 1. - m1) * mix(.84, 1.06, sweep);
    // 第 2 轮：顶面不再整片涂金（读成沙丘）——金草一片一片，片与片之间露出崖石和赭土
    float patchN = vn3(vO * vec3(1.3, 1., 2.1) + 3., 31u) * .65 + vn3(vO * 4.2 + 9., 32u) * .35;
    float cover = mix(.55 + .45 * q, sst(.40, .64, patchN), uTopPatch);
    vec3 earth = mix(vec3(.30, .20, .09), vec3(.42, .30, .14), sweep) * mix(.7, 1., 1. - m1);
    vec3 topMix = mix(mix(col, earth, .3 * uTopPatch), topc, cover);
    col = mix(col, topMix, up * wm * uTopAmt);
  }
  if (uSkyAmt > 0.) col = mix(col, col * uSkyC, sst(.25, .5, N.y) * m1 * uSkyAmt);
  if (uFres > 0.) col *= mix(1., 1. - uFres, pow(1. - abs(dot(N, V)), 2.));
  if (uAO > 0.) col *= mix(.75, 1., sst(0., uAOR, vW.y - uFloorY));
  float ndv = clamp(dot(N, V), 0., 1.);
  float hlv = clamp(.5 * dot(N, L) + .5, 0., 1.);
  if (uRimAmt > 0.) { float rp = pow(1. - ndv, exp2(3. * (1. - uRimPow))) + en * .8; float tA = uRimIn + .3 * hlv; col = mix(col, uRimC, sst(tA - .03, tA + .03, rp) * uRimAmt); }
  // 返修 v2-03（第 3 轮）：日光的受光边是"雾散以后"才有的光——带翻色前沿的材质只在前沿扫过的地方亮（逐像素 wm），
  //   不再在 f458 一下子把整片崖台顶面刷成赭金
  if (uRimLitAmt > 0.) { float rq = pow(1. - ndv, 1.6) + en * .8; float tL = uRimLitIn + .3 * (1. - hlv); col = mix(col, uRimLitC, sst(tL - .03, tL + .03, rq) * uRimLitAmt * (uWipeOn > .5 ? wm : 1.)); }
  if (uSpec > 0.) { float sp = pow(max(dot(N, normalize(L + V)), 0.), uSpecPow); col += uSpecC * (sst(.33, .37, sp) * .5 + sst(.68, .72, sp) * .5) * uSpec; }
  // 第 4 轮（v3-04 / qa2-05）：雨点打在崖面上的水花——原来按 1/60 m 的立方格哈希、step 出硬边小方块（像坏点）。
  //   现在每个 4 cm 的格子里至多一朵，位置、时刻按哈希：第一拍一颗软圆亮点，第二拍散成一圈淡淡的小冠，然后消失（每 8 拍一轮、约 13% 的格子轮到）；
  //   半径按屏幕设计像素（×K）定、羽化约 1K，跟着后面的雾、景深一起变淡
  if (uWetAmt > 0. && N.y > .45) {
    vec2 cp = vW.xz * 25.; ivec2 ci = ivec2(floor(cp));
    float wpp = max(length(fwidth(vW.xz)), 1e-6);
    float st = floor(uTc * 12. + .5);
    float off = floor(h31(ivec3(ci, 7), 81u) * 8.);
    float per = floor((st + off) / 8.), k = st + off - per * 8.;
    float on = step(h31(ivec3(ci, int(per)), 82u), .13) * step(k, 1.5);
    if (on > .5) {
      vec2 c = (vec2(ci) + .2 + .6 * vec2(h31(ivec3(ci, 1), 83u), h31(ivec3(ci, 2), 84u))) / 25.;
      float r = min((1.1 + .7 * h31(ivec3(ci, 3), 85u)) * uK * wpp, .006), fe = max(uK * wpp, r * .35);
      float d = length(vW.xz - c);
      float a = k < .5 ? 1. - sst(r - fe, r + fe * .5, d) : (1. - sst(.3 * r, .3 * r + fe, abs(d - 2.1 * r))) * .45;
      col = mix(col, uWetC, a * uWetAmt * 2.6);
    }
  }
  if (uPool.w > 0.) { vec2 d = vW.xz - uPool.xy; vec2 ax = normalize(vec2(.8, -.4)); float dp = dot(d, ax), dq = dot(d, vec2(-ax.y, ax.x)); float pl = exp(-(dp * dp / (uPool.z * uPool.z * 2.6) + dq * dq / (uPool.z * uPool.z))); col *= mix(1. - uPool.w, 1. + .55 * uPool.w, pl); }
  if (uDap.x > 0.) { float Ld = dappleW(vW) * uDap.x; col = mix(col * vec3(.70, .72, .78), col * vec3(1.42, 1.22, .86) + vec3(.896, .552, .147) * .10, Ld); }
  if (uTipAmt > 0.) col = mix(col, uTipC, sst(.45, 1., vO.y) * uTipAmt * wm);
  if (uGrad.z > 0.) col *= mix(1. - uGrad.z, 1. + .25 * uGrad.z, sst(uGrad.x, uGrad.y, vW.y));
  col *= uTint;
  // 彩态前景整体饱和度压 15%（返修 style-04：不要比底板更艳）
  if (uWipeOn > .5 || uMixB > 0.) { float lw = dot(col, vec3(.2126, .7152, .0722)); col = mix(col, vec3(lw), .15 * wm); }
  // 借底板笔触（返修 style-04）：A19 近景局部按世界坐标投到崖面（顶面用 xz、侧面用 xy），亮度细节混 30%
  float pw = max(wm, uPaintAlways);
  if (uPaintAmt > 0. && pw > 0.) {
    vec3 an = pow(abs(N), vec3(4.)); an /= an.x + an.y + an.z;
    vec3 P = vW * uPaintS;
    vec3 rel = paintRel(P.zy) * an.x + paintRel(P.xz + 7.3) * an.y + paintRel(P.xy + 3.1) * an.z;
    rel = clamp(rel, vec3(.45), vec3(1.8));
    col *= mix(vec3(1.), rel, uPaintAmt * pw);
  }
  col += uEmis;
  float fd = vVZ * uFogD; float ff = min(1. - exp(-fd * fd), uFogMax);
  col = mix(col, mix(mix(uFogC, uFogCB, wm), uFogHi.rgb, uFogHi.w), ff);
  gl_FragColor = vec4(col, uOpacity);
}`;

const C = h => lin3(h);
// makeToon(o)：o 的键见下面的默认值
export function makeToon(o = {}) {
  const d = {
    base: '#888888', s1: null, s2: null, baseB: null, s1B: null, s2B: null, wipe: false, mixB: 0,
    step1: .58, f1: .08, step2: .32, f2: .1, light: [.6, .5, .6],
    rim: '#ffffff', rimAmt: 0, rimIn: .5, rimPow: .3, rimLit: '#ffffff', rimLitAmt: 0, rimLitIn: .2,
    sky: [1, 1, 1], skyAmt: 0, fres: .18, ao: 0, floorY: 0,
    edgeN: .04, edgeNS: 1.6, dab: 0, dabS: 2.2, strata: 0, strataF: 1.1, dry: 0,
    top: '#B48339', top2: '#EAAD49', topAmt: 0,
    fog: '#CFCAC1', fogB: null, fogD: 0, fogMax: 1, emis: [0, 0, 0], opacity: 1,
    wet: '#D8D4CC', wetAmt: 0, spec: 0, specC: '#ffffff', specPow: 30, wood: 0, doorCut: 0, tint: [1, 1, 1],
    side: THREE.FrontSide, transparent: false,
  };
  const p = { ...d, ...o };
  const base = C(p.base), s1 = p.s1 ? C(p.s1) : base.clone().multiplyScalar(.5), s2 = p.s2 ? C(p.s2) : base.clone().multiplyScalar(.25);
  const u = {
    uBase: { value: base }, uS1: { value: s1 }, uS2: { value: s2 },
    uBaseB: { value: p.baseB ? C(p.baseB) : base.clone() }, uS1B: { value: p.s1B ? C(p.s1B) : s1.clone() }, uS2B: { value: p.s2B ? C(p.s2B) : s2.clone() },
    uWipeOn: { value: p.wipe ? 1 : 0 }, uWipeX: SHARED.uWipeX, uK: SHARED.uK, uTc: SHARED.uTc, uMixB: { value: p.mixB },
    uStep1: { value: p.step1 }, uF1: { value: p.f1 }, uStep2: { value: p.step2 }, uF2: { value: p.f2 },
    uLightW: { value: new THREE.Vector3(...p.light).normalize() },
    uRimC: { value: C(p.rim) }, uRimAmt: { value: p.rimAmt }, uRimIn: { value: p.rimIn }, uRimPow: { value: p.rimPow },
    uRimLitC: { value: C(p.rimLit) }, uRimLitAmt: { value: p.rimLitAmt }, uRimLitIn: { value: p.rimLitIn },
    uSkyC: { value: new THREE.Vector3(...p.sky) }, uSkyAmt: { value: p.skyAmt },
    uFres: { value: p.fres }, uAO: { value: p.ao }, uFloorY: { value: p.floorY }, uAOR: { value: p.aoR ?? .15 },
    uEdgeN: { value: p.edgeN }, uEdgeNS: { value: p.edgeNS }, uDab: { value: p.dab }, uDabS: { value: p.dabS }, uStrata: { value: p.strata }, uStrataF: { value: p.strataF }, uDry: { value: p.dry }, uDabDark: { value: p.dabDark ?? 0 }, uStrataLit: { value: p.strataLit ?? 0 },
    uTopC: { value: C(p.top) }, uTopC2: { value: C(p.top2) }, uTopAmt: { value: p.topAmt },
    uFogC: { value: C(p.fog) }, uFogCB: { value: C(p.fogB || p.fog) }, uFogD: { value: p.fogD }, uFogMax: { value: p.fogMax },
    uEmis: { value: new THREE.Vector3(...p.emis) }, uOpacity: { value: p.opacity },
    uWetC: { value: C(p.wet) }, uWetAmt: { value: p.wetAmt },
    uSpecC: { value: C(p.specC) }, uSpec: { value: p.spec }, uSpecPow: { value: p.specPow }, uWood: { value: p.wood },
    uDoor: SHARED.uDoor, uDoorCut: { value: p.doorCut }, uDap: SHARED.uDap, uPool: SHARED.uPool,
    uDapW: SHARED.uDapW, uDapWP: SHARED.uDapWP, uFogHi: SHARED.uFogHi,
    uTint: { value: new THREE.Vector3(...p.tint) }, tPaint: { value: p.paint ?? null }, uPaintAmt: { value: p.paint ? (p.paintAmt ?? .3) : 0 },
    uPaintS: { value: p.paintS ?? .35 }, uPaintR: { value: new THREE.Vector4(...(p.paintR || [.53, .337, .276, .497])) }, uWarmLit: { value: p.warmLit ?? 0 }, uTopPatch: { value: p.topPatch ?? 0 }, uPaintMean: { value: new THREE.Vector3(...(p.paintMean || [0, 0, 0])) }, uPaintAlways: { value: p.paintAlways ?? 0 }, uTipC: { value: C(p.tip || '#EAAD49') }, uTipAmt: { value: p.tipAmt ?? 0 }, uGrad: { value: new THREE.Vector3(...(p.grad || [0, 1, 0])) },
    uSway: { value: 0 }, uSwayPivot: { value: new THREE.Vector3() },
  };
  const defines = {};
  if (p.bind) {   // 第 4 轮（qa2-06 / main3-02）：线装书的封面、订线、包角、题签
    const b = p.bind; defines.BIND = '';
    u.uBindA = { value: new THREE.Vector4(b.mode, ...(b.h || [0, 0, 0])) }; u.uBindCov = { value: C(b.cov || '#3C4A5A') }; u.uBindSilk = { value: C(b.silk || '#262E3C') }; u.uBindThr = { value: C(b.thr || '#D8CDB4') };
  }
  const m = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: u, defines, side: p.side, transparent: p.transparent, toneMapped: false });
  m.userData.u = u;
  return m;
}
// 给网格挂描线标记（look 管线读 userData）
export function outlined(mesh, width = 1, alpha = 1) { mesh.userData.outline = true; mesh.userData.outlineWidth = width; mesh.userData.outlineAlpha = alpha; return mesh; }
