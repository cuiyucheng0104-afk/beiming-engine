// core.manuals：routes/README.md 在；注册表里每条路线的手册都在，并且 8 个二级标题齐全、按顺序（标题照抄）。
export const SECTIONS = Object.freeze(['这条路线是什么', '最快上手', '一部作品的目录', '能力清单', '契约', '验收', '边界与常见坑', '参考作品']);

export default {
  id: 'core.manuals',
  title: '三份路线手册齐全，8 节按顺序',
  run(ctx) {
    const out = [];
    if (!ctx.exists('routes/README.md')) out.push({ level: 'error', file: 'routes/README.md', message: '三路线总指引缺失', hint: '恢复 routes/README.md：新 agent 从这里选路线' });
    const reg = ctx.registry.registry;
    if (!reg) return out;
    for (const r of reg.routes) {
      const f = r.manual;
      if (typeof f !== 'string' || !ctx.exists(f)) { out.push({ level: 'error', file: f ?? 'routes/routes.json', message: `路线 ${r.id} 的手册不存在`, hint: `手册必须有 8 节：${SECTIONS.join(' / ')}` }); continue; }
      const heads = ctx.md.headings(ctx.read(f)).filter(h => h.level === 2).map(h => h.text);
      const missing = SECTIONS.filter(s => !heads.includes(s));
      if (missing.length) { out.push({ level: 'error', file: f, message: `缺少二级标题：${missing.map(s => `「## ${s}」`).join(' ')}`, hint: '标题要照抄，new agent 和规则都按这 8 个标题找内容' }); continue; }
      const order = SECTIONS.map(s => heads.indexOf(s));
      if (order.some((v, i) => i && v < order[i - 1])) out.push({ level: 'error', file: f, message: `8 节齐全但顺序不对：应为 ${SECTIONS.join(' → ')}` });
    }
    if (!out.length) out.push({ level: 'info', message: `${reg.routes.map(r => r.manual).join('、')} 都有 8 节` });
    return out;
  },
};
