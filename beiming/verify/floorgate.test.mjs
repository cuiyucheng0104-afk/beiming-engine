// 「噪声地板乘 k」的门与合并门的测试。合并门的每条拦截各在临时仓库里造一份故意做错的提交。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checks } from '../kernel/contracts/ref-pack/check.mjs';
import { CYCLES, GATES as LEVEL2_GATES, PRINCIPLED, PRINCIPLED_F0 } from '../sources/core/chassis/level2.mjs';
import { CLAMP_CASES, KNIFE_CASES, NEGATIVE } from '../sources/core/chassis/imaging.mjs';
import { FUNCTIONS } from '../sources/core/fncheck/registry.mjs';
import { THRESHOLDS, floorGate, welchGate } from './floorgate.mjs';
import { LEVEL2, PROTECTED, REGRESS_SET, SIGNOFFS, defaultBase, guard, level2Gates } from './floorguard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '../..');
const example = JSON.parse(fs.readFileSync(path.join(HERE, '../kernel/contracts/ref-pack/examples/full.json'), 'utf8'));
const withFloor = (floor) => ({ ...example, floor: { ...example.floor, ...floor } });
const contractProblems = (pack, judgings) => ['RP3', 'RP4'].flatMap((id) => checks[id]({ format: 'ref-pack-check/0.1', pack, judgings }));

test('阈值文件：k = 1.25，Welch α = 1%、每边 16 个种子；第 2 级的数学门和 level2.mjs 的 GATES 整个相同', () => {
  assert.equal(THRESHOLDS.k, 1.25);
  assert.equal(THRESHOLDS.floorMetric, 'seedVsSeedFlipMean');
  assert.deepEqual(THRESHOLDS.welch, { alpha: 0.01, seeds: 16, blockSize: 8, equivalence: 2 ** -22 });
  assert.deepEqual(THRESHOLDS.floorLevels, [3, 4, 5, 7]);
  assert.deepEqual(THRESHOLDS.math.level2, { ...LEVEL2_GATES });
  // 合并门从源码里抠出来的和模块导出的一样
  assert.deepEqual(level2Gates(fs.readFileSync(path.join(REPO, LEVEL2), 'utf8')), { ...LEVEL2_GATES });
});

test('门：差不超过 k × 地板判过（等于也算过），超过判不过；产出的 judging 过参考包契约 RP3、RP4', () => {
  const pack = withFloor({ seedVsSeedFlipMean: 0.02 });
  const at = floorGate({ pack, value: 0.02 * 1.25 });
  assert.equal(at.status, 'pass');
  assert.equal(at.threshold, 0.02 * 1.25);
  assert.deepEqual(at.judging, { metric: 'seedVsSeedFlipMean', k: 1.25, threshold: 0.02 * 1.25 });
  assert.equal(floorGate({ pack, value: 0.0251 }).status, 'fail');
  assert.equal(floorGate({ pack, value: 0 }).status, 'pass');
  assert.deepEqual(contractProblems(pack, [at.judging]), []);
  // 负对照：门值写死成别的数，RP4 认得出
  assert.equal(contractProblems(pack, [{ ...at.judging, threshold: 0.03 }]).length, 1);
});

test('门：floor 缺段、缺键或任一项为 null，判未定线、不判过、不产出 judging；这样的包配上 judging 会被 RP3 拦下', () => {
  for (const key of ['rerunBitExact', 'seedVsSeedPsnr', 'seedVsSeedFlipMean']) {
    const pack = withFloor({ [key]: null });
    const r = floorGate({ pack, value: 0 });
    assert.equal(r.status, 'unset', key);
    assert.equal(r.judging, undefined);
    assert.match(r.reason, new RegExp(key));
    // 负对照：floor 有 null 的包还是拿去判了，RP3 认得出
    assert.equal(contractProblems(pack, [{ metric: 'seedVsSeedFlipMean', k: 1.25, threshold: 0.025 }]).length, 1);
  }
  const { seedVsSeedPsnr: _drop, ...rest } = example.floor;
  assert.equal(floorGate({ pack: { ...example, floor: rest }, value: 0 }).status, 'unset');
  assert.equal(floorGate({ pack: { ...example, floor: undefined }, value: 0 }).status, 'unset');
  assert.equal(floorGate({ pack: {}, value: 0 }).status, 'unset');
});

test('门：k、量都只认阈值文件，调用方传不进来；坏的读数、坏的地板拒收', () => {
  const pack = withFloor({ seedVsSeedFlipMean: 0.02 });
  assert.equal(floorGate({ pack, value: 0.1, k: 5, metric: 'seedVsSeedPsnr' }).status, 'fail');
  for (const value of [-0.1, 1.5, NaN, Infinity, undefined, '0.01']) assert.throws(() => floorGate({ pack, value }), /value 须为/);
  for (const f of [0, 1.5, -1, '0.02']) assert.throws(() => floorGate({ pack: withFloor({ seedVsSeedFlipMean: f }), value: 0 }), /floor\.seedVsSeedFlipMean 须为/);
  assert.throws(() => THRESHOLDS.k = 5, TypeError);
  assert.throws(() => THRESHOLDS.welch.alpha = 0.5, TypeError);
  assert.throws(() => THRESHOLDS.math.level2.furnaceRel = 1, TypeError);
});

test('Welch 门：每边必须正好 16 个种子，α 取阈值文件里的 1%', () => {
  const frame = (v) => ({ width: 8, height: 8, data: Float32Array.from({ length: 64 }, (_, i) => v + ((i * 7919) % 13) / 1000) });
  const seeds = (n, off) => Array.from({ length: n }, (_, s) => frame(off + s / 100));
  assert.throws(() => welchGate(seeds(8, 0), seeds(8, 0)), /正好 16 个/);
  assert.equal(welchGate(seeds(16, 0), seeds(16, 0)).alpha, 0.01);
  assert.equal(welchGate(seeds(16, 0), seeds(16, 0)).equivalence, 2 ** -22, '等价下限照阈值文件传给 Welch');
});

test('回归集：登记的条数不大于代码里现在的条数；runner 都在（没登记条数的项删案例这里看不出来）', () => {
  const items = JSON.parse(fs.readFileSync(path.join(REPO, REGRESS_SET), 'utf8')).items;
  const actual = {
    'level1.fncheck': FUNCTIONS.length,
    'level2.furnace-metal': Object.keys(CYCLES.GGX).length + Object.keys(CYCLES.MULTI_GGX).length,
    'level2.furnace-principled': Object.keys(PRINCIPLED.readings).length,
    'level2.furnace-principled-f0': Object.keys(PRINCIPLED_F0.readings).length,
    'level2.imaging-knife': KNIFE_CASES.length,
    'level2.imaging-clamp': Object.keys(CLAMP_CASES).length,
    'level2.imaging-negative': NEGATIVE.length,
  };
  for (const it of items) {
    assert.ok(fs.existsSync(path.join(REPO, it.runner)), `${it.id} 的 runner ${it.runner} 不在`);
    if (it.count === undefined) continue;
    assert.ok(Object.hasOwn(actual, it.id), `${it.id} 登记了条数，测试里要有对应的实际条数`);
    assert.ok(it.count <= actual[it.id], `${it.id} 登记 ${it.count} 条，代码里只剩 ${actual[it.id]} 条`);
  }
});

test('基准：BEIMING_FLOORGATE_BASE 优先，全零的提交号（推新分支时 GitHub 给的）当没给', () => {
  assert.equal(defaultBase({}), 'origin/main');
  assert.equal(defaultBase({ BEIMING_FLOORGATE_BASE: 'abc123' }), 'abc123');
  assert.equal(defaultBase({ BEIMING_FLOORGATE_BASE: '0000000000000000000000000000000000000000' }), 'origin/main');
});

// ───────────────────────── 合并门：临时仓库 ─────────────────────────

const sha = (s) => createHash('sha256').update(s).digest('hex');
function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const put = (root, p, text) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); };
const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
const ITEMS = [{ id: 'a', level: 1, runner: 'x' }, { id: 'b', level: 2, runner: 'y', count: 3 }];
const SIGN = { path: 'p', from: 'f', to: 't', change: '例', readingsSeen: '无', signer: '红队', review: 'r1' };
const THRESH = { format: 'beiming.verify.floor-gate/1', k: 1.25, math: { level2: { furnaceRel: 0.005, analyticRel: 0.002 } } };
const L2 = 'export const GATES = { furnaceRel: 5e-3, analyticRel: 2e-3 };\n';
const signoffs = (entries) => json({ format: 'beiming.verify.signoffs/1', entries });
const regress = (items) => json({ format: 'beiming.verify.regress-set/1', items });

function repo(t, { omit = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floorguard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  sh(root, 'init', '-q', '-b', 'main');
  const files = {
    [PROTECTED[0]]: json(THRESH), [PROTECTED[1]]: '闸\n', [PROTECTED[2]]: '// 门\n',
    [PROTECTED[3]]: fs.readFileSync(path.join(HERE, 'floorguard.mjs'), 'utf8'),
    [LEVEL2]: L2, [REGRESS_SET]: regress(ITEMS), [SIGNOFFS]: signoffs([SIGN]),
  };
  for (const [p, text] of Object.entries(files)) if (!omit.includes(p)) put(root, p, text);
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'base');
  sh(root, 'checkout', '-q', '-b', 'pr');
  return root;
}
const problems = (root) => guard({ root, base: 'main' }).problems;
const signFor = (root, p, after, extra = []) => {
  const before = spawnSync('git', ['show', `main:${p}`], { cwd: root, encoding: 'utf8' }).stdout;
  put(root, p, after);
  return { ...SIGN, path: p, from: sha(before), to: sha(after), review: `r-${extra.length}` };
};

test('合并门：什么都没改，过；只往回归集和签字记录里加，过', (t) => {
  const root = repo(t);
  assert.deepEqual(problems(root), []);
  put(root, REGRESS_SET, regress([...ITEMS, { id: 'c', level: 3, runner: 'z' }]));
  put(root, SIGNOFFS, signoffs([SIGN, { ...SIGN, review: 'r2' }]));
  assert.deepEqual(problems(root), []);
});

test('合并门：改阈值（把 k 改大）没签字被拦；新签字对上前后哈希才过；签完再改一笔、哈希不对，照拦', (t) => {
  const root = repo(t);
  const p = PROTECTED[0];
  const entry = signFor(root, p, json({ ...THRESH, k: 5 }));
  assert.match(problems(root).join('\n'), /floor-gate\.json 改了，没有对得上的签字/);
  put(root, SIGNOFFS, signoffs([SIGN, { ...entry, to: sha('别的内容') }]));
  assert.equal(problems(root).length, 1);
  put(root, SIGNOFFS, signoffs([SIGN, entry]));
  assert.deepEqual(problems(root), []);
  put(root, p, json({ ...THRESH, k: 6 }));
  assert.equal(problems(root).length, 1);
});

test('合并门：旧签字不能重放——基准上已有的签字对得上这次的改动也不算', (t) => {
  const root = repo(t);
  const p = PROTECTED[0];
  const entry = signFor(root, p, json({ ...THRESH, k: 5 }));
  put(root, SIGNOFFS, signoffs([SIGN, entry]));
  sh(root, 'commit', '-q', '-am', 'k=5 signed');
  sh(root, 'checkout', '-q', 'main');
  sh(root, 'merge', '-q', '--no-ff', '-m', 'm1', 'pr');
  // 回到 1.25（签字），再改回 5，只拿上一轮的签字
  sh(root, 'checkout', '-q', '-b', 'pr2');
  const back = signFor(root, p, json(THRESH));
  put(root, SIGNOFFS, signoffs([SIGN, entry, back]));
  sh(root, 'commit', '-q', '-am', 'back');
  sh(root, 'checkout', '-q', 'main');
  sh(root, 'merge', '-q', '--no-ff', '-m', 'm2', 'pr2');
  sh(root, 'checkout', '-q', '-b', 'pr3');
  put(root, p, json({ ...THRESH, k: 5 }));
  assert.match(problems(root).join('\n'), /floor-gate\.json 改了，没有对得上的签字/);
});

test('合并门：改 GATES.md、改门、改合并门自己、删受保护文件，没签字都被拦；提交过的改动也查', (t) => {
  const root = repo(t);
  put(root, PROTECTED[1], '改了闸\n');
  put(root, PROTECTED[2], '// 改了门\n');
  sh(root, 'commit', '-q', '-am', 'edit');
  put(root, PROTECTED[3], `${read(root, PROTECTED[3])}// 改\n`);
  fs.rmSync(path.join(root, PROTECTED[0]));
  const got = problems(root).join('\n');
  for (const p of PROTECTED) assert.match(got, new RegExp(`${p.replace(/[.]/g, '\\.')} 改了`), p);
  assert.match(got, /floor-gate\.json 改了.*to=deleted/);
});

test('合并门：受保护文件第一次加进来不要签字；受保护的路径换成符号链接被拦', { skip: process.platform === 'win32' && '要建符号链接' }, (t) => {
  const root = repo(t, { omit: [PROTECTED[1]] });
  put(root, PROTECTED[1], '新写的闸\n');
  assert.deepEqual(problems(root), []);
  const p = PROTECTED[2];
  fs.renameSync(path.join(root, p), path.join(root, 'elsewhere.mjs'));
  fs.symlinkSync(path.join(root, 'elsewhere.mjs'), path.join(root, p));
  assert.match(problems(root).join('\n'), /floorgate\.mjs 不是普通文件/);
});

test('合并门：回归集删一项、改一项、用重复 id 盖住改动、整个删掉，都被拦', (t) => {
  const root = repo(t);
  put(root, REGRESS_SET, regress([ITEMS[0]]));
  assert.match(problems(root).join('\n'), /回归集删了 b/);
  put(root, REGRESS_SET, regress([ITEMS[0], { ...ITEMS[1], count: 2 }]));
  assert.match(problems(root).join('\n'), /回归集改了 b/);
  put(root, REGRESS_SET, regress([ITEMS[0], { ...ITEMS[1], count: 2 }, ITEMS[1]]));
  assert.match(problems(root).join('\n'), /b 出现了不止一次/);
  fs.rmSync(path.join(root, REGRESS_SET));
  assert.match(problems(root).join('\n'), /regress-set\.json 被删了/);
});

test('合并门：签字记录删改旧条目、新条目缺字段，都被拦', (t) => {
  const root = repo(t);
  put(root, SIGNOFFS, signoffs([{ ...SIGN, signer: '别人' }]));
  assert.match(problems(root).join('\n'), /第 1 条被删或被改了/);
  put(root, SIGNOFFS, signoffs([]));
  assert.match(problems(root).join('\n'), /第 1 条被删或被改了/);
  put(root, SIGNOFFS, signoffs([SIGN, { ...SIGN, readingsSeen: ' ' }]));
  assert.match(problems(root).join('\n'), /第 2 条缺 readingsSeen/);
});

test('合并门：第 2 级的门在 level2.mjs 里放宽、或改得认不出，都被拦', (t) => {
  const root = repo(t);
  put(root, LEVEL2, 'export const GATES = { furnaceRel: 5e-2, analyticRel: 2e-3 };\n');
  assert.match(problems(root).join('\n'), /GATES .* 和 .* 不一致/);
  put(root, LEVEL2, 'export const GATES = { furnaceRel: 5e-3, analyticRel: 2e-3, extra: 1 };\n');
  assert.match(problems(root).join('\n'), /不一致/);
  put(root, LEVEL2, 'export const GATES = makeGates();\n');
  assert.match(problems(root).join('\n'), /找不到/);
});

test('合并门：命令行被拦退出 4，基准解析不出来退出 3，参数错退出 2', (t) => {
  const root = repo(t);
  const cli = (...args) => spawnSync(process.execPath, [path.join(HERE, 'floorguard.mjs'), '--repo', root, ...args], { encoding: 'utf8' }).status;
  assert.equal(cli('--base', 'main'), 0);
  put(root, PROTECTED[1], '改\n');
  assert.equal(cli('--base', 'main'), 4);
  assert.equal(cli('--base', 'no-such-ref'), 3);
  assert.equal(cli('--nope'), 2);
});

const checkAll = (root) => spawnSync(process.execPath, [path.join(REPO, 'tools/check-all.mjs'), '--root', root, '--only', 'floorgate', '--json'],
  { encoding: 'utf8', env: { ...process.env, BEIMING_FLOORGATE_BASE: 'main', GITHUB_ACTIONS: '' } }); // 在 Actions 上 check-all 会往标准输出打分组标记

test('check-all：跑的是 merge-base 上的合并门，同一个 PR 把合并门改成放行也没用', (t) => {
  const root = repo(t);
  assert.equal(checkAll(root).status, 0);
  put(root, PROTECTED[0], json({ ...THRESH, k: 5 }));
  put(root, PROTECTED[3], 'process.exitCode = 0;\n');
  const r = checkAll(root);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stdout, /floor-gate\.json 改了/);
});

test('check-all：合并门连同 GATES.md 一起删掉，跑基准上那一份，照拦；基准上没有合并门而 GATES.md 在，判不过；两样都没有才跳过', (t) => {
  const root = repo(t);
  fs.rmSync(path.join(root, PROTECTED[1]));
  fs.rmSync(path.join(root, PROTECTED[3]));
  put(root, PROTECTED[0], json({ ...THRESH, k: 5 }));
  const r = checkAll(root);
  assert.equal(r.status, 4, r.stdout);
  for (const p of [PROTECTED[0], PROTECTED[1], PROTECTED[3]]) assert.match(r.stdout, new RegExp(`${p.replace(/[.]/g, '\\.')} 改了`), p);
  const noGuard = repo(t, { omit: [PROTECTED[3]] });
  const n = checkAll(noGuard);
  assert.equal(n.status, 4);
  assert.match(JSON.parse(n.stdout).steps[0].reason, /合并门不能跳过/);
  const neither = repo(t, { omit: [PROTECTED[1], PROTECTED[3]] });
  const s = checkAll(neither);
  assert.equal(s.status, 0);
  assert.equal(JSON.parse(s.stdout).steps[0].status, 'skip');
});

test('合并门：上一级目录换成符号链接被拦；只把换行改成 CRLF 不算改动', { skip: process.platform === 'win32' && '要建符号链接' }, (t) => {
  const root = repo(t);
  put(root, PROTECTED[0], read(root, PROTECTED[0]).replace(/\n/g, '\r\n'));
  assert.deepEqual(problems(root), []);
  fs.renameSync(path.join(root, 'beiming/verify'), path.join(root, 'beiming/verify-real'));
  fs.symlinkSync(path.join(root, 'beiming/verify-real'), path.join(root, 'beiming/verify'));
  assert.match(problems(root).join('\n'), /beiming\/verify 不是普通目录/);
});

test('check-all：本仓库里这一步真的在跑，不是跳过', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/check-all.mjs'), '--root', REPO, '--only', 'floorgate', '--json'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  const step = JSON.parse(r.stdout).steps[0];
  assert.equal(step.id, 'floorgate');
  assert.notEqual(step.status, 'skip', step.reason);
});
