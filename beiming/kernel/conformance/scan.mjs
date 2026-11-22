// 静态扫描：在渲染路径的文件里找读墙钟和不带种子的随机。
// shortcut: 追文件内静态成员与简单绑定；跨函数传参、动态属性和作用域遮蔽需要语法树及数据流分析。
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
const renderRules = [...RULES, ...['randomBytes', 'randomInt', 'randomFill', 'randomFillSync'].map((name) => member('unseededRandom', 'crypto', name))];
const matches = (source, rules) => rules.flatMap(({ kind, call, re }) => Array.from(source.matchAll(re), () => ({ kind, call })));

// 只保留静态成员名、模块名和模板插值。字符串内部的源码示例不能产生绑定或命中。
function codeForScan(source, python, strict) {
  const templates = [];
  const literal = /^(?:[\w$]+|node:crypto)$/;
  const regexLiteral = /\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*/y;
  let out = '', i = 0;
  function quoted(q) {
    const start = i;
    while (i < source.length) {
      if (source.startsWith(q, i)) {
        const value = source.slice(start, i);
        i += q.length;
        return literal.test(value) ? `"${value}"` : '""';
      }
      if (q === '`' && source.startsWith('${', i)) {
        i += 2;
        templates.push(0);
        return '(';
      }
      i += source[i] === '\\' ? 2 : 1;
    }
    if (strict) throw new Error('源码字符串未闭合');
    return '""';
  }
  while (i < source.length) {
    const c = source[i];
    if ((python && c === '#') || (!python && (source.startsWith('//', i) || (i === 0 && source.startsWith('#!'))))) {
      while (i < source.length && !/[\r\n\u2028\u2029]/.test(source[i])) i++;
      out += ' ';
    } else if (!python && source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0 && strict) throw new Error('源码注释未闭合');
      i = end < 0 ? source.length : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'" || (!python && c === '`')) {
      const q = python && source.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += q.length;
      out += quoted(q);
    } else if (templates.length && c === '}' && templates.at(-1) === 0) {
      templates.pop();
      i++;
      out += ')' + quoted('`');
    } else if (!python && c === '/' && /(?:^|[=(:,;!&|?{[]|=>|\b(?:return|throw|case))\s*$/.test(out) &&
      (regexLiteral.lastIndex = i, regexLiteral.test(source))) {
      i = regexLiteral.lastIndex;
      out += '""';
    } else {
      if (templates.length && c === '{') templates[templates.length - 1]++;
      if (templates.length && c === '}') templates[templates.length - 1]--;
      out += source[i++];
    }
  }
  if (strict && (templates.length || !out.trim())) throw new Error('模板插值未闭合或没有可扫描的渲染代码');
  return out;
}

const pyRandom = /^(?:random|randint|randrange|uniform|choice|choices|shuffle|sample|gauss|normalvariate|getrandbits|randbytes|triangular|\w+variate|SystemRandom)$/;
const numpyRandom = /^(?:rand\w*|choice|shuffle|permutation|bytes|sample|ranf|standard_\w+|normal|uniform|beta|binomial|chisquare|dirichlet|exponential|f|gamma|geometric|gumbel|hypergeometric|laplace|logistic|lognormal|logseries|multinomial|multivariate_normal|negative_binomial|noncentral_\w+|pareto|poisson|power|rayleigh|triangular|vonmises|wald|weibull|zipf)$/;
const noSeed = /^\s*\(\s*(?:(?:(?:seed|x|a|entropy)\s*=\s*)?None\s*,?\s*)?\)/;
const id = '[$A-Z_a-z][$\\w]*';
const ref = `${id}(?:\\.${id})*`;

function bindings(code, python, implicitPython) {
  const names = new Map(python || implicitPython ? [['np', 'numpy']] : []);
  const resolveName = (path) => {
    const [root, ...props] = path.split('.');
    return [names.get(root) ?? root, ...props].join('.');
  };
  const bindList = (items, module) => {
    for (const item of items.replace(/[()]/g, '').split(',')) {
      const [name, local = name] = item.trim().split(/\s+as\s+|\s*:\s*/);
      if (name) names.set(local, module ? `${module}.${name}` : name);
    }
  };
  if (python) {
    code = code.replace(/(^|[;\n])[ \t]*from[ \t]+(numpy(?:\.random)?|random|time)[ \t]+import[ \t]*(\([^)]*\)|[^;\r\n]+)/g,
      (_, start, mod, list) => { bindList(list, mod); return start; });
    code = code.replace(/(^|[;\n])[ \t]*import[ \t]+([^;\r\n]+)/g,
      (_, start, list) => { bindList(list); return start; });
  } else {
    code = code.replace(/\bimport\s+\{([^{}]*)\}\s*from\s*"(?:node:)?crypto"/g,
      (_, list) => { bindList(list, 'crypto'); return ';'; });
    code = code.replace(/\bimport\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s*"(?:node:)?crypto"/g,
      (_, local) => { names.set(local, 'crypto'); return ';'; });
    code = code.replace(/\b(?:require|await\s+import)\s*\(\s*"(?:node:)?crypto"\s*\)/g, 'crypto');
    code = code.replace(/(?:\?\.)?\s*\[\s*"([\w$]+)"\s*\]/g, '.$1').replace(/\s*\?\.\s*(?=[\w$])/g, '.');
    code = code.replace(/\b(?:globalThis|window|self|global)\s*\.\s*(?=Math\b|crypto\b|Date\b|performance\b)/g, '');
  }
  // 此后用不到字符串内容；保留实参占位，不把带参构造误认作无参。
  code = code.replace(/"[^"\n]*"/g, '""').replace(/\s*\.\s*(?=[A-Za-z_$])/g, '.');
  // 右值仍可使用旧绑定。读完同一层的赋值表达式后才更新别名。
  const pending = [];
  const simpleRef = new RegExp(`^${ref}$`);
  const field = `${id}(?:\\s*:\\s*${id})?`;
  const target = `${id}|\\{\\s*${field}(?:\\s*,\\s*${field})*\\s*,?\\s*\\}`;
  const tokens = new RegExp(`(?<![.#\\w$])(?:(${target})\\s*=(?![=>])|${ref})|[(){}\\[\\];,\\r\\n]`, 'g');
  let depth = 0;
  function finish(end) {
    const reads = [];
    while (pending.length && pending.at(-1).depth === depth) {
      const { start, target } = pending.at(-1);
      let value = code.slice(start, end).trim();
      if (!value) break;
      pending.pop();
      while (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1).trim();
      const object = simpleRef.test(value) ? resolveName(value) : '';
      const known = /^(?:Math|crypto|Date|performance|random|numpy|time)(?:\.|$)/.test(object);
      if (target[0] === '{') {
        for (const item of target.slice(1, -1).split(',').filter((s) => s.trim())) {
          const [key, local = key] = item.trim().split(/\s*:\s*/);
          if (known) { names.set(local, `${object}.${key}`); reads.push(`${object}.${key}`); }
          else names.delete(local);
        }
      } else if (known) names.set(target, object);
      else names.delete(target);
    }
    return reads.length ? `;${reads.join(';')};` : '';
  }
  return (code + ';').replace(tokens, (match, target, index) => {
    if (target) { pending.push({ target, start: index + match.length, depth }); return match; }
    if ('([{'.includes(match)) { depth++; return match; }
    if (/^[)\]};,\r\n]$/.test(match)) {
      const reads = finish(index);
      if (')]}'.includes(match)) depth--;
      return reads + match;
    }
    return resolveName(match);
  });
}

// 只折叠值为静态引用的分组；函数的实参括号不能折叠成返回值。
function groupedReceivers(code) {
  if (!/\)\s*\./.test(code)) return code;
  const value = new RegExp(`^\\s*(?:${id}\\s*=\\s*)?(${ref})\\s*$`);
  const opens = [];
  let out = '', start = 0;
  for (const { 0: paren, index } of code.matchAll(/[()]/g)) {
    out += code.slice(start, index);
    start = index + 1;
    if (paren === '(') {
      const call = /[\w$.)\]"']\s*$/.test(out) && !/(?:^|[^\w$.])(?:return|throw|yield|await|void|typeof|delete|case)\s*$/.test(out);
      opens.push(call ? -1 : out.length);
    } else {
      const at = opens.pop();
      if (at >= 0) {
        const group = value.exec(out.slice(at + 1));
        if (group) { out = `${out.slice(0, at)} ${group[1]} `; continue; }
      }
    }
    out += paren;
  }
  return out + code.slice(start);
}

function scanPython(code) {
  const hits = [];
  for (const m of code.matchAll(/(?<![.\w$])(numpy\.random|random|time)\.(\w+)\b/g)) {
    const [, mod, name] = m;
    const call = m[0];
    if (mod === 'time') {
      if (/^(?:time|time_ns)$/.test(name)) hits.push({ kind: 'wallClock', call });
      continue;
    }
    const factory = mod === 'random' ? /^(?:Random|seed)$/ : /^(?:default_rng|RandomState|SeedSequence|seed)$/;
    if (factory.test(name) ? noSeed.test(code.slice(m.index + call.length)) : (mod === 'random' ? pyRandom : numpyRandom).test(name)) {
      hits.push({ kind: 'unseededRandom', call });
    }
  }
  return hits;
}

/** K8 不传选项，按原始文本扫描（含注释）；INV-02 显式传选项，按源码语言扫描。 */
export function scanText(source, options) {
  if (options === undefined) return matches(source, RULES);
  const { language, filename, requireCode } = typeof options === 'string' ? { filename: options } : options;
  const implicit = !filename && !language;
  const pyImport = /^\s*(?:from[ \t]+(?:random|numpy(?:\.random)?|time)[ \t]+import\b|import[ \t]+(?:random|numpy(?:\.random)?|time)(?:[ \t]+as[ \t]+\w+)?[ \t]*(?:[;#\r\n]|$))/;
  const python = language ? /^(?:py|python)$/i.test(language) : /\.py$/i.test(filename ?? '') || (implicit && pyImport.test(source));
  const code = bindings(codeForScan(source, python, requireCode), python, implicit);
  const hits = python ? [] : matches(groupedReceivers(code), renderRules);
  if (python || implicit) hits.push(...scanPython(code));
  return hits.concat(Array.from(code.matchAll(/(?<![.#\w$])random\s*\(\s*\)/g),
    () => ({ kind: 'unseededRandom', call: 'random()' })));
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

// 引用路径是紧跟在这几种写法后面、写死成字符串的那一个：静态 from（含 export … from）、只引不取的 import、import()、require()；拼出来的路径不追
const BEFORE_SPEC = /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*$/;
// 注释和字符串逐个认出来：注释里、字符串里写到的引用语句都不是语句，不算引用（字符串里的 // 也不是注释）
// shortcut: 不认正则字面量，正则里的引号、反引号、// 会被当成字符串或注释，可能漏追引用；镜头代码里出现这种写法时换成语法树上的扫描
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g;

/** 一段源码里写死成字符串的相对路径引用，按出现先后 */
export function importSpecifiers(text) {
  const out = [];
  let code = '', at = 0; // code：到当前位置为止删掉注释、字符串换成占位的源码
  for (const m of text.matchAll(COMMENT_OR_STRING)) {
    code += text.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[0][0] === '/') continue;
    if (m[0][0] !== '`' && BEFORE_SPEC.test(code) && /^\.{1,2}\//.test(m[0].slice(1, -1))) out.push(m[0].slice(1, -1));
    code += '""';
  }
  return out;
}

/** 入口文件加从它出发顺着相对路径引用一直追到的全部文件，去重，入口在前，其余按追到的先后 */
export function withImports(root, entry) {
  const seen = [entry];
  for (let i = 0; i < seen.length; i++) {
    if (!/\.[mc]?js$/.test(seen[i])) continue;
    for (const spec of importSpecifiers(readFileSync(join(root, seen[i]), 'utf8'))) {
      const dep = relative(root, resolve(root, dirname(seen[i]), spec)).split(sep).join('/');
      if (!seen.includes(dep) && existsSync(join(root, dep))) seen.push(dep);
    }
  }
  return seen;
}

/**
 * 一个镜头的文件：files 是入口加顺着引用追到的全部文件；scan 只扫其中和入口同目录的本镜头文件（扫了哪些在 scan.files）。
 * 每个镜头单独扫：别的镜头的辅助文件里有命中，不记到这个镜头头上。
 */
export function shotFiles(root, entry) {
  const files = withImports(root, entry);
  return { files, scan: scanFiles(root, files.filter((f) => dirname(f) === dirname(entry))) };
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
