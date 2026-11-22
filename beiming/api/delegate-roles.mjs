// 委托模式三角色（导演 / 镜头工 / 审片人）配置、镜头工五段任务书构造与 15,000 token 起始上下文守卫、
// 服务端确定性模板判定（selectDelegateTemplate），以及 L5 三视角九票聚合与建议谓词 L1 过滤。
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { checkL1 } from '../verify/l1.mjs';
import {
  FLOOR,
  checkExtra,
  enforcePredicateFloor,
  scopeRange,
} from '../verify/predicates.mjs';
import { HTTP_TOOL } from './agents.mjs';

export const SHOT_WORKER_MAX_START_TOKENS = 15_000;

export const L5_GRADES = Object.freeze(['好', '一般', '差']);

export const L5_PERSPECTIVES = Object.freeze([
  Object.freeze({
    id: 'composition-readability',
    title: '构图与可读',
    votes: 3,
    focus: '检查主体位置、屏占比、四边留白余量、片名与字幕可读性及视觉重心。',
  }),
  Object.freeze({
    id: 'motion-rhythm',
    title: '动作与节奏',
    votes: 3,
    focus: '检查相机与主体运动平滑度、速度曲线、切点时机、刻意冻结段合理性与音画同步。',
  }),
  Object.freeze({
    id: 'look-consistency',
    title: '质感与一致性',
    votes: 3,
    focus: '检查材质高光、布光对比、色彩基调一致性、切点前后亮度跳变与画面伪影。',
  }),
]);

export const DELEGATE_ROLES = Object.freeze({
  director: Object.freeze({
    role: 'director',
    title: '导演',
    allowedVerbs: Object.freeze([
      'GET /v1/guide',
      'POST /v1/cards/search',
      'POST /v1/assets/search',
      'GET /v1/cards/{id}',
      'GET /v1/schema/{name}',
      'GET /v1/films/{id}/film',
      'PUT /v1/films/{id}/film',
    ]),
    systemPrompt: [
      '你是北冥委托编排的导演（director）。你只能通过 http_request 调用本服务开放给导演的 /v1/* 接口。',
      '工作规程：',
      '1. 先调 GET /v1/guide 与 GET /v1/films/{id}/film 读取当前片子脚手架（模板已由服务器按需求与资产确定性选定）与修订号 rev；按需调 POST /v1/cards/search 或 POST /v1/assets/search 检索技术卡与资产。',
      '2. 先写断言再排镜头：先把需求转化为可核验的追加谓词写入 predicates.extra（不得削弱 predicates.base 的 floor@1 底线），再排定 shots 镜头表、卡参数与文案。',
      '3. 用 PUT /v1/films/{id}/film 提交 patch/0.1（带最新 rev）更新 predicates.extra、shots 与 title；若收到 L1 诊断或机器修法，照提示修正，完成后用一段话总结导演方案。',
    ].join('\n'),
  }),
  'shot-worker': Object.freeze({
    role: 'shot-worker',
    title: '镜头工',
    freshSessionPerShot: true,
    maxStartTokens: SHOT_WORKER_MAX_START_TOKENS,
    sections: Object.freeze(['1. 镜头条目', '2. 基础谓词', '3. 可用的卡', '4. 预算', '5. 汇报格式']),
    allowedVerbs: Object.freeze([
      'GET /v1/films/{id}/film',
      'PUT /v1/films/{id}/film (shots/<shotId>/*)',
      'POST /v1/films/{id}/render',
      'POST /v1/films/{id}/verify',
      'POST /v1/films/{id}/observe/query',
      'POST /v1/films/{id}/observe/sheet',
      'POST /v1/cards/search',
      'GET /v1/cards/{id}',
    ]),
    systemPrompt: [
      '你是北冥委托编排的镜头工（shot-worker）。每个镜头使用全新独立会话，起始上下文严格受 15,000 token 上限约束。',
      '工作规程：',
      '1. 仔细阅读五段任务书（1. 镜头条目、2. 基础谓词、3. 可用的卡、4. 预算、5. 汇报格式）。你只负责当前指定镜头，修改片子时只能提交 patch/0.1（带最新 rev）且全部 ops.path 必须落在 shots/<shotId>/ 下。',
      '2. 调 POST /v1/films/{id}/render（tier: "draft"）出本镜头草稿，再调 POST /v1/films/{id}/verify 核验；工具会等到子作业终态。',
      '3. 若核验未过，可调 observe/query 或 observe/sheet 排查并用 patch/0.1 调整 shots/<shotId>/ 参数后重渲重验；通过后按「5. 汇报格式」输出四项结论。',
    ].join('\n'),
  }),
  reviewer: Object.freeze({
    role: 'reviewer',
    title: '异族视觉审片人',
    perspectives: L5_PERSPECTIVES,
    votesPerPerspective: 3,
    totalBallots: 9,
    quorum: 2,
    grades: L5_GRADES,
    overridesHardGates: false,
    systemPrompt: [
      '你是北冥 L5 异族视觉审片人（reviewer）。按当前指定视角审视需求原文、联系表、切点条带与声音量测表，给出等级词评价（好 / 一般 / 差）与具体问题意见。',
      '每条意见必须指明全片整数帧区间 frames: [start, end]、严重度 severity（info|warn|error 或 low|medium|high）、画面或量测证据 evidence 与改进建议 comment；可选附带 issueKey 与建议谓词 suggestedPredicates。',
      '只回一个合法 JSON 对象：{"grade":"好|一般|差","candidateGrades":[{"id":"候选ID","grade":"好|一般|差"}],"opinions":[{"issueKey":"问题标识","frames":[起帧,止帧],"severity":"info|warn|error","evidence":"具体画面证据","comment":"改进意见","suggestedPredicate":"可选建议断言"}],"suggestedPredicates":["谓词断言"]}。',
      '没有意见时 opinions 是空数组。不要回 JSON 以外的字。L5 审片结论仅供参考，绝不推翻 L1–L4 硬门结论。',
    ].join('\n'),
  }),
});

const VALID_SEVERITIES = ['low', 'medium', 'high', 'info', 'warn', 'error'];
const SEVERITY_RANK = { info: 1, low: 1, warn: 2, medium: 2, error: 3, high: 3 };

function badArg(message) {
  return Object.assign(new Error(message), { code: 'usage.bad-argument' });
}

/** 递归校验纯数据入参：拦截 Proxy 与 getter/setter 访问器属性，防止触发副作用陷阱。 */
export function assertSafeData(value, label = 'input', seen = new Set()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (isProxy(value)) throw badArg(`${label} 不接受 Proxy 对象`);
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    const descs = Object.getOwnPropertyDescriptors(value);
    for (const [k, d] of Object.entries(descs)) {
      if (d.get || d.set) throw badArg(`${label}[${k}] 不接受 getter/setter 访问器属性`);
    }
    for (let i = 0; i < value.length; i++) assertSafeData(value[i], `${label}[${i}]`, seen);
    return value;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw badArg(`${label} 必须是纯数据对象`);
  }
  const descs = Object.getOwnPropertyDescriptors(value);
  for (const [k, d] of Object.entries(descs)) {
    if (d.get || d.set || !Object.hasOwn(d, 'value')) {
      throw badArg(`${label}.${k} 不接受 getter/setter 访问器属性`);
    }
    assertSafeData(d.value, `${label}.${k}`, seen);
  }
  return value;
}

function clipText(text, maxChars) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** 按仓库统一的保守口径 ceil(utf8Bytes / 3.5) 计量镜头工会话起始上下文 token 数。 */
export function measureStartContextTokens({ system = '', user = '', tools = [HTTP_TOOL] } = {}) {
  assertSafeData({ system, user, tools }, 'measureStartContextTokens');
  const serialized = JSON.stringify({
    system: String(system ?? ''),
    user: String(user ?? ''),
    tools: Array.isArray(tools) ? tools : [HTTP_TOOL],
  });
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / 3.5);
}

function summarizeCard(card, { titleLimit, intentLimit, paramLimit }) {
  if (!card || typeof card !== 'object') return null;
  const id = typeof card.id === 'string' ? card.id : (typeof card.use === 'string' ? card.use : 'unknown');
  const major = typeof card.version === 'string' ? card.version.split('.')[0] : '1';
  const ref = id.includes('@') ? id : `${id}@${major}`;
  const title = card.title ? clipText(card.title, titleLimit) : '';
  const intent = card.intent ? clipText(card.intent, intentLimit) : '';
  const paramKeys = card.params && typeof card.params === 'object'
    ? Object.keys(card.params).slice(0, paramLimit)
    : [];
  const parts = [`- \`${ref}\``];
  if (title) parts.push(title);
  if (intent) parts.push(`用途：${intent}`);
  if (paramKeys.length) parts.push(`参数：${paramKeys.join(', ')}`);
  return parts.join(' | ');
}

function formatShotWorkerSections({
  filmId,
  rev,
  brief,
  assets,
  shot,
  basePredicates,
  extraPredicates,
  cards,
  budget,
  profile,
}) {
  const shotId = shot.id;
  const compactShot = {
    id: shot.id,
    in: shot.in,
    out: shot.out,
    source: shot.source,
    host: shot.host,
    mode: shot.mode,
    colorRef: shot.colorRef,
    ...(shot.seed !== undefined ? { seed: shot.seed } : {}),
    ...(shot.assets ? { assets: shot.assets } : {}),
    ...(shot.roles ? { roles: shot.roles } : {}),
    ...(Array.isArray(shot.cards)
      ? {
          cards: shot.cards.slice(0, profile.maxShotCards).map((c) => ({
            as: c.as,
            use: c.use,
            params: c.params,
          })),
        }
      : {}),
    ...(shot.tiers ? { tiers: shot.tiers } : {}),
    ...(shot.deliberate ? { deliberate: shot.deliberate } : {}),
  };
  let shotJson = JSON.stringify(compactShot, null, 2);
  if (shotJson.length > profile.maxShotJsonChars) {
    shotJson = `${shotJson.slice(0, profile.maxShotJsonChars)}\n  /* ...已截断长参数... */\n}`;
  }

  const baseRefs = Array.isArray(basePredicates) && basePredicates.length ? basePredicates : ['floor@1'];
  const floorExprs = FLOOR?.items?.map((it) => `  - \`${it.expr}\``) ?? [];
  const extras = Array.isArray(extraPredicates) ? extraPredicates : [];
  const shownExtras = extras.slice(0, profile.maxExtras).map((x) => `  - \`${clipText(x, profile.maxPredChars)}\``);
  if (extras.length > shownExtras.length) {
    shownExtras.push(`  - （其余 ${extras.length - shownExtras.length} 条追加断言已折叠）`);
  }

  const boundCards = Array.isArray(shot.cards)
    ? shot.cards.map((c) => `- 已绑定实例 \`${c.as}\` → \`${c.use}\``)
    : [];
  const candidateCards = (Array.isArray(cards) ? cards : [])
    .slice(0, profile.maxCards)
    .map((c) => summarizeCard(c, profile))
    .filter(Boolean);
  const moreCards = Array.isArray(cards) && cards.length > profile.maxCards
    ? [`- （其余 ${cards.length - profile.maxCards} 张候选卡已按 15,000 token 预算裁剪，可按需调 POST /v1/cards/search）`]
    : [];

  const b = budget && typeof budget === 'object' ? budget : {};
  const tokensText = Number.isFinite(b.tokens) ? b.tokens : 1_200_000;
  const gpuText = Number.isFinite(b.gpuSeconds) ? `${b.gpuSeconds}s` : '未限（受整片配额约束）';
  const wallText = Number.isFinite(b.wallSeconds) ? `${b.wallSeconds}s` : '未限（受整片配额约束）';
  const stepsText = Number.isFinite(b.maxSteps) ? b.maxSteps : 12;

  return [
    `# 镜头工任务书（片子 ${filmId} · 镜头 ${shotId}）`,
    '',
    '## 1. 镜头条目',
    `- 片子标识：\`${filmId}\`（当前修订 \`rev=${rev}\`）`,
    `- 镜头标识：\`${shotId}\`，全片帧区间：\`[${shot.in}, ${shot.out})\`（共 ${Math.max(0, (shot.out ?? 0) - (shot.in ?? 0))} 帧）`,
    `- 写入权限边界：只允许用 \`patch/0.1\`（带最新 \`rev\`）修改 \`shots/${shotId}/\` 下的路径，禁止改动其他镜头或全片只读字段`,
    `- 需求摘要：${clipText(brief || '按片子描述完成本镜头渲染与核验', profile.maxBriefChars)}`,
    ...(Array.isArray(assets) && assets.length ? [`- 素材引用：${clipText(JSON.stringify(assets), 300)}`] : []),
    '```json',
    shotJson,
    '```',
    '',
    '## 2. 基础谓词',
    `- 基础谓词引用（\`predicates.base\`，只读）：${baseRefs.map((r) => `\`${r}\``).join('、')}`,
    ...floorExprs,
    `- 导演追加谓词（\`predicates.extra\`）：${shownExtras.length ? '' : '（无）'}`,
    ...shownExtras,
    '',
    '## 3. 可用的卡',
    ...(boundCards.length ? boundCards : ['- 当前镜头未预绑卡实例']),
    ...(candidateCards.length ? candidateCards : ['- 可通过 `POST /v1/cards/search` 检索候选技术卡']),
    ...moreCards,
    '',
    '## 4. 预算',
    `- 起始上下文硬上限：\`<= ${SHOT_WORKER_MAX_START_TOKENS} tokens\``,
    `- 可用 Token 预算上限：\`${tokensText}\``,
    `- 显卡秒预算（gpuSeconds）：\`${gpuText}\``,
    `- 墙钟秒预算（wallSeconds）：\`${wallText}\``,
    `- 最大工具循环步数（maxSteps）：\`${stepsText}\``,
    '',
    '## 5. 汇报格式',
    '完成本镜头 `POST render`（`tier: "draft"`）与 `POST verify` 并确认通过后，按以下四项结构汇报：',
    '- 状态：`pass` 或 `fail`',
    '- 修订号：`rev=<最终核验通过的修订号>`',
    '- 草稿渲染与核验摘要：说明本镜头草稿渲染帧数与 L1–L3 核验结果',
    '- 遗留问题：若全部通过写 `无`；若未通过列出具体诊断码与帧号',
  ].join('\n');
}

const COMPACTION_PROFILES = [
  { maxBriefChars: 1200, maxShotJsonChars: 4000, maxShotCards: 12, maxExtras: 24, maxPredChars: 160, maxCards: 16, titleLimit: 60, intentLimit: 120, paramLimit: 10 },
  { maxBriefChars: 500, maxShotJsonChars: 1800, maxShotCards: 6, maxExtras: 12, maxPredChars: 100, maxCards: 8, titleLimit: 36, intentLimit: 60, paramLimit: 6 },
  { maxBriefChars: 200, maxShotJsonChars: 800, maxShotCards: 3, maxExtras: 5, maxPredChars: 80, maxCards: 4, titleLimit: 24, intentLimit: 36, paramLimit: 4 },
];

/** 构造固定五段结构的镜头工任务书，确保在任意卡库与长输入下总起始上下文严格 <= 15,000 token。 */
export function buildShotWorkerBrief(options = {}) {
  assertSafeData(options, 'buildShotWorkerBrief');
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw badArg('buildShotWorkerBrief 需要对象入参');
  }
  const {
    filmId = 'f_001',
    rev = 1,
    brief = '',
    assets = [],
    shot,
    basePredicates = ['floor@1'],
    extraPredicates = [],
    cards = [],
    budget = {},
  } = options;
  if (!shot || typeof shot !== 'object' || Array.isArray(shot) || typeof shot.id !== 'string' || !shot.id.trim()) {
    throw badArg('buildShotWorkerBrief 需要带合法 id 的 shot 对象');
  }

  const system = `[ROLE:shot-worker:${shot.id}]\n${DELEGATE_ROLES['shot-worker'].systemPrompt}`;
  for (const profile of COMPACTION_PROFILES) {
    const text = formatShotWorkerSections({
      filmId,
      rev,
      brief,
      assets,
      shot,
      basePredicates,
      extraPredicates,
      cards,
      budget,
      profile,
    });
    const tokens = measureStartContextTokens({ system, user: text, tools: [HTTP_TOOL] });
    if (tokens <= SHOT_WORKER_MAX_START_TOKENS) return text;
  }

  const fallback = formatShotWorkerSections({
    filmId,
    rev,
    brief,
    assets: [],
    shot: { id: shot.id, in: shot.in ?? 0, out: shot.out ?? 1, source: shot.source ?? 'three', host: shot.host ?? 'page', mode: shot.mode ?? 'cards-data', colorRef: shot.colorRef ?? 'display' },
    basePredicates: ['floor@1'],
    extraPredicates: (Array.isArray(extraPredicates) ? extraPredicates : []).slice(0, 2),
    cards: [],
    budget,
    profile: COMPACTION_PROFILES[2],
  });
  return fallback;
}

/** 构造镜头工全新会话的起始消息对（system + 五段 user 任务书）并返回实测 startTokens。 */
export function buildShotWorkerMessages(options = {}) {
  const user = buildShotWorkerBrief(options);
  const shotId = options.shot.id;
  const system = `[ROLE:shot-worker:${shotId}]\n${DELEGATE_ROLES['shot-worker'].systemPrompt}`;
  const startTokens = measureStartContextTokens({ system, user, tools: [HTTP_TOOL] });
  if (startTokens > SHOT_WORKER_MAX_START_TOKENS) {
    throw badArg(`镜头工起始上下文 ${startTokens} token 超过上限 ${SHOT_WORKER_MAX_START_TOKENS}`);
  }
  return {
    role: 'shot-worker',
    shotId,
    system,
    user,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    startTokens,
  };
}

/**
 * 委托片模板由服务端根据需求原文与资产列表确定性判定（零随机、零墙钟、零外部状态）。
 * 返回 { template: 'turntable' | 'title', asset: string | null, selectedBy: 'server' }。
 */
export function selectDelegateTemplate(input) {
  assertSafeData(input, 'selectDelegateTemplate');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badArg('selectDelegateTemplate 需要对象入参');
  }
  const { brief, assets = [] } = input;
  if (typeof brief !== 'string' || !brief.trim()) {
    throw badArg('委托模式需要非空字符串 brief');
  }
  if (!Array.isArray(assets) || !assets.every((a) => typeof a === 'string')) {
    throw badArg('assets 必须是字符串数组');
  }

  const text = brief.trim();
  const hasMechAsset = assets.includes('asset:mech-head-proxy@1') || assets.includes('calib/mech-head-proxy@1');
  const hasRtxAsset = assets.includes('asset:rtx-card@1');

  const mechRe = /头雕|mech-head|机械头|校准几何|装配环绕/i;
  const turntableRe = /转台|turntable|硬表面|三维|3d|环绕展示|绕.*(?:旋转|推|缓推)|产品.*展示|显卡.*(?:展示|转台|绕|硬表面)/i;
  const pureTitleRe = /纯片名|片名落版|片名短片|片名测试片|只显示片名/i;

  if (hasMechAsset || (mechRe.test(text) && !pureTitleRe.test(text))) {
    return { template: 'turntable', asset: 'asset:mech-head-proxy@1', selectedBy: 'server' };
  }
  if (hasRtxAsset || (turntableRe.test(text) && !pureTitleRe.test(text))) {
    return { template: 'turntable', asset: 'asset:rtx-card@1', selectedBy: 'server' };
  }
  return { template: 'title', asset: null, selectedBy: 'server' };
}

/** 基于 (filmId, perspective, voteIndex) 确定性打乱候选列表顺序，消除位置偏置且完全可复现。 */
export function shuffleCandidatesForBallot(candidates = [], { filmId = 'film', perspective = 'composition-readability', voteIndex = 0 } = {}) {
  assertSafeData(candidates, 'candidates');
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  return [...candidates]
    .map((item, idx) => {
      const cid = typeof item === 'string' ? item : String(item?.id ?? idx);
      const score = createHash('sha256')
        .update(`${filmId}:${perspective}:${voteIndex}:${cid}:${idx}`)
        .digest('hex');
      return { item, score };
    })
    .sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : 0))
    .map((x) => x.item);
}

/**
 * 校验并过滤 L5 建议谓词：逐条过 parseAssertion / checkExtra + scopeRange + enforcePredicateFloor + checkL1。
 * 只有完全通过 L1 的谓词才进入 suggestedPredicates / validatedExtraPredicates，其余归入 rejectedPredicates。
 */
export function filterL5SuggestedPredicates(predicates, { film = null, question = null } = {}) {
  assertSafeData(predicates, 'predicates');
  assertSafeData({ film, question }, 'filterL5SuggestedPredicates.options');
  if (!Array.isArray(predicates)) {
    throw badArg('suggestedPredicates 必须是数组');
  }

  const validatedExtraPredicates = [];
  const rejectedPredicates = [];
  const seen = new Set();

  for (const raw of predicates) {
    if (typeof raw !== 'string' || !raw.trim()) {
      rejectedPredicates.push({ predicate: String(raw), reason: '断言必须是非空字符串' });
      continue;
    }
    const pred = raw.trim();
    if (seen.has(pred)) continue;
    seen.add(pred);

    const extraCheck = checkExtra(pred);
    if (!extraCheck.ok) {
      rejectedPredicates.push({
        predicate: pred,
        reason: extraCheck.errors.map((e) => e.message).join('；'),
      });
      continue;
    }

    if (film && typeof film === 'object') {
      const totalFrames = film?.output?.frames;
      const range = scopeRange(extraCheck.assertion.scope, film);
      if (
        range === null ||
        (Number.isSafeInteger(totalFrames) && (range[0] < 0 || range[1] > totalFrames || range[0] >= range[1]))
      ) {
        rejectedPredicates.push({
          predicate: pred,
          reason: `断言范围超出片子总帧数 [0, ${totalFrames}) 或无法解析`,
        });
        continue;
      }

      const existingExtra = Array.isArray(film.predicates?.extra) ? film.predicates.extra : [];
      const candidateFilm = {
        ...film,
        predicates: {
          base: Array.isArray(film.predicates?.base) && film.predicates.base.length ? film.predicates.base : ['floor@1'],
          extra: [...existingExtra, pred],
        },
      };

      const floorCheck = enforcePredicateFloor(
        candidateFilm,
        question ? { base: question.basePredicates } : null,
      );
      const loose = floorCheck.violations.find((v) => v.code === 'threshold-loosened' || v.path === 'predicates/extra');
      if (loose) {
        rejectedPredicates.push({ predicate: pred, reason: loose.message });
        continue;
      }

      const l1 = checkL1(candidateFilm);
      const l1Err = l1.diagnostics.find(
        (d) => d.severity === 'error' && (d.at === 'predicates/extra' || d.at === 'predicates'),
      );
      if (l1Err) {
        rejectedPredicates.push({ predicate: pred, reason: l1Err.message });
        continue;
      }
    }

    validatedExtraPredicates.push(pred);
  }

  return {
    suggestedPredicates: validatedExtraPredicates,
    validatedExtraPredicates,
    rejectedPredicates,
  };
}

function validateBallotOpinion(o, idx, totalFrames) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    throw badArg(`审片意见 opinions[${idx}] 必须是对象`);
  }
  if (
    !Array.isArray(o.frames) ||
    o.frames.length !== 2 ||
    !o.frames.every((f) => Number.isSafeInteger(f) && f >= 0 && f < totalFrames) ||
    o.frames[0] > o.frames[1]
  ) {
    throw badArg(`审片意见 opinions[${idx}] 的帧区间不合法或越界`);
  }
  if (typeof o.severity !== 'string' || !VALID_SEVERITIES.includes(o.severity)) {
    throw badArg(`审片意见 opinions[${idx}] 的严重度不合法`);
  }
  if (typeof o.evidence !== 'string' || !o.evidence.trim()) {
    throw badArg(`审片意见 opinions[${idx}] 的证据不能为空`);
  }
  if (typeof o.comment !== 'string' || !o.comment.trim()) {
    throw badArg(`审片意见 opinions[${idx}] 的意见不能为空`);
  }
  return {
    ...(typeof o.issueKey === 'string' && o.issueKey.trim() ? { issueKey: o.issueKey.trim() } : {}),
    frames: [o.frames[0], o.frames[1]],
    severity: o.severity,
    evidence: o.evidence.trim(),
    comment: o.comment.trim(),
    ...(typeof o.suggestedPredicate === 'string' && o.suggestedPredicate.trim()
      ? { suggestedPredicate: o.suggestedPredicate.trim() }
      : {}),
  };
}

function pickMajorityGrade(grades) {
  const counts = { 好: 0, 一般: 0, 差: 0 };
  for (const g of grades) {
    if (L5_GRADES.includes(g)) counts[g]++;
  }
  let best = '一般';
  let bestCount = -1;
  for (const g of L5_GRADES) {
    if (counts[g] > bestCount) {
      bestCount = counts[g];
      best = g;
    }
  }
  return { grade: best, counts };
}

/**
 * 聚合 L5 三视角九票选票：
 * - 校验每张选票每条意见的帧区间 [start, end]、严重度、非空证据与非空意见；
 * - 同一问题（按 issueKey 或规范化摘要 + 帧区间重叠聚类）得票 >= 2（quorum = 2）才成立；
 * - 仅 1 票的孤立意见丢弃并计入 discardedOpinionCount；
 * - 候选建议谓词过 filterL5SuggestedPredicates（L1 + 防削弱）才进入 suggestedPredicates / validatedExtraPredicates。
 */
export function aggregateL5Votes(ballots, { totalFrames = Infinity, film = null, question = null, quorum = 2 } = {}) {
  assertSafeData(ballots, 'ballots');
  assertSafeData({ totalFrames, film, question, quorum }, 'aggregateL5Votes.options');
  if (!Array.isArray(ballots) || ballots.length === 0) {
    throw badArg('ballots 必须是非空选票数组');
  }
  const maxFrames = Number.isSafeInteger(totalFrames)
    ? totalFrames
    : (Number.isSafeInteger(film?.output?.frames) ? film.output.frames : Infinity);

  const clusters = [];
  const ballotGrades = [];
  const candidateVoteMap = new Map();
  const candidateOrderings = [];
  const predicateVoteCounts = new Map();

  ballots.forEach((ballot, bIdx) => {
    if (!ballot || typeof ballot !== 'object' || Array.isArray(ballot)) {
      throw badArg(`选票 ballots[${bIdx}] 必须是对象`);
    }
    const perspective = typeof ballot.perspective === 'string' ? ballot.perspective : 'composition-readability';
    if (ballot.grade !== undefined) {
      if (!L5_GRADES.includes(ballot.grade)) throw badArg(`选票 ballots[${bIdx}] 的等级词 ${ballot.grade} 不合法`);
      ballotGrades.push(ballot.grade);
    }
    const ordering = ballot.candidateOrdering ?? ballot.candidateOrder;
    if (Array.isArray(ordering)) {
      candidateOrderings.push(ordering);
    }
    if (Array.isArray(ballot.candidateGrades)) {
      for (const cg of ballot.candidateGrades) {
        if (!cg || typeof cg.id !== 'string' || !L5_GRADES.includes(cg.grade)) {
          throw badArg(`选票 ballots[${bIdx}] 的 candidateGrades 项不合法`);
        }
        if (!candidateVoteMap.has(cg.id)) candidateVoteMap.set(cg.id, []);
        candidateVoteMap.get(cg.id).push(cg.grade);
      }
    }

    if (!Array.isArray(ballot.opinions)) {
      throw badArg(`选票 ballots[${bIdx}] 缺少 opinions 数组`);
    }

    const ballotPredicates = new Set();
    if (Array.isArray(ballot.suggestedPredicates)) {
      for (const sp of ballot.suggestedPredicates) {
        if (typeof sp !== 'string' || !sp.trim()) throw badArg(`选票 ballots[${bIdx}] 的 suggestedPredicates 必须是非空字符串`);
        ballotPredicates.add(sp.trim());
      }
    }

    for (let i = 0; i < ballot.opinions.length; i++) {
      const op = validateBallotOpinion(ballot.opinions[i], i, maxFrames);
      if (op.suggestedPredicate) ballotPredicates.add(op.suggestedPredicate);
      const normKey = (op.issueKey ?? op.comment).toLowerCase();
      let cluster = clusters.find(
        (c) =>
          c.normKey === normKey &&
          Math.max(c.frames[0], op.frames[0]) <= Math.min(c.frames[1], op.frames[1]),
      );
      if (!cluster) {
        cluster = {
          normKey,
          issueKey: op.issueKey ?? null,
          frames: [op.frames[0], op.frames[1]],
          severity: op.severity,
          evidence: op.evidence,
          comment: op.comment,
          ballotIndices: new Set(),
          perspectives: new Set(),
          suggestedPredicates: new Set(),
        };
        clusters.push(cluster);
      } else {
        cluster.frames = [
          Math.min(cluster.frames[0], op.frames[0]),
          Math.max(cluster.frames[1], op.frames[1]),
        ];
        if ((SEVERITY_RANK[op.severity] ?? 1) > (SEVERITY_RANK[cluster.severity] ?? 1)) {
          cluster.severity = op.severity;
        }
      }
      cluster.ballotIndices.add(bIdx);
      cluster.perspectives.add(perspective);
      if (op.suggestedPredicate) cluster.suggestedPredicates.add(op.suggestedPredicate);
    }

    for (const sp of ballotPredicates) {
      predicateVoteCounts.set(sp, (predicateVoteCounts.get(sp) ?? 0) + 1);
    }
  });

  const opinions = [];
  let discardedOpinionCount = 0;
  const acceptedPredicateCandidates = [];

  for (const c of clusters) {
    const votes = c.ballotIndices.size;
    if (votes >= quorum) {
      opinions.push({
        ...(c.issueKey ? { issueKey: c.issueKey } : {}),
        frames: c.frames,
        severity: c.severity,
        evidence: c.evidence,
        comment: c.comment,
        votes,
        perspectives: [...c.perspectives],
      });
      for (const sp of c.suggestedPredicates) acceptedPredicateCandidates.push(sp);
    } else {
      discardedOpinionCount++;
    }
  }

  for (const [sp, count] of predicateVoteCounts.entries()) {
    if (count >= Math.min(quorum, ballots.length)) {
      acceptedPredicateCandidates.push(sp);
    }
  }

  const filtered = filterL5SuggestedPredicates(acceptedPredicateCandidates, { film, question });
  const overallGrade = ballotGrades.length
    ? pickMajorityGrade(ballotGrades).grade
    : (opinions.some((o) => o.severity === 'error' || o.severity === 'high') ? '差' : opinions.length ? '一般' : '好');

  const candidateGrades = {};
  for (const [cid, grades] of candidateVoteMap.entries()) {
    candidateGrades[cid] = pickMajorityGrade(grades);
  }

  return {
    totalBallots: ballots.length,
    quorum,
    grade: overallGrade,
    candidateOrderings,
    candidateGrades,
    opinions,
    discardedOpinionCount,
    rawSuggestedPredicates: acceptedPredicateCandidates,
    suggestedPredicates: filtered.suggestedPredicates,
    validatedExtraPredicates: filtered.validatedExtraPredicates,
    rejectedPredicates: filtered.rejectedPredicates,
    overridesHardGates: false,
  };
}
