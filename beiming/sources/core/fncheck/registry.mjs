// 函数登记表：比对外壳只认这里登记的函数。每项的 WGSL 函数名与标准答案程序（cycles/ref.cpp）的函数标识同名。
// inputs：[参数名, 'f32' | 'vec2f' | 'vec3f' | 'dir', 范围]。
//   f32、vec2f、vec3f 在 [下限, 上限] 里均匀取；范围第三项写 'log' 时按对数均匀取；向量可给一个范围（各分量共用）或逐分量各一个。
//   dir 是单位向量，范围是 z 的 [下限, 上限]：在球面上 z 落在这段里的那一圈带上按面积均匀取。[-1, 1] 是整个球面，[0, 1] 是上半球。
// out：输出分量数（函数返回 f32、向量或 array<f32, N>），或 { 字段名: 分量数 } 依次取返回结构体的字段。
// file：WGSL 函数所在的文件；比对时 SHADERS 里的文件全部拼进一个着色器，所以函数可以调用别的文件里的函数。
// call：可选，(实参 WGSL 表达式数组) => 调用表达式，给要补常量实参的函数用（例如查表函数的表偏移）。
// gen：可选，(next: () => [0,1) 均匀数) => { 输入名: 数或数组 }，逐组生成彼此相关的输入（正交基、相对灯面的位置）；有它时 inputs 不写范围。
// branch：可选，(一组输入) => 分支名，只用来在报告里数各分支的比例。
// skip：可选，(标准答案的一组输出, 被测的一组输出) => 真时这一组不比、只计数。只给登记处写明了理由的病态区域用。
// 合格：|被测−标准| ≤ rel·|标准| + abs。rel 一律 1e-4。
// abs 只给有相减抵消的函数：两个 O(1) 的数相减得到接近 0 的结果时，两边哪怕只差 1 ULP 的舍入（WGSL 的 sqrt、
// 除法不保证正确舍入，编译器还可能合成 FMA），相对误差也会大到几十个百分点。这类函数的 abs 取「抵消发生处的
// 量级上 4 个 ULP」，再乘上相减之后的放大系数；实测的最大差值都在它的一半以内。
export const SHADERS = ['shaders/microfacet.wgsl', 'shaders/util.wgsl', 'shaders/ggx_tables.wgsl', 'shaders/area_light.wgsl'];
const BSD = SHADERS[0], APACHE = SHADERS[1], LIGHT = SHADERS[3];
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

// 下面是矩形面光（只移矩形、无聚拢那一条路）与它用到的工具函数，来源都是 Apache-2.0 的文件。
// 面光几何要正交基和相对灯面的位置，各分量不能各自独立取，所以这些项用 gen(next) 逐组生成，按 inputs 的名字依次写入：
// 灯心 co 在 [-1, 1]³，灯面朝向是均匀随机旋转（Shoemake 四元数）给出的 axis_u、axis_v，dir = axis_u × axis_v，
// invarea = 1/(len_u·len_v)（宿主侧这样填是【推断】，内核只把它乘进 eval_fac）。着色点 P 按「离灯心的距离 t、看灯心的仰角」取：
// 仰角的正弦 e = |dot(P − co, dir)|/t，方位角均匀，正反两面各半（反面在灯背后）。全部用双精度算完再存成 float32。
//
// 逐组对拍只放在 float32 条件良好的区域：仰角正弦 e ≥ 0.1（看灯心的仰角约 5.7° 以上）。理由【实测】：e < 0.1 时
// 立体角 S 是四个量级 π/2 的 asin 相加抵消出来的小数，asin 的参数又贴着 ±1（导数无界），Cycles 原式在 float32 下本身就不准：
// 在本机 100 万组里，拿双精度照原式算真值，e < 0.1 的组 Cycles 一侧离真值的相对误差最大到 6.7e-2，显卡一侧 6.1e-2，
// 不合格组里两边谁离真值更近各占一半；e ≥ 0.1 的组两边离真值都在 4e-5 以内（诊断脚本没有入库）。
// e < 0.1 的「立体角」一支由 χ² 与辐照度裁判在掠射几何上从统计上覆盖；平面近似的掠射一支（e ≤ 1e-3）概率密度是闭式，
// 改在灯的局部坐标里单独对拍（见 _grazing 一项）。
const logU = (next, [lo, hi]) => lo * (hi / lo) ** next();
const linU = (next, [lo, hi]) => lo + (hi - lo) * next();
const add = (a, b, s = 1) => a.map((x, k) => x + s * b[k]);
const mul = (a, s) => a.map(x => x * s);
export const dot3 = (a, b) => a.reduce((s, x, k) => s + x * b[k], 0);
export const crs = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
function rotation(next) {
  const u1 = next(), a = 2 * Math.PI * next(), b = 2 * Math.PI * next();
  const [x, y, z, w] = [Math.sqrt(1 - u1) * Math.sin(a), Math.sqrt(1 - u1) * Math.cos(a), Math.sqrt(u1) * Math.sin(b), Math.sqrt(u1) * Math.cos(b)];
  return [[1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)], [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)]];
}
/** len：两边长的对数范围（给了 aspect 时 len_v = len_u 乘上 [1/aspect, aspect] 里对数均匀的比）；dist：t 的对数范围（以较长边为单位）；elev：e 的范围（第三项 'log' 时对数均匀）；
 *  local：灯放在原点、轴对齐（axis_u = x 轴，axis_v = y 轴），灯面坐标的点积与叉积没有舍入；front：只取正面 */
function lightGeom(next, { len, aspect, dist, elev, local = false, front = false }) {
  const [axis_u, axis_v] = local ? [[1, 0, 0], [0, 1, 0]] : rotation(next), dir = crs(axis_u, axis_v);
  const co = local ? [0, 0, 0] : [linU(next, [-1, 1]), linU(next, [-1, 1]), linU(next, [-1, 1])];
  const len_u = logU(next, len), len_v = aspect ? len_u * logU(next, [1 / aspect, aspect]) : logU(next, len);
  const t = logU(next, dist) * Math.max(len_u, len_v), e = (elev[2] ? logU : linU)(next, elev), phi = 2 * Math.PI * next();
  const side = front || next() < 0.5 ? 1 : -1, r = Math.sqrt(1 - e * e);
  const P = add(co, add(add(mul(axis_u, r * Math.cos(phi)), mul(axis_v, r * Math.sin(phi))), mul(dir, side * e)), t);
  return { P, co, light_p: co, axis_u, len_u, axis_v, len_v, dir, invarea: 1 / (len_u * len_v), rand: [next(), next()] };
}
/** 灯面上一点（a、b 以半边长为单位）与从 P 指向它的方向、距离 */
function towards(next, g, ab) {
  const target = add(add(g.co, g.axis_u, linU(next, ab) * g.len_u / 2), g.axis_v, linU(next, ab) * g.len_v / 2);
  const d = add(target, g.P, -1), t = Math.hypot(...d);
  return { ray_P: g.P, ray_D: mul(d, 1 / t), t };
}

/** 报告用：在双精度里按 Cycles 的条件判 area_light_rect_sample 返回概率密度走哪一支（kernel/light/area.h:89）。
 *  只用来统计各分支的比例，不参与比对 */
function rectBranch(P, co, u, lu, v, lv) {
  const d = add(co, P, -1), z0 = -Math.abs(dot3(d, crs(u, v))), xc = dot3(d, u), yc = dot3(d, v);
  const nz = [-(yc - lv / 2), xc + lu / 2, yc + lv / 2, -(xc - lu / 2)].map(c => c / Math.hypot(c, z0));
  const S = -[0, 1, 2, 3].reduce((s, k) => s + Math.asin(-nz[k] * nz[(k + 1) % 4]), 0);
  // 两个条件都成立时 Cycles 走的是同一支，报告里按掠射计
  if (Math.min(...nz.map(c => c * c)) > 0.99999) return '平面近似（掠射）';
  if (S < 1e-5) return '平面近似（立体角小于 1e-5）';
  return S > 1 ? '立体角（大于 1 sr）' : '立体角';
}
const at = (inp, k, n = 3) => [...inp.subarray(k, k + n)];

const LIGHT_IN = [['co', 'vec3f'], ['axis_u', 'vec3f'], ['len_u', 'f32'], ['axis_v', 'vec3f'], ['len_v', 'f32'], ['dir', 'vec3f'], ['invarea', 'f32']];
const RECT_IN = [['P', 'vec3f'], ['light_p', 'vec3f'], ['axis_u', 'vec3f'], ['len_u', 'f32'], ['axis_v', 'vec3f'], ['len_v', 'f32'], ['rand', 'vec2f']];
const light = (name, inputs, out, abs, more) => entry(name, inputs, out, abs, { file: LIGHT, ...more });
const rectBranchOf = i => rectBranch(at(i, 0), at(i, 3), at(i, 6), i[9], at(i, 10), i[13]);
// 场景（dist 以较长边为单位）。MAIN：离灯心 0.02 到 20 倍边长，近处的大灯立体角接近 2π，远处的灯立体角到 1e-6 以下；
// WELL：离开不超过 1 倍边长、长宽比不超过 3、仰角正弦 0.3 以上，立体角都在 0.1 sr 以上；TINY：边长 1e-4 到 3e-3、离开 1000 到
// 1 万倍边长，立体角不到 1e-6，稳走平面近似；GRAZE 见 grazingGeom
const MAIN = { len: [0.05, 5], dist: [0.02, 20], elev: [0.1, 1] };
const WELL = { len: [0.1, 5], aspect: 3, dist: [0.1, 1], elev: [0.3, 1] };
const RAY = { len: [0.3, 5], aspect: 3, dist: [0.1, 3], elev: [0.1, 1] };
const TINY = { len: [1e-4, 3e-3], dist: [1e3, 1e4], elev: [0.1, 1] };
/** 掠射：灯在原点、轴对齐，着色点在灯所在平面外 1e-7 到 1e-3 倍「到最近的边所在直线的距离」，横向在矩形外 0.1 到 4 倍边长。
 *  四个 nz² 都大于 1 − 1e-6，稳走掠射的平面近似（阈值 0.99999）；灯心坐标为 0，dir = light_p − P 与 z0 都没有舍入 */
function grazingGeom(next) {
  const g = lightGeom(next, { len: [0.1, 2], dist: [1, 1], elev: [0.5, 0.5], local: true });
  const ax = g.len_u * (0.5 + logU(next, [0.1, 4])), ay = g.len_v * (0.5 + logU(next, [0.1, 4]));
  const c = Math.min(ax - g.len_u / 2, ay - g.len_v / 2);
  g.P = [next() < 0.5 ? -ax : ax, next() < 0.5 ? -ay : ay, (next() < 0.5 ? -1 : 1) * c * logU(next, [1e-7, 1e-3])];
  return g;
}
// 采样点与方向只在 WELL 里逐组比：立体角小时 au = rand.x·S + g2 + g3 里 rand.x·S 掉到 g2 + g3 的 ULP 以下，采样点基本由舍入决定
// （小灯上仍落在矩形内，Cycles 本机一侧同样如此）；随机数贴近 0、1 时采样点贴着矩形的边，xu、yv 的式子（area.h:74、82）
// 在那里斜率无界。【实测】MAIN 里不论立体角大小，都有超过 1e-6 倍坐标尺度的点差，立体角 1e-4 sr 一档有约 30% 的组超过。
// 这一部分由 χ²、矩形内检查与辐照度裁判覆盖
const RAND_WELL = [1e-2, 1 - 1e-2];
// WELL 里采样点（世界坐标，量级到 7）与方向的分量：采样映射在矩形边附近斜率大，显卡 cos、sin 约 2e-7 的绝对误差被放大，
// 方向 D = (Q − P)/t 还要再乘 1/t（t ≥ 0.01）。【实测】所需 abs 最大 1.1e-5（方向分量），取 2.4e-5
const ABS_SAMPLE = 2.4e-5;
// 立体角 S = −(g0 + g1 + g2 + g3) 是四个量级到 π/2 的 asin 相加抵消（area.h:53-57）。概率密度 1/S 的比对改在 S 上做，
// abs 给在 S 上：【实测】MAIN 里超出 1e-4·S 的差最大 2.1e-6，取 48 个 π/2 处的 ULP（约 5.7e-6）
const ABS_S = 48 * 2 ** -23;
FUNCTIONS.push(
  // asin 在 ±1 附近导数无界，取在 clamp 两侧各外延 0.2，覆盖截断那一支
  entry('safe_asinf', [['a', 'f32', [-1.2, 1.2]]], 1, 0, { file: APACHE }),
  // 概率密度在 WELL 里直接比，abs 只为采样点
  light('area_light_rect_sample', RECT_IN, { pdf: 1, P: 3 }, ABS_SAMPLE, {
    gen: next => ({ ...lightGeom(next, WELL), rand: [linU(next, RAND_WELL), linU(next, RAND_WELL)] }), branch: rectBranchOf,
    call: a => `area_light_rect_sample(${a.join(', ')}, true)`,
  }),
  // 立体角：MAIN 的全部几何（近、远、大、小，含两边在 1e-5 阈值两侧各走一支的组），比 1/pdf
  light('area_light_rect_sample_solid_angle', RECT_IN, 1, ABS_S, {
    wgsl: 'area_light_rect_sample', gen: next => lightGeom(next, MAIN), branch: rectBranchOf,
    call: a => `1.0 / area_light_rect_sample(${a.join(', ')}, false).pdf`,
  }),
  // 平面近似的两支（area.h:89-100）：概率密度是闭式 −t³/(z0·len_u·len_v)，直接比
  light('area_light_rect_sample_tiny', RECT_IN, 1, 0, {
    wgsl: 'area_light_rect_sample', ref: 'area_light_rect_sample_pdf', gen: next => lightGeom(next, TINY), branch: rectBranchOf,
    call: a => `area_light_rect_sample(${a.join(', ')}, false).pdf`,
  }),
  light('area_light_rect_sample_grazing', RECT_IN, 1, 0, {
    wgsl: 'area_light_rect_sample', ref: 'area_light_rect_sample_pdf', gen: grazingGeom, branch: rectBranchOf,
    call: a => `area_light_rect_sample(${a.join(', ')}, false).pdf`,
  }),
  // 正反两面各半；abs 只为采样点与方向
  light('area_light_sample', [['rand', 'vec2f'], ['P', 'vec3f'], ...LIGHT_IN], { ok: 1, P: 3, D: 3, t: 1, pdf: 1, eval_fac: 1 }, ABS_SAMPLE, {
    gen: next => ({ ...lightGeom(next, WELL), rand: [linU(next, RAND_WELL), linU(next, RAND_WELL)] }),
    branch: i => (dot3(add(at(i, 5), at(i, 2), -1), at(i, 16)) > 0 ? '灯背面' : rectBranch(at(i, 2), at(i, 5), at(i, 8), i[11], at(i, 12), i[15])),
  }),
  // 射线打中灯面的那一侧：方向指向灯面上的一点，t 是到那一点的距离
  light('area_light_eval_from_intersection', [['ray_P', 'vec3f'], ['ray_D', 'vec3f'], ['t', 'f32'], ...LIGHT_IN], { eval_fac: 1, pdf: 1 }, 0, {
    gen: next => { const g = lightGeom(next, { ...WELL, front: true }); return { ...g, ...towards(next, g, [-1, 1]) }; },
    branch: i => rectBranch(at(i, 0), at(i, 7), at(i, 10), i[13], at(i, 14), i[17]),
  }),
  // 方向指向灯面外扩 1.5 倍的范围（有中有不中），tmax 取到交点距离的 0.5 到 2 倍（有被 tmax 截掉的），正反两面都有
  light('area_light_intersect', [['ray_P', 'vec3f'], ['ray_D', 'vec3f'], ['tmin', 'f32'], ['tmax', 'f32'], ...LIGHT_IN], { hit: 1, t: 1 }, 0, {
    gen: next => { const g = lightGeom(next, RAY), r = towards(next, g, [-1.5, 1.5]); return { ...g, ...r, tmin: 0, tmax: r.t * linU(next, [0.5, 2]) }; },
  }),
  // 交点 hit = P + t·D 的分量是量级到 16 的数（离开到 3 倍边长，边长到 5）相加抵消，u、v 再由 hit − quad_P 乘上 inv_quad（到 1/0.3）；
  // abs 给 8 个 ULP(16)
  entry('ray_quad_intersect', [['ray_P', 'vec3f'], ['ray_D', 'vec3f'], ['ray_tmin', 'f32'], ['ray_tmax', 'f32'], ['quad_P', 'vec3f'], ['inv_quad_u', 'vec3f'], ['inv_quad_v', 'vec3f'], ['quad_n', 'vec3f']], { hit: 1, P: 3, t: 1, u: 1, v: 1 }, 8 * 16 * ULP1, {
    file: APACHE, call: a => `ray_quad_intersect(${a.join(', ')}, false)`,
    gen: next => {
      const g = lightGeom(next, RAY), r = towards(next, g, [-1.5, 1.5]);
      return { ...r, ray_tmin: 0, ray_tmax: r.t * linU(next, [0.5, 2]), quad_P: g.co, inv_quad_u: mul(g.axis_u, 1 / g.len_u), inv_quad_v: mul(g.axis_v, 1 / g.len_v), quad_n: g.dir };
    },
  }),
);
