// 委托只通过工作区 HTTP 接口操作片子。每个角色单独维护消息，子作业在工具内等到终态。
import { buildShotWorkerMessages, buildToolImageMessage, callApi, chat, DELEGATE_ROLES, estimateChatBodyInputTokens, familyOf, HTTP_TOOL, MODEL_TIMEOUT_MS, normalizeJsonToolBody } from './agents.mjs';

export const DELEGATE_HARD_TOKEN_CAP = 1_200_000;
const SYSTEM = {
  director: DELEGATE_ROLES.director.systemPrompt,
  'shot-worker': DELEGATE_ROLES['shot-worker'].systemPrompt,
  finalizer: '你是收尾。POST deliver（tier final）出六件套。工具会等到终态，交付完汇报。',
};

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 模型的账户级查询只开放素材、卡和契约。片子的写入与作业等待绑定到本次工作区。 */
function inScope(method, pathname, root) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (/(?:^|\/)\.\.(?:\/|$)/.test(decoded)) return false;
  return decoded.startsWith(`${root}/`) ||
    (method === 'GET' && (decoded === '/v1/guide' || /^\/v1\/(cards|schema)\/[^/]+$/.test(decoded))) ||
    (method === 'POST' && ['/v1/cards/search', '/v1/assets/search'].includes(decoded));
}

/** 镜头工修改片子时只允许 patch/0.1 且全部 ops 落在本镜头路径下。 */
function ownShotPatch(body, shotId) {
  if (!body || typeof body !== 'object' || body.format !== 'patch/0.1' || !Array.isArray(body.ops) || !body.ops.length) return false;
  const prefix = `shots/${shotId}/`;
  return body.ops.every(op => op && typeof op === 'object' && typeof op.path === 'string'
    && op.path.startsWith(prefix) && !op.path.split('/').some(s => !s || s === '.' || s === '..')
    && (op.to === undefined || (typeof op.to === 'string' && op.to.length > 0 && !op.to.includes('/'))));
}

/** 运行一次委托，交回终态、最后修订、累计成本以及已经验证过的交付产物。 */
export async function runDelegateOrchestrator({
  baseUrl, accountToken, filmId, workspaceToken, brief, assets = [], budget = {}, endpoint, apiKey, directorModel, workerModel,
  reserveTokens = 20_000, maxSteps = 24, signal, onUsage,
}) {
  if (!endpoint || !apiKey || !directorModel || !workerModel) throw new TypeError('委托模式缺模型配置');
  if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 1 || !Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new RangeError('reserveTokens 和 maxSteps 必须是正整数');
  }
  if (!budget || !['tokens', 'gpuSeconds', 'wallSeconds'].every(k => budget[k] === undefined || (Number.isSafeInteger(budget[k]) && budget[k] > 0))) {
    throw new RangeError('预算必须是正整数');
  }
  const maxTokens = Math.min(budget.tokens ?? DELEGATE_HARD_TOKEN_CAP, DELEGATE_HARD_TOKEN_CAP);
  const stepReserve = Math.min(reserveTokens, maxTokens);
  const root = `/v1/films/${filmId}`;
  const baseOrigin = new URL(baseUrl).origin;
  const api = { baseUrl, account: accountToken ?? workspaceToken, workspaces: { [filmId]: workspaceToken }, jobs: {}, signal };
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  let usedTokens = 0, serverTokens = 0, gpuSeconds = 0, liveGpu = 0, bestRev = 1, deliveredRev = null, outputs = [];
  let at = 'director:step-1', stoppedReason;
  const activeChildren = new Set();
  const discoveredCards = [];
  const skippedRemovedShots = [];
  const result = (status, extra = {}) => ({
    status,
    ...extra,
    bestRev,
    delegateTokens: usedTokens,
    ...(skippedRemovedShots.length ? { skippedRemovedShots } : {}),
    cost: { tokens: usedTokens + serverTokens, gpuSeconds, wallMs: elapsed() },
    outputs,
  });
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
    const refuse = (why) => ({ text: JSON.stringify({ refused: why }) });
    const method = String(args.method).toUpperCase();
    if (typeof args.path !== 'string' || !args.path.startsWith('/v1/')) return refuse('需要本服务的 /v1/ 路径');
    const target = new URL(args.path, baseUrl);
    if (target.origin !== baseOrigin || !inScope(method, target.pathname, root)) return refuse('该动词不在本片的委托范围内');
    const verb = target.pathname.slice(root.length + 1);
    const isJob = method === 'POST' && ['render', 'verify', 'deliver'].includes(verb);
    let body = args.body;
    if (method !== 'GET' && body !== undefined && body !== null) {
      body = normalizeJsonToolBody(target.pathname, body);
      if (body !== args.body) args = { ...args, body };
    }
    if (target.pathname.startsWith(`${root}/`) && method !== 'GET') {
      if (role === 'shot-worker' && method === 'PUT' && verb === 'film') {
        if (!ownShotPatch(body, shot.id)) return refuse(`镜头工只允许用 patch/0.1 修改本镜头 shots/${shot.id}/`);
      } else {
        const allowed = (role === 'director' && method === 'PUT' && verb === 'film') ||
          (role === 'shot-worker' && method === 'POST' && ['observe/query', 'observe/sheet', 'render', 'verify'].includes(verb)) ||
          (role === 'finalizer' && method === 'POST' && verb === 'deliver');
        if (!allowed) return refuse('该动词不属于当前角色');
      }
    }
    if (isJob) {
      if (body !== undefined && !isPlainObject(body)) {
        return refuse(`${verb} 的请求体必须是 JSON 对象`);
      }
      // 先拿到作业号，才能在取消或预算到期时终止自己提交的子作业。
      target.searchParams.delete('wait');
      args = { ...args, path: target.pathname + target.search, body: { ...(body ?? {}), wait: 0 } };
      if (verb === 'deliver') Object.assign(args.body, { tier: 'final' });
      if (shot) Object.assign(args.body, { shots: [shot.id], tier: 'draft' });
    }
    // 创建子作业的 POST（wait=0）用独立短超时信号，防止取消信号在途打断响应导致孤儿子作业。
    let res = await callApi(isJob ? { ...api, signal: AbortSignal.timeout(30_000) } : api, args);
    let env = JSON.parse(res.text).body;
    if (isJob) {
      let waited = false;
      let jobId = null;
      while (['queued', 'running'].includes(env?.data?.status)) {
        jobId = env.data.job;
        if (!jobId) throw new Error('子作业没有交回编号');
        activeChildren.add(jobId);
        waited = true;
        // 子作业跑完才入账；先读账本再轮询，在跑作业的实时显卡秒就不会和账本重复计。
        liveGpu = env.data.cost?.gpuSeconds ?? 0;
        checkBudget();
        const remaining = budget.wallSeconds === undefined ? 30 : Math.max(1, Math.ceil(budget.wallSeconds - elapsed() / 1000));
        await readLedger();
        checkBudget();
        res = await callApi(api, { method: 'GET', path: `/v1/jobs/${jobId}?wait=${Math.min(30, remaining)}` });
        env = JSON.parse(res.text).body;
      }
      if (jobId) activeChildren.delete(jobId);
      if (waited) await readLedger();
      liveGpu = 0;
    }
    if (env?.ok && Number.isSafeInteger(env.data?.rev)) bestRev = Math.max(bestRev, env.data.rev);
    if (env?.ok && target.pathname === '/v1/cards/search' && Array.isArray(env.data?.items)) {
      for (const c of env.data.items) {
        if (c && typeof c === 'object' && !discoveredCards.some(x => x.id === c.id)) discoveredCards.push(c);
      }
    } else if (env?.ok && target.pathname.startsWith('/v1/cards/') && env.data?.card) {
      const c = env.data.card;
      if (c && typeof c === 'object' && !discoveredCards.some(x => x.id === c.id)) discoveredCards.push(c);
    }
    if (isJob && env?.ok && env.data?.status === 'succeeded') {
      const complete = await full(env);
      if (verb === 'deliver') {
        outputs = Array.isArray(complete.outputs) ? complete.outputs : [];
        deliveredRev = complete.data?.rev ?? null;
      } else if (evidence) {
        evidence[verb] = complete.data?.rev;
      }
    }
    return { text: res.text, ...(res.image ? { image: res.image } : {}) };
  }

  async function session(role, shot, currentFilm) {
    const tag = shot ? `shot-worker:${shot.id}` : role;
    const model = role === 'director' ? directorModel : workerModel;
    let messages;
    if (role === 'shot-worker' && shot) {
      const built = buildShotWorkerMessages({
        filmId,
        rev: bestRev,
        brief: brief ?? '',
        assets,
        shot,
        basePredicates: currentFilm?.predicates?.base ?? ['floor@1'],
        extraPredicates: currentFilm?.predicates?.extra ?? [],
        cards: discoveredCards,
        budget: {
          tokens: Math.max(1, maxTokens - usedTokens - serverTokens),
          gpuSeconds: budget.gpuSeconds,
          wallSeconds: budget.wallSeconds,
          maxSteps,
        },
      });
      messages = built.messages;
    } else {
      const task = [`片子 ${filmId}`, `需求：${brief}`, ...(assets.length ? [`素材引用：${JSON.stringify(assets)}`] : []),
        ...(shot ? [`镜头 ${shot.id}（帧 ${shot.in}–${shot.out}）`] : [])].join('\n');
      messages = [{ role: 'system', content: `[ROLE:${tag}]\n${SYSTEM[role]}` }, { role: 'user', content: task }];
    }
    const evidence = {};
    for (let step = 1; step <= maxSteps; step++) {
      at = `${tag}:step-${step}`;
      // 六件套已交到最新修订，不再为汇报调模型，免得预算触线把已交付的片子收成 stopped。
      if (role === 'finalizer' && delivered()) return true;
      await readLedger();
      checkBudget(stepReserve);
      const body = { model, messages, tools: [HTTP_TOOL], tool_choice: 'auto' };
      // 以 UTF-8 字节与图像分辨率上界估算输入预算；服务商同时限制输出，单次请求不能借用下一步预算。
      const inputBound = estimateChatBodyInputTokens(body, model);
      body.max_tokens = Math.min(stepReserve, maxTokens - usedTokens - serverTokens - inputBound);
      if (body.max_tokens < 1) stop('tokens');
      const remainingMs = budget.wallSeconds * 1000 - elapsed();
      const deadline = Number.isFinite(remainingMs) && remainingMs <= MODEL_TIMEOUT_MS
        ? AbortSignal.timeout(Math.max(1, Math.min(remainingMs, MODEL_TIMEOUT_MS - 1)))
        : null;
      let res;
      try {
        res = await chat({ endpoint, apiKey, signal: deadline && signal ? AbortSignal.any([signal, deadline]) : deadline ?? signal, body, requireUsage: true });
      } catch (e) {
        if (e?.usage) {
          const uIn = e.usage.inputTokens ?? 0;
          const uOut = e.usage.outputTokens ?? 0;
          if (uIn > 0 || uOut > 0) {
            const errModel = typeof e.model === 'string' && e.model ? e.model : model;
            usedTokens += uIn + uOut;
            onUsage?.({ role: tag, step, model: errModel, family: familyOf(errModel), inputTokens: uIn, outputTokens: uOut });
          }
        }
        if (deadline?.aborted && !signal?.aborted) stop('wallSeconds');
        throw e;
      }
      usedTokens += res.usage.inputTokens + res.usage.outputTokens;
      onUsage?.({ role: tag, step, model: res.model, family: familyOf(res.model), ...res.usage });
      checkBudget();
      const calls = res.message.tool_calls ?? [];
      if (!calls.length) return !shot || (evidence.render === bestRev && evidence.verify === bestRev);
      messages.push({ role: 'assistant', content: res.message.content ?? null, tool_calls: calls });
      const attachedImages = [];
      for (const tc of calls) {
        let args;
        try { args = JSON.parse(tc.function?.arguments); } catch { /* 把参数错误交回模型修正 */ }
        const out = tc.function?.name === 'http_request' && args && typeof args === 'object'
          ? await tool(args, role, shot, evidence) : { text: JSON.stringify({ refused: 'http_request 需要 JSON 对象参数' }) };
        messages.push({ role: 'tool', tool_call_id: tc.id, content: out.text });
        if (out.image) attachedImages.push(out.image);
      }
      if (attachedImages.length) {
        messages.push(buildToolImageMessage(attachedImages));
      }
    }
    await readLedger();
    checkBudget(stepReserve);
    return false;
  }

  try {
    if (!await session('director')) return result('failed', { failedAt: at });
    let film = await readFilm();
    let filmRev = bestRev;
    const shotIds = film.shots.map((s) => s.id);
    for (const shotId of shotIds) {
      if (bestRev !== filmRev) {
        film = await readFilm();
        filmRev = bestRev;
      }
      let shot = film.shots.find((s) => s.id === shotId);
      if (!shot) {
        skippedRemovedShots.push({ shot: shotId, rev: filmRev });
        continue;
      }
      if (!await session('shot-worker', shot, film)) {
        // 重试前重新读取最新片子与镜头条目，确保第二次任务书拿到最新 rev 与改动后的镜头 JSON；
        // 若最新修订已删除该镜头，不得回退旧镜头继续派工，直接跳过并记入状态。
        film = await readFilm();
        filmRev = bestRev;
        shot = film.shots.find((s) => s.id === shotId);
        if (!shot) {
          skippedRemovedShots.push({ shot: shotId, rev: filmRev });
          continue;
        }
        if (!await session('shot-worker', shot, film)) return result('failed', { failedAt: `shot-worker:${shotId}` });
      }
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
    if (activeChildren.size) {
      // 取消信号可能已触发，清理请求需要自己的信号。
      const cleanup = { ...api, signal: AbortSignal.timeout(30_000) };
      for (const id of [...activeChildren]) {
        await http('DELETE', `/v1/jobs/${id}`, cleanup).catch(() => {});
        activeChildren.delete(id);
      }
      if (!signal?.aborted) await readLedger().catch(() => {});
    }
    if (signal?.aborted) return result('canceled');
    if (stoppedReason) return delivered() ? result('succeeded') : result('stopped', { stoppedReason, stoppedAt: at });
    return result('failed', { failedAt: at, message: e.message });
  }
}
