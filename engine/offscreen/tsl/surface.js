// 北冥引擎 · 离屏出片 · 卡通材质的表面层（TSL）：engine/shade/surface.js 的对应，交给 tsl/toon.js 的 toonKind({ layers: [...] })。
//   patchLayer({ rust, core, algaeK }) → 斑块层：植被斑驳 dab、锈斑 rust（可带深色斑心 core）、藻斑 algae、小斑点 spot；参数与默认值同 GLSL 版
//   muralLayer                         → 壁画风化层：褪色大斑、干笔飞白、剥落块、氧化暗斑、细碎点；钩子可读写 c.muralP（风化坐标）、c.muralK（风化倍率）
// 公式逐式照搬。GLSL 版用 if (量 > 0) 跳过整段，这里不分支：量为 0 时各个 mix 本来就不改颜色，结果相同（也避开 WGSL 对导数所在控制流的限制）。
import { patchLayer as glslPatchLayer, muralLayer as glslMuralLayer } from '../../shade/surface.js';
import { glf } from '../../shade/util.glsl.js';

export function patchLayer({ rust = 'color', core = true, algaeK = 1 } = {}) {
  const tint = rust === 'tint';
  return {
    defaults: glslPatchLayer({ rust, core, algaeK }).defaults,
    uniforms(o, { TSL, C, V3 }) {
      const { uniform } = TSL;
      return {
        uPatchScale: uniform(o.patchScale),
        ...(tint ? { uRustTint: uniform(V3(o.rustTint)) } : { uRustColor: uniform(C(o.rustColor)) }),
        uRustAmt: uniform(o.rustAmt), uRustThr: uniform(o.rustThr),
        uAlgaeColor: uniform(C(o.algaeColor)), uAlgaeAmt: uniform(o.algaeAmt), uAlgaeThr: uniform(o.algaeThr),
        uSpotColor: uniform(C(o.spotColor)), uSpotAmt: uniform(o.spotAmt), uSpotThr: uniform(o.spotThr), uSpotScale: uniform(o.spotScale),
        uDabAmt: uniform(o.dabAmt), uDabScale: uniform(o.dabScale),
      };
    },
    surface(c) {
      const { TSL, u, obj, noise: { noise, fbm }, diffuse: d } = c;
      const { vec3, float, max, mix, smoothstep, fwidth } = TSL;
      const aaOf = n => max(fwidth(n), 1e-4).mul(0.8);
      // 植被斑驳
      const Q = obj.mul(u.uDabScale);
      const d1 = noise(Q), d2 = noise(Q.mul(2.3).add(17));
      const a1 = aaOf(d1), a2 = aaOf(d2);
      const q = smoothstep(float(0.12).sub(a1), float(0.12).add(a1), d1).mul(0.55).add(smoothstep(float(0.22).sub(a2), float(0.22).add(a2), d2).mul(0.45));
      d.mulAssign(mix(float(1).sub(u.uDabAmt), u.uDabAmt.mul(0.7).add(1), q));
      // 锈斑、藻斑、小斑点
      const P = obj.mul(u.uPatchScale), P6 = P.mul(0.6);
      const w = vec3(noise(P6.add(1.3)), noise(P6.add(7.1)), noise(P6.add(13.7)));
      const nR = fbm(P.add(w.mul(0.9))), aR = aaOf(nR);
      const rst = smoothstep(u.uRustThr.sub(aR), u.uRustThr.add(aR), nR);
      const cr = smoothstep(u.uRustThr.add(0.17).sub(aR), u.uRustThr.add(0.17).add(aR), nR);
      if (tint) {
        d.mulAssign(mix(vec3(1), u.uRustTint, rst.mul(u.uRustAmt)));
        if (core) d.mulAssign(mix(vec3(1), u.uRustTint.mul(0.86), cr.mul(u.uRustAmt).mul(0.55)));
      } else {
        d.assign(mix(d, u.uRustColor, rst.mul(u.uRustAmt)));
        if (core) d.assign(mix(d, u.uRustColor.mul(vec3(0.55, 0.5, 0.62)), cr.mul(u.uRustAmt).mul(0.75)));
      }
      const nA = fbm(P.mul(1.6).sub(w.mul(0.7)).add(31)), aA = aaOf(nA);
      const alg = smoothstep(u.uAlgaeThr.sub(aA), u.uAlgaeThr.add(aA), nA).mul(float(1).sub(rst));
      d.assign(mix(d, u.uAlgaeColor, alg.mul(u.uAlgaeAmt).mul(float(+glf(algaeK)))));
      const nS = noise(obj.mul(u.uPatchScale).mul(u.uSpotScale).add(w.mul(0.4)).add(57)), aS = aaOf(nS);
      const spot = smoothstep(u.uSpotThr.sub(aS), u.uSpotThr.add(aS), nS);
      d.assign(mix(d, u.uSpotColor, spot.mul(u.uSpotAmt)));
    },
  };
}

export const muralLayer = {
  defaults: glslMuralLayer.defaults,
  uniforms(o, { TSL, C, V3 }) {
    const { uniform } = TSL;
    return {
      uMuralAmt: uniform(o.muralAmt), uMuralScale: uniform(o.muralScale),
      uMuralGround: uniform(C(o.muralGround)), uStainTint: uniform(V3(o.stainTint)),
      uFleckThr: uniform(o.fleckThr), uFleckAmt: uniform(o.fleckAmt), uFleckFreq: uniform(o.fleckFreq),
      uChipThr: uniform(o.chipThr), uChipAmt: uniform(o.chipAmt),
      uFadeAmt: uniform(o.fadeAmt), uStainAmt: uniform(o.stainAmt), uDotAmt: uniform(o.dotAmt),
    };
  },
  init(c) {
    c.muralP = c.obj.toVar();
    c.muralK = c.TSL.float(1).toVar();
  },
  post(c) {
    const { TSL, u, noise: { noise, fbm }, diffuse: d } = c;
    const { vec3, float, max, mix, smoothstep, fwidth, length } = TSL;
    const Pm = c.muralP.mul(u.uMuralScale);
    const amt = u.uMuralAmt.mul(max(c.muralK, 0));
    // 1) 褪色大斑：颜料层变薄，向地仗色靠（软边，分两档）
    const fn = fbm(Pm.mul(0.45).add(vec3(3.1, 7.7, 1.3)));
    const fa = max(fwidth(fn), 1e-4);
    const fade = smoothstep(float(0.02).sub(fa), float(0.02).add(fa), fn).mul(0.55)
      .add(smoothstep(float(0.22).sub(fa), float(0.22).add(fa), fn).mul(0.45));
    d.assign(mix(d, mix(d, u.uMuralGround, 0.55), fade.mul(u.uFadeAmt).mul(amt)));
    // 2) 干笔飞白：细碎小白点（高频两层，硬边，远景淡出）
    const Q = Pm.mul(u.uFleckFreq).add(vec3(11, -4, 2));
    const fl = noise(Q).mul(0.75).add(noise(Q.mul(2.6).add(5)).mul(0.45));
    const afl = max(fwidth(fl), 1e-4);
    const farK = float(1).sub(smoothstep(0.3, 0.75, length(fwidth(Q))));
    const flake = smoothstep(u.uFleckThr.sub(afl), u.uFleckThr.add(afl), fl).mul(farK);
    // 2b) 剥落块：偶尔一块大些的，露出地仗
    const Q2 = Pm.mul(1.5).add(vec3(-7, 13, 5));
    const ch = fbm(Q2).add(noise(Q2.mul(4)).mul(0.25));
    const ach = max(fwidth(ch), 1e-4);
    const chip = smoothstep(u.uChipThr.sub(ach), u.uChipThr.add(ach), ch);
    d.assign(mix(d, u.uMuralGround, max(flake.mul(u.uFleckAmt), chip.mul(u.uChipAmt)).mul(amt)));
    // 3) 氧化暗斑
    const sn = fbm(Pm.mul(0.8).add(vec3(21, 3, 9)));
    const sa = max(fwidth(sn), 1e-4);
    const stain = smoothstep(float(0.3).sub(sa), float(0.3).add(sa), sn).mul(float(1).sub(flake)).mul(float(1).sub(chip));
    d.assign(mix(d, d.mul(u.uStainTint), stain.mul(u.uStainAmt).mul(amt)));
    // 4) 细碎点：深浅两种
    const D = Pm.mul(u.uFleckFreq).mul(1.9).add(vec3(57));
    const dn = noise(D), da = max(fwidth(dn), 1e-4);
    const farD = float(1).sub(smoothstep(0.3, 0.7, length(fwidth(D))));
    const dk = smoothstep(float(0.62).sub(da), float(0.62).add(da), dn).mul(farD);
    const dl = smoothstep(float(0.62).sub(da), float(0.62).add(da), dn.negate()).mul(farD);
    d.assign(mix(d, d.mul(vec3(0.55, 0.5, 0.6)), dk.mul(u.uDotAmt).mul(amt)));
    d.assign(mix(d, u.uMuralGround, dl.mul(u.uDotAmt).mul(0.6).mul(amt)));
  },
};
