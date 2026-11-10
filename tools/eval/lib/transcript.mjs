// 会话记录解析：把两种 Claude Code 会话记录归一成同一组事件。
//
//   1. stream-json：`claude -p --output-format stream-json --verbose` 的标准输出，run.mjs 每轮存成
//      transcript/turn-NN.jsonl（被中断的半轮另存 turn-NN.partial-<时间>.jsonl）；子代理的消息带 parent_tool_use_id。
//   2. 会话 JSONL：Claude Code 存在 <配置目录>/projects/<项目>/<会话>.jsonl 的原始记录，run.mjs finish 时
//      复制到 transcript/session/；子代理记录带 isSidechain:true（agentId 区分）。评测方手工操作交互式
//      会话时只有这一种。
// 两种都存在时只用 stream-json（避免重复计数）。坏行计数、不中断。
// 接口：loadTranscript(runDir) → { source, files, badLines, inits, results, toolUses, userTexts,
//        assistantTexts, hookEvents, actors, finalText }；parseRecords(records, { source, turn })

import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, walk } from './files.mjs';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

function contentBlocks(message) {
  if (!message) return [];
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return Array.isArray(message.content) ? message.content : [];
}

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(c => (typeof c === 'string' ? c : c.text ?? '')).join('\n');
  return '';
}

const DENIAL = /permission to use .* (has been|was) denied|has been denied|was blocked|blocked by (a )?hook|not allowed|拒绝|已阻止|被阻止|denied by/i;

function emptyTranscript() {
  return { source: 'none', files: [], badLines: 0, inits: [], results: [], toolUses: [], userTexts: [], assistantTexts: [], hookEvents: [], actors: {}, finalText: '' };
}

/**
 * 把一组记录追加进 transcript（就地修改）。
 * @param {object} t 由 emptyTranscript() 得到的对象
 * @param {object[]} records
 * @param {{ source: 'stream'|'session', turn?: number, file?: string }} opts
 */
export function parseRecords(t, records, { source, turn: fixedTurn = null, file = null } = {}) {
  const byId = new Map(t.toolUses.map(u => [u.id, u]));
  let turn = fixedTurn ?? (t._turn ?? 0);
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const seq = (t._seq = (t._seq ?? 0) + 1);
    const at = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    const actor = rec.parent_tool_use_id ? rec.parent_tool_use_id
      : rec.isSidechain ? (rec.agentId ? `agent:${rec.agentId}` : `sidechain:${path.basename(file ?? 'unknown')}`)
        : 'main';
    if (rec.type === 'system' && rec.subtype === 'init') {
      t.inits.push({
        turn, model: rec.model ?? null, cwd: rec.cwd ?? null, sessionId: rec.session_id ?? null,
        tools: rec.tools ?? [], mcpServers: rec.mcp_servers ?? [], skills: rec.skills ?? null,
        plugins: rec.plugins ?? null, slashCommands: rec.slash_commands ?? null, agents: rec.agents ?? null,
        permissionMode: rec.permissionMode ?? null, apiKeySource: rec.apiKeySource ?? null,
      });
      continue;
    }
    if (rec.type === 'system' && /hook/i.test(String(rec.subtype ?? ''))) { t.hookEvents.push({ turn, seq, ...rec }); continue; }
    if (rec.hook_event_name && rec.tool_name) {
      // Claude Code 钩子载荷格式（PreToolUse 等），来自 hook 日志
      t.hookEvents.push({ turn, seq, ...rec });
      t.toolUses.push({ seq, turn, actor: 'main', tool: rec.tool_name, input: rec.tool_input ?? {}, id: rec.tool_use_id ?? `hook-${seq}`, result: null, denied: /deny|block/i.test(String(rec.decision ?? rec.permissionDecision ?? '')), at, source: 'hook' });
      continue;
    }
    if (rec.type === 'result') {
      t.results.push({
        turn, subtype: rec.subtype ?? null, isError: Boolean(rec.is_error), text: typeof rec.result === 'string' ? rec.result : '',
        sessionId: rec.session_id ?? null, durationMs: rec.duration_ms ?? null, numTurns: rec.num_turns ?? null,
        costUsd: rec.total_cost_usd ?? null, usage: rec.usage ?? null, permissionDenials: rec.permission_denials ?? [],
      });
      for (const d of rec.permission_denials ?? []) {
        const u = byId.get(d.tool_use_id);
        if (u) u.denied = true;
      }
      continue;
    }
    if (rec.type === 'assistant') {
      for (const block of contentBlocks(rec.message)) {
        if (block.type === 'text' && block.text) t.assistantTexts.push({ seq, turn, actor, text: block.text });
        if (block.type === 'tool_use') {
          const use = { seq, turn, actor, tool: block.name, input: block.input ?? {}, id: block.id ?? `anon-${seq}`, result: null, denied: false, at, source };
          t.toolUses.push(use);
          byId.set(use.id, use);
          if (SUBAGENT_TOOLS.has(block.name)) {
            t.actors[use.id] = { label: block.input?.description ?? block.input?.subagent_type ?? use.id, subagentType: block.input?.subagent_type ?? null, prompt: block.input?.prompt ?? '' };
          }
        }
      }
      continue;
    }
    if (rec.type === 'user') {
      const blocks = contentBlocks(rec.message);
      let plainText = '';
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const u = byId.get(block.tool_use_id);
          const text = resultText(block);
          if (u) {
            u.result = { isError: Boolean(block.is_error), text };
            if (block.is_error && DENIAL.test(text)) u.denied = true;
          }
        } else if (block.type === 'text' && block.text) {
          plainText += (plainText ? '\n' : '') + block.text;
        }
      }
      if (plainText && actor === 'main' && !rec.isMeta) {
        if (fixedTurn === null) turn += 1;
        t.userTexts.push({ seq, turn, text: plainText, at });
      }
    }
  }
  if (fixedTurn === null) t._turn = turn;
  return t;
}

/** 读一个运行目录的会话记录。 */
export function loadTranscript(runDir) {
  const t = emptyTranscript();
  const dir = path.join(runDir, 'transcript');
  // turn-NN.jsonl 是完整的一轮；turn-NN.partial-<时间>.jsonl 是被中断的半轮（排在同号完整轮之前），里面的调用同样计入
  const streamFiles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => /^turn-\d+(\.partial-[0-9TZ]+)?\.jsonl$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]) || (a.includes('.partial-') ? -1 : 1) - (b.includes('.partial-') ? -1 : 1) || a.localeCompare(b))
    : [];
  if (streamFiles.length) {
    t.source = 'stream';
    for (const f of streamFiles) {
      const file = path.join(dir, f);
      const { records, bad } = readJsonl(file);
      t.badLines += bad;
      t.files.push(file);
      parseRecords(t, records, { source: 'stream', turn: Number(f.match(/\d+/)[0]), file });
    }
  } else {
    const sessionDir = path.join(dir, 'session');
    const files = walk(sessionDir, { skipDirs: new Set() }).filter(e => e.rel.endsWith('.jsonl')).map(e => e.abs).sort();
    // 主会话文件在前，子代理文件在后：子代理记录 isSidechain:true，不影响轮次计数
    const main = files.filter(f => !/agent-[^/\\]*\.jsonl$/.test(f));
    const side = files.filter(f => /agent-[^/\\]*\.jsonl$/.test(f));
    if (files.length) t.source = 'session';
    for (const file of [...main, ...side]) {
      const { records, bad } = readJsonl(file);
      t.badLines += bad;
      t.files.push(file);
      parseRecords(t, records, { source: 'session', file });
    }
  }
  const hookLog = path.join(runDir, 'hooks.jsonl');
  if (fs.existsSync(hookLog)) {
    const { records, bad } = readJsonl(hookLog);
    t.badLines += bad;
    t.files.push(hookLog);
    // 钩子日志只补会话记录里没有的调用（按 tool_use_id 去重）
    const known = new Set(t.toolUses.map(u => u.id));
    parseRecords(t, records.filter(r => !r.tool_use_id || !known.has(r.tool_use_id)), { source: 'hook', turn: 0, file: hookLog });
  }
  const lastResult = [...t.results].reverse().find(r => r.text);
  const lastMain = [...t.assistantTexts].reverse().find(a => a.actor === 'main');
  t.finalText = lastResult?.text ?? lastMain?.text ?? '';
  delete t._seq;
  delete t._turn;
  return t;
}

/** 子代理标签：main 返回「导演（主会话）」，其余用 Task/Agent 调用的 description。 */
export function actorLabel(t, actor) {
  if (actor === 'main') return '主会话';
  return t.actors[actor]?.label ?? actor;
}
