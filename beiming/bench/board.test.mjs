// B9：看板静态页（四个指标、考题×帧源×做题模型矩阵、05 §11 整合进度五个数与两个反向指标、每日历史、离线 HTML、入参门禁）
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as bench from './index.mjs';
import { BOARD_FORMAT, TOTAL_PRIORS_BASELINE, UNSUPPORTED_REASON, appendBoardHistory, buildBoard, escapeHtml, renderBoardHtml } from './board.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const BOARD = join(HERE, 'board.mjs');
const AS_OF = '2026-11-23';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);
const isBadArgument = (e) => e.code === 'usage.bad-argument' && e.exitCode === 2 && (e instanceof TypeError || e instanceof RangeError);
const jsonFiles = (dir, name) => readdirSync(dir, { recursive: true }).filter((f) => (name ? f.endsWith(name) : f.endsWith('.json'))).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));

const question = (id, level, extra = {}) => ({
  id, level, title: `公开题 ${id}`, brief: `题面 ${id}`, needs: [],
  flags: { hidden: false, expectedFail: false, blockedBy: [] },
  calibration: { status: 'uncalibrated', source: '初值', noiseFloor: null, version: 0 },
  ...extra,
});
const result = (questionId, source, model, status, score, extra = {}) => ({
  format: 'bench-result/0.1', questionId, source, model, status, pass: status === 'pass', score, visibility: 'public', unmeasured: 0, ...extra,
});
// 真实卡文件的状态写法（card-file 契约）：status 是逐环境的数组，等级是 read / reproduced / measured / film-verified
const card = (id, kind, livesIn, level, date, extra = {}) => ({ id, kind, livesIn, status: [{ level, host: 'h', source: 's', gpu: 'g', date }], exams: [`cal:${id}`], ...extra });

/* ---------------- 矩阵 ---------------- */

const matrixInputs = () => ({
  asOf: AS_OF,
  questions: [
    question('1-1', 1, { needs: ['deliver.encode'] }),
    question('2-1', 1, { needs: ['blender.cycles'] }),                       // 这张卡只落在 blender 上
    question('5-1', 2, { flags: { hidden: false, expectedFail: true, blockedBy: ['等量测器'] } }),
  ],
  cards: [
    card('deliver.encode', 'delivery', ['comp'], 'reproduced', '2026-11-21'),
    card('blender.cycles', 'mechanism', ['source:blender'], 'reproduced', '2026-11-21'),
  ],
  results: [
    result('1-1', 'three', 'model-a', 'pass', 1),
    result('1-1', 'blender', 'model-a', 'fail', 0.5),
    result('1-1', 'three', 'model-b', 'error', 0),
    result('2-1', 'blender', 'model-a', 'pass', 1),
    result('5-1', 'three', 'model-a', 'expected-fail', 0),
  ],
});

test('矩阵：缺能力的格字面是「这个帧源没有这项能力」，行、列、帧源、模型、总均分都不把它和没跑的格算进去', () => {
  const { matrix, fourIndicators } = buildBoard(matrixInputs());
  assert.equal(UNSUPPORTED_REASON, '这个帧源没有这项能力');
  assert.deepEqual(matrix.columns.map((c) => `${c.source}/${c.model}`), ['blender/model-a', 'three/model-a', 'three/model-b']);
  assert.deepEqual(matrix.rows.map((r) => r.questionId), ['1-1', '2-1', '5-1']);   // 等级升序，同级按题号
  const [q11, q21, q51] = matrix.rows;
  const kinds = (row) => row.cells.map((c) => c.kind);

  assert.deepEqual(kinds(q11), ['scored', 'scored', 'scored']);
  near(q11.rowMean, (0.5 + 1 + 0) / 3);                                    // 做题出错的 0 分照算
  assert.equal(q11.cells[2].status, 'error');

  // 2-1 要的卡只在 source:blender：three 两列是空格
  assert.deepEqual(kinds(q21), ['scored', 'unsupported-capability', 'unsupported-capability']);
  for (const cell of q21.cells.slice(1)) {
    assert.equal(cell.display, '这个帧源没有这项能力');
    assert.equal(cell.unsupportedReason, '这个帧源没有这项能力');
    assert.equal(cell.score, null);
    assert.equal(cell.pass, null);
  }
  assert.equal(q21.rowMean, 1);                                            // 分母是 1，不是 3

  // 5-1 预期失败：跑过的那格记 0 分并标出来，别的两格没跑
  assert.deepEqual(kinds(q51), ['unrun', 'scored', 'unrun']);
  assert.equal(q51.expectedFail, true);
  assert.equal(q51.cells[1].status, 'expected-fail');
  assert.equal(q51.rowMean, 0);

  near(matrix.columns[0].mean, (0.5 + 1) / 2);      // blender/model-a
  near(matrix.columns[1].mean, (1 + 0) / 2);        // three/model-a：1-1 过、5-1 预期失败；2-1 的空格不算
  assert.equal(matrix.columns[1].scoredCells, 2);
  near(matrix.columns[2].mean, 0);                  // three/model-b：只有 1-1 出错这一格
  assert.equal(matrix.columns[2].scoredCells, 1);
  assert.deepEqual(matrix.sourceMeans.map((s) => [s.source, s.scoredCells]), [['blender', 2], ['three', 3]]);
  near(matrix.sourceMeans[0].mean, 0.75);
  near(matrix.sourceMeans[1].mean, 1 / 3);
  assert.deepEqual(matrix.modelMeans.map((m) => [m.model, m.scoredCells]), [['model-a', 4], ['model-b', 1]]);
  near(matrix.modelMeans[0].mean, 2.5 / 4);
  near(matrix.modelMeans[1].mean, 0);
  near(matrix.overallMean, 2.5 / 5);
  assert.deepEqual([matrix.scoredCells, matrix.unsupportedCells, matrix.unrunCells], [5, 2, 2]);

  // 分级通过率同一个口径：空格不进分母，预期失败不进分子
  assert.deepEqual(fourIndicators.ceiling.passRateByLevel['1'], { passed: 2, total: 4, rate: 0.5 });
  assert.deepEqual(fourIndicators.ceiling.passRateByLevel['2'], { passed: 0, total: 1, rate: 0 });
  assert.deepEqual(fourIndicators.ceiling.passRateByLevel['5'], { passed: 0, total: 0, rate: null });
});

test('矩阵：显式标记的三种来源都判成空格，哪怕那一格有成绩', () => {
  const base = { asOf: AS_OF, questions: [question('1-1', 1, { needs: ['a.card'] }), question('1-2', 1)] };
  const scored = [result('1-1', 'three', 'm', 'fail', 0), result('1-2', 'three', 'm', 'pass', 1)];
  const check = (inputs) => {
    const { matrix } = buildBoard({ ...base, ...inputs });
    assert.equal(matrix.rows[0].cells[0].kind, 'unsupported-capability');
    assert.equal(matrix.rows[0].cells[0].display, UNSUPPORTED_REASON);
    assert.equal(matrix.rows[0].rowMean, null);
    assert.equal(matrix.overallMean, 1);                                  // 那个 0 分没被算进去
    assert.equal(matrix.scoredCells, 1);
  };
  check({ results: [result('1-1', 'three', 'm', 'unsupported-capability', 0), scored[1]] });
  check({ results: [{ questionId: '1-1', source: 'three', model: 'm', unsupported: true, score: null }, scored[1]] });
  check({ results: [{ ...scored[0], unsupported: true }, scored[1]] });
  check({ results: scored, sourceCapabilities: { three: { unsupportedQuestions: ['1-1'] } } });
  check({ results: scored, sourceCapabilities: { three: { unsupportedCards: ['a.card'] } } });
  for (const status of ['timeout', 'error', 'failed', 'expected-fail']) {
    const board = buildBoard({ asOf: AS_OF, results: [result('9-1', 'three', 'm', status, 0.8, { level: 1 })] });
    assert.deepEqual([board.matrix.scoredCells, board.matrix.overallMean], [1, 0]);
  }
  // 对照：不标就是普通的 0 分，要进分母
  assert.equal(buildBoard({ ...base, results: scored }).matrix.overallMean, 0.5);
  // 卡同时有跨帧源落点（data / comp / bake）就不是空格；可选的自研核心帧源 core（O12/O13）同样按落点判能力
  const shared = buildBoard({
    ...base,
    results: [...scored, result('1-1', 'core', 'm', 'pass', 1), result('1-2', 'core', 'm', 'pass', 0.5)],
    cards: [card('a.card', 'time', ['source:blender', 'data'], 'reproduced', AS_OF)],
  });
  assert.equal(shared.matrix.rows[0].cells[0].kind, 'scored');
  assert.deepEqual(shared.matrix.sourceMeans.map((s) => [s.source, s.mean]), [['core', 0.75], ['three', 0.5]]);
  const coreOnlyBlender = buildBoard({
    ...base,
    results: [result('1-1', 'core', 'm', 'fail', 0), result('1-2', 'core', 'm', 'pass', 1)],
    cards: [card('a.card', 'mechanism', ['source:blender'], 'reproduced', AS_OF)],
  });
  assert.equal(coreOnlyBlender.matrix.rows[0].cells[0].display, UNSUPPORTED_REASON);
  assert.equal(coreOnlyBlender.matrix.overallMean, 1);
});

test('矩阵：同一格跑了几次取最新一次；没注明帧源的结果单独成列', () => {
  const { matrix } = buildBoard({
    asOf: AS_OF,
    questions: [question('1-1', 1)],
    results: [
      result('1-1', 'three', 'm', 'pass', 1, { createdAt: '2026-11-22T08:00:00.000Z' }),
      result('1-1', 'three', 'm', 'fail', 0.25, { createdAt: '2026-11-23T08:00:00.000Z' }),
      result('1-1', 'three', 'm', 'pass', 1, { createdAt: '2026-11-21T08:00:00.000Z' }),
      result('1-1', null, null, 'pass', 1),
    ],
  });
  assert.deepEqual(matrix.columns.map((c) => [c.source, c.model]), [['three', 'm'], ['unspecified', 'unspecified']]);
  assert.deepEqual([matrix.rows[0].cells[0].score, matrix.rows[0].cells[0].runs], [0.25, 3]);
});

/* ---------------- 隐藏题 ---------------- */

test('隐藏题只落总分和状态：board.json 和 index.html 里没有题面、标题、阻塞原因、逐项、needs、refs', () => {
  const secrets = ['秘密标题甲', '秘密题面乙', '秘密阻塞丙', 'secret.metric-ding', 'secret.card-wu', 'secret/ref-ji.png', '秘密出处庚'];
  const board = buildBoard({
    asOf: AS_OF,
    questions: [
      question('9-1', 2, {
        title: secrets[0], brief: secrets[1], needs: [secrets[4]], refs: [secrets[5]],
        flags: { hidden: true, expectedFail: true, blockedBy: [secrets[2]] },
        calibration: { status: 'calibrated', source: secrets[6], noiseFloor: 0.1, version: 3 },
      }),
      question('1-1', 1),
    ],
    results: [
      result('9-1', 'three', 'm', 'fail', 0.4, { visibility: 'hidden', blockedBy: [secrets[2]], assertions: [{ kind: 'scoring', name: secrets[3], weight: 1, pass: false }] }),
      // 题面没传进来、只有结果说自己是隐藏题：同样只落总分
      result('9-2', 'three', 'm', 'pass', 1, { level: 3, visibility: 'hidden', title: secrets[0] }),
      result('1-1', 'three', 'm', 'pass', 1),
    ],
  });
  const text = JSON.stringify(board) + renderBoardHtml(board);
  for (const secret of secrets) assert.ok(!text.includes(secret), `泄露了 ${secret}`);
  const hidden = board.matrix.rows.find((r) => r.questionId === '9-1');
  assert.deepEqual(Object.keys(hidden).sort(), ['calibration', 'calibrationChanged', 'cells', 'expectedFail', 'hidden', 'level', 'questionId', 'rowMean', 'scoredCells', 'title']);
  assert.deepEqual([hidden.hidden, hidden.title, hidden.cells[0].score, hidden.cells[0].status], [true, '隐藏题 9-1', 0.4, 'fail']);
  assert.equal(Object.hasOwn(hidden.cells[0], 'unmeasured'), false);
  const old = { asOf: '2026-10-01', assertions: [{ note: secrets[3] }] };
  assert.throws(() => appendBoardHistory([old], board), isBadArgument);
  assert.throws(() => buildBoard({ asOf: AS_OF, history: [old] }), isBadArgument);
  const restored = JSON.parse(JSON.stringify(board));
  restored.matrix.rows.find((row) => row.hidden).title = secrets[0];
  assert.ok(!renderBoardHtml(restored).includes(secrets[0]));
  assert.deepEqual(hidden.calibration, { version: 3, status: 'calibrated' });
  assert.deepEqual(board.matrix.rows.find((r) => r.questionId === '9-2').level, 3);
  // 考题覆盖只列公开题
  assert.deepEqual(board.integrationProgress.examCoverage.perQuestion.map((q) => q.questionId), ['1-1']);
  // 公开题和隐藏题的结果对不上号时按隐藏题处理
  const mixed = buildBoard({ asOf: AS_OF, questions: [question('1-1', 1)], results: [result('1-1', 'three', 'm', 'pass', 1, { visibility: 'hidden' })] });
  assert.deepEqual([mixed.matrix.rows[0].hidden, mixed.matrix.rows[0].title], [true, '隐藏题 1-1']);
});

/* ---------------- 四个指标 ---------------- */

const ledgerRow = (jobId, attempt, status, extra = {}) => ({
  format: 'job-ledger/0.1', seq: 1, jobId, attempt, kind: 'film', status, wallMs: 60000, gpuSeconds: 30, gpuKnown: true,
  tokensByTier: { fable: 1000, opus: 0, sonnet: 500, haiku: 0, other: 0 }, totalTokens: 1500, renderedFrames: 240, deliveredFrames: 120, diskBytes: 1024, ...extra,
});

test('四个指标：画面上限、无人值守（自选模板单列）、速度与成本（A15 账本）、可控与可复现', () => {
  const { fourIndicators: four } = buildBoard({
    asOf: AS_OF,
    parity: [{ id: 'psnr', value: 42, threshold: 40, direction: 'at-least' }, { id: 'de00', value: 1.5, threshold: 2, direction: 'at-most' }, { id: 'ssim', margin: -0.01 }],
    energy: [
      { metric: 'noise.residual', value: 0.02 }, { metric: 'metric:noise.residual', value: 0.04 },
      { metric: 'clip.highlight-ratio', value: 0.001 }, { metric: 'alias.edge', value: 0.3 },
    ],
    blindPicks: [{ outcome: 'win' }, { outcome: 'tie' }, { outcome: 'loss' }, { outcome: 'win' }],
    jobs: [
      { jobId: 'job-a', basePass: true, interventions: 0, filmDurationSec: 5 },
      { jobId: 'job-b', basePass: true, interventions: 1 },
      { jobId: 'job-c', basePass: false, interventions: 0 },
      { jobId: 'job-d', basePass: true, interventions: 0, templateOrigin: 'self-selected' },
      { jobId: 'job-e', basePass: false, interventions: 0, mode: 'hand', selfSelectedTemplate: true },
    ],
    ledger: [
      ledgerRow('job-a', 1, 'failed', { deliveredFrames: 0 }),
      ledgerRow('job-a', 2, 'succeeded'),
      ledgerRow('job-x', 1, 'succeeded', { filmDurationSec: 10, gpuKnown: false }),
      ledgerRow('job-b', 1, 'failed', { deliveredFrames: 0 }),               // 没出成片：进总量，不进每秒成片
    ],
    pureFunctionGate: [{ pass: true }, { pass: true }, { pass: false }],
    locality: { passed: 1, total: 1 },
    rebuild: { exact: [{ pass: true }], tolerance: { passed: 1, total: 2 } },
  });

  assert.deepEqual(four.ceiling.parityHeadroom, { count: 3, minMargin: -0.01, belowThreshold: 1, items: [{ id: 'ssim', margin: -0.01 }, { id: 'de00', margin: 0.5 }, { id: 'psnr', margin: 2 }] });
  near(four.ceiling.energyRulers['noise.residual'].mean, 0.03);
  assert.deepEqual([four.ceiling.energyRulers['noise.residual'].samples, four.ceiling.energyRulers['noise.residual'].worst], [2, 0.04]);
  assert.deepEqual(four.ceiling.energyRulers['alias.edge'], { samples: 1, mean: 0.3, worst: 0.3 });
  assert.deepEqual(four.ceiling.blindPick, { wins: 2, ties: 1, losses: 1, winsOrTies: 3, total: 4, rate: 0.75 });

  // 主成功率只数委托和考题作业；自选模板的两部片单列，不混进去
  assert.deepEqual({ ...four.unattended, selfSelected: undefined }, { succeeded: 1, total: 3, rate: 1 / 3, selfSelected: undefined });
  assert.deepEqual(four.unattended.selfSelected, { succeeded: 1, total: 2, rate: 0.5 });

  const cost = four.speedAndCost;
  assert.deepEqual([cost.filmJobs, cost.filmSeconds], [2, 15]);
  near(cost.wallSecPerFilmSec, (60 * 3) / 15);            // job-a 两轮都算在它的成片头上，加 job-x 一轮
  near(cost.gpuSecPerFilmSec, (30 * 3) / 15);
  near(cost.tokensPerFilmSec, (1500 * 3) / 15);
  near(cost.tokensByTierPerFilmSec.fable, 3000 / 15);
  near(cost.tokensByTierPerFilmSec.sonnet, 1500 / 15);
  assert.equal(cost.tokensByTierPerFilmSec.opus, 0);
  near(cost.renderedPerDelivered, (240 * 4) / (120 * 2));
  near(cost.meanRounds, 4 / 3);                           // 4 行、3 个作业
  assert.deepEqual([cost.totals.count, cost.totals.wallMs, cost.totals.totalTokens, cost.totals.gpuUnknownRows], [4, 240000, 6000, 1]);

  assert.deepEqual(four.controllability.pureFunctionGate, { passed: 2, total: 3, rate: 2 / 3 });
  assert.deepEqual(four.controllability.locality, { passed: 1, total: 1, rate: 1 });
  assert.deepEqual(four.controllability.rebuild.exact, { passed: 1, total: 1, rate: 1 });
  assert.deepEqual(four.controllability.rebuild.tolerance, { passed: 1, total: 2, rate: 0.5 });
  assert.deepEqual(four.controllability.rebuild.nightlyLegacy, { passed: 0, total: 0, rate: null, status: 'not-run' });
});

test('四个指标：没有数据时是 null 或 not-run，不出 NaN 和 Infinity', () => {
  const board = buildBoard({ asOf: AS_OF, ledger: [ledgerRow('job-a', 1, 'failed', { renderedFrames: 10, deliveredFrames: 0 })] });
  const { ceiling, unattended, speedAndCost, controllability } = board.fourIndicators;
  assert.deepEqual([ceiling.parityHeadroom, ceiling.energyRulers, ceiling.blindPick], [null, null, null]);
  assert.deepEqual(unattended, { succeeded: 0, total: 0, rate: null, selfSelected: { succeeded: 0, total: 0, rate: null } });
  assert.deepEqual([speedAndCost.wallSecPerFilmSec, speedAndCost.gpuSecPerFilmSec, speedAndCost.tokensPerFilmSec, speedAndCost.tokensByTierPerFilmSec, speedAndCost.renderedPerDelivered], [null, null, null, null, null]);
  assert.equal(speedAndCost.meanRounds, 1);
  assert.equal(controllability.locality.status, 'not-run');
  assert.equal(board.matrix.overallMean, null);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(board) + renderBoardHtml(board)));
  assert.equal(buildBoard({ asOf: AS_OF }).fourIndicators.speedAndCost.meanRounds, null);
});

/* ---------------- 整合进度与反向指标 ---------------- */

test('整合进度五个数：卡分布（只读过单列）、考题覆盖、参数验证比例、原包立靶、收获率', () => {
  const { integrationProgress: progress } = buildBoard({
    asOf: AS_OF,
    questions: [
      question('1-1', 1, { needs: ['c.measured', 'c.film', 'c.reproduced', 'c.missing'] }),
      question('1-2', 2, { needs: [] }),
      question('1-3', 2, { needs: ['c.measured'], flags: { hidden: false, expectedFail: true, blockedBy: ['x'] } }),
      question('9-1', 3, { needs: ['c.read'], flags: { hidden: true, expectedFail: false, blockedBy: [] } }),
    ],
    results: [result('1-2', 'three', 'm', 'fail', 0, { unmeasured: 2 })],
    cards: [
      card('c.read', 'time', ['data'], 'read', '2026-08-01'),
      card('c.reproduced', 'time', ['data', 'comp'], 'reproduced', '2026-11-20'),
      card('c.measured', 'post', ['source:three'], 'measured', '2026-11-20'),
      card('c.film', 'post', ['source:three'], 'film-verified', '2026-11-20', { exams: [] }),
      card('c.candidate', 'post', ['comp'], 'reproduced', '2026-11-20', { ext: { 'registry.candidate': true } }),
      // 北冥看板自己的写法也认
      { id: 'c.alias', category: 'audio', livesIn: ['comp'], status: 'verified', exams: ['1-1'] },
    ],
    priors: [
      { format: 'priors/0.1', entries: [
        { id: 'p.1', verifiedInOurStack: true }, { id: 'p.2', verifiedInOurStack: false },
        { id: 'p.sum', verifiedInOurStack: true, summaryOf: ['p.1', 'p.2'] },             // 汇总行不数
      ] },
      { id: 'p.3', verifiedInOurStack: true }, { id: 'p.1', verifiedInOurStack: true },     // 同一条传两次只数一次
    ],
    packParity: { verifiedPacks: 2, ablatedSwitches: 15 },
    harvest: { drafted: 4, promoted: 1, archived: 2, reproducedPromotions: 1 },
  });

  const { cards } = progress;
  assert.deepEqual(cards.byStatus, { 'read-only': 1, candidate: 1, reproduced: 1, verified: 2, 'production-proven': 1 });
  assert.deepEqual([cards.total, cards.readOnlyPlaceholders, cards.candidates], [6, 1, 1]);
  assert.deepEqual([cards.reproducedOrAbove, cards.verifiedOrAbove, cards.productionProven], [4, 3, 1]);
  assert.deepEqual(cards.distribution, [
    { category: 'audio', livesIn: 'comp', status: 'verified', count: 1 },
    { category: 'post', livesIn: 'comp', status: 'candidate', count: 1 },
    { category: 'post', livesIn: 'source:three', status: 'production-proven', count: 1 },
    { category: 'post', livesIn: 'source:three', status: 'verified', count: 1 },
    { category: 'time', livesIn: 'comp', status: 'reproduced', count: 1 },
    { category: 'time', livesIn: 'data', status: 'read-only', count: 1 },
    { category: 'time', livesIn: 'data', status: 'reproduced', count: 1 },
  ]);

  const { examCoverage } = progress;
  assert.deepEqual(examCoverage.perQuestion, [
    { questionId: '1-1', level: 1, needs: 4, verified: 2, ratio: 0.5, notVerified: ['c.missing', 'c.reproduced'] },
    { questionId: '1-2', level: 2, needs: 0, verified: 0, ratio: null, noCardNeeds: true, notVerified: [] },
    { questionId: '1-3', level: 2, needs: 1, verified: 1, ratio: 1, notVerified: [] },
  ]);
  assert.deepEqual(examCoverage.cardsWithExam, { withExam: 3, total: 4, ratio: 0.75, without: ['c.film'] });
  assert.deepEqual(examCoverage.scorableQuestions, {
    total: 4, scorable: 2,
    byLevel: { 1: { total: 1, scorable: 1 }, 2: { total: 2, scorable: 0 }, 3: { total: 1, scorable: 1 } },
    notScorable: [{ questionId: '1-2', reason: 'unmeasured' }, { questionId: '1-3', reason: 'expected-fail' }],
  });

  assert.equal(TOTAL_PRIORS_BASELINE, 4452);
  assert.deepEqual(progress.priorsVerified, { verifiedCount: 2, detailCount: 3, baselineTotal: 4452, ratio: 2 / 4452 });
  assert.deepEqual(progress.packParity, { verifiedPacks: 2, totalPacks: 5, packRatio: 0.4, ablatedSwitches: 15, totalSwitches: 56, switchRatio: 15 / 56 });
  assert.deepEqual(progress.harvest, { drafted: 4, promoted: 1, archived: 2, reproducedPromotions: 1 });

  const empty = buildBoard({ asOf: AS_OF }).integrationProgress;
  assert.deepEqual(empty.packParity, { verifiedPacks: 0, totalPacks: 5, packRatio: 0, ablatedSwitches: 0, totalSwitches: 56, switchRatio: 0 });
  assert.deepEqual(empty.harvest, { drafted: 0, promoted: 0, archived: 0, reproducedPromotions: 0 });
  assert.deepEqual(empty.priorsVerified, { verifiedCount: 0, detailCount: 0, baselineTotal: 4452, ratio: 0 });
  assert.throws(() => buildBoard({ asOf: AS_OF, packParity: { verifiedPacks: 6 } }), isBadArgument);
  assert.throws(() => buildBoard({ asOf: AS_OF, packParity: { ablatedSwitches: 57 } }), isBadArgument);
  assert.deepEqual(
    buildBoard({ asOf: AS_OF, packParity: { verifiedPacks: 2, totalPacks: 5, ablatedSwitches: 15, totalSwitches: 56 } }).integrationProgress.packParity,
    { verifiedPacks: 2, totalPacks: 5, packRatio: 0.4, ablatedSwitches: 15, totalSwitches: 56, switchRatio: 15 / 56 },
  );
  for (const badPack of [
    { verifiedPacks: 1, totalPacks: 1, ablatedSwitches: 1, totalSwitches: 1 },
    { totalPacks: 0 },
    { totalPacks: 6 },
    { totalSwitches: 0 },
    { totalSwitches: 55 },
    { totalPacks: '5' },
  ]) {
    assert.throws(() => buildBoard({ asOf: AS_OF, packParity: badPack }), isBadArgument);
  }
});

test('两个反向指标：预期失败题；停在复现过超过 14 天的卡（14 天不算、15 天算，只读过和候选放多久都不算）', () => {
  const { reverseIndicators: reverse } = buildBoard({
    asOf: AS_OF,
    questions: [
      question('1-1', 1),
      question('3-1', 3, { flags: { hidden: false, expectedFail: true, blockedBy: ['等卡'] } }),
      question('3-2', 3, { flags: { hidden: false, expectedFail: true, blockedBy: ['等卡'] } }),
    ],
    cards: [
      card('c.day14', 'time', ['data'], 'reproduced', '2026-11-09'),
      card('c.day15', 'time', ['data'], 'reproduced', '2026-11-08'),
      card('c.day100.read', 'time', ['data'], 'read', '2026-08-15'),
      card('c.day100.candidate', 'time', ['data'], 'reproduced', '2026-08-15', { ext: { 'registry.candidate': true } }),
      card('c.day100.measured', 'time', ['data'], 'measured', '2026-08-15'),
      // 两个环境都只到复现过：按最早那天起算
      { id: 'c.two-envs', kind: 'time', livesIn: ['data'], exams: ['cal:x.y'], status: [
        { level: 'reproduced', host: 'h', source: 's', gpu: 'g1', date: '2026-11-20' },
        { level: 'reproduced', host: 'h', source: 's', gpu: 'g2', date: '2026-10-01' },
      ] },
      // 有一个环境已经量测通过：不算停在复现过
      { id: 'c.one-measured', kind: 'time', livesIn: ['data'], exams: ['cal:x.z'], status: [
        { level: 'reproduced', host: 'h', source: 's', gpu: 'g1', date: '2026-08-01' },
        { level: 'measured', host: 'h', source: 's', gpu: 'g2', date: '2026-11-20' },
      ] },
      { id: 'c.alias.old', category: 'time', livesIn: ['data'], status: 'reproduced', reproducedAt: '2026-01-01' },
      { id: 'c.alias.read-only', category: 'time', livesIn: ['data'], status: 'read-only', statusUpdatedAt: '2026-01-01' },
      { id: 'c.alias.undated', category: 'time', livesIn: ['data'], status: 'reproduced' },
    ],
  });
  assert.deepEqual(reverse.expectedFailQuestions, { count: 2, ids: ['3-1', '3-2'] });
  assert.deepEqual(reverse.staleReproducedCards, { count: 3, thresholdDays: 14, ids: ['c.alias.old', 'c.day15', 'c.two-envs'], undated: ['c.alias.undated'] });
  // 天数按日历算：跨闰日、跨年都对，和 Date 的算法逐日对得上
  const stale = (asOf, date) => buildBoard({ asOf, cards: [card('c.x', 'time', ['data'], 'reproduced', date)] }).reverseIndicators.staleReproducedCards.count;
  assert.deepEqual([stale('2028-03-01', '2028-02-15'), stale('2028-03-01', '2028-02-16'), stale('2027-03-01', '2027-02-15'), stale('2027-03-01', '2027-02-14')], [1, 0, 0, 1]);
  assert.deepEqual([stale('2027-01-08', '2026-12-24'), stale('2027-01-08', '2026-12-25'), stale('2026-01-01', '2026-11-23')], [1, 0, 0]);
  for (let offset = 0; offset < 800; offset += 1) {
    const date = new Date(Date.UTC(2026, 10, 23) - offset * 864e5).toISOString().slice(0, 10);
    assert.equal(stale(AS_OF, date), offset > 14 ? 1 : 0, date);
  }
});

test('真实入库数据：仓库里的卡、公开题、先验表直接喂进去能出看板', () => {
  const cards = jsonFiles(join(REPO, 'beiming/cards'), 'card.json');
  const questions = jsonFiles(join(REPO, 'beiming/bench/questions'));
  const priors = [JSON.parse(readFileSync(join(REPO, 'beiming/cards/priors-data/audio-subs.json'), 'utf8'))];
  const board = buildBoard({ asOf: AS_OF, cards, questions, priors });
  assert.equal(board.integrationProgress.cards.total, cards.length);
  assert.equal(board.matrix.rows.length, questions.length);
  assert.equal(board.integrationProgress.priorsVerified.detailCount, priors[0].entries.filter((e) => !Object.hasOwn(e, 'summaryOf')).length);
  assert.ok(renderBoardHtml(board).includes('北冥看板'));
});

/* ---------------- 纯函数、历史 ---------------- */

test('buildBoard 是纯函数：不读墙钟，同一份入参两次结果相同，不改入参，结果深冻结', () => {
  const inputs = matrixInputs();
  const before = JSON.stringify(inputs);
  const realDate = globalThis.Date;
  const FakeDate = function () { throw new Error('读了墙钟'); };
  FakeDate.now = () => { throw new Error('读了墙钟'); };
  globalThis.Date = FakeDate;
  let first, second, html, appended;
  try {
    first = buildBoard(inputs);
    second = buildBoard(inputs);
    html = renderBoardHtml(first);
    appended = appendBoardHistory([], first);
  } finally { globalThis.Date = realDate; }
  assert.deepEqual(first, second);
  assert.ok(html.includes('北冥看板') && appended.length === 1);
  assert.equal(JSON.stringify(inputs), before);
  assert.deepEqual([first.format, first.asOf], [BOARD_FORMAT, AS_OF]);
  assert.equal(BOARD_FORMAT, 'bench-board/0.1');
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.matrix.rows[0].cells[0]) && Object.isFrozen(first.history));
  assert.deepEqual(Object.keys(first), ['format', 'asOf', 'fourIndicators', 'matrix', 'integrationProgress', 'reverseIndicators', 'calibrationChanges', 'history']);
  for (const asOf of [undefined, '2026-02-30', '2026-1-1', 20261123, '2026-11-23T00:00:00Z']) assert.throws(() => buildBoard({ asOf }), isBadArgument);
});

test('每日历史：三天三行，同一天重跑还是三行；改了校准的那天打标', () => {
  const day = (asOf, version, history) => buildBoard({
    asOf, history,
    questions: [question('1-1', 1, { calibration: { status: version ? 'calibrated' : 'uncalibrated', source: '初值', noiseFloor: null, version } }), question('1-2', 1)],
    results: [result('1-1', 'three', 'm', 'pass', 1)],
  });
  const d10 = day('2026-11-10', 0, []);
  const d11 = day('2026-11-11', 0, d10.history);
  const d12 = day('2026-11-12', 1, d11.history);
  assert.deepEqual(d12.history.map((row) => row.asOf), ['2026-11-10', '2026-11-11', '2026-11-12']);
  assert.deepEqual([d10.calibrationChanges, d11.calibrationChanges], [[], []]);
  assert.deepEqual(d12.calibrationChanges, [{ questionId: '1-1', version: 1, status: 'calibrated', previous: { version: 0, status: 'uncalibrated' } }]);
  assert.deepEqual(d12.matrix.rows.map((row) => row.calibrationChanged), [true, false]);
  assert.deepEqual(d12.history.map((row) => row.calibrationChanged), [[], [], ['1-1']]);
  assert.ok(renderBoardHtml(d12).includes('今日校准变更'));
  assert.ok(!renderBoardHtml(d11).includes('今日校准变更'));

  // 同一天重跑：行数不变，标记还在（和前一天比，不和自己上一次比）
  const again = day('2026-11-12', 1, d12.history);
  assert.equal(again.history.length, 3);
  assert.deepEqual(again.calibrationChanges, d12.calibrationChanges);
  assert.deepEqual(again.history, d12.history);
  // 第二天版本没再变：标记消失
  assert.deepEqual(day('2026-11-13', 1, d12.history).calibrationChanges, []);
  // 题目自己带了当天的 updatedAt 也打标；且版本不变时经后续日期推进或 appendBoardHistory 也不会把当天的显式校准标记抹掉
  const dated = buildBoard({ asOf: AS_OF, questions: [question('1-1', 1, { calibration: { status: 'calibrated', version: 2, updatedAt: AS_OF } })] });
  assert.deepEqual(dated.calibrationChanges, [{ questionId: '1-1', version: 2, status: 'calibrated', previous: null }]);
  const nov22 = buildBoard({ asOf: '2026-11-22', questions: [question('1-1', 1, { calibration: { status: 'calibrated', version: 1 } })] });
  const nov23 = buildBoard({ asOf: '2026-11-23', history: nov22.history, questions: [question('1-1', 1, { calibration: { status: 'calibrated', version: 1, updatedAt: '2026-11-23' } })] });
  const nov24 = buildBoard({ asOf: '2026-11-24', history: nov23.history, questions: [question('1-1', 1, { calibration: { status: 'calibrated', version: 1 } })] });
  assert.deepEqual(nov24.history.map((r) => r.calibrationChanged), [[], ['1-1'], []]);
  assert.deepEqual(appendBoardHistory(nov22.history, nov23).map((r) => r.calibrationChanged), [[], ['1-1']]);

  // 乱序补录历史（11-10 v0 → 11-12 v1 → 补录 11-11 v1）：重算相邻日的校准变更，最终趋势标记与按日期顺序跑完全一致
  const inOrder = day('2026-11-12', 1, day('2026-11-11', 1, day('2026-11-10', 0, []).history).history);
  const outOfOrder = day('2026-11-11', 1, day('2026-11-12', 1, day('2026-11-10', 0, []).history).history);
  assert.deepEqual(inOrder.history.map((r) => r.calibrationChanged), [[], ['1-1'], []]);
  assert.deepEqual(outOfOrder.history, inOrder.history);
  const viaAppend = appendBoardHistory(day('2026-11-12', 1, day('2026-11-10', 0, []).history).history, day('2026-11-11', 1, day('2026-11-10', 0, []).history));
  assert.deepEqual(viaAppend, inOrder.history);

  // appendBoardHistory：按日期升序，同一天覆盖，不改传入的数组
  const stale = [{ asOf: '2026-11-12', overallMean: 0 }, { asOf: '2026-11-10', overallMean: 0 }];
  const merged = appendBoardHistory(stale, d12);
  assert.deepEqual(merged.map((row) => row.asOf), ['2026-11-10', '2026-11-12']);
  assert.equal(merged[1].overallMean, 1);
  assert.equal(stale.length, 2);
  assert.deepEqual(appendBoardHistory(merged, d12), merged);
  assert.deepEqual(appendBoardHistory([], d11).map((row) => [row.asOf, row.scoredCells, row.overallMean]), [['2026-11-11', 1, 1]]);
  assert.throws(() => appendBoardHistory([{ asOf: 'yesterday' }], d12), isBadArgument);
  assert.throws(() => appendBoardHistory([{ asOf: '2026-11-10' }, { asOf: '2026-11-10' }], d12), isBadArgument);
  assert.throws(() => appendBoardHistory([], { format: 'bench-board/0.1' }), isBadArgument);
  assert.throws(() => appendBoardHistory(null, d12), isBadArgument);
});

/* ---------------- HTML ---------------- */

test('静态页：离线自包含（没有脚本、外链和网络资源），动态文字全部转义', () => {
  const attack = '<script>alert(1)</script>';
  const quote = '"><img src=x onerror=alert(1)>\'&';
  const board = buildBoard({
    asOf: AS_OF,
    questions: [question('1-1', 1, { title: attack })],
    results: [result('1-1', quote, attack, 'pass', 1)],
    cards: [card('c.x', attack, [quote], 'reproduced', '2026-01-01')],
    parity: [{ id: attack, margin: 1 }],
    sourceCapabilities: { [quote]: {} },
  });
  const html = renderBoardHtml(board);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;'));
  assert.ok(!html.includes(attack) && !html.includes('<img') && !/<script/i.test(html));
  assert.ok(!/https?:|\/\/|<link|<iframe|<object|<embed|@import|url\(|\son[a-z]+\s*=|javascript:|\ssrc\s*=|\shref\s*=/i.test(html.replaceAll('&lt;img src=x onerror=alert(1)&gt;', '')));
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  // 页面上该有的东西
  for (const text of ['北冥看板', AS_OF, '画面上限', '无人值守成功率', '速度与成本', '可控与可复现', '考题 × 帧源 × 做题模型', '整合进度', '反向指标', '每日趋势']) assert.ok(html.includes(text), `缺 ${text}`);

  const page = renderBoardHtml(buildBoard(matrixInputs()));
  assert.equal(page.split('这个帧源没有这项能力').length - 1 >= 2, true);
  assert.ok(page.includes('预期失败') && page.includes('公开题 1-1'));
  // 传进来的看板本身也要过门禁
  assert.throws(() => renderBoardHtml({ format: 'bench-board/0.1' }), isBadArgument);
  assert.throws(() => renderBoardHtml({ ...buildBoard({ asOf: AS_OF }), format: 'other/1' }), isBadArgument);
  assert.throws(() => renderBoardHtml(null), isBadArgument);
  const tampered = JSON.parse(JSON.stringify(buildBoard(matrixInputs())));
  tampered.matrix.rows[0].title = 'lab://private/thing';
  assert.throws(() => renderBoardHtml(tampered), isBadArgument);

  // 极大有限数（如 Number.MAX_VALUE 样本均值）不会因朴素累加溢出成 Infinity 而破坏 buildBoard → renderBoardHtml 闭环
  const hugeEnergyBoard = buildBoard({
    asOf: AS_OF,
    energy: [{ metric: 'noise.residual', value: Number.MAX_VALUE }, { metric: 'noise.residual', value: Number.MAX_VALUE }],
  });
  assert.equal(hugeEnergyBoard.fourIndicators.ceiling.energyRulers['noise.residual'].mean, Number.MAX_VALUE);
  const hugeHtml = renderBoardHtml(hugeEnergyBoard);
  assert.ok(hugeHtml.includes('<!doctype html>') && !hugeHtml.includes('Infinity'));
});

/* ---------------- 入参门禁 ---------------- */

test('入参门禁：Proxy、取值器、稀疏数组、类实例等一律 usage.bad-argument，校验时一个陷阱和取值器都不触发', () => {
  let traps = 0;
  const counting = new Proxy({}, new Proxy({}, { get: () => { traps += 1; return undefined; } }));
  const proxied = (target) => new Proxy(target, new Proxy({}, { get: () => { traps += 1; return undefined; } }));
  const withGetter = (target, key) => Object.defineProperty(target, key, { enumerable: true, get() { traps += 1; return 'x'; } });
  const sparse = [question('1-1', 1), , question('1-2', 1)];   // eslint-disable-line no-sparse-arrays
  const tagged = Object.assign([question('1-1', 1)], { extra: 1 });
  const holeAndTag = Object.assign([, question('1-2', 1)], { extra: 1 });   // eslint-disable-line no-sparse-arrays
  class Fancy { constructor() { this.asOf = AS_OF; } }
  const cyclic = { asOf: AS_OF, harvest: {} };
  cyclic.harvest.self = cyclic;
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const board = buildBoard(matrixInputs());
  const emptyList = [];

  const cases = [
    counting, proxied({ asOf: AS_OF }), revocable.proxy, null, undefined, 'x', 42, emptyList, new Fancy(), new Map(), Object.create({ asOf: AS_OF }),
    { asOf: AS_OF, questions: proxied([]) },
    { asOf: AS_OF, questions: [proxied(question('1-1', 1))] },
    { asOf: AS_OF, results: [{ ...result('1-1', 'three', 'm', 'pass', 1), cost: proxied({}) }] },
    withGetter({ asOf: AS_OF }, 'questions'),
    { asOf: AS_OF, questions: [withGetter(question('1-1', 1), 'title')] },
    Object.defineProperty({}, 'asOf', { enumerable: true, get() { traps += 1; return AS_OF; } }),
    { asOf: AS_OF, questions: sparse },
    { asOf: AS_OF, questions: tagged },
    { asOf: AS_OF, questions: holeAndTag },
    { asOf: AS_OF, [Symbol('s')]: 1 },
    Object.defineProperty({ asOf: AS_OF }, 'cards', { value: [], enumerable: false }),
    { asOf: AS_OF, cards: [new Fancy()] },
    { asOf: AS_OF, cards: new Set() },
    { asOf: AS_OF, harvest: { drafted: NaN } },
    { asOf: AS_OF, harvest: { drafted: 1n } },
    { asOf: AS_OF, harvest: { drafted: () => 1 } },
    { asOf: AS_OF, harvest: undefined },
    { asOf: AS_OF, questions: [{ ...question('1-1', 1), title: '\ud800' }] },
    JSON.parse(`{"asOf":"${AS_OF}","harvest":{"__proto__":{"polluted":1}}}`),
    cyclic,
    { asOf: AS_OF, unknownKey: 1 },
  ];
  for (const [i, input] of cases.entries()) {
    assert.throws(() => buildBoard(input), isBadArgument, `buildBoard 第 ${i} 个`);
    assert.throws(() => renderBoardHtml(input), isBadArgument, `renderBoardHtml 第 ${i} 个`);
    assert.throws(() => appendBoardHistory([], input), isBadArgument, `appendBoardHistory 看板第 ${i} 个`);
    if (input !== emptyList) assert.throws(() => appendBoardHistory(input, board), isBadArgument, `appendBoardHistory 历史第 ${i} 个`);   // 空数组是合法的空历史
  }
  assert.throws(() => appendBoardHistory([proxied({ asOf: AS_OF })], board), isBadArgument);
  assert.throws(() => appendBoardHistory(sparse, board), isBadArgument);
  assert.equal(traps, 0);
  assert.equal({}.polluted, undefined);

  // Object.prototype 被污染挂上继承取值器/设值器（含 value、get、set、toJSON、code）时，三个公开纯函数仍零陷阱触发，且自有 accessor 绝不借原型 value 绕过
  const protoKeys = ['questions', 'results', 'cards', 'sourceCapabilities', 'ledger', 'jobs', 'parity', 'energy', 'blindPicks', 'pureFunctionGate', 'locality', 'rebuild', 'priors', 'packParity', 'harvest', 'history', 'flags', 'hidden', 'expectedFail', 'ext', 'exact', 'tolerance', 'nightlyLegacy', 'verifiedPacks', 'totalPacks', 'ablatedSwitches', 'totalSwitches', 'drafted', 'calibration', 'noCardNeeds', 'status', 'value', 'get', 'set', 'toJSON', 'code'];
  let protoTraps = 0;
  const sneakyAccessor = {
    asOf: AS_OF,
    questions: [Object.defineProperty({ id: '1-1', level: 1 }, 'title', { enumerable: true, get() { protoTraps += 1; return 'OWN_SECRET'; } })],
  };
  try {
    for (const key of protoKeys) {
      Object.defineProperty(Object.prototype, key, {
        __proto__: null,
        configurable: true,
        get() { protoTraps += 1; return key === 'toJSON' ? undefined : []; },
        set() { protoTraps += 1; },
      });
    }
    const cleanBoard = buildBoard({
      asOf: AS_OF,
      questions: [question('1-1', 1)],
      results: [result('1-1', 'three', 'm', 'pass', 1, { level: 1 })],
      cards: [card('a.b', 'time', ['data'], 'read', AS_OF)],
      ledger: [ledgerRow('job-a', 1, 'succeeded')],
      jobs: [{ jobId: 'job-a', basePass: true, interventions: 0, filmDurationSec: 5 }],
      parity: [{ id: 'p-1', direction: 'at-least', value: 0.9, threshold: 0.8 }],
      energy: [{ metric: 'noise.residual', value: 0.01 }],
      blindPicks: [{ outcome: 'win' }],
      priors: [{ entries: [{ id: 'pr.1', verifiedInOurStack: true }] }],
      history: [{ asOf: '2026-11-20' }],
    });
    const cleanHtml = renderBoardHtml(cleanBoard);
    const cleanHist = appendBoardHistory([{ asOf: '2026-11-19' }], cleanBoard);
    assert.equal(Object.getPrototypeOf(cleanBoard), Object.prototype);
    assert.equal(Object.getPrototypeOf(cleanBoard.history[0]), Object.prototype);
    assert.equal(Object.getPrototypeOf(cleanHist[0]), Object.prototype);
    assert.ok(cleanHtml.includes('<!doctype html>'));
    assert.throws(() => buildBoard(sneakyAccessor), isBadArgument);
    assert.throws(() => renderBoardHtml({ format: BOARD_FORMAT, asOf: AS_OF }), isBadArgument);
    assert.throws(() => appendBoardHistory([], { format: BOARD_FORMAT, asOf: AS_OF }), isBadArgument);
  } finally {
    for (const key of protoKeys) delete Object.prototype[key];
  }
  assert.equal(protoTraps, 0);

  // escapeHtml 导出入口同样零陷阱调用：对带 getter 对象、Proxy、非有限数一律抛 usage.bad-argument
  let escapeTraps = 0;
  const badToString = Object.defineProperty({}, 'toString', { get() { escapeTraps += 1; return () => '<secret>'; } });
  const badProxy = new Proxy({}, new Proxy({}, { get() { escapeTraps += 1; return undefined; } }));
  assert.throws(() => escapeHtml(badToString), isBadArgument);
  assert.throws(() => escapeHtml(badProxy), isBadArgument);
  assert.throws(() => escapeHtml(Number.NaN), isBadArgument);
  assert.equal(escapeTraps, 0);

  // 字段类型不对
  const wrong = [
    { questions: [null] }, { questions: [{ id: '1-1' }] }, { questions: [question('1-1', 0)] }, { questions: [question('1-1', 1), question('1-1', 2)] },
    { questions: [question('1-1', 1, { flags: { hidden: 'yes' } })] }, { questions: [question('1-1', 1, { needs: 'a.b' })] },
    { results: [result('1-1', 'three', 'm', 'pass', 1)] },                                // 没有题面，结果里也没有等级
    { results: [result('1-1', 'three', 'm', 'weird', 1, { level: 1 })] }, { results: [result('1-1', 'three', 'm', 'pass', 1.5, { level: 1 })] },
    { results: [result('1-1', 'three', 'm', 'pass', -0.1, { level: 1 })] }, { results: [result('1-1', 'three', 'm', 'fail', 0, { level: 1, pass: true })] },
    { results: [{ ...result('1-1', 'three', 'm', 'pass', 1, { level: 1 }), format: 'other/0.1' }] }, { results: [result('1-1', 7, 'm', 'pass', 1, { level: 1 })] },
    { results: [{ questionId: '1-1', level: 1, source: 'three', model: 'm', status: 'pass' }] },   // 判过分的结果必须带分数
    { cards: [{ id: 'a.b', kind: 'time', livesIn: [], status: 'reproduced' }] }, { cards: [{ id: 'a.b', kind: 'time', livesIn: ['data'], status: 'shipped' }] },
    { cards: [{ id: 'a.b', kind: 'time', livesIn: ['data'], status: [] }] }, { cards: [card('a.b', 'time', ['data'], 'reproduced', '2026-13-01')] },
    { cards: [card('a.b', 'time', ['data'], 'read', AS_OF), card('a.b', 'time', ['data'], 'read', AS_OF)] },
    { sourceCapabilities: { three: { unsupported: ['1-1'] } } }, { sourceCapabilities: [] },
    { jobs: [{ jobId: 'j', basePass: true }] }, { jobs: [{ jobId: 'j', basePass: 1, interventions: 0 }] }, { jobs: [{ jobId: 'j', basePass: true, interventions: -1 }] },
    { jobs: [{ jobId: 'j', basePass: true, interventions: 0 }, { jobId: 'j', basePass: true, interventions: 0 }] },
    { ledger: [{ jobId: 'j' }] }, { ledger: [ledgerRow('j', 1, 'succeeded', { totalTokens: 1 })] }, { ledger: [ledgerRow('j', 1, 'succeeded', { filmDurationSec: -1 })] },
    { parity: [{ id: 'a' }] }, { parity: [{ id: 'a', value: 1, threshold: 1, direction: 'sideways' }] },
    { energy: [{ metric: 'shape.iou', value: 1 }] }, { energy: [{ metric: 'noise.residual', value: -1 }] },
    { blindPicks: [{ outcome: 'draw' }] }, { pureFunctionGate: [{ pass: 'yes' }] }, { locality: { passed: 2, total: 1 } }, { rebuild: { weekly: [] } },
    { priors: [{ id: 'p', verifiedInOurStack: 'true' }] }, { harvest: { drafted: 1.5 } }, { harvest: { sold: 1 } }, { history: [{ asOf: 'x' }] },
  ];
  for (const [i, extra] of wrong.entries()) assert.throws(() => buildBoard({ asOf: AS_OF, ...extra }), isBadArgument, `字段第 ${i} 个：${JSON.stringify(extra).slice(0, 80)}`);
});

test('泄露门禁：入参任何位置带 lab://、原包路径、案例库路径、exams-hidden、本机路径或裸哈希都拒，报错不回显内容', () => {
  const leaks = {
    'lab-url': 'lab://cases/29/ref.mp4',
    'private-source-path': '原包源码/sample/main.js',
    'case-library-path': '复刻/29/工程/量测结果.txt',
    'hidden-exam-path': 'exams-hidden/9-1.json',
    'local-path': '/Users/someone/private/q.json',
    'bare-sha256': 'a'.repeat(64),
  };
  const windowsPath = 'C:\\ProgramData\\beiming\\q.json';
  const board = buildBoard(matrixInputs());
  for (const [code, text] of [...Object.entries(leaks), ['local-path', windowsPath]]) {
    const spots = [
      { questions: [question('1-1', 1, { title: text })] },
      { questions: [question('1-1', 1, { ext: { deep: [{ note: text }] } })] },      // 看板不读的字段也扫
      { results: [result('1-1', 'three', 'm', 'error', 0, { level: 1, error: text })] },
      { results: [result('1-1', 'three', text, 'pass', 1, { level: 1 })] },
      { cards: [card('a.b', 'time', ['data'], 'read', AS_OF, { provenance: { [text]: 1 } })] },
      { priors: [{ id: 'p', verifiedInOurStack: false, note: text }] },
      { jobs: [{ jobId: text, basePass: true, interventions: 0 }] },
      { history: [{ asOf: '2026-11-01', note: text }] },
    ];
    for (const [i, extra] of spots.entries()) {
      assert.throws(() => buildBoard({ asOf: AS_OF, ...extra }), (e) => {
        assert.ok(isBadArgument(e), `${code} 第 ${i} 处：${e.message}`);
        assert.ok(e.leaks.some((leak) => leak.code === code), `${code} 第 ${i} 处没报出类型`);
        assert.ok(!e.message.includes(text) && !JSON.stringify(e.leaks).includes(text), '报错回显了内容');
        return true;
      });
    }
    assert.throws(() => appendBoardHistory([{ asOf: '2026-11-01', note: text }], board), isBadArgument);
  }
  // 规范写法的哈希放行
  assert.doesNotThrow(() => buildBoard({ asOf: AS_OF, results: [result('1-1', 'three', 'm', 'pass', 1, { level: 1, artifacts: [{ sha256: `sha256:${'a'.repeat(64)}` }] })] }));
});

/* ---------------- 命令行 ---------------- */

const run = (args) => {
  const r = spawnSync(process.execPath, [BOARD, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

test('命令行：从题目、结果、账本、卡、先验的真实文件端到端出 board.json、history.json、index.html', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'beiming-b9-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (rel, value) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  // 题目：仓库里的两道真题，加一份不是题目的 JSON 和一个脚本（都跳过）
  const realQuestion = (file) => JSON.parse(readFileSync(join(REPO, 'beiming/bench/questions', file), 'utf8'));
  const q11 = realQuestion('level-1/01-1.json'), q51 = realQuestion('level-2-b/5-1.json');
  put('questions/level-1/01-1.json', q11);
  put('questions/level-2-b/5-1.json', q51);
  put('questions/level-1/notes.json', { format: 'something-else/1' });
  put('questions/level-1/evaluate.mjs', 'export {};\n');
  // 结果按跑题器的目录形状 <root>/<题号>/<runId>/result.json 落盘。
  const full = (r) => ({ ...r, runId: '20261123-080000-abcdef0-a1', error: null, blockedBy: [], assertions: [], cost: { tokens: 1, turns: 1, toolCalls: 0, wallMs: 5, gpuSeconds: 0 }, overBudget: [], artifacts: [], createdAt: '2026-11-23T08:00:00.000Z' });
  put('runs/1-1/run-a/result.json', full(result('1-1', 'three', 'model-a', 'pass', 1, { level: 1 })));
  put('runs/1-1/run-b/result.json', { ...full(result('1-1', 'blender', 'model-a', 'error', 0, { level: 1 })), error: '交付文件不存在' });
  put('runs/1-1/run-a/meta.json', { kind: 'beiming-bench-run' });
  put('runs/1-1/run-a/observation.json', { runId: 'run-a' });
  // 做题目录是做题方写的：里面冒充的成绩不认
  put('runs/1-1/run-a/worktree/result.json', full(result('1-1', 'three', 'model-a', 'fail', 0, { level: 1, createdAt: '2026-11-24T00:00:00.000Z' })));
  put('runs/9-1/run-h/result.json', { ...full(result('9-1', 'three', 'model-a', 'fail', 0.25, { level: 2, visibility: 'hidden' })), blockedBy: ['[hidden]'] });
  writeFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify(ledgerRow('job-a', 1, 'succeeded'))}\n\n${JSON.stringify(ledgerRow('job-b', 1, 'failed', { seq: 2 }))}\n`);
  put('cards/delivery/encode/card.json', JSON.parse(readFileSync(join(REPO, 'beiming/cards/delivery/encode/card.json'), 'utf8')));
  put('cards/delivery/encode/keys.schema.json', { type: 'object' });
  put('priors/a.json', { format: 'priors/0.1', entries: [{ id: 'p.1', verifiedInOurStack: true }, { id: 'p.2', verifiedInOurStack: false }] });
  put('extra.json', { jobs: [{ jobId: 'job-a', basePass: true, interventions: 0, filmDurationSec: 5 }], harvest: { drafted: 2 } });
  const out = join(dir, 'out');
  const args = (asOf) => ['build', '--as-of', asOf, '--out-dir', out, '--questions-dir', join(dir, 'questions'), '--results-dir', join(dir, 'runs'),
    '--ledger', join(dir, 'ledger.jsonl'), '--cards-dir', join(dir, 'cards'), '--priors', join(dir, 'priors/a.json'), '--extra', join(dir, 'extra.json')];

  const first = run(args('2026-11-22'));
  assert.equal(first.code, 0, first.stderr);
  const summary = JSON.parse(first.stdout.trim());
  assert.equal(first.stdout.trim().split('\n').length, 1);
  assert.deepEqual([summary.format, summary.asOf, summary.questions, summary.results, summary.cards, summary.ledgerRows, summary.priors, summary.historyRows], ['bench-board/0.1', '2026-11-22', 2, 3, 1, 2, 2, 1]);
  const board = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8'));
  assert.deepEqual(board.matrix.rows.map((r) => [r.questionId, r.hidden]), [['1-1', false], ['5-1', false], ['9-1', true]]);
  assert.deepEqual(board.matrix.rows[0].cells.map((c) => [c.status, c.score]), [['error', 0], ['pass', 1]]);   // worktree 里那份没被读
  assert.equal(board.matrix.rows[0].title, q11.title);
  assert.equal(board.fourIndicators.speedAndCost.wallSecPerFilmSec, 60 / 5);
  assert.equal(board.fourIndicators.unattended.rate, 1);
  assert.equal(board.integrationProgress.priorsVerified.verifiedCount, 1);
  assert.equal(board.integrationProgress.harvest.drafted, 2);
  assert.equal(board.integrationProgress.cards.byStatus.reproduced, 1);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(html.includes('2026-11-22') && html.includes(escapeHtml(q11.title)) && html.includes('隐藏题 9-1'));
  assert.ok(!/https?:|<script/i.test(html));
  assert.ok(!(JSON.stringify(board) + html).includes('/Users/'));

  // 第二天再跑：历史多一行；同一天重跑：行数不变
  assert.equal(run(args('2026-11-23')).code, 0);
  assert.equal(run(args('2026-11-23')).code, 0);
  const history = JSON.parse(readFileSync(join(out, 'history.json'), 'utf8'));
  assert.deepEqual(history.map((row) => row.asOf), ['2026-11-22', '2026-11-23']);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')).history, history);

  // 即使字段不展示，本机路径也必须在发布前拦住，保留先前的三份输出。
  const before = readdirSync(out).map((name) => readFileSync(join(out, name), 'utf8'));
  put('runs/1-1/run-b/result.json', { ...full(result('1-1', 'blender', 'model-a', 'error', 0, { level: 1 })), error: 'ENOENT /Users/someone/runs/x' });
  const localResult = run(args('2026-11-24'));
  assert.equal(localResult.code, 2);
  assert.ok(!(localResult.stdout + localResult.stderr).includes('someone'));
  assert.deepEqual(readdirSync(out).map((name) => readFileSync(join(out, name), 'utf8')), before);

  // 用法和坏输入
  assert.equal(run(['build', '--out-dir', out]).code, 0);                                                           // 不写 --as-of 取 UTC 当天
  assert.equal(run(['build', '--as-of', '2026-11-23']).code, 2);
  assert.equal(run(['build', '--as-of', 'today', '--out-dir', out]).code, 2);
  assert.equal(run(['build', '--as-of', '2026-11-23', '--out-dir', out, '--ledger', join(dir, 'missing.jsonl')]).code, 2);
  assert.equal(run(['build', '--as-of', '2026-11-23', '--out-dir', out, '--cards-dir', join(dir, 'missing')]).code, 2);
  put('bad-extra.json', { questions: [] });
  assert.equal(run(['build', '--as-of', '2026-11-23', '--out-dir', out, '--extra', join(dir, 'bad-extra.json')]).code, 2);
  // 题目文件没过 question/0.1 校验：exit 4，不回显内容
  put('bad-questions/x.json', { ...q11, title: 'lab://secret/title' });
  const invalid = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out2'), '--questions-dir', join(dir, 'bad-questions')]);
  assert.equal(invalid.code, 4);
  assert.ok(!invalid.stderr.includes('secret/title') && !existsSync(join(dir, 'out2', 'board.json')));
  // 别的输入里有私有内容（含重复键遮蔽、账本附加栏与坏行）：exit 2，不回显内容、不落盘
  put('leaky-priors.json', { format: 'priors/0.1', entries: [{ id: 'p.1', verifiedInOurStack: false, note: '复刻/29/工程/量测结果.txt' }] });
  const leaky = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out3'), '--priors', join(dir, 'leaky-priors.json')]);
  assert.equal(leaky.code, 2);
  assert.ok(!leaky.stderr.includes('量测结果') && !existsSync(join(dir, 'out3')));
  put('dup-priors.json', '{"format":"priors/0.1","entries":[{"id":"p.1","verifiedInOurStack":true,"note":"lab://secret/dup-hidden","note":"clean"}]}\n');
  const dupLeaky = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out4'), '--priors', join(dir, 'dup-priors.json')]);
  assert.equal(dupLeaky.code, 2);
  assert.ok(!dupLeaky.stderr.includes('dup-hidden') && !existsSync(join(dir, 'out4')));
  put('leaky-ledger.jsonl', `${JSON.stringify({ ...ledgerRow('job-a', 1, 'succeeded'), note: 'lab://secret/ledger-field' })}\n`);
  const ledgerLeak = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out5'), '--ledger', join(dir, 'leaky-ledger.jsonl')]);
  assert.equal(ledgerLeak.code, 2);
  assert.ok(!ledgerLeak.stderr.includes('ledger-field') && !existsSync(join(dir, 'out5')));
  put('bad-ledger.jsonl', 'lab://secret/broken-json-line\n');
  const badLedger = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out6'), '--ledger', join(dir, 'bad-ledger.jsonl')]);
  assert.equal(badLedger.code, 2);
  assert.ok(!badLedger.stderr.includes('broken-json-line') && !existsSync(join(dir, 'out6')));

  // 命令行路径含本机用户路径、exams-hidden、复刻/、lab:// 时，报错绝不回显敏感路径且不落盘
  mkdirSync(join(dir, '复刻/29/questions'), { recursive: true });
  for (const [flag, badPath, token] of [
    ['--extra', '/Users/someone/private-exams-hidden/missing.json', 'someone'],
    ['--extra', '/Users/someone/private-exams-hidden/missing.json', 'exams-hidden'],
    ['--extra', '/Users/someone/normal-missing/extra.json', 'someone'],
    ['--ledger', '/Users/someone/normal-missing/ledger.jsonl', 'someone'],
    ['--cards-dir', '/Users/someone/normal-missing/cards', 'someone'],
    ['--questions-dir', join(dir, '复刻/29/questions'), '复刻'],
    ['--priors', 'lab://cases/29/priors.json', 'lab://'],
  ]) {
    const res = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out-never'), flag, badPath]);
    assert.equal(res.code, 2, `${flag} ${badPath}`);
    assert.ok(!(res.stderr + res.stdout).includes(token), `${flag} 回显了敏感路径：${res.stderr}`);
    assert.ok(!existsSync(join(dir, 'out-never')));
  }
  // 输出目录或输入目录父级是普通文件（触发 ENOTDIR）且路径含敏感本机标记时，报错同样绝不回显路径
  put('home/private/blocker', 'x');
  const blockedOut = join(dir, 'home/private/blocker/out');
  const outFail = run(['build', '--as-of', '2026-11-23', '--out-dir', blockedOut]);
  assert.notEqual(outFail.code, 0);
  assert.ok(!(outFail.stderr + outFail.stdout).includes('/home/') && !(outFail.stderr + outFail.stdout).includes('blocker'), `输出报错回显了路径：${outFail.stderr}`);
  const dirEnotdir = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out-never2'), '--cards-dir', join(dir, 'home/private/blocker/cards')]);
  assert.equal(dirEnotdir.code, 2);
  assert.ok(!(dirEnotdir.stderr + dirEnotdir.stdout).includes('/home/') && !existsSync(join(dir, 'out-never2')));

  // 1) 结果 JSON 重复键遮蔽敏感输入或带私有标记：一律 exit 2 拒收且不落盘
  put('dup-runs/result.json', '{"format":"bench-result/0.1","questionId":"1-1","level":1,"source":"lab://secret-source","source":"three","model":"m","status":"pass","score":1}\n');
  const dupResult = run(['build', '--as-of', '2026-11-23', '--results-dir', join(dir, 'dup-runs'), '--out-dir', join(dir, 'out-dup-res'), '--json']);
  assert.equal(dupResult.code, 2);
  assert.ok(!(dupResult.stderr + dupResult.stdout).includes('secret-source') && !existsSync(join(dir, 'out-dup-res')));

  // 2) 输出目录里目标名已是目录（如 index.html/）时：原子失败，不残留 .partial，也不提前改写 board.json / history.json
  mkdirSync(join(dir, 'out-eisdir/index.html'), { recursive: true });
  const eisdirFail = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out-eisdir')]);
  assert.equal(eisdirFail.code, 2);
  assert.deepEqual(readdirSync(join(dir, 'out-eisdir')), ['index.html']);

  // 3) 输入目录无读权限（EACCES）时：不得静默当成空目录发布 0 数据看板
  if (process.platform !== 'win32' && process.geteuid?.() !== 0) {
    const denied = join(dir, 'home/private/denied-cards');
    mkdirSync(denied, { recursive: true });
    chmodSync(denied, 0o000);
    try {
      const eaccesRes = run(['build', '--as-of', '2026-11-23', '--cards-dir', denied, '--out-dir', join(dir, 'out-eacces')]);
      assert.equal(eaccesRes.code, 2);
      assert.ok(!(eaccesRes.stderr + eaccesRes.stdout).includes('/home/') && !existsSync(join(dir, 'out-eacces')));
    } finally {
      chmodSync(denied, 0o700);
    }
  }

  // 4) 命令行解析期错误（多余位置参数、未知子命令、未知选项）同样绝不回显本机路径或私有标记
  for (const [badArgs, secret] of [
    [['build', '/Users/someone/secret.json', '--out-dir', join(dir, 'out-cli-1')], 'someone/secret.json'],
    [['lab://secret-command'], 'secret-command'],
    [['build', '--lab://secret-flag', '--out-dir', join(dir, 'out-cli-2')], 'secret-flag'],
    [['build', '--help=/Users/someone/secret', '--out-dir', join(dir, 'out-cli-3')], 'someone/secret'],
  ]) {
    const cliErr = run(badArgs);
    assert.equal(cliErr.code, 2, badArgs.join(' '));
    assert.ok(!(cliErr.stderr + cliErr.stdout).includes(secret), `解析期报错回显了敏感内容：${cliErr.stderr}`);
  }

  // 结果文件用 id / hidden / unsupported 别名字段，以及直接读仓库真目录也完全一致
  put('runs2/r1.json', { format: 'bench-result/0.1', id: '9-2', level: 2, source: 'three', model: 'model-a', status: 'fail', score: 0.2, hidden: true });
  put('runs2/r2.json', { format: 'bench-result/0.1', id: '5-1', level: 2, source: 'three', model: 'model-a', status: 'fail', score: 0, unsupported: true });
  put('flat-cards/custom.json', { format: 'card/0.1', id: 'c.flat', kind: 'time', livesIn: ['data'], status: [{ level: 'reproduced', host: 'h', source: 's', gpu: 'g', date: '2026-11-20' }], exams: [] });
  const aliasRun = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out7'), '--results-dir', join(dir, 'runs2'), '--cards-dir', join(dir, 'flat-cards')]);
  assert.equal(aliasRun.code, 0, aliasRun.stderr);
  const aliasBoard = JSON.parse(readFileSync(join(dir, 'out7', 'board.json'), 'utf8'));
  assert.equal(aliasBoard.matrix.rows.find((r) => r.questionId === '9-2').hidden, true);
  assert.equal(aliasBoard.matrix.rows.find((r) => r.questionId === '5-1').cells[0].display, UNSUPPORTED_REASON);
  assert.equal(aliasBoard.integrationProgress.cards.total, 1);

  const repoRun = run(['build', '--as-of', '2026-11-23', '--out-dir', join(dir, 'out-repo'), '--questions-dir', join(REPO, 'beiming/bench/questions'), '--cards-dir', join(REPO, 'beiming/cards'), '--priors', join(REPO, 'beiming/cards/priors-data/audio-subs.json')]);
  assert.equal(repoRun.code, 0, repoRun.stderr);
});

test('并发回填三个日期时保留每一天，三个产物对应同一版历史', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'beiming-b9-days-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const days = ['2026-11-10', '2026-11-11', '2026-11-12'];
  const exec = promisify(execFile);
  await Promise.all(days.map((date) => exec(process.execPath, [BOARD, 'build', '--out-dir', dir, '--as-of', date])));
  const board = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'));
  assert.deepEqual(board.history.map((r) => r.asOf), days);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')), board.history);
  assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), renderBoardHtml(board));
  assert.deepEqual(readdirSync(dir).sort(), ['board.json', 'history.json', 'index.html']);
});

test('入口 index.mjs 导出看板的公开接口', () => {
  for (const name of ['buildBoard', 'renderBoardHtml', 'appendBoardHistory']) assert.equal(bench[name], { buildBoard, renderBoardHtml, appendBoardHistory }[name]);
  assert.deepEqual([bench.BOARD_FORMAT, bench.UNSUPPORTED_REASON, bench.TOTAL_PRIORS_BASELINE], ['bench-board/0.1', '这个帧源没有这项能力', 4452]);
});
