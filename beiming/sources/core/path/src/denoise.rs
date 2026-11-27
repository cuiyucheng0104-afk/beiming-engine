// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/src/denoise.rs，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
//! Edge-avoiding a-trous wavelet denoiser (Dammertz et al. 2010) guided by first-hit albedo / normal and
//! per-pixel luminance variance of the mean. Operates on demodulated irradiance so texture detail survives.
//! The luminance edge-stopping width comes from the variance filtered over 3 x 3 pixels (SVGF, Schied et al. 2017):
//! with each pixel's own, a pixel among fireflies that drew none (low mean, low variance) rejected all its neighbours
//! and stayed a dark hole (Bistro's glossy shop windows, Zero Day's machine tops).

use glam::Vec3;
use rayon::prelude::*;

pub fn denoise(w: usize, h: usize, color: &[Vec3], albedo: &[Vec3], normal: &[Vec3], variance: &[f32], iterations: u32) -> Vec<Vec3> {
    let n = w * h;
    let eps = Vec3::splat(1e-3);
    let demod: Vec<Vec3> = (0..n).map(|i| color[i] / albedo[i].max(eps)).collect();
    let mut cur = demod;
    let mut var: Vec<f32> = (0..n).map(|i| variance[i] / albedo[i].max(eps).dot(Vec3::new(0.2126, 0.7152, 0.0722)).powi(2)).collect();
    const K: [f32; 3] = [3.0 / 8.0, 1.0 / 4.0, 1.0 / 16.0];
    for it in 0..iterations {
        let step = 1isize << it;
        // 3 x 3 Gaussian of the variance (the edge-stopping width; the propagated variance stays per pixel).
        let var_f: Vec<f32> = (0..n)
            .into_par_iter()
            .map(|i| {
                let (x, y) = ((i % w) as isize, (i / w) as isize);
                let (mut s, mut ws) = (0.0f32, 0.0f32);
                for dy in -1isize..=1 {
                    for dx in -1isize..=1 {
                        let (qx, qy) = (x + dx, y + dy);
                        if qx < 0 || qy < 0 || qx >= w as isize || qy >= h as isize {
                            continue;
                        }
                        let k = [0.5f32, 0.25][dx.unsigned_abs().min(1)] * [0.5f32, 0.25][dy.unsigned_abs().min(1)];
                        s += k * var[qy as usize * w + qx as usize];
                        ws += k;
                    }
                }
                s / ws
            })
            .collect();
        let (next, next_var): (Vec<Vec3>, Vec<f32>) = (0..n)
            .into_par_iter()
            .map(|i| {
                let (x, y) = ((i % w) as isize, (i / w) as isize);
                let cp = cur[i];
                let lp = luminance(cp);
                let np = normal[i];
                let ap = albedo[i];
                let sigma_l = 4.0 * var_f[i].max(0.0).sqrt() + 1e-4;
                let (mut sum, mut wsum, mut vsum) = (Vec3::ZERO, 0.0f32, 0.0f32);
                for dy in -2isize..=2 {
                    for dx in -2isize..=2 {
                        let (qx, qy) = (x + dx * step, y + dy * step);
                        if qx < 0 || qy < 0 || qx >= w as isize || qy >= h as isize {
                            continue;
                        }
                        let q = qy as usize * w + qx as usize;
                        let k = K[dx.unsigned_abs()] * K[dy.unsigned_abs()];
                        let cq = cur[q];
                        let wl = (-(lp - luminance(cq)).abs() / sigma_l).exp();
                        let wn = np.dot(normal[q]).max(0.0).powi(64);
                        let wa = (-(ap - albedo[q]).length_squared() / 0.01).exp();
                        let wt = k * wl * wn * wa;
                        sum += cq * wt;
                        vsum += wt * wt * var[q];
                        wsum += wt;
                    }
                }
                if wsum > 0.0 { (sum / wsum, vsum / (wsum * wsum)) } else { (cp, var[i]) }
            })
            .unzip();
        cur = next;
        var = next_var;
    }
    (0..n).map(|i| cur[i] * albedo[i].max(eps)).collect()
}

fn luminance(c: Vec3) -> f32 {
    c.dot(Vec3::new(0.2126, 0.7152, 0.0722))
}

/// 北冥：OIDN 降噪在哪台设备上做。Cycles 最终渲染默认在 CPU 上降噪（界面属性 `denoising_use_gpu` 默认关）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OidnDevice {
    Cpu,
    Cuda,
    Metal,
    /// 库自己挑（最快的一个）
    Default,
}

/// 北冥：辅助层（反照率、法线）的预过滤，照 Cycles 的 `denoising_prefilter`（默认 `Accurate`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prefilter {
    /// 辅助层当作没有噪声：不单独降噪，颜色那一遍开 `cleanAux`
    None,
    /// 颜色与带噪的辅助层一起降噪：`cleanAux` 关
    Fast,
    /// 先各用一个 RT 过滤器单独降噪反照率与法线（原地），颜色那一遍开 `cleanAux`
    Accurate,
}

impl OidnDevice {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "cpu" => Self::Cpu,
            "cuda" => Self::Cuda,
            "metal" => Self::Metal,
            "default" => Self::Default,
            _ => return None,
        })
    }
}

impl Prefilter {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "none" => Self::None,
            "fast" => Self::Fast,
            "accurate" => Self::Accurate,
            _ => return None,
        })
    }
}

/// Intel Open Image Denoise (RT filter, albedo + normal guided).
/// 北冥：照 Cycles 最终渲染的降噪接法（对照表见 ../README.md「降噪的口径」）：颜色是场景线性的样本均值，不乘曝光、不设
/// `inputScale`（库自己从图上估）；`hdr` 开、`srgb` 关；引导是反照率加法线，法线是降噪特征的相机空间均值（看 +Z、Y 向上），
/// 不归一；质量 `HIGH`，预过滤的两个过滤器也是。颜色原地输出。`cleanAux` 直接经 C 接口按 OIDN 的参数名设：`oidn` crate 2.5.1
/// 的 `RayTracing::clean_aux` 设的名字是 `clean_aux`，OIDN 2.5 不认（只认 `cleanAux`），设了等于没设；单独降噪辅助层
/// 这个 crate 也没有接口。所以整段都走 crate 的 C 绑定（`oidn::sys`），设备与缓冲用 crate 的安全接口。
#[cfg(feature = "oidn")]
pub fn oidn(w: usize, h: usize, color: &[Vec3], albedo: &[Vec3], normal: &[Vec3], device: OidnDevice, prefilter: Prefilter) -> Result<Vec<Vec3>, String> {
    use oidn::sys::*;
    let dev = match device {
        OidnDevice::Cpu => oidn::Device::cpu(),
        OidnDevice::Cuda => oidn::Device::cuda(),
        OidnDevice::Metal => oidn::Device::metal(),
        OidnDevice::Default => oidn::Device::new(),
    }
    .map_err(|e| format!("建不了 OIDN 设备（{device:?}）：{e}"))?;
    let buf = |v: &[Vec3]| dev.create_buffer(&v.iter().flat_map(|c| [c.x, c.y, c.z]).collect::<Vec<f32>>()).map_err(|e| format!("OIDN 缓冲：{e}"));
    let (c, a, n) = (buf(color)?, buf(albedo)?, buf(normal)?);
    // 一个 RT 过滤器：inputs 是 (图名, 缓冲)，输出写进 out；color 为真时是颜色那一遍（hdr、srgb、cleanAux）
    let run = |inputs: &[(&std::ffi::CStr, &oidn::Buffer)], out: &oidn::Buffer, color: bool, clean_aux: bool| -> Result<(), String> {
        dev.get_error().map_err(|e| format!("OIDN 之前的错：{e}"))?;
        unsafe {
            let f = oidnNewFilter(dev.raw(), c"RT".as_ptr());
            if f.is_null() {
                return Err(format!("oidnNewFilter：{:?}", dev.get_error()));
            }
            for (name, b) in inputs.iter().chain([(c"output", out)].iter()) {
                oidnSetFilterImage(f, name.as_ptr(), b.raw(), OIDNFormat_OIDN_FORMAT_FLOAT3, w, h, 0, 0, 0);
            }
            if color {
                oidnSetFilterBool(f, c"hdr".as_ptr(), true);
                oidnSetFilterBool(f, c"srgb".as_ptr(), false);
                oidnSetFilterBool(f, c"cleanAux".as_ptr(), clean_aux);
            }
            oidnSetFilterInt(f, c"quality".as_ptr(), OIDNQuality_OIDN_QUALITY_HIGH as _);
            oidnCommitFilter(f);
            oidnExecuteFilter(f);
            oidnReleaseFilter(f);
        }
        dev.get_error().map_err(|e| format!("OIDN：{e}"))
    };
    if prefilter == Prefilter::Accurate {
        run(&[(c"albedo", &a)], &a, false, false)?;
        run(&[(c"normal", &n)], &n, false, false)?;
    }
    run(&[(c"color", &c), (c"albedo", &a), (c"normal", &n)], &c, true, prefilter != Prefilter::Fast)?;
    let out = c.read().map_err(|e| format!("读回 OIDN 的输出：{e}"))?;
    Ok(out.chunks(3).map(|p| Vec3::new(p[0], p[1], p[2])).collect())
}

#[cfg(not(feature = "oidn"))]
pub fn oidn(_w: usize, _h: usize, _c: &[Vec3], _a: &[Vec3], _n: &[Vec3], _d: OidnDevice, _p: Prefilter) -> Result<Vec<Vec3>, String> {
    Err("这个程序没编进 OIDN（cargo 特性 oidn）".into())
}
