// baseline.no-render-products：渲染产物不进仓库（D10、QUAL-01）。
//   tests/golden/ 下不许有图片或视频（测试夹具 tests/golden/fixtures/ 除外）：PNG 只在 out/golden/ 本地缓存，仓库只存像素哈希清单；
//   docs/style-baselines/ 下也不许有：认可参照的关键帧只入库登记 <名>@v<版本>/keyframes.json（名字、帧编号、像素哈希），
//   PNG 由 golden keyframes 在登记平台上从登记提交重建到 out/style-baselines/（被 gitignore 的 out/ 下）。
import { REFERENCE_DIR } from '../../../baseline/lib/manifest.mjs';
import { IMAGE_OR_VIDEO, trackedFiles } from './_shared.mjs';

const KEYFRAME = /^docs\/style-baselines\/([a-z0-9][a-z0-9-]*@v[1-9][0-9]*)\/keyframes\/[^/]+$/;

export default {
  id: 'baseline.no-render-products',
  title: '基线目录不入库渲染产物（D10），认可参照的关键帧 PNG 也不入库',
  run(ctx) {
    const out = [];
    for (const f of trackedFiles(ctx, 'tests/golden')) {
      if (IMAGE_OR_VIDEO.test(f) && !f.startsWith('tests/golden/fixtures/')) {
        out.push({ level: 'error', file: f, message: '回归基线目录里入库了图片或视频', hint: 'PNG 只在 out/golden/ 本地缓存，清单里记像素哈希；需要分发时作为 Release 附件（公开动作，先经用户授权）' });
      }
    }
    for (const f of trackedFiles(ctx, REFERENCE_DIR)) {
      if (!IMAGE_OR_VIDEO.test(f)) continue;
      const m = KEYFRAME.exec(f);
      out.push(m
        ? { level: 'error', file: f, message: '认可参照的关键帧 PNG 入库了（D10：渲染产物不进 git）', hint: `仓库只留登记 ${REFERENCE_DIR}/${m[1]}/keyframes.json；用 git rm --cached 移出，本机用 node tools/baseline/golden.mjs keyframes --reference ${m[1]} 重建到 out/style-baselines/` }
        : { level: 'error', file: f, message: '风格基线目录里入库了图片或视频', hint: '这里只放清单、登记与说明；画面是渲染产物，不进仓库（D10）' });
    }
    return out;
  },
};
