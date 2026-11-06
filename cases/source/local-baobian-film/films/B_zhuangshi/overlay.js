// overlay.js — 叠加层 O：在 look.render 之后直接画到屏幕（或门户渲染目标），不吃 Kuwahara、不被描线。
// 内容：雨（三层斜雨、慢放）、白金闪、屏幕地平金线、金环（眼孔形 → 圆，金 → 墨）、闪（四角星 + 中心圆 + 细环 + 光晕）、
//       镜片斜亮带、暖色小光点、浮尘、水珠 / 墨滴、皇冠溅、雨打水花。
// 坐标：一律用设计像素（1920×1040，原点左上，y 向下）= gl_FragCoord / K；颜色是 sRGB 原值（直接写屏幕/门户目标，两边一致）。
import * as THREE from 'three';
import { GLSL_COMMON, SHARED, K, W, H, srgb3 } from './lib.js';

const VS = /* glsl */`void main(){ gl_Position = vec4(position.xy, 0., 1.); }`;

const FS_OVER = /* glsl */`
${GLSL_COMMON}
uniform float uK; uniform vec2 uRes;
// 雨：x 总强度, y 有效时间（慢放已积分）, z 长度倍数, w 只留近层(1)
uniform vec4 uRain; uniform float uRainPan; uniform float uRainNearLen;
// 金线：y, 宽, alpha, 金线亮度；uLineMask：日盘虹膜（门户）的屏幕圆 x, y, 半径——圆内不画（门里由远脊金边接力，tech-01）
uniform vec4 uLine; uniform vec3 uLineMask;
// 金环：中心 x,y, 半径, 形状(0 杏仁 → 1 圆)；uRingB：宽, alpha, 金→墨(0..1)
uniform vec4 uRingA; uniform vec3 uRingB;
// 水珠 / 墨滴：x,y, 半径, alpha；uDropB：拉长, 墨比例, 高光；uDropT：脱落后的细墨尾 长度(px), alpha
uniform vec4 uDrop; uniform vec3 uDropB; uniform vec2 uDropT;
// 皇冠溅：中心 x,y, 进度 0..1（<0 关）, 缩放
uniform vec4 uCrown;
// 雨打水花：最多 4 个 (x, y, 进度, 半径)
uniform vec4 uHit[6];
// 浮尘：强度；光柱遮罩：一条斜带（点、方向、半宽）
uniform float uDust; uniform vec4 uShaft; uniform float uTime;
// w3（qa2-03）：白金闪的"幕"——按 alpha 盖一层暖白（sRGB rgb, alpha），不再整屏加色加到纯白；底下的 S2 透出一层影
uniform vec4 uVeil;
// w3（v3-02）：墨滴的"颈"（墨滴顶 → 指尖下缘接触点）：uNeckA = 下端 x, y, 上端 x, y；uNeckB = 下端半宽, 上端半宽, 中段最细处半宽, alpha；
//   uNeckC = 断开：上段保留比例（从上端量）, 下段保留比例（从下端量）, 开关（>0.5 断开）；手的 alpha 遮罩（颈只画在指尖轮廓以下）
uniform vec4 uNeckA, uNeckB; uniform vec3 uNeckC;
uniform sampler2D uHandTex; uniform vec4 uHandMap; uniform float uHandOn;
// w3（qa2-04）：落背冲击环：中心 x, y, 半径, alpha；半线宽
uniform vec4 uImpact; uniform float uImpactW;
vec3 RAIN = vec3(.910, .949, .941);
float rainLayer(vec2 p, float cellW, float period, float len, float wid, float spd, float rate, float seed, float tt){
  const float S7 = .1219, C7 = .9925;     // 斜 7°：右上 → 左下
  vec2 q = vec2(p.x * C7 + p.y * S7, -p.x * S7 + p.y * C7);
  q.y -= spd * tt;
  float col = floor(q.x / cellW);
  float row = floor(q.y / period);
  float h = bbH2(vec2(col * 1.37 + seed, row * 2.11 - seed));
  if (h > rate) return 0.;
  float h2 = bbH2(vec2(col + 91.3 * seed, row + 17.7));
  float h3 = bbH2(vec2(col - 33.1, row + seed * 5.3));
  float xs = (col + .2 + .6 * h2) * cellW;
  float y0 = row * period + h3 * (period - len);
  float dx = abs(q.x - xs);
  float cx = 1. - smoothstep(wid * .5 - .6 / uK, wid * .5 + .6 / uK, dx);
  float ly = q.y - y0;
  float cy = smoothstep(0., len * .35, ly) * (1. - smoothstep(len * .8, len, ly));
  return cx * cy * (.75 + .25 * h2);
}
float sdEllipse(vec2 p, vec2 r){ float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.) / max(k1, 1e-5); }
void main(){
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uK;     // 设计像素
  vec4 o = vec4(0.);                                               // 预乘 rgba
  // —— 雨 ——
  if (uRain.x > 0.) {
    float tt = uRain.y, lm = uRain.z;
    float r = 0.;
    vec2 pn = p + vec2(uRainPan / 4., 0.);
    r += rainLayer(pn, 18., 260., (uRain.w > .5 ? uRainNearLen : 70.) * lm, 1.4, 2600., .25, 1., tt) * .35;
    if (uRain.w < .5) {
      r += rainLayer(p + vec2(uRainPan / 12., 0.), 18., 190., 45. * lm, 1.1, 1700., .45, 2., tt) * .28;
      r += rainLayer(p + vec2(uRainPan / 40., 0.), 18., 140., 24. * lm, .9, 1000., .70, 3., tt) * .20;
    }
    r = clamp(r * uRain.x, 0., 1.);
    o = vec4(RAIN * r, r) + o * (1. - r);
  }
  // —— 屏幕地平金线 ——
  if (uLine.z > 0.) {
    float d = abs(p.y - uLine.x);
    float c = (1. - smoothstep(uLine.y * .5 - .7 / uK, uLine.y * .5 + .7 / uK, d)) * uLine.z;
    if (uLineMask.z > 0.) c *= smoothstep(uLineMask.z - 1.2 / uK, uLineMask.z + 1.2 / uK, length(p - uLineMask.xy));
    vec3 g = vec3(.886, .725, .231) * uLine.w;
    o = vec4(g * c, c) + o * (1. - c);
  }
  // —— 金环 ——
  if (uRingB.y > 0.) {
    vec2 d = p - uRingA.xy; float R = uRingA.z;
    float de = sdEllipse(d, vec2(R, R * .58));
    float dc = length(d) - R;
    float dd = abs(mix(de, dc, uRingA.w));
    float c = (1. - smoothstep(uRingB.x * .5 - .8 / uK, uRingB.x * .5 + .8 / uK, dd)) * uRingB.y;
    vec3 col = mix(vec3(.965, .843, .478), vec3(.169, .149, .133), uRingB.z);
    float glow = exp(-dd * dd / (2. * pow(uRingB.x * 2.2, 2.))) * .35 * (1. - uRingB.z) * uRingB.y;
    c = max(c, 0.);
    o = vec4(col * c, c) + o * (1. - c);
    o.rgb += vec3(.95, .78, .35) * glow;
  }
  // —— 水珠 / 墨滴 ——
  //   w3（v3-02）：原来整圈 2 px 浅水边 + 白高光，读成图标式的水滴贴纸；脱落时的墨尾是一根从墨滴顶往上画的等宽竖线，
  //   会压到指肚上、手收走后悬在墨滴头上。改成：浅水边只留左下约 1/3 弧（α ≤ 0.5），高光缩到 60%；
  //   墨尾改成一道"颈"（墨滴顶 → 指尖下缘接触点，中段最细、两端略粗），断开后两截各自缩回；墨滴与颈都按手精灵的 alpha 遮掉，
  //   只画在指尖轮廓以下（挂着时墨滴的尖顶藏在指尖里，像从指尖下缘长出来）
  float handM = 1.;
  if (uHandOn > .5) {
    vec2 ip = (p - uHandMap.xy) * uHandMap.zw;                       // 手精灵的图像像素
    vec2 huv = vec2(ip.x / 1968., 1. - ip.y / 665.);
    float ha = (huv.x > 0. && huv.x < 1. && huv.y > 0. && huv.y < 1.) ? texture2D(uHandTex, huv).a : 0.;
    handM = 1. - smoothstep(.35, .65, ha);
  }
  vec3 INKD = vec3(.169, .149, .133);
  if (uDrop.w > 0.) {
    vec2 d = p - uDrop.xy; d.y /= uDropB.x;
    float r = uDrop.z;
    // 水滴形：上尖下圆
    float yy = d.y / r;
    float wq = r * (yy < 0. ? sqrt(max(1. - yy * yy * .55, 0.)) * (1. + yy * .35) : sqrt(max(1. - yy * yy, 0.)));
    float sd = abs(d.x) - wq;
    float c = (1. - smoothstep(-.8 / uK, .8 / uK, sd)) * step(-1.6 * r, d.y) * step(d.y, r) * uDrop.w * handM;
    vec3 water = vec3(.867, .910, .902);
    float edgeW = 1. - smoothstep(-2.4 / uK, -1.2 / uK, sd);          // 1 = 内部，0 = 外缘
    float wLL = smoothstep(.30, .72, dot(normalize(vec2(d.x, d.y * uDropB.x) + vec2(1e-4)), vec2(-.6, .8)));   // 左下约 1/3 弧
    float wEdge = (1. - edgeW) * wLL;                                    // 只有左下这段外缘是浅水边
    vec3 col = mix(INKD, water, wEdge * uDropB.y);
    float hl = (1. - smoothstep(.96 / uK, 1.44 / uK, length(d - vec2(-.35 * r, -.45 * r)))) * uDropB.z;
    col = mix(col, vec3(.902, .929, .933), hl * .85);
    float al = c * mix(mix(.6, .95, uDropB.y), .5, wEdge);
    o = vec4(col * al, al) + o * (1. - al);
  }
  if (uNeckB.w > 0.) {
    // P1 = 墨滴顶（下端），P2 = 指尖接触点（上端）；连着时是一整段 [0,1]，断开后是下段 [0, 下段比例] 和上段 [1 − 上段比例, 1]，
    // 每段按投影夹到自己的区间里算距离，断口自然是圆头
    float cov = 0.;
    for (int k = 0; k < 2; k++) {
      float sa = 0., sb = 1.;
      if (uNeckC.z > .5) { if (k == 0) { sb = uNeckC.y; } else { sa = 1. - uNeckC.x; } }
      else if (k == 1) break;
      if (sb - sa < .005) continue;
      vec2 A0 = mix(uNeckA.xy, uNeckA.zw, sa), B0 = mix(uNeckA.xy, uNeckA.zw, sb), dv = B0 - A0;
      float s1 = clamp(dot(p - A0, dv) / max(dot(dv, dv), 1e-4), 0., 1.);
      float s = mix(sa, sb, s1);
      float dist = length(p - (A0 + dv * s1));
      float hw = mix(mix(uNeckB.x, uNeckB.y, s), uNeckB.z, sin(BB_PI * s));   // 两端略粗、中段最细
      cov = max(cov, 1. - smoothstep(hw - .7 / uK, hw + .7 / uK, dist));
    }
    cov *= uNeckB.w * handM;
    o = vec4(INKD * cov, cov) + o * (1. - cov);
  }
  // —— 皇冠溅：6 粒墨点弹起再落回 ——
  if (uCrown.z >= 0. && uCrown.z <= 1.) {
    float pr = uCrown.z;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float ang = -BB_PI * (.15 + .7 * (fi + .5 * bbH1(fi * 7. + 3.)) / 6.);
      float hgt = (30. + 30. * bbH1(fi * 11. + 1.)) * uCrown.w;
      float rr = (2.2 + 1.6 * bbH1(fi * 5. + 9.)) * uCrown.w;
      float hor = (14. + 22. * bbH1(fi * 3. + 4.)) * uCrown.w;
      vec2 c0 = uCrown.xy + vec2(cos(ang) * hor * pr * 1.6, -hgt * 4. * pr * (1. - pr));
      float c = (1. - smoothstep(rr - .8 / uK, rr + .8 / uK, length(p - c0))) * (1. - smoothstep(.85, 1., pr));
      o = vec4(vec3(.169, .149, .133) * c, c) + o * (1. - c);
    }
  }
  // —— 落背冲击环（w3，qa2-04）：墨滴落上豹背的那一下，一圈深色墨环向外一冲（略扁，豹背是斜着看的）——
  if (uImpact.w > 0.) {
    vec2 q = (p - uImpact.xy) * vec2(1., 1.30);
    float ang = atan(q.y, q.x);
    // 不是一圈规整的靶环：线宽随角度起伏（墨往两侧和下方甩得多），并断成几截
    float wv = .55 + .9 * bbVN(vec2(ang * 2.2 + 3.1, 1.7)) + .35 * max(sin(ang), 0.);
    float brk = smoothstep(.10, .24, bbVN(vec2(ang * 2.6 + 9.2, 4.2)));
    float dd = abs(length(q) - uImpact.z * (1. + .06 * (bbVN(vec2(ang * 3.7, 8.8)) - .5)));
    float hw = uImpactW * wv;
    float c = (1. - smoothstep(hw - .8 / uK, hw + .8 / uK, dd)) * brk * uImpact.w;
    o = vec4(INKD * c, c) + o * (1. - c);
  }
  // —— 雨打水花（白色小圈）——
  for (int i = 0; i < 6; i++) {
    if (uHit[i].z <= 0. || uHit[i].z >= 1.) continue;
    float rr = uHit[i].w * (.4 + .6 * uHit[i].z);
    float d = abs(length(p - uHit[i].xy) - rr);
    float c = (1. - smoothstep(.6 / uK, 1.4 / uK, d)) * (1. - uHit[i].z) * .8;
    o = vec4(RAIN * c, c) + o * (1. - c);
  }
  // —— 浮尘（只在光柱里）——
  if (uDust > 0.) {
    // 光柱：过 (uShaft.x, uShaft.y)、沿 35° 斜向的一条带，半宽 uShaft.w
    float acc = 0.;
    for (int i = 0; i < 40; i++) {
      float fi = float(i);
      vec2 base = vec2(bbH1(fi * 3.1 + 1.) * 1920., bbH1(fi * 5.7 + 2.) * 1040.);
      vec2 drift = vec2(sin(uTime * (.21 + .17 * bbH1(fi + 7.)) + fi) * 40., -uTime * (6. + 10. * bbH1(fi + 11.)) + sin(uTime * .37 + fi * 1.3) * 18.);
      vec2 q = base + drift; q.y = mod(q.y, 1040.);
      float sz = 1.5 + 1.5 * bbH1(fi * 13. + 4.);
      float c = 1. - smoothstep(sz * .5, sz * .5 + 1. / uK, length(p - q));
      float sh = 1. - smoothstep(uShaft.w * .6, uShaft.w, abs(dot(q - uShaft.xy, vec2(.5736, .8192))));
      acc += c * sh * (.35 + .4 * bbH1(fi * 17.));
    }
    o.rgb += vec3(1., .945, .784) * clamp(acc * uDust, 0., 1.) * .6;
  }
  // —— 白金闪的幕（w3，qa2-03）——
  if (uVeil.w > 0.) o = vec4(uVeil.rgb * uVeil.w, uVeil.w) + o * (1. - uVeil.w);
  gl_FragColor = o;
}`;

// 加色层：白金闪、闪（四角星）、光晕、镜片斜亮带、暖色小光点、整屏曝光闪
const FS_ADD = /* glsl */`
${GLSL_COMMON}
uniform float uK; uniform vec2 uRes;
uniform vec4 uFlash;             // rgb, 强度
uniform vec4 uGl[8];             // 闪：x, y, L（设计像素）, 强度 s（0..1+）
uniform float uGlHalo;           // 光晕强度系数
uniform vec4 uBand;              // 斜 35° 亮带：中心偏移（沿法线，像素）, 宽, alpha, 角度(弧度)
uniform vec4 uDot;               // 暖色小光点：x, y, 直径, 强度
uniform vec4 uArc;               // 细金弧（fix2，story-12：S6 镜片外框）：圆心 x, y, 半径, 强度
uniform vec4 uArcB;              // 弧的中心角（弧度，屏幕 y 向下）、半张角、线宽（设计像素）、竖向半径 / 横向半径（椭圆弧）
float star(vec2 d, float L, float rootW){
  // 两条细菱形十字交叉，两头尖
  vec2 a = abs(d);
  float h = max(1. - a.x / max(L * .5, 1e-3), 0.);
  float v = max(1. - a.y / max(L * .5, 1e-3), 0.);
  float sh = 1. - smoothstep(rootW * h * h, rootW * h * h + 1. / uK, a.y);
  float sv = 1. - smoothstep(rootW * v * v, rootW * v * v + 1. / uK, a.x);
  return max(sh * h, sv * v);
}
void main(){
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uK;
  vec3 c = uFlash.rgb * uFlash.w;
  vec3 GL = vec3(1., .965, .871);
  for (int i = 0; i < 8; i++) {
    float s = uGl[i].w; if (s <= 0.) continue;
    float L = uGl[i].z * min(s, 1.);
    vec2 d = p - uGl[i].xy;
    float r = length(d);
    float st = star(d, L, max(.012 * L, .9));
    float core = 1. - smoothstep(.067 * L, .067 * L + 1.2 / uK, r);
    float ring = (1. - smoothstep(.75 / uK, 1.6 / uK, abs(r - .117 * L))) * .8;
    float halo = exp(-r * r / max(2. * pow(.16 * L, 2.), 1.)) * .55 + exp(-r * r / max(2. * pow(.42 * L, 2.), 1.)) * .25;
    float k = max(s, 0.) * (st + core + ring) + halo * uGlHalo * max(s, 0.);
    c += GL * k;
  }
  if (uBand.z > 0.) {
    vec2 n = vec2(cos(uBand.w), sin(uBand.w));
    float d = abs(dot(p - vec2(960., 520.), n) - uBand.x);
    c += vec3(1., .94, .80) * uBand.z * (1. - smoothstep(uBand.y * .25, uBand.y * .5, d));
  }
  if (uArc.w > 0.) {
    vec2 d = p - uArc.xy; d.y /= max(uArcB.w, .2); float r = length(d);
    float da = abs(atan(sin(atan(d.y, d.x) - uArcB.x), cos(atan(d.y, d.x) - uArcB.x)));
    float fall = 1. - smoothstep(uArcB.y * .70, uArcB.y, da);
    float ln = 1. - smoothstep(uArcB.z * .5 - .6 / uK, uArcB.z * .5 + .6 / uK, abs(r - uArc.z));
    float gl = exp(-pow(r - uArc.z, 2.) / (2. * pow(uArcB.z * 1.6, 2.))) * .35;
    c += vec3(1., .86, .48) * (ln + gl) * fall * uArc.w;
  }
  if (uDot.w > 0.) {
    float r = length(p - uDot.xy);
    float k = (1. - smoothstep(uDot.z * .30, uDot.z * .5, r)) + exp(-r * r / (2. * pow(uDot.z * .6, 2.))) * .4;
    c += vec3(1., .945, .784) * k * uDot.w;
  }
  gl_FragColor = vec4(c, 1.);
}`;

export function createOverlay(renderer) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const U = {
    uK: SHARED.uK, uRes: SHARED.uRes, uTime: { value: 0 },
    uRain: { value: new THREE.Vector4() }, uRainPan: { value: 0 }, uRainNearLen: { value: 90 },
    uLine: { value: new THREE.Vector4(520, 5, 0, 1) }, uLineMask: { value: new THREE.Vector3(0, 0, 0) },
    uRingA: { value: new THREE.Vector4() }, uRingB: { value: new THREE.Vector3(6, 0, 0) },
    uDrop: { value: new THREE.Vector4() }, uDropB: { value: new THREE.Vector3(1, 0, 0) }, uDropT: { value: new THREE.Vector2(0, 0) },
    uCrown: { value: new THREE.Vector4(0, 0, -1, 1) },
    uHit: { value: [...Array(6)].map(() => new THREE.Vector4()) },
    uDust: { value: 0 }, uShaft: { value: new THREE.Vector4(700, 520, 0, 260) },
    uVeil: { value: new THREE.Vector4(1, .957, .839, 0) },
    uNeckA: { value: new THREE.Vector4() }, uNeckB: { value: new THREE.Vector4() }, uNeckC: { value: new THREE.Vector3() },
    uHandTex: { value: null }, uHandMap: { value: new THREE.Vector4(0, 0, 1, 1) }, uHandOn: { value: 0 },
    uImpact: { value: new THREE.Vector4() }, uImpactW: { value: 2 },
  };
  const UA = {
    uK: SHARED.uK, uRes: SHARED.uRes,
    uFlash: { value: new THREE.Vector4(1, .957, .839, 0) },
    uGl: { value: [...Array(8)].map(() => new THREE.Vector4()) }, uGlHalo: { value: 1 },
    uBand: { value: new THREE.Vector4(0, 300, 0, 0.6109) },
    uDot: { value: new THREE.Vector4(0, 0, 24, 0) },
    uArc: { value: new THREE.Vector4(0, 0, 50, 0) }, uArcB: { value: new THREE.Vector4(0, 1.0, 3, 1) },
  };
  const over = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: U, vertexShader: VS, fragmentShader: FS_OVER, depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  }));
  const add = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: UA, vertexShader: VS, fragmentShader: FS_ADD, depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  }));
  over.frustumCulled = add.frustumCulled = false;
  const sceneO = new THREE.Scene(); sceneO.add(over);
  const sceneA = new THREE.Scene(); sceneA.add(add);

  // 每帧状态（调用方填）
  function reset() {
    U.uRain.value.set(0, 0, 1, 0); U.uRainPan.value = 0; U.uRainNearLen.value = 90;
    U.uLine.value.z = 0; U.uLineMask.value.set(0, 0, 0); U.uRingB.value.y = 0; U.uDrop.value.w = 0; U.uDropT.value.set(0, 0); U.uCrown.value.z = -1;
    for (const h of U.uHit.value) h.z = 0;
    U.uDust.value = 0;
    U.uVeil.value.w = 0; U.uNeckB.value.w = 0; U.uNeckC.value.set(0, 0, 0); U.uHandOn.value = 0; U.uImpact.value.w = 0;
    UA.uFlash.value.w = 0; for (const g of UA.uGl.value) g.w = 0; UA.uGlHalo.value = 1;
    UA.uBand.value.z = 0; UA.uDot.value.w = 0; UA.uArc.value.w = 0;
  }
  reset();
  let nGl = 0;
  const api = {
    U, UA, reset() { reset(); nGl = 0; },
    glint(x, y, L, s) { if (nGl < 8 && s > 0) UA.uGl.value[nGl++].set(x, y, L, s); },
    render(target = null, { addLayer = true } = {}) {
      const prevAuto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(target);
      renderer.render(sceneO, cam);
      if (addLayer) renderer.render(sceneA, cam);
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(null);
    },
  };
  return api;
}
