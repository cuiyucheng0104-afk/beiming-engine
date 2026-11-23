// M1b 三项视觉/审片链路修复与主干缺陷 #5 回归测试（零 Blender 依赖：纯 Node + FFmpeg + 无头浏览器）。
// 覆盖：
//   1. callApi() 对 HTTP 2xx 图像响应（image/png|jpeg|webp）回传 base64 载荷并严守 <= 8 MiB 上限；
//   2. runHandsOnAgent() 与 runDelegateOrchestrator() 在工具取图后紧跟注入多模态 image_url 消息（含多工具调用顺序与预算估算）；
//   3. reviewMaterials()（成片模式）与 frames 模式审片均向视觉模型提供未缩放原尺寸关键帧（匹配 output.size）与需求原文逐级兜底；
//   4. writeVerification() 对齐顶层 report.ok 与 verification.ok、并排写出 unresolvedReviewOpinions，verifyDeliveryBundle() 与 deliver 响应一致。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import question28 from '../kernel/contracts/question-file/examples/full.json' with { type: 'json' };
import { tools, verifyDeliveryBundle } from '../comp/index.mjs';
import { encodePng, pngSize } from '../observe/index.mjs';
import {
  callApi,
  createOpenAiVisionReviewer,
  issueAccountToken,
  runDelegateOrchestrator,
  runHandsOnAgent,
  startServer,
} from './index.mjs';
import { reviewMaterials } from './pipeline.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function threeMediaSkip() {
  const { ffmpeg, ffprobe } = tools();
  for (const [name, bin, args] of [['ffmpeg', ffmpeg, ['-version']], ['ffprobe', ffprobe, ['-version']]]) {
    if (!bin || spawnSync(bin, args, { stdio: 'ignore', timeout: 20000 }).status !== 0) return `缺少可执行的 ${name}`;
  }
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  if (spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 30000 }).status !== 0) return '无头浏览器不可执行';
  return false;
}

const SKIP_MEDIA = threeMediaSkip();

const TINY_PNG = encodePng({ width: 4, height: 2, rgb: new Uint8Array(4 * 2 * 3).fill(180) });
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const TINY_WEBP = Buffer.from('RIFF\x14\x00\x00\x00WEBPVP8 \x08\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1');

async function waitJob(baseUrl, token, jobId) {
  let env;
  for (let i = 0; i < 30; i++) {
    env = await (await fetch(`${baseUrl}/v1/jobs/${jobId}?wait=30`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    if (['succeeded', 'failed', 'stopped', 'canceled'].includes(env.data?.status)) break;
  }
  const fullRef = env?.outputs?.find((o) => o.kind === 'response');
  if (fullRef) {
    env = await (await fetch(`${baseUrl}${fullRef.url}`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
  }
  return env;
}

test('M1b-1 callApi() 图像响应多模态载荷与 8 MiB 安全上限（含真实 startServer 产物 Content-Type）', async () => {
  const EIGHT_MIB = 8 * 1024 * 1024;
  const exactCap = Buffer.alloc(EIGHT_MIB, 0x41);
  const overCap = Buffer.alloc(EIGHT_MIB + 1, 0x42);

  const mock = createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/img/png') {
      res.writeHead(200, { 'content-type': 'image/png; charset=binary' });
      res.end(TINY_PNG);
      return;
    }
    if (req.url === '/v1/img/jpeg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(TINY_JPEG);
      return;
    }
    if (req.url === '/v1/img/webp') {
      res.writeHead(200, { 'content-type': 'image/webp' });
      res.end(TINY_WEBP);
      return;
    }
    if (req.url === '/v1/img/exact-cap') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(exactCap);
      return;
    }
    if (req.url === '/v1/img/over-cap') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(overCap);
      return;
    }
    if (req.url === '/v1/img/empty') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(0));
      return;
    }
    if (req.url === '/v1/img/err') {
      res.writeHead(404, { 'content-type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    if (req.url === '/v1/img/svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg/>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));

  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-callapi-'));
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer: null });

  try {
    const client = { baseUrl: `http://127.0.0.1:${mock.address().port}`, account: 'acct', workspaces: {}, jobs: {} };

    // 1) png / jpeg / webp 均附带 base64 image 且 text 标 imageAttached: true
    for (const [path, mimeType, raw] of [
      ['/v1/img/png', 'image/png', TINY_PNG],
      ['/v1/img/jpeg', 'image/jpeg', TINY_JPEG],
      ['/v1/img/webp', 'image/webp', TINY_WEBP],
    ]) {
      const r = await callApi(client, { method: 'GET', path });
      const meta = JSON.parse(r.text);
      assert.equal(meta.status, 200);
      assert.equal(meta.bytes, raw.length);
      assert.equal(meta.imageAttached, true);
      assert.equal(r.call.imageAttached, true);
      assert.ok(r.image, `${path} 必须附加 image 对象`);
      assert.equal(r.image.mimeType, mimeType);
      assert.equal(r.image.bytes, raw.length);
      assert.equal(r.image.path, path);
      assert.ok(Buffer.from(r.image.base64, 'base64').equals(raw));
    }

    // 2) 恰好 8 MiB 允许附加，8 MiB + 1 拒绝附加仅回元数据，0 字节不附加
    const atCap = await callApi(client, { method: 'GET', path: '/v1/img/exact-cap' });
    assert.equal(JSON.parse(atCap.text).imageAttached, true);
    assert.equal(atCap.image?.bytes, EIGHT_MIB);
    assert.equal(Buffer.from(atCap.image.base64, 'base64').length, EIGHT_MIB);

    const tooBig = await callApi(client, { method: 'GET', path: '/v1/img/over-cap' });
    assert.equal(JSON.parse(tooBig.text).imageAttached, false);
    assert.equal(JSON.parse(tooBig.text).bytes, EIGHT_MIB + 1);
    assert.equal(tooBig.image, undefined);

    const empty = await callApi(client, { method: 'GET', path: '/v1/img/empty' });
    assert.equal(JSON.parse(empty.text).imageAttached, false);
    assert.equal(empty.image, undefined);

    // 3) 非 2xx / 非支持图像类型（svg、octet-stream）绝不附加 image
    const errRes = await callApi(client, { method: 'GET', path: '/v1/img/err' });
    assert.equal(errRes.image, undefined);
    const svgRes = await callApi(client, { method: 'GET', path: '/v1/img/svg' });
    assert.equal(svgRes.image, undefined);
    const binRes = await callApi(client, { method: 'GET', path: '/v1/bin/data' });
    assert.equal(binRes.image, undefined);
    assert.equal(JSON.parse(binRes.text).bytes, 4);

    // 4) 真实 startServer 产物接口：.png / .jpg / .webp 回图像 Content-Type 并被 callApi 自动附加，.mp4 保持 octet-stream
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ template: 'title' }),
    })).json();
    const filmId = created.data.film;
    const deliverDir = join(dataDir, 'films', filmId, 'deliver', 'check');
    mkdirSync(deliverDir, { recursive: true });
    writeFileSync(join(deliverDir, 'frame.png'), TINY_PNG);
    writeFileSync(join(deliverDir, 'still.jpg'), TINY_JPEG);
    writeFileSync(join(deliverDir, 'thumb.webp'), TINY_WEBP);
    writeFileSync(join(deliverDir, 'clip.mp4'), Buffer.from([0, 0, 0, 8]));

    const srvClient = { baseUrl: api.url, account: token, workspaces: { [filmId]: created.data.token }, jobs: {} };
    for (const [name, mimeType, raw] of [
      ['check/frame.png', 'image/png', TINY_PNG],
      ['check/still.jpg', 'image/jpeg', TINY_JPEG],
      ['check/thumb.webp', 'image/webp', TINY_WEBP],
    ]) {
      const r = await callApi(srvClient, { method: 'GET', path: `/v1/films/${filmId}/artifacts/${name}` });
      assert.equal(JSON.parse(r.text).imageAttached, true, `${name} 应通过 startServer 自动附图像`);
      assert.equal(r.image?.mimeType, mimeType);
      assert.ok(Buffer.from(r.image.base64, 'base64').equals(raw));
    }
    const mp4 = await callApi(srvClient, { method: 'GET', path: `/v1/films/${filmId}/artifacts/check/clip.mp4` });
    assert.equal(mp4.image, undefined);
    assert.equal(JSON.parse(mp4.text).contentType, 'application/octet-stream');
  } finally {
    await api.close();
    await new Promise((r) => mock.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-2 做片代理视觉闭环：runHandsOnAgent 与 runDelegateOrchestrator 取图后紧跟注入 image_url 多模态消息', { skip: SKIP_MEDIA, timeout: 240000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-agent-vision-'));
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer: null });

  // Part A: runHandsOnAgent 端到端渲帧 -> observe/sheet -> GET contact.png（并测同轮双 tool_calls 顺序）
  const handsOnRequests = [];
  let handsOnRound = 0;
  let handsOnFilm = null;
  let handsOnContactUrl = null;
  let handsOnContactSha = null;

  const mockHandsOn = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    handsOnRequests.push(body);
    handsOnRound++;
    const last = body.messages.at(-1);
    const toolBody = last.role === 'tool' ? JSON.parse(last.content).body : null;
    let msg;
    if (handsOnRound === 1) {
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'h1',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: '/v1/films',
              body: { template: 'title', text: 'VISION', output: { size: [320, 180], fps: '10/1', frames: 6 } },
            }),
          },
        }],
      };
    } else if (handsOnRound === 2) {
      handsOnFilm = toolBody.data.film;
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'h2',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: `/v1/films/${handsOnFilm}/render`,
              body: { tier: 'draft', wait: 30 },
            }),
          },
        }],
      };
    } else if (handsOnRound === 3) {
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'h3',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: `/v1/films/${handsOnFilm}/observe/sheet`,
              body: { count: 4 },
            }),
          },
        }],
      };
    } else if (handsOnRound === 4) {
      const contactOut = toolBody.outputs.find((o) => o.kind === 'contact');
      handsOnContactUrl = contactOut.url;
      handsOnContactSha = contactOut.sha256;
      // 同轮并发拉两张图，校验两个 tool 消息都在 user 多模态消息之前
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'h4a', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'GET', path: handsOnContactUrl }) } },
          { id: 'h4b', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'GET', path: handsOnContactUrl }) } },
        ],
      };
    } else {
      msg = { role: 'assistant', content: '已观察到联系表图像内容。' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'vision-hands-on', choices: [{ message: msg }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  });
  await new Promise((r) => mockHandsOn.listen(0, '127.0.0.1', r));

  // Part B: runDelegateOrchestrator 镜头工渲帧 -> observe/sheet -> GET contact.png -> verify -> finalizer deliver
  const delegateWorkerAfterImg = [];
  let delegateContactUrl = null;
  let delegateContactSha = null;
  const mockDelegate = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sys = String(body.messages[0]?.content ?? '');
    const roleTag = /\[ROLE:([^\]]+)\]/.exec(sys)?.[1] ?? '';
    const filmId = /f_\d{3}/.exec(JSON.stringify(body.messages))?.[0];
    const toolMsgs = body.messages.filter((m) => m.role === 'tool');
    let msg;

    if (roleTag === 'director') {
      msg = { role: 'assistant', content: '导演确认完毕' };
    } else if (roleTag.startsWith('shot-worker:')) {
      if (toolMsgs.length === 0) {
        msg = { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `/v1/films/${filmId}/render`, body: { shots: ['s01'], tier: 'draft' } }) } }] };
      } else if (toolMsgs.length === 1) {
        msg = { role: 'assistant', content: null, tool_calls: [{ id: 'w2', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `/v1/films/${filmId}/observe/sheet`, body: { count: 4 } }) } }] };
      } else if (toolMsgs.length === 2) {
        const sheetEnv = JSON.parse(toolMsgs[1].content).body;
        const contactOut = sheetEnv.outputs.find((o) => o.kind === 'contact');
        delegateContactUrl = contactOut.url;
        delegateContactSha = contactOut.sha256;
        msg = { role: 'assistant', content: null, tool_calls: [{ id: 'w3', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'GET', path: delegateContactUrl }) } }] };
      } else if (toolMsgs.length === 3) {
        delegateWorkerAfterImg.push(body.messages);
        msg = { role: 'assistant', content: null, tool_calls: [{ id: 'w4', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `/v1/films/${filmId}/verify`, body: { shots: ['s01'], tier: 'draft' } }) } }] };
      } else {
        msg = { role: 'assistant', content: '已视觉检查并通过草稿核验' };
      }
    } else {
      if (toolMsgs.length === 0) {
        msg = { role: 'assistant', content: null, tool_calls: [{ id: 'f1', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `/v1/films/${filmId}/deliver`, body: { tier: 'final' } }) } }] };
      } else {
        msg = { role: 'assistant', content: '交付完成' };
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: msg }], usage: { prompt_tokens: 150, completion_tokens: 30 } }));
  });
  await new Promise((r) => mockDelegate.listen(0, '127.0.0.1', r));

  try {
    const hoRes = await runHandsOnAgent({
      baseUrl: api.url,
      token,
      brief: '建一部片名测试片并检查联系表图像',
      ledgerPath: join(dataDir, 'hands-on-ledger.jsonl'),
      endpoint: `http://127.0.0.1:${mockHandsOn.address().port}/v1`,
      apiKey: 'k',
      model: 'vision-hands-on',
    });
    assert.equal(hoRes.status, 'done');
    const turnAfterImage = handsOnRequests[4];
    const msgs = turnAfterImage.messages;
    // 顺序必须为: assistant(tool_calls=[h4a,h4b]) -> tool(h4a) -> tool(h4b) -> user(image_url...)
    const tail4 = msgs.slice(-4);
    assert.equal(tail4[0].role, 'assistant');
    assert.equal(tail4[1].role, 'tool');
    assert.equal(tail4[1].tool_call_id, 'h4a');
    assert.equal(JSON.parse(tail4[1].content).imageAttached, true);
    assert.equal(tail4[2].role, 'tool');
    assert.equal(tail4[2].tool_call_id, 'h4b');
    assert.equal(JSON.parse(tail4[2].content).imageAttached, true);
    assert.equal(tail4[3].role, 'user');
    assert.ok(Array.isArray(tail4[3].content), '多模态 user 消息 content 必须是数组');
    const imgParts = tail4[3].content.filter((p) => p.type === 'image_url');
    assert.equal(imgParts.length, 2, '同轮两次取图应注入两张 image_url');
    for (const part of imgParts) {
      assert.match(part.image_url.url, /^data:image\/png;base64,/);
      const raw = Buffer.from(part.image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64');
      assert.equal(sha256(raw), handsOnContactSha, '注入的 base64 图像必须与服务端 contact.png 逐字节一致');
    }

    // Part B: Delegate orchestrator
    const createdDel = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        text: 'DELVIS',
        output: { size: [320, 180], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(createdDel.ok, true);

    const delOut = await runDelegateOrchestrator({
      baseUrl: api.url,
      accountToken: token,
      filmId: createdDel.data.film,
      workspaceToken: createdDel.data.token,
      brief: '测试委托模式镜头工视觉查看联系表并完成交付',
      budget: { tokens: 120_000, gpuSeconds: 300, wallSeconds: 300 },
      endpoint: `http://127.0.0.1:${mockDelegate.address().port}/v1`,
      apiKey: 'k',
      directorModel: 'claude-opus-5-5',
      workerModel: 'claude-sonnet-5-5',
      reserveTokens: 5_000,
    });
    assert.equal(delOut.status, 'succeeded', `委托编排必须成功: ${JSON.stringify(delOut)}`);
    assert.equal(delegateWorkerAfterImg.length, 1);
    const workerMsgs = delegateWorkerAfterImg[0];
    const wTail = workerMsgs.slice(-2);
    assert.equal(wTail[0].role, 'tool');
    assert.equal(wTail[0].tool_call_id, 'w3');
    assert.equal(JSON.parse(wTail[0].content).imageAttached, true);
    assert.equal(wTail[1].role, 'user');
    assert.ok(Array.isArray(wTail[1].content));
    const wImg = wTail[1].content.find((p) => p.type === 'image_url');
    assert.ok(wImg, '委托镜头工必须收到多模态 image_url 消息');
    assert.match(wImg.image_url.url, /^data:image\/png;base64,/);
    const wBytes = Buffer.from(wImg.image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64');
    assert.equal(sha256(wBytes), delegateContactSha, '委托镜头工收到的 base64 图像必须与 contact.png 逐字节一致');
  } finally {
    await api.close();
    await new Promise((r) => mockHandsOn.close(r));
    await new Promise((r) => mockDelegate.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-3 审片模型接收原尺寸关键帧（匹配 film.output.size）与需求原文逐级兜底', { skip: SKIP_MEDIA, timeout: 240000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-review-materials-'));
  const ledgerPath = join(dataDir, 'external-ledger.jsonl');
  const seenVisionRequests = [];

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seenVisionRequests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-m1b',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 400, completion_tokens: 30 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'vkey',
    model: 'gemini-vision-m1b',
    ledgerPath,
    votesPerPerspective: 1,
  });

  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer });

  try {
    // 1) hands-on 建片传入 brief：验证 meta.brief 落盘、frames 模式审片收到原尺寸 640x360 关键帧与 meta.brief
    const created1 = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'hands-on',
        template: 'title',
        title: '标题兜底一',
        brief: '亲手模式需求原文：画面居中展示高清片名',
        text: 'HD TITLE',
        output: { size: [640, 360], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(created1.ok, true);
    const f1 = created1.data.film;
    const t1 = created1.data.token;
    const meta1 = JSON.parse(readFileSync(join(dataDir, 'meta', `${f1}.json`), 'utf8'));
    assert.equal(meta1.brief, '亲手模式需求原文：画面居中展示高清片名', '亲手模式 POST /v1/films 传入 brief 必须落入 meta.brief');

    const r1 = await (await fetch(`${api.url}/v1/films/${f1}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'final', wait: 30 }),
    })).json();
    const r1Done = await waitJob(api.url, t1, r1.data.job);
    assert.equal(r1Done.data.status, 'succeeded');

    // 未传 request brief：应落回 meta.brief，且附带原尺寸 [640, 360] 关键帧
    seenVisionRequests.length = 0;
    const revFrames = await (await fetch(`${api.url}/v1/films/${f1}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    assert.equal(revFrames.ok, true);
    assert.equal(revFrames.data.material, 'frames');
    assert.ok(seenVisionRequests.length > 0);
    const frameReqParts = seenVisionRequests[0].messages[1].content;
    const frameReqText = frameReqParts.find((p) => p.type === 'text').text;
    assert.match(frameReqText, /需求原文：亲手模式需求原文：画面居中展示高清片名/);
    assert.match(frameReqText, /keyframe-f\d+/);
    assert.match(frameReqText, /原尺寸关键帧/);
    const frameImgs = frameReqParts
      .filter((p) => p.type === 'image_url')
      .map((p) => pngSize(Buffer.from(p.image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64')));
    assert.ok(frameImgs.length >= 2, `frames 模式审片应同时包含联系表与原尺寸关键帧，实际仅 ${frameImgs.length} 张`);
    assert.ok(
      frameImgs.some(([w, h]) => w === 640 && h === 360),
      `frames 模式审片必须包含原尺寸 640x360 关键帧，实际尺寸列表：${JSON.stringify(frameImgs)}`,
    );

    // 显式传 request brief 应覆盖 meta.brief
    seenVisionRequests.length = 0;
    const revOverride = await (await fetch(`${api.url}/v1/films/${f1}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1}`, 'content-type': 'application/json' },
      body: JSON.stringify({ brief: '请求级覆盖需求原文' }),
    })).json();
    assert.equal(revOverride.ok, true);
    assert.match(seenVisionRequests[0].messages[1].content[0].text, /需求原文：请求级覆盖需求原文/);

    // 2) deliver 成片模式（master）：审片收到 meta.brief 与未缩放 640x360 关键帧（并落盘到 keyframes/）
    seenVisionRequests.length = 0;
    const d1 = await (await fetch(`${api.url}/v1/films/${f1}/deliver`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const d1Done = await waitJob(api.url, t1, d1.data.job);
    assert.equal(d1Done.data.status, 'succeeded');
    assert.ok(seenVisionRequests.length > 0);
    const masterReqParts = seenVisionRequests[0].messages[1].content;
    assert.match(masterReqParts[0].text, /需求原文：亲手模式需求原文：画面居中展示高清片名/);
    assert.match(masterReqParts[0].text, /keyframe-f\d+/);
    const masterImgSizes = masterReqParts
      .filter((p) => p.type === 'image_url')
      .map((p) => pngSize(Buffer.from(p.image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64')));
    assert.ok(
      masterImgSizes.some(([w, h]) => w === 640 && h === 360),
      `deliver 成片审片必须包含原尺寸 640x360 关键帧，实际尺寸列表：${JSON.stringify(masterImgSizes)}`,
    );

    // 直接验证 reviewMaterials() 多镜头上限 <= 4 帧且原尺寸落盘 keyframes/keyframe-f<帧号>.png
    const masterPath = join(dataDir, 'films', f1, 'deliver', d1Done.data.job, 'bundle', 'master.mp4');
    const multiOutDir = join(dataDir, 'multi-shot-review');
    const synthetic6ShotFilm = {
      output: { size: [640, 360], fps: '10/1', frames: 6 },
      shots: [0, 1, 2, 3, 4, 5].map((i) => ({ id: `s0${i + 1}`, in: i, out: i + 1 })),
      transitions: [],
    };
    const mats = reviewMaterials({ master: masterPath, fps: '10/1', film: synthetic6ShotFilm, outDir: multiOutDir });
    const kfs = mats.filter((m) => /^keyframe-f\d+$/.test(m.name));
    assert.ok(mats.some((m) => m.name === 'contact'), 'reviewMaterials 必须保留 contact');
    assert.equal(kfs.length, 4, `6 镜头片子关键帧必须均匀上限为 4 帧，实际 ${kfs.length}`);
    for (const kf of kfs) {
      assert.ok(kf.path.startsWith(join(multiOutDir, 'keyframes')), `关键帧必须落盘到 keyframes 目录: ${kf.path}`);
      assert.equal(existsSync(kf.path), true);
      assert.deepEqual(pngSize(readFileSync(kf.path)), [640, 360]);
    }

    // 3) 需求原文兜底顺序：无 brief 时落回 meta.question.brief -> film.title
    const qBrief = {
      ...question28,
      brief: '来自考题 question.brief 的原始需求',
      assets: {},
      deliverable: { size: [320, 180], fps: '10/1', frames: 6, audio: 'none' },
      basePredicates: ['delivery(width=320, height=180, fps=10, frames=6)', 'no_cut @ all'],
    };
    const createdQ = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: qBrief }),
    })).json();
    assert.equal(createdQ.ok, true);
    const rq = await (await fetch(`${api.url}/v1/films/${createdQ.data.film}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${createdQ.data.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'draft', wait: 30 }),
    })).json();
    await waitJob(api.url, createdQ.data.token, rq.data.job);
    seenVisionRequests.length = 0;
    await fetch(`${api.url}/v1/films/${createdQ.data.film}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${createdQ.data.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.match(seenVisionRequests[0].messages[1].content[0].text, /需求原文：来自考题 question\.brief 的原始需求/);

    // 仅给 film.title，无 brief 无 question：应落回 film.title
    const createdTitle = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        title: '仅靠片名标题兜底的片子',
        output: { size: [320, 180], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(createdTitle.ok, true);
    const rt = await (await fetch(`${api.url}/v1/films/${createdTitle.data.film}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${createdTitle.data.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'draft', wait: 30 }),
    })).json();
    await waitJob(api.url, createdTitle.data.token, rt.data.job);
    seenVisionRequests.length = 0;
    await fetch(`${api.url}/v1/films/${createdTitle.data.film}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${createdTitle.data.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.match(seenVisionRequests[0].messages[1].content[0].text, /需求原文：仅靠片名标题兜底的片子/);
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-4 报告顶层 ok 与 verification.ok 对齐、unresolvedReviewOpinions 与 ok 并排且与 deliver 响应一致', { skip: SKIP_MEDIA, timeout: 240000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-report-align-'));
  const ledgerPath = join(dataDir, 'external-ledger.jsonl');
  let mode = 'two-opinions';

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sys = String(body.messages?.[0]?.content ?? '');
    const pMatch = /\[PERSPECTIVE:([^\]]+)\]/.exec(sys)?.[1] ?? '';
    const vMatch = Number(/\[VOTE:(\d+)\]/.exec(sys)?.[1] ?? '1');

    let opinions = [];
    if (mode === 'two-opinions') {
      if (pMatch === 'composition-readability' && (vMatch === 1 || vMatch === 2)) {
        opinions = [
          { issueKey: 'title-readability', frames: [0, 3], severity: 'warn', evidence: '主标题偏小', comment: '增大字号' },
          ...(vMatch === 1 ? [{ issueKey: 'margin-clipping', frames: [4, 5], severity: 'info', evidence: '单票孤立意见', comment: '不应计入成立意见数' }] : []),
        ];
      } else if (pMatch === 'look-consistency' && (vMatch === 1 || vMatch === 2)) {
        opinions = [
          { issueKey: 'color-consistency', frames: [1, 4], severity: 'warn', evidence: '背景微偏色', comment: '统一纸底色调' },
        ];
      }
    } else if (mode === 'one-opinion') {
      if (pMatch === 'composition-readability' && (vMatch === 1 || vMatch === 2)) {
        opinions = [
          { issueKey: 'title-readability', frames: [0, 3], severity: 'error', evidence: '文案不匹配', comment: '补齐考题文案' },
        ];
      }
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-align',
      choices: [{ message: { content: JSON.stringify({ grade: '一般', opinions, suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 300, completion_tokens: 40 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'vkey',
    model: 'gemini-vision-align',
    ledgerPath,
  });

  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer });

  try {
    // 场景 A：硬门全部通过 + L5 成立 2 条意见（另有 1 条 1 票孤立意见不计入）
    mode = 'two-opinions';
    const okFilm = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        brief: '通过硬门但有 2 条审片意见',
        text: 'ALIGN',
        output: { size: [320, 180], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(okFilm.ok, true);
    const dOk = await (await fetch(`${api.url}/v1/films/${okFilm.data.film}/deliver`, {
      method: 'POST',
      headers: { authorization: `Bearer ${okFilm.data.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const dOkDone = await waitJob(api.url, okFilm.data.token, dOk.data.job);
    assert.equal(dOkDone.ok, true);
    assert.equal(dOkDone.data.status, 'succeeded');
    assert.equal(dOkDone.data.unresolvedReviewOpinions, 2, 'deliver 响应 data 必须带出 unresolvedReviewOpinions=2');

    const okBundleDir = join(dataDir, 'films', okFilm.data.film, 'deliver', dOkDone.data.job, 'bundle');
    assert.equal(Object.keys(verifyDeliveryBundle(okBundleDir).files).length, 6);
    const okReport = JSON.parse(readFileSync(join(okBundleDir, 'report.json'), 'utf8'));
    assert.equal(okReport.ok, true);
    assert.equal(okReport.verification.ok, true);
    assert.equal(okReport.verification.L5.opinions.length, 2);
    assert.equal(okReport.unresolvedReviewOpinions, 2);
    const okKeys = Object.keys(okReport);
    assert.equal(
      okKeys.indexOf('unresolvedReviewOpinions'),
      okKeys.indexOf('ok') + 1,
      `report.json 顶层 unresolvedReviewOpinions 必须紧邻 ok 并排写入，实际键顺序：${JSON.stringify(okKeys)}`,
    );

    // 场景 B：硬门失败（L3 basePass=false -> verification.ok=false）+ L5 成立 1 条意见
    mode = 'one-opinion';
    const failQuestion = {
      ...question28,
      brief: '硬门失败对齐测试需求',
      assets: {},
      deliverable: { size: [320, 180], fps: '10/1', frames: 6, audio: 'none' },
      basePredicates: ['text_matches(copy)'],
    };
    const failFilm = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: failQuestion }),
    })).json();
    assert.equal(failFilm.ok, true);
    const dFail = await (await fetch(`${api.url}/v1/films/${failFilm.data.film}/deliver`, {
      method: 'POST',
      headers: { authorization: `Bearer ${failFilm.data.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const dFailDone = await waitJob(api.url, failFilm.data.token, dFail.data.job);
    assert.equal(dFailDone.ok, false);
    assert.equal(dFailDone.data.status, 'succeeded');
    assert.equal(dFailDone.data.unresolvedReviewOpinions, 1, '硬门失败时 deliver 响应 data 也必须带出 unresolvedReviewOpinions=1');

    const failBundleDir = join(dataDir, 'films', failFilm.data.film, 'deliver', dFailDone.data.job, 'bundle');
    assert.equal(Object.keys(verifyDeliveryBundle(failBundleDir).files).length, 6, 'verification.ok=false 且 report.ok=false 的交付包必须通过完整性复验');
    const failReport = JSON.parse(readFileSync(join(failBundleDir, 'report.json'), 'utf8'));
    assert.equal(failReport.verification.ok, false);
    assert.equal(failReport.ok, false, 'verification.ok=false 时顶层 report.ok 绝不能为 true');
    assert.equal(failReport.unresolvedReviewOpinions, 1);
    const failKeys = Object.keys(failReport);
    assert.equal(
      failKeys.indexOf('unresolvedReviewOpinions'),
      failKeys.indexOf('ok') + 1,
      `硬门失败报告顶层 unresolvedReviewOpinions 也必须紧邻 ok 并排写入，实际键顺序：${JSON.stringify(failKeys)}`,
    );

    // 篡改场景：强制把 ok 改回 true 但 verification.ok=false（即使重新锚定 run.json）也必须被 verifyDeliveryBundle 拒收
    const tampered = { ...failReport, ok: true, files: { ...failReport.files } };
    const run = JSON.parse(readFileSync(join(failBundleDir, 'run.json'), 'utf8'));
    const bodyForHash = { ...tampered, files: { ...tampered.files } };
    delete bodyForHash.files['run.json'];
    run.reportBodySha256 = sha256(Buffer.from(`${JSON.stringify(bodyForHash, null, 2)}\n`));
    const runBytes = Buffer.from(`${JSON.stringify(run, null, 2)}\n`);
    writeFileSync(join(failBundleDir, 'run.json'), runBytes);
    tampered.files['run.json'] = { bytes: runBytes.length, sha256: sha256(runBytes) };
    writeFileSync(join(failBundleDir, 'report.json'), Buffer.from(`${JSON.stringify(tampered, null, 2)}\n`));
    assert.throws(
      () => verifyDeliveryBundle(failBundleDir),
      (e) => e?.code === 'contract.delivery-mismatch',
      'report.ok=true 但 verification.ok=false 的错配报告必须被 verifyDeliveryBundle 拒收',
    );
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
