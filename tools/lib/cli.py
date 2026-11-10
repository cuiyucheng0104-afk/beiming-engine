"""北冥仓库 · 命令约定库（Python 版）：与 tools/lib/cli.mjs 同一套退出码、--json 信封与错误类，给 Python 命令用。

用法（脚本里）：
    import pathlib, sys
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'lib'))   # 按脚本所在层级调整
    from cli import ArgumentParser, CliError, run

    parser = ArgumentParser(prog='python tools/x.py', description='一句话说明')
    parser.add_argument('target', help='……')

    def main(args, ctx):
        ctx.log('进度……')          # stderr；--quiet 时不打
        ctx.out('结果……')          # stdout；--json 时不打（结果放进返回值的 data）
        if bad:
            raise CliError('contract.x', '哪里不符', hint='下一步怎么做')
        return {'data': {...}, 'outputs': [{'path': 'films/x/out/a.wav', 'sha256': '…', 'kind': 'audio'}]}

    if __name__ == '__main__':
        sys.exit(run(main, parser, command='x'))

约定（docs/CLI.md）：
- -h/--help 打印到 stdout、退出 0、不执行 main；未知选项、缺参数、非法取值退出 2，并给出「是不是想写」的建议；
  不接受选项缩写（--jso 不会被当成 --json）。
- --json 时 stdout 只有一个 JSON 对象（字段同 cli.mjs 的 envelope），成功与失败都输出；日志一律走 stderr。
- CliError(code, message, hint) 的 code 前缀决定退出码：usage.→2、env.→3、contract.→4、busy.→5、timeout→124；
  其他异常按 1（failure.internal）处理，设 BEIMING_DEBUG=1 才打印堆栈。Ctrl+C → 130，SIGTERM → 143，退出前执行 ctx.on_cleanup 登记的清理。
- stdout / stderr 统一改成 UTF-8（Windows 的 GBK 控制台与管道不会因中文抛 UnicodeEncodeError）。
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import signal
import sys
import traceback

__all__ = ['EXIT', 'EXIT_MEANING', 'CliError', 'ArgumentParser', 'envelope', 'exit_code_for', 'run']


class EXIT:
    OK = 0
    FAILURE = 1
    USAGE = 2
    ENVIRONMENT = 3
    CONTRACT = 4
    BUSY = 5
    TIMEOUT = 124
    SIGINT = 130
    SIGTERM = 143


EXIT_MEANING = {
    0: '成功', 1: '运行失败', 2: '用法错误', 3: '环境或依赖缺失', 4: '契约、验收或闸门不通过',
    5: '资源忙', 124: '超时', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理',
}

_PREFIX_EXIT = [('usage.', EXIT.USAGE), ('env.', EXIT.ENVIRONMENT), ('contract.', EXIT.CONTRACT),
                ('busy.', EXIT.BUSY), ('timeout', EXIT.TIMEOUT), ('signal.sigint', EXIT.SIGINT),
                ('signal.sigterm', EXIT.SIGTERM)]


def exit_code_for(code: str) -> int:
    for prefix, value in _PREFIX_EXIT:
        if str(code).startswith(prefix):
            return value
    return EXIT.FAILURE


class CliError(Exception):
    """命令的预期错误：code 是点分机器码（前缀决定退出码），message 说原因，hint 说下一步怎么做。"""

    def __init__(self, code: str, message: str, hint: str | None = None, exit_code: int | None = None, data=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.exit_code = exit_code if exit_code is not None else exit_code_for(code)
        self.data = data

    def to_json(self):
        return {'code': self.code, 'message': self.message, 'hint': self.hint}


class _Terminated(BaseException):
    pass


_ARGPARSE_PATTERNS = [
    (re.compile(r'unrecognized arguments: (.+)'), 'unknown-option', '不认识的参数：{0}'),
    (re.compile(r'the following arguments are required: (.+)'), 'missing-argument', '缺少参数：{0}'),
    (re.compile(r'argument (\S+): expected one argument'), 'missing-value', '{0} 后面要跟一个值'),
    (re.compile(r'argument (\S+): invalid choice: (.+?)(?: \(choose from (.+)\))?$'), 'bad-value', '{0} 的取值 {1} 不在允许范围内（{2}）'),
    (re.compile(r'argument (\S+): invalid (\w+) value: (.+)'), 'bad-value', '{0} 需要 {1} 类型的值，收到 {2}'),
    (re.compile(r'argument (\S+): not allowed with argument (\S+)'), 'conflict', '{0} 不能和 {1} 一起用'),
]


class ArgumentParser(argparse.ArgumentParser):
    """argparse 的严格版：错误抛 CliError（退出码 2，中文说明 + 建议），自动带 --json 与 --quiet，不接受缩写。"""

    def __init__(self, *args, add_globals: bool = True, **kwargs):
        kwargs.setdefault('allow_abbrev', False)
        super().__init__(*args, **kwargs)
        if add_globals:
            self.add_argument('--json', action='store_true', help='stdout 只输出一个 JSON 对象（字段见 docs/CLI.md），日志走 stderr')
            self.add_argument('--quiet', action='store_true', help='不打印进度日志（警告和错误照常打印到 stderr）')

    def _option_strings(self):
        out = []
        for action in self._actions:
            out.extend(s for s in action.option_strings if s.startswith('--'))
        return out

    def error(self, message):  # noqa: D401 - argparse 接口
        for pattern, kind, template in _ARGPARSE_PATTERNS:
            m = pattern.search(message)
            if not m:
                continue
            groups = [g if g is not None else '' for g in m.groups()]
            text = template.format(*groups)
            hint = '全部选项见 --help'
            if kind == 'unknown-option':
                first = groups[0].split()[0]
                close = difflib.get_close_matches(first.split('=')[0], self._option_strings(), n=1, cutoff=0.6)
                if close:
                    hint = f'是不是想写 {close[0]}？全部选项见 --help'
            raise CliError(f'usage.{kind}', text, hint=hint)
        raise CliError('usage.invalid', f'参数不合法：{message}', hint='全部选项见 --help')


def envelope(command, exit_code=0, error=None, outputs=None, run_json=None, warnings=None, data=None):
    """与 cli.mjs 的 envelope 相同的信封（schemaVersion 1）。"""
    err = None
    if error is not None:
        err = error.to_json() if isinstance(error, CliError) else {
            'code': error.get('code', 'failure'), 'message': str(error.get('message', '')), 'hint': error.get('hint')}
    return {
        'schemaVersion': 1,
        'ok': exit_code == 0,
        'exitCode': exit_code,
        'command': command,
        'error': err,
        'outputs': [{'path': o['path'], 'sha256': o.get('sha256'), 'kind': o.get('kind', 'file')} for o in (outputs or [])],
        'runJson': run_json,
        'warnings': [_norm_warning(w) for w in (warnings or [])],
        'data': data,
    }


def _norm_warning(w):
    if isinstance(w, str):
        return {'code': 'warning', 'message': w, 'hint': None}
    return {'code': w.get('code', 'warning'), 'message': str(w.get('message', '')), 'hint': w.get('hint')}


def _utf8_streams():
    for stream in (sys.stdout, sys.stderr):
        try:
            if (stream.encoding or '').lower().replace('-', '') != 'utf8':
                stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass


class _Context:
    def __init__(self, args, command, stdout, stderr):
        self.args = args
        self.command = command
        self.json = bool(getattr(args, 'json', False))
        self.quiet = bool(getattr(args, 'quiet', False))
        self.warnings = []
        self._cleanups = []
        self._stdout = stdout
        self._stderr = stderr

    def log(self, message):
        if not self.quiet:
            print(message, file=self._stderr)

    def warn(self, code, message=None, hint=None):
        """warn('一句话') 或 warn('域.码', '一句话', hint='下一步')。"""
        w = _norm_warning(code) if message is None else {'code': code, 'message': message, 'hint': hint}
        self.warnings.append(w)
        print(f"警告[{w['code']}]：{w['message']}" + (f"\n提示：{w['hint']}" if w['hint'] else ''), file=self._stderr)

    def out(self, text):
        if not self.json:
            print(text, file=self._stdout)

    def on_cleanup(self, fn):
        self._cleanups.append(fn)
        return lambda: self._cleanups.remove(fn) if fn in self._cleanups else None

    def run_cleanups(self):
        while self._cleanups:
            fn = self._cleanups.pop()
            try:
                fn()
            except Exception as exc:  # 清理失败只报告，不掩盖原错误
                print(f'清理失败：{exc}', file=self._stderr)


def run(main, parser, argv=None, command=None, stdout=None, stderr=None):
    """解析参数 → main(args, ctx) → 输出 → 返回退出码（调用方 sys.exit(run(...))）。"""
    _utf8_streams()
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    argv = list(sys.argv[1:] if argv is None else argv)
    command = command or parser.prog
    head = argv[:argv.index('--')] if '--' in argv else argv
    want_json = '--json' in head
    ctx = None

    def finish(code, error=None, data=None, outputs=None, run_json=None):
        if error is not None:
            e = error.to_json() if isinstance(error, CliError) else error
            print(f"错误[{e['code']}]：{e['message']}", file=stderr)
            if e.get('hint'):
                print(f"提示：{e['hint']}", file=stderr)
        if want_json:
            warnings = ctx.warnings if ctx else []
            print(json.dumps(envelope(command, code, error, outputs, run_json, warnings, data), ensure_ascii=False, indent=2), file=stdout)
        try:
            stdout.flush()
        except (BrokenPipeError, ValueError):
            pass
        return code

    try:
        args = parser.parse_args(argv)
    except CliError as e:
        if not want_json:
            print(f'用法：{parser.format_usage().strip()}（完整说明：--help）', file=stderr)
        return finish(e.exit_code, e)
    except SystemExit as e:  # -h / --help / --version 由 argparse 打印后正常退出
        return e.code if isinstance(e.code, int) else 0

    ctx = _Context(args, command, stdout, stderr)
    previous = signal.getsignal(signal.SIGTERM)

    def _on_term(signum, frame):
        raise _Terminated()

    try:
        signal.signal(signal.SIGTERM, _on_term)
    except (ValueError, OSError):  # 非主线程或平台不支持
        previous = None
    try:
        result = main(args, ctx)
        if result is None:
            return finish(EXIT.OK)
        if isinstance(result, int):
            return finish(result)
        code = result.get('exitCode')
        error = result.get('error')
        if code is None:
            code = exit_code_for(error['code']) if error else EXIT.OK
        ctx.warnings.extend(_norm_warning(w) for w in result.get('warnings', []))
        return finish(code, error, result.get('data'), result.get('outputs'), result.get('runJson'))
    except CliError as e:
        ctx.run_cleanups()
        return finish(e.exit_code, e, e.data)
    except KeyboardInterrupt:
        ctx.run_cleanups()
        return finish(EXIT.SIGINT, CliError('signal.sigint', '收到 SIGINT，已停止并清理'))
    except _Terminated:
        ctx.run_cleanups()
        return finish(EXIT.SIGTERM, CliError('signal.sigterm', '收到 SIGTERM，已停止并清理'))
    except Exception as exc:  # 未预期的错误
        ctx.run_cleanups()
        if os.environ.get('BEIMING_DEBUG'):
            traceback.print_exc(file=stderr)
            hint = None
        else:
            hint = '设环境变量 BEIMING_DEBUG=1 重跑可看到堆栈；仍出错请把命令与输出一起报告'
        return finish(EXIT.FAILURE, CliError('failure.internal', f'内部错误：{exc}', hint=hint))
    finally:
        if previous is not None:
            try:
                signal.signal(signal.SIGTERM, previous)
            except (ValueError, OSError):
                pass
