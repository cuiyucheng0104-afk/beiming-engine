// 北冥仓库 · 提交前检查测试（node --test tests/agent-layer）
// 测什么：.githooks/pre-commit 真的被 git 调起、能拦下快照改动、渲染产物、大文件、密钥、指令文件、桥接、CRLF、
//         冲突标记，合规的改动照常提交；--all 按 lock.json 核对快照；--help 无副作用；退出码与 --json 信封。
// 每个用例在系统临时目录里建一个一次性 git 仓库（只复制钩子需要的几个文件），结束时删掉；不碰真实仓库与全局 git 配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-precommit-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const NEEDED = ['.githooks/pre-commit', '.githooks/pre-commit.mjs', 'tools/repo-check/rules/agent/index.mjs',
  'tools/repo-check/rules/agent/instruction-files.json', '.claude/hooks/lib/policy.mjs'];
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
let seq = 0;

function git(dir, args, { env = {}, input } = {}) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: dir, encoding: 'utf8', input, windowsHide: true, timeout: 60000,
    env: { ...process.env, ...GIT_ENV, BEIMING_PRECOMMIT_ALLOW: '', ...env },
  });
}
function put(dir, rel, content) {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

/** 一个最小仓库：钩子与它要用的模块、一份迷你 vendor 快照与 lock、一个归档文件、根 CLAUDE.md；启用 .githooks。
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
  for (const rel of NEEDED) {
    put(dir, rel, fs.readFileSync(path.join(ROOT, ...rel.split('/'))));
  }
  fs.chmodSync(path.join(dir, '.githooks', 'pre-commit'), 0o755);
  put(dir, 'AGENTS.md', '# 规则\n');
  put(dir, 'CLAUDE.md', '@AGENTS.md\n');
  put(dir, 'cases/vendor/README.md', '# 快照\n');
  put(dir, 'cases/vendor/demo/a.txt', 'upstream\n');
  put(dir, 'cases/source/old/main.js', 'console.log(1)\n');
  put(dir, 'films/keep/main.js', 'export const x = 1;\n');
  const blob = git(dir, ['hash-object', 'cases/vendor/demo/a.txt']);
  // hash-object 在 init 之前也能算（不写对象）
  put(dir, 'cases/vendor/lock.json', JSON.stringify({ version: 1, repositories: [{ name: 'demo', path: 'vendor/demo', files: [{ path: 'a.txt', mode: '100644', gitBlob: blob.stdout.trim() }] }] }, null, 2));
  assert.equal(git(dir, ['init', '-q']).status, 0);
  assert.equal(git(dir, ['add', '--', ...listAll(dir)]).status, 0);
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

const skip = HAS_GIT ? false : '本机没有 git';

test('合规改动照常提交：作品源码、vendor README、新增归档、样例配置', { skip }, () => {
  const dir = makeRepo();
  const r = commitWith(dir, {
    'films/demo/main.js': 'export default 1;\n', 'films/demo/film.json': '{"route":"c"}\n', 'films/demo/README.md': '# 演示\n',
    'cases/vendor/README.md': '# 快照\n> 给 agent 的优先级警示\n', 'cases/source/new/main.js': 'console.log(2)\n', '.env.example': 'KEY=\n',
    'tools/build.sh': '#!/bin/sh\necho ok\n',
  });
  assert.equal(r.status, 0, `应提交成功：${r.stderr}`);
});

const blocked = [
  ['vendor', { 'cases/vendor/demo/a.txt': 'changed\n' }],
  ['vendor', { 'cases/vendor/lock.json': '{}\n' }],
  ['source', { 'cases/source/old/main.js': 'console.log(3)\n' }],
  ['films-out', { 'films/demo/out/frame_0001.png': 'png' }],
  ['films-out', { 'films/demo/mix.wav': 'RIFF' }],
  ['films-out', { 'films/demo/cut.mp4': 'mp4' }],
  ['large', { 'films/demo/plate.bin': Buffer.alloc(5 * 1024 * 1024 + 1, 1) }],
  ['secrets', { '.env': 'TOKEN=abc\n' }],
  ['secrets', { 'films/demo/key.pem': 'x' }],
  ['secrets', { 'films/demo/notes.md': '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n' }],
  ['instructions', { 'films/demo/AGENTS.md': '# 子目录指令\n' }],
  ['instructions', { '.claude/skills/new-skill/SKILL.md': '---\nname: new-skill\ndescription: x\n---\n' }],
  ['bridge', { 'CLAUDE.md': '@AGENTS.md\n另外的规则\n' }],
  ['crlf', { 'tools/run.sh': '#!/bin/sh\r\necho hi\r\n' }],
  ['conflict', { 'films/demo/main.js': '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n' }],
];
for (const [id, files] of blocked) {
  test(`拦下 ${id}：${Object.keys(files).join('、')}`, { skip }, () => {
    const dir = makeRepo();
    const r = commitWith(dir, files);
    assert.notEqual(r.status, 0, `应被拦下，实际提交成功`);
    assert.match(r.stderr, new RegExp(`\\[${id}\\]`), `报错里要有 [${id}]：\n${r.stderr}`);
    assert.match(r.stderr, /提交已中止/);
    const head = git(dir, ['rev-list', '--count', 'HEAD']).stdout.trim();
    assert.equal(head, '1', '不应产生新提交');
  });
}

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

test('大文件：LARGE-FILES.allow 登记后放行；没有清单时沿用 HEAD 里已有的大文件', { skip }, () => {
  const dir = makeRepo();
  put(dir, 'LARGE-FILES.allow', '# 现有大文件\nmedia/*.mp4\n');
  const r = commitWith(dir, { 'LARGE-FILES.allow': fs.readFileSync(path.join(dir, 'LARGE-FILES.allow')), 'media/a.mp4': Buffer.alloc(6 * 1024 * 1024, 2) });
  assert.equal(r.status, 0, r.stderr);
  const dir2 = makeRepo();
  const big = Buffer.alloc(6 * 1024 * 1024, 3);
  put(dir2, 'assets/plate.png', big);
  git(dir2, ['add', '--', 'assets/plate.png']);
  assert.equal(git(dir2, ['commit', '-q', '--no-verify', '-m', 'grandfather']).status, 0);
  const again = commitWith(dir2, { 'assets/plate.png': Buffer.alloc(6 * 1024 * 1024, 4) });
  assert.equal(again.status, 0, `HEAD 里已有的大文件改版应放行：${again.stderr}`);
  const fresh = commitWith(dir2, { 'assets/new.png': big });
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stderr, /\[large\]/);
});

test('直接运行：退出码、--json 信封、--all 按 lock.json 核对快照', { skip }, () => {
  const dir = makeRepo();
  const run = (args, env) => spawnSync(process.execPath, [path.join(dir, '.githooks', 'pre-commit.mjs'), ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, BEIMING_PRECOMMIT_ALLOW: '', ...env }, windowsHide: true,
  });
  const clean = run(['--all', '--json']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).ok, true);

  put(dir, 'films/demo/out/a.mp4', 'x');
  git(dir, ['add', '--', 'films/demo/out/a.mp4']);
  const bad = run(['--json']);
  assert.equal(bad.status, 4);
  const o = JSON.parse(bad.stdout);
  for (const k of ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings', 'findings']) assert.ok(k in o, `信封缺 ${k}`);
  assert.equal(o.exitCode, 4);
  assert.deepEqual([...new Set(o.findings.map(f => f.rule))], ['precommit.films-out']);
  git(dir, ['reset', '-q']);

  put(dir, 'cases/vendor/demo/a.txt', 'tampered\n');
  git(dir, ['add', '--', 'cases/vendor/demo/a.txt']);
  put(dir, 'cases/vendor/demo/extra.js', 'x');
  git(dir, ['add', '--', 'cases/vendor/demo/extra.js']);
  const all = run(['--all', '--json', '--only', 'vendor']);
  assert.equal(all.status, 4);
  const msgs = JSON.parse(all.stdout).findings.map(f => f.message).join('\n');
  assert.match(msgs, /不在 cases\/vendor\/lock\.json 里/);
  assert.match(msgs, /不一致/);

  assert.equal(run(['--only', 'nope']).status, 2);
  assert.equal(run(['--bogus']).status, 2);
});

test('--help 无副作用，在仓库外也能运行；不在仓库里运行检查时 exit 3', () => {
  const outside = fs.mkdtempSync(path.join(TMP, 'outside-'));
  const help = spawnSync(process.execPath, [path.join(ROOT, '.githooks', 'pre-commit.mjs'), '--help'], { cwd: outside, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /core\.hooksPath \.githooks/);
  assert.deepEqual(fs.readdirSync(outside), [], '--help 不应写文件');
  if (!HAS_GIT) return;
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(outside) };
  const r = spawnSync(process.execPath, [path.join(ROOT, '.githooks', 'pre-commit.mjs'), '--json'], { cwd: outside, encoding: 'utf8', env });
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).error.code, 'env');
});

test('真实仓库：.githooks/pre-commit 是 LF、可执行、首行 #!/bin/sh；--all 在当前检出上通过', { skip }, () => {
  const text = fs.readFileSync(path.join(ROOT, '.githooks', 'pre-commit'), 'utf8');
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(text, /\r\n/);
  const mode = spawnSync('git', ['ls-files', '-s', '--', '.githooks/pre-commit'], { cwd: ROOT, encoding: 'utf8' }).stdout;
  if (mode.trim()) assert.match(mode, /^100755 /, 'git 里应记为可执行');
  const r = spawnSync(process.execPath, [path.join(ROOT, '.githooks', 'pre-commit.mjs'), '--all'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
