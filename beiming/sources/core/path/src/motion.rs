// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: MIT
//! 北冥新写的文件，不是上游 ThreeRT 的。输出通道 `motion`（输出通道契约 5.6，快门角为 0）：辅助样本的命中点在第 F + 1 帧
//! 的屏幕位置减它在第 F 帧的屏幕位置，像素每帧，原点左上、y 向下；最后一帧向后差分（第 F 帧减第 F − 1 帧），只有一帧的包
//! 写 0。内核的辅助样本只写命中点（世界坐标）与物体号（输出缓冲 `FILM_AUX_HIT`），另一帧的位置与两次投影在这里用双精度算：
//! 刚体是 M_G × M_F⁻¹ × X；动态网格是命中三角形的重心坐标在另一帧的同一个三角形上取点（`dynamic_point`）。
use glam::{DMat4, DVec2, DVec3, Mat4};
use std::collections::HashMap;

/// 一帧的相机，照 `scene::camera_data` 的取法建基（前方 = 矩阵 × (0, 0, −1)，上 = 矩阵 × (0, 1, 0)，右 = 前 × 上，
/// 再上 = 右 × 前），全用双精度；投影是辅助样本那条射线（integrator.wgsl `aux_sample`）的反算。
#[derive(Clone, Copy, Debug)]
pub struct Cam {
    pub pos: DVec3,
    pub right: DVec3,
    pub up: DVec3,
    pub fwd: DVec3,
    pub tan_half: f64,
    pub aspect: f64,
}

impl Cam {
    /// `m`：相机表这一帧的 mat16（相机自己的坐标到世界，列主序）；`fov_y`：垂直视场角，弧度；`aspect`：画面宽 ÷ 高。
    pub fn new(m: Mat4, fov_y: f64, aspect: f64) -> Cam {
        let m = m.as_dmat4();
        let fwd = m.transform_vector3(DVec3::NEG_Z).normalize();
        let up = m.transform_vector3(DVec3::Y).normalize();
        let right = fwd.cross(up).normalize();
        Cam { pos: m.transform_point3(DVec3::ZERO), right, up: right.cross(fwd), fwd, tan_half: (fov_y * 0.5).tan(), aspect }
    }

    /// 世界坐标里的点 `x` 投到 `w`×`h` 的画面上的位置（像素，原点左上、y 向下，像素 (i, j) 的中心是 (i + 0.5, j + 0.5)）。
    /// 点在相机所在的平面上或背后（沿前方的深度不大于 0）时没有定义，返回 None。
    pub fn screen(&self, x: DVec3, w: u32, h: u32) -> Option<DVec2> {
        let c = x - self.pos;
        let z = c.dot(self.fwd);
        if !(z > 0.0) {
            return None;
        }
        let ndc = DVec2::new(c.dot(self.right) / (z * self.tan_half * self.aspect), c.dot(self.up) / (z * self.tan_half));
        Some(DVec2::new((ndc.x + 1.0) * 0.5 * w as f64, (1.0 - ndc.y) * 0.5 * h as f64))
    }
}

/// 求一帧 motion 要的东西：这一帧（F）与另一帧（G = F + 1，或向后差分时的 F − 1）的相机，每个内核物体（物体表下标）
/// 从第 F 帧到第 G 帧的刚体变换 M_G × M_F⁻¹。
#[derive(Clone, Debug)]
pub struct Step {
    pub here: Cam,
    pub there: Cam,
    /// 另一帧是不是 F + 1；不是（向后差分）时结果取反，仍是「后一帧减前一帧」。
    pub forward: bool,
    pub objects: HashMap<u32, DMat4>,
}

/// 第 F 帧与第 G 帧的实例矩阵（列主序 f32，原样）给出的刚体变换 M_G × M_F⁻¹。M_F 的行列式是 0 时这个实例第 F 帧不画，
/// 辅助样本打不到它，返回 None。
pub fn rigid(m_f: Mat4, m_g: Mat4) -> Option<DMat4> {
    let f = m_f.as_dmat4();
    (f.determinant() != 0.0).then(|| m_g.as_dmat4() * f.inverse())
}

/// 动态网格的命中点在另一帧的位置：另一帧同一个三角形的三个顶点（网格自己的坐标）按命中的重心坐标取点（`u` 对第二个顶点、
/// `v` 对第三个，第一个是 1 − u − v，同 shader.wgsl `shader_setup_from_hit`），再用另一帧的矩阵 `m_g` 变到世界坐标。
/// 场景包契约的动态网格文件写法还没定，读入器不收带 `dynamic` 的包，所以这个函数现在只有库测试调。
pub fn dynamic_point(tri_g: [DVec3; 3], u: f64, v: f64, m_g: DMat4) -> DVec3 {
    m_g.transform_point3(tri_g[0] * (1.0 - u - v) + tri_g[1] * u + tri_g[2] * v)
}

impl Step {
    /// 一个像素的 motion：`hit` 是 `FILM_AUX_HIT` 的原值（xyz 命中点，w 物体表下标加 1，没打到是 0）。没打到、或者命中点
    /// 在某一帧落到相机背后：(0, 0)。命中的物体不在 `objects` 里是读入器的毛病，报错，不编一个数。
    pub fn motion(&self, hit: [f32; 4], w: u32, h: u32) -> Result<[f32; 2], String> {
        if hit[3] == 0.0 {
            return Ok([0.0, 0.0]);
        }
        let object = hit[3] as u32 - 1;
        let d = self.objects.get(&object).ok_or_else(|| format!("辅助样本打到了物体 {object}，它不是场景包实例表里画出来的行"))?;
        let x = DVec3::new(hit[0] as f64, hit[1] as f64, hit[2] as f64);
        let (Some(a), Some(b)) = (self.here.screen(x, w, h), self.there.screen(d.transform_point3(x), w, h)) else {
            return Ok([0.0, 0.0]);
        };
        let v = if self.forward { b - a } else { a - b };
        Ok([v.x as f32, v.y as f32])
    }
}

/// 整帧的 motion，行主序每个像素 [X, Y]。`step` 是 None（只有一帧的包）时全 0。
pub fn layer(step: Option<&Step>, hits: &[[f32; 4]], w: u32, h: u32) -> Result<Vec<f32>, String> {
    let Some(s) = step else { return Ok(vec![0.0; hits.len() * 2]) };
    let mut out = Vec::with_capacity(hits.len() * 2);
    for hit in hits {
        out.extend(s.motion(*hit, w, h)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;

    fn cam_at(z: f32) -> Cam {
        Cam::new(Mat4::from_translation(Vec3::new(0.0, 0.0, z)), 0.6, 2.0)
    }

    #[test]
    fn screen_is_the_aux_ray_inverted() {
        // 像素中心的那条射线（integrator.wgsl aux_sample 的式子）上的点投回来就是像素中心
        let c = cam_at(3.0);
        let (w, h) = (64u32, 32u32);
        for (i, j) in [(0u32, 0u32), (17, 5), (63, 31)] {
            let ndc = DVec2::new((i as f64 + 0.5) / w as f64 * 2.0 - 1.0, 1.0 - (j as f64 + 0.5) / h as f64 * 2.0);
            let d = c.fwd + c.right * (ndc.x * c.tan_half * c.aspect) + c.up * (ndc.y * c.tan_half);
            let s = c.screen(c.pos + d * 2.5, w, h).unwrap();
            assert!((s - DVec2::new(i as f64 + 0.5, j as f64 + 0.5)).abs().max_element() < 1e-12, "{s}");
        }
        // 背后与相机平面上：没有定义
        assert!(c.screen(DVec3::new(0.0, 0.0, 4.0), w, h).is_none());
        assert!(c.screen(DVec3::new(1.0, 0.0, 3.0), w, h).is_none());
    }

    #[test]
    fn rigid_translation_and_the_last_frame() {
        // 相机不动，物体沿 +x 每帧走 0.1 m，深度 3 m：屏幕上每帧 0.1 / (3 · tan 0.3 · 2) · 64 / 2 像素，y 不变
        let (w, h) = (64u32, 32u32);
        let m0 = Mat4::IDENTITY;
        let m1 = Mat4::from_translation(Vec3::new(0.1, 0.0, 0.0));
        let px = 0.1f32 as f64 / (3.0 * 0.3f64.tan() * 2.0) * w as f64 / 2.0;
        let fwd = Step { here: cam_at(3.0), there: cam_at(3.0), forward: true, objects: HashMap::from([(4, rigid(m0, m1).unwrap())]) };
        let m = fwd.motion([0.0, 0.0, 0.0, 5.0], w, h).unwrap();
        assert!((m[0] as f64 - px).abs() < 1e-5 && m[1] == 0.0, "{m:?} vs {px}");
        // 向后差分：第 1 帧是最后一帧，另一帧是第 0 帧，结果仍是后一帧减前一帧
        let back = Step { here: cam_at(3.0), there: cam_at(3.0), forward: false, objects: HashMap::from([(4, rigid(m1, m0).unwrap())]) };
        let b = back.motion([0.1, 0.0, 0.0, 5.0], w, h).unwrap();
        assert!((b[0] - m[0]).abs() < 1e-6 && b[1] == 0.0, "{b:?} vs {m:?}");
        // 没打到：0；只有一帧：全 0；打到实例表之外的物体：报错
        assert_eq!(fwd.motion([1.0, 2.0, 3.0, 0.0], w, h).unwrap(), [0.0, 0.0]);
        assert_eq!(layer(None, &[[0.0, 0.0, 0.0, 5.0]; 3], w, h).unwrap(), vec![0.0; 6]);
        assert!(fwd.motion([0.0, 0.0, 0.0, 9.0], w, h).is_err());
        // 第 F 帧行列式为 0 的实例不画
        assert!(rigid(Mat4::ZERO, m1).is_none());
    }

    #[test]
    fn dynamic_point_takes_the_barycentrics_to_the_other_frame() {
        let tri = [DVec3::new(0.0, 0.0, 0.0), DVec3::new(1.0, 0.0, 0.0), DVec3::new(0.0, 1.0, 0.0)];
        // 另一帧三角形整体沿 z 挪 0.5、第二个顶点再往 x 拉 1：重心 (u, v) = (0.25, 0.5) 的点落在 (0.5, 0.5, 0.5)，再平移 (0, 0, 1)
        let next = [tri[0] + DVec3::Z * 0.5, DVec3::new(2.0, 0.0, 0.5), tri[2] + DVec3::Z * 0.5];
        let p = dynamic_point(next, 0.25, 0.5, DMat4::from_translation(DVec3::Z));
        assert!((p - DVec3::new(0.5, 0.5, 1.5)).length() < 1e-15, "{p}");
        // 三角形不动、矩阵不动：还是原来的点
        let q = dynamic_point(tri, 0.25, 0.5, DMat4::IDENTITY);
        assert!((q - DVec3::new(0.25, 0.5, 0.0)).length() < 1e-15, "{q}");
    }
}
