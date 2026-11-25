// B11：成片墙（Daily Film Wall）、原话账本五步流程（Verbatim Rejection Ledger）与盲选页（Blind A/B Page）测试
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import * as bench from './index.mjs';
import { buildBoard } from './board.mjs';
import {
  AGREEMENT_DISABLE_THRESHOLD,
  BLIND_BALLOT_FORMAT,
  BLIND_KEY_FORMAT,
  BLIND_PUBLIC_FORMAT,
  BLIND_REPORT_FORMAT,
  DEFAULT_MAX_DAILY,
  LEDGER_FORMAT,
  MISSED_LAYERS,
  WALL_FORMAT,
  buildFilmWall,
  computeWeeklyRejectionStats,
  confirmRejectionTriage,
  createBlindSession,
  loadLedgerState,
  recordBlindBallot,
  recordLedgerRead,
  recordRejection,
  renderBlindPageHtml,
  renderFilmWallHtml,
  renderLedgerHtml,
  translateRejection,
  unblindBlindSession,
} from './wall.mjs';

const isBadArg = (err) => err?.code === 'usage.bad-argument' && err?.exitCode === 2 && (err instanceof TypeError || err instanceof RangeError);

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bm-b11-wall-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertNoExternalLinks(html) {
  assert.doesNotMatch(html, /\bhttps?:\/\//i, 'HTML 不得包含外网 http/https 链接');
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']\/\//i, 'HTML 不得包含协议相对外链');
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
}

/* ---------------- 导出与入口契约 ---------------- */

test('index.mjs 完整重导出 B11 三大页面与五步流程符号', () => {
  assert.equal(WALL_FORMAT, 'bench-wall/0.1');
  assert.equal(LEDGER_FORMAT, 'bench-rejection-ledger/0.1');
  assert.equal(BLIND_PUBLIC_FORMAT, 'bench-blind-public/0.1');
  assert.equal(BLIND_KEY_FORMAT, 'bench-blind-key/0.1');
  assert.equal(BLIND_BALLOT_FORMAT, 'bench-blind-ballot/0.1');
  assert.equal(BLIND_REPORT_FORMAT, 'bench-blind-report/0.1');
  assert.equal(DEFAULT_MAX_DAILY, 5);
  assert.equal(AGREEMENT_DISABLE_THRESHOLD, 0.6);
  assert.deepEqual(MISSED_LAYERS, ['L1', 'L2', 'L3', 'L4', 'L5']);

  for (const name of [
    'WALL_FORMAT',
    'LEDGER_FORMAT',
    'BLIND_PUBLIC_FORMAT',
    'BLIND_KEY_FORMAT',
    'BLIND_BALLOT_FORMAT',
    'BLIND_REPORT_FORMAT',
    'DEFAULT_MAX_DAILY',
    'AGREEMENT_DISABLE_THRESHOLD',
    'MISSED_LAYERS',
    'buildFilmWall',
    'renderFilmWallHtml',
    'recordRejection',
    'translateRejection',
    'confirmRejectionTriage',
    'recordLedgerRead',
    'computeWeeklyRejectionStats',
    'loadLedgerState',
    'renderLedgerHtml',
    'createBlindSession',
    'renderBlindPageHtml',
    'recordBlindBallot',
    'unblindBlindSession',
  ]) {
    assert.ok(Object.hasOwn(bench, name), `bench/index.mjs 缺少导出 ${name}`);
  }
});

/* ---------------- 1. 成片墙（Daily Film Wall） ---------------- */

test('成片墙：单页汇总当天成片、并排参考、四个核心指标、判不了的维度与过/打回交互区', () => {
  const board = buildBoard({
    asOf: '2026-11-23',
    results: [
      { format: 'bench-result/0.1', questionId: '1-1', level: 1, source: 'three', model: 'model-a', status: 'pass', pass: true, score: 1, visibility: 'public', unmeasured: 0 },
      { format: 'bench-result/0.1', questionId: '28-1', level: 1, source: 'three', model: 'model-a', status: 'fail', pass: false, score: 0.4, visibility: 'public', unmeasured: 0 },
    ],
    jobs: [
      { jobId: 'job-1', basePass: true, interventions: 0, filmDurationSec: 5 },
      { jobId: 'job-2', basePass: false, interventions: 1, filmDurationSec: 5 },
    ],
    ledger: [
      {
        jobId: 'job-1', attempt: 1, kind: 'delegate', status: 'succeeded', gpuKnown: true,
        wallMs: 20_000, gpuSeconds: 8,
        tokensByTier: { fable: 0, opus: 1000, sonnet: 500, haiku: 0, other: 0 }, totalTokens: 1500,
        renderedFrames: 120, deliveredFrames: 120, diskBytes: 4096,
      },
    ],
    pureFunctionGate: { passed: 4, total: 4 },
    locality: { passed: 2, total: 2 },
    rebuild: { exact: { passed: 3, total: 3 } },
  });

  const wall = buildFilmWall({
    date: '2026-11-23',
    scoreboard: board,
    unmeasurableDimensions: [
      { dimension: '镜头呼吸感', template: 'product-turntable', reason: '主观节奏尚无可靠物理标尺' },
      { dimension: '全片叙事张力', template: '*', reason: '跨镜头情绪依赖人眼裁判' },
      { dimension: '角色微表情', template: 'toon-character', reason: '仅角色片适用' },
    ],
    films: [
      {
        filmId: 'film-01',
        title: '硬表面转台 01',
        date: '2026-11-23',
        template: 'product-turntable',
        mediaUrl: 'films/film-01/deliver.mp4',
        reference: { mediaUrl: 'refs/01-ref.mp4', label: '案例 01 参考片' },
        ok: true,
        reviewStatus: 'pending',
      },
      {
        filmId: 'film-02',
        title: '分屏版式 02',
        date: '2026-11-23',
        template: 'split-layout',
        mediaUrl: '/artifacts/film-02/deliver.mp4',
        reference: { mediaUrl: '/media/29-ref.mp4', label: '案例 29 参考片' },
        ok: true,
        reviewStatus: 'approved',
      },
      {
        filmId: 'film-old',
        title: '昨日旧片',
        date: '2026-11-22',
        template: 'product-turntable',
        mediaUrl: 'films/film-old/deliver.mp4',
        reference: { mediaUrl: 'refs/old.mp4', label: '旧参考' },
        ok: true,
      },
    ],
  });

  assert.equal(wall.format, WALL_FORMAT);
  assert.equal(wall.date, '2026-11-23');
  assert.equal(wall.films.length, 2, '自动过滤非当天的成片');
  assert.deepEqual(wall.films.map((f) => f.filmId), ['film-01', 'film-02']);
  assert.deepEqual(wall.films[0].unmeasurableDimensions.map((d) => d.dimension), ['镜头呼吸感', '全片叙事张力']);
  assert.deepEqual(wall.films[1].unmeasurableDimensions.map((d) => d.dimension), ['全片叙事张力']);
  assert.equal(wall.fourIndicators.unattended.value, 0.5);
  assert.equal(wall.fourIndicators.speedAndCost.value, 4);
  assert.equal(wall.fourIndicators.controllability.value, 1);

  const html = renderFilmWallHtml(wall);
  assertNoExternalLinks(html);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /硬表面转台 01/);
  assert.match(html, /案例 01 参考片/);
  assert.match(html, /films\/film-01\/deliver\.mp4/);
  assert.match(html, /refs\/01-ref\.mp4/);
  assert.match(html, /画面上限/);
  assert.match(html, /无人值守成功率/);
  assert.match(html, /速度与成本/);
  assert.match(html, /可控与可复现/);
  assert.match(html, /镜头呼吸感/);
  assert.match(html, /一句话打回/);
  assert.match(html, />过</);
  assert.ok(!html.includes('昨日旧片'), '非当天成片不应渲染进页面');
});

test('成片墙：20 条成片抽样最多 5 条成功片 + 保留全部失败片，换种子结果可复现打乱，无看板数据时显式标暂无', () => {
  const films = Array.from({ length: 20 }, (_, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    const ok = ![3, 9, 17].includes(idx);
    return {
      filmId: `film-${num}`,
      template: 'hard-surface',
      mediaUrl: `films/film-${num}/deliver.mp4`,
      reference: { mediaUrl: `refs/ref-${num}.mp4`, label: `参考 ${num}` },
      ok,
    };
  });

  const w1 = buildFilmWall({ date: '2026-11-23', films, seed: 'd12-batch-a' });
  const w1Repeat = buildFilmWall({ date: '2026-11-23', films, seed: 'd12-batch-a' });
  const w2 = buildFilmWall({ date: '2026-11-23', films, seed: 'd12-batch-b' });

  assert.equal(w1.summary.failedCount, 3);
  assert.equal(w1.summary.sampledPassedCount, 5);
  assert.equal(w1.films.length, 8, '保留 3 条失败片 + 5 条抽样成功片');
  for (const failedId of ['film-04', 'film-10', 'film-18']) {
    assert.ok(w1.films.some((f) => f.filmId === failedId && f.ok === false), `失败片 ${failedId} 必须保留`);
  }
  assert.deepEqual(w1.films.map((f) => f.filmId), w1Repeat.films.map((f) => f.filmId), '同一种子抽样结果完全一致');
  assert.notDeepEqual(
    w1.films.filter((f) => f.ok).map((f) => f.filmId),
    w2.films.filter((f) => f.ok).map((f) => f.filmId),
    '更换种子应改变成功片抽样集合',
  );

  // 无看板数据时四个指标值为 null、展示为「暂无」
  for (const key of ['ceiling', 'unattended', 'speedAndCost', 'controllability']) {
    assert.equal(w1.fourIndicators[key].value, null);
    assert.equal(w1.fourIndicators[key].display, '暂无');
  }
  const html = renderFilmWallHtml(w1);
  assertNoExternalLinks(html);
  assert.match(html, /暂无/);
});

test('成片墙安全：拦截路径穿越、宿主绝对路径、外链和危险协议，并对所有不可信文本做严格 XSS 转义', () => {
  const unsafeUrls = [
    '../secret.mp4',
    'films/../../etc/passwd',
    'films/%2e%2e/secret.mp4',
    'films/%252e%252e/secret.mp4',
    'films/ok.mp4?redirect=//evil.example/x',
    'films/ok.mp4?file=../../etc/passwd',
    'films\\..\\secret.mp4',
    '/etc/passwd',
    '/tmp/out.mp4',
    '/Users/user/Desktop/out.mp4',
    'C:\\Windows\\System32\\clip.mp4',
    'https://evil.example/video.mp4',
    'http://evil.example/video.mp4',
    '//evil.example/video.mp4',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///tmp/out.mp4',
  ];

  for (const badUrl of unsafeUrls) {
    assert.throws(
      () => buildFilmWall({
        date: '2026-11-23',
        films: [{ filmId: 'f1', template: 't1', mediaUrl: badUrl, reference: { mediaUrl: 'refs/ok.mp4' } }],
      }),
      isBadArg,
      `成片路径未拦截危险地址: ${badUrl}`,
    );
    assert.throws(
      () => buildFilmWall({
        date: '2026-11-23',
        films: [{ filmId: 'f1', template: 't1', mediaUrl: 'films/f1/ok.mp4', reference: { mediaUrl: badUrl } }],
      }),
      isBadArg,
      `参考片路径未拦截危险地址: ${badUrl}`,
    );
  }

  const xssPayload = `</script><script>alert("xss")</script><img src=x onerror='alert(1)'>`;
  const wall = buildFilmWall({
    date: '2026-11-23',
    unmeasurableDimensions: [{ dimension: `节奏${xssPayload}`, template: 't1', reason: `原因${xssPayload}` }],
    films: [{
      filmId: 'f-xss',
      title: `标题${xssPayload}`,
      template: 't1',
      mediaUrl: 'films/f-xss/deliver.mp4',
      reference: { mediaUrl: 'refs/r-xss.png', label: `参考${xssPayload}` },
      reviewStatus: 'rejected',
      rejectionVerbatim: `原话${xssPayload}`,
    }],
  });
  const html = renderFilmWallHtml(wall);
  assertNoExternalLinks(html);
  assert.ok(!html.includes('<script>alert'), '不得出现未转义的 <script> 注入');
  assert.ok(!html.includes('<img src=x'), '不得出现未转义的 <img> 注入');
  assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
});

/* ---------------- 2. 原话账本与「一句话打回」五步流程 ---------------- */

test('原话账本：一条打回完整走完 1→5 步落盘读回，原话一字不改、正式校验候选谓词并产出自然周重复打回率', () => {
  withTmpDir((ledgerDir) => {
    const exactVerbatim = '  第 36 到 48 帧主角移出了画框右缘，而且金属反光像塑料 <script>alert(1)</script>！  ';

    // 第 1 步：原话一字不改入账
    const step1 = recordRejection(ledgerDir, {
      filmId: 'film-101',
      template: 'product-turntable',
      frames: [36, 48],
      verbatim: exactVerbatim,
      category: 'framing.hero-out-of-bounds',
      author: 'human-director',
      at: '2026-11-23T10:00:00Z',
    });
    assert.equal(step1.id, 'rej-0001');
    assert.equal(step1.step, 1);
    assert.equal(step1.verbatim, exactVerbatim, '原话必须一字不改保存（含首尾空格与特殊符号）');
    assert.deepEqual(step1.frames, [36, 48]);
    assert.ok(existsSync(join(ledgerDir, 'events.jsonl')));

    // 第 2 步：审片代理翻译成候选谓词并标明本该拦住它的验证层
    const step2 = translateRejection(ledgerDir, step1.id, {
      candidatePredicate: 'inside_frame(hero, margin=0.05) @ [36,49)',
      missedLayer: 'L3',
      rationale: '原本只查了中心点在画内，没留 5% 边距',
      reviewer: 'reviewer-agent',
      at: '2026-11-23T10:05:00Z',
    });
    assert.equal(step2.step, 2);
    assert.equal(step2.translation.missedLayer, 'L3');
    assert.equal(step2.translation.candidateValid, true);

    // 第 3 步（分支 A）：出题代理核验正式谓词语法与登记表后加入片型模板增补表
    const step3 = confirmRejectionTriage(ledgerDir, step1.id, {
      decision: 'add-predicate',
      predicate: 'inside_frame(hero, margin=0.05) @ [0,120)',
      reason: '转台片全程要求主角留 5% 画幅安全边距',
      curator: 'exam-curator',
      at: '2026-11-23T10:12:00Z',
    });
    assert.equal(step3.step, 3);
    assert.equal(step3.triage.decision, 'add-predicate');
    assert.equal(step3.triage.predicate, 'inside_frame(hero, margin=0.05) @ [0,120)');

    // 补充另一条「判不了的维度」走完 1→3 步，验证双分支都能被第 4 步读到
    const aesthetic1 = recordRejection(ledgerDir, {
      filmId: 'film-101',
      template: 'product-turntable',
      frames: [90, 119],
      verbatim: '收尾定格的气口太急，少了半拍余韵',
      category: 'pacing.ending-breath',
      at: '2026-11-24T11:00:00Z',
    });
    translateRejection(ledgerDir, aesthetic1.id, {
      candidatePredicate: 'no_cut @ [90,120)',
      missedLayer: 'L5',
      rationale: '客观无切点但主观气口节奏目前无法靠公式判分',
      at: '2026-11-24T11:05:00Z',
    });
    confirmRejectionTriage(ledgerDir, aesthetic1.id, {
      decision: 'unmeasurable-dimension',
      dimension: '收尾定格气口余韵',
      reason: '交成片墙由人类导演直接把关',
      curator: 'exam-curator',
      at: '2026-11-24T11:10:00Z',
    });

    // 同自然周内同类问题第 2 次出现（用于核验第 5 步重复打回率）+ 下周一条（不计入本周）
    recordRejection(ledgerDir, {
      filmId: 'film-102',
      template: 'product-turntable',
      frames: [40, 44],
      verbatim: '主角右耳朵还是蹭到了画框边！',
      category: 'framing.hero-out-of-bounds',
      at: '2026-11-26T09:30:00Z',
    });
    recordRejection(ledgerDir, {
      filmId: 'film-201',
      template: 'hard-surface',
      frames: [0, 10],
      verbatim: '下周另一部片的问题',
      category: 'lighting.shadow',
      at: '2026-11-30T09:00:00Z',
    });

    // 第 4 步：下一部同类型片开工前读取账本并落盘读取记录
    const readRes = recordLedgerRead(ledgerDir, {
      filmId: 'film-103',
      template: 'product-turntable',
      reader: 'production-agent',
      at: '2026-11-27T08:00:00Z',
    });
    assert.deepEqual(readRes.readRecord.entryIds, ['rej-0001', 'rej-0002', 'rej-0003']);
    assert.equal(readRes.predicateAdditions.length, 1);
    assert.equal(readRes.predicateAdditions[0].predicate, 'inside_frame(hero, margin=0.05) @ [0,120)');
    assert.equal(readRes.unmeasurableDimensions.length, 1);
    assert.equal(readRes.unmeasurableDimensions[0].dimension, '收尾定格气口余韵');

    // 第 5 步：计算自然周（2026-11-23 周一至 2026-11-29 周日）重复打回统计并落盘
    const weekly = computeWeeklyRejectionStats(ledgerDir, { weekOf: '2026-11-25' });
    assert.equal(weekly.weekStart, '2026-11-23');
    assert.equal(weekly.weekEnd, '2026-11-29');
    assert.equal(weekly.totalRejections, 3);
    assert.equal(weekly.uniqueCategories, 2);
    assert.equal(weekly.repeatedRejections, 1);
    assert.equal(weekly.repeatedCategoryCount, 1);
    assert.ok(Math.abs(weekly.repeatRate - 1 / 3) < 1e-12);
    assert.equal(weekly.byCategory[0].category, 'framing.hero-out-of-bounds');
    assert.equal(weekly.byCategory[0].count, 2);
    assert.equal(weekly.byCategory[0].repeatedCount, 1);

    // 重复执行第 5 步幂等，不重复累加
    const weeklyAgain = computeWeeklyRejectionStats(ledgerDir, { weekOf: '2026-11-29' });
    assert.equal(weeklyAgain.totalRejections, 3);
    assert.equal(weeklyAgain.repeatedRejections, 1);

    // 从磁盘全新加载状态：rej-0001 已完整走完第 5 步，原话一字未改
    const reloaded = loadLedgerState(ledgerDir);
    assert.equal(reloaded.format, LEDGER_FORMAT);
    const first = reloaded.entries.find((e) => e.id === 'rej-0001');
    assert.equal(first.step, 5);
    assert.equal(first.verbatim, exactVerbatim);
    assert.deepEqual(first.readByFilmIds, ['film-103']);
    assert.equal(reloaded.readRecords.length, 1);
    assert.equal(reloaded.weeklyStats.length, 1);

    const ledgerHtml = renderLedgerHtml(reloaded);
    assertNoExternalLinks(ledgerHtml);
    assert.ok(!ledgerHtml.includes('<script>alert(1)</script>'), '账本 HTML 必须转义原话中的脚本标签');
    assert.match(ledgerHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(ledgerHtml, /inside_frame\(hero, margin=0\.05\) @ \[0,120\)/);
    assert.match(ledgerHtml, /收尾定格气口余韵/);
    assert.match(ledgerHtml, /film-103/);
    assert.match(ledgerHtml, /33\.3%/);
  });
});

test('原话账本门禁：拒绝空原话、非法帧区间、非法验证层、跳步及未登记/语法错误的候选谓词', () => {
  withTmpDir((ledgerDir) => {
    for (const badInput of [
      { filmId: 'f1', template: 't1', frames: [0, 10], verbatim: '', at: '2026-11-23T10:00:00Z' },
      { filmId: 'f1', template: 't1', frames: [0, 10], verbatim: '   \n\t ', at: '2026-11-23T10:00:00Z' },
      { filmId: 'f1', template: 't1', frames: [-1, 10], verbatim: '原话', at: '2026-11-23T10:00:00Z' },
      { filmId: 'f1', template: 't1', frames: [20, 10], verbatim: '原话', at: '2026-11-23T10:00:00Z' },
      { filmId: 'f1', template: 't1', frames: [1.5, 10], verbatim: '原话', at: '2026-11-23T10:00:00Z' },
      { filmId: 'f1', template: 't1', frames: [10], verbatim: '原话', at: '2026-11-23T10:00:00Z' },
      { filmId: 'f1', template: 't1', frames: [0, 10], verbatim: '原话', at: 'not-a-date' },
    ]) {
      assert.throws(() => recordRejection(ledgerDir, badInput), isBadArg);
    }

    const e1 = recordRejection(ledgerDir, {
      filmId: 'f1', template: 't1', frames: [0, 10], verbatim: '第 0 帧黑屏', at: '2026-11-23T10:00:00Z',
    });

    // 不能跳过第 2 步直接确认第 3 步
    assert.throws(() => confirmRejectionTriage(ledgerDir, e1.id, {
      decision: 'add-predicate', predicate: 'no_cut', at: '2026-11-23T10:05:00Z',
    }), isBadArg);

    // missedLayer 仅限 L1..L5，且时间不得倒退
    assert.throws(() => translateRejection(ledgerDir, e1.id, {
      candidatePredicate: 'no_cut', missedLayer: 'L6', at: '2026-11-23T10:05:00Z',
    }), isBadArg);
    assert.throws(() => translateRejection(ledgerDir, e1.id, {
      candidatePredicate: 'no_cut', missedLayer: 'L2', at: '2026-11-23T09:59:00Z',
    }), isBadArg);

    translateRejection(ledgerDir, e1.id, {
      candidatePredicate: 'unregistered_magic(hero)', missedLayer: 'L2', at: '2026-11-23T10:05:00Z',
    });

    // 第 3 步选 add-predicate 时，非法语法、未登记谓词、分号多断言、planned 未实装谓词一律硬拒且不入模板表
    for (const illegalPred of [
      'unregistered_magic(hero)',
      'inside_frame(',
      'visible()',
      'no_cut ; visible(hero)',
      'key_fill_ratio(hero) <= 2',
      '',
    ]) {
      assert.throws(() => confirmRejectionTriage(ledgerDir, e1.id, {
        decision: 'add-predicate', predicate: illegalPred, at: '2026-11-23T10:10:00Z',
      }), isBadArg, `未拦截非法谓词: ${illegalPred}`);
    }

    const stateAfterReject = loadLedgerState(ledgerDir);
    assert.equal(stateAfterReject.predicateAdditions.length, 0, '被拒的候选谓词不得写入模板增补表');
    assert.equal(stateAfterReject.entries[0].step, 2, '被拒后条目仍停在第 2 步');
  });
});

/* ---------------- 3. 盲选页（Blind A/B Page） ---------------- */

function buildTenPairs(reviewerPattern = () => 'beiming-three') {
  return Array.from({ length: 10 }, (_, idx) => {
    const n = String(idx + 1).padStart(2, '0');
    return {
      id: `cycles-vs-beiming-${n}`,
      kind: idx % 3 === 0 ? 'clip' : 'still',
      candidateA: {
        source: 'beiming-three',
        label: `北冥渲染样本 ${n}`,
        mediaUrl: idx % 3 === 0 ? `blind/sample-${n}-x.mp4` : `blind/sample-${n}-x.png`,
      },
      candidateB: {
        source: 'blender-cycles',
        label: `Cycles 标准参考 ${n}`,
        mediaUrl: idx % 3 === 0 ? `blind/sample-${n}-y.mp4` : `blind/sample-${n}-y.png`,
      },
      reviewerChoice: reviewerPattern(idx),
    };
  });
}

test('盲选页：10 组确定性左右随机、零来源与答案泄露、前置判定线校验、揭盲对接看板与 <0.6 停用审片视角', () => {
  withTmpDir((ballotDir) => {
    // 审片模型只在前 4 组与人类一致（4/10 = 0.4 < 0.6 -> 触发停用视角）
    const pairs = buildTenPairs((idx) => (idx < 4 ? 'beiming-three' : 'blender-cycles'));
    const decisionLine = {
      targetSource: 'beiming-three',
      minTargetWinsOrTies: 5,
      totalPairs: 10,
      committedAt: '2026-11-23T08:00:00Z',
      note: 'U7 同等画面盲选：10 组赢或平不少于 5 组算过',
    };

    const s1 = createBlindSession({
      sessionId: 'blind-u7-01',
      purpose: 'u7-equivalence',
      pairs,
      decisionLine,
      createdAt: '2026-11-23T08:30:00Z',
      seed: 'blind-seed-alpha',
    });
    const s1Repeat = createBlindSession({
      sessionId: 'blind-u7-01',
      purpose: 'u7-equivalence',
      pairs,
      decisionLine,
      createdAt: '2026-11-23T08:30:00Z',
      seed: 'blind-seed-alpha',
    });
    const s2 = createBlindSession({
      sessionId: 'blind-u7-01',
      purpose: 'u7-equivalence',
      pairs,
      decisionLine,
      createdAt: '2026-11-23T08:30:00Z',
      seed: 'blind-seed-beta',
    });

    assert.equal(s1.publicSession.format, BLIND_PUBLIC_FORMAT);
    assert.equal(s1.answerKey.format, BLIND_KEY_FORMAT);
    assert.equal(s1.publicSession.pairs.length, 10);

    // 验证 10 组左右随机：不全在同一侧，同种子完全一致，换种子打乱
    const targetSides1 = s1.answerKey.pairs.map((p) => (p.leftSource === 'beiming-three' ? 'left' : 'right'));
    const targetSidesRepeat = s1Repeat.answerKey.pairs.map((p) => (p.leftSource === 'beiming-three' ? 'left' : 'right'));
    const targetSides2 = s2.answerKey.pairs.map((p) => (p.leftSource === 'beiming-three' ? 'left' : 'right'));
    assert.deepEqual(targetSides1, targetSidesRepeat);
    assert.ok(targetSides1.includes('left') && targetSides1.includes('right'), '10 组不应全部落在同一侧');
    assert.notDeepEqual(targetSides1, targetSides2, '更换种子应打乱左右分配');

    // 严格零泄露：publicSession JSON 与盲选页 HTML 中均不得出现任何来源标识、原始含来源 id 或答案字段
    const publicJson = JSON.stringify(s1.publicSession);
    const blindHtml = renderBlindPageHtml(s1.publicSession);
    assertNoExternalLinks(blindHtml);

    for (const forbidden of [
      'beiming',
      'cycles',
      'blender',
      '北冥渲染样本',
      '标准参考',
      'candidateA',
      'candidateB',
      'answerKey',
      'leftSource',
      'rightSource',
      'targetSource',
      'reviewerChoice',
    ]) {
      assert.ok(!publicJson.toLowerCase().includes(forbidden.toLowerCase()), `publicSession 泄露了敏感词: ${forbidden}`);
      assert.ok(!blindHtml.toLowerCase().includes(forbidden.toLowerCase()), `盲选 HTML 泄露了敏感词: ${forbidden}`);
    }
    assert.match(blindHtml, /pair-01-L/);
    assert.match(blindHtml, /pair-10-R/);
    assert.match(blindHtml, /分不出/);

    // 人类投票：前 4 组投给 beiming-three 所在侧，第 5、6 组选 tie，后 4 组投给对手侧（但审片模型在 4..9 选了 blender-cycles，若我们让后 6 组人类选 tie 或 beiming，一致率 = 4/10）
    // 精确构造人类选择：idx 0..3 选 beiming 侧（与审片一致，4 组）；idx 4..5 选 tie（审片选 cycles，不一致）；idx 6..9 选 beiming 侧？不对，那样 targetWins=8。
    // 构造 targetWins=4, ties=2, opponentWins=4（赢或平 = 6 >= 5 通过 U7）：
    //   idx 0..3: 人类选 beiming（审片也选 beiming -> 4 组一致）
    //   idx 4..5: 人类选 tie（审片选 cycles -> 2 组不一致）
    //   idx 6..9: 人类选 cycles 侧，让审片在 idx 6..9 选 beiming 侧，这样一致数正好 4/10 = 0.4！
    const calibratedPairs = buildTenPairs((idx) => (idx < 4 ? 'beiming-three' : idx < 6 ? 'blender-cycles' : 'beiming-three'));
    const session = createBlindSession({
      sessionId: 'blind-u7-02',
      purpose: 'u7-equivalence',
      pairs: calibratedPairs,
      decisionLine,
      createdAt: '2026-11-23T08:30:00Z',
      seed: 'blind-seed-alpha',
    });

    const votes = {};
    session.answerKey.pairs.forEach((kp, idx) => {
      const beimingSide = kp.leftSource === 'beiming-three' ? 'left' : 'right';
      const cyclesSide = beimingSide === 'left' ? 'right' : 'left';
      votes[kp.pairId] = idx < 4 ? beimingSide : idx < 6 ? 'tie' : cyclesSide;
    });

    // 投票时间早于判定线 committedAt 必须硬拒
    assert.throws(() => recordBlindBallot(ballotDir, session.publicSession, {
      voter: 'director',
      votes,
      submittedAt: '2026-11-23T07:59:59Z',
    }), isBadArg);

    const ballot = recordBlindBallot(ballotDir, session.publicSession, {
      voter: 'director',
      votes,
      submittedAt: '2026-11-23T09:00:00Z',
    });
    assert.equal(ballot.format, BLIND_BALLOT_FORMAT);
    assert.ok(existsSync(join(ballotDir, 'ballots.jsonl')));
    const persistedBallot = JSON.parse(readFileSync(join(ballotDir, 'ballots.jsonl'), 'utf8').trim());
    assert.equal(persistedBallot.voter, 'director');

    const report = unblindBlindSession(session.publicSession, session.answerKey, persistedBallot);
    assert.equal(report.format, BLIND_REPORT_FORMAT);
    assert.equal(report.totalPairs, 10);
    assert.equal(report.targetWins, 4);
    assert.equal(report.ties, 2);
    assert.equal(report.opponentWins, 4);
    assert.equal(report.targetWinsOrTies, 6);
    assert.equal(report.passed, true, '6 >= 5 通过 U7 同等画面判定线');
    assert.ok(Math.abs(report.agreementRate - 0.4) < 1e-12);
    assert.equal(report.disablePerspective, true, '一致率 0.4 < 0.6 必须标记停用该审片视角');
    assert.equal(report.reviewerAgreement.disablePerspective, true);

    // 直接对接 board.mjs 看板 blindPicks 指标
    const board = buildBoard({
      asOf: '2026-11-23',
      blindPicks: report.boardBlindPicks.map(({ outcome }) => ({ outcome })),
    });
    assert.deepEqual(board.fourIndicators.ceiling.blindPick, {
      wins: 4,
      ties: 2,
      losses: 4,
      winsOrTies: 6,
      total: 10,
      rate: 0.6,
    });
  });
});

test('盲选页扩展与边界：30 组核心接管套件、一致率 >= 0.6 保留视角、拦截缺判定线与含来源路径泄露', () => {
  const thirtyPairs = Array.from({ length: 30 }, (_, idx) => {
    const n = String(idx + 1).padStart(2, '0');
    return {
      id: `p-${n}`,
      kind: 'still',
      candidateA: { source: 'core-pt', mediaUrl: `blind/takeover-${n}-1.png` },
      candidateB: { source: 'cycles-ref', mediaUrl: `blind/takeover-${n}-2.png` },
      reviewerChoice: idx < 21 ? 'core-pt' : 'tie',
    };
  });

  const { publicSession, answerKey } = createBlindSession({
    sessionId: 'blind-30-takeover',
    purpose: 'core-takeover',
    pairs: thirtyPairs,
    decisionLine: {
      targetSource: 'core-pt',
      minCandidateWinsOrTies: 18,
      totalPairs: 30,
      alpha: 0.05,
      beta: 0.1,
      committedAt: '2026-11-23T08:00:00Z',
    },
    createdAt: '2026-11-23T08:10:00Z',
    seed: 20261123,
  });
  assert.equal(publicSession.pairs.length, 30);

  // 人类全部投给对手侧（0 胜 0 平 < 18 -> 不过门），但让另一张选票验证一致率 >= 0.6 时不触发停用
  const store = [];
  const votesPassAgreement = {};
  answerKey.pairs.forEach((kp, idx) => {
    const coreSide = kp.leftSource === 'core-pt' ? 'left' : 'right';
    const refSide = coreSide === 'left' ? 'right' : 'left';
    // idx 0..20 人类投 coreSide（与审片一致，21/30 = 0.7 >= 0.6），但总计只让前 12 组选 coreSide、9 组选对手、后 9 组选 tie（9 组与审片 tie 一致 -> 21/30 = 0.7，而 core 赢或平 = 21 >= 18；再测一组不过门的）
    votesPassAgreement[kp.pairId] = idx < 12 ? coreSide : idx < 21 ? refSide : 'tie';
  });
  // 一致数：idx 0..11 (12) + idx 21..29 (9) = 21 / 30 = 0.7 >= 0.6；赢或平 = 12 + 9 = 21 >= 18
  const ballot1 = recordBlindBallot(store, publicSession, {
    voter: 'human-1',
    votes: votesPassAgreement,
    submittedAt: '2026-11-23T09:00:00Z',
  });
  const rep1 = unblindBlindSession(publicSession, answerKey, ballot1);
  assert.equal(rep1.passed, true);
  assert.ok(Math.abs(rep1.agreementRate - 0.7) < 1e-12);
  assert.equal(rep1.disablePerspective, false, '一致率 0.7 >= 0.6 不停用审片视角');

  // 明知能认出的负样本（全部投给 cycles-ref -> 0 < 18 判不过）
  const votesAllRef = Object.fromEntries(
    answerKey.pairs.map((kp) => [kp.pairId, kp.leftSource === 'cycles-ref' ? 'left' : 'right']),
  );
  const ballot2 = recordBlindBallot(store, publicSession, {
    voter: 'human-2',
    votes: votesAllRef,
    submittedAt: '2026-11-23T09:05:00Z',
  });
  const rep2 = unblindBlindSession(publicSession, answerKey, ballot2);
  assert.equal(rep2.targetWinsOrTies, 0);
  assert.equal(rep2.passed, false);

  // 缺判定线、判定线晚于会话创建、媒体路径含来源名、非法投票选项一律拒绝
  assert.throws(() => createBlindSession({
    sessionId: 'bad-no-line',
    pairs: thirtyPairs.slice(0, 2),
    createdAt: '2026-11-23T08:10:00Z',
    seed: 's',
  }), isBadArg);

  assert.throws(() => createBlindSession({
    sessionId: 'bad-late-line',
    pairs: thirtyPairs.slice(0, 2),
    decisionLine: { targetSource: 'core-pt', minWinsOrTies: 1, committedAt: '2026-11-23T09:00:00Z' },
    createdAt: '2026-11-23T08:10:00Z',
    seed: 's',
  }), isBadArg);

  assert.throws(() => createBlindSession({
    sessionId: 'bad-leak-url',
    pairs: [{
      id: 'p1',
      kind: 'still',
      candidateA: { source: 'beiming', mediaUrl: 'blind/beiming_shot01.png' },
      candidateB: { source: 'cycles', mediaUrl: 'blind/anon_shot01.png' },
    }],
    decisionLine: { targetSource: 'beiming', minWinsOrTies: 1, committedAt: '2026-11-23T08:00:00Z' },
    createdAt: '2026-11-23T08:10:00Z',
    seed: 's',
  }), isBadArg, '媒体路径含来源名必须拦截，防止 DevTools 看路径识破盲选');

  assert.throws(() => recordBlindBallot([], publicSession, {
    voter: 'human',
    votes: { ...votesAllRef, 'pair-01': 'both' },
    submittedAt: '2026-11-23T09:00:00Z',
  }), isBadArg);

  // 全角混淆来源名与手工篡改混入答案键的公开会话一律被拦截
  assert.throws(() => createBlindSession({
    sessionId: 'bad-fullwidth-leak',
    pairs: [{
      id: 'p1',
      kind: 'still',
      candidateA: { source: 'src-a', mediaUrl: 'blind/ｂｅｉｍｉｎｇ-01.png' },
      candidateB: { source: 'src-b', mediaUrl: 'blind/anon-02.png' },
    }],
    decisionLine: { targetSource: 'src-a', minWinsOrTies: 1, committedAt: '2026-11-23T08:00:00Z' },
    createdAt: '2026-11-23T08:10:00Z',
    seed: 's',
  }), isBadArg);

  assert.throws(() => renderBlindPageHtml({
    ...publicSession,
    answerKey: { leaked: true },
  }), isBadArg);

  assert.throws(() => renderBlindPageHtml({
    ...publicSession,
    decisionLine: { ...publicSession.decisionLine, targetSource: 'core-pt' },
  }), isBadArg);

  // 多审片视角（reviewerPerspectives）与精确 0.6 边界：0.6 保留、0.5 停用
  const tenForPerspectives = Array.from({ length: 10 }, (_, idx) => {
    const n = String(idx + 1).padStart(2, '0');
    return {
      id: `mp-${n}`,
      kind: 'still',
      candidateA: { source: 'alpha-src', mediaUrl: `blind/mp-${n}-1.png` },
      candidateB: { source: 'beta-src', mediaUrl: `blind/mp-${n}-2.png` },
      reviewerChoice: idx < 6 ? 'alpha-src' : 'beta-src',
      reviewerPerspectives: {
        lighting: idx < 6 ? 'alpha-src' : 'beta-src', // 6/10 = 0.6 -> 保留
        motion: idx < 5 ? 'alpha-src' : 'beta-src',   // 5/10 = 0.5 < 0.6 -> 停用
      },
    };
  });
  const mpSession = createBlindSession({
    sessionId: 'blind-perspectives',
    pairs: tenForPerspectives,
    decisionLine: { targetSource: 'alpha-src', minWinsOrTies: 5, committedAt: '2026-11-23T08:00:00Z' },
    createdAt: '2026-11-23T08:05:00Z',
    seed: 'mp-seed',
  });
  const allAlphaVotes = Object.fromEntries(
    mpSession.answerKey.pairs.map((kp) => [kp.pairId, kp.leftSource === 'alpha-src' ? 'left' : 'right']),
  );
  const mpBallot = recordBlindBallot([], mpSession.publicSession, {
    voter: 'director',
    votes: allAlphaVotes,
    submittedAt: '2026-11-23T08:10:00Z',
  });
  const mpReport = unblindBlindSession(mpSession.publicSession, mpSession.answerKey, mpBallot);
  assert.equal(mpReport.agreementRate, 0.6);
  assert.equal(mpReport.disablePerspective, false, '恰等于 0.6 不停用');
  assert.equal(mpReport.reviewerAgreement.byPerspective.lighting.agreementRate, 0.6);
  assert.equal(mpReport.reviewerAgreement.byPerspective.lighting.disablePerspective, false);
  assert.equal(mpReport.reviewerAgreement.byPerspective.motion.agreementRate, 0.5);
  assert.equal(mpReport.reviewerAgreement.byPerspective.motion.disablePerspective, true);
});

/* ---------------- G_REV-R1 回归测试（B3–B7 / U1–U2 / W3–W4） ---------------- */

test('W3 媒体 URL 拒绝查询参数与 hash 中的父目录 .. 段（含百分号编码与全角点），正常查询参数放行', () => {
  const baseFilm = {
    filmId: 'w3-film',
    template: 'turntable',
    mediaUrl: 'media/sample.png',
    reference: { mediaUrl: 'refs/ref.png' },
  };
  const badQueryUrls = [
    'media/sample.png?file=../sample.png',
    'media/sample.png?file=..',
    'media/sample.png?a=1&file=../sample.png',
    'media/sample.png?file=sub/../sample.png',
    'media/sample.png?file=%2e%2e%2fsample.png',
    'media/sample.png?file=%2e%2e%5csample.png',
    'media/sample.png?%2e%2e=1',
    'media/sample.png#../sample.png',
    'media/sample.png#file=../sample.png',
    'media/sample.png?file=．．/sample.png',
  ];
  const wall = buildFilmWall({ date: '2026-11-23', films: [baseFilm] });
  const blindBase = createBlindSession({
    sessionId: 'w3-blind',
    createdAt: '2026-11-23T08:00:00Z',
    decisionLine: { targetSource: 'src-a', minWinsOrTies: 1, committedAt: '2026-11-23T07:00:00Z' },
    pairs: [{ candidateA: { source: 'src-a', mediaUrl: 'media/a.png' }, candidateB: { source: 'src-b', mediaUrl: 'media/b.png' } }],
    seed: 'w3-seed',
  });
  for (const badUrl of badQueryUrls) {
    assert.throws(() => buildFilmWall({ date: '2026-11-23', films: [{ ...baseFilm, mediaUrl: badUrl }] }), isBadArg, `buildFilmWall 未拦截 ${badUrl}`);
    assert.throws(() => renderFilmWallHtml({ ...wall, films: [{ ...wall.films[0], mediaUrl: badUrl }] }), isBadArg, `renderFilmWallHtml 未拦截 ${badUrl}`);
    assert.throws(() => createBlindSession({
      sessionId: 'w3-blind-bad',
      createdAt: '2026-11-23T08:00:00Z',
      decisionLine: { targetSource: 'src-a', minWinsOrTies: 1, committedAt: '2026-11-23T07:00:00Z' },
      pairs: [{ candidateA: { source: 'src-a', mediaUrl: badUrl }, candidateB: { source: 'src-b', mediaUrl: 'media/b.png' } }],
      seed: 'w3-seed',
    }), isBadArg, `createBlindSession 未拦截 ${badUrl}`);
    const mutated = structuredClone(blindBase.publicSession);
    mutated.pairs[0].left.mediaUrl = badUrl;
    assert.throws(() => renderBlindPageHtml(mutated), isBadArg, `renderBlindPageHtml 未拦截 ${badUrl}`);
  }
  // 合法查询串与版本号小数点应放行
  assert.doesNotThrow(() => buildFilmWall({
    date: '2026-11-23',
    films: [{ ...baseFilm, mediaUrl: 'media/sample.png?v=1.2.3&frame=0#t=0.5' }],
  }));
});

test('W4 成片墙准确提取正式 buildBoard 的 energyRulers 与 rebuild.tolerance 读数并展示', () => {
  const board = buildBoard({
    asOf: '2026-11-23',
    energy: [{ metric: 'noise.residual', value: 0.125 }],
    rebuild: { tolerance: { passed: 3, total: 4 } },
  });
  const wall = buildFilmWall({
    date: '2026-11-23',
    films: [{ filmId: 'w4-1', template: 'turntable', mediaUrl: 'films/w4.png' }],
    scoreboard: board,
  });
  assert.notEqual(wall.fourIndicators.ceiling.display, '暂无');
  assert.match(wall.fourIndicators.ceiling.display, /0\.125/);
  assert.equal(wall.fourIndicators.ceiling.value, 0.125);
  assert.notEqual(wall.fourIndicators.controllability.display, '暂无');
  assert.match(wall.fourIndicators.controllability.display, /75\.0%|3\/4/);
  assert.equal(wall.fourIndicators.controllability.value, 0.75);

  const html = renderFilmWallHtml(wall);
  assert.match(html, /0\.125/);
  assert.match(html, /75\.0%/);

  // 空 energy 与未跑 rebuild 仍保持 null / 暂无
  const emptyBoard = buildBoard({ asOf: '2026-11-23', energy: [] });
  const emptyWall = buildFilmWall({
    date: '2026-11-23',
    films: [{ filmId: 'w4-2', template: 'turntable', mediaUrl: 'films/w4.png' }],
    scoreboard: emptyBoard,
  });
  assert.equal(emptyWall.fourIndicators.ceiling.value, null);
  assert.equal(emptyWall.fourIndicators.ceiling.display, '暂无');
  assert.equal(emptyWall.fourIndicators.controllability.value, null);
  assert.equal(emptyWall.fourIndicators.controllability.display, '暂无');
});

test('U1 成片墙页面打回脚本导出的回执自带 ISO-8601 at，可直接原样入原话账本', () => {
  const wall = buildFilmWall({
    date: '2026-11-23',
    films: [{ filmId: 'cut-0', template: 'turntable', mediaUrl: 'films/cut-0.png' }],
  });
  const html = renderFilmWallHtml(wall);
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, '成片墙应包含内联脚本');

  let clickHandler = null;
  const statusEl = { textContent: '待看' };
  const outBox = { textContent: '{}' };
  const exactText = `  画幅 & 反光 '<script>样例</script>"  `;
  const fields = {
    '[name="frameStart"]': { value: '3' },
    '[name="frameEnd"]': { value: '7' },
    '[name="category"]': { value: '' },
    '[name="verbatim"]': { value: exactText },
    '[data-role="status-label"]': statusEl,
  };
  const card = {
    getAttribute: (k) => (k === 'data-film-id' ? 'cut-0' : k === 'data-film-template' ? 'turntable' : null),
    querySelector: (sel) => fields[sel] ?? null,
  };
  const rejectBtn = {
    getAttribute: (k) => (k === 'data-wall-action' ? 'reject' : null),
    closest: (sel) => (sel === 'button[data-wall-action]' ? rejectBtn : sel === '[data-film-id]' ? card : null),
  };
  const sandbox = {
    window: {},
    document: {
      addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; },
      getElementById: (id) => (id === 'wall-decisions-json' ? outBox : null),
    },
    Date,
  };
  vm.runInNewContext(scriptMatch[1], sandbox);
  assert.equal(typeof clickHandler, 'function');
  clickHandler({ target: rejectBtn });

  const receipt = JSON.parse(outBox.textContent)['cut-0'];
  assert.equal(receipt.filmId, 'cut-0');
  assert.equal(receipt.template, 'turntable');
  assert.deepEqual(receipt.frames, [3, 7]);
  assert.equal(receipt.verbatim, exactText);
  assert.equal(typeof receipt.at, 'string');
  assert.match(receipt.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  withTmpDir((ledgerDir) => {
    const entry = recordRejection(ledgerDir, receipt);
    assert.equal(entry.filmId, 'cut-0');
    assert.equal(entry.verbatim, exactText);
    assert.equal(entry.at, receipt.at);
  });
});

test('B3 盲选页标题与正文完全中性（即使候选来源名就是「北冥」，公开 JSON 与 HTML 均零命中）', () => {
  const pairs = Array.from({ length: 10 }, (_, i) => ({
    id: `p-${i}`,
    kind: 'still',
    candidateA: { source: '北冥', mediaUrl: `media/a-${i}.png` },
    candidateB: { source: '松柏组', mediaUrl: `media/b-${i}.png` },
  }));
  const { publicSession } = createBlindSession({
    sessionId: 'nov-23',
    createdAt: '2026-11-23T08:00:00Z',
    decisionLine: { targetSource: '北冥', minWinsOrTies: 7, committedAt: '2026-11-23T07:00:00Z' },
    pairs,
    seed: 'b3-seed',
  });
  assert.ok(!JSON.stringify(publicSession).includes('北冥'));
  const html = renderBlindPageHtml(publicSession);
  assert.ok(!html.includes('北冥'), '盲选 HTML 不得包含「北冥」');
  assert.match(html, /<title>盲选页 nov-23<\/title>/);
  assert.match(html, /<h1>双盲对比页<\/h1>/);
});

test('B4 拦截 URL 编码的来源名通过 mediaUrl 泄入盲选公开面，并容错合法 note 中的裸 %', () => {
  const target = '银杏组';
  const baseOpts = {
    sessionId: 'b4-session',
    createdAt: '2026-11-23T08:00:00Z',
    decisionLine: { targetSource: target, minWinsOrTies: 1, committedAt: '2026-11-23T07:00:00Z', note: '至少 70% 胜平率' },
    pairs: [{
      candidateA: { source: target, mediaUrl: 'media/neutral-a.png' },
      candidateB: { source: '松柏组', mediaUrl: 'media/neutral-b.png' },
    }],
    seed: 'b4-seed',
  };
  // 合法 note 含裸 % 不抛错
  assert.doesNotThrow(() => createBlindSession(baseOpts));

  // encodeURI 编码后的中文来源名、ASCII 百分号编码内置敏感词、查询参数编码来源名一律拒绝
  for (const leakedUrl of [
    encodeURI(`media/${target}/frame.png`),
    `media/${encodeURIComponent(encodeURIComponent(target))}/frame.png`,
    'media/%62%65%69%6d%69%6e%67/frame.png',
    'media/%E5%8C%97%E5%86%A5/frame.png',
    `media/frame.png?src=${encodeURIComponent(target)}`,
  ]) {
    const badOpts = structuredClone(baseOpts);
    badOpts.pairs[0].candidateA.mediaUrl = leakedUrl;
    assert.throws(() => createBlindSession(badOpts), isBadArg, `createBlindSession 未拦截编码泄源: ${leakedUrl}`);
  }

  // renderBlindPageHtml 同样拦截编码后的内置敏感词
  const { publicSession } = createBlindSession(baseOpts);
  for (const leakedUrl of ['media/%62%65%69%6d%69%6e%67/frame.png', 'media/%E5%8C%97%E5%86%A5/frame.png']) {
    const tampered = structuredClone(publicSession);
    tampered.pairs[0].left.mediaUrl = leakedUrl;
    delete tampered.layoutDigest;
    assert.throws(() => renderBlindPageHtml(tampered), isBadArg, `renderBlindPageHtml 未拦截编码泄源: ${leakedUrl}`);
  }
});

test('B5 跨会话选票回执不得被静默覆盖 sessionId；U2 盲选前端脚本导出的选票带 submittedAt 可直接入库', () => {
  const mkPairs = () => Array.from({ length: 10 }, (_, i) => ({
    candidateA: { source: '银杏组', mediaUrl: `media/p${i}-a.png` },
    candidateB: { source: '松柏组', mediaUrl: `media/p${i}-b.png` },
  }));
  const baseOpts = {
    sessionId: 'nov-23',
    createdAt: '2026-11-23T08:00:00Z',
    decisionLine: { targetSource: '银杏组', minWinsOrTies: 7, committedAt: '2026-11-23T07:00:00Z' },
    pairs: mkPairs(),
    seed: 'b5-seed',
  };
  const sA = createBlindSession(baseOpts);
  const sB = createBlindSession({ ...baseOpts, sessionId: 'nov-24' });
  const votes = Object.fromEntries(sA.publicSession.pairs.map((p) => [p.pairId, 'left']));

  // B5: sessionId 不匹配必须硬拒且不得写入 store
  const store = [];
  assert.throws(() => recordBlindBallot(store, sB.publicSession, {
    sessionId: 'nov-23',
    voter: 'director',
    submittedAt: '2026-11-23T10:00:00Z',
    votes,
  }), isBadArg);
  assert.equal(store.length, 0);
  assert.throws(() => recordBlindBallot(store, sB.publicSession, {
    sessionId: null,
    voter: 'director',
    submittedAt: '2026-11-23T10:00:00Z',
    votes,
  }), isBadArg);
  assert.equal(store.length, 0);

  // U2: 执行 renderBlindPageHtml 内联脚本，产出的回执带 ISO-8601 submittedAt，可直接传给 recordBlindBallot
  const html = renderBlindPageHtml(sA.publicSession);
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, '盲选页应包含内联脚本');
  const digestMatch = html.match(/data-blind-layout-digest="([^"]+)"/);
  const handlers = {};
  const outBox = { textContent: '{}' };
  const radios = sA.publicSession.pairs.map((p) => ({
    getAttribute: (k) => (k === 'data-pair-id' ? p.pairId : null),
    value: 'left',
  }));
  const sessionEl = {
    getAttribute: (k) => (k === 'data-blind-session-id' ? sA.publicSession.sessionId : k === 'data-blind-layout-digest' ? (digestMatch?.[1] ?? null) : null),
  };
  const sandbox = {
    document: {
      addEventListener: (type, fn) => { handlers[type] = fn; },
      querySelector: (sel) => (sel === '[data-blind-session-id]' ? sessionEl : null),
      querySelectorAll: () => radios,
      getElementById: (id) => (id === 'blind-voter' ? { value: 'director' } : id === 'blind-ballot-json' ? outBox : null),
    },
    Date,
  };
  vm.runInNewContext(scriptMatch[1], sandbox);
  assert.equal(typeof handlers.change, 'function');
  handlers.change();

  const receipt = JSON.parse(outBox.textContent);
  assert.equal(receipt.sessionId, 'nov-23');
  assert.equal(receipt.voter, 'director');
  assert.equal(typeof receipt.submittedAt, 'string');
  assert.match(receipt.submittedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepEqual(receipt.votes, votes);

  // 使用 committedAt 早于当前时刻的会话验证 receipt 原样可入库
  const liveSession = createBlindSession({
    ...baseOpts,
    createdAt: '2026-01-01T08:00:00Z',
    decisionLine: { targetSource: '银杏组', minWinsOrTies: 7, committedAt: '2026-01-01T07:00:00Z' },
  });
  const liveReceipt = { ...receipt, layoutDigest: liveSession.publicSession.layoutDigest };
  const savedStore = [];
  const recorded = recordBlindBallot(savedStore, liveSession.publicSession, liveReceipt);
  assert.equal(savedStore.length, 1);
  assert.equal(recorded.submittedAt, receipt.submittedAt);
});

test('B6 同场重排后旧 answerKey 与篡改排布均被 layoutDigest 硬拒，同排布只改审片视角可正常揭盲', () => {
  const pairs = Array.from({ length: 10 }, (_, i) => ({
    id: `p-${i}`,
    kind: 'still',
    reviewerChoice: 'A',
    candidateA: { source: '银杏组', mediaUrl: `media/g-${i}-1.png` },
    candidateB: { source: '松柏组', mediaUrl: `media/g-${i}-2.png` },
  }));
  const opts = {
    sessionId: 'nov-23',
    createdAt: '2026-11-23T08:00:00Z',
    decisionLine: { targetSource: '银杏组', minWinsOrTies: 7, committedAt: '2026-11-23T07:00:00Z' },
    pairs,
    seed: 'R1.31',
  };
  const s1 = createBlindSession(opts);
  const s2 = createBlindSession({ ...opts, seed: 'R1.32' });

  assert.equal(typeof s1.publicSession.layoutDigest, 'string');
  assert.match(s1.publicSession.layoutDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(s1.publicSession.layoutDigest, s1.answerKey.layoutDigest);
  assert.notEqual(s1.publicSession.layoutDigest, s2.publicSession.layoutDigest);

  const votesForS2 = Object.fromEntries(
    s2.answerKey.pairs.map((k) => [k.pairId, k.leftSource === '银杏组' ? 'left' : 'right']),
  );
  const ballot2 = recordBlindBallot([], s2.publicSession, {
    sessionId: opts.sessionId,
    voter: 'director',
    submittedAt: '2026-11-23T10:00:00Z',
    votes: votesForS2,
  });
  const okReport = unblindBlindSession(s2.publicSession, s2.answerKey, ballot2);
  assert.equal(okReport.targetWins, 10);
  assert.equal(okReport.passed, true);

  // 旧答案键 s1.answerKey 绝不能静默揭盲 s2.publicSession
  assert.throws(() => unblindBlindSession(s2.publicSession, s1.answerKey, ballot2), isBadArg);
  // 缺 layoutDigest 的旧格式答案键同样拒绝
  const keyWithoutDigest = structuredClone(s2.answerKey);
  delete keyWithoutDigest.layoutDigest;
  assert.throws(() => unblindBlindSession(s2.publicSession, keyWithoutDigest, ballot2), isBadArg);
  // 篡改 publicSession 排布而保留旧 layoutDigest 被拒绝
  const tamperedPub = structuredClone(s2.publicSession);
  [tamperedPub.pairs[0].left.mediaUrl, tamperedPub.pairs[0].right.mediaUrl] = [
    tamperedPub.pairs[0].right.mediaUrl,
    tamperedPub.pairs[0].left.mediaUrl,
  ];
  assert.throws(() => renderBlindPageHtml(tamperedPub), isBadArg);
  assert.throws(() => unblindBlindSession(tamperedPub, s2.answerKey, ballot2), isBadArg);
  // 同排布仅改审片视角（layoutDigest 相同）正常揭盲
  const altReviewerOpts = structuredClone(opts);
  altReviewerOpts.seed = 'R1.32';
  altReviewerOpts.pairs[0].reviewerChoice = 'B';
  const s2Alt = createBlindSession(altReviewerOpts);
  assert.equal(s2Alt.publicSession.layoutDigest, s2.publicSession.layoutDigest);
  const altReport = unblindBlindSession(s2Alt.publicSession, s2Alt.answerKey, ballot2);
  assert.equal(altReport.targetWins, 10);
  assert.equal(altReport.agreementRate, 0.9);
});

test('B7 省略 seed 时生成不可预测的随机种子，绝不退回公开 sessionId 且不泄入 publicSession', () => {
  const pairs = Array.from({ length: 10 }, (_, i) => ({
    candidateA: { source: '银杏组', mediaUrl: `media/r-${i}-1.png` },
    candidateB: { source: '松柏组', mediaUrl: `media/r-${i}-2.png` },
  }));
  const opts = {
    sessionId: 'nov-23',
    createdAt: '2026-11-23T08:00:00Z',
    decisionLine: { targetSource: '银杏组', minWinsOrTies: 7, committedAt: '2026-11-23T07:00:00Z' },
    pairs,
  };
  const r1 = createBlindSession(opts);
  const r2 = createBlindSession(opts);
  assert.equal(typeof r1.answerKey.seed, 'string');
  assert.ok(r1.answerKey.seed.length >= 16);
  assert.notEqual(r1.answerKey.seed, r1.publicSession.sessionId);
  assert.notEqual(r1.answerKey.seed, r2.answerKey.seed);
  assert.equal(Object.hasOwn(r1.publicSession, 'seed'), false);
  assert.ok(!JSON.stringify(r1.publicSession).includes(r1.answerKey.seed));
});

/* ---------------- G_REV-R2 回归测试（R2-1 / R2-2 / R2-3 / R2-4） ---------------- */

test('R2-1 判定目标不同的答案键不能改判同一张票，且公开承诺不泄露来源名或种子', () => {
  const target = '银杏组';
  const other = '松柏组';
  const opts = {
    sessionId: 'nov-23',
    createdAt: '2026-11-23T08:00:00Z',
    seed: 'R1.31',
    decisionLine: { targetSource: target, minWinsOrTies: 7, committedAt: '2026-11-23T07:00:00Z' },
    pairs: Array.from({ length: 10 }, (_, i) => ({
      candidateA: { source: target, mediaUrl: `media/${2 * i + 1}.png` },
      candidateB: { source: other, mediaUrl: `media/${2 * i + 2}.png` },
    })),
  };
  const first = createBlindSession(opts);
  const second = createBlindSession({
    ...opts,
    decisionLine: { ...opts.decisionLine, targetSource: other },
  });
  assert.notEqual(first.publicSession.decisionCommitment, second.publicSession.decisionCommitment);
  assert.notEqual(JSON.stringify(first.publicSession), JSON.stringify(second.publicSession));
  for (const leak of [target, other, opts.seed]) {
    assert.ok(!JSON.stringify(first.publicSession).includes(leak));
    assert.ok(!JSON.stringify(second.publicSession).includes(leak));
  }

  const allForFirst = {
    voter: 'director',
    submittedAt: '2026-11-23T10:00:00Z',
    votes: Object.fromEntries(first.answerKey.pairs.map((p) => [p.pairId, p.leftSource === target ? 'left' : 'right'])),
  };
  const vote = recordBlindBallot([], first.publicSession, allForFirst);
  const okReport = unblindBlindSession(first.publicSession, first.answerKey, vote);
  assert.deepEqual([okReport.targetWins, okReport.passed], [10, true]);

  // 换用另一判定目标的 answerKey 必须以 usage.bad-argument 拒绝
  assert.throws(() => unblindBlindSession(first.publicSession, second.answerKey, vote), isBadArg);
  assert.throws(() => unblindBlindSession(second.publicSession, second.answerKey, vote), isBadArg);
  assert.throws(() => recordBlindBallot([], second.publicSession, vote), isBadArg);
});

test('R2-2 缺少 layoutDigest 或 decisionCommitment 的前版落盘选票不得按新排布重新盖章或直接计分', () => {
  const target = '银杏组';
  const other = '松柏组';
  const opts = {
    sessionId: 'nov-23',
    createdAt: '2026-11-23T08:00:00Z',
    seed: 'R1.32',
    decisionLine: { targetSource: target, minWinsOrTies: 7, committedAt: '2026-11-23T07:00:00Z' },
    pairs: Array.from({ length: 10 }, (_, i) => ({
      candidateA: { source: target, mediaUrl: `media/${2 * i + 1}.png` },
      candidateB: { source: other, mediaUrl: `media/${2 * i + 2}.png` },
    })),
  };
  const second = createBlindSession(opts);
  const votes = Object.fromEntries(second.publicSession.pairs.map((p) => [p.pairId, 'left']));

  // 模拟前版（无 layoutDigest / 无 decisionCommitment）落盘的 bench-blind-ballot/0.1 选票
  const legacySavedWithoutDigest = {
    format: BLIND_BALLOT_FORMAT,
    sessionId: 'nov-23',
    voter: 'director',
    submittedAt: '2026-11-23T10:00:00Z',
    votes,
  };
  const legacySavedWithoutCommitment = {
    ...legacySavedWithoutDigest,
    layoutDigest: second.publicSession.layoutDigest,
  };

  for (const saved of [legacySavedWithoutDigest, legacySavedWithoutCommitment]) {
    const store = [];
    assert.throws(() => recordBlindBallot(store, second.publicSession, saved), isBadArg);
    assert.equal(store.length, 0);
    assert.throws(() => unblindBlindSession(second.publicSession, second.answerKey, saved), isBadArg);
  }
});

test('R2-3 无盲选成绩但同时有考题成绩与能量尺时，成片墙画面上限与 HTML 均展示能量尺读数', () => {
  const date = '2026-11-23';
  const board = buildBoard({
    asOf: date,
    results: [{
      format: 'bench-result/0.1',
      questionId: '9-1',
      level: 1,
      source: 'three',
      model: 'm',
      status: 'pass',
      pass: true,
      score: 1,
    }],
    energy: [{ metric: 'noise.residual', value: 0.125 }],
    rebuild: { tolerance: { passed: 3, total: 4 } },
  });
  const wall = buildFilmWall({
    date,
    films: [{ filmId: 'cut-0', template: 'turntable', mediaUrl: 'cut.png' }],
    scoreboard: board,
  });
  const html = renderFilmWallHtml(wall);
  assert.match(wall.fourIndicators.ceiling.display, /考题通过 1\/1（100\.0%）/);
  assert.match(wall.fourIndicators.ceiling.display, /noise\.residual=0\.125/);
  assert.match(html, /跨机容差 3\/4（75\.0%）/);
  assert.ok(html.includes('noise.residual=0.125'));
});

test('R2-4 成片墙点击一句话打回前严格校验 frameEnd >= frameStart，非法区间不标已打回且不导出非法回执', () => {
  const wall = buildFilmWall({
    date: '2026-11-23',
    films: [{ filmId: 'cut-0', template: 'turntable', mediaUrl: 'cut.png' }],
  });
  const html = renderFilmWallHtml(wall);
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch);

  let clickHandler = null;
  const statusEl = { textContent: '待看' };
  const outBox = { textContent: '{}' };
  const fields = {
    '[name="frameStart"]': { value: '12' },
    '[name="frameEnd"]': { value: '0' }, // 保留页面初始值 0 < 12
    '[name="category"]': { value: '' },
    '[name="verbatim"]': { value: '从这里开始反光跳动' },
    '[data-role="status-label"]': statusEl,
  };
  const card = {
    getAttribute: (k) => (k === 'data-film-id' ? 'cut-0' : k === 'data-film-template' ? 'turntable' : null),
    querySelector: (sel) => fields[sel] ?? null,
  };
  const rejectBtn = {
    getAttribute: (k) => (k === 'data-wall-action' ? 'reject' : null),
    closest: (sel) => (sel === 'button[data-wall-action]' ? rejectBtn : sel === '[data-film-id]' ? card : null),
  };
  const sandbox = {
    window: {},
    document: {
      addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; },
      getElementById: (id) => (id === 'wall-decisions-json' ? outBox : null),
    },
    Date,
  };
  vm.runInNewContext(scriptMatch[1], sandbox);
  clickHandler({ target: rejectBtn });

  // 结束帧 0 < 起始帧 12：绝不能标为「已打回」，也不得写入回执
  assert.notEqual(statusEl.textContent, '已打回');
  assert.match(statusEl.textContent, /帧区间无效/);
  assert.equal(JSON.parse(outBox.textContent)['cut-0'], undefined);

  // 更正结束帧为 15 后再次点击：标为「已打回」且导出回执可原样入账
  fields['[name="frameEnd"]'].value = '15';
  clickHandler({ target: rejectBtn });
  assert.equal(statusEl.textContent, '已打回');
  const receipt = JSON.parse(outBox.textContent)['cut-0'];
  assert.deepEqual(receipt.frames, [12, 15]);
  withTmpDir((ledgerDir) => {
    assert.doesNotThrow(() => recordRejection(ledgerDir, receipt));
  });
});
