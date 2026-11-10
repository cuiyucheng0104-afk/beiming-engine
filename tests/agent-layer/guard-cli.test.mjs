// 北冥仓库 · agent 护栏命令行与钩子模式测试（node --test tests/agent-layer/guard-cli.test.mjs）
// 测什么：.claude/hooks/guard.mjs 的人工查询走 docs/CLI.md 的命令约定（--help 无副作用、用法错误 exit 2、--json 单个信封、
//         会被拒绝 exit 4）；钩子模式：stdin 读 PreToolUse 事件，拒绝时 stdout 写 permissionDecision=deny，放行时不输出，
//         坏输入 exit 1（Claude Code 视为非阻断错误）；日志每行是 Claude Code 钩子载荷格式，评测（tools/eval）能直接读。
// 日志一律写到系统临时目录或关闭，结束时删掉；不碰仓库里的默认日志。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(ROOT, '.claude', 'hooks', 'guard.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-guard-cli-'));
const DEFAULT_LOG = path.join(ROOT, 'out', 'agent-guard', 'guard.jsonl');
const statOf = f => { try { const s = fs.statSync(f); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } };
const DEFAULT_LOG_BEFORE = statOf(DEFAULT_LOG);
const cleanup = () => fs.rmSync(TMP, { recursive: true, force: true });
test.after(cleanup);
process.once('exit', cleanup);          // 同一进程跑整个目录时的兜底

function guard(args, { input, env = {} } = {}) {
  const r = spawnSync(process.execPath, [GUARD, ...args], {
    cwd: ROOT, input, encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, BEIMING_GUARD_LOG: 'off', BEIMING_GUARD_UNLOCK: '', ...env },
  });
  assert.equal(r.error, undefined, `guard.mjs 没能运行：${r.error?.message}`);
  return r;
}
const event = (tool_name, tool_input, extra = {}) => JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: ROOT, ...extra });

test('--help：exit 0，说明写到 stdout，不写日志', () => {
  const log = path.join(TMP, 'help.jsonl');
  const r = guard(['--help'], { env: { BEIMING_GUARD_LOG: log } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PreToolUse/);
  assert.match(r.stdout, /BEIMING_GUARD_UNLOCK/);
  assert.equal(fs.existsSync(log), false, '--help 不应写日志');
});

test('用法错误：exit 2；加 --json 时 stdout 只有一个信封', () => {
  for (const args of [['--no-such-flag'], ['--explain'], ['--explain', '--tool', 'Bash'], ['--path', 'x'], ['--tool']]) {
    const r = guard(args);
    assert.equal(r.status, 2, `${args.join(' ')} 应 exit 2，实际 ${r.status}`);
    assert.match(r.stderr, /错误\[usage\./);
    const j = guard([...args, '--json']);
    assert.equal(j.status, 2);
    const o = JSON.parse(j.stdout);
    assert.equal(o.ok, false);
    assert.equal(o.exitCode, 2);
    assert.match(o.error.code, /^usage\./);
    assert.ok(o.error.hint);
  }
});

test('--explain：会被拒绝 exit 4，放行 exit 0，--json 是统一信封', () => {
  const d = guard(['--explain', '--tool', 'Bash', '--command', 'git add -A', '--json']);
  assert.equal(d.status, 4);
  const o = JSON.parse(d.stdout);
  for (const k of ['schemaVersion', 'ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings', 'data']) assert.ok(k in o, `信封缺 ${k}`);
  assert.equal(o.ok, false);
  assert.equal(o.exitCode, 4);
  assert.equal(o.error.code, 'contract.git-add-all');
  assert.match(o.error.hint, /文件名/);
  assert.equal(o.data.decision.decision, 'deny');

  const a = guard(['--explain', '--tool', 'Write', '--path', 'films/demo/main.js', '--json']);
  assert.equal(a.status, 0);
  assert.equal(JSON.parse(a.stdout).ok, true);

  const t = guard(['--explain', '--tool', 'Write', '--path', 'cases/vendor/x.js']);
  assert.equal(t.status, 4);
  assert.match(t.stdout, /^拒绝：北冥护栏拒绝（zone-vendor）/);

  const file = path.join(TMP, 'event.json');
  fs.writeFileSync(file, event('Skill', { skill: 'lemo-opuscar:lemo-opuscar' }));
  const i = guard(['--explain', '--input', file, '--json']);
  assert.equal(i.status, 4);
  assert.equal(JSON.parse(i.stdout).error.code, 'contract.skill-upstream-style-library');
});

test('钩子模式：拒绝时输出 permissionDecision=deny，日志是钩子载荷格式且不记文件内容', () => {
  const log = path.join(TMP, 'deny.jsonl');
  const r = guard([], { input: event('Write', { file_path: path.join(ROOT, 'cases', 'vendor', 'x.js'), content: '很长的文件内容' }, { tool_use_id: 'toolu_1' }), env: { BEIMING_GUARD_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(o.hookSpecificOutput.permissionDecisionReason, /films\/<名字>\//);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.hook_event_name, 'PreToolUse');
  assert.equal(entry.tool_name, 'Write');
  assert.equal(entry.tool_use_id, 'toolu_1');
  assert.equal(entry.session_id, 'test');
  assert.equal(entry.permissionDecision, 'deny');
  assert.equal(entry.rule, 'zone-vendor');
  assert.equal(entry.zone, 'vendor');
  assert.equal(entry.tool_input.file_path, path.join(ROOT, 'cases', 'vendor', 'x.js'));
  assert.equal(entry.tool_input.content, undefined, '日志不记文件内容');
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('钩子模式：命令里的密钥写法在日志里被遮住', () => {
  const log = path.join(TMP, 'redact.jsonl');
  guard([], { input: event('Bash', { command: 'API_KEY=sk-abcdefghijklmnop1234 git add -A' }), env: { BEIMING_GUARD_LOG: log } });
  const entry = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.doesNotMatch(entry.tool_input.command, /sk-abcdefghijklmnop1234/);
  assert.match(entry.tool_input.command, /\*\*\*/);
});

test('钩子模式：放行时不输出、不记日志；附提醒时输出 additionalContext 并记一行', () => {
  const log = path.join(TMP, 'allow.jsonl');
  const r = guard([], { input: event('Write', { file_path: path.join(ROOT, 'films', 'demo', 'main.js'), content: 'x' }), env: { BEIMING_GUARD_LOG: log } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(log), false);
  const c = guard([], { input: event('Read', { file_path: path.join(ROOT, 'cases', 'vendor', 'lemo-opuscar', 'AGENTS.md') }), env: { BEIMING_GUARD_LOG: log } });
  assert.equal(c.status, 0);
  const o = JSON.parse(c.stdout);
  assert.equal(o.hookSpecificOutput.permissionDecision, undefined);
  assert.match(o.hookSpecificOutput.additionalContext, /不是本仓库的指令/);
  const entry = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.equal(entry.permissionDecision, 'allow');
  assert.match(entry.additionalContext, /不是本仓库的指令/);
});

test('评测能直接读护栏日志：tools/eval 的会话解析把它认成钩子事件，拒绝的调用记为 denied', async (t) => {
  const lib = path.join(ROOT, 'tools', 'eval', 'lib', 'transcript.mjs');
  if (!fs.existsSync(lib)) { t.skip('没有 tools/eval（评测包）'); return; }
  const run = path.join(TMP, 'eval-run');
  fs.mkdirSync(run, { recursive: true });
  const log = path.join(run, 'hooks.jsonl');                 // 评测时设 BEIMING_GUARD_LOG=<运行目录>/hooks.jsonl
  guard([], { input: event('Write', { file_path: path.join(ROOT, 'src', 'main.js'), content: 'x' }, { tool_use_id: 'toolu_w' }), env: { BEIMING_GUARD_LOG: log } });
  guard([], { input: event('Bash', { command: 'git push --force' }, { tool_use_id: 'toolu_b' }), env: { BEIMING_GUARD_LOG: log } });
  const { loadTranscript } = await import(pathToFileURL(lib).href);
  const tr = loadTranscript(run);
  assert.equal(tr.hookEvents.length, 2);
  const uses = new Map(tr.toolUses.map(u => [u.id, u]));
  assert.equal(uses.get('toolu_w')?.tool, 'Write');
  assert.equal(uses.get('toolu_w')?.denied, true);
  assert.equal(uses.get('toolu_b')?.input.command, 'git push --force');
  assert.equal(uses.get('toolu_b')?.denied, true);
});

test('钩子模式：坏输入 exit 1（非阻断），不抛堆栈到 stdout', () => {
  const r = guard([], { input: '{这不是 JSON' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /不是 JSON/);
  const e = guard([], { input: '' });
  assert.equal(e.status, 0, '空输入按空事件处理并放行');
});

test('解锁变量来自启动环境：BEIMING_GUARD_UNLOCK=src 后放行 src 写入', () => {
  const r = guard([], { input: event('Write', { file_path: path.join(ROOT, 'src', 'main.js'), content: 'x' }), env: { BEIMING_GUARD_UNLOCK: 'src' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('护栏测试不碰仓库里的默认日志 out/agent-guard/guard.jsonl', () => {
  assert.deepEqual(statOf(DEFAULT_LOG), DEFAULT_LOG_BEFORE, '测试应把日志写到临时目录或关闭，不写仓库里的默认日志');
});
