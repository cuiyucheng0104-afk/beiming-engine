// core.templates：注册表里每条路线的模版目录在；film.json 合格（v1 或 v2，route 等于这条路线的 id、title 是 "{{TITLE}}"、
// v2 的 id 是 "{{NAME}}"、写了 next 时步骤格式合格）；有 README.md；文本文件里的占位符只用 {{NAME}} / {{TITLE}}。
// 占位符 = 两层花括号包住的大写标识符（tools/lib/filmspec.mjs），JSX 的 style={{ … }} 不算。
import { ALLOWED_PLACEHOLDERS, filmJsonProblems, findPlaceholders } from '../../../lib/filmspec.mjs';
import { validateSteps } from '../../../lib/routes.mjs';

const TEXT_EXT = /\.(md|js|mjs|cjs|ts|tsx|jsx|json|html|css|py|sh|ps1|txt|glsl|wgsl|wesl|toml|ya?ml|svg)$/i;
const isTextName = f => TEXT_EXT.test(f) || /(^|\/)\.[^/]+$/.test(f);

export default {
  id: 'core.templates',
  title: '三个模版齐全，film.json 合格，占位符只用 {{NAME}} / {{TITLE}}',
  run(ctx) {
    const reg = ctx.registry.registry;
    if (!reg) return [];
    const out = [];
    for (const r of reg.routes) {
      const t = r.template;
      if (typeof t !== 'string' || !ctx.isDir(t)) { out.push({ level: 'error', file: t ?? 'routes/routes.json', message: `路线 ${r.id} 的模版目录不存在（new-film ${r.id} 会失败）` }); continue; }
      const fj = `${t}/film.json`;
      if (!ctx.exists(fj)) out.push({ level: 'error', file: fj, message: '模版缺 film.json' });
      else {
        let j = null;
        try { j = ctx.readJson(fj); } catch (e) { out.push({ level: 'error', file: fj, message: `不是合法 JSON（${e.message}）` }); }
        if (j) {
          for (const p of filmJsonProblems(j, { mode: 'template', route: r.id })) out.push({ level: 'error', file: fj, message: p });
          if (Array.isArray(j.next)) for (const d of validateSteps(j.next)) out.push({ level: 'error', file: fj, message: `${d.path}：${d.message}`, hint: d.hint ?? '格式同 routes/routes.json 的 next' });
        }
      }
      if (!ctx.exists(`${t}/README.md`)) out.push({ level: 'error', file: `${t}/README.md`, message: '模版缺 README.md（三五行：改哪里、怎么出片）' });
      for (const f of ctx.walk(t)) {
        if (!isTextName(f)) continue;
        let text;
        try { text = ctx.read(f); } catch { continue; }
        for (const ph of findPlaceholders(text)) {
          if (ALLOWED_PLACEHOLDERS.includes(ph.name)) continue;
          out.push({ level: 'error', file: f, line: ph.line, message: `不认识的占位符 {{${ph.name}}}（只允许 {{NAME}} / {{TITLE}}）`, hint: 'new-film 只替换这两个；别的值写进 film.json 或代码', excerpt: `{{${ph.name}}}` });
        }
      }
    }
    if (!out.length) out.push({ level: 'info', message: `${reg.routes.map(r => r.template).join('、')} 都合格` });
    return out;
  },
};
