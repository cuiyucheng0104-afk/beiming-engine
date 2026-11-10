// core.doc-commands：文档里写的命令要能照抄执行。
//   - 新建作品的命令（node tools/new-film.mjs <路线> <名字>、npm run new -- <路线> <名字>）：路线是注册表 id 或别名，名字合乎 new-film 的规则
//     （小写字母、数字、连字符）；<路线>、<名字> 这类占位写法不查
//   - npm run <脚本>：脚本在 package.json 里，或是 docs/CLI.md 命令表里登记的在建命令；不在的报提示
// 只查代码块与行内代码；归档（cases/source、cases/vendor）与决定书不查。
import { nameProblem } from '../../../lib/filmspec.mjs';
import { isArchive, isDecisionDoc, routeTokens } from './_shared.mjs';

/** 附录 C3 的命令面（含在建）：文档提前写到它们不算错。 */
export const PLANNED_SCRIPTS = Object.freeze(['setup', 'env:doctor', 'env:gpu', 'serve', 'new', 'film', 'qa', 'golden', 'determinism',
  'test', 'check', 'lint', 'check:repo', 'plan:check', 'plan:next', 'cases:list', 'cases:check', 'cases:restore', 'cases:index',
  'cases:ingest', 'cases:pack', 'c:styles', 'c:styles:check', 'c:setup', 'b:preflight', 'b:render', 'beiming:build']);
const NEW_RE = /(?:node\s+(?:\.\/)?tools\/new-film\.mjs|npm\s+run\s+new\s+--)\s+(\S+)\s+(\S+)/g;
const RUN_RE = /npm\s+run\s+(?:-s\s+|--silent\s+)?([a-z0-9](?:[a-z0-9_-]|:(?=[a-z0-9]))*)(:\*)?/g;
const isPlaceholder = t => /[<>|{}$…*]|\.\.\./.test(t) || t.startsWith('-');

function codeSpans(ctx, text) {
  const spans = ctx.md.inlineCode(text).map(c => ({ code: c.code, line: c.line }));
  for (const f of ctx.md.fences(text)) for (const l of f.lines) spans.push({ code: l.text, line: l.line });
  return spans;
}

export default {
  id: 'core.doc-commands',
  title: '文档里的命令能照抄执行（新建作品的路线与名字、npm 脚本名）',
  run(ctx) {
    const { ids, aliases } = routeTokens(ctx);
    const scripts = new Set(Object.keys(ctx.pkg?.scripts ?? {}));
    const known = s => scripts.has(s) || PLANNED_SCRIPTS.includes(s) || (s.endsWith(':*') && [...scripts].some(x => x.startsWith(s.slice(0, -1))));
    const out = [];
    for (const f of ctx.mdFiles()) {
      if (isArchive(f) || isDecisionDoc(f) || !ctx.inScope(f)) continue;
      for (const { code, line } of codeSpans(ctx, ctx.read(f))) {
        for (const m of code.matchAll(NEW_RE)) {
          const [, route, name] = m;
          if (!isPlaceholder(route) && ids.size && !ids.has(route) && !aliases.has(route)) {
            out.push({ level: 'error', file: f, line, message: `新建作品命令的路线「${route}」不在注册表里`, hint: `只能是 ${[...ids].join(' / ')}（或旧名 ${[...aliases.keys()].join('、')}）`, excerpt: m[0] });
          }
          const np = isPlaceholder(name) ? null : nameProblem(name);
          if (np) out.push({ level: 'error', file: f, line, message: `新建作品命令的名字「${name}」照抄会失败：${np}`, hint: '示例名用 my-film 这样的小写 ASCII；片名用 --title 另给', excerpt: m[0] });
        }
        for (const m of code.matchAll(RUN_RE)) {
          const name = m[2] ? `${m[1]}:*` : m[1];
          if (!known(name)) out.push({ level: 'warn', file: f, line, message: `npm run ${name}：package.json 里没有这个脚本`, hint: '改成现有脚本；在建命令先登记到 docs/CLI.md 的命令表', excerpt: m[0] });
        }
      }
    }
    return out;
  },
};
