"""tools/lib/cli.py 的单元测试：与 cli.mjs 同一套退出码、--json 信封与错误码。

运行：python3 -m unittest discover -s tests/cli -p 'test_*.py'（node --test tests/cli 也会调用它）。
"""
import io
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools' / 'lib'))

from cli import EXIT, ArgumentParser, CliError, envelope, exit_code_for, run  # noqa: E402

ENVELOPE_KEYS = ['schemaVersion', 'ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings', 'data']


def make_parser():
    p = ArgumentParser(prog='python demo.py', description='演示命令')
    p.add_argument('film')
    p.add_argument('--workers', type=int, default=1)
    p.add_argument('--mode', choices=['draft', 'final'], default='draft')
    return p


def call(main, argv):
    out, err = io.StringIO(), io.StringIO()
    code = run(main, make_parser(), argv=argv, command='demo', stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


class ExitCodes(unittest.TestCase):
    def test_constants(self):
        self.assertEqual((EXIT.OK, EXIT.FAILURE, EXIT.USAGE, EXIT.ENVIRONMENT, EXIT.CONTRACT, EXIT.BUSY,
                          EXIT.TIMEOUT, EXIT.SIGINT, EXIT.SIGTERM), (0, 1, 2, 3, 4, 5, 124, 130, 143))
        self.assertEqual(exit_code_for('usage.x'), 2)
        self.assertEqual(exit_code_for('env.numpy'), 3)
        self.assertEqual(exit_code_for('contract.qa'), 4)
        self.assertEqual(exit_code_for('failure.io'), 1)
        self.assertEqual(CliError('busy.gpu', 'm').exit_code, 5)


class Parsing(unittest.TestCase):
    def test_unknown_option_is_usage_error_with_suggestion(self):
        code, out, err = call(lambda a, c: None, ['x', '--worker', '2', '--json'])
        self.assertEqual(code, 2)
        env = json.loads(out)
        self.assertEqual(env['error']['code'], 'usage.unknown-option')
        self.assertIn('--workers', env['error']['hint'])
        self.assertIn('错误[usage.unknown-option]', err)

    def test_no_abbreviation(self):
        code, out, _ = call(lambda a, c: None, ['x', '--jso'])
        self.assertEqual(code, 2)

    def test_bad_value_and_missing_argument(self):
        self.assertEqual(call(lambda a, c: None, ['x', '--workers', 'four'])[0], 2)
        self.assertEqual(call(lambda a, c: None, ['x', '--mode', 'fnial'])[0], 2)
        self.assertEqual(call(lambda a, c: None, [])[0], 2)

    def test_help_goes_to_stdout_and_skips_main(self):
        calls = []
        old = sys.stdout
        sys.stdout = buf = io.StringIO()
        try:
            code = run(lambda a, c: calls.append(1), make_parser(), argv=['--help'], command='demo')
        finally:
            sys.stdout = old
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])
        self.assertIn('--json', buf.getvalue())


class Envelope(unittest.TestCase):
    def test_success_envelope_has_frozen_fields(self):
        def main(args, ctx):
            ctx.log('进度')
            ctx.warn('demo.w', '提醒', hint='下一步')
            ctx.out('给人看的')
            return {'data': {'n': 1}, 'outputs': [{'path': 'films/x/out/a.wav', 'sha256': 'ab', 'kind': 'audio'}]}
        code, out, err = call(main, ['x', '--json'])
        self.assertEqual(code, 0)
        env = json.loads(out)
        self.assertEqual(list(env.keys()), ENVELOPE_KEYS)
        self.assertTrue(env['ok'])
        self.assertEqual(env['warnings'], [{'code': 'demo.w', 'message': '提醒', 'hint': '下一步'}])
        self.assertNotIn('给人看的', out)
        self.assertIn('进度', err)

    def test_cli_error_and_internal_error(self):
        def contract(args, ctx):
            raise CliError('contract.demo', '契约不符', hint='改 film.json')
        code, out, _ = call(contract, ['x', '--json'])
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out)['error']['hint'], '改 film.json')

        cleaned = []

        def boom(args, ctx):
            ctx.on_cleanup(lambda: cleaned.append(1))
            raise RuntimeError('炸了')
        code, out, err = call(boom, ['x'])
        self.assertEqual(code, 1)
        self.assertEqual(cleaned, [1])
        self.assertIn('failure.internal', err)
        self.assertNotIn('Traceback', err)

    def test_envelope_helper(self):
        e = envelope('c', 3, CliError('env.ffmpeg', '没有 ffmpeg', hint='装 FFmpeg 7'), warnings=['一句话'])
        self.assertFalse(e['ok'])
        self.assertEqual(e['error'], {'code': 'env.ffmpeg', 'message': '没有 ffmpeg', 'hint': '装 FFmpeg 7'})
        self.assertEqual(e['warnings'], [{'code': 'warning', 'message': '一句话', 'hint': None}])


if __name__ == '__main__':
    unittest.main()
