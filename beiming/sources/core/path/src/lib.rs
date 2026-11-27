// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/src/lib.rs，MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
//! core-render as a library: scene loading and the GPU path tracer (used by the `core-render` CLI).

pub mod api;
pub mod bvh;
#[cfg(not(target_arch = "wasm32"))]
pub mod denoise;
pub mod desc;
pub mod files;
pub mod gpu;
pub mod heap;
pub mod ltree;
pub mod merged;
// 北冥：输出通道 motion（输出通道契约 5.6），宿主一侧用双精度求
pub mod motion;
pub mod pack;
pub mod post;
pub mod procasset;
pub mod scene;
#[cfg(not(target_arch = "wasm32"))]
pub mod script;
pub mod skin;
pub mod cycles_hash;
// 北冥：照 Cycles 移植的像素滤波建表
pub mod pixel_filter;
pub mod sample;
pub mod sky;
pub mod texpack;
pub mod pipeline_cache;
pub mod world;

use glam::Vec3;
use std::path::PathBuf;
use web_time::Instant;

/// `presets/` next to (an ancestor of) the executable, else ./presets.
pub fn default_presets_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    for anc in exe.ancestors() {
        let p = anc.join("presets");
        if p.join("cinematic.json").exists() {
            return p;
        }
    }
    PathBuf::from("presets")
}


/// Traversal groups (see `group_of`).
pub const GROUPS: usize = 8;

/// Everything the GPU kernels need for a loaded scene: triangle layout for the active traversal backend, emitter CDF,
/// baked sky + its sampling CDF, and the base kernel parameters (camera from the scene).
pub struct Prepared {
    pub tri_verts: Vec<[f32; 4]>,
    /// Triangle counts of the traversal groups, in order: shadow-casting opaque, shadow-casting cutout,
    /// non-shadowing opaque, non-shadowing cutout; then the same four for dynamic triangles (posed models).
    pub groups: [usize; GROUPS],
    pub nodes: Vec<bvh::GpuNode>,
    /// The emitter CDF (`emitter_cdf`): one entry per `emitter_tris`, then the guide table.
    pub emitters: Vec<[f32; 4]>,
    /// The emitters' triangles as light sampling reads them, one per `emitter_tris`.
    pub gpu_emitter_tris: Vec<GpuEmitterTri>,
    pub env: gpu::EnvMap,
    pub env_cdf: Vec<f32>,
    pub params: gpu::Params,
    pub energy: Vec<[f32; 4]>,
    /// Emissive triangles (also those at power 0), for re-weighting `emitters` after power / material edits.
    pub emitter_tris: Vec<EmitterTri>,
    /// The light tree over the static emitters (`ltree`).
    pub light_tree: Option<ltree::LightTree>,
    /// Material -> runs of its flattened static triangles (first, end in the traversal order, object), and the
    /// materials that also cover pool or dynamic triangles: a material that starts emitting gets emitter entries in
    /// place from its runs (live/edits.rs `add_material_emitters`), unless fixed.
    pub mat_runs: std::collections::HashMap<u32, Vec<[u32; 3]>>,
    pub fixed_mats: std::collections::HashSet<u32>,
    /// The flattened triangles' build indices in traversal order (`Scene::tris` order: positions for new entries).
    pub tri_order: Vec<u32>,
    /// The brightest sky texel (luminance) from which the environment is light-sampled (`Params::counts2[1]`): 0 when
    /// there are no emitters. A dynamic sky re-decides with each bake (live/load.rs `DynamicSky`).
    pub env_nee_floor: f32,
}

/// The emitter entry of triangle `k` (traversal order) with attributes `a`, or None if it does not emit. Particle
/// triangles are collapsed until the particle pass places them: their nominal area (attrs x.z).
pub fn emitter_tri(k: usize, tri_verts: &[[f32; 4]], a: &scene::GpuTriAttr, materials: &[scene::GpuMaterial]) -> Option<EmitterTri> {
    let mat = a.uv[3].to_bits();
    let m = materials.get(mat as usize)?;
    let lum = 0.2126 * m.emissive[0] + 0.7152 * m.emissive[1] + 0.0722 * m.emissive[2];
    if !(lum > 0.0) {
        return None;
    }
    let v = |j: usize| Vec3::new(tri_verts[k * 3 + j][0], tri_verts[k * 3 + j][1], tri_verts[k * 3 + j][2]);
    let (e1, e2) = (v(1) - v(0), v(2) - v(0));
    let nominal = a.x[2] > 0.0;
    let area = if nominal { a.x[2] } else { 0.5 * e1.cross(e2).length() };
    if !(area * lum > 0.0) {
        return None;
    }
    let c = v(0) + (e1 + e2) / 3.0;
    let moves = tri_verts[k * 3][3].to_bits() & scene::TRI_DYNAMIC != 0;
    Some(EmitterTri { tri: k as u32, mat, obj: a.x[1].to_bits(), area, c: c.to_array(), moves, nominal, in_tree: false, inst: NO_INST })
}

/// An emissive triangle of the emitter CDF: triangle (traversal order), material, object, area.
#[derive(Clone, Copy, Debug)]
pub struct EmitterTri {
    pub tri: u32,
    pub mat: u32,
    pub obj: u32,
    pub area: f32,
    /// Centroid (light LOD: distance to the reference camera position).
    pub c: [f32; 3],
    /// On a moving object (TRI_DYNAMIC): no light LOD, its centroid would go stale (the kernel skips it too).
    pub moves: bool,
    /// A particle's: `area` is the nominal one (Particles emitterArea); its CDF entry carries it negated so the kernel
    /// samples the actual area (pathtrace.wgsl sample_emitter_ris, emit_mis).
    pub nominal: bool,
    /// One of the light tree's (`ltree`): its CDF entry is in the tree's range, at the start of the CDF.
    pub in_tree: bool,
    /// The instance that places its triangle (its record; the triangle is the mesh's, in model space), or `NO_INST`:
    /// a triangle in world space.
    pub inst: u32,
}

/// No instance (pathtrace.wgsl `NO_INST`).
pub const NO_INST: u32 = u32::MAX;

/// `GpuEmitterTri::code`: the emitter moves (`EmitterTri::moves`). Path codes are below it.
pub const EMITTER_MOVES: u32 = 1 << 31;
const _: () = assert!((ltree::PATH_BITS + 2) << ltree::PATH_BITS <= EMITTER_MOVES);

/// An emitter's triangle as the kernel's light sampling reads it (pathtrace.wgsl `EmitterTri`; `Table::EmitterTris`,
/// entry i for `emitter_tris[i]`): in world space, the light list's own copy, so a sample reads no placement. v0, e1,
/// e2 in world space; its triangle in the triangles' table (attributes); the instance that places it (`NO_INST`: the
/// triangle is in world space there too); the light tree's path code (0: not one of the tree's) with `EMITTER_MOVES`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuEmitterTri {
    pub v0: [f32; 3],
    pub tri: u32,
    pub e1: [f32; 3],
    pub inst: u32,
    pub e2: [f32; 3],
    pub code: u32,
}

impl GpuEmitterTri {
    /// `e`'s, from its triangle's rows (its three vertices: `Prepared::tri_verts`), with path code `code`.
    pub fn new(e: &EmitterTri, rows: &[[f32; 4]], code: u32) -> GpuEmitterTri {
        let v = |r: usize| glam::Vec3A::new(rows[r][0], rows[r][1], rows[r][2]);
        GpuEmitterTri::of(e, [v(0), v(1), v(2)], code)
    }

    /// As `new`, from its vertices.
    pub fn of(e: &EmitterTri, [a, b, c]: [glam::Vec3A; 3], code: u32) -> GpuEmitterTri {
        let (e1, e2) = (b - a, c - a);
        GpuEmitterTri { v0: a.to_array(), tri: e.tri, e1: e1.to_array(), inst: e.inst, e2: e2.to_array(), code: code | if e.moves { EMITTER_MOVES } else { 0 } }
    }

    /// Its vertices.
    pub fn vertices(&self) -> [[f32; 3]; 3] {
        let at = |e: [f32; 3]| [self.v0[0] + e[0], self.v0[1] + e[1], self.v0[2] + e[2]];
        [self.v0, at(self.e1), at(self.e2)]
    }
}

/// The emitters of an instance of a mesh that emits (`scene::InstMesh::emitters`, `count` of them): one a numbered
/// triangle, in the numbers' order, each with its triangle as the instance places it. `tris`: the mesh's, in model
/// space; `first`: its first triangle in the triangles' table; `numbered(k)`: triangle k's number and material, if
/// it emits; `record`: the instance's. A hidden instance's, and a triangle of no area: no weight (area 0).
pub fn instance_emitters(inst: &scene::Instance, record: u32, tris: &[[glam::Vec3A; 3]], first: u32, numbered: &dyn Fn(usize) -> Option<(usize, u32)>, count: usize, materials: &[scene::GpuMaterial], moves: bool) -> Vec<(EmitterTri, [glam::Vec3A; 3])> {
    let dead = EmitterTri { tri: first, mat: 0, obj: inst.object, area: 0.0, c: [0.0; 3], moves, nominal: false, in_tree: false, inst: record };
    let mut out = vec![(dead, [glam::Vec3A::ZERO; 3]); count];
    for (k, t) in tris.iter().enumerate() {
        let Some((slot, mat)) = numbered(k) else { continue };
        let w = t.map(|v| glam::Vec3A::from(inst.world.transform_point3(v.into())));
        let emits = materials.get(mat as usize).is_some_and(|m| 0.2126 * m.emissive[0] + 0.7152 * m.emissive[1] + 0.0722 * m.emissive[2] > 0.0);
        let area = if emits && !inst.hidden { 0.5 * (w[1] - w[0]).cross(w[2] - w[0]).length() } else { 0.0 };
        out[slot] = (EmitterTri { tri: first + k as u32, mat, area, c: ((w[0] + w[1] + w[2]) / 3.0).to_array(), ..dead }, w);
    }
    out
}

/// An emitter triangle's power: area x emissive-factor luminance x object power (its CDF weight without light LOD).
pub fn emitter_power(e: &EmitterTri, materials: &[scene::GpuMaterial], objects: &[[f32; 4]], stride: usize) -> f32 {
    let m = &materials[e.mat as usize];
    let lum = 0.2126 * m.emissive[0] + 0.7152 * m.emissive[1] + 0.0722 * m.emissive[2];
    e.area * lum * objects.get(e.obj as usize * stride).map_or(1.0, |o| o[3])
}

/// An emitter's power with its object switched on: its power now, or at full power if its object is off (0). What the
/// light sampling is set up for at load (the light tree, the sky's light-sampling floor), so that it does not depend on
/// which lights were on then: a time-of-day room switched in place samples as one loaded in that state.
pub fn switchable_power(e: &EmitterTri, materials: &[scene::GpuMaterial], objects: &[[f32; 4]], stride: usize) -> f32 {
    let p = emitter_power(e, materials, objects, stride);
    if p > 0.0 { p } else { emitter_power(e, materials, &[], stride) }
}

/// The light tree over a scene's emitters (`ltree::build`; `slot`: with the slot for emitters added in place). Its
/// members and shape go by `switchable_power`: a time-of-day room's lamps and windows by day are in the tree at zero
/// weight until they switch on, instead of in the flat CDF beyond it, where the kernel draws them by power share alone
/// (no importance at the shading point) once they are on. Then, if some are off, the node powers are refit to the
/// objects' powers now; a scene with every emitter on at load gets the tree it had before, bit for bit.
pub fn light_tree_of(tris: &[EmitterTri], verts: &dyn Fn(usize) -> [[f32; 3]; 3], materials: &[scene::GpuMaterial], objects: &[[f32; 4]], stride: usize, slot: bool) -> Option<ltree::LightTree> {
    let build = if slot { ltree::build_slotted } else { ltree::build };
    let mut t = build(tris, verts, &|i| switchable_power(&tris[i], materials, objects, stride))?;
    let now: Vec<f32> = t.order.iter().map(|&i| emitter_power(&tris[i as usize], materials, objects, stride)).collect();
    if now.iter().any(|&w| !(w > 0.0)) {
        t.refit(&|k| now[k]);
    }
    Some(t)
}

/// The live emitter cull: emitters farther than `radius` from the light LOD's reference are not proposed at all, unless
/// they lie in the view cone (`dir`, cosine of the half-angle `cos`) within `far`. Far emitters behind or beside the
/// camera are mostly occluded and cost long shadow rays; the ones ahead light what the camera sees (Bistro's square,
/// 40-90 m down the street, lost 60 % of its light in the live image when they were culled too: the BSDF rays that
/// alone bring a culled emitter's light are rare and the firefly clamp cuts them). radius 0 = no cull; far 0 = no cone.
/// The kernel's `emitter_culled` makes the same test.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct EmitterCull {
    pub radius: f32,
    pub far: f32,
    pub dir: [f32; 3],
    pub cos: f32,
}

impl EmitterCull {
    /// Whether an emitter at `c`, `d` from the reference `r`, is culled.
    fn culls(&self, c: Vec3, r: Vec3, d: f32) -> bool {
        self.radius > 0.0 && d > self.radius && !(d <= self.far && (c - r).dot(Vec3::from(self.dir)) >= self.cos * d)
    }
}

/// Light LOD (live): emitters are sampled by power x (d0 / max(d, d0))^2, d = distance to the reference position, so
/// far emitters (mostly occluded, long shadow rays) are drawn rarely. Unbiased: the kernel's emitter pdfs apply the
/// same factor (`emitter_lod`). xyz = reference position, w = d0 (0 = off).
/// Emitters the cull drops (`EmitterCull`) are not proposed at all (factor 0). The kernel gives the BSDF rays that hit
/// them their whole light (emit_mis), so the estimator stays unbiased; their light just comes by those rays alone.
pub fn emitter_lod(c: [f32; 3], lod: [f32; 4], cull: EmitterCull) -> f32 {
    if lod[3] <= 0.0 {
        return 1.0;
    }
    let (c, r) = (Vec3::from(c), Vec3::new(lod[0], lod[1], lod[2]));
    let d = c.distance(r);
    if cull.culls(c, r, d) {
        return 0.0;
    }
    let d = d.max(lod[3]);
    (lod[3] / d) * (lod[3] / d)
}

/// Seed of the kernel's random numbers (`KernelIntegrator::new` hashes it once: `Params::integrator.seed`). Renders are
/// deterministic; THREERT_SEED gives the same build another sample sequence, for noise floors (two seeds, same
/// estimator).
pub fn rng_seed() -> u32 {
    static S: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *S.get_or_init(|| std::env::var("THREERT_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0x5eed))
}

/// Local lights are evaluated in groups of LIGHT_GROUP at camera hits (pathtrace.wgsl `local_lights`): spatially sorted,
/// each group with a sphere bounding its lights' reach, so a shading point skips whole groups it is outside of instead
/// of testing every light's range. Same result as testing each light (a skipped light is one its range test rejects).
pub const LIGHT_GROUP: usize = 16;

/// Distance beyond which a local light gives nothing (the kernel's range test in `local_lights`); f32::MAX without a
/// range. (A black light gives nothing anywhere: `light_groups` leaves it out.)
fn light_reach(l: &scene::GpuLight) -> f32 {
    if l.color[3] <= 0.0 {
        return f32::MAX;
    }
    let size = if l.pos[3] == 3.0 { Vec3::from_slice(&l.ext[..3]).length() + l.dir[3] } else { l.dir[3] };
    l.color[3] + size
}

/// Orders `idx` (lights at positions base.. of the light table) so that every LIGHT_GROUP-sized chunk counted from
/// `origin` is spatially compact: median splits at chunk boundaries along the longest axis.
fn sort_lights_spatially(idx: &mut [usize], base: usize, origin: usize, lights: &[scene::GpuLight]) {
    let (lo, hi) = (base, base + idx.len());
    // The chunk boundary nearest the middle, strictly inside.
    let mid = lo + idx.len() / 2;
    let k = ((mid - origin) as f32 / LIGHT_GROUP as f32).round() as usize;
    let mut split = origin + k * LIGHT_GROUP;
    if split <= lo {
        split += LIGHT_GROUP;
    }
    if split >= hi {
        split = split.saturating_sub(LIGHT_GROUP);
    }
    if split <= lo || split >= hi {
        return;
    }
    let p = |i: usize| Vec3::from_slice(&lights[i].pos[..3]);
    let (mut a, mut b) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for &i in idx.iter() {
        a = a.min(p(i));
        b = b.max(p(i));
    }
    let ext = b - a;
    let axis = if ext.x >= ext.y && ext.x >= ext.z { 0 } else if ext.y >= ext.z { 1 } else { 2 };
    idx.select_nth_unstable_by(split - lo, |&i, &j| p(i)[axis].total_cmp(&p(j)[axis]));
    let (l, r) = idx.split_at_mut(split - lo);
    sort_lights_spatially(l, lo, origin, lights);
    sort_lights_spatially(r, split, origin, lights);
}

/// 0 directional, 1 local without shadows, 2 local with shadows.
fn light_class(l: &scene::GpuLight) -> u8 {
    if l.pos[3] == 0.0 { 0 } else if l.ext[3] < 0.5 { 1 } else { 2 }
}

/// The kernel's light order: directional lights first (it loops over them), then local lights without shadows (evaluated
/// exactly at camera hits, like UE's deferred lights), then shadowed ones (one shadow ray each when few, else sampled);
/// each class spatially sorted into the kernel's light groups (`light_groups`).
pub fn light_order(lights: &[scene::GpuLight]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..lights.len()).collect();
    order.sort_by_key(|&i| light_class(&lights[i]));
    let nd = order.iter().take_while(|&&i| light_class(&lights[i]) == 0).count();
    let ns = nd + order[nd..].iter().take_while(|&&i| light_class(&lights[i]) == 1).count();
    let (unshadowed, shadowed) = order[nd..].split_at_mut(ns - nd);
    sort_lights_spatially(unshadowed, nd, nd, lights);
    sort_lights_spatially(shadowed, ns, nd, lights);
    order
}

/// The light groups' table: per group of LIGHT_GROUP local lights (counted from the first local one) the sphere
/// (centre, radius) holding every point its lights reach. Black lights (off, or hidden: `scene::gpu_light_shown`)
/// reach nothing and are in no sphere; a group of them alone has radius -1 (no point is in it).
/// THREERT_LIGHT_GROUPS=0: unbounded spheres, every light tested (A/B).
pub fn light_groups(lights: &[scene::GpuLight]) -> Vec<[f32; 4]> {
    static OFF: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let off = *OFF.get_or_init(|| std::env::var("THREERT_LIGHT_GROUPS").is_ok_and(|v| v == "0"));
    let nd = lights.iter().take_while(|l| l.pos[3] == 0.0).count();
    let mut out = vec![];
    for g in lights[nd..].chunks(LIGHT_GROUP) {
        let lit = |l: &&scene::GpuLight| l.color[..3].iter().any(|c| *c > 0.0);
        if !off && !g.iter().any(|l| lit(&l)) {
            out.push([0.0, 0.0, 0.0, -1.0]);
            continue;
        }
        let (mut a, mut b) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for l in g.iter().filter(lit) {
            a = a.min(Vec3::from_slice(&l.pos[..3]));
            b = b.max(Vec3::from_slice(&l.pos[..3]));
        }
        let c = (a + b) * 0.5;
        let mut r = 0.0f32;
        for l in g.iter().filter(lit) {
            let reach = light_reach(l);
            r = if reach == f32::MAX { f32::MAX } else { r.max(c.distance(Vec3::from_slice(&l.pos[..3])) + reach) };
        }
        if off {
            r = f32::MAX;
        }
        // Margin for rounding in the kernel's distance (positions up to a few km).
        if r < f32::MAX {
            r = r * (1.0 + 1e-5) + 1e-3 * (1.0 + c.abs().max_element() * 1e-3);
        }
        out.push([c.x, c.y, c.z, r]);
    }
    out
}

/// Buckets of the emitter CDF's guide table (pathtrace.wgsl `EMITTER_GUIDE`, a power of two).
pub const EMITTER_GUIDE: usize = 65536;

/// The order of a scene's emitters in the CDF: the light tree's in its leaf order (a node covers a run of entries),
/// then the rest as the list has them. The list itself keeps its order.
pub fn emitter_order(tris: &[EmitterTri], tree: Option<&ltree::LightTree>) -> Vec<u32> {
    let all = 0..tris.len() as u32;
    let Some(t) = tree else { return all.collect() };
    let mut placed = vec![false; tris.len()];
    for &i in &t.order {
        placed[i as usize] = true;
    }
    t.order.iter().copied().chain(all.filter(|&i| !placed[i as usize])).collect()
}

/// Emitter CDF entries (its emitter's index in `tris`: bits, normalized cumulative weight, weight, area), one per
/// emitter in `order` (`emitter_order`); then the guide table; the total weight and the total without light LOD
/// (Params::emit_power). Weight = area x emissive luminance x object power (x light LOD). Triangles switched off
/// keep a zero-weight entry.
/// Guide table (the cutpoint method): EMITTER_GUIDE + 1 indices, four per vec4 (bits); index k is where the kernel's
/// binary search lands for u = k / EMITTER_GUIDE, so a draw u only searches between the indices of its bucket and the
/// next, and finds the same entry as a search over the whole CDF.
pub fn emitter_cdf(tris: &[EmitterTri], order: &[u32], materials: &[scene::GpuMaterial], objects: &[[f32; 4]], stride: usize, lod: [f32; 4], cull: EmitterCull) -> (Vec<[f32; 4]>, f32, f32) {
    let (mut total, mut power) = (0.0f32, 0.0f32);
    let mut out = Vec::with_capacity(order.len());
    for &i in order {
        let e = &tris[i as usize];
        let lod_k = if e.moves { 1.0 } else { emitter_lod(e.c, lod, cull) };
        let p = emitter_power(e, materials, objects, stride);
        power += p;
        total += p * lod_k;
        out.push([f32::from_bits(i), total, p * lod_k, if e.nominal { -e.area } else { e.area }]);
    }
    if total > 0.0 {
        for e in &mut out {
            e[1] /= total;
        }
    }
    // The kernel's search: the first entry whose cumulative weight is not below u.
    let (n, mut i) = (out.len(), 0usize);
    let guide: Vec<u32> = (0..=EMITTER_GUIDE)
        .map(|k| {
            let u = k as f32 / EMITTER_GUIDE as f32;
            while i < n && out[i][1] < u {
                i += 1;
            }
            i as u32
        })
        .collect();
    out.extend(guide.chunks(4).map(|c| std::array::from_fn(|j| f32::from_bits(c.get(j).copied().unwrap_or(0)))));
    (out, total, power)
}

/// Height fog and volumetric fog kernel parameters (`Params::fog`, `fog_color`, `vol`, `vol2`).
pub fn fog_params(fog: Option<&desc::Fog>) -> [[f32; 4]; 4] {
    [
        fog.map_or([0.0; 4], |f| [f.density.max(0.0), f.height_falloff, f.height, f.start_distance]),
        fog.map_or([0.0; 4], |f| {
            let k = f.intensity.unwrap_or(1.0);
            [f.color[0] * k, f.color[1] * k, f.color[2] * k, f.max_opacity.unwrap_or(1.0).clamp(0.0, 1.0)]
        }),
        fog.and_then(|f| f.volumetric.as_ref()).map_or([0.0; 4], |v| [v.scattering.max(0.0), v.anisotropy.clamp(-0.95, 0.95), v.extinction_scale.max(0.0), 0.0]),
        fog.and_then(|f| f.volumetric.as_ref()).map_or([1.0, 1.0, 1.0, 0.0], |v| {
            let a = v.albedo.unwrap_or([1.0; 3]);
            [a[0], a[1], a[2], v.distance.max(0.0)]
        }),
    ]
}

/// Whether a baked environment map (an HDRI, a `SkyAtmosphere`'s bake) is light-sampled: THREERT_ENV_NEE=1|0, on
/// everywhere but Android. On Adreno 740 the kernel's reads of `env_cdf` for it went to the wrong memory (tens of
/// thousands of GPU page faults a second under a `SkyAtmosphere`, a trace up to twice as slow). Without it the sky
/// still lights through the paths' own rays, with their full weight; the sun is a directional light, sampled as ever.
pub fn env_nee_on() -> bool {
    env_nee_of(std::env::var("THREERT_ENV_NEE").ok().as_deref(), cfg!(target_os = "android"))
}

fn env_nee_of(var: Option<&str>, android: bool) -> bool {
    var.map_or(!android, |v| v != "0")
}

/// `prepare` for an offline render: under software traversal every instance flattened.
pub fn prepare(g: &gpu::Gpu, sc: &mut scene::Scene, timings: &mut Vec<(String, f64)>) -> Prepared {
    prepare_as(g.hwrt, sc, timings)
}

/// `prepare` for a traversal: hardware ray queries, or software traversal.
pub fn prepare_as(hwrt: bool, sc: &mut scene::Scene, timings: &mut Vec<(String, f64)>) -> Prepared {
    let t = Instant::now();
    // Software traversal: the instances become ordinary world-space triangles.
    if !hwrt && !sc.instances.is_empty() {
        flatten_instances(sc);
    }
    // Software traversal walks each procedural object's boxes through a tree of its own, and the tree over no box is
    // not one the kernel can walk (bvh.rs `EMPTY`): an object without boxes has nothing to meet, and is left out.
    if !hwrt {
        sc.procs.retain(|p| !p.blob.boxes.is_empty());
    }
    // Hardware RT only needs triangles grouped by shadow casting; software traversal needs our BVH.
    let bvh = if hwrt {
        let mut order: Vec<u32> = (0..sc.tris.len() as u32).collect();
        order.sort_by_key(|&i| group_of(sc.tri_flags[i as usize]));
        bvh::Bvh { nodes: vec![bvh::GpuNode { bmin: [0.0; 3], left_or_first: 0, bmax: [0.0; 3], count: 0 }], order, depth: 0 }
    } else {
        let b = bvh::build(&sc.tris);
        timings.push(("bvh_depth".into(), b.depth as f64));
        b
    };
    let mut groups = [0usize; GROUPS];
    for f in &sc.tri_flags {
        groups[group_of(*f)] += 1;
    }
    let mut tri_verts: Vec<[f32; 4]> = Vec::with_capacity(sc.tris.len() * 3);
    let mut attrs = Vec::with_capacity(sc.attrs.len());
    for &i in &bvh.order {
        let [a, b, c] = sc.tris[i as usize];
        tri_verts.push([a.x, a.y, a.z, f32::from_bits(sc.tri_flags[i as usize])]);
        tri_verts.push([b.x, b.y, b.z, 0.0]);
        tri_verts.push([c.x, c.y, c.z, 0.0]);
        attrs.push(sc.attrs[i as usize]);
    }
    // Instanced meshes (hardware RT): the model-space pool after every traversal group, one BLAS per mesh.
    let pool_first = tri_verts.len() / 3;
    // Deforming meshes come first (scene build): flagged dynamic, their previous vertices kept for motion vectors.
    let deforming = scene::deforming_pool(&sc.meshes);
    for (k, (t, a)) in sc.pool_tris.iter().zip(&sc.pool_attrs).enumerate() {
        let [a0, b, c] = *t;
        tri_verts.push([a0.x, a0.y, a0.z, f32::from_bits(if k < deforming { scene::TRI_DYNAMIC } else { 0 })]);
        tri_verts.push([b.x, b.y, b.z, 0.0]);
        tri_verts.push([c.x, c.y, c.z, 0.0]);
        attrs.push(*a);
    }
    sc.gpu_instances = sc.instances.iter().map(|i| { let m = sc.meshes[i.mesh as usize]; i.gpu(pool_first as u32 + m.first, m.opaque) }).collect();
    let nodes = bvh.nodes;
    // Procedural geometry: its records after the model instances', its boxes / materials / data in `proc_data`.
    let layout = scene::proc_layout(&sc.procs, !hwrt);
    sc.proc_records = sc.procs.iter().zip(&layout.headers).map(|(p, &h)| p.gpu(h)).collect();
    sc.proc_layout = (!sc.procs.is_empty()).then_some(layout);
    sc.attrs = attrs;
    // Vertex colours (scene.rs `tri_colors`), with the triangles: the flattened ones in traversal order, the pool, the
    // translucent particles (white).
    sc.gpu_vcolors = if sc.vcolors.is_empty() && sc.pool_vcolors.is_empty() {
        vec![]
    } else {
        let at = |v: &[[u32; 3]], k: usize| v.get(k).copied().unwrap_or(scene::WHITE);
        let mut v: Vec<u32> = Vec::with_capacity(sc.attrs.len() * 3);
        v.extend(bvh.order.iter().flat_map(|&i| at(&sc.vcolors, i as usize)));
        v.extend((0..sc.pool_tris.len()).flat_map(|k| at(&sc.pool_vcolors, k)));
        v.resize(sc.attrs.len() * 3, u32::MAX);
        v
    };
    // Posed models: where each of their triangles landed (they are re-skinned in place, hardware RT only).
    if hwrt && sc.retained.dynamics_mut().next().is_some() {
        let first_dynamic: usize = groups[..4].iter().sum();
        let finals: std::collections::HashMap<u32, u32> = bvh.order[first_dynamic..].iter().enumerate().map(|(k, &i)| (i, (first_dynamic + k) as u32)).collect();
        for d in sc.retained.dynamics_mut() {
            d.finals = (0..d.mats.len() as u32).map(|j| finals[&(d.first + j)]).collect();
        }
    }
    timings.push(("bvh_ms".into(), t.elapsed().as_secs_f64() * 1000.0));

    // The light list (an emitter's weight = area x luminance of the emissive factor x object power): the flattened
    // triangles that emit, then, an instance at a time, those of a mesh that emits (`InstMesh::emitters`): a run of
    // the list an instance, its first in its record, its triangles' numbers counted from it. Each with its triangle in
    // world space.
    let mut emitter_tris: Vec<EmitterTri> = vec![];
    let mut gpu_emitter_tris: Vec<GpuEmitterTri> = vec![];
    for k in 0..pool_first {
        if let Some(e) = emitter_tri(k, &tri_verts, &sc.attrs[k], &sc.materials) {
            gpu_emitter_tris.push(GpuEmitterTri::new(&e, &tri_verts[k * 3..][..3], 0));
            emitter_tris.push(e);
        }
    }
    // (A mesh that emits: its emitting triangles numbered as they lie here, for its instances' emitters.)
    for m in sc.meshes.iter().filter(|m| m.emitters > 0) {
        let n = scene::number_emitters(&mut sc.attrs[pool_first + m.first as usize..pool_first + (m.first + m.count) as usize], &sc.materials);
        assert_eq!(n, m.emitters, "a mesh's emitters as the build counted them");
    }
    // (The instances an edit moves in place: a body's, a movable model's, a posed rigid model's nodes'.)
    let moving: std::collections::HashSet<u32> = sc.retained.proxies.values().flat_map(|p| match &p.draw {
        scene::Draw::Instance(i) if i.moves => vec![i.instance],
        scene::Draw::Rigid(r) => r.instances.iter().map(|&(_, i)| i).collect(),
        _ => vec![],
    }).collect();
    for r in 0..sc.instances.len() {
        let m = sc.meshes[sc.instances[r].mesh as usize];
        if m.emitters == 0 {
            continue;
        }
        sc.instances[r].first_emitter = emitter_tris.len() as u32;
        if let Some(g) = sc.gpu_instances.get_mut(r) {
            g.n[2][3] = f32::from_bits(emitter_tris.len() as u32);
        }
        let (a, b) = (m.first as usize, (m.first + m.count) as usize);
        let attrs = &sc.attrs[pool_first + a..pool_first + b];
        let numbered = |k: usize| (attrs[k].x[3].to_bits() as usize).checked_sub(1).map(|n| (n, attrs[k].uv[3].to_bits()));
        for (e, w) in instance_emitters(&sc.instances[r], r as u32, &sc.pool_tris[a..b], (pool_first + a) as u32, &numbered, m.emitters as usize, &sc.materials, moving.contains(&(r as u32))) {
            gpu_emitter_tris.push(GpuEmitterTri::of(&e, w, 0));
            emitter_tris.push(e);
        }
    }
    // Where each material's flattened static triangles are (runs of the traversal order, with their object), for a
    // material that starts emitting in the live view (tables.rs `apply`): its emitter entries are made from them in
    // place. Materials that also cover pool or dynamic triangles cannot (`fixed_mats`).
    let mut mat_runs: std::collections::HashMap<u32, Vec<[u32; 3]>> = std::collections::HashMap::new();
    let mut fixed_mats: std::collections::HashSet<u32> = sc.pool_attrs.iter().map(|a| a.uv[3].to_bits()).collect();
    for (k, a) in sc.attrs[..pool_first].iter().enumerate() {
        let (mat, obj) = (a.uv[3].to_bits(), a.x[1].to_bits());
        if tri_verts[k * 3][3].to_bits() & scene::TRI_DYNAMIC != 0 {
            fixed_mats.insert(mat);
            continue;
        }
        let runs = mat_runs.entry(mat).or_default();
        match runs.last_mut() {
            Some(r) if r[1] == k as u32 && r[2] == obj => r[1] += 1,
            _ => runs.push([k as u32, k as u32 + 1, obj]),
        }
    }
    let tri_order = bvh.order[..pool_first.min(bvh.order.len())].to_vec();
    // Many static emitters: a light tree samples them by importance at the shading point (`ltree`); each one's path
    // code with its triangle in the list (emit_mis). THREERT_LTREE=0: the CDF alone (A/B).
    // (Switched-off objects at full power: `switchable_power`.)
    let all_power: f32 = emitter_tris.iter().map(|e| switchable_power(e, &sc.materials, &sc.objects, sc.object_stride())).sum();
    let use_tree = std::env::var("THREERT_LTREE").map_or(true, |v| v != "0");
    let light_tree = if use_tree { light_tree_of(&emitter_tris, &|i| gpu_emitter_tris[i].vertices(), &sc.materials, &sc.objects, sc.object_stride(), sc.emitter_slot) } else { None };
    // The list keeps its own order (the tree and the CDF name its emitters: `emitter_order`); the tree's have their
    // codes.
    if let Some(t) = &light_tree {
        for (k, &i) in t.order.iter().enumerate() {
            emitter_tris[i as usize].in_tree = true;
            gpu_emitter_tris[i as usize].code |= t.code[k];
        }
    }
    // A triangle in world space names its emitter in its attributes (x.w = the entry + 1), for the rays that hit it
    // (emit_mis); a mesh's triangle is numbered among its mesh's, and its instance has the first.
    for (i, e) in emitter_tris.iter().enumerate().filter(|(_, e)| e.inst == NO_INST) {
        sc.attrs[e.tri as usize].x[3] = f32::from_bits(i as u32 + 1);
    }
    let (emitters, total, _) = emitter_cdf(&emitter_tris, &emitter_order(&emitter_tris, light_tree.as_ref()), &sc.materials, &sc.objects, sc.object_stride(), [0.0; 4], EmitterCull::default());
    // The moving emitters (after the tree's in the CDF) are picked with the probability of their share of power.
    let ltree_param = light_tree.as_ref().map_or([0.0; 4], |t| [0.0, f32::from_bits(t.order.len() as u32), if total > 0.0 { ((total - t.power) / total).max(0.0) } else { 0.0 }, ltree::RIS_OFFLINE as f32]);

    // Sky / environment.
    let t = Instant::now();
    let baked = bake_sky(&sc.sky, sc.environment.cloud_cover, sc.camera.position.y.max(0.0));
    // (The atmosphere's sun: its light's colour is what the bake leaves it.)
    if let (Some(i), Some(c)) = (sc.retained.sun.and_then(|s| sc.retained.light_nodes.iter().position(|n| *n == s)), baked.sun) {
        sc.lights[i].color = [c.x, c.y, c.z, 0.0];
    }
    let env_cdf = build_env_cdf(&baked.env);
    let procs = [0, sc.procs.len() as u32, sc.gpu_instances.len() as u32, 0];
    // Environment light sampling (one shadow ray per vertex) is skipped when the sky is negligible next to the emitters
    // (night streets): escaping BSDF rays still pick it up, with full MIS weight (`SkyBaked::write`). The emitters as
    // if all on: a time-of-day room loaded by day decides at dusk as one loaded at night does (live/edits.rs `put_sky`).
    let em_area: f32 = emitters[..emitter_tris.len()].iter().map(|e| e[3]).sum();
    let env_nee_floor = if emitter_tris.is_empty() { 0.0 } else { 0.01 * all_power / em_area.max(1e-6) };
    // The kernel's light order (`light_order`).
    let class = light_class;
    let order = light_order(&sc.lights);
    sc.lights = order.iter().map(|&i| sc.lights[i]).collect();
    if sc.retained.light_nodes.len() == order.len() {
        sc.retained.light_nodes = order.iter().map(|&i| sc.retained.light_nodes[i].clone()).collect();
    }
    let n_dir = sc.lights.iter().filter(|l| l.pos[3] == 0.0).count() as u32;
    let first_shadowed = sc.lights.iter().position(|l| class(l) == 2).unwrap_or(sc.lights.len()) as u32;
    timings.push(("sky_ms".into(), t.elapsed().as_secs_f64() * 1000.0));

    let cam = &sc.camera;
    let aspect = sc.width as f32 / sc.height as f32;
    let (lens_radius, focus) = match &cam.dof {
        Some(d) => {
            let sensor_h = d.sensor_width / aspect;
            let focal_mm = sensor_h / (2.0 * cam.tan_half_fov);
            (0.5 * focal_mm / d.f_stop / 1000.0, d.focus_distance)
        }
        None => (0.0, 1.0),
    };
    let params = gpu::Params {
        cam_pos: [cam.position.x, cam.position.y, cam.position.z, cam.tan_half_fov],
        cam_fwd: [cam.forward.x, cam.forward.y, cam.forward.z, aspect],
        cam_right: [cam.right.x, cam.right.y, cam.right.z, lens_radius],
        cam_up: [cam.up.x, cam.up.y, cam.up.z, focus],
        // （北冥：第 4 格预留，恒 0。上游在这里放种子，种子挪到了 `integrator.seed`。）
        size: [sc.width, sc.height, 0, 0],
        // (The preset's and the exposure's: `Params::set_preset`; the sky's: `SkyBaked::write`; the environment's:
        // `EnvSettings::write`. Below.)
        counts: [sc.lights.len() as u32, if total > 0.0 { emitter_tris.len() as u32 } else { 0 }, 0, 0],
        env: [0.0, 0.0, 0.0, -1.0],
        misc: [0.0, total, 0.0, 0.0],
        sky_color: [0.0; 4],
        counts2: [n_dir, 0, 0, first_shadowed],
        time: [sc.time, 0.0, 0.0, sc.media.len() as f32],
        fog: [0.0; 4],
        fog_color: [0.0; 4],
        vol: [0.0; 4],
        vol2: [0.0; 4],
        raster: [0.0; 4],
        cache: [0.0; 4],
        // (y is `render --signals`'.)
        motion: [0.0; 4],
        group_first: [[0; 4]; 2],
        light_lod: [0.0; 4],
        emit_power: [total, 0.0, 0.0, 0.0],
        aerial: [0.0; 4],
        background: [0.0; 4],
        lod_view: [0.0; 4],
        ltree: ltree_param,
        procs,
        ltile: [0; 4],
        ltile2: [0; 4],
        lt_cam: [[0.0; 4]; 4],
        // (`gpu::Uploaded::place`, with the buffers.)
        table_first: [[0; 4]; 3],
        word_first: [0; 4],
        // (`gpu::KernelBufs::place`, with what is traced into.)
        live_first: [[0; 4]; 2],
        live_len: [0; 4],
        integrator: gpu::KernelIntegrator::new(rng_seed()),
        // （不请求灯组。要灯组的调用方在渲之前换成 `KernelFilm::new(组数)`。）
        film: gpu::KernelFilm::new(0),
        // (`gpu::Uploaded::place`, with the buffers.)
        table_first_ext: [[0; 4]; 2],
        // （北冥：不查滤波表，像素内均匀抖动。要像素滤波的调用方换成 `KernelFilterTable::new`。）
        filter_table: gpu::KernelFilterTable::default(),
    };
    let mut params = params;
    params.set_preset(&sc.preset.native, &cam.exposure);
    baked.write(&mut params, env_nee_floor);
    sc.environment.write(&mut params);
    let env = baked.env;
    let mut first = 0u32;
    for (g, &count) in groups.iter().enumerate() {
        params.group_first[g / 4][g % 4] = first;
        first += u32::try_from(count).expect("more than 2^32 triangles");
    }
    let energy = energy_lut();
    Prepared { tri_verts, groups, nodes, emitters, gpu_emitter_tris, env, env_cdf, params, energy, emitter_tris, light_tree, env_nee_floor, mat_runs, fixed_mats, tri_order }
}

/// Instances as world-space triangles (software traversal), appended to the flattened ones with their objects.
fn flatten_instances(sc: &mut scene::Scene) {
    for inst in std::mem::take(&mut sc.instances) {
        if inst.hidden {
            continue;
        }
        let m = sc.meshes[inst.mesh as usize];
        let first = sc.tris.len() as u32;
        for k in m.first..m.first + m.count {
            if let Some(&c) = sc.pool_vcolors.get(k as usize) {
                scene::put_colors(&mut sc.vcolors, sc.tris.len(), Some(vec![c]));
            }
            sc.tris.push(inst.tri(&sc.pool_tris[k as usize]));
            sc.tri_flags.push(scene::instance_tri_flags(&inst, &sc.pool_attrs[k as usize], &sc.materials));
            sc.attrs.push(scene::instance_attr(&sc.pool_attrs[k as usize], inst.world, inst.object));
        }
        // A second range for the node when its glass / function part was flattened at build: node_tris joins them.
        sc.tri_nodes.push((inst.name, first, sc.tris.len() as u32));
        if let Some(i) = inst.sub {
            sc.tri_instances.push((first, sc.tris.len() as u32, i));
        }
    }
    sc.pool_tris.clear();
    sc.pool_attrs.clear();
    sc.meshes.clear();
}

/// Traversal group: shadow casting x alpha cutout, static (0..4) or dynamic (4..8: posed models, own BLASes).
fn group_of(flags: u32) -> usize {
    ((((flags & scene::TRI_NO_SHADOW) << 1) | ((flags & scene::TRI_MASKED) >> 1)) + (flags & scene::TRI_DYNAMIC)) as usize
}

/// Marginal (rows) + conditional (per row) CDFs over luminance * sin(theta).
fn build_env_cdf(env: &gpu::EnvMap) -> Vec<f32> {
    let (w, h) = (env.width as usize, env.height as usize);
    let mut cond = vec![0f32; w * h];
    let mut rows = vec![0f32; h];
    for y in 0..h {
        let sin_t = (((y as f32) + 0.5) / h as f32 * std::f32::consts::PI).sin();
        let mut acc = 0.0f32;
        for x in 0..w {
            let t = env.texels[y * w + x];
            acc += (0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]).max(0.0) * sin_t + 1e-12;
            cond[y * w + x] = acc;
        }
        rows[y] = acc;
        for x in 0..w {
            cond[y * w + x] /= acc;
        }
    }
    let total: f32 = rows.iter().sum();
    let mut marg = vec![0f32; h];
    let mut acc = 0.0;
    for y in 0..h {
        acc += rows[y] / total;
        marg[y] = acc;
    }
    marg.extend(cond);
    marg
}

/// A sky as the kernel takes it: the environment map (1 x 1 for a uniform sky or none), a uniform sky's radiance,
/// whether the map is one to sample, and the illuminance the atmosphere leaves its sun's light.
pub struct SkyBaked {
    pub env: gpu::EnvMap,
    pub color: Vec3,
    pub has_env: bool,
    pub sun: Option<Vec3>,
}

/// Bakes a scene's sky (`cloud_cover`: an atmosphere's; `altitude`: the camera's, m). The last atmosphere and the last
/// gradient are kept: edits that leave the sky's inputs as they were reuse the bake.
pub fn bake_sky(sky: &scene::SkyData, cloud_cover: f32, altitude: f32) -> SkyBaked {
    match sky {
        scene::SkyData::Atmosphere { sun_dir, sun_lux, rayleigh, mie, g: mie_g, ground, dynamic, glow, .. } => {
            static LAST: std::sync::Mutex<Option<(Vec<u32>, std::sync::Arc<sky::SkyBake>)>> = std::sync::Mutex::new(None);
            let alt = altitude;
            let (bw, bh) = if *dynamic { sky::DYNAMIC_SKY } else { (1024, 512) };
            let key: Vec<u32> = [*rayleigh, *mie, *mie_g, ground.x, ground.y, ground.z, sun_dir.x, sun_dir.y, sun_dir.z, sun_lux.x, sun_lux.y, sun_lux.z, alt, glow.uniform.x, glow.uniform.y, glow.uniform.z, glow.horizon.x, glow.horizon.y, glow.horizon.z, glow.height, bw as f32, cloud_cover].iter().map(|f| f.to_bits()).collect();
            let mut last = LAST.lock().unwrap();
            let bake = match last.as_ref() {
                Some((k, b)) if *k == key => b.clone(),
                _ => {
                    let atm = sky::Atmosphere::earth(*rayleigh, *mie, *mie_g, *ground);
                    let b = std::sync::Arc::new(if *dynamic || !glow.is_zero() || cloud_cover > 0.0 {
                        sky::bake_atmosphere_tables(&atm, &sky::SkyTables::new(&atm), *sun_dir, *sun_lux, alt, bw, bh, *glow, cloud_cover)
                    } else {
                        sky::bake_atmosphere(&atm, *sun_dir, *sun_lux, alt, bw, bh)
                    });
                    *last = Some((key, b.clone()));
                    b
                }
            };
            SkyBaked { env: gpu::EnvMap { width: bake.width, height: bake.height, texels: bake.texels.clone() }, color: Vec3::ZERO, has_env: true, sun: Some(bake.sun_illuminance) }
        }
        scene::SkyData::Gradient(gr) => {
            static LAST: std::sync::Mutex<Option<(sky::Gradient, std::sync::Arc<sky::SkyBake>)>> = std::sync::Mutex::new(None);
            let mut last = LAST.lock().unwrap();
            let bake = match last.as_ref() {
                Some((k, b)) if k == gr => b.clone(),
                _ => {
                    let b = std::sync::Arc::new(sky::bake_gradient(gr, 1024, 512));
                    *last = Some((gr.clone(), b.clone()));
                    b
                }
            };
            SkyBaked { env: gpu::EnvMap { width: bake.width, height: bake.height, texels: bake.texels.clone() }, color: Vec3::ZERO, has_env: true, sun: None }
        }
        scene::SkyData::Color(c) => SkyBaked { env: gpu::EnvMap { width: 1, height: 1, texels: vec![[c.x, c.y, c.z, 1.0]] }, color: *c, has_env: false, sun: None },
        scene::SkyData::None => SkyBaked { env: gpu::EnvMap { width: 1, height: 1, texels: vec![[0.0; 4]] }, color: Vec3::ZERO, has_env: false, sun: None },
    }
}

impl SkyBaked {
    /// The kernel's parameters for it: whether it is a map and its size, a uniform sky's colour, whether it is
    /// light-sampled (`floor`: `Prepared::env_nee_floor`).
    pub fn write(&self, p: &mut gpu::Params, floor: f32) {
        p.env = [if self.has_env { 1.0 } else { 0.0 }, self.env.width as f32, self.env.height as f32, p.env[3]];
        p.sky_color = [self.color.x, self.color.y, self.color.z, 0.0];
        p.counts2[1] = sky_sampled(sky_brightest(&self.env, self.color), floor, self.has_env) as u32;
    }
}

/// The brightest luminance a sky has (its map's texels, its uniform colour).
pub fn sky_brightest(env: &gpu::EnvMap, color: Vec3) -> f32 {
    env.texels.iter().map(|t| 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]).fold(0.0f32, f32::max).max(0.2126 * color.x + 0.7152 * color.y + 0.0722 * color.z)
}

/// Whether the sky is light-sampled (`Params::counts2[1]`): not when it is negligible next to the emitters (`floor`:
/// `Prepared::env_nee_floor`), nor a baked sky with THREERT_ENV_NEE off. A uniform sky reads no table: always.
pub fn sky_sampled(brightest: f32, floor: f32, has_env: bool) -> bool {
    brightest >= floor && (!has_env || env_nee_on())
}

/// UE GGXEnergyLookup equivalent: E.x = integral of D*Vis*NoL (F = 1), E.y = same weighted by (1-VoH)^5.
pub fn energy_lut() -> Vec<[f32; 4]> {
    let n = 32usize;
    let mut vals = vec![[0f32; 2]; n * n];
    for ry in 0..n {
        let roughness = (ry as f32 / (n - 1) as f32).max(0.02);
        let a = roughness * roughness;
        let a2 = a * a;
        for vx in 0..n {
            let nov = (vx as f32 / (n - 1) as f32).max(1e-3);
            let v = Vec3::new((1.0 - nov * nov).sqrt(), 0.0, nov);
            let (mut ex, mut ey) = (0.0f64, 0.0f64);
            let samples = 1024;
            for i in 0..samples {
                // Hammersley + GGX NDF sampling of H.
                let u1 = (i as f32 + 0.5) / samples as f32;
                let u2 = (i as u32).reverse_bits() as f32 / 4294967296.0;
                let phi = 2.0 * std::f32::consts::PI * u2;
                let cos_t = ((1.0 - u1) / (1.0 + (a2 - 1.0) * u1)).sqrt();
                let sin_t = (1.0 - cos_t * cos_t).sqrt();
                let hv = Vec3::new(sin_t * phi.cos(), sin_t * phi.sin(), cos_t);
                let l = 2.0 * v.dot(hv) * hv - v;
                let (nol, noh, voh) = (l.z, hv.z, v.dot(hv));
                if nol > 0.0 && voh > 0.0 {
                    let av = a;
                    let vis_v = nol * (nov * (1.0 - av) + av);
                    let vis_l = nov * (nol * (1.0 - av) + av);
                    let vis = 0.5 / (vis_v + vis_l);
                    // pdf_L = D * NoH / (4 VoH)  =>  D*Vis*NoL / pdf = Vis * NoL * 4 VoH / NoH
                    let est = (vis * nol * 4.0 * voh / noh) as f64;
                    let fc = (1.0 - voh).powi(5) as f64;
                    ex += est;
                    ey += est * fc;
                }
            }
            vals[ry * n + vx] = [(ex / samples as f64).min(1.0) as f32, (ey / samples as f64) as f32];
        }
    }
    vals.chunks(2).map(|c| [c[0][0], c[0][1], c[1][0], c[1][1]]).collect()
}

/// The glass energy table's nodes (pathtrace.wgsl GLASS_E_MU, _ROUGH, _IOR): cos(view) as its square root, roughness,
/// the index of refraction as sqrt((ior - 1) / (ior + 1)) up to `GLASS_E_ZMAX` (ior 3); and the side (entering,
/// leaving).
pub const GLASS_E: [usize; 3] = [16, 16, 8];
pub const GLASS_E_ZMAX: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// Unpolarised Fresnel reflectance of a dielectric interface: `c` the cosine on the incident side, `eta` = n_t / n_i;
/// 1 at total internal reflection (Walter et al. 2007, eq. 22).
fn fresnel_dielectric(c: f64, eta: f64) -> f64 {
    let g2 = eta * eta - 1.0 + c * c;
    if g2 <= 0.0 {
        return 1.0;
    }
    let g = g2.sqrt();
    let (a, b) = ((g - c) / (g + c), (c * (g + c) - 1.0) / (c * (g - c) + 1.0));
    0.5 * a * a * (1.0 + b * b)
}

/// What a rough dielectric interface (GGX, single scattering: the kernel's `dielectric_*`) returns of a uniform white
/// surround toward a direction at cosine `mu`: reflection + transmission, without the tint. `alpha` = roughness^2,
/// `eta` = n(far side) / n(view side). By `n` x `n` stratified visible normals (Heitz 2018), whose estimator is
/// bounded: G2 / G1, reflected or refracted by Fresnel at the normal.
pub fn glass_energy(mu: f64, alpha: f64, eta: f64, n: usize) -> f64 {
    let a2 = alpha * alpha;
    let lambda = |c: f64| {
        let c = c.abs().min(1.0);
        0.5 * (-1.0 + (1.0 + a2 * (1.0 - c * c) / (c * c)).sqrt())
    };
    let v = [(1.0 - mu * mu).max(0.0).sqrt(), 0.0, mu];
    let k = (alpha * alpha * v[0] * v[0] + v[2] * v[2]).sqrt();
    let vh = [alpha * v[0] / k, 0.0, v[2] / k];
    // (t1 = (0, 1, 0), t2 = vh x t1.)
    let t2 = [-vh[2], 0.0, vh[0]];
    let (lv, s) = (lambda(mu), 0.5 * (1.0 + vh[2]));
    let mut sum = 0.0;
    for i in 0..n {
        for j in 0..n {
            let (r, phi) = (((i as f64 + 0.5) / n as f64).sqrt(), 2.0 * std::f64::consts::PI * (j as f64 + 0.5) / n as f64);
            let p1 = r * phi.cos();
            let p2 = (1.0 - s) * (1.0 - p1 * p1).max(0.0).sqrt() + s * r * phi.sin();
            let pz = (1.0 - p1 * p1 - p2 * p2).max(0.0).sqrt();
            let nh = [p2 * t2[0] + pz * vh[0], p1, p2 * t2[2] + pz * vh[2]];
            let m = [alpha * nh[0], alpha * nh[1], nh[2].max(0.0)];
            let len = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
            let m = [m[0] / len, m[1] / len, m[2] / len];
            let vm = v[0] * m[0] + v[2] * m[2];
            let f = fresnel_dielectric(vm, eta);
            // Reflection: the kernel's joint visibility (vis_smith_joint_approx x 4 nov nol) over G1(v).
            let nol = 2.0 * vm * m[2] - v[2];
            if nol > 0.0 {
                let g2 = 2.0 * mu * nol / (nol * (mu * (1.0 - alpha) + alpha) + mu * (nol * (1.0 - alpha) + alpha)).max(1e-7);
                sum += f * g2 * (1.0 + lv);
            }
            // Refraction (eq. 40): height-correlated Smith over G1(v).
            let c2 = 1.0 - (1.0 - vm * vm) / (eta * eta);
            if f < 1.0 && c2 > 0.0 {
                let lz = (vm / eta - c2.sqrt()) * m[2] - v[2] / eta;
                if lz < 0.0 {
                    sum += (1.0 - f) * (1.0 + lv) / (1.0 + lv + lambda(lz));
                }
            }
        }
    }
    sum / (n * n) as f64
}

/// 北冥：广义 Schlick 的一张表有几个数（16×16×16）。
pub const GGX_GEN_SCHLICK_LEN: usize = 4096;

/// 北冥：Cycles 的 table_ggx_gen_schlick_ior_s 与 table_ggx_gen_schlick_s 接在一起（各 `GGX_GEN_SCHLICK_LEN` 个），
/// 从 ../shaders/ggx_gen_schlick.tables 读（`//` 开头的行是注释，其余是带 f 后缀、逗号分隔的数）。内核按 float 读
/// （`heap::Table::GgxGenSchlickIorS`、`GgxGenSchlickS`；pathtrace.wgsl 的 `lookup_table_fetch`）。
pub fn ggx_gen_schlick_tables() -> &'static [f32] {
    static T: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let v: Vec<f32> = include_str!("../../shaders/ggx_gen_schlick.tables")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .flat_map(|l| l.split(','))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_end_matches('f').parse::<f32>().expect("ggx_gen_schlick.tables: a number"))
            .collect();
        assert_eq!(v.len(), 2 * GGX_GEN_SCHLICK_LEN, "ggx_gen_schlick.tables");
        v
    })
}

/// `glass_energy` over the table's nodes, entering then leaving, four values a vec4 (`heap::Table::GlassEnergy`; once
/// a process, 35 ms).
pub fn glass_energy_lut() -> &'static [[f32; 4]] {
    static LUT: std::sync::OnceLock<Vec<[f32; 4]>> = std::sync::OnceLock::new();
    LUT.get_or_init(|| {
        let [nm, nr, nz] = GLASS_E;
        let mut vals = Vec::with_capacity(2 * nz * nr * nm);
        for side in 0..2 {
            for iz in 0..nz {
                let z = (iz as f64 / (nz - 1) as f64 * GLASS_E_ZMAX).max(0.02);
                let ior = (1.0 + z * z) / (1.0 - z * z);
                for ir in 0..nr {
                    let r = (ir as f64 / (nr - 1) as f64).max(0.02);
                    for im in 0..nm {
                        let y = im as f64 / (nm - 1) as f64;
                        vals.push(glass_energy((y * y).max(1e-3), r * r, if side == 0 { ior } else { 1.0 / ior }, 24).clamp(0.05, 1.0) as f32);
                    }
                }
            }
        }
        vals.chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect()
    })
}

#[cfg(test)]
mod glass_energy_tests {
    use super::*;

    fn lambda(a2: f64, c: f64) -> f64 {
        let c = c.abs().min(1.0);
        0.5 * (-1.0 + (1.0 + a2 * (1.0 - c * c) / (c * c)).sqrt())
    }

    /// The kernel's `dielectric_t`: the interface's transmission x |n.l| (Walter et al. 2007 eq. 21 from the view
    /// side; n = +y, v above, l below).
    fn transmitted(v: [f64; 3], l: [f64; 3], a2: f64, eta: f64) -> f64 {
        let h = [v[0] + eta * l[0], v[1] + eta * l[1], v[2] + eta * l[2]];
        let k = (h[0] * h[0] + h[1] * h[1] + h[2] * h[2]).sqrt() * h[1].signum();
        let h = [h[0] / k, h[1] / k, h[2] / k];
        let (voh, loh) = (v[0] * h[0] + v[1] * h[1] + v[2] * h[2], l[0] * h[0] + l[1] * h[1] + l[2] * h[2]);
        if voh <= 0.0 || loh >= 0.0 {
            return 0.0;
        }
        let d = (h[1] * a2 - h[1]) * h[1] + 1.0;
        let den = voh + eta * loh;
        (1.0 - fresnel_dielectric(voh, eta)) * a2 / (std::f64::consts::PI * d * d) * voh * eta * eta * -loh / (v[1] * den * den * (1.0 + lambda(a2, v[1]) + lambda(a2, l[1])))
    }

    /// (R, T) of one interface toward a view at cosine `mu`: the BSDF's value x cosine integrated over the directions
    /// of each side (`n` x 2 `n` points). What the kernel's light samples sum; the table's estimator is its sampling.
    fn interface(mu: f64, alpha: f64, eta: f64, n: usize) -> (f64, f64) {
        let a2 = alpha * alpha;
        let v = [(1.0 - mu * mu).sqrt(), mu, 0.0];
        let (mut r, mut t) = (0.0, 0.0);
        for i in 0..n {
            let c = (i as f64 + 0.5) / n as f64;
            let st = (1.0 - c * c).sqrt();
            for j in 0..2 * n {
                let phi = std::f64::consts::PI * (j as f64 + 0.5) / n as f64;
                let (x, z) = (st * phi.cos(), st * phi.sin());
                // Reflection: D x the kernel's joint visibility x Fresnel at the half vector.
                let h = [v[0] + x, v[1] + c, z];
                let k = (h[0] * h[0] + h[1] * h[1] + h[2] * h[2]).sqrt();
                let (noh, voh) = (h[1] / k, (v[0] * h[0] + v[1] * h[1]) / k);
                let d = (noh * a2 - noh) * noh + 1.0;
                let vis = 0.5 / (c * (mu * (1.0 - alpha) + alpha) + mu * (c * (1.0 - alpha) + alpha)).max(1e-7);
                r += a2 / (std::f64::consts::PI * d * d) * vis * fresnel_dielectric(voh, eta) * c;
                t += transmitted(v, [x, -c, z], a2, eta);
            }
        }
        let k = std::f64::consts::PI / (n * n) as f64;
        (r * k, t * k)
    }

    /// The table's estimator against the BSDF's integral; the numbers the `glass/rough-*` render tests expect; the
    /// table's cost.
    #[test]
    fn the_glass_energy_is_the_interfaces() {
        for (r, eta, mu) in [(0.3, 1.5, 0.7071), (0.3, 1.0 / 1.5, 0.7071), (0.6, 1.5, 0.4), (0.6, 1.0 / 1.5, 0.9), (1.0, 1.5, 0.9), (1.0, 1.0 / 1.5, 0.9), (0.5, 1.33, 0.2), (0.8, 1.0 / 1.33, 0.5)] {
            let (e, (qr, qt)) = (glass_energy(mu, r * r, eta, 24), interface(mu, r * r, eta, 700));
            assert!((e - qr - qt).abs() < 0.012 * (qr + qt), "roughness {r}, eta {eta:.3}, cos {mu}: {e:.4} for {:.4}", qr + qt);
        }
        // tests/render/glass-rough-enter.ts, -leave.ts, -leave-low.ts (roughness 0.6, ior 1.5).
        let c45 = std::f64::consts::FRAC_1_SQRT_2;
        for (eta, mu, want) in [(1.5, c45, 0.9573), (1.0 / 1.5, c45, 0.7390), (1.0 / 1.5, 0.4, 0.6474)] {
            let ((qr, qt), e) = (interface(mu, 0.36, eta, 1000), glass_energy(mu, 0.36, eta, 192));
            eprintln!("eta {eta:.3}, cos {mu:.4}: R {qr:.4} + T {qt:.4} = {:.4}; by visible normals {e:.4}", qr + qt);
            assert!((qr + qt - want).abs() < 1e-3 && (e - want).abs() < 5e-4, "eta {eta:.3}, cos {mu}: R {qr:.4} + T {qt:.4}, {e:.4} for {want}");
        }
        let t = std::time::Instant::now();
        let lut = glass_energy_lut();
        assert_eq!(lut.len() * 4, 2 * GLASS_E[0] * GLASS_E[1] * GLASS_E[2]);
        assert!(lut.iter().flatten().all(|e| (0.05..=1.0).contains(e)));
        eprintln!("glass energy table: {:.0} ms", t.elapsed().as_secs_f64() * 1e3);
    }

    /// tests/render/glass-rough-lamp.ts and -wide.ts: what a square emitter of side `side`, 1 m under a sheet of
    /// glass (roughness 0.6, ior 1.5) where the 45-degree view's refracted ray arrives, sends through the sheet, as
    /// a fraction of its radiance: `transmitted` integrated over the emitter's area.
    #[test]
    fn the_lamp_through_frosted_glass() {
        let (a2, eta) = (0.6f64.powi(4), 1.5f64);
        let c45 = std::f64::consts::FRAC_1_SQRT_2;
        let v = [0.0, c45, c45];
        // The refracted ray's foot 1 m down (the test's lamp is centred there: z = -0.5345).
        let st = c45 / eta;
        let cz = -st / (1.0 - st * st).sqrt();
        assert!((cz + 0.5345).abs() < 1e-4);
        for (side, want) in [(0.3, 0.40415), (1.0, 0.83641)] {
            let n = 600;
            let mut sum = 0.0;
            for i in 0..n {
                let x = ((i as f64 + 0.5) / n as f64 - 0.5) * side;
                for j in 0..n {
                    let z = cz + ((j as f64 + 0.5) / n as f64 - 0.5) * side;
                    let d2 = x * x + 1.0 + z * z;
                    let d = d2.sqrt();
                    sum += transmitted(v, [x / d, -1.0 / d, z / d], a2, eta) / (d * d2);
                }
            }
            let got = sum * (side / n as f64).powi(2);
            assert!((got - want).abs() < 2e-4, "a {side} m lamp: {got:.5} for {want}");
        }
    }

    /// Whether the table's nodes are enough: the kernel's lookup (pathtrace.wgsl `glass_energy`, trilinear over the
    /// nodes; copied here) against the estimator between them.
    #[test]
    fn the_glass_energy_table_interpolates() {
        let lut = glass_energy_lut();
        let at = |i: usize| lut[i / 4][i % 4] as f64;
        let [nm, nr, nz] = GLASS_E;
        let look = |mu: f64, r: f64, ior: f64, leaving: bool| {
            let x = (mu.sqrt() * (nm - 1) as f64).clamp(0.0, (nm - 1) as f64);
            let y = (r * (nr - 1) as f64).clamp(0.0, (nr - 1) as f64);
            let z = (((ior - 1.0).max(0.0) / (ior + 1.0)).sqrt() * (nz - 1) as f64 / GLASS_E_ZMAX).clamp(0.0, (nz - 1) as f64);
            let (x0, y0, z0) = (x as usize, y as usize, z as usize);
            let (x1, y1, z1) = ((x0 + 1).min(nm - 1), (y0 + 1).min(nr - 1), (z0 + 1).min(nz - 1));
            let (fx, fy, fz) = (x - x0 as f64, y - y0 as f64, z - z0 as f64);
            let plane = |zi: usize| {
                let b = (if leaving { nz } else { 0 } + zi) * nr * nm;
                let row = |yi: usize| at(b + yi * nm + x0) * (1.0 - fx) + at(b + yi * nm + x1) * fx;
                row(y0) * (1.0 - fy) + row(y1) * fy
            };
            plane(z0) * (1.0 - fz) + plane(z1) * fz
        };
        let (mut worst, mut sum, mut n) = ((0.0f64, String::new()), 0.0, 0);
        for leaving in [false, true] {
            for ior in [1.2, 1.33, 1.5, 1.8, 2.4] {
                for ri in 0..12 {
                    let r = 0.08 + ri as f64 * 0.08;
                    for mi in 0..24 {
                        let mu = 0.02 + mi as f64 * 0.0408;
                        let (t, e) = (look(mu, r, ior, leaving), glass_energy(mu, r * r, if leaving { 1.0 / ior } else { ior }, 48));
                        let d = (t - e).abs() / e;
                        sum += d;
                        n += 1;
                        if d > worst.0 {
                            worst = (d, format!("ior {ior} r {r:.2} mu {mu:.3} leaving {leaving}: table {t:.4}, direct {e:.4}"));
                        }
                    }
                }
            }
        }
        eprintln!("glass energy table against the estimator: mean {:.4}, worst {:.4} ({})", sum / n as f64, worst.0, worst.1);
        assert!(sum / (n as f64) < 0.01 && worst.0 < 0.05, "mean {:.4}, worst {:.4} ({})", sum / n as f64, worst.0, worst.1);
    }
}

#[cfg(test)]
mod light_lod_tests {
    use super::*;

    fn light(p: [f32; 3], range: f32, shadowed: bool) -> scene::GpuLight {
        scene::GpuLight { pos: [p[0], p[1], p[2], 1.0], dir: [0.0, 0.0, 0.0, 0.05], color: [1.0, 1.0, 1.0, range], ext: [0.0, 0.0, 0.0, shadowed as u32 as f32], x: [1.0; 4] }
    }

    #[test]
    fn emitters_switched_off_at_load_are_in_the_light_tree() {
        // 600 triangles in a row, 100 on object 0 (on) and 500 on object 1 (switched off at load): too few on for a
        // tree of their own (MIN_STATIC), yet all are in it, at zero weight. Switched on in place and refit, the tree is
        // the one a load with all of them on builds: the plain build's, its powers summed bottom-up.
        let mats = [scene::GpuMaterial { emissive: [1.0, 1.0, 1.0, 0.0], ..Default::default() }];
        let tris: Vec<EmitterTri> = (0..600u32)
            .map(|i| EmitterTri { tri: i, mat: 0, obj: (i % 6 != 0) as u32, area: 0.5, c: [2.0 * i as f32 + 1.0 / 3.0, 1.0 / 3.0, 0.0], moves: false, nominal: false, in_tree: false, inst: NO_INST })
            .collect();
        let verts: Vec<[f32; 4]> = (0..600).flat_map(|i| [[2.0 * i as f32, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]]).collect();
        let (off, on) = ([[0.0, 0.0, 0.0, 1.0], [0.0; 4]], [[0.0, 0.0, 0.0, 1.0]; 2]);
        let rows = |i: usize| ltree::tri_vertices(&verts[i * 3..i * 3 + 3]);
        assert!(ltree::build(&tris, &rows, &|i| emitter_power(&tris[i], &mats, &off, 1)).is_none());
        let mut t = light_tree_of(&tris, &rows, &mats, &off, 1, false).unwrap();
        assert_eq!(t.order.len(), 600);
        assert!((t.power - 100.0 * 0.5).abs() < 1e-3, "{}", t.power);
        let loaded = light_tree_of(&tris, &rows, &mats, &on, 1, false).unwrap();
        let plain = ltree::build(&tris, &rows, &|i| emitter_power(&tris[i], &mats, &on, 1)).unwrap();
        let bits = |t: &ltree::LightTree| t.nodes.iter().map(|n| n.map(f32::to_bits)).collect::<Vec<_>>();
        assert_eq!((bits(&loaded), &loaded.order), (bits(&plain), &plain.order));
        let w: Vec<f32> = t.order.iter().map(|&i| emitter_power(&tris[i as usize], &mats, &on, 1)).collect();
        t.refit(&|k| w[k]);
        assert_eq!(t.order, loaded.order);
        for (a, b) in t.nodes.iter().zip(&loaded.nodes) {
            assert_eq!([a[0], a[1], a[3]].map(f32::to_bits), [b[0], b[1], b[3]].map(f32::to_bits));
            assert!((a[2] - b[2]).abs() <= 1e-4 * b[2], "{} {}", a[2], b[2]);
        }
    }

    #[test]
    fn emitter_guide_finds_what_the_full_search_finds() {
        // 3000 triangles over six decades of power, light LOD on, some switched off (material 0 is black).
        let mut seed = 11u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            seed
        };
        let mut unit = || (rnd() >> 8) as f32 / (1 << 24) as f32;
        let mats: Vec<scene::GpuMaterial> = (0..4).map(|k| scene::GpuMaterial { emissive: [k as f32 * 3.0, k as f32, 0.5 * k as f32, 0.0], ..Default::default() }).collect();
        let tris: Vec<EmitterTri> = (0..3000)
            .map(|i| EmitterTri { tri: i, mat: if i % 9 == 0 { 0 } else { 1 + i % 3 }, obj: 0, area: 10f32.powf(-6.0 * unit()), c: [300.0 * unit(), 5.0, 100.0 * unit()], moves: i % 50 == 0, nominal: false, in_tree: false, inst: NO_INST })
            .collect();
        let (t, total, _) = emitter_cdf(&tris, &emitter_order(&tris, None), &mats, &[], 3, [20.0, 0.0, 30.0, 10.0], EmitterCull::default());
        let n = tris.len() as u32;
        assert!(total > 0.0);
        assert_eq!(t.len(), tris.len() + (EMITTER_GUIDE + 1).div_ceil(4));
        // pathtrace.wgsl: the search over [lo, hi), the guide table, emitter_pick.
        let search = |mut lo: u32, mut hi: u32, u: f32| {
            while lo < hi {
                let mid = (lo + hi) / 2;
                if t[mid as usize][1] < u { lo = mid + 1 } else { hi = mid }
            }
            lo.min(n - 1)
        };
        let guide = |k: u32| t[(n + k / 4) as usize][(k % 4) as usize].to_bits();
        let pick = |u: f32| {
            let k = ((u * EMITTER_GUIDE as f32) as u32).min(EMITTER_GUIDE as u32 - 1);
            search(guide(k), guide(k + 1), u)
        };
        // Random 24-bit u, the bucket edges and their neighbours, and every entry's own cumulative weight.
        let mut us: Vec<u32> = (0..200_000).map(|_| rnd() >> 8).collect();
        for k in 0..=EMITTER_GUIDE as u32 {
            let m = k << 12;
            us.extend([m.saturating_sub(1), m, m + 1].into_iter().filter(|&m| m < 1 << 24));
        }
        us.extend(t[..tris.len()].iter().map(|e| ((e[1] * (1 << 24) as f32) as u32).min((1 << 24) - 1)));
        for m in us {
            let u = m as f32 / (1 << 24) as f32;
            assert_eq!(pick(u), search(0, n, u), "u = {u}");
        }
    }

    #[test]
    fn emitter_lod_falls_off_beyond_d0() {
        let none = EmitterCull::default();
        let cull = EmitterCull { radius: 60.0, ..none };
        assert_eq!(emitter_lod([50.0, 0.0, 0.0], [0.0; 4], none), 1.0);
        assert_eq!(emitter_lod([5.0, 0.0, 0.0], [0.0, 0.0, 0.0, 10.0], none), 1.0);
        assert!((emitter_lod([40.0, 0.0, 0.0], [0.0, 0.0, 0.0, 10.0], none) - 1.0 / 16.0).abs() < 1e-6);
        assert!((emitter_lod([40.0, 0.0, 0.0], [0.0, 0.0, 0.0, 10.0], cull) - 1.0 / 16.0).abs() < 1e-6);
        assert_eq!(emitter_lod([70.0, 0.0, 0.0], [0.0, 0.0, 0.0, 10.0], cull), 0.0);
    }

    #[test]
    fn emitter_cull_keeps_the_view_cone() {
        // Looking down +x, cone half-angle 60 degrees, reach 240 m.
        let cull = EmitterCull { radius: 60.0, far: 240.0, dir: [1.0, 0.0, 0.0], cos: 0.5 };
        let lod = [0.0, 0.0, 0.0, 10.0];
        assert!((emitter_lod([100.0, 0.0, 0.0], lod, cull) - 0.01).abs() < 1e-6); // ahead: kept
        assert_eq!(emitter_lod([50.0, 140.0, 0.0], lod, cull), 0.0); // 70 degrees off, 149 m: outside the cone
        assert!(emitter_lod([100.0, 100.0, 0.0], lod, cull) > 0.0); // 45 degrees, 141 m: kept
        assert_eq!(emitter_lod([-100.0, 0.0, 0.0], lod, cull), 0.0); // behind
        assert_eq!(emitter_lod([300.0, 0.0, 0.0], lod, cull), 0.0); // beyond the reach
        assert!(emitter_lod([0.0, 50.0, 0.0], lod, cull) > 0.0); // beside, within the radius
    }

    #[test]
    fn light_groups_hold_every_light_they_skip() {
        // Pseudo-random lights over a 500 x 200 m district: directional, unshadowed, shadowed, one without a range.
        let mut seed = 7u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1 << 24) as f32
        };
        let mut lights = vec![scene::GpuLight { pos: [0.0, 0.0, 0.0, 0.0], ..Default::default() }];
        for k in 0..300 {
            lights.push(light([500.0 * rnd(), 10.0 * rnd(), 200.0 * rnd() - 100.0], 5.0 + 25.0 * rnd(), k % 10 == 0));
        }
        lights[150].color[3] = 0.0;
        let order = light_order(&lights);
        let mut seen = order.clone();
        seen.sort();
        assert_eq!(seen, (0..lights.len()).collect::<Vec<_>>(), "a permutation");
        let sorted: Vec<_> = order.iter().map(|&i| lights[i]).collect();
        let classes: Vec<u8> = sorted.iter().map(light_class).collect();
        assert!(classes.windows(2).all(|w| w[0] <= w[1]), "classes stay in order");
        let table = light_groups(&sorted);
        let nd = 1;
        assert_eq!(table.len(), (sorted.len() - nd).div_ceil(LIGHT_GROUP));
        for (i, l) in sorted.iter().enumerate().skip(nd) {
            let g = table[(i - nd) / LIGHT_GROUP];
            let d = Vec3::new(g[0], g[1], g[2]).distance(Vec3::from_slice(&l.pos[..3]));
            assert!(d + light_reach(l) <= g[3], "light {i} reaches out of its group's sphere");
        }
        // Spatially compact: the groups' mean radius well under that of the same classes in their original order.
        let mut plain: Vec<usize> = (0..lights.len()).collect();
        plain.sort_by_key(|&i| light_class(&lights[i]));
        let unsorted = light_groups(&plain.iter().map(|&i| lights[i]).collect::<Vec<_>>());
        let mean = |t: &[[f32; 4]]| {
            let r: Vec<f32> = t.iter().map(|g| g[3]).filter(|r| *r < f32::MAX).collect();
            r.iter().sum::<f32>() / r.len() as f32
        };
        assert!(mean(&table) < 0.5 * mean(&unsorted), "groups are compact: {} vs {}", mean(&table), mean(&unsorted));
    }

    /// Black lights (off, or hidden) are in no group's sphere: one parked far away does not widen its group, and a
    /// group of them alone holds no point.
    #[test]
    fn black_lights_reach_nothing() {
        let at = |x: f32, lit: bool| scene::GpuLight { pos: [x, 0.0, 0.0, 1.0], color: [if lit { 1.0 } else { 0.0 }, 0.0, 0.0, 10.0], ..Default::default() };
        // 16 lit lights within 15 m and, in their group's place, one of them black 10 km away: the sphere as without it.
        let mut near: Vec<_> = (0..LIGHT_GROUP).map(|k| at(k as f32, true)).collect();
        let lit = light_groups(&near)[0];
        near[3] = at(-10_000.0, false);
        let with_black = light_groups(&near)[0];
        assert!(with_black[3] <= lit[3] && with_black[3] > 0.0, "{with_black:?} for {lit:?}");
        // A group of black lights alone: radius -1.
        let dark: Vec<_> = (0..LIGHT_GROUP + 2).map(|k| at(k as f32, k < LIGHT_GROUP)).collect();
        let t = light_groups(&dark);
        assert!(t[0][3] > 0.0);
        assert_eq!(t[1][3], -1.0);
    }
}
