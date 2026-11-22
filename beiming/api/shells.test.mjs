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
import { fail } from './envelope.mjs';
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
const cli = (args, { url = api.url, token, encoding = 'utf8' } = {}) => new Promise((done) => {
  const env = { ...process.env, BEIMING_API_URL: url };
  delete env.BEIMING_API_TOKEN;
  if (token) env.BEIMING_API_TOKEN = token;
  execFile(process.execPath, [CLI, ...args], { env, encoding, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }));
});
const cliJson = async (args, opts) => {
  const out = await cli(args, opts);
  return { code: out.code, env: JSON.parse(out.stdout) };
};
const textOf = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);

test('A9-4 MCP stdio 子进程对真实服务：initialize、tools/list、tools/call、图片与二进制产物、令牌衔接、JSON-RPC 错误码', async () => {
  const child = spawn(process.execPath, [CLI, 'mcp', '--url', api.url, '--token', account], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  const stray = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const take = waiting.get(msg.id);
    if (take) take(msg); else stray.push(msg);
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((done) => {
    const id = ++seq;
    waiting.set(id, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) })}\n`);
  });
  const callTool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  try {
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).result;
    assert.equal(init.protocolVersion, '2025-06-18');
    assert.deepEqual(init.capabilities, { tools: {} });
    assert.equal(init.serverInfo.name, 'beiming-api');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
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
    child.stdin.write('{not json\n');
    assert.equal((await rpc('ping')).result !== undefined, true);
    assert.deepEqual(stray.map((m) => [m.id, m.error.code]), [[null, -32700]]);
  } finally {
    child.stdin.end();
    await new Promise((done) => child.once('exit', done));
  }
  assert.equal(child.exitCode, 0);
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
