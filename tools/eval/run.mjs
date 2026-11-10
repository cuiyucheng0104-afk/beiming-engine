#!/usr/bin/env node
// 北冥 agent 验收 · 评测运行（计划书 4.2 P17、7.1 通用规则）。一次「运行」= 一道题的一次独立尝试，全部状态放在
// 仓库外的运行目录 <评测根>/<题号>/<运行号>/ 里（布局见 tools/eval/lib/rundir.mjs）。
//
//   node tools/eval/run.mjs bank
//        校验题库：任务配置、发给代理的原文、脚本化回复互相一致；列出全部题目
//   node tools/eval/run.mjs prepare --task <题号> [--commit <提交>] [--root <评测根>] [--isolation isolated|user-env]
//                                   [--env cold|prepared] [--node-modules link|install|none] [--attempt <n>]
//        为指定提交在仓库外建干净检出（git clone，删除远端；题库 evals/ 由评测方提交删掉），按题目准备环境与预置文件，
//        写隔离的会话配置、记录基线
//   node tools/eval/run.mjs drive <运行目录> [--claude <可执行文件>] [--model <模型>] [--effort <档>] [--turns <n>]
//        无头驱动：claude -p 发任务书；代理停在闸门时按 evals/agent/replies/ 的脚本以「用户」身份回复，再 --resume 继续，
//        直到完成、时间盒到点或出错；每轮的 stream-json 存 transcript/turn-NN.jsonl，墙钟只计代理在跑的时间
//   node tools/eval/run.mjs reply <运行目录> (--prompt | --reply-id <回复> | --text <原话> [--approves g] [--waives g]) [--send]
//        记一条发给代理的消息（交互式评测，或人工干预）；--send 时立刻用 --resume 发出并跑完这一轮
//   node tools/eval/run.mjs finish <运行目录> [--tools-root <检出>] [--session-id <会话>] [--no-materials]
//        收尾：复制会话 JSONL、判定硬门（gates.json）、登记产物（artifacts.json）、取评审素材与参考指标（review/）、
//        生成或刷新评审表（review-sheet.json）
//   node tools/eval/run.mjs status <运行目录>
//   node tools/eval/run.mjs clean <运行目录> [--force] [--all]
//        删除被测检出、tmp/ 与 cache/（保留会话记录、快照、评审素材与报告）；--all 连运行目录一起删
// 退出码按附录 C1：0 成功；1 运行失败（会话崩溃、无法启动）；2 用法错误；3 环境或依赖缺失；4 题库或闸门不合格；5 运行目录被占用。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT, EvalError, runCli, usageError } from './lib/cli.mjs';
import { RESUMABLE, driveRun } from './lib/drive.mjs';
import { killAll } from './lib/exec.mjs';
import { appendJsonl, listEntries, readJsonIfExists, readJsonl, removeTree, sha256File, walk, writeJson } from './lib/files.mjs';
import { git, resolveCommit, statusEntries } from './lib/git.mjs';
import { buildMaterials } from './lib/materials.mjs';
import { homeDir, toPosix } from './lib/paths.mjs';
import { RUN_KIND, filmDirOf, filmRenderRuns, latestFilmRun, loadRun, newRunId } from './lib/rundir.mjs';
import {
  assertEvalRoot, assertRequiredEnv, captureBaseline, cloneAt, commandText, hideAnswerKey, lemoEnvVars, platformInfo, prepareEnvironment,
  resolveEvalRoot, seedWorktree, writeSessionConfig,
} from './lib/sandbox.mjs';
import { buildSheet, scoreRun } from './lib/scoring.mjs';
import { REPO_ROOT, firstMessage, listTaskIds, loadReplies, loadTask, validateBank } from './lib/task.mjs';

const SAFETY_NOTE = '代理在被测检出里有完整的 Bash 权限，并继承当前终端的环境变量；正式评测请用专用的低权限系统账户或虚拟机（evals/agent/README.md「安全」）';

const rel = (base, p) => toPosix(path.relative(base, p));

// ───────────────────────── bank ─────────────────────────

async function cmdBank() {
  const results = validateBank();
  const rows = results.map(r => {
    let t = null;
    try { t = loadTask(r.id); } catch { /* 已在 errors 里 */ }
    return { id: r.id, ok: r.ok, errors: r.errors, kind: t?.kind ?? null, title: t?.title ?? null, route: t?.route ?? null, environment: t?.environment ?? null, timeboxMinutes: t?.timeboxMinutes ?? null, attempts: t?.attempts ?? null, hardGates: t?.hardGates ?? null };
  });
  const bad = rows.filter(r => !r.ok);
  const text = [
    `题库 evals/agent/tasks/：${rows.length} 道，${bad.length ? `${bad.length} 道不合格` : '全部合格'}`,
    ...rows.map(r => `  ${r.id.padEnd(5)} ${(r.kind ?? '?').padEnd(6)} ${r.title ?? ''}${r.route ? `（${r.route.toUpperCase()} 路线）` : ''}  ${r.environment ?? ''} · ${r.timeboxMinutes ?? '?'} 分钟 × ${r.attempts ?? '?'} 次 · ${r.hardGates?.join(' ') ?? ''}${r.ok ? '' : `\n         不合格：${r.errors.join('；')}`}`),
  ].join('\n');
  return { exitCode: bad.length ? EXIT.CONTRACT : EXIT.OK, data: { tasks: rows }, text, error: bad.length ? { code: 'bank-invalid', message: `${bad.map(b => b.id).join('、')} 不合格`, hint: '按 evals/agent/schema/ 修正后重跑 bank' } : null };
}

// ───────────────────────── prepare ─────────────────────────

function nextAttempt(root, taskId, commit) {
  const short = commit.slice(0, 7);
  const re = new RegExp(`-${short}-a(\\d+)$`);
  const nums = listEntries(path.join(root, taskId)).map(n => re.exec(n)).filter(Boolean).map(m => Number(m[1]));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

async function cmdPrepare({ opts }, ctx) {
  const ids = listTaskIds();
  if (!ids.includes(opts.task)) throw usageError(`没有这道题：${opts.task}`, `可用题号：${ids.join('、')}`);
  const task = loadTask(opts.task);
  const replies = loadReplies(task);
  const repo = path.resolve(opts.repo ?? REPO_ROOT);
  const isolation = opts.isolation ?? task.isolation?.[0] ?? 'isolated';
  if (!(task.isolation ?? ['isolated']).includes(isolation)) ctx.warn(`题目 ${task.id} 的正式口径是 ${task.isolation.join(' / ')}；这次用 ${isolation} 只能当对照组，不计入就绪度均分`);
  const environment = opts.env ?? task.environment;
  const nodeModules = opts['node-modules'] ?? (environment === 'cold' ? 'none' : 'link');
  if (environment === 'cold' && nodeModules !== 'none') ctx.warn('冷启动题通常不预装 node_modules（--node-modules none），否则测不到代理按仓库指引装依赖');
  const root = assertEvalRoot(resolveEvalRoot(opts.root), repo, { isolation });
  assertRequiredEnv(task.requiresEnv);
  const leaks = lemoEnvVars();
  if (leaks.length) ctx.warn(`当前终端的环境变量 ${leaks.join('、')} 指向家目录下的 lemo-*，会被会话继承（等于把仓库外的风格库递给代理）；评测前先 unset 它们`);
  const commit = resolveCommit(repo, opts.commit ?? 'HEAD');
  let sourceDirty = null;
  try {
    const head = git(['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
    if (head === commit) {
      sourceDirty = statusEntries(repo).length > 0;
      if (sourceDirty) ctx.warn('源仓库有未提交的改动：评测检出取的是提交，不包含这些改动');
    }
  } catch { /* 源仓库状态只作提示 */ }
  const attempt = opts.attempt ?? nextAttempt(root, task.id, commit);
  const runId = newRunId(commit, attempt);
  const runDir = path.join(root, task.id, runId);
  if (fs.existsSync(runDir)) throw new EvalError('run-exists', `运行目录已存在：${toPosix(runDir)}`, { exitCode: EXIT.USAGE, hint: '换 --attempt，或稍等一秒再建（运行号带时间到秒）' });
  fs.mkdirSync(path.join(runDir, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'transcript'), { recursive: true });
  let done = false;
  ctx.onCleanup(() => { if (!done) { try { removeTree(runDir, root); } catch { /* 尽力 */ } } });
  try {
    const worktree = path.join(runDir, 'worktree');
    ctx.log(`建检出：${task.id} @ ${commit.slice(0, 12)} → ${toPosix(runDir)}`);
    cloneAt(repo, commit, worktree);
    const { baseCommit, hidden } = hideAnswerKey(worktree);
    const envSteps = prepareEnvironment(worktree, repo, { mode: environment, nodeModules, log: ctx.log });
    const seedSteps = seedWorktree(worktree, task.seed, { log: ctx.log });
    const sessionDir = path.join(runDir, 'session');
    const denyWeb = (task.rules?.forbiddenTools ?? []).some(t => /^Web(Search|Fetch)$/.test(t));
    const session = writeSessionConfig(sessionDir, { denyWeb });
    const prompt = firstMessage(task);
    writeJson(path.join(runDir, 'task.json'), task);
    writeJson(path.join(runDir, 'replies.json'), replies);
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt);
    const tmpDir = path.join(runDir, 'tmp');
    const baseline = captureBaseline({ worktree, tmpDir, commit: baseCommit });
    writeJson(path.join(runDir, 'baseline.json'), baseline);
    const meta = {
      kind: RUN_KIND, schemaVersion: 1, runId, task: task.id, attempt, commit, commitShort: commit.slice(0, 7), baseCommit, hidden,
      isolation, environment, nodeModules, worktree: 'worktree', tmp: 'tmp', session: 'session',
      createdAt: new Date().toISOString(), platform: platformInfo(), source: toPosix(repo), sourceDirty,
      envSteps, seedSteps, denyWeb,
    };
    writeJson(path.join(runDir, 'meta.json'), meta);
    const run = loadRun(runDir);
    const interactiveArgs = isolation === 'isolated'
      ? ['--settings', session.settings, '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', session.mcp, '--permission-mode', 'acceptEdits']
      : ['--settings', session.settings, '--permission-mode', 'acceptEdits'];
    fs.writeFileSync(path.join(sessionDir, 'COMMAND.txt'), commandText(run, interactiveArgs));
    done = true;
    ctx.warn(SAFETY_NOTE);
    const next = [
      `node tools/eval/run.mjs drive ${toPosix(runDir)}`,
      `node tools/eval/run.mjs finish ${toPosix(runDir)}`,
      `node tools/eval/score.mjs run ${toPosix(runDir)} --write`,
    ];
    return {
      data: { runDir: toPosix(runDir), runId, task: task.id, attempt, commit, isolation, environment, worktree: toPosix(worktree), next },
      outputs: [{ path: path.join(runDir, 'meta.json'), sha256: sha256File(path.join(runDir, 'meta.json')), kind: 'eval-run' }],
      text: [
        `已建运行目录：${toPosix(runDir)}`,
        `  题目 ${task.id}《${task.title}》 · 第 ${attempt} 次 · 提交 ${commit.slice(0, 12)} · ${isolation === 'isolated' ? '隔离会话' : '带用户全局环境（对照组）'} · ${environment === 'cold' ? '冷启动' : '已准备环境'}`,
        `  被测检出：${toPosix(worktree)}`,
        `  手工操作的等价命令：${toPosix(path.join(sessionDir, 'COMMAND.txt'))}`,
        '下一步：',
        ...next.map(c => `  ${c}`),
      ].join('\n'),
    };
  } catch (e) {
    try { removeTree(runDir, root); } catch { /* 尽力 */ }
    done = true;
    throw e;
  }
}

// ───────────────────────── drive / reply ─────────────────────────

function driveOptions(opts) {
  const extraArgs = [];
  if (opts['max-budget-usd'] !== undefined) extraArgs.push('--max-budget-usd', String(opts['max-budget-usd']));
  return {
    claude: opts.claude ?? process.env.BEIMING_EVAL_CLAUDE ?? 'claude',
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    maxTurns: opts['max-turns'],
    timeboxMinutes: opts['timebox-min'] ?? undefined,
    permissionMode: opts['permission-mode'],
    maxNewTurns: opts.turns ?? undefined,
    extraArgs,
  };
}

/** SIGINT / SIGTERM：结束会话进程树，把 drive.json 标成 interrupted、去掉锁，之后可以用 drive 接着跑。 */
function interruptHandler(run, holder) {
  return () => {
    if (holder.child?.pid) {
      try { process.platform === 'win32' ? process.kill(holder.child.pid) : process.kill(-holder.child.pid, 'SIGTERM'); } catch { /* 已退出 */ }
    }
    killAll();
    const file = path.join(run.dir, 'drive.json');
    const state = readJsonIfExists(file);
    if (state) { try { writeJson(file, { ...state, stopReason: 'interrupted', interruptedAt: new Date().toISOString() }); } catch { /* 尽力 */ } }
    fs.rmSync(path.join(run.dir, 'drive.lock'), { force: true });
  };
}

function driveText(run, state) {
  const reasons = {
    finished: '代理不再请求审阅，视为完成', stalled: '代理还在提问，但兜底回复次数已用完', timeout: '时间盒到点，已终止会话',
    'max-turns': '达到轮数上限', paused: '按 --turns 暂停（再跑 drive 接着来）', 'agent-error': '会话以错误结束', 'agent-crashed': '会话进程异常退出', 'spawn-error': '无法启动 claude',
  };
  return [
    `驱动结束：${reasons[state.stopReason] ?? state.stopReason}${state.error ? `（${state.error}）` : ''}`,
    `  ${state.turns.length} 轮 · 代理墙钟 ${Math.round(state.agentSeconds / 60 * 10) / 10} 分钟 · 已发脚本回复 ${state.sentIds.length} 条${state.unsentReplies?.length ? ` · 没用上的回复：${state.unsentReplies.join('、')}` : ''} · 兜底 ${state.fallbacksUsed} 次`,
    `下一步：node tools/eval/run.mjs finish ${toPosix(run.dir)}`,
  ].join('\n');
}

const FAILED_STOPS = new Set(['agent-error', 'agent-crashed', 'spawn-error']);

async function cmdDrive({ opts, positionals }, ctx) {
  const run = loadRun(positionals[0]);
  if (!run.baseline) throw new EvalError('run-not-prepared', '运行目录没有 baseline.json，prepare 没有完成', { exitCode: EXIT.USAGE, hint: '删掉这个目录，重新 prepare' });
  const holder = { child: null };
  ctx.onCleanup(interruptHandler(run, holder));
  const o = driveOptions(opts);
  const { state, alreadyFinished } = await driveRun(run, { ...o, log: ctx.log, onChild: c => { holder.child = c; } });
  if (alreadyFinished) {
    return { data: { state }, text: `这个运行已经驱动完（${state.stopReason}）；要人工再续一轮用 run.mjs reply --send，要重来就重新 prepare\n下一步：node tools/eval/run.mjs finish ${toPosix(run.dir)}` };
  }
  const failed = FAILED_STOPS.has(state.stopReason);
  return {
    exitCode: failed ? EXIT.RUN : EXIT.OK,
    data: { state },
    outputs: [{ path: path.join(run.dir, 'drive.json'), sha256: sha256File(path.join(run.dir, 'drive.json')), kind: 'drive-record' }],
    text: driveText(run, state),
    error: failed ? { code: state.stopReason, message: state.error ?? state.stopReason, hint: `看 ${toPosix(path.join(run.dir, 'transcript'))} 里最后一轮的 .stderr.log；未登录时先设置 CLAUDE_CODE_OAUTH_TOKEN 或 ANTHROPIC_API_KEY` } : null,
  };
}

async function cmdReply({ opts, positionals }, ctx) {
  const run = loadRun(positionals[0]);
  const modes = [opts.prompt, Boolean(opts['reply-id']), opts.text !== undefined && !opts['reply-id']].filter(Boolean).length;
  if (modes !== 1) throw usageError('--prompt、--reply-id、--text 三选一', '交互式评测：开场记 --prompt，闸门处记 --reply-id <回复 id>，脚本外的话记 --text');
  let msg;
  if (opts.prompt) {
    if (run.injections.some(i => i.kind === 'prompt')) throw usageError('任务书已经记过了', '闸门处用 --reply-id 记脚本回复');
    msg = { kind: 'prompt', text: run.prompt, approves: run.replies?.prompt?.approves ?? [], waives: run.replies?.prompt?.waives ?? [] };
  } else if (opts['reply-id']) {
    const r = (run.replies?.replies ?? []).find(x => x.id === opts['reply-id']);
    if (!r) throw usageError(`回复脚本里没有 ${opts['reply-id']}`, `可用：${(run.replies?.replies ?? []).map(x => x.id).join('、') || '（本题没有脚本回复）'}`);
    if (opts.text !== undefined && opts.text !== r.text) throw usageError('--text 与脚本原文不一致：脚本回复必须原样发出', `原文：${r.text}`);
    if (run.injections.some(i => i.replyId === r.id)) ctx.warn(`脚本回复 ${r.id} 已经发过一次`);
    msg = { kind: 'scripted', replyId: r.id, gate: r.gate, text: r.text, approves: r.approves, waives: r.waives };
  } else {
    if (!opts.text.trim()) throw usageError('--text 不能为空');
    msg = { kind: 'manual', text: opts.text, approves: opts.approves, waives: opts.waives, reason: opts.note ?? null };
    if (opts.approves.length || opts.waives.length) ctx.warn('人工消息带了审批含义：只有评测方真的这样回复了用户才能这样记');
  }
  if (opts.send) {
    if (msg.kind === 'prompt') throw usageError('任务书用 drive 发出，不用 reply --send');
    const holder = { child: null };
    ctx.onCleanup(interruptHandler(run, holder));
    const { state } = await driveRun(run, { ...driveOptions(opts), maxNewTurns: 1, next: msg, log: ctx.log, onChild: c => { holder.child = c; } });
    return { data: { sent: msg, state }, text: `已发出并跑完一轮（${state.stopReason}）。接着自动驱动：node tools/eval/run.mjs drive ${toPosix(run.dir)}` };
  }
  const file = path.join(run.dir, 'injections.jsonl');
  const { records } = readJsonl(file);
  const turn = msg.kind === 'prompt' ? 1 : (run.drive?.turns?.length ?? records.length) + 1;
  const record = { seq: records.length, turn, at: new Date().toISOString(), ...msg, quoteScope: msg.text, skipped: [], source: 'reply' };
  appendJsonl(file, record);
  return {
    data: { recorded: record },
    text: [`已记下第 ${turn} 轮发给代理的消息（${{ prompt: '任务书', scripted: `脚本回复 ${msg.replyId}`, manual: '人工消息' }[msg.kind]}）。请把下面这段原样发给代理：`, '', msg.text].join('\n'),
  };
}

// ───────────────────────── finish ─────────────────────────

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/** 把会话 JSONL 复制到 transcript/session/：隔离会话取它自己的配置目录；对照组只取本次会话 id 的文件。 */
function collectSessionFiles(run, sessionId) {
  const dest = path.join(run.dir, 'transcript', 'session');
  const copied = [];
  const isolated = (run.meta.isolation ?? 'isolated') === 'isolated';
  if (isolated) {
    const src = path.join(run.sessionDir, 'config', 'projects');
    for (const e of walk(src, { skipDirs: new Set() })) {
      if (!e.rel.endsWith('.jsonl')) continue;
      copyFile(e.abs, path.join(dest, e.rel));
      copied.push(e.rel);
    }
    return { copied, note: copied.length ? null : '隔离配置目录里没有会话 JSONL（会话没跑过，或 CLI 没有持久化会话）' };
  }
  if (!sessionId) return { copied, note: '对照组没有会话 id（交互式会话请用 --session-id 指定），没有复制会话 JSONL' };
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude'), 'projects');
  for (const proj of listEntries(projects)) {
    const file = path.join(projects, proj, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) { copyFile(file, path.join(dest, proj, `${sessionId}.jsonl`)); copied.push(`${proj}/${sessionId}.jsonl`); }
    const sub = path.join(projects, proj, sessionId);
    for (const e of walk(sub, { skipDirs: new Set() })) {
      if (!e.rel.endsWith('.jsonl')) continue;
      copyFile(e.abs, path.join(dest, proj, sessionId, e.rel));
      copied.push(`${proj}/${sessionId}/${e.rel}`);
    }
  }
  return { copied, note: copied.length ? null : `在 ${toPosix(projects)} 下没有找到会话 ${sessionId}` };
}

const FILE_HASH_LIMIT = 256 * 1024 * 1024;

function artifactList(run, report) {
  const film = filmDirOf(run);
  const files = film.dir && fs.existsSync(film.dir)
    ? walk(film.dir, { skipDirs: new Set(['node_modules', 'out', '.git', '__pycache__']) }).slice(0, 2000).map(e => ({ path: `films/${film.id}/${e.rel}`, size: e.size, sha256: e.size <= FILE_HASH_LIMIT ? sha256File(e.abs) : null }))
    : [];
  const latest = latestFilmRun(film.dir);
  const deliverables = latest
    ? walk(latest, { skipDirs: new Set(['frames', 'cache']) }).filter(e => e.size <= FILE_HASH_LIMIT).slice(0, 200).map(e => ({ path: rel(run.worktree, e.abs), size: e.size, sha256: sha256File(e.abs) }))
    : [];
  return {
    schemaVersion: 1,
    kind: 'beiming-eval-artifacts',
    generatedAt: new Date().toISOString(),
    filmId: film.id,
    filmSource: files,
    latestRun: latest ? rel(run.worktree, latest) : null,
    deliverables,
    renderRuns: filmRenderRuns(film.dir).map(d => rel(run.worktree, d)),
    wallClockSeconds: report.observations?.usage?.wallClockSeconds ?? null,
    firstStill: report.observations?.firstStill ?? null,
  };
}

async function cmdFinish({ opts, positionals }, ctx) {
  ctx.onCleanup(killAll);
  const run = loadRun(positionals[0]);
  if (!run.worktree || !fs.existsSync(run.worktree)) throw new EvalError('worktree-missing', '被测检出已经被清掉了，无法判定', { exitCode: EXIT.USAGE, hint: 'finish 要在 clean 之前跑' });
  if (fs.existsSync(path.join(run.dir, 'drive.lock'))) throw new EvalError('run-busy', 'drive 还在驱动这个运行目录', { exitCode: EXIT.BUSY, hint: '等 drive 结束（或中断它）再 finish' });
  if (run.drive && RESUMABLE.has(run.drive.stopReason)) ctx.warn(`驱动处于 ${run.drive.stopReason} 状态，还没跑完；现在 finish 按当前状态判定`);
  const outputs = [];
  const sessionId = opts['session-id'] ?? run.drive?.sessionId ?? null;
  const sess = collectSessionFiles(run, sessionId);
  if (sess.note) ctx.warn(sess.note);
  const { evaluateRun } = await import('./gates.mjs');
  const toolsRoot = path.resolve(opts['tools-root'] ?? REPO_ROOT);
  ctx.log('判定硬门 H1–H7、安全项与会话隔离…');
  const report = await evaluateRun(run.dir, { toolsRoot, strictProcs: opts['strict-procs'], qaTimeoutMs: opts['qa-timeout-min'] * 60 * 1000 });
  const gatesFile = path.join(run.dir, 'gates.json');
  writeJson(gatesFile, report);
  outputs.push({ path: gatesFile, sha256: sha256File(gatesFile), kind: 'gates-report' });
  const artifacts = artifactList(run, report);
  const artFile = path.join(run.dir, 'artifacts.json');
  writeJson(artFile, artifacts);
  outputs.push({ path: artFile, sha256: sha256File(artFile), kind: 'artifacts' });
  let materials = null;
  if (!opts['no-materials'] && run.task.kind !== 'safety') {
    ctx.log('取评审素材与参考指标…');
    try {
      ({ materials } = await buildMaterials(run, report, { toolsRoot, log: ctx.log }));
      if (materials?.video) {
        const src = path.resolve(run.dir, materials.video);
        if (fs.statSync(src).size <= 1024 * 1024 * 1024) {
          const copy = path.join(run.dir, 'review', `film${path.extname(src)}`);
          copyFile(src, copy);
          materials.videoCopy = rel(run.dir, copy);
        }
      }
    } catch (e) { ctx.warn(`评审素材没生成：${e.message}`); }
  }
  const sheetFile = path.join(run.dir, 'review-sheet.json');
  const existing = readJsonIfExists(sheetFile);
  const sheet = buildSheet(report, run, { existing, materials });
  writeJson(sheetFile, sheet);
  outputs.push({ path: sheetFile, sha256: sha256File(sheetFile), kind: 'review-sheet' });
  const score = scoreRun(report, sheet, run);
  const verdictText = { pass: '通过', fail: '不通过', incomplete: '判定不完整', invalid: '无效（会话隔离失效）', 'needs-review': '待复核' }[report.verdict];
  const film = run.task.kind === 'film';
  const lines = [
    `收尾完成：硬门 ${verdictText}${report.hardGates.failed.length ? `（${report.hardGates.failed.join('、')}）` : ''}${report.hardGates.unavailable.length ? `；无法判定：${report.hardGates.unavailable.join('、')}` : ''}${report.safety ? `；安全项 ${report.safety.status}` : ''}`,
    `  会话记录：${report.judge.transcriptSource}${sess.copied.length ? `（另存会话 JSONL ${sess.copied.length} 个）` : ''} · 隔离 ${report.isolation.status}`,
    `  评审表：${toPosix(sheetFile)}${existing ? '（保留了已填的评审内容）' : ''}`,
    film
      ? `  当前分数：${score.total ?? '—'}/100（${score.status === 'final' ? '定稿' : score.status === 'provisional' ? '暂定' : '还缺评审'}）`
      : `  ${run.task.kind === 'safety' ? '安全题' : '演练'}：${score.passed === true ? '通过' : score.passed === false ? '不通过' : '待定'}（不评画面分）`,
    film ? '下一步：两名人类评审填 review-sheet.json 的画面分与待定分项，然后'
      : report.verdict === 'needs-review' ? '下一步：读会话记录，在 review-sheet.json 的 safety.review 里写复核结论，然后' : '下一步：',
    `  node tools/eval/score.mjs run ${toPosix(run.dir)} --write`,
  ];
  const exitCode = opts.strict ? (report.verdict === 'pass' ? EXIT.OK : report.verdict === 'fail' || report.verdict === 'needs-review' ? EXIT.CONTRACT : EXIT.ENV) : EXIT.OK;
  return { exitCode, data: { verdict: report.verdict, hardGates: report.hardGates, safety: report.safety?.status ?? null, isolation: report.isolation.status, score: { total: score.total, status: score.status, passed: score.passed } }, outputs, text: lines.join('\n'), error: exitCode ? { code: 'not-passed', message: `硬门结论 ${report.verdict}`, hint: '看 gates.json 的 findings' } : null };
}

// ───────────────────────── status / clean ─────────────────────────

async function cmdStatus({ positionals }) {
  const run = loadRun(positionals[0]);
  const gates = readJsonIfExists(path.join(run.dir, 'gates.json'));
  const sheet = readJsonIfExists(path.join(run.dir, 'review-sheet.json'));
  const score = readJsonIfExists(path.join(run.dir, 'score.json'));
  const d = run.drive;
  const stage = !run.baseline ? 'prepare 未完成'
    : score ? '已计分'
      : gates ? '已收尾，待评审计分'
        : d && (RESUMABLE.has(d.stopReason) || !d.stopReason) ? '驱动中断或暂停'
          : !d && !run.injections.length ? '已准备，未驱动' : '已驱动，未收尾';
  const next = stage === '已准备，未驱动' ? `node tools/eval/run.mjs drive ${toPosix(run.dir)}`
    : stage === '驱动中断或暂停' ? `node tools/eval/run.mjs drive ${toPosix(run.dir)}`
      : stage === '已驱动，未收尾' ? `node tools/eval/run.mjs finish ${toPosix(run.dir)}`
        : stage === '已收尾，待评审计分' ? `填 review-sheet.json 后 node tools/eval/score.mjs run ${toPosix(run.dir)} --write` : null;
  const data = {
    runDir: toPosix(run.dir), task: run.task.id, runId: run.meta.runId, attempt: run.meta.attempt, commit: run.meta.commit, isolation: run.meta.isolation, environment: run.meta.environment,
    stage, worktreePresent: Boolean(run.worktree && fs.existsSync(run.worktree)),
    drive: d ? { turns: d.turns.length, stopReason: d.stopReason, agentSeconds: d.agentSeconds, sent: d.sentIds, unsent: d.unsentReplies ?? null } : null,
    injections: run.injections.length,
    verdict: gates?.verdict ?? null,
    sheetFilled: sheet ? (sheet.visual?.reviewers ?? []).filter(r => r.kind === 'human' && Object.values(r.scores ?? {}).every(Number.isFinite)).length : null,
    score: score ? { total: score.total, passed: score.passed, status: score.status } : null,
    next,
  };
  const text = [
    `${data.task} · ${data.runId} · ${stage}`,
    d ? `  驱动：${d.turns.length} 轮，${d.stopReason ?? '进行中'}，代理墙钟 ${Math.round((d.agentSeconds ?? 0) / 6) / 10} 分钟` : null,
    gates ? `  硬门：${gates.verdict}` : null,
    sheet && data.sheetFilled !== null ? `  评审表：${data.sheetFilled} 名人类评审打完画面分` : null,
    score ? `  分数：${score.total ?? '—'}/100，${score.passed === true ? '通过' : score.passed === false ? '不通过' : '未定'}（${score.status}）` : null,
    next ? `下一步：${next}` : null,
  ].filter(Boolean).join('\n');
  return { data, text };
}

/** node_modules 可能是软链或 Windows 联接点：先单独去掉链接本身，再删目录树，避免删到源仓库的依赖。 */
function unlinkNodeModules(wt) {
  const nm = path.join(wt, 'node_modules');
  try { if (fs.lstatSync(nm).isSymbolicLink()) fs.unlinkSync(nm); } catch { /* 不存在或不是链接 */ }
  if (process.platform === 'win32') { try { fs.rmdirSync(nm); } catch { /* 不是联接点，或是真目录 */ } }
}

async function cmdClean({ opts, positionals }, ctx) {
  const run = loadRun(positionals[0]);
  const evalRoot = path.dirname(path.dirname(run.dir));
  if (fs.existsSync(path.join(run.dir, 'drive.lock'))) throw new EvalError('run-busy', 'drive 还在驱动这个运行目录', { exitCode: EXIT.BUSY, hint: '等它结束再清理' });
  if (opts.all) {
    if (run.worktree && fs.existsSync(run.worktree)) unlinkNodeModules(run.worktree);
    removeTree(run.dir, evalRoot);
    return { data: { removed: [toPosix(run.dir)] }, text: `已删除整个运行目录：${toPosix(run.dir)}（会话记录与报告也一并删除）` };
  }
  if (!fs.existsSync(path.join(run.dir, 'gates.json')) && !opts.force) {
    throw new EvalError('not-finished', '还没有 gates.json：现在删掉被测检出，判定证据就没了', { exitCode: EXIT.CONTRACT, hint: `先 node tools/eval/run.mjs finish ${toPosix(run.dir)}；确实不要了再加 --force` });
  }
  const removed = [];
  const wt = run.worktree;
  if (wt && fs.existsSync(wt)) {
    unlinkNodeModules(wt);
    removeTree(wt, run.dir);
    removed.push(rel(run.dir, wt));
  }
  for (const d of ['tmp', 'cache']) {
    const p = path.join(run.dir, d);
    if (fs.existsSync(p)) { removeTree(p, run.dir); removed.push(d); }
  }
  ctx.log(removed.length ? `已删除：${removed.join('、')}` : '没有可删的内容');
  return { data: { removed }, text: removed.length ? `已清理 ${toPosix(run.dir)}：${removed.join('、')}（会话记录、快照、评审素材与报告保留）` : '没有可删的内容' };
}

// ───────────────────────── 命令表 ─────────────────────────

const DRIVE_OPTIONS = {
  claude: { type: 'string', desc: 'claude 可执行文件（或 cli.js / 测试桩 .mjs）；默认 $BEIMING_EVAL_CLAUDE 或 claude' },
  model: { type: 'string', desc: '模型；默认沿用 CLI 的默认模型（计划书：沿用用户会话的模型）' },
  effort: { type: 'string', choices: ['low', 'medium', 'high', 'xhigh', 'max'], desc: '推理档位' },
  'max-turns': { type: 'number', min: 1, default: 12, desc: '最多发几轮消息（含任务书）' },
  'timebox-min': { type: 'number', min: 1, desc: '时间盒（分钟，只计代理在跑的时间）；默认取题目配置' },
  'permission-mode': { type: 'string', choices: ['acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'], default: 'acceptEdits', desc: '会话权限模式' },
  'max-budget-usd': { type: 'number', min: 0, desc: '每轮的费用上限（传给 claude --max-budget-usd）' },
  turns: { type: 'number', min: 1, desc: '这次最多续几轮就暂停（逐轮观察时用）' },
};

const subcommands = {
  bank: { spec: { summary: '校验题库并列出全部题目', usage: 'node tools/eval/run.mjs bank [--json]', positionals: { min: 0, max: 0 }, options: {} }, handler: cmdBank },
  prepare: {
    spec: {
      summary: '为一道题建运行目录：仓库外的干净检出、环境、隔离会话配置、基线',
      usage: 'node tools/eval/run.mjs prepare --task <题号> [--commit <提交>] [--root <评测根>] [--isolation isolated|user-env] [--env cold|prepared] [--json]',
      positionals: { min: 0, max: 0 },
      options: {
        task: { type: 'string', desc: '题号（DF-A、DF-B、DF-C、DF-M、S1、S2、S3、DR-W）' },
        commit: { type: 'string', desc: '被测提交（默认源仓库的 HEAD）' },
        repo: { type: 'string', desc: '源仓库（默认本脚本所在的检出）' },
        root: { type: 'string', desc: '评测根；默认 $BEIMING_EVAL_ROOT，再默认 ~/.cache/beiming/evals（必须在仓库外）' },
        isolation: { type: 'string', choices: ['isolated', 'user-env'], desc: '会话隔离方式；默认取题目配置的第一种' },
        env: { type: 'string', choices: ['cold', 'prepared'], desc: '环境：冷启动或已准备；默认取题目配置' },
        'node-modules': { type: 'string', choices: ['link', 'install', 'none'], desc: '已准备环境怎么放 node_modules（默认 link 软链源仓库的；冷启动默认 none）' },
        attempt: { type: 'number', min: 1, desc: '第几次尝试（默认接着已有的编号往下数）' },
      },
      notes: ['评测根的上级目录不能有 CLAUDE.md / AGENTS.md（隔离会话会沿父目录加载它们）；评测根不能在仓库里，也不能在 .claude/worktrees/ 下。'],
    },
    handler: async (parsed, ctx) => { if (!parsed.opts.task) throw usageError('缺少 --task', '例如 --task DF-A；node tools/eval/run.mjs bank 列出全部题号'); return cmdPrepare(parsed, ctx); },
  },
  drive: {
    spec: { summary: '无头驱动会话：发任务书，闸门处按脚本回复并 --resume 继续', usage: 'node tools/eval/run.mjs drive <运行目录> [--claude <可执行文件>] [--model <模型>] [--json]', positionals: { min: 1, max: 1, names: ['<运行目录>'] }, options: DRIVE_OPTIONS, notes: ['凭据只经环境变量给出（隔离会话读不到本机登录状态）：ANTHROPIC_API_KEY 或 CLAUDE_CODE_OAUTH_TOKEN（claude setup-token 生成）。'] },
    handler: cmdDrive,
  },
  reply: {
    spec: {
      summary: '记一条发给代理的消息（交互式评测或人工干预）；--send 时立刻发出并跑一轮',
      usage: 'node tools/eval/run.mjs reply <运行目录> (--prompt | --reply-id <回复> | --text <原话> [--approves look] [--waives animatic]) [--send] [--json]',
      positionals: { min: 1, max: 1, names: ['<运行目录>'] },
      options: {
        prompt: { type: 'boolean', desc: '记任务书（交互式评测开场时）' },
        'reply-id': { type: 'string', desc: '脚本回复的 id（见 evals/agent/replies/<题号>.json）' },
        text: { type: 'string', desc: '人工消息原文（计一次人工干预）' },
        approves: { type: 'list', desc: '这条人工消息批准了哪些闸门' },
        waives: { type: 'list', desc: '这条人工消息豁免了哪些闸门' },
        note: { type: 'string', desc: '为什么要人工插话' },
        send: { type: 'boolean', desc: '立刻用 claude --resume 发出并跑完这一轮' },
        ...DRIVE_OPTIONS,
      },
    },
    handler: cmdReply,
  },
  finish: {
    spec: {
      summary: '收尾：复制会话记录、判定硬门、登记产物、取评审素材、生成评审表',
      usage: 'node tools/eval/run.mjs finish <运行目录> [--tools-root <检出>] [--session-id <会话>] [--no-materials] [--strict] [--json]',
      positionals: { min: 1, max: 1, names: ['<运行目录>'] },
      options: {
        'tools-root': { type: 'string', desc: '取判定工具（tools/qa、engine/production/film.js）的检出；默认本脚本所在的检出' },
        'session-id': { type: 'string', desc: '对照组交互式会话的会话 id（用于找会话 JSONL）' },
        'no-materials': { type: 'boolean', desc: '不取评审素材（没有 ffmpeg 或只想快速看硬门时）' },
        'strict-procs': { type: 'boolean', desc: 'H7：看不出归属的新渲染进程也判失败' },
        'qa-timeout-min': { type: 'number', min: 1, default: 30, desc: '每个 QA 子命令的超时（分钟）' },
        strict: { type: 'boolean', desc: '把硬门结论当退出码（pass 0；fail / needs-review 4；incomplete / invalid 3）' },
      },
    },
    handler: cmdFinish,
  },
  status: { spec: { summary: '看运行目录走到了哪一步、下一步做什么', usage: 'node tools/eval/run.mjs status <运行目录> [--json]', positionals: { min: 1, max: 1, names: ['<运行目录>'] }, options: {} }, handler: cmdStatus },
  clean: {
    spec: {
      summary: '删除被测检出、tmp/ 与 cache/（保留会话记录与报告）；--all 删除整个运行目录',
      usage: 'node tools/eval/run.mjs clean <运行目录> [--force] [--all] [--json]',
      positionals: { min: 1, max: 1, names: ['<运行目录>'] },
      options: { force: { type: 'boolean', desc: '还没 finish 也删' }, all: { type: 'boolean', desc: '连会话记录与报告一起删掉整个运行目录（不可恢复）' } },
    },
    handler: cmdClean,
  },
};

export { subcommands };

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) runCli({ command: 'tools/eval/run.mjs', subcommands, summary: '北冥 agent 验收 · 评测运行（建干净检出 → 无头驱动 → 收尾判定）' });

export { collectSessionFiles };
