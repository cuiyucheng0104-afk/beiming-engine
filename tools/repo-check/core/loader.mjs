// 北冥仓库 · 规范检查 · 规则加载器：扫描 tools/repo-check/rules/<域>/*.mjs。规则文件有两种写法：
// ① 单条规则（一个文件一条）：导出 { id, title, run(ctx) }（默认导出一个对象，或三个具名导出都行）
//   id     "<域>.<名字>"，域必须等于所在目录名，名字用小写 kebab-case，例如 core.links、comp.secrets
//   title  一句话说明检查什么
//   run    (ctx) → Finding[] 或 Promise<Finding[]>；Finding = { level: 'error'|'warn'|'info', file?, line?, message, hint?, excerpt? }
// ② 域模块（一个文件装本域的多条规则，常见于还要单独运行的域，如 env、qa）：具名导出
//   rules          [{ id, title, run(ctx), severity? }]，每条的 id、title、run 要求同上
//   domain?        写了就必须等于所在目录名
//   createContext? (root, { staged }) → 本域自己的 ctx；导出了就用它给本模块的规则建上下文（每次检查建一次），
//                  没导出就用框架的 ctx（见 context.mjs）
//   域模块的发现按它自己的约定换算：没写 level 的取该规则的 severity（缺省 error）；level 为 'ok' 的是「通过」说明，
//   不进报告；没写 hint 时用 fix。
// 以 _ 开头的文件是同域的辅助模块、以 .test.mjs 结尾的是测试，都不当规则加载。
// 一个规则文件坏了（语法错误、导出不对）只记成一条错误（带 domain，--only 只看选中的域），不影响别的规则。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const LEVELS = new Set(['error', 'warn', 'info']);
const SHAPES = '单条规则导出 { id: "<域>.<名字>", title, run(ctx) }；域模块导出 rules: [{ id, title, run(ctx) }, …]';

const isRule = r => !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.title === 'string' && !!r.title && typeof r.run === 'function';

/** 域模块里的一条规则：按模块自己的上下文与发现约定包一层，交给执行器时与单条规则无异。 */
function adaptDomainRule(r, mod, where) {
  const severity = LEVELS.has(r.severity) ? r.severity : 'error';
  const makeCtx = typeof mod.createContext === 'function' ? mod.createContext : null;
  return async ctx => {
    const own = makeCtx ? ctx.memo(`domain-ctx:${where}`, () => makeCtx(ctx.root, { staged: ctx.staged ?? null })) : ctx;
    const res = await r.run(own);
    if (!Array.isArray(res)) return res;          // 形状不对交给执行器报「规则自身出错」
    return res.filter(f => f?.level !== 'ok').map(f => (f && typeof f === 'object'
      ? { ...f, level: f.level ?? severity, hint: f.hint ?? f.fix ?? null }
      : f));
  };
}

export async function loadRules(rulesDir) {
  const rules = [];
  const problems = [];
  let domains = [];
  try {
    domains = fs.readdirSync(rulesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch (e) {
    problems.push({ file: rulesDir, domain: null, message: `规则目录读不出来（${e.message}）` });
    return { rules, problems, domains };
  }
  for (const domain of domains) {
    const dir = path.join(rulesDir, domain);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_') && !f.endsWith('.test.mjs')).sort();
    for (const f of files) {
      const where = `tools/repo-check/rules/${domain}/${f}`;
      const problem = message => problems.push({ file: where, domain, message });
      let mod;
      try { mod = await import(pathToFileURL(path.join(dir, f)).href); } catch (e) {
        problem(`规则文件加载失败（${e.message}）`);
        continue;
      }
      const single = mod.default && typeof mod.default === 'object' ? mod.default : mod;
      const isDomainModule = Array.isArray(mod.rules);
      if (isDomainModule && isRule(single)) { problem(`同时导出了单条规则与 rules 数组，只能选一种（${SHAPES}）`); continue; }
      let found;
      if (isDomainModule) {
        if (mod.domain !== undefined && mod.domain !== domain) { problem(`域模块的 domain = ${JSON.stringify(mod.domain)} 与目录 ${domain}/ 不一致`); continue; }
        if (!mod.rules.length) { problem('域模块的 rules 是空数组'); continue; }
        const bad = mod.rules.map((r, i) => (isRule(r) ? null : `rules[${i}]${r?.id ? `（${r.id}）` : ''}`)).filter(Boolean);
        if (bad.length) { problem(`${bad.join('、')} 不是 { id, title, run(ctx) }（${SHAPES}）`); continue; }
        found = mod.rules.map(r => ({ id: r.id, title: r.title, run: adaptDomainRule(r, mod, where) }));
      } else if (isRule(single)) {
        found = [{ id: single.id, title: single.title, run: single.run }];
      } else {
        problem(`导出的形状不认识（${SHAPES}）`);
        continue;
      }
      for (const r of found) {
        const m = ID_RE.exec(r.id);
        if (!m) { problem(`规则 id ${JSON.stringify(r.id)} 要写成 "<域>.<名字>"（名字小写 kebab-case）`); continue; }
        if (m[1] !== domain) { problem(`规则 id ${r.id} 的域与目录 ${domain}/ 不一致`); continue; }
        if (rules.some(x => x.id === r.id)) { problem(`规则 id ${r.id} 重复`); continue; }
        rules.push({ ...r, domain, file: where });
      }
    }
  }
  return { rules, problems, domains };
}
