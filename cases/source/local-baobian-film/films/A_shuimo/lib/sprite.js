// 《豹变》A 水墨 · 2D 资产着色与合成（DESIGN 3.2）
//   墨色归一：D = clamp((Lp − L)/(Lp − Li))，按当段六色重新上色；饱和处（肤色、琥珀眼）保留色相 = 原色 × 纸色
//   B 类（要遮住后景：小豹、陆蔚、手）：alpha 作遮罩，遮罩内是归一后的颜色 → 普通混合
//   A 类（白底墨画：豹头、木刻、长卷）：正片叠底 out = bg × src（白即透明），用自定义混合实现
//   网格形变：24×24 网格，控制柄（中心、半径、支点、转角、缩放、平移）+ 全身呼吸缩放；一拍二由调用方量化
//   母型 R：最多 48 枚斑在精灵像素坐标里逐像素算（rosette()），跟着网格形变走
import * as THREE from 'three';
import { U } from './core.js';
import { NOISE, PALETTE, FOG, ROSETTE } from './glsl.js';

export const NSPOT = 80, NH = 5;

const SPR_VS = /* glsl */`
uniform vec2 uImg;
uniform vec4 uH[${NH}], uHP[${NH}], uHT[${NH}];
uniform vec4 uBr;          // 呼吸：支点 y（像素）、sx、sy、支点 x
varying vec2 vUv, vPx; varying vec3 vW;
void main(){
  vec2 px = vec2(uv.x, 1. - uv.y) * uImg;
  vec2 d = vec2(0.);
  for (int i = 0; i < ${NH}; i++) {
    if (uH[i].w <= 0.) continue;
    float w = 1. - smoothstep(uH[i].z, uH[i].w, length(px - uH[i].xy));
    vec2 q = px - uHP[i].xy;
    float a = uHP[i].z * w, s = mix(1., uHP[i].w, w);
    vec2 r = vec2(cos(a) * q.x - sin(a) * q.y, sin(a) * q.x + cos(a) * q.y) * s;
    d += (r - q) + uHT[i].xy * w;
  }
  vec2 np = px + d;
  np = vec2(uBr.w + (np.x - uBr.w) * uBr.y, uBr.x + (np.y - uBr.x) * uBr.z);
  vec3 pos = vec3(np.x / uImg.x - .5, .5 - np.y / uImg.y, 0.);
  vUv = uv; vPx = px;
  vec4 wp = modelMatrix * vec4(pos, 1.);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SPR_FS = /* glsl */`
${NOISE}
${PALETTE}
${FOG}
${ROSETTE}
uniform sampler2D map;
uniform vec2 uImg;
uniform float uLp, uLi, uLod, uOp, uA0, uA1, uSatK, uFur, uFurF, uMode, uFogMul, uDmax, uDmin, uInset;
uniform vec4 uWash;                 // 淡赭洗染：rgb 色、量（内缩、正片叠底、不碰边）
uniform vec4 uSpA[${NSPOT}], uSpB[${NSPOT}], uSpC[${NSPOT}];   // A：x y R seed（像素）；B：mode prog 不透明度 斑心赭量；C：压扁比、压扁方向（弧度）
uniform int uNS;
uniform vec3 uSpInk, uSpCore, uWetC;
uniform vec4 uEye;                  // 代码琥珀眼点：x y r 量
uniform vec4 uEyeC;                 // 眼色 rgb、眼睑合上程度
uniform float uDesat, uGhost;       // 残影：去饱和、淡化
uniform float uRevT;                // 浓先淡后显影阈值 τ（<= 0 关）；B 类只改颜色（先铺纸、墨从纸上渗出来），不改遮挡
uniform float uErode;               // alpha 腐蚀半径（贴图像素）：去掉抠图边上那圈浅色（白边）
uniform vec4 uBlock;                // 笔块化（大写意）：开关、平滑 lod、焦墨点保留阈值、水渍边量
uniform vec4 uLine;                 // 人物线条加重：开关、加粗半径（贴图像素）、肤色内缩半径（贴图像素）、线条墨浓
uniform vec4 uTipBlob;              // 尾尖焦墨团：x y r 量
uniform vec2 uClip;                 // 只画图像 y 在 [x, y] 之间的部分（同一张画切成两片、分别排层序时用）
uniform vec4 uOch;                  // 浅绛赭石（长卷底板用）：rgb 赭色、量——只上在"清—淡"的中间调（山坡受光面），成块、边软，叠在墨上
uniform vec2 uOchY;                 // 只上在图的这一段高度以下（近处的山坡；远峰留给花青）：图高比例 [起, 满]
uniform vec2 uFadeB;                // 图底部按 y（图像素）淡出：[起, 尽]（资产底边是裁切直线时，让它化进接着画下去的部分）
uniform vec4 uRimInk;               // 轮廓外那一圈亮边压回轮廓墨色：开关、离透明边的半径、找轮廓线的半径（贴图像素）
uniform vec4 uVeil;                 // 画右缘的近雾（只罩这一张精灵）：量、起 x、满 x（屏幕设计像素）
varying vec2 vUv, vPx; varying vec3 vW;
float Dof(vec3 c){ return clamp((uLp - lum(c)) / max(uLp - uLi, .02), 0., 1.); }
void main(){
  if (vPx.y < uClip.x || vPx.y > uClip.y) discard;
  vec4 tx = texture(map, vUv, uLod);
  float a = tx.a;
  if (uErode > 0.) {
    vec2 e = uErode / uImg;
    float m = min(min(texture(map, vUv + vec2(e.x, 0.), uLod).a, texture(map, vUv - vec2(e.x, 0.), uLod).a), min(texture(map, vUv + vec2(0., e.y), uLod).a, texture(map, vUv - vec2(0., e.y), uLod).a));
    m = min(m, min(min(texture(map, vUv + e * .7, uLod).a, texture(map, vUv - e * .7, uLod).a), min(texture(map, vUv + vec2(e.x, -e.y) * .7, uLod).a, texture(map, vUv + vec2(-e.x, e.y) * .7, uLod).a)));
    float Lx = lum(tx.rgb), sx = max(tx.r, max(tx.g, tx.b)) - min(tx.r, min(tx.g, tx.b));
    float ab = texture(map, vUv, uLod + log2(max(uErode, 1.)) + 1.6).a;
    float halo = step(.80, Lx) * (1. - smoothstep(.05, .10, sx)) * (1. - smoothstep(.86, .97, ab));
    // 腐蚀后再羽化：边上一圈按略虚的 alpha 收，阶梯与碎点被抹平
    float soft = texture(map, vUv, uLod + 1.2).a;
    a = min(a, mix(m, min(m, soft), .5)) * (1. - halo);
  }
  if (uFadeB.y > uFadeB.x) a *= 1. - smoothstep(uFadeB.x, uFadeB.y, vPx.y + 10. * (vn2(vec2(vPx.x / 23., 3.), 63u) - .5));
  if (uFur > 0.) a += uFur * (vn2(vPx / uFurF, 7u) - .5) * .16;
  a = smoothstep(uA0, uA1, a);
  if (a < .002) discard;
  float D = mix(uDmin, uDmax, Dof(tx.rgb));
  float sat = max(tx.r, max(tx.g, tx.b)) - min(tx.r, min(tx.g, tx.b));
  float satM = smoothstep(.06, .16, sat);
  // ── 笔块化：先平滑掉小斑驳，再压成 3 阶墨块（淡 0.25 / 重 0.55 / 浓 0.85），阶间软交界、暗侧水渍边；焦墨点只留最浓的几处
  if (uBlock.x > 0.) {
    float Ds = Dof(textureLod(map, vUv, uBlock.y).rgb) * uDmax;                      // 平滑尺度按图像像素定（推拉时块形不变）
    Ds = Ds * .78 + Dof(textureLod(map, vUv, uBlock.y + 1.2).rgb) * uDmax * .22;
    float w = .075 + 2.2 * fwidth(Ds);                                              // 返修 w3（qa2-12）：阶间交界更软，门槛加大块噪声扰动（像湿墨洇开的边，不是色调分离）
    float tn = .07 * (vn2(vPx / 26., 39u) - .5) + .03 * (vn2(vPx / 7., 40u) - .5);
    float Dq = mix(0., .25, smoothstep(.16 - w, .16 + w, Ds + tn));
    Dq = mix(Dq, .55, smoothstep(.40 - w, .40 + w, Ds + tn));
    Dq = mix(Dq, .85, smoothstep(.64 - w, .64 + w, Ds + tn));
    float ws = 0.;
    for (int i = 0; i < 3; i++) { float t = i == 0 ? .16 : i == 1 ? .40 : .64; float dd = Ds + tn - t; ws += smoothstep(-.01, .01, dd) * (1. - smoothstep(0., 2.2 * fwidth(Ds) + .03, dd)); }
    Dq += uBlock.w * ws;
    Dq *= .93 + .10 * vn2(vPx / 11., 37u);                                          // 块内墨不匀：湿墨的浓淡
    float foc = smoothstep(uBlock.z, uBlock.z + .08, D);                            // 眼眶、鼻、耳尖、爪尖：原画最浓处保留
    Dq = mix(Ds, Dq, .72);                                                         // 只压七成：块里留一点湿墨的浓淡
    D = mix(Dq, max(Dq, D), foc * uBlock.x) * uBlock.x + D * (1. - uBlock.x);
  }
  // ── 人物线条：加粗、加浓；肤色只铺在线内、离线内缩
  float lineNear = 0.;
  if (uLine.x > 0.) {
    vec2 e = uLine.y / uImg, e2 = uLine.z / uImg;
    float Lmin = lum(tx.rgb), Lmin2 = Lmin;
    for (int i = 0; i < 8; i++) {
      float an = float(i) * .7853982;
      vec2 o = vec2(cos(an), sin(an));
      vec4 s1 = texture(map, vUv + o * e, uLod);
      vec4 s2 = texture(map, vUv + o * e2, uLod);
      float sat1 = max(s1.r, max(s1.g, s1.b)) - min(s1.r, min(s1.g, s1.b));
      float sat2 = max(s2.r, max(s2.g, s2.b)) - min(s2.r, min(s2.g, s2.b));
      if (s1.a > .5 && sat1 < .12) Lmin = min(Lmin, lum(s1.rgb));
      if (s2.a > .5 && sat2 < .12) Lmin2 = min(Lmin2, lum(s2.rgb));
    }
    float Dl = Dof(vec3(Lmin)), Dl2 = Dof(vec3(Lmin2));
    float isLine = smoothstep(.45, .75, Dl) * (1. - satM * .7);
    D = max(D, isLine * uLine.w * (.86 + .14 * vn2(vPx / 6., 38u)));
    lineNear = smoothstep(.45, .75, Dl2);
  }
  // ── 返修第 3 轮（v2-07）：B 类人物 / 手的轮廓线外侧常有 1–3 个贴图像素的浅色抠图残边，衬在焦墨洞口或冷雾上读成一道亮边（像贴纸）：
  //    离透明边 uRimInk.y 以内、本身是浅色、往里 uRimInk.z 以内有轮廓墨线的像素，直接压成轮廓线的墨
  if (uRimInk.x > 0.) {
    float edgeN = 1., Lm = 1.;
    float tpp = max(1., max(fwidth(vPx.x), fwidth(vPx.y)));                          // 每个屏幕像素合多少贴图像素（缩小显示时半径跟着放大）
    for (int i = 0; i < 8; i++) {
      float an = float(i) * .7853982 + .39;
      vec2 o = vec2(cos(an), sin(an)) / uImg;
      edgeN = min(edgeN, texture(map, vUv + o * uRimInk.y * min(tpp, 2.2), uLod).a);
      vec4 s2 = texture(map, vUv + o * uRimInk.z * tpp, uLod);
      float sat2 = max(s2.r, max(s2.g, s2.b)) - min(s2.r, min(s2.g, s2.b));
      if (s2.a > .5 && sat2 < .14) Lm = min(Lm, lum(s2.rgb));
    }
    float Dl = max(Dof(vec3(Lm)), .97);                                              // 轮廓外缘一律按焦墨（衬在焦墨洞口上也不亮出一道边）
    float pull = (1. - smoothstep(.30, .72, edgeN)) * (1. - smoothstep(.40, .62, D));
    D = mix(D, max(D, Dl), pull);
    satM *= 1. - pull;
  }
  // ── 母型 R：斑一律减色叠墨，外圈一层淡墨晕（湿毛上才有，毛色越浓晕越重）
  float inkAcc = 0., haloAcc = 0., coreAcc = 0.;
  for (int i = 0; i < ${NSPOT}; i++) {
    if (i >= uNS) break;
    vec4 A = uSpA[i], B = uSpB[i], C = uSpC[i];
    vec2 p = vPx - A.xy;
    if (C.x > 0. && C.x < .999) { float ca = cos(C.y), sa = sin(C.y); p = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y); p.x /= C.x; }
    if (dot(p, p) > 4.4 * A.z * A.z || B.z <= 0.) continue;
    vec4 r = rosette(p, A.z, A.w, B.x, B.y);
    float k = smoothstep(.2, .6, tx.a) * B.z;
    float ink = clamp(r.x + r.z, 0., 1.) * k;
    inkAcc = 1. - (1. - inkAcc) * (1. - .9 * ink);
    haloAcc = max(haloAcc, r.w * k);
    coreAcc = max(coreAcc, r.y * B.w * smoothstep(.2, .6, tx.a));
  }
  if (uTipBlob.w > 0.) {
    vec2 p = vPx - uTipBlob.xy;
    float nz = (vn2(p / (.35 * uTipBlob.z), 39u) - .5) * .45 * uTipBlob.z;
    float b = (1. - smoothstep(.55 * uTipBlob.z, 1.05 * uTipBlob.z, length(p) + nz)) * uTipBlob.w;
    inkAcc = 1. - (1. - inkAcc) * (1. - .95 * b);
  }
  D = 1. - (1. - D) * (1. - inkAcc);
  D = 1. - (1. - D) * (1. - haloAcc * (.45 + .9 * D));
  vec3 col = rampS(D);
  vec3 hueC = tx.rgb * uPal[0] / max(uLp, .5);
  float skinK = satM * uSatK * (1. - inkAcc) * (1. - lineNear);
  col = mix(col, hueC, skinK);
  if (uLine.x > 0.) {                                                               // 肤色淡彩的内缘：一道淡赭水渍边（唯一的体积）
    float edgeW = smoothstep(.15, .5, lineNear) * (1. - smoothstep(.5, .95, lineNear));
    col *= 1. - .06 * edgeW * satM;
  }
  // 淡赭洗染（内缩：只在 alpha 很实的地方、离边远的地方）
  if (uWash.w > 0.) {
    float inA = smoothstep(uInset, 1., texture(map, vUv, 3.).a) * smoothstep(.9, 1., tx.a);
    float n = .75 + .25 * vn2(vPx / 40., 19u);
    col *= mix(vec3(1.), uWash.rgb / max(uPal[0], vec3(.01)), uWash.w * inA * n);
  }
  if (uOch.w > 0.) {
    float mid = smoothstep(.05, .16, D) * (1. - smoothstep(.40, .64, D));
    float nz = smoothstep(.30, .50, vn2(vPx / 150., 61u) * .62 + vn2(vPx / 52., 62u) * .38);
    float low = smoothstep(uOchY.x, uOchY.y, vPx.y / uImg.y);
    vec3 oc = uOch.rgb * (.74 * lum(col) / max(lum(uOch.rgb), .05));               // 换成赭色、压暗一档（参考里赭石是中间调的褐赭，比纸深得多）
    col = mix(col, oc, clamp(uOch.w * mid * nz * low, 0., .80));
  }
  col = mix(col, uSpCore, coreAcc);
  // 代码琥珀眼点（全片唯一的亮色点）
  if (uEye.w > 0.) {
    float e = 1. - smoothstep(uEye.z * .55, uEye.z, length(vPx - uEye.xy));
    vec3 ec = mix(uEyeC.rgb, rampS(.55), uEyeC.w);
    col = mix(col, ec, e * uEye.w);
  }
  if (uDesat > 0.) col = mix(col, vec3(lum(col)), uDesat);
  if (uRevT > 0.) {
    float rv = smoothstep(uRevT - .08, uRevT + .08, D + .06 * fbm2(vPx / 40., 33u));
    if (uMode > .5) a *= rv;                                                        // A 类：没显出来的地方就是纸（叠底为白）
    else col = mix(uPal[0], col, rv);                                               // B 类：人形先铺纸挡住后景，墨再从纸上渗出来
  }
  col = mix(col, uPal[0], fogAmt(length(vW - cameraPosition), vW.y) * uFogMul);
  if (uVeil.x > 0.) {
    vec2 sq = gl_FragCoord.xy / uK;
    float vx = sq.x + 46. * (vn2(vec2(sq.x / 70., sq.y / 110.), 66u) - .5);
    col = mix(col, uPal[0], uVeil.x * smoothstep(uVeil.y, uVeil.z, vx));
  }
  if (uMode > .5) gl_FragColor = vec4(mix(vec3(1.), col / max(uPal[0], vec3(.01)), a * uOp), 1.);   // A 类
  else gl_FragColor = vec4(col, a * uOp);                                                            // B 类
}`;

const PLANE = new THREE.PlaneGeometry(1, 1, 24, 24);
const PLANE1 = new THREE.PlaneGeometry(1, 1, 1, 1);

// tex：THREE.Texture；meta：{ Lp, Li }；o：选项
export function sprite(tex, meta, o = {}) {
  const img = tex.image;
  const mode = o.mode === 'A' ? 1 : 0;
  const uni = {
    uPal: U.uPal, uFogA: U.uFogA, uFogB: U.uFogB, uK: U.uK, uT: U.uT,
    map: { value: tex }, uImg: { value: new THREE.Vector2(img.width, img.height) },
    uLp: { value: meta.Lp ?? 0.95 }, uLi: { value: meta.Li ?? 0.15 }, uLod: { value: o.lod ?? 0 }, uOp: { value: o.op ?? 1 },
    uA0: { value: o.a0 ?? 0.30 }, uA1: { value: o.a1 ?? 0.80 }, uSatK: { value: o.satK ?? 1 }, uFur: { value: o.fur ?? 0 }, uFurF: { value: o.furF ?? 3 },
    uMode: { value: mode }, uFogMul: { value: o.fogMul ?? 1 }, uDmax: { value: o.dmax ?? 1 }, uDmin: { value: o.dmin ?? 0 }, uInset: { value: 0.85 },
    uWash: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSpA: { value: Array.from({ length: NSPOT }, () => new THREE.Vector4()) }, uSpB: { value: Array.from({ length: NSPOT }, () => new THREE.Vector4()) },
    uSpC: { value: Array.from({ length: NSPOT }, () => new THREE.Vector4(1, 0, 0, 0)) },
    uBlock: { value: new THREE.Vector4(0, 4.0, 0.9, 0.08) }, uLine: { value: new THREE.Vector4(0, 2, 5, 0.82) }, uTipBlob: { value: new THREE.Vector4(0, 0, 0, 0) },
    uNS: { value: 0 },
    uSpInk: { value: new THREE.Vector3(0.1, 0.1, 0.1) }, uSpCore: { value: new THREE.Vector3(0.7, 0.6, 0.43) }, uWetC: { value: new THREE.Vector3(0.3, 0.34, 0.36) },
    uEye: { value: new THREE.Vector4(0, 0, 0, 0) }, uEyeC: { value: new THREE.Vector4(0.85, 0.59, 0.24, 0) },
    uH: { value: Array.from({ length: NH }, () => new THREE.Vector4()) }, uHP: { value: Array.from({ length: NH }, () => new THREE.Vector4(0, 0, 0, 1)) },
    uHT: { value: Array.from({ length: NH }, () => new THREE.Vector4()) },
    uBr: { value: new THREE.Vector4(img.height, 1, 1, img.width / 2) },
    uDesat: { value: 0 }, uGhost: { value: 0 }, uRevT: { value: 0 }, uErode: { value: o.erode ?? 0 }, uClip: { value: new THREE.Vector2(-1e9, 1e9) }, uOch: { value: new THREE.Vector4(0, 0, 0, 0) }, uOchY: { value: new THREE.Vector2(0, 1) }, uFadeB: { value: new THREE.Vector2(0, 0) }, uRimInk: { value: new THREE.Vector4(o.rimInk ? 1 : 0, ...(o.rimInk || [0, 0]), 0) }, uVeil: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: uni, vertexShader: SPR_VS, fragmentShader: SPR_FS, transparent: true, depthWrite: false, depthTest: o.depthTest ?? true,
    side: THREE.DoubleSide,
  });
  if (mode === 1) {
    mat.blending = THREE.CustomBlending; mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.ZeroFactor; mat.blendDst = THREE.SrcColorFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor; mat.blendDstAlpha = THREE.OneFactor;
  }
  const m = new THREE.Mesh(o.deform === false ? PLANE1 : PLANE, mat);
  m.renderOrder = o.order ?? 10; m.frustumCulled = false;
  m.userData.aspect = img.width / img.height; m.userData.img = [img.width, img.height];
  return m;
}

// 控制柄：i 号；c 中心像素、r0/r1 影响半径（像素）、pivot 支点、ang 转角（弧度，图像坐标系里正值为顺时针）、sc 缩放、tr 平移（像素）
export function setHandle(m, i, { c, r0, r1, pivot, ang = 0, sc = 1, tr = [0, 0] }) {
  const u = m.material.uniforms;
  u.uH.value[i].set(c[0], c[1], r0, r1);
  u.uHP.value[i].set((pivot || c)[0], (pivot || c)[1], ang, sc);
  u.uHT.value[i].set(tr[0], tr[1], 0, 0);
}
export function clearHandles(m) { const u = m.material.uniforms; for (let i = 0; i < NH; i++) u.uH.value[i].set(0, 0, 0, 0); }
export function setBreath(m, pivotY, sx, sy, pivotX) { const u = m.material.uniforms; u.uBr.value.set(pivotY, sx, sy, pivotX ?? m.userData.img[0] / 2); }
// 斑：list = [{x, y, R, seed, mode, prog, op, core}]
export function setSpots(m, list) {
  const u = m.material.uniforms; const n = Math.min(NSPOT, list.length);
  for (let i = 0; i < n; i++) { const s = list[i]; u.uSpA.value[i].set(s.x, s.y, s.R, s.seed); u.uSpB.value[i].set(s.mode, s.prog, s.op ?? 1, s.core ?? 0); u.uSpC.value[i].set(s.sq ?? 1, s.sqA ?? 0, 0, 0); }
  u.uNS.value = n;
}
