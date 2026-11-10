// 北冥仓库 · 规范检查 · 报告：限期豁免、汇总、给人看的文字。
// 限期豁免（tools/repo-check/core/waivers.json，在被检查的仓库里）：只给「属主还没轮到改」的存量问题用。
//   { "rule": "core.terms", "file": "AGENTS.md", "match": "两条路线", "owner": "PZ", "reason": "…" }
//   命中（同规则、同文件、消息或摘录里含 match）的 error 降为 warn 并标出属主；--strict 时不降。
//   条目不再命中任何问题时报 warn，提醒删掉——豁免只会越来越少。
import fs from 'node:fs';
import path from 'node:path';

export const WAIVERS_PATH = 'tools/repo-check/core/waivers.json';
const LEVELS = ['error', 'warn', 'info'];

export function loadWaivers(root) {
  const file = path.join(root, ...WAIVERS_PATH.split('/'));
  if (!fs.existsSync(file)) return { waivers: [], problems: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { waivers: [], problems: [{ level: 'error', file: WAIVERS_PATH, message: `豁免表不是合法 JSON（${e.message}）`, hint: '修好或删掉这个文件' }] };
  }
  const list = Array.isArray(raw?.waivers) ? raw.waivers : null;
  if (!list) return { waivers: [], problems: [{ level: 'error', file: WAIVERS_PATH, message: '豁免表要写成 { "waivers": [ … ] }' }] };
  const waivers = [], problems = [];
  list.forEach((w, i) => {
    const ok = w && ['rule', 'file', 'owner', 'reason'].every(k => typeof w[k] === 'string' && w[k].trim()) && (w.match === undefined || (typeof w.match === 'string' && w.match));
    if (ok) waivers.push({ ...w, index: i, used: 0 });
    else problems.push({ level: 'error', file: WAIVERS_PATH, message: `第 ${i + 1} 条豁免缺字段：要有 rule、file、owner、reason（match 可选）`, hint: '豁免必须写清属主与原因' });
  });
  return { waivers, problems };
}

/** 把豁免套到问题上；返回新的问题列表与没用上的豁免。ranRules 是这次实际跑了的规则 id。 */
export function applyWaivers(findings, waivers, { strict = false, ranRules, reportStale = true } = {}) {
  const out = findings.map(f => {
    const text = `${f.message}\n${f.excerpt ?? ''}`;
    const w = waivers.find(x => x.rule === f.rule && x.file === f.file && (!x.match || text.includes(x.match)));
    if (!w) return f;
    w.used++;
    if (strict || f.level !== 'error') return f;
    return { ...f, level: 'warn', waived: { owner: w.owner, reason: w.reason } };
  });
  if (reportStale) {
    for (const w of waivers) {
      if (w.used || !ranRules.has(w.rule)) continue;
      out.push({
        rule: 'core.waivers', level: 'warn', file: WAIVERS_PATH,
        message: `豁免不再命中：${w.rule} · ${w.file}${w.match ? ` ·「${w.match}」` : ''}（属主 ${w.owner}）`,
        hint: '问题已经修好：删掉这一条豁免',
      });
    }
  }
  return out;
}

export function summarize(rules, findings) {
  const by = new Map(rules.map(r => [r.id, { id: r.id, title: r.title, errors: 0, warnings: 0, infos: 0 }]));
  for (const f of findings) {
    if (!by.has(f.rule)) by.set(f.rule, { id: f.rule, title: f.rule === 'core.waivers' ? '限期豁免表' : f.rule, errors: 0, warnings: 0, infos: 0 });
    const s = by.get(f.rule);
    if (f.level === 'error') s.errors++; else if (f.level === 'warn') s.warnings++; else s.infos++;
  }
  const list = [...by.values()].map(s => ({ ...s, status: s.errors ? 'fail' : s.warnings ? 'warn' : 'pass' }));
  return {
    errors: findings.filter(f => f.level === 'error').length,
    warnings: findings.filter(f => f.level === 'warn').length,
    infos: findings.filter(f => f.level === 'info').length,
    waived: findings.filter(f => f.waived).length,
    rules: list,
  };
}

export function normalizeFinding(rule, f) {
  const level = LEVELS.includes(f?.level) ? f.level : 'error';
  const out = { rule, level, file: f?.file ?? null, line: Number.isInteger(f?.line) ? f.line : null, message: String(f?.message ?? '（规则没有给出说明）'), hint: f?.hint ?? null };
  if (f?.excerpt) out.excerpt = String(f.excerpt).slice(0, 200);
  return out;
}

const MARK = { fail: '✗', warn: '!', pass: '✓' };
const FMARK = { error: '✗', warn: '!', info: '·' };

export function formatHuman({ summary, findings, header }) {
  const lines = [header, ''];
  const width = Math.max(...summary.rules.map(r => r.id.length), 10) + 2;
  for (const r of summary.rules) {
    lines.push(`${MARK[r.status]} ${r.id.padEnd(width)}${r.title}`);
    for (const f of findings.filter(x => x.rule === r.id)) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}  ` : '';
      const tag = f.waived ? `[豁免·${f.waived.owner}] ` : '';
      lines.push(`    ${FMARK[f.level]} ${tag}${where}${f.message}`);
      if (f.hint && f.level !== 'info') lines.push(`      提示：${f.hint}`);
    }
  }
  const { errors, warnings, waived } = summary;
  lines.push('');
  const tail = [];
  if (warnings) tail.push(`${warnings} 个提示${waived ? `（其中 ${waived} 个是限期豁免，见 ${WAIVERS_PATH}；--strict 不豁免）` : ''}`);
  lines.push(errors ? `结果：✗ ${errors} 个错误${tail.length ? `，${tail.join('')}` : ''}` : `结果：✓ 全部通过${tail.length ? `，${tail.join('')}` : ''}`);
  return lines.join('\n');
}
