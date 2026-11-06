// 北冥引擎 · Generalized Kuwahara 颜料笔触（Papari 2007 的思路，8 扇区；扇区权重自己写：cos⁸ 角向 × 高斯径向）。
// 在 sRGB 空间里做；远处 / 清屏处可以换更大的笔触；输入 alpha 是「保护量」，保护处保留原图（灯点不被抹成星形）。
//
//   createKuwahara(fx) → {
//     render({ src, depth, camera, p, k, w, h }, target)
//       src     sRGB 颜色（alpha = 保护量，见 grade.js）；depth：场景深度纹理（远近换半径用）
//       p       { radius, strength, q, farRadius, farStart, farEnd }
//               radius 笔触半径（像素，标定高度下）  strength 0..1 混合量  q 扇区选择的锐度
//               farRadius 远处半径（默认 = radius）  farStart / farEnd 从多远开始变、多远完全变成 farRadius（世界单位）
//       k       像素缩放（输出高度 / 标定高度）；w × h：输出尺寸
//     dispose()
//   }
// 采样半径是编译期常量（2..10），按需要编译几个变体。正交相机不做远近变化。

import * as THREE from 'three';

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

export function createKuwahara(fx) {
  const mats = new Map();
  const matFor = KR => {
    if (!mats.has(KR)) mats.set(KR, fx.material(KUWA_FS, { tIn: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 4 }, uQ: { value: 8 }, uStrength: { value: 1 },
      uFar: { value: new THREE.Vector4() }, uNear: { value: .1 }, uFarClip: { value: 100 } }, { KR }));
    return mats.get(KR);
  };

  function render({ src, depth, camera, p, k, w, h }, target) {
    const r = p.radius * k, rf = (p.farRadius ?? p.radius) * k, KR = Math.min(10, Math.max(2, Math.ceil(Math.max(r, rf))));
    const km = matFor(KR), u = km.uniforms;
    u.tIn.value = src; u.uTexel.value.set(1 / w, 1 / h); u.uRadius.value = r; u.uQ.value = p.q ?? 8; u.uStrength.value = Math.min(1, p.strength);
    u.tDepth.value = depth; u.uNear.value = camera.near; u.uFarClip.value = camera.far;
    u.uFar.value.set(rf, p.farStart ?? 40, p.farEnd ?? 120, rf !== r && !camera.isOrthographicCamera ? 1 : 0);
    fx.draw(km, target);
  }

  return { render, dispose() { for (const m of mats.values()) m.dispose(); } };
}
