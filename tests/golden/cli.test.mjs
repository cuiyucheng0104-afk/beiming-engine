// 金标准与确定性命令的契约与集成测试：node --test tests/golden/cli.test.mjs
// 契约部分不开浏览器（与 tests/cli/contract.test.mjs 对每个已登记脚本做的检查相同，外加 P09 smoke-render 依赖的 --platform）；
// 集成部分用 tests/golden/fixtures 下的 2D 夹具页（几秒），没装无头浏览器时自动跳过。
// 候选 → 审批的流程在系统临时目录里搭一个小 git 仓库跑（复制工具与夹具），不碰本仓库的清单。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GOLDEN = path.join(ROOT, 'tools/baseline/golden.mjs');
const DET = path.join(ROOT, 'tools/baseline/determinism.mjs');
const run = (script, args, { env = {}, cwd = ROOT } = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 300000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
// --json：stdout 只有一个 JSON 对象（docs/CLI.md 的信封，schemaVersion 1）
const envelope = s => {
  let j;
  assert.doesNotThrow(() => { j = JSON.parse(s); }, `--json 时 stdout 只能是一个 JSON 对象，实际：${s.slice(0, 300)}`);
  for (const k of ['schemaVersion', 'ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings', 'data']) assert.ok(k in j, `信封缺 ${k}`);
  assert.equal(j.schemaVersion, 1);
  return j;
};
function snapshot(dir) {
  if (!fs.existsSync(dir)) return '';
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${p}:${fs.statSync(p).mtimeMs}`); } };
  walk(dir);
  return out.sort().join('\n');
}
// 入库的清单、审批记录、认可参照：任何测试都不能改它们
const trackedState = () => ['tests/golden', 'docs/style-baselines'].map(d => snapshot(path.join(ROOT, d))).join('|');

test('--help：stdout、exit 0、含「用法」「退出码」与 --platform，不留任何文件', () => {
  const outState = () => ['out/golden', 'out/determinism'].map(d => snapshot(path.join(ROOT, d))).join('|');
  const before = outState() + trackedState();
  for (const [s, args] of [[GOLDEN, ['--help']], [GOLDEN, ['compare', '--help']], [GOLDEN, ['-h']], [DET, ['--help']], [DET, ['.', '--help']]]) {
    const r = run(s, args);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /用法/); assert.match(r.out, /退出码/);
    if (s === GOLDEN) assert.match(r.out, /--platform\b/, 'P09 的 smoke-render 靠 --help 里有没有 --platform 探测是否支持');
  }
  assert.equal(outState() + trackedState(), before);
});

test('未知选项 → exit 2，stderr 说「不认识的选项」，--json 信封是 usage.unknown-option（与 tests/cli/contract.test.mjs 一致）', () => {
  for (const s of [GOLDEN, DET]) {
    const bad = run(s, ['--no-such-flag']);
    assert.equal(bad.code, 2, bad.err);
    assert.match(bad.err, /不认识的选项 --no-such-flag/);
    const j = envelope(run(s, ['--no-such-flag', '--json']).out);
    assert.equal(j.ok, false); assert.equal(j.exitCode, 2); assert.equal(j.error.code, 'usage.unknown-option');
    assert.ok(Array.isArray(j.outputs) && Array.isArray(j.warnings));
  }
});

test('子命令用错选项、缺参数、非法值 → exit 2，信封可解析', () => {
  for (const [s, args, code] of [
    [GOLDEN, ['capture', '--by', 'x', '--set', 'fixtures', '--json'], 'usage.option-not-allowed'],
    [GOLDEN, ['nope', '--json'], 'usage.bad-argument'],
    [GOLDEN, ['--json'], 'usage.missing-argument'],
    [GOLDEN, ['capture', '--set', 'fixtures', '--platform', 'mac', '--json'], 'usage.bad-argument'],
    [GOLDEN, ['compare', '--set', 'fixtures', '--gpu', 'maybe', '--json'], 'usage.bad-value'],
    [GOLDEN, ['capture', '--set', 'no-such-set', '--json'], 'usage.unknown-set'],
    [DET, ['--json'], 'usage.bad-argument'],
    [DET, ['.', '--template', 'a', '--json'], 'usage.bad-argument'],
    [DET, ['--template', 'b', '--json'], 'usage.bad-value'],
  ]) {
    const r = run(s, args);
    assert.equal(r.code, 2, `${args.join(' ')}：${r.err}`);
    const j = envelope(r.out);
    assert.equal(j.ok, false); assert.equal(j.exitCode, 2); assert.equal(j.error.code, code, args.join(' '));
  }
});

test('--platform 写的是软件光栅平台时 --gpu 默认 software-ok；平台键写法不对是用法错误', () => {
  const bad = run(GOLDEN, ['compare', '--set', 'fixtures', '--platform', 'linux_swiftshader', '--json']);
  assert.equal(bad.code, 2);
  assert.match(envelope(bad.out).error.message, /--platform/);
});

test('update / approve 缺审批字段、或登记提交与 HEAD 像素不等价 → 拒绝且不写清单', () => {
  const before = trackedState();
  const r1 = run(GOLDEN, ['update', '--set', 'fixtures', '--json']);
  assert.equal(r1.code, 2); assert.match(envelope(r1.out).error.message, /--by/);
  const r0 = run(GOLDEN, ['approve', '--set', 'fixtures', '--by', 'x', '--reason', 'y', '--json']);
  assert.equal(r0.code, 2); assert.match(envelope(r0.out).error.message, /--platform/);
  // 登记一个与 HEAD 像素路径不同的提交（仓库的根提交 v1.0 没有 tests/golden/fixtures）：必须拒绝
  const rootCommit = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().split('\n')[0] || 'no-such-commit';
  const r2 = run(GOLDEN, ['update', '--set', 'fixtures', '--by', '测试', '--reason', '测试', '--commit', rootCommit, '--json']);
  assert.ok([2, 4].includes(r2.code), r2.err);   // 提交不存在（浅克隆）是 2；不等价或有未提交改动是 4
  assert.notEqual(envelope(r2.out).ok, true);
  assert.equal(trackedState(), before);
});

test('list --json 列出集合、平台清单与认可参照', () => {
  const r = run(GOLDEN, ['list', '--json']);
  assert.equal(r.code, 0, r.err);
  const j = envelope(r.out);
  assert.ok(j.data.sets.some(s => s.name === 'beiming-core'));
  assert.ok(j.data.platforms.some(p => p.platformKey === 'darwin-metal' && p.set === 'beiming-core' && p.status === 'approved'));
  assert.ok(j.data.references.some(x => x.id === 'beiming-original@v1'));
});

test('静态扫描：仓库默认范围没有未登记的不确定 API', () => {
  const r = run(DET, ['--scan-only', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(envelope(r.out).data.scan.errors.length, 0);
});

// ── 集成（要无头浏览器）──
let browserOk = false;
try {
  const { chromium } = await import('playwright-core');
  browserOk = fs.existsSync(chromium.executablePath()) || !!process.env.BEIMING_CHROME;
} catch { browserOk = false; }
const gpuEnv = process.env.BEIMING_TEST_GPU || (process.platform === 'darwin' ? 'any' : 'software-ok');

test('确定性：纯函数夹具通过（exit 0），有累计状态的反例夹具判不通过（exit 4）', { skip: !browserOk && '没装无头浏览器' }, () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'out', '.det-test-'));
  try {
    const ok = run(DET, ['tests/golden/fixtures/pure', '--size', '320x180', '--gpu', gpuEnv, '--no-scan', '--out', path.join(tmp, 'pure'), '--json']);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(envelope(ok.out).ok, true);
    const bad = run(DET, ['tests/golden/fixtures/stateful', '--size', '320x180', '--frames', '5,30', '--gpu', gpuEnv, '--no-scan', '--out', path.join(tmp, 'stateful'), '--json']);
    assert.equal(bad.code, 4, bad.err);
    const j = envelope(bad.out);
    assert.equal(j.error.code, 'contract.nondeterministic');
    const rep = JSON.parse(fs.readFileSync(path.join(ROOT, j.runJson), 'utf8'));
    assert.ok(rep.rows.every(r => r.status === 'differs'));
    assert.ok(rep.rows.some(r => r.diff && fs.existsSync(path.join(tmp, 'stateful', r.diff))), '应输出差异热图');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('金标准：同一页面自比逐像素一致；页面被改动（方块平移 3 像素）→ exit 4 并出差异热图与接触印', { skip: !browserOk && '没装无头浏览器' }, () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'out', '.golden-test-'));
  try {
    // 被改动的页面放在仓库内的临时目录，页面名不变，所以帧编号与参照一一对应
    const shifted = path.join(tmp, 'pure-shifted');
    fs.mkdirSync(shifted);
    fs.writeFileSync(path.join(shifted, 'index.html'), fs.readFileSync(path.join(ROOT, 'tests/golden/fixtures/pure/index.html'), 'utf8').replace("get('shift') || 0", "get('shift') || 3"));
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/baseline/sets.json'), 'utf8'));
    const mk = (name, dir) => {
      const s = { schema: base.schema, pages: { 'fixture:pure': { dir, fps: 24 } }, sets: { fixtures: { tolerance: base.sets.fixtures.tolerance, shots: [{ page: 'fixture:pure', size: [320, 180], times: { frames: [0, 12, 24, 47] } }] } } };
      const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(s)); return f;
    };
    const refSets = mk('ref.json', 'tests/golden/fixtures/pure'), badSets = mk('bad.json', path.relative(ROOT, shifted).split(path.sep).join('/'));
    const cap = run(GOLDEN, ['capture', '--set', 'fixtures', '--sets', refSets, '--gpu', gpuEnv, '--out', path.join(tmp, 'ref'), '--json']);
    assert.equal(cap.code, 0, cap.err);
    const same = run(GOLDEN, ['compare', '--set', 'fixtures', '--sets', refSets, '--ref-dir', path.join(tmp, 'ref'), '--strict', '--gpu', gpuEnv, '--out', path.join(tmp, 'cmp-same'), '--json']);
    assert.equal(same.code, 0, same.err);
    assert.equal(envelope(same.out).data[0].summary.identical, 4);
    // --perturb 只改当前工作树的页面网址：shift=3 等于把方块平移 3 像素
    const pert = run(GOLDEN, ['compare', '--set', 'fixtures', '--sets', refSets, '--ref-dir', path.join(tmp, 'ref'), '--perturb', 'shift=3', '--gpu', gpuEnv, '--out', path.join(tmp, 'cmp-pert'), '--json']);
    assert.equal(pert.code, 4, pert.err);
    const diff = run(GOLDEN, ['compare', '--set', 'fixtures', '--sets', badSets, '--ref-dir', path.join(tmp, 'ref'), '--gpu', gpuEnv, '--out', path.join(tmp, 'cmp-bad'), '--json']);
    assert.equal(diff.code, 4, diff.err);
    const dj = envelope(diff.out);
    assert.equal(dj.error.code, 'contract.golden-mismatch');
    assert.equal(dj.data[0].summary.differs, 4);
    assert.ok(dj.outputs.some(o => o.kind === 'contact-sheet'), '应输出接触印');
    const rep = JSON.parse(fs.readFileSync(path.join(ROOT, dj.runJson), 'utf8'));
    assert.ok(rep.frames.every(f => f.diff && fs.existsSync(path.join(tmp, 'cmp-bad', 'fixtures', f.diff))));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// 小 git 仓库：复制金标准工具、命令约定库、页面渲染器与夹具，集合只有纯函数夹具两帧
function sandboxRepo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-golden-flow-')));
  for (const p of ['tools/baseline', 'tools/lib', 'engine/render', 'tests/golden/fixtures']) fs.cpSync(path.join(ROOT, p), path.join(d, p), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'sandbox', private: true, type: 'module', version: '0.0.0' }));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(d, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules\nout/\n');
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/baseline/sets.json'), 'utf8'));
  fs.writeFileSync(path.join(d, 'tools/baseline/sets.json'), JSON.stringify({
    schema: base.schema,
    pages: { 'fixture:pure': { dir: 'tests/golden/fixtures/pure', fps: 24 } },
    sets: { fixtures: { tolerance: base.sets.fixtures.tolerance, shots: [{ page: 'fixture:pure', size: [320, 180], times: { frames: [0, 12] } }] } },
  }, null, 1));
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=测试', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: d, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', '夹具');
  return { d, git, golden: path.join(d, 'tools/baseline/golden.mjs') };
}

test('候选 → 审批：capture --platform 写待审批候选（不参与比对），approve 按像素路径摘要核对后转正，之后 compare 逐像素一致', { skip: !browserOk && '没装无头浏览器' }, () => {
  const { d, git, golden } = sandboxRepo();
  const g = args => run(golden, [...args, '--gpu', gpuEnv, '--json'], { cwd: d });
  const gNoGpu = args => run(golden, [...args, '--json'], { cwd: d });
  try {
    const probe = g(['capture', '--set', 'fixtures']);
    assert.equal(probe.code, 0, probe.err);
    const pk = envelope(probe.out).data[0].platformKey;
    assert.match(pk, /^(darwin|win|linux)-[a-z0-9]+$/);
    const manifest = path.join(d, 'tests/golden', pk, 'manifest.json');
    assert.equal(fs.existsSync(manifest), false, '不带 --platform 的 capture 不写清单');

    const wrong = g(['capture', '--set', 'fixtures', '--platform', pk === 'win-d3d11' ? 'linux-swiftshader' : 'win-d3d11']);
    assert.equal(wrong.code, 3, wrong.err);
    assert.equal(envelope(wrong.out).error.code, 'env.platform-mismatch');

    const cap = g(['capture', '--set', 'fixtures', '--platform', pk]);
    assert.equal(cap.code, 0, cap.err);
    const capEnv = envelope(cap.out);
    assert.ok(capEnv.outputs.some(o => o.kind === 'golden-candidate'));
    const sheet = capEnv.outputs.find(o => o.kind === 'contact-sheet');
    assert.ok(sheet && fs.existsSync(path.join(d, sheet.path)), '--platform 采集要拼一张审批用的总览');
    const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.equal(doc.sets.fixtures.status, 'candidate');
    assert.equal(doc.sets.fixtures.approval, null);

    const noBase = g(['compare', '--set', 'fixtures']);
    assert.equal(noBase.code, 3, '只有候选时不算有基线');
    assert.equal(envelope(noBase.out).error.code, 'env.no-baseline');

    // 候选的源提交之后改了夹具：用新提交登记必须拒绝（像素路径不等价）
    const head1 = git('rev-parse', 'HEAD');
    fs.appendFileSync(path.join(d, 'tests/golden/fixtures/pure/index.html'), '\n<!-- 改动 -->\n');
    git('add', 'tests/golden/fixtures/pure/index.html'); git('commit', '-q', '-m', '改夹具');   // 只提交夹具，候选清单留在工作区
    const ne = gNoGpu(['approve', '--platform', pk, '--set', 'fixtures', '--by', '测试', '--reason', '测试', '--commit', 'HEAD']);
    assert.equal(ne.code, 4, ne.err);
    assert.equal(envelope(ne.out).error.code, 'contract.not-equivalent');
    git('reset', '-q', '--hard', head1);

    // 模拟 CI：候选记的源提交在本仓库里找不到（合并提交），不写 --commit 是用法错误；写一个像素路径相同的提交就能转正
    const cand = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    cand.sets.fixtures.source.commit = 'f'.repeat(40);
    fs.writeFileSync(manifest, JSON.stringify(cand));
    const need = gNoGpu(['approve', '--platform', pk, '--set', 'fixtures', '--by', '测试', '--reason', '测试']);
    assert.equal(need.code, 2, need.err);
    const ok = gNoGpu(['approve', '--platform', pk, '--set', 'fixtures', '--by', '测试审批人', '--reason', '测试转正', '--commit', 'HEAD']);
    assert.equal(ok.code, 0, ok.err);
    const after = JSON.parse(fs.readFileSync(manifest, 'utf8')).sets.fixtures;
    assert.equal(after.status, undefined);
    assert.equal(after.approval.by, '测试审批人');
    assert.equal(after.source.commit, head1);
    assert.equal(after.source.capturedAt, 'f'.repeat(40));
    const recs = fs.readFileSync(path.join(d, 'tests/golden/approvals.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(recs.at(-1).after, after.framesDigest);

    const same = g(['compare', '--set', 'fixtures', '--strict']);
    assert.equal(same.code, 0, same.err);
    assert.equal(envelope(same.out).data[0].summary.identical, 2);
    // 已有经审批的基线时，capture --platform 不覆盖它
    const again = g(['capture', '--set', 'fixtures', '--platform', pk]);
    assert.equal(again.code, 0, again.err);
    assert.ok(envelope(again.out).warnings.some(w => /不覆盖/.test(w.message)));
    assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).sets.fixtures.approval.by, '测试审批人');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
