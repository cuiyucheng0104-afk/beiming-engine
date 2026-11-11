// spec.treatment：作品的 TREATMENT.md 有镜头表、节拍表、cue map、声音设计四节（ORCH-13；模板 routes/directing/templates/TREATMENT.md）。
// 没有 TREATMENT.md 只提示（小样可以只写开头的必填表）；镜像作品（mirror）描述冻结样片，阐述在它自己的文档里，不查。
import { filmDirs, filmInScope, finding } from './_lib.mjs';

export const TREATMENT_SECTIONS = Object.freeze(['镜头表', '节拍表', 'cue map', '声音设计']);

export default {
  id: 'spec.treatment',
  title: 'TREATMENT.md 有镜头表、节拍表、cue map、声音设计四节',
  run(ctx) {
    const out = [];
    for (const dir of filmDirs(ctx)) {
      if (!filmInScope(ctx, dir)) continue;
      let raw = null;
      try { raw = ctx.readJson(`${dir}/film.json`); } catch { /* spec.films 会报 */ }
      if (raw?.mirror) continue;
      const p = `${dir}/TREATMENT.md`;
      if (!ctx.exists(p)) { out.push(finding('warn', 'treatment-missing', dir, `${dir} 没有 TREATMENT.md`, '复制 routes/directing/templates/TREATMENT.md，按节填写（小样按开头的必填表）')); continue; }
      const heads = ctx.md.maskCode(ctx.read(p)).split('\n').filter(l => /^#{2,3}\s/.test(l)).map(l => l.toLowerCase());
      const missing = TREATMENT_SECTIONS.filter(n => !heads.some(h => h.includes(n)));
      if (missing.length) out.push(finding('error', 'treatment-sections', p, `缺少小节：${missing.join('、')}`, '镜头表、节拍表、cue map 从 film.json 导出（node engine/production/film.js expect / export），不手抄'));
    }
    return out;
  },
};
