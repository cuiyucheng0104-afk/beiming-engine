// 北冥引擎 · 镜头依赖：静态 import 图（只看字面量），用来把“别的镜头独有的模块”从某个镜头的依赖里剔掉。
// 镜头缓存的键 = 页面实际加载过的本地文件（渲染时记下）减去其他镜头独有的模块，再加 film.json 里与这个镜头有关的字段。
// 这样只改镜头 B 的模块时只重渲 B；改共享代码（main.js、engine/、node_modules）或底板贴图时所有镜头都重渲（保守、不会漏）。
// 不认的写法（拼出来的动态 import 路径）会让依赖多算、不会少算：页面实际加载的文件总在依赖里，只有能静态认定“只属于别的
// 镜头”的模块才被剔除。约定：镜头模块之间不互相 import；共享的东西放作品级文件（README「镜头缓存」）。
//   entryModules(root, filmRel)          index.html 里的 <script type="module" src> 与内联 import，加 importmap
//   closure(root, files, { importmap, stopAt })   从这些模块出发的静态闭包（仓库相对路径）；stopAt 里的模块不往下走
//   shotExclusions(root, filmRel, shots) → Map<镜头 id, Set<要剔除的路径>>
import fs from 'node:fs';
import path from 'node:path';

const IMPORT = /(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]+\s*from\s*)?['"]([^'"\n]+)['"]|(?:^|[^\w$.])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
const posix = p => p.split(path.sep).join('/');

export function readImportmap(html) {
  const m = /<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return {};
  try { return JSON.parse(m[1]).imports ?? {}; } catch { return {}; }
}

/** 解析一个说明符到仓库相对路径；解析不了（外网、拼出来的）返回 null */
export function resolveSpecifier(root, fromRel, spec, importmap = {}) {
  let target = null;
  if (spec.startsWith('./') || spec.startsWith('../')) target = path.posix.join(path.posix.dirname(fromRel), spec);
  else if (spec.startsWith('/')) target = spec.slice(1);
  else {
    if (importmap[spec]) target = importmap[spec].replace(/^\//, '');
    else {
      const k = Object.keys(importmap).filter(x => x.endsWith('/') && spec.startsWith(x)).sort((a, b) => b.length - a.length)[0];
      if (k) target = importmap[k].replace(/^\//, '') + spec.slice(k.length);
    }
  }
  if (!target || target.startsWith('..') || /^[a-z]+:/i.test(target)) return null;
  return path.posix.normalize(target);
}

export function entryModules(root, filmRel) {
  const indexRel = path.posix.join(posix(filmRel) || '.', 'index.html').replace(/^\.\//, '');
  let html = '';
  try { html = fs.readFileSync(path.join(root, indexRel), 'utf8'); } catch { return { importmap: {}, entries: [], inline: [] }; }
  const importmap = readImportmap(html);
  const entries = [], inline = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (!/type=["']module["']/i.test(attrs)) continue;
    const src = /src=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (src) { const r = resolveSpecifier(root, indexRel, src.startsWith('.') || src.startsWith('/') ? src : `./${src}`, importmap); if (r) entries.push(r); }
    else for (const x of scan(m[2])) { const r = resolveSpecifier(root, indexRel, x, importmap); if (r) inline.push(r); }
  }
  return { importmap, entries: [...entries, ...inline], indexRel };
}

export function scan(source) {
  const out = [];
  for (const m of stripComments(source).matchAll(IMPORT)) out.push(m[1] ?? m[2]);
  return out;
}

export function closure(root, files, { importmap = {}, stopAt = new Set() } = {}) {
  const seen = new Set(), stack = [...files];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (stopAt.has(f) || !/\.(m?js|cjs)$/.test(f)) continue;
    let src;
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const spec of scan(src)) { const r = resolveSpecifier(root, f, spec, importmap); if (r && !seen.has(r)) stack.push(r); }
  }
  return seen;
}

/** 每个镜头要从依赖里剔除的路径：别的镜头模块闭包里、既不在本镜头闭包也不在共享闭包里的文件 */
export function shotExclusions(root, filmRel, shots) {
  const { importmap, entries } = entryModules(root, filmRel);
  const base = posix(filmRel);
  const modules = new Map(shots.filter(s => s.module).map(s => [s.id, path.posix.normalize(path.posix.join(base || '.', s.module))]));
  const stopAt = new Set(modules.values());
  const shared = closure(root, entries, { importmap, stopAt });
  for (const m of stopAt) shared.delete(m);
  const own = new Map([...modules].map(([id, m]) => [id, closure(root, [m], { importmap })]));
  const out = new Map();
  for (const s of shots) {
    const ex = new Set();
    for (const [id, c] of own) {
      if (id === s.id) continue;
      for (const f of c) if (!shared.has(f) && !(own.get(s.id)?.has(f))) ex.add(f);
    }
    out.set(s.id, ex);
  }
  return out;
}
