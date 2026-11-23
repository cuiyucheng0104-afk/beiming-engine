// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：输出），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// ------------------------------------------------------------------------------------------------
// What a live trace leaves the live passes (live.wgsl).

// Group 1, the buffers the kernel writes, used through the functions below in every layout:
//  - refl: reflection resolve inputs (live; live.wgsl `refl`), 2 per traced pixel: the camera hit's specular-lobe ray
//    (radiance it brought back, its lobe pdf; pdf 0 = the pixel sampled another lobe), (specular albedo E at the hit,
//    octahedral ray direction). Neighbours reuse each other's rays weighted by their own BRDF (Lumen / SSSR);
//  - motion_out: live motion vectors per traced pixel: where the camera hit was the previous frame, as a world-space
//    offset (w = 1: on a moving triangle);
//  - direct_out: live deterministic direct light per traced pixel (`dl_det` at the camera hit; w: the light it
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
// 北冥：一个样本写进 accum。这一段原来写在 main 的末尾；着色器的一个函数不能跨文件，按阶段分文件时抽成了函数，
// 里面的语句没动（参数是 main 里的同名局部量）。

fn accum_write_sample(pix: u32, radiance_in: vec3<f32>, albedo_in: vec3<f32>, normal_in: vec3<f32>, e0: vec3<f32>, spec0: vec3<f32>, split: bool, rad0: vec3<f32>, k_spec: vec3<f32>) {
    var radiance = radiance_in;
    var albedo = albedo_in;
    var normal = normal_in;
    // Integer tests: Metal's fast-math folds `x != x` away, so float NaN checks are unreliable.
    if (non_finite(radiance)) { radiance = vec3<f32>(0.0); }
    if (non_finite(albedo)) { albedo = vec3<f32>(0.0); }
    if (non_finite(normal)) { normal = vec3<f32>(0.0, 1.0, 0.0); }
    var px = accum[pix];
    px.color += vec4<f32>(radiance, 1.0);
    let lum = luminance(radiance);
    px.albedo += vec4<f32>(albedo, lum);
    px.normal += vec4<f32>(normal, lum * lum);
    // `render --signals` (P.motion.y, a live-only lane otherwise): what the camera ray saw directly and the specular
    // share at the camera hit, split as the live denoiser splits them (no reflection resolve), in the slots only live
    // renders use. The diffuse signal is the rest.
    if (P.motion.y > 0.5) {
        var sp = spec0;
        if (split) { sp += (radiance - rad0) * k_spec; }
        let em = select(e0, vec3<f32>(0.0), non_finite(e0));
        sp = select(clamp(sp, vec3<f32>(0.0), max(radiance - em, vec3<f32>(0.0))), vec3<f32>(0.0), non_finite(sp));
        px.emit += vec4<f32>(em, 0.0);
        px.spec += vec4<f32>(sp, 0.0);
    }
    accum[pix] = px;
}
