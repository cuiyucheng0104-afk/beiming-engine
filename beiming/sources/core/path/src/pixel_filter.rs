// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: Apache-2.0
//! 北冥：像素滤波的重要性采样表，宿主一侧建表。照 Cycles（Blender v5.2.3）的 intern/cycles/scene/film.cpp
//! （`filter_func_box`、`filter_func_gaussian`、`filter_func_blackman_harris`、`filter_table`）与
//! intern/cycles/util/math_cdf.h、math_cdf.cpp（`util_cdf_evaluate`、`util_cdf_inverted`、`util_cdf_invert` 的对称一支）
//! 逐行移植，这几个文件都是 Apache-2.0。全用 f32 算，次序照原式。内核拿一个随机数查这张表得到像素内的偏移
//! （../../shaders/imaging.wgsl 的 `filter_table_read`），每个样本的权重是 1。
//! 表对不对由函数级比对外壳逐项对 Cycles 自己建的表把关（`core-render fncheck-host`，见 ../../fncheck/registry.mjs）。

/// kernel/types.h:34 `FILTER_TABLE_SIZE`
pub const FILTER_TABLE_SIZE: usize = 1024;

/// scene/film.h:21-27 `FilterType`（数值照它的次序）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterType {
    Box = 0,
    Gaussian = 1,
    BlackmanHarris = 2,
}

impl FilterType {
    /// 命令行的写法（`--pixel-filter`）
    pub fn parse(s: &str) -> Option<FilterType> {
        match s {
            "box" => Some(FilterType::Box),
            "gaussian" => Some(FilterType::Gaussian),
            "blackman-harris" => Some(FilterType::BlackmanHarris),
            _ => None,
        }
    }
}

/// util/math_base.h `M_2PI_F`（与 f32 的 TAU 是同一个数）
const M_2PI_F: f32 = std::f32::consts::TAU;

/// scene/film.cpp:26-29 `filter_func_box`
pub fn filter_func_box(_v: f32, _width: f32) -> f32 {
    1.0
}

/// scene/film.cpp:31-35 `filter_func_gaussian`
pub fn filter_func_gaussian(v: f32, width: f32) -> f32 {
    let v = v * (6.0 / width);
    (-2.0 * v * v).exp()
}

/// scene/film.cpp:37-41 `filter_func_blackman_harris`
pub fn filter_func_blackman_harris(v: f32, width: f32) -> f32 {
    let v = M_2PI_F * (v / width + 0.5);
    0.35875 - 0.48829 * v.cos() + 0.14128 * (2.0 * v).cos() - 0.01168 * (3.0 * v).cos()
}

/// util/math_cdf.h:13-33 `util_cdf_evaluate`
fn cdf_evaluate(resolution: usize, from: f32, to: f32, functor: impl Fn(f32) -> f32) -> Vec<f32> {
    let cdf_count = resolution + 1;
    let range = to - from;
    let mut cdf = vec![0.0f32; cdf_count];
    for i in 0..resolution {
        let x = from + range * i as f32 / (resolution - 1) as f32;
        let y = functor(x);
        cdf[i + 1] = cdf[i] + y.abs();
    }
    let fac = if cdf[resolution] == 0.0 { 0.0 } else { 1.0 / cdf[resolution] };
    for c in cdf.iter_mut() {
        *c *= fac;
    }
    cdf[resolution] = 1.0;
    cdf
}

/// util/math_cdf.cpp:13-42 `util_cdf_invert`，make_symmetric 为真的那一支（建滤波表只走这一支）。表的最后一格不写，
/// 留 0（Cycles 也是这样：建表前 resize 成全 0，对称的一支只写到倒数第二格）
fn cdf_invert_symmetric(resolution: usize, from: f32, to: f32, cdf: &[f32], inv_cdf: &mut [f32]) {
    let cdf_size = cdf.len();
    let range = to - from;
    let half_size = (resolution - 1) / 2;
    for i in 0..=half_size {
        let x = i as f32 / half_size as f32;
        // upper_bound：第一个大于 x 的元素
        let mut index = cdf.partition_point(|&c| c <= x);
        let t;
        if index < cdf_size - 1 {
            t = (x - cdf[index]) / (cdf[index + 1] - cdf[index]);
        } else {
            t = 0.0;
            index = cdf_size - 1;
        }
        let y = ((index as f32 + t) / (resolution - 1) as f32) * (2.0 * range);
        inv_cdf[half_size + i] = 0.5 * (1.0 + y);
        inv_cdf[half_size - i] = 0.5 * (1.0 - y);
    }
}

/// scene/film.cpp:43-84 `filter_table`：滤波函数在 [0, 宽度/2] 上的重要性采样表（经 util/math_cdf.h:36-53
/// `util_cdf_inverted`），表里是像素内的偏移，像素中心是 0.5
pub fn filter_table(kind: FilterType, width: f32) -> Vec<f32> {
    let mut table = vec![0.0f32; FILTER_TABLE_SIZE];
    let (func, width): (fn(f32, f32) -> f32, f32) = match kind {
        FilterType::Box => (filter_func_box, width),
        FilterType::Gaussian => (filter_func_gaussian, width * 3.0),
        FilterType::BlackmanHarris => (filter_func_blackman_harris, width * 2.0),
    };
    let cdf = cdf_evaluate(FILTER_TABLE_SIZE - 1, 0.0, width * 0.5, |x| func(x, width));
    cdf_invert_symmetric(FILTER_TABLE_SIZE, 0.0, width * 0.5, &cdf, &mut table);
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_width_1_is_the_unit_interval() {
        // 盒式宽 1：节点 j 上是 j/1022（对称的一支只写到倒数第二格），最后一格是 0
        let t = filter_table(FilterType::Box, 1.0);
        assert_eq!(t[0], 0.0);
        assert_eq!(t[1022], 1.0);
        assert_eq!(t[1023], 0.0);
        assert_eq!(t[511], 0.5);
        for (j, v) in t.iter().enumerate().take(1023) {
            assert!((v - j as f32 / 1022.0).abs() < 2e-6, "第 {j} 格 {v}");
        }
    }

    #[test]
    fn tables_are_symmetric_about_the_pixel_centre_and_span_the_support() {
        // 支撑半宽：盒式 w/2，高斯 1.5w，Blackman-Harris w（建表前宽度乘 3、乘 2）
        for (kind, half) in [(FilterType::Box, 1.0f32), (FilterType::Gaussian, 3.0), (FilterType::BlackmanHarris, 2.0)] {
            let t = filter_table(kind, 2.0);
            for i in 0..=511 {
                assert!((t[511 + i] + t[511 - i] - 1.0).abs() < 1e-6, "{kind:?} 第 {i} 对");
            }
            assert!((t[1022] - (0.5 + half)).abs() < 1e-5, "{kind:?} 右端 {}", t[1022]);
            assert!(t.windows(2).take(1022).all(|w| w[0] <= w[1]), "{kind:?} 不单调");
        }
    }

    #[test]
    fn filter_names_parse() {
        assert_eq!(FilterType::parse("box"), Some(FilterType::Box));
        assert_eq!(FilterType::parse("gaussian"), Some(FilterType::Gaussian));
        assert_eq!(FilterType::parse("blackman-harris"), Some(FilterType::BlackmanHarris));
        assert_eq!(FilterType::parse("mitchell"), None);
    }
}
