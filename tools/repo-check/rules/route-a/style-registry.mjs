// route-a.style-registry：画风注册表 engine/style/registry.json 合格；每个登记版本的锁定文件存在、校验通过、预设齐全、
// 认可状态与登记表一致、基准帧在；候选（未认可的实验）不许写认可状态（审计 CRAFT-01 / CRAFT-06，LOOKDEV.md）。
import { REGISTRY, styleData } from './_shared.mjs';

export default {
  id: 'route-a.style-registry',
  title: '画风注册表：登记版本的锁定文件合格、预设齐全、认可状态一致',
  run(ctx) {
    if (!ctx.exists(REGISTRY)) return [];
    const { reg, error, styles } = styleData(ctx);
    if (error) return [{ level: 'error', file: REGISTRY, message: error, hint: 'git checkout -- engine/style/registry.json 恢复；字段说明见文件开头的 $comment' }];
    const out = [];
    for (const [key, rec] of styles) {
      const n0 = out.length, s = rec.entry;
      for (const p of rec.problems) out.push({ level: 'error', file: rec.doc ? rec.file : REGISTRY, message: p, hint: '锁定文件的字段见 routes/directing/templates/STYLE-LOCK.md；改画风要升版本（LOOKDEV.md）' });
      if (rec.doc) {
        for (const p of s.lookPresets || []) if (!rec.doc.lookPresets?.[p]) out.push({ level: 'error', file: rec.file, message: `登记表说 ${key} 有预设 ${p}，锁定文件里没有` });
        for (const p of Object.keys(rec.doc.lookPresets || {})) if (!(s.lookPresets || []).includes(p)) out.push({ level: 'warn', file: REGISTRY, message: `${s.file} 有预设 ${p}，登记表的 lookPresets 没列出` });
        if (s.userApproval !== rec.doc.status?.userApproval) out.push({ level: 'error', file: REGISTRY, message: `${key} 的认可状态不一致：登记表 ${s.userApproval}，锁定文件 ${rec.doc.status?.userApproval}`, hint: '认可状态只能按用户原话改，两处一起改' });
      }
      for (const b of s.baselineFrames || []) if (!ctx.exists(b)) out.push({ level: 'error', file: REGISTRY, message: `${key} 的基准帧 ${b} 不存在` });
      if (out.length === n0) out.push({ level: 'info', file: rec.file, message: `${key}：锁定文件合格，${Object.keys(rec.doc.lookPresets || {}).length} 个预设，认可状态 ${s.userApproval}` });
    }
    for (const c of reg.candidates || []) {
      if (!c.file || !ctx.exists(`engine/style/${c.file}`)) out.push({ level: 'error', file: REGISTRY, message: `候选 ${c.id} 的文件 ${c.file} 不存在` });
      if (c.userApproval && c.userApproval !== 'none') out.push({ level: 'error', file: REGISTRY, message: `候选 ${c.id} 写了认可状态 ${c.userApproval}：候选是实验，认可了就该登记成正式版本`, hint: '按 routes/a-webgl/LOOKDEV.md 签认后登记到 styles' });
    }
    return out;
  },
};
