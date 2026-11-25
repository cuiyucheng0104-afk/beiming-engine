// SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: BSD-3-Clause
//
// GGX 微表面与 F82 菲涅耳：叶子函数，加上金属反射闭包的建立、求值与采样，照 Cycles（Blender v5.2.3）内核源码逐行移植；
// 文件后半是原理化 BSDF 非金属那一半的闭包（电介质高光、漫反射）与发光值，来源同为 BSD-3-Clause 的文件
// （kernel/closure/bsdf_microfacet.h、bsdf_util.h、bsdf_diffuse.h、emissive.h、kernel/sample/mapping.h）。
// 纯函数，不带绑定；用到 util.wgsl 的工具函数与 ggx_tables.wgsl 的查找表，与同目录的 WGSL 文件拼在一起编译。
// 广义 Schlick 的两张表在存储缓冲里：偏移 table_ggx_gen_schlick_ior_s()、table_ggx_gen_schlick_s() 由引入的着色器给（见 util.wgsl）。
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

// ------------------------------------------------------------------------------------------------
// 下面是原理化 BSDF 非金属那一半要的函数：电介质的菲涅耳与 F0、广义 Schlick 型电介质高光的建立、求值与采样、
// 反照率估计、层间权重、漫反射、发光值、滤光泽。照 Cycles（Blender v5.2.3）逐行移植，路是 kernel/svm/closure.h 的
// svm_node_closure_bsdf 原理化分支里「无清漆、无光泽、无次表面、无透射、无薄膜、各向同性、漫反射粗糙度 0」那一条。
// 电介质高光是 CLOSURE_BSDF_MICROFACET_GGX_ID 加 FRESNEL_GENERALIZED_SCHLICK：只有反射（has_reflection 为真、
// has_transmission 为假），所以透射率乘 0、pdf_reflect 恒为 1。广义 Schlick 的参数照 Cycles 摊成显式参数：ior、f0、f90、
// exponent、reflection_tint、transmission_tint。

// kernel/closure/bsdf_util.h:47-92: fresnel_dielectric_polarized（r_cos_phi 为空；r_cos_theta_t 只在折射时用，不返回）。
// 返回 s、p 两个偏振方向的反射率
fn fresnel_dielectric_polarized(cos_theta_i_in: f32, eta: f32) -> vec2f {
  let eta_cos_theta_t_sq = sqr(eta) - (1.0 - sqr(cos_theta_i_in));
  if (eta_cos_theta_t_sq <= 0.0) {
    // 全反射
    return vec2f(1.0);
  }

  let cos_theta_i = abs(cos_theta_i_in);
  let cos_theta_t = -safe_sqrtf(eta_cos_theta_t_sq) / eta;

  let r_s = (cos_theta_i + eta * cos_theta_t) / (cos_theta_i - eta * cos_theta_t);
  let r_p = (cos_theta_t + eta * cos_theta_i) / (eta * cos_theta_i - cos_theta_t);

  return vec2f(sqr(r_s), sqr(r_p));
}

// kernel/closure/bsdf_util.h:94-100: fresnel_dielectric（非偏振，average(float2) = (x + y)·(1/2)）。
// 内核里上游另有一个同名的 fresnel_dielectric（closure.wgsl，上游顶替的玻璃用），所以这里带 _ccl 后缀
fn fresnel_dielectric_ccl(cos_theta_i: f32, eta: f32) -> f32 {
  let f = fresnel_dielectric_polarized(cos_theta_i, eta);
  return (f.x + f.y) * (1.0 / 2.0);
}

// kernel/closure/bsdf_util.h:131-138: fresnel_dielectric_Fss
fn fresnel_dielectric_Fss(eta: f32) -> f32 {
  if (eta < 1.0) {
    return 0.997118 + eta * (0.1014 - eta * (0.965241 + eta * 0.130607));
  }
  return (eta - 1.0) / (4.08567 + 1.00071 * eta);
}

// kernel/closure/bsdf_util.h:284-288: ior_from_F0
fn ior_from_F0(f0: f32) -> f32 {
  let sqrt_f0 = sqrt(clamp(f0, 0.0, 0.99));
  return (1.0 + sqrt_f0) / (1.0 - sqrt_f0);
}

// kernel/closure/bsdf_util.h:290-293: F0_from_ior
fn F0_from_ior(ior: f32) -> f32 {
  return sqr((ior - 1.0) / (ior + 1.0));
}

// kernel/closure/bsdf_util.h:437-444: closure_layering_weight
fn closure_layering_weight(layer_albedo: vec3f, weight: vec3f) -> vec3f {
  return weight * saturate(1.0 - reduce_max(safe_divide_color(layer_albedo, weight)));
}

// kernel/closure/bsdf_util.h:319-395: ensure_valid_specular_reflection。着色法线 N 让镜面反射方向落到几何面以下时，
// 把 N 往几何法线 Ng 拧，刚好让反射方向抬到门槛以上。I 指向来路，与 Ng 在同一侧（Cycles 在这里断言 dot(I, Ng) ≥ 0）
fn ensure_valid_specular_reflection(Ng: vec3f, I: vec3f, N: vec3f) -> vec3f {
  let R = 2.0 * dot(N, I) * N - I;

  let Iz = dot(I, Ng);

  // 反射方向至少可以与入射方向一样贴地
  let threshold = min(0.9 * Iz, 0.01);
  if (dot(Ng, R) >= threshold) {
    return N;
  }

  // 以 Ng 为 Z 轴、N 落在 X-Z 平面里的局部坐标：X 是 N 垂直于 Ng 的分量归一化
  let X = safe_normalize_fallback(N - dot(N, Ng) * Ng, N);

  // 解 4·a·N'.z⁴ − 2·b·N'.z² + c = 0，四个根里只有一个合用（推导见 Cycles 原文的注释）
  let Ix = dot(I, X);

  let a = sqr(Ix) + sqr(Iz);
  let b = 2.0 * (a + Iz * threshold);
  let c = sqr(threshold + Iz);

  // Ix 与 (t + I.z·(1 − 2·N'.z²)) 要同号，按 Ix 的符号取根
  var Nz2: f32;
  if (Ix < 0.0) {
    Nz2 = 0.25 * (b + safe_sqrtf(sqr(b) - 4.0 * a * c)) / a;
  } else {
    Nz2 = 0.25 * (b - safe_sqrtf(sqr(b) - 4.0 * a * c)) / a;
  }

  let Nx = safe_sqrtf(1.0 - Nz2);
  let Nz = safe_sqrtf(Nz2);

  return Nx * X + Nz * Ng;
}

// kernel/closure/bsdf_util.h:397-409: maybe_ensure_valid_specular_reflection。Cycles 读着色点的三样：凹凸校正标志
// SD_USE_BUMP_MAP_CORRECTION、图元是不是曲线、几何法线与来路方向。这里标志视为开（场景包里没有这个材质参数，取 Blender
// 的默认：材质属性 use_bump_map_correction 默认为真），没有曲线，几何法线与来路方向作参数传进来
fn maybe_ensure_valid_specular_reflection(Ng: vec3f, wi: vec3f, N: vec3f) -> vec3f {
  if (all(Ng == N)) {
    return N;
  }
  return ensure_valid_specular_reflection(Ng, wi, N);
}

// 广义 Schlick 的菲涅耳：反射率与透射率
struct FresnelRT {
  reflectance: vec3f,
  transmittance: vec3f,
}

// kernel/closure/bsdf_microfacet.h:264-333: generalized_schlick_fresnel，无薄膜（thickness ≤ THINFILM_THICKNESS_CUTOFF）的两支。
// mix(a, b, s) 照 util/math_float3.h 写成 a + s·(b − a)
fn generalized_schlick_fresnel(ior: f32, cos_theta_i: f32, f0: vec3f, f90: vec3f, exponent: f32, reflection_tint: vec3f, transmission_tint: vec3f) -> FresnelRT {
  var F: vec3f;
  if (exponent < 0.0) {
    // 用真菲涅耳曲线定 F0 到 F90 之间的插值（原理化 BSDF 用这一支）
    let F_real = fresnel_dielectric_ccl(cos_theta_i, ior);
    let F0_real = F0_from_ior(ior);
    let s = saturate(inverse_lerp(F0_real, 1.0, F_real));
    F = f0 + s * (f90 - f0);
  } else {
    // 一般的广义 Schlick 项
    let cos_theta_t_sq = 1.0 - (1.0 - sqr(cos_theta_i)) / sqr(ior);
    if (cos_theta_t_sq <= 0.0) {
      // 全反射
      return FresnelRT(reflection_tint, vec3f(0.0));
    }
    let cos_theta_t = sqrt(cos_theta_t_sq);
    // 从折射率高的一侧进折射率低的一侧时用折射角
    let fresnel_angle = select(cos_theta_i, cos_theta_t, ior < 1.0);
    let s = pow(1.0 - fresnel_angle, exponent);
    F = f0 + s * (f90 - f0);
  }
  return FresnelRT(F * reflection_tint, (vec3f(1.0) - F) * transmission_tint);
}

// kernel/closure/bsdf_microfacet.h:335-430: microfacet_fresnel 的 GENERALIZED_SCHLICK 分支（396 行），闭包是
// CLOSURE_BSDF_MICROFACET_GGX_ID：末尾的 has_reflection 是 1、has_transmission 是 0，只返回反射率
fn microfacet_fresnel_generalized_schlick(cos_theta_i: f32, ior: f32, f0: vec3f, f90: vec3f, exponent: f32, reflection_tint: vec3f, transmission_tint: vec3f) -> vec3f {
  return generalized_schlick_fresnel(ior, cos_theta_i, f0, f90, exponent, reflection_tint, transmission_tint).reflectance;
}

// kernel/closure/bsdf_microfacet.h:498-599: bsdf_microfacet_estimate_albedo 的 GENERALIZED_SCHLICK 分支（无薄膜），各向同性
fn bsdf_microfacet_estimate_albedo_generalized_schlick(N: vec3f, wi: vec3f, alpha: f32, ior: f32, f0: vec3f, f90: vec3f, exponent: f32, reflection_tint: vec3f, transmission_tint: vec3f, eval_reflection: bool, eval_transmission: bool) -> vec3f {
  let cos_NI = dot(wi, N);
  let rough = sqrt(sqrt(alpha * alpha));
  var s: f32;
  if (exponent < 0.0) {
    let z = sqrt(abs((ior - 1.0) / (ior + 1.0)));
    s = lookup_table_read_3D(rough, cos_NI, z, table_ggx_gen_schlick_ior_s(), 16, 16, 16);
  } else {
    let z = 1.0 / (0.2 * exponent + 1.0);
    s = lookup_table_read_3D(rough, cos_NI, z, table_ggx_gen_schlick_s(), 16, 16, 16);
  }
  let F = f0 + s * (f90 - f0);
  let reflectance = F * reflection_tint * f32(eval_reflection);
  let transmittance = (vec3f(1.0) - F) * transmission_tint * f32(eval_transmission);
  return reflectance + transmittance;
}

// kernel/closure/bsdf_microfacet.h:498-599: bsdf_microfacet_estimate_albedo 的 F82_TINT 分支（无薄膜），各向同性
fn bsdf_microfacet_estimate_albedo_f82_tint(N: vec3f, wi: vec3f, alpha: f32, f0: vec3f, eval_reflection: bool) -> vec3f {
  let cos_NI = dot(wi, N);
  let rough = sqrt(sqrt(alpha * alpha));
  let s = lookup_table_read_3D(rough, cos_NI, 0.5, table_ggx_gen_schlick_s(), 16, 16, 16);
  return (f0 + s * (vec3f(1.0) - f0)) * f32(eval_reflection);
}

// 建立广义 Schlick 电介质高光后，求值与采样要用的三项：saturate 过的 f0、energy_scale、乘到闭包权重上的 darkening
struct GeneralizedSchlickSetup {
  f0: vec3f,
  energy_scale: f32,
  weight: vec3f,
}

// kernel/closure/bsdf_microfacet.h:963-1000: bsdf_microfacet_setup_fresnel_generalized_schlick，接在 bsdf_microfacet_ggx_setup
// （energy_scale 置 1）之后。Cycles 在这里原地改 sample_weight 两次（乘估出来的反照率的平均、乘 darkening 的平均），
// 这里不收 sample_weight：调用方照同样的次序乘（closure.wgsl 的 principled_setup）
fn bsdf_microfacet_setup_fresnel_generalized_schlick(N: vec3f, wi: vec3f, alpha: f32, ior: f32, f0_in: vec3f, f90: vec3f, exponent: f32, reflection_tint: vec3f, transmission_tint: vec3f, preserve_energy: bool) -> GeneralizedSchlickSetup {
  let f0 = saturate(f0_in);
  var r = GeneralizedSchlickSetup(f0, 1.0, vec3f(1.0));
  if (preserve_energy) {
    var Fss = vec3f(1.0);
    // 多重反射的菲涅耳只对反射叶做
    if (all(transmission_tint == vec3f(0.0))) {
      var s: f32;
      if (exponent < 0.0) {
        let F0 = F0_from_ior(ior);
        let Fss_real = fresnel_dielectric_Fss(ior);
        s = saturate(inverse_lerp(F0, 1.0, Fss_real));
      } else {
        // 2·cosI·(1 − cosI)^exponent 在 0 到 1 上的积分
        s = 2.0 / ((exponent + 3.0) * exponent + 2.0);
      }
      Fss = reflection_tint * (f0 + s * (f90 - f0));
    } else {
      Fss = transmission_tint;
    }
    let e = microfacet_ggx_preserve_energy(N, wi, alpha, Fss);
    r.energy_scale = e.energy_scale;
    r.weight = e.darkening;
  }
  return r;
}

// kernel/closure/bsdf_microfacet.h:687-776: bsdf_microfacet_eval<GGX>，反射、各向同性、广义 Schlick 那一条路。
// pdf_reflect = average(reflectance) / average(reflectance + 0) 恒为 1，lobe_pdf 也是 1，不写。返回零时 pdf 也是 0
fn bsdf_microfacet_eval_ggx_generalized_schlick(N: vec3f, wi: vec3f, wo: vec3f, alpha: f32, ior: f32, f0: vec3f, f90: vec3f, exponent: f32, reflection_tint: vec3f, transmission_tint: vec3f) -> MicrofacetEval {
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
  let reflectance = microfacet_fresnel_generalized_schlick(cos_HI, ior, f0, f90, exponent, reflection_tint, transmission_tint);

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
fn bsdf_microfacet_ggx_eval_generalized_schlick(N: vec3f, wi: vec3f, wo: vec3f, alpha: f32, ior: f32, f0: vec3f, f90: vec3f, exponent: f32, reflection_tint: vec3f, transmission_tint: vec3f, energy_scale: f32) -> MicrofacetEval {
  let r = bsdf_microfacet_eval_ggx_generalized_schlick(N, wi, wo, alpha, ior, f0, f90, exponent, reflection_tint, transmission_tint);
  return MicrofacetEval(energy_scale * r.eval, r.pdf);
}

// kernel/closure/bsdf_microfacet.h:778-921: bsdf_microfacet_sample<GGX>，反射、各向同性、广义 Schlick 那一条路。
// pdf_reflect 恒为 1，do_refract = rand.z >= 1 永远为假，所以只用两个随机数
fn bsdf_microfacet_sample_ggx_generalized_schlick(N: vec3f, Ng: vec3f, wi: vec3f, alpha: f32, ior: f32, f0: vec3f, f90: vec3f, exponent: f32, reflection_tint: vec3f, transmission_tint: vec3f, rand: vec2f) -> MicrofacetSample {
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

  let reflectance = microfacet_fresnel_generalized_schlick(cos_HI, ior, f0, f90, exponent, reflection_tint, transmission_tint);
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
fn bsdf_microfacet_ggx_sample_generalized_schlick(N: vec3f, Ng: vec3f, wi: vec3f, alpha: f32, ior: f32, f0: vec3f, f90: vec3f, exponent: f32, reflection_tint: vec3f, transmission_tint: vec3f, energy_scale: f32, rand: vec2f) -> MicrofacetSample {
  var r = bsdf_microfacet_sample_ggx_generalized_schlick(N, Ng, wi, alpha, ior, f0, f90, exponent, reflection_tint, transmission_tint, rand);
  r.eval *= energy_scale;
  return r;
}

// kernel/closure/bsdf_microfacet.h:1098-1104: bsdf_microfacet_blur（Cycles 拿 alpha 直接与「粗糙度」取大，照搬）
fn bsdf_microfacet_blur(alpha_x: f32, alpha_y: f32, roughness: f32) -> vec2f {
  return vec2f(max(roughness, alpha_x), max(roughness, alpha_y));
}

// 采样一个立体角方向的结果：方向与立体角概率密度
struct CosHemisphereSample {
  wo: vec3f,
  pdf: f32,
}

// kernel/sample/mapping.h:71-84: sample_cos_hemisphere
fn sample_cos_hemisphere(N: vec3f, rand_in: vec2f) -> CosHemisphereSample {
  let rand = sample_uniform_disk(rand_in);
  let costheta = safe_sqrtf(1.0 - dot(rand, rand));

  let TB = make_orthonormals(N);
  return CosHemisphereSample(rand.x * TB.a + rand.y * TB.b + costheta * N, costheta * M_1_PI_F);
}

// kernel/closure/bsdf_diffuse.h:38-49: bsdf_diffuse_eval（求值已含余弦）
fn bsdf_diffuse_eval(N: vec3f, wo: vec3f) -> MicrofacetEval {
  let cosNO = max(dot(N, wo), 0.0) * M_1_PI_F;
  return MicrofacetEval(vec3f(cosNO), cosNO);
}

// kernel/closure/bsdf_diffuse.h:51-71: bsdf_diffuse_sample。几何法线下面的方向：标签照样是 REFLECT | DIFFUSE，
// 求值与概率密度为 0，方向照写（Cycles 也写了 *wo）
fn bsdf_diffuse_sample(N: vec3f, Ng: vec3f, rand: vec2f) -> MicrofacetSample {
  let s = sample_cos_hemisphere(N, rand);
  if (dot(Ng, s.wo) > 0.0) {
    return MicrofacetSample(LABEL_REFLECT | LABEL_DIFFUSE, vec3f(s.pdf), s.wo, s.pdf);
  }
  return MicrofacetSample(LABEL_REFLECT | LABEL_DIFFUSE, vec3f(0.0), s.wo, 0.0);
}

// kernel/closure/emissive.h:43-47: emissive_pdf（双面：几何法线的哪一侧都发光）
fn emissive_pdf(Ng: vec3f, wi: vec3f) -> f32 {
  let cosNI = abs(dot(Ng, wi));
  return select(0.0, 1.0, cosNI > 0.0);
}

// kernel/closure/emissive.h:58-63: emissive_simple_eval
fn emissive_simple_eval(Ng: vec3f, wi: vec3f) -> vec3f {
  return vec3f(emissive_pdf(Ng, wi));
}
