// core.scripts：package.json 有 new 与 check:repo；每个脚本用 node / python / sh 直接调用的文件都存在。
// 脚本名、指向与实现方的总表见 docs/CLI.md（附录 C3）。
const RUNNERS = new Set(['node', 'python', 'python3', 'sh', 'bash']);

function targets(cmd) {
  const out = [];
  for (const part of cmd.split(/&&|\|\||;/)) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    if (!RUNNERS.has(toks[i])) continue;
    for (i++; i < toks.length; i++) {
      const t = toks[i];
      if (t === '-m' || t === '-c' || t === '-e') { i = toks.length; break; }
      if (t.startsWith('-')) continue;
      out.push(t);
      break;
    }
  }
  return out;
}

export default {
  id: 'core.scripts',
  title: 'package.json 的脚本都指向存在的文件，new 与 check:repo 在',
  run(ctx) {
    if (!ctx.pkg) return [{ level: 'error', file: 'package.json', message: 'package.json 读不出来' }];
    const scripts = ctx.pkg.scripts ?? {};
    const out = [];
    for (const s of ['new', 'check:repo']) if (!scripts[s]) out.push({ level: 'error', file: 'package.json', message: `scripts 缺少 "${s}"`, hint: '请集成者按 docs/CLI.md 的命令表登记' });
    for (const [name, cmd] of Object.entries(scripts)) {
      for (const t of targets(String(cmd))) {
        if (!ctx.exists(t)) out.push({ level: 'error', file: 'package.json', message: `脚本 ${name} 调用的 ${t} 不存在`, hint: '改脚本指向，或恢复那个文件', excerpt: name });
      }
    }
    if (!out.length) out.push({ level: 'info', message: `${Object.keys(scripts).length} 个脚本的目标文件都在` });
    return out;
  },
};
