// 北冥引擎 · 调色：曝光 → 加 bloom → 白平衡（warmth）→ 饱和度 → lift/gamma/gain（在 2.2 伽马空间里做）→ 高光肩。
// 线性进、线性出（之后交给 OutputPass 做色调映射 + sRGB）。另把「自发光高光保护」写进 alpha，给 Kuwahara 用。
//
//   createGrade(fx) → {
//     render({ src, bloom, bloomAmount, bloomTint, grade, protect }, target)
//       bloom / bloomAmount / bloomTint   光晕纹理（空 = 无）、强度、染色（'#hex' 等，空 = 白）
//       grade      { exposure, warmth, lift, gamma, gain, saturation, shoulder }；空 = 不调色
//                  lift/gamma/gain 可以是数或 [r,g,b]；shoulder < 1 时超过它的高光按指数肩压缩（大部分保色相）
//       protect    [lo, hi]：线性 HDR 最大通道在此区间的像素渐进记为「保护」；空 = 不保护
//     dispose()
//   }

import * as THREE from 'three';
import { linVec, vec3Of } from './params.js';

const GRADE_FS = /* glsl */`
uniform sampler2D tColor, tBloom;
uniform float uBloom, uExposure, uSat, uKnee;
uniform vec3 uBloomTint, uWB, uLift, uGamma, uGain;
uniform vec2 uProt;   // 自发光高光（HDR 超过 1 的灯点）保护阈值：写进 alpha，Kuwahara 在它附近保留原图，不把小灯点抹成星形
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

const IDENTITY = { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 };

export function createGrade(fx) {
  const mat = fx.material(GRADE_FS, { tColor: { value: null }, tBloom: { value: null }, uBloom: { value: 0 }, uExposure: { value: 1 }, uSat: { value: 1 }, uKnee: { value: 1 },
    uProt: { value: new THREE.Vector2() }, uBloomTint: { value: new THREE.Vector3(1, 1, 1) }, uWB: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) } });
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;

  function render({ src, bloom, bloomAmount, bloomTint, grade, protect }, target) {
    const g = mat.uniforms, G = grade || IDENTITY;
    g.tColor.value = src; g.tBloom.value = bloom || black; g.uBloom.value = bloom ? bloomAmount : 0;
    linVec(bloomTint ?? '#ffffff', g.uBloomTint.value);
    // 白平衡：暖 = 红多蓝少，再按亮度归一，不改整体明暗
    const wm = G.warmth ?? 0, wb = g.uWB.value.set(1 + .10 * wm, 1 + .012 * wm, 1 - .15 * wm);
    wb.divideScalar(wb.x * .2126 + wb.y * .7152 + wb.z * .0722);
    g.uExposure.value = G.exposure ?? 1; g.uSat.value = G.saturation ?? 1; g.uKnee.value = G.shoulder ?? 1;
    vec3Of(G.lift ?? 0, g.uLift.value); vec3Of(G.gamma ?? 1, g.uGamma.value); vec3Of(G.gain ?? 1, g.uGain.value);
    g.uProt.value.set(protect ? protect[0] : 0, protect ? protect[1] : 0);
    fx.draw(mat, target);
  }

  return { render, dispose() { mat.dispose(); black.dispose(); } };
}
