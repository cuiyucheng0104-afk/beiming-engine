// 标准答案程序：直接包含 Cycles 内核的真实头文件、调用真实函数（不抄函数体），按函数标识分发。
// 用法：ref <函数标识> < 输入 > 输出。输入是小端 float32 流，每组 n_in 个；输出每组 n_out 个。
// 退出码：0 成功；1 函数标识不认识；2 最后一组不完整。
// 要闭包结构体或查找表的函数，在这里填好真的 MicrofacetBsdf、FresnelF82Tint 和内核全局数据，再调真函数；面光填真的 KernelLight 与 Ray。
#include "kernel/device/cpu/compat.h"
#include "kernel/device/cpu/globals.h"
#include "kernel/types.h"
#include "kernel/closure/bsdf.h"
#include "kernel/closure/bsdf_diffuse.h"
#include "kernel/closure/bsdf_microfacet.h"
#include "kernel/closure/emissive.h"
#include "kernel/light/area.h"
#include "kernel/sample/mapping.h"
#include "util/projection.h"
#include "util/transform.h"

// 宿主侧的预计算表原文（static const float 数组），Cycles 的 scene/shader.cpp 也是这样包含它的
#include "scene/shader.tables"

#include <cstdio>
#include <cstring>
#include <vector>

using namespace ccl;

struct Entry {
  const char *id;
  int n_in, n_out;
  void (*fn)(const float *i, float *o);
};

static float2 get2(const float *i) { return make_float2(i[0], i[1]); }
static float3 get3(const float *i) { return make_float3(i[0], i[1], i[2]); }
static void put2(float *o, const float2 v) { o[0] = v.x; o[1] = v.y; }
static void put3(float *o, const float3 v) { o[0] = v.x; o[1] = v.y; o[2] = v.z; }

/* 内核全局数据：只填查表用到的 lookup_table 与 data.tables。表按 scene/tables.cpp 的 add_table 那样原样拷进一个
 * float 数组，偏移写进 data.tables（Cycles 会按块对齐偏移，偏移取多少不影响查到的值）。
 * 不构造整个 ThreadKernelGlobalsCPU：它的构造函数和成员（性能统计、Cycles 的分配器）要链接宿主库。用到的两个成员都是
 * 平凡类型，零初始化的存储就是它们的默认值。 */
static std::vector<float> lut;
alignas(ThreadKernelGlobalsCPU) static unsigned char kg_storage[sizeof(ThreadKernelGlobalsCPU)];
static KernelGlobals kg = reinterpret_cast<const ThreadKernelGlobalsCPU *>(kg_storage);

static int add_table(const float *data, const size_t size)
{
  const int offset = int(lut.size());
  lut.insert(lut.end(), data, data + size);
  return offset;
}

static void init_tables()
{
  ThreadKernelGlobalsCPU *g = reinterpret_cast<ThreadKernelGlobalsCPU *>(kg_storage);
  g->data.tables.ggx_E = add_table(table_ggx_E, 1024);
  g->data.tables.ggx_Eavg = add_table(table_ggx_Eavg, 32);
  g->data.tables.ggx_gen_schlick_ior_s = add_table(table_ggx_gen_schlick_ior_s, 4096);
  g->data.tables.ggx_gen_schlick_s = add_table(table_ggx_gen_schlick_s, 4096);
  g->lookup_table.data = lut.data();
  g->lookup_table.width = int(lut.size());
}

/* 金属闭包：照 Metallic 节点的 F82 分支（kernel/svm/closure.h）那样，先 bsdf_microfacet_ggx_setup，ior 取 1，
 * 再挂上 F82-tint 菲涅耳（无薄膜）。b 直接给，相当于 bsdf_microfacet_setup_fresnel_f82_tint 已经算过它。 */
struct Metal {
  ShaderClosure sc = {};
  FresnelF82Tint fresnel = {};
  MicrofacetBsdf *bsdf = (MicrofacetBsdf *)&sc;

  Metal(const float3 N, const float alpha)
  {
    bsdf->N = N;
    bsdf->weight = one_spectrum();
    bsdf->sample_weight = 1.0f;
    bsdf->alpha_x = bsdf->alpha_y = alpha;
    bsdf->ior = 1.0f;
    bsdf_microfacet_ggx_setup(bsdf);
  }
  Metal(const float3 N, const float alpha, const float3 f0, const float3 b, const float energy_scale) : Metal(N, alpha)
  {
    fresnel.f0 = f0;
    fresnel.b = b;
    bsdf->fresnel_type = MicrofacetFresnel::F82_TINT;
    bsdf->fresnel = &fresnel;
    bsdf->energy_scale = energy_scale;
  }
};

/* 电介质高光：照原理化 BSDF 的高光分支（kernel/svm/closure.h）那样，先 bsdf_microfacet_ggx_setup（只有反射），
 * 再挂上广义 Schlick 菲涅耳（无薄膜）。输入依次是 ior、f0、f90、exponent、reflection_tint、transmission_tint（14 个 float） */
struct Dielectric {
  ShaderClosure sc = {};
  FresnelGeneralizedSchlick fresnel = {};
  MicrofacetBsdf *bsdf = (MicrofacetBsdf *)&sc;

  Dielectric(const float3 N, const float alpha, const float *i, const float energy_scale = 1.0f)
  {
    bsdf->N = N;
    bsdf->weight = one_spectrum();
    bsdf->sample_weight = 1.0f;
    bsdf->alpha_x = bsdf->alpha_y = alpha;
    bsdf->ior = i[0];
    bsdf_microfacet_ggx_setup(bsdf);
    fresnel.f0 = get3(i + 1);
    fresnel.f90 = get3(i + 4);
    fresnel.exponent = i[7];
    fresnel.reflection_tint = get3(i + 8);
    fresnel.transmission_tint = get3(i + 11);
    bsdf->fresnel_type = MicrofacetFresnel::GENERALIZED_SCHLICK;
    bsdf->fresnel = &fresnel;
    bsdf->energy_scale = energy_scale;
  }
};

/* 漫反射闭包：bsdf_diffuse_setup 只填 N 与 type */
static ShaderClosure diffuse(const float3 N)
{
  ShaderClosure sc = {};
  sc.N = N;
  sc.type = CLOSURE_BSDF_DIFFUSE_ID;
  sc.weight = one_spectrum();
  sc.sample_weight = 1.0f;
  return sc;
}

/* 求值：返回零时 Cycles 不写 *pdf，这里预置 0 */
static void eval_out(float *o, const Spectrum eval, const float pdf)
{
  put3(o, eval);
  o[3] = pdf;
}

/* 采样：返回 LABEL_NONE 时 Cycles 不保证 eval、wo、pdf 有意义（半球检查不过时 wo 已经写了），这里一律写 0 */
static void sample_out(float *o, const int label, const Spectrum eval, const float3 wo, const float pdf)
{
  o[0] = float(label);
  put3(o + 1, label == LABEL_NONE ? zero_spectrum() : eval);
  put3(o + 4, label == LABEL_NONE ? zero_float3() : wo);
  o[7] = label == LABEL_NONE ? 0.0f : pdf;
}

/* 矩形面光：输入依次是 co、axis_u、len_u、axis_v、len_v、dir、invarea（15 个 float），无聚拢（normalize_spread = 0），
 * tan_half_spread 只在椭圆那一支读，取 0。KernelLight 里有联合体，先整块清零 */
static KernelLight area_light(const float *i)
{
  KernelLight k;
  memset(&k, 0, sizeof(k));
  k.type = LIGHT_AREA;
  k.co = get3(i);
  k.area.axis_u = get3(i + 3);
  k.area.len_u = i[6];
  k.area.axis_v = get3(i + 7);
  k.area.len_v = i[10];
  k.area.dir = get3(i + 11);
  k.area.invarea = i[14];
  return k;
}

/* 采样：返回 false 时 Cycles 只写了一部分字段（ls->P 已是灯心），这里一律写 0 */
static void light_sample_out(float *o, const bool ok, const LightSample &ls)
{
  o[0] = float(ok);
  put3(o + 1, ok ? float3(ls.P) : zero_float3());
  put3(o + 4, ok ? ls.D : zero_float3());
  o[7] = ok ? ls.t : 0.0f;
  o[8] = ok ? ls.pdf : 0.0f;
  o[9] = ok ? ls.eval_fac : 0.0f;
}

static const Entry table[] = {
    {"bsdf_lambda_from_sqr_alpha_tan_n_ggx", 1, 1, [](const float *i, float *o) { o[0] = bsdf_lambda_from_sqr_alpha_tan_n<MicrofacetType::GGX>(i[0]); }},
    {"bsdf_lambda_ggx", 2, 1, [](const float *i, float *o) { o[0] = bsdf_lambda<MicrofacetType::GGX>(i[0], i[1]); }},
    {"bsdf_aniso_lambda_ggx", 5, 1, [](const float *i, float *o) { o[0] = bsdf_aniso_lambda<MicrofacetType::GGX>(i[0], i[1], get3(i + 2)); }},
    {"bsdf_G_mono_ggx", 2, 1, [](const float *i, float *o) { o[0] = bsdf_G<MicrofacetType::GGX>(i[0], i[1]); }},
    {"bsdf_G_combined_ggx", 3, 1, [](const float *i, float *o) { o[0] = bsdf_G<MicrofacetType::GGX>(i[0], i[1], i[2]); }},
    {"bsdf_D_ggx", 2, 1, [](const float *i, float *o) { o[0] = bsdf_D<MicrofacetType::GGX>(i[0], i[1]); }},
    {"bsdf_aniso_D_ggx", 5, 1, [](const float *i, float *o) { o[0] = bsdf_aniso_D<MicrofacetType::GGX>(i[0], i[1], get3(i + 2)); }},
    {"fresnel_f82_Fss", 6, 3, [](const float *i, float *o) { put3(o, fresnel_f82_Fss(get3(i), get3(i + 3))); }},
    {"fresnel_f82tint_B", 6, 3, [](const float *i, float *o) { put3(o, fresnel_f82tint_B(get3(i), get3(i + 3))); }},
    {"fresnel_f82_B", 6, 3, [](const float *i, float *o) { put3(o, fresnel_f82_B(get3(i), get3(i + 3))); }},
    {"fresnel_f82_B_f32", 2, 1, [](const float *i, float *o) { o[0] = fresnel_f82_B(i[0], i[1]); }},
    {"fresnel_f82", 7, 3, [](const float *i, float *o) { put3(o, fresnel_f82(i[0], get3(i + 1), get3(i + 4))); }},
    {"fresnel_f82_f32", 3, 1, [](const float *i, float *o) { o[0] = fresnel_f82(i[0], i[1], i[2]); }},
    {"make_orthonormals", 3, 6, [](const float *i, float *o) { float3 a, b; make_orthonormals(get3(i), &a, &b); put3(o, a); put3(o + 3, b); }},
    {"to_global", 12, 3, [](const float *i, float *o) { put3(o, to_global(get3(i), get3(i + 3), get3(i + 6), get3(i + 9))); }},
    {"disk_to_hemisphere", 2, 3, [](const float *i, float *o) { put3(o, disk_to_hemisphere(get2(i))); }},
    {"lookup_table_read_ggx_Eavg", 1, 1, [](const float *i, float *o) { o[0] = lookup_table_read(kg, i[0], kernel_data.tables.ggx_Eavg, 32); }},
    {"lookup_table_read_2D_ggx_E", 2, 1, [](const float *i, float *o) { o[0] = lookup_table_read_2D(kg, i[0], i[1], kernel_data.tables.ggx_E, 32, 32); }},
    {"sample_uniform_disk", 2, 2, [](const float *i, float *o) { put2(o, sample_uniform_disk(get2(i))); }},
    {"microfacet_ggx_sample_vndf", 7, 3, [](const float *i, float *o) { put3(o, microfacet_ggx_sample_vndf(get3(i), i[3], i[4], get2(i + 5))); }},
    {"microfacet_fresnel_f82", 7, 3, [](const float *i, float *o) {
       Metal m(make_float3(0.0f, 0.0f, 1.0f), 0.5f, get3(i + 1), get3(i + 4), 1.0f);
       Spectrum r, t;
       float cos_theta_t;
       microfacet_fresnel(kg, m.bsdf, i[0], &cos_theta_t, &r, &t);
       put3(o, r);
     }},
    {"microfacet_ggx_preserve_energy", 10, 4, [](const float *i, float *o) {
       Metal m(get3(i), i[6]);
       microfacet_ggx_preserve_energy(kg, m.bsdf, get3(i + 3), get3(i + 7));
       o[0] = m.bsdf->energy_scale;
       put3(o + 1, m.bsdf->weight);
     }},
    {"bsdf_microfacet_setup_fresnel_f82_tint", 13, 7, [](const float *i, float *o) {
       Metal m(get3(i), i[6]);
       m.fresnel.f0 = get3(i + 7);
       bsdf_microfacet_setup_fresnel_f82_tint(kg, m.bsdf, get3(i + 3), &m.fresnel, get3(i + 10), true);
       put3(o, m.fresnel.b);
       o[3] = m.bsdf->energy_scale;
       put3(o + 4, m.bsdf->weight);
     }},
    {"bsdf_microfacet_eval_ggx", 16, 4, [](const float *i, float *o) {
       Metal m(get3(i), i[9], get3(i + 10), get3(i + 13), 1.0f);
       float pdf = 0.0f;
       const Spectrum e = bsdf_microfacet_eval<MicrofacetType::GGX>(kg, &m.sc, get3(i + 3), get3(i + 6), &pdf);
       eval_out(o, e, pdf);
     }},
    {"bsdf_microfacet_ggx_eval", 17, 4, [](const float *i, float *o) {
       Metal m(get3(i), i[9], get3(i + 10), get3(i + 13), i[16]);
       float pdf = 0.0f;
       const Spectrum e = bsdf_microfacet_ggx_eval(kg, &m.sc, get3(i + 3), get3(i + 6), &pdf);
       eval_out(o, e, pdf);
     }},
    {"bsdf_microfacet_sample_ggx", 18, 8, [](const float *i, float *o) {
       Metal m(get3(i), i[9], get3(i + 10), get3(i + 13), 1.0f);
       Spectrum eval = zero_spectrum();
       float3 wo = zero_float3();
       float pdf = 0.0f, eta;
       float2 rough;
       /* rand.z 只用来在反射与折射之间选；金属 pdf_reflect 为 1，取 0 一定选反射 */
       const int label = bsdf_microfacet_sample<MicrofacetType::GGX>(kg, &m.sc, get3(i + 3), get3(i + 6), make_float3(i[16], i[17], 0.0f), &eval, &wo, &pdf, &rough, &eta);
       sample_out(o, label, eval, wo, pdf);
     }},
    {"bsdf_microfacet_ggx_sample", 19, 8, [](const float *i, float *o) {
       Metal m(get3(i), i[9], get3(i + 10), get3(i + 13), i[16]);
       Spectrum eval = zero_spectrum();
       float3 wo = zero_float3();
       float pdf = 0.0f, eta;
       float2 rough;
       const int label = bsdf_microfacet_ggx_sample(kg, &m.sc, get3(i + 3), get3(i + 6), make_float3(i[17], i[18], 0.0f), &eval, &wo, &pdf, &rough, &eta);
       sample_out(o, label, eval, wo, pdf);
     }},
    {"fresnel_dielectric_polarized", 2, 2, [](const float *i, float *o) { put2(o, fresnel_dielectric_polarized(i[0], i[1], nullptr, nullptr)); }},
    {"fresnel_dielectric_ccl", 2, 1, [](const float *i, float *o) { o[0] = fresnel_dielectric(i[0], i[1], nullptr); }},
    {"fresnel_dielectric_Fss", 1, 1, [](const float *i, float *o) { o[0] = fresnel_dielectric_Fss(i[0]); }},
    {"ior_from_F0", 1, 1, [](const float *i, float *o) { o[0] = ior_from_F0(i[0]); }},
    {"F0_from_ior", 1, 1, [](const float *i, float *o) { o[0] = F0_from_ior(i[0]); }},
    {"inverse_lerp", 3, 1, [](const float *i, float *o) { o[0] = inverse_lerp(i[0], i[1], i[2]); }},
    {"safe_divide_color", 6, 3, [](const float *i, float *o) { put3(o, safe_divide_color(get3(i), get3(i + 3))); }},
    {"closure_layering_weight", 6, 3, [](const float *i, float *o) { put3(o, closure_layering_weight(get3(i), get3(i + 3))); }},
    {"lookup_table_read_3D_ggx_gen_schlick_ior_s", 3, 1, [](const float *i, float *o) { o[0] = lookup_table_read_3D(kg, i[0], i[1], i[2], kernel_data.tables.ggx_gen_schlick_ior_s, 16, 16, 16); }},
    {"lookup_table_read_3D_ggx_gen_schlick_s", 3, 1, [](const float *i, float *o) { o[0] = lookup_table_read_3D(kg, i[0], i[1], i[2], kernel_data.tables.ggx_gen_schlick_s, 16, 16, 16); }},
    {"generalized_schlick_fresnel", 15, 6, [](const float *i, float *o) {
       /* 输入依次是 ior、cos_theta_i、f0、f90、exponent、reflection_tint、transmission_tint */
       FresnelGeneralizedSchlick f = {};
       f.f0 = get3(i + 2);
       f.f90 = get3(i + 5);
       f.exponent = i[8];
       f.reflection_tint = get3(i + 9);
       f.transmission_tint = get3(i + 12);
       Spectrum r, t;
       float cos_theta_t = 0.0f;
       generalized_schlick_fresnel(kg, &f, i[0], i[1], &cos_theta_t, &r, &t);
       put3(o, r);
       put3(o + 3, t);
     }},
    {"microfacet_fresnel_generalized_schlick", 15, 3, [](const float *i, float *o) {
       Dielectric d(make_float3(0.0f, 0.0f, 1.0f), 0.5f, i + 1);
       Spectrum r, t;
       float cos_theta_t;
       microfacet_fresnel(kg, d.bsdf, i[0], &cos_theta_t, &r, &t);
       put3(o, r);
     }},
    {"bsdf_microfacet_estimate_albedo_generalized_schlick", 21, 3, [](const float *i, float *o) {
       Dielectric d(get3(i), i[6], i + 7);
       put3(o, bsdf_microfacet_estimate_albedo(kg, get3(i + 3), d.bsdf, true, true));
     }},
    {"bsdf_microfacet_estimate_albedo_f82_tint", 10, 3, [](const float *i, float *o) {
       Metal m(get3(i), i[6], get3(i + 7), zero_float3(), 1.0f);
       put3(o, bsdf_microfacet_estimate_albedo(kg, get3(i + 3), m.bsdf, true, true));
     }},
    {"bsdf_microfacet_setup_fresnel_generalized_schlick", 21, 7, [](const float *i, float *o) {
       Dielectric d(get3(i), i[6], i + 7);
       bsdf_microfacet_setup_fresnel_generalized_schlick(kg, d.bsdf, get3(i + 3), &d.fresnel, true);
       put3(o, d.fresnel.f0);
       o[3] = d.bsdf->energy_scale;
       put3(o + 4, d.bsdf->weight);
     }},
    {"bsdf_microfacet_eval_ggx_generalized_schlick", 24, 4, [](const float *i, float *o) {
       Dielectric d(get3(i), i[9], i + 10);
       float pdf = 0.0f;
       const Spectrum e = bsdf_microfacet_eval<MicrofacetType::GGX>(kg, &d.sc, get3(i + 3), get3(i + 6), &pdf);
       eval_out(o, e, pdf);
     }},
    {"bsdf_microfacet_ggx_eval_generalized_schlick", 25, 4, [](const float *i, float *o) {
       Dielectric d(get3(i), i[9], i + 10, i[24]);
       float pdf = 0.0f;
       const Spectrum e = bsdf_microfacet_ggx_eval(kg, &d.sc, get3(i + 3), get3(i + 6), &pdf);
       eval_out(o, e, pdf);
     }},
    {"bsdf_microfacet_sample_ggx_generalized_schlick", 26, 8, [](const float *i, float *o) {
       Dielectric d(get3(i), i[9], i + 10);
       Spectrum eval = zero_spectrum();
       float3 wo = zero_float3();
       float pdf = 0.0f, eta;
       float2 rough;
       /* rand.z 只用来在反射与折射之间选；只有反射时 pdf_reflect 为 1，取 0 一定选反射 */
       const int label = bsdf_microfacet_sample<MicrofacetType::GGX>(kg, &d.sc, get3(i + 3), get3(i + 6), make_float3(i[24], i[25], 0.0f), &eval, &wo, &pdf, &rough, &eta);
       sample_out(o, label, eval, wo, pdf);
     }},
    {"bsdf_microfacet_ggx_sample_generalized_schlick", 27, 8, [](const float *i, float *o) {
       Dielectric d(get3(i), i[9], i + 10, i[24]);
       Spectrum eval = zero_spectrum();
       float3 wo = zero_float3();
       float pdf = 0.0f, eta;
       float2 rough;
       const int label = bsdf_microfacet_ggx_sample(kg, &d.sc, get3(i + 3), get3(i + 6), make_float3(i[25], i[26], 0.0f), &eval, &wo, &pdf, &rough, &eta);
       sample_out(o, label, eval, wo, pdf);
     }},
    {"bsdf_blur", 3, 2, [](const float *i, float *o) {
       Metal m(make_float3(0.0f, 0.0f, 1.0f), 0.5f);
       m.bsdf->alpha_x = i[0];
       m.bsdf->alpha_y = i[1];
       bsdf_blur(&m.sc, i[2]);
       o[0] = m.bsdf->alpha_x;
       o[1] = m.bsdf->alpha_y;
     }},
    {"sample_cos_hemisphere", 5, 4, [](const float *i, float *o) {
       float3 wo;
       float pdf;
       sample_cos_hemisphere(get3(i), get2(i + 3), &wo, &pdf);
       put3(o, wo);
       o[3] = pdf;
     }},
    {"bsdf_diffuse_eval", 6, 4, [](const float *i, float *o) {
       const ShaderClosure sc = diffuse(get3(i));
       float pdf = 0.0f;
       const Spectrum e = bsdf_diffuse_eval(&sc, zero_float3(), get3(i + 3), &pdf);
       eval_out(o, e, pdf);
     }},
    {"bsdf_diffuse_sample", 8, 8, [](const float *i, float *o) {
       const ShaderClosure sc = diffuse(get3(i));
       Spectrum eval = zero_spectrum();
       float3 wo = zero_float3();
       float pdf = 0.0f;
       const int label = bsdf_diffuse_sample(&sc, get3(i + 3), zero_float3(), get2(i + 6), &eval, &wo, &pdf);
       /* 几何法线下面的方向：Cycles 照写 wo、label，eval 与 pdf 为 0，原样输出 */
       o[0] = float(label);
       put3(o + 1, eval);
       put3(o + 4, wo);
       o[7] = pdf;
     }},
    {"emissive_pdf", 6, 1, [](const float *i, float *o) { o[0] = emissive_pdf(get3(i), get3(i + 3)); }},
    {"emissive_simple_eval", 6, 3, [](const float *i, float *o) { put3(o, emissive_simple_eval(get3(i), get3(i + 3))); }},
    {"safe_asinf", 1, 1, [](const float *i, float *o) { o[0] = safe_asinf(i[0]); }},
    {"ray_quad_intersect", 20, 7, [](const float *i, float *o) {
       float3 P = zero_float3();
       float t = 0.0f, u = 0.0f, v = 0.0f;
       const bool hit = ray_quad_intersect(get3(i), get3(i + 3), i[6], i[7], get3(i + 8), get3(i + 11), get3(i + 14), get3(i + 17), &P, &t, &u, &v, false);
       o[0] = float(hit);
       put3(o + 1, P);
       o[4] = t;
       o[5] = u;
       o[6] = v;
     }},
    {"area_light_rect_sample", 16, 4, [](const float *i, float *o) {
       float3 light_p = get3(i + 3);
       o[0] = area_light_rect_sample(get3(i), &light_p, get3(i + 6), i[9], get3(i + 10), i[13], get2(i + 14), true);
       put3(o + 1, light_p);
     }},
    {"area_light_rect_sample_pdf", 16, 1, [](const float *i, float *o) {
       float3 light_p = get3(i + 3);
       o[0] = area_light_rect_sample(get3(i), &light_p, get3(i + 6), i[9], get3(i + 10), i[13], get2(i + 14), false);
     }},
    {"area_light_rect_sample_solid_angle", 16, 1, [](const float *i, float *o) {
       float3 light_p = get3(i + 3);
       o[0] = 1.0f / area_light_rect_sample(get3(i), &light_p, get3(i + 6), i[9], get3(i + 10), i[13], get2(i + 14), false);
     }},
    {"area_light_sample", 20, 10, [](const float *i, float *o) {
       const KernelLight k = area_light(i + 5);
       LightSample ls{};
       const bool ok = area_light_sample<false>(&k, get2(i), get3(i + 2), &ls);
       light_sample_out(o, ok, ls);
     }},
    {"area_light_eval_from_intersection", 22, 2, [](const float *i, float *o) {
       const KernelLight k = area_light(i + 7);
       const LightEval e = area_light_eval_from_intersection(&k, get3(i), get3(i + 3), i[6]);
       o[0] = e.eval_fac;
       o[1] = e.pdf;
     }},
    {"area_light_intersect", 23, 2, [](const float *i, float *o) {
       const KernelLight k = area_light(i + 8);
       Ray ray{};
       ray.P = get3(i);
       ray.D = get3(i + 3);
       ray.tmin = i[6];
       ray.tmax = i[7];
       float t = 0.0f;
       const bool hit = area_light_intersect(&k, &ray, &t);
       o[0] = float(hit);
       o[1] = hit ? t : 0.0f;
     }},
};

// 成像一组（像素滤波、夹取）另放一个文件，表名 imaging_table
#include "ref_imaging.h"

static_assert(sizeof(float) == 4, "float32 required");  // 只在小端主机上用（arm64、x86-64），不做字节序转换

int main(int argc, char **argv)
{
  const Entry *e = nullptr;
  for (const Entry &t : table) {
    if (argc == 2 && strcmp(t.id, argv[1]) == 0) e = &t;
  }
  for (const Entry &t : imaging_table) {
    if (argc == 2 && strcmp(t.id, argv[1]) == 0) e = &t;
  }
  if (!e) {
    fprintf(stderr, "unknown function id: %s\n", argc == 2 ? argv[1] : "(none)");
    return 1;
  }
  init_tables();
  init_imaging_tables();
  std::vector<float> in(e->n_in), out(e->n_out);
  for (;;) {
    const size_t got = fread(in.data(), sizeof(float), e->n_in, stdin);
    if (got == 0) break;
    if (got != size_t(e->n_in)) {
      fprintf(stderr, "truncated input: last group has %zu of %d floats\n", got, e->n_in);
      return 2;
    }
    e->fn(in.data(), out.data());
    fwrite(out.data(), sizeof(float), e->n_out, stdout);
  }
  return 0;
}
