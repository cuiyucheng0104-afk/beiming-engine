// B5：B2 一级 4 道考题（01-1、23-1、28-1、29-1）与 B3 二级第一批 4 道考题（23-2、27-1、29-2、30-1）共 8 道公开题的 24 份标准负对照（关卡、整体错位 2 帧、随机拍点）与正式判分核验。
// 正对照和负对照的读数分别由 negatives/level-1/run-b5-l1.mjs 和 negatives/level-2-a/run-b5-l2a.mjs 在合成信号/行为模型上真实量出，判分走 evaluate-b2 与 evaluate-b3 的正式判分器。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { audioLoudness, blackFreezeDup, cutYdif } from '../observe/metrics/video-audio.mjs';
import { evaluateAssertion } from '../verify/predicates.mjs';
import { scanQuestionLeaks } from './index.mjs';
import {
  B5_FORMAT as B5_L1_FORMAT,
  B5_L1_QUESTION_IDS,
  B5_NEGATIVE_KINDS as B5_L1_KINDS,
  buildPositiveBaseline as buildL1Baseline,
  evaluateAllB5L1Negatives,
  evaluateNegativeControl as evaluateL1Control,
  evaluatePerturbedModel as evaluateL1Perturbed,
  inspect291Frames,
  loadControl as loadL1Control,
  loadQuestion as loadL1Question,
  measure as measureL1,
  measureAudioLoudness as measureL1AudioLoudness,
  synthesize011AudioTrack,
  synthesize231Planes,
  validateNegativeControl as validateL1Control,
} from './negatives/level-1/run-b5-l1.mjs';
import {
  B5_FORMAT as B5_L2A_FORMAT,
  B5_L2A_QUESTION_IDS,
  B5_NEGATIVE_KINDS as B5_L2A_KINDS,
  build301Resolver,
  buildPositiveBaseline as buildL2aBaseline,
  encodeWavPcm16,
  evaluateAllB5L2aNegatives,
  evaluateNegativeControl as evaluateL2aControl,
  evaluatePerturbedModel as evaluateL2aPerturbed,
  loadControl as loadL2aControl,
  loadQuestion as loadL2aQuestion,
  measure as measureL2a,
  measureAudioLoudness,
  synthesizeAudioTrack,
  synthesizePlanes,
  validateNegativeControl as validateL2aControl,
} from './negatives/level-2-a/run-b5-l2a.mjs';
import { score as scoreB2 } from './questions/level-1/evaluate-b2.mjs';
import { read30_1 } from './questions/level-2-a/evaluate-b3.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEGATIVES_L1 = join(HERE, 'negatives/level-1');
const NEGATIVES_L2A = join(HERE, 'negatives/level-2-a');
const L1_CONTROL_IDS = B5_L1_QUESTION_IDS.flatMap((id) => B5_L1_KINDS.map((kind) => `${id}-${kind}`));
const L2A_CONTROL_IDS = B5_L2A_QUESTION_IDS.flatMap((id) => B5_L2A_KINDS.map((kind) => `${id}-${kind}`));
const ALL_QUESTION_IDS = [...B5_L1_QUESTION_IDS, ...B5_L2A_QUESTION_IDS];
const ALL_CONTROL_IDS = [...L1_CONTROL_IDS, ...L2A_CONTROL_IDS];

const isL1Question = (qid) => B5_L1_QUESTION_IDS.includes(qid);
const isL1Control = (id) => L1_CONTROL_IDS.includes(id);
const loadQuestion = (qid) => (isL1Question(qid) ? loadL1Question(qid) : loadL2aQuestion(qid));
const loadControl = (id) => (isL1Control(id) ? loadL1Control(id) : loadL2aControl(id));
const validateControl = (control) => (isL1Question(control?.questionId) ? validateL1Control(control) : validateL2aControl(control));
const evaluateControl = (idOrControl) => {
  const qid = typeof idOrControl === 'string' ? idOrControl.replace(/-(?:disable-card|shift-2f|random-beats)$/, '') : idOrControl?.questionId;
  return isL1Question(qid) ? evaluateL1Control(idOrControl) : evaluateL2aControl(idOrControl);
};
const evaluatePerturbed = (qid, perturbation, seed) => (isL1Question(qid)
  ? evaluateL1Perturbed(qid, perturbation, seed)
  : evaluateL2aPerturbed(qid, perturbation, seed));
const buildBaseline = (qid) => (isL1Question(qid) ? buildL1Baseline(qid) : buildL2aBaseline(qid));

// 整份文件预跑一遍：8 份正对照、24 份负对照
const POSITIVE = Object.fromEntries(ALL_QUESTION_IDS.map((id) => [id, buildBaseline(id)]));
const RESULTS_L1 = evaluateAllB5L1Negatives();
const RESULTS_L2A = evaluateAllB5L2aNegatives();
const RESULTS = [...RESULTS_L1, ...RESULTS_L2A];
const resultOf = (id) => RESULTS.find(({ control }) => control.id === id);
const failedAt = (verdict) => verdict.items.flatMap((item, index) => (item.pass ? [] : [index]));

test('B5-1 8 道题正对照走正式判分器满分通过，24 份标准负对照（8 题 × 3 类）全部真实量测并判不过', () => {
  assert.deepEqual(B5_L1_QUESTION_IDS, ['01-1', '23-1', '28-1', '29-1']);
  assert.deepEqual(B5_L2A_QUESTION_IDS, ['23-2', '27-1', '29-2', '30-1']);
  assert.deepEqual(B5_L1_KINDS, ['disable-card', 'shift-2f', 'random-beats']);
  assert.deepEqual(B5_L2A_KINDS, ['disable-card', 'shift-2f', 'random-beats']);
  assert.equal(B5_L1_FORMAT, 'bench-negative/0.1');
  assert.equal(B5_L2A_FORMAT, 'bench-negative/0.1');

  for (const qid of ALL_QUESTION_IDS) {
    const pos = POSITIVE[qid];
    assert.equal(pos.verdict.pass, true, `${qid} 正对照必须满分通过`);
    assert.equal(pos.verdict.basePass, true, `${qid} 正对照基础门必须通过`);
    assert.ok(Math.abs(pos.verdict.score - 1) < 1e-9, `${qid} 正对照得分必须为 1`);
    assert.deepEqual(failedAt(pos.verdict), [], `${qid} 正对照不应有失分项`);
  }

  assert.equal(RESULTS_L1.length, 12);
  assert.equal(RESULTS_L2A.length, 12);
  assert.equal(RESULTS.length, 24);
  assert.deepEqual(RESULTS.map(({ control }) => control.id), ALL_CONTROL_IDS);
  for (const r of RESULTS) {
    assert.equal(r.verdict.pass, false, `${r.control.id} 必须判不过`);
    assert.ok(r.verdict.score < 1, `${r.control.id} 得分必须低于满分（实际 ${r.verdict.score}）`);
  }
});

test('B5-2 24 份夹具齐全，字段完整，种类和题面的 needs、种子、判分线对得上', () => {
  assert.deepEqual(
    readdirSync(NEGATIVES_L1).sort(),
    [...L1_CONTROL_IDS.map((id) => `${id}.json`), 'run-b5-l1.mjs'].sort(),
    'negatives/level-1 目录正好 12 份夹具和 1 个核验模块',
  );
  assert.deepEqual(
    readdirSync(NEGATIVES_L2A).sort(),
    [...L2A_CONTROL_IDS.map((id) => `${id}.json`), 'run-b5-l2a.mjs'].sort(),
    'negatives/level-2-a 目录正好 12 份夹具和 1 个核验模块',
  );

  for (const qid of ALL_QUESTION_IDS) {
    for (const kind of B5_L1_KINDS) {
      const id = `${qid}-${kind}`, control = loadControl(id), q = loadQuestion(qid);
      assert.equal(validateControl(control), control, `${id} 过得了入口校验`);
      assert.deepEqual(
        Object.keys(control),
        ['format', 'id', 'questionId', 'kind', 'disabledCards', 'seed', 'description', 'perturbation', 'expectedFailedMetrics'],
        id,
      );
      assert.deepEqual([control.format, control.id, control.questionId, control.kind], [B5_L1_FORMAT, id, qid, kind]);
      assert.ok(typeof control.description === 'string' && control.description.length >= 10, `${id} 要写清故意做错了什么`);
      const changed = Object.entries(control.perturbation);
      assert.ok(changed.length >= 1, `${id} 没写改了哪个参数`);
      if (kind === 'disable-card') {
        assert.ok(
          control.disabledCards.length >= 1 && control.disabledCards.every((card) => q.needs.includes(card)),
          `${id} 关的卡要在题面的 needs 里`,
        );
      } else {
        assert.deepEqual(control.disabledCards, [], id);
      }
      if (kind === 'shift-2f') assert.deepEqual(changed.map(([, value]) => value), [2], id);
      if (kind === 'random-beats') assert.deepEqual(changed.map(([, value]) => value), ['random-beats'], id);
      assert.equal(Number.isSafeInteger(control.seed), kind === 'random-beats', `${id} 的种子`);
      if (kind !== 'random-beats') assert.equal(control.seed, null, id);

      assert.ok(control.expectedFailedMetrics.length >= 1, id);
      assert.equal(new Set(control.expectedFailedMetrics.map(({ scoring }) => scoring)).size, control.expectedFailedMetrics.length, id);
      for (const expected of control.expectedFailedMetrics) {
        assert.deepEqual(Object.keys(expected), ['scoring', 'metric', 'why'], id);
        assert.equal(q.scoring[expected.scoring]?.metric, expected.metric, `${id} 第 ${expected.scoring} 条判分线`);
        assert.ok(typeof expected.why === 'string' && expected.why.length >= 5, id);
      }
    }
  }
});

const ALLOW_EMPTY_ARRAYS = new Set(['blackFrames', 'freezes']);
function assertSolid(value, path, lastKey = '') {
  if (Array.isArray(value)) {
    if (!ALLOW_EMPTY_ARRAYS.has(lastKey)) assert.ok(value.length > 0, `${path} 是空数组`);
    assert.equal(Reflect.ownKeys(value).length, value.length + 1, `${path} 有空洞或附加属性`);
    for (let i = 0; i < value.length; i++) {
      assert.ok(Object.hasOwn(value, i), `${path}[${i}] 是空洞`);
      assertSolid(value[i], `${path}[${i}]`);
    }
  } else if (value !== null && typeof value === 'object') {
    assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path} 不是普通对象`);
    assert.ok(
      Object.keys(value).length > 0 && Reflect.ownKeys(value).length === Object.keys(value).length,
      `${path} 是空对象或带了隐藏的键`,
    );
    for (const key of Object.keys(value)) assertSolid(value[key], `${path}.${key}`, key);
  } else {
    const ok = Number.isFinite(value) || (typeof value === 'string' && value.trim().length > 0);
    assert.ok(ok, `${path} 不是有限数或非空标签：${String(value)}`);
  }
}

test('B5-3 8 份正对照和 24 份负对照的读数都完整、密实、无 NaN/空洞/越界：判不过不是靠缺项或坏格式', () => {
  const l1Fields = {
    '01-1': {
      'deliver.spec': ['width', 'height', 'fps', 'frames', 'color_space', 'color_transfer', 'color_primaries', 'color_range', 'audioChannels', 'audioLayout'],
      'audio.loudness': ['lufs', 'truePeakDbtp'],
      'frame.black-freeze-dup': ['blackFrames', 'freezeSegments', 'duplicateFrames'],
    },
    '23-1': { 'loop.closure-psnr': ['nearest', 'closurePsnr', 'adjacentPsnr'] },
    '28-1': {
      'meta.bbox-limits': ['frames', 'maxW', 'minH', 'maxH', 'minMarginLr', 'minMarginTb'],
      'loop.closure-psnr': ['closurePsnr', 'adjacentPsnr'],
      'pixel.bbox': ['maxDiffPx'],
    },
    '29-1': { 'layout.edges': ['bands', 'edgeErrorsPx', 'sideErrorsPx', 'lineColorError'] },
  };
  const l2aFields = {
    '23-2': ['width', 'height', 'fps', 'frames', 'colorTag', 'blackFrames', 'freezes', 'cuts', 'shots', 'chaptersMs', 'beat', 'strongOnsetsMs'],
    '27-1': ['width', 'height', 'fps', 'frames', 'colorTag', 'blackFrames', 'freezes', 'shots', 'cuts', 'loudnessLufs', 'truePeakDbtp'],
    '29-2': ['width', 'height', 'fps', 'frames', 'eventsFps', 'eventsFrames', 'colorTag', 'blackFrames', 'freezes', 'shots', 'clicks', 'cuts', 'onsetsMs'],
    '30-1': ['width', 'height', 'fps', 'frames', 'colorTag', 'blackFrames', 'freezes', 'cuts', 'shots', 'loudnessLufs', 'truePeakDbtp', 'baseBpm', 'probeBpm', 'beatEvents', 'probeBeatEvents', 'absoluteEvents', 'probeAbsoluteEvents'],
  };

  const allRuns = [
    ...Object.values(POSITIVE).map((pos) => ({ ...pos, label: `${pos.questionId} 正对照` })),
    ...RESULTS.map((r) => ({ ...r, label: r.control.id })),
  ];
  for (const { questionId, readings, verdict, label } of allRuns) {
    const q = loadQuestion(questionId), { frames } = q.deliverable;
    assertSolid(readings, label);
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(readings))), JSON.stringify(readings), `${label} JSON 往返一致`);
    if (isL1Question(questionId)) {
      assert.equal(verdict.malformed, false, `${label} 绝不靠 malformed 判 0 分`);
      assert.deepEqual(
        Object.keys(readings).sort(),
        ['base', ...new Set(q.scoring.map(({ metric }) => metric))].sort(),
        `${label} 的读数指标齐全`,
      );
      for (const [metric, keys] of Object.entries(l1Fields[questionId])) {
        assert.deepEqual(Object.keys(readings[metric]), keys, `${label} ${metric}`);
      }
      if (questionId === '23-1') {
        const { nearest } = readings['loop.closure-psnr'];
        assert.ok(nearest >= 36 && nearest < frames, `${label} nearest 帧号在后半段窗口内`);
      }
      if (questionId === '28-1') {
        assert.equal(readings['meta.bbox-limits'].frames, frames, `${label} 包围盒帧数齐全`);
      }
    } else {
      assert.deepEqual(Object.keys(readings), l2aFields[questionId], `${label} 顶层字段齐全`);
      for (const item of verdict.items) {
        assert.equal(item.detail?.invalid, undefined, `${label} 绝不靠读数不成形 invalid 判不过`);
      }
      for (const cut of readings.cuts) assert.ok(cut > 0 && cut < frames, `${label} 切点帧号在片内`);
      if (questionId === '23-2') {
        assert.equal(readings.chaptersMs.length, 6, `${label} 章节数正好 6 个`);
        assert.equal(readings.strongOnsetsMs.length, 55, `${label} 强起音数正好 55 个`);
      }
      if (questionId === '27-1') assert.equal(readings.cuts.length, 13, `${label} 切点数正好 13 个`);
      if (questionId === '29-2') {
        assert.equal(readings.clicks.length, 11, `${label} 点击数正好 11 次`);
        assert.equal(readings.cuts.length, 11, `${label} 切点数正好 11 个`);
      }
      if (questionId === '30-1') {
        assert.equal(readings.beatEvents.length, 20, `${label} 跟拍事件正好 20 个`);
        assert.equal(readings.probeBeatEvents.length, 20, `${label} 重求值跟拍事件正好 20 个`);
      }
    }
  }
});

const amplitude = (db) => 10 ** (-db / 20);
const MECHANISM = {
  '01-1-disable-card': (q, r, base) => {
    assert.deepEqual([r['deliver.spec'].color_transfer, r['deliver.spec'].color_primaries], ['unknown', 'unknown']);
    assert.deepEqual(r['audio.loudness'], { lufs: -9.5, truePeakDbtp: 0.8 });
    assert.deepEqual(r['frame.black-freeze-dup'], base['frame.black-freeze-dup']);
  },
  '01-1-shift-2f': (q, r, base) => {
    assert.deepEqual(r['frame.black-freeze-dup'], { blackFrames: 2, freezeSegments: 0, duplicateFrames: 0 });
    assert.deepEqual([r['deliver.spec'], r['audio.loudness']], [base['deliver.spec'], base['audio.loudness']]);
  },
  '01-1-random-beats': (q, r, base) => {
    assert.deepEqual(r['frame.black-freeze-dup'], { blackFrames: 0, freezeSegments: 25, duplicateFrames: 1011 });
    assert.deepEqual([r['deliver.spec'], r['audio.loudness']], [base['deliver.spec'], base['audio.loudness']]);
  },
  '23-1-disable-card': (q, r) => {
    assert.equal(r['loop.closure-psnr'].nearest, 71);
    const ratio = amplitude(r['loop.closure-psnr'].closurePsnr) / amplitude(r['loop.closure-psnr'].adjacentPsnr);
    assert.ok(ratio > 3 && ratio > q.scoring[1].args.maxRatio, `首尾误差比 ${ratio}`);
  },
  '23-1-shift-2f': (q, r) => {
    assert.equal(r['loop.closure-psnr'].nearest, 69);
    const ratio = amplitude(r['loop.closure-psnr'].closurePsnr) / amplitude(r['loop.closure-psnr'].adjacentPsnr);
    assert.ok(ratio <= q.scoring[1].args.maxRatio, `第 71 帧误差比 ${ratio} 在限值内`);
  },
  '23-1-random-beats': (q, r, base) => {
    assert.equal(r['loop.closure-psnr'].nearest, 42);
    assert.ok(r['loop.closure-psnr'].closurePsnr < 10);
    assert.equal(r['loop.closure-psnr'].adjacentPsnr, base['loop.closure-psnr'].adjacentPsnr);
  },
  '28-1-disable-card': (q, r, base) => {
    assert.ok(r['meta.bbox-limits'].maxH > 0.87 && r['meta.bbox-limits'].minMarginTb < 0.07);
    assert.ok(r['loop.closure-psnr'].closurePsnr < r['loop.closure-psnr'].adjacentPsnr - 8);
    assert.deepEqual(r['pixel.bbox'], base['pixel.bbox']);
  },
  '28-1-shift-2f': (q, r, base) => {
    assert.equal(r['pixel.bbox'].maxDiffPx, 14);
    assert.deepEqual([r['meta.bbox-limits'], r['loop.closure-psnr']], [base['meta.bbox-limits'], base['loop.closure-psnr']]);
  },
  '28-1-random-beats': (q, r, base) => {
    assert.ok(r['meta.bbox-limits'].minH < 0.7 && r['meta.bbox-limits'].maxH > 0.83);
    assert.ok(r['loop.closure-psnr'].closurePsnr < r['loop.closure-psnr'].adjacentPsnr - 7);
    assert.deepEqual(r['pixel.bbox'], base['pixel.bbox']);
  },
  '29-1-disable-card': (q, r) => {
    assert.deepEqual(r['layout.edges'].edgeErrorsPx, [4, 0, 0, 0, 0, 4]);
    assert.deepEqual(r['layout.edges'].sideErrorsPx, [0, 0, 0, 0, 0, 0]);
    assert.equal(r['layout.edges'].lineColorError, 12);
  },
  '29-1-shift-2f': (q, r) => {
    assert.deepEqual(r['layout.edges'].edgeErrorsPx, [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(r['layout.edges'].sideErrorsPx, [0, 0, 0, 0, 0, 0]);
    assert.equal(r['layout.edges'].lineColorError, 24);
  },
  '29-1-random-beats': (q, r) => {
    assert.deepEqual(r['layout.edges'].edgeErrorsPx, [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(r['layout.edges'].sideErrorsPx, [21, 21, 0, 0, 21, 21]);
    assert.equal(r['layout.edges'].lineColorError, 21);
  },
  '23-2-disable-card': (q, r, base) => {
    assert.deepEqual(r.chaptersMs, [0, 2000, 8083, 14000, 18000, 22000]);
    assert.deepEqual([r.beat, r.strongOnsetsMs], [base.beat, base.strongOnsetsMs]);
  },
  '23-2-shift-2f': (q, r, base) => {
    assert.equal(r.chaptersMs[0], 0);
    assert.ok(r.chaptersMs.slice(1).every((ms, i) => Math.abs(ms - base.chaptersMs[i + 1] - 83.33333) < 1e-4));
    assert.deepEqual(r.cuts, base.cuts.map((f) => f + 2));
  },
  '23-2-random-beats': (q, r, base) => {
    assert.equal(r.chaptersMs[0], 0);
    assert.notDeepEqual(r.chaptersMs, base.chaptersMs);
    assert.deepEqual([r.beat, r.strongOnsetsMs], [base.beat, base.strongOnsetsMs]);
  },
  '27-1-disable-card': (q, r, base) => {
    assert.deepEqual(r.cuts, [36, 73, 109, 146, 182, 219, 255, 291, 328, 364, 401, 437, 474]);
    assert.deepEqual([r.loudnessLufs, r.truePeakDbtp], [base.loudnessLufs, base.truePeakDbtp]);
  },
  '27-1-shift-2f': (q, r, base) => {
    assert.deepEqual(r.cuts, base.cuts.map((f) => f + 2));
    assert.ok(r.cuts.every((f) => f % 12 === 2));
  },
  '27-1-random-beats': (q, r, base) => {
    assert.equal(r.cuts.length, base.cuts.length);
    assert.equal(r.cuts[0], 37);
    assert.ok(r.cuts.filter((f) => f % 12 !== 0).length >= 10);
  },
  '29-2-disable-card': (q, r, base) => {
    assert.deepEqual(r.clicks, [50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550]);
    assert.deepEqual(r.cuts, r.clicks);
    assert.deepEqual(r.onsetsMs, base.onsetsMs);
  },
  '29-2-shift-2f': (q, r, base) => {
    assert.deepEqual(r.clicks, base.clicks.map((f) => f + 2));
    assert.deepEqual(r.cuts, base.cuts.map((f) => f + 2));
    assert.deepEqual(r.onsetsMs, base.onsetsMs);
  },
  '29-2-random-beats': (q, r, base) => {
    assert.equal(r.clicks.length, base.clicks.length);
    assert.deepEqual(r.cuts, r.clicks.map((f) => f + 2));
    assert.deepEqual(r.onsetsMs, base.onsetsMs);
  },
  '30-1-disable-card': (q, r, base) => {
    assert.deepEqual(r.beatEvents, base.beatEvents);
    assert.deepEqual(r.probeBeatEvents, r.beatEvents, '改到 96 BPM 后跟拍事件原地不动');
    assert.deepEqual(r.probeAbsoluteEvents, [{ id: 'title_enter', frame: 48 }]);
  },
  '30-1-shift-2f': (q, r, base) => {
    assert.deepEqual(r.beatEvents.map((e) => e.frame), base.beatEvents.map((e) => e.frame + 2));
    assert.deepEqual(r.probeBeatEvents.map((e) => e.frame), base.probeBeatEvents.map((e) => e.frame + 2));
  },
  '30-1-random-beats': (q, r, base) => {
    assert.equal(r.beatEvents.length, 20);
    assert.notDeepEqual(r.beatEvents, base.beatEvents);
    assert.notDeepEqual(r.probeBeatEvents, r.beatEvents, '96 BPM 下仍随拍速联动位移');
  },
};

test('B5-4 击穿的判分项和夹具写的一一对应，得分是剩下几项的权重；读数里留着故障的痕迹', () => {
  assert.deepEqual(Object.keys(MECHANISM), ALL_CONTROL_IDS);
  for (const { control, questionId, readings, verdict, failedAsDeclared } of RESULTS) {
    const q = loadQuestion(questionId);
    assert.equal(failedAsDeclared, true, `${control.id} 入口自报 failedAsDeclared === true`);
    assert.deepEqual(failedAt(verdict), control.expectedFailedMetrics.map(({ scoring }) => scoring), `${control.id} 没过的判分项`);
    assert.deepEqual(
      verdict.items.filter((item) => !item.pass).map((item) => item.metric),
      control.expectedFailedMetrics.map(({ metric }) => metric),
      control.id,
    );
    const kept = q.scoring.reduce((sum, { weight }, index) => sum + (failedAt(verdict).includes(index) ? 0 : weight), 0);
    assert.ok(Math.abs(verdict.score - kept) < 1e-9, `${control.id} 得分 ${verdict.score}`);
    MECHANISM[control.id](q, readings, POSITIVE[questionId].readings);
  }
});

test('B5-5 一份负对照一类故障：去掉改动就是正对照；多参数关卡逐个拆开各打穿各的线；随机拍点确定性复现且跟种子走', () => {
  for (const qid of ALL_QUESTION_IDS) {
    const undone = evaluatePerturbed(qid, {});
    assert.equal(undone.verdict.pass, true, qid);
    assert.equal(JSON.stringify(undone.readings), JSON.stringify(POSITIVE[qid].readings), `${qid} 零改动重跑逐字等于正对照`);
  }

  // 多参数 disable-card 逐项拆开各打穿自己那条判分线
  assert.deepEqual(failedAt(evaluatePerturbed('01-1', { colorTags: false }).verdict), [0]);
  assert.deepEqual(failedAt(evaluatePerturbed('01-1', { audioMaster: false }).verdict), [1]);
  assert.deepEqual(failedAt(evaluatePerturbed('28-1', { subjectHeightPx: 720 }).verdict), [0]);
  assert.deepEqual(failedAt(evaluatePerturbed('28-1', { orbitDegrees: 240 }).verdict), [1]);
  assert.deepEqual(failedAt(evaluatePerturbed('29-1', { panelMarginPx: 48 }).verdict), [0]);
  assert.deepEqual(failedAt(evaluatePerturbed('29-1', { dividerColorDelta: 12 }).verdict), [1]);
  assert.deepEqual(failedAt(evaluatePerturbed('29-2', { cutLagFrames: 0 }).verdict), [0]);
  assert.deepEqual(failedAt(evaluatePerturbed('29-2', { clickTrigger: 'equal-interval' }).verdict), [1]);

  // 随机拍点：同种子逐字复现，换种子读数必变且照旧判不过
  for (const qid of ALL_QUESTION_IDS) {
    const id = `${qid}-random-beats`, control = loadControl(id);
    const again = evaluateControl(id);
    assert.equal(JSON.stringify(again.readings), JSON.stringify(resultOf(id).readings), `${id} 同种子确定性逐位一致`);
    const other = evaluatePerturbed(qid, control.perturbation, control.seed + 1);
    assert.equal(other.verdict.pass, false, `${id} 换种子仍判不过`);
    assert.notDeepEqual(other.readings, again.readings, `${id} 换种子后读数真的跟着变`);
  }
});

test('B5-6 贴线、对称错位与模型假设核验：如实记录双向错位与模型边界表现', () => {
  const verdict = (qid, perturbation) => evaluatePerturbed(qid, perturbation).verdict;
  // 23-1、28-1、23-2、27-1、30-1 往反方向错位 2 帧（-2 帧）同样判不过
  assert.equal(verdict('23-1', { loopShiftFrames: -2 }).pass, false);
  assert.equal(verdict('28-1', { metaShiftFrames: -2 }).pass, false);
  assert.equal(verdict('28-1', { metaShiftFrames: 1 }).pass, true, '28-1 错位 1 帧差 7 像素，在 8 像素容差内');
  assert.equal(verdict('23-2', { chapterShiftFrames: -2 }).pass, false);
  assert.equal(verdict('23-2', { chapterShiftFrames: -1 }).pass, true, '23-2 早 1 帧离拍点 21.7 毫秒，在 1 帧容差内');
  assert.equal(verdict('27-1', { cutShiftFrames: -2 }).pass, false);
  assert.equal(verdict('30-1', { eventShiftFrames: -2 }).pass, false);
  assert.equal(verdict('30-1', { eventShiftFrames: 1 }).pass, true, '30-1 错位 1 帧在 1 帧容差内');

  // 29-2 的配乐有 109 个密集起音，早 2 帧恰好踩入前侧起音容差窗（贴线说明）
  assert.equal(verdict('29-2', { clickShiftFrames: -2 }).pass, true);
  assert.equal(verdict('29-2', { clickShiftFrames: 3 }).pass, false);
  assert.match(loadControl('29-2-shift-2f').description, /贴线说明/);

  // 01-1 与 29-1 的 2 帧错位靠模型假设（固定容器黑场引带 / 抽样帧前过渡脉冲），错位 1 帧同样判不过
  assert.equal(verdict('01-1', { videoShiftFrames: 1 }).pass, false);
  assert.equal(verdict('29-1', { transitionShiftFrames: 1 }).pass, false);
  assert.match(loadControl('01-1-shift-2f').description, /模型假设说明/);
  assert.match(loadControl('29-1-shift-2f').description, /模型假设说明/);
});

test('B5-7 30-1 专项核验（2026-11-23 管理员裁定）：纯行为 BPM 扰动检查（80 -> 96 BPM 重求值），与 read30_1 逐位一致且零源码静态扫描', async () => {
  const q = loadQuestion('30-1');
  const pos = POSITIVE['30-1'];
  const filmMeta = {
    width: pos.readings.width,
    height: pos.readings.height,
    fps: pos.readings.fps,
    frames: pos.readings.frames,
    colorTag: pos.readings.colorTag,
    blackFrames: pos.readings.blackFrames,
    freezes: pos.readings.freezes,
    cuts: pos.readings.cuts,
    shots: pos.readings.shots,
    loudnessLufs: pos.readings.loudnessLufs,
    truePeakDbtp: pos.readings.truePeakDbtp,
  };
  for (const run of [pos, resultOf('30-1-disable-card'), resultOf('30-1-shift-2f'), resultOf('30-1-random-beats')]) {
    const probed = await read30_1({
      question: q,
      resolveEvents: build301Resolver(q, run.params),
      filmMeta,
    });
    assert.deepEqual(probed, run.readings, 'run-b5-l2a 的 30-1 读数与 evaluate-b3 的 read30_1 行为探针逐位一致');
  }
  const l2aSource = readFileSync(join(NEGATIVES_L2A, 'run-b5-l2a.mjs'), 'utf8');
  assert.doesNotMatch(l2aSource, /acorn|espree|babel|typescript|regexScanSource|scanSource/i, '严禁任何源码静态扫描器');
});

const MUTATIONS = [
  ['01-1-shift-2f', '帧数写成字符串', (c) => { c.perturbation.videoShiftFrames = '2'; }, TypeError],
  ['23-1-disable-card', '角度写成字符串', (c) => { c.perturbation.orbitDegrees = '350'; }, TypeError],
  ['01-1-disable-card', '布尔参数写成数字', (c) => { c.perturbation.colorTags = 0; }, TypeError],
  ['23-2-shift-2f', '删掉 perturbation', (c) => { delete c.perturbation; }, TypeError],
  ['23-2-shift-2f', 'perturbation 是空对象', (c) => { c.perturbation = {}; }, RangeError],
  ['27-1-shift-2f', 'id 没登记', (c) => { c.id = '27-1-shift-3f'; }, RangeError],
  ['27-1-shift-2f', 'id 和题号对不上', (c) => { c.id = '23-2-shift-2f'; }, RangeError],
  ['29-2-shift-2f', 'format 被改', (c) => { c.format = 'bench-negative/0.2'; }, RangeError],
  ['29-2-shift-2f', 'expectedFailedMetrics 清空', (c) => { c.expectedFailedMetrics = []; }, RangeError],
  ['29-2-shift-2f', '不是随机拍点却带字符串种子', (c) => { c.seed = '7'; }, TypeError],
  ['29-2-shift-2f', '不是随机拍点却带整数种子', (c) => { c.seed = 20261124; }, RangeError],
  ['30-1-random-beats', '随机拍点缺种子', (c) => { c.seed = null; }, RangeError],
  ['30-1-random-beats', '随机拍点种子是浮点数', (c) => { c.seed = 1.5; }, RangeError],
  ['28-1-shift-2f', '错位方向反了', (c) => { c.perturbation.metaShiftFrames = -2; }, RangeError],
  ['28-1-shift-2f', '错位写了 0 帧', (c) => { c.perturbation.metaShiftFrames = 0; }, RangeError],
  ['29-1-disable-card', '关卡未点名卡', (c) => { c.disabledCards = []; }, RangeError],
  ['29-1-disable-card', '关的卡不在题面 needs 里', (c) => { c.disabledCards = ['camera.orbit']; }, RangeError],
  ['29-1-shift-2f', '非关卡却点名关了卡', (c) => { c.disabledCards = ['layout.panels']; }, RangeError],
  ['30-1-disable-card', '关卡那份冒充错位 2 帧', (c) => { c.perturbation = { eventShiftFrames: 2 }; }, RangeError],
  ['30-1-shift-2f', '预期失分指标名对不上题面', (c) => { c.expectedFailedMetrics[0].metric = 'cut.ydif'; }, RangeError],
  ['30-1-shift-2f', '预期失分下标出界', (c) => { c.expectedFailedMetrics[0].scoring = 5; }, RangeError],
  ['29-2-disable-card', '预期失分判分线写了两遍', (c) => { c.expectedFailedMetrics[1] = { ...c.expectedFailedMetrics[0] }; }, RangeError],
  ['23-1-shift-2f', '少一栏 description', (c) => { delete c.description; }, TypeError],
  ['23-1-shift-2f', '多一栏 note', (c) => { c.note = 'extra'; }, RangeError],
];

test('B5-8 正式入口先验夹具再量：类型不对、缺栏、没登记的 id、种类串台都直接抛错；部分关卡或预期不符报 failedAsDeclared === false', () => {
  for (const [id, what, mutate, Kind] of MUTATIONS) {
    const control = structuredClone(loadControl(id));
    assert.equal(validateControl(control), control);
    mutate(control);
    assert.throws(() => validateControl(control), (err) => err.constructor === Kind, `${id} ${what}`);
    assert.throws(() => evaluateControl(control), (err) => err.constructor === Kind, `${id} ${what}`);
  }

  for (const [id, mutate] of [
    ['01-1-disable-card', (c) => { delete c.perturbation.colorTags; }],
    ['28-1-disable-card', (c) => { delete c.perturbation.subjectHeightPx; }],
    ['29-1-disable-card', (c) => { delete c.perturbation.panelMarginPx; }],
    ['29-2-disable-card', (c) => { delete c.perturbation.cutLagFrames; }],
    ['29-2-disable-card', (c) => { c.expectedFailedMetrics.pop(); }],
  ]) {
    const control = structuredClone(loadControl(id));
    mutate(control);
    assert.equal(evaluateControl(control).failedAsDeclared, false, `${id} 预期与实际不完全一致时记 false`);
  }

  for (const bad of [null, undefined, 7, [], new Map()]) {
    assert.throws(() => evaluateL1Control(bad), TypeError);
    assert.throws(() => evaluateL2aControl(bad), TypeError);
  }
  for (const id of ['01-1-shift-3f', '99-1-shift-2f', '', '../../questions/level-1/01-1', '01-1-shift-2f.json']) {
    assert.throws(() => evaluateL1Control(id), RangeError, id);
    assert.throws(() => loadL1Control(id), RangeError, id);
    assert.throws(() => evaluateL2aControl(id), RangeError, id);
    assert.throws(() => loadL2aControl(id), RangeError, id);
  }

  assert.throws(() => measureL1('01-1', { videoShiftFrames: '2' }), TypeError);
  assert.throws(() => measureL2a('30-1', { eventShiftFrames: '2' }), TypeError);
  assert.throws(() => evaluateL1Perturbed('01-1', { videoShiftFrames: 100000 }), RangeError);
  assert.throws(() => evaluateL1Perturbed('23-1', { loopShiftFrames: 100000 }), RangeError);
  assert.throws(() => evaluateL2aPerturbed('23-2', { chapterShiftFrames: 100000 }), RangeError);
  assert.throws(() => evaluateL2aPerturbed('27-1', { cutShiftFrames: 100000 }), RangeError);
  assert.throws(() => evaluateL2aPerturbed('29-2', { clickShiftFrames: 100000 }), RangeError);
  assert.throws(() => evaluateL2aPerturbed('30-1', { eventShiftFrames: 100000 }), RangeError);
});

test('B5-9 每次核验互不相干：改坏一次实验回来的参数和读数、改坏导出的清单，后面的正对照和负对照照旧', () => {
  const scribble = (value) => {
    for (const key of Object.keys(value)) {
      if (value[key] !== null && typeof value[key] === 'object') scribble(value[key]);
      else value[key] = 0;
    }
  };
  for (const qid of ALL_QUESTION_IDS) {
    const { params, readings } = evaluatePerturbed(qid, {});
    scribble(params);
    scribble(readings);
    assert.equal(JSON.stringify(buildBaseline(qid).readings), JSON.stringify(POSITIVE[qid].readings), qid);
  }
  const control = structuredClone(loadControl('29-1-disable-card'));
  const judged = evaluateControl(control);
  scribble(judged.params);
  scribble(judged.readings);
  assert.equal(JSON.stringify(evaluateControl(control).readings), JSON.stringify(resultOf('29-1-disable-card').readings));

  assert.throws(() => B5_L1_QUESTION_IDS.push('99-1'), TypeError);
  assert.throws(() => B5_L2A_QUESTION_IDS.push('99-2'), TypeError);
  assert.throws(() => B5_L1_KINDS.pop(), TypeError);
  assert.throws(() => B5_L2A_KINDS.pop(), TypeError);
});

/* ---------------- 泄露与专名门禁 ---------------- */

const NOUN_HASHES_24 = new Set((readFileSync(join(HERE, 'b4-questions.test.mjs'), 'utf8').match(/'[0-9a-f]{24}'/g) ?? []).map((q) => q.slice(1, -1)));
const NOUN_HASHES_16 = new Set((readFileSync(join(HERE, 'b2-questions.test.mjs'), 'utf8').match(/'[0-9a-f]{16}'/g) ?? []).map((q) => q.slice(1, -1)));
const hash24 = (token) => createHash('sha256').update(token).digest('hex').slice(0, 24);
const hash16 = (token) => createHash('sha256').update(token).digest('hex').slice(0, 16);

function scanProperNouns24(text) {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '').split('\n').flatMap((line, index) => {
    const tokens = (line.match(/\p{Script=Han}+|\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})/gu) ?? []).flatMap((run) => (/\p{Script=Han}/u.test(run)
      ? [2, 3, 4].flatMap((size) => Array.from({ length: Math.max(0, run.length - size + 1) }, (_, i) => run.slice(i, i + size)))
      : [run.toLowerCase()]));
    return [...new Set(tokens)].some((token) => NOUN_HASHES_24.has(hash24(token))) ? [index + 1] : [];
  });
}

function scanProperNouns16(text) {
  const words = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]+|[0-9]+/g) ?? [];
  return new Set(words.flatMap((word, i) => [word, word + (words[i + 1] ?? '')]).filter((gram) => NOUN_HASHES_16.has(hash16(gram)))).size;
}

test('B5-10 24 份夹具、2 个核验模块和本测试文件零泄露、零私有路径、零案例专名', () => {
  assert.ok(NOUN_HASHES_24.size >= 50, `B4 专名哈希取到 ${NOUN_HASHES_24.size} 个`);
  assert.ok(NOUN_HASHES_16.size >= 8, `B2 专名哈希取到 ${NOUN_HASHES_16.size} 个`);
  const word = ['zqx', 'canary'].join(''), han = ['甲乙', '丙丁'].join('');
  assert.deepEqual(scanProperNouns24(`第一行\n// ${word.toUpperCase()}\n{"note":"${han}"}`), [2, 3]);
  const privatePaths = new RegExp(['复刻', '调研资料', 'lab:/', '/Users', '/home'].map((head) => `${head}/`).join('|'), 'u');

  const files = [
    ...readdirSync(NEGATIVES_L1).map((name) => join(NEGATIVES_L1, name)),
    ...readdirSync(NEGATIVES_L2A).map((name) => join(NEGATIVES_L2A, name)),
    fileURLToPath(import.meta.url),
  ];
  assert.equal(files.length, 27, '24 份夹具、2 个核验模块、1 个测试');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.deepEqual(scanQuestionLeaks(text), [], `${file} 有泄露`);
    assert.doesNotMatch(text, privatePaths, `${file} 里有私有路径`);
    assert.deepEqual(scanProperNouns24(text), [], `${file} 里有案例专名（24 位表）`);
    assert.equal(scanProperNouns16(text), 0, `${file} 里有商业专名（16 位表）`);
  }
  for (const id of ALL_CONTROL_IDS) assert.deepEqual(scanQuestionLeaks(loadControl(id)), [], id);
});

/* ---------------- R1 独立复核回归门禁 ---------------- */

const MEDIA_OPTS = ['ffmpeg', 'ffprobe'].every((tool) => spawnSync(tool, ['-version']).status === 0)
  ? {}
  : { skip: '缺少 ffmpeg/ffprobe' };

function writeLosslessMkv(filePath, planes, [width, height], fps, wavBuffer = null) {
  const uv = Buffer.alloc(width * height * 2, 128);
  const rawYuv = Buffer.concat(planes.flatMap((plane) => [plane, uv]));
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv444p',
    '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'];
  let wavPath = null;
  if (wavBuffer) {
    wavPath = `${filePath}.wav`;
    writeFileSync(wavPath, wavBuffer);
    args.push('-i', wavPath, '-c:a', 'pcm_s16le');
  }
  args.push('-c:v', 'ffv1', filePath);
  const run = spawnSync('ffmpeg', args, { input: rawYuv });
  if (wavPath) rmSync(wavPath, { force: true });
  assert.equal(run.status, 0, String(run.stderr));
}

test('B5-11 R1 回归：27-1 与 30-1 真实合成 48 kHz 立体声 PCM 并实测响度/真峰值，与正式 audioLoudness 交叉一致', MEDIA_OPTS, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-b5-audio-'));
  try {
    for (const qid of ['27-1', '30-1']) {
      const pos = POSITIVE[qid];
      assert.ok(pos.readings.loudnessLufs >= -15 && pos.readings.loudnessLufs <= -13, `${qid} 响度在 [-15, -13] LUFS 内`);
      assert.ok(pos.readings.truePeakDbtp <= -1, `${qid} 真峰值不高于 -1 dBTP`);
      const track = synthesizeAudioTrack(qid);
      const wavFile = join(dir, `${qid}.wav`);
      writeFileSync(wavFile, encodeWavPcm16(track));
      const official = await audioLoudness(wavFile);
      assert.ok(Math.abs(pos.readings.loudnessLufs - official.value) <= 0.35, `${qid} LUFS 偏差超出 ±0.35`);
      assert.ok(Math.abs(pos.readings.truePeakDbtp - official.details.truePeakDbtp) <= 0.35, `${qid} dBTP 偏差超出 ±0.35`);
    }

    // 合成带音轨的无损成片再交正式 audioLoudness 端到端量测，确认成片容器内真实可测
    const pos271 = POSITIVE['27-1'];
    const mkv271 = join(dir, '27-1-av.mkv');
    const planes271 = synthesizePlanes([32, 32], pos271.readings.frames, pos271.readings.cuts);
    writeLosslessMkv(mkv271, planes271, [32, 32], pos271.readings.fps, encodeWavPcm16(synthesizeAudioTrack('27-1')));
    const muxed = await audioLoudness(mkv271);
    assert.ok(Math.abs(pos271.readings.loudnessLufs - muxed.value) <= 0.35);
    assert.ok(Math.abs(pos271.readings.truePeakDbtp - muxed.details.truePeakDbtp) <= 0.35);

    // 增益扰动时实测响度与真峰值同步线性变化，非硬编码常数
    const louder = measureAudioLoudness(synthesizeAudioTrack(510, 30, { bpm: 150, seed: 271, gainDb: 3 }));
    assert.ok(Math.abs((louder.loudnessLufs - pos271.readings.loudnessLufs) - 3) <= 0.05);
    assert.ok(Math.abs((louder.truePeakDbtp - pos271.readings.truePeakDbtp) - 3) <= 0.05);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B5-12 R1 回归：23-2、27-1 与 30-1 合成灰度平面编码成无损成片后，与正式 cutYdif(file, 24) 检出切点逐帧完全相等', MEDIA_OPTS, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-b5-ydif-'));
  try {
    for (const [qid, size] of [['23-2', [32, 18]], ['27-1', [32, 32]], ['30-1', [32, 18]]]) {
      const pos = POSITIVE[qid];
      const mkv = join(dir, `${qid}.mkv`);
      const planes = synthesizePlanes(size, pos.readings.frames, pos.readings.cuts);
      writeLosslessMkv(mkv, planes, size, pos.readings.fps);
      const actual = await cutYdif(mkv, 24);
      assert.deepEqual(pos.readings.cuts, actual.value, `${qid} 正对照切点与正式 cutYdif 逐帧一致`);
    }
    const shifted232 = resultOf('23-2-shift-2f');
    const mkvShift = join(dir, '23-2-shift.mkv');
    writeLosslessMkv(mkvShift, synthesizePlanes([32, 18], shifted232.readings.frames, shifted232.readings.cuts), [32, 18], shifted232.readings.fps);
    assert.deepEqual(shifted232.readings.cuts, (await cutYdif(mkvShift, 24)).value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B5-13 R1 回归：29-1 全片 600 帧逐帧独立生成 meta，第 298 帧及全片 margin_tb(panel_top) 真实合规，越界扰动报 fail', () => {
  const q = loadQuestion('29-1');
  const H = q.deliverable.size[1];
  const marginKey = q.basePredicates.find((p) => p.startsWith('margin_tb(panel_top)'));
  assert.ok(marginKey);
  assert.equal(POSITIVE['29-1'].readings.base.predicates[marginKey], 'pass');

  const inspected = inspect291Frames({}, null, [0, 298, 299, 300, 599]);
  assert.equal(inspected.frames.length, 600);
  assert.equal(new Set(inspected.frames.map((f) => f.meta)).size, 600, '600 帧各有独立的 meta 对象，不跨帧复用');
  for (const f of inspected.frames) {
    const topPanel = f.meta.entities.find((e) => e.name === 'panel_top');
    const marginTb = Math.min(topPanel.bbox2d[1], H - topPanel.bbox2d[3]) / H;
    assert.ok(marginTb >= 0.0323 && marginTb <= 0.0329, `第 ${f.frame} 帧 margin_tb=${marginTb} 在 [0.0323, 0.0329] 内`);
  }
  // 第 298、299 帧是分隔线绿通道色阶脉冲（几何不变），第 300 帧恢复 #CBFB03
  assert.deepEqual(inspected.sampledLayouts[298].bands, [[44, 652], [673, 677], [698, 1306]]);
  assert.equal(inspected.sampledLayouts[298].lineColorError, 24);
  assert.equal(inspected.sampledLayouts[299].lineColorError, 24);
  assert.equal(inspected.sampledLayouts[300].lineColorError, 1);

  const shiftCtrl = evaluateL1Control('29-1-shift-2f');
  assert.equal(shiftCtrl.verdict.basePass, true, '29-1-shift-2f 全片几何基础谓词保持通过');
  assert.equal(shiftCtrl.readings.base.predicates[marginKey], 'pass');
  assert.deepEqual(failedAt(shiftCtrl.verdict), [1], '29-1-shift-2f 仅打穿分隔线色差判分项');

  const brokenMargin = evaluateL1Perturbed('29-1', { panelMarginPx: 46 });
  assert.equal(brokenMargin.readings.base.predicates[marginKey], 'fail', 'panelMarginPx=46 破坏面板边距时基础谓词必报 fail');
  assert.equal(brokenMargin.verdict.basePass, false);
});

test('B5-14 R1 回归：23-1-shift-2f 提前 2 帧闭合且总转角 360.8°，保持 orbit_total 基础谓词通过', () => {
  const pos = POSITIVE['23-1'];
  const ctrl = evaluateL1Control('23-1-shift-2f');
  const orbitKey = Object.keys(pos.readings.base.predicates).find((k) => k.startsWith('orbit_total'));
  assert.ok(orbitKey);
  assert.equal(ctrl.readings.base.predicates[orbitKey], 'pass');
  assert.equal(ctrl.readings.base.predicates[orbitKey], pos.readings.base.predicates[orbitKey]);
  assert.equal(ctrl.verdict.basePass, true);
  assert.equal(ctrl.readings['loop.closure-psnr'].nearest, 69);
  assert.deepEqual(failedAt(ctrl.verdict), [0]);
});

test('B5-15 R1 回归：Floyd 无放回抽样遍历 seed = 700..799（含 701）全部确定性快速返回、零超时', () => {
  const start = performance.now();
  for (let seed = 700; seed <= 799; seed++) {
    const r = evaluateL1Perturbed('23-1', { orbitMode: 'random-beats' }, seed);
    assert.equal(r.verdict.pass, false, `23-1 seed=${seed} 应判不过`);
  }
  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs < 3000, `100 个种子（含 701）耗时 ${elapsedMs.toFixed(1)}ms 应远低于 3000ms`);
});

/* ---------------- R2（B5-A 裁定）定点回归门禁 ---------------- */

test('B5-16 R2 回归：23-1 实测渲染帧切点写入 measured.cuts，23-1-random-beats 的 no_cut @ all 与正式 cutYdif(file, 24) 完全一致', MEDIA_OPTS, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-b5-231-cuts-'));
  try {
    const q = loadL1Question('23-1');
    const film = { output: q.deliverable, shots: [{ id: 's01', in: 0, out: q.deliverable.frames }] };

    for (const [label, perturbation, seed, wantStatus] of [
      ['pos', {}, null, 'pass'],
      ['shift', loadL1Control('23-1-shift-2f').perturbation, null, 'pass'],
      ['disable', loadL1Control('23-1-disable-card').perturbation, null, 'pass'],
      ['random', loadL1Control('23-1-random-beats').perturbation, loadL1Control('23-1-random-beats').seed, 'fail'],
    ]) {
      const mkv = join(dir, `23-1-${label}.mkv`);
      const planes = synthesize231Planes(perturbation, seed);
      writeLosslessMkv(mkv, planes, [64, 16], 24);
      const actualCuts = (await cutYdif(mkv, 24)).value;
      const expectedStatus = evaluateAssertion('no_cut @ all', film, { cuts: actualCuts }).status;
      assert.equal(expectedStatus, wantStatus, `23-1 ${label} 正式 cutYdif 求值应为 ${wantStatus}`);
      const measured = measureL1('23-1', perturbation, seed);
      assert.equal(measured.readings.base.predicates['no_cut @ all'], expectedStatus, `23-1 ${label} 的 no_cut @ all 与 cutYdif 一致`);
      if (label === 'random') {
        assert.ok(actualCuts.length > 0 && actualCuts[0] === 4, `23-1-random-beats 检出真实切点 ${JSON.stringify(actualCuts)}`);
        const ctrl = evaluateL1Control('23-1-random-beats');
        assert.equal(ctrl.readings.base.predicates['no_cut @ all'], 'fail');
        assert.deepEqual(failedAt(ctrl.verdict), [0, 1]);
        assert.equal(ctrl.failedAsDeclared, true);
      } else {
        assert.deepEqual(actualCuts, []);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B5-17 R2 回归：synthesizeAudioTrack 收窄为仅接受带响度判分的 27-1 与 30-1，对 23-2、29-2 或未知题号明确抛 RangeError', () => {
  for (const onsetOnlyId of ['23-2', '29-2']) {
    assert.throws(
      () => synthesizeAudioTrack(onsetOnlyId),
      (err) => err instanceof RangeError && /B6|buildLogRmsEnvelope/.test(err.message),
      `${onsetOnlyId} 走合成对数能量包络，调用 synthesizeAudioTrack 必抛 RangeError`,
    );
  }
  for (const unknownId of ['99-2', '01-1', '']) {
    assert.throws(() => synthesizeAudioTrack(unknownId), RangeError, `未登记题号 ${unknownId} 必抛 RangeError`);
  }
  for (const loudId of ['27-1', '30-1']) {
    const track = synthesizeAudioTrack(loudId);
    assert.equal(track.sampleRate, 48000);
    assert.equal(track.channels.length, 2);
    assert.ok(track.channels[0].length > 0);
  }
});

test('B5-18 R2 回归：run-b5-l1 统一兼容公开题号 1-1 与内部登记名 01-1，保持 B5_L1_QUESTION_IDS 不变', () => {
  assert.deepEqual(B5_L1_QUESTION_IDS, ['01-1', '23-1', '28-1', '29-1']);
  const q = loadL1Question('01-1');
  assert.equal(q.id, '1-1');
  assert.deepEqual(loadL1Question('1-1'), q);

  const baselineFromPublicId = buildL1Baseline(q.id);
  assert.equal(baselineFromPublicId.verdict.score, 1);
  assert.equal(baselineFromPublicId.verdict.pass, true);
  assert.deepEqual(baselineFromPublicId, buildL1Baseline('01-1'));
  assert.deepEqual(measureL1('1-1', { videoShiftFrames: 2 }), measureL1('01-1', { videoShiftFrames: 2 }));
  assert.deepEqual(evaluateL1Perturbed('1-1', { audioMaster: false }), evaluateL1Perturbed('01-1', { audioMaster: false }));
});

test('B5-19 R2 回归：run-b5-l1 放行两帧逐像素全等产生的合法 PSNR === Infinity，与正式 evaluate-b2 score 完全一致', () => {
  const q = loadL1Question('28-1');
  const perturbation = { orbitDegrees: 1 };
  const measured = measureL1('28-1', perturbation);
  assert.equal(measured.readings['loop.closure-psnr'].adjacentPsnr, Infinity);
  const formal = scoreB2(q, measured.readings);
  assert.equal(formal.malformed, false);
  const judged = evaluateL1Perturbed('28-1', perturbation);
  assert.deepEqual(judged.verdict, formal);
});

test('B5-20 R2 回归：ITU-R BS.1770-4 两阶段门控严格筛除 <= -70 LUFS 绝对门下低电平段，-65/-73 dBFS 双段 PCM 与正式 audioLoudness 一致', MEDIA_OPTS, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-b5-bs1770-'));
  try {
    const samples = Float32Array.from(
      { length: 48000 * 20 },
      (_, i) => (10 ** ((i < 480000 ? -65 : -73) / 20)) * Math.sin((2 * Math.PI * i) / 48),
    );
    const pcm = { sampleRate: 48000, channels: [samples, samples] };
    const wavBuf = Buffer.alloc(samples.length * 8);
    for (let i = 0; i < samples.length; i++) {
      wavBuf.writeFloatLE(samples[i], i * 8);
      wavBuf.writeFloatLE(samples[i], i * 8 + 4);
    }
    const wavPath = join(dir, 'dual-gate.wav');
    const enc = spawnSync(
      'ffmpeg',
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-c:a', 'pcm_f32le', wavPath],
      { input: wavBuf },
    );
    assert.equal(enc.status, 0, String(enc.stderr));
    const official = (await audioLoudness(wavPath)).value;
    const localL2a = measureAudioLoudness(pcm).loudnessLufs;
    const localL1 = measureL1AudioLoudness(pcm).loudnessLufs;
    assert.ok(Math.abs(localL2a - official) <= 0.35, `L2a 响度 ${localL2a} 与正式 ${official} 偏差超出 ±0.35 LU`);
    assert.ok(Math.abs(localL1 - official) <= 0.35, `L1 响度 ${localL1} 与正式 ${official} 偏差超出 ±0.35 LU`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B5-21 R2 红队加固回归：delivery 冻结段与 blackFreezeDup 对齐、build301Resolver 兼容夹具扰动、辅助入口参数严检', MEDIA_OPTS, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-b5-redteam-'));
  try {
    // 1. 23-1-random-beats 与慢转 1° 的 delivery(...) 基础谓词与正式 blackFreezeDup 对齐
    const q23 = loadL1Question('23-1');
    const delivKey23 = q23.basePredicates[0];
    const film23 = { output: q23.deliverable, shots: [{ id: 's01', in: 0, out: q23.deliverable.frames }] };
    const randCtrl23 = loadL1Control('23-1-random-beats');
    const mkv23 = join(dir, '23-1-rand-freeze.mkv');
    writeLosslessMkv(mkv23, synthesize231Planes(randCtrl23.perturbation, randCtrl23.seed), [64, 16], 24);
    const still23 = await blackFreezeDup(mkv23);
    const officialDeliv23 = evaluateAssertion(delivKey23, film23, {
      output: { ...q23.deliverable, colorTag: 'bt709' },
      blackFrames: still23.details.black,
      freezes: still23.details.freezes.map(([from, to]) => ({ in: from, out: to + 1 })),
    }).status;
    assert.equal(officialDeliv23, 'fail');
    assert.equal(measureL1('23-1', randCtrl23.perturbation, randCtrl23.seed).readings.base.predicates[delivKey23], officialDeliv23);
    assert.equal(measureL1('23-1', { orbitDegrees: 1 }).readings.base.predicates[delivKey23], 'fail');
    assert.equal(measureL1('28-1', { orbitDegrees: 1 }).readings.base.predicates[loadL1Question('28-1').basePredicates[0]], 'fail');

    // 2. build301Resolver 直接传夹具 perturbation（及可选 seed）或默认无参均返回完整 20 个事件并与 measure 对齐
    const q30 = loadL2aQuestion('30-1');
    const pos30 = POSITIVE['30-1'];
    const filmMeta30 = {
      width: pos30.readings.width,
      height: pos30.readings.height,
      fps: pos30.readings.fps,
      frames: pos30.readings.frames,
      colorTag: pos30.readings.colorTag,
      blackFrames: pos30.readings.blackFrames,
      freezes: pos30.readings.freezes,
      cuts: pos30.readings.cuts,
      shots: pos30.readings.shots,
      loudnessLufs: pos30.readings.loudnessLufs,
      truePeakDbtp: pos30.readings.truePeakDbtp,
    };
    assert.deepEqual(await read30_1({ question: q30, resolveEvents: build301Resolver(), filmMeta: filmMeta30 }), pos30.readings);
    for (const cid of ['30-1-disable-card', '30-1-shift-2f', '30-1-random-beats']) {
      const c = loadL2aControl(cid);
      const probed = await read30_1({ question: q30, resolveEvents: build301Resolver(q30, c.perturbation, c.seed), filmMeta: filmMeta30 });
      assert.deepEqual(probed, resultOf(cid).readings, `${cid} 经 build301Resolver(q, perturbation, seed) 与正式结果一致`);
    }

    // 3. synthesizeAudioTrack 三参调用、非法帧率字符串与 synthesize011AudioTrack 分数帧率兼容
    assert.deepEqual(
      measureAudioLoudness(synthesizeAudioTrack('27-1', undefined, { gainDb: 3 })),
      measureAudioLoudness(synthesizeAudioTrack('27-1', { gainDb: 3 })),
    );
    assert.throws(() => synthesizeAudioTrack(510, 'bad'), RangeError);
    assert.throws(() => synthesizeAudioTrack(510, 30, 'bad'), TypeError);
    assert.equal(synthesize011AudioTrack(1104, '30/1').channels[0].length, 1104 * 1600);
    assert.equal(synthesize011AudioTrack('1-1').channels[0].length, 1104 * 1600);

    // 4. 低于 -70 LUFS 绝对门的全低电平音轨对齐正式 audioLoudness（-70 LUFS）
    const sub70 = Float32Array.from({ length: 48000 * 2 }, (_, i) => (10 ** (-75 / 20)) * Math.sin((2 * Math.PI * i) / 48));
    const subWav = join(dir, 'sub70.wav');
    const subBuf = Buffer.alloc(sub70.length * 8);
    for (let i = 0; i < sub70.length; i++) {
      subBuf.writeFloatLE(sub70[i], i * 8);
      subBuf.writeFloatLE(sub70[i], i * 8 + 4);
    }
    const enc = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-c:a', 'pcm_f32le', subWav], { input: subBuf });
    assert.equal(enc.status, 0);
    const offSub = (await audioLoudness(subWav)).value;
    assert.ok(Math.abs(measureAudioLoudness([sub70, sub70]).loudnessLufs - offSub) <= 0.35);
    assert.ok(Math.abs(measureL1AudioLoudness([sub70, sub70]).loudnessLufs - offSub) <= 0.35);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


