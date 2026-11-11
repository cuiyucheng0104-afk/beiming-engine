// baseline.approvals：每份回归基线与认可参照都有审批记录（QUAL-01「approve：只能显式更新基线，并记录理由与审批人」）。
//   tests/golden/approvals.jsonl 一行一条、只追加：每行可解析且字段齐全；清单里每个经审批的集合、每份认可参照，
//   都能按「平台键 / 集合 / 帧摘要」找到对应的记录。
import { APPROVALS, listManifests, listReferences, readManifest, readApprovals } from '../../../baseline/lib/manifest.mjs';

const FIELDS = ['at', 'set', 'platformKey', 'by', 'reason', 'commit', 'after'];

export default {
  id: 'baseline.approvals',
  title: '每份基线清单与认可参照都有审批记录',
  run(ctx) {
    const out = [];
    const recs = readApprovals(ctx.root);
    recs.forEach((r, i) => {
      if (r.invalid) { out.push({ level: 'error', file: APPROVALS, line: r.line, message: `第 ${r.line} 行不是合法 JSON`, hint: '这个文件只追加、不手改；用 git checkout 还原后让工具重写' }); return; }
      const miss = FIELDS.filter(k => !r[k]);
      if (miss.length) out.push({ level: 'error', file: APPROVALS, line: i + 1, message: `第 ${i + 1} 行缺 ${miss.join('、')}` });
    });
    const ok = recs.filter(r => !r.invalid);
    const known = new Set(ok.map(r => `${r.platformKey}/${r.set}/${r.after}`));
    for (const { platformKey, set, file, m } of listManifests(ctx.root)) {
      if (!m || m.status === 'candidate') continue;   // 候选由 baseline.manifests 报
      if (!known.has(`${platformKey}/${set}/${m.framesDigest}`)) {
        out.push({ level: 'error', file: ctx.rel(file), message: `${platformKey} 的 ${set} 在 ${APPROVALS} 里没有对应的审批记录（after 摘要对不上）`, hint: '清单只能由 golden update / approve 生成，它们会同时追加审批记录' });
      }
    }
    for (const { id, platformKey, file } of listReferences(ctx.root)) {
      const m = readManifest(file);
      if (!m) continue;
      if (!ok.some(r => r.kind === 'style-reference' && r.referenceId === id && r.platformKey === platformKey && r.after === m.framesDigest)) {
        out.push({ level: 'error', file: ctx.rel(file), message: `认可参照 ${id}（${platformKey}）没有登记记录`, hint: '认可参照只能由 golden reference 生成' });
      }
    }
    return out;
  },
};
