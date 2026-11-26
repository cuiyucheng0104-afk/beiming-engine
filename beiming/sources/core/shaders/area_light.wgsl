// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//
// 灯的采样、求值与求交，照 Cycles（Blender v5.2.3）逐行移植（Apache-2.0）：矩形面光（intern/cycles/kernel/light/area.h），
// 点光（kernel/light/point.h，不是球形的那一条路：半径 0 或按半径取圆盘）、平行光（kernel/light/sun.h），它们用到的
// kernel/light/common.h 与 kernel/sample/mapping.h 里的几个函数，以及阴影射线避开明暗交界线的起点偏移
// （kernel/light/sample.h 的 shadow_ray_offset、shadow_ray_smooth_surface_offset）。
// 矩形只移无聚拢（spread）、不在体积段里的那一条路：椭圆、聚光与体积段的分支不带。
// Cycles 里灯的参数放在 KernelLight（kernel/types.h:1492-1527）里，这里一律改成显式参数：co（灯心）、axis_u、len_u、
// axis_v、len_v、dir（灯面法向，灯朝这一侧发光）、invarea（面积的倒数，大于 0 表示矩形）。不定义灯的内存布局。
// Cycles 的 LightSample（kernel/light/common.h:17-31）只取这条路会写的字段作返回值。
// 用到 util.wgsl 的 safe_asinf、copysignf、safe_divide、len_ccl、normalize_ccl、safe_sqrtf、make_orthonormals、vector_angle、
// ray_quad_intersect 与 microfacet.wgsl 的 sqr、M_1_PI_F、sample_uniform_disk。

// area.h:19-102 的两个输出：立体角测度的概率密度；sample_coord 为真时是灯上的采样点，否则原样是传入的 light_p
struct RectSample {
  pdf: f32,
  P: vec3f,
}

// area.h:19-102: area_light_rect_sample。球面矩形采样（Urena et al., An Area-Preserving Parametrization for Spherical
// Rectangles）。Cycles 用 *light_p 同时做输入和输出，这里输入叫 light_p、输出放在返回值的 P
fn area_light_rect_sample(P: vec3f, light_p: vec3f, axis_u: vec3f, len_u: f32, axis_v: vec3f, len_v: f32, rand: vec2f, sample_coord: bool) -> RectSample {
  // Compute local reference system R.
  let x = axis_u;
  let y = axis_v;
  var z = cross(x, y);
  // Compute rectangle coords in local reference system.
  let dir = light_p - P;
  var z0 = dot(dir, z);
  // Flip 'z' to make it point against Q.
  if (z0 > 0.0) {
    z *= -1.0;
    z0 *= -1.0;
  }
  let xc = dot(dir, x);
  let yc = dot(dir, y);
  let x0 = xc - 0.5 * len_u;
  let x1 = xc + 0.5 * len_u;
  let y0 = yc - 0.5 * len_v;
  let y1 = yc + 0.5 * len_v;
  // Compute predefined constants.
  var nz = vec4f(-y0, x1, y1, -x0);
  nz /= sqrt(nz * nz + z0 * z0);
  // 原论文用 acos 求内角再减 2π，小矩形时相减抵消严重；Cycles 改用 asin(x) = π/2 − acos(x)（area.h:49-52）
  let g0 = safe_asinf(-nz.x * nz.y);
  let g1 = safe_asinf(-nz.y * nz.z);
  let g2 = safe_asinf(-nz.z * nz.w);
  let g3 = safe_asinf(-nz.w * nz.x);
  let S = -(g0 + g1 + g2 + g3);

  var out_p = light_p;
  if (sample_coord) {
    // Compute predefined constants.
    let b0 = nz.x;
    let b1 = nz.z;
    let b0sq = b0 * b0;
    // Compute cu. 论文里的常数 k 同样会抵消，Cycles 用上面的 asin 项代替，并翻转 cos(au)、sin(au) 的符号消掉多出的 π（area.h:64-68）
    let au = rand.x * S + g2 + g3;
    let fu = safe_divide(cos(au) * b0 + b1, sin(au));
    var cu = copysignf(1.0 / sqrt(fu * fu + b0sq), fu);
    cu = clamp(cu, -1.0, 1.0);
    // Compute xu.
    var xu = -(cu * z0) / max(sqrt(1.0 - cu * cu), 1e-7);
    xu = clamp(xu, x0, x1);
    // Compute yv.
    let d2 = sqr(xu) + sqr(z0);
    let h0 = y0 / sqrt(d2 + sqr(y0));
    let h1 = y1 / sqrt(d2 + sqr(y1));
    let hv = h0 + rand.y * (h1 - h0);
    let hv2 = hv * hv;
    // 阈值照 C++ 的 1.0f - 1e-6f 在 float32 里算
    let yv = select(y1, hv * sqrt(d2 / (1.0 - hv2)), hv2 < 1.0 - f32(1e-6));

    // Transform (xu, yv, z0) to world coords.
    out_p = P + xu * x + yv * y + z0 * z;
  }

  // return pdf
  let nz2 = nz * nz;
  if (S < 1e-5 || min(min(nz2.x, nz2.y), min(nz2.z, nz2.w)) > 0.99999) {
    // 立体角太小、float32 算不准，或者掠射（#98930），退回平面采样的概率密度；阈值 1e-5 是 Cycles 实测定的（area.h:89-97）
    let t = len_ccl(dir);
    return RectSample(safe_divide(-t * t * t, (z0 * len_u * len_v)), out_p);
  }
  return RectSample(1.0 / rect_solid_angle_pdf_S(S, x0, x1, y0, y1, z0, len_u, len_v), out_p);
}

// 北冥（对 Cycles 的有意偏离）：做概率密度 1/S 的那个 S。采样映射与「S 小于 1e-5 退到平面」的判断照旧用上面 Cycles 原式的 S；
// 远场换成 Van Oosterom–Strackee 的两个三角形 (a, b, c)、(a, c, d)：tan(Ω/2) = |a·(b×c)| / (|a||b||c| + (a·b)|c| + (a·c)|b| + (b·c)|a|)，
// a、b、c、d 是灯的四个角在 Cycles 的局部坐标里的位置，三重积就是 |z0|·len_u·len_v（没有相消）。
// 理由：原式的 S 是四个量级到 π/2 的 asin 相加抵消出来的，远场只剩几个末位；Cycles 在处理器上舍入近乎随机，像素抖动平均得掉，
// 显卡上舍入随位置光滑变化，平均不掉，暗区出 ±7e-5 的弧纹【实测】。
// 远场：S 不小于 RECT_VOS_MIN_S，且四个角两两的点积都是正的（从着色点看两两夹角小于 90°）。这时分母的四项同号、不相消，
// 结果到几个末位；近场分母是几项相消出来的（三角形的立体角接近 π 时分母接近 0），单精度下反而不如原式，所以近场照旧用原式。
// RECT_VOS_MIN_S 扫过 1e-5、5e-5、2e-4、1e-3【实测，第 4 级 r006、r013 低粗糙度高光四个取值点】：四档在三个点上读数相同，
// 光面掠过地板那一帧 Welch 显著比例 2.1e-2、1.4e-2、1.5e-2、1.6e-2，取 5e-5。S 贴近 1e-5 时原式在 Cycles 一侧也只剩一两位，
// 参考图里带着它，那里照原式反而对得上（推断）
// 守卫：分母不大于 0（这个三角形的立体角不小于 π）时也退回原式；漏了它，贴近灯面时 S 会算成 1e-28 这类数
const RECT_VOS_MIN_S: f32 = 5e-5;
fn rect_solid_angle_pdf_S(S: f32, x0: f32, x1: f32, y0: f32, y1: f32, z0: f32, len_u: f32, len_v: f32) -> f32 {
  if (S < RECT_VOS_MIN_S) { return S; }
  let a = vec3f(x0, y0, z0);
  let b = vec3f(x1, y0, z0);
  let c = vec3f(x1, y1, z0);
  let d = vec3f(x0, y1, z0);
  let ab = dot(a, b);
  let ac = dot(a, c);
  let bc = dot(b, c);
  let ad = dot(a, d);
  let cd = dot(c, d);
  if (!(min(min(ab, ac), min(min(bc, ad), cd)) > 0.0)) { return S; }
  let ra = len_ccl(a);
  let rb = len_ccl(b);
  let rc = len_ccl(c);
  let rd = len_ccl(d);
  let n = abs(z0) * len_u * len_v;
  let m1 = ra * rb * rc + ab * rc + ac * rb + bc * ra;
  let m2 = ra * rc * rd + ac * rd + ad * rc + cd * ra;
  if (!(m1 > 0.0 && m2 > 0.0)) { return S; }
  return 2.0 * (atan2(n, m1) + atan2(n, m2));
}

// area.h:249-326 与 328-372 的输出，即 LightSample 里这条路会写的字段。ok 为假时其余字段为 0
struct AreaLightSample {
  ok: bool,
  P: vec3f,
  D: vec3f,
  t: f32,
  pdf: f32,
  eval_fac: f32,
}

// area.h:249-326: area_light_eval<false>，矩形（invarea > 0）、无聚拢（normalize_spread = 0）。
// sample_coord 为假时 Cycles 不写 ls->P、ls->D、ls->t，这里 P 原样返回 light_P，D、t 为 0，由调用方自己的值为准
fn area_light_eval(ray_P: vec3f, light_P: vec3f, axis_u: vec3f, len_u: f32, axis_v: vec3f, len_v: f32, invarea_in: f32, rand: vec2f, sample_coord: bool) -> AreaLightSample {
  let invarea = abs(invarea_in);
  var ls = AreaLightSample();
  let r = area_light_rect_sample(ray_P, light_P, axis_u, len_u, axis_v, len_v, rand, sample_coord);
  ls.pdf = r.pdf;
  ls.P = light_P;
  if (sample_coord) {
    ls.P = r.P;
    // util/math_float3.h:548-552: safe_normalize_len
    ls.t = len_ccl(ls.P - ray_P);
    ls.D = select(ls.P - ray_P, (ls.P - ray_P) / ls.t, ls.t != 0.0);
  }

  // Convert radiant flux to radiance.
  ls.eval_fac = M_1_PI_F * invarea;

  ls.ok = ls.eval_fac > 0.0;
  return ls;
}

// area.h:328-372: area_light_sample<false>，从着色点 P 采样矩形面光。灯单面发光：P 在灯背面（dot(co − P, dir) > 0）时返回 ok = 假。
// area.h:347-369 算的 light_u、light_v 只在聚拢打开时用来判越界，这条路上不用，不带
fn area_light_sample(rand: vec2f, P: vec3f, co: vec3f, axis_u: vec3f, len_u: f32, axis_v: vec3f, len_v: f32, dir: vec3f, invarea: f32) -> AreaLightSample {
  if (dot(co - P, dir) > 0.0) {
    return AreaLightSample();
  }
  let ls = area_light_eval(P, co, axis_u, len_u, axis_v, len_v, invarea, rand, true);
  if (!ls.ok) {
    return AreaLightSample();
  }
  return ls;
}

// area.h:390-427 的输出：打中没有，与交点距离；没打中时 t 为 0
struct AreaLightHit {
  hit: bool,
  t: f32,
}

// area.h:390-427: area_light_intersect。射线 (ray_P, ray_D, tmin, tmax) 与灯面求交，单面：从灯背面来的射线不算打中
fn area_light_intersect(ray_P: vec3f, ray_D: vec3f, tmin: f32, tmax: f32, co: vec3f, axis_u: vec3f, len_u: f32, axis_v: vec3f, len_v: f32, dir: vec3f, invarea_in: f32) -> AreaLightHit {
  // Area light.
  let invarea = abs(invarea_in);
  let is_ellipse = invarea_in < 0.0;
  if (invarea == 0.0) {
    return AreaLightHit();
  }

  let inv_extent_u = axis_u / len_u;
  let inv_extent_v = axis_v / len_v;
  let Ng = dir;

  // One sided.
  if (dot(ray_D, Ng) >= 0.0) {
    return AreaLightHit();
  }

  let h = ray_quad_intersect(ray_P, ray_D, tmin, tmax, co, inv_extent_u, inv_extent_v, Ng, is_ellipse);
  return AreaLightHit(h.hit, h.t);
}

// kernel/light/common.h:34-37: LightEval
struct LightEval {
  eval_fac: f32,
  pdf: f32,
}

// area.h:445-462: area_light_eval_from_intersection。射线从 ray_P 沿 ray_D 走 t 打中灯面时（采样闭包那一侧的多重重要性采样）
// 的 eval_fac 与立体角概率密度。ray_D、t 在这条路上不参与计算（Cycles 只把它们存进 LightSample），dir 同样只是 KernelLight 的一员
fn area_light_eval_from_intersection(ray_P: vec3f, ray_D: vec3f, t: f32, co: vec3f, axis_u: vec3f, len_u: f32, axis_v: vec3f, len_v: f32, dir: vec3f, invarea: f32) -> LightEval {
  let ls = area_light_eval(ray_P, co, axis_u, len_u, axis_v, len_v, invarea, vec2f(0.0), false);
  if (!ls.ok) {
    return LightEval();
  }
  return LightEval(ls.eval_fac, ls.pdf);
}

// util/types_float.h: FLT_MAX；kernel/sample/mapping.h 等处的 M_1_2PI_F（1 / 2π）
const FLT_MAX: f32 = 3.402823466e38;
const M_1_2PI_F: f32 = 0.1591549430918953;

// kernel/light/common.h:17-31: LightSample 里点光、平行光这两条路会写的字段
struct LampSample {
  P: vec3f,
  Ng: vec3f,
  t: f32,
  D: vec3f,
  pdf: f32,
  eval_fac: f32,
}

// kernel/light/common.h:39-43: ellipse_sample
fn ellipse_sample(ru: vec3f, rv: vec3f, rand: vec2f) -> vec3f {
  let uv = sample_uniform_disk(rand);
  return ru * uv.x + rv * uv.y;
}

// kernel/light/common.h:51-59: disk_light_sample
fn disk_light_sample(n: vec3f, rand: vec2f) -> vec3f {
  let o = make_orthonormals(n);
  return ellipse_sample(o.a, o.b, rand);
}

// kernel/light/common.h:62-71: light_pdf_area_to_solid_angle
fn light_pdf_area_to_solid_angle(Ng: vec3f, I: vec3f, t: f32) -> f32 {
  let cos_pi = dot(Ng, I);
  if (cos_pi <= 0.0) {
    return 0.0;
  }
  return t * t / cos_pi;
}

// kernel/sample/mapping.h:125-171 的三个输出：方向、cos_theta、概率密度
struct ConeSample {
  D: vec3f,
  cos_theta: f32,
  pdf: f32,
}

// kernel/sample/mapping.h:125-171: sample_uniform_cone，绕 N、1 − cos 张角 one_minus_cos_angle 的锥里按立体角均匀取
fn sample_uniform_cone(N: vec3f, one_minus_cos_angle: f32, rand: vec2f) -> ConeSample {
  if (one_minus_cos_angle > 0.0) {
    var xy = sample_uniform_disk(rand);
    let r2 = dot(xy, xy);
    // Equivalent to `mix(cos_angle, 1.0f, 1.0f - r2)`.
    let cos_theta = 1.0 - r2 * one_minus_cos_angle;
    // Remap disk radius to cone radius, equivalent to `xy *= sin_theta / sqrt(r2)`.
    xy *= safe_sqrtf(one_minus_cos_angle * (2.0 - one_minus_cos_angle * r2));
    let pdf = M_1_2PI_F / one_minus_cos_angle;
    let o = make_orthonormals(N);
    return ConeSample(xy.x * o.a + xy.y * o.b + cos_theta * N, cos_theta, pdf);
  }
  return ConeSample(N, 1.0, 1.0);
}

// kernel/light/point.h:18-80: point_light_sample，不是球形（is_sphere 为假）的那一条路：半径 0 时就是灯心，否则在朝着色点的
// 圆盘上取一点。KernelLight 的 co、spot.radius、spot.eval_fac 改成显式参数；N 与 shader_flags 只在球形那一支读，不带
fn point_light_sample(co: vec3f, radius: f32, eval_fac: f32, rand: vec2f, P: vec3f) -> LampSample {
  var ls = LampSample();
  let r_sq = sqr(radius);
  var lightN = P - co;
  let d_sq = dot(lightN, lightN);
  let d = sqrt(d_sq);
  lightN /= d;

  ls.eval_fac = eval_fac;

  // Point light with ad-hoc radius based on oriented disk.
  ls.P = co;
  if (r_sq > 0.0) {
    ls.P += disk_light_sample(lightN, rand) * radius;
  }

  // util/math_float3.h:548-552: safe_normalize_len
  ls.t = len_ccl(ls.P - P);
  ls.D = select(ls.P - P, (ls.P - P) / ls.t, ls.t != 0.0);
  ls.Ng = -ls.D;

  // PDF.
  let invarea = select(1.0, 1.0 / (r_sq * M_PI_F), r_sq > 0.0);
  ls.pdf = invarea * light_pdf_area_to_solid_angle(lightN, -ls.D, ls.t);
  return ls;
}

// kernel/light/point.h:154-180: point_light_eval_from_intersection，不是球形的那一条路（path_flag、N 只在球形那一支读）
fn point_light_eval_from_intersection(ray_P: vec3f, ray_D: vec3f, t: f32, co: vec3f, radius: f32, eval_fac: f32) -> LightEval {
  let r_sq = sqr(radius);
  var light_eval = LightEval(eval_fac, 0.0);
  if (t != FLT_MAX) {
    let lightN = normalize_ccl(ray_P - co);
    let invarea = select(1.0, 1.0 / (r_sq * M_PI_F), r_sq > 0.0);
    light_eval.pdf = invarea * light_pdf_area_to_solid_angle(lightN, -ray_D, t);
  }
  return light_eval;
}

// kernel/light/sun.h:34-48: sun_light_sample。co 是光走的方向（宿主存 -Z 列归一化），one_minus_cosangle、eval_fac 照
// KernelLight 的 sun 一块
fn sun_light_sample(co: vec3f, one_minus_cosangle: f32, eval_fac: f32, rand: vec2f) -> LampSample {
  var ls = LampSample();
  let c = sample_uniform_cone(co, one_minus_cosangle, rand);
  ls.Ng = c.D;
  ls.pdf = c.pdf;
  ls.P = ls.Ng;
  ls.D = -ls.Ng;
  ls.t = FLT_MAX;
  ls.eval_fac = eval_fac;
  return ls;
}

// kernel/light/sun.h:76-89: sun_light_eval_from_intersection。angle 是半角（KernelLight 的 sun.angle），pdf 是宿主存的
// 1 / (2π·one_minus_cosangle)
fn sun_light_eval_from_intersection(co: vec3f, angle: f32, eval_fac: f32, pdf: f32, ray_D: vec3f) -> LightEval {
  if (angle == 0.0) {
    return LightEval();
  }
  if (vector_angle(-co, ray_D) > angle) {
    return LightEval();
  }
  return LightEval(eval_fac, pdf);
}

// kernel/light/sample.h:169-221: shadow_ray_smooth_surface_offset。三角形的三个顶点 V0..V2 与顶点法线 N0..N2 在世界空间
// （相当于 SD_OBJECT_TRANSFORM_APPLIED，插值出来的 n 不再变换）；sd_u、sd_v 是着色点的重心坐标（sd->u、sd->v）；Ng 是已经
// 按透射翻过的几何法线
fn shadow_ray_smooth_surface_offset(V0: vec3f, V1: vec3f, V2: vec3f, N0: vec3f, N1: vec3f, N2: vec3f, sd_u: f32, sd_v: f32, Ng: vec3f) -> vec3f {
  let u = 1.0 - sd_u - sd_v;
  let v = sd_u;
  let w = sd_v;
  let P = V0 * u + V1 * v + V2 * w; // Local space
  let n = N0 * u + N1 * v + N2 * w; // We get away without normalization

  // Parabolic approximation
  let a = dot(N2 - N0, V0 - V2);
  let b = dot(N2 - N1, V1 - V2);
  let c = dot(N1 - N0, V1 - V0);
  var h = a * u * (u - 1.0) + (a + b + c) * u * v + b * v * (v - 1.0);

  // Check flipped normals
  if (dot(n, Ng) > 0.0) {
    // Local linear envelope
    var h0 = max(max(dot(V1 - V0, N0), dot(V2 - V0, N0)), 0.0);
    var h1 = max(max(dot(V0 - V1, N1), dot(V2 - V1, N1)), 0.0);
    var h2 = max(max(dot(V0 - V2, N2), dot(V1 - V2, N2)), 0.0);
    h0 = max(dot(V0 - P, N0) + h0, 0.0);
    h1 = max(dot(V1 - P, N1) + h1, 0.0);
    h2 = max(dot(V2 - P, N2) + h2, 0.0);
    h = max(min(min(h0, h1), h2), h * 0.5);
  } else {
    var h0 = max(max(dot(V0 - V1, N0), dot(V0 - V2, N0)), 0.0);
    var h1 = max(max(dot(V1 - V0, N1), dot(V1 - V2, N1)), 0.0);
    var h2 = max(max(dot(V2 - V0, N2), dot(V2 - V1, N2)), 0.0);
    h0 = max(dot(P - V0, N0) + h0, 0.0);
    h1 = max(dot(P - V1, N1) + h1, 0.0);
    h2 = max(dot(P - V2, N2) + h2, 0.0);
    h = min(-min(min(h0, h1), h2), h * 0.5);
  }

  return n * h;
}

// kernel/light/sample.h:225-263 的两个输出：挪过的起点，与 *r_skip_self（调用方的初值为真，Cycles 只在挪了的时候改写它）
struct ShadowOffset {
  P: vec3f,
  skip_self: bool,
}

// kernel/light/sample.h:225-263: shadow_ray_offset。sd->P、sd->N、sd->Ng 改成显式参数；`smooth_normal` 是 Cycles 的条件
// (sd->type & PRIMITIVE_TRIANGLE) && (sd->shader & SHADER_SMOOTH_NORMAL)，offset_cutoff 是物体的
// shadow_terminator_geometry_offset；三角形的顶点与顶点法线、重心坐标转给 shadow_ray_smooth_surface_offset
fn shadow_ray_offset(sd_P: vec3f, sd_N: vec3f, sd_Ng: vec3f, L: vec3f, smooth_normal: bool, offset_cutoff: f32, V0: vec3f, V1: vec3f, V2: vec3f, N0: vec3f, N1: vec3f, N2: vec3f, sd_u: f32, sd_v: f32) -> ShadowOffset {
  var P = sd_P;
  var skip_self = true;

  if (smooth_normal) {
    // Do ray offset (heavy stuff) only for close to be terminated triangles:
    // offset_cutoff = 0.1f means that 10-20% of rays will be affected. Also
    // make a smooth transition near the threshold.
    if (offset_cutoff > 0.0) {
      var NL = dot(sd_N, L);
      let transmit = (NL < 0.0);
      if (NL < 0.0) {
        NL = -NL;
      }

      let Ng = select(sd_Ng, -sd_Ng, transmit);
      let NgL = dot(Ng, L);

      let offset_amount = select(clamp(1.0 - NgL / offset_cutoff, 0.0, 1.0), clamp(2.0 - (NgL + NL) / offset_cutoff, 0.0, 1.0), NL < offset_cutoff);

      if (offset_amount > 0.0) {
        P += shadow_ray_smooth_surface_offset(V0, V1, V2, N0, N1, N2, sd_u, sd_v, Ng) * offset_amount;

        // Only skip self intersections if light direction and geometric normal point in the same
        // direction, otherwise we're meant to hit this surface.
        skip_self = (NgL > 0.0);
      }
    }
  }

  return ShadowOffset(P, skip_self);
}
