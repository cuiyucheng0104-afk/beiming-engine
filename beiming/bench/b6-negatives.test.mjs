// B6：B4 四道二级考题（5-1、18-1、18-2、15-2）的 12 份标准负对照（关卡、整体错位 2 帧、随机拍点）与判分核验。
// 正对照和负对照的读数都由 negatives/level-2-b/run-b6.mjs 在合成信号上量出来，判分走 evaluate-b4 的正式 score（不传第三个参数）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanQuestionLeaks } from './index.mjs';
import { median, readCameraStatic, readHits, readSubtitleLag } from './questions/level-2-b/evaluate-b4.mjs';
import {
  B6_FORMAT,
  B6_QUESTION_IDS,
  B6_NEGATIVE_KINDS,
  buildPositiveBaseline,
  evaluateAllB6Negatives,
  evaluateNegativeControl,
  evaluatePerturbedModel,
  loadControl,
  loadQuestion,
  measure,
  validateNegativeControl,
} from './negatives/level-2-b/run-b6.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEGATIVES = join(HERE, 'negatives/level-2-b');
const CONTROL_IDS = B6_QUESTION_IDS.flatMap((id) => B6_NEGATIVE_KINDS.map((kind) => `${id}-${kind}`));
// 整份文件只量一遍：4 份正对照、12 份负对照
const POSITIVE = Object.fromEntries(B6_QUESTION_IDS.map((id) => [id, buildPositiveBaseline(id)]));
const RESULTS = evaluateAllB6Negatives();
const resultOf = (id) => RESULTS.find(({ control }) => control.id === id);
const failedAt = (verdict) => verdict.items.flatMap((item, index) => (item.pass ? [] : [index]));

test('B6-1 正对照满分通过，12 份标准负对照（4 题 × 3 类）全部真实量测并判不过', () => {
  assert.deepEqual(B6_QUESTION_IDS, ['5-1', '18-1', '18-2', '15-2']);
  assert.deepEqual(B6_NEGATIVE_KINDS, ['disable-card', 'shift-2f', 'random-beats']);
  for (const qid of B6_QUESTION_IDS) {
    const pos = POSITIVE[qid];
    assert.equal(pos.verdict.pass, true, `${qid} 正对照必须满分通过`);
    assert.ok(Math.abs(pos.verdict.score - 1) < 1e-9);
    assert.deepEqual(failedAt(pos.verdict), []);
  }
  assert.equal(RESULTS.length, 12);
  assert.deepEqual(RESULTS.map(({ control }) => control.id), CONTROL_IDS);
  for (const r of RESULTS) {
    assert.equal(r.verdict.pass, false, `${r.control.id} 必须判不过`);
    assert.ok(r.verdict.score < 1, `${r.control.id} 得分必须低于满分`);
  }
});

test('B6-2 12 份夹具齐全，字段完整，种类和题面的 needs、种子对得上', () => {
  assert.deepEqual(readdirSync(NEGATIVES).sort(), [...CONTROL_IDS.map((id) => `${id}.json`), 'run-b6.mjs'].sort(), '目录里正好 12 份夹具和 1 个核验模块');
  for (const qid of B6_QUESTION_IDS) for (const kind of B6_NEGATIVE_KINDS) {
    const id = `${qid}-${kind}`, control = loadControl(id), q = loadQuestion(qid);
    assert.equal(validateNegativeControl(control), control, `${id} 过得了入口校验`);
    assert.deepEqual(Object.keys(control), ['format', 'id', 'questionId', 'kind', 'disabledCards', 'seed', 'description', 'perturbation', 'expectedFailedMetrics'], id);
    assert.deepEqual([control.format, control.id, control.questionId, control.kind], [B6_FORMAT, id, qid, kind]);
    assert.ok(typeof control.description === 'string' && control.description.length >= 10, `${id} 要写清故意做错了什么`);
    const changed = Object.entries(control.perturbation);
    assert.ok(changed.length >= 1, `${id} 没写改了哪个参数`);
    // 关卡的那一份点名关了题面 needs 里的哪几张卡；另外两种不关卡
    if (kind === 'disable-card') assert.ok(control.disabledCards.length >= 1 && control.disabledCards.every((card) => q.needs.includes(card)), `${id} 关的卡要在题面的 needs 里`);
    else assert.deepEqual(control.disabledCards, [], id);
    // 错位的那一份只改一个参数，值就是 2 帧；随机拍点的那一份只改一个参数，带整数种子，别的不带种子
    if (kind === 'shift-2f') assert.deepEqual(changed.map(([, value]) => value), [2], id);
    if (kind === 'random-beats') assert.deepEqual(changed.map(([, value]) => value), ['random-beats'], id);
    assert.equal(Number.isSafeInteger(control.seed), kind === 'random-beats', `${id} 的种子`);
    if (kind !== 'random-beats') assert.equal(control.seed, null, id);
    // 预期没过的判分项：scoring 的下标和指标名对得上题面，不重复，带一句原因
    assert.ok(control.expectedFailedMetrics.length >= 1, id);
    assert.equal(new Set(control.expectedFailedMetrics.map(({ scoring }) => scoring)).size, control.expectedFailedMetrics.length, id);
    for (const expected of control.expectedFailedMetrics) {
      assert.deepEqual(Object.keys(expected), ['scoring', 'metric', 'why'], id);
      assert.equal(q.scoring[expected.scoring]?.metric, expected.metric, `${id} 第 ${expected.scoring} 条判分线`);
      assert.ok(typeof expected.why === 'string' && expected.why.length >= 5, id);
    }
  }
});

// 读数里每个数组都非空、密实、没有附加属性，每个对象都是普通对象，每个叶子都是有限数
function assertSolid(value, path) {
  if (Array.isArray(value)) {
    assert.ok(value.length > 0, `${path} 是空数组`);
    assert.equal(Reflect.ownKeys(value).length, value.length + 1, `${path} 有空洞或附加属性`);
    for (let i = 0; i < value.length; i++) {
      assert.ok(Object.hasOwn(value, i), `${path}[${i}] 是空洞`);
      assertSolid(value[i], `${path}[${i}]`);
    }
  } else if (value !== null && typeof value === 'object') {
    assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path} 不是普通对象`);
    assert.ok(Object.keys(value).length > 0 && Reflect.ownKeys(value).length === Object.keys(value).length, `${path} 是空对象或带了隐藏的键`);
    for (const key of Object.keys(value)) assertSolid(value[key], `${path}.${key}`);
  } else assert.ok(Number.isFinite(value), `${path} 不是有限数：${String(value)}`);
}

test('B6-3 正对照和负对照的读数都完整、密实、全是有限数：判不过不是靠缺项、空洞、NaN 或坏格式', () => {
  // 每道题判分线要用的原始读数，一栏都不能少
  const fields = {
    '5-1': { 'music.align': ['corr', 'stretch', 'offsetSec'], 'beat.onset-hit': ['eventFrames', 'markFrames', 'range'] },
    '18-1': { 'narration.timing': ['appearSec', 'onsetsSec', 'spanSec', 'fadeFrames', 'leadSec', 'tailSec'], 'color.palette': ['shares'] },
    '18-2': { 'narration.timing': ['eventFrames', 'markFrames', 'range'] },
    '15-2': { 'meta.camera-static': ['cameras'], 'motion.zoom-pan': ['pairs'] },
  };
  for (const { questionId, readings, label } of [...Object.values(POSITIVE).map((pos) => ({ ...pos, label: `${pos.questionId} 正对照` })), ...RESULTS.map((r) => ({ ...r, label: r.control.id }))]) {
    const q = loadQuestion(questionId);
    assert.deepEqual(Object.keys(readings).sort(), [...new Set(q.scoring.map(({ metric }) => metric))].sort(), `${label} 的读数正好是题面的几个指标`);
    for (const [metric, keys] of Object.entries(fields[questionId])) assert.deepEqual(Object.keys(readings[metric]), keys, `${label} ${metric}`);
    assertSolid(readings, label);
    // 过一遍 JSON 原样回来：没有 NaN、undefined、空洞、类型化数组混在里面
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(readings))), JSON.stringify(readings), label);
    // 帧号、时刻都在题目自己的时间线里，没有靠出界判不过的
    const { frames } = q.deliverable, timing = readings['narration.timing'] ?? {}, hit = readings['beat.onset-hit'] ?? timing;
    for (const frame of [...(hit.eventFrames ?? []), ...(hit.markFrames ?? [])]) assert.ok(frame >= 0 && frame < frames, `${label} 第 ${frame} 帧出界`);
    for (const at of [...(timing.appearSec ?? []), ...(timing.onsetsSec ?? [])]) assert.ok(at >= 0 && at <= frames / 30, `${label} ${at} 秒出界`);
    if (questionId === '15-2') {
      assert.equal(readings['meta.camera-static'].cameras.length, frames, `${label} 相机矩阵一帧不少`);
      assert.equal(readings['motion.zoom-pan'].pairs.length, q.scoring[1].args.pairs.length, `${label} 两对帧都量到`);
    }
    if (questionId === '18-1') {
      const { fadeFrames, leadSec, tailSec } = timing;
      assert.ok(fadeFrames.length >= 2 && leadSec.length >= 3 && tailSec.length === leadSec.length && readings['color.palette'].shares.length >= 3, `${label} 场景量全了`);
    }
    if (questionId === '18-2') assert.equal(timing.markFrames.length, q.scoring[0].args.moves, `${label} 运镜正好两次，不是靠次数不对判不过`);
  }
});

// 5-1、18-2：每个应起帧（事件帧减题面的提前量）离对应记号的帧数，照判分线的算法
function hitOffsets(q, reading) {
  const args = q.scoring.find((item) => item.args.events !== undefined).args;
  const expected = reading.eventFrames.map((frame, i) => frame - (args.leadFrames?.[i] ?? 0));
  return { tol: args.tolFrames, offsets: readHits(expected, reading.markFrames, [0, q.deliverable.frames], args.tolFrames).offsetsFrames };
}
const lagOf = (q, timing) => readSubtitleLag(timing.appearSec, timing.onsetsSec, q.deliverable.frames / 30, q.scoring[0].args.maxSubtitleLagSec);
const still = ({ scale, dx, dy }) => scale === 1 && dx === 0 && dy === 0;
// 每份负对照的读数里，故障留下的痕迹：击穿判分线的是这个数，不是别的
const MECHANISM = {
  '5-1-disable-card': (q, r, base) => {
    assert.deepEqual([r['music.align'].stretch, r['music.align'].offsetSec], [1, 0], '量回没拉伸、没平移');
    assert.ok(r['music.align'].corr >= q.scoring[0].args.minCorr, '相关够，配乐对位那条不是因为量不准才过的');
    assert.deepEqual(hitOffsets(q, r['beat.onset-hit']).offsets, [4]);
    assert.deepEqual(r['beat.onset-hit'].eventFrames, base['beat.onset-hit'].eventFrames, '硬切没动');
  },
  '5-1-shift-2f': (q, r, base) => {
    assert.deepEqual(r['beat.onset-hit'].markFrames, base['beat.onset-hit'].markFrames.map((frame) => frame + 2), '每个重击峰都晚 2 帧');
    assert.deepEqual(r['beat.onset-hit'].eventFrames, [624]);
    assert.deepEqual([hitOffsets(q, base['beat.onset-hit']).offsets, hitOffsets(q, r['beat.onset-hit']).offsets], [[1], [3]]);
    assert.equal(r['music.align'].stretch, base['music.align'].stretch);
    assert.ok(Math.abs(r['music.align'].offsetSec - base['music.align'].offsetSec - 2 / 24) < 0.011, '对位量回的平移多了 2 帧（20 毫秒一格）');
  },
  '5-1-random-beats': (q, r, base) => {
    assert.equal(r['beat.onset-hit'].markFrames.length, base['beat.onset-hit'].markFrames.length, '重击的下数不变');
    assert.notDeepEqual(r['beat.onset-hit'].markFrames, base['beat.onset-hit'].markFrames);
    assert.deepEqual(hitOffsets(q, r['beat.onset-hit']).offsets, [17]);
    assert.equal(r['music.align'].stretch, base['music.align'].stretch);
  },
  '18-1-disable-card': (q, r, base) => {
    const t = r['narration.timing'], palette = r['color.palette'];
    assert.ok(lagOf(q, t).subtitleLagSec > 1, `字幕滞后的中位数 ${lagOf(q, t).subtitleLagSec}`);
    assert.deepEqual(t.fadeFrames, [0, 0, 0, 0]);
    assert.ok(palette.shares.every((share) => share >= 0.17 && share < 0.19), JSON.stringify(palette.shares));
    assert.deepEqual([t.onsetsSec, t.leadSec, t.tailSec], [base['narration.timing'].onsetsSec, base['narration.timing'].leadSec, base['narration.timing'].tailSec], '旁白和留白没动');
  },
  '18-1-shift-2f': (q, r, base) => {
    const t = r['narration.timing'], b = base['narration.timing'], line = q.scoring[0].args.maxSubtitleLagSec;
    assert.ok(t.appearSec.every((at, i) => Math.abs(at - b.appearSec[i] - 2 / 30) < 1e-9), '每块字幕都晚 2 帧');
    assert.ok(t.appearSec.every((at, i) => at - t.onsetsSec[i] >= 2 / 30 - 1e-9 && at - t.onsetsSec[i] > line), '每块都超线');
    assert.equal(lagOf(q, t).hitRate, 0);
    assert.ok(lagOf(q, b).subtitleLagSec <= 1 / 30 && lagOf(q, b).hitRate === 1, '正对照每块都在一帧之内');
    assert.deepEqual([t.onsetsSec, t.fadeFrames, t.leadSec, t.tailSec], [b.onsetsSec, b.fadeFrames, b.leadSec, b.tailSec], '别的都没动');
  },
  '18-1-random-beats': (q, r, base) => {
    const t = r['narration.timing'], b = base['narration.timing'];
    assert.equal(t.appearSec.length, b.appearSec.length, '字幕块数不变');
    assert.ok(lagOf(q, t).subtitleLagSec > 10 * q.scoring[0].args.maxSubtitleLagSec, `字幕滞后的中位数 ${lagOf(q, t).subtitleLagSec}`);
    assert.deepEqual([t.onsetsSec, t.fadeFrames, t.leadSec, t.tailSec], [b.onsetsSec, b.fadeFrames, b.leadSec, b.tailSec], '别的都没动');
    assert.ok(r['color.palette'].shares.every((share) => share >= 0.75 && share <= 0.85), '底色占比仍在线内');
  },
  '18-2-disable-card': (q, r) => {
    assert.deepEqual(r['narration.timing'].markFrames, r['narration.timing'].eventFrames, '运镜起在触发词上');
    assert.deepEqual(hitOffsets(q, r['narration.timing']).offsets, q.scoring[0].args.leadFrames, '差的正好是没提前的那 15 帧和 27 帧');
  },
  '18-2-shift-2f': (q, r, base) => {
    assert.deepEqual(r['narration.timing'].markFrames, base['narration.timing'].markFrames.map((frame) => frame + 2));
    assert.deepEqual([hitOffsets(q, base['narration.timing']).offsets, hitOffsets(q, r['narration.timing']).offsets], [[0, 0], [2, 2]]);
  },
  '18-2-random-beats': (q, r, base) => {
    assert.deepEqual(r['narration.timing'].eventFrames, base['narration.timing'].eventFrames, '触发词没动');
    assert.deepEqual(hitOffsets(q, r['narration.timing']).offsets, [37, 20]);
  },
  '15-2-disable-card': (q, r) => {
    assert.deepEqual(readCameraStatic(r['meta.camera-static'].cameras), { frames: 300, changedAt: 1 });
    const [, last] = r['motion.zoom-pan'].pairs;
    assert.deepEqual([last.scale, last.dx, last.dy], [1.025, -5, 2], '末帧量回推近（分辨率 0.025）和平移');
    assert.ok(r['motion.zoom-pan'].pairs.every((pair) => !still(pair) && pair.error < pair.stillError));
  },
  '15-2-shift-2f': (q, r) => {
    assert.deepEqual(readCameraStatic(r['meta.camera-static'].cameras), { frames: 300, changedAt: 2 });
    assert.ok(r['motion.zoom-pan'].pairs.every((pair) => pair.scale === 1 && Math.abs(pair.dx) === 2 && pair.dy === 0), JSON.stringify(r['motion.zoom-pan'].pairs));
  },
  '15-2-random-beats': (q, r) => {
    const { frames, changedAt } = readCameraStatic(r['meta.camera-static'].cameras);
    assert.ok(frames === 300 && changedAt >= 1, `第 ${changedAt} 帧起机位变了`);
    assert.ok(r['motion.zoom-pan'].pairs.every((pair) => !still(pair) && Math.hypot(pair.dx, pair.dy) > q.scoring[1].args.maxPanPx));
  },
};

test('B6-4 击穿的判分项和夹具写的一一对应，得分是剩下几项的权重；读数里留着故障的痕迹', () => {
  assert.deepEqual(Object.keys(MECHANISM), CONTROL_IDS);
  for (const { control, questionId, readings, verdict, failedAsDeclared } of RESULTS) {
    const q = loadQuestion(questionId);
    assert.equal(failedAsDeclared, true, `${control.id} 入口自己也报「没过的就是夹具写的那几条」`);
    assert.deepEqual(failedAt(verdict), control.expectedFailedMetrics.map(({ scoring }) => scoring), `${control.id} 没过的判分项`);
    assert.deepEqual(verdict.items.filter((item) => !item.pass).map((item) => item.metric), control.expectedFailedMetrics.map(({ metric }) => metric), control.id);
    const kept = q.scoring.reduce((sum, { weight }, index) => sum + (failedAt(verdict).includes(index) ? 0 : weight), 0);
    assert.ok(Math.abs(verdict.score - kept) < 1e-9, `${control.id} 得分 ${verdict.score}`);
    MECHANISM[control.id](q, readings, POSITIVE[questionId].readings);
  }
  // 正对照自己的读数：硬切量回第 624 帧，两次运镜量回应起帧，淡出 3 到 4 帧，底色八成，机位没动
  assert.deepEqual(POSITIVE['5-1'].readings['beat.onset-hit'].eventFrames, [624]);
  assert.deepEqual(POSITIVE['5-1'].readings['music.align'], { corr: POSITIVE['5-1'].readings['music.align'].corr, stretch: 1.009, offsetSec: -0.02 });
  assert.deepEqual(POSITIVE['18-2'].readings['narration.timing'], { eventFrames: [240, 546], markFrames: [225, 519], range: [0, 600] });
  assert.deepEqual(POSITIVE['18-1'].readings['narration.timing'].fadeFrames, [3, 4, 3, 4]);
  assert.ok(Math.abs(median(POSITIVE['18-1'].readings['color.palette'].shares) - 0.8) < 0.01);
  assert.deepEqual(readCameraStatic(POSITIVE['15-2'].readings['meta.camera-static'].cameras), { frames: 300, changedAt: null });
  assert.ok(POSITIVE['15-2'].readings['motion.zoom-pan'].pairs.every((pair) => still(pair) && pair.error === pair.stillError && pair.error > 0));
});

test('B6-5 一份负对照一类故障：读数只跟着夹具里写的参数变，去掉就是正对照；关卡带几个参数的逐个拆开各打穿各的线；随机拍点真的跟种子走', () => {
  // 去掉改动走模型实验入口（正式入口不收空的 perturbation）：零改动重跑就是正对照
  for (const qid of B6_QUESTION_IDS) {
    const undone = evaluatePerturbedModel(qid, {});
    assert.equal(JSON.stringify(undone.readings), JSON.stringify(POSITIVE[qid].readings), `${qid} 去掉改动就是正对照的读数`);
    assert.equal(undone.verdict.pass, true, qid);
  }
  for (const id of CONTROL_IDS) {
    const control = loadControl(id);
    // 正式入口的读数只由夹具的 perturbation 和种子决定：同样的参数直接喂给模型，重跑逐字相同
    assert.equal(JSON.stringify(evaluatePerturbedModel(control.questionId, control.perturbation, control.seed).readings), JSON.stringify(resultOf(id).readings), `${id} 读数只跟着 perturbation 和种子走`);
    if (control.kind === 'random-beats') {
      const reseeded = evaluateNegativeControl({ ...control, seed: control.seed + 1 });
      assert.notEqual(JSON.stringify(reseeded.readings), JSON.stringify(resultOf(id).readings), `${id} 换种子读数跟着变`);
      assert.throws(() => evaluateNegativeControl({ ...control, seed: null }), RangeError, `${id} 没有种子不出读数`);
    } else assert.throws(() => evaluateNegativeControl({ ...control, seed: 7 }), RangeError, `${id} 不是随机拍点，不带种子`);
  }
  // 关卡的那几份可以带不止一个参数（一张卡管的事对着几个参数，或者一次关几张卡）；逐个拆开单独施加，各自打穿的线合起来正好是整份打穿的线
  const alone = (qid, perturbation) => failedAt(evaluatePerturbedModel(qid, perturbation).verdict);
  assert.deepEqual(Object.entries(loadControl('18-1-disable-card').perturbation).map(([key, value]) => alone('18-1', { [key]: value })), [[0], [1], [3]]);
  // 5-1：不拉伸单独就够让重击落空；不平移（正对照只平移了 0.02 秒，不到一帧）单独不起作用，两个一起才是「没对位」
  assert.deepEqual(Object.entries(loadControl('5-1-disable-card').perturbation).map(([key, value]) => alone('5-1', { [key]: value })), [[1], []]);
  // 夹具写了模型没有的参数、想从 perturbation 里塞种子、题号不认识：报错，不悄悄退回正对照
  assert.throws(() => measure('5-1', { audioShiftFrame: 2 }), RangeError);
  assert.throws(() => measure('5-1', { seed: 1 }), RangeError);
  assert.throws(() => measure('7-1'), RangeError);
  // 选做法的参数写错了值（少个字母、大小写不对）同样报错，四个模型一个口径
  for (const [qid, perturbation] of [['5-1', { hitTrigger: 'random-beat' }], ['18-1', { subtitleTrigger: 'fixed' }], ['18-2', { moveTrigger: 'On-Cue' }], ['15-2', { cameraPath: 'Drift' }]]) {
    assert.throws(() => measure(qid, perturbation), RangeError, JSON.stringify(perturbation));
  }
});

test('B6-6 贴线和靠模型假设的如实记下：5-1、18-1 的 2 帧错位只在偏晚的方向判不过，18-2 两个方向都判不过，15-2 判不过和「2 帧」无关', () => {
  const verdict = (id, perturbation) => evaluatePerturbedModel(id, perturbation).verdict;
  // 5-1 的容差就是 2 帧：正对照的重击峰偏晚 1 帧，再晚 2 帧出界，早 2 帧还在界内
  assert.equal(verdict('5-1', { audioShiftFrames: -2 }).pass, true);
  assert.equal(verdict('5-1', { audioShiftFrames: 3 }).pass, false);
  // 18-1 的线是 0.063 秒，2 帧是 0.0667 秒：正对照的字幕不早于起声，再晚 2 帧每块都超线，早 2 帧时中位数落回线内
  assert.equal(verdict('18-1', { subtitleShiftFrames: -2 }).pass, true);
  assert.equal(verdict('18-1', { subtitleShiftFrames: -3 }).pass, false);
  for (const text of [loadControl('5-1-shift-2f').description, loadControl('18-1-shift-2f').description]) assert.match(text, /贴线说明/, '夹具里写明了这一点');
  // 18-2 的容差是 1 帧，正对照正好起在应起帧上
  assert.equal(verdict('18-2', { moveShiftFrames: -2 }).pass, false);
  assert.equal(verdict('18-2', { moveShiftFrames: 1 }).pass, true);
  // 15-2：锁死的机位整体错位本身看不出来；这份靠模型假设的「锁定前机位在别处」，晚 1 帧生效一样判不过
  assert.equal(verdict('15-2', { lockShiftFrames: 1 }).pass, false);
  assert.match(loadControl('15-2-shift-2f').description, /模型假设说明/, '夹具里写明了这一点');
});

/* ---------------- 夹具入口的严格校验 ---------------- */

// 每条：从哪份合法夹具出发、只改哪一处、该抛哪种错。类型不对抛 TypeError，类型对但值不收抛 RangeError
const MUTATIONS = [
  // 首审的五项
  ['18-2-shift-2f', '帧数写成字符串', (c) => { c.perturbation.moveShiftFrames = '2'; }, TypeError],
  ['5-1-disable-card', '拉伸比写成字符串 1', (c) => { c.perturbation.stretch = '1'; }, TypeError],
  ['5-1-disable-card', '拉伸比写成字符串 1.05', (c) => { c.perturbation.stretch = '1.05'; }, TypeError],
  ['18-2-shift-2f', '删掉 perturbation', (c) => { delete c.perturbation; }, TypeError],
  ['18-2-shift-2f', 'perturbation 是空对象', (c) => { c.perturbation = {}; }, RangeError],
  ['18-2-shift-2f', 'id 没登记', (c) => { c.id = '18-2-shift-3f'; }, RangeError],
  ['18-2-shift-2f', 'id 和题号、种类对不上', (c) => { c.id = '18-1-shift-2f'; }, RangeError],
  ['18-2-shift-2f', 'format 被改', (c) => { c.format = 'bench-negative/0.2'; }, RangeError],
  ['18-2-shift-2f', 'expectedFailedMetrics 清空', (c) => { c.expectedFailedMetrics = []; }, RangeError],
  ['18-2-shift-2f', '不是随机拍点却带字符串种子', (c) => { c.seed = '7'; }, TypeError],
  // 同一类口子的其余写法
  ['5-1-shift-2f', '不是随机拍点却带 NaN 种子', (c) => { c.seed = NaN; }, RangeError],
  ['15-2-random-beats', '随机拍点的种子是字符串', (c) => { c.seed = '20261123'; }, TypeError],
  ['15-2-random-beats', '随机拍点的种子不是整数', (c) => { c.seed = 1.5; }, RangeError],
  ['18-2-shift-2f', 'perturbation 是数组', (c) => { c.perturbation = [2]; }, TypeError],
  ['18-2-shift-2f', 'perturbation 是 null', (c) => { c.perturbation = null; }, TypeError],
  ['18-2-shift-2f', '帧数是 NaN', (c) => { c.perturbation.moveShiftFrames = NaN; }, RangeError],
  ['18-2-shift-2f', '帧数不是整数', (c) => { c.perturbation.moveShiftFrames = 2.5; }, RangeError],
  ['18-2-shift-2f', '错位不是 2 帧', (c) => { c.perturbation.moveShiftFrames = 3; }, RangeError],
  ['18-2-shift-2f', '错位写了 0 帧，等于没改', (c) => { c.perturbation.moveShiftFrames = 0; }, RangeError],
  ['18-2-shift-2f', '错位的那份多带一个参数', (c) => { c.perturbation.moveTrigger = 'on-cue'; }, RangeError],
  ['18-2-shift-2f', '多了模型没有的参数', (c) => { c.perturbation.frameShift = 2; }, RangeError],
  ['5-1-disable-card', '拉伸比是无穷大', (c) => { c.perturbation.stretch = Infinity; }, RangeError],
  ['5-1-disable-card', '拉伸比是零', (c) => { c.perturbation.stretch = 0; }, RangeError],
  ['5-1-disable-card', '拉伸比是负数', (c) => { c.perturbation.stretch = -1; }, RangeError],
  ['5-1-disable-card', '参数和正对照一样，等于没改', (c) => { c.perturbation = { audioShiftFrames: 0 }; }, RangeError],
  ['18-1-disable-card', '布尔参数写成数', (c) => { c.perturbation.pageCanvas = 0; }, TypeError],
  ['18-1-disable-card', '淡出帧数少一场', (c) => { c.perturbation.sceneFadeFrames = [0, 0, 0]; }, RangeError],
  ['18-1-disable-card', '淡出帧数里混进字符串', (c) => { c.perturbation.sceneFadeFrames = [0, '0', 0, 0]; }, TypeError],
  ['18-1-disable-card', '淡出帧数不是数组', (c) => { c.perturbation.sceneFadeFrames = 0; }, TypeError],
  ['18-1-disable-card', '选做法的参数写成数', (c) => { c.perturbation.subtitleTrigger = 1; }, TypeError],
  ['18-1-disable-card', '关卡的那份混进随机拍点', (c) => { c.perturbation.subtitleTrigger = 'random-beats'; }, RangeError],
  ['18-1-random-beats', '随机拍点的那份没换成随机拍点', (c) => { c.perturbation.subtitleTrigger = 'fixed-interval'; }, RangeError],
  ['18-2-disable-card', '关卡的那份没点名关哪张卡', (c) => { c.disabledCards = []; }, RangeError],
  ['18-2-disable-card', '关的卡不在题面的 needs 里', (c) => { c.disabledCards = ['camera.nope']; }, RangeError],
  ['18-2-disable-card', 'disabledCards 不是数组', (c) => { c.disabledCards = 'camera.cue-kf'; }, TypeError],
  ['18-2-shift-2f', '不是关卡却点名关了卡', (c) => { c.disabledCards = ['camera.cue-kf']; }, RangeError],
  ['18-2-shift-2f', 'kind 不认识', (c) => { c.kind = 'shift-3f'; c.id = '18-2-shift-3f'; }, RangeError],
  ['18-2-shift-2f', '题号不认识', (c) => { c.questionId = '7-1'; c.id = '7-1-shift-2f'; }, RangeError],
  ['18-2-shift-2f', 'description 是空的', (c) => { c.description = ' '; }, RangeError],
  ['18-2-shift-2f', 'description 不是字符串', (c) => { c.description = 2; }, TypeError],
  ['18-2-shift-2f', 'expectedFailedMetrics 不是数组', (c) => { c.expectedFailedMetrics = 'narration.timing'; }, TypeError],
  ['18-2-shift-2f', '预期没过的指标名对不上题面', (c) => { c.expectedFailedMetrics[0].metric = 'beat.onset-hit'; }, RangeError],
  ['18-2-shift-2f', '预期没过的判分线下标出界', (c) => { c.expectedFailedMetrics[0].scoring = 1; }, RangeError],
  ['18-2-shift-2f', '预期没过的判分线下标是字符串', (c) => { c.expectedFailedMetrics[0].scoring = '0'; }, TypeError],
  ['15-2-shift-2f', '预期没过的判分线写了两遍', (c) => { c.expectedFailedMetrics[1] = { ...c.expectedFailedMetrics[0] }; }, RangeError],
  ['18-2-shift-2f', '少一栏', (c) => { delete c.description; }, TypeError],
  ['18-2-shift-2f', '多一栏', (c) => { c.note = '多出来的'; }, RangeError],
  // 二审的三项：每份只认登记的那组卡、那组参数，故障种类不能互相冒充
  ['18-2-disable-card', '关的卡换成题面里另一张不相干的卡', (c) => { c.disabledCards = ['time.narration']; }, RangeError],
  ['18-2-disable-card', '关卡的那份其实做的是错位 2 帧', (c) => { c.perturbation = { moveShiftFrames: 2 }; }, RangeError],
  ['18-2-disable-card', '关卡的那份混进错位（把一次运镜推出片外）', (c) => { c.perturbation.moveShiftFrames = 100; }, RangeError],
  // 同一类口子的其余写法
  ['18-2-disable-card', '关的卡多点一张', (c) => { c.disabledCards.push('time.narration'); }, RangeError],
  ['18-2-disable-card', '同一张卡点两遍', (c) => { c.disabledCards.push('camera.cue-kf'); }, RangeError],
  ['18-1-disable-card', '关的卡少点一张', (c) => { c.disabledCards.pop(); }, RangeError],
  ['5-1-disable-card', '关掉对位却还带着拉伸', (c) => { c.perturbation.stretch = 1.02; }, RangeError],
  ['15-2-disable-card', '关卡的那份其实做的是锁机位晚生效', (c) => { c.perturbation = { lockShiftFrames: 2 }; }, RangeError],
  ['18-2-shift-2f', '错位的方向反了（登记的是晚 2 帧）', (c) => { c.perturbation.moveShiftFrames = -2; }, RangeError],
  ['18-2-shift-2f', '错位的那份其实做的是关卡', (c) => { c.perturbation = { moveTrigger: 'on-cue' }; }, RangeError],
  ['18-1-random-beats', '随机拍点的那份混进错位', (c) => { c.perturbation.subtitleShiftFrames = 2; }, RangeError],
];

test('B6-8 正式入口先验夹具再量：类型不对、缺栏、没登记的 id、空改动都直接抛错，不出 0 分也不出满分', () => {
  for (const [id, what, mutate, Kind] of MUTATIONS) {
    const control = structuredClone(loadControl(id));
    assert.equal(validateNegativeControl(control), control, `${id} 没动之前是合法的`);
    mutate(control);
    for (const entry of [validateNegativeControl, evaluateNegativeControl]) {
      assert.throws(() => entry(control), (error) => error.constructor === Kind, `${id} ${what}：${entry.name} 要抛 ${Kind.name}`);
    }
  }
  // 夹具合法、但写的预期和实际没过的判分项对不上：照量照判，不抛错，入口报 failedAsDeclared === false，调用方不会把它数成「照预期拦住了」
  for (const [id, mutate] of [
    ['18-1-disable-card', (c) => { delete c.perturbation.pageCanvas; }],
    ['18-1-disable-card', (c) => { c.expectedFailedMetrics.pop(); }],
    ['18-1-shift-2f', (c) => { c.expectedFailedMetrics[0].scoring = 2; }],
    ['5-1-disable-card', (c) => { delete c.perturbation.stretch; }],
    // 没过的判分线和夹具写的一样，但读数不是「这张卡关掉了」的样子（关得不全）：同样记 false
    ['5-1-disable-card', (c) => { delete c.perturbation.offsetSec; }],
    ['18-1-disable-card', (c) => { delete c.perturbation.pageCanvas; c.expectedFailedMetrics.pop(); }],
  ]) {
    const control = structuredClone(loadControl(id));
    mutate(control);
    assert.equal(evaluateNegativeControl(control).failedAsDeclared, false, `${id} 预期和实际对不上`);
  }
  // 整份不是普通对象
  for (const bad of [null, undefined, 7, [], [loadControl('5-1-shift-2f')], new Map()]) assert.throws(() => evaluateNegativeControl(bad), TypeError, String(bad));
  // 字符串入口和对象入口一个口径：没登记的 id 抛 RangeError，不去读盘，也不能借路径读到别的文件
  for (const id of ['18-2-shift-3f', '7-1-shift-2f', '', '../../questions/level-2-b/5-1', '5-1-shift-2f.json']) {
    assert.throws(() => evaluateNegativeControl(id), RangeError, id);
    assert.throws(() => loadControl(id), RangeError, id);
  }
  // 模型实验入口同样不收写错类型的参数，也不收错类型的种子
  assert.throws(() => evaluatePerturbedModel('18-2', { moveShiftFrames: '2' }), TypeError);
  assert.throws(() => evaluatePerturbedModel('5-1', { stretch: '1' }), TypeError);
  assert.throws(() => evaluatePerturbedModel('5-1', { audioShiftFrames: 0.5 }), RangeError);
  assert.throws(() => evaluatePerturbedModel('5-1', null), TypeError);
  assert.throws(() => evaluatePerturbedModel('5-1', {}, '7'), TypeError);
  assert.throws(() => evaluatePerturbedModel('5-1', {}, NaN), RangeError);
  assert.throws(() => measure('15-2', { lockShiftFrames: '2' }), TypeError);
  // 参数类型都对、但大到把事件挪出片外：量回来是空的，不交给判分（否则「一次也没量到」会被记成「判分线拦住了」）
  assert.throws(() => evaluatePerturbedModel('18-2', { moveShiftFrames: 100000 }), RangeError);
  assert.throws(() => evaluatePerturbedModel('18-1', { subtitleShiftFrames: 100000 }), RangeError);
});

test('B6-9 每次核验互不相干：改坏一次实验回来的参数和读数、改坏导出的清单，后面的正对照和负对照照旧', () => {
  // 二审的反例：把实验回来的淡出帧数表原地清零，正对照不能跟着掉分
  evaluatePerturbedModel('18-1', {}).params.sceneFadeFrames.fill(0);
  assert.equal(buildPositiveBaseline('18-1').verdict.score, 1);
  const again = evaluateNegativeControl('18-1-disable-card');
  assert.deepEqual([again.verdict.pass, again.failedAsDeclared], [false, true]);
  // 四道题一个口径：回来的参数、读数每个叶子都改成 0，再量一遍正对照，读数逐字不变
  const scribble = (value) => { for (const key of Object.keys(value)) { if (value[key] !== null && typeof value[key] === 'object') scribble(value[key]); else value[key] = 0; } };
  for (const qid of B6_QUESTION_IDS) {
    const { params, readings } = evaluatePerturbedModel(qid, {});
    scribble(params); scribble(readings);
    assert.equal(JSON.stringify(buildPositiveBaseline(qid).readings), JSON.stringify(POSITIVE[qid].readings), qid);
  }
  // 正式入口回来的参数是另一份：改它动不到调用方手里的夹具，也动不到下一次核验
  const control = structuredClone(loadControl('18-1-disable-card')), judged = evaluateNegativeControl(control);
  judged.params.sceneFadeFrames.fill(9); scribble(judged.readings);
  assert.deepEqual(control.perturbation.sceneFadeFrames, [0, 0, 0, 0]);
  assert.equal(JSON.stringify(evaluateNegativeControl(control).readings), JSON.stringify(resultOf('18-1-disable-card').readings));
  // 导出的题号和种类清单改不动
  assert.throws(() => B6_QUESTION_IDS.push('7-1'), TypeError);
  assert.throws(() => B6_NEGATIVE_KINDS.pop(), TypeError);
  assert.deepEqual(evaluateAllB6Negatives().map(({ control: { id } }) => id), CONTROL_IDS);
});

/* ---------------- 泄露与专名 ---------------- */

// 案例专名只以小写词元的 SHA-256 前 24 位存在 B4 的测试文件里（明文不进仓库）。这里不另抄一份表，直接从那个文件的原文里取全部 24 位前缀，分词口径照 B4 的写法。
// shortcut: 靠 B4 测试里哈希写成带引号的 24 位十六进制字面量；那张表搬走或换写法时，下面「至少 50 个」的断言会红，届时改成从公共模块引
const NOUN_HASHES = new Set((readFileSync(join(HERE, 'b4-questions.test.mjs'), 'utf8').match(/'[0-9a-f]{24}'/g) ?? []).map((quoted) => quoted.slice(1, -1)));
const tokenHash = (token) => createHash('sha256').update(token).digest('hex').slice(0, 24);
function scanProperNouns(text) {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '').split('\n').flatMap((line, index) => {
    const tokens = (line.match(/\p{Script=Han}+|\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})/gu) ?? []).flatMap((run) => (/\p{Script=Han}/u.test(run)
      ? [2, 3, 4].flatMap((size) => Array.from({ length: Math.max(0, run.length - size + 1) }, (_, i) => run.slice(i, i + size)))
      : [run.toLowerCase()]));
    return [...new Set(tokens)].some((token) => NOUN_HASHES.has(tokenHash(token))) ? [index + 1] : [];
  });
}

test('B6-7 12 份夹具、核验模块和本测试文件零泄露、零私有路径、零案例专名', () => {
  assert.ok(NOUN_HASHES.size >= 50, `专名哈希只取到 ${NOUN_HASHES.size} 个`);
  // 扫描器自己先验一遍：B4 表里的两个假词元现拼出来必须报警（源码里不连着写）
  const word = ['zqx', 'canary'].join(''), han = ['甲乙', '丙丁'].join('');
  assert.deepEqual(scanProperNouns(`第一行\n// ${word.toUpperCase()}\n{"note":"${han}"}`), [2, 3]);
  // 私有路径的几种开头也现拼，免得本文件自己撞上
  const privatePaths = new RegExp(['复刻', '调研资料', 'lab:/', '/Users', '/home'].map((head) => `${head}/`).join('|'), 'u');
  assert.match(['复刻', '某片'].join('/'), privatePaths);
  const files = [...readdirSync(NEGATIVES).map((name) => join(NEGATIVES, name)), fileURLToPath(import.meta.url)];
  assert.equal(files.length, 14, '12 份夹具、1 个核验模块、1 个测试');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.deepEqual(scanQuestionLeaks(text), [], `${file} 有泄露`);
    assert.doesNotMatch(text, privatePaths, `${file} 里有私有路径`);
    assert.deepEqual(scanProperNouns(text), [], `${file} 里有案例专名`);
  }
  // 夹具对象本身也过一遍泄露门禁（对象口径）
  for (const id of CONTROL_IDS) assert.deepEqual(scanQuestionLeaks(loadControl(id)), [], id);
});
