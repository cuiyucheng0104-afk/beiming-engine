// 已发布作品的锁文件和基线核对。锁文件在 locks/<作品>.lock.json（lock/1.0，本机锁），按 film-upgrade 升级后的片子描述生成：
// 种子照锁文件契约 5.7 派生，卡的版本和摘要取自 beiming/cards 里的真卡，帧源锁 legacy-page 1.0.0 加 three 0.170.0（宿主都是 page）。
// 基线有两份，像素哈希口径都是 sha256("RGB8 <宽>x<高>\n" + RGB)，和 host.mjs 的 pixelHash 一致：
//   published（默认）：baselines/published-baselines.json，三部作品按真实 films/<作品> + 锁重建的抽样帧，绑定出片环境（平台、架构、渲染器、three）；
//   golden：P9 的金标清单（tests/golden/<平台>/manifest.json），只有《北冥》10 秒样片，作辅助对照。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventsTable, shotInput } from '../../kernel/eval/input.mjs';
import { upgradeFilmV2ToV3 } from '../../kernel/film-upgrade.mjs';
import { THREE_VERSION, VERSION } from './caps.mjs';
import { open } from './host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const PUBLISHED_BASELINES = path.join(HERE, 'baselines/published-baselines.json');

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

const fail = (reason) => ({ ok: false, mismatched: [], missing: [], reason });
const HASH = /^sha256:[0-9a-f]{64}$/;
const PIXEL_HASH_KEY = 'legacy-page.pixelSha256';
const readOptional = (file) => { try { return readJson(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

/** 金标（P9 清单）：每个集合都得在、都带 env.three（且是 0.170.0）、都有成片帧；不满足返回 { problem } */
function goldenBaseline(workId, repoRoot) {
  const { baseline } = entryOf(workId);
  if (!baseline) return { problem: 'no-baseline' };
  const manifest = readJson(path.join(repoRoot, baseline.manifest));
  const sets = baseline.sets;
  const noSet = sets.filter((n) => !manifest.sets?.[n]);
  if (noSet.length) return { problem: `missing-set: 金标清单缺集合 ${noSet.join('、')}` };
  const noThree = sets.filter((n) => manifest.sets[n].env?.three === undefined);
  if (noThree.length) return { problem: `missing-three: 集合 ${noThree.join('、')} 没有 env.three` };
  const wrong = sets.filter((n) => manifest.sets[n].env.three !== THREE_VERSION);
  if (wrong.length) return { problem: `three-mismatch: 集合 ${wrong.join('、')} 的 three 是 ${manifest.sets[wrong[0]].env.three}，要的是 ${THREE_VERSION}` };
  const empty = sets.filter((n) => !(manifest.sets[n].frames ?? []).some((fr) => fr.page === baseline.page && !fr.query));
  if (empty.length) return { problem: `empty-baseline: 集合 ${empty.join('、')} 没有成片帧` };
  return { frames: getBaselineHashes(workId, { repoRoot }) };
}

/** 已发布作品的重建基线（baselines/published-baselines.json）：缺作品、缺 env.three、空帧表、摘要不合格式都返回 { problem } */
function publishedBaseline(workId, file) {
  const w = readOptional(file)?.works?.[workId];
  if (!w) return { problem: 'no-baseline' };
  if (w.env?.three === undefined) return { problem: `missing-three: ${workId} 的基线没有 env.three` };
  if (w.env.three !== THREE_VERSION) return { problem: `three-mismatch: ${workId} 的基线 three 是 ${w.env.three}，要的是 ${THREE_VERSION}` };
  if (!Array.isArray(w.frames) || !w.frames.length) return { problem: `empty-baseline: ${workId} 的基线帧表是空的` };
  const bad = w.frames.filter((f) => typeof f?.id !== 'string' || !Number.isInteger(f.frame) || !HASH.test(f.hash));
  if (bad.length) return { problem: `bad-baseline: ${workId} 的基线有 ${bad.length} 项帧标识、帧号或摘要不合格式` };
  return { frames: Object.fromEntries(w.frames.map((f) => [f.id, f.hash])), list: w.frames, env: w.env };
}

/**
 * 按锁核对出片的像素哈希和基线是否逐帧一致。renderedHashes 是 { 帧标识: 'sha256:…' }。
 * baseline：'published'（默认，baselines/published-baselines.json，帧标识 f<6 位全片帧号>）或 'golden'（P9 金标清单，帧标识同清单）。
 * env 给了（{ platform, arch, three, renderer }）就核对基线绑定的出片环境，任何一项不同都不算过。
 * 返回 { ok, mismatched: [帧标识], missing: [帧标识], reason? }。缺集合、缺作品、缺 env.three、three 不符、空帧表、没有基线、
 * 少帧、摘要不匹配、环境不符一律 ok: false 并写明原因；只有基线完好且每一帧都对上才是 ok: true。
 */
export function verifyBaselineHashes(workId, renderedHashes, { baseline = 'published', repoRoot = REPO, baselinesFile = PUBLISHED_BASELINES, env } = {}) {
  entryOf(workId);
  if (baseline !== 'published' && baseline !== 'golden') throw new RangeError(`baseline 只能是 published 或 golden，给的是 ${baseline}`);
  const lock = loadLegacyLock(workId);
  if (lock.sources?.['legacy-page']?.version !== VERSION) return fail(`锁的 legacy-page 是 ${lock.sources?.['legacy-page']?.version}，当前帧源是 ${VERSION}`);
  if (lock.sources?.three?.version !== THREE_VERSION) return fail(`锁的 three 是 ${lock.sources?.three?.version}，要的是 ${THREE_VERSION}`);
  const want = baseline === 'golden' ? goldenBaseline(workId, repoRoot) : publishedBaseline(workId, baselinesFile);
  if (want.problem) return fail(want.problem);
  if (env && want.env) {
    const diff = ['platform', 'arch', 'three', 'renderer'].filter((k) => want.env[k] !== env[k]).map((k) => `${k} 基线是 ${want.env[k]}、出片是 ${env[k]}`);
    if (diff.length) return fail(`env-mismatch: ${diff.join('；')}`);
  }
  const got = renderedHashes ?? {};
  const ids = Object.keys(want.frames);
  const missing = ids.filter((id) => !Object.hasOwn(got, id));
  const mismatched = ids.filter((id) => Object.hasOwn(got, id) && got[id] !== want.frames[id]);
  if (missing.length || mismatched.length) return { ok: false, mismatched, missing, reason: `少 ${missing.length} 帧、${mismatched.length} 帧摘要不匹配` };
  return { ok: true, mismatched: [], missing: [] };
}

/**
 * 从真实的 films/<作品> 和 locks/<作品>.lock.json 打开 legacy-page，渲出基线规定的帧，独立算 RGB8 摘要后与基线逐项核对。
 * options：repoRoot、tier（默认 final）、workspace（不给就用临时目录，用完删）、baselinesFile、driver（测试注入，默认真浏览器）。
 * 没有基线的作品直接返回 ok: false（不开页面）；渲染中途失败也会关净会话、清掉临时目录。
 */
export async function rebuildAndVerifyWork(workId, { repoRoot = REPO, tier = 'final', workspace, baselinesFile = PUBLISHED_BASELINES, driver } = {}) {
  entryOf(workId);
  const want = publishedBaseline(workId, baselinesFile);
  if (want.problem) return fail(want.problem);
  const lock = loadLegacyLock(workId);
  const filmDir = path.join(repoRoot, 'films', workId);
  const film = upgradeFilmV2ToV3(readJson(path.join(filmDir, 'film.json')));
  const events = eventsTable(film);
  const ws = workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bm-legacy-rebuild-'));
  const rendered = {};
  let gpu;
  try {
    for (const shot of film.shots) {
      const mine = want.list.filter((f) => f.frame >= shot.in && f.frame < shot.out);
      if (!mine.length) continue;
      const session = await open(shotInput(film, shot.id, events), { lock, tier, workspace: ws, filmDir }, driver ? { driver } : undefined);
      try {
        for (const f of mine) {
          const { meta } = await session.render(f.frame - shot.in, {}, ['color', 'meta']);
          rendered[f.id] = meta.ext?.[PIXEL_HASH_KEY];
          gpu = meta.source.gpu ?? gpu;
        }
      } finally { await session.close(); }
    }
  } finally { if (!workspace) fs.rmSync(ws, { recursive: true, force: true }); }
  return verifyBaselineHashes(workId, rendered, { baselinesFile, env: { platform: os.platform(), arch: os.arch(), three: lock.sources.three.version, renderer: gpu } });
}
