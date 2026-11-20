import { compareVersions, getCardStatus, getStatusLevel, isCalendarDate, parseVersion, statusLevels } from './status.mjs';

const maxResults = 5;
const summaryTokenBudget = 300;

/** 字符串按传入文本，其他值按 JSON 序列化后，以每 UTF-8 字节一个 token 估算。 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.byteLength(text, 'utf8');
}

function fitText(text, budget) {
  let result = '';
  for (const point of text) {
    const size = estimateTokens(JSON.stringify(point)) - 2;
    if (size > budget) break;
    result += point;
    budget -= size;
  }
  return result;
}

function summarize(card, statusLevel, recentUsesInLast10Films, onDiagnostic) {
  const summary = {
    id: card.id,
    version: card.version,
    kind: card.kind,
    title: '',
    intent: '',
    lives_in: [...card.livesIn],
    statusLevel,
    recentUsesInLast10Films,
  };
  const fixedBytes = estimateTokens(summary);
  const textBudget = summaryTokenBudget - fixedBytes;
  if (textBudget >= 0) {
    const titleBudget = Math.max(Math.floor(textBudget / 2), textBudget - (estimateTokens(JSON.stringify(card.intent)) - 2));
    summary.title = fitText(card.title, titleBudget);
    summary.intent = fitText(card.intent, summaryTokenBudget - estimateTokens(summary));
  }
  const omitted = estimateTokens(summary) > summaryTokenBudget;
  if (omitted || (card.title && !summary.title) || (card.intent && !summary.intent)) {
    onDiagnostic?.({ code: 'summary-budget', id: card.id, version: card.version, fixedBytes,
      budgetBytes: summaryTokenBudget, omitted });
  }
  return omitted ? null : summary;
}

// 片子按首次出现登记，记录从旧到新。只有 filmId 的记录也占窗口位置。
function indexUsage(records, recentFilmsWindow) {
  const filmOrder = [...new Set(records.map(({ filmId }) => filmId).filter(Boolean))];
  const recent = new Set(filmOrder.slice(Math.max(0, filmOrder.length - recentFilmsWindow)));
  const byCard = new Map();
  for (const { filmId, cardId, version } of records) {
    if (!filmId || !cardId) continue;
    if (!byCard.has(cardId)) byCard.set(cardId, []);
    byCard.get(cardId).push({ filmId, version });
  }
  return (card) => {
    const uses = (byCard.get(card.id) ?? []).filter(({ version }) => version === undefined || version === card.version);
    const recentUses = new Set(uses.filter(({ filmId }) => recent.has(filmId)).map(({ filmId }) => filmId)).size;
    return { totalUses: uses.length, recentUses };
  };
}

function metadata(card, key) {
  const namespaced = `registry.${key}`;
  if (card.ext && Object.hasOwn(card.ext, namespaced)) return card.ext[namespaced];
  return Object.hasOwn(card, key) ? card[key] : undefined;
}

function examAverage(card) {
  const results = metadata(card, 'examScores') ?? {};
  const scores = (card.exams ?? [])
    .filter((exam) => Object.hasOwn(results, exam) && Number.isFinite(results[exam]))
    .map((exam) => results[exam]);
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : -Infinity;
}

function hasKeyword(value, keyword) {
  if (typeof value === 'string') return value.toLowerCase().includes(keyword);
  return value !== null && typeof value === 'object' && Object.values(value).some((item) => hasKeyword(item, keyword));
}

function highestStatusLevel(card) {
  return (card.status ?? []).reduce((highest, { level }) => Math.max(highest, getStatusLevel(level)), -1);
}

function compareResults(left, right) {
  return right.statusLevel - left.statusLevel
    || (right.score === left.score ? 0 : right.score > left.score ? 1 : -1)
    || right.totalUses - left.totalUses
    || (left.cost === right.cost ? 0 : left.cost < right.cost ? -1 : 1)
    || (left.card.id < right.card.id ? -1 : Number(left.card.id > right.card.id));
}

/** 注册有效卡文件。候选、弃用和考题分数可写在 registry 命名空间的 ext 中。 */
export function createCardRegistry(cards, {
  allowReproduced = false,
  allowReproducedUntilDate,
  nowDate,
  recentFilmsWindow = 10,
  usageRecords = [],
} = {}) {
  if (!Number.isSafeInteger(recentFilmsWindow) || recentFilmsWindow < 0) throw new RangeError('最近成片窗口必须是非负整数');
  const inWindow = isCalendarDate(nowDate) && isCalendarDate(allowReproducedUntilDate) && nowDate <= allowReproducedUntilDate;
  const usageFor = indexUsage(usageRecords, recentFilmsWindow);
  const byId = new Map();
  const activeByRef = new Map();
  for (const input of cards) {
    const card = structuredClone(input);
    const version = parseVersion(card.version);
    if (!version) throw new TypeError('注册卡需要三段十进制版本');
    const row = { card, version, score: examAverage(card), ...usageFor(card) };
    const latest = byId.get(card.id);
    if (!latest || compareVersions(version, latest.version) > 0) byId.set(card.id, row);
    if (metadata(card, 'deprecated') === true) continue;
    const ref = `${card.id}@${version[0]}`;
    const active = activeByRef.get(ref);
    if (!active || compareVersions(version, active.version) > 0) activeByRef.set(ref, row);
  }

  function getCard(idOrMajorRef) {
    if (typeof idOrMajorRef !== 'string') return null;
    let row = byId.get(idOrMajorRef);
    if (!row) {
      const ref = /^([^@]+)@([0-9]+)$/.exec(idOrMajorRef);
      if (ref) row = activeByRef.get(`${ref[1]}@${BigInt(ref[2])}`);
    }
    return row ? structuredClone(row.card) : null;
  }

  // onDiagnostic 在匹配卡因预算缺少整段文本或整条摘要时收到通知。
  function searchCards({ kind, livesIn, source, minLevel, q, environmentKey, allowReproduced: relax, onDiagnostic } = {}) {
    if (minLevel !== undefined && (!Number.isInteger(minLevel) || minLevel < 0)) throw new RangeError('最低验证等级必须是非负整数');
    const visibleFloor = inWindow || allowReproduced === true || relax === true ? statusLevels.reproduced : statusLevels.measured;
    const requiredLevel = Math.max(visibleFloor, minLevel ?? visibleFloor);
    const keyword = q?.trim().toLowerCase();
    const matches = [];
    for (const row of activeByRef.values()) {
      const { card } = row;
      const visible = card.visibleToAgent ?? card.visible_to_agent ?? (card.kind !== 'mechanism');
      if (!visible || metadata(card, 'candidate') === true) continue;
      if (kind !== undefined && card.kind !== kind) continue;
      if (livesIn !== undefined && !card.livesIn.includes(livesIn)) continue;
      if (source !== undefined && !card.livesIn.includes(`source:${source}`)) continue;
      if (keyword && !hasKeyword(card, keyword)) continue;
      const environmentStatus = environmentKey === undefined ? null : getCardStatus(card, environmentKey);
      const statusLevel = environmentStatus ? (environmentStatus.statusLevel ?? -1) : highestStatusLevel(card);
      if (statusLevel < requiredLevel) continue;
      const costs = (card.cost ?? []).filter(({ host }) => !environmentStatus || host === environmentStatus.host);
      const cost = costs.reduce((lowest, { msPerFrame }) => Math.min(lowest, msPerFrame), Infinity);
      matches.push({ ...row, statusLevel, cost });
    }
    const summaries = [];
    for (const { card, statusLevel, recentUses } of matches.sort(compareResults)) {
      const summary = summarize(card, statusLevel, recentUses, onDiagnostic);
      if (summary) summaries.push(summary);
      if (summaries.length === maxResults) break;
    }
    return summaries;
  }

  return { getCard, searchCards };
}
