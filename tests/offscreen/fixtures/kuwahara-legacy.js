// 优化前的 TSL Kuwahara 原样副本（engine/offscreen/tsl/kuwahara.js @ 优化前），只作逐像素对照的基准，不要改：
// 每个像素在着色器里对 (2KR+1)² 个格子重算 exp / cos⁸ / inversesqrt，8 个扇区全部累加，圆外格子照常采样后权重乘 0。
export function kuwaharaLegacy(TSL, { input, KR, radius, q, strength, texel, far }) {
  if (!Number.isInteger(KR) || KR < 2 || KR > 10) throw new RangeError(`Kuwahara 的 KR 要是 2..10 的整数，收到 ${KR}`);
  const { Fn, Loop, float, int, vec2, vec3, vec4, uv, dot, exp, max, mix, pow, select, step, inversesqrt, smoothstep, perspectiveDepthToViewZ } = TSL;
  return Fn(() => {
    const coord = uv();
    const c0 = input.sample(coord).level(0).toVar();
    const M = Array.from({ length: 8 }, () => vec3(0).toVar());
    const S = Array.from({ length: 8 }, () => vec3(0).toVar());
    const WA = vec4(0).toVar(), WB = vec4(0).toVar();
    const prot = float(0).toVar();
    let rad = radius;
    if (far) {   // 底板（远处、清屏处）用更大的笔触，3D 主体保持小笔触
      const d = far.depth.sample(coord).level(0).x;
      const z = select(d.greaterThanEqual(0.9999999), float(1e9), perspectiveDepthToViewZ(d, far.near, far.farClip).negate());
      rad = mix(radius, far.radius, smoothstep(far.start, far.end, z)).toVar();
    }
    const stp = rad.div(KR);
    Loop({ start: int(-KR), end: int(KR), type: 'int', condition: '<=', name: 'j' }, { start: int(-KR), end: int(KR), type: 'int', condition: '<=', name: 'i' }, ({ i, j }) => {
      const v = vec2(float(i), float(j)).div(KR);
      const r2 = dot(v, v);
      const inside = step(r2, 1.0001);   // 圆外的格子（GLSL 里是 continue）：照常采样，权重乘 0
      const cs = input.sample(coord.add(vec2(float(i), float(j)).mul(stp).mul(texel))).level(0);
      const c = cs.rgb, c2 = c.mul(c);
      const g = exp(r2.mul(-2));
      prot.assign(max(prot, inside.mul(cs.a).mul(float(1).sub(r2.mul(0.6)))));
      const n = v.mul(inversesqrt(max(r2, 1e-8)));
      const pr = vec4(n.x, n.x.add(n.y).mul(0.70710678), n.y, n.y.sub(n.x).mul(0.70710678));   // 0°/45°/90°/135° 四根轴
      const pow8 = p => { const a = max(p, 0), a2 = a.mul(a), a4 = a2.mul(a2); return a4.mul(a4); };   // cos⁸：相邻扇区在 ±22.5° 处各占一半
      const center = i.equal(0).and(j.equal(0));
      const wc = vec4(g.mul(0.125));
      const wa = select(center, wc, pow8(pr).mul(g)).mul(inside);
      const wb = select(center, wc, pow8(pr.negate()).mul(g)).mul(inside);
      WA.addAssign(wa); WB.addAssign(wb);
      for (let k = 0; k < 8; k++) {
        const w = k < 4 ? [wa.x, wa.y, wa.z, wa.w][k] : [wb.x, wb.y, wb.z, wb.w][k - 4];
        M[k].addAssign(w.mul(c)); S[k].addAssign(w.mul(c2));
      }
    });
    const acc = vec3(0).toVar(), as = float(0).toVar();
    for (let k = 0; k < 8; k++) {
      const W = k < 4 ? [WA.x, WA.y, WA.z, WA.w][k] : [WB.x, WB.y, WB.z, WB.w][k - 4];
      const m = M[k].div(W);
      const v = max(S[k].div(W).sub(m.mul(m)), 0);
      const s2 = v.x.add(v.y).add(v.z).mul(65025);   // 方差按 0..255 计，和论文的尺度一致
      const a = float(1).div(float(1).add(pow(s2, q.mul(0.5))));
      acc.addAssign(a.mul(m)); as.addAssign(a);
    }
    return vec4(mix(c0.rgb, acc.div(as), strength.mul(float(1).sub(prot))), 1);
  })();
}
