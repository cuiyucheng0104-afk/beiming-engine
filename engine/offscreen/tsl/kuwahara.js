// 北冥引擎 · 离屏出片 · Kuwahara 颜料笔触的 TSL 版：engine/look/kuwahara.js 的 GLSL（Papari 2007 的思路，8 扇区；
// 扇区权重 cos⁸ 角向 × 高斯径向）在 WebGPU 里的对应，算法与常数逐项照搬，作品在 Node + Dawn 与 Chrome WebGPU 里用同一份。
// 在 sRGB 数值空间里做（输入是 sRGB 编码的数值，不是线性光）；输入 alpha 是「保护量」，保护处保留原图（灯点不被抹成星形）。
//
//   kuwahara(TSL, { input, KR, radius, q, strength, texel, far }) → vec4 节点（rgb 笔触结果，a = 1）
//     input     texture 节点（支持 .sample(uv)）
//     KR        采样半径格数，编译期常量，整数 2..10（与 GLSL 版相同）；每个 KR 是一个独立的着色器变体
//     radius    笔触半径（像素，已按画幅缩放）的 uniform 节点；采样步长 = radius / KR
//     q         扇区选择的锐度的 uniform 节点（GLSL 默认 8）
//     strength  0..1 混合量的 uniform 节点
//     texel     vec2 uniform 节点，1 / 输入尺寸
//     far       可选，远处换更大的笔触（GLSL 的 farRadius / farStart / farEnd），不给就是全幅 radius。透视相机才用，正交相机不要给（与 GLSL 一致）
//               { depth, radius, start, end, near, farClip }
//               depth   texture 节点，.x 是场景深度（0..1，WebGPU 的零到一深度；不是反向深度也行，用 three 的 perspectiveDepthToViewZ 换算，它认 renderer.reversedDepthBuffer）
//               radius  远处半径（像素）的 uniform 节点；start / end 从多远开始变、多远完全变成远处半径（视空间距离，世界单位）；near / farClip 相机的近远面
//               深度 ≥ 0.9999999 当作无穷远（天空、清屏处）。KR 要自己按 ceil(max(radius, far.radius)) 取，同 GLSL 的调用方。
//               真实深度：pass(scene, camera).getTextureNode('depth') 可以直接当 far.depth（已用 Dawn 实测，见 tests/offscreen/kuwahara.test.mjs 的深度约定用例）
export function kuwahara(TSL, { input, KR, radius, q, strength, texel, far }) {
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
