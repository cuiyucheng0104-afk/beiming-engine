import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runExam } from './exam.mjs';
import {
  loadM4Gates,
  scoreSteppingStone,
  validSteppingStoneReading,
} from './questions/level-4/evaluate-b18.mjs';
import {
  buildSteppingStoneReading,
  readSteppingStoneFilm,
  runSteppingStoneControls,
} from './solutions/level-4/run-b18.mjs';
import {
  discoverQuestions,
  discoverSuiteQuestions,
  planFullExam2,
  planFullExam3,
  runFullExam3,
} from './suite.mjs';
import {
  projectPublicQuestion,
  scanQuestionLeaks,
  validateQuestion,
} from './validate-question.mjs';

const BENCH_DIR = import.meta.dirname;
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(BENCH_DIR, ...parts), 'utf8'));
const readText = (...parts) => fs.readFileSync(path.join(BENCH_DIR, ...parts), 'utf8');

const STEPPING_STONES = [
  [
    '41-1',
    'M4-SS1',
    'stepping_stone_1_post_chain',
    ['three.patch', 'post.ao', 'post.bloom', 'post.volumetric', 'post.grade-cl', 'deliver.encode'],
    [],
  ],
  [
    '41-2',
    'M4-SS2',
    'stepping_stone_2_dragon_spine',
    ['motion.sweep-body', 'motion.roll-bank', 'motion.swim', 'motion.impulse', 'deliver.encode'],
    [],
  ],
  [
    '41-3',
    'M4-SS3',
    'stepping_stone_3_particle_replay',
    ['particle.premult', 'particle.soft', 'particle.minpx', 'fx.breath', 'light.emit-pool', 'time.bake', 'deliver.encode'],
    ['fx.breath:drag-10%', 'fx.breath:drag+10%'],
  ],
];

const FORBIDDEN_THRESHOLD_NUMBERS = new Set([50, 0.00316228, 0.1, 0.01, 0.5, 1, 0.03, 0.15, 0.2]);
const FORBIDDEN_TEXT_PATTERNS = [
  /\b50(?:\.0+)?\s*dB\b/i,
  /\b0\.00316228\b/,
  /\b0\.1\s*%/,
  /\b0\.01\s*m\b/i,
  /\b1\s*cm\b/i,
  /1\s*厘米/,
  /\b0\.5\s*(?:deg|度)/i,
  /\b1(?:\.0+)?\s*(?:px|像素)/i,
];

function collectNumbers(value, pathPrefix = '', out = []) {
  if (typeof value === 'number') {
    out.push({ path: pathPrefix, value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectNumbers(v, `${pathPrefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      collectNumbers(v, pathPrefix ? `${pathPrefix}.${k}` : k, out);
    }
  }
  return out;
}

test('B18-1: 单一公开阈值源 gates-m4.json 锁定四道门数值、FX16 策略与零泄露', () => {
  const raw = readText('questions', 'level-4', 'gates-m4.json');
  assert.deepEqual(scanQuestionLeaks(raw), []);
  const parsed = JSON.parse(raw);
  assert.deepEqual(scanQuestionLeaks(parsed), []);
  assert.equal(parsed.source, 'spec-05-sec4-l10-locked');
  assert.equal(parsed.lockPolicy, 'FX16');

  const gates = loadM4Gates();
  assert.equal(gates.source, 'spec-05-sec4-l10-locked');
  assert.equal(gates.lockPolicy, 'FX16');
  assert.deepEqual(gates.stepping_stone_1_post_chain, {
    finalSrgbPsnrMinDb: 50,
    finalSrgbRmseMax: 0.00316228,
    finalSrgbDiffGe5PxRatioMaxPct: 0.1,
  });
  assert.deepEqual(gates.stepping_stone_2_dragon_spine, {
    positionRmseMaxM: 0.01,
    maxTwistJumpErrorDeg: 0.5,
  });
  assert.deepEqual(gates.stepping_stone_3_particle_replay, {
    screenPosErrorMaxPx: 1,
  });
  assert.deepEqual(gates.full_shot_fire_breath, {
    peakPositionMaxRelError: 0.03,
    plumeLengthMaxRelError: 0.1,
    bloomRadiusMaxRelError: 0.15,
    fireVigorMaxRelError: 0.2,
  });
});

for (const [id, code, gateRef, expectedNeeds, extraNegatives] of STEPPING_STONES) {
  test(`B18-2 (${id}/${code}): 题目文件过 validateQuestion/零泄露，通过 gateRef 引用 gates-m4.json 且题目内绝不硬编码门限数字`, () => {
    const raw = readText('questions', 'level-4', `${id}.json`);
    const rawCheck = validateQuestion(raw);
    assert.equal(rawCheck.ok, true, JSON.stringify(rawCheck));
    const question = JSON.parse(raw);
    const objCheck = validateQuestion(question);
    assert.equal(objCheck.ok, true, JSON.stringify(objCheck));
    assert.deepEqual(scanQuestionLeaks(raw), []);
    assert.deepEqual(scanQuestionLeaks(question), []);

    assert.equal(question.id, id);
    assert.equal(question.level, 4);
    assert.equal(question.ext['bench.code'], code);
    assert.equal(question.ext['bench.steppingStone'], true);
    assert.deepEqual(question.needs, expectedNeeds);
    assert.ok(question.refs.includes('bench/questions/level-4/gates-m4.json'));
    assert.ok(question.refs.includes(`bench/refs/level-4/${id}.json`));

    const pub = projectPublicQuestion(question);
    assert.equal('ext' in pub, false);

    // 断言题目 scoring[].args 仅通过 gateRef 引用门表，不含任何硬编码数值
    const gateItems = question.scoring.filter((s) => s.metric !== 'deliver.spec');
    assert.ok(gateItems.length >= 3);
    for (const item of gateItems) {
      assert.equal(item.args?.gateRef, gateRef, `${id} ${item.metric} 必须通过 gateRef 引用 ${gateRef}`);
      const argNums = collectNumbers(item.args, item.metric);
      assert.deepEqual(argNums, [], `${id} ${item.metric}.args 内不得硬编码任何数字阈值: ${JSON.stringify(argNums)}`);
    }

    // 断言题目 scoring 权重与文本均不重复写锁定门限数字
    for (const item of question.scoring) {
      assert.equal(FORBIDDEN_THRESHOLD_NUMBERS.has(item.weight), false, `${id} weight 不得与门限数字重合`);
    }
    const textToScan = [
      question.title,
      question.brief,
      ...question.scoring.map((s) => s.pass),
      question.controls.referencePass,
      question.controls.negative,
    ].join('\n');
    for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
      assert.doesNotMatch(textToScan, pattern, `${id} 题面文本不得硬编码门限数字 (${pattern})`);
    }
  });

  test(`B18-3 (${id}/${code}): 标准答案 film/3.0 与参考夹具满分 1.00，逐卡关闭/扰动负对照全部判红`, () => {
    const question = readJson('questions', 'level-4', `${id}.json`);
    const film = readSteppingStoneFilm(question);
    assert.deepEqual(film.output, {
      size: question.deliverable.size,
      fps: question.deliverable.fps,
      frames: question.deliverable.frames,
    });

    const ref = readJson('refs', 'level-4', `${id}.json`);
    assert.equal(ref.question, id);
    assert.equal(ref.kind, 'reference');
    assert.deepEqual(scanQuestionLeaks(ref), []);
    const refVerdict = scoreSteppingStone(question, ref.readings);
    assert.equal(refVerdict.valid, true);
    assert.equal(refVerdict.pass, true);
    assert.equal(refVerdict.score, 1);

    const { positive, negatives } = runSteppingStoneControls(question);
    assert.equal(positive.valid, true);
    assert.equal(positive.pass, true);
    assert.equal(positive.score, 1);

    const expectedControlKeys = [...expectedNeeds, ...extraNegatives].sort();
    assert.deepEqual(Object.keys(negatives).sort(), expectedControlKeys);
    for (const [control, verdict] of Object.entries(negatives)) {
      assert.equal(verdict.valid, true, `${id}/${control} 负对照读数结构应合法`);
      assert.equal(verdict.pass, false, `${id}/${control} 负对照必须 pass === false`);
      assert.ok(verdict.score < 1, `${id}/${control} 负对照必须 score < 1，实测 ${verdict.score}`);
    }
  });
}

test('B18-4: 动态修改 gates-m4.json 阈值实时改变三道垫脚题的判分结论', () => {
  // 1) 41-1：对带 1 级微扰（PSNR ~52.9 dB, RMSE ~0.00226, >=5/255 = 0%）的读数，默认 50 dB 门限通过；动态收紧至 58 dB 或放宽负对照门限实时翻转结论
  const q1 = readJson('questions', 'level-4', '41-1.json');
  const r1 = buildSteppingStoneReading(q1);
  const buf0 = Buffer.from(r1.frames[0].candSrgb, 'base64');
  for (let i = 0; i < buf0.length; i += 3) {
    buf0[i] = buf0[i] < 255 ? buf0[i] + 1 : buf0[i] - 1;
  }
  r1.frames[0].candSrgb = buf0.toString('base64');
  assert.equal(scoreSteppingStone(q1, r1).pass, true);

  const tightGates1 = loadM4Gates({
    stepping_stone_1_post_chain: {
      finalSrgbPsnrMinDb: 58,
      finalSrgbRmseMax: 0.001,
      finalSrgbDiffGe5PxRatioMaxPct: 0.1,
    },
  });
  const v1Tight = scoreSteppingStone(q1, r1, { gates: tightGates1 });
  assert.equal(v1Tight.pass, false);
  assert.ok(v1Tight.score < 1);

  // 2) 41-2：对 5 毫米（0.005 m）微偏移与 0.25 度扭转微扰，默认门限（0.01 m / 0.5 deg）通过；动态收紧至 0.002 m 或 0.1 deg 实时判红
  const q2 = readJson('questions', 'level-4', '41-2.json');
  const r2 = buildSteppingStoneReading(q2);
  r2.frames[0].candPositions = r2.frames[0].candPositions.map(([x, y, z]) => [x + 0.005, y, z]);
  assert.equal(scoreSteppingStone(q2, r2).pass, true);

  const tightGates2 = loadM4Gates({
    stepping_stone_2_dragon_spine: {
      positionRmseMaxM: 0.002,
      maxTwistJumpErrorDeg: 0.5,
    },
  });
  const v2Tight = scoreSteppingStone(q2, r2, { gates: tightGates2 });
  assert.equal(v2Tight.pass, false);
  assert.ok(v2Tight.score < 1);

  // 3) 41-3：对 0.45 px 屏幕微偏移，默认门限（1 px）通过；动态收紧至 0.2 px 实时判红
  const q3 = readJson('questions', 'level-4', '41-3.json');
  const r3 = buildSteppingStoneReading(q3);
  for (const pt of r3.frames[0].layers.fire) {
    pt.candPx = [pt.candPx[0] + 0.45, pt.candPx[1]];
    pt.randomAccessPx = [...pt.candPx];
  }
  assert.equal(scoreSteppingStone(q3, r3).pass, true);

  const tightGates3 = loadM4Gates({
    stepping_stone_3_particle_replay: {
      screenPosErrorMaxPx: 0.2,
    },
  });
  const v3Tight = scoreSteppingStone(q3, r3, { gates: tightGates3 });
  assert.equal(v3Tight.pass, false);
  assert.ok(v3Tight.score < 1);
});

test('B18-5: 严防空洞数组、缺帧、NaN 与自报极值作弊', () => {
  for (const [id, corrupt] of [
    ['41-1', (r) => { delete r.frames[2]; }],
    ['41-1', (r) => { r.frames[0].candSrgb = 'invalid-base64!'; }],
    ['41-1', (r) => { r.frames[0].refSrgb = Buffer.alloc(48 * 27 * 3, 128).toString('base64'); }],
    ['41-2', (r) => { delete r.frames[5]; }],
    ['41-2', (r) => { r.frames[0].candPositions[0][0] = NaN; }],
    ['41-2', (r) => { r.frames[0].bounds = [0.8, 0.8, 0.2, 0.2]; }],
    ['41-3', (r) => { delete r.frames[3]; }],
    ['41-3', (r) => { r.frames[0].layers.fire[0].candPx[0] = NaN; }],
  ]) {
    const q = readJson('questions', 'level-4', `${id}.json`);
    const r = buildSteppingStoneReading(q);
    corrupt(r);
    r.pass = true;
    r.score = 1;
    assert.equal(validSteppingStoneReading(q, r), false, `${id} 损坏读数应被拒收`);
    const verdict = scoreSteppingStone(q, r);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.score, 0);
  }
});

test('B18-6: exam.mjs 纳入 level-4 三道垫脚题（18 道公开题全过 + 5 道 expected-fail 跳过）', async () => {
  const report = await runExam({ outDir: null });
  assert.equal(report.ok, true, JSON.stringify(report.error));
  assert.equal(report.exitCode, 0);
  assert.equal(report.summary.passedQuestions, 18);
  assert.equal(report.summary.evaluatedQuestions, 18);
  assert.equal(report.summary.skippedQuestions, 5);
  assert.equal(report.summary.totalQuestions, 23);
  for (const [id] of STEPPING_STONES) {
    const qReport = report.questions.find((q) => q.id === id);
    assert.ok(qReport, `exam 报告缺少 ${id}`);
    assert.equal(qReport.pass, true);
    assert.equal(qReport.score, 1);
    assert.ok(qReport.negativeControlsChecked >= 5);
    assert.equal(qReport.negativeControlsRejected, qReport.negativeControlsChecked);
  }
});

test('B18-7: suite.mjs 保持 full-2 23 场不变，新增 full-3 精确 26 场计分实考与看板零泄露落盘', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-b18-suite-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hiddenDir = path.join(root, 'private-bank');
  const boardDir = path.join(root, 'board');
  fs.mkdirSync(hiddenDir);
  const marker = 'private-b18-hidden-marker';
  for (const id of ['91-1', '92-1', '93-1']) {
    const q = { ...readJson('questions', 'level-1', '01-1.json'), id, title: marker, brief: marker, refs: [] };
    q.flags.hidden = true;
    fs.writeFileSync(path.join(hiddenDir, `${id}.json`), JSON.stringify(q));
  }

  const questionsDir = path.join(BENCH_DIR, 'questions');
  assert.equal(discoverQuestions(questionsDir).publicQuestions.length, 12);
  const bank = discoverSuiteQuestions({ questionsDir, hiddenDir });
  assert.equal(bank.publicQuestions.length, 12);
  assert.equal(bank.level3Questions.length, 3);
  assert.equal(bank.level4Questions.length, 3);

  const models = ['family-a', 'family-b'];
  const asOf = '2026-11-26';

  // full-2 保持精确 23 场不变
  const plan2 = planFullExam2({ ...bank, models, asOf });
  assert.equal(plan2.scoredRunCount, 23);

  // full-3 = full-2 (23) + 3 道垫脚题 (41-1, 41-2, 41-3) = 精确 26 场
  const plan3 = planFullExam3({ ...bank, models, asOf });
  assert.equal(plan3.kind, 'full-3');
  assert.equal(plan3.scoredRunCount, 26);
  assert.equal(plan3.publicRunCount, 23);
  assert.equal(plan3.hiddenRunCount, 3);
  assert.equal(plan3.steppingStoneRunCount, 3);
  assert.deepEqual(
    plan3.runs.slice(20, 23).map((r) => [r.questionId, r.level, r.source]),
    [
      ['41-1', 4, 'three'],
      ['41-2', 4, 'three'],
      ['41-3', 4, 'three'],
    ],
  );
  assert.deepEqual(plan3.runs.slice(23).map((r) => r.questionId), ['91-1', '92-1', '93-1']);

  const calls = [];
  const res3 = await runFullExam3({
    questionsDir,
    hiddenDir,
    boardDir,
    models,
    asOf,
    evalRoot: path.join(root, 'eval-full3'),
    solver: ({ questionFile }) => {
      calls.push(JSON.parse(fs.readFileSync(questionFile, 'utf8')).id);
      return { tokens: 100 };
    },
    judge: ({ question }) => ({
      metrics: Object.fromEntries(question.scoring.map((s) => [s.metric, { pass: true }])),
      predicates: Object.fromEntries(question.basePredicates.map((p) => [p, true])),
    }),
  });
  assert.equal(calls.length, 26);
  assert.equal(res3.summary.scoredRuns, 26);
  assert.equal(res3.summary.passedRuns, 26);
  assert.equal(res3.summary.expectedFailRuns, 5);
  assert.equal(res3.results.length, 31);
  for (const file of Object.values(res3.outputs)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(marker) && !text.includes(root) && !text.includes(hiddenDir));
  }

  const cli = spawnSync(process.execPath, [path.join(BENCH_DIR, 'suite.mjs'), 'full-3', '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /26/);
});
