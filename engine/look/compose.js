// 北冥引擎 · 最终合成：叠墨线 → 纸纹 → 暗角 →（颗粒），输出 sRGB 到屏幕或渲染目标。
// 墨线叠在 Kuwahara 之后，不被抹糊；墨色吸收一点底色，底色比墨还暗时线取底色更暗的一档，暗部的线也看得见。
//
//   createCompose(fx) → {
//     render({ src, line, ink, paper, vignette, grain, grainSeed, grainCell, w, h }, target)
//       src       sRGB 颜色
//       line      墨线覆盖率纹理（R 通道）或空 = 不叠线；超采样 2 倍时双线性取样正好是 2×2 盒下采样 → 线自带抗锯齿
//       ink       { color, tint, darken }：墨色、吸收底色的比例、「底色 × darken」作墨色的下限；空 = 沿用上一次
//       paper     paper.js 的 layer() 返回值 { tex, strength, mid, w, h, anchor?, texels? }；带 anchor 时换用"纸纹跟锚点走"的着色器变体
//                 （纸纹点 = (像素 − pos) / zoom + origin，pos / origin 是左上为原点的实际像素）；带 texels（纸纹图的像素数 [宽, 高]，
//                 scaleMode 'refHeight'）时换用面积取样的变体（见下面 paperVariantFs 前的说明）；两样都不带时着色器源码与以前一字不差
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

// 纸纹取样的变体：只换纸纹取样那一行、加几个 uniform（面积取样再加一个函数）。替换没生效就直接报错（改了 FINAL_FS 却忘了这里）。
//   锚点   纸纹点 = (像素 − pos) / zoom + origin（paper.layer 带 anchor 时）
//   面积   按输出像素在纸纹上覆盖的面积取样（paper.layer 带 texels 时，即图片纸纹的 scaleMode 'refHeight'）：
//          纸纹当作逐格常值的图，一个输出像素在纸纹上盖住 [u − hw, u + hw]（纸纹像素单位）。放大时（hw ≤ .5）最多跨两格，
//          两格按面积加权 = 一次双线性取样，取样点放在两格中心之间、按面积比例的位置；整格盖住时正好落在格子中心，取到原值。
//          效果：纸纹按 1080 设计稿的样子等比放大，整数倍画幅（原生 4K）缩回 1080 与 1080 直出逐像素相同（双线性放大会糊掉
//          纸纹两成的高频）；非整数倍（1440）只在跨格的像素上混合相邻两格。缩小（hw > .5）时退回普通的 mip 取样。
//          textureLod 0：放大时不碰 mip（mip 会把相邻格糊进来）。思路同像素画的「锐利双线性」放大，这里是自写的公式
const PAPER_SAMPLE = 'float pp = texture2D(tPaper, gl_FragCoord.xy / uPaperSize).r;';
const PAPER_UNIFORMS = 'uniform vec2 uRes, uPaperSize;';
const PAPER_POINT = 'gl_FragCoord.xy', PAPER_POINT_ANCHOR = '((gl_FragCoord.xy - uPaperPos) / uPaperZoom + uPaperOrigin)';
const PAPER_AREA_FN = `
float paperArea(vec2 u, vec2 hw) {   // u：输出像素中心在纸纹上的位置，hw：像素半宽（都按纸纹像素计）
  if (any(greaterThan(hw, vec2(.5)))) return texture2D(tPaper, u / uPaperTexels).r;   // 缩小：一个像素盖住两格以上，交给 mip
  vec2 b = floor(u + .5), a = clamp((u + hw - b) / (2. * hw), 0., 1.);
  return textureLod(tPaper, (b - .5 + a) / uPaperTexels, 0.).r;
}
void main(){`;
function paperVariantFs({ anchor = false, area = false } = {}, fs = FINAL_FS) {
  if (!fs.includes(PAPER_SAMPLE) || !fs.includes(PAPER_UNIFORMS) || !fs.includes('void main(){')) {
    throw new Error(`compose：FINAL_FS 里找不到纸纹取样那一行，${anchor ? '锚点' : ''}${anchor && area ? '、' : ''}${area ? '面积取样' : ''}变体对不上了`);
  }
  const P = anchor ? PAPER_POINT_ANCHOR : PAPER_POINT;
  const sample = area
    ? `float pp = paperArea(${P} / uPaperSize * uPaperTexels, .5 * uPaperTexels / (uPaperSize${anchor ? ' * uPaperZoom' : ''}));`
    : `float pp = texture2D(tPaper, ${P} / uPaperSize).r;`;
  const uni = `uniform vec2 uRes, uPaperSize${anchor ? ', uPaperPos, uPaperOrigin' : ''}${area ? ', uPaperTexels' : ''};${anchor ? ' uniform float uPaperZoom;' : ''}`;
  const out = fs.replace(PAPER_SAMPLE, sample).replace(PAPER_UNIFORMS, uni);
  return area ? out.replace('void main(){', PAPER_AREA_FN) : out;
}
export function anchoredFinalFs(fs = FINAL_FS) { return paperVariantFs({ anchor: true }, fs); }
export { FINAL_FS };

export function createCompose(fx) {
  const uniforms = () => ({ tColor: { value: null }, tLine: { value: null }, tPaper: { value: null }, uLineOn: { value: 0 }, uInkTint: { value: 0 }, uInkDark: { value: .6 }, uPaper: { value: 0 }, uPaperMid: { value: .5 },
    uVig: { value: 0 }, uGrain: { value: 0 }, uGrainSeed: { value: 0 }, uGrainCell: { value: 1 }, uInk: { value: new THREE.Vector3() }, uRes: { value: new THREE.Vector2() }, uPaperSize: { value: new THREE.Vector2() } });
  const mat = fx.material(FINAL_FS, uniforms());
  const variants = new Map();   // 锚点 / 面积取样的着色器变体，用到时才建；默认着色器源码与以前一字不差
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  function variant(anchor, area) {
    const key = `${anchor ? 'a' : ''}${area ? 'r' : ''}`;
    if (!variants.has(key)) {
      variants.set(key, fx.material(paperVariantFs({ anchor, area }), {
        ...uniforms(),
        ...(anchor ? { uPaperPos: { value: new THREE.Vector2() }, uPaperOrigin: { value: new THREE.Vector2() }, uPaperZoom: { value: 1 } } : {}),
        ...(area ? { uPaperTexels: { value: new THREE.Vector2(1, 1) } } : {}),
      }));
    }
    return variants.get(key);
  }

  function render({ src, line, ink, paper, vignette, grain, grainSeed, grainCell = 1, w, h }, target) {
    const A = paper.anchor, X = paper.texels;
    const m = A || X ? variant(!!A, !!X) : mat, f = m.uniforms;
    if (ink) { srgbVec(ink.color, mat.uniforms.uInk.value); mat.uniforms.uInkTint.value = ink.tint; mat.uniforms.uInkDark.value = ink.darken; }
    if (m !== mat) { f.uInk.value.copy(mat.uniforms.uInk.value); f.uInkTint.value = mat.uniforms.uInkTint.value; f.uInkDark.value = mat.uniforms.uInkDark.value; }   // 墨色"空 = 沿用上一次"各变体共用
    f.tColor.value = src; f.tLine.value = line || black; f.uLineOn.value = line ? 1 : 0;
    f.tPaper.value = paper.tex; f.uPaper.value = paper.strength; f.uPaperMid.value = paper.mid; f.uPaperSize.value.set(paper.w, paper.h);
    if (A) { f.uPaperPos.value.set(A.pos[0], h - A.pos[1]); f.uPaperOrigin.value.set(A.origin[0], h - A.origin[1]); f.uPaperZoom.value = A.zoom; }   // 左上原点 → gl_FragCoord 的左下原点
    if (X) f.uPaperTexels.value.set(X[0], X[1]);
    f.uVig.value = vignette; f.uGrain.value = grain; f.uGrainSeed.value = grainSeed; f.uGrainCell.value = Math.max(1, Math.round(grainCell));
    f.uRes.value.set(w, h);
    fx.draw(m, target);
  }

  return { render, dispose() { mat.dispose(); for (const v of variants.values()) v.dispose(); variants.clear(); black.dispose(); } };
}
