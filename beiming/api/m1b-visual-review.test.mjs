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
import { reviewKeyframeNumbers, reviewMaterials } from './pipeline.mjs';

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

test('M1b-5 frames 模式审片在默认草稿渲染（半尺寸）与稀疏终渲下仍按镜头中点送出原尺寸关键帧', { skip: SKIP_MEDIA, timeout: 240000 }, async () => {
  // 纯函数单元核验：共用 reviewKeyframeNumbers 选帧逻辑
  assert.deepEqual(
    reviewKeyframeNumbers({ output: { frames: 6 }, shots: [{ id: 's01', in: 0, out: 6 }] }),
    [2],
  );
  assert.deepEqual(
    reviewKeyframeNumbers({
      output: { frames: 60 },
      shots: Array.from({ length: 6 }, (_, i) => ({ id: `s0${i + 1}`, in: i * 10, out: (i + 1) * 10 })),
    }),
    [4, 24, 34, 54],
  );
  assert.deepEqual(
    reviewKeyframeNumbers({
      output: { frames: 20 },
      shots: [{ id: 's01', in: 0, out: 10 }, { id: 's02', in: 10, out: 20 }],
    }, 1),
    [4],
  );

  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-frames-kf-'));
  const ledgerPath = join(dataDir, 'external-ledger.jsonl');
  const seenVisionRequests = [];

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seenVisionRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-kf',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 350, completion_tokens: 25 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'vkey',
    model: 'gemini-vision-kf',
    ledgerPath,
    votesPerPerspective: 1,
  });

  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer });

  try {
    // 1) 建 640x360、6 帧 title 片 -> 默认 POST /render（省略 tier，即 draft 320x180）-> POST /review {}
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        brief: '草稿与稀疏终渲均须送原尺寸中点关键帧',
        text: 'FULLRES',
        output: { size: [640, 360], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(created.ok, true);
    const filmId = created.data.film;
    const wsToken = created.data.token;

    const rDraft = await (await fetch(`${api.url}/v1/films/${filmId}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const rDraftDone = await waitJob(api.url, wsToken, rDraft.data.job);
    assert.equal(rDraftDone.data.status, 'succeeded');

    // 确认草稿索引确实是半尺寸 320x180 且 frames-final.json 尚不存在
    const filmDeliverDir = join(dataDir, 'films', filmId, 'deliver');
    const draftIdx = JSON.parse(readFileSync(join(filmDeliverDir, 'frames-draft.json'), 'utf8'));
    const draftMid = draftIdx.frames.find((f) => f.frame === 2);
    assert.ok(draftMid, '默认草稿抽样应含中点帧 f2');
    assert.deepEqual(
      pngSize(readFileSync(join(dataDir, 'films', filmId, draftMid.png))),
      [320, 180],
      '默认草稿渲染产物应为半尺寸 320x180',
    );
    assert.equal(existsSync(join(filmDeliverDir, 'frames-final.json')), false);

    seenVisionRequests.length = 0;
    const revDraft = await (await fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    assert.equal(revDraft.ok, true);
    assert.equal(revDraft.data.material, 'frames');
    assert.ok(seenVisionRequests.length > 0);

    const draftReviewJson = JSON.parse(readFileSync(join(filmDeliverDir, 'review', 'rev-1', 'review.json'), 'utf8'));
    const draftKfIdx = draftReviewJson.images.indexOf('keyframe-f2');
    assert.ok(draftKfIdx >= 1, `审片记录 images 必须含 keyframe-f2，实际：${JSON.stringify(draftReviewJson.images)}`);
    const draftParts = seenVisionRequests[0].messages[1].content;
    const draftText = draftParts.find((p) => p.type === 'text').text;
    assert.match(draftText, /keyframe-f2/);
    assert.doesNotMatch(draftText, /keyframe-f0/);
    const draftImgParts = draftParts.filter((p) => p.type === 'image_url');
    const draftKfSize = pngSize(Buffer.from(draftImgParts[draftKfIdx].image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64'));
    assert.deepEqual(draftKfSize, [640, 360], `默认草稿渲染后审片 keyframe-f2 必须为原尺寸 640x360，绝非 320x180，实际：${JSON.stringify(draftKfSize)}`);
    assert.equal(
      existsSync(join(filmDeliverDir, 'frames-final.json')),
      false,
      '审片补渲关键帧不得改写 frames-final.json 索引',
    );

    // 2) 同一修订再跑稀疏终渲 POST /render { tier: 'final', frames: [0] } -> POST /review {}
    const rSparse = await (await fetch(`${api.url}/v1/films/${filmId}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'final', frames: [0], wait: 30 }),
    })).json();
    const rSparseDone = await waitJob(api.url, wsToken, rSparse.data.job);
    assert.equal(rSparseDone.data.status, 'succeeded');

    seenVisionRequests.length = 0;
    const revSparse = await (await fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    assert.equal(revSparse.ok, true);
    assert.equal(revSparse.data.material, 'frames');
    const sparseReviewJson = JSON.parse(readFileSync(join(filmDeliverDir, 'review', 'rev-1', 'review.json'), 'utf8'));
    assert.ok(sparseReviewJson.images.includes('keyframe-f2'), '稀疏终渲 [0] 后审片仍须提供镜头中点 keyframe-f2');
    assert.equal(sparseReviewJson.images.includes('keyframe-f0'), false, '稀疏终渲 [0] 后不得退回 keyframe-f0');
    const sparseKfIdx = sparseReviewJson.images.indexOf('keyframe-f2');
    const sparseParts = seenVisionRequests[0].messages[1].content;
    const sparseText = sparseParts.find((p) => p.type === 'text').text;
    assert.match(sparseText, /keyframe-f2/);
    assert.doesNotMatch(sparseText, /keyframe-f0/);
    const sparseImgParts = sparseParts.filter((p) => p.type === 'image_url');
    const sparseKfSize = pngSize(Buffer.from(sparseImgParts[sparseKfIdx].image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64'));
    assert.deepEqual(sparseKfSize, [640, 360], `稀疏终渲后 keyframe-f2 宽高必须为 640x360，实际：${JSON.stringify(sparseKfSize)}`);
    const finalIdxAfter = JSON.parse(readFileSync(join(filmDeliverDir, 'frames-final.json'), 'utf8'));
    assert.deepEqual(finalIdxAfter.frames.map((f) => f.frame), [0], 'frames-final.json 仍只保留用户渲染的 [0]');

    // 3) 独立冷启动新片仅做稀疏终渲 [0]（无前序草稿审片缓存）-> POST /review {} 同样补渲原尺寸中点 keyframe-f2
    const created2 = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        brief: '冷启动稀疏终渲原尺寸中点验证',
        text: 'COLD',
        output: { size: [640, 360], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(created2.ok, true);
    const f2 = created2.data.film;
    const t2 = created2.data.token;
    const rCold = await (await fetch(`${api.url}/v1/films/${f2}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t2}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'final', frames: [0], wait: 30 }),
    })).json();
    const rColdDone = await waitJob(api.url, t2, rCold.data.job);
    assert.equal(rColdDone.data.status, 'succeeded');

    seenVisionRequests.length = 0;
    const revCold = await (await fetch(`${api.url}/v1/films/${f2}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t2}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    assert.equal(revCold.ok, true);
    const coldReviewJson = JSON.parse(readFileSync(join(dataDir, 'films', f2, 'deliver', 'review', 'rev-1', 'review.json'), 'utf8'));
    const coldKfIdx = coldReviewJson.images.indexOf('keyframe-f2');
    assert.ok(coldKfIdx >= 1);
    assert.equal(coldReviewJson.images.includes('keyframe-f0'), false);
    const coldImgParts = seenVisionRequests[0].messages[1].content.filter((p) => p.type === 'image_url');
    assert.deepEqual(
      pngSize(Buffer.from(coldImgParts[coldKfIdx].image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64')),
      [640, 360],
    );
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-6 runHandsOnAgent 转发建片与审片请求时自动补回 brief 需求原文且尊重显式非空传值', { skip: SKIP_MEDIA, timeout: 240000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-handson-brief-'));
  const reviewLedger = join(dataDir, 'review-ledger.jsonl');
  const agentLedger = join(dataDir, 'agent-ledger.jsonl');
  const seenVisionPrompts = [];

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const promptText = body.messages?.[1]?.content?.find((p) => p.type === 'text')?.text ?? '';
    seenVisionPrompts.push(promptText);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-brief',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 300, completion_tokens: 20 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'vkey',
    model: 'gemini-vision-brief',
    ledgerPath: reviewLedger,
    votesPerPerspective: 1,
  });

  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer });

  let round = 0;
  let filmId = null;
  const mockAgent = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    round++;
    const last = body.messages.at(-1);
    const toolBody = last.role === 'tool' ? JSON.parse(last.content).body : null;
    let msg;
    if (round === 1) {
      // 模型建片故意不手抄 brief（带查询串一并覆盖路径判断）
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'b1',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: '/v1/films?source=hands-on',
              body: { template: 'title', text: 'HI', output: { size: [320, 180], fps: '10/1', frames: 6 } },
            }),
          },
        }],
      };
    } else if (round === 2) {
      filmId = toolBody.data.film;
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'b2',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: `/v1/films/${filmId}/render`,
              body: { tier: 'draft', wait: 30 },
            }),
          },
        }],
      };
    } else if (round === 3) {
      // 模型审片传入空对象 {}（不带 brief）
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'b3',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: `/v1/films/${filmId}/review`,
              body: {},
            }),
          },
        }],
      };
    } else if (round === 4) {
      // 验证建片时 meta.brief 已落盘，随后故意清空 meta.brief 以独立验证 POST /review 分支的 brief 自动注入（含空白 body.brief 与省略 body）
      const metaFile = join(dataDir, 'meta', `${filmId}.json`);
      const m = JSON.parse(readFileSync(metaFile, 'utf8'));
      assert.equal(m.brief, '原文要在纯色背景中居中显示大标题', 'runHandsOnAgent 建片省略 body.brief 时必须自动持久化 meta.brief');
      delete m.brief;
      writeFileSync(metaFile, `${JSON.stringify(m, null, 2)}\n`);
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'b4',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: `/v1/films/${filmId}/review?check=blank`,
              body: { brief: '   ' },
            }),
          },
        }],
      };
    } else if (round === 5) {
      // 省略 body 时同样自动补回 brief
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'b5',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: `/v1/films/${filmId}/review`,
            }),
          },
        }],
      };
    } else if (round === 6) {
      // 模型审片显式传非空 body.brief：代理不得覆盖模型显式传值
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'b6',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: `/v1/films/${filmId}/review`,
              body: { brief: '模型显式覆盖的审片要求' },
            }),
          },
        }],
      };
    } else {
      msg = { role: 'assistant', content: '已完成建片、渲染与审片。' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'hands-on-brief-model', choices: [{ message: msg }], usage: { prompt_tokens: 80, completion_tokens: 20 } }));
  });
  await new Promise((r) => mockAgent.listen(0, '127.0.0.1', r));

  try {
    const brief = '原文要在纯色背景中居中显示大标题';
    const hoRes = await runHandsOnAgent({
      baseUrl: api.url,
      token,
      brief,
      ledgerPath: agentLedger,
      endpoint: `http://127.0.0.1:${mockAgent.address().port}/v1`,
      apiKey: 'akey',
      model: 'hands-on-brief-model',
    });
    assert.equal(hoRes.status, 'done');
    assert.ok(filmId, '应成功创建片子');
    assert.deepEqual(hoRes.calls.map((c) => [c.method, c.status, c.ok]), [
      ['POST', 200, true],
      ['POST', 200, true],
      ['POST', 200, true],
      ['POST', 200, true],
      ['POST', 200, true],
      ['POST', 200, true],
    ]);

    // 3 视角 × 3 票 × 4 次 review = 36 次视觉审片调用：前 3 次（27 票）均为自动补回的 brief，最后 1 次（9 票）为模型显式覆盖值
    assert.equal(seenVisionPrompts.length, 36);
    for (const p of seenVisionPrompts.slice(0, 27)) {
      assert.match(p, /需求原文：原文要在纯色背景中居中显示大标题/);
      assert.doesNotMatch(p, /需求原文：（没有给）/);
    }
    for (const p of seenVisionPrompts.slice(27, 36)) {
      assert.match(p, /需求原文：模型显式覆盖的审片要求/);
    }
  } finally {
    await api.close();
    await new Promise((r) => mockAgent.close(r));
    await new Promise((r) => mockVision.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-7 shots.tiers.final.scale < 1 时 frames 审片仍产出原尺寸 film.output.size 关键帧（绝不静默丢弃成空关键帧）', { skip: SKIP_MEDIA, timeout: 240000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-r2-scale-'));
  const ledgerPath = join(dataDir, 'review-ledger.jsonl');
  const seenVisionRequests = [];

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seenVisionRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-r2-scale',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 300, completion_tokens: 20 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'vkey',
    model: 'gemini-vision-r2-scale',
    ledgerPath,
    votesPerPerspective: 3,
  });
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer });

  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        brief: '合法终渲缩放 0.5 时审片仍须拿到 640x360 原尺寸关键帧',
        text: 'SCALE',
        output: { size: [640, 360], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(created.ok, true);
    const filmId = created.data.film;
    const wsToken = created.data.token;

    // 合法设置 shots/s01/tiers.final.scale = 0.5
    const putRes = await (await fetch(`${api.url}/v1/films/${filmId}/film`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'patch/0.1',
        rev: 1,
        ops: [{ op: 'set', path: 'shots/s01/tiers', value: { final: { scale: 0.5 } } }],
      }),
    })).json();
    assert.equal(putRes.ok, true);
    assert.equal(putRes.data.rev, 2);

    // 1) 默认草稿 POST /render {} -> POST /review {}
    const rDraft = await (await fetch(`${api.url}/v1/films/${filmId}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const rDraftDone = await waitJob(api.url, wsToken, rDraft.data.job);
    assert.equal(rDraftDone.data.status, 'succeeded');

    seenVisionRequests.length = 0;
    const revDraft = await (await fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    assert.equal(revDraft.ok, true);
    assert.equal(revDraft.data.status, 'ok');
    assert.equal(revDraft.data.material, 'frames');
    assert.equal(seenVisionRequests.length, 9);

    const filmDeliverDir = join(dataDir, 'films', filmId, 'deliver');
    const reviewJson = JSON.parse(readFileSync(join(filmDeliverDir, 'review', 'rev-2', 'review.json'), 'utf8'));
    const kfIdx = reviewJson.images.indexOf('keyframe-f2');
    assert.ok(kfIdx >= 1, `review.json.images 必须包含 keyframe-f2，实际：${JSON.stringify(reviewJson.images)}`);
    for (const reqBody of seenVisionRequests) {
      const imgParts = reqBody.messages[1].content.filter((p) => p.type === 'image_url');
      const kfSize = pngSize(Buffer.from(imgParts[kfIdx].image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64'));
      assert.deepEqual(kfSize, [640, 360], `L5 每票必须收到 640x360 原尺寸 keyframe-f2，实际：${JSON.stringify(kfSize)}`);
    }

    // 2) 显式终渲（按镜头 tiers.final.scale = 0.5 产出 320x180）后复审，仍须收到 640x360 原尺寸关键帧且不覆盖 frames-final.json
    const rFinal = await (await fetch(`${api.url}/v1/films/${filmId}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'final', wait: 30 }),
    })).json();
    const rFinalDone = await waitJob(api.url, wsToken, rFinal.data.job);
    assert.equal(rFinalDone.data.status, 'succeeded');
    const finalIdx = JSON.parse(readFileSync(join(filmDeliverDir, 'frames-final.json'), 'utf8'));
    const finalMid = finalIdx.frames.find((f) => f.frame === 2);
    assert.deepEqual(pngSize(readFileSync(join(dataDir, 'films', filmId, finalMid.png))), [320, 180]);

    seenVisionRequests.length = 0;
    const revAfterFinal = await (await fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json();
    assert.equal(revAfterFinal.ok, true);
    assert.equal(revAfterFinal.data.status, 'ok');
    assert.equal(seenVisionRequests.length, 9);
    const kfAfterImg = seenVisionRequests[0].messages[1].content.filter((p) => p.type === 'image_url')[kfIdx];
    assert.deepEqual(
      pngSize(Buffer.from(kfAfterImg.image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64')),
      [640, 360],
    );
    const finalIdxAfter = JSON.parse(readFileSync(join(filmDeliverDir, 'frames-final.json'), 'utf8'));
    assert.deepEqual(
      pngSize(readFileSync(join(dataDir, 'films', filmId, finalIdxAfter.frames.find((f) => f.frame === 2).png))),
      [320, 180],
    );
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-8 两镜硬切 frames 审片补渲期间并发 POST /observe/sheet { cuts: false } 零目录竞态', { skip: SKIP_MEDIA, timeout: 240000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-r2-sheet-race-'));
  const ledgerPath = join(dataDir, 'review-ledger.jsonl');
  const seenVisionRequests = [];

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seenVisionRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-r2-race',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 300, completion_tokens: 20 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'vkey',
    model: 'gemini-vision-r2-race',
    ledgerPath,
    votesPerPerspective: 1,
  });
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer });

  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        brief: '两镜硬切审片与并发 observe/sheet 零竞态验证',
        text: 'CUT1',
        output: { size: [640, 360], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(created.ok, true);
    const filmId = created.data.film;
    const wsToken = created.data.token;

    const current = (await (await fetch(`${api.url}/v1/films/${filmId}/film`, {
      headers: { authorization: `Bearer ${wsToken}` },
    })).json()).data.film;
    const baseShot = current.shots[0];
    const s01 = structuredClone({ ...baseShot, id: 's01', in: 0, out: 3 });
    const s02 = structuredClone({ ...baseShot, id: 's02', in: 3, out: 6, seed: (baseShot.seed ?? 1) + 1 });
    if (s01.deliberate?.[0]) { s01.deliberate[0].in = 0; s01.deliberate[0].out = 3; }
    if (s02.deliberate?.[0]) { s02.deliberate[0].in = 3; s02.deliberate[0].out = 6; }
    if (s02.cards?.[0]?.params) s02.cards[0].params.text = 'CUT2';
    const nextFilm = {
      ...current,
      shots: [s01, s02],
      transitions: [{ id: 'cut-f3', at: 3, type: 'cut' }],
    };
    const putRes = await (await fetch(`${api.url}/v1/films/${filmId}/film`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...nextFilm, rev: 1 }),
    })).json();
    assert.equal(putRes.ok, true);
    assert.equal(putRes.data.rev, 2);

    // 默认草稿渲染（覆盖 f0..f5 全部 6 帧，含切点 f3 的 6 个邻帧）
    const rDraft = await (await fetch(`${api.url}/v1/films/${filmId}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const rDraftDone = await waitJob(api.url, wsToken, rDraft.data.job);
    assert.equal(rDraftDone.data.status, 'succeeded');

    // 并发发起 POST /review {} 与多波 POST /observe/sheet { cuts: false, count: 1 }，确保覆盖审片补渲等待窗口
    const reviewPromise = fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sheetCall = () => fetch(`${api.url}/v1/films/${filmId}/observe/sheet`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cuts: false, count: 1 }),
    });
    const sheetImmediate = sheetCall();
    const sheetDelayed = new Promise((resolve) => setTimeout(() => resolve(sheetCall()), 60));
    const [revHttp, sheetHttp1, sheetHttp2] = await Promise.all([reviewPromise, sheetImmediate, sheetDelayed]);

    assert.equal(revHttp.status, 200);
    assert.equal(sheetHttp1.status, 200);
    assert.equal(sheetHttp2.status, 200);
    const revBody = await revHttp.json();
    assert.equal(revBody.ok, true);
    assert.equal(revBody.data.status, 'ok');
    assert.equal(revBody.data.material, 'frames');

    const filmDeliverDir = join(dataDir, 'films', filmId, 'deliver');
    assert.equal(existsSync(join(filmDeliverDir, 'sheets', 'rev2-draft', 'cuts')), false, 'observe/sheet { cuts: false } 应清空 sheets/cuts');

    const reviewJson = JSON.parse(readFileSync(join(filmDeliverDir, 'review', 'rev-2', 'review.json'), 'utf8'));
    assert.deepEqual(reviewJson.images, ['contact', 'cut', 'keyframe-f1', 'keyframe-f4']);
    assert.equal(seenVisionRequests.length, 9);
    const imgParts = seenVisionRequests[0].messages[1].content.filter((p) => p.type === 'image_url');
    assert.equal(imgParts.length, 4, 'L5 必须完整收到 contact + cut + 2 张关键帧');
    for (const idx of [2, 3]) {
      const sz = pngSize(Buffer.from(imgParts[idx].image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64'));
      assert.deepEqual(sz, [640, 360]);
    }
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-9 Three 片设 delivery.layers: ["color", "motion"] 时草稿审片不因补渲报 422 且交付原校验不受影响', { skip: SKIP_MEDIA, timeout: 240000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-r2-layers-'));
  const ledgerPath = join(dataDir, 'review-ledger.jsonl');
  const seenVisionRequests = [];

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seenVisionRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-r2-layers',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 300, completion_tokens: 20 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'vkey',
    model: 'gemini-vision-r2-layers',
    ledgerPath,
    votesPerPerspective: 1,
  });
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer });

  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        brief: 'Three 片配 delivery.layers 含 motion 时草稿审片必须成功拿到原尺寸关键帧',
        text: 'LAYERS',
        output: { size: [640, 360], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(created.ok, true);
    const filmId = created.data.film;
    const wsToken = created.data.token;

    const putRes = await (await fetch(`${api.url}/v1/films/${filmId}/film`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'patch/0.1',
        rev: 1,
        ops: [{ op: 'set', path: 'delivery/layers', value: ['color', 'motion'] }],
      }),
    })).json();
    assert.equal(putRes.ok, true);

    const rDraft = await (await fetch(`${api.url}/v1/films/${filmId}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const rDraftDone = await waitJob(api.url, wsToken, rDraft.data.job);
    assert.equal(rDraftDone.data.status, 'succeeded');

    const revHttp = await fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(revHttp.status, 200);
    const revBody = await revHttp.json();
    assert.equal(revBody.ok, true);
    assert.equal(revBody.data.status, 'ok');
    assert.equal(seenVisionRequests.length, 9);

    const imgParts = seenVisionRequests[0].messages[1].content.filter((p) => p.type === 'image_url');
    assert.ok(
      imgParts.some((p) => {
        const [w, h] = pngSize(Buffer.from(p.image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64'));
        return w === 640 && h === 360;
      }),
      '审片必须收到 640x360 原尺寸关键帧',
    );

    // 确认 POST /deliver 原语义未受影响（Three 不支持 motion 交付通道仍报 contract.unsupported-output）
    const dRes = await (await fetch(`${api.url}/v1/films/${filmId}/deliver`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const dDone = await waitJob(api.url, wsToken, dRes.data.job);
    assert.equal(dDone.data.status, 'failed');
    assert.equal(dDone.error?.code, 'contract.unsupported-output');
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-10 并发两次草稿审片共享补渲时 GET /ledger 精确记一次 frames=1 且 gpuSeconds > 0', { skip: SKIP_MEDIA, timeout: 240000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-r2-ledger-'));
  const ledgerPath = join(dataDir, 'review-ledger.jsonl');

  const mockVision = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-r2-ledger',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 300, completion_tokens: 20 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'vkey',
    model: 'gemini-vision-r2-ledger',
    ledgerPath,
    votesPerPerspective: 1,
  });
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer });

  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        brief: '并发草稿审片账本精确计账验证',
        text: 'LEDGER',
        output: { size: [640, 360], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(created.ok, true);
    const filmId = created.data.film;
    const wsToken = created.data.token;

    const rDraft = await (await fetch(`${api.url}/v1/films/${filmId}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const rDraftDone = await waitJob(api.url, wsToken, rDraft.data.job);
    assert.equal(rDraftDone.data.status, 'succeeded');

    const callReview = () => fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    const [rev1, rev2] = await Promise.all([callReview(), callReview()]);
    assert.equal(rev1.ok, true);
    assert.equal(rev2.ok, true);
    assert.equal(rev1.data.status, 'ok');
    assert.equal(rev2.data.status, 'ok');
    assert.equal(
      [rev1.cost?.gpuSeconds ?? 0, rev2.cost?.gpuSeconds ?? 0].filter((g) => g > 0).length,
      1,
      '两次并发审片响应信封 cost.gpuSeconds 亦应仅由发起方记一次正值',
    );

    const ledgerRes = await (await fetch(`${api.url}/v1/films/${filmId}/ledger`, {
      headers: { authorization: `Bearer ${wsToken}` },
    })).json();
    assert.equal(ledgerRes.ok, true);
    const reviewRows = ledgerRes.data.items.filter((row) => row.step === 'review');
    assert.equal(reviewRows.length, 2, `应有 2 条 review 账本记录，实际 ${reviewRows.length}`);
    const totalFrames = reviewRows.reduce((s, r) => s + (r.frames ?? 0), 0);
    const totalGpu = reviewRows.reduce((s, r) => s + (r.gpuSeconds ?? 0), 0);
    assert.equal(totalFrames, 1, `两次并发审片合计补渲帧数必须精确为 1，实际 ${totalFrames}`);
    assert.ok(totalGpu > 0, `两次并发审片合计 gpuSeconds 必须 > 0，实际 ${totalGpu}`);
    assert.deepEqual(reviewRows.map((r) => r.frames).sort((a, b) => a - b), [0, 1], '仅发起方记 1 帧，搭便车方记 0 帧');
    assert.equal(reviewRows.filter((r) => r.gpuSeconds > 0).length, 1, '仅发起方记正 gpuSeconds，搭便车方记 0');
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-11 runHandsOnAgent 遇到显式非法类型 brief 时原样透传返回 400 usage.bad-argument（绝不覆盖成 200）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-m1b-r2-bad-brief-'));
  const agentLedger = join(dataDir, 'agent-ledger.jsonl');
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0 });

  let round = 0;
  let filmId = null;
  const toolResponses = [];
  const mockAgent = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    round++;
    const last = body.messages.at(-1);
    if (last.role === 'tool') toolResponses.push(JSON.parse(last.content));

    let msg;
    if (round === 1) {
      // 显式非法对象类型 brief -> 必须透传并由服务端返回 400 usage.bad-argument
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'bad-obj',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: '/v1/films',
              body: { template: 'title', brief: { text: '另一份要求' }, text: 'BAD', output: { size: [320, 180], fps: '10/1', frames: 6 } },
            }),
          },
        }],
      };
    } else if (round === 2) {
      // 显式非法数值与 null 类型 brief -> 同样必须返回 400 usage.bad-argument
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'bad-num',
            type: 'function',
            function: {
              name: 'http_request',
              arguments: JSON.stringify({
                method: 'POST',
                path: '/v1/films',
                body: { template: 'title', brief: 42, text: 'NUM', output: { size: [320, 180], fps: '10/1', frames: 6 } },
              }),
            },
          },
          {
            id: 'bad-null',
            type: 'function',
            function: {
              name: 'http_request',
              arguments: JSON.stringify({
                method: 'POST',
                path: '/v1/films',
                body: { template: 'title', brief: null, text: 'NULL', output: { size: [320, 180], fps: '10/1', frames: 6 } },
              }),
            },
          },
        ],
      };
    } else if (round === 3) {
      // 正常省略 brief 建片 -> 自动补回代理需求原文
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'good-create',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: '/v1/films',
              body: { template: 'title', text: 'OK', output: { size: [320, 180], fps: '10/1', frames: 6 } },
            }),
          },
        }],
      };
    } else if (round === 4) {
      filmId = toolResponses.at(-1)?.body?.data?.film;
      // 审片显式传非法对象类型 brief -> 同样必须返回 400 usage.bad-argument
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'bad-review-obj',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: `/v1/films/${filmId}/review`,
              body: { brief: { text: '审片非法对象' } },
            }),
          },
        }],
      };
    } else {
      msg = { role: 'assistant', content: '测试结束。' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'hands-on-bad-brief', choices: [{ message: msg }], usage: { prompt_tokens: 60, completion_tokens: 15 } }));
  });
  await new Promise((r) => mockAgent.listen(0, '127.0.0.1', r));

  try {
    const res = await runHandsOnAgent({
      baseUrl: api.url,
      token,
      brief: '代理需求原文不应覆盖模型显式传入的非法类型 brief',
      ledgerPath: agentLedger,
      endpoint: `http://127.0.0.1:${mockAgent.address().port}/v1`,
      apiKey: 'akey',
      model: 'hands-on-bad-brief',
    });
    assert.equal(res.status, 'done');
    assert.equal(res.calls.length, 5);
    // 1) POST /v1/films brief: { text: '另一份要求' } -> 400 usage.bad-argument
    assert.deepEqual([res.calls[0].status, res.calls[0].ok, res.calls[0].code], [400, false, 'usage.bad-argument']);
    // 2) POST /v1/films brief: 42 -> 400 usage.bad-argument
    assert.deepEqual([res.calls[1].status, res.calls[1].ok, res.calls[1].code], [400, false, 'usage.bad-argument']);
    // 3) POST /v1/films brief: null -> 自动补回代理需求原文（200 且 meta.brief 已落盘）
    assert.deepEqual([res.calls[2].status, res.calls[2].ok], [200, true]);
    const nullFilmId = toolResponses[1]?.body?.data?.film;
    assert.ok(nullFilmId);
    const nullMeta = JSON.parse(readFileSync(join(dataDir, 'meta', `${nullFilmId}.json`), 'utf8'));
    assert.equal(nullMeta.brief, '代理需求原文不应覆盖模型显式传入的非法类型 brief');
    // 4) POST /v1/films 省略 brief -> 200 且 meta.brief 正确落盘
    assert.deepEqual([res.calls[3].status, res.calls[3].ok], [200, true]);
    assert.ok(filmId);
    const meta = JSON.parse(readFileSync(join(dataDir, 'meta', `${filmId}.json`), 'utf8'));
    assert.equal(meta.brief, '代理需求原文不应覆盖模型显式传入的非法类型 brief');
    // 5) POST /v1/films/<id>/review brief: { text: '审片非法对象' } -> 400 usage.bad-argument
    assert.deepEqual([res.calls[4].status, res.calls[4].ok, res.calls[4].code], [400, false, 'usage.bad-argument']);
  } finally {
    await api.close();
    await new Promise((r) => mockAgent.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('M1b-12 部分补渲失败仅记单条失败账目且错误信封如实回报 gpuSeconds（R3 回归）', { skip: threeMediaSkip(), timeout: 180000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'beiming-m1b12-'));
  const ledgerPath = join(dataDir, 'vision-ledger.jsonl');
  const mockVision = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-r3-partial',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));
  const reviewer = createOpenAiVisionReviewer({
    endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
    apiKey: 'vkey',
    model: 'gemini-vision-r3-partial',
    ledgerPath,
    votesPerPerspective: 1,
  });
  const account = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0, reviewer });
  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${account}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'title',
        text: 'PARTIAL',
        brief: '两镜部分补渲失败单账回归',
        output: { size: [640, 360], fps: '10/1', frames: 6 },
      }),
    })).json();
    assert.equal(created.ok, true);
    const { film: filmId, token } = created.data;
    const cur = (await (await fetch(`${api.url}/v1/films/${filmId}/film`, {
      headers: { authorization: `Bearer ${token}` },
    })).json()).data;
    const baseShot = cur.film.shots[0];
    const s01 = structuredClone({ ...baseShot, id: 's01', in: 0, out: 3 });
    const s02 = structuredClone({
      ...baseShot,
      id: 's02',
      in: 3,
      out: 6,
      seed: (baseShot.seed ?? 1) + 1,
      tiers: { final: { samples: 2 } },
    });
    if (s01.deliberate?.[0]) { s01.deliberate[0].in = 0; s01.deliberate[0].out = 3; }
    if (s02.deliberate?.[0]) { s02.deliberate[0].in = 3; s02.deliberate[0].out = 6; }
    const putRes = await fetch(`${api.url}/v1/films/${filmId}/film`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...cur.film,
        shots: [s01, s02],
        transitions: [{ id: 'c1', at: 3, type: 'cut' }],
        rev: cur.rev,
      }),
    });
    assert.equal(putRes.status, 200);
    const rDraft = await (await fetch(`${api.url}/v1/films/${filmId}/render`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wait: 30 }),
    })).json();
    const rDraftDone = await waitJob(api.url, token, rDraft.data.job);
    assert.equal(rDraftDone.data.status, 'succeeded');

    const revHttp = await fetch(`${api.url}/v1/films/${filmId}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const revBody = await revHttp.json();
    assert.equal(revHttp.status, 422);
    assert.equal(revBody.ok, false);
    assert.equal(revBody.error.code, 'contract.unsupported-option');
    assert.ok(revBody.cost.gpuSeconds > 0, `HTTP 错误信封必须回报正值 gpuSeconds，实际 ${JSON.stringify(revBody.cost)}`);

    const ledgerRes = await (await fetch(`${api.url}/v1/films/${filmId}/ledger`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    assert.equal(ledgerRes.ok, true);
    const reviewRows = ledgerRes.data.items.filter((row) => row.step === 'review');
    assert.equal(reviewRows.length, 1, `单次失败审片只能产生 1 条 review 账目，实际 ${reviewRows.length} 条`);
    assert.equal(reviewRows[0].ok, false);
    assert.equal(reviewRows[0].frames, 1);
    assert.ok(reviewRows[0].gpuSeconds > 0);
  } finally {
    await api.close();
    await new Promise((r) => mockVision.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});


