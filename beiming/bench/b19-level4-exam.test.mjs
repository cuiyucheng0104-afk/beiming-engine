import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { evaluate as evaluateGradeCl } from '../cards/post/grade-cl/comp.mjs';
import { bakeTrajectory, queryBakedTable } from '../cards/time/bake/index.mjs';
import { evaluateBasePredicates, runExam } from './exam.mjs';
import {
  argsOf as argsOfB2,
  readClosure,
  readNearest,
  score as scoreLevel1,
} from './questions/level-1/evaluate-b2.mjs';
import { scoreLevel3 } from './questions/level-3/evaluate-b17.mjs';
import {
  loadM4Gates,
  scoreLevel4Shot,
  validLevel4ShotReading,
} from './questions/level-4/evaluate-b19.mjs';
import {
  buildLevel4ShotReading,
  readLevel4ShotFilm,
  runLevel4ShotControls,
} from './solutions/level-4/run-b19.mjs';
import {
  B19_LEVEL4_SHOT_IDS,
  discoverQuestions,
  discoverSuiteQuestions,
  planFullExam1,
  planFullExam2,
  planFullExam3,
  planFullExam4,
  runFullExam4,
} from './suite.mjs';
import {
  projectPublicQuestion,
  scanQuestionLeaks,
  validateQuestion,
} from './validate-question.mjs';

const BENCH_DIR = import.meta.dirname;
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(BENCH_DIR, ...parts), 'utf8'));
const readText = (...parts) => fs.readFileSync(path.join(BENCH_DIR, ...parts), 'utf8');

const EXPECTED_NEEDS = [
  'fx.breath',
  'motion.sweep-body',
  'motion.roll-bank',
  'post.ao',
  'post.bloom',
  'post.volumetric',
  'post.grade-cl',
  'light.emit-pool',
  'deliver.encode',
];

const FORBIDDEN_TEXT_PATTERNS = [
  /\b0\.03\b/,
  /\b0\.10?\b/,
  /\b0\.15\b/,
  /\b0\.20?\b/,
  /\b3(?:\.0+)?\s*%/,
  /\b10(?:\.0+)?\s*%/,
  /\b15(?:\.0+)?\s*%/,
  /\b20(?:\.0+)?\s*%/,
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

test('B19-1: 公开第 4 级整镜题 42-1.json 过 validateQuestion/零泄露，全部四特征通过 gateRef 引用 gates-m4.json 且题目内零硬编码阈值数字', () => {
  const raw = readText('questions', 'level-4', '42-1.json');
  const rawCheck = validateQuestion(raw);
  assert.equal(rawCheck.ok, true, JSON.stringify(rawCheck));
  const question = JSON.parse(raw);
  const objCheck = validateQuestion(question);
  assert.equal(objCheck.ok, true, JSON.stringify(objCheck));
  assert.deepEqual(scanQuestionLeaks(raw), []);
  assert.deepEqual(scanQuestionLeaks(question), []);

  assert.equal(question.id, '42-1');
  assert.equal(question.level, 4);
  assert.deepEqual(question.deliverable, {
    size: [1920, 1080],
    fps: '60/1',
    frames: 96,
    audio: 'none',
  });
  assert.equal(question.ext['bench.code'], 'M4-SHOT');
  assert.equal(question.ext['bench.fullShot'], true);
  assert.deepEqual(question.needs, EXPECTED_NEEDS);
  assert.deepEqual(question.budget, { tokens: 1800000, wallMs: 2400000, gpuSeconds: 300 });
  assert.ok(question.refs.includes('bench/refs/level-4/42-1.json'));
  assert.ok(question.refs.includes('bench/questions/level-4/gates-m4.json'));

  const pub = projectPublicQuestion(question);
  assert.equal('ext' in pub, false);

  const gateItems = question.scoring.filter((s) => s.metric !== 'deliver.spec');
  assert.equal(gateItems.length, 4);
  for (const item of gateItems) {
    assert.equal(item.args?.gateRef, 'full_shot_fire_breath', `${item.metric} 必须引用 full_shot_fire_breath`);
    const argNums = collectNumbers(item.args, item.metric);
    assert.deepEqual(argNums, [], `${item.metric}.args 内不得硬编码任何阈值数字: ${JSON.stringify(argNums)}`);
  }

  const textToScan = [
    question.title,
    question.brief,
    ...question.scoring.map((s) => s.pass),
    question.controls.referencePass,
    question.controls.negative,
    question.calibration.source,
  ].join('\n');
  for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
    assert.doesNotMatch(textToScan, pattern, `42-1 题面文本不得硬编码门限数字 (${pattern})`);
  }
});

test('B19-2: 标准答案 42-1/film.json 与参考夹具满分 1.00，9 项逐卡关闭负对照全部判红', () => {
  const question = readJson('questions', 'level-4', '42-1.json');
  const film = readLevel4ShotFilm(question);
  assert.deepEqual(film.output, {
    size: question.deliverable.size,
    fps: question.deliverable.fps,
    frames: question.deliverable.frames,
  });

  const ref = readJson('refs', 'level-4', '42-1.json');
  assert.equal(ref.question, '42-1');
  assert.equal(ref.kind, 'reference');
  assert.deepEqual(scanQuestionLeaks(ref), []);
  const refVerdict = scoreLevel4Shot(question, ref.readings);
  assert.equal(refVerdict.valid, true);
  assert.equal(refVerdict.pass, true);
  assert.equal(refVerdict.score, 1);

  const { positive, negatives } = runLevel4ShotControls(question);
  assert.equal(positive.valid, true);
  assert.equal(positive.pass, true);
  assert.equal(positive.score, 1);

  assert.deepEqual(Object.keys(negatives).sort(), [...EXPECTED_NEEDS].sort());
  for (const [control, verdict] of Object.entries(negatives)) {
    assert.equal(verdict.valid, true, `42-1/${control} 负对照读数结构应合法`);
    assert.equal(verdict.pass, false, `42-1/${control} 负对照必须 pass === false`);
    assert.ok(verdict.score < 1, `42-1/${control} 负对照必须 score < 1，实测 ${verdict.score}`);
  }
});

test('B19-3: 动态修改 gates-m4.json#full_shot_fire_breath 四项阈值实时改变判分结论', () => {
  const q = readJson('questions', 'level-4', '42-1.json');
  const [W] = q.deliverable.size;

  // 1) peakPositionMaxRelError：微移 1.5% 画幅宽度（默认 0.03 通过，收紧至 0.008 判红）
  const rPeak = buildLevel4ShotReading(q);
  rPeak.frames[0].candPeakPx = [rPeak.frames[0].refPeakPx[0] + W * 0.015, rPeak.frames[0].refPeakPx[1]];
  assert.equal(scoreLevel4Shot(q, rPeak).pass, true);
  const tightPeak = loadM4Gates({ full_shot_fire_breath: { peakPositionMaxRelError: 0.008 } });
  const vPeak = scoreLevel4Shot(q, rPeak, { gates: tightPeak });
  assert.equal(vPeak.pass, false);
  assert.equal(vPeak.items.find((it) => it.metric === 'shot.peak-position').pass, false);

  // 2) plumeLengthMaxRelError：长度拉伸 5%（默认 0.10 通过，收紧至 0.02 判红）
  const rLen = buildLevel4ShotReading(q);
  const refSpan = rLen.frames[0].refSpanMaxPx - rLen.frames[0].refSpanMinPx;
  rLen.frames[0].candSpanMaxPx = rLen.frames[0].candSpanMinPx + refSpan * 1.05;
  rLen.frames[0].candPlumeLengthPx = refSpan * 1.05;
  assert.equal(scoreLevel4Shot(q, rLen).pass, true);
  const tightLen = loadM4Gates({ full_shot_fire_breath: { plumeLengthMaxRelError: 0.02 } });
  const vLen = scoreLevel4Shot(q, rLen, { gates: tightLen });
  assert.equal(vLen.pass, false);
  assert.equal(vLen.items.find((it) => it.metric === 'shot.plume-length').pass, false);

  // 3) bloomRadiusMaxRelError：泛光半径放大 8%（默认 0.15 通过，收紧至 0.04 判红）
  const rBloom = buildLevel4ShotReading(q);
  rBloom.frames[0].candBloomRadiusPx = rBloom.frames[0].refBloomRadiusPx * 1.08;
  rBloom.frames[0].candBloomMoments.transverseSqSum = rBloom.frames[0].refBloomMoments.transverseSqSum * (1.08 ** 2);
  assert.equal(scoreLevel4Shot(q, rBloom).pass, true);
  const tightBloom = loadM4Gates({ full_shot_fire_breath: { bloomRadiusMaxRelError: 0.04 } });
  const vBloom = scoreLevel4Shot(q, rBloom, { gates: tightBloom });
  assert.equal(vBloom.pass, false);
  assert.equal(vBloom.items.find((it) => it.metric === 'shot.bloom-radius').pass, false);

  // 4) fireVigorMaxRelError：帧间活力偏移 10%（默认 0.20 通过，收紧至 0.05 判红）
  const rVigor = buildLevel4ShotReading(q);
  for (const vp of rVigor.vigorPairs) {
    vp.candHdrDelta = vp.refHdrDelta * 1.10;
    vp.candFinalDelta = vp.refFinalDelta * 1.10;
  }
  assert.equal(scoreLevel4Shot(q, rVigor).pass, true);
  const tightVigor = loadM4Gates({ full_shot_fire_breath: { fireVigorMaxRelError: 0.05 } });
  const vVigor = scoreLevel4Shot(q, rVigor, { gates: tightVigor });
  assert.equal(vVigor.pass, false);
  assert.equal(vVigor.items.find((it) => it.metric === 'shot.fire-vigor').pass, false);
});

test('B19-4: 严防空洞数组、缺帧、NaN、倒置包围盒与自报极值作弊', () => {
  const q = readJson('questions', 'level-4', '42-1.json');
  for (const [label, corrupt] of [
    ['sparse-frame-hole', (r) => { delete r.frames[3]; }],
    ['missing-vigor-pair', (r) => { r.vigorPairs.pop(); }],
    ['nan-peak-px', (r) => { r.frames[0].candPeakPx[0] = NaN; }],
    ['zero-plume-len', (r) => { r.frames[1].candPlumeLengthPx = 0; }],
    ['inverted-span', (r) => { r.frames[2].candSpanMaxPx = r.frames[2].candSpanMinPx - 5; }],
    ['invalid-bounds', (r) => { r.frames[0].bounds = [0.9, 0.9, 0.1, 0.1]; }],
    ['bad-cand-srgb', (r) => { r.frames[0].candSrgb = 'not-valid-base64!'; }],
    ['nan-vigor-delta', (r) => { r.vigorPairs[0].candHdrDelta = NaN; }],
  ]) {
    const r = buildLevel4ShotReading(q);
    corrupt(r);
    r.pass = true;
    r.score = 1;
    assert.equal(validLevel4ShotReading(q, r), false, `损坏读数 (${label}) 应被拒收`);
    const verdict = scoreLevel4Shot(q, r);
    assert.equal(verdict.valid, false, label);
    assert.equal(verdict.pass, false, label);
    assert.equal(verdict.score, 0, label);
  }
});

test('B19-5: exam.mjs 纳入 42-1（19 道公开实评题全过 + 5 道 expected-fail 跳过）', async () => {
  const report = await runExam({ outDir: null });
  assert.equal(report.ok, true, JSON.stringify(report.error));
  assert.equal(report.exitCode, 0);
  assert.equal(report.summary.evaluatedQuestions, 19);
  assert.equal(report.summary.passedQuestions, 19);
  assert.equal(report.summary.skippedQuestions, 5);
  assert.equal(report.summary.totalQuestions, 24);

  const q42 = report.questions.find((q) => q.id === '42-1');
  assert.ok(q42, 'exam 报告缺少 42-1');
  assert.equal(q42.pass, true);
  assert.equal(q42.score, 1);
  assert.equal(q42.negativeControlsChecked, 9);
  assert.equal(q42.negativeControlsRejected, 9);
});

test('B19-6: suite.mjs 保持 full-1(27)/full-2(23)/full-3(26) 零回归，新增 full-4 精确 28 场计分与看板零泄露', async (t) => {
  assert.deepEqual(B19_LEVEL4_SHOT_IDS, ['42-1']);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-b19-suite-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hiddenDir = path.join(root, 'private-bank');
  const boardDir = path.join(root, 'board');
  fs.mkdirSync(hiddenDir);

  const marker = 'private-b19-hidden-canary';
  // 放入 4 道 L1/L2 隐藏题 + 1 道 L4 隐藏变体（虚拟题号 94-101，绝不写死真实隐藏题号）
  for (const [id, level] of [['91-1', 1], ['92-1', 1], ['93-1', 2], ['93-2', 2]]) {
    const q = { ...readJson('questions', 'level-1', '01-1.json'), id, level, title: marker, brief: marker, refs: [] };
    q.flags = { hidden: true, expectedFail: false, blockedBy: [] };
    fs.writeFileSync(path.join(hiddenDir, `${id}.json`), JSON.stringify(q));
  }
  const hiddenL4 = {
    ...readJson('questions', 'level-4', '42-1.json'),
    id: '94-101',
    level: 4,
    title: `${marker}-L4`,
    brief: `${marker}-L4-brief`,
    deliverable: { size: [1280, 720], fps: '60/1', frames: 72, audio: 'none' },
    basePredicates: [
      'delivery(width=1280, height=720, fps=60, frames=72)',
      'no_cut',
      'inside_frame(hero) @ all',
      'encoded_readback',
    ],
    flags: { hidden: true, expectedFail: false, blockedBy: [] },
    ext: { 'bench.variantOf': '42-1', 'bench.code': 'M4-SHOT-HIDDEN' },
  };
  delete hiddenL4.refs;
  fs.writeFileSync(path.join(hiddenDir, '94-101.json'), JSON.stringify(hiddenL4));

  const questionsDir = path.join(BENCH_DIR, 'questions');
  assert.equal(discoverQuestions(questionsDir).publicQuestions.length, 12);
  const bank = discoverSuiteQuestions({ questionsDir, hiddenDir });
  assert.equal(bank.publicQuestions.length, 12);
  assert.equal(bank.level3Questions.length, 3);
  assert.equal(bank.level4Questions.length, 3);
  assert.equal(bank.level4ShotQuestions.length, 1);
  assert.equal(bank.hiddenQuestions.length, 5);

  const models = ['family-a', 'family-b'];
  const asOf = '2026-11-26';

  // full-1(27)、full-2(23)、full-3(26) 均只从 level < 4 隐藏池抽取 3 道，绝不被 L4 隐藏题冲乱
  const plan1 = planFullExam1({ ...bank, models, asOf });
  assert.equal(plan1.scoredRunCount, 27);
  assert.deepEqual(plan1.runs.filter((r) => r.visibility === 'hidden').map((r) => r.questionId), ['91-1', '92-1', '93-1']);

  const plan2 = planFullExam2({ ...bank, models, asOf });
  assert.equal(plan2.scoredRunCount, 23);
  assert.deepEqual(plan2.runs.filter((r) => r.visibility === 'hidden').map((r) => r.questionId), ['91-1', '92-1', '93-1']);

  const plan3 = planFullExam3({ ...bank, models, asOf });
  assert.equal(plan3.scoredRunCount, 26);
  assert.deepEqual(plan3.runs.filter((r) => r.visibility === 'hidden').map((r) => r.questionId), ['91-1', '92-1', '93-1']);

  // full-4 = full-3 (26) + 42-1 (1) + L4 隐藏变体 (1) = 精确 28 场
  const plan4 = planFullExam4({ ...bank, models, asOf });
  assert.equal(plan4.kind, 'full-4');
  assert.equal(plan4.scoredRunCount, 28);
  assert.equal(plan4.publicRunCount, 24);
  assert.equal(plan4.hiddenRunCount, 4);
  assert.equal(plan4.steppingStoneRunCount, 3);
  assert.equal(plan4.level4ShotRunCount, 1);
  assert.equal(plan4.level4HiddenRunCount, 1);
  assert.deepEqual(
    plan4.runs.slice(20, 24).map((r) => [r.questionId, r.level, r.visibility, r.model, r.source]),
    [
      ['41-1', 4, 'public', 'family-a', 'three'],
      ['41-2', 4, 'public', 'family-a', 'three'],
      ['41-3', 4, 'public', 'family-a', 'three'],
      ['42-1', 4, 'public', 'family-a', 'three'],
    ],
  );
  assert.deepEqual(
    plan4.runs.slice(24).map((r) => [r.questionId, r.level, r.visibility, r.model]),
    [
      ['91-1', 1, 'hidden', 'family-a'],
      ['92-1', 1, 'hidden', 'family-a'],
      ['93-1', 2, 'hidden', 'family-a'],
      ['94-101', 4, 'hidden', 'family-a'],
    ],
  );

  const calls = [];
  const res4 = await runFullExam4({
    questionsDir,
    hiddenDir,
    boardDir,
    models,
    asOf,
    evalRoot: path.join(root, 'eval-full4'),
    solver: ({ questionFile }) => {
      calls.push(JSON.parse(fs.readFileSync(questionFile, 'utf8')).id);
      return { tokens: 100 };
    },
    judge: ({ question }) => ({
      metrics: Object.fromEntries(question.scoring.map((s) => [s.metric, { pass: true }])),
      predicates: Object.fromEntries(question.basePredicates.map((p) => [p, true])),
    }),
  });
  assert.equal(calls.length, 28);
  assert.equal(res4.summary.scoredRuns, 28);
  assert.equal(res4.summary.passedRuns, 28);
  assert.equal(res4.summary.hiddenRuns, 4);
  assert.equal(res4.summary.expectedFailRuns, 5);
  assert.equal(res4.results.length, 33);
  for (const file of Object.values(res4.outputs)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(marker) && !text.includes(root) && !text.includes(hiddenDir));
  }

  const cli = spawnSync(process.execPath, [path.join(BENCH_DIR, 'suite.mjs'), 'full-4', '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /28/);
});

test('B19-7 (FX15): M4 技术卡 post.grade-cl 与 time.bake 跨题复用真实提升非 M4 考题 1-2 与 23-1 得分（Δscore > 0）', () => {
  // 实证 1：M4 卡 post.grade-cl 跨题复用于三级题 1-2（多材质显卡模块单镜爆炸拆解）
  const q12 = readJson('questions', 'level-3', '1-2.json');
  const ref12 = readJson('refs', 'level-3', '1-2.json').readings;
  const w12 = 48;
  const h12 = 27;
  const nPx12 = w12 * h12;

  const before12 = globalThis.structuredClone(ref12);
  const after12 = globalThis.structuredClone(ref12);
  let beforeMaxClipRatio = 0;
  let afterMaxClipRatio = 0;

  for (let fIdx = 0; fIdx < q12.deliverable.frames; fIdx++) {
    const maskBuf = Buffer.from(ref12.frames[fIdx].materialMask, 'base64');
    const hdrData = new Float32Array(nPx12 * 4);
    const ungradedLuma = Buffer.alloc(nPx12);

    for (let p = 0; p < nPx12; p++) {
      const id = maskBuf[p];
      // 线性 HDR 棚光爆炸场景：发光件(1)与金属件高光(2)在线性空间均超过 1.0，背景顶部存在棚灯高光反光区
      const row = Math.floor(p / w12);
      let rLin = row < 3 ? 1.15 : 0.08;
      let gLin = row < 3 ? 1.12 : 0.08;
      let bLin = row < 3 ? 1.08 : 0.09;
      if (id === 1) {
        rLin = 2.6;
        gLin = 2.4;
        bLin = 2.1;
      } else if (id === 2) {
        rLin = 1.25;
        gLin = 1.22;
        bLin = 1.18;
      } else if (id === 3) {
        rLin = 0.22;
        gLin = 0.22;
        bLin = 0.24;
      }
      hdrData[p * 4] = rLin;
      hdrData[p * 4 + 1] = gLin;
      hdrData[p * 4 + 2] = bLin;
      hdrData[p * 4 + 3] = 1.0;

      // 无 post.grade-cl 基线：线性直接截断量化到 [0, 255]，发光件、金属件与顶棚高光全部溢出到 255
      const linLuma = 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
      ungradedLuma[p] = Math.round(Math.min(1, Math.max(0, linLuma)) * 255);
    }

    // 调用真实 M4 卡 post.grade-cl (evaluate) 执行 ACES RRT/ODT 高光肩部压缩与分离色调显示变换
    const gradedRgba = evaluateGradeCl(
      { color: { width: w12, height: h12, data: hdrData, channels: 4 } },
      {
        exposure: 0.68,
        vignette: 0.18,
        caBase: 0,
        bloom: 0,
        god: 0,
        saturation: 1.04,
        contrast: 0.36,
        gamma: 2.2,
        grain: 0,
        ditherMode: 'none',
      },
      [w12, h12],
    );
    const gradedLuma = Buffer.alloc(nPx12);
    let clipsBefore = 0;
    let clipsAfter = 0;
    for (let p = 0; p < nPx12; p++) {
      if (ungradedLuma[p] === 255) clipsBefore++;
      const y = Math.round(
        0.2126 * gradedRgba[p * 4]
        + 0.7152 * gradedRgba[p * 4 + 1]
        + 0.0722 * gradedRgba[p * 4 + 2],
      );
      gradedLuma[p] = y;
      if (y === 255) clipsAfter++;
    }
    beforeMaxClipRatio = Math.max(beforeMaxClipRatio, clipsBefore / nPx12);
    afterMaxClipRatio = Math.max(afterMaxClipRatio, clipsAfter / nPx12);
    before12.frames[fIdx].lumaRaster = ungradedLuma.toString('base64');
    after12.frames[fIdx].lumaRaster = gradedLuma.toString('base64');
  }

  const verdictBefore12 = scoreLevel3(q12, before12);
  const verdictAfter12 = scoreLevel3(q12, after12);
  assert.equal(verdictBefore12.valid, true);
  assert.equal(verdictBefore12.pass, false);
  assert.ok(verdictBefore12.score < 1);
  assert.ok(beforeMaxClipRatio > 0.05);
  assert.equal(verdictAfter12.valid, true);
  assert.equal(verdictAfter12.pass, true);
  assert.equal(verdictAfter12.score, 1);
  assert.ok(afterMaxClipRatio <= 0.05);
  assert.ok(verdictAfter12.score - verdictBefore12.score > 0);

  // 实证 2：M4 卡 time.bake 跨题复用于一级题 23-1（无缝转台循环）
  const q23 = readJson('questions', 'level-1', '23-1.json');
  const totalFrames23 = q23.deliverable.frames; // 72
  const [W23, H23] = q23.deliverable.size;
  const renderTurntableFrame = (degrees) => {
    const rgba = new Uint8Array(64 * 8 * 4).fill(255);
    for (let i = 0; i < 64 * 8; i++) {
      const val = Math.round(128 + 100 * Math.sin((2 * Math.PI * (i % 64)) / 64 + (degrees * Math.PI) / 180));
      rgba.fill(val, i * 4, i * 4 + 3);
    }
    return { width: 64, height: 8, rgba };
  };
  const build23ReadingFromAngles = (anglesDeg) => {
    const totalDeg = anglesDeg.at(-1) * (totalFrames23 / (totalFrames23 - 1));
    const frameAt = (k) => renderTurntableFrame(anglesDeg[k]);
    const search = argsOfB2(q23, 'loop.closure-psnr')?.search ?? [36, 72];
    const film23 = { output: { size: [W23, H23], fps: '24/1', frames: totalFrames23 }, shots: [{ id: 's01', in: 0, out: totalFrames23 }] };
    const measured23 = {
      output: { size: [W23, H23], fps: '24/1', frames: totalFrames23, colorTag: 'bt709' },
      blackFrames: [],
      freezes: [],
      cuts: [],
      orbitTotalDeg: { 'camera:subject': totalDeg },
      orbitAnglesDeg: {
        'camera:subject': anglesDeg.map((deg, frame) => ({ frame, deg })),
      },
    };
    const predicates = evaluateBasePredicates(q23, film23, measured23);
    return {
      base: {
        spec: { width: W23, height: H23, fps: 24, frames: totalFrames23, audioChannels: 0 },
        predicates,
      },
      'loop.closure-psnr': {
        ...readNearest(frameAt, search),
        ...readClosure(frameAt(0), frameAt(totalFrames23 - 1), frameAt(1)),
      },
    };
  };

  // 无 time.bake 基线：未烘焙的漂移步进积分（角度过冲至 374.4°，首尾闭合落在第 68 帧而非第 71 帧）
  const unbakedAngles = Array.from({ length: totalFrames23 }, (_, k) => k * 5.2);
  const before23Reading = build23ReadingFromAngles(unbakedAngles);
  const verdictBefore23 = scoreLevel1(q23, before23Reading);

  // 调用真实 M4 卡 time.bake (bakeTrajectory + queryBakedTable) 烘焙确定性 360° 闭合转台轨迹表
  const bakedTurntable = bakeTrajectory({
    t0: 0,
    duration: 3.0,
    sampleHz: 24,
    substeps: 8,
    warmupSteps: 0,
    initialState: [0, 120],
    step([deg, omega], _t, dt) {
      return [deg + omega * dt, omega];
    },
  });
  const bakedAngles = Array.from(
    { length: totalFrames23 },
    (_, k) => queryBakedTable(bakedTurntable, k / 24, { interpolation: 'cubic' })[0],
  );
  const after23Reading = build23ReadingFromAngles(bakedAngles);
  const verdictAfter23 = scoreLevel1(q23, after23Reading);

  assert.equal(verdictBefore23.pass, false);
  assert.ok(verdictBefore23.score < 1);
  assert.equal(verdictAfter23.pass, true);
  assert.equal(verdictAfter23.score, 1);
  assert.ok(verdictAfter23.score - verdictBefore23.score > 0);
});
