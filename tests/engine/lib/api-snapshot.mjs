// engine 九层的 API 快照：模块 → 排序后的导出名，与 tests/engine/api-snapshot.json 比对（审计 CODE-04 ①）。
// 范围是 P13 维护的层：engine/core/{clock,math,noise,stroke}.js 与 engine/{form,shade,stage,look,paint,overlay}/*.js。
//
// 每个模块在快照里标一个稳定级别：
//   stable        《北冥》、作品站、lab、路线模版在用的接口：导出名必须与快照逐个相同（删、改名、新增都要先更新快照）
//   experimental  新沉淀、还在打磨的画法：只要求模块登记在快照里，导出可以变
// 新模块必须先登记（默认按 experimental 写进快照，稳定后手工改成 stable）。改了 stable 模块的导出：
// 确认是有意的，再运行 node tests/engine/lib/api-snapshot.mjs --write 更新快照，并在 CHANGELOG 的 [Unreleased] 记一笔。
//
// 库：listModules(root) / collect(root) / compare(snapshot, current) → { errors[], notes[] }
// 命令：node tests/engine/lib/api-snapshot.mjs [--write] [--json]   不写参数 = 只比对（不一致 exit 4）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { defineCommand, runCli, isMain, CliError } from '../../../tools/lib/cli.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SNAPSHOT = path.join(ROOT, 'tests/engine/api-snapshot.json');
const CORE = ['clock', 'math', 'noise', 'stroke'];
const LAYERS = ['form', 'shade', 'stage', 'look', 'paint', 'overlay'];
const LEVELS = ['stable', 'experimental'];

export function listModules(root = ROOT) {
  const out = CORE.map(n => `engine/core/${n}.js`);
  for (const L of LAYERS) {
    for (const f of fs.readdirSync(path.join(root, 'engine', L)).sort()) if (f.endsWith('.js')) out.push(`engine/${L}/${f}`);
  }
  return out;
}

export async function collect(root = ROOT) {
  const mods = {};
  for (const rel of listModules(root)) {
    const m = await import(pathToFileURL(path.join(root, rel)).href);
    mods[rel] = Object.keys(m).sort();
  }
  return mods;
}

export function readSnapshot(file = SNAPSHOT) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (s.schemaVersion !== 1 || !s.modules || typeof s.modules !== 'object') throw new Error(`${file}：要是 { schemaVersion: 1, modules: {…} }`);
  for (const [rel, e] of Object.entries(s.modules)) {
    if (!LEVELS.includes(e.stability)) throw new Error(`${file}：${rel} 的 stability 只能是 ${LEVELS.join(' / ')}，收到 ${JSON.stringify(e.stability)}`);
    if (!Array.isArray(e.exports)) throw new Error(`${file}：${rel} 缺 exports 数组`);
  }
  return s;
}

export function compare(snapshot, current) {
  const errors = [], notes = [];
  for (const [rel, names] of Object.entries(current)) {
    const e = snapshot.modules[rel];
    if (!e) { errors.push(`${rel}：新模块还没登记进快照（先定 stable / experimental）`); continue; }
    const want = new Set(e.exports), have = new Set(names);
    const removed = e.exports.filter(n => !have.has(n)), added = names.filter(n => !want.has(n));
    if (!removed.length && !added.length) continue;
    const what = [removed.length ? `少了 ${removed.join('、')}` : '', added.length ? `多了 ${added.join('、')}` : ''].filter(Boolean).join('；');
    (e.stability === 'stable' ? errors : notes).push(`${rel}（${e.stability}）：${what}`);
  }
  for (const rel of Object.keys(snapshot.modules)) if (!current[rel]) errors.push(`${rel}：快照里有、仓库里没有了（删了或改名了模块）`);
  return { errors, notes };
}

export function nextSnapshot(snapshot, current) {
  const modules = {};
  for (const [rel, names] of Object.entries(current)) modules[rel] = { stability: snapshot?.modules?.[rel]?.stability ?? 'experimental', exports: names };
  return { schemaVersion: 1, note: 'engine 九层的导出快照（tests/engine/api-snapshot.test.mjs）。stable 的导出名必须逐个相同；更新：node tests/engine/lib/api-snapshot.mjs --write', modules };
}

const cmd = defineCommand({
  name: 'engine-api-snapshot',
  summary: '比对或更新 engine 九层的导出快照（tests/engine/api-snapshot.json）',
  usage: ['node tests/engine/lib/api-snapshot.mjs [--write] [--json]'],
  options: { write: { type: 'boolean', describe: '按当前代码重写快照（保留已有的 stable / experimental 标记，新模块记 experimental）' } },
  exitCodes: { 0: '与快照一致（或已写好）', 2: '用法错误', 4: 'stable 模块的导出与快照不一致、或有模块没登记' },
  examples: ['node tests/engine/lib/api-snapshot.mjs            # 只比对', 'node tests/engine/lib/api-snapshot.mjs --write    # 有意改了 API 之后更新快照'],
  run: async ctx => {
    const current = await collect();
    let snap = null;
    try { snap = readSnapshot(); } catch (e) { if (!ctx.opts.write) throw new CliError('contract.snapshot', `读不了快照：${e.message}`, { hint: '运行 node tests/engine/lib/api-snapshot.mjs --write 生成' }); }
    if (ctx.opts.write) {
      const next = nextSnapshot(snap, current);
      fs.writeFileSync(SNAPSHOT, JSON.stringify(next, null, 1) + '\n');
      const fresh = Object.keys(current).filter(r => !snap?.modules?.[r]);
      for (const r of fresh) ctx.warn('snapshot.new-module', `${r} 按 experimental 登记`, '稳定后在快照里改成 stable');
      ctx.out(`已写 ${path.relative(ROOT, SNAPSHOT)}：${Object.keys(current).length} 个模块`);
      return { data: { modules: Object.keys(current).length, fresh }, outputs: [{ path: path.relative(ROOT, SNAPSHOT), kind: 'snapshot' }] };
    }
    const { errors, notes } = compare(snap, current);
    for (const n of notes) ctx.log.info(`（experimental，不拦）${n}`);
    if (errors.length) {
      return { error: new CliError('contract.api-snapshot', `engine 导出与快照不一致：\n  ${errors.join('\n  ')}`,
        { hint: '确认是有意的 API 变化后运行 node tests/engine/lib/api-snapshot.mjs --write，并在 CHANGELOG 的 [Unreleased] 记一笔' }), data: { errors, notes } };
    }
    ctx.out(`engine 导出与快照一致：${Object.keys(current).length} 个模块`);
    return { data: { errors, notes } };
  },
});

if (isMain(import.meta.url)) runCli(cmd);
