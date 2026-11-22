#!/usr/bin/env node
// 考题跑题器（B8）：一条命令跑完一道题（准备 → 做题 → 判分 → 落盘）。
// 会话隔离与过程观测复用 tools/eval/lib（旧目录白名单）；旧目录不反向引用本目录。
//   node beiming/bench/runner.mjs run --question <题目文件> --root <仓库外目录> (--solver-cmd <命令> | --model <模型>)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalError, contractError, envError, runCli, usageError } from '../../tools/eval/lib/cli.mjs';
import { claudeCommand } from '../../tools/eval/lib/drive.mjs';
import { runTool } from '../../tools/eval/lib/exec.mjs';
import { readJsonIfExists, sha256File, sha256Text, walk, writeJson } from '../../tools/eval/lib/files.mjs';
import { newRunId } from '../../tools/eval/lib/rundir.mjs';
import { assertEvalRoot, platformInfo, resolveEvalRoot, sessionEnv, writeSessionConfig } from '../../tools/eval/lib/sandbox.mjs';
import { loadTranscript } from '../../tools/eval/lib/transcript.mjs';
import { isMain } from '../../tools/lib/cli.mjs';
import { projectPublicQuestion, validateQuestion } from './validate-question.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RESULT_FORMAT = 'bench-result/0.1';
export const SOURCES = ['three', 'blender', 'core'];
const PROMPT = '读当前目录的 question.json，按题面做题。交付物写在当前目录，量到的结果写进 submission.json。';
const num = (v) => (Number.isFinite(v) ? v : null);

// 校验没过只报类别和数量，不回显题目内容（隐藏题也走这里）
function whyInvalid(r) {
  if (r.parseError) return r.parseError;
  return [r.leaks?.length && `泄露 ${r.leaks.length} 处`, r.schemaErrors?.length && `结构 ${r.schemaErrors.length} 处`, ...Object.keys(r.violations ?? {})].filter(Boolean).join('、');
}

// 用命令做题：标准输出存成 transcript/turn-01.jsonl，是 Claude Code 的 stream-json 时从里面数轮次、工具调用和 token
async function solveByCommand(run, { solverCmd, model, claude, timeoutMs }) {
  let cmd, args;
  if (solverCmd) {
    // shortcut: 不经 shell（各平台引号规则不一样），按空白拆词，整个词可以用引号包起来；要管道、重定向时自己写 sh -c "…"
    [cmd, ...args] = [...solverCmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    if (!cmd) throw usageError('--solver-cmd 是空的');
  } else {
    const [bin, pre] = claudeCommand(claude);
    cmd = bin;
    args = [...pre, '-p', PROMPT, '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', 'acceptEdits',
      '--settings', path.join(run.sessionDir, 'settings.json'), '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', path.join(run.sessionDir, 'mcp.json')];
  }
  const r = await runTool(cmd, args, { cwd: run.worktree, env: sessionEnv(run), timeoutMs });
  fs.writeFileSync(path.join(run.dir, 'transcript', 'turn-01.jsonl'), r.stdout);
  fs.writeFileSync(path.join(run.dir, 'transcript', 'turn-01.stderr.log'), r.stderr);
  if (r.error) throw envError('env.solver-missing', `做题命令启动不了（${r.error.code ?? r.error.message}）`, '检查 --solver-cmd；用 --model 时确认 claude 在 PATH 里，或用 --claude 指定可执行文件');
  const t = loadTranscript(run.dir);
  const used = t.results.filter((x) => x.usage);
  return {
    exitCode: r.exitCode, timedOut: r.timedOut, model: t.inits[0]?.model ?? null, toolCalls: t.toolUses.length,
    turns: t.results.reduce((n, x) => n + (x.numTurns ?? 0), 0) || null,
    tokens: used.length ? used.reduce((n, { usage: u }) => n + (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), 0) : null,
  };
}

/**
 * 跑一道题。solver（函数，测试和内嵌用）、solverCmd（shell 命令）、model（无头 claude）三选一；都在做题目录里运行。
 * 做题方只拿得到 question.json（公开投影）；完整题目只在本进程里，判分在本进程做。
 * judge({ question, worktreeDir, runDir }) → { metrics: { 指标名: true | { pass } }, predicates: { 断言原文: true | { pass } } }
 * @returns 结果文件的内容，外加 runDir、resultFile
 */
export async function runExamQuestion({ questionFile, evalRoot, solver, solverCmd, model = null, claude = 'claude', source = null, judge, forceExpectedFail = false } = {}) {
  if (!questionFile) throw usageError('缺少题目文件', '写 --question <题目文件>', 'usage.missing-argument');
  if (source !== null && !SOURCES.includes(source)) throw usageError(`source 只能是 ${SOURCES.join(' / ')}`);
  let raw;
  try { raw = fs.readFileSync(questionFile, 'utf8'); } catch (e) { throw usageError(`读不到题目文件（${e.code ?? e.message}）`, '检查 --question 的路径'); }
  const checked = validateQuestion(raw);
  if (!checked.ok) throw contractError('contract.question-invalid', `题目没过 question/0.1 校验：${whyInvalid(checked)}`, '用 beiming/bench 的 validateQuestion 看逐条问题，改完重跑');
  const question = JSON.parse(raw);
  const { hidden, expectedFail, blockedBy } = question.flags;
  const skip = expectedFail && !forceExpectedFail;
  if (!skip && typeof solver !== 'function' && !solverCmd && !model) throw usageError('没说谁来做题', '写 --solver-cmd <命令> 或 --model <模型>', 'usage.missing-argument');

  const root = assertEvalRoot(resolveEvalRoot(evalRoot), REPO);
  const startedAt = new Date();
  let runId, dir;
  fs.mkdirSync(path.join(root, question.id), { recursive: true });
  for (let attempt = 1; ; attempt++) {   // 同一秒里重跑同一道题：尝试号加一
    runId = newRunId(sha256Text(raw), attempt, startedAt);
    dir = path.join(root, question.id, runId);
    try { fs.mkdirSync(dir); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const run = { dir, worktree: path.join(dir, 'worktree'), sessionDir: path.join(dir, 'session'), tmpDir: path.join(dir, 'tmp'), meta: { isolation: 'isolated' } };
  for (const d of [run.worktree, run.tmpDir, path.join(dir, 'transcript')]) fs.mkdirSync(d);
  writeSessionConfig(run.sessionDir, { denyWeb: true });
  // 运行目录做题方够得着：里面不放原题、原题路径和判分细节，只留原文的哈希
  writeJson(path.join(dir, 'meta.json'), { kind: 'beiming-bench-run', runId, questionId: question.id, questionSha256: `sha256:${sha256Text(raw)}`, hidden, source, model, platform: platformInfo(), startedAt: startedAt.toISOString() });

  let solved = {}, error = null, measured = {}, wallMs = 0;
  if (!skip) {
    writeJson(path.join(run.worktree, 'question.json'), projectPublicQuestion(question));
    const t0 = Date.now();
    try {
      solved = typeof solver === 'function'
        ? (await solver({ worktreeDir: run.worktree, questionFile: path.join(run.worktree, 'question.json'), env: sessionEnv(run) })) ?? {}
        : await solveByCommand(run, { solverCmd, model, claude, timeoutMs: question.budget.wallMs });
    } catch (e) {
      if (e instanceof EvalError) throw e;
      error = String(e?.message ?? e);
    }
    wallMs = Date.now() - t0;
    if (!error && solved.timedOut) error = `超过墙钟预算 ${question.budget.wallMs} ms，已结束`;
    if (!error && solved.exitCode != null && solved.exitCode !== 0) error = `做题命令 exit ${solved.exitCode}`;
    // shortcut: 没给 judge 时读做题方自己写的 submission.json（自报，不防作弊）；指标登记表和宿主侧量测落地后默认换成它们
    measured = (judge ? await judge({ question, worktreeDir: run.worktree, runDir: dir }) : readJsonIfExists(path.join(run.worktree, 'submission.json'))) ?? {};
  }

  const passed = (table, key) => {
    const v = table !== null && typeof table === 'object' && Object.hasOwn(table, key) ? table[key] : null;
    return v === true || v?.pass === true;
  };
  const assertions = skip ? [] : [
    ...(question.basePredicates ?? []).map((text) => ({ kind: 'base', name: text, pass: passed(measured.predicates, text) })),
    ...question.scoring.map((s) => ({ kind: 'scoring', name: s.metric, weight: s.weight, pass: passed(measured.metrics, s.metric) })),
  ];
  const score = Math.round(assertions.reduce((n, a) => n + (a.kind === 'scoring' && a.pass ? a.weight : 0), 0) * 1e9) / 1e9;
  const cost = { tokens: num(solved.tokens), turns: num(solved.turns), toolCalls: num(solved.toolCalls), wallMs, gpuSeconds: skip ? 0 : num(solved.gpuSeconds ?? measured.cost?.gpuSeconds) };
  const overBudget = ['tokens', 'wallMs', 'gpuSeconds'].filter((k) => cost[k] > question.budget[k]);
  const status = skip ? 'expected-fail' : error ? 'error' : assertions.every((a) => a.pass) && !overBudget.length ? 'pass' : 'fail';
  const artifacts = walk(run.worktree).filter((e) => e.rel !== 'question.json').map((e) => ({ path: e.rel, bytes: e.size, sha256: `sha256:${sha256File(e.abs)}` }));
  const endedAt = new Date().toISOString();

  writeJson(path.join(dir, 'observation.json'), {
    runId, questionId: question.id, solver: skip ? 'none' : typeof solver === 'function' ? 'function' : solverCmd ? 'command' : 'claude',
    exitCode: solved.exitCode ?? null, timedOut: Boolean(solved.timedOut), error, cost, overBudget,
    transcript: fs.readdirSync(path.join(dir, 'transcript')).sort(), startedAt: startedAt.toISOString(), endedAt,
  });
  const result = {
    format: RESULT_FORMAT, questionId: question.id, level: question.level, source, model: model ?? solved.model ?? null, runId, status, score,
    visibility: hidden ? 'hidden' : 'public', blockedBy,
    assertions: hidden ? [] : assertions,   // 隐藏题只落总分：逐项的指标名和断言原文是私有段
    cost, overBudget, artifacts, createdAt: endedAt,
  };
  const resultFile = path.join(dir, 'result.json');
  writeJson(resultFile, result);
  return { ...result, runDir: dir, resultFile };
}

const RUN = {
  spec: {
    summary: '跑一道考题：准备隔离目录 → 做题 → 判分 → 写 result.json、meta.json、observation.json',
    usage: 'node beiming/bench/runner.mjs run --question <题目文件> [--root <仓库外目录>] (--solver-cmd <命令> | --model <模型>) [参数]',
    options: {
      question: { type: 'string', placeholder: '文件', desc: 'question/0.1 题目文件（公开题，或仓库外的隐藏题）' },
      root: { type: 'string', placeholder: '目录', desc: '运行根目录，必须在仓库外（默认 BEIMING_EVAL_ROOT 或 ~/.cache/beiming/evals）' },
      'solver-cmd': { type: 'string', placeholder: '命令', desc: '做题命令，在做题目录里运行（不经 shell，按空白拆词，词可加引号）；标准输出存成会话记录' },
      model: { type: 'string', placeholder: '模型', desc: '没给 --solver-cmd 时用无头 claude 做题，这是它的 --model' },
      claude: { type: 'string', placeholder: '可执行文件', default: 'claude', desc: 'claude 可执行文件（或 .mjs 测试桩）' },
      source: { type: 'string', choices: SOURCES, desc: '这次用的出片来源，原样记进结果' },
      'force-expected-fail': { type: 'boolean', desc: '题目标了 expectedFail 也照样实跑（默认直接落 expected-fail）' },
    },
    notes: ['退出码 0 表示跑完并落盘，及格与否看 result.json 的 status（pass / fail / error / expected-fail）；题目没过校验 exit 4。'],
  },
  handler: async ({ opts }) => {
    const r = await runExamQuestion({ questionFile: opts.question, evalRoot: opts.root, solverCmd: opts['solver-cmd'], model: opts.model ?? null, claude: opts.claude, source: opts.source ?? null, forceExpectedFail: opts['force-expected-fail'] });
    return { data: r, outputs: [r.resultFile], text: `${r.questionId}：${r.status}，得分 ${r.score}\n结果：${r.resultFile}` };
  },
};

if (isMain(import.meta.url)) await runCli({ command: 'beiming/bench/runner.mjs', subcommands: { run: RUN }, summary: '北冥考题跑题器' });
