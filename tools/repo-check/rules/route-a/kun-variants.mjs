// route-a.kun-variants：画风注册表里的鲲变体表（标签 → 模块 → 材质 → 自测页 → 对照图 → 认可状态）引用的文件都在，
// 认可状态只能是 none / indirect / approved / rejected（审计 CRAFT-05：变体的认可状态此前没有书面记录）。
import { REGISTRY } from './_shared.mjs';

const APPROVAL = new Set(['none', 'indirect', 'approved', 'rejected']);

export default {
  id: 'route-a.kun-variants',
  title: '鲲变体表引用的模块、材质、自测页与对照图都在',
  run(ctx) {
    let reg;
    try { reg = ctx.readJson(REGISTRY); } catch { return []; }
    const kun = reg.variants?.kun;
    if (!kun) return [];
    const out = [];
    for (const v of kun.items || []) {
      for (const k of ['module', 'toon']) if (v[k] && !ctx.exists(v[k])) out.push({ level: 'error', file: REGISTRY, message: `鲲变体「${v.label}」的 ${k} ${v[k]} 不存在` });
      if (v.test && !ctx.exists(`lab/${v.test}.js`)) out.push({ level: 'error', file: REGISTRY, message: `鲲变体「${v.label}」的自测页 lab/${v.test}.js 不存在` });
      if (!APPROVAL.has(v.approval)) out.push({ level: 'error', file: REGISTRY, message: `鲲变体「${v.label}」的认可状态 ${JSON.stringify(v.approval)} 不认识（none / indirect / approved / rejected）` });
    }
    if (kun.sheet && !ctx.exists(kun.sheet)) out.push({ level: 'error', file: REGISTRY, message: `变体对照图 ${kun.sheet} 不存在` });
    if (!out.length) out.push({ level: 'info', file: REGISTRY, message: `鲲变体表：${(kun.items || []).length} 项的模块、材质、自测页都在` });
    return out;
  },
};
