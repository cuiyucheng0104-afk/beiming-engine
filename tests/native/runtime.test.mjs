// B 路线原生运行时锁定（engine/native/runtime.mjs）：用假的可执行文件与 VERSION 核对各种不合格情况的退出码；
// RAEA_BIN 写相对路径时解析成绝对路径、之后一律用它（审查 R03）；获取命令不接受许可就拒绝（exit 2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLock, platformKey, resolveRuntime } from '../../engine/native/runtime.mjs';
import { EXIT } from '../../engine/native/cli.mjs';

const ENTRY = fileURLToPath(new URL('../../engine/native/runtime.mjs', import.meta.url));

function fakeRuntime(version = '0.1.0-canary.2') {
  const dir = mkdtempSync(join(tmpdir(), 'bne-rt-'));
  const exe = join(dir, 'raea', 'bin', process.platform === 'win32' ? 'raea.exe' : 'raea');
  mkdirSync(join(dir, 'raea', 'bin'), { recursive: true });
  mkdirSync(join(dir, 'raea', 'share', 'raea'), { recursive: true });
  writeFileSync(exe, '#!/bin/sh\necho usage\n');
  chmodSync(exe, 0o755);
  writeFileSync(join(dir, 'raea', 'share', 'raea', 'VERSION'), `${version}\n`);
  const sha = createHash('sha256').update(readFileSync(exe)).digest('hex');
  return { dir, exe, sha };
}
const lockWith = binarySha256 => ({ version: '0.1.0-canary.2', platforms: { [platformKey()]: { binarySha256 } } });

test('锁文件：版本、许可、各平台归档哈希都在；macOS arm64 的可执行文件哈希已锁定', async () => {
  const lock = await loadLock();
  assert.equal(lock.version, '0.1.0-canary.2');
  assert.equal(lock.license, 'FSL-1.1-ALv2');
  for (const k of ['macos-arm64', 'windows-x64', 'linux-x64']) assert.match(lock.platforms[k].sha256, /^[0-9a-f]{64}$/, k);
  assert.equal(lock.platforms['macos-arm64'].sha256, 'bc48a94af99f7626a83f930a5d7ecfd2464218ad8b2b06169a8248a514dfa280');
  assert.match(lock.platforms['macos-arm64'].binarySha256, /^[0-9a-f]{64}$/);
});

test('platformKey', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'macos-arm64');
  assert.equal(platformKey('win32', 'x64'), 'windows-x64');
  assert.equal(platformKey('linux', 'x64'), 'linux-x64');
});

test('没设 RAEA_BIN / 文件不存在 → exit 3，提示下一步', async () => {
  await assert.rejects(resolveRuntime({ env: {}, lock: lockWith(null) }), e => e.exitCode === EXIT.ENV && e.code === 'no-runtime' && /fetch --accept-license/.test(e.hint));
  await assert.rejects(resolveRuntime({ env: { RAEA_BIN: '/no/such/raea' }, lock: lockWith(null) }), e => e.exitCode === EXIT.ENV && e.code === 'bad-runtime');
});

test('相对路径的 RAEA_BIN 按调用者当前目录解析成绝对路径（R03）', async () => {
  const f = fakeRuntime();
  try {
    const r = await resolveRuntime({ env: { RAEA_BIN: join('raea', 'bin', process.platform === 'win32' ? 'raea.exe' : 'raea') }, cwd: f.dir, lock: lockWith(f.sha) });
    assert.equal(r.exe, f.exe);
    assert.equal(r.verified, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('哈希：未锁定的平台记为 unlocked；与锁不符 → exit 3', async () => {
  const f = fakeRuntime();
  try {
    assert.equal((await resolveRuntime({ env: { RAEA_BIN: f.exe }, lock: lockWith(null) })).verified, 'unlocked');
    await assert.rejects(resolveRuntime({ env: { RAEA_BIN: f.exe }, lock: lockWith('0'.repeat(64)) }), e => e.exitCode === EXIT.ENV && e.code === 'runtime-hash');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('版本：不符 → exit 3；BNE_ALLOW_VERSION 显式放行时记为 allowed、不核对哈希', async () => {
  const f = fakeRuntime('0.2.0');
  try {
    await assert.rejects(resolveRuntime({ env: { RAEA_BIN: f.exe }, lock: lockWith(f.sha) }), e => e.exitCode === EXIT.ENV && e.code === 'runtime-version');
    assert.equal((await resolveRuntime({ env: { RAEA_BIN: f.exe, BNE_ALLOW_VERSION: '0.2.0' }, lock: lockWith('0'.repeat(64)) })).verified, 'allowed');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('命令行：fetch 不接受许可 → exit 2；status 没设 RAEA_BIN → exit 3 且只有一行说明', () => {
  const env = { ...process.env };
  delete env.RAEA_BIN;
  const fetch = spawnSync(process.execPath, [ENTRY, 'fetch', '--json'], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(fetch.status, EXIT.USAGE);
  const j = JSON.parse(fetch.stdout);
  assert.equal(j.error.code, 'license');
  assert.match(j.error.message, /FSL-1\.1-ALv2/);
  const st = spawnSync(process.execPath, [ENTRY, 'status'], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(st.status, EXIT.ENV);
  assert.equal(st.stderr.trim().split('\n').length, 1, st.stderr);
});
