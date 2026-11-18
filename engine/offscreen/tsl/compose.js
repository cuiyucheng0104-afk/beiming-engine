// 北冥引擎 · 离屏出片 · 最终合成（TSL）：engine/look/compose.js 的对应——叠墨线 → 纸纹 → 暗角 →（颗粒），输出 sRGB 数值。
// 墨线叠在 Kuwahara 之后，不被抹糊；墨色吸收一点底色，底色比墨还暗时线取底色更暗的一档，暗部的线也看得见。
//
//   createCompose({ THREE, TSL }, { width, height }) → {
//     node      vec4 节点（rgb 是 sRGB 数值，a = 1）：交给宿主的 pipeline 去画；宿主的目标是 sRGB 的，要在外面先过 sRGBTransferEOTF（look.js 的 output 就是这样）
//     update({ src, line, ink, paper, vignette, grain, grainSeed, grainCell })   每帧填参数；src / line / paper.texture 是 RenderTarget 或 DataTexture 的 texture
//       src 与输出同尺寸；line 空 = 不叠线（墨线缓冲可以是输出的 ss 倍，双线性取样正好是 2×2 盒下采样 → 线自带抗锯齿）；ink { color, tint, darken } 空 = 沿用上一次
//       paper：{ texture, strength, w, h }（paper.js 的 layer()）；mid 在构造时给（节点或数）
//     dispose()
//   }
// 与 GLSL 版同一套公式。坐标：纸纹与颗粒按 gl_FragCoord（左下角原点）取值，这里翻回 GL 约定；纸纹纹理的行序是自上而下，取样时 v 翻成 1 - v。
import { noise } from './noise.js';
import { glCoord } from './pass.js';
import { srgbVec } from './color.js';

export function createCompose({ THREE, TSL }, { width: W, height: H, mid }) {
  const { uniform, texture, vec2, vec3, vec4, ivec2, uint, float, dot, min, mix, clamp, length, floor, smoothstep, select, screenCoordinate } = TSL;
  const { h21 } = noise(TSL);
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  const tColor = texture(black), tLine = texture(black), tPaper = texture(black);
  const U = {
    lineOn: uniform(0), inkTint: uniform(0), inkDark: uniform(0.6), ink: uniform(new THREE.Vector3()), paper: uniform(0), paperSize: uniform(new THREE.Vector2(1, 1)),
    vig: uniform(0), grain: uniform(0), grainSeed: uniform(0), grainCell: uniform(1),
  };

  const uvT = screenCoordinate.xy.div(vec2(W, H));                        // 像素中心的 [0,1] 坐标，左上角原点
  let c = tColor.load(ivec2(screenCoordinate.xy)).rgb;
  const cov = tLine.sample(uvT).r;
  let ink = min(U.ink, c.mul(U.inkDark));                                  // 底色比墨还暗时，线取底色的更暗一档，保证看得见
  ink = mix(ink, ink.mul(c.mul(0.9).add(0.55)), U.inkTint);
  c = select(U.lineOn.greaterThan(0.5), mix(c, ink, cov), c);
  const pGL = glCoord(TSL, H), pUv = pGL.div(U.paperSize);
  const pp = tPaper.sample(vec2(pUv.x, float(1).sub(pUv.y))).r;
  c = c.mul(float(1).add(U.paper.mul(2).mul(pp.sub(mid))));
  const a = vec2(W / H, 1);
  const r = length(uvT.sub(0.5).mul(a)).div(length(a.mul(0.5)));
  c = c.mul(float(1).sub(U.vig.mul(smoothstep(0.32, 1.05, r))));
  const gp = ivec2(floor(pGL.div(U.grainCell))), sd = uint(U.grainSeed).mul(uint(2654435761));   // 格子 1 时就是逐像素
  const n = h21(gp, sd).add(h21(gp, sd.add(uint(77)))).sub(1);              // 三角分布
  const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = c.add(n.mul(U.grain).mul(0.06).mul(float(1).sub(l.mul(0.5))));
  const node = vec4(clamp(c, 0, 1), 1);

  function update({ src, line, ink: I, paper, vignette, grain, grainSeed, grainCell = 1 }) {
    if (I) { srgbVec(THREE, I.color, U.ink.value); U.inkTint.value = I.tint; U.inkDark.value = I.darken; }
    tColor.value = src; tLine.value = line || black; U.lineOn.value = line ? 1 : 0;
    tPaper.value = paper.texture; U.paper.value = paper.strength; U.paperSize.value.set(paper.w, paper.h);
    U.vig.value = vignette; U.grain.value = grain; U.grainSeed.value = grainSeed; U.grainCell.value = Math.max(1, Math.round(grainCell));
  }
  return { node, update, dispose() { black.dispose(); } };
}
