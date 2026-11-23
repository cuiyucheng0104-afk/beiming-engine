// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：材质求值），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// ------------------------------------------------------------------------------------------------
// Surface

struct Surface {
    p: vec3<f32>,
    ng: vec3<f32>,
    n: vec3<f32>,
    base: vec3<f32>,
    metallic: f32,
    roughness: f32,
    specular: f32,
    emissive: vec3<f32>,
    front: bool,
    card: bool,
    // Shading changes over time (animated emission, rain ripples): the live viewport keeps a short history here.
    anim: bool,
    // Glass (transmission share, index of refraction) and clearcoat (amount, perceptual roughness).
    transmission: f32,
    ior: f32,
    coat: f32,
    coat_rough: f32,
};

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

// Texture pages: `lod` is log2 of the ray footprint in texture-UV units; the mip level adds the texture's resolution.
fn tex_level(id: i32, uv: vec2<f32>, level: f32) -> vec4<f32> {
    let a = tex_info_at(u32(id) * 2u);
    let b = tex_info_at(u32(id) * 2u + 1u);
    let f = select(clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), fract(uv), b.y > 0.5);
    return textureSampleLevel(textures, samp, a.xy + f * a.zw, i32(b.x), clamp(level, 0.0, TEX_MAX_LEVEL));
}

fn tex(id: i32, uv: vec2<f32>, lod: f32) -> vec4<f32> {
    let b = tex_info_at(u32(id) * 2u + 1u);
    return tex_level(id, uv, lod + 0.5 * log2(b.z * b.w));
}

fn mesh_uv(a: TriAttr, m: Material, u: f32, v: f32) -> vec2<f32> {
    let w = 1.0 - u - v;
    return (vec2<f32>(a.n0.w, a.n1.w) * w + vec2<f32>(a.n2.w, a.uv.x) * u + a.uv.yz * v) * m.uv.xy + m.uv2.xy;
}

// log2(texture-UV units per metre) of a triangle's mesh UVs (incl. material repeat).
fn mesh_lod(a: TriAttr, m: Material) -> f32 {
    return a.x.x + 0.5 * log2(max(abs(m.uv.x * m.uv.y), 1e-12));
}

// ------------------------------------------------------------------------------------------------
// Material functions: scene-supplied WGSL (like a UE Custom-HLSL material), docs/MATERIAL_FUNCTIONS.md.
// Inputs in world space (metres, Y up); helpers convert to UE space (cm, Z up) for ported UE code.

struct MatIn {
    wp: vec3<f32>,   // world position, m
    n: vec3<f32>,    // vertex normal (facing the viewer)
    ng: vec3<f32>,   // geometric normal (facing the viewer)
    t: vec3<f32>,    // tangent (+u)
    b: vec3<f32>,    // bitangent (image up = -v)
    uv: vec2<f32>,   // mesh UV0 (image convention: v down)
    uvd: f32,        // log2(mesh UV units per metre): msample(..., exp2(i.uvd)) for mesh-UV lookups
    view: vec3<f32>, // unit vector toward the viewer / ray origin
    op: vec3<f32>,   // object pivot, m
    ob: vec3<f32>,   // object world bounds size, m
    time: f32,
    wetness: f32,
    rain: f32,
    lod: f32,        // log2 of the ray footprint, m
    depth: u32,      // path vertex (0 = camera hit)
    power: f32,      // instance power (UE "Power"): scale the emission by it
    near: bool,      // seen directly or in mirror-like reflections (puddles, glass): where fine detail shows
    custom: vec4<f32>, // per-instance data (UE PerInstanceCustomData): the object's `customData`, or its particle's
};

struct MatOut {
    base: vec3<f32>,
    roughness: f32,
    metallic: f32,
    specular: f32,
    emissive: vec3<f32>,
    normal: vec3<f32>, // world-space shading normal
    opacity: f32,      // alpha-tested against the material's alphaTest
    animated: bool,    // the shading here moves with time (live: short history, as for animated emission)
};

// Texture slot `slot` of the material function at `uv`, mip from the ray footprint and `uv_per_m` (uv units / m).
fn msample(m: Material, i: MatIn, slot: u32, uv: vec2<f32>, uv_per_m: f32) -> vec4<f32> {
    let id = m.mt[slot];
    if (id < 0) { return vec4<f32>(1.0); }
    return tex(id, uv, i.lod + log2(max(uv_per_m, 1e-9)) - LOD_BIAS);
}

// Colour texture (sRGB-encoded) -> linear rgb, alpha as stored.
fn msample_color(m: Material, i: MatIn, slot: u32, uv: vec2<f32>, uv_per_m: f32) -> vec4<f32> {
    let c = msample(m, i, slot, uv, uv_per_m);
    return vec4<f32>(srgb_to_linear(c.rgb), c.a);
}

// Tangent-space normal (x along +u, y image-up, z out) -> world.
fn tangent_normal(i: MatIn, tn: vec3<f32>) -> vec3<f32> {
    let w = i.t * tn.x + i.b * tn.y + i.n * tn.z;
    if (dot(w, w) < 1e-12) { return i.n; }
    let nn = normalize(w);
    return select(i.n, nn, dot(nn, i.ng) > 0.0);
}

// Unreal space: (X, Y, Z) cm, Z up = ours (x, z, y) * 100.
fn ue_pos(p: vec3<f32>) -> vec3<f32> { return vec3<f32>(p.x, p.z, p.y) * 100.0; }
fn ue_vec(v: vec3<f32>) -> vec3<f32> { return vec3<f32>(v.x, v.z, v.y); }
fn from_ue_vec(v: vec3<f32>) -> vec3<f32> { return vec3<f32>(v.x, v.z, v.y); }

// @material-functions-begin
fn material_function(f: i32, i: MatIn, m: Material, base: MatOut) -> MatOut { return base; }
fn alpha_material_function(f: i32, i: MatIn, m: Material, base: MatOut) -> MatOut { return base; }
fn emissive_material_function(f: i32, i: MatIn, m: Material, base: MatOut) -> MatOut { return base; }
// @material-functions-end

fn object_of(a: TriAttr) -> u32 { return bitcast<u32>(a.x.y); }
// vec4s per object (scene.rs OBJECT_STRIDE): (pivot, power), (bounds size, time of the last power edit), per-instance
// data (`MatIn.custom`).
override OBJECT_STRIDE: u32 = select(3u, 4u, (FEAT & F_TINT) != 0u);
// An instanced object's instance colour (three.js `instanceColor`), white for every other object.
fn obj_tint(oi: u32) -> vec3<f32> { return object_at(oi * OBJECT_STRIDE + 3u).rgb; }
// Instance power (UE material "Power", scripts animate it): scales the emission of everything the node draws.
fn obj_power(a: TriAttr) -> f32 { return object_at(object_of(a) * OBJECT_STRIDE).w; }

// Inputs at a point of triangle ti (barycentrics u, v) for material functions outside full shading (alpha, NEE).
fn mat_in_at(ti: u32, u: f32, v: f32, view: vec3<f32>, lod: f32) -> MatIn {
    let a = attrs[ti];
    let m = material_at(bitcast<u32>(a.uv.w));
    let w = 1.0 - u - v;
    let p = tri_verts[ti * 3u].xyz + tri_verts[ti * 3u + 1u].xyz * u + tri_verts[ti * 3u + 2u].xyz * v;
    let ng = normalize(cross(tri_verts[ti * 3u + 1u].xyz, tri_verts[ti * 3u + 2u].xyz));
    var n = normalize(a.n0.xyz * w + a.n1.xyz * u + a.n2.xyz * v);
    let t = normalize(a.t.xyz - n * dot(n, a.t.xyz) + vec3<f32>(1e-9));
    let oi = object_of(a);
    return MatIn(p, n, ng, t, cross(n, t) * a.t.w, mesh_uv(a, m, u, v), mesh_lod(a, m), view, object_at(oi * OBJECT_STRIDE).xyz, object_at(oi * OBJECT_STRIDE + 1u).xyz,
                 P.time.x, P.time.y, P.time.z, lod, cur_depth, object_at(oi * OBJECT_STRIDE).w, cur_depth == 0u || mirror_path,
                 object_at(oi * OBJECT_STRIDE + 2u));
}

fn mat_base(m: Material) -> MatOut {
    return MatOut(m.base_color.rgb, m.params.y, m.params.x, m.params.z, m.emissive.rgb, vec3<f32>(0.0, 1.0, 0.0), m.base_color.a, false);
}

// A_CUTOUT_PATHS: rays past the camera ray and its own light samples, off mirror-like paths (whose image is still seen), take
// alpha-cutout triangles as opaque: no alpha test, no stepping through the leaves behind. The leaves of a tree are then
// solid cards to indirect light and to the light samples of later bounces. Through foliage that was most of the trace:
// Bistro along its camera path, frame GPU 16.1 / 19.9 ms -> 14.2 / 16.0 at its first pose / 15 s in; against the
// unbiased offline render the live image 0.3 % darker, ΔE +0.02–0.04 (the clamps' darkening is 9–13 %). Offline
// rendering always tests.
fn cutouts_opaque() -> bool {
    return approx(A_CUTOUT_PATHS) && cur_depth >= 1u && !mirror_path;
}

// A path stays mirror-like (`mirror_path`) through specular samples off surfaces smoother than this.
const MIRROR_ROUGHNESS: f32 = 0.3;

// Whether a cutout let the last shadow ray through (the shadow rays' functions clear it, `trace` sets it).
var<private> shadow_hole: bool = false;

// Set around a `direct_light` that no BSDF ray follows (where a path ends without the cache): its light samples
// take the whole of their light. Weighed against a BSDF ray that is never traced they kept their MIS share alone:
// of a uniform sky on a Lambert surface, ln 17 / 16 = 18 %.
var<private> nee_alone: bool = false;

// `direct_light` without the sky: a surface seen in a reflection lights itself from the lights, the sky's light
// there is the radiance cache's.
var<private> lights_only: bool = false;

// Alpha-cutout test for candidate hits on masked triangles (mesh UVs, footprint of a camera ray at distance t). `inst`:
// the model instance a pool triangle belongs to (its scale shifts the texel density, as in `inst_attr`), or NO_INST.
fn alpha_pass(ti: u32, inst: u32, u: f32, v: f32, t: f32) -> bool {
    let a = attrs[ti];
    let m = material_at(bitcast<u32>(a.uv.w));
    var alpha = m.base_color.a;
    var lod = mesh_lod(a, m) + log2(max(t * 2.0 * P.cam_pos.w / lod_height(), 1e-7)) - LOD_BIAS;
    if (has(F_INST) && inst != NO_INST) { lod += bitcast<f32>(instance_at(inst).info.z); }
    if (has(F_TEX) && m.tex0.x >= 0) {
        alpha *= tex(m.tex0.x, mesh_uv(a, m, u, v), lod).a;
    }
    if (has(F_FUNC) && m.tex1.w > 0) {
        let i = mat_in_at(ti, u, v, vec3<f32>(0.0, 1.0, 0.0), log2(max(t * 2.0 * P.cam_pos.w / lod_height(), 1e-7)));
        var b = mat_base(m);
        b.opacity = alpha;
        alpha = alpha_material_function(m.tex1.w - 1, i, m, b).opacity;
    }
    return alpha >= m.uv2.w;
}

// Emitted radiance at `uv`: factor x emissive map.
fn emission(m: Material, uv: vec2<f32>, lod: f32) -> vec3<f32> {
    var em = m.emissive.rgb;
    if (all(em <= vec3<f32>(0.0))) { return em; }
    if (has(F_TEX) && m.tex1.x >= 0) { em *= srgb_to_linear(tex(m.tex1.x, uv, lod).rgb); }
    return em;
}

// `width` = ray-cone footprint (m) at the hit, for texture LOD.
fn surface(o: vec3<f32>, d: vec3<f32>, h: Hit, width: f32) -> Surface {
    if (is_proc(h)) { return surface_proc(o, d, h, width); }
    let i = h.tri;
    var e1 = tri_verts[i * 3u + 1u].xyz;
    var e2 = tri_verts[i * 3u + 2u].xyz;
    var a = attrs[i];
    if (has(F_INST) && h.inst != NO_INST) {
        let r = instance_at(h.inst);
        e1 = inst_vec(r, e1);
        e2 = inst_vec(r, e2);
        a = inst_attr(r, a);
    }
    let w = 1.0 - h.u - h.v;
    var ng = normalize(cross(e1, e2));
    var n = normalize(a.n0.xyz * w + a.n1.xyz * h.u + a.n2.xyz * h.v);
    let mi = bitcast<u32>(a.uv.w);
    let m = material_at(mi);
    let front = dot(ng, d) < 0.0;
    if (!front) { ng = -ng; }
    if (dot(n, ng) < 0.0) { n = -n; }
    let p = o + d * h.t;

    let uv = mesh_uv(a, m, h.u, h.v);
    let lod = mesh_lod(a, m) + log2(max(width, 1e-7)) - 0.5 * log2(max(abs(dot(ng, d)), 1e-3)) - LOD_BIAS;

    var s: Surface;
    s.p = p;
    s.front = front;
    s.card = m.tex1.z == MAT_EMITTER_CARD;
    var base = m.base_color.rgb;
    if (has(F_TINT)) { base *= obj_tint(object_of(a)); }
    if (has(F_VCOLOR)) { base *= vcolor(i, h.u, h.v); }
    var rough = m.params.y;
    var metal = m.params.x;
    var spec = m.params.z;
    if (has(F_TEX)) {
        if (m.tex0.x >= 0) { base *= srgb_to_linear(tex(m.tex0.x, uv, lod).rgb); }
        if (m.tex0.z >= 0) { rough *= tex(m.tex0.z, uv, lod).g; }
        if (m.tex0.w >= 0) { metal *= tex(m.tex0.w, uv, lod).b; }
    }
    s.emissive = emission(m, uv, lod) * obj_power(a);
    // three.js MeshBasicMaterial: its colour to camera rays and mirror-like paths, lit by nothing, lighting nothing.
    if (has(F_UNLIT) && m.tex1.z == MAT_UNLIT) {
        s.emissive = select(vec3<f32>(0.0), base, cur_depth == 0u || mirror_path);
        base = vec3<f32>(0.0);
        spec = 0.0;
        metal = 0.0;
    }
    // Power just changed by a script / gameplay (objects[1].w = scene time of the edit): short history.
    s.anim = P.time.x - object_at(object_of(a) * OBJECT_STRIDE + 1u).w < 0.5;
    // Detail that only matters where it is seen directly or in mirror-like reflections (puddles, glass, chrome).
    let near = cur_depth == 0u || mirror_path;
    if (has(F_TEX) && m.tex0.y >= 0 && near) {
        let tn = tex(m.tex0.y, uv, lod).xyz * 2.0 - 1.0;
        let tp = a.t.xyz - n * dot(n, a.t.xyz);
        if (dot(tp, tp) > 1e-12) {
            let t = normalize(tp);
            let b = cross(n, t) * a.t.w;
            let pn = t * (tn.x * m.params.w) + b * (tn.y * m.params.w) + n * tn.z;
            if (dot(pn, pn) > 1e-12 && dot(pn, ng) > 0.0) { n = normalize(pn); }
        }
    }
    if (has(F_FUNC) && m.tex1.w > 0) {
        let oi = object_of(a);
        var t = normalize(a.t.xyz - n * dot(n, a.t.xyz) + vec3<f32>(1e-9));
        let nv = normalize(a.n0.xyz * w + a.n1.xyz * h.u + a.n2.xyz * h.v) * select(-1.0, 1.0, front || dot(a.n0.xyz, ng) > 0.0);
        let i = MatIn(p, select(-nv, nv, dot(nv, ng) >= 0.0), ng, t, cross(n, t) * a.t.w, mesh_uv(a, m, h.u, h.v), mesh_lod(a, m), -d,
                      object_at(oi * OBJECT_STRIDE).xyz, object_at(oi * OBJECT_STRIDE + 1u).xyz, P.time.x, P.time.y, P.time.z,
                      log2(max(width, 1e-7)) - 0.5 * log2(max(abs(dot(ng, d)), 1e-3)), cur_depth, object_at(oi * OBJECT_STRIDE).w, near,
                      object_at(oi * OBJECT_STRIDE + 2u));
        let r = material_function(m.tex1.w - 1, i, m, MatOut(base, rough, metal, spec, s.emissive, n, m.base_color.a, false));
        base = r.base;
        rough = r.roughness;
        metal = r.metallic;
        spec = r.specular;
        s.emissive = r.emissive;
        n = r.normal;
        // Shading the function says moves with time (wave normals) is as animated as emission is: short history.
        s.anim = s.anim || any(r.emissive > vec3<f32>(0.0)) || r.animated;
    }
    s.base = base;
    s.roughness = clamp(rough, 0.02, 1.0);
    s.metallic = clamp(metal, 0.0, 1.0);
    s.specular = spec;
    s.ng = ng;
    s.n = n;
    s.ior = 1.5;
    if (has(F_GLASS)) {
        s.transmission = clamp(m.layer.x, 0.0, 1.0);
        // glTF transmissionTexture (R), its index + 1 in uv.z.
        if (has(F_TEX) && m.uv.z > 0.5) { s.transmission *= tex(i32(m.uv.z) - 1, uv, lod).r; }
        s.ior = max(m.layer.y, 1.0001);
    }
    if (has(F_COAT)) {
        s.coat = clamp(m.layer.z, 0.0, 1.0);
        s.coat_rough = clamp(m.layer.w, 0.02, 1.0);
    }
    return s;
}

// A procedural hit's surface: the material its geometry function picked, the normal it gave (geometric and shading,
// two-sided), the object's power and customData. No textures (no uv: material functions get uv 0 and can work from
// `i.wp`), no transmission.
fn surface_proc(o: vec3<f32>, d: vec3<f32>, h: Hit, width: f32) -> Surface {
    let r = instance_at(h.inst);
    let hd = r.info.x;
    let mi = pword(pword(hd + 7u) + min((h.tri >> 23u) & 0xffu, pword(hd + 3u) - 1u));
    let m = material_at(mi);
    let oi = r.info.y;
    var ng = proc_normal(h);
    let front = dot(ng, d) < 0.0;
    if (!front) { ng = -ng; }
    var n = ng;
    let p = o + d * h.t;
    var s: Surface;
    s.p = p;
    s.front = front;
    s.card = false;
    var base = m.base_color.rgb;
    if (has(F_TINT)) { base *= obj_tint(oi); }
    var rough = m.params.y;
    var metal = m.params.x;
    var spec = m.params.z;
    s.emissive = m.emissive.rgb * object_at(oi * OBJECT_STRIDE).w;
    s.anim = P.time.x - object_at(oi * OBJECT_STRIDE + 1u).w < 0.5;
    if (has(F_FUNC) && m.tex1.w > 0) {
        let near = cur_depth == 0u || mirror_path;
        let a = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(n.x) > 0.9);
        let t = normalize(cross(a, n));
        let i = MatIn(p, n, ng, t, cross(n, t), proc_attr(h), 0.0, -d, object_at(oi * OBJECT_STRIDE).xyz, object_at(oi * OBJECT_STRIDE + 1u).xyz,
                      P.time.x, P.time.y, P.time.z, log2(max(width, 1e-7)) - 0.5 * log2(max(abs(dot(ng, d)), 1e-3)), cur_depth,
                      object_at(oi * OBJECT_STRIDE).w, near, object_at(oi * OBJECT_STRIDE + 2u));
        let f = material_function(m.tex1.w - 1, i, m, MatOut(base, rough, metal, spec, s.emissive, n, m.base_color.a, false));
        base = f.base;
        rough = f.roughness;
        metal = f.metallic;
        spec = f.specular;
        s.emissive = f.emissive;
        n = f.normal;
        s.anim = s.anim || any(f.emissive > vec3<f32>(0.0)) || f.animated;
    }
    s.base = base;
    s.roughness = clamp(rough, 0.02, 1.0);
    s.metallic = clamp(metal, 0.0, 1.0);
    s.specular = spec;
    s.ng = ng;
    s.n = n;
    s.ior = 1.5;
    if (has(F_COAT)) {
        s.coat = clamp(m.layer.z, 0.0, 1.0);
        s.coat_rough = clamp(m.layer.w, 0.02, 1.0);
    }
    return s;
}
