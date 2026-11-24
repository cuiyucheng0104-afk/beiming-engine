// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//! 照 Cycles（Blender v5.2.3）的 intern/cycles/util/hash.h 移植的哈希函数在 CPU 上的一份（着色器里的在
//! shaders/hash.wgsl）。那个文件是 Apache-2.0。给测试用：`sample.rs` 拿它算每个像素的随机数种子。

/// util/hash.h:625 `hash_iqnt2d`：2D hash recommended from "Hash Functions for GPU Rendering" JCGT Vol. 9, No. 3, 2020.
pub fn hash_iqnt2d(x: u32, y: u32) -> u32 {
    let qx = 1103515245u32.wrapping_mul((x >> 1) ^ y);
    let qy = 1103515245u32.wrapping_mul((y >> 1) ^ x);
    1103515245u32.wrapping_mul(qx ^ (qy >> 3))
}
