// 采集与离线 QA 共用错误类型，旧调用方仍能按类型和退出码处理。
export const EXIT = Object.freeze({ OK: 0, RUNTIME: 1, USAGE: 2, ENV: 3, GATE: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143 });

export class QaError extends Error {
  constructor(code, message, { hint = null, exitCode = EXIT.RUNTIME, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'QaError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}
