// route-b.manual-boundary：B 路线手册写明 BNE 释义、上游署名与 FSL 使用边界（决定 D03 / D04；P01 的 docs/rights/fsl-boundary.md），
// 以及实测得到的两条硬约束：运行时要显式接受许可才能获取、作品必须在 git 工作树里（git archive 导出的目录会被 REFUSED）。
const MANUAL = 'routes/b-native/README.md';
const NEED = [
  [/Beiming Native Edition/, 'BNE 的释义「Beiming Native Edition」（D04）'],
  [/基于 `?RAEA`? 原生运行时（FSL-1\.1-ALv2）/, '署名「基于 RAEA 原生运行时（FSL-1.1-ALv2）」（D04）'],
  [/内部制作层/, 'FSL 使用边界：只作内部制作层（D03）'],
  [/--accept-license/, '获取运行时要显式 --accept-license'],
  [/书面许可/, '商业化前取得上游书面许可（D03）'],
  [/docs\/rights\/fsl-boundary\.md/, '链接 docs/rights/fsl-boundary.md（许可边界全文与 agent 规则）'],
  [/git 工作树/, '作品必须在 git 工作树里（git archive 导出的目录会被运行时拒绝）'],
];

export default {
  id: 'route-b.manual-boundary',
  title: 'B 路线手册写明 BNE 释义、上游署名、FSL 使用边界与运行时的硬约束',
  run(ctx) {
    if (!ctx.exists(MANUAL)) return [{ level: 'error', file: MANUAL, message: 'B 路线手册不存在' }];
    const text = ctx.read(MANUAL), out = [];
    for (const [re, what] of NEED) if (!re.test(text)) out.push({ level: 'error', file: MANUAL, message: `缺少：${what}`, hint: '写进「这条路线是什么」或「边界与常见坑」' });
    const boundary = text.split(/^## /m).find(s => s.startsWith('边界与常见坑'));
    if (!boundary || !/FSL/.test(boundary)) out.push({ level: 'error', file: MANUAL, message: '「边界与常见坑」一节要写 FSL 使用边界', hint: '抄 docs/rights/fsl-boundary.md「agent 规则」五条并链接该页' });
    if (!out.length) out.push({ level: 'info', message: '手册写明 BNE 释义、上游署名、FSL 使用边界、获取许可与 git 工作树约束' });
    return out;
  },
};
