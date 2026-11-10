// 北冥仓库 · 出片编排 · 退出码与错误类型（加固计划附录 C1）。
// 所有子命令只用这里的码；报错一律抛 FilmError，由 cli.mjs 统一落成 stderr 一行中文 + --json 信封。
//   EXIT.OK 0 成功 · RUN 1 运行失败 · USAGE 2 用法错误 · ENV 3 环境或依赖缺失 · CONTRACT 4 契约/验收/闸门不通过
//   BUSY 5 资源忙（作品锁） · TIMEOUT 124 超时 · SIGINT 130 / SIGTERM 143 收到中断且已清理
//   new FilmError(exitCode, code, message, hint?, details?)
//     code    机器可读的短名（如 'gate-blocked'、'qa-failed'），写进信封 error.code
//     message 一句话说清原因；hint 一句话说清下一步怎么做
// P02 的 tools/lib/cli.mjs 合入后，本文件改为从那里转出同名常量（见 tools/film/README.md「接口与替换点」）。

export const EXIT = Object.freeze({
  OK: 0, RUN: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143,
});

export const EXIT_MEANING = Object.freeze({
  0: '成功', 1: '运行失败', 2: '用法错误', 3: '环境或依赖缺失', 4: '契约、验收或闸门不通过',
  5: '资源忙', 124: '超时', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理',
});

export class FilmError extends Error {
  constructor(exitCode, code, message, hint = null, details = null) {
    super(message);
    this.name = 'FilmError';
    this.exitCode = exitCode;
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export const usage = (message, hint = '加 --help 查看用法') => new FilmError(EXIT.USAGE, 'usage', message, hint);

// 把任意异常归一成 FilmError：已知的原样返回，未知的记为运行失败并保留原始信息
export function asFilmError(e) {
  if (e instanceof FilmError) return e;
  const msg = e?.message ? String(e.message).split('\n')[0] : String(e);
  return new FilmError(EXIT.RUN, 'internal', `内部错误：${msg}`, '这是编排器自身的问题；把完整命令与 stderr 一起报给维护者', { stack: e?.stack || null });
}
