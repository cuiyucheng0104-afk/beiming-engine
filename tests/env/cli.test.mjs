// env 域命令行的统一约定（加固计划附录 C1/C2）：--help 到 stdout、exit 0、无副作用；不认识的参数 exit 2；
// --json 时 stdout 只有一个信封对象；doctor / preflight 在缺依赖时 exit 3 并给出可执行的修复命令，预检 2 秒内出结论。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIS = ['tools/env/doctor.mjs', 'tools/env/setup.mjs', 'tools/env/preflight.mjs', 'tools/env/lock.mjs', 'tools/env/large-files.mjs', 'tools/remote/cli.mjs', 'tools/repo-check/rules/env/index.mjs'];
const ENVELOPE = ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings'];
const node = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000, ...opts });
// 只看这些命令可能写到的位置：整个 out/ 是别的测试也会写的共用目录，放进来会让并行跑的测试互相干扰
const WATCH = ['tools', 'tests/env', 'docs', 'requirements.in', 'requirements.lock', 'requirements.txt', 'LARGE-FILES.allow', '.gitattributes', '.venv', 'out/remote', 'out/doctor'];
const state = () => {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored', '--', ...WATCH], { cwd: ROOT, encoding: 'utf8' });
  const venv = path.join(ROOT, '.venv');
  return r.status === 0 ? r.stdout + (fs.existsSync(venv) ? `venv:${fs.statSync(venv).mtimeMs}` : '') : null;
};
const missing = name => path.join(os.tmpdir(), `beiming-missing-${process.pid}-${name}`);

test('--help：每个命令 exit 0、说明写到 stdout、不改动仓库里的任何文件', () => {
  const before = state();
  for (const cli of [...CLIS, 'tools/env/py.mjs']) {
    const r = node([cli, '--help']);
    assert.equal(r.status, 0, `${cli} --help 退出码 ${r.status}：${r.stderr}`);
    assert.match(r.stdout, /用法/, `${cli} --help 没有把用法写到 stdout`);
    assert.match(r.stdout, /退出码/, `${cli} --help 没写退出码`);
  }
  if (before !== null) assert.equal(state(), before, '--help 改动了仓库（出现了新文件或改动）');
});

test('不认识的参数：exit 2；加 --json 时 stdout 只有一个信封对象（与 tools/lib/cli.mjs 同一套错误码）', () => {
  for (const cli of CLIS) {
    const r = node([cli, '--no-such-flag']);
    assert.equal(r.status, 2, `${cli} --no-such-flag 退出码 ${r.status}`);
    assert.match(r.stderr, /不认识的选项 --no-such-flag/, `${cli} 的用法错误没说清楚`);
    const j = node([cli, '--no-such-flag', '--json']);
    assert.equal(j.status, 2);
    const obj = JSON.parse(j.stdout);           // 整个 stdout 就是一个对象
    for (const k of ENVELOPE) assert.ok(k in obj, `${cli} 的信封缺 ${k}`);
    assert.equal(obj.schemaVersion, 1);
    assert.equal(obj.ok, false);
    assert.equal(obj.exitCode, 2);
    assert.equal(obj.error.code, 'usage.unknown-option');
    assert.ok(obj.error.hint, `${cli} 的用法错误没有下一步提示`);
    assert.doesNotMatch(obj.command, /no-such-flag/, `${cli}：拼错的参数不该进命令名`);
  }
});

test('参数缺值、开关带值、多余的位置参数：exit 2，错误码分别是 usage.missing-value、usage.bad-value、usage.extra-argument', () => {
  const code = args => { const j = node(args); assert.equal(j.status, 2, `${args.join(' ')}：${j.stderr}`); return JSON.parse(j.stdout).error.code; };
  assert.equal(code(['tools/env/doctor.mjs', '--route', '--json']), 'usage.missing-value');
  assert.equal(code(['tools/env/doctor.mjs', '--json', '--route']), 'usage.missing-value');
  assert.equal(code(['tools/env/doctor.mjs', '--quick=yes', '--json']), 'usage.bad-value');
  assert.equal(code(['tools/env/doctor.mjs', 'extra', '--json']), 'usage.extra-argument');
});

test('枚举参数写错时列出合法取值', () => {
  const r = node(['tools/env/doctor.mjs', '--route', 'd', '--json']);
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).error.message, /a \/ b \/ c/);
  const p = node(['tools/env/preflight.mjs', '--need', 'gpu']);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /可选：node、npm、browser/);
});

test('doctor：缺必需项时 exit 3，每个不合格项都有修复命令，信封里带全部检查项', () => {
  const env = { ...process.env, BEIMING_PYTHON: missing('python'), FFMPEG: missing('ffmpeg'), FFPROBE: missing('ffprobe') };
  const r = node(['tools/env/doctor.mjs', '--quick', '--json'], { env });
  assert.equal(r.status, 3, r.stderr);
  const j = JSON.parse(r.stdout);
  for (const k of [...ENVELOPE, 'checks', 'summary', 'platform']) assert.ok(k in j, `doctor 信封缺 ${k}`);
  assert.equal(j.exitCode, 3);
  assert.equal(j.error.code, 'env-check-failed');
  const byId = Object.fromEntries(j.checks.map(c => [c.id, c]));
  for (const id of ['node.version', 'npm.lock', 'playwright.core', 'browser.headless-shell', 'ffmpeg.version', 'python.interpreter', 'git.eol', 'disk.free', 'env.vars']) assert.ok(byId[id], `缺检查项 ${id}`);
  for (const c of j.checks) for (const k of ['id', 'ok', 'required', 'found', 'fix', 'status']) assert.ok(k in c, `${c.id} 缺字段 ${k}`);
  assert.equal(byId['python.interpreter'].status, 'fail');
  assert.match(byId['python.interpreter'].found, /BEIMING_PYTHON=/);
  assert.equal(byId['ffmpeg.version'].status, 'fail');
  for (const c of j.checks.filter(x => x.status === 'fail')) assert.ok(c.fix && c.fix.length > 4, `${c.id} 不合格却没有修复命令`);
  // 顶层提示是一串按顺序执行的修复命令：系统级安装在前，npm run setup 合并 npm ci 类的修复，最后重跑 doctor
  assert.match(j.error.hint, /^按顺序执行：.*最后重跑 npm run env:doctor$/);
  assert.ok(Array.isArray(j.nextSteps) && j.nextSteps.length >= 1);
  assert.equal(new Set(j.nextSteps).size, j.nextSteps.length, '修复步骤有重复');
  assert.ok(byId['env.vars'].data.set.includes('BEIMING_PYTHON') && byId['env.vars'].data.set.includes('FFMPEG'));
});

test('nextSteps：系统级安装在前，npm ci 与 npm run setup 合并成一步，去重', async () => {
  const { nextSteps } = await import('../../tools/env/doctor.mjs');
  const steps = nextSteps([
    { id: 'npm.lock', fix: 'npm ci' }, { id: 'playwright.core', fix: 'npm ci' },
    { id: 'browser.headless-shell', fix: 'npm run setup（只装锁定版本）' },
    { id: 'ffmpeg.version', fix: 'brew install ffmpeg' }, { id: 'ffprobe.version', fix: 'brew install ffmpeg' },
    { id: 'python.interpreter', fix: 'brew install uv，再运行 npm run setup（uv 会自动取 Python 3.12）', data: { needUv: true } },
    { id: 'git.eol', fix: 'git config core.autocrlf false && git rm -r -q --cached . && git reset --hard' },
  ]);
  assert.deepEqual(steps, ['brew install ffmpeg', 'brew install uv', 'npm run setup', 'git config core.autocrlf false && git rm -r -q --cached . && git reset --hard']);
});

test('doctor：拼错的 BEIMING_ 变量会被点名', () => {
  const r = node(['tools/env/doctor.mjs', '--quick', '--json'], { env: { ...process.env, BEIMING_ANGEL: 'vulkan' } });
  const c = JSON.parse(r.stdout).checks.find(x => x.id === 'env.vars');
  assert.equal(c.status, 'warn');
  assert.match(c.fix, /BEIMING_ANGEL（是不是 BEIMING_ANGLE/);
});

test('preflight：2 秒内给出结论；缺依赖时 exit 3，hint 就是修复命令', () => {
  const t0 = Date.now();
  const ok = node(['tools/env/preflight.mjs', '--need', 'node,npm,disk', '--json']);
  assert.equal(ok.status, 0, ok.stdout);
  const bad = node(['tools/env/preflight.mjs', '--need', 'ffmpeg,python:audio', '--json'], { env: { ...process.env, BEIMING_PYTHON: missing('python'), FFMPEG: missing('ffmpeg') } });
  const ms = Date.now() - t0;
  assert.equal(bad.status, 3);
  const j = JSON.parse(bad.stdout);
  assert.equal(j.error.code, 'preflight-failed');
  assert.ok(j.error.hint);
  assert.ok(j.checks.every(c => c.ok || c.fix), '不合格的预检项都要有修复命令');
  assert.ok(ms < 4000, `两次预检共用了 ${ms} 毫秒（每次应在 2 秒内）`);
});

test('setup --dry-run --json：只列计划，不下载、不写文件', () => {
  const before = state();
  const r = node(['tools/env/setup.mjs', '--dry-run', '--json', '--skip-npm', '--no-hooks'], { timeout: 120_000 });
  const j = JSON.parse(r.stdout);
  if (r.status === 3) {
    // 这台机器既没有 uv 也没有 Python 3.12：演练也要如实报出缺前置条件，并给出先装 uv 的修复
    assert.equal(j.error.code, 'python-missing', r.stderr);
    assert.match(j.error.hint, /uv/);
  } else {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(j.dryRun, true);
    assert.deepEqual(j.steps.map(s => s.id), ['npm', 'browser', 'python', 'hooks']);
    for (const s of j.steps) assert.ok(['skipped', 'planned'].includes(s.status), `${s.id} 在演练里是 ${s.status}`);
  }
  if (before !== null) assert.equal(state(), before, '--dry-run 改动了仓库');
});
