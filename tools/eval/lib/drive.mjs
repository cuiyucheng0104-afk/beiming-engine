// 会话驱动：无头运行 claude -p，在代理停下时按 replies 脚本以「用户」身份回复，再用 --resume 继续。
//
// 每一轮：
//   1. 先把要发的消息记进 injections.jsonl（时间、轮次、回复 id、审批含义、可引用的原话范围）；
//   2. 启动 claude -p <消息> --output-format stream-json --verbose …（第 1 轮 --session-id，之后 --resume），
//      stdout 落 transcript/turn-NN.jsonl，stderr 落 turn-NN.stderr.log；
//   3. 按剩余时间盒计时，到点结束整个进程组（stopReason = timeout）；
//   4. 记一份作品目录快照（snapshots/turn-NN.json）；
//   5. 读这一轮的 result：代理最后一段话 → 选下一条回复（selectReply），没有就结束。
// 人工干预：opts.next = { kind: 'manual', text, approves, waives } 时先发这一条（可在已结束的运行上续一轮）。
// 选回复（selectReply）：候选 = 尚未发出的脚本回复，从前往后直到第一条非 optional 的；
//   关键词命中记 2 分，「*」或「有新图片且像在请求审阅」记 1 分，取最高分（同分取靠前的），跳过的 optional 记为已跳过。
//   都不命中时，若代理像在提问或请求审阅、且兜底次数未用完，发兜底回复（不批准任何闸门）；否则结束。
// 接口：detectClaude(bin)、selectReply(state, stop)、looksLikeRequest(text)、driveRun(run, opts)

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EvalError, EXIT, envError } from './cli.mjs';
import { appendJsonl, readJsonIfExists, readJsonl, walk, writeJson } from './files.mjs';
import { filmDirOf, snapshotFilm } from './rundir.mjs';
import { sessionEnv } from './sandbox.mjs';

/** 停止原因里可以接着驱动的两种：被中断、按 --turns 暂停。其余（finished、stalled、timeout、max-turns、agent-error…）视为结束。 */
export const RESUMABLE = new Set(['interrupted', 'paused']);

/** 隔离会话用空的 CLAUDE_CONFIG_DIR，读不到评测机的登录状态：凭据只能经环境变量给出。 */
export const AUTH_ENV = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/** claude 可执行文件或 .mjs/.js 脚本（测试桩）→ [命令, 前置参数]。 */
export function claudeCommand(bin) {
  if (/\.(mjs|cjs|js)$/i.test(bin)) return [process.execPath, [bin]];
  return [bin, []];
}

/** 探测 claude CLI：版本与支持的参数（按 --help 文本判断，不发任何请求）。 */
export function detectClaude(bin = 'claude') {
  const [cmd, pre] = claudeCommand(bin);
  const v = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (v.error || v.status !== 0) throw envError('claude-missing', `无法运行 ${bin} --version（${v.error?.code ?? `exit ${v.status}`}）`, '安装 Claude Code CLI 并确认 claude 在 PATH 里，或用 --claude 指定可执行文件');
  const h = spawnSync(cmd, [...pre, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const help = `${h.stdout ?? ''}${h.stderr ?? ''}`;
  const has = flag => help.includes(flag);
  return {
    bin, version: v.stdout.trim(),
    settingSources: has('--setting-sources'), strictMcp: has('--strict-mcp-config'), settings: has('--settings'),
    sessionId: has('--session-id'), permissionPrompts: has('--permission-prompts'), forwardSubagentText: has('--forward-subagent-text'),
    hookEvents: has('--include-hook-events'), streamJson: has('stream-json'), resume: has('--resume'),
  };
}

const REQUEST = /(请(您|你)?(审阅|确认|查看|看一下|看看|选择|过目|指示|定夺|回复)|是否(可以|认可|继续|满意)|要不要|可以吗|行吗|您看|你看|等(你|您)的?(意见|确认|回复)|待(你|您)确认|确认后(我)?(再|继续)|认可(后|之后)|选(哪|定))/;

export function looksLikeRequest(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  return /[?？]\s*$/.test(s) || /[?？][^\n]{0,40}$/.test(s) || REQUEST.test(s);
}

/**
 * 选下一条回复。
 * @param {{ replies: object[], sentIds: Set<string>, skippedIds: Set<string>, fallbacksUsed: number, fallback: {text, max} }} state
 * @param {{ text: string, newImages: boolean }} stop
 * @returns {{ kind: 'scripted', reply, skipped: string[], reason } | { kind: 'fallback', text, reason } | { kind: 'none', reason }}
 */
export function selectReply(state, stop) {
  const pending = state.replies.filter(r => !state.sentIds.has(r.id) && !state.skippedIds.has(r.id));
  const candidates = [];
  for (const r of pending) { candidates.push(r); if (!r.optional) break; }
  const isRequest = looksLikeRequest(stop.text);
  let best = null;
  candidates.forEach((r, i) => {
    const words = r.expect.filter(w => w !== '*');
    let score = 0;
    let reason = '';
    if (words.some(w => stop.text.includes(w))) { score = 2; reason = `命中关键词「${words.find(w => stop.text.includes(w))}」`; }
    else if (r.expect.includes('*') && (isRequest || stop.newImages)) { score = 1; reason = '代理在请求审阅（通配）'; }
    else if (r.whenNewImages && stop.newImages && isRequest) { score = 1; reason = '有新图片且在请求审阅'; }
    if (score && (!best || score > best.score)) best = { r, i, score, reason };
  });
  if (best) return { kind: 'scripted', reply: best.r, skipped: candidates.slice(0, best.i).map(r => r.id), reason: best.reason };
  if (isRequest && state.fallback?.text && state.fallbacksUsed < (state.fallback.max ?? 0)) return { kind: 'fallback', text: state.fallback.text, reason: '代理在提问或请求审阅，但不对应脚本里的下一道闸门' };
  return { kind: 'none', reason: isRequest ? '代理仍在提问，但兜底次数已用完' : '代理没有再请求审阅，视为完成' };
}

function newImagesSince(run, sinceMs) {
  const film = filmDirOf(run);
  if (!film.dir || !fs.existsSync(film.dir)) return false;
  return walk(film.dir, { skipDirs: new Set(['node_modules']) }).some(e => /\.(png|jpe?g|webp)$/i.test(e.rel) && e.mtimeMs > sinceMs);
}

function lastResult(file) {
  const { records } = readJsonl(file);
  const result = [...records].reverse().find(r => r.type === 'result');
  const init = records.find(r => r.type === 'system' && r.subtype === 'init');
  const lastText = [...records].reverse().find(r => r.type === 'assistant' && !r.parent_tool_use_id && (r.message?.content ?? []).some(b => b.type === 'text'));
  const text = result?.result ?? (lastText ? lastText.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '');
  return { result, init, text: typeof text === 'string' ? text : '' };
}

function spawnTurn(run, features, { message, turn, sessionId, firstTurn, model, effort, permissionMode, extraArgs }, timeLeftMs, onChild) {
  const tdir = path.join(run.dir, 'transcript');
  fs.mkdirSync(tdir, { recursive: true });
  const out = path.join(tdir, `turn-${String(turn).padStart(2, '0')}.jsonl`);
  const err = path.join(tdir, `turn-${String(turn).padStart(2, '0')}.stderr.log`);
  // 上次在这一轮被中断：留下的半截记录改名保存（里面的工具调用仍是证据），不覆盖
  if (fs.existsSync(out)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    fs.renameSync(out, path.join(tdir, `turn-${String(turn).padStart(2, '0')}.partial-${stamp}.jsonl`));
    if (fs.existsSync(err)) fs.renameSync(err, path.join(tdir, `turn-${String(turn).padStart(2, '0')}.partial-${stamp}.stderr.log`));
  }
  const args = ['-p', message, '--output-format', 'stream-json', '--verbose'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  args.push('--permission-mode', permissionMode);
  if (features.permissionPrompts) args.push('--permission-prompts', 'none');
  if (features.settings) args.push('--settings', path.join(run.sessionDir, 'settings.json'));
  if ((run.meta.isolation ?? 'isolated') === 'isolated') {
    args.push('--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', path.join(run.sessionDir, 'mcp.json'));
  }
  if (features.forwardSubagentText) args.push('--forward-subagent-text');
  if (features.hookEvents) args.push('--include-hook-events');
  if (firstTurn) { if (features.sessionId) args.push('--session-id', sessionId); }
  else args.push('--resume', sessionId);
  args.push(...extraArgs);
  const [cmd, pre] = claudeCommand(features.bin);
  const outFd = fs.openSync(out, 'w');
  const errFd = fs.openSync(err, 'w');
  return new Promise(resolve => {
    const startedAt = Date.now();
    let timedOut = false;
    const child = spawn(cmd, [...pre, ...args], { cwd: run.worktree, env: sessionEnv(run), stdio: ['ignore', outFd, errFd], windowsHide: true, detached: process.platform !== 'win32' });
    onChild(child);
    const killTree = signal => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(-child.pid, signal); } catch { /* 已退出 */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 10000).unref(); }, Math.max(1000, timeLeftMs));
    const done = (code, signal, error) => {
      clearTimeout(timer);
      onChild(null);
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve({ out, err, startedAt, endedAt: Date.now(), exitCode: code, signal: signal ?? null, timedOut, error: error ? String(error.message ?? error) : null, args });
    };
    child.on('error', e => done(null, null, e));
    child.on('exit', (code, signal) => done(code, signal, null));
  });
}

/**
 * 驱动一个运行目录直到代理完成、时间盒到点或出错。可在中断后再次调用，从 drive.json 记下的状态继续。
 * @param {object} run loadRun() 的结果
 * @param {{ claude?: string, model?: string, effort?: string, permissionMode?: string, timeboxMinutes?: number,
 *           maxTurns?: number, extraArgs?: string[], log?: Function, onChild?: Function, features?: object }} opts
 */
export async function driveRun(run, opts = {}) {
  const log = opts.log ?? (() => {});
  const features = opts.features ?? detectClaude(opts.claude ?? 'claude');
  if ((run.meta.isolation ?? 'isolated') === 'isolated' && !(features.settingSources && features.strictMcp)) {
    throw envError('claude-isolation-unsupported', `这个版本的 claude（${features.version}）不支持 --setting-sources / --strict-mcp-config，做不到计划书 7.1 要求的会话隔离`, '升级 Claude Code CLI；或明确做「带用户全局环境」的对照组：prepare 时加 --isolation user-env');
  }
  if (!features.streamJson || !features.resume) throw envError('claude-unsupported', `这个版本的 claude（${features.version}）不支持 stream-json 或 --resume`, '升级 Claude Code CLI');
  if ((run.meta.isolation ?? 'isolated') === 'isolated' && !AUTH_ENV.some(k => process.env[k]) && !opts.features) {
    log(`提示：隔离会话读不到本机的登录状态，当前终端里没有 ${AUTH_ENV.slice(0, 2).join(' / ')} 等凭据变量；第一轮若报未登录，先 claude setup-token 再 export CLAUDE_CODE_OAUTH_TOKEN=…（PowerShell：$env:CLAUDE_CODE_OAUTH_TOKEN = '…'）`);
  }
  const lockFile = path.join(run.dir, 'drive.lock');
  let lockFd;
  try { lockFd = fs.openSync(lockFile, 'wx'); } catch {
    throw new EvalError('run-busy', `另一个 drive 正在驱动这个运行目录（${lockFile} 存在）`, { exitCode: EXIT.BUSY, hint: '等它结束；确认没有在跑之后删掉 drive.lock 再重试' });
  }
  fs.writeSync(lockFd, String(process.pid));
  const driveFile = path.join(run.dir, 'drive.json');
  const prev = readJsonIfExists(driveFile);
  const state = prev ?? {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    claude: { bin: features.bin, version: features.version },
    model: opts.model ?? null,
    sessionId: crypto.randomUUID(),
    turns: [],
    sentIds: [],
    skippedIds: [],
    fallbacksUsed: 0,
    agentSeconds: 0,
    stopReason: null,
  };
  if (prev?.stopReason && !RESUMABLE.has(prev.stopReason) && !opts.next) {
    fs.closeSync(lockFd); fs.rmSync(lockFile, { force: true });
    return { state: prev, alreadyFinished: true };
  }
  const timeboxMs = (opts.timeboxMinutes ?? run.task.timeboxMinutes) * 60 * 1000;
  const maxTurns = opts.maxTurns ?? 12;
  const save = () => writeJson(driveFile, { ...state, updatedAt: new Date().toISOString() });
  const injectionsFile = path.join(run.dir, 'injections.jsonl');
  const { records: injected } = readJsonl(injectionsFile);
  let seq = injected.length;
  const replies = run.replies?.replies ?? [];
  const sel = { replies, sentIds: new Set(state.sentIds), skippedIds: new Set(state.skippedIds), fallbacksUsed: state.fallbacksUsed, fallback: run.replies?.fallback ?? { text: null, max: 0 } };

  state.stopReason = null;
  let next;
  let budget = opts.maxNewTurns ?? Infinity;
  if (opts.next) {
    next = { kind: opts.next.kind ?? 'manual', text: opts.next.text, approves: opts.next.approves ?? [], waives: opts.next.waives ?? [], replyId: opts.next.replyId ?? null, gate: opts.next.gate ?? null, reason: opts.next.reason ?? '评测方人工发出' };
    if (!state.turns.length) throw new EvalError('run-not-started', '这个运行还没有发过任务书，不能先发人工消息', { exitCode: EXIT.USAGE, hint: '先用 run.mjs drive 发任务书' });
  } else if (!state.turns.length) {
    next = { kind: 'prompt', text: run.prompt, approves: run.replies?.prompt?.approves ?? [], waives: run.replies?.prompt?.waives ?? [], quoteScope: run.meta.promptQuoteScope ?? run.prompt };
  } else {
    // 中断后继续：重新判断最后一轮之后该发什么
    const last = state.turns[state.turns.length - 1];
    const { text } = lastResult(last.out ? path.resolve(run.dir, last.out) : '');
    next = choose(text, Date.parse(last.endedAt));
  }

  function choose(text, sinceMs) {
    const pick = selectReply(sel, { text, newImages: newImagesSince(run, sinceMs) });
    if (pick.kind === 'scripted') {
      for (const id of pick.skipped) sel.skippedIds.add(id);
      return { kind: 'scripted', text: pick.reply.text, replyId: pick.reply.id, gate: pick.reply.gate, approves: pick.reply.approves, waives: pick.reply.waives, reason: pick.reason, skipped: pick.skipped };
    }
    if (pick.kind === 'fallback') return { kind: 'fallback', text: pick.text, approves: [], waives: [], reason: pick.reason };
    return { kind: 'none', reason: pick.reason };
  }

  try {
    while (next.kind !== 'none') {
      if (budget-- <= 0) { state.stopReason = 'paused'; state.stopNote = '已按要求只续了指定的轮数'; break; }
      if (state.turns.length >= maxTurns) { state.stopReason = 'max-turns'; break; }
      const left = timeboxMs - state.agentSeconds * 1000;
      if (left <= 0) { state.stopReason = 'timeout'; break; }
      const turn = state.turns.length + 1;
      appendJsonl(injectionsFile, {
        seq: seq++, turn, at: new Date().toISOString(), kind: next.kind, replyId: next.replyId ?? null, gate: next.gate ?? null,
        text: next.text, quoteScope: next.quoteScope ?? next.text, approves: next.approves, waives: next.waives, reason: next.reason ?? null, skipped: next.skipped ?? [],
      });
      if (next.kind === 'scripted' && next.replyId) sel.sentIds.add(next.replyId);
      if (next.kind === 'fallback') sel.fallbacksUsed++;
      log(`第 ${turn} 轮：发送${{ prompt: '任务书', scripted: `脚本回复 ${next.replyId}`, fallback: '兜底回复', manual: '人工回复' }[next.kind]}（剩余时间盒 ${Math.round(left / 60000)} 分钟）`);
      const res = await spawnTurn(run, features, {
        message: next.text, turn, sessionId: state.sessionId, firstTurn: turn === 1, model: opts.model, effort: opts.effort,
        permissionMode: opts.permissionMode ?? 'acceptEdits', extraArgs: opts.extraArgs ?? [],
      }, left, child => opts.onChild?.(child));
      const { result, init, text } = lastResult(res.out);
      if (turn === 1 && !features.sessionId && (init?.session_id || result?.session_id)) state.sessionId = init?.session_id ?? result?.session_id;
      const seconds = (res.endedAt - res.startedAt) / 1000;
      state.agentSeconds += seconds;
      state.turns.push({
        turn, startedAt: new Date(res.startedAt).toISOString(), endedAt: new Date(res.endedAt).toISOString(), seconds: Math.round(seconds * 10) / 10,
        exitCode: res.exitCode, signal: res.signal, timedOut: res.timedOut, error: res.error,
        resultSubtype: result?.subtype ?? null, isError: result?.is_error ?? null, model: init?.model ?? null,
        out: path.relative(run.dir, res.out).split(path.sep).join('/'), stderr: path.relative(run.dir, res.err).split(path.sep).join('/'),
        sent: next.kind === 'prompt' ? 'prompt' : (next.replyId ?? next.kind),
      });
      if (!state.model && init?.model) state.model = init.model;
      try { snapshotFilm(run, turn); } catch (e) { log(`提示：第 ${turn} 轮的作品快照没写成（${e.message}），不影响判定`); }
      state.sentIds = [...sel.sentIds];
      state.skippedIds = [...sel.skippedIds];
      state.fallbacksUsed = sel.fallbacksUsed;
      save();
      if (res.timedOut) { state.stopReason = 'timeout'; break; }
      if (res.error) { state.stopReason = 'spawn-error'; state.error = res.error; break; }
      if (!result) { state.stopReason = 'agent-crashed'; state.error = `第 ${turn} 轮没有 result 记录（exit ${res.exitCode}${res.signal ? `，${res.signal}` : ''}），见 ${state.turns.at(-1).stderr}`; break; }
      if (result.is_error && result.subtype !== 'success') { state.stopReason = 'agent-error'; state.error = `第 ${turn} 轮以 ${result.subtype} 结束`; break; }
      next = choose(text, res.startedAt);
      if (next.kind === 'none') { state.stopReason = /用完/.test(next.reason) ? 'stalled' : 'finished'; state.stopNote = next.reason; }
    }
    if (!state.stopReason) { state.stopReason = /用完/.test(next.reason ?? '') ? 'stalled' : 'finished'; state.stopNote = next.reason ?? null; }
  } catch (e) {
    state.stopReason = 'interrupted';
    state.error = String(e?.message ?? e);
    throw e;
  } finally {
    state.endedAt = new Date().toISOString();
    state.agentSeconds = Math.round(state.agentSeconds * 10) / 10;
    state.unsentReplies = replies.filter(r => !sel.sentIds.has(r.id) && !sel.skippedIds.has(r.id)).map(r => r.id);
    save();
    try { fs.closeSync(lockFd); } catch { /* 已关闭 */ }
    fs.rmSync(lockFile, { force: true });
  }
  return { state };
}
