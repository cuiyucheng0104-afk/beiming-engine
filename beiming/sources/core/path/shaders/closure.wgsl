// 源自 ThreeRT（github.com/meshy-dev/ThreeRT）固定提交 c946cc96bdb08979224e851a7fc67a066b1b456b 的 renderer/shaders/pathtrace.wgsl（北冥按阶段分出的一段：闭包），MIT 许可，版权人 Meshy LLC（2026）。这个文件北冥有没有改过、改了什么，见 ../PROVENANCE.md，许可全文见 ../LICENSE-upstream.txt。
// ------------------------------------------------------------------------------------------------
// 北冥：积分器碰材质只经下面这一组函数（名字照 Cycles 的 integrator/surface_shader.h；着色点与闭包的结构、
// 材质求值的三步在 shader.wgsl）。它们是分发函数：按闭包种类取出字段，再调标量签名的闭包函数。
// 现在每个着色点至多一个闭包：纯金属是照 Cycles 移植的微表面闭包（../../shaders/microfacet.wgsl），别的是上游顶替。

// 求值的结果。Cycles 把漫反射与光泽分开累加；上游顶替不分，只填 sum（它的高光占比另走上游的私有量 state.legacy.split_frac）。
struct BsdfEval {
    diffuse: vec3<f32>,             // 漫反射闭包的部分（已含余弦）。已定义
    glossy: vec3<f32>,              // 光泽闭包的部分。已定义
    sum: vec3<f32>,                 // 全部闭包之和（已含余弦）。已落地
    pdf: f32,                       // 立体角概率密度：各闭包的密度按 sample_weight 加权平均。已落地
};

// 采样的结果。积分器把路径的通量乘上 weight。奇异（delta）的一瓣只有 weight 有意义：label 带 LABEL_SINGULAR，
// pdf 为 0，不做多重重要性采样。
struct BsdfSample {
    wo: vec3<f32>,                  // 采样到的方向；全 0 表示没采到
    eval: BsdfEval,                 // 这个方向上的求值。上游顶替不填（它的求值直接算进了 weight）。已定义
    pdf: f32,                       // 这个方向的概率密度；奇异的一瓣为 0
    label: i32,                     // 采样标签（LABEL_*，位照 Cycles）
    sampled_roughness: vec2<f32>,   // 采样到的那个闭包的粗糙度（两个方向）
    eta: f32,                       // 折射率比。上游顶替不填，恒为 1。已定义
    weight: vec3<f32>,              // 通量的权重：eval.sum / pdf（奇异的一瓣直接给出）
};

// 选闭包的结果：选中的下标，与第三维重新拉伸回 0 到 1 之后的随机数（留给选中的闭包复用）
struct BsdfPick { closure: u32, rand: vec3<f32> };

// 采样标签里移植的着色器（../../shaders/util.wgsl）还没用到的两位，数值照 Cycles
const LABEL_TRANSMIT: i32 = 1;
const LABEL_DIFFUSE: i32 = 4;

// 闭包填好之后、算直接光与采样之前的事后处理。「滤光泽」（按路径上最小的概率密度把各闭包的粗糙度调大）以后做在这里，
// 现在还没有。
// 上游顶替：上游的 Lobes（依赖视线的分层权重）在这里算，位置与上游原来一样（发光算完、确定要往下走之后）。
// 试过提前到填闭包那一步：苹果显卡上编译出来的运算次序会变，像素末位不同。所以只发光的面、到了弹射上限的面没有 Lobes。
// 移植的闭包（纯金属）的着色点上也照算：上游的 light_mis 还经它拿概率密度（见那里的说明），而且只给上游顶替算的话，
// 苹果显卡上别的材质像素末位会变。
fn surface_shader_prepare_closures(sd: ptr<function, ShadingPoint>) {
    (*sd).legacy.lobes = lobes((*sd).legacy.surface, max(dot((*sd).legacy.surface.n, (*sd).wi), 1e-4));
}

// 一个闭包在方向 `wo` 上的求值（已含余弦，没乘闭包的 weight）与立体角概率密度；`wi` 是着色点指向来路的方向。
// 照 Cycles 的 closure/bsdf.h `bsdf_eval`：按种类取出闭包的字段，调移植的标量函数。上游顶替不走这里（它不是一个能
// 单独求值的闭包），没接的种类返回 0。
// 参数收一个闭包，不收整个着色点：试过收整个着色点（一千多字节，按值再往下传一层），苹果显卡上过程几何的阴影场景
// 会随机丢样本，每次跑丢的还不一样；换成只传闭包就好了。原因没有查实，推测与按值传大结构的层数有关。
struct ClosureEval { eval: vec3<f32>, pdf: f32 };

fn bsdf_eval(c: Closure, wi: vec3<f32>, wo: vec3<f32>) -> ClosureEval {
    var r = ClosureEval();
    if (c.kind == CLOSURE_BSDF_MICROFACET_GGX) {
        let e = bsdf_microfacet_ggx_eval(c.N, wi, wo, c.alpha_x, c.f0, c.f90_or_b, c.energy_scale);
        r.eval = e.eval;
        r.pdf = e.pdf;
    }
    return r;
}

// 对所有闭包求值求和。`light_shader_flags`：灯的着色标志（按灯排除漫反射、光泽、透射闭包），现在都传 0，没人读。
// 多个闭包求和、密度按 sample_weight 加权平均的那一段归移植闭包的人照 Cycles 写。
// 要先调过 surface_shader_prepare_closures。还没有调用者：上游的灯光函数用的是上游顶替专用的那一个求值，
// 上游顶替的采样把求值直接算进权重里（见 surface_shader_bsdf_sample_legacy）。照 Cycles 做灯的人来调它。
fn surface_shader_bsdf_eval(sd: ShadingPoint, wo: vec3<f32>, light_shader_flags: u32) -> BsdfEval {
    var r = BsdfEval();
    if (sd.num_closure == 0u) { return r; }
    if (sd.closure[0].kind == CLOSURE_LEGACY) {
        // 上游顶替：密度与求值直接转给上游的两个函数，次序照上游（先密度后求值）
        r.pdf = pdf_bsdf(sd.legacy.surface, sd.legacy.lobes, sd.wi, wo);
        r.sum = eval_bsdf(sd.legacy.surface, sd.legacy.lobes, sd.wi, wo);
    } else {
        let e = bsdf_eval(sd.closure[0], sd.wi, wo);
        r.glossy = e.eval * sd.closure[0].weight;
        r.sum = r.glossy;
        r.pdf = e.pdf;
    }
    return r;
}

// 按 sample_weight 选一个闭包去采样。`rand`：三个随机数，第三个用来选，选完重新拉伸回 0 到 1。
// 现在至多一个闭包：选第 0 个，随机数原样返回。多个闭包的选法归移植闭包的人照 Cycles 写。
fn surface_shader_bsdf_bssrdf_pick(sd: ShadingPoint, rand: vec3<f32>) -> BsdfPick {
    var r = BsdfPick();
    r.closure = 0u;
    r.rand = rand;
    return r;
}

// 在第 `k` 个闭包上采样方向：用 `rand` 的前两个定方向；有多个闭包时把其余闭包的贡献并进 eval 与 pdf。
// 上游顶替不用 `rand`：它自己从上游的随机数里取（sample_bsdf）。要先调过 surface_shader_prepare_closures。
fn surface_shader_bsdf_sample_closure(sd: ShadingPoint, k: u32, rand: vec3<f32>) -> BsdfSample {
    let c = sd.closure[k];
    if (c.kind == CLOSURE_LEGACY) { return surface_shader_bsdf_sample_legacy(sd); }
    var bs = BsdfSample();
    if (c.kind != CLOSURE_BSDF_MICROFACET_GGX) { return bs; }
    let m = bsdf_microfacet_ggx_sample(c.N, sd.Ng, sd.wi, c.alpha_x, c.f0, c.f90_or_b, c.energy_scale, rand.xy);
    // 没采到（label 为 LABEL_NONE）：结果全 0，积分器看到密度为 0 就结束这条路径。零方向上的求值照算但不用：那里
    // 密度不是 0，求值为 0 靠的是除以零得无穷大，这门语言不保证。用 select 不用分支：这个函数里多一支分支，
    // 苹果显卡上没有金属的场景稳态也会慢 3% 到 4%。
    let ok = m.label != LABEL_NONE;
    bs.wo = m.wo;
    bs.label = m.label;
    let e = bsdf_eval(c, sd.wi, m.wo);
    bs.pdf = select(0.0, e.pdf, ok);
    bs.eval.glossy = select(vec3<f32>(0.0), e.eval * c.weight, ok);
    bs.eval.sum = bs.eval.glossy;
    bs.eval.pdf = bs.pdf;
    bs.weight = select(vec3<f32>(0.0), bs.eval.sum / max(e.pdf, 1e-20), ok);
    // （这里的口径是粗糙度，即 alpha 的平方根：积分器拿它算光线锥与「镜面路径」。Cycles 的同名量是 alpha。）
    bs.sampled_roughness = select(vec2<f32>(0.0), sqrt(vec2<f32>(c.alpha_x, c.alpha_y)), ok);
    bs.eta = select(0.0, 1.0, ok);
    // （上游的私有量：这次采样里高光占的份额，积分器在相机命中处读它。微表面闭包全是高光。）
    state.legacy.split_frac = vec3<f32>(1.0);
    return bs;
}

// 这个点朝来路发出的光。上游的发光卡片是单面的：打在背面时不发光。
fn surface_shader_emission(sd: ShadingPoint) -> vec3<f32> {
    if (sd.legacy.surface.card && (sd.flag & SD_BACKFACING) != 0u) { return vec3<f32>(0.0); }
    return sd.emission;
}

// 阴影射线穿过这个点时放过多少光（透明闭包的权重之和）。现在没有透明闭包，恒为 0。
// 归移植闭包的人（透明闭包）填。还没有调用者。
fn surface_shader_transparency(sd: ShadingPoint) -> vec3<f32> {
    return vec3<f32>(0.0);
}

// 第 `k` 个闭包的反照率（降噪特征与层间衰减用）。口径还是上游的：上游顶替返回上游的底色，微表面闭包返回 F0
// （纯金属的底色）；Cycles 的口径（按菲涅耳估出来的反照率乘闭包权重）归换降噪口径的人改。别的种类现在返回 0。
fn bsdf_albedo(sd: ShadingPoint, k: u32) -> vec3<f32> {
    if (sd.closure[k].kind == CLOSURE_LEGACY) { return sd.legacy.surface.base; }
    if (sd.closure[k].kind == CLOSURE_BSDF_MICROFACET_GGX) { return sd.closure[k].f0; }
    return vec3<f32>(0.0);
}

// ------------------------------------------------------------------------------------------------
// 北冥：上游顶替。下面两个函数把着色点转给上游原来的求值与采样（本文件后面的 eval_bsdf_k、pdf_bsdf、sample_bsdf）。
// 带清漆或透射的金属仍在上游顶替里，它的基础高光层走移植闭包的那条接线（Lobes.bm）原样留着；纯金属已经是独立的
// 微表面闭包，不进上游的这几个函数。
// 这一层的写法是试出来的：显卡的着色器编译器会按上下文合并或重排浮点运算，同样的式子换一种组织法（多包一层函数、
// 把两个量合在一个函数里算、按值返回大结构、把除法挪到调用方）就可能换一种运算次序，像素末位随之变化，两块显卡
// 各有各的敏感处。改这里之后要在两台机器上重跑回归基线核对。
//
// 读 legacy 的例外清单（新写的代码不许再加；哪次移植删掉了读者，就顺手从这里划掉）：
//   closure.wgsl     下面两个转接函数；surface_shader_prepare_closures（算上游的 Lobes）；surface_shader_bsdf_eval
//                    （转给上游的 pdf_bsdf、eval_bsdf）；surface_shader_emission（发光卡片单面）；bsdf_albedo（上游的底色）；
//                    light_mis（直接调上游的 pdf_bsdf，移植的闭包也经它；并读 Lobes 的 p_coat、p_trans、p_spec、a2、bm、coat、coat_alpha
//                    与 Surface 的粗糙度、法线）；pdf_spec（直接读 Lobes 的 bm、a2，与 Surface 的法线）。
//                    light_mis 与 pdf_spec 这两处归做灯的人删。
//   shader.wgsl      shader_eval_inputs（留下上游的 Surface）；shader_setup_closures（发光卡片没有闭包）。
//   light.wgsl       local_lights（两处问「是不是两面受光」two_sided，候选权重的余弦用上游的着色法线）；
//                    direct_light（发光体采样用上游的着色法线，并问 two_sided）。归做灯的人删。
//   integrator.wgsl  相机命中处记的几个量（实时预览留下的 anim、rough0、glass0、refl_e 与清漆判断），现在没有读者。
// 另有直接读材质记录（Material）的已知例外，都是上游留下的。求交一侧：镂空测试 alpha_pass（shader.wgsl）、阴影穿玻璃
// glass_at（intersect.wgsl）、硬件求交的 cutout（trace_hw.wgsl）。灯光一侧读发光三角的材质：emitter_radiance、emitter_sel、
// emit_mis、sample_emitter、sample_emitter_ris（light.wgsl），归做灯的人。还有给材质函数备输入的 mat_in_at（shader.wgsl）。

// 上游的灯光函数专用的求值：方向 `wo` 上 BSDF 乘余弦的值，与这次求值里高光占的份额（逐通道）。
// `k`：上游每盏灯的高光倍率，只对上游顶替的闭包有效（移植的闭包不认它）。新写的代码不许调；灯移植完后删。
// 移植的闭包在这里多查一次几何法线：上游的灯光函数靠求值为 0 来丢掉几何面背后的灯（Cycles 的求值有意不查）。
// 不带概率密度：试过在这里一并算（上游的 pdf_bsdf），苹果显卡上有玻璃的场景像素末位会变。要密度的地方
// （light_mis、surface_shader_bsdf_eval）直接调上游的 pdf_bsdf。
struct BsdfEvalLegacy { eval: vec3<f32>, spec_frac: vec3<f32> };

fn surface_shader_bsdf_eval_legacy(sd: ShadingPoint, wo: vec3<f32>, k: f32) -> BsdfEvalLegacy {
    var r = BsdfEvalLegacy();
    if (sd.closure[0].kind != CLOSURE_LEGACY) {
        state.legacy.split_frac = vec3<f32>(1.0);
        r.spec_frac = state.legacy.split_frac;
        if (dot(sd.Ng, wo) > 0.0) { r.eval = bsdf_eval(sd.closure[0], sd.wi, wo).eval * sd.closure[0].weight; }
        return r;
    }
    r.eval = eval_bsdf_k(sd.legacy.surface, sd.legacy.lobes, sd.wi, wo, k);
    // （上游把高光份额留在私有量 state.legacy.split_frac 里；值为 0 的方向上它不更新，照旧是上一次的。）
    r.spec_frac = state.legacy.split_frac;
    return r;
}

// 上游顶替专用的采样：方向由上游的 sample_bsdf 定（它自己取随机数，并记下采到的是哪一瓣）。
// 权重照上游原样的式子在这里算（求值除以密度，一步写完）。试过拆成「这里给求值与密度、积分器来除」：
// 英伟达显卡上软件求交的像素末位会变。
fn surface_shader_bsdf_sample_legacy(sd: ShadingPoint) -> BsdfSample {
    var bs = BsdfSample();
    let s = sd.legacy.surface;
    let lb = sd.legacy.lobes;
    let l = sample_bsdf(s, lb, sd.wi);
    // Through smooth glass: a delta lobe (weight tint / its sampling share, no MIS: what lies behind counts in full).
    // Rough glass's transmission has a density like any lobe. Either way the live viewport files the light with
    // the specular, like a reflection.
    let through = has(F_GLASS) && state.legacy.sampled_trans && !lb.rough_t;
    bs.wo = l;
    var pdf = 0.0;
    var wgt = lb.tint / max(lb.p_trans, 1e-6);
    if (through) {
        state.legacy.split_frac = vec3<f32>(1.0);
        bs.label = LABEL_TRANSMIT | LABEL_SINGULAR;
    } else {
        pdf = pdf_bsdf(s, lb, sd.wi, l);
        wgt = eval_bsdf(s, lb, sd.wi, l) / max(pdf, 1e-20);
        if (state.legacy.sampled_trans) {
            bs.label = LABEL_TRANSMIT | LABEL_GLOSSY;
        } else if (state.legacy.sampled_spec) {
            bs.label = LABEL_REFLECT | LABEL_GLOSSY;
        } else {
            bs.label = LABEL_REFLECT | LABEL_DIFFUSE;
        }
    }
    bs.pdf = pdf;
    bs.weight = wgt;
    bs.sampled_roughness = vec2<f32>(s.roughness);
    bs.eta = 1.0;
    return bs;
}

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
        state.legacy.split_frac = vec3<f32>(1.0);
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
    state.legacy.split_frac = spec / max(diff + spec, vec3<f32>(1e-12));
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
// the sample through a cutout (`state.legacy.shadow_hole`) is light this vertex's BSDF ray cannot bring, a cutout being opaque to
// it, unless it is a specular or coat sample that keeps the path mirror-like (`state.legacy.mirror_path`). The sample takes the
// BSDF ray's weight for the rest: 1 - (the share of pdf_bsdf that still tests cutouts) x (the BSDF ray's weight).
// (Until 2026-11-15 the weight was the plain heuristic: under a card cut out everywhere a uniform sky lit a Lambert
// plane with 18 % of its light.)
// 北冥：参数从 (Surface, Lobes, 视线) 换成着色点。函数体直接调上游的 pdf_bsdf、直接读 Lobes 的内部字段，
// 是登记过的例外（见本文件「上游顶替」一节），归做灯的人删。
// 移植的闭包（纯金属）在这里也走上游的 pdf_bsdf：它的 Lobes.bm 为真，pdf_bsdf 给出的就是同一个移植函数算的微表面
// 密度（密度只看法线、两个方向与 alpha，与菲涅耳无关），和采样一侧的密度配得上。没有改成按闭包种类分支：试过三种
// 写法，不是苹果显卡就是英伟达显卡上别的材质像素末位会变。
fn light_mis(pdf_l: f32, sd: ShadingPoint, l: vec3<f32>) -> f32 {
    if (state.legacy.nee_alone) { return 1.0; }
    let s = sd.legacy.surface;
    let lb = sd.legacy.lobes;
    let v = sd.wi;
    let pb = pdf_bsdf(s, lb, v, l);
    let w = power_heuristic(pdf_l, pb);
    if (!approx(A_CUTOUT_PATHS) || !has(F_MASKED) || !state.legacy.shadow_hole) { return w; }
    var see = 0.0;
    if ((state.bounce == 0u || state.legacy.mirror_path) && s.roughness < MIRROR_ROUGHNESS && pb > 0.0) {
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

// A direction by the BSDF's lobes (`pdf_bsdf` its density; which lobe: state.legacy.sampled_spec, state.legacy.sampled_trans). The zero vector:
// no sample (every value and density of it is 0).
fn sample_bsdf(s: Surface, lb: Lobes, v: vec3<f32>) -> vec3<f32> {
    let tbn = basis(s.n);
    let r = rng4(rng_legacy(D_BSDF));
    state.legacy.sampled_trans = false;
    if (has(F_COAT) || has(F_GLASS)) {
        let u = r.x;
        if (u < lb.p_coat) {
            state.legacy.sampled_spec = true;
            return reflect(-v, sample_vndf(v, tbn, lb.coat_alpha, r.z, r.w));
        }
        if (u < lb.p_coat + lb.p_trans) {
            // The dielectric: a visible microfacet normal; reflected off it, or refracted through it (smooth glass:
            // through the shading normal), by the Fresnel reflectance there.
            let h = sample_vndf(v, tbn, s.roughness * s.roughness, r.z, r.w);
            var m = s.n;
            if (lb.rough_t) { m = h; }
            let t = refract(-v, m, 1.0 / lb.eta);
            state.legacy.sampled_spec = u - lb.p_coat < fresnel_dielectric(max(dot(v, m), 1e-4), lb.eta) * lb.p_trans || all(t == vec3<f32>(0.0));
            // A ray reflected under the surface, or refracted and still above it, is one the microfacets' masking
            // stops: no sample.
            if (state.legacy.sampled_spec) {
                let rl = reflect(-v, h);
                return select(rl, vec3<f32>(0.0), dot(rl, s.n) <= 0.0);
            }
            state.legacy.sampled_trans = true;
            return select(t, vec3<f32>(0.0), dot(t, s.n) >= 0.0);
        }
    }
    state.legacy.sampled_spec = r.y < lb.p_spec;
    if (state.legacy.sampled_spec && lb.bm) {
        let c = bm_closure(s, v);
        let m = bsdf_microfacet_ggx_sample(s.n, s.ng, v, roughness_to_alpha(s.roughness), s.base, c.b, c.energy_scale, r.zw);
        return select(vec3<f32>(0.0), m.wo, m.label != LABEL_NONE);
    }
    if (state.legacy.sampled_spec) {
        let h = sample_vndf(v, tbn, s.roughness * s.roughness, r.z, r.w);
        return reflect(-v, h);
    }
    let rr = sqrt(r.z);
    let phi = 2.0 * PI * r.w;
    return tbn * vec3<f32>(rr * cos(phi), rr * sin(phi), sqrt(max(0.0, 1.0 - rr * rr)));
}

// Density of l under the base specular lobe alone (VNDF sampling).
// 北冥：参数从 (Surface, Lobes, 视线) 换成着色点。直接读 Lobes 的 bm、a2，是登记过的例外，归做灯的人删。
// 它唯一的调用处在积分主循环里实时预览留下的、没人读的那一段。
fn pdf_spec(sd: ShadingPoint, l: vec3<f32>) -> f32 {
    let s = sd.legacy.surface;
    let lb = sd.legacy.lobes;
    let v = sd.wi;
    let nov = max(dot(s.n, v), 1e-4);
    let noh = max(dot(s.n, normalize(v + l)), 0.0);
    if (lb.bm) { return bm_eval(s, v, l).pdf; }
    return g1(lb.a2, nov) * d_ggx(lb.a2, noh) / (4.0 * nov);
}
