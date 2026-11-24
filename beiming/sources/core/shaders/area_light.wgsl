// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//
// 矩形面光的采样、求值与求交，照 Cycles（Blender v5.2.3）的 intern/cycles/kernel/light/area.h 逐行移植（Apache-2.0）。
// 只移矩形、无聚拢（spread）、不在体积段里的那一条路：椭圆、聚光与体积段的分支不带。
// Cycles 里灯的参数放在 KernelLight（kernel/types.h:1492-1527）里，这里一律改成显式参数：co（灯心）、axis_u、len_u、
// axis_v、len_v、dir（灯面法向，灯朝这一侧发光）、invarea（面积的倒数，大于 0 表示矩形）。不定义灯的内存布局。
// Cycles 的 LightSample（kernel/light/common.h:17-31）只取这条路会写的字段作返回值。
// 用到 util.wgsl 的 safe_asinf、copysignf、safe_divide、len_ccl、ray_quad_intersect 与 microfacet.wgsl 的 sqr、M_1_PI_F。

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
  return RectSample(1.0 / S, out_p);
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
