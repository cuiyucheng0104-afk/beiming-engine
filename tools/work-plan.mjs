#!/usr/bin/env node
// Read-only work-plan inspection. This does not render or claim implementation completion.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATES = new Set(['planned', 'in-progress', 'blocked', 'done']);
const ROUTES = new Set(['shared', 'beiming', 'raea']);
function safePath(p) {
  if (typeof p !== 'string' || !p.length || isAbsolute(p) || /[\\:\x00-\x1f]/.test(p)) return false;
  if (p === '**') return true;
  const base = p.endsWith('/**') ? p.slice(0, -3) : p.replace(/\/$/, '');
  return !base.includes('*') && base.split('/').every(part => part && part !== '.' && part !== '..');
}

export function validatePlan(plan) {
  const errors = [];
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.tasks)) return ['Expected schemaVersion=1 and tasks array.'];
  const ids = new Map();
  for (const [i, task] of plan.tasks.entries()) {
    if (!task || typeof task !== 'object') { errors.push(`tasks[${i}] must be an object`); continue; }
    if (typeof task.id !== 'string' || !/^[A-Z]\d{2}$/.test(task.id)) errors.push(`tasks[${i}]: invalid id`);
    if (ids.has(task.id)) errors.push(`Duplicate id ${task.id}`);
    ids.set(task.id, task);
    for (const field of ['title', 'ownerRole']) if (typeof task[field] !== 'string' || !task[field].trim()) errors.push(`${task.id}: missing ${field}`);
    if (!ROUTES.has(task.route)) errors.push(`${task.id}: invalid route`);
    if (!STATES.has(task.status)) errors.push(`${task.id}: invalid status`);
    for (const field of ['dependsOn', 'inputs', 'writeScope', 'outputs', 'acceptance', 'evidence']) {
      if (!Array.isArray(task[field]) || task[field].some(x => typeof x !== 'string' || !x.trim())) errors.push(`${task.id}: invalid ${field}`);
    }
    for (const field of ['inputs', 'writeScope', 'outputs', 'acceptance']) if (Array.isArray(task[field]) && !task[field].length) errors.push(`${task.id}: ${field} cannot be empty`);
    if (Array.isArray(task.writeScope) && task.writeScope.some(p => !safePath(p))) errors.push(`${task.id}: writeScope must stay inside the repository`);
    if (task.status === 'done' && (!Array.isArray(task.evidence) || !task.evidence.length)) errors.push(`${task.id}: done requires evidence`);
    if (task.status === 'blocked' && (typeof task.blocker !== 'string' || !task.blocker.trim())) errors.push(`${task.id}: blocked requires a nonempty blocker`);
    if (task.playbook && !safePath(task.playbook)) errors.push(`${task.id}: invalid playbook path`);
  }
  for (const task of plan.tasks.filter(t => t && typeof t === 'object')) {
    for (const dep of Array.isArray(task.dependsOn) ? task.dependsOn : []) {
      if (!ids.has(dep)) errors.push(`${task.id}: unknown dependency ${dep}`);
      if (task.status === 'done' && ids.get(dep)?.status !== 'done') errors.push(`${task.id}: done before dependency ${dep}`);
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(id, chain) {
    if (visiting.has(id)) { errors.push(`Dependency cycle: ${[...chain, id].join(' -> ')}`); return; }
    if (visited.has(id) || !ids.has(id)) return;
    visiting.add(id);
    for (const dep of Array.isArray(ids.get(id).dependsOn) ? ids.get(id).dependsOn : []) visit(dep, [...chain, id]);
    visiting.delete(id); visited.add(id);
  }
  for (const id of ids.keys()) visit(id, []);
  return errors;
}

// Conservatively treat case/Unicode aliases as conflicts on the shared Mac/Windows workflow.
function scopeRoot(p) { return p.normalize('NFC').toLowerCase().replace(/\*.*$/, '').replace(/\/$/, ''); }
function scopesOverlap(a, b) {
  const x = scopeRoot(a), y = scopeRoot(b);
  return !x || !y || x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}
export function inspectPlan(plan, route) {
  const errors = validatePlan(plan);
  if (errors.length) throw new Error(errors.join('\n'));
  if (route && !ROUTES.has(route)) throw new Error(`Unknown route: ${route}`);
  const byId = new Map(plan.tasks.map(t => [t.id, t]));
  const tasks = plan.tasks.filter(t => !route || t.route === route || t.route === 'shared');
  const ready = tasks.filter(t => t.status === 'planned' && t.dependsOn.every(id => byId.get(id).status === 'done'));
  const waiting = tasks.filter(t => t.status !== 'done').map(t => ({
    id: t.id, route: t.route, status: t.status, blocker: t.blocker ?? null,
    dependencies: t.dependsOn.filter(id => byId.get(id).status !== 'done').map(id => {
      const dep = byId.get(id);
      return { id, route: dep.route, status: dep.status, title: dep.title };
    }),
  })).filter(t => t.dependencies.length || t.status === 'blocked');
  // Waiting for input does not release files already assigned to a task.
  const candidates = [...ready, ...plan.tasks.filter(t => t.status === 'in-progress' || t.status === 'blocked')];
  const conflicts = [];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const overlap = candidates[i].writeScope.flatMap(a => candidates[j].writeScope.filter(b => scopesOverlap(a, b)).map(b => [a, b]));
    if (overlap.length) conflicts.push({ tasks: [candidates[i].id, candidates[j].id], statuses: [candidates[i].status, candidates[j].status], scopes: overlap });
  }
  return { total: plan.tasks.length, shown: tasks.length, counts: Object.fromEntries([...STATES].map(s => [s, tasks.filter(t => t.status === s).length])), ready, waiting, conflicts };
}

function main() {
  const args = process.argv.slice(2);
  let route, file = resolve(ROOT, 'docs/routes/work-plan.json'), json = false, list = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--route' || arg === '--file') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--route') route = value; else file = resolve(value);
    } else if (arg === '--json') json = true;
    else if (arg === '--ready') list = true;
    else if (arg === '--check') { /* validation is always performed */ }
    else if (arg === '--help') {
      console.log('node tools/work-plan.mjs [--check | --ready] [--route beiming|raea|shared] [--json] [--file plan.json]\n只读检查；不执行任务、不改变状态、不启动渲染。');
      return;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const result = inspectPlan(JSON.parse(readFileSync(file, 'utf8')), route);
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`计划有效：${result.total} 项；当前选择 ${result.shown} 项。`);
  console.log(Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(', '));
  if (list) for (const task of result.ready) console.log(`${task.id} [${task.route}] ${task.title}\n  负责：${task.ownerRole}\n  写入：${task.writeScope.join(', ')}\n  指引：${task.playbook}`);
  if (list) for (const task of result.waiting) console.log(`待前置：${task.id} ← ${task.dependencies.map(dep => `${dep.id}[${dep.route}/${dep.status}]`).join(', ') || '无未完成依赖'}${task.blocker ? `；阻塞原因：${task.blocker}` : ''}`);
  for (const conflict of result.conflicts) console.log(`不可并行写入：${conflict.tasks.join(' / ')}（${conflict.scopes.map(s => s.join(' ↔ ')).join(', ')}）`);
}
// Node realpaths the entry module (symlinks, Windows junctions, macOS /tmp -> /private/tmp) before it
// builds import.meta.url but leaves argv[1] as typed, so compare both sides after realpath. A mismatch
// here used to skip main() and exit 0, silently passing a broken plan.
export function isEntryPoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try { return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
}
if (isEntryPoint()) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
