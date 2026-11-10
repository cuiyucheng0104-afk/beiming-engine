#!/usr/bin/env node
// 北冥仓库 · agent 护栏（Claude Code PreToolUse 钩子，跨平台 node 脚本）
// 做什么：每次 agent 调用写文件、跑命令、调 skill、读归档之前判定一次：
//   拒绝写 cases/vendor/、cases/source/（上游快照与历史归档）、src/（《北冥》基准）、许可文件、护栏本身；
//   拒绝 git add（或同义的 git stage）-A / . / -f、git commit -a / --no-verify、设置 BEIMING_PRECOMMIT_ALLOW、强推、删远端、
//   改写历史、reset --hard、clean -f；
//   拒绝在归档里运行代码、访问 ~/lemo-opuscar 与 ~/lemo-my-styles、调用全局第三方风格库 skill；
//   拒绝时告诉 agent 原因与下一步（作品一律放 films/<名字>/）。规则数据在 lib/policy.mjs，判定在 lib/decide.mjs。
// 用法：
//   钩子模式（由 .claude/settings.json 调用，不带参数）：stdin 读 PreToolUse 事件 JSON，stdout 写判定 JSON，退出码 0；
//     放行时不输出；内部出错时 stderr 报错、退出码 1（Claude Code 视为非阻断错误，照常执行）。只依赖 lib/，不依赖 tools/。
//   人工查询（带参数时）：node .claude/hooks/guard.mjs --explain --tool <Write|Bash|PowerShell|Read|Skill> (--path P | --command C | --skill S | --input 事件.json) [--cwd D] [--json]
//     按 docs/CLI.md 的命令约定（tools/lib/cli.mjs）：退出码 0 放行、4 会被拒绝、2 用法错误；--json 输出一个信封，data.decision 是判定。
//   node .claude/hooks/guard.mjs --help
// 临时解锁：由用户设置 BEIMING_GUARD_UNLOCK=<区域 id,…>（见 .claude/hooks/README.md）。
// 日志：拒绝与附提醒的判定追加到 out/agent-guard/guard.jsonl（BEIMING_GUARD_LOG=off 关闭、=<路径> 改写），
//   每行是 Claude Code 钩子载荷的格式（hook_event_name、tool_name、tool_input、tool_use_id、session_id、permissionDecision…），
//   评测（tools/eval 的 H4）可以直接读。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decide } from './lib/decide.mjs';
import { appendLog, redact } from './lib/log.mjs';
import { RULES, ZONES, ALWAYS_DENY_RULES, LOG_ENV, DEFAULT_LOG, UNLOCK_ENV } from './lib/policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.BEIMING_GUARD_ROOT ? path.resolve(process.env.BEIMING_GUARD_ROOT) : path.resolve(HERE, '..', '..');
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 日志里只留判定用得到的输入：路径、命令（遮住密钥）、skill 名；不记文件内容与 Edit 的新旧文本。 */
export function slimInput(tool, input = {}) {
  const out = {};
  for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'skill', 'name', 'url']) {
    if (typeof input[k] === 'string') out[k] = k === 'pattern' ? input[k].slice(0, 200) : input[k];
  }
  if (typeof input.command === 'string') out.command = redact(input.command);
  if (tool.startsWith('mcp__')) {
    for (const [k, v] of Object.entries(input)) {
      if (k in out || typeof v !== 'string') continue;
      if (/^(source|src|destination|dest|target|new_?path|old_?path|output|out|directory|dir|cwd|cmd|script)$/i.test(k)) out[k] = /^(cmd|script)$/i.test(k) ? redact(v) : v;
    }
  }
  if (WRITE_TOOLS.has(tool) && out.path === undefined && typeof input.path === 'string') out.path = input.path;
  return out;
}

/** 一条日志：Claude Code 钩子载荷的字段名，加上护栏自己的 rule、zone、target。 */
export function logRecord(event, d) {
  const tool = String(event?.tool_name ?? '');
  return {
    timestamp: new Date().toISOString(),
    hook_event_name: 'PreToolUse',
    session_id: event?.session_id ?? null,
    tool_use_id: event?.tool_use_id ?? null,
    cwd: event?.cwd ?? null,
    tool_name: tool,
    tool_input: slimInput(tool, event?.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {}),
    permissionDecision: d.decision === 'deny' ? 'deny' : 'allow',
    ...(d.decision === 'deny' ? { permissionDecisionReason: d.reason } : { additionalContext: d.context }),
    rule: d.rule ?? null,
    zone: d.zone ?? null,
    target: d.target ?? null,
  };
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
  appendLog(logRecord(event, d), { root: ROOT });
  const out = d.decision === 'deny'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.context } };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

// ───────────────────────── 人工查询（命令约定库） ─────────────────────────

/** 带一个文本值的选项（tools/lib/cli.mjs 的声明格式）。 */
const textOption = (arg, describe, example) => ({ type: 'string', arg, describe, ...(example ? { example } : {}) });

async function explainCli(argv) {
  const { CliError, defineCommand, runCli } = await import(pathToFileURL(path.join(HERE, '..', '..', 'tools', 'lib', 'cli.mjs')).href);
  const command = defineCommand({
    name: 'agent-guard',
    summary: '北冥仓库 agent 护栏的人工查询：给一次工具调用，说出会放行还是拒绝、为什么、下一步（不写日志、不改文件）',
    usage: ['node .claude/hooks/guard.mjs --explain --tool <工具> (--path <路径> | --command <命令> | --skill <名字>) [--cwd <目录>] [--json]',
      'node .claude/hooks/guard.mjs --explain --input <PreToolUse 事件.json> [--json]'],
    description: () => [
      '不带参数时是 Claude Code 的 PreToolUse 钩子（由 .claude/settings.json 调用）：stdin 读事件 JSON，拒绝时 stdout 写',
      '  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}，放行时不输出。',
      '',
      `受保护区域（${UNLOCK_ENV} 可点名解锁，逗号分隔，由用户在启动 Claude Code 前设置；agent 自己 export 无效）：`,
      ...ZONES.map(z => `  ${z.unlock.padEnd(12)} ${[...z.prefixes, ...z.files].join('、')}`),
      '  instructions  子目录里的 AGENTS.md / CLAUDE.md / GEMINI.md、嵌套的 .claude/ 与 .mcp.json',
      '  publish       gh release delete、gh repo delete / rename / archive / edit --visibility',
      `  git           ${Object.keys(RULES).filter(k => k.startsWith('git-') && !ALWAYS_DENY_RULES.has(k)).join('、')}`,
      `永远拒绝、不能解锁：${[...ALWAYS_DENY_RULES].join('、')}（git add 或 git stage 的 -A / --all / . / *、强推）`,
      'git-no-verify 还管设置提交前检查的放行变量 BEIMING_PRECOMMIT_ALLOW：放行只由用户本人在 Claude Code 之外的终端里做。',
      `日志：${DEFAULT_LOG}（${LOG_ENV}=off 关闭，=<路径> 改写），每行是 Claude Code 钩子载荷格式。说明：.claude/hooks/README.md`,
    ],
    options: {
      explain: { type: 'boolean', describe: '判定一次工具调用（人工查询模式；带其他选项时可以省略）' },
      tool: textOption('<工具>', 'Write、Edit、Bash、PowerShell、Read、Skill、mcp__… 等', 'Bash'),
      path: textOption('<路径>', '写文件或读文件的目标（相对 --cwd）', 'cases/vendor/x.js'),
      command: textOption('<命令>', 'Bash / PowerShell 命令文本', '"git add -A"'),
      skill: textOption('<名字>', 'Skill 工具调用的 skill 名', 'lemo-opuscar:lemo-opuscar'),
      input: textOption('<文件>', '一个完整的 PreToolUse 事件 JSON 文件'),
      cwd: textOption('<目录>', '模拟的工作目录（默认当前目录）'),
    },
    examples: ['node .claude/hooks/guard.mjs --explain --tool Write --path cases/vendor/x.js',
      'node .claude/hooks/guard.mjs --explain --tool Bash --command "git add -A" --json',
      'node .claude/hooks/guard.mjs --explain --tool PowerShell --command "Remove-Item -Recurse cases\\vendor"'],
    exitCodes: { 0: '放行', 2: '用法错误', 4: '会被拒绝', 1: '内部错误' },
    run(ctx) {
      const o = ctx.opts;
      let event;
      if (o.input) {
        try { event = JSON.parse(fs.readFileSync(path.resolve(o.input), 'utf8')); } catch (e) {
          throw new CliError('usage.bad-input', `读不了 --input ${o.input}：${e.message}`, '给一个 PreToolUse 事件 JSON 文件');
        }
      } else {
        if (!o.tool) throw new CliError('usage.missing-tool', '需要 --tool（或 --input 事件文件）', '例：--tool Write --path cases/vendor/x.js');
        const input = {};
        if (o.path !== null) { input.file_path = path.resolve(o.cwd ?? process.cwd(), o.path); input.path = input.file_path; }
        if (o.command !== null) input.command = o.command;
        if (o.skill !== null) input.skill = o.skill;
        if (!Object.keys(input).length) throw new CliError('usage.missing-target', '需要 --path、--command 或 --skill 之一', '见 --help');
        event = { tool_name: o.tool, tool_input: input, cwd: path.resolve(o.cwd ?? process.cwd()) };
      }
      const d = decide(event, { root: ROOT });
      if (d.decision === 'deny') {
        ctx.out(`拒绝：${d.reason}`);
        const next = RULES[d.rule]?.next ?? ZONES.find(z => `zone-${z.id}` === d.rule)?.next ?? null;
        return { exitCode: 4, data: { decision: d }, error: { code: `contract.${d.rule}`, message: d.reason, hint: next } };
      }
      ctx.out(`放行${d.context ? `（附提醒）：${d.context}` : ''}`);
      return { data: { decision: d } };
    },
  });
  await runCli(command, argv);
}

const isMainModule = (() => { try { return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMainModule) {
  const argv = process.argv.slice(2);
  if (argv.length) {
    explainCli(argv).catch((e) => { process.stderr.write(`北冥护栏内部错误：${e?.stack ?? e}\n`); process.exit(1); });
  } else {
    hookMode().catch((e) => {
      process.stderr.write(`北冥护栏内部错误（本次不判定）：${e?.stack ?? e}\n`);
      process.exit(1);
    });
  }
}
