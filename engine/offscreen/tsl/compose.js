// 北冥引擎 · 离屏出片 · 最终合成（TSL）：engine/look/compose.js 的对应——叠墨线 → 纸纹（支持 anchor 跟移与 refHeight 面积取样）→ 暗角 → 颗粒，输出 sRGB 数值。
// 墨线叠在 Kuwahara 之后，不被抹糊；墨色吸收一点底色，底色比墨还暗时线取底色更暗的一档，暗部的线也看得见。
//
//   createCompose({ THREE, TSL }, { width, height, mid }) → {
//     node      vec4 节点（rgb 是 sRGB 数值，a = 1）
//     update({ src, line, ink, paper, vignette, grain, grainSeed, grainCell })   每帧填参数
//     dispose()
//   }
import { noise } from './noise.js';
import { glCoord } from './pass.js';
import { srgbVec } from './color.js';

export function createCompose({ THREE, TSL }, { width: W, height: H, mid }) {
  const { Fn, uniform, texture, vec2, vec3, vec4, ivec2, uint, float, dot, min, mix, clamp, length, floor, smoothstep, select, screenCoordinate } = TSL;
  const { h21 } = noise(TSL);
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  const tColor = texture(black), tLine = texture(black), tPaper = texture(black);
  const U = {
    lineOn: uniform(0), inkTint: uniform(0), inkDark: uniform(0.6), ink: uniform(new THREE.Vector3()),
    paper: uniform(0), paperSize: uniform(new THREE.Vector2(1, 1)), paperMid: uniform(0.5), useProcMid: uniform(1),
    anchorOn: uniform(0), paperPos: uniform(new THREE.Vector2()), paperOrigin: uniform(new THREE.Vector2()), paperZoom: uniform(1),
    areaOn: uniform(0), paperTexels: uniform(new THREE.Vector2(1, 1)),
    vig: uniform(0), grain: uniform(0), grainSeed: uniform(0), grainCell: uniform(1),
  };

  const samplePaper = uvGL => tPaper.sample(vec2(uvGL.x, float(1).sub(uvGL.y)));
  const paperArea = Fn(([u, hw]) => {
    const shrink = hw.x.greaterThan(0.5).or(hw.y.greaterThan(0.5));
    const b = floor(u.add(0.5));
    const a = clamp(u.add(hw).sub(b).div(hw.mul(2)), 0, 1);
    const uvSharp = b.sub(0.5).add(a).div(U.paperTexels);
    const sMip = samplePaper(u.div(U.paperTexels)).r;
    const sLod0 = samplePaper(uvSharp).level(0).r;
    return select(shrink, sMip, sLod0);
  });

  const uvT = screenCoordinate.xy.div(vec2(W, H));
  let c = tColor.load(ivec2(screenCoordinate.xy)).rgb;
  const cov = tLine.sample(uvT).r;
  let ink = min(U.ink, c.mul(U.inkDark));
  ink = mix(ink, ink.mul(c.mul(0.9).add(0.55)), U.inkTint);
  c = select(U.lineOn.greaterThan(0.5), mix(c, ink, cov), c);

  const pGL = glCoord(TSL, H);
  const pPaper = select(U.anchorOn.greaterThan(0.5), pGL.sub(U.paperPos).div(U.paperZoom).add(U.paperOrigin), pGL);
  const pUv = pPaper.div(U.paperSize);
  const zoomDenom = select(U.anchorOn.greaterThan(0.5), U.paperSize.mul(U.paperZoom), U.paperSize);
  const hw = U.paperTexels.mul(0.5).div(zoomDenom);
  const pp = select(U.areaOn.greaterThan(0.5), paperArea(pUv.mul(U.paperTexels), hw), samplePaper(pUv).r);
  const effMid = select(U.useProcMid.greaterThan(0.5), mid, U.paperMid);
  c = c.mul(float(1).add(U.paper.mul(2).mul(pp.sub(effMid))));

  const a = vec2(W / H, 1);
  const r = length(uvT.sub(0.5).mul(a)).div(length(a.mul(0.5)));
  c = c.mul(float(1).sub(U.vig.mul(smoothstep(0.32, 1.05, r))));
  const gp = ivec2(floor(pGL.div(U.grainCell))), sd = uint(U.grainSeed).mul(uint(2654435761));
  const n = h21(gp, sd).add(h21(gp, sd.add(uint(77)))).sub(1);
  const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = c.add(n.mul(U.grain).mul(0.06).mul(float(1).sub(l.mul(0.5))));
  const node = vec4(clamp(c, 0, 1), 1);

  function update({ src, line, ink: I, paper, vignette, grain, grainSeed, grainCell = 1 }) {
    if (I) { srgbVec(THREE, I.color, U.ink.value); U.inkTint.value = I.tint; U.inkDark.value = I.darken; }
    tColor.value = src; tLine.value = line || black; U.lineOn.value = line ? 1 : 0;
    tPaper.value = paper.texture; U.paper.value = paper.strength; U.paperSize.value.set(paper.w, paper.h);
    if (paper.mid === null || paper.mid === undefined) U.useProcMid.value = 1;
    else { U.useProcMid.value = 0; U.paperMid.value = paper.mid; }
    const A = paper.anchor, X = paper.texels;
    if (A) { U.anchorOn.value = 1; U.paperPos.value.set(A.pos[0], H - A.pos[1]); U.paperOrigin.value.set(A.origin[0], H - A.origin[1]); U.paperZoom.value = A.zoom; }
    else U.anchorOn.value = 0;
    if (X) { U.areaOn.value = 1; U.paperTexels.value.set(X[0], X[1]); }
    else U.areaOn.value = 0;
    U.vig.value = vignette; U.grain.value = grain; U.grainSeed.value = grainSeed; U.grainCell.value = Math.max(1, Math.round(grainCell));
  }
  return { node, update, dispose() { black.dispose(); } };
}
