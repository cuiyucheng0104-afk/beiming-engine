// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//
// 成像：像素滤波的查表与贡献的夹取，照 Cycles（Blender v5.2.3）内核源码逐行移植；这些源文件都是 Apache-2.0。
// 行号指 intern/cycles/ 下的文件。纯函数，不带绑定，与同目录的 WGSL 文件拼在一起编译。
// 滤波表放在哪里归调用方：本文件只调 filter_table_value(i)（表的第 i 个数），内核在 path/shaders/film.wgsl 里给出
// （读全局参数的 filter_table 一块），函数级比对外壳给的是 Cycles 自己建的表。宿主一侧建表的那一段在 path/src/pixel_filter.rs。

// kernel/types.h:34: FILTER_TABLE_SIZE
const FILTER_TABLE_SIZE: i32 = 1024;

// kernel/util/lookup_table.h:14-28: lookup_table_read，表固定是滤波表（kernel/camera/camera.h:460-465 的像素滤波用它：
// 像素内的偏移 raster += lookup_table_read(kg, filter_uv, filter_table_offset, FILTER_TABLE_SIZE)）
fn filter_table_read(x_in: f32, offset: i32) -> f32 {
  let x = saturate(x_in) * f32(FILTER_TABLE_SIZE - 1);

  let index = min(i32(x), FILTER_TABLE_SIZE - 1);
  let nindex = min(index + 1, FILTER_TABLE_SIZE - 1);
  let t = x - f32(index);

  let data0 = filter_table_value(index + offset);
  if (t == 0.0) {
    return data0;
  }

  let data1 = filter_table_value(nindex + offset);
  return (1.0 - t) * data0 + t * data1;
}

// util/math_base.h:352-357: isfinite_safe（显卡上那一支）。只用整数比：指数位全 1 的是无穷或非数，(x << 1) 不小于
// 0xff000000；这一条已经蕴含原式的另外两条。苹果显卡的快速数学会把浮点的 f == f 折掉，所以不用浮点比
fn isfinite_safe(f: f32) -> bool {
  return (bitcast<u32>(f) << 1u) < 0xff000000u;
}

// util/math_float3.h:707-720: ensure_finite（float3）
fn ensure_finite3(v: vec3f) -> vec3f {
  var r = v;
  if (!isfinite_safe(r.x)) {
    r.x = 0.0;
  }
  if (!isfinite_safe(r.y)) {
    r.y = 0.0;
  }
  if (!isfinite_safe(r.z)) {
    r.z = 0.0;
  }
  return r;
}

// kernel/film/light_passes.h:126-148: film_clamp_light（开了 __CLAMP_SAMPLE__ 的那一支）。两个上限照
// kernel_data.integrator 的口径传：宿主写的是用户值乘 3，不夹时是 FLT_MAX（scene/integrator.cpp:311-315）。
// bounce 照 Cycles 各调用处的口径：直接光是阴影射线出发处的弹射数，发光与背景是打到它的那段射线的弹射数减 1
fn film_clamp_light(L_in: vec3f, bounce: i32, sample_clamp_direct: f32, sample_clamp_indirect: f32) -> vec3f {
  var L = ensure_finite3(L_in);

  let limit = select(sample_clamp_direct, sample_clamp_indirect, bounce > 0);
  // util/math_float3.h:590-599: reduce_add
  let a = abs(L);
  let sum = a.x + a.y + a.z;
  if (sum > limit) {
    L *= limit / sum;
  }
  return L;
}
