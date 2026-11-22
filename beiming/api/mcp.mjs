// MCP 薄壳：把合同 ROUTES 的每个动词变成一个 MCP 工具（名字就是 route.id），经 HTTP 调真实服务，不碰制作管线。
// 工具表、入参结构与请求全部由 ROUTES 推出，改合同不用改这里。图片产物直接回 { type: 'image', data, mimeType }。
// 传输是 stdio 上每行一条 JSON-RPC 2.0 消息：node beiming/api/cli.mjs mcp --url <服务地址> --token <账户令牌>。
import { createInterface } from 'node:readline';
import { callRoute, checkArgs, defaultUrl, imageMime, inputsOf, readEnvelope, sha256Hex, unreachable, urlOf, whyOf } from './client.mjs';
import { buildOpenApi, ROUTES } from './contract.mjs';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'beiming-api', version: buildOpenApi().info.version };
const AUTH_NOTE = { account: '账户令牌', workspace: '这部片的工作区令牌', job: '作业所属那部片的工作区令牌' };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

// 冻结契约内嵌进来时带着 $schema、$id，工具入参结构里不留。
const plainSchema = (schema) => JSON.parse(JSON.stringify(schema, (key, value) => (key === '$schema' || key === '$id' ? undefined : value)));

/** 纯函数：由路由表生成 MCP 工具表，和 routes 一一对应。入参是路径参数、查询参数、请求体 body，外加可选的 _token */
export function buildMcpTools(routes = ROUTES) {
  return routes.map((route) => {
    const { path, query, body, required } = inputsOf(route);
    return {
      name: route.id,
      description: `${route.summary}（${route.method} ${route.path}，用${AUTH_NOTE[route.auth] ?? route.auth}）`,
      inputSchema: plainSchema({
        type: 'object',
        properties: {
          ...Object.fromEntries(path.map((name) => [name, route.params[name]])),
          ...Object.fromEntries(query.map(([arg, name]) => [arg, route.query[name]])),
          ...(body && { body }),
          _token: { type: 'string', description: '可选：这一次调用改用的令牌；不进请求体和查询串' },
        },
        ...(required.length && { required }),
        additionalProperties: false,
      }),
    };
  });
}

/**
 * 一个 MCP 会话：handleMessage(消息) 交回 JSON-RPC 响应，通知交回 null。
 * token 是账户令牌（或单部片的工作区令牌）；建片交回的工作区令牌和作业所属的片子自动记住，后面的调用自己选令牌。
 */
export function createMcpSession({ baseUrl = defaultUrl(), token = process.env.BEIMING_API_TOKEN, workspaceTokens = new Map(), fetchImpl = fetch, routes = ROUTES } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const tools = buildMcpTools(routes);
  const byId = new Map(routes.map((route) => [route.id, route]));
  const jobFilm = new Map();
  const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });

  const tokenFor = (route, args) => (route.auth === 'account' ? token : workspaceTokens.get(route.auth === 'job' ? jobFilm.get(args.id) : args.id) ?? token);

  /** 一份产物字节变成内容块：图片直接回 image，JSON 与文本回正文，别的二进制只回摘要 */
  async function artifactBlocks(res, url) {
    const bytes = Buffer.from(await res.arrayBuffer());
    const type = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
    const image = imageMime(type, url);
    const meta = { url, bytes: bytes.length, sha256: sha256Hex(bytes), mimeType: image ?? type };
    if (image) return [text(meta), { type: 'image', data: bytes.toString('base64'), mimeType: image }];
    if (!image && /json$|^text\//.test(type)) return [text(bytes.toString('utf8'))];
    return [text({ binary: true, ...meta })];
  }

  /**
   * 引用（地址或路径）落在本服务的产物地址上时交回 [片号, 规整后的路径]；别的服务、不是产物地址、带 .. 的越界路径交回 null。
   * 产物地址的样子每次从合同里 artifacts 那一行的路径模板推出，不在这里另抄一份。
   */
  function artifactRef(ref) {
    try {
      const template = byId.get('artifacts').path;
      const shape = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, k) => `(?<${k}>${k === 'name' ? '.+' : '[^/]+'})`)}$`);
      const root = new URL(`${base}/`);
      const url = new URL(ref, root);
      const path = url.pathname.startsWith(root.pathname) ? url.pathname.slice(root.pathname.length - 1) : url.pathname;
      const { id, name } = shape.exec(path).groups;
      const segs = decodeURIComponent(name).split('/');
      if (url.origin !== root.origin || segs.some((s) => !s || s === '.' || s === '..' || s.includes('\\'))) return null;
      return [decodeURIComponent(id), template.replace(/\{(\w+)\}/g, (_, k) => (k === 'name' ? segs.map(encodeURIComponent).join('/') : id))];
    } catch {
      return null;
    }
  }

  /**
   * 成功信封里的图片产物（联系表、切点条带）用同一个令牌取回来，一张不少、按出现的顺序、同一张只取一次。
   * 引用从顶层 outputs 和 data.sheet / data.strips / data.outputs 里找；信封被截短时先读挂在 outputs 里的全文。
   * 只取 film 这部片的；片号不知道时（重启后直接查作业）认第一个引用的那部片。
   * 交回 { blocks, incomplete }：某一张取不回来只在它的位置留一条诊断，后面的照取；全文取不回来 incomplete 为 true。
   */
  async function outputImages(env, bearer, film) {
    // 路径都是 artifactRef 规整过的本服务路径；带着令牌，不跟重定向。
    const get = (path) => fetchImpl(`${base}${path}`, { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${bearer}` } });
    const mine = (ref) => {
      const hit = artifactRef(ref);
      return hit && hit[0] === String(film ??= hit[0]) ? hit[1] : null;
    };
    const blocks = [];
    let incomplete = false;
    const full = env.outputs?.find((o) => o?.kind === 'response')?.url;
    if (full) {
      try {
        const path = mine(full);
        if (!path) throw new Error('全文引用不是本服务这部片的产物地址');
        const res = await get(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!isObject(body)) throw new Error('全文不是信封');
        env = body;
      } catch (e) {
        incomplete = true;
        blocks.push(text({ url: full, fullOutputError: `信封被截短，全文没取回来：${whyOf(e)}` }));
      }
    }
    const refs = [env.outputs, env.data?.sheet, env.data?.strips, env.data?.outputs].flatMap(strings);
    for (const path of new Set(refs.map(mine).filter((p) => p && imageMime('', p)))) {
      try {
        const res = await get(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blocks.push(...await artifactBlocks(res, path));
      } catch (e) {
        blocks.push(text({ url: path, error: whyOf(e) }));
      }
    }
    return { blocks, incomplete };
  }

  async function callTool(route, args, override) {
    const bearer = override ?? tokenFor(route, args);
    const res = await callRoute(route, args, { baseUrl, token: bearer, fetchImpl });
    if (route.binary && res.ok) return { content: await artifactBlocks(res, urlOf(route, args, '')) };
    const env = await readEnvelope(res, baseUrl);
    // 建片（账户动词）交回片号、工作区令牌，委托模式还有作业号；工作区动词交回作业号。都记下，后面的调用自己选令牌。
    const str = (...vs) => vs.find((v) => typeof v === 'string');
    const made = env.ok ? str(env.data?.film, env.data?.filmId) : undefined;
    if (made && typeof env.data.token === 'string') workspaceTokens.set(made, env.data.token);
    const owner = route.auth === 'workspace' ? args.id : route.auth === 'account' ? made : undefined;
    // 失败信封也可能带着还能接着查的作业号，归属照记。
    const job = str(env.data?.job, env.data?.job?.id, env.data?.jobId);
    if (job && owner) jobFilm.set(job, owner);
    if (!env.ok) return { content: [text(env)], isError: true };
    const { blocks, incomplete } = await outputImages(env, bearer, route.auth === 'workspace' ? args.id : jobFilm.get(args.id));
    return { content: [text(env), ...blocks], isError: incomplete };
  }

  async function handleMessage(msg) {
    // id 只能是字符串、数字或 null；不合规的 id 不回显。
    const idOk = isObject(msg) && (msg.id === undefined || msg.id === null || ['string', 'number'].includes(typeof msg.id));
    if (!idOk || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(idOk ? msg.id : null, -32600, 'Invalid Request');
    const { id, method } = msg;
    if (id === undefined) return null;
    if (msg.params !== undefined && !isObject(msg.params)) return error(id, -32602, 'params 应为对象');
    const params = msg.params ?? {};
    switch (method) {
      case 'initialize': return reply(id, { protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      case 'ping': return reply(id, {});
      case 'tools/list': return reply(id, { tools });
      case 'tools/call': {
        const route = byId.get(params.name);
        if (!route) return error(id, -32602, `Unknown tool: ${params.name}`);
        // 省略 arguments 当空对象；显式给 null、数组或原始值是入参错误，不调上游。
        const given = params.arguments === undefined ? {} : params.arguments;
        if (!isObject(given)) return error(id, -32602, 'arguments 应为对象');
        const { _token, ...args } = given;
        if (_token !== undefined && typeof _token !== 'string') return error(id, -32602, '_token 应为字符串');
        const why = checkArgs(route, args);
        if (why) return error(id, -32602, why);
        try {
          return reply(id, await callTool(route, args, _token));
        } catch (e) {
          return reply(id, { content: [text(unreachable(baseUrl, whyOf(e)))], isError: true });
        }
      }
      default: return error(id, -32601, `Method not found: ${method}`);
    }
  }

  return { tools, handleMessage };
}

/** 在 stdio 上跑 MCP：每行一条消息，读到输入结束并等在途调用回完后返回 */
export async function serveMcpStdio({ input = process.stdin, output = process.stdout, ...options } = {}) {
  const session = createMcpSession(options);
  const pending = new Set();
  const send = (msg) => { if (msg) output.write(`${JSON.stringify(msg)}\n`); };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    // 不等上一个调用回完就读下一行：长轮询的作业不挡 ping。
    const task = session.handleMessage(msg).then(send, (e) => send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: e.message } })).finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}
