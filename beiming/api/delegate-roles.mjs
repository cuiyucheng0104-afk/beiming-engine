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
const CONSERVATIVE_GRADE_ORDER = Object.freeze(['差', '一般', '好']);

export const L5_ISSUE_KEYS = Object.freeze({
  'composition-readability': Object.freeze([
    'hero-framing',
    'margin-clipping',
    'title-readability',
    'visual-balance',
  ]),
  'motion-rhythm': Object.freeze([
    'camera-jitter',
    'motion-pacing',
    'cut-timing',
    'unintended-freeze',
    'av-sync',
  ]),
  'look-consistency': Object.freeze([
    'cut-seam',
    'lighting-contrast',
    'material-specularity',
    'color-consistency',
    'render-artifact',
  ]),
});

export const L5_PERSPECTIVES = Object.freeze([
  Object.freeze({
    id: 'composition-readability',
    title: '构图与可读',
    votes: 3,
    focus: '检查主体位置、屏占比、四边留白余量、片名与字幕可读性及视觉重心。',
    issueKeys: L5_ISSUE_KEYS['composition-readability'],
  }),
  Object.freeze({
    id: 'motion-rhythm',
    title: '动作与节奏',
    votes: 3,
    focus: '检查相机与主体运动平滑度、速度曲线、切点时机、刻意冻结段合理性与音画同步。',
    issueKeys: L5_ISSUE_KEYS['motion-rhythm'],
  }),
  Object.freeze({
    id: 'look-consistency',
    title: '质感与一致性',
    votes: 3,
    focus: '检查材质高光、布光对比、色彩基调一致性、切点前后亮度跳变与画面伪影。',
    issueKeys: L5_ISSUE_KEYS['look-consistency'],
  }),
]);

const PERSPECTIVE_INDEX = new Map(L5_PERSPECTIVES.map((p, i) => [p.id, i]));
const PERSPECTIVE_ISSUE_KEY_SET = new Map(
  L5_PERSPECTIVES.map((p) => [p.id, new Set(L5_ISSUE_KEYS[p.id])]),
);
const ALL_ISSUE_KEYS = new Set(Object.values(L5_ISSUE_KEYS).flat());

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
    issueKeys: L5_ISSUE_KEYS,
    votesPerPerspective: 3,
    totalBallots: 9,
    quorum: 2,
    grades: L5_GRADES,
    overridesHardGates: false,
    systemPrompt: [
      '你是北冥 L5 异族视觉审片人（reviewer）。按当前指定视角审视需求原文、联系表、切点条带与声音量测表，给出等级词评价（仅限 好 / 一般 / 差，严禁百分制）与具体问题意见。',
      '每条意见必须指明所属视角的封闭 issueKey、全片整数帧区间 frames: [start, end]、严重度 severity（info|warn|error 或 low|medium|high）、画面或量测证据 evidence 与改进建议 comment；可选附带 suggestedPredicate。',
      `各视角封闭 issueKey 枚举表：composition-readability=[${L5_ISSUE_KEYS['composition-readability'].join(', ')}]；motion-rhythm=[${L5_ISSUE_KEYS['motion-rhythm'].join(', ')}]；look-consistency=[${L5_ISSUE_KEYS['look-consistency'].join(', ')}]。表外或泛化键（如 issue）将作废。`,
      '只回一个合法 JSON 对象：{"grade":"好|一般|差","candidateGrades":[{"id":"候选ID","grade":"好|一般|差"}],"opinions":[{"issueKey":"本视角封闭枚举值","frames":[起帧,止帧],"severity":"info|warn|error","evidence":"具体画面证据","comment":"改进意见","suggestedPredicate":"可选建议断言"}],"suggestedPredicates":["谓词断言"]}。',
      '没有意见时 opinions 是空数组。不要回 JSON 以外的字。L5 审片结论仅供参考，绝不推翻 L1–L4 硬门结论。',
    ].join('\n'),
  }),
});

const VALID_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'info', 'warn', 'error']);
const SEVERITY_RANK = Object.freeze({ info: 1, low: 1, warn: 2, medium: 2, error: 3, high: 3 });
const MAX_SAFE_DEPTH = 64;
const MAX_ID_CHARS = 128;

function badArg(message) {
  return Object.assign(new Error(message), { code: 'usage.bad-argument' });
}

function own(obj, key) {
  return obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function safeLabel(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return '[object]'; }
}

function isCanonicalIndex(key, length) {
  if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const idx = Number(key);
  return Number.isSafeInteger(idx) && idx >= 0 && idx < length;
}

/**
 * 递归校验纯数据入参（零陷阱防御）：
 * - 拦截 Proxy、getter/setter 访问器属性、Symbol 属性、函数与 BigInt；
 * - 数组强制要求原型为 Array.prototype、无稀疏空洞、无附加非下标键；
 * - 对象强制要求原型为 Object.prototype 或 null，且拒绝循环引用。
 */
function assertSafeData(value, label = 'input', ancestors = new Set(), visited = new Set(), depth = 0) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'boolean' || t === 'string' || t === 'number') return value;
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw badArg(`${label} 不接受 ${t} 类型值`);
  }
  if (isProxy(value)) throw badArg(`${label} 不接受 Proxy 对象`);
  if (depth > MAX_SAFE_DEPTH) throw badArg(`${label} 嵌套层级过深`);
  if (ancestors.has(value)) throw badArg(`${label} 包含循环引用`);
  if (visited.has(value)) return value;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw badArg(`${label} 必须是标准 Array.prototype 数组`);
      }
      const keys = Reflect.ownKeys(value);
      let indexCount = 0;
      const lenDesc = Object.getOwnPropertyDescriptor(value, 'length');
      if (!lenDesc || lenDesc.get || lenDesc.set || !Object.hasOwn(lenDesc, 'value') || !Number.isSafeInteger(lenDesc.value) || lenDesc.value < 0) {
        throw badArg(`${label} 的数组长度属性不合法`);
      }
      const len = lenDesc.value;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (typeof k === 'symbol') {
          throw badArg(`${label} 数组不接受 Symbol 属性`);
        }
        if (k === 'length') continue;
        if (!isCanonicalIndex(k, len)) {
          throw badArg(`${label} 数组不接受附加非下标属性 ${k}`);
        }
        const d = Object.getOwnPropertyDescriptor(value, k);
        if (!d || d.get || d.set || !Object.hasOwn(d, 'value')) {
          throw badArg(`${label}[${k}] 不接受 getter/setter 访问器属性`);
        }
        indexCount++;
        assertSafeData(d.value, `${label}[${k}]`, ancestors, visited, depth + 1);
      }
      if (indexCount !== len) {
        throw badArg(`${label} 不接受含空洞的稀疏数组`);
      }
      return value;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw badArg(`${label} 必须是纯数据对象`);
    }
    const keys = Reflect.ownKeys(value);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (typeof k === 'symbol') {
        throw badArg(`${label} 不接受 Symbol 属性`);
      }
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (!d || d.get || d.set || !Object.hasOwn(d, 'value')) {
        throw badArg(`${label}.${k} 不接受 getter/setter 访问器属性`);
      }
      assertSafeData(d.value, `${label}.${k}`, ancestors, visited, depth + 1);
    }
    return value;
  } finally {
    ancestors.delete(value);
    visited.add(value);
  }
}

function assertPlainObject(value, label) {
  assertSafeData(value, label);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badArg(`${label} 必须是纯对象`);
  }
  return value;
}

function assertOptionalPlainObject(value, label) {
  if (value === undefined) return {};
  return assertPlainObject(value, label);
}

function clipText(text, maxChars) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** 按仓库统一的保守口径 ceil(utf8Bytes / 3.5) 计量镜头工会话起始上下文 token 数。 */
export function measureStartContextTokens(input) {
  const opts = assertOptionalPlainObject(input, 'measureStartContextTokens');
  const system = own(opts, 'system');
  const user = own(opts, 'user');
  const tools = own(opts, 'tools');
  if (system !== undefined && typeof system !== 'string') {
    throw badArg('measureStartContextTokens.system 必须是字符串');
  }
  if (user !== undefined && typeof user !== 'string') {
    throw badArg('measureStartContextTokens.user 必须是字符串');
  }
  if (tools !== undefined && !Array.isArray(tools)) {
    throw badArg('measureStartContextTokens.tools 必须是数组');
  }
  const serialized = JSON.stringify({
    system: system ?? '',
    user: user ?? '',
    tools: tools ?? [HTTP_TOOL],
  });
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / 3.5);
}

function summarizeCard(card, { titleLimit, intentLimit, paramLimit }) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const rawId = own(card, 'id');
  const rawUse = own(card, 'use');
  const id = typeof rawId === 'string' ? rawId : (typeof rawUse === 'string' ? rawUse : 'unknown');
  const rawVer = own(card, 'version');
  const major = typeof rawVer === 'string' ? rawVer.split('.')[0] : '1';
  const ref = clipText(id.includes('@') ? id : `${id}@${major}`, 120);
  const rawTitle = own(card, 'title');
  const rawIntent = own(card, 'intent');
  const rawParams = own(card, 'params');
  const title = typeof rawTitle === 'string' && rawTitle ? clipText(rawTitle, titleLimit) : '';
  const intent = typeof rawIntent === 'string' && rawIntent ? clipText(rawIntent, intentLimit) : '';
  const paramKeys = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
    ? Object.keys(rawParams).slice(0, paramLimit).map((k) => clipText(k, 40))
    : [];
  const parts = [`- \`${ref}\``];
  if (title) parts.push(title);
  if (intent) parts.push(`用途：${intent}`);
  if (paramKeys.length) parts.push(`参数：${paramKeys.join(', ')}`);
  return parts.join(' | ');
}

function serializeShotEntry(compactShot, maxShotJsonChars) {
  const compactJson = JSON.stringify(compactShot);
  if (compactJson.length <= maxShotJsonChars) return compactJson;

  const slimShot = {
    id: compactShot.id,
    in: compactShot.in,
    out: compactShot.out,
    ...(compactShot.source !== undefined ? { source: compactShot.source } : {}),
    ...(compactShot.host !== undefined ? { host: compactShot.host } : {}),
    ...(compactShot.mode !== undefined ? { mode: compactShot.mode } : {}),
    ...(compactShot.colorRef !== undefined ? { colorRef: compactShot.colorRef } : {}),
    ...(compactShot.seed !== undefined ? { seed: compactShot.seed } : {}),
    ...(Array.isArray(compactShot.cards)
      ? { cards: compactShot.cards.map((c) => ({ as: own(c, 'as'), use: own(c, 'use'), _paramsOmitted: true })) }
      : {}),
    _truncated: true,
  };
  const slimJson = JSON.stringify(slimShot);
  if (slimJson.length <= maxShotJsonChars) return slimJson;

  return JSON.stringify({
    id: compactShot.id,
    in: compactShot.in,
    out: compactShot.out,
    ...(compactShot.source !== undefined ? { source: compactShot.source } : {}),
    _truncated: true,
  });
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
  const shotCards = own(shot, 'cards');
  const compactShot = {
    ...shot,
    ...(Array.isArray(shotCards)
      ? {
          cards: shotCards.slice(0, profile.maxShotCards).map((c) => ({
            as: own(c, 'as'),
            use: own(c, 'use'),
            params: own(c, 'params'),
          })),
        }
      : {}),
  };
  const shotJson = serializeShotEntry(compactShot, profile.maxShotJsonChars);

  const baseRefs = Array.isArray(basePredicates) && basePredicates.length ? basePredicates : ['floor@1'];
  const floorExprs = FLOOR?.items?.map((it) => `  - \`${it.expr}\``) ?? [];
  const extras = Array.isArray(extraPredicates) ? extraPredicates : [];
  const shownExtras = extras.slice(0, profile.maxExtras).map((x) => `  - \`${clipText(x, profile.maxPredChars)}\``);
  if (extras.length > shownExtras.length) {
    shownExtras.push(`  - （其余 ${extras.length - shownExtras.length} 条追加断言已折叠）`);
  }

  const boundCards = Array.isArray(shotCards)
    ? shotCards.slice(0, profile.maxBoundCards).map((c) => {
        const rawAs = own(c, 'as');
        const rawUse = own(c, 'use');
        const asText = typeof rawAs === 'string' && rawAs.trim() ? clipText(rawAs, 80) : 'unnamed';
        const useText = typeof rawUse === 'string' && rawUse.trim() ? clipText(rawUse, 120) : 'unknown';
        return `- 已绑定实例 \`${asText}\` → \`${useText}\``;
      })
    : [];
  if (Array.isArray(shotCards) && shotCards.length > boundCards.length) {
    boundCards.push(`- （其余 ${shotCards.length - boundCards.length} 个已绑定卡实例已折叠）`);
  }
  const candidateCards = (Array.isArray(cards) ? cards : [])
    .slice(0, profile.maxCards)
    .map((c) => summarizeCard(c, profile))
    .filter(Boolean);
  const moreCards = Array.isArray(cards) && cards.length > profile.maxCards
    ? [`- （其余 ${cards.length - profile.maxCards} 张候选卡已按 15,000 token 预算裁剪，可按需调 POST /v1/cards/search）`]
    : [];

  const tokensVal = own(budget, 'tokens');
  const gpuVal = own(budget, 'gpuSeconds');
  const wallVal = own(budget, 'wallSeconds');
  const stepsVal = own(budget, 'maxSteps');
  const tokensText = tokensVal !== undefined ? tokensVal : 1_200_000;
  const gpuText = gpuVal !== undefined ? `${gpuVal}s` : '未限（受整片配额约束）';
  const wallText = wallVal !== undefined ? `${wallVal}s` : '未限（受整片配额约束）';
  const stepsText = stepsVal !== undefined ? stepsVal : 12;

  return [
    `# 镜头工任务书（片子 ${filmId} · 镜头 ${shotId}）`,
    '',
    '## 1. 镜头条目',
    `- 片子标识：\`${filmId}\`（当前修订 \`rev=${rev}\`）`,
    `- 镜头标识：\`${shotId}\`，全片帧区间：\`[${shot.in}, ${shot.out})\`（共 ${shot.out - shot.in} 帧）`,
    `- 写入权限边界：只允许用 \`patch/0.1\`（带最新 \`rev\`）修改 \`shots/${shotId}/\` 下的路径，禁止改动其他镜头或全片只读字段`,
    `- 需求摘要：${clipText(brief || '按片子描述完成本镜头渲染与核验', profile.maxBriefChars)}`,
    ...(Array.isArray(assets) && assets.length ? [`- 素材引用：${clipText(JSON.stringify(assets), 300)}`] : []),
    '```json',
    shotJson,
    '```',
    '',
    '## 2. 基础谓词',
    `- 基础谓词引用（\`predicates.base\`，只读）：${baseRefs.slice(0, profile.maxBaseRefs).map((r) => `\`${clipText(r, 80)}\``).join('、')}`,
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
  { maxBriefChars: 1200, maxShotJsonChars: 12000, maxShotCards: 16, maxBoundCards: 24, maxBaseRefs: 16, maxExtras: 24, maxPredChars: 160, maxCards: 16, titleLimit: 60, intentLimit: 120, paramLimit: 10 },
  { maxBriefChars: 500, maxShotJsonChars: 4000, maxShotCards: 8, maxBoundCards: 12, maxBaseRefs: 8, maxExtras: 12, maxPredChars: 100, maxCards: 8, titleLimit: 36, intentLimit: 60, paramLimit: 6 },
  { maxBriefChars: 200, maxShotJsonChars: 1200, maxShotCards: 3, maxBoundCards: 4, maxBaseRefs: 4, maxExtras: 5, maxPredChars: 80, maxCards: 4, titleLimit: 24, intentLimit: 36, paramLimit: 4 },
];

function validateShotWorkerOptions(options) {
  const opts = assertPlainObject(options, 'buildShotWorkerBrief');
  const filmId = own(opts, 'filmId') === undefined ? 'f_001' : own(opts, 'filmId');
  const rev = own(opts, 'rev') === undefined ? 1 : own(opts, 'rev');
  const brief = own(opts, 'brief') === undefined ? '' : own(opts, 'brief');
  const assets = own(opts, 'assets') === undefined ? [] : own(opts, 'assets');
  const shot = own(opts, 'shot');
  const basePredicates = own(opts, 'basePredicates') === undefined ? ['floor@1'] : own(opts, 'basePredicates');
  const extraPredicates = own(opts, 'extraPredicates') === undefined ? [] : own(opts, 'extraPredicates');
  const cards = own(opts, 'cards') === undefined ? [] : own(opts, 'cards');
  const budget = own(opts, 'budget') === undefined ? {} : own(opts, 'budget');

  if (typeof filmId !== 'string' || !filmId.trim() || filmId.length > MAX_ID_CHARS) {
    throw badArg(`filmId 必须是 1..${MAX_ID_CHARS} 字符的非空字符串`);
  }
  if (!Number.isSafeInteger(rev) || rev < 0) {
    throw badArg('rev 必须是非负安全整数');
  }
  if (typeof brief !== 'string') {
    throw badArg('brief 必须是字符串');
  }
  if (!Array.isArray(assets)) {
    throw badArg('assets 必须是字符串数组');
  }
  for (let i = 0; i < assets.length; i++) {
    if (typeof assets[i] !== 'string') throw badArg(`assets[${i}] 必须是字符串`);
  }
  if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
    throw badArg('buildShotWorkerBrief 需要纯对象 shot');
  }
  const shotId = own(shot, 'id');
  const shotIn = own(shot, 'in');
  const shotOut = own(shot, 'out');
  if (typeof shotId !== 'string' || !shotId.trim() || shotId.length > MAX_ID_CHARS) {
    throw badArg(`shot.id 必须是 1..${MAX_ID_CHARS} 字符的非空字符串`);
  }
  if (!Number.isSafeInteger(shotIn) || shotIn < 0) {
    throw badArg('shot.in 必须是非负安全整数');
  }
  if (!Number.isSafeInteger(shotOut) || shotOut <= shotIn) {
    throw badArg('shot.out 必须是大于 shot.in 的安全整数');
  }
  const shotCards = own(shot, 'cards');
  if (shotCards !== undefined) {
    if (!Array.isArray(shotCards)) throw badArg('shot.cards 必须是数组');
    for (let i = 0; i < shotCards.length; i++) {
      if (!shotCards[i] || typeof shotCards[i] !== 'object' || Array.isArray(shotCards[i])) {
        throw badArg(`shot.cards[${i}] 必须是纯对象`);
      }
    }
  }
  if (!Array.isArray(basePredicates)) {
    throw badArg('basePredicates 必须是字符串数组');
  }
  for (let i = 0; i < basePredicates.length; i++) {
    if (typeof basePredicates[i] !== 'string') throw badArg(`basePredicates[${i}] 必须是字符串`);
  }
  if (!Array.isArray(extraPredicates)) {
    throw badArg('extraPredicates 必须是字符串数组');
  }
  for (let i = 0; i < extraPredicates.length; i++) {
    if (typeof extraPredicates[i] !== 'string') throw badArg(`extraPredicates[${i}] 必须是字符串`);
  }
  if (!Array.isArray(cards)) {
    throw badArg('cards 必须是对象数组');
  }
  for (let i = 0; i < cards.length; i++) {
    if (!cards[i] || typeof cards[i] !== 'object' || Array.isArray(cards[i])) {
      throw badArg(`cards[${i}] 必须是纯对象`);
    }
  }
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    throw badArg('budget 必须是纯对象');
  }
  const bTokens = own(budget, 'tokens');
  const bGpu = own(budget, 'gpuSeconds');
  const bWall = own(budget, 'wallSeconds');
  const bSteps = own(budget, 'maxSteps');
  if (bTokens !== undefined && (!Number.isSafeInteger(bTokens) || bTokens < 0)) {
    throw badArg('budget.tokens 必须是非负安全整数');
  }
  if (bGpu !== undefined && (typeof bGpu !== 'number' || !Number.isFinite(bGpu) || bGpu < 0)) {
    throw badArg('budget.gpuSeconds 必须是非负有限数字');
  }
  if (bWall !== undefined && (typeof bWall !== 'number' || !Number.isFinite(bWall) || bWall < 0)) {
    throw badArg('budget.wallSeconds 必须是非负有限数字');
  }
  if (bSteps !== undefined && (!Number.isSafeInteger(bSteps) || bSteps < 1)) {
    throw badArg('budget.maxSteps 必须是正安全整数');
  }

  return { filmId, rev, brief, assets, shot, basePredicates, extraPredicates, cards, budget };
}

/** 构造固定五段结构的镜头工任务书，确保在任意卡库与长输入下总起始上下文严格 <= 15,000 token。 */
export function buildShotWorkerBrief(options) {
  const {
    filmId,
    rev,
    brief,
    assets,
    shot,
    basePredicates,
    extraPredicates,
    cards,
    budget,
  } = validateShotWorkerOptions(options);

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
    shot: {
      id: shot.id,
      in: shot.in,
      out: shot.out,
      source: own(shot, 'source') ?? 'three',
      host: own(shot, 'host') ?? 'page',
      mode: own(shot, 'mode') ?? 'cards-data',
      colorRef: own(shot, 'colorRef') ?? 'display',
    },
    basePredicates: ['floor@1'],
    extraPredicates: extraPredicates.slice(0, 2),
    cards: [],
    budget,
    profile: COMPACTION_PROFILES[2],
  });
  const fallbackTokens = measureStartContextTokens({ system, user: fallback, tools: [HTTP_TOOL] });
  if (fallbackTokens > SHOT_WORKER_MAX_START_TOKENS) {
    throw badArg(`镜头工起始上下文 ${fallbackTokens} token 超过上限 ${SHOT_WORKER_MAX_START_TOKENS}`);
  }
  return fallback;
}

/** 构造镜头工全新会话的起始消息对（system + 五段 user 任务书）并返回实测 startTokens。 */
export function buildShotWorkerMessages(options) {
  const user = buildShotWorkerBrief(options);
  const shotId = own(own(options, 'shot'), 'id');
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
  const obj = assertPlainObject(input, 'selectDelegateTemplate');
  const brief = own(obj, 'brief');
  const assets = own(obj, 'assets') === undefined ? [] : own(obj, 'assets');
  if (typeof brief !== 'string' || !brief.trim()) {
    throw badArg('委托模式需要非空字符串 brief');
  }
  if (!Array.isArray(assets)) {
    throw badArg('assets 必须是字符串数组');
  }
  let hasMechAsset = false;
  let hasRtxAsset = false;
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    if (typeof a !== 'string') throw badArg('assets 必须是字符串数组');
    if (a === 'asset:mech-head-proxy@1' || a === 'calib/mech-head-proxy@1') hasMechAsset = true;
    if (a === 'asset:rtx-card@1') hasRtxAsset = true;
  }

  const text = brief.trim();
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
export function shuffleCandidatesForBallot(candidates, options) {
  const list = candidates === undefined ? [] : candidates;
  assertSafeData(list, 'candidates');
  if (!Array.isArray(list)) {
    throw badArg('candidates 必须是数组');
  }
  const opts = assertOptionalPlainObject(options, 'shuffleCandidatesForBallot.options');
  const filmId = own(opts, 'filmId') === undefined ? 'film' : own(opts, 'filmId');
  const perspective = own(opts, 'perspective') === undefined ? 'composition-readability' : own(opts, 'perspective');
  const voteIndex = own(opts, 'voteIndex') === undefined ? 0 : own(opts, 'voteIndex');
  if (typeof filmId !== 'string' || !filmId.trim()) {
    throw badArg('filmId 必须是非空字符串');
  }
  if (typeof perspective !== 'string' || !perspective.trim()) {
    throw badArg('perspective 必须是非空字符串');
  }
  if (!Number.isSafeInteger(voteIndex) || voteIndex < 0) {
    throw badArg('voteIndex 必须是非负安全整数');
  }
  if (list.length === 0) return [];

  const decorated = [];
  for (let idx = 0; idx < list.length; idx++) {
    const item = list[idx];
    const cid = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' && typeof own(item, 'id') === 'string' ? own(item, 'id') : String(idx));
    const score = createHash('sha256')
      .update(`${filmId}:${perspective}:${voteIndex}:${cid}:${idx}`)
      .digest('hex');
    decorated.push({ item, score });
  }
  decorated.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : 0));
  return decorated.map((x) => x.item);
}

/**
 * 规范化 L5 问题类别码（连字符/下划线/空白/大小写归一化），仅接受本视角封闭表内的合法键。
 * 不在封闭表内（如泛化键 issue 或跨视角键）返回 null。
 */
export function normalizeIssueKey(rawKey, perspective) {
  assertSafeData(rawKey, 'issueKey');
  assertSafeData(perspective, 'perspective');
  if (perspective !== undefined && typeof perspective !== 'string') {
    throw badArg('perspective 必须是字符串');
  }
  if (typeof rawKey !== 'string') return null;
  const canonical = rawKey
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!canonical) return null;

  if (perspective !== undefined) {
    const allowed = PERSPECTIVE_ISSUE_KEY_SET.get(perspective);
    if (!allowed) return null;
    return allowed.has(canonical) ? canonical : null;
  }
  return ALL_ISSUE_KEYS.has(canonical) ? canonical : null;
}

/**
 * 校验并过滤 L5 建议谓词：逐条过 parseAssertion / checkExtra + scopeRange + enforcePredicateFloor + checkL1。
 * 只有完全通过 L1 的谓词才进入 suggestedPredicates / validatedExtraPredicates，其余归入 rejectedPredicates。
 */
export function filterL5SuggestedPredicates(predicates, options) {
  assertSafeData(predicates, 'predicates');
  if (!Array.isArray(predicates)) {
    throw badArg('suggestedPredicates 必须是数组');
  }
  const opts = assertOptionalPlainObject(options, 'filterL5SuggestedPredicates.options');
  const film = own(opts, 'film') === undefined ? null : own(opts, 'film');
  const question = own(opts, 'question') === undefined ? null : own(opts, 'question');
  if (film !== null && (typeof film !== 'object' || Array.isArray(film))) {
    throw badArg('film 必须是纯对象或 null');
  }
  if (film !== null) {
    const outObj = own(film, 'output');
    if (outObj !== undefined) {
      if (!outObj || typeof outObj !== 'object' || Array.isArray(outObj)) {
        throw badArg('film.output 必须是纯对象');
      }
      const f = own(outObj, 'frames');
      if (f !== undefined && (!Number.isSafeInteger(f) || f < 1)) {
        throw badArg('film.output.frames 必须是正整数');
      }
    }
    const shotsVal = own(film, 'shots');
    if (shotsVal !== undefined && !Array.isArray(shotsVal)) {
      throw badArg('film.shots 必须是数组');
    }
    const predsVal = own(film, 'predicates');
    if (predsVal !== undefined && (!predsVal || typeof predsVal !== 'object' || Array.isArray(predsVal))) {
      throw badArg('film.predicates 必须是纯对象');
    }
  }
  if (question !== null && (typeof question !== 'object' || Array.isArray(question))) {
    throw badArg('question 必须是纯对象或 null');
  }
  if (question !== null) {
    const qBase = own(question, 'basePredicates');
    if (qBase !== undefined && !Array.isArray(qBase)) {
      throw badArg('question.basePredicates 必须是数组');
    }
  }

  const validatedExtraPredicates = [];
  const rejectedPredicates = [];
  const seen = new Set();

  for (let i = 0; i < predicates.length; i++) {
    const raw = predicates[i];
    if (typeof raw !== 'string' || !raw.trim()) {
      rejectedPredicates.push({ predicate: safeLabel(raw), reason: '断言必须是非空字符串' });
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

    if (film) {
      const outputObj = own(film, 'output');
      const totalFrames = outputObj && typeof outputObj === 'object' ? own(outputObj, 'frames') : undefined;
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

      const filmPreds = own(film, 'predicates');
      const existingExtra = filmPreds && Array.isArray(own(filmPreds, 'extra')) ? own(filmPreds, 'extra') : [];
      const existingBase = filmPreds && Array.isArray(own(filmPreds, 'base')) && own(filmPreds, 'base').length
        ? own(filmPreds, 'base')
        : ['floor@1'];
      const candidateFilm = {
        ...film,
        predicates: {
          base: existingBase,
          extra: [...existingExtra, pred],
        },
      };

      const floorCheck = enforcePredicateFloor(
        candidateFilm,
        question ? { base: own(question, 'basePredicates') } : null,
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
    } else {
      // 未传 film 时仍须执行 floor@1 防削弱校验，防止放宽底线断言绕过
      const syntheticFilm = { predicates: { base: ['floor@1'], extra: [pred] } };
      const floorCheck = enforcePredicateFloor(
        syntheticFilm,
        question ? { base: own(question, 'basePredicates') } : null,
      );
      const loose = floorCheck.violations.find((v) => v.code === 'threshold-loosened' || v.path === 'predicates/extra');
      if (loose) {
        rejectedPredicates.push({ predicate: pred, reason: loose.message });
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
  const frames = own(o, 'frames');
  if (
    !Array.isArray(frames) ||
    frames.length !== 2 ||
    !Number.isSafeInteger(frames[0]) ||
    !Number.isSafeInteger(frames[1]) ||
    frames[0] < 0 ||
    frames[1] < 0 ||
    frames[0] >= totalFrames ||
    frames[1] >= totalFrames ||
    frames[0] > frames[1]
  ) {
    throw badArg(`审片意见 opinions[${idx}] 的帧区间不合法或越界`);
  }
  const severity = own(o, 'severity');
  if (typeof severity !== 'string' || !VALID_SEVERITIES.includes(severity)) {
    throw badArg(`审片意见 opinions[${idx}] 的严重度不合法`);
  }
  const evidence = own(o, 'evidence');
  if (typeof evidence !== 'string' || !evidence.trim()) {
    throw badArg(`审片意见 opinions[${idx}] 的证据不能为空`);
  }
  const comment = own(o, 'comment');
  if (typeof comment !== 'string' || !comment.trim()) {
    throw badArg(`审片意见 opinions[${idx}] 的意见不能为空`);
  }
  const rawIssueKey = own(o, 'issueKey');
  if (rawIssueKey !== undefined && typeof rawIssueKey !== 'string') {
    throw badArg(`审片意见 opinions[${idx}] 的 issueKey 必须是字符串`);
  }
  const rawPred = own(o, 'suggestedPredicate');
  if (rawPred !== undefined && (typeof rawPred !== 'string' || !rawPred.trim())) {
    throw badArg(`审片意见 opinions[${idx}] 的 suggestedPredicate 必须是非空字符串`);
  }
  return {
    ...(typeof rawIssueKey === 'string' && rawIssueKey.trim() ? { rawIssueKey: rawIssueKey.trim() } : {}),
    frames: [frames[0], frames[1]],
    severity,
    evidence: evidence.trim(),
    comment: comment.trim(),
    ...(typeof rawPred === 'string' && rawPred.trim() ? { suggestedPredicate: rawPred.trim() } : {}),
  };
}

/** 多数决等级词；平票时严格按保守顺序（差 > 一般 > 好）取更保守一档。 */
function pickMajorityGrade(grades) {
  const counts = { 好: 0, 一般: 0, 差: 0 };
  for (let i = 0; i < grades.length; i++) {
    const g = grades[i];
    if (L5_GRADES.includes(g)) counts[g]++;
  }
  let best = '一般';
  let bestCount = 0;
  for (let i = 0; i < CONSERVATIVE_GRADE_ORDER.length; i++) {
    const g = CONSERVATIVE_GRADE_ORDER[i];
    if (counts[g] > bestCount) {
      bestCount = counts[g];
      best = g;
    }
  }
  return { grade: best, counts };
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function extractKnownCandidates(candidates) {
  if (candidates === undefined) return null;
  if (!Array.isArray(candidates)) {
    throw badArg('candidates 必须是数组');
  }
  const ids = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const id = typeof c === 'string'
      ? c.trim()
      : (c && typeof c === 'object' && !Array.isArray(c) && typeof own(c, 'id') === 'string' ? own(c, 'id').trim() : '');
    if (!id) throw badArg(`candidates[${i}] 缺少合法候选 ID`);
    ids.add(id);
  }
  return ids;
}

/**
 * 聚合 L5 三视角九票选票：
 * - 校验每张选票与每条意见的帧区间 [start, end]、严重度、非空证据、非空意见、封闭 issueKey、重复 (perspective, voteIndex) 与未知候选 ID；
 * - 按 (perspective, normalizedIssueKey, 重叠或相邻帧段) 做与选票输入顺序完全无关的连通分量聚类；
 * - 同一问题得票 >= quorum（默认 2）才成立进入 opinions；单票孤立与表外 issueKey 意见归入 discardedOpinionCount；
 * - 当票面存在未成立/作废意见且 opinions 为空时，总评不得落成「好」（最高不超过「一般」，平票取更保守一档）；
 * - 保留逐票摘要明细 ballots，并将建议谓词过 filterL5SuggestedPredicates（L1 + 防削弱）。
 */
export function aggregateL5Votes(ballots, options) {
  assertSafeData(ballots, 'ballots');
  if (!Array.isArray(ballots) || ballots.length === 0) {
    throw badArg('ballots 必须是非空选票数组');
  }
  const opts = assertOptionalPlainObject(options, 'aggregateL5Votes.options');
  const rawTotalFrames = own(opts, 'totalFrames');
  const film = own(opts, 'film') === undefined ? null : own(opts, 'film');
  const question = own(opts, 'question') === undefined ? null : own(opts, 'question');
  const rawQuorum = own(opts, 'quorum');
  const rawCandidates = own(opts, 'candidates');

  if (film !== null && (typeof film !== 'object' || Array.isArray(film))) {
    throw badArg('film 必须是纯对象或 null');
  }
  if (film !== null) {
    const outObj = own(film, 'output');
    if (outObj !== undefined) {
      if (!outObj || typeof outObj !== 'object' || Array.isArray(outObj)) {
        throw badArg('film.output 必须是纯对象');
      }
      const f = own(outObj, 'frames');
      if (f !== undefined && (!Number.isSafeInteger(f) || f < 1)) {
        throw badArg('film.output.frames 必须是正整数');
      }
    }
    const shotsVal = own(film, 'shots');
    if (shotsVal !== undefined && !Array.isArray(shotsVal)) {
      throw badArg('film.shots 必须是数组');
    }
    const predsVal = own(film, 'predicates');
    if (predsVal !== undefined && (!predsVal || typeof predsVal !== 'object' || Array.isArray(predsVal))) {
      throw badArg('film.predicates 必须是纯对象');
    }
  }
  if (question !== null && (typeof question !== 'object' || Array.isArray(question))) {
    throw badArg('question 必须是纯对象或 null');
  }
  if (question !== null) {
    const qBase = own(question, 'basePredicates');
    if (qBase !== undefined && !Array.isArray(qBase)) {
      throw badArg('question.basePredicates 必须是数组');
    }
  }

  let maxFrames;
  if (rawTotalFrames !== undefined) {
    if (!Number.isSafeInteger(rawTotalFrames) || rawTotalFrames < 1) {
      throw badArg('totalFrames 必须是正整数');
    }
    maxFrames = rawTotalFrames;
  } else if (film && own(film, 'output') && typeof own(film, 'output') === 'object' && own(own(film, 'output'), 'frames') !== undefined) {
    const f = own(own(film, 'output'), 'frames');
    if (!Number.isSafeInteger(f) || f < 1) {
      throw badArg('film.output.frames 必须是正整数');
    }
    maxFrames = f;
  } else {
    maxFrames = Infinity;
  }

  let quorum = 2;
  if (rawQuorum !== undefined) {
    if (!Number.isSafeInteger(rawQuorum) || rawQuorum < 2) {
      throw badArg('quorum 必须是 >= 2 的整数');
    }
    quorum = rawQuorum;
  }

  const knownCandidates = extractKnownCandidates(rawCandidates);
  const seenSlots = new Set();
  const implicitVoteCounter = new Map();
  const groupedOpinions = new Map();
  const rejectedOpinions = [];
  const ballotGrades = [];
  const candidateVoteMap = new Map();
  const predicateVoteCounts = new Map();
  const ballotEntries = [];

  for (let bIdx = 0; bIdx < ballots.length; bIdx++) {
    const ballot = ballots[bIdx];
    if (!ballot || typeof ballot !== 'object' || Array.isArray(ballot)) {
      throw badArg(`选票 ballots[${bIdx}] 必须是对象`);
    }

    const rawPerspective = own(ballot, 'perspective');
    let perspective = 'composition-readability';
    if (rawPerspective !== undefined) {
      if (typeof rawPerspective !== 'string' || !PERSPECTIVE_INDEX.has(rawPerspective)) {
        throw badArg(`选票 ballots[${bIdx}] 的视角 ${safeLabel(rawPerspective)} 不合法`);
      }
      perspective = rawPerspective;
    }

    const rawVoteIndex = own(ballot, 'voteIndex');
    let voteIndex;
    if (rawVoteIndex !== undefined) {
      if (!Number.isSafeInteger(rawVoteIndex) || rawVoteIndex < 0) {
        throw badArg(`选票 ballots[${bIdx}] 的 voteIndex 必须是非负安全整数`);
      }
      voteIndex = rawVoteIndex;
      const slotKey = `${perspective}:${voteIndex}`;
      if (seenSlots.has(slotKey)) {
        throw badArg(`选票重复：视角 ${perspective} 的第 ${voteIndex} 票重复出现`);
      }
      seenSlots.add(slotKey);
    } else {
      let nextIdx = implicitVoteCounter.get(perspective) ?? 0;
      while (seenSlots.has(`${perspective}:${nextIdx}`)) nextIdx++;
      voteIndex = nextIdx;
      implicitVoteCounter.set(perspective, nextIdx + 1);
      seenSlots.add(`${perspective}:${voteIndex}`);
    }

    const grade = own(ballot, 'grade');
    if (grade !== undefined) {
      if (typeof grade !== 'string' || !L5_GRADES.includes(grade)) {
        throw badArg(`选票 ballots[${bIdx}] 的等级词 ${safeLabel(grade)} 不合法`);
      }
      ballotGrades.push(grade);
    }

    const ordering = own(ballot, 'candidateOrdering') !== undefined
      ? own(ballot, 'candidateOrdering')
      : own(ballot, 'candidateOrder');
    let validatedOrdering = null;
    if (ordering !== undefined) {
      if (!Array.isArray(ordering)) {
        throw badArg(`选票 ballots[${bIdx}] 的 candidateOrder 必须是字符串数组`);
      }
      const orderSet = new Set();
      validatedOrdering = [];
      for (let i = 0; i < ordering.length; i++) {
        const cid = ordering[i];
        if (typeof cid !== 'string' || !cid.trim()) {
          throw badArg(`选票 ballots[${bIdx}] 的 candidateOrder[${i}] 必须是非空字符串`);
        }
        const trimmed = cid.trim();
        if (orderSet.has(trimmed)) {
          throw badArg(`选票 ballots[${bIdx}] 的 candidateOrder 包含重复候选 ID：${trimmed}`);
        }
        if (knownCandidates && !knownCandidates.has(trimmed)) {
          throw badArg(`选票 ballots[${bIdx}] 的 candidateOrder 包含未知候选 ID：${trimmed}`);
        }
        orderSet.add(trimmed);
        validatedOrdering.push(trimmed);
      }
    }

    const allowedBallotCandidates = knownCandidates ?? (validatedOrdering ? new Set(validatedOrdering) : null);
    const rawCandidateGrades = own(ballot, 'candidateGrades');
    let validatedCandidateGrades;
    if (rawCandidateGrades !== undefined) {
      if (!Array.isArray(rawCandidateGrades)) {
        throw badArg(`选票 ballots[${bIdx}] 的 candidateGrades 必须是数组`);
      }
      const seenCandidateIds = new Set();
      validatedCandidateGrades = [];
      for (let i = 0; i < rawCandidateGrades.length; i++) {
        const cg = rawCandidateGrades[i];
        const cgId = cg && typeof cg === 'object' && !Array.isArray(cg) ? own(cg, 'id') : undefined;
        const cgGrade = cg && typeof cg === 'object' && !Array.isArray(cg) ? own(cg, 'grade') : undefined;
        if (typeof cgId !== 'string' || !cgId.trim() || typeof cgGrade !== 'string' || !L5_GRADES.includes(cgGrade)) {
          throw badArg(`选票 ballots[${bIdx}] 的 candidateGrades[${i}] 项不合法`);
        }
        const trimmedId = cgId.trim();
        if (seenCandidateIds.has(trimmedId)) {
          throw badArg(`选票 ballots[${bIdx}] 的 candidateGrades 存在重复候选 ID：${trimmedId}`);
        }
        if (allowedBallotCandidates && !allowedBallotCandidates.has(trimmedId)) {
          throw badArg(`选票 ballots[${bIdx}] 包含未知候选 ID：${trimmedId}`);
        }
        seenCandidateIds.add(trimmedId);
        validatedCandidateGrades.push({ id: trimmedId, grade: cgGrade });
        if (!candidateVoteMap.has(trimmedId)) candidateVoteMap.set(trimmedId, []);
        candidateVoteMap.get(trimmedId).push(cgGrade);
      }
    }

    const ballotOpinions = own(ballot, 'opinions');
    if (!Array.isArray(ballotOpinions)) {
      throw badArg(`选票 ballots[${bIdx}] 缺少 opinions 数组`);
    }

    const ballotPredicates = new Set();
    const rawSuggestedPredicates = own(ballot, 'suggestedPredicates');
    if (rawSuggestedPredicates !== undefined) {
      if (!Array.isArray(rawSuggestedPredicates)) {
        throw badArg(`选票 ballots[${bIdx}] 的 suggestedPredicates 必须是数组`);
      }
      for (let i = 0; i < rawSuggestedPredicates.length; i++) {
        const sp = rawSuggestedPredicates[i];
        if (typeof sp !== 'string' || !sp.trim()) {
          throw badArg(`选票 ballots[${bIdx}] 的 suggestedPredicates[${i}] 必须是非空字符串`);
        }
        ballotPredicates.add(sp.trim());
      }
    }

    const ballotSlotKey = `${perspective}:${voteIndex}`;
    const validOpinionsForSummary = [];
    let rejectedCountForBallot = 0;

    for (let i = 0; i < ballotOpinions.length; i++) {
      const op = validateBallotOpinion(ballotOpinions[i], i, maxFrames);
      const normKey = op.rawIssueKey ? normalizeIssueKey(op.rawIssueKey, perspective) : null;
      if (!normKey) {
        rejectedCountForBallot++;
        rejectedOpinions.push({
          perspective,
          voteIndex,
          issueKey: op.rawIssueKey ?? null,
          frames: op.frames,
          reason: op.rawIssueKey
            ? `issueKey "${op.rawIssueKey}" 不在视角 ${perspective} 的封闭类别表内`
            : `缺少视角 ${perspective} 的封闭 issueKey`,
        });
        continue;
      }
      if (op.suggestedPredicate) ballotPredicates.add(op.suggestedPredicate);
      const entry = {
        perspective,
        voteIndex,
        ballotSlotKey,
        issueKey: normKey,
        frames: op.frames,
        severity: op.severity,
        evidence: op.evidence,
        comment: op.comment,
        ...(op.suggestedPredicate ? { suggestedPredicate: op.suggestedPredicate } : {}),
      };
      validOpinionsForSummary.push({
        issueKey: normKey,
        frames: op.frames,
        severity: op.severity,
        evidence: op.evidence,
        comment: op.comment,
        ...(op.suggestedPredicate ? { suggestedPredicate: op.suggestedPredicate } : {}),
      });
      const groupKey = `${perspective}\0${normKey}`;
      if (!groupedOpinions.has(groupKey)) groupedOpinions.set(groupKey, []);
      groupedOpinions.get(groupKey).push(entry);
    }

    for (const sp of ballotPredicates) {
      predicateVoteCounts.set(sp, (predicateVoteCounts.get(sp) ?? 0) + 1);
    }

    ballotEntries.push({
      perspective,
      voteIndex,
      ...(grade !== undefined ? { grade } : {}),
      ...(validatedOrdering ? { candidateOrder: validatedOrdering } : {}),
      ...(validatedCandidateGrades ? { candidateGrades: validatedCandidateGrades } : {}),
      opinionCount: validOpinionsForSummary.length,
      rejectedOpinionCount: rejectedCountForBallot,
      opinions: validOpinionsForSummary,
      suggestedPredicates: [...ballotPredicates].sort(compareStrings),
    });
  }

  ballotEntries.sort(
    (a, b) => (PERSPECTIVE_INDEX.get(a.perspective) - PERSPECTIVE_INDEX.get(b.perspective)) || (a.voteIndex - b.voteIndex),
  );

  const candidateOrderings = ballotEntries
    .filter((b) => Array.isArray(b.candidateOrder))
    .map((b) => [...b.candidateOrder]);

  // 与选票输入顺序完全无关的连通分量聚类：按 (perspective, issueKey) 分组、按帧段排序后合并重叠或相邻帧段
  const clusters = [];
  for (const entries of groupedOpinions.values()) {
    entries.sort((a, b) =>
      (a.frames[0] - b.frames[0])
      || (a.frames[1] - b.frames[1])
      || (a.voteIndex - b.voteIndex)
      || compareStrings(a.comment, b.comment)
      || compareStrings(a.evidence, b.evidence),
    );
    let current = null;
    for (let i = 0; i < entries.length; i++) {
      const op = entries[i];
      if (!current || op.frames[0] > current.frames[1] + 1) {
        current = {
          perspective: op.perspective,
          issueKey: op.issueKey,
          frames: [op.frames[0], op.frames[1]],
          members: [op],
          ballotSlots: new Set([op.ballotSlotKey]),
          suggestedPredicates: new Set(op.suggestedPredicate ? [op.suggestedPredicate] : []),
        };
        clusters.push(current);
      } else {
        current.frames[1] = Math.max(current.frames[1], op.frames[1]);
        current.members.push(op);
        current.ballotSlots.add(op.ballotSlotKey);
        if (op.suggestedPredicate) current.suggestedPredicates.add(op.suggestedPredicate);
      }
    }
  }

  const opinions = [];
  let discardedOpinionCount = 0;
  const acceptedPredicateCandidates = [];

  clusters.sort((a, b) =>
    (a.frames[0] - b.frames[0])
    || (a.frames[1] - b.frames[1])
    || (PERSPECTIVE_INDEX.get(a.perspective) - PERSPECTIVE_INDEX.get(b.perspective))
    || compareStrings(a.issueKey, b.issueKey),
  );

  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const votes = c.ballotSlots.size;
    if (votes >= quorum) {
      const sortedMembers = [...c.members].sort((a, b) =>
        ((SEVERITY_RANK[b.severity] ?? 1) - (SEVERITY_RANK[a.severity] ?? 1))
        || (a.frames[0] - b.frames[0])
        || (a.frames[1] - b.frames[1])
        || (a.voteIndex - b.voteIndex)
        || compareStrings(a.evidence, b.evidence)
        || compareStrings(a.comment, b.comment),
      );
      const rep = sortedMembers[0];
      opinions.push({
        perspective: c.perspective,
        issueKey: c.issueKey,
        frames: c.frames,
        severity: rep.severity,
        evidence: rep.evidence,
        comment: rep.comment,
        votes,
        perspectives: [c.perspective],
      });
      for (const sp of [...c.suggestedPredicates].sort(compareStrings)) {
        if ((predicateVoteCounts.get(sp) ?? 0) >= quorum && !acceptedPredicateCandidates.includes(sp)) {
          acceptedPredicateCandidates.push(sp);
        }
      }
    } else {
      discardedOpinionCount++;
    }
  }

  for (const sp of [...predicateVoteCounts.keys()].sort(compareStrings)) {
    if (predicateVoteCounts.get(sp) >= quorum && !acceptedPredicateCandidates.includes(sp)) {
      acceptedPredicateCandidates.push(sp);
    }
  }

  const filtered = filterL5SuggestedPredicates(acceptedPredicateCandidates, { film, question });
  const gradeStats = ballotGrades.length
    ? pickMajorityGrade(ballotGrades)
    : { grade: null, counts: { 好: 0, 一般: 0, 差: 0 } };

  let overallGrade = gradeStats.grade
    ?? (opinions.some((o) => o.severity === 'error' || o.severity === 'high')
      ? '差'
      : (opinions.length > 0 || discardedOpinionCount > 0 || rejectedOpinions.length > 0 ? '一般' : '好'));

  if (opinions.length === 0 && (discardedOpinionCount > 0 || rejectedOpinions.length > 0) && overallGrade === '好') {
    overallGrade = '一般';
  }

  const candidateGrades = {};
  for (const cid of [...candidateVoteMap.keys()].sort(compareStrings)) {
    candidateGrades[cid] = pickMajorityGrade(candidateVoteMap.get(cid));
  }

  rejectedOpinions.sort((a, b) =>
    (PERSPECTIVE_INDEX.get(a.perspective) - PERSPECTIVE_INDEX.get(b.perspective))
    || (a.voteIndex - b.voteIndex)
    || (a.frames[0] - b.frames[0])
    || (a.frames[1] - b.frames[1])
    || compareStrings(a.issueKey ?? '', b.issueKey ?? '')
    || compareStrings(a.reason, b.reason),
  );

  return {
    totalBallots: ballots.length,
    quorum,
    grade: overallGrade,
    gradeCounts: gradeStats.counts,
    ballots: ballotEntries,
    candidateOrderings,
    candidateGrades,
    opinions,
    discardedOpinionCount,
    rejectedOpinions,
    rawSuggestedPredicates: acceptedPredicateCandidates,
    suggestedPredicates: filtered.suggestedPredicates,
    validatedExtraPredicates: filtered.validatedExtraPredicates,
    rejectedPredicates: filtered.rejectedPredicates,
    overridesHardGates: false,
  };
}
