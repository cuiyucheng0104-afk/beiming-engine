#!/usr/bin/env node
// 测试桩：模拟 Claude Code CLI 的无头模式（claude -p … --output-format stream-json），只供 tests/eval/ 使用。
//
//   node claude-stub.mjs --version | --help
//   node claude-stub.mjs -p <消息> --output-format stream-json --verbose [--session-id <id> | --resume <id>] [其余参数照收]
//
// 行为由环境变量 EVAL_STUB_CLAUDE（剧本 JSON 文件路径）决定。剧本：
//   { "turns": [ { "expect": "<消息里应含的字>", "actions": [动作…], "text": "<这一轮最后一段话>", "exit": 0, "sleepMs": 0,
//                  "isError": false } ] }
//   动作：{ "write": "<相对工作目录的路径>", "content": "…" }   真写文件，并记一次 Write 调用
//         { "copy": "<绝对路径>", "to": "<相对路径>" }           真复制文件（成片），并记一次 Bash cp 调用
//         { "bash": "<命令>", "result": "…" }                    只记一次 Bash 调用，不执行
//         { "tool": "<工具名>", "input": { … } }                 只记一次任意工具调用
// 第几轮由剧本旁的 <剧本>.state.json 计数（不写会话的 TMPDIR，免得被当成残留）。
// 设了 CLAUDE_CONFIG_DIR 时，同时把记录写进 <配置目录>/projects/<编码后的工作目录>/<会话>.jsonl（模拟会话持久化）。
// EVAL_STUB_NO_ISOLATION=1：--help 里不列 --setting-sources / --strict-mcp-config（模拟旧版 CLI）。

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('9.9.9 (Claude Code 测试桩)\n'); process.exit(0); }
if (argv.includes('--help')) {
  const flags = ['-p, --print', '--output-format <format> "text", "json", or "stream-json"', '--verbose', '--session-id <uuid>', '-r, --resume [value]', '--settings <file-or-json>', '--permission-mode <mode>', '--permission-prompts <target>', '--forward-subagent-text', '--include-hook-events', '--mcp-config <configs...>', '--model <model>', '--effort <level>', '--max-budget-usd <amount>'];
  if (process.env.EVAL_STUB_NO_ISOLATION !== '1') flags.push('--setting-sources <sources>', '--strict-mcp-config');
  process.stdout.write(`Usage: claude [options] [prompt]\n\nOptions:\n${flags.map(f => `  ${f}`).join('\n')}\n`);
  process.exit(0);
}
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const message = opt('-p') ?? '';
const sessionId = opt('--session-id') ?? opt('--resume') ?? '00000000-0000-4000-8000-000000000000';
const scriptFile = process.env.EVAL_STUB_CLAUDE;
if (!scriptFile) { process.stderr.write('测试桩：没有设置 EVAL_STUB_CLAUDE\n'); process.exit(2); }
const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
const stateFile = `${scriptFile}.state.json`;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { turn: 0, sessionId: null };
if (state.turn > 0 && opt('--resume') !== state.sessionId) { process.stderr.write(`测试桩：第 ${state.turn + 1} 轮应 --resume ${state.sessionId}\n`); process.exit(3); }
const turn = script.turns[state.turn];
state.turn += 1;
state.sessionId = sessionId;
fs.writeFileSync(stateFile, JSON.stringify(state));

const records = [];
const emit = rec => { const r = { ...rec, session_id: sessionId, timestamp: new Date().toISOString() }; records.push(r); process.stdout.write(JSON.stringify(r) + '\n'); };
let seq = 0;
const call = (name, input, result = 'ok', isError = false) => {
  const id = `toolu_stub_${state.turn}_${++seq}`;
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] }, parent_tool_use_id: null });
};

const isolated = argv.includes('--strict-mcp-config');
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-stub', tools: ['Bash', 'Read', 'Write', 'Edit'], mcp_servers: isolated ? [] : [{ name: 'stub-global-mcp', status: 'connected' }], plugins: [], permissionMode: opt('--permission-mode') ?? 'default', apiKeySource: 'none', slash_commands: [] });
if (!turn) {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '（剧本已经演完）' }] }, parent_tool_use_id: null });
  emit({ type: 'result', subtype: 'success', is_error: false, result: '（剧本已经演完）', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
  process.exit(0);
}
if (turn.expect && !message.includes(turn.expect)) {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `测试桩：第 ${state.turn} 轮的消息里没有「${turn.expect}」：${message.slice(0, 80)}`, duration_ms: 1, num_turns: 1, usage: {}, permission_denials: [] });
  process.exit(1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (turn.sleepMs) await sleep(turn.sleepMs);
for (const a of turn.actions ?? []) {
  if (a.write) {
    const abs = path.resolve(a.write);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, a.content ?? '');
    call('Write', { file_path: abs, content: (a.content ?? '').slice(0, 200) }, '已写入');
  } else if (a.copy) {
    const dst = path.resolve(a.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(a.copy, dst);
    const now = new Date();
    fs.utimesSync(dst, now, now);   // 模拟「刚渲染出来」：macOS 的 copyfile 会连修改时间一起复制
    call('Bash', { command: `cp ${JSON.stringify(a.copy)} ${JSON.stringify(a.to)}` }, '');
  } else if (a.bash) call('Bash', { command: a.bash }, a.result ?? '', Boolean(a.isError));
  else if (a.tool) call(a.tool, a.input ?? {}, a.result ?? 'ok', Boolean(a.isError));
}
emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: turn.text ?? '' }] }, parent_tool_use_id: null });
emit({ type: 'result', subtype: turn.isError ? 'error_during_execution' : 'success', is_error: Boolean(turn.isError), result: turn.text ?? '', duration_ms: 1000, num_turns: 2, total_cost_usd: 0.002, usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }, permission_denials: [] });
if (process.env.CLAUDE_CONFIG_DIR) {
  const proj = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.appendFileSync(path.join(proj, `${sessionId}.jsonl`), records.filter(r => r.type !== 'result').map(r => JSON.stringify(r)).join('\n') + '\n');
}
process.exit(turn.exit ?? 0);
