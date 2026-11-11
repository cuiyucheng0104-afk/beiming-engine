// 北冥引擎 · 本地预览服务（npm run serve）：用渲染器同一个加固过的静态服务器（lib/server.mjs）在 127.0.0.1 上提供仓库，
// 在浏览器里打开影片页面（ES 模块与贴图要经 http 加载）。只监听本机回环地址，局域网里的其他机器访问不到；
// 点文件（.git、.env …）一律 404，Host 必须是 127.0.0.1 / localhost，只回答 GET / HEAD，不列目录。
// 取代 python3 -m http.server 与 npx http-server（它们监听所有网卡，并且会把 .git 发出去）。
//   node engine/render/serve.mjs [--port 8080] [--root <目录>] [--json]
//   打开 http://127.0.0.1:8080/films/<名字>/          （《北冥》样片是 http://127.0.0.1:8080/）
// 一启动就输出地址（stdout；--json 时是一个信封对象，data 里有 url、port、root），之后一直服务到 Ctrl-C（退出码 130）或
// SIGTERM（143）。端口被占用 → 退出码 5；--root 不是目录 → 2。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCommand, isMain, runCli, CliError, EXIT } from '../../tools/lib/cli.mjs';
import { createServer } from './lib/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const command = defineCommand({
  name: 'engine/render/serve.mjs',
  summary: '在 127.0.0.1 上提供仓库（或 --root 指定的目录），供浏览器预览影片页面；不监听其他网卡',
  usage: ['node engine/render/serve.mjs [--port 8080] [--root <目录>] [--json]'],
  options: {
    port: { type: 'integer', min: 0, max: 65535, default: 8080, arg: '<端口>', describe: '端口（默认 8080；0 表示随机空闲端口）' },
    root: { type: 'string', arg: '<目录>', describe: '服务根（默认仓库根）' },
  },
  exitCodes: { 0: '已启动（之后一直服务）', 2: '用法错误', 3: '监听失败', 5: '端口被占用', 130: '收到 SIGINT，已关闭', 143: '收到 SIGTERM，已关闭' },
  examples: ['node engine/render/serve.mjs                    → http://127.0.0.1:8080/', 'node engine/render/serve.mjs --port 0 --json      随机端口，把地址交给调度器'],
  async run(ctx) {
    const root = path.resolve(ctx.opts.root ?? REPO);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new CliError('usage.bad-root', `--root 不是目录：${root}`, { hint: '写仓库里的目录，或不写（默认仓库根）' });
    const srv = createServer({ root });
    let port, url;
    try { ({ port, url } = await srv.listen(ctx.opts.port)); } catch (e) {
      if (e.code === 'EADDRINUSE') throw new CliError('busy.port', `端口 ${ctx.opts.port} 已被占用`, { hint: '换一个 --port，或用 --port 0 取随机空闲端口' });
      throw new CliError('env.listen', `监听 127.0.0.1:${ctx.opts.port} 失败：${e.message}`, { hint: '检查本机防火墙与端口权限（1024 以下的端口要管理员权限）' });
    }
    // 一直服务到信号：信封已经在启动时输出，这里只负责关掉服务器并以 130 / 143 退出
    for (const [sig, code] of [['SIGINT', EXIT.SIGINT], ['SIGTERM', EXIT.SIGTERM], ['SIGHUP', EXIT.SIGTERM]]) {
      process.once(sig, () => {
        process.stderr.write(`\n收到 ${sig}：关闭预览服务\n`);
        setTimeout(() => process.exit(code), 2000).unref();
        srv.close().then(() => process.exit(code));
      });
    }
    ctx.log.info(`预览服务：${url}（只监听 127.0.0.1；服务根 ${path.relative(REPO, root) || '仓库根'}）。Ctrl-C 结束`);
    ctx.out(url);
    return { data: { url, port, root: path.relative(REPO, root).split(path.sep).join('/') || '.' } };
  },
});

if (isMain(import.meta.url)) await runCli(command);
