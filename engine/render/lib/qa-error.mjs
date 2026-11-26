// 采集与离线 QA 共用错误类型，旧调用方仍能按类型和退出码处理。
// EXIT 提供 QA 兼容的退出码名称，QaError 携带错误码、提示和原始异常。
import { EXIT as BASE_EXIT } from '../../../tools/lib/cli.mjs';

const { FAILURE, ENVIRONMENT, CONTRACT, ...COMMON_EXIT } = BASE_EXIT;
export const EXIT = Object.freeze({ ...COMMON_EXIT, RUNTIME: FAILURE, ENV: ENVIRONMENT, GATE: CONTRACT });

export class QaError extends Error {
  constructor(code, message, { hint = null, exitCode = EXIT.RUNTIME, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'QaError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}
