// spec.films：films/ 下每部作品的 film.json 过作品描述校验器（engine/production/film.js：镜头首尾相接覆盖整片、事件在镜头内、
// 档位、闸门、署名、AIGC、路线专属段……，附录 C6）。v1 自动升级读取只提示；core.films 只查结构与占位符，这里查完整语义。
import { diagToFinding, engineLibs, filmDirs, filmInScope, finding } from './_lib.mjs';

// 这些提示值得在仓库检查里露出来（其余提示看 node engine/production/film.js check <作品>）
const SURFACE = new Set(['v1-upgraded', 'asset-changed', 'route-alias', 'unknown-field', 'next-in-film', 'event-sync-legacy']);

export default {
  id: 'spec.films',
  title: 'films/ 下每部作品的 film.json 通过作品描述校验（engine/production/film.js）',
  async run(ctx) {
    const L = await engineLibs(ctx);
    const out = [];
    const dirs = filmDirs(ctx);
    for (const dir of dirs) {
      if (!filmInScope(ctx, dir)) continue;
      const file = `${dir}/film.json`;
      if (!ctx.exists(file)) continue;   // 缺 film.json 由 core.films 报
      let r;
      try { r = L.film.loadFilm(ctx.abs(dir)); } catch (error) { out.push(finding('error', error.code ?? 'film-json-invalid', file, error.message, error.hint)); continue; }
      for (const d of r.diagnostics) {
        if (d.level === 'error') out.push(diagToFinding(d, file));
        else if (SURFACE.has(d.code)) out.push(diagToFinding(d, file, { level: 'warn' }));
      }
    }
    if (!out.length) out.push({ level: 'info', message: dirs.length ? `${dirs.length} 部作品的 film.json 都通过作品描述校验` : 'films/ 下没有作品' });
    return out;
  },
};
