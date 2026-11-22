// 已发布作品的锁文件和基线核对。锁文件在 locks/<作品>.lock.json（lock/1.0，本机锁），按 film-upgrade 升级后的片子描述生成：
// 种子照锁文件契约 5.7 派生，卡的版本和摘要取自 beiming/cards 里的真卡，帧源锁 legacy-page 1.0.0 加 three 0.170.0（宿主都是 page）。
// 基线是 P9 的金标清单（tests/golden/<平台>/manifest.json），像素哈希口径 sha256("RGB8 <宽>x<高>\n" + RGB)，和 host.mjs 的 pixelHash 一致。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THREE_VERSION, VERSION } from './caps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// 只有《北冥》10 秒样片进了金标清单；晨渡、渡还没有基线，核对时如实报 no-baseline
const BEIMING_BASELINE = { manifest: 'tests/golden/darwin-metal/manifest.json', sets: ['beiming-core', 'beiming-detail'], page: 'film' };
export const PUBLISHED_LOCKS = Object.freeze({
  'beiming-10s': { lockFile: 'locks/beiming-10s.lock.json', baseline: BEIMING_BASELINE },
  chendu: { lockFile: 'locks/chendu.lock.json', baseline: null },
  du: { lockFile: 'locks/du.lock.json', baseline: null },
});
export const PUBLISHED_WORKS = Object.freeze(Object.keys(PUBLISHED_LOCKS));

const entryOf = (workId) => {
  if (!Object.hasOwn(PUBLISHED_LOCKS, workId)) throw new RangeError(`不是已发布作品：${workId}（有 ${PUBLISHED_WORKS.join('、')}）`);
  return PUBLISHED_LOCKS[workId];
};

/** 读作品的锁文件（lock/1.0） */
export function loadLegacyLock(workId) {
  return readJson(path.join(HERE, entryOf(workId).lockFile));
}

/** 基线里这部作品的成片帧：{ 帧标识: 'sha256:<像素哈希>' }。调试参数（query）出的帧不是成片，不算；没有基线返回 {} */
export function getBaselineHashes(workId, { repoRoot = REPO } = {}) {
  const { baseline } = entryOf(workId);
  if (!baseline) return {};
  const manifest = readJson(path.join(repoRoot, baseline.manifest));
  const out = {};
  for (const name of baseline.sets) {
    for (const fr of manifest.sets?.[name]?.frames ?? []) {
      if (fr.page === baseline.page && !fr.query) out[fr.id] = `sha256:${fr.pixelSha256}`;
    }
  }
  return out;
}

/**
 * 按锁核对出片的像素哈希和基线是否逐帧一致。renderedHashes 是 { 帧标识: 'sha256:…' }，帧标识和基线清单一致。
 * 返回 { ok, mismatched: [帧标识], missing: [帧标识], reason? }：锁的帧源版本对不上基线的出片环境、没有基线都算不过。
 */
export function verifyBaselineHashes(workId, renderedHashes, { repoRoot = REPO } = {}) {
  const { baseline } = entryOf(workId);
  const fail = (reason) => ({ ok: false, mismatched: [], missing: [], reason });
  if (!baseline) return fail('no-baseline');
  const lock = loadLegacyLock(workId);
  if (lock.sources?.['legacy-page']?.version !== VERSION) return fail(`锁的 legacy-page 是 ${lock.sources?.['legacy-page']?.version}，当前帧源是 ${VERSION}`);
  const three = lock.sources?.three?.version;
  const manifest = readJson(path.join(repoRoot, baseline.manifest));
  const envThree = baseline.sets.map((s) => manifest.sets?.[s]?.env?.three).find((v) => v !== THREE_VERSION);
  if (three !== THREE_VERSION || envThree !== undefined) return fail(`锁的 three 是 ${three}，基线出片环境是 ${envThree ?? THREE_VERSION}，要的是 ${THREE_VERSION}`);
  const want = getBaselineHashes(workId, { repoRoot });
  if (!Object.keys(want).length) return fail('no-baseline');
  const got = renderedHashes ?? {};
  const missing = Object.keys(want).filter((id) => !Object.hasOwn(got, id));
  const mismatched = Object.keys(want).filter((id) => Object.hasOwn(got, id) && got[id] !== want[id]);
  return { ok: !missing.length && !mismatched.length, mismatched, missing };
}
