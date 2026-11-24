// 异族模型的两个客户端，都走 OpenAI-compatible 的 Chat Completions：
//   runHandsOnAgent            亲手模式的最小代理循环。模型手里只有一个工具 http_request，只能调本服务的 /v1/* 动词；
//   createOpenAiVisionReviewer L5 审片：把需求原文、联系表、切点条带、声音量测表交给视觉模型，收回带帧区间、严重度、证据的意见和建议谓词。
// 接口地址、密钥、模型名从环境变量读（或由调用方传入），代码里不写任何密钥和地址：
//   代理 BEIMING_AGENT_ENDPOINT、BEIMING_AGENT_API_KEY、BEIMING_AGENT_MODEL；审片 BEIMING_REVIEW_ENDPOINT、BEIMING_REVIEW_API_KEY、BEIMING_REVIEW_MODEL。
// 每次模型响应往外部模型用量账本 external-ledger.jsonl 追加一行：序号、角色、模型家族、模型名、输入与输出 token。
// 这份账本和工作区的账本（GET ledger）分开记：那边是服务器花的，这边是外部模型花的。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DELEGATE_ROLES,
  L5_GRADES,
  L5_ISSUE_KEYS,
  L5_PERSPECTIVES,
  SHOT_WORKER_MAX_START_TOKENS,
  aggregateL5Votes,
  buildShotWorkerBrief,
  buildShotWorkerMessages,
  filterL5SuggestedPredicates,
  measureStartContextTokens,
  normalizeIssueKey,
  selectDelegateTemplate,
  shuffleCandidatesForBallot,
} from './delegate-roles.mjs';

export {
  DELEGATE_ROLES,
  L5_GRADES,
  L5_ISSUE_KEYS,
  L5_PERSPECTIVES,
  SHOT_WORKER_MAX_START_TOKENS,
  aggregateL5Votes,
  buildShotWorkerBrief,
  buildShotWorkerMessages,
  filterL5SuggestedPredicates,
  measureStartContextTokens,
  normalizeIssueKey,
  selectDelegateTemplate,
  shuffleCandidatesForBallot,
};

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
// 一次模型调用最多等多久（毫秒）
const MODEL_TIMEOUT_MS = 120000;
const SEVERITIES = ['low', 'medium', 'high', 'info', 'warn', 'error'];
const AGENT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AGENT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const DATA_IMAGE_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
// 单张 L5 视觉审片选票的默认输出 token 上限（每次请求必带 max_tokens，用于可执行上界与防失控输出）
export const DEFAULT_REVIEW_MAX_OUTPUT_TOKENS = 1_024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REVIEW_MIN_IMAGE_TOKENS = 1_024;
const REVIEW_FALLBACK_IMAGE_TOKENS = 2_048;
const GPT_4O_MINI_RE = /^(?:[^:]+:)?gpt-4o-mini(?:$|[-_:@.])/;
const HIGH_MULT_VISION_MODELS = [
  [/^(?:[^:]+:)?gpt-4\.1-mini(?:$|[-_:@.])/, 1.62],
  [/^(?:[^:]+:)?gpt-4\.1-nano(?:$|[-_:@.])/, 2.46],
  [/^(?:[^:]+:)?o4-mini(?:$|[-_:@.])/, 1.72],
  [/^(?:[^:]+:)?gpt-5-mini(?:$|[-_:@.])/, 1.62],
  [/^(?:[^:]+:)?gpt-5-nano(?:$|[-_:@.])/, 2.46],
];

/** 估算单张视觉图像的保守输入 token 上界（覆盖 OpenAI 高倍率/分块/补丁计费、Claude 面积与 Gemini 视觉计费） */
function estimateImageTokens(buf, model = '') {
  const modelName = String(model ?? '').trim().toLowerCase().split('/').pop() ?? '';
  const isGpt4oMini = GPT_4O_MINI_RE.test(modelName);
  const highMult = HIGH_MULT_VISION_MODELS.find(([re]) => re.test(modelName))?.[1] ?? 0;

  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (isGpt4oMini) return Math.max(REVIEW_FALLBACK_IMAGE_TOKENS, 2833 + 5667);
    if (highMult > 0) return Math.max(REVIEW_FALLBACK_IMAGE_TOKENS, Math.ceil(1536 * highMult));
    return REVIEW_FALLBACK_IMAGE_TOKENS;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    if (isGpt4oMini) return Math.max(REVIEW_FALLBACK_IMAGE_TOKENS, 2833 + 5667);
    if (highMult > 0) return Math.max(REVIEW_FALLBACK_IMAGE_TOKENS, Math.ceil(1536 * highMult));
    return REVIEW_FALLBACK_IMAGE_TOKENS;
  }
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
  const areaBound = Math.ceil((width * height) / 512);
  const baseBound = Math.max(REVIEW_MIN_IMAGE_TOKENS, tiles * 256 + 256, areaBound);
  if (isGpt4oMini) {
    return Math.max(baseBound, 2833 + 5667 * tiles);
  }
  if (highMult > 0) {
    const tileBound = Math.ceil((85 + 170 * tiles) * highMult);
    const patchBound = Math.ceil(Math.min(1536, Math.ceil(width / 32) * Math.ceil(height / 32)) * highMult);
    return Math.max(baseBound, tileBound, patchBound);
  }
  return baseBound;
}

/** 估算单张 L5 选票纯文本输入的保守 token 上界（UTF-8 字节数 + 消息封装开销，永不为 0） */
function estimateReviewTextInputTokens(systemContent, userText) {
  return Buffer.byteLength(systemContent, 'utf8') + Buffer.byteLength(userText, 'utf8') + 256;
}

/** 把工具调用返回的一组图像产物封装为紧随 tool 消息之后的多模态 user 消息，供视觉代理观察画面。 */
export function buildToolImageMessage(images) {
  return {
    role: 'user',
    content: images.flatMap((img) => [
      {
        type: 'text',
        text: `以上工具调用返回的图像产物（${img.path}，${img.mimeType}，${img.bytes} 字节），请直接观察画面内容后再决定下一步。`,
      },
      {
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      },
    ]),
  };
}

/** 估算含可选 image_url 的 Chat Completions 请求体输入 token 保守上界（图像按分辨率估算，不按 base64 字节膨胀）。 */
export function estimateChatBodyInputTokens(body, model = '') {
  let imageTokens = 0;
  const messages = Array.isArray(body?.messages)
    ? body.messages.map((msg) => {
      if (!msg || !Array.isArray(msg.content)) return msg;
      let changed = false;
      const content = msg.content.map((part) => {
        const url = part?.type === 'image_url' ? part?.image_url?.url : null;
        if (typeof url === 'string' && DATA_IMAGE_PREFIX_RE.test(url)) {
          changed = true;
          const comma = url.indexOf(',');
          const headB64 = url.slice(comma + 1, comma + 65).replace(/\s+/g, '').slice(0, 48);
          imageTokens += estimateImageTokens(Buffer.from(headB64, 'base64'), model);
          return { ...part, image_url: { ...part.image_url, url: '[image_url]' } };
        }
        return part;
      });
      return changed ? { ...msg, content } : msg;
    })
    : body?.messages;
  const sanitized = JSON.stringify({ ...body, messages });
  const msgCount = Array.isArray(body?.messages) ? body.messages.length : 0;
  return Buffer.byteLength(sanitized) + imageTokens + 256 + 16 * msgCount;
}

async function readBinaryResponse(res, keepUpTo = 0) {
  const contentLength = Number(res.headers.get('content-length'));
  const keep = keepUpTo > 0 && !(Number.isFinite(contentLength) && contentLength > keepUpTo) ? keepUpTo : 0;
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { bytes: buf.byteLength, buffer: keep > 0 && buf.byteLength <= keep ? buf : null };
  }
  let bytes = 0;
  let chunks = keep > 0 ? [] : null;
  for await (const chunk of res.body) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += piece.byteLength;
    if (chunks) {
      if (bytes <= keep) chunks.push(piece);
      else chunks = null;
    }
  }
  return { bytes, buffer: chunks ? Buffer.concat(chunks, bytes) : null };
}

const AGENT_SYSTEM = [
  '你是一个只通过 HTTP 接口做片子的代理。你手里只有一个工具 http_request，只能调本服务 /v1/ 开头的动词；令牌由工具替你带。',
  '先 GET /v1/guide，照里面的闭环做：建片、改片（补丁带 rev）、看诊断（能机器修的用 ?applyFixes=machine）、渲、观测、核验、交付。',
  '每一步先看响应信封的 ok、error.code、diagnostics、next。做完用一段话汇报做了什么、卡在哪。',
].join('\n');

export const HTTP_TOOL = {
  type: 'function',
  function: {
    name: 'http_request',
    description: '调本服务的一个 HTTP 动词。path 以 /v1/ 开头；body 是 JSON 对象（PUT files 交脚本时是字符串）。返回 HTTP 状态码和响应信封。',
    parameters: {
      type: 'object',
      properties: { method: { type: 'string', enum: METHODS }, path: { type: 'string', pattern: '^/v1/' }, body: {} },
      required: ['method', 'path'],
      additionalProperties: false,
    },
  },
};

const count = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** 模型家族：模型名（去掉供应商前缀）开头的那串字母，例如 gpt-4o → gpt、gemini-2.5-pro → gemini */
export const familyOf = (model) => /^[a-z]+/.exec(String(model).toLowerCase().split('/').pop())?.[0] ?? 'unknown';

/** 往外部模型用量账本追加一行（序号接着已有的行数） */
export function appendExternalLedger(ledgerPath, entry) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const seq = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).length + 1 : 1;
  appendFileSync(ledgerPath, `${JSON.stringify({ seq, ...entry })}\n`);
}

function requireConfig(what, names, { endpoint, apiKey, model, ledgerPath }) {
  const missing = [!endpoint && `endpoint（${names.endpoint}）`, !apiKey && `apiKey（${names.apiKey}）`, !model && `model（${names.model}）`, !ledgerPath && 'ledgerPath'].filter(Boolean);
  if (missing.length) throw new TypeError(`${what}缺配置：${missing.join('、')}`);
}

/** 调一次 chat/completions：先提取可核算 usage 再校验 choices[0].message，异常对象亦附带已提取的 usage 与 model */
export async function chat({ endpoint, apiKey, body, signal, requireUsage = false }) {
  const target = /\/chat\/completions\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(target, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]) : AbortSignal.timeout(MODEL_TIMEOUT_MS),
  }).catch(() => { throw new ModelResponseError('模型接口连接失败或超时'); });
  if (!res.ok) throw new ModelResponseError(`模型接口返回 HTTP ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new ModelResponseError('模型接口返回的不是 JSON'); }
  const resolvedModel = typeof data?.model === 'string' && data.model.trim() ? data.model : body.model;
  const hasUsageObj = Boolean(data?.usage && typeof data.usage === 'object');
  let inputTokens = count(data?.usage?.prompt_tokens ?? data?.usage?.input_tokens);
  let outputTokens = count(data?.usage?.completion_tokens ?? data?.usage?.output_tokens);
  if (!requireUsage) {
    const total = count(data?.usage?.total_tokens);
    if (total > inputTokens + outputTokens) {
      if (inputTokens > 0 && outputTokens === 0) {
        outputTokens = total - inputTokens;
      } else if (inputTokens === 0 && outputTokens > 0) {
        inputTokens = total - outputTokens;
      } else {
        inputTokens += total - inputTokens - outputTokens;
      }
    }
  }
  const usage = { inputTokens, outputTokens };
  const withUsage = (err) => {
    if (hasUsageObj && (inputTokens > 0 || outputTokens > 0)) {
      err.usage = usage;
      err.model = resolvedModel;
    }
    return err;
  };
  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') throw withUsage(new ModelResponseError('模型接口的返回里没有 choices[0].message'));
  if (requireUsage && !(Number.isSafeInteger(data.usage?.prompt_tokens) && data.usage.prompt_tokens > 0 &&
    Number.isSafeInteger(data.usage.completion_tokens) && data.usage.completion_tokens >= 0)) {
    throw withUsage(new ModelResponseError('模型接口没有返回可核算的 token 用量'));
  }
  return { message, model: resolvedModel, usage };
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isFilesPath(path) {
  if (typeof path !== 'string') return false;
  const pathname = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i, '').split(/[?#]/, 1)[0];
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* 保持原路径 */ }
  return /^\/v1\/films\/[^/]+\/files(?:\/|$)/.test(pathname)
    || /^\/v1\/films\/[^/]+\/files(?:\/|$)/.test(decoded);
}

/**
 * 兼容外部模型把 JSON 请求体序列化为字符串传入 http_request.body 的情形：
 * 仅对非 /v1/films/<id>/files/* 路径且以 { 或 [ 开头的合法 JSON 对象/数组字符串解包；
 * /files/* 源码正文、解析失败字符串与其他原始值一律原样保留，避免误解析或吞掉非法类型错误。
 */
export function normalizeJsonToolBody(path, body) {
  if (typeof body !== 'string' || isFilesPath(path)) return body;
  const trimmed = body.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return body;
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed) || Array.isArray(parsed)) return parsed;
  } catch { /* 非法 JSON 字符串原样交给上游校验或服务端报错 */ }
  return body;
}

/**
 * 执行一次 http_request。只放行本服务 /v1/ 开头的路径；令牌由这里挑：建片交回的工作区令牌记下来（不交给模型），
 * 之后调那部片和它的作业时带工作区令牌，别的动词带账户令牌。交回 { text（给模型的工具结果）, call（留给调用方的记录） }。
 */
export async function callApi({ baseUrl, account, workspaces, jobs, signal }, args) {
  const refuse = (why) => ({ text: JSON.stringify({ refused: why }), call: { method: String(args?.method), path: String(args?.path), status: 0, ok: false, refused: why } });
  const method = String(args?.method ?? '').toUpperCase();
  const path = args?.path;
  if (!METHODS.includes(method)) return refuse(`method 只收 ${METHODS.join('、')}`);
  if (typeof path !== 'string' || !/^\/v1\/[^\s#\\]*$/.test(path)) return refuse('path 只收本服务 /v1/ 开头的路径');
  const target = new URL(path, baseUrl);
  if (target.origin !== new URL(baseUrl).origin || !target.pathname.startsWith('/v1/')) return refuse('path 只收本服务 /v1/ 开头的路径');
  const film = /^\/v1\/films\/([^/]+)\//.exec(target.pathname)?.[1];
  const job = /^\/v1\/jobs\/([^/]+)$/.exec(target.pathname)?.[1];
  const token = (film && workspaces[film]) || (job && workspaces[jobs[job]]) || account;
  const hasBody = args.body !== undefined && args.body !== null && method !== 'GET';
  const reqBody = hasBody ? normalizeJsonToolBody(target.pathname, args.body) : args.body;
  const text = typeof reqBody === 'string';
  const res = await fetch(target, {
    method, headers: { authorization: `Bearer ${token}`, ...(hasBody ? { 'content-type': text ? 'text/plain; charset=utf-8' : 'application/json' } : {}) },
    ...(hasBody ? { body: text ? reqBody : JSON.stringify(reqBody) } : {}), signal,
  });
  const call = { method, path, status: res.status, ok: res.ok };
  const rawContentType = res.headers.get('content-type') ?? '';
  if (!/json/i.test(rawContentType)) {
    const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
    const isSupportedImage = res.ok && AGENT_IMAGE_MIMES.has(mimeType);
    const { bytes, buffer } = await readBinaryResponse(res, isSupportedImage ? AGENT_IMAGE_MAX_BYTES : 0);
    if (isSupportedImage) {
      const imageAttached = bytes > 0 && buffer !== null;
      const out = {
        text: JSON.stringify({ status: res.status, contentType: res.headers.get('content-type'), bytes, imageAttached }),
        call: { ...call, bytes, imageAttached },
      };
      if (imageAttached) {
        out.image = { mimeType, base64: buffer.toString('base64'), bytes, path };
      }
      return out;
    }
    return { text: JSON.stringify({ status: res.status, contentType: res.headers.get('content-type'), bytes }), call: { ...call, bytes } };
  }
  const envelope = await res.json();
  if (envelope?.format === 'envelope/0.1') call.ok = envelope.ok;
  if (envelope?.error?.code) call.code = envelope.error.code;
  const data = envelope?.data;
  if (envelope?.ok && typeof data?.token === 'string' && typeof data.film === 'string') {
    workspaces[data.film] = data.token;
    data.token = '（工具已代存，后续调用自动带上）';
  }
  if (typeof data?.job === 'string' && film) jobs[data.job] = film;
  return { text: JSON.stringify({ status: res.status, body: envelope }), call };
}

/** 亲手代理调用建片或审片时，若模型省略或留空 body.brief，自动在副本中补回已传入的需求原文（不篡改原参数，不覆盖显式非空传值，亦不吞掉显式非法类型） */
function attachHandsOnBrief(args, brief, baseUrl) {
  if (typeof brief !== 'string' || !brief.trim()) return args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (String(args.method ?? '').toUpperCase() !== 'POST') return args;
  const path = args.path;
  if (typeof path !== 'string' || !/^\/v1\/[^\s#\\]*$/.test(path)) return args;
  let target;
  try {
    target = new URL(path, baseUrl);
    if (target.origin !== new URL(baseUrl).origin) return args;
  } catch {
    return args;
  }
  const pathname = target.pathname;
  if (pathname !== '/v1/films' && !/^\/v1\/films\/[^/]+\/review$/.test(pathname)) return args;
  const body = normalizeJsonToolBody(pathname, args.body);
  if (body !== undefined && body !== null) {
    if (!isPlainObject(body)) return args;
    const hasBrief = Object.hasOwn(body, 'brief') && body.brief !== undefined && body.brief !== null;
    if (hasBrief && (typeof body.brief !== 'string' || body.brief.trim())) {
      return body === args.body ? args : { ...args, body };
    }
  }
  return { ...args, body: body == null ? { brief } : { ...body, brief } };
}

/**
 * 亲手模式的代理循环。baseUrl 是本服务的地址，token 是账户令牌；endpoint、apiKey、model 不给就读环境变量；
 * brief 是需求原文；ledgerPath 是外部模型用量账本；maxSteps 是最多几轮模型调用；tokenBudget 是输入加输出的 token 上限。
 * 交回 { status: 'done' | 'max-steps' | 'budget', steps, calls, usage, final, workspaces: { 片子: 工作区令牌 }, ledgerPath }。
 */
export async function runHandsOnAgent({
  baseUrl, token, brief, ledgerPath, maxSteps = 40, tokenBudget = 200000,
  endpoint = process.env.BEIMING_AGENT_ENDPOINT, apiKey = process.env.BEIMING_AGENT_API_KEY, model = process.env.BEIMING_AGENT_MODEL,
} = {}) {
  requireConfig('代理循环', { endpoint: 'BEIMING_AGENT_ENDPOINT', apiKey: 'BEIMING_AGENT_API_KEY', model: 'BEIMING_AGENT_MODEL' }, { endpoint, apiKey, model, ledgerPath });
  if (typeof baseUrl !== 'string' || !baseUrl || typeof token !== 'string' || !token) throw new TypeError('代理循环要 baseUrl（本服务地址）和 token（账户令牌）');
  if (typeof brief !== 'string' || !brief.trim()) throw new TypeError('代理循环要 brief（需求原文）');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || !(tokenBudget > 0)) throw new RangeError('maxSteps 要正整数，tokenBudget 要正数');
  const api = { baseUrl, account: token, workspaces: {}, jobs: {} };
  const messages = [{ role: 'system', content: AGENT_SYSTEM }, { role: 'user', content: brief }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const calls = [];
  const done = (status, steps, final = null) => ({ status, steps, calls, usage, final, workspaces: api.workspaces, ledgerPath });
  for (let step = 1; step <= maxSteps; step++) {
    if (usage.inputTokens + usage.outputTokens >= tokenBudget) return done('budget', step - 1);
    const res = await chat({ endpoint, apiKey, body: { model, messages, tools: [HTTP_TOOL], tool_choice: 'auto' } });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    appendExternalLedger(ledgerPath, { role: 'agent', step, family: familyOf(res.model), model: res.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens });
    if (usage.inputTokens + usage.outputTokens >= tokenBudget) return done('budget', step);
    const toolCalls = Array.isArray(res.message.tool_calls) ? res.message.tool_calls : [];
    messages.push({ role: 'assistant', content: res.message.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    if (!toolCalls.length) return done('done', step, typeof res.message.content === 'string' ? res.message.content : null);
    const attachedImages = [];
    for (const tc of toolCalls) {
      let result;
      if (tc?.function?.name !== 'http_request') result = { text: JSON.stringify({ refused: '只有 http_request 这一个工具' }), call: { method: '', path: '', status: 0, ok: false, refused: `没有工具 ${tc?.function?.name}` } };
      else {
        let args = null;
        try { args = JSON.parse(tc.function.arguments ?? ''); } catch { /* 参数不是 JSON：下面按拒绝处理 */ }
        result = args && typeof args === 'object'
          ? await callApi(api, attachHandsOnBrief(args, brief, baseUrl))
          : { text: JSON.stringify({ refused: 'arguments 不是 JSON 对象' }), call: { method: '', path: '', status: 0, ok: false, refused: 'arguments 不是 JSON 对象' } };
      }
      calls.push({ step, ...result.call });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.text });
      if (result.image) attachedImages.push(result.image);
    }
    if (attachedImages.length) {
      messages.push(buildToolImageMessage(attachedImages));
    }
  }
  return done('max-steps', maxSteps);
}

class ModelResponseError extends Error {}

export const reviewFailure = error =>
  (error instanceof ModelResponseError || error?.code === 'usage.bad-argument')
    ? error.message
    : '视觉审片适配器调用失败';

export function validateReview(parsed, frames = Infinity) {
  const text = value => typeof value === 'string' && value.trim().length > 0;
  if (!Array.isArray(parsed?.opinions)) throw new ModelResponseError('审片 JSON 缺少 opinions 数组');
  const opinions = parsed.opinions.map((o, i) => {
    if (!Array.isArray(o?.frames) || o.frames.length !== 2 || !o.frames.every(f => Number.isSafeInteger(f) && f >= 0 && f < frames)
      || o.frames[0] > o.frames[1] || !SEVERITIES.includes(o.severity) || !text(o.evidence) || !text(o.comment)) {
      throw new ModelResponseError(`审片意见 opinions[${i}] 的帧段、严重度、证据或意见不合法`);
    }
    if (o.issueKey !== undefined && !text(o.issueKey)) {
      throw new ModelResponseError(`审片意见 opinions[${i}] 的 issueKey 必须是非空字符串`);
    }
    if (o.suggestedPredicate !== undefined && !text(o.suggestedPredicate)) {
      throw new ModelResponseError(`审片意见 opinions[${i}] 的 suggestedPredicate 必须是非空字符串`);
    }
    return {
      ...(text(o.issueKey) ? { issueKey: o.issueKey.trim() } : {}),
      frames: o.frames,
      severity: o.severity,
      evidence: o.evidence,
      comment: o.comment,
      ...(text(o.suggestedPredicate) ? { suggestedPredicate: o.suggestedPredicate.trim() } : {}),
    };
  });
  const suggestedPredicates = parsed.suggestedPredicates === undefined ? [] : parsed.suggestedPredicates;
  if (!Array.isArray(suggestedPredicates) || !suggestedPredicates.every(text)) throw new ModelResponseError('suggestedPredicates 必须是断言字符串数组');
  if (parsed.grade !== undefined && !L5_GRADES.includes(parsed.grade)) {
    throw new ModelResponseError(`审片等级 grade 必须是 ${L5_GRADES.join('/')} 之一`);
  }
  let candidateGrades;
  if (parsed.candidateGrades !== undefined) {
    if (!Array.isArray(parsed.candidateGrades) || !parsed.candidateGrades.every(cg => cg && text(cg.id) && L5_GRADES.includes(cg.grade))) {
      throw new ModelResponseError('candidateGrades 必须是含 id 与合法等级词的数组');
    }
    candidateGrades = parsed.candidateGrades.map(cg => ({ id: cg.id.trim(), grade: cg.grade }));
  }
  return {
    ...(parsed.grade !== undefined ? { grade: parsed.grade } : {}),
    ...(candidateGrades !== undefined ? { candidateGrades } : {}),
    opinions,
    suggestedPredicates,
  };
}

function parseReview(text, frames) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new ModelResponseError('审片模型必须返回完整的 JSON 对象'); }
  return validateReview(parsed, frames);
}

/**
 * 异族视觉审片客户端（L5 三视角 × 3 票 = 9 票完整规程）。
 * 交回 { model, perspectives, votesPerPerspective, review({ brief, images, loudness, film, filmId, candidates, budgetCheck, maxTokens, signal }) }；
 * review 按三个视角各投 3 票（共 9 票）：
 * - 每票调用模型前先执行 budgetCheck / maxTokens 预算闸检查，超限时立即停票并保留已投票与 stoppedReason；
 * - 收到响应后先累计 usage 并写入带 film 字段的外部用量账本，再解析校验单票；
 * - 单张坏票或上游失败仅隔离记入 invalidBallots，不中断其余选票，也不丢失已花 token。
 */
export function createOpenAiVisionReviewer({
  endpoint,
  apiKey,
  model,
  ledgerPath,
  perspectives = L5_PERSPECTIVES,
  votesPerPerspective = 3,
  maxTokens = null,
  maxOutputTokens = DEFAULT_REVIEW_MAX_OUTPUT_TOKENS,
} = {}) {
  requireConfig('审片客户端', { endpoint: 'BEIMING_REVIEW_ENDPOINT', apiKey: 'BEIMING_REVIEW_API_KEY', model: 'BEIMING_REVIEW_MODEL' }, { endpoint, apiKey, model, ledgerPath });
  if (!Number.isSafeInteger(votesPerPerspective) || votesPerPerspective < 1) {
    throw Object.assign(new Error('votesPerPerspective 必须是正安全整数'), { code: 'usage.bad-argument' });
  }
  if (maxTokens !== null && maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 0)) {
    throw Object.assign(new Error('maxTokens 必须是非负安全整数'), { code: 'usage.bad-argument' });
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw Object.assign(new Error('maxOutputTokens 必须是正安全整数'), { code: 'usage.bad-argument' });
  }
  return {
    model,
    perspectives,
    votesPerPerspective,
    async review({
      brief,
      images = [],
      loudness = null,
      film = null,
      filmId = null,
      candidates = [],
      budgetCheck = null,
      maxTokens: reqMaxTokens = null,
      maxOutputTokens: reqMaxOutputTokens = null,
      signal = null,
    } = {}) {
      if (reqMaxTokens !== null && reqMaxTokens !== undefined && (!Number.isSafeInteger(reqMaxTokens) || reqMaxTokens < 0)) {
        throw Object.assign(new Error('maxTokens 必须是非负安全整数'), { code: 'usage.bad-argument' });
      }
      if (reqMaxOutputTokens !== null && reqMaxOutputTokens !== undefined && (!Number.isSafeInteger(reqMaxOutputTokens) || reqMaxOutputTokens < 1)) {
        throw Object.assign(new Error('maxOutputTokens 必须是正安全整数'), { code: 'usage.bad-argument' });
      }
      const resolvedFilmId = typeof filmId === 'string' && filmId.trim()
        ? filmId.trim()
        : (typeof film?.id === 'string' && film.id.trim() ? film.id.trim() : null);
      const planned = perspectives.map((p) => ({
        p,
        votes: Number.isSafeInteger(p.votes) && p.votes > 0 ? p.votes : votesPerPerspective,
      }));
      // 在发首票前先校验候选目录（避免非法/重复候选 ID 浪费 token）
      shuffleCandidatesForBallot(candidates, {
        filmId: resolvedFilmId ?? 'film',
        perspective: planned[0]?.p?.id ?? 'composition-readability',
        voteIndex: 0,
      });
      let imageInputBound = 0;
      const imageParts = images.map((img) => {
        const buf = readFileSync(img.path);
        imageInputBound += estimateImageTokens(buf, model);
        return {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${buf.toString('base64')}` },
        };
      });
      const totalBallots = planned.reduce((n, item) => n + item.votes, 0);
      const effectiveMaxTokens = [maxTokens, reqMaxTokens]
        .filter((v) => Number.isSafeInteger(v) && v >= 0)
        .reduce((min, v) => Math.min(min, v), Infinity);
      const configuredMaxOutput = reqMaxOutputTokens !== null && reqMaxOutputTokens !== undefined
        ? Math.min(maxOutputTokens, reqMaxOutputTokens)
        : maxOutputTokens;

      const ballots = [];
      const invalidBallots = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let maxObservedInputTokens = 0;
      let maxObservedTotalTokens = 0;
      let lastModel = model;
      let ballotIndex = 0;
      let executedBallots = 0;
      let stoppedReason = null;

      const recordUsage = (usedModel, usage, perspectiveId, voteIdx) => {
        const uIn = count(usage?.inputTokens);
        const uOut = count(usage?.outputTokens);
        const uTotal = uIn + uOut;
        lastModel = usedModel;
        inputTokens += uIn;
        outputTokens += uOut;
        maxObservedInputTokens = Math.max(maxObservedInputTokens, uIn);
        maxObservedTotalTokens = Math.max(maxObservedTotalTokens, uTotal);
        executedBallots++;
        appendExternalLedger(ledgerPath, {
          ...(resolvedFilmId ? { film: resolvedFilmId } : {}),
          role: 'reviewer',
          perspective: perspectiveId,
          voteIndex: voteIdx,
          family: familyOf(usedModel),
          model: usedModel,
          inputTokens: uIn,
          outputTokens: uOut,
        });
        return uTotal;
      };

      for (const { p, votes } of planned) {
        if (stoppedReason) break;
        const issueKeys = Array.isArray(p.issueKeys) && p.issueKeys.length
          ? p.issueKeys
          : (L5_ISSUE_KEYS[p.id] ?? []);
        for (let voteIndex = 0; voteIndex < votes; voteIndex++) {
          if (signal?.aborted) {
            stoppedReason = 'canceled';
            break;
          }

          const orderedCandidates = shuffleCandidatesForBallot(candidates, {
            filmId: resolvedFilmId ?? 'film',
            perspective: p.id,
            voteIndex,
          });
          const candidateOrder = orderedCandidates.map((c, idx) =>
            (typeof c === 'string' ? c : String(c?.id ?? idx)).trim(),
          );
          const text = [
            `审片视角：${p.title}（${p.id}）· 第 ${voteIndex + 1}/${votes} 票`,
            `视角关注点：${p.focus}`,
            `本视角封闭 issueKey 枚举（每条意见必填且仅限此表）：${issueKeys.join(', ')}`,
            `等级词枚举：${L5_GRADES.join(' / ')}`,
            `需求原文：${brief || '（没有给）'}`,
            `片子：${JSON.stringify(film)}`,
            `声音量测表：${loudness ? JSON.stringify(loudness) : '（没有声音量测）'}`,
            ...(orderedCandidates.length
              ? [`候选展示顺序（已按种子打乱）：${JSON.stringify(orderedCandidates)}`]
              : []),
            `图：${images.map((img, i) => `第 ${i + 1} 张 ${img.name}`).join('；') || '（没有图）'}。联系表（contact）每格左上角是全片帧号；切点条带（cut）是切点前 3 帧到后 2 帧，红线是切口；keyframe-f<帧号> 为未缩放的原尺寸关键帧，请直接据以检查构图细节、主体清晰度与文字可读性。`,
          ].join('\n');
          const content = [{ type: 'text', text }, ...imageParts];
          const systemContent = `[ROLE:reviewer][PERSPECTIVE:${p.id}][VOTE:${voteIndex + 1}]\n${DELEGATE_ROLES.reviewer.systemPrompt}`;

          // 发票前计算可执行保守上界（文本 + 图像 + 输出上限，且不低于已观测单票高水位；首票绝不为 0）
          const spentTokens = inputTokens + outputTokens;
          const staticInputBound = estimateReviewTextInputTokens(systemContent, text) + imageInputBound;
          const inputUpperBound = Math.max(staticInputBound, maxObservedInputTokens);
          let requestMaxTokens = configuredMaxOutput;
          if (Number.isFinite(effectiveMaxTokens)) {
            const localRemaining = effectiveMaxTokens - spentTokens;
            const minRequired = Math.max(inputUpperBound + 1, maxObservedTotalTokens);
            if (localRemaining < minRequired) {
              stoppedReason = 'budget.tokens';
              break;
            }
            requestMaxTokens = Math.min(requestMaxTokens, Math.floor(localRemaining - inputUpperBound));
            if (requestMaxTokens < 1) {
              stoppedReason = 'budget.tokens';
              break;
            }
          }
          const estimatedNextTokens = Math.max(inputUpperBound + requestMaxTokens, maxObservedTotalTokens);

          let settleReservation = null;
          if (typeof budgetCheck === 'function') {
            let decision;
            try {
              decision = await budgetCheck({
                ballotIndex,
                totalBallots,
                spentTokens,
                estimatedInputTokens: inputUpperBound,
                maxOutputTokens: requestMaxTokens,
                maxObservedTokens: maxObservedTotalTokens,
                estimatedNextTokens,
                perspective: p.id,
                voteIndex,
              });
            } catch {
              // 预算回调抛错时停止后续投票，保留已投出的全部有效票与累计 usage 交回 layerL5/work 记账
              stoppedReason = 'budget.check-error';
              break;
            }
            if (decision === false || (decision && typeof decision === 'object' && (decision.ok === false || decision.allow === false))) {
              stoppedReason = (decision && typeof decision === 'object' && typeof decision.reason === 'string' && decision.reason.trim())
                ? decision.reason.trim()
                : 'budget.tokens';
              break;
            }
            if (decision && typeof decision === 'object') {
              if (typeof decision.settle === 'function') settleReservation = decision.settle;
              if (decision.maxOutputTokens !== undefined) {
                if (!Number.isSafeInteger(decision.maxOutputTokens) || decision.maxOutputTokens < 1) {
                  try { settleReservation?.(0); } catch { /* 释放无用量预留失败时不覆盖停票原因 */ }
                  stoppedReason = 'budget.tokens';
                  break;
                }
                requestMaxTokens = Math.min(requestMaxTokens, decision.maxOutputTokens);
              } else if (!settleReservation && Number.isFinite(decision.remaining)) {
                const minRequired = Math.max(inputUpperBound + 1, maxObservedTotalTokens);
                if (decision.remaining < minRequired) {
                  stoppedReason = 'budget.tokens';
                  break;
                }
                requestMaxTokens = Math.min(requestMaxTokens, Math.floor(decision.remaining - inputUpperBound));
                if (requestMaxTokens < 1) {
                  stoppedReason = 'budget.tokens';
                  break;
                }
              }
            }
          }

          let res = null;
          let ballotTotalTokens = 0;
          let chatFailed = false;
          try {
            res = await chat({
              endpoint,
              apiKey,
              ...(signal ? { signal } : {}),
              body: {
                model,
                max_tokens: requestMaxTokens,
                messages: [
                  { role: 'system', content: systemContent },
                  { role: 'user', content },
                ],
              },
            });
            ballotTotalTokens = recordUsage(res.model, res.usage, p.id, voteIndex);
          } catch (err) {
            chatFailed = true;
            if (err?.usage && (count(err.usage.inputTokens) > 0 || count(err.usage.outputTokens) > 0)) {
              const errModel = typeof err.model === 'string' && err.model.trim() ? err.model : model;
              ballotTotalTokens = recordUsage(errModel, err.usage, p.id, voteIndex);
            }
            if (signal?.aborted) {
              stoppedReason = 'canceled';
            } else {
              invalidBallots.push({
                perspective: p.id,
                voteIndex,
                reason: reviewFailure(err),
              });
            }
          } finally {
            if (settleReservation) {
              try {
                settleReservation(ballotTotalTokens);
              } catch {
                stoppedReason = stoppedReason ?? 'budget.check-error';
              }
            }
          }

          if (stoppedReason) break;
          if (chatFailed) {
            ballotIndex++;
            continue;
          }

          const answer = typeof res.message.content === 'string'
            ? res.message.content
            : (Array.isArray(res.message.content) ? res.message.content.map((part) => part?.text ?? '').join('') : '');
          try {
            const parsedBallot = parseReview(answer, film?.output?.frames);
            if (parsedBallot.candidateGrades) {
              const allowed = new Set(candidateOrder);
              const seen = new Set();
              for (const cg of parsedBallot.candidateGrades) {
                if (!allowed.has(cg.id)) throw new ModelResponseError(`审片选票包含未知候选 ID：${cg.id}`);
                if (seen.has(cg.id)) throw new ModelResponseError(`审片选票包含重复候选 ID：${cg.id}`);
                seen.add(cg.id);
              }
            }
            ballots.push({
              perspective: p.id,
              voteIndex,
              ...(candidateOrder.length ? { candidateOrder } : {}),
              ...parsedBallot,
            });
          } catch (err) {
            invalidBallots.push({
              perspective: p.id,
              voteIndex,
              reason: reviewFailure(err),
            });
          }
          ballotIndex++;
        }
      }

      return {
        model: lastModel,
        ballots,
        invalidBallots,
        plannedBallots: totalBallots,
        executedBallots,
        ...(stoppedReason ? { stoppedReason } : {}),
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      };
    },
  };
}

/** 照环境变量建审片客户端：三项都配了才建，否则交回 null（审片如实写 not-run） */
export function reviewerFromEnv({ env = process.env, ledgerPath } = {}) {
  const { BEIMING_REVIEW_ENDPOINT: endpoint, BEIMING_REVIEW_API_KEY: apiKey, BEIMING_REVIEW_MODEL: model } = env;
  return endpoint && apiKey && model ? createOpenAiVisionReviewer({ endpoint, apiKey, model, ledgerPath }) : null;
}
