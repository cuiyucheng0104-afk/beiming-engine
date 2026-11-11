// film.loadable：films/<名>/film.json 能被出片编排读懂（路线、帧数、画幅、声音来源存在；页面型作品有 index.html）。
// 字段级完整校验在作品描述包（node engine/production/film.js check）；这里只拦「npm run film -- build 一开始就会失败」的问题。
import fs from 'node:fs';
import path from 'node:path';
import { filmDirs, importFrom } from './_shared.mjs';

export default {
  id: 'film.loadable',
  title: '作品能被出片编排读懂（films/<名>/film.json）',
  async run(ctx) {
    const { loadFilm } = await importFrom(ctx, 'tools/film/lib/spec.mjs');
    const out = [];
    const dirs = filmDirs(ctx);
    for (const d of dirs) {
      const file = `${d}/film.json`;
      if (!ctx.inScope(file)) continue;
      if (!ctx.exists(file)) { out.push({ level: 'error', file: d, message: '作品目录没有 film.json', hint: '作品用 npm run new -- <a|b|c> <名字> 生成' }); continue; }
      try {
        const f = loadFilm(ctx.abs(d));
        if (f.route !== 'b' && !fs.existsSync(path.join(f.pageDir, 'index.html'))) out.push({ level: 'error', file, message: `页面型作品（A / C）的页面目录 ${path.relative(ctx.root, f.pageDir).split(path.sep).join('/') || '.'} 下没有 index.html` });
        for (const w of f.warnings) out.push({ level: 'warn', file, message: w.message });
      } catch (e) { out.push({ level: 'error', file, message: String(e.message).split('\n')[0], hint: e.hint || 'npm run film -- check <作品目录> 看完整诊断' }); }
    }
    if (!out.length) out.push({ level: 'info', message: dirs.length ? `${dirs.length} 部作品都能交给 npm run film -- build` : 'films/ 下没有作品' });
    return out;
  },
};
