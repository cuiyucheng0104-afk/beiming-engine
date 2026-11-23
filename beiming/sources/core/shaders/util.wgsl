// SPDX-FileCopyrightText: 2011-2013 Intel Corporation
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//
// 闭包、采样与面光用到的工具函数，照 Cycles（Blender v5.2.3）的 util 与内核源码逐行移植；这些源文件都是 Apache-2.0。
// 行号指 intern/cycles/ 下的文件。Cycles 的 normalize、len 与 WGSL 内建的舍入不同（内建 normalize 用 inverseSqrt），
// 所以照原式写成 normalize_ccl、len_ccl。查表函数读 ggx_tables.wgsl 里的 LOOKUP_TABLE。

// util/math_base.h:37、40: M_PI_2_F、M_PI_4_F
const M_PI_2_F: f32 = 1.5707963267948966;
const M_PI_4_F: f32 = 0.7853981633974830;

// kernel/types.h:330-335: ClosureLabel 里金属反射用得到的几个
const LABEL_NONE: i32 = 0;
const LABEL_REFLECT: i32 = 2;
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

// util/math_base.h:552-555: safe_asinf
fn safe_asinf(a: f32) -> f32 {
  return asin(clamp(a, -1.0, 1.0));
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

// util/math_float3.h:332-340: normalize(float3)
fn normalize_ccl(a: vec3f) -> vec3f {
  return a / len_ccl(a);
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

// util/projection.h:30-33: polar_to_cartesian
fn polar_to_cartesian(r: f32, phi: f32) -> vec2f {
  return vec2f(r * cos(phi), r * sin(phi));
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
