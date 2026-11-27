// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：求交），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// SPDX-FileCopyrightText: 2026 Meshy LLC
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: MIT AND Apache-2.0
// 多方许可。上游的与北冥新写的部分是 MIT。照 Cycles（Blender v5.2.3，路径相对 intern/cycles/）取的部分是 Apache-2.0
// （许可全文见仓库根的 LICENSES/Apache-2.0.txt）：
//   LOCAL_MAX_HITS 的名字与数值、LocalIntersection 的字段名：kernel/types.h
//   trace_local 这个问法（只查同一个物体、返回至多几个命中）：kernel/bvh/bvh.h（scene_intersect_local）
//   local_record 收命中的规则（同距离不重复收、满了按蓄水池抽样替换、max_hits 为 0 只问有没有命中）：
//   kernel/device/cpu/bvh.h（kernel_embree_filter_occluded_local_func_impl），照原式重写
// ------------------------------------------------------------------------------------------------
// Intersection

// `inst`: the model instance whose model-space triangle `tri` is (F_INST), NO_INST for world-space triangles.
struct Hit { t: f32, tri: u32, u: f32, v: f32, inst: u32 };

// 北冥：「只查同一个物体」的问法（倒角、遮蔽这类图案节点用），照 Cycles 的 scene_intersect_local（kernel/bvh/bvh.h）
// 与它在处理器上的实现（kernel/device/cpu/bvh.h 的 kernel_embree_filter_occluded_local_func_impl）：
//   ray         光线（integrator.wgsl 的 Ray）：只收 tmin < t < tmax 的命中
//   object      物体表的下标（着色点的 object）：只收这个物体上的命中，别的物体当不存在
//   lcg_state   命中多于 max_hits 时随机留下哪几个（蓄水池抽样）用的小随机数状态；用过之后的状态在返回值里带回
//   max_hits    最多留几个，不超过 LOCAL_MAX_HITS；0：只问有没有命中（找到第一个就返回，num_hits 记 1，不留命中）
// 跳过的图元同 trace：模块级的 trace_self（遮蔽节点设它，Cycles 的 ray.self.prim）。
// num_hits 照 Cycles 是找到的命中总数，可以大于 max_hits；hits 里前 min(num_hits, max_hits) 个有效，不保证按距离排序。
// 两条求交路上做法不同：软件求交在 BVH 遍历里按物体号过滤、收齐区间里的全部命中；硬件求交下不新增光线查询的源码位置，
// 在现有的 trace 上逐次步进（每次从上一个命中处出发、跳过刚命中的三角形，最多 LOCAL_STEPS 步）、按物体号过滤来拼，
// 不用候选循环（上游记录过候选循环在 Metal 上丢命中）。步进的漏命中率两台显卡上的实测见 ../STRUCTURES.md「求交」。
// 阴影类的问法只许判断挡没挡住，不许读返回的三角号。
const LOCAL_MAX_HITS: u32 = 4u;
const LOCAL_STEPS: u32 = 16u;
struct LocalHit { t: f32, tri: u32, u: f32, v: f32, inst: u32 };
struct LocalIntersection {
    num_hits: u32,                          // 找到的命中总数（照 Cycles，可以大于 max_hits）
    hits: array<LocalHit, LOCAL_MAX_HITS>,  // 前 min(num_hits, max_hits) 个有效，不保证按距离排序
    lcg_state: u32,                         // 用过之后的小随机数状态
};

// 收一个命中，照 Cycles 的 kernel_embree_filter_occluded_local_func_impl 里带 lcg_state 的那一支：与已留下的命中距离相同的
// 不算（同一点打在两个三角形的公共边上）；满了之后按蓄水池抽样随机替换。max_hits 为 0 的调用方不经这里
fn local_record(r: ptr<function, LocalIntersection>, h: LocalHit, max_hits: u32) {
    let kept = min(max_hits, (*r).num_hits);
    for (var i = 0u; i < kept; i++) {
        if ((*r).hits[i].t == h.t) { return; }
    }
    (*r).num_hits += 1u;
    var idx = (*r).num_hits - 1u;
    if ((*r).num_hits > max_hits) {
        (*r).lcg_state = lcg_step_uint((*r).lcg_state);
        idx = (*r).lcg_state % (*r).num_hits;
        if (idx >= max_hits) { return; }
    }
    (*r).hits[idx] = h;
}

// 一个命中落在哪个物体上（着色点的 object 的取法，shader_setup_from_hit）
fn hit_object(h: Hit) -> u32 {
    if (is_proc(h)) { return instance_at(h.inst).info.y; }
    var a = attrs[h.tri];
    if (has(F_INST) && h.inst != NO_INST) { a = inst_attr(instance_at(h.inst), a); }
    return object_of(a);
}

@if(!hwrt) fn trace_local(ray: Ray, object: u32, lcg_state: u32, max_hits: u32) -> LocalIntersection {
    var r = LocalIntersection();
    r.lcg_state = lcg_state;
    let o = ray.P;
    let d = ray.D;
    let inv_d = 1.0 / select(d, vec3<f32>(1e-20), abs(d) < vec3<f32>(1e-20));
    var stack: array<u32, 48>;
    var sp = 0u;
    var node = 0u;
    loop {
        let n = nodes[node];
        if (n.count > 0u) {
            for (var k = 0u; k < n.count; k++) {
                let ti = n.left_or_first + k;
                if (hit_self(ti, NO_INST) || object_of(attrs[ti]) != object) { continue; }
                let x = intersect_tri(o, d, ti, ray.tmax);
                if (!(x.x > ray.tmin && x.x < ray.tmax)) { continue; }
                if (max_hits == 0u) {
                    r.num_hits = 1u;
                    return r;
                }
                var lh = LocalHit();
                lh.t = x.x;
                lh.tri = ti;
                lh.u = x.y;
                lh.v = x.z;
                lh.inst = NO_INST;
                local_record(&r, lh, max_hits);
            }
            if (sp == 0u) { break; }
            sp--;
            node = stack[sp];
            continue;
        }
        let l = n.left_or_first;
        let tl = ray_aabb(o, inv_d, nodes[l].bmin, nodes[l].bmax, ray.tmax);
        let tr = ray_aabb(o, inv_d, nodes[l + 1u].bmin, nodes[l + 1u].bmax, ray.tmax);
        if (tl == INF && tr == INF) {
            if (sp == 0u) { break; }
            sp--;
            node = stack[sp];
            continue;
        }
        if (tl == INF) {
            node = l + 1u;
        } else {
            node = l;
            if (tr != INF && sp < 48u) {
                stack[sp] = l + 1u;
                sp++;
            }
        }
    }
    return r;
}

@if(hwrt) fn trace_local(ray: Ray, object: u32, lcg_state: u32, max_hits: u32) -> LocalIntersection {
    var r = LocalIntersection();
    r.lcg_state = lcg_state;
    let self_in = trace_self;
    var o = ray.P;
    var base = 0.0;
    for (var k = 0u; k < LOCAL_STEPS; k++) {
        let h = trace(o, ray.D, ray.tmax - base, TRACE_CLOSEST);
        if (h.tri == 0xffffffffu) { break; }
        let t = base + h.t;
        if (t >= ray.tmax) { break; }
        if (!is_proc(h) && t > ray.tmin && hit_object(h) == object) {
            if (max_hits == 0u) {
                r.num_hits = 1u;
                break;
            }
            var lh = LocalHit();
            lh.t = t;
            lh.tri = h.tri;
            lh.u = h.u;
            lh.v = h.v;
            lh.inst = h.inst;
            local_record(&r, lh, max_hits);
        }
        // 下一步从这个命中处出发，跳过刚命中的三角形
        o = o + ray.D * h.t;
        base = t;
        trace_self = vec2<u32>(h.tri, h.inst);
    }
    trace_self = self_in;
    return r;
}
const NO_INST: u32 = 0xffffffffu;

// ------------------------------------------------------------------------------------------------
// Procedural geometry (F_PROC; scene::ProcObject): a game's boxes and its geometry function (`gf_<name>`), which
// intersects the object-space ray with what one box holds; the hardware (or the software loop below) finds the boxes.
// A procedural object's record in `instances` follows the model instances': world rows, normal rows, info = (header
// word in proc_data, object, geometry function, casts shadows), the previous frame's world rows. Its hits are
// Hit(t, PROC_BIT | material << 23 | box, the object-space normal octahedral in (u, v), record).
const PROC_BIT: u32 = 0x80000000u;

// The geometry function's input: the ray in the object's space (d is not normalised: t is the world ray's parameter)
// and the interval a hit must lie in, the box (its index, min, max), where the object's data starts and its length in
// words (read it with `gdata` / `gdataf`), the object's customData and the scene time.
struct GIn { o: vec3<f32>, d: vec3<f32>, tmin: f32, tmax: f32, prim: u32, lo: vec3<f32>, hi: vec3<f32>, data: u32, count: u32, custom: vec4<f32>, time: f32 };
// Its output: t (none: outside (tmin, tmax), e.g. the default -1), the object-space normal (any length, facing either
// way), the material (an index into the mesh's materials; past the last: the last).
struct GOut { t: f32, normal: vec3<f32>, material: u32, attr: vec2<f32> };

// Procedural data (scene::proc_data): per object its header (`proc_vec`), materials, boxes (min xyz, max xyz) and the
// game's own data, 32-bit words.
// `pword`: the renderer's own reads (headers, boxes, materials). `gdata`: the geometry function's, of its object's data
// only, word i.data .. i.data + i.count - 1; anything else reads 0. The kernel is compiled without bounds checks (its
// indices come from the scene build) and the function is game code: it must not reach past its data.
fn pword(k: u32) -> u32 { return words[P.word_first.y + k]; }
fn pwordf(k: u32) -> f32 { return bitcast<f32>(pword(k)); }
var<private> gdata_first: u32;
var<private> gdata_count: u32;
fn gdata(k: u32) -> u32 {
    if (k - gdata_first >= gdata_count) { return 0u; }
    return pword(k);
}
fn gdataf(k: u32) -> f32 { return bitcast<f32>(gdata(k)); }

// @geometry-functions-begin
fn geometry_function(f: u32, i: GIn) -> GOut { return GOut(-1.0, vec3<f32>(0.0, 1.0, 0.0), 0u, vec2<f32>(0.0)); }
// @geometry-functions-end

fn is_proc(h: Hit) -> bool { return has(F_PROC) && h.tri != 0xffffffffu && (h.tri & PROC_BIT) != 0u; }

// Header words of a procedural object (scene::PROC_HEADER): box count, first box word, first data word, material count,
// bounds min xyz, first material word, bounds max xyz, data length.
fn proc_vec(w: u32) -> vec3<f32> { return vec3<f32>(pwordf(w), pwordf(w + 1u), pwordf(w + 2u)); }

// Octahedral unit vector in two floats (a hit's u, v).
fn proc_oct(v: vec3<f32>) -> vec2<f32> {
    let n = v / max(abs(v.x) + abs(v.y) + abs(v.z), 1e-30);
    let w = (1.0 - abs(n.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), n.xy >= vec2<f32>(0.0));
    return select(w, n.xy, n.z >= 0.0);
}
fn proc_unoct(e: vec2<f32>) -> vec3<f32> {
    var n = vec3<f32>(e, 1.0 - abs(e.x) - abs(e.y));
    let t = max(-n.z, 0.0);
    n.x += select(t, -t, n.x >= 0.0);
    n.y += select(t, -t, n.y >= 0.0);
    return normalize(n);
}

// World -> object space of a record: its world rows' inverse (the normal rows are the inverse transpose of its 3 x 3).
fn proc_dir(r: Instance, d: vec3<f32>) -> vec3<f32> { return r.n0.xyz * d.x + r.n1.xyz * d.y + r.n2.xyz * d.z; }
fn proc_point(r: Instance, p: vec3<f32>) -> vec3<f32> { return proc_dir(r, p - vec3<f32>(r.m0.w, r.m1.w, r.m2.w)); }

// Box `prim` of record `rec` against the object-space ray: the geometry function's hit in (tmin, tmax), else t = -1.
fn proc_box(rec: u32, prim: u32, o: vec3<f32>, d: vec3<f32>, tmin: f32, tmax: f32) -> GOut {
    let info = instance_at(rec).info;
    let b = pword(info.x + 1u) + prim * 6u;
    gdata_first = pword(info.x + 2u);
    gdata_count = pword(info.x + 11u);
    let g = geometry_function(info.z, GIn(o, d, tmin, tmax, prim, proc_vec(b), proc_vec(b + 3u), gdata_first, gdata_count, object_at(info.y * OBJECT_STRIDE + 2u), P.time.x));
    if (!(g.t > tmin && g.t < tmax)) { return GOut(-1.0, g.normal, 0u, g.attr); }
    return g;
}

// (u, v) carry 30 bits each as an ordinary float: exponent bits 01xxxxxx (64..127: never NaN, infinite or denormal,
// whose bits WGSL does not promise to keep through a bitcast), the payload in the sign bit and bits 28..0. u: the
// octahedral normal, 15 bits per component; v: the attribute, two half floats rounded to 15 bits (9-bit mantissa).
fn proc_word(p: u32) -> f32 { return bitcast<f32>(((p >> 29u) << 31u) | 0x20000000u | (p & 0x1fffffffu)); }
fn proc_bits(f: f32) -> u32 { let w = bitcast<u32>(f); return ((w >> 31u) << 29u) | (w & 0x1fffffffu); }

fn proc_hit(t: f32, g: GOut, prim: u32, rec: u32) -> Hit {
    let q = vec2<u32>(round(clamp(proc_oct(g.normal) * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)) * 32767.0));
    let a = pack2x16float(g.attr);
    // Each half rounded to its upper 15 bits (a carry into the exponent is the right rounding; 0x7fff stays put).
    let ha = min(((a & 0xffffu) + 1u) >> 1u, 0x7fffu);
    let hb = min(((a >> 16u) + 1u) >> 1u, 0x7fffu);
    return Hit(t, PROC_BIT | (min(g.material, 255u) << 23u) | prim, proc_word(q.x | (q.y << 15u)), proc_word(ha | (hb << 15u)), rec);
}

// A procedural hit's attribute (GOut.attr): its material function's `i.uv`.
fn proc_attr(h: Hit) -> vec2<f32> {
    let p = proc_bits(h.v);
    return unpack2x16float(((p & 0x7fffu) << 1u) | (((p >> 15u) & 0x7fffu) << 17u));
}

// A procedural hit's world normal (geometric = shading) through its record's normal rows.
fn proc_normal(h: Hit) -> vec3<f32> {
    let r = instance_at(h.inst);
    let p = proc_bits(h.u);
    let n = proc_unoct(vec2<f32>(f32(p & 0x7fffu), f32(p >> 15u)) / 32767.0 * 2.0 - 1.0);
    return normalize(vec3<f32>(dot(r.n0.xyz, n), dot(r.n1.xyz, n), dot(r.n2.xyz, n)));
}

// Live primary visibility rasterized by the viewport (triangle index + 1, 0 = sky) at this frame's jitter.
@group(1) @binding(0) var vis_tex: texture_2d<u32>;

// The software BVH walk (without `hwrt`: trace_hw.wgsl's traversal is the hardware's).

@if(!hwrt) fn ray_aabb(o: vec3<f32>, inv_d: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>, tmax: f32) -> f32 {
    let t0 = (bmin - o) * inv_d;
    let t1 = (bmax - o) * inv_d;
    let tmin_v = min(t0, t1);
    let tmax_v = max(t0, t1);
    let tn = max(max(tmin_v.x, tmin_v.y), max(tmin_v.z, 0.0));
    let tf = min(min(tmax_v.x, tmax_v.y), min(tmax_v.z, tmax));
    return select(INF, tn, tn <= tf);
}

// 北冥：三角形求交换成照 Cycles 移植的 ray_triangle_intersect（util.wgsl，防水的 Plücker 边测试）；上游的 Möller–Trumbore
// 是闭区间、无容差，网格的公共边上两个三角形可能都判不中。接受的范围照上游（0 < t < tmax，与离开起点的偏移配套）
@if(!hwrt) fn intersect_tri(o: vec3<f32>, d: vec3<f32>, i: u32, tmax: f32) -> vec3<f32> {
    let h = ray_triangle_intersect(o, d, 0.0, tmax, tri_verts[i * 3u].xyz, tri_verts[i * 3u + 1u].xyz, tri_verts[i * 3u + 2u].xyz);
    if (!h.hit || h.t <= 0.0 || h.t >= tmax) { return vec3<f32>(INF, 0.0, 0.0); }
    return vec3<f32>(h.t, h.u, h.v);
}

// 求交时跳过的图元（照 Cycles 的 Ray.self，intersection_skip_self）：(全局三角下标, 实例记录)，只有阴影射线设它
// （light.wgsl 的 shadow_ray_vis、shadow_ray_sky，测完清回 TRACE_SELF_NONE）。不进 trace 的参数：trace 的签名是冻结的接口。
// 软件求交里实例的三角形已经铺进世界空间（记 NO_INST），硬件求交里按（模型空间的池三角形, 实例记录）认
const TRACE_SELF_NONE: vec2<u32> = vec2<u32>(0xffffffffu, 0xffffffffu);
var<private> trace_self: vec2<u32> = TRACE_SELF_NONE;
fn hit_self(tri: u32, inst: u32) -> bool { return tri == trace_self.x && inst == trace_self.y; }

// mode: TRACE_CLOSEST, TRACE_SHADOW (any hit among shadow casters), TRACE_ANY (any hit on any surface).
@if(!hwrt) fn trace(o: vec3<f32>, d: vec3<f32>, tmax_in: f32, mode: u32) -> Hit {
    var hit = Hit(tmax_in, 0xffffffffu, 0.0, 0.0, NO_INST);
    if (state.legacy.rays_off) { return hit; }
    let inv_d = 1.0 / select(d, vec3<f32>(1e-20), abs(d) < vec3<f32>(1e-20));
    var stack: array<u32, 48>;
    var sp = 0u;
    var node = 0u;
    loop {
        let n = nodes[node];
        if (n.count > 0u) {
            for (var k = 0u; k < n.count; k++) {
                let ti = n.left_or_first + k;
                let flags = bitcast<u32>(tri_verts[ti * 3u].w);
                if (mode == TRACE_SHADOW && (flags & TRI_NO_SHADOW) != 0u) { continue; }
                if (hit_self(ti, NO_INST)) { continue; }
                let r = intersect_tri(o, d, ti, hit.t);
                if (r.x < hit.t) {
                    if (has(F_MASKED) && (flags & TRI_MASKED) != 0u && !cutouts_opaque() && mode != TRACE_ANY_OPAQUE && !alpha_pass(ti, NO_INST, r.y, r.z, r.x)) { state.legacy.shadow_hole = true; continue; }
                    hit = Hit(r.x, ti, r.y, r.z, NO_INST);
                    if (mode != TRACE_CLOSEST) { return hit; }
                }
            }
            if (sp == 0u) { break; }
            sp--;
            node = stack[sp];
            continue;
        }
        let l = n.left_or_first;
        let r = l + 1u;
        let nl = nodes[l];
        let nr = nodes[r];
        var tl = ray_aabb(o, inv_d, nl.bmin, nl.bmax, hit.t);
        var tr = ray_aabb(o, inv_d, nr.bmin, nr.bmax, hit.t);
        if (tl == INF && tr == INF) {
            if (sp == 0u) { break; }
            sp--;
            node = stack[sp];
            continue;
        }
        var near = l;
        var far = r;
        if (tr < tl) {
            near = r;
            far = l;
            let tmp = tl; tl = tr; tr = tmp;
        }
        node = near;
        if (tr != INF && sp < 48u) {
            stack[sp] = far;
            sp++;
        }
    }
    if (has(F_PROC)) { return trace_procs(o, d, hit, mode); }
    return hit;
}

// Procedural geometry, software traversal (the reference the hardware one is checked against): each object's bounds,
// then its boxes through the object's BVH (scene::ProcLayout with `sw`: nodes as bvh::GpuNode words, and the box of
// each leaf slot, so the geometry function gets the box's own index).
@if(!hwrt) fn trace_procs(o: vec3<f32>, d: vec3<f32>, hit_in: Hit, mode: u32) -> Hit {
    var hit = hit_in;
    let first = P.procs.z;
    for (var k = 0u; k < P.procs.y; k++) {
        let rec = first + k;
        let r = instance_at(rec);
        if (mode == TRACE_SHADOW && r.info.w == 0u) { continue; }
        let lo = proc_point(r, o);
        let ld = proc_dir(r, d);
        let inv = 1.0 / select(ld, vec3<f32>(1e-20), abs(ld) < vec3<f32>(1e-20));
        let h = r.info.x;
        if (ray_aabb(lo, inv, proc_vec(h + 4u), proc_vec(h + 8u), hit.t) == INF) { continue; }
        let bw = pword(h + 1u);
        let nb = pword(h + 12u);
        let ob = pword(h + 13u);
        var stack: array<u32, 48>;
        var sp = 0u;
        var node = 0u;
        loop {
            let w = nb + node * 8u;
            let first_or_left = pword(w + 3u);
            let count = pword(w + 7u);
            if (count > 0u) {
                for (var q = 0u; q < count; q++) {
                    let p = pword(ob + first_or_left + q);
                    if (ray_aabb(lo, inv, proc_vec(bw + p * 6u), proc_vec(bw + p * 6u + 3u), hit.t) == INF) { continue; }
                    let g = proc_box(rec, p, lo, ld, 0.0, hit.t);
                    if (g.t >= 0.0) {
                        hit = proc_hit(g.t, g, p, rec);
                        if (mode != TRACE_CLOSEST) { return hit; }
                    }
                }
                if (sp == 0u) { break; }
                sp--;
                node = stack[sp];
                continue;
            }
            let wl = nb + first_or_left * 8u;
            var tl = ray_aabb(lo, inv, proc_vec(wl), proc_vec(wl + 4u), hit.t);
            var tr = ray_aabb(lo, inv, proc_vec(wl + 8u), proc_vec(wl + 12u), hit.t);
            if (tl == INF && tr == INF) {
                if (sp == 0u) { break; }
                sp--;
                node = stack[sp];
                continue;
            }
            var near = first_or_left;
            var far = first_or_left + 1u;
            if (tr < tl) {
                near = far;
                far = first_or_left;
                let tmp = tl; tl = tr; tr = tmp;
            }
            node = near;
            if (tr != INF && sp < 48u) {
                stack[sp] = far;
                sp++;
            }
        }
    }
    return hit;
}


// What a shadow ray keeps of its light: a weight, 0 where a surface stops it, and every caller multiplies by it.
// (Until 2026-11-16 a pass / stop decision; the glass's colour then reached only the callers that asked for it, and
// fog and volume points took its largest channel.)
//
// The analytic lights' and the sky's: objects that cast no shadow (castShadow = false, glass) let the ray through,
// the glass it crosses at its transmission's share and colour (`glass_tr`; in full with A_GLASS_SHADOWS), the media
// at their transmittance. `sky`: as `glass_tr` takes it.
fn shadow_tr(o: vec3<f32>, d: vec3<f32>, tmax: f32, sky: bool, rd: u32) -> vec3<f32> {
    state.legacy.shadow_hole = false;
    if (trace(o, d, tmax, TRACE_SHADOW).tri != 0xffffffffu) { return vec3<f32>(0.0); }
    var tr = vec3<f32>(1.0);
    if (!approx(A_GLASS_SHADOWS) && has(F_GLASS)) {
        tr = glass_tr(o, d, tmax, sky);
        if (all(tr <= vec3<f32>(0.0))) { return tr; }
    }
    return tr * media_shadow(o, d, tmax, rd);
}

// Whether a shadow ray's light can be less than whole in this kernel (glass that tints, media). Elsewhere the weight
// is 0 or 1, and `tr3` / `tr1` make it a constant 1 past the caller's test for 0, which the compiler folds away: such
// scenes' code is as it was with a decision (Bistro's trace is 2 % slower with the products left in, and 1 % with
// the callers' two tests side by side instead of nested).
fn shadow_weighted() -> bool { return (!approx(A_GLASS_SHADOWS) && has(F_GLASS)) || has(F_MEDIA) || has(F_HMEDIA); }
fn tr3(v: vec3<f32>) -> vec3<f32> {
    if (shadow_weighted()) { return v; }
    return vec3<f32>(1.0);
}
fn tr1(v: f32) -> f32 {
    if (shadow_weighted()) { return v; }
    return 1.0;
}

// The media's transmittance along a shadow ray: every medium's (ratio tracking: an unbiased estimate), or with
// A_MEDIA_SHADOWS the homogeneous ones' (water) alone, analytic.
fn media_shadow(o: vec3<f32>, d: vec3<f32>, tmax: f32, rd: u32) -> f32 {
    if (media_shadows()) { return media_tr(o, d, tmax, rd); }
    return 1.0;
}

// Without A_GLASS_SHADOWS: what the glass a shadow ray crosses lets through (it has passed every opaque caster). At
// each glass surface the share of the BSDF's transmission lobe, transmission x (1 - the specular directional albedo)
// at the crossing angle, times the glass's colour. The ray goes straight (no refraction, no caustics), so a light seen from under
// water at more than the critical angle still lights through the surface, as its refracted light does. `sky`: an odd
// number of glass surfaces lets nothing through (sky_tr). Unattenuated, light under a water surface came both
// through it and from the paths it reflects back (a white furnace through water read 1.25).
fn glass_tr(o_in: vec3<f32>, d: vec3<f32>, tmax: f32, sky: bool) -> vec3<f32> {
    var o = o_in;
    var left = tmax;
    var tr = vec3<f32>(1.0);
    var odd = false;
    var t0 = 0.0;
    for (var k = 0u; k < 8u; k++) {
        let h = trace(o, d, left, TRACE_CLOSEST);
        if (h.tri == 0xffffffffu) { break; }
        t0 += h.t;
        let g = glass_hit(h, d, t0);
        if (g.share > 0.0) {
            tr *= g.share * g.tint;
            odd = !odd;
        }
        o = offset_origin(o + d * h.t, select(g.ng, -g.ng, dot(g.ng, d) < 0.0));
        left -= h.t;
        if (left <= 0.0 || all(tr <= vec3<f32>(0.0))) { break; }
    }
    if (sky && odd) { return vec3<f32>(0.0); }
    return tr;
}

// What reaches a lit point from an analytic light (`shadow_tr`). `shadows` false (a light that casts none): 1, no ray.
fn light_vis(shadows: bool, o: vec3<f32>, d: vec3<f32>, tmax: f32, rd: u32) -> vec3<f32> {
    if (!shadows) {
        state.legacy.shadow_hole = false;
        return vec3<f32>(1.0);
    }
    return shadow_tr(o, d, tmax, false, rd);
}

// Glass at a hit along d, `t` from the ray's start (texture LOD): its geometric normal, the share of the ray its
// transmission takes at that angle (transmission (x its texture) x (1 - a Schlick specular albedo); 0: not glass), its
// tint (base colour x texture: what the transmission lobe passes), and whether a ray from that side is totally
// reflected.
struct GlassAt { ng: vec3<f32>, share: f32, tir: bool, tint: vec3<f32> };

// `glass_at` of any hit: procedural surfaces are opaque (`surface_proc`). (Kept out of glass_at itself: there, even
// compiled out, it changed how Metal compiled the glass path, and glass scenes rendered 0.08 % of values differently.)
fn glass_hit(h: Hit, d: vec3<f32>, t: f32) -> GlassAt {
    if (is_proc(h)) { return GlassAt(proc_normal(h), 0.0, false, vec3<f32>(1.0)); }
    return glass_at(h, d, t);
}

// 北冥：直接读材质记录（Material）的已知例外，上游留下的；清单在 closure.wgsl「读 legacy 的例外清单」。
fn glass_at(h: Hit, d: vec3<f32>, t: f32) -> GlassAt {
    var a = attrs[h.tri];
    let v0 = tri_verts[h.tri * 3u].xyz;
    var e1 = tri_verts[h.tri * 3u + 1u].xyz - v0;
    var e2 = tri_verts[h.tri * 3u + 2u].xyz - v0;
    if (has(F_INST) && h.inst != NO_INST) {
        let r = instance_at(h.inst);
        e1 = inst_vec(r, e1);
        e2 = inst_vec(r, e2);
        a = inst_attr(r, a);
    }
    let m = material_at(bitcast<u32>(a.uv.w));
    var g = GlassAt(normalize(cross(e1, e2)), 0.0, false, vec3<f32>(1.0));
    var tr = clamp(m.layer.x, 0.0, 1.0) * (1.0 - clamp(m.params.x, 0.0, 1.0));
    if (tr <= 0.0) { return g; }
    g.tint = m.base_color.rgb;
    if (has(F_TINT)) { g.tint *= obj_tint(object_of(a)); }
    if (has(F_VCOLOR)) { g.tint *= vcolor(h.tri, h.u, h.v); }
    if (has(F_TEX) && (m.tex0.x >= 0 || m.uv.z > 0.5)) {
        let uv = mesh_uv(a, m, h.u, h.v);
        var lod = mesh_lod(a, m) + log2(max(t * 2.0 * P.cam_pos.w / lod_height(), 1e-7)) - LOD_BIAS;
        if (has(F_INST) && h.inst != NO_INST) { lod += bitcast<f32>(instance_at(h.inst).info.z); }
        if (m.tex0.x >= 0) { g.tint *= srgb_to_linear(tex(m.tex0.x, uv, lod).rgb); }
        if (m.uv.z > 0.5) { tr *= tex(i32(m.uv.z) - 1, uv, lod).r; }
    }
    let c = abs(dot(g.ng, d));
    let ior = max(m.layer.y, 1.0001);
    let eta = select(1.0 / ior, ior, dot(g.ng, d) > 0.0);
    g.tir = eta * eta * (1.0 - c * c) >= 1.0;
    // (Schlick from either side, no total reflection: the ray goes straight where the light it stands for refracts,
    // glass_tr. With the dielectric's own reflectance a surface seen past the critical angle let the whole sky
    // through: water/furnace 1.16.)
    let r = (ior - 1.0) / (ior + 1.0);
    let f0 = r * r;
    let e = energy_lookup(clamp(m.params.y, 0.02, 1.0), c);
    let w = 1.0 + P.misc.z * f0 * ((1.0 - e.x) / e.x);
    g.share = tr * (1.0 - w * (e.x * f0 + e.y * (clamp(50.0 * f0, 0.0, 1.0) - f0)));
    return g;
}

// Shadow rays toward the environment: `shadow_tr` with `sky`, where glass that bends the ray (an odd number of glass
// surfaces: a water surface, the shading point inside a glass solid) blocks it. The sky there is the refracted paths'
// (the path loop counts it in full past such glass), which find it where it is (Snell's window from under water).
fn sky_tr(o: vec3<f32>, d: vec3<f32>, rd: u32) -> vec3<f32> {
    return shadow_tr(o, d, INF, true, rd);
}

// Every medium on a shadow ray (`media_tr`): without A_MEDIA_SHADOWS, and in the live media voxel training
// (media_train sets `media_voxels`). With it a live trace's shadow rays run no volume function: inlined at every
// shadow ray they cost Kabukichō 0.4 ms with a smoke column out of view (the homogeneous ones are what is left: `media_shadow`).
var<private> media_voxels: bool = false;
fn media_shadows() -> bool { return (!approx(A_MEDIA_SHADOWS) || media_voxels) && has(F_MEDIA) && P.time.w > 0.5; }

// Shadow rays toward emissive surfaces: every surface blocks them, as it blocks the BSDF rays that find the same
// emitters (their MIS partner; a pass-through here counted light that no path can reach, and more of it the larger
// the emitter's sampling share). UE's path tracer, too, reaches emissive surfaces only through rays that every mesh
// blocks.
// Shadow ray to an emitter sample (any surface blocks). A_CUTOUT_EMITTERS: alpha-cutout triangles are opaque to it at camera hits too
// (deeper vertices take them as opaque anyway, `cutouts_opaque`): the leaves of a tree block as whole cards. A bias,
// accepted by the user on 2026-11-09 to bring the Bistro crowd within its 60 fps budget: the alpha tests of these rays
// were ~0.9 ms of the frame (crowd GPU p50 15.06 -> 14.16 ms, frame start p95 17.14 -> 16.67 ms), and cost the live
// image under foliage ~1.7 % of its light (static Bistro at 25 s along its path; layer B Bistro ΔE 3.23 -> 3.30).
// Removing the bias without the cost (an opacity micromap, or these rays compacted into a pass of their own) is a
// follow-up item (ROADMAP § 0). Offline rendering always tests.
fn emitter_tr(o: vec3<f32>, d: vec3<f32>, tmax: f32, rd: u32) -> f32 {
    state.legacy.shadow_hole = false;
    if (trace(o, d, tmax, select(TRACE_ANY, TRACE_ANY_OPAQUE, approx(A_CUTOUT_EMITTERS))).tri != 0xffffffffu) { return 0.0; }
    return media_shadow(o, d, tmax, rd);
}

// A shadow ray any surface stops (fog and volume points toward emitters).
fn any_tr(o: vec3<f32>, d: vec3<f32>, tmax: f32, rd: u32) -> f32 {
    state.legacy.shadow_hole = false;
    if (trace(o, d, tmax, TRACE_ANY).tri != 0xffffffffu) { return 0.0; }
    return media_shadow(o, d, tmax, rd);
}
