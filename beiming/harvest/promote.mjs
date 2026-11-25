import { isCalendarDate } from '../cards/status.mjs';
import { validateCard } from '../cards/validate-card.mjs';

export const PROMOTION_MIN_FILMS = 2;

export function requireDate(asOf) {
  if (!isCalendarDate(asOf)) throw new RangeError('asOf 必须是 YYYY-MM-DD 日历日期');
}

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
const refused = (code) => ({ ok: false, code: `harvest.${code}` });

function hasReuse(row) {
  return Number.isSafeInteger(row?.usedCount) && row.usedCount >= PROMOTION_MIN_FILMS
    && Array.isArray(row.usedByFilms) && row.usedByFilms.every(hasText)
    && new Set(row.usedByFilms.map((id) => id.trim())).size >= PROMOTION_MIN_FILMS;
}

export function createPromotionProposal(item, { asOf } = {}) {
  requireDate(asOf);
  if (!hasReuse(item)) return refused('insufficient-reuse');
  return globalThis.structuredClone({ ok: true, itemId: item.id, proposedAt: asOf, candidate: item.candidate,
    usedCount: item.usedCount, usedByFilms: item.usedByFilms, unlocksExams: item.unlocksExams,
    authorSessionIds: item.authorSessionIds ?? [] });
}

/** 单独调用可检查提案；传入 queue 时由队列从当前记录重新核证，成功才写入晋升历史。 */
export function promoteCandidateCard(proposal, evidence = {}, { asOf, queue } = {}) {
  requireDate(asOf);
  if (queue) return queue.promote(proposal, evidence, { asOf });
  if (!hasReuse(proposal)) return refused('insufficient-reuse');
  const { candidate } = proposal;
  if (candidate?.kind !== 'module' || candidate.mergeIntoCard || candidate.cardDraft?.ext?.['registry.candidate'] !== true) return refused('not-candidate-card');
  const author = candidate.authorSessionId;
  const agent = evidence.harvestAgentSessionId;
  const authors = [author, ...(proposal.authorSessionIds ?? [])];
  if (!hasText(agent) || authors.some((id) => !hasText(id) || id.trim() === agent.trim())
      || (evidence.authorSessionId !== undefined && evidence.authorSessionId !== author)) {
    return refused('independent-agent-required');
  }
  if (!isCalendarDate(proposal.proposedAt) || asOf < proposal.proposedAt) return refused('invalid-promotion-date');

  const missing = ['selftestPassed', 'calibrationPassed', 'pureFunctionGatePassed'].filter((key) => evidence[key] !== true);
  const promotedCard = globalThis.structuredClone(candidate.cardDraft);
  // 外部恢复的快照也可能含残缺草稿；返回契约诊断，不在抄参数时抛出异常。
  if (!promotedCard.params || typeof promotedCard.params !== 'object' || Array.isArray(promotedCard.params)
      || Object.values(promotedCard.params).some((p) => !p || typeof p !== 'object' || Array.isArray(p))) {
    return { ...refused('invalid-card'), validation: validateCard(promotedCard) };
  }
  const units = evidence.confirmedUnits ?? {};
  for (const [name, param] of Object.entries(promotedCard.params)) {
    if (Object.hasOwn(units, name)) param.unit = units[name];
    const unconfirmed = candidate.params?.[name]?.unitUnconfirmed || param.unitUnconfirmed;
    if (!hasText(param.unit) || param.unit.trim() === '待确认' || (unconfirmed && !Object.hasOwn(units, name))) {
      missing.push(`params.${name}.unit`);
    }
    delete param.unitUnconfirmed;
  }
  const { host, source, gpu } = evidence;
  for (const key of ['host', 'source', 'gpu']) if (!hasText(evidence[key])) missing.push(key);
  if (missing.length) return { ...refused('missing-evidence'), missing };

  delete promotedCard.ext?.['registry.candidate'];
  promotedCard.status = [{ level: 'reproduced', host, source, gpu, date: asOf }];
  promotedCard.exams = [...new Set([...(promotedCard.exams ?? []), ...(proposal.unlocksExams ?? [])])];
  const validation = validateCard(promotedCard);
  if (!validation.ok) return { ...refused('invalid-card'), validation };
  return { ok: true, promotedCard };
}
