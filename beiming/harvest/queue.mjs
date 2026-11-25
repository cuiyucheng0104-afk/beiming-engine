import { computeCandidateKey, isSameThing } from './draft.mjs';
import { createPromotionProposal, promoteCandidateCard, PROMOTION_MIN_FILMS, requireDate } from './promote.mjs';

export const MAX_QUEUE_SIZE = 30;
export const EXPIRY_DAYS = 14;
export { PROMOTION_MIN_FILMS };

export function daysBetween(from, to) {
  requireDate(from);
  requireDate(to);
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

const text = (s) => typeof s === 'string' && s.trim().length > 0;
const union = (a, b) => [...new Set([...a, ...b])];
const compare = (a, b) => a < b ? -1 : Number(a > b);
const oldest = (a, b) => compare(a.lastUsedAt, b.lastUsedAt) || compare(a.createdAt, b.createdAt) || compare(a.id, b.id);

function textSet(values) {
  if (!Array.isArray(values) || !values.every(text)) throw new TypeError('需要非空字符串数组');
  return [...new Set(values.map((s) => s.trim()))];
}

/** initialState 接收 getState() 的纯数据快照；三个集合分别保存待审、归档、已晋升条目。 */
export function createHarvestQueue(initialState = {}) {
  const { pending = [], archived = [], promoted = [] } = globalThis.structuredClone(initialState);
  if (![pending, archived, promoted].every(Array.isArray) || pending.length > MAX_QUEUE_SIZE) throw new RangeError('队列快照无效');
  const ids = new Set();
  for (const row of [...pending, ...archived, ...promoted]) {
    requireDate(row.createdAt);
    requireDate(row.lastUsedAt);
    if (!text(row.id) || ids.has(row.id) || row.createdAt > row.lastUsedAt || !row.usedCount
        || textSet(row.usedByFilms).length !== row.usedCount || row.usedByFilms.length !== row.usedCount) throw new TypeError('无效的候选追踪信息');
    textSet(row.unlocksExams);
    ids.add(row.id);
  }

  function archive(row, asOf, reason) {
    pending.splice(pending.indexOf(row), 1);
    const record = { ...row, archivedAt: asOf, archivedReason: reason };
    archived.push(record);
    return record;
  }

  function enqueue(candidate, { asOf, filmId, unlocksExams = [] } = {}) {
    requireDate(asOf);
    if (!text(filmId)) throw new TypeError('每次使用都需要 filmId');
    const film = filmId.trim();
    const exams = textSet(unlocksExams);
    const key = computeCandidateKey(candidate);
    const existing = pending.find((row) => isSameThing(row.candidate, candidate));
    const authors = text(candidate.authorSessionId) ? [candidate.authorSessionId.trim()] : [];
    if (existing) {
      if (asOf < existing.lastUsedAt) throw new RangeError('复用日期早于上次使用');
      existing.usedByFilms = union(existing.usedByFilms, [film]);
      existing.usedCount = existing.usedByFilms.length;
      existing.unlocksExams = union(existing.unlocksExams, exams);
      existing.authorSessionIds = union(existing.authorSessionIds, authors);
      existing.lastUsedAt = asOf;
      if (!existing.promotionProposal && existing.usedCount >= PROMOTION_MIN_FILMS) {
        existing.promotionProposal = createPromotionProposal(existing, { asOf });
        existing.promotionEligible = true;
      }
      return globalThis.structuredClone(existing);
    }

    let seq = ids.size + 1;
    while (ids.has(`candidate-${seq}`)) seq++;
    const row = { id: `candidate-${seq}`, key, candidate: globalThis.structuredClone(candidate), createdAt: asOf, lastUsedAt: asOf,
      usedByFilms: [film], usedCount: 1, unlocksExams: exams, authorSessionIds: authors,
      promotionEligible: false, promotionProposal: null };
    if (pending.length === MAX_QUEUE_SIZE) archive([...pending].sort(oldest)[0], asOf, 'evicted-lru');
    ids.add(row.id);
    pending.push(row);
    return globalThis.structuredClone(row);
  }

  function pruneExpired({ asOf } = {}) {
    requireDate(asOf);
    const expired = pending.filter((row) => row.usedCount < PROMOTION_MIN_FILMS && daysBetween(row.createdAt, asOf) > EXPIRY_DAYS);
    return globalThis.structuredClone(expired.map((row) => archive(row, asOf, 'expired-14d')));
  }

  function promote(proposal, evidence, { asOf } = {}) {
    requireDate(asOf);
    if (proposal?.code === 'harvest.insufficient-reuse') return { ok: false, code: proposal.code };
    const row = pending.find((item) => item.id === proposal?.itemId);
    if (!row) return { ok: false, code: 'harvest.not-pending' };
    if (!row.promotionProposal) return { ok: false, code: 'harvest.insufficient-reuse' };
    // 不同队列的顺序 id 可能相同，不能拿另一张卡的提案和试跑证据作数。
    if (!proposal.candidate || computeCandidateKey(proposal.candidate) !== row.key
        || proposal.candidate.cardDraft?.id !== row.candidate.cardDraft?.id
        || proposal.proposedAt !== row.promotionProposal.proposedAt) return { ok: false, code: 'harvest.proposal-mismatch' };
    if (asOf < row.lastUsedAt) return { ok: false, code: 'harvest.invalid-promotion-date' };
    const current = createPromotionProposal(row, { asOf: row.promotionProposal.proposedAt });
    const result = promoteCandidateCard(current, evidence, { asOf });
    if (result.ok) {
      promoted.push({ ...row, promotedAt: asOf, promotedCard: globalThis.structuredClone(result.promotedCard) });
      pending.splice(pending.indexOf(row), 1);
    }
    return result;
  }

  function listCandidateCards() {
    return pending.filter(({ candidate: c }) => c.kind === 'module' && c.cardDraft && !c.mergeIntoCard).map(({ candidate }) => {
      const card = globalThis.structuredClone(candidate.cardDraft);
      card.ext = { ...card.ext, 'registry.candidate': true };
      return card;
    });
  }

  function getBoardHarvestStats() {
    return { drafted: ids.size, promoted: promoted.length, archived: archived.length,
      reproducedPromotions: promoted.filter((row) => row.promotedCard?.status?.some((s) => s.level === 'reproduced')).length };
  }

  return { enqueue, pruneExpired, promote, listCandidateCards, getBoardHarvestStats,
    getState: () => globalThis.structuredClone({ pending, archived, promoted }) };
}
