// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// SPDX-FileCopyrightText: 2026 Meshy LLC
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: MIT AND Apache-2.0
// 多方许可。上游的与北冥新写的部分是 MIT。照 Cycles（Blender v5.2.3，路径相对 intern/cycles/）取的部分是 Apache-2.0
// （许可全文见仓库根的 LICENSES/Apache-2.0.txt）：
//   物体标志 SD_OBJECT_NEGATIVE_SCALE 的名字与数值：kernel/types.h
//   积分器参数块 KernelIntegrator 的字段名：kernel/data_template.h
// ThreeRT native path tracer. One sample per pixel per dispatch, accumulated in `film` (film.wgsl).
// Shading model mirrors UE5 DefaultLit: Lambert diffuse + GGX / Smith-joint-approx / Schlick(F90 = saturate(50 F0.g)),
// with UE's GGX multi-scattering energy conservation and diffuse energy preservation.
// Material / atmosphere extensions (docs/PARITY.md): texture pages with ray-cone LOD, alpha cutout, world mapping,
// wetness / puddles / ripples / grime, procedural facade windows, emissive animation, RIS many-light sampling, height
// fog with volumetric single scattering. Each is compiled out when the scene does not use it (FEAT).
//
// The kernel is this file and records.wgsl, sample.wgsl and trace_hw.wgsl after it (gpu.rs `KERNEL_FILES`),
// compiled for a device and a scene by WESL's conditional translation (`@if`, gpu.rs `kernel_wgsl`): a declaration
// or a statement under `@if(x)` is there only where x holds. The flags:
//   hwrt                  hardware traversal (ray queries) in the software BVH walk's place, and the translucency pass
//   strict, cutout_lite, cutout_lite2, last_direct, last_sun, light_pick
//                         a device's switches (gpu.rs `KernelSwitches`: what a GPU the kernel as written is wrong or
//                         too slow on needs)
//   (a scene's features are bits of `FEAT`, a pipeline-overridable constant)
//   merged                the merged binding layout (merged.rs: at most eight storage buffers a stage, a browser's)
//   uniform_tables        four tables in uniform buffers (merged.rs `UNIFORM_TABLES`: Android's drivers)
//   whole_tables          the seven typed tables read from the tables' buffer whole, as `merged` reads them, and
//                         no views of their sections (gpu.rs `GpuOptions::table_views`: Android's drivers)
//   guard                 the loop guard (gpu.rs `loop_guard_of`, `guard_loops`)
// The numbers a variant is compiled for are WESL constants (`import constants::`, gpu.rs `KernelVariant::constants`): the
// uniform tables' lengths, the loop guard's limit.
//
// 北冥：这个文件原来是内核的全部主体，现在按阶段分成了几个文件，只搬了位置。这里留下的是开头的一段：编译开关、常数、
// 全局参数、各张表的绑定与读法，外加各阶段共用的小函数。别处写着「pathtrace.wgsl 的某某函数」的，按下表去找：
//   intersect.wgsl   求交：命中记录、过程几何、软件 BVH（trace）、阴影射线与穿玻璃（shadow_tr、glass_tr、glass_at）；
//                    「只查同一个物体」的问法（trace_local，现在是空壳）
//   shader.wgsl      材质求值：着色点与闭包的结构、求值的三步（shader_setup_from_hit、shader_eval_inputs、
//                    shader_setup_closures）；上游的 Surface、贴图、材质函数、镂空测试（alpha_pass）、surface 与 surface_proc
//   closure.wgsl     闭包：积分器碰材质的那一组函数（surface_shader_*）；上游的 Lobes、玻璃、求值与采样（eval_bsdf_k、
//                    pdf_bsdf、sample_bsdf、light_mis、pdf_spec）
//   light.wgsl       灯光：发光体表与灯光树、环境、天空与发光体的权重、直接光（direct_light、local_lights 等）
//   volume.wgsl      体积：大气透视、高度雾、有界介质
//   integrator.wgsl  路径状态 PathState（模块级的私有变量 state，上游原来散在各处的私有全局都并在里面）、光线 Ray、
//                    积分主循环（main，相机光线也在里面）
//   film.wgsl        输出：输出缓冲 film 与读写它的一组函数（film_add_light、film_write_aux、film_write_sample）；第 1 组的缓冲
// 拼接次序见 gpu.rs 的 `KERNEL_FILES`；本文件必须排第一个（模块的 import 与 enable 要在声明之前）。
@if(uniform_tables) import constants::{UT_TEX_INFO, UT_OBJECTS, UT_INSTANCES, UT_MEDIA};
@if(merged || guard) import constants::GUARD_WORDS;
@if(guard) import constants::LOOP_GUARD_LIMIT;
@if(hwrt) enable wgpu_ray_query;

const PI: f32 = 3.14159265358979;
const INF: f32 = 3.0e38;
const TRI_NO_SHADOW: u32 = 1u;
const TRACE_CLOSEST: u32 = 0u;
const TRACE_SHADOW: u32 = 1u;
const TRACE_ANY: u32 = 2u;
// Any hit on any surface, alpha-cutout triangles taken as opaque (live emitter shadow rays: `emitter_tr`).
const TRACE_ANY_OPAQUE: u32 = 3u;
const TRI_MASKED: u32 = 2u;
const TRI_DYNAMIC: u32 = 4u;
// Highest texture-page mip (texpack::MIPS - 1) and the ray-cone LOD bias (negative = sharper; accumulation antialiases).
const TEX_MAX_LEVEL: f32 = 4.0;
const LOD_BIAS: f32 = 0.5;

// Pixel footprint for texture LOD: the output resolution when tracing below it (upsampled like UE TSR's mip bias).
fn lod_height() -> f32 {
    return f32(select(P.size.y, P.counts2.z, P.counts2.z > 0u));
}
// Local lights: up to RIS_EXACT are evaluated exhaustively, more are resampled from RIS_M candidates (one shadow ray).
const RIS_EXACT: u32 = 8u;
const RIS_M: u32 = 8u;
const LIGHT_GROUP: u32 = 16u; // lib.rs LIGHT_GROUP
// Emitter candidates per camera-ray hit (sample_emitter_ris).
const EMIT_RIS_M: u32 = 6u;
// Volumetric fog runs on 1 / (VOL_RATE_MASK + 1) of the pixel tiles per sample (0 = every pixel).
const VOL_RATE_MASK: u32 = 1u;
const MAT_DOUBLE_SIDED: i32 = 1;
const MAT_EMITTER_CARD: i32 = 2;
const MAT_UNLIT: i32 = 4;
// Live (real-time) mode: not in this build (the offline core). A constant, false: what is left under it is folded away.
const LIVE: bool = false;
// The live renderer's approximations (gpu::A_*; docs/RUNTIME.md "How live differs from offline"): what a live path
// leaves out or takes a cheaper way to stay in its frame, each a bit, each with the bias and the cost it was measured
// at. A pipeline's constant, as FEAT is: a kernel without one has no code for it. Offline has none; a live view has
// them all unless it asks otherwise (THREERT_APPROX), which is how a live picture is held to the offline one.
// (This build is offline only: none, a constant.)
const APPROX: u32 = 0u;
const A_GLASS_SHADOWS: u32 = 1u;   // shadow rays to the analytic lights and the sky pass glass in full, untinted (`shadow_tr`)
const A_MEDIA_SHADOWS: u32 = 2u;   // of the media only the homogeneous ones dim shadow rays (`media_shadows`)
const A_CUTOUT_PATHS: u32 = 4u;    // cutouts are opaque to rays past a camera hit's own, off mirror paths (`cutouts_opaque`)
const A_CUTOUT_EMITTERS: u32 = 8u; // cutouts are opaque to emitters' shadow rays (`emitter_tr`)
const A_FAR_EMITTERS: u32 = 16u;   // the light tree proposes no emitter beyond LT_FAR (`lt_imp`; without a tree: the emitter cull)
fn approx(a: u32) -> bool { return (APPROX & a) != 0u; }
// Features the scene uses (gpu::F_*): the rest is compiled out, so plain scenes pay nothing for them.
override FEAT: u32 = 0xffffffffu;
const F_MASKED: u32 = 1u;
const F_FOG: u32 = 64u;
const F_VOLUME: u32 = 128u;
const F_TEX: u32 = 256u;
const F_FUNC: u32 = 512u;
const F_GLASS: u32 = 2048u;
const F_COAT: u32 = 4096u;
const F_HUGE: u32 = 8192u;
const F_INST: u32 = 16384u;
const F_MEDIA: u32 = 32768u;
const F_PEMIT: u32 = 65536u; // opaque particles: their emitter handling (nominal areas, not light-sampled ones)
const F_HMEDIA: u32 = 131072u; // homogeneous media (water): live attenuation of paths and shadow rays (media_homogeneous)
const F_AERIAL: u32 = 16777216u; // the sky's aerial perspective (aerial_tr) on segments ending on a surface
const F_PROC: u32 = 262144u; // procedural geometry (ProceduralMesh): AABB candidates in every query, `surface_proc`
const F_TINT: u32 = 524288u; // instance colours: OBJECT_STRIDE 4, `obj_tint`
const F_UNLIT: u32 = 1048576u; // MeshBasicMaterial (MAT_UNLIT)
const F_BACKGROUND: u32 = 2097152u; // scene.background (`sky_mis`)
const F_VCOLOR: u32 = 4194304u; // vertex colours (`vcolor`)
const F_GRID: u32 = 33554432u; // density grids (`vgrid`)
const F_LISTS: u32 = 134217728u; // light tiles (`lt_list_start`): a scene whose shadow-casting local lights are resampled
const F_SPECULAR_TINT: u32 = 268435456u; // 北冥：有材质的边缘色（Material.specular_tint）不是白：材质求值从材质记录读它
fn has(f: u32) -> bool { return (FEAT & f) != 0u; }

// 北冥：全局参数末尾追加的三块（integrator、film、table_first_ext）。全局参数是进缓冲的格式：已有的块长度冻结；
// 要加东西就在末尾追加自己命名的一整块，并登记块名与主人。Rust 一侧的镜像是 gpu::Params 与同名的结构，库测试
// 逐字段比两侧的偏移与总长度。
// 积分器的参数，字段名照 Cycles 的 KernelIntegrator。4 个 vec4。
struct KernelIntegrator {
    // 各类弹射的上限。已定义，全 0：弹射上限现在还读上游的 P.counts.z
    @align(16) max_bounce: u32,
    max_diffuse_bounce: u32,
    max_glossy_bounce: u32,
    max_transmission_bounce: u32,
    transparent_max_bounce: u32,    // 已定义，0
    transparent_min_bounce: u32,    // 已定义，0
    min_bounce: u32,                // 已定义，0：俄罗斯轮盘的起始深度现在还读上游的 P.counts.w
    sampling_pattern: u32,          // 采样图案，只有 0（Sobol-Burley）
    sample_clamp_direct: f32,       // 夹取。已定义，0：现在还用上游的亮度夹取（P.misc.x）
    sample_clamp_indirect: f32,
    filter_glossy: f32,             // 已定义，0
    light_inv_rr_threshold: f32,    // 已定义，0
    seed: u32,                      // 随机数的全局种子。放的是用户种子过一次 hash_hp 之后的值（sample.wgsl 的 rng_start 要的那个）。
                                    // 已落地
    sobol_index_mask: u32,          // Sobol 打乱后的索引取哪几位（sample.wgsl 的 rng_index_at）。现在固定是 0xffff0000；为 0 时
                                    // 每个样本取同一个点，开渲前报错。已落地
    pass_kind: u32,                 // 这一趟调度写什么：0 颜色样本，1 辅助样本。已定义，恒 0（辅助那一趟还没有）
    background_transparent: u32,    // 背景对相机不可见。已定义，恒 0
};
const PASS_KIND_COLOR: u32 = 0u;
const PASS_KIND_AUX: u32 = 1u;
// 输出缓冲 film 的形状（film.wgsl）。1 个 vec4。
struct KernelFilm {
    @align(16) film_stride: u32,    // 每个像素占几个 vec4：固定部分加这次渲染请求的灯组数
    film_lightgroup_first: u32,     // 第 0 个灯组在像素里的位置（固定部分的长度）
    num_lightgroups: u32,           // 这次渲染请求的灯组数（不是场景里的灯组数）
    reserved: u32,
};

struct Params {
    cam_pos: vec4<f32>,   // w = tan(fov/2)
    cam_fwd: vec4<f32>,   // w = aspect
    cam_right: vec4<f32>, // w = lens radius
    cam_up: vec4<f32>,    // w = focus distance
    size: vec4<u32>,      // width, height, sample index, 预留（北冥：上游在这一格放种子；种子挪到了 integrator.seed，
                          // 这一格停写，恒 0）
    counts: vec4<u32>,    // lights, emitters, max bounces, rr depth
    env: vec4<f32>,       // has env map, env width, env height, sun light index (-1 none)
    misc: vec4<f32>,      // clamp (absolute radiance), emitter total weight, env total weight, _
    sky_color: vec4<f32>, // constant sky radiance when no env map
    counts2: vec4<u32>,   // directional lights (first in `lights`), environment NEE on, output height for texture LOD (0 = traced height), first shadowed local light
    time: vec4<f32>,      // scene time (s), wetness, rain, -
    fog: vec4<f32>,       // density at fog height (1/m), height falloff (1/m), fog height, start distance (m)
    fog_color: vec4<f32>, // ambient inscattering radiance, max opacity
    vol: vec4<f32>,       // volumetric scattering albedo (0 = off), HG anisotropy, extinction scale in range, -
    vol2: vec4<f32>,      // volumetric albedo tint rgb, range (m, 0 = unlimited)
    raster: vec4<f32>,    // live: primary visibility from the raster pass (1 = on), this frame's sub-pixel jitter x, y (every camera ray's); ray tracing off (1)
    cache: vec4<f32>,     // live radiance cache (1 = on), history cap in samples, history cap in frames, -
    motion: vec4<f32>,    // live motion vectors: 1 = on, -, -, - (first dynamic triangle: group_first[1].x)
    group_first: array<vec4<u32>, 2>, // first global triangle of each traversal group ([1].x = the first dynamic one)
    light_lod: vec4<f32>, // live light LOD (lib.rs emitter_lod): reference position, d0 (0 = off)
    emit_power: vec4<f32>, // x: the emitter CDF's total without light LOD (= misc.y when it is off); y: emitter cull radius (0 = off); z: its reach in the view cone
    lod_view: vec4<f32>,   // emitter cull's view cone (lib.rs EmitterCull): forward direction, cos of the half-angle
    ltree: vec4<f32>,      // light tree (ltree.rs): -, its entry count (bits: the moving emitters' first), P(pick a moving one), candidates at camera hits (0 = off)
    procs: vec4<u32>,      // procedural geometry (F_PROC): -, object count, first record in `instances`, -
    aerial: vec4<f32>,     // the sky's aerial perspective (F_AERIAL): density multiple, Rayleigh scale, Mie scale, -
    background: vec4<f32>, // three.js scene.background (radiance), 1 (F_BACKGROUND)
    ltile: vec4<u32>,      // live light tiles (`lt_list_start`): 1 with last frame's lists (0: none), tiles a row, the grid's offset when they were built (x | y << 16), candidates a vertex the camera sees takes from its list
    ltile2: vec4<u32>,     // the traced size they were built at, -, -
    lt_cam: array<vec4<f32>, 4>, // the camera they were built under: position (w = tan(fov/2)), forward (w = aspect), right, up
    table_first: array<vec4<u32>, 3>, // each table's first vec4 in `tables` (heap.rs `Table`): light tree (0), materials, lights, light groups; emitters, tex_info, objects, instances; media, energy LUT, glass energy, emitter triangles
    word_first: vec4<u32>, // each stream's first word in `words` (heap.rs `Stream`): environment CDF (0), procedural data, vertex colours, -
    live_first: array<vec4<u32>, 2>, // the merged layout: each of group 1's vec4 sections' first vec4 in `ML.vecs` (heap.rs `Live`): cache values (0), refl, motion, direct; lists, -, -, -
    live_len: vec4<u32>,   // and the vec4s of refl, motion, direct, lists
    integrator: KernelIntegrator, // 北冥：积分器的参数
    film: KernelFilm,             // 北冥：输出缓冲的形状
    // 北冥：新表在 `tables` 里的首地址（heap.rs `Table` 里排在上游 12 张之后的）。上游的 table_first 已经占满，新表
    // 只许用这里的 8 格，取用前要登记。现在登记的四个去向：
    //   [0].x 物体扩展表（object_ext_at，已落地，全 0）   [0].y 图案节点表（已定义，0）
    //   [0].z、[0].w 广义 Schlick 的两张能量表（已定义，0）   [1] 的四格空闲
    table_first_ext: array<vec4<u32>, 2>,
};

// (`TriAttr`, a triangle's attributes: records.wgsl.)
struct Node { bmin: vec3<f32>, left_or_first: u32, bmax: vec3<f32>, count: u32 };
// See scene::GpuMaterial for the field layout.
// 北冥：材质记录是进缓冲的格式，26 个 vec4。总长度冻结：以后只能往预留格（reserved）里填，不许追加。前 18 个是上游
// 原样的；其中 base_color.rgb（底色）、base_color.a（不透明度）、params.x（金属度）、params.y（粗糙度）、layer.y
// （折射率）、emissive.rgb（自发光辐亮度，不含物体的功率倍数）照 Cycles 移植的闭包直接读，不另存一份；params.z（上游
// 的高光强度）只给上游顶替读，它与 specular_ior_level 只在折射率 1.5 时等价，所以高光等级单独存。
// mp、mt 只归上游的材质函数；图案节点的参数不放在材质记录里，材质记录只带 pattern_first、pattern_count 指向节点表
// （表的首地址在 P.table_first_ext，表的格式归做图案节点的人）。
// 第 19 格声明成四个标量，不用向量再做位转换。Rust 一侧的镜像是 scene::GpuMaterial，默认值在那里手写（边缘色白、
// 高光等级 0.5）；库测试逐字段比两侧的偏移与总长度。
struct Material {
    base_color: vec4<f32>, emissive: vec4<f32>, params: vec4<f32>, tex0: vec4<i32>, tex1: vec4<i32>, uv: vec4<f32>,
    uv2: vec4<f32>, layer: vec4<f32>, mp: array<vec4<f32>, 8>, mt: array<i32, 8>,
    specular_tint: vec3<f32>,       // 第 18 格。金属：F82 的边缘色；非金属：乘在 F0 上的颜色。默认白。已落地（纯金属读；
                                    // 场景里没有非白的边缘色时内核编译期取白，不读这一格：F_SPECULAR_TINT）
    specular_ior_level: f32,        // 高光等级，默认 0.5。已写未读
    diffuse_roughness: f32,         // 第 19 格。漫反射粗糙度，0 是朗伯。已写未读
    flags: u32,                     // MATERIAL_FLAG_*，见下
    pattern_first: u32,             // 这个材质的图案节点在节点表里的起点与个数。已定义，恒 0
    pattern_count: u32,
    reserved: array<vec4<f32>, 6>,  // 第 20 到 25 格，预留，全 0（各向异性、清漆、绒面、透射、薄膜、次表面的参数用到时在这里起名）
};
// 材质记录 flags 的位（Rust 一侧同名：scene::MATERIAL_FLAG_*，库测试逐个比数值）。空闲的位取用前要登记。
const MATERIAL_FLAG_MULTISCATTER: u32 = 1u << 0u;        // 微表面做多重散射的能量补偿（Cycles 的 distribution 选多重散射 GGX）。
                                                         // 上传前由一处按全局开关 energyCompensation 统一写。已落地
const MATERIAL_FLAG_NO_LEGACY_FUNCTION: u32 = 1u << 1u;  // 不走上游的材质函数。已定义
const MATERIAL_FLAG_CLASS_SHIFT: u32 = 8u;               // 第 8 到 11 位：闭包大类（MATERIAL_CLASS_*）。已定义，恒 0
const MATERIAL_FLAG_CLASS_MASK: u32 = 0xfu << 8u;
const MATERIAL_CLASS_SURFACE: u32 = 0u;
const MATERIAL_CLASS_EMISSION: u32 = 1u;
const MATERIAL_CLASS_TRANSPARENT: u32 = 2u;
const MATERIAL_CLASS_TOON: u32 = 3u;
// See scene::GpuLight (x = volumetric scattering scale, specular scale, rect barn-door cosine, -).
struct Light { pos: vec4<f32>, dir: vec4<f32>, color: vec4<f32>, ext: vec4<f32>, x: vec4<f32> };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> tri_verts: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> attrs: array<TriAttr>;
// (Software traversal's trees: hardware traversal has no binding for them.)
@if(!hwrt) @group(0) @binding(3) var<storage, read> nodes: array<Node>;
@group(0) @binding(7) var textures: texture_2d_array<f32>;
@group(0) @binding(8) var samp: sampler;
@group(0) @binding(9) var env_tex: texture_2d<f32>;
// The scene's flat arrays, sections of one buffer of 32-bit words (heap.rs `Stream`), each from the word
// `P.word_first` names: the environment's CDF (floats: [0, H) the rows' marginal CDF, then H rows of W conditional
// entries; `env_cdf_at`), the procedural data (`pword`, `gdata`), the vertex colours (`vcolor_word`).
@group(0) @binding(5) var<storage, read> words: array<u32>;
// (The CDF is the buffer's first section: from word 0, no offset to read.)
fn env_cdf_at(i: u32) -> f32 { return bitcast<f32>(words[i]); }
// （北冥：绑定 11 是输出缓冲 film，声明在 film.wgsl。）
// The dynamic triangles' vertices (kernel layout, from triangle P.group_first[1].x on) as they were the previous frame.
@group(0) @binding(6) var<storage, read> prev_verts: array<vec4<f32>>;
// Model instances (scene::GpuInstance): world matrix rows, normal matrix rows, (first triangle, object, LOD offset bits, -).
struct Instance { m0: vec4<f32>, m1: vec4<f32>, m2: vec4<f32>, n0: vec4<f32>, n1: vec4<f32>, n2: vec4<f32>, info: vec4<u32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32> };
// Bounded participating media (`VolumeMesh`, gpu.rs MediumGpu; F_MEDIA), P.time.w of them: world -> local affine rows,
// (volume function, shape: 0 box / 1 sphere / 2 none while its node is hidden, homogeneous, 1 = it changes with time: `VolumeFunction` `animated`, a
// simulated grid), (majorant 1/m, HG anisotropy, -, -), customData, parameters.
struct Medium { w0: vec4<f32>, w1: vec4<f32>, w2: vec4<f32>, a: vec4<u32>, b: vec4<f32>, c: vec4<f32>, p: array<vec4<f32>, 8> };

// The scene's tables: sections of one buffer of vec4s (heap.rs `Table`), each from the vec4 `P.table_first` names:
//  - materials (scene::GpuMaterial), lights (scene::GpuLight), and per LIGHT_GROUP local lights a sphere (centre,
//    radius) holding all their light (lib.rs `light_groups`);
//  - emitters: (its emitter's index: bits, cumulative weight (normalized), weight, area) for i < counts.y, then the
//    guide table: EMITTER_GUIDE + 1 entry indices (bits), four per vec4 (lib.rs emitter_cdf); the emitters'
//    triangles (`EmitterTri`); the light tree's nodes;
//  - tex_info, per texture: (u0, v0, du, dv) of its rect in the page, (layer, wrap, width, height). See texpack.rs;
//  - objects, per object (scene node): pivot (world position), world bounds size (UE ObjectPositionWS /
//    ObjectBounds), then what `OBJECT_STRIDE` says;
//  - instances (Instance), media (Medium);
//  - the GGX energy LUT: (E.x, E.y) for 32 roughness x 32 NoV, two per vec4;
//  - the glass energy table (`glass_energy`): four values per vec4.
// The buffer whole is `tables` in every layout (unsigned words: integers are read as they are, floats by a bit
// cast): the light groups, the light tree and the energy LUT are read from it, and what a scene has more of is
// another section of it, not another binding.
@group(0) @binding(4) var<storage, read> tables: array<vec4<u32>>;
fn table_f(i: u32) -> vec4<f32> { return bitcast<vec4<f32>>(tables[i]); }
fn table_i(i: u32) -> vec4<i32> { return bitcast<vec4<i32>>(tables[i]); }
// (The light tree is the buffer's first section: from vec4 0, no offset to read.)
fn lt_node(i: u32) -> vec4<f32> { return table_f(i); }
fn light_group_at(i: u32) -> vec4<f32> { return table_f(P.table_first[0].w + i); }
fn energy_at(i: u32) -> vec4<f32> { return table_f(P.table_first[2].y + i); }
fn glass_energy_at(i: u32) -> vec4<f32> { return table_f(P.table_first[2].z + i); }
// 北冥：物体扩展表。每个物体 2 个 vec4，与上游的物体表同下标（着色点的 object）、定长；首地址在
// P.table_first_ext[0].x。各家只填自己的格子，不改长度。现在全是 0，还没有读者。Rust 一侧的镜像是 scene::GpuObjectExt。
// （运动矢量要的前后两刻变换不放这里，到做运动模糊时另定。）
struct ObjectExt {
    entity_id: f32,                 // 实体编号，存成浮点数值（小于 2^24；整数的位直接进浮点通道会被驱动冲成 0），0：不属于任何实体
    object_flag: u32,               // 物体标志，位照 Cycles 的 SD_OBJECT_*（第 3 位：物体是镜像的）
    receiver_light_set: u32,        // 灯光链接：这个物体属于哪个接收者集合
    lightgroup: u32,                // 这个物体（发光时）属于哪个灯组
    shadow_terminator_shading_offset: f32,   // 阴影终止的两个偏移（平滑网格用）
    shadow_terminator_geometry_offset: f32,
    reserved0: f32,
    reserved1: f32,
};
const OBJECT_EXT_VEC4: u32 = 2u;
const SD_OBJECT_NEGATIVE_SCALE: u32 = 1u << 3u;
fn object_ext_at(object: u32) -> ObjectExt {
    let b = P.table_first_ext[0].x + object * OBJECT_EXT_VEC4;
    let r0 = tables[b];
    let r1 = tables[b + 1u];
    return ObjectExt(bitcast<f32>(r0.x), r0.y, r0.z, r0.w, bitcast<f32>(r1.x), bitcast<f32>(r1.y), bitcast<f32>(r1.z), bitcast<f32>(r1.w));
}
// An emitter's triangle (lib.rs `GpuEmitterTri`): in world space, the light list's own copy, so a light sample reads
// no placement (what moves it is copied again: emitter_fill.wgsl); `tri`: its triangle in the triangles' table
// (attributes: `emitter_attrs`), `inst`: the instance that places it (NO_INST: none), `code`: the light tree's path
// code (0: not one of the tree's), EMITTER_MOVES if it moves.
struct EmitterTri { v0: vec3<f32>, tri: u32, e1: vec3<f32>, inst: u32, e2: vec3<f32>, code: u32 };
const EMITTER_TRI_VEC4: u32 = 3u;
const EMITTER_MOVES: u32 = 0x80000000u;
fn emitter_tri_at(i: u32) -> EmitterTri {
    let b = P.table_first[2].w + i * EMITTER_TRI_VEC4;
    let r0 = tables[b];
    let r1 = tables[b + 1u];
    let r2 = tables[b + 2u];
    return EmitterTri(bitcast<vec3<f32>>(r0.xyz), r0.w, bitcast<vec3<f32>>(r1.xyz), r1.w, bitcast<vec3<f32>>(r2.xyz), r2.w);
}
// The seven tables read at every hit or light, through `material_at`, `light_at`, `emitter_at`, `tex_info_at`,
// `object_at`, `instance_at` and `medium_at` in every layout.
@if(merged || whole_tables) {
    // The merged layout (merged.rs: a browser's eight storage buffers), and a device whose driver reads the views below
    // wrong (gpu.rs `GpuOptions::table_views`: Android): from the buffer whole, a record made of its vec4s (their
    // counts: the tests hold them to the renderer's records). Slower than the views below where it was measured
    // (docs/RUNTIME.md "The scene's tables"): an offset from the parameters at every read, the records' assembly.
    const MATERIAL_VEC4: u32 = 26u;
    const LIGHT_VEC4: u32 = 5u;
    const INSTANCE_VEC4: u32 = 10u;
    const MEDIUM_VEC4: u32 = 14u;
    fn material_at(i: u32) -> Material {
        let b = P.table_first[0].y + i * MATERIAL_VEC4;
        let t0 = table_i(b + 16u);
        let t1 = table_i(b + 17u);
        let st = table_f(b + 18u);
        let fl = tables[b + 19u];
        return Material(table_f(b), table_f(b + 1u), table_f(b + 2u), table_i(b + 3u), table_i(b + 4u), table_f(b + 5u), table_f(b + 6u), table_f(b + 7u),
            array<vec4<f32>, 8>(table_f(b + 8u), table_f(b + 9u), table_f(b + 10u), table_f(b + 11u), table_f(b + 12u), table_f(b + 13u), table_f(b + 14u), table_f(b + 15u)),
            array<i32, 8>(t0.x, t0.y, t0.z, t0.w, t1.x, t1.y, t1.z, t1.w),
            st.xyz, st.w, bitcast<f32>(fl.x), fl.y, fl.z, fl.w,
            array<vec4<f32>, 6>(table_f(b + 20u), table_f(b + 21u), table_f(b + 22u), table_f(b + 23u), table_f(b + 24u), table_f(b + 25u)));
    }
    fn light_at(i: u32) -> Light {
        let b = P.table_first[0].z + i * LIGHT_VEC4;
        return Light(table_f(b), table_f(b + 1u), table_f(b + 2u), table_f(b + 3u), table_f(b + 4u));
    }
    fn emitter_at(i: u32) -> vec4<f32> { return table_f(P.table_first[1].x + i); }
    fn tex_info_at(i: u32) -> vec4<f32> { return table_f(P.table_first[1].y + i); }
    fn object_at(i: u32) -> vec4<f32> { return table_f(P.table_first[1].z + i); }
    fn instance_at(i: u32) -> Instance {
        let b = P.table_first[1].w + i * INSTANCE_VEC4;
        return Instance(table_f(b), table_f(b + 1u), table_f(b + 2u), table_f(b + 3u), table_f(b + 4u), table_f(b + 5u), tables[b + 6u], table_f(b + 7u), table_f(b + 8u), table_f(b + 9u));
    }
    fn medium_at(i: u32) -> Medium {
        let b = P.table_first[2].x + i * MEDIUM_VEC4;
        return Medium(table_f(b), table_f(b + 1u), table_f(b + 2u), tables[b + 3u], table_f(b + 4u), table_f(b + 5u),
            array<vec4<f32>, 8>(table_f(b + 6u), table_f(b + 7u), table_f(b + 8u), table_f(b + 9u), table_f(b + 10u), table_f(b + 11u), table_f(b + 12u), table_f(b + 13u)));
    }
} @else {
    // Where a stage has bindings to spare, each of the seven's section is bound again as an array of its own type
    // (gpu.rs `Gpu::scene_bind_group`: the same buffer, from the section's first byte): a read is one typed load.
    @group(0) @binding(12) var<storage, read> materials: array<Material>;
    @group(0) @binding(13) var<storage, read> lights: array<Light>;
    @group(0) @binding(14) var<storage, read> emitters: array<vec4<f32>>;
    fn material_at(i: u32) -> Material { return materials[i]; }
    fn light_at(i: u32) -> Light { return lights[i]; }
    fn emitter_at(i: u32) -> vec4<f32> { return emitters[i]; }
    @if(uniform_tables) {
        // The uniform tables (merged.rs `UNIFORM_TABLES`): these four from sized uniform arrays, copies of their
        // sections, every index held to the array (a scene with more entries than one holds reads the last for the
        // rest; nothing outside the buffer is read).
        @group(0) @binding(15) var<uniform> tex_info: array<vec4<f32>, UT_TEX_INFO>;
        @group(0) @binding(16) var<uniform> objects: array<vec4<f32>, UT_OBJECTS>;
        @group(0) @binding(17) var<uniform> instances: array<Instance, UT_INSTANCES>;
        @group(0) @binding(18) var<uniform> media: array<Medium, UT_MEDIA>;
        fn tex_info_at(i: u32) -> vec4<f32> { return tex_info[min(i, UT_TEX_INFO - 1u)]; }
        fn object_at(i: u32) -> vec4<f32> { return objects[min(i, UT_OBJECTS - 1u)]; }
        fn instance_at(i: u32) -> Instance { return instances[min(i, UT_INSTANCES - 1u)]; }
        fn medium_at(i: u32) -> Medium { return media[min(i, UT_MEDIA - 1u)]; }
    } @else {
        @group(0) @binding(15) var<storage, read> tex_info: array<vec4<f32>>;
        @group(0) @binding(16) var<storage, read> objects: array<vec4<f32>>;
        @group(0) @binding(17) var<storage, read> instances: array<Instance>;
        @group(0) @binding(18) var<storage, read> media: array<Medium>;
        fn tex_info_at(i: u32) -> vec4<f32> { return tex_info[i]; }
        fn object_at(i: u32) -> vec4<f32> { return objects[i]; }
        fn instance_at(i: u32) -> Instance { return instances[i]; }
        fn medium_at(i: u32) -> Medium { return media[i]; }
    }
}
// Density grids (gpu.rs F_GRID, `GridsGpu`): field A of every grid, stacked along z; one cell in scenes without.
@group(0) @binding(10) var grid_tex: texture_3d<f32>;
// Vertex colours (three.js `vertexColors`; gpu.rs F_VCOLOR): three sRGB 8-bit colours per triangle.
fn vcolor_word(k: u32) -> u32 { return words[P.word_first.z + k]; }
fn vcolor(t: u32, u: f32, v: f32) -> vec3<f32> {
    let c0 = srgb_to_linear(unpack4x8unorm(vcolor_word(t * 3u)).rgb);
    let c1 = srgb_to_linear(unpack4x8unorm(vcolor_word(t * 3u + 1u)).rgb);
    let c2 = srgb_to_linear(unpack4x8unorm(vcolor_word(t * 3u + 2u)).rgb);
    return c0 * (1.0 - u - v) + c1 * u + c2 * v;
}


fn inst_vec(r: Instance, v: vec3<f32>) -> vec3<f32> { return vec3<f32>(dot(r.m0.xyz, v), dot(r.m1.xyz, v), dot(r.m2.xyz, v)); }
fn inst_normal(r: Instance, n: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(normalize(vec3<f32>(dot(r.n0.xyz, n.xyz), dot(r.n1.xyz, n.xyz), dot(r.n2.xyz, n.xyz))), n.w);
}
// A model-space triangle's `x` (texel density, object, ...) as its instance has it: the instance's texture LOD offset
// and object (the record's `info`).
fn inst_x(info: vec4<u32>, x: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(x.x + bitcast<f32>(info.z), bitcast<f32>(info.y), x.z, x.w);
}
// A model-space triangle's shading attributes placed by instance r (scene::instance_attr).
fn inst_attr(r: Instance, a: TriAttr) -> TriAttr {
    var b = a;
    b.n0 = inst_normal(r, a.n0);
    b.n1 = inst_normal(r, a.n1);
    b.n2 = inst_normal(r, a.n2);
    b.t = vec4<f32>(normalize(inst_vec(r, a.t.xyz)), a.t.w);
    b.x = inst_x(r.info, a.x);
    return b;
}

// ------------------------------------------------------------------------------------------------
// 北冥：各阶段共用的小函数与循环守卫（原来散在文件各处，内容没动）

fn pcg(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn power_heuristic(a: f32, b: f32) -> f32 {
    let a2 = a * a;
    return a2 / max(a2 + b * b, 1e-20);
}

fn non_finite(v: vec3<f32>) -> bool {
    let b = bitcast<vec3<u32>>(v) & vec3<u32>(0x7fffffffu);
    return any(b >= vec3<u32>(0x7f800000u));
}

fn luminance(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn offset_origin(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    return p + n * (1e-4 * max(1.0, max(abs(p.x), max(abs(p.y), abs(p.z)))));
}

// The loop guard (gpu.rs `loop_guard_of`; docs/RUNTIME.md "The engine in a browser"): every loop of the kernel, the
// scene's functions' too, begins with `if (loop_guard()) { break; }` (gpu.rs `guard_loops`, a pass over the variant's
// syntax tree). The kernel's traversals follow indices they read from buffers and end only on sound data; with the
// guard a dispatch always ends: an invocation's iterations are counted over all its loops together, past
// LOOP_GUARD_LIMIT it leaves them, and the invocations stopped are counted for the renderer to read back.
@if(guard) var<private> LOOP_GUARD_N: u32 = 0u;
@if(guard) fn loop_guard() -> bool {
    LOOP_GUARD_N += 1u;
    if (LOOP_GUARD_N == LOOP_GUARD_LIMIT + 1u) { loop_guard_stopped(); }
    return LOOP_GUARD_N > LOOP_GUARD_LIMIT;
}
