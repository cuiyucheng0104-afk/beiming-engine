// 北冥引擎 · 本地预览服务（npm run serve）：用渲染器同一个加固过的静态服务器（lib/server.mjs）在 127.0.0.1 上提供仓库，
// 在浏览器里打开影片页面（ES 模块与贴图要经 http 加载）。只监听本机回环地址，局域网里的其他机器访问不到；
// 点文件（.git、.env …）一律 404，Host 必须是 127.0.0.1 / localhost，只回答 GET / HEAD，不列目录。
//   node engine/render/serve.mjs [--port 8080] [--root <目录>] [--json]
//   打开 http://127.0.0.1:8080/films/<名字>/          （《北冥》样片是 http://127.0.0.1:8080/）
// Ctrl-C 结束（退出码 130）。端口被占用 → 退出码 5；--json 时一启动就在 stdout 输出一个对象 { ok, …, url, port }。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './lib/server.mjs';
import { runCli, RenderError, UsageError, EXIT, REPO } from './lib/cli.mjs';

export const SPEC = {
  command: 'engine/render/serve.mjs',
  usage: 'node engine/render/serve.mjs [--port 8080] [--root <目录>] [--json]',
  summary: ['在 127.0.0.1 上提供仓库（或 --root 指定的目录），供浏览器预览影片页面；不监听其他网卡。'],
  positionals: { min: 0, max: 0 },
  options: {
    '--port': { type: 'int', min: 0, max: 65535, default: 8080, arg: '<端口>', desc: '端口（默认 8080；0 表示随机空闲端口）' },
    '--root': { type: 'string', arg: '<目录>', desc: '服务根（默认仓库根）' },
    '--json': { type: 'flag', desc: '一启动就在 stdout 输出 { ok, url, port, root }' },
  },
  examples: ['node engine/render/serve.mjs                    → http://127.0.0.1:8080/', 'node engine/render/serve.mjs --port 0 --json      随机端口，把地址交给调度器'],
};

async function main({ opts, log, signal, emit }) {
  const root = path.resolve(opts['--root'] ?? REPO);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`--root 不是目录：${root}`);
  const srv = createServer({ root });
  let port, url;
  try { ({ port, url } = await srv.listen(opts['--port'])); } catch (e) {
    if (e.code === 'EADDRINUSE') throw new RenderError('port-busy', `端口 ${opts['--port']} 已被占用`, { exitCode: EXIT.BUSY, hint: '换一个 --port，或用 --port 0 取随机空闲端口' });
    throw new RenderError('listen-failed', `监听 127.0.0.1:${opts['--port']} 失败：${e.message}`, { exitCode: EXIT.ENV });
  }
  log.info(`预览服务：${url}（只监听 127.0.0.1；服务根 ${root}）。Ctrl-C 结束`);
  emit({ url, port, root });
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  await srv.close();
  return { silent: true };
}

const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await runCli(SPEC, main);
