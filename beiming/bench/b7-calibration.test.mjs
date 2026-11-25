// B7（05 §6.5）：12 道公开考题容差校准五步、记录一致性、36 负对照与 15 参考夹具复核及看板校准变更标记端到端测试
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendBoardHistory, buildBoard, renderBoardHtml } from './board.mjs';
import {
  CALIBRATION_IDS,
  CALIBRATION_RECORD_FORMAT,
  CALIBRATION_TIERS,
  CALIBRATION_VERSION,
  RELAXED_IDS,
  STRICT_IDS,
  calibrateQuestion,
  checkQuestionReferences,
  getCalibrationTier,
  hasMediaTools,
  loadAllCalibrationRecords,
  loadCalibrationRecord,
  runQuestionNegativeControls,
  validateCalibrationRecord,
} from './calibration/index.mjs';
import { loadSolutionSpec } from './solutions/index.mjs';
import { scanQuestionLeaks, validateQuestion } from './validate-question.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CALIBRATION_DIR = join(HERE, 'calibration');
const BINARY_EXT_RE = /\.(mp4|mov|wav|png|jpe?g|mkv|webm)$/i;

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function requireOrSkipMedia(t) {
  if (hasMediaTools()) return true;
  const required = (process.env.BEIMING_REQUIRE ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (required.includes('ffmpeg')) {
    assert.fail('BEIMING_REQUIRE 包含 ffmpeg，但当前环境缺少 ffmpeg/ffprobe');
  }
  t.skip('缺少 ffmpeg/ffprobe');
  return false;
}

test('B7-1 12 道公开考题与 12 份校准记录全过契约校验、严档/放宽档分档齐备、噪声地板与题面逐一严格一致且零泄露', () => {
  assert.equal(CALIBRATION_RECORD_FORMAT, 'bench-calibration/0.1');
  assert.equal(CALIBRATION_IDS.length, 12);
  assert.equal(STRICT_IDS.length, 9);
  assert.equal(RELAXED_IDS.length, 3);
  assert.deepEqual([...CALIBRATION_TIERS.relaxed].sort(), ['15-2', '18-1', '18-2']);

  // 题号别名兼容 1-1/01-1 与 5-1/05-1
  assert.equal(getCalibrationTier('01-1').questionId, '1-1');
  assert.equal(getCalibrationTier('1-1').tier, 'strict');
  assert.equal(getCalibrationTier('05-1').questionId, '5-1');
  assert.equal(getCalibrationTier('15-2').tier, 'relaxed');
  assert.equal(loadCalibrationRecord('01-1').questionId, '1-1');
  assert.equal(loadCalibrationRecord('05-1').questionId, '5-1');

  const records = loadAllCalibrationRecords();
  assert.equal(records.length, 12);
  assert.ok(Object.isFrozen(records));

  let uncalibratedCount = 0;
  let strictCount = 0;
  let relaxedCount = 0;

  for (let i = 0; i < CALIBRATION_IDS.length; i++) {
    const id = CALIBRATION_IDS[i];
    const spec = loadSolutionSpec(id);
    const raw = readFileSync(spec.questionPath, 'utf8');
    const question = JSON.parse(raw);

    // 原文与解析对象均必须通过 validateQuestion（含 B1_METRIC_NAMESPACE 与零泄露）
    for (const input of [raw, question]) {
      const verdict = validateQuestion(input);
      assert.deepEqual(verdict, { ok: true, schemaErrors: [], violations: {}, leaks: [] }, `${id} 校验未过：${JSON.stringify(verdict)}`);
    }

    // 0 道题 uncalibrated；全部四键齐备且符合冻结契约
    if (question.calibration.status === 'uncalibrated') uncalibratedCount += 1;
    assert.deepEqual(Object.keys(question.calibration).sort(), ['noiseFloor', 'source', 'status', 'version'], `${id} calibration 键集不合规`);
    assert.equal(question.calibration.status, 'calibrated', `${id} 必须为 calibrated`);
    assert.ok(Number.isInteger(question.calibration.version) && question.calibration.version >= 1, `${id} version 必须 >= 1`);
    assert.equal(question.calibration.version, CALIBRATION_VERSION);
    assert.ok(typeof question.calibration.noiseFloor === 'number' && Number.isFinite(question.calibration.noiseFloor) && question.calibration.noiseFloor >= 0, `${id} noiseFloor 必须为有限非负数`);

    // 校准记录结构、深冻结与题面逐字段一致
    const record = records[i];
    assert.ok(Object.isFrozen(record) && Object.isFrozen(record.step1NoiseFloor) && Object.isFrozen(record.step4Thresholds));
    const check = validateCalibrationRecord(record, question);
    assert.deepEqual(check, { ok: true, errors: [], leaks: [] }, `${id} 校准记录核验未过：${JSON.stringify(check)}`);
    assert.equal(record.noiseFloor, question.calibration.noiseFloor);
    assert.equal(record.version, question.calibration.version);
    assert.equal(record.status, question.calibration.status);
    assert.equal(record.calibrationField.source, question.calibration.source);

    if (record.tier === 'strict') strictCount += 1;
    else if (record.tier === 'relaxed') relaxedCount += 1;
  }

  assert.equal(uncalibratedCount, 0);
  assert.equal(strictCount, 9);
  assert.equal(relaxedCount, 3);

  // 校验器对篡改记录必须准确拒收
  const tampered = structuredClone(records[0]);
  tampered.noiseFloor = -0.1;
  assert.equal(validateCalibrationRecord(tampered).ok, false);

  const tamperedField = structuredClone(records[0]);
  tamperedField.calibrationField.tier = 'strict';
  assert.equal(validateCalibrationRecord(tamperedField).ok, false);

  const mismatchedQuestion = structuredClone(loadSolutionSpec('1-1').question);
  mismatchedQuestion.calibration.version = 2;
  assert.equal(validateCalibrationRecord(records[0], mismatchedQuestion).ok, false);

  // calibration 目录零二进制媒体且零泄露
  const calFiles = walkFiles(CALIBRATION_DIR);
  assert.equal(calFiles.filter((f) => f.endsWith('.json')).length, 12);
  for (const file of calFiles) {
    assert.doesNotMatch(file, BINARY_EXT_RE, `禁止提交二进制媒体：${file}`);
    if (file.endsWith('.json')) {
      assert.deepEqual(scanQuestionLeaks(readFileSync(file, 'utf8')), [], `校准记录存在泄露：${file}`);
    }
  }
});

test('B7-2 新版 v1 题面全量重跑：36/36 标准负对照全拦、全部参考夹具（含 4 份原作反例）100% 符合预期', () => {
  let totalNegatives = 0;
  let rejectedNegatives = 0;
  let totalFixtures = 0;
  const originalNegativesChecked = new Set();

  for (const id of CALIBRATION_IDS) {
    const { question } = loadSolutionSpec(id);
    const refRes = checkQuestionReferences(question);
    assert.equal(refRes.allOk, true, `${id} 参考夹具未全部通过：${JSON.stringify(refRes.fixtures)}`);
    for (const fixture of refRes.fixtures) {
      totalFixtures += 1;
      assert.equal(fixture.ok, true, `${id} 参考夹具 ${fixture.ref} 异常`);
      if (fixture.role === 'original-negative') {
        assert.equal(fixture.actualPass, false, `原作反例 ${fixture.ref} 必须判不过`);
        assert.ok(fixture.actualScore < 1, `原作反例 ${fixture.ref} 分数必须 < 1`);
        originalNegativesChecked.add(fixture.ref);
      }
    }

    const negRes = runQuestionNegativeControls(id);
    assert.equal(negRes.positiveBaseline.verdict.pass, true, `${id} 合成正对照基线必须满分通过`);
    assert.equal(negRes.positiveBaseline.verdict.score, 1);
    assert.equal(negRes.total, 3);
    assert.equal(negRes.rejected, 3);
    assert.equal(negRes.allRejectedAsDeclared, true, `${id} 标准负对照未 3/3 按声明拦截`);
    for (const ctrl of negRes.controls) {
      totalNegatives += 1;
      assert.equal(ctrl.pass, false, `负对照 ${ctrl.id} 必须判不过`);
      assert.ok(ctrl.score < 1, `负对照 ${ctrl.id} 分数必须 < 1`);
      assert.equal(ctrl.failedAsDeclared, true, `负对照 ${ctrl.id} 失分项必须与声明一致`);
      rejectedNegatives += 1;
    }
  }

  assert.equal(totalNegatives, 36);
  assert.equal(rejectedNegatives, 36);
  assert.ok(totalFixtures >= 15, `参考夹具核验总数应 >= 15，实得 ${totalFixtures}`);
  assert.deepEqual(
    [...originalNegativesChecked].sort(),
    [
      'bench/refs/level-1/28-1-negative.json',
      'bench/refs/level-2-a/23-2.original.json',
      'bench/refs/level-2-a/27-1.original.json',
      'bench/refs/level-2-a/30-1.hardcoded.json',
    ],
  );
});

test('B7-3 看板换尺子标记端到端核验：v0 uncalibrated → v1 calibrated 当日 12 题全打标、次日无变更清零', () => {
  const calibratedQuestions = CALIBRATION_IDS.map((id) => loadSolutionSpec(id).question);
  const previousQuestions = calibratedQuestions.map((q) => ({
    ...structuredClone(q),
    calibration: {
      status: 'uncalibrated',
      source: '初值未校准',
      noiseFloor: null,
      version: 0,
    },
  }));

  // 昨日（2026-11-24）：12 题均为 v0 uncalibrated
  const dayPrev = buildBoard({
    asOf: '2026-11-24',
    questions: previousQuestions,
    results: [],
    history: [],
  });
  assert.equal(dayPrev.calibrationChanges.length, 0);
  assert.ok(dayPrev.matrix.rows.every((row) => row.calibrationChanged === false));
  assert.ok(!renderBoardHtml(dayPrev).includes('今日校准变更'));

  // 今日（2026-11-25）：全部 12 道真实公开题升级为 v1 calibrated
  const dayCalibrated = buildBoard({
    asOf: '2026-11-25',
    questions: calibratedQuestions,
    results: [],
    history: dayPrev.history,
  });
  assert.equal(dayCalibrated.calibrationChanges.length, 12);
  assert.equal(dayCalibrated.matrix.rows.length, 12);
  assert.ok(dayCalibrated.matrix.rows.every((row) => row.calibrationChanged === true));
  for (const change of dayCalibrated.calibrationChanges) {
    assert.equal(change.version, 1);
    assert.equal(change.status, 'calibrated');
    assert.deepEqual(change.previous, { version: 0, status: 'uncalibrated' });
  }

  const todayHistoryRow = dayCalibrated.history.find((h) => h.asOf === '2026-11-25');
  assert.ok(todayHistoryRow);
  assert.deepEqual([...todayHistoryRow.calibrationChanged].sort(), [...CALIBRATION_IDS].sort());

  const appended = appendBoardHistory(dayPrev.history, dayCalibrated);
  assert.equal(appended.length, 2);
  assert.deepEqual([...appended[1].calibrationChanged].sort(), [...CALIBRATION_IDS].sort());

  const html = renderBoardHtml(dayCalibrated);
  assert.ok(html.includes('今日校准变更'));

  // 次日（2026-11-26）：保持 v1 calibrated 无变更，今日变更清零，昨日 12 题历史标记保留
  const dayNext = buildBoard({
    asOf: '2026-11-26',
    questions: calibratedQuestions,
    results: [],
    history: appended,
  });
  assert.equal(dayNext.calibrationChanges.length, 0);
  assert.ok(dayNext.matrix.rows.every((row) => row.calibrationChanged === false));
  assert.deepEqual(dayNext.history.map((h) => h.asOf), ['2026-11-24', '2026-11-25', '2026-11-26']);
  assert.deepEqual(dayNext.history[0].calibrationChanged, []);
  assert.deepEqual([...dayNext.history[1].calibrationChanged].sort(), [...CALIBRATION_IDS].sort());
  assert.deepEqual(dayNext.history[2].calibrationChanged, []);
  assert.ok(!renderBoardHtml(dayNext).includes('今日校准变更'));
});

test('B7-4 媒体实测代表题（严档 23-1/27-1 + 放宽档 15-2）重跑完整五步并与落盘记录一致', async (t) => {
  if (!requireOrSkipMedia(t)) return;
  const workDir = mkdtempSync(join(tmpdir(), 'beiming-b7-test-'));
  try {
    for (const id of ['23-1', '27-1', '15-2']) {
      const saved = loadCalibrationRecord(id);
      const fresh = await calibrateQuestion(id, {
        outDir: join(workDir, id),
        write: false,
        asOf: saved.calibratedOn,
      });
      assert.equal(fresh.format, CALIBRATION_RECORD_FORMAT);
      assert.equal(fresh.questionId, saved.questionId);
      assert.equal(fresh.tier, saved.tier);
      assert.equal(fresh.version, saved.version);
      assert.equal(fresh.status, 'calibrated');
      assert.equal(fresh.step1NoiseFloor.measurementCount, 4);
      assert.equal(fresh.step1NoiseFloor.allFullScore, true);
      assert.equal(fresh.noiseFloor, saved.noiseFloor);
      assert.equal(fresh.step2ReferenceCheck.allOk, true);
      assert.equal(fresh.step3NegativeControls.rejected, 3);
      assert.equal(fresh.step3NegativeControls.allRejectedAsDeclared, true);
      assert.equal(fresh.step4Thresholds.allSeparated, true);
      assert.equal(fresh.step4Thresholds.noiseFloorSafe, true);
      assert.deepEqual(fresh.calibrationField, saved.calibrationField);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    assert.equal(existsSync(workDir), false);
  }
});
