import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tools as mediaTools } from '../comp/index.mjs';
import { issueAccountToken } from './auth.mjs';
import { matchRoute, ROUTES } from './contract.mjs';
import { encodePng } from '../observe/sheet.mjs';
import { fail, ok } from './envelope.mjs';
import { startServer } from './server.mjs';
import { buildMcpTools, createMcpSession } from './mcp.mjs';
import { buildCliCommands, exitCodeForEnvelope, runApiCli } from './cli-shell.mjs';

test('A9-1 MCP 与 CLI 两个薄壳与 ROUTES 动词严格 1:1 对应，且动态新增合同路由无需手改即生效', () => {
  const mcpTools = buildMcpTools(ROUTES);
  const cliCmds = buildCliCommands(ROUTES);
  assert.deepEqual(
    mcpTools.map((t) => t.name),
    ROUTES.map((r) => r.id),
  );
  assert.deepEqual(
    cliCmds.map((c) => c.id),
    ROUTES.map((r) => r.id),
  );

  const extended = [
    ...ROUTES,
    {
      id: 'custom-ping',
      method: 'POST',
      path: '/v1/custom/{slug}',
      auth: 'account',
      tokens: 100,
      summary: '动态测试路由',
      params: { slug: { type: 'string' } },
      request: { type: 'object', properties: { count: { type: 'integer' } }, additionalProperties: false },
      response: { type: 'object' },
    },
  ];
  assert.equal(buildMcpTools(extended).at(-1).name, 'custom-ping');
  assert.equal(buildCliCommands(extended).at(-1).id, 'custom-ping');
});

test('A9-2 MCP 直接回图片内容（artifacts PNG/JPEG 与 observe-sheet 联系表图片）', async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const session = createMcpSession({
    baseUrl: 'http://127.0.0.1:19999',
    token: 'acct-tok',
    workspaceTokens: new Map([['f_1', 'ws-tok']]),
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.authorization || init.headers.Authorization, 'Bearer ws-tok');
      if (String(url).endsWith('/artifacts/contact.png')) {
        return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const res = await session.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'artifacts', arguments: { id: 'f_1', name: 'contact.png' } },
  });
  const imgBlock = res.result.content.find((c) => c.type === 'image');
  assert.ok(imgBlock, 'MCP 应直接返回 type=image 内容块');
  assert.equal(imgBlock.mimeType, 'image/png');
  assert.equal(imgBlock.data, pngBytes.toString('base64'));
});

test('A9-3 CLI 薄壳按冻结错误码表映射退出码（0 / 1 / 2 / 3 / 4 / 5 / 124）', () => {
  assert.equal(exitCodeForEnvelope({ ok: true }), 0);
  assert.equal(exitCodeForEnvelope({ ok: false, error: { code: 'usage.bad-argument' } }), 2);
  assert.equal(exitCodeForEnvelope({ ok: false, error: { code: 'env.missing-binary' } }), 3);
  assert.equal(exitCodeForEnvelope({ ok: false, error: { code: 'contract.unknown-key' } }), 4);
  assert.equal(exitCodeForEnvelope({ ok: false, error: { code: 'busy.rev-conflict' } }), 5);
  assert.equal(exitCodeForEnvelope({ ok: false, error: { code: 'timeout.job' } }), 124);
  assert.equal(typeof runApiCli, 'function');
});

/* ---------------- 以下对真实启动的 startServer 端到端 ---------------- */

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const MP4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0xff, 0xfe, 0x80]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const typo = { format: 'patch/0.1', rev: 1, ops: [{ op: 'set', path: 'titele', value: 'X' }] };
let root, api, account;
const tempVariable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
const previousTemp = process.env[tempVariable];

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'beiming-shells-'));
  process.env[tempVariable] = root;
  account = issueAccountToken(root);
  api = await startServer({ dataDir: root, port: 0, reviewer: null });
});
after(async () => {
  await api?.close();
  if (previousTemp === undefined) delete process.env[tempVariable];
  else process.env[tempVariable] = previousTemp;
  if (root) rmSync(root, { recursive: true, force: true });
});

/** 往一部片的只读产物目录放一个文件（服务端按 deliver/ 下的相对路径交出去） */
function putArtifact(film, name, bytes) {
  const file = join(root, 'films', film, 'deliver', name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, bytes);
}

/** 异步跑命令行（服务端和测试同进程，不能用同步子进程堵住事件循环）。交回 { code, stdout, stderr } */
const cli = (args, { url = api.url, token, encoding = 'utf8', timeout } = {}) => new Promise((done) => {
  const env = { ...process.env, BEIMING_API_URL: url };
  delete env.BEIMING_API_TOKEN;
  if (token) env.BEIMING_API_TOKEN = token;
  execFile(process.execPath, [CLI, ...args], { env, encoding, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }));
});
const cliJson = async (args, opts) => {
  const out = await cli(args, opts);
  return { code: out.code, env: JSON.parse(out.stdout) };
};
const textOf = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);

/** 起一个真实的 MCP stdio 子进程：rpc 发请求等回应，send 原样写一行，stray 收没人等的回应，close 关输入并交回退出码 */
function mcpStdio(url, token) {
  const child = spawn(process.execPath, [CLI, 'mcp', '--url', url, '--token', token], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  const stray = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const take = waiting.get(msg.id);
    if (take) take(msg); else stray.push(msg);
  });
  let seq = 0;
  const send = (msg) => child.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  const rpc = (method, params) => new Promise((done) => {
    const id = ++seq;
    waiting.set(id, done);
    send({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
  });
  const callTool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const close = async () => {
    child.stdin.end();
    await new Promise((done) => (child.exitCode === null ? child.once('exit', done) : done()));
    return child.exitCode;
  };
  return { rpc, send, callTool, stray, close };
}

/** 只回固定响应的回环 HTTP 服务：reply(地址, 请求) 交回 [状态码, 正文]，正文是 Buffer 按文件字节回，别的按 JSON 回。hits 记下每次请求 */
async function stubApi(reply) {
  const hits = [];
  const server = createServer((req, res) => {
    req.resume();
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const [status, body] = reply(req.url, req);
    res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' });
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((done) => server.close(done)) };
}

test('A9-4 MCP stdio 子进程对真实服务：initialize、tools/list、tools/call、图片与二进制产物、令牌衔接、JSON-RPC 错误码', async () => {
  const { rpc, send, callTool, stray, close } = mcpStdio(api.url, account);
  try {
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).result;
    assert.equal(init.protocolVersion, '2025-06-18');
    assert.deepEqual(init.capabilities, { tools: {} });
    assert.equal(init.serverInfo.name, 'beiming-api');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.deepEqual((await rpc('ping')).result, {});
    assert.deepEqual(stray, [], '通知不回消息');

    const listed = (await rpc('tools/list')).result.tools;
    assert.deepEqual(listed.map((t) => t.name), ROUTES.map((r) => r.id));
    for (const tool of listed) {
      assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
      assert.equal(tool.inputSchema.type, 'object');
      assert.doesNotMatch(JSON.stringify(tool.inputSchema), /"\$(schema|id)"/);
    }
    assert.deepEqual(listed.find((t) => t.name === 'film-put').inputSchema.required, ['id', 'body']);

    const guide = await callTool('guide');
    assert.equal(guide.isError, false);
    assert.equal(textOf(guide).data.verbs.length, ROUTES.length);

    // 建片交回的工作区令牌自动记住：后面的工作区动词不用再带令牌。
    const film = textOf(await callTool('films-create', { body: {} })).data.film;
    const got = await callTool('film-get', { id: film });
    assert.equal(got.isError, false);
    assert.equal(textOf(got).data.rev, 1);
    const other = textOf(await callTool('films-create', { body: {} })).data.film;
    assert.equal(textOf(await callTool('film-get', { id: other })).data.film.id, other);

    putArtifact(film, 'shot.png', PNG);
    putArtifact(film, 'photo.jpg', JPEG);
    putArtifact(film, 'sheets/rev1-draft/contact.png', PNG);
    putArtifact(film, 'clip.mp4', MP4);
    putArtifact(film, 'report.json', '{"hello":"world"}');
    for (const [name, bytes, mimeType] of [['shot.png', PNG, 'image/png'], ['photo.jpg', JPEG, 'image/jpeg'], ['sheets/rev1-draft/contact.png', PNG, 'image/png']]) {
      const result = await callTool('artifacts', { id: film, name });
      const image = result.content.find((c) => c.type === 'image');
      assert.deepEqual(image, { type: 'image', data: bytes.toString('base64'), mimeType }, name);
      assert.deepEqual([textOf(result).bytes, textOf(result).sha256, textOf(result).mimeType], [bytes.length, sha(bytes), mimeType]);
    }
    const clip = await callTool('artifacts', { id: film, name: 'clip.mp4' });
    assert.deepEqual(clip.content.map((c) => c.type), ['text']);
    assert.deepEqual(textOf(clip), { binary: true, url: `/v1/films/${film}/artifacts/clip.mp4`, bytes: MP4.length, sha256: sha(MP4), mimeType: 'application/octet-stream' });
    assert.deepEqual(textOf(await callTool('artifacts', { id: film, name: 'report.json' })), { hello: 'world' });

    // 失败信封原样交回并标 isError；_token 只换这一次调用的令牌。
    const rejected = await callTool('film-put', { id: film, body: typo });
    assert.equal(rejected.isError, true);
    assert.equal(textOf(rejected).error.code, 'contract.unknown-key');
    assert.ok(textOf(rejected).diagnostics.length > 0);
    const denied = await callTool('film-get', { id: film, _token: account });
    assert.equal(denied.isError, true);
    assert.equal(textOf(denied).error.code, 'auth.base-readonly');
    assert.equal((await callTool('film-get', { id: film })).isError, false);
    const missing = await callTool('artifacts', { id: film, name: 'absent.png' });
    assert.equal(missing.isError, true);
    assert.equal(missing.content.some((c) => c.type === 'image'), false);

    // 作业归属自动记住：job 动词用作业所属那部片的工作区令牌。
    const job = textOf(await callTool('render', { id: film, body: { tier: 'draft' } })).data.job;
    assert.match(job, /^j-\d+$/);
    assert.equal(textOf(await callTool('job-get', { id: job })).data.job, job);
    assert.equal(textOf(await callTool('job-delete', { id: job })).data.job, job);

    assert.equal((await rpc('nope/method')).error.code, -32601);
    assert.equal((await rpc('tools/call', { name: 'nope' })).error.code, -32602);
    assert.equal((await rpc('tools/call', { name: 'film-get', arguments: {} })).error.code, -32602);
    assert.equal((await rpc('tools/call', { name: 'film-get', arguments: { id: film, bogus: 1 } })).error.code, -32602);
    send('{not json');
    assert.equal((await rpc('ping')).result !== undefined, true);
    assert.deepEqual(stray.map((m) => [m.id, m.error.code]), [[null, -32700]]);
  } finally {
    assert.equal(await close(), 0);
  }
});

test('A9-5 MCP 动态新增路由直接能调；信封被截短时从全文里找回联系表与切点条带图片', async () => {
  const custom = { id: 'custom-ping', method: 'POST', path: '/v1/custom/{slug}', auth: 'account', tokens: 100, summary: '动态测试路由', params: { slug: { type: 'string' } }, query: { slug: { type: 'string' } }, request: { type: 'object', properties: { count: { type: 'integer' } } } };
  const seen = [];
  const full = { ok: true, outputs: [{ kind: 'contact', url: '/v1/films/f_9/artifacts/sheets/rev1-draft/contact.png' }, { kind: 'cut-strip', url: '/v1/films/f_9/artifacts/sheets/rev1-draft/cuts/cut-12.jpeg' }, { kind: 'report', url: '/v1/films/f_9/artifacts/report.json' }] };
  const { createMcpSession } = await import('./mcp.mjs');
  const session = createMcpSession({
    baseUrl: 'http://stub.invalid/', token: 'acct', workspaceTokens: new Map([['f_9', 'ws-9']]), routes: [...ROUTES, custom],
    fetchImpl: async (url, init) => {
      seen.push([init.method, String(url), init.headers.authorization, init.body]);
      const path = new URL(url).pathname;
      if (path === '/v1/custom/a%2Fb') return Response.json({ ok: true, outputs: [], data: { pong: true } });
      if (path.endsWith('/observe/sheet')) return Response.json({ ok: true, data: { truncated: true }, outputs: [{ kind: 'response', url: '/v1/films/f_9/artifacts/response-abc.json' }] });
      if (path.endsWith('/response-abc.json')) return Response.json(full);
      if (/\.(png|jpeg)$/.test(path)) return new Response(path.endsWith('.png') ? PNG : JPEG, { headers: { 'content-type': 'application/octet-stream' } });
      throw new Error(`unexpected url: ${url}`);
    },
  });
  const call = async (name, args) => (await session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  const pong = await call('custom-ping', { slug: 'a/b', 'query-slug': 'q', body: { count: 2 } });
  assert.equal(textOf(pong).data.pong, true);
  assert.deepEqual(seen[0], ['POST', 'http://stub.invalid/v1/custom/a%2Fb?slug=q', 'Bearer acct', '{"count":2}']);
  const sheet = await call('observe-sheet', { id: 'f_9', body: { cuts: true } });
  assert.equal(sheet.isError, false);
  assert.deepEqual(sheet.content.filter((c) => c.type === 'image'), [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }, { type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' }]);
  assert.ok(seen.slice(1).every(([, , auth]) => auth === 'Bearer ws-9'));
});

function sheetSkip() {
  const { ffmpeg, ffprobe } = mediaTools();
  for (const [name, bin] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) if (!bin || spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 20000 }).status !== 0) return `缺少可执行的 ${name}`;
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  return spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 30000 }).status !== 0 && '无头浏览器不可执行';
}

test('A9-6 MCP 对真实服务渲帧后 observe-sheet 直接回联系表图片', { skip: sheetSkip(), timeout: 300000 }, async () => {
  const { createMcpSession } = await import('./mcp.mjs');
  const session = createMcpSession({ baseUrl: api.url, token: account });
  let seq = 0;
  const call = async (name, args) => (await session.handleMessage({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } })).result;
  const film = textOf(await call('films-create', { body: { output: { size: [320, 180], fps: '24/1', frames: 12 } } })).data.film;
  let job = textOf(await call('render', { id: film, wait: 30, body: { tier: 'draft' } }));
  while (['queued', 'running'].includes(job.data.status)) job = textOf(await call('job-get', { id: job.data.job, wait: 30 }));
  assert.equal(job.data.status, 'succeeded', JSON.stringify(job));
  const sheet = await call('observe-sheet', { id: film, body: {} });
  assert.equal(sheet.isError, false, JSON.stringify(sheet.content[0]));
  const env = textOf(sheet);
  const image = sheet.content.find((c) => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  const bytes = Buffer.from(image.data, 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(sha(bytes), env.outputs.find((o) => o.kind === 'contact').sha256);
  assert.deepEqual(bytes, readFileSync(join(root, 'films', film, 'deliver', new URL(env.outputs[0].url, api.url).pathname.split('/artifacts/')[1])));
});

test('A9-7 CLI 全部动词经服务端自己的路由匹配能对回原动词；每个动词有 --help', async () => {
  const { runApiCli } = await import('./cli-shell.mjs');
  const sink = () => { const chunks = []; return { write: (c) => chunks.push(c), text: () => chunks.join('') }; };
  const body = join(root, 'body.txt');
  writeFileSync(body, '{}');
  for (const route of ROUTES) {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push([init.method, new URL(url)]); return Response.json({ ok: true }); };
    const flags = [...Object.keys(route.params ?? {}).flatMap((k) => [`--${k}`, 'x/y']), ...(route.requiredQuery ?? []).flatMap((k) => [`--${k}`, 'q']), ...(route.request ? ['--body-file', body] : [])];
    const out = sink();
    assert.equal(await runApiCli([route.id, ...flags, '--url', 'http://stub.invalid', '--token', 't'], { fetchImpl, stdout: out, env: {} }), 0, `${route.id} ${out.text()}`);
    const [method, url] = seen[0];
    const match = matchRoute(method, url.pathname);
    assert.equal(match.route?.id, route.id);
    for (const k of Object.keys(route.params ?? {})) assert.equal(match.params[k], 'x/y');
    const help = sink();
    assert.equal(await runApiCli([route.id, '--help'], { stdout: help, env: {} }), 0);
    assert.ok(help.text().includes(`${route.method} ${route.path}`) && help.text().includes(route.summary));
  }
  const extended = [...ROUTES, { id: 'custom-ping', method: 'POST', path: '/v1/custom/{slug}', auth: 'account', summary: '动态测试路由', params: { slug: { type: 'string' } }, request: { type: 'object', properties: { count: { type: 'integer' } } } }];
  const seen = [];
  const out = sink();
  const code = await runApiCli(['custom-ping', '--slug', 's', '--json', '{"count":3}', '--token', 't'], { routes: extended, stdout: out, env: { BEIMING_API_URL: 'http://stub.invalid' }, fetchImpl: async (url, init) => { seen.push([init.method, String(url), init.body]); return Response.json({ ok: true }); } });
  assert.equal(code, 0);
  assert.deepEqual(seen, [['POST', 'http://stub.invalid/v1/custom/s', '{"count":3}']]);
  assert.throws(() => buildCliCommands([{ id: 'bad', method: 'GET', path: '/v1/bad/{url}', params: { url: { type: 'string' } } }]), /重名/);
});

test('A9-8 CLI 子进程对真实服务：成功、--out 落盘、上传、冻结错误码到退出码 2 / 3 / 4 / 5 / 124', { timeout: 120000 }, async () => {
  const verbs = await cli(['--list-verbs']);
  assert.equal(verbs.code, 0);
  assert.deepEqual(verbs.stdout.trim().split('\n'), ROUTES.map((r) => r.id));
  assert.match((await cli(['artifacts', '--help'])).stdout, /--out/);

  const guide = await cliJson(['guide'], { token: account });
  assert.deepEqual([guide.code, guide.env.ok, guide.env.data.verbs.length], [0, true, ROUTES.length]);
  const made = await cliJson(['films-create', '--json', '{}', '--token', account]);
  assert.equal(made.code, 0, JSON.stringify(made.env));
  const { film, token } = made.env.data;
  assert.equal((await cliJson(['film-get', '--id', film], { token })).env.data.rev, 1);
  assert.equal((await cliJson(['explain', '--id', film, '--path', 'output/frames'], { token })).env.data.value, 60);
  assert.equal((await cliJson(['cards-search', '--json', '{"q":"title","limit":1}'], { token: account })).env.data.items.length, 1);

  // 上传：--file 自动 base64 并用文件名；镜头脚本走文本请求体（默认工作区不收脚本，对到 contract. 的 4）。
  const mesh = join(root, 'mesh.stl');
  writeFileSync(mesh, 'solid mesh\nendsolid mesh\n');
  const upload = await cliJson(['film-assets', '--id', film, '--file', mesh], { token });
  assert.deepEqual([upload.code, upload.env.data.asset, upload.env.data.sha256], [0, 'assets/mesh.stl', sha(readFileSync(mesh))]);
  const script = await cliJson(['film-files', '--id', film, '--path', 'shots/test.py', '--text', 'pass'], { token });
  assert.deepEqual([script.code, script.env.error.code], [4, 'contract.unsupported-mode']);

  // 二进制产物：--out 落盘只回摘要；不带 --out 字节原样到标准输出；失败时不留文件。
  putArtifact(film, 'sheets/shot.png', PNG);
  const dest = join(root, 'out.png');
  const saved = await cliJson(['artifacts', '--id', film, '--name', 'sheets/shot.png', '--out', dest], { token });
  assert.equal(saved.code, 0);
  assert.deepEqual(saved.env.data, { out: dest, bytes: PNG.length, sha256: sha(PNG), mimeType: 'image/png' });
  assert.deepEqual(readFileSync(dest), PNG);
  assert.deepEqual((await cli(['artifacts', '--id', film, '--name', 'sheets/shot.png'], { token, encoding: 'buffer' })).stdout, PNG);
  const lost = await cliJson(['artifacts', '--id', film, '--name', 'absent.png', '--out', join(root, 'absent.png')], { token });
  assert.deepEqual([lost.code, lost.env.error.code, existsSync(join(root, 'absent.png'))], [2, 'usage.bad-argument', false]);

  // 2：薄壳自己判的用法错误和服务端的 usage.*。
  for (const args of [['film-get'], ['film-get', '--id', film, '--bogus', '1'], ['nope'], [], ['film-put', '--id', film, '--json', '{bad'], ['film-put', '--id', film, '--json', '{}', '--body-file', mesh]]) {
    const out = await cliJson(args, { token });
    assert.deepEqual([out.code, out.env.error.code, out.env.exitCode], [2, 'usage.bad-argument', 2], args.join(' '));
  }
  assert.equal((await cliJson(['guide'])).code, 2, '没有令牌');
  assert.equal((await cliJson(['card-get', '--id', 'no.such.card'], { token: account })).code, 2);
  assert.equal((await cliJson(['explain', '--id', film, '--path', 'title'], { token })).code, 2, '默认片的 title 没有生效值');
  // 4：contract.* 与 auth.*。
  const rev = upload.env.data.rev;
  const rejected = await cliJson(['film-put', '--id', film, '--json', JSON.stringify({ ...typo, rev })], { token });
  assert.deepEqual([rejected.code, rejected.env.error.code], [4, 'contract.unknown-key']);
  assert.equal((await cliJson(['film-get', '--id', film], { token: account })).code, 4);
  // applyFixes 查询参数：机器修法把上一条的错键改对。
  const fixed = await cliJson(['film-put', '--id', film, '--applyFixes', 'machine', '--json', JSON.stringify({ rev })], { token });
  assert.deepEqual([fixed.code, fixed.env.data.rev], [0, rev + 1]);
  // 5：busy.rev-conflict。
  const stale = await cliJson(['film-put', '--id', film, '--json', JSON.stringify({ ...typo, rev })], { token });
  assert.deepEqual([stale.code, stale.env.error.code, stale.env.data.latestRev], [5, 'busy.rev-conflict', rev + 1]);
  // 3：真实服务的 env.*（查找表缺失），以及连不上服务。
  const lut = await cliJson(['film-put', '--id', film, '--json', JSON.stringify({ format: 'patch/0.1', rev: rev + 1, ops: [{ op: 'set', path: 'style/view/scene', value: 'absent-lut' }] })], { token });
  assert.equal(lut.code, 3, JSON.stringify(lut.env));
  assert.match(lut.env.error.code, /^env\./);

  // 124 与对面不是北冥 API：真实服务造不出超时，用一个只回固定响应的 HTTP 服务。
  const stub = createServer((req, res) => {
    const timeout = req.url.startsWith('/v1/guide');
    res.writeHead(timeout ? 504 : 502, { 'content-type': timeout ? 'application/json' : 'text/html' });
    res.end(timeout ? JSON.stringify(fail('timeout.ffmpeg', '编码超时')) : '<h1>Bad Gateway</h1>');
  });
  await new Promise((done) => stub.listen(0, '127.0.0.1', done));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  try {
    assert.deepEqual([(await cliJson(['guide'], { url: stubUrl, token: account })).code, (await cliJson(['ledger', '--id', film], { url: stubUrl, token })).code], [124, 3]);
  } finally {
    await new Promise((done) => stub.close(done));
  }
  const down = await cliJson(['guide', '--url', stubUrl], { token: account });
  assert.deepEqual([down.code, down.env.error.code], [3, 'env.missing-tool']);
});

test('A9-9 原有 issue-token 与 serve 子命令照旧：两个进程、同一数据目录', { timeout: 60000 }, async () => {
  const dataDir = mkdtempSync(join(root, 'serve-'));
  // 账户名故意取一个动词名：不能被当成薄壳子命令。
  const issued = await cli(['issue-token', '--data-dir', dataDir, '--name', 'guide']);
  assert.equal(issued.code, 0);
  assert.match(issued.stdout.trim(), /^bma_[0-9a-f]{48}$/);
  const bad = await cli(['serve', 'extra', '--data-dir', dataDir]);
  assert.deepEqual([bad.code, bad.stdout], [2, '']);
  assert.match(bad.stderr, /issue-token\|serve/);
  const child = spawn(process.execPath, [CLI, '--data-dir', dataDir, 'serve', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const url = await new Promise((done, reject) => {
      createInterface({ input: child.stdout }).once('line', done);
      child.once('exit', (code) => reject(new Error(`serve 提前退出：${code}`)));
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const guide = await cliJson(['guide'], { url, token: issued.stdout.trim() });
    assert.deepEqual([guide.code, guide.env.ok], [0, true]);
  } finally {
    child.kill('SIGTERM');
    await new Promise((done) => (child.exitCode === null ? child.once('exit', done) : done()));
  }
});

test('A9-10 README 不超过 1500 token，细则在 DETAILS.md', () => {
  const readme = readFileSync(new URL('./README.md', import.meta.url));
  assert.ok(Math.ceil(readme.length / 3.5) <= 1500, `README 估算 ${Math.ceil(readme.length / 3.5)} token`);
  assert.ok(readme.includes('./DETAILS.md') && existsSync(new URL('./DETAILS.md', import.meta.url)));
});

/* ---------------- 二轮回归：一审 G_REV-R1-A9 的 6 项 ---------------- */

test('A9-11 MCP 大图与多图完整直返：5.5 MiB 以上的 PNG 和同一信封的 9 张图一张不少、按序交回', { timeout: 120000 }, async () => {
  const rgb = Buffer.alloc(1400 * 1400 * 3);
  for (let i = 0, x = 1; i < rgb.length; i++) rgb[i] = (x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 16;
  const big = encodePng({ width: 1400, height: 1400, rgb });
  assert.ok(big.length > 5.5 * 1024 * 1024, `夹具只有 ${big.length} 字节`);
  const real = mcpStdio(api.url, account);
  try {
    const film = textOf(await real.callTool('films-create', { body: {} })).data.film;
    putArtifact(film, 'big.png', big);
    const result = await real.callTool('artifacts', { id: film, name: 'big.png' });
    const image = result.content.find((c) => c.type === 'image');
    assert.equal(image?.mimeType, 'image/png', result.content[0].text);
    assert.ok(Buffer.from(image.data, 'base64').equals(big), '大图逐字节相同');
    assert.deepEqual([textOf(result).bytes, textOf(result).sha256], [big.length, sha(big)]);
  } finally {
    assert.equal(await real.close(), 0);
  }

  // 每张图在 PNG 后面跟上自己的地址，用来核对顺序。
  const urls = Array.from({ length: 9 }, (_, i) => `/v1/films/f_9/artifacts/sheets/cut-${i}.png`);
  const stub = await stubApi((url) => (url.endsWith('/observe/sheet') ? [200, ok({ outputs: urls.map((u) => ({ kind: 'cut-strip', url: u })) })] : [200, Buffer.concat([PNG, Buffer.from(url)])]));
  const mcp = mcpStdio(stub.url, 'ws-9');
  try {
    const sheet = await mcp.callTool('observe-sheet', { id: 'f_9', body: {} });
    assert.equal(sheet.isError, false);
    const images = sheet.content.filter((c) => c.type === 'image').map((c) => Buffer.from(c.data, 'base64'));
    assert.deepEqual(images.map((b) => b.subarray(PNG.length).toString()), urls);
    assert.ok(images.every((b) => b.subarray(0, PNG.length).equals(PNG)));
    assert.deepEqual(stub.hits.map((h) => `${h.method} ${h.url}`), ['POST /v1/films/f_9/observe/sheet', ...urls.map((u) => `GET ${u}`)]);
  } finally {
    await mcp.close();
    await stub.close();
  }
});

test('A9-12 MCP 取回只写在 data.sheet / data.strips / data.outputs 里的本片图片：去重、同一令牌；别的片、别的服务、越界路径不取', async () => {
  const at = (name, film = 'f_9') => `/v1/films/${film}/artifacts/${name}`;
  const stub = await stubApi((url) => {
    if (url === '/v1/films/f_9/observe/sheet') {
      return [200, ok({ data: {
        sheet: at('s/contact.png'),
        strips: [{ url: at('s/cut-1.jpeg') }, `${stub.url}${at('s/cut-2.png')}`],
        outputs: [
          { kind: 'contact', url: at('s/contact.png') }, { kind: 'report', url: at('report.json') },
          { kind: 'contact', url: at('x.png', 'f_8') }, { kind: 'contact', url: `http://evil.invalid${at('y.png')}` },
          { kind: 'contact', url: at('../../f_8/artifacts/z.png') }, { kind: 'contact', url: at('..%2F..%2Ff_8%2Fartifacts%2Fw.png') },
        ],
      } })];
    }
    // 第二部片：信封被截短，图片引用只在全文的 data.sheet 里。
    if (url === '/v1/films/f_7/observe/sheet') return [200, ok({ data: { truncated: true }, outputs: [{ kind: 'response', url: at('response-1.json', 'f_7') }] })];
    if (url === at('response-1.json', 'f_7')) return [200, ok({ data: { sheet: { url: at('s/contact.png', 'f_7') } } })];
    return [200, url.endsWith('.jpeg') ? JPEG : PNG];
  });
  const mcp = mcpStdio(stub.url, 'ws-tok');
  try {
    const sheet = await mcp.callTool('observe-sheet', { id: 'f_9', body: {} });
    assert.equal(sheet.isError, false);
    assert.deepEqual(sheet.content.filter((c) => c.type === 'image'), [
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
    ]);
    assert.deepEqual(stub.hits.map((h) => `${h.method} ${h.url}`), ['POST /v1/films/f_9/observe/sheet', `GET ${at('s/contact.png')}`, `GET ${at('s/cut-1.jpeg')}`, `GET ${at('s/cut-2.png')}`]);
    stub.hits.length = 0;
    const cut = await mcp.callTool('observe-sheet', { id: 'f_7', body: {} });
    assert.deepEqual(cut.content.filter((c) => c.type === 'image'), [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }]);
    assert.deepEqual(stub.hits.map((h) => `${h.method} ${h.url}`), ['POST /v1/films/f_7/observe/sheet', `GET ${at('response-1.json', 'f_7')}`, `GET ${at('s/contact.png', 'f_7')}`]);
    assert.ok(stub.hits.every((h) => h.auth === 'Bearer ws-tok'));
  } finally {
    await mcp.close();
    await stub.close();
  }
});

test('A9-13 CLI 退出码只落在冻结集合里：没登记的前缀不管信封自带什么 exitCode 都是 1', async () => {
  const table = [['usage.x', 2], ['env.x', 3], ['contract.x', 4], ['auth.x', 4], ['busy.x', 5], ['timeout.x', 124], ['failure.x', 1], ['weird.x', 1], ['pred.x', 1], ['qa.x', 1], ['', 1]];
  for (const [code, want] of table) for (const exitCode of [42, 0, undefined, '7']) assert.equal(exitCodeForEnvelope({ ok: false, exitCode, error: { code } }), want, `${code} ${exitCode}`);
  assert.equal(exitCodeForEnvelope({ ok: false, exitCode: 42 }), 1);

  // 真实子进程对回环服务：令牌写成「错误码|exitCode」，服务照着回失败信封。
  const stub = await stubApi((url, req) => {
    const [code, exitCode] = req.headers.authorization.slice('Bearer '.length).split('|');
    return [500, { format: 'envelope/0.1', ok: false, ...(exitCode && { exitCode: Number(exitCode) }), error: { code, message: '夹具' } }];
  });
  try {
    for (const [token, want] of [['weird.thing|42', 1], ['weird.thing', 1], ['pred.gate|4', 1], ['qa.gate|4', 1], ['failure.ffmpeg|1', 1], ['auth.base-readonly|4', 4], ['busy.rev-conflict|42', 5]]) {
      const out = await cliJson(['guide'], { url: stub.url, token });
      assert.deepEqual([out.code, out.env.error.code], [want, token.split('|')[0]], token);
    }
  } finally {
    await stub.close();
  }
});

test('A9-14 HTTP 非 2xx 配成功信封不算成功：CLI 退出 3，MCP 标 isError；正常失败信封保留原码与诊断', async () => {
  const stub = await stubApi((url, req) => ({
    lie: [503, ok({ data: { verbs: [] } })],
    down: [503, fail('env.ffmpeg-missing', '找不到 ffmpeg', { diagnostics: [{ code: 'env.ffmpeg-missing', message: '装 FFmpeg' }] })],
    fine: [200, ok({ data: { verbs: [] } })],
  })[req.headers.authorization.slice('Bearer '.length)]);
  const mcp = mcpStdio(stub.url, 'lie');
  try {
    const lie = await cliJson(['guide'], { url: stub.url, token: 'lie' });
    assert.deepEqual([lie.code, lie.env.ok, lie.env.exitCode, lie.env.error.code], [3, false, 3, 'env.missing-tool']);
    assert.match(lie.env.error.message, /HTTP 503/);
    const down = await cliJson(['guide'], { url: stub.url, token: 'down' });
    assert.deepEqual([down.code, down.env.error.code, down.env.diagnostics.length], [3, 'env.ffmpeg-missing', 1]);
    assert.equal((await cliJson(['guide'], { url: stub.url, token: 'fine' })).code, 0);

    const lied = await mcp.callTool('guide');
    assert.deepEqual([lied.isError, textOf(lied).ok, textOf(lied).error.code], [true, false, 'env.missing-tool']);
    const failed = await mcp.callTool('guide', { _token: 'down' });
    assert.deepEqual([failed.isError, textOf(failed).error.code, textOf(failed).diagnostics.length], [true, 'env.ffmpeg-missing', 1]);
    assert.equal((await mcp.callTool('guide', { _token: 'fine' })).isError, false);
  } finally {
    await mcp.close();
    await stub.close();
  }
});

test('A9-15 MCP 严格校验 JSON-RPC 请求结构：非法 id 回 -32600，非法 params / arguments 回 -32602 且不打上游；查询数组按重复键发', async () => {
  const stub = await stubApi(() => [200, ok()]);
  const mcp = mcpStdio(stub.url, 't');
  try {
    for (const id of [{}, [1], true]) mcp.send({ jsonrpc: '2.0', id, method: 'ping' });
    mcp.send({ jsonrpc: '1.0', id: 'old', method: 'ping' });
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: true });
    assert.deepEqual((await mcp.rpc('ping')).result, {});
    assert.deepEqual(mcp.stray.map((m) => [m.id, m.error.code]), [[null, -32600], [null, -32600], [null, -32600], ['old', -32600]]);
    for (const params of [true, [], 'x', 5, null]) assert.equal((await mcp.rpc('ping', params)).error?.code, -32602, `params ${JSON.stringify(params)}`);
    for (const args of [null, [], 'x', 5, true]) assert.equal((await mcp.rpc('tools/call', { name: 'guide', arguments: args })).error?.code, -32602, `arguments ${JSON.stringify(args)}`);
    assert.equal((await mcp.rpc('tools/call', { name: 5 })).error?.code, -32602);
    assert.deepEqual(stub.hits, [], '非法请求不打上游');
    assert.equal((await mcp.rpc('tools/call', { name: 'guide' })).result.isError, false, '省略 arguments 当空对象');
    assert.equal(stub.hits.length, 1);

    // 查询参数的结构是数组时按重复键发，MCP 与命令行同一个编码；真实 fetch 打到回环服务核对线上的地址。
    const tagged = { id: 'custom-tags', method: 'GET', path: '/v1/custom', auth: 'account', summary: '数组查询', query: { tags: { type: 'array', items: { type: 'string' } }, wait: { type: 'integer' } } };
    const session = createMcpSession({ baseUrl: stub.url, token: 't', routes: [tagged] });
    assert.equal(session.tools[0].inputSchema.properties.tags.type, 'array');
    const call = (args) => session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'custom-tags', arguments: args } });
    assert.equal((await call({ tags: ['a b', 'c&d'], wait: 0 })).result?.isError, false);
    assert.equal((await call({ wait: [1, 2] })).error?.code, -32602, '结构不是数组的查询参数不收数组');
    assert.equal((await call({ tags: [{}] })).error?.code, -32602);
    assert.equal(await runApiCli(['custom-tags', '--tags', 'a b', '--tags', 'c&d', '--wait', '0', '--url', stub.url, '--token', 't'], { routes: [tagged], stdout: { write() {} }, env: {} }), 0);
    assert.deepEqual(stub.hits.slice(1).map((h) => h.url), ['/v1/custom?tags=a+b&tags=c%26d&wait=0', '/v1/custom?tags=a+b&tags=c%26d&wait=0']);
  } finally {
    await mcp.close();
    await stub.close();
  }
});

test('A9-16 mcp 子命令的启动参数写错按用法错误退出 2，不挂着等输入；README 写明不带 --out 时出原始字节', { timeout: 90000 }, async () => {
  for (const args of [['mcp', 'extra'], ['mcp', '--bogus'], ['mcp', '--url']]) {
    const out = await cli(args, { token: account, timeout: 15000 });
    assert.deepEqual([out.code, out.stdout], [2, ''], args.join(' '));
    assert.match(out.stderr, /^用法：.*\bmcp\b/, args.join(' '));
    assert.doesNotMatch(out.stderr, /node:internal|\n\s+at /, args.join(' '));
  }
  assert.match(readFileSync(new URL('./README.md', import.meta.url), 'utf8'), /不带 `--out`[^。]*原始字节/);
});

/* ---------------- 二审（G_REV-R2-A9）收口：取图地址跟合同走、逐张容错、全文取不回要报错、委托作业令牌衔接、不跟重定向 ---------------- */

const notesOf = (result) => result.content.filter((c) => c.type === 'text').slice(1).map((c) => JSON.parse(c.text));
const imagesOf = (result) => result.content.filter((c) => c.type === 'image').map((c) => Buffer.from(c.data, 'base64'));
const callVia = (session) => async (name, args) => (await session.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
const png = () => new Response(PNG, { headers: { 'content-type': 'application/octet-stream' } });

test('A9-17 自动取图的地址由合同里 artifacts 的路径模板推出：改合同路径，直接调和自动取图一起跟着变', async () => {
  const routes = ROUTES.map((r) => (r.id === 'artifacts' ? { ...r, path: '/v2/works/{id}/files/{name}' } : r));
  const seen = [];
  const call = callVia(createMcpSession({
    baseUrl: 'http://stub.invalid', token: 'ws', routes,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      seen.push(`${init.method} ${path}`);
      if (path.endsWith('/observe/sheet')) return Response.json(ok({ outputs: [{ kind: 'contact', url: '/v2/works/f_9/files/s/contact.png' }, { kind: 'contact', url: '/v1/films/f_9/artifacts/s/old.png' }] }));
      return png();
    },
  }));
  const sheet = await call('observe-sheet', { id: 'f_9', body: {} });
  assert.equal(sheet.isError, false);
  assert.deepEqual(imagesOf(sheet), [PNG]);
  assert.deepEqual(seen, ['POST /v1/films/f_9/observe/sheet', 'GET /v2/works/f_9/files/s/contact.png'], '旧路径不再是产物地址，不取');
  assert.deepEqual(imagesOf(await call('artifacts', { id: 'f_9', name: 'a.png' })), [PNG]);
  assert.equal(seen.at(-1), 'GET /v2/works/f_9/files/a.png');
});

/** 临时改掉内存里合同的 artifacts 路径模板（服务端和薄壳读的是同一份 ROUTES），跑完改回去 */
async function withArtifactsPath(path, run) {
  const route = ROUTES.find((r) => r.id === 'artifacts');
  const frozen = route.path;
  route.path = path;
  try { return await run(); } finally { route.path = frozen; }
}

test('A9-17 真实服务签发的产物引用也跟合同走：改了 artifacts 的路径模板，observe-sheet 交回新路径，MCP 自动取回完整的联系表', { skip: sheetSkip(), timeout: 300000 }, async () => {
  const call = callVia(createMcpSession({ baseUrl: api.url, token: account }));
  const film = textOf(await call('films-create', { body: { output: { size: [320, 180], fps: '24/1', frames: 12 } } })).data.film;
  let job = textOf(await call('render', { id: film, wait: 30, body: { tier: 'draft' } }));
  while (['queued', 'running'].includes(job.data.status)) job = textOf(await call('job-get', { id: job.data.job, wait: 30 }));
  assert.equal(job.data.status, 'succeeded', JSON.stringify(job));
  const [before] = imagesOf(await call('observe-sheet', { id: film, body: {} }));
  assert.deepEqual([...before.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await withArtifactsPath('/v2/works/{id}/out/{name}', async () => {
    const sheet = await call('observe-sheet', { id: film, body: {} });
    assert.equal(sheet.isError, false, JSON.stringify(sheet.content[0]));
    const contact = textOf(sheet).outputs.find((o) => o.kind === 'contact');
    assert.match(contact.url, new RegExp(`^/v2/works/${film}/out/sheets/.+\\.png$`));
    assert.deepEqual(imagesOf(sheet), [before], '改了路径，取回的还是同一张完整的联系表');
    assert.equal(sha(before), contact.sha256);
    assert.deepEqual(before, readFileSync(join(root, 'films', film, 'deliver', contact.url.split('/out/')[1])));
  });
});

test('A9-17 真实服务签发的全文引用也跟合同走：改了 artifacts 的路径模板，截短信封的全文引用是新路径，MCP 取得回全文', async () => {
  const call = callVia(createMcpSession({ baseUrl: api.url, token: account }));
  const film = textOf(await call('films-create', { body: {} })).data.film;
  const title = 'LONG'.repeat(3000);
  assert.equal((await call('film-put', { id: film, body: { format: 'patch/0.1', rev: 1, ops: [{ op: 'set', path: 'title', value: title }] } })).isError, false);
  await withArtifactsPath('/v2/works/{id}/out/{name}', async () => {
    const got = await call('film-get', { id: film });
    const env = textOf(got);
    assert.equal(env.data.truncated, true);
    const ref = env.outputs.find((o) => o.kind === 'response').url;
    assert.match(ref, new RegExp(`^/v2/works/${film}/out/response-[0-9a-f]{64}\\.json$`));
    assert.deepEqual([got.isError, notesOf(got)], [false, []], '全文取回来了，不留取不回的诊断');
    assert.equal(textOf(await call('artifacts', { id: film, name: ref.split('/').at(-1) })).data.film.title, title);
  });
});

test('A9-18 批量取图逐张容错：中间一张断流或连不上，后面的图照样取回，坏的那张留下带地址的诊断', async () => {
  const at = (n) => `/v1/films/f_9/artifacts/s/${n}.png`;
  const seen = [];
  const call = callVia(createMcpSession({
    baseUrl: 'http://stub.invalid', token: 'ws',
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      seen.push(`${init.method} ${path}`);
      if (path.endsWith('/observe/sheet')) return Response.json(ok({ outputs: [1, 2, 3, 4, 5].map((n) => ({ kind: 'contact', url: at(n) })) }));
      if (path === at(2)) return new Response(new ReadableStream({ pull(c) { c.error(new Error('terminated')); } }));
      if (path === at(4)) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return png();
    },
  }));
  const sheet = await call('observe-sheet', { id: 'f_9', body: {} });
  assert.deepEqual(seen.slice(1), [1, 2, 3, 4, 5].map((n) => `GET ${at(n)}`), '五张都要去取');
  assert.deepEqual(imagesOf(sheet), [PNG, PNG, PNG], '第 1、3、5 张一张不少');
  assert.deepEqual(notesOf(sheet).filter((n) => n.error), [{ url: at(2), error: 'terminated' }, { url: at(4), error: 'ECONNRESET' }]);
});

test('A9-19 截短信封的全文取不回来（404、断流、坏 JSON、不是信封、HTTP 200 的普通对象、HTTP 200 的失败信封、连不上）不装成功：留下诊断，isError 为 true', async () => {
  const full = '/v1/films/f_9/artifacts/response-abc.json';
  const broken = {
    'HTTP 404': () => Response.json(fail('contract.not-found', '没有这个产物'), { status: 404 }),
    terminated: () => new Response(new ReadableStream({ pull(c) { c.error(new Error('terminated')); } })),
    JSON: () => new Response('{"ok":tr'),
    信封: () => Response.json([1, 2]),
    全文不是信封: () => Response.json({ message: '当前不可用' }),
    // 字面写：fail() 会把没登记的码归一成别的码。
    '失败信封：contract.not-found': () => Response.json({ ok: false, error: { code: 'contract.not-found', message: '没有这个产物' } }),
    ECONNRESET: () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); },
  };
  for (const [why, respond] of Object.entries(broken)) {
    const call = callVia(createMcpSession({
      baseUrl: 'http://stub.invalid', token: 'ws',
      fetchImpl: async (url) => (new URL(url).pathname === full ? respond() : Response.json(ok({ data: { truncated: true }, outputs: [{ kind: 'response', url: full }] }))),
    }));
    const sheet = await call('observe-sheet', { id: 'f_9', body: {} });
    assert.equal(sheet.isError, true, why);
    assert.equal(textOf(sheet).data.truncated, true, '截短的信封照样交回');
    const [note] = notesOf(sheet);
    assert.equal(note.url, full, why);
    assert.match(note.fullOutputError, new RegExp(why), why);
  }
  // 全文引用指到别的服务：不取，但同样不能装成拿到了全文。
  const call = callVia(createMcpSession({ baseUrl: 'http://stub.invalid', token: 'ws', fetchImpl: async () => Response.json(ok({ data: { truncated: true }, outputs: [{ kind: 'response', url: `http://evil.invalid${full}` }] })) }));
  const foreign = await call('observe-sheet', { id: 'f_9', body: {} });
  assert.equal(foreign.isError, true);
  assert.ok(notesOf(foreign)[0].fullOutputError);
});

test('A9-20 账户动词建片（mode=delegate）交回的工作区令牌和作业号一起记下：紧接着 job-get 自动用工作区令牌', async () => {
  const shapes = [{ film: 'f_1', token: 'ws-1', job: 'j_1' }, { filmId: 'f_2', token: 'ws-2', jobId: 'j_2' }, { film: 'f_3', token: 'ws-3', job: { id: 'j_3' } }];
  for (const data of shapes) {
    const seen = [];
    const call = callVia(createMcpSession({
      baseUrl: 'http://stub.invalid', token: 'acct',
      fetchImpl: async (url, init) => {
        seen.push([`${init.method} ${new URL(url).pathname}`, init.headers.authorization]);
        return Response.json(ok({ data }));
      },
    }));
    const film = data.film ?? data.filmId;
    const job = data.jobId ?? data.job.id ?? data.job;
    assert.equal((await call('films-create', { body: { mode: 'delegate', brief: '一条鱼' } })).isError, false);
    await call('job-get', { id: job });
    await call('film-get', { id: film });
    await call('job-get', { id: 'j_other' });
    assert.deepEqual(seen, [['POST /v1/films', 'Bearer acct'], [`GET /v1/jobs/${job}`, `Bearer ws-${film.at(-1)}`], [`GET /v1/films/${film}/film`, `Bearer ws-${film.at(-1)}`], ['GET /v1/jobs/j_other', 'Bearer acct']]);
  }
});

test('A9-21 带令牌的请求不跟重定向：动词调用、全文、自动取图遇到 302 都报错，令牌不到别的服务', { timeout: 60000 }, async () => {
  const inits = [];
  const call = callVia(createMcpSession({ baseUrl: 'http://stub.invalid', token: 'ws', fetchImpl: async (url, init) => { inits.push(init.redirect); return String(url).endsWith('.png') ? png() : Response.json(ok({ outputs: [{ kind: 'contact', url: '/v1/films/f_9/artifacts/a.png' }] })); } }));
  await call('observe-sheet', { id: 'f_9', body: {} });
  assert.deepEqual(inits, ['error', 'error'], '动词请求和取图请求都写明 redirect: error');

  // 真实 fetch 对真实的回环服务：本服务把请求 302 到另一个服务，那个服务一次请求都不该收到。
  const evil = await stubApi(() => [200, PNG]);
  let mode = 'image';
  const hop = (res, path) => { res.writeHead(302, { location: `${evil.url}${path}` }); res.end(); };
  const server = createServer((req, res) => {
    req.resume();
    if (mode === 'verb') return hop(res, req.url);
    if (req.url.endsWith('/observe/sheet')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(mode === 'full' ? ok({ data: { truncated: true }, outputs: [{ kind: 'response', url: '/v1/films/f_9/artifacts/response-1.json' }] }) : ok({ outputs: [{ kind: 'contact', url: '/v1/films/f_9/artifacts/a.png' }] })));
    }
    return hop(res, req.url);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const real = callVia(createMcpSession({ baseUrl: url, token: 'ws-secret' }));
    const image = await real('observe-sheet', { id: 'f_9', body: {} });
    assert.deepEqual(imagesOf(image), []);
    assert.equal(notesOf(image)[0].url, '/v1/films/f_9/artifacts/a.png');
    assert.ok(notesOf(image)[0].error);
    mode = 'full';
    const full = await real('observe-sheet', { id: 'f_9', body: {} });
    assert.equal(full.isError, true);
    assert.ok(notesOf(full)[0].fullOutputError);
    mode = 'verb';
    assert.equal((await real('artifacts', { id: 'f_9', name: 'a.png' })).isError, true);
    assert.equal(textOf(await real('film-get', { id: 'f_9' })).error.code, 'env.missing-tool');
    const out = await cli(['artifacts', '--id', 'f_9', '--name', 'a.png'], { url, token: 'ws-secret', encoding: 'buffer' });
    assert.equal(out.code, 3, '命令行薄壳同样不跟重定向');
    assert.deepEqual(evil.hits, [], '带令牌的请求一次都没到别的服务');
  } finally {
    await new Promise((done) => server.close(done));
    await evil.close();
  }
});
