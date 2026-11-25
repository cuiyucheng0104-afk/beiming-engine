import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { scanQuestionLeaks, validateQuestion } from './validate-question.mjs';
import { scoreLevel3 } from './questions/level-3/evaluate-b17.mjs';
import { buildLevel3Reading, readLevel3Film, runLevel3Controls } from './solutions/level-3/run-b17.mjs';
import { decodeAllFramesGray, encodeRawFramesStream, encodeSpecFor, hasMediaTools, probeDeliverableSpec } from './solutions/media.mjs';
import { runExam } from './exam.mjs';
import { discoverQuestions, discoverSuiteQuestions, planFullExam2, runFullExam2 } from './index.mjs';

const bench = import.meta.dirname;
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(bench, ...parts), 'utf8'));
const cases = [['3-1', '03B-1', true], ['31-1', 'X7-1', true], ['1-2', '01-2', false]];

for (const [id, code, included] of cases) {
  test(`${code} 三级题、阶段验收标记和 T3 预算`, () => {
    const question = read('questions', 'level-3', `${id}.json`);
    assert.equal(validateQuestion(question).ok, true);
    assert.equal(question.id, id);
    assert.equal(question.level, 3);
    assert.equal(question.ext['bench.code'], code);
    assert.equal(question.ext['bench.m3AcceptanceIncluded'], included);
    assert.deepEqual(question.budget, { tokens: 1800000, wallMs: 2400000, gpuSeconds: 300 });
    const ref = read('refs', 'level-3', `${id}.json`);
    assert.equal(ref.question, id);
    assert.deepEqual(scanQuestionLeaks(ref), []);
    const film = readLevel3Film(question); // 同时跑 film schema / filmChecks 与 needs 对齐。
    assert.deepEqual(film.output, { size: question.deliverable.size, fps: question.deliverable.fps, frames: question.deliverable.frames });
    assert.ok(scoreLevel3(question, ref.readings).pass);
  });

  test(`${code} 真实卡运行满分，独立撤卡后仍有有效量测但不合格`, () => {
    const question = read('questions', 'level-3', `${id}.json`);
    const { positive, negatives } = runLevel3Controls(question);
    assert.equal(positive.score, 1);
    assert.equal(positive.pass, true);
    const extra = id === '31-1' ? ['cut'] : id === '1-2' ? ['camera.fit'] : [];
    assert.deepEqual(Object.keys(negatives).sort(), [...question.needs, ...extra].sort());
    for (const [control, verdict] of Object.entries(negatives)) {
      assert.ok(verdict.valid && !verdict.pass && verdict.score < 1, `${id}/${control}：${verdict.score}`);
    }
  });
}

function probe(id, change) {
  const q = read('questions', 'level-3', `${id}.json`);
  const { readings } = read('refs', 'level-3', `${id}.json`);
  change(q, readings);
  return scoreLevel3(q, readings);
}

test('读数不允许空洞、缺帧、NaN、倒置边界；时间常数、接触和基础谓词按实际加载的阈值计算', () => {
  for (const [id, corrupt] of [
    ['3-1', r => { delete r.frames[120]; }], ['3-1', r => { r.frames[0].positions[0][0] = NaN; }],
    ['31-1', r => { r.takes[1].centers.pop(); }], ['31-1', r => { r.takes[0].boxes[0] = [20, 20, 5, 10]; }],
    ['1-2', r => { r.frames[72].materialMask = ''; }],
  ]) assert.equal(probe(id, (_, r) => { corrupt(r); r.pass = true; r.score = 1; }).score, 0);
  const gap = probe('3-1', (_, r) => { r.frames[179].gapsM[1] = -0.00051; });
  assert.equal(gap.score, 0.75);
  assert.equal(gap.base.find(p => p.predicate.startsWith('no_intersect')).pass, false);
  assert.equal(probe('3-1', q => { q.scoring[1].args.tauFrames = [1, 2]; }).score, 0.7);
  const base = probe('3-1', q => { q.basePredicates.push('camera.height >= 100 @ [0,1)'); });
  assert.equal(base.score, 1); assert.equal(base.pass, false);
});

test('换机位证据、质心、切点像素和带掩膜材质像素不能用自报极值代替', () => {
  for (const [id, mutate, metric] of [
    ['31-1', r => { r.takes[1].anchors[51] = [...r.takes[0].anchors[51]]; }, 'camera.displacement'],
    ['31-1', r => { r.takes[1].centers[71][0] += 3; }, 'overlay.tracking'],
    ['31-1', r => { r.takes[1].overlayKey = 'a'.repeat(24); }, 'overlay.tracking'],
    ['31-1', r => { r.takes[0].corners[72] = [28, 52, 124]; }, 'edit.hard-cut'],
    ['1-2', r => { r.frames[33].lumaRaster = Buffer.alloc(48 * 27, 255).toString('base64'); }, 'lighting.exposure'],
    ['1-2', r => { r.frames[57].materialMask = Buffer.alloc(48 * 27).toString('base64'); }, 'material.separation'],
    ['1-2', r => { r.frames[29].positions = r.frames[0].positions; }, 'assembly.excursion'],
  ]) {
    const result = probe(id, (_, r) => { mutate(r); r.maxErrorPx = 0; r.maxClipRatio = 0; r.pass = true; });
    assert.equal(result.items.find(it => it.metric === metric).pass, false, metric);
    assert.equal(result.pass, false);
  }
});

test('可选编码读回：爆炸题逐帧见证图经交付卡编码，按解码像素重算曝光和材质分层', async t => {
  if (!hasMediaTools()) return t.skip('缺少 ffmpeg 或 ffprobe，离线逐卡核验不依赖媒体工具');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-readback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = read('questions', 'level-3', '1-2.json');
  const film = readLevel3Film(q), r = buildLevel3Reading(q, null, film);
  const outPath = path.join(dir, 'witness.mp4'), inSize = [48, 27];
  const { size, fps } = r.delivery;
  await encodeRawFramesStream({ outPath, inSize, outSize: size, fps, pixFmt: 'gray', spec: encodeSpecFor(size, fps, film.delivery.master),
    writeFrames: async push => { for (const f of r.frames) await push(Buffer.from(f.lumaRaster, 'base64')); },
  });
  const p = probeDeliverableSpec(outPath);
  assert.equal(p.audio, false);
  r.delivery = { size: [p.width, p.height], fps: p.fpsFraction, frames: p.frames, audio: 'none' };
  const planes = decodeAllFramesGray(outPath, inSize, p.frames);
  assert.equal(planes.length, r.frames.length);
  for (const [i, f] of r.frames.entries()) f.lumaRaster = Buffer.from(planes[i]).toString('base64');
  const verdict = scoreLevel3(q, r);
  assert.equal(verdict.pass, true, JSON.stringify(verdict));
});

test('exam 扫描并真实核验至少 15 道公开题（含全部三级题），expected-fail 不计入通过', async () => {
  const report = await runExam({ outDir: null });
  assert.ok(report.ok, JSON.stringify(report.error));
  assert.ok(report.summary.passedQuestions >= 15);
  assert.equal(report.summary.passedQuestions, report.summary.evaluatedQuestions);
  assert.equal(report.summary.skippedQuestions, 5);
  for (const [id] of cases) assert.equal(report.questions.find(q => q.id === id).score, 1);
});

test('full-2：两周轮抽、23 次计分、门控不占分母、隐藏题不进公开产物', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-b15-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hiddenDir = path.join(root, 'private-bank'), boardDir = path.join(root, 'board');
  fs.mkdirSync(hiddenDir);
  const marker = 'private-fixture-marker';
  for (const id of ['91-1', '92-1', '93-1']) {
    const q = { ...read('questions', 'level-1', '01-1.json'), id, title: marker, brief: marker, refs: [] };
    q.flags.hidden = true;
    fs.writeFileSync(path.join(hiddenDir, `${id}.json`), JSON.stringify(q));
  }
  const questionsDir = path.join(bench, 'questions');
  assert.equal(discoverQuestions(questionsDir).publicQuestions.length, 12);
  const bank = discoverSuiteQuestions({ questionsDir, hiddenDir });
  assert.equal(bank.level3Questions.length, 3);
  const models = ['family-a', 'family-b'];
  const asOf = '2026-11-25';
  const plan = planFullExam2({ ...bank, models, asOf });
  assert.equal(plan.scoredRunCount, 23);
  assert.equal(plan.estimatedTokens, 21 * 800000 + 2 * 1800000);
  assert.deepEqual(plan.runs.slice(0, 12).map(r => r.questionId), bank.publicQuestions.map(e => e.question.id));
  assert.ok(plan.runs.slice(0, 12).every(r => r.model === models[0]));
  assert.deepEqual(plan.runs.slice(18, 20).map(r => [r.questionId, r.source]), [['3-1', 'blender'], ['31-1', 'blender']]);
  assert.deepEqual(plan.runs.slice(20).map(r => r.questionId), ['91-1', '92-1', '93-1']);
  assert.ok(!plan.runs.some(r => r.questionId === '1-2'));
  const second = p => p.runs.filter(r => r.model === models[1]).map(r => r.questionId);
  assert.equal(second(plan).length, 6);
  assert.deepEqual(second(planFullExam2({ ...bank, publicQuestions: [...bank.publicQuestions].reverse(), models, asOf })), second(plan));
  const week2 = '2026-12-02';
  assert.equal(new Set([...second(plan), ...second(planFullExam2({ ...bank, models, asOf: week2 }))]).size, 12);
  assert.throws(() => planFullExam2({ ...bank, models, hiddenCount: 2 }));
  assert.throws(() => planFullExam2({ ...bank, models, secondFamilyCount: 5 }));
  assert.throws(() => planFullExam2({ ...bank, models, level3Questions: bank.level3Questions.filter(e => e.question.id !== '31-1') }));
  const calls = [];
  for (const [day, date] of [asOf, week2].entries()) {
    calls.length = 0;
    const result = await runFullExam2({ questionsDir, hiddenDir, boardDir, models, asOf: date,
      evalRoot: path.join(root, `eval-${day}`), previousBlockedBy: day ? { '10-1': ['prior blocker'] } : {},
      solver: ({ questionFile }) => { calls.push(JSON.parse(fs.readFileSync(questionFile, 'utf8')).id); return { tokens: 37 }; },
      judge: ({ question }) => ({ metrics: Object.fromEntries(question.scoring.map(s => [s.metric, { pass: true }])),
        predicates: Object.fromEntries(question.basePredicates.map(p => [p, true])) }),
    });
    assert.equal(calls.length, 23 + day);
    assert.equal(calls.includes('10-1'), day === 1);
    assert.equal(result.summary.expectedFailRuns, 5 - day);
    assert.equal(result.summary.passedRuns, 23);
    assert.equal(result.summary.scoredRuns, 23);
    assert.equal(result.summary.actualTokens, (23 + day) * 37);
    assert.equal(result.results.length, 28);
    assert.ok(result.results.every(r => fs.existsSync(r.resultFile)));
    assert.equal(result.summary.historyRows, day + 1);
    for (const file of Object.values(result.outputs)) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes(marker) && !text.includes(root) && !text.includes(hiddenDir));
    }
  }
  const cli = spawnSync(process.execPath, [path.join(bench, 'suite.mjs'), 'full-2', '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0); assert.match(cli.stdout, /23/);
});
