// 北冥仓库 · 出片编排 · 退出码与错误类型（加固计划附录 C1），建在命令约定库 tools/lib/cli.mjs（P02）之上。
// 所有子命令只用这里的码；报错一律抛 FilmError，由 tools/lib/cli.mjs 的 runCli 统一落成 stderr 两行中文 + --json 信封。
//   EXIT.OK 0 成功 · RUN 1 运行失败 · USAGE 2 用法错误 · ENV 3 环境或依赖缺失 · CONTRACT 4 契约/验收/闸门不通过
//   BUSY 5 资源忙（作品锁） · TIMEOUT 124 超时 · SIGINT 130 / SIGTERM 143 收到中断且已清理
//   （RUN、ENV 是本目录沿用的短名，分别等于 tools/lib/cli.mjs 的 FAILURE、ENVIRONMENT）
//   new FilmError(exitCode, code, message, hint?, details?)
//     code    机器可读的短名（如 'gate-blocked'、'qa-failed'）；写进信封时按退出码补上 docs/CLI.md 第 4 节的前缀：
//             2 → usage.*、3 → env.*、4 → contract.*、5 → busy.*、124 → timeout.*、130/143 → signal.*、其余 → failure.*
//     message 一句话说清原因；hint 一句话说清下一步怎么做
import { CliError, EXIT as BASE, EXIT_MEANING } from '../../lib/cli.mjs';

export const EXIT = Object.freeze({ ...BASE, RUN: BASE.FAILURE, ENV: BASE.ENVIRONMENT });
export { EXIT_MEANING };

const PREFIX = { 2: 'usage', 3: 'env', 4: 'contract', 5: 'busy', 124: 'timeout', 130: 'signal', 143: 'signal' };
const KNOWN = /^(usage|env|contract|busy|timeout|signal|failure)\./;

/** 短名 → 带前缀的错误码（已带前缀的原样返回）。 */
export function prefixed(exitCode, code) {
  const c = String(code || 'error');
  if (KNOWN.test(c)) return c;
  if (exitCode === 130) return 'signal.sigint';
  if (exitCode === 143) return 'signal.sigterm';
  return `${PREFIX[exitCode] || 'failure'}.${c}`;
}

export class FilmError extends CliError {
  constructor(exitCode, code, message, hint = null, details = null) {
    super(prefixed(exitCode, code), message, { hint, exitCode });
    this.name = 'FilmError';
    this.short = String(code || 'error');
    this.details = details;
  }
}

export const usage = (message, hint = '加 --help 查看用法') => new FilmError(EXIT.USAGE, 'bad-usage', message, hint);

// 把任意异常归一成 FilmError：已知的原样返回，别的命令库抛的 CliError 保留码与退出码，未知的记为运行失败并保留原始信息
export function asFilmError(e) {
  if (e instanceof FilmError) return e;
  if (e instanceof CliError) {
    const fe = new FilmError(e.exitCode, e.code, e.message, e.hint ?? null, e.data ?? null);
    return fe;
  }
  // P10 的环境库（tools/env/lib/cli.mjs）抛的错误：{ exitCode, code, message, hint }
  if (e && Number.isInteger(e.exitCode) && typeof e.message === 'string' && e.exitCode !== 0) {
    return new FilmError(e.exitCode, e.code || 'error', e.message.split('\n')[0], e.hint ?? null, { checks: e.checks ?? null });
  }
  const msg = e?.message ? String(e.message).split('\n')[0] : String(e);
  return new FilmError(EXIT.RUN, 'internal', `内部错误：${msg}`, '这是编排器自身的问题；设 BEIMING_DEBUG=1 重跑可看到堆栈，把完整命令与 stderr 一起报给维护者', { stack: e?.stack || null });
}
