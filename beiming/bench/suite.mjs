#!/usr/bin/env node
// 每日小卷（B13）与全卷一（B14）统一组卷调度、预算门控、隔离跑题与看板每日落盘引擎。
//   node beiming/bench/suite.mjs mini --as-of YYYY-MM-DD --eval-root <dir> --board-dir <dir> --models m1,m2
//   node beiming/bench/suite.mjs full-1 --as-of YYYY-MM-DD --eval-root <dir> --board-dir <dir> --models m1,m2 --hidden-dir <dir>
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EvalError, EXIT, contractError, runCli, usageError } from '../../tools/eval/lib/cli.mjs';
import { isInside } from '../../tools/eval/lib/paths.mjs';
import { assertEvalRoot, resolveEvalRoot } from '../../tools/eval/lib/sandbox.mjs';
import { isCalendarDate } from '../cards/status.mjs';
import { isPlainObject, withFileLock } from '../jobs/ledger.mjs';
import { BOARD_FORMAT, appendBoardHistory, buildBoard, renderBoardHtml } from './board.mjs';
import { RESULT_FORMAT, SOURCES, hasBlockedByChanged, runExamQuestion } from './runner.mjs';
import { scanQuestionLeaks, validateQuestion } from './validate-question.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DEFAULT_QUESTIONS_DIR = path.resolve(HERE, 'questions');
const RUN_PRIVATE_DIRS = new Set(['worktree', 'session', 'tmp', 'transcript', '.git', 'node_modules']);
const CARD_SKIP_DIRS = new Set(['.git', 'node_modules', 'priors-data']);
const DEFAULT_SKIP_DIRS = new Set(['.git', 'node_modules']);

export const SUITE_FORMAT = 'bench-suite/0.1';
export const DEFAULT_MINI_MAX_BUDGET_SHARE = 0.4;
export const DEFAULT_T2_UNIT_TOKENS = 250_000;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function hasLocalPath(value) {
  const plain = value.normalize('NFKC').replace(/\p{Cf}/gu, '');
  return /file:\/|~[\\/]|(?<![a-z0-9])[a-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+/i.test(plain)
    || /(?<![\p{L}\p{N}_.])(?<!https?:\/)\/(?:Users|home|tmp|var|private|etc|opt|Volumes|mnt|root|usr|proc|dev|bin|sbin|lib|Library|System|Applications)(?:[\\/]|$)/iu.test(plain);
}

function hasPrivateMarker(s) {
  return scanQuestionLeaks(String(s)).some((l) => l.code !== 'local-path');
}

function shownPath(s) {
  return /^(?:[\\/]|file:|~[\\/]|[a-z]:[\\/])/i.test(s) || hasLocalPath(s) || hasPrivateMarker(s) ? '<路径已隐去>' : s;
}

function withErrorMeta(err, code, exitCode) {
  Object.defineProperty(err, 'code', { value: code, enumerable: true, writable: true, configurable: true });
  if (exitCode !== undefined) {
    Object.defineProperty(err, 'exitCode', { value: exitCode, enumerable: true, writable: true, configurable: true });
  }
  return err;
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = freezeDeep(v);
  return Object.freeze(out);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.trim().length === 0 || value.includes('\0')) {
    throw withErrorMeta(new TypeError(`${name} 必须是非空字符串`), 'usage.bad-argument', EXIT.USAGE);
  }
  return value;
}

function assertSafeInt(value, name, min = 0) {
  if (typeof value !== 'number') {
    throw withErrorMeta(new TypeError(`${name} 必须是数字`), 'usage.bad-argument', EXIT.USAGE);
  }
  if (!Number.isSafeInteger(value) || value < min) {
    throw withErrorMeta(new RangeError(`${name} 必须是不小于 ${min} 的安全整数`), 'usage.bad-argument', EXIT.USAGE);
  }
  return value;
}

function assertPositiveFinite(value, name) {
  if (typeof value !== 'number') {
    throw withErrorMeta(new TypeError(`${name} 必须是数字`), 'usage.bad-argument', EXIT.USAGE);
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw withErrorMeta(new RangeError(`${name} 必须是大于 0 的有限数`), 'usage.bad-argument', EXIT.USAGE);
  }
  return value;
}

function assertModels(models, { exact = null } = {}) {
  if (!Array.isArray(models)) {
    throw withErrorMeta(new TypeError('models 必须是字符串数组'), 'usage.bad-argument', EXIT.USAGE);
  }
  const normalized = [];
  for (let i = 0; i < models.length; i += 1) {
    const m = assertNonEmptyString(models[i], `models[${i}]`).trim();
    normalized.push(m);
  }
  if (exact !== null) {
    if (normalized.length !== exact) {
      throw withErrorMeta(new RangeError(`models 必须恰含 ${exact} 个模型家族`), 'usage.bad-argument', EXIT.USAGE);
    }
  } else if (normalized.length < 1 || normalized.length > 2) {
    throw withErrorMeta(new RangeError('models 必须包含 1 到 2 个模型家族'), 'usage.bad-argument', EXIT.USAGE);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw withErrorMeta(new RangeError('models 不能包含重复的模型家族'), 'usage.bad-argument', EXIT.USAGE);
  }
  return normalized;
}

function assertSource(source) {
  if (typeof source !== 'string') {
    throw withErrorMeta(new TypeError('source 必须是字符串'), 'usage.bad-argument', EXIT.USAGE);
  }
  if (!SOURCES.includes(source)) {
    throw withErrorMeta(new RangeError(`source 只能是 ${SOURCES.join(' / ')}`), 'usage.bad-argument', EXIT.USAGE);
  }
  return source;
}

function normalizeQuestionEntry(entry, index, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw withErrorMeta(new TypeError(`${label}[${index}] 必须是对象`), 'usage.bad-argument', EXIT.USAGE);
  }
  const hasWrapper = Object.hasOwn(entry, 'question') && entry.question && typeof entry.question === 'object';
  const question = hasWrapper ? entry.question : entry;
  const file = hasWrapper
    ? (entry.file === null || entry.file === undefined ? null : path.resolve(assertNonEmptyString(entry.file, `${label}[${index}].file`)))
    : (entry.file ? path.resolve(assertNonEmptyString(entry.file, `${label}[${index}].file`)) : null);
  assertNonEmptyString(question.id, `${label}[${index}].id`);
  assertSafeInt(question.level, `${label}[${index}].level`, 1);
  return { file, question };
}

function sortQuestionEntries(entries) {
  return [...entries].sort((a, b) => a.question.level - b.question.level || cmp(a.question.id, b.question.id));
}

function checkUniqueIds(entries, label) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.question.id)) {
      throw withErrorMeta(new RangeError(`${label} 存在重复题号 ${entry.question.id}`), 'contract.duplicate-question-id', EXIT.CONTRACT);
    }
    seen.add(entry.question.id);
  }
}

function listJsonFilesRecursive(rootDir, skipDirs = DEFAULT_SKIP_DIRS) {
  const found = [];
  const visit = (cur) => {
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.resolve(cur, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) visit(abs);
      } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.schema.json')) {
        found.push(abs);
      }
    }
  };
  visit(rootDir);
  return found.sort((a, b) => {
    const ra = path.relative(rootDir, a).split(path.sep).join('/');
    const rb = path.relative(rootDir, b).split(path.sep).join('/');
    return cmp(ra, rb);
  });
}

function loadAndValidateQuestions(dir, { isHiddenBank }) {
  const files = listJsonFilesRecursive(dir);
  const loaded = [];
  for (const abs of files) {
    const raw = fs.readFileSync(abs, 'utf8');
    const checked = validateQuestion(raw);
    if (!checked.ok) {
      const label = isHiddenBank ? '隐藏题文件' : `题目文件 ${shownPath(path.relative(dir, abs))}`;
      throw contractError('contract.question-invalid', `${label}未通过 question/0.1 校验`, '用 validateQuestion 检查题目格式与泄露门禁');
    }
    const question = JSON.parse(raw);
    loaded.push({ file: path.resolve(abs), question });
  }
  return loaded;
}

/**
 * 发现并校验题库题目（公开题、预期失败题与可选外部目录隐藏题）。
 * 返回按 level 升序 + id 字典序排列的 `{ publicQuestions, hiddenQuestions, expectedFailQuestions }`。
 */
export function discoverSuiteQuestions({ questionsDir = DEFAULT_QUESTIONS_DIR, hiddenDir = null } = {}) {
  const qDirRaw = questionsDir === undefined || questionsDir === null
    ? DEFAULT_QUESTIONS_DIR
    : assertNonEmptyString(questionsDir, 'questionsDir');
  if (hasPrivateMarker(qDirRaw)) {
    throw usageError('questionsDir 路径含有私有标记', '使用合规目录路径', 'usage.bad-argument');
  }
  const resolvedQuestionsDir = path.resolve(qDirRaw);
  const qStat = fs.statSync(resolvedQuestionsDir, { throwIfNoEntry: false });
  if (!qStat || !qStat.isDirectory()) {
    throw usageError(`题目目录不存在或不是目录：${shownPath(resolvedQuestionsDir)}`, '检查 --questions-dir 路径', 'usage.bad-argument');
  }

  const publicQuestions = [];
  const expectedFailQuestions = [];
  for (const entry of loadAndValidateQuestions(resolvedQuestionsDir, { isHiddenBank: false })) {
    if (entry.question.flags?.hidden === true) continue;
    if (entry.question.flags?.expectedFail === true) expectedFailQuestions.push(entry);
    else publicQuestions.push(entry);
  }

  const hiddenQuestions = [];
  if (hiddenDir !== null && hiddenDir !== undefined) {
    const hDirRaw = assertNonEmptyString(hiddenDir, 'hiddenDir');
    if (hasPrivateMarker(hDirRaw)) {
      throw usageError('hiddenDir 路径含有私有标记', '使用外部独立隐藏题目录', 'usage.bad-argument');
    }
    const resolvedHiddenDir = path.resolve(hDirRaw);
    if (isInside(REPO, resolvedHiddenDir) || isInside(resolvedHiddenDir, REPO)) {
      throw usageError('hiddenDir 必须在引擎仓外部', '把隐藏题放到仓库外的独立目录', 'usage.bad-argument');
    }
    const hStat = fs.statSync(resolvedHiddenDir, { throwIfNoEntry: false });
    if (!hStat || !hStat.isDirectory()) {
      throw usageError('hiddenDir 不存在或不是目录', '检查 --hidden-dir 路径', 'usage.bad-argument');
    }
    for (const entry of loadAndValidateQuestions(resolvedHiddenDir, { isHiddenBank: true })) {
      if (entry.question.flags?.hidden !== true) continue;
      if (entry.question.flags?.expectedFail === true) expectedFailQuestions.push(entry);
      else hiddenQuestions.push(entry);
    }
  }

  checkUniqueIds([...publicQuestions, ...hiddenQuestions, ...expectedFailQuestions], '题库');

  return {
    publicQuestions: sortQuestionEntries(publicQuestions),
    hiddenQuestions: sortQuestionEntries(hiddenQuestions),
    expectedFailQuestions: sortQuestionEntries(expectedFailQuestions),
  };
}

/**
 * 纯函数：生成每日小卷（B13）确定性抽题与 40% 验证栏预算门控计划（深冻结）。
 */
export function planMiniExam({
  publicQuestions,
  dayIndex = 0,
  count = 6,
  models,
  source = 'three',
  validationBudgetTokens = 3_750_000,
  maxBudgetShare = DEFAULT_MINI_MAX_BUDGET_SHARE,
  unitTokens = DEFAULT_T2_UNIT_TOKENS,
  onOverBudget = 'reject',
} = {}) {
  if (!Array.isArray(publicQuestions)) {
    throw withErrorMeta(new TypeError('publicQuestions 必须是数组'), 'usage.bad-argument', EXIT.USAGE);
  }
  const normalized = publicQuestions.map((item, i) => normalizeQuestionEntry(item, i, 'publicQuestions'));
  if (normalized.length === 0) {
    throw withErrorMeta(new RangeError('publicQuestions 不能为空'), 'contract.empty-questions', EXIT.CONTRACT);
  }
  for (const entry of normalized) {
    if (entry.question.flags?.hidden === true) {
      throw withErrorMeta(new RangeError(`小卷不能包含隐藏题 ${entry.question.id}`), 'contract.invalid-mini-question', EXIT.CONTRACT);
    }
    if (entry.question.flags?.expectedFail === true) {
      throw withErrorMeta(new RangeError(`小卷不能包含预期失败题 ${entry.question.id}`), 'contract.invalid-mini-question', EXIT.CONTRACT);
    }
  }
  checkUniqueIds(normalized, 'publicQuestions');
  const sorted = sortQuestionEntries(normalized);

  assertSafeInt(dayIndex, 'dayIndex', 0);
  assertSafeInt(count, 'count', 1);
  const validModels = assertModels(models);
  const validSource = assertSource(source);
  assertPositiveFinite(validationBudgetTokens, 'validationBudgetTokens');
  if (typeof maxBudgetShare !== 'number') {
    throw withErrorMeta(new TypeError('maxBudgetShare 必须是数字'), 'usage.bad-argument', EXIT.USAGE);
  }
  if (!Number.isFinite(maxBudgetShare) || maxBudgetShare <= 0 || maxBudgetShare > 1) {
    throw withErrorMeta(new RangeError('maxBudgetShare 必须在 (0, 1] 范围内'), 'usage.bad-argument', EXIT.USAGE);
  }
  assertPositiveFinite(unitTokens, 'unitTokens');
  if (typeof onOverBudget !== 'string') {
    throw withErrorMeta(new TypeError('onOverBudget 必须是字符串'), 'usage.bad-argument', EXIT.USAGE);
  }
  if (onOverBudget !== 'reject' && onOverBudget !== 'trim') {
    throw withErrorMeta(new RangeError('onOverBudget 只能是 reject 或 trim'), 'usage.bad-argument', EXIT.USAGE);
  }

  const total = sorted.length;
  const start = (dayIndex * count) % total;
  const targetCount = Math.min(count, total);
  let selected = Array.from({ length: targetCount }, (_, i) => sorted[(start + i) % total]);

  const budgetCapTokens = Math.floor(validationBudgetTokens * maxBudgetShare);
  let estimatedTokens = selected.length * unitTokens;
  if (estimatedTokens > budgetCapTokens) {
    if (onOverBudget === 'reject') {
      throw withErrorMeta(
        new RangeError(`小卷估算开销 ${estimatedTokens} tokens 超出每日验证栏上限 ${budgetCapTokens} tokens`),
        'budget.exceeds-daily-cap',
        EXIT.CONTRACT,
      );
    }
    const maxAffordable = Math.floor(budgetCapTokens / unitTokens);
    if (maxAffordable < 1) {
      throw withErrorMeta(
        new RangeError(`每日验证栏上限 ${budgetCapTokens} tokens 不足运行 1 道题（单价 ${unitTokens}）`),
        'budget.exceeds-daily-cap',
        EXIT.CONTRACT,
      );
    }
    selected = selected.slice(0, maxAffordable);
    estimatedTokens = selected.length * unitTokens;
  }

  const runs = selected.map((entry, i) => ({
    questionId: entry.question.id,
    questionFile: entry.file,
    level: entry.question.level,
    visibility: 'public',
    model: validModels[(dayIndex + i) % validModels.length],
    source: validSource,
    expectedFail: false,
  }));

  return freezeDeep({
    format: SUITE_FORMAT,
    kind: 'mini',
    dayIndex,
    requestedCount: count,
    selectedCount: runs.length,
    budgetCapTokens,
    estimatedTokens,
    budgetShare: estimatedTokens / validationBudgetTokens,
    withinBudgetCap: estimatedTokens <= budgetCapTokens,
    runs,
  });
}

/**
 * 纯函数：生成全卷一（B14）27 次计分运行与 expected-fail 门控计划（深冻结）。
 */
export function planFullExam1({
  publicQuestions,
  hiddenQuestions = [],
  expectedFailQuestions = [],
  models,
  source = 'three',
  hiddenModel = null,
  hiddenCount = 3,
  previousBlockedBy = {},
  unitTokens = DEFAULT_T2_UNIT_TOKENS,
} = {}) {
  if (!Array.isArray(publicQuestions)) {
    throw withErrorMeta(new TypeError('publicQuestions 必须是数组'), 'usage.bad-argument', EXIT.USAGE);
  }
  if (!Array.isArray(hiddenQuestions)) {
    throw withErrorMeta(new TypeError('hiddenQuestions 必须是数组'), 'usage.bad-argument', EXIT.USAGE);
  }
  if (!Array.isArray(expectedFailQuestions)) {
    throw withErrorMeta(new TypeError('expectedFailQuestions 必须是数组'), 'usage.bad-argument', EXIT.USAGE);
  }
  const validModels = assertModels(models, { exact: 2 });
  const validSource = assertSource(source);
  assertSafeInt(hiddenCount, 'hiddenCount', 0);
  const chosenHiddenModel = hiddenModel === null || hiddenModel === undefined
    ? validModels[0]
    : assertNonEmptyString(hiddenModel, 'hiddenModel').trim();
  assertPositiveFinite(unitTokens, 'unitTokens');
  if (previousBlockedBy !== null && previousBlockedBy !== undefined && !isPlainObject(previousBlockedBy)) {
    throw withErrorMeta(new TypeError('previousBlockedBy 必须是普通对象'), 'usage.bad-argument', EXIT.USAGE);
  }

  const normPublic = publicQuestions.map((item, i) => normalizeQuestionEntry(item, i, 'publicQuestions'));
  for (const entry of normPublic) {
    if (entry.question.flags?.hidden === true || entry.question.flags?.expectedFail === true) {
      throw withErrorMeta(new RangeError(`publicQuestions 不能包含隐藏或预期失败题 ${entry.question.id}`), 'contract.invalid-question', EXIT.CONTRACT);
    }
  }
  const normHidden = hiddenQuestions.map((item, i) => normalizeQuestionEntry(item, i, 'hiddenQuestions'));
  for (const entry of normHidden) {
    if (entry.question.flags?.hidden !== true) {
      throw withErrorMeta(new RangeError('hiddenQuestions 只能包含 flags.hidden === true 的隐藏题'), 'contract.invalid-question', EXIT.CONTRACT);
    }
    if (entry.question.flags?.expectedFail === true) {
      throw withErrorMeta(new RangeError('hiddenQuestions 不能包含预期失败题'), 'contract.invalid-question', EXIT.CONTRACT);
    }
  }
  const normExpectedFail = expectedFailQuestions.map((item, i) => normalizeQuestionEntry(item, i, 'expectedFailQuestions'));

  checkUniqueIds([...normPublic, ...normHidden, ...normExpectedFail], '全卷一题集');

  const sortedPublic = sortQuestionEntries(normPublic);
  const sortedHidden = sortQuestionEntries(normHidden);
  const sortedExpectedFail = sortQuestionEntries(normExpectedFail);

  if (sortedHidden.length < hiddenCount) {
    throw withErrorMeta(
      new RangeError(`隐藏题数量不足：需要 ${hiddenCount} 道，实际只有 ${sortedHidden.length} 道`),
      'contract.insufficient-hidden-questions',
      EXIT.CONTRACT,
    );
  }
  const selectedHidden = sortedHidden.slice(0, hiddenCount);

  const runs = [];
  for (const entry of sortedPublic) {
    for (const model of validModels) {
      runs.push({
        questionId: entry.question.id,
        questionFile: entry.file,
        level: entry.question.level,
        visibility: 'public',
        model,
        source: validSource,
        expectedFail: false,
      });
    }
  }
  for (const entry of selectedHidden) {
    runs.push({
      questionId: entry.question.id,
      questionFile: entry.file,
      level: entry.question.level,
      visibility: 'hidden',
      model: chosenHiddenModel,
      source: validSource,
      expectedFail: false,
    });
  }

  const prevMap = previousBlockedBy ?? {};
  const expectedFailRuns = sortedExpectedFail.map((entry) => {
    const q = entry.question;
    const prev = Object.hasOwn(prevMap, q.id) ? prevMap[q.id] : null;
    const changed = hasBlockedByChanged(q.flags?.blockedBy ?? [], prev);
    return {
      questionId: q.id,
      questionFile: entry.file,
      level: q.level,
      visibility: q.flags?.hidden ? 'hidden' : 'public',
      model: validModels[0],
      source: validSource,
      expectedFail: true,
      forceExpectedFail: changed,
      blockedByChanged: changed,
    };
  });

  const publicRunCount = sortedPublic.length * validModels.length;
  const hiddenRunCount = selectedHidden.length;
  const rerunExpectedFailIds = expectedFailRuns.filter((r) => r.forceExpectedFail).map((r) => r.questionId);

  return freezeDeep({
    format: SUITE_FORMAT,
    kind: 'full-1',
    models: validModels,
    hiddenModel: chosenHiddenModel,
    scoredRunCount: runs.length,
    publicRunCount,
    hiddenRunCount,
    expectedFailCount: expectedFailRuns.length,
    rerunExpectedFailIds,
    estimatedTokens: (runs.length + rerunExpectedFailIds.length) * unitTokens,
    runs,
    expectedFailRuns,
  });
}

function projectQuestionForBoard(question) {
  const hidden = question.flags?.hidden === true;
  const expectedFail = question.flags?.expectedFail === true;
  const cal = question.calibration && typeof question.calibration === 'object'
    ? {
        version: question.calibration.version,
        status: question.calibration.status,
        ...(question.calibration.updatedAt ? { updatedAt: question.calibration.updatedAt } : {}),
      }
    : null;
  if (hidden) {
    return {
      format: question.format,
      id: question.id,
      level: question.level,
      title: `隐藏题 ${question.id}`,
      needs: [],
      flags: { hidden: true, expectedFail },
      ...(cal ? { calibration: cal } : {}),
    };
  }
  return {
    format: question.format,
    id: question.id,
    level: question.level,
    title: question.title,
    needs: Array.isArray(question.needs) ? [...question.needs] : [],
    flags: { hidden: false, expectedFail },
    ...(cal ? { calibration: cal } : {}),
  };
}

function projectResultForBoard(result) {
  const out = {
    format: result.format,
    questionId: result.questionId,
    ...(result.level !== undefined && result.level !== null ? { level: result.level } : {}),
    ...(result.source !== undefined && result.source !== null ? { source: result.source } : {}),
    ...(result.model !== undefined && result.model !== null ? { model: result.model } : {}),
    status: result.status,
    ...(typeof result.pass === 'boolean' ? { pass: result.pass } : {}),
    score: result.score,
    ...(result.visibility !== undefined ? { visibility: result.visibility } : {}),
    ...(typeof result.hidden === 'boolean' ? { hidden: result.hidden } : {}),
    ...(typeof result.unsupported === 'boolean' ? { unsupported: result.unsupported } : {}),
    ...(typeof result.expectedFail === 'boolean' ? { expectedFail: result.expectedFail } : {}),
    ...(result.unmeasured !== undefined ? { unmeasured: result.unmeasured } : {}),
    ...(result.createdAt !== undefined ? { createdAt: result.createdAt } : {}),
  };
  return out;
}

function collectEvalResults(evalRoot) {
  const files = listJsonFilesRecursive(evalRoot, RUN_PRIVATE_DIRS);
  const results = [];
  for (const abs of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      continue;
    }
    if (data?.format === RESULT_FORMAT) {
      results.push(projectResultForBoard(data));
    }
  }
  return results;
}

function loadCardsForBoard(cardsDir) {
  if (cardsDir === null || cardsDir === undefined) return undefined;
  const rawPath = assertNonEmptyString(cardsDir, 'cardsDir');
  if (hasPrivateMarker(rawPath)) {
    throw usageError('cardsDir 路径含有私有标记', '使用合规目录路径', 'usage.bad-argument');
  }
  const resolved = path.resolve(rawPath);
  const st = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) {
    throw usageError(`cardsDir 不存在或不是目录：${shownPath(resolved)}`, '检查 --cards-dir 路径', 'usage.bad-argument');
  }
  const files = listJsonFilesRecursive(resolved, CARD_SKIP_DIRS);
  const cards = [];
  for (const abs of files) {
    const raw = fs.readFileSync(abs, 'utf8');
    if (scanQuestionLeaks(raw).length > 0) {
      throw contractError('contract.leak-detected', '卡文件含有私有内容', '移除泄露内容后重试');
    }
    const data = JSON.parse(raw);
    if (path.basename(abs) === 'card.json' || data?.format === 'card/0.1') {
      cards.push(data);
    }
  }
  return cards;
}

function loadPriorsForBoard(priors) {
  if (!priors || (Array.isArray(priors) && priors.length === 0)) return undefined;
  if (!Array.isArray(priors)) {
    throw withErrorMeta(new TypeError('priors 必须是数组'), 'usage.bad-argument', EXIT.USAGE);
  }
  return priors.map((item, i) => {
    if (typeof item === 'string') {
      if (hasPrivateMarker(item)) {
        throw usageError(`priors[${i}] 路径含有私有标记`, '使用合规文件路径', 'usage.bad-argument');
      }
      const raw = fs.readFileSync(path.resolve(item), 'utf8');
      if (scanQuestionLeaks(raw).length > 0) {
        throw contractError('contract.leak-detected', '先验表含有私有内容', '移除泄露内容后重试');
      }
      return JSON.parse(raw);
    }
    return item;
  });
}

function scanSuiteLeaks(value) {
  const leaks = [...scanQuestionLeaks(value)];
  const seen = new WeakSet();
  const visit = (cur, at) => {
    if (typeof cur === 'string') {
      if (hasLocalPath(cur)) leaks.push({ code: 'local-path', path: at || '/' });
      return;
    }
    if (cur === null || typeof cur !== 'object' || seen.has(cur)) return;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i += 1) visit(cur[i], `${at}/${i}`);
    } else {
      for (const [k, v] of Object.entries(cur)) {
        if (hasLocalPath(k)) leaks.push({ code: 'local-path', path: at || '/', field: 'key' });
        visit(v, `${at}/${k}`);
      }
    }
  };
  visit(value, '');
  return leaks;
}

function sanitizePlanForReport(plan) {
  const cleanRun = (r) => ({
    questionId: r.questionId,
    level: r.level,
    visibility: r.visibility,
    model: r.model,
    source: r.source,
    expectedFail: r.expectedFail,
    ...(Object.hasOwn(r, 'forceExpectedFail') ? { forceExpectedFail: r.forceExpectedFail } : {}),
    ...(Object.hasOwn(r, 'blockedByChanged') ? { blockedByChanged: r.blockedByChanged } : {}),
  });
  return {
    ...plan,
    runs: plan.runs.map(cleanRun),
    ...(Array.isArray(plan.expectedFailRuns) ? { expectedFailRuns: plan.expectedFailRuns.map(cleanRun) } : {}),
  };
}

function sanitizeResultForReport(result) {
  const hidden = result.visibility === 'hidden';
  const safeError = hidden
    ? (result.error ? '运行出错' : null)
    : (typeof result.error === 'string' && (hasLocalPath(result.error) || scanQuestionLeaks(result.error).length > 0)
        ? '运行出错（细节已脱敏）'
        : result.error);
  return {
    format: result.format,
    questionId: result.questionId,
    level: result.level,
    source: result.source,
    model: result.model,
    runId: result.runId,
    status: result.status,
    pass: result.pass,
    score: result.score,
    error: safeError,
    visibility: result.visibility,
    blockedBy: hidden ? (result.blockedBy?.length ? ['[hidden]'] : []) : result.blockedBy,
    unmeasured: result.unmeasured,
    assertions: hidden ? [] : result.assertions,
    cost: result.cost,
    overBudget: result.overBudget,
    createdAt: result.createdAt,
  };
}

function writeSuiteAtomic(boardDir, names, buildFn) {
  fs.mkdirSync(boardDir, { recursive: true });
  return withFileLock(path.join(boardDir, 'history.json'), (locked) => {
    const historyFile = locked();
    const dir = path.dirname(historyFile);
    const existing = names.filter((name) => {
      const st = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false });
      if (st && !st.isFile()) throw usageError(`输出目标 ${name} 必须是普通文件`, '检查 --board-dir', 'usage.bad-argument');
      return Boolean(st);
    });
    const rendered = buildFn(existing.includes('history.json') ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : []);
    const staging = fs.mkdtempSync(path.join(dir, '.suite-'));
    const replaced = [];
    try {
      for (const name of existing) fs.copyFileSync(path.join(dir, name), path.join(staging, `${name}.old`));
      for (const name of names) fs.writeFileSync(path.join(staging, name), rendered.contents[name]);
      for (const name of names) {
        fs.renameSync(path.join(staging, name), path.join(dir, name));
        replaced.push(name);
      }
    } catch (error) {
      for (const name of replaced.reverse()) {
        if (existing.includes(name)) fs.renameSync(path.join(staging, `${name}.old`), path.join(dir, name));
        else fs.unlinkSync(path.join(dir, name));
      }
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return rendered.meta;
  });
}

async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 异步组卷调度与看板发布：发现题库 → 规划小卷/全卷一 → 隔离跑题 → 汇总结果 → 续写看板与脱敏报告原子落盘。
 */
export async function runExamSuite({
  mode,
  asOf,
  evalRoot,
  boardDir,
  questionsDir = DEFAULT_QUESTIONS_DIR,
  hiddenDir = null,
  models,
  source = 'three',
  hiddenModel = null,
  hiddenCount = 3,
  dayIndex = 0,
  count = 6,
  validationBudgetTokens = 3_750_000,
  maxBudgetShare = DEFAULT_MINI_MAX_BUDGET_SHARE,
  unitTokens = DEFAULT_T2_UNIT_TOKENS,
  onOverBudget = 'reject',
  previousBlockedBy = {},
  concurrency = 1,
  solver,
  solverForRun,
  solverCmd,
  solverCmdForRun,
  judge,
  cardsDir = null,
  priors = [],
} = {}) {
  if (mode !== 'mini' && mode !== 'full-1') {
    throw usageError(`mode 只能是 mini 或 full-1，收到 ${String(mode)}`, '指定 mode: "mini" 或 "full-1"', 'usage.bad-argument');
  }
  if (!isCalendarDate(asOf)) {
    throw usageError(`asOf 必须是 YYYY-MM-DD 日期，收到 ${String(asOf)}`, '传合法日期，例如 2026-11-25', 'usage.bad-argument');
  }
  assertNonEmptyString(evalRoot, 'evalRoot');
  assertNonEmptyString(boardDir, 'boardDir');
  if (hasPrivateMarker(evalRoot) || hasPrivateMarker(boardDir)) {
    throw usageError('evalRoot 或 boardDir 路径含有私有标记', '使用合规目录路径', 'usage.bad-argument');
  }
  const resolvedEvalRoot = assertEvalRoot(resolveEvalRoot(evalRoot), REPO);
  const resolvedBoardDir = path.resolve(boardDir);
  if (isInside(REPO, resolvedBoardDir) || isInside(resolvedBoardDir, REPO)) {
    throw usageError('boardDir 必须在引擎仓外部', '把看板目录放到仓库外', 'usage.bad-argument');
  }
  const boardStat = fs.statSync(resolvedBoardDir, { throwIfNoEntry: false });
  if (boardStat && !boardStat.isDirectory()) {
    throw usageError('boardDir 必须是目录', '检查 --board-dir 路径', 'usage.bad-argument');
  }
  assertSafeInt(concurrency, 'concurrency', 1);

  const resolvedHiddenDir = hiddenDir !== null && hiddenDir !== undefined ? path.resolve(assertNonEmptyString(hiddenDir, 'hiddenDir')) : null;
  const discovered = discoverSuiteQuestions({ questionsDir, hiddenDir: resolvedHiddenDir });
  const plan = mode === 'mini'
    ? planMiniExam({
        publicQuestions: discovered.publicQuestions,
        dayIndex,
        count,
        models,
        source,
        validationBudgetTokens,
        maxBudgetShare,
        unitTokens,
        onOverBudget,
      })
    : planFullExam1({
        publicQuestions: discovered.publicQuestions,
        hiddenQuestions: discovered.hiddenQuestions,
        expectedFailQuestions: discovered.expectedFailQuestions,
        models,
        source,
        hiddenModel,
        hiddenCount,
        previousBlockedBy,
        unitTokens,
      });

  const plannedItems = mode === 'mini' ? plan.runs : [...plan.runs, ...plan.expectedFailRuns];
  const prevMap = previousBlockedBy ?? {};
  const results = await runPool(plannedItems, concurrency, async (item) => {
    const itemSolver = typeof solverForRun === 'function' ? solverForRun(item) : solver;
    const itemSolverCmd = typeof solverCmdForRun === 'function' ? solverCmdForRun(item) : solverCmd;
    return runExamQuestion({
      questionFile: item.questionFile,
      evalRoot: resolvedEvalRoot,
      source: item.source,
      model: item.model,
      ...(typeof itemSolver === 'function' ? { solver: itemSolver } : {}),
      ...(typeof itemSolver !== 'function' && itemSolverCmd ? { solverCmd: itemSolverCmd } : {}),
      ...(judge ? { judge } : {}),
      ...(item.expectedFail
        ? {
            previousBlockedBy: Object.hasOwn(prevMap, item.questionId) ? prevMap[item.questionId] : null,
            rerunOnBlockedByChange: true,
          }
        : {}),
      ...(resolvedHiddenDir ? { denyReadDirs: [resolvedHiddenDir] } : {}),
    });
  });

  const actualTokens = results.reduce((sum, r) => sum + (Number.isFinite(r.cost?.tokens) ? r.cost.tokens : 0), 0);
  const wallMs = results.reduce((sum, r) => sum + (Number.isFinite(r.cost?.wallMs) ? r.cost.wallMs : 0), 0);
  const gpuSeconds = results.reduce((sum, r) => sum + (Number.isFinite(r.cost?.gpuSeconds) ? r.cost.gpuSeconds : 0), 0);

  const passedRuns = results.filter((r) => r.status === 'pass').length;
  const failedRuns = results.filter((r) => r.status === 'fail').length;
  const errorRuns = results.filter((r) => r.status === 'error').length;
  const expectedFailRuns = results.filter((r) => r.status === 'expected-fail').length;
  const scoredRuns = results.length - expectedFailRuns;
  const hiddenRuns = results.filter((r) => r.visibility === 'hidden').length;
  const budgetCapTokens = mode === 'mini' ? plan.budgetCapTokens : null;
  const actualWithinBudgetCap = mode === 'mini' ? actualTokens <= plan.budgetCapTokens : null;

  const allQuestions = [
    ...discovered.publicQuestions,
    ...discovered.hiddenQuestions,
    ...discovered.expectedFailQuestions,
  ].map((entry) => projectQuestionForBoard(entry.question));
  const evalResults = collectEvalResults(resolvedEvalRoot);
  const cards = loadCardsForBoard(cardsDir);
  const priorsData = loadPriorsForBoard(priors);

  const baseSummary = {
    totalRuns: results.length,
    scoredRuns,
    passedRuns,
    failedRuns,
    errorRuns,
    expectedFailRuns,
    hiddenRuns,
    actualTokens,
    wallMs,
    gpuSeconds,
    budgetCapTokens,
    actualWithinBudgetCap,
  };

  const { historyRows } = writeSuiteAtomic(
    resolvedBoardDir,
    ['board.json', 'history.json', 'index.html', 'suite-report.json'],
    (existingHistory) => {
      const board = buildBoard({
        asOf,
        questions: allQuestions,
        results: evalResults,
        ...(cards !== undefined ? { cards } : {}),
        ...(priorsData !== undefined ? { priors: priorsData } : {}),
        ...(existingHistory.length ? { history: existingHistory } : {}),
      });
      const history = appendBoardHistory(existingHistory, board);
      const boardWithHistory = { ...board, format: BOARD_FORMAT, history };
      const html = renderBoardHtml(boardWithHistory);
      const summary = { ...baseSummary, historyRows: history.length };
      const suiteReport = {
        format: SUITE_FORMAT,
        mode,
        asOf,
        plan: sanitizePlanForReport(plan),
        results: results.map(sanitizeResultForReport),
        summary,
        outputs: {
          boardJson: 'board.json',
          historyJson: 'history.json',
          boardHtml: 'index.html',
          suiteReport: 'suite-report.json',
        },
      };
      const leaks = scanSuiteLeaks(suiteReport);
      if (leaks.length > 0) {
        throw contractError('contract.leak-detected', `suite-report.json 检测到 ${leaks.length} 处泄露`, '检查脱敏投影');
      }
      return {
        meta: { historyRows: history.length },
        contents: {
          'board.json': `${JSON.stringify(boardWithHistory, null, 2)}\n`,
          'history.json': `${JSON.stringify(history, null, 2)}\n`,
          'index.html': html,
          'suite-report.json': `${JSON.stringify(suiteReport, null, 2)}\n`,
        },
      };
    },
  );

  const outputs = {
    boardJson: path.join(resolvedBoardDir, 'board.json'),
    historyJson: path.join(resolvedBoardDir, 'history.json'),
    boardHtml: path.join(resolvedBoardDir, 'index.html'),
    suiteReport: path.join(resolvedBoardDir, 'suite-report.json'),
  };

  return {
    format: SUITE_FORMAT,
    mode,
    asOf,
    plan,
    results,
    summary: { ...baseSummary, historyRows },
    outputs,
  };
}

function wrapCliError(err) {
  if (err instanceof EvalError) return err;
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'budget.exceeds-daily-cap' || code.startsWith('contract.')) {
    return contractError(code, err.message, '调整题目数量、预算参数或题库后重试');
  }
  if (err instanceof TypeError || err instanceof RangeError || code.startsWith('usage.')) {
    return usageError(err.message, '加 --help 查看用法', code || 'usage.bad-argument');
  }
  return err;
}

const SHARED_OPTIONS = {
  'as-of': { type: 'string', placeholder: 'YYYY-MM-DD', desc: '看板日期（必填）' },
  'eval-root': { type: 'string', placeholder: '目录', desc: '运行根目录，必须在仓库外（必填）' },
  'board-dir': { type: 'string', placeholder: '目录', desc: '看板与历史输出目录，必须在仓库外（必填）' },
  models: { type: 'list', placeholder: 'm1,m2', desc: '参与评测的模型家族列表（逗号分隔，必填）' },
  source: { type: 'string', placeholder: '帧源', default: 'three', desc: `出片帧源（${SOURCES.join(' / ')}）` },
  'questions-dir': { type: 'string', placeholder: '目录', desc: '题库目录（默认 beiming/bench/questions）' },
  'unit-tokens': { type: 'number', placeholder: '数值', default: DEFAULT_T2_UNIT_TOKENS, desc: '单次运行估算 token 单价' },
  concurrency: { type: 'number', placeholder: '整数', default: 1, desc: '并发跑题数' },
  'solver-cmd': { type: 'string', placeholder: '命令', desc: '做题命令（不填则使用 --model 无头 claude）' },
  'cards-dir': { type: 'string', placeholder: '目录', desc: '可选技术卡目录' },
  priors: { type: 'list', placeholder: '文件,…', desc: '可选先验表 JSON 文件列表' },
};

function requireCommonOpts(opts) {
  if (!opts['as-of']) throw usageError('缺少 --as-of', '写 --as-of YYYY-MM-DD', 'usage.missing-argument');
  if (!opts['eval-root']) throw usageError('缺少 --eval-root', '写 --eval-root <仓库外目录>', 'usage.missing-argument');
  if (!opts['board-dir']) throw usageError('缺少 --board-dir', '写 --board-dir <仓库外目录>', 'usage.missing-argument');
  if (!opts.models.length) throw usageError('缺少 --models', '写 --models m1,m2', 'usage.missing-argument');
}

const MINI = {
  spec: {
    summary: '运行每日小卷（B13）：确定性轮转抽题、40% 验证栏预算门控并每日续写看板',
    usage: 'node beiming/bench/suite.mjs mini --as-of YYYY-MM-DD --eval-root <dir> --board-dir <dir> --models m1,m2 [选项]',
    options: {
      ...SHARED_OPTIONS,
      'day-index': { type: 'number', placeholder: '整数', default: 0, desc: '轮转天序号（非负整数）' },
      count: { type: 'number', placeholder: '整数', default: 6, desc: '小卷抽题数（如 3 或 6）' },
      'validation-budget': { type: 'number', placeholder: '数值', default: 3_750_000, desc: '当天验证栏总 token 预算' },
      'max-budget-share': { type: 'number', placeholder: '比例', default: DEFAULT_MINI_MAX_BUDGET_SHARE, desc: '小卷占验证栏预算上限比例（(0, 1]）' },
      'on-over-budget': { type: 'string', placeholder: '策略', default: 'reject', choices: ['reject', 'trim'], desc: '超预算策略：reject 或 trim' },
    },
    notes: ['参数错误 exit 2；题库校验或 40% 预算超限 exit 4。'],
  },
  handler: async ({ opts }) => {
    requireCommonOpts(opts);
    try {
      const res = await runExamSuite({
        mode: 'mini',
        asOf: opts['as-of'],
        evalRoot: opts['eval-root'],
        boardDir: opts['board-dir'],
        questionsDir: opts['questions-dir'] ?? DEFAULT_QUESTIONS_DIR,
        models: opts.models,
        source: opts.source,
        dayIndex: opts['day-index'],
        count: opts.count,
        validationBudgetTokens: opts['validation-budget'],
        maxBudgetShare: opts['max-budget-share'],
        unitTokens: opts['unit-tokens'],
        onOverBudget: opts['on-over-budget'],
        concurrency: opts.concurrency,
        solverCmd: opts['solver-cmd'],
        cardsDir: opts['cards-dir'] ?? null,
        priors: opts.priors,
      });
      return {
        data: res,
        outputs: Object.values(res.outputs),
        text: `小卷（${res.asOf}）完成：${res.summary.passedRuns}/${res.summary.scoredRuns} 通过，历史行数 ${res.summary.historyRows}`,
      };
    } catch (err) {
      throw wrapCliError(err);
    }
  },
};

const FULL1 = {
  spec: {
    summary: '运行全卷一（B14）：12 公开题×双家族 + 3 隐藏题×单家族（27 次计分）+ expected-fail 门控并发布看板',
    usage: 'node beiming/bench/suite.mjs full-1 --as-of YYYY-MM-DD --eval-root <dir> --board-dir <dir> --models m1,m2 --hidden-dir <dir> [选项]',
    options: {
      ...SHARED_OPTIONS,
      'hidden-dir': { type: 'string', placeholder: '目录', desc: '仓库外隐藏题目录' },
      'hidden-model': { type: 'string', placeholder: '模型', desc: '隐藏题指定单一模型家族（默认取 models 第一项）' },
      'hidden-count': { type: 'number', placeholder: '整数', default: 3, desc: '抽取隐藏题数量（传 0 可无隐藏题干跑）' },
      'previous-blocked-by': { type: 'string', placeholder: '文件', desc: '上次记录的 blockedBy 映射 JSON 文件（{ 题号: [...] }）' },
    },
    notes: ['参数错误 exit 2；题库/隐藏题数量不足或泄露门禁不通过 exit 4。'],
  },
  handler: async ({ opts }) => {
    requireCommonOpts(opts);
    let previousBlockedBy = {};
    if (opts['previous-blocked-by']) {
      try {
        previousBlockedBy = JSON.parse(fs.readFileSync(path.resolve(opts['previous-blocked-by']), 'utf8'));
      } catch (err) {
        throw usageError(`无法读取 --previous-blocked-by 文件（${err.message}）`, '提供合法 JSON 文件', 'usage.bad-argument');
      }
    }
    try {
      const res = await runExamSuite({
        mode: 'full-1',
        asOf: opts['as-of'],
        evalRoot: opts['eval-root'],
        boardDir: opts['board-dir'],
        questionsDir: opts['questions-dir'] ?? DEFAULT_QUESTIONS_DIR,
        hiddenDir: opts['hidden-dir'] ?? null,
        models: opts.models,
        source: opts.source,
        hiddenModel: opts['hidden-model'] ?? null,
        hiddenCount: opts['hidden-count'],
        unitTokens: opts['unit-tokens'],
        previousBlockedBy,
        concurrency: opts.concurrency,
        solverCmd: opts['solver-cmd'],
        cardsDir: opts['cards-dir'] ?? null,
        priors: opts.priors,
      });
      return {
        data: res,
        outputs: Object.values(res.outputs),
        text: `全卷一（${res.asOf}）完成：计分 ${res.summary.scoredRuns} 次（通过 ${res.summary.passedRuns}），预期失败跳过 ${res.summary.expectedFailRuns} 次，历史行数 ${res.summary.historyRows}`,
      };
    } catch (err) {
      throw wrapCliError(err);
    }
  },
};

const isMain = () => {
  try {
    return Boolean(process.argv[1])
      && pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
};

if (isMain()) {
  await runCli({
    command: 'beiming/bench/suite.mjs',
    subcommands: { mini: MINI, 'full-1': FULL1 },
    summary: '北冥考题每日小卷与全卷一调度引擎',
  });
}
