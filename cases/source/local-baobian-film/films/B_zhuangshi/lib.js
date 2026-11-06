// lib.js —《豹变》B 装饰版 · 公共件
//   数学与缓动（转引 _lib/scene.js、engine/core/math.js）、颜色、确定性 GLSL 噪声、文斑（母题）距离场、
//   着色器卡片（远山 / 卷云 / 雾带 / 日轮……都是放在 3D 空间里的平面卡片，内容由 SDF 着色器画，任何分辨率都清楚）、
//   2D 赛璐珞精灵（彩色层 + 只写深度的遮罩层；顶点分区形变；alpha 与线稿按 fwidth 重新截边，放大不发软）。
// 确定性：这里没有随机数、没有时间读取；一切由调用方传入的 t / 帧号决定。
import * as THREE from 'three';
export { DEG, clamp, lerp, seg, ss, ss5, eio, eo, hashi, aimCamera, placeOnScreen, screenToWorld, project, dirOf } from '/films/_lib/scene.js';
export { monotone, mulberry } from '/engine/core/math.js';
import { clamp, placeOnScreen } from '/films/_lib/scene.js';

// ───────────────────────── 全局：画面尺寸与 K ─────────────────────────
export const W = innerWidth, H = innerHeight, K = H / 1040;
export const SHARED = {
  uK: { value: K },
  uRes: { value: new THREE.Vector2(W, H) },
  uT: { value: 0 },          // 连续时间（秒）
  uTc: { value: 0 },         // 一拍二时间（秒）
};

// ───────────────────────── 颜色 ─────────────────────────
// 线性工作空间（three 的 Color 会把 #hex 从 sRGB 转成线性）
export const lin = hex => new THREE.Color(hex);
export const lin3 = hex => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };
// 原始 sRGB 分量（叠加层直接写屏幕用）
export const srgb3 = hex => { const c = new THREE.Color(hex); const o = {}; c.getRGB(o, THREE.SRGBColorSpace); return new THREE.Vector3(o.r, o.g, o.b); };
export const mixHex = (a, b, t) => { const A = new THREE.Color(a), B = new THREE.Color(b); return A.lerp(B, t); };   // 线性空间插值

// 帧号工具
export const F = t => Math.round(t * 24);
export const tcOf = t => { const f = Math.round(t * 24); return (f - (f & 1)) / 24; };   // 一拍二
export const fseg = (f, a, b) => clamp((f - a) / (b - a));
// 对数线性插值：keys [[帧, 值], ...]
export function loglin(keys) {
  return f => {
    if (f <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [f0, v0] = keys[i], [f1, v1] = keys[i + 1];
      if (f <= f1) { const u = (f - f0) / (f1 - f0); return Math.exp(Math.log(v0) + (Math.log(v1) - Math.log(v0)) * u); }
    }
    return keys[keys.length - 1][1];
  };
}
// 分段线性
export function plin(keys) {
  return f => {
    if (f <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [f0, v0] = keys[i], [f1, v1] = keys[i + 1];
      if (f <= f1) return v0 + (v1 - v0) * (f - f0) / (f1 - f0);
    }
    return keys[keys.length - 1][1];
  };
}
// 二次贝塞尔（屏幕点）
export const qbez = (P0, P1, P2, u) => [
  (1 - u) * (1 - u) * P0[0] + 2 * (1 - u) * u * P1[0] + u * u * P2[0],
  (1 - u) * (1 - u) * P0[1] + 2 * (1 - u) * u * P1[1] + u * u * P2[1]];

// ───────────────────────── GLSL：哈希、噪声、色彩空间、文斑 ─────────────────────────
export const GLSL_COMMON = /* glsl */`
#ifndef BB_COMMON
#define BB_COMMON
#define BB_PI 3.14159265
#define BB_TAU 6.2831853
uint bbPcg(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float bbH1(float n){ return float(bbPcg(uint(int(floor(n)) + 1048576))) * (1.0 / 4294967295.0); }
float bbH2(vec2 p){ ivec2 i = ivec2(floor(p)) + 1048576; return float(bbPcg(uint(i.x) + bbPcg(uint(i.y)))) * (1.0 / 4294967295.0); }
float bbVN(vec2 x){
  vec2 i = floor(x), f = fract(x); vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = bbH2(i), b = bbH2(i + vec2(1., 0.)), c = bbH2(i + vec2(0., 1.)), d = bbH2(i + vec2(1., 1.));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float bbFbm(vec2 p){ float s = 0., a = .5; for (int k = 0; k < 4; k++){ s += a * bbVN(p); p = p * 2.03 + vec2(17.1, 9.3); a *= .5; } return s / .9375; }
float bbFbm2(vec2 p){ float s = 0., a = .5; for (int k = 0; k < 2; k++){ s += a * bbVN(p); p = p * 2.03 + vec2(17.1, 9.3); a *= .5; } return s / .75; }
vec3 bbS2L(vec3 c){ return mix(c / 12.92, pow((c + .055) / 1.055, vec3(2.4)), step(.04045, c)); }
vec3 bbL2S(vec3 c){ c = max(c, 0.); return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
float bbLum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
// 以像素为单位的抗锯齿边：d 为带符号距离（任意单位），返回覆盖率
float bbFill(float d){ float w = max(fwidth(d), 1e-5); return 1. - smoothstep(-w, w, d); }
float bbFillF(float d, float fe){ float w = max(fwidth(d), 1e-5) + fe; return 1. - smoothstep(-w, w, d); }
float bbSmin(float a, float b, float k){ float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }

// —— 文斑（母题：四瓣月牙围成的环）——
// q：以半径 R 归一、已按 rot 反转的局部坐标；idx：哈希序号；gap：四段缺口（弧度）；T：瓣厚（R 单位）
float bbWbRho(float th, float idx){
  float p1 = BB_TAU * bbH1(idx * 7.13 + 1.), p2 = BB_TAU * bbH1(idx * 3.37 + 2.);
  return 1. + .06 * sin(3. * th + p1) + .03 * sin(5. * th + p2);
}
float bbWbPetal(vec2 q, float idx, vec4 gap, float T){
  float r = length(q), th = atan(q.y, q.x); if (th < 0.) th += BB_TAU;
  float rho = bbWbRho(th, idx), rc = .80 * rho;
  float P = (BB_TAU - (gap.x + gap.y + gap.z + gap.w)) * .25;
  float a = gap.x * .5, best = 1e3;
  for (int i = 0; i < 4; i++){
    float gi = i == 0 ? 0. : (i == 1 ? gap.y : (i == 2 ? gap.z : gap.w));
    a += gi;
    float mid = a + P * .5;
    float dth = mod(th - mid + BB_PI, BB_TAU) - BB_PI;
    float phi = dth / (P * .5);
    float hh = bbH1(idx * 13.7 + float(i) * 31.1 + 5.);
    float w = T * (.85 + .3 * hh) * pow(max(1. - abs(phi), 0.), .7) * .5;
    float d = abs(r - rc) - w;
    if (abs(phi) > 1.) d = max(d, (abs(dth) - P * .5) * rc);
    best = min(best, d);
    a += P;
  }
  return best;
}
float bbWbCenter(vec2 q, float idx){
  float th = atan(q.y, q.x); if (th < 0.) th += BB_TAU;
  float rho = bbWbRho(th, idx);
  return 1. - smoothstep(.55 * rho - .125, .55 * rho + .125, length(q));
}
vec2 bbRot(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c * p.x + s * p.y, -s * p.x + c * p.y); }   // 反转 a
// 指尖墨渍（fix1，story-03 / style-21）：一团湿墨落在指尖皮肤上（不在指甲面上）——不规则洇边、外圈干墨边、
// 顺手指方向往掌心拖一道干笔蹭痕；ringK > 0 时内部隐约透出四瓣环（只给 A 点那枚，rot −18°，母题同形）。
// p：以 R 归一的局部坐标（图像像素系），smearA：蹭痕方向角，ringA：环的旋转角，wash：被雨冲开的程度 0..1。返回线性色 + alpha
vec4 bbInkSmudge(vec2 p, float idx, float smearA, float ringA, float ringK, float wash){
  vec2 q = bbRot(p, smearA);
  float r = length(q), th = atan(q.y, q.x);
  float wob = .13 * (bbFbm(q * 2.3 + idx * 3.7) - .5) * 2. + .05 * sin(5. * th + idx * 2.1) + .03 * (bbVN(q * 9. + idx) - .5) * 2.;
  float dB = r - (1. + wob) * (1. + .15 * wash);
  float aa = max(fwidth(r), 1e-4) * 1.2;
  float blob = 1. - smoothstep(-.10 - aa - .06 * wash, .06 + aa + .06 * wash, dB);
  float rim = (1. - smoothstep(0., .17, abs(dB + .10))) * blob;
  float sx = (q.x - .25) / 1.95;
  float w = mix(.58, .10, clamp(sx, 0., 1.));
  float yc = q.y - .10 * sin(q.x * 1.8 + idx);
  float dry = smoothstep(.30, .62, bbFbm(vec2(q.x * 1.2, q.y * 8.) + idx * 5.1));
  float smear = (1. - smoothstep(w - .08 - aa, w + .08 + aa, abs(yc))) * step(0., sx) * (1. - smoothstep(.75, 1., sx)) * dry;
  vec3 INK = vec3(.0242, .0194, .0159), INKI = vec3(.0400, .0340, .0280), INKS = vec3(.0423, .0356, .0284);
  vec3 c = mix(INKI, INK, max(rim, smoothstep(.2, .9, r)));
  if (ringK > 0.) {
    vec2 qr = bbRot(p, ringA);
    float d = bbWbPetal(qr, idx, vec4(.6981, .1047, .1047, .1047), .40);
    c = mix(c, INK, (1. - smoothstep(-.06 - aa, .06 + aa, d)) * ringK);
  }
  float a = max(blob * mix(.92, .60, wash), smear * .38 * (1. - .4 * wash));
  c = mix(INKS, c, blob / max(a, 1e-3) * mix(.92, .60, wash));
  return vec4(c, clamp(a, 0., 1.));
}
// 化开（fix1，story-08 / style-20 / tech-10）：一道横向干笔刷边自右向左推过去（像颜料在绢上一笔笔铺开），
// 边是横向拉长约 7 倍的干笔纹、清楚但不碎；推进按 ss 缓入缓出、每帧平滑移动，不再有一块块跳出来的孤岛。
// p 设计像素（屏幕），u 0→1；返回 1 = 已化开成新画面
float bbSpread(vec2 p, float u){
  if (u <= 0.) return 0.; if (u >= 1.) return 1.;
  float e = u * u * (3. - 2. * u);
  float n = bbFbm(vec2(p.x * .0011, p.y * .0085) + vec2(3.7, 1.3)) - .5;
  float n2 = bbFbm(vec2(p.x * .004, p.y * .03) + 9.1) - .5;
  float xf = mix(2250., -330., e);
  float d = (p.x + 300. * n + 70. * n2) - xf;
  return smoothstep(-38., 38., d);
}
#endif
`;

// ───────────────────────── 着色器卡片 ─────────────────────────
const UNIT = new THREE.PlaneGeometry(1, 1);
export const CARD_VS = /* glsl */`
varying vec2 vUv; varying vec3 vWorld;
void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
// frag：片元主体，要写 gl_FragColor（线性色、直通 alpha）。可用 vUv、vWorld、uK、uRes、uT、uTc
export function cardMat(frag, uniforms = {}, o = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...SHARED, ...uniforms },
    vertexShader: o.vs || CARD_VS,
    fragmentShader: GLSL_COMMON + '\nuniform float uK, uT, uTc; uniform vec2 uRes;\nvarying vec2 vUv; varying vec3 vWorld;\n' + frag,
    transparent: o.transparent ?? true, depthWrite: o.depthWrite ?? false, depthTest: o.depthTest ?? true,
    blending: o.blending ?? THREE.NormalBlending, side: o.side ?? THREE.FrontSide, toneMapped: false,
  });
}
export function card(mat, order = 0, geo = UNIT) {
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false;
  return m;
}
// 按参考机位把卡片摆到屏幕矩形（中心 cx, cy，宽 wpx，高 hpx）、深度 D
export function putCard(m, cam, cx, cy, wpx, hpx, D) {
  m.userData.aspect = wpx / hpx;
  placeOnScreen(m, cam, W, H, cx * K, cy * K, wpx * K, D, hpx * K);
  return m;
}
// 每帧随相机摆（全屏背景、贴相机的特效卡）
export function putScreen(m, cam, D, margin = 1.02) {
  placeOnScreen(m, cam, W, H, W / 2, H / 2, W * margin, D, H * margin);
}

// ───────────────────────── 贴图 ─────────────────────────
const loader = new THREE.TextureLoader();
export async function loadTex(url, { srgb = true, mip = true } = {}) {
  const t = await loader.loadAsync(url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8; t.generateMipmaps = mip;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ───────────────────────── 2D 赛璐珞精灵 ─────────────────────────
// 图像像素坐标（原点左上、y 向下）里做分区形变：最多 3 个旋转区 + 1 个纵向呼吸区 + 整体压扁拉长 / 倾斜（绕轴心）。
// 片元：alpha 按 fwidth 重新截边；放大时把线稿边界也重新截边（白身 / 线的边界按 50% 等值线锐化），4K 与 1080 一致。
const SPRITE_VS = /* glsl */`
uniform vec2 uImg;              // 图像尺寸（像素）
uniform vec4 uRotP[3];          // 旋转区：轴心 x, y, 角度（弧度，屏幕顺时针为正）, 开关
uniform vec4 uRotR[3];          // 旋转区矩形 x0, y0, x1, y1
uniform float uRotF[3];         // 羽化（像素）
uniform vec4 uBre;              // 呼吸区矩形
uniform vec3 uBreP;             // 呼吸：轴心 y、纵向缩放增量、羽化
uniform vec4 uGlo;              // 整体：轴心 x, y, 横向缩放, 纵向缩放
uniform float uLean;            // 整体绕轴心倾斜（弧度，顺时针为正）
uniform vec2 uShear;            // fix3：水平剪切——x 轴心 y（图像像素），y 每往上 1 像素向右移多少（脚不动、头往前；S4d 起身中间张用）
uniform vec4 uCrop;             // 只显示图像的一块（uv：u0, v0, u1, v1；v 从上往下）；默认 0,0,1,1
varying vec2 vUv; varying vec2 vPx;
float bbBox(vec2 p, vec4 r, float f){
  vec2 a = smoothstep(r.xy - f, r.xy + f, p), b = 1. - smoothstep(r.zw - f, r.zw + f, p);
  return a.x * a.y * b.x * b.y;
}
vec2 bbRotCW(vec2 p, vec2 c, float a){ vec2 d = p - c; float co = cos(a), si = sin(a); return c + vec2(co * d.x - si * d.y, si * d.x + co * d.y); }
void main(){
  vec2 uv0 = mix(uCrop.xy, uCrop.zw, vec2(uv.x, 1. - uv.y));     // 图像 uv（v 向下）
  vec2 p = uv0 * uImg;
  vPx = p; vUv = vec2(uv0.x, 1. - uv0.y);
  // 呼吸
  float wb = bbBox(p, uBre, uBreP.z);
  p.y = uBreP.x + (p.y - uBreP.x) * (1. + uBreP.y * wb);
  for (int i = 0; i < 3; i++){
    if (uRotP[i].w < .5) continue;
    float w = bbBox(vPx, uRotR[i], uRotF[i]);
    p = bbRotCW(p, uRotP[i].xy, uRotP[i].z * w);
  }
  p.x += (uShear.x - p.y) * uShear.y;
  p = uGlo.xy + (p - uGlo.xy) * uGlo.zw;
  p = bbRotCW(p, uGlo.xy, uLean);
  // 回到面片局部坐标：面片 1×1 对应 crop 区域
  vec2 cuv = (p / uImg - uCrop.xy) / (uCrop.zw - uCrop.xy);
  vec3 pos = vec3(cuv.x - .5, .5 - cuv.y, 0.);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.);
}`;

// 片元主体由 opts.frag 提供（可选），在 #include 之后：可读 c（线性 rgba）、cs（sRGB rgb）、vPx、vUv；写 col（线性）与 a
const SPRITE_FS_HEAD = /* glsl */`
uniform sampler2D map; uniform vec2 uImg;
uniform vec3 uTint; uniform vec3 uAdd; uniform float uOpacity; uniform float uSharp;
uniform vec3 uLineCol; uniform float uDesat; uniform vec2 uClamp;
varying vec2 vUv; varying vec2 vPx;
`;
function spriteFS(frag) {
  return GLSL_COMMON + '\nuniform float uK, uT, uTc; uniform vec2 uRes;\n' + SPRITE_FS_HEAD + (frag?.pars || '') + /* glsl */`
void main(){
  vec4 c = texture2D(map, vec2(min(vUv.x, uClamp.x), max(vUv.y, 1. - uClamp.y)));
  float a0 = c.a;
  // alpha 重新截边（放大到 2 倍以上剪影仍是干净的）
  float wa = max(fwidth(a0), 1e-4);
  float a = smoothstep(.5 - wa, .5 + wa, a0);
  if (a < .002) discard;
  vec3 cs = bbL2S(c.rgb);
  float lum = bbLum(cs), sat = max(cs.r, max(cs.g, cs.b)) - min(cs.r, min(cs.g, cs.b));
  // 放大倍数（屏幕像素 / 纹理像素）：>1.2 倍起逐步把线稿边界重新截边
  vec2 fpx = fwidth(vPx);
  float spp = 1. / max(max(fpx.x, fpx.y), 1e-4);
  float up = smoothstep(1.2, 2.0, spp) * uSharp;
  vec3 col = c.rgb;
  ${frag?.body || ''}
  col = col * uTint + uAdd;
  col = mix(col, vec3(bbLum(col)), uDesat);
  gl_FragColor = vec4(col, a * uOpacity);
}`;
}
const MASK_FS = /* glsl */`
uniform sampler2D map; uniform vec2 uClamp; varying vec2 vUv; varying vec2 vPx;
void main(){ if (texture2D(map, vec2(min(vUv.x, uClamp.x), max(vUv.y, 1. - uClamp.y))).a < .5) discard; gl_FragColor = vec4(0.); }`;

export function makeSprite(tex, o = {}) {
  const img = new THREE.Vector2(tex.image.width, tex.image.height);
  const U = {
    ...SHARED,
    map: { value: tex }, uImg: { value: img },
    uRotP: { value: [0, 1, 2].map(() => new THREE.Vector4(0, 0, 0, 0)) },
    uRotR: { value: [0, 1, 2].map(() => new THREE.Vector4(0, 0, 1, 1)) },
    uRotF: { value: [20, 20, 20] },
    uBre: { value: new THREE.Vector4(0, 0, 0, 0) }, uBreP: { value: new THREE.Vector3(0, 0, 1) },
    uGlo: { value: new THREE.Vector4(0, 0, 1, 1) }, uLean: { value: 0 }, uShear: { value: new THREE.Vector2(0, 0) },
    uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
    uTint: { value: new THREE.Vector3(1, 1, 1) }, uAdd: { value: new THREE.Vector3(0, 0, 0) }, uOpacity: { value: 1 },
    uSharp: { value: o.sharp ?? 1 }, uLineCol: { value: lin3(o.lineCol || '#6E5340') }, uDesat: { value: 0 }, uClamp: { value: new THREE.Vector2(1, 1) },
    ...(o.uniforms || {}),
  };
  const geo = new THREE.PlaneGeometry(1, 1, o.segX ?? 48, o.segY ?? 24);
  const colorMat = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: SPRITE_VS, fragmentShader: spriteFS(o.frag), defines: o.defines || {},
    transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
  const maskMat = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: SPRITE_VS, fragmentShader: MASK_FS, colorWrite: false, depthWrite: true, side: THREE.DoubleSide,
  });
  const color = new THREE.Mesh(geo, colorMat), mask = new THREE.Mesh(geo, maskMat);
  color.renderOrder = o.order ?? 10; mask.renderOrder = (o.order ?? 10) - 0.01;
  for (const m of [color, mask]) { m.frustumCulled = false; m.userData.outline = false; }
  mask.userData.outlineOccluder = false;
  if (o.noMask) mask.visible = false;
  const g = new THREE.Group(); g.add(mask, color); g.userData.outline = false;
  return { group: g, color, mask, U, img, crop: U.uCrop.value };
}
// 指尖墨渍位置（fix1）：manifest 的墨渍锚点在指甲面上；沿手指方向（指尖 → 手腕）往里挪 3.4 个墨渍半径，落到指甲后面的皮肤上；
// 半径放大 1.35 倍。返回 [食指（A 点那枚，带环）, 中指, 拇指]：{ px, r, smearA（图像系角度）, ringA, ringK }
export function inkAnchors(an, rmul = 1.35) {
  const out = [];
  for (const [key, ringK, ringA] of [['ink_index_A', 0.55, -18 * Math.PI / 180], ['ink_middle', 0, 0], ['ink_thumb', 0, 0]]) {
    const s = an[key]; if (!s) { out.push(null); continue; }
    const tip = s.tip_px || s.px, wr = an.wrist ? an.wrist.px : [s.px[0] + 1, s.px[1] + 1];
    let dx = wr[0] - tip[0], dy = wr[1] - tip[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const r = s.r_px * rmul;
    out.push({ px: [s.px[0] + dx * s.r_px * 3.4, s.px[1] + dy * s.r_px * 3.4], r, smearA: Math.atan2(dy, dx), ringA, ringK });
  }
  return out;
}
// 人物线加粗（fix1，style-14）：精灵着色器里对线稿做一次膨胀——邻域（8 个方向、uThick 图像像素）里有深线，就把本像素画成线色。
// 用法：makeSprite(tex, { frag: THICK_FS, uniforms: { uThick: { value: 1.2 } } })；或把 THICK_BODY 拼进别的 frag.body 里
export const THICK_PARS = /* glsl */`uniform float uThick;`;
export const THICK_BODY = /* glsl */`
  if (uThick > 0.) {
    vec2 dd = uThick / uImg;
    float lmin = lum;
    for (int k = 0; k < 8; k++) {
      float ang = float(k) * .785398;
      vec4 cn = texture2D(map, vUv + vec2(cos(ang), sin(ang)) * dd);
      if (cn.a > .5) lmin = min(lmin, bbLum(bbL2S(cn.rgb)));
    }
    float kk = smoothstep(.12, .32, lum - lmin) * (1. - smoothstep(.30, .50, lmin));
    col = mix(col, uLineCol, kk);
  }
`;
export const THICK_FS = { pars: THICK_PARS, body: THICK_BODY };
// 精灵的世界尺寸：按 crop 区域的像素宽高 × 每米像素
export function spriteSize(sp, pxPerM) {
  const c = sp.crop, w = (c.z - c.x) * sp.img.x / pxPerM, h = (c.w - c.y) * sp.img.y / pxPerM;
  return [w, h];
}
// 把精灵摆到：图像像素点 anchorPx 落在世界点 P，面片朝向 quat，图像每米 pxPerM 像素
const _v = new THREE.Vector3(), _q = new THREE.Quaternion();
export function placeSprite(sp, P, quat, anchorPx, pxPerM) {
  const c = sp.crop, cw = (c.z - c.x) * sp.img.x, ch = (c.w - c.y) * sp.img.y;
  const w = cw / pxPerM, h = ch / pxPerM;
  // anchor 在面片局部（中心为 0）的偏移
  const ax = (anchorPx[0] - c.x * sp.img.x) / cw - 0.5, ay = 0.5 - (anchorPx[1] - c.y * sp.img.y) / ch;
  sp.group.quaternion.copy(quat);
  sp.group.scale.set(w, h, 1);
  _v.set(-ax * w, -ay * h, 0).applyQuaternion(quat);
  sp.group.position.copy(P).add(_v);
  sp.group.updateMatrixWorld(true);
}
// 精灵分区形变的便捷设置
export function setRot(sp, i, pivot, ang, rect, feather = 30) {
  sp.U.uRotP.value[i].set(pivot[0], pivot[1], ang, 1);
  sp.U.uRotR.value[i].set(rect[0], rect[1], rect[2], rect[3]);
  sp.U.uRotF.value[i] = feather;
}
export function clearDeform(sp) {
  for (const v of sp.U.uRotP.value) v.w = 0;
  sp.U.uBreP.value.y = 0; sp.U.uGlo.value.z = 1; sp.U.uGlo.value.w = 1; sp.U.uLean.value = 0; sp.U.uShear.value.y = 0;
}
