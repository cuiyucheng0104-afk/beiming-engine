// baseline.media-provenance：media/ 的每个文件都有来源记录（ENV-02、D05）。
//   来源清单 docs/style-baselines/media-provenance.json（本轮不改 media/，D05 的替换落地时随 media/ 一起迁到 media/PROVENANCE.json）：
//   每个文件记 sha256、来源提交（查不到写 sourceState）、生成命令、状态；文件换了而记录没跟着改 → 错误。
import { REFERENCE_DIR } from '../../../baseline/lib/manifest.mjs';
import { readJsonAbs, sha256File, trackedFiles } from './_shared.mjs';

const FILE = `${REFERENCE_DIR}/media-provenance.json`;

export default {
  id: 'baseline.media-provenance',
  title: 'media/ 的每个文件都有来源记录',
  run(ctx) {
    const out = [];
    const media = trackedFiles(ctx, 'media');
    if (!ctx.exists(FILE)) return media.length ? [{ level: 'error', file: FILE, message: '没有 media 来源清单', hint: '每个 media/ 文件记 sha256、来源提交、生成命令、环境' }] : [];
    let j;
    try { j = readJsonAbs(ctx.abs(FILE)); } catch (e) { return [{ level: 'error', file: FILE, message: `读不出来（${e.message}）` }]; }
    if (j.schema !== 'beiming-media-provenance/v1') out.push({ level: 'error', file: FILE, message: 'schema 应为 beiming-media-provenance/v1' });
    const recs = new Map((j.files || []).map(r => [r.path, r]));
    for (const m of media) {
      const r = recs.get(m);
      if (!r) { out.push({ level: 'error', file: m, message: `${FILE} 里没有这个文件的来源记录`, hint: '补一条：sha256、sourceCommit（查不到写 sourceState）、command、environment、status' }); continue; }
      for (const k of ['sha256', 'command', 'status']) if (!r[k]) out.push({ level: 'error', file: FILE, message: `${m} 的记录缺 ${k}` });
      if (!('sourceCommit' in r) || (r.sourceCommit === null && !r.sourceState)) out.push({ level: 'error', file: FILE, message: `${m} 的记录要写 sourceCommit，查不到时写 sourceState 说明来源` });
      if (r.sha256 && ctx.exists(m) && r.sha256 !== sha256File(ctx.abs(m))) out.push({ level: 'error', file: m, message: `文件换了，来源记录还是旧的 sha256（${r.sha256.slice(0, 12)}…）`, hint: `换 media 文件时同步更新 ${FILE}` });
    }
    for (const p of recs.keys()) if (!media.includes(p)) out.push({ level: 'warn', file: FILE, message: `记录了 ${p}，仓库里已经没有这个文件` });
    return out;
  },
};
