// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine

// 原样帮助标志优先于严格解析。调用者决定传入全部 argv 还是仅本地参数。
export function wantsHelp(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

// Node parseArgs 的共同错误码和消息；提示与错误类由调用者决定。
export function describeParseArgsError(error) {
  const flag = /'(-{1,2}[^' ]+)/.exec(error.message)?.[1] ?? '';
  switch (error.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return { code: 'usage.unknown-option', message: `不认识的选项 ${flag || error.message}`, flag };
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      if (/does not take an argument/.test(error.message)) {
        return { code: 'usage.bad-value', message: `${flag} 是开关，不带值`, flag };
      }
      return { code: 'usage.missing-value', message: `${flag} 后面要跟一个值`, flag };
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL': {
      const positional = /'([^']*)'/.exec(error.message)?.[1] ?? '';
      return { code: 'usage.extra-argument', message: `不接受位置参数：${positional}`, flag };
    }
    default:
      return null;
  }
}
