import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tools } from '../comp/index.mjs';
import { DEFAULT_REVIEW_CONCURRENCY, createOpenAiVisionReviewer, reviewerFromEnv } from './agents.mjs';
import { issueAccountToken, startServer } from './index.mjs';
import { layerL5 } from './pipeline.mjs';

function threeMediaSkip() {
  const { ffmpeg, ffprobe } = tools();
  for (const [name, bin, args] of [['ffmpeg', ffmpeg, ['-version']], ['ffprobe', ffprobe, ['-version']]]) {
    if (!bin || spawnSync(bin, args, { stdio: 'ignore', timeout: 20000 }).status !== 0) return `缺少可执行的 ${name}`;
  }
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 20000 });
  return r.status === 0 ? null : '无头浏览器不可执行';
}

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

  assert.equal(DEFAULT_REVIEW_CONCURRENCY, 1, 'DEFAULT_REVIEW_CONCURRENCY 必须为 1');
  const def = createOpenAiVisionReviewer(baseCfg);
  assert.equal(def.concurrency, 1, '默认 concurrency 必须为 1');

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
  assert.equal(reviewerFromEnv({ env: baseEnv, ledgerPath: baseCfg.ledgerPath }).concurrency, 1);
  assert.equal(reviewerFromEnv({ env: { ...baseEnv, BEIMING_REVIEW_CONCURRENCY: '' }, ledgerPath: baseCfg.ledgerPath }).concurrency, 1);
  assert.equal(reviewerFromEnv({ env: { ...baseEnv, BEIMING_REVIEW_CONCURRENCY: '   ' }, ledgerPath: baseCfg.ledgerPath }).concurrency, 1);
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

test('L5-PAR-5 [R1-阻断#1]: 默认 POST /review（concurrency=1）3 票预算 65,000 + 变价 [10,040, 30,040, 30,040] 在第 2 票后停票且两本账均为 40,080', async (t) => {
  const skip = threeMediaSkip();
  if (skip) return t.skip(skip);

  const dir = mkdtempSync(join(tmpdir(), 'bm-l5-par-5-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  const costPlan = [
    { prompt: 10_000, comp: 40 },
    { prompt: 30_000, comp: 40 },
    { prompt: 30_000, comp: 40 },
  ];
  let callIdx = 0;

  const mockVision = createServer(async (req, res) => {
    await readJsonBody(req);
    const plan = costPlan[Math.min(callIdx++, costPlan.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'vision-var-price',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: plan.prompt, completion_tokens: plan.comp },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'test-key',
    model: 'vision-var-price',
    ledgerPath,
    perspectives: [{ id: 'composition-readability', title: '构图与可读', focus: '构图', votes: 3 }],
  });
  assert.equal(reviewer.concurrency, 1);

  const token = issueAccountToken(dir);
  const api = await startServer({ dataDir: dir, port: 0, reviewer });
  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        text: 'R1B1',
        output: { size: [320, 180], fps: '10/1', frames: 6 },
        budget: { tokens: 65_000 },
      }),
    })).json();
    assert.equal(created.ok, true);
    const filmId = created.data.film;
    const wsToken = created.data.token;

    const renderEnv = await (await fetch(`${api.url}/v1/films/${filmId}/render?wait=30`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'draft' }),
    })).json();
    assert.equal(renderEnv.ok, true);
    assert.equal(renderEnv.data.status, 'succeeded');

    const reviewEnv = await (await fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'R1 阻断 #1 默认串行高水位防超支测试' }),
    })).json();
    assert.equal(reviewEnv.ok, true);
    assert.equal(reviewEnv.data.status, 'ok');
    assert.equal(reviewEnv.data.stoppedReason, 'budget.tokens');
    assert.equal(callIdx, 2, '第 2 票完成后高水位更新为 30,040，余额 24,920 不足高水位，必须停在第 2 票');

    const ledgerEnv = await (await fetch(`${api.url}/v1/films/${filmId}/ledger`, {
      headers: { authorization: `Bearer ${wsToken}` },
    })).json();
    const wsTotal = ledgerEnv.data.items.reduce((s, x) => s + (x.modelTokens ?? 0), 0);
    const extRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    const extTotal = extRows.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
    assert.equal(wsTotal, 40_080);
    assert.equal(extTotal, 40_080);
    assert.ok(wsTotal <= 65_000 && extTotal <= 65_000);
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L5-PAR-6 [R1-阻断#2]: concurrency=3 + 预算 31,104 不因在途临时预留截断第 3 票 max_tokens（3 票全有效、invalidBallots=0）', async (t) => {
  const skip = threeMediaSkip();
  if (skip) return t.skip(skip);

  const dir = mkdtempSync(join(tmpdir(), 'bm-l5-par-6-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  const seenMaxTokens = [];

  const mockVision = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    const { voteIndex } = parseVoteTag(body);
    seenMaxTokens.push(body.max_tokens);
    if (voteIndex === 1) {
      await new Promise((r) => setTimeout(r, 60));
    }
    const isThird = voteIndex === 2;
    const neededComp = isThird ? 80 : 40;
    const payload = JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] });
    // 模拟真实上游按请求 max_tokens 硬截断输出（第 3 票需要 80 token，若被误裁为 40 则返回半截 JSON）
    const content = body.max_tokens < neededComp ? payload.slice(0, 18) : payload;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'vision-no-trunc',
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10_000, completion_tokens: Math.min(neededComp, body.max_tokens) },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'test-key',
    model: 'vision-no-trunc',
    ledgerPath,
    perspectives: [{ id: 'composition-readability', title: '构图与可读', focus: '构图', votes: 3 }],
    concurrency: 3,
  });

  const token = issueAccountToken(dir);
  const api = await startServer({ dataDir: dir, port: 0, reviewer });
  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        text: 'R1B2',
        output: { size: [320, 180], fps: '10/1', frames: 6 },
        budget: { tokens: 31_104 },
      }),
    })).json();
    assert.equal(created.ok, true);
    const filmId = created.data.film;
    const wsToken = created.data.token;

    const renderEnv = await (await fetch(`${api.url}/v1/films/${filmId}/render?wait=30`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'draft' }),
    })).json();
    assert.equal(renderEnv.ok, true);

    const reviewEnv = await (await fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'R1 阻断 #2 在途临时预留不得截断 max_tokens' }),
    })).json();
    assert.equal(reviewEnv.ok, true);
    assert.equal(reviewEnv.data.status, 'ok');
    assert.equal(reviewEnv.data.stoppedReason, undefined);
    assert.equal(reviewEnv.data.invalidBallots ?? undefined, undefined, '3 票均不得因临时预留被截断而成为坏票');
    assert.equal(seenMaxTokens.length, 3);
    assert.ok(seenMaxTokens.every((m) => m === 1024), `每票均应按完整 max_tokens=1024 发出，实际 ${JSON.stringify(seenMaxTokens)}`);

    const extRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(extRows.length, 3);
    const extTotal = extRows.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
    assert.equal(extTotal, 30_160);
    assert.ok(extTotal <= 31_104);
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L5-PAR-7 [R1-阻断#3]: 异步 budgetCheck 在途票结算后返回过期拒绝时自动重检，全部 3 票通过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-l5-par-7-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');

  const mockVision = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    const { voteIndex } = parseVoteTag(body);
    await new Promise((r) => setTimeout(r, voteIndex === 1 ? 45 : 10));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'vision-async-stale',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  try {
    const reviewer = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'test-key',
      model: 'vision-async-stale',
      ledgerPath,
      perspectives: [{ id: 'composition-readability', title: '构图与可读', focus: '构图', votes: 3 }],
      concurrency: 3,
    });

    const active = new Map();
    let seq = 0;
    let ballot2Checks = 0;
    const res = await reviewer.review({
      brief: '异步 budgetCheck 过期拒绝重检',
      images: [],
      film: FILM,
      filmId: FILM.id,
      async budgetCheck({ ballotIndex }) {
        if (ballotIndex === 2) {
          ballot2Checks++;
          if (ballot2Checks === 1) {
            // 模拟异步预算服务在第 2 票（index=1）结算前读到满额，等其结算释放后再把过期拒绝交回
            await new Promise((r) => setTimeout(r, 90));
            return { ok: false, reason: 'budget.tokens' };
          }
        }
        const id = ++seq;
        active.set(id, 1);
        return {
          ok: true,
          settle() { active.delete(id); },
        };
      },
    });

    assert.equal(ballot2Checks, 2, '过期拒绝被 settledSeq 识别后必须自动重检第 3 票');
    assert.equal(res.ballots.length, 3);
    assert.equal(res.stoppedReason, undefined);
    assert.equal(res.usage.totalTokens, 360);
    assert.equal(active.size, 0);
  } finally {
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L5-PAR-8 [R1-阻断#4 & #5]: 首票有 settle 不掩盖后续无 settle、constructor 视角键与调度抛错必等在途票记账结算', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-l5-par-8-'));

  // 1) 阻断 #4：首票返回 settle()，后续票无 settle 按 spentTokens + 120 <= 240 授权
  {
    const server = createServer(async (req, res) => {
      await readJsonBody(req);
      await new Promise((r) => setTimeout(r, 15));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'vision-mixed-settle',
        choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const reviewer = createOpenAiVisionReviewer({
        endpoint: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'test-key',
        model: 'vision-mixed-settle',
        ledgerPath: join(dir, 'mixed-settle.jsonl'),
        perspectives: [{ id: 'composition-readability', title: '构图与可读', focus: '构图', votes: 3 }],
        concurrency: 3,
      });
      const observedSpent = [];
      const res = await reviewer.review({
        brief: '逐票检查 settle',
        images: [],
        film: FILM,
        filmId: FILM.id,
        budgetCheck({ ballotIndex, spentTokens }) {
          observedSpent.push(spentTokens);
          return ballotIndex === 0 ? { ok: true, settle() {} } : spentTokens + 120 <= 240;
        },
      });
      assert.deepEqual(observedSpent, [0, 120, 240]);
      assert.equal(res.ballots.length, 2);
      assert.equal(res.stoppedReason, 'budget.tokens');
      assert.ok(res.usage.totalTokens <= 240, `总支出 ${res.usage.totalTokens} 不得超过 240`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  // 2) 阻断 #5a：自定义视角 id="constructor" 且省略 issueKeys 不抛错
  {
    const server = createServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'vision-ctor',
        choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const reviewer = createOpenAiVisionReviewer({
        endpoint: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'test-key',
        model: 'vision-ctor',
        ledgerPath: join(dir, 'ctor.jsonl'),
        perspectives: [{ id: 'constructor', title: '构造原型键测试', focus: '检查不误命中 Object.prototype.constructor', votes: 1 }],
        concurrency: 2,
      });
      const res = await reviewer.review({
        brief: 'constructor 键测试',
        images: [],
        film: FILM,
        filmId: FILM.id,
      });
      assert.equal(res.ballots.length, 1);
      assert.equal(res.ballots[0].perspective, 'constructor');
      assert.equal(res.usage.totalTokens, 120);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  // 3) 阻断 #5b：调度循环抛错时必须等在途票完成响应、写账本与 settle 后才返回，绝不先返回、后记账
  {
    const ledgerPath = join(dir, 'drain-on-throw.jsonl');
    const server = createServer(async (req, res) => {
      await readJsonBody(req);
      await new Promise((r) => setTimeout(r, 80));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'vision-drain',
        choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const active = new Map();
      let seq = 0;
      let settledTotal = 0;
      const reviewer = createOpenAiVisionReviewer({
        endpoint: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'test-key',
        model: 'vision-drain',
        ledgerPath,
        perspectives: [
          { id: 'constructor', title: '正常在途票', focus: '延迟响应', votes: 1 },
          {
            id: 'boom',
            votes: 1,
            get title() { throw new Error('simulated dispatch failure'); },
            focus: '触发调度异常',
          },
        ],
        concurrency: 2,
      });
      const res = await layerL5({
        reviewer,
        brief: '调度异常排空在途票测试',
        images: [],
        film: FILM,
        filmId: FILM.id,
        budgetCheck() {
          const id = ++seq;
          active.set(id, 1);
          return {
            ok: true,
            settle(actual = 0) {
              active.delete(id);
              settledTotal += actual;
            },
          };
        },
      });
      assert.equal(res.status, 'failed');
      assert.equal(res.reason, '视觉审片适配器调用失败');
      assert.equal(active.size, 0, '返回时在途票必须已全部 settle');
      assert.equal(settledTotal, 120, '返回时在途票实耗必须已全部结算');
      assert.equal(res.usage?.totalTokens, 120, '返回结果 usage 必须完整包含已收在途票用量');
      const rowsAtReturn = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rowsAtReturn.length, 1, '返回瞬间外部账本必须已完成落账');
      assert.equal(rowsAtReturn[0].inputTokens + rowsAtReturn[0].outputTokens, 120);

      await new Promise((r) => setTimeout(r, 120));
      const rowsLater = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rowsLater.length, 1, '返回后不得再有延迟补写账本');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  rmSync(dir, { recursive: true, force: true });
});

test('L5-PAR-9 [R2-丙1]: 异步无 settle 过期授权在途票结算后必须触发重检，总支出严格 <= 240', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-l5-par-9-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  let upstreamCalls = 0;

  const mockVision = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    const { voteIndex } = parseVoteTag(body);
    upstreamCalls++;
    await new Promise((r) => setTimeout(r, voteIndex === 1 ? 45 : 5));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'vision-stale-allow',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  try {
    const reviewer = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'test-key',
      model: 'vision-stale-allow',
      ledgerPath,
      perspectives: [{ id: 'composition-readability', title: '构图与可读', focus: '构图', votes: 3 }],
      concurrency: 3,
    });

    const ballot2ObservedSpent = [];
    const active = new Map();
    let seq = 0;
    const res = await reviewer.review({
      brief: 'R2 丙1 异步无 settle 过期授权重检',
      images: [],
      film: FILM,
      filmId: FILM.id,
      async budgetCheck({ ballotIndex, spentTokens }) {
        if (ballotIndex === 2) {
          ballot2ObservedSpent.push(spentTokens);
          if (ballot2ObservedSpent.length === 1) {
            // 第 3 票在 spentTokens=120 且第 2 票在途时开始检查，等第 2 票结算完成（inFlight 归零、spentTokens=240）后才返回无 settle 的 true
            await new Promise((r) => setTimeout(r, 90));
            return true;
          }
          return spentTokens + 120 <= 240;
        }
        if (spentTokens + 120 > 240) return false;
        const id = ++seq;
        active.set(id, 1);
        return {
          ok: true,
          settle() { active.delete(id); },
        };
      },
    });

    assert.deepEqual(ballot2ObservedSpent, [120, 240], '过期无 settle 授权必须被 settledSeq 拦截并以最新 spentTokens=240 重检');
    assert.equal(upstreamCalls, 2, '第 3 票重检被拒后严禁发出第 3 次上游调用');
    assert.equal(res.ballots.length, 2);
    assert.equal(res.stoppedReason, 'budget.tokens');
    assert.equal(res.usage.totalTokens, 240);
    assert.ok(res.usage.totalTokens <= 240, `总支出 ${res.usage.totalTokens} 不得超过 240`);
    assert.equal(active.size, 0);

    const extRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(extRows.length, 2);
    assert.equal(extRows.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0), 240);
  } finally {
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L5-PAR-10 [R2-丙2]: 调度抛出冻结 Error 时通过真实 POST /review 保持外部账本与工作区用量均为 240 一致', async (t) => {
  const skip = threeMediaSkip();
  if (skip) return t.skip(skip);

  const dir = mkdtempSync(join(tmpdir(), 'bm-l5-par-10-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  const frozenErr = Object.freeze(Object.assign(new Error('frozen scheduler error'), { code: 'E_FROZEN_SCHED' }));

  const mockVision = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    const { perspective } = parseVoteTag(body);
    if (perspective === 'motion-rhythm') {
      await new Promise((r) => setTimeout(r, 80));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'vision-frozen-err',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'test-key',
    model: 'vision-frozen-err',
    ledgerPath,
    perspectives: [
      { id: 'composition-readability', title: '首票探测', focus: '构图', votes: 1 },
      { id: 'motion-rhythm', title: '在途延迟票', focus: '节奏', votes: 1 },
      {
        id: 'look-consistency',
        votes: 1,
        get title() { throw frozenErr; },
        focus: '触发冻结异常',
      },
    ],
    concurrency: 3,
  });

  const token = issueAccountToken(dir);
  const api = await startServer({ dataDir: dir, port: 0, reviewer });
  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        text: 'R2C2',
        output: { size: [320, 180], fps: '10/1', frames: 6 },
        budget: { tokens: 100_000 },
      }),
    })).json();
    assert.equal(created.ok, true);
    const filmId = created.data.film;
    const wsToken = created.data.token;

    const renderEnv = await (await fetch(`${api.url}/v1/films/${filmId}/render?wait=30`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'draft' }),
    })).json();
    assert.equal(renderEnv.ok, true);
    assert.equal(renderEnv.data.status, 'succeeded');

    const reviewEnv = await (await fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'R2 丙2 冻结异常两本账一致性测试' }),
    })).json();
    assert.equal(reviewEnv.ok, true);
    assert.equal(reviewEnv.data.status, 'failed');
    assert.equal(reviewEnv.data.reason, '视觉审片适配器调用失败');

    const ledgerEnv = await (await fetch(`${api.url}/v1/films/${filmId}/ledger`, {
      headers: { authorization: `Bearer ${wsToken}` },
    })).json();
    const wsTotal = ledgerEnv.data.items.reduce((s, x) => s + (x.modelTokens ?? 0), 0);
    const extRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    const extTotal = extRows.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
    assert.equal(extRows.length, 2);
    assert.equal(extTotal, 240);
    assert.equal(wsTotal, 240, '冻结 Error 包装后工作区账本必须与外部账本完全一致（均为 240）');

    // 验证包装错误保留 cause/code 且兼容不可写 usage 与原始值异常
    const frozenBadArg = Object.freeze(Object.assign(new Error('frozen bad arg'), { code: 'usage.bad-argument' }));
    const reviewerWrap = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'test-key',
      model: 'vision-frozen-err',
      ledgerPath: join(dir, 'wrap-check.jsonl'),
      perspectives: [
        { id: 'composition-readability', title: '正常票', focus: '构图', votes: 1 },
        { id: 'look-consistency', votes: 1, get title() { throw frozenBadArg; }, focus: '冻结带 code 异常' },
      ],
      concurrency: 2,
    });
    await assert.rejects(
      () => reviewerWrap.review({ brief: 'wrap check', images: [], film: FILM, filmId: FILM.id }),
      (err) => err instanceof Error && err.cause === frozenBadArg && err.code === 'usage.bad-argument' && err.usage?.totalTokens === 120,
    );

    const reviewerPrim = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'test-key',
      model: 'vision-frozen-err',
      ledgerPath: join(dir, 'prim-check.jsonl'),
      perspectives: [
        { id: 'composition-readability', title: '正常票', focus: '构图', votes: 1 },
        { id: 'look-consistency', votes: 1, get title() { throw 'primitive-boom'; }, focus: '原始值异常' },
      ],
      concurrency: 2,
    });
    const primL5 = await layerL5({ reviewer: reviewerPrim, brief: 'primitive check', images: [], film: FILM, filmId: FILM.id });
    assert.equal(primL5.status, 'failed');
    assert.equal(primL5.usage?.totalTokens, 120);
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
