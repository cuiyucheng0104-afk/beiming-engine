// 委托只通过工作区 HTTP 接口操作片子。每个角色单独维护消息，子作业在工具内等到终态。
import { callApi, chat, familyOf, HTTP_TOOL } from './agents.mjs';

export const DELEGATE_HARD_TOKEN_CAP = 1_200_000;
const SYSTEM = {
  director: '你是导演。先 GET /v1/guide，再 GET 片子，照需求用补丁（patch/0.1，带 rev）调片子描述和谓词；改完用一段话说明。',
  'shot-worker': '你是镜头工。为指定镜头 POST render（tier draft）出草稿，再 POST verify 核验。工具会等到终态。通过后汇报。',
  finalizer: '你是收尾。POST deliver（tier final）出六件套。工具会等到终态，交付完汇报。',
};

/** 模型的账户级查询只开放素材、卡和契约。片子的写入与作业等待绑定到本次工作区。 */
function inScope(method, pathname, root) {
  return pathname.startsWith(`${root}/`) ||
    (method === 'GET' && (pathname === '/v1/guide' || /^\/v1\/(cards|schema)\/[^/]+$/.test(pathname))) ||
    (method === 'POST' && ['/v1/cards/search', '/v1/assets/search'].includes(pathname));
}

/** 运行一次委托，交回终态、最后修订、累计成本以及已经验证过的交付产物。 */
export async function runDelegateOrchestrator({
  baseUrl, accountToken, filmId, workspaceToken, brief, assets = [], budget = {}, endpoint, apiKey, directorModel, workerModel,
  reserveTokens = 20_000, maxSteps = 12, signal, onUsage,
}) {
  if (!endpoint || !apiKey || !directorModel || !workerModel) throw new TypeError('委托模式缺模型配置');
  if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 1 || !Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new RangeError('reserveTokens 和 maxSteps 必须是正整数');
  }
  if (!budget || !['tokens', 'gpuSeconds', 'wallSeconds'].every(k => budget[k] === undefined || (Number.isSafeInteger(budget[k]) && budget[k] > 0))) {
    throw new RangeError('预算必须是正整数');
  }
  const maxTokens = Math.min(budget.tokens ?? DELEGATE_HARD_TOKEN_CAP, DELEGATE_HARD_TOKEN_CAP);
  const root = `/v1/films/${filmId}`;
  const api = { baseUrl, account: accountToken ?? workspaceToken, workspaces: { [filmId]: workspaceToken }, jobs: {}, signal };
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  let usedTokens = 0, serverTokens = 0, gpuSeconds = 0, liveGpu = 0, bestRev = 1, deliveredRev = null, outputs = [];
  let at = 'director:step-1', child = null, stoppedReason;
  const result = (status, extra = {}) => ({ status, ...extra, bestRev, delegateTokens: usedTokens, cost: { tokens: usedTokens + serverTokens, gpuSeconds, wallMs: elapsed() }, outputs });
  const http = async (method, path, client = api) => JSON.parse((await callApi(client, { method, path })).text).body;
  async function full(env) {
    const ref = env?.outputs?.find(o => o.kind === 'response');
    return ref ? http('GET', ref.url) : env;
  }
  async function readLedger() {
    const env = await full(await http('GET', `/v1/films/${filmId}/ledger`));
    if (!env?.ok || !Array.isArray(env.data?.items)) throw new Error('读不到工作区账本');
    serverTokens = env.data.items.reduce((n, row) => n + (row.modelTokens ?? 0), 0);
    gpuSeconds = Math.round(env.data.items.reduce((n, row) => n + (row.gpuSeconds ?? 0), 0) * 1000) / 1000;
  }
  async function readFilm() {
    const env = await full(await http('GET', `${root}/film`));
    if (!env?.ok || !Number.isSafeInteger(env.data?.rev) || !Array.isArray(env.data?.film?.shots)) throw new Error('读不到片子的镜头清单');
    bestRev = env.data.rev;
    return env.data.film;
  }
  function stop(reason) {
    stoppedReason = reason;
    throw new Error(reason);
  }
  const delivered = () => outputs.length === 6 && deliveredRev === bestRev;
  function checkBudget(reserve = 0) {
    signal?.throwIfAborted();
    if (usedTokens + serverTokens + reserve > maxTokens) stop('tokens');
    if (elapsed() >= budget.wallSeconds * 1000) stop('wallSeconds');
    if (gpuSeconds + liveGpu >= budget.gpuSeconds) stop('gpuSeconds');
  }

  async function tool(args, role, shot, evidence) {
    checkBudget();
    const method = String(args.method).toUpperCase();
    if (typeof args.path !== 'string' || !args.path.startsWith('/v1/')) return JSON.stringify({ refused: '需要本服务的 /v1/ 路径' });
    const target = new URL(args.path, baseUrl);
    if (!inScope(method, target.pathname, root)) return JSON.stringify({ refused: '该动词不在本片的委托范围内' });
    const verb = target.pathname.slice(root.length + 1);
    const isJob = method === 'POST' && ['render', 'verify', 'deliver'].includes(verb);
    if (target.pathname.startsWith(`${root}/`) && method !== 'GET') {
      const allowed = (role === 'director' && method === 'PUT' && verb === 'film') ||
        (role === 'shot-worker' && method === 'POST' && ['observe/query', 'observe/sheet', 'render', 'verify'].includes(verb)) ||
        (role === 'finalizer' && method === 'POST' && verb === 'deliver');
      if (!allowed) return JSON.stringify({ refused: '该动词不属于当前角色' });
    }
    if (isJob) {
      // 先拿到作业号，才能在取消或预算到期时终止自己提交的子作业。
      target.searchParams.delete('wait');
      args = { ...args, path: target.pathname + target.search, body: { ...args.body, wait: 0 } };
      if (verb === 'deliver') Object.assign(args.body, { tier: 'final', deferReview: true });
      if (shot) Object.assign(args.body, { shots: [shot.id], tier: 'draft' });
    }
    let res = await callApi(api, args);
    let env = JSON.parse(res.text).body;
    if (isJob) {
      while (['queued', 'running'].includes(env?.data?.status)) {
        child = env.data.job;
        if (!child) throw new Error('子作业没有交回编号');
        // 子作业跑完才入账；先读账本再轮询，在跑作业的实时显卡秒就不会和账本重复计。
        liveGpu = env.data.cost?.gpuSeconds ?? 0;
        checkBudget();
        const remaining = budget.wallSeconds === undefined ? 30 : Math.max(1, Math.ceil(budget.wallSeconds - elapsed() / 1000));
        await readLedger();
        res = await callApi(api, { method: 'GET', path: `/v1/jobs/${child}?wait=${Math.min(30, remaining)}` });
        env = JSON.parse(res.text).body;
      }
      if (child) await readLedger();
      child = null;
      liveGpu = 0;
    }
    if (env?.ok && Number.isSafeInteger(env.data?.rev)) bestRev = Math.max(bestRev, env.data.rev);
    if (isJob && env?.ok && env.data?.status === 'succeeded') {
      const complete = await full(env);
      if (verb === 'deliver') {
        outputs = complete.outputs;
        deliveredRev = complete.data.rev;
      } else if (evidence) {
        evidence[verb] = complete.data.rev;
      }
    }
    return res.text;
  }

  async function session(role, shot) {
    const tag = shot ? `shot-worker:${shot.id}` : role;
    const model = role === 'director' ? directorModel : workerModel;
    const task = [`片子 ${filmId}`, `需求：${brief}`, ...(assets.length ? [`素材引用：${JSON.stringify(assets)}`] : []),
      ...(shot ? [`镜头 ${shot.id}（帧 ${shot.in}–${shot.out}）`] : [])].join('\n');
    const messages = [{ role: 'system', content: `[ROLE:${tag}]\n${SYSTEM[role]}` }, { role: 'user', content: task }];
    const evidence = {};
    for (let step = 1; step <= maxSteps; step++) {
      at = `${tag}:step-${step}`;
      // 六件套已交到最新修订，不再为汇报调模型，免得预算触线把已交付的片子收成 stopped。
      if (role === 'finalizer' && delivered()) return true;
      await readLedger();
      checkBudget(reserveTokens);
      const body = { model, messages, tools: [HTTP_TOOL], tool_choice: 'auto' };
      // 以 UTF-8 字节为保守的输入界，预留消息封装开销；服务商同时限制输出，单次请求不能借用下一步预算。
      const inputBound = Buffer.byteLength(JSON.stringify(body)) + 256 + 16 * messages.length;
      body.max_tokens = Math.min(reserveTokens, maxTokens - usedTokens - serverTokens - inputBound);
      if (body.max_tokens < 1) stop('tokens');
      const remainingMs = budget.wallSeconds * 1000 - elapsed();
      const deadline = Number.isFinite(remainingMs) && remainingMs < 120_000 ? AbortSignal.timeout(Math.max(1, remainingMs)) : null;
      let res;
      try {
        res = await chat({ endpoint, apiKey, signal: deadline && signal ? AbortSignal.any([signal, deadline]) : deadline ?? signal, body, requireUsage: true });
      } catch (e) {
        if (deadline?.aborted && !signal?.aborted) stop('wallSeconds');
        throw e;
      }
      usedTokens += res.usage.inputTokens + res.usage.outputTokens;
      onUsage?.({ role: tag, step, model: res.model, family: familyOf(res.model), ...res.usage });
      checkBudget();
      const calls = res.message.tool_calls ?? [];
      if (!calls.length) return !shot || (evidence.render === bestRev && evidence.verify === bestRev);
      messages.push({ role: 'assistant', content: res.message.content ?? null, tool_calls: calls });
      for (const tc of calls) {
        let args;
        try { args = JSON.parse(tc.function?.arguments); } catch { /* 把参数错误交回模型修正 */ }
        const content = tc.function?.name === 'http_request' && args && typeof args === 'object'
          ? await tool(args, role, shot, evidence) : JSON.stringify({ refused: 'http_request 需要 JSON 对象参数' });
        messages.push({ role: 'tool', tool_call_id: tc.id, content });
      }
    }
    await readLedger();
    checkBudget(reserveTokens);
    return false;
  }

  try {
    if (!await session('director')) return result('failed', { failedAt: at });
    const film = await readFilm();
    for (const shot of film.shots) {
      if (!await session('shot-worker', shot) && !await session('shot-worker', shot)) return result('failed', { failedAt: `shot-worker:${shot.id}` });
    }
    if (deliveredRev !== bestRev) {
      if (!await session('finalizer')) return result('failed', { failedAt: at });
      await readFilm();
      if (deliveredRev !== bestRev) {
        await readLedger();
        await tool({ method: 'POST', path: `${root}/deliver`, body: { tier: 'final' } }, 'finalizer');
      }
    }
    await readFilm();
    await readLedger();
    return delivered() ? result('succeeded') : result('failed', { failedAt: at });
  } catch (e) {
    if (child) {
      // 取消信号可能已触发，清理请求需要自己的信号。
      await http('DELETE', `/v1/jobs/${child}`, { ...api, signal: AbortSignal.timeout(30_000) }).catch(() => {});
      if (!signal?.aborted) await readLedger().catch(() => {});
    }
    if (signal?.aborted) return result('canceled');
    if (stoppedReason) return delivered() ? result('succeeded') : result('stopped', { stoppedReason, stoppedAt: at });
    return result('failed', { failedAt: at, message: e.message });
  }
}
