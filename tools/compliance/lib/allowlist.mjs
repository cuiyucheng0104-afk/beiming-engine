// 北冥仓库 · 合规扫描的允许清单：按 规则 + 路径 + 命中文字 精确豁免，每条必须写理由。
// 文件：tools/compliance/allowlist.json（--allowlist 可换）。格式：
//   { "schemaVersion": 1, "entries": [ { "rule": "comp.local-paths", "path": "tools/x.py", "match": "abs.txt",
//       "kind": "false-positive" | "pending", "reason": "…", "owner": "P02", "added": "2026-11-10", "expires": "2027-01-31"?, "ref": "…"? } ] }
//   path 用与 REUSE.toml 相同的通配写法（* 不跨目录，** 跨目录）；match 是命中文字或提示信息里必须出现的子串
//   （可省，省略即整个文件的该规则全部豁免）。match 本身不要写成会被扫到的完整形态（如完整路径、完整地址），取其中一段即可。
// 两类豁免：
//   false-positive（默认）：人工判定「不是问题」，例如测试里构造的样例路径、通用写法被当成派生代码。
//   pending：真问题，但修复归别的工作包，先登记再修——必须写 owner、expires 与 ref（跨包请求记在哪里）；
//            到期自动失效并报 error；--strict 时一律不豁免，用来看真实欠账。
// 接口：loadAllowlist(file) → { entries, problems }；applyAllowlist(findings, list, now, { strict }) → { kept, suppressed, unused, expired }
// 一条都没匹配上的条目报 warn（该删了）。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import fs from 'node:fs';
import { globToRegExp } from './reuse.mjs';

export const KINDS = ['false-positive', 'pending'];

export function loadAllowlist(file) {
  const problems = [];
  if (!file || !fs.existsSync(file)) return { entries: [], problems, missing: true };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    problems.push({ level: 'error', message: `允许清单不是合法 JSON：${e.message}`, hint: '修好 JSON 语法后重跑' });
    return { entries: [], problems };
  }
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.entries)) {
    problems.push({ level: 'error', message: '允许清单要有 "schemaVersion": 1 与 "entries" 数组', hint: '照 tools/compliance/allowlist.json 的格式写' });
    return { entries: [], problems };
  }
  const entries = [];
  doc.entries.forEach((e, i) => {
    const where = `允许清单第 ${i + 1} 条`;
    const bad = (message, hint) => problems.push({ level: 'error', message: `${where}${e && e.rule ? `（${e.rule} ${e.path}）` : ''}${message}`, hint });
    if (!e || typeof e.rule !== 'string' || typeof e.path !== 'string') return bad('缺 rule 或 path', '每条都要写 rule、path、reason');
    if (typeof e.reason !== 'string' || e.reason.trim().length < 6) return bad('没写理由', '写清楚为什么这不是问题（或为什么暂缓），以及谁判定的');
    const kind = e.kind || 'false-positive';
    if (!KINDS.includes(kind)) return bad(`kind 只能是 ${KINDS.join(' / ')}，现在是 ${e.kind}`, '人工判定不是问题写 false-positive；等别的包修写 pending');
    if (e.expires != null && !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) return bad(' expires 要写成 YYYY-MM-DD', '或者删掉 expires');
    if (kind === 'pending' && (!e.owner || !e.expires || !e.ref)) return bad('是 pending（等别的包修），必须写 owner、expires 与 ref', 'owner 写负责修的工作包，expires 写最晚修好的日期，ref 写跨包请求记在哪里');
    entries.push({ ...e, kind, index: i, re: globToRegExp(e.path), hits: 0 });
  });
  return { entries, problems };
}

export function applyAllowlist(findings, list, now = Date.now(), { strict = false } = {}) {
  const kept = [], suppressed = [];
  const today = new Date(now).toISOString().slice(0, 10);
  const live = list.entries.filter(x => !(x.expires && x.expires < today) && !(strict && x.kind === 'pending'));
  for (const f of findings) {
    const e = live.find(x => x.rule === f.rule && x.re.test(f.file) && (!x.match || (f._text || '').includes(x.match) || (f.message || '').includes(x.match)));
    if (e) { e.hits++; suppressed.push({ ...f, allowlisted: e.index + 1, waiver: e.kind, owner: e.owner || null }); }
    else kept.push(f);
  }
  const unused = live.filter(e => e.hits === 0);
  const expired = list.entries.filter(e => e.expires && e.expires < today);
  return { kept, suppressed, unused, expired };
}
