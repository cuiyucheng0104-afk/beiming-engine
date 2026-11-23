// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：体积：大气透视、雾与介质），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// ------------------------------------------------------------------------------------------------
// The sky's aerial perspective (F_AERIAL): the atmosphere between a viewer and a surface. Its extinction is the
// SkyAtmosphere's own (sky.rs Atmosphere::earth): Rayleigh 5.8 / 13.6 / 33.1 per 1000 km and Mie 4.0 x scale + 0.44 per
// 1000 km at sea level (y = 0), thinning with scale heights of 8 km and 1.2 km, times P.aerial.x. The light it
// scatters toward the viewer is taken as the sky's own radiance at the horizon in the ray's direction, (1 - T) of it:
// a horizontal ray through the same air ends on that horizon, so far land fades into the sky behind it.
fn aerial_od(y0: f32, dy: f32, t: f32, h: f32) -> f32 {
    // the integral of exp(-(y0 + dy s) / h) over s < t
    let a = exp(-max(y0, -500.0) / h);
    let k = dy / h;
    if (abs(k * t) < 1e-4) { return a * t; }
    return a * (1.0 - exp(clamp(-k * t, -80.0, 80.0))) / k;
}

fn aerial_tr(o: vec3<f32>, d: vec3<f32>, t: f32) -> vec3<f32> {
    let rayleigh = vec3<f32>(5.802e-6, 13.558e-6, 33.1e-6) * P.aerial.y;
    let mie = 3.996e-6 * P.aerial.z + 0.444e-6;
    return exp(-P.aerial.x * (rayleigh * aerial_od(o.y, d.y, t, 8000.0) + mie * aerial_od(o.y, d.y, t, 1200.0)));
}

// The sky a little above the horizon (2.3 degrees: clear of the baked sky's fade to its black lower half), or where
// the ray points if higher: the haze's light, and what camera rays see of the sky near the horizon with F_AERIAL, so
// that the hazed land meets the sky without the fade's dark seam.
fn aerial_light(d: vec3<f32>) -> vec3<f32> {
    return env_radiance(normalize(vec3<f32>(d.x, max(d.y, 0.04), d.z)));
}

// Exponential height fog: extinction density * exp(-falloff * (y - height)).

fn fog_base(o: vec3<f32>, d: vec3<f32>, t0: f32) -> f32 {
    return P.fog.x * exp(clamp(-P.fog.y * (o.y + d.y * t0 - P.fog.z), -80.0, 80.0));
}

// Optical depth along o + d t, t in [t0, t1].
fn fog_depth(o: vec3<f32>, d: vec3<f32>, t0: f32, t1: f32) -> f32 {
    let len = t1 - t0;
    if (len <= 0.0) { return 0.0; }
    let a = fog_base(o, d, t0);
    let k = P.fog.y * d.y;
    if (abs(k * len) < 1e-4) { return a * len; }
    return a * (1.0 - exp(clamp(-k * len, -80.0, 80.0))) / k;
}

// Single scattering along a camera ray segment: one distance sampled by optical depth, then lights (RIS), one
// emissive point and the directional lights, each with a shadow ray. `tr` = segment transmittance.
fn fog_scatter(o: vec3<f32>, d: vec3<f32>, t0: f32, t1: f32, tr: f32, rd: u32) -> vec3<f32> {
    let r2 = rng2(rd);
    let pe = 1.0 - tr;
    if (pe < 1e-4) { return vec3<f32>(0.0); }
    let tau = -log(max(1.0 - r2.x * pe, 1e-8));
    let a = fog_base(o, d, t0) * max(P.vol.z, 1e-3);
    let k = P.fog.y * d.y;
    var t = tau / max(a, 1e-12);
    if (abs(k) > 1e-6) { t = -log(max(1.0 - tau * k / a, 1e-8)) / k; }
    let x = o + d * (t0 + clamp(t, 0.0, t1 - t0));
    var ls = vec3<f32>(0.0);
    for (var i = 0u; i < P.counts2.x; i++) {
        let li = light_at(i);
        let l = -li.dir.xyz;
        if (all(li.color.rgb <= vec3<f32>(0.0))) { continue; } // black: no shadow ray (direct_light)
        let vis = light_vis(li.ext.w >= 0.5, x, l, INF, rng_sub(rd, 0x30u + i));
        if (any(vis > vec3<f32>(0.0))) { ls += li.color.rgb * hg_phase(P.vol.y, dot(l, d)) * li.x.x * tr3(vis); }
    }
    // One shadow ray: either the local lights (RIS) or one emissive point, chosen with equal odds when both exist.
    let has_l = P.counts.x > P.counts2.x;
    let has_e = P.counts.y > 0u;
    let both = has_l && has_e;
    let use_e = has_e && (!has_l || r2.y < 0.5);
    let wk = select(1.0, 2.0, both);
    if (use_e) {
        // Emitters picked by global power are mostly far away from a fog point: resample 4 candidates by their
        // unshadowed contribution here (RIS), one shadow ray for the winner.
        var wsum = 0.0;
        var pick: ES;
        var pick_t = 0.0;
        for (var c = 0u; c < 4u; c++) {
            state.legacy.mis_x = x;
            state.legacy.mis_n = vec3<f32>(0.0);
            let es = sample_emitter(x, vec3<f32>(0.0), rng_sub(rd, 0x10u + c));
            if (es.pdf_w <= 0.0) { continue; }
            let t = luminance(es.le) * hg_phase(P.vol.y, dot(es.l, d));
            let w = t / es.pdf_w;
            if (w <= 0.0) { continue; }
            wsum += w;
            if (rng1(rng_sub(rd, 0x20u + c)) * wsum < w) {
                pick = es;
                pick_t = t;
            }
        }
        if (pick_t > 0.0) {
            let vis = any_tr(x, pick.l, pick.dist * 0.999, rng_sub(rd, 0x40u));
            if (vis > 0.0) { ls += wk * pick.le * hg_phase(P.vol.y, dot(pick.l, d)) * (wsum / (4.0 * pick_t)) * tr1(vis); }
        }
    } else if (has_l) {
        // 北冥：local_lights 改成收着色点；雾里的散射点没有表面，传一个全 0 的（`vol` 为真时不读它）
        var dummy_sd: ShadingPoint;
        ls += wk * local_lights(dummy_sd, x, x, true, d, rng_sub(rd, 0x50u));
    }
    return P.vol.x * P.vol2.rgb * pe * ls;
}

// ------------------------------------------------------------------------------------------------
// Bounded participating media (F_MEDIA): `VolumeMesh` nodes, a box or sphere each, whose volume function gives
// extinction, albedo and emission at a point (docs/MATERIAL_FUNCTIONS.md, "Volume functions"). Paths sample them by
// delta tracking, shadow rays by ratio tracking (Novák et al. 2018); single and multiple scattering, emission.

struct VIn {
    p: vec3<f32>,      // world position, m
    lp: vec3<f32>,     // position in the volume's own space: the box [-0.5, 0.5]^3 / the sphere of radius 0.5
    time: f32,         // scene time, s
    custom: vec4<f32>, // the node's customData
    grid: vec2<u32>, // the node's density grid: its first layer in the atlas, its cells (10 bits an axis; 0: none)
};

struct VOut {
    extinction: f32,    // 1/m (clamped to the volume's majorant)
    albedo: vec3<f32>,  // scattering / extinction
    emission: vec3<f32>, // emitted radiance per metre (absorption x emitted radiance)
};

// The node's density grid at `lp` (the volume's own space, the box [-0.5, 0.5]^3): field A's four numbers, trilinear
// between cell centres, the border cells' beyond them; zeros for a node without a grid.
fn vgrid(i: VIn, lp: vec3<f32>) -> vec4<f32> {
    if (i.grid.y == 0u) { return vec4<f32>(0.0); }
    let n = vec3<f32>(vec3<u32>(i.grid.y & 1023u, (i.grid.y >> 10u) & 1023u, (i.grid.y >> 20u) & 1023u));
    let c = clamp((lp + 0.5) * n, vec3<f32>(0.5), n - 0.5) + vec3<f32>(0.0, 0.0, f32(i.grid.x));
    return textureSampleLevel(grid_tex, samp, c / vec3<f32>(textureDimensions(grid_tex)), 0.0);
}

// @volume-functions-begin
fn volume_function(f: u32, i: VIn, p: array<vec4<f32>, 8>) -> VOut { return VOut(0.0, vec3<f32>(1.0), vec3<f32>(0.0)); }
// @volume-functions-end

fn medium_local(m: Medium, x: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(dot(m.w0.xyz, x) + m.w0.w, dot(m.w1.xyz, x) + m.w1.w, dot(m.w2.xyz, x) + m.w2.w);
}

// The ray's (o + d t) parameter interval inside medium m (x > y: it misses).
fn medium_span(m: Medium, o: vec3<f32>, d: vec3<f32>) -> vec2<f32> {
    let lo = medium_local(m, o);
    let ld = vec3<f32>(dot(m.w0.xyz, d), dot(m.w1.xyz, d), dot(m.w2.xyz, d));
    // (Its node hidden: scene.rs MEDIUM_HIDDEN. No ray crosses it.)
    if (m.a.y >= 2u) { return vec2<f32>(1.0, 0.0); }
    if (m.a.y == 1u) {
        let a = dot(ld, ld);
        let b = dot(lo, ld);
        let disc = b * b - a * (dot(lo, lo) - 0.25);
        if (disc < 0.0 || a <= 0.0) { return vec2<f32>(1.0, 0.0); }
        let r = sqrt(disc);
        return vec2<f32>((-b - r) / a, (-b + r) / a);
    }
    let inv = 1.0 / select(ld, vec3<f32>(1e-20), abs(ld) < vec3<f32>(1e-20));
    let ta = (vec3<f32>(-0.5) - lo) * inv;
    let tb = (vec3<f32>(0.5) - lo) * inv;
    let lo_t = min(ta, tb);
    let hi_t = max(ta, tb);
    return vec2<f32>(max(max(lo_t.x, lo_t.y), lo_t.z), min(min(hi_t.x, hi_t.y), hi_t.z));
}

fn medium_eval(k: u32, x: vec3<f32>) -> VOut {
    let m = medium_at(k);
    var i: VIn;
    i.p = x;
    i.lp = medium_local(m, x);
    i.time = P.time.x;
    i.custom = m.c;
    i.grid = vec2<u32>(bitcast<u32>(m.b.z), bitcast<u32>(m.b.w));
    var r = volume_function(m.a.x, i, m.p);
    r.extinction = clamp(r.extinction, 0.0, m.b.x);
    return r;
}

struct Track { t: f32, albedo: vec3<f32>, g: f32, emission: vec3<f32> };

// Delta tracking along o + d t, t < tmax: the first real collision (t < 0: none) with its albedo and HG anisotropy,
// and the emission met on the way (emission / majorant at every tentative collision). The ray is taken a stretch at
// a time, between the points where it enters or leaves a medium: in each the media it is in are one medium, their
// majorants and their coefficients summed (media may overlap). A collision is one of theirs, by extinction.
// (Until 2026-11-13 each medium was tracked whole, in the order the ray entered them: a collision in the first hid
// what a medium inside it emitted or scattered before that point: a fire inside smoke was drawn behind the smoke.)
fn media_track(o: vec3<f32>, d: vec3<f32>, tmax: f32, rd: u32) -> Track {
    var stp = 0u;
    var r = Track(-1.0, vec3<f32>(1.0), 0.0, vec3<f32>(0.0));
    let n = min(u32(P.time.w), 32u);
    var t = 0.0;
    for (var s = 0u; s <= 2u * n; s++) {
        var mask = 0u;
        var mj = 0.0;
        var end = tmax;
        for (var k = 0u; k < n; k++) {
            let sp = medium_span(medium_at(k), o, d);
            let a = max(sp.x, 0.0);
            let b = min(sp.y, tmax);
            if (a >= b) { continue; }
            if (a > t) {
                end = min(end, a);
            } else if (b > t) {
                mask |= 1u << k;
                mj += medium_at(k).b.x;
                end = min(end, b);
            }
        }
        if (mask != 0u && mj > 0.0) {
            loop {
                let r3 = rng_hash3(rng_sub(rd, stp));
                stp++;
                t -= log(1.0 - r3.x) / mj;
                if (t >= end) { break; }
                var st = 0.0;
                var em = vec3<f32>(0.0);
                for (var k = 0u; k < n; k++) {
                    if (((mask >> k) & 1u) == 0u) { continue; }
                    let v = medium_eval(k, o + d * t);
                    st += v.extinction;
                    em += v.emission;
                    // The medium a collision here is in: each by its extinction (the first without a draw).
                    if (v.extinction > 0.0 && (st <= v.extinction || rng_hash(rng_sub(rng_sub(rd, stp), k), 0u) * st < v.extinction)) {
                        r.albedo = v.albedo;
                        r.g = medium_at(k).b.y;
                    }
                }
                r.emission += em / mj;
                if (r3.z * mj < st) {
                    r.t = t;
                    return r;
                }
            }
        }
        if (end >= tmax) { break; }
        t = end;
    }
    r.albedo = vec3<f32>(1.0);
    r.g = 0.0;
    return r;
}

// Transmittance through the media along o + d t, t < tmax (ratio tracking; an unbiased estimate).
fn media_tr(o: vec3<f32>, d: vec3<f32>, tmax: f32, rd: u32) -> f32 {
    var tr = 1.0;
    let n = min(u32(P.time.w), 32u);
    for (var k = 0u; k < n; k++) {
        let sp = medium_span(medium_at(k), o, d);
        let b = min(sp.y, tmax);
        let mj = medium_at(k).b.x;
        if (max(sp.x, 0.0) >= b || mj <= 0.0) { continue; }
        var t = max(sp.x, 0.0);
        var step = 0u;
        loop {
            t -= log(1.0 - rng_hash(rng_sub(rd, (k << 24u) + step), 0u)) / mj;
            step++;
            if (t >= b) { break; }
            tr *= 1.0 - medium_eval(k, o + d * t).extinction / mj;
            if (tr < 1e-4) { return 0.0; }
        }
    }
    return tr;
}

// A direction scattered from `d` by the Henyey-Greenstein phase function (its pdf: hg_phase(g, dot(d, result))).
fn sample_hg(d: vec3<f32>, g: f32) -> vec3<f32> {
    let r = rng2(rng_dim(D_PHASE));
    let u = r.x;
    var ct = 1.0 - 2.0 * u;
    if (abs(g) > 1e-3) {
        let q = (1.0 - g * g) / (1.0 - g + 2.0 * g * u);
        ct = (1.0 + g * g - q * q) / (2.0 * g);
    }
    let st = sqrt(max(0.0, 1.0 - ct * ct));
    let phi = 2.0 * PI * r.y;
    return basis(d) * vec3<f32>(st * cos(phi), st * sin(phi), ct);
}

// Direct light scattered at x along a path travelling in direction d (phase function HG g; shadow rays through the
// media), MIS against phase sampling where the light can also be hit: directional disks, emitters, the environment.
fn phase_direct(x: vec3<f32>, d: vec3<f32>, g: f32, rd: u32) -> vec3<f32> {
    var sum = vec3<f32>(0.0);
    for (var i = 0u; i < P.counts2.x; i++) {
        let li = light_at(i);
        let cos_max = li.dir.w;
        let u = rng2(rng_sub(rd, i));
        let cos_t = 1.0 - u.x * (1.0 - cos_max);
        let sin_t = sqrt(max(0.0, 1.0 - cos_t * cos_t));
        let phi = 2.0 * PI * u.y;
        let l = basis(-li.dir.xyz) * vec3<f32>(sin_t * cos(phi), sin_t * sin(phi), cos_t);
        if (all(li.color.rgb <= vec3<f32>(0.0))) { continue; } // black: no shadow ray (direct_light)
        let ph = hg_phase(g, dot(l, d));
        let vis = light_vis(li.ext.w >= 0.5, x, l, INF, rng_sub(rd, 0x100u + i));
        if (any(vis > vec3<f32>(0.0))) {
            sum += li.color.rgb * tr3(vis) * ph * power_heuristic(1.0 / (2.0 * PI * (1.0 - cos_max)), ph);
        }
    }
    let nd = P.counts2.x;
    let nl = P.counts.x - nd;
    if (nl > 0u) {
        var wsum = 0.0;
        var pick = 0u;
        var pick_w = 0.0;
        var pick_ls: LS;
        for (var k = 0u; k < 3u; k++) {
            let r4 = rng4(rng_sub(rd, 0x200u + k));
            let idx = nd + min(u32(r4.x * f32(nl)), nl - 1u);
            let ls = local_light(light_at(idx), x, r4.yz);
            let wk = luminance(ls.c) * hg_phase(g, dot(ls.l, d));
            if (wk <= 0.0) { continue; }
            wsum += wk;
            if (r4.w * wsum < wk) {
                pick = idx;
                pick_w = wk;
                pick_ls = ls;
            }
        }
        if (pick_w > 0.0) {
            let vis = light_vis(light_at(pick).ext.w >= 0.5, x, pick_ls.sl, pick_ls.dist * 0.999, rng_sub(rd, 0x300u));
            if (any(vis > vec3<f32>(0.0))) { sum += pick_ls.c * tr3(vis) * hg_phase(g, dot(pick_ls.l, d)) * (wsum * f32(nl) / (3.0 * pick_w)); }
        }
    }
    if (P.counts.y > 0u) {
        state.legacy.mis_x = x;
        state.legacy.mis_n = vec3<f32>(0.0);
        let es = sample_emitter(x, vec3<f32>(0.0), rng_sub(rd, 0x400u));
        if (es.pdf_w > 0.0) {
            let vis = any_tr(x, es.l, es.dist * 0.999, rng_sub(rd, 0x401u));
            if (vis > 0.0) {
                let ph = hg_phase(g, dot(es.l, d));
                sum += es.le * ph * power_heuristic(es.pdf_w, ph) * es.w * tr1(vis);
            }
        }
    }
    if (P.counts2.y != 0u && (P.env.x > 0.5 || luminance(P.sky_color.rgb) > 0.0)) {
        let l = sample_env(rng_sub(rd, 0x500u));
        let pdf_e = env_pdf(l);
        if (pdf_e > 0.0) {
            let vis = sky_tr(x, l, rng_sub(rd, 0x501u));
            if (any(vis > vec3<f32>(0.0))) {
                let ph = hg_phase(g, dot(l, d));
                sum += env_radiance(l) * ph * power_heuristic(pdf_e, ph) / pdf_e * tr3(vis);
            }
        }
    }
    return sum;
}
