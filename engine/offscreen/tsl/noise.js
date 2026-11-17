// 北冥引擎 · 离屏出片 · 整数哈希与值噪声（TSL）：engine/look/glsl.js 的 HASH_NOISE 逐式照搬（PCG，Jarzynski & Olano 2020）。种子是整数，结果逐帧可复现。
//   noise(TSL) → { pcgh(uint) → uint, h21(ivec2, uint seed) → float [0,1], vnoise(vec2, uint seed) → float [0,1]（五次插值的值噪声） }
export function noise(TSL) {
  const { Fn, float, uint, ivec2, floor, fract, mix } = TSL;
  const pcgh = Fn(([v]) => {
    const s = v.mul(uint(747796405)).add(uint(2891336453));
    const w = s.shiftRight(s.shiftRight(uint(28)).add(uint(4))).bitXor(s).mul(uint(277803737));
    return w.shiftRight(uint(22)).bitXor(w);
  });
  const h21 = Fn(([p, seed]) => float(pcgh(uint(p.x).add(pcgh(uint(p.y).add(seed))))).mul(1 / 4294967295));
  const vnoise = Fn(([x, seed]) => {
    const i = floor(x), f = fract(x), ii = ivec2(i);
    const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
    const a = h21(ii, seed), b = h21(ii.add(ivec2(1, 0)), seed), c = h21(ii.add(ivec2(0, 1)), seed), d = h21(ii.add(ivec2(1, 1)), seed);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });
  return { pcgh, h21, vnoise };
}
