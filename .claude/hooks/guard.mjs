#!/usr/bin/env node
// 北冥仓库 · agent 护栏（Claude Code PreToolUse 钩子，跨平台 node 脚本）
// 做什么：每次 agent 调用写文件、跑命令、调 skill、读归档之前判定一次：
//   拒绝写 cases/vendor/、cases/source/（上游快照与历史归档）、src/（《北冥》基准）、许可文件、护栏本身；
//   拒绝 git add -A / . / -f、git commit -a / --no-verify、强推、删远端、改写历史、reset --hard、clean -f；
//   拒绝在归档里运行代码、访问 ~/lemo-opuscar 与 ~/lemo-my-styles、调用全局第三方风格库 skill；
//   拒绝时告诉 agent 原因与下一步（作品一律放 films/<名字>/）。规则数据在 lib/policy.mjs，判定在 lib/decide.mjs。
// 用法：
//   钩子模式（由 .claude/settings.json 调用）：stdin 读 PreToolUse 事件 JSON，stdout 写判定 JSON，退出码 0；
//     放行时不输出；内部出错时 stderr 报错、退出码 1（Claude Code 视为非阻断错误，照常执行）。
//   人工查询：node .claude/hooks/guard.mjs --explain --tool <Write|Bash|PowerShell|Read|Skill> (--path P | --command C | --skill S | --input 事件.json) [--cwd D] [--json]
//     退出码：0 放行、4 会被拒绝、2 用法错误；--json 输出一个对象（ok、exitCode、command、error、outputs、runJson、warnings、decision）。
//   node .claude/hooks/guard.mjs --help
// 临时解锁：由用户设置 BEIMING_GUARD_UNLOCK=<区域 id,…>（见 .claude/hooks/README.md）；日志：out/agent-guard/guard.jsonl。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from './lib/decide.mjs';
import { appendLog, redact } from './lib/log.mjs';
import { RULES, ZONES } from './lib/policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.BEIMING_GUARD_ROOT ? path.resolve(process.env.BEIMING_GUARD_ROOT) : path.resolve(HERE, '..', '..');

const HELP = `北冥仓库 · agent 护栏（Claude Code PreToolUse 钩子）

钩子模式：由 .claude/settings.json 调用，stdin 读事件 JSON，拒绝时 stdout 写
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}
放行时不输出。内部出错退出码 1（非阻断）。

人工查询（不写日志、不改任何文件）：
  node .claude/hooks/guard.mjs --explain --tool Write --path cases/vendor/x.js
  node .claude/hooks/guard.mjs --explain --tool Bash --command "git add -A" --json
  node .claude/hooks/guard.mjs --explain --input event.json
  选项：--tool 名称  --path 路径  --command 命令  --skill 名称  --input 事件文件  --cwd 目录  --json
  退出码：0 放行；4 会被拒绝；2 用法错误；1 内部错误。

受保护区域（BEIMING_GUARD_UNLOCK 可点名解锁，逗号分隔，由用户在启动 Claude Code 前设置）：
${ZONES.map(z => `  ${z.unlock.padEnd(12)} ${[...z.prefixes, ...z.files].join('、')}`).join('\n')}
  instructions  子目录里的 AGENTS.md / CLAUDE.md / GEMINI.md
  publish       gh release delete、gh repo delete / rename / archive / edit --visibility

命令规则：${Object.keys(RULES).filter(k => k.startsWith('git-')).join('、')}
日志：out/agent-guard/guard.jsonl（BEIMING_GUARD_LOG=off 关闭）。说明：.claude/hooks/README.md
`;

function envelope({ ok, exitCode, error = null, decision = null, warnings = [] }) {
  return JSON.stringify({ ok, exitCode, command: 'node .claude/hooks/guard.mjs --explain', error, outputs: [], runJson: null, warnings, decision });
}

function usageError(msg, json) {
  if (json) process.stdout.write(envelope({ ok: false, exitCode: 2, error: { code: 'usage', message: msg, hint: '运行 node .claude/hooks/guard.mjs --help 看用法' } }) + '\n');
  process.stderr.write(`用法错误：${msg}\n运行 node .claude/hooks/guard.mjs --help 看用法\n`);
  process.exit(2);
}

function parseArgv(argv) {
  const o = { json: false };
  const valued = new Set(['--tool', '--path', '--command', '--skill', '--input', '--cwd']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--explain') o.explain = true;
    else if (valued.has(a)) {
      if (i + 1 >= argv.length) return { error: `${a} 后面要跟一个值`, json: argv.includes('--json') };
      o[a.slice(2)] = argv[++i];
    } else return { error: `不认识的参数 ${a}`, json: argv.includes('--json') };
  }
  return o;
}

function explain(o) {
  let event;
  if (o.input) {
    try { event = JSON.parse(fs.readFileSync(path.resolve(o.input), 'utf8')); } catch (e) { usageError(`读不了 --input ${o.input}：${e.message}`, o.json); }
  } else {
    if (!o.tool) usageError('--explain 需要 --tool（或 --input 事件文件）', o.json);
    const input = {};
    if (o.path !== undefined) { input.file_path = path.resolve(o.cwd ?? process.cwd(), o.path); input.path = input.file_path; }
    if (o.command !== undefined) input.command = o.command;
    if (o.skill !== undefined) input.skill = o.skill;
    if (!Object.keys(input).length) usageError('--explain 需要 --path、--command 或 --skill 之一', o.json);
    event = { tool_name: o.tool, tool_input: input, cwd: path.resolve(o.cwd ?? process.cwd()) };
  }
  const d = decide(event, { root: ROOT });
  const code = d.decision === 'deny' ? 4 : 0;
  if (o.json) {
    const error = d.decision === 'deny' ? { code: d.rule, message: d.reason, hint: (RULES[d.rule]?.next ?? ZONES.find(z => `zone-${z.id}` === d.rule)?.next ?? '') } : null;
    process.stdout.write(envelope({ ok: code === 0, exitCode: code, error, decision: d }) + '\n');
  } else if (d.decision === 'deny') {
    process.stdout.write(`拒绝：${d.reason}\n`);
  } else {
    process.stdout.write(`放行${d.context ? `（附提醒）：${d.context}` : ''}\n`);
  }
  process.exit(code);
}

function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => { process.stdin.pause(); resolve(Buffer.concat(chunks).toString('utf8')); }, timeoutMs);
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

async function hookMode() {
  if (process.stdin.isTTY) {
    process.stderr.write('这是 Claude Code 的 PreToolUse 钩子，从 stdin 读事件 JSON。人工查询请用 --explain，用法见 --help。\n');
    process.exit(2);
  }
  const raw = await readStdin();
  let event;
  try { event = JSON.parse(raw || '{}'); } catch (e) {
    process.stderr.write(`北冥护栏：钩子输入不是 JSON（${e.message}），本次不判定。\n`);
    process.exit(1);
  }
  const d = decide(event, { root: ROOT });
  if (d.decision === 'allow' && !d.context) process.exit(0);
  const tool = String(event.tool_name ?? '');
  const input = event.tool_input ?? {};
  appendLog({
    ts: new Date().toISOString(),
    session: event.session_id ?? null,
    tool,
    decision: d.decision,
    rule: d.rule ?? null,
    target: d.target ?? (input.file_path ? String(input.file_path) : null),
    zone: d.zone ?? null,
    command: typeof input.command === 'string' ? redact(input.command) : null,
    skill: typeof input.skill === 'string' ? input.skill : null,
  }, { root: ROOT });
  const out = d.decision === 'deny'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.context } };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

const o = parseArgv(process.argv.slice(2));
if (o.error) usageError(o.error, o.json);
if (o.help) { process.stdout.write(HELP); process.exit(0); }
if (o.explain) explain(o);
else if (Object.keys(o).some(k => k !== 'json')) usageError('这些参数只能和 --explain 一起用', o.json);
else {
  hookMode().catch((e) => {
    process.stderr.write(`北冥护栏内部错误（本次不判定）：${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
