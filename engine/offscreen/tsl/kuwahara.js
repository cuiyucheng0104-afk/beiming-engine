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
//
// 性能：每个采样格的权重（高斯径向 × 8 扇区 cos⁸ 角向 × 圆内判定）只取决于 (i, j, KR)，与像素无关，所以在编译期用 kuwaharaTaps(KR) 算成常量并在着色器里展开：
//   · 圆外的格子整格省掉（不采样、不累加）；每个格子只累加权重非零的 3–4 个扇区（cos⁸ 在背向半圆为 0）；
//   · 各扇区的总权重（分母）是常量，不再逐像素累加；exp / cos⁸ / inversesqrt 都不在着色器里算。
//   · 方差只用三个通道之和（s² = Σ_c Var_c），所以 S 按标量累加 Σ w·|c|²，方差 = S / W − |m|²：每个扇区项少 2 次 FMA、累加寄存器 48 → 32 个；
//     与逐通道算再相加只差浮点舍入（逐通道 max(…, 0) 改成对和取 max，各通道方差在数学上本就 ≥ 0）。KR = 10 时（4K）这一遍约快三分之一，KR ≤ 7 时已卡在取样速率上、看不出差别。
// 画面与展开前（tests/offscreen/fixtures/kuwahara-legacy.js 的原样副本）逐像素一致（最大差 ≤ 1 级，见 tests/offscreen/kuwahara-fast.test.mjs）。
// shortcut: 完全展开，KR=10 时约 350 个采样、着色器源码很长，首次编译比循环版慢；以后若在 WARP 等软件适配器上编译过慢，再改成按行分块的循环。

/** 编译期格子表：圆内每个格子的 { i, j, prot, w }（prot = 灯点保护的距离衰减 1 - 0.6 r²；w = 8 个扇区的权重，前 4 个是 0°/45°/90°/135° 轴的正半，后 4 个是负半），以及 8 个扇区的总权重 W。 */
export function kuwaharaTaps(KR) {
  if (!Number.isInteger(KR) || KR < 2 || KR > 10) throw new RangeError(`Kuwahara 的 KR 要是 2..10 的整数，收到 ${KR}`);
  const p8 = p => { const a = Math.max(p, 0), a2 = a * a, a4 = a2 * a2; return a4 * a4; };   // cos⁸：相邻扇区在 ±22.5° 处各占一半
  const taps = [], W = Array(8).fill(0);
  for (let j = -KR; j <= KR; j++) for (let i = -KR; i <= KR; i++) {
    const vx = i / KR, vy = j / KR, r2 = vx * vx + vy * vy;
    if (r2 > 1.0001) continue;   // 圆外的格子（GLSL 里是 continue）
    const g = Math.exp(-2 * r2);
    let w;
    if (i === 0 && j === 0) w = Array(8).fill(g * 0.125);
    else {
      const s = 1 / Math.sqrt(Math.max(r2, 1e-8)), nx = vx * s, ny = vy * s;
      const pr = [nx, (nx + ny) * 0.70710678, ny, (ny - nx) * 0.70710678];   // 0°/45°/90°/135° 四根轴
      w = [...pr.map(p => p8(p) * g), ...pr.map(p => p8(-p) * g)].map(x => (x > 1e-9 ? x : 0));   // 1e-9 以下的权重（正交时的浮点残渣）对结果的影响 < 1e-8，直接当 0
    }
    for (let k = 0; k < 8; k++) W[k] += w[k];
    taps.push({ i, j, prot: 1 - 0.6 * r2, w });
  }
  return { taps, W };
}

export function kuwahara(TSL, { input, KR, radius, q, strength, texel, far }) {
  const { taps, W } = kuwaharaTaps(KR);
  const { Fn, float, vec2, vec3, vec4, uv, dot, max, mix, pow, select, smoothstep, perspectiveDepthToViewZ } = TSL;
  return Fn(() => {
    const coord = uv();
    const c0 = input.sample(coord).level(0).toVar();
    const M = Array.from({ length: 8 }, () => vec3(0).toVar());
    const S = Array.from({ length: 8 }, () => float(0).toVar());
    const prot = float(0).toVar();
    let rad = radius;
    if (far) {   // 底板（远处、清屏处）用更大的笔触，3D 主体保持小笔触
      const d = far.depth.sample(coord).level(0).x;
      const z = select(d.greaterThanEqual(0.9999999), float(1e9), perspectiveDepthToViewZ(d, far.near, far.farClip).negate());
      rad = mix(radius, far.radius, smoothstep(far.start, far.end, z)).toVar();
    }
    const step = rad.div(KR).mul(texel).toVar();   // 一格的 uv 步长
    for (const t of taps) {
      const cs = input.sample(coord.add(step.mul(vec2(t.i, t.j)))).level(0).toVar();
      const c = cs.rgb, c2 = dot(c, c).toVar();   // |c|²：方差只要三通道之和
      prot.assign(max(prot, cs.a.mul(t.prot)));
      for (let k = 0; k < 8; k++) if (t.w[k] > 0) { M[k].addAssign(c.mul(t.w[k])); S[k].addAssign(c2.mul(t.w[k])); }
    }
    const acc = vec3(0).toVar(), as = float(0).toVar();
    for (let k = 0; k < 8; k++) {
      const m = M[k].div(W[k]);
      const s2 = max(S[k].div(W[k]).sub(dot(m, m)), 0).mul(65025);   // 三通道方差之和，按 0..255 计，和论文的尺度一致
      const a = float(1).div(float(1).add(pow(s2, q.mul(0.5))));
      acc.addAssign(a.mul(m)); as.addAssign(a);
    }
    return vec4(mix(c0.rgb, acc.div(as), strength.mul(float(1).sub(prot))), 1);
  })();
}

