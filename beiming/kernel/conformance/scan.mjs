// 静态扫描：在渲染路径的文件里找读墙钟和不带种子的随机。
// shortcut: 只认直接写出来的调用，Python 的 random 模块不认；渲染路径里有 Python 文件、或者要追间接调用时换成语法树上的扫描
// 这个目录自己也会被同样的规则搜，所以被找的调用名在这里一律拆开写，不出现字面量。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** 取成员的一条规则：点号取（含 ?.）和方括号里写字符串取都算 */
const member = (kind, object, prop) => ({
  kind, call: `${object}.${prop}`,
  re: new RegExp(`\\b${object}\\s*(?:\\??\\.\\s*${prop}\\b|(?:\\?\\.)?\\s*\\[\\s*(['"\`])${prop}\\1\\s*\\])`, 'g'),
});
const RULES = [
  member('wallClock', 'Date', 'now'),
  member('wallClock', 'performance', 'now'),
  member('wallClock', 'performance', 'timeOrigin'),
  // 不带参数的 new：括号省掉也算；带参数的是造一个给定的时刻，不算
  { kind: 'wallClock', call: `new ${'Date'}`, re: /\bnew\s+Date\b(?!\s*\(\s*[^)\s])/g },
  // 不带 new 当函数调：不管传什么，交回的都是当前时刻
  { kind: 'wallClock', call: `${'Date'}()`, re: /(?<!\bnew\s+)(?<![.\w$])Date\s*\(/g },
  { kind: 'wallClock', call: ['time', 'time'].join('.'), re: /\btime\s*\.\s*time\s*\(/g },
  member('unseededRandom', 'Math', 'random'),
  member('unseededRandom', 'crypto', 'getRandomValues'),
  member('unseededRandom', 'crypto', 'randomUUID'),
];

/** 一段源码里的全部命中，命中一处一项：[{ kind, call }]。注释里写到也算。 */
export function scanText(text) {
  return RULES.flatMap(({ kind, call, re }) => Array.from(text.matchAll(re), () => ({ kind, call })));
}

/** 目录下（含子目录）的 .js、.mjs，不含测试；返回相对 root 的路径，正斜杠，排好序 */
export function sourceFiles(root, dirs) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?js$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort();
}

// 相对路径的引用：静态 from（含 export … from）、只引不取的 import、写死字符串的 import() 和 require()；拼出来的路径不追
const IMPORT = /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
// 注释里写的引用不算：先把注释删掉，字符串原样留着（字符串里的 // 不是注释）
// shortcut: 不认正则字面量，正则里的引号、反引号、// 会被当成字符串或注释，可能漏追引用；镜头代码里出现这种写法时换成语法树上的扫描
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g;
export const stripComments = (text) => text.replace(COMMENT_OR_STRING, (m) => (m[0] === '/' ? '' : m));

/** 入口文件加从它出发顺着相对路径引用一直追到的全部文件，去重，入口在前，其余按追到的先后 */
export function withImports(root, entry) {
  const seen = [entry];
  for (let i = 0; i < seen.length; i++) {
    if (!/\.[mc]?js$/.test(seen[i])) continue;
    for (const m of stripComments(readFileSync(join(root, seen[i]), 'utf8')).matchAll(IMPORT)) {
      const dep = relative(root, resolve(root, dirname(seen[i]), m[1])).split(sep).join('/');
      if (!seen.includes(dep) && existsSync(join(root, dep))) seen.push(dep);
    }
  }
  return seen;
}

/**
 * 扫一批文件。allowed 是白名单 [{ path, call }]：宿主量耗时的单调时钟，不记进命中，另列在 allowed 里。
 * 返回 { files, wallClock, unseededRandom, allowed }，后三个每项是 { path, call }。
 */
export function scanFiles(root, files, allowed = []) {
  const out = { files, wallClock: [], unseededRandom: [], allowed: [] };
  for (const path of files) {
    for (const { kind, call } of scanText(readFileSync(join(root, path), 'utf8'))) {
      const ok = allowed.some((a) => a.path === path && a.call === call);
      out[ok ? 'allowed' : kind].push({ path, call });
    }
  }
  return out;
}
