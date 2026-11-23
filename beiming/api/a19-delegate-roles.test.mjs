import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tools, verifyDeliveryBundle } from '../comp/index.mjs';
import { loadCardLibrary } from './runtime.mjs';
import {
  DELEGATE_ROLES,
  HTTP_TOOL,
  L5_GRADES,
  L5_ISSUE_KEYS,
  L5_PERSPECTIVES,
  SHOT_WORKER_MAX_START_TOKENS,
  aggregateL5Votes,
  buildShotWorkerBrief,
  buildShotWorkerMessages,
  createOpenAiVisionReviewer,
  filterL5SuggestedPredicates,
  issueAccountToken,
  measureStartContextTokens,
  normalizeIssueKey,
  runDelegateOrchestrator,
  selectDelegateTemplate,
  shuffleCandidatesForBallot,
  startServer,
} from './index.mjs';
import { scaffold } from './films.mjs';
import { layerL5 } from './pipeline.mjs';

function threeMediaSkip() {
  const { ffmpeg, ffprobe } = tools();
  for (const [name, bin, args] of [['ffmpeg', ffmpeg, ['-version']], ['ffprobe', ffprobe, ['-version']]]) {
    if (!bin || spawnSync(bin, args, { stdio: 'ignore', timeout: 20000 }).status !== 0) return `缺少可执行的 ${name}`;
  }
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  if (spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 30000 }).status !== 0) return '无头浏览器不可执行';
  return false;
}

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

  // 非阻断改进 #3：镜头条目先紧凑 JSON 序列化再按预算安全截断（不切出残缺 JSON）
  const normalJsonMatch = /```json\n([^\n]+)\n```/.exec(hugeBuilt.user);
  assert.ok(normalJsonMatch, '镜头条目 JSON 必须为紧凑单行 JSON');
  const parsedNormalShot = JSON.parse(normalJsonMatch[1]);
  assert.equal(parsedNormalShot.id, film.shots[0].id);

  const giantParamShot = {
    ...film.shots[0],
    cards: [
      { as: 'cam', use: 'three.camera@1', params: { payload: 'P'.repeat(25_000) } },
    ],
  };
  const giantBrief = buildShotWorkerBrief({
    filmId: 'f_998',
    rev: 4,
    brief: '超大参数镜头测试',
    shot: giantParamShot,
    basePredicates: ['floor@1'],
    extraPredicates: [],
    cards: [],
    budget: { tokens: 100_000 },
  });
  const giantJsonMatch = /```json\n([^\n]+)\n```/.exec(giantBrief);
  assert.ok(giantJsonMatch, '超大参数镜头仍须输出合法紧凑单行 JSON');
  const parsedGiantShot = JSON.parse(giantJsonMatch[1]);
  assert.equal(parsedGiantShot.id, giantParamShot.id);
  assert.equal(parsedGiantShot._truncated, true);
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

test('A19-3 L5 三视角九票规程：封闭 issueKey、两票成立、一票丢弃、候选带种子打乱与等级词统计、建议谓词过 L1 记入 validatedExtraPredicates、绝不推翻硬门', async () => {
  assert.deepEqual(L5_PERSPECTIVES.map((p) => p.id), [
    'composition-readability',
    'motion-rhythm',
    'look-consistency',
  ]);
  assert.deepEqual(L5_GRADES, ['好', '一般', '差']);
  assert.ok(Object.isFrozen(L5_ISSUE_KEYS));

  const { film } = scaffold({ id: 'f_001', template: 'turntable', output: { size: [320, 180], fps: '10/1', frames: 20 } });
  const candidates = [
    { id: 'cand-alpha', label: '方案 Alpha' },
    { id: 'cand-beta', label: '方案 Beta' },
    { id: 'cand-gamma', label: '方案 Gamma' },
  ];

  // 构造 9 张选票（3 视角 × 3 票）：
  // - composition-readability（idx 0, 1, 2）：
  //   * hero-framing 3 票（>= 2 票 -> 成立）
  //   * title-readability 仅 1 票（1 票 -> 丢弃进 discardedOpinionCount）
  // - motion-rhythm（idx 3, 4, 5）：
  //   * idx 4 返回表外 issueKey 'isolated-nitpick'（不在封闭表内 -> 作废进 rejectedOpinions）
  // - look-consistency（idx 6, 7, 8）：
  //   * cut-seam 2 票（>= 2 票 -> 成立）
  // - 建议谓词：
  //   * 'visible(hero) >= 0.92'（合法且 >= 2 票，过 L1 -> 保留）
  //   * 'inside_frame(hero, margin=0.08)'（合法且 >= 2 票，过 L1 -> 保留）
  //   * 'unregistered_magic(hero) >= 0.9'（未登记谓词 -> 被 L1 拦截在 rejectedPredicates）
  //   * 'visible(hero) >= 0.3'（比 floor@1 的 0.5 更松 -> 被 L1 防削弱拦截在 rejectedPredicates）
  //   * 'visible(hero, in=[0f, 999f]) >= 0.9'（非法参数与越界帧区间 -> 被 L1 拦截在 rejectedPredicates）
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-l5-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  const seenSystems = [];
  let callCount = 0;

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seenSystems.push(body.messages[0]?.content ?? '');
    const idx = callCount++;

    const opinions = [];
    if (idx === 0 || idx === 1 || idx === 2) {
      opinions.push({
        issueKey: idx === 1 ? 'Hero_Framing' : 'hero-framing',
        frames: [2, 8],
        severity: 'warn',
        evidence: `联系表第 ${idx + 1} 格（帧 2–8）主体偏左，屏占比偏低`,
        comment: '前段转台镜头主体构图偏左，建议收紧机位距离',
        suggestedPredicate: 'visible(hero) >= 0.92',
      });
    }
    if (idx === 2) {
      opinions.push({
        issueKey: 'title-readability',
        frames: [15, 18],
        severity: 'info',
        evidence: '联系表末格片名对比度略低',
        comment: '单票孤立意见不应成立',
      });
    }
    if (idx === 4) {
      opinions.push({
        issueKey: 'isolated-nitpick',
        frames: [5, 7],
        severity: 'info',
        evidence: '表外自由词意见',
        comment: '不在本视角封闭类别表内，必须拦截在 rejectedOpinions',
      });
    }
    if (idx === 6 || idx === 7) {
      opinions.push({
        issueKey: 'cut-seam',
        frames: [9, 11],
        severity: 'error',
        evidence: '切点条带 cut-a 红线前后两帧亮度跳变明显',
        comment: '切点处需要保证主体留边与切口干净',
        suggestedPredicate: 'inside_frame(hero, margin=0.08)',
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
      filmId: 'f_001',
      candidates,
    });

    assert.equal(l5.status, 'ok');
    assert.equal(callCount, 9, 'L5 完整规程必须执行 3 视角 × 3 票 = 9 次独立投票');
    assert.equal(l5.overridesHardGates, false, 'L5 结论永远不得推翻 L1–L4 硬门');
    assert.equal(l5.totalBallots, 9);
    assert.equal(l5.plannedBallots, 9);
    assert.equal(l5.quorum, 2);
    assert.equal(l5.ballots.length, 9, '必须保留 9 张选票的逐票摘要');

    // 系统提示词只用统一的 DELEGATE_ROLES.reviewer.systemPrompt，不再拼接旧版冲突 schema
    for (const sys of seenSystems) {
      assert.ok(sys.includes(DELEGATE_ROLES.reviewer.systemPrompt));
      assert.equal(sys.includes('你是视觉审片人。给你需求原文'), false, '不得再拼接旧版 REVIEW_SYSTEM');
    }

    // 验证两票成立、一票丢弃与表外键作废
    assert.equal(l5.opinions.length, 2, '只有 >= 2 票的两个问题成立，1 票孤立问题必须被过滤');
    assert.equal(l5.discardedOpinionCount, 1);
    assert.equal(l5.rejectedOpinions.length, 1);
    assert.equal(l5.rejectedOpinions[0].issueKey, 'isolated-nitpick');
    const byKey = Object.fromEntries(l5.opinions.map((o) => [o.issueKey, o]));
    assert.equal(byKey['hero-framing'].votes, 3);
    assert.equal(byKey['hero-framing'].perspective, 'composition-readability');
    assert.deepEqual(byKey['hero-framing'].frames, [2, 8]);
    assert.ok(byKey['hero-framing'].evidence.length > 0);
    assert.equal(byKey['cut-seam'].votes, 2);
    assert.equal(byKey['cut-seam'].perspective, 'look-consistency');
    assert.deepEqual(byKey['cut-seam'].frames, [9, 11]);
    assert.equal(byKey['title-readability'], undefined);

    // 验证候选展示顺序带确定性种子打乱且等级词统计准确
    assert.ok(Array.isArray(l5.candidateOrderings));
    assert.equal(l5.candidateOrderings.length, 9);
    const uniqueOrders = new Set(l5.candidateOrderings.map((o) => o.join(',')));
    assert.ok(uniqueOrders.size >= 2, '9 张选票对候选的展示顺序必须经过确定性打乱而非固定不变');
    assert.equal(l5.candidateGrades['cand-alpha'].grade, '好');
    assert.equal(l5.candidateGrades['cand-beta'].grade, '一般');
    assert.equal(l5.candidateGrades['cand-gamma'].grade, '差');
    assert.ok(L5_GRADES.includes(l5.grade));

    // 验证建议谓词过 L1 才进入 suggestedPredicates / validatedExtraPredicates
    assert.deepEqual(l5.suggestedPredicates, ['visible(hero) >= 0.92', 'inside_frame(hero, margin=0.08)']);
    assert.deepEqual(l5.validatedExtraPredicates, ['visible(hero) >= 0.92', 'inside_frame(hero, margin=0.08)']);
    const rejectedTexts = l5.rejectedPredicates.map((r) => r.predicate);
    assert.ok(rejectedTexts.includes('unregistered_magic(hero) >= 0.9'));
    assert.ok(rejectedTexts.includes('visible(hero) >= 0.3'));
    assert.ok(rejectedTexts.includes('visible(hero, in=[0f, 999f]) >= 0.9'));

    // 外部账本记录了 9 条审片调用，且均带 film 字段
    const ledgerLines = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(ledgerLines.length, 9);
    assert.ok(ledgerLines.every((r) => r.film === 'f_001' && r.role === 'reviewer'));
    assert.equal(l5.usage.totalTokens, 9 * 140);
  } finally {
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-4 端到端委托编排真交付：导演查卡立断言、镜头工独立会话接收五段任务书并渲染核验、收尾员交付六件套达 succeeded', async (t) => {
  const skip = threeMediaSkip();
  if (skip) return t.skip(skip);

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
      if (toolMsgs.length === 0) {
        replyMsg = {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-w1',
            type: 'function',
            function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `${root}/render`, body: { shots: ['s01'], tier: 'draft' } }) },
          }],
        };
      } else if (toolMsgs.length === 1) {
        replyMsg = {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-w2',
            type: 'function',
            function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `${root}/verify`, body: { shots: ['s01'], tier: 'draft' } }) },
          }],
        };
      } else {
        replyMsg = { role: 'assistant', content: '- 状态：pass\n- 修订号：rev=2\n- 草稿渲染与核验摘要：通过\n- 遗留问题：无' };
      }
    } else if (roleTag === 'finalizer') {
      if (toolMsgs.length === 0) {
        replyMsg = {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc-f1',
            type: 'function',
            function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `${root}/deliver`, body: { tier: 'final' } }) },
          }],
        };
      } else {
        replyMsg = { role: 'assistant', content: '六件套已交付完毕。' };
      }
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
      reserveTokens: 5_000,
    },
  });

  try {
    const created = await (await fetch(`${api.url}/v1/films`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'delegate',
        brief: '做一条 1 秒纯片名落版短片，居中显示 BEIMING',
        text: 'BEIMING',
        output: { size: [320, 180], fps: '10/1', frames: 6 },
        budget: { tokens: 500_000, gpuSeconds: 300, wallSeconds: 300 },
      }),
    })).json();
    assert.equal(created.ok, true);

    let jobEnv;
    for (let w = 0; w < 10; w++) {
      jobEnv = await (await fetch(`${api.url}/v1/jobs/${created.data.job}?wait=30`, {
        headers: { authorization: `Bearer ${created.data.token}` },
      })).json();
      if (['succeeded', 'failed', 'stopped', 'canceled'].includes(jobEnv.data.status)) break;
    }
    assert.equal(jobEnv.ok, true);
    assert.equal(jobEnv.data.status, 'succeeded', `委托端到端必须以 succeeded 收尾: ${JSON.stringify(jobEnv)}`);
    assert.equal(jobEnv.outputs?.length, 6, '必须产出六件套交付产物');

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

    const deliverJob = jobEnv.outputs[0].url.split('/artifacts/')[1].split('/')[0];
    const bundleDir = join(dir, 'films', created.data.film, 'deliver', deliverJob, 'bundle');
    const verified = verifyDeliveryBundle(bundleDir);
    assert.equal(Object.keys(verified.files).length, 6);
    const report = JSON.parse(readFileSync(join(bundleDir, 'report.json'), 'utf8'));
    assert.equal(report.verification.layers.L1.ok, true);
    assert.equal(report.verification.layers.L2.ok, true);
    assert.equal(report.verification.layers.L3.ok, true);
    assert.equal(report.verification.layers.L3.basePass, true);
    assert.equal(report.verification.layers.L5.status, 'not-run');
  } finally {
    await api.close();
    await new Promise((r) => mock.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-5 入参防御（B4）：全量公开导出零陷阱校验 Proxy、getter、稀疏/附键数组、循环引用、自定义原型、函数与越界值', () => {
  const isBadArg = (err) => err?.code === 'usage.bad-argument';

  // 1) Proxy 拒绝（覆盖全部公开导出）
  assert.throws(() => selectDelegateTemplate(new Proxy({ brief: '显卡转台' }, {})), isBadArg);
  assert.throws(() => buildShotWorkerBrief(new Proxy({}, {})), isBadArg);
  assert.throws(() => buildShotWorkerMessages(new Proxy({}, {})), isBadArg);
  assert.throws(() => measureStartContextTokens(new Proxy({}, {})), isBadArg);
  assert.throws(() => shuffleCandidatesForBallot(new Proxy([], {})), isBadArg);
  assert.throws(() => normalizeIssueKey(new Proxy({}, {}), 'composition-readability'), isBadArg);
  assert.throws(() => aggregateL5Votes(new Proxy([], {}), { totalFrames: 10 }), isBadArg);
  assert.throws(() => filterL5SuggestedPredicates(new Proxy([], {})), isBadArg);

  // 2) 访问器 getter 零触发拒绝（解构前先检查描述符）
  let getterTriggered = false;
  const makeTrapped = (prop) => {
    const obj = {};
    Object.defineProperty(obj, prop, {
      enumerable: true,
      get() {
        getterTriggered = true;
        throw new Error('不应触发 getter');
      },
    });
    return obj;
  };
  assert.throws(() => selectDelegateTemplate(makeTrapped('brief')), isBadArg);
  assert.throws(() => buildShotWorkerBrief(makeTrapped('shot')), isBadArg);
  assert.throws(() => buildShotWorkerMessages(makeTrapped('shot')), isBadArg);
  assert.throws(() => measureStartContextTokens(makeTrapped('system')), isBadArg);
  assert.throws(() => shuffleCandidatesForBallot(['a'], makeTrapped('filmId')), isBadArg);
  assert.throws(() => aggregateL5Votes([makeTrapped('opinions')], { totalFrames: 10 }), isBadArg);
  assert.throws(() => filterL5SuggestedPredicates([], makeTrapped('film')), isBadArg);
  assert.equal(getterTriggered, false, '属性描述符检查必须在触发任意 getter 前拦截');

  // 3) 稀疏数组、附带非下标键的数组、循环引用、非纯原型、函数（含 toJSON/toString）、Symbol 键
  const sparse = [];
  sparse[1] = 'visible(hero) >= 0.9';
  assert.throws(() => filterL5SuggestedPredicates(sparse), isBadArg);

  const extraKeyArr = ['cand-a'];
  extraKeyArr.sneaky = 1;
  assert.throws(() => shuffleCandidatesForBallot(extraKeyArr), isBadArg);

  const cyclic = { brief: '显卡转台' };
  cyclic.self = cyclic;
  assert.throws(() => selectDelegateTemplate(cyclic), isBadArg);

  class CustomObj { constructor() { this.brief = '显卡转台'; } }
  assert.throws(() => selectDelegateTemplate(new CustomObj()), isBadArg);
  assert.throws(() => selectDelegateTemplate({ brief: '显卡转台', toJSON() { return {}; } }), isBadArg);
  assert.throws(() => selectDelegateTemplate({ brief: '显卡转台', [Symbol('trap')]: 1 }), isBadArg);

  // 4) buildShotWorkerBrief 独立校验：非法 shot.in/out、负预算、超长 ID、超 15,000 token 硬上限
  const validShot = { id: 's01', in: 0, out: 10, source: 'three', host: 'page', mode: 'cards-data', colorRef: 'display' };
  assert.throws(() => buildShotWorkerBrief({ shot: { ...validShot, in: 10, out: 10 } }), isBadArg);
  assert.throws(() => buildShotWorkerBrief({ shot: { ...validShot, in: -1, out: 10 } }), isBadArg);
  assert.throws(() => buildShotWorkerBrief({ shot: validShot, budget: { tokens: -5 } }), isBadArg);
  assert.throws(() => buildShotWorkerBrief({ shot: validShot, budget: { gpuSeconds: NaN } }), isBadArg);
  assert.throws(() => buildShotWorkerBrief({ shot: { ...validShot, id: 's'.repeat(200) } }), isBadArg);
  assert.throws(() => buildShotWorkerBrief({ filmId: 'f'.repeat(200), shot: validShot }), isBadArg);
  assert.throws(() => buildShotWorkerBrief({ shot: { ...validShot, source: 'x'.repeat(80_000) } }), isBadArg);
  assert.throws(() => selectDelegateTemplate({ brief: 123 }), isBadArg);
  assert.throws(() => selectDelegateTemplate({ brief: '   ' }), isBadArg);

  // 5) aggregateL5Votes / filterL5SuggestedPredicates 嵌套结构、quorum、totalFrames、越界帧与空证据拒绝
  assert.throws(() => aggregateL5Votes([{ perspective: 'composition-readability', voteIndex: 0, opinions: [] }], { totalFrames: 0 }), isBadArg);
  assert.throws(() => aggregateL5Votes([{ perspective: 'composition-readability', voteIndex: 0, opinions: [] }], { totalFrames: 10, quorum: 1 }), isBadArg);
  assert.throws(() => aggregateL5Votes([{ perspective: 'composition-readability', voteIndex: 0, opinions: [] }], { totalFrames: 10, film: { output: 'bad' } }), isBadArg);
  assert.throws(() => filterL5SuggestedPredicates(['visible(hero) >= 0.9'], { question: { basePredicates: 'not-array' } }), isBadArg);
  assert.throws(() => createOpenAiVisionReviewer({ endpoint: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', ledgerPath: '/tmp/l.jsonl', votesPerPerspective: 0 }), isBadArg);
  assert.throws(() => createOpenAiVisionReviewer({ endpoint: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', ledgerPath: '/tmp/l.jsonl', maxTokens: -1 }), isBadArg);

  for (const badOpinion of [
    { issueKey: 'hero-framing', frames: [-1, 3], severity: 'warn', evidence: '有证据', comment: '负帧号' },
    { issueKey: 'hero-framing', frames: [2, 10], severity: 'warn', evidence: '有证据', comment: '止帧等于 totalFrames 越界' },
    { issueKey: 'hero-framing', frames: [5, 3], severity: 'warn', evidence: '有证据', comment: '起帧大于止帧' },
    { issueKey: 'hero-framing', frames: [0, 3], severity: 'warn', evidence: '   ', comment: '空证据' },
    { issueKey: 'hero-framing', frames: [0, 3], severity: 'warn', evidence: '有证据', comment: '' },
    { issueKey: 'hero-framing', frames: [0, 3], severity: 'fatal', evidence: '有证据', comment: '非法严重度' },
  ]) {
    assert.throws(
      () => aggregateL5Votes([{ perspective: 'composition-readability', voteIndex: 0, opinions: [badOpinion] }], { totalFrames: 10 }),
      isBadArg,
    );
  }
});

test('A19-6 [B1] L5 每票前预算闸：60,000 token 预算下每票 30,040 token 必须在超限前停票并透传真实预算到服务端 deliver', async () => {
  const { film } = scaffold({ id: 'f_001', template: 'title', output: { size: [320, 180], fps: '10/1', frames: 10 } });
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-b1-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  let visionCalls = 0;

  const mockVision = createServer(async (req, res) => {
    if (!req.complete) await new Promise((r) => { req.once('end', r); req.resume(); });
    visionCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-b1',
      choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 30_000, completion_tokens: 40 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  try {
    const reviewer = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'vision-key',
      model: 'gemini-vision-b1',
      ledgerPath,
    });

    // 1) maxTokens=60000，每票 30,040：第 1 票完成后预计第 2 票将达 60,080 > 60,000，必须在第 2 票前立即停票
    const res1 = await layerL5({
      reviewer,
      brief: '预算测试',
      images: [],
      loudness: null,
      film,
      filmId: 'f_001',
      maxTokens: 60_000,
    });
    assert.equal(visionCalls, 1, '60,000 预算下每票 30,040 token 最多发 1 票，不得发第 2 票冲破预算');
    assert.equal(res1.status, 'ok');
    assert.equal(res1.stoppedReason, 'budget.tokens');
    assert.equal(res1.totalBallots, 1);
    assert.equal(res1.plannedBallots, 9);
    assert.equal(res1.usage.totalTokens, 30_040);

    // 2) maxTokens=0：首票前即拦截，0 次上游调用，status=not-run
    visionCalls = 0;
    const res0 = await layerL5({
      reviewer,
      brief: '零预算测试',
      images: [],
      loudness: null,
      film,
      filmId: 'f_001',
      maxTokens: 0,
    });
    assert.equal(visionCalls, 0);
    assert.equal(res0.status, 'not-run');
    assert.equal(res0.stoppedReason, 'budget.tokens');
    assert.equal(res0.totalBallots, 0);

    // 3) 真实服务端 deliver + delegate 端到端预算联动（若具备媒体工具）
    if (!threeMediaSkip()) {
      visionCalls = 0;
      const srvDir = mkdtempSync(join(tmpdir(), 'bm-a19-b1-srv-'));
      const srvLedger = join(srvDir, 'external-ledger.jsonl');
      const mockAgent = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const sys = body.messages[0]?.content ?? '';
        const roleTag = /\[ROLE:([^\]]+)\]/.exec(sys)?.[1] ?? '';
        const toolMsgs = body.messages.filter((m) => m.role === 'tool');
        const filmId = /f_\d{3}/.exec(JSON.stringify(body.messages))?.[0] ?? 'f_001';
        let msg;
        if (roleTag === 'director') {
          msg = { role: 'assistant', content: 'ok' };
        } else if (roleTag.startsWith('shot-worker:')) {
          if (toolMsgs.length === 0) {
            msg = { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `/v1/films/${filmId}/render`, body: { shots: ['s01'], tier: 'draft' } }) } }] };
          } else if (toolMsgs.length === 1) {
            msg = { role: 'assistant', content: null, tool_calls: [{ id: 'w2', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `/v1/films/${filmId}/verify`, body: { shots: ['s01'], tier: 'draft' } }) } }] };
          } else {
            msg = { role: 'assistant', content: 'pass' };
          }
        } else if (roleTag === 'finalizer') {
          if (toolMsgs.length === 0) {
            msg = { role: 'assistant', content: null, tool_calls: [{ id: 'f1', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: `/v1/films/${filmId}/deliver`, body: { tier: 'final' } }) } }] };
          } else {
            msg = { role: 'assistant', content: 'done' };
          }
        } else {
          msg = { role: 'assistant', content: 'ok' };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, choices: [{ message: msg }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      });
      await new Promise((r) => mockAgent.listen(0, '127.0.0.1', r));
      const token = issueAccountToken(srvDir);
      const api = await startServer({
        dataDir: srvDir,
        port: 0,
        reviewer: createOpenAiVisionReviewer({
          endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
          apiKey: 'vision-key',
          model: 'gemini-vision-b1',
          ledgerPath: srvLedger,
        }),
        delegate: {
          endpoint: `http://127.0.0.1:${mockAgent.address().port}/v1`,
          apiKey: 'key',
          directorModel: 'claude-opus-5-5',
          workerModel: 'claude-sonnet-5-5',
          reserveTokens: 2_000,
        },
      });
      try {
        const created = await (await fetch(`${api.url}/v1/films`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'delegate',
            brief: '做一条 1 秒纯片名落版短片，居中显示 BUDGET',
            text: 'BUDGET',
            output: { size: [320, 180], fps: '10/1', frames: 6 },
            budget: { tokens: 60_000, gpuSeconds: 300, wallSeconds: 300 },
          }),
        })).json();
        assert.equal(created.ok, true);
        let jobEnv;
        for (let w = 0; w < 10; w++) {
          jobEnv = await (await fetch(`${api.url}/v1/jobs/${created.data.job}?wait=30`, {
            headers: { authorization: `Bearer ${created.data.token}` },
          })).json();
          if (['succeeded', 'failed', 'stopped', 'canceled'].includes(jobEnv.data.status)) break;
        }
        assert.equal(jobEnv.data.status, 'succeeded');
        assert.equal(visionCalls, 1, '服务端 deliver 内的 L5 必须受单片 60,000 token 预算约束，仅发 1 票即停');
        const ledgerEnv = await (await fetch(`${api.url}/v1/films/${created.data.film}/ledger`, {
          headers: { authorization: `Bearer ${created.data.token}` },
        })).json();
        const totalModelTokens = ledgerEnv.data.items.reduce((n, row) => n + (row.modelTokens ?? 0), 0);
        assert.ok(totalModelTokens <= 60_000, `整片账本 modelTokens=${totalModelTokens} 必须 <= 60,000`);
        assert.ok(totalModelTokens >= 30_040, `整片账本 modelTokens=${totalModelTokens} 必须计入 L5 的 30,040 token`);
        const deliverJob = jobEnv.outputs[0].url.split('/artifacts/')[1].split('/')[0];
        const report = JSON.parse(readFileSync(join(srvDir, 'films', created.data.film, 'deliver', deliverJob, 'bundle', 'report.json'), 'utf8'));
        assert.equal(report.verification.L5.stoppedReason, 'budget.tokens');
        assert.equal(report.verification.L5.totalBallots, 1);
        const extRows = readFileSync(srvLedger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const revRows = extRows.filter((r) => r.role === 'reviewer');
        assert.equal(revRows.length, 1);
        assert.equal(revRows[0].film, created.data.film);
      } finally {
        await api.close();
        await new Promise((r) => mockAgent.close(r));
        rmSync(srvDir, { recursive: true, force: true });
      }
    }
  } finally {
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-7 [B2] L5 先记账后解析与坏票隔离：第 5 票返回越界帧 [0, 9999] 不丢已花 token、不中断其余选票，全坏票亦 100% 入账', async () => {
  const { film } = scaffold({ id: 'f_001', template: 'turntable', output: { size: [320, 180], fps: '10/1', frames: 20 } });
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-b2-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  let mode = 'mixed';
  let idx = 0;

  const mockVision = createServer(async (req, res) => {
    if (!req.complete) await new Promise((r) => { req.once('end', r); req.resume(); });
    const n = idx++;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'all-bad') {
      res.end(JSON.stringify({
        model: 'gemini-vision-b2',
        choices: [{ message: { content: JSON.stringify({ grade: '一般', opinions: [{ issueKey: 'hero-framing', frames: [0, 9999], severity: 'warn', evidence: '越界', comment: '坏票' }] }) } }],
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      }));
      return;
    }
    if (n === 4) {
      // 第 5 票（motion-rhythm vote 1）：返回越界帧区间 [0, 9999]
      res.end(JSON.stringify({
        model: 'gemini-vision-b2',
        choices: [{ message: { content: JSON.stringify({ grade: '差', opinions: [{ issueKey: 'camera-jitter', frames: [0, 9999], severity: 'error', evidence: '越界帧', comment: '应隔离为坏票但必须记账' }] }) } }],
        usage: { prompt_tokens: 260, completion_tokens: 40 },
      }));
      return;
    }
    if (n === 7) {
      // 第 8 票：损坏 JSON
      res.end(JSON.stringify({
        model: 'gemini-vision-b2',
        choices: [{ message: { content: '{broken json' } }],
        usage: { prompt_tokens: 210, completion_tokens: 40 },
      }));
      return;
    }
    const opinions = (n === 0 || n === 1)
      ? [{ issueKey: 'hero-framing', frames: [2, 6], severity: 'warn', evidence: '主体略偏左', comment: '建议居中' }]
      : [];
    res.end(JSON.stringify({
      model: 'gemini-vision-b2',
      choices: [{ message: { content: JSON.stringify({ grade: '一般', opinions, suggestedPredicates: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  try {
    const reviewer = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'vision-key',
      model: 'gemini-vision-b2',
      ledgerPath,
    });

    const mixed = await layerL5({ reviewer, brief: '坏票隔离测试', images: [], loudness: null, film, filmId: 'f_001' });
    assert.equal(mixed.status, 'ok');
    assert.equal(mixed.totalBallots, 7, '9 票中 2 张坏票被隔离，其余 7 张有效票必须照常聚合');
    assert.equal(mixed.plannedBallots, 9);
    assert.equal(mixed.invalidBallots.length, 2);
    assert.equal(mixed.invalidBallots[0].perspective, 'motion-rhythm');
    assert.equal(mixed.invalidBallots[0].voteIndex, 1);
    assert.equal(mixed.opinions.length, 1);
    assert.equal(mixed.opinions[0].issueKey, 'hero-framing');
    // 7 * 140 + 300 + 250 = 1530：坏票 token 一分不少计入 usage 与外部账本
    assert.equal(mixed.usage.totalTokens, 1530);
    const ledger1 = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(ledger1.length, 9);
    assert.equal(ledger1.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0), 1530);
    assert.ok(ledger1.every((r) => r.film === 'f_001'));

    // 全坏票场景：status === 'failed' 但 usage 依然 100% 返还（9 * 250 = 2250）
    mode = 'all-bad';
    idx = 0;
    const allBad = await layerL5({ reviewer, brief: '全坏票记账测试', images: [], loudness: null, film, filmId: 'f_002' });
    assert.equal(allBad.status, 'failed');
    assert.equal(allBad.totalBallots, 0);
    assert.equal(allBad.invalidBallots.length, 9);
    assert.equal(allBad.usage.totalTokens, 9 * 250);
  } finally {
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-8 [B3] 封闭 issueKey、顺序无关聚类、保守总评、重复槽位/未知候选拒收与建议谓词法定票数门限', () => {
  // 1) normalizeIssueKey：接受大小写/下划线/空白归一化，拒绝泛化键 'issue' 与跨视角键
  assert.equal(normalizeIssueKey('Hero_Framing', 'composition-readability'), 'hero-framing');
  assert.equal(normalizeIssueKey('  cut  seam ', 'look-consistency'), 'cut-seam');
  assert.equal(normalizeIssueKey('issue', 'composition-readability'), null);
  assert.equal(normalizeIssueKey('cut-seam', 'composition-readability'), null);
  assert.equal(normalizeIssueKey('hero-framing', 'motion-rhythm'), null);

  // 2) 顺序无关连通分量聚类：相邻帧段 [2, 5] 与 [6, 8] 无论选票顺序如何均合并为 [2, 8] 且结果字节一致
  const ballotsForward = [
    {
      perspective: 'composition-readability',
      voteIndex: 0,
      grade: '一般',
      opinions: [{ issueKey: 'hero-framing', frames: [2, 5], severity: 'warn', evidence: '证据 A', comment: '意见 A', suggestedPredicate: 'visible(hero) >= 0.91' }],
      suggestedPredicates: ['inside_frame(hero, margin=0.05)'],
    },
    {
      perspective: 'composition-readability',
      voteIndex: 1,
      grade: '一般',
      opinions: [
        { issueKey: 'hero-framing', frames: [6, 8], severity: 'error', evidence: '证据 B', comment: '意见 B', suggestedPredicate: 'visible(hero) >= 0.91' },
        { issueKey: 'hero-framing', frames: [6, 7], severity: 'warn', evidence: '证据 B2', comment: '顺带单票建议谓词', suggestedPredicate: 'inside_frame(hero, margin=0.12)' },
      ],
    },
    {
      perspective: 'composition-readability',
      voteIndex: 2,
      grade: '好',
      opinions: [{ issueKey: 'title-readability', frames: [12, 15], severity: 'info', evidence: '单票证据', comment: '单票意见' }],
    },
  ];
  const ballotsReversed = [...ballotsForward].reverse();
  const aggForward = aggregateL5Votes(ballotsForward, { totalFrames: 20 });
  const aggReversed = aggregateL5Votes(ballotsReversed, { totalFrames: 20 });
  assert.deepEqual(aggForward, aggReversed, '选票输入顺序变化不得影响聚类、代表意见、总评或逐票排序');
  assert.equal(aggForward.opinions.length, 1);
  assert.deepEqual(aggForward.opinions[0].frames, [2, 8]);
  assert.equal(aggForward.opinions[0].votes, 2);
  assert.equal(aggForward.opinions[0].severity, 'error');
  // 单票 suggestedPredicate ('inside_frame(hero, margin=0.05)' 仅 1 票) 不得放行；2 票的 'visible(hero) >= 0.91' 放行
  assert.deepEqual(aggForward.suggestedPredicates, ['visible(hero) >= 0.91']);

  // 3) 保守总评：opinions 为空但存在单票丢弃或表外键作废时，总评绝不落成「好」
  const onlyDiscardedNoGrade = aggregateL5Votes([
    { perspective: 'composition-readability', voteIndex: 0, opinions: [{ issueKey: 'hero-framing', frames: [0, 3], severity: 'warn', evidence: '证据', comment: '单票问题' }] },
    { perspective: 'composition-readability', voteIndex: 1, opinions: [] },
  ], { totalFrames: 10 });
  assert.equal(onlyDiscardedNoGrade.opinions.length, 0);
  assert.equal(onlyDiscardedNoGrade.discardedOpinionCount, 1);
  assert.equal(onlyDiscardedNoGrade.grade, '一般');

  const onlyDiscardedGoodGrade = aggregateL5Votes([
    { perspective: 'composition-readability', voteIndex: 0, grade: '好', opinions: [{ issueKey: 'hero-framing', frames: [0, 3], severity: 'warn', evidence: '证据', comment: '单票问题' }] },
    { perspective: 'composition-readability', voteIndex: 1, grade: '好', opinions: [] },
  ], { totalFrames: 10 });
  assert.equal(onlyDiscardedGoodGrade.grade, '一般');

  const onlyRejectedKey = aggregateL5Votes([
    { perspective: 'composition-readability', voteIndex: 0, grade: '好', opinions: [{ issueKey: 'issue', frames: [0, 3], severity: 'warn', evidence: '泛化键', comment: '应作废' }] },
  ], { totalFrames: 10 });
  assert.equal(onlyRejectedKey.opinions.length, 0);
  assert.equal(onlyRejectedKey.rejectedOpinions.length, 1);
  assert.equal(onlyRejectedKey.grade, '一般');

  // 平票保守裁决（差 > 一般 > 好）
  const tied = aggregateL5Votes([
    { perspective: 'composition-readability', voteIndex: 0, grade: '好', opinions: [] },
    { perspective: 'composition-readability', voteIndex: 1, grade: '一般', opinions: [] },
    { perspective: 'composition-readability', voteIndex: 2, grade: '差', opinions: [] },
  ], { totalFrames: 10 });
  assert.equal(tied.grade, '差');

  // 4) 拒绝重复 (perspective, voteIndex) 与未知/重复候选 ID（含显式空 candidates: []）
  assert.throws(
    () => aggregateL5Votes([
      { perspective: 'composition-readability', voteIndex: 0, opinions: [] },
      { perspective: 'composition-readability', voteIndex: 0, opinions: [] },
    ], { totalFrames: 10 }),
    (err) => err.code === 'usage.bad-argument',
  );
  assert.throws(
    () => aggregateL5Votes([
      { perspective: 'composition-readability', voteIndex: 0, candidateGrades: [{ id: 'ghost', grade: '好' }], opinions: [] },
    ], { totalFrames: 10, candidates: ['cand-a'] }),
    (err) => err.code === 'usage.bad-argument',
  );
  assert.throws(
    () => aggregateL5Votes([
      { perspective: 'composition-readability', voteIndex: 0, candidateGrades: [{ id: 'ghost', grade: '好' }], opinions: [] },
    ], { totalFrames: 10, candidates: [] }),
    (err) => err.code === 'usage.bad-argument',
  );
});

test('A19-9 [非阻断 #2] 镜头工首次未过重试前重读最新片子与镜头条目，第二次任务书收到最新 rev 与改动后的镜头 JSON', async () => {
  const { film: initialFilm } = scaffold({ id: 'f_001', template: 'title', text: 'FIRST', output: { size: [320, 180], fps: '10/1', frames: 6 } });
  let currentFilm = structuredClone(initialFilm);
  let currentRev = 1;
  const workerBriefs = [];

  const mockApi = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && url.pathname === '/v1/films/f_001/ledger') {
      res.end(JSON.stringify({ ok: true, data: { items: [] } }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/films/f_001/film') {
      res.end(JSON.stringify({ ok: true, data: { rev: currentRev, film: currentFilm } }));
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/v1/films/f_001/film') {
      currentRev += 1;
      currentFilm = structuredClone(currentFilm);
      currentFilm.shots[0].cards[0].params.text = 'UPDATED';
      res.end(JSON.stringify({ ok: true, data: { rev: currentRev, applied: 1 } }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/films/f_001/render') {
      res.end(JSON.stringify({ ok: true, data: { status: 'succeeded', rev: currentRev } }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/films/f_001/verify') {
      res.end(JSON.stringify({ ok: true, data: { status: 'succeeded', rev: currentRev } }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/films/f_001/deliver') {
      res.end(JSON.stringify({
        ok: true,
        data: { status: 'succeeded', rev: currentRev },
        outputs: ['master', 'web', 'contact', 'report', 'run', 'lock'].map((k) => ({ kind: k, url: `/v1/films/f_001/artifacts/j_001/bundle/${k}` })),
      }));
      return;
    }
    res.end(JSON.stringify({ ok: true, data: {} }));
  });
  await new Promise((r) => mockApi.listen(0, '127.0.0.1', r));

  let workerAttempt = 0;
  const mockModel = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sys = body.messages[0]?.content ?? '';
    const usr = body.messages[1]?.content ?? '';
    const roleTag = /\[ROLE:([^\]]+)\]/.exec(sys)?.[1] ?? '';
    const toolMsgs = body.messages.filter((m) => m.role === 'tool');
    let msg;

    if (roleTag === 'director') {
      msg = { role: 'assistant', content: '导演确认完毕' };
    } else if (roleTag === 'shot-worker:s01') {
      if (body.messages.length === 2) {
        workerAttempt++;
        workerBriefs.push(usr);
      }
      if (workerAttempt === 1) {
        if (toolMsgs.length === 0) {
          // 第 1 次尝试修改了 s01 的文案，但未做 render/verify 就退出触发重试
          msg = {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'p1',
              type: 'function',
              function: {
                name: 'http_request',
                arguments: JSON.stringify({
                  method: 'PUT',
                  path: '/v1/films/f_001/film',
                  body: { format: 'patch/0.1', rev: 1, ops: [{ op: 'set', path: 'shots/s01/cards/title/params/text', value: 'UPDATED' }] },
                }),
              },
            }],
          };
        } else {
          msg = { role: 'assistant', content: '已修改文案，退出触发重试' };
        }
      } else {
        if (toolMsgs.length === 0) {
          msg = { role: 'assistant', content: null, tool_calls: [{ id: 'r2', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films/f_001/render', body: { shots: ['s01'], tier: 'draft' } }) } }] };
        } else if (toolMsgs.length === 1) {
          msg = { role: 'assistant', content: null, tool_calls: [{ id: 'v2', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films/f_001/verify', body: { shots: ['s01'], tier: 'draft' } }) } }] };
        } else {
          msg = { role: 'assistant', content: '重试通过' };
        }
      }
    } else {
      msg = { role: 'assistant', content: '收尾完成' };
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: msg }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  });
  await new Promise((r) => mockModel.listen(0, '127.0.0.1', r));

  try {
    const outcome = await runDelegateOrchestrator({
      baseUrl: `http://127.0.0.1:${mockApi.address().port}`,
      accountToken: 'acct',
      filmId: 'f_001',
      workspaceToken: 'ws',
      brief: '纯片名重试测试',
      endpoint: `http://127.0.0.1:${mockModel.address().port}/v1`,
      apiKey: 'key',
      directorModel: 'claude-opus-5-5',
      workerModel: 'claude-sonnet-5-5',
      reserveTokens: 2_000,
    });
    assert.equal(outcome.status, 'succeeded');
    assert.equal(workerBriefs.length, 2, '镜头工未过时应恰好重试一次');
    assert.match(workerBriefs[0], /rev=1/);
    assert.match(workerBriefs[0], /"text":"FIRST"/);
    assert.match(workerBriefs[1], /rev=2/, '重试前必须重读最新修订号');
    assert.match(workerBriefs[1], /"text":"UPDATED"/, '重试前必须重读改动后的最新镜头 JSON');
  } finally {
    await new Promise((r) => mockApi.close(r));
    await new Promise((r) => mockModel.close(r));
  }
});
