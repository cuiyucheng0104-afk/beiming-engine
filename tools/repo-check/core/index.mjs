// 北冥仓库 · 规范检查 · 执行器：加载 tools/repo-check/rules/<域>/ 下的全部规则，在被检查的仓库上逐条运行，
// 套用限期豁免，输出报告。只读：不改任何文件、不渲染、不联网。
// 退出码：0 没有错误（可以有提示）；4 有规范错误；2 用法错误；1 有规则自身出错（结果不完整）。
// 写规则见 tools/repo-check/core/README.md；命令约定见 docs/CLI.md。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, suggest } from '../../lib/cli.mjs';
import { createContext } from './context.mjs';
import { loadRules } from './loader.mjs';
import { WAIVERS_PATH, applyWaivers, formatHuman, loadWaivers, normalizeFinding, summarize } from './report.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RULES_DIR = path.join(TOOL_ROOT, 'tools', 'repo-check', 'rules');
const RULE_TIMEOUT_MS = 120_000;

async function runRule(rule, ctx) {
  let timer;
  try {
    const res = await Promise.race([
      Promise.resolve().then(() => rule.run(ctx)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`超过 ${RULE_TIMEOUT_MS / 1000} 秒没有返回`)), RULE_TIMEOUT_MS); }),
    ]);
    if (res !== undefined && !Array.isArray(res)) throw new Error('run(ctx) 要返回数组');
    return (res ?? []).map(f => normalizeFinding(rule.id, f));
  } catch (e) {
    return [{ ...normalizeFinding(rule.id, { level: 'error', file: rule.file, message: `规则自身出错：${e?.message ?? e}`, hint: `这是规则的问题，不是仓库的：把这行报告给 ${rule.file} 的属主` }), internal: true }];
  } finally { clearTimeout(timer); }
}

async function run(ctx) {
  const { opts } = ctx;
  const root = opts.root ? path.resolve(opts.root) : TOOL_ROOT;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new CliError('usage.bad-root', `--root ${opts.root} 不是目录`, '给出一个仓库检出的目录');

  const { rules, problems, domains: ruleDirs } = await loadRules(RULES_DIR);
  if (opts.list) {
    ctx.out(rules.map(r => `${r.id.padEnd(26)}${r.title}`).join('\n'));
    return { data: { rules: rules.map(r => ({ id: r.id, title: r.title, domain: r.domain, file: r.file })) } };
  }
  let selected = rules;
  let loadProblems = problems;
  if (opts.only.length) {
    // 规则文件没加载上的域（目录在）也认：选中它时要把加载问题报出来，而不是说「没有这个域」
    const domains = new Set([...ruleDirs, ...rules.map(r => r.domain)]);
    for (const t of opts.only) {
      if (!domains.has(t) && !rules.some(r => r.id === t)) {
        const s = suggest(t, [...domains, ...rules.map(r => r.id)]);
        throw new CliError('usage.unknown-rule', `--only ${t}：没有这个域或规则`, `${s ? `是不是想写 ${s}？` : ''}现有的域：${[...domains].join('、')}；全部规则见 --list`);
      }
    }
    selected = rules.filter(r => opts.only.includes(r.domain) || opts.only.includes(r.id));
    // 加载问题只报选中的域（选单条规则时算它所在的域）：别的包正在改的规则文件坏了，不该让 --only core 跟着失败；全量检查照常全报
    const chosen = new Set(opts.only.map(t => (domains.has(t) ? t : t.split('.')[0])));
    loadProblems = problems.filter(p => !p.domain || chosen.has(p.domain));
  }
  let staged = null;
  if (opts.staged) {
    const g = createContext({ root }).git(['diff', '--cached', '--name-only', '-z']);
    if (!g.ok) throw new CliError('env.git', '--staged 需要在 git 检出里运行，且能执行 git', '不用 --staged，或在仓库根目录里运行');
    staged = new Set(g.stdout.split('\0').filter(Boolean));
  }
  const rctx = createContext({ root, staged, strict: !!opts.strict });
  let findings = loadProblems.map(p => ({ ...normalizeFinding('core.loader', { level: 'error', file: p.file, message: p.message, hint: '修好或删掉这个规则文件' }), internal: true }));
  for (const rule of selected) {
    ctx.log.info(`检查 ${rule.id}`);
    findings.push(...await runRule(rule, rctx));
  }
  const { waivers, problems: wp } = loadWaivers(root);
  findings.push(...wp.map(p => normalizeFinding('core.waivers', p)));
  findings = applyWaivers(findings, waivers, { strict: opts.strict, ranRules: new Set(selected.map(r => r.id)), reportStale: !staged });
  const ruleList = [...(loadProblems.length ? [{ id: 'core.loader', title: '规则文件加载' }] : []), ...selected];
  if (findings.some(f => f.rule === 'core.waivers')) ruleList.push({ id: 'core.waivers', title: '限期豁免表' });
  const summary = summarize(ruleList, findings);
  const domains = [...new Set(selected.map(r => r.domain))];
  const header = `北冥仓库规范检查：${selected.length} 条规则（${domains.map(d => `${d} ${selected.filter(r => r.domain === d).length}`).join('、')}）${opts.root ? `，根目录 ${opts.root}` : ''}${opts.strict ? '，--strict' : ''}${staged ? `，只看暂存区 ${staged.size} 个文件` : ''}`;
  ctx.out(formatHuman({ summary, findings, header }));
  const data = {
    root: opts.root ?? '.', strict: !!opts.strict, staged: !!staged, only: opts.only,
    summary: { errors: summary.errors, warnings: summary.warnings, infos: summary.infos, waived: summary.waived },
    rules: summary.rules,
    findings: findings.map(({ internal, ...f }) => f),
  };
  const internal = findings.filter(f => f.internal && f.level === 'error');
  if (internal.length) {
    return { data, error: { code: 'failure.rule-crash', message: `${internal.length} 条规则自身出错，检查结果不完整`, hint: '见报告里「规则自身出错」的条目，报告给对应规则文件的属主' } };
  }
  if (summary.errors) {
    return { data, error: { code: 'contract.repo-check', message: `仓库规范检查有 ${summary.errors} 个错误`, hint: `按每条的「提示」修；属主还没轮到改的存量问题记在 ${WAIVERS_PATH}` } };
  }
  return { data };
}

export const command = defineCommand({
  name: 'repo-check',
  summary: '仓库规范检查（只读）：路线注册表、手册、模版、链接、命名与署名、作品目录、入口预算与可达性、vendor 快照',
  usage: ['node tools/repo-check.mjs [--only 域或规则] [--json] [--strict] [--staged] [--list] [--root 目录]', 'npm run check:repo -- [选项]'],
  description: [
    '规则按域放在 tools/repo-check/rules/<域>/（core 由治理骨架维护，其他域由各工作包维护）；写规则见 tools/repo-check/core/README.md。',
    `属主还没轮到改的存量问题记在 ${WAIVERS_PATH}：命中的错误降为提示并标出属主，--strict 时不降。`,
  ],
  options: {
    only: { type: 'list', split: ',', arg: '<域或规则>', describe: '只跑这些域或规则，逗号分隔（如 core、comp、core.links）', example: 'core' },
    list: { type: 'boolean', describe: '列出全部规则后退出，不检查' },
    strict: { type: 'boolean', describe: '不套用限期豁免（发布前用）' },
    staged: { type: 'boolean', describe: '逐文件的规则只看 git 暂存区涉及的文件（读工作区内容）；全仓规则照常跑' },
    root: { type: 'string', arg: '<目录>', describe: '检查另一个检出（默认本仓库）', example: '../other-checkout' },
  },
  examples: ['npm run check:repo', 'node tools/repo-check.mjs --only core --json', 'node tools/repo-check.mjs --list', 'node tools/repo-check.mjs --strict'],
  exitCodes: { 0: '没有错误（可以有提示）', 1: '有规则自身出错，结果不完整', 2: '用法错误', 3: '--staged 时没有 git', 4: '有规范错误' },
  run,
});
