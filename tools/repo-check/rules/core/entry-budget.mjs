// core.entry-budget：入口文档行数预算（北极星验收 1：新 agent 读 AGENTS.md → routes/README.md → 一份路线手册，
// 不超过 3 份、300 行就到达第一条可执行命令）。
//   - 单份上限：AGENTS.md 150 行；routes/README.md 120 行；ROUTES.md 10 行（只做跳转页）；每份路线手册 300 行
//   - 路径上限：AGENTS.md 全文 + routes/README.md 全文 + 手册里到第一条可执行命令（第一个代码块里的 node / npm / sh / python 行）为止，合计 300 行
// 预算改动要有理由：先在 docs/CLI.md 的「入口预算」里写明再改这里。
export const FILE_BUDGET = Object.freeze({ 'AGENTS.md': 150, 'routes/README.md': 120, 'ROUTES.md': 10 });
export const MANUAL_BUDGET = 300;
export const PATH_BUDGET = 300;
const COMMAND = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:node|npm|npx|sh|bash|python3?|pwsh)\s/;

const lineCount = text => text.replace(/\n$/, '').split('\n').length;

/** 手册里第一条可执行命令所在的行号（没有返回 null）。 */
export function firstCommandLine(md, text) {
  for (const f of md.fences(text)) for (const l of f.lines) if (COMMAND.test(l.text)) return l.line;
  return null;
}

export default {
  id: 'core.entry-budget',
  title: '入口文档行数预算：AGENTS → routes/README → 手册第一条命令 ≤ 300 行',
  run(ctx) {
    const out = [];
    const lines = {};
    for (const [f, max] of Object.entries(FILE_BUDGET)) {
      if (!ctx.exists(f)) continue;
      lines[f] = lineCount(ctx.read(f));
      if (lines[f] > max) out.push({ level: 'error', file: f, message: `${lines[f]} 行，超过入口预算 ${max} 行`, hint: f === 'ROUTES.md' ? '改成跳转页：一句话 + 指向 routes/README.md 的链接' : '细节挪到被链接的深入文档，入口只留判据与链接' });
    }
    const reg = ctx.registry.registry;
    if (!reg) return out;
    const head = (lines['AGENTS.md'] ?? 0) + (lines['routes/README.md'] ?? 0);
    const per = [];
    for (const r of reg.routes) {
      if (typeof r.manual !== 'string' || !ctx.exists(r.manual)) continue;
      const text = ctx.read(r.manual);
      const n = lineCount(text);
      if (n > MANUAL_BUDGET) out.push({ level: 'error', file: r.manual, message: `${n} 行，超过手册预算 ${MANUAL_BUDGET} 行`, hint: '能力细节挪到深入文档，手册只留 8 节的要点' });
      const first = firstCommandLine(ctx.md, text);
      if (first === null) { out.push({ level: 'error', file: r.manual, message: '手册里没有可执行命令（「最快上手」应有一个 sh 代码块）', hint: '在「最快上手」放 npm run new -- … 与出片命令' }); continue; }
      per.push(`${r.id} ${first}`);
      if (head + first > PATH_BUDGET) out.push({ level: 'error', file: r.manual, line: first, message: `AGENTS.md ${lines['AGENTS.md'] ?? 0} 行 + routes/README.md ${lines['routes/README.md'] ?? 0} 行 + 本手册到第一条命令 ${first} 行 = ${head + first} 行，超过 ${PATH_BUDGET} 行`, hint: '缩短入口文档，或把「最快上手」往前放' });
    }
    if (!out.length) out.push({ level: 'info', message: `AGENTS.md ${lines['AGENTS.md'] ?? '—'} 行、routes/README.md ${lines['routes/README.md'] ?? '—'} 行；手册到第一条命令 ${per.join(' / ')} 行；最长路径 ${head + Math.max(0, ...per.map(p => +p.split(' ')[1]))} 行（预算 ${PATH_BUDGET}）` });
    return out;
  },
};
