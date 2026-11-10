// core.route-ids：路线 id 只能取注册表 routes/routes.json 里的值。
//   - films/*/film.json 的 route 必须是注册表 id（a / b / c），旧名（beiming、raea、目录名）也不行；
//   - docs/routes/work-plan.json（引擎工程待办）v2 的 route 只能是注册表 id 或 shared；v1 的旧名（beiming、raea）按别名提示；
//   - 机器层的硬编码清单（engine/production/project.js 导出的 ROUTES、tools/work-plan.mjs 的 ROUTES）只能含 id、别名或 shared。
// 模版 film.json 的 route 由 core.templates 按各自路线核对。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { routeTokens, registryOf } from './_shared.mjs';

export default {
  id: 'core.route-ids',
  title: '路线 id 只取注册表的值（作品、工程计划、机器层清单）',
  async run(ctx) {
    const reg = registryOf(ctx);
    if (!reg) return [];
    const { ids, aliases } = routeTokens(ctx);
    const out = [];
    const idList = [...ids].map(x => `"${x}"`).join(' / ');
    for (const f of ctx.walk('films')) {
      if (!/^films\/[^/]+\/film\.json$/.test(f) || !ctx.inScope(f)) continue;
      let j;
      try { j = ctx.readJson(f); } catch { continue; }   // JSON 坏了由 core.films 报
      if (ids.has(j?.route)) continue;
      const alias = aliases.get(j?.route);
      out.push({ level: 'error', file: f, message: `route = ${JSON.stringify(j?.route)} 不是注册表 id（只能是 ${idList}）`, hint: alias ? `旧名 ${j.route} 对应路线 ${alias}：改成 "route": "${alias}"` : '路线怎么选见 routes/README.md', excerpt: String(j?.route) });
    }
    const wp = 'docs/routes/work-plan.json';
    if (ctx.exists(wp)) {
      let plan = null;
      try { plan = ctx.readJson(wp); } catch (e) { out.push({ level: 'error', file: wp, message: `不是合法 JSON（${e.message}）` }); }
      const v2 = plan?.schemaVersion === 2;
      const legacy = new Set();
      for (const t of Array.isArray(plan?.tasks) ? plan.tasks : []) {
        if (ids.has(t.route) || t.route === 'shared') continue;
        if (aliases.has(t.route) && !v2) { legacy.add(t.route); continue; }
        out.push({
          level: 'error', file: wp, message: `任务 ${t.id} 的 route = ${JSON.stringify(t.route)} 不是注册表 id 或 shared`,
          hint: aliases.has(t.route) ? `工程计划 v2 只写注册表 id：改成 "route": "${aliases.get(t.route)}"` : `只能是 ${idList}、shared`, excerpt: String(t.route),
        });
      }
      if (legacy.size) out.push({ level: 'info', file: wp, message: `工程计划 v1 仍用旧路线名 ${[...legacy].join('、')}（别名；升到 v2 时改成注册表 id）` });
    }
    const known = v => ids.has(v) || aliases.has(v) || v === 'shared';
    const pj = 'engine/production/project.js';
    if (ctx.exists(pj)) {
      try {
        const mod = await import(pathToFileURL(path.join(ctx.root, pj)).href);
        const bad = Array.isArray(mod.ROUTES) ? mod.ROUTES.filter(v => !known(v)) : [];
        if (bad.length) out.push({ level: 'warn', file: pj, message: `导出的 ROUTES 里有注册表不认识的路线：${bad.join('、')}`, hint: '在 routes/routes.json 的 aliases 里登记旧名，或改用注册表 id' });
      } catch (e) {
        out.push({ level: 'info', file: pj, message: `没能载入以核对 ROUTES（${e.message}），跳过` });
      }
    }
    const wm = 'tools/work-plan.mjs';
    if (ctx.exists(wm)) {
      const m = /const ROUTES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(ctx.read(wm));
      const vals = m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]) : [];
      const bad = vals.filter(v => !known(v));
      if (bad.length) out.push({ level: 'warn', file: wm, message: `硬编码的 ROUTES 里有注册表不认识的路线：${bad.join('、')}`, hint: '改成从 tools/lib/routes.mjs 读注册表' });
    }
    return out;
  },
};
