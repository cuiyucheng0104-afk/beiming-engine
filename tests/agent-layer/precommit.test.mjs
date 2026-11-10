// 北冥仓库 · 提交前检查端到端测试（node --test tests/agent-layer/precommit.test.mjs）
// 测什么：在一次性 git 仓库里启用 .githooks，真由 git commit 调起钩子：合规改动照常提交；本文件自己的检查（vendor、source、
//         films-out、instructions、bridge、conflict）与交给已有工具的检查（large → tools/env/large-files.mjs、compliance →
//         tools/compliance/scan.mjs --staged、eol → env 规则的 env.eol、repo-check → tools/repo-check.mjs --staged）各自拦下违规；
//         规范检查「规则自身出错」只提示不阻断；合并提交只查冲突的解决结果；--json 是 docs/CLI.md 的信封；--help 无副作用；
//         CLAUDECODE=1 时 BEIMING_PRECOMMIT_ALLOW 不生效；git 子进程超时退出 124。
// 夹具里复制的是仓库里真实的 P10 / P01 工具（集成测试）。规范检查分两组：
//   - 替身执行器：按约定输出 JSON，测「规则自身出错只提示」「--only 不重跑 comp 与 env」这类接线；
//   - 真实执行器（tools/repo-check.mjs、core 框架、tools/lib）加读工作区的真实规则（core.vendor-immutable、core.films、
//     core.ascii-paths、agent.skills）：测发现按路径归属——工作区里与这次提交不一致的路径只提示，带进提交或与提交一致的照常阻断。
// 测试进程的环境里如果有 CLAUDECODE（在 Claude Code 里跑），git 子进程一律清掉它，需要时由用例自己设。
// 夹具建在系统临时目录，结束时删掉；不碰真实仓库与全局 git 配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-precommit-'));
const cleanup = () => fs.rmSync(TMP, { recursive: true, force: true });
test.after(cleanup);
process.once('exit', cleanup);          // 同一进程跑整个目录时的兜底

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const NEEDED = ['.githooks/pre-commit', '.githooks/pre-commit.mjs', 'tools/lib/cli.mjs',
  'tools/repo-check/rules/agent/instruction-files.json', '.claude/hooks/lib/policy.mjs'];
const TOOL_DIRS = ['tools/env', 'tools/compliance'];                       // P10 大文件闸门与 env 规则的库、P01 合规扫描
const TOOL_FILES = ['tools/repo-check/rules/env/index.mjs'];              // P10 env 规则的命令行入口（env.eol）
const OWN_AND_INDEX = 'vendor,source,films-out,instructions,bridge,conflict,large,eol';
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  BEIMING_PRECOMMIT_ALLOW: '', CLAUDECODE: '', BEIMING_PRECOMMIT_GIT_TIMEOUT_MS: '' };
let seq = 0;

function git(dir, args, { env = {}, input } = {}) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd: dir, encoding: 'utf8', input, windowsHide: true, timeout: 180000,
    env: { ...process.env, ...GIT_ENV, ...env },
  });
}
function put(dir, rel, content) {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

/** 一个最小仓库：钩子与它要用的模块、P10 / P01 的工具、一份迷你 vendor 快照与 lock、一个归档文件、根 CLAUDE.md；启用 .githooks。
 *  第一次调用时建一份模板，之后每个用例复制模板（连同 .git），省掉重复的 init 与首次提交。 */
let template = null;
function makeRepo() {
  template ??= buildTemplate();
  const dir = path.join(TMP, `repo-${++seq}`);
  fs.cpSync(template, dir, { recursive: true });
  return dir;
}
function buildTemplate() {
  const dir = path.join(TMP, 'template');
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of [...NEEDED, ...TOOL_FILES]) put(dir, rel, fs.readFileSync(path.join(ROOT, ...rel.split('/'))));
  for (const rel of TOOL_DIRS) fs.cpSync(path.join(ROOT, ...rel.split('/')), path.join(dir, ...rel.split('/')), { recursive: true, filter: s => !/__pycache__|node_modules/.test(s) });
  fs.chmodSync(path.join(dir, '.githooks', 'pre-commit'), 0o755);
  put(dir, 'AGENTS.md', '# 规则\n');
  put(dir, 'CLAUDE.md', '@AGENTS.md\n');
  put(dir, 'cases/vendor/README.md', '# 快照\n');
  put(dir, 'cases/vendor/demo/a.txt', 'upstream\n');
  put(dir, 'cases/source/old/main.js', 'console.log(1)\n');
  put(dir, 'films/keep/main.js', 'export const x = 1;\n');
  const blob = git(dir, ['hash-object', 'cases/vendor/demo/a.txt']);   // init 之前也能算（不写对象）
  put(dir, 'cases/vendor/lock.json', JSON.stringify({ version: 1, repositories: [{ name: 'demo', path: 'vendor/demo', files: [{ path: 'a.txt', mode: '100644', gitBlob: blob.stdout.trim() }] }] }, null, 2));
  assert.equal(git(dir, ['init', '-q']).status, 0);
  assert.equal(git(dir, ['add', '--', ...listAll(dir)]).status, 0);
  assert.equal(git(dir, ['update-index', '--chmod=+x', '--', '.githooks/pre-commit']).status, 0);
  const c = git(dir, ['commit', '-q', '--no-verify', '-m', 'init']);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(git(dir, ['config', 'core.hooksPath', '.githooks']).status, 0);
  return dir;
}
function listAll(dir, sub = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listAll(dir, rel)); else out.push(rel);
  }
  return out;
}
/** 写入并暂存这些文件，然后提交；返回 git commit 的结果。 */
function commitWith(dir, files, { env, message = 'x' } = {}) {
  for (const [rel, content] of Object.entries(files)) put(dir, rel, content);
  const add = git(dir, ['add', '--', ...Object.keys(files)]);
  assert.equal(add.status, 0, add.stderr);
  return git(dir, ['commit', '-q', '-m', message], { env });
}
const commits = dir => git(dir, ['rev-list', '--count', 'HEAD']).stdout.trim();
const runDirect = (dir, args, env = {}) => spawnSync(process.execPath, [path.join(dir, '.githooks', 'pre-commit.mjs'), ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env }, windowsHide: true, timeout: 180000,
});

const skip = HAS_GIT ? false : '本机没有 git';

test('合规改动照常提交：作品源码、vendor README、新增归档、样例配置、LF 脚本', { skip }, () => {
  const dir = makeRepo();
  const r = commitWith(dir, {
    'films/demo/main.js': 'export default 1;\n', 'films/demo/film.json': '{"route":"c"}\n', 'films/demo/README.md': '# 演示\n',
    'cases/vendor/README.md': '# 快照\n> 给 agent 的优先级警示\n', 'cases/source/new/main.js': 'console.log(2)\n', '.env.example': 'KEY=\n',
    'tools/build.sh': '#!/bin/sh\necho ok\n',
  });
  assert.equal(r.status, 0, `应提交成功：${r.stderr}`);
  assert.equal(commits(dir), '2');
});

const blocked = [
  ['vendor', { 'cases/vendor/demo/a.txt': 'changed\n' }],
  ['vendor', { 'cases/vendor/lock.json': '{}\n' }],
  ['source', { 'cases/source/old/main.js': 'console.log(3)\n' }],
  ['films-out', { 'films/demo/out/frame_0001.png': 'png' }],
  ['films-out', { 'films/demo/mix.wav': 'RIFF' }],
  ['films-out', { 'films/demo/cut.mp4': 'mp4' }],
  ['instructions', { 'films/demo/AGENTS.md': '# 子目录指令\n' }],
  ['instructions', { '.claude/skills/new-skill/SKILL.md': '---\nname: new-skill\ndescription: x\n---\n' }],
  ['bridge', { 'CLAUDE.md': '@AGENTS.md\n另外的规则\n' }],
  ['conflict', { 'films/demo/main.js': '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n' }],
  ['large', { 'films/demo/plate.bin': Buffer.alloc(5 * 1024 * 1024 + 1, 1) }],
  ['compliance', { '.env': 'TOKEN=abc\n' }],
  ['compliance', { 'films/demo/key.pem': 'x' }],
  ['compliance', { 'films/demo/notes.md': `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----\nabc\n` }],   // 拆开写，免得本文件自己被当成私钥
  ['eol', { 'tools/run.sh': '#!/bin/sh\r\necho hi\r\n' }],
];
for (const [id, files] of blocked) {
  test(`拦下 ${id}：${Object.keys(files).join('、')}`, { skip }, () => {
    const dir = makeRepo();
    const r = commitWith(dir, files);
    assert.notEqual(r.status, 0, '应被拦下，实际提交成功');
    assert.match(r.stderr, new RegExp(`\\[${id}\\]`), `报错里要有 [${id}]：\n${r.stderr}`);
    assert.match(r.stderr, /提交已中止/);
    assert.equal(commits(dir), '1', '不应产生新提交');
  });
}

test('按路径提交（git commit -- <路径>，git 用临时索引）：只判这次真正要提交的内容', { skip }, () => {
  const dir = makeRepo();
  put(dir, 'cases/vendor/demo/a.txt', 'tampered\n');
  assert.equal(git(dir, ['add', '--', 'cases/vendor/demo/a.txt']).status, 0);   // 暂存了快照改动，但这次不提交它
  put(dir, 'films/keep/main.js', 'export const x = 5;\n');
  const ok = git(dir, ['commit', '-q', '-m', 'only film', '--', 'films/keep/main.js']);
  assert.equal(ok.status, 0, `只提交作品文件应放行：${ok.stderr}`);
  const bad = git(dir, ['commit', '-q', '-m', 'vendor', '--', 'cases/vendor/demo/a.txt']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /\[vendor\]/);
  assert.equal(commits(dir), '2');
});

test('删除归档或根 CLAUDE.md 也拦下', { skip }, () => {
  const dir = makeRepo();
  assert.equal(git(dir, ['rm', '-q', 'cases/source/old/main.js']).status, 0);
  const r = git(dir, ['commit', '-q', '-m', 'rm']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\[source\]/);
  const dir2 = makeRepo();
  assert.equal(git(dir2, ['rm', '-q', 'CLAUDE.md']).status, 0);
  const r2 = git(dir2, ['commit', '-q', '-m', 'rm']);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /\[bridge\]/);
});

test('BEIMING_PRECOMMIT_ALLOW 只放行点名的检查', { skip }, () => {
  const dir = makeRepo();
  const ok = commitWith(dir, { 'cases/vendor/demo/a.txt': 'upgraded\n' }, { env: { BEIMING_PRECOMMIT_ALLOW: 'vendor' } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /本次放行/);
  const dir2 = makeRepo();
  const no = commitWith(dir2, { 'cases/vendor/demo/a.txt': 'x\n', 'films/demo/out/a.png': 'x' }, { env: { BEIMING_PRECOMMIT_ALLOW: 'vendor' } });
  assert.notEqual(no.status, 0);
  assert.match(no.stderr, /\[films-out\]/);
  assert.doesNotMatch(no.stderr, /\[vendor\]/);
});

test('CLAUDECODE=1（Claude Code 的工具发起的提交）时 BEIMING_PRECOMMIT_ALLOW 不生效，照常拦下', { skip }, () => {
  const dir = makeRepo();
  const r = commitWith(dir, { 'cases/vendor/demo/a.txt': 'upgraded\n' }, { env: { BEIMING_PRECOMMIT_ALLOW: 'vendor', CLAUDECODE: '1' } });
  assert.notEqual(r.status, 0, 'agent 会话里设的放行不该生效');
  assert.match(r.stderr, /CLAUDECODE=1/);
  assert.match(r.stderr, /Claude Code 之外的终端/);
  assert.match(r.stderr, /\[vendor\]/);
  assert.doesNotMatch(r.stderr, /本次放行/);
  assert.equal(commits(dir), '1');
});

test('大文件按 LARGE-FILES.allow 判定（P10 的 sha256 + 字节数格式）：登记了放行，内容换了照样拦', { skip }, () => {
  const dir = makeRepo();
  const big = Buffer.alloc(6 * 1024 * 1024, 2);
  const line = `${crypto.createHash('sha256').update(big).digest('hex')}  ${big.length}  media/a.mp4\n`;
  const r = commitWith(dir, { 'LARGE-FILES.allow': `# 现有大文件\n${line}`, 'media/a.mp4': big });
  assert.equal(r.status, 0, r.stderr);
  const again = commitWith(dir, { 'media/a.mp4': Buffer.alloc(6 * 1024 * 1024, 4) });
  assert.notEqual(again.status, 0, '登记过的大文件内容变了要拦');
  assert.match(again.stderr, /\[large\]/);
});

test('合并提交：只查冲突的解决结果；另一边已提交的 vendor 改动不算这次引入', { skip }, () => {
  const dir = makeRepo();
  assert.equal(git(dir, ['checkout', '-q', '-b', 'side']).status, 0);
  assert.equal(commitWith(dir, { 'cases/vendor/demo/a.txt': 'upgraded\n', 'films/keep/main.js': 'export const x = 2;\n' }, { env: { BEIMING_PRECOMMIT_ALLOW: 'vendor' } }).status, 0);
  assert.equal(git(dir, ['checkout', '-q', 'main']).status, 0);
  assert.equal(commitWith(dir, { 'films/keep/main.js': 'export const x = 3;\n' }).status, 0);
  assert.notEqual(git(dir, ['merge', '-q', 'side']).status, 0, '应当有冲突');
  put(dir, 'films/keep/main.js', 'export const x = 4;\n');
  assert.equal(git(dir, ['add', '--', 'films/keep/main.js']).status, 0);
  const ok = git(dir, ['commit', '-q', '--no-edit']);
  assert.equal(ok.status, 0, `解决得干净的合并应放行：${ok.stderr}`);
  assert.match(ok.stderr, /合并提交/);

  const dir2 = makeRepo();
  assert.equal(git(dir2, ['checkout', '-q', '-b', 'side']).status, 0);
  assert.equal(commitWith(dir2, { 'films/keep/main.js': 'export const x = 2;\n' }).status, 0);
  assert.equal(git(dir2, ['checkout', '-q', 'main']).status, 0);
  assert.equal(commitWith(dir2, { 'films/keep/main.js': 'export const x = 3;\n' }).status, 0);
  assert.notEqual(git(dir2, ['merge', '-q', 'side']).status, 0);
  assert.equal(git(dir2, ['add', '--', 'films/keep/main.js']).status, 0);       // 带着冲突标记就加进来
  const bad = git(dir2, ['commit', '-q', '--no-edit']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /\[conflict\]/);
});

/** 规范检查执行器的替身：--list 列出三个域；检查时按 BEIMING_STUB_MODE 输出规则崩溃或真错误，并把收到的参数写进 stub-argv.json。 */
const STUB = `import fs from 'node:fs';
const argv = process.argv.slice(2);
const root = argv[argv.indexOf('--root') + 1];
const env = (o, code) => { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: code === 0, exitCode: code, command: 'repo-check', error: code ? { code: 'x', message: 'x', hint: null } : null, outputs: [], runJson: null, warnings: [], data: o })); process.exitCode = code; };
if (argv.includes('--list')) env({ rules: [{ id: 'core.links', domain: 'core' }, { id: 'comp.secrets', domain: 'comp' }, { id: 'agent.skills', domain: 'agent' }] }, 0);
else {
  fs.writeFileSync(root + '/stub-argv.json', JSON.stringify(argv));
  const mode = process.env.BEIMING_STUB_MODE;
  if (mode === 'crash') env({ findings: [{ rule: 'core.loader', level: 'error', file: 'tools/repo-check/rules/x/index.mjs', message: '规则要导出 { id, title, run(ctx) }' }] }, 1);
  else if (mode === 'error') env({ findings: [{ rule: 'core.links', level: 'error', file: 'docs/x.md', line: 3, message: '链接指向不存在的文件', hint: '改链接' }] }, 4);
  else env({ findings: [] }, 0);
}
`;

test('规范检查：规则自身出错只提示不阻断，真错误阻断；合规与 env 域不重复跑', { skip }, () => {
  const dir = makeRepo();
  put(dir, 'tools/repo-check.mjs', STUB);
  assert.equal(git(dir, ['add', '--', 'tools/repo-check.mjs']).status, 0);
  assert.equal(git(dir, ['commit', '-q', '--no-verify', '-m', 'stub']).status, 0);
  const crash = commitWith(dir, { 'films/demo/main.js': 'export default 1;\n' }, { env: { BEIMING_STUB_MODE: 'crash' } });
  assert.equal(crash.status, 0, `规则崩溃不应挡住提交：${crash.stderr}`);
  assert.match(crash.stderr, /规则自身出错，结果不完整/);
  const argv = JSON.parse(fs.readFileSync(path.join(dir, 'stub-argv.json'), 'utf8'));
  assert.ok(argv.includes('--staged'), '要带 --staged');
  assert.equal(argv[argv.indexOf('--only') + 1], 'core,agent', '合规（P01 已直接扫）与 env（P10 已直接跑）不在 --only 里');
  const error = commitWith(dir, { 'films/demo/b.js': 'export default 2;\n' }, { env: { BEIMING_STUB_MODE: 'error' } });
  assert.notEqual(error.status, 0);
  assert.match(error.stderr, /\[repo-check\] docs\/x\.md:3 core\.links：链接指向不存在的文件/);
});

// ── 真实规范检查：执行器、框架与读工作区的规则都是仓库里的原文件（复核员指出的误拦就出在这里） ──
const RC_FILES = ['tools/repo-check.mjs', 'tools/repo-check/rules/core/vendor-immutable.mjs', 'tools/repo-check/rules/core/films.mjs',
  'tools/repo-check/rules/core/ascii-paths.mjs', 'tools/repo-check/rules/agent/_shared.mjs', 'tools/repo-check/rules/agent/skills.mjs'];
const RC_DIRS = ['tools/repo-check/core', 'tools/lib'];
let rcTemplate = null;
/** 在基础夹具上加真实的规范检查，以及让这几条规则在提交状态下全过的内容（作品 film.json、带 size 的 lock、skill 与它引用的文档）。 */
function makeRcRepo() {
  rcTemplate ??= (() => {
    template ??= buildTemplate();
    const dir = path.join(TMP, 'rc-template');
    fs.cpSync(template, dir, { recursive: true });
    for (const rel of RC_FILES) put(dir, rel, fs.readFileSync(path.join(ROOT, ...rel.split('/'))));
    for (const rel of RC_DIRS) fs.cpSync(path.join(ROOT, ...rel.split('/')), path.join(dir, ...rel.split('/')), { recursive: true, filter: s => !/waivers\.json$|__pycache__/.test(s) });
    put(dir, 'films/keep/film.json', `${JSON.stringify({ route: 'c', title: '保留', dur: 1, fps: 24, size: [1920, 1080] })}\n`);
    put(dir, 'docs/guide.md', '# 指南\n');
    put(dir, '.claude/skills/beiming-film/SKILL.md', '---\nname: beiming-film\ndescription: 在北冥仓库里做动画、短片与风格化渲染时的入口流程（夹具）\n---\n\n先读 `docs/guide.md`。\n');
    const lockFile = path.join(dir, 'cases', 'vendor', 'lock.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.repositories[0].files[0].size = fs.statSync(path.join(dir, 'cases', 'vendor', 'demo', 'a.txt')).size;   // core.vendor-immutable 按大小核对
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2));
    assert.equal(git(dir, ['add', '--', ...RC_FILES, ...RC_DIRS, 'films/keep/film.json', 'docs/guide.md', '.claude/skills/beiming-film/SKILL.md', 'cases/vendor/lock.json']).status, 0);
    const c = git(dir, ['commit', '-q', '--no-verify', '-m', 'repo-check']);
    assert.equal(c.status, 0, c.stderr);
    return dir;
  })();
  const dir = path.join(TMP, `rc-${++seq}`);
  fs.cpSync(rcTemplate, dir, { recursive: true });
  return dir;
}
const touchKeep = (dir, n) => { put(dir, 'films/keep/main.js', `export const x = ${n};\n`); assert.equal(git(dir, ['add', '--', 'films/keep/main.js']).status, 0); };

test('真实规范检查：夹具在提交状态下全过，规范检查确实跑了（不是跳过）', { skip }, () => {
  const dir = makeRcRepo();
  touchKeep(dir, 2);
  const r = runDirect(dir, ['--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const rc = JSON.parse(r.stdout).data.checks.find(c => c.id === 'repo-check');
  assert.ok(['pass', 'warn'].includes(rc.status), `repo-check 应当跑了：${JSON.stringify(rc)}`);
});

test('复核 (a)：按路径提交时另暂存的快照改动只提示；把它带进提交时照样拦（本文件 vendor + core.vendor-immutable）', { skip }, () => {
  const dir = makeRcRepo();
  put(dir, 'cases/vendor/demo/a.txt', 'tampered, longer\n');                        // 大小变了，core.vendor-immutable 才看得出
  assert.equal(git(dir, ['add', '--', 'cases/vendor/demo/a.txt']).status, 0);
  put(dir, 'films/keep/main.js', 'export const x = 5;\n');
  const ok = git(dir, ['commit', '-q', '-m', 'only film', '--', 'films/keep/main.js']);
  assert.equal(ok.status, 0, `只提交作品文件应放行：${ok.stderr}`);
  assert.match(ok.stderr, /只在工作区、不在这次提交里[^\n]*core\.vendor-immutable/);
  const bad = git(dir, ['commit', '-q', '-m', 'vendor', '--', 'cases/vendor/demo/a.txt']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /\[vendor\]/);
  assert.match(bad.stderr, /\[repo-check\] cases\/vendor\/demo core\.vendor-immutable/);
  assert.equal(commits(dir), '3');
});

test('复核 (b)：未跟踪的 films/wip（没有 film.json）只提示；暂存进提交后拦下（core.films）', { skip }, () => {
  const dir = makeRcRepo();
  put(dir, 'films/wip/notes.md', '草稿\n');
  touchKeep(dir, 3);
  const ok = git(dir, ['commit', '-q', '-m', 'unrelated']);
  assert.equal(ok.status, 0, `无关提交应放行：${ok.stderr}`);
  assert.match(ok.stderr, /只在工作区、不在这次提交里：目录里有未跟踪[^\n]*films\/wip core\.films/);
  assert.equal(git(dir, ['add', '--', 'films/wip/notes.md']).status, 0);
  const bad = git(dir, ['commit', '-q', '-m', 'wip']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /\[repo-check\] films\/wip core\.films：作品根目录缺 film\.json/);
});

test('未跟踪的中文目录名只提示；暂存进提交后拦下（core.ascii-paths）；--json 里降级的发现是 warn', { skip }, () => {
  const dir = makeRcRepo();
  put(dir, 'tools/草稿/a.js', 'export {};\n');
  touchKeep(dir, 4);
  const r = runDirect(dir, ['--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const warned = JSON.parse(r.stdout).data.findings.filter(f => f.rule === 'precommit.repo-check' && f.level === 'warn' && /core\.ascii-paths/.test(f.message));
  assert.ok(warned.length && warned.every(f => /只在工作区、不在这次提交里/.test(f.message)), JSON.stringify(warned));
  assert.equal(git(dir, ['add', '--', 'tools/草稿/a.js']).status, 0);
  const bad = runDirect(dir, ['--json']);
  assert.equal(bad.status, 4);
  assert.ok(JSON.parse(bad.stdout).data.findings.some(f => f.level === 'error' && /core\.ascii-paths/.test(f.message)));
});

test('跨文件：工作区里删了 skill 引用的文档但没暂存，不拦（agent.skills 读索引）；删除暂存进提交后拦下与提交一致的 SKILL.md', { skip }, () => {
  const dir = makeRcRepo();
  fs.rmSync(path.join(dir, 'docs', 'guide.md'));
  touchKeep(dir, 6);
  const ok = git(dir, ['commit', '-q', '-m', 'unrelated']);
  assert.equal(ok.status, 0, `工作区里没暂存的删除不该拦：${ok.stderr}`);
  assert.equal(git(dir, ['add', '--', 'docs/guide.md']).status, 0);                // 暂存删除
  const bad = git(dir, ['commit', '-q', '-m', 'rm guide']);
  assert.notEqual(bad.status, 0, '删掉被引用的文档要拦');
  assert.match(bad.stderr, /\[repo-check\] \.claude\/skills\/beiming-film\/SKILL\.md agent\.skills：[^\n]*docs\/guide\.md 不存在/);
});

test('与提交一致的已跟踪路径上的发现照常阻断，并列出工作区里与提交不同的路径', { skip }, () => {
  const dir = makeRcRepo();
  put(dir, 'tools/中文.js', 'export {};\n');                                       // 先绕过检查提交一个存量问题
  assert.equal(git(dir, ['add', '--', 'tools/中文.js']).status, 0);
  assert.equal(git(dir, ['commit', '-q', '--no-verify', '-m', 'legacy']).status, 0);
  put(dir, 'notes.txt', '没提交的笔记\n');
  touchKeep(dir, 7);
  const bad = git(dir, ['commit', '-q', '-m', 'unrelated']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /\[repo-check\] tools\/中文\.js core\.ascii-paths[^\n]*工作区里另有 1 处与这次提交不同：notes\.txt/);
});

test('直接运行：退出码、--json 信封、--all 按 lock.json 核对快照', { skip }, () => {
  const dir = makeRepo();
  const clean = runDirect(dir, ['--all', '--json', '--only', OWN_AND_INDEX]);
  assert.equal(clean.status, 0, clean.stderr);
  const c = JSON.parse(clean.stdout);
  assert.equal(c.ok, true);
  assert.equal(c.data.all, true);
  assert.deepEqual(c.data.checks.filter(x => x.status === 'fail'), []);

  put(dir, 'films/demo/out/a.mp4', 'x');
  git(dir, ['add', '--', 'films/demo/out/a.mp4']);
  const bad = runDirect(dir, ['--json']);
  assert.equal(bad.status, 4);
  const o = JSON.parse(bad.stdout);
  for (const k of ['schemaVersion', 'ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings', 'data']) assert.ok(k in o, `信封缺 ${k}`);
  assert.equal(o.exitCode, 4);
  assert.equal(o.error.code, 'contract.precommit');
  assert.deepEqual([...new Set(o.data.findings.filter(f => f.level === 'error').map(f => f.rule))], ['precommit.films-out']);
  git(dir, ['reset', '-q']);

  put(dir, 'cases/vendor/demo/a.txt', 'tampered\n');
  put(dir, 'cases/vendor/demo/extra.js', 'x');
  git(dir, ['add', '--', 'cases/vendor/demo/a.txt', 'cases/vendor/demo/extra.js']);
  const all = runDirect(dir, ['--all', '--json', '--only', 'vendor']);
  assert.equal(all.status, 4);
  const msgs = JSON.parse(all.stdout).data.findings.map(f => f.message).join('\n');
  assert.match(msgs, /不在 cases\/vendor\/lock\.json 里/);
  assert.match(msgs, /不一致/);

  const unknown = runDirect(dir, ['--only', 'nope', '--json']);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).error.code, 'usage.unknown-check');
  assert.equal(runDirect(dir, ['--bogus']).status, 2);
});

test('git 子进程超时：按附录 C1 退出 124，信封里是 timeout.git 与下一步', { skip }, () => {
  const dir = makeRepo();
  put(dir, 'films/keep/main.js', 'export const x = 9;\n');
  git(dir, ['add', '--', 'films/keep/main.js']);
  const r = runDirect(dir, ['--json'], { BEIMING_PRECOMMIT_GIT_TIMEOUT_MS: '1' });
  assert.equal(r.status, 124, `${r.stdout}\n${r.stderr}`);
  const o = JSON.parse(r.stdout);
  assert.equal(o.error.code, 'timeout.git');
  assert.match(o.error.hint, /BEIMING_PRECOMMIT_GIT_TIMEOUT_MS/);
});

test('--help 无副作用，在仓库外也能运行；不在仓库里运行检查时 exit 3', () => {
  const outside = fs.mkdtempSync(path.join(TMP, 'outside-'));
  const help = spawnSync(process.execPath, [path.join(ROOT, '.githooks', 'pre-commit.mjs'), '--help'], { cwd: outside, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /core\.hooksPath \.githooks/);
  assert.match(help.stdout, /BEIMING_PRECOMMIT_ALLOW/);
  assert.deepEqual(fs.readdirSync(outside), [], '--help 不应写文件');
  if (!HAS_GIT) return;
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(outside) };
  const r = spawnSync(process.execPath, [path.join(ROOT, '.githooks', 'pre-commit.mjs'), '--json'], { cwd: outside, encoding: 'utf8', env });
  assert.equal(r.status, 3);
  assert.match(JSON.parse(r.stdout).error.code, /^env\./);
});

test('真实仓库：.githooks/pre-commit 是 LF、可执行、首行 #!/bin/sh；本包检查与索引级检查在当前检出上通过', { skip }, () => {
  const text = fs.readFileSync(path.join(ROOT, '.githooks', 'pre-commit'), 'utf8');
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(text, /\r\n/);
  const mode = spawnSync('git', ['ls-files', '-s', '--', '.githooks/pre-commit'], { cwd: ROOT, encoding: 'utf8' }).stdout;
  if (mode.trim()) assert.match(mode, /^100755 /, 'git 里应记为可执行');
  // 合规全量与规范检查全量由 npm run check / CI 负责（别的包的存量问题不归提交前检查判）
  const r = spawnSync(process.execPath, [path.join(ROOT, '.githooks', 'pre-commit.mjs'), '--all', '--only', OWN_AND_INDEX], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
