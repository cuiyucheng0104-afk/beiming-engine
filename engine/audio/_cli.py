# -*- coding: utf-8 -*-
"""北冥引擎 · 声音命令的约定层：退出码（计划附录 C1）、--json 信封（附录 C2）、严格参数解析、--help 无副作用、信号清理。

与 tools/lib/cli.py 是同一套约定（同样的退出码、信封字段、错误码前缀）；engine 是库层，不反向依赖 tools/，所以在这里放一份最小实现。
engine/audio 下所有 `python -m engine.audio.<命令>` 都经它运行。

接口：
  EXIT                                    OK 0 / FAILURE 1 / USAGE 2 / ENVIRONMENT 3 / CONTRACT 4 / BUSY 5 / TIMEOUT 124 / SIGINT 130 / SIGTERM 143
  CliError(code, message, hint=None)      预期错误；code 的前缀决定退出码：usage.→2、env.→3、contract.→4、busy.→5、timeout→124，其余 1
  ArgumentParser(prog=..., description=...)  argparse 的严格版：不接受缩写，错误抛 CliError（退出码 2，中文说明 + 「是不是想写」）；自带 --json、--quiet
  run(main, parser, argv=None, command=None) → 退出码     main(args, ctx) 返回 None / int / {data, outputs, runJson, warnings, error, exitCode}
  ctx.log(msg) / ctx.warn(code, msg, hint) / ctx.out(text) / ctx.on_cleanup(fn)
  envelope(command, exit_code, error, outputs, run_json, warnings, data) → dict      附录 C2 的信封（多一个 schemaVersion: 1）
  sha256_file(path) → 十六进制摘要

约定：--json 时 stdout 只有一个 JSON 对象（成功、失败都输出），人读的日志一律走 stderr；--help 打到 stdout、退出 0、不执行 main。
stdout / stderr 改成 UTF-8（Windows 的 GBK 控制台与管道里打印中文不抛 UnicodeEncodeError）。未预期的异常按 1 退出，设 BEIMING_DEBUG=1 才打印堆栈。
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import signal
import sys
import traceback

__all__ = ['EXIT', 'CliError', 'ArgumentParser', 'envelope', 'exit_code_for', 'run', 'sha256_file']


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


_PREFIX = [('usage.', EXIT.USAGE), ('env.', EXIT.ENVIRONMENT), ('contract.', EXIT.CONTRACT), ('busy.', EXIT.BUSY),
           ('timeout', EXIT.TIMEOUT), ('signal.sigint', EXIT.SIGINT), ('signal.sigterm', EXIT.SIGTERM)]


def exit_code_for(code):
    for prefix, value in _PREFIX:
        if str(code).startswith(prefix):
            return value
    return EXIT.FAILURE


class CliError(Exception):
    """命令的预期错误：code 是点分机器码（前缀决定退出码），message 说原因，hint 说下一步怎么做。"""

    def __init__(self, code, message, hint=None, exit_code=None, data=None):
        super().__init__(message)
        self.code, self.message, self.hint, self.data = code, message, hint, data
        self.exit_code = exit_code if exit_code is not None else exit_code_for(code)

    def to_json(self):
        return {'code': self.code, 'message': self.message, 'hint': self.hint}


class _Terminated(BaseException):
    pass


_PATTERNS = [
    (re.compile(r'unrecognized arguments: (.+)'), 'unknown-option', '不认识的参数：{0}'),
    (re.compile(r'the following arguments are required: (.+)'), 'missing-argument', '缺少参数：{0}'),
    (re.compile(r'argument (\S+): expected one argument'), 'missing-value', '{0} 后面要跟一个值'),
    (re.compile(r'argument (\S+): invalid choice: (.+?)(?: \(choose from (.+)\))?$'), 'bad-value', '{0} 的取值 {1} 不在允许范围内（{2}）'),
    (re.compile(r'argument (\S+): invalid (\w+) value: (.+)'), 'bad-value', '{0} 需要 {1} 类型的值，收到 {2}'),
    (re.compile(r'argument (\S+): not allowed with argument (\S+)'), 'conflict', '{0} 不能和 {1} 一起用'),
]


class ArgumentParser(argparse.ArgumentParser):
    """argparse 的严格版：错误抛 CliError（退出码 2），自动带 --json 与 --quiet，不接受选项缩写。"""

    def __init__(self, *args, add_globals=True, **kwargs):
        kwargs.setdefault('allow_abbrev', False)
        super().__init__(*args, **kwargs)
        if add_globals:
            self.add_argument('--json', action='store_true', help='stdout 只输出一个 JSON 对象（附录 C2 的信封），日志走 stderr')
            self.add_argument('--quiet', action='store_true', help='不打印进度日志（警告和错误照常打印到 stderr）')

    def _long_options(self):
        return [s for a in self._actions for s in a.option_strings if s.startswith('--')]

    def error(self, message):  # argparse 的接口
        for pattern, kind, template in _PATTERNS:
            m = pattern.search(message)
            if not m:
                continue
            groups = [g if g is not None else '' for g in m.groups()]
            hint = '全部选项见 --help'
            if kind == 'unknown-option':
                first = groups[0].split()[0].split('=')[0]
                close = difflib.get_close_matches(first, self._long_options(), n=1, cutoff=0.6)
                if close:
                    hint = f'是不是想写 {close[0]}？全部选项见 --help'
            raise CliError(f'usage.{kind}', template.format(*groups), hint=hint)
        raise CliError('usage.invalid', f'参数不合法：{message}', hint='全部选项见 --help')


def _norm_warning(w):
    if isinstance(w, str):
        return {'code': 'warning', 'message': w, 'hint': None}
    return {'code': w.get('code', 'warning'), 'message': str(w.get('message', '')), 'hint': w.get('hint')}


def envelope(command, exit_code=0, error=None, outputs=None, run_json=None, warnings=None, data=None):
    err = None
    if error is not None:
        err = error.to_json() if isinstance(error, CliError) else {
            'code': error.get('code', 'failure'), 'message': str(error.get('message', '')), 'hint': error.get('hint')}
    return {'schemaVersion': 1, 'ok': exit_code == 0, 'exitCode': exit_code, 'command': command, 'error': err,
            'outputs': [{'path': o['path'], 'sha256': o.get('sha256'), 'kind': o.get('kind', 'file')} for o in (outputs or [])],
            'runJson': run_json, 'warnings': [_norm_warning(w) for w in (warnings or [])], 'data': data}


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(chunk), b''):
            h.update(b)
    return h.hexdigest()


def _utf8_streams():
    for s in (sys.stdout, sys.stderr):
        try:
            if (s.encoding or '').lower().replace('-', '') != 'utf8':
                s.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass


class _Context:
    def __init__(self, args, command, stdout, stderr):
        self.args, self.command = args, command
        self.json = bool(getattr(args, 'json', False))
        self.quiet = bool(getattr(args, 'quiet', False))
        self.warnings, self._cleanups = [], []
        self._stdout, self._stderr = stdout, stderr

    def log(self, message):
        if not self.quiet:
            print(message, file=self._stderr)

    def warn(self, code, message=None, hint=None):
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
            except Exception as exc:  # 清理失败只报告，不掩盖原来的错误
                print(f'清理失败：{exc}', file=self._stderr)


def run(main, parser, argv=None, command=None, stdout=None, stderr=None):
    """解析参数 → main(args, ctx) → 输出 → 返回退出码（调用方 sys.exit(run(...))）。"""
    _utf8_streams()
    stdout, stderr = stdout or sys.stdout, stderr or sys.stderr
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
            print(json.dumps(envelope(command, code, error, outputs, run_json, ctx.warnings if ctx else [], data),
                             ensure_ascii=False, indent=2), file=stdout)
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
    except SystemExit as e:  # -h / --help 由 argparse 打印后正常退出
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
        error = result.get('error')
        code = result.get('exitCode')
        if code is None:
            code = exit_code_for(error['code'] if isinstance(error, dict) else error.code) if error else EXIT.OK
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
        return finish(EXIT.FAILURE, CliError('failure.internal', f'内部错误：{type(exc).__name__}: {exc}', hint=hint))
    finally:
        if previous is not None:
            try:
                signal.signal(signal.SIGTERM, previous)
            except (ValueError, OSError):
                pass
