// baseline.no-render-products：渲染产物不进仓库（D10、QUAL-01）。
//   tests/golden/ 下不许有任何图片或视频（PNG 只在 out/golden/ 本地缓存，仓库只存像素哈希清单）；
//   docs/style-baselines/ 下只许有认可参照的关键帧 <名>@v<版本>/keyframes/<名字>.png，而且必须登记在同目录的 keyframes.json 里
//   （关键帧是冻结的认可参照的一部分、可由登记提交逐像素复现，不是出片产物；内容核对由 baseline.references 做）。
import { REFERENCE_DIR } from '../../../baseline/lib/manifest.mjs';
import { IMAGE_OR_VIDEO, trackedFiles } from './_shared.mjs';

const KEYFRAME = /^docs\/style-baselines\/([a-z0-9][a-z0-9-]*@v[1-9][0-9]*)\/keyframes\/([a-z0-9][a-z0-9-]*)\.png$/;

export default {
  id: 'baseline.no-render-products',
  title: '基线目录不入库渲染产物（D10）；认可参照的关键帧必须登记',
  run(ctx) {
    const out = [];
    for (const f of trackedFiles(ctx, 'tests/golden')) {
      if (IMAGE_OR_VIDEO.test(f) && !f.startsWith('tests/golden/fixtures/')) {
        out.push({ level: 'error', file: f, message: '回归基线目录里入库了图片或视频', hint: 'PNG 只在 out/golden/ 本地缓存，清单里记像素哈希；需要分发时作为 Release 附件（公开动作，先经用户授权）' });
      }
    }
    const listed = new Map();
    const keyframesOf = id => {
      if (!listed.has(id)) {
        let names = new Set();
        try { names = new Set((JSON.parse(ctx.read(`${REFERENCE_DIR}/${id}/keyframes.json`)).keyframes || []).map(k => k.file)); } catch { /* 没有或坏了：由 baseline.references 报 */ }
        listed.set(id, names);
      }
      return listed.get(id);
    };
    for (const f of trackedFiles(ctx, REFERENCE_DIR)) {
      if (!IMAGE_OR_VIDEO.test(f)) continue;
      const m = KEYFRAME.exec(f);
      if (!m) { out.push({ level: 'error', file: f, message: '风格基线目录里只许放认可参照的关键帧 <名>@v<版本>/keyframes/<名字>.png', hint: '其它图片是渲染产物，不进仓库（D10）' }); continue; }
      if (!keyframesOf(m[1]).has(`keyframes/${m[2]}.png`)) out.push({ level: 'error', file: f, message: `关键帧没有登记在 ${REFERENCE_DIR}/${m[1]}/keyframes.json 里`, hint: `node tools/baseline/golden.mjs keyframes --reference ${m[1]}` });
    }
    return out;
  },
};
