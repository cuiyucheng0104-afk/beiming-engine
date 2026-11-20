import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const statusLevels = Object.freeze({ read: 0, reproduced: 1, measured: 2, 'film-verified': 3 });
const sha256 = /^[0-9a-f]{64}$/;
const parityHash = /^sha256:[0-9a-f]{64}$/;

export function parseVersion(version) {
  return typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)
    ? version.split('.').map((part) => BigInt(part))
    : null;
}

export function compareVersions(left, right) {
  for (const [index, part] of left.entries()) {
    if (part < right[index]) return -1;
    if (part > right[index]) return 1;
  }
  return 0;
}

export function getStatusLevel(level) {
  return typeof level === 'string' && Object.hasOwn(statusLevels, level) ? statusLevels[level] : -1;
}

/** 宿主、版本或显卡名含分隔符时，转义后再组合。 */
export function makeStatusKey({ host, source, gpu } = {}) {
  const parts = [host, source, gpu];
  if (parts.some((part) => typeof part !== 'string' || part.length === 0)) return null;
  return parts.map((part) => part.replaceAll('%', '%25').replaceAll('/', '%2F')).join('/');
}

export function getCardStatus(card, environmentKey) {
  const found = typeof environmentKey === 'string'
    ? card.status?.find((status) => environmentKey === makeStatusKey(status))
    : undefined;
  const statusLevel = getStatusLevel(found?.level);
  return statusLevel < 0 ? { level: 'unverified', statusLevel: null } : { ...found, statusLevel };
}

/** 校验注入的日历日期，全程不读墙钟。 */
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1];
}

export function verifyStatusUpdateAuthor(prevCard, nextCard, { actorRole } = {}) {
  if (isDeepStrictEqual(prevCard?.status, nextCard?.status)) return { ok: true, violations: [] };
  if (actorRole !== 'reviewer') {
    return { ok: false, violations: [{ code: 'status-reviewer-required' }] };
  }
  if (!Array.isArray(nextCard?.status) || !nextCard.status.length) {
    return { ok: false, violations: [{ code: 'invalid-status' }] };
  }

  const previous = new Map((prevCard?.status ?? []).map((item) => [makeStatusKey(item), item]));
  const seen = new Set();
  const violations = [];
  for (const item of nextCard.status) {
    const key = item && makeStatusKey(item);
    const level = getStatusLevel(item?.level);
    if (!key || level < 0 || seen.has(key)) {
      violations.push({ code: 'invalid-status', key });
      continue;
    }
    seen.add(key);
    if (isDeepStrictEqual(previous.get(key), item)) continue;
    if (level >= statusLevels.measured && (typeof item.parityReport !== 'string' || !parityHash.test(item.parityReport))) {
      violations.push({ code: 'parity-report-required', key });
    }
    if (!isCalendarDate(item.date)) violations.push({ code: 'invalid-status-date', key });
  }
  return { ok: violations.length === 0, violations };
}

/** 比较按实施文件相对路径登记的哈希，并检查需要升主版本的变更。 */
export function checkVersionBump(prevCard, prevImplHashes, nextCard, nextImplHashes) {
  const prev = parseVersion(prevCard.version);
  const next = parseVersion(nextCard.version);
  if (!prev || !next) return { ok: false, violations: [{ code: 'invalid-version' }] };

  const violations = [];
  if (!isDeepStrictEqual(prevImplHashes, nextImplHashes) && compareVersions(next, prev) <= 0) {
    violations.push({ code: 'implementation-version-bump-required' });
  }

  if (next[0] <= prev[0]) {
    const outputPorts = (card) => (card.ports?.out ?? []).map(({ name, type }) => `${name}:${type}`).sort();
    const previousGates = prevCard.verify?.parity?.gates;
    if (!isDeepStrictEqual(outputPorts(prevCard), outputPorts(nextCard))
      || (previousGates !== undefined && !isDeepStrictEqual(previousGates, nextCard.verify?.parity?.gates))) {
      violations.push({ code: 'parity-output-major-bump-required' });
    }
    for (const name of Object.keys(prevCard.params ?? {})) {
      if (!Object.hasOwn(nextCard.params ?? {}, name)) {
        violations.push({ code: 'parameter-removal-major-bump-required', param: name });
      }
    }
    const nextLandings = new Set(nextCard.livesIn ?? []);
    if ((prevCard.livesIn ?? []).some((landing) => !nextLandings.has(landing))) {
      violations.push({ code: 'data-landing-major-bump-required' });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** 输入卡目录全部文件的相对路径和内容摘要，返回锁文件所用的卡摘要。 */
export function hashCardContents(fileHashes) {
  const files = Object.entries(fileHashes);
  if (!files.length) throw new TypeError('卡目录摘要至少需要一个文件');
  for (const [path, hash] of files) {
    if (typeof path !== 'string' || !path.isWellFormed() || /[:\\\r\n\0]/.test(path)
      || path.split('/').some((part) => !part || part === '.' || part === '..')
      || typeof hash !== 'string' || !sha256.test(hash)) {
      throw new TypeError('卡目录摘要需要合法的相对路径和小写 SHA-256');
    }
  }
  files.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const digest = createHash('sha256');
  for (const [path, hash] of files) digest.update(`${path}\n${hash}\n`);
  return digest.digest('hex');
}

export function verifyCardLock(card, fileHashes, lockEntry) {
  const violations = [];
  if (!parseVersion(card.version) || card.version !== lockEntry?.version) violations.push({ code: 'lock-version-mismatch' });
  try {
    if (hashCardContents(fileHashes) !== lockEntry?.sha256) violations.push({ code: 'lock-hash-mismatch' });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    violations.push({ code: 'invalid-file-manifest' });
  }
  return { ok: violations.length === 0, violations };
}
