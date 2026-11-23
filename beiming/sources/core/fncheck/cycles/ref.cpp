// 标准答案程序：直接包含 Cycles 内核的真实头文件、调用真实函数（不抄函数体），按函数标识分发。
// 用法：ref <函数标识> < 输入 > 输出。输入是小端 float32 流，每组 n_in 个；输出每组 n_out 个。
// 退出码：0 成功；1 函数标识不认识；2 最后一组不完整。
// 要闭包结构体或查找表的函数，在这里填好真的 MicrofacetBsdf、FresnelF82Tint 和内核全局数据，再调真函数。
#include "kernel/device/cpu/compat.h"
#include "kernel/device/cpu/globals.h"
#include "kernel/types.h"
#include "kernel/closure/bsdf_microfacet.h"
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
};

static_assert(sizeof(float) == 4, "float32 required");  // 只在小端主机上用（arm64、x86-64），不做字节序转换

int main(int argc, char **argv)
{
  const Entry *e = nullptr;
  for (const Entry &t : table) {
    if (argc == 2 && strcmp(t.id, argv[1]) == 0) e = &t;
  }
  if (!e) {
    fprintf(stderr, "unknown function id: %s\n", argc == 2 ? argv[1] : "(none)");
    return 1;
  }
  init_tables();
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
