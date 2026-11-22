import { parseArgs } from 'node:util';
import { defaultUrl } from './client.mjs';
import { runApiCli } from './cli-shell.mjs';

const ADMIN = {
  'data-dir': { type: 'string', default: '.beiming-api' }, port: { type: 'string', default: '8080' },
  host: { type: 'string', default: '127.0.0.1' }, name: { type: 'string' }, 'local-trusted': { type: 'boolean' },
};
const SHELL = { url: { type: 'string' }, token: { type: 'string' } };
const argv = process.argv.slice(2);
// 宽松解析只用来认子命令；issue-token 与 serve 仍按原来的严格解析走。
const sub = parseArgs({ args: argv, strict: false, allowPositionals: true, options: { ...ADMIN, ...SHELL } }).positionals[0];
if (sub === 'issue-token' || sub === 'serve') {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: ADMIN });
  // 管理命令才加载服务端；动词薄壳只经 HTTP，不带制作管线启动。
  const { issueAccountToken, startServer } = await import('./index.mjs');
  const dataDir = values['data-dir'];
  if (positionals.length === 1 && positionals[0] === 'issue-token') {
    console.log(issueAccountToken(dataDir, { name: values.name }));
  } else if (positionals.length === 1 && positionals[0] === 'serve') {
    const api = await startServer({ dataDir, host: values.host, port: Number(values.port), localTrusted: values['local-trusted'] });
    console.log(api.url);
    const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void api.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else {
    console.error('用法：node beiming/api/cli.mjs issue-token|serve [--data-dir 目录]');
    process.exitCode = 2;
  }
} else if (sub === 'mcp') {
  let values;
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, options: SHELL });
    if (parsed.positionals.length === 1) values = parsed.values;
  } catch { /* 选项写错：落到下面的用法 */ }
  if (values) {
    const { serveMcpStdio } = await import('./mcp.mjs');
    await serveMcpStdio({ baseUrl: values.url ?? defaultUrl(), token: values.token ?? process.env.BEIMING_API_TOKEN });
  } else {
    // 启动参数写错不进 stdio 循环：不然配置里的拼写错误看起来像在正常等输入。
    console.error('用法：node beiming/api/cli.mjs mcp [--url <服务地址>] [--token <令牌>]');
    process.exitCode = 2;
  }
} else {
  process.exitCode = await runApiCli(argv);
}
