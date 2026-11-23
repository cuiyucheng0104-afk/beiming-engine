// 函数级比对外壳的测试。纯逻辑部分任何机器都跑；端到端部分要编得出 Cycles、拿得到硬件 WebGPU 适配器，
// 缺了就跳过并写明缺什么；BEIMING_FNCHECK_E2E=1 时缺工具链算失败。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compare } from './compare.mjs';
import { FUNCTIONS, width } from './registry.mjs';
import { WGSL_FILE, check, makeInputs } from './run.mjs';

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

test('登记表里每个函数在 WGSL 文件和标准答案程序里都有，参数个数对得上', async () => {
  const wgsl = await readFile(WGSL_FILE, 'utf8');
  const cpp = await readFile(new URL('./cycles/ref.cpp', import.meta.url), 'utf8');
  assert.ok(FUNCTIONS.length >= 10);
  for (const f of FUNCTIONS) {
    const m = wgsl.match(new RegExp(`\\nfn ${f.wgsl}\\(([^)]*)\\)`));
    assert.ok(m, `microfacet.wgsl 里没有 fn ${f.wgsl}`);
    assert.equal(m[1].split(',').filter(s => s.trim()).length, f.inputs.length, f.name);
    assert.ok(cpp.includes(`{"${f.ref}", ${width(f)}, ${f.out},`), `ref.cpp 里没有 ${f.ref}（${width(f)} 进 ${f.out} 出）`);
    for (const [lo, hi] of f.inputs.flatMap(([, , r]) => (Array.isArray(r[0]) ? r : [r]))) assert.ok(Number.isFinite(lo) && Number.isFinite(hi) && lo < hi, f.name);
    assert.ok(f.rel <= 1e-4 && f.abs >= 0, f.name);
  }
});

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
    t.diagnostic(`${r.name}: groups=${r.groups} maxRel=${r.maxRel.toExponential(3)} maxRelNonTiny=${r.maxRelNonTiny.toExponential(3)} abs=${r.abs.toExponential(2)} fails=${r.fails} nonFinite=${r.nonFinite}`);
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
  const src = await readFile(WGSL_FILE, 'utf8');
  const broken = src.replace('B * (1.0 / 126.0)', 'B * (1.0 / 125.0)');
  assert.notEqual(broken, src, '要改的那一项在 WGSL 里找不到了');
  const r = await e2e(t, { n: 100_000, seed: 3, wgsl: broken });
  if (!r) return;
  assert.equal(r.ok, false);
  const bad = r.results.filter(x => x.fails > 0).map(x => x.name);
  assert.deepEqual(bad, ['fresnel_f82_Fss']);
  const w = r.results.find(x => x.name === 'fresnel_f82_Fss').worst[0];
  assert.ok(Number.isInteger(w.index) && w.input.length === 6 && w.ref.length === 3 && w.test.length === 3);
  assert.ok(w.relErr > 1e-4);
});
