// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//
// 照 Cycles（Blender v5.2.3）的 intern/cycles/util/hash.h 逐行移植的哈希函数，与 kernel/sample/lcg.h 的线性同余发生器；
// 那两个文件是 Apache-2.0（许可全文见仓库根的 LICENSES/Apache-2.0.txt）。行号指 hash.h。src/cycles_hash.rs 是 hash_iqnt2d
// 在 CPU 上的同一份（hash_uint3 与 lcg 只有着色器里这一份）。

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

// util/hash.h:20-21 rot、:84-103 final（Bob Jenkins 的 lookup3 收尾混合），:153-166 hash_uint3。
// 用处：倒角节点给局部求交随机取子集用的小随机数状态（下面的 lcg_state_init）。
fn hash_rot(x: u32, k: u32) -> u32 { return (x << k) | (x >> (32u - k)); }
fn hash_uint3(kx: u32, ky: u32, kz: u32) -> u32 {
    var a = 0xdeadbeefu + (3u << 2u) + 13u;
    var b = a;
    var c = a;
    c += kz;
    b += ky;
    a += kx;
    c ^= b; c -= hash_rot(b, 14u);
    a ^= c; a -= hash_rot(c, 11u);
    b ^= a; b -= hash_rot(a, 25u);
    c ^= b; c -= hash_rot(b, 16u);
    a ^= c; a -= hash_rot(c, 4u);
    b ^= a; b -= hash_rot(a, 14u);
    c ^= b; c -= hash_rot(b, 24u);
    return c;
}

// kernel/sample/lcg.h（照 Cycles 逐行移植，同样是 Apache-2.0）：线性同余发生器。WGSL 不能把局部变量的指针当返回值带回，
// 所以 lcg_step_uint 返回新的状态，调用方自己存回去（Cycles 里状态与返回值是同一个数）。
fn lcg_step_uint(rng: u32) -> u32 { return 1103515245u * rng + 12345u; }
fn lcg_state_init(rng_hash: u32, rng_offset: u32, sample: u32, scramble: u32) -> u32 {
    return hash_uint3(rng_hash ^ scramble, rng_offset, sample);
}
