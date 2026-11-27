// 北冥引擎 · 暗场舞台光（屏幕空间，在线性 HDR 里、bloom 之前加）：局部暖光源 + 多层空气薄雾。
// 主光（平行光）照不到的暗场里，最多 4 盏「窗灯」按世界距离衰减，半兰伯特两档量化：受光面亮、背光面保持暗，明暗反差来自这里；
// 光同时照亮像素处的那层雾（空气里的光晕）。雾按世界高度分层（高斯带 × 随距离变浓再淡出 × 随 t 漂移的值噪声），最多 4 层；
// 厚度给得很大就是不分层的空气透视。物体材质不用改：深度 + 颜色就能算，噪声只取决于 p.t，任意帧可以单独重渲。
//
//   STAGE_BASE                 { lights: [], haze: [] }（关）
//   DARK_STAGE                 暗场调子的后期默认值：{ bloom, grade, vignette }（克制的暖色辉光 + 强反差调色 + 暗角），给 createLook 的 defaults
//   stageParams(p)             整理并校验一份 stage 参数 → { lights, haze }（各最多 4 项，多余的丢，写错的抛 TypeError）；纯函数
//   createStageLight(fx) → { render({ src, depth, camera, p, t }, target), dispose() }   fx：createFullscreen 的返回
//
// stage 参数（每帧参数 p.stage；写 false / null = 关）：
//   lights   [{ pos, color, range, intensity, glow, step1, step2, soft, flicker }]
//     pos [x, y, z] 世界坐标；color 灯色（默认窗灯金 #FFC46B）；range 8 作用距离（世界单位，按 (1 − r/range)² 衰减）
//     intensity 2 受光面提亮倍数（乘在原色上）；glow .25 往原色上加的灯色量（近黑的剪影也吃得到光）
//     step1 .7 / step2 .35 两档阈值（半兰伯特 0..1：过 step1 进亮档，过 step2 是半档）；soft .06 亮档羽化宽度（另有 fwidth 抗锯齿）
//     flicker 0 灯焰抖动幅度（0..1，按 t 的正弦叠加，确定性）
//   haze     [{ y, thick, density, color, start, end, scale, drift, noise, seed }]
//     y 0 / thick 2 高度带的中心与厚度（世界单位，高斯）；density .4 浓度；color 雾色（默认次级灰 #B9B3A6）
//     start 0 / end 60 这层雾所在的视距范围（近于 start 没有，远于 end 淡出；end 给很大就是不分距离的空气透视）
//     scale .15 噪声的世界频率；drift .25 每秒漂移的世界单位；noise .5 噪声调制幅度；seed 1 噪声种子
//   resize(w, h) / dispose()                内部缓冲（体积光、景深）按输出尺寸重新分配；w、h 是输出像素
//
// 体积光（stage.shaft，可选）：场景里标了 userData.stageLight 的那盏投影聚光灯（SpotLight，castShadow）是唯一的光源，
// 沿视线从相机步进到表面，每一步查灯自己的阴影图（three 渲主场景时顺手渲的那张）算遮挡，再乘锥角、距离衰减与该点雾层的浓度，
// 半分辨率累加后加回画面——遮挡物（窗棂、桥板）背后才有光柱，是真正的体积散射，不是径向模糊。
// 景深（stage.dof，可选）：按视距算弥散圆，焦平面两侧各一段过渡；两档预先模糊的图（约 9 px、约 28 px @1080）按弥散圆混合，
// 前景虚得轻、背景虚得重；天空按最远处理。
//
//   stage.shaft   { strength, steps, phase, air, far, bias } 或只写一个数（= strength）
//     strength 1 散射量；steps 16 步数（1..64，降档时减半）；phase 8 前向散射的锐度（越大越像朝灯看时的光柱）；
//     air .15 没有雾层时的均匀空气浓度（有雾层时按雾层积分）；far 80 最远步进到的视距；bias 3e-4 阴影深度偏移
//   stage.dof     { focus, near, far, maxNear, maxFar }（世界单位；maxNear / maxFar 是 1080 高上的像素）
//     focus 10 焦平面（到相机的距离）；near = focus ÷ 2 焦平面往相机方向虚到最大的距离；far 40 往远虚到最大的距离；
//     maxNear 9 前景最大弥散圆；maxFar 28 背景最大弥散圆
// 雾层的公式在 AIR_GLSL 里另抄了一份给步进用（合成通道里那份带着混色，不能直接复用）；改雾的算法时两处一起改。
import * as THREE from 'three';
import { linVec } from './params.js';
import { FOG_GLSL, fogUniforms } from './fog.js';
import { HASH_NOISE } from './glsl.js';
import { renderTarget } from './pass.js';

export const STAGE_BASE = { lights: [], haze: [] };
const MAX = 4;

// 暗场调子：只有 HDR 超过 1 的灯点发光（阈值 1）、暖色辉光量小；黑位压低、中间调压暗、亮部偏暖并压肩；暗角收边
export const DARK_STAGE = {
  bloom: { strength: 0.28, threshold: 1.0, radius: 0.5, knee: 0.15, tint: '#FFC46B' },
  grade: { lift: -0.03, gamma: 0.94, gain: 1.04, saturation: 0.9, shoulder: 0.85, warmth: 0.03 },
  vignette: 0.45,
};

const num = (v, def, name, min = -Infinity) => {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new TypeError(`look：stage.${name} 要是${min === -Infinity ? '有限数' : `不小于 ${min} 的数`}，收到 ${JSON.stringify(v)}`);
  return v;
};
const vec3 = (v, name) => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) throw new TypeError(`look：stage.${name} 要是 [x, y, z]（世界坐标），收到 ${JSON.stringify(v)}`);
  return v;
};

/** 整理 stage 参数：补默认、校验、各截到 4 项。p 为空 = 关（返回空表）。 */
export function stageParams(p) {
  if (!p || typeof p !== 'object') throw new TypeError(`look：stage 要是对象 { lights, haze }，收到 ${JSON.stringify(p)}`);
  const pick = (list, name) => (list === undefined ? [] : Array.isArray(list) ? list : [list]).slice(0, MAX).map(e => {
    const at = `stage.${name}[]`;
    if (!e || typeof e !== 'object') throw new TypeError(`look：${at} 要是对象，收到 ${JSON.stringify(e)}`);
    return e;
  });
  return {
    lights: pick(p.lights, 'lights').map(e => ({
      pos: vec3(e.pos, 'lights.pos'), color: e.color ?? '#FFC46B', range: num(e.range, 8, 'lights.range', 1e-4),
      intensity: num(e.intensity, 2, 'lights.intensity'), glow: num(e.glow, 0.25, 'lights.glow'),
      step1: num(e.step1, 0.7, 'lights.step1'), step2: num(e.step2, 0.35, 'lights.step2'), soft: num(e.soft, 0.06, 'lights.soft', 0),
      flicker: num(e.flicker, 0, 'lights.flicker', 0),
    })),
    haze: pick(p.haze, 'haze').map(e => ({
      y: num(e.y, 0, 'haze.y'), thick: num(e.thick, 2, 'haze.thick', 1e-4), density: num(e.density, 0.4, 'haze.density'), color: e.color ?? '#B9B3A6',
      start: num(e.start, 0, 'haze.start', 0), end: num(e.end, 60, 'haze.end'), scale: num(e.scale, 0.15, 'haze.scale'), drift: num(e.drift, 0.25, 'haze.drift'),
      noise: num(e.noise, 0.5, 'haze.noise', 0), seed: num(e.seed, 1, 'haze.seed', 0),
    })),
    dof: dofParams(p.dof), shaft: shaftParams(p.shaft),
  };
}
const off = v => v === undefined || v === null || v === false;
/** 景深参数：不写 / false = 关；写错的抛 TypeError */
export function dofParams(v) {
  if (off(v)) return null;
  if (typeof v !== 'object') throw new TypeError(`look：stage.dof 要是对象 { focus, near, far, maxNear, maxFar }，收到 ${JSON.stringify(v)}`);
  const focus = num(v.focus, 10, 'dof.focus', 1e-4);
  return { focus, near: num(v.near, focus / 2, 'dof.near', 1e-4), far: num(v.far, 40, 'dof.far', 1e-4), maxNear: num(v.maxNear, 9, 'dof.maxNear', 0), maxFar: num(v.maxFar, 28, 'dof.maxFar', 0) };
}
/** 体积光参数：不写 / false = 关；只写一个数 = 散射量 */
export function shaftParams(v) {
  if (off(v)) return null;
  const o = typeof v === 'number' ? { strength: v } : v;
  if (!o || typeof o !== 'object') throw new TypeError(`look：stage.shaft 要是对象 { strength, steps, … } 或一个数，收到 ${JSON.stringify(v)}`);
  const steps = o.steps === undefined ? 16 : o.steps;
  if (!Number.isInteger(steps) || steps < 1 || steps > 64) throw new TypeError(`look：stage.shaft.steps 要是 1..64 的整数，收到 ${JSON.stringify(o.steps)}`);
  return { strength: num(o.strength, 1, 'shaft.strength'), steps, phase: num(o.phase, 8, 'shaft.phase', 0), air: num(o.air, 0.15, 'shaft.air', 0), far: num(o.far, 80, 'shaft.far', 1e-4), bias: num(o.bias, 3e-4, 'shaft.bias') };
}

const STAGE_FS = /* glsl */`
${FOG_GLSL}
${HASH_NOISE}
uniform sampler2D tColor, tDepth;
uniform float uTime;
uniform vec2 uCount;   // x 灯数, y 雾层数
#define N 4
uniform vec4 uLightA[N];   // xyz 灯的世界坐标, w 作用距离
uniform vec3 uLightB[N];   // 灯色（线性）
uniform vec4 uLightC[N];   // x 提亮倍数, y 加色量, z / w 两档阈值
uniform vec4 uLightD[N];   // x 羽化, y 照亮雾的量
uniform vec4 uHazeA[N];    // x 高度带中心, y 厚度, z 浓度, w 噪声幅度
uniform vec4 uHazeB[N];    // x 起始视距, y 终止视距, z 噪声频率, w 种子
uniform vec3 uHazeC[N];    // 雾色（线性）
uniform vec3 uHazeD[N];    // x 每秒漂移
uniform sampler2D tVol;   // 半分辨率的体积光
uniform float uVolOn;
varying vec2 vUv;

float band(float x, float s1, float s2, float soft){
  float aa = fwidth(x) * 1.2;
  float m1 = smoothstep(s1 - max(soft, aa), s1 + max(soft, aa), x);
  float m2 = smoothstep(s2 - aa, s2 + aa, x);
  return max(m1, .45 * m2);
}
void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  float sky = step(.9999999, d);                      // 清屏处：没有表面，只算雾和空气里的光
  vec3 vp = viewPosAt(vUv, min(d, .9999999));
  vec3 wp = (uCamWorld * vec4(vp, 1.)).xyz;
  float dist = length(vp);
  vec3 dx = dFdx(wp), dy = dFdy(wp);                  // 导数一律在分支之外算
  float jump = (abs(dFdx(dist)) + abs(dFdy(dist))) / max(dist, 1e-3);
  // 雾：每层 = 高度带 × 视距窗 × 漂移的两层值噪声
  float hz = 0.;
  for (int i = 0; i < N; i++) {
    if (float(i) >= uCount.y) break;
    vec4 b = uHazeB[i];
    float a = (1. - exp(-uHazeA[i].z * max(dist - b.x, 0.))) * exp(-.5 * pow((wp.y - uHazeA[i].x) / uHazeA[i].y, 2.));
    float w = .25 * max(b.y - b.x, 1e-3);
    a *= smoothstep(b.x, b.x + w, dist) * (1. - smoothstep(b.y - w, b.y, dist));
    vec2 q = wp.xz * b.z + vec2(uTime * uHazeD[i].x, 0.);
    float n = vnoise(q, uint(b.w)) * .65 + vnoise(q * 2.3 - vec2(uTime * uHazeD[i].x * 1.3, 0.), uint(b.w) + 7u) * .35;
    a *= 1. - uHazeA[i].w + 1.5 * uHazeA[i].w * n;
    a = clamp(a, 0., 1.);
    hz += a;
    col = mix(col, uHazeC[i], a);
  }
  // 局部光：屏幕空间法线（深度重建的世界坐标的偏导），跳变处（物体边缘）不给光
  vec3 nrm = normalize(cross(dx, dy));
  nrm *= 1. - 2. * step(0., dot(nrm, wp - uCamWorld[3].xyz));            // 一律朝向相机
  float surf = (1. - sky) * (1. - step(.05, jump));
  for (int i = 0; i < N; i++) {
    if (float(i) >= uCount.x) break;
    vec3 L = uLightA[i].xyz - wp;
    float r = length(L);
    float fall = pow(clamp(1. - r / uLightA[i].w, 0., 1.), 2.);
    float lit = band(dot(nrm, L / max(r, 1e-4)) * .5 + .5, uLightC[i].z, uLightC[i].w, uLightD[i].x) * surf;
    col = col * (1. + uLightB[i] * (uLightC[i].x * fall * lit)) + uLightB[i] * (fall * (uLightC[i].y * lit + min(hz, 1.) * uLightD[i].y));
  }
  if (uVolOn > .5) col += texture2D(tVol, vUv).rgb;
  gl_FragColor = vec4(col, 1.);
}`;

// 步进用的雾浓度：与上面合成通道里每层雾的式子相同（只是不求混色，只累加浓度）
const AIR_GLSL = /* glsl */`
float airAt(float dist, float y, vec2 xz, float time){
  float a = 0.;
  for (int i = 0; i < N; i++) {
    if (float(i) >= uCount.y) break;
    vec4 b = uHazeB[i];
    float v = (1. - exp(-uHazeA[i].z * max(dist - b.x, 0.))) * exp(-.5 * pow((y - uHazeA[i].x) / uHazeA[i].y, 2.));
    float w = .25 * max(b.y - b.x, 1e-3);
    v *= smoothstep(b.x, b.x + w, dist) * (1. - smoothstep(b.y - w, b.y, dist));
    vec2 q = xz * b.z + vec2(time * uHazeD[i].x, 0.);
    float n = vnoise(q, uint(b.w)) * .65 + vnoise(q * 2.3 - vec2(time * uHazeD[i].x * 1.3, 0.), uint(b.w) + 7u) * .35;
    a += clamp(v * (1. - uHazeA[i].w + 1.5 * uHazeA[i].w * n), 0., 1.);
  }
  return uCount.y < .5 ? uVolD.w : a;
}`;

// 体积光：沿视线步进，每步查灯的阴影图（RGBA 打包深度，与 three 的 unpackRGBAToDepth 同一套系数）
const SHAFT_FS = /* glsl */`
${FOG_GLSL}
${HASH_NOISE}
#define N 4
uniform sampler2D tDepth, tShadow;
uniform mat4 uShadowMat;   // 世界 → 灯的阴影图（uv 与深度都在 0..1）
uniform vec4 uVolA;        // xyz 灯的世界坐标, w 作用距离
uniform vec4 uVolB;        // x 外锥角余弦, y 内锥角余弦, z / w 保留
uniform vec4 uVolC;        // xyz 灯的照射方向, w 最远步进到的视距
uniform vec4 uVolD;        // x 步数, y 散射量, z 前向散射锐度, w 均匀空气浓度
uniform vec3 uVolColor;  // 灯色（线性）
uniform vec4 uHazeA[N];    // 与合成通道共用同一批 uniform 对象
uniform vec4 uHazeB[N];
uniform vec3 uHazeD[N];
uniform vec2 uCount;
uniform float uTime;
varying vec2 vUv;
${AIR_GLSL}
float unpackDepth(const in vec4 v){ return dot(v, vec4(255. / 256., 255. / (256. * 256.), 255. / (256. * 256. * 256.), 1. / (256. * 256. * 256.))); }   // = three 的 unpackRGBAToDepth
void main(){
  float d = texture2D(tDepth, vUv).x;
  vec3 vp = viewPosAt(vUv, min(d, .9999999));
  vec3 wp = (uCamWorld * vec4(vp, 1.)).xyz, cp = vec3(uCamWorld[3].xyz);
  vec3 seg = wp - cp;
  float len = min(length(seg), uVolC.w);
  vec3 dir = seg / max(length(seg), 1e-4);
  float stepLen = len / uVolD.x, jit = h21(ivec2(gl_FragCoord.xy), 11u), sum = 0.;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= uVolD.x) break;
    vec3 q = cp + dir * ((float(i) + jit) * stepLen);
    vec3 L = q - uVolA.xyz;
    float r = length(L);
    float fall = pow(clamp(1. - r / uVolA.w, 0., 1.), 2.) * smoothstep(uVolB.x, uVolB.y, dot(L / max(r, 1e-4), uVolC.xyz));
    if (fall <= 0.) continue;
    vec4 sc = uShadowMat * vec4(q, 1.);
    vec3 suv = sc.xyz / sc.w;
    float vis = (suv.x < 0. || suv.x > 1. || suv.y < 0. || suv.y > 1. || suv.z > 1.) ? 0. : step(suv.z - uVolB.z, unpackDepth(texture2D(tShadow, suv.xy)));
    sum += fall * vis * airAt(length(q - cp), q.y, q.xz, uTime);
  }
  float phase = .35 + .65 * pow(max(dot(dir, normalize(uVolA.xyz - cp)), 0.), uVolD.z);
  gl_FragColor = vec4(uVolColor * (sum * stepLen * uVolD.y * phase), 1.);
}`;

// 可分离高斯（线性取样 5 点）；uDir 是以 1080 画高为基准的横向或纵向 UV 步长
const BLUR_FS = /* glsl */`
uniform sampler2D tSrc; uniform vec2 uDir;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb * .2270270270;
  c += (texture2D(tSrc, vUv + uDir * 1.3846153846).rgb + texture2D(tSrc, vUv - uDir * 1.3846153846).rgb) * .3162162162;
  c += (texture2D(tSrc, vUv + uDir * 3.2307692308).rgb + texture2D(tSrc, vUv - uDir * 3.2307692308).rgb) * .0702702703;
  gl_FragColor = vec4(c, 1.);
}`;

// 景深合成：弥散圆（1080 高上的像素）→ 小虚（约 9 px）/ 大虚（约 28 px）两档混合
const DOF_FS = /* glsl */`
${FOG_GLSL}
uniform sampler2D tColor, tDepth, tSmall, tLarge;
uniform vec3 uDof;   // x 焦平面视距, y 往近虚到最大的距离, z 往远虚到最大的距离
uniform vec2 uDof2;  // 前景 / 背景最大弥散圆
varying vec2 vUv;
void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  float dist = length(viewPosAt(vUv, min(d, .9999999)));
  float c = d >= .9999999 || dist > uDof.x ? clamp((max(dist, uDof.x) - uDof.x) / uDof.z, 0., 1.) * uDof2.y : clamp((uDof.x - dist) / uDof.y, 0., 1.) * uDof2.x;
  col = mix(col, texture2D(tSmall, vUv).rgb, min(c / 9., 1.));
  col = mix(col, texture2D(tLarge, vUv).rgb, smoothstep(9., 28., c));
  gl_FragColor = vec4(col, 1.);
}`;

export function createStageLight(fx) {
  const rep = mk => Array.from({ length: MAX }, mk);
  const hazeU = { uCount: { value: new THREE.Vector2() }, uTime: { value: 0 },
    uHazeA: { value: rep(() => new THREE.Vector4()) }, uHazeB: { value: rep(() => new THREE.Vector4()) },
    uHazeC: { value: rep(() => new THREE.Vector3()) }, uHazeD: { value: rep(() => new THREE.Vector3()) } };
  const u = { ...fogUniforms(), tColor: { value: null }, tDepth: { value: null }, ...hazeU,
    uLightA: { value: rep(() => new THREE.Vector4()) }, uLightB: { value: rep(() => new THREE.Vector3()) }, uLightC: { value: rep(() => new THREE.Vector4()) },
    uLightD: { value: rep(() => new THREE.Vector4()) }, tVol: { value: null }, uVolOn: { value: 0 } };
  const mat = fx.material(STAGE_FS, u);
  // 体积光与景深的着色器各自声明用到的雾层 uniform，但引用同一个 uniform 对象：雾的参数只设一次
  const volU = { ...fogUniforms(), ...hazeU, tDepth: { value: null }, tShadow: { value: null }, uShadowMat: { value: new THREE.Matrix4() },
    uVolA: { value: new THREE.Vector4() }, uVolB: { value: new THREE.Vector4() }, uVolC: { value: new THREE.Vector4() }, uVolD: { value: new THREE.Vector4(16, 1, 8, 0.15) },
    uVolColor: { value: new THREE.Vector3() } };
  const volMat = fx.material(SHAFT_FS, volU), blurMat = fx.material(BLUR_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
  const dofU = { ...fogUniforms(), tColor: { value: null }, tDepth: { value: null }, tSmall: { value: null }, tLarge: { value: null }, uDof: { value: new THREE.Vector3() }, uDof2: { value: new THREE.Vector2() } };
  const dofMat = fx.material(DOF_FS, dofU);
  function blur(src, dir, target, referenceStep) {
    const step = referenceStep * H / 1080;
    blurMat.uniforms.tSrc.value = src;
    blurMat.uniforms.uDir.value.set(dir === 'x' ? step / W : 0, dir === 'y' ? step / H : 0);
    fx.draw(blurMat, target);
  }
  const mats = [mat, volMat, blurMat, dofMat];

  let W = 0, H = 0, T = {};
  function resize(w, h) {
    if (w === W && h === H) return;
    for (const k in T) T[k].dispose();
    W = w; H = h;
    const half = [Math.max(1, w >> 1), Math.max(1, h >> 1)];
    // 在参考画高上建两级景深缓冲，让双线性插值也随画幅缩放；低档沿用较小的缓冲。
    const scale = Math.min(1, 1080 / h);
    const level = divisor => [w, h].map(size => Math.max(1, Math.floor(size * scale / divisor)));
    const small = level(2), large = level(4);
    T = { vol: renderTarget(...half), full: renderTarget(w, h), hA: renderTarget(...small), hB: renderTarget(...small), qA: renderTarget(...large), qB: renderTarget(...large) };
  }

  // 灯焰抖动：两个不成倍数的正弦，只取决于 t 与灯的序号
  const flick = (t, i, amp) => 1 + amp * (Math.sin(t * 13.1 + i * 7.3) * 0.6 + Math.sin(t * 7.7 + i * 3.1) * 0.4);

  // vol：场景里标了 userData.stageLight 的投影聚光灯（engine/look/index.js 从场景里取出来交进来）
  function shaft(vol, depth, camera, p, t) {
    u.tVol.value = T.vol.texture; u.uVolOn.value = 0;
    if (!vol || !vol.map) return;
    const v = volU;
    v.tDepth.value = depth; v.tShadow.value = vol.map; v.uShadowMat.value.copy(vol.matrix);
    v.uProjInv.value.copy(camera.projectionMatrixInverse); v.uCamWorld.value.copy(camera.matrixWorld); v.uTime.value = t;
    v.uVolA.value.set(vol.pos.x, vol.pos.y, vol.pos.z, vol.range);
    v.uVolB.value.set(vol.cosOuter, vol.cosInner, p.bias, 0);
    v.uVolC.value.set(vol.dir.x, vol.dir.y, vol.dir.z, p.far);
    v.uVolD.value.set(p.steps, p.strength, p.phase, p.air);
    linVec(vol.color ?? '#FFC46B', v.uVolColor.value);
    fx.draw(volMat, T.vol);
    u.uVolOn.value = 1;
  }

  function render({ src, depth, camera, p, t = 0, vol = null }, target) {
    const { lights, haze, dof, shaft: sp } = stageParams(p);
    if (!(lights.length || haze.length || dof || (sp && vol))) { u.uVolOn.value = 0; return; }   // 没有可算的：不占通道，调用方继续用 src
    const W0 = target.width || W, H0 = target.height || H;
    resize(W0, H0);
    u.tColor.value = src; u.tDepth.value = depth; u.uTime.value = t;
    u.uProjInv.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCount.value.set(lights.length, haze.length);
    lights.forEach((e, i) => {
      u.uLightA.value[i].set(e.pos[0], e.pos[1], e.pos[2], e.range);
      linVec(e.color, u.uLightB.value[i]);
      u.uLightC.value[i].set(e.intensity * flick(t, i, e.flicker), e.glow, e.step1, e.step2);
      u.uLightD.value[i].set(e.soft, e.glow * 0.8, 0, 0);
    });
    haze.forEach((e, i) => {
      u.uHazeA.value[i].set(e.y, e.thick, e.density, e.noise);
      u.uHazeB.value[i].set(e.start, e.end, e.scale, e.seed);
      linVec(e.color, u.uHazeC.value[i]);
      u.uHazeD.value[i].set(e.drift, 0, 0);
    });
    if (sp && vol) shaft(vol, depth, camera, sp, t); else u.uVolOn.value = 0;
    if (!dof) { fx.draw(mat, target); return; }
    fx.draw(mat, T.full);                                           // 光与雾先合成到整幅缓冲
    blur(T.full.texture, 'x', T.hA, 2); blur(T.hA.texture, 'y', T.hB, 2);   // 半分辨率 → 小虚
    blur(T.hB.texture, 'x', T.qA, 4); blur(T.qA.texture, 'y', T.qB, 4);     // 四分之一 → 大虚
    dofU.tColor.value = T.full.texture; dofU.tDepth.value = depth; dofU.tSmall.value = T.hB.texture; dofU.tLarge.value = T.qB.texture;
    dofU.uProjInv.value.copy(camera.projectionMatrixInverse);
    dofU.uDof.value.set(dof.focus, dof.near, dof.far); dofU.uDof2.value.set(dof.maxNear, dof.maxFar);
    fx.draw(dofMat, target);
  }

  return { render, resize, dispose() { for (const k in T) T[k].dispose(); mats.forEach(m => m.dispose()); } };
}
