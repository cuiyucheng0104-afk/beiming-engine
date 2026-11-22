import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tools, verifyDeliveryBundle } from '../comp/index.mjs';
import { issueAccountToken, openApiText, startServer } from './index.mjs';
import * as apiIndex from './index.mjs';

function threeMediaSkip() {
  const { ffmpeg, ffprobe } = tools();
  for (const [name, bin, args] of [['ffmpeg', ffmpeg, ['-version']], ['ffprobe', ffprobe, ['-version']]]) {
    if (!bin || spawnSync(bin, args, { stdio: 'ignore', timeout: 20000 }).status !== 0) return `缺少可执行的 ${name}`;
  }
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  if (spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 30000 }).status !== 0) return '无头浏览器不可执行';
  return false;
}

async function startMockModelServer(handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const idx = calls.length + 1;
    calls.push({ idx, url: req.url, body });
    const reply = await handler(body, idx, calls);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(reply.json));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function toolReply(model, id, method, path, body, usage = { prompt_tokens: 1200, completion_tokens: 150 }) {
  return {
    json: {
      id: `cmpl-${id}`,
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `tc-${id}`,
            type: 'function',
            function: { name: 'http_request', arguments: JSON.stringify(body === undefined ? { method, path } : { method, path, body }) },
          }],
        },
      }],
      usage,
    },
  };
}

function doneReply(model, text, usage = { prompt_tokens: 800, completion_tokens: 120 }) {
  return {
    json: {
      id: 'cmpl-done',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text } }],
      usage,
    },
  };
}

test('A12-1 纯 HTTP 零后门守卫：delegate.mjs 不导入内部状态模块、不直接读写工作区文件', () => {
  const delegateFile = new URL('./delegate.mjs', import.meta.url);
  assert.ok(existsSync(delegateFile), '缺少 beiming/api/delegate.mjs');
  assert.equal(apiIndex.DELEGATE_HARD_TOKEN_CAP, 1_200_000);
  assert.equal(typeof apiIndex.runDelegateOrchestrator, 'function');

  const src = readFileSync(delegateFile, 'utf8');
  assert.deepEqual(Array.from(src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), m => m[1]), ['./agents.mjs']);
  assert.doesNotMatch(src, /\b(?:require\s*\(|import\s*(?:\(|['"])|process\s*\.\s*getBuiltinModule)/);
  const forbiddenImports = [
    /\bfrom\s+['"]\.\/(?:store|work|films|pipeline|server|runtime)\.mjs['"]/,
    /\bfrom\s+['"]\.\.\/(?:jobs|sources|comp|verify|observe|cards|kernel)/,
    /\b(?:readFileSync|writeFileSync|cpSync|rmSync|readdirSync)\s*\(/,
  ];
  for (const pat of forbiddenImports) {
    assert.equal(pat.test(src), false, `delegate.mjs 命中禁止的后门调用模式: ${pat}`);
  }
  assert.match(src, /\/v1\/films\/\$\{[^}]+\}\/ledger/, 'delegate.mjs 必须通过 HTTP GET /v1/films/{id}/ledger 预检账本');
});

test('A12-2 合同与入参校验：mode=delegate 必填 brief，budget.tokens 硬上限 120 万，openapi.json 字节同步', async () => {
  assert.deepEqual(readFileSync(new URL('./openapi.json', import.meta.url)), Buffer.from(openApiText()));
  const dir = mkdtempSync(join(tmpdir(), 'bm-a12-contract-'));
  const token = issueAccountToken(dir);
  const api = await startServer({ dataDir: dir, port: 0, reviewer: null });
  try {
    // 缺 brief 被拒
    const missingBrief = await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'delegate' }),
    });
    assert.equal(missingBrief.status, 400);
    const e1 = await missingBrief.json();
    assert.equal(e1.ok, false);
    assert.equal(e1.error.code, 'usage.bad-argument');

    // 超 120 万硬上限被拒
    const overCap = await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'delegate', brief: '10 秒片名测试', budget: { tokens: 1_200_001 } }),
    });
    assert.equal(overCap.status, 400);
    const e2 = await overCap.json();
    assert.equal(e2.ok, false);
    assert.equal(e2.error.code, 'usage.bad-argument');
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A12-3 预算硬停：设 20 万 token 预算时每次调模型前查账本，超限不调模型并以 status=stopped 报停在哪一步与 bestRev', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-a12-budget-'));
  const mock = await startMockModelServer(async (body, idx) => {
    const sys = String(body.messages?.[0]?.content ?? '');
    assert.ok(sys.length > 0);
    // 第 1 次导演调用：打一个合法补丁把 rev 推到 2，消耗 185,000 token（下次预留 25,000 -> 185k + 25k = 210k > 200k）
    if (idx === 1) {
      const userText = JSON.stringify(body.messages);
      const filmId = /f_\d{3}/.exec(userText)?.[0] ?? 'f_001';
      return toolReply(
        body.model,
        idx,
        'PUT',
        `/v1/films/${filmId}/film`,
        { format: 'patch/0.1', rev: 1, ops: [{ op: 'set', path: 'title', value: 'BUDGET STOP TEST' }] },
        { prompt_tokens: 180_000, completion_tokens: 5_000 },
      );
    }
    throw new Error(`超预算后不应发生第 ${idx} 次模型调用`);
  });

  const token = issueAccountToken(dir);
  const api = await startServer({
    dataDir: dir,
    port: 0,
    reviewer: null,
    delegate: {
      endpoint: mock.endpoint,
      apiKey: 'mock-key',
      directorModel: 'claude-opus-5-5',
      workerModel: 'claude-sonnet-5-5',
      reserveTokens: 25_000,
    },
  });
  try {
    const createRes = await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'delegate',
        brief: '一条 2 秒片名测试片 RTX 5090',
        assets: ['asset:poster@1'],
        output: { size: [320, 180], fps: '10/1', frames: 10 },
        budget: { tokens: 200_000, gpuSeconds: 300, wallSeconds: 300 },
      }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.equal(created.ok, true);
    assert.ok(created.data.job, '委托模式 POST /v1/films 必须返回 job 编号');
    const { film: filmId, job: jobId, token: wsToken } = created.data;

    const jobRes = await fetch(`${api.url}/v1/jobs/${jobId}?wait=30`, {
      headers: { authorization: `Bearer ${wsToken}` },
    });
    assert.equal(jobRes.status, 200);
    const jobEnv = await jobRes.json();
    assert.equal(jobEnv.data.status, 'stopped');
    assert.equal(mock.calls.length, 1, '第 2 次模型调用前查账本超预算，必须精确停在第 1 次调用之后');
    assert.ok(jobEnv.data.cost.tokens <= 200_000, `实际花费 ${jobEnv.data.cost.tokens} 必须在 20 万预算内`);
    assert.equal(jobEnv.data.cost.tokens, 185_000);
    assert.equal(jobEnv.data.stoppedAt, 'director:step-2');
    assert.equal(jobEnv.data.stoppedReason, 'tokens');
    assert.match(JSON.stringify(mock.calls[0].body.messages), /asset:poster@1/);
    assert.ok(mock.calls[0].body.max_tokens <= 25_000);
    assert.equal(typeof jobEnv.data.stoppedAt, 'string');
    assert.ok(jobEnv.data.stoppedAt.length > 0, '必须报出停在哪一步 stoppedAt');
    assert.equal(jobEnv.data.bestRev, 2, '必须报出已提交的最好修订号 bestRev');

    // 核对工作区账本确实有 GET ledger 预检记录以及 job.delegate stopped 账目
    const ledgerEnv = await (await fetch(`${api.url}/v1/films/${filmId}/ledger`, {
      headers: { authorization: `Bearer ${wsToken}` },
    })).json();
    assert.equal(ledgerEnv.ok, true);
    assert.ok(ledgerEnv.data.items.some((x) => x.step === 'ledger'), '编排器在调模型前必须实际请求过 GET /v1/films/{id}/ledger');
    const delRow = ledgerEnv.data.items.find((x) => x.step === 'job.delegate');
    assert.ok(delRow, '账本必须记下 job.delegate 行');
    assert.equal(delRow.status, 'stopped');
  } finally {
    await api.close();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A12-4 墙钟与显卡秒预算同样触发 stopped 并报停在哪一步', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-a12-wall-'));
  const mock = await startMockModelServer(async (body, idx) => {
    await new Promise((r) => setTimeout(r, 80));
    return doneReply(body.model, `step-${idx}`, { prompt_tokens: 500, completion_tokens: 50 });
  });
  const token = issueAccountToken(dir);
  const api = await startServer({
    dataDir: dir,
    port: 0,
    reviewer: null,
    delegate: {
      endpoint: mock.endpoint,
      apiKey: 'mock-key',
      directorModel: 'claude-opus-5-5',
      workerModel: 'claude-sonnet-5-5',
      reserveTokens: 1_000,
    },
  });
  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'delegate',
        brief: '墙钟超时停止验证',
        output: { size: [320, 180], fps: '10/1', frames: 10 },
        budget: { tokens: 200_000, gpuSeconds: 60, wallSeconds: 0.05 },
      }),
    })).json();
    // 若整数校验要求 wallSeconds >= 1，则测试 1 秒墙钟内慢调用停机
    if (!created.ok) {
      assert.equal(created.error.code, 'usage.bad-argument');
    }
    const slowMock = await startMockModelServer(async (body, idx) => {
      if (idx === 1) {
        await new Promise((r) => setTimeout(r, 1150));
        const filmId = /f_\d{3}/.exec(JSON.stringify(body.messages))?.[0] ?? 'f_001';
        return toolReply(body.model, idx, 'GET', `/v1/films/${filmId}/film`, undefined, { prompt_tokens: 500, completion_tokens: 50 });
      }
      throw new Error('墙钟超限后不应再调第 2 次模型');
    });
    const api2 = await startServer({
      dataDir: dir,
      port: 0,
      reviewer: null,
      delegate: { endpoint: slowMock.endpoint, apiKey: 'mock-key', directorModel: 'claude-opus-5-5', workerModel: 'claude-sonnet-5-5', reserveTokens: 1_000 },
    });
    try {
      const c2 = await (await fetch(`${api2.url}/v1/films`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'delegate',
          brief: '1 秒墙钟预算验证',
          output: { size: [320, 180], fps: '10/1', frames: 10 },
          budget: { tokens: 200_000, gpuSeconds: 60, wallSeconds: 1 },
        }),
      })).json();
      assert.equal(c2.ok, true);
      const j2 = await (await fetch(`${api2.url}/v1/jobs/${c2.data.job}?wait=30`, {
        headers: { authorization: `Bearer ${c2.data.token}` },
      })).json();
      assert.equal(j2.data.status, 'stopped');
      assert.equal(j2.data.stoppedReason, 'wallSeconds');
      assert.ok(j2.data.stoppedAt);
    } finally {
      await api2.close();
      await slowMock.close();
    }
  } finally {
    await api.close();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('直接调用也拒绝无效预算，服务端审片用量计入单片预算', async (t) => {
  const options = { baseUrl: 'http://localhost', filmId: 'f_001', workspaceToken: 'test', endpoint: 'http://localhost/model', apiKey: 'test', directorModel: 'director', workerModel: 'worker' };
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    paths.push(new URL(url).pathname);
    return Response.json({ ok: true, data: { items: [{ gpuSeconds: 0, modelTokens: 195_000 }] } });
  });
  await assert.rejects(apiIndex.runDelegateOrchestrator({ ...options, budget: { tokens: NaN } }), RangeError);
  const r = await apiIndex.runDelegateOrchestrator({ ...options, budget: { tokens: 200_000 } });
  assert.deepEqual(paths, ['/v1/films/f_001/ledger']);
  assert.equal(r.stoppedReason, 'tokens');
  assert.equal(r.cost.tokens, 195_000);
});

test('显卡成本达到上限时第一次模型调用前即停止', async (t) => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    paths.push(new URL(url).pathname);
    return Response.json({ ok: true, data: { items: [{ gpuSeconds: 2 }] } });
  });
  const result = await apiIndex.runDelegateOrchestrator({
    baseUrl: 'http://localhost', filmId: 'f_001', workspaceToken: 'test', budget: { gpuSeconds: 2 },
    endpoint: 'http://localhost/model', apiKey: 'test', directorModel: 'director', workerModel: 'worker',
  });
  assert.deepEqual(paths, ['/v1/films/f_001/ledger']);
  assert.equal(result.status, 'stopped');
  assert.equal(result.stoppedReason, 'gpuSeconds');
  assert.equal(result.stoppedAt, 'director:step-1');
  assert.equal(result.cost.gpuSeconds, 2);
});

test('子作业还没入账时，实时显卡秒超限也会停下并撤掉子作业', async (t) => {
  const root = '/v1/films/f_001';
  const seen = [];
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = new URL(url).pathname;
    seen.push(`${init.method ?? 'GET'} ${path}`);
    if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
    if (path === `${root}/film`) return Response.json({ ok: true, data: { rev: 1, film: { shots: [{ id: 's01', in: 0, out: 3 }] } } });
    if (path === `${root}/render`) return Response.json({ ok: true, data: { status: 'queued', job: 'j1', cost: { gpuSeconds: 0 } } });
    if (path === '/v1/jobs/j1') {
      if (init.method === 'DELETE') return Response.json({ ok: true, data: { status: 'canceled', job: 'j1' } });
      polls++;
      return Response.json({ ok: true, data: { status: polls < 4 ? 'running' : 'succeeded', job: 'j1', rev: 1, cost: { gpuSeconds: 50 * polls } } });
    }
    const { messages } = JSON.parse(init.body);
    return Response.json(messages[0].content.includes('shot-worker') && messages.length === 2
      ? toolReply('test', 1, 'POST', `${root}/render`, {}).json : doneReply('test', '完成').json);
  });
  const result = await apiIndex.runDelegateOrchestrator({
    baseUrl: 'http://localhost', filmId: 'f_001', workspaceToken: 'test', budget: { gpuSeconds: 10 },
    endpoint: 'http://localhost/model', apiKey: 'test', directorModel: 'director', workerModel: 'worker',
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stoppedReason, 'gpuSeconds');
  assert.equal(result.stoppedAt, 'shot-worker:s01:step-1');
  assert.equal(polls, 1, '第一次轮询看到 50 显卡秒就该停');
  assert.ok(seen.includes('DELETE /v1/jobs/j1'));
});

test('收尾交付六件套后预算触线，仍按 succeeded 收尾且不再为汇报调模型', async (t) => {
  const root = '/v1/films/f_001';
  let delivered = false, modelCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: delivered ? [{ gpuSeconds: 0, modelTokens: 199_000 }] : [] } });
    if (path === `${root}/film`) return Response.json({ ok: true, data: { rev: 1, film: { shots: [] } } });
    if (path === `${root}/deliver`) {
      delivered = true;
      return Response.json({ ok: true, data: { status: 'succeeded', rev: 1 }, outputs: Array.from({ length: 6 }, (_, i) => ({ kind: 'file', url: `${root}/artifacts/${i}` })) });
    }
    modelCalls++;
    const { messages } = JSON.parse(init.body);
    return Response.json(messages[0].content.includes('finalizer')
      ? toolReply('test', 1, 'POST', `${root}/deliver`, {}).json : doneReply('test', '完成').json);
  });
  const result = await apiIndex.runDelegateOrchestrator({
    baseUrl: 'http://localhost', filmId: 'f_001', workspaceToken: 'test', budget: { tokens: 200_000 },
    endpoint: 'http://localhost/model', apiKey: 'test', directorModel: 'director', workerModel: 'worker',
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputs.length, 6);
  assert.equal(modelCalls, 2, '导演一次、收尾一次，交付后不再调模型');
});

test('截短信封恢复镜头清单，未过核验的镜头只重试一次', async (t) => {
  const sessions = [];
  const root = '/v1/films/f_001';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    if (path === `${root}/ledger`) return Response.json({ ok: true, data: { items: [] } });
    if (path === `${root}/film`) return Response.json({ ok: true, data: { truncated: true, rev: 3 }, outputs: [{ kind: 'response', url: `${root}/artifacts/full.json` }] });
    if (path === `${root}/artifacts/full.json`) return Response.json({ ok: true, data: { rev: 3, film: { shots: [{ id: 's02', in: 0, out: 3 }] } } });
    assert.equal(path, '/model/chat/completions');
    const { messages } = JSON.parse(init.body);
    const role = messages[0].content.match(/\[ROLE:(.*?)\]/)[1];
    if (messages.length === 2) sessions.push(role);
    if (role.startsWith('shot-worker')) {
      if (messages.length === 2) return Response.json(toolReply('test', 1, 'POST', `${root}/deliver`, {}).json);
      assert.match(messages.at(-1).content, /不属于当前角色/);
    }
    return Response.json(doneReply('test', '完成').json);
  });
  const result = await apiIndex.runDelegateOrchestrator({
    baseUrl: 'http://localhost', filmId: 'f_001', workspaceToken: 'test',
    endpoint: 'http://localhost/model', apiKey: 'test', directorModel: 'director', workerModel: 'worker',
  });
  assert.deepEqual(sessions, ['director', 'shot-worker:s02', 'shot-worker:s02']);
  assert.equal(result.status, 'failed');
  assert.equal(result.failedAt, 'shot-worker:s02');
  assert.equal(result.bestRev, 3);
});

test('A12-5 连续 5 次委托出片不用重启服务（含工具层自动长轮询、三角色衔接与六件套真交付）', async (t) => {
  const skip = threeMediaSkip();
  if (skip) return t.skip(skip);

  const dir = mkdtempSync(join(tmpdir(), 'bm-a12-five-runs-'));
  // 脚本化确定性多角色模型服务：识别 director / shot-worker，驱动真实 HTTP 动词并校验异步作业已由工具层等待完毕
  const mock = await startMockModelServer(async (body, idx) => {
    const allText = JSON.stringify(body.messages);
    const filmId = /f_\d{3}/.exec(allText)?.[0];
    assert.ok(filmId, '提示词里必须带当前工作区 film 编号');
    const roleTag = /\[ROLE:(director|shot-worker|finalizer)([^\]]*)\]/.exec(allText)?.[1] ?? 'director';
    const toolMessages = body.messages.filter((m) => m.role === 'tool');

    if (roleTag === 'director') {
      if (toolMessages.length === 0) {
        return toolReply(body.model, idx, 'GET', '/v1/guide');
      }
      if (toolMessages.length === 1) {
        return toolReply(body.model, idx, 'GET', `/v1/films/${filmId}/film`);
      }
      return doneReply(body.model, `导演已完成 ${filmId} 分镜确认`);
    }

    if (roleTag === 'shot-worker') {
      if (toolMessages.length === 0) {
        return toolReply(body.model, idx, 'POST', `/v1/films/${filmId}/render`, { shots: ['s01'], tier: 'draft' });
      }
      if (toolMessages.length === 1) {
        const lastTool = JSON.parse(toolMessages.at(-1).content);
        assert.equal(lastTool.body?.data?.status, 'succeeded', '工具层必须内聚完成 render 作业等待，不让模型轮询');
        return toolReply(body.model, idx, 'POST', `/v1/films/${filmId}/verify`, { shots: ['s01'], tier: 'draft' });
      }
      const lastVerify = JSON.parse(toolMessages.at(-1).content);
      assert.equal(lastVerify.body?.data?.status, 'succeeded', '工具层必须内聚完成 verify 作业等待');
      return doneReply(body.model, 's01 草稿与核验通过');
    }

    // finalizer 阶段：触发 deliver 并一次性拿到六件套终态
    if (toolMessages.length === 0) {
      return toolReply(body.model, idx, 'POST', `/v1/films/${filmId}/deliver`, { tier: 'final' });
    }
    const lastDeliver = JSON.parse(toolMessages.at(-1).content);
    assert.equal(lastDeliver.body?.data?.status, 'succeeded', '工具层必须内聚完成 deliver 作业等待');
    return doneReply(body.model, `${filmId} 六件套交付完毕`);
  });

  const token = issueAccountToken(dir);
  const api = await startServer({
    dataDir: dir,
    port: 0,
    reviewer: null,
    delegate: {
      endpoint: mock.endpoint,
      apiKey: 'mock-key',
      directorModel: 'claude-opus-5-5',
      workerModel: 'claude-sonnet-5-5',
      reserveTokens: 5_000,
    },
  });

  try {
    for (let i = 1; i <= 5; i++) {
      const createRes = await fetch(`${api.url}/v1/films`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'delegate',
          brief: `第 ${i} 条 1 秒片名短片：显示 RUN ${i}`,
          text: `RUN ${i}`,
          output: { size: [320, 180], fps: '10/1', frames: 6 },
          budget: { tokens: 500_000, gpuSeconds: 300, wallSeconds: 300 },
        }),
      });
      assert.equal(createRes.status, 200, `第 ${i} 次建片失败`);
      const created = await createRes.json();
      assert.equal(created.ok, true);
      const { film: filmId, job: jobId, token: wsToken } = created.data;
      assert.equal(filmId, `f_00${i}`);

      // 等待整条委托作业完成
      let jobEnv;
      for (let w = 0; w < 10; w++) {
        jobEnv = await (await fetch(`${api.url}/v1/jobs/${jobId}?wait=30`, {
          headers: { authorization: `Bearer ${wsToken}` },
        })).json();
        if (['succeeded', 'failed', 'stopped', 'canceled'].includes(jobEnv.data.status)) break;
      }
      assert.equal(jobEnv.data.status, 'succeeded', `第 ${i} 次委托作业未成功: ${JSON.stringify(jobEnv)}`);
      assert.equal(jobEnv.ok, true);
      assert.equal(jobEnv.outputs?.length, 6, `第 ${i} 次委托必须产出六件套 outputs`);

      const deliverJobs = jobEnv.outputs[0].url.split('/artifacts/')[1].split('/')[0];
      const bundleDir = join(dir, 'films', filmId, 'deliver', deliverJobs, 'bundle');
      const verified = verifyDeliveryBundle(bundleDir);
      assert.equal(Object.keys(verified.files).length, 6);
      const report = JSON.parse(readFileSync(join(bundleDir, 'report.json'), 'utf8'));
      assert.equal(report.verification.layers.L1.ok, true);
      assert.equal(report.verification.layers.L2.ok, true);
      assert.equal(report.verification.layers.L3.basePass, true);
      assert.equal(report.verification.layers.L5.status, 'not-run');
      assert.match(report.verification.layers.L5.reason, /推迟/);
    }
  } finally {
    await api.close();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
