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

test('exam-1 扫描并运行仓库真实公开题库：12 道公开题（level-1 / level-2-a / level-2-b）与负对照全部通过，写出结构化 report.json', async (t) => {
  const outDir = makeTempDir(t);
  const files = discoverQuestionFiles(QUESTIONS_DIR);
  assert.ok(files.length >= 12, `应至少发现 12 道公开题，实际 ${files.length}`);

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
  assert.ok(report.summary.negativeControlsChecked >= 24);
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

  // 2. tolFrames 放宽到 10 -> shift-2f 负对照失守，必须 exit 1 且得分归 0
  const looseDir = makeTempDir(t);
  const looseQ = structuredClone(base182);
  looseQ.scoring[0].args.tolFrames = 10;
  fs.writeFileSync(path.join(looseDir, '18-2.json'), JSON.stringify(looseQ, null, 2));
  const looseReport = await runExam({ questionsDir: looseDir, outDir: null });
  assert.equal(looseReport.ok, false);
  assert.equal(looseReport.exitCode, 1);
  assert.equal(looseReport.questions[0].pass, false);
  assert.equal(looseReport.questions[0].score, 0);
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

test('exam-10 回归：默认考试缺少任一内置题集或子目录为空时必须退出非 0（exit 4，消除 missing-level-1 假绿）', async (t) => {
  const copyBench = () => {
    const root = makeTempDir(t);
    const fakeBench = path.join(root, 'bench');
    fs.cpSync(path.join(HERE, 'questions'), path.join(fakeBench, 'questions'), { recursive: true });
    fs.cpSync(path.join(HERE, 'refs'), path.join(fakeBench, 'refs'), { recursive: true });
    return { root, fakeBench };
  };

  // 1. 移走 level-1 全部 4 份题目 JSON（保留 evaluate-b2.mjs 与 level-2-b）-> exit 4
  const c1 = copyBench();
  const level1Dir = path.join(c1.fakeBench, 'questions/level-1');
  for (const name of fs.readdirSync(level1Dir)) {
    if (name.endsWith('.json')) fs.rmSync(path.join(level1Dir, name));
  }
  const out1 = path.join(c1.root, 'out-missing-l1');
  const r1 = await runExam({ benchDir: c1.fakeBench, outDir: out1 });
  assert.equal(r1.ok, false);
  assert.equal(r1.exitCode, 4);
  assert.equal(r1.error?.code, 'contract.missing-question-set');
  assert.match(r1.error?.message ?? '', /level-1/);
  const saved1 = JSON.parse(fs.readFileSync(path.join(out1, 'report.json'), 'utf8'));
  assert.equal(saved1.ok, false);
  assert.equal(saved1.exitCode, 4);

  // 2. CLI 通过 --questions 指向含空子目录 level-1 的题库副本 -> exit 4，且退出码与 report.json 一致
  const outCli = path.join(c1.root, 'out-cli');
  const cli = spawnSync(process.execPath, [EXAM_CLI, '--questions', path.join(c1.fakeBench, 'questions'), '--out', outCli, '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 4, cli.stderr);
  const cliReport = JSON.parse(fs.readFileSync(path.join(outCli, 'report.json'), 'utf8'));
  assert.equal(cliReport.ok, false);
  assert.equal(cliReport.exitCode, cli.status);

  // 3. 默认题库仅缺 level-1 中的单道题（23-1.json）-> exit 4
  const c2 = copyBench();
  fs.rmSync(path.join(c2.fakeBench, 'questions/level-1/23-1.json'));
  const r2 = await runExam({ benchDir: c2.fakeBench, outDir: null });
  assert.equal(r2.ok, false);
  assert.equal(r2.exitCode, 4);
  assert.equal(r2.error?.code, 'contract.missing-question-set');
  assert.match(r2.error?.message ?? '', /23-1/);

  // 4. 移走 level-2-b 全部题目 JSON，且 --dry-run 同样不得假绿 -> exit 4
  const c3 = copyBench();
  const level2bDir = path.join(c3.fakeBench, 'questions/level-2-b');
  for (const name of fs.readdirSync(level2bDir)) {
    if (name.endsWith('.json')) fs.rmSync(path.join(level2bDir, name));
  }
  const r3 = await runExam({ benchDir: c3.fakeBench, dryRun: true, outDir: null });
  assert.equal(r3.ok, false);
  assert.equal(r3.exitCode, 4);
  assert.equal(r3.error?.code, 'contract.missing-question-set');
  assert.match(r3.error?.message ?? '', /level-2-b/);
});

test('exam-11 回归：orbit_total 基础谓词带 @ [start,end) 区间时必须按区间逐帧角度求值（消除 scoped-orbit 假绿）', async (t) => {
  const base23 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/23-1.json'), 'utf8'));
  const base28 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/28-1.json'), 'utf8'));
  const base15 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-2-b/15-2.json'), 'utf8'));

  // 1. 23-1 追加 orbit_total(camera, subject) >= 359 deg @ [0,2)（第 0 帧 0° 到第 1 帧 5°）-> 必失败 exit 1
  const badScope23 = structuredClone(base23);
  badScope23.basePredicates.push('orbit_total(camera, subject) >= 359 deg @ [0,2)');
  const outcome23 = evaluateOfflineQuestion({ question: badScope23 });
  assert.equal(outcome23.pass, false);
  assert.equal(outcome23.predicates['orbit_total(camera, subject) in [359, 361] deg']?.pass, true);
  assert.equal(outcome23.predicates['orbit_total(camera, subject) >= 359 deg @ [0,2)']?.pass, false);

  const bankDir = makeTempDir(t);
  const outDir = makeTempDir(t);
  fs.writeFileSync(path.join(bankDir, '23-1.json'), JSON.stringify(badScope23, null, 2));
  const cli = spawnSync(process.execPath, [EXAM_CLI, '--questions', bankDir, '--out', outDir, '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr);
  const cliReport = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
  assert.equal(cliReport.ok, false);
  assert.equal(cliReport.exitCode, 1);
  assert.equal(cliReport.questions[0].pass, false);

  // 2. 23-1 追加如实区间谓词 orbit_total(camera, subject) in [4, 6] deg @ [0,2)（实测 5°）-> 应通过
  const goodScope23 = structuredClone(base23);
  goodScope23.basePredicates.push('orbit_total(camera, subject) in [4, 6] deg @ [0,2)');
  const okOutcome = evaluateOfflineQuestion({ question: goodScope23 });
  assert.equal(okOutcome.pass, true, okOutcome.detail);
  assert.equal(okOutcome.predicates['orbit_total(camera, subject) in [4, 6] deg @ [0,2)']?.pass, true);

  // 3. 单帧区间 [0,1)（0°）与越界区间 [72,80)（无帧）均不得通过 >= 1 deg
  for (const pred of ['orbit_total(camera, subject) >= 1 deg @ [0,1)', 'orbit_total(camera, subject) >= 1 deg @ [72,80)']) {
    const q = structuredClone(base23);
    q.basePredicates.push(pred);
    assert.equal(evaluateOfflineQuestion({ question: q }).pass, false, pred);
  }

  // 4. 28-1（288 帧 360°）与 15-2（静态 0°）同样遵守区间求值
  const badScope28 = structuredClone(base28);
  badScope28.basePredicates.push('orbit_total(camera, subject) >= 359 deg @ [0,2)');
  assert.equal(evaluateOfflineQuestion({ question: badScope28 }).pass, false);

  const badScope15 = structuredClone(base15);
  badScope15.basePredicates.push('orbit_total(camera, scene) >= 1 deg @ [0,10)');
  assert.equal(evaluateOfflineQuestion({ question: badScope15 }).pass, false);
});

test('exam-12 回归：23-1 参考夹具 variants[] 变体参考片失配或缺失时必须判失败（消除 bad-reference-variant 假绿）', async (t) => {
  const makeFakeBench = (mutateRef) => {
    const root = makeTempDir(t);
    const fakeBench = path.join(root, 'bench');
    const only23Dir = path.join(fakeBench, 'questions/only-23-1');
    const refDir = path.join(fakeBench, 'refs/level-1');
    fs.mkdirSync(only23Dir, { recursive: true });
    fs.mkdirSync(refDir, { recursive: true });
    fs.copyFileSync(path.join(HERE, 'questions/level-1/23-1.json'), path.join(only23Dir, '23-1.json'));
    const refFile = path.join(refDir, '23-1-reference.json');
    fs.copyFileSync(path.join(HERE, 'refs/level-1/23-1-reference.json'), refFile);
    const fixture = JSON.parse(fs.readFileSync(refFile, 'utf8'));
    mutateRef(fixture);
    fs.writeFileSync(refFile, JSON.stringify(fixture, null, 2));
    return { root, fakeBench, only23Dir };
  };

  // 1. 头部 60 帧变体 nearest 从 59 改为 30 -> B2 评分器得 0.5 分，整场考试必须 exit 1
  const b1 = makeFakeBench((fixture) => {
    fixture.variants[0].readings['loop.closure-psnr'].nearest = 30;
  });
  const out1 = path.join(b1.root, 'out');
  const r1 = await runExam({ benchDir: b1.fakeBench, questionsDir: b1.only23Dir, outDir: out1 });
  assert.equal(r1.ok, false);
  assert.equal(r1.exitCode, 1);
  const q23 = r1.questions.find((q) => q.id === '23-1');
  assert.equal(q23?.pass, false);
  const saved1 = JSON.parse(fs.readFileSync(path.join(out1, 'report.json'), 'utf8'));
  assert.equal(saved1.ok, false);
  assert.equal(saved1.exitCode, 1);

  // 2. 头部 60 帧变体 closurePsnr 劣于阈值 -> 必须 exit 1
  const b2 = makeFakeBench((fixture) => {
    fixture.variants[0].readings['loop.closure-psnr'].closurePsnr = 5;
  });
  const r2 = await runExam({ benchDir: b2.fakeBench, questionsDir: b2.only23Dir, outDir: null });
  assert.equal(r2.ok, false);
  assert.equal(r2.exitCode, 1);

  // 3. 头部 60 帧变体 base.spec.frames 误写成 72 -> deliverable 不匹配，必须 exit 1
  const b3 = makeFakeBench((fixture) => {
    fixture.variants[0].readings.base.spec.frames = 72;
  });
  const r3 = await runExam({ benchDir: b3.fakeBench, questionsDir: b3.only23Dir, outDir: null });
  assert.equal(r3.ok, false);
  assert.equal(r3.exitCode, 1);

  // 4. 删除 variants 数组 -> 夹具契约校验不通过，必须 exit 4
  const b4 = makeFakeBench((fixture) => {
    delete fixture.variants;
  });
  const r4 = await runExam({ benchDir: b4.fakeBench, questionsDir: b4.only23Dir, outDir: null });
  assert.equal(r4.ok, false);
  assert.equal(r4.exitCode, 4);
  assert.equal(r4.summary.invalidQuestions, 1);
});

test('exam-13 回归：level-2-a（27-1 / 29-2 / 23-2 / 30-1）接入 B3 评分器，缺题集或夹具/阈值篡改必退非 0', async (t) => {
  // 1. 移走 level-2-a 全部题目 -> exit 4
  const root1 = makeTempDir(t);
  const fakeBench1 = path.join(root1, 'bench');
  fs.cpSync(path.join(HERE, 'questions'), path.join(fakeBench1, 'questions'), { recursive: true });
  fs.cpSync(path.join(HERE, 'refs'), path.join(fakeBench1, 'refs'), { recursive: true });
  const l2aDir = path.join(fakeBench1, 'questions/level-2-a');
  for (const name of fs.readdirSync(l2aDir)) {
    if (name.endsWith('.json')) fs.rmSync(path.join(l2aDir, name));
  }
  const rMissing = await runExam({ benchDir: fakeBench1, outDir: null });
  assert.equal(rMissing.ok, false);
  assert.equal(rMissing.exitCode, 4);
  assert.equal(rMissing.error?.code, 'contract.missing-question-set');
  assert.match(rMissing.error?.message ?? '', /level-2-a/);

  // 2. 仅移走 30-1.json -> 缺少必需题目 30-1，exit 4
  const root30 = makeTempDir(t);
  const fakeBench30 = path.join(root30, 'bench');
  fs.cpSync(path.join(HERE, 'questions'), path.join(fakeBench30, 'questions'), { recursive: true });
  fs.cpSync(path.join(HERE, 'refs'), path.join(fakeBench30, 'refs'), { recursive: true });
  fs.rmSync(path.join(fakeBench30, 'questions/level-2-a/30-1.json'));
  const rMissing30 = await runExam({ benchDir: fakeBench30, outDir: null });
  assert.equal(rMissing30.ok, false);
  assert.equal(rMissing30.exitCode, 4);
  assert.equal(rMissing30.error?.code, 'contract.missing-question-set');
  assert.match(rMissing30.error?.message ?? '', /30-1/);

  // 3. 篡改 27-1 首切阈值 -> B3 评分器必须拒绝（exit 1）
  const q27 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-2-a/27-1.json'), 'utf8'));
  q27.scoring[0].args.firstCut = 120;
  const badDir = makeTempDir(t);
  fs.writeFileSync(path.join(badDir, '27-1.json'), JSON.stringify(q27, null, 2));
  const rBad = await runExam({ questionsDir: badDir, outDir: null });
  assert.equal(rBad.ok, false);
  assert.equal(rBad.exitCode, 1);
  assert.equal(rBad.questions[0].pass, false);

  // 4. 30-1 删掉写死帧号固定负对照样本 -> 夹具校验必须拒绝（exit 4）
  const q30NoNeg = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-2-a/30-1.json'), 'utf8'));
  q30NoNeg.refs = ['beiming/bench/refs/level-2-a/30-1.reference.json'];
  const only30NoNegDir = makeTempDir(t);
  fs.writeFileSync(path.join(only30NoNegDir, '30-1.json'), JSON.stringify(q30NoNeg, null, 2));
  const rNoNeg = await runExam({ questionsDir: only30NoNegDir, outDir: null });
  assert.equal(rNoNeg.ok, false);
  assert.equal(rNoNeg.exitCode, 4);

  // 5. 30-1 写死样本被改成移动样本（探针帧 +2 偏移或直接换成参考探针表，0/20 固定）-> 夹具校验必须拒收（exit 4，绝不判 4/4 通过）
  const makeOnly30Bench = () => {
    const root = makeTempDir(t);
    const fakeBench = path.join(root, 'bench');
    const only30Dir = path.join(fakeBench, 'questions-only-30');
    const evalRoot = path.join(root, 'eval-runs');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(only30Dir, { recursive: true });
    fs.cpSync(path.join(QUESTIONS_DIR, 'level-2-a/30-1.json'), path.join(only30Dir, '30-1.json'));
    fs.cpSync(path.join(HERE, 'refs'), path.join(fakeBench, 'refs'), { recursive: true });
    return { root, fakeBench, only30Dir, evalRoot, outDir };
  };

  for (const delta of [2, 0]) {
    const bShift = makeOnly30Bench();
    const ref30 = JSON.parse(fs.readFileSync(path.join(bShift.fakeBench, 'refs/level-2-a/30-1.reference.json'), 'utf8'));
    const hardPath = path.join(bShift.fakeBench, 'refs/level-2-a/30-1.hardcoded.json');
    const hard30 = JSON.parse(fs.readFileSync(hardPath, 'utf8'));
    hard30.probeBeatEvents = ref30.probeBeatEvents.map((e) => ({ ...e, frame: e.frame + delta }));
    fs.writeFileSync(hardPath, JSON.stringify(hard30, null, 2));

    const rShift = await runExam({ benchDir: bShift.fakeBench, questionsDir: bShift.only30Dir, evalRoot: bShift.evalRoot, outDir: bShift.outDir });
    assert.equal(rShift.ok, false, `delta=${delta}`);
    assert.equal(rShift.exitCode, 4, `delta=${delta}`);
    assert.equal(rShift.questions[0].valid, false);
    assert.equal(rShift.questions[0].pass, false);
    assert.equal(rShift.questions[0].score, 0);

    const q30Loaded = JSON.parse(fs.readFileSync(path.join(bShift.only30Dir, '30-1.json'), 'utf8'));
    assert.equal(evaluateOfflineQuestion({ question: q30Loaded, benchDir: bShift.fakeBench }).pass, false);
  }

  // 6. 30-1 固定样本失配或负对照失守（exit 1）时：runner 落盘的 result.json 与单题报告均必须为 pass: false, score: 0（绝不签出 pass: true 或 score: 1）
  const findResultJson = (dir) => {
    const hit = fs.readdirSync(dir, { recursive: true }).find((f) => String(f).endsWith('result.json'));
    assert.ok(hit, `应在 ${dir} 下落盘 result.json`);
    return JSON.parse(fs.readFileSync(path.join(dir, String(hit)), 'utf8'));
  };

  // 6a) 保留合法双固定夹具过契约门，追加失配负样本（其 probeBeatEvents 换成参考探针表、保留 expect.pass=false）-> exit 1，result.json 与报告均为 pass:false, score:0
  const bMismatch = makeOnly30Bench();
  const ref30 = JSON.parse(fs.readFileSync(path.join(bMismatch.fakeBench, 'refs/level-2-a/30-1.reference.json'), 'utf8'));
  const extraNeg = JSON.parse(fs.readFileSync(path.join(bMismatch.fakeBench, 'refs/level-2-a/30-1.hardcoded.json'), 'utf8'));
  extraNeg.probeBeatEvents = ref30.probeBeatEvents;
  fs.writeFileSync(path.join(bMismatch.fakeBench, 'refs/level-2-a/30-1.extra-neg.json'), JSON.stringify(extraNeg, null, 2));
  const q30WithExtra = JSON.parse(fs.readFileSync(path.join(bMismatch.only30Dir, '30-1.json'), 'utf8'));
  q30WithExtra.refs.push('beiming/bench/refs/level-2-a/30-1.extra-neg.json');
  fs.writeFileSync(path.join(bMismatch.only30Dir, '30-1.json'), JSON.stringify(q30WithExtra, null, 2));

  const rHardMismatch = await runExam({
    benchDir: bMismatch.fakeBench,
    questionsDir: bMismatch.only30Dir,
    evalRoot: bMismatch.evalRoot,
    outDir: bMismatch.outDir,
  });
  assert.equal(rHardMismatch.ok, false);
  assert.equal(rHardMismatch.exitCode, 1);
  assert.equal(rHardMismatch.questions[0].pass, false);
  assert.equal(rHardMismatch.questions[0].score, 0);
  const mismatchResult = findResultJson(bMismatch.evalRoot);
  assert.equal(mismatchResult.status, 'fail');
  assert.equal(mismatchResult.pass, false);
  assert.equal(mismatchResult.score, 0);

  // 6b) 放宽 minMovedRatio=0 使写死帧号样本被误放过（固定样本失配 + 合成负对照失守，而正对照仍为 1.0）-> exit 1，result.json 与报告均为 pass:false, score:0
  const bLoose30 = makeOnly30Bench();
  const q30Loose = JSON.parse(fs.readFileSync(path.join(bLoose30.only30Dir, '30-1.json'), 'utf8'));
  q30Loose.scoring[1].args.minMovedRatio = 0;
  fs.writeFileSync(path.join(bLoose30.only30Dir, '30-1.json'), JSON.stringify(q30Loose, null, 2));
  const rLoose30 = await runExam({
    benchDir: bLoose30.fakeBench,
    questionsDir: bLoose30.only30Dir,
    evalRoot: bLoose30.evalRoot,
    outDir: bLoose30.outDir,
  });
  assert.equal(rLoose30.ok, false);
  assert.equal(rLoose30.exitCode, 1);
  assert.equal(rLoose30.questions[0].pass, false);
  assert.equal(rLoose30.questions[0].score, 0);
  const looseResult = findResultJson(bLoose30.evalRoot);
  assert.equal(looseResult.status, 'fail');
  assert.equal(looseResult.pass, false);
  assert.equal(looseResult.score, 0);

  // 6c) 收紧 probeBpm 阈值 -> exit 1，报告与 result.json 均不得签出满分
  const q30Tight = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-2-a/30-1.json'), 'utf8'));
  q30Tight.scoring[1].args.probeBpm = 108;
  const tight30Dir = makeTempDir(t);
  const tightEvalRoot = makeTempDir(t);
  fs.writeFileSync(path.join(tight30Dir, '30-1.json'), JSON.stringify(q30Tight, null, 2));
  const rTight30 = await runExam({ questionsDir: tight30Dir, evalRoot: tightEvalRoot, outDir: null });
  assert.equal(rTight30.ok, false);
  assert.equal(rTight30.exitCode, 1);
  assert.equal(rTight30.questions[0].pass, false);
  assert.equal(rTight30.questions[0].score, 0);
  const tightResult = findResultJson(tightEvalRoot);
  assert.equal(tightResult.pass, false);
  assert.equal(tightResult.score, 0);

  // 6d) 写死样本保持帧号不动但把 beatEvents 改成全偏拍（或把参考样本 probeBeatEvents 改成不动）-> 过契约门后求值失配（exit 1），result.json 与报告均为 pass:false, score:0
  const bHardOffBeat = makeOnly30Bench();
  const hardOffPath = path.join(bHardOffBeat.fakeBench, 'refs/level-2-a/30-1.hardcoded.json');
  const hardOff = JSON.parse(fs.readFileSync(hardOffPath, 'utf8'));
  hardOff.beatEvents = hardOff.beatEvents.map((e, idx) => ({ id: e.id, frame: (idx + 1) * 18 + 9 }));
  hardOff.probeBeatEvents = hardOff.beatEvents.map((e) => ({ ...e }));
  fs.writeFileSync(hardOffPath, JSON.stringify(hardOff, null, 2));
  const rHardOff = await runExam({
    benchDir: bHardOffBeat.fakeBench,
    questionsDir: bHardOffBeat.only30Dir,
    evalRoot: bHardOffBeat.evalRoot,
    outDir: null,
  });
  assert.equal(rHardOff.ok, false);
  assert.equal(rHardOff.exitCode, 1);
  assert.equal(rHardOff.questions[0].pass, false);
  assert.equal(rHardOff.questions[0].score, 0);
  const hardOffResult = findResultJson(bHardOffBeat.evalRoot);
  assert.equal(hardOffResult.pass, false);
  assert.equal(hardOffResult.score, 0);

  const bBadPosRef = makeOnly30Bench();
  const badPosPath = path.join(bBadPosRef.fakeBench, 'refs/level-2-a/30-1.reference.json');
  const badPos30 = JSON.parse(fs.readFileSync(badPosPath, 'utf8'));
  badPos30.loudnessLufs = -8.7;
  fs.writeFileSync(badPosPath, JSON.stringify(badPos30, null, 2));
  const rBadPosRef = await runExam({
    benchDir: bBadPosRef.fakeBench,
    questionsDir: bBadPosRef.only30Dir,
    evalRoot: bBadPosRef.evalRoot,
    outDir: null,
  });
  assert.equal(rBadPosRef.ok, false);
  assert.equal(rBadPosRef.exitCode, 1);
  assert.equal(rBadPosRef.questions[0].pass, false);
  assert.equal(rBadPosRef.questions[0].score, 0);
  const badPosResult = findResultJson(bBadPosRef.evalRoot);
  assert.equal(badPosResult.pass, false);
  assert.equal(badPosResult.score, 0);

  // 7. 30-1 截断伪负样本、把通过样本改成写死静止表、BPM 扰动对失配或 expect 自相矛盾（含 --dry-run）-> 夹具契约校验必须拒收（exit 4，passedQuestions=0）
  const bTrunc = makeOnly30Bench();
  const truncHardPath = path.join(bTrunc.fakeBench, 'refs/level-2-a/30-1.hardcoded.json');
  const truncHard = JSON.parse(fs.readFileSync(truncHardPath, 'utf8'));
  truncHard.beatEvents = [{ id: 'm01', frame: 216 }];
  truncHard.probeBeatEvents = [{ id: 'm01', frame: 216 }];
  truncHard.expect = { pass: false, basePass: true, score: 0, items: [false, false] };
  fs.writeFileSync(truncHardPath, JSON.stringify(truncHard, null, 2));
  const rTrunc = await runExam({ benchDir: bTrunc.fakeBench, questionsDir: bTrunc.only30Dir, outDir: null });
  assert.equal(rTrunc.ok, false);
  assert.equal(rTrunc.exitCode, 4);
  assert.equal(rTrunc.summary.passedQuestions, 0);

  const bStationaryPos = makeOnly30Bench();
  const stationaryPosPath = path.join(bStationaryPos.fakeBench, 'refs/level-2-a/30-1.reference.json');
  const stationaryPos = JSON.parse(fs.readFileSync(stationaryPosPath, 'utf8'));
  stationaryPos.probeBeatEvents = stationaryPos.beatEvents;
  fs.writeFileSync(stationaryPosPath, JSON.stringify(stationaryPos, null, 2));
  for (const dryRun of [true, false]) {
    const rStatPos = await runExam({ benchDir: bStationaryPos.fakeBench, questionsDir: bStationaryPos.only30Dir, dryRun, outDir: null });
    assert.equal(rStatPos.ok, false);
    assert.equal(rStatPos.exitCode, 4);
    assert.equal(rStatPos.summary.passedQuestions, 0);
    assert.equal(rStatPos.questions[0].pass, false);
    assert.equal(rStatPos.questions[0].score, 0);
  }

  const bUnpairedBpm = makeOnly30Bench();
  const unpairedHardPath = path.join(bUnpairedBpm.fakeBench, 'refs/level-2-a/30-1.hardcoded.json');
  const unpairedHard = JSON.parse(fs.readFileSync(unpairedHardPath, 'utf8'));
  unpairedHard.probeBpm = 120;
  fs.writeFileSync(unpairedHardPath, JSON.stringify(unpairedHard, null, 2));
  const rUnpairedDry = await runExam({ benchDir: bUnpairedBpm.fakeBench, questionsDir: bUnpairedBpm.only30Dir, dryRun: true, outDir: null });
  assert.equal(rUnpairedDry.ok, false);
  assert.equal(rUnpairedDry.exitCode, 4);
  assert.equal(rUnpairedDry.questions[0].pass, false);
  assert.equal(rUnpairedDry.questions[0].score, 0);

  const bDryBadRef = makeOnly30Bench();
  const badRefPath = path.join(bDryBadRef.fakeBench, 'refs/level-2-a/30-1.reference.json');
  const badRef30 = JSON.parse(fs.readFileSync(badRefPath, 'utf8'));
  badRef30.expect = { pass: true, basePass: true, score: 0.6, items: [true, false] };
  fs.writeFileSync(badRefPath, JSON.stringify(badRef30, null, 2));
  const rDryBadRef = await runExam({ benchDir: bDryBadRef.fakeBench, questionsDir: bDryBadRef.only30Dir, dryRun: true, outDir: null });
  assert.equal(rDryBadRef.ok, false);
  assert.equal(rDryBadRef.exitCode, 4);
  assert.equal(rDryBadRef.summary.passedQuestions, 0);
  assert.equal(rDryBadRef.questions[0].pass, false);
  assert.equal(rDryBadRef.questions[0].score, 0);
});

test('exam-14 回归：30-1 追加合法可选事件不误清零、28-1 单分项失败保留部分分、运行期控制失配必零分落盘', async (t) => {
  const findResultJson = (dir) => {
    const hit = fs.readdirSync(dir, { recursive: true }).find((f) => String(f).endsWith('result.json'));
    assert.ok(hit, `应在 ${dir} 下落盘 result.json`);
    return JSON.parse(fs.readFileSync(path.join(dir, String(hit)), 'utf8'));
  };

  // 1. 30-1 在参考样本末尾追加合法第 21 个可选事件 m21（基准帧 180、探针帧 150），以及可选事件名为 other_event 时均应满分通过且负对照 5/5 全拦
  for (const extraId of ['m21', 'other_event']) {
    const root30 = makeTempDir(t);
    const fakeBench30 = path.join(root30, 'bench');
    const only30Dir = path.join(fakeBench30, 'questions-only-30');
    const evalRoot30 = path.join(root30, 'eval-runs');
    fs.mkdirSync(only30Dir, { recursive: true });
    fs.cpSync(path.join(QUESTIONS_DIR, 'level-2-a/30-1.json'), path.join(only30Dir, '30-1.json'));
    fs.cpSync(path.join(HERE, 'refs'), path.join(fakeBench30, 'refs'), { recursive: true });

    const refPath = path.join(fakeBench30, 'refs/level-2-a/30-1.reference.json');
    const ref30 = JSON.parse(fs.readFileSync(refPath, 'utf8'));
    ref30.beatEvents.push({ id: extraId, frame: 180 });
    ref30.probeBeatEvents.push({ id: extraId, frame: 150 });
    fs.writeFileSync(refPath, JSON.stringify(ref30, null, 2));

    const r30 = await runExam({ benchDir: fakeBench30, questionsDir: only30Dir, evalRoot: evalRoot30, outDir: null });
    assert.equal(r30.ok, true, `${extraId}: ${JSON.stringify(r30.error)} / ${JSON.stringify(r30.questions[0]?.errors)}`);
    assert.equal(r30.exitCode, 0, extraId);
    assert.equal(r30.questions[0].pass, true, extraId);
    assert.equal(r30.questions[0].score, 1, extraId);
    assert.equal(r30.questions[0].negativeControlsChecked, 5, extraId);
    assert.equal(r30.questions[0].negativeControlsRejected, 5, extraId);
    const res30 = findResultJson(evalRoot30);
    assert.equal(res30.pass, true, extraId);
    assert.equal(res30.score, 1, extraId);
  }

  // 2. 28-1 收紧 maxW=0.05（正对照 0.5 分、负对照 2/2 正常拦截）-> exit 1，单题报告与落盘 result.json 均保留真实部分分 0.5
  const q28Dir = makeTempDir(t);
  const evalRoot28 = makeTempDir(t);
  const out28 = makeTempDir(t);
  const q28 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/28-1.json'), 'utf8'));
  q28.scoring[0].args.maxW = 0.05;
  fs.writeFileSync(path.join(q28Dir, '28-1.json'), JSON.stringify(q28, null, 2));

  const r28 = await runExam({ questionsDir: q28Dir, evalRoot: evalRoot28, outDir: out28 });
  assert.equal(r28.ok, false);
  assert.equal(r28.exitCode, 1);
  assert.equal(r28.questions[0].valid, true);
  assert.equal(r28.questions[0].pass, false);
  assert.equal(r28.questions[0].score, 0.5);
  assert.equal(r28.questions[0].negativeControlsChecked, 2);
  assert.equal(r28.questions[0].negativeControlsRejected, 2);
  const saved28 = JSON.parse(fs.readFileSync(path.join(out28, 'report.json'), 'utf8'));
  assert.equal(saved28.questions[0].pass, false);
  assert.equal(saved28.questions[0].score, 0.5);
  const res28 = findResultJson(evalRoot28);
  assert.equal(res28.status, 'fail');
  assert.equal(res28.pass, false);
  assert.equal(res28.score, 0.5);

  // 3. 合法 30-1 夹具过 validateRefs 后，运行期出现负对照失守或固定样本控制项失配（controlsOk: false）时：exit 1 且报告与 result.json 均零分落盘
  const q30ValidDir = makeTempDir(t);
  fs.cpSync(path.join(QUESTIONS_DIR, 'level-2-a/30-1.json'), path.join(q30ValidDir, '30-1.json'));

  for (const [label, outcomePatch] of [
    ['neg-leak', { pass: true, controlsOk: true, negativeControlsChecked: 4, negativeControlsRejected: 3 }],
    ['ref-mismatch', { pass: false, controlsOk: false, negativeControlsChecked: 4, negativeControlsRejected: 4 }],
  ]) {
    const evalRootCtrl = makeTempDir(t);
    const outCtrl = makeTempDir(t);
    const rCtrl = await runExam({
      questionsDir: q30ValidDir,
      evalRoot: evalRootCtrl,
      outDir: outCtrl,
      evaluators: {
        '30-1': ({ question }) => ({
          positiveScore: 1,
          predicates: Object.fromEntries(question.basePredicates.map((p) => [p, { pass: true, basis: 'test' }])),
          metrics: Object.fromEntries(question.scoring.map((s) => [s.metric, { pass: true, basis: 'test' }])),
          detail: `模拟运行期控制失配（${label}）`,
          ...outcomePatch,
        }),
      },
    });
    assert.equal(rCtrl.ok, false, label);
    assert.equal(rCtrl.exitCode, 1, label);
    assert.equal(rCtrl.questions[0].valid, true, label);
    assert.equal(rCtrl.questions[0].pass, false, label);
    assert.equal(rCtrl.questions[0].score, 0, label);
    const savedCtrl = JSON.parse(fs.readFileSync(path.join(outCtrl, 'report.json'), 'utf8'));
    assert.equal(savedCtrl.questions[0].pass, false, label);
    assert.equal(savedCtrl.questions[0].score, 0, label);
    const resCtrl = findResultJson(evalRootCtrl);
    assert.equal(resCtrl.status, 'fail', label);
    assert.equal(resCtrl.pass, false, label);
    assert.equal(resCtrl.score, 0, label);
  }

  // 4. 省略 requiredEventIds 的旧版 30-1 题面不得跳过“漏交必需事件”负对照而假绿（R3 回归）
  const legacy30 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-2-a/30-1.json'), 'utf8'));
  delete legacy30.scoring[0].args.requiredEventIds;
  delete legacy30.scoring[1].args.requiredEventIds;
  const legacyDir = makeTempDir(t);
  const legacyEvalRoot = makeTempDir(t);
  fs.writeFileSync(path.join(legacyDir, '30-1.json'), JSON.stringify(legacy30, null, 2));
  const rLegacy = await runExam({ questionsDir: legacyDir, evalRoot: legacyEvalRoot, outDir: null });
  assert.equal(rLegacy.ok, false);
  assert.equal(rLegacy.exitCode, 1);
  assert.equal(rLegacy.questions[0].pass, false);
  assert.equal(rLegacy.questions[0].score, 0);
  assert.equal(rLegacy.questions[0].negativeControlsChecked, 5);
  assert.equal(rLegacy.questions[0].negativeControlsRejected, 4);
  const legacyRes = findResultJson(legacyEvalRoot);
  assert.equal(legacyRes.pass, false);
  assert.equal(legacyRes.score, 0);
});