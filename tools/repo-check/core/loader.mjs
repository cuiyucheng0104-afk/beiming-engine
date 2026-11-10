// 北冥仓库 · 规范检查 · 规则加载器：扫描 tools/repo-check/rules/<域>/*.mjs，每个文件一条规则。
// 规则文件导出 { id, title, run(ctx) }（默认导出一个对象，或三个具名导出都行）：
//   id     "<域>.<名字>"，域必须等于所在目录名，名字用小写 kebab-case，例如 core.links、comp.secrets
//   title  一句话说明检查什么
//   run    (ctx) → Finding[] 或 Promise<Finding[]>；Finding = { level: 'error'|'warn'|'info', file?, line?, message, hint?, excerpt? }
// 以 _ 开头的文件是同域的辅助模块、以 .test.mjs 结尾的是测试，都不当规则加载。
// 一个规则文件坏了（语法错误、导出不对）只记成一条错误，不影响别的规则。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

export async function loadRules(rulesDir) {
  const rules = [];
  const problems = [];
  let domains = [];
  try {
    domains = fs.readdirSync(rulesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch (e) {
    problems.push({ file: rulesDir, message: `规则目录读不出来（${e.message}）` });
    return { rules, problems, domains };
  }
  for (const domain of domains) {
    const dir = path.join(rulesDir, domain);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_') && !f.endsWith('.test.mjs')).sort();
    for (const f of files) {
      const where = `tools/repo-check/rules/${domain}/${f}`;
      let mod;
      try { mod = await import(pathToFileURL(path.join(dir, f)).href); } catch (e) {
        problems.push({ file: where, message: `规则文件加载失败（${e.message}）` });
        continue;
      }
      const r = mod.default && typeof mod.default === 'object' ? mod.default : mod;
      const m = typeof r.id === 'string' ? ID_RE.exec(r.id) : null;
      if (!m || typeof r.title !== 'string' || !r.title || typeof r.run !== 'function') {
        problems.push({ file: where, message: '规则要导出 { id: "<域>.<名字>", title, run(ctx) }' });
        continue;
      }
      if (m[1] !== domain) { problems.push({ file: where, message: `规则 id ${r.id} 的域与目录 ${domain}/ 不一致` }); continue; }
      if (rules.some(x => x.id === r.id)) { problems.push({ file: where, message: `规则 id ${r.id} 重复` }); continue; }
      rules.push({ id: r.id, title: r.title, domain, file: where, run: r.run });
    }
  }
  return { rules, problems, domains };
}
