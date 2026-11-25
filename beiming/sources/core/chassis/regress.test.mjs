// 回归基线工具（regress.mjs）的测试：比较规则是纯逻辑，任何机器都跑；仓库里已记的基线文件逐个查形状。
// 真去渲一遍（--record、--check）要显卡和几分钟，不放在这里。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { COMMIT } from './build.mjs';
import { BASELINES, OUTPUT_ONLY, baselineName, compare, tally } from './regress.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const sample = () => ({
  gpu: { adapter: 'Some GPU', backend: 'Vulkan', driver: '1.0' },
  level2: { '白炉 GGX 0.50': 0.8900307556820743, '面光 正对': 0.36325430814758874 },
  upstream: {
    sw: { unstable: [], scenes: { 'furnace/diffuse': `pass ${A}`, 'cache/corner-live': 'unsupported', 'particles/burst': 'fail' } },
    hw: { unstable: ['procedural/shadow'], scenes: { 'furnace/diffuse': `pass ${A}`, 'procedural/shadow': 'pass' } },
  },
  cargo: { passed: 86, failed: 0, ignored: 1, failures: [] },
  perf: { firstFrameMs: 1000, steadyS: 2 },
});

test('基线文件名：显卡名加后端，小写，别的字符换成连字符', () => {
  assert.equal(baselineName({ adapter: 'Apple M5 Pro', backend: 'Metal' }), 'apple-m5-pro-metal.json');
  assert.equal(baselineName({ adapter: 'NVIDIA GeForce RTX 5090', backend: 'Vulkan' }), 'nvidia-geforce-rtx-5090-vulkan.json');
});

test('比较：全同没有不同；读数差一个末位、稳定场景的输出变了、状态变了、少了场景都算不同', () => {
  assert.deepEqual(compare(sample(), sample()), { diffs: [], warnings: [] });
  const expectDiff = (change, pattern) => {
    const now = sample();
    change(now);
    const { diffs } = compare(sample(), now);
    assert.equal(diffs.length, 1, diffs.join('\n'));
    assert.match(diffs[0], pattern);
  };
  expectDiff(n => { n.level2['白炉 GGX 0.50'] *= 1 + Number.EPSILON; }, /读数「白炉 GGX 0\.50」.*相对差/);
  expectDiff(n => { delete n.level2['面光 正对']; }, /读数「面光 正对」/);
  expectDiff(n => { n.upstream.sw.scenes['furnace/diffuse'] = `pass ${B}`; }, /furnace\/diffuse（软件求交）：状态都是 pass，原始输出不同/);
  expectDiff(n => { n.upstream.hw.scenes['furnace/diffuse'] = `fail ${A}`; }, /furnace\/diffuse（硬件求交）：状态 pass → fail/);
  expectDiff(n => { n.upstream.sw.scenes['cache/corner-live'] = `pass ${A}`; }, /cache\/corner-live（软件求交）：状态 unsupported → pass/);
  expectDiff(n => { delete n.upstream.sw.scenes['particles/burst']; }, /particles\/burst（软件求交）：状态 fail → 没有这个场景/);
  expectDiff(n => { n.upstream.hw = null; }, /硬件求交.*基线有、这次没跑/);
});

test('比较：登记为不稳定的场景只比状态', () => {
  const now = sample();
  now.upstream.hw.scenes['procedural/shadow'] = `pass ${B}`; // 这次跑出来带着摘要，基线里只有状态
  assert.deepEqual(compare(sample(), now).diffs, []);
  now.upstream.hw.scenes['procedural/shadow'] = `fail ${B}`;
  assert.match(compare(sample(), now).diffs[0], /procedural\/shadow（硬件求交）：状态 pass → fail/);
});

test('比较：登记为只比原始输出的场景不比状态，原始输出变了照样算不同', () => {
  const id = Object.keys(OUTPUT_ONLY)[0];
  const base = sample(), now = sample();
  base.upstream.sw.scenes[id] = 'pass aaaa';
  now.upstream.sw.scenes[id] = 'fail aaaa';
  assert.deepEqual(compare(base, now).diffs, []);
  now.upstream.sw.scenes[id] = 'fail bbbb';
  assert.equal(compare(base, now).diffs.length, 1);
});

test('比较：cargo test 有失败或通过数变少算不同，变多只提示；计时慢 10% 以上与驱动变了只提示', () => {
  const run = change => {
    const now = sample();
    change(now);
    return compare(sample(), now);
  };
  assert.match(run(n => { n.cargo = { passed: 85, failed: 1, ignored: 1, failures: ['gpu::tests::x'] }; }).diffs.join('\n'), /1 个失败（gpu::tests::x）[\s\S]*通过数 86 → 85/);
  assert.deepEqual(run(n => { n.cargo.passed = 90; }), { diffs: [], warnings: ['cargo test：通过数 86 → 90（多了测试）'] });
  assert.deepEqual(run(n => { n.perf.steadyS = 2.19; n.perf.firstFrameMs = 1099; }), { diffs: [], warnings: [] });
  const slow = run(n => { n.perf.steadyS = 2.3; n.perf.firstFrameMs = 1500; n.gpu.driver = '2.0'; });
  assert.deepEqual(slow.diffs, []);
  assert.equal(slow.warnings.length, 3);
  assert.match(slow.warnings[0], /稳态变慢.*\+15\.0%/);
});

test('各类场景的个数', () => {
  assert.deepEqual(tally(sample()), {
    sw: { scenes: 3, pass: 1, unsupported: 1, fail: 1, withOutput: 1, unstable: 0 },
    hw: { scenes: 2, pass: 2, withOutput: 2, unstable: 1 },
  });
});

test('仓库里的基线：文件名对得上显卡，24 个读数，两种求交的场景一样多，不稳定的场景只留状态，体积小，不含本机信息', () => {
  const files = fs.existsSync(BASELINES) ? fs.readdirSync(BASELINES).filter(f => f.endsWith('.json')) : [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(BASELINES, f), 'utf8'), b = JSON.parse(text);
    assert.equal(f, baselineName(b.gpu));
    assert.equal(b.upstreamCommit, COMMIT);
    assert.equal(Object.keys(b.level2).length, 24);
    assert.ok(Object.values(b.level2).every(v => Number.isFinite(v) && v > 0));
    const modes = Object.values(b.upstream).filter(Boolean);
    assert.ok(modes.length >= 1);
    for (const u of modes) {
      assert.equal(Object.keys(u.scenes).length, Object.keys(b.upstream.sw.scenes).length);
      for (const s of Object.values(u.scenes)) assert.match(s, /^(pass|fail|unsupported)( [0-9a-f]{64})?$/);
      for (const id of u.unstable) assert.match(u.scenes[id], /^(pass|fail)$/);
    }
    assert.equal(b.cargo.failed, 0);
    assert.ok(b.perf.firstFrameMs > 0 && b.perf.steadyS > 0);
    assert.ok(text.length < 64 * 1024, `${f} 有 ${text.length} 字节`);
    assert.doesNotMatch(text, /\/Users\/|\/home\/|[A-Z]:\\|192\.168\./);
  }
});
