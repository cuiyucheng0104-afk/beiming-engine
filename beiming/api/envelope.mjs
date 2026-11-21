// 信封 envelope/0.1 的拼装：错误码只认 errors.json 里登记过的，退出码按前缀表取（EN3），ok 跟着退出码走（EN1、EN2）。
// 诊断补齐 layer、severity；没登记的码换成登记过的近义码，原码记进 evidence（EN4）。
// token 估算口径：UTF-8 字节数 ÷ 3.5 向上取整（和 observe/query.mjs 的 estimateTokens 同一口径）。
import { readFileSync } from 'node:fs';

const REGISTRY = JSON.parse(readFileSync(new URL('../kernel/contracts/errors/errors.json', import.meta.url), 'utf8'));
export const ERROR_CODES = Object.freeze(REGISTRY.codes.map((c) => c.code));
const KNOWN = new Set(ERROR_CODES);
const PATH_RE = /^[^/#\s]+(\/[^/#\s]+)*$/;
const CODE_RE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
const HTTP_BY_PREFIX = { 'usage.': 400, 'auth.': 403, 'contract.': 422, 'busy.': 409, 'env.': 503, 'timeout.': 504, 'failure.': 500 };

/** 估算 token：UTF-8 字节 ÷ 3.5 向上取整；不是字符串的先 JSON 序列化 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.5);
}

export const isRegistered = (code) => typeof code === 'string' && KNOWN.has(code);

/** 错误码的退出码：按 errors.json 的前缀表 */
export function exitCodeOf(code) {
  const hit = REGISTRY.prefixes.find((p) => code.startsWith(p.prefix));
  if (!hit) throw new Error(`错误码 ${code} 的前缀没有登记`);
  return hit.exitCode;
}

/** 错误码的 HTTP 状态码：按前缀；notFound 时 404 */
export function httpStatusOf(code, { notFound = false } = {}) {
  if (notFound) return 404;
  const hit = Object.keys(HTTP_BY_PREFIX).find((p) => code.startsWith(p));
  return hit ? HTTP_BY_PREFIX[hit] : 500;
}

/** 把任意码落到登记过的码上：登记过的原样；没登记的按前缀找近义码 */
export function registeredCode(code, fallback = 'contract.bad-value') {
  if (isRegistered(code)) return code;
  if (typeof code === 'string') {
    if (code.startsWith('usage.')) return 'usage.bad-argument';
    if (code.startsWith('env.')) return 'env.missing-tool';
    if (code.startsWith('busy.')) return 'busy.rev-conflict';
    if (code.startsWith('timeout.')) return 'timeout.ffmpeg';
  }
  return fallback;
}

const cleanPath = (at) => {
  if (typeof at !== 'string') return undefined;
  const p = at.replace(/^\/+/, '').replace(/\/+$/, '');
  return PATH_RE.test(p) ? p : undefined;
};

const cleanFix = (fix) => {
  if (!fix || typeof fix !== 'object') return undefined;
  const { op, path, value, to, applicability } = fix;
  if (!['set', 'remove', 'rename', 'add'].includes(op) || !cleanPath(path) || !['machine', 'maybe', 'placeholder', 'none'].includes(applicability)) return undefined;
  if (op === 'rename' && !(typeof to === 'string' && /^[^/#\s]+$/.test(to))) return undefined;
  return { op, path: cleanPath(path), ...(value !== undefined && (op === 'set' || op === 'add') ? { value } : {}), ...(op === 'rename' ? { to } : {}), applicability };
};

/** 一条诊断照信封契约 3.4 规整：码落到登记表，补 layer、severity，去掉多余的键 */
export function diagnostic(d, { layer = 'L1', severity = 'error' } = {}) {
  const original = d?.code;
  const code = registeredCode(original);
  const at = cleanPath(d?.at ?? d?.path);
  const fix = cleanFix(d?.fix);
  const evidence = [original !== code && typeof original === 'string' ? `原码 ${original}` : null, typeof d?.evidence === 'string' ? d.evidence : null].filter(Boolean).join('；');
  const out = {
    code, layer: ['L1', 'L2', 'L3', 'L4', 'L5'].includes(d?.layer) ? d.layer : layer,
    severity: d?.severity === 'warning' || d?.severity === 'error' ? d.severity : severity,
    ...(at ? { at } : {}),
    message: typeof d?.message === 'string' && d.message ? d.message : code,
  };
  if (d?.value !== undefined && d.value !== null) out.value = d.value;
  if (typeof d?.expected === 'string' && d.expected) out.expected = d.expected;
  if (Array.isArray(d?.atFrames) && d.atFrames.every((f) => Number.isInteger(f) && f >= 0)) out.atFrames = d.atFrames;
  if (evidence) out.evidence = evidence;
  if (typeof d?.hint === 'string' && d.hint) out.hint = d.hint;
  if (fix) out.fix = fix;
  return out;
}

const cost = (c = {}) => ({
  tokens: Math.max(0, Math.round(c.tokens ?? 0)),
  gpuSeconds: Math.max(0, Number((c.gpuSeconds ?? 0).toFixed(3))),
  wallMs: Math.max(0, Math.round(c.wallMs ?? 0)),
});

const nextOf = (next = []) => next.filter((n) => n && /^(GET|POST|PUT|DELETE) \/v1\/\S+$/.test(n.verb)).map((n) => ({ verb: n.verb, ...(n.why ? { why: n.why } : {}) }));

const outputsOf = (outputs = []) => outputs.filter((o) => o && /^[a-z][a-z0-9-]*$/.test(o.kind) && o.url).map((o) => ({
  kind: o.kind, url: o.url, ...(typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256.replace(/^sha256:/, '')) ? { sha256: o.sha256.replace(/^sha256:/, '') } : {}),
}));

/** 成功的信封 */
export function ok({ data = {}, outputs, diagnostics = [], cost: c, next } = {}) {
  return { format: 'envelope/0.1', ok: true, exitCode: 0, error: null, outputs: outputsOf(outputs), data, diagnostics: diagnostics.map((d) => diagnostic(d)), cost: cost(c), next: nextOf(next) };
}

/** 失败的信封：code 必须登记过（不是的落到近义码） */
export function fail(code, message, { hint, data = {}, outputs, diagnostics = [], cost: c, next } = {}) {
  const reg = registeredCode(code);
  const error = { code: reg, message: message || reg, ...(hint ? { hint } : {}) };
  return { format: 'envelope/0.1', ok: false, exitCode: exitCodeOf(reg), error, outputs: outputsOf(outputs), data, diagnostics: diagnostics.map((d) => diagnostic(d)), cost: cost(c), next: nextOf(next) };
}

/** 带错误码的异常：路由处理里抛它，服务端统一转成失败信封 */
export class ApiError extends Error {
  constructor(code, message, { status, hint, data, diagnostics } = {}) {
    super(message);
    this.code = registeredCode(code);
    this.status = status ?? httpStatusOf(this.code);
    this.hint = hint;
    this.data = data;
    this.diagnostics = diagnostics;
  }
}

/**
 * 把信封压进 token 上限：先从尾部丢诊断（先丢 warning），再把 data 里最长的数组截短并记 truncated，
 * 还超就只留 data 的标量字段。spill(env) 给了的话，被截的全文先交给它落盘，返回的输出项挂进 outputs。
 */
export function fitEnvelope(env, limit, spill) {
  if (!Number.isFinite(limit) || estimateTokens(env) <= limit) return env;
  const full = structuredClone(env);
  const out = structuredClone(env);
  const extra = spill ? spill(full) : null;
  if (extra) out.outputs = [...out.outputs, ...outputsOf([extra])];
  out.data = { ...out.data, truncated: true };
  const total = out.diagnostics.length;
  const order = out.diagnostics.map((d, i) => [d, i]).sort((a, b) => (a[0].severity === b[0].severity ? b[1] - a[1] : a[0].severity === 'warning' ? -1 : 1));
  while (estimateTokens(out) > limit && out.diagnostics.length > 1) {
    const [drop] = order.shift();
    out.diagnostics = out.diagnostics.filter((d) => d !== drop);
    out.data.diagnosticsTotal = total;
  }
  for (let guard = 0; estimateTokens(out) > limit && guard < 200; guard++) {
    const arrays = Object.entries(out.data).filter(([, v]) => Array.isArray(v) && v.length > 0).sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length);
    if (!arrays.length) break;
    const [key, arr] = arrays[0];
    out.data[`${key}Total`] ??= arr.length;
    out.data[key] = arr.slice(0, Math.max(0, Math.floor(arr.length / 2)));
    const n = out.data[key].length;
    if (key === 'events' && out.data.eventCounts) out.data.eventCounts.actualCount = n;
    const collection = ['items', 'entities', 'texts', 'frames', 'verbs', 'fields', 'events'].find(k => Array.isArray(out.data[k]));
    if (key === collection && 'actualCount' in out.data) out.data.actualCount = n;
    const returned = { entities: 'returnedEntities', texts: 'returnedTexts', frames: 'returnedFrames' }[key];
    if (returned && returned in out.data) out.data[returned] = n;
  }
  if (estimateTokens(out) > limit) {
    out.data = Object.fromEntries(Object.entries(out.data).filter(([, v]) => v === null || typeof v !== 'object').map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v]));
    if ('actualCount' in out.data) out.data.actualCount = 0;
    for (const key of ['returnedEntities', 'returnedTexts', 'returnedFrames']) if (key in out.data) out.data[key] = 0;
    out.data.truncated = true;
  }
  if (estimateTokens(out) > limit) {
    out.diagnostics = out.diagnostics.slice(0, 1).map((d) => ({ code: d.code, layer: d.layer, severity: d.severity, message: d.message.slice(0, 120) }));
    out.next = out.next.slice(0, 1);
  }
  // 上限很小的动词（取消作业 100 token）：再超就去掉诊断、提示和下一步，错误原因从尾部截短
  if (estimateTokens(out) > limit) {
    out.diagnostics = [];
    out.next = [];
    if (out.error) delete out.error.hint;
  }
  for (let guard = 0; out.error && estimateTokens(out) > limit && out.error.message.length > 16 && guard < 40; guard++) {
    out.error.message = `${Array.from(out.error.message.replace(/…$/, '')).slice(0, -8).join('')}…`;
  }
  return out;
}

export { CODE_RE };
