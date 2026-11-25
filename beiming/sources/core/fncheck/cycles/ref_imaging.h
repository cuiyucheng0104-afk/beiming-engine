// 标准答案程序的成像一组（ref.cpp 包含它，表名 imaging_table）：像素滤波的三个滤波函数与建表、内核查滤波表、贡献的夹取。
// 滤波函数与建表在宿主侧的 scene/film.cpp 里，是 static 函数：build.mjs 从源码缓存原样截出那一段，生成 cycles_film_filter.h；
// 这里直接调那几个真函数，不抄函数体。查表与夹取调内核的真函数（kernel/util/lookup_table.h、kernel/film/light_passes.h）。
#pragma once

#include "kernel/film/light_passes.h"
#include "kernel/util/lookup_table.h"

#include "cycles_film_filter.h"

/* 查表比对用的三张滤波表，接在 lut 的末尾：盒式宽 2、高斯宽 1.5、Blackman-Harris 宽 1.5（与 fncheck/registry.mjs 的
 * FILTER_TABLES 同序）。被测一侧拿 filter_table 一项按同样的参数建出的表（就是这三张）查 */
static const float filter_tables_fixed[3][2] = {{float(FILTER_BOX), 2.0f}, {float(FILTER_GAUSSIAN), 1.5f}, {float(FILTER_BLACKMAN_HARRIS), 1.5f}};
static int filter_table_offset[3];

static void init_imaging_tables()
{
  ThreadKernelGlobalsCPU *g = reinterpret_cast<ThreadKernelGlobalsCPU *>(kg_storage);
  for (int k = 0; k < 3; k++) {
    const vector<float> t = filter_table(FilterType(int(filter_tables_fixed[k][0])), filter_tables_fixed[k][1]);
    filter_table_offset[k] = add_table(t.data(), t.size());
  }
  g->lookup_table.data = lut.data();
  g->lookup_table.width = int(lut.size());
}

/* 夹取：两个上限写进内核全局数据的 integrator（就是 Cycles 内核读的那两格），再调真函数 */
static void clamp_light(const float *i, float *o)
{
  ThreadKernelGlobalsCPU *g = reinterpret_cast<ThreadKernelGlobalsCPU *>(kg_storage);
  g->data.integrator.sample_clamp_direct = i[4];
  g->data.integrator.sample_clamp_indirect = i[5];
  Spectrum L = get3(i);
  film_clamp_light(kg, &L, int(i[3]));
  put3(o, L);
}

static_assert(FILTER_TABLE_SIZE == 1024, "filter_table 一项的输出个数照 kernel/types.h 写成 1024");

static const Entry imaging_table[] = {
    {"filter_func_box", 2, 1, [](const float *i, float *o) { o[0] = filter_func_box(i[0], i[1]); }},
    {"filter_func_gaussian", 2, 1, [](const float *i, float *o) { o[0] = filter_func_gaussian(i[0], i[1]); }},
    {"filter_func_blackman_harris", 2, 1, [](const float *i, float *o) { o[0] = filter_func_blackman_harris(i[0], i[1]); }},
    {"filter_table", 2, 1024, [](const float *i, float *o) {
       const vector<float> t = filter_table(FilterType(int(i[0])), i[1]);
       memcpy(o, t.data(), sizeof(float) * FILTER_TABLE_SIZE);
     }},
    {"filter_table_read_box", 1, 1, [](const float *i, float *o) { o[0] = lookup_table_read(kg, i[0], filter_table_offset[0], FILTER_TABLE_SIZE); }},
    {"filter_table_read_gaussian", 1, 1, [](const float *i, float *o) { o[0] = lookup_table_read(kg, i[0], filter_table_offset[1], FILTER_TABLE_SIZE); }},
    {"filter_table_read_blackman_harris", 1, 1, [](const float *i, float *o) { o[0] = lookup_table_read(kg, i[0], filter_table_offset[2], FILTER_TABLE_SIZE); }},
    {"film_clamp_light", 6, 3, clamp_light},
};
