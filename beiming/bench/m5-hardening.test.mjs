import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBoard, renderBoardHtml } from './board.mjs';
import { runExamQuestion } from './runner.mjs';
import { runExamSuite } from './suite.mjs';
import { scanQuestionLeaks, validateQuestion } from './validate-question.mjs';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(BENCH_DIR, '../..');
const NODE = process.execPath;

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ---------------- 1. Seatbelt 沙箱拒读 beiming/bench/solutions ---------------- */

test('macOS seatbelt 沙箱阻断求解器读取 beiming/bench/solutions，但允许读取公开 refs 与 cards', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS seatbelt 仅在 darwin 上可用');
    return;
  }
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
  if (probe.status !== 0) {
    t.skip('当前宿主环境不允许嵌套 sandbox-exec');
    return;
  }

  const evalRoot = mkTempDir('beiming-m5-sandbox-');
  const scriptDir = mkTempDir('beiming-m5-solver-');
  t.after(() => {
    fs.rmSync(evalRoot, { recursive: true, force: true });
    fs.rmSync(scriptDir, { recursive: true, force: true });
  });

  const solverScript = path.join(scriptDir, 'probe-sandbox.mjs');
  const solTarget = path.join(REPO, 'beiming/bench/solutions/level-4/run-b18.mjs');
  const solSymlink = path.join(scriptDir, 'escape-link.mjs');
  fs.symlinkSync(path.join(REPO, 'beiming/bench/solutions/renderers.mjs'), solSymlink);
  const refTarget = path.join(REPO, 'beiming/bench/refs/level-4/41-1.json');
  const cardTarget = path.join(REPO, 'beiming/cards/post/bloom/card.json');
  fs.writeFileSync(solverScript, `
import fs from 'node:fs';
const report = { solBlocked: false, solCode: null, symlinkBlocked: false, symlinkCode: null, refReadable: false, cardReadable: false };
try {
  fs.readFileSync(${JSON.stringify(solTarget)}, 'utf8');
} catch (e) {
  report.solBlocked = true;
  report.solCode = e.code;
}
try {
  fs.readFileSync(${JSON.stringify(solSymlink)}, 'utf8');
} catch (e) {
  report.symlinkBlocked = true;
  report.symlinkCode = e.code;
}
try {
  report.refReadable = fs.readFileSync(${JSON.stringify(refTarget)}, 'utf8').length > 0;
} catch {}
try {
  report.cardReadable = fs.readFileSync(${JSON.stringify(cardTarget)}, 'utf8').length > 0;
} catch {}
fs.writeFileSync('probe-out.json', JSON.stringify(report));
`);

  const qFile = path.join(REPO, 'beiming/bench/questions/level-4/41-1.json');
  const res = await runExamQuestion({
    questionFile: qFile,
    evalRoot,
    solverCmd: `${JSON.stringify(NODE)} ${JSON.stringify(solverScript)}`,
    source: 'three',
    judge: async () => ({ predicates: {}, metrics: {} }),
  });

  const obs = JSON.parse(fs.readFileSync(path.join(res.runDir, 'observation.json'), 'utf8'));
  assert.equal(obs.isolation, 'seatbelt');
  const probeOut = JSON.parse(fs.readFileSync(path.join(res.runDir, 'worktree/probe-out.json'), 'utf8'));
  assert.equal(probeOut.solBlocked, true, `求解器不应读到 bench/solutions，实测 ${JSON.stringify(probeOut)}`);
  assert.equal(probeOut.solCode, 'EPERM');
  assert.equal(probeOut.symlinkBlocked, true, `求解器不应通过软链绕过读取 bench/solutions，实测 ${JSON.stringify(probeOut)}`);
  assert.equal(probeOut.symlinkCode, 'EPERM');
  assert.equal(probeOut.refReadable, true, '公开 bench/refs/level-4/41-1.json 必须保持可读');
  assert.equal(probeOut.cardReadable, true, '公开 beiming/cards/ 必须保持可读');
});

/* ---------------- 2. L4 垫脚题公开 inputSpec 解耦 ---------------- */

test('refs/level-4/41-{1,2,3}.json 包含无泄露的完整公开 inputSpec，与标准参数一致', () => {
  for (const id of ['41-1', '41-2', '41-3']) {
    const refPath = path.join(BENCH_DIR, 'refs/level-4', `${id}.json`);
    const raw = fs.readFileSync(refPath, 'utf8');
    assert.deepEqual(scanQuestionLeaks(raw), [], `${id} ref 不得含私有泄露`);
    const doc = JSON.parse(raw);
    assert.ok(doc.inputSpec && typeof doc.inputSpec === 'object', `${id}.json 缺少公开 inputSpec`);
    const film = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'solutions/level-4', id, 'film.json'), 'utf8'));
    const shot = film.shots[0];

    if (id === '41-1') {
      assert.equal(doc.inputSpec.patchRules?.length, 2);
      assert.deepEqual(doc.inputSpec.rasterSize, shot.params.rasterSize);
      assert.deepEqual(doc.inputSpec.camera, shot.params.camera);
      assert.ok(doc.inputSpec.cardParams?.ao && doc.inputSpec.cardParams?.bloom && doc.inputSpec.cardParams?.volumetric && doc.inputSpec.cardParams?.grade);
    } else if (id === '41-2') {
      assert.equal(doc.inputSpec.controlPoints?.length, 37);
      assert.deepEqual(doc.inputSpec.windowSec, shot.params.windowSec);
      assert.equal(doc.inputSpec.bodyLength, shot.params.bodyLength);
      assert.equal(doc.inputSpec.segments, shot.params.segments);
      assert.equal(doc.inputSpec.impulses?.length, 4);
      assert.ok(doc.inputSpec.swim && typeof doc.inputSpec.bankGain === 'number');
    } else if (id === '41-3') {
      assert.deepEqual(doc.inputSpec.checkFrames, shot.params.checkFrames);
      assert.equal(doc.inputSpec.viewMatrix?.length, 16);
      assert.equal(doc.inputSpec.projMatrix?.length, 16);
      assert.deepEqual(doc.inputSpec.counts, shot.params.counts);
      assert.deepEqual(doc.inputSpec.birthSeeds, [11, 23, 37]);
      assert.ok(doc.inputSpec.breathSpec && doc.inputSpec.wake && doc.inputSpec.bakeSpec);
    }
  }
});

/* ---------------- 3. L3/L4 考题交付证据文件契约 ---------------- */

test('L3/L4 核心考题（3-1, 31-1, 41-1..3, 42-1）显式声明 ext["bench.evidenceFiles"] 且通过 question/0.1 校验', () => {
  const targets = [
    ['level-3', '3-1.json', 'assembly'],
    ['level-3', '31-1.json', 'alternate.mp4'],
    ['level-4', '41-1.json', 'render.mjs'],
    ['level-4', '41-2.json', 'spine-samples.json'],
    ['level-4', '41-3.json', 'replay.mjs'],
    ['level-4', '42-1.json', 'deliverable.mp4'],
  ];
  for (const [sub, file, expectedToken] of targets) {
    const p = path.join(BENCH_DIR, 'questions', sub, file);
    const raw = fs.readFileSync(p, 'utf8');
    const checked = validateQuestion(raw);
    assert.equal(checked.ok, true, `${file} 未通过 validateQuestion: ${JSON.stringify(checked)}`);
    const q = JSON.parse(raw);
    const ev = q.ext?.['bench.evidenceFiles'];
    assert.ok(Array.isArray(ev) && ev.length >= 1, `${file} 缺少 ext["bench.evidenceFiles"]`);
    assert.ok(ev.includes('deliverable.mp4'), `${file} evidenceFiles 必须包含 deliverable.mp4`);
    assert.ok(ev.some((x) => x.includes(expectedToken)), `${file} evidenceFiles 应声明 ${expectedToken}`);
    assert.match(q.brief, /保留|工作目录/, `${file} brief 应提示保留宿主核验产物`);
  }
});

/* ---------------- 4. 公开看板与全卷报告隐藏题 ID 掩码 ---------------- */

test('buildBoard({ maskHiddenIds: true }) 与 renderBoardHtml 彻底掩码隐藏题原始 ID，默认关闭向后兼容', () => {
  const questions = [
    {
      id: '1-1', level: 1, title: '公开题 1-1', brief: '题面', needs: [],
      flags: { hidden: false, expectedFail: false, blockedBy: [] },
      calibration: { status: 'calibrated', source: '测试', noiseFloor: 0, version: 1 },
    },
    {
      id: '94-101', level: 4, title: '秘密整镜变体', brief: '秘密题面', needs: ['fx.breath'],
      flags: { hidden: true, expectedFail: false, blockedBy: [] },
      calibration: { status: 'calibrated', source: '秘密来源', noiseFloor: 0, version: 2, updatedAt: '2026-11-30' },
    },
    {
      id: '92-102', level: 2, title: '秘密二级变体', brief: '秘密题面', needs: [],
      flags: { hidden: true, expectedFail: true, blockedBy: ['秘密阻塞'] },
      calibration: { status: 'calibrated', source: '秘密来源', noiseFloor: 0, version: 1 },
    },
  ];
  const results = [
    { format: 'bench-result/0.1', questionId: '1-1', level: 1, source: 'three', model: 'm1', status: 'pass', pass: true, score: 1, visibility: 'public', unmeasured: 0 },
    { format: 'bench-result/0.1', questionId: '94-101', level: 4, source: 'three', model: 'm1', status: 'fail', pass: false, score: 0.16, visibility: 'hidden', unmeasured: 0 },
    { format: 'bench-result/0.1', questionId: '92-102', level: 2, source: 'three', model: 'm1', status: 'fail', pass: false, score: 0.5, visibility: 'hidden', unmeasured: 0 },
  ];

  // 默认模式：保持既有契约（raw ID 可见）
  const unmasked = buildBoard({ asOf: '2026-11-30', questions, results });
  assert.ok(unmasked.matrix.rows.some((r) => r.questionId === '94-101'));

  // 开启掩码模式：board.json、history、HTML 中均不得出现原始隐藏题 ID
  const masked = buildBoard({ asOf: '2026-11-30', questions, results, maskHiddenIds: true });
  const html = renderBoardHtml(masked);
  const serialized = JSON.stringify(masked) + html;
  assert.equal(serialized.includes('94-101'), false, '开启 maskHiddenIds 后不得出现原始隐藏题 ID 94-101');
  assert.equal(serialized.includes('92-102'), false, '开启 maskHiddenIds 后不得出现原始隐藏题 ID 92-102');
  assert.equal(serialized.includes('秘密整镜变体'), false);
  const hiddenRows = masked.matrix.rows.filter((r) => r.hidden);
  assert.equal(hiddenRows.length, 2);
  assert.deepEqual(hiddenRows.map((r) => r.questionId), ['hidden-L2-1', 'hidden-L4-1']);
  assert.deepEqual(hiddenRows.map((r) => r.title), ['隐藏题 #1', '隐藏题 #2']);
  assert.equal(masked.matrix.overallMean, unmasked.matrix.overallMean);
  // 防篡改：即便隐藏行 title 被外部改成私密文案，renderBoardHtml 也绝不渲染它
  const tampered = JSON.parse(JSON.stringify(masked));
  tampered.matrix.rows.find((r) => r.hidden).title = 'LEAK_SECRET_TITLE';
  assert.equal(renderBoardHtml(tampered).includes('LEAK_SECRET_TITLE'), false);
  assert.deepEqual(scanQuestionLeaks(masked), []);
  assert.deepEqual(scanQuestionLeaks(html), []);
});

test('runExamSuite({ maskHiddenIds: true }) 在落盘 board.json / history.json / index.html / suite-report.json 中全面掩码隐藏题 ID', async (t) => {
  const evalRoot = mkTempDir('beiming-m5-suite-eval-');
  const boardDir = mkTempDir('beiming-m5-suite-board-');
  const hiddenDir = mkTempDir('beiming-m5-suite-hidden-');
  t.after(() => {
    fs.rmSync(evalRoot, { recursive: true, force: true });
    fs.rmSync(boardDir, { recursive: true, force: true });
    fs.rmSync(hiddenDir, { recursive: true, force: true });
  });

  // 写入 3 道测试用隐藏题（满足 full-1 要求）
  const baseQ = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'questions/level-1/01-1.json'), 'utf8'));
  const secretIds = ['91-101', '92-102', '93-103'];
  for (const sid of secretIds) {
    const hq = { ...baseQ, id: sid, title: `私密变体 ${sid}`, flags: { hidden: true, expectedFail: false, blockedBy: [] } };
    fs.writeFileSync(path.join(hiddenDir, `${sid}.json`), JSON.stringify(hq, null, 2));
  }

  await runExamSuite({
    mode: 'full-1',
    asOf: '2026-11-30',
    evalRoot,
    boardDir,
    hiddenDir,
    models: ['mock/a', 'mock/b'],
    maskHiddenIds: true,
    solver: async () => ({ tokens: 1000, turns: 1, toolCalls: 1 }),
    judge: async () => ({ predicates: {}, metrics: {} }),
  });

  for (const name of ['board.json', 'history.json', 'index.html', 'suite-report.json']) {
    const text = fs.readFileSync(path.join(boardDir, name), 'utf8');
    for (const sid of secretIds) {
      assert.equal(text.includes(sid), false, `${name} 在 maskHiddenIds=true 时泄露了原始隐藏题 ID ${sid}`);
    }
    assert.deepEqual(scanQuestionLeaks(text), [], `${name} 泄露扫描应为空`);
  }
});

test('CLI 暴露 --deny-read-dir（runner）与 --mask-hidden-ids（board/suite）且参数校验 fail-fast 拒绝非布尔 maskHiddenIds', async (t) => {
  const runnerHelp = spawnSync(NODE, [path.join(BENCH_DIR, 'runner.mjs'), 'run', '--help'], { encoding: 'utf8' });
  assert.equal(runnerHelp.status, 0);
  assert.match(runnerHelp.stdout, /--deny-read-dir/);

  const boardHelp = spawnSync(NODE, [path.join(BENCH_DIR, 'board.mjs'), 'build', '--help'], { encoding: 'utf8' });
  assert.equal(boardHelp.status, 0);
  assert.match(boardHelp.stdout, /--mask-hidden-ids/);

  const suiteHelp = spawnSync(NODE, [path.join(BENCH_DIR, 'suite.mjs'), 'full-4', '--help'], { encoding: 'utf8' });
  assert.equal(suiteHelp.status, 0);
  assert.match(suiteHelp.stdout, /--mask-hidden-ids/);

  assert.throws(
    () => buildBoard({ asOf: '2026-11-30', maskHiddenIds: 'yes' }),
    (err) => err?.code === 'usage.bad-argument' && err?.exitCode === 2,
  );

  const evalRoot = mkTempDir('beiming-m5-ff-eval-');
  const boardDir = mkTempDir('beiming-m5-ff-board-');
  t.after(() => {
    fs.rmSync(evalRoot, { recursive: true, force: true });
    fs.rmSync(boardDir, { recursive: true, force: true });
  });
  let solverCalls = 0;
  await assert.rejects(
    () => runExamSuite({
      mode: 'mini',
      asOf: '2026-11-30',
      evalRoot,
      boardDir,
      models: ['mock/a'],
      maskHiddenIds: 1,
      solver: async () => { solverCalls += 1; return {}; },
    }),
    (err) => err?.code === 'usage.bad-argument' && err?.exitCode === 2,
  );
  assert.equal(solverCalls, 0, '非法 maskHiddenIds 必须在跑题前 fail-fast 拒收');
});
