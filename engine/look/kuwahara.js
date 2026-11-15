// 北冥引擎 · Generalized / Anisotropic Kuwahara 颜料笔触：
//   - 默认（anisotropy 缺省或 0）：各向同性 Generalized Kuwahara（Papari 2007 思路，8 扇区 cos⁸ 角向 × 高斯径向），与既有金标准逐像素一致；
//   - 开启各向异性（anisotropy > 0）：先算局部结构张量（Structure Tensor）与高斯平滑场，求边缘切向主方向 φ 与相干度 A，
//     再把 8 扇区采样核沿切向拉伸 (1 + A·anisotropy)、沿法向压缩 1/(1 + A·anisotropy)（Kyprianidis et al. 2009 思路，参考开源项目
//     stylized-components，本模块为纯自研实现），使颜料笔触顺着山石棱线与衣袂轮廓流淌而不糊边。
// 在 sRGB 空间里做；远处 / 清屏处可以换更大的笔触；输入 alpha 是「保护量」，保护处保留原图（灯点不被抹成星形）。
//
//   createKuwahara(fx) → {
//     render({ src, depth, camera, p, k, w, h }, target)
//       src     sRGB 颜色（alpha = 保护量，见 grade.js）；depth：场景深度纹理（远近换半径用）
//       p       { radius, strength, q, farRadius, farStart, farEnd, anisotropy, tensorSigma }
//               radius 笔触半径（像素，标定高度下）  strength 0..1 混合量  q 扇区选择的锐度
//               farRadius 远处半径（默认 = radius）  farStart / farEnd 从多远开始变、多远完全变成 farRadius（世界单位）
//               anisotropy 各向异性拉伸强度（默认 0 走原单 pass；建议 0.6..1.5）  tensorSigma 结构张量平滑半径（默认 1.5，标定高度下）
//       k       像素缩放（输出高度 / 标定高度）；w × h：输出尺寸
//     dispose()
//   }
// 采样半径是编译期常量（2..10），按需要编译几个变体。正交相机不做远近变化。

import * as THREE from 'three';
import { renderTarget } from './pass.js';

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

// 结构张量第 1 步：旋转对称 Scharr 算子求三通道颜色梯度内积 (E = gx·gx, F = gx·gy, G = gy·gy)
const TENSOR_FS = /* glsl */`
uniform sampler2D tIn;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c00 = texture2D(tIn, vUv + vec2(-1., -1.) * uTexel).rgb;
  vec3 c10 = texture2D(tIn, vUv + vec2( 0., -1.) * uTexel).rgb;
  vec3 c20 = texture2D(tIn, vUv + vec2( 1., -1.) * uTexel).rgb;
  vec3 c01 = texture2D(tIn, vUv + vec2(-1.,  0.) * uTexel).rgb;
  vec3 c21 = texture2D(tIn, vUv + vec2( 1.,  0.) * uTexel).rgb;
  vec3 c02 = texture2D(tIn, vUv + vec2(-1.,  1.) * uTexel).rgb;
  vec3 c12 = texture2D(tIn, vUv + vec2( 0.,  1.) * uTexel).rgb;
  vec3 c22 = texture2D(tIn, vUv + vec2( 1.,  1.) * uTexel).rgb;
  vec3 gx = (3. * (c20 - c00) + 10. * (c21 - c01) + 3. * (c22 - c02)) / 16.;
  vec3 gy = (3. * (c02 - c00) + 10. * (c12 - c10) + 3. * (c22 - c20)) / 16.;
  gl_FragColor = vec4(dot(gx, gx), dot(gx, gy), dot(gy, gy), 1.);
}`;

// 结构张量第 2 步：高斯平滑 + 解析特征分解 → (cosφ, sinφ, 相干度 A, 1)，其中 φ 为沿边缘切向的主方向
const TENSOR_FLOW_FS = /* glsl */`
uniform sampler2D tTensor;
uniform vec2 uTexel;
uniform float uSigma;
varying vec2 vUv;
void main() {
  float sig = max(0.35, uSigma);
  float inv2s2 = 0.5 / (sig * sig);
  vec3 sum = vec3(0.);
  float wsum = 0.;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 o = vec2(float(i), float(j));
      float w = exp(-dot(o, o) * inv2s2);
      sum += w * texture2D(tTensor, vUv + o * max(1., sig * 0.65) * uTexel).rgb;
      wsum += w;
    }
  }
  vec3 T = sum / wsum;
  float E = T.x, F = T.y, G = T.z;
  float tr = E + G;
  float disc = sqrt(max(0., (E - G) * (E - G) + 4. * F * F));
  // 梯度角 θg = 0.5 * atan(2F, E - G)，边缘切向 φ = θg + π/2 → (cosφ, sinφ) = (-sinθg, cosθg)
  float thetaG = 0.5 * atan(2. * F, E - G);
  vec2 tangent = vec2(-sin(thetaG), cos(thetaG));
  float aniso = tr > 1e-6 ? clamp(disc / (tr + 1e-6), 0., 1.) : 0.;
  gl_FragColor = vec4(tangent, aniso, 1.);
}`;

// 各向异性 Kuwahara 主滤波：在切向椭圆核内执行 8 扇区最小方差混合
const ANISO_KUWA_FS = /* glsl */`
#include <packing>
uniform sampler2D tIn, tDepth, tFlow;
uniform vec2 uTexel;
uniform float uRadius, uQ, uStrength, uAniso;
uniform vec4 uFar;
uniform float uNear, uFarClip;
varying vec2 vUv;
#define ACC(k, w) M[k] += (w) * c; S[k] += (w) * c2;
void main() {
  vec3 c0 = texture2D(tIn, vUv).rgb;
  vec3 flow = texture2D(tFlow, vUv).rgb;
  vec2 tDir = flow.xy;
  float tLen = length(tDir);
  tDir = tLen > 1e-4 ? tDir / tLen : vec2(1., 0.);
  vec2 nDir = vec2(-tDir.y, tDir.x);
  float stretch = 1. + flow.z * uAniso;

  vec3 M[8], S[8];
  for (int k = 0; k < 8; k++) { M[k] = vec3(0.); S[k] = vec3(0.); }
  vec4 WA = vec4(0.), WB = vec4(0.);
  float rad = uRadius, prot = 0.;
  if (uFar.w > .5) {
    float d = texture2D(tDepth, vUv).x;
    float z = d >= .9999999 ? 1e9 : -perspectiveDepthToViewZ(d, uNear, uFarClip);
    rad = mix(uRadius, uFar.x, smoothstep(uFar.y, uFar.z, z));
  }
  float semiMajor = rad * stretch;
  float semiMinor = rad / stretch;
  for (int j = -KR; j <= KR; j++) {
    for (int i = -KR; i <= KR; i++) {
      vec2 v = vec2(float(i), float(j)) / float(KR);
      float r2 = dot(v, v);
      if (r2 > 1.0001) continue;
      vec2 pxOff = tDir * (v.x * semiMajor) + nDir * (v.y * semiMinor);
      vec4 cs = texture2D(tIn, vUv + pxOff * uTexel);
      vec3 c = cs.rgb, c2 = c * c;
      float g = exp(-2. * r2);
      prot = max(prot, cs.a * (1. - .6 * r2));
      vec4 wa, wb;
      if (i == 0 && j == 0) { wa = vec4(g * .125); wb = wa; }
      else {
        vec2 n = v * inversesqrt(r2);
        vec4 pr = vec4(n.x, (n.x + n.y) * .70710678, n.y, (n.y - n.x) * .70710678);
        wa = max(pr, 0.); wb = max(-pr, 0.);
        wa *= wa; wa *= wa; wa *= wa; wb *= wb; wb *= wb; wb *= wb;
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
    float s2 = (v.r + v.g + v.b) * 65025.;
    float a = 1. / (1. + pow(s2, uQ * .5));
    acc += a * m; as += a;
  }
  gl_FragColor = vec4(mix(c0, acc / as, uStrength * (1. - prot)), 1.);
}`;

export function createKuwahara(fx) {
  const mats = new Map();
  const anisoMats = new Map();
  let tensorMat = null, flowMat = null, rtTensor = null, rtFlow = null, tw = 0, th = 0;

  const matFor = KR => {
    if (!mats.has(KR)) {
      mats.set(KR, fx.material(KUWA_FS, {
        tIn: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 4 }, uQ: { value: 8 }, uStrength: { value: 1 },
        uFar: { value: new THREE.Vector4() }, uNear: { value: .1 }, uFarClip: { value: 100 },
      }, { KR }));
    }
    return mats.get(KR);
  };

  const anisoMatFor = KR => {
    if (!anisoMats.has(KR)) {
      anisoMats.set(KR, fx.material(ANISO_KUWA_FS, {
        tIn: { value: null }, tDepth: { value: null }, tFlow: { value: null },
        uTexel: { value: new THREE.Vector2() }, uRadius: { value: 4 }, uQ: { value: 8 },
        uStrength: { value: 1 }, uAniso: { value: 1 }, uFar: { value: new THREE.Vector4() },
        uNear: { value: .1 }, uFarClip: { value: 100 },
      }, { KR }));
    }
    return anisoMats.get(KR);
  };

  function ensureAnisoTargets(w, h) {
    tensorMat ??= fx.material(TENSOR_FS, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() } });
    flowMat ??= fx.material(TENSOR_FLOW_FS, { tTensor: { value: null }, uTexel: { value: new THREE.Vector2() }, uSigma: { value: 1.5 } });
    if (!rtTensor || tw !== w || th !== h) {
      rtTensor?.dispose();
      rtFlow?.dispose();
      rtTensor = renderTarget(w, h);
      rtFlow = renderTarget(w, h);
      tw = w;
      th = h;
    }
  }

  function render({ src, depth, camera, p, k, w, h }, target) {
    const r = p.radius * k, rf = (p.farRadius ?? p.radius) * k;
    const aniso = p.anisotropy ?? 0;
    if (!(aniso > 0)) {
      const KR = Math.min(10, Math.max(2, Math.ceil(Math.max(r, rf))));
      const km = matFor(KR), u = km.uniforms;
      u.tIn.value = src; u.uTexel.value.set(1 / w, 1 / h); u.uRadius.value = r; u.uQ.value = p.q ?? 8; u.uStrength.value = Math.min(1, p.strength);
      u.tDepth.value = depth; u.uNear.value = camera.near; u.uFarClip.value = camera.far;
      u.uFar.value.set(rf, p.farStart ?? 40, p.farEnd ?? 120, rf !== r && !camera.isOrthographicCamera ? 1 : 0);
      fx.draw(km, target);
      return;
    }

    ensureAnisoTargets(w, h);
    tensorMat.uniforms.tIn.value = src;
    tensorMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    fx.draw(tensorMat, rtTensor);

    flowMat.uniforms.tTensor.value = rtTensor.texture;
    flowMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    flowMat.uniforms.uSigma.value = (p.tensorSigma ?? 1.5) * k;
    fx.draw(flowMat, rtFlow);

    const maxStretch = 1 + Math.min(2.5, aniso);
    const KR = Math.min(12, Math.max(2, Math.ceil(Math.max(r, rf) * Math.min(1.6, maxStretch))));
    const am = anisoMatFor(KR), u = am.uniforms;
    u.tIn.value = src;
    u.tFlow.value = rtFlow.texture;
    u.uTexel.value.set(1 / w, 1 / h);
    u.uRadius.value = r;
    u.uQ.value = p.q ?? 8;
    u.uStrength.value = Math.min(1, p.strength);
    u.uAniso.value = aniso;
    u.tDepth.value = depth;
    u.uNear.value = camera.near;
    u.uFarClip.value = camera.far;
    u.uFar.value.set(rf, p.farStart ?? 40, p.farEnd ?? 120, rf !== r && !camera.isOrthographicCamera ? 1 : 0);
    fx.draw(am, target);
  }

  return {
    render,
    dispose() {
      for (const m of mats.values()) m.dispose();
      for (const m of anisoMats.values()) m.dispose();
      tensorMat?.dispose();
      flowMat?.dispose();
      rtTensor?.dispose();
      rtFlow?.dispose();
      rtTensor = rtFlow = null;
    },
  };
}
