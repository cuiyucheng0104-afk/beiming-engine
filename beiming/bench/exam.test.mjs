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
