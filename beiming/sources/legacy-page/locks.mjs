// 已发布作品的锁文件和基线核对。锁文件在 locks/<作品>.lock.json（lock/1.0，本机锁），按 film-upgrade 升级后的片子描述生成：
// 种子照锁文件契约 5.7 派生，卡的版本和摘要取自 beiming/cards 里的真卡，帧源锁 legacy-page 1.0.0 加 three 0.170.0（宿主都是 page）。
// 三部作品的登记基线均可重建。P9 回归金标和冻结风格参照另作辅助对照，仅覆盖《北冥》。
import { createHash } from 'node:crypto';
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

const fail = (reason) => ({ ok: false, mismatched: [], missing: [], reason });
const HASH = /^sha256:[0-9a-f]{64}$/;
const readOptional = (file) => { try { return readJson(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

/** P9 金标和冻结风格参照均只选无调试参数的成片帧。 */
function referenceBaseline(workId, repoRoot, kind) {
  const { baseline } = entryOf(workId);
  if (!baseline) return { problem: 'no-baseline' };
  const style = kind === 'style';
  const file = style ? 'docs/style-baselines/beiming-original@v1/darwin-metal.json' : baseline.manifest;
  const manifest = readOptional(path.join(repoRoot, file));
  if (!manifest) return { problem: 'missing-manifest: ' + file };
  const sets = style ? { 'beiming-original-v1': manifest } : manifest.sets;
  const frames = Object.create(null);
  for (const name of style ? ['beiming-original-v1'] : baseline.sets) {
    const set = sets?.[name];
    if (!set) return { problem: 'missing-set: ' + name };
    if (!set.env?.three) return { problem: 'missing-three: ' + name };
    if (set.env.three !== THREE_VERSION) return { problem: 'three-mismatch: ' + name + ' ' + set.env.three };
    const rows = Array.isArray(set.frames) ? set.frames.filter((fr) => fr?.page === baseline.page && !fr.query) : [];
    if (!rows.length) return { problem: 'empty-baseline: ' + name };
    for (const fr of rows) {
      const hash = 'sha256:' + fr.pixelSha256;
      if (!fr.id || !HASH.test(hash) || (Object.hasOwn(frames, fr.id) && frames[fr.id] !== hash)) {
        return { problem: 'bad-baseline: ' + name + ' ' + fr.id };
      }
      frames[fr.id] = hash;
    }
  }
  return { frames: { ...frames } };
}

/** 读取辅助参照。缺少有效清单时返回空表，核对接口保留具体原因。 */
export function getBaselineHashes(workId, { repoRoot = REPO, baseline = 'golden' } = {}) {
  if (!['golden', 'style'].includes(baseline)) throw new RangeError('辅助参照只能是 golden 或 style');
  return referenceBaseline(workId, repoRoot, baseline).frames ?? {};
}

/** 已发布作品的重建基线（baselines/published-baselines.json）：缺作品、缺 env.three、空帧表、摘要不合格式都返回 { problem } */
export function publishedBaseline(workId, file = PUBLISHED_BASELINES) {
  const w = readOptional(file)?.works?.[workId];
  if (!w) return { problem: 'no-baseline' };
  if (w.env?.three !== THREE_VERSION) return { problem: `three-mismatch: ${workId} 的 env.three 是 ${w.env?.three ?? '未登记'}，要的是 ${THREE_VERSION}` };
  if (!Array.isArray(w.frames) || !w.frames.length) return { problem: `empty-baseline: ${workId} 的基线帧表是空的` };
  const ids = new Set();
  for (const f of w.frames) {
    if (!Number.isSafeInteger(f?.frame) || f.frame < 0 || f.id !== `f${String(f.frame).padStart(6, '0')}` || typeof f.hash !== 'string' || !HASH.test(f.hash) || ids.has(f.id)) {
      return { problem: `bad-baseline: ${workId} 的帧 ${f?.id} 重复或帧标识、帧号、摘要不合格式` };
    }
    ids.add(f.id);
  }
  for (const field of ['platform', 'arch', 'renderer']) {
    if (typeof w.env[field] !== 'string' || !w.env[field].trim()) return { problem: `bad-baseline: ${workId} 的 env.${field} 缺少有效值` };
  }
  return { frames: Object.fromEntries(w.frames.map((f) => [f.id, f.hash])), list: w.frames, env: w.env };
}

/** 开页前能确定的环境差异。实际 GPU 名称由首帧确认。 */
export function staticEnvMismatch(env) {
  if (env.platform !== process.platform || env.arch !== process.arch) {
    return `env-mismatch: 基线平台是 ${env.platform}/${env.arch}，本机是 ${process.platform}/${process.arch}`;
  }
  if (process.env.BEIMING_ANGLE?.trim().toLowerCase() === 'swiftshader' && !/swiftshader/i.test(env.renderer)) {
    return `env-mismatch: 基线 renderer 是 ${env.renderer}，本机指定了 SwiftShader`;
  }
  return null;
}

/**
 * 按锁核对出片的像素哈希和基线是否逐帧一致。renderedHashes 是 { 帧标识: 'sha256:…' }。
 * baseline 可取 'published'（默认，帧标识 f<6 位全片帧号>）、'golden'（P9 金标）或 'style'（冻结风格参照）。
 * env 给了（{ platform, arch, three, renderer }）就核对基线绑定的出片环境，任何一项不同都不算过。
 * 返回 { ok, mismatched: [帧标识], missing: [帧标识], reason? }。缺集合、缺作品、缺 env.three、three 不符、空帧表、没有基线、
 * 少帧、摘要不匹配、环境不符一律 ok: false 并写明原因；只有基线完好且每一帧都对上才是 ok: true。
 */
export function verifyBaselineHashes(workId, renderedHashes, { baseline = 'published', repoRoot = REPO, baselinesFile = PUBLISHED_BASELINES, env } = {}) {
  entryOf(workId);
  if (!['published', 'golden', 'style'].includes(baseline)) throw new RangeError(`baseline 只能是 published、golden 或 style，给的是 ${baseline}`);
  const lock = loadLegacyLock(workId);
  if (lock.sources?.['legacy-page']?.version !== VERSION) return fail(`锁的 legacy-page 是 ${lock.sources?.['legacy-page']?.version}，当前帧源是 ${VERSION}`);
  if (lock.sources?.three?.version !== THREE_VERSION) return fail(`锁的 three 是 ${lock.sources?.three?.version}，要的是 ${THREE_VERSION}`);
  const want = baseline === 'published' ? publishedBaseline(workId, baselinesFile) : referenceBaseline(workId, repoRoot, baseline);
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

/** 从交付的 f32 颜色层复算 RGB8 摘要，覆盖截图之后的转换与写盘。 */
function layerHash(workspace, layer) {
  const [height, width] = layer.shape;
  const bytes = fs.readFileSync(path.join(workspace, layer.file));
  if (bytes.length !== width * height * 16) throw new Error(`颜色层长度不符：${layer.file}`);
  const linear = new Float32Array(bytes.buffer, bytes.byteOffset, width * height * 4);
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0, j = 0; i < linear.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = linear[i + c];
      if (!(v >= 0 && v <= 1)) throw new Error(`颜色层超出显示参考范围：${layer.file}`);
      rgb[j++] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    }
  }
  return 'sha256:' + createHash('sha256').update(`RGB8 ${width}x${height}\n`).update(rgb).digest('hex');
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
  const mismatch = staticEnvMismatch(want.env);
  if (mismatch) return fail(mismatch);
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
          const { meta, layers } = await session.render(f.frame - shot.in, {}, ['color', 'meta']);
          gpu = meta.source.gpu;
          if (gpu !== want.env.renderer) return fail(`env-mismatch: renderer 基线是 ${want.env.renderer}、出片是 ${gpu ?? '未知'}`);
          rendered[f.id] = layerHash(ws, layers.color);
        }
      } finally { await session.close(); }
    }
  } finally { if (!workspace) fs.rmSync(ws, { recursive: true, force: true }); }
  return verifyBaselineHashes(workId, rendered, { baselinesFile, env: { platform: os.platform(), arch: os.arch(), three: lock.sources.three.version, renderer: gpu } });
}
