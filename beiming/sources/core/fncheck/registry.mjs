// 函数登记表：比对外壳只认这里登记的函数。每项的 WGSL 函数名与标准答案程序（cycles/ref.cpp）的函数标识同名。
// inputs：[参数名, 'f32' | 'vec2f' | 'vec3f' | 'dir', 范围]。
//   f32、vec2f、vec3f 在 [下限, 上限] 里均匀取；范围第三项写 'log' 时按对数均匀取；向量可给一个范围（各分量共用）或逐分量各一个。
//   dir 是单位向量，范围是 z 的 [下限, 上限]：在球面上 z 落在这段里的那一圈带上按面积均匀取。[-1, 1] 是整个球面，[0, 1] 是上半球。
// out：输出分量数（函数返回 f32、向量或 array<f32, N>），或 { 字段名: 分量数 } 依次取返回结构体的字段。
// file：WGSL 函数所在的文件；比对时 SHADERS 里的文件全部拼进一个着色器，所以函数可以调用别的文件里的函数。
// call：可选，(实参 WGSL 表达式数组) => 调用表达式，给要补常量实参的函数用（例如查表函数的表偏移）。
// gen：可选，(next: () => [0,1) 均匀数) => { 输入名: 数或数组 }，逐组生成彼此相关的输入（正交基、相对灯面的位置）；有它时 inputs 不写范围。
// host：可选，为真时被测的是宿主一侧的 Rust（core-render fncheck-host 逐组算），file 是 Rust 源文件，不上显卡。
// n：可选，这一项的组数（不写就用外壳的 --n）。filterTables：可选，为真时外壳先按 FILTER_TABLES 让标准答案程序建表，
// 经存储缓冲交给着色器（gpu.mjs 的 runGpu 的 filterTables）。
// branch：可选，(一组输入) => 分支名，只用来在报告里数各分支的比例。
// skip：可选，(标准答案的一组输出, 被测的一组输出, 这一组的输入) => 真时这一组不比、只计数。只给登记处写明了理由的病态区域用。
// 合格：|被测−标准| ≤ rel·|标准| + abs。rel 一律 1e-4。
// abs 只给有相减抵消的函数：两个 O(1) 的数相减得到接近 0 的结果时，两边哪怕只差 1 ULP 的舍入（WGSL 的 sqrt、
// 除法不保证正确舍入，编译器还可能合成 FMA），相对误差也会大到几十个百分点。这类函数的 abs 取「抵消发生处的
// 量级上 4 个 ULP」，再乘上相减之后的放大系数；实测的最大差值都在它的一半以内。
export const SHADERS = ['shaders/microfacet.wgsl', 'shaders/util.wgsl', 'shaders/ggx_tables.wgsl', 'shaders/area_light.wgsl', 'shaders/imaging.wgsl'];
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
  // 每步都带几个 ULP。【实测】所需 abs：Apple 显卡 4.6e-7，NVIDIA 1.3e-6（它的 cos、sin 误差更大），取 32 个 ULP。
  // alpha 取整个范围，随机数离开圆盘边缘（理由同上）
  entry('microfacet_ggx_sample_vndf', [['wi', 'dir', [1e-3, 1]], ['alpha_x', 'f32', ALPHA], ['alpha_y', 'f32', ALPHA], ['rand', 'vec2f', RAND]], 3, 32 * ULP1),
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
// 球面矩形采样在 au = rand.x·S + g2 + g3 恰为 0 时有一个间断：真值是 xu = 0（着色点在灯面上的垂足），但 Cycles 的
// safe_divide 在除数为 0 时给 0，于是 fu = 0、cu 被夹到 1、采样点被甩到灯的边上（area.h:67-73）。au 在 float32 里的
// 分辨率约 1e-7，两边只要差一个最小浮点间隔（比如一边把乘加合成了一条指令），就会一边踩中一边没踩中。【实测】NVIDIA 上
// 100 万组里踩中 1 组（au 的双精度真值 1.5e-7），Cycles 本机一侧对输入做微扰则不踩。这是公式自己的间断，照原式移植、不逐组比：
// 任一边的采样点离垂足不到 1e-5 个边长就跳过。p 是采样点，P 是着色点，axis_u 是单位向量
const atPole = (p, P, axis_u, len_u) => Math.abs(dot3(add(p, P, -1), axis_u)) < 1e-5 * len_u;
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
    skip: (ref, test, i) => atPole(at(ref, 1), at(i, 0), at(i, 6), i[9]) || atPole(at(test, 1), at(i, 0), at(i, 6), i[9]),
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
    // ok 为假（灯背面）的组输出全零，照常比；只有两边都采到了点才看是不是在间断上
    skip: (ref, test, i) => ref[0] !== 0 && test[0] !== 0 && (atPole(at(ref, 1), at(i, 2), at(i, 8), i[11]) || atPole(at(test, 1), at(i, 2), at(i, 8), i[11])),
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

// 下面是成像一路：像素滤波（宿主一侧照 scene/film.cpp 建表，内核拿一个随机数查表）与贡献的夹取（kernel/film/light_passes.h）。
// 滤波函数与建表在宿主一侧：被测的是 Rust（path/src/pixel_filter.rs，经 core-render fncheck-host 逐组算），登记 host: true；
// 查表与夹取在内核里：被测的是 WGSL（shaders/imaging.wgsl），在显卡上算。
// 查表的三项用的是 Cycles 自己建的三张表（FILTER_TABLES，次序与 cycles/ref_imaging.h 的 filter_tables_fixed 相同）：
// 外壳先让标准答案程序按这三组参数建表，经存储缓冲给 imaging.wgsl 要的 filter_table_value(i)（gpu.mjs 的 LUT_PRELUDE），只比查表本身；
// 建表对不对由 filter_table 一项逐项比。
const IMAGING = 'shaders/imaging.wgsl';
const PIXEL_FILTER = 'path/src/pixel_filter.rs';
/** 查表比对用的三张表：[种类（scene/film.h 的 FilterType：0 盒式、1 高斯、2 Blackman-Harris）, 宽度] */
export const FILTER_TABLES = [[0, 2.0], [1, 1.5], [2, 1.5]];
export const FILTER_TABLE_SIZE = 1024;
const hostFn = (name, inputs, out, abs = 0, more = {}) => entry(name, inputs, out, abs, { file: PIXEL_FILTER, host: true, ...more });
// 滤波函数只在建表用到的定义域上比：自变量 v 在 [0, 宽度/2]，宽度是建表时放大过的（高斯乘 3、Blackman-Harris 乘 2），
// 界面上的宽度 0.01 到 10 像素，所以放大后取到 0.01 到 30
const WIDTH = [0.01, 30];
const filterIn = next => { const width = logU(next, WIDTH); return { v: width / 2 * next(), width }; };
// Blackman-Harris 在 v = 宽度/2 处是四个 O(1) 的系数加减抵消到 6e-5，量级 1 上 4 个 ULP
const BH_ABS = 4 * ULP1;
// 建表：种类三选一，界面上的宽度 0.01 到 10 像素对数均匀。表里的数是 0.5·(1 ± y)，y 贴近 1 时相减抵消；y 由约一千项的累加和
// 反查出来，两边滤波函数差的一个 ULP 会在累加里放大。表值的量级到 0.5 + 支撑半宽（高斯宽 10 时 15.5），abs 按这个量级给
// 【实测】所需 abs 见测试输出，在这个 abs 的一半以内
const TABLE_ABS = 64 * 16 * ULP1;
// 查表：自变量取到 [0, 1] 外面一点，覆盖 saturate 与 t == 0 的那一支；表值到 2.75（高斯宽 1.5 的支撑半宽 2.25 加 0.5），
// 插值 (1 − t)·d0 + t·d1 在过 0 处相减抵消，abs 给量级 4 上 4 个 ULP
const READ_ABS = 4 * 4 * ULP1;
const read = (name, k) => entry(`filter_table_read_${name}`, [['x', 'f32', [-0.1, 1.1]]], 1, READ_ABS, { file: IMAGING, wgsl: 'filter_table_read', filterTables: true, call: ([x]) => `filter_table_read(${x}, ${k * FILTER_TABLE_SIZE})` });
// 夹取：贡献的三个分量正负都有、对数均匀取在 1e-3 到 1e3，各有 5% 是 0、+∞、−∞、非数（照 ensure_finite 清成 0）；bounce 取 −1 到 2
// （相机射线上的发光是 −1）；两个上限对数均匀取在 1e-2 到 1e4，各有 20% 是 FLT_MAX（不夹）
const SPECIAL = [0, Infinity, -Infinity, NaN];
function clampIn(next) {
  const comp = () => { const r = next(); return r < 0.2 ? SPECIAL[Math.floor(r / 0.05)] : (next() < 0.5 ? -1 : 1) * logU(next, [1e-3, 1e3]); };
  const limit = () => (next() < 0.2 ? 3.4028234663852886e38 : logU(next, [1e-2, 1e4]));
  return { L: [comp(), comp(), comp()], bounce: Math.floor(next() * 4) - 1, sample_clamp_direct: limit(), sample_clamp_indirect: limit() };
}
FUNCTIONS.push(
  hostFn('filter_func_box', [['v', 'f32'], ['width', 'f32']], 1, 0, { gen: filterIn }),
  hostFn('filter_func_gaussian', [['v', 'f32'], ['width', 'f32']], 1, 0, { gen: filterIn }),
  hostFn('filter_func_blackman_harris', [['v', 'f32'], ['width', 'f32']], 1, BH_ABS, { gen: filterIn }),
  // 建表，三种各一项。一组是一整张表（1024 个数），各取 1000 组：100 万组要写 4 GB
  ...['box', 'gaussian', 'blackman_harris'].map((kind, type) => hostFn(`filter_table_${kind}`, [['type', 'f32'], ['width', 'f32']], FILTER_TABLE_SIZE, TABLE_ABS, {
    wgsl: 'filter_table', ref: 'filter_table', n: 1000, gen: next => ({ type, width: logU(next, [0.01, 10]) }),
  })),
  read('box', 0),
  read('gaussian', 1),
  read('blackman_harris', 2),
  entry('film_clamp_light', [['L', 'vec3f'], ['bounce', 'f32'], ['sample_clamp_direct', 'f32'], ['sample_clamp_indirect', 'f32']], 3, 0, {
    file: IMAGING, gen: clampIn, call: ([L, b, d, i]) => `film_clamp_light(${L}, i32(${b}), ${d}, ${i})`,
    branch: i => (Number.isFinite(i[0]) && Number.isFinite(i[1]) && Number.isFinite(i[2]) ? (i[3] > 0 ? '间接' : '直接') : '有非有限分量'),
  }),
);
// 下面是原理化 BSDF 非金属那一半（电介质高光：GGX 加广义 Schlick，只有反射；漫反射；发光值；滤光泽）与它们用到的
// 工具函数。闭包一层的输入范围同上面金属的理由：N 固定为 (0, 0, 1)、alpha 取 [0.1, 1]、随机数离开圆盘边缘、贴地出射不比。
// 原理化 BSDF 给电介质高光的是 f90 = 1、exponent = −eta、reflection_tint = 1、transmission_tint = 0（kernel/svm/closure.h），
// 这里 f0、f90、两个染色在 [0, 1] 里取，exponent 取 [−4, −1.01]（eta 到 4）；广义 Schlick 的一般那一支（exponent ≥ 0）
// 与 ior < 1（含全反射）单独一项。
const IOR = [1.01, 4, 'log'];
const NEG_EXP = [-4, -1.01];
/** η < 1 时贴着临界角：η² − (1 − cos²θi) 的绝对值小于 1e-2（双精度算）的组不比。输入的前两个是 cosθi、η */
const NEAR_CRITICAL = (ref, test, i) => Math.abs(i[1] * i[1] - (1 - i[0] * i[0])) < 1e-2;
const GS_IN = [['ior', 'f32', IOR], ['f0', 'vec3f', UNIT], ['f90', 'vec3f', UNIT], ['exponent', 'f32', NEG_EXP], ['reflection_tint', 'vec3f', UNIT], ['transmission_tint', 'vec3f', UNIT]];
const GS_EVAL_IN = [['N', 'dir', NZ], ['wi', 'dir', HEMI], ['wo', 'dir', [-0.2, 1]], ['alpha', 'f32', ALPHA_CLOSURE], ...GS_IN];
const GS_SAMPLE_IN = alpha => [['N', 'dir', NZ], ['Ng', 'dir', NDIR], ['wi', 'dir', HEMI], ['alpha', 'f32', alpha], ...GS_IN];
FUNCTIONS.push(
  // 偏振反射率。条件不好的两处在 float32 下 Cycles 原式本身就不准，照上面金属闭包那一批的做法收窄或跳过（理由【实测】见核对报告）：
  //   - η 贴近 1：r_s = (cosθi − √(cos²θi + η² − 1))/(…) 的分子相消；η 取 [1.01, 4]（原理化 BSDF 的电介质高光 eta 只在
  //     这一侧：ior ≥ 1 时 eta = ior 或 ior_from_F0 的值，都不小于 1，等于 1 时不建闭包）。
  //   - η < 1 贴着临界角：η² − (1 − cos²θi) 贴近 0，开方把一个 ULP 放大成 cosθt 的大误差。η < 1 另登记一项，
  //     那个差的绝对值小于 1e-2 的组不比。
  // 反射率在 η 接近 1、正入射时很小：量级 1 的数相减之后平方，给 4 个 ULP
  entry('fresnel_dielectric_polarized', [['cos_theta_i', 'f32', [-1, 1]], ['eta', 'f32', IOR]], 2, 4 * ULP1),
  entry('fresnel_dielectric_polarized_inside', [['cos_theta_i', 'f32', [-1, 1]], ['eta', 'f32', [0.25, 0.99, 'log']]], 2, 4 * ULP1, { wgsl: 'fresnel_dielectric_polarized', ref: 'fresnel_dielectric_polarized', skip: NEAR_CRITICAL }),
  entry('fresnel_dielectric_ccl', [['cos_theta_i', 'f32', [-1, 1]], ['eta', 'f32', IOR]], 1, 4 * ULP1),
  entry('fresnel_dielectric_ccl_inside', [['cos_theta_i', 'f32', [-1, 1]], ['eta', 'f32', [0.25, 0.99, 'log']]], 1, 4 * ULP1, { wgsl: 'fresnel_dielectric_ccl', ref: 'fresnel_dielectric_ccl', skip: NEAR_CRITICAL }),
  entry('fresnel_dielectric_Fss', [['eta', 'f32', [0.25, 4, 'log']]], 1, 4 * ULP1),
  entry('ior_from_F0', [['f0', 'f32', [-0.1, 1.1]]], 1),
  // (ior − 1) 在 ior 接近 1 时相消，取 [1.01, 4] 加 [0.25, 0.99] 两段的整个 [0.25, 4]
  entry('F0_from_ior', [['ior', 'f32', [0.25, 4, 'log']]], 1, 4 * ULP1),
  // 电介质高光的 (F0, eta)：Cycles 里是 svm_node_closure_bsdf 原理化分支内联的一段（kernel/svm/closure.h:426-436），标准答案程序
  // 用 Cycles 的 F0_from_ior、ior_from_F0 照那一段的式子组装。ior 取 ior < 1 与 ior > 1 两段（各离开 1 一点，理由同 F0_from_ior），
  // 高光等级四分之一取 0、四分之一取 0.5（走不走调整那一支的分界）、其余在 [0, 1] 里均匀取（含大于 0.5）。调用方先把等级夹到不小于 0
  entry('principled_specular_f0_eta', [['ior', 'f32'], ['specular_ior_level', 'f32']], 2, 4 * ULP1, {
    file: APACHE,
    gen: next => {
      const side = next() < 0.5, u = next(), k = next();
      return { ior: side ? 0.25 * (0.99 / 0.25) ** u : 1.01 * (4 / 1.01) ** u, specular_ior_level: k < 0.25 ? 0 : k < 0.5 ? 0.5 : next() };
    },
    branch: i => `${i[0] < 1 ? 'ior<1' : 'ior>1'}/${i[1] === 0 ? '等级0' : i[1] === 0.5 ? '等级0.5' : i[1] > 0.5 ? '等级>0.5' : '等级<0.5'}`,
  }),
  entry('inverse_lerp', [['a', 'f32', [0, 0.5]], ['b', 'f32', [0.6, 1]], ['x', 'f32', [0, 1]]], 1, 4 * ULP1, { file: APACHE }),
  // 除数取 0 与非 0 各半：分量是 0 的概率不够，用 gen 逐组生成
  entry('safe_divide_color', [['a', 'vec3f'], ['b', 'vec3f']], 3, 0, { file: APACHE, gen: next => ({ a: [next(), next(), next()], b: [0, 1, 2].map(() => (next() < 0.5 ? 0 : 0.01 + next())) }) }),
  // 1 − max(albedo / weight) 在比值接近 1 时相消：量级 1 上的 4 个 ULP，再乘 weight（不超过 1）
  entry('closure_layering_weight', [['layer_albedo', 'vec3f'], ['weight', 'vec3f']], 3, 4 * ULP1, { gen: next => { const w = [0, 1, 2].map(() => (next() < 0.1 ? 0 : 0.01 + next())); return { weight: w, layer_albedo: w.map(x => x * next() * 1.2) }; } }),
  entry('lookup_table_read_3D_ggx_gen_schlick_ior_s', [['x', 'f32', [-0.1, 1.1]], ['y', 'f32', [-0.1, 1.1]], ['z', 'f32', [-0.1, 1.1]]], 1, 0, { file: APACHE, wgsl: 'lookup_table_read_3D', call: ([x, y, z]) => `lookup_table_read_3D(${x}, ${y}, ${z}, table_ggx_gen_schlick_ior_s(), 16, 16, 16)` }),
  entry('lookup_table_read_3D_ggx_gen_schlick_s', [['x', 'f32', [-0.1, 1.1]], ['y', 'f32', [-0.1, 1.1]], ['z', 'f32', [-0.1, 1.1]]], 1, 0, { file: APACHE, wgsl: 'lookup_table_read_3D', call: ([x, y, z]) => `lookup_table_read_3D(${x}, ${y}, ${z}, table_ggx_gen_schlick_s(), 16, 16, 16)` }),
  // F = f0 + s·(f90 − f0) 与 1 − F：量级 1 的相减；s 来自 (F_real − F0)/(1 − F0)，正入射附近两个接近的数相减
  entry('generalized_schlick_fresnel', [['ior', 'f32', IOR], ['cos_theta_i', 'f32', UNIT], ['f0', 'vec3f', UNIT], ['f90', 'vec3f', UNIT], ['exponent', 'f32', NEG_EXP], ['reflection_tint', 'vec3f', UNIT], ['transmission_tint', 'vec3f', UNIT]], { reflectance: 3, transmittance: 3 }, 4 * ULP1),
  // 一般那一支：exponent ≥ 0，ior 取 [0.5, 2]（含 ior < 1 的全反射与用折射角的那一支）。cosθi 取到 0.999 为止：
  // pow(1 − cos, e) 在显卡上是 exp2·log2，底数贴近 0 时相对误差大。ior < 1 贴着全反射（1 − (1 − cos²θi)/ior² 的绝对值
  // 小于 1e-2）的组不比：开方把一个 ULP 放大成折射角余弦的大误差，再经 pow 放大 e 倍
  entry('generalized_schlick_fresnel_regular', [['ior', 'f32', [0.5, 2, 'log']], ['cos_theta_i', 'f32', [0, 0.999]], ['f0', 'vec3f', UNIT], ['f90', 'vec3f', UNIT], ['exponent', 'f32', [0.5, 8]], ['reflection_tint', 'vec3f', UNIT], ['transmission_tint', 'vec3f', UNIT]], { reflectance: 3, transmittance: 3 }, 16 * ULP1, {
    wgsl: 'generalized_schlick_fresnel', ref: 'generalized_schlick_fresnel', skip: (ref, test, i) => Math.abs(1 - (1 - i[1] * i[1]) / (i[0] * i[0])) < 1e-2,
  }),
  entry('microfacet_fresnel_generalized_schlick', [['cos_theta_i', 'f32', UNIT], ...GS_IN], 3, 4 * ULP1),
  entry('bsdf_microfacet_estimate_albedo_generalized_schlick', [['N', 'dir', NDIR], ['wi', 'dir', HEMI], ['alpha', 'f32', ALPHA], ...GS_IN], 3, 4 * ULP1, { call: a => `bsdf_microfacet_estimate_albedo_generalized_schlick(${a.join(', ')}, true, true)` }),
  entry('bsdf_microfacet_estimate_albedo_f82_tint', [['N', 'dir', NDIR], ['wi', 'dir', HEMI], ['alpha', 'f32', ALPHA], ['f0', 'vec3f', UNIT]], 3, 0, { call: a => `bsdf_microfacet_estimate_albedo_f82_tint(${a.join(', ')}, true)` }),
  // darkening = (1 + Fms·missing)/energy_scale：Fss = f0 + s·(f90 − f0) 的相减同上
  entry('bsdf_microfacet_setup_fresnel_generalized_schlick', [['N', 'dir', NDIR], ['wi', 'dir', HEMI], ['alpha', 'f32', ALPHA], ...GS_IN], { f0: 3, energy_scale: 1, weight: 3 }, 4 * ULP1, { call: a => `bsdf_microfacet_setup_fresnel_generalized_schlick(${a.join(', ')}, true)` }),
  entry('bsdf_microfacet_eval_ggx_generalized_schlick', GS_EVAL_IN, EVAL_OUT, 4 * ULP1),
  entry('bsdf_microfacet_eval_ggx_generalized_schlick_singular', [['N', 'dir', NZ], ['wi', 'dir', HEMI], ['wo', 'dir', [-0.2, 1]], ['alpha', 'f32', ALPHA_SINGULAR], ...GS_IN], EVAL_OUT, 0, { wgsl: 'bsdf_microfacet_eval_ggx_generalized_schlick', ref: 'bsdf_microfacet_eval_ggx_generalized_schlick' }),
  entry('bsdf_microfacet_ggx_eval_generalized_schlick', [...GS_EVAL_IN, ['energy_scale', 'f32', [1, 2]]], EVAL_OUT, 4 * ULP1),
  entry('bsdf_microfacet_sample_ggx_generalized_schlick', [...GS_SAMPLE_IN(ALPHA_CLOSURE), ['rand', 'vec2f', RAND]], SAMPLE_OUT, SAMPLE_ABS, { skip: GRAZING }),
  // 纯镜面：求值乘了 1e6，反射率里 s = (F_real − F0)/(1 − F0) 在正入射附近的相消（量级 1 上的几个 ULP）跟着放大 1e6 倍；
  // abs 兜不住求值又不能放宽到方向上，所以 f0、f90 取 [0.01, 1]（反射率不低于 0.01 的量级），不取 0 附近
  entry('bsdf_microfacet_sample_ggx_generalized_schlick_singular', [['N', 'dir', NZ], ['Ng', 'dir', NDIR], ['wi', 'dir', HEMI], ['alpha', 'f32', ALPHA_SINGULAR], ['ior', 'f32', IOR], ['f0', 'vec3f', [0.01, 1]], ['f90', 'vec3f', [0.01, 1]], ['exponent', 'f32', NEG_EXP], ['reflection_tint', 'vec3f', [0.01, 1]], ['transmission_tint', 'vec3f', UNIT], ['rand', 'vec2f', UNIT]], SAMPLE_OUT, 4 * ULP1, { wgsl: 'bsdf_microfacet_sample_ggx_generalized_schlick', ref: 'bsdf_microfacet_sample_ggx_generalized_schlick' }),
  entry('bsdf_microfacet_ggx_sample_generalized_schlick', [...GS_SAMPLE_IN(ALPHA_CLOSURE), ['energy_scale', 'f32', [1, 2]], ['rand', 'vec2f', RAND]], SAMPLE_OUT, SAMPLE_ABS, { skip: GRAZING }),
  // 滤光泽：Cycles 的 bsdf_blur 分发到 bsdf_microfacet_blur（kernel/closure/bsdf.h），alpha 与模糊粗糙度取大
  entry('bsdf_blur', [['alpha_x', 'f32', UNIT], ['alpha_y', 'f32', UNIT], ['roughness', 'f32', [0, 0.5]]], 2, 0, { wgsl: 'bsdf_microfacet_blur' }),
  // 余弦半球采样：随机数离开圆盘边缘（理由同 microfacet_ggx_sample_vndf），方向分量经 make_orthonormals 与 to_global 相加抵消
  entry('sample_cos_hemisphere', [['N', 'dir', [-1, 1]], ['rand', 'vec2f', RAND]], { wo: 3, pdf: 1 }, 32 * ULP1),
  entry('bsdf_diffuse_eval', [['N', 'dir', [-1, 1]], ['wo', 'dir', [-1, 1]]], EVAL_OUT, 4 * ULP1),
  entry('bsdf_diffuse_sample', [['N', 'dir', [-1, 1]], ['Ng', 'dir', [-1, 1]], ['rand', 'vec2f', RAND]], SAMPLE_OUT, 32 * ULP1, {
    // 方向贴着几何法线的地平线（|Ng·wo| < 1e-5）时两边可能一边判在上面、一边判在下面
    skip: (ref, test, i) => [ref, test].some(o => Math.abs(o[4] * i[3] + o[5] * i[4] + o[6] * i[5]) < 1e-5),
  }),
  entry('emissive_pdf', [['Ng', 'dir', [-1, 1]], ['wi', 'dir', [-1, 1]]], 1),
  entry('emissive_simple_eval', [['Ng', 'dir', [-1, 1]], ['wi', 'dir', [-1, 1]]], 3),
);

// 下面是原理化 BSDF 给金属与电介质高光换法线的一步（kernel/closure/bsdf_util.h 的 ensure_valid_specular_reflection，BSD-3-Clause）
// 与闭包求值、采样入口乘的凹凸阴影项（kernel/closure/bsdf.h 的 bump_shadowing_term，Apache-2.0）。
// 法线与方向不能各自独立均匀取：要的是「着色法线偏离几何法线、反射方向落到几何面以下」这类相关的输入，所以用 gen 逐组生成，
// 全部用双精度算完再存成 float32。
/** 以 Z 为轴、偏开 theta 弧度、方位角 phi 的单位向量；X、Y 是与 Z 正交的两个单位向量 */
const tilted = (Z, X, Y, theta, phi) => add(add(mul(Z, Math.cos(theta)), X, Math.sin(theta) * Math.cos(phi)), Y, Math.sin(theta) * Math.sin(phi));
/** 双精度里照 Cycles 的式子（bsdf_util.h:324-394）走一遍 ensure_valid_specular_reflection：不拧法线时返回 null，拧时返回
 *  四个量里最小的那个（都在 0 到 1 之间，越小 float32 下越病态）：结果的 Nx、Nz，根号与 b 之比 √(b² − 4ac)/b，入射方向在 X-Z 平面里的
 *  长度 √a。理由：Nx = √(1 − Nz²)、Nz = √Nz² 在被开方数贴近 0 时把一个 ULP 放大成 ε/(2Nx) 量级的绝对误差（Nx 到 1e-4 时是 4e-4）；
 *  b² − 4ac = 4(a − t²)·Ix² 在 Ix 贴近 0 时是两个量级 4a² 的数相减，开方后同样被放大；√a 小时 Ix、Iz 本身是两个点积相消出来的小数。
 *  这几处 Cycles 原式在 float32 下本身就不准：【实测】本机 100 万组里不合格的组拿双精度照原式算真值，Cycles 本机一侧离真值更远的
 *  约占四成（诊断脚本没有入库） */
function specularCond(Ng, I, N) {
  const R = add(mul(N, 2 * dot3(N, I)), I, -1), Iz = dot3(I, Ng), t = Math.min(0.9 * Iz, 0.01);
  if (dot3(Ng, R) >= t) return null;
  const Xr = add(N, Ng, -dot3(N, Ng)), L = Math.hypot(...Xr), X = L ? mul(Xr, 1 / L) : N;
  const Ix = dot3(I, X), a = Ix * Ix + Iz * Iz, b = 2 * (a + Iz * t), c = (t + Iz) ** 2, d = Math.sqrt(Math.max(b * b - 4 * a * c, 0));
  const Nz2 = (Ix < 0 ? b + d : b - d) / (4 * a);
  return Math.min(Math.sqrt(Math.max(1 - Nz2, 0)), Math.sqrt(Math.max(Nz2, 0)), d / b, Math.sqrt(a));
}
// 拧法线的组只在 specularCond 不小于这个数的区域里逐组比
const SPEC_WELL = 0.1;
/** 几何法线 Ng 任意朝向；着色法线 N 偏开 Ng 0.01 到 1.4 弧度（十分之一的组 N 就是 Ng）；来路方向 I 在 Ng 这一侧，与 Ng 的夹角余弦
 *  对数均匀取在 1e-4 到 1（贴地的多）。不是 N 就是 Ng 的组里，一半只收「要拧法线、又在条件良好区域」的（N 偏开 0.3 到 1.4 弧度，
 *  按 specularCond 拒绝重取：N 偏得太少时拧过的法线贴着 Ng，Nx 小于 0.1，取不到），另一半不挑 */
function specularGeom(next) {
  const [X, Y] = rotation(next), Ng = crs(X, Y), same = next() < 0.1, force = !same && next() < 0.5;
  const N = same ? Ng : tilted(Ng, X, Y, linU(next, force ? [0.3, 1.4] : [0.01, 1.4]), 2 * Math.PI * next());
  for (;;) {
    const I = tilted(Ng, X, Y, Math.acos(logU(next, [1e-4, 1])), 2 * Math.PI * next());
    if (!force || specularCond(Ng, I, N) >= SPEC_WELL) return { Ng, I, N };
  }
}
/** 凹凸阴影项的输入：平滑法线 Ns 任意朝向；闭包法线 N 五分之一的组就是 Ns（直接返回 1 的那一支），其余偏开 Ns 0.1 到 π − 0.1 弧度
 *  （含翻到背面的，上游材质函数把法线翻过来时会这样）；出射方向 I 与 Ns 的夹角余弦的绝对值取在 1e-2 到 1、正负各半。
 *  另有十分之一的组 Ns 取 (0, 0, 1)、I 的 z 分量取 ±(1e-9 到 5e-7)（对数均匀）：cos_i 小于 1e-6 那一支，这时 dot(Ns, I) 就是 I.z，
 *  没有舍入。is_eval、is_diffuse 各自五五开（1 为真）。
 *  收窄的理由（都是 Cycles 原式在 float32 下的病态，不是移植的差别）：
 *    - N 不贴着 Ns（偏开至少 0.1 弧度）：tan²_d = 1/cos_d² − 1 在 cos_d 贴近 1 时相消，cos_d 差一个 ULP，tan²_d 就差 6e-8/(1 − cos_d)
 *      的相对量，再经柔化放大到结果上；偏开 0.1 弧度时约 1.2e-5。
 *    - cos_i 不在 1e-6 到 1e-2 之间：dot(Ns, I) 两边各差一两个 ULP（约 1e-7 的绝对量），柔化的结果在掠射处随 δcos/cos 变。 */
function bumpGeom(next) {
  const tiny = next() < 0.1;
  const [X, Y] = tiny ? [[1, 0, 0], [0, 1, 0]] : rotation(next), Ns = crs(X, Y);
  const N = next() < 0.2 ? Ns : tilted(Ns, X, Y, linU(next, [0.1, Math.PI - 0.1]), 2 * Math.PI * next());
  const side = next() < 0.5 ? 1 : -1, phi = 2 * Math.PI * next();
  let I;
  if (tiny) {
    const z = side * logU(next, [1e-9, 5e-7]), r = Math.sqrt(1 - z * z);
    I = [r * Math.cos(phi), r * Math.sin(phi), z];
  } else {
    I = tilted(Ns, X, Y, Math.acos(side * logU(next, [1e-2, 1])), phi);
  }
  return { Ns, N, I, is_eval: next() < 0.5 ? 1 : 0, is_diffuse: next() < 0.5 ? 1 : 0 };
}
/** 报告用：双精度里按 Cycles 的条件判 bump_shadowing_term 走哪一支（bsdf.h:98-149） */
function bumpBranch(i) {
  const Ns = at(i, 0), N = at(i, 3), I = at(i, 6), is_eval = i[9] !== 0, is_diffuse = i[10] !== 0;
  if (Ns.every((x, k) => x === N[k])) return '闭包法线就是平滑法线';
  if (dot3(Ns, I) * dot3(Ns, N) * dot3(N, I) < 0 && (is_eval || is_diffuse)) return '方向在平滑法线那一侧不合法';
  if (!is_diffuse) return '非漫反射';
  return Math.abs(dot3(Ns, I)) < 1e-6 ? '漫反射柔化·贴地' : '漫反射柔化';
}
FUNCTIONS.push(
  // 拧过的法线 Nx·X + Nz·Ng。拧法线的组只比条件良好区域（specularCond ≥ SPEC_WELL）里的，别的不比。比的组里 Nx、Nz 不小于 0.1，
  // 开方把 Nz² 的几个 ULP 放大到至多约 5 倍；结果分量量级 1。abs 给 16 个 ULP；【实测】所需 abs 见测试输出，在它的一半以内
  entry('ensure_valid_specular_reflection', [['Ng', 'vec3f'], ['I', 'vec3f'], ['N', 'vec3f']], 3, 16 * ULP1, {
    gen: specularGeom,
    branch: i => { const c = specularCond(at(i, 0), at(i, 3), at(i, 6)); return at(i, 0).every((x, k) => x === i[6 + k]) ? 'N 就是 Ng' : c === null ? '原样' : c >= SPEC_WELL ? '拧法线' : '拧法线·病态（不比）'; },
    skip: (ref, test, i) => { const c = specularCond(at(i, 0), at(i, 3), at(i, 6)); return c !== null && c < SPEC_WELL; },
  }),
  // 判据 cosNsI·cosNsN·cosNI < 0 在任一个余弦贴近 0 时两边可能一边判正一边判负（各差一两个 ULP），这些组不比。
  // 贴地那一支 dot(Ns, I) 没有舍入，只看另两个
  entry('bump_shadowing_term', [['Ns', 'vec3f'], ['N', 'vec3f'], ['I', 'vec3f'], ['is_eval', 'f32'], ['is_diffuse', 'f32']], 1, 0, {
    file: APACHE, gen: bumpGeom, branch: bumpBranch,
    call: ([Ns, N, I, ev, di]) => `bump_shadowing_term(${Ns}, ${N}, ${I}, ${ev} != 0.0, ${di} != 0.0)`,
    skip: (ref, test, i) => Math.min(Math.abs(dot3(at(i, 0), at(i, 3))), Math.abs(dot3(at(i, 3), at(i, 6)))) < 1e-5,
  }),
);

// 三角形求交（util/math_intersect.h 的 ray_triangle_intersect，内核的软件求交用它）。输入不能只均匀取：要守的是公共边与
// 顶点上不漏，均匀取的射线几乎碰不到边。三角形任意朝向、边长 1e-2 到 1e3；射线方向是单位向量。分两项：
//   ray_triangle_intersect       逐组对 Cycles 比中没中与 u、v、t，只在单精度条件良好的区域（WELL_TRI）：最短的高不小于
//                                0.3 倍最长边，方向与法线夹角的余弦不小于 0.3，起点离目标 0.1 到 10 倍边长，三角形离原点不超过
//                                10 倍边长。出了这个区域，U、V、W 是大数相消再除以小数（放大约 κ/(cos·高²) 倍），一两个 ULP 的
//                                舍入次序（显卡可能合成 FMA）就决定中没中与 u、v 的末几位，比的不是移植。
//                                【实测】苹果显卡上放到高 0.05、余弦 0.05、起点 1e-2 倍边长时，t 差到相对 3.5e-4，u、v 差到 1.2e-4
//   ray_triangle_intersect_pair  防水：不收窄（高 0.05、余弦 0.05、起点到 1e3 倍边长、离原点到 100 倍边长），只看公共边上
//                                两个三角形有没有一个打中，与条件数无关（见那一项）
// 目标点按四类取：
//   uniform  重心坐标在 [-0.2, 1.2] 里（有中有不中）
//   edge     在某条边上（双精度里正好在边上），再沿平面内垂直于边的方向挪开 0 或 ±1e-9 到 1e-3 倍边长
//   vertex   在某个顶点上，再沿平面内任意方向挪开 0 或 1e-9 到 1e-3 倍边长
//   tmax     uniform 的目标，tmax 取交点距离的 0.5 到 0.99 或 1.01 到 2 倍（有被截掉的）
// 除 tmax 一类外 tmin = 0、tmax = 1e30。
const TRI_KINDS = ['uniform', 'edge', 'vertex', 'tmax'];
const WELL_TRI = { flat: 0.3, cos: 0.3, dist: [0.1, 10], far: 10 };
const WIDE_TRI = { flat: 0.05, cos: 0.05, dist: [1e-2, 1e3], far: 100 };
// 中没中可以两边不同的带宽（重心坐标，乘条件数 κ，见 triCond）。【实测】WELL_TRI 里两边不同的组 |最小重心坐标|/κ 最大
// 5.4e-7（苹果显卡与英伟达显卡相同；100 万组里约 3.2% 的组两边不同，都在边界上），取约 4 倍
const TRI_BAND = 4e-6;
function triGeom(next, { flat, far }) {
  const size = logU(next, [1e-2, 1e3]);
  const center = mul([linU(next, [-1, 1]), linU(next, [-1, 1]), linU(next, [-1, 1])], size * logU(next, [1e-2, far]));
  for (;;) {
    const tri = [0, 1, 2].map(() => add(center, [linU(next, [-1, 1]), linU(next, [-1, 1]), linU(next, [-1, 1])], size));
    const n = crs(add(tri[1], tri[0], -1), add(tri[2], tri[0], -1)), long = Math.max(...[0, 1, 2].map(k => Math.hypot(...add(tri[(k + 1) % 3], tri[k], -1))));
    // 最短的高 = 2·面积/最长边
    if (Math.hypot(...n) / long > flat * long) return { tri, n: mul(n, 1 / Math.hypot(...n)), size: long };
  }
}
/** 从离 target dist 倍 size 处、与法线 n 夹角余弦不小于 cos 的一侧打向 target 的射线 */
function rayAt(next, target, n, size, { cos, dist }) {
  const [u, v] = rotation(next), w = crs(u, v);
  let d = add(add(mul(u, linU(next, [-1, 1])), v, linU(next, [-1, 1])), w, linU(next, [-1, 1]));
  d = mul(d, 1 / Math.hypot(...d));
  // 法线分量不够就把它抬到 cos 以上
  const c = dot3(d, n), side = c < 0 ? -1 : 1;
  if (Math.abs(c) < cos) { d = add(d, n, side * (cos - Math.abs(c)) * 1.01); d = mul(d, 1 / Math.hypot(...d)); }
  if (Math.abs(dot3(d, n)) < cos) d = mul(n, side);
  const t = size * logU(next, dist);
  return { ray_P: add(target, d, t), ray_D: mul(d, -1), t };
}
/** 挪开的距离（以边长为单位）：四分之一的组正好是 0 */
const nudge = next => (next() < 0.25 ? 0 : logU(next, [1e-9, 1e-3]) * (next() < 0.5 ? -1 : 1));
function triCase(next, kind) {
  const { tri, n, size } = triGeom(next, WELL_TRI);
  let target;
  if (kind === 'edge') {
    const k = Math.floor(next() * 3), a = tri[k], b = tri[(k + 1) % 3], e = add(b, a, -1), s = linU(next, [0.02, 0.98]);
    const out = crs(e, n);
    target = add(add(a, e, s), out, nudge(next) * size / Math.hypot(...out));
  } else if (kind === 'vertex') {
    const [p] = rotation(next), m = crs(n, crs(p, n)), len = Math.hypot(...m) || 1;
    target = add(tri[Math.floor(next() * 3)], m, Math.abs(nudge(next)) * size / len);
  } else {
    const b1 = linU(next, [-0.2, 1.2]), b2 = linU(next, [-0.2, 1.2]);
    target = add(add(tri[0], add(tri[1], tri[0], -1), b1), add(tri[2], tri[0], -1), b2);
  }
  const r = rayAt(next, target, n, size, WELL_TRI);
  const tmax = kind === 'tmax' ? r.t * (next() < 0.5 ? linU(next, [0.5, 0.99]) : linU(next, [1.01, 2])) : 1e30;
  return { ray_P: r.ray_P, ray_D: r.ray_D, ray_tmin: 0, ray_tmax: tmax, tri_a: tri[0], tri_b: tri[1], tri_c: tri[2] };
}
/** 双精度里射线与三角形所在平面的交点：重心坐标里最小的那个（负数在三角形外）与条件数 κ = max(最长边, 起点到交点、原点到交点
 *  的距离) / 最长边。单精度下 U、V、W 的舍入误差约为 κ·ε 乘上 U+V+W 的量级，skip 用它判一组是不是贴在边界上 */
function triCond(i) {
  const P = at(i, 0), D = at(i, 3), A = at(i, 8), B = at(i, 11), C = at(i, 14);
  const e1 = add(B, A, -1), e2 = add(C, A, -1), n = crs(e1, e2), t = dot3(add(A, P, -1), n) / dot3(D, n), X = add(P, D, t);
  const nn = dot3(n, n), b1 = dot3(crs(add(X, A, -1), e2), n) / nn, b2 = dot3(crs(e1, add(X, A, -1)), n) / nn;
  const size = Math.max(...[e1, e2, add(C, B, -1)].map(e => Math.hypot(...e)));
  return { mb: Math.min(1 - b1 - b2, b1, b2), kappa: Math.max(size, Math.hypot(...add(X, P, -1)), Math.hypot(...X)) / size };
}
const TRI_IN = [['ray_P', 'vec3f'], ['ray_D', 'vec3f'], ['ray_tmin', 'f32'], ['ray_tmax', 'f32'], ['tri_a', 'vec3f'], ['tri_b', 'vec3f'], ['tri_c', 'vec3f']];
FUNCTIONS.push(
  // 中没中：边界上（|最小重心坐标| < TRI_BAND·κ）两边可能一边判中一边判不中：容差 FLT_EPSILON·|U+V+W| 的门槛两侧各差一两个
  // ULP（标准答案一侧 SSE 与 NEON 的倒数是近似值，dot、cross 的舍入次序也可能与显卡不同），这些组不比；两边都判中时照常比
  // u、v、t。u、v 是 U/(U+V+W)，贴边时 U 抵消到接近 0，abs 给在 u、v 上。【实测】u、v 的差最大 7.9e-6（苹果显卡；英伟达显卡 7.8e-6；
  // 都在 κ 为 8 到 16 那一档），t 的相对差最大 2.8e-6（英伟达 2.5e-6）。比对外壳按 |差| − rel·|标准| 算的所需 abs：苹果 5.1e-6、
  // 英伟达 7.8e-6；外壳要求它在 abs 的一半以内，abs 取 256 个 [1, 2) 的 ULP（3.1e-5）
  entry('ray_triangle_intersect', TRI_IN, { hit: 1, u: 1, v: 1, t: 1 }, 256 * ULP1, {
    file: APACHE,
    gen: next => triCase(next, TRI_KINDS[Math.floor(next() * 4)]),
    branch: i => { const { mb } = triCond(i); return i[7] < 1e29 ? 'tmax 截断' : Math.abs(mb) < 1e-5 ? '贴边或贴顶点' : mb < 0 ? '三角形外' : '三角形内'; },
    skip: (ref, test, i) => { const { mb, kappa } = triCond(i); return ref[0] !== test[0] && Math.abs(mb) < TRI_BAND * kappa; },
  }),
  // 防水：两个三角形 (a, b, c) 与 (c, b, d) 共用边 b–c，射线打向这条公共边（双精度里正好在边上，或挪开不到 1e-9 倍边长）、
  // 穿过曲面，WIDE_TRI 的范围（不收窄：公共边在两个三角形里算出来只差符号，合成 FMA 时也一样，与条件数无关）。
  // 输出两个里有没有一个打中，标准答案与被测都必须是 1；上游的 Möller–Trumbore 在这里漏
  entry('ray_triangle_intersect_pair', [...TRI_IN, ['tri_d', 'vec3f']], 1, 0, {
    file: APACHE, wgsl: 'ray_triangle_intersect',
    gen: next => {
      for (;;) {
        const { tri: [a, b, c], n, size } = triGeom(next, WIDE_TRI), e = add(c, b, -1), mid = add(b, e, 0.5);
        // d：在 b–c 另一侧，可以折起来（与 a 不共面）
        const d = add(add(mid, add(mid, a, -1), linU(next, [0.5, 2])), n, linU(next, [-0.5, 0.5]) * size);
        const out = crs(e, n), target = add(add(b, e, linU(next, [0.02, 0.98])), out, (next() < 0.5 ? 0 : linU(next, [-1e-9, 1e-9])) * size / Math.hypot(...out));
        const r = rayAt(next, target, n, size, WIDE_TRI);
        // 射线要穿过曲面：两个三角形对射线朝同一面（折得太狠时射线擦过的是轮廓边，两个都不中才对）
        const n2 = crs(add(b, c, -1), add(d, c, -1)), c2 = dot3(n2, r.ray_D) / Math.hypot(...n2);
        if (dot3(n, r.ray_D) * c2 > 0 && Math.abs(c2) >= WIDE_TRI.cos) return { ray_P: r.ray_P, ray_D: r.ray_D, ray_tmin: 0, ray_tmax: 1e30, tri_a: a, tri_b: b, tri_c: c, tri_d: d };
      }
    },
    call: a => `(ray_triangle_intersect(${a.slice(0, 7).join(', ')}).hit || ray_triangle_intersect(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]}, ${a[6]}, ${a[5]}, ${a[7]}).hit)`,
  }),
);

// 下面是点光、平行光的采样与求交后的求值（kernel/light/point.h 不是球形的那一条路、kernel/light/sun.h），与阴影射线避开明暗交界线的
// 起点偏移（kernel/light/sample.h 的 shadow_ray_offset、shadow_ray_smooth_surface_offset），来源都是 Apache-2.0 的文件。
// 几何量彼此相关，用 gen 逐组生成，全部用双精度算完再存成 float32。
const unit = next => { const z = 2 * next() - 1, phi = 2 * Math.PI * next(), r = Math.sqrt(1 - z * z); return [r * Math.cos(phi), r * Math.sin(phi), z]; };
const norm3 = v => mul(v, 1 / Math.hypot(...v));
/** v 绕一个与它正交的随机轴转 theta 弧度（v 是单位向量） */
function turn(next, v, theta) {
  const a = norm3(crs(v, Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), b = crs(v, a), phi = 2 * Math.PI * next();
  return add(mul(v, Math.cos(theta)), add(mul(a, Math.cos(phi)), b, Math.sin(phi)), Math.sin(theta));
}
const F32_MAX = 3.4028234663852886e38;
/** 点光：灯心 co 在 [-2, 2]³，着色点离它 0.1 到 10（对数均匀）；半径一半是 0（灯心那一支，内核里场景包的点光都是这一支），一半取
 *  0.01% 到一半距离（圆盘那一支）；eval_fac 对数均匀取在 1e-3 到 1。距离不取到 0.1 以下：方向 D = (灯上一点 − P)/t 是两个量级到 4 的
 *  坐标相减，灯上那一点（灯心加圆盘上的偏移）在 float32 里差一个 ULP(4)，方向就差 ULP(4)/t；【实测】100 万组里距离 0.014 时
 *  方向分量差 8.6e-6（相对 2e-4）。这是 Cycles 原式在 float32 下的病态，不是移植的差别 */
function pointGeom(next) {
  const co = [linU(next, [-2, 2]), linU(next, [-2, 2]), linU(next, [-2, 2])], d = logU(next, [0.1, 10]);
  const radius = next() < 0.5 ? 0 : d * logU(next, [1e-4, 0.5]);
  return { co, radius, d, P: add(co, unit(next), d), eval_fac: logU(next, [1e-3, 1]) };
}
// 平行光张角的病态带：vector_angle 的 len(a − b) 在两个单位向量很近时是 float32 分量相减抵消出来的，相对误差约 ULP(1)/角度；
// 张角 1e-4 弧度时到 1e-3。fast_atan2f 里「压掉非规格化数」的 1 − (1 − k) 把角度按 ULP(1) 一档档取整（约 1.2e-7 弧度）：
// 【实测】标准答案一侧照原式取整，显卡一侧编译器把它化简成 k，两边在边界附近差到 1e-7。离张角边界不到 2e-3 倍张角（再加 1e-6）
// 的方向不比（两边可能一边判在盘里一边判在外面）。边界用双精度里的夹角 2·atan2(|a − b|, |a + b|) 量（acos 在 1 附近病态）
const SUN_EDGE = (angle, theta) => Math.abs(theta - angle) < 2e-3 * angle + 1e-6;
const sunTheta = i => { const a = mul(at(i, 0), -1 / Math.hypot(...at(i, 0))), b = mul(at(i, 6), 1 / Math.hypot(...at(i, 6))); return 2 * Math.atan2(Math.hypot(...add(a, b, -1)), Math.hypot(...add(a, b))); };
/** Cycles 的角法线压缩码（util/types_normal.h）：编码只用来取一个码（双精度近似即可），解码照处理器上 SIMD 版
 *  （packed_normal_decode_simd）逐步舍入，标准答案程序拿码解出来的法线与这里的逐位相同 */
function encodeNormal(n) {
  const l1 = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) + 1e-6;
  let vx = n[0] / l1, vy = n[1] / l1;
  if (n[2] < 0) [vx, vy] = [(1 - Math.abs(vy)) * Math.sign(vx || 1), (1 - Math.abs(vx)) * Math.sign(vy || 1)];
  const q = v => Math.min(Math.max(Math.trunc(v * 32767.5 + 32768), 0), 65535);
  return [q(vx), q(vy)];
}
function decodeNormal([dx, dy]) {
  const f = Math.fround, inv = f(2 / 65535);
  let nx = f(f(dx * inv) - 1), ny = f(f(dy * inv) - 1);
  const nz = f(f(1 - Math.abs(nx)) - Math.abs(ny)), t = Math.max(-nz, 0);
  nx = nx > 0 ? f(nx - t) : f(nx + t);
  ny = ny > 0 ? f(ny - t) : f(ny + t);
  const il = f(1 / f(Math.sqrt(f(f(f(nx * nx) + f(ny * ny)) + f(nz * nz)))));
  return [f(nx * il), f(ny * il), f(nz * il)];
}
/** 光滑网格上的一个三角形：三个顶点在半径 R（0.3 到 3）的球面上、彼此张开 0.01 到 0.3 弧度；角法线是球面法线（五分之一的组再随机
 *  偏开至多 0.2 弧度），压缩成码再照 Cycles 解码；着色点在三角形里均匀取；四分之一的组打在背面（Ng 与插值出来的 N 一起翻）。
 *  L 六成取在明暗交界线附近（与 N 的夹角余弦在 −0.2 到 0.3），其余在整个球面上均匀取；cutoff 七成取 Blender 的默认 0.1，
 *  一成半在 0.01 到 0.5 里对数均匀，一成半是 0（不挪）。全部用双精度算完再存成 float32（顶点先存，P、N、Ng 由存过的顶点算） */
function smoothGeom(next) {
  const f3 = v => v.map(Math.fround);
  const c = [linU(next, [-1, 1]), linU(next, [-1, 1]), linU(next, [-1, 1])], R = logU(next, [0.3, 3]), base = unit(next), s = logU(next, [0.01, 0.3]);
  const dirs = [0, 1, 2].map(k => turn(next, base, s * linU(next, [0.5, 1]) + 1e-3 * k));
  const V = dirs.map(d => f3(add(c, d, R)));
  const bend = next() < 0.2;
  const codes = dirs.map(d => encodeNormal(bend ? turn(next, d, linU(next, [0, 0.2])) : d));
  const N = codes.map(decodeNormal);
  let u = next(), v = next();
  if (u + v > 1) [u, v] = [1 - u, 1 - v];
  [u, v] = [Math.fround(u), Math.fround(v)];
  const w = 1 - u - v, P = f3(add(add(mul(V[0], w), V[1], u), V[2], v));
  let Ng = norm3(crs(add(V[1], V[0], -1), add(V[2], V[0], -1)));
  if (dot3(Ng, base) < 0) Ng = mul(Ng, -1);
  let Ns = norm3(add(add(mul(N[0], w), N[1], u), N[2], v));
  if (next() < 0.25) [Ng, Ns] = [mul(Ng, -1), mul(Ns, -1)];
  const L = next() < 0.6 ? turn(next, Ns, Math.acos(linU(next, [-0.2, 0.3]))) : unit(next);
  const r = next(), cutoff = r < 0.7 ? 0.1 : r < 0.85 ? logU(next, [0.01, 0.5]) : 0;
  return { V0: V[0], V1: V[1], V2: V[2], N0: N[0], N1: N[1], N2: N[2], codes: codes.flat(), u, v, P, N: f3(Ns), Ng: f3(Ng), L, cutoff };
}
const TRI_V = [['V0', 'vec3f'], ['V1', 'vec3f'], ['V2', 'vec3f'], ['N0', 'vec3f'], ['N1', 'vec3f'], ['N2', 'vec3f']];
const CODES = [['c0x', 'f32'], ['c0y', 'f32'], ['c1x', 'f32'], ['c1y', 'f32'], ['c2x', 'f32'], ['c2y', 'f32']];
const withCodes = g => ({ ...g, c0x: g.codes[0], c0y: g.codes[1], c1x: g.codes[2], c1y: g.codes[3], c2x: g.codes[4], c2y: g.codes[5] });
FUNCTIONS.push(
  // 采样点、方向的分量是量级到 7 的数相减（圆盘那一支还带显卡 cos、sin 约 2e-7 的绝对误差乘半径），abs 给在分量上
  light('point_light_sample', [['co', 'vec3f'], ['radius', 'f32'], ['eval_fac', 'f32'], ['rand', 'vec2f'], ['P', 'vec3f']], { P: 3, Ng: 3, t: 1, D: 3, pdf: 1, eval_fac: 1 }, 32 * ULP1, {
    gen: next => ({ ...pointGeom(next), rand: [next(), next()] }),
    branch: i => (i[3] > 0 ? '圆盘' : '灯心'),
  }),
  // 射线打向圆盘上的一点（半径 0 的组打向灯心），一成的组 t 是 FLT_MAX（Cycles 不算密度那一支）
  light('point_light_eval_from_intersection', [['ray_P', 'vec3f'], ['ray_D', 'vec3f'], ['t', 'f32'], ['co', 'vec3f'], ['radius', 'f32'], ['eval_fac', 'f32']], { eval_fac: 1, pdf: 1 }, 0, {
    gen: next => {
      const g = pointGeom(next), lightN = norm3(add(g.P, g.co, -1)), a = norm3(crs(lightN, Math.abs(lightN[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), b = crs(lightN, a);
      const rr = g.radius * Math.sqrt(next()), phi = 2 * Math.PI * next(), Q = add(add(g.co, a, rr * Math.cos(phi)), b, rr * Math.sin(phi));
      const d = add(Q, g.P, -1), t = Math.hypot(...d);
      return { ray_P: g.P, ray_D: mul(d, 1 / t), t: next() < 0.1 ? F32_MAX : t, co: g.co, radius: g.radius, eval_fac: g.eval_fac };
    },
    branch: i => (i[6] > 1e38 ? 't 是 FLT_MAX' : i[10] > 0 ? '圆盘' : '灯心'),
  }),
  // 1 − cos 半角：一成半是 0（张角 0：锥退化成一个方向），其余在 1e-6 到 1 里对数均匀（半角约 0.08° 到 90°）。方向分量量级 1，
  // 圆盘采样的 cos、sin 误差乘上 √(2·one_minus_cosangle)
  light('sun_light_sample', [['co', 'vec3f'], ['one_minus_cosangle', 'f32'], ['eval_fac', 'f32'], ['rand', 'vec2f']], { P: 3, Ng: 3, t: 1, D: 3, pdf: 1, eval_fac: 1 }, 32 * ULP1, {
    gen: next => ({ co: unit(next), one_minus_cosangle: next() < 0.15 ? 0 : logU(next, [1e-6, 1]), eval_fac: logU(next, [1e-3, 1]), rand: [next(), next()] }),
    branch: i => (i[3] > 0 ? '锥' : '张角 0'),
  }),
  // 半角一成是 0，其余在 1e-4 到 1.5 弧度里对数均匀；方向是 −co 转开 0 到 2 倍半角。离边界太近的不比（SUN_EDGE）
  light('sun_light_eval_from_intersection', [['co', 'vec3f'], ['angle', 'f32'], ['eval_fac', 'f32'], ['pdf', 'f32'], ['ray_D', 'vec3f']], { eval_fac: 1, pdf: 1 }, 0, {
    gen: next => {
      const co = unit(next), angle = next() < 0.1 ? 0 : logU(next, [1e-4, 1.5]), theta = angle * linU(next, [0, 2]);
      return { co, angle, eval_fac: logU(next, [1e-3, 1]), pdf: logU(next, [1e-3, 1e5]), ray_D: turn(next, mul(co, -1), theta) };
    },
    branch: i => (i[3] === 0 ? '张角 0' : sunTheta(i) > i[3] ? '盘外' : '盘里'),
    skip: (ref, test, i) => i[3] > 0 && SUN_EDGE(i[3], sunTheta(i)),
  }),
  // 偏移 n·h：h 是顶点差与角法线差的点积组合，量级到 R·s² ≈ 0.3；顶点坐标量级到 4，差的舍入约 ULP(4)，abs 给在分量上
  light('shadow_ray_smooth_surface_offset', [...TRI_V, ...CODES, ['u', 'f32'], ['v', 'f32'], ['Ng', 'vec3f']], 3, 32 * 4 * ULP1, {
    gen: next => { const g = withCodes(smoothGeom(next)); return { ...g, Ng: next() < 0.5 ? g.Ng : mul(g.Ng, -1) }; },
    call: a => `shadow_ray_smooth_surface_offset(${[...a.slice(0, 6), a[12], a[13], a[14]].join(', ')})`,
    branch: i => (dot3(add(add(mul(at(i, 9), 1 - i[24] - i[25]), at(i, 12), i[24]), at(i, 15), i[25]), at(i, 26)) > 0 ? '法线同侧' : '法线翻过'),
  }),
  // 挪过的起点 = sd.P + 偏移·挪的份额；sd.P 量级到 4。L 贴着 N 或 Ng 的面（余弦不到 1e-5）的组不比：transmit 与 skip_self 两个判断
  // 在那里两边可能一边判正一边判负
  light('shadow_ray_offset', [['sd_P', 'vec3f'], ['sd_N', 'vec3f'], ['sd_Ng', 'vec3f'], ['L', 'vec3f'], ['cutoff', 'f32'], ...TRI_V, ...CODES, ['u', 'f32'], ['v', 'f32']], { P: 3, skip_self: 1 }, 32 * 4 * ULP1, {
    gen: next => { const g = withCodes(smoothGeom(next)); return { ...g, sd_P: g.P, sd_N: g.N, sd_Ng: g.Ng }; },
    call: a => `shadow_ray_offset(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]}, true, ${a[4]}, ${a.slice(5, 11).join(', ')}, ${a[17]}, ${a[18]})`,
    branch: i => { const NL = dot3(at(i, 3), at(i, 9)); return i[12] === 0 ? '不挪（cutoff 0）' : Math.abs(NL) < i[12] ? '贴着明暗交界线' : '离交界线远'; },
    skip: (ref, test, i) => Math.abs(dot3(at(i, 3), at(i, 9))) < 1e-5 || Math.abs(dot3(at(i, 6), at(i, 9))) < 1e-5,
  }),
);
