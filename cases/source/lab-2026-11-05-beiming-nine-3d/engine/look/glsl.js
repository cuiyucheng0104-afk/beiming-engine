// 北冥引擎 · 后期着色器共用的 GLSL 片段：整数哈希 + 值噪声。种子是整数，结果逐帧可复现。
// 哈希用 PCG（Jarzynski & Olano 2020 的公式）。
//
//   HASH_NOISE 定义：
//     uint  pcgh(uint v)                 32 位整数哈希
//     float h21(ivec2 p, uint seed)      整数格点 → [0, 1]
//     float vnoise(vec2 x, uint seed)    五次插值的值噪声 → [0, 1]

export const HASH_NOISE = /* glsl */`
uint pcgh(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h21(ivec2 p, uint seed){ return float(pcgh(uint(p.x) + pcgh(uint(p.y) + seed))) * (1.0 / 4294967295.0); }
float vnoise(vec2 x, uint seed){
  vec2 i = floor(x), f = fract(x); ivec2 ii = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = h21(ii, seed), b = h21(ii + ivec2(1, 0), seed), c = h21(ii + ivec2(0, 1), seed), d = h21(ii + ivec2(1, 1), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`;
