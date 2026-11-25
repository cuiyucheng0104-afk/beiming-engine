// B13 + B14：每日小卷与全卷一组卷调度、40% 预算门控、隔离跑题与看板每日落盘自测
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as bench from './index.mjs';
import {
  BOARD_FORMAT,
  DEFAULT_MINI_MAX_BUDGET_SHARE,
  DEFAULT_T2_UNIT_TOKENS,
  SUITE_FORMAT,
  discoverSuiteQuestions,
  planFullExam1,
  planMiniExam,
  runExamSuite,
  scanQuestionLeaks,
  validateQuestion,
} from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const QUESTIONS_DIR = path.join(HERE, 'questions');
const SUITE_CLI = path.join(HERE, 'suite.mjs');

function makeTempDir(t, prefix = 'beiming-b13-b14-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const allPassJudge = ({ question }) => ({
  metrics: Object.fromEntries(question.scoring.map((s) => [s.metric, { pass: true }])),
  predicates: Object.fromEntries((question.basePredicates ?? []).map((p) => [p, true])),
});

function createHiddenFixtures(hiddenDir) {
  const base29 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/29-1.json'), 'utf8'));
  const specs = [
    { id: '91-1', level: 1, tag: 'ALPHA' },
    { id: '92-1', level: 2, tag: 'BETA' },
    { id: '93-1', level: 3, tag: 'GAMMA' },
  ];
  const secrets = [];
  for (const spec of specs) {
    const title = `CANARY-HIDDEN-TITLE-${spec.tag}`;
    const brief = `CANARY-HIDDEN-BRIEF-${spec.tag}`;
    const passText = `CANARY-HIDDEN-PASS-${spec.tag}`;
    const ctrlRef = `CANARY-HIDDEN-CTRL-REF-${spec.tag}`;
    const ctrlNeg = `CANARY-HIDDEN-CTRL-NEG-${spec.tag}`;
    const calSrc = `CANARY-HIDDEN-CAL-${spec.tag}`;
    const needId = `canary.hidden-${spec.tag.toLowerCase()}`;
    const q = {
      ...structuredClone(base29),
      id: spec.id,
      level: spec.level,
      title,
      brief,
      scoring: base29.scoring.map((item, idx) => (idx === 0 ? { ...item, pass: passText } : item)),
      controls: { referencePass: ctrlRef, negative: ctrlNeg },
      needs: [needId],
      flags: { hidden: true, expectedFail: false, blockedBy: [] },
      calibration: { status: 'calibrated', source: calSrc, noiseFloor: 0.05, version: 1 },
    };
    delete q.refs;
    const file = path.join(hiddenDir, `${spec.id}.json`);
    fs.writeFileSync(file, JSON.stringify(q, null, 2));
    assert.deepEqual(validateQuestion(fs.readFileSync(file, 'utf8')), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
    secrets.push(title, brief, passText, ctrlRef, ctrlNeg, calSrc, needId, file);
  }
  return { specs, secrets };
}

test('B13/B14-0: index.mjs 正确重导出全部 suite 公共符号与常量', () => {
  assert.equal(SUITE_FORMAT, 'bench-suite/0.1');
  assert.equal(DEFAULT_MINI_MAX_BUDGET_SHARE, 0.4);
  assert.equal(DEFAULT_T2_UNIT_TOKENS, 250_000);
  for (const name of [
    'SUITE_FORMAT',
    'DEFAULT_MINI_MAX_BUDGET_SHARE',
    'DEFAULT_T2_UNIT_TOKENS',
    'discoverSuiteQuestions',
    'planMiniExam',
    'planFullExam1',
    'runExamSuite',
  ]) {
    assert.ok(Object.hasOwn(bench, name), `index.mjs 缺少导出 ${name}`);
  }
});

test('B13-1: 两天/四天确定性轮转覆盖 12/12 公开题无重复，且严格执行 40% 日预算门控', (t) => {
  const discovered = discoverSuiteQuestions({ questionsDir: QUESTIONS_DIR });
  assert.equal(discovered.publicQuestions.length, 12);
  assert.equal(discovered.expectedFailQuestions.length, 5);
  assert.equal(discovered.hiddenQuestions.length, 0);

  // count = 6：两天精确轮完 12/12 道公开题，零重复
  const d0 = planMiniExam({ publicQuestions: discovered.publicQuestions, dayIndex: 0, count: 6, models: ['family-a', 'family-b'] });
  const d1 = planMiniExam({ publicQuestions: discovered.publicQuestions, dayIndex: 1, count: 6, models: ['family-a', 'family-b'] });
  assert.equal(Object.isFrozen(d0), true);
  assert.equal(Object.isFrozen(d0.runs), true);
  assert.equal(d0.format, SUITE_FORMAT);
  assert.equal(d0.kind, 'mini');
  assert.equal(d0.selectedCount, 6);
  assert.equal(d1.selectedCount, 6);
  assert.equal(d0.budgetCapTokens, 1_500_000);
  assert.equal(d0.estimatedTokens, 1_500_000);
  assert.equal(d0.budgetShare, 0.4);
  assert.equal(d0.withinBudgetCap, true);

  const idsTwoDays = [...d0.runs.map((r) => r.questionId), ...d1.runs.map((r) => r.questionId)];
  assert.equal(idsTwoDays.length, 12);
  assert.equal(new Set(idsTwoDays).size, 12);
  assert.deepEqual(d0.runs.map((r) => r.model), ['family-a', 'family-b', 'family-a', 'family-b', 'family-a', 'family-b']);
  assert.deepEqual(d1.runs.map((r) => r.model), ['family-b', 'family-a', 'family-b', 'family-a', 'family-b', 'family-a']);

  // count = 3：四天精确轮完 12/12 道公开题
  const fourDayIds = [];
  for (let day = 0; day < 4; day += 1) {
    const plan = planMiniExam({ publicQuestions: discovered.publicQuestions, dayIndex: day, count: 3, models: ['family-a', 'family-b'] });
    assert.equal(plan.selectedCount, 3);
    assert.equal(plan.estimatedTokens, 750_000);
    assert.equal(plan.withinBudgetCap, true);
    fourDayIds.push(...plan.runs.map((r) => r.questionId));
  }
  assert.equal(fourDayIds.length, 12);
  assert.equal(new Set(fourDayIds).size, 12);

  // 超出 40% 预算时 reject 抛 RangeError(budget.exceeds-daily-cap)
  assert.throws(
    () => planMiniExam({
      publicQuestions: discovered.publicQuestions,
      count: 6,
      models: ['family-a', 'family-b'],
      validationBudgetTokens: 2_500_000, // 40% = 1_000_000 < 6 * 250_000
      onOverBudget: 'reject',
    }),
    (e) => e instanceof RangeError && e.code === 'budget.exceeds-daily-cap',
  );

  // 超出 40% 预算时 trim 精确缩减到预算上限内（1_000_000 / 250_000 = 4 题）
  const trimmed = planMiniExam({
    publicQuestions: discovered.publicQuestions,
    count: 6,
    models: ['family-a', 'family-b'],
    validationBudgetTokens: 2_500_000,
    onOverBudget: 'trim',
  });
  assert.equal(trimmed.requestedCount, 6);
  assert.equal(trimmed.selectedCount, 4);
  assert.equal(trimmed.budgetCapTokens, 1_000_000);
  assert.equal(trimmed.estimatedTokens, 1_000_000);
  assert.equal(trimmed.withinBudgetCap, true);

  // 连 1 题都跑不起时，即使 trim 也抛 budget.exceeds-daily-cap
  assert.throws(
    () => planMiniExam({
      publicQuestions: discovered.publicQuestions,
      count: 6,
      models: ['family-a'],
      validationBudgetTokens: 500_000, // 40% = 200_000 < 250_000
      onOverBudget: 'trim',
    }),
    (e) => e instanceof RangeError && e.code === 'budget.exceeds-daily-cap',
  );

  // 非法题目目录与非法参数校验
  const badBank = makeTempDir(t, 'beiming-bad-bank-');
  fs.writeFileSync(path.join(badBank, 'broken.json'), '{"format":"question/0.1","id":"bad"}');
  assert.throws(
    () => discoverSuiteQuestions({ questionsDir: badBank }),
    (e) => e instanceof Error && e.code === 'contract.question-invalid',
  );
  assert.throws(() => planMiniExam({ publicQuestions: discovered.publicQuestions, models: ['a', 'a'] }), RangeError);
  assert.throws(() => planMiniExam({ publicQuestions: discovered.publicQuestions, models: ['a', 'b', 'c'] }), RangeError);
  assert.throws(() => planMiniExam({ publicQuestions: discovered.publicQuestions, models: ['a'], count: 0 }), RangeError);
  assert.throws(() => planMiniExam({ publicQuestions: discovered.publicQuestions, models: ['a'], dayIndex: -1 }), RangeError);
});

test('B13-2: 连续两天小卷端到端落盘与看板 history.json 每日增行及同日覆写不重复', async (t) => {
  const root = makeTempDir(t, 'beiming-b13-e2e-');
  const evalRoot = path.join(root, 'evals');
  const boardDir = path.join(root, 'board');

  const day1 = await runExamSuite({
    mode: 'mini',
    asOf: '2026-11-24',
    dayIndex: 0,
    count: 6,
    evalRoot,
    boardDir,
    models: ['family-a', 'family-b'],
    solver: async () => ({ tokens: 200_000, gpuSeconds: 1.5 }),
    judge: allPassJudge,
  });

  assert.equal(day1.format, SUITE_FORMAT);
  assert.equal(day1.mode, 'mini');
  assert.equal(day1.summary.totalRuns, 6);
  assert.equal(day1.summary.scoredRuns, 6);
  assert.equal(day1.summary.passedRuns, 6);
  assert.equal(day1.summary.actualTokens, 1_200_000);
  assert.equal(day1.summary.actualWithinBudgetCap, true);
  assert.equal(day1.summary.historyRows, 1);

  const hist1 = JSON.parse(fs.readFileSync(day1.outputs.historyJson, 'utf8'));
  assert.equal(hist1.length, 1);
  assert.equal(hist1[0].asOf, '2026-11-24');
  assert.equal(hist1[0].scoredCells, 6);

  // 第二天（2026-11-25）跑后 6 题，history.json 增长到 2 行
  const day2 = await runExamSuite({
    mode: 'mini',
    asOf: '2026-11-25',
    dayIndex: 1,
    count: 6,
    evalRoot,
    boardDir,
    models: ['family-a', 'family-b'],
    solver: async () => ({ tokens: 180_000, gpuSeconds: 1.2 }),
    judge: allPassJudge,
  });

  assert.equal(day2.summary.totalRuns, 6);
  assert.equal(day2.summary.passedRuns, 6);
  assert.equal(day2.summary.actualWithinBudgetCap, true);
  assert.equal(day2.summary.historyRows, 2);

  const board2 = JSON.parse(fs.readFileSync(day2.outputs.boardJson, 'utf8'));
  const hist2 = JSON.parse(fs.readFileSync(day2.outputs.historyJson, 'utf8'));
  const html2 = fs.readFileSync(day2.outputs.boardHtml, 'utf8');
  const report2 = JSON.parse(fs.readFileSync(day2.outputs.suiteReport, 'utf8'));

  assert.equal(board2.format, BOARD_FORMAT);
  assert.equal(board2.asOf, '2026-11-25');
  assert.equal(board2.matrix.scoredCells, 12);
  assert.deepEqual(hist2.map((r) => r.asOf), ['2026-11-24', '2026-11-25']);
  assert.equal(hist2[1].scoredCells, 12);
  assert.match(html2, /<!doctype html>/i);
  assert.match(html2, /2026-11-24/);
  assert.match(html2, /2026-11-25/);
  assert.equal(report2.format, SUITE_FORMAT);
  assert.deepEqual(scanQuestionLeaks(report2), []);

  // 重跑同一天（2026-11-25）覆写当天而不重复行
  const day2Rerun = await runExamSuite({
    mode: 'mini',
    asOf: '2026-11-25',
    dayIndex: 1,
    count: 6,
    evalRoot,
    boardDir,
    models: ['family-a', 'family-b'],
    solver: async () => ({ tokens: 150_000, gpuSeconds: 1.0 }),
    judge: allPassJudge,
  });
  assert.equal(day2Rerun.summary.historyRows, 2);
  const histRerun = JSON.parse(fs.readFileSync(day2Rerun.outputs.historyJson, 'utf8'));
  assert.deepEqual(histRerun.map((r) => r.asOf), ['2026-11-24', '2026-11-25']);
});

test('B14-1: 全卷一 27 次计分 + 预期失败门控 + 隐藏题零泄露端到端验证', async (t) => {
  const root = makeTempDir(t, 'beiming-b14-e2e-');
  const hiddenDir = path.join(root, 'private-hidden');
  const evalRoot1 = path.join(root, 'evals-run1');
  const boardDir1 = path.join(root, 'board-run1');
  fs.mkdirSync(hiddenDir);

  const { secrets } = createHiddenFixtures(hiddenDir);

  // 验证 planFullExam1 参数门控
  const discovered = discoverSuiteQuestions({ questionsDir: QUESTIONS_DIR, hiddenDir });
  assert.equal(discovered.publicQuestions.length, 12);
  assert.equal(discovered.hiddenQuestions.length, 3);
  assert.equal(discovered.expectedFailQuestions.length, 5);

  assert.throws(
    () => planFullExam1({ publicQuestions: discovered.publicQuestions, hiddenQuestions: discovered.hiddenQuestions, models: ['only-one'] }),
    RangeError,
  );
  assert.throws(
    () => planFullExam1({ publicQuestions: discovered.publicQuestions, hiddenQuestions: discovered.hiddenQuestions, models: ['dup', 'dup'] }),
    RangeError,
  );
  assert.throws(
    () => planFullExam1({ publicQuestions: discovered.publicQuestions, hiddenQuestions: [], models: ['a', 'b'] }),
    RangeError,
  );
  // 显式传 hiddenCount: 0 允许无隐藏题干跑
  const dryNoHidden = planFullExam1({
    publicQuestions: discovered.publicQuestions,
    hiddenQuestions: [],
    expectedFailQuestions: discovered.expectedFailQuestions,
    models: ['family-a', 'family-b'],
    hiddenCount: 0,
  });
  assert.equal(dryNoHidden.scoredRunCount, 24);
  assert.equal(dryNoHidden.hiddenRunCount, 0);

  // 1) 默认 blockedBy 未变：精确执行 27 次计分运行（12×2 + 3），5 道 expected-fail 全部 0 solver 调用跳过
  const solverCalls1 = [];
  const res1 = await runExamSuite({
    mode: 'full-1',
    asOf: '2026-11-25',
    evalRoot: evalRoot1,
    boardDir: boardDir1,
    hiddenDir,
    models: ['family-a', 'family-b'],
    solver: async ({ questionFile }) => {
      const q = JSON.parse(fs.readFileSync(questionFile, 'utf8'));
      solverCalls1.push(q.id);
      return { tokens: 150_000, gpuSeconds: 2.0 };
    },
    judge: allPassJudge,
  });

  assert.equal(res1.plan.publicRunCount, 24);
  assert.equal(res1.plan.hiddenRunCount, 3);
  assert.equal(res1.plan.scoredRunCount, 27);
  assert.equal(res1.plan.expectedFailCount, 5);
  assert.deepEqual(res1.plan.rerunExpectedFailIds, []);
  assert.equal(solverCalls1.length, 27);
  assert.equal(res1.summary.scoredRuns, 27);
  assert.equal(res1.summary.passedRuns, 27);
  assert.equal(res1.summary.expectedFailRuns, 5);
  assert.equal(res1.summary.hiddenRuns, 3);
  assert.equal(res1.summary.totalRuns, 32);

  // 验证 27+5 份 result.json 均已实际落盘
  for (const r of res1.results) {
    assert.ok(fs.existsSync(r.resultFile), `缺少 result.json: ${r.questionId}`);
  }
  for (const efId of ['10-1', '14-1', '24-1', '30-2', '900-1']) {
    const ef = res1.results.find((r) => r.questionId === efId);
    assert.ok(ef);
    assert.equal(ef.status, 'expected-fail');
    assert.equal(solverCalls1.includes(efId), false);
  }

  // 校验看板、历史、静态页、suite-report 对隐藏题零泄露
  const board1 = JSON.parse(fs.readFileSync(res1.outputs.boardJson, 'utf8'));
  const hist1 = JSON.parse(fs.readFileSync(res1.outputs.historyJson, 'utf8'));
  const html1 = fs.readFileSync(res1.outputs.boardHtml, 'utf8');
  const report1 = JSON.parse(fs.readFileSync(res1.outputs.suiteReport, 'utf8'));

  assert.ok(board1.reverseIndicators.expectedFailQuestions.count >= 5);
  assert.equal(board1.matrix.scoredCells, 32);
  for (const hiddenId of ['91-1', '92-1', '93-1']) {
    const row = board1.matrix.rows.find((r) => r.questionId === hiddenId);
    assert.ok(row, `看板应包含隐藏题行 ${hiddenId}`);
    assert.equal(row.hidden, true);
    assert.equal(row.title, `隐藏题 ${hiddenId}`);
  }
  assert.deepEqual(scanQuestionLeaks(report1), []);
  const combinedOutputs = JSON.stringify(board1) + JSON.stringify(hist1) + html1 + JSON.stringify(report1);
  for (const secret of [...secrets, hiddenDir, evalRoot1, boardDir1]) {
    assert.equal(combinedOutputs.includes(secret), false, `输出泄露了敏感内容: ${secret}`);
  }

  // 2) 当 1 道 expected-fail 题（10-1）的 blockedBy 较 previousBlockedBy 变化时，仅该题自动放行重跑，其余 4 道保持跳过
  const evalRoot2 = path.join(root, 'evals-run2');
  const boardDir2 = path.join(root, 'board-run2');
  const efQuestions = Object.fromEntries(discovered.expectedFailQuestions.map((e) => [e.question.id, e.question]));
  const previousBlockedBy = {
    '10-1': ['旧阻塞：已解封'],
    '14-1': [...efQuestions['14-1'].flags.blockedBy],
    '24-1': [...efQuestions['24-1'].flags.blockedBy],
    '30-2': [...efQuestions['30-2'].flags.blockedBy],
    '900-1': [...efQuestions['900-1'].flags.blockedBy],
  };

  const solverCalls2 = [];
  const res2 = await runExamSuite({
    mode: 'full-1',
    asOf: '2026-11-25',
    evalRoot: evalRoot2,
    boardDir: boardDir2,
    hiddenDir,
    models: ['family-a', 'family-b'],
    previousBlockedBy,
    solver: async ({ questionFile }) => {
      const q = JSON.parse(fs.readFileSync(questionFile, 'utf8'));
      solverCalls2.push(q.id);
      return { tokens: 150_000, gpuSeconds: 2.0 };
    },
    judge: allPassJudge,
  });

  assert.deepEqual(res2.plan.rerunExpectedFailIds, ['10-1']);
  assert.equal(solverCalls2.length, 28);
  assert.equal(solverCalls2.includes('10-1'), true);
  assert.equal(res2.summary.scoredRuns, 28);
  assert.equal(res2.summary.passedRuns, 28);
  assert.equal(res2.summary.expectedFailRuns, 4);
  for (const keptId of ['14-1', '24-1', '30-2', '900-1']) {
    assert.equal(solverCalls2.includes(keptId), false);
    assert.equal(res2.results.find((r) => r.questionId === keptId).status, 'expected-fail');
  }
  assert.equal(res2.results.find((r) => r.questionId === '10-1').status, 'pass');
});

test('B13/B14-CLI: --help 退出 0，缺参退出 2，预算超限/隐藏题不足退出 4', (t) => {
  const runCliProc = (args) => spawnSync(process.execPath, [SUITE_CLI, ...args], { cwd: REPO, encoding: 'utf8' });

  // --help
  for (const args of [['--help'], ['mini', '--help'], ['full-1', '--help']]) {
    const r = runCliProc(args);
    assert.equal(r.status, 0, `${args.join(' ')} stderr: ${r.stderr}`);
    assert.match(r.stdout, /用法：/);
  }

  // 参数错误 exit 2
  const missingArgs = runCliProc(['mini', '--as-of', '2026-11-25']);
  assert.equal(missingArgs.status, 2);

  const badMode = runCliProc(['unknown-cmd']);
  assert.equal(badMode.status, 2);

  // 预算超限 exit 4
  const tmp = makeTempDir(t, 'beiming-suite-cli-');
  const overBudget = runCliProc([
    'mini',
    '--as-of', '2026-11-25',
    '--eval-root', path.join(tmp, 'evals'),
    '--board-dir', path.join(tmp, 'board'),
    '--models', 'family-a,family-b',
    '--validation-budget', '100000',
  ]);
  assert.equal(overBudget.status, 4, overBudget.stderr);

  // full-1 缺少隐藏题目录（且未传 --hidden-count 0）exit 4
  const missingHidden = runCliProc([
    'full-1',
    '--as-of', '2026-11-25',
    '--eval-root', path.join(tmp, 'evals2'),
    '--board-dir', path.join(tmp, 'board2'),
    '--models', 'family-a,family-b',
  ]);
  assert.equal(missingHidden.status, 4, missingHidden.stderr);
});

test('B13/B14-guard: 仓内路径拒收、并发跑题与 solverForRun 注入', async (t) => {
  const root = makeTempDir(t, 'beiming-suite-guard-');

  // 仓库内 hiddenDir / evalRoot / boardDir 一律拒收
  assert.throws(
    () => discoverSuiteQuestions({ questionsDir: QUESTIONS_DIR, hiddenDir: path.join(REPO, 'beiming/bench') }),
    (e) => e?.exitCode === 2,
  );
  await assert.rejects(
    () => runExamSuite({
      mode: 'mini',
      asOf: '2026-11-25',
      evalRoot: path.join(REPO, 'out/evals-bad'),
      boardDir: path.join(root, 'board'),
      models: ['family-a'],
      solver: async () => ({ tokens: 100 }),
      judge: allPassJudge,
    }),
    (e) => e?.exitCode === 2,
  );
  await assert.rejects(
    () => runExamSuite({
      mode: 'mini',
      asOf: '2026-11-25',
      evalRoot: path.join(root, 'evals'),
      boardDir: path.join(REPO, 'out/board-bad'),
      models: ['family-a'],
      solver: async () => ({ tokens: 100 }),
      judge: allPassJudge,
    }),
    (e) => e?.exitCode === 2,
  );

  // concurrency=2 + solverForRun + actualWithinBudgetCap 实耗超限核对
  const seenModels = [];
  const res = await runExamSuite({
    mode: 'mini',
    asOf: '2026-11-25',
    evalRoot: path.join(root, 'evals-conc'),
    boardDir: path.join(root, 'board-conc'),
    dayIndex: 0,
    count: 3,
    validationBudgetTokens: 1_875_000, // 40% = 750_000 (刚好够 3 * 250_000)
    models: ['family-a', 'family-b'],
    concurrency: 2,
    solverForRun: (item) => async () => {
      seenModels.push(`${item.questionId}:${item.model}`);
      return { tokens: 260_000, gpuSeconds: 0.5 };
    },
    judge: allPassJudge,
  });
  assert.equal(res.summary.scoredRuns, 3);
  assert.equal(seenModels.length, 3);
  assert.equal(res.summary.actualTokens, 780_000);
  assert.equal(res.summary.budgetCapTokens, 750_000);
  assert.equal(res.summary.actualWithinBudgetCap, false);
});

test('B16-full-3: 保持 full-2 23 场不变，新增 full-3 精确 26 场计分（全卷二 23 场 + B18 3 道四级垫脚题）', async (t) => {
  const { planFullExam2, planFullExam3, runFullExam3 } = await import('./suite.mjs');
  const root = makeTempDir(t, 'beiming-b16-full3-');
  const hiddenDir = path.join(root, 'hidden');
  const evalRoot = path.join(root, 'evals');
  const boardDir = path.join(root, 'board');
  fs.mkdirSync(hiddenDir);
  createHiddenFixtures(hiddenDir);

  const bank = discoverSuiteQuestions({ questionsDir: QUESTIONS_DIR, hiddenDir });
  assert.equal(bank.publicQuestions.length, 12);
  assert.equal(bank.level3Questions.length, 3);
  assert.equal(bank.level4Questions.length, 3);

  const models = ['family-a', 'family-b'];
  const asOf = '2026-11-26';
  const plan2 = planFullExam2({ ...bank, models, asOf });
  assert.equal(plan2.scoredRunCount, 23);

  const plan3 = planFullExam3({ ...bank, models, asOf });
  assert.equal(plan3.scoredRunCount, 26);
  assert.equal(plan3.steppingStoneRunCount, 3);
  assert.deepEqual(plan3.runs.slice(20, 23).map((r) => r.questionId), ['41-1', '41-2', '41-3']);

  const res3 = await runFullExam3({
    asOf,
    evalRoot,
    boardDir,
    hiddenDir,
    models,
    solver: async () => ({ tokens: 120_000, gpuSeconds: 1.0 }),
    judge: allPassJudge,
  });
  assert.equal(res3.summary.scoredRuns, 26);
  assert.equal(res3.summary.passedRuns, 26);
  assert.equal(res3.summary.expectedFailRuns, 5);
});

