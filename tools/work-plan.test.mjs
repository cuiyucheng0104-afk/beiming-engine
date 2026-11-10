// tools/work-plan.mjs（引擎工程待办，D06）的测试：结构与依赖、路线 id 与旧名、认领与过期、写入范围冲突的等级与 --strict、
// 取代关系、证据与指引路径的存在性、输入里的路径（R87）、verify-diff、按 JSON 生成的任务卡与 work-breakdown.md 逐字一致（R82），
// 以及命令行约定（--help、未知参数、--json 信封、旧名迁移提示）。
//   node --test tools/work-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CARDS_BEGIN, CARDS_END, auditPlan, changedFiles, diagnosePlan, formatCards, inScope, inputPathProblems, inspectPlan,
  isEntryPoint, resolveRoute, validatePlan,
} from './work-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CLI = join(HERE, 'work-plan.mjs');
const task = (id, extra = {}) => ({ id, title: id, ownerRole: 'owner', route: 'shared', status: 'planned', dependsOn: [], inputs: ['source'], writeScope: [`engine/${id}/`], outputs: ['result'], acceptance: ['verified'], evidence: [], ...extra });
const plan = tasks => ({ schemaVersion: 1, tasks });
const claim = (extra = {}) => ({ by: '代理甲', session: 'hard/X', baseCommit: 'abfdc83', startedAt: '2026-11-10', ...extra });
const plan2 = tasks => ({ schemaVersion: 2, claimTtlDays: 14, tasks: tasks.map(t => ({ playbook: 'docs/x.md', ...t })) });
// Git for Windows 默认按 CRLF 检出：发布的文档按同一方式解析
const readDoc = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const canonicalPlan = () => JSON.parse(readFileSync(join(ROOT, 'docs/routes/work-plan.json'), 'utf8'));
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_lifecycle_event: '', ...env } });
const tmp = prefix => mkdtempSync(join(tmpdir(), prefix));

// ───── 结构与依赖（v1 计划照样能读） ─────

test('只有依赖全部 done 才可领取；按路线筛选时带上 shared；旧名与注册表 id 等价', () => {
  const p = plan([task('C00', { status: 'done', evidence: ['commit'] }), task('A01', { route: 'beiming', dependsOn: ['C00'] }), task('R01', { route: 'raea' }), task('A02', { dependsOn: ['A01'] }), task('C02', { status: 'blocked', blocker: 'missing asset' })]);
  assert.deepEqual(inspectPlan(p, 'beiming').ready.map(t => t.id), ['A01']);
  assert.deepEqual(inspectPlan(p, 'a').ready.map(t => t.id), ['A01'], '注册表 id a = 旧名 beiming');
  assert.deepEqual(inspectPlan(p, 'b-native').ready.map(t => t.id), ['R01'], '目录名也是别名');
  assert.deepEqual(inspectPlan(p, 'shared').ready.map(t => t.id), []);
  assert.deepEqual([resolveRoute('BEIMING').id, resolveRoute('c').id, resolveRoute('shared').id, resolveRoute('style')], ['a', 'c', 'shared', null]);
});
test('不认识的依赖、依赖成环都报错', () => {
  assert.match(validatePlan(plan([task('A01', { dependsOn: ['Z99'] })])).join(), /依赖的 Z99 不在计划里/);
  assert.match(validatePlan(plan([task('A01', { dependsOn: ['R01'] }), task('R01', { dependsOn: ['A01'] })])).join(), /依赖成环/);
});
test('done 要有证据，且依赖都已 done', () => {
  const errors = validatePlan(plan([task('C01'), task('A01', { status: 'done', dependsOn: ['C01'] })])).join();
  assert.match(errors, /标成 done 必须有证据/);
  assert.match(errors, /依赖 C01 还是 planned/);
});
test('写入范围重叠能查出，前缀相似但不同的目录不算', () => {
  const p = plan([task('A01', { writeScope: ['engine/style/**'] }), task('R01', { writeScope: ['engine/style/native.js'] }), task('C01', { writeScope: ['engine/styles/new.js'] })]);
  assert.deepEqual(inspectPlan(p).conflicts.map(c => c.tasks), [['A01', 'R01']]);
});
test('越界路径、空验收、重复 id 都报错', () => {
  const errors = validatePlan(plan([task('A01', { writeScope: ['../elsewhere'] }), task('A01', { acceptance: [] })])).join();
  assert.match(errors, /写入范围要在仓库里/);
  assert.match(errors, /任务 id A01 重复/);
  assert.match(errors, /acceptance 不能为空/);
});
test('结构坏掉的计划与未知路线：未知路线是用法错误并列出合法取值', () => {
  assert.ok(validatePlan({ tasks: [] }).length);
  assert.ok(validatePlan(plan([null, task('A01', { dependsOn: 3 })])).length);
  assert.throws(() => inspectPlan(plan([task('C01')]), 'unknown'), e => e.code === 'usage.unknown-route' && /a（北冥风格路线 · WebGL 三渲二）、b（北冥原生 · BNE）、c（北冥代码动画风格 · 86 式）、shared/.test(e.message));
  assert.throws(() => inspectPlan(plan([task('C01', { route: 'style' })])), e => e.code === 'contract.plan' && /路线 "style" 不认识/.test(e.message));
});
test('别的路线的在办任务照样挡住重叠的可领取任务', () => {
  const p = plan([task('A01', { route: 'beiming', writeScope: ['README.md'] }), task('R01', { route: 'raea', status: 'in-progress', writeScope: ['**'] })]);
  const result = inspectPlan(p, 'beiming');
  assert.deepEqual(result.conflicts[0].tasks, ['A01', 'R01']);
  assert.deepEqual(result.conflicts[0].statuses, ['planned', 'in-progress']);
  assert.equal(result.conflicts[0].level, 'warn', '可领取 ↔ 在办只是提醒');
  assert.equal(inspectPlan(p, 'beiming', { strict: true }).conflicts[0].level, 'error', '--strict 时算错误');
});
test('不规范的写法会藏住冲突，一律拒绝', () => {
  for (const path of ['./engine/style', 'engine//style', 'engine/*/**', 'engine/./style', '/engine', 'C:/engine']) {
    assert.match(validatePlan(plan([task('A01', { writeScope: [path] })])).join(), /写入范围要在仓库里/, path);
  }
  assert.deepEqual(validatePlan(plan([task('A01', { writeScope: ['engine/style/', 'engine/style/**', '**'] })])), []);
});
test('两个在办任务互相重叠是错误', () => {
  const p = plan([task('A01', { route: 'beiming', status: 'in-progress', writeScope: ['README.md'] }), task('R01', { route: 'raea', status: 'in-progress', writeScope: ['README.md'] })]);
  const c = inspectPlan(p, 'beiming').conflicts[0];
  assert.deepEqual(c.tasks, ['A01', 'R01']);
  assert.equal(c.level, 'error');
});
test('按路线筛选时照样说明跨路线的未完成依赖与阻塞原因', () => {
  const p = plan([task('A01', { route: 'beiming', dependsOn: ['R01'] }), task('R01', { route: 'raea' }), task('C01', { status: 'blocked', blocker: 'missing asset' })]);
  const r = inspectPlan(p, 'beiming');
  assert.deepEqual(r.ready, []);
  assert.deepEqual(r.waiting[0].dependencies, [{ id: 'R01', route: 'b', status: 'planned', title: 'R01' }]);
  assert.equal(r.waiting[1].blocker, 'missing asset');
});
test('Mac / Windows 共用工作区时大小写与 Unicode 等价名仍算冲突', () => {
  for (const scopes of [['README.md', 'readme.md'], ['docs/café.md', 'docs/cafe\u0301.md']]) {
    const p = plan([task('A01', { writeScope: [scopes[0]] }), task('R01', { status: 'in-progress', writeScope: [scopes[1]] })]);
    assert.equal(inspectPlan(p).conflicts.length, 1);
  }
});
test('blocked 不释放写入范围，必须写清阻塞原因', () => {
  const p = plan([task('A01', { writeScope: ['README.md'] }), task('R01', { route: 'raea', status: 'blocked', blocker: 'awaiting asset', writeScope: ['README.md'] })]);
  assert.deepEqual(inspectPlan(p, 'beiming').conflicts[0].statuses, ['planned', 'blocked']);
  for (const blocker of [' ', 1, {}]) assert.match(validatePlan(plan([task('C01', { status: 'blocked', blocker })])).join(), /非空的 blocker/);
});

// ───── v2：认领、取代、证据对象 ─────

test('v2：在办任务必须有认领记录；认领格式要对；planned 带认领要提示；旧路线名要提示改写', () => {
  const d = diagnosePlan(plan2([task('A01', { status: 'in-progress' }), task('A02', { status: 'blocked', blocker: 'x', claim: { by: '', session: 's', baseCommit: 'zz', startedAt: '昨天' } }), task('A03', { claim: claim() }), task('A04', { route: 'raea' })]));
  const msgs = d.errors.map(e => e.message).join('\n');
  assert.match(msgs, /A01：in-progress 必须写 claim/);
  assert.match(msgs, /A02：claim 格式不对（by、baseCommit（7–40 位提交号）、startedAt（ISO 日期））/);
  assert.deepEqual(d.warnings.map(w => w.code).sort(), ['task.claim-planned', 'task.route-alias']);
});
test('v2：认领过期按 expiresAt 或 claimTtlDays 判断，--now 可复现', () => {
  const p = plan2([task('A01', { status: 'in-progress', claim: claim() }), task('A02', { status: 'in-progress', claim: claim({ expiresAt: '2026-12-31' }), writeScope: ['tools/x/'] })]);
  const root = tmp('plan-root-');
  try {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/x.md'), '# x\n');
    const fresh = auditPlan(p, { root, now: Date.parse('2026-11-20') });
    assert.deepEqual(fresh.errors, []);
    assert.deepEqual(fresh.view.claims.map(c => [c.id, c.expiresAt, c.stale]), [['A01', '2026-11-24', false], ['A02', '2026-12-31', false]]);
    const late = auditPlan(p, { root, now: Date.parse('2026-11-25') });
    assert.deepEqual(late.errors.map(e => [e.task, e.code]), [['A01', 'task.claim-stale']]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('v2：superseded 要写取代者与原因；依赖被取代的任务要改依赖取代者', () => {
  const p = plan2([task('A01', { status: 'superseded', superseded: { by: ['H01'], reason: '并入加固包' } }), task('H01', { status: 'in-progress', claim: claim(), writeScope: ['tools/h/'] }), task('A02', { dependsOn: ['A01'] }), task('A03', { status: 'superseded' }), task('A04', { superseded: { by: ['H01'], reason: 'x' } })]);
  const msgs = diagnosePlan(p).errors.map(e => `${e.message} ${e.hint ?? ''}`).join('\n');
  assert.match(msgs, /A02：依赖的 A01 已被取代 改成依赖 H01/);
  assert.match(msgs, /A03：superseded 要写/);
  assert.match(msgs, /A04：只有 superseded 状态才写 superseded 字段/);
  const ok = plan2([task('A01', { status: 'superseded', superseded: { by: ['H01'], reason: '并入' } }), task('H01', { status: 'in-progress', claim: claim(), writeScope: ['engine/A01/'] })]);
  assert.deepEqual(diagnosePlan(ok).errors, []);
  assert.deepEqual(inspectPlan(ok).conflicts, [], '被取代的任务不再占写入范围');
});
test('v2：证据是对象；文件要存在、sha256 要对得上、提交要在 git 里；指引文件要存在', () => {
  const root = tmp('plan-ev-');
  try {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/x.md'), '# x\n');
    writeFileSync(join(root, 'docs/r.json'), '{}\n');
    const p = plan2([
      task('A01', { status: 'done', evidence: [{ kind: 'file', ref: 'docs/x.md' }, { kind: 'result', ref: 'docs/r.json', sha256: '0'.repeat(64) }, { kind: 'command', ref: 'node --test x', note: '3 项通过' }] }),
      task('A02', { status: 'done', dependsOn: ['A01'], evidence: [{ kind: 'file', ref: 'docs/gone.md' }], playbook: 'docs/missing.md' }),
      task('A03', { status: 'done', evidence: ['旧写法的字符串证据'] }),
    ]);
    const bad = diagnosePlan(p).errors.map(e => e.message).join('\n');
    assert.match(bad, /A03：evidence\[0\] 要写成 \{ kind: file \| result \| command \| commit, ref, note\? \}/);
    p.tasks.pop();
    const a = auditPlan(p, { root });
    const msgs = a.errors.map(e => `${e.code} ${e.message}`).join('\n');
    assert.match(msgs, /task\.evidence-changed A01：证据文件 docs\/r\.json 的 sha256 变了/);
    assert.match(msgs, /task\.evidence-missing A02：证据文件 docs\/gone\.md 不存在/);
    assert.match(msgs, /task\.playbook-missing A02：详细指引 docs\/missing\.md 不存在/);
    const commitPlan = plan2([task('A01', { status: 'done', evidence: [{ kind: 'commit', ref: 'abcdef1234567' }] })]);
    const noGit = auditPlan(commitPlan, { root });
    assert.ok(noGit.warnings.some(w => w.code === 'task.evidence-unverified'), '不是 git 检出时只提示');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('提交号证据在本仓库里核对：存在的通过，不存在的报错', () => {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (head.status !== 0) return;
  const mk = ref => plan2([task('A01', { status: 'done', evidence: [{ kind: 'commit', ref }], playbook: 'docs/CLI.md' })]);
  assert.deepEqual(auditPlan(mk(head.stdout.trim().slice(0, 9)), { root: ROOT }).errors, []);
  assert.match(auditPlan(mk('0123456789abcdef0123'), { root: ROOT }).errors.map(e => e.message).join(), /证据提交 0123456789abcdef0123 在本仓库里找不到/);
});
test('输入里的路径（R87）：从仓库根写起的要存在，带扩展名却没写全的算不完整；--strict 时是错误', () => {
  assert.deepEqual(inputPathProblems('现有 tools/render.mjs/prepare.mjs；项目记录契约', ROOT), [{ token: 'tools/render.mjs/prepare.mjs', problem: '不存在' }]);
  assert.deepEqual(inputPathProblems('templates/project-*.json 与 render-result.json', ROOT), [{ token: 'templates/project-*.json', problem: '不是从仓库根写起的完整路径' }]);
  assert.deepEqual(inputPathProblems('docs/routes/templates/project-*.json 与 docs/routes/templates/render-result.json', ROOT), []);
  assert.deepEqual(inputPathProblems('ffprobe/FFmpeg 检查方法；update(t,f)/look(t)；Canvas3D/ImagePlane/Model SDK；1080/4K', ROOT), [], '不是路径的斜杠写法不算');
  const p = plan2([task('A01', { inputs: ['现有 tools/render.mjs/prepare.mjs'], playbook: 'docs/CLI.md' })]);
  assert.ok(auditPlan(p, { root: ROOT }).warnings.some(w => w.code === 'task.input-path'));
  assert.ok(auditPlan(p, { root: ROOT, strict: true }).errors.some(e => e.code === 'task.input-path'));
  const done = plan2([task('A01', { status: 'done', evidence: [{ kind: 'command', ref: 'x' }], inputs: ['现有 tools/render.mjs/prepare.mjs'], playbook: 'docs/CLI.md' })]);
  assert.ok(!auditPlan(done, { root: ROOT, strict: true }).errors.length, '已完成任务的输入是历史记录，不再核对');
});

// ───── verify-diff ─────

test('verify-diff：基线以来的提交、未提交与未跟踪改动都算，范围外的文件挑出来', t => {
  const repo = tmp('plan-git-');
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  try {
    if (git('init', '-q').status !== 0) { t.skip('没有 git'); return; }
    git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'engine/style'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(repo, 'engine/style/a.js'), '1\n');
    git('add', '.'); git('commit', '-qm', 'one');
    writeFileSync(join(repo, 'engine/style/b.js'), '2\n');
    writeFileSync(join(repo, 'README.md'), 'y\n');
    const r = changedFiles(repo, base.slice(0, 7));
    assert.equal(r.base, base);
    assert.deepEqual(r.files, ['README.md', 'engine/style/a.js', 'engine/style/b.js']);
    assert.deepEqual(r.files.filter(f => !inScope(f, ['engine/style/**'])), ['README.md']);
    assert.deepEqual(r.files.filter(f => !inScope(f, ['engine/style/', 'README.md'])), []);
    assert.equal(inScope('engine/styles/x.js', ['engine/style']), false, '前缀相似不算');
    assert.equal(inScope('Engine/style/x.js', ['engine/style']), false, 'git 里大小写不同就是两个路径');
    assert.throws(() => changedFiles(repo, 'nope'), e => e.code === 'usage.bad-base');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ───── 本仓库的计划与任务卡（R82） ─────

test('本仓库计划：v2、--strict 合格；登记 19 个加固工作包；T09 / T13 被 engine/native 取代；去掉 T18→T04、T20→T17', () => {
  const p = canonicalPlan();
  assert.equal(p.schemaVersion, 2);
  const a = auditPlan(p, { root: ROOT, strict: true, now: Date.parse('2026-11-10') });
  assert.deepEqual(a.errors, []);
  const H = p.tasks.filter(t => t.id.startsWith('H'));
  assert.equal(H.length, 19);
  assert.deepEqual(H.map(t => t.title.split(' ')[0]), [...Array.from({ length: 18 }, (_, i) => `P${String(i).padStart(2, '0')}`), 'PZ']);
  for (const t of H.filter(x => x.status === 'in-progress')) assert.equal(t.claim.session, t.id === 'H00' ? 'routes-template' : `hard/${t.title.split(' ')[0]}`, t.id);
  const byId = new Map(p.tasks.map(t => [t.id, t]));
  for (const id of ['T09', 'T13']) assert.deepEqual([byId.get(id).status, byId.get(id).superseded.by], ['superseded', ['H14']], id);
  assert.ok(!byId.get('T18').dependsOn.includes('T04'));
  assert.ok(!byId.get('T20').dependsOn.includes('T17'));
  assert.ok(p.tasks.every(t => ['a', 'b', 'c', 'shared'].includes(t.route)), 'route 只用注册表 id 或 shared');
  assert.match(byId.get('T13').inputs.join(), /examples\/raea\/tools\/render\.mjs/, 'R87：路径写完整');
  assert.doesNotMatch(p.scope, /除\s*T00.*待实现/, 'R82：scope 不再写死状态');
});
test('work-breakdown.md 的依赖总览与任务卡和 JSON 逐字一致（node tools/work-plan.mjs --cards 生成）', () => {
  const doc = readDoc('docs/routes/work-breakdown.md');
  const i = doc.indexOf(CARDS_BEGIN), j = doc.indexOf(CARDS_END);
  assert.ok(i >= 0 && j > i, `work-breakdown.md 要有 ${CARDS_BEGIN} … ${CARDS_END} 一段`);
  const region = doc.slice(i + CARDS_BEGIN.length, j).trim();
  assert.equal(region, formatCards(canonicalPlan()).trim(), '改了 work-plan.json 就重新生成：node tools/work-plan.mjs --cards');
  const outside = doc.slice(0, i) + doc.slice(j);
  assert.doesNotMatch(outside, /^### [A-Z]\d{2} · /m, '任务卡只在生成段里');
  assert.doesNotMatch(outside, /^\|\s*[TH]\d{2}\s*\|/m, '不再手写「首批可领取」表：以 npm run plan:next 为准');
  assert.doesNotMatch(outside, /其余是待实现|除\s*T00\s*外/, 'R82：页面不写死任务状态');
});
test('任务卡生成能抓住漂移：范围、状态、证据、指引任一处改了卡片就不同', () => {
  const t = task('T05', { title: '校准', writeScope: ['lab/x/', 'docs/y/'], evidence: [{ kind: 'file', ref: 'docs/y/a.md' }, { kind: 'command', ref: 'node --test tests/a.test.mjs', note: '3 项通过' }, { kind: 'commit', ref: 'c16f0b7880ae128ce8ef270395d2d80a7f36f715' }], status: 'done', playbook: 'docs/routes/beiming-style.md' });
  const base = formatCards(plan2([t]));
  assert.match(base, /- 证据：`docs\/y\/a\.md`；`node --test tests\/a\.test\.mjs`（3 项通过）；提交 `c16f0b7`。/);
  assert.match(base, /- 详细指引：\[beiming-style\.md\]\(beiming-style\.md\)。/);
  const variants = [{ writeScope: ['lab/x/'] }, { status: 'planned' }, { evidence: t.evidence.slice(1) }, { playbook: 'docs/routes/raea-native.md' }, { acceptance: ['verified', 'extra'] }];
  for (const v of variants) assert.notEqual(formatCards(plan2([{ ...t, ...v }])), base, JSON.stringify(v));
});

// ───── 命令行 ─────

test('命令行：--help 退出 0 不读计划；未知参数退出 2；--json 只输出一个对象；动作互斥', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /plan:check/);
  const bogus = run(['--bogus', '--json']);
  assert.equal(bogus.status, 2);
  assert.equal(JSON.parse(bogus.stdout).error.code, 'usage.unknown-option');
  const both = run(['--check', '--ready']);
  assert.equal(both.status, 2);
  const ok = run(['--check', '--json', '--now', '2026-11-10']);
  assert.equal(ok.status, 0, ok.stderr);
  const env = JSON.parse(ok.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.data.total, canonicalPlan().tasks.length);
  assert.equal(run(['--ready', '--route', 'c', '--json']).status, 0, '计划 M2 的验收');
  const nope = run(['--ready', '--route', 'nope']);
  assert.equal(nope.status, 2);
  assert.match(nope.stderr, /只能是 a（.*）、b（.*）、c（.*）、shared/);
  assert.equal(run(['--verify-diff', 'Z99']).status, 2, '未知任务');
  assert.equal(run(['--base', 'HEAD']).status, 2, '--base 只和 --verify-diff 一起用');
});
test('旧名 npm run routes:check / routes:next 照样能用，但提示改名为 plan:*', () => {
  const r = run(['--ready', '--json'], { npm_lifecycle_event: 'routes:next' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /routes:next 已改名为 npm run plan:next/);
  assert.ok(JSON.parse(r.stdout).warnings.some(w => w.code === 'plan.renamed'));
  assert.doesNotMatch(run(['--check'], { npm_lifecycle_event: 'plan:check' }).stderr, /已改名/);
});
test('经符号链接、目录联接或 /tmp 别名启动照样校验：坏计划退出 4', t => {
  const dir = tmp('work-plan-');
  try {
    const link = join(dir, 'tools');
    try { symlinkSync(HERE, link, 'junction'); } catch (error) { t.skip(`建不了链接：${error.code}`); return; }
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify(plan([task('T01', { status: 'done', dependsOn: ['T99'] })])));
    const r = (...args) => spawnSync(process.execPath, [join(link, 'work-plan.mjs'), ...args], { encoding: 'utf8' });
    const broken = r('--check', '--file', bad);
    assert.equal(broken.status, 4, broken.stdout + broken.stderr);
    assert.match(broken.stdout, /标成 done 必须有证据/);
    assert.match(broken.stdout, /依赖的 T99 不在计划里/);
    assert.equal(r('--bogus').status, 2);
    const ok = r('--check', '--now', '2026-11-10');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /计划有效/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('入口判断按真实路径比较', () => {
  assert.equal(isEntryPoint(undefined), false);
  assert.equal(isEntryPoint('/no/such/work-plan.mjs'), false);
  assert.equal(isEntryPoint(fileURLToPath(new URL('./work-plan.mjs', import.meta.url)), new URL('./work-plan.mjs', import.meta.url).href), true);
});
test('镜头模版用整数的全局帧起点，事件落在镜头区间内', () => {
  const shot = JSON.parse(readFileSync(join(ROOT, 'docs/routes/templates/shot.json'), 'utf8'));
  for (const id of shot.actorTracks) {
    const origin = shot.actorClockOrigin[id];
    assert.ok(Number.isInteger(origin) && origin >= 0 && origin <= shot.inFrame, id);
    assert.ok(Number.isFinite((shot.inFrame + 12 - origin) / 24), id);
  }
  assert.ok(shot.visibleEvents.every(e => Number.isInteger(e.atFrame) && e.atFrame >= shot.inFrame && e.atFrame < shot.outFrame));
});
