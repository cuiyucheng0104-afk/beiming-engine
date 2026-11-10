// 北冥仓库 · 把合规扫描接成仓库规范检查（repo-check）的 comp 规则。
// 规则约定（P02 的执行器）：每个规则文件导出 { id, title, run(ctx) → [{ level: 'error'|'warn', file, line?, message, hint }] }。
// 本模块给 tools/repo-check/rules/comp/*.mjs 共用：同一进程里只扫一次仓库，各条规则从同一份结果里取自己的发现。
// 接口：
//   compRule(ruleId) → { id, title, hint, run(ctx) }
//   toRepoCheck(findings, ruleId) → repo-check 的发现列表（归档区按案例目录合并成一条提示，避免一次刷几百行）
// ctx 只用到 ctx.root（缺省为本仓库根）；ctx.staged 为真时只看 git 暂存区（与 scan.mjs --staged 相同）；
// ctx.strict 为真时 pending 类豁免不生效。其余字段忽略，所以执行器怎么扩展 ctx 都不影响这里。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import path from 'node:path';
import { RULES, REPO_ROOT, DEFAULT_ALLOWLIST, scanRepository } from './scan.mjs';

const short = id => id.replace(/^comp\./, '');

export function toRepoCheck(findings, ruleId) {
  const out = [];
  const archive = new Map();     // 案例目录 → { n, sample }
  for (const f of findings) {
    if (f.rule !== ruleId) continue;
    if (f.zone === 'archive') {
      const dir = f.file.split('/').slice(0, 3).join('/');
      const a = archive.get(dir) || { n: 0, sample: f };
      a.n++; archive.set(dir, a);
      continue;
    }
    out.push({ level: f.level === 'error' ? 'error' : 'warn', file: f.file, ...(f.line ? { line: f.line } : {}), message: f.message, hint: f.hint });
  }
  for (const [dir, a] of [...archive].sort((x, y) => y[1].n - x[1].n || x[0].localeCompare(y[0]))) {
    out.push({ level: 'warn', file: dir,
      message: `历史归档区有 ${a.n} 处：${a.sample.message}${a.n > 1 ? ' 等' : ''}（归档区只报告、不阻塞）`,
      hint: `逐条清单：node tools/compliance/scan.mjs --only ${short(ruleId)} --scope archive；清理由案例库属主执行，做法见 docs/rights/README.md` });
  }
  return out;
}

export function compRule(ruleId) {
  const meta = RULES.find(r => r.id === ruleId);
  if (!meta) throw new Error(`没有这条合规规则：${ruleId}`);
  return {
    id: meta.id,
    title: meta.title,
    hint: meta.hint,
    run(ctx = {}) {
      const root = path.resolve(ctx.root || ctx.repoRoot || REPO_ROOT);
      const res = scanRepository({ root, staged: !!ctx.staged, strict: !!ctx.strict, allowlistPath: DEFAULT_ALLOWLIST });
      return toRepoCheck(res.findings, ruleId);
    },
  };
}
