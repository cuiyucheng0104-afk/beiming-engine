// 函数级比对外壳的测试。纯逻辑部分任何机器都跑；端到端部分要编得出 Cycles、拿得到硬件 WebGPU 适配器，
// 缺了就跳过并写明缺什么；BEIMING_FNCHECK_E2E=1 时缺工具链算失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { OUT, buildRenderer, sourceKey } from '../chassis/build.mjs';
import { chi2Test, directionChi2, gammaQ, ggxAlbedo, gridChi2, mcMean, polygonIrradiance, reciprocity } from './checks.mjs';
import { compare } from './compare.mjs';
import { FILTER_TABLES, FUNCTIONS, crs, dot3, outWidth, width } from './registry.mjs';
import { CORE, check, filterTables, makeInputs, runHost, shaderSource } from './run.mjs';

const E2E = process.env.BEIMING_FNCHECK_E2E === '1';
const byName = name => FUNCTIONS.find(f => f.name === name);

/** 宿主一侧的渲染程序：E2E=1 时现编；否则只用编好的（chassis/build.mjs 的 out/bin），没有就返回 null。
 *  不设 E2E 时不现编：CI 上从头编带 wgpu 的 release 要好几分钟，会拖垮整组测试的时限 */
function prebuiltRenderer() {
  if (E2E) return buildRenderer().bin;
  const bin = path.join(OUT, 'bin', `core-render-${sourceKey([])}${process.platform === 'win32' ? '.exe' : ''}`);
  return fs.existsSync(bin) ? bin : null;
}

test('同一种子产生同一串输入字节，换种子就变，值都落在登记的范围里', () => {
  const f = byName('fresnel_f82');
  const a = makeInputs(f, 1000, 7), b = makeInputs(f, 1000, 7), c = makeInputs(f, 1000, 8);
  assert.equal(a.length, 1000 * width(f));
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
  assert.notDeepEqual(Buffer.from(a.buffer), Buffer.from(c.buffer));
  const ranges = f.inputs.flatMap(([, type, r]) => (type !== 'vec3f' ? [r] : Array.isArray(r[0]) ? r : [r, r, r]));
  for (let i = 0; i < a.length; i++) {
    const [lo, hi] = ranges[i % ranges.length];
    assert.ok(a[i] >= Math.fround(lo) && a[i] <= Math.fround(hi), `第 ${i} 个分量 ${a[i]} 不在 [${lo}, ${hi}]`);
  }
  // 单跑一个函数与跑全部时，同一个函数拿到的输入相同：流按函数名分开
  assert.notDeepEqual(Buffer.from(makeInputs(byName('bsdf_D_ggx'), 100, 7).buffer), Buffer.from(makeInputs(byName('bsdf_G_mono_ggx'), 100, 7).buffer));
});

test('比较函数抓得出错值，并报出下标、输入和两边的值', () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  const r = compare({ input, nIn: 1, ref: new Float32Array([1, 2, 3]), test: new Float32Array([1, 2.1, 3]), nOut: 1, rel: 1e-4, abs: 0 });
  assert.equal(r.groups, 3);
  assert.equal(r.fails, 1);
  assert.equal(r.worst[0].index, 1);
  assert.deepEqual(r.worst[0].input, [input[1]]);
  assert.deepEqual(r.worst[0].ref, [2]);
  assert.deepEqual(r.worst[0].test, [Math.fround(2.1)]);
  assert.ok(Math.abs(r.maxRel - 0.05) < 1e-6);
});

test('容差边界：恰好等于容差算过，超一点不过；任一边非有限数单独计数并判不过', () => {
  const run = (ref, t, rel, abs) => compare({ input: new Float32Array(ref.length), nIn: 1, ref: Float64Array.from(ref), test: Float64Array.from(t), nOut: 1, rel, abs });
  assert.equal(run([1], [1.5], 0.25, 0.25).fails, 0);            // |Δ| = 0.5 = 0.25·1 + 0.25
  assert.equal(run([1], [1.5000001], 0.25, 0.25).fails, 1);
  assert.equal(run([0], [1e-7], 0, 1e-7).fails, 0);               // 标准为 0 时只剩绝对容差
  const nf = run([NaN, 1, Infinity, 1], [NaN, Infinity, Infinity, 1], 1, 1);
  assert.equal(nf.nonFinite, 3);
  assert.equal(nf.fails, 3);
  // 多分量输出：一组里任一分量不过，整组不过
  const v = compare({ input: new Float32Array(2), nIn: 1, ref: new Float32Array([1, 1, 1, 1, 1, 1]), test: new Float32Array([1, 1, 1, 1, 2, 1]), nOut: 3, rel: 1e-4, abs: 0 });
  assert.equal(v.fails, 1);
  assert.equal(v.worst[0].index, 1);
});

test('登记表里每个函数在它的 WGSL 文件和标准答案程序里都有，参数个数对得上', async () => {
  const cpp = (await readFile(new URL('./cycles/ref.cpp', import.meta.url), 'utf8')) + (await readFile(new URL('./cycles/ref_imaging.h', import.meta.url), 'utf8'));
  for (const name of [...NEW, ...NEW_IMAGING]) assert.ok(byName(name), `登记表里没有 ${name}`);
  for (const f of FUNCTIONS) {
    const wgsl = await readFile(`${CORE}/${f.file}`, 'utf8');
    // 宿主一侧的几项是 Rust 的 pub fn
    const m = wgsl.match(new RegExp(`\\n${f.host ? 'pub fn' : 'fn'} ${f.wgsl}\\(([^)]*)\\)`));
    assert.ok(m, `${f.file} 里没有 fn ${f.wgsl}`);
    // 有 call 的项由它拼出调用（补常量实参），参数个数不必与输入个数相同
    if (!f.call) assert.equal(m[1].split(',').filter(s => s.trim()).length, f.inputs.length, f.name);
    assert.ok(cpp.includes(`{"${f.ref}", ${width(f)}, ${outWidth(f)},`), `ref.cpp 里没有 ${f.ref}（${width(f)} 进 ${outWidth(f)} 出）`);
    // gen 逐组生成的项不写范围，由下面的面光几何测试核对
    for (const [, type, r] of f.gen ? [] : f.inputs) {
      // dir 的 z 范围可以退化成一点：[1, 1] 就是 (0, 0, 1)
      for (const [lo, hi] of Array.isArray(r[0]) ? r : [r]) assert.ok(Number.isFinite(lo) && Number.isFinite(hi) && (type === 'dir' ? lo <= hi : lo < hi), f.name);
      if (type === 'dir') assert.ok(r[0] >= -1 && r[1] <= 1, f.name);
    }
    assert.ok(f.rel <= 1e-4 && f.abs >= 0, f.name);
  }
});

test('方向输入：由均匀数确定地生成，是单位向量，z 落在登记的范围里', () => {
  const f = byName('bsdf_microfacet_ggx_eval');
  const a = makeInputs(f, 2000, 5);
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(makeInputs(f, 2000, 5).buffer));
  let o = 0;
  const at = f.inputs.map(([, type, r]) => { const k = o; o += type === 'dir' || type === 'vec3f' ? 3 : type === 'vec2f' ? 2 : 1; return [k, type, r]; });
  for (let g = 0; g < 2000; g++) {
    for (const [k, type, r] of at.filter(x => x[1] === 'dir')) {
      const [x, y, z] = a.subarray(g * o + k, g * o + k + 3);
      assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-6, `${type} 第 ${g} 组不是单位向量`);
      assert.ok(z >= Math.fround(r[0]) && z <= Math.fround(r[1]));
    }
  }
});

test('面光几何输入：正交基、invarea 与着色点的位置按场景生成，确定且可复现', () => {
  const dot = (p, q) => dot3([...p], [...q]);
  for (const [name, elev] of [['area_light_rect_sample', [0.3, 1]], ['area_light_rect_sample_solid_angle', [0.1, 1]], ['area_light_rect_sample_grazing', [0, 1e-3]]]) {
    const f = byName(name), w = width(f), a = makeInputs(f, 2000, 5);
    assert.deepEqual(Buffer.from(a.buffer), Buffer.from(makeInputs(f, 2000, 5).buffer));
    for (let g = 0; g < 2000; g++) {
      const i = a.subarray(g * w, (g + 1) * w);
      const [P, co, u, v] = [i.subarray(0, 3), i.subarray(3, 6), i.subarray(6, 9), i.subarray(10, 13)];
      assert.ok(Math.abs(dot(u, u) - 1) < 1e-6 && Math.abs(dot(v, v) - 1) < 1e-6 && Math.abs(dot(u, v)) < 1e-6, `${name} 第 ${g} 组不是正交基`);
      const d = [0, 1, 2].map(k => P[k] - co[k]), e = Math.abs(dot(d, crs([...u], [...v]))) / Math.hypot(...d);
      assert.ok(e >= elev[0] * 0.999 && e <= elev[1] * 1.001, `${name} 第 ${g} 组仰角正弦 ${e} 不在 [${elev}]`);
    }
  }
  const s = byName('area_light_sample'), b = makeInputs(s, 100, 5), w = width(s);
  for (let g = 0; g < 100; g++) assert.ok(Math.abs(b[g * w + 19] * b[g * w + 11] * b[g * w + 15] - 1) < 1e-5, 'invarea 应为 1/(len_u·len_v)');
});

test('χ² 检验：p 值与已知值一致，期望过小的箱合并，期望为 0 却有样本时判不过', () => {
  // 卡方分布上分位：dof=1 时 3.841 对应 p=0.05；dof=10 时 23.209 对应 p=0.01
  assert.ok(Math.abs(gammaQ(0.5, 3.841 / 2) - 0.05) < 1e-4);
  assert.ok(Math.abs(gammaQ(5, 23.209 / 2) - 0.01) < 1e-4);
  // Q(a, a) ≈ 1/2 − 1/(3√(2πa))
  assert.ok(Math.abs(gammaQ(1000, 1000) - 0.4958) < 1e-4);
  const r = chi2Test([100, 98, 3, 1, 0], [100, 100, 2, 1.5, 0.5], { minExpected: 5 });
  assert.equal(r.bins, 2);  // 后三个期望合起来 4 < 5，再并进期望最小的那一箱
  assert.equal(r.dof, 1);
  assert.ok(r.p > 0.5);
  assert.equal(chi2Test([10, 10, 1], [10.5, 10.5, 0]).p, 0);
});

const NEW = [
  'make_orthonormals', 'to_global', 'disk_to_hemisphere', 'lookup_table_read_ggx_Eavg', 'lookup_table_read_2D_ggx_E',
  'sample_uniform_disk', 'microfacet_ggx_sample_vndf', 'microfacet_fresnel_f82', 'microfacet_ggx_preserve_energy',
  'bsdf_microfacet_setup_fresnel_f82_tint', 'bsdf_microfacet_eval_ggx', 'bsdf_microfacet_ggx_eval',
  'bsdf_microfacet_sample_ggx', 'bsdf_microfacet_ggx_sample',
  'safe_asinf', 'ray_quad_intersect', 'area_light_rect_sample', 'area_light_rect_sample_solid_angle', 'area_light_rect_sample_tiny', 'area_light_rect_sample_grazing',
  'area_light_sample', 'area_light_eval_from_intersection', 'area_light_intersect',
  // 原理化 BSDF 非金属那一半
  'fresnel_dielectric_polarized', 'fresnel_dielectric_polarized_inside', 'fresnel_dielectric_ccl', 'fresnel_dielectric_ccl_inside', 'fresnel_dielectric_Fss',
  'ior_from_F0', 'F0_from_ior', 'inverse_lerp', 'safe_divide_color', 'closure_layering_weight',
  'lookup_table_read_3D_ggx_gen_schlick_ior_s', 'lookup_table_read_3D_ggx_gen_schlick_s',
  'generalized_schlick_fresnel', 'generalized_schlick_fresnel_regular', 'microfacet_fresnel_generalized_schlick',
  'bsdf_microfacet_estimate_albedo_generalized_schlick', 'bsdf_microfacet_estimate_albedo_f82_tint', 'bsdf_microfacet_setup_fresnel_generalized_schlick',
  'bsdf_microfacet_eval_ggx_generalized_schlick', 'bsdf_microfacet_eval_ggx_generalized_schlick_singular', 'bsdf_microfacet_ggx_eval_generalized_schlick',
  'bsdf_microfacet_sample_ggx_generalized_schlick', 'bsdf_microfacet_sample_ggx_generalized_schlick_singular', 'bsdf_microfacet_ggx_sample_generalized_schlick',
  'bsdf_blur', 'sample_cos_hemisphere', 'bsdf_diffuse_eval', 'bsdf_diffuse_sample', 'emissive_pdf', 'emissive_simple_eval',
];

// 成像一路：像素滤波的滤波函数与建表（宿主一侧），查表与夹取（内核）
const NEW_IMAGING = [
  'filter_func_box', 'filter_func_gaussian', 'filter_func_blackman_harris', 'filter_table_box', 'filter_table_gaussian', 'filter_table_blackman_harris',
  'filter_table_read_box', 'filter_table_read_gaussian', 'filter_table_read_blackman_harris', 'film_clamp_light',
];

/** 端到端测试的公共前置：缺工具链时跳过（E2E=1 时抛出），返回 null */
async function e2e(t, opts) {
  try { return await check({ allowFetch: E2E, ...opts }); } catch (e) {
    if (e.missing && !E2E) { t.skip(`缺工具链：${e.missing}`); return null; }
    throw e;
  }
}

test('端到端：每个登记的函数 100 万组随机输入，WGSL 与 Cycles 在容差内一致；同一种子两遍输入字节与结论相同', { timeout: 600_000 }, async t => {
  const a = await e2e(t, { n: 1_000_000, seed: 1 });
  if (!a) return;
  for (const r of a.results) {
    t.diagnostic(`${r.name}: groups=${r.groups} maxRel=${r.maxRel.toExponential(3)} maxRelNonTiny=${r.maxRelNonTiny.toExponential(3)} abs=${r.abs.toExponential(2)} fails=${r.fails} nonFinite=${r.nonFinite} 标准全零的组=${(r.zeroRef / r.groups * 100).toFixed(2)}% 不比的组=${(r.skipped / r.groups * 100).toFixed(3)}% 所需abs=${r.needAbs.toExponential(2)}${r.branches ? ` 分支=${Object.entries(r.branches).map(([b, c]) => `${b}:${(c / r.groups * 100).toFixed(2)}%`).join('，')}` : ''}`);
    // 实测差值要在 abs 的一半以内
    assert.ok(r.needAbs <= r.abs / 2, `${r.name} 所需 abs ${r.needAbs} 超过登记的 abs 的一半`);
    assert.equal(r.groups, byName(r.name).n ?? 1_000_000, r.name);
    assert.ok(r.maxRelNonTiny <= 1e-4, `${r.name} 在绝对容差不兜底的地方相对误差 ${r.maxRelNonTiny}`);
    assert.equal(r.fails, 0, `${r.name} 不合格：${JSON.stringify(r.worst[0])}`);
  }
  assert.equal(a.ok, true);
  assert.equal(a.results.length, FUNCTIONS.length);
  const b = await e2e(t, { n: 1_000_000, seed: 1 });
  assert.deepEqual(b.results.map(r => [r.name, r.inputSha256, r.fails]), a.results.map(r => [r.name, r.inputSha256, r.fails]));
  assert.equal(b.ok, a.ok);
});

test('端到端：故意把一个 WGSL 函数改错一项，报出是哪个函数、哪组输入、差多少', { timeout: 600_000 }, async t => {
  const file = 'shaders/microfacet.wgsl';
  const src = await readFile(`${CORE}/${file}`, 'utf8');
  for (const [from, to, expect, nIn, nOut] of [
    // 建立闭包时开能量补偿要用 Fss，所以它也跟着不合格
    ['B * (1.0 / 126.0)', 'B * (1.0 / 125.0)', ['fresnel_f82_Fss', 'bsdf_microfacet_setup_fresnel_f82_tint'], 6, 3],
    // 新移植的闭包求值：反射的公共因子 0.25 改成 0.26，只有求值与它的包装不合格
    ['let common_ = D / cos_NI * 0.25;', 'let common_ = D / cos_NI * 0.26;', ['bsdf_microfacet_eval_ggx', 'bsdf_microfacet_ggx_eval'], 16, 4],
  ]) {
    await breakOne(t, file, src, from, to, expect, nIn, nOut);
  }
  // 原理化 BSDF 非金属那一半，各改错一项：
  for (const [from, to, expect, nIn, nOut] of [
    // 电介质的菲涅耳：非偏振取平均的 1/2 改成 0.51。用它的广义 Schlick（exponent < 0 那一支）、求值、采样、能量补偿一并不合格；
    // 一般那一支（exponent ≥ 0）不经它，照旧合格
    ['return (f.x + f.y) * (1.0 / 2.0);', 'return (f.x + f.y) * 0.51;', ['fresnel_dielectric_ccl', 'fresnel_dielectric_ccl_inside', 'generalized_schlick_fresnel', 'microfacet_fresnel_generalized_schlick',
      'bsdf_microfacet_eval_ggx_generalized_schlick', 'bsdf_microfacet_ggx_eval_generalized_schlick', 'bsdf_microfacet_sample_ggx_generalized_schlick', 'bsdf_microfacet_sample_ggx_generalized_schlick_singular', 'bsdf_microfacet_ggx_sample_generalized_schlick'], 2, 1],
    // 电介质的 F0：(ior − 1)/(ior + 1) 的平方漏掉平方（电介质高光的 (F0, eta) 也经它）。能量补偿那一项也用它（s = (Fss − F0)/(1 − F0)），但改错之后 F0
    // 总大于 Fss、s 被夹成 0，与对的 s（几个百分点）只在粗糙时差得出 1e-4，10 万组里没有超出的组，所以它不在名单里
    ['return sqr((ior - 1.0) / (ior + 1.0));', 'return (ior - 1.0) / (ior + 1.0);', ['F0_from_ior', 'principled_specular_f0_eta', 'generalized_schlick_fresnel', 'microfacet_fresnel_generalized_schlick',
      'bsdf_microfacet_eval_ggx_generalized_schlick', 'bsdf_microfacet_ggx_eval_generalized_schlick', 'bsdf_microfacet_sample_ggx_generalized_schlick', 'bsdf_microfacet_sample_ggx_generalized_schlick_singular', 'bsdf_microfacet_ggx_sample_generalized_schlick'], 1, 1],
    // 层间权重：剩下的权重多乘 0.99（标准为 0 的组被测也是 0，最差一组落在标准不为 0 的组上）
    ['return weight * saturate(1.0 - reduce_max(safe_divide_color(layer_albedo, weight)));', 'return 0.99 * weight * saturate(1.0 - reduce_max(safe_divide_color(layer_albedo, weight)));', ['closure_layering_weight'], 6, 3],
    // 漫反射：求值的 1/π 改成 0.32
    ['let cosNO = max(dot(N, wo), 0.0) * M_1_PI_F;', 'let cosNO = max(dot(N, wo), 0.0) * 0.32;', ['bsdf_diffuse_eval'], 6, 4],
    // 发光值：双面改成单面（只认几何法线那一侧）
    ['let cosNI = abs(dot(Ng, wi));', 'let cosNI = dot(Ng, wi);', ['emissive_pdf', 'emissive_simple_eval'], 6, 1],
    // 滤光泽：alpha 与模糊粗糙度取大写成取小
    ['return vec2f(max(roughness, alpha_x), max(roughness, alpha_y));', 'return vec2f(min(roughness, alpha_x), max(roughness, alpha_y));', ['bsdf_blur'], 3, 2],
  ]) {
    await breakOne(t, file, src, from, to, expect, nIn, nOut);
  }
  // 电介质高光的 (F0, eta)：高光等级乘 2 写成乘 2.1；ior < 1 时 eta 漏了取倒数
  const util = 'shaders/util.wgsl', usrc = await readFile(`${CORE}/${util}`, 'utf8');
  await breakOne(t, util, usrc, 'f0 *= 2.0 * specular_ior_level;', 'f0 *= 2.1 * specular_ior_level;', ['principled_specular_f0_eta'], 2, 2);
  await breakOne(t, util, usrc, 'eta = 1.0 / eta;', 'eta = eta;', ['principled_specular_f0_eta'], 2, 2);
  const light = 'shaders/area_light.wgsl', lsrc = await readFile(`${CORE}/${light}`, 'utf8');
  // 面光：矩形右边界的 0.5 改成 0.51，走立体角那一支的四项不合格；平面近似的两项（tiny、grazing）概率密度不用 x1，照旧合格
  await breakOne(t, light, lsrc, 'let x1 = xc + 0.5 * len_u;', 'let x1 = xc + 0.51 * len_u;', ['area_light_rect_sample', 'area_light_rect_sample_solid_angle', 'area_light_sample', 'area_light_eval_from_intersection'], 16, 4);
  // 辐射通量换成辐射亮度的 1/π 改成 0.32，只有带 eval_fac 的两项不合格
  await breakOne(t, light, lsrc, 'M_1_PI_F * invarea', '0.32 * invarea', ['area_light_sample', 'area_light_eval_from_intersection'], 20, 10);
  // 三角形求交：换回上游的 Möller–Trumbore（闭区间、无容差），防水一项不合格；逐组那一项在边界上本来就不比中没中，照旧合格。
  // 这两处只跑三角形求交的两项（各自只让自己那一项不合格），不碰宿主一侧
  const TRI = ['ray_triangle_intersect', 'ray_triangle_intersect_pair'];
  const start = usrc.indexOf('fn ray_triangle_intersect('), end = usrc.indexOf('\n}\n', start) + 3;
  await breakOne(t, util, usrc, usrc.slice(start, end), `fn ray_triangle_intersect(ray_P: vec3f, ray_D: vec3f, ray_tmin: f32, ray_tmax: f32, tri_a: vec3f, tri_b: vec3f, tri_c: vec3f) -> TriangleHit {
  let e1 = tri_b - tri_a;
  let e2 = tri_c - tri_a;
  let pv = cross(ray_D, e2);
  let det = dot(e1, pv);
  if (abs(det) < 1e-12) { return TriangleHit(); }
  let inv = 1.0 / det;
  let tv = ray_P - tri_a;
  let u = dot(tv, pv) * inv;
  if (u < 0.0 || u > 1.0) { return TriangleHit(); }
  let qv = cross(tv, e1);
  let v = dot(ray_D, qv) * inv;
  if (v < 0.0 || u + v > 1.0) { return TriangleHit(); }
  let t = dot(e2, qv) * inv;
  if (!(t >= ray_tmin && t <= ray_tmax)) { return TriangleHit(); }
  return TriangleHit(true, u, v, t);
}
`, ['ray_triangle_intersect_pair'], 20, 1, TRI);
  // u、v 对调：逐组那一项不合格，防水一项不看 u、v，照旧合格
  await breakOne(t, util, usrc, 'return TriangleHit(true, min(U * rcp_uvw, 1.0), min(V * rcp_uvw, 1.0), t);', 'return TriangleHit(true, min(V * rcp_uvw, 1.0), min(U * rcp_uvw, 1.0), t);', ['ray_triangle_intersect'], 17, 4, TRI);
});

// names：只跑这几项（不写就是全部）。只给着色器一侧的项时不碰宿主一侧，不编渲染程序
async function breakOne(t, file, src, from, to, expect, nIn, nOut, names) {
  {
    const broken = src.replace(from, to);
    assert.notEqual(broken, src, `要改的那一项在 WGSL 里找不到了：${from}`);
    const r = await e2e(t, { n: 100_000, seed: 3, wgsl: { [file]: broken }, ...(names && { names }) });
    if (!r) return;
    assert.equal(r.ok, false);
    assert.deepEqual(r.results.filter(x => x.fails > 0).map(x => x.name), expect);
    const w = r.results.find(x => x.name === expect[0]).worst[0];
    t.diagnostic(`${expect[0]} 最差一组：下标 ${w.index} 输入 [${w.input}] 标准 [${w.ref}] 被测 [${w.test}] 相对误差 ${w.relErr}`);
    assert.ok(Number.isInteger(w.index) && w.input.length === nIn && w.ref.length === nOut && w.test.length === nOut);
    assert.ok(w.relErr > 1e-4);
  }
}

/** 显卡上的检验缺工具链时跳过（E2E=1 时抛出） */
async function gpuOnly(t, fn) {
  try { return await fn(); } catch (e) {
    if (e.missing && !E2E) { t.skip(`缺工具链：${e.missing}`); return null; }
    throw e;
  }
}

// χ² 与反照率用的金属：F0 与 F82 的 B 取一组普通值；这两项不影响采样分布，只影响被拒的样本
const METAL = 'vec3f(0.9, 0.6, 0.3), fresnel_f82tint_B(vec3f(0.9, 0.6, 0.3), vec3f(0.8))';
const CHI2_HELPERS = `
fn chi2_ggx_wi(cos_i: f32) -> vec3f { return vec3f(sqrt(1.0 - cos_i * cos_i), 0.0, cos_i); }
fn chi2_ggx_sample(u: vec3f, alpha: f32, cos_i: f32) -> vec4f {
  let s = bsdf_microfacet_ggx_sample(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, 1.0), chi2_ggx_wi(cos_i), alpha, ${METAL}, 1.0, u.xy);
  return vec4f(s.wo, f32(s.label != LABEL_NONE));
}
fn chi2_ggx_pdf(wo: vec3f, alpha: f32, cos_i: f32) -> f32 {
  return bsdf_microfacet_ggx_eval(vec3f(0.0, 0.0, 1.0), chi2_ggx_wi(cos_i), wo, alpha, ${METAL}, 1.0).pdf;
}
`;

test('端到端 χ²：闭包采样的出射方向分布与概率密度配对；故意不配对时检验不过', { timeout: 600_000 }, async t => {
  // 箱：θ 64 份 × φ 64 份；抛光那一头（alpha 0.02、0.03，波瓣宽一两度）θ、φ 各分 512 份，每箱内的积分点相应减少
  const groups = [
    { alphas: [0.05, 0.2, 0.5, 1], opts: {} },
    { alphas: [0.02, 0.03], opts: { nTheta: 512, nPhi: 512, sub: 4 } },
  ];
  const pairs = groups.reduce((n, g) => n + g.alphas.length * 3, 0);
  // Šidák 校正：配对的检验共 pairs 次，整体显著性 0.01
  const level = 1 - (1 - 0.01) ** (1 / pairs);
  for (const { alphas, opts } of groups) {
    const cases = alphas.flatMap(alpha => [1, 0.7, 0.26].flatMap(cosI => [
      { name: `alpha=${alpha} cosI=${cosI}`, sample: `chi2_ggx_sample(u, ${alpha}, ${cosI})`, pdf: `chi2_ggx_pdf(wo, ${alpha}, ${cosI})` },
      // 反例：采样用 alpha，概率密度用 1.1·alpha
      { name: `反例 alpha=${alpha} cosI=${cosI}`, bad: true, sample: `chi2_ggx_sample(u, ${alpha}, ${cosI})`, pdf: `chi2_ggx_pdf(wo, ${alpha * 1.1}, ${cosI})` },
    ]));
    const r = await gpuOnly(t, () => directionChi2({ source: shaderSource() + CHI2_HELPERS, cases, n: 1_000_000, seed: 1, ...opts }));
    if (!r) return;
    for (const c of r) {
      t.diagnostic(`${c.name}: χ²=${c.chi2.toFixed(1)} dof=${c.dof} p=${c.p.toExponential(3)} 被拒样本 ${c.lost.observed}（期望 ${c.lost.expected.toFixed(1)}）`);
      if (c.bad) assert.ok(c.p < level, `${c.name} 应当不过，p=${c.p}`);
      else assert.ok(c.p >= level, `${c.name} 不过：p=${c.p} < ${level}`);
    }
  }
});

test('端到端反照率：F0=1、B=0 时对出射半球积分求值结果，不超过 1.001；开能量补偿的读数一并记下', { timeout: 600_000 }, async t => {
  const cases = [];
  // 粗糙度从 0.1 起：更低时 Cycles 自己的 float32 求值在法线附近就不守恒（bsdf_D 的 1 − cos² 舍入），
  // 在本机用标准答案程序按同一套求积实测，粗糙度 0.05、正入射积出 1.015，见核对报告
  for (const roughness of [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
    for (const cosI of [1, 0.9, 0.7, 0.5, 0.3, 0.1, 0.05]) cases.push({ roughness, cosI, alpha: roughness_to_alpha(roughness) });
  }
  const eval_ = energy => `bsdf_microfacet_ggx_eval(N, wi, wo, alpha, vec3f(1.0), vec3f(0.0), ${energy}).eval.x`;
  const energy = 'microfacet_ggx_preserve_energy(N, wi, alpha, fresnel_f82_Fss(vec3f(1.0), vec3f(0.0))).energy_scale';
  const r = await gpuOnly(t, () => ggxAlbedo({ source: shaderSource(), cases: [...cases.map(c => ({ ...c, eval: eval_('1.0') })), ...cases.map(c => ({ ...c, eval: eval_(energy) }))], m: 1024 }));
  if (!r) return;
  const off = r.slice(0, cases.length), on = r.slice(cases.length);
  let maxOff = 0;
  cases.forEach((c, k) => {
    t.diagnostic(`roughness=${c.roughness} cosI=${c.cosI}: 关能量补偿 ${off[k].toFixed(5)}  开能量补偿 ${on[k].toFixed(5)}`);
    maxOff = Math.max(maxOff, off[k]);
    assert.ok(Number.isFinite(on[k]) && on[k] >= off[k], `${JSON.stringify(c)} 开补偿后反而变暗`);
  });
  t.diagnostic(`关能量补偿的最大反照率 ${maxOff.toFixed(6)}；开能量补偿最大 ${Math.max(...on).toFixed(6)}、最小 ${Math.min(...on).toFixed(6)}`);
  assert.ok(maxOff <= 1.001, `反照率 ${maxOff} 超过 1.001`);
});

/** Cycles 金属节点里 alpha = sqr(roughness)（kernel/svm/closure.h） */
function roughness_to_alpha(r) { return r * r; }

// 面光的检验几何：着色点在原点，灯心 co、灯面朝向 dir（朝着原点）、两边长。axis_u、axis_v 由 dir 补成正交基，
// 使 axis_u × axis_v = dir（与比对输入的约定相同）。灯都放在 +y 方向附近，远离 χ² 分箱的两极和 φ 的接缝
const v3 = { dot: dot3, cross: crs, norm: a => { const l = Math.hypot(...a); return a.map(x => x / l); }, sub: (a, b) => a.map((x, k) => x - b[k]) };
function rectLight({ co, dir, len_u, len_v }) {
  const n = v3.norm(dir);
  const axis_u = v3.norm(v3.cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], n));
  const axis_v = v3.cross(n, axis_u);
  const f = a => `vec3f(${a.map(x => x.toPrecision(9)).join(', ')})`;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => co.map((c, k) => c + a * len_u / 2 * axis_u[k] + b * len_v / 2 * axis_v[k]));
  return { co, axis_u, axis_v, n, len_u, len_v, corners, wgsl: `${f(co)}, ${f(axis_u)}, ${len_u}, ${f(axis_v)}, ${len_v}, ${f(n)}, ${1 / (len_u * len_v)}` };
}
const LIGHTS = {
  近处大灯: rectLight({ co: [0, 0.4, 0], dir: [0, -1, 0], len_u: 1.5, len_v: 1 }),
  远处小灯: rectLight({ co: [0.2, 6, -0.3], dir: [0, -1, 0], len_u: 0.6, len_v: 0.4 }),
  掠射: rectLight({ co: [0, 2, 0], dir: [1, -0.1, 0], len_u: 1, len_v: 1 }),
  斜向: rectLight({ co: [0.5, 1.5, 0.3], dir: [-0.6, -0.5, 0.4], len_u: 0.8, len_v: 1.3 }),
  // 立体角约 1e-6，走平面近似那一支
  极小灯: rectLight({ co: [0, 1, 0], dir: [0, -1, 0.2], len_u: 1e-3, len_v: 1e-3 }),
};
const LIGHT_HELPERS = `
// 采样方向打在灯面所在平面上的局部坐标 (x, y) ∈ [0, 1]²。采样点 P 与方向打到的点都要落在矩形内（局部坐标不超过半边长，
// 留 1e-5 的相对余量：随机数贴着 0、1 时采样点正好在边上，舍入一下就出界一点）；有一条不满足就记作被拒，测试要求被拒为 0
fn chi2_light_sample(u: vec3f, co: vec3f, axis_u: vec3f, len_u: f32, axis_v: vec3f, len_v: f32, dir: vec3f, invarea: f32) -> vec3f {
  let s = area_light_sample(u.xy, vec3f(0.0), co, axis_u, len_u, axis_v, len_v, dir, invarea);
  let q = s.P - co;
  let w = dot(co, dir) / dot(s.D, dir) * s.D - co;
  let x = dot(w, axis_u) / len_u;
  let y = dot(w, axis_v) / len_v;
  let m = 0.5 + 1e-5;
  let inside = abs(dot(q, axis_u)) <= m * len_u && abs(dot(q, axis_v)) <= m * len_v && abs(x) <= m && abs(y) <= m;
  return vec3f(x + 0.5, y + 0.5, f32(s.ok && inside));
}
// 灯面局部坐标 p 上的概率密度：立体角概率密度照 Cycles 在射线打中灯时的做法取（多重重要性采样那一侧用的就是它），
// 再乘上换到面积测度的 |cos|/t² 与灯面积。density_light 可以是另一盏灯（反例），p 始终是采样那盏灯的局部坐标
fn chi2_light_density(p: vec2f, co: vec3f, axis_u: vec3f, len_u: f32, axis_v: vec3f, len_v: f32, dir: vec3f, pdf_len_u: f32) -> f32 {
  let X = co + (p.x - 0.5) * len_u * axis_u + (p.y - 0.5) * len_v * axis_v;
  let t = length(X);
  let D = X / t;
  let pdf = area_light_eval_from_intersection(vec3f(0.0), D, t, co, axis_u, pdf_len_u, axis_v, len_v, dir, 1.0 / (pdf_len_u * len_v)).pdf;
  return pdf * abs(dot(D, dir)) / (t * t) * len_u * len_v;
}
fn irradiance_sample(u: vec3f, N: vec3f, co: vec3f, axis_u: vec3f, len_u: f32, axis_v: vec3f, len_v: f32, dir: vec3f, invarea: f32) -> f32 {
  let s = area_light_sample(u.xy, vec3f(0.0), co, axis_u, len_u, axis_v, len_v, dir, invarea);
  if (!s.ok) { return 0.0; }
  return max(dot(N, s.D), 0.0) / s.pdf;
}
`;

test('端到端 χ²：面光采样的方向分布与立体角概率密度配对，采样点都落在矩形内；故意不配对时检验不过', { timeout: 600_000 }, async t => {
  const names = ['近处大灯', '远处小灯', '掠射', '斜向', '极小灯'];
  const level = 1 - (1 - 0.01) ** (1 / names.length);
  const cases = names.flatMap(name => {
    const L = LIGHTS[name], geom = L.wgsl.split(', ').slice(0, -1).join(', ');
    return [
      { name, sample: `chi2_light_sample(u, ${L.wgsl})`, density: `chi2_light_density(p, ${geom}, ${L.len_u})` },
      // 反例：采样用这盏灯，概率密度用 axis_u 方向长 10% 的灯
      { name: `反例 ${name}`, bad: true, sample: `chi2_light_sample(u, ${L.wgsl})`, density: `chi2_light_density(p, ${geom}, ${L.len_u * 1.1})` },
      // 反例二：支撑集与归一化都不变，只把第二个随机数换成它的平方，分布沿 axis_v 变形
      { name: `反例（只变形） ${name}`, bad: true, sample: `chi2_light_sample(vec3f(u.x, u.y * u.y, u.z), ${L.wgsl})`, density: `chi2_light_density(p, ${geom}, ${L.len_u})` },
    ];
  });
  const r = await gpuOnly(t, () => gridChi2({ source: shaderSource() + LIGHT_HELPERS, cases, n: 1_000_000, seed: 1, nx: 64, ny: 64, sub: 8 }));
  if (!r) return;
  for (const c of r) {
    t.diagnostic(`${c.name}: χ²=${c.chi2.toFixed(1)} dof=${c.dof} p=${c.p.toExponential(3)} 被拒（打不中灯或采样点在矩形外）${c.lost.observed}（期望 ${c.lost.expected.toFixed(1)}）`);
    if (c.bad) { assert.ok(c.p < level, `${c.name} 应当不过，p=${c.p}`); continue; }
    assert.equal(c.lost.observed, 0, `${c.name} 有采样方向打不中灯或采样点落在矩形外`);
    // 极小灯只记读数、不断言分布：立体角约 1e-6 时 rand.x·S 掉到 g2 + g3 的最小浮点间隔以下，采样点在灯面上的位置
    // 由舍入和显卡 cos、sin 的精度决定（Cycles 本机一侧同样如此）。【实测】Apple 显卡 p = 0.44，NVIDIA 上点聚成几簇、p = 0。
    // 这么小的灯，点落在灯面哪里对方向的影响不到灯的张角；它的概率密度由平面近似一项逐组比，能量由数学裁判把关
    if (c.name === '极小灯') continue;
    assert.ok(c.p >= level, `${c.name} 不过：p=${c.p} < ${level}`);
  }
});

test('端到端数学裁判：均匀矩形面光照小面元，采样估计的辐照度对解析形状因子在 0.2% 以内（不依赖 Cycles）', { timeout: 600_000 }, async t => {
  const cases = [
    ['近处大灯', [0, 1, 0]], ['近处大灯', v3.norm([0.3, 1, 0.2])], ['远处小灯', [0, 1, 0]], ['掠射', [0, 1, 0]], ['斜向', v3.norm([0.4, 1, 0.1])], ['极小灯', [0, 1, 0]],
  ].map(([name, N]) => ({ name, N, exact: polygonIrradiance([0, 0, 0], N, LIGHTS[name].corners), expr: `irradiance_sample(u, vec3f(${N.join(', ')}), ${LIGHTS[name].wgsl})` }));
  const n = 2_000_000;
  const r = await gpuOnly(t, () => mcMean({ source: shaderSource() + LIGHT_HELPERS, cases, n, seed: 1 }));
  if (!r) return;
  cases.forEach((c, k) => {
    const rel = r[k].mean / c.exact - 1;
    t.diagnostic(`${c.name} N=[${c.N.map(x => x.toFixed(3))}]: 估计 ${r[k].mean.toExponential(6)} ± ${r[k].stderr.toExponential(2)}  解析 ${c.exact.toExponential(6)}  相对差 ${rel.toExponential(2)}`);
    assert.ok(Math.abs(rel) <= 2e-3, `${c.name} 相对差 ${rel}`);
    // 样本数给够：标准误差不到容差的四分之一
    assert.ok(r[k].stderr / c.exact < 5e-4, `${c.name} 标准误差 ${r[k].stderr}`);
  });
});

// ------------------------------------------------------------------------------------------------ 成像一路

test('端到端：成像一路故意改错一项，对应的函数报不过（查表、夹取改着色器；三种滤波改宿主一侧的 Rust）', { timeout: 900_000 }, async t => {
  const file = 'shaders/imaging.wgsl', src = await readFile(`${CORE}/${file}`, 'utf8');
  // 查表：插值的后一项读错成前一格，三张表的查表都不合格
  await breakOne(t, file, src, 'return (1.0 - t) * data0 + t * data1;', 'return (1.0 - t) * data0 + t * data0;', ['filter_table_read_box', 'filter_table_read_gaussian', 'filter_table_read_blackman_harris'], 1, 1);
  // 夹取：直接、间接按 bounce > 1 分（相机射线之后第一次弹射的直接光被当成间接光）
  await breakOne(t, file, src, 'select(sample_clamp_direct, sample_clamp_indirect, bounce > 0)', 'select(sample_clamp_direct, sample_clamp_indirect, bounce > 1)', ['film_clamp_light'], 6, 3);
  // 宿主一侧：三种滤波各改错一项，在源码的拷贝上改了再编（../chassis/build.mjs 的 inject，工作树不动）
  const pf = 'path/src/pixel_filter.rs';
  const inject = [
    // 盒式：建表前宽度多乘 1%（滤波函数本身恒为 1，错只出在表上）
    { file: pf, from: 'FilterType::Box => (filter_func_box, width),', to: 'FilterType::Box => (filter_func_box, width * 1.01),' },
    // 高斯：6/宽度写成 6.1/宽度
    { file: pf, from: 'let v = v * (6.0 / width);', to: 'let v = v * (6.1 / width);' },
    // Blackman-Harris：第二项的系数 0.48829 写成 0.48
    { file: pf, from: '0.35875 - 0.48829 * v.cos()', to: '0.35875 - 0.48 * v.cos()' },
  ];
  const r = await e2e(t, { names: NEW_IMAGING.slice(0, 6), n: 100_000, seed: 3, inject });
  if (!r) return;
  assert.deepEqual(r.results.filter(x => x.fails > 0).map(x => x.name), ['filter_func_gaussian', 'filter_func_blackman_harris', 'filter_table_box', 'filter_table_gaussian', 'filter_table_blackman_harris']);
});

// 像素滤波的采样分布：内核的查表（filter_table_read）查宿主一侧 Rust 建的表（与 Cycles 建的逐位相同，见 filter_table_* 三项），
// 样本是像素内的偏移 o（像素中心 0.5）。期望的分布是这张表本身给出的：表是分段线性的反函数，第 s 段（s = 0…1022）占随机数的
// 1/1023，在 [表[s], 表[s+1]] 上均匀；最后一格是 0（Cycles 建表时只写到倒数第二格），所以最后一段反着铺在 [0, 表[1022]] 上。
// 这里检验的是查表与这个分布配不配对。表本身与连续的滤波函数并不完全一样：对称的一支在半边累积分布为 1 的那一格跳到支撑的
// 端点，两头各有 1/1023 的随机数均匀铺在尾巴上，加上最后一段，一共约 0.3% 的样本不照滤波函数分布。【实测】高斯宽 1.5 的表
// 对连续的高斯，100 万个样本、64 箱的 χ² 期望是 2514（自由度约 55），所以不拿连续的滤波函数做这一项的期望。
// 偏移映射到 [0, 1]：x = (o − (0.5 − R)) / 2R（R 是支撑半宽：盒式 w/2，高斯 1.5w，Blackman-Harris w），y 是另一个均匀数
// （只为套 gridChi2），64×1 个箱。
const FILTER_R = [w => w / 2, w => 1.5 * w, w => w];
const FILTER_HELPERS = `
fn filter_chi2_sample(u: vec3f, offset: i32, R: f32) -> vec3f { return vec3f((filter_table_read(u.x, offset) - (0.5 - R)) / (2.0 * R), u.y, 1.0); }
// 表（从 offset 起）给出的偏移 o 处的概率密度（对 do）：单调的 1022 段二分找所在的段，加上反铺的最后一段
fn filter_table_density(o: f32, offset: i32) -> f32 {
  var d = 0.0;
  let last = filter_table_value(offset + 1022);
  if (o >= 0.0 && o <= last) { d += 1.0 / (1023.0 * last); }
  if (o < filter_table_value(offset) || o > last) { return d; }
  var lo = 0;
  var hi = 1022;
  while (hi - lo > 1) {
    let mid = (lo + hi) / 2;
    if (filter_table_value(offset + mid) <= o) { lo = mid; } else { hi = mid; }
  }
  let w = filter_table_value(offset + hi) - filter_table_value(offset + lo);
  if (w > 0.0) { d += 1.0 / (1023.0 * w); }
  return d;
}
fn filter_chi2_density(x: f32, offset: i32, R: f32) -> f32 { return filter_table_density((0.5 - R) + x * 2.0 * R, offset) * 2.0 * R; }
`;

test('端到端 χ²：像素滤波的查表（查宿主一侧建的表）给出的偏移照表的分布；宽度对不上、分布变形时检验不过', { timeout: 900_000 }, async t => {
  let tables;
  try {
    const bin = prebuiltRenderer();
    if (!bin) { t.skip('没有编好的渲染程序（设 BEIMING_FNCHECK_E2E=1 现编）'); return; }
    // 照 FILTER_TABLES 建的三张，再接上宽度各乘 1.1 的三张（反例的密度用）
    tables = Float32Array.from([...filterTables(bin, runHost), ...runHost(bin, 'filter_table', Float32Array.from(FILTER_TABLES.flatMap(([k, w]) => [k, w * 1.1])), 3 * 1024)]);
  } catch (e) {
    if (e.missing && !E2E) { t.skip(`缺工具链：${e.missing}`); return; }
    throw e;
  }
  const kinds = ['盒式', '高斯', 'Blackman-Harris'];
  const level = 1 - (1 - 0.01) ** (1 / kinds.length);
  const cases = kinds.flatMap((name, k) => {
    const R = FILTER_R[FILTER_TABLES[k][0]](FILTER_TABLES[k][1]), sample = `filter_chi2_sample(u, ${k * 1024}, ${R})`;
    return [
      { name, sample, density: `filter_chi2_density(p.x, ${k * 1024}, ${R})` },
      // 反例：密度用宽 1.1 倍的表
      { name: `反例（宽度） ${name}`, bad: true, sample, density: `filter_chi2_density(p.x, ${(3 + k) * 1024}, ${R})` },
      // 反例二：支撑集与归一化都不变，只把随机数换成它的平方
      { name: `反例（只变形） ${name}`, bad: true, sample: `filter_chi2_sample(vec3f(u.x * u.x, u.y, u.z), ${k * 1024}, ${R})`, density: `filter_chi2_density(p.x, ${k * 1024}, ${R})` },
    ];
  });
  const r = await gpuOnly(t, () => gridChi2({ source: shaderSource() + FILTER_HELPERS, cases, n: 1_000_000, seed: 1, nx: 64, ny: 1, sub: 64, filterTables: tables }));
  if (!r) return;
  for (const c of r) {
    t.diagnostic(`${c.name}: χ²=${c.chi2.toFixed(1)} dof=${c.dof} p=${c.p.toExponential(3)} 落在区间外 ${c.lost.observed}（期望 ${c.lost.expected.toFixed(1)}）`);
    if (c.bad) { assert.ok(c.p < level, `${c.name} 应当不过，p=${c.p}`); continue; }
    assert.ok(c.p >= level, `${c.name} 不过：p=${c.p} < ${level}`);
  }
});

// 原理化 BSDF 的电介质高光（GGX、广义 Schlick、只有反射；f0 取折射率 1.5 的 F0、f90 = 1、exponent = −1.5，照
// kernel/svm/closure.h 高光分支的默认值）与漫反射
const DIELECTRIC = (ior = 1.5) => `${ior}, vec3f(F0_from_ior(${ior})), vec3f(1.0), ${-ior}, vec3f(1.0), vec3f(0.0)`;
const PRINCIPLED_HELPERS = `
fn chi2_wi(cos_i: f32) -> vec3f { return vec3f(sqrt(1.0 - cos_i * cos_i), 0.0, cos_i); }
fn chi2_dielectric_sample(u: vec3f, alpha: f32, cos_i: f32) -> vec4f {
  let s = bsdf_microfacet_ggx_sample_generalized_schlick(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, 1.0), chi2_wi(cos_i), alpha, ${DIELECTRIC()}, 1.0, u.xy);
  return vec4f(s.wo, f32(s.label != LABEL_NONE));
}
fn chi2_dielectric_pdf(wo: vec3f, alpha: f32, cos_i: f32) -> f32 {
  return bsdf_microfacet_ggx_eval_generalized_schlick(vec3f(0.0, 0.0, 1.0), chi2_wi(cos_i), wo, alpha, ${DIELECTRIC()}, 1.0).pdf;
}
fn chi2_diffuse_sample(u: vec3f, N: vec3f) -> vec4f {
  let s = bsdf_diffuse_sample(N, N, u.xy);
  return vec4f(s.wo, f32(s.pdf > 0.0));
}
`;

test('端到端 χ²：电介质高光与漫反射的采样方向分布与概率密度配对；故意不配对时检验不过', { timeout: 600_000 }, async t => {
  const alphas = [0.05, 0.2, 0.5, 1];
  const normals = [[0, 0, 1], [0.3, -0.5, 0.812404]];
  const pairs = alphas.length * 3 + normals.length;
  const level = 1 - (1 - 0.01) ** (1 / pairs);
  const cases = [
    ...alphas.flatMap(alpha => [1, 0.7, 0.26].flatMap(cosI => [
      { name: `电介质 alpha=${alpha} cosI=${cosI}`, sample: `chi2_dielectric_sample(u, ${alpha}, ${cosI})`, pdf: `chi2_dielectric_pdf(wo, ${alpha}, ${cosI})` },
      { name: `反例 电介质 alpha=${alpha} cosI=${cosI}`, bad: true, sample: `chi2_dielectric_sample(u, ${alpha}, ${cosI})`, pdf: `chi2_dielectric_pdf(wo, ${alpha * 1.1}, ${cosI})` },
    ])),
    ...normals.flatMap(N => [
      { name: `漫反射 N=[${N}]`, sample: `chi2_diffuse_sample(u, vec3f(${N.join(', ')}))`, pdf: `bsdf_diffuse_eval(vec3f(${N.join(', ')}), wo).pdf` },
      // 反例：概率密度按 cos^1.1 归一化前的形状给，分布形状与采样对不上
      { name: `反例 漫反射 N=[${N}]`, bad: true, sample: `chi2_diffuse_sample(u, vec3f(${N.join(', ')}))`, pdf: `pow(bsdf_diffuse_eval(vec3f(${N.join(', ')}), wo).pdf * M_PI_F, 1.1) * 2.1 / (2.0 * M_PI_F)` },
    ]),
  ];
  const r = await gpuOnly(t, () => directionChi2({ source: shaderSource() + PRINCIPLED_HELPERS, cases, n: 1_000_000, seed: 1 }));
  if (!r) return;
  for (const c of r) {
    t.diagnostic(`${c.name}: χ²=${c.chi2.toFixed(1)} dof=${c.dof} p=${c.p.toExponential(3)} 被拒样本 ${c.lost.observed}（期望 ${c.lost.expected.toFixed(1)}）`);
    if (c.bad) assert.ok(c.p < level, `${c.name} 应当不过，p=${c.p}`);
    else assert.ok(c.p >= level, `${c.name} 不过：p=${c.p} < ${level}`);
  }
});

test('端到端反照率：电介质高光（关能量补偿）与漫反射对出射半球积分不超过 1.001', { timeout: 600_000 }, async t => {
  const cases = [];
  // 粗糙度从 0.1 起，理由同金属那一项
  for (const roughness of [0.1, 0.2, 0.3, 0.5, 0.7, 1]) {
    for (const cosI of [1, 0.7, 0.3, 0.1, 0.05]) {
      // f0 = f90 = 1：反射率恒为 1，是这个闭包反照率的上界（折射率只经 s 插在 f0 与 f90 之间，这里不起作用）
      cases.push({ name: '电介质 f0=f90=1', roughness, cosI, alpha: roughness_to_alpha(roughness), eval: `bsdf_microfacet_ggx_eval_generalized_schlick(N, wi, wo, alpha, 1.5, vec3f(1.0), vec3f(1.0), -1.5, vec3f(1.0), vec3f(0.0), 1.0).eval.x` });
    }
  }
  // 漫反射：alpha 只决定求积用的半向量分布（取 1，盖住整个半球）
  for (const cosI of [1, 0.5, 0.05]) cases.push({ name: '漫反射', roughness: 1, cosI, alpha: 1, eval: 'bsdf_diffuse_eval(N, wo).eval.x' });
  const r = await gpuOnly(t, () => ggxAlbedo({ source: shaderSource(), cases, m: 1024 }));
  if (!r) return;
  let max = 0;
  cases.forEach((c, k) => {
    t.diagnostic(`${c.name} roughness=${c.roughness} cosI=${c.cosI}: 反照率 ${r[k].toFixed(6)}`);
    max = Math.max(max, r[k]);
    assert.ok(r[k] <= 1.001, `${c.name} ${JSON.stringify(c)} 反照率 ${r[k]} 超过 1.001`);
  });
  // 漫反射的积分该是 1：求积本身准不准也在这里看
  cases.forEach((c, k) => { if (c.name === '漫反射') assert.ok(Math.abs(r[k] - 1) < 1e-3, `漫反射 cosI=${c.cosI} 积出 ${r[k]}`); });
  t.diagnostic(`最大反照率 ${max.toFixed(6)}`);
});

test('端到端互易：电介质高光与漫反射交换两个方向，BSDF 的相对差不超过 1e-4；故意不互易时检验不过', { timeout: 600_000 }, async t => {
  const cases = [
    ...[0.1, 0.3, 0.6, 1].map(roughness => ({ name: `电介质 粗糙度 ${roughness}`, eval: `bsdf_microfacet_eval_ggx_generalized_schlick(N, wi, wo, ${roughness_to_alpha(roughness)}, ${DIELECTRIC()}).eval.x` })),
    { name: '漫反射', eval: 'bsdf_diffuse_eval(N, wo).eval.x' },
    // 反例：能量补偿的倍率随入射方向变（microfacet_ggx_preserve_energy 按入射余弦查表），乘上它就不互易
    { name: '反例 电介质乘入射方向的能量补偿', bad: true, eval: `bsdf_microfacet_eval_ggx_generalized_schlick(N, wi, wo, 0.25, ${DIELECTRIC()}).eval.x * microfacet_ggx_preserve_energy(N, wi, 0.25, vec3f(1.0)).energy_scale` },
  ];
  const r = await gpuOnly(t, () => reciprocity({ source: shaderSource(), cases, n: 1_000_000, seed: 1 }));
  if (!r) return;
  for (const c of r) {
    t.diagnostic(`${c.name}: 最大相对差 ${c.maxRel.toExponential(3)}（参与比较 ${c.counted} 组，最差一组 cos 与两边的值 [${c.worst}]）`);
    if (c.bad) assert.ok(c.maxRel > 1e-4, `${c.name} 应当不互易`);
    else { assert.ok(c.maxRel <= 1e-4, `${c.name} 相对差 ${c.maxRel}`); assert.ok(c.counted > 900_000, c.name); }
  }
});
