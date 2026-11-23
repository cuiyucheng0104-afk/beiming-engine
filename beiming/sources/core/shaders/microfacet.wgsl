// SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: BSD-3-Clause
//
// GGX 微表面与 F82 菲涅耳：叶子函数，加上金属反射闭包的建立、求值与采样，照 Cycles（Blender v5.2.3）内核源码逐行移植。
// 纯函数，不带绑定；用到 util.wgsl 的工具函数与 ggx_tables.wgsl 的查找表，三个文件拼在一起编译。
// 闭包只移金属反射这一条路：GGX、F82-tint 菲涅耳、无薄膜、无折射、各向同性（alpha_x == alpha_y，所以只传一个 alpha）。
// Cycles 里闭包参数放在 MicrofacetBsdf 结构体里，这里一律改成显式参数：N、alpha（已 saturate）、f0、b（F82 的 B 项）、energy_scale。
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

// kernel/sample/mapping.h:21-41: sample_uniform_disk（同心圆映射）
fn sample_uniform_disk(rand: vec2f) -> vec2f {
  var phi: f32;
  var r: f32;
  let a = 2.0 * rand.x - 1.0;
  let b = 2.0 * rand.y - 1.0;

  if (a == 0.0 && b == 0.0) {
    return vec2f(0.0);
  }

  if (a * a > b * b) {
    r = a;
    phi = M_PI_4_F * (b / a);
  } else {
    r = b;
    phi = M_PI_2_F - M_PI_4_F * (a / b);
  }

  return polar_to_cartesian(r, phi);
}

// kernel/closure/bsdf_microfacet.h:230-261: microfacet_ggx_sample_vndf（Heitz 2018 的可见法线采样），wi 在局部坐标里
fn microfacet_ggx_sample_vndf(wi: vec3f, alpha_x: f32, alpha_y: f32, rand: vec2f) -> vec3f {
  let wi_ = normalize_ccl(vec3f(alpha_x * wi.x, alpha_y * wi.y, wi.z));

  let lensq = sqr(wi_.x) + sqr(wi_.y);
  var T1: vec3f;
  var T2: vec3f;
  if (lensq > 1e-7) {
    T1 = vec3f(-wi_.y, wi_.x, 0.0) * inversesqrtf(lensq);
    T2 = cross(wi_, T1);
  } else {
    T1 = vec3f(1.0, 0.0, 0.0);
    T2 = vec3f(0.0, 1.0, 0.0);
  }

  var t = sample_uniform_disk(rand);
  // mix(a, b, s) 照 util/math_base.h 写成 a + s * (b - a)
  let m = safe_sqrtf(1.0 - sqr(t.x));
  t.y = m + 0.5 * (1.0 + wi_.z) * (t.y - m);

  let H_ = to_global(disk_to_hemisphere(t), T1, T2, wi_);

  return normalize_ccl(vec3f(alpha_x * H_.x, alpha_y * H_.y, max(0.0, H_.z)));
}

// kernel/closure/bsdf_microfacet.h:676-679: roughness_is_almost_specular
fn roughness_is_almost_specular(alpha_x: f32, alpha_y: f32) -> bool {
  return (alpha_x * alpha_y) <= 2e-10;
}

// kernel/closure/bsdf_microfacet.h:335-430: microfacet_fresnel 的 F82_TINT 无薄膜分支（406 行）。
// 金属是 CLOSURE_BSDF_MICROFACET_GGX_ID：has_reflection 为真、has_transmission 为假，所以透射率恒为 0，
// 末尾乘的 (float)has_reflection 是 1，这里不写；cos_theta_t 只在折射时用，也不返回。
fn microfacet_fresnel_f82(cos_theta_i: f32, f0: vec3f, b: vec3f) -> vec3f {
  return fresnel_f82(cos_theta_i, f0, b);
}

// microfacet_ggx_preserve_energy 写进闭包的两项：energy_scale 和乘到闭包权重上的 darkening
struct EnergyPreservation {
  energy_scale: f32,
  darkening: vec3f,
}

// kernel/closure/bsdf_microfacet.h:432-485: microfacet_ggx_preserve_energy，GGX 反射（CLOSURE_BSDF_MICROFACET_GGX_ID）那一支。
// Cycles 把 darkening 乘进 bsdf->weight，并把 average(darkening) 乘进 sample_weight；这里返回 darkening 由调用方乘，
// sample_weight（多个闭包之间的选择概率）不移植。
fn microfacet_ggx_preserve_energy(N: vec3f, wi: vec3f, alpha: f32, Fss: vec3f) -> EnergyPreservation {
  let mu = dot(wi, N);
  let rough = sqrt(sqrt(alpha * alpha));

  let E = lookup_table_read_2D(rough, mu, TABLE_GGX_E, 32, 32);
  let E_avg = lookup_table_read(rough, TABLE_GGX_EAVG, 32);

  let missing_factor = ((1.0 - E) / E);
  let energy_scale = 1.0 + missing_factor;

  var darkening = vec3f(1.0);
  if (!all(Fss == vec3f(1.0))) {
    let Fms = Fss * E_avg / (vec3f(1.0) - Fss * (1.0 - E_avg));
    darkening = (vec3f(1.0) + Fms * missing_factor) / energy_scale;
  }
  return EnergyPreservation(energy_scale, darkening);
}

// 建立 F82-tint 金属闭包后，求值与采样要用的三项；weight 是闭包权重的乘子（初始权重为 1 时就是结果）
struct F82TintSetup {
  b: vec3f,
  energy_scale: f32,
  weight: vec3f,
}

// kernel/closure/bsdf_microfacet.h:1002-1023: bsdf_microfacet_setup_fresnel_f82_tint，接在 bsdf_microfacet_ggx_setup
// （1062-1072，energy_scale 置 1）之后。1018 行估反照率改 sample_weight 的那一步不移植，理由同上。
fn bsdf_microfacet_setup_fresnel_f82_tint(N: vec3f, wi: vec3f, alpha: f32, f0: vec3f, f82_tint: vec3f, preserve_energy: bool) -> F82TintSetup {
  var b = vec3f(0.0);
  if (!all(f82_tint == vec3f(1.0))) {
    b = fresnel_f82tint_B(f0, f82_tint);
  }

  var r = F82TintSetup(b, 1.0, vec3f(1.0));
  if (preserve_energy) {
    let e = microfacet_ggx_preserve_energy(N, wi, alpha, fresnel_f82_Fss(f0, b));
    r.energy_scale = e.energy_scale;
    r.weight = e.darkening;
  }
  return r;
}

// 求值结果（已含出射方向的余弦，即 BSDF·cos_NO）与概率密度（立体角测度）。common 是 WGSL 的保留字，Cycles 的变量 common 改叫 common_
struct MicrofacetEval {
  eval: vec3f,
  pdf: f32,
}

// kernel/closure/bsdf_microfacet.h:687-776: bsdf_microfacet_eval<GGX>，反射、各向同性、F82 那一条路。
// 金属下 pdf_reflect = average(reflectance) / average(reflectance + 0) 恒为 1（x/x 是精确的 1），lobe_pdf 也是 1，不写。
// Cycles 返回零时不写 *pdf；这里返回零时 pdf 也是 0。
fn bsdf_microfacet_eval_ggx(N: vec3f, wi: vec3f, wo: vec3f, alpha: f32, f0: vec3f, b: vec3f) -> MicrofacetEval {
  let zero = MicrofacetEval(vec3f(0.0), 0.0);
  let cos_NI = dot(N, wi);
  let cos_NO = dot(N, wo);

  let is_transmission = (cos_NO < 0.0);

  // 纯反射闭包不能有折射方向
  if ((cos_NI <= 0.0) || roughness_is_almost_specular(alpha, alpha) || is_transmission) {
    return zero;
  }

  var H = wi + wo;
  let inv_len_H = safe_divide(1.0, len_ccl(H));
  H *= inv_len_H;

  let cos_HI = dot(H, wi);
  let reflectance = microfacet_fresnel_f82(cos_HI, f0, b);

  if (all(reflectance == vec3f(0.0))) {
    return zero;
  }

  let cos_NH = dot(N, H);
  let alpha2 = alpha * alpha;
  let D = bsdf_D_ggx(alpha2, cos_NH);
  let lambdaI = bsdf_lambda_ggx(alpha2, cos_NI);
  let lambdaO = bsdf_lambda_ggx(alpha2, cos_NO);

  let common_ = D / cos_NI * 0.25;

  return MicrofacetEval(reflectance * common_ / (1.0 + lambdaO + lambdaI), common_ / (1.0 + lambdaI));
}

// kernel/closure/bsdf_microfacet.h:1106-1114: bsdf_microfacet_ggx_eval，求值乘 energy_scale，概率密度不乘
fn bsdf_microfacet_ggx_eval(N: vec3f, wi: vec3f, wo: vec3f, alpha: f32, f0: vec3f, b: vec3f, energy_scale: f32) -> MicrofacetEval {
  let r = bsdf_microfacet_eval_ggx(N, wi, wo, alpha, f0, b);
  return MicrofacetEval(energy_scale * r.eval, r.pdf);
}

// 采样结果。label 为 LABEL_NONE 时其余全是 0。sampled_roughness（恒为 (alpha, alpha)）与 eta（恒为 1）不返回
struct MicrofacetSample {
  label: i32,
  eval: vec3f,
  wo: vec3f,
  pdf: f32,
}

// kernel/closure/bsdf_microfacet.h:778-921: bsdf_microfacet_sample<GGX>，反射、各向同性、F82 那一条路。
// 只用两个随机数：rand.z 只用来在反射与折射之间选（do_refract = rand.z >= pdf_reflect），金属 pdf_reflect 恒为 1，永远选反射。
fn bsdf_microfacet_sample_ggx(N: vec3f, Ng: vec3f, wi: vec3f, alpha: f32, f0: vec3f, b: vec3f, rand: vec2f) -> MicrofacetSample {
  let none = MicrofacetSample(LABEL_NONE, vec3f(0.0), vec3f(0.0), 0.0);
  let cos_NI = dot(N, wi);
  if (cos_NI <= 0.0) {
    return none;
  }

  let m_singular = roughness_is_almost_specular(alpha, alpha);

  var H: vec3f;
  var local_H: vec3f;
  if (m_singular) {
    H = N;
  } else {
    let XY = make_orthonormals(N);
    let local_I = vec3f(dot(XY.a, wi), dot(XY.b, wi), cos_NI);
    local_H = microfacet_ggx_sample_vndf(local_I, alpha, alpha, rand);
    H = to_global(local_H, XY.a, XY.b, N);
  }
  let cos_HI = dot(H, wi);

  let reflectance = microfacet_fresnel_f82(cos_HI, f0, b);
  if (all(reflectance == vec3f(0.0))) {
    return none;
  }

  let wo = 2.0 * cos_HI * H - wi;

  // 出射方向对着色法线和几何法线都要在上半球；求值时不查几何法线（Cycles 有意如此，见源码 856-861 行的注释）
  let cos_NO = dot(N, wo);
  let cos_NgO = dot(Ng, wo);
  if (cos_NgO < 0.0 || cos_NO < 0.0) {
    return none;
  }

  var eval = reflectance;
  var pdf = 1.0;

  if (m_singular) {
    // Cycles 原注释：给 MIS 用的一个大数
    pdf *= 1e6;
    eval *= 1e6;
  } else {
    let alpha2 = alpha * alpha;
    let cos_NH = local_H.z;
    let D = bsdf_D_ggx(alpha2, cos_NH);
    let lambdaO = bsdf_lambda_ggx(alpha2, cos_NO);
    let lambdaI = bsdf_lambda_ggx(alpha2, cos_NI);

    let common_ = D / cos_NI * 0.25;

    pdf *= common_ / (1.0 + lambdaI);
    eval *= common_ / (1.0 + lambdaI + lambdaO);
  }

  return MicrofacetSample(LABEL_REFLECT | select(LABEL_GLOSSY, LABEL_SINGULAR, m_singular), eval, wo, pdf);
}

// kernel/closure/bsdf_microfacet.h:1116-1131: bsdf_microfacet_ggx_sample，求值乘 energy_scale，概率密度不乘
fn bsdf_microfacet_ggx_sample(N: vec3f, Ng: vec3f, wi: vec3f, alpha: f32, f0: vec3f, b: vec3f, energy_scale: f32, rand: vec2f) -> MicrofacetSample {
  var r = bsdf_microfacet_sample_ggx(N, Ng, wi, alpha, f0, b, rand);
  r.eval *= energy_scale;
  return r;
}
