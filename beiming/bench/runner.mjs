#!/usr/bin/env node
// 考题跑题器（B8）：一条命令跑完一道题（准备 → 做题 → 判分 → 落盘）。
// 会话隔离与过程观测复用 tools/eval/lib（旧目录白名单）；旧目录不反向引用本目录。
//   node beiming/bench/runner.mjs run --question <题目文件> --root <仓库外目录> (--solver-cmd <命令> | --model <模型>)
// 信任边界：做题进程和宿主是同一个系统用户。macOS 上 sandbox-exec 能用时，用它挡住原题、隐藏题所在目录、meta.json 和别的运行（seatbelt）；
// 别的平台只换了工作目录和环境变量（process-cwd），这个用户读得到的文件做题进程照样读得到。实际级别记在 observation.json 的 isolation。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { EvalError, contractError, envError, runCli, usageError } from '../../tools/eval/lib/cli.mjs';
import { claudeCommand } from '../../tools/eval/lib/drive.mjs';
import { runTool } from '../../tools/eval/lib/exec.mjs';
import { readJsonIfExists, sha256File, sha256Text, walk, writeJson } from '../../tools/eval/lib/files.mjs';
import { newRunId } from '../../tools/eval/lib/rundir.mjs';
import { assertEvalRoot, platformInfo, resolveEvalRoot, sessionEnv, writeSessionConfig } from '../../tools/eval/lib/sandbox.mjs';
import { loadTranscript } from '../../tools/eval/lib/transcript.mjs';
import { cutScene } from '../observe/index.mjs';
import { checkAssertion, evaluateAssertion } from '../verify/predicates.mjs';
import { projectPublicQuestion, validateQuestion } from './validate-question.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RESULT_FORMAT = 'bench-result/0.1';
export const SOURCES = ['three', 'blender', 'core'];
const PROMPT = '读当前目录的 question.json，按题面做题。成片存成当前目录的 deliverable.mp4；用了显卡就把秒数写进 submission.json 的 cost.gpuSeconds。';
const num = (v) => (Number.isFinite(v) ? v : null);
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const ffprobe = () => process.env.FFPROBE || 'ffprobe';
// 异常的原因，保证不是空的：new Error() 的 message 是 ''，throw '' 连名字都没有
const why = (e) => String(e?.message || e || '') || '原因不明';
const noFfprobe = () => envError('env.ffmpeg-missing', '宿主上没有可用的 ffprobe，成片量不了、判不了分', '装 FFmpeg（带 ffprobe），或用环境变量 FFPROBE 指定可执行文件');

// 做题进程的环境变量：只留白名单（名字不分大小写），宿主别的变量一律不传；模型的凭据和代理只在 --model 时传
const ENV_KEEP = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TERM', 'NODE_PATH', 'TMPDIR', 'TMP', 'TEMP', 'CLAUDE_CONFIG_DIR', 'PLAYWRIGHT_BROWSERS_PATH']);
const ENV_MODEL = /^(ANTHROPIC_|CLAUDE_CODE_)|^(HTTPS?|NO)_PROXY$/;
const solverEnv = (run, viaModel) => Object.fromEntries(Object.entries(sessionEnv(run)).filter(([k]) => ENV_KEEP.has(k.toUpperCase()) || (viaModel && ENV_MODEL.test(k.toUpperCase()))));

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
let seatbelt;   // 实际试一次：有这个文件不等于能用（已经在别的沙箱里时可能套不上）
const hasSeatbelt = () => (seatbelt ??= process.platform === 'darwin' && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0);

// seatbelt 规则：别的照常放行，只挡下面三样。读（file-read-data）要点名写才盖得住通配的放行
function seatbeltProfile(run, questionFile, hidden) {
  // shortcut: 路径里有双引号或控制字符时拼不成规则（sandbox-exec 起不来，这道题落 error），真遇到再换转义
  const q = JSON.stringify, rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const real = fs.realpathSync(questionFile), qDir = path.dirname(real), dir = fs.realpathSync(run.dir);
  // 隐藏题常和别的隐藏题、答案放在一个目录：原题在仓库外就整个目录都挡；目录里装着运行目录、家目录或 node 的不挡（挡了做题进程起不来）
  const wholeDir = hidden && !inside(real, REPO) && [dir, fs.realpathSync(os.homedir()), fs.realpathSync(process.execPath)].every((p) => !inside(p, qDir));
  return '(version 1)(allow default)'
    + `(deny file-read* file-read-data (literal ${q(real)})${wholeDir ? ` (subpath ${q(qDir)})` : ''})`
    // 宿主写的三个文件：meta.json 不给读，结果和观测不给改（做题进程留下的后台进程也改不了）
    + `(deny file-read* file-read-data file-write* ${['meta.json', 'result.json', 'observation.json'].map((f) => `(literal ${q(path.join(dir, f))})`).join(' ')})`
    // 别的运行（<运行根>/<题号>/<runId>/ 这一层往下，里面有别人交的成片）；运行根里别的文件照常读得到
    + `(deny file-read-data (require-all (regex #"^${rx(path.resolve(dir, '../..'))}/[^/]+/[^/]+/") (require-not (subpath ${q(dir)}))))`;
}

// 校验没过只报类别和数量，不回显题目内容（隐藏题也走这里）
function whyInvalid(r) {
  if (r.parseError) return r.parseError;
  return [r.leaks?.length && `泄露 ${r.leaks.length} 处`, r.schemaErrors?.length && `结构 ${r.schemaErrors.length} 处`, ...Object.keys(r.violations ?? {})].filter(Boolean).join('、');
}

// 用命令做题：标准输出存成 transcript/turn-01.jsonl，是 Claude Code 的 stream-json 时从里面数轮次、工具调用和 token
async function solveByCommand(run, { argv, model, claude, timeoutMs, profile }) {
  let [cmd, ...args] = argv ?? [];
  if (!argv) {
    const [bin, pre] = claudeCommand(claude);
    cmd = bin;
    args = [...pre, '-p', PROMPT, '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', 'acceptEdits',
      '--settings', path.join(run.sessionDir, 'settings.json'), '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', path.join(run.sessionDir, 'mcp.json')];
  }
  if (profile) [cmd, args] = [SANDBOX_EXEC, ['-p', profile, cmd, ...args]];
  const r = await runTool(cmd, args, { cwd: run.worktree, env: solverEnv(run, !argv), timeoutMs });
  fs.writeFileSync(path.join(run.dir, 'transcript', 'turn-01.jsonl'), r.stdout);
  fs.writeFileSync(path.join(run.dir, 'transcript', 'turn-01.stderr.log'), r.stderr);
  // 套了 sandbox-exec 时命令起不来不报 error：它自己 exit 71，stderr 以 sandbox-exec: execvp() 开头
  if (r.error || (profile && r.exitCode === 71 && r.stderr.startsWith('sandbox-exec: execvp()'))) throw envError('env.solver-missing', `做题命令启动不了（${r.error?.code ?? r.error?.message ?? r.stderr.trim()}）`, '检查 --solver-cmd；用 --model 时确认 claude 在 PATH 里，或用 --claude 指定可执行文件');
  const t = loadTranscript(run.dir);
  const used = t.results.filter((x) => x.usage);
  return {
    exitCode: r.exitCode, timedOut: r.timedOut, model: t.inits[0]?.model ?? null, toolCalls: t.toolUses.length,
    turns: t.results.reduce((n, x) => n + (x.numTurns ?? 0), 0) || null,
    tokens: used.length ? used.reduce((n, { usage: u }) => n + (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), 0) : null,
  };
}

// 交付成片：submission.json 点名的相对路径（video / deliverable / file）优先，其次 deliverable.mp4、out.mp4，再次做题目录里唯一的视频文件。
// 解析掉软链后必须还是做题目录里的普通文件，指到外面的不认
function findDeliverable(worktreeDir, submission) {
  const base = fs.realpathSync(worktreeDir);
  const named = ['video', 'deliverable', 'file'].map((k) => submission?.[k]).find((v) => typeof v === 'string' && v);
  const videos = walk(base).filter((e) => /\.(mp4|mov|mkv|webm)$/i.test(e.rel));
  const rel = named ?? ['deliverable.mp4', 'out.mp4'].find((f) => fs.existsSync(path.join(base, f))) ?? (videos.length === 1 ? videos[0].rel : null);
  if (!rel) return null;
  try {
    const real = fs.realpathSync(path.resolve(base, rel));
    return inside(real, base) && real !== base && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

// ffprobe 实测：解码数帧（不信容器里写的帧数）、平均帧率的分子分母、有没有音轨；读不了回 null
async function probeDeliverable(file) {
  const r = await runTool(ffprobe(), ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,nb_read_frames', '-of', 'json', file], { timeoutMs: 5 * 60 * 1000 });
  if (r.error) throw noFfprobe();
  let streams;
  try { streams = JSON.parse(r.stdout).streams; } catch { return null; }
  const v = r.exitCode === 0 && Array.isArray(streams) ? streams.find((s) => s.codec_type === 'video') : null;
  if (!v) return null;
  const [fpsNum, fpsDen] = String(v.avg_frame_rate).split('/').map(Number);
  return { width: v.width, height: v.height, fpsNum, fpsDen, frames: Number(v.nb_read_frames), audio: streams.some((s) => s.codec_type === 'audio') };
}

/**
 * 宿主侧的默认判分：只认宿主自己量到的。成片用 ffprobe 实测尺寸、帧率（有理数精确比）、帧数、有没有音轨，对题目的 deliverable。
 * delivery(...) 和 delivery.spec / deliver.spec 看这个实测（basis: 'host'）；no_cut 用 observe 的切点检测加 verify 的求值；
 * 别的谓词和指标还没接量测器，一律不过（basis: 'unmeasured'），要判就传自己的 judge。
 * submission.json 是做题方写的，只读成片的相对路径和 cost.gpuSeconds，自报的过没过不看。
 * shortcut: delivery 只核规格和音轨，色彩标签、黑帧、冻结（谓词契约 5.6 第 1 条的其余部分）没核；指标登记表落地后换成它。
 */
export async function defaultJudge({ question, worktreeDir }) {
  const submission = readJsonIfExists(path.join(worktreeDir, 'submission.json'));
  const file = findDeliverable(worktreeDir, submission);
  const got = file && await probeDeliverable(file);
  const want = question.deliverable, [wantNum, wantDen] = want.fps.split('/').map(Number);
  const specOk = Boolean(got) && got.width === want.size[0] && got.height === want.size[1] && got.fpsDen > 0 && got.fpsNum * wantDen === wantNum * got.fpsDen
    && got.frames === want.frames && got.audio === (want.audio !== 'none');
  const film = { output: want, shots: [{ id: 's01', in: 0, out: want.frames }] };
  let cuts;   // 切点整条片量一次；规格不对的片不量，no_cut 跟着不过
  const HOST = {
    delivery: (bound) => specOk && ['width', 'height', 'frames'].every((k) => bound[k] === undefined || bound[k].value === got[k])
      && (bound.fps === undefined || got.fpsNum / got.fpsDen === bound.fps.value),
    no_cut: async (bound, text) => {
      cuts ??= specOk ? await cutScene(file).then((m) => m.value, () => null) : null;
      return evaluateAssertion(text, film, { cuts }).status === 'pass';
    },
  };
  const predicates = {};
  for (const text of question.basePredicates ?? []) {
    const c = checkAssertion(text), name = c.assertion?.name;
    predicates[text] = Object.hasOwn(HOST, name) ? { pass: await HOST[name](c.bound, text), basis: 'host' } : { pass: false, basis: 'unmeasured' };
  }
  const metrics = Object.fromEntries(question.scoring.map((s) => [s.metric, ['delivery.spec', 'deliver.spec'].includes(s.metric) ? { pass: specOk, basis: 'host' } : { pass: false, basis: 'unmeasured' }]));
  return { predicates, metrics, cost: { gpuSeconds: submission?.cost?.gpuSeconds } };
}

/**
 * 跑一道题。solver（函数，测试和内嵌用，和宿主同进程）、solverCmd（命令）、model（无头 claude）三选一；后两种在做题目录里起子进程。
 * 做题目录里只放 question.json（公开投影），完整题目只在本进程里，判分也在本进程做；子进程还读得到什么，看文件头的信任边界。
 * judge({ question, worktreeDir, runDir }) → { metrics: { 指标名: true | { pass } }, predicates: { 断言原文: true | { pass } } }；不传用 defaultJudge
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
  // shortcut: 不经 shell（各平台引号规则不一样），按空白拆词，整个词可以用引号包起来；要管道、重定向时自己写 sh -c "…"
  const argv = solverCmd ? [...solverCmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]) : null;
  const how = skip ? 'none' : typeof solver === 'function' ? 'function' : argv ? 'command' : model ? 'claude' : null;
  if (!how) throw usageError('没说谁来做题', '写 --solver-cmd <命令> 或 --model <模型>', 'usage.missing-argument');
  if (how === 'command' && !argv.length) throw usageError('--solver-cmd 是空的');

  const root = assertEvalRoot(resolveEvalRoot(evalRoot), REPO);
  // 默认判分要 ffprobe：做题之前先查，别等花完预算才发现判不了
  if (!skip && !judge && spawnSync(ffprobe(), ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) throw noFfprobe();
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
  // 运行目录里不放原题、原题路径和判分细节，只留原文的哈希
  writeJson(path.join(dir, 'meta.json'), { kind: 'beiming-bench-run', runId, questionId: question.id, questionSha256: `sha256:${sha256Text(raw)}`, hidden, source, model, platform: platformInfo(), startedAt: startedAt.toISOString() });

  const sandboxed = how === 'command' || how === 'claude';
  const profile = sandboxed && hasSeatbelt() ? seatbeltProfile(run, questionFile, hidden) : null;
  let solved = {}, error = null, measured = {}, wallMs = 0;
  if (!skip) {
    writeJson(path.join(run.worktree, 'question.json'), projectPublicQuestion(question));
    const t0 = Date.now();
    try {
      solved = how === 'function'
        ? (await solver({ worktreeDir: run.worktree, questionFile: path.join(run.worktree, 'question.json'), env: solverEnv(run, false) })) ?? {}
        : await solveByCommand(run, { argv, model, claude, timeoutMs: question.budget.wallMs, profile });
    } catch (e) {
      if (e instanceof EvalError) throw e;
      error = why(e);
    }
    wallMs = Date.now() - t0;
    // 隐藏题的预算是私有段：超时只说超了，不写数
    if (error === null && solved.timedOut) error = hidden ? '超过墙钟预算，已结束' : `超过墙钟预算 ${question.budget.wallMs} ms，已结束`;
    // 子进程没有退出码就是被信号杀掉的，产物写完了也不算做完
    if (error === null && sandboxed && solved.exitCode !== 0) error = solved.exitCode === null ? '做题进程异常终止（无退出码，可能被信号中断）' : `做题命令 exit ${solved.exitCode}`;
    // 没做完就不判分：反正记 0 分，判分器读不到要的文件抛错还会把这条失败记录一起丢掉
    if (error === null) {
      try { measured = (await (judge ?? defaultJudge)({ question, worktreeDir: run.worktree, runDir: dir })) ?? {}; } catch (e) {
        if (e instanceof EvalError) throw e;
        // 判分器的报错可能带着指标名、阈值：隐藏题不写原因
        error = hidden ? '判分出错' : `判分出错：${why(e)}`;
      }
    }
  }

  // basis 是这一项凭什么判的：host 宿主实测、unmeasured 没有量测器（一律不过）、judge 调用方自己的判分
  const judged = (table, key) => {
    const v = table !== null && typeof table === 'object' && Object.hasOwn(table, key) ? table[key] : null;
    return { pass: v === true || v?.pass === true, basis: v?.basis ?? (judge ? 'judge' : 'unmeasured') };
  };
  // 没做完（出错、被杀、超时）或判分出错的运行不采信半截产物：逐项不落，记 0 分。出没出错只看 error 是不是 null，不看文字
  const failed = error !== null;
  const assertions = skip || failed ? [] : [
    ...(question.basePredicates ?? []).map((text) => ({ kind: 'base', name: text, ...judged(measured.predicates, text) })),
    ...question.scoring.map((s) => ({ kind: 'scoring', name: s.metric, weight: s.weight, ...judged(measured.metrics, s.metric) })),
  ];
  const score = Math.round(assertions.reduce((n, a) => n + (a.kind === 'scoring' && a.pass ? a.weight : 0), 0) * 1e9) / 1e9;
  const cost = { tokens: num(solved.tokens), turns: num(solved.turns), toolCalls: num(solved.toolCalls), wallMs, gpuSeconds: skip ? 0 : num(solved.gpuSeconds ?? measured.cost?.gpuSeconds) };
  const overBudget = ['tokens', 'wallMs', 'gpuSeconds'].filter((k) => cost[k] > question.budget[k]);
  const status = skip ? 'expected-fail' : failed ? 'error' : assertions.every((a) => a.pass) && !overBudget.length ? 'pass' : 'fail';
  const artifacts = walk(run.worktree).filter((e) => e.rel !== 'question.json').map((e) => ({ path: e.rel, bytes: e.size, sha256: `sha256:${sha256File(e.abs)}` }));
  const endedAt = new Date().toISOString();

  writeJson(path.join(dir, 'observation.json'), {
    runId, questionId: question.id, solver: how, isolation: !sandboxed ? (skip ? 'none' : 'in-process') : profile ? 'seatbelt' : 'process-cwd',
    exitCode: solved.exitCode ?? null, timedOut: Boolean(solved.timedOut), error, cost, overBudget,
    transcript: fs.readdirSync(path.join(dir, 'transcript')).sort(), startedAt: startedAt.toISOString(), endedAt,
  });
  const result = {
    format: RESULT_FORMAT, questionId: question.id, level: question.level, source, model: model ?? solved.model ?? null, runId, status, score,
    // 没出错是 null；出错时和 observation.json 的 error 是同一句（隐藏题的判分原因、预算数值在上面已经抹掉）
    error,
    // 隐藏题只落总分和计数：blockedBy 的原文、逐项的指标名和断言原文都是私有段
    visibility: hidden ? 'hidden' : 'public', blockedBy: hidden && blockedBy.length ? ['[hidden]'] : blockedBy,
    unmeasured: assertions.filter((a) => a.basis === 'unmeasured').length,
    assertions: hidden ? [] : assertions,
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
      question: { type: 'string', placeholder: '文件', desc: 'question/0.1 题目文件（公开题，或仓库外的隐藏题；隐藏题单独放一个目录，做题命令别放在里面）' },
      root: { type: 'string', placeholder: '目录', desc: '运行根目录，必须在仓库外（默认 BEIMING_EVAL_ROOT 或 ~/.cache/beiming/evals）' },
      'solver-cmd': { type: 'string', placeholder: '命令', desc: '做题命令，在做题目录里运行（不经 shell，按空白拆词，词可加引号）；标准输出存成会话记录' },
      model: { type: 'string', placeholder: '模型', desc: '没给 --solver-cmd 时用无头 claude 做题，这是它的 --model' },
      claude: { type: 'string', placeholder: '可执行文件', default: 'claude', desc: 'claude 可执行文件（或 .mjs 测试桩）' },
      source: { type: 'string', choices: SOURCES, desc: '这次用的出片来源，原样记进结果' },
      'force-expected-fail': { type: 'boolean', desc: '题目标了 expectedFail 也照样实跑（默认直接落 expected-fail）' },
    },
    notes: [
      '退出码 0 表示跑完并落盘，及格与否看 result.json 的 status（pass / fail / error / expected-fail）；题目没过校验 exit 4，宿主缺 ffprobe exit 3。',
      '判分只认宿主用 ffprobe 量到的成片（做题目录里的 deliverable.mp4），做题方在 submission.json 里自报的过没过不看。',
    ],
  },
  handler: async ({ opts }) => {
    const r = await runExamQuestion({ questionFile: opts.question, evalRoot: opts.root, solverCmd: opts['solver-cmd'], model: opts.model ?? null, claude: opts.claude, source: opts.source ?? null, forceExpectedFail: opts['force-expected-fail'] });
    return { data: r, outputs: [r.resultFile], text: `${r.questionId}：${r.status}，得分 ${r.score}\n结果：${r.resultFile}` };
  },
};

// 是不是被直接执行：两边都解析掉软链再比（从软链启动也认）；argv[1] 不是文件（node - 从标准输入读脚本）就不是
const isMain = () => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) await runCli({ command: 'beiming/bench/runner.mjs', subcommands: { run: RUN }, summary: '北冥考题跑题器' });
