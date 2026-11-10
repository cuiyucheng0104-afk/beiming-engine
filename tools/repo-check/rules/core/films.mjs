// core.films：films/ 下每部作品根目录有 film.json，结构合格（v1 或 v2；v2 的 id 等于目录名、v1 兼容字段与 output 一致），
// 文本文件里不残留 {{NAME}} / {{TITLE}} 等占位符（作品应由 npm run new 生成）。路线 id 由 core.route-ids 核对。
// 完整的作品描述校验在 engine/production/film.js（作品描述包维护）。
import { filmJsonProblems, findPlaceholders } from '../../../lib/filmspec.mjs';

const TEXT_EXT = /\.(md|js|mjs|cjs|ts|tsx|jsx|json|html|css|py|sh|ps1|txt|glsl|wgsl|wesl|toml|ya?ml|svg)$/i;

export default {
  id: 'core.films',
  title: 'films/ 下每部作品的 film.json 合格、不残留占位符',
  run(ctx) {
    if (!ctx.isDir('films')) return [{ level: 'info', message: 'films/ 还没有作品（npm run new -- <a|b|c> <名字> 新建）' }];
    const reg = ctx.registry.registry;
    const routeIds = reg ? reg.ids : [];
    const dirs = ctx.walk('films', { dirs: true, files: false }).filter(d => /^films\/[^/]+$/.test(d) && !d.split('/')[1].startsWith('.'));
    const out = [];
    for (const d of dirs) {
      const fj = `${d}/film.json`;
      if (!ctx.exists(fj)) { out.push({ level: 'error', file: d, message: '作品根目录缺 film.json', hint: '作品用 npm run new -- <a|b|c> <名字> 生成' }); continue; }
      if (ctx.inScope(fj)) {
        let j = null;
        try { j = ctx.readJson(fj); } catch (e) { out.push({ level: 'error', file: fj, message: `不是合法 JSON（${e.message}）` }); }
        if (j) {
          const probs = filmJsonProblems(j, { mode: 'film', routeIds, dirName: d.split('/')[1] }).filter(p => !p.startsWith('route 应为'));
          for (const p of probs) out.push({ level: 'error', file: fj, message: p });
        }
      }
      for (const f of ctx.walk(d)) {
        if (!TEXT_EXT.test(f) || !ctx.inScope(f)) continue;
        let text;
        try { text = ctx.read(f); } catch { continue; }
        const left = findPlaceholders(text);
        if (left.length) out.push({ level: 'error', file: f, line: left[0].line, message: `残留占位符 ${[...new Set(left.map(p => `{{${p.name}}}`))].join(' ')}`, hint: '作品应由 npm run new 生成；手工复制的要把占位符换掉', excerpt: `{{${left[0].name}}}` });
      }
    }
    if (!out.length) out.push({ level: 'info', message: dirs.length ? `films/ 下 ${dirs.length} 部作品的 film.json 都合格` : 'films/ 下没有作品' });
    return out;
  },
};
