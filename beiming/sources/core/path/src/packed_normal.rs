// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//! 北冥：Cycles 存法线的精度。Cycles（Blender v5.2.3）把网格的顶点法线与角法线存成两个 16 位整数的八面体编码
//! （intern/cycles/util/types_normal.h 的 `packed_normal`：构造即编码、`decode`、处理器上取角法线用的 SIMD 版
//! `packed_normal_decode_simd`），同步时就编码（blender/mesh.cpp:672、:765）；渲染静态 BVH 时，只被一个物体用的网格把物体
//! 变换烘进几何，法线先解码、乘逆转置、归一化、再编码一次（scene/object.cpp:1172-1238 的 `apply_static_transforms`，
//! scene/mesh.cpp:552-585 的 `Mesh::apply_transform`）。步长 2/65535，轴对齐的法线解码后也偏开 2^-16 弧度上下；
//! 低粗糙度的高光对这么大的偏差就敏感。场景包读入器（pack.rs）照这里把法线过一遍，与标准答案机用的法线逐位相同。
//! 三个函数逐行移植，全用 f32、次序照原式（Cycles 的 normalize 在开 SSE 的构建里是 a / sqrt(dot)，dot 是 (x·x + y·y) + z·z，
//! 与标量写法同次序）。对不对由函数级比对逐组对 Cycles 把关（`core-render fncheck-host`，见 ../../fncheck/registry.mjs）。

const MU: u32 = (1 << 16) - 1;

/// util/types_normal.h:26-40：`packed_normal(const float3 in)`，返回 `value`（低 16 位 dx、高 16 位 dy）
pub fn encode(n: [f32; 3]) -> u32 {
    let hmu: f32 = MU as f32 / 2.0;
    let inv_l1 = 1.0f32 / (n[0].abs() + n[1].abs() + n[2].abs() + 1e-6f32);
    let mut vx = n[0] * inv_l1;
    let mut vy = n[1] * inv_l1;
    let wrapx = (1.0 - vy.abs()) * 1.0f32.copysign(vx);
    let wrapy = (1.0 - vx.abs()) * 1.0f32.copysign(vy);
    if n[2] < 0.0 {
        vx = wrapx;
        vy = wrapy;
    }
    // Cycles 的 clamp(a, lo, hi) 是 min(max(a, lo), hi)；转 uint 截掉小数
    let q = |v: f32| (v * hmu + (hmu + 0.5)).max(0.0).min(MU as f32) as u32;
    q(vx) | (q(vy) << 16)
}

/// util/types_normal.h:42-53：`packed_normal::decode`（标量版：Mesh::apply_transform 解码用它）。最后的 normalize 照开 SSE 的
/// 构建写成真除（x86-64 的 Cycles 都开 SSE4.2；不开 SSE 的构建是乘倒数，差一个末位）
pub fn decode(value: u32) -> [f32; 3] {
    let inv_hmu: f32 = 2.0 / MU as f32;
    let mut nx = (value & MU) as f32 * inv_hmu - 1.0;
    let mut ny = ((value >> 16) & MU) as f32 * inv_hmu - 1.0;
    let nz = 1.0 - nx.abs() - ny.abs();
    let t = (-nz).max(0.0);
    nx += t.copysign(-nx);
    ny += t.copysign(-ny);
    let len = ((nx * nx + ny * ny) + nz * nz).sqrt();
    [nx / len, ny / len, nz / len]
}

/// util/types_normal.h:66-95：`packed_normal_decode_simd` 的一个分量（处理器上取顶点、角法线用它：geom/attribute.h
/// `attribute_data_fetch_normals`）。与标量版的两处不同：符号按「大于 0」选，最后乘倒数而不是除以长度
pub fn decode_simd(value: u32) -> [f32; 3] {
    let inv_hmu: f32 = 2.0 / 65535.0;
    let mut nx = (value & 0xFFFF) as f32 * inv_hmu - 1.0;
    let mut ny = ((value >> 16) & 0xFFFF) as f32 * inv_hmu - 1.0;
    let nz = 1.0 - nx.abs() - ny.abs();
    let t = (-nz).max(0.0);
    nx += if nx > 0.0 { -t } else { t };
    ny += if ny > 0.0 { -t } else { t };
    let inv_len = 1.0 / ((nx * nx + ny * ny) + nz * nz).sqrt();
    [nx * inv_len, ny * inv_len, nz * inv_len]
}

/// scene/mesh.cpp:565-583：烘进物体变换时一个法线码的变化：`packed_normal(normalize(transform_direction(&ntfm, decode())))`。
/// `ntfm` 是物体变换的逆转置（行主序，只用线性部分）。transform_direction 照开 SSE 的写法（util/transform.h:157-169）：
/// 先 z 分量、再加 y、再加 x（a.x·m0 + (a.y·m1 + a.z·m2)）。逆转置这里在调用方用双精度求（Cycles 在单精度里求逆，
/// 差一两个末位只在编码的格子边界上偶尔差一格）
pub fn apply_transform(value: u32, ntfm: [[f32; 3]; 3]) -> u32 {
    let a = decode(value);
    let r = ntfm.map(|row| a[0] * row[0] + (a[1] * row[1] + a[2] * row[2]));
    let len = ((r[0] * r[0] + r[1] * r[1]) + r[2] * r[2]).sqrt();
    encode([r[0] / len, r[1] / len, r[2] / len])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axis_normals_round_trip_with_cycles_tilt() {
        // (0, 1, 0) 解码之后偏开约 2^-16 弧度（步长 2/65535 的一半量级），x、z 两轴同理
        for n in [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]] {
            let d = decode_simd(encode(n));
            let cos = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
            let ang = (cos.min(1.0) as f64).acos();
            assert!(ang < 3e-5, "{n:?} → {d:?}，偏开 {ang}");
            assert!((d[0] * d[0] + d[1] * d[1] + d[2] * d[2] - 1.0).abs() < 1e-6);
        }
        // 绕 z 轴转 90° 的逆转置：x 轴的码变成 y 轴的码
        let c = apply_transform(encode([1.0, 0.0, 0.0]), [[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]);
        let d = decode_simd(c);
        assert!(d[1] > 0.99999 && d[0].abs() < 3e-5, "{d:?}");
    }
}
