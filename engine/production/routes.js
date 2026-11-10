// 北冥引擎 · 路线注册表的读取（film.js 与 project.js 共用）。
// 规范值是注册表 id：a（北冥风格路线 · WebGL 三渲二）、b（北冥原生 · BNE）、c（北冥代码动画风格 · 86 式），见决策 D01、D04。
// routes/routes.json（P02 维护）存在时以它为准；不存在时用下面的内置三条。旧值 beiming / raea 与目录名 a-webgl / b-native / c-style 都是别名。
//
//   BUILTIN_ROUTES                       内置注册表（与 D01、D04 一致）
//   loadRouteRegistry(root?)             → { routes: [{ id, slug, brand, legacyId, backends, manual, renderer }], source, aliases: Map }
//   builtinRegistry()                    只用内置三条（注册表文件坏了时的退路，或测试用）
//   resolveRoute(value, registry?)       任意写法 → { id, alias: 是否写成了别名, route } | null（大小写不敏感）
//   routeIds(registry?)                  ['a', 'b', 'c']
//   BACKEND_ALIASES                      后端别名：raea → native（ProjectSpec v1 的旧写法）
// 注册表文件读不出或结构不对时抛 RouteRegistryError（exitCode 1：仓库自带的文件坏了，不是用户输入的问题）。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readJsonFile } from './io.js';

export const BUILTIN_ROUTES = Object.freeze([
  Object.freeze({ id: 'a', slug: 'a-webgl', brand: '北冥风格路线 · WebGL 三渲二', legacyId: 'beiming', backends: Object.freeze(['three']), manual: 'routes/a-webgl/README.md', renderer: 'page' }),
  Object.freeze({ id: 'b', slug: 'b-native', brand: '北冥原生 · BNE', legacyId: 'raea', backends: Object.freeze(['native']), manual: 'routes/b-native/README.md', renderer: 'native' }),
  Object.freeze({ id: 'c', slug: 'c-style', brand: '北冥代码动画风格 · 86 式', legacyId: null, backends: Object.freeze(['canvas', 'svg', 'dom', 'three', 'webgl']), manual: 'routes/c-style/README.md', renderer: 'page' }),
]);

/** 后端的旧写法：ProjectSpec v1 把原生执行写成 raea。 */
export const BACKEND_ALIASES = Object.freeze({ raea: 'native' });

export class RouteRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RouteRegistryError';
    this.code = 'routes-invalid';
    this.exitCode = 1;
    this.hint = 'routes/routes.json 由治理骨架维护：从版本库恢复，或按 { "routes": [{ "id": "a", … }] } 修好';
  }
}

const isStr = v => typeof v === 'string' && v.trim().length > 0;

function withAliases(routes, source) {
  const aliases = new Map();
  // 注册表的 aliases 数组（P02：a-webgl / beiming、b-native / raea……）与 id、目录名、旧路线名都认
  for (const r of routes) for (const a of [r.id, r.slug, r.legacyId, ...(Array.isArray(r.aliases) ? r.aliases : [])].filter(isStr)) aliases.set(String(a).toLowerCase(), r.id);
  return { routes, source, aliases };
}

export function builtinRegistry() {
  return withAliases(BUILTIN_ROUTES.map(r => ({ ...r, backends: [...r.backends] })), 'builtin');
}

export function loadRouteRegistry(root = REPO_ROOT) {
  const file = join(root, 'routes', 'routes.json');
  if (!existsSync(file)) return builtinRegistry();
  const r = readJsonFile(file);
  const list = r.ok ? (Array.isArray(r.value) ? r.value : r.value?.routes) : null;
  if (!Array.isArray(list) || !list.length || !list.every(x => isStr(x?.id))) {
    throw new RouteRegistryError(`路线注册表 routes/routes.json 不合格：${r.ok ? '需要 routes 数组，每项有 id' : r.message}`);
  }
  const routes = list.map(x => {
    const b = BUILTIN_ROUTES.find(y => y.id === x.id);
    // 注册表没写 backends 时沿用内置值；renderer 以内置为准（注册表里 renderer 是数组，含义不同）
    return { ...(b ?? {}), ...x, backends: Array.isArray(x.backends) ? [...x.backends] : (b ? [...b.backends] : null), renderer: b?.renderer ?? null };
  });
  return withAliases(routes, 'routes/routes.json');
}

export function resolveRoute(value, registry = loadRouteRegistry()) {
  if (typeof value !== 'string') return null;
  const id = registry.aliases.get(value.trim().toLowerCase());
  return id ? { id, alias: id !== value, route: registry.routes.find(r => r.id === id) } : null;
}

export function routeIds(registry = loadRouteRegistry()) {
  return registry.routes.map(r => r.id);
}
