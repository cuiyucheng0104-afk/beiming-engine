// 北冥仓库 · 合规扫描的允许清单：人工判定为「不是问题」的发现，按 规则 + 路径 + 命中文字 精确豁免，每条必须写理由。
// 文件：tools/compliance/allowlist.json（--allowlist 可换）。格式：
//   { "schemaVersion": 1, "entries": [ { "rule": "comp.local-paths", "path": "tools/x.py", "match": "/Users/someone/x",
//       "reason": "这是路径检查器自己的测试样例", "owner": "P02", "added": "2026-11-10", "expires": "2027-01-31"? } ] }
//   path 用与 REUSE.toml 相同的通配写法（* 不跨目录，** 跨目录）；match 是命中文字里必须出现的子串（可省，省略即整文件该规则全豁免）。
// 接口：loadAllowlist(file) → { entries, problems }；applyAllowlist(findings, list, now) → { kept, suppressed, unused }
// 过期的条目自动失效并报 error；一条都没匹配上的条目报 warn（该删了）。
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import { globToRegExp } from './reuse.mjs';

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
    if (!e || typeof e.rule !== 'string' || typeof e.path !== 'string') { problems.push({ level: 'error', message: `${where}缺 rule 或 path`, hint: '每条都要写 rule、path、reason' }); return; }
    if (typeof e.reason !== 'string' || e.reason.trim().length < 6) { problems.push({ level: 'error', message: `${where}（${e.rule} ${e.path}）没写理由`, hint: '写清楚为什么这不是问题，以及谁判定的' }); return; }
    if (e.expires != null && !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) { problems.push({ level: 'error', message: `${where} expires 要写成 YYYY-MM-DD`, hint: '或者删掉 expires' }); return; }
    entries.push({ ...e, index: i, re: globToRegExp(e.path), hits: 0 });
  });
  return { entries, problems };
}

export function applyAllowlist(findings, list, now = Date.now()) {
  const kept = [], suppressed = [];
  const today = new Date(now).toISOString().slice(0, 10);
  for (const f of findings) {
    const e = list.entries.find(x => x.rule === f.rule && x.re.test(f.file) && (!x.match || (f._text || '').includes(x.match) || (f.message || '').includes(x.match)));
    if (e && !(e.expires && e.expires < today)) { e.hits++; suppressed.push({ ...f, allowlisted: e.index + 1 }); }
    else kept.push(f);
  }
  const unused = list.entries.filter(e => e.hits === 0 && !(e.expires && e.expires < today));
  const expired = list.entries.filter(e => e.expires && e.expires < today);
  return { kept, suppressed, unused, expired };
}
