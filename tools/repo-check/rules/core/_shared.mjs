// 北冥仓库 · 规范检查 · core 域的共享口径（以 _ 开头，不当规则加载）。
// 入口文档 = 新 agent 选路线时会读到的文档：根目录与 docs/ 的几份入口，加上 routes/ 下的全部 Markdown。
export const ROOT_ENTRY_DOCS = Object.freeze([
  'AGENTS.md', 'README.md', 'ROUTES.md', 'docs/README.md', 'docs/TRACKS.md', 'docs/GLOSSARY.md', 'docs/routes/README.md',
]);

// 存在的入口文档（根目录几份 + routes/ 下全部 .md + 每部作品的 README.md），去重、排好序。
export function entryDocs(ctx) {
  const set = new Set(ROOT_ENTRY_DOCS.filter(f => ctx.exists(f)));
  for (const f of ctx.walk('routes')) if (f.endsWith('.md')) set.add(f);
  for (const f of ctx.walk('films')) if (/^films\/[^/]+\/README\.md$/.test(f)) set.add(f);
  return [...set].sort();
}

/** 第三方快照与历史归档：只读，多数规则不检查。 */
export const isArchive = rel => rel.startsWith('cases/vendor/') || rel.startsWith('cases/source/');

/** 讨论命名口径本身的文件（决定书会原样引用要废除的说法），术语类规则跳过。 */
export const isDecisionDoc = rel => rel.startsWith('docs/decisions/');

export const registryOf = ctx => ctx.registry.registry;

/** 全部路线 id 与别名。 */
export function routeTokens(ctx) {
  const reg = registryOf(ctx);
  if (!reg) return { ids: new Set(), aliases: new Map() };
  const aliases = new Map();
  for (const r of reg.routes) for (const a of r.aliases ?? []) aliases.set(a, r.id);
  return { ids: new Set(reg.ids), aliases };
}

/** 一段正文（已遮掉代码）里按行找正则，返回 [{ line, excerpt }]。 */
export function grepLines(text, re) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    re.lastIndex = 0;
    const m = re.exec(l);
    if (m) out.push({ line: i + 1, excerpt: m[0], text: l.trim().slice(0, 160) });
  });
  return out;
}
