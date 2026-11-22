// 合同驱动的 HTTP 客户端：MCP 薄壳与命令行薄壳共用。入参表、校验与请求全部由 ROUTES 的一行路由推出，不手抄路由。
// 入参是一张平表：路径参数、查询参数（与路径参数或 body 重名时加 query- 前缀）、请求体 body。
import { createHash } from 'node:crypto';
import { fail } from './envelope.mjs';

const IMAGE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * 响应是不是图片：先看 content-type，再看产物名末尾的扩展名（服务端的产物一律回 application/octet-stream）。不是图片交回 null。
 * name 是解码后的产物名，不是地址：名字里的 # 和 ? 是字面量（contact#2.png），不能当地址分隔符截掉。
 */
export function imageMime(contentType, name = '') {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (Object.values(IMAGE_BY_EXT).includes(type)) return type;
  return IMAGE_BY_EXT[/\.(png|jpe?g|webp|gif)$/i.exec(String(name))?.[1].toLowerCase()] ?? null;
}

/** 认图片用的产物名（解码后的字面量）：有 name 入参就是它；没有的二进制路由用填了入参、不带查询串的路径，不拿转义过的请求地址去认 */
export const artifactName = (route, args) => String(args.name ?? route.path.replace(/\{(\w+)\}/g, (_, k) => args[k]));

/** 一个动词的入参表：{ path: [名], query: [[入参名, 查询名]], body: 请求体结构或 undefined, required: [入参名] } */
export function inputsOf(route) {
  const path = Object.keys(route.params ?? {});
  const query = Object.keys(route.query ?? {}).map((name) => [path.includes(name) || name === 'body' ? `query-${name}` : name, name]);
  const required = [...path, ...query.filter(([, name]) => route.requiredQuery?.includes(name)).map(([arg]) => arg), ...(route.request && route.bodyRequired ? ['body'] : [])];
  return { path, query, body: route.request, required };
}

/** 入参校验：只判薄壳拼请求要用的部分（多余的键、缺的必填、路径参数的类型）；请求体内容交给服务端按同一份合同判。交回原因或 null */
export function checkArgs(route, args) {
  const { path, query, body, required } = inputsOf(route);
  const known = new Set([...path, ...query.map(([arg]) => arg), ...(body ? ['body'] : [])]);
  const extra = Object.keys(args).filter((k) => !known.has(k));
  if (extra.length) return `${route.id} 不认识的入参：${extra.join('、')}（可用：${[...known].join('、') || '无'}）`;
  const lost = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (lost.length) return `${route.id} 缺少必填入参：${lost.join('、')}`;
  const badPath = path.filter((k) => !['string', 'number'].includes(typeof args[k]));
  if (badPath.length) return `${route.id} 的路径参数应为字符串：${badPath.join('、')}`;
  const scalar = (v) => ['string', 'number', 'boolean'].includes(typeof v);
  const badQuery = query.filter(([arg, name]) => args[arg] !== undefined && !scalar(args[arg]) && !(route.query[name].type === 'array' && Array.isArray(args[arg]) && args[arg].every(scalar))).map(([arg]) => arg);
  if (badQuery.length) return `${route.id} 的查询参数应为标量（合同里是数组的可以给标量数组）：${badQuery.join('、')}`;
  return null;
}

/** 命令行与 MCP 共用的服务地址：BEIMING_API_URL，没设就是 serve 的默认监听地址 */
export const defaultUrl = (env = process.env) => env.BEIMING_API_URL || 'http://127.0.0.1:8080';

/** 路由加入参拼出的地址。路径参数整段转义，带 / 的产物路径由服务端逐段解码；数组查询参数按重复键发（tags=a&tags=b） */
export function urlOf(route, args, baseUrl) {
  const search = new URLSearchParams(inputsOf(route).query.filter(([arg]) => args[arg] !== undefined).flatMap(([arg, name]) => [args[arg]].flat().map((v) => [name, String(v)])));
  return `${String(baseUrl).replace(/\/+$/, '')}${route.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(args[k]))}${search.size ? `?${search}` : ''}`;
}

/**
 * 产物地址：填进合同里 artifacts 那一行的路径模板。服务端签发引用和薄壳规整引用共用这一处。
 * 跟路由器（contract.mjs 的 matchPath）对齐：{name} 是模板末段时收多段路径，逐段转义、/ 留着；后面还有固定段时只收一个路径段，整个产物名转义成一段。
 */
export function artifactUrl(routes, id, name) {
  const { path } = routes.find((r) => r.id === 'artifacts');
  const last = path.endsWith('/{name}');
  return path.replace(/\{(\w+)\}/g, (_, k) => (k !== 'name' ? encodeURIComponent(id) : last ? String(name).split('/').map(encodeURIComponent).join('/') : encodeURIComponent(name)));
}

/** 按路由和入参发一次请求，交回 fetch 的 Response。请求带着令牌，不跟重定向：跟过去令牌就到了别的服务 */
export function callRoute(route, args, { baseUrl, token, fetchImpl = fetch }) {
  const text = route.request?.type === 'string';
  const hasBody = route.request && args.body !== undefined;
  return fetchImpl(urlOf(route, args, baseUrl), {
    method: route.method,
    redirect: 'error',
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(hasBody && { 'content-type': text ? 'text/plain; charset=utf-8' : 'application/json' }) },
    ...(hasBody && { body: text ? String(args.body) : JSON.stringify(args.body) }),
  });
}

/** 请求失败的原因：fetch 把真正的原因（ECONNREFUSED、unexpected redirect）放在 cause 里 */
export const whyOf = (e) => e.cause?.code ?? e.cause?.message ?? e.message;

/** 连不上服务，或对面不是北冥 API：登记表里没有网络类的码，归到环境不合格（env.，退出码 3） */
export const unreachable = (baseUrl, why) => fail('env.missing-tool', `北冥 API 不可用（${baseUrl}）：${why}`, { hint: '先 node beiming/api/cli.mjs serve，再用 --url 或 BEIMING_API_URL 指过去' });

/** 把响应读成信封；不是信封的（代理错误页、别的服务）落到 unreachable，不让调用方看见半截正文。
 * HTTP 状态不是 2xx 却回成功信封的也落到 unreachable：信 HTTP 状态，失败的调用不能读成成功。 */
export async function readEnvelope(res, baseUrl) {
  const text = await res.text();
  try {
    const env = JSON.parse(text);
    if (env && typeof env === 'object' && typeof env.ok === 'boolean') return env.ok && !res.ok ? unreachable(baseUrl, `HTTP ${res.status} 却回了成功信封`) : env;
  } catch { /* 落到下面的失败信封 */ }
  return unreachable(baseUrl, `HTTP ${res.status} 的响应不是信封`);
}
