#!/usr/bin/env node
// 派工前的拒发检查：一份派工单对着 config.json 查上限，超了就不发。
// 用法：node beiming/crew/dispatch-check.mjs <派工单.json>
// 派工单是数组，每项 { id, role, contextTokens, tokenCap, line }；line 是 engine（默认）、core、lab、cleanup 之一。
// shortcut: contextTokens 由集成负责人自己估了填进来，这里不去数必读文件；估不准的次数多了再改成按文件算。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const LINES = ['engine', 'core', 'lab', 'cleanup'];

export function checkDispatch(plan, config = CONFIG) {
  const problems = [];
  if (!Array.isArray(plan)) return ['派工单必须是数组'];
  const perRole = {};
  const writers = { engine: 0, core: 0, lab: 0, cleanup: 0 };
  const seen = new Set();
  for (const [i, item] of plan.entries()) {
    const who = item?.id ?? `第 ${i + 1} 项`;
    if (!item?.id || seen.has(item.id)) problems.push(`${who}：id 必须有且不重复`);
    seen.add(item?.id);
    const role = config.roles[item?.role];
    if (!role) { problems.push(`${who}：没有这个角色 ${item?.role}`); continue; }
    const line = item.line ?? 'engine';
    if (!LINES.includes(line)) { problems.push(`${who}：line 只能是 ${LINES.join('、')}`); continue; }
    if (!Number.isFinite(item.contextTokens)) problems.push(`${who}：没填 contextTokens`);
    else if (item.contextTokens > role.contextCap) problems.push(`${who}：起始上下文 ${item.contextTokens} 超过 ${item.role} 的上限 ${role.contextCap}`);
    if (role.tokenCap !== undefined) {
      if (!Number.isFinite(item.tokenCap)) problems.push(`${who}：没填 tokenCap`);
      else if (item.tokenCap > role.tokenCap) problems.push(`${who}：用量上限 ${item.tokenCap} 超过 ${item.role} 的上限 ${role.tokenCap}`);
    }
    perRole[item.role] = (perRole[item.role] ?? 0) + 1;
    if (line === 'cleanup' || role.countsAsWriter) writers[line] += 1;
  }
  for (const [name, n] of Object.entries(perRole)) {
    const cap = config.roles[name].concurrency;
    if (n > cap) problems.push(`${name} 同时 ${n} 个，超过上限 ${cap}`);
  }
  const L = config.limits;
  // 核心线的写者也在引擎仓库里写代码，一起算进 8 个里。
  if (writers.engine + writers.core > L.engineWriters) problems.push(`引擎仓库同时写代码的工作包 ${writers.engine + writers.core} 个，超过上限 ${L.engineWriters}`);
  if (writers.core > L.coreWriters) problems.push(`核心线写者 ${writers.core} 个，超过上限 ${L.coreWriters}`);
  if (writers.lab > L.labWriters) problems.push(`实验室线 ${writers.lab} 路，超过上限 ${L.labWriters}`);
  if (writers.cleanup > L.cleanupPullRequests) problems.push(`清理 PR ${writers.cleanup} 个，超过上限 ${L.cleanupPullRequests}`);
  if (plan.length > L.total) problems.push(`一共 ${plan.length} 个会话，超过上限 ${L.total}`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('用法：node beiming/crew/dispatch-check.mjs <派工单.json>'); process.exit(2); }
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const problems = checkDispatch(plan);
  for (const p of problems) console.log(`✗ ${p}`);
  const total = plan.reduce((s, x) => s + (x.tokenCap ?? 0), 0);
  console.log(problems.length ? `拒发：${problems.length} 处超限` : `可以发：${plan.length} 个会话，用量上限合计 ${total} token`);
  process.exit(problems.length ? 1 : 0);
}
