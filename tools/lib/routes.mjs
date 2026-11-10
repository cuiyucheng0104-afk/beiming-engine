// 北冥仓库 · 路线注册表的唯一读取口：读 routes/routes.json、校验结构、按 id 或别名找路线、把「下一步」命令展开成可执行的形式。
// new-film、repo-check 与以后的 film 命令都用它，不各自硬编码 a / b / c。
//
//   readRegistry(root)               → { raw, error }               只读不抛错（给 repo-check 报告用）
//   validateRegistry(raw, { root })  → [{ path, message, hint }]    结构与路径诊断，空数组 = 合格
//   loadRegistry(root)               → Registry                     不合格时抛 CliError(contract.registry)
//   registry.resolve('beiming')      → { route, via: 'alias' }      id 或别名；找不到返回 null
//   expandSteps(steps, vars)         → [{ stage, title, argv, env, requires, output }]   把 {dir} {name} {size} … 换成实际值
//   validateSteps(steps, where)      → [{ path, message, hint }]    步骤格式诊断（注册表与模版 film.json 的 next 共用）
//   formatStep(step, { platform })   → { command, notes }           给人看的一行命令（POSIX sh 或 PowerShell 写法）
//   filmVars({ dir, name, dur, fps, width, height }) → 命令模版可用的全部变量
// 字段含义见 docs/CLI.md「路线注册表」。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './cli.mjs';

export const REGISTRY_PATH = 'routes/routes.json';
export const STAGES = Object.freeze(['look', 'animatic', 'build', 'check', 'final']);
export const STEP_VARS = Object.freeze(['dir', 'name', 'dur', 'fps', 'width', 'height', 'size', 'mid', 'last', 'midFrame', 'lastFrame']);
/** 上游项目名：可以在技术说明与署名里出现，不得用作我方的产品名、路线名、目录名或文件名（D04）。 */
export const UPSTREAM_NAME_RE = /raea/i;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v.trim().length > 0;

/** 仓库相对路径（正斜杠、不越界、不是绝对路径）。 */
export function isRepoPath(p) {
  return isStr(p) && !p.includes('\\') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').some(s => s === '..' || s === '');
}

export function readRegistry(root) {
  const file = join(root, REGISTRY_PATH);
  if (!existsSync(file)) return { raw: null, error: `${REGISTRY_PATH} 不存在` };
  try { return { raw: JSON.parse(readFileSync(file, 'utf8')), error: null }; }
  catch (e) { return { raw: null, error: `${REGISTRY_PATH} 不是合法 JSON（${e.message}）` }; }
}

/** 校验一组步骤（注册表与模版 film.json 的 next 共用这份格式）。 */
export function validateSteps(steps, where = 'next') { const out = []; checkSteps(steps, where, out); return out; }

function checkSteps(steps, where, out) {
  if (!Array.isArray(steps) || !steps.length) { out.push({ path: where, message: '要写成非空数组（每项一个步骤）' }); return; }
  steps.forEach((s, i) => {
    const p = `${where}[${i}]`;
    if (!isObj(s)) { out.push({ path: p, message: '每个步骤是对象 { stage, title, run[] }' }); return; }
    if (!STAGES.includes(s.stage)) out.push({ path: `${p}.stage`, message: `只能是 ${STAGES.join(' / ')}，现在是 ${JSON.stringify(s.stage)}` });
    if (!isStr(s.title)) out.push({ path: `${p}.title`, message: '要写一句话说明这一步做什么' });
    if (!Array.isArray(s.run) || !s.run.length || !s.run.every(isStr)) out.push({ path: `${p}.run`, message: '要写成非空字符串数组（argv，第一项是程序名），不写成一整行 shell' });
    else for (const tok of s.run) for (const m of tok.matchAll(/\{([^{}]*)\}/g)) {
      if (!STEP_VARS.includes(m[1])) out.push({ path: `${p}.run`, message: `不认识的变量 {${m[1]}}`, hint: `可用：${STEP_VARS.map(v => `{${v}}`).join(' ')}` });
    }
    if (s.env !== undefined) {
      if (!isObj(s.env)) out.push({ path: `${p}.env`, message: '要写成 { 变量名: { describe, default?, required? } }' });
      else for (const [k, v] of Object.entries(s.env)) {
        if (!ENV_RE.test(k)) out.push({ path: `${p}.env.${k}`, message: '环境变量名用大写字母、数字、下划线' });
        if (!isObj(v) || !isStr(v.describe)) out.push({ path: `${p}.env.${k}`, message: '要写 describe（这个变量指什么）' });
      }
    }
    if (s.requires !== undefined && !(Array.isArray(s.requires) && s.requires.every(isStr))) out.push({ path: `${p}.requires`, message: '要写成字符串数组' });
  });
}

/** 校验注册表；root 给出时顺带检查手册、模版、渲染器入口这些路径是否存在。 */
export function validateRegistry(raw, { root } = {}) {
  const out = [];
  const has = p => root ? existsSync(join(root, p)) : true;
  const isDir = p => { try { return statSync(join(root, p)).isDirectory(); } catch { return false; } };
  if (!isObj(raw)) return [{ path: '(根)', message: '顶层要是对象' }];
  if (raw.schemaVersion !== 1) out.push({ path: 'schemaVersion', message: `只认 1，现在是 ${JSON.stringify(raw.schemaVersion)}` });
  if (!isStr(raw.defaultProfile)) out.push({ path: 'defaultProfile', message: '要写默认交付档位（D07：web-1080p24）' });
  const renderers = isObj(raw.renderers) ? raw.renderers : {};
  if (!isObj(raw.renderers) || !Object.keys(renderers).length) out.push({ path: 'renderers', message: '要写渲染器表 { id: { title, entry } }' });
  for (const [k, r] of Object.entries(renderers)) {
    if (!isObj(r) || !isStr(r.title) || !isRepoPath(r.entry)) { out.push({ path: `renderers.${k}`, message: '要有 title 与仓库相对路径 entry' }); continue; }
    if (!has(r.entry)) out.push({ path: `renderers.${k}.entry`, message: `${r.entry} 不存在` });
  }
  if (!Array.isArray(raw.routes) || !raw.routes.length) { out.push({ path: 'routes', message: '要写成非空数组' }); return out; }
  const ids = new Map(), slugs = new Set(), tokens = new Map();
  raw.routes.forEach((r, i) => {
    const p = `routes[${i}]`;
    if (!isObj(r)) { out.push({ path: p, message: '每条路线是一个对象' }); return; }
    if (!(typeof r.id === 'string' && /^[a-z]$/.test(r.id))) out.push({ path: `${p}.id`, message: `路线 id 是单个小写字母（a / b / c），现在是 ${JSON.stringify(r.id)}` });
    else if (ids.has(r.id)) out.push({ path: `${p}.id`, message: `id ${r.id} 重复` });
    else ids.set(r.id, i);
    if (!(typeof r.slug === 'string' && SLUG_RE.test(r.slug))) out.push({ path: `${p}.slug`, message: 'slug 用小写字母、数字、连字符（目录名 routes/<slug>/）' });
    else {
      if (slugs.has(r.slug)) out.push({ path: `${p}.slug`, message: `slug ${r.slug} 重复` });
      slugs.add(r.slug);
      if (UPSTREAM_NAME_RE.test(r.slug)) out.push({ path: `${p}.slug`, message: '目录名不得含上游项目名（D04）' });
      if (root && !isDir(`routes/${r.slug}`)) out.push({ path: `${p}.slug`, message: `routes/${r.slug}/ 不存在` });
    }
    for (const k of ['brand', 'label', 'summary', 'chooseWhen', 'backend']) if (!isStr(r[k])) out.push({ path: `${p}.${k}`, message: '不能为空' });
    if (isStr(r.brand)) {
      if (/RTX/.test(r.brand)) out.push({ path: `${p}.brand`, message: '产品名里不再带 RTX（D04）' });
      if (UPSTREAM_NAME_RE.test(r.brand)) out.push({ path: `${p}.brand`, message: '品牌名不得用上游项目名（D04）' });
    }
    for (const [k, file] of [['manual', true], ['template', false]]) {
      const v = r[k];
      if (!isRepoPath(v)) { out.push({ path: `${p}.${k}`, message: '要写仓库相对路径（正斜杠）' }); continue; }
      if (isStr(r.slug) && !v.startsWith(`routes/${r.slug}/`)) out.push({ path: `${p}.${k}`, message: `要放在 routes/${r.slug}/ 下` });
      if (!root) continue;
      if (file ? !has(v) : !isDir(v)) out.push({ path: `${p}.${k}`, message: `${v} 不存在` });
      else if (!file && !has(`${v}/film.json`)) out.push({ path: `${p}.${k}`, message: `${v}/film.json 不存在` });
    }
    if (!Array.isArray(r.aliases) || !r.aliases.every(a => typeof a === 'string' && SLUG_RE.test(a))) out.push({ path: `${p}.aliases`, message: '要写成小写 slug 的数组（旧路线名、目录名）' });
    if (!Array.isArray(r.renderer) || !r.renderer.length) out.push({ path: `${p}.renderer`, message: '要写成非空数组，取 renderers 里的 id' });
    else for (const x of r.renderer) if (!(x in renderers)) out.push({ path: `${p}.renderer`, message: `渲染器 ${x} 不在 renderers 表里` });
    if (!Array.isArray(r.upstream)) out.push({ path: `${p}.upstream`, message: '要写成数组（没有上游写 []）' });
    else r.upstream.forEach((u, j) => {
      if (!isObj(u) || !isStr(u.name) || !isStr(u.repository) || !isStr(u.license)) out.push({ path: `${p}.upstream[${j}]`, message: '要有 name、repository、license' });
    });
    if (r.templateDefaults !== undefined) {
      const d = r.templateDefaults;
      if (!isObj(d)) out.push({ path: `${p}.templateDefaults`, message: '要写成对象' });
      else {
        if (d.aigc !== undefined && !(isObj(d.aigc) && typeof d.aigc.contains === 'boolean' && isStr(d.aigc.note))) out.push({ path: `${p}.templateDefaults.aigc`, message: '要写 { contains: true|false, note }（D11）' });
        if (d.audio !== undefined && !(isObj(d.audio) && isStr(d.audio.mode))) out.push({ path: `${p}.templateDefaults.audio`, message: '要写 { mode, script? }' });
        if (d.credits !== undefined && !(Array.isArray(d.credits) && d.credits.every(c => isObj(c) && isStr(c.what) && isStr(c.license)))) out.push({ path: `${p}.templateDefaults.credits`, message: '每项要有 what 与 license' });
      }
    }
    checkSteps(r.next, `${p}.next`, out);
  });
  // 别名不得与 id 或别的别名撞车
  raw.routes.forEach((r, i) => {
    for (const a of Array.isArray(r?.aliases) ? r.aliases : []) {
      if (ids.has(a)) out.push({ path: `routes[${i}].aliases`, message: `别名 ${a} 和路线 id 撞车` });
      else if (tokens.has(a) && tokens.get(a) !== i) out.push({ path: `routes[${i}].aliases`, message: `别名 ${a} 已被 routes[${tokens.get(a)}] 用了` });
      else tokens.set(a, i);
    }
  });
  return out;
}

export class Registry {
  constructor(raw) {
    this.raw = raw;
    this.routes = raw.routes;
    this.renderers = raw.renderers;
    this.defaultProfile = raw.defaultProfile;
    this.ids = raw.routes.map(r => r.id);
  }
  get(id) { return this.routes.find(r => r.id === id) ?? null; }
  /** 按 id 或别名（大小写不敏感）找路线。 */
  resolve(token) {
    const t = String(token ?? '').trim().toLowerCase();
    const byId = this.routes.find(r => r.id === t);
    if (byId) return { route: byId, via: 'id' };
    const byAlias = this.routes.find(r => (r.aliases ?? []).includes(t));
    return byAlias ? { route: byAlias, via: 'alias' } : null;
  }
  /** 「a（北冥风格路线 · WebGL 三渲二）、b（…）」这样的一句，给报错与帮助用。 */
  describeIds() { return this.routes.map(r => `${r.id}（${r.brand}）`).join('、'); }
  allTokens() { return this.routes.flatMap(r => [r.id, ...(r.aliases ?? [])]); }
}

/** 读并校验注册表；不合格时抛 CliError(contract.registry)，提示跑 check:repo 看详情。 */
export function loadRegistry(root) {
  const { raw, error } = readRegistry(root);
  if (error) throw new CliError('contract.registry', `路线注册表读不出来：${error}`, { hint: `恢复 ${REGISTRY_PATH}（git checkout -- ${REGISTRY_PATH}），再跑 npm run check:repo` });
  const diags = validateRegistry(raw, { root });
  if (diags.length) {
    const head = diags.slice(0, 5).map(d => `${d.path}：${d.message}`).join('；');
    throw new CliError('contract.registry', `路线注册表 ${REGISTRY_PATH} 不合格（${diags.length} 处）：${head}${diags.length > 5 ? '……' : ''}`, { hint: '跑 npm run check:repo 看全部诊断，修好注册表再重试' });
  }
  return new Registry(raw);
}

const round = (x, n) => String(Number(x.toFixed(n)));

/** 命令模版里能用的变量。dir 是仓库相对路径（正斜杠），命令都在仓库根目录执行。 */
export function filmVars({ dir, name, dur, fps, width, height }) {
  const frames = Math.round(dur * fps);
  return {
    dir, name, dur: String(dur), fps: String(fps), width: String(width), height: String(height), size: `${width}x${height}`,
    mid: round(dur / 2, 3), last: round(Math.max(0, dur - 1 / fps), 3),
    midFrame: String(Math.floor(frames / 2)), lastFrame: String(Math.max(0, frames - 1)),
  };
}

/** 把步骤里的 {变量} 换成实际值；不认识的变量原样保留（校验阶段已经拦下）。 */
export function expandSteps(steps, vars) {
  const sub = s => String(s).replace(/\{([A-Za-z]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return (steps || []).map(s => ({
    stage: s.stage,
    title: sub(s.title),
    argv: s.run.map(sub),
    env: Object.entries(s.env || {}).map(([name, v]) => ({ name, describe: v.describe, default: v.default ?? null, required: !!v.required })),
    requires: s.requires || [],
    output: s.output ? sub(s.output) : null,
  }));
}

function quote(arg, platform) {
  if (/^[A-Za-z0-9_./:=,@%+-]+$/.test(arg)) return arg;
  return platform === 'win32' ? `'${arg.replace(/'/g, "''")}'` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** 给人看的一行命令，以及要先设的环境变量说明。 */
export function formatStep(step, { platform = process.platform } = {}) {
  const command = step.argv.map(a => quote(a, platform)).join(' ');
  const notes = [];
  for (const e of step.env) {
    const set = platform === 'win32' ? `$env:${e.name} = '<值>'` : `export ${e.name}=<值>`;
    const tag = e.required ? '必填' : `可选${e.default ? `，不设时用 ${e.default}` : ''}`;
    notes.push(`环境变量 ${e.name}（${tag}）：${e.describe}。写法：${set}`);
  }
  if (platform === 'win32' && step.argv[0] === 'sh') notes.push('这一步要 POSIX sh：Windows 上在 Git Bash 里执行（统一入口 npm run film 在建，见 docs/CLI.md）');
  return { command, notes };
}
