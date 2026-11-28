// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCli, UsageError } from '../../tools/compliance/lib/cli.mjs';

const root = new URL('../../', import.meta.url);
const scan = 'tools/compliance/scan.mjs';
const signed = 'tools/compliance/signed-urls.mjs';
const aigc = 'tools/compliance/aigc.mjs';
const doctor = 'tools/env/doctor.mjs';
const preflight = 'tools/env/preflight.mjs';
const remote = 'tools/remote/cli.mjs';
const scanHint = '可用参数：--json --only --scope --staged --root --allowlist --limit --list-rules --strict --help；加 --help 查看用法';

function invoke(script, ...args) {
  const entry = fileURLToPath(new URL(script, root));
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.ifError(result.error);
  return result;
}

function jsonResult(script, args, exitCode = 0) {
  const result = invoke(script, ...args);
  assert.equal(result.status, exitCode, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const data = JSON.parse(result.stdout);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.ok, exitCode === 0);
  assert.equal(data.exitCode, exitCode);
  return data;
}

test('R12：原样帮助和 JSON 标志在普通入口扫描整个 argv', () => {
  const comp = jsonResult(scan, ['--scope', '--', '-h', '--json']);
  assert.match(comp.result.help, /用法/);
  const env = invoke(doctor, '--unknown', '--', '--json', '-h');
  assert.equal(env.status, 0);
  assert.equal(env.stderr, '');
  assert.match(env.stdout, /用法/);
  const inlineJson = invoke(doctor, '--json=false');
  assert.equal(inlineJson.status, 2);
  assert.equal(inlineJson.stdout, '');
  assert.equal(inlineJson.stderr, 'env:doctor：--json 是开关，不带值\n下一步：直接写 --json\n');
});

test('R12：用法错误保留各外壳的完整消息和提示', () => {
  const cases = [
    [scan, ['--unknown=value', '--json'], 'unknown-option', '不认识的选项 --unknown', scanHint],
    [scan, ['--json', '--scope', '--'], 'missing-value', '--scope 后面要跟一个值', scanHint],
    [scan, ['--json', '--staged=1'], 'bad-value', '--staged 是开关，不带值', scanHint],
    [scan, ['first', '--unknown', '--json'], 'extra-argument', '不接受位置参数：first', scanHint],
    [scan, ['--', '--json'], 'extra-argument', '不接受位置参数：--json', scanHint],
    [signed, ['--json', 'list', '--', 'strip', '--unknown'], 'extra-argument', '多余的位置参数：strip --unknown', '加 --help 查看用法'],
    [doctor, ['first', '--unknown', '--json'], 'unknown-option', '不认识的选项 --unknown', '全部选项见 --help'],
    [doctor, ['--json', '--route', '-a'], 'missing-value', '--route 后面要跟一个值', '见 --help；值本身以 - 开头时写成 --route=<值>'],
    [doctor, ['--json', '--quick=0'], 'bad-value', '--quick 是开关，不带值', '直接写 --quick'],
    [doctor, ['--', '--json', 'extra'], 'extra-argument', '不接受位置参数：--json extra', '见 --help'],
  ];
  for (const [script, args, code, message, hint] of cases) {
    const { error } = jsonResult(script, args, 2);
    assert.deepEqual(error, { code: `usage.${code}`, message, hint }, `${script} ${args.join(' ')}`);
  }
  assert.throws(() => parseCli(['--unknown'], { options: {} }), {
    constructor: UsageError, code: 'usage.unknown-option', exitCode: 2,
  });
});

test('R12：别名、重复选项与缺省值维持真实入口的解析结果', () => {
  const label = jsonResult(aigc, ['label', '-hh', '--id', 'first', '--id=second', '--tool=one', '--tool=-two', '--json']);
  assert.match(label.result.comment, /"ProduceID":"second"/);
  assert.match(label.result.comment, /生成工具：one、-two/);
  assert.deepEqual(label.result.explicit, ['含 AI 生成画面']);
  const env = jsonResult(preflight, ['--need', 'node', '--need=disk', '--json']);
  assert.deepEqual(env.checks.map(check => check.id), ['node.version', 'disk.free']);
});

test('R12：remote 的分隔符保护远端 argv，compare 单独校验位置参数和选项', () => {
  const missing = invoke(remote, 'compare', 'left', '--', '--json', '-h');
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /^remote compare：compare 需要两个运行记录文件\n/);
  const unexpected = jsonResult(remote, ['compare', 'left', 'right', '--json', '--', '-h'], 2);
  assert.equal(unexpected.error.message, 'compare 只接受 --mode、--left-root、--right-root、--json');
  const extra = jsonResult(remote, ['compare', 'left', 'right', 'extra', '--json'], 2);
  assert.deepEqual(extra.error, { code: 'usage.extra-argument', message: '多余的参数：extra', hint: '见 --help' });
});
