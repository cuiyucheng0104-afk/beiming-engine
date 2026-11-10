#!/usr/bin/env node
// 北冥仓库 · 统一的 Python 入口：任何 npm 脚本、工具与文档里的 Python 命令都经它启动，三个平台写法一样。
//   node tools/env/py.mjs <python 参数…>        例：node tools/env/py.mjs tools/casebook.py list
//   node tools/env/py.mjs -c "import numpy"
//   node tools/env/py.mjs --which [--json]      只显示选中的解释器与查找过程，不运行
//   node tools/env/py.mjs --help
//
// 解释器查找顺序见 tools/env/lib/python.mjs：BEIMING_PYTHON → BEIMING_PY → PYTHON → .venv → python3 → python → py -3.12 → py -3。
// 子进程环境固定 PYTHONUTF8=1、PYTHONIOENCODING=utf-8（中文 Windows 的 GBK 管道下也不会 UnicodeEncodeError），
// PYTHONPATH 前置仓库根（任何目录下都能 import engine.audio）。
// 退出码：透传 Python 的退出码；找不到可用解释器时 3；被信号结束时 128+信号号。
// 只有放在最前面的 --help / -h / --which / --json 属于本工具，其余参数原样交给 Python（所以 casebook 的 --help 照常是 casebook 的）。
// 供其它 Node 工具调用：import { resolvePython, pythonEnv, spawnPython } from './tools/env/py.mjs'
import { spawn } from 'node:child_process';
import { EXIT, envelope, writeAndExit, isMain } from './lib/cli.mjs';
import { resolvePython, pythonEnv, ROOT, candidates } from './lib/python.mjs';

export { resolvePython, pythonEnv, ROOT, candidates };

const HELP = `北冥仓库 · 统一的 Python 入口

用法：
  node tools/env/py.mjs <python 参数…>      用仓库选定的解释器运行，例如：
      node tools/env/py.mjs tools/casebook.py list
      node tools/env/py.mjs -c "import numpy, scipy, numba, soundfile, soxr"
      node tools/env/py.mjs -m engine.audio.cuecheck --help
  node tools/env/py.mjs --which [--json]    只显示选中的解释器与查找过程（每个候选只运行一次版本探测）
  node tools/env/py.mjs --help              本说明

查找顺序（第一个能运行的就用）：
  BEIMING_PYTHON → BEIMING_PY → PYTHON → .venv（npm run setup 建）→ python3 → python → py -3.12 → py -3（仅 Windows）
  显式设置的变量或 .venv 坏了会直接报错（exit 3），不会悄悄换成别的解释器。

子进程环境：PYTHONUTF8=1、PYTHONIOENCODING=utf-8、PYTHONPATH 前置仓库根。
退出码：透传 Python 的退出码；没有可用解释器 3；被信号结束 128+信号号。
只有最前面的 --help / -h / --which / --json 属于本工具，之后的参数原样交给 Python。`;

// 起一个 Python 子进程：stdio 默认继承；返回 ChildProcess。解析失败时抛错（带 hint）
export async function spawnPython(args, { stdio = 'inherit', env = process.env, cwd } = {}) {
  const py = await resolvePython({ env });
  if (!py.ok) {
    const e = new Error(py.error);
    e.hint = py.hint; e.exitCode = EXIT.ENV; e.resolution = py;
    throw e;
  }
  return spawn(py.cmd, [...py.args, ...args], { stdio, env: pythonEnv(env), cwd, windowsHide: true });
}

async function main(argv) {
  const own = new Set(['--help', '-h', '--which', '--json']);
  const mine = [];
  while (argv.length && own.has(argv[0])) mine.push(argv.shift());
  if (argv[0] === '--') argv.shift();
  if (mine.includes('--help') || mine.includes('-h')) return writeAndExit(HELP, EXIT.OK);

  if (mine.includes('--which') || mine.includes('--json')) {
    if (argv.length) {
      const msg = '--which 只显示解释器，不和 Python 参数一起用';
      if (mine.includes('--json')) return writeAndExit(JSON.stringify(envelope({ command: 'env:py', exitCode: EXIT.USAGE, error: { code: 'usage', message: msg, hint: '去掉 --which 再运行 Python 命令' } })), EXIT.USAGE);
      process.stderr.write(`py.mjs：${msg}\n`);
      return writeAndExit('', EXIT.USAGE);
    }
    const py = await resolvePython({ want: '3.12' });
    const exitCode = py.ok ? EXIT.OK : EXIT.ENV;
    if (mine.includes('--json')) {
      const python = py.ok ? { source: py.source, cmd: [py.cmd, ...py.args], version: py.versionString, executable: py.executable, prefix: py.prefix, venv: py.prefix !== py.basePrefix } : null;
      return writeAndExit(JSON.stringify(envelope({ command: 'env:py', exitCode, error: py.ok ? null : { code: 'python-missing', message: py.error, hint: py.hint }, python, tried: py.tried })), exitCode);
    }
    const lines = py.ok
      ? [`选中：${py.source} → ${py.executable}（Python ${py.versionString}${py.prefix !== py.basePrefix ? '，虚拟环境' : ''}）`]
      : [`没有可用的 Python：${py.error}`, `下一步：${py.hint}`];
    lines.push('查找过程：', ...py.tried.map(t => `  ${t.ok ? 'OK  ' : 'FAIL'} ${t.source.padEnd(14)} ${t.ok ? '' : t.error}`));
    return writeAndExit(lines.join('\n'), exitCode);
  }

  let child;
  try {
    child = await spawnPython(argv);
  } catch (e) {
    process.stderr.write(`py.mjs：${e.message}\n下一步：${e.hint}\n`);
    return writeAndExit('', e.exitCode || EXIT.ENV);
  }
  const forward = sig => () => { try { child.kill(sig); } catch { /* 已退出 */ } };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('error', e => { process.stderr.write(`py.mjs：无法启动 Python（${e.message}）\n`); process.exit(EXIT.ENV); });
  child.on('close', (code, signal) => {
    const n = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }[signal];
    process.exit(code ?? (n ? 128 + n : EXIT.FAIL));
  });
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
