// 北冥仓库 · 远端命令行的拼装：POSIX 单引号转义；PowerShell 用 -EncodedCommand（UTF-16LE + base64），避开 cmd / PowerShell 两层引号与中文编码问题。
// 参数一律先变成 base64url 的 JSON 令牌再传给远端 agent，令牌里只有 [A-Za-z0-9_-]，任何 shell 都不会改它。
//
// 接口：
//   shQuote(s) / psQuote(s)              单个参数加引号
//   encodePowerShell(script)             → -EncodedCommand 的值
//   remoteCommand(shell, argv)           → 交给 ssh 的一整条命令（shell = 'posix' | 'powershell'）
//   encodeToken(obj) / decodeToken(str)  JSON ⇄ base64url
export const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;
export const encodePowerShell = script => Buffer.from(script, 'utf16le').toString('base64');
export const encodeToken = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
export const decodeToken = str => JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));

export function remoteCommand(shell, argv) {
  if (shell === 'powershell') {
    const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; & ${argv.map(psQuote).join(' ')}; exit $LASTEXITCODE`;
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
  }
  return argv.map(shQuote).join(' ');
}
