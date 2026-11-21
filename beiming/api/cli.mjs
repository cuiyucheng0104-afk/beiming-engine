import { parseArgs } from 'node:util';
import { issueAccountToken, startServer } from './index.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'data-dir': { type: 'string', default: '.beiming-api' }, port: { type: 'string', default: '8080' },
  host: { type: 'string', default: '127.0.0.1' }, name: { type: 'string' }, 'local-trusted': { type: 'boolean' },
} });
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
