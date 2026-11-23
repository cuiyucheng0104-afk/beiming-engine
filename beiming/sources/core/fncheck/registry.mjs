// 函数登记表：比对外壳只认这里登记的函数。每项的 WGSL 函数名与标准答案程序（cycles/ref.cpp）的函数标识同名。
// inputs：[参数名, 'f32' | 'vec2f' | 'vec3f' | 'dir', 范围]。
//   f32、vec2f、vec3f 在 [下限, 上限] 里均匀取；范围第三项写 'log' 时按对数均匀取；向量可给一个范围（各分量共用）或逐分量各一个。
//   dir 是单位向量，范围是 z 的 [下限, 上限]：在球面上 z 落在这段里的那一圈带上按面积均匀取。[-1, 1] 是整个球面，[0, 1] 是上半球。
// out：输出分量数（函数返回 f32、向量或 array<f32, N>），或 { 字段名: 分量数 } 依次取返回结构体的字段。
// file：WGSL 函数所在的文件；比对时 SHADERS 里的文件全部拼进一个着色器，所以函数可以调用别的文件里的函数。
// call：可选，(实参 WGSL 表达式数组) => 调用表达式，给要补常量实参的函数用（例如查表函数的表偏移）。
// skip：可选，(标准答案的一组输出, 被测的一组输出) => 真时这一组不比、只计数。只给登记处写明了理由的病态区域用。
// 合格：|被测−标准| ≤ rel·|标准| + abs。rel 一律 1e-4。
// abs 只给有相减抵消的函数：两个 O(1) 的数相减得到接近 0 的结果时，两边哪怕只差 1 ULP 的舍入（WGSL 的 sqrt、
// 除法不保证正确舍入，编译器还可能合成 FMA），相对误差也会大到几十个百分点。这类函数的 abs 取「抵消发生处的
// 量级上 4 个 ULP」，再乘上相减之后的放大系数；实测的最大差值都在它的一半以内。
export const SHADERS = ['shaders/microfacet.wgsl', 'shaders/util.wgsl', 'shaders/ggx_tables.wgsl'];
const BSD = SHADERS[0], APACHE = SHADERS[1];
const entry = (name, inputs, out, abs = 0, more = {}) => ({ name, file: BSD, wgsl: name, ref: name, inputs, out, rel: 1e-4, abs, ...more });

// alpha2 = 粗糙度 alpha 的平方。Cycles 在 alpha_x·alpha_y ≤ 2e-10 时才当成纯镜面、不再求值，所以下限取到它上面一点；
// 按对数均匀取，抛光金属那一头（alpha 很小）和粗糙那一头拿到一样多的样本。alpha2 = 0 时 bsdf_D 是 0/0，两边都出 NaN。
const ALPHA2 = [2.56e-10, 1, 'log'];
const ALPHA = [1.6e-5, 1, 'log'];
// cos_N = 0 时 1/sqr(cos_N) 是无穷，两边都出 inf；掠射角取到 1e-3（约 89.94°）为止
const COS = [1e-3, 1];
// 向量的 z 分量（法线方向）不能是 0：aniso_lambda 除以 sqr(V.z)
const XY = [-1, 1];
const Z = [0.05, 1];
// F82 的 B 来自 fresnel_f82tint_B：F_schlick·7/f⁶·(1−tint)，最大约 17.6，取到 18
const B = [0, 18];
const UNIT = [0, 1];
// float32 在 [1, 2) 的 ULP
const ULP1 = 2 ** -23;
// fresnel_f82_B 把 F_schlick − F82 乘上 7/f⁶（f = 6/7），约 17.6
const F82_GAIN = 7 / (6 / 7) ** 6;

/** 一个输入占几个 float32 */
export const size = type => ({ f32: 1, vec2f: 2, vec3f: 3, dir: 3 })[type];
/** 一组输入有几个 float32 */
export const width = f => f.inputs.reduce((s, [, type]) => s + size(type), 0);
/** 一组输出有几个 float32 */
export const outWidth = f => (typeof f.out === 'number' ? f.out : Object.values(f.out).reduce((a, b) => a + b, 0));

export const FUNCTIONS = [
  // 参数是 alpha2·tan²θ；取到 100（约 alpha=1、θ=84°），再大 lambda 只是 √x/2 的单调延伸
  entry('bsdf_lambda_from_sqr_alpha_tan_n_ggx', [['sqr_alpha_tan_n', 'f32', [0, 100]]], 1, 4 * ULP1),
  // lambda 的三个函数都在 sqrt(1 + x) − 1 处抵消（x 接近 0，即接近法线方向），量级 1
  entry('bsdf_lambda_ggx', [['alpha2', 'f32', ALPHA2], ['cos_N', 'f32', COS]], 1, 4 * ULP1),
  entry('bsdf_aniso_lambda_ggx', [['alpha_x', 'f32', ALPHA], ['alpha_y', 'f32', ALPHA], ['V', 'vec3f', [XY, XY, Z]]], 1, 4 * ULP1),
  entry('bsdf_G_mono_ggx', [['alpha2', 'f32', ALPHA2], ['cos_N', 'f32', COS]], 1),
  entry('bsdf_G_combined_ggx', [['alpha2', 'f32', ALPHA2], ['cos_NI', 'f32', COS], ['cos_NO', 'f32', COS]], 1),
  entry('bsdf_D_ggx', [['alpha2', 'f32', ALPHA2], ['cos_NH', 'f32', UNIT]], 1),
  entry('bsdf_aniso_D_ggx', [['alpha_x', 'f32', ALPHA], ['alpha_y', 'f32', ALPHA], ['H', 'vec3f', [XY, XY, Z]]], 1),
  // F82 这几个都是 O(1) 的 F_schlick 减去另一项，量级 1；f82_B 相减后再乘 F82_GAIN
  entry('fresnel_f82_Fss', [['F0', 'vec3f', UNIT], ['B', 'vec3f', B]], 3, 4 * ULP1),
  entry('fresnel_f82tint_B', [['F0', 'vec3f', UNIT], ['tint', 'vec3f', UNIT]], 3),
  entry('fresnel_f82_B', [['F0', 'vec3f', UNIT], ['F82', 'vec3f', UNIT]], 3, 4 * ULP1 * F82_GAIN),
  entry('fresnel_f82_B_f32', [['F0', 'f32', UNIT], ['F82', 'f32', UNIT]], 1, 4 * ULP1 * F82_GAIN),
  entry('fresnel_f82', [['cosi', 'f32', UNIT], ['F0', 'vec3f', UNIT], ['B', 'vec3f', B]], 3, 4 * ULP1),
  entry('fresnel_f82_f32', [['cosi', 'f32', UNIT], ['F0', 'f32', UNIT], ['B', 'f32', B]], 1, 4 * ULP1),
];

// 下面是闭包一层（金属反射：GGX、F82-tint、无薄膜、各向同性）与它用到的采样和工具函数。
//
// 闭包一层的输入范围收在 float32 条件良好的区域里，理由（都是 Cycles 原式在 float32 下的病态，不是移植的差别；
// 在不合格的组里拿双精度照原式算真值，Cycles 本机一侧离真值并不比显卡近，实测记录见核对报告）：
//   - N 固定为 (0, 0, 1)（dir 的 z 范围取 [1, 1]）：cos_NI、cos_NO 就是输入的 z 分量，不经 dot 相消。贴着地平线时
//     λ ∝ 1/cos，dot 的一个 ULP 会被放大成求值结果的相对误差。任意法线下的转换由 make_orthonormals、to_global 两项单独对拍。
//   - alpha 取 [0.1, 1]：bsdf_D 里 1 − cos_NH² 在半向量贴近法线时相消，采样出的半向量正好都贴近法线，
//     误差约 4·δcos/alpha²；alpha 小于 0.1 时 cos_NH 差一两个 ULP 就超过 1e-4。纯镜面一支另登记一项。
//   - b 取 [0, 4]：F82 的 F_schlick − B·cos·(1−cos)⁶ 在 B 大时相消；B ≤ 4 时反射率不低于 Schlick 项的一半。
//     B 到 18 的整个范围在 microfacet_fresnel_f82 一项（带 abs）里对拍。
//   - 随机数取 [1e-2, 1 − 1e-2]：贴近 0 或 1 时同心圆映射落在圆盘边缘，disk_to_hemisphere 的 1 − |p|² 相消，
//     显卡 cos、sin 约 2e-7 的绝对误差被放大（离边缘 1e-3 时半向量分量的相对误差到 1.4e-4，贴到边缘时到 1e-2）。
// 收窄之外的区域（alpha 在纯镜面阈值到 0.1 之间等）由 χ² 检验从统计上覆盖，不在这里逐组比。
const NDIR = [0.5, 1];
const HEMI = [0, 1];
const F0 = UNIT;
const NZ = [1, 1];
const ALPHA_CLOSURE = [0.1, 1, 'log'];
// alpha_x·alpha_y ≤ 2e-10 是纯镜面
const ALPHA_SINGULAR = [1e-6, 1.4e-5, 'log'];
const B_CLOSURE = [0, 4];
const RAND = [1e-2, 1 - 1e-2];
const EVAL_IN = alpha => [['N', 'dir', NZ], ['wi', 'dir', HEMI], ['wo', 'dir', [-0.2, 1]], ['alpha', 'f32', alpha], ['f0', 'vec3f', F0], ['b', 'vec3f', B_CLOSURE]];
const SAMPLE_IN = alpha => [['N', 'dir', NZ], ['Ng', 'dir', NDIR], ['wi', 'dir', HEMI], ['alpha', 'f32', alpha], ['f0', 'vec3f', F0], ['b', 'vec3f', B_CLOSURE]];
const EVAL_OUT = { eval: 3, pdf: 1 };
const SAMPLE_OUT = { label: 1, eval: 3, wo: 3, pdf: 1 };
// wo = 2(H·wi)·H − wi 的分量是量级 1 的数相减，H 又带着上面说的圆盘边缘附近被放大的 cos、sin 误差。
// 实测所需 abs 见测试输出，在这个 abs 的一半以内
const SAMPLE_ABS = 2e-5;
// 出射方向贴着地平线（cos_NO < 1e-2，N 固定为 z 轴所以就是 wo.z）的组不逐组比：求值里 λO ∝ 1/cos_NO，
// cos_NO 的绝对误差（约 4e-7，来自上一条）变成求值结果 δcos/cos 的相对误差，用 abs 兜不住；cos_NO 贴着 0 时
// 两边还可能一边判在上半球、一边判在下半球。所以任一边给出贴地出射就不比。比例见测试输出，由 χ² 检验覆盖
const grazing = o => o[0] !== 0 && o[6] < 1e-2;
const GRAZING = (ref, test) => grazing(ref) || grazing(test);

FUNCTIONS.push(
  // 结果分量是 O(1) 的数相减（N.z−N.y 这类差，cross 的两项乘积之差），接近 0 时只能靠 abs
  entry('make_orthonormals', [['N', 'dir', [-1, 1]]], { a: 3, b: 3 }, 4 * ULP1, { file: APACHE }),
  // p.x·X + p.y·Y + p.z·Z 三项正负相消，量级 1
  entry('to_global', [['p', 'dir', [-1, 1]], ['X', 'vec3f', [-1, 1]], ['Y', 'vec3f', [-1, 1]], ['Z', 'vec3f', [-1, 1]]], 3, 4 * ULP1, { file: APACHE }),
  // 1 − |p|² 在 |p| 接近 1 时抵消；取在半径 0.99 以内
  entry('disk_to_hemisphere', [['p', 'vec2f', [-0.7, 0.7]]], 3, 0, { file: APACHE }),
  // 取到 [0, 1] 外面一点，覆盖 saturate 与端点处 t == 0 的那一支
  entry('lookup_table_read_ggx_Eavg', [['x', 'f32', [-0.1, 1.1]]], 1, 0, { file: APACHE, wgsl: 'lookup_table_read', call: ([x]) => `lookup_table_read(${x}, TABLE_GGX_EAVG, 32)` }),
  entry('lookup_table_read_2D_ggx_E', [['x', 'f32', [-0.1, 1.1]], ['y', 'f32', [-0.1, 1.1]]], 1, 0, { file: APACHE, wgsl: 'lookup_table_read_2D', call: ([x, y]) => `lookup_table_read_2D(${x}, ${y}, TABLE_GGX_E, 32, 32)` }),
  // r·cos(phi)、r·sin(phi) 在 phi 接近 ±π/2 时 cos 接近 0；显卡上 cos 的误差是绝对误差，量级 1
  entry('sample_uniform_disk', [['rand', 'vec2f', UNIT]], 2, 4 * ULP1),
  // 半向量分量是量级 1 的数经 to_global 相加，贴近 0 时靠 abs；中间经过两次归一化、一次 to_global 和显卡的 cos、sin，
  // 每步都带几个 ULP，取 16 个 ULP。alpha 取整个范围，随机数离开圆盘边缘（理由同上）
  entry('microfacet_ggx_sample_vndf', [['wi', 'dir', [1e-3, 1]], ['alpha_x', 'f32', ALPHA], ['alpha_y', 'f32', ALPHA], ['rand', 'vec2f', RAND]], 3, 16 * ULP1),
  // 同 fresnel_f82：F_schlick 减去 B 项
  entry('microfacet_fresnel_f82', [['cos_theta_i', 'f32', UNIT], ['f0', 'vec3f', F0], ['b', 'vec3f', B]], 3, 4 * ULP1),
  entry('microfacet_ggx_preserve_energy', [['N', 'dir', NDIR], ['wi', 'dir', HEMI], ['alpha', 'f32', ALPHA], ['Fss', 'vec3f', UNIT]], { energy_scale: 1, darkening: 3 }),
  entry('bsdf_microfacet_setup_fresnel_f82_tint', [['N', 'dir', NDIR], ['wi', 'dir', HEMI], ['alpha', 'f32', ALPHA], ['f0', 'vec3f', F0], ['f82_tint', 'vec3f', UNIT]], { b: 3, energy_scale: 1, weight: 3 }, 0, { call: a => `bsdf_microfacet_setup_fresnel_f82_tint(${a.join(', ')}, true)` }),
  entry('bsdf_microfacet_eval_ggx', EVAL_IN(ALPHA_CLOSURE), EVAL_OUT),
  // 纯镜面：没有求值，恒返回 0
  entry('bsdf_microfacet_eval_ggx_singular', EVAL_IN(ALPHA_SINGULAR), EVAL_OUT, 0, { wgsl: 'bsdf_microfacet_eval_ggx', ref: 'bsdf_microfacet_eval_ggx' }),
  entry('bsdf_microfacet_ggx_eval', [...EVAL_IN(ALPHA_CLOSURE), ['energy_scale', 'f32', [1, 2]]], EVAL_OUT),
  entry('bsdf_microfacet_sample_ggx', [...SAMPLE_IN(ALPHA_CLOSURE), ['rand', 'vec2f', RAND]], SAMPLE_OUT, SAMPLE_ABS, { skip: GRAZING }),
  // 纯镜面：半向量就是法线，概率密度与求值乘 1e6
  entry('bsdf_microfacet_sample_ggx_singular', [...SAMPLE_IN(ALPHA_SINGULAR), ['rand', 'vec2f', UNIT]], SAMPLE_OUT, 4 * ULP1, { wgsl: 'bsdf_microfacet_sample_ggx', ref: 'bsdf_microfacet_sample_ggx' }),
  entry('bsdf_microfacet_ggx_sample', [...SAMPLE_IN(ALPHA_CLOSURE), ['energy_scale', 'f32', [1, 2]], ['rand', 'vec2f', RAND]], SAMPLE_OUT, SAMPLE_ABS, { skip: GRAZING }),
);
