# -*- coding: utf-8 -*-
"""北冥引擎 · 声音命令的命令约定：直接用仓库的命令约定库 tools/lib/cli.py（docs/CLI.md），这里不另写一份。

engine/audio 下所有 `python -m engine.audio.<命令>` 与 audio/ 下的《北冥》声音入口都经这里取同一套：
  EXIT                                    OK 0 / FAILURE 1 / USAGE 2 / ENVIRONMENT 3 / CONTRACT 4 / BUSY 5 / TIMEOUT 124 / SIGINT 130 / SIGTERM 143
  CliError(code, message, hint=None)      预期错误；code 的前缀决定退出码：usage.→2、env.→3、contract.→4、busy.→5、timeout→124，其余 1
  ArgumentParser(prog=..., description=...)  argparse 的严格版（不接受缩写，错误抛 CliError，退出码 2）；自带 --json、--quiet
  run(main, parser, argv=None, command=None) → 退出码     main(args, ctx) 返回 None / int / {data, outputs, runJson, warnings, error, exitCode}
  envelope(...)                           附录 C2 的 --json 信封
另加两个声音工具共用的小函数：
  sha256_file(path) → 十六进制摘要（按块读，长片混音不整个读进内存）
  rel(path) → 仓库相对、正斜杠的路径（仓库外的路径原样返回）：报告与信封里不写本机绝对路径
命令约定库按文件路径加载（模块名 beiming_cli），不往 sys.path 里加目录，不会和别的叫 cli 的模块撞名。
"""
import hashlib
import importlib.util
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LIB = os.path.join(ROOT, 'tools', 'lib', 'cli.py')
_NAME = 'beiming_cli'


def _load():
    mod = sys.modules.get(_NAME)
    if mod is not None:
        return mod
    if not os.path.exists(LIB):
        raise ImportError(f'找不到命令约定库 {LIB}：engine/audio 的命令要在完整的仓库检出里运行（tools/lib/cli.py 随仓库提供）')
    spec = importlib.util.spec_from_file_location(_NAME, LIB)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[_NAME] = mod
    try:
        spec.loader.exec_module(mod)
    except BaseException:
        sys.modules.pop(_NAME, None)
        raise
    return mod


_lib = _load()
EXIT = _lib.EXIT
EXIT_MEANING = _lib.EXIT_MEANING
CliError = _lib.CliError
ArgumentParser = _lib.ArgumentParser
envelope = _lib.envelope
exit_code_for = _lib.exit_code_for
run = _lib.run

__all__ = ['EXIT', 'EXIT_MEANING', 'CliError', 'ArgumentParser', 'envelope', 'exit_code_for', 'run', 'sha256_file', 'rel', 'ROOT']


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(chunk), b''):
            h.update(b)
    return h.hexdigest()


def rel(path):
    """仓库内的路径 → 仓库相对、正斜杠；仓库外（或 Windows 上跨盘符）原样返回"""
    if not path:
        return path
    p = os.path.abspath(path)
    try:
        r = os.path.relpath(p, ROOT)
    except ValueError:
        return p
    return p if r == '..' or r.startswith('..' + os.sep) else r.replace(os.sep, '/')
