// MCP 薄壳：把合同 ROUTES 的每个动词变成一个 MCP 工具（名字就是 route.id），经 HTTP 调真实服务，不碰制作管线。
// 工具表、入参结构与请求全部由 ROUTES 推出，改合同不用改这里。图片产物直接回 { type: 'image', data, mimeType }。
// 传输是 stdio 上每行一条 JSON-RPC 2.0 消息：node beiming/api/cli.mjs mcp --url <服务地址> --token <账户令牌>。
import { createInterface } from 'node:readline';
import { callRoute, checkArgs, defaultUrl, imageMime, inputsOf, readEnvelope, sha256Hex, unreachable, urlOf } from './client.mjs';
import { buildOpenApi, ROUTES } from './contract.mjs';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'beiming-api', version: buildOpenApi().info.version };
const AUTH_NOTE = { account: '账户令牌', workspace: '这部片的工作区令牌', job: '作业所属那部片的工作区令牌' };
const ARTIFACT_URL = /^\/v1\/films\/[^/]+\/artifacts\/.+/;
// shortcut: 单张图超过 5 MiB 只回摘要、一个信封最多带回 8 张图，模型上下文放不下更多；要原件用命令行薄壳的 --out 落盘
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 8;

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
    if (image && bytes.length <= MAX_IMAGE_BYTES) return [text(meta), { type: 'image', data: bytes.toString('base64'), mimeType: image }];
    if (!image && /json$|^text\//.test(type)) return [text(bytes.toString('utf8'))];
    return [text({ binary: true, ...meta })];
  }

  /** 信封 outputs 里的图片产物（联系表、切点条带）用同一个令牌取回来；信封被截短时先读挂在 outputs 里的全文 */
  async function outputImages(env, bearer) {
    const get = (url) => fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}${url}`, { method: 'GET', headers: { authorization: `Bearer ${bearer}` } });
    const blocks = [];
    try {
      let outputs = env.outputs ?? [];
      const full = outputs.find((o) => o.kind === 'response' && ARTIFACT_URL.test(o.url));
      if (full) {
        const res = await get(full.url);
        if (res.ok) outputs = (await res.json()).outputs ?? outputs;
      }
      for (const o of outputs.filter((o) => ARTIFACT_URL.test(o.url) && imageMime('', o.url)).slice(0, MAX_IMAGES)) {
        const res = await get(o.url);
        blocks.push(...(res.ok ? await artifactBlocks(res, o.url) : [text({ url: o.url, error: `HTTP ${res.status}` })]));
      }
    } catch (e) {
      // 动词本身已经成功，图取不回来不改它的结果，只把原因交回去。
      blocks.push(text({ imagesError: e.message }));
    }
    return blocks;
  }

  async function callTool(route, args, override) {
    const bearer = override ?? tokenFor(route, args);
    const res = await callRoute(route, args, { baseUrl, token: bearer, fetchImpl });
    if (route.binary && res.ok) return { content: await artifactBlocks(res, urlOf(route, args, '')) };
    const env = await readEnvelope(res, baseUrl);
    if (env.ok && typeof env.data?.film === 'string' && typeof env.data?.token === 'string') workspaceTokens.set(env.data.film, env.data.token);
    if (route.auth === 'workspace' && typeof env.data?.job === 'string') jobFilm.set(env.data.job, args.id);
    return { content: [text(env), ...(env.ok ? await outputImages(env, bearer) : [])], isError: !res.ok || env.ok !== true };
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(msg?.id, -32600, 'Invalid Request');
    const { id, method } = msg;
    const params = msg.params ?? {};
    if (id === undefined) return null;
    switch (method) {
      case 'initialize': return reply(id, { protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      case 'ping': return reply(id, {});
      case 'tools/list': return reply(id, { tools });
      case 'tools/call': {
        const route = byId.get(params.name);
        if (!route) return error(id, -32602, `Unknown tool: ${params.name}`);
        const given = params.arguments ?? {};
        if (typeof given !== 'object' || Array.isArray(given)) return error(id, -32602, 'arguments 应为对象');
        const { _token, ...args } = given;
        if (_token !== undefined && typeof _token !== 'string') return error(id, -32602, '_token 应为字符串');
        const why = checkArgs(route, args);
        if (why) return error(id, -32602, why);
        try {
          return reply(id, await callTool(route, args, _token));
        } catch (e) {
          return reply(id, { content: [text(unreachable(baseUrl, e.cause?.code ?? e.message))], isError: true });
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
