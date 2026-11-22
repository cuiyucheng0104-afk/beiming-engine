// 委托模式的编排进程：只经 HTTP 调本服务的 /v1/* 动词（不碰数据目录、不导入服务端内部模块），按导演 → 镜头工 → 收尾三段起模型会话。
// 每次调模型前先 GET /v1/films/{id}/ledger 查账：token（本编排已花 + 预留）、墙钟秒、显卡秒任一超了就不调模型，以 stopped 收尾并报停在哪一步。
// render/verify/deliver 交回的异步作业由工具层自己长轮询到终态再交给模型，模型不用逐 30 秒空转轮询。
import { performance } from 'node:perf_hooks';
import { callApi, chat, HTTP_TOOL } from './agents.mjs';

/** 单片 token 硬上限：budget.tokens 给多大都钳在这里 */
export const DELEGATE_HARD_TOKEN_CAP = 1_200_000;
const JOB_VERB = /^\/v1\/films\/[^/]+\/(?:render|verify|deliver)(?:\?|$)/;

const SYSTEM = {
  director: '你是导演。先 GET /v1/guide，再 GET 片子，照需求用补丁（patch/0.1，带 rev）调片子描述和谓词；改完用一段话说明。',
  'shot-worker': '你是镜头工，只管这一个镜头：POST render（tier draft）出草稿，再 POST verify 核验；作业由工具等到终态才交回。过了用一段话汇报。',
  finalizer: '你是收尾。POST deliver（tier final）出六件套，工具会等到终态；交付完用一段话汇报。',
};

/**
 * 跑一次委托出片。baseUrl 本服务地址；accountToken 账户令牌（GET guide 等账户动词用）；filmId 与 workspaceToken 是建片交回的工作区；
 * budget { tokens, gpuSeconds, wallSeconds }；endpoint、apiKey、directorModel、workerModel 是模型接口；reserveTokens 是下一次调用的预留。
 * 交回 { status: succeeded | failed | stopped | canceled, stoppedReason?, stoppedAt?, bestRev, cost: { tokens, gpuSeconds, wallMs }, outputs }。
 */
export async function runDelegateOrchestrator({
  baseUrl, accountToken, filmId, workspaceToken, brief, budget = {}, endpoint, apiKey, directorModel, workerModel,
  reserveTokens = 20_000, maxSteps = 12, signal,
}) {
  if (!endpoint || !apiKey || !directorModel || !workerModel) throw new TypeError('委托模式缺模型配置：endpoint、apiKey、directorModel、workerModel');
  const maxTokens = Math.min(budget.tokens ?? DELEGATE_HARD_TOKEN_CAP, DELEGATE_HARD_TOKEN_CAP);
  const api = { baseUrl, account: accountToken ?? workspaceToken, workspaces: { [filmId]: workspaceToken }, jobs: {}, signal };
  const start = performance.now();
  const st = { tokens: 0, gpuSeconds: 0, bestRev: 1, outputs: [], deliveredRev: null };
  const wallSeconds = () => (performance.now() - start) / 1000;
  const result = (status, extra = {}) => ({ status, ...extra, bestRev: st.bestRev, cost: { tokens: st.tokens, gpuSeconds: st.gpuSeconds, wallMs: Math.round(wallSeconds() * 1000) }, outputs: st.outputs });

  const http = async (method, path) => JSON.parse((await callApi(api, { method, path })).text).body;
  /** 信封被截短时去取 outputs 里挂的全文 */
  const full = async (env) => {
    const ref = env?.outputs?.find((o) => o.kind === 'response');
    return ref ? (await http('GET', ref.url)) ?? env : env;
  };

  async function readLedger() {
    const env = await full(await http('GET', `/v1/films/${filmId}/ledger`));
    if (!env?.ok) throw new Error(`账本读不到：${env?.error?.code ?? '未知'}`);
    st.gpuSeconds = Math.round(env.data.items.reduce((n, x) => n + (Number(x.gpuSeconds) || 0), 0) * 1000) / 1000;
  }

  /** 超了哪一项预算：tokens | wallSeconds | gpuSeconds；都没超交回 null */
  function over() {
    if (st.tokens + reserveTokens > maxTokens) return 'tokens';
    if (budget.wallSeconds !== undefined && wallSeconds() >= budget.wallSeconds) return 'wallSeconds';
    if (budget.gpuSeconds !== undefined && st.gpuSeconds >= budget.gpuSeconds) return 'gpuSeconds';
    return null;
  }

  /** 一次工具调用：异步作业在这里等到终态；顺手记下修订号和交付产物 */
  async function tool(args) {
    let res = await callApi(api, args);
    let parsed = JSON.parse(res.text);
    const path = String(args.path ?? '');
    while (JOB_VERB.test(path) && ['queued', 'running'].includes(parsed.body?.data?.status) && !signal?.aborted && !over()) {
      res = await callApi(api, { method: 'GET', path: `/v1/jobs/${parsed.body.data.job}?wait=30` });
      parsed = JSON.parse(res.text);
      await readLedger();
    }
    const env = parsed.body;
    if (env?.ok && Number.isSafeInteger(env.data?.rev) && /\/film(?:\?|$)/.test(path)) st.bestRev = Math.max(st.bestRev, env.data.rev);
    if (/\/deliver(?:\?|$)/.test(path) && env?.ok && env.data?.status === 'succeeded') {
      const whole = await full(env);
      st.outputs = (whole.outputs ?? []).filter((o) => o.kind !== 'response');
      st.deliveredRev = whole.data?.rev ?? st.bestRev;
    }
    return res.text;
  }

  /** 一段角色会话：交回 'done' | 'max-steps'，或 { stop: 原因, at: 停在哪一步 } */
  async function session(role, tag, model, task) {
    const messages = [{ role: 'system', content: `[ROLE:${tag}]\n${SYSTEM[role]}` }, { role: 'user', content: `片子 ${filmId}\n需求：${brief}\n${task}` }];
    for (let step = 1; step <= maxSteps; step++) {
      if (signal?.aborted) return { stop: 'canceled', at: `${tag}:step-${step}` };
      await readLedger();
      const why = over();
      if (why) return { stop: why, at: `${tag}:step-${step}` };
      const res = await chat({ endpoint, apiKey, signal, body: { model, messages, tools: [HTTP_TOOL], tool_choice: 'auto' } });
      st.tokens += res.usage.inputTokens + res.usage.outputTokens;
      const calls = Array.isArray(res.message.tool_calls) ? res.message.tool_calls : [];
      messages.push({ role: 'assistant', content: res.message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) return 'done';
      for (const tc of calls) {
        let args = null;
        try { args = JSON.parse(tc?.function?.arguments ?? ''); } catch { /* 下面按拒绝处理 */ }
        const content = tc?.function?.name === 'http_request' && args && typeof args === 'object' ? await tool(args) : JSON.stringify({ refused: '只有 http_request 这一个工具，arguments 要是 JSON 对象' });
        messages.push({ role: 'tool', tool_call_id: tc.id, content });
      }
    }
    return 'max-steps';
  }

  try {
    const director = await session('director', 'director', directorModel, '先定片子，再交给镜头工。');
    if (director.stop) return director.stop === 'canceled' ? result('canceled') : result('stopped', { stoppedReason: director.stop, stoppedAt: director.at });
    const filmEnv = await http('GET', `/v1/films/${filmId}/film`);
    if (Number.isSafeInteger(filmEnv?.data?.rev)) st.bestRev = Math.max(st.bestRev, filmEnv.data.rev);
    for (const shot of filmEnv?.data?.film?.shots ?? []) {
      let outcome;
      // 一个镜头工没收住就起一个新鲜的再试一次
      for (let attempt = 1; attempt <= 2 && outcome !== 'done'; attempt++) {
        outcome = await session('shot-worker', `shot-worker:${shot.id}`, workerModel, `镜头 ${shot.id}（帧 ${shot.in}–${shot.out}）。`);
        if (outcome.stop) return outcome.stop === 'canceled' ? result('canceled') : result('stopped', { stoppedReason: outcome.stop, stoppedAt: outcome.at });
      }
      if (outcome !== 'done') return result('failed', { failedAt: `shot-worker:${shot.id}` });
    }
    if (st.deliveredRev === null || st.deliveredRev < st.bestRev) {
      const fin = await session('finalizer', 'finalizer', workerModel, `最新修订 rev ${st.bestRev} 还没交付六件套。`);
      if (fin.stop) return fin.stop === 'canceled' ? result('canceled') : result('stopped', { stoppedReason: fin.stop, stoppedAt: fin.at });
    }
    return st.outputs.length === 6 ? result('succeeded') : result('failed', { failedAt: 'finalizer' });
  } catch (e) {
    if (signal?.aborted) return result('canceled');
    throw e;
  }
}
