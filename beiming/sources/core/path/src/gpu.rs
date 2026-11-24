// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/src/gpu.rs，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// SPDX-FileCopyrightText: 2026 Meshy LLC
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: MIT AND Apache-2.0
// 多方许可。上游的与北冥新写的部分是 MIT。照 Cycles（Blender v5.2.3，路径相对 intern/cycles/）取的部分是 Apache-2.0
// （许可全文见仓库根的 LICENSES/Apache-2.0.txt）：
//   积分器参数块 KernelIntegrator 的字段名（pass_kind、background_transparent 是这里自己的）：kernel/data_template.h
//! Headless wgpu backend: uploads the flattened scene once, accumulates path-traced samples, reads back HDR.

use crate::heap::{Heap, Live, Section, Stream, Table};
use crate::scene::Scene;
use crate::GROUPS;
use anyhow::{anyhow, Result};
use web_time::Instant;
use wgpu::util::DeviceExt;

/// The uploaded texture pages of a texture set (texpack.rs).
struct Pages {
    /// `texpack::set_key` of the set.
    key: u64,
    view: wgpu::TextureView,
    info: std::sync::Arc<Vec<[f32; 4]>>,
}

pub struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    /// GPU timestamp queries are available (used for adaptive samples per frame in the viewer).
    pub timestamps: bool,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_info: wgpu::AdapterInfo,
    /// The kernel's bounded tables are uniform buffers (`GpuOptions::uniform_tables`; merged.rs `UNIFORM_TABLES`).
    pub uniform_tables: bool,
    /// The kernel reads its seven typed tables from the tables' buffer whole, not from views of their sections
    /// (`GpuOptions::table_views`; merged.rs `TABLE_VIEWS`).
    pub whole_tables: bool,
    /// The kernel's switches this device was opened with (`KernelSwitches`): they are in `source`.
    pub switches: KernelSwitches,
    /// Compiled pipelines kept between runs (`GpuOptions::pipeline_cache`), where the backend has such a cache.
    pipeline_cache: Option<crate::pipeline_cache::PipelineCache>,
    /// Kernel source (hardware or software traversal spliced in); scenes with material functions get their own module.
    source: String,
    /// The kernel as written: a scene without features that change the source or functions of its own.
    module: wgpu::ShaderModule,
    /// The merged binding layout (merged.rs): a browser's, where a stage has eight storage buffers. Natively with
    /// THREERT_MERGED=1 (software traversal, the device held to eight too).
    pub merged: bool,
    /// By (material-function code hash, the features that change the source: `KernelVariant::flags`).
    modules: std::sync::Mutex<std::collections::HashMap<(u64, u32), wgpu::ShaderModule>>,
    pipeline_layout: wgpu::PipelineLayout,
    /// Kernel variants by (feature mask, material-function code hash): `FEAT` compiles out the features a scene
    /// does not use (they cost registers even when idle).
    pipelines: std::sync::Mutex<std::collections::HashMap<(u32, u64), wgpu::ComputePipeline>>,
    layout: wgpu::BindGroupLayout,
    /// Group 1, the live viewport's: primary visibility (texture_2d<u32>), the radiance cache (`CacheBuffers`) and
    /// what the live passes read of a trace (`KernelBufs`). Offline renders bind `no_vis` (1x1 texture `no_vis_view`,
    /// one-entry cache).
    pub vis_layout: wgpu::BindGroupLayout,
    pub no_vis: wgpu::BindGroup,
    /// `no_vis`'s buffers (the merged layout: an offline kernel's source is written for their lengths).
    no_vis_bufs: KernelBufs,
    pub no_vis_view: wgpu::TextureView,
    /// Binding 19 of scenes without density grids (one cell).
    no_grid_view: wgpu::TextureView,
    /// Hardware ray queries (Metal / Vulkan RT). Software BVH traversal otherwise.
    pub hwrt: bool,
    /// Last uploaded texture pages, reused while the scene's texture set is unchanged (live edits re-upload often).
    pages: std::sync::Mutex<Option<Pages>>,
    /// The procedural blobs of the last upload (`upload_procs`).
    proc_cache: std::sync::Mutex<Option<ProcCache>>,
    /// The last upload's procedural BLASes by geometry hash (read-only once built; another upload may share them), with
    /// the bytes Metal allocated for each (0 where unknown).
    proc_blases: std::sync::Mutex<std::collections::HashMap<[u8; 32], (wgpu::Blas, u64)>>,
}

/// Where the last upload's procedural blobs are on the GPU: a rebuild with the same geometries (`ProcLayout::key`)
/// copies them from there, GPU to GPU, instead of sending them again. Read-only: every upload owns its buffer (a scene
/// being replaced, or another room's on a render node, may still be reading the one it came from).
struct ProcCache {
    key: Vec<[u8; 32]>,
    buf: wgpu::Buffer,
    offset: u64,
    bytes: u64,
}

/// 北冥：积分器的参数（pathtrace.wgsl `KernelIntegrator`），字段名照 Cycles。只定义、内核还没读的字段是 0。
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct KernelIntegrator {
    pub max_bounce: u32,
    pub max_diffuse_bounce: u32,
    pub max_glossy_bounce: u32,
    pub max_transmission_bounce: u32,
    pub transparent_max_bounce: u32,
    pub transparent_min_bounce: u32,
    pub min_bounce: u32,
    pub sampling_pattern: u32,
    pub sample_clamp_direct: f32,
    pub sample_clamp_indirect: f32,
    pub filter_glossy: f32,
    pub light_inv_rr_threshold: f32,
    /// 用户种子过一次 `sample::hash_hp` 之后的值（`KernelIntegrator::new`）。内核的像素种子从这里来（sample.wgsl 的
    /// `rng_start`）。
    pub seed: u32,
    /// Sobol 打乱后的索引取哪几位（sample.wgsl 的 `rng_index_at` 读它）。为 0 时每个样本取同一个点：`Gpu::render` 开渲前
    /// 报错。
    pub sobol_index_mask: u32,
    /// 0 颜色样本，1 辅助样本。
    pub pass_kind: u32,
    pub background_transparent: u32,
}

/// 上游写死的 Sobol 索引掩码：打乱后的索引取高 16 位（65536 个样本之后重复）。经 `KernelIntegrator::new` 进全局参数。
pub const SOBOL_INDEX_MASK: u32 = 0xffff_0000;

impl KernelIntegrator {
    /// 一次渲染的积分器参数：`seed` 是用户给的种子（`rng_seed`），进缓冲的是它过一次哈希之后的值。
    pub fn new(seed: u32) -> KernelIntegrator {
        KernelIntegrator { seed: crate::sample::hash_hp(seed), sobol_index_mask: SOBOL_INDEX_MASK, ..Default::default() }
    }
}

/// 北冥：输出缓冲的形状（pathtrace.wgsl `KernelFilm`）。
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct KernelFilm {
    /// 每个像素占几个 vec4。
    pub film_stride: u32,
    /// 第 0 个灯组在像素里的位置。
    pub film_lightgroup_first: u32,
    /// 这次渲染请求的灯组数。
    pub num_lightgroups: u32,
    pub reserved: u32,
}

/// 北冥：输出缓冲 film 固定部分各通道的位置（film.wgsl 里同名，库测试逐个比数值）：颜色与样本数、降噪用的反照率
/// 与法线、上游降噪用的两个方差量、上游 `--signals` 的两组、辅助样本的两格。第 8、9 格预留。
pub const FILM_COMBINED: u32 = 0;
pub const FILM_DENOISE_ALBEDO: u32 = 1;
pub const FILM_DENOISE_NORMAL: u32 = 2;
pub const FILM_LEGACY_VARIANCE: u32 = 3;
pub const FILM_LEGACY_EMIT: u32 = 4;
pub const FILM_LEGACY_SPEC: u32 = 5;
pub const FILM_AUX_DATA: u32 = 6;
pub const FILM_AUX_NORMAL: u32 = 7;
/// 输出缓冲里每个像素固定部分的长度（vec4 个数）：灯组排在它后面。内核不写死这个数，从 `KernelFilm` 读。
pub const FILM_FIXED: u32 = 10;
/// 每个像素的步长向上取到这个数的倍数（4 个 vec4 是 64 字节）。量出来的：苹果显卡上步长 10、11 比步长 12、16 的
/// 稳态慢 5%（同样只写前四格），每个像素的记录对不齐 64 字节时写起来就慢。多出来的格子没人读写。
pub const FILM_STRIDE_ALIGN: u32 = 4;

/// 输出缓冲的字节数：每个像素 `film_stride` 个 vec4。`limit` 是显卡单个缓冲绑定的上限（也不许超过单个缓冲的上限）：
/// 超过就报错，并写明这个分辨率下这次最多能要几个灯组。形状对不上（不是 `KernelFilm::new` 填的）也报错。
pub fn film_bytes(w: u32, h: u32, film: &KernelFilm, limit: u64) -> Result<u64> {
    if film.film_lightgroup_first < FILM_FIXED || film.film_stride < film.film_lightgroup_first + film.num_lightgroups {
        return Err(anyhow!("全局参数的 film 一块形状不对（{film:?}）：用 KernelFilm::new 填"));
    }
    let per_vec4 = w as u64 * h as u64 * 16;
    let bytes = per_vec4 * film.film_stride as u64;
    if bytes > limit {
        // （步长是 FILM_STRIDE_ALIGN 的倍数：放得下的最大步长先向下取整，再减去固定部分。）
        let most = (limit / per_vec4.max(1) / FILM_STRIDE_ALIGN as u64 * FILM_STRIDE_ALIGN as u64).saturating_sub(film.film_lightgroup_first as u64);
        return Err(anyhow!(
            "输出缓冲要 {bytes} 字节（{w}×{h}，每个像素 {} 个 vec4），超过这块显卡单个缓冲绑定的上限 {limit} 字节：这个分辨率下这次最多能要 {most} 个灯组（请求了 {} 个），多出来的分几次渲",
            film.film_stride,
            film.num_lightgroups
        ));
    }
    Ok(bytes)
}

impl KernelFilm {
    /// 请求 `num_lightgroups` 个灯组的一次渲染的输出缓冲形状。
    pub fn new(num_lightgroups: u32) -> KernelFilm {
        KernelFilm { film_stride: (FILM_FIXED + num_lightgroups).next_multiple_of(FILM_STRIDE_ALIGN), film_lightgroup_first: FILM_FIXED, num_lightgroups, reserved: 0 }
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable, Default)]
pub struct Params {
    pub cam_pos: [f32; 4],
    pub cam_fwd: [f32; 4],
    pub cam_right: [f32; 4],
    pub cam_up: [f32; 4],
    pub size: [u32; 4],
    pub counts: [u32; 4],
    pub env: [f32; 4],
    pub misc: [f32; 4],
    pub sky_color: [f32; 4],
    pub counts2: [u32; 4],   // directional lights (first in the light list), -, -, -
    pub time: [f32; 4],      // scene time (s), wetness, rain, -
    pub fog: [f32; 4],       // density at fog height (1/m), height falloff (1/m), fog height (m), start distance (m)
    pub fog_color: [f32; 4], // ambient inscattering radiance rgb, max opacity
    pub vol: [f32; 4],       // volumetric scattering albedo (0 = off), phase anisotropy, extinction scale in range, -
    pub vol2: [f32; 4],      // volumetric albedo tint rgb, range (m, 0 = unlimited)
    pub raster: [f32; 4],    // live primary visibility from the raster pass (1 = on), sub-pixel jitter x, y; ray tracing off (1)
    pub cache: [f32; 4],     // live radiance cache (1 = on), history cap in samples, history cap in frames, -
    pub motion: [f32; 4],    // live motion vectors: 1 = on, -, -, - (first dynamic triangle: group_first[1][0])
    /// First global triangle of each traversal group (`Prepared::groups`; group 4 = the first dynamic one). Hardware
    /// BLAS instances carry their group index, not this offset: instance custom data has only 24 bits (16.7 M).
    pub group_first: [[u32; 4]; 2],
    /// Light LOD (live; `emitter_lod`): reference position, d0 (0 = off).
    pub light_lod: [f32; 4],
    /// x: the emitter CDF's total without light LOD (camera-hit MIS weighs by power alone; = misc[1] when it is off);
    /// y: live emitter cull radius (lib.rs emitter_lod; 0 = off); z: the cull's reach inside the view cone (0 = none).
    pub emit_power: [f32; 4],
    /// Live emitter cull's view cone (lib.rs `EmitterCull`): the forward direction it was built for (xyz), the cosine
    /// of its half-angle (w).
    pub lod_view: [f32; 4],
    /// Light tree (`ltree`): -, its entry count (bits: the first moving emitter's entry), the probability of picking
    /// a moving emitter (their share of power), candidates at camera hits (0 = off).
    pub ltree: [f32; 4],
    /// Procedural geometry (F_PROC; scene::proc_data): -, object count, first record in `instances`, -.
    pub procs: [u32; 4],
    /// The sky's aerial perspective (F_AERIAL; `scene::aerial_params`): density multiple, Rayleigh scale, Mie scale, -.
    pub aerial: [f32; 4],
    /// three.js `scene.background` (F_BACKGROUND): its radiance, 1.
    pub background: [f32; 4],
    /// The live light tiles (pathtrace.wgsl "Light tiles"; live/frame.rs): 1 with the last frame's lists (0: none
    /// this frame), tiles a row, the grid's offset when they were built (x | y << 16), candidates a
    /// vertex the camera sees takes from its list beside the uniform ones (`live::LIST_CANDIDATES`; half past it).
    pub ltile: [u32; 4],
    /// The traced size the lists were built at, -, -.
    pub ltile2: [u32; 4],
    /// The camera the lists were built under (the last frame's): position (w = tan(fov / 2)), forward (w = aspect),
    /// right, up. A camera hit reads the list of the tile it was seen in then.
    pub lt_cam: [[f32; 4]; 4],
    /// Each table's first vec4 in the tables' heap (`heap::Table`'s order; `Uploaded::place`).
    pub table_first: [[u32; 4]; 3],
    /// Each stream's first word in the words' heap (`heap::Stream`'s order): the environment's CDF, the procedural
    /// data, the vertex colours, -.
    pub word_first: [u32; 4],
    /// The merged layout (`KernelBufs::place`): each of group 1's vec4 sections' first vec4 in the tail of its one
    /// buffer (the cache's values, the specular rays, the motion vectors, the direct light; the light lists), and
    /// the last four's lengths. As written: zeros (the kernel asks the buffers).
    pub live_first: [[u32; 4]; 2],
    pub live_len: [u32; 4],
    /// 北冥：末尾追加的三块（pathtrace.wgsl 同名）。已有的块长度冻结，要加东西就在末尾再追加自己的一整块。
    pub integrator: KernelIntegrator,
    pub film: KernelFilm,
    /// 北冥加的表的首地址（`heap::Table` 里排在上游 12 张之后的，`Uploaded::place`）：物体扩展表、图案节点表、
    /// 广义 Schlick 的两张能量表；后四格空闲。还没有的表是 0。
    pub table_first_ext: [[u32; 4]; 2],
}

/// Room the live view's in-place geometry edits grow into (live/edits.rs `edit_geometry`), past the scene's own data:
/// triangles (verts, attrs, BLAS vertices), kernel records and TLAS instances, object-table entries, procedural words.
/// Only scenes with editable geometry (procedural meshes, `own_blas` meshes) under hardware RT get any: a quarter of
/// what they have, at least a minimum; `THREERT_EDIT_RESERVE` scales it (0: none). Past it an edit rebuilds the scene.
#[derive(Clone, Copy, Default, Debug)]
pub struct EditRoom {
    pub tris: usize,
    pub records: usize,
    pub objects: usize,
    pub proc_words: usize,
}

impl EditRoom {
    fn reserve() -> f64 {
        std::env::var("THREERT_EDIT_RESERVE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0)
    }

    /// Whether the scene gets room (`for_scene`): editable geometry under hardware RT.
    pub fn editable(scene: &Scene, hwrt: bool) -> bool {
        hwrt && Self::reserve() > 0.0 && (!scene.procs.is_empty() || scene.retained.has_own_instances())
    }

    pub(crate) fn for_scene(scene: &Scene, tris: usize, records: usize, hwrt: bool) -> EditRoom {
        let k = Self::reserve();
        let (procs, meshes) = (!scene.procs.is_empty(), scene.retained.has_own_instances());
        let part = |n: usize, min: usize| ((n as f64 * 0.25 * k) as usize).max((min as f64 * k) as usize);
        if !Self::editable(scene, hwrt) {
            return EditRoom::default();
        }
        let blob_words = scene.proc_layout.as_ref().map_or(0, |l| l.head.len() + l.blob_words);
        EditRoom {
            tris: if meshes { part(tris, 1 << 16) } else { 0 },
            records: part(records, 1024),
            objects: part(scene.objects.len() / scene.object_stride(), 1024),
            proc_words: if procs { part(blob_words, 1 << 20) } else { 0 },
        }
    }
}

/// The acceleration structure's binding in the scene's group (trace_hw.wgsl `acc`): the last, after every buffer.
const ACC_BINDING: u32 = 19;

/// What the kernel's bind group layouts follow: the device's traversal and binding layout, and whether group 1 has
/// the loop guard's count (`guard_room`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct LayoutShape {
    pub hwrt: bool,
    pub merged: bool,
    pub uniform_tables: bool,
    /// No views of the tables' sections (`Gpu::whole_tables`).
    pub whole_tables: bool,
    pub guard: bool,
}

fn layout_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::COMPUTE, ty, count: None }
}
fn storage_buffer(read_only: bool) -> wgpu::BindingType {
    wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None }
}
const UNIFORM_BUFFER: wgpu::BindingType = wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None };
fn float_texture(view_dimension: wgpu::TextureViewDimension) -> wgpu::BindingType {
    wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension, multisampled: false }
}
const ACCELERATION_STRUCTURE: wgpu::BindingType = wgpu::BindingType::AccelerationStructure { vertex_return: false };

/// The entries of the kernel's bind group layouts, the one place they are written: group 0 (the scene), group 1
/// (what the kernel writes). A test holds them to what every
/// variant of the kernel's source declares (`the_kernels_layouts_are_its_declarations`).
pub(crate) fn kernel_layout_entries(shape: LayoutShape) -> [Vec<wgpu::BindGroupLayoutEntry>; 2] {
    use crate::merged::{DEFERRED_BINDING, GUARD_BINDING, LISTS_BINDING, LIVE_BINDING, TABLE_VIEWS, UNIFORM_TABLES};
    let LayoutShape { hwrt, merged, uniform_tables, whole_tables, guard } = shape;
    let (read, write) = (storage_buffer(true), storage_buffer(false));
    // Group 0: the parameters; triangles and their attributes; the tables' heap, the words' heap; the dynamic
    // triangles' previous vertices; the texture pages and their sampler, the environment, the density grids' atlas
    // (a 1-cell texture in scenes without grids, whose kernel does not read it); the accumulation buffer.
    let mut scene = vec![
        layout_entry(0, UNIFORM_BUFFER),
        layout_entry(1, read),
        layout_entry(2, read),
        layout_entry(4, read),
        layout_entry(5, read),
        layout_entry(6, read),
        layout_entry(7, float_texture(wgpu::TextureViewDimension::D2Array)),
        layout_entry(8, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
        layout_entry(9, float_texture(wgpu::TextureViewDimension::D2)),
        layout_entry(10, float_texture(wgpu::TextureViewDimension::D3)),
        layout_entry(11, write),
    ];
    // Software traversal's trees.
    if !hwrt {
        scene.push(layout_entry(3, read));
    }
    // The tables the kernel reads at every hit or light, bound again as typed views of their sections (the merged
    // layout has no binding for them, nor has a device that reads them from the buffer whole), four of them uniform
    // copies where a driver needs it.
    if !merged && !whole_tables {
        let copied = |b: u32| uniform_tables && UNIFORM_TABLES.iter().any(|t| t.binding == b);
        scene.extend(TABLE_VIEWS.iter().map(|&(_, b)| layout_entry(b, if copied(b) { UNIFORM_BUFFER } else { read })));
    }
    if hwrt {
        scene.push(layout_entry(ACC_BINDING, ACCELERATION_STRUCTURE));
    }
    // Group 1: the raster pass's visibility; then, merged, the one buffer (`heap::Live`, the loop guard's count in
    // it); as written, the radiance cache's three, the light tiles' lists, the specular rays, the motion vectors, the
    // direct light, the pixels left for `finish`, and the loop guard's count where a kernel of this device may have
    // the guard (one without it does not name the binding).
    let mut live = vec![layout_entry(0, wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Uint, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false })];
    if merged {
        live.push(layout_entry(LIVE_BINDING, write));
    } else {
        live.extend([1, 2, 3, 5, 6, 7].map(|b| layout_entry(b, write)));
        live.push(layout_entry(LISTS_BINDING, read));
        live.push(layout_entry(DEFERRED_BINDING, write));
        if guard {
            live.push(layout_entry(GUARD_BINDING, write));
        }
    }
    [scene, live]
}

/// A note for each uniform table that a scene has more entries of (`used`, merged.rs `UNIFORM_TABLES`' order) than
/// its array holds: the kernel reads the last entry for the rest.
pub(crate) fn uniform_overflow(used: [u64; 4]) -> Vec<String> {
    crate::merged::UNIFORM_TABLES
        .iter()
        .zip(used)
        .filter(|(t, used)| *used > t.len as u64)
        .map(|(t, used)| format!("uniform tables: the scene has {used} entries of `{}`, a uniform buffer holds {} (the rest read as the last one; THREERT_UNIFORM_TABLES=0 reads the tables' heap)", t.name, t.len))
        .collect()
}

/// The bytes of a table that its uniform copy takes: what both hold, in whole words (a copy's unit).
fn uniform_copy_bytes(table: u64, copy: u64) -> u64 {
    table.min(copy) & !3
}


/// What the scene bind group holds besides `Uploaded`'s buffers (`Gpu::rebind_scene` makes it again).
pub struct BindParts {
    pub nodes: wgpu::Buffer,
    pub tex_view: wgpu::TextureView,
    pub env_view: wgpu::TextureView,
    pub sampler: wgpu::Sampler,
    /// The density grids' atlas (binding 19), or the one-cell texture of a scene without grids.
    pub grid_view: wgpu::TextureView,
}

/// What the scene's bind group is made of (`Gpu::scene_bind_group`).
struct SceneBuffers<'a> {
    params: &'a wgpu::Buffer,
    verts: &'a wgpu::Buffer,
    attrs: &'a wgpu::Buffer,
    heap: &'a Heap<Table>,
    words: &'a Heap<Stream>,
    prev_verts: &'a wgpu::Buffer,
    film: &'a wgpu::Buffer,
    parts: &'a BindParts,
    accel: Option<&'a Accel>,
    uniform: Option<&'a [wgpu::Buffer; 4]>,
}

fn buffer_entry(binding: u32, b: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: b.as_entire_binding() }
}

pub struct Uploaded {
    pub bg: wgpu::BindGroup,
    pub bg_parts: BindParts,
    /// The scene's tables (heap.rs): materials, lights, emitters, objects, instances, media and the rest, each a
    /// section that edits write in place (`Heap::write`) and grow (`Heap::grow`, then `Gpu::rebind_scene`).
    pub heap: Heap<Table>,
    /// The uniform tables (`Gpu::uniform_tables`): the uniform buffers the kernel reads four tables from (merged.rs
    /// `UNIFORM_TABLES`' order; `Gpu::sync_tables` copies their sections there each frame).
    pub uniform: Option<[wgpu::Buffer; 4]>,
    /// The trace's samples, a `Pixel` a pixel: the view's buffer (a live view's targets', an offline render's own:
    /// `film_buffer`). A handle of it here, for the scene's bind group, where the kernel's layout has it.
    pub film: wgpu::Buffer,
    pub params: wgpu::Buffer,
    /// Kernel specialisation for this scene (`Gpu::pipeline`).
    pub kernel: Kernel,
    /// Triangle vertices / shading attributes (posed models rewrite their ranges).
    pub verts: wgpu::Buffer,
    pub attrs: wgpu::Buffer,
    /// The dynamic triangles' (posed models, movable objects: the tail from `dynamic_first`) vertices of the previous
    /// frame, kernel layout: live motion vectors.
    pub prev_verts: wgpu::Buffer,
    pub dynamic_first: usize,
    pub accel: Option<Accel>,
    /// The density grids (the atlas the kernel reads), when the scene has any.
    pub grids: Option<GridsGpu>,
    /// Each medium's node (the media table's order).
    /// The scene has vertex colours (F_VCOLOR): three words per triangle in `words`, the edit room's included.
    pub vcolors: bool,
    pub media_nodes: Vec<u32>,
    /// Per medium: its node is hidden (`set_medium_hidden`). The live view runs no media pass while all are.
    pub media_hidden: std::cell::RefCell<Vec<bool>>,
    /// Room for in-place geometry edits (`EditRoom`), and the scene's 32-bit arrays (heap.rs `Stream`: the
    /// environment's CDF, the procedural region, the vertex colours), with the CDF's length and the region's words
    /// in use (the room follows them).
    pub room: EditRoom,
    pub words: Heap<Stream>,
    pub cdf_words: usize,
    pub region_words: usize,
    /// The environment map (`put_env` replaces it: a dynamic sky's sun moved, another sky).
    pub env_tex: wgpu::Texture,
}

impl Uploaded {

    /// Where the kernel finds each table and stream (`Params::table_first`, `word_first`): written with the
    /// parameters, every time (a section that grew moves those after it).
    pub fn place(&self, p: &mut Params) {
        let first = self.heap.firsts();
        p.table_first = std::array::from_fn(|k| std::array::from_fn(|j| first.get(k * 4 + j).copied().unwrap_or(0)));
        p.table_first_ext = std::array::from_fn(|k| std::array::from_fn(|j| first.get(12 + k * 4 + j).copied().unwrap_or(0)));
        let first = self.words.firsts();
        p.word_first = std::array::from_fn(|k| first.get(k).copied().unwrap_or(0));
    }
}

/// The density grids' texel: four half floats (filterable, and a storage texture's format in WebGPU's core).
pub const GRID_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

fn grid_texture(d: &wgpu::Device, label: &str, dims: [u32; 3], written: bool) -> wgpu::Texture {
    d.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: dims[0], height: dims[1], depth_or_array_layers: dims[2] },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: GRID_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | if written { wgpu::TextureUsages::STORAGE_BINDING } else { wgpu::TextureUsages::empty() },
        view_formats: &[],
    })
}

/// Density grids (ROADMAP § 6 step 5b): field A of every grid in one 3D texture, stacked along z (the kernel's binding
/// 19, `vgrid`).
pub struct GridsGpu {
    atlas: wgpu::Texture,
}

/// A grid's data (four f32 a cell) as the atlas's half floats.
fn grid_halves(data: &[f32]) -> Vec<half::f16> {
    data.iter().map(|&v| half::f16::from_f32(v.clamp(-65504.0, 65504.0))).collect()
}

/// Hardware acceleration structures: one BLAS per non-empty traversal group, one TLAS over them (its instances keep
/// their BLASes).
pub struct Accel {
    pub tlas: wgpu::Tlas,
    /// Triangle vertices the BLASes are built from (12 B per vertex, 3 per triangle).
    pub verts: wgpu::Buffer,
    /// The TLAS index of model instance 0 (the traversal groups' instances come first).
    pub inst_base: usize,
    /// The build's triangle BLAS bytes per triangle (Metal's sizes): edits' memory estimates (live/mod.rs `room_stats`).
    pub blas_per_tri: f64,
    /// The TLAS index of the first procedural object's instance (after the model instances; each has its own AABB
    /// BLAS, which its TLAS instance keeps).
    pub proc_base: usize,
}

/// A TLAS instance transform: the world matrix's first three rows.
/// TLAS mask of an instance: 1 casts shadows, 2 does not, 0 a hidden instance of an instanced object (no ray sees it).
pub fn instance_mask(cast_shadow: bool, hidden: bool) -> u8 {
    if hidden {
        0
    } else if cast_shadow {
        1
    } else {
        2
    }
}

/// The kernel's files, one module in this order (pathtrace.wgsl's head says what each holds and names the `@if` flags).
/// What more than one shader reads or writes, declared once: a file of the kernel, of the particle passes and of
/// the live passes (live/targets.rs `live_source`).
const RECORDS: &str = include_str!("../shaders/records.wgsl");

/// (pathtrace.wgsl first: a module's imports and directives come before its declarations.)
/// 北冥：内核主体按阶段分成了几个文件（pathtrace.wgsl 的开头列着哪个阶段在哪个文件）。
const KERNEL_FILES: [&str; 16] = [
    include_str!("../shaders/pathtrace.wgsl"),
    RECORDS,
    include_str!("../shaders/sample.wgsl"),
    // 北冥：照 Cycles 移植的哈希函数（像素种子用）
    include_str!("../shaders/hash.wgsl"),
    include_str!("../shaders/intersect.wgsl"),
    include_str!("../shaders/trace_hw.wgsl"),
    include_str!("../shaders/shader.wgsl"),
    include_str!("../shaders/closure.wgsl"),
    include_str!("../shaders/light.wgsl"),
    include_str!("../shaders/volume.wgsl"),
    include_str!("../shaders/integrator.wgsl"),
    include_str!("../shaders/film.wgsl"),
    // 北冥：照 Cycles 移植的 GGX 金属闭包与矩形面光采样（原文件在 beiming/sources/core/shaders/，仓库里只此一份）
    include_str!("../../shaders/microfacet.wgsl"),
    include_str!("../../shaders/util.wgsl"),
    include_str!("../../shaders/area_light.wgsl"),
    include_str!("../../shaders/ggx_tables.wgsl"),
];

/// The kernel's source: its files as one WESL module, every device's and scene's variant in it under `@if`.
pub fn kernel_template() -> String {
    KERNEL_FILES.join("\n")
}

/// 北冥：去掉着色器源码里的注释（`//` 到行尾，`/* */` 可以嵌套），换行留着。按源码文本查写法的几条测试先过这一道：
/// 被注释掉的语句不算在，夹在名字与括号之间的注释也挡不住匹配。
#[cfg(test)]
pub(crate) fn without_comments(src: &str) -> String {
    let (mut out, mut depth, mut line) = (String::with_capacity(src.len()), 0usize, false);
    let mut it = src.chars().peekable();
    while let Some(c) = it.next() {
        let next = it.peek().copied();
        if line {
            line = c != '\n';
        } else if c == '/' && next == Some('*') {
            depth += 1;
            it.next();
            continue;
        } else if depth > 0 {
            if c == '*' && next == Some('/') {
                depth -= 1;
                it.next();
                continue;
            }
        } else if c == '/' && next == Some('/') {
            line = true;
            it.next();
            continue;
        }
        if c == '\n' || !(line || depth > 0) {
            out.push(c);
        }
    }
    out
}

/// What a kernel is compiled for (pathtrace.wgsl's head names the flags): the device's traversal, switches, binding
/// layout and loop guard, and the scene's features that change the kernel's declarations (`F_SOURCE`; the others
/// switch code under `override FEAT`).
#[derive(Clone, Copy, Debug, Default)]
pub struct KernelVariant {
    pub hwrt: bool,
    pub switches: KernelSwitches,
    /// The scene's features: `F_SOURCE`'s are flags.
    pub features: u32,
    /// The merged layout (merged.rs).
    pub merged: bool,
    /// Four tables in uniform buffers (merged.rs `UNIFORM_TABLES`; `GpuOptions::uniform_tables`). Never with `merged`.
    pub uniform_tables: bool,
    /// The seven typed tables read from the tables' buffer whole, as the merged layout reads them, with the layout as
    /// written otherwise (`GpuOptions::table_views`). Never with `uniform_tables`.
    pub whole_tables: bool,
    /// The loop guard's limit, in a kernel with the guard (`loop_guard_of`, `guard_loops`).
    pub guard: Option<u32>,
}

impl KernelVariant {
    /// A device's traversal and switches, a scene's features; the layout as written, no guard.
    pub fn new(hwrt: bool, switches: KernelSwitches, features: u32) -> KernelVariant {
        KernelVariant { hwrt, switches, features, ..Default::default() }
    }

    /// The flags of the kernel's conditional translation (pathtrace.wgsl's head).
    pub fn flags(&self) -> [(&'static str, bool); 11] {
        let k = &self.switches;
        [
            ("hwrt", self.hwrt),
            ("strict", k.strict),
            ("cutout_lite", k.cutout_lite >= 1),
            ("cutout_lite2", k.cutout_lite >= 2),
            ("last_direct", k.last_direct),
            ("last_sun", k.last_sun),
            ("light_pick", k.light_pick),
            ("merged", self.merged),
            ("uniform_tables", self.uniform_tables),
            ("whole_tables", self.whole_tables),
            ("guard", self.guard.is_some()),
        ]
    }

    /// The numbers the variant is compiled for, WESL constants (`import constants::`): the uniform tables' lengths
    /// (`UT_<table>`), the loop guard's count's words and its limit.
    pub fn constants(&self) -> Vec<(String, u32)> {
        use crate::merged::{GUARD_WORDS, UNIFORM_TABLES};
        let mut out = vec![];
        if self.uniform_tables {
            out.extend(UNIFORM_TABLES.iter().map(|t| (format!("UT_{}", t.name.to_uppercase()), t.len)));
        }
        if self.merged || self.guard.is_some() {
            out.push(("GUARD_WORDS".into(), GUARD_WORDS));
        }
        if let Some(n) = self.guard {
            out.push(("LOOP_GUARD_LIMIT".into(), n));
        }
        out
    }
}

/// A kernel's WGSL: `src` (the template, the scene's functions spliced in) for a variant: WESL's conditional
/// translation for its flags, with its constants, then the loop guard if it has one (`guard_loops`).
pub fn kernel_wgsl(src: &str, v: &KernelVariant) -> String {
    try_kernel_wgsl(src, v).unwrap_or_else(|e| panic!("{e}"))
}

/// `kernel_wgsl`, saying what did not compile instead of panicking (a scene's own functions are a game's code).
pub fn try_kernel_wgsl(src: &str, v: &KernelVariant) -> Result<String, String> {
    assert!(!(v.merged && v.uniform_tables), "the uniform tables are never in the merged layout");
    assert!(!(v.whole_tables && v.uniform_tables), "the uniform tables are copies of views the kernel reading the tables whole does not have");
    let mut out = try_wesl_wgsl(src, &v.flags(), &v.constants())?;
    if v.guard.is_some() {
        guard_loops(&mut out);
    }
    Ok(out.to_string())
}

/// A scene's functions as packages built before the kernel was WESL (#70) carry them: the scene library's hash
/// (packages/scene/src/materials.ts `std_hash`, `std_hash3`) was `a * b ^ c * d`, which naga took and WESL, by the
/// specification's grammar (a bitwise operator's operands are unary), does not. Those packages keep the old library
/// in their bundles, so the two expressions are parenthesised here as the library now writes them, in the order naga
/// read them: the same hash, the same picture. Anything else is left as it is.
pub fn legacy_wgsl(code: String) -> String {
    const OLD: [(&str, &str); 2] = [
        (
            "std_pcg(bitcast<u32>(x) * 73856093u ^ bitcast<u32>(y) * 19349663u ^ bitcast<u32>(z) * 83492791u)",
            "std_pcg((bitcast<u32>(x) * 73856093u) ^ (bitcast<u32>(y) * 19349663u) ^ (bitcast<u32>(z) * 83492791u))",
        ),
        (
            "let v = bitcast<u32>(x) * 73856093u ^ bitcast<u32>(y) * 19349663u ^ bitcast<u32>(z) * 83492791u;",
            "let v = (bitcast<u32>(x) * 73856093u) ^ (bitcast<u32>(y) * 19349663u) ^ (bitcast<u32>(z) * 83492791u);",
        ),
    ];
    if !OLD.iter().any(|(old, _)| code.contains(old)) {
        return code;
    }
    OLD.iter().fold(code, |c, (old, new)| c.replace(old, new))
}

/// `src` through wesl-rs (WESL's reference compiler in Rust): conditional translation for `flags`, imports of the
/// `constants` package from `constants`. Every flag the source names must be given (one that is not is an error, not
/// off), and every constant it imports.
pub fn wesl_wgsl(src: &str, flags: &[(&str, bool)], constants: &[(String, u32)]) -> wesl::syntax::TranslationUnit {
    try_wesl_wgsl(src, flags, constants).unwrap_or_else(|e| panic!("{e}"))
}

/// `wesl_wgsl`, with what did not compile as an error.
pub fn try_wesl_wgsl(src: &str, flags: &[(&str, bool)], constants: &[(String, u32)]) -> Result<wesl::syntax::TranslationUnit, String> {
    use wesl::{syntax::ModulePath, CompileOptions, Feature, Features};
    let mut features = Features { default: Feature::Error, ..Default::default() };
    for &(name, on) in flags {
        features.set(name, on);
    }
    let constants = constants.iter().map(|(name, n)| format!("public const {name} = {n}u;\n")).collect();
    let resolver = KernelResolver { src, constants };
    let options = CompileOptions { imports: true, condcomp: true, strip: false, validate: false, sourcemap: false, mangler: wesl::ManglerKind::None, features, ..Default::default() };
    let path: ModulePath = "package::kernel".parse().expect("a module path");
    wesl::compile(&path, &options, &resolver).map(|r| r.syntax).map_err(|e| format!("the kernel's WESL: {e}"))
}

/// The modules a kernel's WESL sees: itself, and WESL's `constants` package (`wesl_wgsl`).
struct KernelResolver<'a> {
    src: &'a str,
    constants: String,
}

impl wesl::resolver::Resolver for KernelResolver<'_> {
    fn resolve_source<'a>(&'a self, path: &wesl::syntax::ModulePath) -> Result<std::borrow::Cow<'a, str>, wesl::error::ResolveError> {
        use wesl::syntax::PathOrigin;
        match &path.origin {
            PathOrigin::Package(p) if p == "constants" => Ok(std::borrow::Cow::Borrowed(&self.constants)),
            PathOrigin::Absolute if path.components == ["kernel"] => Ok(std::borrow::Cow::Borrowed(self.src)),
            _ => Err(wesl::error::ResolveError::ModuleNotFound(path.clone(), "the kernel imports nothing but `constants`".into())),
        }
    }
}

/// The loop guard (docs/RUNTIME.md "The engine in a browser"): every `loop`, `for` and `while` of a variant, the
/// scene's functions' too, begins with `if (loop_guard()) { break; }` (pathtrace.wgsl declares `loop_guard`, under
/// `@if(guard)`). A pass over the variant's syntax tree, as a compiler instruments code: the tree knows what a loop
/// and its body are, so nothing the text says (comments, strings, a loop without braces) can mislead it.
/// A `for` loop that ends by its own count: `for (var i = N; i < M; i++)` (or `<=`), N and M integer literals, whose
/// body does not assign `i`. The guard leaves it out, as Tint's PreventInfiniteLoops leaves loops it can prove finite.
fn counted(f: &wesl::syntax::ForStatement) -> bool {
    let (Some(init), Some(cond), Some(update)) = (&f.initializer, &f.condition, &f.update) else { return false };
    let lit = |t: &str| {
        let t = t.trim().trim_end_matches(['u', 'i']);
        !t.is_empty() && t.bytes().all(|c| c.is_ascii_digit())
    };
    let init = init.to_string();
    let Some((name, start)) = init.trim().trim_end_matches(';').strip_prefix("var ").and_then(|r| r.split_once('=')) else { return false };
    let name = name.split(':').next().unwrap_or("").trim();
    let cond = cond.to_string();
    let bound = cond.trim().trim_start_matches('(').trim_end_matches(')').strip_prefix(name).map(str::trim_start).and_then(|r| r.strip_prefix("<=").or_else(|| r.strip_prefix('<')));
    if name.is_empty() || !lit(start) || !bound.is_some_and(lit) || update.to_string().trim().trim_end_matches(';') != format!("{name}++") {
        return false;
    }
    // Not assigned in the body: `name` as an identifier followed by `=` (not `==`), `op=`, `++` or `--`.
    let b = f.body.to_string();
    let bytes = b.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    !b.match_indices(name).any(|(k, _)| {
        let before = k.checked_sub(1).map(|p| bytes[p]);
        let after = b[k + name.len()..].trim_start();
        before.is_none_or(|c| !ident(c) && c != b'.') && !after.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
            && (after.starts_with("++") || after.starts_with("--") || (after.starts_with('=') && !after.starts_with("==")) || ["+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="].iter().any(|op| after.starts_with(op)))
    })
}

pub fn guard_loops(tu: &mut wesl::syntax::TranslationUnit) {
    use wesl::syntax::{CompoundStatement, GlobalDeclaration, Statement, StatementNode};
    fn body(b: &mut CompoundStatement, guard: &StatementNode) {
        for s in b.statements.iter_mut() {
            statement(s, guard);
        }
    }
    fn opened(b: &mut CompoundStatement, guard: &StatementNode) {
        body(b, guard);
        b.statements.insert(0, guard.clone());
    }
    fn statement(s: &mut StatementNode, guard: &StatementNode) {
        match s.node_mut() {
            Statement::Compound(c) => body(c, guard),
            Statement::If(i) => {
                body(&mut i.if_clause.body, guard);
                for e in i.else_if_clauses.iter_mut() {
                    body(&mut e.body, guard);
                }
                if let Some(e) = i.else_clause.as_mut() {
                    body(&mut e.body, guard);
                }
            }
            Statement::Switch(sw) => sw.clauses.iter_mut().for_each(|c| body(&mut c.body, guard)),
            Statement::Loop(l) => {
                opened(&mut l.body, guard);
                if let Some(c) = l.continuing.as_mut() {
                    body(&mut c.body, guard);
                }
            }
            Statement::For(f) if counted(f) => body(&mut f.body, guard),
            Statement::For(f) => opened(&mut f.body, guard),
            Statement::While(w) => opened(&mut w.body, guard),
            _ => {}
        }
    }
    let guard: Statement = "if (loop_guard()) { break; }".parse().expect("the guard's statement");
    let guard = StatementNode::from(guard);
    for d in tu.global_declarations.iter_mut() {
        if let GlobalDeclaration::Function(f) = d.node_mut() {
            body(&mut f.body, &guard);
        }
    }
}

/// The loop guard's limit for every kernel, if one is set (`guard_loops`: every loop of a kernel bounded, so a
/// dispatch ends whatever the data): THREERT_LOOP_GUARD=<iterations an invocation> natively, where a kernel is
/// otherwise as written; always in a browser, where a dispatch that does not end is the player's whole GPU.
pub fn loop_guard() -> Option<u32> {
    loop_guard_of(false)
}

/// The loop guard's limit for a kernel with units or without (`F_UNITS`). A kernel with units has the guard natively
/// too, at the browser's limit, unless THREERT_LOOP_GUARD=0: its second level is the traversal that has run least,
/// and what it walks is rewritten by edits while it runs. A kernel without units is as `loop_guard` says: natively,
/// with nothing set, the source as written.
pub fn loop_guard_of(units: bool) -> Option<u32> {
    let page = LOOP_GUARD.load(std::sync::atomic::Ordering::Relaxed);
    let var = std::env::var("THREERT_LOOP_GUARD").ok().and_then(|v| v.parse::<u32>().ok());
    guard_limit(page, var, units, cfg!(target_arch = "wasm32"))
}

/// `loop_guard_of`, of what was set: by a page (0: nothing), by the environment (Some(0): off), and where.
fn guard_limit(page: u32, var: Option<u32>, units: bool, browser: bool) -> Option<u32> {
    match (page, var) {
        (n, _) if n > 0 => Some(n),
        (_, Some(0)) => None,
        (_, Some(n)) => Some(n),
        (_, None) => (units || browser).then_some(1 << 16),
    }
}

/// The loop guard's limit as a page set it (0: not set), before the GPU is opened: a browser has no environment.
static LOOP_GUARD: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Sets the loop guard's limit (a page's first runs of a new kernel take a low one); 0 leaves it as it is. Before
/// `Gpu::new_async`: the limit is in the kernels' source.
pub fn set_loop_guard(limit: u32) {
    if limit > 0 {
        LOOP_GUARD.store(limit, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Whether a device's layout as written has the guard's count (group 1, `merged::GUARD_BINDING`; `KernelBufs::guard`):
/// when a kernel of it may have the guard. Under software traversal that is unless THREERT_LOOP_GUARD=0, a scene's
/// first unit bringing the guard with it; under hardware traversal, when a limit is set.
fn guard_room(hwrt: bool) -> bool {
    loop_guard_of(!hwrt).is_some()
}

/// What a host decides about a device before it is opened (`Gpu::new_with`). `Gpu::new` takes it from the environment
/// (`from_env`), where every platform but Android gets `default()`: the device, its layout and its kernels as they
/// are without any of this. What a phone's GPU needed and why: docs/RUNTIME.md "Android (Adreno)".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GpuOptions {
    /// The kernel's bounded tables (texture pages, objects, instances, media) as uniform buffers instead of storage
    /// buffers (merged.rs `UNIFORM_TABLES`). None: where a driver needs it, which is Android. Never with the merged
    /// layout, whose tables are one buffer of its own.
    pub uniform_tables: Option<bool>,
    /// The seven tables the kernel reads at every hit or light (materials, lights, emitters, texture rects, objects,
    /// instances, media) as views of their sections, each a binding of its own (merged.rs `TABLE_VIEWS`), or read from
    /// the tables' buffer whole by the offsets in the parameters, as the merged layout reads them. None: views, but on
    /// Android: Adreno 740's driver read the views wrong (docs/RUNTIME.md "Android"). Without views there are no
    /// uniform tables either.
    pub table_views: Option<bool>,
    /// A directory to keep compiled pipelines in between runs (pipeline_cache.rs). None: nothing is kept.
    pub pipeline_cache: Option<std::path::PathBuf>,
    pub kernel: KernelSwitches,
}

impl GpuOptions {
    /// THREERT_UNIFORM_TABLES=1|0, THREERT_PIPELINE_CACHE=<directory>, and the
    /// kernel's switches (`KernelSwitches::from_env`).
    pub fn from_env() -> GpuOptions {
        Self::from_vars(&|name| std::env::var(name).ok(), cfg!(target_os = "android"))
    }

    /// `from_env`, of these variables on this platform.
    fn from_vars(var: &dyn Fn(&str) -> Option<String>, android: bool) -> GpuOptions {
        GpuOptions {
            uniform_tables: var("THREERT_UNIFORM_TABLES").map(|v| v == "1"),
            table_views: var("THREERT_TABLE_VIEWS").map(|v| v == "1"),
            pipeline_cache: var("THREERT_PIPELINE_CACHE").filter(|d| !d.is_empty()).map(std::path::PathBuf::from),
            kernel: KernelSwitches::from_vars(var, android),
        }
    }

    /// Whether the kernel reads its tables from views of their sections: as asked, else everywhere but Android; never
    /// in the merged layout.
    fn table_views_on(&self, merged: bool, android: bool) -> bool {
        !merged && self.table_views.unwrap_or(!android)
    }

    /// Whether the device has the uniform tables (copies of four of the views): as asked, else on Android; only with
    /// the views.
    fn uniform_tables_on(&self, merged: bool, android: bool) -> bool {
        self.table_views_on(merged, android) && self.uniform_tables.unwrap_or(android)
    }
}

/// The kernel's switches: changes to its source for a GPU that the source as written is wrong or too slow on. Each
/// is a flag of the kernel's conditional translation (`KernelVariant::flags`; pathtrace.wgsl, trace_hw.wgsl and
/// translucent.wgsl say where, under `@if`); with none set the kernel is as written, every platform's default but
/// Android's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KernelSwitches {
    /// THREERT_KERNEL_STRICT=1|0 (Android: 1). The kernel gives the driver nothing undefined to act on:
    ///  - a ray query whose ray is not finite (origin, direction) or whose length is negative or NaN is not made: the
    ///    ray misses. Such a description is undefined behaviour; on Adreno 740 the odd one faulted the GPU's MMU
    ///    thousands of times a second and doubled the trace. (naga's `ray_query_initialization_tracking` would do
    ///    it with bookkeeping around every ray-query call.)
    ///  - `env_pdf` no longer forms the index before the first entry (`select` evaluates both sides: `y - 1` at
    ///    y = 0 is 0xffffffff, read and then not used).
    pub strict: bool,
    /// THREERT_CUTOUT_LITE=0|1|2 (Android: 1). Hardware traversal: 1 = shadow rays and the other any-hit rays take
    /// alpha cutouts as opaque; 2 = camera rays also step through at most 4 cutouts (16 as written). Alpha-tested
    /// traversal is what costs most on Adreno 740 (a map with cutout foliage: the trace 235 ms, 41 ms without).
    pub cutout_lite: u32,
    /// THREERT_LAST_DIRECT=1|0 (Android: 1). The path's last vertex (past the camera hit, at the bounce limit) still
    /// takes its direct light. A device that affords one bounce and no radiance cache otherwise lights that bounce
    /// by sky and emitters alone: sunlit ground lit nothing, interiors were black.
    pub last_direct: bool,
    /// THREERT_LAST_DIRECT=sun (off everywhere unless set; the ThreeRT clients set it for a budget of one bounce on
    /// Linux). The path's last vertex takes the directional lights' direct light alone (one shadow ray a light): what
    /// one bounce indoors lacks most (sunlit floor lighting the ceiling: Daylight Home's ceiling was black on a Steam
    /// Deck), at a fraction of `last_direct`'s cost where a scene has many local lights (OpenStrikeRT's Foundry on the
    /// Deck: +1 ms a frame, `last_direct` +8). `last_direct` includes it.
    pub last_sun: bool,
    /// THREERT_LIGHT_PICK=1|0 (off everywhere unless set). Past the camera hit, `direct_light` takes the directional
    /// lights and one of the other kinds a scene has (local lights, emitters, the sky), weighted by their number,
    /// instead of all of them: two shadow rays a vertex instead of four. Unbiased; the indirect light is noisier.
    pub light_pick: bool,
}

impl KernelSwitches {
    pub fn from_env() -> KernelSwitches {
        Self::from_vars(&|name| std::env::var(name).ok(), cfg!(target_os = "android"))
    }

    fn from_vars(var: &dyn Fn(&str) -> Option<String>, android: bool) -> KernelSwitches {
        let num = |name: &str, default: u32| var(name).and_then(|v| v.parse::<u32>().ok()).unwrap_or(default);
        let on = android as u32;
        let sun = var("THREERT_LAST_DIRECT").is_some_and(|v| v.trim() == "sun");
        KernelSwitches { strict: num("THREERT_KERNEL_STRICT", on) != 0, cutout_lite: num("THREERT_CUTOUT_LITE", on), last_direct: !sun && num("THREERT_LAST_DIRECT", on) != 0, last_sun: sun, light_pick: num("THREERT_LIGHT_PICK", 0) != 0 }
    }
}

/// The kernel's runtime checks: none (all indices come from our own BVH / scene builder). THREERT_CHECKED turns naga's
/// on to diagnose a driver: 1 = every check, else a mask (2 bounds, 4 loop bounding, 8 ray-query initialization
/// tracking).
fn kernel_checks() -> wgpu::ShaderRuntimeChecks {
    let v: u32 = std::env::var("THREERT_CHECKED").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    if v == 1 {
        return wgpu::ShaderRuntimeChecks::checked();
    }
    let mut c = wgpu::ShaderRuntimeChecks::unchecked();
    c.bounds_checks = v & 2 != 0;
    c.force_loop_bounding = v & 4 != 0;
    c.ray_query_initialization_tracking = v & 8 != 0;
    c
}

pub fn tlas_rows(w: glam::Mat4) -> [f32; 12] {
    let row = |r: usize| [w.x_axis[r], w.y_axis[r], w.z_axis[r], w.w_axis[r]];
    let [r0, r1, r2] = [row(0), row(1), row(2)];
    [r0[0], r0[1], r0[2], r0[3], r1[0], r1[1], r1[2], r1[3], r2[0], r2[1], r2[2], r2[3]]
}

/// Entries of the live radiance cache (pathtrace.wgsl CACHE_SIZE).
pub const CACHE_SIZE: u64 = 1 << 18;
/// The kernel's `finish` pass (pathtrace.wgsl): a record's bytes (DEFERRED_VECS vec4s) after the 16 of their count,
/// and the invocations of a dispatch row (DEFERRED_ROW).
pub const DEFERRED_BYTES: u64 = 96;

/// A buffer, or a range of one: in the merged layout (merged.rs) several of the engine's buffers are ranges of the one
/// buffer a binding holds.
#[derive(Clone)]
pub struct Buf {
    pub buffer: wgpu::Buffer,
    pub offset: u64,
    pub size: u64,
}

impl Buf {
    pub fn whole(buffer: wgpu::Buffer) -> Buf {
        let size = buffer.size();
        Buf { buffer, offset: 0, size }
    }

    /// As a binding (a whole buffer: `as_entire_binding`).
    pub fn binding(&self) -> wgpu::BindingResource<'_> {
        if self.offset == 0 && self.size == self.buffer.size() {
            self.buffer.as_entire_binding()
        } else {
            wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.buffer, offset: self.offset, size: std::num::NonZeroU64::new(self.size) })
        }
    }

    pub fn clear(&self, e: &mut wgpu::CommandEncoder) {
        e.clear_buffer(&self.buffer, self.offset, Some(self.size));
    }
}

/// The radiance cache's storage (pathtrace.wgsl): voxel keys, this frame's training sums, resolved values.
#[derive(Clone)]
pub struct CacheBuffers {
    pub keys: Buf,
    pub acc: Buf,
    pub val: Buf,
}

impl CacheBuffers {
    pub fn new(d: &wgpu::Device, entries: u64) -> CacheBuffers {
        let b = |label, size| Buf::whole(d.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        CacheBuffers { keys: b("cache keys", entries * 4), acc: b("cache sums", entries * 32), val: b("cache values", entries * 32) }
    }

    /// Empties the cache (a different world).
    pub fn clear(&self, e: &mut wgpu::CommandEncoder) {
        for b in [&self.keys, &self.acc, &self.val] {
            b.clear(e);
        }
    }
}

/// The kernel's group-1 buffers: the radiance cache, what the live passes read of a trace (live/targets.rs
/// `Targets`: the specular-lobe rays, the motion vectors, the directional lights' direct light) and the light tiles'
/// lists. In the merged layout they are the sections of one buffer (`heap::Live`).
pub struct KernelBufs {
    pub cache: CacheBuffers,
    pub refl: Buf,
    pub motion: Buf,
    pub direct: Buf,
    pub lists: Buf,
    /// The pixels a sample's trace leaves for `finish` (their count, then `DEFERRED_BYTES` each): the layout as
    /// written only. Of one record until a live view makes it for its traced size (`deferred_buffer`).
    pub deferred: Option<Buf>,
    /// The loop guard's count (`guard_loops`: its first word, the invocations a loop of which was stopped): with
    /// the guard, and always in the merged layout.
    pub guard: Option<Buf>,
    /// The merged layout: the one buffer.
    pub merged: Option<Heap<Live>>,
}

impl KernelBufs {
    /// Each in a buffer of its own: the live passes' four of these bytes, made (and `deferred` of one record: its view
    /// makes it for what it traces), with this radiance cache and loop guard's count.
    fn separate(d: &wgpu::Device, cache: CacheBuffers, guard: Option<Buf>, refl: u64, motion: u64, direct: u64, lists: u64) -> KernelBufs {
        let sb = |label: &str, size: u64| Buf::whole(d.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false }));
        KernelBufs { cache, refl: sb("refl", refl), motion: sb("motion", motion), direct: sb("direct", direct), lists: sb("light lists", lists), deferred: Some(deferred_buffer(d, 1)), guard, merged: None }
    }

    /// For a cache of `entries` and the live passes' four of these bytes.
    /// `guard`: the layout as written has the guard's count (`Gpu::guard_room`).
    pub fn new(d: &wgpu::Device, merged: bool, guard: bool, entries: u64, refl: u64, motion: u64, direct: u64, lists: u64) -> KernelBufs {
        if !merged {
            let guard = guard.then(|| Buf::whole(d.create_buffer(&wgpu::BufferDescriptor { label: Some("loop guard"), size: crate::merged::GUARD_WORDS as u64 * 4, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false })));
            return KernelBufs::separate(d, CacheBuffers::new(d, entries), guard, refl, motion, direct, lists);
        }
        // (The cache's keys and sums are as long as the kernel's struct says, whatever `entries`: `live_sizes`. A
        // section's range is the bytes asked for: a pass that binds it sees an array of that length.)
        let bytes = live_sizes(entries, refl, motion, direct, lists);
        let heap = Heap::<Live>::new(d, &bytes);
        let b = |s: Live| Buf { buffer: heap.buffer.clone(), offset: heap.at(s), size: bytes[s.index()] };
        KernelBufs { cache: CacheBuffers { keys: b(Live::CacheKeys), acc: b(Live::CacheAcc), val: b(Live::CacheVal) }, refl: b(Live::Refl), motion: b(Live::Motion), direct: b(Live::Direct), lists: b(Live::Lists), deferred: None, guard: Some(b(Live::Guard)), merged: Some(heap) }
    }

    /// Where the kernel finds the vec4 sections in the merged layout (`Params::live_first`, `live_len`): written with
    /// the parameters of whatever is traced into these buffers.
    pub fn place(&self, p: &mut Params) {
        let Some(heap) = &self.merged else { return };
        let first = |s: Live| ((heap.at(s) - heap.at(Live::CacheVal)) / 16) as u32;
        p.live_first = [[first(Live::CacheVal), first(Live::Refl), first(Live::Motion), first(Live::Direct)], [first(Live::Lists), 0, 0, 0]];
        p.live_len = [&self.refl, &self.motion, &self.direct, &self.lists].map(|b| (b.size / 16) as u32);
    }
}

/// `finish`'s buffer for `records` pixels: their count (16 bytes, cleared before each sample), then the records.
pub fn deferred_buffer(d: &wgpu::Device, records: u64) -> Buf {
    Buf::whole(d.create_buffer(&wgpu::BufferDescriptor { label: Some("deferred"), size: 16 + records.max(1) * DEFERRED_BYTES, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }))
}

/// The bytes of the merged layout's group-1 buffer's sections (`heap::Live`'s order) for a cache whose values are
/// `entries` long and the live passes' four of these bytes. The cache's keys and sums and the loop guard's count are
/// members of the kernel's struct, of the kernel's lengths (pathtrace.wgsl `MergedLive`).
pub(crate) fn live_sizes(entries: u64, refl: u64, motion: u64, direct: u64, lists: u64) -> [u64; 8] {
    [CACHE_SIZE * 4, CACHE_SIZE * 32, crate::merged::GUARD_WORDS as u64 * 4, entries * 32, refl, motion, direct, lists]
}

/// Group-1 bind group of the kernel: a primary-visibility texture, the radiance cache and the
/// reflection resolve's inputs (`KernelBufs`); in the merged layout, the texture and the one buffer.
/// `deferred`: with `finish`'s records (`vis_layout`; the translucency pass's `tl_vis_layout` is without).
pub fn vis_bind_group(d: &wgpu::Device, layout: &wgpu::BindGroupLayout, view: &wgpu::TextureView, b: &KernelBufs, deferred: bool) -> wgpu::BindGroup {
    fn e(binding: u32, b: &Buf) -> wgpu::BindGroupEntry<'_> {
        wgpu::BindGroupEntry { binding, resource: b.binding() }
    }
    let tex = wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) };
    match &b.merged {
        Some(heap) => d.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("vis"), layout, entries: &[tex, wgpu::BindGroupEntry { binding: crate::merged::LIVE_BINDING, resource: heap.buffer.as_entire_binding() }] }),
        None => {
            let mut entries = vec![tex, e(1, &b.cache.keys), e(2, &b.cache.acc), e(3, &b.cache.val), e(crate::merged::LISTS_BINDING, &b.lists), e(5, &b.refl), e(6, &b.motion), e(7, &b.direct)];
            entries.extend(b.deferred.as_ref().filter(|_| deferred).map(|r| e(crate::merged::DEFERRED_BINDING, r)));
            entries.extend(b.guard.as_ref().map(|g| e(crate::merged::GUARD_BINDING, g)));
            d.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("vis"), layout, entries: &entries })
        }
    }
}

/// Whether a material function's WGSL (`fn mf_<name>(...) -> MatOut { var o = base; ... return o; }`) can change its
/// result's `field`: it names `o.<field>`, or uses `o` otherwise than as `o.<another field>` (a whole assignment, a
/// pointer passed on) beyond its declaration and its return.
fn writes_field(code: &str, field: &str) -> bool {
    if code.contains(&format!("o.{field}")) {
        return true;
    }
    let body = code.replacen("var o = base;", "", 1).replace("return o;", "");
    let b = body.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    (0..b.len()).any(|k| b[k] == b'o' && (k == 0 || !ident(b[k - 1])) && b.get(k + 1).is_none_or(|&c| !ident(c) && c != b'.'))
}

/// What the path-tracing kernel is specialised on: the scene's feature mask and its material functions (WGSL).
#[derive(Clone)]
pub struct Kernel {
    pub features: u32,
    pub functions: String,
    /// The scene's volume functions and their dispatch (pathtrace.wgsl `volume_function`), spliced like `functions`.
    pub volume_functions: String,
    /// The scene's geometry functions and their dispatch (pathtrace.wgsl `geometry_function`), spliced like `functions`.
    pub geometry_functions: String,
    pub hash: u64,
}

impl Kernel {
    /// A pipeline's constant: `FEAT`.
    fn constants(&self) -> [(&'static str, f64); 1] {
        [("FEAT", self.features as f64)]
    }

    pub fn new(scene: &Scene, groups: [usize; GROUPS]) -> Kernel {
        let mut functions = String::new();
        if !scene.shaders.is_empty() {
            let mut seen = std::collections::HashSet::new();
            for (_, _, helpers) in &scene.shaders {
                if !helpers.is_empty() && seen.insert(helpers.clone()) {
                    functions.push_str(helpers);
                    functions.push('\n');
                }
            }
            for (_, code, _) in &scene.shaders {
                functions.push_str(code);
                functions.push('\n');
            }
            functions.push_str("fn material_function(f: i32, i: MatIn, m: Material, base: MatOut) -> MatOut {\n    switch f {\n");
            for (k, (id, _, _)) in scene.shaders.iter().enumerate() {
                functions.push_str(&format!("        case {k} {{ return mf_{id}(i, m, base); }}\n"));
            }
            functions.push_str("        default { return base; }\n    }\n}\n");
            // The sites that read one field of the result (alpha tests: `opacity`; emitter sampling: `emissive`): only
            // the functions that can change it; for the others the result's field is `base`'s. Each site inlines its
            // dispatch, and a function's code costs the kernel there even where it never runs (wetLayer's puddles:
            // ~0.8 ms on Tokyo, dry).
            for (name, field) in [("alpha_material_function", "opacity"), ("emissive_material_function", "emissive")] {
                functions.push_str(&format!("fn {name}(f: i32, i: MatIn, m: Material, base: MatOut) -> MatOut {{\n    switch f {{\n"));
                for (k, (id, code, _)) in scene.shaders.iter().enumerate() {
                    if writes_field(code, field) {
                        functions.push_str(&format!("        case {k} {{ return mf_{id}(i, m, base); }}\n"));
                    }
                }
                functions.push_str("        default { return base; }\n    }\n}\n");
            }
        }
        let mut volume_functions = String::new();
        if !scene.volume_fns.is_empty() {
            let mut seen = std::collections::HashSet::new();
            for (_, _, helpers) in &scene.volume_fns {
                if !helpers.is_empty() && seen.insert(helpers.clone()) {
                    volume_functions.push_str(helpers);
                    volume_functions.push('\n');
                }
            }
            for (_, code, _) in &scene.volume_fns {
                volume_functions.push_str(code);
                volume_functions.push('\n');
            }
            volume_functions.push_str("fn volume_function(f: u32, i: VIn, p: array<vec4<f32>, 8>) -> VOut {\n    switch f {\n");
            for (k, (id, _, _)) in scene.volume_fns.iter().enumerate() {
                volume_functions.push_str(&format!("        case {k}u {{ return vf_{id}(i, p); }}\n"));
            }
            volume_functions.push_str("        default { return VOut(0.0, vec3<f32>(1.0), vec3<f32>(0.0)); }\n    }\n}\n");
        }
        let mut geometry_functions = String::new();
        if !scene.geometry_fns.is_empty() {
            let mut seen = std::collections::HashSet::new();
            for (_, _, helpers) in &scene.geometry_fns {
                if !helpers.is_empty() && seen.insert(helpers.clone()) {
                    geometry_functions.push_str(helpers);
                    geometry_functions.push('\n');
                }
            }
            for (_, code, _) in &scene.geometry_fns {
                geometry_functions.push_str(code);
                geometry_functions.push('\n');
            }
            geometry_functions.push_str("fn geometry_function(f: u32, i: GIn) -> GOut {\n    switch f {\n");
            for (k, (id, _, _)) in scene.geometry_fns.iter().enumerate() {
                geometry_functions.push_str(&format!("        case {k}u {{ return gf_{id}(i); }}\n"));
            }
            geometry_functions.push_str("        default { return GOut(-1.0, vec3<f32>(0.0, 1.0, 0.0), 0u, vec2<f32>(0.0)); }\n    }\n}\n");
        }
        // (Functions from a package built before the kernel was WESL, as WESL reads them: `legacy_wgsl`.)
        let (functions, volume_functions, geometry_functions) = (legacy_wgsl(functions), legacy_wgsl(volume_functions), legacy_wgsl(geometry_functions));
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        functions.hash(&mut h);
        volume_functions.hash(&mut h);
        geometry_functions.hash(&mut h);
        Kernel { features: features(scene, groups), functions, volume_functions, geometry_functions, hash: h.finish() }
    }
}


// Kernel features (`override FEAT` in pathtrace.wgsl).
pub const F_MASKED: u32 = 1;
pub const F_FOG: u32 = 64;
pub const F_VOLUME: u32 = 128;
pub const F_TEX: u32 = 256;
pub const F_FUNC: u32 = 512;
// (1024: the emitter-reservoir experiment, removed 2026-11-13.)
pub const F_GLASS: u32 = 2048;
pub const F_COAT: u32 = 4096;
/// A traversal group starts beyond 2^24 triangles: hardware instances carry their group index instead of their first
/// triangle (24-bit custom data), and hits look the offset up in `Params::group_first` (~0.2 ms on Kabukicho, so only
/// when needed).
pub const F_HUGE: u32 = 8192;
/// Instanced glTF meshes (scene::Instance): TLAS instances with custom data INSTANCE_BIT | record index, shaded from
/// model-space triangles through their `instances` record.
pub const F_INST: u32 = 16384;
/// Bounded participating media (`VolumeMesh`; pathtrace.wgsl `media_track`): compiled out where no scene has one.
pub const F_MEDIA: u32 = 32768;
/// Opaque particles: the kernel's emitter handling for them (nominal areas, emission not light-sampled), compiled out
/// elsewhere.
pub const F_PEMIT: u32 = 65536;
/// Homogeneous media (`VolumeMesh` `homogeneous`, water): the live kernel's analytic attenuation of paths and shadow
/// rays through them (pathtrace.wgsl `media_homogeneous`), compiled out elsewhere (it cost a scene with other media
/// 0.6 ms).
pub const F_HMEDIA: u32 = 131072;
/// Procedural geometry (`ProceduralMesh`; pathtrace.wgsl `proc_*`): AABB candidates in every ray query, its hits'
/// own surface path. Compiled out where no scene has any (`THREERT_FEATURES_ON` forces it in, to measure that cost).
pub const F_PROC: u32 = 262144;
/// Instance colours (`InstancedMesh.setColorAt`): object entries of 4 vec4s, the base colour times the 4th
/// (`scene::object_stride`).
pub const F_TINT: u32 = 524288;
/// three.js MeshBasicMaterial (`scene::MAT_UNLIT`): seen by camera rays, lit by nothing, lighting nothing.
pub const F_UNLIT: u32 = 1 << 20;
/// three.js `scene.background`: camera rays that miss see `Params::background`.
pub const F_BACKGROUND: u32 = 1 << 21;
/// three.js `vertexColors` (`scene::tri_colors`): a colour per triangle vertex multiplies the base colour.
pub const F_VCOLOR: u32 = 1 << 22;
/// Density grids (`scene::GridBuild`): the grid atlas (binding 19) and `vgrid` for volume functions. (Bit 24 is
/// F_AERIAL's.)
pub const F_GRID: u32 = 1 << 25;
/// More shadow-casting local lights than the kernel sums exactly at a camera hit (`RIS_EXACT`): they are resampled,
/// guided live by the light tiles (pathtrace.wgsl "Light tiles"; the live view's `light_tiles` pass runs for such a
/// scene).
pub const F_LISTS: u32 = 1 << 27;
/// 北冥：有材质的边缘色（`GpuMaterial::specular_tint`）不是白：材质求值从材质记录读它。别的场景里内核编译期取白，
/// F82 的 B 项跟着是编译期的 0（一律从记录读时，没有金属的场景稳态也慢 4%）。
pub const F_SPECULAR_TINT: u32 = 1 << 28;
/// Whether a scene with more such lights has the light tiles (`F_LISTS`): `THREERT_LIGHT_TILES=1|0`, else everywhere
/// but Android. On Adreno 740 they took OpenStrikeRT's Foundry from 31 to 48 ms a frame (249 x 140, one bounce):
/// there the lights are resampled as in a scene of fewer, unguided (docs/RUNTIME.md "Android").
pub fn light_tiles_on() -> bool {
    light_tiles_of(std::env::var("THREERT_LIGHT_TILES").ok().as_deref(), cfg!(target_os = "android"))
}

fn light_tiles_of(var: Option<&str>, android: bool) -> bool {
    var.map_or(!android, |v| v == "1")
}
/// Local lights the kernel sums exactly (pathtrace.wgsl `RIS_EXACT`; the test below holds the two together).
pub const RIS_EXACT: usize = 8;
/// The features that change the kernel's source (an `@if` flag) rather than switch code in it (`FEAT`): none.
pub const F_SOURCE: u32 = 0;
/// The sky's aerial perspective (SkyAtmosphere `aerialPerspective`; pathtrace.wgsl `aerial_tr`) on every path segment
/// that ends on a surface: compiled out where no scene has it. (Bit 23 is left to INSTANCE_BIT below.)
pub const F_AERIAL: u32 = 1 << 24;
/// Marks a model instance's custom data (bit 23); group instances then stay below it.
pub const INSTANCE_BIT: u32 = 1 << 23;

/// Whether some traversal group starts beyond what instance custom data holds (see F_HUGE): 24 bits, or 23 when
/// model instances take the top bit.
pub fn huge(groups: [usize; GROUPS], instanced: bool) -> bool {
    let limit = if instanced { 1 << 23 } else { 1 << 24 };
    let mut first = 0;
    groups.iter().any(|&count| {
        let past = count > 0 && first >= limit;
        first += count;
        past
    })
}

/// Features a scene needs; `THREERT_FEATURES` (bit mask) restricts them for profiling.
pub fn features(scene: &Scene, groups: [usize; GROUPS]) -> u32 {
    features_of(&scene.materials, scene.environment.features(), !scene.textures.is_empty(), !scene.shaders.is_empty(), groups, instance_features(scene))
}

impl Params {
    /// What the kernel takes from the render preset and the camera's exposure: the bounce limit, the depth Russian
    /// roulette starts at, the firefly clamp on indirect paths (relative to the exposure), energy compensation.
    pub fn set_preset(&mut self, native: &crate::desc::NativePreset, exposure: &crate::desc::Exposure) {
        self.counts[2] = native.max_bounces;
        self.counts[3] = native.russian_roulette_depth;
        self.misc[0] = native.firefly_clamp(exposure);
        self.misc[2] = native.energy_compensation;
    }
}

/// Kernel features of the environment, which edits change: fog (F_FOG, with lit scattering F_VOLUME), a background
/// (F_BACKGROUND), the sky's aerial perspective (F_AERIAL; `aerial`: `Params::aerial`).
pub fn environment_features(fog: Option<&crate::desc::Fog>, background: bool, aerial: [f32; 4]) -> u32 {
    let mut f = if background { F_BACKGROUND } else { 0 } | if aerial[0] > 0.0 { F_AERIAL } else { 0 };
    if let Some(fog) = fog.filter(|fog| fog.density > 0.0) {
        f |= F_FOG | if fog.volumetric.as_ref().is_some_and(|v| v.scattering > 0.0) { F_VOLUME } else { 0 };
    }
    f
}

/// Kernel features of the scene's structure, which parameter edits do not change: F_INST and F_MASKED for the
/// instanced meshes (cutout triangles among them), F_MEDIA for participating media (F_HMEDIA for homogeneous ones),
/// F_PEMIT for opaque particles, F_PROC for procedural geometry, F_TINT for instance colours.
pub fn instance_features(scene: &Scene) -> u32 {
    // (F_GRID also for a volume function that calls `vgrid` on a node without a grid: it reads zeros.)
    let grid = !scene.grids.is_empty() || (!scene.media.is_empty() && scene.volume_fns.iter().any(|(_, code, helpers)| code.contains("vgrid(") || helpers.contains("vgrid(")));
    let media = if scene.media.is_empty() { 0 } else { F_MEDIA } | if scene.media.iter().any(|m| m.a[2] != 0) { F_HMEDIA } else { 0 } | if grid { F_GRID } else { 0 };
    let particles = if scene.procs.is_empty() { 0 } else { F_PROC } | if scene.tinted { F_TINT } else { 0 } | if scene.gpu_vcolors.is_empty() { 0 } else { F_VCOLOR } | if light_tiles_on() && scene.lights.iter().filter(|l| l.pos[3] != 0.0 && l.ext[3] >= 0.5).count() > RIS_EXACT { F_LISTS } else { 0 };
    if scene.gpu_instances.is_empty() {
        return media | particles;
    }
    media | particles | F_INST | if scene.meshes.iter().any(|m| m.opaque < m.count) { F_MASKED } else { 0 }
}

/// `features` from the parts parameter edits change (the materials; `environment`: `environment_features`), and the
/// scene's structure (`instances`: `instance_features`).
pub fn features_of(ms: &[crate::scene::GpuMaterial], environment: u32, textures: bool, functions: bool, groups: [usize; GROUPS], instances: u32) -> u32 {
    // `instances` carries the structural features (instance_features): instancing is its F_INST bit.
    let instanced = instances & F_INST != 0;
    let mut f = instances | environment;
    if groups[1] + groups[3] + groups[5] + groups[7] > 0 {
        f |= F_MASKED;
    }
    if textures {
        f |= F_TEX;
    }
    if functions {
        f |= F_FUNC;
    }
    if ms.iter().any(|m| m.layer[0] > 0.0) {
        f |= F_GLASS;
    }
    if ms.iter().any(|m| m.layer[2] > 0.0) {
        f |= F_COAT;
    }
    if ms.iter().any(|m| m.tex1[2] == crate::scene::MAT_UNLIT) {
        f |= F_UNLIT;
    }
    if ms.iter().any(|m| m.specular_tint != [1.0; 3]) {
        f |= F_SPECULAR_TINT;
    }
    if huge(groups, instanced) {
        f |= F_HUGE;
    }

    if let Some(mask) = std::env::var("THREERT_FEATURES").ok().and_then(|v| v.parse::<u32>().ok()) {
        f &= mask | F_HUGE | F_INST | F_PROC | F_TINT; // not optional: they say what the instances' custom data / the object table holds
    }
    // Features compiled in although the scene does not use them (the perf smoke's cost of a contract compiled in but off).
    if let Some(on) = std::env::var("THREERT_FEATURES_ON").ok().and_then(|v| v.parse::<u32>().ok()) {
        f |= on;
    }
    f
}

pub struct EnvMap {
    pub width: u32,
    pub height: u32,
    pub texels: Vec<[f32; 4]>,
}

pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub color: Vec<[f32; 3]>,
    pub albedo: Vec<[f32; 3]>,
    pub normal: Vec<[f32; 3]>,
    /// With `Params::motion.y` (`render --signals`): what the camera saw directly, and the specular share at the camera
    /// hit (the diffuse signal: color less both). Zero otherwise.
    pub emission: Vec<[f32; 3]>,
    pub specular: Vec<[f32; 3]>,
    /// Variance of the per-pixel mean luminance.
    pub variance: Vec<f32>,
    /// 北冥：这次渲染请求的每个灯组一层（每个像素的均值），没请求就是空的。现在还没有贡献写进灯组：全 0。
    pub lightgroups: Vec<Vec<[f32; 3]>>,
    pub samples: u32,
}

impl Gpu {
    /// The GPU, waited for (the native shell; a browser has `new_async`: nothing may block there).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new() -> Result<Gpu> {
        pollster::block_on(Self::new_async())
    }

    /// `new`, with a host's own options instead of the environment's.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new_with(options: GpuOptions) -> Result<Gpu> {
        pollster::block_on(Self::new_async_with(options))
    }

    /// The adapter and the device come from futures: a browser resolves them from its event loop.
    pub async fn new_async() -> Result<Gpu> {
        Self::new_async_with(GpuOptions::from_env()).await
    }

    /// `new_async`, with a host's own options instead of the environment's.
    pub async fn new_async_with(options: GpuOptions) -> Result<Gpu> {
        let backends = wgpu::Backends::from_env().unwrap_or(wgpu::Backends::PRIMARY);
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = backends;
        let instance = wgpu::Instance::new(desc);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, force_fallback_adapter: false, compatible_surface: None, ..Default::default() })
            .await
            .map_err(|e| anyhow!("no GPU adapter: {e}"))?;
        let adapter_info = adapter.get_info();
        let al = adapter.limits();
        // The defaults, lowered where the adapter cannot meet them (the iOS Simulator's GPU allows 15 inter-stage
        // variables, not 16); on desktop GPUs this changes nothing.
        let mut limits = wgpu::Limits::default().or_worse_values_from(&al);
        limits.max_storage_buffer_binding_size = al.max_storage_buffer_binding_size;
        limits.max_buffer_size = al.max_buffer_size;
        limits.max_texture_array_layers = al.max_texture_array_layers;
        limits.max_texture_dimension_2d = al.max_texture_dimension_2d;
        // The merged binding layout (merged.rs): a browser's, where a stage has eight storage buffers; natively with
        // THREERT_MERGED=1, on software traversal (what a browser has) and the device held to the same eight (a
        // layout with more does not validate).
        let merged = cfg!(target_arch = "wasm32") || std::env::var("THREERT_MERGED").is_ok_and(|v| v == "1");
        limits.max_storage_buffers_per_shader_stage = if merged { crate::merged::STORAGE_BUFFERS } else { al.max_storage_buffers_per_shader_stage.min(31) };
        // Storage + uniform buffers and acceleration structures together (the translucency pass binds 24 storage
        // buffers, 25 with the loop guard's, 2 uniform ones and 2 structures; Metal allows 29).
        limits.max_buffers_and_acceleration_structures_per_shader_stage = al.max_buffers_and_acceleration_structures_per_shader_stage.min(31);
        limits.max_acceleration_structures_per_shader_stage = al.max_acceleration_structures_per_shader_stage;
        limits.max_blas_geometry_count = al.max_blas_geometry_count;
        limits.max_blas_primitive_count = al.max_blas_primitive_count;
        limits.max_tlas_instance_count = al.max_tlas_instance_count;
        let hwrt = !merged && adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) && std::env::var("THREERT_HWRT").map(|v| v != "0").unwrap_or(true);
        let timestamps = adapter.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        let mut features = if hwrt { wgpu::Features::EXPERIMENTAL_RAY_QUERY } else { wgpu::Features::empty() };
        if timestamps {
            features |= wgpu::Features::TIMESTAMP_QUERY;
        }
        // Compiled pipelines kept between runs, where a host gave a directory and the backend has a cache.
        let cache_feature = options.pipeline_cache.as_ref().and_then(|_| crate::pipeline_cache::PipelineCache::feature(&adapter, &adapter_info));
        features |= cache_feature.unwrap_or(wgpu::Features::empty());
        let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("threert"),
            required_features: features,
            required_limits: limits,
            // Ray queries are still flagged experimental in wgpu 30.
            experimental_features: if hwrt { unsafe { wgpu::ExperimentalFeatures::enabled() } } else { wgpu::ExperimentalFeatures::disabled() },
            ..Default::default()
        }).await?;
        let pipeline_cache = cache_feature.and_then(|_| crate::pipeline_cache::PipelineCache::open(&device, options.pipeline_cache.as_ref()?, &adapter_info));
        let uniform_tables = options.uniform_tables_on(merged, cfg!(target_os = "android"));
        let whole_tables = !merged && !options.table_views_on(merged, cfg!(target_os = "android"));
        let switches = options.kernel;
        let src = kernel_template();
        // Bounds checks are not needed: all indices come from our own BVH / scene builder.
        let module = unsafe {
            let wgsl = kernel_wgsl(&src, &KernelVariant { merged, uniform_tables, whole_tables, guard: loop_guard_of(false), ..KernelVariant::new(hwrt, switches, 0) });
            device.create_shader_module_trusted(wgpu::ShaderModuleDescriptor { label: Some("pathtrace"), source: wgpu::ShaderSource::Wgsl(wgsl.into()) }, kernel_checks())
        };
        let [entries, vis_entries] = kernel_layout_entries(LayoutShape { hwrt, merged, uniform_tables, whole_tables, guard: guard_room(hwrt) });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &entries });
        let vis_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("vis"), entries: &vis_entries });
        let one = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("no vis"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R32Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let no_vis_view = one.create_view(&Default::default());
        let no_grid_view = grid_texture(&device, "no grid", [1, 1, 1], false).create_view(&Default::default());
        let no_vis_bufs = KernelBufs::new(&device, merged, guard_room(hwrt), 1, 64, 64, 64, 64);
        let no_vis = vis_bind_group(&device, &vis_layout, &no_vis_view, &no_vis_bufs, true);
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout), Some(&vis_layout)], immediate_size: 0 });
        Ok(Gpu { instance, adapter, timestamps, device, queue, adapter_info, uniform_tables, whole_tables, switches, pipeline_cache, source: src, module, merged, modules: Default::default(), pipeline_layout: pl, pipelines: Default::default(), layout, vis_layout, no_vis, no_vis_bufs, no_vis_view, no_grid_view, hwrt, pages: Default::default(), proc_cache: Default::default(), proc_blases: Default::default() })
    }

    /// Whether this device's kernel buffers have the loop guard's count (`guard_room`; always in the merged layout).
    pub fn guard_room(&self) -> bool {
        guard_room(self.hwrt)
    }

    /// The pipeline cache for the descriptor of a pipeline about to be made (None: nothing is kept between runs).
    pub fn cache(&self) -> Option<&wgpu::PipelineCache> {
        self.pipeline_cache.as_ref().map(|c| c.for_pipeline())
    }

    /// The pipelines made since the last call, to the cache's file (pipeline_cache.rs: nothing when none was made, or
    /// the cache already had them). The renderer calls it after it compiles a kernel variant, a scene's passes and
    /// the live passes; a host that makes pipelines of its own with `cache` calls it after them.
    pub fn save_pipeline_cache(&self) {
        if let Some(c) = &self.pipeline_cache {
            c.save();
        }
    }

    /// The path-tracing kernel specialised for a scene (feature mask + material functions), compiled on first use.
    pub fn pipeline(&self, k: &Kernel) -> wgpu::ComputePipeline {
        let mut cache = self.pipelines.lock().unwrap();
        cache
            .entry((k.features, k.hash))
            .or_insert_with(|| {
                let module = self.kernel_module(k);
                let constants = k.constants();
                let p = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("pathtrace"),
                    layout: Some(&self.pipeline_layout),
                    module: &module,
                    entry_point: Some("main"),
                    compilation_options: wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() },
                    cache: self.cache(),
                });
                self.save_pipeline_cache();
                p
            })
            .clone()
    }

    /// The kernel module for a scene: the shared one, or with its material functions spliced in.
    fn kernel_module(&self, k: &Kernel) -> wgpu::ShaderModule {
        let patches = k.features & F_SOURCE;
        if patches == 0 && k.functions.is_empty() && k.volume_functions.is_empty() && k.geometry_functions.is_empty() {
            return self.module.clone();
        }
        let mut mods = self.modules.lock().unwrap();
        mods.entry((k.hash, patches))
            .or_insert_with(|| {
                let splice = |src: &str, marker: &str, code: &str| -> String {
                    if code.is_empty() {
                        return src.to_string();
                    }
                    let (head, rest) = src.split_once(&format!("// @{marker}-begin")).unwrap();
                    let (_, tail) = rest.split_once(&format!("// @{marker}-end")).unwrap();
                    format!("{head}{code}{tail}")
                };
                let src = splice(&splice(&splice(&self.source, "material-functions", &k.functions), "volume-functions", &k.volume_functions), "geometry-functions", &k.geometry_functions);
                // The variant: this device's traversal, switches, layout and loop guard, this scene's features.
                let v = KernelVariant { merged: self.merged, uniform_tables: self.uniform_tables, whole_tables: self.whole_tables, guard: loop_guard_of(false), ..KernelVariant::new(self.hwrt, self.switches, patches) };
                // A scene's functions that do not compile (a game's own WGSL) cost the game its functions, not the
                // app its renderer: the kernel is made without them, and the game's log says why. (A panic here took
                // the engine down, and ThreeRT for Android then took the device for one without a renderer.)
                let wgsl = try_kernel_wgsl(&src, &v).unwrap_or_else(|e| {
                    let msg = format!("this scene's material, volume or geometry functions do not compile, so it is drawn without them: {e}");
                    #[cfg(not(target_arch = "wasm32"))]
                    crate::script::engine_log("error", &msg);
                    #[cfg(target_arch = "wasm32")]
                    eprintln!("{msg}");
                    kernel_wgsl(&self.source, &v)
                });
                unsafe { self.device.create_shader_module_trusted(wgpu::ShaderModuleDescriptor { label: Some("pathtrace+functions"), source: wgpu::ShaderSource::Wgsl(wgsl.into()) }, kernel_checks()) }
            })
            .clone()
    }

    /// A view's buffer of the trace's samples (`Uploaded::film`; film.wgsl `film`): `film.film_stride` vec4s a pixel
    /// (北冥：开渲前先按显卡的上限算大小，`film_bytes`), the largest buffer a view holds
    /// (`view_fits`).
    pub fn film_buffer(&self, w: u32, h: u32, film: &KernelFilm) -> Result<wgpu::Buffer> {
        let limits = self.device.limits();
        let size = film_bytes(w, h, film, (limits.max_storage_buffer_binding_size as u64).min(limits.max_buffer_size))?;
        Ok(self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("film"), size, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }))
    }

    /// Texture pages for the scene's texture set (see `texpack`), cached across uploads of the same set.
    fn texture_pages(&self, scene: &Scene, timings: &mut Vec<(String, f64)>) -> (wgpu::TextureView, std::sync::Arc<Vec<[f32; 4]>>) {
        let key = crate::texpack::set_key(&scene.textures);
        let mut cache = self.pages.lock().unwrap();
        if let Some(p) = cache.as_ref() {
            if p.key == key {
                return (p.view.clone(), p.info.clone());
            }
        }
        let t = Instant::now();
        let d = &self.device;
        let packed = crate::texpack::pack(&scene.textures);
        let side = packed.side;
        let tex = d.create_texture(&wgpu::TextureDescriptor {
            label: Some("texture pages"),
            size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: packed.layers.len() as u32 },
            mip_level_count: crate::texpack::MIPS,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        for (z, chain) in packed.layers.iter().enumerate() {
            for (lvl, img) in chain.iter().enumerate() {
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: lvl as u32, origin: wgpu::Origin3d { x: 0, y: 0, z: z as u32 }, aspect: wgpu::TextureAspect::All },
                    img.as_raw(),
                    wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(img.width() * 4), rows_per_image: Some(img.height()) },
                    wgpu::Extent3d { width: img.width(), height: img.height(), depth_or_array_layers: 1 },
                );
            }
        }
        let view = tex.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
        let info = std::sync::Arc::new(packed.info);
        timings.push(("texture_pages_ms".into(), t.elapsed().as_secs_f64() * 1000.0));
        *cache = Some(Pages { key, view: view.clone(), info: info.clone() });
        (view, info)
    }

    /// Uploads a prepared scene (geometry, materials, textures, environment, acceleration structures) and returns the
    /// bind group used by both the offline and the live kernels. `film` is the output buffer (`film_buffer`).
    #[allow(clippy::too_many_arguments)]
    pub fn upload(&self, scene: &Scene, film: &wgpu::Buffer, tri_verts: &[[f32; 4]], groups: [usize; GROUPS], nodes: &[u8], emitters: &[[f32; 4]], emitter_tris: &[crate::GpuEmitterTri], light_tree: &[[f32; 4]], env: &EnvMap, env_cdf: &[f32], energy: &[[f32; 4]], timings: &mut Vec<(String, f64)>) -> Result<Uploaded> {
        let d = &self.device;
        let t0 = Instant::now();
        // (The vertices too: the kernel's tree over no triangle is a leaf of triangle 0, which these zeros make a
        // triangle without area; bvh.rs `EMPTY`.)
        let buf = |label: &str, bytes: &[u8], usage: wgpu::BufferUsages| {
            let data: &[u8] = if bytes.is_empty() { &[0u8; 512] } else { bytes };
            d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: data, usage })
        };
        // The same with `extra` zeroed bytes after the data (the edit room; none: as `buf`).
        let buf_room = |label: &str, bytes: &[u8], extra: usize, usage: wgpu::BufferUsages| {
            if extra == 0 {
                return buf(label, bytes, usage);
            }
            let b = d.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: ((bytes.len() + extra) as u64).next_multiple_of(4), usage, mapped_at_creation: true });
            if !bytes.is_empty() {
                b.slice(..bytes.len() as u64).get_mapped_range_mut().expect("mapped at creation").copy_from_slice(bytes);
            }
            b.unmap();
            b
        };
        let records: Vec<crate::scene::GpuInstance> = scene.gpu_instances.iter().chain(&scene.proc_records).copied().collect();
        let room = EditRoom::for_scene(scene, tri_verts.len() / 3, records.len(), self.hwrt);
        let st = wgpu::BufferUsages::STORAGE;
        // (COPY_SRC: the live view's in-place edits grow these past their room by a copy, live/edits.rs `edit_geometry`.)
        let edit = st | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC;
        let b_verts = buf_room("verts", bytemuck::cast_slice(tri_verts), room.tris * 48, edit | wgpu::BufferUsages::COPY_SRC);
        let dynamic_first: usize = groups[..4].iter().sum();
        // The dynamic tail (groups 4..8; the instanced pool follows it, its deforming meshes first: theirs too).
        let dynamic_end: usize = groups.iter().sum::<usize>() + crate::scene::deforming_pool(&scene.meshes);
        let prev = &tri_verts[(dynamic_first * 3).min(tri_verts.len())..(dynamic_end * 3).min(tri_verts.len())];
        let b_prev = buf("prev verts", bytemuck::cast_slice(prev), edit);
        // The vertex colours' bytes on the GPU (the edit room's included).
        timings.push(("vcolor_mb".into(), if scene.gpu_vcolors.is_empty() { 0.0 } else { (scene.gpu_vcolors.len() * 4 + room.tris * 12) as f64 / (1 << 20) as f64 }));
        let b_attrs = buf_room("attrs", bytemuck::cast_slice(&scene.attrs), room.tris * std::mem::size_of::<crate::scene::GpuTriAttr>(), edit);
        let b_nodes = buf("nodes", nodes, st);
        // What the triangles hold on the GPU besides their BLASes: vertices (a, e1, e2), attributes, the software BVH's nodes
        // (ROADMAP § 6 step 2's table: a meshed representation against voxel data).
        timings.push(("tri_data_mb".into(), (std::mem::size_of_val(tri_verts) + std::mem::size_of_val(&scene.attrs[..]) + nodes.len()) as f64 / (1 << 20) as f64));
        let (words, region_words, proc_room) = self.upload_words(scene, env_cdf, room.proc_words, room.tris, timings)?;
        let room = EditRoom { proc_words: proc_room, ..room };
        // Density grids: field A of each in the atlas (stacked along z), their data.
        let grids = (!scene.grids.is_empty()).then(|| {
            let dims = [scene.grids.iter().map(|g| g.dims[0]).max().unwrap(), scene.grids.iter().map(|g| g.dims[1]).max().unwrap(), scene.grids.iter().map(|g| g.dims[2]).sum()];
            let atlas = grid_texture(d, "grid atlas", dims, true);
            for g in &scene.grids {
                if let Some(data) = &g.data {
                    self.write_grid(&atlas, g.z0, g.dims, data);
                }
            }
            GridsGpu { atlas }
        });
        let grid_view = grids.as_ref().map_or_else(|| self.no_grid_view.clone(), |g| g.atlas.create_view(&Default::default()));
        let b_film = film.clone();
        let b_params = d.create_buffer(&wgpu::BufferDescriptor { label: Some("params"), size: std::mem::size_of::<Params>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });

        let (tex_view, tex_info) = self.texture_pages(scene, timings);
        // The scene's tables, the sections of one buffer (heap.rs), written as it is made. The objects' and the
        // records' have the edits' room after them (the procedural objects' records follow the model instances').
        let none = [crate::scene::GpuInstance::default()];
        let spheres = crate::light_groups(&scene.lights);
        // 北冥：材质表在这里统一写能量补偿那一位（全局开关：预设的 energyCompensation，非 0 即开；`Params::set_preset`
        // 把同一个数写进 misc.z 给上游顶替读）。
        let materials = crate::scene::with_energy_compensation(&scene.materials, scene.preset.native.energy_compensation != 0.0);
        // 北冥：物体扩展表，每个物体一项，现在全是 0（还没有人填）。
        let object_ext = vec![crate::scene::GpuObjectExt::default(); scene.objects.len() / scene.object_stride()];
        let parts: [(Table, &[u8], usize); Table::COUNT] = [
            (Table::LightTree, bytemuck::cast_slice(light_tree), 0),
            (Table::Materials, bytemuck::cast_slice(&materials), 0),
            (Table::Lights, bytemuck::cast_slice(&scene.lights), 0),
            (Table::LightGroups, bytemuck::cast_slice(&spheres), 0),
            (Table::Emitters, bytemuck::cast_slice(emitters), 0),
            (Table::TexInfo, bytemuck::cast_slice(&tex_info[..]), 0),
            (Table::Objects, bytemuck::cast_slice(&scene.objects), room.objects * scene.object_stride() * 16),
            (Table::Instances, bytemuck::cast_slice(if records.is_empty() { &none[..] } else { &records[..] }), room.records * std::mem::size_of::<crate::scene::GpuInstance>()),
            (Table::Media, bytemuck::cast_slice(&scene.media), 0),
            (Table::Energy, bytemuck::cast_slice(energy), 0),
            (Table::GlassEnergy, bytemuck::cast_slice(crate::glass_energy_lut()), 0),
            (Table::EmitterTris, bytemuck::cast_slice(emitter_tris), 0),
            (Table::ObjectExt, bytemuck::cast_slice(&object_ext), room.objects * std::mem::size_of::<crate::scene::GpuObjectExt>()),
        ];
        assert!(parts.iter().enumerate().all(|(k, p)| p.0.index() == k), "the tables in `Table`'s order");
        let heap = Heap::filled(d, &parts.map(|p| (p.1.len() + p.2) as u64), |put| parts.iter().for_each(|p| put(p.0, 0, p.1)));

        let env_tex = self.env_texture(env);
        let env_view = env_tex.create_view(&Default::default());
        let sampler = d.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        // Hardware acceleration structures, one BLAS per traversal group (see `Prepared::groups`): shadow casters have
        // mask 1, the rest mask 2; alpha-cutout groups are non-opaque so the ray query reports candidates to test.
        let mut accel = None;
        if self.hwrt {
            let tb = Instant::now();
            let verts: Vec<[f32; 3]> = tri_verts
                .chunks(3)
                .flat_map(|t| {
                    let v0 = [t[0][0], t[0][1], t[0][2]];
                    crate::scene::blas_tri([v0, [v0[0] + t[1][0], v0[1] + t[1][1], v0[2] + t[1][2]], [v0[0] + t[2][0], v0[1] + t[2][1], v0[2] + t[2][2]]])
                })
                .collect();
            let vbuf = buf_room("blas_verts", bytemuck::cast_slice(&verts), room.tris * 36, wgpu::BufferUsages::BLAS_INPUT | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::STORAGE);
            let huge_scene = huge(groups, !scene.gpu_instances.is_empty());
            let mut first = 0usize;
            let groups: Vec<(usize, usize, u8, bool)> = groups
                .iter()
                .enumerate()
                .map(|(g, &count)| {
                    let r = (first, count, if g % 4 < 2 { 1u8 } else { 2u8 }, g % 2 == 0);
                    first += count;
                    r
                })
                .collect();
            let pool_first = first;
            let mut t = d.create_tlas(&wgpu::CreateTlasDescriptor { label: None, max_instances: (GROUPS + scene.instances.len() + scene.procs.len() + room.records) as u32, flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE, update_mode: wgpu::AccelerationStructureUpdateMode::Build });
            let sizes: Vec<wgpu::BlasTriangleGeometrySizeDescriptor> = groups
                .iter()
                .map(|&(_, count, _, opaque)| wgpu::BlasTriangleGeometrySizeDescriptor {
                    vertex_format: wgpu::VertexFormat::Float32x3,
                    vertex_count: (count * 3) as u32,
                    index_format: None,
                    index_count: None,
                    flags: if opaque { wgpu::AccelerationStructureGeometryFlags::OPAQUE } else { wgpu::AccelerationStructureGeometryFlags::empty() },
                })
                .collect();
            let mut blases = vec![];
            for (i, (first, count, mask, _)) in groups.iter().enumerate() {
                if *count == 0 {
                    continue;
                }
                // Dynamic groups (4..8) are rebuilt whenever something in them moves: built fast rather than traced fast
                // (the C slice's ~100 k moving triangles: rebuild 4.14 -> 3.1 ms a frame, trace unchanged).
                let flags = if i >= 4 { wgpu::AccelerationStructureFlags::PREFER_FAST_BUILD } else { wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE };
                let blas = d.create_blas(
                    &wgpu::CreateBlasDescriptor { label: None, flags, update_mode: wgpu::AccelerationStructureUpdateMode::Build },
                    wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors: vec![sizes[i].clone()] },
                );
                // Custom data = the first triangle, or past 2^24 (F_HUGE) the group: `Params::group_first` has its first.
                let custom = if huge_scene { i as u32 } else { *first as u32 };
                t[blases.len()] = Some(wgpu::TlasInstance::new(&blas, [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0], custom, *mask));
                blases.push((blas, i, *first, sizes[i].clone()));
            }
            // Instanced meshes: one opaque model-space BLAS each, a TLAS instance per placement (custom data
            // INSTANCE_BIT | record; shadow casters mask 1).
            // Per mesh: (first triangle, count, opaque) geometries: the opaque part, then the cutout part (any-hit).
            let mesh_parts: Vec<Vec<(u32, u32, bool)>> = scene.meshes.iter().map(|m| [(m.first, m.opaque, true), (m.first + m.opaque, m.count - m.opaque, false)].into_iter().filter(|p| p.1 > 0).collect()).collect();
            let mesh_sizes: Vec<Vec<wgpu::BlasTriangleGeometrySizeDescriptor>> = mesh_parts
                .iter()
                .map(|parts| {
                    parts
                        .iter()
                        .map(|&(_, count, opaque)| wgpu::BlasTriangleGeometrySizeDescriptor {
                            vertex_format: wgpu::VertexFormat::Float32x3,
                            vertex_count: count * 3,
                            index_format: None,
                            index_count: None,
                            flags: if opaque { wgpu::AccelerationStructureGeometryFlags::OPAQUE } else { wgpu::AccelerationStructureGeometryFlags::empty() },
                        })
                        .collect()
                })
                .collect();
            // Deforming meshes (shared poses) are rebuilt every new pose: built fast rather than traced fast, as the dynamic
            // groups are.
            let meshes: Vec<wgpu::Blas> = mesh_sizes
                .iter()
                .zip(&scene.meshes)
                .map(|(s, m)| {
                    let flags = if m.deforms { wgpu::AccelerationStructureFlags::PREFER_FAST_BUILD } else { wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE };
                    d.create_blas(&wgpu::CreateBlasDescriptor { label: None, flags, update_mode: wgpu::AccelerationStructureUpdateMode::Build }, wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors: s.clone() })
                })
                .collect();
            // What the triangle BLASes hold (Metal's own sizes; each instanced mesh once) and their vertex buffer.
            let group_parts = groups.iter().filter(|g| g.1 > 0).map(|&(first, count, _, opaque)| vec![((first * 3) as u32, (count * 3) as u32, opaque)]);
            let mesh_vertex_parts = mesh_parts.iter().map(|ps| ps.iter().map(|&(first, count, opaque)| ((pool_first as u32 + first) * 3, count * 3, opaque)).collect::<Vec<_>>());
            let mut blas_per_tri = 0.0;
            let parts: Vec<Vec<(u32, u32, bool)>> = group_parts.chain(mesh_vertex_parts).collect();
            if let Some(bytes) = parts.iter().map(|ps| self.tri_blas_bytes(&vbuf, ps)).sum::<Option<u64>>() {
                timings.push(("tri_blas_mb".into(), (bytes + vbuf.size()) as f64 / (1 << 20) as f64));
                let tris: u64 = parts.iter().flatten().map(|p| p.1 as u64 / 3).sum();
                blas_per_tri = bytes as f64 / tris.max(1) as f64;
            }
            let base = blases.len();
            for (k, inst) in scene.instances.iter().enumerate() {
                let w = inst.world;
                let row = |r: usize| [w.x_axis[r], w.y_axis[r], w.z_axis[r], w.w_axis[r]];
                let [r0, r1, r2] = [row(0), row(1), row(2)];
                let xf = [r0[0], r0[1], r0[2], r0[3], r1[0], r1[1], r1[2], r1[3], r2[0], r2[1], r2[2], r2[3]];
                t[base + k] = Some(wgpu::TlasInstance::new(&meshes[inst.mesh as usize], xf, INSTANCE_BIT | k as u32, instance_mask(inst.cast_shadow, inst.hidden)));
            }
            // Procedural geometry: one AABB BLAS per distinct geometry (object space; kept across uploads by the
            // geometry's hash, so a rebuild builds only new ones), and per mesh a TLAS instance of it after the model
            // instances, whose custom data is the mesh's record; its hits are told apart by their kind.
            let proc_base = base + scene.instances.len();
            let mut built = self.proc_blases.lock().unwrap();
            let mut kept: std::collections::HashMap<[u8; 32], (wgpu::Blas, u64)> = Default::default();
            let mut proc_new: Vec<(usize, wgpu::Buffer, wgpu::BlasAABBGeometrySizeDescriptor)> = vec![];
            let geo_blas: Vec<wgpu::Blas> = scene.proc_layout.as_ref().map_or(vec![], |l| {
                l.blobs
                    .iter()
                    .enumerate()
                    .map(|(k, (b, _))| {
                        let (blas, bytes) = built.get(&b.hash).cloned().unwrap_or_else(|| {
                            let size = wgpu::BlasAABBGeometrySizeDescriptor { primitive_count: (b.boxes.len() / 6) as u32, flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE };
                            let blas = d.create_blas(&wgpu::CreateBlasDescriptor { label: Some("proc"), flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE, update_mode: wgpu::AccelerationStructureUpdateMode::Build }, wgpu::BlasGeometrySizeDescriptors::AABBs { descriptors: vec![size.clone()] });
                            let boxes = d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("proc boxes"), contents: bytemuck::cast_slice(&b.boxes), usage: wgpu::BufferUsages::BLAS_INPUT });
                            let bytes = self.aabb_blas_bytes(&boxes, size.primitive_count).unwrap_or(0);
                            proc_new.push((k, boxes, size));
                            (blas, bytes)
                        });
                        kept.insert(b.hash, (blas.clone(), bytes));
                        blas
                    })
                    .collect()
            });
            // What the procedural BLASes hold on the GPU (each distinct geometry once; ROADMAP § 6 step 2's table).
            timings.push(("proc_blas_mb".into(), kept.values().map(|(_, b)| *b).sum::<u64>() as f64 / (1 << 20) as f64));
            *built = kept;
            drop(built);
            for (j, p) in scene.procs.iter().enumerate() {
                let record = (scene.gpu_instances.len() + j) as u32;
                anyhow::ensure!(record < INSTANCE_BIT, "too many instances for 23-bit custom data");
                let k = scene.proc_layout.as_ref().map_or(j, |l| l.blob_of[j]);
                t[proc_base + j] = Some(wgpu::TlasInstance::new(&geo_blas[k], tlas_rows(p.world), record, instance_mask(p.cast_shadow, p.hidden)));
            }
            let entries: Vec<wgpu::BlasBuildEntry> = blases
                .iter()
                .map(|(blas, _, first, size)| wgpu::BlasBuildEntry {
                    blas,
                    geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                        size,
                        vertex_buffer: &vbuf,
                        first_vertex: (*first * 3) as u32,
                        vertex_stride: 12,
                        index_buffer: None,
                        first_index: None,
                        transform_buffer: None,
                        transform_buffer_offset: None,
                    }]),
                })
                .chain(meshes.iter().zip(&mesh_sizes).zip(&mesh_parts).map(|((blas, sizes), parts)| wgpu::BlasBuildEntry {
                    blas,
                    geometry: wgpu::BlasGeometries::TriangleGeometries(
                        sizes
                            .iter()
                            .zip(parts)
                            .map(|(size, &(first, _, _))| wgpu::BlasTriangleGeometry {
                                size,
                                vertex_buffer: &vbuf,
                                first_vertex: ((pool_first + first as usize) * 3) as u32,
                                vertex_stride: 12,
                                index_buffer: None,
                                first_index: None,
                                transform_buffer: None,
                                transform_buffer_offset: None,
                            })
                            .collect(),
                    ),
                }))
                .chain(proc_new.iter().map(|(k, boxes, size)| wgpu::BlasBuildEntry {
                    blas: &geo_blas[*k],
                    geometry: wgpu::BlasGeometries::AabbGeometries(vec![wgpu::BlasAabbGeometry { size, stride: 24, aabb_buffer: boxes, primitive_offset: 0 }]),
                }))
                .collect();
            let mut enc = d.create_command_encoder(&Default::default());
            enc.build_acceleration_structures(entries.iter(), [&t]);
            self.queue.submit([enc.finish()]);
            self.device.poll(wgpu::PollType::wait_indefinitely())?;
            drop(entries);
            accel = Some(Accel { tlas: t, verts: vbuf, inst_base: base, proc_base, blas_per_tri });
            timings.push(("accel_build_ms".into(), tb.elapsed().as_secs_f64() * 1000.0));
        }
        // The uniform tables: four tables' sections again in uniform buffers (merged.rs `UNIFORM_TABLES`).
        let uniform = self.uniform_tables.then(|| {
            // What the scene has of each, against what its array holds (the sections have the edits' room after it).
            let used = [tex_info.len() as u64, scene.objects.len() as u64, records.len() as u64, scene.media.len() as u64];
            for note in uniform_overflow(used) {
                eprintln!("threert: {note}");
            }
            self.uniform_copies(&heap)
        });
        let bg_parts = BindParts { nodes: b_nodes, tex_view, env_view, sampler, grid_view };
        let bg = self.scene_bind_group(&SceneBuffers { params: &b_params, verts: &b_verts, attrs: &b_attrs, heap: &heap, words: &words, prev_verts: &b_prev, film: &b_film, parts: &bg_parts, accel: accel.as_ref(), uniform: uniform.as_ref() });
        let kernel = Kernel::new(scene, groups);
        self.queue.submit([]);
        self.device.poll(wgpu::PollType::wait_indefinitely())?;
        timings.push(("upload_ms".into(), t0.elapsed().as_secs_f64() * 1000.0));
        Ok(Uploaded { bg, bg_parts, heap, uniform, film: b_film, params: b_params, kernel, verts: b_verts, attrs: b_attrs, prev_verts: b_prev, dynamic_first, accel, grids, vcolors: !scene.gpu_vcolors.is_empty(), media_nodes: scene.media_nodes.clone(), media_hidden: std::cell::RefCell::new(scene.media.iter().map(|m| m.a[1] == crate::scene::MEDIUM_HIDDEN).collect()), room, words, cdf_words: env_cdf.len(), region_words, env_tex })
    }

    /// Bytes Metal allocates for an AABB BLAS over `count` boxes in `boxes` (its own size query through wgpu-hal; None
    /// on other backends).
    fn aabb_blas_bytes(&self, boxes: &wgpu::Buffer, count: u32) -> Option<u64> {
        #[cfg(target_vendor = "apple")]
        {
            use wgpu::hal::{api::Metal, Device as _};
            let d = unsafe { self.device.as_hal::<Metal>() }?;
            let b = unsafe { boxes.as_hal::<Metal>() }?;
            let entries = wgpu::hal::AccelerationStructureEntries::AABBs(vec![wgpu::hal::AccelerationStructureAABBs { buffer: Some(&*b), offset: 0, count, stride: 24, flags: wgpu::hal::AccelerationStructureGeometryFlags::OPAQUE }]);
            let s = unsafe { d.get_acceleration_structure_build_sizes(&wgpu::hal::GetAccelerationStructureBuildSizesDescriptor { entries: &entries, flags: wgpu::hal::AccelerationStructureBuildFlags::PREFER_FAST_TRACE }) };
            return Some(s.acceleration_structure_size);
        }
        #[allow(unreachable_code)]
        {
            let _ = (boxes, count);
            None
        }
    }

    /// Bytes Metal allocates for a triangle BLAS over the (first vertex, vertex count, opaque) geometries of `verts`
    /// (non-indexed Float32x3, as every triangle BLAS here; None on other backends).
    fn tri_blas_bytes(&self, verts: &wgpu::Buffer, parts: &[(u32, u32, bool)]) -> Option<u64> {
        #[cfg(target_vendor = "apple")]
        {
            use wgpu::hal::{api::Metal, Device as _};
            let d = unsafe { self.device.as_hal::<Metal>() }?;
            let b = unsafe { verts.as_hal::<Metal>() }?;
            let entries = wgpu::hal::AccelerationStructureEntries::Triangles(
                parts
                    .iter()
                    .map(|&(first_vertex, vertex_count, opaque)| wgpu::hal::AccelerationStructureTriangles {
                        vertex_buffer: Some(&*b),
                        vertex_format: wgpu::VertexFormat::Float32x3,
                        first_vertex,
                        vertex_count,
                        vertex_stride: 12,
                        indices: None,
                        transform: None,
                        flags: if opaque { wgpu::hal::AccelerationStructureGeometryFlags::OPAQUE } else { wgpu::hal::AccelerationStructureGeometryFlags::empty() },
                    })
                    .collect(),
            );
            let s = unsafe { d.get_acceleration_structure_build_sizes(&wgpu::hal::GetAccelerationStructureBuildSizesDescriptor { entries: &entries, flags: wgpu::hal::AccelerationStructureBuildFlags::PREFER_FAST_TRACE }) };
            return Some(s.acceleration_structure_size);
        }
        #[allow(unreachable_code)]
        {
            let _ = (verts, parts);
            None
        }
    }

    /// The scene's 32-bit arrays (heap.rs `Stream`): the environment's CDF, the procedural region (scene::ProcLayout:
    /// headers and materials, then the geometries' blobs) and the vertex colours, each with its edit room
    /// (`room_words` after the region, as much of it as the binding limit leaves; `room_tris` triangles' colours).
    /// Written straight into the new buffer's mapping; the blobs are copied on the GPU from the last upload when its
    /// geometries are the same. Returns the heap, the region's words in use and the room it got.
    fn upload_words(&self, scene: &Scene, env_cdf: &[f32], room_words: usize, room_tris: usize, timings: &mut Vec<(String, f64)>) -> Result<(Heap<Stream>, usize, usize)> {
        let t = Instant::now();
        let l = scene.proc_layout.as_ref();
        let (head, blob_words) = l.map_or((0, 0), |l| (l.head.len(), l.blob_words));
        let colors: &[u8] = bytemuck::cast_slice(&scene.gpu_vcolors);
        let color_bytes = if colors.is_empty() { 0 } else { colors.len() + room_tris * 12 };
        let sizes = |room: usize| [(env_cdf.len() * 4) as u64, ((head + blob_words + room) * 4) as u64, color_bytes as u64];
        let (used, limit) = (Heap::<Stream>::size_for(&sizes(0)), self.device.limits().max_storage_buffer_binding_size as u64);
        if used > limit {
            return Err(anyhow!("procedural geometry: {} MB of data, more than this device binds in one buffer ({} MB)", used >> 20, limit >> 20));
        }
        // (A section's size is rounded up to where the next may start.)
        let room = room_words.min(((limit - used) / 4).saturating_sub(crate::heap::ALIGN / 4) as usize);
        let sizes = sizes(room);
        let blob_at = (head * 4) as u64;
        let blob_bytes = (blob_words * 4) as u64;
        let key = l.map(|l| l.key());
        let mut cache = self.proc_cache.lock().unwrap();
        let reuse = cache.as_ref().filter(|c| blob_bytes > 0 && Some(&c.key) == key.as_ref() && c.bytes == blob_bytes);
        // Reused blobs: the small parts written through the queue, the blobs copied on the GPU (a mapped buffer of the
        // whole size would be zero-filled on the CPU first: 17 ms for 256 MB). New ones: written into the mapping.
        let heap = match (reuse, l) {
            (Some(c), Some(l)) => {
                let heap = Heap::new(&self.device, &sizes);
                heap.write(&self.queue, Stream::EnvCdf, 0, bytemuck::cast_slice(env_cdf));
                heap.write(&self.queue, Stream::Procs, 0, bytemuck::cast_slice(&l.head));
                heap.write(&self.queue, Stream::VertexColors, 0, colors);
                let mut e = self.device.create_command_encoder(&Default::default());
                e.copy_buffer_to_buffer(&c.buf, c.offset, &heap.buffer, heap.at(Stream::Procs) + blob_at, c.bytes);
                self.queue.submit([e.finish()]);
                heap
            }
            _ => Heap::filled(&self.device, &sizes, |put| {
                put(Stream::EnvCdf, 0, bytemuck::cast_slice(env_cdf));
                put(Stream::VertexColors, 0, colors);
                let Some(l) = l else { return };
                put(Stream::Procs, 0, bytemuck::cast_slice(&l.head));
                for (blob, off) in &l.blobs {
                    let mut at = blob_at + (off * 4) as u64;
                    let mut parts: Vec<&[u8]> = vec![bytemuck::cast_slice(&blob.boxes), bytemuck::cast_slice(&blob.data)];
                    if l.sw {
                        let (nodes, order) = blob.sw_bvh();
                        parts.extend([bytemuck::cast_slice::<_, u8>(nodes), bytemuck::cast_slice(order)]);
                    }
                    for part in parts {
                        put(Stream::Procs, at, part);
                        at += part.len() as u64;
                    }
                }
            }),
        };
        if let Some(key) = key {
            timings.push((if reuse.is_some() { "proc_copy_ms" } else { "proc_upload_ms" }.into(), t.elapsed().as_secs_f64() * 1000.0));
            // The procedural region's GPU bytes (headers, materials, blobs: boxes and data, once per distinct geometry).
            timings.push(("proc_data_mb".into(), ((head + blob_words) * 4) as f64 / (1 << 20) as f64));
            *cache = Some(ProcCache { key, buf: heap.buffer.clone(), offset: heap.at(Stream::Procs) + blob_at, bytes: blob_bytes });
        }
        Ok((heap, head + blob_words, room))
    }

    /// A grid's data (four f32 a cell) into the atlas, from layer `z0`.
    fn write_grid(&self, atlas: &wgpu::Texture, z0: u32, dims: [u32; 3], data: &[f32]) {
        let halves = grid_halves(data);
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: atlas, mip_level: 0, origin: wgpu::Origin3d { x: 0, y: 0, z: z0 }, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(&halves),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(dims[0] * 8), rows_per_image: Some(dims[1]) },
            wgpu::Extent3d { width: dims[0], height: dims[1], depth_or_array_layers: dims[2] },
        );
    }

    /// An environment map's texture, with its texels.
    fn env_texture(&self, env: &EnvMap) -> wgpu::Texture {
        let t = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("env"),
            size: wgpu::Extent3d { width: env.width, height: env.height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.write_env_texels(&t, env);
        t
    }

    fn write_env_texels(&self, t: &wgpu::Texture, env: &EnvMap) {
        let half: Vec<u16> = env.texels.iter().flat_map(|t| t.iter().map(|v| half::f16::from_f32(v.min(65000.0)).to_bits())).collect();
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(&half),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(env.width * 8), rows_per_image: Some(env.height) },
            wgpu::Extent3d { width: env.width, height: env.height, depth_or_array_layers: 1 },
        );
    }

    /// The scene's bind group (group 0: pathtrace.wgsl's declarations, the layout `Gpu::new` makes).
    fn scene_bind_group(&self, b: &SceneBuffers) -> wgpu::BindGroup {
        let view = |binding: u32, v| wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(v) };
        let p = b.parts;
        let mut entries = vec![
            buffer_entry(0, b.params),
            buffer_entry(1, b.verts),
            buffer_entry(2, b.attrs),
            buffer_entry(4, &b.heap.buffer),
            buffer_entry(5, &b.words.buffer),
            buffer_entry(6, b.prev_verts),
            view(7, &p.tex_view),
            wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::Sampler(&p.sampler) },
            view(9, &p.env_view),
            view(10, &p.grid_view),
            buffer_entry(11, b.film),
        ];
        if !self.hwrt {
            entries.push(buffer_entry(3, &p.nodes));
        }
        if !self.merged && !self.whole_tables {
            for &(table, binding) in &crate::merged::TABLE_VIEWS {
                let copy = b.uniform.and_then(|u| u.iter().zip(&crate::merged::UNIFORM_TABLES).find(|(_, t)| t.binding == binding).map(|(c, _)| c));
                entries.push(match copy {
                    Some(c) => buffer_entry(binding, c),
                    None => wgpu::BindGroupEntry { binding, resource: b.heap.binding(table) },
                });
            }
        }
        if let Some(a) = b.accel {
            entries.push(wgpu::BindGroupEntry { binding: ACC_BINDING, resource: a.tlas.as_binding() });
        }
        self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.layout, entries: &entries })
    }

    /// The loop guard's count as the GPU has it now (None: the kernels have no guard): the invocations it stopped since
    /// the buffers were made. Waits for the GPU.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn guard_trips(&self, bufs: &KernelBufs) -> Result<Option<u32>> {
        let Some(g) = bufs.guard.as_ref().filter(|_| loop_guard_of(false).is_some()) else { return Ok(None) };
        let read = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("loop guard read"), size: 4, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut e = self.device.create_command_encoder(&Default::default());
        e.copy_buffer_to_buffer(&g.buffer, g.offset, &read, 0, 4);
        self.queue.submit([e.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        self.device.poll(wgpu::PollType::wait_indefinitely())?;
        let n = u32::from_le_bytes(read.slice(..).get_mapped_range()?[..4].try_into().expect("four bytes"));
        Ok(Some(n))
    }

    /// The uniform tables' buffers (merged.rs `UNIFORM_TABLES`' order), filled from their sections as they are now.
    fn uniform_copies(&self, heap: &Heap<Table>) -> [wgpu::Buffer; 4] {
        let copies = crate::merged::UNIFORM_TABLES.each_ref().map(|t| {
            // (COPY_SRC: read back by the test that holds them to the tables, and by whoever diagnoses a driver.)
            self.device.create_buffer(&wgpu::BufferDescriptor { label: Some(t.name), size: t.stride * t.len as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false })
        });
        let mut e = self.device.create_command_encoder(&Default::default());
        Self::copy_uniform(&mut e, heap, &copies);
        self.queue.submit([e.finish()]);
        copies
    }

    fn copy_uniform(e: &mut wgpu::CommandEncoder, heap: &Heap<Table>, copies: &[wgpu::Buffer; 4]) {
        for (t, dst) in crate::merged::UNIFORM_TABLES.iter().zip(copies) {
            e.copy_buffer_to_buffer(&heap.buffer, heap.at(t.table), dst, 0, uniform_copy_bytes(heap.cap(t.table), dst.size()));
        }
    }

    /// The uniform tables: their sections as they are now, copied into the four uniform buffers. The renderer writes
    /// the tables' heap; the passes that read the scene read these copies, so they are made in their encoder, before
    /// them, each frame, after whatever writes a table on the GPU in that encoder (the particle passes write their
    /// objects' entries).
    pub fn sync_tables(&self, up: &Uploaded, e: &mut wgpu::CommandEncoder) {
        if let Some(u) = &up.uniform {
            Self::copy_uniform(e, &up.heap, u);
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    /// Render `spp` samples. `base` holds everything except the per-dispatch sample index.
    #[allow(clippy::too_many_arguments)]
    pub fn render(&self, scene: &Scene, tri_verts: &[[f32; 4]], groups: [usize; GROUPS], nodes: &[u8], emitters: &[[f32; 4]], emitter_tris: &[crate::GpuEmitterTri], light_tree: &[[f32; 4]], env: &EnvMap, env_cdf: &[f32], energy: &[[f32; 4]], base: Params, spp: u32, timings: &mut Vec<(String, f64)>) -> Result<Frame> {
        let d = &self.device;
        let (w, h) = (scene.width, scene.height);
        // 北冥：掩码为 0 时每个样本取的是同一个点，画面不收敛而不报错，所以开渲前拦住。
        if base.integrator.sobol_index_mask == 0 {
            return Err(anyhow!("全局参数的 integrator.sobol_index_mask 是 0：每个样本会取同一个点。用 KernelIntegrator::new 填"));
        }
        let up = self.upload(scene, &self.film_buffer(w, h, &base.film)?, tri_verts, groups, nodes, emitters, emitter_tris, light_tree, env, env_cdf, energy, timings)?;
        let pipeline = self.pipeline(&up.kernel);
        let (b_film, b_params, bg) = (&up.film, &up.params, &up.bg);
        let film_size = b_film.size();
        let stopped_before = self.guard_trips(&self.no_vis_bufs)?;


        let t1 = Instant::now();
        let mut enc = d.create_command_encoder(&Default::default());
        enc.clear_buffer(b_film, 0, None);
        self.sync_tables(&up, &mut enc);
        self.queue.submit([enc.finish()]);
        // One dispatch per sample; params are rewritten between submissions. Batch a few per submit.
        let batch = 4u32;
        let mut s = 0u32;
        while s < spp {
            for k in 0..batch.min(spp - s) {
                let mut p = base;
                p.size[2] = s + k;
                up.place(&mut p);
                self.no_vis_bufs.place(&mut p);
                self.queue.write_buffer(b_params, 0, bytemuck::bytes_of(&p));
                let mut enc = d.create_command_encoder(&Default::default());
                {
                    let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
                    pass.set_pipeline(&pipeline);
                    pass.set_bind_group(0, bg, &[]);
                    pass.set_bind_group(1, &self.no_vis, &[]);
                    pass.dispatch_workgroups(w.div_ceil(8), h.div_ceil(8), 1);
                }
                self.queue.submit([enc.finish()]);
            }
            s += batch.min(spp - s);
            self.device.poll(wgpu::PollType::wait_indefinitely())?;
        }
        timings.push(("trace_ms".into(), t1.elapsed().as_secs_f64() * 1000.0));
        // The loop guard, if the kernel has it: a render in which it stopped a loop has wrong pixels, and is an error.
        if let (Some(before), Some(now)) = (stopped_before, self.guard_trips(&self.no_vis_bufs)?) {
            if now != before {
                return Err(anyhow!("the loop guard stopped {} of the kernel's invocations at {} iterations (THREERT_LOOP_GUARD): a traversal that does not end on this scene's data, or a limit too low for it", now.wrapping_sub(before), loop_guard_of(false).unwrap_or(0)));
            }
        }
        let t2 = Instant::now();
        let readback = d.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: film_size, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut enc = d.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(b_film, 0, &readback, 0, film_size);
        self.queue.submit([enc.finish()]);
        readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        self.device.poll(wgpu::PollType::wait_indefinitely())?;
        let data = readback.slice(..).get_mapped_range()?;
        // 北冥：每个像素 film_stride 个 vec4，各通道按 FILM_* 的位置取，灯组从 film_lightgroup_first 起。步长与起点
        // 是这次渲染写进全局参数的那两个数，不写死。
        let floats: &[f32] = bytemuck::cast_slice(&data);
        let n = (w * h) as usize;
        let (stride, groups) = (base.film.film_stride as usize * 4, base.film.num_lightgroups as usize);
        let mut frame = Frame { width: w, height: h, color: Vec::with_capacity(n), albedo: Vec::with_capacity(n), normal: Vec::with_capacity(n), emission: Vec::with_capacity(n), specular: Vec::with_capacity(n), variance: Vec::with_capacity(n), lightgroups: vec![Vec::with_capacity(n); groups], samples: spp };
        for p in floats.chunks_exact(stride) {
            let c = p[FILM_COMBINED as usize * 4 + 3].max(1.0);
            let at = |slot: u32, k: usize| Some(p[slot as usize * 4 + k]).filter(|v| v.is_finite()).unwrap_or(0.0);
            let rgb = |slot: u32| [at(slot, 0) / c, at(slot, 1) / c, at(slot, 2) / c];
            frame.color.push(rgb(FILM_COMBINED));
            frame.albedo.push(rgb(FILM_DENOISE_ALBEDO));
            frame.normal.push(rgb(FILM_DENOISE_NORMAL));
            frame.emission.push(rgb(FILM_LEGACY_EMIT));
            frame.specular.push(rgb(FILM_LEGACY_SPEC));
            let mean = at(FILM_LEGACY_VARIANCE, 0) / c;
            frame.variance.push(((at(FILM_LEGACY_VARIANCE, 1) / c - mean * mean).max(0.0)) / c);
            for (g, group) in frame.lightgroups.iter_mut().enumerate() {
                group.push(rgb(base.film.film_lightgroup_first + g as u32));
            }
        }
        drop(data);
        readback.unmap();
        timings.push(("readback_ms".into(), t2.elapsed().as_secs_f64() * 1000.0));
        Ok(frame)
    }
}

#[cfg(test)]
mod tests {

    /// A package built before the kernel was WESL carries the scene library's old hash (`a * b ^ c * d`): as it is,
    /// WESL refuses it (Daylight Home on ThreeRT 0.4.2: the engine panicked); through `legacy_wgsl` it compiles.
    #[test]
    fn a_package_with_the_old_scene_library_still_compiles() {
        let old = "fn std_pcg(v: u32) -> u32 {\n    let s = v * 747796405u + 2891336453u;\n    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;\n    return (w >> 22u) ^ w;\n}\nfn std_hashi(x: i32, y: i32, z: i32) -> f32 {\n    return f32(std_pcg(bitcast<u32>(x) * 73856093u ^ bitcast<u32>(y) * 19349663u ^ bitcast<u32>(z) * 83492791u) >> 8u) * (1.0 / 16777216.0);\n}\nfn std_hash3(x: f32, y: f32, z: f32) -> f32 {\n    let v = bitcast<u32>(x) * 73856093u ^ bitcast<u32>(y) * 19349663u ^ bitcast<u32>(z) * 83492791u;\n    return f32(std_pcg(v) >> 8u) * (1.0 / 16777216.0);\n}\n";
        let slot = "fn material_function(f: i32, i: MatIn, m: Material, base: MatOut) -> MatOut { return base; }\nfn alpha_material_function(f: i32, i: MatIn, m: Material, base: MatOut) -> MatOut { return base; }\nfn emissive_material_function(f: i32, i: MatIn, m: Material, base: MatOut) -> MatOut { return base; }\n";
        let template = kernel_template();
        let with = |functions: &str| {
            let (head, rest) = template.split_once("// @material-functions-begin").unwrap();
            let (_, tail) = rest.split_once("// @material-functions-end").unwrap();
            format!("{head}{functions}{slot}{tail}")
        };
        let v = KernelVariant::new(false, KernelSwitches::default(), 0);
        assert!(try_kernel_wgsl(&with(old), &v).is_err(), "WESL takes the old hash as written: the shim is no longer needed");
        let fixed = legacy_wgsl(old.to_string());
        assert!(!fixed.contains("73856093u ^ "), "{fixed}");
        let wgsl = try_kernel_wgsl(&with(&fixed), &v).expect("the old library, parenthesised, compiles");
        naga_valid(&wgsl);
        // What is not the old library is left alone.
        assert_eq!(legacy_wgsl("fn f() -> u32 { return 1u ^ 2u; }".into()), "fn f() -> u32 { return 1u ^ 2u; }");
    }
    #[test]
    fn material_functions_by_the_fields_they_write() {
        let f = |body: &str| format!("fn mf_x(i: MatIn, m: Material, base: MatOut) -> MatOut {{\n    var o = base;\n{body}\n    return o;\n}}\n");
        let wet = f("    o.base = base.base * 0.5;\n    o.roughness = 0.1;\n    o.normal = i.ng;");
        assert!(!writes_field(&wet, "emissive") && !writes_field(&wet, "opacity"));
        assert!(writes_field(&f("    o.emissive = vec3<f32>(1.0);"), "emissive"));
        assert!(writes_field(&f("    o.opacity *= 0.5;"), "opacity"));
        // A whole assignment or a pointer passed on may change any field.
        assert!(writes_field(&f("    o = base;"), "emissive"));
        assert!(writes_field(&f("    helper(&o);"), "opacity"));
        assert!(!writes_field(&f("    let no = 1.0;\n    o.base = vec3<f32>(no);"), "opacity"));
    }

    use super::*;

    /// The kernel features are one bit each, no two the same (`override FEAT` gets them all, the source-patching ones
    /// too), and pathtrace.wgsl's constants for the ones it switches on are the same bits.
    #[test]
    fn feature_bits_are_distinct() {
        let all = [
            ("F_MASKED", F_MASKED), ("F_FOG", F_FOG), ("F_VOLUME", F_VOLUME), ("F_TEX", F_TEX), ("F_FUNC", F_FUNC),
            ("F_GLASS", F_GLASS), ("F_COAT", F_COAT), ("F_HUGE", F_HUGE), ("F_INST", F_INST), ("F_MEDIA", F_MEDIA), ("F_PEMIT", F_PEMIT),
            ("F_HMEDIA", F_HMEDIA), ("F_PROC", F_PROC), ("F_TINT", F_TINT), ("F_UNLIT", F_UNLIT), ("F_BACKGROUND", F_BACKGROUND),
            ("F_VCOLOR", F_VCOLOR), ("F_AERIAL", F_AERIAL), ("F_GRID", F_GRID), ("F_LISTS", F_LISTS),
            ("F_SPECULAR_TINT", F_SPECULAR_TINT),
        ];
        let mut seen = 0u32;
        for (name, bit) in all {
            assert!(bit.is_power_of_two() && seen & bit == 0, "{name} = {bit:#x} is not a bit of its own");
            seen |= bit;
        }
        let wgsl = include_str!("../shaders/pathtrace.wgsl");
        assert!(wgsl.contains(&format!("const RIS_EXACT: u32 = {RIS_EXACT}u;")), "RIS_EXACT: pathtrace.wgsl and gpu.rs differ");
        for line in wgsl.lines().filter(|l| l.starts_with("const F_")) {
            let name = &line[6..line.find(':').unwrap()];
            let value: u32 = line[line.find('=').unwrap() + 1..line.find("u;").unwrap()].trim().parse().unwrap();
            let rust = all.iter().find(|(n, _)| *n == name).unwrap_or_else(|| panic!("{name}: not in gpu.rs")).1;
            assert_eq!(value, rust, "{name}: pathtrace.wgsl and gpu.rs differ");
        }
    }

    fn naga_valid(src: &str) {
        let m = naga::front::wgsl::parse_str(src).unwrap_or_else(|e| panic!("{}", e.emit_to_string(src)));
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all()).validate(&m).unwrap_or_else(|e| panic!("{}", e.emit_to_string(src)));
    }

    /// 北冥：`src` 过 naga 的校验之后，再过 SPIR-V（Vulkan）与 MSL（Metal）两个后端的代码生成。
    /// 校验过了不等于生成得出来：把结构成员或数组元素的指针当函数实参（`f(&sd.N)`、`f(&sd.closure[1])`），校验放行，
    /// MSL 后端照常生成，SPIR-V 后端在生成时崩（进程退出，不是报错）。只在苹果显卡上跑是发现不了的，所以每台机器
    /// 两个后端都生成一遍。只生成、不交给驱动编译；绑定号用假的。
    pub(crate) fn codegen_valid(src: &str) {
        let m = naga::front::wgsl::parse_str(src).unwrap_or_else(|e| panic!("{}", e.emit_to_string(src)));
        let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all()).validate(&m).unwrap_or_else(|e| panic!("{}", e.emit_to_string(src)));
        // （内核有一个管线常数 FEAT：后端要它先定成值，这里取它的默认值。）
        let (m, info) = naga::back::pipeline_constants::process_overrides(&m, &info, None, &Default::default()).expect("管线常数取默认值");
        let spv = naga::back::spv::Options { fake_missing_bindings: true, ..Default::default() };
        let words = naga::back::spv::write_vec(&m, &info, &spv, None).unwrap_or_else(|e| panic!("SPIR-V 后端生成不出来：{e}"));
        assert!(!words.is_empty());
        let msl = naga::back::msl::Options { lang_version: (2, 4), fake_missing_bindings: true, ..Default::default() };
        let (text, _) = naga::back::msl::write_string(&m, &info, &msl, &Default::default()).unwrap_or_else(|e| panic!("MSL 后端生成不出来：{e}"));
        assert!(!text.is_empty());
    }

    /// The kernel's bind group layouts are what its source declares, in every layout and traversal: a variant's
    /// bindings are the layout's, each of its kind (a storage buffer's access too), but for the loop guard's count,
    /// which a layout as written has room for and a kernel without the guard does not name.
    #[test]
    fn the_kernels_layouts_are_its_declarations() {
        use naga::{AddressSpace, ImageClass, ImageDimension as Dim, ScalarKind, StorageAccess, TypeInner};
        use wgpu::TextureViewDimension as View;
        type Entry = (u32, u32, wgpu::BindingType);
        let declared = |v: &KernelVariant| -> Vec<Entry> {
            let src = kernel_wgsl(&kernel_template(), v);
            let m = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{}", e.emit_to_string(&src)));
            let mut out: Vec<Entry> = m
                .global_variables
                .iter()
                .filter_map(|(_, g)| {
                    let b = g.binding.as_ref()?;
                    let name = g.name.as_deref().unwrap_or("");
                    let ty = match (g.space, &m.types[g.ty].inner) {
                        (AddressSpace::Uniform, _) => UNIFORM_BUFFER,
                        (AddressSpace::Storage { access }, _) => storage_buffer(!access.contains(StorageAccess::STORE)),
                        (AddressSpace::Handle, TypeInner::Image { dim: Dim::D2, arrayed: false, class: ImageClass::Sampled { kind: ScalarKind::Uint, multi: false } }) => {
                            wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Uint, view_dimension: View::D2, multisampled: false }
                        }
                        (AddressSpace::Handle, TypeInner::Image { dim, arrayed, class: ImageClass::Sampled { kind: ScalarKind::Float, multi: false } }) => float_texture(match (dim, arrayed) {
                            (Dim::D2, true) => View::D2Array,
                            (Dim::D2, false) => View::D2,
                            (Dim::D3, false) => View::D3,
                            other => panic!("{name}: a {other:?} texture"),
                        }),
                        (AddressSpace::Handle, TypeInner::Sampler { comparison: false }) => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        (AddressSpace::Handle, TypeInner::AccelerationStructure { .. }) => ACCELERATION_STRUCTURE,
                        (space, _) => panic!("{name}: a {space:?} binding the layouts do not know"),
                    };
                    Some((b.group, b.binding, ty))
                })
                .collect();
            out.sort_by_key(|e| (e.0, e.1));
            out
        };
        let mut checked = 0;
        for (hwrt, merged, uniform_tables, whole_tables) in [(true, false, false, false), (true, false, true, false), (true, false, false, true), (false, false, false, false), (false, false, true, false), (false, false, false, true), (false, true, false, false)] {
            for room in [false, true] {
                let mut layout: Vec<Entry> = kernel_layout_entries(LayoutShape { hwrt, merged, uniform_tables, whole_tables, guard: room }).iter().enumerate().flat_map(|(g, es)| es.iter().map(move |e| (g as u32, e.binding, e.ty))).collect();
                layout.sort_by_key(|e| (e.0, e.1));
                for guard in [None, Some(1 << 16)] {
                    // (As written, a kernel with the guard needs the room.)
                    if guard.is_some() && !room && !merged {
                        continue;
                    }
                    for features in [0u32] {
                        let mut want = layout.clone();
                        if guard.is_none() && !merged {
                            want.retain(|e| (e.0, e.1) != (1, crate::merged::GUARD_BINDING));
                        }
                        let v = KernelVariant { merged, uniform_tables, whole_tables, guard, ..KernelVariant::new(hwrt, KernelSwitches::default(), features) };
                        assert_eq!(declared(&v), want, "{v:?} in a layout {} room for the guard", if room { "with" } else { "without" });
                        checked += 1;
                    }
                }
            }
        }
        assert_eq!(checked, 3 * 3 + 3 * 3 + 4);
    }

    /// The native default has no loop guard. Every variant the kernel's flags
    /// make is valid WGSL (naga, wgpu's front end): each traversal with no switch, each alone and all of them, by no
    /// scene feature, with the uniform tables, with the
    /// tables read whole, and with the loop guard. (The merged layout's: merged.rs.) Prints the default variants'
    /// SHA-256 (`--nocapture`).
    #[test]
    fn every_kernel_variant_is_valid() {
        use sha2::{Digest, Sha256};
        if std::env::var("THREERT_LOOP_GUARD").is_ok() {
            return;
        }
        assert_eq!(loop_guard(), None);
        let sha = |s: &str| Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
        let template = kernel_template();
        let all = KernelSwitches { strict: true, cutout_lite: 2, last_direct: true, last_sun: false, light_pick: true };
        let switches = [
            KernelSwitches::default(),
            KernelSwitches { strict: true, ..Default::default() },
            KernelSwitches { cutout_lite: 1, ..Default::default() },
            KernelSwitches { cutout_lite: 2, ..Default::default() },
            KernelSwitches { last_direct: true, ..Default::default() },
            KernelSwitches { last_sun: true, ..Default::default() },
            KernelSwitches { light_pick: true, ..Default::default() },
            all,
        ];
        for hwrt in [false, true] {
            println!("source kernel hwrt={hwrt} {}", sha(&kernel_wgsl(&template, &KernelVariant::new(hwrt, KernelSwitches::default(), 0))));
            for &k in &switches {
                naga_valid(&kernel_wgsl(&template, &KernelVariant::new(hwrt, k, 0)));
                let all_features = KernelVariant::new(hwrt, k, F_SOURCE);
                naga_valid(&kernel_wgsl(&template, &KernelVariant { uniform_tables: true, ..all_features }));
                naga_valid(&kernel_wgsl(&template, &KernelVariant { whole_tables: true, ..all_features }));
                naga_valid(&kernel_wgsl(&template, &KernelVariant { guard: Some(1 << 16), ..all_features }));
            }
        }
    }

    /// 北冥：内核的每个变体（上一条测试校验的那些，加合并布局的）都过 SPIR-V 与 MSL 两个后端的代码生成，见
    /// `codegen_valid`。末尾是这条测试自己的对照：一段成员指针当实参的着色器，校验放行，SPIR-V 后端必须生成不出来；
    /// 哪天后端修好了这段，这条断言会红，那时内核里的这条禁令（shaders/shader.wgsl 开头）才可以放开。
    #[test]
    fn every_kernel_variant_generates_spirv_and_msl() {
        if std::env::var("THREERT_LOOP_GUARD").is_ok() {
            return;
        }
        let template = kernel_template();
        let all = KernelSwitches { strict: true, cutout_lite: 2, last_direct: true, last_sun: false, light_pick: true };
        let switches = [
            KernelSwitches::default(),
            KernelSwitches { strict: true, ..Default::default() },
            KernelSwitches { cutout_lite: 1, ..Default::default() },
            KernelSwitches { cutout_lite: 2, ..Default::default() },
            KernelSwitches { last_direct: true, ..Default::default() },
            KernelSwitches { last_sun: true, ..Default::default() },
            KernelSwitches { light_pick: true, ..Default::default() },
            all,
        ];
        let mut n = 0;
        for hwrt in [false, true] {
            for &k in &switches {
                let plain = KernelVariant::new(hwrt, k, 0);
                let all_features = KernelVariant::new(hwrt, k, F_SOURCE);
                for v in [plain, KernelVariant { uniform_tables: true, ..all_features }, KernelVariant { whole_tables: true, ..all_features }, KernelVariant { guard: Some(1 << 16), ..all_features }, KernelVariant { merged: true, ..plain }, KernelVariant { merged: true, guard: Some(1 << 16), ..all_features }] {
                    // （合并布局是浏览器的，那里没有硬件求交。）
                    if v.merged && v.hwrt {
                        continue;
                    }
                    codegen_valid(&kernel_wgsl(&template, &v));
                    n += 1;
                }
            }
        }
        assert_eq!(n, 8 * 6 + 8 * 4);
        let bad = "struct S { a: vec3<f32>, b: f32 };\nfn half(p: ptr<function, vec3<f32>>) { *p = *p * 0.5; }\n@group(0) @binding(0) var<storage, read_write> out: array<vec4<f32>>;\n@compute @workgroup_size(1) fn main() {\n    var s = S();\n    s.a = vec3<f32>(1.0);\n    half(&s.a);\n    out[0] = vec4<f32>(s.a, s.b);\n}\n";
        naga_valid(bad);
        let crash = std::panic::catch_unwind(|| codegen_valid(bad)).expect_err("成员指针当实参：SPIR-V 后端现在生成得出来了");
        let said = crash.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(said.contains("is not cached"), "崩的不是预期的那一处：{said}");
    }

    /// 北冥：请求灯组的那条路是通的。同一个场景渲两遍，一遍不请求灯组、一遍请求 2 个（现在还没有任何贡献写进
    /// 灯组）：颜色、反照率、法线、方差逐位相同；读回的灯组是 2 层、每层一个像素一项、全是 0；不请求时没有灯组层。
    /// 请求得太多（缓冲超过这块显卡的上限）在开渲前报错。（没有显卡时跳过。）
    #[test]
    fn requested_lightgroups_leave_the_picture_alone() {
        const GAME: &str = r#"
            const tri = (id, p) => __engine.geometry(id, new Float32Array(p), new Float32Array([0,0,1, 0,0,1, 0,0,1]), new Float32Array([0,0, 1,0, 0,1]), new Uint32Array([0,1,2]));
            globalThis.__threert = {
                describe: () => JSON.stringify({ handlers: [], frame: false, keys: {} }),
                setup: (room, seed) => {
                    tri(1, [-1,0,0, 0,0,0, -1,1,0]);
                    tri(2, [0,-1,0, 2,-1,0, 0,1,0]);
                    __engine.material(3, { name: "lamp", color: [1, 1, 1], opacity: 1, metalness: 0, roughness: 0.5, emissive: [1, 0.5, 0.25], emissiveIntensity: 10, doubleSided: true });
                    __engine.material(4, { name: "wall", color: [0.8, 0.8, 0.8], opacity: 1, metalness: 0, roughness: 0.5, emissive: [0, 0, 0], emissiveIntensity: 0, doubleSided: true });
                    __engine.object(5, { name: "lamp", parent: null, castShadow: true, kind: "mesh", geometry: 1, material: 3 });
                    __engine.object(6, { name: "wall", parent: null, castShadow: true, kind: "mesh", geometry: 2, material: 4 });
                    __engine.object(7, { name: "cam", parent: null, castShadow: false, kind: "camera", camera: { fov: 50, near: 0.1, far: 100, exposure: { mode: "manual", ev100: 0 } } });
                    __engine.transform(7, new Float32Array([0, 0, 5, 0, 0, 0, 1, 1, 1, 1]));
                    __engine.environment({ sky: { type: "color", color: [0.2, 0.3, 0.4], intensity: 1, skyLightIntensity: 1 } });
                    __engine.settings({ name: "lightgroups", preset: "preview", width: 32, height: 18, time: 0, camera: 7 });
                    return "{}";
                },
                event: () => "{}", commit: () => {}, setState: () => {}, frame: () => {}, outline: () => "[]", inspect: () => "{}", edit: () => {},
            };
        "#;
        let g = match Gpu::new_with(GpuOptions::default()) {
            Ok(g) => g,
            Err(e) => return eprintln!("skipped: {e}"),
        };
        let host = crate::script::ScriptHost::new(GAME).unwrap();
        host.setup("room", None).unwrap();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut sc = crate::scene::build(&host.world.borrow(), root, &root.join("presets"), None).unwrap();
        let mut timings = vec![];
        let prep = crate::prepare(&g, &mut sc, &mut timings);
        let mut render = |film: KernelFilm| {
            let params = Params { film, ..prep.params };
            g.render(&sc, &prep.tri_verts, prep.groups, bytemuck::cast_slice(&prep.nodes), &prep.emitters, &prep.gpu_emitter_tris, crate::ltree::nodes_of(prep.light_tree.as_ref()), &prep.env, &prep.env_cdf, &prep.energy, params, 4, &mut timings)
        };
        let plain = render(prep.params.film).unwrap();
        let with = render(KernelFilm::new(2)).unwrap();
        let n = (sc.width * sc.height) as usize;
        let bits = |v: &[[f32; 3]]| v.iter().flatten().map(|x| x.to_bits()).collect::<Vec<u32>>();
        assert_eq!((plain.color.len(), with.color.len()), (n, n));
        assert!(plain.color.iter().flatten().any(|x| *x > 0.0), "场景是黑的，比不出东西");
        assert_eq!(bits(&plain.color), bits(&with.color), "颜色");
        assert_eq!(bits(&plain.albedo), bits(&with.albedo), "反照率");
        assert_eq!(bits(&plain.normal), bits(&with.normal), "法线");
        assert_eq!(plain.variance.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), with.variance.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), "方差");
        assert!(plain.lightgroups.is_empty());
        assert_eq!(with.lightgroups.len(), 2);
        for group in &with.lightgroups {
            assert_eq!(group.len(), n);
            assert!(bits(group).iter().all(|b| *b == 0), "还没有贡献写进灯组，应当全是 0");
        }
        // 请求得太多：开渲前报错，并说最多能要几组。
        let limits = g.device.limits();
        let too_many = ((limits.max_storage_buffer_binding_size as u64).min(limits.max_buffer_size) / (n as u64 * 16)) as u32;
        let e = render(KernelFilm::new(too_many)).err().expect("超过显卡上限的请求应当报错").to_string();
        assert!(e.contains("最多能要"), "{e}");
    }

    /// 北冥：路径状态与光线（shaders/integrator.wgsl 的 PathState、Ray）的字段名单，与「已写未读」的几项写入。
    /// 字段名照 Cycles 的 IntegratorState.path 与 Ray：改名、删字段要先改这里（加字段只要在名单里补上）。
    /// 最小概率密度、上一个散射点的物体、可见类、随机维度偏移这四项现在只写不读，着色器里没有别处能发现它们被
    /// 悄悄删掉，所以在这里按源码查：初值与每次弹射的写入都得在。查的是写入语句在不在（先去掉注释，被注释掉的不算），
    /// 不是运行时的值：语句还在、却包进永不成立的分支，这里查不出来。
    #[test]
    fn path_state_is_written() {
        let src = kernel_wgsl(&kernel_template(), &KernelVariant::new(false, KernelSwitches::default(), 0));
        let m = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{}", e.emit_to_string(&src)));
        let src = without_comments(&src);
        let members = |name: &str| -> Vec<String> {
            let (_, t) = m.types.iter().find(|(_, t)| t.name.as_deref() == Some(name)).unwrap_or_else(|| panic!("内核里没有结构 {name}"));
            match &t.inner {
                naga::TypeInner::Struct { members, .. } => members.iter().map(|x| x.name.clone().unwrap()).collect(),
                _ => panic!("{name} 不是结构"),
            }
        };
        assert_eq!(
            members("PathState"),
            ["render_pixel_index", "sample", "bounce", "diffuse_bounce", "glossy_bounce", "transmission_bounce", "transparent_bounce", "rng_pixel", "rng_offset", "flag", "mis_ray_pdf", "min_ray_pdf", "continuation_probability", "throughput", "visibility", "mis_ray_object", "legacy"]
        );
        let mut ray = members("Ray");
        ray.sort();
        assert_eq!(ray, ["D", "P", "cone_a", "cone_w", "self_object", "self_prim", "time", "tmax", "tmin"]);
        for (write, count) in [
            ("state.rng_offset = PRNG_BOUNCE_NUM;", 1),
            ("state.min_ray_pdf = 3.4028235e38;", 1),
            ("state.visibility = PATH_RAY_VISIBILITY_CAMERA;", 1),
            ("state.mis_ray_object = OBJECT_NONE;", 2),
            ("state.min_ray_pdf = min(pdf, state.min_ray_pdf);", 1),
            ("state.min_ray_pdf = min(state.mis_ray_pdf, state.min_ray_pdf);", 1),
            ("state.mis_ray_object = sd.object;", 1),
            ("path_state_next(bs.label);", 1),
            ("path_state_next(LABEL_VOLUME_SCATTER);", 1),
            ("state.visibility = visibility;", 1),
            ("state.rng_offset += PRNG_BOUNCE_NUM;", 1),
        ] {
            assert_eq!(src.matches(write).count(), count, "路径状态的这处写入该有 {count} 处：{write}");
        }
    }

    /// 北冥：着色点、闭包、材质输入值（shaders/shader.wgsl）的字段名单，与「已写未读」的几项写入，做法同上一条。
    /// 字段名照 Cycles 的 ShaderData、ShaderClosure：改名、删字段要先改这里（加字段只要在名单里补上）。
    /// 现在只写不读的：着色点的平滑法线、物体号、图元号、重心坐标、这一段光线的长度（物体号只被抄进同样没人读的
    /// `state.mis_ray_object`）；材质输入值的折射率、高光等级、不透明度、漫反射粗糙度；闭包的采样权重与菲涅耳种类；
    /// 光线的「出发处的物体与图元」。它们是给后面照 Cycles 移植闭包、灯、图案节点的人留的，着色器里没有别处能发现
    /// 它们被悄悄删掉，所以在这里按源码查写入语句都在。查的是语句在不在（先去掉注释），不是运行时的值。
    #[test]
    fn shading_point_is_written() {
        let template = without_comments(&kernel_template());
        // 去注释这一道自己的对照：行注释、块注释（可以嵌套）里的不算，注释外面的原样留着
        assert_eq!(without_comments("a = 1; // b = 2;\n/* c = 3; /* d */ e = 4; */f = 5; g = 6 / 2;"), "a = 1; \nf = 5; g = 6 / 2;");
        assert_eq!(without_comments("// (*sd).ray_length = h.t;").matches("(*sd).ray_length = h.t;").count(), 0);
        let src = kernel_wgsl(&template, &KernelVariant::new(false, KernelSwitches::default(), 0));
        let m = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{}", e.emit_to_string(&src)));
        let members = |name: &str| -> Vec<String> {
            let (_, t) = m.types.iter().find(|(_, t)| t.name.as_deref() == Some(name)).unwrap_or_else(|| panic!("内核里没有结构 {name}"));
            match &t.inner {
                naga::TypeInner::Struct { members, .. } => members.iter().map(|x| x.name.clone().unwrap()).collect(),
                _ => panic!("{name} 不是结构"),
            }
        };
        assert_eq!(members("ShadingPoint"), ["P", "N", "Ng", "wi", "object", "prim", "u", "v", "ray_length", "flag", "object_flag", "time", "lcg_state", "emission", "num_closure", "closure", "legacy"]);
        assert_eq!(members("Closure"), ["kind", "weight", "sample_weight", "N", "alpha_x", "alpha_y", "ior", "energy_scale", "fresnel_type", "f0", "f90_or_b", "exponent", "reflection_tint", "transmission_tint"]);
        assert_eq!(members("ShaderInputs"), ["base_color", "metallic", "roughness", "ior", "specular_ior_level", "specular_tint", "emission", "alpha", "diffuse_roughness", "flags", "coat_weight", "transmission_weight", "N"]);
        for (write, count) in [
            // 着色点（shader_setup_from_hit）
            ("(*sd).prim = h.tri;", 1),
            ("(*sd).u = h.u;", 1),
            ("(*sd).v = h.v;", 1),
            ("(*sd).ray_length = h.t;", 1),
            ("(*sd).object = instance_at(h.inst).info.y;", 1),
            ("(*sd).object = object_of(a);", 1),
            ("(*sd).N = n;", 1),
            // 材质输入值（legacy_shader_inputs）
            ("inp.ior = max(m.layer.y, 1e-5);", 1),
            ("inp.specular_ior_level = max(m.specular_ior_level, 0.0);", 1),
            ("inp.alpha = clamp(m.base_color.a, 0.0, 1.0);", 1),
            ("inp.diffuse_roughness = clamp(m.diffuse_roughness, 0.0, 1.0);", 1),
            // 闭包（shader_setup_closures）
            ("c.sample_weight = 1.0;", 1),
            ("c.fresnel_type = FRESNEL_F82_TINT;", 1),
            // 光线（main）
            ("ray.self_object = OBJECT_NONE;", 1),
            ("ray.self_prim = OBJECT_NONE;", 1),
        ] {
            assert_eq!(template.matches(write).count(), count, "这处写入该有 {count} 处：{write}");
        }
    }

    /// A kernel with units has the loop guard natively with nothing set, at the browser's limit; THREERT_LOOP_GUARD=0
    /// takes it out, a limit set is the limit, a page's limit comes first. A kernel without units has it only where
    /// one is set, or in a browser.
    #[test]
    fn a_kernel_with_units_has_the_loop_guard() {
        assert_eq!(guard_limit(0, None, true, false), Some(65536));
        assert_eq!(guard_limit(0, None, false, false), None);
        assert_eq!(guard_limit(0, Some(0), true, false), None);
        assert_eq!(guard_limit(0, Some(0), true, true), None);
        assert_eq!(guard_limit(0, Some(16), true, false), Some(16));
        assert_eq!(guard_limit(0, Some(16), false, false), Some(16));
        assert_eq!(guard_limit(0, None, false, true), Some(65536));
        assert_eq!(guard_limit(8192, Some(0), false, false), Some(8192));
        if std::env::var("THREERT_LOOP_GUARD").is_ok() {
            return;
        }
        assert!(guard_room(false) && !guard_room(true));
    }

    /// With nothing set, every platform but Android opens the device as it was before the options existed: no
    /// uniform tables, no pipeline cache, the kernel's source the files (`every_kernel_variant_is_valid` prints the
    /// default variants' hashes). Android's defaults are the uniform tables and the switches its GPUs needed; the environment overrides
    /// either way, and the merged layout never has the uniform tables.
    #[test]
    fn the_options_default_to_the_device_as_written() {
        let vars = |set: &'static [(&'static str, &'static str)]| move |name: &str| set.iter().find(|(n, _)| *n == name).map(|(_, v)| v.to_string());
        let desktop = GpuOptions::from_vars(&vars(&[]), false);
        assert_eq!(desktop, GpuOptions::default());
        assert_eq!(desktop.kernel, KernelSwitches { strict: false, cutout_lite: 0, last_direct: false, last_sun: false, light_pick: false });
        assert!(!desktop.uniform_tables_on(false, false) && desktop.table_views_on(false, false));
        for hwrt in [false, true] {
            assert!(KernelVariant::new(hwrt, desktop.kernel, 0).flags().iter().all(|&(name, on)| on == (name == "hwrt" && hwrt)));
        }
        let android = GpuOptions::from_vars(&vars(&[]), true);
        assert_eq!(android.kernel, KernelSwitches { strict: true, cutout_lite: 1, last_direct: true, last_sun: false, light_pick: false });
        // `sun`: the directional lights alone at the last vertex, in place of all of them, on either platform.
        let sun = GpuOptions::from_vars(&vars(&[("THREERT_LAST_DIRECT", "sun")]), true);
        assert_eq!((sun.kernel.last_direct, sun.kernel.last_sun), (false, true));
        assert_eq!((android.uniform_tables, android.table_views, android.pipeline_cache.clone()), (None, None, None));
        // Android reads the tables whole (no views, so no uniform copies of four of them); with the views asked for,
        // the uniform copies as before.
        assert!(!android.table_views_on(false, true) && !android.uniform_tables_on(false, true) && !android.uniform_tables_on(true, true));
        let views = GpuOptions::from_vars(&vars(&[("THREERT_TABLE_VIEWS", "1")]), true);
        assert!(views.table_views_on(false, true) && views.uniform_tables_on(false, true) && !views.table_views_on(true, true));
        // Set: what is asked, on either platform.
        let off = GpuOptions::from_vars(&vars(&[("THREERT_UNIFORM_TABLES", "0"), ("THREERT_KERNEL_STRICT", "0"), ("THREERT_CUTOUT_LITE", "0"), ("THREERT_LAST_DIRECT", "0")]), true);
        assert_eq!((off.kernel, off.uniform_tables_on(false, true)), (KernelSwitches::default(), false));
        let on = GpuOptions::from_vars(&vars(&[("THREERT_UNIFORM_TABLES", "1"), ("THREERT_CUTOUT_LITE", "2"), ("THREERT_LIGHT_PICK", "1"), ("THREERT_PIPELINE_CACHE", "/data/cache/pipelines")]), false);
        assert!(on.uniform_tables_on(false, false) && !on.uniform_tables_on(true, false));
        // Elsewhere the views unless asked otherwise; without them no uniform tables, whatever is asked.
        assert!(on.table_views_on(false, false) && !on.table_views_on(true, false));
        let whole = GpuOptions::from_vars(&vars(&[("THREERT_TABLE_VIEWS", "0"), ("THREERT_UNIFORM_TABLES", "1")]), false);
        assert!(!whole.table_views_on(false, false) && !whole.uniform_tables_on(false, false));
        assert_eq!(on.kernel, KernelSwitches { strict: false, cutout_lite: 2, last_direct: false, last_sun: false, light_pick: true });
        assert_eq!(on.pipeline_cache.as_deref(), Some(std::path::Path::new("/data/cache/pipelines")));
        assert_eq!(GpuOptions::from_vars(&vars(&[("THREERT_PIPELINE_CACHE", "")]), true).pipeline_cache, None);
        // The light tiles: everywhere but Android unless asked.
        assert_eq!([light_tiles_of(None, false), light_tiles_of(None, true), light_tiles_of(Some("1"), true), light_tiles_of(Some("0"), false)], [true, false, true, false]);
        // (And the environment map's light sampling, which is the scene's preparation's: lib.rs `env_nee_on`.)
        assert_eq!([crate::env_nee_of(None, false), crate::env_nee_of(None, true), crate::env_nee_of(Some("1"), true), crate::env_nee_of(Some("0"), false)], [true, false, true, false]);
    }

    /// Each switch changes what it says, under both traversals (that every combination is valid WGSL:
    /// `every_kernel_variant_is_valid`). Strict guards every ray query the hardware kernel makes; software traversal
    /// has none and takes only `env_pdf`'s index; the cutout switches are hardware traversal's.
    #[test]
    fn the_kernel_switches_change_what_they_say() {
        let t = kernel_template();
        let v = |hwrt: bool, k: KernelSwitches| kernel_wgsl(&t, &KernelVariant::new(hwrt, k, 0));
        for hwrt in [false, true] {
            let plain = v(hwrt, KernelSwitches::default());
            let strict = v(hwrt, KernelSwitches { strict: true, ..Default::default() });
            let queries = strict.matches("rayQueryInitialize(").count();
            assert_eq!(queries, if hwrt { 1 } else { 0 });
            assert_eq!(strict.matches("ray_bad(o, d, tmax").count(), queries, "every ray query is guarded");
            assert_eq!(strict.matches("fn ray_bad(").count(), hwrt as usize);
            assert!(!strict.contains("env_cdf_at(y - 1u)") && !strict.contains("env_cdf_at(base + x - 1u)") && plain.contains("env_cdf_at(y - 1u)"));
            let lit = v(hwrt, KernelSwitches { strict: true, cutout_lite: 2, last_direct: true, last_sun: false, light_pick: true });
            assert_eq!(lit.matches("film_add_light(dz, depth, LIGHTGROUP_NONE);").count(), 1);
            assert!(!lit.contains("fn sun_light("), "last_direct takes the directional lights already");
            let sun = v(hwrt, KernelSwitches { last_sun: true, ..Default::default() });
            assert_eq!((sun.matches("film_add_light(dz, depth, LIGHTGROUP_NONE);").count(), sun.matches("fn sun_light(").count(), sun.matches("state.throughput * sun_light(sd)").count()), (1, 1, 1));
            assert!(!plain.contains("sun_light"));
            assert_eq!(lit.matches("env_on = take_env && has_env && !state.legacy.lights_only;").count(), 1);
            assert_eq!(lit.contains("let steps = 4u;"), hwrt);
            assert_eq!(v(hwrt, KernelSwitches { cutout_lite: 2, ..Default::default() }) == plain, !hwrt);
        }
    }

    /// The uniform tables' buffers: each array fits a uniform binding of 64 KiB, the media's holds every medium a
    /// scene may have, and the four are at their own bindings, before the acceleration structure's. A copy takes what
    /// the table's section and its uniform buffer both hold, in whole words; a scene with more entries than an array
    /// is said, by name.
    #[test]
    fn the_uniform_tables_fit_their_bindings() {
        use crate::merged::UNIFORM_TABLES;
        for t in &UNIFORM_TABLES {
            assert!(kernel_template().contains(&format!("@group(0) @binding({}) var<uniform> {}: array<", t.binding, t.name)), "{}", t.name);
            let bytes = t.stride * t.len as u64;
            assert!(bytes <= 65536 && bytes % 16 == 0 && t.binding < ACC_BINDING, "{}: {bytes} bytes", t.name);
        }
        assert_eq!(UNIFORM_TABLES.each_ref().map(|t| t.table), [Table::TexInfo, Table::Objects, Table::Instances, Table::Media]);
        assert_eq!(UNIFORM_TABLES[3].len as usize, crate::scene::MAX_MEDIA);
        assert_eq!(UNIFORM_TABLES[2].len as u64, 65536 / UNIFORM_TABLES[2].stride);
        assert_eq!([UNIFORM_TABLES[2].stride as usize, UNIFORM_TABLES[3].stride as usize], [std::mem::size_of::<crate::scene::GpuInstance>(), std::mem::size_of::<crate::scene::MediumGpu>()]);
        assert!(kernel_template().contains(&format!("@group(0) @binding({ACC_BINDING}) var acc: acceleration_structure;")));
        // A table shorter than its array, one with the edits' room past it, one whose size is not the array's multiple.
        assert_eq!([uniform_copy_bytes(512, 65536), uniform_copy_bytes(1 << 20, 65536), uniform_copy_bytes(65600, 65440), uniform_copy_bytes(0, 7168), uniform_copy_bytes(7, 64)], [512, 65536, 65440, 0, 4]);
        assert!(uniform_overflow([4096, 4096, 409, 32]).is_empty());
        let notes = uniform_overflow([4096, 4099, 1024, 32]);
        assert_eq!(notes.len(), 2);
        assert!(notes[0].contains("4099 entries of `objects`") && notes[0].contains("holds 4096") && notes[1].contains("1024 entries of `instances`"), "{notes:?}");
    }

    /// The order of a layout's entries and of a bind group's is not the device's to see: wgpu puts both in binding
    /// order before its backend gets them (wgpu-core 30: `bgl::EntryMap::from_entries` sorts a layout's, and
    /// `create_bind_group` its entries), and takes two layouts of the same entries as one. So the kernel's layout,
    /// whose acceleration structure (binding 13) is pushed last, needs no sorting here for a driver that minds the
    /// order. Held on this machine's GPU: a bind group made of one order runs with a pipeline laid out in another,
    /// without a validation error, and each binding reads its own buffer. (Skipped without a GPU.)
    #[test]
    fn wgpu_takes_bind_group_entries_in_any_order() {
        let g = match Gpu::new_with(GpuOptions::default()) {
            Ok(g) => g,
            Err(e) => return eprintln!("skipped: {e}"),
        };
        let d = &g.device;
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None }, count: None };
        let (uni, read, write) = (entry(0, wgpu::BufferBindingType::Uniform), entry(5, wgpu::BufferBindingType::Storage { read_only: true }), entry(9, wgpu::BufferBindingType::Storage { read_only: false }));
        let scope = d.push_error_scope(wgpu::ErrorFilter::Validation);
        let ordered = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[uni, read, write] });
        let shuffled = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[write, uni, read] });
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None,
            source: wgpu::ShaderSource::Wgsl("@group(0) @binding(0) var<uniform> a: vec4<u32>;\n@group(0) @binding(5) var<storage, read> b: array<u32>;\n@group(0) @binding(9) var<storage, read_write> c: array<u32>;\n@compute @workgroup_size(1) fn main() { c[0] = a.x; c[1] = b[0]; }\n".into()),
        });
        let layout = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&ordered)], immediate_size: 0 });
        let pipeline = d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: None, layout: Some(&layout), module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
        let buf = |words: [u32; 4], usage| d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&words), usage });
        let (a, b, c) = (buf([11, 0, 0, 0], wgpu::BufferUsages::UNIFORM), buf([22, 0, 0, 0], wgpu::BufferUsages::STORAGE), buf([0; 4], wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC));
        fn e(binding: u32, b: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry { binding, resource: b.as_entire_binding() }
        }
        let bg = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &shuffled, entries: &[e(9, &c), e(5, &b), e(0, &a)] });
        let out = d.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bg, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        enc.copy_buffer_to_buffer(&c, 0, &out, 0, 16);
        g.queue.submit([enc.finish()]);
        assert!(pollster::block_on(scope.pop()).is_none(), "a layout's entries in another order are another layout to wgpu");
        out.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        d.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let words: Vec<u32> = bytemuck::cast_slice(&out.slice(..).get_mapped_range().unwrap()).to_vec();
        assert_eq!(words[..2], [11, 22]);
    }

    /// A scene's features are `FEAT` bits, not source: the kernel's text is the same for each, and
    /// what they switch is fixed when a pipeline sets `FEAT` (naga's override processing; `OBJECT_STRIDE` from F_TINT).
    #[test]
    fn scene_features_are_feat_bits() {
        let t = kernel_template();
        let v = |f: u32| kernel_wgsl(&t, &KernelVariant::new(false, KernelSwitches::default(), f));
        let base = v(0);
        for f in [F_TINT, F_UNLIT, F_BACKGROUND, F_VCOLOR, F_GRID] {
            assert_eq!(v(f), base, "{f:#x}");
        }
        let m = naga::front::wgsl::parse_str(&base).unwrap();
        let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all()).validate(&m).unwrap();
        for (feat, stride) in [(0, 3.0), (F_TINT, 4.0)] {
            let c = naga::back::PipelineConstants::from([("FEAT".to_string(), feat as f64)]);
            let (m, _) = naga::back::pipeline_constants::process_overrides(&m, &info, None, &c).unwrap();
            let (_, k) = m.constants.iter().find(|(_, k)| k.name.as_deref() == Some("OBJECT_STRIDE")).expect("OBJECT_STRIDE");
            assert_eq!(m.global_expressions[k.init], naga::Expression::Literal(naga::Literal::U32(stride as u32)));
        }
    }

    /// Structural features other than F_INST (opaque particles, media) do not make a scene count as instanced: a group
    /// starting between 2^23 and 2^24 stays within the non-instanced custom-data limit (no F_HUGE).
    #[test]
    fn structural_features_are_not_instancing() {
        const M: usize = 1 << 23;
        let groups = [M + 5, 3, 0, 0, 0, 0, 0, 0];
        assert_eq!(features_of(&[], 0, false, false, groups, F_PEMIT) & F_HUGE, 0);
        assert_eq!(features_of(&[], 0, false, false, groups, F_MEDIA) & F_HUGE, 0);
        assert_ne!(features_of(&[], 0, false, false, groups, F_INST) & F_HUGE, 0);
    }

    #[test]
    fn huge_when_a_group_starts_past_24_bits() {
        const M: usize = 1 << 24;
        // One group of any size: its first triangle is 0.
        assert!(!huge([M * 3, 0, 0, 0, 0, 0, 0, 0], false));
        // The second group starts at 2^24 - 1: still fits.
        assert!(!huge([M - 1, 5, 0, 0, 0, 0, 0, 0], false));
        // ... at 2^24: does not.
        assert!(huge([M, 5, 0, 0, 0, 0, 0, 0], false));
        // Empty groups past 2^24 have no instance.
        assert!(!huge([M + 7, 0, 0, 0, 0, 0, 0, 0], false));
        // The 3 x 3 Kabukicho district (37.75 M triangles, opaque shadow casters first).
        assert!(huge([36_000_000, 900_000, 500_000, 352_799, 0, 0, 0, 0], false));
        // With model instances, group custom data must stay below the instance bit (2^23).
        assert!(!huge([M - 1, 5, 0, 0, 0, 0, 0, 0], false));
        assert!(huge([M / 2, 5, 0, 0, 0, 0, 0, 0], true));
        assert!(!huge([M / 2 - 1, 5, 0, 0, 0, 0, 0, 0], true));
    }
}
