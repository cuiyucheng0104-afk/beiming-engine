// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：材质求值），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// SPDX-FileCopyrightText: 2026 Meshy LLC
// SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-License-Identifier: MIT AND Apache-2.0 AND BSD-3-Clause
// 多方许可。上游的与北冥新写的部分是 MIT。照 Cycles（Blender v5.2.3，路径相对 intern/cycles/）取的部分是 Apache-2.0
// （许可全文见仓库根的 LICENSES/Apache-2.0.txt）：
//   着色点标志 SD_BACKFACING 的名字与数值，着色点与闭包的字段名（ShaderData、ShaderClosure）：kernel/types.h
//   闭包种类 CLOSURE_* 的名字（数值是这里自己的）：kernel/svm/types.h（ClosureType，去掉 _ID 后缀）
//   shader_setup_closures 里原理化 BSDF 建金属、电介质高光、漫反射三个闭包的次序与权重，金属与电介质高光取 valid_reflection_N：
//   kernel/svm/closure.h（svm_node_closure_bsdf 的 CLOSURE_BSDF_PRINCIPLED_ID 分支），照原式重写
//   图案节点的求值：倒角 svm_bevel 与它的三次 BSSRDF 采样 svm_bevel_cubic_*（kernel/svm/bevel.h）、环境光遮蔽 svm_ao
//   （kernel/svm/ao.h）、平滑阶梯 pattern_smoothstep（util/math_base.h 的 smoothstep 与 kernel/svm/map_range.h 的 SMOOTHSTEP 一支）、
//   混合 pattern_mix 的两种插值（kernel/svm/mix.h 的 MIX 一支、map_range.h 的 LINEAR 一支），照原式重写
// 菲涅耳种类 FRESNEL_* 的名字与次序取自 kernel/closure/bsdf_microfacet.h 的 enum MicrofacetFresnel，那个文件是 BSD-3-Clause
// （版权人 Sony Pictures Imageworks Inc. 等与 Blender Foundation，许可全文见仓库根的 LICENSES/BSD-3-Clause.txt）。
// ------------------------------------------------------------------------------------------------
// 北冥：着色点、闭包、材质输入值，以及材质求值的三步。闭包的求值、采样在 closure.wgsl。
// 内核的四样内部结构（材质记录、光线负载、随机维度、输出通道）已经冻结：每个字段的含义与状态、编号登记表、改动的规矩
// 在 ../STRUCTURES.md；改了这里的结构、常数或函数的参数表，要同步改那份条文与冻结标记（../FREEZE.json）。
//
// 这几个结构只活在一次调用里，不进缓冲。规矩：
//   - 不许位置式构造（`Closure(a, b, …)`）：先取零值（`Closure()`）再按名字赋值，这样以后加字段不会破坏别处。
//   - 函数实参不许是指向结构成员或数组元素的指针（`&sd.closure[i]`、`&sd.N`）：有的显卡后端建管线时会崩。
//     要改某个闭包就传下标，或传整个变量的指针（`ptr<function, ShadingPoint>`）。
//   - 加新函数、给返回结构加字段不算破坏；改已有函数的参数表算破坏。
//   - 照 Cycles 逐函数移植、要进函数级比对的函数（../../shaders/ 下的那些）签名只收标量与向量，不收这里的结构。
//     收结构的只有这里与 closure.wgsl 的分发函数：它们取出字段，再调标量签名的函数。
// 「上游顶替」：还没照 Cycles 移植的材质由上游原来的代码顶着，圈在名字带 legacy 的字段与函数里，移植完一块删一块。
// 走移植的闭包的是没有清漆、透射、漫反射粗糙度、不透明度都是 1 的材质（原理化 BSDF 的金属、电介质高光、漫反射，
// 见 shader_setup_closures）；别的是上游顶替。
// 新写的代码不许读 legacy，也不许调名字带 legacy 的函数；
// 眼下读着 legacy 的地方都列在 closure.wgsl「上游顶替」一节的例外清单里。
// 字段的状态：「已落地」有写有读；「已写未读」现在就写、还没人读；「已定义」含义定了、等后面的移植来写。

// 一个着色点上同时存在的闭包个数上限。只在这里定义。
const MAX_CLOSURE: u32 = 4u;

// 闭包种类。名字照 Cycles，数值是这里自己的：往后追加，已有的数值不改。
const CLOSURE_NONE: u32 = 0u;
const CLOSURE_LEGACY: u32 = 1u;                // 上游顶替：求值与采样转给上游的 eval_bsdf_k、pdf_bsdf、sample_bsdf
const CLOSURE_BSDF_MICROFACET_GGX: u32 = 2u;   // GGX 微表面反射，各向同性。接了 F82_TINT（金属）与 GENERALIZED_SCHLICK（电介质高光）两种菲涅耳
const CLOSURE_BSDF_DIFFUSE: u32 = 3u;          // 朗伯漫反射（bsdf_diffuse）
const CLOSURE_BSDF_TRANSPARENT: u32 = 4u;      // 已定义

// 菲涅耳种类，数值照 Cycles 的 MicrofacetFresnel。F82_TINT、GENERALIZED_SCHLICK 已落地，其余已定义。
// （CONDUCTOR 要一个复数折射率，Closure 里还没有放它的字段：种类号先占着，用到时加两个字段。）
const FRESNEL_NONE: u32 = 0u;
const FRESNEL_DIELECTRIC: u32 = 1u;
const FRESNEL_DIELECTRIC_TINT: u32 = 2u;
const FRESNEL_CONDUCTOR: u32 = 3u;
const FRESNEL_GENERALIZED_SCHLICK: u32 = 4u;
const FRESNEL_F82_TINT: u32 = 5u;

// 着色点标志（ShadingPoint.flag），位照 Cycles 的 ShaderDataFlag
const SD_BACKFACING: u32 = 1u;                 // 打在背面

// 闭包：一个结构装所有种类。微表面的菲涅耳参数在 Cycles 里另放在四个结构里，这里摊平放进来。
// kind、weight、sample_weight、N 所有闭包都填；alpha_x、alpha_y、energy_scale、fresnel_type、f0、f90_or_b 现在只有
// 纯金属的微表面闭包填；其余是「已定义」，由移植闭包的人填。
struct Closure {
    kind: u32,                      // 闭包种类（CLOSURE_*）。Cycles 里叫 type，那是这门着色器语言的保留字
    weight: vec3<f32>,              // 彩色权重
    sample_weight: f32,             // 在多个闭包之间选哪个去采样的权重
    N: vec3<f32>,                   // 这个闭包用的法线
    alpha_x: f32,                   // 微表面两个方向的粗糙度（各向同性时相等）
    alpha_y: f32,
    ior: f32,                       // 折射率
    energy_scale: f32,              // 能量补偿的标量倍率。必须与 weight 分开存，合进去会把颜色通道弄乱
    fresnel_type: u32,              // 菲涅耳种类（FRESNEL_*）
    f0: vec3<f32>,                  // F82 型：F0；广义 Schlick 型：F0
    f90_or_b: vec3<f32>,            // F82 型：预先算好的 b；广义 Schlick 型：F90
    exponent: f32,                  // 广义 Schlick 的指数；负数表示「按折射率算真菲涅耳再重映射」
    reflection_tint: vec3<f32>,     // 反射的染色。广义 Schlick 里 Cycles 把真正的染色乘进了 F0，这里只取 1 或 0，
    transmission_tint: vec3<f32>,   // 实际是「要不要反射焦散」的开关：照搬它的用法，别当颜色用。透射的染色
};

// 上游顶替读的东西：上游的 Surface（贴图与材质函数算完之后的材质值）与 Lobes（依赖视线的分层权重）。
// 字段按「搜不到读者就删」处理：最后删掉读者的那次移植顺手删字段。
struct ShadingLegacy { surface: Surface, lobes: Lobes };

// 着色点：一次命中上的几何量与闭包。照 Cycles 的 ShaderData 取子集。
struct ShadingPoint {
    P: vec3<f32>,                   // 位置（世界空间）。已落地
    N: vec3<f32>,                   // 插值后的平滑法线，打在背面时与 Ng 一起翻向来路；不含法线贴图、不含倒角。已落地（凹凸阴影项读）
                                    // （扰动后的法线在 ShaderInputs.N 与各闭包的 N 里；上游顶替用它自己的 legacy.surface.n）
    Ng: vec3<f32>,                  // 几何法线，翻向来路。已落地
    wi: vec3<f32>,                  // 指向来路的方向。已落地
    object: u32,                    // 物体表的下标（上游的 object_of），软件、硬件两条求交路上都有；不是实例记录号。已写未读
    prim: u32,                      // 全局三角下标；过程几何的命中是上游的命中码（最高位是 1）。已写未读
    u: f32,                         // 重心坐标；过程几何的命中里是上游编码过的法线与属性。已写未读
    v: f32,
    ray_length: f32,                // 这一段光线走了多远。已写未读
    flag: u32,                      // 着色点标志（SD_*）。SD_BACKFACING 已落地
    object_flag: u32,               // 物体标志，位照 Cycles（第 3 位：物体是镜像的）。已定义
    time: f32,                      // 这条光线的时刻。已定义，恒 0
    lcg_state: u32,                 // 局部求交随机取子集用的小随机数状态。已定义
    inst: u32,                      // 放置这个三角形的实例记录（NO_INST：没经实例，三角形本身就在世界空间；过程几何也记 NO_INST）。
                                    // 已落地（阴影射线的起点偏移取世界空间的顶点与顶点法线，light.wgsl 的 shadow_tri）
    emission: vec3<f32>,            // 这个点的自发光，单独一个量，不占闭包。已落地
    num_closure: u32,               // 闭包个数。0：只发光、不散射，路径到这里结束。已落地
    closure: array<Closure, MAX_CLOSURE>,
    legacy: ShadingLegacy,          // 上游顶替。闭包移植完后删
};

// 材质输入值：贴图、材质函数、图案节点都算完之后，一个着色点上的材质参数。
// 取值范围照 Cycles 读出节点输入之后的夹取（粗糙度不带上游的 0.02 下限）。
// 现在读着的：N、emission，以及纯金属的闭包读的 base_color、metallic、roughness、specular_tint、flags、coat_weight、
// transmission_weight；其余是「已写未读」，等移植闭包的人读。
struct ShaderInputs {
    base_color: vec3<f32>,          // 底色，不小于 0
    metallic: f32,                  // 金属度，0 到 1
    roughness: f32,                 // 粗糙度，0 到 1（alpha = 粗糙度的平方）
    ior: f32,                       // 折射率，不小于 1e-5
    specular_ior_level: f32,        // 高光等级，不小于 0，默认 0.5
    specular_tint: vec3<f32>,       // 金属：F82 的边缘色；非金属：乘在 F0 上的颜色。不小于 0，默认白
    emission: vec3<f32>,            // 这个点的自发光辐亮度（已乘物体的功率倍数）
    alpha: f32,                     // 不透明度，0 到 1。现在只是材质记录里的值：贴图的透明度与镂空在求交那一档里判
    diffuse_roughness: f32,         // 漫反射粗糙度，0 到 1，0 是朗伯
    flags: u32,                     // 材质记录的 flags 原样带过来（MATERIAL_FLAG_*）：能量补偿那一位纯金属的闭包读；
                                    // 闭包大类等移植闭包的人读
    coat_weight: f32,               // 清漆的份额，0 到 1（没编清漆功能的内核里恒为 0）
    transmission_weight: f32,       // 透射的份额，0 到 1（没编玻璃功能的内核里恒为 0）
    N: vec3<f32>,                   // 闭包用的法线：含法线贴图、材质函数（以后还有倒角）
};

// 第一步：填着色点的几何量。不读材质。`sd` 要是刚取的零值（`var sd = ShadingPoint();`）。
// 往指针里填、不按值返回：试过返回整个着色点，苹果显卡上编译出来的运算次序会变，像素末位不同。
// 背面的判法沿用上游：几何法线与光线方向的点积不小于 0 就算背面（恰好垂直时 Cycles 算正面，这里算背面）。
// 三角形上的着色点照 Cycles 的 triangle_point_from_uv（kernel/geom/triangle_intersect.h:123-143）用重心坐标重建：
// tri_a + u·(tri_b − tri_a) + v·(tri_c − tri_a)，在顶点所在的空间里算，硬件求交的模型实例再乘实例的物体变换（Cycles 没把变换
// 烘进几何的物体同样如此）。点落在自己的三角形上，阴影射线的自交测试（integrate_surface_ray_offset 的「测中不抬」）以此为前提；
// 继续弹射的射线起点跟着变。过程几何照旧取 o + d·t
fn shader_setup_from_hit(sd: ptr<function, ShadingPoint>, o: vec3<f32>, d: vec3<f32>, h: Hit) {
    (*sd).P = o + d * h.t;
    (*sd).wi = -d;
    (*sd).prim = h.tri;
    (*sd).u = h.u;
    (*sd).v = h.v;
    (*sd).ray_length = h.t;
    var ng: vec3<f32>;
    var n: vec3<f32>;
    if (is_proc(h)) {
        // 过程几何：几何法线就是着色法线
        ng = proc_normal(h);
        n = ng;
        (*sd).object = instance_at(h.inst).info.y;
    } else {
        let i = h.tri;
        let v0 = tri_verts[i * 3u].xyz;
        var e1 = tri_verts[i * 3u + 1u].xyz - v0;
        var e2 = tri_verts[i * 3u + 2u].xyz - v0;
        var a = attrs[i];
        var p = v0 + h.u * e1 + h.v * e2;
        if (has(F_INST) && h.inst != NO_INST) {
            let r = instance_at(h.inst);
            p = inst_vec(r, p) + vec3<f32>(r.m0.w, r.m1.w, r.m2.w);
            e1 = inst_vec(r, e1);
            e2 = inst_vec(r, e2);
            a = inst_attr(r, a);
        }
        (*sd).P = p;
        let w = 1.0 - h.u - h.v;
        ng = normalize(cross(e1, e2));
        // 着色法线不用内建 normalize：它在显卡上偏向一边，经 GGX 的 1 − cos_NH² 放大（util.wgsl 的 normalize_unbiased）
        n = normalize_unbiased(a.n0.xyz * w + a.n1.xyz * h.u + a.n2.xyz * h.v);
        (*sd).object = object_of(a);
        // 北冥：镜像的实例（物体扩展表的镜像位）共用没换绕序的网格，变换后的两条边叉乘出来朝里，取反。Cycles 对没烘进几何的
        // 物体是在物体空间求几何法线再乘法线矩阵（kernel/geom/shader_data.h:105 的 object_normal_transform），镜像时方向与这里取反后的一致
        if (has(F_INST) && h.inst != NO_INST && (object_ext_at((*sd).object).object_flag & SD_OBJECT_NEGATIVE_SCALE) != 0u) {
            ng = -ng;
        }
    }
    (*sd).inst = select(NO_INST, h.inst, !is_proc(h) && has(F_INST));
    if (!(dot(ng, d) < 0.0)) {
        (*sd).flag |= SD_BACKFACING;
        ng = -ng;
        n = -n;
    }
    (*sd).Ng = ng;
    (*sd).N = n;
}

// 第二步：解出这个着色点上的材质输入值。新写的代码里只有这个函数读材质记录（Material）与贴图。
// 现在装的是上游的贴图与材质函数逻辑（下面的 surface、surface_proc），它顺带把上游的 Surface 留在 legacy 里给
// 上游顶替用；上游这一段自己再算一遍几何量，读数不变，随 Surface 一起删。
// 图案节点接在这里；以后的节点图编译器整段替换它。`width`：光线锥在命中处的宽度（米），贴图取级用。
fn shader_eval_inputs(sd: ptr<function, ShadingPoint>, o: vec3<f32>, d: vec3<f32>, h: Hit, width: f32) -> ShaderInputs {
    let r = surface(o, d, h, width);
    (*sd).legacy.surface = r.surface;
    // 图案节点（F_PATTERN 的内核）：贴图与材质函数之后、闭包之前，照材质记录的 pattern_first、pattern_count 依次求值
    if (has(F_PATTERN) && !is_proc(h)) {
        var a = attrs[h.tri];
        if (has(F_INST) && h.inst != NO_INST) { a = inst_attr(instance_at(h.inst), a); }
        let m = material_at(bitcast<u32>(a.uv.w));
        if (m.pattern_count > 0u) { return shader_eval_pattern(sd, r.inputs, m.pattern_first, m.pattern_count); }
    }
    return r.inputs;
}

// ------------------------------------------------------------------------------------------------
// 图案节点（场景包契约 3.5、5.6 的四种），照 Cycles 的 SVM 节点求值；节点表的格式见 pathtrace.wgsl 的 pattern_node_at。
// 标准答案机把它们接成 Blender 的节点图（倒角接原理化 BSDF 的法线，遮蔽与平滑阶梯接混合系数，混合换掉底色、金属度、
// 粗糙度），这里的求值次序与输入照那张图：
//   倒角  svm_bevel：输出替换闭包用的法线 inputs.N。法线输入没接，Cycles 自动接着色法线 sd->N，
//         normalize(sd->N + (bevel_N − sd->N)) 与 bevel_N 只差舍入，这里直接取 bevel_N
//   遮蔽  svm_ao：法线输入同样是着色法线 sd->N（不含倒角：倒角的输出只接到 BSDF），无 inside、无全局半径
//   平滑阶梯 pattern_smoothstep；混合 pattern_mix
// 过程几何的命中没有图案节点（Cycles 里没有这种几何）。

// kernel/svm/bevel.h:28-42: svm_bevel_cubic_eval（svm_bevel_cubic_pdf 与它相同）
fn svm_bevel_cubic_eval(radius: f32, r: f32) -> f32 {
    let Rm = radius;
    if (r >= Rm) { return 0.0; }
    let Rm5 = (Rm * Rm) * (Rm * Rm) * Rm;
    let f = Rm - r;
    let num = f * f * f;
    return (10.0 * num) / (Rm5 * M_PI_F);
}

// kernel/svm/bevel.h:50-74: svm_bevel_cubic_quintic_root_find，解 10x² − 20x³ + 15x⁴ − 4x⁵ − xi = 0（牛顿迭代）
fn svm_bevel_cubic_quintic_root_find(xi: f32) -> f32 {
    let tolerance = 1e-6;
    var x = 0.25;
    for (var i = 0; i < 10; i++) {
        let x2 = x * x;
        let x3 = x2 * x;
        let nx = 1.0 - x;
        let f = 10.0 * x2 - 20.0 * x3 + 15.0 * x2 * x2 - 4.0 * x2 * x3 - xi;
        let f_ = 20.0 * (x * nx) * (nx * nx);
        if (abs(f) < tolerance || f_ == 0.0) { break; }
        x = saturate(x - f / f_);
    }
    return x;
}

// kernel/svm/bevel.h:76-89: svm_bevel_cubic_sample，返回 (r, h)
fn svm_bevel_cubic_sample(radius: f32, xi: f32) -> vec2<f32> {
    let Rm = radius;
    let r = svm_bevel_cubic_quintic_root_find(xi) * Rm;
    return vec2<f32>(r, safe_sqrtf(Rm * Rm - r * r));
}

// 局部命中处的位置、几何法线与平滑法线（Cycles 在 svm_bevel 里用 triangle_point_from_uv、isect.Ng 与 triangle_smooth_normal
// 取的三样），算法同 shader_setup_from_hit
struct LocalGeom { P: vec3<f32>, Ng: vec3<f32>, N: vec3<f32> };
fn local_hit_geometry(h: LocalHit) -> LocalGeom {
    let i = h.tri;
    let v0 = tri_verts[i * 3u].xyz;
    var e1 = tri_verts[i * 3u + 1u].xyz - v0;
    var e2 = tri_verts[i * 3u + 2u].xyz - v0;
    var a = attrs[i];
    var p = v0 + h.u * e1 + h.v * e2;
    if (has(F_INST) && h.inst != NO_INST) {
        let r = instance_at(h.inst);
        p = inst_vec(r, p) + vec3<f32>(r.m0.w, r.m1.w, r.m2.w);
        e1 = inst_vec(r, e1);
        e2 = inst_vec(r, e2);
        a = inst_attr(r, a);
    }
    var g = LocalGeom();
    g.P = p;
    g.Ng = normalize(cross(e1, e2));
    let w = 1.0 - h.u - h.v;
    let n = normalize_unbiased(a.n0.xyz * w + a.n1.xyz * h.u + a.n2.xyz * h.v);
    // triangle_smooth_normal：插值法线是零向量时取几何法线
    g.N = select(n, g.Ng, all(n == vec3<f32>(0.0)));
    return g;
}

// kernel/svm/bevel.h:97-288: svm_bevel。在着色点周围的同一个物体表面上取点，平均那里的法线。Cycles 的镜像物体把 hit_Ng 取反，
// 它只进 |dot|，这里不翻。返回闭包用的法线
fn svm_bevel(sd: ptr<function, ShadingPoint>, radius: f32, num_samples: u32) -> vec3<f32> {
    if (radius <= 0.0 || num_samples < 1u) { return (*sd).N; }
    // 模糊的间接光线上不做倒角
    if (state.min_ray_pdf < 8.0) { return (*sd).N; }
    var lcg_state = lcg_state_init(state.rng_pixel, state.rng_offset, state.sample, 0x64c6a40eu);
    var sum_N = vec3<f32>(0.0);
    for (var sample = 0u; sample < num_samples; sample++) {
        var rand_disk = path_branched_rng_2D(sample, num_samples, PRNG_SURFACE_BEVEL);
        // 在局部坐标系里随机取一根轴，再在圆盘上取点
        var disk_N = (*sd).Ng;
        let onb = make_orthonormals(disk_N);
        var disk_T = onb.a;
        var disk_B = onb.b;
        var pick_pdf_N: f32;
        var pick_pdf_T: f32;
        var pick_pdf_B: f32;
        let axisu = rand_disk.x;
        if (axisu < 0.5) {
            pick_pdf_N = 0.5;
            pick_pdf_T = 0.25;
            pick_pdf_B = 0.25;
            rand_disk.x *= 2.0;
        } else if (axisu < 0.75) {
            let tmp = disk_N;
            disk_N = disk_T;
            disk_T = tmp;
            pick_pdf_N = 0.25;
            pick_pdf_T = 0.5;
            pick_pdf_B = 0.25;
            rand_disk.x = (rand_disk.x - 0.5) * 4.0;
        } else {
            let tmp = disk_N;
            disk_N = disk_B;
            disk_B = tmp;
            pick_pdf_N = 0.25;
            pick_pdf_T = 0.25;
            pick_pdf_B = 0.5;
            rand_disk.x = (rand_disk.x - 0.75) * 4.0;
        }
        let phi = 2.0 * M_PI_F * rand_disk.x;
        let rh = svm_bevel_cubic_sample(radius, rand_disk.y);
        let disk_r = rh.x;
        let disk_height = rh.y;
        let pc = polar_to_cartesian(disk_r, phi);
        let disk_P = pc.x * disk_T + pc.y * disk_B;
        var ray = Ray();
        ray.P = (*sd).P + disk_N * disk_height + disk_P;
        ray.D = -disk_N;
        ray.tmin = 0.0;
        ray.tmax = 2.0 * disk_height;
        // 只查同一个物体；命中多于 LOCAL_MAX_HITS 个时随机留一个子集
        let isect = trace_local(ray, (*sd).object, lcg_state, LOCAL_MAX_HITS);
        lcg_state = isect.lcg_state;
        let num_eval_hits = min(isect.num_hits, LOCAL_MAX_HITS);
        for (var hit = 0u; hit < num_eval_hits; hit++) {
            let g = local_hit_geometry(isect.hits[hit]);
            // 三根轴的概率密度；三轴之间按幂启发式做多重重要性采样（分子与分母里的 pdf_N 约掉了一个）
            let pdf_N = pick_pdf_N * abs(dot(disk_N, g.Ng));
            let pdf_T = pick_pdf_T * abs(dot(disk_T, g.Ng));
            let pdf_B = pick_pdf_B * abs(dot(disk_B, g.Ng));
            var w = pdf_N / (sqr(pdf_N) + sqr(pdf_T) + sqr(pdf_B));
            if (isect.num_hits > LOCAL_MAX_HITS) { w *= f32(isect.num_hits) / f32(LOCAL_MAX_HITS); }
            let r = len_ccl(g.P - (*sd).P);
            let pdf = svm_bevel_cubic_eval(radius, r);
            let disk_pdf = svm_bevel_cubic_eval(radius, disk_r);
            w *= pdf / disk_pdf;
            sum_N += w * g.N;
        }
    }
    let N = safe_normalize_fallback(sum_N, vec3<f32>(0.0));
    if (all(N == vec3<f32>(0.0))) { return (*sd).N; }
    return select(N, -N, ((*sd).flag & SD_BACKFACING) != 0u);
}

// kernel/svm/ao.h:25-96: svm_ao（无 NODE_AO_INSIDE、无 NODE_AO_GLOBAL_RADIUS）。返回没被挡的样本所占的份额。
// onlyLocal 为假走阴影的问法（scene_intersect_shadow，SHADOW_OPAQUE：不投影的物体不挡），为真只查同一个物体
fn svm_ao(sd: ptr<function, ShadingPoint>, N: vec3<f32>, max_dist: f32, num_samples: u32, only_local: bool) -> f32 {
    if (max_dist <= 0.0 || num_samples < 1u) { return 1.0; }
    let onb = make_orthonormals(N);
    var unoccluded = 0u;
    // 跳过自己的图元（Cycles 的 ray.self.prim = sd->prim）
    trace_self = vec2<u32>((*sd).prim, (*sd).inst);
    for (var sample = 0u; sample < num_samples; sample++) {
        let rand_disk = path_branched_rng_2D(sample, num_samples, PRNG_SURFACE_AO);
        let d = sample_uniform_disk(rand_disk);
        let D = vec3<f32>(d.x, d.y, safe_sqrtf(1.0 - dot(d, d)));
        let dir = to_global(D, onb.a, onb.b, N);
        if (only_local) {
            var ray = Ray();
            ray.P = (*sd).P;
            ray.D = dir;
            ray.tmin = 0.0;
            ray.tmax = max_dist;
            if (trace_local(ray, (*sd).object, 0u, 0u).num_hits == 0u) { unoccluded++; }
        } else if (trace((*sd).P, dir, max_dist, TRACE_SHADOW).tri == 0xffffffffu) {
            unoccluded++;
        }
    }
    trace_self = TRACE_SELF_NONE;
    return f32(unoccluded) / f32(num_samples);
}

// util/math_base.h 的 smoothstep，经 kernel/svm/map_range.h 的 NODE_MAP_RANGE_SMOOTHSTEP（from_min < from_max，to 是 0 到 1）
fn pattern_smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    if (x < edge0) { return 0.0; }
    if (x >= edge1) { return 1.0; }
    let t = (x - edge0) / (edge1 - edge0);
    return (3.0 - 2.0 * t) * (t * t);
}

// 混合：底色照 MixRGB 的 MIX（kernel/svm/mix.h，interp(a, b, t) = (1 − t)·a + t·b），金属度与粗糙度照 MapRange 的 LINEAR
// （from 0 到 1、to 从材质的值到 set 的值：a + t·(b − a)，再夹到两端之间）
fn pattern_map_linear(a: f32, b: f32, t: f32) -> f32 {
    return clamp(a + t * (b - a), min(a, b), max(a, b));
}

// 依次求值一个材质的图案节点，改出材质输入值
fn shader_eval_pattern(sd: ptr<function, ShadingPoint>, inputs_in: ShaderInputs, first: u32, count: u32) -> ShaderInputs {
    var inputs = inputs_in;
    var values: array<f32, PATTERN_VALUES>;
    for (var k = 0u; k < count; k++) {
        let n = pattern_node_at(first + k);
        switch (n.a.x) {
            case PATTERN_BEVEL: { inputs.N = svm_bevel(sd, n.b.x, n.a.y); }
            case PATTERN_AO: { values[n.a.z] = svm_ao(sd, (*sd).N, n.b.x, n.a.y, n.a.w != 0u); }
            case PATTERN_SMOOTHSTEP: { values[n.a.z] = pattern_smoothstep(n.b.x, n.b.y, values[n.a.y]); }
            case PATTERN_MIX: {
                let t = values[n.a.y];
                if ((n.a.z & 1u) != 0u) { inputs.base_color = (1.0 - t) * inputs.base_color + t * n.b.xyz; }
                if ((n.a.z & 2u) != 0u) { inputs.metallic = pattern_map_linear(inputs.metallic, n.b.w, t); }
                if ((n.a.z & 4u) != 0u) { inputs.roughness = pattern_map_linear(inputs.roughness, bitcast<f32>(n.a.w), t); }
            }
            default: {}
        }
    }
    return inputs;
}

// 第三步：按材质输入值填闭包与自发光。只读 ShaderInputs，不读材质记录。归移植闭包的人。
// 发光卡片（上游的 card：只发光、不散射）没有闭包。带清漆、透射、漫反射粗糙度或不透明度小于 1 的材质整个走一个上游顶替的
// 闭包（CLOSURE_LEGACY；它另要的上游 Lobes 在 surface_shader_prepare_closures 里算）。别的材质照 Cycles 的原理化 BSDF
// （kernel/svm/closure.h svm_node_closure_bsdf 的 CLOSURE_BSDF_PRINCIPLED_ID 分支）里「无清漆、无光泽、无次表面、无透射、
// 无薄膜、各向同性、漫反射粗糙度 0」那一条路填至多三个闭包，次序与 Cycles 相同：
//   1. 金属：金属度大于 CLOSURE_WEIGHT_CUTOFF（1e-5，svm/types.h）时，GGX 加 F82-tint，权重是金属度乘剩下的权重，
//      F0 是夹到 1 以内的底色，边缘色夹到 1 以内；之后剩下的权重乘 (1 − 金属度)。
//   2. 电介质高光：按高光等级调过的 eta（principled_specular_f0_eta）不为 1 时，GGX 加广义 Schlick
//      （f0 = F0·高光染色、f90 = 1、exponent = −eta、反射染色 1、透射染色 0），权重是剩下的权重；
//      剩下的权重按它的反照率衰减（closure_layering_weight）。
//   3. 漫反射：bsdf_diffuse，权重是底色乘剩下的权重。
// 每个闭包分配时照 Cycles 的 bsdf_alloc：权重的平均小于 1e-5 就不建（closure_sample_weight），sample_weight 取权重的平均，
// 微表面的再乘估出来的反照率的平均与能量补偿的 darkening 的平均（bsdf_microfacet_setup_fresnel_*，乘的次序照 Cycles）。
// 微表面的 alpha 取粗糙度的平方（ShaderInputs.roughness 已夹在 0 到 1），不带上游的 0.02 下限：粗糙度为 0 时是奇异的一瓣，
// 积分主循环按 Cycles 的做法处理（integrator.wgsl 里 through 的那个判断）。能量补偿（Cycles 的多重散射 GGX）读材质记录
// flags 的 MATERIAL_FLAG_MULTISCATTER（上传前按全局开关 energyCompensation 统一写的）。
// 金属与电介质高光的法线照 Cycles 取 valid_reflection_N（maybe_ensure_valid_specular_reflection：着色法线让镜面反射方向
// 落到几何面以下时往几何法线拧；它只在材质带凹凸校正标志时生效，而这个标志 Blender 默认开着，场景包里又没有这个参数，
// 所以视为开），漫反射用原来的 N。
// 没有移的（这条路上都不出现，或这里没有）：发光被光泽与清漆衰减的那一步（principled_bsdf_emission：没有清漆与光泽，
// 衰减是 1）、各向异性的切线。
// 把闭包放进第 n 格。下标写成常数：按变量下标往着色点的闭包数组里写，苹果显卡上整个着色点会被挪到内存里，
// 有 24 盏灯的计时场景稳态慢了几倍（实测）
fn closure_store(sd: ptr<function, ShadingPoint>, n: u32, c: Closure) {
    switch (n) {
        case 0u: { (*sd).closure[0] = c; }
        case 1u: { (*sd).closure[1] = c; }
        case 2u: { (*sd).closure[2] = c; }
        default: { (*sd).closure[3] = c; }
    }
}

fn shader_setup_closures(sd: ptr<function, ShadingPoint>, inputs: ShaderInputs) {
    (*sd).emission = inputs.emission;
    (*sd).num_closure = 0u;
    if ((*sd).legacy.surface.card) { return; }
    var c = Closure();
    c.weight = vec3<f32>(1.0);
    c.sample_weight = 1.0;
    c.N = inputs.N;
    if (inputs.coat_weight > 0.0 || inputs.transmission_weight > 0.0 || inputs.diffuse_roughness > 0.0 || inputs.alpha < 1.0) {
        c.kind = CLOSURE_LEGACY;
        (*sd).closure[0] = c;
        (*sd).num_closure = 1u;
        return;
    }
    let N = inputs.N;
    let wi = (*sd).wi;
    // 金属与电介质高光用拧过的法线（反射方向不落到几何面以下），漫反射用原来的 N：照 Cycles 的 valid_reflection_N
    let valid_reflection_N = maybe_ensure_valid_specular_reflection((*sd).Ng, wi, N);
    let preserve = (inputs.flags & MATERIAL_FLAG_MULTISCATTER) != 0u;
    let alpha = saturate(roughness_to_alpha(inputs.roughness));
    var weight = vec3<f32>(1.0);
    var n = 0u;
    // 1. 金属
    if (inputs.metallic > 1e-5) {
        c = Closure();
        c.weight = inputs.metallic * weight;
        c.sample_weight = closure_sample_weight(c.weight);
        if (c.sample_weight > 0.0) {
            c.kind = CLOSURE_BSDF_MICROFACET_GGX;
            c.N = valid_reflection_N;
            c.alpha_x = alpha;
            c.alpha_y = alpha;
            c.ior = 1.0;
            c.fresnel_type = FRESNEL_F82_TINT;
            c.f0 = min(inputs.base_color, vec3<f32>(1.0));
            let f = bsdf_microfacet_setup_fresnel_f82_tint(valid_reflection_N, wi, alpha, c.f0, min(inputs.specular_tint, vec3<f32>(1.0)), preserve);
            c.f90_or_b = f.b;
            c.sample_weight *= average(bsdf_microfacet_estimate_albedo_f82_tint(valid_reflection_N, wi, alpha, c.f0, true));
            c.energy_scale = f.energy_scale;
            if (preserve) {
                c.weight *= f.weight;
                c.sample_weight *= average(f.weight);
            }
            closure_store(sd, n, c);
            n += 1u;
        }
        weight *= 1.0 - inputs.metallic;
    }
    // 2. 电介质高光
    let fe = principled_specular_f0_eta(inputs.ior, inputs.specular_ior_level);
    if (fe.y != 1.0) {
        c = Closure();
        c.weight = weight;
        c.sample_weight = closure_sample_weight(c.weight);
        if (c.sample_weight > 0.0) {
            c.kind = CLOSURE_BSDF_MICROFACET_GGX;
            c.N = valid_reflection_N;
            c.alpha_x = alpha;
            c.alpha_y = alpha;
            c.ior = fe.y;
            c.fresnel_type = FRESNEL_GENERALIZED_SCHLICK;
            c.f90_or_b = vec3<f32>(1.0);
            c.exponent = -fe.y;
            c.reflection_tint = vec3<f32>(1.0);
            c.transmission_tint = vec3<f32>(0.0);
            let g = bsdf_microfacet_setup_fresnel_generalized_schlick(valid_reflection_N, wi, alpha, c.ior, fe.x * inputs.specular_tint, c.f90_or_b, c.exponent, c.reflection_tint, c.transmission_tint, preserve);
            c.f0 = g.f0;
            c.sample_weight *= average(bsdf_microfacet_estimate_albedo_generalized_schlick(valid_reflection_N, wi, alpha, c.ior, c.f0, c.f90_or_b, c.exponent, c.reflection_tint, c.transmission_tint, true, true));
            c.energy_scale = g.energy_scale;
            if (preserve) {
                c.weight *= g.weight;
                c.sample_weight *= average(g.weight);
            }
            closure_store(sd, n, c);
            n += 1u;
            // 剩下的权重按这一层的反照率衰减（Cycles 在这里调 bsdf_albedo(…, true, false)：只算反射，这个闭包没有透射，相同）
            weight = closure_layering_weight(closure_albedo(c, wi), weight);
        }
    }
    // 3. 漫反射（次表面份额是 0：底色乘 (1 − 0) 就是底色）
    c = Closure();
    c.weight = inputs.base_color * weight;
    c.sample_weight = closure_sample_weight(c.weight);
    if (c.sample_weight > 0.0) {
        c.kind = CLOSURE_BSDF_DIFFUSE;
        c.N = N;
        closure_store(sd, n, c);
        n += 1u;
    }
    (*sd).num_closure = n;
}

// 只算透明度的一档求值：命中点放过多少光（每个通道 0 到 1；0 是挡住）。不许发任何光线，不许调图案节点。
// 求交函数和阴影透射里只许调这一档，不许调上面的全量求值：这门着色器语言不许调用图里有环，而全量求值以后会回头
// 发光线（倒角、遮蔽）。`t`：命中点到光线起点的距离（贴图取级用）。
// 现在转给上游的两处做法：镂空测试（alpha_pass）与阴影穿玻璃（intersect.wgsl 的 glass_hit）。这两处直接读材质记录，
// 是已知的例外；上游的求交与阴影射线仍直接调它们，没有改道到这里。归移植闭包的人（透明闭包）填。还没有调用者。
fn shader_eval_shadow(h: Hit, d: vec3<f32>, t: f32) -> vec3<f32> {
    if (is_proc(h)) { return vec3<f32>(0.0); }
    if (!alpha_pass(h.tri, h.inst, h.u, h.v, t)) { return vec3<f32>(1.0); }
    let g = glass_hit(h, d, t);
    return g.share * g.tint;
}

// 灯采样点上的发光：发光三角 `em` 上重心坐标 (b1, b2) 的一点朝 -l 发出的辐亮度。口径照 Cycles 在灯采样点上求的表面发光
// （integrator/surface_shader.h surface_shader_emission：发光量乘 emissive_simple_eval，两面都发光）；发光量（发光色、
// 发光贴图、物体的功率倍数、材质函数）仍由上游的 emitter_radiance（light.wgsl）给。调用者：上游采样发光三角的
// sample_emitter、sample_emitter_ris（它们先按上游的规矩丢掉背对的单面卡片，再取发光值；采样的概率密度归做灯的人）。
fn shader_eval_emission(em: EmitterTri, b1: f32, b2: f32, l: vec3<f32>) -> vec3<f32> {
    return emissive_simple_eval(normalize(cross(em.e1, em.e2)), -l) * emitter_radiance(em, b1, b2, l);
}

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
    let nn = normalize_unbiased(w);
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
    let v0 = tri_verts[ti * 3u].xyz;
    let e1 = tri_verts[ti * 3u + 1u].xyz - v0;
    let e2 = tri_verts[ti * 3u + 2u].xyz - v0;
    let p = v0 + e1 * u + e2 * v;
    let ng = normalize(cross(e1, e2));
    var n = normalize_unbiased(a.n0.xyz * w + a.n1.xyz * u + a.n2.xyz * v);
    let t = normalize(a.t.xyz - n * dot(n, a.t.xyz) + vec3<f32>(1e-9));
    let oi = object_of(a);
    return MatIn(p, n, ng, t, cross(n, t) * a.t.w, mesh_uv(a, m, u, v), mesh_lod(a, m), view, object_at(oi * OBJECT_STRIDE).xyz, object_at(oi * OBJECT_STRIDE + 1u).xyz,
                 P.time.x, P.time.y, P.time.z, lod, state.bounce, object_at(oi * OBJECT_STRIDE).w, state.bounce == 0u || state.legacy.mirror_path,
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
    return approx(A_CUTOUT_PATHS) && state.bounce >= 1u && !state.legacy.mirror_path;
}

// A path stays mirror-like (`state.legacy.mirror_path`) through specular samples off surfaces smoother than this.
const MIRROR_ROUGHNESS: f32 = 0.3;

// 北冥：原来声明在这里的三个私有量 shadow_hole、nee_alone、lights_only 并进了路径状态（integrator.wgsl 的 PathLegacy，
// 说明也在那里）。

// Alpha-cutout test for candidate hits on masked triangles (mesh UVs, footprint of a camera ray at distance t). `inst`:
// the model instance a pool triangle belongs to (its scale shifts the texel density, as in `inst_attr`), or NO_INST.
// 北冥：直接读材质记录（Material）的已知例外，上游留下的；清单在 closure.wgsl「读 legacy 的例外清单」。
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

// 北冥：上游的 surface、surface_proc 算完之后的两样东西：上游自己的 Surface（上游顶替用），与材质输入值。
struct SurfaceEval { surface: Surface, inputs: ShaderInputs };

// 北冥：从上游算完贴图与材质函数之后的量取出材质输入值，夹取照 Cycles。`rough`、`metal` 是上游夹取之前的值；
// `coat`、`transmission` 是上游夹好的份额。
fn legacy_shader_inputs(m: Material, emissive: vec3<f32>, base: vec3<f32>, rough: f32, metal: f32, n: vec3<f32>, coat: f32, transmission: f32) -> ShaderInputs {
    var inp = ShaderInputs();
    inp.base_color = max(base, vec3<f32>(0.0));
    inp.metallic = clamp(metal, 0.0, 1.0);
    inp.roughness = clamp(rough, 0.0, 1.0);
    inp.ior = max(m.layer.y, 1e-5);
    inp.specular_ior_level = max(m.specular_ior_level, 0.0);
    // （边缘色只在场景里有材质的边缘色不是白时才从材质记录读，别的场景编译期就是白：F82 的 B 项在编译期是 0，
    // 每盏灯的金属求值少一截。量过：一律从记录读，没有金属的场景也慢 4%。）
    inp.specular_tint = vec3<f32>(1.0);
    if (has(F_SPECULAR_TINT)) { inp.specular_tint = max(m.specular_tint, vec3<f32>(0.0)); }
    inp.emission = emissive;
    inp.alpha = clamp(m.base_color.a, 0.0, 1.0);
    inp.diffuse_roughness = clamp(m.diffuse_roughness, 0.0, 1.0);
    inp.flags = m.flags;
    inp.coat_weight = coat;
    inp.transmission_weight = transmission;
    inp.N = n;
    return inp;
}

// `width` = ray-cone footprint (m) at the hit, for texture LOD.
// 北冥：返回值从 Surface 换成 SurfaceEval（多带一份材质输入值），别的没动。只由 shader_eval_inputs 调。
fn surface(o: vec3<f32>, d: vec3<f32>, h: Hit, width: f32) -> SurfaceEval {
    if (is_proc(h)) { return surface_proc(o, d, h, width); }
    let i = h.tri;
    let v0 = tri_verts[i * 3u].xyz;
    var e1 = tri_verts[i * 3u + 1u].xyz - v0;
    var e2 = tri_verts[i * 3u + 2u].xyz - v0;
    var a = attrs[i];
    if (has(F_INST) && h.inst != NO_INST) {
        let r = instance_at(h.inst);
        e1 = inst_vec(r, e1);
        e2 = inst_vec(r, e2);
        a = inst_attr(r, a);
    }
    let w = 1.0 - h.u - h.v;
    var ng = normalize(cross(e1, e2));
    // 北冥：镜像的实例取反，同 shader_setup_from_hit
    if (has(F_INST) && h.inst != NO_INST && (object_ext_at(object_of(a)).object_flag & SD_OBJECT_NEGATIVE_SCALE) != 0u) { ng = -ng; }
    // 着色法线不用内建 normalize：它在显卡上偏向一边，经 GGX 的 1 − cos_NH² 放大（util.wgsl 的 normalize_unbiased）
    var n = normalize_unbiased(a.n0.xyz * w + a.n1.xyz * h.u + a.n2.xyz * h.v);
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
        s.emissive = select(vec3<f32>(0.0), base, state.bounce == 0u || state.legacy.mirror_path);
        base = vec3<f32>(0.0);
        spec = 0.0;
        metal = 0.0;
    }
    // Power just changed by a script / gameplay (objects[1].w = scene time of the edit): short history.
    s.anim = P.time.x - object_at(object_of(a) * OBJECT_STRIDE + 1u).w < 0.5;
    // Detail that only matters where it is seen directly or in mirror-like reflections (puddles, glass, chrome).
    let near = state.bounce == 0u || state.legacy.mirror_path;
    if (has(F_TEX) && m.tex0.y >= 0 && near) {
        let tn = tex(m.tex0.y, uv, lod).xyz * 2.0 - 1.0;
        let tp = a.t.xyz - n * dot(n, a.t.xyz);
        if (dot(tp, tp) > 1e-12) {
            let t = normalize(tp);
            let b = cross(n, t) * a.t.w;
            let pn = t * (tn.x * m.params.w) + b * (tn.y * m.params.w) + n * tn.z;
            if (dot(pn, pn) > 1e-12 && dot(pn, ng) > 0.0) { n = normalize_unbiased(pn); }
        }
    }
    if (has(F_FUNC) && m.tex1.w > 0) {
        let oi = object_of(a);
        var t = normalize(a.t.xyz - n * dot(n, a.t.xyz) + vec3<f32>(1e-9));
        let nv = normalize_unbiased(a.n0.xyz * w + a.n1.xyz * h.u + a.n2.xyz * h.v) * select(-1.0, 1.0, front || dot(a.n0.xyz, ng) > 0.0);
        let i = MatIn(p, select(-nv, nv, dot(nv, ng) >= 0.0), ng, t, cross(n, t) * a.t.w, mesh_uv(a, m, h.u, h.v), mesh_lod(a, m), -d,
                      object_at(oi * OBJECT_STRIDE).xyz, object_at(oi * OBJECT_STRIDE + 1u).xyz, P.time.x, P.time.y, P.time.z,
                      log2(max(width, 1e-7)) - 0.5 * log2(max(abs(dot(ng, d)), 1e-3)), state.bounce, object_at(oi * OBJECT_STRIDE).w, near,
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
    var se = SurfaceEval();
    se.surface = s;
    se.inputs = legacy_shader_inputs(m, s.emissive, base, rough, metal, n, s.coat, s.transmission);
    // 北冥：three.js 的无光照材质不反光，上游把它的高光强度置 0；移植的闭包读高光等级，这里同样置 0
    if (has(F_UNLIT) && m.tex1.z == MAT_UNLIT) { se.inputs.specular_ior_level = 0.0; }
    return se;
}

// A procedural hit's surface: the material its geometry function picked, the normal it gave (geometric and shading,
// two-sided), the object's power and customData. No textures (no uv: material functions get uv 0 and can work from
// `i.wp`), no transmission.
fn surface_proc(o: vec3<f32>, d: vec3<f32>, h: Hit, width: f32) -> SurfaceEval {
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
        let near = state.bounce == 0u || state.legacy.mirror_path;
        let a = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(n.x) > 0.9);
        let t = normalize(cross(a, n));
        let i = MatIn(p, n, ng, t, cross(n, t), proc_attr(h), 0.0, -d, object_at(oi * OBJECT_STRIDE).xyz, object_at(oi * OBJECT_STRIDE + 1u).xyz,
                      P.time.x, P.time.y, P.time.z, log2(max(width, 1e-7)) - 0.5 * log2(max(abs(dot(ng, d)), 1e-3)), state.bounce,
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
    var se = SurfaceEval();
    se.surface = s;
    se.inputs = legacy_shader_inputs(m, s.emissive, base, rough, metal, n, s.coat, s.transmission);
    return se;
}
