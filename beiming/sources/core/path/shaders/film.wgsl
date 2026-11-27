// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：输出），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// ------------------------------------------------------------------------------------------------
// What a live trace leaves the live passes (live.wgsl).

// Group 1, the buffers the kernel writes, used through the functions below in every layout:
//  - refl: reflection resolve inputs (live; live.wgsl `refl`), 2 per traced pixel: the camera hit's specular-lobe ray
//    (radiance it brought back, its lobe pdf; pdf 0 = the pixel sampled another lobe), (specular albedo E at the hit,
//    octahedral ray direction). Neighbours reuse each other's rays weighted by their own BRDF (Lumen / SSSR);
//  - motion_out: live motion vectors per traced pixel: where the camera hit was the previous frame, as a world-space
//    offset (w = 1: on a moving triangle);
//  - direct_out: live deterministic direct light per traced pixel (`state.legacy.dl_det` at the camera hit; w: the light it
//    reports, "Light tiles");
//  - light_lists: the light tiles' lists, 64 vec4s a tile, as the live pass `light_tiles` made them last frame;
//  - cache_keys, cache_acc, cache_val: the radiance cache (below, at `cache_on`);
//  - loop_guard_trips: the loop guard's count (first word: the invocations a loop of which was stopped).
@if(merged) {
    // The merged layout (merged.rs: a browser's eight storage buffers): one buffer (gpu.rs `KernelBufs`; heap.rs
    // `Live` places its parts). The radiance cache's atomic words and the loop guard's count are at fixed places (the
    // cache's size is the kernel's own constant); the vec4 arrays follow as the sections of `vecs`, each from the
    // vec4 `P.live_first` names and as long as `P.live_len` says, so a view of another size is the same kernel. What
    // the live passes read of it they bind as buffers of their own (a section starts at a multiple of 256 bytes).
    struct MergedLive {
        cache_keys: array<atomic<u32>, CACHE_SIZE>,
        @align(256) cache_acc: array<atomic<u32>, CACHE_SIZE * 8u>,
        @align(256) @size(512) loop_guard_trips: array<atomic<u32>, GUARD_WORDS>,
        @align(256) vecs: array<vec4<f32>>,
    };
    @group(1) @binding(1) var<storage, read_write> ML: MergedLive;
    fn refl_len() -> u32 { return P.live_len.x; }
    fn refl_store(i: u32, v: vec4<f32>) { ML.vecs[P.live_first[0].y + i] = v; }
    fn motion_len() -> u32 { return P.live_len.y; }
    fn motion_store(i: u32, v: vec4<f32>) { ML.vecs[P.live_first[0].z + i] = v; }
    fn direct_len() -> u32 { return P.live_len.z; }
    fn direct_load(i: u32) -> vec4<f32> { return ML.vecs[P.live_first[0].w + i]; }
    fn direct_store(i: u32, v: vec4<f32>) { ML.vecs[P.live_first[0].w + i] = v; }
    fn lists_len() -> u32 { return P.live_len.w; }
    fn list_load(i: u32) -> vec4<f32> { return ML.vecs[P.live_first[1].x + i]; }
    fn cache_key_load(i: u32) -> u32 { return atomicLoad(&ML.cache_keys[i]); }
    fn cache_key_claim(i: u32, k: u32) -> bool { let r = atomicCompareExchangeWeak(&ML.cache_keys[i], 0u, k); return r.exchanged || r.old_value == k; }
    fn cache_key_clear(i: u32) { atomicStore(&ML.cache_keys[i], 0u); }
    fn cache_acc_add(i: u32, v: u32) -> u32 { return atomicAdd(&ML.cache_acc[i], v); }
    fn cache_acc_load(i: u32) -> u32 { return atomicLoad(&ML.cache_acc[i]); }
    fn cache_acc_clear(i: u32) { atomicStore(&ML.cache_acc[i], 0u); }
    // (The cache's values are `vecs`' first section: from vec4 0.)
    fn cache_val_load(i: u32) -> vec4<f32> { return ML.vecs[i]; }
    fn cache_val_store(i: u32, v: vec4<f32>) { ML.vecs[i] = v; }
    @if(guard) fn loop_guard_stopped() { atomicAdd(&ML.loop_guard_trips[0], 1u); }
} @else {
    @group(1) @binding(1) var<storage, read_write> cache_keys: array<atomic<u32>>;
    @group(1) @binding(2) var<storage, read_write> cache_acc: array<atomic<u32>>;
    @group(1) @binding(3) var<storage, read_write> cache_val: array<vec4<f32>>;
    @group(1) @binding(4) var<storage, read> light_lists: array<vec4<f32>>;
    @group(1) @binding(5) var<storage, read_write> refl: array<vec4<f32>>;
    @group(1) @binding(6) var<storage, read_write> motion_out: array<vec4<f32>>;
    @group(1) @binding(7) var<storage, read_write> direct_out: array<vec4<f32>>;
    fn refl_len() -> u32 { return arrayLength(&refl); }
    fn refl_store(i: u32, v: vec4<f32>) { refl[i] = v; }
    fn motion_len() -> u32 { return arrayLength(&motion_out); }
    fn motion_store(i: u32, v: vec4<f32>) { motion_out[i] = v; }
    fn direct_len() -> u32 { return arrayLength(&direct_out); }
    fn direct_load(i: u32) -> vec4<f32> { return direct_out[i]; }
    fn direct_store(i: u32, v: vec4<f32>) { direct_out[i] = v; }
    fn lists_len() -> u32 { return arrayLength(&light_lists); }
    fn list_load(i: u32) -> vec4<f32> { return light_lists[i]; }
    fn cache_key_load(i: u32) -> u32 { return atomicLoad(&cache_keys[i]); }
    fn cache_key_claim(i: u32, k: u32) -> bool { let r = atomicCompareExchangeWeak(&cache_keys[i], 0u, k); return r.exchanged || r.old_value == k; }
    fn cache_key_clear(i: u32) { atomicStore(&cache_keys[i], 0u); }
    fn cache_acc_add(i: u32, v: u32) -> u32 { return atomicAdd(&cache_acc[i], v); }
    fn cache_acc_load(i: u32) -> u32 { return atomicLoad(&cache_acc[i]); }
    fn cache_acc_clear(i: u32) { atomicStore(&cache_acc[i], 0u); }
    fn cache_val_load(i: u32) -> vec4<f32> { return cache_val[i]; }
    fn cache_val_store(i: u32, v: vec4<f32>) { cache_val[i] = v; }
    @if(guard) {
        @group(1) @binding(8) var<storage, read_write> loop_guard_trips: array<atomic<u32>, GUARD_WORDS>;
        fn loop_guard_stopped() { atomicAdd(&loop_guard_trips[0], 1u); }
    }
    // The pixels of this sample that `finish` ends (below `cache_end`): their number, then a record each.
    struct Deferred { n: atomic<u32>, recs: array<vec4<u32>> };
    @group(1) @binding(9) var<storage, read_write> deferred: Deferred;
}

// ------------------------------------------------------------------------------------------------
// (The live radiance cache is not in this build; group 1 still declares its buffers, by these sizes.)

const CACHE_SIZE: u32 = 262144u;     // entries, a power of two (gpu.rs CACHE_SIZE)

// ------------------------------------------------------------------------------------------------
// 北冥：输出缓冲 film。上游是每个像素一个写死的结构（5 个 vec4），这里换成一块 vec4 的数组：每个像素占
// P.film.film_stride 个 vec4，前面是固定部分（下面的位置常数），后面是这次渲染请求的灯组，从
// P.film.film_lightgroup_first 开始、共 P.film.num_lightgroups 个。步长与灯组的起点一律从全局参数读，这里与
// Rust 一侧（gpu.rs）都不写死数字。步长不小于固定部分加灯组数：Rust 一侧把它向上取到 4 的倍数（64 字节），
// 末尾多出来的格子没人读写。
// 这是进缓冲的格式：固定部分的各个位置冻结，以后加固定通道只能填预留的两格。
// film 只经下面 film_ 开头的函数读写，别处不许下标 film。
@group(0) @binding(11) var<storage, read_write> film: array<vec4<f32>>;

// 固定部分各通道的位置（Rust 一侧同名：gpu.rs 的 FILM_*，库测试逐个比数值）。
const FILM_COMBINED: u32 = 0u;        // 颜色 rgb 的累加和，w：样本数。已落地
const FILM_DENOISE_ALBEDO: u32 = 1u;  // 降噪用的反照率 rgb 的累加和（上游的口径：相机首次命中的底色）。已落地。
                                      // w：不透明度的累加和。已落地
const FILM_DENOISE_NORMAL: u32 = 2u;  // 降噪用的法线 xyz 的累加和（上游的口径：世界空间）。已落地。
                                      // w：覆盖率计数（首次命中的实体编号等于辅助样本编号的样本数）。已落地
const FILM_LEGACY_VARIANCE: u32 = 3u; // 上游降噪用的两个量：x 亮度的和，y 亮度平方的和。已落地，换降噪器时腾出来
const FILM_LEGACY_EMIT: u32 = 4u;     // 上游 `render --signals` 的两组：相机直接看到的光；
const FILM_LEGACY_SPEC: u32 = 5u;     // 首次命中处的高光部分。已落地（只在开了 --signals 时写），以后腾出来
const FILM_AUX_DATA: u32 = 6u;        // 辅助样本覆盖写一次：x 深度，y 实体编号（存成浮点数值，小于 2^24），zw 运动矢量。已定义
const FILM_AUX_NORMAL: u32 = 7u;      // 辅助样本覆盖写一次：xyz 法线（相机空间，长度 1）。已定义
const FILM_AUX_HIT: u32 = 8u;         // 辅助样本覆盖写一次：xyz 命中点（世界坐标），w 物体表下标加 1（存成浮点数值；没打到：0）。
                                      // 宿主拿它求 motion（main.rs `write_passes`）。已落地
                                      // 第 9 格预留
const FILM_FIXED: u32 = 10u;          // 固定部分的长度。只用来与 Rust 一侧对数；内核读的是 P.film.film_lightgroup_first

// 「不属于任何灯组」的槽位
const LIGHTGROUP_NONE: u32 = 0xffffffffu;

// 上游 `render --signals` 要的几样（相机直接看到的光、首次命中处的高光份额怎么拆）。接上正式的通道之后删。
struct SampleLegacy {
    split: bool,                    // 相机命中处采过一次材质（下面几项才有意义）
    e0: vec3<f32>,                  // emission / sky seen directly (camera ray)
    spec0: vec3<f32>,               // specular direct light at the first hit
    rad0: vec3<f32>,                // radiance before the first BSDF sample
    k_spec: vec3<f32>,              // the specular share of the first BSDF sample
};

// 一个样本的结果：film_write_sample 收它。规矩同着色点（shader.wgsl 开头）：不许位置式构造；三维向量后面别紧跟标量。
struct SampleResult {
    alpha: f32,                     // 这个样本的不透明度：背景对相机不可见、相机射线又没打到表面时 0，否则 1。已落地
    L: vec3<f32>,                   // 颜色：这条路径上各次贡献之和。只由 film_add_light 加。已落地
    albedo: vec3<f32>,              // 降噪用的反照率与法线（上游的口径）。已落地
    normal: vec3<f32>,
    legacy: SampleLegacy,
};

// 这次调用（一个像素的一个样本）的结果，随路径推进累加。
var<private> film_sample: SampleResult;

// 这个像素在 film 里的第一个 vec4
fn film_pixel_first() -> u32 { return state.render_pixel_index * P.film.film_stride; }

// 路径上的一次贡献（已乘通量、已夹取）：加进这个样本的颜色；`lightgroup` 不是 LIGHTGROUP_NONE 时，同一个值直接加进
// film 里的那个灯组。每一次贡献调一次。`bounce`：这次贡献出在路径的第几个顶点（以后按它分直接光与间接光的夹取上限）。
// 现在各处传的都是 LIGHTGROUP_NONE，而且一次调用里还是几盏灯的和：把算灯的函数改成逐盏调用、带上灯组槽位，
// 是做灯的人的活。夹取在调用处：上游的亮度夹取，编译开关 sample_clamp 的变体里再经 film_clamp_contribution（Cycles 的口径）。
// 一个像素一条线程，直接加没有竞争。非有限的值不进灯组（颜色那边在样本结束时整个样本一起查）。
fn film_add_light(L: vec3<f32>, bounce: u32, lightgroup: u32) {
    film_sample.L += L;
    if (lightgroup != LIGHTGROUP_NONE && lightgroup < P.film.num_lightgroups && !non_finite(L)) {
        let i = film_pixel_first() + P.film.film_lightgroup_first + lightgroup;
        film[i] += vec4<f32>(L, 0.0);
    }
}

// 北冥：照 Cycles 的口径夹取路径上的一次贡献（../../shaders/imaging.wgsl 的 film_clamp_light），每次 film_add_light 之前调。
// bounce 照 Cycles 各调用处的口径：直接光（阴影射线）是着色点所在的顶点号，路上找到的发光、背景、雾是那一段射线的顶点号
// 减 1（相机射线是 -1）；所以相机看到的、第一次弹射之后打到的发光都算直接光。两个上限是 Cycles 内核的口径（用户值乘 3，
// render-pack 照命令行写），是 0 的那一个不夹（Cycles 在那里写 FLT_MAX）。只在编译开关 sample_clamp 的变体里调（两个上限
// 有一个不是 0 时 src/gpu.rs 打开它）；没有它时只有调用处上游的亮度夹取 P.misc.x。
fn film_clamp_contribution(L: vec3<f32>, bounce: i32) -> vec3<f32> {
    let direct = P.integrator.sample_clamp_direct;
    let indirect = P.integrator.sample_clamp_indirect;
    return film_clamp_light(L, bounce, select(direct, 3.4028235e38, direct == 0.0), select(indirect, 3.4028235e38, indirect == 0.0));
}

// 北冥：像素滤波表的第 i 个数（../../shaders/imaging.wgsl 的 filter_table_read 调它）：表在全局参数的 filter_table 一块
fn filter_table_value(i: i32) -> f32 { return P.filter_table.table[u32(i) >> 2u][u32(i) & 3u]; }

// 辅助样本：过像素中心的单独一条射线看到的深度、实体编号、运动矢量与法线，每个像素覆盖写一次，不做平均。
struct AuxSample {
    depth: f32,                     // 相机 Z 方向的平面深度；什么都没打到：1e10
    object_id: u32,                 // 实体编号（小于 2^24），没打到或打到的不属于任何实体：0
    motion: vec2<f32>,              // 运动矢量
    normal: vec3<f32>,              // 法线（相机空间，长度 1）；没打到：0
    hit: vec4<f32>,                 // 北冥：xyz 命中点（世界坐标），w 物体表下标加 1；没打到：全 0
};

// 写辅助样本。辅助那一趟调度（入口 aux_sample，integrator.wgsl）调它。
// 实体编号存成浮点数值：整数的位直接进浮点通道，小整数是非规格化数，驱动可能把它冲成 0。
fn film_write_aux(aux: AuxSample) {
    let b = film_pixel_first();
    film[b + FILM_AUX_DATA] = vec4<f32>(aux.depth, f32(aux.object_id), aux.motion);
    film[b + FILM_AUX_NORMAL] = vec4<f32>(aux.normal, 0.0);
    film[b + FILM_AUX_HIT] = aux.hit;
}

// 样本结束时写其余通道（颜色、样本数、降噪用的反照率与法线、上游的几格）。每个样本调一次。
// 这一段是上游 main 末尾写累加缓冲的语句，次序没动；只是每个通道各自成了 film 里的一格。
fn film_write_sample(r: SampleResult) {
    var radiance = r.L;
    var albedo = r.albedo;
    var normal = r.normal;
    // Integer tests: Metal's fast-math folds `x != x` away, so float NaN checks are unreliable.
    if (non_finite(radiance)) { radiance = vec3<f32>(0.0); }
    if (non_finite(albedo)) { albedo = vec3<f32>(0.0); }
    if (non_finite(normal)) { normal = vec3<f32>(0.0, 1.0, 0.0); }
    let b = film_pixel_first();
    // （四格先都读出来、再写回去，像上游整个结构读、整个结构写那样。读一格写一格地交替也对，苹果显卡上稳态慢约 1%。）
    let combined = film[b + FILM_COMBINED];
    let denoise_albedo = film[b + FILM_DENOISE_ALBEDO];
    let denoise_normal = film[b + FILM_DENOISE_NORMAL];
    let variance = film[b + FILM_LEGACY_VARIANCE];
    film[b + FILM_COMBINED] = combined + vec4<f32>(radiance, 1.0);
    let lum = luminance(radiance);
    film[b + FILM_DENOISE_ALBEDO] = denoise_albedo + vec4<f32>(albedo, r.alpha);
    // 覆盖率计数（输出通道契约 5.4）：这个样本相机射线首次命中的实体编号（没打到表面、或打到的不属于任何实体：0）等于辅助
    // 样本的编号，就记一份。只在要辅助层的变体里数（编译开关 aux）：每个样本多读一次辅助那一格，英伟达显卡上稳态慢约 1.4%。
    @if(!aux) film[b + FILM_DENOISE_NORMAL] = denoise_normal + vec4<f32>(normal, 0.0);
    @if(aux) {
        var first_id = 0.0;
        if (state.first_hit_object != OBJECT_NONE) { first_id = object_ext_at(state.first_hit_object).entity_id; }
        film[b + FILM_DENOISE_NORMAL] = denoise_normal + vec4<f32>(normal, select(0.0, 1.0, first_id == film[b + FILM_AUX_DATA].y));
    }
    film[b + FILM_LEGACY_VARIANCE] = variance + vec4<f32>(lum, lum * lum, 0.0, 0.0);
    // `render --signals` (P.motion.y, a live-only lane otherwise): what the camera ray saw directly and the specular
    // share at the camera hit, split as the live denoiser splits them (no reflection resolve), in the slots only live
    // renders use. The diffuse signal is the rest.
    if (P.motion.y > 0.5) {
        var sp = r.legacy.spec0;
        if (r.legacy.split) { sp += (radiance - r.legacy.rad0) * r.legacy.k_spec; }
        let em = select(r.legacy.e0, vec3<f32>(0.0), non_finite(r.legacy.e0));
        sp = select(clamp(sp, vec3<f32>(0.0), max(radiance - em, vec3<f32>(0.0))), vec3<f32>(0.0), non_finite(sp));
        film[b + FILM_LEGACY_EMIT] += vec4<f32>(em, 0.0);
        film[b + FILM_LEGACY_SPEC] += vec4<f32>(sp, 0.0);
    }
}
