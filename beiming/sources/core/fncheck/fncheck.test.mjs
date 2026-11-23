// 函数级比对外壳的测试。纯逻辑部分任何机器都跑；端到端部分要编得出 Cycles、拿得到硬件 WebGPU 适配器，
// 缺了就跳过并写明缺什么；BEIMING_FNCHECK_E2E=1 时缺工具链算失败。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chi2Test, directionChi2, gammaQ, ggxAlbedo } from './checks.mjs';
import { compare } from './compare.mjs';
import { FUNCTIONS, outWidth, width } from './registry.mjs';
import { CORE, check, makeInputs, shaderSource } from './run.mjs';

const E2E = process.env.BEIMING_FNCHECK_E2E === '1';
const byName = name => FUNCTIONS.find(f => f.name === name);

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
  const cpp = await readFile(new URL('./cycles/ref.cpp', import.meta.url), 'utf8');
  for (const name of NEW) assert.ok(byName(name), `登记表里没有 ${name}`);
  for (const f of FUNCTIONS) {
    const wgsl = await readFile(`${CORE}/${f.file}`, 'utf8');
    const m = wgsl.match(new RegExp(`\\nfn ${f.wgsl}\\(([^)]*)\\)`));
    assert.ok(m, `${f.file} 里没有 fn ${f.wgsl}`);
    // 有 call 的项由它拼出调用（补常量实参），参数个数不必与输入个数相同
    if (!f.call) assert.equal(m[1].split(',').filter(s => s.trim()).length, f.inputs.length, f.name);
    assert.ok(cpp.includes(`{"${f.ref}", ${width(f)}, ${outWidth(f)},`), `ref.cpp 里没有 ${f.ref}（${width(f)} 进 ${outWidth(f)} 出）`);
    for (const [, type, r] of f.inputs) {
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
    t.diagnostic(`${r.name}: groups=${r.groups} maxRel=${r.maxRel.toExponential(3)} maxRelNonTiny=${r.maxRelNonTiny.toExponential(3)} abs=${r.abs.toExponential(2)} fails=${r.fails} nonFinite=${r.nonFinite} 标准全零的组=${(r.zeroRef / r.groups * 100).toFixed(2)}% 不比的组=${(r.skipped / r.groups * 100).toFixed(3)}% 所需abs=${r.needAbs.toExponential(2)}`);
    // 实测差值要在 abs 的一半以内
    assert.ok(r.needAbs <= r.abs / 2, `${r.name} 所需 abs ${r.needAbs} 超过登记的 abs 的一半`);
    assert.equal(r.groups, 1_000_000, r.name);
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
    const broken = src.replace(from, to);
    assert.notEqual(broken, src, `要改的那一项在 WGSL 里找不到了：${from}`);
    const r = await e2e(t, { n: 100_000, seed: 3, wgsl: { [file]: broken } });
    if (!r) return;
    assert.equal(r.ok, false);
    assert.deepEqual(r.results.filter(x => x.fails > 0).map(x => x.name), expect);
    const w = r.results.find(x => x.name === expect[0]).worst[0];
    t.diagnostic(`${expect[0]} 最差一组：下标 ${w.index} 输入 [${w.input}] 标准 [${w.ref}] 被测 [${w.test}] 相对误差 ${w.relErr}`);
    assert.ok(Number.isInteger(w.index) && w.input.length === nIn && w.ref.length === nOut && w.test.length === nOut);
    assert.ok(w.relErr > 1e-4);
  }
});

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
