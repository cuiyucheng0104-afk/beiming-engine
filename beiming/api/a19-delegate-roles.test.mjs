import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCardLibrary } from './runtime.mjs';
import {
  DELEGATE_ROLES,
  HTTP_TOOL,
  L5_GRADES,
  L5_PERSPECTIVES,
  SHOT_WORKER_MAX_START_TOKENS,
  aggregateL5Votes,
  buildShotWorkerBrief,
  buildShotWorkerMessages,
  createOpenAiVisionReviewer,
  filterL5SuggestedPredicates,
  issueAccountToken,
  measureStartContextTokens,
  selectDelegateTemplate,
  startServer,
} from './index.mjs';
import { scaffold } from './films.mjs';
import { layerL5 } from './pipeline.mjs';

test('A19-1 三角色配置与固定五段镜头工任务书：包含完整五段标题，真实卡库与超大输入下起始上下文均严格 <= 15,000 token', () => {
  assert.equal(SHOT_WORKER_MAX_START_TOKENS, 15_000);
  assert.ok(Object.isFrozen(DELEGATE_ROLES));
  assert.ok(DELEGATE_ROLES.director);
  assert.ok(DELEGATE_ROLES['shot-worker']);
  assert.ok(DELEGATE_ROLES.reviewer);

  // 导演提示词：读 guide、查卡、先写 extra 断言再排镜头、用 patch/0.1 带 rev
  assert.match(DELEGATE_ROLES.director.systemPrompt, /\/v1\/guide/);
  assert.match(DELEGATE_ROLES.director.systemPrompt, /cards\/search/);
  assert.match(DELEGATE_ROLES.director.systemPrompt, /predicates\.extra/);
  assert.match(DELEGATE_ROLES.director.systemPrompt, /patch\/0\.1/);

  // 镜头工配置：每镜头全新会话，15,000 token 上限，五段任务书
  assert.equal(DELEGATE_ROLES['shot-worker'].freshSessionPerShot, true);
  assert.equal(DELEGATE_ROLES['shot-worker'].maxStartTokens, 15_000);

  const library = loadCardLibrary();
  const realCards = Object.values(library).map((x) => x.card);
  const { film } = scaffold({ id: 'f_001', template: 'turntable' });

  for (const shot of film.shots) {
    const briefText = buildShotWorkerBrief({
      filmId: film.id,
      rev: 2,
      brief: '做一条 4 秒显卡硬表面转台展示，前两秒绕显卡缓慢推进，后两秒定格显示 RTX 片名',
      shot,
      basePredicates: film.predicates.base,
      extraPredicates: ['visible(hero) >= 0.9', 'cut_clean() == true'],
      cards: realCards,
      budget: { tokens: 120_000, gpuSeconds: 60, wallSeconds: 120, maxSteps: 12 },
    });

    const sections = [
      '## 1. 镜头条目',
      '## 2. 基础谓词',
      '## 3. 可用的卡',
      '## 4. 预算',
      '## 5. 汇报格式',
    ];
    let lastIdx = -1;
    for (const heading of sections) {
      const idx = briefText.indexOf(heading);
      assert.ok(idx > lastIdx, `任务书必须按顺序包含段落 ${heading}`);
      lastIdx = idx;
    }
    assert.match(briefText, new RegExp(`shots/${shot.id}/`));
    assert.match(briefText, /floor@1/);
    assert.match(briefText, /visible\(hero\) >= 0\.9/);

    const built = buildShotWorkerMessages({
      filmId: film.id,
      rev: 2,
      brief: '做一条 4 秒显卡硬表面转台展示',
      shot,
      basePredicates: film.predicates.base,
      extraPredicates: ['visible(hero) >= 0.9'],
      cards: realCards,
      budget: { tokens: 120_000, gpuSeconds: 60, wallSeconds: 120, maxSteps: 12 },
    });
    assert.ok(built.system.includes(`[ROLE:shot-worker:${shot.id}]`));
    const measured = measureStartContextTokens({
      system: built.system,
      user: built.user,
      tools: [HTTP_TOOL],
    });
    assert.equal(measured, built.startTokens);
    assert.ok(measured > 0 && measured <= SHOT_WORKER_MAX_START_TOKENS, `起始上下文 ${measured} token 必须 <= 15000`);
  }

  // 超大对抗输入（120 张大卡、40,000 字长需求、80 条追加断言）：自动确定性裁剪且保留五段结构，严格 <= 15,000 token
  const hugeCards = Array.from({ length: 120 }, (_, i) => ({
    id: `custom.card-${i}`,
    version: '1.0.0',
    title: `超长候选技术卡 ${i} `.repeat(20),
    intent: `用于测试镜头工起始上下文裁剪逻辑的候选技术卡描述 ${i} `.repeat(30),
    livesIn: ['source:three'],
    params: Object.fromEntries(Array.from({ length: 15 }, (__, j) => [`param_${j}`, { type: 'number', default: j, unit: 'px', description: '参数说明'.repeat(15) }])),
  }));
  const hugeBuilt = buildShotWorkerMessages({
    filmId: 'f_999',
    rev: 15,
    brief: '超长需求原文段落：要求硬表面高光与镜头推进节奏精确匹配。'.repeat(1500),
    shot: film.shots[0],
    basePredicates: ['floor@1'],
    extraPredicates: Array.from({ length: 80 }, (_, i) => `visible(hero) >= ${0.85 + (i % 10) * 0.01}`),
    cards: hugeCards,
    budget: { tokens: 200_000, gpuSeconds: 180, wallSeconds: 300, maxSteps: 12 },
  });
  for (const heading of ['## 1. 镜头条目', '## 2. 基础谓词', '## 3. 可用的卡', '## 4. 预算', '## 5. 汇报格式']) {
    assert.ok(hugeBuilt.user.includes(heading), `裁剪后仍须保留段落 ${heading}`);
  }
  const hugeTokens = measureStartContextTokens({ system: hugeBuilt.system, user: hugeBuilt.user, tools: [HTTP_TOOL] });
  assert.ok(hugeTokens <= SHOT_WORKER_MAX_START_TOKENS, `超大输入起始上下文 ${hugeTokens} 必须 <= 15000`);
});

test('A19-2 服务端确定性模板判定：同一需求连续 5 次结果完全一致，委托模式忽略客户端伪造的 template', async () => {
  const cases = [
    {
      input: { brief: '做一条 4 秒显卡硬表面产品转台展示短片，相机绕显卡缓推后切落版', assets: ['asset:rtx-card@1'] },
      expectTemplate: 'turntable',
      expectAsset: 'asset:rtx-card@1',
    },
    {
      input: { brief: '做一条机械头雕校准几何装配环绕展示短片', assets: [] },
      expectTemplate: 'turntable',
      expectAsset: 'asset:mech-head-proxy@1',
    },
    {
      input: { brief: '做一条 2 秒纯片名落版短片，居中显示 BEIMING', assets: [] },
      expectTemplate: 'title',
      expectAsset: null,
    },
  ];

  for (const c of cases) {
    const first = selectDelegateTemplate(c.input);
    assert.equal(first.template, c.expectTemplate);
    assert.equal(first.asset, c.expectAsset);
    assert.equal(first.selectedBy, 'server');
    for (let i = 0; i < 5; i++) {
      const again = selectDelegateTemplate(c.input);
      assert.deepEqual(again, first, `第 ${i + 1} 次调用必须返回完全相同的模板判定`);
    }
  }

  // HTTP 层连续 5 次建委托片 + 客户端伪造相反/无效 template 均被服务器判定覆盖
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-tpl-'));
  const mockModel = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cmpl-1',
      model: 'claude-opus-5-5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }));
  });
  await new Promise((r) => mockModel.listen(0, '127.0.0.1', r));
  const token = issueAccountToken(dir);
  const api = await startServer({
    dataDir: dir,
    port: 0,
    reviewer: null,
    delegate: {
      endpoint: `http://127.0.0.1:${mockModel.address().port}/v1`,
      apiKey: 'test-key',
      directorModel: 'claude-opus-5-5',
      workerModel: 'claude-sonnet-5-5',
    },
  });

  try {
    const spoofedTemplates = ['title', 'title', 'bogus-template', 'title', undefined];
    const seenTemplates = [];
    for (let i = 0; i < 5; i++) {
      const createRes = await (await fetch(`${api.url}/v1/films`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'delegate',
          brief: '做一条 4 秒显卡硬表面转台展示，相机绕主体旋转推进',
          assets: ['asset:rtx-card@1'],
          ...(spoofedTemplates[i] ? { template: spoofedTemplates[i] } : {}),
          output: { size: [320, 180], fps: '10/1', frames: 10 },
        }),
      })).json();
      assert.equal(createRes.ok, true);
      const filmEnv = await (await fetch(`${api.url}/v1/films/${createRes.data.film}/film`, {
        headers: { authorization: `Bearer ${createRes.data.token}` },
      })).json();
      assert.equal(filmEnv.ok, true);
      // turntable 脚手架有 s01 (blender) + s02 (three) 两个镜头
      assert.equal(filmEnv.data.film.shots.length, 2);
      assert.equal(filmEnv.data.film.shots[0].source, 'blender');
      assert.equal(filmEnv.data.film.shots[1].source, 'three');
      const meta = JSON.parse(readFileSync(join(dir, 'meta', `${createRes.data.film}.json`), 'utf8'));
      assert.equal(meta.template, 'turntable');
      assert.equal(meta.templateSelectedBy, 'server');
      seenTemplates.push(meta.template);
    }
    assert.deepEqual(seenTemplates, ['turntable', 'turntable', 'turntable', 'turntable', 'turntable']);
  } finally {
    await api.close();
    await new Promise((r) => mockModel.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-3 L5 三视角九票规程：两票成立、一票丢弃、候选带种子打乱与等级词统计、建议谓词过 L1 才进 extra、绝不推翻硬门', async () => {
  assert.deepEqual(L5_PERSPECTIVES.map((p) => p.id), [
    'composition-readability',
    'motion-rhythm',
    'look-consistency',
  ]);
  assert.deepEqual(L5_GRADES, ['好', '一般', '差']);

  const { film } = scaffold({ id: 'f_001', template: 'turntable', output: { size: [320, 180], fps: '10/1', frames: 20 } });
  const candidates = [
    { id: 'cand-alpha', label: '方案 Alpha' },
    { id: 'cand-beta', label: '方案 Beta' },
    { id: 'cand-gamma', label: '方案 Gamma' },
  ];

  // 构造 9 张选票（3 视角 × 3 票）：
  // - 问题 1（hero-framing）：在 3 张选票出现（>= 2 票 -> 成立）
  // - 问题 2（cut-seam）：在 2 张选票出现（>= 2 票 -> 成立）
  // - 问题 3（isolated-nitpick）：仅在 1 张选票出现（1 票 -> 不成立，必须丢弃）
  // - 建议谓词：
  //   * 'visible(hero) >= 0.92'（合法，过 L1 -> 保留）
  //   * 'inside_frame(hero, margin=0.08)'（合法，过 L1 -> 保留）
  //   * 'unregistered_magic(hero) >= 0.9'（未登记谓词 -> 被 L1 拦截在 rejectedPredicates）
  //   * 'visible(hero) >= 0.3'（比 floor@1 的 0.5 更松 -> 被 L1 防削弱拦截在 rejectedPredicates）
  //   * 'visible(hero, in=[0f, 999f]) >= 0.9'（非法参数与越界帧区间 -> 被 L1 拦截在 rejectedPredicates）
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-l5-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  const seenPrompts = [];
  let callCount = 0;

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seenPrompts.push(JSON.stringify(body.messages));
    const idx = callCount++;

    const opinions = [];
    if (idx === 0 || idx === 3 || idx === 7) {
      opinions.push({
        issueKey: 'hero-framing',
        frames: [2, 8],
        severity: 'warn',
        evidence: `联系表第 ${idx + 1} 格（帧 2–8）主体偏左，屏占比偏低`,
        comment: '前段转台镜头主体构图偏左，建议收紧机位距离',
        suggestedPredicate: 'visible(hero) >= 0.92',
      });
    }
    if (idx === 4 || idx === 5) {
      opinions.push({
        issueKey: 'cut-seam',
        frames: [9, 11],
        severity: 'error',
        evidence: '切点条带 cut-a 红线前后两帧亮度跳变明显',
        comment: '切点处需要保证主体留边与切口干净',
        suggestedPredicate: 'inside_frame(hero, margin=0.08)',
      });
    }
    if (idx === 2) {
      opinions.push({
        issueKey: 'isolated-nitpick',
        frames: [15, 18],
        severity: 'info',
        evidence: '联系表末格边角对比度略低',
        comment: '单票孤立意见不应成立',
      });
    }

    const suggestedPredicates = [
      'visible(hero) >= 0.92',
      'unregistered_magic(hero) >= 0.9',
      'visible(hero) >= 0.3',
      'visible(hero, in=[0f, 999f]) >= 0.9',
    ];

    const grade = idx % 3 === 0 ? '好' : idx % 3 === 1 ? '一般' : '好';
    const candidateGrades = [
      { id: 'cand-alpha', grade: '好' },
      { id: 'cand-beta', grade: '一般' },
      { id: 'cand-gamma', grade: '差' },
    ];

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-test',
      choices: [{
        message: {
          content: JSON.stringify({ grade, candidateGrades, opinions, suggestedPredicates }),
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  try {
    const reviewer = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'vision-key',
      model: 'gemini-vision-test',
      ledgerPath,
    });
    const l5 = await layerL5({
      reviewer,
      brief: '4 秒显卡硬表面转台展示',
      images: [],
      loudness: { integratedLufs: -14.2, truePeakDbtp: -1.3 },
      film,
      candidates,
    });

    assert.equal(l5.status, 'ok');
    assert.equal(callCount, 9, 'L5 完整规程必须执行 3 视角 × 3 票 = 9 次独立投票');
    assert.equal(l5.overridesHardGates, false, 'L5 结论永远不得推翻 L1–L4 硬门');
    assert.equal(l5.totalBallots, 9);
    assert.equal(l5.quorum, 2);

    // 验证两票成立与一票丢弃
    assert.equal(l5.opinions.length, 2, '只有 >= 2 票的两个问题成立，1 票孤立问题必须被过滤');
    assert.equal(l5.discardedOpinionCount, 1);
    const byKey = Object.fromEntries(l5.opinions.map((o) => [o.issueKey, o]));
    assert.equal(byKey['hero-framing'].votes, 3);
    assert.deepEqual(byKey['hero-framing'].frames, [2, 8]);
    assert.ok(byKey['hero-framing'].evidence.length > 0);
    assert.equal(byKey['cut-seam'].votes, 2);
    assert.deepEqual(byKey['cut-seam'].frames, [9, 11]);
    assert.equal(byKey['isolated-nitpick'], undefined);

    // 验证候选展示顺序带确定性种子打乱且等级词统计准确
    assert.ok(Array.isArray(l5.candidateOrderings));
    assert.equal(l5.candidateOrderings.length, 9);
    const uniqueOrders = new Set(l5.candidateOrderings.map((o) => o.join(',')));
    assert.ok(uniqueOrders.size >= 2, '9 张选票对候选的展示顺序必须经过确定性打乱而非固定不变');
    assert.equal(l5.candidateGrades['cand-alpha'].grade, '好');
    assert.equal(l5.candidateGrades['cand-beta'].grade, '一般');
    assert.equal(l5.candidateGrades['cand-gamma'].grade, '差');
    assert.ok(L5_GRADES.includes(l5.grade));

    // 验证建议谓词过 L1 才进 extra
    assert.deepEqual(l5.suggestedPredicates, ['visible(hero) >= 0.92', 'inside_frame(hero, margin=0.08)']);
    assert.deepEqual(l5.validatedExtraPredicates, ['visible(hero) >= 0.92', 'inside_frame(hero, margin=0.08)']);
    const rejectedTexts = l5.rejectedPredicates.map((r) => r.predicate);
    assert.ok(rejectedTexts.includes('unregistered_magic(hero) >= 0.9'));
    assert.ok(rejectedTexts.includes('visible(hero) >= 0.3'));
    assert.ok(rejectedTexts.includes('visible(hero, in=[0f, 999f]) >= 0.9'));

    // 外部账本记录了 9 条审片调用
    const ledgerLines = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(ledgerLines.length, 9);
  } finally {
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-4 端到端委托编排接入三角色提示词与五段任务书：导演查卡立断言、镜头工独立会话接收五段任务书', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-e2e-'));
  const recordedSessions = [];

  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sys = body.messages[0]?.content ?? '';
    const usr = body.messages[1]?.content ?? '';
    const roleMatch = /\[ROLE:([^\]]+)\]/.exec(sys);
    const roleTag = roleMatch?.[1] ?? 'unknown';
    const toolMsgs = body.messages.filter((m) => m.role === 'tool');

    if (body.messages.length === 2) {
      recordedSessions.push({
        roleTag,
        sys,
        usr,
        startTokens: measureStartContextTokens({ system: sys, user: usr, tools: body.tools ?? [HTTP_TOOL] }),
      });
    }

    const filmId = /f_\d{3}/.exec(JSON.stringify(body.messages))?.[0] ?? 'f_001';
    const root = `/v1/films/${filmId}`;
    let replyMsg;

    if (roleTag === 'director') {
      if (toolMsgs.length === 0) {
        replyMsg = {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc-d1', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/cards/search', body: { q: 'title' } }) } }],
        };
      } else if (toolMsgs.length === 1) {
        replyMsg = {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-d2',
            type: 'function',
            function: {
              name: 'http_request',
              arguments: JSON.stringify({
                method: 'PUT',
                path: `${root}/film`,
                body: {
                  format: 'patch/0.1',
                  rev: 1,
                  ops: [{ op: 'set', path: 'predicates/extra', value: ['visible(hero) >= 0.9'] }],
                },
              }),
            },
          }],
        };
      } else {
        replyMsg = { role: 'assistant', content: '导演已完成技术卡检索与 extra 断言写入。' };
      }
    } else if (roleTag.startsWith('shot-worker:')) {
      // 模拟镜头工在第一轮直接汇报（或测试假渲染流程由外部拦截）
      replyMsg = { role: 'assistant', content: '状态：pass\n修订号：rev=2' };
    } else {
      replyMsg = { role: 'assistant', content: '完成' };
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cmpl-e2e',
      model: body.model,
      choices: [{ index: 0, message: replyMsg }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));

  const token = issueAccountToken(dir);
  const api = await startServer({
    dataDir: dir,
    port: 0,
    reviewer: null,
    delegate: {
      endpoint: `http://127.0.0.1:${mock.address().port}/v1`,
      apiKey: 'key',
      directorModel: 'claude-opus-5-5',
      workerModel: 'claude-sonnet-5-5',
    },
  });

  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'delegate',
        brief: '做一条 2 秒纯片名落版短片，居中显示 BEIMING',
        output: { size: [320, 180], fps: '10/1', frames: 10 },
      }),
    })).json();
    assert.equal(created.ok, true);
    await fetch(`${api.url}/v1/jobs/${created.data.job}?wait=10`, {
      headers: { authorization: `Bearer ${created.data.token}` },
    });

    const directorSession = recordedSessions.find((s) => s.roleTag === 'director');
    assert.ok(directorSession, '必须启动 director 会话');
    assert.match(directorSession.sys, /predicates\.extra/);

    const workerSession = recordedSessions.find((s) => s.roleTag === 'shot-worker:s01');
    assert.ok(workerSession, '必须启动 shot-worker:s01 会话');
    for (const heading of ['## 1. 镜头条目', '## 2. 基础谓词', '## 3. 可用的卡', '## 4. 预算', '## 5. 汇报格式']) {
      assert.ok(workerSession.usr.includes(heading), `镜头工会话首条消息必须含 ${heading}`);
    }
    assert.match(workerSession.usr, /visible\(hero\) >= 0\.9/, '镜头工任务书必须包含导演刚写入的 extra 谓词');
    assert.match(workerSession.usr, /overlay\.title/, '镜头工任务书必须包含绑定或检索到的技术卡');
    assert.ok(workerSession.startTokens <= SHOT_WORKER_MAX_START_TOKENS);
  } finally {
    await api.close();
    await new Promise((r) => mock.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-5 入参防御：Proxy、访问器 getter 陷阱、越界帧区间、空证据与坏谓词一律零陷阱拒绝', () => {
  // 1) Proxy 拒绝
  const proxied = new Proxy({ brief: '显卡转台' }, {});
  assert.throws(() => selectDelegateTemplate(proxied), (err) => err.code === 'usage.bad-argument');
  assert.throws(() => buildShotWorkerBrief(new Proxy({}, {})), (err) => err.code === 'usage.bad-argument');
  assert.throws(() => aggregateL5Votes(new Proxy([], {}), { totalFrames: 10 }), (err) => err.code === 'usage.bad-argument');
  assert.throws(() => filterL5SuggestedPredicates(new Proxy([], {})), (err) => err.code === 'usage.bad-argument');

  // 2) 访问器 getter 零触发拒绝
  let getterTriggered = false;
  const trapped = {};
  Object.defineProperty(trapped, 'brief', {
    enumerable: true,
    get() {
      getterTriggered = true;
      throw new Error('不应触发 getter');
    },
  });
  assert.throws(() => selectDelegateTemplate(trapped), (err) => err.code === 'usage.bad-argument');
  assert.equal(getterTriggered, false, '属性描述符检查必须在触发 getter 前拦截');

  // 3) 非字符串 brief 拒绝
  assert.throws(() => selectDelegateTemplate({ brief: 123 }), (err) => err.code === 'usage.bad-argument');
  assert.throws(() => selectDelegateTemplate({ brief: '   ' }), (err) => err.code === 'usage.bad-argument');

  // 4) 越界帧区间与空证据拒绝
  for (const badOpinion of [
    { frames: [-1, 3], severity: 'warn', evidence: '有证据', comment: '负帧号' },
    { frames: [2, 10], severity: 'warn', evidence: '有证据', comment: '止帧等于 totalFrames 越界' },
    { frames: [5, 3], severity: 'warn', evidence: '有证据', comment: '起帧大于止帧' },
    { frames: [0, 3], severity: 'warn', evidence: '   ', comment: '空证据' },
    { frames: [0, 3], severity: 'warn', evidence: '有证据', comment: '' },
    { frames: [0, 3], severity: 'fatal', evidence: '有证据', comment: '非法严重度' },
  ]) {
    assert.throws(
      () => aggregateL5Votes([{ perspective: 'composition-readability', voteIndex: 0, opinions: [badOpinion] }], { totalFrames: 10 }),
      /帧|证据|意见|严重度|不合法/,
    );
  }
});
