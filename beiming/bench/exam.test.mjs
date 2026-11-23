// beiming/bench/exam.mjs 的单元与端到端测试（含空题库、坏题库、缺参考夹具、判分失败必退非 0 的负对照）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXAM_REPORT_FORMAT,
  discoverQuestionFiles,
  evaluateOfflineQuestion,
  parseExamArgs,
  runExam,
} from './exam.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAM_CLI = path.join(HERE, 'exam.mjs');
const QUESTIONS_DIR = path.join(HERE, 'questions');

function makeTempDir(t, prefix = 'beiming-exam-test-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('exam-1 扫描并运行仓库真实公开题库：8 道公开题与 16 份负对照全部通过，写出结构化 report.json', async (t) => {
  const outDir = makeTempDir(t);
  const files = discoverQuestionFiles(QUESTIONS_DIR);
  assert.ok(files.length >= 8, `应至少发现 8 道公开题，实际 ${files.length}`);

  const report = await runExam({ outDir });
  assert.equal(report.format, EXAM_REPORT_FORMAT);
  assert.equal(report.ok, true, JSON.stringify(report.error));
  assert.equal(report.exitCode, 0);
  assert.equal(report.error, null);
  assert.equal(report.summary.totalQuestions, files.length);
  assert.equal(report.summary.validQuestions, files.length);
  assert.equal(report.summary.invalidQuestions, 0);
  assert.equal(report.summary.passedQuestions, files.length);
  assert.equal(report.summary.failedQuestions, 0);
  assert.ok(report.summary.negativeControlsChecked >= 16);
  assert.equal(report.summary.negativeControlsRejected, report.summary.negativeControlsChecked);

  const reportFile = path.join(outDir, 'report.json');
  assert.deepEqual(report.outputs, [reportFile]);
  assert.ok(fs.existsSync(reportFile));
  const saved = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(saved.ok, true);
  assert.equal(saved.summary.passedQuestions, files.length);
  for (const q of saved.questions) {
    assert.equal(q.valid, true, q.file);
    assert.equal(q.pass, true, `${q.id}: ${q.errors.join('；')}`);
    assert.equal(q.score, 1, q.id);
    assert.ok(typeof q.runId === 'string' && q.runId.length > 0, q.id);
  }
});

test('exam-2 CLI 真实调用：支持 --out、--json、--dry-run、--help，未知参数退出码为 2', (t) => {
  const outDir = makeTempDir(t);
  const helpRun = spawnSync(process.execPath, [EXAM_CLI, '--help'], { encoding: 'utf8' });
  assert.equal(helpRun.status, 0);
  assert.match(helpRun.stdout, /用法：node beiming\/bench\/exam\.mjs/);

  const dryRun = spawnSync(process.execPath, [EXAM_CLI, '--dry-run', '--json', '--out', outDir], { encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryParsed = JSON.parse(dryRun.stdout);
  assert.equal(dryParsed.ok, true);
  assert.equal(dryParsed.dryRun, true);
  assert.equal(dryParsed.summary.invalidQuestions, 0);
  assert.ok(fs.existsSync(path.join(outDir, 'report.json')));

  const fullOut = path.join(outDir, 'full');
  const fullRun = spawnSync(process.execPath, [EXAM_CLI, '--out', fullOut, '--json'], { encoding: 'utf8' });
  assert.equal(fullRun.status, 0, fullRun.stderr);
  const fullParsed = JSON.parse(fullRun.stdout);
  assert.equal(fullParsed.ok, true);
  assert.equal(fullParsed.exitCode, 0);
  assert.equal(fullParsed.summary.failedQuestions, 0);
  assert.ok(fs.existsSync(path.join(fullOut, 'report.json')));

  const badArg = spawnSync(process.execPath, [EXAM_CLI, '--no-such-flag'], { encoding: 'utf8' });
  assert.equal(badArg.status, 2);
  assert.equal(JSON.parse(badArg.stdout).ok, false);
  assert.throws(() => parseExamArgs(['--out']), /--out 需要指定目录路径/);
  assert.throws(() => parseExamArgs(['--questions', '--json']), /--questions 需要指定题库目录路径/);
});

test('exam-3 负对照：空题库或不存在的题库目录必须失败并返回非 0 退出码（exit 4，绝不假绿）', async (t) => {
  const emptyDir = makeTempDir(t);
  const outDir = makeTempDir(t);

  const emptyReport = await runExam({ questionsDir: emptyDir, outDir });
  assert.equal(emptyReport.ok, false);
  assert.equal(emptyReport.exitCode, 4);
  assert.equal(emptyReport.error?.code, 'contract.empty-question-set');

  const missingReport = await runExam({ questionsDir: path.join(emptyDir, 'nonexistent'), outDir: null });
  assert.equal(missingReport.ok, false);
  assert.equal(missingReport.exitCode, 4);

  const cliEmpty = spawnSync(process.execPath, [EXAM_CLI, '--questions', emptyDir, '--out', outDir, '--json'], { encoding: 'utf8' });
  assert.equal(cliEmpty.status, 4);
  const cliParsed = JSON.parse(cliEmpty.stdout);
  assert.equal(cliParsed.ok, false);
  assert.equal(cliParsed.exitCode, 4);
});

test('exam-4 负对照：坏题目（JSON 损坏、权重和不为 1、题号重复、参考夹具缺失）必须返回 exit 4', async (t) => {
  const sampleRaw = fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/29-1.json'), 'utf8');
  const sample = JSON.parse(sampleRaw);

  // 1. 权重和不为 1 的坏题
  const badWeightDir = makeTempDir(t);
  const badWeightQ = { ...sample, scoring: sample.scoring.map((s) => ({ ...s, weight: 0.2 })) };
  fs.writeFileSync(path.join(badWeightDir, 'bad-weight.json'), JSON.stringify(badWeightQ, null, 2));
  const r1 = await runExam({ questionsDir: badWeightDir, outDir: null });
  assert.equal(r1.ok, false);
  assert.equal(r1.exitCode, 4);
  assert.equal(r1.summary.invalidQuestions, 1);
  assert.match(r1.questions[0].errors.join(' '), /QF1/);

  // 2. 题号重复
  const dupDir = makeTempDir(t);
  fs.writeFileSync(path.join(dupDir, 'a.json'), sampleRaw);
  fs.writeFileSync(path.join(dupDir, 'b.json'), sampleRaw);
  const r2 = await runExam({ questionsDir: dupDir, outDir: null });
  assert.equal(r2.ok, false);
  assert.equal(r2.exitCode, 4);
  assert.equal(r2.summary.invalidQuestions, 1);
  assert.match(r2.questions[1].errors.join(' '), /重复/);

  // 3. 引用了不存在的 refs 文件
  const badRefDir = makeTempDir(t);
  const badRefQ = { ...sample, refs: ['bench/refs/level-1/no-such-ref.json'] };
  fs.writeFileSync(path.join(badRefDir, 'bad-ref.json'), JSON.stringify(badRefQ, null, 2));
  const r3 = await runExam({ questionsDir: badRefDir, outDir: null });
  assert.equal(r3.ok, false);
  assert.equal(r3.exitCode, 4);
  assert.match(r3.questions[0].errors.join(' '), /参考文件不存在/);
});

test('exam-5 负对照：题目合法但评测未通过或负对照失守或未接入核验器时必须返回 exit 1（绝不假绿）', async (t) => {
  const sampleRaw = fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/29-1.json'), 'utf8');
  const sample = JSON.parse(sampleRaw);
  const qDir = makeTempDir(t);
  fs.writeFileSync(path.join(qDir, '29-1.json'), sampleRaw);

  // 1. 正对照判分不过
  const failEval = await runExam({
    questionsDir: qDir,
    outDir: null,
    evaluators: {
      '29-1': () => ({
        pass: false,
        positiveScore: 0.5,
        negativeControlsChecked: 1,
        negativeControlsRejected: 1,
        predicates: {},
        metrics: { 'layout.edges': { pass: false, basis: 'test' } },
        detail: '模拟正对照未得满分',
      }),
    },
  });
  assert.equal(failEval.ok, false);
  assert.equal(failEval.exitCode, 1);
  assert.equal(failEval.summary.failedQuestions, 1);

  // 2. 负对照漏放（negativeControlsRejected < negativeControlsChecked）
  const leakNeg = await runExam({
    questionsDir: qDir,
    outDir: null,
    evaluators: {
      '29-1': ({ question }) => ({
        pass: true,
        positiveScore: 1,
        negativeControlsChecked: 2,
        negativeControlsRejected: 1,
        predicates: Object.fromEntries(question.basePredicates.map((p) => [p, { pass: true, basis: 'test' }])),
        metrics: { 'layout.edges': { pass: true, basis: 'test' } },
        detail: '模拟负对照漏放',
      }),
    },
  });
  assert.equal(leakNeg.ok, false);
  assert.equal(leakNeg.exitCode, 1);

  // 3. 未接入离线核验器的未知题号不得假绿
  const unknownQ = { ...sample, id: '99-9' };
  const unknownOutcome = evaluateOfflineQuestion({ question: unknownQ });
  assert.equal(unknownOutcome.pass, false);
  assert.match(unknownOutcome.detail, /尚未接入离线核验器/);
});

test('exam-6 回归：互斥基础谓词（contradiction）与交付规格不符必须如实求值失败（exit 1）', async (t) => {
  const sample = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/29-1.json'), 'utf8'));

  // 1. 29-1 追加互斥谓词 bbox_w(panel_top) <= 0 @ all -> 必须如实判一条过、一条不过，CLI 退非 0
  const contraDir = makeTempDir(t);
  const outDir = makeTempDir(t);
  const contraQ = structuredClone(sample);
  contraQ.basePredicates.push('bbox_w(panel_top) <= 0 @ all');
  fs.writeFileSync(path.join(contraDir, '29-1-contra.json'), JSON.stringify(contraQ, null, 2));

  const outcome = evaluateOfflineQuestion({ question: contraQ });
  assert.equal(outcome.pass, false);
  assert.equal(outcome.predicates['bbox_w(panel_top) >= 1 @ all']?.pass, true);
  assert.equal(outcome.predicates['bbox_w(panel_top) <= 0 @ all']?.pass, false);

  const report = await runExam({ questionsDir: contraDir, outDir: null });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.equal(report.summary.passedQuestions, 0);
  assert.equal(report.summary.failedQuestions, 1);

  const cli = spawnSync(process.execPath, [EXAM_CLI, '--questions', contraDir, '--out', outDir, '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).ok, false);

  // 2. 29-1 题面改为 stereo 与静音基准不符 -> 必须失败（不得按题面反填 spec 伪造通过）
  const stereoDir = makeTempDir(t);
  const stereoQ = structuredClone(sample);
  stereoQ.deliverable.audio = 'stereo';
  fs.writeFileSync(path.join(stereoDir, '29-1-stereo.json'), JSON.stringify(stereoQ, null, 2));
  const stereoReport = await runExam({ questionsDir: stereoDir, outDir: null });
  assert.equal(stereoReport.ok, false);
  assert.equal(stereoReport.exitCode, 1);

  // 3. Level 2-b（5-1）追加错误基础谓词 cut_at(100) -> 同样必须如实求值失败
  const q51 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-2-b/5-1.json'), 'utf8'));
  q51.basePredicates.push('cut_at(100)');
  const badPredDir = makeTempDir(t);
  fs.writeFileSync(path.join(badPredDir, '5-1-bad-pred.json'), JSON.stringify(q51, null, 2));
  const badPredReport = await runExam({ questionsDir: badPredDir, outDir: null });
  assert.equal(badPredReport.ok, false);
  assert.equal(badPredReport.exitCode, 1);
});

test('exam-7 回归：参考夹具为空对象、缺量测字段或跨题错指必须校验失败（exit 4，消除 empty-reference 假绿）', async (t) => {
  const q182 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-2-b/18-2.json'), 'utf8'));
  const ref291 = fs.readFileSync(path.join(HERE, 'refs/level-1/29-1-reference.json'), 'utf8');

  // 1. 18-2 夹具清空为 {} -> exit 4
  const fakeRoot1 = makeTempDir(t);
  const fakeBench1 = path.join(fakeRoot1, 'bench');
  const fakeQ1 = path.join(fakeBench1, 'questions/level-2-b');
  const fakeRef1 = path.join(fakeBench1, 'refs/level-2-b');
  fs.mkdirSync(fakeQ1, { recursive: true });
  fs.mkdirSync(fakeRef1, { recursive: true });
  fs.writeFileSync(path.join(fakeQ1, '18-2.json'), JSON.stringify(q182, null, 2));
  fs.writeFileSync(path.join(fakeRef1, '18-2.json'), '{}\n');

  const rEmpty = await runExam({ questionsDir: fakeQ1, benchDir: fakeBench1, outDir: null });
  assert.equal(rEmpty.ok, false);
  assert.equal(rEmpty.exitCode, 4);
  assert.equal(rEmpty.summary.invalidQuestions, 1);

  // 2. 18-2 夹具仅有 question 字段、缺少 fps/sceneFrames/moves -> exit 4
  fs.writeFileSync(path.join(fakeRef1, '18-2.json'), JSON.stringify({ question: '18-2' }));
  const rHollow = await runExam({ questionsDir: fakeQ1, benchDir: fakeBench1, outDir: null });
  assert.equal(rHollow.ok, false);
  assert.equal(rHollow.exitCode, 4);
  assert.equal(rHollow.summary.invalidQuestions, 1);

  // 3. 18-2 的 refs 指向 29-1 的版式参考文件 -> exit 4
  const fakeRefL1 = path.join(fakeBench1, 'refs/level-1');
  fs.mkdirSync(fakeRefL1, { recursive: true });
  fs.writeFileSync(path.join(fakeRefL1, '29-1-reference.json'), ref291);
  const crossRefQ = { ...q182, refs: ['bench/refs/level-1/29-1-reference.json'] };
  const crossDir = makeTempDir(t);
  fs.writeFileSync(path.join(crossDir, '18-2.json'), JSON.stringify(crossRefQ, null, 2));
  const rCross = await runExam({ questionsDir: crossDir, benchDir: fakeBench1, outDir: null });
  assert.equal(rCross.ok, false);
  assert.equal(rCross.exitCode, 4);
  assert.equal(rCross.summary.invalidQuestions, 1);
});

test('exam-8 回归：--questions 副本收紧或放宽 18-2 阈值时必须按加载题目对象判分失败（exit 1，消除 threshold 假绿）', async (t) => {
  const base182 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-2-b/18-2.json'), 'utf8'));

  // 1. minLiftOverRandom 提到 1 -> 正对照不达标，必须 exit 1
  const tightDir = makeTempDir(t);
  const outDir = makeTempDir(t);
  const tightQ = structuredClone(base182);
  tightQ.scoring[0].args.minLiftOverRandom = 1;
  fs.writeFileSync(path.join(tightDir, '18-2.json'), JSON.stringify(tightQ, null, 2));

  const cliTight = spawnSync(process.execPath, [EXAM_CLI, '--questions', tightDir, '--out', outDir, '--json'], { encoding: 'utf8' });
  assert.equal(cliTight.status, 1, cliTight.stderr);
  const parsed = JSON.parse(cliTight.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.exitCode, 1);
  assert.equal(parsed.questions[0].pass, false);
  assert.equal(parsed.questions[0].score, 0);

  // 2. tolFrames 放宽到 10 -> shift-2f 负对照失守，必须 exit 1
  const looseDir = makeTempDir(t);
  const looseQ = structuredClone(base182);
  looseQ.scoring[0].args.tolFrames = 10;
  fs.writeFileSync(path.join(looseDir, '18-2.json'), JSON.stringify(looseQ, null, 2));
  const looseReport = await runExam({ questionsDir: looseDir, outDir: null });
  assert.equal(looseReport.ok, false);
  assert.equal(looseReport.exitCode, 1);
});

test('exam-9 回归：全 expectedFail 跳过题库不得计入通过且必须退出非 0（exit 1，消除 all-skipped 假绿）', async (t) => {
  const sample29 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/29-1.json'), 'utf8'));
  const sample23 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/23-1.json'), 'utf8'));

  // 1. 仅含 1 道 expectedFail=true 题 -> evaluatedQuestions=0, passedQuestions=0, ok=false, exit 1
  const skipOnlyDir = makeTempDir(t);
  const outDir = makeTempDir(t);
  const skipped29 = structuredClone(sample29);
  skipped29.flags.expectedFail = true;
  skipped29.flags.blockedBy = ['layout.panels'];
  fs.writeFileSync(path.join(skipOnlyDir, '29-1.json'), JSON.stringify(skipped29, null, 2));

  const cliSkip = spawnSync(process.execPath, [EXAM_CLI, '--questions', skipOnlyDir, '--out', outDir, '--json'], { encoding: 'utf8' });
  assert.equal(cliSkip.status, 1, cliSkip.stderr);
  const parsed = JSON.parse(cliSkip.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.exitCode, 1);
  assert.equal(parsed.summary.passedQuestions, 0);
  assert.equal(parsed.summary.evaluatedQuestions, 0);
  assert.equal(parsed.summary.skippedQuestions, 1);
  assert.equal(parsed.questions[0].status, 'expected-fail');
  assert.equal(parsed.questions[0].pass, false);

  // 2. 混合题库（1 道可跑通 + 1 道 expectedFail）-> 可跑通计入 passedQuestions=1，跳过题不计入 passedQuestions
  const mixedDir = makeTempDir(t);
  const skipped23 = structuredClone(sample23);
  skipped23.flags.expectedFail = true;
  skipped23.flags.blockedBy = ['camera.orbit'];
  fs.writeFileSync(path.join(mixedDir, '29-1.json'), JSON.stringify(sample29, null, 2));
  fs.writeFileSync(path.join(mixedDir, '23-1.json'), JSON.stringify(skipped23, null, 2));

  const mixed = await runExam({ questionsDir: mixedDir, outDir: null });
  assert.equal(mixed.ok, true, JSON.stringify(mixed.error));
  assert.equal(mixed.exitCode, 0);
  assert.equal(mixed.summary.totalQuestions, 2);
  assert.equal(mixed.summary.evaluatedQuestions, 1);
  assert.equal(mixed.summary.passedQuestions, 1);
  assert.equal(mixed.summary.skippedQuestions, 1);
});
