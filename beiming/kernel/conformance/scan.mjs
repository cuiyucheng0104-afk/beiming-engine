// 静态扫描：在渲染路径的文件里找读墙钟和不带种子的随机。
// 这个目录自己也会被同样的规则搜，所以被找的调用名在这里一律拆开写，不出现字面量。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const name = (...parts) => parts.join('.');
const RULES = [
  { kind: 'wallClock', call: name('Date', 'now'), re: /\bDate\s*\.\s*now\b/g },
  { kind: 'wallClock', call: name('performance', 'now'), re: /\bperformance\s*\.\s*now\b/g },
  { kind: 'wallClock', call: `new ${'Date'}()`, re: /\bnew\s+Date\s*\(\s*\)/g },
  { kind: 'wallClock', call: name('time', 'time'), re: /\btime\s*\.\s*time\s*\(/g },
  { kind: 'unseededRandom', call: name('Math', 'random'), re: /\bMath\s*\.\s*random\b/g },
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

/** 入口文件加它直接引用的相对路径文件（只跟一层） */
export function withDirectImports(root, entry) {
  const text = readFileSync(join(root, entry), 'utf8');
  const deps = Array.from(text.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g), (m) => relative(root, resolve(root, dirname(entry), m[1])).split(sep).join('/'));
  return [entry, ...deps];
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
