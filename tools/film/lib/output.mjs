// 北冥仓库 · 出片编排 · 结果输出（附录 C2）：
//   --json 时 stdout 只输出一个对象 { ok, exitCode, command, error: {code,message,hint}|null, outputs: [{path,sha256,kind}], runJson, warnings[], …data }
//   否则 stdout 只打印一段给人看的结论；过程日志一律走 stderr
//   emit(result, { json }) → 退出码
import { EXIT_MEANING } from './exit.mjs';

export function envelope({ command, exitCode = 0, error = null, outputs = [], runJson = null, warnings = [], data = {} }) {
  return {
    ok: exitCode === 0, exitCode, command,
    error: error ? { code: error.code || 'error', message: error.message, hint: error.hint || null } : null,
    outputs, runJson, warnings, ...data,
  };
}

export function emit(env, { json = false, human = null } = {}) {
  if (json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    if (env.error) {
      process.stderr.write(`\n✗ ${env.error.message}\n`);
      if (env.error.hint) process.stderr.write(`  下一步：${env.error.hint}\n`);
      process.stderr.write(`  退出码 ${env.exitCode}（${EXIT_MEANING[env.exitCode] || '?'}）\n`);
    }
    if (human) process.stdout.write(human.endsWith('\n') ? human : human + '\n');
  }
  return env.exitCode;
}
