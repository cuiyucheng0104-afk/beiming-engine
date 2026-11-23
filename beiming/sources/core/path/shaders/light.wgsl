// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：灯光），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// Buckets of the emitter CDF's guide table (lib.rs EMITTER_GUIDE).
const EMITTER_GUIDE: u32 = 65536u;

fn emitter_guide(k: u32) -> u32 {
    return bitcast<u32>(emitter_at(P.counts.y + k / 4u)[k % 4u]);
}

// One emitter CDF entry: the first whose cumulative weight is not below u. The guide table bounds the binary search to
// u's bucket (u * EMITTER_GUIDE is exact for the 24-bit u), which holds the same entry a search over the whole CDF
// finds. Requires counts.y > 0.
fn emitter_pick_u(u: f32) -> vec4<f32> {
    let k = min(u32(u * f32(EMITTER_GUIDE)), EMITTER_GUIDE - 1u);
    var lo = emitter_guide(k);
    var hi = emitter_guide(k + 1u);
    while (lo < hi) {
        let mid = (lo + hi) / 2u;
        if (emitter_at(mid).y < u) { lo = mid + 1u; } else { hi = mid; }
    }
    return emitter_at(min(lo, P.counts.y - 1u));
}

// Light tree (ltree.rs): nodes after the CDF in `emitters`, one vec4 each: pack2x16float(centre x, y),
// pack2x16float(centre z, radius), power, child word (the left child, the right one follows it; or LT_LEAF |
// (count - 1) << 29 | its first entry). The tree's emitters come first in the CDF in leaf order, the moving ones after
// them (from entry P.ltree.y).
const LT_LEAF: u32 = 0x80000000u;
const LT_PATH_BITS: u32 = 26u;
// A_FAR_EMITTERS: tree nodes wholly farther than this (m) from the shading point are not proposed. A city's emitters
// are mostly that far from any one point: Tokyo's aerial view traces in 4.7 ms with the cut, 9.2 without.
const LT_FAR: f32 = 120.0;

fn lt_on() -> bool { return P.ltree.w > 0.5; }


// Importance of a tree node seen from x on a surface with normal n (n = 0: no hemisphere, a fog point): power x the
// best cosine any point of its sphere can have at x / max(distance², radius²).
fn lt_imp(nd: vec4<f32>, x: vec3<f32>, n: vec3<f32>) -> f32 {
    let cxy = unpack2x16float(bitcast<u32>(nd.x));
    let czr = unpack2x16float(bitcast<u32>(nd.y));
    let dv = vec3<f32>(cxy, czr.x) - x;
    let d2 = dot(dv, dv);
    let r2 = czr.y * czr.y;
    var cb = 1.0;
    if (d2 > r2 && dot(n, n) > 0.0) {
        let inv = inverseSqrt(d2);
        let cos_t = dot(n, dv) * inv;
        let sin_b = czr.y * inv;
        let cos_b = sqrt(max(1.0 - sin_b * sin_b, 0.0));
        if (cos_t < cos_b) {
            cb = max(cos_t * cos_b + sqrt(max(1.0 - cos_t * cos_t, 0.0)) * sin_b, 0.0);
        }
    }
    // A_FAR_EMITTERS: nodes wholly farther than LT_FAR from x are not proposed (their light comes by BSDF rays,
    // emit_mis weighs them 1): shadow rays across a city cost more than the light they find.
    if (approx(A_FAR_EMITTERS) && d2 > (LT_FAR + czr.y) * (LT_FAR + czr.y)) { return 0.0; }
    return nd.z * cb / max(d2, r2);
}

// A CDF entry by power within entries [lo, hi) (cumulative p0 .. p1): one guide-table lookup.
fn emitter_pick_range(lo: u32, hi: u32, r: f32) -> vec4<f32> {
    let p0 = select(0.0, emitter_at(max(lo, 1u) - 1u).y, lo > 0u);
    let p1 = emitter_at(hi - 1u).y;
    let u = min(p0 + r * (p1 - p0), p1);
    let k = min(u32(u * f32(EMITTER_GUIDE)), EMITTER_GUIDE - 1u);
    var l = emitter_guide(k);
    var h = emitter_guide(k + 1u);
    while (l < h) {
        let mid = (l + h) / 2u;
        if (emitter_at(mid).y < u) { l = mid + 1u; } else { h = mid; }
    }
    return emitter_at(clamp(l, lo, hi - 1u));
}

// An emitter entry for a point x (normal n), its selection probability `p` and its weight `w` (area x luminance x
// power, as the CDF weighs). With the tree: the moving emitters by power with probability P.ltree.z, else the tree
// descended by importance to a leaf, and one of its few entries by weight. Without it: the CDF entry (p = weight /
// total).
struct EPick { e: vec4<f32>, p: f32, w: f32 };

fn emitter_draw(x: vec3<f32>, n: vec3<f32>, rd: u32) -> EPick {
    let r3 = rng3(rd);
    if (!lt_on()) {
        let e = emitter_pick_u(r3.x);
        return EPick(e, e.z / P.misc.y, e.z);
    }
    if (r3.x < P.ltree.z) {
        let e = emitter_pick_range(bitcast<u32>(P.ltree.y), P.counts.y, r3.y);
        return EPick(e, e.z / P.misc.y, e.z);
    }
    var p = 1.0 - P.ltree.z;
    var u = r3.y;
    var w = bitcast<u32>(lt_node(0u).w);
    for (var k = 0u; k <= LT_PATH_BITS && (w & LT_LEAF) == 0u; k++) {
        let l = lt_node(w);
        let r = lt_node(w + 1u);
        let il = lt_imp(l, x, n);
        let ir = lt_imp(r, x, n);
        if (!(il + ir > 0.0)) { return EPick(vec4<f32>(0.0), 0.0, 0.0); }
        let pl = il / (il + ir);
        if (u < pl) { w = bitcast<u32>(l.w); p *= pl; u = u / pl; } else { w = bitcast<u32>(r.w); p *= 1.0 - pl; u = (u - pl) / (1.0 - pl); }
        u = clamp(u, 0.0, 0.99999994);
    }
    if ((w & LT_LEAF) == 0u) { return EPick(vec4<f32>(0.0), 0.0, 0.0); }
    let lo = w & 0x1fffffffu;
    let hi = lo + ((w >> 29u) & 3u) + 1u;
    var wsum = 0.0;
    for (var j = lo; j < hi; j++) { wsum += emitter_at(j).z; }
    var t = r3.z * wsum;
    var e = emitter_at(hi - 1u);
    for (var j = lo; j < hi; j++) {
        let c = emitter_at(j);
        if (t < c.z) { e = c; break; }
        t -= c.z;
    }
    return EPick(e, p * e.z / wsum, e.z);
}

// With the tree: the probability that emitter_draw(x, n) picks emitter `ei` (`em`; `a`: its attributes,
// `emitter_attrs`), the same choices down its path (its code; 0: picked by its share of power).
fn emitter_sel(ei: u32, em: EmitterTri, a: TriAttr, x: vec3<f32>, n: vec3<f32>) -> f32 {
    let code = em.code & ~EMITTER_MOVES;
    if (code == 0u) {
        if (P.misc.y <= 0.0) { return 0.0; }
        var area = 0.5 * length(cross(em.e1, em.e2));
        if (has(F_PEMIT) && a.x.z > 0.0) { area = a.x.z; }
        return luminance(material_at(bitcast<u32>(a.uv.w)).emissive.rgb) * obj_power(a) * area / P.misc.y;
    }
    let depth = (code >> LT_PATH_BITS) - 1u;
    var p = 1.0 - P.ltree.z;
    var w = bitcast<u32>(lt_node(0u).w);
    for (var k = 0u; k < depth; k++) {
        let l = lt_node(w);
        let r = lt_node(w + 1u);
        let il = lt_imp(l, x, n);
        let ir = lt_imp(r, x, n);
        if (!(il + ir > 0.0)) { return 0.0; }
        let right = (code >> k) & 1u;
        p *= select(il, ir, right == 1u) / (il + ir);
        w = bitcast<u32>(select(l.w, r.w, right == 1u));
    }
    let lo = w & 0x1fffffffu;
    let hi = lo + ((w >> 29u) & 3u) + 1u;
    var wsum = 0.0;
    var we = 0.0;
    for (var j = lo; j < hi; j++) {
        let c = emitter_at(j);
        wsum += c.z;
        if (bitcast<u32>(c.x) == ei) { we = c.z; }
    }
    return p * we / wsum;
}

// ------------------------------------------------------------------------------------------------
// Environment

fn env_uv(d: vec3<f32>) -> vec2<f32> {
    let u = atan2(d.x, -d.z) / (2.0 * PI) + 0.5;
    let v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    return vec2<f32>(u, v);
}

fn env_radiance(d: vec3<f32>) -> vec3<f32> {
    if (P.env.x < 0.5) { return P.sky_color.rgb; }
    return textureSampleLevel(env_tex, samp, env_uv(d), 0.0).rgb;
}

fn env_pdf(d: vec3<f32>) -> f32 {
    if (P.env.x < 0.5) { return 1.0 / (4.0 * PI); }
    let w = u32(P.env.y); let h = u32(P.env.z);
    let uv = env_uv(d);
    let x = min(u32(uv.x * f32(w)), w - 1u);
    let y = min(u32(uv.y * f32(h)), h - 1u);
    @if(!strict) let row_p = env_cdf_at(y) - select(0.0, env_cdf_at(y - 1u), y > 0u);
    @if(strict) let row_p = env_cdf_at(y) - select(0.0, env_cdf_at(max(y, 1u) - 1u), y > 0u);
    let base = h + y * w;
    @if(!strict) let col_p = env_cdf_at(base + x) - select(0.0, env_cdf_at(base + x - 1u), x > 0u);
    @if(strict) let col_p = env_cdf_at(base + x) - select(0.0, env_cdf_at(base + max(x, 1u) - 1u), x > 0u);
    let sin_t = sin((f32(y) + 0.5) / f32(h) * PI);
    return row_p * col_p * f32(w) * f32(h) / (2.0 * PI * PI * max(sin_t, 1e-4));
}

fn lower_bound(start: u32, count: u32, x: f32) -> u32 {
    var lo = 0u;
    var hi = count;
    while (lo < hi) {
        let mid = (lo + hi) / 2u;
        if (env_cdf_at(start + mid) < x) { lo = mid + 1u; } else { hi = mid; }
    }
    return min(lo, count - 1u);
}

fn sample_env(rd: u32) -> vec3<f32> {
    let u4 = rng4(rd);
    if (P.env.x < 0.5) {
        let z = 1.0 - 2.0 * u4.x;
        let r = sqrt(max(0.0, 1.0 - z * z));
        let phi = 2.0 * PI * u4.y;
        return vec3<f32>(r * cos(phi), z, r * sin(phi));
    }
    let w = u32(P.env.y); let h = u32(P.env.z);
    let y = lower_bound(0u, h, u4.x);
    let x = lower_bound(h + y * w, w, u4.y);
    let u = (f32(x) + u4.z) / f32(w);
    let v = (f32(y) + u4.w) / f32(h);
    let theta = v * PI;
    let phi = (u - 0.5) * 2.0 * PI;
    return vec3<f32>(sin(theta) * sin(phi), cos(theta), -sin(theta) * cos(phi));
}

// What a BSDF-sampled ray (solid-angle pdf `pdf`; 0 = the camera ray, no MIS) that left the scene brings back: the
// environment and the directional lights' disks, MIS-weighted against their sampling in `direct_light`.
fn sky_mis(d: vec3<f32>, pdf: f32) -> vec3<f32> {
    // three.js scene.background: what camera rays (and paths bent straight through glass) see where nothing is.
    if (has(F_BACKGROUND) && pdf <= 0.0) { return P.background.rgb; }
    var wgt = 1.0;
    if (pdf > 0.0 && P.counts2.y != 0u) {
        wgt = power_heuristic(pdf, env_pdf(d));
    }
    var c = env_radiance(d) * wgt;
    if (has(F_AERIAL) && pdf <= 0.0) { c = aerial_light(d); }
    if (pdf > 0.0) { c += sun_disks(d, pdf); }
    return c;
}

// The directional lights' disks a BSDF ray (pdf `pdf`) falls in, MIS-weighted against their cones' sampling.
fn sun_disks(d: vec3<f32>, pdf: f32) -> vec3<f32> {
    var c = vec3<f32>(0.0);
    for (var i = 0u; i < P.counts2.x; i++) {
        let li = light_at(i);
        if (dot(d, -li.dir.xyz) >= li.dir.w) {
            let omega = 2.0 * PI * (1.0 - li.dir.w);
            c += (li.color.rgb / omega) * power_heuristic(pdf, 1.0 / omega);
        }
    }
    return c;
}

// What light sampling reads of an emitter's attributes (UVs, material, object, texel density), as shading has them
// at a hit of it: its triangle's, with its instance's object and texture LOD offset if it has one. (Not the normals
// and the tangent, which stay the mesh's: a light sample reads none, and placing them is work a sample.)
fn emitter_attrs(em: EmitterTri) -> TriAttr {
    var a = attrs[em.tri];
    if (has(F_INST) && em.inst != NO_INST) { a.x = inst_x(instance_at(em.inst).info, a.x); }
    return a;
}

// MIS weight of emission that a BSDF-sampled ray (pdf `pdf`) hit, against emitter sampling in `direct_light`.
// Without sampled emitters (only material functions emit, e.g. facade windows) the BSDF ray is the only estimator.
// It weighs by emitted power alone, as emitter sampling's MIS does with or without light LOD (sample_emitter_ris).
fn emit_mis(hit: Hit, d: vec3<f32>, pdf: f32) -> f32 {
    // Procedural surfaces are not light-sampled (no emitter entries): the BSDF ray is the only estimator.
    if (is_proc(hit) || P.counts.y == 0u) { return 1.0; }
    // The hit triangle's emitter: its attributes' x.w is the entry + 1 (0: it is not light-sampled), counted from its
    // instance's first entry (the record's n2.w) when an instance places it.
    var entry = bitcast<u32>(attrs[hit.tri].x.w);
    if (entry == 0u) { return 1.0; }
    if (has(F_INST) && hit.inst != NO_INST) { entry += bitcast<u32>(instance_at(hit.inst).n2.w); }
    let em = emitter_tri_at(entry - 1u);
    let ha = emitter_attrs(em);
    let cr = cross(em.e1, em.e2);
    let area = 0.5 * length(cr);
    let cos_l = abs(dot(normalize(cr), d));
    if (lt_on()) {
        // The light tree's pmf where the ray left (the vertex that sampled emitters), per area of the hit triangle.
        let sel = emitter_sel(entry - 1u, em, ha, mis_x, mis_n);
        if (!(sel > 0.0)) { return 1.0; }
        return power_heuristic(pdf, sel / max(area, 1e-12) * hit.t * hit.t / max(cos_l, 1e-6));
    }
    if (P.misc.y <= 0.0 || emitter_culled(em)) { return 1.0; }
    let mat = material_at(bitcast<u32>(ha.uv.w));
    let pdf_a = luminance(mat.emissive.rgb) * obj_power(ha) / P.emit_power.x;
    let pdf_w = pdf_a * hit.t * hit.t / max(cos_l, 1e-6);
    if (!has(F_PEMIT) || ha.x.z == 0.0) { return power_heuristic(pdf, pdf_w); }
    // Particles (x.z > 0): a nominal area is what the CDF weighed them by, the point is uniform over the actual area.
    // (Those without one, x.z < 0, are not light-sampled: no entry.)
    return power_heuristic(pdf, pdf_w * ha.x.z / max(area, 1e-12));
}

// Light LOD factor of an emitter (lib.rs emitter_lod): the emitter CDF's weights carry it, so every pdf of an
// emitter point does too. Moving ones have none (lib.rs EmitterTri::moves).
fn emitter_lod(em: EmitterTri) -> f32 {
    if (P.light_lod.w <= 0.0 || (em.code & EMITTER_MOVES) != 0u) { return 1.0; }
    let c = em.v0 + (em.e1 + em.e2) / 3.0;
    let k = P.light_lod.w / max(distance(c, P.light_lod.xyz), P.light_lod.w);
    return k * k;
}

// Live: emitters farther than P.emit_power.y from the light LOD's reference are never proposed (lib.rs emitter_lod),
// so BSDF rays that hit them keep their whole light (emit_mis), unless they lie in the view cone (P.lod_view) within
// P.emit_power.z: those light what the camera sees. The same centroid and test as lib.rs EmitterCull::culls.
fn emitter_culled(em: EmitterTri) -> bool {
    if (P.emit_power.y <= 0.0 || P.light_lod.w <= 0.0) { return false; }
    if ((em.code & EMITTER_MOVES) != 0u) { return false; }
    let c = em.v0 + (em.e1 + em.e2) / 3.0;
    let d = distance(c, P.light_lod.xyz);
    if (d <= P.emit_power.y) { return false; }
    return !(d <= P.emit_power.z && dot(c - P.light_lod.xyz, P.lod_view.xyz) >= P.lod_view.w * d);
}

// ------------------------------------------------------------------------------------------------
// Direct lighting (NEE)

// pdf：北冥的矩形纯光的立体角概率密度，给多重重要性采样用；别的灯是 0（不做）
struct LS { c: vec3<f32>, l: vec3<f32>, sl: vec3<f32>, dist: f32, pdf: f32 };

// 北冥：矩形纯光（不画卡片的那种）在离线路径里走照 Cycles 移植的球面矩形采样（../../shaders/area_light.wgsl），并和材质采样
// 做多重重要性采样：光源一侧在 local_lights 里乘 light_mis，材质一侧见 bm_rect_hits（两边用同一对概率密度，权重和为 1）。
// 灯的参数换成 Cycles KernelLight 的写法：单位轴、全长、面积的倒数（大于 0 表示矩形）。
struct BmRect { u: vec3<f32>, len_u: f32, v: vec3<f32>, len_v: f32, invarea: f32 };

fn bm_rect(li: Light) -> BmRect {
    let hu = length(li.ext.xyz);
    let u = li.ext.xyz / hu;
    let len_u = 2.0 * hu;
    let len_v = 2.0 * li.dir.w;
    return BmRect(u, len_u, normalize(cross(li.dir.xyz, u)), len_v, 1.0 / (len_u * len_v));
}

// 灯沿 -l 射向着色点的辐亮度（还没乘 Cycles 的 eval_fac）。ThreeRT 的 color 是辐亮度（nits）；Cycles 的
// eval_fac = 1 / (π·面积) 把强度当总辐射通量，所以强度取 color·π·面积，乘上 eval_fac 正好是 color。
// 挡光板与衰减范围照 ThreeRT 原来的写法乘在辐亮度上，光源与材质两侧都乘。d2：着色点到灯上那一点的距离平方。
fn bm_rect_le(li: Light, r: BmRect, l: vec3<f32>, d2: f32) -> vec3<f32> {
    var k = PI / r.invarea * smoothstep(li.x.z - 0.04, li.x.z + 0.04, dot(li.dir.xyz, -l));
    let range = li.color.w;
    if (range > 0.0) {
        let q = d2 / (range * range);
        let win = clamp(1.0 - q * q, 0.0, 1.0);
        k *= win * win;
    }
    return li.color.rgb * k;
}

// 从 x 采样矩形纯光：c = 辐亮度 × eval_fac / 立体角概率密度（接收端的 BSDF·cos 由调用方乘）
fn bm_rect_sample(li: Light, x: vec3<f32>, u: vec2<f32>) -> LS {
    let r = bm_rect(li);
    let ls = area_light_sample(u, x, li.pos.xyz, r.u, r.len_u, r.v, r.len_v, li.dir.xyz, r.invarea);
    if (!ls.ok || !(ls.pdf > 0.0)) { return LS(vec3<f32>(0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), 0.0, 0.0); }
    return LS(bm_rect_le(li, r, ls.D, ls.t * ls.t) * (ls.eval_fac / ls.pdf), ls.D, ls.D, ls.t, ls.pdf);
}

// 表面顶点按材质采样的射线 (o, d)（立体角概率密度 pdf_b）在 t_hit 之前打到的矩形纯光，按多重重要性采样加权。
// 灯不挡光，射线照常往前走；不投影的灯在光源一侧不查遮挡，这一侧也不查。
fn bm_rect_hits(o: vec3<f32>, d: vec3<f32>, t_hit: f32, pdf_b: f32) -> vec3<f32> {
    var c = vec3<f32>(0.0);
    for (var i = P.counts2.x; i < P.counts.x; i++) {
        let li = light_at(i);
        if (u32(li.pos.w) != 3u || all(li.color.rgb <= vec3<f32>(0.0))) { continue; }
        let r = bm_rect(li);
        let h = area_light_intersect(o, d, 0.0, select(t_hit, INF, li.ext.w < 0.5), li.pos.xyz, r.u, r.len_u, r.v, r.len_v, li.dir.xyz, r.invarea);
        if (!h.hit) { continue; }
        let e = area_light_eval_from_intersection(o, d, h.t, li.pos.xyz, r.u, r.len_u, r.v, r.len_v, li.dir.xyz, r.invarea);
        if (!(e.pdf > 0.0)) { continue; }
        c += bm_rect_le(li, r, d, h.t * h.t) * e.eval_fac * power_heuristic(pdf_b, e.pdf);
    }
    return c;
}

// Point / spot light seen from x: punctual intensity x attenuation (unshadowed), direction to the light centre `l`,
// and a shadow ray toward a point sampled on the light's sphere (soft shadows).
fn local_light(li: Light, x: vec3<f32>, u: vec2<f32>) -> LS {
    if (!LIVE && u32(li.pos.w) == 3u) { return bm_rect_sample(li, x, u); }
    if (u32(li.pos.w) == 3u) {
        // Rect (UE RectLight): uniform point on the rectangle; luminance x area x cos_light / d^2 (Lambertian),
        // cut beyond the barn-door angle.
        let n = li.dir.xyz;
        let ux = li.ext.xyz;
        let uy = normalize(cross(n, ux)) * li.dir.w;
        let lp = li.pos.xyz + ux * (2.0 * u.x - 1.0) + uy * (2.0 * u.y - 1.0);
        let dl = lp - x;
        let d2 = max(dot(dl, dl), 1e-8);
        let dist = sqrt(d2);
        let l = dl / dist;
        let cos_l = dot(n, -l);
        var k = 0.0;
        if (cos_l > 0.0) {
            let area = 4.0 * length(ux) * li.dir.w;
            k = area * cos_l / d2 * smoothstep(li.x.z - 0.04, li.x.z + 0.04, cos_l);
            let range = li.color.w;
            if (range > 0.0) {
                let q = d2 / (range * range);
                let win = clamp(1.0 - q * q, 0.0, 1.0);
                k *= win * win;
            }
        }
        return LS(li.color.rgb * k, l, l, dist, 0.0);
    }
    var lp = li.pos.xyz;
    let radius = li.dir.w;
    if (radius > 0.0) {
        let z = 1.0 - 2.0 * u.x;
        let r = sqrt(max(0.0, 1.0 - z * z));
        let phi = 2.0 * PI * u.y;
        lp += radius * vec3<f32>(r * cos(phi), r * sin(phi), z);
    }
    let dl = li.pos.xyz - x;
    let d2 = max(dot(dl, dl), 1e-8);
    let l = dl * inverseSqrt(d2);
    var atten = 1.0 / d2;
    let range = li.color.w;
    if (range > 0.0) {
        let q = d2 / (range * range);
        let win = clamp(1.0 - q * q, 0.0, 1.0);
        atten *= win * win;
    }
    if (u32(li.pos.w) == 2u) {
        let m = clamp((dot(-l, li.dir.xyz) - li.ext.x) * li.ext.y, 0.0, 1.0);
        atten *= m * m;
    }
    let ls = lp - x;
    let dist = max(length(ls), 1e-6);
    return LS(li.color.rgb * atten, l, ls / dist, dist, 0.0);
}

// Local lights (after the directional ones; unshadowed before shadowed, P.counts2.w = first shadowed). At camera-ray
// hits every unshadowed light is evaluated exactly, as UE's deferred lights are (no sampling noise), and the shadowed
// ones too when there are few (one shadow ray each). Otherwise: resampled importance sampling (Talbot 2005) of RIS_M
// uniform candidates by unshadowed contribution, then one shadow ray. `vol` = in-scattering in the fog (phase
// function) instead of the surface BSDF. Surface results add their specular part to `dl_spec`.
// Light tiles (live; what guides MegaLights' draws and RTXPT's): each camera pixel reports the local light its
// resampled shadow ray found (direct_out's w: `lt_fb`, a light-table index; LT_NONE: none), live.wgsl `light_tiles`
// makes each 8 x 8 tile's reports a list in `light_lists` (the lights found, each once: index, reports; ascending;
// the last vec4 their number), and the next frame's paths take resampling candidates
// from the list of the tile their camera hit was seen in then (`lt_list_start`: where the point was, through that
// frame's camera), spread over it without repeats (all of it when it is short). The candidates drawn uniformly, as
// before, then stand for the lights the list lacks (`lt_in_list`). A list is a guide: whatever it holds the estimate
// is the same sum, so one gone stale (the table reordered, a surface newly in view) costs noise, not light.
// Compiled in for scenes whose shadow-casting local lights are resampled (F_LISTS). (LT_TILE, LT_LIST, LT_NONE:
// records.wgsl.)
var<private> lt_list: u32;
var<private> lt_list_n: u32;
var<private> lt_fb: u32;

// The list of the tile that point `p` (the camera hit, where it was when the lists were built) was seen in then, and
// how many lights it holds: the nearest tile's when it was off screen, none when it was behind the camera.
fn lt_list_start(p: vec3<f32>) {
    lt_list_n = 0u;
    if (!LIVE || P.ltile.x == 0u) { return; }
    let d = p - P.lt_cam[0].xyz;
    let z = dot(d, P.lt_cam[1].xyz);
    if (z <= 1e-4) { return; }
    let ndc = vec2<f32>(dot(d, P.lt_cam[2].xyz) / (z * P.lt_cam[0].w * P.lt_cam[1].w), dot(d, P.lt_cam[3].xyz) / (z * P.lt_cam[0].w));
    let uv = clamp(vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5), vec2<f32>(0.0), vec2<f32>(1.0));
    let q = min(vec2<u32>(uv * vec2<f32>(P.ltile2.xy)), P.ltile2.xy - 1u);
    let c = q + vec2<u32>(P.ltile.z & 0xffffu, P.ltile.z >> 16u);
    lt_list = ((c.y / LT_TILE) * P.ltile.y + c.x / LT_TILE) * LT_LIST;
    if (lt_list + LT_LIST > lists_len()) { return; }
    lt_list_n = min(u32(list_load(lt_list + LT_LIST - 1u).x), LT_LIST - 1u);
}

// Whether the pixel's list holds light `i`.
fn lt_in_list(i: u32) -> bool {
    var lo = 0u;
    var hi = lt_list_n;
    for (var k = 0u; k < 7u; k++) {
        if (lo >= hi) { break; }
        let mid = (lo + hi) / 2u;
        let km = u32(list_load(lt_list + mid).x);
        if (km == i) { return true; }
        if (km < i) { lo = mid + 1u; } else { hi = mid; }
    }
    return false;
}

// A shadow ray's origin toward l at a surface: on the side l leaves it from (`o`: the near side's, as computed once).
// Only a surface that lets light through has a value for the far side, so only a kernel with glass has the code
// (in every kernel, at its five inlined sites, it cost Bistro's trace 4 %).
fn light_origin(sd: ShadingPoint, o: vec3<f32>, l: vec3<f32>) -> vec3<f32> {
    if (has(F_GLASS) && dot(l, sd.Ng) < 0.0) { return offset_origin(sd.P, -sd.Ng); }
    return o;
}

// 北冥：参数从 (Surface, Lobes, 视线) 换成着色点；材质求值经上游顶替专用的 surface_shader_bsdf_eval_legacy。
// （`vol` 为真时不读着色点：雾里的散射点传一个全 0 的。）
fn local_lights(sd: ShadingPoint, o: vec3<f32>, x: vec3<f32>, vol: bool, d: vec3<f32>, rd: u32) -> vec3<f32> {
    let nd = P.counts2.x;
    let nl = P.counts.x - nd;
    if (nl == 0u) { return vec3<f32>(0.0); }
    var sum = vec3<f32>(0.0);
    var first = nd;
    var count = nl;
    if (!vol && (seen_directly() || nl <= RIS_EXACT)) {
        let ns = P.counts2.w;
        let n_sh = P.counts.x - ns;
        let end = select(ns, P.counts.x, n_sh <= RIS_EXACT || nl <= RIS_EXACT);
        // In groups of LIGHT_GROUP (spatially sorted; a sphere holding all their light per group: lib.rs
        // light_groups): a group x is outside of is skipped whole.
        var i = nd;
        loop {
            if (i >= end) { break; }
            let gs = light_group_at((i - nd) / LIGHT_GROUP);
            let gend = min(i + LIGHT_GROUP, end);
            if (distance(x, gs.xyz) > gs.w) {
                i = gend;
                continue;
            }
            for (; i < gend; i++) {
                let li = light_at(i);
                // Cheap rejects before sampling the light: black (off, or hidden), beyond its attenuation range (the
                // window is zero there), or entirely behind the surface.
                if (all(li.color.rgb <= vec3<f32>(0.0))) { continue; }
                let dc = li.pos.xyz - x;
                let reach = li.color.w + select(li.dir.w, length(li.ext.xyz) + li.dir.w, u32(li.pos.w) == 3u);
                if (li.color.w > 0.0 && dot(dc, dc) > reach * reach) { continue; }
                if (u32(li.pos.w) != 3u && dot(dc, sd.Ng) < -li.dir.w && !two_sided(sd.legacy.lobes)) { continue; } // eval_bsdf rejects it anyway
                let ls = local_light(li, x, rng2(rng_sub(rd, i)));
                if (all(ls.c <= vec3<f32>(0.0))) { continue; }
                let e = surface_shader_bsdf_eval_legacy(sd, ls.l, li.x.y);
                let f = e.eval;
                if (any(f > vec3<f32>(0.0))) {
                    let vis = light_vis(li.ext.w >= 0.5, light_origin(sd, o, ls.l), ls.sl, ls.dist * 0.999, rng_sub(rd ^ 0x40000000u, i));
                    if (any(vis > vec3<f32>(0.0))) {
                        var c = ls.c;
                        if (ls.pdf > 0.0) { c *= light_mis(ls.pdf, sd, ls.l); }
                        sum += c * f * tr3(vis);
                        dl_spec += c * f * tr3(vis) * e.spec_frac;
                    }
                }
            }
        }
        if (end == P.counts.x) { return sum; }
        first = ns;
        count = n_sh;
    }
    // Target: unshadowed intensity x cosine (cheap; the full BSDF / phase is applied to the chosen light only).
    let m_cand = select(3u, RIS_M, seen_directly());
    // With the pixel's list (light tiles), `nt` candidates more come from it, one in each `step` of its lights, and
    // the uniform ones keep the lights it lacks. A uniform candidate stands for count / m_cand lights (weight 1 here,
    // the factor applied at the end, as without a list), one of the list's for `step` (`listed`, relative to that).
    var nt = 0u;
    if (has(F_LISTS) && !vol && lt_list_n > 0u) { nt = min(select(P.ltile.w / 2u, P.ltile.w, seen_directly()), lt_list_n); }
    let step = f32(lt_list_n) / f32(max(nt, 1u));
    let listed = step * f32(m_cand) / f32(count);
    var at = 0.0;
    if (nt > 0u) { at = rng1(rng_sub(rd ^ 0x80000000u, 0x2000u)); }
    var wsum = 0.0;
    var pick = 0u;
    var pick_ph = 0.0;
    var pick_ls: LS;
    for (var k = 0u; k < m_cand + nt; k++) {
        var r4: vec4<f32>;
        var idx: u32;
        var stands = 1.0;
        if (k < m_cand) {
            r4 = rng4(rng_sub(rd ^ 0x80000000u, k));
            idx = first + min(u32(r4.x * f32(count)), count - 1u);
        } else {
            r4 = rng4(rng_sub(rd ^ 0x80000000u, 0x1000u + k));
            idx = u32(list_load(lt_list + min(u32((f32(k - m_cand) + at) * step), lt_list_n - 1u)).x);
            if (idx < first || idx >= first + count) { continue; }
            stands = listed;
        }
        let ls = local_light(light_at(idx), x, r4.yz);
        var ph = luminance(ls.c);
        if (vol) { ph *= light_at(idx).x.x; } else if (two_sided(sd.legacy.lobes)) { ph *= abs(dot(sd.legacy.surface.n, ls.l)); } else { ph *= max(dot(sd.legacy.surface.n, ls.l), 0.0) + 0.05 * max(dot(sd.Ng, ls.l), 0.0); }
        if (ph <= 0.0) { continue; }
        if (nt > 0u && k < m_cand && lt_in_list(idx)) { continue; }
        let w = ph * stands;
        wsum += w;
        if (r4.w * wsum < w) {
            pick = idx;
            pick_ph = ph;
            pick_ls = ls;
        }
    }
    if (pick_ph > 0.0) {
        var c: vec3<f32>;
        // 北冥：选中的那盏灯上这次求值的高光份额
        var frac = vec3<f32>(0.0);
        let lk = light_at(pick).x;
        if (vol) { c = pick_ls.c * hg_phase(P.vol.y, dot(pick_ls.l, d)) * lk.x; } else {
            let e = surface_shader_bsdf_eval_legacy(sd, pick_ls.l, lk.y);
            c = pick_ls.c * e.eval;
            frac = e.spec_frac;
        }
        if (any(c > vec3<f32>(0.0))) {
            let vis = light_vis(light_at(pick).ext.w >= 0.5, light_origin(sd, o, pick_ls.l), pick_ls.sl, pick_ls.dist * 0.999, rng_sub(rd, 0xffffffffu));
            if (!vol && pick_ls.pdf > 0.0) { c *= light_mis(pick_ls.pdf, sd, pick_ls.l); }
            if (any(vis > vec3<f32>(0.0))) {
                let r = c * tr3(vis) * (wsum * f32(count) / (f32(m_cand) * pick_ph));
                sum += r;
                if (!vol) { dl_spec += r * frac; }
                // The light tiles' report: the light the camera hit's ray found.
                if (has(F_LISTS) && !vol && cur_depth == 0u) { lt_fb = pick; }
            }
        }
    }
    return sum;
}

// An emitter sample: radiance, direction, distance, its source pdf (solid angle; MIS weights) and its contribution
// weight `w` (1 / pdf, or the RIS weight).
struct ES { le: vec3<f32>, l: vec3<f32>, dist: f32, pdf_w: f32, w: f32 };

// Emitted radiance of an emitter at (b1, b2) toward -l (emissive map, animation, material function, node power).
fn emitter_radiance(em: EmitterTri, b1: f32, b2: f32, l: vec3<f32>) -> vec3<f32> {
    let a = emitter_attrs(em);
    let m = material_at(bitcast<u32>(a.uv.w));
    // 5 cm footprint: a blurred texel is plenty for lighting and keeps NEE cheap.
    let pw = obj_power(a);
    var le = emission(m, mesh_uv(a, m, b1, b2), mesh_lod(a, m) + log2(0.05)) * pw;
    if (has(F_FUNC) && m.tex1.w > 0) {
        var mb = mat_base(m);
        mb.emissive *= pw;
        le = emissive_material_function(m.tex1.w - 1, mat_in_at(em.tri, b1, b2, -l, log2(0.05)), m, mb).emissive;
    }
    return le;
}

// Camera-ray hits: RIS over `m` candidates from the emitter CDF, resampled by emitted luminance x geometry term at x
// (with m > 1 the receiving side's cosine is the surface's BSDF x cosine toward the candidate, `eval_bsdf`: a glossy
// surface then picks the lights in its specular lobe, not only the bright and near ones. The string lights on the
// crowd's moving van roofs were sparse sparkles; live specular in motion 0.88 -> 0.91 of our offline render, layer B
// Bistro 3.47 -> 3.34. The target is free to choose: the estimate stays unbiased, tools/unbiased-check.ts within 0.1 %)
// (the CDF knows emitted power, and with light LOD the distance to the camera; without it, it mostly proposes signs
// far down the street). The target leaves the light LOD out, so the light LOD only changes which candidates are
// proposed. MIS against the BSDF rays weighs by power alone, the CDF's pdf without light LOD (emit_mis): the weights
// m_nee + m_bsdf still sum to one, so the combination stays unbiased, and which of the two carries which light is the
// same with or without light LOD. With light LOD every surface vertex samples this way (deeper ones with 2
// candidates): a single draw from the LOD'd CDF would make far emitters rare and heavy, which the radiance cache's
// clamps cut.
// 北冥：参数从 (Surface, Lobes, 视线) 换成着色点；材质求值经上游顶替专用的 surface_shader_bsdf_eval_legacy。
fn sample_emitter_ris(x: vec3<f32>, n: vec3<f32>, m: u32, sd: ShadingPoint, rd: u32) -> ES {
    var r = ES(vec3<f32>(0.0), vec3<f32>(0.0, 1.0, 0.0), 0.0, 0.0, 0.0);
    var wsum = 0.0;
    var pick_b = vec2<f32>(0.0);
    var pick_ph = 0.0;
    var pick_e = vec4<f32>(0.0);
    var pick_sel = 0.0;
    for (var k = 0u; k < m; k++) {
        let dk = rng_sub(rd, k);
        let pk = emitter_draw(x, n, dk);
        let e = pk.e;
        let bb = rng3(rng_sub(dk, 1u));
        var b1 = bb.x;
        var b2 = bb.y;
        if (pk.p <= 0.0) { continue; }
        if (b1 + b2 > 1.0) { b1 = 1.0 - b1; b2 = 1.0 - b2; }
        let em = emitter_tri_at(bitcast<u32>(e.x));
        let e1 = em.e1;
        let e2 = em.e2;
        let lp = em.v0 + e1 * b1 + e2 * b2;
        let ln = normalize(cross(e1, e2));
        let dl = lp - x;
        let d2 = max(dot(dl, dl), 1e-8);
        let l = dl * inverseSqrt(d2);
        var g = abs(dot(ln, l)) * select(max(dot(n, l), 0.0), 1.0, dot(n, n) == 0.0) / d2;
        if (m > 1u) { g = abs(dot(ln, l)) * luminance(surface_shader_bsdf_eval_legacy(sd, l, 1.0).eval) / d2; }
        // target (emitted luminance x G) over source pdf (luminance x light LOD / total, per area) = total x G / LOD;
        // with the tree the source pdf is its selection probability / area (weight / area = luminance x power)
        let lk = emitter_lod(em);
        var w = select(P.misc.y * g / lk, pk.w * g / pk.p, lt_on());
        // Particle emitters (e.w < 0): weighed by a nominal area -e.w, sampled over the actual one (0 when not shown).
        var ae = e.w;
        if (has(F_PEMIT) && e.w < 0.0) {
            ae = 0.5 * length(cross(e1, e2));
            if (ae <= 0.0) { continue; }
            w *= ae / -e.w;
        }
        if (w <= 0.0) { continue; }
        wsum += w;
        if (bb.z * wsum < w) {
            pick_b = vec2<f32>(b1, b2);
            pick_ph = pk.w / (abs(e.w) * lk) * g;
            pick_e = vec4<f32>(e.x, e.y, e.z / lk, ae);
            pick_sel = pk.p;
        }
    }
    if (pick_ph <= 0.0) { return r; }
    let em = emitter_tri_at(bitcast<u32>(pick_e.x));
    let e1 = em.e1;
    let e2 = em.e2;
    let lp = em.v0 + e1 * pick_b.x + e2 * pick_b.y;
    let ln = normalize(cross(e1, e2));
    let dl = lp - x;
    let d2 = dot(dl, dl);
    let dist = sqrt(d2);
    let l = dl / dist;
    var cos_l = dot(ln, -l);
    let m_card = material_at(bitcast<u32>(attrs[em.tri].uv.w)).tex1.z == MAT_EMITTER_CARD;
    if (!m_card) { cos_l = abs(cos_l); }
    if (cos_l <= 0.0) { return r; }
    r.le = emitter_radiance(em, pick_b.x, pick_b.y, l);
    r.l = l;
    r.dist = dist;
    // MIS by the source pdf: power alone without the tree (emit_mis), the tree's pmf with it
    r.pdf_w = select(pick_e.z / P.emit_power.x / pick_e.w * d2 / cos_l, pick_sel / pick_e.w * d2 / cos_l, lt_on());
    r.w = (wsum / f32(m)) / pick_ph * cos_l / d2;
    return r;
}

// One emissive triangle point by the emitter CDF (area x emissive-factor luminance); radiance includes the emissive
// map (coarse mip) and animation, so signs spill their own colours.
fn sample_emitter(x: vec3<f32>, n: vec3<f32>, rd: u32) -> ES {
    var r = ES(vec3<f32>(0.0), vec3<f32>(0.0, 1.0, 0.0), 0.0, 0.0, 0.0);
    let pk = emitter_draw(x, n, rd);
    let e = pk.e;
    if (pk.p <= 0.0) { return r; } // switched off (power 0)
    let em = emitter_tri_at(bitcast<u32>(e.x));
    let v0 = em.v0;
    let e1 = em.e1;
    let e2 = em.e2;
    let bb = rng2(rng_sub(rd, 1u));
    var b1 = bb.x;
    var b2 = bb.y;
    if (b1 + b2 > 1.0) { b1 = 1.0 - b1; b2 = 1.0 - b2; }
    let lp = v0 + e1 * b1 + e2 * b2;
    let cr = cross(e1, e2);
    let area = 0.5 * length(cr);
    let ln = cr / (2.0 * area);
    let dl = lp - x;
    let d2 = dot(dl, dl);
    let dist = sqrt(d2);
    let l = dl / dist;
    var cos_l = dot(ln, -l);
    if (material_at(bitcast<u32>(attrs[em.tri].uv.w)).tex1.z != MAT_EMITTER_CARD) { cos_l = abs(cos_l); }
    if (cos_l <= 0.0 || (has(F_PEMIT) && !(cos_l > 0.0))) { return r; } // also a particle not shown (no area: NaN)
    r.le = emitter_radiance(em, b1, b2, l);
    r.l = l;
    r.dist = dist;
    r.pdf_w = pk.p / area * d2 / cos_l;
    r.w = 1.0 / r.pdf_w;
    return r;
}

fn hg_phase(g: f32, c: f32) -> f32 {
    let d = 1.0 + g * g - 2.0 * g * c;
    return (1.0 - g * g) / (4.0 * PI * d * sqrt(d));
}

// gpu.rs `KernelSwitches::last_sun`: the directional lights alone, as `direct_light` takes them (one shadow ray a
// light), for the path's last vertex.
// 北冥：参数从 (Surface, Lobes, 视线) 换成着色点；材质求值经上游顶替专用的 surface_shader_bsdf_eval_legacy。
@if(last_sun && !last_direct) fn sun_light(sd: ShadingPoint) -> vec3<f32> {
    var sum = vec3<f32>(0.0);
    let o = offset_origin(sd.P, sd.Ng);
    for (var i = 0u; i < P.counts2.x; i++) {
        let li = light_at(i);
        if (all(li.color.rgb <= vec3<f32>(0.0))) { continue; }
        let cos_max = li.dir.w;
        let to_light = -li.dir.xyz;
        let u = rng2(rng_sub(rng_dim(D_SUN), i));
        let cos_t = 1.0 - u.x * (1.0 - cos_max);
        let sin_t = sqrt(max(0.0, 1.0 - cos_t * cos_t));
        let phi = 2.0 * PI * u.y;
        let l = basis(to_light) * vec3<f32>(sin_t * cos(phi), sin_t * sin(phi), cos_t);
        let f = surface_shader_bsdf_eval_legacy(sd, l, li.x.y).eval;
        if (any(f > vec3<f32>(0.0))) {
            let vis = light_vis(li.ext.w >= 0.5, light_origin(sd, o, l), l, INF, rng_sub(rng_dim(D_SUN_VIS), i));
            if (any(vis > vec3<f32>(0.0))) {
                let pdf_l = 1.0 / (2.0 * PI * (1.0 - cos_max));
                sum += li.color.rgb * f * light_mis(pdf_l, sd, l) * tr3(vis);
            }
        }
    }
    return sum;
}

// Whether the sky is light-sampled.
fn env_sampled() -> bool { return P.counts2.y != 0u && (P.env.x > 0.5 || luminance(P.sky_color.rgb) > 0.0); }

// The sky's light sample at a surface (`o`: its shadow rays' origin): one direction by the map, MIS against the BSDF.
// 北冥：参数从 (Surface, Lobes, 视线) 换成着色点；材质求值经上游顶替专用的 surface_shader_bsdf_eval_legacy。
fn env_light(sd: ShadingPoint, o: vec3<f32>) -> vec3<f32> {
    let l = sample_env(rng_dim(D_ENV));
    let f = surface_shader_bsdf_eval_legacy(sd, l, 1.0).eval;
    if (any(f > vec3<f32>(0.0))) {
        let pdf_e = env_pdf(l);
        if (pdf_e > 0.0) {
            let vis = sky_tr(light_origin(sd, o, l), l, rng_dim(D_ENV_VIS));
            if (any(vis > vec3<f32>(0.0))) { return env_radiance(l) * f * light_mis(pdf_e, sd, l) / pdf_e * tr3(vis); }
        }
    }
    return vec3<f32>(0.0);
}

// 北冥：参数从 (Surface, Lobes, 视线) 换成着色点；材质求值经上游顶替专用的 surface_shader_bsdf_eval_legacy。
fn direct_light(sd: ShadingPoint) -> vec3<f32> {
    var sum = vec3<f32>(0.0);
    dl_spec = vec3<f32>(0.0);
    let o = offset_origin(sd.P, sd.Ng);
    // Directional lights: uniformly sampled cone (soft shadows), MIS against BSDF sampling.
    for (var i = 0u; i < P.counts2.x; i++) {
        let li = light_at(i);
        let cos_max = li.dir.w;
        let to_light = -li.dir.xyz;
        let u = rng2(rng_sub(rng_dim(D_SUN), i));
        let cos_t = 1.0 - u.x * (1.0 - cos_max);
        let sin_t = sqrt(max(0.0, 1.0 - cos_t * cos_t));
        let phi = 2.0 * PI * u.y;
        let tb = basis(to_light);
        let l = tb * vec3<f32>(sin_t * cos(phi), sin_t * sin(phi), cos_t);
        // A light gone black (a moon that has set, the sun at night) costs neither its BSDF nor its shadow ray.
        if (all(li.color.rgb <= vec3<f32>(0.0))) { continue; }
        let e = surface_shader_bsdf_eval_legacy(sd, l, li.x.y);
        let f = e.eval;
        if (any(f > vec3<f32>(0.0))) {
            let vis = light_vis(li.ext.w >= 0.5, light_origin(sd, o, l), l, INF, rng_sub(rng_dim(D_SUN_VIS), i));
            if (any(vis > vec3<f32>(0.0))) {
                let pdf_l = 1.0 / (2.0 * PI * (1.0 - cos_max));
                let frac = e.spec_frac;
                let wgt = light_mis(pdf_l, sd, l);
                sum += li.color.rgb * f * wgt * tr3(vis);
                dl_spec += li.color.rgb * f * wgt * tr3(vis) * frac;
            }
        }
    }
    if (cur_depth == 0u) {
        dl_det += sum;
        dl_det_spec += dl_spec;
    }
    // gpu.rs `KernelSwitches::light_pick`: past the camera hit, the directional lights and one of the other kinds a
    // scene has (local lights, emitters, the sky), weighted by their number.
    @if(light_pick) let has_local = P.counts.x > P.counts2.x;
    @if(light_pick) let has_emit = P.counts.y > 0u;
    @if(light_pick) let has_env = P.counts2.y != 0u && (P.env.x > 0.5 || luminance(P.sky_color.rgb) > 0.0);
    @if(light_pick) var take_local = true;
    @if(light_pick) var take_emit = true;
    @if(light_pick) var take_env = true;
    @if(light_pick) var pick_w = 1.0;
    @if(light_pick) let kinds = u32(has_local) + u32(has_emit) + u32(has_env);
    @if(light_pick) if (cur_depth > 0u && kinds > 1u) {
        var k = min(u32(rng1(rng_dim(D_PICK)) * f32(kinds)), kinds - 1u);
        take_local = has_local && k == 0u;
        if (has_local) { k -= 1u; }
        take_emit = has_emit && k == 0u;
        if (has_emit) { k -= 1u; }
        take_env = has_env && k == 0u;
        pick_w = f32(kinds);
    }
    @if(light_pick) let sum_sun = sum;
    @if(light_pick) let spec_sun = dl_spec;
    @if(!light_pick) sum += local_lights(sd, o, sd.P, false, vec3<f32>(0.0), rng_dim(D_LOCAL));
    @if(light_pick) if (take_local) { sum += local_lights(sd, o, sd.P, false, vec3<f32>(0.0), rng_dim(D_LOCAL)); }
    // Emissive triangles (incl. rect lights)
    // (Rough glass takes emitters from both sides: as a point without a hemisphere does, the samples and `emit_mis`
    // alike. The tree's bound has no two-sided cosine; without one the estimate is the same, its noise a little more.)
    var ne = sd.legacy.surface.n;
    if (two_sided(sd.legacy.lobes)) { ne = vec3<f32>(0.0); }
    mis_x = o;
    mis_n = ne;
    var emitters = P.counts.y;
    @if(light_pick) if (!take_emit) { emitters = 0u; }
    if (emitters > 0u) {
        var es: ES;
        // With the light tree its candidates are already near the point: P.ltree.y of them at camera hits, one elsewhere.
        if (lt_on()) { es = sample_emitter_ris(o, ne, select(1u, u32(P.ltree.w), cur_depth == 0u), sd, rng_dim(D_EMIT)); } else if (seen_directly()) { es = sample_emitter_ris(o, ne, select(EMIT_RIS_M / 2u, EMIT_RIS_M, cur_depth == 0u), sd, rng_dim(D_EMIT)); } else if (P.light_lod.w > 0.0) { es = sample_emitter_ris(o, ne, 2u, sd, rng_dim(D_EMIT)); } else { es = sample_emitter(o, ne, rng_dim(D_EMIT)); }
        if (es.pdf_w > 0.0) {
            let e = surface_shader_bsdf_eval_legacy(sd, es.l, 1.0);
            let f = e.eval;
            if (any(f > vec3<f32>(0.0))) {
                let vis = emitter_tr(light_origin(sd, o, es.l), es.l, es.dist * 0.999, rng_dim(D_EMIT_VIS));
                if (vis > 0.0) {
                    let frac = e.spec_frac;
                    let wgt = light_mis(es.pdf_w, sd, es.l) * tr1(vis);
                    sum += es.le * f * wgt * es.w;
                    dl_spec += es.le * f * wgt * es.w * frac;
                }
            }
        }
    }
    // Environment
    var env_on = env_sampled() && !lights_only;
    @if(light_pick) env_on = take_env && has_env && !lights_only;
    if (env_on) {
        // (`split_frac` is the sky sample's where its BSDF was not 0; where it was, e is 0.)
        let e = env_light(sd, o);
        sum += e;
        dl_spec += e * split_frac;
    }
    @if(light_pick) if (pick_w > 1.0) {
        sum = sum_sun + (sum - sum_sun) * pick_w;
        dl_spec = spec_sun + (dl_spec - spec_sun) * pick_w;
    }
    return sum;
}
