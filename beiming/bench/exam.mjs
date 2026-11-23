#!/usr/bin/env node
// 北冥考题库离线核验与基准考试入口：
// 扫描并校验 beiming/bench/questions/ 下全部公开考题、参考读数夹具与公开投影，
// 并通过 beiming/bench/runner.mjs (runExamQuestion) 跑通离线基准做题与正负对照判分核验。
// 题库缺失、为空、题目不合规或任一题正负对照未通过时均以非 0 退出码失败，绝不假绿。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  B6_NEGATIVE_KINDS,
  B6_QUESTION_IDS,
  buildPositiveBaseline,
  evaluateNegativeControl,
} from './negatives/level-2-b/run-b6.mjs';
import {
  readClosure,
  readFraming,
  readPixelBoxes,
  score as scoreLevel1,
} from './questions/level-1/evaluate-b2.mjs';
import { RESULT_FORMAT, runExamQuestion } from './runner.mjs';
import {
  projectPublicQuestion,
  scanQuestionLeaks,
  validateQuestion,
} from './validate-question.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
export const EXAM_REPORT_FORMAT = 'bench-exam-report/0.1';

const HELP = `北冥考题库离线考试核验入口

用法：node beiming/bench/exam.mjs [--out <目录>] [--json] [--dry-run] [--questions <题库目录>] [--help]

选项：
  --out <目录>        输出结构化考试报告的目录（默认 out/exam）
  --json              标准输出打印 JSON 报告
  --dry-run           仅执行题库、参考夹具与公开投影契约校验，不跑离线基准考试
  --questions <目录>  指定题库根目录（默认 beiming/bench/questions）
  --help, -h          打印本帮助信息

退出码：0 全部通过；1 离线考试或负对照未通过；2 命令行参数错误；4 题库为空或题目/夹具契约校验不通过`;

/** 递归收集目录下全部 .json 题目文件（按相对 POSIX 路径排序） */
export function discoverQuestionFiles(questionsDir) {
  if (typeof questionsDir !== 'string' || !questionsDir || !fs.existsSync(questionsDir)) return [];
  let st;
  try { st = fs.statSync(questionsDir); } catch { return []; }
  if (!st.isDirectory()) return [];
  const found = [];
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(abs);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(abs);
    }
  };
  walkDir(questionsDir);
  return found.sort((a, b) => {
    const ra = path.relative(questionsDir, a).split(path.sep).join('/');
    const rb = path.relative(questionsDir, b).split(path.sep).join('/');
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

function specOf({ deliverable: { size, fps, frames, audio } }) {
  const [num, den] = fps.split('/').map(Number);
  return { width: size[0], height: size[1], fps: num / den, frames, audioChannels: { none: 0, stereo: 2 }[audio] };
}

function builtBase(question) {
  return {
    spec: specOf(question),
    predicates: Object.fromEntries((question.basePredicates ?? []).map((text) => [text, 'pass'])),
  };
}

function paintRgba(width, height, bg, rects = []) {
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1, color] of [[0, 0, width, height, bg], ...rects]) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) rgba.set(color, (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

function synthesize28OrbitReadings(question) {
  const [W, H] = question.deliverable.size;
  const total = question.deliverable.frames;
  const grey = [110, 108, 108];
  const boxAt = (k, height = 560) => {
    const angle = (2 * Math.PI * k) / total;
    const half = Math.round(300 + 50 * Math.cos(angle));
    return [960 - half, (H - height) / 2, 960 + half, (H + height) / 2];
  };
  const frameAt = (k, box = boxAt(k)) => {
    const stripe = 960 + Math.round(200 * Math.sin((2 * Math.PI * k) / total));
    return paintRgba(W, H, grey, [
      [...box, [30, 30, 40]],
      [stripe - 20, box[1] + 40, stripe + 20, box[3] - 40, [200, 180, 160]],
    ]);
  };
  const boxes = Array.from({ length: total }, (_, k) => boxAt(k));
  const samples = [0, 72, 144, 216].map((k) => ({ frame: frameAt(k), box: boxes[k] }));
  return {
    base: builtBase(question),
    'meta.bbox-limits': readFraming(boxes, [W, H]),
    'loop.closure-psnr': readClosure(frameAt(0), frameAt(total - 1), frameAt(1)),
    'pixel.bbox': readPixelBoxes(samples, '#6E6C6C', 16),
  };
}

const LEVEL1_IDS = new Set(['29-1', '28-1', '23-1', '1-1']);
const LEVEL2B_IDS = new Set(B6_QUESTION_IDS);

/**
 * 针对单道公开考题运行离线正对照与负对照判分核验。
 * 返回 { pass, positiveScore, negativeControlsChecked, negativeControlsRejected, predicates, metrics, detail }。
 */
export function evaluateOfflineQuestion({ question, benchDir = HERE }) {
  const beimingRoot = path.resolve(benchDir, '..');
  if (LEVEL1_IDS.has(question.id)) {
    const refRel = question.refs?.[0];
    const refAbs = refRel ? path.resolve(beimingRoot, refRel) : null;
    if (!refAbs || !fs.existsSync(refAbs)) {
      return {
        pass: false,
        positiveScore: 0,
        negativeControlsChecked: 0,
        negativeControlsRejected: 0,
        predicates: {},
        metrics: {},
        detail: `缺少参考夹具 ${refRel ?? '(未声明)'}`,
      };
    }
    const refData = JSON.parse(fs.readFileSync(refAbs, 'utf8'));
    let posVerdict;
    let negChecked = 0;
    let negRejected = 0;

    if (question.id === '28-1') {
      const negVerdict = scoreLevel1(question, refData.readings);
      negChecked++;
      if (negVerdict.pass === false && negVerdict.score === 0) negRejected++;
      posVerdict = scoreLevel1(question, synthesize28OrbitReadings(question));
    } else {
      posVerdict = scoreLevel1(question, { ...refData.readings, base: builtBase(question) });
    }
    const emptyNeg = scoreLevel1(question, {});
    negChecked++;
    if (emptyNeg.pass === false && emptyNeg.score === 0) negRejected++;

    const posOk = posVerdict.pass === true && posVerdict.scoringPass === true && posVerdict.basePass === true && Math.abs(posVerdict.score - 1) < 1e-9;
    const negOk = negChecked > 0 && negRejected === negChecked;
    const allOk = posOk && negOk;

    const predicates = Object.fromEntries(
      (question.basePredicates ?? []).map((text) => {
        const hit = posVerdict.base?.find((b) => b.check === text);
        return [text, { pass: Boolean(allOk && hit?.pass), basis: 'offline-eval-b2' }];
      }),
    );
    const metrics = {};
    for (const s of question.scoring) {
      const matching = posVerdict.items.filter((item) => item.metric === s.metric);
      metrics[s.metric] = {
        pass: Boolean(allOk && matching.length > 0 && matching.every((item) => item.pass)),
        basis: 'offline-eval-b2',
      };
    }
    return {
      pass: allOk,
      positiveScore: posVerdict.score,
      negativeControlsChecked: negChecked,
      negativeControlsRejected: negRejected,
      predicates,
      metrics,
      detail: allOk ? 'ok' : !posOk ? `正对照得分 ${posVerdict.score}（pass=${posVerdict.pass}）` : `负对照未全部拦截（${negRejected}/${negChecked}）`,
    };
  }

  if (LEVEL2B_IDS.has(question.id)) {
    const pos = buildPositiveBaseline(question.id);
    const posOk = pos.verdict.pass === true && Math.abs(pos.verdict.score - 1) < 1e-9;
    let negChecked = 0;
    let negRejected = 0;
    for (const kind of B6_NEGATIVE_KINDS) {
      negChecked++;
      const neg = evaluateNegativeControl(`${question.id}-${kind}`);
      if (neg.verdict.pass === false && neg.verdict.score < 1 && neg.failedAsDeclared === true) {
        negRejected++;
      }
    }
    const negOk = negChecked === B6_NEGATIVE_KINDS.length && negRejected === negChecked;
    const allOk = posOk && negOk;
    const predicates = Object.fromEntries(
      (question.basePredicates ?? []).map((text) => [text, { pass: allOk, basis: 'offline-eval-b4' }]),
    );
    const metrics = {};
    for (const s of question.scoring) {
      const matching = pos.verdict.items.filter((item) => item.metric === s.metric);
      metrics[s.metric] = {
        pass: Boolean(allOk && matching.length > 0 && matching.every((item) => item.pass)),
        basis: 'offline-eval-b4',
      };
    }
    return {
      pass: allOk,
      positiveScore: pos.verdict.score,
      negativeControlsChecked: negChecked,
      negativeControlsRejected: negRejected,
      predicates,
      metrics,
      detail: allOk ? 'ok' : !posOk ? `正对照得分 ${pos.verdict.score}` : `B6 负对照未全部按声明拦截（${negRejected}/${negChecked}）`,
    };
  }

  return {
    pass: false,
    positiveScore: 0,
    negativeControlsChecked: 0,
    negativeControlsRejected: 0,
    predicates: {},
    metrics: {},
    detail: `题号 ${question.id} 尚未接入离线核验器`,
  };
}

function validateRefs(question, benchDir) {
  const beimingRoot = path.resolve(benchDir, '..');
  const errors = [];
  for (const ref of question.refs ?? []) {
    const abs = path.resolve(beimingRoot, ref);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      errors.push(`参考文件不存在：${ref}`);
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(abs, 'utf8');
      JSON.parse(raw);
    } catch (e) {
      errors.push(`参考文件不是合法 JSON（${ref}）：${e.message}`);
      continue;
    }
    const leaks = scanQuestionLeaks(raw);
    if (leaks.length > 0) errors.push(`参考文件存在泄露项（${ref}）：${leaks.length} 处`);
  }
  return errors;
}

/**
 * 运行考题库校验与离线考试核验。
 * @param {object} [options]
 * @param {string} [options.questionsDir] 题库目录（默认 beiming/bench/questions）
 * @param {string} [options.benchDir] bench 根目录（默认 beiming/bench）
 * @param {string|null} [options.outDir] 报告输出目录（传 null 不落盘）
 * @param {boolean} [options.dryRun] 仅校验题库与夹具结构
 * @param {string} [options.evalRoot] runner 隔离运行根目录（必须在仓库外；默认使用系统临时目录并自动清理）
 * @param {Record<string, Function>} [options.evaluators] 自定义单题离线核验器（供测试注入正反例）
 */
export async function runExam(options = {}) {
  const benchDir = path.resolve(options.benchDir ?? HERE);
  const questionsDir = path.resolve(options.questionsDir ?? path.join(benchDir, 'questions'));
  const outDir = options.outDir === null ? null : path.resolve(options.outDir ?? path.join(REPO, 'out/exam'));
  const dryRun = Boolean(options.dryRun);
  const evaluators = options.evaluators ?? null;
  const startedAt = Date.now();

  const files = discoverQuestionFiles(questionsDir);
  const writeOut = (report) => {
    if (!outDir) return [];
    fs.mkdirSync(outDir, { recursive: true });
    const reportFile = path.join(outDir, 'report.json');
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return [reportFile];
  };

  if (files.length === 0) {
    const baseReport = {
      format: EXAM_REPORT_FORMAT,
      ok: false,
      exitCode: 4,
      command: 'beiming/bench/exam.mjs',
      dryRun,
      questionsDir,
      wallMs: Date.now() - startedAt,
      summary: {
        totalQuestions: 0,
        validQuestions: 0,
        invalidQuestions: 0,
        passedQuestions: 0,
        failedQuestions: 0,
        negativeControlsChecked: 0,
        negativeControlsRejected: 0,
      },
      questions: [],
      outputs: [],
      error: {
        code: 'contract.empty-question-set',
        message: `题库目录为空或不存在：${questionsDir}`,
        hint: '确认 beiming/bench/questions/ 下存在公开考题 JSON 文件',
      },
      createdAt: new Date().toISOString(),
    };
    baseReport.outputs = writeOut(baseReport);
    return baseReport;
  }

  const seenIds = new Map();
  const entries = [];
  for (const file of files) {
    const relFile = path.relative(questionsDir, file).split(path.sep).join('/');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      entries.push({ file: relFile, absFile: file, id: null, level: null, valid: false, errors: [`无法读取文件：${e.message}`] });
      continue;
    }
    const rawVerdict = validateQuestion(raw);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* validateQuestion 已捕获 parseError */ }
    const objVerdict = parsed ? validateQuestion(parsed) : rawVerdict;
    const errors = [];
    if (!rawVerdict.ok || !objVerdict.ok) {
      if (rawVerdict.parseError) errors.push(rawVerdict.parseError);
      if (rawVerdict.leaks?.length) errors.push(`泄露 ${rawVerdict.leaks.length} 处`);
      if (rawVerdict.schemaErrors?.length) errors.push(`结构错误 ${rawVerdict.schemaErrors.length} 处`);
      for (const [rule, list] of Object.entries(rawVerdict.violations ?? {})) {
        errors.push(`${rule}: ${list.join('；')}`);
      }
    }
    if (parsed && errors.length === 0) {
      if (seenIds.has(parsed.id)) {
        errors.push(`题号 ${parsed.id} 与 ${seenIds.get(parsed.id)} 重复`);
      } else {
        seenIds.set(parsed.id, relFile);
      }
      try {
        const pub = projectPublicQuestion(parsed);
        if ('ext' in pub) errors.push('公开投影未剥离私有 ext 字段');
      } catch (e) {
        errors.push(`公开投影失败：${e.message}`);
      }
      errors.push(...validateRefs(parsed, benchDir));
    }
    entries.push({
      file: relFile,
      absFile: file,
      id: parsed?.id ?? null,
      level: parsed?.level ?? null,
      question: parsed,
      valid: errors.length === 0,
      errors,
    });
  }

  const ownTempRoot = !dryRun && !options.evalRoot
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-exam-'))
    : null;
  const evalRoot = options.evalRoot ? path.resolve(options.evalRoot) : ownTempRoot;

  const questionReports = [];
  let negativeControlsChecked = 0;
  let negativeControlsRejected = 0;

  try {
    for (const entry of entries) {
      if (!entry.valid) {
        questionReports.push({
          file: entry.file,
          id: entry.id,
          level: entry.level,
          valid: false,
          status: 'invalid',
          pass: false,
          score: 0,
          negativeControlsChecked: 0,
          negativeControlsRejected: 0,
          errors: entry.errors,
        });
        continue;
      }

      if (dryRun) {
        questionReports.push({
          file: entry.file,
          id: entry.id,
          level: entry.level,
          valid: true,
          status: 'validated',
          pass: true,
          score: 1,
          negativeControlsChecked: 0,
          negativeControlsRejected: 0,
          errors: [],
        });
        continue;
      }

      const customEval = evaluators && Object.hasOwn(evaluators, entry.id) ? evaluators[entry.id] : null;
      let evalOutcome = null;
      const runResult = await runExamQuestion({
        questionFile: entry.absFile,
        evalRoot,
        solver: async ({ worktreeDir, questionFile }) => {
          const projected = JSON.parse(fs.readFileSync(questionFile, 'utf8'));
          if (projected.id !== entry.id) throw new Error(`公开投影题号不匹配：${projected.id} !== ${entry.id}`);
          fs.writeFileSync(
            path.join(worktreeDir, 'submission.json'),
            `${JSON.stringify({ questionId: entry.id, mode: 'offline-exam', cost: { gpuSeconds: 0 } }, null, 2)}\n`,
            'utf8',
          );
          return { tokens: 0, turns: 1, toolCalls: 0, gpuSeconds: 0 };
        },
        judge: async ({ question }) => {
          evalOutcome = customEval
            ? await customEval({ question, questionFile: entry.absFile, benchDir })
            : evaluateOfflineQuestion({ question, questionFile: entry.absFile, benchDir });
          return {
            predicates: evalOutcome.predicates ?? {},
            metrics: evalOutcome.metrics ?? {},
            cost: { gpuSeconds: 0 },
          };
        },
      });

      const negChecked = evalOutcome?.negativeControlsChecked ?? 0;
      const negRejected = evalOutcome?.negativeControlsRejected ?? 0;
      negativeControlsChecked += negChecked;
      negativeControlsRejected += negRejected;

      const expectedSkip = Boolean(entry.question.flags?.expectedFail) && runResult.status === 'expected-fail';
      const runnerOk = runResult.format === RESULT_FORMAT && fs.existsSync(runResult.resultFile) && (runResult.pass === true || expectedSkip);
      const evalOk = expectedSkip || (Boolean(evalOutcome?.pass) && negRejected === negChecked);
      const pass = runnerOk && evalOk;
      const errors = [];
      if (!pass) {
        if (runResult.error) errors.push(runResult.error);
        if (evalOutcome?.detail && evalOutcome.detail !== 'ok') errors.push(evalOutcome.detail);
        if (!errors.length) errors.push(`runner 状态 ${runResult.status}，得分 ${runResult.score}`);
      }

      questionReports.push({
        file: entry.file,
        id: entry.id,
        level: entry.level,
        valid: true,
        status: pass ? runResult.status : 'fail',
        pass,
        score: runResult.score,
        runId: runResult.runId,
        negativeControlsChecked: negChecked,
        negativeControlsRejected: negRejected,
        errors,
      });
    }
  } finally {
    if (ownTempRoot) {
      fs.rmSync(ownTempRoot, { recursive: true, force: true });
    }
  }

  const totalQuestions = questionReports.length;
  const validQuestions = questionReports.filter((q) => q.valid).length;
  const invalidQuestions = totalQuestions - validQuestions;
  const passedQuestions = questionReports.filter((q) => q.pass).length;
  const failedQuestions = totalQuestions - passedQuestions;
  const ok = totalQuestions > 0 && invalidQuestions === 0 && failedQuestions === 0;
  const exitCode = ok ? 0 : invalidQuestions > 0 ? 4 : 1;

  const report = {
    format: EXAM_REPORT_FORMAT,
    ok,
    exitCode,
    command: 'beiming/bench/exam.mjs',
    dryRun,
    questionsDir,
    wallMs: Date.now() - startedAt,
    summary: {
      totalQuestions,
      validQuestions,
      invalidQuestions,
      passedQuestions,
      failedQuestions,
      negativeControlsChecked,
      negativeControlsRejected,
    },
    questions: questionReports,
    outputs: [],
    error: ok
      ? null
      : {
          code: invalidQuestions > 0 ? 'contract.question-invalid' : 'exam.verification-failed',
          message: invalidQuestions > 0
            ? `${invalidQuestions} 道考题或参考夹具未通过契约校验`
            : `${failedQuestions} 道考题未通过离线考试核验`,
          hint: '检查 questions[].errors 中的失败原因',
        },
    createdAt: new Date().toISOString(),
  };
  report.outputs = writeOut(report);
  return report;
}

export function parseExamArgs(argv) {
  const opts = { outDir: path.join(REPO, 'out/exam'), json: false, dryRun: false, questionsDir: path.join(HERE, 'questions'), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--out') {
      const val = argv[++i];
      if (!val || val.startsWith('-')) throw Object.assign(new Error('--out 需要指定目录路径'), { exitCode: 2, code: 'usage.missing-out' });
      opts.outDir = path.resolve(val);
    } else if (arg === '--questions') {
      const val = argv[++i];
      if (!val || val.startsWith('-')) throw Object.assign(new Error('--questions 需要指定题库目录路径'), { exitCode: 2, code: 'usage.missing-questions' });
      opts.questionsDir = path.resolve(val);
    } else {
      throw Object.assign(new Error(`未知参数：${arg}`), { exitCode: 2, code: 'usage.unknown-option' });
    }
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseExamArgs(argv);
  } catch (e) {
    const code = e.exitCode ?? 2;
    const errObj = {
      format: EXAM_REPORT_FORMAT,
      ok: false,
      exitCode: code,
      command: 'beiming/bench/exam.mjs',
      error: { code: e.code ?? 'usage.bad-args', message: e.message, hint: '运行 node beiming/bench/exam.mjs --help 查看用法' },
    };
    process.stdout.write(`${JSON.stringify(errObj, null, 2)}\n`);
    process.stderr.write(`${e.message}\n`);
    return code;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const report = await runExam({
    questionsDir: opts.questionsDir,
    outDir: opts.outDir,
    dryRun: opts.dryRun,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.stderr.write(`考试核验未通过（exit ${report.exitCode}）：${report.error?.message ?? '原因不明'}\n`);
  } else {
    process.stderr.write(
      `考试核验通过：共 ${report.summary.totalQuestions} 题（通过 ${report.summary.passedQuestions} 题，拦截负对照 ${report.summary.negativeControlsRejected}/${report.summary.negativeControlsChecked} 份）\n`,
    );
  }
  return report.exitCode;
}

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const code = await main();
  process.exit(code);
}
