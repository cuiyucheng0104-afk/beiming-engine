// 北冥引擎 · 渲染器的错误与退出码：在仓库命令约定库（tools/lib/cli.mjs，docs/CLI.md 第 1、4 节）之上加渲染器自己的错误码表。
// 错误码是点分的稳定标识，前缀决定退出码（与 CliError 相同）：usage.* → 2、env.* → 3、contract.* → 4、busy.* → 5、
// timeout.* → 124、signal.sigint / signal.sigterm → 130 / 143，其余（failure.*）→ 1。完整的码表与含义见
// engine/render/README.md「错误码」（repo-check 规则 render.error-codes 核对两边一致）。
//
//   RenderError(code, message, { hint, exitCode, detail, data })   可预期的失败；是 CliError 的子类，命令外壳据此出信封与退出码
//   renderUsage(code, message, hint)                                 usage.<code> 的简写
//   describeError(e) → { code, message, hint, exitCode }            任意异常 → 写进 run.json 与信封的形状（未预期的记为 failure.internal）
//   EXIT / EXIT_MEANING                                              退出码常量（转自 tools/lib/cli.mjs）
//   RENDER_EXIT_CODES                                                渲染命令 --help 里列出的退出码
import { CliError, EXIT, EXIT_MEANING, exitCodeFor } from '../../../tools/lib/cli.mjs';

export { CliError, EXIT, EXIT_MEANING, exitCodeFor };

export class RenderError extends CliError {
  /**
   * @param {string} code 点分标识，例如 failure.render-throw、contract.dur、env.software-gl
   * @param {string} message 中文：出了什么事、在哪
   * @param {{ hint?: string|null, exitCode?: number, detail?: unknown, data?: unknown }} [o]
   */
  constructor(code, message, { hint = null, exitCode, detail, data } = {}) {
    super(code, message, { hint, exitCode, data });
    this.name = 'RenderError';
    if (detail !== undefined) this.detail = detail;
  }
}

export const renderUsage = (code, message, hint = null) => new RenderError(`usage.${code}`, message, { hint });

/** 任意异常 → { code, message, hint, exitCode }（信封与 run.json 用） */
export function describeError(e) {
  if (e instanceof CliError) return { code: e.code, message: e.message, hint: e.hint ?? null, exitCode: e.exitCode };
  const message = String(e?.message ?? e).split('\n')[0];
  return { code: 'failure.internal', message: `内部错误：${message}`, hint: '这是渲染器自身的问题：设 BEIMING_DEBUG=1 重跑看堆栈，带上命令行与日志报告', exitCode: EXIT.FAILURE };
}

/** 渲染命令（still / video / shots / mux）--help 里的退出码表 */
export const RENDER_EXIT_CODES = Object.freeze({
  0: '成功',
  1: '运行失败（页面报错、render 抛错、着色器错误、上下文丢失、缺素材、FFmpeg 出错）',
  2: '用法错误',
  3: '环境不合格（要求 GPU 却落到软件渲染、缺 FFmpeg / 浏览器、磁盘不够）',
  4: '契约不通过（页面约定、帧率 / 帧数、响度）',
  5: '资源忙（输出锁、渲染槽位、共享 GPU）',
  124: '超时（等 READY、单帧、排队）',
  130: '收到 SIGINT，已清理',
  143: '收到 SIGTERM，已清理',
});
