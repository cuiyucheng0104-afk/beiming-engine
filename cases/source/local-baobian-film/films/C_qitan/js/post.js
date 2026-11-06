// post.js — C 奇谭的后期合成（由 films/_lib/look.js 拷来改，_lib 本身不动）
// 顺序：① 主场景（MSAA、HalfFloat 线性、深度纹理）
//      ② 墨线：ID 图 → 边缘 → 笔画（look.js 原样，另加"线随雾淡"）
//      ③ bloom → 调色 → OutputPass（线性 → sRGB）
//      ④ 叠墨线 → ⑤ 景深（按深度 / 移轴 / 均匀，可加镜片椭圆）→ ⑥ 方向 / 放射模糊
//      ⑦ 屏幕层（sRGB 空间，叠在景深之后）→ ⑧ 终合成：雨（按底色自适应）→ 纸纹 → 字幕 → 暗角 → 颗粒（1.6K 一格）→ 淡出
// 改动（相对 look.js）：去掉 Kuwahara 与屏幕雾；颗粒按 1.6K 一格；新增景深、模糊、雨、字幕、淡出、渲到目标（不加颗粒暗角）。
// 所有随时间变化的量只取决于 p.t。
import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLSL_COMMON } from './util.js';

const _c = new THREE.Color();
function toColor(v, out = new THREE.Color()) {
  if (v === undefined || v === null) return out.setRGB(1, 1, 1);
  if (v.isColor) return out.copy(v);
  if (Array.isArray(v)) return out.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
  return out.set(v);
}
function linVec(v, out = new THREE.Vector3()) { toColor(v, _c); return out.set(_c.r, _c.g, _c.b); }
function srgbVec(v, out = new THREE.Vector3()) { toColor(v, _c); const o = {}; _c.getRGB(o, THREE.SRGBColorSpace); return out.set(o.r, o.g, o.b); }
function vec3Of(v, out = new THREE.Vector3()) { return Array.isArray(v) ? out.set(v[0], v[1], v[2]) : out.setScalar(v); }

const VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

const FOG = /* glsl */`
uniform vec4 uFogA; uniform vec4 uFogB;
float fogAmount(float dist, float worldY){
  if (uFogA.w < .5 || dist > uFogB.z) return 0.;
  float dens = uFogA.x;
  if (uFogB.y > 0.) dens *= exp(-max(worldY - uFogB.x, 0.) / uFogB.y);
  return (1. - exp(-dens * max(dist - uFogA.y, 0.))) * uFogA.z;
}
uniform mat4 uProjInv, uCamWorld;
vec3 viewPosAt(vec2 uv, float d){ vec4 v = uProjInv * vec4(uv * 2. - 1., d * 2. - 1., 1.); return v.xyz / v.w; }`;

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

const EDGE_FS = /* glsl */`
#include <packing>
${FOG}
uniform sampler2D tId, tDepth;
uniform vec2 uRes;
uniform float uNear, uFar, uOrtho;
uniform float uHalfW, uDepthThr, uInner, uSil, uOpacity, uFogFade;
uniform vec3 uWD;
float lz(ivec2 p){ float d = texelFetch(tDepth, p, 0).x; return uOrtho > .5 ? -orthographicDepthToViewZ(d, uNear, uFar) : -perspectiveDepthToViewZ(d, uNear, uFar); }
float gid(ivec2 p){ vec2 s = texelFetch(tId, p, 0).xy; return s.x + s.y * 2048.; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uRes) - 1;
  vec4 s0 = texelFetch(tId, p, 0);
  float id0 = s0.x + s0.y * 2048.;
  if (id0 < .5 || s0.w < .002) { gl_FragColor = vec4(0.); return; }
  float z0 = lz(p), iz0 = 1. / z0;
  float edge = 0., gap = 0.;
  ivec2 N4[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int k = 0; k < 4; k++) {
    ivec2 q = clamp(p + N4[k], ivec2(0), mx);
    float idq = gid(q);
    if (abs(idq - id0) > .5) {
      float z = lz(q), rel = (z - z0) / z0;
      if (rel > .002 || (rel > -.002 && id0 > idq)) { edge = 1.; gap = max(gap, rel); }
    }
  }
  ivec2 AX[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(1, 1), ivec2(1, -1));
  for (int k = 0; k < 4; k++) {
    float zp = lz(clamp(p + AX[k], ivec2(0), mx)), zm = lz(clamp(p - AX[k], ivec2(0), mx));
    float lap = (1. / zp + 1. / zm - 2. * iz0) / iz0;
    if (lap < -uDepthThr) { edge = 1.; gap = max(gap, max(zp, zm) / z0 - 1.); }
  }
  if (edge < .5) { gl_FragColor = vec4(0.); return; }
  vec2 uv = (vec2(p) + .5) / uRes;
  vec3 vp = viewPosAt(uv, texelFetch(tDepth, p, 0).x);
  vec3 wp = (uCamWorld * vec4(vp, 1.)).xyz;
  float f = fogAmount(length(vp), wp.y);
  float strength = clamp(s0.w, 0., 1.) * uOpacity * (1. - uFogFade * f);
  float hw = uHalfW * s0.z * mix(1., uWD.z, smoothstep(uWD.x, uWD.y, z0)) * (gap > uSil ? 1. : uInner);
  gl_FragColor = vec4(strength, hw, gap, 1.);
}`;

const STROKE_FS = /* glsl */`
${GLSL_COMMON}
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

const BLOOM_PRE_FS = /* glsl */`
uniform sampler2D tIn; uniform vec2 uTexel; uniform float uThr, uKnee;
varying vec2 vUv;
void main(){
  vec2 o = uTexel;
  vec3 c = (texture2D(tIn, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tIn, vUv + vec2(o.x, -o.y)).rgb
          + texture2D(tIn, vUv + vec2(-o.x, o.y)).rgb + texture2D(tIn, vUv + vec2(o.x, o.y)).rgb) * .25;
  float l = max(c.r, max(c.g, c.b));
  if (!(l < 1e4) || !(l >= 0.)) { c = vec3(0.); l = 0.; }
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

// 返修 style-07（第 2 轮）：屏幕空间体积光（丁达尔光柱）。
//   ① 光源遮罩（半分辨率）：只取"没有写深度的远处"（天、底板、雾带、太阳）里比阈值亮的部分，按离太阳的距离衰减；
//      崖、松、豹和人的深度遮罩是遮挡物，所以光柱里会被它们切出影子。再乘一层按角度的低频噪声，像远处云隙把光分成一束一束。
//   ② 放射模糊：从每个像素朝太阳方向步进 64 次、逐步衰减累加（按像素哈希抖动起点，没有阶梯）。
//   ③ 在调色里按琥珀色加回去（线性空间，进肩部压缩之前）。全是当前帧的纯函数。
const RAY_MASK_FS = /* glsl */`
#include <packing>
${GLSL_COMMON}
uniform sampler2D tColor, tDepth; uniform vec2 uSun, uDir; uniform float uThr, uAspect, uR, uBeams, uSeed, uBeamF, uCore;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  float far = step(.999999, d);
  float l = max(c.r, max(c.g, c.b));
  vec2 dd = (vUv - uSun) * vec2(uAspect, 1.);
  float r = length(dd);
  float fall = exp(-r * r / (uR * uR));
  float ang = atan(dd.y, dd.x);
  // 一束一束：低频的宽束（每弧度约 5 个起伏）+ 细一档的纹理；只往画面里（左下）扇开，朝天的方向不出光柱（不是贴纸式的放射星）
  float bn = sst(.36, .74, vnoise(vec2(ang * uBeamF + uSeed, 3.1), 47u)) * (.6 + .4 * vnoise(vec2(ang * uBeamF * 3.4 + uSeed * 2., 7.3), 48u));
  float beams = mix(1., .04 + 2.3 * bn, uBeams);
  // 第 4 轮（v3-05）：日芯半径以内不参与按角度的明暗调制（原来两束之间的暗缝一直伸进日心，日芯上像被切了一刀）；光束从日芯外缘才开始
  beams = mix(beams, 1.05, 1. - sst(uCore * .8, uCore * 1.25, r));
  float dirW = sst(.66, .95, dot(dd / max(r, 1e-4), uDir));
  float m = max(l - uThr, 0.) * far * fall * beams * dirW;
  gl_FragColor = vec4(c / max(l, 1e-3) * min(m, 4.), 1.);
}`;
const RAY_BLUR_FS = /* glsl */`
${GLSL_COMMON}
uniform sampler2D tIn, tDepth; uniform vec2 uSun; uniform float uDensity, uDecay, uWeight, uNear;
varying vec2 vUv;
void main(){
  // 近处的实体（崖、人、豹）前面的空气少：只吃 uNear 那么多的散射光，暗部不被洗灰
  float own = step(.999999, texture2D(tDepth, vUv).x);
  vec2 delta = (vUv - uSun) * uDensity / 64.;
  vec2 uv = vUv - delta * h21(ivec2(gl_FragCoord.xy), 3u);
  vec3 acc = vec3(0.); float w = 1.;
  for (int i = 0; i < 64; i++) { acc += texture2D(tIn, uv).rgb * w; w *= uDecay; uv -= delta; }
  gl_FragColor = vec4(acc * uWeight / 64. * mix(uNear, 1., own), 1.);
}`;

const GRADE_FS = /* glsl */`
${GLSL_COMMON}
uniform sampler2D tColor, tBloom, tRays;
uniform float uBloom, uExposure, uSat, uKnee, uRays, uToe, uRayWipe, uDesW;
uniform vec3 uBloomTint, uWB, uLift, uGamma, uGain, uRayTint; uniform vec2 uWipeE; uniform vec3 uRaySun;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tColor, vUv).rgb * uExposure;
  c += texture2D(tBloom, vUv).rgb * uBloom * uBloomTint;
  vec2 dp = vec2(vUv.x * uDesW, (1. - vUv.y) * 1040.);
  // 返修 v2-03（第 3 轮）：S4c 的体积光是雾散以后的日光——只加在翻色前沿已经扫过的那一侧（前沿右边），前沿左边仍是灰态（第 4 轮：前沿用 wipeD，和各着色器一致）
  // 第 4 轮（v3-05）：日芯里不再加体积光——琥珀色的光加在已经顶满的白日芯上，肩部压缩按色相保持把 G、B 压下去，
  //   加了光的那一扇反而读成一道"暗带"切进日心；光束从日芯外缘才开始
  if (uRays > 0.) { float rs = length((vUv - uRaySun.xy) * vec2(uDesW / 1040., 1.)); c += texture2D(tRays, vUv).rgb * uRays * uRayTint * smoothstep(-160., 160., wipeD(dp, uRayWipe)) * sst(uRaySun.z * .85, uRaySun.z * 1.35, rs); }
  // 第 4 轮（qa2-07）：翻色前沿里侧一道颜料积色（水彩的干边）：深一档、略浓，约 20K 宽，贴着前沿走
  if (uWipeE.y > 0.) { float wd = wipeD(dp, uWipeE.x); float band = (1. - sst(0., 24., abs(wd - 26.))) * uWipeE.y; c *= 1. - .16 * band; float l0 = dot(c, vec3(.2126, .7152, .0722)); c = mix(vec3(l0), c, 1. + .3 * band); }
  c *= uWB;
  float l = dot(c, vec3(.2126, .7152, .0722));
  c = max(mix(vec3(l), c, uSat), 0.);
  vec3 g = pow(c, vec3(1. / 2.2));
  g = uGain * (g + uLift * max(1. - g, 0.));
  // 返修 style-11（第 2 轮）：暗部曲线（toe）——只压暗部，中间调基本不动（修复室 p5 目标 12–25）
  if (uToe > 0.) g -= uToe * g * (1. - smoothstep(0., .45, g));
  g = pow(max(g, 0.), 1. / uGamma);
  c = pow(g, vec3(2.2));
  if (uKnee < .999) {
    vec3 k = vec3(uKnee);
    vec3 pc = min(c, k) + (1. - k) * (1. - exp(-max(c - k, 0.) / (1. - k)));
    float m = max(c.r, max(c.g, c.b));
    float mm = m < uKnee ? m : uKnee + (1. - uKnee) * (1. - exp(-(m - uKnee) / (1. - uKnee)));
    c = mix(c * (mm / max(m, 1e-5)), pc, .3);
  }
  gl_FragColor = vec4(c, 1.);
}`;

// ④ 叠墨线（sRGB）
const INK_FS = /* glsl */`
uniform sampler2D tColor, tLine;
uniform float uLineOn, uInkTint, uInkDark;
uniform vec3 uInk;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tColor, vUv).rgb;
  if (uLineOn > .5) {
    float cov = texture2D(tLine, vUv).r;
    vec3 ink = min(uInk, c * uInkDark);
    ink = mix(ink, ink * (.55 + .9 * c), uInkTint);
    c = mix(c, ink, cov);
  }
  gl_FragColor = vec4(c, 1.);
}`;

// ⑤ 景深：样本自身的 CoC ≥ 距离才计入；比中心远的样本还要中心自己的 CoC 覆盖到（背景不渗进清楚的前景）；
//    另一圈只收"比中心近"的样本，把虚掉的前景盖到清楚的背景上。亮样本 ×1.6 做圆盘散景。
const DOF_FS = /* glsl */`
#include <packing>
${GLSL_COMMON}
uniform sampler2D tColor, tDepth;
uniform vec2 uRes;
uniform float uNear, uFar, uOrtho, uK, uDW;
uniform float uZf, uCocScale, uCocMax, uDefocus, uRfg, uMode;
uniform vec4 uTilt;
uniform vec4 uLens, uLens2; uniform float uDbgC, uLensAmt;
varying vec2 vUv;
float viewZ(vec2 uv){ float d = texture2D(tDepth, uv).x; if (d >= .999999) return 1e5; return uOrtho > .5 ? -orthographicDepthToViewZ(d, uNear, uFar) : -perspectiveDepthToViewZ(d, uNear, uFar); }
vec2 dpos(vec2 uv){ return vec2(uv.x * uDW, (1. - uv.y) * 1040.); }
float cocOf(vec2 uv, float z){
  float c = 0.;
  if (uMode < .5) c = min(uCocScale * abs(1. / z - 1. / uZf), uCocMax);
  else if (uMode < 1.5) { float y = (1. - uv.y) * 1040.; c = y < uTilt.x ? uTilt.y * sst(0., 1., (uTilt.x - y) / uTilt.x) : (y > uTilt.z ? uTilt.w * sst(0., 1., (y - uTilt.z) / (1040. - uTilt.z)) : 0.); }
  c = max(c, uDefocus);
  if (uLens2.w > .5) { float e = ellR(dpos(uv), uLens.xy, uLens.zw, uLens2.x); c = max(c, uLens2.z * sst(.97, 1.05, e)); }
  return c * uK;
}
void main(){
  float z0 = viewZ(vUv);
  float c0 = cocOf(vUv, z0);
  vec3 c = texture2D(tColor, vUv).rgb;
  float rot = h21(ivec2(gl_FragCoord.xy), 71u) * 6.2832;
  vec3 res = c;
  if (c0 > .6) {
    vec3 acc = c; float ws = 1.;
    for (int i = 0; i < 48; i++) {
      float fi = float(i) + .5;
      float r = sqrt(fi / 48.) * c0;
      float a = fi * 2.39996323 + rot;
      vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
      float zs = viewZ(uv); float cs = cocOf(uv, zs);
      vec3 s = texture2D(tColor, uv).rgb;
      float w = sst(r - 1.5, r + .5, cs);
      w *= 1. + .6 * step(.85, lum(s));
      acc += s * w; ws += w;
    }
    res = acc / ws;
  }
  if (uRfg > .6) {
    vec3 acc = vec3(0.); float ws = 0.; float R = uRfg * uK;
    for (int i = 0; i < 40; i++) {
      float fi = float(i) + .5;
      float r = sqrt(fi / 40.) * R;
      float a = fi * 2.39996323 + rot * 1.7;
      vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
      float zs = viewZ(uv);
      if (zs > z0 * .97) continue;
      float cs = cocOf(uv, zs);
      if (cs < c0 + .5) continue;
      float w = sst(r - 1.5, r + .5, cs);
      acc += texture2D(tColor, uv).rgb * w; ws += w;
    }
    if (ws > 0.) res = mix(res, acc / ws, clamp(ws / 14., 0., 1.));
  }
  if (uLens2.w > .5) {
    vec2 p = dpos(vUv);
    float e = ellR(p, uLens.xy, uLens.zw, uLens2.x);
    vec2 q = uLens.xy + (p - uLens.xy) / uLens2.y;
    vec2 uvq = vec2(q.x / uDW, 1. - q.y / 1040.);
    res = mix(res, texture2D(tColor, uvq).rgb, (1. - sst(.97, 1.03, e)) * uLensAmt);
  }
  if (uDbgC > .5) res = vec3(c0 / 40., viewZ(vUv) < 1e4 ? 1. / max(viewZ(vUv), .01) / 20. : 0., 0.);
  gl_FragColor = vec4(res, 1.);
}`;

// ⑥ 方向模糊（甩镜）/ 放射模糊（推进豹眼）
const BLUR_FS = /* glsl */`
${GLSL_COMMON}
uniform sampler2D tColor; uniform vec2 uRes, uDir; uniform vec4 uRad;
varying vec2 vUv;
// 返修 tech-06：48 个样本，每个像素按哈希抖动起点，放射模糊不再出年轮状的阶梯
void main(){
  vec3 acc = vec3(0.);
  float j = h21(ivec2(gl_FragCoord.xy), 5u);
  for (int i = 0; i < 48; i++) {
    float t = (float(i) + j) / 48. - .5;
    vec2 uv = vUv + uDir / uRes * t;
    if (uRad.w > .5) uv = uRad.xy + (uv - uRad.xy) * (1. + uRad.z * t);
    acc += texture2D(tColor, uv).rgb;
  }
  gl_FragColor = vec4(acc / 48., 1.);
}`;

// ⑧ 终合成
const FINAL_FS = /* glsl */`
${GLSL_COMMON}
uniform sampler2D tColor, tPaper, tRain, tSub;
uniform float uPaper, uPaperMid, uVig, uGrain, uGrainSeed, uK, uRainOn, uSubOn, uSubA, uFade, uDbg, uVigHi;
uniform vec3 uFadeCol; uniform vec2 uRes, uPaperSize;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tColor, vUv).rgb;
  if (uRainOn > .5) { float a = texture2D(tRain, vUv).r; c = mix(c + .25 * a, c * (1. - .45 * a), sst(.5, .7, lum(c))); if (uDbg > .5) c = vec3(a * 4.); }
  // 返修 style-19：纸纹只做底子——亮的平涂大面（L > 180/255）里减到 0.4 倍
  if (uPaper > 0.) { float pp = texture2D(tPaper, gl_FragCoord.xy / uPaperSize).r; float pk = mix(1., .4, sst(.66, .76, lum(c))); c *= 1. + uPaper * pk * 2. * (pp - uPaperMid); }
  if (uSubOn > .5) { vec4 s = texture2D(tSub, vUv); c = mix(c, s.rgb, s.a * uSubA); }
  if (uVig > 0.) {
    vec2 a = vec2(uRes.x / uRes.y, 1.);
    float r = length((vUv - .5) * a) / length(a * .5);
    // 返修 style-07（第 2 轮）：太阳在画角里，暗角把日芯压得比周围的天还暗（"纸月亮"）。uVigHi > 0 时高光不吃暗角
    c *= 1. - uVig * smoothstep(.32, 1.05, r) * (1. - uVigHi * sst(.86, .97, lum(c)));
  }
  if (uGrain > 0.) {
    // 返修 main-04（第 2 轮）：颗粒改成平滑的值噪声（约 2.2K 一颗、没有方格硬边），高频能量少，x264 好压得多；仍是一拍二换图案
    uint sd = uint(uGrainSeed) * 2654435761u;
    vec2 gp = gl_FragCoord.xy / (2.2 * uK);
    float n = (vnoise(gp, sd) + vnoise(gp * 1.37 + 17.3, sd + 77u) - 1.) * 1.25;
    float l = dot(c, vec3(.2126, .7152, .0722));
    c += n * uGrain * .046 * (1. - .5 * l);   // 返修 main-04：强度 ×0.85（第 1 轮）→ ×0.77（第 2 轮）；中间调 σ 约 3（8 bit），仍在 DESIGN 的 3–4 内
  }
  c = mix(c, uFadeCol, uFade);
  gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
}`;

const PAPER_FS = /* glsl */`
${GLSL_COMMON}
uniform float uK;
float tooth(vec2 p){ return fbm3(p / (4.5 * uK), 23u); }
void main(){
  vec2 p = gl_FragCoord.xy;
  float grain = h21(ivec2(p / uK), 7u) - .5;
  float g2 = vnoise(p / (1.7 * uK), 9u) - .5;
  float emb = (tooth(p + vec2(-1., 1.) * uK) - tooth(p + vec2(1., -1.) * uK));
  float mott = fbm3(p / (160. * uK), 37u);
  float fib = vnoise(vec2(p.x / 70., p.y / 2.5) * mat2(.96, .28, -.28, .96) / uK, 51u) - .5;
  float v = .5 + grain * .03 + g2 * .08 + emb * .5 + mott * .3 + fib * .05;
  gl_FragColor = vec4(v, v, v, 1.);
}`;

export function createPost(renderer, w, h, opts = {}) {
  const ss = opts.ss ?? 2;
  const msaa = opts.msaa ?? 4;
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
      grade: rt(W, H), out: rt(W, H), ink: rt(W, H), dof: rt(W, H), blur: rt(W, H),
      rain: rt(W, H, { type: THREE.UnsignedByteType }),
      paper: rt(W, H, { type: THREE.UnsignedByteType, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping }),
      rayA: rt(W >> 1, H >> 1), rayB: rt(W >> 1, H >> 1),
    };
    T.ink.depthBuffer = false;
    bloomLv = [];
    let bw = W >> 1, bh = H >> 1;
    while (bloomLv.length < 7 && Math.min(bw, bh) >= 8) { bloomLv.push({ w: bw, h: bh, down: rt(bw, bh), up: rt(bw, bh) }); bw >>= 1; bh >>= 1; }
    paperDirty = true;
  }
  const fogU = () => ({ uFogA: { value: new THREE.Vector4() }, uFogB: { value: new THREE.Vector4() }, uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() } });
  const M = {
    edge: mat(EDGE_FS, { ...fogU(), tId: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uNear: { value: .1 }, uFar: { value: 100 }, uOrtho: { value: 0 },
      uHalfW: { value: 2 }, uDepthThr: { value: .03 }, uInner: { value: .6 }, uSil: { value: .12 }, uOpacity: { value: 1 }, uFogFade: { value: 1 }, uWD: { value: new THREE.Vector3() } }),
    pre: mat(BLOOM_PRE_FS, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() }, uThr: { value: .7 }, uKnee: { value: .2 } }),
    down: mat(BLOOM_DOWN_FS, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() } }),
    up: mat(BLOOM_UP_FS, { tLow: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: .6 } }),
    grade: mat(GRADE_FS, { tColor: { value: null }, tBloom: { value: null }, tRays: { value: null }, uBloom: { value: 0 }, uExposure: { value: 1 }, uSat: { value: 1 }, uKnee: { value: 1 }, uRays: { value: 0 }, uToe: { value: 0 }, uRayWipe: { value: -1e9 }, uDesW: { value: 1920 }, uRayTint: { value: new THREE.Vector3(1, 1, 1) }, uWipeE: { value: new THREE.Vector2(0, 0) }, uRaySun: { value: new THREE.Vector3(0, 0, 0) },
      uBloomTint: { value: new THREE.Vector3(1, 1, 1) }, uWB: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) } }),
    rayMask: mat(RAY_MASK_FS, { tColor: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2(-.87, -.5) }, uThr: { value: .8 }, uAspect: { value: 1.846 }, uR: { value: .6 }, uBeams: { value: .7 }, uSeed: { value: 0 }, uBeamF: { value: 5 }, uCore: { value: 0 } }),
    rayBlur: mat(RAY_BLUR_FS, { tIn: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uDensity: { value: .9 }, uDecay: { value: .97 }, uWeight: { value: 1 }, uNear: { value: .5 } }),
    ink: mat(INK_FS, { tColor: { value: null }, tLine: { value: null }, uLineOn: { value: 0 }, uInkTint: { value: 0 }, uInkDark: { value: .6 }, uInk: { value: new THREE.Vector3() } }),
    dof: mat(DOF_FS, { tColor: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uNear: { value: .1 }, uFar: { value: 100 }, uOrtho: { value: 0 }, uK: { value: 1 }, uDW: { value: 1920 },
      uZf: { value: 1 }, uCocScale: { value: 0 }, uCocMax: { value: 0 }, uDefocus: { value: 0 }, uRfg: { value: 0 }, uMode: { value: 0 },
      uTilt: { value: new THREE.Vector4() }, uLens: { value: new THREE.Vector4() }, uLens2: { value: new THREE.Vector4() }, uDbgC: { value: 0 }, uLensAmt: { value: 1 } }),
    blur: mat(BLUR_FS, { tColor: { value: null }, uRes: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2() }, uRad: { value: new THREE.Vector4() } }),
    final: mat(FINAL_FS, { tColor: { value: null }, tPaper: { value: null }, tRain: { value: null }, tSub: { value: null }, uPaper: { value: 0 }, uPaperMid: { value: .5 },
      uVig: { value: 0 }, uGrain: { value: 0 }, uGrainSeed: { value: 0 }, uK: { value: 1 }, uRainOn: { value: 0 }, uSubOn: { value: 0 }, uSubA: { value: 1 }, uFade: { value: 0 }, uDbg: { value: 0 }, uVigHi: { value: 0 },
      uFadeCol: { value: new THREE.Vector3() }, uRes: { value: new THREE.Vector2() }, uPaperSize: { value: new THREE.Vector2() } }),
    paper: mat(PAPER_FS, { uK: { value: 1 } }),
  };
  const strokeMats = new Map();
  const strokeMat = R => {
    if (!strokeMats.has(R)) strokeMats.set(R, mat(STROKE_FS, { tEdge: { value: null }, uRes: { value: new THREE.Vector2() }, uWobble: { value: 1 }, uWarp: { value: 60 }, uPressure: { value: 0 }, uBreakup: { value: 0 }, uSeed: { value: 0 } }, { SR: R }));
    return strokeMats.get(R);
  };
  const out = new OutputPass();
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  const clear0 = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); clear0.needsUpdate = true;

  let paperDirty = true, paperMid = .5;
  function makePaper() {
    M.paper.uniforms.uK.value = Math.max(.5, H / 1080);
    draw(M.paper, T.paper);
    const n = 128, buf = new Uint8Array(n * n * 4);
    renderer.readRenderTargetPixels(T.paper, 0, 0, n, n, buf);
    let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i] / 255;
    paperMid = s / (n * n); paperDirty = false;
  }

  // ── ID 图（look.js 原样） ──
  const idCache = new WeakMap();
  const IDENT3 = new THREE.Matrix3();
  function idMaterialFor(o, m0, ov) {
    const cut = !!(m0 && m0.map && (m0.alphaTest > 0 || m0.transparent));
    const side = m0 ? m0.side : THREE.FrontSide;
    const sig = `${cut ? m0.map.uuid : ''}|${side}|${ov ? ov.head + ov.body : ''}`;
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
  function renderIds(scene, camera) {
    const swaps = [], hidden = [], patched = new Map(), groups = new Map(), cbs = [];
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
      const st = { outline: u.outline ?? inh.outline, width: u.outlineWidth ?? inh.width, alpha: u.outlineAlpha ?? inh.alpha,
        occ: u.outlineOccluder ?? inh.occ, per: u.outlinePerInstance ?? inh.per, ov: u.outlineVertex ?? inh.ov, grp: u.outlineGroup ?? inh.grp };
      if (o.isMesh || o.isSprite || o.isPoints || o.isLine) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const m0 = mats[0];
        if (st.outline === true && o.isMesh) {
          const m = idMaterialFor(o, m0, st.ov);
          if (st.grp !== undefined && st.grp !== null) {
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
            if (o.isPoints || o.isLine || mats.every(m => m.blending === THREE.AdditiveBlending || m.colorWrite === false)) mode = false;
            else if (o.isSprite || mats.some(m => m.transparent)) mode = 'soft';
            else if (mats.some(m => m.isShaderMaterial)) mode = 'own';
            else mode = 'solid';
          }
          if (mode === false || ((o.isPoints || o.isLine) && mode !== 'soft')) { hidden.push(o); o.visible = false; }
          else if (mode === 'soft' || mode === 'own') { for (const m of mats) patch(m, mode === 'soft'); }
          else if (o.isMesh) {
            const m = idMaterialFor(o, m0, st.ov);
            m.uniforms.uBaseId.value = 0; m.uniforms.uPerInstance.value = 0; m.uniforms.uWidth.value = 0; m.uniforms.uAlpha.value = 0;
            swaps.push([o, o.material]); o.material = m; guard(o);
          } else { hidden.push(o); o.visible = false; }
        }
      }
      for (const c of o.children) visit(c, st);
    };
    visit(scene, { outline: undefined, width: 1, alpha: 1, occ: undefined, per: true, ov: undefined, grp: undefined });
    const bg = scene.background;
    scene.background = null;
    try {
      renderer.setRenderTarget(T.id);
      renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true);
      renderer.render(scene, camera);
    } finally {
      for (const [o, m] of swaps) o.material = m;
      for (const [o, f] of cbs) o.onBeforeRender = f;
      for (const o of hidden) o.visible = true;
      for (const [m, save] of patched) Object.assign(m, save);
      scene.background = bg;
    }
    return maxWidth || 1;
  }
  const setFog = (u, fog, camera) => {
    u.uProjInv.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    if (!fog) { u.uFogA.value.set(0, 0, 0, 0); return; }
    u.uFogA.value.set(fog.density ?? .02, fog.start ?? 0, fog.max ?? 1, 1);
    u.uFogB.value.set(fog.baseHeight ?? 0, fog.falloff ?? 0, fog.cutoff ?? 1e9, 0);
  };

  alloc(w, h);
  const _cc = new THREE.Color();
  const DEF_OL = { width: 2.0, color: '#1A0F0A', wobble: .6, boilFps: 12, warp: 60, pressure: .3, breakup: .12, inner: .5, silhouette: .12, depthThreshold: .03, near: 4, far: 80, farScale: .55, opacity: 1, tint: .15, darken: .5, fogFade: .9 };

  function render(scene, camera, p = {}) {
    const t = p.t ?? 0, k = H / 1080, K = H / 1040;
    const OL = p.outline ? { ...DEF_OL, ...p.outline } : null;
    const BL = p.bloom || null, GR = p.grade || null;
    const target = p.target ?? null, noFx = !!p.noFx;
    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_cc);
    renderer.autoClear = false;
    try {
      if (paperDirty) makePaper();
      camera.updateMatrixWorld();
      // ① 主场景
      renderer.setRenderTarget(T.scene); renderer.setClearColor(p.clear ?? 0x000000, 1); renderer.clear(true, true, true);
      renderer.render(scene, camera);
      // ② 墨线
      let lineOn = false;
      if (OL && OL.opacity > 0 && OL.width > 0) {
        const maxW = renderIds(scene, camera);
        const e = M.edge.uniforms;
        e.tId.value = T.id.texture; e.tDepth.value = T.id.depthTexture; e.uRes.value.set(LW, LH);
        e.uNear.value = camera.near; e.uFar.value = camera.far; e.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
        const hw = OL.width * .5 * k * ss;
        e.uHalfW.value = hw; e.uDepthThr.value = OL.depthThreshold; e.uInner.value = OL.inner; e.uSil.value = OL.silhouette;
        e.uOpacity.value = OL.opacity; e.uFogFade.value = p.lineFog ? OL.fogFade : 0; e.uWD.value.set(OL.near, OL.far, OL.farScale);
        setFog(e, p.lineFog, camera);
        draw(M.edge, T.edge);
        const R = Math.min(8, Math.max(2, Math.ceil(hw * maxW * (1 + OL.pressure) + 1)));
        const sm = strokeMat(R), s = sm.uniforms;
        s.tEdge.value = T.edge.texture; s.uRes.value.set(LW, LH);
        s.uWobble.value = OL.wobble * k * ss; s.uWarp.value = OL.warp * k * ss; s.uPressure.value = OL.pressure; s.uBreakup.value = OL.breakup;
        s.uSeed.value = Math.floor(Math.round(t * 24) * OL.boilFps / 24 + 1e-6) % 100000;
        draw(sm, T.line);
        lineOn = true;
      }
      // ③ bloom → 调色 → sRGB
      const src = T.scene.texture;
      let bloomTex = black, bloomAmt = 0;
      if (BL && BL.strength > 0 && bloomLv.length) {
        const pr = M.pre.uniforms; pr.tIn.value = src; pr.uTexel.value.set(1 / W, 1 / H); pr.uThr.value = BL.threshold; pr.uKnee.value = BL.knee ?? .25;
        draw(M.pre, bloomLv[0].down);
        for (let i = 1; i < bloomLv.length; i++) {
          const d = M.down.uniforms; d.tIn.value = bloomLv[i - 1].down.texture; d.uTexel.value.set(1 / bloomLv[i - 1].w, 1 / bloomLv[i - 1].h);
          draw(M.down, bloomLv[i].down);
        }
        let low = bloomLv[bloomLv.length - 1].down;
        for (let i = bloomLv.length - 2; i >= 0; i--) {
          const u = M.up.uniforms; u.tLow.value = low.texture; u.tCur.value = bloomLv[i].down.texture;
          u.uTexel.value.set(1 / bloomLv[i + 1].w, 1 / bloomLv[i + 1].h); u.uRadius.value = i === 0 ? 1 : BL.radius;
          draw(M.up, bloomLv[i].up); low = bloomLv[i].up;
        }
        bloomTex = low.texture; bloomAmt = BL.strength;
      }
      // 体积光（返修 style-07 第 2 轮）：p.rays = { x, y（设计像素）, amt, thr, r, density, decay, beams, tint }
      const RY = p.rays;
      let rayAmt = 0;
      if (RY && RY.amt > 0) {
        const su = RY.x / (W / K), sv = 1 - RY.y / 1040;
        const rm = M.rayMask.uniforms; rm.tColor.value = src; rm.tDepth.value = T.scene.depthTexture; rm.uSun.value.set(su, sv); rm.uThr.value = RY.thr ?? .8; rm.uAspect.value = W / H; rm.uR.value = RY.r ?? .6; rm.uBeams.value = RY.beams ?? .7; rm.uSeed.value = RY.seed ?? 0; rm.uBeamF.value = RY.beamF ?? 5; rm.uCore.value = Math.max(RY.core ?? 0, 1) / 1040;
        { const dx = RY.dir ? RY.dir[0] : -.87, dy = RY.dir ? RY.dir[1] : -.5, dl = Math.hypot(dx, dy) || 1; rm.uDir.value.set(dx / dl, dy / dl); }   // uv 空间（y 朝上）里光柱扇开的主方向
        draw(M.rayMask, T.rayA);
        const rb = M.rayBlur.uniforms; rb.tIn.value = T.rayA.texture; rb.tDepth.value = T.scene.depthTexture; rb.uNear.value = RY.near ?? .5; rb.uSun.value.set(su, sv); rb.uDensity.value = RY.density ?? .9; rb.uDecay.value = RY.decay ?? .97; rb.uWeight.value = 1;
        draw(M.rayBlur, T.rayB);
        rayAmt = RY.amt;
      }
      const g = M.grade.uniforms, G = GR || { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 };
      g.tColor.value = src; g.tBloom.value = bloomTex; g.uBloom.value = bloomAmt;
      g.tRays.value = rayAmt > 0 ? T.rayB.texture : black; g.uRays.value = rayAmt; linVec(RY?.tint ?? '#F3C46B', g.uRayTint.value); g.uRayWipe.value = RY?.wipe ?? -1e9; g.uDesW.value = W / K; g.uWipeE.value.set(p.wipeE ? p.wipeE.x : 0, p.wipeE ? (p.wipeE.a ?? 1) : 0);
      if (RY && RY.amt > 0) g.uRaySun.value.set(RY.x / (W / K), 1 - RY.y / 1040, Math.max(RY.core ?? 0, 1) / 1040); else g.uRaySun.value.set(0, 0, 0);
      linVec(BL?.tint ?? '#ffffff', g.uBloomTint.value);
      const wm = G.warmth ?? 0, wb = g.uWB.value.set(1 + .10 * wm, 1 + .012 * wm, 1 - .15 * wm);
      wb.divideScalar(wb.x * .2126 + wb.y * .7152 + wb.z * .0722);
      g.uExposure.value = G.exposure ?? 1; g.uSat.value = G.saturation ?? 1; g.uKnee.value = G.shoulder ?? 1; g.uToe.value = G.toe ?? 0;
      vec3Of(G.lift ?? 0, g.uLift.value); vec3Of(G.gamma ?? 1, g.uGamma.value); vec3Of(G.gain ?? 1, g.uGain.value);
      draw(M.grade, T.grade);
      out.render(renderer, T.out, T.grade);
      // ④ 叠墨线
      const ik = M.ink.uniforms;
      ik.tColor.value = T.out.texture; ik.tLine.value = lineOn ? T.line.texture : black; ik.uLineOn.value = lineOn ? 1 : 0;
      if (OL) { srgbVec(OL.color, ik.uInk.value); ik.uInkTint.value = OL.tint; ik.uInkDark.value = OL.darken; }
      draw(M.ink, T.ink);
      let cur = T.ink;
      // ⑤ 景深
      const D = p.dof;
      if (D && (D.mode === 'tilt' || D.mode === 'const' || (D.cocMax > 0 && D.cocScale > 0) || (D.defocus > 0) || D.lens || D.rfg > 0)) {
        const u = M.dof.uniforms;
        u.tColor.value = cur.texture; u.tDepth.value = T.scene.depthTexture; u.uRes.value.set(W, H);
        u.uNear.value = camera.near; u.uFar.value = camera.far; u.uOrtho.value = camera.isOrthographicCamera ? 1 : 0; u.uK.value = K; u.uDW.value = W / K;
        u.uZf.value = D.zf ?? 1; u.uCocScale.value = D.cocScale ?? 0; u.uCocMax.value = D.cocMax ?? 0; u.uDefocus.value = D.defocus ?? 0; u.uRfg.value = D.rfg ?? 0;
        u.uMode.value = D.mode === 'tilt' ? 1 : D.mode === 'const' ? 2 : 0;
        if (D.tilt) u.uTilt.value.set(...D.tilt);
        if (D.lens) { const L = D.lens; u.uLens.value.set(L.cx, L.cy, L.rx, L.ry); u.uLens2.value.set(L.tilt, L.zoom ?? 1, L.coc ?? 0, 1); u.uLensAmt.value = L.amt ?? 1; } else u.uLens2.value.set(0, 1, 0, 0);
        u.uDbgC.value = p.dbgCoc ? 1 : 0;
        draw(M.dof, T.dof); cur = T.dof;
      }
      // ⑥ 模糊
      const B = p.blur;
      if (B && ((B.dir && Math.hypot(B.dir[0], B.dir[1]) > .5) || (B.radial && B.radial[2] > .001))) {
        const u = M.blur.uniforms;
        u.tColor.value = cur.texture; u.uRes.value.set(W, H);
        u.uDir.value.set(B.dir ? B.dir[0] * K : 0, B.dir ? -B.dir[1] * K : 0);
        if (B.radial) u.uRad.value.set(B.radial[0] / (W / K), 1 - B.radial[1] / 1040, B.radial[2], 1); else u.uRad.value.set(0, 0, 0, 0);
        const dst = cur === T.blur ? T.dof : T.blur;
        draw(M.blur, dst); cur = dst;
      }
      // ⑦ 屏幕层（sRGB，叠在景深之后）
      if (p.overlay) { renderer.setRenderTarget(cur); for (const o of [].concat(p.overlay)) renderer.render(o.scene, o.camera); }
      // 雨：先把覆盖度画进 T.rain
      let rainOn = 0;
      if (p.rain && !noFx) { renderer.setRenderTarget(T.rain); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false); renderer.render(p.rain.scene, p.rain.camera); rainOn = 1; }
      // ⑧ 终合成
      const f = M.final.uniforms;
      f.tColor.value = cur.texture; f.tPaper.value = T.paper.texture; f.uPaperMid.value = paperMid; f.uPaperSize.value.set(W, H);
      f.tRain.value = rainOn ? T.rain.texture : clear0; f.uRainOn.value = rainOn; f.uDbg.value = p.dbgRain ? 1 : 0;
      f.uPaper.value = noFx ? 0 : (p.paper ?? 0); f.uVig.value = noFx ? 0 : (p.vignette ?? 0); f.uGrain.value = noFx ? 0 : (p.grain ?? 0); f.uVigHi.value = p.vigHi ?? 0;
      f.uGrainSeed.value = Math.floor(Math.round(t * 24) / 2) % 3; f.uK.value = K; f.uRes.value.set(W, H);   // 返修 main-04：颗粒图案一拍二（每 2 帧换一次）；第 2 轮：三张颗粒图轮换（6 帧一循环），编码器能从前几帧找到同一张，码率减半
      if (p.sub && !noFx) { f.tSub.value = p.sub.tex; f.uSubOn.value = 1; f.uSubA.value = p.sub.alpha ?? 1; } else { f.tSub.value = clear0; f.uSubOn.value = 0; }
      if (p.fade && !noFx) { f.uFade.value = p.fade.amt; srgbVec(p.fade.color, f.uFadeCol.value); } else f.uFade.value = 0;
      draw(M.final, target);
    } finally {
      renderer.autoClear = prevAuto; renderer.setClearColor(_cc, prevAlpha); renderer.setRenderTarget(prevRT);
    }
  }
  return { render, get targets() { return T; }, get size() { return { w: W, h: H, ss }; } };
}
