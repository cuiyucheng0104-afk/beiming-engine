#!/usr/bin/env node
// 北冥仓库 · 引擎工程待办（D06）：docs/routes/work-plan.json 的只读检查与领取视图。只读：不改计划、不执行任务、不渲染。
//   npm run plan:check  = node tools/work-plan.mjs --check            结构、依赖、认领与过期、证据与指引路径、写入范围冲突
//   npm run plan:next   = node tools/work-plan.mjs --ready [--route a|b|c|shared]   依赖已满足、可以领取的任务
//   node tools/work-plan.mjs --verify-diff <任务> [--base <提交>]       基线以来的改动是否都落在该任务的写入范围里
//   node tools/work-plan.mjs --cards                                    按 JSON 生成 work-breakdown.md 的依赖总览与任务卡
// 旧名 npm run routes:check / routes:next 保留一个版本，调用时提示改名（D06）。做作品不用它：作品由 film.json 与
// films/<名>/review/ 记录；这里只管引擎与工具的工程任务（T 编号）和加固工作包（H 编号）。
//
// 计划 schemaVersion 2（v1 照样能读）：
//   task.route      注册表 id（a / b / c，见 routes/routes.json）或 shared；旧名 beiming / raea 等按别名认，v2 里会提示改写
//   task.status     planned | in-progress | blocked | done | superseded
//   task.claim      { by, session, baseCommit, startedAt, expiresAt?, note? }：in-progress 与 blocked 必须有；过了到期日（默认开工后
//                   claimTtlDays 天）算认领过期；续期时改 expiresAt，并在 note 写明谁、哪天、为什么续
//   task.evidence   [{ kind: file | result | command | commit, ref, note?, sha256? }]：done 至少一条；file / result 要存在，commit 要能在 git 里找到
//   task.superseded { by: [任务 id], reason }：被别的任务或已有实现取代；依赖它的任务要改成依赖取代者
//   task.playbook   详细指引（仓库相对路径，必须存在）
//   plan.newRoots   计划新增的根目录与根文件（如 evals、CHANGELOG.md）：未完成任务的写入范围首段要么已在仓库里，要么登记在这里
// 退出码：0 合格（可以有提示）；4 计划不合格（结构错误、两个在办任务写入范围重叠、认领过期、证据或指引缺失；
// --strict 时可领取任务之间的重叠、输入里写错的路径、没登记的新根目录也算）；verify-diff 有越界改动也是 4；2 用法错误；3 没有 git；1 内部错误。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli, suggest } from './lib/cli.mjs';
import { loadRegistry } from './lib/routes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLAN_PATH = 'docs/routes/work-plan.json';
export const CARDS_DOC = 'docs/routes/work-breakdown.md';
export const STATES = Object.freeze(['planned', 'in-progress', 'blocked', 'done', 'superseded']);
export const EVIDENCE_KINDS = Object.freeze(['file', 'result', 'command', 'commit']);
const ACTIVE = new Set(['in-progress', 'blocked']);
const SHARED = 'shared';
const DEFAULT_CLAIM_TTL_DAYS = 14;
const DAY_MS = 86_400_000;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SHA = /^[0-9a-f]{7,40}$/;

// ───────────────────────── 路线 ─────────────────────────

let registryCache = null;
function defaultRegistry() { return (registryCache ??= loadRegistry(ROOT)); }

/** 路线写法 → { id, via }：注册表 id、别名（含 legacyId）、shared；不认识返回 null。 */
export function resolveRoute(token, reg = defaultRegistry()) {
  const t = String(token ?? '').trim().toLowerCase();
  if (t === SHARED) return { id: SHARED, via: 'id' };
  const hit = reg.resolve(t);
  return hit ? { id: hit.route.id, via: hit.via } : null;
}

/** 「a（…）、b（…）、c（…）、shared（跨路线工程）」 */
export const legalRoutes = (reg = defaultRegistry()) => `${reg.describeIds()}、shared（跨路线工程）`;

function unknownRouteError(token, reg) {
  const s = suggest(String(token).toLowerCase(), [...reg.allTokens(), SHARED]);
  return new CliError('usage.unknown-route', `未知路线「${token}」：只能是 ${legalRoutes(reg)}`, `${s ? `是不是想写 --route ${s}？` : ''}旧名 ${reg.routes.flatMap(r => r.aliases ?? []).join('、')} 也认；路线说明见 routes/README.md`);
}

// ───────────────────────── 结构校验 ─────────────────────────

/** 写入范围是不是仓库里的规范路径（不越界、不用反斜杠、通配只许出现在末尾的 /**）。 */
export function safePath(p) {
  if (typeof p !== 'string' || !p.length || isAbsolute(p) || /[\\:\x00-\x1f]/.test(p)) return false;
  if (p === '**') return true;
  const base = p.endsWith('/**') ? p.slice(0, -3) : p.replace(/\/$/, '');
  return !base.includes('*') && base.split('/').every(part => part && part !== '.' && part !== '..');
}

/**
 * 计划的结构诊断（不读文件系统、不跑 git）：{ version, errors: [{code, message, hint, task}], warnings: […] }。
 * 只看 JSON 本身：字段、状态、路线、认领与证据的格式、依赖存在与成环、done 前置、取代关系。
 */
export function diagnosePlan(plan, { reg = defaultRegistry() } = {}) {
  const errors = [], warnings = [];
  const E = (task, code, message, hint = null) => errors.push({ task, code, message, hint });
  const W = (task, code, message, hint = null) => warnings.push({ task, code, message, hint });
  if (!isObj(plan) || ![1, 2].includes(plan.schemaVersion) || !Array.isArray(plan.tasks)) {
    E(null, 'plan.shape', '计划要写成 { "schemaVersion": 2, "tasks": [ … ] }（v1 也认）', `字段见 ${CARDS_DOC} 开头与 tools/work-plan.mjs 文件头`);
    return { version: null, errors, warnings };
  }
  const v2 = plan.schemaVersion === 2;
  if (!v2) W(null, 'plan.v1', 'schemaVersion 1（旧格式）：路线可写旧名、证据是字符串、没有认领记录', '升到 v2：route 用注册表 id，in-progress / blocked 写 claim，证据写成对象（见 tools/work-plan.mjs 文件头）');
  if (plan.claimTtlDays !== undefined && !(Number.isInteger(plan.claimTtlDays) && plan.claimTtlDays > 0)) E(null, 'plan.claim-ttl', `claimTtlDays 要是正整数（天），现在是 ${JSON.stringify(plan.claimTtlDays)}`);
  if (plan.newRoots !== undefined && !(Array.isArray(plan.newRoots) && plan.newRoots.every(x => isStr(x) && !x.includes('/') && safePath(x)))) E(null, 'plan.new-roots', 'newRoots 要写成仓库根下的名字数组（不带斜杠），如 ["evals", "CHANGELOG.md"]');
  const ids = new Map();
  plan.tasks.forEach((task, i) => {
    if (!isObj(task)) { E(null, 'task.shape', `tasks[${i}] 要是对象`); return; }
    const id = typeof task.id === 'string' && /^[A-Z]\d{2}$/.test(task.id) ? task.id : null;
    if (!id) E(null, 'task.id', `tasks[${i}] 的 id ${JSON.stringify(task.id)} 不合规：一个大写字母加两位数字（如 T05、H02）`);
    else if (ids.has(id)) E(id, 'task.duplicate', `任务 id ${id} 重复`);
    if (id) ids.set(id, task);
  });
  for (const task of plan.tasks.filter(isObj)) {
    const id = task.id;
    for (const f of ['title', 'ownerRole']) if (!isStr(task[f])) E(id, 'task.field', `${id}：缺少 ${f}`);
    const r = resolveRoute(task.route, reg);
    if (!r) E(id, 'task.route', `${id}：路线 ${JSON.stringify(task.route)} 不认识，只能是 ${legalRoutes(reg)}`);
    else if (r.via === 'alias' && v2) W(id, 'task.route-alias', `${id}：路线写的是旧名 ${JSON.stringify(task.route)}，注册表 id 是 "${r.id}"`, `改成 "route": "${r.id}"`);
    if (!STATES.includes(task.status) || (!v2 && task.status === 'superseded')) E(id, 'task.status', `${id}：状态 ${JSON.stringify(task.status)} 不认识，只能是 ${(v2 ? STATES : STATES.slice(0, 4)).join(' / ')}`);
    for (const f of ['dependsOn', 'inputs', 'writeScope', 'outputs', 'acceptance']) {
      if (!Array.isArray(task[f]) || task[f].some(x => !isStr(x))) E(id, 'task.field', `${id}：${f} 要是字符串数组`);
    }
    for (const f of ['inputs', 'writeScope', 'outputs', 'acceptance']) if (Array.isArray(task[f]) && !task[f].length) E(id, 'task.field', `${id}：${f} 不能为空`);
    if (Array.isArray(task.writeScope) && task.writeScope.some(p => !safePath(p))) E(id, 'task.scope', `${id}：写入范围要在仓库里（相对路径、正斜杠、不含 . 与 ..，通配只用末尾的 /**）：${task.writeScope.filter(p => !safePath(p)).join(', ')}`);
    // 证据
    const ev = task.evidence;
    if (!Array.isArray(ev)) E(id, 'task.evidence', `${id}：evidence 要是数组`);
    else ev.forEach((x, k) => {
      if (!v2) { if (!isStr(x)) E(id, 'task.evidence', `${id}：evidence[${k}] 要是非空字符串`); return; }
      if (!isObj(x) || !EVIDENCE_KINDS.includes(x.kind) || !isStr(x.ref)) { E(id, 'task.evidence', `${id}：evidence[${k}] 要写成 { kind: ${EVIDENCE_KINDS.join(' | ')}, ref, note? }`); return; }
      if ((x.kind === 'file' || x.kind === 'result') && !safePath(x.ref)) E(id, 'task.evidence', `${id}：evidence[${k}] 的文件 ${x.ref} 要写成仓库相对路径`);
      if (x.kind === 'commit' && !SHA.test(x.ref)) E(id, 'task.evidence', `${id}：evidence[${k}] 的提交号 ${x.ref} 要是 7–40 位十六进制`);
      if (x.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(x.sha256)) E(id, 'task.evidence', `${id}：evidence[${k}].sha256 要是 64 位十六进制`);
      if (x.note !== undefined && !isStr(x.note)) E(id, 'task.evidence', `${id}：evidence[${k}].note 要是非空字符串`);
    });
    if (task.status === 'done' && (!Array.isArray(ev) || !ev.length)) E(id, 'task.done-evidence', `${id}：标成 done 必须有证据`, '写实际跑过的命令、结果文件或提交');
    if (task.status === 'blocked' && !isStr(task.blocker)) E(id, 'task.blocker', `${id}：blocked 要写非空的 blocker（缺什么、等谁）`);
    // 认领
    if (task.claim !== undefined) {
      const c = task.claim;
      const bad = !isObj(c) ? ['整体'] : [
        ...['by', 'session'].filter(k => !isStr(c[k])),
        ...(SHA.test(c.baseCommit ?? '') ? [] : ['baseCommit（7–40 位提交号）']),
        ...(ISO_DATE.test(c.startedAt ?? '') && !Number.isNaN(Date.parse(c.startedAt)) ? [] : ['startedAt（ISO 日期）']),
        ...(c.expiresAt === undefined || (ISO_DATE.test(c.expiresAt) && Date.parse(c.expiresAt) > Date.parse(c.startedAt)) ? [] : ['expiresAt（晚于 startedAt 的 ISO 日期）']),
        ...(c.note === undefined || isStr(c.note) ? [] : ['note（非空字符串）']),
      ];
      if (bad.length) E(id, 'task.claim', `${id}：claim 格式不对（${bad.join('、')}）`, '写成 { "by": "<谁>", "session": "<分支或会话>", "baseCommit": "<开工时的提交>", "startedAt": "YYYY-MM-DD" }');
      if (task.status === 'planned') W(id, 'task.claim-planned', `${id}：还是 planned 却有认领记录`, '开工就改成 in-progress；放弃就删掉 claim');
    } else if (v2 && ACTIVE.has(task.status)) E(id, 'task.claim-missing', `${id}：${task.status} 必须写 claim（谁在做、在哪个分支、从哪个提交开始）`, '没人做就改回 planned');
    // 取代
    if (task.status === 'superseded') {
      const s = task.superseded;
      if (!isObj(s) || !Array.isArray(s.by) || !s.by.length || !s.by.every(isStr) || !isStr(s.reason)) E(id, 'task.superseded', `${id}：superseded 要写 { "by": ["<取代它的任务>"], "reason": "<为什么>" }`);
      else for (const b of s.by) {
        if (b === id) E(id, 'task.superseded', `${id}：不能被自己取代`);
        else if (!ids.has(b)) E(id, 'task.superseded', `${id}：取代者 ${b} 不在计划里`);
        else if (ids.get(b).status === 'superseded') E(id, 'task.superseded', `${id}：取代者 ${b} 自己也被取代了`, `直接写最终的取代者`);
      }
    } else if (task.superseded !== undefined) E(id, 'task.superseded', `${id}：只有 superseded 状态才写 superseded 字段`);
    // 指引
    if (task.playbook === undefined) { if (v2) E(id, 'task.playbook', `${id}：缺少 playbook（详细指引的仓库相对路径）`); }
    else if (!safePath(task.playbook) || task.playbook.endsWith('/') || task.playbook.includes('*')) E(id, 'task.playbook', `${id}：playbook ${JSON.stringify(task.playbook)} 要是仓库相对的文件路径`);
  }
  // 依赖
  for (const task of plan.tasks.filter(isObj)) {
    for (const dep of Array.isArray(task.dependsOn) ? task.dependsOn : []) {
      const d = ids.get(dep);
      if (!d) { E(task.id, 'task.dependency', `${task.id}：依赖的 ${dep} 不在计划里`); continue; }
      if (task.status === 'done' && d.status !== 'done') E(task.id, 'task.done-order', `${task.id}：标成 done 了，依赖 ${dep} 还是 ${d.status}`);
      if (d.status === 'superseded' && task.status !== 'superseded') {
        const by = isObj(d.superseded) && Array.isArray(d.superseded.by) ? d.superseded.by.join('、') : '取代它的任务';
        E(task.id, 'task.dependency-superseded', `${task.id}：依赖的 ${dep} 已被取代`, `改成依赖 ${by}`);
      }
    }
  }
  const visiting = new Set(), visited = new Set();
  const visit = (id, chain) => {
    if (visiting.has(id)) { E(id, 'task.cycle', `依赖成环：${[...chain, id].join(' → ')}`); return; }
    if (visited.has(id) || !ids.has(id)) return;
    visiting.add(id);
    const deps = ids.get(id).dependsOn;
    for (const dep of Array.isArray(deps) ? deps : []) visit(dep, [...chain, id]);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids.keys()) visit(id, []);
  return { version: plan.schemaVersion, errors, warnings };
}

/** 兼容旧接口：只返回结构错误的说明文字（空数组 = 结构合格）。 */
export function validatePlan(plan, opts) { return diagnosePlan(plan, opts).errors.map(e => e.message); }

// ───────────────────────── 写入范围 ─────────────────────────

// Mac / Windows 共用工作区时大小写与 Unicode 等价名按同一路径处理（保守：宁可多报冲突）。
function scopeRoot(p) { return p.normalize('NFC').toLowerCase().replace(/\*.*$/, '').replace(/\/$/, ''); }
export function scopesOverlap(a, b) {
  const x = scopeRoot(a), y = scopeRoot(b);
  return !x || !y || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
/** 某个文件是否落在写入范围里（verify-diff 用，大小写敏感：git 里大小写不同就是两个路径）。 */
export function inScope(file, scopes) {
  return scopes.some(s => {
    const root = s === '**' ? '' : s.replace(/\/\*\*$/, '').replace(/\/$/, '');
    return !root || file === root || file.startsWith(`${root}/`);
  });
}

// ───────────────────────── 视图 ─────────────────────────

/** 认领的到期时间（毫秒）。 */
function claimExpiry(claim, ttlDays) {
  if (claim.expiresAt) return Date.parse(claim.expiresAt);
  return Date.parse(claim.startedAt) + ttlDays * DAY_MS;
}
const day = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * 领取视图：{ total, shown, route, counts, ready, waiting, conflicts, claims }。
 * 计划结构不合格抛 CliError(contract.plan)；路线不认识抛 CliError(usage.unknown-route)。
 * conflicts 覆盖「可领取 + 在办（in-progress / blocked）」的全部任务（路线筛选不影响冲突检查）；
 * level：两个在办任务互相重叠是 error，涉及可领取任务的重叠是 warn（--strict 下也是 error）。
 */
export function inspectPlan(plan, route, { reg = defaultRegistry(), strict = false, now = Date.now() } = {}) {
  const diag = diagnosePlan(plan, { reg });
  if (diag.errors.length) throw new CliError('contract.plan', `计划不合格：${diag.errors.map(e => e.message).join('；')}`, `修好 ${PLAN_PATH} 再领任务；npm run plan:check 列出全部问题`);
  let want = null;
  if (route !== undefined && route !== null) {
    const r = resolveRoute(route, reg);
    if (!r) throw unknownRouteError(route, reg);
    want = r.id;
  }
  const norm = t => resolveRoute(t.route, reg).id;
  const byId = new Map(plan.tasks.map(t => [t.id, t]));
  const tasks = plan.tasks.filter(t => !want || norm(t) === want || norm(t) === SHARED);
  const ready = tasks.filter(t => t.status === 'planned' && t.dependsOn.every(id => byId.get(id).status === 'done'));
  const waiting = tasks.filter(t => !['done', 'superseded'].includes(t.status)).map(t => ({
    id: t.id, route: norm(t), status: t.status, blocker: t.blocker ?? null,
    dependencies: t.dependsOn.filter(id => byId.get(id).status !== 'done').map(id => {
      const dep = byId.get(id);
      return { id, route: norm(dep), status: dep.status, title: dep.title };
    }),
  })).filter(t => t.dependencies.length || t.status === 'blocked');
  // 等待输入不释放已经分出去的写入范围：在办任务不分路线全部参与冲突检查
  const candidates = [...ready, ...plan.tasks.filter(t => ACTIVE.has(t.status))];
  const conflicts = [];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const [a, b] = [candidates[i], candidates[j]];
    const overlap = a.writeScope.flatMap(x => b.writeScope.filter(y => scopesOverlap(x, y)).map(y => [x, y]));
    if (!overlap.length) continue;
    const bothActive = ACTIVE.has(a.status) && ACTIVE.has(b.status);
    conflicts.push({ tasks: [a.id, b.id], statuses: [a.status, b.status], scopes: overlap, level: bothActive || strict ? 'error' : 'warn' });
  }
  const ttl = plan.claimTtlDays ?? DEFAULT_CLAIM_TTL_DAYS;
  const claims = plan.tasks.filter(t => t.claim && ACTIVE.has(t.status)).map(t => {
    const exp = claimExpiry(t.claim, ttl);
    return { id: t.id, status: t.status, by: t.claim.by, session: t.claim.session, baseCommit: t.claim.baseCommit, startedAt: t.claim.startedAt, expiresAt: day(exp), stale: now > exp };
  });
  return {
    total: plan.tasks.length, shown: tasks.length, route: want,
    counts: Object.fromEntries(STATES.map(s => [s, tasks.filter(t => t.status === s).length])),
    ready, waiting, conflicts, claims, warnings: diag.warnings,
  };
}

// ───────────────────────── 审计（读文件、跑 git） ─────────────────────────

function gitAt(root) {
  const cache = new Map();
  return args => {
    const k = args.join('\0');
    if (!cache.has(k)) {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
      cache.set(k, { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', missing: r.error?.code === 'ENOENT' });
    }
    return cache.get(k);
  };
}

const exists = (root, rel) => existsSync(resolve(root, ...rel.split('/')));
const isFile = (root, rel) => { try { return statSync(resolve(root, ...rel.split('/'))).isFile(); } catch { return false; } };

function globExists(root, pattern) {
  const segs = pattern.split('/');
  const walk = (dir, i) => {
    if (i === segs.length) return true;
    const seg = segs[i];
    if (!/[*?]/.test(seg)) return existsSync(resolve(dir, seg)) && walk(resolve(dir, seg), i + 1);
    const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    let ents = [];
    try { ents = readdirSync(dir); } catch { return false; }
    return ents.some(e => re.test(e) && walk(resolve(dir, e), i + 1));
  };
  return walk(root, 0);
}

/** 输入说明里写成路径的片段：从仓库根写起的要存在；带扩展名却不从仓库根写起的算「路径不完整」（R87）。 */
export function inputPathProblems(text, root) {
  const tops = new Set(readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name));
  const out = [];
  for (const m of String(text).matchAll(/(?:^|[\s（(：:，,；;、"'`])((?:[A-Za-z0-9_.*-]+\/)+[A-Za-z0-9_.*-]*)/g)) {
    const token = m[1].replace(/[.。，、；;]+$/, '');
    const first = token.split('/')[0];
    const hasExt = /\.[A-Za-z0-9]+$/.test(token);
    if (tops.has(first)) {
      const p = token.replace(/\/$/, '');
      if (!(p.includes('*') ? globExists(root, p) : existsSync(resolve(root, ...p.split('/'))))) out.push({ token, problem: '不存在' });
    } else if (hasExt) out.push({ token, problem: '不是从仓库根写起的完整路径' });
  }
  return out;
}

/**
 * 完整审计：结构诊断 + 文件与 git 核对 + 认领过期 + 写入范围冲突。
 * 返回 { view, errors, warnings }；errors 非空即计划不合格（退出 4）。
 */
export function auditPlan(plan, { root = ROOT, reg = defaultRegistry(), strict = false, now = Date.now() } = {}) {
  const diag = diagnosePlan(plan, { reg });
  const errors = [...diag.errors], warnings = [...diag.warnings];
  if (errors.length) return { view: null, errors, warnings };
  const E = (task, code, message, hint = null) => errors.push({ task, code, message, hint });
  const W = (task, code, message, hint = null) => warnings.push({ task, code, message, hint });
  const git = gitAt(root);
  let gitOk = null;
  const newRoots = new Set(Array.isArray(plan.newRoots) ? plan.newRoots : []);
  for (const t of plan.tasks) {
    if (t.playbook !== undefined && !isFile(root, t.playbook)) E(t.id, 'task.playbook-missing', `${t.id}：详细指引 ${t.playbook} 不存在`, '改成现有文档的完整仓库相对路径，或先把文档写出来');
    for (const x of t.evidence) {
      if (plan.schemaVersion !== 2) {
        // v1 证据是字符串：像文件路径的才查
        if (/^[\w.-]+(\/[\w.-]+)+$/.test(x) && !exists(root, x)) E(t.id, 'task.evidence-missing', `${t.id}：证据文件 ${x} 不存在`);
        continue;
      }
      if (x.kind === 'file' || x.kind === 'result') {
        if (!isFile(root, x.ref)) { E(t.id, 'task.evidence-missing', `${t.id}：证据文件 ${x.ref} 不存在`, '证据要能复核：恢复文件，或改成提交号证据'); continue; }
        if (x.sha256) {
          const h = createHash('sha256').update(readFileSync(resolve(root, ...x.ref.split('/')))).digest('hex');
          if (h !== x.sha256) E(t.id, 'task.evidence-changed', `${t.id}：证据文件 ${x.ref} 的 sha256 变了（记录 ${x.sha256.slice(0, 12)}…，现在 ${h.slice(0, 12)}…）`, '证据被改过：确认后更新 sha256，或改引用提交号');
        }
      }
      if (x.kind === 'commit') {
        if (gitOk === null) gitOk = git(['rev-parse', '--git-dir']).ok;
        if (!gitOk) { W(t.id, 'task.evidence-unverified', `${t.id}：不是 git 检出（或没有 git），提交号证据 ${x.ref} 没有核对`); continue; }
        if (!git(['cat-file', '-e', `${x.ref}^{commit}`]).ok) E(t.id, 'task.evidence-missing', `${t.id}：证据提交 ${x.ref} 在本仓库里找不到`, '浅克隆要 git fetch --unshallow；确实不存在就改正提交号');
      }
    }
    if (!['done', 'superseded'].includes(t.status)) {
      for (const input of t.inputs) for (const p of inputPathProblems(input, root)) {
        (strict ? E : W)(t.id, 'task.input-path', `${t.id}：输入里的路径 ${p.token} ${p.problem}`, '写完整的仓库相对路径，领取的人才能照着找到文件（R87）');
      }
      // 写入范围的首段要么已在仓库里，要么登记为计划新增的根目录或根文件（TOOLS-15：防止写错路径、悄悄另起根目录）
      for (const s of t.writeScope) {
        const top = s.split('/')[0];
        if (top === '**' || exists(root, top) || newRoots.has(top)) continue;
        (strict ? E : W)(t.id, 'task.scope-root', `${t.id}：写入范围 ${s} 的首段 ${top} 在仓库里不存在，也没登记在计划的 newRoots 里`, '路径写错了就改正；确实要新建根目录或根文件，先在 work-plan.json 的 newRoots 里登记');
      }
    }
  }
  const view = inspectPlan(plan, null, { reg, strict, now });
  for (const c of view.claims) if (c.stale) E(c.id, 'task.claim-stale', `${c.id}：认领已过期（${c.by}，${c.startedAt} 起，${c.expiresAt} 到期）`, '还在做就续期（改 claim.expiresAt）；没人做就改回 planned 并删掉 claim');
  for (const c of view.conflicts) {
    const msg = `${c.tasks.join(' / ')}（${c.statuses.join(' / ')}）写入范围重叠：${c.scopes.map(s => s.join(' ↔ ')).join('、')}`;
    if (c.level === 'error') E(c.tasks[0], 'task.scope-conflict', msg, '拆分写入范围或串行：同一文件只能有一个在办的属主');
    else W(c.tasks[0], 'task.scope-overlap', msg, '别同时开工：一个做完再领另一个（--strict 时算错误）');
  }
  return { view, errors, warnings };
}

// ───────────────────────── verify-diff ─────────────────────────

/** 基线以来（含暂存、未暂存与未跟踪的改动）改过的文件。 */
export function changedFiles(root, base) {
  const git = gitAt(root);
  if (!git(['rev-parse', '--git-dir']).ok) throw new CliError('env.git', 'verify-diff 需要在 git 检出里运行，且能执行 git', '装好 git，在仓库根目录里运行');
  const rev = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (!rev.ok) throw new CliError('usage.bad-base', `基线 ${base} 不是这个仓库里的提交`, '给一个存在的提交号或分支名（--base）');
  const z = s => s.split('\0').filter(Boolean);
  const files = new Set([
    ...z(git(['diff', '--name-only', '--no-renames', '-z', `${rev.stdout.trim()}...HEAD`]).stdout),
    ...z(git(['diff', '--name-only', '--no-renames', '-z', 'HEAD']).stdout),
    ...z(git(['ls-files', '--others', '--exclude-standard', '-z']).stdout),
  ]);
  return { base: rev.stdout.trim(), files: [...files].sort() };
}

// ───────────────────────── 任务卡 ─────────────────────────

const code = s => `\`${s}\``;
const sentence = s => (/[。！？]$/.test(s) ? s : `${s}。`);
function evidenceText(x) {
  if (typeof x === 'string') return code(x.split('（')[0].trim());
  const note = x.note ? `（${x.note}）` : '';
  return x.kind === 'commit' ? `提交 ${code(x.ref.slice(0, 7))}${note}` : `${code(x.ref)}${note}`;
}

/** 一张任务卡（Markdown）。 */
export function formatCard(t, { ttlDays = DEFAULT_CLAIM_TTL_DAYS } = {}) {
  const lines = [`### ${t.id} · ${t.title}`, ''];
  lines.push(`- 路线：${code(t.route)}；角色：${t.ownerRole}；状态：${code(t.status)}。`);
  if (t.claim) lines.push(`- 认领：${t.claim.by}；会话 ${code(t.claim.session)}；基线 ${code(t.claim.baseCommit.slice(0, 7))}；${t.claim.startedAt.slice(0, 10)} 起，${day(claimExpiry(t.claim, ttlDays))} 到期${t.claim.note ? `（${t.claim.note}）` : ''}。`);
  if (t.status === 'blocked') lines.push(`- 阻塞：${sentence(t.blocker)}`);
  if (t.superseded) lines.push(`- 取代：由 ${t.superseded.by.join('、')} 取代；${sentence(t.superseded.reason)}`);
  lines.push(`- 依赖：${t.dependsOn.join('、') || '无'}。`);
  lines.push(`- 输入：${sentence(t.inputs.join('；'))}`);
  lines.push(`- 写入范围：${t.writeScope.map(code).join('、')}。`);
  lines.push(`- 交付：${sentence(t.outputs.join('；'))}`);
  lines.push(`- 验收：${sentence(t.acceptance.join('；'))}`);
  if (t.evidence.length) lines.push(`- 证据：${t.evidence.map(evidenceText).join('；')}。`);
  if (t.playbook) lines.push(`- 详细指引：[${posix.basename(t.playbook)}](${posix.relative(posix.dirname(CARDS_DOC), t.playbook)})。`);
  return lines.join('\n');
}

/** work-breakdown.md 里由本命令生成的一段：依赖总览（mermaid）+ 全部任务卡。 */
export function formatCards(plan) {
  const ttlDays = plan.claimTtlDays ?? DEFAULT_CLAIM_TTL_DAYS;
  const edges = [];
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) edges.push(`  ${d} --> ${t.id}`);
    if (t.superseded) for (const b of t.superseded.by) edges.push(`  ${t.id} -.-> ${b}`);
  }
  const isolated = plan.tasks.filter(t => !edges.some(e => e.split(/\s+/).includes(t.id))).map(t => `  ${t.id}`);
  const out = ['## 依赖总览', '', '实线箭头：前置依赖（箭头指向后做的任务）；虚线箭头：被取代（指向取代它的任务）。', '', '```mermaid', 'flowchart LR', ...edges, ...isolated, '```', '', '## 任务卡', ''];
  for (const t of plan.tasks) out.push(formatCard(t, { ttlDays }), '');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

export const CARDS_BEGIN = '<!-- plan:cards:begin 由 node tools/work-plan.mjs --cards 生成；改 work-plan.json 后重新生成这一段，tools/work-plan.test.mjs 逐字核对 -->';
export const CARDS_END = '<!-- plan:cards:end -->';

// ───────────────────────── 命令 ─────────────────────────

/** 旧版里 import 的入口判断，保留给调用方。 */
export function isEntryPoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try { return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
}

function loadPlanFile(opt) {
  const file = opt ? resolve(opt) : resolve(ROOT, PLAN_PATH);
  const shown = opt ?? PLAN_PATH;
  if (!existsSync(file)) throw new CliError(opt ? 'usage.no-file' : 'contract.plan-missing', `计划文件 ${shown} 不存在`, opt ? '给一个存在的 JSON 文件（--file）' : `恢复 ${PLAN_PATH}（git checkout -- ${PLAN_PATH}）`);
  try { return { file, shown, plan: JSON.parse(readFileSync(file, 'utf8')) }; } catch (e) {
    throw new CliError('contract.plan-json', `${shown} 不是合法 JSON（${e.message}）`, '修好 JSON 语法再跑');
  }
}

const RENAMED = { 'routes:check': 'plan:check', 'routes:next': 'plan:next' };

async function run(ctx) {
  const { opts } = ctx;
  const actions = ['check', 'ready', 'cards'].filter(k => opts[k]);
  if (opts['verify-diff'] !== null) actions.push('verify-diff');
  if (actions.length > 1) throw new CliError('usage.conflict', `${actions.map(a => `--${a}`).join('、')} 只能选一个`, '分别运行');
  const action = actions[0] ?? 'check';
  if (opts.base !== null && action !== 'verify-diff') throw new CliError('usage.conflict', '--base 只和 --verify-diff 一起用', null);
  if (opts.route !== null && !['check', 'ready'].includes(action)) throw new CliError('usage.conflict', '--route 只和 --check / --ready 一起用', null);
  let now = Date.now();
  if (opts.now !== null) {
    now = Date.parse(opts.now);
    if (!ISO_DATE.test(opts.now) || Number.isNaN(now)) throw new CliError('usage.bad-value', `--now 要是 ISO 日期（如 2026-11-10），收到「${opts.now}」`, null);
  }
  const lifecycle = ctx.env.npm_lifecycle_event;
  if (RENAMED[lifecycle]) ctx.warn('plan.renamed', `npm run ${lifecycle} 已改名为 npm run ${RENAMED[lifecycle]}（D06：工程计划降级为引擎工程待办），旧名保留一个版本`, `以后用 npm run ${RENAMED[lifecycle]}`);
  const reg = loadRegistry(ROOT);
  if (opts.route !== null && !resolveRoute(opts.route, reg)) throw unknownRouteError(opts.route, reg);
  const { plan, shown } = loadPlanFile(opts.file);

  if (action === 'cards') {
    const diag = diagnosePlan(plan, { reg });
    if (diag.errors.length) throw new CliError('contract.plan', `计划结构不合格，不生成任务卡：${diag.errors.map(e => e.message).join('；')}`, '先跑 npm run plan:check 修好');
    const markdown = formatCards(plan);
    ctx.out(`${CARDS_BEGIN}\n\n${markdown}\n${CARDS_END}`);
    return { data: { file: shown, markdown, begin: CARDS_BEGIN, end: CARDS_END } };
  }

  if (action === 'verify-diff') {
    const diag = diagnosePlan(plan, { reg });
    if (diag.errors.length) throw new CliError('contract.plan', `计划不合格：${diag.errors.map(e => e.message).join('；')}`, '先跑 npm run plan:check 修好');
    const id = opts['verify-diff'];
    const task = plan.tasks.find(t => t.id === id);
    if (!task) {
      const s = suggest(id, plan.tasks.map(t => t.id));
      throw new CliError('usage.unknown-task', `计划里没有任务 ${id}`, `${s ? `是不是想写 ${s}？` : ''}全部任务见 npm run plan:check`);
    }
    const base = opts.base ?? task.claim?.baseCommit;
    if (!base) throw new CliError('usage.missing-base', `${id} 没有认领记录，要用 --base 指定开工时的提交`, `例：node tools/work-plan.mjs --verify-diff ${id} --base main`);
    const { base: full, files } = changedFiles(ROOT, base);
    const outside = files.filter(f => !inScope(f, task.writeScope));
    const data = { task: id, base: full, from: opts.base ? '--base' : 'claim.baseCommit', writeScope: task.writeScope, changed: files, outside };
    if (outside.length) {
      return { data, error: { code: 'contract.scope', message: `${id} 的改动有 ${outside.length} 个文件在写入范围外：${outside.slice(0, 12).join('、')}${outside.length > 12 ? '……' : ''}`, hint: `只改 ${task.writeScope.join('、')}；别的文件要改，先请属主或集成负责人调整计划` } };
    }
    ctx.out(`${id} 的写入范围：${task.writeScope.join('、')}\n基线 ${full.slice(0, 7)}（${data.from}）以来改动 ${files.length} 个文件，全部在范围内。`);
    return { data };
  }

  // check / ready
  const { view, errors, warnings } = auditPlan(plan, { root: ROOT, reg, strict: opts.strict, now });
  for (const w of warnings) ctx.warn(w.code, w.message, w.hint);
  const routeView = view && opts.route !== null ? inspectPlan(plan, opts.route, { reg, strict: opts.strict, now }) : view;
  const data = {
    file: shown, schemaVersion: plan?.schemaVersion ?? null, strict: !!opts.strict, now: new Date(now).toISOString(),
    route: routeView?.route ?? null, total: view?.total ?? null, shown: routeView?.shown ?? null, counts: routeView?.counts ?? null,
    ready: (routeView?.ready ?? []).map(t => ({ id: t.id, route: resolveRoute(t.route, reg).id, title: t.title, ownerRole: t.ownerRole, writeScope: t.writeScope, playbook: t.playbook ?? null })),
    waiting: routeView?.waiting ?? [], conflicts: view?.conflicts ?? [], claims: view?.claims ?? [],
    errors: errors.map(({ task, code: c, message, hint }) => ({ task, code: c, message, hint })),
  };
  const lines = [];
  if (errors.length) {
    lines.push(`计划不合格：${errors.length} 个错误（${shown}）`);
    for (const e of errors) lines.push(`  ✗ [${e.code}] ${e.message}${e.hint ? `\n      提示：${e.hint}` : ''}`);
  } else {
    lines.push(`计划有效：${view.total} 项（${STATES.map(s => `${s} ${view.counts[s]}`).join('、')}）；schemaVersion ${plan.schemaVersion}；${shown}`);
    const active = view.claims;
    if (active.length) lines.push(`在办：${active.length} 项，最早 ${active.map(c => c.expiresAt).sort()[0]} 到期（--ready 列出认领人）`);
    lines.push(`可以领取：${routeView.ready.length} 项${opts.route !== null ? `（路线 ${routeView.route}，含 shared）` : ''}`);
  }
  if (action === 'ready' && routeView) {
    for (const t of routeView.ready) lines.push(`${t.id} [${resolveRoute(t.route, reg).id}] ${t.title}\n  负责：${t.ownerRole}\n  写入：${t.writeScope.join(', ')}\n  指引：${t.playbook ?? '—'}`);
    for (const t of routeView.waiting) lines.push(`待前置：${t.id} ← ${t.dependencies.map(dep => `${dep.id}[${dep.route}/${dep.status}]`).join(', ') || '无未完成依赖'}${t.blocker ? `；阻塞原因：${t.blocker}` : ''}`);
    for (const c of view.claims) lines.push(`在办：${c.id}（${c.status}）${c.by} · ${c.session} · ${c.startedAt} 起，${c.expiresAt} 到期${c.stale ? '（已过期）' : ''}`);
  }
  for (const c of view?.conflicts ?? []) lines.push(`${c.level === 'error' ? '不可并行写入' : '别同时开工'}：${c.tasks.join(' / ')}（${c.scopes.map(s => s.join(' ↔ ')).join(', ')}）`);
  ctx.out(lines.join('\n'));
  if (errors.length) return { data, error: { code: 'contract.plan', message: `工程计划不合格：${errors.length} 个错误（首个：${errors[0].message}）`, hint: errors[0].hint ?? `按上面的诊断修 ${PLAN_PATH}；改完同步 ${CARDS_DOC} 的任务卡（node tools/work-plan.mjs --cards）` } };
  return { data };
}

export const command = defineCommand({
  name: 'work-plan',
  summary: '引擎工程待办（D06）：检查 docs/routes/work-plan.json、列出可领取的任务、核对改动是否越出写入范围（只读）',
  usage: [
    'node tools/work-plan.mjs [--check] [--strict] [--json]          npm run plan:check',
    'node tools/work-plan.mjs --ready [--route a|b|c|shared] [--json] npm run plan:next -- --route c',
    'node tools/work-plan.mjs --verify-diff <任务> [--base <提交>]',
    'node tools/work-plan.mjs --cards',
  ],
  description: [
    '做作品不用它：作品由 film.json 与 films/<名>/review/ 记录，见 routes/README.md。这里只管引擎与工具的工程任务（T 编号）与加固工作包（H 编号）。',
    '旧名 npm run routes:check / routes:next 保留一个版本，调用时提示改名。',
  ],
  options: {
    check: { type: 'boolean', describe: '检查计划（默认动作）：结构、依赖、认领与过期、证据与指引路径、写入范围冲突' },
    ready: { type: 'boolean', describe: '列出依赖已满足、可以领取的任务，以及待前置、在办与冲突' },
    route: { type: 'string', arg: '<路线>', describe: '只看这条路线和 shared 的任务：a / b / c / shared（旧名 beiming、raea 等也认）', example: 'c' },
    strict: { type: 'boolean', describe: '可领取任务之间（含与在办任务）的写入范围重叠、输入里写错的路径也算错误' },
    'verify-diff': { type: 'string', arg: '<任务>', describe: '核对基线以来（含未提交、未跟踪）的改动是否都在该任务的写入范围里', example: 'H02' },
    base: { type: 'string', arg: '<提交>', describe: '--verify-diff 的基线；不给时用任务认领记录里的 baseCommit', example: 'main' },
    cards: { type: 'boolean', describe: `按 JSON 生成 ${CARDS_DOC} 的依赖总览与任务卡（打印到 stdout）` },
    file: { type: 'string', arg: '<计划.json>', describe: `检查另一份计划（默认 ${PLAN_PATH}）`, example: 'plan.json' },
    now: { type: 'string', arg: '<ISO 日期>', describe: '按这个时刻判断认领是否过期（默认现在；测试与复现用）', example: '2026-11-10' },
  },
  examples: [
    'npm run plan:check',
    'npm run plan:next -- --route b',
    'node tools/work-plan.mjs --ready --route c --json',
    'node tools/work-plan.mjs --verify-diff H02',
    'node tools/work-plan.mjs --check --strict --json',
  ],
  exitCodes: { 0: '计划合格（可以有提示）', 1: '内部错误', 2: '用法错误（未知路线、未知任务、参数冲突、--file 不存在）', 3: '--verify-diff 时没有 git', 4: '计划不合格，或 --verify-diff 有越界改动' },
  run,
});

if (isMain(import.meta.url)) await runCli(command);
