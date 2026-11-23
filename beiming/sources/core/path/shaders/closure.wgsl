// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：闭包），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// ------------------------------------------------------------------------------------------------
// BSDF (UE DefaultLit)

fn energy_lookup(roughness: f32, nov: f32) -> vec2<f32> {
    let x = clamp(nov * 31.0, 0.0, 31.0);
    let y = clamp(roughness * 31.0, 0.0, 31.0);
    let x0 = u32(floor(x)); let y0 = u32(floor(y));
    let x1 = min(x0 + 1u, 31u); let y1 = min(y0 + 1u, 31u);
    let fx = x - f32(x0); let fy = y - f32(y0);
    let a = mix(lut(x0, y0), lut(x1, y0), fx);
    let b = mix(lut(x0, y1), lut(x1, y1), fx);
    return mix(a, b, fy);
}

fn lut(x: u32, y: u32) -> vec2<f32> {
    let i = y * 32u + x;
    let v = energy_at(i / 2u);
    return select(v.xy, v.zw, (i & 1u) == 1u);
}

// Base layer: diffuse + GGX specular (e_spec: the specular's directional albedo; kd: what it leaves the diffuse
// under it; p_spec: the specular share of the base's samples). Over it a clearcoat (GGX, F0 0.04; the base gets what
// the coat's directional albedo e_coat lets through). Glass: a share of the base is a dielectric interface (below,
// "The dielectric"), the rest keeps the diffuse and the specular. p_coat / p_trans: the coat's and the dielectric's
// shares of all samples.
struct Lobes {
    diffuse: vec3<f32>, f0: vec3<f32>, f90: vec3<f32>, w: vec3<f32>, e_spec: vec3<f32>, kd: vec3<f32>, a2: f32, p_spec: f32,
    coat: f32, coat_alpha: f32, e_coat: f32, p_coat: f32, tint: vec3<f32>, p_trans: f32,
    // The dielectric: its share of the base under the coat x its energy compensation (reflection's factor), `tint`
    // the same x the base colour (transmission's); n(far side) / n(view side); whether its transmission has a density;
    // its directional reflection albedo (before the coat).
    t: f32, eta: f32, rough_t: bool, e_glass: f32,
    // 北冥：基础高光层走 Cycles 移植的金属闭包（bm_eval）
    bm: bool,
};

// ------------------------------------------------------------------------------------------------
// The dielectric (glass): a rough interface between two indices of refraction, Walter et al. 2007 (GGX): light
// reflects off a microfacet or refracts through it by the Fresnel reflectance there, exact (total internal
// reflection is reflection, untinted). Both have a value and a density, so lights are sampled through frosted glass
// and weighed against the BSDF's rays. Below GLASS_DELTA its transmission is a delta lobe (a clear pane: what lies
// behind is seen straight, `through` in the path loop); its reflection keeps the microfacet lobe. Single scattering
// loses energy as the roughness grows (leaving glass at 0.6: a quarter); the whole is scaled by 1 / (R + T) from a
// table (Turquin 2019, as Cycles), P.misc.z of it.
// Not here: the radiance scaling by the indices' ratio squared (as Cycles and glTF's formula: it cancels over a
// closed solid, and a single-sheet pane, which refracts as a solid here, would be scaled once); thin walls;
// absorption by distance.
const GLASS_DELTA: f32 = 0.05; // roughness (RTXPT 0.04, Falcor 0.08)

// Unpolarised Fresnel reflectance: `c` the cosine on the incident side, `eta` = n(far) / n(incident); 1 at total
// internal reflection (Walter eq. 22).
fn fresnel_dielectric(c: f32, eta: f32) -> f32 {
    let g2 = eta * eta - 1.0 + c * c;
    if (g2 <= 0.0) { return 1.0; }
    let g = sqrt(g2);
    let a = (g - c) / (g + c);
    let b = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
    return 0.5 * a * a * (1.0 + b * b);
}

// Smith's Lambda (GGX) at |cosine| c: g1 = 1 / (1 + Lambda).
fn lambda_ggx(a2: f32, c: f32) -> f32 {
    let c2 = c * c;
    return 0.5 * (sqrt(1.0 + a2 * (1.0 - c2) / max(c2, 1e-8)) - 1.0);
}

// The glass energy table (lib.rs `glass_energy_lut`, `GLASS_E`): R + T of the interface at GLASS_E_MU nodes over
// sqrt(cos), GLASS_E_ROUGH over the roughness, GLASS_E_IOR over sqrt((ior - 1) / (ior + 1)) up to GLASS_E_ZMAX
// (ior 3); entering, then leaving.
const GLASS_E_MU: u32 = 16u;
const GLASS_E_ROUGH: u32 = 16u;
const GLASS_E_IOR: u32 = 8u;
const GLASS_E_ZMAX: f32 = 0.70710678;
// (A select chain: the vec4 indexed by a variable cost the glass scene's trace 1.5 %.)
fn glass_e_at(i: u32) -> f32 {
    let v = glass_energy_at(i / 4u);
    let k = i & 3u;
    return select(select(v.x, v.y, k == 1u), select(v.z, v.w, k == 3u), k >= 2u);
}
// One (roughness, ior, side) row of it at x, between the nodes.
fn glass_e_row(row: u32, x: f32) -> f32 {
    let x0 = u32(x);
    return mix(glass_e_at(row * GLASS_E_MU + x0), glass_e_at(row * GLASS_E_MU + min(x0 + 1u, GLASS_E_MU - 1u)), x - f32(x0));
}
fn glass_energy(nov: f32, roughness: f32, ior: f32, leaving: bool) -> f32 {
    let x = clamp(sqrt(nov), 0.0, 1.0) * f32(GLASS_E_MU - 1u);
    let y = clamp(roughness, 0.0, 1.0) * f32(GLASS_E_ROUGH - 1u);
    let z = clamp(sqrt(max(ior - 1.0, 0.0) / (ior + 1.0)) / GLASS_E_ZMAX, 0.0, 1.0) * f32(GLASS_E_IOR - 1u);
    let y0 = u32(y);
    let y1 = min(y0 + 1u, GLASS_E_ROUGH - 1u);
    let z0 = select(0u, GLASS_E_IOR, leaving) + u32(z);
    let z1 = select(0u, GLASS_E_IOR, leaving) + min(u32(z) + 1u, GLASS_E_IOR - 1u);
    let e0 = mix(glass_e_row(z0 * GLASS_E_ROUGH + y0, x), glass_e_row(z0 * GLASS_E_ROUGH + y1, x), y - f32(y0));
    let e1 = mix(glass_e_row(z1 * GLASS_E_ROUGH + y0, x), glass_e_row(z1 * GLASS_E_ROUGH + y1, x), y - f32(y0));
    return mix(e0, e1, z - floor(z));
}

// Whether lights on both sides of the surface reach it: rough glass.
fn two_sided(lb: Lobes) -> bool { return has(F_GLASS) && lb.rough_t; }

// The dielectric's transmission toward l (the far side; nov, nol: |cosines|) x |n.l|: Walter eq. 21 from the view
// side. `h` = the microfacet normal that refracts v to l, on the shading normal's side.
fn dielectric_t(s: Surface, lb: Lobes, v: vec3<f32>, l: vec3<f32>, nov: f32, nol: f32) -> vec3<f32> {
    if (!lb.rough_t) { return vec3<f32>(0.0); }
    var h = normalize(v + lb.eta * l);
    if (dot(h, s.n) < 0.0) { h = -h; }
    let voh = dot(v, h);
    let loh = dot(l, h);
    if (voh <= 0.0 || loh >= 0.0) { return vec3<f32>(0.0); }
    let den = voh + lb.eta * loh;
    let g2 = 1.0 / (1.0 + lambda_ggx(lb.a2, nov) + lambda_ggx(lb.a2, nol));
    return lb.tint * ((1.0 - fresnel_dielectric(voh, lb.eta)) * d_ggx(lb.a2, max(dot(s.n, h), 0.0)) * g2 * voh * lb.eta * lb.eta * -loh / (nov * max(den * den, 1e-12)));
}

// Density of l under the dielectric's sampling (`sample_bsdf`: a visible microfacet normal, the ray reflected or
// refracted by the Fresnel reflectance there; at the shading normal's for smooth glass), x its share of the samples.
fn pdf_dielectric(s: Surface, lb: Lobes, v: vec3<f32>, l: vec3<f32>) -> f32 {
    let nov = max(dot(s.n, v), 1e-4);
    if (dot(s.n, l) > 0.0) {
        let h = normalize(v + l);
        let voh = max(dot(v, h), 1e-6);
        let f = fresnel_dielectric(select(nov, voh, lb.rough_t), lb.eta);
        return lb.p_trans * f * g1(lb.a2, nov) * d_ggx(lb.a2, max(dot(s.n, h), 0.0)) / (4.0 * nov);
    }
    if (!lb.rough_t) { return 0.0; }
    var h = normalize(v + lb.eta * l);
    if (dot(h, s.n) < 0.0) { h = -h; }
    let voh = dot(v, h);
    let loh = dot(l, h);
    if (voh <= 0.0 || loh >= 0.0) { return 0.0; }
    let den = voh + lb.eta * loh;
    return lb.p_trans * (1.0 - fresnel_dielectric(voh, lb.eta)) * g1(lb.a2, nov) * voh * d_ggx(lb.a2, max(dot(s.n, h), 0.0)) * lb.eta * lb.eta * -loh / (nov * max(den * den, 1e-12));
}

fn lobes(s: Surface, nov: f32) -> Lobes {
    var l: Lobes;
    let t = s.transmission * (1.0 - s.metallic);
    l.diffuse = s.base * (1.0 - s.metallic) * (1.0 - t);
    var f0 = 0.08 * s.specular;
    if (t > 0.0) {
        // Glass: F0 from the index of refraction.
        let r = (s.ior - 1.0) / (s.ior + 1.0);
        f0 = r * r;
    }
    l.f0 = mix(vec3<f32>(f0), s.base, s.metallic);
    l.bm = !LIVE && s.metallic >= 1.0;
    l.f90 = vec3<f32>(clamp(50.0 * l.f0.g, 0.0, 1.0));
    let e = energy_lookup(s.roughness, nov);
    // misc.z = multiple-scattering compensation amount (1 = energy conserving, matches the white furnace).
    l.w = 1.0 + P.misc.z * l.f0 * ((1.0 - e.x) / e.x);
    l.e_spec = l.w * (e.x * l.f0 + e.y * (l.f90 - l.f0));
    l.kd = 1.0 - l.e_spec;
    if (has(F_GLASS) && t > 0.0) {
        // The share that is not the dielectric keeps this specular lobe (the diffuse, 1 - t of it already, under it).
        l.w *= 1.0 - t;
        l.e_spec *= 1.0 - t;
    }
    let r = s.roughness;
    l.a2 = r * r * r * r;
    let ws = dot(l.e_spec, vec3<f32>(0.3, 0.6, 0.1));
    let wd = dot(l.diffuse * l.kd, vec3<f32>(0.3, 0.6, 0.1));
    l.p_spec = clamp(ws / max(ws + wd, 1e-6), 0.05, 1.0);
    if (wd <= 0.0) { l.p_spec = 1.0; }
    l.coat_alpha = 1.0;
    if (has(F_COAT) && s.coat > 0.0) {
        let ec = energy_lookup(s.coat_rough, nov);
        l.coat = s.coat;
        l.e_coat = s.coat * (ec.x * 0.04 + ec.y * 0.96);
        l.coat_alpha = s.coat_rough * s.coat_rough;
    }
    let under = 1.0 - l.e_coat;
    var wt = 0.0;
    if (has(F_GLASS) && t > 0.0) {
        l.eta = select(1.0 / s.ior, s.ior, s.front);
        l.rough_t = s.roughness > GLASS_DELTA && abs(s.ior - 1.0) > 1e-3;
        var comp = 1.0;
        if (l.rough_t) { comp = mix(1.0, 1.0 / glass_energy(nov, s.roughness, s.ior, !s.front), P.misc.z); }
        l.t = t * under * comp;
        l.tint = s.base * l.t;
        l.e_glass = t * fresnel_dielectric(nov, l.eta);
        wt = under * (l.e_glass + (t - l.e_glass) * dot(s.base, vec3<f32>(0.3, 0.6, 0.1)));
    }
    let total = (ws + wd) * under + l.e_coat + wt;
    l.p_coat = l.e_coat / max(total, 1e-6);
    l.p_trans = wt / max(total, 1e-6);
    return l;
}

fn d_ggx(a2: f32, noh: f32) -> f32 {
    let d = (noh * a2 - noh) * noh + 1.0;
    return a2 / (PI * d * d);
}

fn vis_smith_joint_approx(a2: f32, nov: f32, nol: f32) -> f32 {
    let a = sqrt(a2);
    let v = nol * (nov * (1.0 - a) + a);
    let l = nov * (nol * (1.0 - a) + a);
    return 0.5 / max(v + l, 1e-7);
}

fn f_schlick(f0: vec3<f32>, f90: vec3<f32>, voh: f32) -> vec3<f32> {
    let fc = pow(1.0 - voh, 5.0);
    return f0 + (f90 - f0) * fc;
}

// 北冥：金属（metallic = 1，只在离线路径里）的基础高光层是照 Cycles 移植的 GGX 金属闭包（../../shaders/microfacet.wgsl）：
// F82-tint 菲涅耳，底色当 F0，边缘色取白（B = 0）；alpha 照 Cycles 取 roughness 的平方；能量补偿 preserve_energy 由
// energyCompensation（P.misc.z，非 0 即开）开关。ThreeRT 原来的近似可见项、f90 与它自己的能量表在这条路上不参与。
// 闭包的建立要入射方向，Lobes 里只有 nov，所以在求值、密度、采样处现算。
fn bm_closure(s: Surface, v: vec3<f32>) -> F82TintSetup {
    return bsdf_microfacet_setup_fresnel_f82_tint(s.n, v, roughness_to_alpha(s.roughness), s.base, vec3<f32>(1.0), P.misc.z != 0.0);
}

// 求值（已含 cos(n, l)，乘了能量补偿的 darkening）与立体角概率密度
fn bm_eval(s: Surface, v: vec3<f32>, l: vec3<f32>) -> MicrofacetEval {
    let c = bm_closure(s, v);
    var e = bsdf_microfacet_ggx_eval(s.n, v, l, roughness_to_alpha(s.roughness), s.base, c.b, c.energy_scale);
    e.eval *= c.weight;
    return e;
}

// BSDF * NoL with the specular lobe scaled (per-light specular scale)
fn eval_bsdf_k(s: Surface, lb: Lobes, v: vec3<f32>, l: vec3<f32>, k: f32) -> vec3<f32> {
    let nol = dot(s.n, l);
    let nov = max(dot(s.n, v), 1e-4);
    if (two_sided(lb) && nol < 0.0 && dot(s.ng, l) < 0.0) {
        split_frac = vec3<f32>(1.0);
        return dielectric_t(s, lb, v, l, nov, -nol);
    }
    if (nol <= 0.0 || dot(s.ng, l) <= 0.0) { return vec3<f32>(0.0); }
    let h = normalize(v + l);
    let noh = max(dot(s.n, h), 0.0);
    let voh = max(dot(v, h), 0.0);
    let dv = d_ggx(lb.a2, noh) * vis_smith_joint_approx(lb.a2, nov, nol);
    var spec = dv * f_schlick(lb.f0, lb.f90, voh) * lb.w * k;
    if (lb.bm) { spec = bm_eval(s, v, l).eval / nol * k; }
    // (The dielectric's reflection: lb.t holds the coat's share already, so it joins after the coat's layering.)
    var glass = 0.0;
    if (has(F_GLASS) && lb.t > 0.0) { glass = lb.t * fresnel_dielectric(voh, lb.eta) * dv * k; }
    var diff = lb.diffuse * (1.0 / PI) * lb.kd;
    if (has(F_COAT) && lb.coat > 0.0) {
        let ca2 = lb.coat_alpha * lb.coat_alpha;
        let coat = d_ggx(ca2, noh) * vis_smith_joint_approx(ca2, nov, nol) * f_schlick(vec3<f32>(0.04), vec3<f32>(1.0), voh).x * lb.coat * k;
        diff *= 1.0 - lb.e_coat;
        spec = spec * (1.0 - lb.e_coat) + vec3<f32>(coat);
    }
    spec += vec3<f32>(glass);
    split_frac = spec / max(diff + spec, vec3<f32>(1e-12));
    return (diff + spec) * nol;
}

// BSDF * NoL
fn eval_bsdf(s: Surface, lb: Lobes, v: vec3<f32>, l: vec3<f32>) -> vec3<f32> {
    return eval_bsdf_k(s, lb, v, l, 1.0);
}

fn g1(a2: f32, nov: f32) -> f32 {
    return 2.0 * nov / (nov + sqrt(a2 + (1.0 - a2) * nov * nov));
}

fn pdf_bsdf(s: Surface, lb: Lobes, v: vec3<f32>, l: vec3<f32>) -> f32 {
    let nol = dot(s.n, l);
    var pg = 0.0;
    if (has(F_GLASS) && lb.p_trans > 0.0) { pg = pdf_dielectric(s, lb, v, l); }
    if (nol <= 0.0) { return pg; }
    let nov = max(dot(s.n, v), 1e-4);
    let h = normalize(v + l);
    let noh = max(dot(s.n, h), 0.0);
    let voh = max(dot(v, h), 1e-6);
    let dv = g1(lb.a2, nov) * voh * d_ggx(lb.a2, noh) / nov;
    var ps = dv / (4.0 * voh);
    if (lb.bm) { ps = bm_eval(s, v, l).pdf; }
    let pd = nol / PI;
    var pc = 0.0;
    if (has(F_COAT) && lb.coat > 0.0) {
        let ca2 = lb.coat_alpha * lb.coat_alpha;
        pc = g1(ca2, nov) * d_ggx(ca2, noh) / (4.0 * nov);
    }
    // (Smooth glass's transmission is a delta lobe, without a density: its samples only lower the others' share.)
    return pg + lb.p_coat * pc + (1.0 - lb.p_coat - lb.p_trans) * (lb.p_spec * ps + (1.0 - lb.p_spec) * pd);
}

// MIS weight of a light sample (solid-angle pdf `pdf_l`) against BSDF sampling. A_CUTOUT_PATHS: light that reached
// the sample through a cutout (`shadow_hole`) is light this vertex's BSDF ray cannot bring, a cutout being opaque to
// it, unless it is a specular or coat sample that keeps the path mirror-like (`mirror_path`). The sample takes the
// BSDF ray's weight for the rest: 1 - (the share of pdf_bsdf that still tests cutouts) x (the BSDF ray's weight).
// (Until 2026-11-15 the weight was the plain heuristic: under a card cut out everywhere a uniform sky lit a Lambert
// plane with 18 % of its light.)
fn light_mis(pdf_l: f32, s: Surface, lb: Lobes, v: vec3<f32>, l: vec3<f32>) -> f32 {
    if (nee_alone) { return 1.0; }
    let pb = pdf_bsdf(s, lb, v, l);
    let w = power_heuristic(pdf_l, pb);
    if (!approx(A_CUTOUT_PATHS) || !has(F_MASKED) || !shadow_hole) { return w; }
    var see = 0.0;
    if ((cur_depth == 0u || mirror_path) && s.roughness < MIRROR_ROUGHNESS && pb > 0.0) {
        // pdf_bsdf's specular and coat terms.
        let nov = max(dot(s.n, v), 1e-4);
        let h = normalize(v + l);
        let noh = max(dot(s.n, h), 0.0);
        var p = (1.0 - lb.p_coat - lb.p_trans) * lb.p_spec * g1(lb.a2, nov) * d_ggx(lb.a2, noh) / (4.0 * nov);
        if (lb.bm) { p = (1.0 - lb.p_coat - lb.p_trans) * lb.p_spec * bm_eval(s, v, l).pdf; }
        if (has(F_COAT) && lb.coat > 0.0) {
            let ca2 = lb.coat_alpha * lb.coat_alpha;
            p += lb.p_coat * g1(ca2, nov) * d_ggx(ca2, noh) / (4.0 * nov);
        }
        if (has(F_GLASS) && lb.p_trans > 0.0) { p += pdf_dielectric(s, lb, v, l); }
        see = min(p / pb, 1.0);
    }
    return 1.0 - see * (1.0 - w);
}

fn basis(n: vec3<f32>) -> mat3x3<f32> {
    let sgn = select(-1.0, 1.0, n.z >= 0.0);
    let a = -1.0 / (sgn + n.z);
    let b = n.x * n.y * a;
    let t = vec3<f32>(1.0 + sgn * n.x * n.x * a, sgn * b, -sgn * n.x);
    let bt = vec3<f32>(b, sgn + n.y * n.y * a, -n.y);
    return mat3x3<f32>(t, bt, n);
}

// Heitz 2018 VNDF sampling (isotropic), returns world-space half vector.
fn sample_vndf(v: vec3<f32>, tbn: mat3x3<f32>, alpha: f32, u1: f32, u2: f32) -> vec3<f32> {
    let vl = transpose(tbn) * v;
    let vh = normalize(vec3<f32>(alpha * vl.x, alpha * vl.y, vl.z));
    let lensq = vh.x * vh.x + vh.y * vh.y;
    let t1 = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-vh.y, vh.x, 0.0) / sqrt(lensq), lensq > 0.0);
    let t2 = cross(vh, t1);
    let r = sqrt(u1);
    let phi = 2.0 * PI * u2;
    let p1 = r * cos(phi);
    var p2 = r * sin(phi);
    let s = 0.5 * (1.0 + vh.z);
    p2 = (1.0 - s) * sqrt(1.0 - p1 * p1) + s * p2;
    let nh = p1 * t1 + p2 * t2 + sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2)) * vh;
    let hl = normalize(vec3<f32>(alpha * nh.x, alpha * nh.y, max(0.0, nh.z)));
    return tbn * hl;
}

// A direction by the BSDF's lobes (`pdf_bsdf` its density; which lobe: sampled_spec, sampled_trans). The zero vector:
// no sample (every value and density of it is 0).
fn sample_bsdf(s: Surface, lb: Lobes, v: vec3<f32>) -> vec3<f32> {
    let tbn = basis(s.n);
    let r = rng4(rng_dim(D_BSDF));
    sampled_trans = false;
    if (has(F_COAT) || has(F_GLASS)) {
        let u = r.x;
        if (u < lb.p_coat) {
            sampled_spec = true;
            return reflect(-v, sample_vndf(v, tbn, lb.coat_alpha, r.z, r.w));
        }
        if (u < lb.p_coat + lb.p_trans) {
            // The dielectric: a visible microfacet normal; reflected off it, or refracted through it (smooth glass:
            // through the shading normal), by the Fresnel reflectance there.
            let h = sample_vndf(v, tbn, s.roughness * s.roughness, r.z, r.w);
            var m = s.n;
            if (lb.rough_t) { m = h; }
            let t = refract(-v, m, 1.0 / lb.eta);
            sampled_spec = u - lb.p_coat < fresnel_dielectric(max(dot(v, m), 1e-4), lb.eta) * lb.p_trans || all(t == vec3<f32>(0.0));
            // A ray reflected under the surface, or refracted and still above it, is one the microfacets' masking
            // stops: no sample.
            if (sampled_spec) {
                let rl = reflect(-v, h);
                return select(rl, vec3<f32>(0.0), dot(rl, s.n) <= 0.0);
            }
            sampled_trans = true;
            return select(t, vec3<f32>(0.0), dot(t, s.n) >= 0.0);
        }
    }
    sampled_spec = r.y < lb.p_spec;
    if (sampled_spec && lb.bm) {
        let c = bm_closure(s, v);
        let m = bsdf_microfacet_ggx_sample(s.n, s.ng, v, roughness_to_alpha(s.roughness), s.base, c.b, c.energy_scale, r.zw);
        return select(vec3<f32>(0.0), m.wo, m.label != LABEL_NONE);
    }
    if (sampled_spec) {
        let h = sample_vndf(v, tbn, s.roughness * s.roughness, r.z, r.w);
        return reflect(-v, h);
    }
    let rr = sqrt(r.z);
    let phi = 2.0 * PI * r.w;
    return tbn * vec3<f32>(rr * cos(phi), rr * sin(phi), sqrt(max(0.0, 1.0 - rr * rr)));
}

// Density of l under the base specular lobe alone (VNDF sampling).
fn pdf_spec(s: Surface, lb: Lobes, v: vec3<f32>, l: vec3<f32>) -> f32 {
    let nov = max(dot(s.n, v), 1e-4);
    let noh = max(dot(s.n, normalize(v + l)), 0.0);
    if (lb.bm) { return bm_eval(s, v, l).pdf; }
    return g1(lb.a2, nov) * d_ggx(lb.a2, noh) / (4.0 * nov);
}
