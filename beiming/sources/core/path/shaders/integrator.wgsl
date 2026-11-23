// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：积分主循环），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// ------------------------------------------------------------------------------------------------
// RNG

// Path vertex index of the current shading point (cheaper procedural detail / fewer candidates past the first hit).
var<private> cur_depth: u32;
// Live "ray tracing off" (P.raster.w, LiveCore::rays): set once the camera's own ray has found its surface. From then
// on `trace` reports a miss, so nothing is shadowed, a bounce sees the sky and a mirror reflects the sky: what a
// rasterizer without shadow maps draws, on any GPU, from the same scene and the same shading. The switch is a uniform:
// no kernel is rebuilt to flip it.
var<private> rays_off: bool;
// The path so far is camera ray + mirror-like bounces (puddles, glass): surface detail is still visible.
var<private> mirror_path: bool;

// Shading points the camera sees, directly or in a mirror-like reflection (wet streets, glass): they get the exact
// light loop and resampled emitters, so reflections are as clean as what they reflect.
fn seen_directly() -> bool {
    return cur_depth == 0u || (cur_depth == 1u && mirror_path);
}
// Specular share of the last BSDF evaluation (per channel), the specular part of the direct light being summed, and
// whether the last BSDF sample took the specular lobe: the live denoiser filters diffuse and specular apart.
var<private> split_frac: vec3<f32>;
// Where the last vertex sampled emitters (its point and normal, 0 = none: fog): a BSDF ray's emitter hit weighs its MIS
// by the light tree's pmf there (emit_mis).
var<private> mis_x: vec3<f32>;
var<private> mis_n: vec3<f32>;
var<private> dl_spec: vec3<f32>;
// At camera hits, the direct light from directional lights (the sun: a tiny disk, so nearly deterministic) and its
// specular part: the live viewport keeps it in a signal of its own (no denoiser; short history while things change).
// Local lights stay in the denoised signals: their soft shadows are noisy, and on Kabukicho moving them here cost
// motion and static error (excess 1.71 / 1.86 / 2.20 -> 1.92 / 1.95 / 2.33, k = 1 SSIM 0.640 -> 0.620).
var<private> dl_det: vec3<f32>;
var<private> dl_det_spec: vec3<f32>;
var<private> sampled_spec: bool;
// The last BSDF sample went through the surface (glass: refraction, a delta lobe).
var<private> sampled_trans: bool;

// ------------------------------------------------------------------------------------------------

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let w = P.size.x;
    let h = P.size.y;
    if (gid.x >= w || gid.y >= h) { return; }
    let pix = gid.y * w + gid.x;
    if (has(F_LISTS)) { lt_fb = LT_NONE; }
    rng_start(gid.xy, P.size.z, P.size.w, 0u);
    cur_depth = 0u;
    // 北冥：相机光线。这一段留在 main 里：试过抽成单独的函数，Metal 上相机三个轴都不贴坐标轴的场景末位会变（运算次序），
    // 所以没有单独的相机文件。
    let cam = rng4(rng_dim(D_CAMERA));

    // (Every sample draws its own sub-pixel jitter.)
    var jx = cam.x;
    var jy = cam.y;
    let ndc = vec2<f32>((f32(gid.x) + jx) / f32(w) * 2.0 - 1.0, 1.0 - (f32(gid.y) + jy) / f32(h) * 2.0);
    var d = normalize(P.cam_fwd.xyz + P.cam_right.xyz * (ndc.x * P.cam_pos.w * P.cam_fwd.w) + P.cam_up.xyz * (ndc.y * P.cam_pos.w));
    var o = P.cam_pos.xyz;
    if (P.cam_right.w > 0.0) {
        let focus = o + d * (P.cam_up.w / dot(d, P.cam_fwd.xyz));
        let r = sqrt(cam.z) * P.cam_right.w;
        let phi = 2.0 * PI * cam.w;
        o += P.cam_right.xyz * (r * cos(phi)) + P.cam_up.xyz * (r * sin(phi));
        d = normalize(focus - o);
    }

    var radiance = vec3<f32>(0.0);
    var first_t = 0.0;
    var thr = vec3<f32>(1.0);
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
    var last_pdf = 0.0;
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
    dl_det = vec3<f32>(0.0);
    dl_det_spec = vec3<f32>(0.0);
    var specular_bounce = true;
    // Glass passed since the last scattering vertex: any (behind_glass), and whether an odd number of surfaces (bent).
    // The vertex's shadow rays toward emitters stopped at the glass and those toward the sky at bending glass, so
    // what the path finds there counts in full; behind glass that does not bend (a pane) the sky and the directional
    // lights' disks are weighed against the vertex's samples, which passed it (counted in full, they were counted
    // twice: a white furnace through water read 1.53).
    var behind_glass = false;
    var bent = false;
    // Only glass passed so far (straight through): what lies behind is seen directly, not clamped as indirect.
    var straight = true;
    let clamp_v = P.misc.x;
    // Ray cone (Akenine-Moller et al. 2019) for texture LOD: footprint width at the origin + spread angle.
    var cone_w = 0.0;
    var cone_a = 2.0 * P.cam_pos.w / lod_height();

    mirror_path = false;
    // 北冥：这一段射线是表面顶点按材质采样出来的（bm_rect_hits 要的就是这种）
    var bm_surf = false;
    for (var depth = 0u; depth <= P.counts.z; depth++) {
        cur_depth = depth;
        var hit: Hit;
        hit = trace(o, d, INF, TRACE_CLOSEST);
        // Ray tracing off: the camera ray above was the last one traced for this pixel.
        if (depth == 0u) { rays_off = LIVE && P.raster.w > 0.5; }
        if (has(F_FOG) && P.fog.x > 0.0) {
            // Height fog on every segment (attenuation + ambient inscattering); lit volumetric scattering on camera rays.
            let t0 = select(0.0, P.fog.w, depth == 0u);
            let t1 = select(hit.t, 2.0e4, hit.tri == 0xffffffffu);
            // Inside the volumetric range (camera rays) the medium is denser by the extinction scale (UE).
            var od = fog_depth(o, d, t0, t1);
            var tv = t1;
            var trv = 1.0;
            if (has(F_VOLUME) && depth == 0u && P.vol.x > 0.0) {
                tv = select(t1, min(t1, P.vol2.w), P.vol2.w > 0.0);
                let odv = fog_depth(o, d, t0, max(tv, t0));
                od += odv * (P.vol.z - 1.0);
                trv = exp(-odv * P.vol.z);
            }
            let tr = max(exp(-od), 1.0 - P.fog_color.w);
            // Interleaved over 8x4 tiles (one SIMD group each, so skipped tiles really idle), rotating per sample:
            // a quarter of the pixels at 4x weight; the low-frequency fog converges in the accumulation.
            if (has(F_VOLUME) && depth == 0u && P.vol.x > 0.0 && (((gid.x >> 3u) + 2u * (gid.y >> 2u) + pcg(P.size.z)) & VOL_RATE_MASK) == 0u) {
                // Firefly clamp: a fog point next to a bright sign is rare and huge; haze is a few nits.
                var fs = f32(VOL_RATE_MASK + 1u) * fog_scatter(o, d, t0, max(tv, t0), trv, rng_dim(D_FOG));
                let fl = luminance(fs);
                let fmax = 0.02 * clamp_v;
                if (fl > fmax) { fs *= fmax / fl; }
                radiance += thr * fs;
            }
            radiance += thr * (1.0 - tr) * P.fog_color.rgb;
            thr *= tr;
        }
        if (has(F_AERIAL) && hit.tri != 0xffffffffu) {
            let ta = aerial_tr(o, d, hit.t);
            let haze = thr * (1.0 - ta) * aerial_light(d);
            radiance += haze;
            // Live: the camera ray's haze is light the camera sees directly, not the surface's: it joins the emission
            // signal (left out of the diffuse one, which the denoiser divides by the albedo).
            if (depth == 0u) { e0 += haze; }
            thr *= ta;
        }
        // Paths track every medium.
        if (!LIVE && has(F_MEDIA) && P.time.w > 0.5) {
            // Media on this segment: emission on the way; a real collision scatters the path there.
            let tk = media_track(o, d, select(hit.t, 1.0e30, hit.tri == 0xffffffffu), rng_dim(D_MEDIA));
            radiance += thr * tk.emission;
            if (tk.t >= 0.0) {
                let x = o + d * tk.t;
                thr *= tk.albedo;
                if (depth == 0u) {
                    first_t = tk.t;
                    albedo = tk.albedo;
                    normal = -d;
                }
                var c = thr * phase_direct(x, d, tk.g, rng_dim(D_VOL_LIGHT));
                if (depth > 0u && !straight) {
                    let lum = luminance(c);
                    if (lum > clamp_v) { c *= clamp_v / lum; }
                }
                radiance += c;
                if (depth == P.counts.z) { break; }
                let nd = sample_hg(d, tk.g);
                last_pdf = hg_phase(tk.g, dot(nd, d));
                bm_surf = false;
                specular_bounce = false;
                behind_glass = false;
                bent = false;
                straight = false;
                mirror_path = false;
                cone_w += cone_a * tk.t;
                cone_a += 2.0;
                if (depth >= P.counts.w) {
                    let q = min(max(thr.x, max(thr.y, thr.z)), 0.95);
                    if (rng1(rng_dim(D_RR)) > q) { break; }
                    thr /= q;
                }
                o = x;
                d = nd;
                continue;
            }
        }
        if (!LIVE && bm_surf) {
            var c = thr * bm_rect_hits(o, d, select(hit.t, INF, hit.tri == 0xffffffffu), last_pdf);
            if (depth > 1u && !straight) {
                let lum = luminance(c);
                if (lum > clamp_v) { c *= clamp_v / lum; }
            }
            radiance += c;
        }
        if (hit.tri == 0xffffffffu) {
            var c = thr * sky_mis(d, select(0.0, last_pdf, depth > 0u && !bent));
            if (depth > 1u && !straight) {
                let lum = luminance(c);
                if (lum > clamp_v) { c *= clamp_v / lum; }
            }
            if (depth == 0u) { e0 += c; }
            if (depth == 1u && spec_lobe) { spec_t = 1.0e4; }
            radiance += c;
            break;
        }
        let width = cone_w + cone_a * hit.t;
        let s = surface(o, d, hit, width);
        if (depth == 0u) {
            first_t = hit.t;
            if (has(F_LISTS)) { lt_list_start(s.p + mv.xyz); }
            albedo = select(s.base, s.emissive / max(max(s.emissive.r, max(s.emissive.g, s.emissive.b)), 1e-6), s.card);
            normal = s.n;
            anim = s.anim;
            rough0 = s.roughness;
        }
        if (depth == 1u && spec_lobe) { spec_t = hit.t; }
        // Emission (one-sided for rect light cards)
        if (any(s.emissive > vec3<f32>(0.0)) && (s.front || !s.card)) {
            var wgt = 1.0;
            // Behind glass an emitter counts in full: shadow rays toward emitters stop at glass (emitter_tr).
            if (depth > 0u && !specular_bounce && !behind_glass) {
                wgt = emit_mis(hit, d, last_pdf);
            }
            var c = thr * s.emissive * wgt;
            if (depth > 1u && !straight) {
                let lum = luminance(c);
                if (lum > clamp_v) { c *= clamp_v / lum; }
            }
            if (depth == 0u) { e0 += c; }
            radiance += c;
        }
        if (s.card) { break; }
        @if(!last_direct && !last_sun) if (depth == P.counts.z) { break; }
        @if(last_sun && !last_direct) if (depth == P.counts.z) {
            // gpu.rs `KernelSwitches::last_sun`: the last vertex's light from the directional lights alone.
            if (depth > 0u) {
                var dz = thr * sun_light(s, lobes(s, max(dot(s.n, -d), 1e-4)), -d);
                let lum = luminance(dz);
                if (lum > clamp_v && !straight) { dz *= clamp_v / lum; }
                radiance += dz;
            }
            break;
        }
        @if(last_direct) if (depth == P.counts.z) {
            // gpu.rs `KernelSwitches::last_direct`: the last vertex's direct light.
            if (depth > 0u) {
                var dz = thr * direct_light(s, lobes(s, max(dot(s.n, -d), 1e-4)), -d);
                let lum = luminance(dz);
                if (lum > clamp_v && !straight) { dz *= clamp_v / lum; }
                radiance += dz;
            }
            break;
        }
        let v = -d;
        let nov = max(dot(s.n, v), 1e-4);
        let lb = lobes(s, nov);
        var dl = thr * direct_light(s, lb, v);
        if (depth > 0u && !straight) {
            let lum = luminance(dl);
            if (lum > clamp_v) { dl *= clamp_v / lum; }
        }
        radiance += dl;
        let l = sample_bsdf(s, lb, v);
        // Through smooth glass: a delta lobe (weight tint / its sampling share, no MIS: what lies behind counts in full).
        // Rough glass's transmission has a density like any lobe. Either way the live viewport files the light with
        // the specular, like a reflection.
        let through = has(F_GLASS) && sampled_trans && !lb.rough_t;
        var pdf = 0.0;
        var wgt = lb.tint / max(lb.p_trans, 1e-6);
        if (through) {
            split_frac = vec3<f32>(1.0);
        } else {
            pdf = pdf_bsdf(s, lb, v, l);
            wgt = eval_bsdf(s, lb, v, l) / max(pdf, 1e-20);
        }
        if (depth == 0u) {
            spec0 = thr * dl_spec;
            k_spec = split_frac;
            rad0 = radiance;
            split = true;
            spec_lobe = sampled_spec || sampled_trans;
            through0 = through;
            glass0 = has(F_GLASS) && s.transmission > 0.0;
            refl_e = lb.e_spec;
            if (sampled_spec && !through && lb.coat <= 0.0) {
                refl_l = l;
                refl_pdf = pdf_spec(s, lb, v, l);
                refl_w = wgt;
            }
        }
        if ((!through && pdf <= 0.0) || all(wgt <= vec3<f32>(0.0))) { break; }
        thr *= wgt;
        if (through && dot(l, s.ng) < 0.0) {
            behind_glass = true;
            bent = !bent;
        } else if (through) {
            // (A refracted direction the geometric normal keeps on this side: a specular vertex.)
            last_pdf = 0.0;
            specular_bounce = true;
            behind_glass = false;
            bent = false;
        } else {
            last_pdf = pdf;
            specular_bounce = false;
            behind_glass = false;
            bent = false;
        }
        straight = straight && through;
        bm_surf = !through;
        cone_w = width;
        cone_a += 2.0 * s.roughness * s.roughness;
        mirror_path = (depth == 0u || mirror_path) && s.roughness < MIRROR_ROUGHNESS && (sampled_spec || sampled_trans);
        if (depth >= P.counts.w) {
            let q = min(max(thr.x, max(thr.y, thr.z)), 0.95);
            if (rng1(rng_dim(D_RR)) > q) { break; }
            thr /= q;
        }
        o = offset_origin(s.p, select(s.ng, -s.ng, dot(l, s.ng) < 0.0));
        d = l;
    }

    if (non_finite(vec3<f32>(first_t))) { first_t = 0.0; }
    // 北冥：写进 accum 的那一段在 film.wgsl
    accum_write_sample(pix, radiance, albedo, normal, e0, spec0, split, rad0, k_spec);
}
