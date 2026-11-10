#!/usr/bin/env node
// 北冥仓库 · 合规扫描（只读，不改任何文件、不联网）。给 agent、pre-commit 与 CI 用。
//   node tools/compliance/scan.mjs                         扫全部已跟踪文件，人读报告
//   node tools/compliance/scan.mjs --json                  附录 C2 信封，stdout 只有一个 JSON 对象
//   node tools/compliance/scan.mjs --staged                只扫暂存区里新增或改动的文件（pre-commit 用）
//   node tools/compliance/scan.mjs --only secrets,local-paths --scope archive
// 规则：密钥与令牌、敏感文件名、本机路径、内网地址、带签名的链接、个人邮箱（含提交历史）、FSL 文本误入 MIT 目录、
//       派生代码缺来源头、REUSE 许可覆盖、根 LICENSE、授权登记册。--list-rules 列出全部。
// 区域：仓库主体（tree）按规则阻断；cases/source（历史归档）与 cases/vendor（第三方快照）只报告不阻塞。
// 退出码（附录 C1）：0 没有阻断级发现；4 有阻断级发现；2 用法错误；3 环境问题（不是目录、读不到 git 暂存区）；1 工具自身出错。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import path from 'node:path';
import { EXIT, parseCli, runMain, wantsHelp, UsageError } from './lib/cli.mjs';
import { RULES, REPO_ROOT, DEFAULT_ALLOWLIST, resolveRuleIds, scanRepository } from './lib/scan.mjs';

const HELP = `北冥仓库 · 合规扫描（只读）
用法：node tools/compliance/scan.mjs [选项]
  --json               输出附录 C2 的 JSON 信封（发现列表在 result.findings）
  --only <规则,…>      只跑这些规则（可省略 comp. 前缀），如 --only secrets,signed-urls
  --scope <区域>       报告里显示哪些区域：tree（仓库主体）| archive（cases/source、cases/vendor）| all（默认）
  --staged             只扫 git 暂存区里新增或改动的文件（读暂存区内容，不读工作区）
  --root <目录>        仓库根目录（默认为本工具所在仓库）
  --allowlist <文件>   允许清单（默认 ${DEFAULT_ALLOWLIST}；写 none 不用允许清单）
  --strict             pending 类豁免（等别的工作包修的真问题）不生效，看真实欠账
  --limit <n>          人读报告里每条规则最多列几处（默认 12；--json 不受影响）
  --list-rules         列出全部规则后退出
  -h, --help           显示本帮助
退出码：0 无阻断；4 有阻断级发现；2 用法错误；3 环境问题；1 工具自身出错。
归档区（历史案例与第三方快照）的发现只报告、不阻塞；清理由案例库属主执行。`;

const argv = process.argv.slice(2);
const json = argv.includes('--json');

function listRules() {
  return RULES.map(r => `${r.id.padEnd(22)} ${r.title}`).join('\n');
}

function human(res, { scope, limit, ms }) {
  const L = [];
  const st = res.stats;
  L.push(`合规扫描 · ${st.files} 个文件（${st.source === 'git' ? 'git 已跟踪' : st.source === 'git-index' ? '暂存区' : '目录遍历'}，文本 ${st.textFiles}、二进制 ${st.binaryFiles}${st.skipped ? `、跳过 ${st.skipped}` : ''}）· 用时 ${(ms / 1000).toFixed(1)}s`);
  const show = f => scope === 'all' || (scope === 'archive' ? f.zone === 'archive' : f.zone !== 'archive');
  const groups = new Map();
  for (const f of res.findings.filter(show)) {
    const k = `${f.zone === 'archive' ? 'archive' : f.blocking ? 'block' : 'warn'}|${f.rule}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const order = ['block', 'warn', 'archive'];
  const title = id => (RULES.find(r => r.id === id) || { title: '允许清单' }).title;
  for (const kind of order) {
    const ks = [...groups.keys()].filter(k => k.startsWith(kind + '|')).sort();
    if (!ks.length) continue;
    L.push('');
    L.push(kind === 'block' ? '■ 阻断（必须处理）' : kind === 'warn' ? '■ 提示（不阻断，需要人看）' : '■ 归档区（cases/source、cases/vendor：只报告不阻塞）');
    for (const k of ks) {
      const fs_ = groups.get(k);
      const rule = k.split('|')[1];
      L.push(`  ${rule} ${title(rule)} — ${fs_.length} 处`);
      if (kind === 'archive') {
        const byCase = new Map();
        for (const f of fs_) { const c = f.file.split('/').slice(0, 3).join('/'); byCase.set(c, (byCase.get(c) || 0) + 1); }
        const top = [...byCase].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} ${n}`).join('、');
        L.push(`    分布：${top}${byCase.size > 6 ? ` 等 ${byCase.size} 处目录` : ''}`);
        if (scope !== 'archive') { L.push(`    逐条清单：node tools/compliance/scan.mjs --only ${rule.slice(5)} --scope archive`); continue; }
      }
      for (const f of fs_.slice(0, limit)) L.push(`    ${f.file}${f.line ? `:${f.line}` : ''}  ${f.message}`);
      if (fs_.length > limit) L.push(`    …另有 ${fs_.length - limit} 处（--limit 调大，或用 --json）`);
      L.push(`    下一步：${fs_[0].hint}`);
    }
  }
  const blocking = res.findings.filter(f => f.blocking).length;
  const warns = res.findings.filter(f => !f.blocking && f.zone !== 'archive').length;
  const archived = res.findings.filter(f => f.zone === 'archive').length;
  L.push('');
  const w = res.waivers || { falsePositive: res.suppressed.length, pending: 0, pendingEntries: [] };
  if (w.falsePositive) L.push(`允许清单：人工判定的误报 ${w.falsePositive} 处（理由见 ${DEFAULT_ALLOWLIST}）。`);
  if (w.pending) {
    const owners = [...new Set(w.pendingEntries.filter(e => e.hits).map(e => `${e.owner}（${e.expires} 前）`))].join('、');
    L.push(`允许清单：等别的工作包修的真问题 ${w.pending} 处，暂不阻断——${owners}；加 --strict 查看。`);
  } else if (w.strict && w.pendingEntries.length) L.push(`--strict：${w.pendingEntries.length} 条 pending 豁免未生效，上面按真实状态报告。`);
  L.push(blocking ? `结论：${blocking} 处阻断、${warns} 处提示、归档区 ${archived} 处 → 退出码 4` : `结论：没有阻断级发现（提示 ${warns} 处、归档区 ${archived} 处）→ 退出码 0`);
  return L.join('\n');
}

await runMain('compliance.scan', async () => {
  if (wantsHelp(argv)) return { exitCode: EXIT.OK, text: HELP, result: { help: HELP } };
  const { values } = parseCli(argv, {
    options: { json: { type: 'boolean' }, only: { type: 'string', multiple: true }, scope: { type: 'string' }, staged: { type: 'boolean' },
      root: { type: 'string' }, allowlist: { type: 'string' }, limit: { type: 'string' }, 'list-rules': { type: 'boolean' }, strict: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' } },
    allowPositionals: false,
  });
  if (values['list-rules']) return { exitCode: EXIT.OK, text: listRules(), result: { rules: RULES.map(({ id, title, kind }) => ({ id, title, kind })) } };
  const scope = values.scope || 'all';
  if (!['tree', 'archive', 'all'].includes(scope)) throw new UsageError(`--scope 只能是 tree / archive / all，收到 ${scope}`);
  const limit = values.limit == null ? 12 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit 要写正整数，收到 ${values.limit}`);
  const only = resolveRuleIds(values.only);
  const root = values.root ? path.resolve(values.root) : REPO_ROOT;
  const allowlistPath = values.allowlist === 'none' ? null : (values.allowlist || DEFAULT_ALLOWLIST);
  const t0 = Date.now();
  const res = scanRepository({ root, staged: !!values.staged, only, allowlistPath, strict: !!values.strict });
  const ms = Date.now() - t0;
  const blocking = res.findings.filter(f => f.blocking);
  const counts = {};
  for (const f of res.findings) {
    const c = counts[f.rule] || (counts[f.rule] = { error: 0, warn: 0, archive: 0 });
    if (f.zone === 'archive') c.archive++; else c[f.level]++;
  }
  const show = f => scope === 'all' || (scope === 'archive' ? f.zone === 'archive' : f.zone !== 'archive');
  return {
    exitCode: blocking.length ? EXIT.CONTRACT : EXIT.OK,
    error: blocking.length ? { code: 'compliance', message: `${blocking.length} 处阻断级合规问题`, hint: blocking[0].hint } : null,
    warnings: res.findings.filter(f => !f.blocking && f.zone !== 'archive').map(f => `${f.rule} ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}`),
    result: { root: path.relative(process.cwd(), res.root) || '.', scope, staged: !!values.staged, durationMs: ms, stats: res.stats, counts,
      findings: res.findings.filter(show), suppressed: res.suppressed.length, waivers: res.waivers },
    text: human(res, { scope, limit, ms }),
  };
}, { json });
