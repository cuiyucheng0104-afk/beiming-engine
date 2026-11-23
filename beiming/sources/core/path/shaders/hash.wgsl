// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//
// 照 Cycles（Blender v5.2.3）的 intern/cycles/util/hash.h 逐行移植的哈希函数；那个文件是 Apache-2.0（许可全文见仓库根的
// LICENSES/Apache-2.0.txt）。行号指那个文件。src/cycles_hash.rs 是 CPU 上的同一份。

// util/hash.h:625 hash_iqnt2d。原注释：2D hash recommended from "Hash Functions for GPU Rendering" JCGT Vol. 9, No. 3,
// 2020. See https://www.shadertoy.com/view/4tXyWN and https://www.shadertoy.com/view/XlGcRh,
// http://www.jcgt.org/published/0009/03/02/paper.pdf
// 用处：每个像素的随机数种子（sample.wgsl 的 rng_start，对应 Cycles kernel/sample/pattern.h 的 path_rng_pixel_init）。
fn hash_iqnt2d(x: u32, y: u32) -> u32 {
    let qx = 1103515245u * ((x >> 1u) ^ (y));
    let qy = 1103515245u * ((y >> 1u) ^ (x));
    let n = 1103515245u * ((qx) ^ (qy >> 3u));

    return n;
}
