// B10 + B22：预期失败题库、blockedBy 变化重跑门、隐藏题隔离与看板脱敏回归测试
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as bench from './index.mjs';
import {
  buildBoard,
  hasBlockedByChanged,
  projectPublicQuestion,
  renderBoardHtml,
  runExamQuestion,
  scanQuestionLeaks,
  validateQuestion,
} from './index.mjs';
import { runExam } from './exam.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const QUESTIONS_DIR = path.join(HERE, 'questions');
const EXPECTED_FAIL_DIR = path.join(QUESTIONS_DIR, 'expected-fail');
const SEATBELT = process.platform === 'darwin'
  && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

function makeTempDir(t, prefix = 'beiming-b10-b22-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const allPassJudge = ({ question }) => ({
  metrics: Object.fromEntries(question.scoring.map((s) => [s.metric, { pass: true }])),
  predicates: Object.fromEntries((question.basePredicates ?? []).map((p) => [p, true])),
});

test('B10/B22-1: expected-fail/ 下 5 道预期失败题存在、过 B1 校验且零泄露', () => {
  const expected = [
    { file: '10-1.json', id: '10-1', level: 4, benchCode: undefined },
    { file: '14-1.json', id: '14-1', level: 4, benchCode: undefined },
    { file: '24-1.json', id: '24-1', level: 5, benchCode: '024-1' },
    { file: '30-2.json', id: '30-2', level: 5, benchCode: '外01-2' },
    { file: '900-1.json', id: '900-1', level: 5, benchCode: 'B22-1' },
  ];
  const actualFiles = fs.readdirSync(EXPECTED_FAIL_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(actualFiles, expected.map((e) => e.file).sort());

  for (const spec of expected) {
    const abs = path.join(EXPECTED_FAIL_DIR, spec.file);
    assert.ok(fs.existsSync(abs), `缺少 ${spec.file}`);
    const raw = fs.readFileSync(abs, 'utf8');
    assert.deepEqual(scanQuestionLeaks(raw), [], `${spec.file} 原文不能有泄露`);
    const vRaw = validateQuestion(raw);
    assert.deepEqual(vRaw, { ok: true, schemaErrors: [], violations: {}, leaks: [] }, `${spec.file}: ${JSON.stringify(vRaw)}`);
    const q = JSON.parse(raw);
    assert.deepEqual(validateQuestion(q), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, spec.file);
    assert.equal(q.id, spec.id);
    assert.equal(q.level, spec.level);
    assert.equal(q.flags.expectedFail, true);
    assert.equal(q.flags.hidden, false);
    assert.ok(q.flags.blockedBy.length >= 1);
    assert.equal('refs' in q, false, `${spec.file} 无参考夹具时省略 refs`);
    if (spec.benchCode !== undefined) {
      assert.equal(q.ext?.['bench.code'], spec.benchCode);
    }
    const pub = projectPublicQuestion(q);
    assert.equal('ext' in pub, false);
    assert.equal(pub.id, spec.id);
  }

  const b22 = JSON.parse(fs.readFileSync(path.join(EXPECTED_FAIL_DIR, '900-1.json'), 'utf8'));
  const b22Text = b22.flags.blockedBy.join(' | ');
  assert.match(b22Text, /核心接管写实/);
  assert.match(b22Text, /G18/);
});

test('B10/B22-2: runExam 自动发现并跳过 5 道 expected-fail 题，且既有 12 道公开题全部通过', async (t) => {
  const outDir = makeTempDir(t);
  const report = await runExam({ outDir });
  assert.equal(report.ok, true, JSON.stringify(report.error));
  assert.equal(report.exitCode, 0);
  assert.ok(report.summary.totalQuestions >= 17);
  assert.equal(report.summary.validQuestions, report.summary.totalQuestions);
  assert.equal(report.summary.invalidQuestions, 0);
  assert.ok(report.summary.skippedQuestions >= 5);
  assert.equal(report.summary.evaluatedQuestions, report.summary.totalQuestions - report.summary.skippedQuestions);
  assert.ok(report.summary.evaluatedQuestions >= 12);
  assert.equal(report.summary.passedQuestions, report.summary.evaluatedQuestions);
  assert.equal(report.summary.failedQuestions, 0);

  for (const id of ['10-1', '14-1', '24-1', '30-2', '900-1']) {
    const entry = report.questions.find((q) => q.id === id);
    assert.ok(entry, `报告缺少 ${id}`);
    assert.equal(entry.valid, true, id);
    assert.equal(entry.status, 'expected-fail', id);
    assert.equal(entry.pass, false, id);
    assert.equal(entry.score, 0, id);
  }
});

test('B22-3: hasBlockedByChanged 单元测试（相同、重排去重、增删改、null 与非法类型）', () => {
  assert.equal(bench.hasBlockedByChanged, hasBlockedByChanged);

  // null / undefined 作为 previousBlockedBy 时视为无对照，不触发重跑
  assert.equal(hasBlockedByChanged(['缺 A'], null), false);
  assert.equal(hasBlockedByChanged(['缺 A'], undefined), false);
  assert.equal(hasBlockedByChanged(null, null), false);
  assert.equal(hasBlockedByChanged([], null), false);

  // 相同与重排/空白/重复归一后相同
  assert.equal(hasBlockedByChanged(['核心接管写实', 'G18'], ['核心接管写实', 'G18']), false);
  assert.equal(hasBlockedByChanged([' G18 ', '', '核心接管写实', 'G18'], ['核心接管写实', '  G18']), false);
  assert.equal(hasBlockedByChanged([], ['  ']), false);
  assert.equal(hasBlockedByChanged(null, []), false);

  // 增、删、改均返回 true
  assert.equal(hasBlockedByChanged(['核心接管写实', 'G18'], ['核心接管写实']), true);
  assert.equal(hasBlockedByChanged(['核心接管写实'], ['核心接管写实', 'G18']), true);
  assert.equal(hasBlockedByChanged(['核心接管写实', 'G19'], ['核心接管写实', 'G18']), true);
  assert.equal(hasBlockedByChanged(null, ['G18']), true);

  // 非法类型抛 usageError (exitCode 2)
  const badInputs = ['str', 123, {}, true, [123], [null], ['ok', 42], ['ok', undefined]];
  const sparse = ['a', 'b'];
  delete sparse[0];
  badInputs.push(sparse);
  badInputs.push(new Proxy(['a'], {}));
  const withGetter = ['a'];
  Object.defineProperty(withGetter, 1, { enumerable: true, get() { throw new Error('getter must not run'); } });
  badInputs.push(withGetter);

  for (const bad of badInputs) {
    assert.throws(() => hasBlockedByChanged(bad, ['a']), (e) => e?.exitCode === 2 && /^usage\./.test(e?.code));
    assert.throws(() => hasBlockedByChanged(bad, null), (e) => e?.exitCode === 2 && /^usage\./.test(e?.code));
    assert.throws(() => hasBlockedByChanged(['a'], bad), (e) => e?.exitCode === 2 && /^usage\./.test(e?.code));
  }
});

test('B22-4: runExamQuestion 对 B22 (900-1.json) 默认与 blockedBy 未变不重跑，变化且开启门控时放行重跑', async (t) => {
  const b22File = path.join(EXPECTED_FAIL_DIR, '900-1.json');
  const b22 = JSON.parse(fs.readFileSync(b22File, 'utf8'));
  const evalRoot = makeTempDir(t, 'beiming-b22-runs-');

  // 1) 未传 rerunOnBlockedByChange 时向后兼容：即使传入不同的 previousBlockedBy 仍跳过
  let calls = 0;
  const compatRes = await runExamQuestion({
    questionFile: b22File,
    evalRoot,
    previousBlockedBy: ['只有一项'],
    solver: async () => { calls++; return { gpuSeconds: 9 }; },
    judge: allPassJudge,
  });
  assert.equal(calls, 0);
  assert.equal(compatRes.status, 'expected-fail');
  assert.equal(compatRes.pass, false);
  assert.equal(compatRes.score, 0);
  assert.equal(compatRes.cost.gpuSeconds, 0);

  // 2) 开启 rerunOnBlockedByChange，previousBlockedBy 为 null 或内容相同（含顺序调整/空格）时均不重跑
  for (const prev of [null, [...b22.flags.blockedBy], [...b22.flags.blockedBy].reverse().map((s) => ` ${s} `)]) {
    let called = 0;
    const res = await runExamQuestion({
      questionFile: b22File,
      evalRoot,
      previousBlockedBy: prev,
      rerunOnBlockedByChange: true,
      solver: async () => { called++; return { gpuSeconds: 12 }; },
      judge: allPassJudge,
    });
    assert.equal(called, 0);
    assert.equal(res.status, 'expected-fail');
    assert.equal(res.pass, false);
    assert.equal(res.score, 0);
    assert.equal(res.cost.gpuSeconds, 0);
  }

  // 3) 开启 rerunOnBlockedByChange 且 blockedBy 发生变化时放行重跑 solver 与 judge
  let solverCalls = 0;
  let judgeCalls = 0;
  const rerunRes = await runExamQuestion({
    questionFile: b22File,
    evalRoot,
    previousBlockedBy: ['核心接管写实（core 路径追踪写实接管）'],
    rerunOnBlockedByChange: true,
    solver: async ({ worktreeDir }) => {
      solverCalls++;
      fs.writeFileSync(path.join(worktreeDir, 'submission.json'), JSON.stringify({ cost: { gpuSeconds: 3 } }));
      return { tokens: 50, turns: 1, gpuSeconds: 3 };
    },
    judge: (ctx) => {
      judgeCalls++;
      return allPassJudge(ctx);
    },
  });
  assert.equal(solverCalls, 1);
  assert.equal(judgeCalls, 1);
  assert.equal(rerunRes.status, 'pass');
  assert.equal(rerunRes.pass, true);
  assert.equal(rerunRes.score, 1);
  assert.equal(rerunRes.cost.gpuSeconds, 3);

  // 4) 隐藏 expectedFail 题重跑时依然严格脱敏 blockedBy / assertions / 私有字段
  const tmpDir = makeTempDir(t, 'beiming-b22-hidden-xf-');
  const hiddenXf = structuredClone(b22);
  hiddenXf.id = '900-99';
  hiddenXf.flags.hidden = true;
  hiddenXf.flags.blockedBy = ['SECRET-BLOCKER-ALPHA', 'SECRET-BLOCKER-BETA'];
  const hiddenXfFile = path.join(tmpDir, 'hidden-xf.json');
  fs.writeFileSync(hiddenXfFile, JSON.stringify(hiddenXf, null, 2));

  const dumpRun = (runDir) => fs.readdirSync(runDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
    .join('\n');

  const skipHidden = await runExamQuestion({
    questionFile: hiddenXfFile,
    evalRoot,
    previousBlockedBy: ['SECRET-BLOCKER-BETA', 'SECRET-BLOCKER-ALPHA'],
    rerunOnBlockedByChange: true,
    solver: async () => { throw new Error('must not run'); },
    judge: allPassJudge,
  });
  assert.equal(skipHidden.status, 'expected-fail');
  assert.deepEqual(skipHidden.blockedBy, ['[hidden]']);
  assert.ok(!dumpRun(skipHidden.runDir).includes('SECRET-BLOCKER'));

  // R1 回归：将隐藏预期失败题落盘 result.json 的脱敏占位 ["[hidden]"] 原样传回 previousBlockedBy，不得误判为变化而重跑
  let redactedCalls = 0;
  const recordedBlockedBy = JSON.parse(fs.readFileSync(skipHidden.resultFile, 'utf8')).blockedBy;
  const skipRedacted = await runExamQuestion({
    questionFile: hiddenXfFile,
    evalRoot,
    previousBlockedBy: recordedBlockedBy,
    rerunOnBlockedByChange: true,
    solver: async () => { redactedCalls++; return { gpuSeconds: 1 }; },
    judge: allPassJudge,
  });
  assert.deepEqual([redactedCalls, skipRedacted.status, skipRedacted.cost.gpuSeconds], [0, 'expected-fail', 0]);

  // R1 兼容回归：沿用旧签名传 forceExpectedFail: null 时仍按假值跳过，不抛参数错
  const legacyNullForce = await runExamQuestion({
    questionFile: b22File,
    evalRoot,
    forceExpectedFail: null,
  });
  assert.equal(legacyNullForce.status, 'expected-fail');

  let hiddenSawQuestion = null;
  const rerunHidden = await runExamQuestion({
    questionFile: hiddenXfFile,
    evalRoot,
    previousBlockedBy: ['SECRET-BLOCKER-ALPHA'],
    rerunOnBlockedByChange: true,
    solver: async ({ questionFile }) => {
      hiddenSawQuestion = JSON.parse(fs.readFileSync(questionFile, 'utf8'));
      return { tokens: 10, turns: 1, gpuSeconds: 1 };
    },
    judge: allPassJudge,
  });
  assert.equal(rerunHidden.status, 'pass');
  assert.deepEqual(Object.keys(hiddenSawQuestion).sort(), ['assets', 'brief', 'deliverable', 'id', 'level', 'title']);
  assert.deepEqual(rerunHidden.blockedBy, ['[hidden]']);
  assert.deepEqual(rerunHidden.assertions, []);
  assert.ok(!dumpRun(rerunHidden.runDir).includes('SECRET-BLOCKER'));

  // 非法参数校验
  await assert.rejects(
    runExamQuestion({ questionFile: b22File, evalRoot, previousBlockedBy: 'bad', rerunOnBlockedByChange: true }),
    (e) => e?.exitCode === 2 && /^usage\./.test(e?.code),
  );
  await assert.rejects(
    runExamQuestion({ questionFile: b22File, evalRoot, rerunOnBlockedByChange: 'yes' }),
    (e) => e?.exitCode === 2 && /^usage\./.test(e?.code),
  );
});

test('B10/B22-5: 看板纳入 5 道预期失败题并校验隐藏题投影与零泄露', (t) => {
  const realQuestions = fs.readdirSync(QUESTIONS_DIR, { recursive: true })
    .filter((f) => String(f).endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, String(f)), 'utf8')));

  const tmpDir = makeTempDir(t, 'beiming-b10-board-');
  const base29 = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, 'level-1/29-1.json'), 'utf8'));
  const secretTitle = 'CANARY-HIDDEN-TITLE-XYZ';
  const secretBrief = 'CANARY-HIDDEN-BRIEF-XYZ';
  const secretPass = 'CANARY-HIDDEN-SCORING-PASS-XYZ';
  const secretCtrl = 'CANARY-HIDDEN-CONTROLS-XYZ';
  const secretCal = 'CANARY-HIDDEN-CALIBRATION-XYZ';
  const secretBlockedBy = 'CANARY-HIDDEN-BLOCKEDBY-XYZ';
  const hiddenQ = {
    ...structuredClone(base29),
    id: '29-901',
    title: secretTitle,
    brief: secretBrief,
    scoring: base29.scoring.map((item, idx) => (idx === 0 ? { ...item, pass: secretPass } : item)),
    controls: { referencePass: secretCtrl, negative: `${secretCtrl}-NEG` },
    needs: ['canary.hidden-need'],
    flags: { hidden: true, expectedFail: true, blockedBy: [secretBlockedBy] },
    calibration: { status: 'calibrated', source: secretCal, noiseFloor: 0.05, version: 1 },
    ext: { 'bench.variantOf': '29-1' },
  };
  delete hiddenQ.refs;

  const hiddenPath = path.join(tmpDir, 'hidden-question.json');
  fs.writeFileSync(hiddenPath, JSON.stringify(hiddenQ, null, 2));
  const rawHidden = fs.readFileSync(hiddenPath, 'utf8');
  assert.deepEqual(validateQuestion(rawHidden), { ok: true, schemaErrors: [], violations: {}, leaks: [] });

  const pub = projectPublicQuestion(hiddenQ);
  assert.deepEqual(Object.keys(pub).sort(), ['assets', 'brief', 'deliverable', 'id', 'level', 'title']);
  for (const hiddenKey of ['scoring', 'controls', 'calibration', 'needs', 'flags', 'ext', 'refs', 'blockedBy']) {
    assert.equal(hiddenKey in pub, false, `公开投影不得包含 ${hiddenKey}`);
  }

  const publicResults = ['10-1', '14-1', '24-1', '30-2', '900-1'].map((questionId) => ({
    format: 'bench-result/0.1',
    questionId,
    source: 'three',
    model: 'model-test',
    status: 'expected-fail',
    pass: false,
    score: 0,
    visibility: 'public',
    unmeasured: 0,
  }));

  const publicBoard = buildBoard({
    asOf: '2026-11-24',
    questions: realQuestions,
    results: publicResults,
  });
  const publicHtml = renderBoardHtml(publicBoard);
  assert.ok(publicBoard.reverseIndicators.expectedFailQuestions.count >= 5);
  assert.deepEqual(
    ['10-1', '14-1', '24-1', '30-2', '900-1'].filter((id) => publicBoard.reverseIndicators.expectedFailQuestions.ids.includes(id)),
    ['10-1', '14-1', '24-1', '30-2', '900-1'],
  );
  for (const id of ['10-1', '14-1', '24-1', '30-2', '900-1']) {
    const row = publicBoard.matrix.rows.find((r) => r.questionId === id);
    assert.ok(row, id);
    assert.equal(row.expectedFail, true, id);
    assert.equal(row.cells[0].status, 'expected-fail', id);
  }
  assert.match(publicHtml, /预期失败/);

  const board = buildBoard({
    asOf: '2026-11-24',
    questions: [...realQuestions, hiddenQ],
    results: [
      ...publicResults,
      {
        format: 'bench-result/0.1',
        questionId: '29-901',
        level: 1,
        source: 'three',
        model: 'model-test',
        status: 'expected-fail',
        pass: false,
        score: 0,
        visibility: 'hidden',
        blockedBy: [secretBlockedBy],
        unmeasured: 0,
      },
    ],
  });
  const html = renderBoardHtml(board);

  assert.ok(board.reverseIndicators.expectedFailQuestions.count >= 5);
  const hiddenRow = board.matrix.rows.find((r) => r.questionId === '29-901');
  assert.equal(hiddenRow.hidden, true);
  assert.equal(hiddenRow.title, '隐藏题 29-901');
  const serialized = JSON.stringify(board) + html;
  for (const secret of [secretTitle, secretBrief, secretPass, secretCtrl, secretCal, secretBlockedBy, 'canary.hidden-need']) {
    assert.equal(serialized.includes(secret), false, `看板泄露了 ${secret}`);
  }
});

test('B10-6: 临时目录隐藏题在 macOS seatbelt 沙箱下做题子进程读不到原隐藏题文件及其目录', async (t) => {
  const dir = makeTempDir(t, 'beiming-b10-seatbelt-');
  const hiddenDir = path.join(dir, 'private-bank');
  const evalRoot = path.join(dir, 'eval-root');
  fs.mkdirSync(hiddenDir);

  const sample = JSON.parse(fs.readFileSync(path.join(REPO, 'beiming/kernel/contracts/question-file/examples/minimal.json'), 'utf8'));
  const secretQuestion = {
    ...structuredClone(sample),
    id: '29-902',
    scoring: [{ metric: 'canary.secret-metric', pass: 'CANARY-SCORING-SECRET', weight: 1 }],
    controls: { referencePass: 'CANARY-REF-SECRET', negative: 'CANARY-NEG-SECRET' },
    needs: ['canary.secret-need'],
    flags: { hidden: true, expectedFail: false, blockedBy: [] },
    calibration: { status: 'uncalibrated', source: 'CANARY-CAL-SECRET', noiseFloor: null, version: 0 },
  };
  const qFile = path.join(hiddenDir, '29-902.json');
  const siblingFile = path.join(hiddenDir, 'sibling-secret.json');
  fs.writeFileSync(qFile, JSON.stringify(secretQuestion, null, 2));
  fs.writeFileSync(siblingFile, '{"secret":"CANARY-SIBLING"}');

  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, `import fs from 'node:fs';
const readSafe = (target) => {
  try { return { ok: true, content: fs.readFileSync(target, 'utf8') }; }
  catch (e) { return { ok: false, code: e.code || 'ERR' }; }
};
const listSafe = (target) => {
  try { return { ok: true, items: fs.readdirSync(target) }; }
  catch (e) { return { ok: false, code: e.code || 'ERR' }; }
};
const [origQ, sibling, origDir] = process.argv.slice(2);
fs.writeFileSync('probe-out.json', JSON.stringify({
  projected: JSON.parse(fs.readFileSync('question.json', 'utf8')),
  origQ: readSafe(origQ),
  sibling: readSafe(sibling),
  origDir: listSafe(origDir),
}));
`);

  const res = await runExamQuestion({
    questionFile: qFile,
    evalRoot,
    solverCmd: `"${process.execPath}" "${probe}" "${qFile}" "${siblingFile}" "${hiddenDir}"`,
    judge: allPassJudge,
  });
  assert.equal(res.status, 'pass');

  const obs = JSON.parse(fs.readFileSync(path.join(res.runDir, 'observation.json'), 'utf8'));
  const probeOut = JSON.parse(fs.readFileSync(path.join(res.runDir, 'worktree/probe-out.json'), 'utf8'));
  assert.deepEqual(Object.keys(probeOut.projected).sort(), ['assets', 'brief', 'deliverable', 'id', 'level', 'title']);
  const projText = JSON.stringify(probeOut.projected);
  for (const s of ['CANARY-SCORING-SECRET', 'CANARY-REF-SECRET', 'CANARY-NEG-SECRET', 'CANARY-CAL-SECRET', 'canary.secret-need', 'canary.secret-metric']) {
    assert.equal(projText.includes(s), false, `question.json 不得包含 ${s}`);
  }

  assert.equal(obs.isolation, SEATBELT ? 'seatbelt' : 'process-cwd');
  if (SEATBELT) {
    assert.equal(probeOut.origQ.ok, false, 'seatbelt 下不得读到原隐藏题文件');
    assert.equal(probeOut.sibling.ok, false, 'seatbelt 下不得读到同目录兄弟文件');
    assert.equal(probeOut.origDir.ok, false, 'seatbelt 下不得列出隐藏题目录');
  } else {
    t.diagnostic('当前环境不支持 sandbox-exec，跳过 seatbelt 文件边界断言');
  }
});
