// src/look.js —《北冥》后期合成管线：配方第 2 层的「手绘墨线」+ 第 5 层的后期。
//
// 顺序（按《仓库研究总览》第 5 条定下的）：
//   ① 主场景 → MSAA 4×、HalfFloat 线性 HDR，带深度纹理
//   ② ID 图（超采样 ss 倍、无 MSAA）：每个描边物体 / 每个实例一个 ID + 深度 + 线宽系数 + 可见度
//        → 边缘检测（深度 + ID，近的一侧拥有这条线）→ 笔画（域扭曲抖动，种子 floor(t*12) 一拍二沸腾）
//   ③ 空气透视雾（屏幕空间，按深度重建世界坐标）→ bloom（mip 链）→ 调色 → OutputPass（色调映射 + sRGB）
//   ④ Generalized Kuwahara（8 扇区，sRGB 空间）→ 叠墨线（Kuwahara 之后，不被抹糊）→ 纸纹 → 暗角 →（可选颗粒）→ 屏幕/目标
//
// 用法：
//   import { createLook, LOOK_DEFAULTS } from './look.js';
//   const look = createLook(renderer, W, H, { ss: 2 });   // W×H = 画布实际像素（setPixelRatio(1)）
//   await look.ready;                          // 纸纹（assets/plates/paper.png 有就用，否则程序化）准备好，再设 window.READY
//   look.render(scene, camera, { t, outline: {...}, kuwahara: {...}, bloom: {...}, grade: {...}, fog: {...}, paper: {...}, vignette: .2 });
//   // 眼镜显示层（HUD）在这之后直接画到屏幕：renderer.autoClear = false; renderer.render(hudScene, hudCam); renderer.autoClear = true;
//
// createLook(renderer, w, h, opts)  opts：
//   ss: 2          墨线超采样倍数（ID 图和笔画在 w*ss × h*ss 上算，合成时 2×2 盒下采样 → 线自带抗锯齿）；1 更快、线略硬
//   msaa: 4        主场景 MSAA 采样数
//   paperUrl       纸纹图，默认 './assets/plates/paper.png'；加载失败就用程序化纸纹；null = 不尝试
// 返回 { render(scene, camera, p), ready, setSize(w, h), dispose(), targets, size }
//
// p（每帧参数；某一项不写 = 用 LOOK_DEFAULTS；写 false / null = 关掉这一项；写对象 = 覆盖默认里的同名字段）：
//   t                      全局时间（秒），用 帧号/24 的精确值；墨线沸腾种子 = floor(t*boilFps)，颗粒种子 = floor(t*24)
//   outline   { width, color, wobble, boilFps, warp, pressure, breakup, inner, silhouette, depthThreshold, near, far, farScale, opacity, tint, darken, fogFade }
//   kuwahara  { radius, strength, q, farRadius, farStart, farEnd, protect }
//   bloom     { strength, threshold, radius, knee, tint }      阈值比的是线性 HDR 的最大通道
//   grade     { exposure, warmth, lift, gamma, gain, saturation, shoulder }   lift/gamma/gain 可以是数或 [r,g,b]
//   fog       { color, colorHigh, density, start, max, baseHeight, falloff, cutoff, sky }   颜色写 '#hex'；默认关
//   paper     { strength, scale, tex, mid }                  tex：自带纸纹贴图（重复平铺）；mid：它的中性亮度
//   vignette  数值（0..1）
//   grain     数值（0..1，默认 0；成片颗粒交给 mux）
//   target    输出到哪个 WebGLRenderTarget（默认 null = 屏幕）
//   debug     'id' | 'depth' | 'edge' | 'line' | 'bloom' | 'paper' | 'kuwahara' | 'scene'  看中间缓冲
//
// 物体上的开关（userData，子物体继承父物体，子物体显式写了就以子物体为准）：
//   outline: true            只有它为 true 的 Mesh / InstancedMesh 才描边；底板面片不要设
//   outlineWidth: 1          线宽系数（乘在 p.outline.width 上）
//   outlineAlpha: 1          线的不透明度系数
//   outlinePerInstance: true InstancedMesh 默认每个实例一个 ID；false = 整个 InstancedMesh 共用一个 ID
//   outlineGroup: 'body'     同组的物体共用一个 ID，组内部件相接处不出线（只留外轮廓和深度折痕）。几乎共面的穿插件（比如腹部嵌进身体）建议同组
//   outlineOccluder: 'auto'  不描边物体在 ID 图里怎么挡线：'auto' | 'solid'(实心挡) | 'soft'(按自身 alpha 半挡) | 'own'(用自身材质实心挡) | false(不挡)
//                            auto：透明材质 → soft；加色混合 / Points / Line → 不挡；ShaderMaterial → own；其它 → solid
//   outlineVertex: { head, body, uniforms }  描边物体如果在自己的材质里做了顶点位移，把同样的 GLSL 交给 ID 图
//                            （head 放在 main 之前，body 放在 #include <begin_vertex> 之后，改 transformed）
//
// 所有随时间变化的东西只取决于 p.t（逐帧离线渲染可任意跳帧）。

import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ───────────────────────────── 默认参数（像素量都按 1080 高度标定，内部按 h/1080 缩放） ─────────────────────────────
export const LOOK_DEFAULTS = {
  outline: {
    width: 2.6,          // 外轮廓线宽（像素，1080p）；外轮廓约 3px、内部线约 1.5px 的手绘比例
    color: '#2A2D52',    // 墨色：深蓝灰，不用纯黑
    wobble: 1.2,         // 抖动幅度（像素）：检测坐标的低频域扭曲
    boilFps: 12,         // 沸腾频率：种子 floor(t*12)，即一拍二
    warp: 70,            // 抖动的波长（像素）
    pressure: 0.35,      // 笔压：线宽沿线 ±35% 起伏
    breakup: 0.1,        // 断线：0 = 不断；0.1 偶尔断开，0.25 明显成段
    inner: 0.55,         // 内部线（两个部件相接、深度相近）相对外轮廓的粗细
    silhouette: 0.12,    // 两侧深度相对差大于它算外轮廓
    depthThreshold: 0.03,// 同一物体内部的深度折痕阈值（1/z 的二阶差分，相对值）
    near: 4, far: 80,    // 线宽随深度变化的区间（世界单位）
    farScale: 0.55,      // 远处线宽系数
    opacity: 1,
    tint: 0.15,          // 墨色吸收一点底色，不那么「贴」
    darken: 0.5,         // 底色比墨还暗时，线取「底色 × 0.5」，暗部的线也看得见
    fogFade: 0.9,        // 雾里的线跟着变淡的程度
  },
  kuwahara: { radius: 5, strength: 1, q: 8, farRadius: 5, farStart: 40, farEnd: 120, protect: [1.05, 1.6] },   // farRadius：远处 / 底板的笔触半径；protect：HDR 亮度在此区间的自发光点不被抹（null 关）
  bloom: { strength: 0.55, threshold: 0.72, radius: 0.65, knee: 0.25, tint: '#ffffff' },
  grade: { exposure: 1, warmth: 0.12, lift: [0.035, 0.022, 0.06], gamma: 1, gain: 1, saturation: 1.04, shoulder: 0.9 },
  fog: null,             // 默认关。{ color, colorHigh, density, start, max, baseHeight, falloff, cutoff, sky }
  paper: { strength: 0.12, scale: 1 },
  vignette: 0.22,
  grain: 0,              // 页面内颗粒默认关（交给 ffmpeg mux）；要让 HUD 不带颗粒时可以在这里开、mux 关
};

// ───────────────────────────── 工具 ─────────────────────────────
const _c = new THREE.Color();
// 颜色输入：'#hex' / 0xhex / THREE.Color / [r,g,b]（sRGB 0..1）→ 线性 RGB 或 sRGB 分量
function toColor(v, out = new THREE.Color()) {
  if (v === undefined || v === null) return out.setRGB(1, 1, 1);
  if (v.isColor) return out.copy(v);
  if (Array.isArray(v)) return out.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
  return out.set(v);
}
function linVec(v, out = new THREE.Vector3()) { toColor(v, _c); return out.set(_c.r, _c.g, _c.b); }
function srgbVec(v, out = new THREE.Vector3()) { toColor(v, _c); const o = {}; _c.getRGB(o, THREE.SRGBColorSpace); return out.set(o.r, o.g, o.b); }
// 标量或三通道 → Vector3
function vec3Of(v, out = new THREE.Vector3()) { return Array.isArray(v) ? out.set(v[0], v[1], v[2]) : out.setScalar(v); }
// 合并参数：false/null = 关；undefined/true = 默认；对象 = 覆盖默认
function merge(v, def) {
  if (v === false || v === null) return null;
  if (v === undefined || v === true) return def ? { ...def } : null;
  if (typeof v === 'number') return v;
  return { ...(def || {}), ...v };
}

const VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

// 整数哈希（PCG，Jarzynski & Olano 2020 的公式）+ 值噪声；种子是整数，结果逐帧可复现
const NOISE = /* glsl */`
uint pcgh(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h21(ivec2 p, uint seed){ return float(pcgh(uint(p.x) + pcgh(uint(p.y) + seed))) * (1.0 / 4294967295.0); }
float vnoise(vec2 x, uint seed){
  vec2 i = floor(x), f = fract(x); ivec2 ii = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = h21(ii, seed), b = h21(ii + ivec2(1, 0), seed), c = h21(ii + ivec2(0, 1), seed), d = h21(ii + ivec2(1, 1), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`;

// 空气透视：按真实距离 + 世界高度（越低越浓，江面雾）
const FOG = /* glsl */`
uniform vec4 uFogA;   // x 密度, y 起始距离, z 最大浓度, w 开关
uniform vec4 uFogB;   // x 基准高度, y 高度衰减(0=不按高度), z 截止距离(更远的不加雾,给远处底板留原色), w 天空(清屏处)浓度
uniform vec3 uFogLow, uFogHigh;   // 低处 / 高处（按视线仰角）雾色，线性
float fogAmount(float dist, float worldY){
  if (uFogA.w < .5 || dist > uFogB.z) return 0.;
  float dens = uFogA.x;
  if (uFogB.y > 0.) dens *= exp(-max(worldY - uFogB.x, 0.) / uFogB.y);
  return (1. - exp(-dens * max(dist - uFogA.y, 0.))) * uFogA.z;
}
vec3 fogColor(vec3 dirW){ return mix(uFogLow, uFogHigh, smoothstep(-.05, .35, dirW.y)); }
uniform mat4 uProjInv, uCamWorld;
vec3 viewPosAt(vec2 uv, float d){ vec4 v = uProjInv * vec4(uv * 2. - 1., d * 2. - 1., 1.); return v.xyz / v.w; }`;

// ───────────────────────────── ID 图材质 ─────────────────────────────
// 输出 (id 低 11 位, id 高位, 线宽系数, 线可见度)。HalfFloat 能精确存 0..2048 的整数，拆两段可放 400 万个 ID。
// 顶点着色器用 three 自带的 chunk（<begin_vertex>/<project_vertex>），所以 InstancedMesh、蒙皮、变形都对得上（研究 03 篇第 4 个坑）。
function idVertexShader(head = '', body = '') {
  return /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform float uBaseId, uPerInstance;
uniform mat3 uCutTransform;
flat varying float vId;
varying vec2 vCutUv;
${head}
void main(){
  #include <batching_vertex>
  #include <skinbase_vertex>
  #include <morphinstance_vertex>
  #include <begin_vertex>
  ${body}
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #ifdef USE_INSTANCING
    vId = uBaseId + uPerInstance * float(gl_InstanceID);
  #else
    vId = uBaseId;
  #endif
  vCutUv = (uCutTransform * vec3(uv, 1.)).xy;
}`;
}
const ID_FS = /* glsl */`
uniform float uWidth, uAlpha;
uniform sampler2D uCutMap; uniform float uCutRef;
flat varying float vId;
varying vec2 vCutUv;
void main(){
  #ifdef CUTOUT
    if (texture2D(uCutMap, vCutUv).a < uCutRef) discard;
  #endif
  gl_FragColor = vec4(mod(vId, 2048.), floor(vId / 2048.), uWidth, uAlpha);
}`;

// ───────────────────────────── 边缘检测：近的一侧拥有这条线 ─────────────────────────────
const EDGE_FS = /* glsl */`
#include <packing>
${FOG}
uniform sampler2D tId, tDepth;
uniform vec2 uRes;
uniform float uNear, uFar, uOrtho;
uniform float uHalfW, uDepthThr, uInner, uSil, uOpacity, uFogFade;
uniform vec3 uWD;    // x 近, y 远, z 远处线宽系数
float lz(ivec2 p){ float d = texelFetch(tDepth, p, 0).x; return uOrtho > .5 ? -orthographicDepthToViewZ(d, uNear, uFar) : -perspectiveDepthToViewZ(d, uNear, uFar); }
float gid(ivec2 p){ vec2 s = texelFetch(tId, p, 0).xy; return s.x + s.y * 2048.; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uRes) - 1;
  vec4 s0 = texelFetch(tId, p, 0);
  float id0 = s0.x + s0.y * 2048.;
  if (id0 < .5 || s0.w < .002) { gl_FragColor = vec4(0.); return; }
  float z0 = lz(p), iz0 = 1. / z0;
  float edge = 0., gap = 0.;
  // ① ID 跳变（4 邻域，含 (-1,0)：修掉原仓库漏掉的方向）。只有更近（或一样近）的一侧画线
  ivec2 N4[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int k = 0; k < 4; k++) {
    ivec2 q = clamp(p + N4[k], ivec2(0), mx);
    float idq = gid(q);
    if (abs(idq - id0) > .5) {
      float z = lz(q), rel = (z - z0) / z0;
      // 近的一侧拥有；两个部件互相穿插、深度几乎一样时，固定让 ID 大的一侧画，避免两边轮流画出锯齿双线
      if (rel > .002 || (rel > -.002 && id0 > idq)) { edge = 1.; gap = max(gap, rel); }
    }
  }
  // ② 深度断层 / 折痕：1/z 的二阶差分（平面上恒为 0，掠射的地面不会误报）；只在近的一侧出线
  ivec2 AX[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(1, 1), ivec2(1, -1));
  for (int k = 0; k < 4; k++) {
    float zp = lz(clamp(p + AX[k], ivec2(0), mx)), zm = lz(clamp(p - AX[k], ivec2(0), mx));
    float lap = (1. / zp + 1. / zm - 2. * iz0) / iz0;
    if (lap < -uDepthThr) { edge = 1.; gap = max(gap, max(zp, zm) / z0 - 1.); }
  }
  if (edge < .5) { gl_FragColor = vec4(0.); return; }
  // 线的浓淡：物体给的可见度（被半透明云挡住会变小）× 雾
  vec2 uv = (vec2(p) + .5) / uRes;
  vec3 vp = viewPosAt(uv, texelFetch(tDepth, p, 0).x);
  vec3 wp = (uCamWorld * vec4(vp, 1.)).xyz;
  float f = fogAmount(length(vp), wp.y);
  float strength = clamp(s0.w, 0., 1.) * uOpacity * (1. - uFogFade * f);
  // 半线宽（ID 图像素）：基础 × 物体系数 × 随深度变细 × 内部线更细
  float hw = uHalfW * s0.z * mix(1., uWD.z, smoothstep(uWD.x, uWD.y, z0)) * (gap > uSil ? 1. : uInner);
  gl_FragColor = vec4(strength, hw, gap, 1.);
}`;

// ───────────────────────────── 笔画：以边缘像素为圆心画圆头笔，查找坐标做低频域扭曲（抖动） ─────────────────────────────
const STROKE_FS = /* glsl */`
${NOISE}
uniform sampler2D tEdge;
uniform vec2 uRes;
uniform float uWobble, uWarp, uPressure, uBreakup, uSeed;
void main(){
  vec2 c = gl_FragCoord.xy;
  uint sd = uint(uSeed) * 7919u + 13u;
  vec2 q = c;
  if (uWobble > 0.) {
    vec2 a = c / uWarp;
    q += (vec2(vnoise(a, sd), vnoise(a + 31.7, sd + 1u)) * 2. - 1.) * uWobble;
    vec2 b = c / (uWarp * .31);
    q += (vec2(vnoise(b, sd + 2u), vnoise(b + 13.1, sd + 3u)) * 2. - 1.) * uWobble * .3;
  }
  // 笔压：沿线粗细起伏（低频噪声，和沸腾同一个种子）
  float pr = uPressure > 0. ? 1. + uPressure * (vnoise(q / (uWarp * .45), sd + 5u) * 2. - 1.) : 1.;
  ivec2 b0 = ivec2(floor(q)), mx = ivec2(uRes) - 1;
  float cov = 0.;
  for (int j = -SR; j <= SR; j++) {
    for (int i = -SR; i <= SR; i++) {
      ivec2 e = b0 + ivec2(i, j);
      if (any(lessThan(e, ivec2(0))) || any(greaterThan(e, mx))) continue;
      vec4 E = texelFetch(tEdge, e, 0);
      if (E.x <= 0.) continue;
      float d = length(q - (vec2(e) + .5));
      cov = max(cov, clamp(E.y * pr + .5 - d, 0., 1.) * E.x);
    }
  }
  if (uBreakup > 0.) cov *= smoothstep(uBreakup - .1, uBreakup + .1, vnoise(q / (uWarp * .6), sd + 9u));
  gl_FragColor = vec4(cov, 0., 0., 1.);
}`;

// ───────────────────────────── 空气透视雾 ─────────────────────────────
const FOGPASS_FS = /* glsl */`
${FOG}
uniform sampler2D tColor, tDepth;
varying vec2 vUv;
void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  vec3 vp = viewPosAt(vUv, min(d, .9999999));
  vec3 wp = (uCamWorld * vec4(vp, 1.)).xyz;
  vec3 dirW = normalize((uCamWorld * vec4(vp, 0.)).xyz);
  float f = d >= .9999999 ? uFogB.w * uFogA.z : fogAmount(length(vp), wp.y);
  gl_FragColor = vec4(mix(col, fogColor(dirW), f), 1.);
}`;

// ───────────────────────────── bloom：软阈值 → 13 抽头下采样 mip 链 → 帐篷上采样（radius 决定大光晕的权重） ─────────────────────────────
const BLOOM_PRE_FS = /* glsl */`
uniform sampler2D tIn; uniform vec2 uTexel; uniform float uThr, uKnee;
varying vec2 vUv;
void main(){
  vec2 o = uTexel;   // 源图像素；四个双线性采样合成 4×4 盒
  vec3 c = (texture2D(tIn, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tIn, vUv + vec2(o.x, -o.y)).rgb
          + texture2D(tIn, vUv + vec2(-o.x, o.y)).rgb + texture2D(tIn, vUv + vec2(o.x, o.y)).rgb) * .25;
  float l = max(c.r, max(c.g, c.b));
  float k = max(uKnee, 1e-4);
  float soft = clamp(l - uThr + k, 0., 2. * k); soft = soft * soft / (4. * k);
  float w = max(soft, l - uThr) / max(l, 1e-4);
  gl_FragColor = vec4(c * w, 1.);
}`;
const BLOOM_DOWN_FS = /* glsl */`
uniform sampler2D tIn; uniform vec2 uTexel;
varying vec2 vUv;
vec3 s(vec2 o){ return texture2D(tIn, vUv + o * uTexel).rgb; }
void main(){
  vec3 c = s(vec2(0)) * .125;
  c += (s(vec2(-2, -2)) + s(vec2(2, -2)) + s(vec2(-2, 2)) + s(vec2(2, 2))) * .03125;
  c += (s(vec2(0, -2)) + s(vec2(-2, 0)) + s(vec2(2, 0)) + s(vec2(0, 2))) * .0625;
  c += (s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1))) * .125;
  gl_FragColor = vec4(c, 1.);
}`;
const BLOOM_UP_FS = /* glsl */`
uniform sampler2D tLow, tCur; uniform vec2 uTexel; uniform float uRadius;
varying vec2 vUv;
vec3 s(vec2 o){ return texture2D(tLow, vUv + o * uTexel).rgb; }
void main(){
  vec3 t = s(vec2(0)) * 4.;
  t += (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.;
  t += s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1));
  gl_FragColor = vec4(mix(texture2D(tCur, vUv).rgb, t / 16., uRadius), 1.);
}`;

// ───────────────────────────── 调色（线性进、线性出；lift/gamma/gain 在 2.2 伽马空间里做） ─────────────────────────────
const GRADE_FS = /* glsl */`
uniform sampler2D tColor, tBloom;
uniform float uBloom, uExposure, uSat, uKnee;
uniform vec3 uBloomTint, uWB, uLift, uGamma, uGain;
uniform vec2 uProt;   // 自发光高光（HDR 超过 1 的窗灯、灯点）保护阈值：写进 alpha，Kuwahara 在它附近保留原图，不把小灯点抹成星形
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tColor, vUv).rgb * uExposure;
  float prot = uProt.y > 0. ? smoothstep(uProt.x, uProt.y, max(c.r, max(c.g, c.b))) : 0.;
  c += texture2D(tBloom, vUv).rgb * uBloom * uBloomTint;
  c *= uWB;
  float l = dot(c, vec3(.2126, .7152, .0722));
  c = max(mix(vec3(l), c, uSat), 0.);
  vec3 g = pow(c, vec3(1. / 2.2));
  g = uGain * (g + uLift * max(1. - g, 0.));
  g = pow(max(g, 0.), 1. / uGamma);
  c = pow(g, vec3(2.2));
  if (uKnee < .999) {   // 高光肩：大部分保色相（橙色灯过曝仍是橙色），少量按通道压（核心略发白，像真的亮）
    vec3 k = vec3(uKnee);
    vec3 pc = min(c, k) + (1. - k) * (1. - exp(-max(c - k, 0.) / (1. - k)));
    float m = max(c.r, max(c.g, c.b));
    float mm = m < uKnee ? m : uKnee + (1. - uKnee) * (1. - exp(-(m - uKnee) / (1. - uKnee)));
    c = mix(c * (mm / max(m, 1e-5)), pc, .3);
  }
  gl_FragColor = vec4(c, prot);
}`;

// ───────────────────────────── Generalized Kuwahara（Papari 2007 的思路，8 扇区；扇区权重自己写：cos⁸ 角向 × 高斯径向） ─────────────────────────────
const KUWA_FS = /* glsl */`
#include <packing>
uniform sampler2D tIn, tDepth; uniform vec2 uTexel; uniform float uRadius, uQ, uStrength;
uniform vec4 uFar;   // x 远处半径（像素）, y 开始变化的距离, z 完全变成远处半径的距离, w 开关
uniform float uNear, uFarClip;
varying vec2 vUv;
#define ACC(k, w) M[k] += (w) * c; S[k] += (w) * c2;
void main(){
  vec3 c0 = texture2D(tIn, vUv).rgb;
  vec3 M[8], S[8];
  for (int k = 0; k < 8; k++) { M[k] = vec3(0.); S[k] = vec3(0.); }
  vec4 WA = vec4(0.), WB = vec4(0.);
  float rad = uRadius, prot = 0.;
  if (uFar.w > .5) {   // 底板（远处、清屏处）可以用更大的笔触，3D 主体保持小笔触
    float d = texture2D(tDepth, vUv).x;
    float z = d >= .9999999 ? 1e9 : -perspectiveDepthToViewZ(d, uNear, uFarClip);
    rad = mix(uRadius, uFar.x, smoothstep(uFar.y, uFar.z, z));
  }
  float stp = rad / float(KR);
  for (int j = -KR; j <= KR; j++) {
    for (int i = -KR; i <= KR; i++) {
      vec2 v = vec2(float(i), float(j)) / float(KR);
      float r2 = dot(v, v);
      if (r2 > 1.0001) continue;
      vec4 cs = texture2D(tIn, vUv + vec2(float(i), float(j)) * stp * uTexel);
      vec3 c = cs.rgb, c2 = c * c;
      float g = exp(-2. * r2);
      prot = max(prot, cs.a * (1. - .6 * r2));
      vec4 wa, wb;
      if (i == 0 && j == 0) { wa = vec4(g * .125); wb = wa; }
      else {
        vec2 n = v * inversesqrt(r2);
        vec4 pr = vec4(n.x, (n.x + n.y) * .70710678, n.y, (n.y - n.x) * .70710678);   // 0°/45°/90°/135° 四根轴
        wa = max(pr, 0.); wb = max(-pr, 0.);
        wa *= wa; wa *= wa; wa *= wa; wb *= wb; wb *= wb; wb *= wb;                // cos⁸：相邻扇区在 ±22.5° 处各占一半
        wa *= g; wb *= g;
      }
      WA += wa; WB += wb;
      ACC(0, wa.x) ACC(1, wa.y) ACC(2, wa.z) ACC(3, wa.w) ACC(4, wb.x) ACC(5, wb.y) ACC(6, wb.z) ACC(7, wb.w)
    }
  }
  float W[8] = float[8](WA.x, WA.y, WA.z, WA.w, WB.x, WB.y, WB.z, WB.w);
  vec3 acc = vec3(0.); float as = 0.;
  for (int k = 0; k < 8; k++) {
    vec3 m = M[k] / W[k];
    vec3 v = max(S[k] / W[k] - m * m, 0.);
    float s2 = (v.r + v.g + v.b) * 65025.;          // 方差按 0..255 计，和论文的尺度一致
    float a = 1. / (1. + pow(s2, uQ * .5));
    acc += a * m; as += a;
  }
  gl_FragColor = vec4(mix(c0, acc / as, uStrength * (1. - prot)), 1.);
}`;

// ───────────────────────────── 最终合成：叠墨线 → 纸纹 → 暗角 →（颗粒） ─────────────────────────────
const FINAL_FS = /* glsl */`
${NOISE}
uniform sampler2D tColor, tLine, tPaper;
uniform float uLineOn, uInkTint, uInkDark, uPaper, uPaperMid, uVig, uGrain, uGrainSeed;
uniform vec3 uInk; uniform vec2 uRes, uPaperSize;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tColor, vUv).rgb;
  if (uLineOn > .5) {
    float cov = texture2D(tLine, vUv).r;                    // ss=2 时双线性正好是 2×2 盒下采样 → 线自带抗锯齿
    vec3 ink = min(uInk, c * uInkDark);                     // 底色比墨还暗时，线取底色的更暗一档，保证看得见
    ink = mix(ink, ink * (.55 + .9 * c), uInkTint);
    c = mix(c, ink, cov);
  }
  if (uPaper > 0.) {
    float pp = texture2D(tPaper, gl_FragCoord.xy / uPaperSize).r;
    c *= 1. + uPaper * 2. * (pp - uPaperMid);
  }
  if (uVig > 0.) {
    vec2 a = vec2(uRes.x / uRes.y, 1.);
    float r = length((vUv - .5) * a) / length(a * .5);
    c *= 1. - uVig * smoothstep(.32, 1.05, r);
  }
  if (uGrain > 0.) {
    ivec2 p = ivec2(gl_FragCoord.xy); uint sd = uint(uGrainSeed) * 2654435761u;
    float n = h21(p, sd) + h21(p, sd + 77u) - 1.;           // 三角分布
    float l = dot(c, vec3(.2126, .7152, .0722));
    c += n * uGrain * .06 * (1. - .5 * l);
  }
  gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
}`;

// 程序化纸纹：极细的颗粒 + 很淡的纸齿浮雕（左上来光）+ 大块斑驳；输出以 0.5 为中性、对比很低，铺满整屏不重复
const PAPER_FS = /* glsl */`
${NOISE}
uniform float uK;
float fbm(vec2 p, uint s){ float a = 0., m = .5; for (int i = 0; i < 3; i++) { a += m * vnoise(p, s + uint(i) * 101u); p = p * 2.03 + vec2(17.1, 9.3); m *= .5; } return a / .875 - .5; }
float tooth(vec2 p){ return fbm(p / (4.5 * uK), 23u); }
void main(){
  vec2 p = gl_FragCoord.xy;
  float grain = h21(ivec2(p), 7u) - .5;                                     // 1 像素的纸面颗粒
  float g2 = vnoise(p / (1.7 * uK), 9u) - .5;                               // 2 像素左右的颗粒团
  float emb = (tooth(p + vec2(-1., 1.)) - tooth(p + vec2(1., -1.)));        // 纸齿浮雕（左上来光）
  float mott = fbm(p / (160. * uK), 37u);                                   // 大块斑驳（颜料吃纸不均）
  float fib = vnoise(vec2(p.x / 70., p.y / 2.5) * mat2(.96, .28, -.28, .96) / uK, 51u) - .5;   // 极淡的纤维
  float v = .5 + grain * .03 + g2 * .08 + emb * .5 + mott * .3 + fib * .05;
  gl_FragColor = vec4(v, v, v, 1.);
}`;

// 调试视图
const DEBUG_FS = /* glsl */`
#include <packing>
uniform sampler2D tA; uniform int uMode; uniform float uNear, uFar, uScale;
varying vec2 vUv;
vec3 hue(float x){ return clamp(abs(fract(x + vec3(0., 2., 1.) / 3.) * 6. - 3.) - 1., 0., 1.); }
void main(){
  vec4 a = texture2D(tA, vUv);
  vec3 c = a.rgb;
  if (uMode == 1) { float id = a.x + a.y * 2048.; c = id < .5 ? vec3(0.) : hue(fract(id * .61803)) * (.5 + .5 * a.w); }     // id
  else if (uMode == 2) { float z = -perspectiveDepthToViewZ(a.x, uNear, uFar); c = vec3(1. - clamp(log(z) / log(uFar), 0., 1.)); }  // 深度
  else if (uMode == 3) { c = vec3(a.x, a.y / 6., a.z); }          // 边缘：强度 / 半线宽 / 深度差
  else if (uMode == 4) { c = vec3(1. - a.r); }                    // 线
  else if (uMode == 5) { c = a.rgb * uScale; }                     // bloom / 线性图
  else if (uMode == 6) { c = a.rrr; }                              // 纸纹
  gl_FragColor = vec4(c, 1.);
}`;

// ───────────────────────────── 主体 ─────────────────────────────
export function createLook(renderer, w, h, opts = {}) {
  const ss = opts.ss ?? 2;                  // 墨线超采样倍数（1 或 2）
  const msaa = opts.msaa ?? 4;
  const paperUrl = opts.paperUrl === undefined ? './assets/plates/paper.png' : opts.paperUrl;

  // 全屏三角形（自建，不用 FullScreenQuad：它的 dispose 会删掉全局共享几何体）
  const fsGeo = new THREE.BufferGeometry();
  fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  fsGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsMesh = new THREE.Mesh(fsGeo); fsMesh.frustumCulled = false;
  const draw = (mat, target) => { fsMesh.material = mat; renderer.setRenderTarget(target); renderer.render(fsMesh, fsCam); };
  const mat = (fs, uniforms, defines = {}) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, defines, depthTest: false, depthWrite: false });

  const HF = THREE.HalfFloatType;
  const rt = (W, H, o = {}) => new THREE.WebGLRenderTarget(W, H, { type: HF, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...o });

  let W = 0, H = 0, LW = 0, LH = 0, T = {}, bloomLv = [];
  function alloc(nw, nh) {
    for (const k in T) T[k]?.dispose?.();
    for (const l of bloomLv) { l.down.dispose(); l.up.dispose(); }
    W = nw; H = nh; LW = W * ss; LH = H * ss;
    T = {
      scene: new THREE.WebGLRenderTarget(W, H, { type: HF, samples: msaa, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) }),
      id: new THREE.WebGLRenderTarget(LW, LH, { type: HF, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture: new THREE.DepthTexture(LW, LH, THREE.FloatType) }),
      edge: rt(LW, LH, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      line: rt(LW, LH, { type: THREE.UnsignedByteType }),
      fog: rt(W, H), grade: rt(W, H), out: rt(W, H), kuwa: rt(W, H),
      paper: rt(W, H, { type: THREE.UnsignedByteType, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping }),
    };
    bloomLv = [];
    let bw = W >> 1, bh = H >> 1;
    while (bloomLv.length < 7 && Math.min(bw, bh) >= 8) { bloomLv.push({ w: bw, h: bh, down: rt(bw, bh), up: rt(bw, bh) }); bw >>= 1; bh >>= 1; }
    paperDirty = true;
  }

  // 各个 pass 的材质
  const fogU = () => ({
    uFogA: { value: new THREE.Vector4() }, uFogB: { value: new THREE.Vector4() }, uFogLow: { value: new THREE.Vector3() }, uFogHigh: { value: new THREE.Vector3() },
    uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
  });
  const M = {
    edge: mat(EDGE_FS, { ...fogU(), tId: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uNear: { value: .1 }, uFar: { value: 100 }, uOrtho: { value: 0 },
      uHalfW: { value: 2 }, uDepthThr: { value: .03 }, uInner: { value: .6 }, uSil: { value: .12 }, uOpacity: { value: 1 }, uFogFade: { value: 1 }, uWD: { value: new THREE.Vector3() } }),
    fog: mat(FOGPASS_FS, { ...fogU(), tColor: { value: null }, tDepth: { value: null } }),
    pre: mat(BLOOM_PRE_FS, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() }, uThr: { value: .7 }, uKnee: { value: .2 } }),
    down: mat(BLOOM_DOWN_FS, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() } }),
    up: mat(BLOOM_UP_FS, { tLow: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: .6 } }),
    grade: mat(GRADE_FS, { tColor: { value: null }, tBloom: { value: null }, uBloom: { value: 0 }, uExposure: { value: 1 }, uSat: { value: 1 }, uKnee: { value: 1 },
      uProt: { value: new THREE.Vector2() }, uBloomTint: { value: new THREE.Vector3(1, 1, 1) }, uWB: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) } }),
    final: mat(FINAL_FS, { tColor: { value: null }, tLine: { value: null }, tPaper: { value: null }, uLineOn: { value: 0 }, uInkTint: { value: 0 }, uInkDark: { value: .6 }, uPaper: { value: 0 }, uPaperMid: { value: .5 },
      uVig: { value: 0 }, uGrain: { value: 0 }, uGrainSeed: { value: 0 }, uInk: { value: new THREE.Vector3() }, uRes: { value: new THREE.Vector2() }, uPaperSize: { value: new THREE.Vector2() } }),
    paper: mat(PAPER_FS, { uK: { value: 1 } }),
    debug: mat(DEBUG_FS, { tA: { value: null }, uMode: { value: 0 }, uNear: { value: .1 }, uFar: { value: 100 }, uScale: { value: 1 } }),
  };
  // 笔画和 Kuwahara 的循环半径是编译期常量，按需要编译几个变体
  const strokeMats = new Map(), kuwaMats = new Map();
  const strokeMat = R => {
    if (!strokeMats.has(R)) strokeMats.set(R, mat(STROKE_FS, { tEdge: { value: null }, uRes: { value: new THREE.Vector2() }, uWobble: { value: 1 }, uWarp: { value: 60 }, uPressure: { value: 0 }, uBreakup: { value: 0 }, uSeed: { value: 0 } }, { SR: R }));
    return strokeMats.get(R);
  };
  const kuwaMat = KR => {
    if (!kuwaMats.has(KR)) kuwaMats.set(KR, mat(KUWA_FS, { tIn: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 4 }, uQ: { value: 8 }, uStrength: { value: 1 },
      uFar: { value: new THREE.Vector4() }, uNear: { value: .1 }, uFarClip: { value: 100 } }, { KR }));
    return kuwaMats.get(KR);
  };
  const out = new OutputPass();
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;

  // ── 纸纹：有 paper.png 就用（重复平铺，均值自动测），否则程序化生成整屏一张 ──
  let paperDirty = true, paperTex = null, paperMid = .5, extPaper = null, extMid = .5;
  const ready = (async () => {
    if (!paperUrl) return;
    try {
      const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = paperUrl; });
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 64, 64);
      const d = g.getImageData(0, 0, 64, 64).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (d[i] * .2126 + d[i + 1] * .7152 + d[i + 2] * .0722) / 255;
      extMid = s / (d.length / 4);
      extPaper = new THREE.Texture(img); extPaper.wrapS = extPaper.wrapT = THREE.RepeatWrapping; extPaper.needsUpdate = true;
    } catch { extPaper = null; }   // 没有文件：用程序化纸纹
  })();
  function makePaper() {
    M.paper.uniforms.uK.value = Math.max(.5, H / 1080);
    draw(M.paper, T.paper);
    // 量一下均值，叠加时以它为中性点
    const n = 128, buf = new Uint8Array(n * n * 4);
    renderer.readRenderTargetPixels(T.paper, 0, 0, n, n, buf);
    let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i] / 255;
    paperMid = s / (n * n); paperTex = T.paper.texture; paperDirty = false;
  }

  // ── ID 图：逐个物体换材质 ──
  const idCache = new WeakMap();
  const IDENT3 = new THREE.Matrix3();
  function idMaterialFor(o, m0, ov, occluder) {
    const cut = !!(m0 && m0.map && (m0.alphaTest > 0 || m0.transparent));
    const side = m0 ? m0.side : THREE.FrontSide;
    const sig = `${cut ? m0.map.uuid : ''}|${side}|${occluder}|${ov ? ov.head + ov.body : ''}`;
    let e = idCache.get(o);
    if (!e || e.sig !== sig) {
      e?.mat.dispose();
      const m = new THREE.ShaderMaterial({
        vertexShader: idVertexShader(ov?.head, ov?.body), fragmentShader: ID_FS,
        uniforms: { uBaseId: { value: 0 }, uPerInstance: { value: 0 }, uWidth: { value: 1 }, uAlpha: { value: 1 },
          uCutMap: { value: cut ? m0.map : null }, uCutRef: { value: cut ? (m0.alphaTest > 0 ? m0.alphaTest : .5) : 0 }, uCutTransform: { value: new THREE.Matrix3() },
          ...(ov?.uniforms || {}) },
        defines: cut ? { CUTOUT: '' } : {}, side,
      });
      e = { mat: m, sig }; idCache.set(o, e);
    }
    if (cut) { if (m0.map.matrixAutoUpdate) m0.map.updateMatrix(); e.mat.uniforms.uCutTransform.value.copy(m0.map.matrix); }
    else e.mat.uniforms.uCutTransform.value.copy(IDENT3);
    return e.mat;
  }
  const BLEND_KEYS = ['blending', 'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha', 'depthWrite'];
  function renderIds(scene, camera, maxW) {
    const swaps = [], hidden = [], patched = new Map(), groups = new Map(), cbs = [];
    // 换了材质的物体，如果它的 onBeforeRender 去改自己材质的 uniform，会拿到 ID 材质而报错；ID 图期间包一层 try
    const guard = o => {
      const f = o.onBeforeRender;
      if (f === THREE.Object3D.prototype.onBeforeRender) return;
      cbs.push([o, f]); o.onBeforeRender = function (...a) { try { f.apply(this, a); } catch (e) { /* ID 图里忽略 */ } };
    };
    let nextId = 1, maxWidth = 0;
    const patch = (m, soft) => {
      if (patched.has(m)) return;
      const save = {}; for (const k of BLEND_KEYS) save[k] = m[k];
      patched.set(m, save);
      m.blending = THREE.CustomBlending; m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
      if (soft) { m.blendSrc = THREE.ZeroFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; m.depthWrite = false; }
      else { m.blendSrc = m.blendDst = m.blendSrcAlpha = m.blendDstAlpha = THREE.ZeroFactor; }
    };
    const visit = (o, inh) => {
      if (!o.visible) return;
      const u = o.userData;
      const st = {
        outline: u.outline ?? inh.outline, width: u.outlineWidth ?? inh.width, alpha: u.outlineAlpha ?? inh.alpha,
        occ: u.outlineOccluder ?? inh.occ, per: u.outlinePerInstance ?? inh.per, ov: u.outlineVertex ?? inh.ov,
        grp: u.outlineGroup ?? inh.grp,
      };
      if (o.isMesh || o.isSprite || o.isPoints || o.isLine) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const m0 = mats[0];
        if (st.outline === true && o.isMesh) {
          const m = idMaterialFor(o, m0, st.ov, false);
          if (st.grp !== undefined && st.grp !== null) {   // 同组共用一个 ID：组内部件之间不出线
            if (!groups.has(st.grp)) groups.set(st.grp, nextId++);
            m.uniforms.uBaseId.value = groups.get(st.grp); m.uniforms.uPerInstance.value = 0;
          } else {
            const n = o.isInstancedMesh && st.per !== false ? o.count : 1;
            m.uniforms.uBaseId.value = nextId; m.uniforms.uPerInstance.value = n > 1 ? 1 : 0; nextId += Math.max(1, n);
          }
          const wmul = st.width ?? 1; maxWidth = Math.max(maxWidth, wmul);
          m.uniforms.uWidth.value = wmul;
          m.uniforms.uAlpha.value = (st.alpha ?? 1) * (m0 && m0.transparent ? m0.opacity : 1);
          swaps.push([o, o.material]); o.material = m; guard(o);
        } else {
          let mode = st.occ ?? 'auto';
          if (mode === 'auto') {
            if (o.isPoints || o.isLine || mats.every(m => m.blending === THREE.AdditiveBlending || m.blending === THREE.MultiplyBlending || m.colorWrite === false)) mode = false;
            else if (o.isSprite || mats.some(m => m.transparent)) mode = 'soft';
            else if (mats.some(m => m.isShaderMaterial)) mode = 'own';
            else mode = 'solid';
          }
          if (mode === false || ((o.isPoints || o.isLine) && mode !== 'soft')) { hidden.push(o); o.visible = false; }
          else if (mode === 'soft' || mode === 'own') { for (const m of mats) patch(m, mode === 'soft'); }
          else if (o.isMesh) {   // solid：ID=0、实心挡线
            const m = idMaterialFor(o, m0, st.ov, true);
            m.uniforms.uBaseId.value = 0; m.uniforms.uPerInstance.value = 0; m.uniforms.uWidth.value = 0; m.uniforms.uAlpha.value = 0;
            swaps.push([o, o.material]); o.material = m; guard(o);
          } else { hidden.push(o); o.visible = false; }
        }
      }
      for (const c of o.children) visit(c, st);
    };
    visit(scene, { outline: undefined, width: 1, alpha: 1, occ: undefined, per: true, ov: undefined, grp: undefined });

    const bg = scene.background, sm = renderer.shadowMap.autoUpdate;
    scene.background = null; renderer.shadowMap.autoUpdate = false;
    try {
      renderer.setRenderTarget(T.id);
      renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true);
      renderer.render(scene, camera);
    } finally {
      for (const [o, m] of swaps) o.material = m;
      for (const [o, f] of cbs) o.onBeforeRender = f;
      for (const o of hidden) o.visible = true;
      for (const [m, save] of patched) Object.assign(m, save);
      scene.background = bg; renderer.shadowMap.autoUpdate = sm;
    }
    return maxWidth || maxW;
  }

  const setFog = (u, fog, camera) => {
    u.uProjInv.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    if (!fog) { u.uFogA.value.set(0, 0, 0, 0); return; }
    u.uFogA.value.set(fog.density ?? .02, fog.start ?? 0, fog.max ?? 1, 1);
    u.uFogB.value.set(fog.baseHeight ?? 0, fog.falloff ?? 0, fog.cutoff ?? 1e9, fog.sky ?? 0);
    linVec(fog.color ?? '#9C8FD8', u.uFogLow.value); linVec(fog.colorHigh ?? fog.color ?? '#9C8FD8', u.uFogHigh.value);
  };

  alloc(w, h);
  const _cc = new THREE.Color();

  function render(scene, camera, p = {}) {
    const t = p.t ?? 0, k = H / 1080;
    const OL = merge(p.outline, LOOK_DEFAULTS.outline), KU = merge(p.kuwahara, LOOK_DEFAULTS.kuwahara), BL = merge(p.bloom, LOOK_DEFAULTS.bloom);
    const GR = merge(p.grade, LOOK_DEFAULTS.grade), FG = merge(p.fog, LOOK_DEFAULTS.fog), PA = merge(p.paper, LOOK_DEFAULTS.paper);
    const VG = p.vignette === undefined ? LOOK_DEFAULTS.vignette : (typeof p.vignette === 'object' && p.vignette ? p.vignette.strength ?? 0 : +p.vignette || 0);
    const GN = p.grain === undefined ? LOOK_DEFAULTS.grain : (typeof p.grain === 'object' && p.grain ? p.grain.amount ?? 0 : +p.grain || 0);
    const target = p.target ?? null;

    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_cc);
    renderer.autoClear = false;
    try {
      if (paperDirty) makePaper();
      camera.updateMatrixWorld();

      // ① 主场景
      renderer.setRenderTarget(T.scene); renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.setClearColor(_cc, prevAlpha);

      // ② 墨线：ID 图 → 边缘 → 笔画
      let lineOn = false;
      if (OL && OL.opacity > 0 && OL.width > 0) {
        const maxW = renderIds(scene, camera, 1);
        renderer.setClearColor(_cc, prevAlpha);
        const e = M.edge.uniforms;
        e.tId.value = T.id.texture; e.tDepth.value = T.id.depthTexture; e.uRes.value.set(LW, LH);
        e.uNear.value = camera.near; e.uFar.value = camera.far; e.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
        const hw = OL.width * .5 * k * ss;
        e.uHalfW.value = hw; e.uDepthThr.value = OL.depthThreshold; e.uInner.value = OL.inner; e.uSil.value = OL.silhouette;
        e.uOpacity.value = OL.opacity; e.uFogFade.value = FG ? OL.fogFade : 0; e.uWD.value.set(OL.near, OL.far, OL.farScale);
        setFog(e, FG, camera);
        draw(M.edge, T.edge);
        const R = Math.min(8, Math.max(2, Math.ceil(hw * maxW * (1 + OL.pressure) + 1)));
        const sm = strokeMat(R), s = sm.uniforms;
        s.tEdge.value = T.edge.texture; s.uRes.value.set(LW, LH);
        s.uWobble.value = OL.wobble * k * ss; s.uWarp.value = OL.warp * k * ss; s.uPressure.value = OL.pressure; s.uBreakup.value = OL.breakup;
        s.uSeed.value = Math.floor(t * OL.boilFps + 1e-6) % 100000;
        draw(sm, T.line);
        lineOn = true;
      }

      // ③ 雾 → bloom → 调色 → OutputPass
      let src = T.scene.texture;
      if (FG) {
        const f = M.fog.uniforms; f.tColor.value = src; f.tDepth.value = T.scene.depthTexture; setFog(f, FG, camera);
        draw(M.fog, T.fog); src = T.fog.texture;
      }
      let bloomTex = black, bloomAmt = 0;
      if (BL && BL.strength > 0 && bloomLv.length) {
        const pr = M.pre.uniforms; pr.tIn.value = src; pr.uTexel.value.set(1 / W, 1 / H); pr.uThr.value = BL.threshold; pr.uKnee.value = BL.knee;
        draw(M.pre, bloomLv[0].down);
        for (let i = 1; i < bloomLv.length; i++) {
          const d = M.down.uniforms; d.tIn.value = bloomLv[i - 1].down.texture; d.uTexel.value.set(1 / bloomLv[i - 1].w, 1 / bloomLv[i - 1].h);
          draw(M.down, bloomLv[i].down);
        }
        let low = bloomLv[bloomLv.length - 1].down;
        for (let i = bloomLv.length - 2; i >= 0; i--) {
          const u = M.up.uniforms; u.tLow.value = low.texture; u.tCur.value = bloomLv[i].down.texture;
          // 最后一步只取上采样的模糊结果，不混入半分辨率的清晰亮部（否则 bloom 变成「提亮」而不是「光晕」）
          u.uTexel.value.set(1 / bloomLv[i + 1].w, 1 / bloomLv[i + 1].h); u.uRadius.value = i === 0 ? 1 : BL.radius;
          draw(M.up, bloomLv[i].up); low = bloomLv[i].up;
        }
        bloomTex = low.texture; bloomAmt = BL.strength;
      }
      const g = M.grade.uniforms, G = GR || { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 };
      g.tColor.value = src; g.tBloom.value = bloomTex; g.uBloom.value = bloomAmt;
      linVec(BL?.tint ?? '#ffffff', g.uBloomTint.value);
      const wm = G.warmth ?? 0, wb = g.uWB.value.set(1 + .10 * wm, 1 + .012 * wm, 1 - .15 * wm);
      wb.divideScalar(wb.x * .2126 + wb.y * .7152 + wb.z * .0722);
      g.uExposure.value = G.exposure ?? 1; g.uSat.value = G.saturation ?? 1; g.uKnee.value = G.shoulder ?? 1;
      vec3Of(G.lift ?? 0, g.uLift.value); vec3Of(G.gamma ?? 1, g.uGamma.value); vec3Of(G.gain ?? 1, g.uGain.value);
      const pt = KU && KU.protect; g.uProt.value.set(pt ? pt[0] : 0, pt ? pt[1] : 0);
      draw(M.grade, T.grade);
      out.render(renderer, T.out, T.grade);

      // ④ Kuwahara（sRGB 空间）
      let col = T.out.texture;
      if (KU && KU.strength > 0 && KU.radius > 0) {
        const r = KU.radius * k, rf = (KU.farRadius ?? KU.radius) * k, KR = Math.min(10, Math.max(2, Math.ceil(Math.max(r, rf))));
        const km = kuwaMat(KR), u = km.uniforms;
        u.tIn.value = col; u.uTexel.value.set(1 / W, 1 / H); u.uRadius.value = r; u.uQ.value = KU.q ?? 8; u.uStrength.value = Math.min(1, KU.strength);
        u.tDepth.value = T.scene.depthTexture; u.uNear.value = camera.near; u.uFarClip.value = camera.far;
        u.uFar.value.set(rf, KU.farStart ?? 40, KU.farEnd ?? 120, rf !== r && !camera.isOrthographicCamera ? 1 : 0);
        draw(km, T.kuwa); col = T.kuwa.texture;
      }

      // ⑤ 合成：墨线 → 纸纹 → 暗角 →（颗粒）
      const f = M.final.uniforms;
      f.tColor.value = col; f.tLine.value = lineOn ? T.line.texture : black; f.uLineOn.value = lineOn ? 1 : 0;
      if (OL) { srgbVec(OL.color, f.uInk.value); f.uInkTint.value = OL.tint; f.uInkDark.value = OL.darken; }
      const ptex = PA?.tex || extPaper;
      f.tPaper.value = ptex || paperTex; f.uPaper.value = PA ? PA.strength : 0;
      f.uPaperMid.value = PA?.tex ? (PA.mid ?? .5) : extPaper ? extMid : paperMid;
      if (ptex) { const img = ptex.image; f.uPaperSize.value.set((img?.width || 1024) * (PA?.scale ?? 1), (img?.height || 1024) * (PA?.scale ?? 1)); }
      else f.uPaperSize.value.set(W, H);
      f.uVig.value = VG; f.uGrain.value = GN; f.uGrainSeed.value = Math.floor(t * 24 + 1e-6);
      f.uRes.value.set(W, H);
      if (p.debug) drawDebug(p.debug, camera, target, col, bloomTex, f.tPaper.value);
      else draw(M.final, target);
    } finally {
      renderer.autoClear = prevAuto; renderer.setClearColor(_cc, prevAlpha); renderer.setRenderTarget(prevRT);
    }
  }

  function drawDebug(mode, camera, target, col, bloomTex, ptex) {
    const d = M.debug.uniforms; d.uNear.value = camera.near; d.uFar.value = camera.far; d.uScale.value = 1;
    const table = { id: [T.id.texture, 1], depth: [T.id.depthTexture, 2], edge: [T.edge.texture, 3], line: [T.line.texture, 4], bloom: [bloomTex, 5], paper: [ptex, 6], kuwahara: [col, 0], scene: [T.scene.texture, 5] };
    const [tex, m] = table[mode] || [col, 0];
    d.tA.value = tex; d.uMode.value = m;
    if (mode === 'bloom') d.uScale.value = 4;
    draw(M.debug, target);
  }

  function dispose() {
    for (const k in T) T[k]?.dispose?.();
    for (const l of bloomLv) { l.down.dispose(); l.up.dispose(); }
    for (const m of Object.values(M)) m.dispose();
    for (const m of strokeMats.values()) m.dispose();
    for (const m of kuwaMats.values()) m.dispose();
    out.dispose(); fsGeo.dispose(); black.dispose(); extPaper?.dispose();
  }

  return {
    render, ready, dispose,
    setSize(nw, nh) { if (nw !== W || nh !== H) alloc(nw, nh); },
    get targets() { return T; },
    get size() { return { w: W, h: H, ss }; },
  };
}
