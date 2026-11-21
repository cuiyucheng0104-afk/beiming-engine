import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import verdictSchema from '../kernel/contracts/predicates/schema/verdict.schema.json' with { type: 'json' };
import fixSchema from '../kernel/contracts/patch/schema/fix.schema.json' with { type: 'json' };
import question28 from '../kernel/contracts/question-file/examples/full.json' with { type: 'json' };
import { layerL2, layerL3, layerL5 } from './pipeline.mjs';
import { ensureLut } from './runtime.mjs';
import { sanitizeErrorText } from './work.mjs';
import { BUILTIN_ASSETS } from '../sources/blender/host.mjs';
import { tools, verifyDeliveryBundle } from '../comp/index.mjs';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { findBlender } from '../sources/blender/host.mjs';
import { estimateTokens, issueAccountToken, matchRoute, openApiText, ROUTES, createOpenAiVisionReviewer, runHandsOnAgent, startServer } from './index.mjs';

const frozen = await loadContracts();
const checkVerdict = new Ajv2020({ strict: false }).addSchema(fixSchema).compile(verdictSchema);
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const limits = { guide: 1500, 'cards-search': 1500, 'card-get': 1500, 'schema-get': 1500, 'films-create': 600, 'assets-search': 600, 'film-assets': 300, 'film-get': 1500, 'film-put': 800, 'film-files': 800, explain: 300, render: 600, 'observe-query': 400, 'observe-sheet': 300, 'observe-metrics': 600, verify: 1000, review: 1000, deliver: 600, harvest: 600, ledger: 600, artifacts: null, 'job-get': 500, 'job-delete': 100 };
let root, api, account;
const tempVariable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
const previousTemp = process.env[tempVariable];

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'beiming-api-'));
  // 同时运行的 Blender 组件测试会统计系统临时目录，API 子进程的中间文件放在各自测试目录。
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

function checkEnvelope(text, route) {
  const env = JSON.parse(text);
  assert.equal(env.format, 'envelope/0.1');
  assert.deepEqual(frozen.validate(env), { contract: 'envelope', schemaErrors: [], violations: {} });
  const limit = limits[route.id] ?? 600;
  assert.ok(estimateTokens(text) <= limit, `${route.id} ${estimateTokens(text)} > ${limit}`);
  return env;
}

async function call(method, path, token, body, expected = 200, endpoint = api.url) {
  const res = await fetch(endpoint + path, { method, headers: { ...(token && { authorization: `Bearer ${token}` }), 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const env = checkEnvelope(await res.text(), matchRoute(method, new URL(path, endpoint).pathname).route);
  if (expected !== null) {
    assert.equal(res.status, expected, `${method} ${path} ${JSON.stringify(env)}`);
    assert.equal(env.ok, expected === 200);
  }
  return env;
}
const create = async (body = {}) => (await call('POST', '/v1/films', account, body)).data;
const patch = (rev, path, value) => ({ format: 'patch/0.1', rev, ops: [{ op: 'set', path, value }] });

function mediaSkip() {
  const { ffmpeg, ffprobe } = tools();
  for (const [name, bin, args] of [['ffmpeg', ffmpeg, ['-version']], ['ffprobe', ffprobe, ['-version']], ['Blender', findBlender(), ['--version']]]) {
    if (!bin || spawnSync(bin, args, { stdio: 'ignore', timeout: 20000 }).status !== 0) return `缺少可执行的 ${name}`;
  }
  // 让页面宿主使用的 Playwright 实际启动并关闭无头浏览器，兼容各平台的安装布局。
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  if (spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 30000 }).status !== 0) return '无头浏览器不可执行';
  return false;
}
const HAS_BLENDER = (() => {
  const bin = findBlender();
  return Boolean(bin && spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 20000 }).status === 0);
})();

test('合同字节、冻结不变量及入口卡覆盖全部 HTTP 动词', async t => {
  assert.deepEqual(readFileSync(new URL('./openapi.json', import.meta.url)), Buffer.from(openApiText()));
  const paths = JSON.parse(openApiText()).paths;
  assert.equal(paths['/v1/films/{id}/film'].put.requestBody.required, true);
  assert.equal(paths['/v1/films/{id}/explain'].get.parameters.find(p => p.name === 'path').required, true);
  assert.deepEqual(Object.fromEntries(ROUTES.map(r => [r.id, r.tokens])), limits);
  assert.deepEqual(Object.keys(frozen.contracts.get('envelope').checks), ['EN1', 'EN2', 'EN3', 'EN4']);
  assert.equal(api.server.address().address, '127.0.0.1');
  assert.equal(Number(new URL(api.url).port), api.port);
  const env = await call('GET', '/v1/guide', account);
  const verbs = ROUTES.map(r => `${r.method} ${r.path}`);
  assert.deepEqual(env.data.verbs, verbs);
  for (const verb of verbs) assert.ok(env.data.guide.split('\n').some(line => line === verb || line.startsWith(verb + ' ')), verb);
  t.diagnostic(`${verbs.length} 个动词，guide ${estimateTokens(env)} token`);
});

test('两级令牌隔离、冻结字段、并发修订与资产写入', async () => {
  const a = await create({ exam: '1-1' }), b = await create();
  const path = `/v1/films/${a.film}`;
  for (const route of ROUTES) {
    const target = route.path.replace('{id}', a.film).replace('{name}', 'file').replace('{path}', 'shots/s01.py');
    const wrong = route.auth === 'account' ? a.token : route.auth === 'workspace' ? b.token : account;
    for (const token of [undefined, wrong]) assert.equal((await call(route.method, target, token, undefined, 403)).error.code, 'auth.base-readonly');
  }
  await call('GET', `${path}/film`, account, undefined, 403);
  const assets = await call('POST', '/v1/assets/search', account, { q: 'rtx' });
  assert.ok(assets.data.items.some(a => a.id === 'asset:rtx-card@1' && a.parts > 0 && a.bbox));
  assert.equal((await call('POST', '/v1/assets/search', account, { q: 'ssd' })).data.items.length, 0);
  await call('PUT', `${path}/film`, a.token, patch(1, 'output/frames', 12), 403);
  const cards = await call('POST', '/v1/cards/search', account, {});
  assert.ok(cards.data.items.length > 0 && cards.data.items.length <= 5);
  for (const card of cards.data.items) assert.ok(estimateTokens(card) <= 300);
  assert.equal((await call('GET', '/v1/cards/overlay.title@1', account)).data.card.id, 'overlay.title');
  for (const name of ['film', 'predicates']) assert.ok((await call('GET', `/v1/schema/${name}`, account)).data.fields.length);
  const film = (await call('GET', `${path}/film`, a.token)).data.film;
  assert.equal(film.exam, '1-1');
  assert.deepEqual(film.predicates.base, ['floor@1']);
  await call('PUT', `${path}/film`, a.token, patch(1, 'exam', '2-1'), 422);
  await call('PUT', `${path}/film`, a.token, patch(1, 'predicates/base', []), 403);
  const writes = await Promise.all(['A', 'B'].map(title => call('PUT', `${path}/film`, a.token, { ...film, title, rev: 1 }, null)));
  assert.equal(writes.filter(r => r.ok && r.data.rev === 2).length, 1);
  assert.equal(writes.filter(r => r.error?.code === 'busy.rev-conflict' && r.data.latestRev === 2).length, 1);
  await call('PUT', `${path}/film`, a.token, patch(1, 'title', 'C'), 409);
  await call('PUT', `${path}/files/shots/test.py`, a.token, 'pass', 422);
  const mesh = Buffer.from('solid mesh\nendsolid mesh\n');
  const upload = await call('POST', `${path}/assets`, a.token, { name: 'mesh.stl', data: mesh.toString('base64') });
  assert.equal(upload.data.bytes, mesh.length);
  const binding = { subject: 'asset:rtx-card@1', mesh: upload.data.ref };
  const locked = await call('PUT', `${path}/film`, a.token, patch(upload.data.rev, 'assets', binding));
  const dir = join(root, 'films', a.film);
  const bytes = readFileSync(join(dir, 'film.lock'));
  const lock = JSON.parse(bytes);
  assert.equal(lock.rev, locked.data.rev);
  assert.equal(lock.assets[binding.subject], digest(readFileSync(BUILTIN_ASSETS[binding.subject])));
  assert.equal(lock.assets[binding.mesh], digest(mesh));
  const before = readFileSync(join(dir, 'film.json'));
  await call('PUT', `${path}/film`, a.token, patch(lock.rev, 'assets', { missing: 'asset:absent@1' }), 422);
  await call('PUT', `${path}/film`, a.token, patch(lock.rev, 'style/view/scene', 'absent-lut'), 503);
  assert.deepEqual(readFileSync(join(dir, 'film.lock')), bytes);
  assert.deepEqual(readFileSync(join(dir, 'film.json')), before);
  assert.equal(existsSync(join(dir, 'snapshots', `rev-${lock.rev + 1}`)), false);
  assert.equal((await call('GET', `${path}/film`, a.token)).data.rev, lock.rev);
  const idem = await call('PUT', `${path}/film`, a.token, { ...JSON.parse(before), rev: lock.rev });
  assert.equal(idem.data.rev, lock.rev);
  const invalid = { format: 'patch/0.1', ops: [false] };
  for (const rev of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await call('PUT', `${path}/film`, a.token, { ...invalid, rev }, 400)).error.code, 'usage.bad-argument');
  }
  const stale = await call('PUT', `${path}/film`, a.token, { ...invalid, rev: 0 }, 409);
  assert.equal(stale.data.latestRev, lock.rev);
  await call('PUT', `${path}/film`, a.token, { ...invalid, rev: lock.rev }, 400);
  const cardPath = `${path}/explain?path=shots/s01/cards/title/params/`;
  assert.equal((await call('GET', cardPath + 'ink', a.token)).data.value, '#F4F0E9');
  const settle = (await call('GET', cardPath + 'settleFrames', a.token)).data;
  assert.deepEqual(settle.layers.map(l => l.value), [24, 0]);
  assert.deepEqual(settle.coupling, ['fps']);
  assert.deepEqual(readFileSync(join(root, 'films', a.film, 'assets', 'mesh.stl')), mesh);
  const review = await call('POST', `${path}/review`, a.token, {});
  assert.equal(review.data.status, 'not-run');
  await call('GET', review.outputs[0].url, b.token, undefined, 403);
  await call('GET', `${path}/artifacts/..%2Ffilm.json`, a.token, undefined, 422);
});

const media = mediaSkip();
test('真实双镜头建片、修复、渲染、观测、核验与交付六件套', { skip: media, timeout: 600000 }, async t => {
  const a = await create({ template: 'turntable', output: { size: [640, 360], fps: '24/1', frames: 24 } });
  const base = `/v1/films/${a.film}`;
  const request = (method, tail, body, status) => call(method, base + tail, a.token, body, status);
  const film = (await request('GET', '/film')).data.film;
  assert.deepEqual(film.shots.map(s => [s.source, s.mode, s.entry]), [['blender', 'cards-data', undefined], ['three', 'cards-data', undefined]]);
  assert.deepEqual(readdirSync(join(root, 'films', a.film, 'shots')), []);
  assert.deepEqual(film.shots[0].cards.map(c => c.use), ['camera.spline@1', 'blender.cycles@1', 'blender.state-keys@1']);
  assert.equal(film.shots[0].cards[0].params.keys[0].look, 'kit');
  const typo = patch(1, 'titele', 'BEIMING');
  const rejected = await request('PUT', '/film', typo, 422);
  assert.ok(rejected.diagnostics.some(d => !d.fix && d.hint?.includes('title')));
  const repaired = await request('PUT', '/film?applyFixes=machine', { rev: 1 });
  assert.equal(repaired.data.rev, 2);
  assert.equal(repaired.data.lock, 'film.lock');
  assert.equal((await request('GET', '/explain?path=title')).data.value, 'BEIMING');
  async function job(kind, body) {
    let env = await request('POST', '/' + kind, { ...body, wait: kind === 'render' ? 0 : 30 });
    while (['queued', 'running'].includes(env.data.status)) env = await call('GET', `/v1/jobs/${env.data.job}?wait=30`, a.token);
    assert.equal(env.data.status, 'succeeded');
    const full = env.outputs.find(o => o.kind === 'response');
    if (full) env = await (await fetch(api.url + full.url, { headers: { authorization: `Bearer ${a.token}` } })).json();
    return env;
  }
  const render = await job('render', { tier: 'draft' });
  assert.equal(render.data.actualCount, render.data.expectedCount);
  const s01meta = JSON.parse(readFileSync(join(root, 'films', a.film, 'deliver', render.data.job, 'frames/s01/f0000.meta.json')));
  assert.equal(s01meta.source.renderer, 'blender');
  assert.equal(s01meta.source.host, 'cycles');
  assert.ok(s01meta.entities.some(e => e.name === 'kit.fan_L'));
  assert.deepEqual([...new Set(render.data.items.map(f => f.shot))], ['s01', 's02']);
  const other = await create();
  for (const method of ['GET', 'DELETE']) await call(method, `/v1/jobs/${render.data.job}`, other.token, undefined, 403);
  const observation = await request('POST', '/observe/query', { type: 'entities', frame: 0 });
  assert.match(JSON.stringify(observation.data), /kit/);
  assert.equal(observation.data.actualCount, observation.data.entities.length);
  assert.ok(observation.data.expectedCount >= observation.data.actualCount);
  const framing = await request('POST', '/observe/query', { type: 'framing', target: 'hero' });
  assert.equal(framing.data.target, 'hero');
  assert.ok(framing.data.entities.some(e => e.name === 'kit'));
  assert.equal((await request('POST', '/verify', { shots: ['s01', 'absent'] }, 400)).error.code, 'usage.bad-argument');
  const sheet = await request('POST', '/observe/sheet', { cuts: true });
  assert.equal(sheet.data.actualCount, 1);
  const verified = await job('verify', { tier: 'draft' });
  assert.equal(verified.data.layers.L2.ok, true);
  assert.equal(verified.data.layers.L3.ok, true);
  const deliver = await job('deliver', {});
  const expected = ['contact.png', 'film.lock', 'master.mp4', 'report.json', 'run.json', 'web.mp4'];
  assert.deepEqual(deliver.outputs.map(o => basename(o.url)).sort(), expected);
  assert.deepEqual([deliver.data.expectedCount, deliver.data.actualCount], [6, 6]);
  for (const item of deliver.outputs) {
    const res = await fetch(api.url + item.url, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(res.status, 200);
    if (/\.(json|lock)$/.test(item.url)) assert.match(res.headers.get('content-type'), /^application\/json/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 0);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    if (item.kind === 'report') {
      const v = JSON.parse(bytes).verification;
      assert.equal(v.ok, true);
      assert.equal(v.layers.L2.bbox.ok, true);
      assert.equal(v.layers.L3.basePass, true);
      assert.equal(v.L5.status, 'not-run');
      assert.equal(v.layers.L4.status, 'not-run');
      assert.match(v.layers.L4.reason, /ref-pack/);
      assert.equal(v.layers.L4.compChecks.count, JSON.parse(bytes).checks.length);
      for (const verdict of v.verdicts) assert.ok(checkVerdict(verdict), JSON.stringify(checkVerdict.errors));
    }
  }
  const bundle = verifyDeliveryBundle(join(root, 'films', a.film, 'deliver', deliver.data.job, 'bundle'));
  assert.deepEqual(Object.keys(bundle.files).sort(), expected);
  const metrics = await request('POST', '/observe/metrics', { metrics: ['deliverSpec'] });
  assert.equal(metrics.data.items[0].metric, 'deliverSpec');
  assert.deepEqual((await request('POST', '/harvest', {})).data.items, []);
  const ledger = await request('GET', '/ledger');
  const entries = readFileSync(join(root, 'meta', `${a.film}.ledger.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.data.actualCount, ledger.data.items.length);
  assert.ok(ledger.data.expectedCount > ledger.data.actualCount);
  assert.equal(entries.filter(r => r.step === 'harvest-hook').length, 1);
  assert.equal(entries.find(r => r.step === 'job.deliver').frames, 24);
  const cancel = await request('POST', '/render', { tier: 'final' });
  const jobPath = `/v1/jobs/${cancel.data.job}`;
  let live;
  do {
    await new Promise(resolve => setTimeout(resolve, 30));
    live = (await call('GET', jobPath, a.token)).data;
    assert.equal(live.actualCount, live.events.length);
    assert.ok(live.expectedCount >= live.actualCount);
    assert.equal(live.status, 'running');
  } while (!live.cost.frames);
  assert.equal((await call('DELETE', jobPath, a.token)).data.status, 'canceled');
  const terminal = (await call('GET', jobPath, a.token)).data;
  for (const key of ['frames', 'gpuSeconds', 'wallMs']) assert.ok(terminal.cost[key] >= live.cost[key] && live.cost[key] > 0);
  const row = readFileSync(join(root, 'meta', `${a.film}.ledger.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(r => r.step === 'job.render' && r.job === live.job);
  assert.equal(row.length, 1);
  assert.equal(row[0].status, 'canceled');
  for (const key of ['frames', 'gpuSeconds', 'wallMs']) assert.equal(row[0][key], terminal.cost[key]);

  let reviews = 0;
  const reviewed = await startServer({ dataDir: root, reviewer: { async review() { reviews++; return {}; } } });
  try {
    const review = () => call('POST', base + '/review', a.token, {}, null, reviewed.url);
    assert.equal((await review()).data.status, 'failed');
    await request('PUT', '/film', patch(2, 'shots/s02/cards/title/params/text', 'NEW'));
    const stale = await review();
    assert.equal(stale.ok, false);
    assert.equal(stale.data.renderedRev, 2);
    assert.equal(stale.data.rev, 3);
    assert.match(stale.error.hint, /render/);
    assert.equal(reviews, 1);
  } finally { await reviewed.close(); }
  for (const flag of ['web', 'contact']) {
    const at = (await request('GET', '/film')).data.rev;
    await request('PUT', '/film', patch(at, 'delivery', { ...film.delivery, [flag]: false }));
    assert.equal((await request('POST', '/deliver', {}, 422)).error.code, 'contract.delivery-mismatch');
  }
  t.diagnostic(`2 个帧源，终渲 24 帧，下载并验证 ${expected.length} 件产物`);
});

test('本地可信模式先扫描源码再提交修订', async () => {
  const dir = join(root, 'trusted');
  const local = await startServer({ dataDir: dir, localTrusted: true, reviewer: null });
  try {
    const a = (await call('POST', '/v1/films', issueAccountToken(dir), {}, 200, local.url)).data;
    const path = `/v1/films/${a.film}/files/shots/test.py`;
    await call('PUT', path, a.token, 'import time\nprint(time.time())', 422, local.url);
    const saved = await call('PUT', path, a.token, 'value = 1\n', 200, local.url);
    assert.equal(saved.data.rev, 2);
    assert.equal(readFileSync(join(dir, 'films', a.film, saved.data.path), 'utf8'), 'value = 1\n');
  } finally { await local.close(); }
});

test('模拟异族模型读入口、建片、修复并查询，每轮用量追加到外部账本', async t => {
  const model = 'qwen-test';
  const ledgerPath = join(root, 'external-ledger.jsonl');
  const key = randomBytes(24).toString('hex');
  let film, rounds = 0, mockError;
  const mock = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const chat = JSON.parse(Buffer.concat(chunks));
      assert.equal(chat.model, model);
      assert.deepEqual(chat.tools.map(tool => tool.function.name), ['http_request']);
      assert.ok(!JSON.stringify(chat.messages).includes(account));
      let args;
      const last = chat.messages.at(-1);
      const reply = last.role === 'tool' ? JSON.parse(last.content).body : null;
      switch (++rounds) {
        case 1: args = { method: 'GET', path: '/v1/guide' }; break;
        case 2:
          assert.ok(reply.data.verbs.includes('POST /v1/films'));
          args = { method: 'POST', path: '/v1/films', body: {} }; break;
        case 3:
          film = reply.data.film;
          assert.doesNotMatch(reply.data.token, /^bmw_/);
          args = { method: 'PUT', path: `/v1/films/${film}/film`, body: patch(reply.data.rev, 'titele', 'AGENT') }; break;
        case 4:
          assert.ok(reply.diagnostics.some(d => !d.fix && d.hint?.includes('title')));
          args = { method: 'PUT', path: `/v1/films/${film}/film?applyFixes=machine`, body: { rev: 1 } }; break;
        case 5:
          assert.equal(reply.data.rev, 2);
          args = { method: 'GET', path: `/v1/films/${film}/explain?path=title` }; break;
        case 6:
          assert.equal(reply.data.value, 'AGENT');
          args = { method: 'PUT', path: `/v1/films/${film}/film`, body: patch(2, 'title', 'LONG'.repeat(3000)) }; break;
        case 7: args = { method: 'GET', path: `/v1/films/${film}/film` }; break;
        case 8:
          assert.equal(reply.data.truncated, true);
          args = { method: 'GET', path: reply.outputs.find(o => o.kind === 'response').url }; break;
        case 9: assert.equal(reply.data.film.title, 'LONG'.repeat(3000)); break;
        default: assert.fail('模型收到多余的调用');
      }
      const message = args ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${rounds}`, type: 'function', function: { name: 'http_request', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: '已核对修订 2 的片名。' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model, choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } catch (e) {
      mockError = e;
      res.writeHead(500).end('模拟接口断言失败');
    }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runHandsOnAgent({ baseUrl: api.url, token: account, brief: '建片并核对片名', ledgerPath, model, apiKey: key, endpoint: `http://127.0.0.1:${mock.address().port}/v1`, maxSteps: 9, tokenBudget: 150 });
    assert.equal(result.status, 'done');
    assert.deepEqual(result.calls.map(r => r.status), [200, 200, 422, 200, 200, 200, 200, 200]);
    assert.deepEqual(result.usage, { inputTokens: 90, outputTokens: 45 });
    const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 9);
    rows.forEach((r, i) => assert.deepEqual(r, { seq: i + 1, role: 'agent', step: i + 1, family: 'qwen', model, inputTokens: 10, outputTokens: 5 }));
    rounds = 0;
    const over = await runHandsOnAgent({ baseUrl: api.url, token: account, brief: '读入口', ledgerPath, model, apiKey: key,
      endpoint: `http://127.0.0.1:${mock.address().port}/v1`, maxSteps: 2, tokenBudget: 1 });
    assert.equal(over.status, 'budget');
    assert.equal(over.steps, 1);
    assert.deepEqual(over.calls, []);
    assert.deepEqual(over.usage, { inputTokens: 10, outputTokens: 5 });
    t.diagnostic('模拟模型 9 轮，8 次 HTTP 调用，读回 12000 字符全文。另测首轮超预算，工具调用 0 次');
  } catch (e) { throw mockError ?? e; }
  finally { await new Promise(resolve => mock.close(resolve)); }
});

test('考题规格、主体网格和八条基础断言与同修订正式锁绑定', { skip: !HAS_BLENDER && '缺少可执行的 Blender' }, async () => {
  const a = await create({ exam: '28-1' });
  const path = `/v1/films/${a.film}/film`;
  const dir = join(root, 'films', a.film);
  const film = (await call('GET', path, a.token)).data.film;
  const lock = JSON.parse(readFileSync(join(dir, 'film.lock')));
  const ref = film.assets.subject;
  assert.equal(film.shots[0].assets.subject, ref);
  assert.equal(film.shots[0].roles.hero, 'subject');
  assert.deepEqual(film.output, { size: [1920, 824], fps: '24/1', frames: 288 });
  assert.deepEqual(film.predicates.extra, question28.basePredicates);
  assert.equal(lock.assets[ref], digest(readFileSync(new URL('./mech-head-proxy.json', import.meta.url))));
  const exam = readFileSync(join(dir, 'exam.json'));
  assert.deepEqual(JSON.parse(exam), question28);
  assert.equal(lock.assets['asset:exam-28-1@1'], digest(exam));
  assert.deepEqual(frozen.validate(lock), { contract: 'lock', schemaErrors: [], violations: {} });
  assert.equal((await call('PUT', path, a.token, patch(1, 'predicates/extra', []), 403)).error.code, 'auth.base-readonly');
  assert.equal((await call('PUT', path, a.token, patch(1, 'output', { size: [320, 180], fps: '24/1', frames: 24 }), 403)).error.code, 'auth.base-readonly');
  assert.equal((await call('PUT', path, a.token, patch(1, 'assets/subject', 'asset:rtx-card@1'), 403)).error.code, 'auth.base-readonly');
  assert.equal((await call('PUT', path, a.token, patch(1, 'shots/s01/assets/subject', 'asset:rtx-card@1'), 403)).error.code, 'auth.base-readonly');
  assert.equal((await call('PUT', path, a.token, patch(1, 'shots/s01/roles/hero', 'other'), 403)).error.code, 'auth.base-readonly');
  assert.equal((await call('PUT', path, a.token, patch(1, 'title', 'ORBIT'))).data.rev, 2);
  const unknown = { ...question28, assets: { subject: 'unavailable' } };
  assert.match((await call('POST', '/v1/films', account, { question: unknown }, 422)).error.message, /subject/);
});

test('旧片的未知键可以直接 rename，候选的新键提供更正提示', async () => {
  const a = await create();
  const path = `/v1/films/${a.film}/film`;
  const file = join(root, 'films', a.film, 'film.json');
  const next = patch(1, 'titele', 'FRESH');
  const fresh = await call('PUT', path, a.token, next, 422);
  assert.ok(fresh.diagnostics.some(d => !d.fix && d.hint?.includes('title')));
  assert.equal((await call('PUT', path + '?applyFixes=machine', a.token, next)).data.applied, 1);
  const legacy = JSON.parse(readFileSync(file));
  legacy.titele = legacy.title;
  delete legacy.title;
  writeFileSync(file, JSON.stringify(legacy));
  const rejected = await call('PUT', path, a.token, patch(2, 'seed', 123), 422);
  const fix = rejected.diagnostics.find(d => d.fix?.op === 'rename').fix;
  assert.equal(fix.applicability, 'machine');
  const { applicability, ...op } = fix;
  await call('PUT', path, a.token, { format: 'patch/0.1', rev: 2, ops: [op] });
  assert.equal((await call('GET', path, a.token)).data.film.title, 'FRESH');
});

test('单帧纯函数门明记 skipped', async () => {
  const a = await create();
  const film = (await call('GET', `/v1/films/${a.film}/film`, a.token)).data.film;
  film.shots[0].out = film.output.frames = 1;
  const result = await layerL2({ film, shots: film.shots, records: [] });
  assert.equal(result.gates[0].status, 'skipped');
  assert.equal(result.gates[0].ok, undefined);
  assert.match(result.gates[0].reason, /两帧/);
});

test('考题明确要求的文案缺失时六件套报告记 skipped、基础门拒绝收获', { skip: media, timeout: 120000 }, async () => {
  const question = { ...question28, deliverable: { size: [640, 360], fps: '24/1', frames: 4, audio: 'none' }, basePredicates: ['text_matches(copy)'] };
  const a = await create({ question });
  let result = await call('POST', `/v1/films/${a.film}/deliver`, a.token, { wait: 30 }, null);
  while (['queued', 'running'].includes(result.data.status)) result = await call('GET', `/v1/jobs/${result.data.job}?wait=30`, a.token, undefined, null);
  assert.equal(result.ok, false);
  assert.equal(result.data.status, 'succeeded');
  const dir = join(root, 'films', a.film, 'deliver', result.data.job);
  const { verification: v } = JSON.parse(readFileSync(join(dir, 'bundle/report.json')));
  assert.equal(v.layers.L3.basePass, false);
  const required = v.verdicts.filter(r => r.id === 'pred.text_matches' && r.base);
  assert.equal(required.length, 2);
  assert.ok(required.every(r => r.status === 'skipped' && r.reason));
  for (const verdict of v.verdicts) assert.ok(checkVerdict(verdict), JSON.stringify(checkVerdict.errors));
  assert.equal(JSON.parse(readFileSync(join(dir, 'outcome.json'))).data.harvest.triggered, false);
  assert.ok(!readFileSync(join(root, 'meta', `${a.film}.ledger.jsonl`), 'utf8').includes('harvest-hook'));
});

test('审片适配器验证每条意见，第三方异常正文不进入报告', async () => {
  const film = { id: 'film', output: { frames: 8 }, shots: [] };
  const review = value => layerL5({ film, reviewer: { review: async () => value } });
  const opinion = { frames: [0, 7], evidence: '首格主角靠左', severity: 'low', comment: '调整构图' };
  for (const value of [{}, { opinions: null }, { opinions: [opinion, {}] }, { opinions: [{ ...opinion, frames: [2, 8] }] }, { opinions: [], suggestedPredicates: [1] }]) {
    assert.equal((await review(value)).status, 'failed');
  }
  assert.deepEqual((await review({ opinions: [opinion] })).opinions, [opinion]);
  assert.equal((await review({ opinions: [] })).status, 'ok');
  const marker = randomBytes(20).toString('hex');
  const failed = await layerL5({ film, reviewer: { async review() { throw new Error(marker); } } });
  assert.equal(failed.status, 'failed');
  assert.ok(!JSON.stringify(failed).includes(marker));
});

test('视觉客户端拒绝损坏的 JSON、遗漏字段和上游错误回显', async () => {
  let status = 200, answer = '{}';
  const marker = randomBytes(24).toString('hex');
  const mock = createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: answer } }] }) : marker);
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  try {
    const reviewer = createOpenAiVisionReviewer({ endpoint: `http://127.0.0.1:${mock.address().port}`, apiKey: marker, model: 'vision-test', ledgerPath: join(root, 'vision.jsonl') });
    const run = () => layerL5({ reviewer, images: [], film: { id: 'film', output: { frames: 2 }, shots: [] } });
    for (const invalid of ['{}', 'null', '{"opinions":[{}]}', 'prefix {"opinions":[]}']) {
      answer = invalid;
      assert.equal((await run()).status, 'failed');
    }
    answer = '{"opinions":[]}';
    assert.equal((await run()).status, 'ok');
    status = 502;
    const failed = await run();
    assert.match(failed.reason, /502/);
    assert.ok(!JSON.stringify(failed).includes(marker));
  } finally { await new Promise(resolve => mock.close(resolve)); }
});

test('正确键已存在时保留未知键 hint 并支持 applyFixes=machine 改写路径', async () => {
  const a = await create();
  const path = `/v1/films/${a.film}/film`;
  let rev = 1;
  const cases = [
    ['shots/s01/seedd', 7, 'seed', f => f.shots[0].seed, 7],
    ['outputt', { size: [640, 360], fps: '24/1', frames: 60 }, 'output', f => f.output, { size: [640, 360], fps: '24/1', frames: 60 }],
    ['shots/s01/colorReff', 'display', 'colorRef', f => f.shots[0].colorRef, 'display'],
    ['shots/s01/cards/title/usee', 'overlay.title@1', 'use', f => f.shots[0].cards[0].use, 'overlay.title@1'],
    ['style/vieww', { scene: 'agx-mhc', display: 'srgb' }, 'view', f => f.style.view, { scene: 'agx-mhc', display: 'srgb' }],
  ];
  for (const [typoPath, value, expectKey, pick, expected] of cases) {
    const body = patch(rev, typoPath, value);
    const rejected = await call('PUT', path, a.token, body, 422);
    assert.equal(rejected.error.code, 'contract.unknown-key');
    assert.ok(rejected.diagnostics.some(d => !d.fix && d.hint?.includes(expectKey)), `${typoPath}: ${JSON.stringify(rejected.diagnostics)}`);
    const fixed = await call('PUT', `${path}?applyFixes=machine`, a.token, body);
    assert.equal(fixed.data.applied, 1);
    rev = fixed.data.rev;
    const film = (await call('GET', path, a.token)).data.film;
    assert.deepEqual(pick(film), expected);
  }
});

test('L3 过滤非有限音频量测值且错误脱敏保留可诊断业务原因', async () => {
  const a = await create();
  const film = (await call('GET', `/v1/films/${a.film}/film`, a.token)).data.film;
  const res = layerL3({
    film,
    measured: {
      frames: [0, 1].map(frame => ({ frame, meta: { entities: [], cuts: [], luma: { mean: 0.5, min: 0.1, max: 0.9 } } })),
      audio: { loudnessLufs: -120, truePeakDbtp: -120 },
    },
  });
  for (const v of res.verdicts) {
    assert.notEqual(v.value, null);
    assert.ok(checkVerdict(v), JSON.stringify(checkVerdict.errors));
  }
  const clean = sanitizeErrorText('母带不达标：集成响度 -70 LUFS（目标 -14 ± 1），真峰值 1.4 dBTP（上限 -1）');
  assert.match(clean, /母带不达标：集成响度 -70 LUFS/);
  const posixSpacePath = ['', 'Users', 'alice', 'Tools Directory', 'ReviewFixture', 'ffmpeg'].join('/');
  const winPath = ['C:', 'work', 'Tools Directory', 'a.wav'].join('\\');
  const stripped = sanitizeErrorText(`失败：${posixSpacePath} ${winPath} https://example.invalid/api Bearer bma_0123456789abcdef0123456789abcdef0123456789abcdef\n    at internal (beiming/comp/audio.mjs:1:1)`);
  assert.ok(!stripped.includes('alice') && !stripped.includes('ReviewFixture') && !stripped.includes(winPath.slice(0, 6)) && !stripped.includes('https://') && !stripped.includes('bma_') && !stripped.includes('at internal'));
});

test('静音有声轨片名交付不生成 value:null 判定并全过 verdict 契约', { skip: media, timeout: 120000 }, async () => {
  const a = await create();
  await call('PUT', `/v1/films/${a.film}/film`, a.token, patch(1, 'events', []));
  let res = await call('POST', `/v1/films/${a.film}/deliver`, a.token, { wait: 30 }, null);
  while (['queued', 'running'].includes(res.data.status)) res = await call('GET', `/v1/jobs/${res.data.job}?wait=30`, a.token, undefined, null);
  assert.equal(res.data.status, 'succeeded');
  const report = JSON.parse(readFileSync(join(root, 'films', a.film, 'deliver', res.data.job, 'bundle/report.json')));
  for (const verdict of report.verification.verdicts) {
    assert.notEqual(verdict.value, null);
    assert.ok(checkVerdict(verdict), JSON.stringify(checkVerdict.errors));
  }
});

test('缩尺考题正例通过 L2 包围盒门、L3 基础门并交付六件套', { skip: media, timeout: 300000 }, async () => {
  const question = { ...question28, deliverable: { size: [640, 360], fps: '24/1', frames: 4, audio: 'none' }, basePredicates: ['delivery(width=640, height=360, fps=24, frames=4)', 'no_cut @ all'] };
  const a = await create({ question });
  const base = `/v1/films/${a.film}`;
  const runJob = async (kind, body = {}) => {
    let env = await call('POST', `${base}/${kind}`, a.token, { ...body, wait: 30 }, null);
    while (['queued', 'running'].includes(env.data.status)) env = await call('GET', `/v1/jobs/${env.data.job}?wait=30`, a.token, undefined, null);
    const full = env.outputs?.find(o => o.kind === 'response');
    if (full) env = await (await fetch(api.url + full.url, { headers: { authorization: `Bearer ${a.token}` } })).json();
    return env;
  };
  const render = await runJob('render', { tier: 'draft' });
  assert.equal(render.ok, true);
  const verify = await runJob('verify');
  assert.equal(verify.data.layers.L1.ok, true, JSON.stringify(verify));
  assert.equal(verify.data.layers.L2.ok, true, JSON.stringify(verify));
  assert.ok(verify.data.layers.L2.bbox.minIou >= 0.95);
  assert.equal(verify.data.layers.L2.bbox.failures, 0);
  const deliver = await runJob('deliver');
  assert.equal(deliver.ok, true, JSON.stringify(deliver));
  assert.equal(deliver.data.layers.L2.ok, true);
  assert.ok(deliver.data.layers.L2.bbox.minIou >= 0.95);
  assert.equal(deliver.data.layers.L2.bbox.failures, 0);
  assert.equal(deliver.data.layers.L3.basePass, true);
  assert.equal(deliver.data.harvest.triggered, true);
  const bundleDir = join(root, 'films', a.film, 'deliver', deliver.data.job, 'bundle');
  const verified = verifyDeliveryBundle(bundleDir);
  assert.equal(Object.keys(verified.files).length, 6);
  const report = JSON.parse(readFileSync(join(bundleDir, 'report.json')));
  for (const verdict of report.verification.verdicts) assert.ok(checkVerdict(verdict), JSON.stringify(checkVerdict.errors));
});

test('转台模板长片名 RTX 5090 硬切通过并交付六件套', { skip: media, timeout: 300000 }, async () => {
  const a = await create({ template: 'turntable', text: 'RTX 5090', output: { size: [640, 360], fps: '24/1', frames: 24 } });
  let deliver = await call('POST', `/v1/films/${a.film}/deliver`, a.token, { wait: 30 }, null);
  while (['queued', 'running'].includes(deliver.data.status)) deliver = await call('GET', `/v1/jobs/${deliver.data.job}?wait=30`, a.token, undefined, null);
  const full = deliver.outputs?.find(o => o.kind === 'response');
  if (full) deliver = await (await fetch(api.url + full.url, { headers: { authorization: `Bearer ${a.token}` } })).json();
  assert.equal(deliver.ok, true, JSON.stringify(deliver));
  assert.equal(deliver.data.layers.L3.basePass, true);
  assert.deepEqual(deliver.data.failed, []);
  const bundleDir = join(root, 'films', a.film, 'deliver', deliver.data.job, 'bundle');
  assert.equal(Object.keys(verifyDeliveryBundle(bundleDir).files).length, 6);
});

test('短片交付失败保留可诊断响度原因与下一步且不漏路径', { skip: media, timeout: 120000 }, async () => {
  const a = await create({ output: { size: [320, 180], fps: '24/1', frames: 8 } });
  let res = await call('POST', `/v1/films/${a.film}/deliver`, a.token, { wait: 30 }, null);
  while (['queued', 'running'].includes(res.data.status)) res = await call('GET', `/v1/jobs/${res.data.job}?wait=30`, a.token, undefined, null);
  assert.equal(res.ok, false);
  assert.equal(res.data.status, 'failed');
  assert.equal(res.error.code, 'contract.delivery-mismatch');
  assert.match(res.error.message, /母带不达标|LUFS|dBTP/);
  assert.ok(res.error.hint);
  assert.ok(res.next.length > 0);
  const serialized = JSON.stringify(res);
  const homePrefix = `${['', 'Users'].join('/')}/`;
  const tmpPrefix = `${['', 'tmp'].join('/')}/`;
  assert.ok(!serialized.includes(root) && !serialized.includes(homePrefix) && !serialized.includes(tmpPrefix));
});

test('终审四项回归：无声考题保护、混合补丁错误码次序、裸机兜底查找表不污染正式 65³ 表', async () => {
  const silentQ = { ...question28, assets: {}, deliverable: { size: [640, 360], fps: '24/1', frames: 12, audio: 'none' }, basePredicates: ['delivery(width=640, height=360, fps=24, frames=12)', 'no_cut @ all'] };
  const ex = await create({ question: silentQ });
  // 必须修 3：第 1 个 op 写 id、第 2 个 op 写 output/size，按书写顺序报 422 contract.immutable-key
  const mixed = await call('PUT', `/v1/films/${ex.film}/film`, ex.token, {
    format: 'patch/0.1', rev: 1,
    ops: [{ op: 'set', path: 'id', value: 'other' }, { op: 'set', path: 'output/size', value: [320, 180] }],
  }, 422);
  assert.equal(mixed.error.code, 'contract.immutable-key');
  // 必须修 2：无声考题不允许加有声配置或带声事件
  const addAudio = await call('PUT', `/v1/films/${ex.film}/film`, ex.token, {
    format: 'patch/0.1', rev: 1,
    ops: [
      { op: 'set', path: 'audio', value: { mode: 'script', loudness: -14, truePeak: -1 } },
      { op: 'add', path: 'events', value: { id: 'boom', frame: 0, shot: 's01', audio: 'hit.low', sync: 'onset' } },
    ],
  }, 403);
  assert.equal(addAudio.error.code, 'auth.base-readonly');

  // 必须修 1：同一数据目录先在无 Blender 时写 fallback 表，恢复 Blender 后烘正式 65³ agx-mhc.cube
  if (HAS_BLENDER) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'beiming-lut-switch-'));
    const prev = process.env.BEIMING_BLENDER;
    try {
      process.env.BEIMING_BLENDER = join(tmpDir, 'missing-blender');
      const fb = await ensureLut(tmpDir);
      assert.equal(fb.fallback, true);
      assert.ok(fb.path.endsWith('agx-mhc.fallback.cube'));
      assert.equal(existsSync(join(tmpDir, 'view', 'agx-mhc.cube')), false);
      if (prev === undefined) delete process.env.BEIMING_BLENDER;
      else process.env.BEIMING_BLENDER = prev;
      const real = await ensureLut(tmpDir);
      assert.equal(real.fallback, false);
      assert.ok(real.path.endsWith('agx-mhc.cube'));
      assert.notEqual(real.sha256, fb.sha256);
    } finally {
      if (prev === undefined) delete process.env.BEIMING_BLENDER;
      else process.env.BEIMING_BLENDER = prev;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});
