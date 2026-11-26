// SPDX-FileCopyrightText: 2011-2013 Intel Corporation
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//
// 闭包、采样与面光用到的工具函数，照 Cycles（Blender v5.2.3）的 util 与内核源码逐行移植；这些源文件都是 Apache-2.0。
// 另有两段取自 Apache-2.0 的内核文件里的一小段式子：原理化 BSDF 按高光等级调折射率（kernel/svm/closure.h），
// 滤光泽的模糊粗糙度（kernel/integrator/surface_shader.h）；还有闭包求值与采样入口乘的凹凸阴影项（kernel/closure/bsdf.h 的
// bump_shadowing_term，用到 microfacet.wgsl 的 bsdf_G_mono_ggx）。
// 行号指 intern/cycles/ 下的文件。Cycles 的 normalize、len 与 WGSL 内建的舍入不同（内建 normalize 用 inverseSqrt），
// 所以照原式写成 normalize_ccl、len_ccl。一维、二维查表函数读 ggx_tables.wgsl 里的 LOOKUP_TABLE；三维的与 _buf 两个
// 读存储缓冲（数据在 ggx_gen_schlick.tables，见 lookup_table_read_buf 上面的说明）。

// util/math_base.h:37、40: M_PI_2_F、M_PI_4_F
const M_PI_2_F: f32 = 1.5707963267948966;
const M_PI_4_F: f32 = 0.7853981633974830;

// kernel/types.h:330-335: ClosureLabel 里移植的闭包用得到的几个
const LABEL_NONE: i32 = 0;
const LABEL_REFLECT: i32 = 2;
const LABEL_DIFFUSE: i32 = 4;
const LABEL_GLOSSY: i32 = 8;
const LABEL_SINGULAR: i32 = 16;

// util/math_base.h:538: safe_sqrtf
fn safe_sqrtf(f: f32) -> f32 {
  return sqrt(max(f, 0.0));
}

// util/math_base.h:543-550: inversesqrtf（CPU 那一支；Metal 那一支用 rsqrt，精度不同）
fn inversesqrtf(f: f32) -> f32 {
  return select(0.0, 1.0 / sqrt(f), f > 0.0);
}

// util/math_base.h:552-555: safe_asinf。Cycles 在处理器上调 C 库的 asinf，结果近乎正确舍入，误差在相邻的输入之间像随机数；
// 显卡内建的 asin 偏差是位置的光滑函数（苹果显卡上一段输入里平均偏 0.3 到 2 个末位，同号），矩形面光的立体角是四个 asin
// 相加抵消出来的，这种偏差像素抖动平均不掉。所以不用内建，照教科书的写法自己算（北冥的写法，不是 Cycles 的式子）：
// |x| ≤ 0.5 用 asin 的泰勒级数（到 x²⁵，截断误差不到 1e-10 倍），|x| > 0.5 用 asin(x) = π/2 − 2·asin(√((1 − |x|)/2))，
// π/2 拆成单精度的高位与低位（低位 −4.371139e-8），低位先经 fma 并进 2·asin(…)：写成 (高位 − 2·asin) + 低位的话，显卡编译器
// 会把两个常数合并掉。【实测】苹果显卡上对 C 库 asinf 的段内平均偏差：|x| ≤ 0.5 不到 0.02 个末位（与 C 库相同），0.5 到 0.85 约
// 0.3 到 0.7 个末位（低位在 fma 的舍入里丢了），0.9 以上不到 0.1；内建 asin 在 1e-4 附近偏 2 个末位、0.3 附近偏 1.1 个
fn asinf_series(x: f32) -> f32 {
  let t = x * x;
  var p = 0.0064472103;
  p = p * t + 0.0073125259;
  p = p * t + 0.0083903358;
  p = p * t + 0.0097616095;
  p = p * t + 0.0115518009;
  p = p * t + 0.0139648438;
  p = p * t + 0.0173527644;
  p = p * t + 0.0223721591;
  p = p * t + 0.0303819444;
  p = p * t + 0.0446428571;
  p = p * t + 0.075;
  p = p * t + 0.16666667;
  return x + x * (t * p);
}

fn safe_asinf(a: f32) -> f32 {
  let x = clamp(a, -1.0, 1.0);
  let ax = abs(x);
  var r = asinf_series(ax);
  if (ax > 0.5) {
    r = M_PI_2_F - fma(2.0, asinf_series(sqrt((1.0 - ax) * 0.5)), 4.371139e-8);
  }
  return copysignf(r, x);
}

// C 库的 sinf、cosf，一次给出 (sin x, cos x)。Cycles 在处理器上调 C 库，结果近乎正确舍入；显卡内建的 sin、cos 偏差随位置光滑
// 变化、一段里同号，像素抖动平均不掉（理由同 safe_asinf）。照教科书的写法自己算（北冥的写法，不是 Cycles 的式子）：
// Cody–Waite 两段约简 x = k·π/2 + rh + rl（k = round(x·2/π)，π/2 拆成单精度的高位与低位；rh = x − k·高位经 fma 是精确的，
// rl = −k·低位），|rh| ≤ π/4 上 sin 的泰勒级数到 r¹³、cos 到 r¹²（截断误差不到 1e-12），rl 当一阶修正并进最后一步，再按 k 的
// 象限换位、变号。rl 不先并进 rh：rh 落在 x 的末位网格上，加 rl 的舍入对一段输入是同一个量，结果整段同号地偏（实测约 0.25 个末位）。
// 只为 |x| 不过几个 π 的输入（矩形面光采样映射的 au 在 (−π, π)）。级数是奇偶函数、round 对正负对称，sincosf(−x) 与 sincosf(x) 严格对称
fn sincosf(x: f32) -> vec2f {
  let k = round(x * 0.63661975);
  let rh = fma(-k, 1.5707964, x);
  let rl = k * 4.3711388e-8;
  let t = rh * rh;
  var ps = 1.6059044e-10;
  ps = ps * t - 2.5052108e-8;
  ps = ps * t + 2.7557319e-6;
  ps = ps * t - 1.9841270e-4;
  ps = ps * t + 8.3333333e-3;
  ps = ps * t - 0.16666667;
  var pc = 2.0876757e-9;
  pc = pc * t - 2.7557319e-7;
  pc = pc * t + 2.4801587e-5;
  pc = pc * t - 1.3888889e-3;
  pc = pc * t + 4.1666667e-2;
  pc = pc * t - 0.5;
  // sin(rh + rl) ≈ sin rh + rl·cos rh，cos(rh + rl) ≈ cos rh − rl·sin rh（rl 不到 1e-7，二阶项远小于末位）。修正量都在最后一次
  // 舍入之前并进去：先把 cos rh 舍入成单精度再减 rl·rh 的话，修正量不到一个末位、整段被同一个方向舍掉（实测约 0.3 个末位）
  let c = 1.0 + fma(t, pc, -rl * rh);
  let s = rh + fma(rl, c, rh * (t * ps));
  let q = i32(k) & 3;
  if (q == 0) { return vec2f(s, c); }
  if (q == 1) { return vec2f(c, -s); }
  if (q == 2) { return vec2f(-s, -c); }
  return vec2f(-c, s);
}

// C 标准库的 copysignf（Cycles 在 CPU 上直接用它）：WGSL 没有，按位取 b 的符号位，±0 与 NaN 的符号也照搬
fn copysignf(a: f32, b: f32) -> f32 {
  return bitcast<f32>((bitcast<u32>(a) & 0x7fffffffu) | (bitcast<u32>(b) & 0x80000000u));
}

// util/math_base.h:594: safe_divide(float, float)
fn safe_divide(a: f32, b: f32) -> f32 {
  return select(0.0, a / b, b != 0.0);
}

// util/math_float3.h:288: len(float3)
fn len_ccl(a: vec3f) -> f32 {
  return sqrt(dot(a, a));
}

// 1/|a|，a 为零时给 0：GGX 求值里半向量的 safe_divide(1.0f, len(H))（kernel/closure/bsdf_microfacet.h:726）。Cycles 在处理器上
// sqrtf 与除法都正确舍入，误差在相邻的输入之间像随机数；显卡上照原式写，1/sqrt 被编成近似指令，结果偏向一边（【实测】镜面峰上
// cos_NH 的平均偏差，英伟达上 −0.089 个末位、苹果显卡上 0.05 个，见 fncheck/registry.mjs 的 PEAK_BIAS）。bsdf_D_ggx 的 1 − cos_NH²
// 在半向量贴近法线时相消，cos_NH 的偏差被放大约 4/alpha² 倍：alpha = 0.017 的抛光金属上，峰顶一个末位就是高光亮度的 8e-4，整片
// 高光同号地偏，像素抖动平均不掉。所以用内建 inverseSqrt 再做一次牛顿迭代（北冥的写法，不是 Cycles 的式子）：
// y ← y + y/2·(1 − |a|²·y²)，两步都经 fma，近似指令的误差压到舍入误差以下（两台显卡上都不到 0.005 个末位）
fn inverse_len(a: vec3f) -> f32 {
  let l2 = dot(a, a);
  let y = select(0.0, inverseSqrt(l2), l2 > 0.0);
  return fma(y * 0.5, fma(-l2 * y, y, 1.0), y);
}

// 着色法线的单位化（插值法线、法线贴图）：内建 normalize 与 a / len_ccl(a) 在显卡上同 1/|H| 一样偏向一边（【实测】|N| − 1 的平均偏差，
// 英伟达上 −0.094 个末位、苹果显卡上 0.05 个，见 fncheck/registry.mjs 的 NLEN_BIAS）。|N| 的偏差原样进 cos_NH = dot(N, H)，经 bsdf_D_ggx
// 放大的倍数与 inverse_len 那里相同，曲面网格上的抛光金属会整片同号地偏。所以乘 inverse_len（北冥的写法）；a 为零时给零向量
fn normalize_unbiased(a: vec3f) -> vec3f {
  return a * inverse_len(a);
}

// util/math_float3.h:332-340: normalize(float3)
fn normalize_ccl(a: vec3f) -> vec3f {
  return a / len_ccl(a);
}

// util/math_float3.h:542-546: safe_normalize_fallback
fn safe_normalize_fallback(a: vec3f, fallback: vec3f) -> vec3f {
  let t = len_ccl(a);
  if (t != 0.0) {
    return a * (1.0 / t);
  }
  return fallback;
}

// kernel/closure/bsdf.h:89-150: bump_shadowing_term。Ns 是插值后的平滑法线（Cycles 的 sd->N），N 是闭包的法线（sc->N），
// I 是出射方向。Cycles 读着色点的另两样：图元是不是曲线（这里没有曲线）、凹凸校正标志 SD_USE_BUMP_MAP_CORRECTION
// （这里视为开，理由见 microfacet.wgsl 的 maybe_ensure_valid_specular_reflection）；闭包是不是漫反射类
// （CLOSURE_IS_BSDF_DIFFUSE）由调用方判好传进来。is_eval：求值入口为真，采样入口为假
fn bump_shadowing_term(Ns: vec3f, N: vec3f, I: vec3f, is_eval: bool, is_diffuse: bool) -> f32 {
  if (all(N == Ns)) {
    return 1.0;
  }

  // 方向要在平滑法线这一侧也合法：I 与 N 在平滑几何的同一侧时拒绝折射，在两侧时拒绝反射
  let cosNsI = dot(Ns, I);
  let cosNsN = dot(Ns, N);
  let cosNI = dot(N, I);
  if (cosNsI * cosNsN * cosNI < 0.0 && (is_eval || is_diffuse)) {
    return 0.0;
  }

  // 上面的判据对所有闭包都做，下面的柔化只给漫反射类
  if (!is_diffuse) {
    return 1.0;
  }

  // （凹凸校正标志关着时 Cycles 在这里返回 1；这里标志视为开）

  let cos_i = abs(cosNsI);
  let cos_d = abs(cosNsN);
  if (cos_d >= 1.0 || cos_i >= 1.0) {
    return 1.0;
  }
  if (cos_i < 1e-6) {
    return 0.0;
  }

  let tan2_d = 1.0 / sqr(cos_d) - 1.0;
  let bump_alpha2 = saturate(0.125 * tan2_d);

  // 平滑过渡，免得在垂直处不连续
  return bsdf_G_mono_ggx(bump_alpha2, cos_i);
}

// util/math_float3.h:601: average(float3) = reduce_add(a) * (1/3)
fn average(a: vec3f) -> f32 {
  return (a.x + a.y + a.z) * (1.0 / 3.0);
}

// util/math_float3.h:733-759: make_orthonormals 的两个输出
struct Orthonormals {
  a: vec3f,
  b: vec3f,
}

// util/math_float3.h:733-759: make_orthonormals(N, &a, &b)
fn make_orthonormals(N: vec3f) -> Orthonormals {
  var a: vec3f;
  if (N.x != N.y || N.x != N.z) {
    a = vec3f(N.z - N.y, N.x - N.z, N.y - N.x);  // (1,1,1) x N
  } else {
    a = vec3f(N.z - N.y, N.x + N.z, -N.y - N.x);  // (-1,1,1) x N
  }
  a = normalize_ccl(a);
  return Orthonormals(a, cross(N, a));
}

// util/transform.h:27-30: to_global(float3 p, X, Y, Z)
fn to_global(p: vec3f, X: vec3f, Y: vec3f, Z: vec3f) -> vec3f {
  return p.x * X + p.y * Y + p.z * Z;
}

// util/projection.h:30-33: polar_to_cartesian。Cycles 在处理器上调 C 库的 cosf、sinf；这里用上面自己写的 sincosf，不用内建：
// 显卡内建的 cos、sin 偏差是位置的光滑函数、一段里同号（理由同 safe_asinf），同心圆映射给平行光的锥、点光与面光的圆盘、GGX 可见
// 法线采样取点，取点整片同向地挪，像素抖动平均不掉（【实测】第 4 级平行光照抛光金属那一个取值点，苹果显卡对参考的 Welch 读数
// 由 1.1e-3 降到 0，英伟达上不变）。调用方只有 sample_uniform_disk，phi 在 [−π/4, 3π/4]，在 sincosf 的有效范围（|x| 不过几个 π）里
fn polar_to_cartesian(r: f32, phi: f32) -> vec2f {
  let sc = sincosf(phi);
  return vec2f(r * sc.y, r * sc.x);
}

// util/projection.h:35-38: disk_to_hemisphere
fn disk_to_hemisphere(p: vec2f) -> vec3f {
  return vec3f(p.x, p.y, safe_sqrtf(1.0 - dot(p, p)));
}

// kernel/svm/closure.h:307-308、582-583: 金属与 Principled 都取 alpha = sqr(roughness)（roughness 先 saturate）
fn roughness_to_alpha(roughness: f32) -> f32 {
  return sqr(roughness);
}

// kernel/util/lookup_table.h:13-28: lookup_table_read
fn lookup_table_read(x_in: f32, offset: i32, size: i32) -> f32 {
  let x = saturate(x_in) * f32(size - 1);

  let index = min(i32(x), size - 1);
  let nindex = min(index + 1, size - 1);
  let t = x - f32(index);

  let data0 = LOOKUP_TABLE[index + offset];
  if (t == 0.0) {
    return data0;
  }

  let data1 = LOOKUP_TABLE[nindex + offset];
  return (1.0 - t) * data0 + t * data1;
}

// kernel/util/lookup_table.h:30-45: lookup_table_read_2D
fn lookup_table_read_2D(x: f32, y_in: f32, offset: i32, xsize: i32, ysize: i32) -> f32 {
  let y = saturate(y_in) * f32(ysize - 1);

  let index = min(i32(y), ysize - 1);
  let nindex = min(index + 1, ysize - 1);
  let t = y - f32(index);

  let data0 = lookup_table_read(x, offset + xsize * index, xsize);
  if (t == 0.0) {
    return data0;
  }

  let data1 = lookup_table_read(x, offset + xsize * nindex, xsize);
  return (1.0 - t) * data0 + t * data1;
}

// 下面三个读存储缓冲里的表，与 Cycles 一样按偏移读 lookup_table（kernel_data_fetch(lookup_table, i)）。
// 不用常数数组：naga 生成 SPIR-V 时按运行时下标取常数数组会先把整个数组拷进函数内的临时变量，大表在英伟达上编译不出来。
// 取数的 lookup_table_fetch(i)（i 是第几个 float）与各表的偏移由引入这份文件的着色器给：内核在 path/shaders/pathtrace.wgsl，
// 比对外壳在 fncheck/gpu.mjs，函数体两边同一份。上面两个读 ggx_tables.wgsl 常数数组的旧函数不动。

// kernel/util/lookup_table.h:13-28: lookup_table_read（读存储缓冲里的表）
fn lookup_table_read_buf(x_in: f32, offset: i32, size: i32) -> f32 {
  let x = saturate(x_in) * f32(size - 1);

  let index = min(i32(x), size - 1);
  let nindex = min(index + 1, size - 1);
  let t = x - f32(index);

  let data0 = lookup_table_fetch(index + offset);
  if (t == 0.0) {
    return data0;
  }

  let data1 = lookup_table_fetch(nindex + offset);
  return (1.0 - t) * data0 + t * data1;
}

// kernel/util/lookup_table.h:30-45: lookup_table_read_2D（读存储缓冲里的表）
fn lookup_table_read_2D_buf(x: f32, y_in: f32, offset: i32, xsize: i32, ysize: i32) -> f32 {
  let y = saturate(y_in) * f32(ysize - 1);

  let index = min(i32(y), ysize - 1);
  let nindex = min(index + 1, ysize - 1);
  let t = y - f32(index);

  let data0 = lookup_table_read_buf(x, offset + xsize * index, xsize);
  if (t == 0.0) {
    return data0;
  }

  let data1 = lookup_table_read_buf(x, offset + xsize * nindex, xsize);
  return (1.0 - t) * data0 + t * data1;
}

// kernel/util/lookup_table.h:49-69: lookup_table_read_3D（读存储缓冲里的表；广义 Schlick 的两张表只走这里）
fn lookup_table_read_3D(x: f32, y: f32, z_in: f32, offset: i32, xsize: i32, ysize: i32, zsize: i32) -> f32 {
  let z = saturate(z_in) * f32(zsize - 1);

  let index = min(i32(z), zsize - 1);
  let nindex = min(index + 1, zsize - 1);
  let t = z - f32(index);

  let data0 = lookup_table_read_2D_buf(x, y, offset + xsize * ysize * index, xsize, ysize);
  if (t == 0.0) {
    return data0;
  }

  let data1 = lookup_table_read_2D_buf(x, y, offset + xsize * ysize * nindex, xsize, ysize);
  return (1.0 - t) * data0 + t * data1;
}

// util/math_base.h:521-524: inverse_lerp
fn inverse_lerp(a: f32, b: f32, x: f32) -> f32 {
  return (x - a) / (b - a);
}

// util/math_float3.h:302-305: reduce_max(float3)
fn reduce_max(a: vec3f) -> f32 {
  return max(max(a.x, a.y), a.z);
}

// util/color.h:388-397: safe_divide_color（fallback 取默认的 0）
fn safe_divide_color(a: vec3f, b: vec3f) -> vec3f {
  return select(vec3f(0.0), a / b, b != vec3f(0.0));
}

// kernel/svm/closure.h:426-436 原理化分支里按高光等级调折射率的那一段：返回电介质高光用的 (f0, eta)。
// eta 为 1 时 Cycles 不建电介质高光（closure.h:439，薄膜关着）
fn principled_specular_f0_eta(ior: f32, specular_ior_level: f32) -> vec2f {
  var eta = ior;
  var f0 = F0_from_ior(eta);
  if (specular_ior_level != 0.5) {
    f0 *= 2.0 * specular_ior_level;
    eta = ior_from_F0(f0);
    if (ior < 1.0) {
      eta = 1.0 / eta;
    }
  }
  return vec2f(f0, eta);
}

// kernel/integrator/surface_shader.h:189-202 surface_shader_prepare_closures 里滤光泽那一段算出的模糊粗糙度：
// filter_glossy 是内核里的值 1 / blur_glossy（宿主侧 scene/integrator.cpp:269；北冥的全局参数里存的也是它，0 关、调用方不进来）。
// blur_pdf ≥ 1 时 Cycles 不模糊，这里返回 0（bsdf_microfacet_blur 取大之后不改任何闭包）
fn filter_glossy_roughness(filter_glossy: f32, min_ray_pdf: f32) -> f32 {
  let blur_pdf = filter_glossy * min_ray_pdf;
  if (blur_pdf < 1.0) {
    return sqrt(1.0 - blur_pdf) * 0.5;
  }
  return 0.0;
}

// util/math_intersect.h:288-338: ray_quad_intersect 的输出。没打中时 Cycles 不写输出指针，这里其余字段为 0
struct QuadHit {
  hit: bool,
  P: vec3f,
  t: f32,
  u: f32,
  v: f32,
}

// util/math_intersect.h:288-338: ray_quad_intersect（isect_P、isect_t、isect_u、isect_v 四个输出指针都不为空的情形）
fn ray_quad_intersect(ray_P: vec3f, ray_D: vec3f, ray_tmin: f32, ray_tmax: f32, quad_P: vec3f, inv_quad_u: vec3f, inv_quad_v: vec3f, quad_n: vec3f, ellipse: bool) -> QuadHit {
  // Perform intersection test.
  let t = -(dot(ray_P, quad_n) - dot(quad_P, quad_n)) / dot(ray_D, quad_n);
  if (!(t > ray_tmin && t < ray_tmax)) {
    return QuadHit();
  }
  let hit = ray_P + t * ray_D;
  let inplane = hit - quad_P;
  let u = dot(inplane, inv_quad_u);
  if (u < -0.5 || u > 0.5) {
    return QuadHit();
  }
  let v = dot(inplane, inv_quad_v);
  if (v < -0.5 || v > 0.5) {
    return QuadHit();
  }
  if (ellipse && (u * u + v * v > 0.25)) {
    return QuadHit();
  }
  // NOTE: Return barycentric coordinates in the same notation as Embree and OptiX.
  return QuadHit(true, hit, t, v + 0.5, -u - v);
}

// util/math_intersect.h:140-149: ray_triangle_dot（不带 SSE 的那一支，逐分量乘了再加）
fn ray_triangle_dot(a: vec3f, b: vec3f) -> f32 {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// util/math_intersect.h:151-161: ray_triangle_cross（不带 SSE 的那一支）
fn ray_triangle_cross(a: vec3f, b: vec3f) -> vec3f {
  return vec3f(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

// util/math_intersect.h:116-138: ray_triangle_reciprocal（不带 SIMD 的那一支，1/x；SSE 与 NEON 两支是近似倒数加一步牛顿迭代）
fn ray_triangle_reciprocal(x: f32) -> f32 {
  return 1.0 / x;
}

// util/math_intersect.h:163-222: ray_triangle_intersect 的输出。没打中时 Cycles 不写输出指针，这里其余字段为 0。
// u、v 是 tri_b、tri_c 的重心坐标（u 由不含 tri_b 的那条边算出），与硬件求交的 barycentrics 同一口径
struct TriangleHit {
  hit: bool,
  u: f32,
  v: f32,
  t: f32,
}

// util/math_intersect.h:163-222: ray_triangle_intersect，Embree 的 Plücker 坐标求交。每条边各算一次
// cross(边, 两端之和)·D，两个三角形的公共边算出来只差符号，再给 FLT_EPSILON·|U+V+W| 的容差：公共边上不会两边都判不中
fn ray_triangle_intersect(ray_P: vec3f, ray_D: vec3f, ray_tmin: f32, ray_tmax: f32, tri_a: vec3f, tri_b: vec3f, tri_c: vec3f) -> TriangleHit {
  // This implementation matches the Plücker coordinates triangle intersection
  // in Embree.

  // Calculate vertices relative to ray origin.
  let v0 = tri_a - ray_P;
  let v1 = tri_b - ray_P;
  let v2 = tri_c - ray_P;

  // Calculate triangle edges.
  let e0 = v2 - v0;
  let e1 = v0 - v1;
  let e2 = v1 - v2;

  // Perform edge tests.
  let U = ray_triangle_dot(ray_triangle_cross(e0, v2 + v0), ray_D);
  let V = ray_triangle_dot(ray_triangle_cross(e1, v0 + v1), ray_D);
  let W = ray_triangle_dot(ray_triangle_cross(e2, v1 + v2), ray_D);

  let UVW = U + V + W;
  // FLT_EPSILON（C 标准库 float.h，2^-23）
  let eps = 1.192092896e-07 * abs(UVW);
  let minUVW = min(U, min(V, W));
  let maxUVW = max(U, max(V, W));

  if (!(minUVW >= -eps || maxUVW <= eps)) {
    return TriangleHit();
  }

  // Calculate geometry normal and denominator.
  let Ng1 = ray_triangle_cross(e1, e0);
  let Ng = Ng1 + Ng1;
  let den = dot(Ng, ray_D);
  // Avoid division by 0.
  if (den == 0.0) {
    return TriangleHit();
  }

  // Perform depth test.
  let T = dot(v0, Ng);
  let t = T / den;
  if (!(t >= ray_tmin && t <= ray_tmax)) {
    return TriangleHit();
  }

  let rcp_uvw = select(ray_triangle_reciprocal(UVW), 0.0, abs(UVW) < 1e-18);
  return TriangleHit(true, min(U * rcp_uvw, 1.0), min(V * rcp_uvw, 1.0), t);
}

// util/math_intersect.h:252-276: ray_triangle_intersect_self。与 ray_triangle_intersect 同一套边测试（叉积的两个因子对调），
// 容差放宽成「严格在三条边以内 FLT_EPSILON·|U+V+W|」：起点在三角形上、方向穿过三角形内部时为真（这条射线不会先打中相邻的三角形）
fn ray_triangle_intersect_self(ray_P: vec3f, ray_D: vec3f, tri_a: vec3f, tri_b: vec3f, tri_c: vec3f) -> bool {
  // Matches logic in ray_triangle_intersect, self intersection test to validate
  // if a ray is going to hit self or might incorrectly hit a neighboring triangle.

  // Calculate vertices relative to ray origin.
  let v0 = tri_a - ray_P;
  let v1 = tri_b - ray_P;
  let v2 = tri_c - ray_P;

  // Calculate triangle edges.
  let e0 = v2 - v0;
  let e1 = v0 - v1;
  let e2 = v1 - v2;

  // Perform edge tests.
  let U = ray_triangle_dot(ray_triangle_cross(v2 + v0, e0), ray_D);
  let V = ray_triangle_dot(ray_triangle_cross(v0 + v1, e1), ray_D);
  let W = ray_triangle_dot(ray_triangle_cross(v1 + v2, e2), ray_D);

  // FLT_EPSILON（C 标准库 float.h，2^-23）
  let eps = 1.192092896e-07 * abs(U + V + W);
  let minUVW = min(U, min(V, W));
  let maxUVW = max(U, max(V, W));

  // Note the extended epsilon compared to ray_triangle_intersect, to account
  // for intersections with neighboring triangles that have an epsilon.
  return (minUVW >= eps || maxUVW <= -eps);
}

// kernel/bvh/util.h:64-88: ray_offset（Ray Tracing Gems 第 6 章 "A Fast and Robust Method for Avoiding Self-Intersection"）：
// 起点沿 Ng 挪 256·Ng 个末位（对浮点数的位做整数加法）；分量的绝对值小于 1/32 时改加 Ng/65536。2^-16 是 2 的幂，
// 乘积没有舍入，显卡合不合成 FMA 结果都一样
fn ray_offset(P: vec3f, Ng: vec3f) -> vec3f {
  let int_scale = 256.0;
  let of_i = vec3<i32>(i32(int_scale * Ng.x), i32(int_scale * Ng.y), i32(int_scale * Ng.z));

  let p_i = vec3f(
      bitcast<f32>(bitcast<i32>(P.x) + select(of_i.x, -of_i.x, P.x < 0.0)),
      bitcast<f32>(bitcast<i32>(P.y) + select(of_i.y, -of_i.y, P.y < 0.0)),
      bitcast<f32>(bitcast<i32>(P.z) + select(of_i.z, -of_i.z, P.z < 0.0)));
  let origin = 1.0 / 32.0;
  let float_scale = 1.0 / 65536.0;
  return vec3f(select(p_i.x, P.x + float_scale * Ng.x, abs(P.x) < origin),
               select(p_i.y, P.y + float_scale * Ng.y, abs(P.y) < origin),
               select(p_i.z, P.z + float_scale * Ng.z, abs(P.z) < origin));
}

// util/math_fast.h:309-336: fast_atan2f（多项式近似，最大误差约 6.6e-6）。madd(a, b, c) 是 a·b + c（-ffp-contract=off 下不合成
// FMA，这里照样分两步写）
fn fast_atan2f(y: f32, x: f32) -> f32 {
  let a = abs(x);
  let b = abs(y);

  let k = select(select(select(a / b, b / a, !(b > a)), 1.0, a == b), 0.0, b == 0.0);
  let s = 1.0 - (1.0 - k); // Crush denormals
  let t = s * s;

  var r = s * (0.43157974 * t + 1.0) / ((0.05831938 * t + 0.76443945) * t + 1.0);

  if (b > a) {
    // Account for arg reduction.
    r = M_PI_2_F - r;
  }
  // Test sign bit of x.
  if ((bitcast<u32>(x) & 0x80000000u) != 0u) {
    r = M_PI_F - r;
  }
  return copysignf(r, y);
}

// util/math_fast.h:339-342: vector_angle
fn vector_angle(a: vec3f, b: vec3f) -> f32 {
  return 2.0 * fast_atan2f(len_ccl(a - b), len_ccl(a + b));
}
