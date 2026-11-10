#!/usr/bin/env node
// 北冥仓库 · 规范检查 · agent 执行层规则的单独入口（只读，不改任何文件）
// 用法：node tools/repo-check/rules/agent/run.mjs [--json] [--only <规则 id,…>] [--root <仓库根>] [--list] [--help]
// 规则执行器 tools/repo-check.mjs 支持插件后，等价于 node tools/repo-check.mjs --only agent。
// 退出码：0 全部通过；4 有规则不通过；2 用法错误；3 仓库根不存在；1 检查自身出错。
// --json：stdout 只输出一个对象 { ok, exitCode, command, error, outputs: [], runJson: null, warnings, findings }。
import fs from 'node:fs';
import path from 'node:path';
import { rules, runAgentRules, DEFAULT_ROOT } from './index.mjs';

const HELP = `北冥仓库 · agent 执行层规范检查（只读）

用法：node tools/repo-check/rules/agent/run.mjs [选项]
  --json            stdout 输出一个 JSON 对象（ok、exitCode、command、error、outputs、runJson、warnings、findings）
  --only <id,…>     只跑这些规则，例如 --only agent.instruction-files,agent.vendor-films
  --root <目录>     要检查的仓库根（默认是本文件所在的仓库）
  --list            列出规则后退出
  --help            显示本说明

退出码：0 通过；4 有规则不通过；2 用法错误；3 仓库根不存在；1 检查自身出错

规则：
${rules.map(r => `  ${r.id.padEnd(26)} ${r.title}`).join('\n')}
`;

const COMMAND = 'node tools/repo-check/rules/agent/run.mjs';

function finish({ json, code, findings = [], error = null, warnings = [] }) {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: code === 0, exitCode: code, command: COMMAND, error, outputs: [], runJson: null, warnings, findings }) + '\n');
  }
  process.exit(code);
}

function main(argv) {
  const json = argv.includes('--json');
  const o = { only: null, root: DEFAULT_ROOT, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') continue;
    if (a === '--help' || a === '-h') { process.stdout.write(HELP); process.exit(0); }
    if (a === '--list') { o.list = true; continue; }
    if (a === '--only' || a === '--root') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        process.stderr.write(`用法错误：${a} 后面要跟一个值\n`);
        return finish({ json, code: 2, error: { code: 'usage', message: `${a} 后面要跟一个值`, hint: `运行 ${COMMAND} --help` } });
      }
      if (a === '--only') o.only = v.split(',').map(s => s.trim()).filter(Boolean);
      else o.root = path.resolve(v);
      continue;
    }
    process.stderr.write(`用法错误：不认识的参数 ${a}\n运行 ${COMMAND} --help 看用法\n`);
    return finish({ json, code: 2, error: { code: 'usage', message: `不认识的参数 ${a}`, hint: `运行 ${COMMAND} --help` } });
  }
  if (o.list) {
    if (json) process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, command: COMMAND, error: null, outputs: [], runJson: null, warnings: [], rules: rules.map(r => ({ id: r.id, title: r.title })) }) + '\n');
    else process.stdout.write(rules.map(r => `${r.id}\t${r.title}`).join('\n') + '\n');
    process.exit(0);
  }
  if (o.only) {
    const unknown = o.only.filter(id => !rules.some(r => r.id === id));
    if (unknown.length) {
      const msg = `没有这些规则：${unknown.join('、')}；可选：${rules.map(r => r.id).join('、')}`;
      process.stderr.write(`用法错误：${msg}\n`);
      return finish({ json, code: 2, error: { code: 'usage', message: msg, hint: `运行 ${COMMAND} --list` } });
    }
  }
  if (!fs.existsSync(o.root) || !fs.statSync(o.root).isDirectory()) {
    const msg = `仓库根不存在：${o.root}`;
    process.stderr.write(`${msg}\n`);
    return finish({ json, code: 3, error: { code: 'root-missing', message: msg, hint: '用 --root 指向仓库根目录' } });
  }
  const findings = runAgentRules({ root: o.root }, { only: o.only });
  const errors = findings.filter(f => f.level === 'error');
  const warns = findings.filter(f => f.level !== 'error');
  const log = json ? s => process.stderr.write(s + '\n') : s => process.stdout.write(s + '\n');
  const ran = o.only ?? rules.map(r => r.id);
  for (const id of ran) {
    const mine = findings.filter(f => f.rule === id);
    if (!mine.length) log(`通过  ${id}`);
    for (const f of mine) log(`${f.level === 'error' ? '错误' : '提示'}  ${id}  ${f.message}`);
  }
  log(`agent 规则：${ran.length} 条，${errors.length} 个错误，${warns.length} 个提示`);
  finish({
    json,
    code: errors.length ? 4 : 0,
    findings,
    warnings: warns.map(w => w.message),
    error: errors.length ? { code: 'rule-failed', message: `${errors.length} 个错误`, hint: '按每条错误后面的说明修改，再运行本命令' } : null,
  });
}

try { main(process.argv.slice(2)); } catch (e) {
  process.stderr.write(`检查自身出错：${e?.stack ?? e}\n`);
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, exitCode: 1, command: COMMAND, error: { code: 'internal', message: String(e?.message ?? e), hint: '把完整报错交给维护者' }, outputs: [], runJson: null, warnings: [], findings: [] }) + '\n');
  process.exit(1);
}
