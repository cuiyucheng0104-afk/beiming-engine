// spec.templates：路线注册表里每条路线的模版 film.json 按模版口径（--template）通过作品描述校验；模版还是 v1 只提示。
// 模版本身归各路线包（A / B / C），这里只把校验器的结论报出来（core.templates 查结构与占位符）。
import { diagToFinding, engineLibs, finding } from './_lib.mjs';

const FALLBACK = ['routes/a-webgl/template', 'routes/b-native/template', 'routes/c-style/template'];

export default {
  id: 'spec.templates',
  title: '三条路线模版的 film.json 按模版口径通过作品描述校验',
  async run(ctx) {
    const L = await engineLibs(ctx);
    const reg = ctx.registry.registry;
    const dirs = reg ? reg.routes.map(r => r.template).filter(t => typeof t === 'string') : FALLBACK;
    const out = [];
    for (const t of dirs) {
      const file = `${t}/film.json`;
      if (!ctx.exists(file) || !ctx.inScope(file)) continue;   // 缺模版由 core.templates 报
      let r;
      try { r = L.film.loadFilm(ctx.abs(t), { template: true }); } catch (error) { out.push(finding('error', error.code ?? 'template-invalid', file, error.message, error.hint)); continue; }
      for (const d of r.diagnostics) {
        if (d.level === 'error') out.push(diagToFinding(d, file));
        else if (d.code === 'v1-upgraded') out.push(finding('warn', d.code, file, '模版还是 v1：迁到 film.json v2（output.profile、shots、events、credits、aigc，A 路线加 style）', d.hint));
      }
    }
    if (!out.length) out.push({ level: 'info', message: `${dirs.join('、')} 都通过作品描述校验` });
    return out;
  },
};
