// 北冥引擎 · 最终合成：叠墨线 → 纸纹 → 暗角 →（颗粒），输出 sRGB 到屏幕或渲染目标。
// 墨线叠在 Kuwahara 之后，不被抹糊；墨色吸收一点底色，底色比墨还暗时线取底色更暗的一档，暗部的线也看得见。
//
//   createCompose(fx) → {
//     render({ src, line, ink, paper, vignette, grain, grainSeed, grainCell, w, h }, target)
//       src       sRGB 颜色
//       line      墨线覆盖率纹理（R 通道）或空 = 不叠线；超采样 2 倍时双线性取样正好是 2×2 盒下采样 → 线自带抗锯齿
//       ink       { color, tint, darken }：墨色、吸收底色的比例、「底色 × darken」作墨色的下限；空 = 沿用上一次
//       paper     paper.js 的 layer() 返回值 { tex, strength, mid, w, h }
//       vignette  0..1 暗角强度；grain：0..1 颗粒强度（亮部减半，三角分布）；grainSeed：颗粒种子（整数）
//       grainCell 颗粒格子边长（整数像素，默认 1）：look 按 round(输出高度 / refHeight) 给，原生 4K 为 2，
//                 一粒颗粒占 2×2 像素，缩回 1080 和 1080 直接出图的颗粒一样大、一样强
//       w × h     输出尺寸
//     dispose()
//   }

import * as THREE from 'three';
import { HASH_NOISE } from './glsl.js';
import { srgbVec } from './params.js';

const FINAL_FS = /* glsl */`
${HASH_NOISE}
uniform sampler2D tColor, tLine, tPaper;
uniform float uLineOn, uInkTint, uInkDark, uPaper, uPaperMid, uVig, uGrain, uGrainSeed, uGrainCell;
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
    ivec2 p = ivec2(floor(gl_FragCoord.xy / uGrainCell)); uint sd = uint(uGrainSeed) * 2654435761u;   // 格子 1 时就是逐像素
    float n = h21(p, sd) + h21(p, sd + 77u) - 1.;           // 三角分布
    float l = dot(c, vec3(.2126, .7152, .0722));
    c += n * uGrain * .06 * (1. - .5 * l);
  }
  gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
}`;

export function createCompose(fx) {
  const mat = fx.material(FINAL_FS, { tColor: { value: null }, tLine: { value: null }, tPaper: { value: null }, uLineOn: { value: 0 }, uInkTint: { value: 0 }, uInkDark: { value: .6 }, uPaper: { value: 0 }, uPaperMid: { value: .5 },
    uVig: { value: 0 }, uGrain: { value: 0 }, uGrainSeed: { value: 0 }, uGrainCell: { value: 1 }, uInk: { value: new THREE.Vector3() }, uRes: { value: new THREE.Vector2() }, uPaperSize: { value: new THREE.Vector2() } });
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;

  function render({ src, line, ink, paper, vignette, grain, grainSeed, grainCell = 1, w, h }, target) {
    const f = mat.uniforms;
    f.tColor.value = src; f.tLine.value = line || black; f.uLineOn.value = line ? 1 : 0;
    if (ink) { srgbVec(ink.color, f.uInk.value); f.uInkTint.value = ink.tint; f.uInkDark.value = ink.darken; }
    f.tPaper.value = paper.tex; f.uPaper.value = paper.strength; f.uPaperMid.value = paper.mid; f.uPaperSize.value.set(paper.w, paper.h);
    f.uVig.value = vignette; f.uGrain.value = grain; f.uGrainSeed.value = grainSeed; f.uGrainCell.value = Math.max(1, Math.round(grainCell));
    f.uRes.value.set(w, h);
    fx.draw(mat, target);
  }

  return { render, dispose() { mat.dispose(); black.dispose(); } };
}
