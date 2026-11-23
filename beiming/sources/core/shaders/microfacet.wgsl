// SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: BSD-3-Clause
//
// GGX 微表面与 F82 菲涅耳的叶子函数，照 Cycles（Blender v5.2.3）内核源码逐行移植。纯函数，不带绑定。
// Cycles 的模板参数 MicrofacetType 在这里固定为 GGX，函数名带 _ggx；同名的 float 与 Spectrum 重载分成两个名字，
// Spectrum（三通道）用 vec3f，float 版带 _f32。
// 移植时要守住的一条：Cycles 的 mix(a, b, t) 是 a + t * (b - a)，与 WGSL 内建 mix 的舍入不同，所以照原式展开。

// util/math_base.h: M_PI_F、M_1_PI_F
const M_PI_F: f32 = 3.1415926535897932;
const M_1_PI_F: f32 = 0.3183098861837067;

// util/math_base.h: sqr(float)
fn sqr(a: f32) -> f32 {
  return a * a;
}

// kernel/closure/bsdf_microfacet.h: bsdf_lambda_from_sqr_alpha_tan_n<GGX>
fn bsdf_lambda_from_sqr_alpha_tan_n_ggx(sqr_alpha_tan_n: f32) -> f32 {
  return 0.5 * (sqrt(1.0 + sqr_alpha_tan_n) - 1.0);
}

// kernel/closure/bsdf_microfacet.h: bsdf_lambda<GGX>
fn bsdf_lambda_ggx(alpha2: f32, cos_N: f32) -> f32 {
  return bsdf_lambda_from_sqr_alpha_tan_n_ggx(alpha2 * max(1.0 / sqr(cos_N) - 1.0, 0.0));
}

// kernel/closure/bsdf_microfacet.h: bsdf_aniso_lambda<GGX>
fn bsdf_aniso_lambda_ggx(alpha_x: f32, alpha_y: f32, V: vec3f) -> f32 {
  let sqr_alpha_tan_n = (sqr(alpha_x * V.x) + sqr(alpha_y * V.y)) / sqr(V.z);
  return bsdf_lambda_from_sqr_alpha_tan_n_ggx(sqr_alpha_tan_n);
}

// kernel/closure/bsdf_microfacet.h: bsdf_G<GGX>(alpha2, cos_N)，单向遮蔽
fn bsdf_G_mono_ggx(alpha2: f32, cos_N: f32) -> f32 {
  return 1.0 / (1.0 + bsdf_lambda_ggx(alpha2, cos_N));
}

// kernel/closure/bsdf_microfacet.h: bsdf_G<GGX>(alpha2, cos_NI, cos_NO)，合并遮蔽
fn bsdf_G_combined_ggx(alpha2: f32, cos_NI: f32, cos_NO: f32) -> f32 {
  return 1.0 / (1.0 + bsdf_lambda_ggx(alpha2, cos_NI) + bsdf_lambda_ggx(alpha2, cos_NO));
}

// kernel/closure/bsdf_microfacet.h: bsdf_D<GGX>，法线分布
fn bsdf_D_ggx(alpha2: f32, cos_NH: f32) -> f32 {
  let cos_NH2 = min(sqr(cos_NH), 1.0);
  let one_minus_cos_NH2 = 1.0 - cos_NH2;
  return alpha2 / (M_PI_F * sqr(one_minus_cos_NH2 + alpha2 * cos_NH2));
}

// kernel/closure/bsdf_microfacet.h: bsdf_aniso_D<GGX>
fn bsdf_aniso_D_ggx(alpha_x: f32, alpha_y: f32, H: vec3f) -> f32 {
  let h = H / vec3f(alpha_x, alpha_y, 1.0);
  let alpha2 = alpha_x * alpha_y;
  return M_1_PI_F / (alpha2 * sqr(dot(h, h)));
}

// kernel/closure/bsdf_util.h: fresnel_f82_Fss(Spectrum F0, Spectrum B)
fn fresnel_f82_Fss(F0: vec3f, B: vec3f) -> vec3f {
  return F0 + (1.0 / 21.0) * (vec3f(1.0) - F0) - B * (1.0 / 126.0);
}

// kernel/closure/bsdf_util.h: fresnel_f82tint_B(Spectrum F0, Spectrum tint)
fn fresnel_f82tint_B(F0: vec3f, tint: vec3f) -> vec3f {
  let f: f32 = 6.0 / 7.0;
  let f5 = sqr(sqr(f)) * f;
  let F_schlick = F0 + f5 * (vec3f(1.0) - F0);
  return F_schlick * (7.0 / (f5 * f)) * (vec3f(1.0) - tint);
}

// kernel/closure/bsdf_util.h: fresnel_f82_B(Spectrum F0, Spectrum F82)
fn fresnel_f82_B(F0: vec3f, F82: vec3f) -> vec3f {
  let f: f32 = 6.0 / 7.0;
  let f5 = sqr(sqr(f)) * f;
  let F_schlick = F0 + f5 * (vec3f(1.0) - F0);
  return (7.0 / (f5 * f)) * (F_schlick - F82);
}

// kernel/closure/bsdf_util.h: fresnel_f82_B(float F0, float F82)
fn fresnel_f82_B_f32(F0: f32, F82: f32) -> f32 {
  let f: f32 = 6.0 / 7.0;
  let f5 = sqr(sqr(f)) * f;
  let F_schlick = F0 + f5 * (1.0 - F0);
  return (7.0 / (f5 * f)) * (F_schlick - F82);
}

// kernel/closure/bsdf_util.h: fresnel_f82(float cosi, Spectrum F0, Spectrum B)
fn fresnel_f82(cosi: f32, F0: vec3f, B: vec3f) -> vec3f {
  let s = saturate(1.0 - cosi);
  let s5 = sqr(sqr(s)) * s;
  let F_schlick = F0 + s5 * (vec3f(1.0) - F0);
  return saturate(F_schlick - B * cosi * s5 * s);
}

// kernel/closure/bsdf_util.h: fresnel_f82(float cosi, float F0, float B)
fn fresnel_f82_f32(cosi: f32, F0: f32, B: f32) -> f32 {
  let s = saturate(1.0 - cosi);
  let s5 = sqr(sqr(s)) * s;
  let F_schlick = F0 + s5 * (1.0 - F0);
  return clamp(F_schlick - B * cosi * s5 * s, 0.0, 1.0);
}
