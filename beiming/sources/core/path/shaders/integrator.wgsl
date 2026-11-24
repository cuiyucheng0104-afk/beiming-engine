// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：积分主循环），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// SPDX-FileCopyrightText: 2026 Meshy LLC
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: MIT AND Apache-2.0
// 多方许可。上游的与北冥新写的部分是 MIT。照 Cycles（Blender v5.2.3，路径相对 intern/cycles/）取的部分是 Apache-2.0
// （许可全文见仓库根的 LICENSES/Apache-2.0.txt）：
//   路径标志位 PATH_RAY_*、可见类 PATH_RAY_VISIBILITY_*、PRNG_BOUNCE_NUM、LABEL_VOLUME_SCATTER 的名字与数值，光线的字段名：kernel/types.h
//   路径状态的字段名：kernel/integrator/state_template.h
//   path_state_next 的骨架（按采样标签定下一段光线的可见类、推进随机维度的偏移）：kernel/integrator/path_state.h
// ------------------------------------------------------------------------------------------------
// 北冥：路径状态与光线。照 Cycles 的 IntegratorState.path 与 Ray 取子集，字段名不改。
//
// 路径状态是一个模块级的私有变量（每个像素的这次调用各有一份），所有函数直接读写 `state`，不当参数传。
// 上游散在各处的私有全局与主循环里的散变量都并在这里：照 Cycles 有对应的进正式字段，没有对应的进 `legacy`。
// 规矩同着色点（shader.wgsl 开头）：不许位置式构造；函数实参不许是指向它的成员的指针（`&state.throughput`：两块显卡
// 的着色器后端都编不过）。
// 字段的状态：「已落地」有写有读；「已写未读」现在就写、还没人读（src/gpu.rs 的测试 `path_state_is_written` 守着这几处
// 写入不被删掉）；「已定义」含义定了、等后面的移植来写。

// 每次弹射占的随机维度个数，照 Cycles 的 PRNG_BOUNCE_NUM
const PRNG_BOUNCE_NUM: u32 = 16u;

// 路径标志位（PathState.flag），位照 Cycles 的 PathRayFlag。现在只接了 PATH_RAY_MIS_SKIP，其余已定义。
const PATH_RAY_REFLECT: u32 = 1u << 0u;
const PATH_RAY_SINGULAR: u32 = 1u << 1u;
const PATH_RAY_TRANSPARENT: u32 = 1u << 2u;
const PATH_RAY_DIFFUSE_ANCESTOR: u32 = 1u << 4u;
const PATH_RAY_EMISSION: u32 = 1u << 5u;
const PATH_RAY_MIS_HAD_TRANSMISSION: u32 = 1u << 6u;
const PATH_RAY_MIS_SKIP: u32 = 1u << 7u;                 // 下一次打到灯不做多重重要性采样（相机射线、镜面弹射之后）。已落地
const PATH_RAY_SINGLE_PASS_DONE: u32 = 1u << 8u;
const PATH_RAY_TRANSPARENT_BACKGROUND: u32 = 1u << 9u;
const PATH_RAY_TERMINATE_ON_NEXT_SURFACE: u32 = 1u << 10u;
const PATH_RAY_TERMINATE_AFTER_TRANSPARENT: u32 = 1u << 12u;
const PATH_RAY_DENOISING_FEATURES: u32 = 1u << 17u;
const PATH_RAY_SURFACE_PASS: u32 = 1u << 18u;
const PATH_RAY_SHADOW_FOR_AO: u32 = 1u << 20u;
const PATH_RAY_SHADOW_FOR_LIGHT_LINKING: u32 = 1u << 25u;

// 光线可见类（PathState.visibility），位照 Cycles 的 PathRayVisibilityFlag
const PATH_RAY_VISIBILITY_NONE: u32 = 0u;
const PATH_RAY_VISIBILITY_CAMERA: u32 = 1u << 0u;
const PATH_RAY_VISIBILITY_TRANSMIT: u32 = 1u << 1u;
const PATH_RAY_VISIBILITY_DIFFUSE: u32 = 1u << 2u;
const PATH_RAY_VISIBILITY_GLOSSY: u32 = 1u << 3u;
const PATH_RAY_VISIBILITY_VOLUME_SCATTER: u32 = 1u << 4u;
const PATH_RAY_VISIBILITY_SHADOW_OPAQUE: u32 = 1u << 5u;
const PATH_RAY_VISIBILITY_SHADOW_TRANSPARENT: u32 = 1u << 6u;

// 采样标签里介质散射的一位，数值照 Cycles（别的几位在 ../../shaders/util.wgsl 与 closure.wgsl）
const LABEL_VOLUME_SCATTER: i32 = 64;

// 「没有物体」
const OBJECT_NONE: u32 = 0xffffffffu;

// 上游的路径状态，照 Cycles 没有对应。对应的功能照 Cycles 移植之后删。
struct PathLegacy {
    // Glass passed since the last scattering vertex: any (behind_glass), and whether an odd number of surfaces (bent).
    // The vertex's shadow rays toward emitters stopped at the glass and those toward the sky at bending glass, so
    // what the path finds there counts in full; behind glass that does not bend (a pane) the sky and the directional
    // lights' disks are weighed against the vertex's samples, which passed it (counted in full, they were counted
    // twice: a white furnace through water read 1.53).
    behind_glass: bool,
    bent: bool,
    // Only glass passed so far (straight through): what lies behind is seen directly, not clamped as indirect.
    straight: bool,
    // The path so far is camera ray + mirror-like bounces (puddles, glass): surface detail is still visible.
    mirror_path: bool,
    // 这一段射线是表面顶点按材质采样出来的（bm_rect_hits 要的就是这种）
    bm_surf: bool,
    // Live "ray tracing off" (P.raster.w, LiveCore::rays): set once the camera's own ray has found its surface. From
    // then on `trace` reports a miss, so nothing is shadowed, a bounce sees the sky and a mirror reflects the sky: what
    // a rasterizer without shadow maps draws, on any GPU, from the same scene and the same shading. The switch is a
    // uniform: no kernel is rebuilt to flip it.
    rays_off: bool,
    // Specular share of the last BSDF evaluation (per channel), the specular part of the direct light being summed,
    // and whether the last BSDF sample took the specular lobe: the live denoiser filters diffuse and specular apart.
    split_frac: vec3<f32>,
    dl_spec: vec3<f32>,
    sampled_spec: bool,
    // The last BSDF sample went through the surface (glass: refraction, a delta lobe).
    sampled_trans: bool,
    // Where the last vertex sampled emitters (its point and normal, 0 = none: fog): a BSDF ray's emitter hit weighs
    // its MIS by the light tree's pmf there (emit_mis).
    mis_x: vec3<f32>,
    mis_n: vec3<f32>,
    // At camera hits, the direct light from directional lights (the sun: a tiny disk, so nearly deterministic) and its
    // specular part: the live viewport keeps it in a signal of its own (no denoiser; short history while things
    // change). Local lights stay in the denoised signals: their soft shadows are noisy, and on Kabukicho moving them
    // here cost motion and static error (excess 1.71 / 1.86 / 2.20 -> 1.92 / 1.95 / 2.33, k = 1 SSIM 0.640 -> 0.620).
    dl_det: vec3<f32>,
    dl_det_spec: vec3<f32>,
    // Whether a cutout let the last shadow ray through (the shadow rays' functions clear it, `trace` sets it).
    shadow_hole: bool,
    // Set around a `direct_light` that no BSDF ray follows (where a path ends without the cache): its light samples
    // take the whole of their light. Weighed against a BSDF ray that is never traced they kept their MIS share alone:
    // of a uniform sky on a Lambert surface, ln 17 / 16 = 18 %.
    nee_alone: bool,
    // `direct_light` without the sky: a surface seen in a reflection lights itself from the lights, the sky's light
    // there is the radiance cache's.
    lights_only: bool,
    // 上游随机数编号里的「这次调用的第几条路径」，离线恒为 0。编号换成按 rng_offset 之后只剩实时那一支的 rng_white 读它
    rng_path: u32,
    // 这一段射线出发的着色点本身（没有沿法线挪开）。bm_rect_hits 从它算矩形纯光的命中与概率密度：光源采样一侧
    // 也是从着色点本身算的，两侧要用同一个点，多重重要性采样的权重才配得平（Cycles 不挪射线起点，没有这个问题）
    bm_x: vec3<f32>,
};

struct PathState {
    render_pixel_index: u32,        // 写缓冲用的像素下标。已落地
    sample: u32,                    // 第几个样本（上游的 RNG_INDEX）。已落地
    bounce: u32,                    // 总弹射数，也就是当前着色点是路径上第几个顶点（上游的 cur_depth）。已落地
    diffuse_bounce: u32,            // 分类计数，照采样标签累加并接各自的上限。已定义（移植闭包的人写）
    glossy_bounce: u32,
    transmission_bounce: u32,
    transparent_bounce: u32,
    rng_pixel: u32,                 // 随机数的像素种子（上游的 RNG_SEED）。已落地
    rng_offset: u32,                // 当前弹射的随机维度偏移：初值 PRNG_BOUNCE_NUM，每弹射一次加一个（sample.wgsl 的
                                    // path_rng_* 与 rng_legacy 都按它编号）。已落地
    flag: u32,                      // 路径标志位（PATH_RAY_*）
    mis_ray_pdf: f32,               // 上一个散射点采样的概率密度：下一次打到灯时算多重重要性采样的权重。已落地
    min_ray_pdf: f32,               // 这条路径上最小的采样概率密度，初值为浮点最大值（滤光泽与倒角的早退用）。已写未读
    continuation_probability: f32,  // 这一次弹射俄罗斯轮盘的存活概率，不掷时为 1。已落地
    throughput: vec3<f32>,          // 路径的通量权重。已落地
    visibility: u32,                // 这一段光线的可见类（PATH_RAY_VISIBILITY_*）。已写未读（做灯的人读；按采样标签
                                    // 细分的规矩归移植闭包的人）
    mis_ray_object: u32,            // 上一个散射点所在的物体（物体表的下标；灯光链接用）。已写未读
    first_hit_object: u32,          // 相机射线首次命中的物体（物体表的下标），没打到表面：OBJECT_NONE。覆盖率用（film.wgsl 的
                                    // film_write_sample 拿它的实体编号与辅助样本的比）。已落地
    legacy: PathLegacy,             // 上游的状态，见上
};

var<private> state: PathState;

// 光线。照 Cycles 的 Ray，加上游的射线锥（它跟着光线走，不随闭包的移植删除）。
// 上游的求交函数签名没动：`trace(起点, 方向, 最远距离, 模式)`，调用处从这里取字段。
// 两个三维向量排在最后，是有意的：它们排在前面、后面紧跟标量时，苹果显卡上两个带水的场景像素会变（实测）。推测是
// 后端把后面紧跟标量的三维向量按紧凑格式存，运算次序跟着变。往这个结构里加字段请加在两个向量之前。
struct Ray {
    tmin: f32,                      // 起始距离。已定义（上游靠把起点沿法线挪开来避开自己，见 offset_origin）
    tmax: f32,                      // 最远距离。已落地
    time: f32,                      // 时刻（运动模糊用）。已定义，恒 0
    self_object: u32,               // 光线出发处的物体与图元，求交时跳过自己用。已写未读，现在恒为 OBJECT_NONE
    self_prim: u32,
    cone_w: f32,                    // Ray cone (Akenine-Moller et al. 2019) for texture LOD: footprint width at the origin
    cone_a: f32,                    // + spread angle. 已落地
    P: vec3<f32>,                   // 起点。已落地
    D: vec3<f32>,                   // 方向（单位向量）。已落地
};

// 弹射之后更新路径状态。照 Cycles 的 path_state_next，现在只有骨架：下一段光线的可见类与随机维度的偏移。
// 分类计数、各类弹射上限、其余路径标志位归移植闭包的人照 Cycles 补；PATH_RAY_MIS_SKIP 还按上游的规矩在主循环里设
// （上游的「镜面弹射」与 Cycles 的「奇异的一瓣」不是同一个判法）。`label`：这次采样的标签（LABEL_*）。
fn path_state_next(label: i32) {
    var visibility = PATH_RAY_VISIBILITY_NONE;
    if ((label & LABEL_VOLUME_SCATTER) != 0) {
        visibility |= PATH_RAY_VISIBILITY_VOLUME_SCATTER;
    } else {
        if ((label & LABEL_TRANSMIT) != 0) { visibility |= PATH_RAY_VISIBILITY_TRANSMIT; }
        if ((label & LABEL_DIFFUSE) != 0) { visibility |= PATH_RAY_VISIBILITY_DIFFUSE; } else { visibility |= PATH_RAY_VISIBILITY_GLOSSY; }
    }
    state.visibility = visibility;
    state.rng_offset += PRNG_BOUNCE_NUM;
}

// Shading points the camera sees, directly or in a mirror-like reflection (wet streets, glass): they get the exact
// light loop and resampled emitters, so reflections are as clean as what they reflect.
fn seen_directly() -> bool {
    return state.bounce == 0u || (state.bounce == 1u && state.legacy.mirror_path);
}

// 北冥：辅助样本（输出通道契约 5.1）。每个像素一条：过像素中心、针孔（不开景深）、时刻 0，不取任何随机数、不调图案节点，
// 只求交、取几何量，覆盖写 film 的辅助两格。深度是沿相机前方的平面深度；法线是着色法线（顶点法线插值，背对来路的面翻向
// 相机：shader_setup_from_hit 已经翻过），变到相机空间（相机看 -Z、Y 向上）；实体编号读物体扩展表。什么都没打到：编号 0、
// 深度 1e10、法线 0。相机射线的算式照 main 里的那一段，只是像素内的位置取中心、不加镜头的偏移。
fn aux_sample(gid: vec2<u32>) {
    let w = P.size.x;
    let h = P.size.y;
    state.bounce = 0u;
    let ndc = vec2<f32>((f32(gid.x) + 0.5) / f32(w) * 2.0 - 1.0, 1.0 - (f32(gid.y) + 0.5) / f32(h) * 2.0);
    let d = normalize(P.cam_fwd.xyz + P.cam_right.xyz * (ndc.x * P.cam_pos.w * P.cam_fwd.w) + P.cam_up.xyz * (ndc.y * P.cam_pos.w));
    let hit = trace(P.cam_pos.xyz, d, INF, TRACE_CLOSEST);
    var aux = AuxSample();
    aux.depth = 1e10;
    if (hit.tri != 0xffffffffu) {
        var sd = ShadingPoint();
        shader_setup_from_hit(&sd, P.cam_pos.xyz, d, hit);
        aux.depth = hit.t * dot(d, P.cam_fwd.xyz);
        aux.object_id = u32(object_ext_at(sd.object).entity_id);
        aux.normal = vec3<f32>(dot(sd.N, P.cam_right.xyz), dot(sd.N, P.cam_up.xyz), -dot(sd.N, P.cam_fwd.xyz));
    }
    film_write_aux(aux);
}

// ------------------------------------------------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let w = P.size.x;
    let h = P.size.y;
    if (gid.x >= w || gid.y >= h) { return; }
    let pix = gid.y * w + gid.x;
    state.render_pixel_index = pix;
    // 北冥：辅助那一趟调度（gpu.rs 在清零之后、第一个颜色样本之前跑一次）只写辅助样本，不走下面的颜色样本
    if (P.integrator.pass_kind == PASS_KIND_AUX) {
        aux_sample(gid.xy);
        return;
    }
    if (has(F_LISTS)) { lt_fb = LT_NONE; }
    rng_start(gid.xy, P.size.z, P.integrator.seed, 0u);
    state.bounce = 0u;
    state.rng_offset = PRNG_BOUNCE_NUM;
    state.min_ray_pdf = 3.4028235e38;
    state.continuation_probability = 1.0;
    state.visibility = PATH_RAY_VISIBILITY_CAMERA;
    state.mis_ray_object = OBJECT_NONE;
    state.first_hit_object = OBJECT_NONE;
    // 这个样本的不透明度：背景对相机可见时恒为 1；不可见时相机射线什么都没打到记 0（见下面没打到的那一支）
    film_sample.alpha = 1.0;
    // 北冥：相机光线。这一段留在 main 里：试过抽成单独的函数，Metal 上相机三个轴都不贴坐标轴的场景末位会变（运算次序），
    // 所以没有单独的相机文件。
    // 相机的两个决定照 Cycles 编号（kernel/integrator/init_from_camera.h）：像素滤波取 PRNG_FILTER 的 2 维，镜头取
    // PRNG_LENS_TIME 的 3 维里的后两个（第一个是时刻，现在不用）；这两个编号不加弹射的偏移。Cycles 在样本号为 0 时把
    // 像素滤波固定在像素中心，这里不照搬：每个样本都抖动。
    let rand_filter = rng2(PRNG_FILTER);

    // (Every sample draws its own sub-pixel jitter.)
    var jx = rand_filter.x;
    var jy = rand_filter.y;
    let ndc = vec2<f32>((f32(gid.x) + jx) / f32(w) * 2.0 - 1.0, 1.0 - (f32(gid.y) + jy) / f32(h) * 2.0);
    var d = normalize(P.cam_fwd.xyz + P.cam_right.xyz * (ndc.x * P.cam_pos.w * P.cam_fwd.w) + P.cam_up.xyz * (ndc.y * P.cam_pos.w));
    var o = P.cam_pos.xyz;
    if (P.cam_right.w > 0.0) {
        let focus = o + d * (P.cam_up.w / dot(d, P.cam_fwd.xyz));
        let rand_time_lens = rng3(PRNG_LENS_TIME);
        let r = sqrt(rand_time_lens.y) * P.cam_right.w;
        let phi = 2.0 * PI * rand_time_lens.z;
        o += P.cam_right.xyz * (r * cos(phi)) + P.cam_up.xyz * (r * sin(phi));
        d = normalize(focus - o);
    }

    var first_t = 0.0;
    state.throughput = vec3<f32>(1.0);
    var albedo = vec3<f32>(0.0);
    var normal = vec3<f32>(0.0);
    var anim = false;
    var e0 = vec3<f32>(0.0); // emission / sky seen directly (camera ray): the live denoiser leaves it unfiltered
    // Diffuse / specular split at the first hit: specular direct light, the specular share of the first BSDF sample
    // (everything gathered after it scales the same way), radiance before it, roughness, reflection hit distance.
    var spec0 = vec3<f32>(0.0);
    var k_spec = vec3<f32>(0.0);
    var rad0 = vec3<f32>(0.0);
    var split = false;
    var rough0 = 1.0;
    var spec_lobe = false;
    var spec_t = 0.0;
    state.mis_ray_pdf = 0.0;
    // The camera hit's specular-lobe sample for the reflection resolve: direction, lobe pdf, path weight, albedo E;
    // and whether the camera hit's sample went through glass.
    var refl_l = vec3<f32>(0.0);
    var refl_pdf = 0.0;
    var refl_w = vec3<f32>(0.0);
    var refl_e = vec3<f32>(0.0);
    var through0 = false;
    // The camera hit is transmissive (glass, water): its reflections stay in the specular signal too (the resolve's
    // neighbours there mostly went through, so it had no rays to rebuild them from: live glass lost its reflection).
    var glass0 = false;
    var mv = vec4<f32>(0.0);
    state.legacy.dl_det = vec3<f32>(0.0);
    state.legacy.dl_det_spec = vec3<f32>(0.0);
    state.flag = PATH_RAY_MIS_SKIP;
    state.legacy.behind_glass = false;
    state.legacy.bent = false;
    state.legacy.straight = true;
    let clamp_v = P.misc.x;
    // 北冥：相机那一段算出的起点与方向在这里填进光线（相机的算式没有挪动，见上）。
    var ray = Ray();
    ray.P = o;
    ray.D = d;
    ray.tmax = INF;
    ray.self_object = OBJECT_NONE;
    ray.self_prim = OBJECT_NONE;
    ray.cone_w = 0.0;
    ray.cone_a = 2.0 * P.cam_pos.w / lod_height();

    state.legacy.mirror_path = false;
    state.legacy.bm_surf = false;
    for (var depth = 0u; depth <= P.counts.z; depth++) {
        state.bounce = depth;
        var hit: Hit;
        hit = trace(ray.P, ray.D, ray.tmax, TRACE_CLOSEST);
        // Ray tracing off: the camera ray above was the last one traced for this pixel.
        if (depth == 0u) { state.legacy.rays_off = LIVE && P.raster.w > 0.5; }
        if (has(F_FOG) && P.fog.x > 0.0) {
            // Height fog on every segment (attenuation + ambient inscattering); lit volumetric scattering on camera rays.
            let t0 = select(0.0, P.fog.w, depth == 0u);
            let t1 = select(hit.t, 2.0e4, hit.tri == 0xffffffffu);
            // Inside the volumetric range (camera rays) the medium is denser by the extinction scale (UE).
            var od = fog_depth(ray.P, ray.D, t0, t1);
            var tv = t1;
            var trv = 1.0;
            if (has(F_VOLUME) && depth == 0u && P.vol.x > 0.0) {
                tv = select(t1, min(t1, P.vol2.w), P.vol2.w > 0.0);
                let odv = fog_depth(ray.P, ray.D, t0, max(tv, t0));
                od += odv * (P.vol.z - 1.0);
                trv = exp(-odv * P.vol.z);
            }
            let tr = max(exp(-od), 1.0 - P.fog_color.w);
            // Interleaved over 8x4 tiles (one SIMD group each, so skipped tiles really idle), rotating per sample:
            // a quarter of the pixels at 4x weight; the low-frequency fog converges in the accumulation.
            if (has(F_VOLUME) && depth == 0u && P.vol.x > 0.0 && (((gid.x >> 3u) + 2u * (gid.y >> 2u) + pcg(P.size.z)) & VOL_RATE_MASK) == 0u) {
                // Firefly clamp: a fog point next to a bright sign is rare and huge; haze is a few nits.
                var fs = f32(VOL_RATE_MASK + 1u) * fog_scatter(ray.P, ray.D, t0, max(tv, t0), trv, rng_legacy(D_FOG));
                let fl = luminance(fs);
                let fmax = 0.02 * clamp_v;
                if (fl > fmax) { fs *= fmax / fl; }
                film_add_light(state.throughput * fs, depth, LIGHTGROUP_NONE);
            }
            film_add_light(state.throughput * (1.0 - tr) * P.fog_color.rgb, depth, LIGHTGROUP_NONE);
            state.throughput *= tr;
        }
        if (has(F_AERIAL) && hit.tri != 0xffffffffu) {
            let ta = aerial_tr(ray.P, ray.D, hit.t);
            let haze = state.throughput * (1.0 - ta) * aerial_light(ray.D);
            film_add_light(haze, depth, LIGHTGROUP_NONE);
            // Live: the camera ray's haze is light the camera sees directly, not the surface's: it joins the emission
            // signal (left out of the diffuse one, which the denoiser divides by the albedo).
            if (depth == 0u) { e0 += haze; }
            state.throughput *= ta;
        }
        // Paths track every medium.
        if (!LIVE && has(F_MEDIA) && P.time.w > 0.5) {
            // Media on this segment: emission on the way; a real collision scatters the path there.
            let tk = media_track(ray.P, ray.D, select(hit.t, 1.0e30, hit.tri == 0xffffffffu), rng_legacy(D_MEDIA));
            film_add_light(state.throughput * tk.emission, depth, LIGHTGROUP_NONE);
            if (tk.t >= 0.0) {
                let x = ray.P + ray.D * tk.t;
                state.throughput *= tk.albedo;
                if (depth == 0u) {
                    first_t = tk.t;
                    albedo = tk.albedo;
                    normal = -ray.D;
                }
                var c = state.throughput * phase_direct(x, ray.D, tk.g, rng_legacy(D_VOL_LIGHT));
                if (depth > 0u && !state.legacy.straight) {
                    let lum = luminance(c);
                    if (lum > clamp_v) { c *= clamp_v / lum; }
                }
                film_add_light(c, depth, LIGHTGROUP_NONE);
                if (depth == P.counts.z) { break; }
                let nd = sample_hg(ray.D, tk.g);
                state.mis_ray_pdf = hg_phase(tk.g, dot(nd, ray.D));
                state.min_ray_pdf = min(state.mis_ray_pdf, state.min_ray_pdf);
                state.mis_ray_object = OBJECT_NONE;
                path_state_next(LABEL_VOLUME_SCATTER);
                state.legacy.bm_surf = false;
                state.flag &= ~PATH_RAY_MIS_SKIP;
                state.legacy.behind_glass = false;
                state.legacy.bent = false;
                state.legacy.straight = false;
                state.legacy.mirror_path = false;
                ray.cone_w += ray.cone_a * tk.t;
                ray.cone_a += 2.0;
                state.continuation_probability = 1.0;
                if (depth >= P.counts.w) {
                    state.continuation_probability = min(max(state.throughput.x, max(state.throughput.y, state.throughput.z)), 0.95);
                    if (path_rng_1D(PRNG_TERMINATE) > state.continuation_probability) { break; }
                    state.throughput /= state.continuation_probability;
                }
                ray.P = x;
                ray.D = nd;
                continue;
            }
        }
        if (!LIVE && state.legacy.bm_surf) {
            // （遮挡距离 hit.t 是从挪开的起点量的，灯距从着色点本身量，两个起点不同，不能直接比。光源采样一侧的阴影
            // 射线从挪开的起点打、长度取灯距乘 0.999，在这之内没有遮挡物就算照得到；这里用同一条判法：hit.t 除以
            // 0.999 再与灯距比。直接拿 hit.t 比的话，灯紧贴背后的面时这一侧会把灯判成被挡住，两侧权重加不到 1。）
            var c = state.throughput * bm_rect_hits(state.legacy.bm_x, ray.D, select(hit.t / 0.999, INF, hit.tri == 0xffffffffu), state.mis_ray_pdf);
            if (depth > 1u && !state.legacy.straight) {
                let lum = luminance(c);
                if (lum > clamp_v) { c *= clamp_v / lum; }
            }
            film_add_light(c, depth, LIGHTGROUP_NONE);
        }
        if (hit.tri == 0xffffffffu) {
            // 北冥：背景对相机不可见（P.integrator.background_transparent）时，相机射线什么都没打到的样本不透明度与颜色都记 0
            // （输出通道契约 5.2）：路上已经加进来的雾也不算
            if (depth == 0u && P.integrator.background_transparent != 0u) {
                film_sample.alpha = 0.0;
                film_sample.L = vec3<f32>(0.0);
                break;
            }
            var c = state.throughput * sky_mis(ray.D, select(0.0, state.mis_ray_pdf, depth > 0u && !state.legacy.bent));
            if (depth > 1u && !state.legacy.straight) {
                let lum = luminance(c);
                if (lum > clamp_v) { c *= clamp_v / lum; }
            }
            if (depth == 0u) { e0 += c; }
            if (depth == 1u && spec_lobe) { spec_t = 1.0e4; }
            film_add_light(c, depth, LIGHTGROUP_NONE);
            break;
        }
        let width = ray.cone_w + ray.cone_a * hit.t;
        // 北冥：材质求值分三步（shader.wgsl）：几何量、材质输入值、闭包。主循环碰材质只经 shader.wgsl 的这三步与
        // closure.wgsl 的 surface_shader_* 一组函数；读 legacy 的几处是登记过的例外（closure.wgsl「上游顶替」一节）。
        var sd = ShadingPoint();
        shader_setup_from_hit(&sd, ray.P, ray.D, hit);
        let inputs = shader_eval_inputs(&sd, ray.P, ray.D, hit, width);
        shader_setup_closures(&sd, inputs);
        if (depth == 0u) {
            state.first_hit_object = sd.object;
            first_t = hit.t;
            if (has(F_LISTS)) { lt_list_start(sd.P + mv.xyz); }
            // （降噪用的反照率与法线，上游的口径：只发光的面取发光色，别的取闭包的反照率；法线取闭包用的法线。）
            albedo = select(bsdf_albedo(sd, 0u), sd.emission / max(max(sd.emission.r, max(sd.emission.g, sd.emission.b)), 1e-6), sd.num_closure == 0u);
            normal = inputs.N;
            anim = sd.legacy.surface.anim;
            rough0 = sd.legacy.surface.roughness;
        }
        if (depth == 1u && spec_lobe) { spec_t = hit.t; }
        // Emission (one-sided for rect light cards)
        let le = surface_shader_emission(sd);
        if (any(le > vec3<f32>(0.0))) {
            var wgt = 1.0;
            // Behind glass an emitter counts in full: shadow rays toward emitters stop at glass (emitter_tr).
            if (depth > 0u && (state.flag & PATH_RAY_MIS_SKIP) == 0u && !state.legacy.behind_glass) {
                wgt = emit_mis(hit, ray.D, state.mis_ray_pdf);
            }
            var c = state.throughput * le * wgt;
            if (depth > 1u && !state.legacy.straight) {
                let lum = luminance(c);
                if (lum > clamp_v) { c *= clamp_v / lum; }
            }
            if (depth == 0u) { e0 += c; }
            film_add_light(c, depth, LIGHTGROUP_NONE);
        }
        // （没有闭包的面只发光、不散射：上游的发光卡片。）
        if (sd.num_closure == 0u) { break; }
        @if(!last_direct && !last_sun) if (depth == P.counts.z) { break; }
        @if(last_sun && !last_direct) if (depth == P.counts.z) {
            // gpu.rs `KernelSwitches::last_sun`: the last vertex's light from the directional lights alone.
            if (depth > 0u) {
                surface_shader_prepare_closures(&sd);
                var dz = state.throughput * sun_light(sd);
                let lum = luminance(dz);
                if (lum > clamp_v && !state.legacy.straight) { dz *= clamp_v / lum; }
                film_add_light(dz, depth, LIGHTGROUP_NONE);
            }
            break;
        }
        @if(last_direct) if (depth == P.counts.z) {
            // gpu.rs `KernelSwitches::last_direct`: the last vertex's direct light.
            if (depth > 0u) {
                surface_shader_prepare_closures(&sd);
                var dz = state.throughput * direct_light(sd);
                let lum = luminance(dz);
                if (lum > clamp_v && !state.legacy.straight) { dz *= clamp_v / lum; }
                film_add_light(dz, depth, LIGHTGROUP_NONE);
            }
            break;
        }
        surface_shader_prepare_closures(&sd);
        var dl = state.throughput * direct_light(sd);
        if (depth > 0u && !state.legacy.straight) {
            let lum = luminance(dl);
            if (lum > clamp_v) { dl *= clamp_v / lum; }
        }
        film_add_light(dl, depth, LIGHTGROUP_NONE);
        // 北冥：选一个闭包，在它上面采样方向。三个随机数照 Cycles 编号（PRNG_SURFACE_BSDF）：前两个定方向，第三个选闭包
        // 并复用。上游顶替自己从上游的随机数里取（rng_legacy(D_BSDF)），不用这三个。
        let rand_bsdf = path_rng_3D(PRNG_SURFACE_BSDF);
        let pick = surface_shader_bsdf_bssrdf_pick(sd, rand_bsdf);
        let bs = surface_shader_bsdf_sample_closure(sd, pick.closure, pick.rand);
        let l = bs.wo;
        // （奇异的一瓣：上游顶替里是穿过光滑玻璃。没有概率密度，不做多重重要性采样，后面的东西算全份。）
        let through = (bs.label & LABEL_SINGULAR) != 0;
        // （采到的是光泽或奇异的一瓣，不是漫反射：上游的 state.legacy.sampled_spec || state.legacy.sampled_trans。）
        let glossy = (bs.label & (LABEL_GLOSSY | LABEL_SINGULAR)) != 0;
        let pdf = bs.pdf;
        let wgt = bs.weight;
        if (depth == 0u) {
            spec0 = state.throughput * state.legacy.dl_spec;
            k_spec = state.legacy.split_frac;
            rad0 = film_sample.L;
            split = true;
            spec_lobe = glossy;
            through0 = through;
            glass0 = has(F_GLASS) && sd.legacy.surface.transmission > 0.0;
            refl_e = sd.legacy.lobes.e_spec;
            if ((bs.label & (LABEL_REFLECT | LABEL_GLOSSY)) == (LABEL_REFLECT | LABEL_GLOSSY) && sd.legacy.lobes.coat <= 0.0) {
                refl_l = l;
                refl_pdf = pdf_spec(sd, l);
                refl_w = wgt;
            }
        }
        if ((!through && pdf <= 0.0) || all(wgt <= vec3<f32>(0.0))) { break; }
        state.throughput *= wgt;
        if (through && dot(l, sd.Ng) < 0.0) {
            state.legacy.behind_glass = true;
            state.legacy.bent = !state.legacy.bent;
        } else if (through) {
            // (A refracted direction the geometric normal keeps on this side: a specular vertex.)
            state.mis_ray_pdf = 0.0;
            state.flag |= PATH_RAY_MIS_SKIP;
            state.legacy.behind_glass = false;
            state.legacy.bent = false;
        } else {
            state.mis_ray_pdf = pdf;
            // （有概率密度的弹射才记最小值：穿过光滑玻璃的那一瓣没有密度，上面两支不记。）
            state.min_ray_pdf = min(pdf, state.min_ray_pdf);
            state.flag &= ~PATH_RAY_MIS_SKIP;
            state.legacy.behind_glass = false;
            state.legacy.bent = false;
        }
        state.legacy.straight = state.legacy.straight && through;
        state.mis_ray_object = sd.object;
        path_state_next(bs.label);
        state.legacy.bm_surf = !through;
        ray.cone_w = width;
        ray.cone_a += 2.0 * bs.sampled_roughness.x * bs.sampled_roughness.x;
        state.legacy.mirror_path = (depth == 0u || state.legacy.mirror_path) && bs.sampled_roughness.x < MIRROR_ROUGHNESS && glossy;
        state.continuation_probability = 1.0;
        if (depth >= P.counts.w) {
            state.continuation_probability = min(max(state.throughput.x, max(state.throughput.y, state.throughput.z)), 0.95);
            if (path_rng_1D(PRNG_TERMINATE) > state.continuation_probability) { break; }
            state.throughput /= state.continuation_probability;
        }
        state.legacy.bm_x = sd.P;
        ray.P = offset_origin(sd.P, select(sd.Ng, -sd.Ng, dot(l, sd.Ng) < 0.0));
        ray.D = l;
    }

    if (non_finite(vec3<f32>(first_t))) { first_t = 0.0; }
    // 北冥：样本结束，其余通道在 film.wgsl 的 film_write_sample 里写（颜色已经由各处的 film_add_light 加进 film_sample.L）
    film_sample.albedo = albedo;
    film_sample.normal = normal;
    film_sample.legacy.split = split;
    film_sample.legacy.e0 = e0;
    film_sample.legacy.spec0 = spec0;
    film_sample.legacy.rad0 = rad0;
    film_sample.legacy.k_spec = k_spec;
    film_write_sample(film_sample);
}
