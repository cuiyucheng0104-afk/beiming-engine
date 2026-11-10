// core.links：全部 Markdown（cases/vendor/ 的第三方快照除外）的相对链接都能解析到仓库里的文件或目录；
// 带 #锚点 的，锚点要对得上目标 .md 的标题（按 GitHub 的锚点规则）或显式 <a name/id>。
//   - 模版里的 .md 按复制后的位置 films/<名字>/ 解析（模版是给那个深度写的）；
//   - cases/source/** 是历史归档、不能改：其中指向 Release 素材包的链接按 cases/catalog.json 的资产条目判定有效；
//   - http(s):、mailto: 等外部链接不查；/ 开头的按仓库根解析。
import path from 'node:path';

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function catalogIndex(ctx) {
  return ctx.memo('catalog-index', () => {
    if (!ctx.exists('cases/catalog.json')) return null;
    let cat;
    try { cat = ctx.readJson('cases/catalog.json'); } catch { return null; }
    const bySource = new Map();
    for (const c of Array.isArray(cat.cases) ? cat.cases : []) {
      const paths = new Set((c.files || []).map(f => f.path));
      for (const f of c.files || []) if (f.source) {
        if (!bySource.has(f.source)) bySource.set(f.source, []);
        bySource.get(f.source).push({ itemPath: f.path, paths });
      }
    }
    return bySource;
  });
}

/** 归档 README 的链接：换算成案例工作区里的路径，看 catalog 里有没有这个文件（含 Release 资产）。 */
function inCatalog(ctx, mdRel, link) {
  const idx = catalogIndex(ctx);
  if (!idx) return false;
  const hits = idx.get(mdRel.replace(/^cases\//, '')) || [];
  return hits.some(({ itemPath, paths }) => {
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(itemPath), link));
    if (p.startsWith('..')) return false;
    return paths.has(p) || [...paths].some(x => x.startsWith(`${p.replace(/\/$/, '')}/`));
  });
}

function anchorsOf(ctx, rel) {
  return ctx.memo(`anchors:${rel}`, () => {
    const text = ctx.read(rel);
    return new Set([...ctx.md.headings(text).map(h => h.slug), ...ctx.md.explicitAnchors(text).map(a => a.toLowerCase())]);
  });
}

export default {
  id: 'core.links',
  title: 'Markdown 相对链接与锚点都能解析（第三方快照除外）',
  run(ctx) {
    const reg = ctx.registry.registry;
    const templates = (reg?.routes ?? []).map(r => r.template).filter(t => typeof t === 'string');
    const out = [];
    let files = 0, n = 0;
    for (const f of ctx.mdFiles()) {
      if (!ctx.inScope(f)) continue;
      files++;
      const tpl = templates.find(t => f.startsWith(`${t}/`));
      const baseRel = tpl ? path.posix.dirname(`films/__template__/${f.slice(tpl.length + 1)}`) : path.posix.dirname(f);
      let text;
      try { text = ctx.read(f); } catch { continue; }
      for (const l of ctx.md.links(text)) {
        const raw = l.target.trim();
        if (!raw || EXTERNAL.test(raw)) continue;
        n++;
        const hash = raw.indexOf('#');
        let target = (hash >= 0 ? raw.slice(0, hash) : raw).split('?')[0];
        let anchor = hash >= 0 ? raw.slice(hash + 1) : '';
        try { target = decodeURIComponent(target); anchor = decodeURIComponent(anchor); } catch { /* 原样 */ }
        let rel;
        if (!target) rel = f;
        else {
          const joined = target.startsWith('/') ? path.posix.normalize(target.slice(1)) : path.posix.normalize(path.posix.join(baseRel, target));
          if (joined === '..' || joined.startsWith('../')) { out.push({ level: 'error', file: f, line: l.line, message: `链接 ${raw} 指到仓库外`, excerpt: raw }); continue; }
          rel = joined.replace(/\/$/, '') || '.';
        }
        if (!ctx.exists(rel)) {
          if (f.startsWith('cases/source/') && inCatalog(ctx, f, target)) continue;
          out.push({ level: 'error', file: f, line: l.line, message: `链接 ${raw} 解析为 ${rel}，不存在${tpl ? '（模版里的链接按 films/<名字>/ 的深度解析）' : ''}`, hint: '改成正确的相对路径；文件改名时把引用一起改', excerpt: raw });
          continue;
        }
        if (anchor && rel.toLowerCase().endsWith('.md') && !ctx.isDir(rel)) {
          if (!anchorsOf(ctx, rel).has(anchor.toLowerCase())) {
            out.push({ level: 'error', file: f, line: l.line, message: `链接 ${raw}：${rel} 里没有锚点 #${anchor}`, hint: '锚点按 GitHub 规则由标题生成（小写、去标点、空格换成 -）；标题改了要同步改链接', excerpt: raw });
          }
        }
      }
    }
    if (!out.length) out.push({ level: 'info', message: `${files} 个 .md、${n} 条相对链接全部可解析` });
    return out;
  },
};
