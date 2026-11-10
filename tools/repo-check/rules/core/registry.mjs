// core.registry：路线注册表 routes/routes.json 能读、结构合格、写到的手册 / 模版 / 渲染器入口都在。
// 校验逻辑在 tools/lib/routes.mjs（new-film 与以后的 film 命令用的是同一份）。
export default {
  id: 'core.registry',
  title: '路线注册表 routes/routes.json 结构合格，手册、模版、渲染器入口都在',
  run(ctx) {
    const { error, diagnostics, registry } = ctx.registry;
    const file = 'routes/routes.json';
    if (error) return [{ level: 'error', file, message: error, hint: '这是 new-film、repo-check 与 film 命令共用的路线注册表：恢复它（git checkout -- routes/routes.json）' }];
    const out = diagnostics.map(d => ({ level: 'error', file, message: `${d.path}：${d.message}`, hint: d.hint ?? '字段说明见 docs/CLI.md「路线注册表」' }));
    if (!out.length && registry) out.push({ level: 'info', file, message: `${registry.routes.length} 条路线：${registry.routes.map(r => `${r.id}（routes/${r.slug}/）`).join('、')}` });
    return out;
  },
};
