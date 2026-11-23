// 标准答案程序：直接包含 Cycles 内核的真实头文件、调用真实函数（不抄函数体），按函数标识分发。
// 用法：ref <函数标识> < 输入 > 输出。输入是小端 float32 流，每组 n_in 个；输出每组 n_out 个。
// 退出码：0 成功；1 函数标识不认识；2 最后一组不完整。
#include "kernel/device/cpu/compat.h"
#include "kernel/device/cpu/globals.h"
#include "kernel/types.h"
#include "kernel/closure/bsdf_microfacet.h"

#include <cstdio>
#include <cstring>
#include <vector>

using namespace ccl;

struct Entry {
  const char *id;
  int n_in, n_out;
  void (*fn)(const float *i, float *o);
};

static float3 get3(const float *i) { return make_float3(i[0], i[1], i[2]); }
static void put3(float *o, const float3 v) { o[0] = v.x; o[1] = v.y; o[2] = v.z; }

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
