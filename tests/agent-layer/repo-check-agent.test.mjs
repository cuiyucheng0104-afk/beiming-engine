// 北冥仓库 · 规范检查 agent 域规则测试（node --test tests/agent-layer/repo-check-agent.test.mjs）
// 测什么：tools/repo-check/rules/agent/ 的每个文件都能被 P02 的规则加载器当成一条规则加载（一个文件一条规则，
//         导出 { id, title, run(ctx) }，以 _ 开头的是辅助模块）；在真实仓库与最小夹具上全过；每条规则在对应的违规夹具上
//         报出自己的 id；--staged 时只看索引；经 node tools/repo-check.mjs --only agent 的命令行接线可用。
// 夹具是系统临时目录里的一次性 git 仓库（只 git add，不提交），结束时删掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../../tools/repo-check/core/loader.mjs';
import { createContext } from '../../tools/repo-check/core/context.mjs';
import { isInstructionFile } from '../../.claude/hooks/lib/policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES_DIR = path.join(ROOT, 'tools', 'repo-check', 'rules');
const CLI = path.join(ROOT, 'tools', 'repo-check.mjs');
const EXPECTED = ['agent.githooks', 'agent.guard-config', 'agent.instruction-files', 'agent.search-scope', 'agent.skills', 'agent.vendor-warning'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-agent-rules-'));
// 进程退出时也清一次：node --test tests/agent-layer 把各文件导进同一个进程，带顶层 await 的文件注册的根级 after 钩子可能不执行
const cleanup = () => fs.rmSync(TMP, { recursive: true, force: true });
test.after(cleanup);
process.once('exit', cleanup);

const loaded = await loadRules(RULES_DIR);
const AGENT = loaded.rules.filter(r => r.domain === 'agent');
let seq = 0;

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
}
function put(dir, rel, content) {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}
const copy = (dir, rel) => put(dir, rel, fs.readFileSync(path.join(ROOT, ...rel.split('/'))));

/** 一个让 agent 域全部规则通过的最小 git 仓库（文件都已暂存，钩子在索引里是 100755）。 */
function fixture() {
  const dir = path.join(TMP, `fx-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of ['.claude/settings.json', '.ignore', 'cases/vendor/README.md', '.githooks/pre-commit']) copy(dir, rel);
  put(dir, '.claude/hooks/guard.mjs', '// 夹具\n');
  put(dir, '.githooks/pre-commit.mjs', '// 夹具\n');
  put(dir, 'AGENTS.md', '# 规则\n');
  put(dir, 'CLAUDE.md', '@AGENTS.md\n');
  put(dir, '.claude/skills/beiming-film/SKILL.md', '---\nname: beiming-film\ndescription: 在北冥仓库里做动画、短片与风格化渲染时的入口流程（夹具）\n---\n\n读 `AGENTS.md`。\n');
  const wl = { schemaVersion: 1, files: ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.claude/skills/beiming-film/SKILL.md'].map(p => ({ path: p, role: '夹具' })) };
  put(dir, 'tools/repo-check/rules/agent/instruction-files.json', JSON.stringify(wl, null, 2));
  git(dir, ['init', '-q']);
  git(dir, ['add', '--', '.claude', '.ignore', '.githooks', 'cases', 'AGENTS.md', 'CLAUDE.md', 'tools']);
  git(dir, ['update-index', '--chmod=+x', '--', '.githooks/pre-commit']);   // Windows 上 git add 不带可执行位
  return dir;
}

async function check(dir, only, { staged = null } = {}) {
  const ctx = createContext({ root: dir, staged });
  const out = [];
  for (const r of AGENT) {
    if (only && !only.includes(r.id)) continue;
    for (const f of await r.run(ctx)) out.push({ rule: r.id, ...f });
  }
  return out;
}
const errors = findings => findings.filter(f => f.level === 'error');
const ids = findings => [...new Set(errors(findings).map(f => f.rule))].sort();
const text = findings => errors(findings).map(f => `${f.message}｜${f.hint ?? ''}`).join('\n');

test('加载器：agent 目录下每个规则文件都能加载（一个文件一条规则），_shared.mjs 不当规则', () => {
  const mine = loaded.problems.filter(p => String(p.file).includes('rules/agent/'));
  assert.deepEqual(mine, [], mine.map(p => `${p.file}：${p.message}`).join('\n'));
  assert.deepEqual(AGENT.map(r => r.id).sort(), EXPECTED);
  for (const r of AGENT) assert.ok(r.title.length > 8 && typeof r.run === 'function', `${r.id} 的 title / run 不对`);
  // 加载规则文件不能有副作用：旧的 run.mjs 在导入时直接执行并 process.exit，劫持了整个 repo-check
  const files = fs.readdirSync(path.join(RULES_DIR, 'agent')).filter(f => f.endsWith('.mjs'));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(RULES_DIR, 'agent', f), 'utf8'), /process\.(exit|argv)/, `${f} 不能读命令行参数或退出进程`);
});

test('真实仓库：agent 规则没有错误', async () => {
  const f = await check(ROOT);
  assert.deepEqual(errors(f), [], text(f));
});

test('最小夹具全部通过（夹具本身是对的）', async () => {
  const f = await check(fixture());
  assert.deepEqual(errors(f), [], text(f));
});

test('agent.instruction-files：子目录指令文件与白名单不一致', async () => {
  const dir = fixture();
  put(dir, 'films/demo/AGENTS.md', '# x\n');
  put(dir, 'engine/core/CLAUDE.md', '@AGENTS.md\n');
  put(dir, 'routes/x/.claude-plugin/plugin.json', '{}');
  git(dir, ['rm', '-q', '-r', '--cached', '--', '.claude/skills/beiming-film']);
  fs.rmSync(path.join(dir, '.claude', 'skills', 'beiming-film'), { recursive: true });
  const f = await check(dir, ['agent.instruction-files']);
  assert.deepEqual(ids(f), ['agent.instruction-files']);
  const msg = text(f);
  for (const p of ['films/demo/AGENTS.md', 'engine/core/CLAUDE.md', 'routes/x/.claude-plugin/plugin.json']) assert.ok(msg.includes(p), `没有报 ${p}`);
  assert.match(msg, /白名单登记了 \.claude\/skills\/beiming-film\/SKILL\.md/);
  assert.match(msg, /README\.md/, '提示要说子目录说明写成 README.md');
  // 个人本地配置未跟踪时不算
  const dir2 = fixture();
  put(dir2, '.claude/settings.local.json', '{}');
  put(dir2, 'CLAUDE.local.md', '个人笔记\n');
  assert.deepEqual(errors(await check(dir2, ['agent.instruction-files'])), []);
  for (const [p, want] of [['a/AGENTS.md', true], ['a/agents.md', true], ['x/SKILL.md', true], ['x/DIRECTOR.md', true], ['.claude/settings.local.json', true],
    ['.claude/commands/x.md', true], ['.mcp.json', true], ['a\\GEMINI.md', true], ['x/README.md', false], ['films/x/main.js', false], ['.claude/hooks/README.md', false]]) {
    assert.equal(isInstructionFile(p), want, p);
  }
});

test('agent.instruction-files：--staged（提交前检查）只看索引，不因没打算提交的文件挡住提交', async () => {
  const dir = fixture();
  put(dir, 'films/demo/AGENTS.md', '# x\n');
  const staged = new Set(['README.md']);
  assert.deepEqual(errors(await check(dir, ['agent.instruction-files'], { staged })), [], '未跟踪的不算');
  git(dir, ['add', '--', 'films/demo/AGENTS.md']);
  assert.deepEqual(ids(await check(dir, ['agent.instruction-files'], { staged })), ['agent.instruction-files'], '暂存了就要报');
});

test('--staged（提交前检查）时 agent 域全部读索引：工作区里没暂存的改动与删除不算，暂存了才算', async () => {
  const dir = fixture();
  const staged = new Set(['README.md']);
  // 工作区里删掉 skill 引用的文件、削弱 settings.json、删掉 .ignore 与 vendor README，都不暂存
  fs.rmSync(path.join(dir, 'AGENTS.md'));
  const base = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  put(dir, '.claude/settings.json', JSON.stringify({ ...base, permissions: { deny: [] } }));
  fs.rmSync(path.join(dir, '.ignore'));
  put(dir, 'cases/vendor/README.md', '# 没有警示\n');
  put(dir, '.githooks/pre-commit', '#!/bin/sh\r\necho 坏了\r\n');
  assert.deepEqual(errors(await check(dir, null, { staged })), [], '索引里这次要提交的版本都合格，不该拦');
  assert.deepEqual(ids(await check(dir)), ['agent.githooks', 'agent.guard-config', 'agent.search-scope', 'agent.skills', 'agent.vendor-warning'], '全量检查照常按工作区判');
  // 把这些改动暂存进提交后，--staged 也要报（删掉的 AGENTS.md 还登记在白名单里，instruction-files 一并报）
  git(dir, ['add', '--', '.claude/settings.json', '.ignore', 'cases/vendor/README.md', '.githooks/pre-commit', 'AGENTS.md']);
  const f = await check(dir, null, { staged });
  assert.deepEqual(ids(f), ['agent.githooks', 'agent.guard-config', 'agent.instruction-files', 'agent.search-scope', 'agent.skills', 'agent.vendor-warning']);
  assert.match(text(f), /引用的 AGENTS\.md 不存在/);
  assert.match(text(f), /白名单登记了 AGENTS\.md/);
  // 未跟踪的新 skill 目录不算这次提交的 skill
  const dir2 = fixture();
  put(dir2, '.claude/skills/beiming-x/SKILL.md', '没有头\n');
  assert.deepEqual(errors(await check(dir2, ['agent.skills'], { staged })), []);
  assert.match(text(await check(dir2, ['agent.skills'])), /beiming-x\/SKILL\.md 缺 YAML 头/);
});

test('agent.guard-config：拒绝规则、钩子接线、插件禁用、排除项缺一不可', async () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const mutate = [
    [s => { s.permissions.deny = s.permissions.deny.filter(r => r !== 'Bash(git add -A)'); }, /Bash\(git add -A\)/],
    [s => { s.permissions.deny = s.permissions.deny.filter(r => !r.startsWith('Edit(/cases/vendor')); }, /Edit\(\/cases\/vendor/],
    [s => { s.hooks.PreToolUse = s.hooks.PreToolUse.filter(m => m.matcher === 'Read'); }, /Write.*Bash.*Skill/],
    [s => { s.hooks.PreToolUse[0].matcher = 'Write|Edit'; }, /MultiEdit/],
    [s => { s.enabledPlugins = {}; }, /lemo-opuscar@lemolab/],
    [s => { s.claudeMdExcludes = ['**/cases/source/**']; }, /cases\/vendor/],
  ];
  for (const [m, want] of mutate) {
    const dir = fixture();
    const s = structuredClone(base);
    m(s);
    put(dir, '.claude/settings.json', JSON.stringify(s));
    const f = await check(dir, ['agent.guard-config']);
    assert.deepEqual(ids(f), ['agent.guard-config']);
    assert.match(text(f), want);
  }
  const dir = fixture();
  put(dir, '.claude/settings.json', '{ 坏 JSON');
  assert.match(text(await check(dir, ['agent.guard-config'])), /不是合法 JSON/);
  fs.rmSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
  put(dir, '.claude/settings.json', JSON.stringify(base));
  assert.match(text(await check(dir, ['agent.guard-config'])), /guard\.mjs 不存在/);
});

test('agent.skills：缺入口 skill、缺 YAML 头、名字与目录不符、引用的路径不存在、引导调用全局风格库', async () => {
  const dir = fixture();
  put(dir, '.claude/skills/beiming-film/SKILL.md', '---\nname: other\ndescription: 太短\n---\n读 `routes/nope.md`，再 Skill(lemo-opuscar:lemo-opuscar)。\n');
  put(dir, '.claude/skills/beiming-x/SKILL.md', '没有头\n');
  const msg = text(await check(dir, ['agent.skills']));
  assert.match(msg, /应与目录名 beiming-film 相同/);
  assert.match(msg, /description 太短/);
  assert.match(msg, /routes\/nope\.md 不存在/);
  assert.match(msg, /全局第三方风格库/);
  assert.match(msg, /beiming-x\/SKILL\.md 缺 YAML 头/);
  const dir2 = fixture();
  fs.rmSync(path.join(dir2, '.claude', 'skills', 'beiming-film'), { recursive: true });
  put(dir2, '.claude/skills/other/SKILL.md', '---\nname: other\ndescription: 在北冥仓库里的另一个 skill，用来测缺入口\n---\n');
  assert.match(text(await check(dir2, ['agent.skills'])), /缺 \.claude\/skills\/beiming-film\/SKILL\.md/);
});

test('agent.search-scope：.ignore 缺排除项，或把该搜的目录也排除了', async () => {
  const dir = fixture();
  put(dir, '.ignore', 'cases/source/\nengine/\n');
  const msg = text(await check(dir, ['agent.search-scope']));
  assert.match(msg, /没有排除 cases\/vendor/);
  assert.match(msg, /「engine」/);
  put(dir, '.ignore', 'cases/vendor/\ncases/source/\ncases/\n');
  assert.match(text(await check(dir, ['agent.search-scope'])), /cases\/entries|cases\/INDEX/, '整个 cases/ 都排除会连案例卡一起排掉');
  fs.rmSync(path.join(dir, '.ignore'));
  assert.deepEqual(ids(await check(dir, ['agent.search-scope'])), ['agent.search-scope']);
});

test('agent.githooks：CRLF、首行不是 sh、不调用检查脚本、索引里不可执行、缺文件', async () => {
  const dir = fixture();
  put(dir, '.githooks/pre-commit', '#!/bin/sh\r\nexec node "$hook_dir/pre-commit.mjs"\r\n');
  assert.match(text(await check(dir, ['agent.githooks'])), /CRLF/);
  put(dir, '.githooks/pre-commit', 'exec node x\n');
  const msg = text(await check(dir, ['agent.githooks']));
  assert.match(msg, /第一行/);
  assert.match(msg, /没有调用 \.githooks\/pre-commit\.mjs/);
  copy(dir, '.githooks/pre-commit');
  git(dir, ['update-index', '--chmod=-x', '--', '.githooks/pre-commit']);
  assert.match(text(await check(dir, ['agent.githooks'])), /100755/);
  fs.rmSync(path.join(dir, '.githooks'), { recursive: true });
  assert.match(text(await check(dir, ['agent.githooks'])), /缺 \.githooks\/pre-commit/);
});

test('agent.vendor-warning：vendor README 顶部没有优先级警示', async () => {
  const dir = fixture();
  put(dir, 'cases/vendor/README.md', '# 完整风格基座快照\n\n说明。\n');
  const f = await check(dir, ['agent.vendor-warning']);
  assert.deepEqual(ids(f), ['agent.vendor-warning']);
  assert.match(text(f), /给 agent 的优先级警示/);
  fs.rmSync(path.join(dir, 'cases'), { recursive: true });
  assert.deepEqual(errors(await check(dir, ['agent.vendor-warning'])), [], '没有 cases/vendor/ 时不要求');
});

test('快照里建了作品目录（上游让 agent 放进克隆里的 films/）：仓库规范检查报错，即使快照自己的 .gitignore 把它藏起来', () => {
  // 这一条由治理骨架的 core.vendor-immutable 判（agent 域不重复）；这里守住 P03 的要求「cases/vendor/*/films 不得存在」
  const dir = fixture();
  put(dir, 'cases/vendor/demo/a.txt', 'x');
  put(dir, 'cases/vendor/demo/.gitignore', 'films/\nout/\n');
  put(dir, 'cases/vendor/lock.json', JSON.stringify({ version: 1, repositories: [{ name: 'demo', path: 'vendor/demo', files: [{ path: 'a.txt', size: 1 }, { path: '.gitignore', size: 11 }] }] }));
  put(dir, 'cases/vendor/demo/films/my-film/index.html', '<html>');
  git(dir, ['add', '--', 'cases']);
  assert.equal(git(dir, ['status', '--porcelain', '--', 'cases/vendor/demo/films']).trim(), '', 'git status 看不见被快照 .gitignore 藏起来的 films/');
  const r = spawnSync(process.execPath, [CLI, '--only', 'core.vendor-immutable', '--root', dir, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true });
  const o = JSON.parse(r.stdout);
  assert.ok(o.data.findings.some(f => f.level === 'error' && f.file === 'cases/vendor/demo/films'), JSON.stringify(o.data.findings).slice(0, 400));
  assert.notEqual(r.status, 0);
});

test('命令行：node tools/repo-check.mjs --only agent 能跑到 agent 域，违规时非零退出，--json 是统一信封', () => {
  const run = args => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true });
  const list = run(['--list']);
  assert.equal(list.status, 0, list.stderr);
  for (const id of EXPECTED) assert.ok(list.stdout.includes(id), `--list 里没有 ${id}`);
  const dir = fixture();
  put(dir, 'films/demo/AGENTS.md', '# x\n');
  for (const only of ['agent', 'agent.instruction-files']) {
    const r = run(['--only', only, '--root', dir, '--json']);
    const o = JSON.parse(r.stdout);
    for (const k of ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings']) assert.ok(k in o, `信封缺 ${k}`);
    assert.equal(o.exitCode, r.status);
    const mine = o.data.findings.filter(f => f.rule === 'agent.instruction-files' && f.level === 'error');
    assert.ok(mine.some(f => f.file === 'films/demo/AGENTS.md'), JSON.stringify(o.data.findings).slice(0, 400));
    // 别的域的规则文件加载失败时执行器整体退出 1（结果不完整），否则规范错误退出 4
    const loaderBroken = o.data.findings.some(f => f.rule === 'core.loader');
    assert.equal(r.status, loaderBroken ? 1 : 4, `退出码 ${r.status}`);
  }
});
