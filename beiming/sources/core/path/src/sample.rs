// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/src/sample.rs，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// SPDX-FileCopyrightText: 2026 Meshy LLC
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: MIT AND Apache-2.0
// 多方许可。上游的与北冥新写的部分是 MIT。照 Cycles（Blender v5.2.3，路径相对 intern/cycles/）取的部分是 Apache-2.0
// （许可全文见仓库根的 LICENSES/Apache-2.0.txt）：
//   每次弹射的随机维度个数 PRNG_BOUNCE_NUM 的名字与数值：kernel/types.h（PathTraceDimension）
//   像素种子的式子（rng_pixel）：kernel/sample/pattern.h（path_rng_pixel_init）
//! The kernel's sampler on the CPU (shaders/sample.wgsl, the same numbers): shuffled, Owen-scrambled Sobol (Burley
//! 2020). For tests: the sequence's properties here, and the shader held to this.

/// Direction numbers of Sobol dimensions 1-3 (Joe & Kuo), bit-reversed: `SOBOL_REV` in sample.wgsl.
const SOBOL_REV: [[u32; 32]; 3] = {
    const fn dirs(s: usize, a: u32, m0: [u32; 3]) -> [u32; 32] {
        let mut m = [0u32; 32];
        let mut i = 0;
        while i < 32 {
            m[i] = if i < s {
                m0[i]
            } else {
                let mut v = m[i - s] ^ (m[i - s] << s);
                let mut k = 1;
                while k < s {
                    v ^= ((a >> (s - 1 - k)) & 1) * (m[i - k] << k);
                    k += 1;
                }
                v
            };
            i += 1;
        }
        let mut out = [0u32; 32];
        let mut i = 0;
        while i < 32 {
            out[i] = (m[i] << (31 - i)).reverse_bits();
            i += 1;
        }
        out
    }
    [dirs(1, 0, [1, 0, 0]), dirs(2, 1, [1, 3, 0]), dirs(3, 1, [1, 3, 1])]
};

pub fn owen_rev(mut n: u32, seed: u32) -> u32 {
    n ^= n.wrapping_mul(0x3d20adea);
    n = n.wrapping_add(seed);
    n = n.wrapping_mul((seed >> 16) | 1);
    n ^= n.wrapping_mul(0x05526c56);
    n ^= n.wrapping_mul(0x53a22864);
    n
}

pub fn hash_hp(mut i: u32) -> u32 {
    i ^= i >> 16;
    i = i.wrapping_mul(0x21f0aaad);
    i ^= i >> 15;
    i = i.wrapping_mul(0xd35a2d97);
    i ^= i >> 15;
    i ^ 0xe6fe3beb
}

pub fn sobol_owen(rev_index: u32, dim: usize, seed: u32) -> f32 {
    let mut r = 0;
    if dim == 0 {
        r = rev_index.reverse_bits();
    } else {
        let (mut x, mut i) = (rev_index, 0usize);
        for _ in 0..16 {
            if x == 0 {
                break;
            }
            let j = x.leading_zeros() as usize;
            r ^= SOBOL_REV[dim - 1][i + j];
            i += j + 1;
            x = (x << j) << 1;
        }
    }
    owen_rev(r, seed).reverse_bits() as f32 * (1.0 / 4294967808.0)
}

/// `rng_index_at` of sample.wgsl: the shuffled index, masked (`KernelIntegrator::sobol_index_mask`).
fn rng_index_at(index: u32, salt: u32) -> u32 {
    owen_rev(index.reverse_bits(), salt) & crate::gpu::SOBOL_INDEX_MASK
}

/// `rng1` of sample.wgsl for a pixel seed (`state.rng_pixel`), a sample index and a dimension id.
pub fn rng1(pixel_seed: u32, index: u32, d: u32) -> f32 {
    let s = pixel_seed ^ hash_hp(d);
    sobol_owen(rng_index_at(index, s ^ 0xbff95bfe), 0, s ^ 0x635c77bd)
}

/// `rng2` of sample.wgsl.
pub fn rng2(pixel_seed: u32, index: u32, d: u32) -> [f32; 2] {
    let s = pixel_seed ^ hash_hp(d);
    let i = rng_index_at(index, s ^ 0xf8ade99a);
    [sobol_owen(i, 0, s ^ 0xe0aaaf76), sobol_owen(i, 1, s ^ 0x94964d4e)]
}

/// 北冥：`path_branched_rng_2D` of sample.wgsl（`index` 已是样本号乘分支数加分支号，`d` 是偏移加维度）：下标照 `rng2`
/// 按像素打乱，点的 Owen 打乱只用维度的种子（蓝噪声图案的取法，见 STRUCTURES.md 第 57 条）。
pub fn branched2(pixel_seed: u32, index: u32, d: u32) -> [f32; 2] {
    let i = rng_index_at(index, pixel_seed ^ hash_hp(d) ^ 0xf8ade99a);
    let v = hash_hp(d);
    [sobol_owen(i, 0, v ^ 0xe0aaaf76), sobol_owen(i, 1, v ^ 0x94964d4e)]
}

/// `rng3` of sample.wgsl.
pub fn rng3(pixel_seed: u32, index: u32, d: u32) -> [f32; 3] {
    let s = pixel_seed ^ hash_hp(d);
    let i = rng_index_at(index, s ^ 0xcaa726ac);
    [sobol_owen(i, 0, s ^ 0x9e78e391), sobol_owen(i, 1, s ^ 0x67c33241), sobol_owen(i, 2, s ^ 0x78c395c5)]
}

/// `rng4` of sample.wgsl.
pub fn rng4(pixel_seed: u32, index: u32, d: u32) -> [f32; 4] {
    let s = pixel_seed ^ hash_hp(d);
    let i = rng_index_at(index, s ^ 0xc2c1a055);
    [sobol_owen(i, 0, s ^ 0x39468210), sobol_owen(i, 1, s ^ 0xe9d8a845), sobol_owen(i, 2, s ^ 0x5f32b482), sobol_owen(i, 3, s ^ 0x1524cc56)]
}

// 北冥：「哪个决定用哪一维」的编号，sample.wgsl 里同名的函数与常数在 CPU 上的一份。三个名字空间按最高两位分开：
// 照 Cycles 编号的（`rng_offset` 加 `PRNG_*`）最高位是 0，`rng_legacy` 是 10，`rng_sub` 是 11。

/// 每次弹射占的随机维度个数（integrator.wgsl 的 `PRNG_BOUNCE_NUM`，照 Cycles）：`state.rng_offset` 的初值与步长。
pub const PRNG_BOUNCE_NUM: u32 = 16;

/// sample.wgsl 的 `rng_start`：像素种子。`seed` 是 `KernelIntegrator::seed`（用户种子过一次 `hash_hp`）。
pub fn rng_pixel(x: u32, y: u32, seed: u32) -> u32 {
    crate::cycles_hash::hash_iqnt2d(x, y) ^ seed
}

/// sample.wgsl 的 `rng_legacy`：还没照 Cycles 移植的决定的编号。`slot` 小于 `PRNG_BOUNCE_NUM`。
pub fn rng_legacy(rng_offset: u32, slot: u32) -> u32 {
    (hash_hp(rng_offset + slot) & 0x3fff_ffff) | 0x8000_0000
}

/// sample.wgsl 的 `rng_sub`：决定 `d` 的第 `k` 个子流。
pub fn rng_sub(d: u32, k: u32) -> u32 {
    hash_hp(d ^ hash_hp(k.wrapping_add(0x9e37_79b9))) | 0xc000_0000
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table is sample.wgsl's, and Cycles' (`sobol_burley_table`, its last entries).
    #[test]
    fn the_directions_are_the_shaders() {
        let wgsl = include_str!("../shaders/sample.wgsl");
        for row in SOBOL_REV {
            for v in &row[..16] {
                assert!(wgsl.contains(&format!("0x{v:08x}u")), "{v:#010x}");
            }
        }
        assert_eq!([SOBOL_REV[0][31], SOBOL_REV[1][31], SOBOL_REV[2][31]], [0xffffffff, 0xaaaa00a3, 0xc900a00a]);
    }

    /// Each 2D pair of a 4D point set of 2^m samples is a (0, m, 2)-net: every elementary interval of area 2^-m holds
    /// exactly one point (dimensions 0-1 of Sobol are; the shuffle and Owen scrambling keep it). And 1D strata.
    #[test]
    fn the_first_2_to_the_m_points_are_a_net() {
        for (seed, d) in [(0u32, 0u32), (0x1234_5678, 7), (hash_hp(99), 0xdead)] {
            for m in [4u32, 6, 8] {
                let n = 1u32 << m;
                let pts: Vec<[f32; 4]> = (0..n).map(|i| rng4(seed, i, d)).collect();
                let cell = |v: f32, k: u32| ((v * (1u64 << k) as f32) as u32).min((1 << k) - 1);
                for a in 0..=m {
                    let mut seen = vec![false; n as usize];
                    for p in &pts {
                        let c = (cell(p[0], a) << (m - a)) | cell(p[1], m - a);
                        assert!(!std::mem::replace(&mut seen[c as usize], true), "seed {seed:#x} d {d} m {m}: interval {a}x{} twice", m - a);
                    }
                }
                for k in 0..4 {
                    let mut strata: Vec<u32> = pts.iter().map(|p| cell(p[k], m)).collect();
                    strata.sort();
                    assert_eq!(strata, (0..n).collect::<Vec<_>>(), "dimension {k}");
                }
                assert!(pts.iter().flatten().all(|v| (0.0..1.0).contains(v)));
            }
        }
    }

    /// sample.wgsl on the GPU gives these numbers, offline (`LIVE` false; to the last place: a u32's conversion to f32
    /// may round either way). (Skipped without a GPU.)
    #[test]
    fn the_shader_is_this() {
        use wgpu::util::DeviceExt;
        let g = match crate::gpu::Gpu::new_with(crate::gpu::GpuOptions::default()) {
            Ok(g) => g,
            Err(e) => return eprintln!("skipped: {e}"),
        };
        let d = &g.device;
        let seeds = [0u32, 0x1234_5678, hash_hp(99)];
        // 每个 i 写 16 个数：rng4(rng_legacy(槽位))、path_rng_3D、path_rng_1D、分支版的 2 维、一个子流的 2 维，再加
        // 三个编号（像素种子、rng_legacy、rng_sub）。路径状态与全局参数在这里用只含所需字段的替身。
        let stub = "const LIVE: bool = false;
struct PathLegacy { rng_path: u32 };
struct PathState { sample: u32, bounce: u32, rng_pixel: u32, rng_offset: u32, legacy: PathLegacy };
var<private> state: PathState;
struct KernelIntegrator { seed: u32, sobol_index_mask: u32 };
struct Params { integrator: KernelIntegrator };
var<private> P: Params;
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    P.integrator.sobol_index_mask = MASK;
    P.integrator.seed = SEEDS[i % 3u];
    state.rng_offset = 16u * (1u + i % 7u);
    rng_start(vec2<u32>(i * 13u, i / 3u), i, P.integrator.seed, 0u);
    let a = rng4(rng_legacy(1u + i % 14u));
    let b = path_rng_3D(PRNG_SURFACE_BSDF);
    let c = path_rng_1D(PRNG_TERMINATE);
    let e = path_branched_rng_2D(i % 4u, 4u, PRNG_SURFACE_AO);
    let s = rng_sub(rng_legacy(6u) ^ 0x40000000u, i);
    let f = rng2(s);
    let o = i * 16u;
    for (var k = 0u; k < 4u; k++) { out[o + k] = bitcast<u32>(a[k]); }
    for (var k = 0u; k < 3u; k++) { out[o + 4u + k] = bitcast<u32>(b[k]); }
    out[o + 7u] = bitcast<u32>(c);
    out[o + 8u] = bitcast<u32>(e.x);
    out[o + 9u] = bitcast<u32>(e.y);
    out[o + 10u] = bitcast<u32>(f.x);
    out[o + 11u] = bitcast<u32>(f.y);
    out[o + 12u] = state.rng_pixel;
    out[o + 13u] = rng_legacy(1u + i % 14u);
    out[o + 14u] = s;
}
";
        let src = format!("{}\n{}\nconst MASK: u32 = {}u;\nconst SEEDS = array<u32, 3>({}u, {}u, {}u);\n{stub}", include_str!("../shaders/sample.wgsl"), include_str!("../shaders/hash.wgsl"), crate::gpu::SOBOL_INDEX_MASK, seeds[0], seeds[1], seeds[2]);
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(src.into()) });
        let pipeline = d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: None, layout: None, module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
        let n = 256u32;
        let buf = d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: &vec![0u8; n as usize * 64], usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC });
        let read = d.create_buffer(&wgpu::BufferDescriptor { label: None, size: n as u64 * 64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let bg = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipeline.get_bind_group_layout(0), entries: &[wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() }] });
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bg, &[]);
            pass.dispatch_workgroups(n / 64, 1, 1);
        }
        enc.copy_buffer_to_buffer(&buf, 0, &read, 0, n as u64 * 64);
        g.queue.submit([enc.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        d.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let words: Vec<u32> = bytemuck::cast_slice(&read.slice(..).get_mapped_range().unwrap()).to_vec();
        for i in 0..n {
            let w = &words[(i * 16) as usize..(i * 16 + 16) as usize];
            let offset = PRNG_BOUNCE_NUM * (1 + i % 7);
            let pixel = rng_pixel(i * 13, i / 3, seeds[(i % 3) as usize]);
            let legacy = rng_legacy(offset, 1 + i % 14);
            let sub = rng_sub(rng_legacy(offset, 6) ^ 0x4000_0000, i);
            assert_eq!((w[12], w[13], w[14]), (pixel, legacy, sub), "index {i}: the pixel seed, rng_legacy, rng_sub");
            // (path_rng_*: the offset plus Cycles' enumeration; the branched one: index * branches + branch, the points'
            // scramble seeded by the dimension alone.)
            let mut want = rng4(pixel, i, legacy).to_vec();
            want.extend(rng3(pixel, i, offset + 3));
            want.push(rng1(pixel, i, offset));
            want.extend(branched2(pixel, i * 4 + i % 4, offset + 4));
            want.extend(rng2(pixel, i, sub));
            for (k, want) in want.into_iter().enumerate() {
                let got = f32::from_bits(w[k]);
                assert!((got - want).abs() <= 1.2e-7, "index {i} number {k}: {got} on the GPU, {want} here");
            }
        }
    }

    /// 「哪个决定用哪一维」的编号互不相同：一条路径上两个决定拿到同一个编号，就是用同一串随机数，结果有偏而且白炉
    /// 这类读数看不出来。照 sample.wgsl 的三个名字空间与各着色器里的用法，把弹射 0 到 64 的编号全部枚举出来查。
    ///
    /// 这里是登记表：着色器里加槽位、加子流、改子流序号的区段，都要在这里同步加，否则这条测试管不到。
    /// 区段的长度是登记的保证范围（超出的序号没有枚举过；哈希出来的 30 位编号，每一对相撞的概率是 2^-30）。
    #[test]
    fn the_dimension_ids_are_distinct() {
        const BOUNCES: u32 = 65; // 弹射 0 到 64
        const SLOTS: u32 = PRNG_BOUNCE_NUM; // 上游槽位 D_*：0 到 14 用着或退役，15 空着，全枚举
        const DIR_LIGHTS: u32 = 8; // 方向光的盏数（子流序号是第几盏）
        const LOCAL_LIGHTS: u32 = 64; // 本地灯逐盏求值时的灯号（子流序号是灯在灯表里的下标）
        const LIGHT_CANDIDATES: u32 = 8; // 本地灯重采样的候选数（pathtrace.wgsl 的 RIS_M）
        const LISTED_CANDIDATES: u32 = 16; // 灯光瓦片给的候选，序号 0x1000 + k，k 从候选数起
        const EMITTER_CANDIDATES: u32 = 16; // 发光体重采样的候选数（EMIT_RIS_M 是 6；有光树时由参数给）
        const MEDIA: u32 = 4; // 一条射线穿过的介质个数（介质跟踪步的序号高 8 位）
        const TRACK_STEPS: u32 = 32; // 一条射线上的介质跟踪步数

        #[derive(Default)]
        struct Ids {
            all: Vec<(u32, &'static str, u32)>, // 编号、哪个决定、第几次弹射
            rays: Vec<(u32, &'static str, u32)>, // 交给阴影射线的编号：它下面是介质的跟踪步（白噪声）
            bounce: u32,
        }
        impl Ids {
            fn cycles(&mut self, d: u32, what: &'static str) {
                assert!(d < 1 << 31, "{what}：照 Cycles 的编号 {d:#x} 不小于 2^31");
                self.all.push((d, what, self.bounce));
            }
            fn legacy(&mut self, slot: u32) -> u32 {
                let d = rng_legacy(PRNG_BOUNCE_NUM * (self.bounce + 1), slot);
                assert_eq!(d >> 30, 0b10, "rng_legacy 的最高两位");
                d
            }
            fn sub(&self, d: u32, k: u32) -> u32 {
                let s = rng_sub(d, k);
                assert_eq!(s >> 30, 0b11, "rng_sub 的最高两位");
                s
            }
            fn draw(&mut self, d: u32, what: &'static str) {
                self.all.push((d, what, self.bounce));
            }
            fn ray(&mut self, d: u32, what: &'static str) {
                self.draw(d, what);
                self.rays.push((d, what, self.bounce));
            }
            // light.wgsl sample_emitter(rd)：emitter_draw(rd)，再 rng_sub(rd, 1)
            fn emitter(&mut self, rd: u32, what: &'static str) {
                self.draw(rd, what);
                self.draw(self.sub(rd, 1), what);
            }
            // light.wgsl sample_emitter_ris(rd)：第 k 个候选 dk = rng_sub(rd, k) 与 rng_sub(dk, 1)。与同一个 rd 上的
            // sample_emitter 二选一（它用的 rd 与 rng_sub(rd, 1) 都在这个集合里，所以 rd 只记一次）。
            fn emitter_ris(&mut self, rd: u32, what: &'static str) {
                self.draw(rd, what);
                for k in 0..EMITTER_CANDIDATES {
                    let dk = self.sub(rd, k);
                    self.draw(dk, what);
                    self.draw(self.sub(dk, 1), what);
                }
            }
            // light.wgsl local_lights(rd)：逐盏（雾里没有这一段）、候选、选中那盏的阴影射线
            fn local_lights(&mut self, rd: u32, vol: bool, what: &'static str) {
                if !vol {
                    for i in 0..LOCAL_LIGHTS {
                        self.draw(self.sub(rd, i), what);
                        self.ray(self.sub(rd ^ 0x4000_0000, i), what);
                    }
                }
                self.draw(self.sub(rd ^ 0x8000_0000, 0x2000), what);
                for k in 0..LIGHT_CANDIDATES {
                    self.draw(self.sub(rd ^ 0x8000_0000, k), what);
                }
                for k in LIGHT_CANDIDATES..LIGHT_CANDIDATES + LISTED_CANDIDATES {
                    self.draw(self.sub(rd ^ 0x8000_0000, 0x1000 + k), what);
                }
                self.ray(self.sub(rd, 0xffff_ffff), what);
            }
        }

        let mut ids = Ids::default();
        let mut tracks = vec![];
        // 相机的两个决定不加偏移（PRNG_FILTER、PRNG_LENS_TIME）
        ids.cycles(0, "相机：像素滤波");
        ids.cycles(1, "相机：镜头");
        for bounce in 0..BOUNCES {
            ids.bounce = bounce;
            // 照 Cycles 的枚举：每次弹射 16 个位置全算上（用着的、给 Cycles 留的、空闲的）
            for e in 0..PRNG_BOUNCE_NUM {
                ids.cycles(PRNG_BOUNCE_NUM * (bounce + 1) + e, "照 Cycles 的枚举");
            }
            let slot: Vec<u32> = (0..SLOTS).map(|s| ids.legacy(s)).collect();
            // 槽位 0、2 退役，15 空着：编号仍然占着
            for s in [0, 2, 15] {
                ids.draw(slot[s], "退役或空着的槽位");
            }
            ids.draw(slot[1], "D_BSDF"); // closure.wgsl sample_bsdf
            ids.draw(slot[3], "D_PICK"); // light.wgsl direct_light
            for i in 0..DIR_LIGHTS {
                ids.draw(ids.sub(slot[4], i), "D_SUN"); // light.wgsl direct_light、sun_light
                ids.ray(ids.sub(slot[5], i), "D_SUN_VIS");
            }
            ids.local_lights(slot[6], false, "D_LOCAL");
            ids.emitter_ris(slot[7], "D_EMIT");
            ids.ray(slot[8], "D_EMIT_VIS");
            ids.draw(slot[9], "D_ENV"); // light.wgsl sample_env
            ids.ray(slot[10], "D_ENV_VIS");
            // volume.wgsl fog_scatter(rd)
            let rd = slot[11];
            ids.draw(rd, "D_FOG");
            for i in 0..DIR_LIGHTS {
                ids.ray(ids.sub(rd, 0x30 + i), "D_FOG");
            }
            for c in 0..4 {
                ids.emitter(ids.sub(rd, 0x10 + c), "D_FOG");
                ids.draw(ids.sub(rd, 0x20 + c), "D_FOG");
            }
            ids.ray(ids.sub(rd, 0x40), "D_FOG");
            ids.local_lights(ids.sub(rd, 0x50), true, "D_FOG");
            // volume.wgsl media_track(rd)：跟踪步在下面单查
            ids.draw(slot[12], "D_MEDIA");
            tracks.push((slot[12], bounce));
            ids.draw(slot[13], "D_PHASE"); // volume.wgsl sample_hg
            // volume.wgsl phase_direct(rd)
            let rd = slot[14];
            ids.draw(rd, "D_VOL_LIGHT");
            for i in 0..DIR_LIGHTS {
                ids.draw(ids.sub(rd, i), "D_VOL_LIGHT");
                ids.ray(ids.sub(rd, 0x100 + i), "D_VOL_LIGHT");
            }
            for k in 0..3 {
                ids.draw(ids.sub(rd, 0x200 + k), "D_VOL_LIGHT");
            }
            ids.ray(ids.sub(rd, 0x300), "D_VOL_LIGHT");
            ids.emitter(ids.sub(rd, 0x400), "D_VOL_LIGHT");
            ids.ray(ids.sub(rd, 0x401), "D_VOL_LIGHT");
            ids.draw(ids.sub(rd, 0x500), "D_VOL_LIGHT");
            ids.ray(ids.sub(rd, 0x501), "D_VOL_LIGHT");
        }

        // 一、取 Sobol 的每个决定的编号，加上每条阴影射线、每次介质跟踪拿到的编号：全部弹射放在一起互不相同。
        let mut all = ids.all.clone();
        all.sort();
        for w in all.windows(2) {
            assert!(w[0].0 != w[1].0, "编号 {:#x} 撞了：第 {} 次弹射的 {} 与第 {} 次弹射的 {}", w[0].0, w[0].2, w[0].1, w[1].2, w[1].1);
        }
        // 二、介质的跟踪步（白噪声 rng_hash，循环多长事先不知道）：同一条射线之内互不相同。
        // 不同射线的跟踪步之间没有枚举：照上面的区段它们有几十万个，30 位的哈希编号装不下「全部互不相同」。
        let distinct = |mut v: Vec<u32>, what: &str, bounce: u32| {
            let n = v.len();
            v.sort();
            v.dedup();
            assert_eq!(v.len(), n, "第 {bounce} 次弹射的 {what}：一条射线之内的介质跟踪步撞了编号");
        };
        // volume.wgsl media_tr(rd)：第 k 个介质的第 step 步是 rng_sub(rd, (k << 24) + step)
        for &(rd, what, bounce) in &ids.rays {
            distinct((0..MEDIA).flat_map(|k| (0..TRACK_STEPS).map(move |step| rng_sub(rd, (k << 24) + step))).collect(), what, bounce);
        }
        // volume.wgsl media_track(rd)：第 stp 步是 rng_sub(rd, stp)，那一步上选介质是 rng_sub(rng_sub(rd, stp + 1), k)
        for &(rd, bounce) in &tracks {
            let mut v: Vec<u32> = (0..=TRACK_STEPS).map(|stp| rng_sub(rd, stp)).collect();
            v.extend((1..=TRACK_STEPS).flat_map(|stp| (0..MEDIA).map(move |k| rng_sub(rng_sub(rd, stp), k))));
            distinct(v, "D_MEDIA", bounce);
        }
        eprintln!("编号 {} 个，阴影射线 {} 条，介质跟踪 {} 次", all.len(), ids.rays.len(), tracks.len());
    }

    /// Different dimension ids and seeds give different (uncorrelated) sequences.
    #[test]
    fn ids_and_seeds_decorrelate() {
        let a: Vec<[f32; 2]> = (0..64).map(|i| rng2(5, i, 1)).collect();
        let b: Vec<[f32; 2]> = (0..64).map(|i| rng2(5, i, 2)).collect();
        let c: Vec<[f32; 2]> = (0..64).map(|i| rng2(6, i, 1)).collect();
        let corr = |x: &[[f32; 2]], y: &[[f32; 2]]| {
            let (mx, my) = (x.iter().map(|p| p[0]).sum::<f32>() / 64.0, y.iter().map(|p| p[0]).sum::<f32>() / 64.0);
            let cov: f32 = x.iter().zip(y).map(|(p, q)| (p[0] - mx) * (q[0] - my)).sum();
            let (vx, vy): (f32, f32) = (x.iter().map(|p| (p[0] - mx).powi(2)).sum(), y.iter().map(|q| (q[0] - my).powi(2)).sum());
            cov / (vx * vy).sqrt()
        };
        assert!(corr(&a, &b).abs() < 0.35 && corr(&a, &c).abs() < 0.35, "{} {}", corr(&a, &b), corr(&a, &c));
    }
}
