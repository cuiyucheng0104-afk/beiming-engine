import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tools, verifyDeliveryBundle } from '../comp/index.mjs';
import { blenderInfo, loadCardLibrary } from './runtime.mjs';
import { normalizeJsonToolBody } from './agents.mjs';
import {
  DEFAULT_REVIEW_MAX_OUTPUT_TOKENS,
  DELEGATE_HARD_TOKEN_CAP,
  DELEGATE_ROLES,
  HTTP_TOOL,
  L5_GRADES,
  L5_ISSUE_KEYS,
  L5_PERSPECTIVES,
  SHOT_WORKER_MAX_START_TOKENS,
  aggregateL5Votes,
  buildShotWorkerBrief,
  buildShotWorkerMessages,
  callApi,
  chat,
  createOpenAiVisionReviewer,
  filterL5SuggestedPredicates,
  issueAccountToken,
  measureStartContextTokens,
  normalizeIssueKey,
  runDelegateOrchestrator,
  runHandsOnAgent,
  selectDelegateTemplate,
  shuffleCandidatesForBallot,
  startServer,
} from './index.mjs';
import { scaffold } from './films.mjs';
import { layerL1, layerL5 } from './pipeline.mjs';

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
    // 1) 无 Blender 依赖的 title 需求：全平台（含无 Blender 的 CI runner）必跑，服务端忽略客户端伪造 turntable/非法模板
    const spoofedForTitle = ['turntable', 'turntable', 'bogus-template', 'turntable', undefined];
    const seenTitleTemplates = [];
    for (let i = 0; i < 5; i++) {
      const createRes = await (await fetch(`${api.url}/v1/films`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'delegate',
          brief: '做一条 2 秒纯片名落版短片，居中显示 BEIMING',
          assets: [],
          ...(spoofedForTitle[i] ? { template: spoofedForTitle[i] } : {}),
          output: { size: [320, 180], fps: '10/1', frames: 10 },
        }),
      })).json();
      assert.equal(createRes.ok, true, `第 ${i + 1} 次 title 委托建片应成功：${JSON.stringify(createRes.error ?? null)}`);
      const filmEnv = await (await fetch(`${api.url}/v1/films/${createRes.data.film}/film`, {
        headers: { authorization: `Bearer ${createRes.data.token}` },
      })).json();
      assert.equal(filmEnv.ok, true);
      assert.equal(filmEnv.data.film.shots.length, 1);
      assert.equal(filmEnv.data.film.shots[0].source, 'three');
      const meta = JSON.parse(readFileSync(join(dir, 'meta', `${createRes.data.film}.json`), 'utf8'));
      assert.equal(meta.template, 'title');
      assert.equal(meta.templateSelectedBy, 'server');
      seenTitleTemplates.push(meta.template);
    }
    assert.deepEqual(seenTitleTemplates, ['title', 'title', 'title', 'title', 'title']);

    // 2) 本机装有 Blender 时另验 turntable 需求（需 Blender 签发正式锁）：服务端忽略客户端伪造 title/非法模板
    if (blenderInfo()) {
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
        assert.equal(createRes.ok, true, `第 ${i + 1} 次 turntable 委托建片应成功：${JSON.stringify(createRes.error ?? null)}`);
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
    }
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

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sys = body?.messages?.[0]?.content ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'all-bad') {
      res.end(JSON.stringify({
        model: 'gemini-vision-b2',
        choices: [{ message: { content: JSON.stringify({ grade: '一般', opinions: [{ issueKey: 'hero-framing', frames: [0, 9999], severity: 'warn', evidence: '越界', comment: '坏票' }] }) } }],
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      }));
      return;
    }
    if (sys.includes('[PERSPECTIVE:motion-rhythm][VOTE:2]')) {
      // 第 5 票（motion-rhythm vote 1）：返回越界帧区间 [0, 9999]
      res.end(JSON.stringify({
        model: 'gemini-vision-b2',
        choices: [{ message: { content: JSON.stringify({ grade: '差', opinions: [{ issueKey: 'camera-jitter', frames: [0, 9999], severity: 'error', evidence: '越界帧', comment: '应隔离为坏票但必须记账' }] }) } }],
        usage: { prompt_tokens: 260, completion_tokens: 40 },
      }));
      return;
    }
    if (sys.includes('[PERSPECTIVE:look-consistency][VOTE:2]')) {
      // 第 8 票（look-consistency vote 1）：损坏 JSON
      res.end(JSON.stringify({
        model: 'gemini-vision-b2',
        choices: [{ message: { content: '{broken json' } }],
        usage: { prompt_tokens: 210, completion_tokens: 40 },
      }));
      return;
    }
    const opinions = (
      sys.includes('[PERSPECTIVE:composition-readability][VOTE:1]')
      || sys.includes('[PERSPECTIVE:composition-readability][VOTE:2]')
    )
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

/** 构造带合法 PNG 签名与 IHDR 宽高的最小假 PNG 字节（供测试图像上界估算） */
function fakePngHeader(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('A19-10 [R2-B1] L5 视觉请求必带 max_tokens、首票与带图可执行上界、高水位防均价超支与同片并发原子预留', async () => {
  const { film } = scaffold({ id: 'f_001', template: 'title', output: { size: [320, 180], fps: '10/1', frames: 10 } });
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-r2-b1-'));
  const ledgerPath = join(dir, 'external-ledger.jsonl');
  const hdPngPath = join(dir, 'contact-hd.png');
  writeFileSync(hdPngPath, fakePngHeader(1920, 1080));

  const seenBodies = [];
  const seenEstimates = [];
  let costPlan = [{ prompt: 100, comp: 40 }];
  let callIdx = 0;

  const mockVision = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seenBodies.push(body);
    const plan = costPlan[Math.min(callIdx, costPlan.length - 1)];
    callIdx++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gemini-vision-r2',
      choices: [{ message: { content: '{"grade":"好","opinions":[],"suggestedPredicates":[]}' } }],
      usage: { prompt_tokens: plan.prompt, completion_tokens: plan.comp },
    }));
  });
  await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));

  try {
    const reviewer = createOpenAiVisionReviewer({
      endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
      apiKey: 'r2-b1-key',
      model: 'gemini-vision-r2',
      ledgerPath,
    });

    // 1) 首票估价绝不为 0，且每次视觉请求显式带上 max_tokens；带 1920x1080 PNG 图时可执行上界显著大于无图
    seenBodies.length = 0;
    seenEstimates.length = 0;
    callIdx = 0;
    const textOnly = await layerL5({
      reviewer,
      brief: '上界测试',
      images: [],
      film,
      filmId: 'f_001',
      maxTokens: 60_000,
      budgetCheck(info) {
        seenEstimates.push(info.estimatedNextTokens);
        return true;
      },
    });
    assert.equal(textOnly.status, 'ok');
    assert.equal(seenBodies.length, 9);
    assert.ok(seenEstimates[0] > 0, '首票 estimatedNextTokens 绝不能为 0');
    assert.ok(
      seenBodies.every((b) => Number.isSafeInteger(b.max_tokens) && b.max_tokens === DEFAULT_REVIEW_MAX_OUTPUT_TOKENS),
      '每次 L5 视觉请求体必须显式带 max_tokens',
    );
    const textOnlyFirstBound = seenEstimates[0];

    const withImageEstimates = [];
    seenBodies.length = 0;
    callIdx = 0;
    const withImage = await layerL5({
      reviewer,
      brief: '上界测试',
      images: [{ name: 'contact', path: hdPngPath }],
      film,
      filmId: 'f_001',
      maxTokens: 60_000,
      budgetCheck(info) {
        withImageEstimates.push(info.estimatedNextTokens);
        return true;
      },
    });
    assert.equal(withImage.status, 'ok');
    assert.ok(
      withImageEstimates[0] >= textOnlyFirstBound + 3_000,
      `带 1920x1080 图像的首票上界 (${withImageEstimates[0]}) 必须显著高于纯文本上界 (${textOnlyFirstBound})`,
    );

    // 2) 预算小于首票可执行上界时，首票前即拦停（0 次调用），绝不靠首票估价=0放行
    seenBodies.length = 0;
    callIdx = 0;
    const tooSmall = await layerL5({
      reviewer,
      brief: '小预算测试',
      images: [{ name: 'contact', path: hdPngPath }],
      film,
      filmId: 'f_001',
      maxTokens: textOnlyFirstBound, // 足够纯文本，但不足以覆盖 1920x1080 图 + 输出上限
    });
    assert.equal(seenBodies.length, 0, '不足首票带图上界时必须 0 票拦截');
    assert.equal(tooSmall.status, 'not-run');
    assert.equal(tooSmall.stoppedReason, 'budget.tokens');

    // 3) 变价票防均价超支：第 1 票 10,040、第 2 票 30,040（总 40,080，均价 20,040），总预算 65,000（余额 24,920 > 均价但 < 高水位 30,040）
    //    必须在第 3 票前立即停票，绝不能因余额大于历史均价而放行更贵的第 3 票！
    seenBodies.length = 0;
    callIdx = 0;
    costPlan = [
      { prompt: 10_000, comp: 40 },
      { prompt: 30_000, comp: 40 },
      { prompt: 30_000, comp: 40 },
    ];
    const antiAvg = await layerL5({
      reviewer,
      brief: '变价防均价超支',
      images: [],
      film,
      filmId: 'f_001',
      maxTokens: 65_000,
    });
    assert.equal(seenBodies.length, 2, '余额 24,920 小于历史高水位 30,040 时不得发第 3 票');
    assert.equal(antiAvg.status, 'ok');
    assert.equal(antiAvg.stoppedReason, 'budget.tokens');
    assert.equal(antiAvg.usage.totalTokens, 40_080);

    // 4) 剩余额度略高于输入上界但小于默认 max_tokens 时，显式把请求体 max_tokens 钳制在剩余额度内
    seenBodies.length = 0;
    callIdx = 0;
    costPlan = [{ prompt: 100, comp: 40 }];
    const tightCap = textOnlyFirstBound - DEFAULT_REVIEW_MAX_OUTPUT_TOKENS + 300;
    const tightRes = await layerL5({
      reviewer,
      brief: '上界测试',
      images: [],
      film,
      filmId: 'f_001',
      maxTokens: tightCap,
    });
    assert.equal(tightRes.status, 'ok');
    assert.ok(seenBodies.length >= 1);
    assert.equal(seenBodies[0].max_tokens, 300, '首票 max_tokens 必须钳制为剩余预算减去输入上界');

    // 5) 同片并发 POST /v1/films/{id}/review 进程内原子预留实测：慢响应并发时绝不双双冲过单片预算
    if (!threeMediaSkip()) {
      const srvDir = mkdtempSync(join(tmpdir(), 'bm-a19-r2-conc-'));
      const srvLedger = join(srvDir, 'external-ledger.jsonl');
      let concurrentCalls = 0;
      let maxInFlight = 0;
      let inFlight = 0;
      let holdNextVision = null;
      let onVisionEntered = null;
      const slowVision = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.ok(Number.isSafeInteger(body.max_tokens) && body.max_tokens >= 1 && body.max_tokens <= DEFAULT_REVIEW_MAX_OUTPUT_TOKENS);
        concurrentCalls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        onVisionEntered?.();
        if (holdNextVision) {
          const gate = holdNextVision;
          holdNextVision = null;
          await gate;
        } else {
          await new Promise((r) => setTimeout(r, 80));
        }
        inFlight--;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'gemini-vision-conc',
          choices: [{ message: { content: '{"grade":"好","opinions":[],"suggestedPredicates":[]}' } }],
          usage: { prompt_tokens: 4_000, completion_tokens: 40 },
        }));
      });
      await new Promise((r) => slowVision.listen(0, '127.0.0.1', r));
      const token = issueAccountToken(srvDir);
      const api = await startServer({
        dataDir: srvDir,
        port: 0,
        reviewer: createOpenAiVisionReviewer({
          endpoint: `http://127.0.0.1:${slowVision.address().port}/v1`,
          apiKey: 'conc-key',
          model: 'gemini-vision-conc',
          ledgerPath: srvLedger,
        }),
      });
      try {
        // 单片预算 6,500：带 1 张 contact.png 时单票上界约 ~4,300，只能容纳 1 张在途预留，并发 3 路 review 时后 2 路必须被原子预留立即挡下！
        const created = await (await fetch(`${api.url}/v1/films`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            template: 'title',
            text: 'ATOM',
            output: { size: [320, 180], fps: '10/1', frames: 6 },
            budget: { tokens: 6_500 },
          }),
        })).json();
        assert.equal(created.ok, true);
        const filmId = created.data.film;
        const wsToken = created.data.token;

        // 先渲草稿帧作为 review 材料
        const renderEnv = await (await fetch(`${api.url}/v1/films/${filmId}/render?wait=30`, {
          method: 'POST',
          headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tier: 'draft' }),
        })).json();
        assert.equal(renderEnv.ok, true);
        assert.equal(renderEnv.data.status, 'succeeded');

        // 并发发起 3 路独立 POST /review
        const results = await Promise.all([1, 2, 3].map(() =>
          fetch(`${api.url}/v1/films/${filmId}/review`, {
            method: 'POST',
            headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ brief: '并发原子预留测试' }),
          }).then((r) => r.json()),
        ));
        assert.ok(results.every((r) => r.ok));
        assert.equal(concurrentCalls, 1, '单片 6,500 预算下并发 3 路 review 只允许放行 1 票，绝不允许双双在途超支');
        assert.equal(maxInFlight, 1, '进程内原子预留必须保证同片并发超额请求不会同时在途');
        assert.equal(results.filter((r) => r.data.status === 'ok').length, 1);
        assert.equal(results.filter((r) => r.data.status === 'not-run' && r.data.stoppedReason === 'budget.tokens').length, 2);

        const ledgerEnv = await (await fetch(`${api.url}/v1/films/${filmId}/ledger`, {
          headers: { authorization: `Bearer ${wsToken}` },
        })).json();
        const ledgerTotal = ledgerEnv.data.items.reduce((s, x) => s + (x.modelTokens ?? 0), 0);
        const extRows = readFileSync(srvLedger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const extTotal = extRows.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
        assert.equal(ledgerTotal, 4_040);
        assert.equal(extTotal, 4_040);
        assert.ok(ledgerTotal <= 6_500);

        // 5b) 同片独立 POST /review 在途未结算时，并发 POST /deliver 的 L5 必须共享同一原子预留账本，不得超支
        concurrentCalls = 0;
        maxInFlight = 0;
        const created2 = await (await fetch(`${api.url}/v1/films`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            template: 'title',
            text: 'RACE',
            output: { size: [320, 180], fps: '10/1', frames: 6 },
            budget: { tokens: 6_500 },
          }),
        })).json();
        assert.equal(created2.ok, true);
        const film2 = created2.data.film;
        const ws2 = created2.data.token;
        const render2 = await (await fetch(`${api.url}/v1/films/${film2}/render?wait=30`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ws2}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tier: 'draft' }),
        })).json();
        assert.equal(render2.ok, true);
        assert.equal(render2.data.status, 'succeeded');

        let releaseReview;
        holdNextVision = new Promise((r) => { releaseReview = r; });
        const entered = new Promise((r) => { onVisionEntered = r; });
        const reviewPromise = fetch(`${api.url}/v1/films/${film2}/review`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ws2}`, 'content-type': 'application/json' },
          body: JSON.stringify({ brief: 'review 与 deliver 并发原子预留' }),
        }).then((r) => r.json());
        try {
          await entered;
          onVisionEntered = null;

          // 此时 review 已原子预留首票额度并悬停在慢上游请求中，立即发起同片 deliver
          const deliverEnv = await (await fetch(`${api.url}/v1/films/${film2}/deliver?wait=30`, {
            method: 'POST',
            headers: { authorization: `Bearer ${ws2}`, 'content-type': 'application/json' },
            body: JSON.stringify({ tier: 'final' }),
          })).json();
          assert.equal(deliverEnv.ok, true);
          assert.equal(deliverEnv.data.status, 'succeeded');
          const reportOut = deliverEnv.outputs.find((o) => o.kind === 'report');
          assert.ok(reportOut, 'deliver 必须产出 report.json');
          const report = await (await fetch(`${api.url}${reportOut.url}`, {
            headers: { authorization: `Bearer ${ws2}` },
          })).json();
          assert.equal(report.verification.L5.status, 'not-run', 'review 在途原子预留占满剩余预算时，deliver 内 L5 必须被挡停');
          assert.equal(report.verification.L5.stoppedReason, 'budget.tokens');
        } finally {
          releaseReview();
        }
        const reviewEnv = await reviewPromise;
        assert.equal(reviewEnv.ok, true);
        assert.equal(reviewEnv.data.status, 'ok');
        assert.equal(reviewEnv.data.stoppedReason, 'budget.tokens');
        assert.equal(concurrentCalls, 1, 'review + deliver 同片并发总上游调用必须严格 <= 1 票');
        assert.equal(maxInFlight, 1);

        const ledger2 = await (await fetch(`${api.url}/v1/films/${film2}/ledger`, {
          headers: { authorization: `Bearer ${ws2}` },
        })).json();
        const ledger2Total = ledger2.data.items.reduce((s, x) => s + (x.modelTokens ?? 0), 0);
        const ext2Total = readFileSync(srvLedger, 'utf8').trim().split('\n')
          .map((l) => JSON.parse(l))
          .filter((r) => r.film === film2)
          .reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
        assert.equal(ledger2Total, 4_040);
        assert.equal(ext2Total, 4_040);
        assert.ok(ledger2Total <= 6_500);
      } finally {
        await api.close();
        await new Promise((r) => slowVision.close(r));
        rmSync(srvDir, { recursive: true, force: true });
      }
    }
  } finally {
    await new Promise((r) => mockVision.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-11 [R2-B2] 坏信封（choices: [] 含 usage）与 budgetCheck 抛错 0 丢账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-r2-b2-'));
  const origFetch = globalThis.fetch;
  try {
    // 1) 完整复现 review_report_r2.md:86-113 两条异常路径（envelope & callback）
    for (const mode of ['envelope', 'callback']) {
      let calls = 0;
      let billed = 0;
      let outputLimit = null;
      globalThis.fetch = async (_, { body }) => {
        const req = JSON.parse(body);
        outputLimit = req.max_completion_tokens ?? req.max_tokens ?? null;
        const n = ++calls;
        billed += 140 + n;
        return Response.json({
          choices: n === 5 ? [] : [{ message: { content: '{"opinions":[]}' } }],
          usage: { prompt_tokens: 100 + n, completion_tokens: 40 },
        });
      };
      const ledgerPath = join(dir, `${mode}.jsonl`);
      const reviewer = createOpenAiVisionReviewer({
        endpoint: 'https://fixture.invalid',
        apiKey: 'fixture',
        model: 'fixture',
        ledgerPath,
      });
      const r = await layerL5({
        reviewer,
        images: [],
        film: { id: 'f', output: { frames: 40 }, shots: [] },
        maxTokens: 60_000,
        budgetCheck() {
          if (mode === 'callback' && calls) throw new Error('ledger unavailable /secret/path');
          return true;
        },
      });
      const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const ledger = rows.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
      assert.equal(outputLimit, DEFAULT_REVIEW_MAX_OUTPUT_TOKENS);
      assert.ok(rows.every((row) => row.film === 'f'), '每条外部账本行必须带 film 字段');

      if (mode === 'envelope') {
        assert.equal(r.status, 'ok');
        assert.equal(r.totalBallots, 8);
        assert.equal(r.invalidBallots.length, 1);
        assert.equal(billed, 1_305);
        assert.equal(r.usage?.totalTokens, 1_305, '第 5 票坏信封里的 145 token 绝不得丢失');
        assert.equal(ledger, 1_305, '外部账本必须计入第 5 票坏信封的 145 token');
      } else {
        assert.equal(r.status, 'ok');
        assert.equal(r.stoppedReason, 'budget.check-error');
        assert.equal(r.totalBallots, 1, '回调抛错时必须保留已投出的第 1 张有效选票');
        assert.equal(billed, 141);
        assert.equal(r.usage?.totalTokens, 141, '回调抛错时必须保留前序 141 token 用量');
        assert.equal(ledger, 141);
        assert.equal(JSON.stringify(r).includes('ledger unavailable'), false, '回调内部错误文案不得泄漏');
      }
    }

    // 2) 首票 budgetCheck 即抛错时返回 failed + stoppedReason: 'budget.check-error' 且 0 次上游调用
    let calls0 = 0;
    globalThis.fetch = async () => {
      calls0++;
      return Response.json({ choices: [{ message: { content: '{"opinions":[]}' } }], usage: { prompt_tokens: 100, completion_tokens: 40 } });
    };
    const r0 = await layerL5({
      reviewer: createOpenAiVisionReviewer({
        endpoint: 'https://fixture.invalid',
        apiKey: 'fixture',
        model: 'fixture',
        ledgerPath: join(dir, 'cb0.jsonl'),
      }),
      images: [],
      film: { id: 'f', output: { frames: 40 }, shots: [] },
      budgetCheck() { throw new Error('boom'); },
    });
    assert.equal(calls0, 0);
    assert.equal(r0.status, 'failed');
    assert.equal(r0.stoppedReason, 'budget.check-error');
    assert.equal(r0.usage?.totalTokens, 0);

    // 3) chat() 遇到 choices: [] 仍把提取到的 usage/model 附在异常对象上
    globalThis.fetch = async () => Response.json({
      model: 'fixture-m',
      choices: [],
      usage: { prompt_tokens: 105, completion_tokens: 40 },
    });
    await assert.rejects(
      () => chat({ endpoint: 'https://fixture.invalid', apiKey: 'k', body: { model: 'm', messages: [] } }),
      (err) => err?.usage?.inputTokens === 105 && err?.usage?.outputTokens === 40 && err?.model === 'fixture-m',
    );
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-12 [R2-B3 & R2-B4] 重复候选 ID 拒收、无 film 时 totalFrames 帧界校验、28-1 真实考题对齐与任务书 120 万硬上限', () => {
  const isBadArg = (err) => err?.code === 'usage.bad-argument';
  const votes = (p) => [0, 1].map((voteIndex) => ({
    voteIndex,
    opinions: [],
    suggestedPredicates: [p],
  }));

  // 1) B3: 重复候选 ID 在 aggregateL5Votes 与 shuffleCandidatesForBallot 均立即拒收
  assert.throws(() => aggregateL5Votes([{ opinions: [] }], { candidates: ['a', 'a'] }), isBadArg);
  assert.throws(() => aggregateL5Votes([{ opinions: [] }], { candidates: [{ id: 'a' }, { id: 'a' }] }), isBadArg);
  assert.throws(() => shuffleCandidatesForBallot(['a', 'a']), isBadArg);
  assert.throws(() => shuffleCandidatesForBallot([{ id: 'a' }, { id: ' a ' }]), isBadArg);

  // 2) B3: 未传 film 但传了 totalFrames: 40 时，越界帧区间谓词必须拦截在 rejectedPredicates
  const oob = aggregateL5Votes(votes('visible(hero) >= 0.92 @ [100,120)'), { totalFrames: 40 });
  assert.deepEqual(oob.validatedExtraPredicates, []);
  assert.equal(oob.rejectedPredicates.length, 1);

  const inBounds = aggregateL5Votes(votes('visible(hero) >= 0.92 @ [10,30)'), { totalFrames: 40 });
  assert.deepEqual(inBounds.validatedExtraPredicates, ['visible(hero) >= 0.92 @ [10,30)']);
  assert.deepEqual(inBounds.rejectedPredicates, []);

  // 需要片子上下文才能验证的作用域（无 film 时的 shot(s01) / 无帧数时的 [10,30) / event(...)）不得放行
  assert.deepEqual(
    filterL5SuggestedPredicates(['visible(hero) >= 0.92 @ shot(s01)'], { totalFrames: 40 }).validatedExtraPredicates,
    [],
  );
  assert.deepEqual(
    filterL5SuggestedPredicates(['visible(hero) >= 0.92 @ [10,30)']).validatedExtraPredicates,
    [],
  );
  assert.deepEqual(
    filterL5SuggestedPredicates(['visible(hero) >= 0.92 @ event(beat1)'], { totalFrames: 40 }).validatedExtraPredicates,
    [],
  );

  // 3) B3: 真实考题 28-1 与正式 layerL1 完全对齐（考题自带 bbox_w 不得误杀合法建议谓词）
  const p = 'visible(subject) >= 0.92';
  const question = JSON.parse(readFileSync('beiming/bench/questions/level-1/28-1.json', 'utf8'));
  const { film } = scaffold({ id: 'f', template: 'title', question });
  const proposed = { ...film, predicates: { ...film.predicates, extra: [...film.predicates.extra, p] } };
  assert.equal(layerL1(proposed, null, 1, question).ok, true);
  const examAgg = aggregateL5Votes(votes(p), { film, question });
  assert.deepEqual(examAgg.validatedExtraPredicates, [p]);
  assert.deepEqual(examAgg.rejectedPredicates, []);
  // 而如果 L5 自己建议未实现的计划谓词 bbox_w，仍须拦截
  const plannedAgg = aggregateL5Votes(votes('bbox_w(subject) <= 0.50 @ all'), { film, question });
  assert.deepEqual(plannedAgg.validatedExtraPredicates, []);
  assert.equal(plannedAgg.rejectedPredicates.length, 1);

  // 4) B4: buildShotWorkerBrief / buildShotWorkerMessages 对齐 120 万硬上限
  assert.equal(DELEGATE_HARD_TOKEN_CAP, 1_200_000);
  assert.throws(
    () => buildShotWorkerBrief({ shot: { id: 's', in: 0, out: 6 }, budget: { tokens: 1_200_001 } }),
    isBadArg,
  );
  assert.throws(
    () => buildShotWorkerMessages({ shot: { id: 's', in: 0, out: 6 }, budget: { tokens: 1_200_001 } }),
    isBadArg,
  );
  const atCap = buildShotWorkerBrief({ shot: { id: 's', in: 0, out: 6 }, budget: { tokens: 1_200_000 } });
  assert.ok(atCap.includes('1200000'));
});

test('A19-13 [R2-删镜重试] 镜头工重试前最新修订已删除原镜头时跳过该镜头并记入状态，绝不回退过期旧镜头', async () => {
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

  const mockModel = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sys = body.messages[0]?.content ?? '';
    const usr = body.messages[1]?.content ?? '';
    const roleTag = /\[ROLE:([^\]]+)\]/.exec(sys)?.[1] ?? '';
    let msg;

    if (roleTag === 'director') {
      msg = { role: 'assistant', content: '导演确认完毕' };
    } else if (roleTag === 'shot-worker:s01') {
      workerBriefs.push(usr);
      // 模拟首轮执行期间，外部最新修订已把 s01 从片子中移除（rev=2, shots=[]）
      currentRev = 2;
      currentFilm = { ...structuredClone(currentFilm), shots: [] };
      msg = { role: 'assistant', content: '未做渲染核验，触发重试前重读' };
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
      brief: '删镜重试不回退测试',
      endpoint: `http://127.0.0.1:${mockModel.address().port}/v1`,
      apiKey: 'key',
      directorModel: 'claude-opus-5-5',
      workerModel: 'claude-sonnet-5-5',
      reserveTokens: 2_000,
    });
    assert.equal(outcome.status, 'succeeded');
    assert.equal(workerBriefs.length, 1, '最新修订已移除 s01 时不得带着过期旧镜头发起第二次重试派工');
    assert.match(workerBriefs[0], /rev=1/);
    assert.match(workerBriefs[0], /"text":"FIRST"/);
    assert.deepEqual(outcome.skippedRemovedShots, [{ shot: 's01', rev: 2 }]);
  } finally {
    await new Promise((r) => mockApi.close(r));
    await new Promise((r) => mockModel.close(r));
  }
});

test('A19-14 [R3-B1] 高倍率视觉模型图像输入预估：gpt-4o-mini 与 gpt-4.1-mini/nano/o4-mini 首票防超支且不回归其他模型', async () => {
  const { film } = scaffold({ id: 'f_001', template: 'title', output: { size: [320, 180], fps: '10/1', frames: 10 } });
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-r3-b1-'));
  const img180 = join(dir, 'icon-180.png');
  const img512 = join(dir, 'icon-512.png');
  const imgContact = join(dir, 'contact-326x186.png');
  const imgSq1024 = join(dir, 'sq-1024.png');
  const imgHd = join(dir, 'hd-1920x1080.png');
  const imgCorrupt = join(dir, 'corrupt.bin');
  writeFileSync(img180, fakePngHeader(180, 180));
  writeFileSync(img512, fakePngHeader(512, 512));
  writeFileSync(imgContact, fakePngHeader(326, 186));
  writeFileSync(imgSq1024, fakePngHeader(1024, 1024));
  writeFileSync(imgHd, fakePngHeader(1920, 1080));
  writeFileSync(imgCorrupt, Buffer.from('not-a-valid-png-image'));

  const origFetch = globalThis.fetch;
  try {
    const runProbe = async ({ model, images, maxTokens = null, rejectOnBudget = false }) => {
      const ledgerPath = join(dir, `${model.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
      const reviewer = createOpenAiVisionReviewer({
        endpoint: 'https://fixture.invalid',
        apiKey: 'test-key',
        model,
        ledgerPath,
      });
      let calls = 0;
      let firstInfo = null;
      globalThis.fetch = async () => {
        calls++;
        return Response.json({
          model,
          choices: [{ message: { content: JSON.stringify({ grade: '好', opinions: [], suggestedPredicates: [] }) } }],
          usage: { prompt_tokens: 8500, completion_tokens: 8 },
        });
      };
      const r = await layerL5({
        reviewer,
        brief: '高倍率图像预估测试',
        images,
        film,
        filmId: 'f_001',
        ...(maxTokens !== null ? { maxTokens } : {}),
        budgetCheck(info) {
          firstInfo ??= info;
          return !rejectOnBudget;
        },
      });
      return { r, calls, firstInfo, ledgerExists: existsSync(ledgerPath) };
    };

    // 1) R3 复现：3 张图 + gpt-4o-mini + maxTokens: 8000 -> 预估 > 8000，首票前停下且 0 次上游调用
    const threeImages = [
      { name: 'contact', path: img180 },
      { name: 'cut1', path: img512 },
      { name: 'cut2', path: imgContact },
    ];
    const threeProbeEstimate = await runProbe({ model: 'gpt-4o-mini', images: threeImages, rejectOnBudget: true });
    assert.equal(threeProbeEstimate.calls, 0);
    assert.ok(
      threeProbeEstimate.firstInfo.estimatedInputTokens >= 3 * (2833 + 5667),
      `3 张图 gpt-4o-mini 输入预估应 >= 25500，实际 ${threeProbeEstimate.firstInfo.estimatedInputTokens}`,
    );
    assert.ok(threeProbeEstimate.firstInfo.estimatedNextTokens > 8_000);

    const threeCapped = await runProbe({ model: 'gpt-4o-mini', images: threeImages, maxTokens: 8_000 });
    assert.equal(threeCapped.calls, 0, '3 张图 + gpt-4o-mini + maxTokens=8000 必须 0 调用拦停');
    assert.equal(threeCapped.r.status, 'not-run');
    assert.equal(threeCapped.r.stoppedReason, 'budget.tokens');

    // 2) R3 复现：单张 326x186 联系表 + gpt-4o-mini（含供应商前缀与日期后缀）+ maxTokens: 6500 -> 首票前拦停 0 调用
    for (const modelName of ['gpt-4o-mini', 'openai/gpt-4o-mini', 'OpenRouter/OpenAI/GPT-4O-MINI-2024-07-18']) {
      const singleCapped = await runProbe({
        model: modelName,
        images: [{ name: 'contact', path: imgContact }],
        maxTokens: 6_500,
      });
      assert.equal(singleCapped.calls, 0, `${modelName} 单张联系表 6500 预算必须 0 调用拦停`);
      assert.equal(singleCapped.r.status, 'not-run');
      assert.equal(singleCapped.r.stoppedReason, 'budget.tokens');
    }

    // 3) 不可解析图像字节在 gpt-4o-mini 下回退至少 2833 + 5667 = 8500
    const corruptCapped = await runProbe({
      model: 'gpt-4o-mini',
      images: [{ name: 'contact', path: imgCorrupt }],
      maxTokens: 8_000,
    });
    assert.equal(corruptCapped.calls, 0, 'gpt-4o-mini 不可解析图回退至少 8500，8000 预算必须 0 调用拦停');
    assert.equal(corruptCapped.r.stoppedReason, 'budget.tokens');

    // 4) gpt-4.1-mini / gpt-4.1-nano / o4-mini 官方倍率与非高倍率基线对照（同图同 prompt 文本，精确验证图像估算差值）
    const imgStrip = join(dir, 'strip-513x1537.png');
    writeFileSync(imgStrip, fakePngHeader(513, 1537));
    const stripTiles = Math.ceil(513 / 512) * Math.ceil(1537 / 512); // 8
    const stripBaseImg = Math.max(1024, stripTiles * 256 + 256, Math.ceil((513 * 1537) / 512)); // 2304

    const sqBase = await runProbe({ model: 'gemini-vision-r2', images: [{ name: 'sq', path: imgSq1024 }], rejectOnBudget: true });
    const sqNano = await runProbe({ model: 'openai/gpt-4.1-nano-2025-04-14', images: [{ name: 'sq', path: imgSq1024 }], rejectOnBudget: true });
    assert.equal(
      sqNano.firstInfo.estimatedInputTokens - sqBase.firstInfo.estimatedInputTokens,
      Math.ceil(1024 * 2.46) - 2048,
      '1024x1024 gpt-4.1-nano 图像输入估算应覆盖 32px 补丁倍率',
    );

    const stripBase = await runProbe({ model: 'gpt-4o', images: [{ name: 'strip', path: imgStrip }], rejectOnBudget: true });
    const stripMini41 = await runProbe({ model: 'gpt-4.1-mini', images: [{ name: 'strip', path: imgStrip }], rejectOnBudget: true });
    const stripO4Mini = await runProbe({ model: 'o4-mini', images: [{ name: 'strip', path: imgStrip }], rejectOnBudget: true });
    const stripNano41 = await runProbe({ model: 'gpt-4.1-nano', images: [{ name: 'strip', path: imgStrip }], rejectOnBudget: true });
    assert.equal(
      stripMini41.firstInfo.estimatedInputTokens - stripBase.firstInfo.estimatedInputTokens,
      Math.ceil((85 + 170 * stripTiles) * 1.62) - stripBaseImg,
    );
    assert.equal(
      stripO4Mini.firstInfo.estimatedInputTokens - stripBase.firstInfo.estimatedInputTokens,
      Math.ceil((85 + 170 * stripTiles) * 1.72) - stripBaseImg,
    );
    assert.equal(
      stripNano41.firstInfo.estimatedInputTokens - stripBase.firstInfo.estimatedInputTokens,
      Math.ceil((85 + 170 * stripTiles) * 2.46) - stripBaseImg,
    );

    const hdBase = await runProbe({ model: 'gpt-4o', images: [{ name: 'hd', path: imgHd }], rejectOnBudget: true });
    const hdNano41 = await runProbe({ model: 'gpt-4.1-nano', images: [{ name: 'hd', path: imgHd }], rejectOnBudget: true });
    const hdTiles = Math.ceil(1920 / 512) * Math.ceil(1080 / 512); // 12
    assert.equal(
      hdNano41.firstInfo.estimatedInputTokens - hdBase.firstInfo.estimatedInputTokens,
      Math.ceil((85 + 170 * hdTiles) * 2.46) - Math.ceil((1920 * 1080) / 512),
    );

    // 非高倍率模型（gemini-vision-r2）单张 326x186 + maxTokens: 6500 仍可正常发首票（零回归）
    const nonHighOk = await runProbe({
      model: 'gemini-vision-r2',
      images: [{ name: 'contact', path: imgContact }],
      maxTokens: 6_500,
    });
    assert.equal(nonHighOk.calls, 1, '非高倍率模型原有保守估算保持不变');

    // 5) 端到端 POST /review：真实渲染 326x186 联系表 + gpt-4o-mini + 单片 6,500 预算 -> 首票前零调用停下
    if (!threeMediaSkip()) {
      globalThis.fetch = origFetch;
      const srvDir = mkdtempSync(join(tmpdir(), 'bm-a19-r3-b1-srv-'));
      const srvLedger = join(srvDir, 'external-ledger.jsonl');
      let upstreamCalls = 0;
      const mockVision = createServer(async (req, res) => {
        for await (const chunk of req) void chunk;
        upstreamCalls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: '{"opinions":[]}' } }],
          usage: { prompt_tokens: 8500, completion_tokens: 8 },
        }));
      });
      await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));
      const token = issueAccountToken(srvDir);
      const api = await startServer({
        dataDir: srvDir,
        port: 0,
        reviewer: createOpenAiVisionReviewer({
          endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
          apiKey: 'test-key',
          model: 'gpt-4o-mini',
          ledgerPath: srvLedger,
        }),
      });
      try {
        const created = await (await fetch(`${api.url}/v1/films`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            template: 'title',
            text: 'MINI',
            output: { size: [320, 180], fps: '10/1', frames: 6 },
            budget: { tokens: 6_500 },
          }),
        })).json();
        assert.equal(created.ok, true);
        const filmId = created.data.film;
        const wsToken = created.data.token;
        const rendered = await (await fetch(`${api.url}/v1/films/${filmId}/render?wait=30`, {
          method: 'POST',
          headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tier: 'draft' }),
        })).json();
        assert.equal(rendered.ok, true);
        assert.equal(rendered.data.status, 'succeeded');

        const reviewed = await (await fetch(`${api.url}/v1/films/${filmId}/review`, {
          method: 'POST',
          headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ brief: 'gpt-4o-mini 单片 6500 预算守卫' }),
        })).json();
        assert.equal(reviewed.ok, true);
        assert.equal(reviewed.data.status, 'not-run');
        assert.equal(reviewed.data.stoppedReason, 'budget.tokens');
        assert.equal(upstreamCalls, 0, 'POST /review 在 gpt-4o-mini + 6500 预算下必须 0 次上游调用');
        assert.equal(existsSync(srvLedger), false, '未发出任何上游调用时外部账本不应有扣费记录');
        const ledger = await (await fetch(`${api.url}/v1/films/${filmId}/ledger`, {
          headers: { authorization: `Bearer ${wsToken}` },
        })).json();
        const wsTotal = ledger.data.items.reduce((s, x) => s + (x.modelTokens ?? 0), 0);
        assert.equal(wsTotal, 0);
      } finally {
        await api.close();
        await new Promise((r) => mockVision.close(r));
        rmSync(srvDir, { recursive: true, force: true });
      }
    }
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-15 [R3-B2] 坏信封省略 completion_tokens 但含 total_tokens 时全额补足差额入账（L5 与外部/工作区三账一致）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-r3-b2-'));
  const origFetch = globalThis.fetch;
  try {
    // 1) R3 精确复现：第 5 票 choices: [] + { prompt_tokens: 105, total_tokens: 145 } -> 合计 1305 不丢 40
    const ledgerPath = join(dir, 'r3-b2.jsonl');
    let calls = 0;
    globalThis.fetch = async () => {
      const n = ++calls;
      return Response.json({
        choices: n === 5 ? [] : [{ message: { content: JSON.stringify({ opinions: [] }) } }],
        usage: n === 5
          ? { prompt_tokens: 105, total_tokens: 145 }
          : { prompt_tokens: 100 + n, completion_tokens: 40 },
      });
    };
    const reviewer = createOpenAiVisionReviewer({
      endpoint: 'https://fixture.invalid',
      apiKey: 'test-key',
      model: 'fixture',
      ledgerPath,
    });
    const r = await layerL5({
      film: { id: 'f', output: { frames: 40 }, shots: [] },
      images: [],
      reviewer,
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.totalBallots, 8);
    assert.equal(r.invalidBallots?.length, 1);
    const ledgerRows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(ledgerRows.length, 9);
    assert.equal(ledgerRows[4].inputTokens, 105);
    assert.equal(ledgerRows[4].outputTokens, 40);
    const extTotal = ledgerRows.reduce((sum, x) => sum + x.inputTokens + x.outputTokens, 0);
    assert.deepEqual([r.usage?.totalTokens, extTotal], [1305, 1305]);

    // 2) chat() 各种 total_tokens 差额补足与 requireUsage 严格模式守卫
    const cases = [
      { usage: { prompt_tokens: 105, total_tokens: 145 }, expect: { inputTokens: 105, outputTokens: 40 } },
      { usage: { completion_tokens: 40, total_tokens: 145 }, expect: { inputTokens: 105, outputTokens: 40 } },
      { usage: { total_tokens: 145 }, expect: { inputTokens: 145, outputTokens: 0 } },
      { usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 145 }, expect: { inputTokens: 115, outputTokens: 30 } },
      { usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 120 }, expect: { inputTokens: 100, outputTokens: 40 } },
    ];
    for (const c of cases) {
      globalThis.fetch = async () => Response.json({
        model: 'fixture-m',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: c.usage,
      });
      const res = await chat({ endpoint: 'https://fixture.invalid', apiKey: 'test-key', body: { model: 'fixture-m', messages: [] } });
      assert.deepEqual(res.usage, c.expect, `usage=${JSON.stringify(c.usage)}`);
    }
    globalThis.fetch = async () => Response.json({
      model: 'fixture-m',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 105, total_tokens: 145 },
    });
    await assert.rejects(
      () => chat({ endpoint: 'https://fixture.invalid', apiKey: 'test-key', body: { model: 'fixture-m', messages: [] }, requireUsage: true }),
      /没有返回可核算的 token 用量/,
    );

    // 3) 端到端 POST /review：第 5 票坏信封省略 completion_tokens，审片报告、工作区账本与外部账本三者均为 1305
    if (!threeMediaSkip()) {
      globalThis.fetch = origFetch;
      const srvDir = mkdtempSync(join(tmpdir(), 'bm-a19-r3-b2-srv-'));
      const srvLedger = join(srvDir, 'external-ledger.jsonl');
      let ballotCalls = 0;
      const mockVision = createServer(async (req, res) => {
        for await (const chunk of req) void chunk;
        const n = ++ballotCalls;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'fixture-review',
          choices: n === 5 ? [] : [{ message: { content: JSON.stringify({ opinions: [] }) } }],
          usage: n === 5
            ? { prompt_tokens: 105, total_tokens: 145 }
            : { prompt_tokens: 100 + n, completion_tokens: 40 },
        }));
      });
      await new Promise((r) => mockVision.listen(0, '127.0.0.1', r));
      const token = issueAccountToken(srvDir);
      const api = await startServer({
        dataDir: srvDir,
        port: 0,
        reviewer: createOpenAiVisionReviewer({
          endpoint: `http://127.0.0.1:${mockVision.address().port}/v1`,
          apiKey: 'test-key',
          model: 'fixture-review',
          ledgerPath: srvLedger,
        }),
      });
      try {
        const created = await (await fetch(`${api.url}/v1/films`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            template: 'title',
            text: 'B2',
            output: { size: [320, 180], fps: '10/1', frames: 6 },
            budget: { tokens: 60_000 },
          }),
        })).json();
        assert.equal(created.ok, true);
        const filmId = created.data.film;
        const wsToken = created.data.token;
        const rendered = await (await fetch(`${api.url}/v1/films/${filmId}/render?wait=30`, {
          method: 'POST',
          headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tier: 'draft' }),
        })).json();
        assert.equal(rendered.ok, true);
        assert.equal(rendered.data.status, 'succeeded');

        const reviewed = await (await fetch(`${api.url}/v1/films/${filmId}/review`, {
          method: 'POST',
          headers: { authorization: `Bearer ${wsToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ brief: 'B2 坏信封三账一致测试' }),
        })).json();
        assert.equal(reviewed.ok, true);
        assert.equal(reviewed.data.status, 'ok');
        assert.equal(reviewed.data.invalidBallots?.length, 1);
        const reviewArtifact = reviewed.outputs.find((o) => o.kind === 'review');
        assert.ok(reviewArtifact, 'POST /review 必须返回 review.json 报告产物');
        const reviewReport = await (await fetch(`${api.url}${reviewArtifact.url}`, {
          headers: { authorization: `Bearer ${wsToken}` },
        })).json();
        assert.equal(reviewReport.totalBallots, 8);
        assert.equal(reviewReport.invalidBallots?.length, 1);
        assert.equal(reviewReport.usage?.totalTokens, 1305);

        const wsLedger = await (await fetch(`${api.url}/v1/films/${filmId}/ledger`, {
          headers: { authorization: `Bearer ${wsToken}` },
        })).json();
        const wsTotal = wsLedger.data.items.reduce((s, x) => s + (x.modelTokens ?? 0), 0);
        const srvExtRows = readFileSync(srvLedger, 'utf8').trim().split('\n').map(JSON.parse);
        const srvExtTotal = srvExtRows.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
        assert.deepEqual([reviewReport.usage?.totalTokens, wsTotal, srvExtTotal], [1305, 1305, 1305]);
      } finally {
        await api.close();
        await new Promise((r) => mockVision.close(r));
        rmSync(srvDir, { recursive: true, force: true });
      }
    }
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-16 [R3-B3] 候选 ID 首尾空白一致规范化：展示目录、逐票允许集合与回票解析完全对齐', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-r3-b3-'));
  const origFetch = globalThis.fetch;
  try {
    // 1) shuffleCandidatesForBallot 规范化空白、保持元数据、不修改原输入且与已去空格输入产生同序
    const rawObjects = [{ id: ' a ', label: '方案A' }, { id: 'b', label: '方案B' }];
    const cleanObjects = [{ id: 'a', label: '方案A' }, { id: 'b', label: '方案B' }];
    const shuffledRaw = shuffleCandidatesForBallot(rawObjects, { filmId: 'f', perspective: 'composition-readability', voteIndex: 0 });
    const shuffledClean = shuffleCandidatesForBallot(cleanObjects, { filmId: 'f', perspective: 'composition-readability', voteIndex: 0 });
    assert.deepEqual(shuffledRaw, shuffledClean, '带空白候选 ID 打乱结果必须与去空白版完全一致');
    assert.equal(rawObjects[0].id, ' a ', 'shuffleCandidatesForBallot 不得原地修改调用方入参');

    const shuffledStrings = shuffleCandidatesForBallot([' a ', ' b '], { filmId: 'f', perspective: 'motion-rhythm', voteIndex: 1 });
    assert.ok(shuffledStrings.every((id) => id === id.trim()), '字符串候选列表也应统一 trim');

    // 2) R3 精确复现：对象候选 [{ id: ' a ' }, { id: 'b' }]，模型原样回填展示顺序的 ID，9 票全部有效
    const ledgerPath = join(dir, 'r3-b3-obj.jsonl');
    const seenDisplayed = [];
    globalThis.fetch = async (_, { body }) => {
      const req = JSON.parse(body);
      const text = req.messages[1].content[0].text;
      const ordered = JSON.parse(text.split('\n').find((x) => x.startsWith('候选展示顺序')).split('：').slice(1).join('：'));
      seenDisplayed.push(ordered);
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ opinions: [], candidateGrades: ordered.map(({ id }) => ({ id, grade: '好' })) }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      });
    };
    const reviewer = createOpenAiVisionReviewer({
      endpoint: 'https://fixture.invalid',
      apiKey: 'test-key',
      model: 'fixture',
      ledgerPath,
    });
    const r = await layerL5({
      film: { id: 'f', output: { frames: 40 }, shots: [] },
      images: [],
      reviewer,
      candidates: [{ id: ' a ' }, { id: 'b' }],
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.totalBallots, 9);
    assert.equal(r.invalidBallots, undefined);
    assert.equal(seenDisplayed.length, 9);
    assert.ok(seenDisplayed.every((list) => list.every((item) => item.id === item.id.trim())));
    assert.equal(r.candidateGrades.a.grade, '好');
    assert.equal(r.candidateGrades.b.grade, '好');

    // 3) 字符串候选 [' a ', 'b'] 且模型回填含空白 ID ' a ' 时同样 9 票有效
    const ledgerPath2 = join(dir, 'r3-b3-str.jsonl');
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ opinions: [], candidateGrades: [{ id: ' a ', grade: '一般' }, { id: 'b', grade: '好' }] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    });
    const reviewer2 = createOpenAiVisionReviewer({
      endpoint: 'https://fixture.invalid',
      apiKey: 'test-key',
      model: 'fixture',
      ledgerPath: ledgerPath2,
    });
    const r2 = await layerL5({
      film: { id: 'f', output: { frames: 40 }, shots: [] },
      images: [],
      reviewer: reviewer2,
      candidates: [' a ', 'b'],
    });
    assert.equal(r2.status, 'ok');
    assert.equal(r2.totalBallots, 9);
    assert.equal(r2.invalidBallots, undefined);
    assert.equal(r2.candidateGrades.a.grade, '一般');
    assert.equal(r2.candidateGrades.b.grade, '好');
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-17 [FIX-real-model] 委托编排兼容模型将 JSON 请求体序列化为字符串（shot-worker patch/0.1 与 render/verify/deliver）且拒收非法体', async () => {
  const { film: initialFilm } = scaffold({ id: 'f_001', template: 'title', text: 'INIT', output: { size: [320, 180], fps: '10/1', frames: 6 } });
  let currentFilm = structuredClone(initialFilm);
  let currentRev = 1;
  const received = [];

  const mockApi = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const contentType = req.headers['content-type'] ?? '';
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { /* 保留 raw */ }
    }
    if (req.method !== 'GET') {
      received.push({ method: req.method, path: url.pathname, contentType, raw, parsed });
    }
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
      currentRev++;
      res.end(JSON.stringify({ ok: true, data: { rev: currentRev } }));
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/v1/films/f_001/render' || url.pathname === '/v1/films/f_001/verify')) {
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

  const toolReplies = { director: [], worker: [], finalizer: [] };
  const mockModel = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sys = body.messages[0]?.content ?? '';
    const roleTag = /\[ROLE:([^\]]+)\]/.exec(sys)?.[1] ?? '';
    const tm = body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    const tc = (id, method, path, reqBody) => ({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method, path, ...(reqBody !== undefined ? { body: reqBody } : {}) }) } }],
    });

    let msg;
    if (roleTag === 'director') {
      toolReplies.director = tm;
      if (tm.length === 0) {
        // 导演用 JSON 字符串提交 patch/0.1
        msg = tc('d1', 'PUT', '/v1/films/f_001/film', JSON.stringify({
          format: 'patch/0.1',
          rev: 1,
          ops: [{ op: 'set', path: 'predicates/extra', value: ['inside_frame(hero, margin=0.05) @ shot(s01)'] }],
        }));
      } else {
        msg = { role: 'assistant', content: '导演完成' };
      }
    } else if (roleTag === 'shot-worker:s01') {
      toolReplies.worker = tm;
      if (tm.length === 0) {
        // 越权跨镜头 JSON 字符串 patch -> 仍须被 ownShotPatch 拒收
        msg = tc('w1', 'PUT', '/v1/films/f_001/film', JSON.stringify({
          format: 'patch/0.1',
          rev: 2,
          ops: [{ op: 'set', path: 'shots/s99/cards/title/params/text', value: 'BAD' }],
        }));
      } else if (tm.length === 1) {
        // 损坏 JSON 字符串 patch -> 仍须被 ownShotPatch 拒收
        msg = tc('w2', 'PUT', '/v1/films/f_001/film', '{"format":"patch/0.1",broken');
      } else if (tm.length === 2) {
        // 合法本镜头 JSON 字符串 patch/0.1 -> 必须解包通过 ownShotPatch 并以 application/json 发送
        msg = tc('w3', 'PUT', '/v1/films/f_001/film', JSON.stringify({
          format: 'patch/0.1',
          rev: 2,
          ops: [{ op: 'set', path: 'shots/s01/cards/title/params/text', value: 'STR-OK' }],
        }));
      } else if (tm.length === 3) {
        // render 给坏 JSON 字符串 -> 拒收，绝不按字符拆散成 {"0":"{",...}
        msg = tc('w4', 'POST', '/v1/films/f_001/render', '{not-json');
      } else if (tm.length === 4) {
        // render 给数组 JSON 字符串 -> 拒收，绝不按索引展开
        msg = tc('w5', 'POST', '/v1/films/f_001/render', '["s01"]');
      } else if (tm.length === 5) {
        // render 给合法 JSON 字符串 -> 解包后合并 wait:0 / shots / tier:draft
        msg = tc('w6', 'POST', '/v1/films/f_001/render', '{"tier":"final","shots":["s99"]}');
      } else if (tm.length === 6) {
        // verify 给合法 JSON 字符串 -> 解包后合并 wait:0 / shots / tier:draft
        msg = tc('w7', 'POST', '/v1/films/f_001/verify', '{"tier":"draft"}');
      } else {
        msg = { role: 'assistant', content: '状态：pass' };
      }
    } else {
      toolReplies.finalizer = tm;
      if (tm.length === 0) {
        // deliver 给非法原始值 -> 拒收，不吞成 { wait: 0 }
        msg = tc('f1', 'POST', '/v1/films/f_001/deliver', 42);
      } else if (tm.length === 1) {
        // deliver 给合法 JSON 字符串 -> 解包后合并 tier:final / wait:0
        msg = tc('f2', 'POST', '/v1/films/f_001/deliver', '{"tier":"final"}');
      } else {
        msg = { role: 'assistant', content: '交付完成' };
      }
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
      brief: '真模型 JSON 字符串请求体回归',
      endpoint: `http://127.0.0.1:${mockModel.address().port}/v1`,
      apiKey: 'key',
      directorModel: 'gemini-4-carbon',
      workerModel: 'gemini-4-argon',
      reserveTokens: 2_000,
    });
    assert.equal(outcome.status, 'succeeded', `委托应成功，实际：${JSON.stringify(outcome)}`);
    // 越权/损坏 patch 与非法作业 body 必须在委托侧拒收
    assert.ok(toolReplies.worker[0]?.refused, '跨镜头字符串 patch 必须被拒收');
    assert.ok(toolReplies.worker[1]?.refused, '损坏 JSON 字符串 patch 必须被拒收');
    assert.equal(toolReplies.worker[2]?.status, 200, '本镜头合法 JSON 字符串 patch 必须放行');
    assert.ok(toolReplies.worker[3]?.refused, 'render 损坏 JSON 字符串必须被拒收');
    assert.ok(toolReplies.worker[4]?.refused, 'render JSON 数组字符串必须被拒收');
    assert.equal(toolReplies.worker[5]?.status, 200, 'render 合法 JSON 字符串必须放行');
    assert.equal(toolReplies.worker[6]?.status, 200, 'verify 合法 JSON 字符串必须放行');
    assert.ok(toolReplies.finalizer[0]?.refused, 'deliver 非对象原始体必须被拒收');
    // deliver 成功交回六件套后 finalizer 直接短循环返回，不再为汇报追加一次模型调用
    assert.equal(toolReplies.finalizer.length, 1);
    assert.equal(outcome.outputs.length, 6);

    // 核对到达服务端的全部请求均是合法 application/json 且无字符拆散键 "0"
    assert.equal(received.length, 5);
    for (const r of received) {
      assert.match(r.contentType, /^application\/json\b/i, `${r.method} ${r.path} 应为 application/json`);
      assert.equal(Object.hasOwn(r.parsed, '0'), false, `${r.method} ${r.path} 不得把字符串按字符拆散成键 "0"`);
    }
    assert.equal(received[0].path, '/v1/films/f_001/film');
    assert.equal(received[0].parsed.format, 'patch/0.1');
    assert.equal(received[1].path, '/v1/films/f_001/film');
    assert.equal(received[1].parsed.ops[0].value, 'STR-OK');
    assert.equal(received[2].path, '/v1/films/f_001/render');
    assert.deepEqual(received[2].parsed, { tier: 'draft', shots: ['s01'], wait: 0 });
    assert.equal(received[3].path, '/v1/films/f_001/verify');
    assert.deepEqual(received[3].parsed, { tier: 'draft', shots: ['s01'], wait: 0 });
    assert.equal(received[4].path, '/v1/films/f_001/deliver');
    assert.deepEqual(received[4].parsed, { tier: 'final', wait: 0 });
  } finally {
    await new Promise((r) => mockApi.close(r));
    await new Promise((r) => mockModel.close(r));
  }
});

test('A19-18 [FIX-real-model] callApi 与 attachHandsOnBrief 兼容非 /files/ 的 JSON 字符串 body，/files/* 保持 text/plain 且不吞非法 brief', async () => {
  // 1) 探针服务：验证 callApi 对非 /files/ 的 JSON 对象/数组字符串发 application/json，而 /files/* 与非法字符串保持 text/plain
  const seen = [];
  const probe = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({
      method: req.method,
      path: req.url,
      contentType: req.headers['content-type'] ?? '',
      raw: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: {} }));
  });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const client = { baseUrl: `http://127.0.0.1:${probe.address().port}`, account: 'acct', workspaces: { f_001: 'ws' }, jobs: {} };

  try {
    await callApi(client, { method: 'POST', path: '/v1/cards/search', body: '  {"q":"title","limit":5}  ' });
    await callApi(client, { method: 'POST', path: '/v1/films/f_001/observe/metrics', body: '["deliverSpec"]' });
    await callApi(client, { method: 'POST', path: '/v1/films/f_001/render', body: '{bad-json' });
    await callApi(client, { method: 'POST', path: '/v1/films/f_001/render', body: '123' });
    await callApi(client, { method: 'PUT', path: '/v1/films/f_001/files/shots/s01/main.py', body: '  {"not_unwrapped": 1}\n' });
    await callApi(client, { method: 'PUT', path: '/v1/films/f_001/files/shots/s01/script.mjs?x=1', body: 'export default {}' });

    assert.equal(seen[0].contentType, 'application/json');
    assert.deepEqual(JSON.parse(seen[0].raw), { q: 'title', limit: 5 });
    assert.equal(seen[1].contentType, 'application/json');
    assert.deepEqual(JSON.parse(seen[1].raw), ['deliverSpec']);
    assert.equal(seen[2].contentType, 'text/plain; charset=utf-8');
    assert.equal(seen[2].raw, '{bad-json');
    assert.equal(seen[3].contentType, 'text/plain; charset=utf-8');
    assert.equal(seen[3].raw, '123');
    assert.equal(seen[4].contentType, 'text/plain; charset=utf-8');
    assert.equal(seen[4].raw, '  {"not_unwrapped": 1}\n');
    assert.equal(seen[5].contentType, 'text/plain; charset=utf-8');
    assert.equal(seen[5].raw, 'export default {}');
  } finally {
    await new Promise((r) => probe.close(r));
  }

  // 2) 真实 startServer + runHandsOnAgent：字符串 JSON 建片省略 brief 时自动补回 brief，显式非法类型 brief 仍报 400
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-a19-18-handson-'));
  const ledgerPath = join(dataDir, 'agent-ledger.jsonl');
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0 });
  let round = 0;
  let createdFilmId = null;
  const mockAgent = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    round++;
    const last = body.messages.at(-1);
    if (round === 2 && last?.role === 'tool') {
      createdFilmId = JSON.parse(last.content)?.body?.data?.film ?? null;
    }
    let msg;
    if (round === 1) {
      // 字符串化 JSON 建片且省略 brief -> 必须解包并自动补回代理 brief（200）
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: {
            name: 'http_request',
            arguments: JSON.stringify({
              method: 'POST',
              path: '/v1/films',
              body: JSON.stringify({ template: 'title', text: 'STRBRIEF', output: { size: [320, 180], fps: '10/1', frames: 6 } }),
            }),
          },
        }],
      };
    } else if (round === 2) {
      // 字符串化 JSON 带显式非法类型 brief（对象 / 数字）-> 绝不覆盖，服务端必须返回 400 usage.bad-argument
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c2',
            type: 'function',
            function: {
              name: 'http_request',
              arguments: JSON.stringify({
                method: 'POST',
                path: '/v1/films',
                body: JSON.stringify({ template: 'title', brief: { bad: true }, text: 'BAD1', output: { size: [320, 180], fps: '10/1', frames: 6 } }),
              }),
            },
          },
          {
            id: 'c3',
            type: 'function',
            function: {
              name: 'http_request',
              arguments: JSON.stringify({
                method: 'POST',
                path: '/v1/films',
                body: JSON.stringify({ template: 'title', brief: 123, text: 'BAD2', output: { size: [320, 180], fps: '10/1', frames: 6 } }),
              }),
            },
          },
          {
            id: 'c4',
            type: 'function',
            function: {
              name: 'http_request',
              arguments: JSON.stringify({
                method: 'POST',
                path: `/v1/films/${createdFilmId}/review`,
                body: JSON.stringify({ brief: { bad: 'review' } }),
              }),
            },
          },
        ],
      };
    } else {
      msg = { role: 'assistant', content: '完成' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'hands-on-str-body', choices: [{ message: msg }], usage: { prompt_tokens: 60, completion_tokens: 15 } }));
  });
  await new Promise((r) => mockAgent.listen(0, '127.0.0.1', r));

  try {
    const res = await runHandsOnAgent({
      baseUrl: api.url,
      token,
      brief: '字符串 JSON 建片应自动补回需求原文',
      ledgerPath,
      endpoint: `http://127.0.0.1:${mockAgent.address().port}/v1`,
      apiKey: 'akey',
      model: 'hands-on-str-body',
    });
    assert.equal(res.status, 'done');
    assert.equal(res.calls.length, 4);
    assert.deepEqual([res.calls[0].status, res.calls[0].ok], [200, true]);
    assert.ok(createdFilmId);
    const meta = JSON.parse(readFileSync(join(dataDir, 'meta', `${createdFilmId}.json`), 'utf8'));
    assert.equal(meta.brief, '字符串 JSON 建片应自动补回需求原文');
    assert.deepEqual([res.calls[1].status, res.calls[1].ok, res.calls[1].code], [400, false, 'usage.bad-argument']);
    assert.deepEqual([res.calls[2].status, res.calls[2].ok, res.calls[2].code], [400, false, 'usage.bad-argument']);
    assert.deepEqual([res.calls[3].status, res.calls[3].ok, res.calls[3].code], [400, false, 'usage.bad-argument']);
  } finally {
    await api.close();
    await new Promise((r) => mockAgent.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('A19-19 [FIX-real-model] director 提示词包含 predicates.extra 语法、常用谓词名、patch/0.1 示例与防盲猜指引，shot-worker 起始上下文仍 <= 15,000 token', () => {
  const dp = DELEGATE_ROLES.director.systemPrompt;
  assert.match(dp, /predicates\.extra.*字符串数组/);
  assert.match(dp, /谓词名\(实参\)\s*\[比较\]\s*@\s*范围/);
  assert.match(dp, /\ball\b/);
  assert.match(dp, /shot\(s01\)/);
  for (const name of ['inside_frame', 'visible', 'text_matches', 'readable', 'margin_lr', 'margin_tb', 'bbox_w', 'bbox_h', 'at_rest', 'delivery']) {
    assert.ok(dp.includes(name), `director.systemPrompt 应列出常用已登记谓词 ${name}`);
  }
  assert.match(dp, /"format":"patch\/0\.1"/);
  assert.match(dp, /"path":"predicates\/extra"/);
  assert.match(dp, /\/v1\/schema\//);

  // shot-worker 提示词明示 JSON 对象 body，起始上下文仍严格 <= 15,000 token，且省略 budget.maxSteps 时默认展示 24
  assert.match(DELEGATE_ROLES['shot-worker'].systemPrompt, /JSON\s*对象/);
  const { film } = scaffold({ id: 'f_001', template: 'turntable' });
  const built = buildShotWorkerMessages({
    filmId: film.id,
    rev: 1,
    brief: '测试镜头工任务书',
    shot: film.shots[0],
    basePredicates: film.predicates.base,
  });
  assert.ok(built.startTokens <= SHOT_WORKER_MAX_START_TOKENS);
  assert.match(built.user, /最大工具循环步数（maxSteps）：`24`/);
});

test('A19-20 [FIX-real-model] runDelegateOrchestrator 默认 maxSteps 为 24（>12 步可完成、超 24 步在 step-24 停、显式传参严格生效）', async () => {
  const { film } = scaffold({ id: 'f_001', template: 'title', text: 'STEPS', output: { size: [320, 180], fps: '10/1', frames: 6 } });
  const mockApi = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    const url = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && url.pathname === '/v1/films/f_001/ledger') {
      res.end(JSON.stringify({ ok: true, data: { items: [] } }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/films/f_001/film') {
      res.end(JSON.stringify({ ok: true, data: { rev: 1, film: { ...film, shots: [] } } }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/films/f_001/deliver') {
      res.end(JSON.stringify({
        ok: true,
        data: { status: 'succeeded', rev: 1 },
        outputs: ['master', 'web', 'contact', 'report', 'run', 'lock'].map((k) => ({ kind: k, url: `/v1/films/f_001/artifacts/j_001/bundle/${k}` })),
      }));
      return;
    }
    res.end(JSON.stringify({ ok: true, data: {} }));
  });
  await new Promise((r) => mockApi.listen(0, '127.0.0.1', r));

  let directorToolSteps = 15;
  const mockModel = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sys = body.messages[0]?.content ?? '';
    const roleTag = /\[ROLE:([^\]]+)\]/.exec(sys)?.[1] ?? '';
    const tm = body.messages.filter((m) => m.role === 'tool');
    let msg;
    if (roleTag === 'director' && tm.length < directorToolSteps) {
      msg = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `s-${tm.length + 1}`, type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'GET', path: '/v1/guide' }) } }],
      };
    } else {
      msg = { role: 'assistant', content: '完成' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: msg }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  });
  await new Promise((r) => mockModel.listen(0, '127.0.0.1', r));

  const common = {
    baseUrl: `http://127.0.0.1:${mockApi.address().port}`,
    accountToken: 'acct',
    filmId: 'f_001',
    workspaceToken: 'ws',
    brief: '默认步数上限回归',
    endpoint: `http://127.0.0.1:${mockModel.address().port}/v1`,
    apiKey: 'key',
    directorModel: 'gemini-4-carbon',
    workerModel: 'gemini-4-argon',
    reserveTokens: 2_000,
  };

  try {
    // 1) 省略 maxSteps，导演走 15 步工具调用 + 1 步汇报（共 16 步 > 旧默认值 12）-> 成功
    directorToolSteps = 15;
    const pass16 = await runDelegateOrchestrator(common);
    assert.equal(pass16.status, 'succeeded');

    // 2) 省略 maxSteps，导演持续调用超过 24 步 -> 在 director:step-24 停止失败
    directorToolSteps = 30;
    const hitDefault = await runDelegateOrchestrator(common);
    assert.equal(hitDefault.status, 'failed');
    assert.equal(hitDefault.failedAt, 'director:step-24');

    // 3) 显式传入 maxSteps: 3 -> 严格在 director:step-3 停止失败
    const hitExplicit = await runDelegateOrchestrator({ ...common, maxSteps: 3 });
    assert.equal(hitExplicit.status, 'failed');
    assert.equal(hitExplicit.failedAt, 'director:step-3');
  } finally {
    await new Promise((r) => mockApi.close(r));
    await new Promise((r) => mockModel.close(r));
  }
});

test('A19-21 [FIX-real-model] 单片 L5 审片提示词省略 candidateGrades、自指 film.id 与空数组平滑归一化、未知/矛盾项严格拒收且多候选模式零回归', async () => {
  // 1) reviewer systemPrompt 明确 candidateGrades 仅多候选对比时填写、单片请省略或留空 []
  const rp = DELEGATE_ROLES.reviewer.systemPrompt;
  assert.match(rp, /candidateGrades/);
  assert.match(rp, /候选展示顺序|多候选/);
  assert.match(rp, /单片.*省略.*candidateGrades|省略\s*candidateGrades/);

  const dir = mkdtempSync(join(tmpdir(), 'bm-a19-21-'));
  const origFetch = globalThis.fetch;
  const film = { id: 'f_001', output: { frames: 20 }, shots: [{ id: 's01', in: 0, out: 20 }] };

  const makeReviewer = (name) => createOpenAiVisionReviewer({
    endpoint: 'https://fixture.invalid',
    apiKey: 'test-key',
    model: 'gpt-6.2-astra',
    ledgerPath: join(dir, `${name}.jsonl`),
  });

  try {
    // 2) 单片评审（candidates: []）：提示词明确要求省略 candidateGrades；自指 film.id（含匹配 grade / 省 grade / 带空格）与 [] 均平滑吸收并产出聚合意见
    const singlePrompts = [];
    globalThis.fetch = async (_, { body }) => {
      const req = JSON.parse(body);
      const sys = req.messages[0].content;
      const userText = req.messages[1].content[0].text;
      singlePrompts.push(userText);
      const perspective = /\[PERSPECTIVE:([^\]]+)\]/.exec(sys)?.[1];
      const voteNum = Number(/\[VOTE:(\d+)\]/.exec(sys)?.[1] ?? 1);
      let payload;
      if (perspective === 'composition-readability' && voteNum === 1) {
        payload = {
          grade: '一般',
          candidateGrades: [{ id: 'f_001', grade: '一般' }],
          opinions: [{ issueKey: 'title-readability', frames: [0, 5], severity: 'warn', evidence: '片名字号偏小', comment: '放大片名字号' }],
          suggestedPredicates: [],
        };
      } else if (perspective === 'composition-readability' && voteNum === 2) {
        // 省略顶层 grade，仅给出单片自指 candidateGrades（带首尾空白）-> 沿用其 grade
        payload = {
          candidateGrades: [{ id: ' f_001 ', grade: '一般' }],
          opinions: [{ issueKey: 'title-readability', frames: [0, 5], severity: 'warn', evidence: '片名边缘偏紧', comment: '增大片名留白' }],
          suggestedPredicates: [],
        };
      } else if (perspective === 'composition-readability' && voteNum === 3) {
        payload = { grade: '好', candidateGrades: [], opinions: [], suggestedPredicates: [] };
      } else if (perspective === 'motion-rhythm') {
        payload = { grade: '好', candidateGrades: [{ id: 'f_001', grade: '好' }], opinions: [], suggestedPredicates: [] };
      } else {
        payload = { grade: '一般', opinions: [], suggestedPredicates: [] };
      }
      return Response.json({
        model: 'gpt-6.2-astra',
        choices: [{ message: { content: JSON.stringify(payload) } }],
        usage: { prompt_tokens: 120, completion_tokens: 45 },
      });
    };

    const singleOk = await layerL5({
      film,
      filmId: 'f_001',
      images: [],
      reviewer: makeReviewer('single-ok'),
      candidates: [],
    });
    assert.equal(singlePrompts.length, 9);
    for (const txt of singlePrompts) {
      assert.ok(!txt.includes('候选展示顺序'), '单片评审提示词不应包含候选展示顺序');
      assert.match(txt, /本次为单片评审.*省略\s*candidateGrades/);
    }
    assert.equal(singleOk.status, 'ok');
    assert.equal(singleOk.totalBallots, 9);
    assert.equal(singleOk.invalidBallots, undefined);
    assert.equal(singleOk.grade, '一般');
    assert.deepEqual(singleOk.gradeCounts, { 好: 4, 一般: 5, 差: 0 });
    assert.deepEqual(singleOk.candidateGrades, {});
    assert.ok(singleOk.ballots.every((b) => b.candidateGrades === undefined), '单片归一化后选票不得残留 candidateGrades 字段');
    const adoptedVote = singleOk.ballots.find((b) => b.perspective === 'composition-readability' && b.voteIndex === 1);
    assert.equal(adoptedVote?.grade, '一般', '省略顶层 grade 时应沿用自指 candidateGrades[0].grade');
    assert.equal(singleOk.opinions.length, 1);
    assert.equal(singleOk.opinions[0].issueKey, 'title-readability');
    assert.equal(singleOk.opinions[0].votes, 2);

    // 3a) 单片评审：未知候选 ID 'ghost' 仍严格拒收
    globalThis.fetch = async () => Response.json({
      model: 'gpt-6.2-astra',
      choices: [{ message: { content: JSON.stringify({ grade: '好', candidateGrades: [{ id: 'ghost', grade: '好' }], opinions: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    });
    const ghostRes = await layerL5({ film, filmId: 'f_001', images: [], reviewer: makeReviewer('ghost'), candidates: [] });
    assert.equal(ghostRes.status, 'failed');
    assert.equal(ghostRes.invalidBallots?.length, 9);
    assert.ok(ghostRes.invalidBallots.every((b) => /审片选票包含未知候选 ID：ghost/.test(b.reason)));

    // 3b) 单片评审：顶层 grade 与自指 candidateGrades[0].grade 互相矛盾时严格拒收
    globalThis.fetch = async () => Response.json({
      model: 'gpt-6.2-astra',
      choices: [{ message: { content: JSON.stringify({ grade: '好', candidateGrades: [{ id: 'f_001', grade: '差' }], opinions: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    });
    const conflictRes = await layerL5({ film, filmId: 'f_001', images: [], reviewer: makeReviewer('conflict'), candidates: [] });
    assert.equal(conflictRes.status, 'failed');
    assert.equal(conflictRes.invalidBallots?.length, 9);
    assert.ok(conflictRes.invalidBallots.every((b) => /矛盾|不一致/.test(b.reason)));

    // 3c) 单片评审：>= 2 个候选条目（含异 ID 双条目或重复自指双条目）仍严格拒收
    for (const [tag, cg] of [
      ['two-mixed', [{ id: 'f_001', grade: '好' }, { id: 'ghost', grade: '差' }]],
      ['two-dup-self', [{ id: 'f_001', grade: '好' }, { id: 'f_001', grade: '好' }]],
    ]) {
      globalThis.fetch = async () => Response.json({
        model: 'gpt-6.2-astra',
        choices: [{ message: { content: JSON.stringify({ grade: '好', candidateGrades: cg, opinions: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      });
      const multiEntryRes = await layerL5({ film, filmId: 'f_001', images: [], reviewer: makeReviewer(tag), candidates: [] });
      assert.equal(multiEntryRes.status, 'failed', `${tag} 必须拒收`);
      assert.equal(multiEntryRes.invalidBallots?.length, 9);
      assert.ok(multiEntryRes.invalidBallots.every((b) => /审片选票包含未知候选 ID：/.test(b.reason)));
    }

    // 3d) 无 resolvedFilmId 时不得误判为自指，仍严格拒收
    globalThis.fetch = async () => Response.json({
      model: 'gpt-6.2-astra',
      choices: [{ message: { content: JSON.stringify({ grade: '一般', candidateGrades: [{ id: 'f_001', grade: '一般' }], opinions: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    });
    const noIdRes = await layerL5({
      film: { output: { frames: 20 }, shots: [] },
      images: [],
      reviewer: makeReviewer('no-id'),
      candidates: [],
    });
    assert.equal(noIdRes.status, 'failed');
    assert.equal(noIdRes.invalidBallots?.length, 9);
    assert.ok(noIdRes.invalidBallots.every((b) => /审片选票包含未知候选 ID：f_001/.test(b.reason)));

    // 4) 多候选模式（candidates: ['a', 'b']）提示词与严格校验零回归（含误填 film.id 仍拒收）
    const multiPrompts = [];
    globalThis.fetch = async (_, { body }) => {
      const req = JSON.parse(body);
      const userText = req.messages[1].content[0].text;
      multiPrompts.push(userText);
      return Response.json({
        model: 'gpt-6.2-astra',
        choices: [{ message: { content: JSON.stringify({ grade: '好', candidateGrades: [{ id: 'a', grade: '好' }, { id: 'b', grade: '一般' }], opinions: [] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      });
    };
    const multiOk = await layerL5({
      film,
      filmId: 'f_001',
      images: [],
      reviewer: makeReviewer('multi-ok'),
      candidates: ['a', 'b'],
    });
    assert.equal(multiOk.status, 'ok');
    assert.equal(multiOk.totalBallots, 9);
    assert.equal(multiOk.invalidBallots, undefined);
    assert.equal(multiOk.candidateGrades.a.grade, '好');
    assert.equal(multiOk.candidateGrades.b.grade, '一般');
    assert.ok(multiPrompts.every((txt) => /候选展示顺序/.test(txt) && /candidateGrades 仅填写以上候选 ID/.test(txt)));

    globalThis.fetch = async () => Response.json({
      model: 'gpt-6.2-astra',
      choices: [{ message: { content: JSON.stringify({ grade: '好', candidateGrades: [{ id: 'f_001', grade: '好' }], opinions: [] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    });
    const multiSelfReject = await layerL5({
      film,
      filmId: 'f_001',
      images: [],
      reviewer: makeReviewer('multi-self-reject'),
      candidates: ['a', 'b'],
    });
    assert.equal(multiSelfReject.status, 'failed');
    assert.equal(multiSelfReject.invalidBallots?.length, 9);
    assert.ok(multiSelfReject.invalidBallots.every((b) => /审片选票包含未知候选 ID：f_001/.test(b.reason)));
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A19-22 [FIX-real-model] shot-worker allowedVerbs 开放 artifacts 只读、systemPrompt 引导 observe/sheet + GET 看图且起始 token 远低于 15,000', () => {
  const sw = DELEGATE_ROLES['shot-worker'];
  assert.ok(Object.isFrozen(sw.allowedVerbs));
  assert.ok(
    sw.allowedVerbs.includes('GET /v1/films/{id}/artifacts/{name}'),
    'shot-worker.allowedVerbs 必须包含 GET /v1/films/{id}/artifacts/{name}',
  );
  assert.match(sw.systemPrompt, /POST\s+\/v1\/films\/\{id\}\/observe\/sheet/);
  assert.match(sw.systemPrompt, /outputs\[\]\.url/);
  assert.match(sw.systemPrompt, /GET/);
  assert.match(sw.systemPrompt, /构图.*文字清晰度.*入场动效|联系表/);
  assert.match(sw.systemPrompt, /cards\/title\/params\/heightFrac/);
  assert.match(sw.systemPrompt, /observe\/query.*framing.*entities/);
  assert.match(DELEGATE_ROLES.director.systemPrompt, /暂勿写入\s+predicates\.extra.*text_matches.*OCR/);

  const library = loadCardLibrary();
  const realCards = Object.values(library).map((x) => x.card);
  for (const template of ['title', 'turntable']) {
    const { film } = scaffold({ id: 'f_001', template });
    for (const shot of film.shots) {
      const built = buildShotWorkerMessages({
        filmId: film.id,
        rev: 1,
        brief: '测试镜头工看图引导后的起始上下文 token 余量',
        shot,
        basePredicates: film.predicates.base,
        extraPredicates: ['inside_frame(hero, margin=0.05) @ all'],
        cards: realCards,
      });
      assert.ok(
        built.startTokens < 6_000 && built.startTokens <= SHOT_WORKER_MAX_START_TOKENS,
        `${template}/${shot.id} 起始上下文 (${built.startTokens}) 应远低于 ${SHOT_WORKER_MAX_START_TOKENS}`,
      );
    }
  }
});

test('A19-23 [R1 收口] 150s 墙钟预算守卫、严格 JSON 解包（拒重复键与非 JSON 空白）、显式空串/string-null-brief 拒收与作业体 null 拒收', async () => {
  // 1) 严格 JSON 解包：拒绝重复键与 U+00A0 非 JSON 空白（原样保留交服务端拒收），同时兼容合法对象与数组
  const dupStr = '{"brief":2,"brief":"片名"}';
  const nbspStr = '\u00A0{"tier":"draft"}';
  assert.equal(normalizeJsonToolBody('/v1/films', dupStr), dupStr, '重复键 JSON 字符串不得经 JSON.parse 折叠');
  assert.equal(normalizeJsonToolBody('/v1/films/f_001/render', nbspStr), nbspStr, '含 U+00A0 前导空白的字符串不得被 trim 解包');
  assert.deepEqual(normalizeJsonToolBody('/v1/cards/search', ' \t{"q":"title"}\r\n'), { q: 'title' });
  assert.deepEqual(normalizeJsonToolBody('/v1/films/f_001/observe/metrics', '["deliverSpec"]'), ['deliverSpec']);
  assert.equal(normalizeJsonToolBody('/v1/films/f_001/observe/metrics', '[{"a":1,"a":2}]'), '[{"a":1,"a":2}]');

  // 2) 真实 startServer + runHandsOnAgent：重复键、U+00A0 空白、显式空串 "" 与字符串 '{"brief":null}' 均须被服务端 400 拒收
  const dataDir = mkdtempSync(join(tmpdir(), 'bm-a19-23-r1-'));
  const ledgerPath = join(dataDir, 'agent-ledger.jsonl');
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0 });
  let round = 0;
  const mockAgent = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    round++;
    const msg = round === 1
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'r1-dup', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films', body: dupStr }) } },
            { id: 'r1-nbsp', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films', body: '\u00A0{"template":"title"}' }) } },
            { id: 'r1-empty', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films', body: '' }) } },
            { id: 'r1-null-brief', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films', body: '{"brief":null}' }) } },
          ],
        }
      : { role: 'assistant', content: '完成' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'r1-strict-check', choices: [{ message: msg }], usage: { prompt_tokens: 40, completion_tokens: 10 } }));
  });
  await new Promise((r) => mockAgent.listen(0, '127.0.0.1', r));

  // 3) 委托作业合并拒收显式 body: null（覆盖 shot-worker render:null 与 finalizer deliver:null 两条真实路径）
  let deliverReachedDuringNullCall = false;
  let deliverNullSawStep2 = false;
  let renderNullReached = false;
  let finalizerCalled = false;
  let deliverCallCount = 0;
  const { film } = scaffold({ id: 'f_001', template: 'title', text: 'NULLTEST', output: { size: [320, 180], fps: '10/1', frames: 6 } });
  const mockDelegateApi = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && url.pathname === '/v1/films/f_001/ledger') return res.end(JSON.stringify({ ok: true, data: { items: [] } }));
    if (req.method === 'GET' && url.pathname === '/v1/films/f_001/film') return res.end(JSON.stringify({ ok: true, data: { rev: 1, film } }));
    if (req.method === 'POST' && url.pathname === '/v1/films/f_001/render') {
      if (!raw || raw === 'null') renderNullReached = true;
      return res.end(JSON.stringify({ ok: true, data: { status: 'succeeded', rev: 1 }, outputs: [] }));
    }
    if (req.method === 'POST' && url.pathname === '/v1/films/f_001/verify') {
      return res.end(JSON.stringify({ ok: true, data: { status: 'succeeded', rev: 1 }, outputs: [] }));
    }
    if (req.method === 'POST' && url.pathname === '/v1/films/f_001/deliver') {
      deliverCallCount++;
      if (!deliverNullSawStep2) deliverReachedDuringNullCall = true;
      return res.end(JSON.stringify({ ok: true, data: { status: 'succeeded', rev: 1 }, outputs: [] }));
    }
    res.end(JSON.stringify({ ok: true, data: { rev: 1 } }));
  });
  await new Promise((r) => mockDelegateApi.listen(0, '127.0.0.1', r));

  const toolRepliesByRole = { worker: [], finalizer: [] };
  let workerStep = 0;
  let finalizerStep = 0;
  const mockDelegateModel = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sys = body.messages[0]?.content ?? '';
    const last = body.messages.at(-1);
    let msg;
    if (sys.startsWith('[ROLE:director]')) {
      msg = { role: 'assistant', content: '导演完成' };
    } else if (sys.startsWith('[ROLE:shot-worker:')) {
      if (last?.role === 'tool') toolRepliesByRole.worker.push(JSON.parse(last.content));
      workerStep++;
      if (workerStep === 1) {
        msg = { role: 'assistant', content: null, tool_calls: [{ id: 'w-null', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films/f_001/render', body: null }) } }] };
      } else if (workerStep === 2) {
        msg = { role: 'assistant', content: null, tool_calls: [{ id: 'w-r', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films/f_001/render', body: { tier: 'draft' } }) } }] };
      } else if (workerStep === 3) {
        msg = { role: 'assistant', content: null, tool_calls: [{ id: 'w-v', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films/f_001/verify', body: {} }) } }] };
      } else {
        msg = { role: 'assistant', content: '镜头完成' };
      }
    } else {
      finalizerCalled = true;
      if (last?.role === 'tool') {
        deliverNullSawStep2 = true;
        toolRepliesByRole.finalizer.push(JSON.parse(last.content));
      }
      finalizerStep++;
      msg = finalizerStep === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'f-d', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films/f_001/deliver', body: null }) } }] }
        : { role: 'assistant', content: '收尾结束' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'r1-null-check', choices: [{ message: msg }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
  });
  await new Promise((r) => mockDelegateModel.listen(0, '127.0.0.1', r));

  // 4) wallSeconds: 150 与边界 240 均须为模型调用登记 < MODEL_TIMEOUT_MS 的预算截止信号并以 stopped / wallSeconds 收口
  const origTimeout = AbortSignal.timeout;
  const recordedTimeouts = [];
  const wallController = new AbortController();
  const mockSlowModel = createServer(async (req, res) => {
    req.on('close', () => { if (!res.writableEnded) res.end(); });
  });
  await new Promise((r) => mockSlowModel.listen(0, '127.0.0.1', r));

  try {
    const ho = await runHandsOnAgent({
      baseUrl: api.url,
      token,
      brief: '原需求',
      ledgerPath,
      endpoint: `http://127.0.0.1:${mockAgent.address().port}/v1`,
      apiKey: 'akey',
      model: 'r1-strict-check',
    });
    assert.equal(ho.status, 'done');
    assert.equal(ho.calls.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.deepEqual([ho.calls[i].status, ho.calls[i].ok, ho.calls[i].code], [400, false, 'usage.bad-argument'], `第 ${i + 1} 个非法字符串体必须被服务端拒收`);
    }

    await runDelegateOrchestrator({
      baseUrl: `http://127.0.0.1:${mockDelegateApi.address().port}`,
      filmId: 'f_001',
      workspaceToken: 'ws',
      brief: '测显式 null 作业体',
      budget: { tokens: 50000, gpuSeconds: 60, wallSeconds: 60 },
      endpoint: `http://127.0.0.1:${mockDelegateModel.address().port}/v1`,
      apiKey: 'akey',
      directorModel: 'r1-null-check',
      workerModel: 'r1-null-check',
      maxSteps: 6,
    });
    assert.equal(renderNullReached, false, 'render 显式 body: null 不得放行至服务端');
    assert.equal(finalizerCalled, true, '必须真实进入收尾员阶段验证 deliver body: null');
    assert.equal(deliverReachedDuringNullCall, false, '收尾员显式 body: null 调 deliver 时不得放行至服务端');
    assert.equal(deliverCallCount, 1, '仅允许收尾后兜底调用以合法对象 {tier:"final"} 到达服务端，显式 null 那次必须被拦截');
    assert.ok(toolRepliesByRole.worker.some((r) => typeof r.refused === 'string' && r.refused.includes('render') && r.refused.includes('JSON 对象')));
    assert.ok(toolRepliesByRole.finalizer.some((r) => typeof r.refused === 'string' && r.refused.includes('deliver') && r.refused.includes('JSON 对象')));

    for (const wallSec of [150, 240]) {
      recordedTimeouts.length = 0;
      AbortSignal.timeout = (ms) => {
        recordedTimeouts.push(ms);
        if (ms > 120_000 && ms < 240_000) {
          const ac = new AbortController();
          queueMicrotask(() => ac.abort(new DOMException(`wallSeconds ${wallSec} deadline`, 'TimeoutError')));
          return ac.signal;
        }
        return origTimeout(ms);
      };
      const wallRes = await runDelegateOrchestrator({
        baseUrl: `http://127.0.0.1:${mockDelegateApi.address().port}`,
        filmId: 'f_001',
        workspaceToken: 'ws',
        brief: `测 ${wallSec} 秒墙钟预算截止`,
        budget: { tokens: 50000, gpuSeconds: 60, wallSeconds: wallSec },
        endpoint: `http://127.0.0.1:${mockSlowModel.address().port}/v1`,
        apiKey: 'akey',
        directorModel: 'r1-slow',
        workerModel: 'r1-slow',
        signal: wallController.signal,
      });
      assert.equal(wallRes.status, 'stopped', `wallSeconds=${wallSec} 必须 stopped`);
      assert.equal(wallRes.stoppedReason, 'wallSeconds', `wallSeconds=${wallSec} 必须 stoppedReason=wallSeconds`);
      assert.ok(
        recordedTimeouts.some((ms) => ms > 120_000 && ms < 240_000 && ms <= wallSec * 1000),
        `wallSeconds=${wallSec} 必须登记严格小于 240000ms 的截止信号，实际: ${JSON.stringify(recordedTimeouts)}`,
      );
    }
  } finally {
    AbortSignal.timeout = origTimeout;
    await api.close();
    await new Promise((r) => mockAgent.close(r));
    await new Promise((r) => mockDelegateApi.close(r));
    await new Promise((r) => mockDelegateModel.close(r));
    await new Promise((r) => mockSlowModel.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('A19-24: normalizeJsonToolBody 边界（孤立代理码元直击真实 server 400、防包壳注入与 128 层数组深度）', async () => {
  const loneHigh = '{"brief":"bad\uD800str"}';
  const loneLow = '{"brief":"bad\uDC00str"}';
  assert.equal(normalizeJsonToolBody('/v1/films', loneHigh), loneHigh, '含孤立高代理的对象串不得解包');
  assert.equal(normalizeJsonToolBody('/v1/films', loneLow), loneLow, '含孤立低代理的对象串不得解包');
  assert.equal(normalizeJsonToolBody('/v1/films', '["\\uD800"]'), '["\\uD800"]', '含转义孤立代理的数组串不得解包');

  // 防止 {"_":...} 包壳注入把非法的 [ ],"extra":[] 当合法数组解包
  const wrappedBypass = '[],"extra":[]';
  assert.equal(normalizeJsonToolBody('/v1/films', wrappedBypass), wrappedBypass, '[],"extra":[] 不得绕过包壳解包');

  // 嵌套数组内对象重复键不得解包
  const dupInArr = '[{"a":1,"a":2}]';
  assert.equal(normalizeJsonToolBody('/v1/films', dupInArr), dupInArr, '数组内嵌套对象重复键不得解包');
  assert.deepEqual(
    normalizeJsonToolBody('/v1/films', '[{"a":1,"b":[2,{"c":3}],"d":4}]'),
    [{ a: 1, b: [2, { c: 3 }], d: 4 }],
    '数组内无重复键合法嵌套对象须正常解包',
  );

  // 128 层空数组应按不包壳真实深度解包，129 层超限保留原串；超过 2 MiB（<= 16 MiB，与 parseRequestText 同口径）的合法数组须正常解包
  const depth128 = '['.repeat(128) + ']'.repeat(128);
  const depth129 = '['.repeat(129) + ']'.repeat(129);
  assert.ok(Array.isArray(normalizeJsonToolBody('/v1/films', depth128)), '128 层空数组须解包为数组');
  assert.equal(normalizeJsonToolBody('/v1/films', depth129), depth129, '129 层空数组超限须保留原串');
  const over2MiBArr = `["${'x'.repeat(2 * 1024 * 1024 + 16)}"]`;
  assert.deepEqual(normalizeJsonToolBody('/v1/films', over2MiBArr), ['x'.repeat(2 * 1024 * 1024 + 16)], '2 MiB 以上（<= 16 MiB）合法数组须按 parseRequestText 同口径解包');

  // 真实 POST /v1/films：含孤立代理码元（高/低代理）的字符串体经 callApi 发送不得被 fetch 静默替换为 U+FFFD，必须返回 400
  const dataDir = mkdtempSync(join(tmpdir(), 'a19-24-surrogate-'));
  const ledgerPath = join(dataDir, 'agent-ledger.jsonl');
  const token = issueAccountToken(dataDir);
  const api = await startServer({ dataDir, port: 0 });
  let round = 0;
  const mockAgent = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    round++;
    const msg = round === 1
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc_surr_hi', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films', body: loneHigh }) } },
            { id: 'tc_surr_lo', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films', body: loneLow }) } },
            { id: 'tc_wrap_inj', type: 'function', function: { name: 'http_request', arguments: JSON.stringify({ method: 'POST', path: '/v1/films', body: wrappedBypass }) } },
          ],
        }
      : { role: 'assistant', content: 'done' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'r2-surrogate', choices: [{ message: msg }], usage: { prompt_tokens: 40, completion_tokens: 10 } }));
  });
  await new Promise((r) => mockAgent.listen(0, '127.0.0.1', r));
  try {
    const res = await runHandsOnAgent({
      baseUrl: api.url,
      token,
      brief: '测孤立代理不被静默替换',
      ledgerPath,
      endpoint: `http://127.0.0.1:${mockAgent.address().port}/v1`,
      apiKey: 'akey',
      model: 'r2-surrogate',
      maxSteps: 4,
    });
    assert.equal(res.calls.length, 3);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual([res.calls[i].status, res.calls[i].ok, res.calls[i].code], [400, false, 'usage.bad-argument'], `第 ${i + 1} 个非法字符串体必须被真实服务端 400 拒收`);
    }
  } finally {
    await api.close();
    await new Promise((r) => mockAgent.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});



