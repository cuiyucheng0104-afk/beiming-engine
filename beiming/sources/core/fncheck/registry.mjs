// 函数登记表：比对外壳只认这里登记的函数。每项的 WGSL 函数名与标准答案程序（cycles/ref.cpp）的函数标识同名。
// inputs：[参数名, 'f32' | 'vec3f', [下限, 上限]]，在范围里均匀取；范围第三项写 'log' 时按对数均匀取。
// vec3f 可给一个范围（三个分量共用）或三个范围（逐分量）。
// 合格：|被测−标准| ≤ rel·|标准| + abs。rel 一律 1e-4。
// abs 只给有相减抵消的函数：两个 O(1) 的数相减得到接近 0 的结果时，两边哪怕只差 1 ULP 的舍入（WGSL 的 sqrt、
// 除法不保证正确舍入，编译器还可能合成 FMA），相对误差也会大到几十个百分点。这类函数的 abs 取「抵消发生处的
// 量级上 4 个 ULP」，再乘上相减之后的放大系数；实测的最大差值都在它的一半以内。
const FILE = 'shaders/microfacet.wgsl';
const entry = (name, inputs, out, abs = 0) => ({ name, file: FILE, wgsl: name, ref: name, inputs, out, rel: 1e-4, abs });

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

/** 一组输入有几个 float32 */
export const width = f => f.inputs.reduce((s, [, type]) => s + (type === 'vec3f' ? 3 : 1), 0);

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
