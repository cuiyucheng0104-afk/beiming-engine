// film.templates：三个路线模版的 film.json 替换占位符后能直接交给 npm run film -- build（模版接线改坏了会在这里暴露）。
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATES, importFrom } from './_shared.mjs';

export default {
  id: 'film.templates',
  title: '路线模版替换占位符后能直接出片',
  async run(ctx) {
    const { parseFilm } = await importFrom(ctx, 'tools/film/lib/spec.mjs');
    const out = [];
    for (const [route, rel] of Object.entries(TEMPLATES)) {
      const file = `${rel}/film.json`;
      if (!ctx.exists(file)) { out.push({ level: 'error', file, message: '模版缺 film.json' }); continue; }
      if (!ctx.inScope(file)) continue;
      let raw;
      try { raw = JSON.parse(ctx.read(file).split('{{NAME}}').join('tpl-check').split('{{TITLE}}').join('模版检查')); }
      catch (e) { out.push({ level: 'error', file, message: `替换占位符后不是合法 JSON（${e.message}）` }); continue; }
      try {
        const film = parseFilm(raw, { dir: ctx.abs(rel) });
        if (film.route !== route) out.push({ level: 'error', file, message: `route 是 ${film.route}，模版目录属于 ${route}` });
        if (route !== 'b' && !fs.existsSync(path.join(ctx.abs(rel), 'index.html'))) out.push({ level: 'error', file: `${rel}/`, message: '页面型模版缺 index.html' });
      } catch (e) { out.push({ level: 'error', file, message: String(e.message).split('\n')[0] }); }
    }
    if (!out.length) out.push({ level: 'info', message: '三个路线模版都能直接交给 npm run film -- build' });
    return out;
  },
};
