// B 路线命令行公共件（engine/native/cli.mjs）：在仓库命令约定库 tools/lib/cli.mjs 之上的薄封装——
// 退出码数值一致、fail() 的错误码前缀决定退出码、入口判断（经符号链接调用，审查 R06）、子进程超时（124）与找不到程序（3）、
// 信号中断时整组终止子进程并清理（130）。不启动 GPU、不需要原生运行时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, fail, runQuick, spawnStream } from '../../engine/native/cli.mjs';
import { EXIT as LIB_EXIT, exitCodeFor } from '../../tools/lib/cli.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('退出码与附录 C1、命令约定库一致', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, FAIL: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143 });
  assert.deepEqual([EXIT.FAIL, EXIT.ENV, EXIT.TIMEOUT], [LIB_EXIT.FAILURE, LIB_EXIT.ENVIRONMENT, LIB_EXIT.TIMEOUT]);
});

test('fail()：返回命令约定库的 CliError，错误码前缀与退出码对得上', () => {
  for (const [exit, prefix] of [[EXIT.FAIL, 'failure'], [EXIT.USAGE, 'usage'], [EXIT.ENV, 'env'], [EXIT.CONTRACT, 'contract'], [EXIT.BUSY, 'busy'], [EXIT.TIMEOUT, 'timeout']]) {
    const e = fail(exit, 'x', '原因', '下一步');
    assert.ok(e instanceof CliError);
    assert.equal(e.exitCode, exit);
    assert.equal(e.code, `${prefix}.x`);
    assert.equal(exitCodeFor(e.code), exit, '前缀单独也能推出同一个退出码');
    assert.deepEqual(e.toJSON(), { code: `${prefix}.x`, message: '原因', hint: '下一步' });
  }
});

test('isMain：经符号链接调用的入口照样执行（审查 R06）', { skip: process.platform === 'win32' && '需要创建符号链接的权限' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bne-ismain-'));
  try {
    const link = join(dir, 'repo');
    symlinkSync(realpathSync(ROOT), link, 'dir');
    for (const entry of ['engine/native/bridge/validate.mjs', 'examples/raea/tools/export-kun-validate.mjs']) {
      const r = spawnSync(process.execPath, [join(link, entry), join(dir, 'nope.glb')], { encoding: 'utf8', timeout: 30000 });
      assert.equal(r.status, EXIT.USAGE, `${entry} 经链接调用应真正执行并因文件不存在 exit 2，实际 ${r.status}：${r.stderr}`);
      assert.match(r.stderr, /读不了/);
    }
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

test('SIGINT：命令整组终止子进程、执行登记的清理，以 130 退出并输出一个信封', { skip: process.platform === 'win32' && 'Windows 没有 POSIX 信号' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bne-sig-'));
  try {
    const marker = join(dir, 'cleaned'), pidFile = join(dir, 'child.pid');
    const script = join(dir, 'cmd.mjs');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
import { bind, exitWith, onCleanup, spawnStream } from ${JSON.stringify(new URL('../../engine/native/cli.mjs', import.meta.url).href)};
import { defineCommand, runCli } from ${JSON.stringify(new URL('../../tools/lib/cli.mjs', import.meta.url).href)};
const command = defineCommand({ name: 'sig-test', summary: '测试', async run(ctx) {
  bind(ctx);
  onCleanup(() => writeFileSync(${JSON.stringify(marker)}, 'ok'));
  const p = spawnStream(process.execPath, ['-e', 'require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)'], { quiet: true });
  process.stderr.write('READY\\n');
  await p;
} });
await exitWith(runCli(command));
`);
    const child = spawn(process.execPath, [script, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    for (let i = 0; i < 100 && !(err.includes('READY') && existsSync(pidFile)); i++) await new Promise(r => setTimeout(r, 50));
    child.kill('SIGINT');
    const code = await new Promise(r => child.on('close', c => r(c)));
    assert.equal(code, EXIT.SIGINT, err);
    const env = JSON.parse(out);
    assert.equal(env.exitCode, EXIT.SIGINT);
    assert.equal(env.error.code, 'signal.sigint');
    assert.ok(existsSync(marker), '登记的清理要执行');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 50)); } catch { alive = false; } }
    assert.equal(alive, false, '子进程要被终止，不留残留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

