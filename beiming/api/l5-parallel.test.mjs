import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAiVisionReviewer, reviewerFromEnv } from './agents.mjs';
import { layerL5 } from './pipeline.mjs';

const FILM = {
  id: 'f_par_001',
  output: { size: [320, 180], fps: '10/1', frames: 20 },
  shots: [{ id: 's01', in: 0, out: 20 }],
};

function parseVoteTag(body) {
  const sys = body?.messages?.[0]?.content ?? '';
  const m = /\[PERSPECTIVE:([^\]]+)\]\[VOTE:(\d+)\]/.exec(sys);
  return m ? { perspective: m[1], voteIndex: Number(m[2]) - 1 } : { perspective: 'unknown', voteIndex: -1 };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('L5-PAR-1: concurrency 参数校验与 BEIMING_REVIEW_CONCURRENCY 环境变量解析', () => {
  const isBadArg = (err) => err?.code === 'usage.bad-argument';
  const baseCfg = {
    endpoint: 'http://127.0.0.1:1/v1',
    apiKey: 'k',
    model: 'm',
    ledgerPath: '/tmp/l5-par-1.jsonl',
  };

  const def = createOpenAiVisionReviewer(baseCfg);
  assert.equal(def.concurrency, 3, '默认 concurrency 必须为 3');

  for (const valid of [1, 3, 16]) {
    const r = createOpenAiVisionReviewer({ ...baseCfg, concurrency: valid });
    assert.equal(r.concurrency, valid);
  }

  for (const invalid of [0, -1, 1.5, 17, '3', NaN, Infinity, null, true]) {
    assert.throws(
      () => createOpenAiVisionReviewer({ ...baseCfg, concurrency: invalid }),
      isBadArg,
      `非法 concurrency=${String(invalid)} 必须抛 usage.bad-argument`,
    );
  }

  const baseEnv = {
    BEIMING_REVIEW_ENDPOINT: 'http://127.0.0.1:1/v1',
    BEIMING_REVIEW_API_KEY: 'k',
    BEIMING_REVIEW_MODEL: 'm',
  };
  assert.equal(reviewerFromEnv({ env: baseEnv, ledgerPath: baseCfg.ledgerPath }).concurrency, 3);
  assert.equal(reviewerFromEnv({ env: { ...baseEnv, BEIMING_REVIEW_CONCURRENCY: '' }, ledgerPath: baseCfg.ledgerPath }).concurrency, 3);
  assert.equal(reviewerFromEnv({ env: { ...baseEnv, BEIMING_REVIEW_CONCURRENCY: '   ' }, ledgerPath: baseCfg.ledgerPath }).concurrency, 3);
  assert.equal(reviewerFromEnv({ env: { ...baseEnv, BEIMING_REVIEW_CONCURRENCY: '1' }, ledgerPath: baseCfg.ledgerPath }).concurrency, 1);
  assert.equal(reviewerFromEnv({ env: { ...baseEnv, BEIMING_REVIEW_CONCURRENCY: '3' }, ledgerPath: baseCfg.ledgerPath }).concurrency, 3);
  assert.equal(reviewerFromEnv({ env: { ...baseEnv, BEIMING_REVIEW_CONCURRENCY: ' 16 ' }, ledgerPath: baseCfg.ledgerPath }).concurrency, 16);

  for (const badEnv of ['0', '-1', '1.5', '17', 'abc', '3px', '1e1']) {
    assert.throws(
      () => reviewerFromEnv({ env: { ...baseEnv, BEIMING_REVIEW_CONCURRENCY: badEnv }, ledgerPath: baseCfg.ledgerPath }),
      isBadArg,
      `非法 BEIMING_REVIEW_CONCURRENCY=${badEnv} 必须抛 usage.bad-argument`,
    );
  }
});

test('L5-PAR-2: 真实并发提速与乱序返回严格按 slotIndex 保序（9 票 concurrency: 3）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-l5-par-2-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  let inFlight = 0;
  let maxInFlight = 0;
  const completionOrder = [];

  const mockVision = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    const { perspective, voteIndex } = parseVoteTag(body);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const isFirst = perspective === 'composition-readability' && voteIndex === 0;
    const delayMs = isFirst ? 220 : 40;
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight--;
    completionOrder.push(`${perspective}:${voteIndex}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'vision-par',
      choices: [{
        message: {
          content: JSON.stringify({
            grade: '好',
            opinions: [],
            suggestedPredicates: [],
          }),
        },
      }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  try {
    const reviewer = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'test-key',
      model: 'vision-par',
      ledgerPath,
      concurrency: 3,
    });
    const t0 = Date.now();
    const res = await reviewer.review({
      brief: '并发与保序测试',
      images: [],
      film: FILM,
      filmId: FILM.id,
    });
    const elapsedMs = Date.now() - t0;

    assert.equal(res.ballots.length, 9);
    assert.equal(res.invalidBallots.length, 0);
    assert.equal(res.executedBallots, 9);
    assert.ok(maxInFlight >= 2 && maxInFlight <= 3, `期望 maxInFlight 在 2..3 之间，实际 ${maxInFlight}`);
    // 串行理论下限为 220 + 8 * 40 = 540ms；并发 3 约 220~270ms
    assert.ok(elapsedMs < 430, `并发 3 总耗时 ${elapsedMs}ms 应显著低于串行下限 540ms`);
    assert.notEqual(
      completionOrder[0],
      'composition-readability:0',
      `第 0 票延迟最长，应晚于更快的票完成，实际完成序: ${completionOrder.join(', ')}`,
    );
    assert.deepEqual(
      res.ballots.map((b) => `${b.perspective}:${b.voteIndex}`),
      [
        'composition-readability:0',
        'composition-readability:1',
        'composition-readability:2',
        'motion-rhythm:0',
        'motion-rhythm:1',
        'motion-rhythm:2',
        'look-consistency:0',
        'look-consistency:1',
        'look-consistency:2',
      ],
      '即使乱序返回，ballots 顺序必须严格按视角×票号升序确定性排列',
    );
    assert.equal(res.usage.totalTokens, 9 * 150);
    const ledgerRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(ledgerRows.length, 9);
    assert.equal(ledgerRows.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0), 9 * 150);
  } finally {
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L5-PAR-3: 带 settle 原子预留的严格预算（concurrency: 3 不越线、暂满等结算不假停机、active 归零）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-l5-par-3-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  let inFlight = 0;
  let maxInFlight = 0;

  const mockVision = createServer(async (req, res) => {
    await readJsonBody(req);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 35));
    inFlight--;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'vision-lease',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 760, completion_tokens: 40 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  function makeLease(cap) {
    const active = new Map();
    let settled = 0;
    let seq = 0;
    let peakCommitted = 0;
    let deniedForTokensCount = 0;
    const check = ({ estimatedInputTokens = 0, maxOutputTokens = 0, maxObservedTokens = 0, estimatedNextTokens = 0 } = {}) => {
      const activeSum = [...active.values()].reduce((a, b) => a + b, 0);
      const used = settled + activeSum;
      const remaining = cap - used;
      const minRequired = Math.max(estimatedInputTokens + 1, maxObservedTokens);
      if (remaining < minRequired) {
        deniedForTokensCount++;
        return { ok: false, reason: 'budget.tokens', remaining };
      }
      const grantedOutput = Math.min(maxOutputTokens, Math.max(0, remaining - estimatedInputTokens));
      if (grantedOutput < 1) {
        deniedForTokensCount++;
        return { ok: false, reason: 'budget.tokens', remaining };
      }
      const reserveAmount = Math.min(remaining, Math.max(estimatedInputTokens + grantedOutput, maxObservedTokens, estimatedNextTokens));
      peakCommitted = Math.max(peakCommitted, used + reserveAmount);
      const id = ++seq;
      active.set(id, reserveAmount);
      let done = false;
      return {
        ok: true,
        remaining: remaining - reserveAmount,
        maxOutputTokens: grantedOutput,
        settle(actual = 0) {
          if (done) return;
          done = true;
          active.delete(id);
          settled += Math.max(0, Math.round(actual));
        },
      };
    };
    return {
      check,
      active,
      get settled() { return settled; },
      get peakCommitted() { return peakCommitted; },
      get deniedForTokensCount() { return deniedForTokensCount; },
    };
  }

  try {
    const reviewer = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'test-key',
      model: 'vision-lease',
      ledgerPath,
      concurrency: 3,
    });

    // 1) cap=9,500：单票预估 ~2,500、实耗 800（9 票总实耗 7,200 <= 9,500）
    //    在途 3 票同时预留 ~7,500 后暂满，第 4 票必须等在途结算释放后继续，不得提前假停机！
    const lease1 = makeLease(9_500);
    const res1 = await layerL5({
      reviewer,
      brief: '严格预算并发等待结算测试',
      images: [],
      film: FILM,
      filmId: FILM.id,
      budgetCheck: lease1.check,
    });
    assert.equal(res1.status, 'ok');
    assert.equal(res1.stoppedReason, undefined);
    assert.equal(res1.totalBallots, 9, '在途预留暂满等待结算后，全部 9 票应完成而不假停机');
    assert.ok(maxInFlight >= 2 && maxInFlight <= 3, `期望并发度在 2..3，实际 ${maxInFlight}`);
    assert.ok(lease1.deniedForTokensCount >= 1, '测试应真实触发至少一次在途预留暂满后等待重试');
    assert.ok(lease1.peakCommitted <= 9_500, `峰值已承诺预留 ${lease1.peakCommitted} 不得越过 cap 9,500`);
    assert.equal(lease1.settled, 9 * 800);
    assert.equal(lease1.active.size, 0, '结束后所有预留必须归零');

    // 2) cap=4,800：真不够全部 9 票（6 票 * 800 = 4,800），绝不超支且 active 归零
    maxInFlight = 0;
    const lease2 = makeLease(4_800);
    const res2 = await layerL5({
      reviewer,
      brief: '真超预算停票测试',
      images: [],
      film: FILM,
      filmId: FILM.id,
      budgetCheck: lease2.check,
    });
    assert.equal(res2.status, 'ok');
    assert.equal(res2.stoppedReason, 'budget.tokens');
    assert.ok(lease2.settled <= 4_800, `实耗 ${lease2.settled} 绝不得超过 cap 4,800`);
    assert.ok(lease2.peakCommitted <= 4_800, `峰值预留 ${lease2.peakCommitted} 绝不得超过 cap 4,800`);
    assert.equal(lease2.active.size, 0, '超预算停票后 active 必须归零');
  } finally {
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L5-PAR-4: 无 settle 降级串行、AbortSignal 中途取消与单票异常隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-l5-par-4-'));

  // 1) 无 settle 的传统 budgetCheck 自动降级为串行（maxInFlight === 1）
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const server = createServer(async (req, res) => {
      await readJsonBody(req);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'vision-legacy',
        choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const reviewer = createOpenAiVisionReviewer({
        endpoint: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'test-key',
        model: 'vision-legacy',
        ledgerPath: join(dir, 'legacy.jsonl'),
        concurrency: 3,
      });
      const res = await reviewer.review({
        brief: '无 settle 回调测试',
        images: [],
        film: FILM,
        filmId: FILM.id,
        budgetCheck: ({ ballotIndex }) => ballotIndex < 4,
      });
      assert.equal(maxInFlight, 1, '不带 settle 的传统 budgetCheck 必须自动降级为串行');
      assert.equal(res.ballots.length, 4);
      assert.equal(res.stoppedReason, 'budget.tokens');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  // 2) AbortSignal 中途取消：立即停发新票，已发在途预留全部安全结算
  {
    let calls = 0;
    const active = new Map();
    let seq = 0;
    const server = createServer(async (req, res) => {
      await readJsonBody(req);
      calls++;
      await new Promise((r) => setTimeout(r, 120));
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'vision-abort',
          choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }));
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const reviewer = createOpenAiVisionReviewer({
        endpoint: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'test-key',
        model: 'vision-abort',
        ledgerPath: join(dir, 'abort.jsonl'),
        concurrency: 3,
      });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30);
      const res = await reviewer.review({
        brief: '取消测试',
        images: [],
        film: FILM,
        filmId: FILM.id,
        signal: ac.signal,
        budgetCheck() {
          const id = ++seq;
          active.set(id, 3000);
          return { ok: true, settle() { active.delete(id); } };
        },
      });
      assert.equal(res.stoppedReason, 'canceled');
      assert.ok(calls <= 3, `取消后不得继续派发新票，实际调用 ${calls}`);
      assert.equal(active.size, 0, '取消后所有已发在途预留必须安全结算归零');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  // 3) 并发中单票 HTTP 500 与坏 JSON 隔离：不拖垮同批其他在途票，usage 0 丢账且双数组均按 slotIndex 升序
  {
    const active = new Map();
    let seq = 0;
    let settledTotal = 0;
    const server = createServer(async (req, res) => {
      const body = await readJsonBody(req);
      const { perspective, voteIndex } = parseVoteTag(body);
      await new Promise((r) => setTimeout(r, perspective === 'composition-readability' && voteIndex === 1 ? 50 : 15));
      if (perspective === 'composition-readability' && voteIndex === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('upstream error');
        return;
      }
      if (perspective === 'motion-rhythm' && voteIndex === 2) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'vision-fault',
          choices: [{ message: { content: '{not-valid-json' } }],
          usage: { prompt_tokens: 180, completion_tokens: 20 },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'vision-fault',
        choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const reviewer = createOpenAiVisionReviewer({
        endpoint: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'test-key',
        model: 'vision-fault',
        ledgerPath: join(dir, 'fault.jsonl'),
        concurrency: 3,
      });
      const res = await reviewer.review({
        brief: '单票故障隔离测试',
        images: [],
        film: FILM,
        filmId: FILM.id,
        budgetCheck() {
          const id = ++seq;
          active.set(id, 3000);
          return {
            ok: true,
            settle(actual = 0) {
              active.delete(id);
              settledTotal += actual;
            },
          };
        },
      });
      assert.equal(res.ballots.length, 7);
      assert.equal(res.invalidBallots.length, 2);
      assert.deepEqual(
        res.invalidBallots.map((b) => `${b.perspective}:${b.voteIndex}`),
        ['composition-readability:1', 'motion-rhythm:2'],
      );
      assert.equal(res.usage.totalTokens, 7 * 120 + 200);
      assert.equal(settledTotal, 7 * 120 + 200);
      assert.equal(active.size, 0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  rmSync(dir, { recursive: true, force: true });
});
