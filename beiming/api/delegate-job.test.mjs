// 委托作业的作业记录：落成 jobs 的 job/0.1 记录，重开服务后照样可读、可等、可取消；全程不要显存租约。
// 只经 createStore / createWork / loadQueue 的公开接口，不起 HTTP、不要 FFmpeg 和浏览器。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadQueue } from '../jobs/index.mjs';
import { runDelegateOrchestrator } from './delegate.mjs';
import { createStore } from './store.mjs';
import { createWork } from './work.mjs';

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

// 委托作业不该碰显存调度器：谁来要预算或租约都算错
const noGpu = {
  request() { throw new Error('委托作业申请了显存预算'); },
  acquire() { throw new Error('委托作业申请了显存租约'); },
};

/** 一个临时数据目录；boot() 每次交回全新的 store 和 work，等于重开一次服务 */
function open(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bm-e1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const boot = () => {
    const store = createStore(dir);
    return { store, work: createWork({ store, library: null, reviewer: null, scheduler: noGpu }) };
  };
  return { boot, film: 'f_001' };
}

const types = (job) => job.events.map((e) => e.type).filter((type) => !type.startsWith('step-'));

test('E1-1 委托作业落成 job/0.1 记录：运行中可读，重开服务后终态、事件、结论和账本都在', async (t) => {
  const { boot, film } = open(t);
  const a = boot();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const job = a.work.submitDelegate(film, async () => {
    await gate;
    return { status: 'stopped', stoppedReason: 'tokens', stoppedAt: 'director:step-2', bestRev: 0, cost: { tokens: 7 }, outputs: [] };
  });
  // 换一个队列实例读盘：记录要过 jobs 自己的格式校验
  const onDisk = () => loadQueue(a.store.filmDir(film)).getJob(job);

  const live = onDisk();
  assert.equal(live.format, 'job/0.1');
  assert.equal(live.status, 'running');
  assert.equal(live.handler, 'delegate');
  assert.deepEqual(types(live), ['queued', 'running']);
  const running = a.work.view(film, job);
  assert.equal(running.terminal, false);
  assert.equal(running.outcome, null);
  assert.equal(running.base.stage, 'orchestrate');

  release();
  await a.work.wait(film, job, 5);
  assert.deepEqual(types(onDisk()), ['queued', 'running', 'stopped']);
  assert.deepEqual(onDisk().events.map((e) => e.seq), onDisk().events.map((_, i) => i + 1));

  const b = boot();
  const { terminal, base, outcome } = b.work.view(film, job);
  assert.equal(terminal, true);
  assert.equal(base.status, 'stopped');
  assert.equal(base.verb, 'delegate');
  assert.equal(base.stage, null);
  assert.deepEqual(base.events.at(-1), { seq: base.events.at(-1).seq, type: 'stopped', reason: 'tokens' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.data.stoppedAt, 'director:step-2');
  assert.equal(outcome.cost.tokens, 7);
  assert.equal(base.cost.gpuSeconds, 0);
  const row = b.store.readLedger(film).find((r) => r.step === 'job.delegate');
  assert.equal(row.job, job);
  assert.equal(row.status, 'stopped');
  assert.equal(row.gpuSeconds, 0);
  // 终态的作业：等立刻回来，取消原样交回
  await b.work.wait(film, job, 30);
  assert.equal(await b.work.cancel(film, job), 'stopped');
});

test('E1-2 succeeded 和 failed 按实落盘：编排报失败、抛异常、交回的不是结论，都收在 failed', async (t) => {
  const { boot, film } = open(t);
  const cases = [
    [async () => ({ status: 'succeeded', bestRev: 0, cost: { tokens: 1 }, outputs: [] }), 'succeeded', true],
    [async () => ({ status: 'failed', failedAt: 'finalizer', cost: {}, outputs: [] }), 'failed', false],
    [async () => { throw new Error('模型端点 https://model.example.invalid/v1 连不上'); }, 'failed', false],
    [async () => undefined, 'failed', false],
    [async () => ({ status: 'weird' }), 'failed', false],
  ];
  for (const [run, status, ok] of cases) {
    const a = boot();
    const job = a.work.submitDelegate(film, run);
    await a.work.wait(film, job, 2);
    const { terminal, base, outcome } = boot().work.view(film, job);
    assert.equal(base.status, status);
    assert.equal(terminal, true);
    assert.equal(outcome.ok, ok);
    assert.doesNotMatch(JSON.stringify(outcome), /model\.example\.invalid/);
  }
  assert.deepEqual(boot().store.readLedger(film).map((r) => r.status), cases.map(([, status]) => status));
});

test('E1-3 取消和关服务都把在跑的委托作业收在 canceled，重开后可读', async (t) => {
  const { boot, film } = open(t);
  const a = boot();
  const hang = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ status: 'canceled', cost: {}, outputs: [] }));
  });
  const one = a.work.submitDelegate(film, hang);
  assert.equal(await a.work.cancel(film, one), 'canceled');
  const two = a.work.submitDelegate(film, hang);
  await a.work.cancelAll();

  const b = boot();
  for (const job of [one, two]) {
    const { terminal, base } = b.work.view(film, job);
    assert.equal(base.status, 'canceled');
    assert.equal(terminal, true);
  }
  assert.deepEqual(b.store.readLedger(film).map((r) => r.status), ['canceled', 'canceled']);
  await b.work.cancelAll();
});

test('E1-4 结论落不了盘也收在 failed，不留未捕获的 rejection', async (t) => {
  const { boot, film } = open(t);
  const a = boot();
  a.store.workspace(film);
  // 占住结论目录的位置，让写 outcome.json 失败
  writeFileSync(join(a.store.filmDir(film), 'deliver', 'j-1'), '占位');
  const job = a.work.submitDelegate(film, async () => ({ status: 'succeeded', cost: {}, outputs: [] }));
  assert.equal(job, 'j-1');
  await a.work.wait(film, job, 2);
  await new Promise((resolve) => setImmediate(resolve));
  const { terminal, base, outcome } = boot().work.view(film, job);
  assert.equal(base.status, 'failed');
  assert.equal(terminal, true);
  assert.equal(outcome, null);
  assert.deepEqual(rejections, []);
});

const toolCall = (id, method, path, body, usage = { prompt_tokens: 100, completion_tokens: 20 }) => ({
  id: `cmpl-${id}`, model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `tc-${id}`, type: 'function', function: { name: 'http_request', arguments: JSON.stringify(body === undefined ? { method, path } : { method, path, body }) } }] } }],
  ...(usage === null ? {} : { usage }),
});

const finishCall = (text = 'done', usage = { prompt_tokens: 80, completion_tokens: 10 }) => ({
  id: 'cmpl-done', model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: text } }],
  ...(usage === null ? {} : { usage }),
});

const opts = (extra = {}) => ({
  baseUrl: 'http://localhost', filmId: 'f_001', workspaceToken: 'ws', accountToken: 'acc',
  brief: '测试委托', endpoint: 'http://localhost/model', apiKey: 'key', directorModel: 'dir', workerModel: 'wrk',
  ...extra,
});

test('E1-5 [P2-1/P2-2] 重启后残留 running 委托作业自动收敛为 stopped(interrupted)，且运行中实时汇报 cost.tokens', async (t) => {
  const { boot, film } = open(t);
  const a = boot();
  let release;
  const gate = new Promise((r) => { release = r; });
  const liveJob = a.work.submitDelegate(film, async ({ onTokens }) => {
    onTokens(1234);
    onTokens(566);
    await gate;
    return { status: 'succeeded', bestRev: 1, cost: { tokens: 1800, gpuSeconds: 0 }, outputs: [] };
  });
  assert.equal(a.work.view(film, liveJob).base.cost.tokens, 1800, '运行中应实时看到累加的 cost.tokens');
  release();
  await a.work.wait(film, liveJob, 2);

  // 模拟进程被杀：a 提交了一个永不结束的委托作业，新实例 b 启动后看不到内存中的 running
  const staleJob = a.work.submitDelegate(film, () => new Promise(() => {}));
  const b = boot();
  const recovered = b.work.view(film, staleJob);
  assert.equal(recovered.terminal, true);
  assert.equal(recovered.base.status, 'stopped');
  assert.equal(recovered.base.stage, null);
  assert.equal(recovered.outcome?.data?.stoppedReason, 'interrupted');
  assert.equal(loadQueue(b.store.filmDir(film)).getJob(staleJob).status, 'stopped');
  assert.equal(await b.work.cancel(film, staleJob), 'stopped');
  const t0 = Date.now();
  await b.work.wait(film, staleJob, 5);
  assert.ok(Date.now() - t0 < 500, '已恢复为终态的作业 wait 应立即返回');
});

test('E2-A 等待子作业期间取消委托，发出 DELETE 取消子作业（杀 M11）', async (t) => {
  const root = '/v1/films/f_001';
  const ac = new AbortController();
  const deleted = [];
  let childStatus = 'running';
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
    if (path === `${root}/film`) return Response.json({ ok: true, data: { rev: 1, film: { shots: [{ id: 's01', in: 0, out: 3 }] } } });
    if (path === `${root}/render`) return Response.json({ ok: true, data: { status: 'queued', job: 'j-child', cost: { gpuSeconds: 0 } } });
    if (path === '/v1/jobs/j-child') {
      if (init.method === 'DELETE') { deleted.push(path); childStatus = 'canceled'; return Response.json({ ok: true, data: { status: 'canceled', job: 'j-child' } }); }
      ac.abort();
      init.signal?.throwIfAborted();
      return Response.json({ ok: true, data: { status: 'running', job: 'j-child' } });
    }
    const { messages } = JSON.parse(init.body);
    return Response.json(messages[0].content.includes('shot-worker') && messages.length === 2
      ? toolCall(1, 'POST', `${root}/render`, {}) : finishCall());
  });
  const res = await runDelegateOrchestrator(opts({ signal: ac.signal }));
  assert.equal(res.status, 'canceled');
  assert.deepEqual(deleted, ['/v1/jobs/j-child']);
  assert.equal(childStatus, 'canceled');
});

test('E2-B [P1-1] POST 子作业在途瞬间取消，不中断建作业响应且立即 DELETE 子作业、零孤儿', async (t) => {
  const root = '/v1/films/f_001';
  const ac = new AbortController();
  const deleted = [];
  let postSignalAborted = false;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
    if (path === `${root}/film`) return Response.json({ ok: true, data: { rev: 1, film: { shots: [{ id: 's01', in: 0, out: 3 }] } } });
    if (path === `${root}/render`) {
      // 模拟服务端受理期间父取消信号到达：POST 自身不应被父信号直接掐断，从而能拿到作业号并清理
      ac.abort();
      await new Promise((r) => setTimeout(r, 15));
      postSignalAborted = Boolean(init.signal?.aborted);
      return Response.json({ ok: true, data: { status: 'queued', job: 'j-inflight', cost: { gpuSeconds: 0 } } });
    }
    if (path === '/v1/jobs/j-inflight' && init.method === 'DELETE') {
      deleted.push(path);
      return Response.json({ ok: true, data: { status: 'canceled', job: 'j-inflight' } });
    }
    const { messages } = JSON.parse(init.body);
    return Response.json(messages[0].content.includes('shot-worker') && messages.length === 2
      ? toolCall(1, 'POST', `${root}/render`, {}) : finishCall());
  });
  const res = await runDelegateOrchestrator(opts({ signal: ac.signal }));
  assert.equal(postSignalAborted, false, '创建子作业的 POST 不应绑定父取消信号');
  assert.equal(res.status, 'canceled');
  assert.deepEqual(deleted, ['/v1/jobs/j-inflight']);
});

test('E2-C 等待子作业期间触发 wallSeconds 与 gpuSeconds 超预算，均 stopped 并 DELETE 子作业（杀 M19/M11/M5）', async (t) => {
  const root = '/v1/films/f_001';
  // 1) wallSeconds 超预算
  {
    const deleted = [];
    let polls = 0;
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
      if (path === `${root}/film`) return Response.json({ ok: true, data: { rev: 1, film: { shots: [{ id: 's01', in: 0, out: 3 }] } } });
      if (path === `${root}/render`) return Response.json({ ok: true, data: { status: 'queued', job: 'j-wall', cost: { gpuSeconds: 0 } } });
      if (path === '/v1/jobs/j-wall') {
        if (init.method === 'DELETE') { deleted.push(path); return Response.json({ ok: true, data: { status: 'canceled', job: 'j-wall' } }); }
        polls++;
        await new Promise((r) => setTimeout(r, 1100));
        return Response.json({ ok: true, data: { status: 'running', job: 'j-wall', cost: { gpuSeconds: 0 } } });
      }
      const { messages } = JSON.parse(init.body);
      return Response.json(messages[0].content.includes('shot-worker') && messages.length === 2
        ? toolCall(1, 'POST', `${root}/render`, {}) : finishCall());
    });
    const res = await runDelegateOrchestrator(opts({ budget: { wallSeconds: 1 } }));
    assert.equal(res.status, 'stopped');
    assert.equal(res.stoppedReason, 'wallSeconds');
    assert.equal(polls, 1);
    assert.deepEqual(deleted, ['/v1/jobs/j-wall']);
  }
  // 2) gpuSeconds 超预算（账本在轮询期间超限）
  {
    const deleted = [];
    let polls = 0;
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: polls > 0 ? [{ gpuSeconds: 12 }] : [] } });
      if (path === `${root}/film`) return Response.json({ ok: true, data: { rev: 1, film: { shots: [{ id: 's01', in: 0, out: 3 }] } } });
      if (path === `${root}/render`) return Response.json({ ok: true, data: { status: 'queued', job: 'j-gpu', cost: { gpuSeconds: 0 } } });
      if (path === '/v1/jobs/j-gpu') {
        if (init.method === 'DELETE') { deleted.push(path); return Response.json({ ok: true, data: { status: 'canceled', job: 'j-gpu' } }); }
        polls++;
        return Response.json({ ok: true, data: { status: 'running', job: 'j-gpu', cost: { gpuSeconds: 0 } } });
      }
      const { messages } = JSON.parse(init.body);
      return Response.json(messages[0].content.includes('shot-worker') && messages.length === 2
        ? toolCall(1, 'POST', `${root}/render`, {}) : finishCall());
    });
    const res = await runDelegateOrchestrator(opts({ budget: { gpuSeconds: 10 } }));
    assert.equal(res.status, 'stopped');
    assert.equal(res.stoppedReason, 'gpuSeconds');
    assert.deepEqual(deleted, ['/v1/jobs/j-gpu']);
  }
});

test('E2-D inScope 越权拦截：建新片、跨片、路径穿越与直调作业动词全部 refused 且不发后端（杀 M8）', async (t) => {
  const root = '/v1/films/f_001';
  const attempts = [
    ['POST', '/v1/films', { mode: 'delegate', brief: '套娃' }],
    ['GET', '/v1/films/f_999/film'],
    ['GET', '/v1/films/f_001/../f_999/film'],
    ['GET', '/v1/films/f_001/%2e%2e/f_999/film'],
    ['GET', '/v1/jobs/j-1'],
    ['DELETE', '/v1/jobs/j-1'],
    ['GET', '//evil.example/v1/x'],
  ];
  const leaked = [];
  let toolReplies = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
    if (path === `${root}/film`) return Response.json({ ok: true, data: { rev: 1, film: { shots: [] } } });
    if (path === `${root}/deliver`) {
      return Response.json({ ok: true, data: { status: 'succeeded', rev: 1 }, outputs: Array.from({ length: 6 }, (_, i) => ({ kind: 'file', url: `${root}/artifacts/${i}` })) });
    }
    if (path !== '/model/chat/completions') {
      leaked.push(`${init.method ?? 'GET'} ${path}`);
      return Response.json({ ok: false }, { status: 403 });
    }
    const { messages } = JSON.parse(init.body);
    if (!messages[0].content.includes('director')) return Response.json(finishCall());
    const tm = messages.filter((m) => m.role === 'tool');
    toolReplies = tm.map((m) => JSON.parse(m.content));
    if (tm.length < attempts.length) return Response.json(toolCall(tm.length + 1, ...attempts[tm.length]));
    return Response.json(finishCall());
  });
  await runDelegateOrchestrator(opts({ maxSteps: 12 }));
  assert.deepEqual(leaked, [], '越权请求不得触达后端');
  assert.equal(toolReplies.length, attempts.length);
  for (let i = 0; i < attempts.length; i++) {
    assert.ok(toolReplies[i].refused, `越权尝试 #${i + 1} (${attempts[i][0]} ${attempts[i][1]}) 必须返回 refused`);
  }
});

test('E2-E shot-worker 强制本镜头 draft，且仅允许修改本镜头 patch/0.1（杀 M23）', async (t) => {
  const root = '/v1/films/f_001';
  let renderBody = null;
  let ownPatchSent = false;
  let crossPatchReply = null;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
    if (path === `${root}/film` && (init.method ?? 'GET') === 'GET') {
      return Response.json({ ok: true, data: { rev: ownPatchSent ? 2 : 1, film: { shots: [{ id: 's01', in: 0, out: 3 }] } } });
    }
    if (path === `${root}/film` && init.method === 'PUT') {
      ownPatchSent = true;
      return Response.json({ ok: true, data: { rev: 2 } });
    }
    if (path === `${root}/render`) {
      renderBody = JSON.parse(init.body);
      return Response.json({ ok: true, data: { status: 'succeeded', rev: 2 } });
    }
    if (path === `${root}/verify`) return Response.json({ ok: true, data: { status: 'succeeded', rev: 2 } });
    if (path === `${root}/deliver`) {
      return Response.json({ ok: true, data: { status: 'succeeded', rev: 2 }, outputs: Array.from({ length: 6 }, (_, i) => ({ kind: 'file', url: `${root}/artifacts/${i}` })) });
    }
    const { messages } = JSON.parse(init.body);
    if (!messages[0].content.includes('shot-worker')) return Response.json(finishCall());
    const tm = messages.filter((m) => m.role === 'tool');
    if (tm.length === 0) return Response.json(toolCall(1, 'PUT', `${root}/film`, { format: 'patch/0.1', rev: 1, ops: [{ op: 'set', path: 'shots/s99/cards/t/params/text', value: 'BAD' }] }));
    if (tm.length === 1) {
      crossPatchReply = JSON.parse(tm[0].content);
      return Response.json(toolCall(2, 'PUT', `${root}/film`, { format: 'patch/0.1', rev: 1, ops: [{ op: 'set', path: 'shots/s01/cards/t/params/text', value: 'OK' }] }));
    }
    if (tm.length === 2) return Response.json(toolCall(3, 'POST', `${root}/render`, { shots: ['s99'], tier: 'final' }));
    if (tm.length === 3) return Response.json(toolCall(4, 'POST', `${root}/verify`, { shots: ['s99'], tier: 'final' }));
    return Response.json(finishCall());
  });
  const res = await runDelegateOrchestrator(opts());
  assert.equal(res.status, 'succeeded');
  assert.ok(crossPatchReply?.refused, '跨镜头补丁必须被拒绝');
  assert.equal(ownPatchSent, true, '本镜头 patch/0.1 应被放行');
  assert.deepEqual(renderBody?.shots, ['s01'], 'shot-worker 的 render 必须强制绑定本镜头');
  assert.equal(renderBody?.tier, 'draft', 'shot-worker 的 render 必须强制 draft 档');
});

test('E2-F 缺 usage 拒判 failed、交付不足六件/修订不符判 failed、120万直调硬钳制与小预算首步放行（杀 M18/M15/M4）', async (t) => {
  const root = '/v1/films/f_001';
  // 1) 缺 usage（杀 M18）
  {
    t.mock.method(globalThis, 'fetch', async (url) => {
      const path = new URL(url).pathname;
      if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
      return Response.json(finishCall('ok', null));
    });
    const res = await runDelegateOrchestrator(opts());
    assert.equal(res.status, 'failed');
  }
  // 2) 交付不足 6 件（杀 M15）
  {
    t.mock.method(globalThis, 'fetch', async (url) => {
      const path = new URL(url).pathname;
      if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
      if (path === `${root}/film`) return Response.json({ ok: true, data: { rev: 1, film: { shots: [] } } });
      if (path === `${root}/deliver`) return Response.json({ ok: true, data: { status: 'succeeded', rev: 1 }, outputs: [{ kind: 'file', url: `${root}/artifacts/0` }] });
      return Response.json(finishCall());
    });
    const res = await runDelegateOrchestrator(opts());
    assert.equal(res.status, 'failed');
  }
  // 3) 直调超过 120 万被硬钳制在 120 万（杀 M4）
  {
    const paths = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      paths.push(new URL(url).pathname);
      return Response.json({ ok: true, data: { items: [{ gpuSeconds: 0, modelTokens: 1_190_000 }] } });
    });
    const res = await runDelegateOrchestrator(opts({ budget: { tokens: 5_000_000 } }));
    assert.deepEqual(paths, [`${root}/ledger`]);
    assert.equal(res.status, 'stopped');
    assert.equal(res.stoppedReason, 'tokens');
  }
  // 4) 小预算（5000 < 默认 20000 预留）也能合法跑第 1 步
  {
    let modelCalls = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
      const path = new URL(url).pathname;
      if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
      if (path === `${root}/film`) return Response.json({ ok: true, data: { rev: 1, film: { shots: [] } } });
      if (path === `${root}/deliver`) return Response.json({ ok: true, data: { status: 'succeeded', rev: 1 }, outputs: Array.from({ length: 6 }, (_, i) => ({ kind: 'file', url: `${root}/artifacts/${i}` })) });
      modelCalls++;
      return Response.json(finishCall('ok', { prompt_tokens: 100, completion_tokens: 20 }));
    });
    const res = await runDelegateOrchestrator(opts({ budget: { tokens: 5_000 } }));
    assert.ok(modelCalls >= 1, '小预算 5000 应能合法执行第 1 步');
    assert.equal(res.status, 'stopped');
    assert.equal(res.stoppedReason, 'tokens');
  }
});
