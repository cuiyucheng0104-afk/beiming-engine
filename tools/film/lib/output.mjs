// 北冥仓库 · 出片编排 · 结果输出（附录 C2，信封本身由命令约定库 tools/lib/cli.mjs 生成）：
//   子命令返回 { env: envelope({...}), human }：env 交给 tools/film/cli.mjs 的适配层，由 runCli 写成
//     { schemaVersion: 1, ok, exitCode, command, error: {code,message,hint}|null, outputs: [{path,sha256,kind}], runJson, warnings[], data }
//   human 是给人看的结论（普通模式打到 stdout；--json 时不打）；过程日志一律走 stderr
//   emit(env, { json })：不经 runCli 的路径（收到中断信号时）直接输出同一格式的信封
import { envelope as cliEnvelope } from '../../lib/cli.mjs';
import { EXIT_MEANING } from './exit.mjs';

const errOf = e => (e ? { code: e.code || 'failure.error', message: String(e.message ?? e), hint: e.hint || null } : null);

export function envelope({ command, exitCode = 0, error = null, outputs = [], runJson = null, warnings = [], data = null }) {
  return { command, exitCode, error: errOf(error), outputs, runJson, warnings, data };
}

export function emit(env, { json = false } = {}) {
  const full = cliEnvelope({ ...env, error: errOf(env.error) });
  if (json) {
    try { process.stdout.write(JSON.stringify(full, null, 2) + '\n'); } catch { /* stdout 已关 */ }
  } else if (full.error) {
    process.stderr.write(`错误[${full.error.code}]：${full.error.message}\n`);
    if (full.error.hint) process.stderr.write(`提示：${full.error.hint}\n`);
    process.stderr.write(`退出码 ${full.exitCode}（${EXIT_MEANING[full.exitCode] || '?'}）\n`);
  }
  return full.exitCode;
}
