// B 路线命令行公共件（engine/native/cli.mjs）：参数解析、退出码、--json 信封、入口判断（经符号链接调用，审查 R06）、
// 子进程超时（124）与找不到程序（3）。不启动 GPU、不需要原生运行时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, envelope, parseArgs, runQuick, spawnStream } from '../../engine/native/cli.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('退出码与附录 C1 一致', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, FAIL: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143 });
});

test('parseArgs：开关、带值、--k=v、位置参数、-- 之后原样', () => {
  const spec = { '--json': 'bool', '--at': 'string', '--quality': 'string' };
  assert.deepEqual(parseArgs(['films/x', '--at', '0,3', '--quality=draft', '--json', '--', '--not-a-flag'], spec),
    { _: ['films/x', '--not-a-flag'], at: '0,3', quality: 'draft', json: true });
});

test('parseArgs：未知参数、缺值、开关带值都是用法错误（exit 2）', () => {
  const spec = { '--json': 'bool', '--at': 'string' };
  for (const argv of [['--nope'], ['--at'], ['--at', '--json'], ['--json=1']]) {
    assert.throws(() => parseArgs(argv, spec), e => e instanceof CliError && e.exitCode === EXIT.USAGE, argv.join(' '));
  }
});

test('envelope：字段齐全，ok 由退出码决定', () => {
  const e = envelope({ command: 'x', exitCode: 4, error: { code: 'c', message: 'm', hint: 'h' } });
  assert.deepEqual(Object.keys(e).sort(), ['command', 'error', 'exitCode', 'ok', 'outputs', 'runJson', 'warnings']);
  assert.equal(e.ok, false);
  assert.equal(envelope({ command: 'x' }).ok, true);
});

test('isMain：经符号链接调用的入口照样执行（审查 R06）', { skip: process.platform === 'win32' && '需要创建符号链接的权限' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bne-ismain-'));
  try {
    const link = join(dir, 'repo');
    symlinkSync(realpathSync(ROOT), link, 'dir');
    const r = spawnSync(process.execPath, [join(link, 'engine/native/bridge/validate.mjs'), join(dir, 'nope.glb')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, EXIT.USAGE, `经链接调用应真正执行并因文件不存在 exit 2，实际 ${r.status}：${r.stderr}`);
    assert.match(r.stderr, /读不了/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spawnStream：超时终止子进程并以 124 报告', async () => {
  const t0 = Date.now();
  await assert.rejects(spawnStream(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 400, quiet: true, label: '测试子进程' }),
    e => e instanceof CliError && e.exitCode === EXIT.TIMEOUT && /超过/.test(e.message));
  assert.ok(Date.now() - t0 < 10000, '超时后应在几秒内返回');
});

test('spawnStream：逐行回调、写日志、返回退出码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bne-spawn-'));
  try {
    const lines = [];
    const r = await spawnStream(process.execPath, ['-e', 'console.log("a");console.error("b");process.exit(3)'], { quiet: true, logFile: join(dir, 'x.log'), onLine: (l, s) => lines.push(`${s}:${l}`) });
    assert.equal(r.code, 3);
    assert.deepEqual(lines.sort(), ['stderr:b', 'stdout:a']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('找不到程序：exit 3，说明下一步', async () => {
  assert.throws(() => runQuick('bne-no-such-program-xyz', ['--version']), e => e.exitCode === EXIT.ENV);
  await assert.rejects(spawnStream('bne-no-such-program-xyz', [], { quiet: true }), e => e.exitCode === EXIT.ENV && e.hint.length > 0);
});

test('runQuick：同步命令也有超时（124）', () => {
  assert.throws(() => runQuick(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 300, label: '慢命令' }), e => e.exitCode === EXIT.TIMEOUT);
});

test('写一个临时文件不影响 cli.mjs 的模块状态（信封里的 warnings 只来自 warn）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bne-env-'));
  try { writeFileSync(join(dir, 'x'), '1'); assert.deepEqual(envelope({ command: 'y' }).warnings, []); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
