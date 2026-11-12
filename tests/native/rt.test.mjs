// 光追外部后端适配器（engine/native/rt.mjs）：用假的可执行文件核对版本 / 哈希 / 缺失的退出码；锁文件字段；
// 场景与命令行参数的纯函数输出；分层产物校验（临时目录里造小文件）。不要显卡、不要真渲染器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildScene, loadLock, readLayers, renderArgs, resolveRt } from '../../engine/native/rt.mjs';
import { platformKey } from '../../engine/native/runtime.mjs';
import { EXIT } from '../../engine/native/cli.mjs';

const ENTRY = fileURLToPath(new URL('../../engine/native/rt.mjs', import.meta.url));
const isWin = process.platform === 'win32';

function fakeRt(version = '0.5.1') {
  const dir = mkdtempSync(join(tmpdir(), 'bne-rt-test-'));
  const exe = join(dir, isWin ? 'rt.cmd' : 'rt');
  writeFileSync(exe, isWin ? `@echo ${version} (commit abc; API v2)\r\n` : `#!/bin/sh\necho "${version} (commit abc; API v2)"\n`);
  chmodSync(exe, 0o755);
  return { dir, exe, sha: createHash('sha256').update(readFileSync(exe)).digest('hex') };
}
const lockWith = binarySha256 => ({ version: '0.5.1', platforms: { [platformKey()]: { binarySha256 } } });
const cleanup = d => rmSync(d, { recursive: true, force: true });

test('锁文件：字段齐全，三个平台归档哈希都在，许可与边界已写', async () => {
  const lock = await loadLock();
  for (const k of ['$note', 'upstream', 'version', 'tag', 'sourceCommit', 'license', 'licenseUrl', 'releaseUrl', 'downloadBase', 'usageBoundary', 'platforms']) assert.ok(lock[k], k);
  assert.equal(lock.version, '0.5.1');
  assert.equal(lock.license, 'LicenseRef-vork-Preview');
  assert.match(lock.usageBoundary, /内部制作层/);
  for (const k of ['macos-arm64', 'windows-x64', 'linux-x64']) {
    const e = lock.platforms[k];
    assert.match(e.sha256, /^[0-9a-f]{64}$/, k);
    assert.ok(e.archive && e.binary && 'binarySha256' in e && e.verified, k);
    assert.equal(e.binarySha256, null, `${k} 的可执行文件哈希尚未计算，锁里应为 null`);
  }
  assert.equal(lock.platforms['windows-x64'].binary, 'vork.exe');
});

test('没设 BNE_RT_BIN / 文件缺失 → exit 3', async () => {
  await assert.rejects(resolveRt({ env: {}, lock: lockWith(null) }), e => e.exitCode === EXIT.ENV && e.code === 'env.no-rt');
  await assert.rejects(resolveRt({ env: { BNE_RT_BIN: join(tmpdir(), 'no-such-rt') }, lock: lockWith(null) }), e => e.exitCode === EXIT.ENV && e.code === 'env.bad-rt');
});

test('版本对得上：哈希 null 记 unlocked，哈希一致记 true，哈希不符 → exit 3', async () => {
  const f = fakeRt();
  try {
    const r = await resolveRt({ env: { BNE_RT_BIN: f.exe }, lock: lockWith(null) });
    assert.equal(r.version, '0.5.1');
    assert.equal(r.verified, 'unlocked');
    assert.equal((await resolveRt({ env: { BNE_RT_BIN: f.exe }, lock: lockWith(f.sha) })).verified, true);
    await assert.rejects(resolveRt({ env: { BNE_RT_BIN: f.exe }, lock: lockWith('0'.repeat(64)) }), e => e.exitCode === EXIT.ENV && e.code === 'env.rt-hash');
  } finally { cleanup(f.dir); }
});

test('版本对不上 → exit 3；BNE_ALLOW_VERSION 显式放行记 allowed', async () => {
  const f = fakeRt('0.6.0');
  try {
    await assert.rejects(resolveRt({ env: { BNE_RT_BIN: f.exe }, lock: lockWith(null) }), e => e.exitCode === EXIT.ENV && e.code === 'env.rt-version' && /0\.5\.1/.test(e.message));
    assert.equal((await resolveRt({ env: { BNE_RT_BIN: f.exe, BNE_ALLOW_VERSION: '0.6.0' }, lock: lockWith(null) })).verified, 'allowed');
  } finally { cleanup(f.dir); }
});

test('命令行：status 没设 BNE_RT_BIN → exit 3，一行原因加一行下一步', () => {
  const env = { ...process.env };
  delete env.BNE_RT_BIN;
  const r = spawnSync(process.execPath, [ENTRY, 'status'], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(r.status, EXIT.ENV);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 2, r.stderr);
  assert.match(lines[0], /^错误\[env\.no-rt\]/);
  assert.match(lines[1], /^提示：/);
});

test('buildScene：节点类型、相机、分辨率、曝光', () => {
  const s = buildScene({ model: 'kun.glb' });
  assert.equal(s.version, 2);
  assert.deepEqual(s.nodes.map(n => n.type), ['asset', 'light', 'light', 'camera']);
  assert.equal(s.nodes[0].file, 'kun.glb');
  assert.deepEqual(s.nodes.filter(n => n.type === 'light').map(n => n.shape), ['environment', 'sun']);
  assert.deepEqual(s.nodes[3].translation, [17, 5, 40]);
  assert.deepEqual(s.nodes[3].target, [0, 1.5, 0]);
  assert.deepEqual(s.render.resolution, [1920, 1040]);
  assert.equal(s.render.display.inputs.exposure, -1.7);
  const c = buildScene({ model: 'a.glb', camera: { translation: [1, 2, 3] }, resolution: [640, 360], exposure: 0 });
  assert.deepEqual(c.nodes[3].translation, [1, 2, 3]);
  assert.deepEqual(c.nodes[3].target, [0, 1.5, 0]);
  assert.deepEqual(c.render.resolution, [640, 360]);
  assert.throws(() => buildScene({}), e => e.exitCode === EXIT.USAGE);
});

test('renderArgs：--at 与 --frames 两种 argv 逐项相等', () => {
  assert.deepEqual(renderArgs({ scene: 's.json', out: 'o/', at: 0 }), ['render', 's.json', '--profile', 'std/final', '--at', '0', '--out', 'o/', '--channels', 'color,depth,object_index,view_normal', '--set', 'seed=42', '--diagnostics']);
  assert.deepEqual(renderArgs({ scene: 's.json', out: 'o/', frames: [0, 23], seed: 7, resolution: '1280x720' }),
    ['render', 's.json', '--profile', 'std/final', '--frame-start', '0', '--frame-end', '23', '--out', 'o/', '--channels', 'color,depth,object_index,view_normal', '--set', 'seed=7', '--set', 'resolution=1280x720', '--diagnostics']);
});

function layersDir({ skipDepth = false, frames = [{ index: 0, depth_unit_m: 0.015 }] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bne-rt-layers-'));
  for (const f of ['000000.png', '000000.depth.png', '000000.object_index.png', '000000.view_normal.png']) if (!(skipDepth && f.includes('depth'))) writeFileSync(join(dir, f), 'x');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ frames, object_ids: [{ pass_index: 1, gltf_node_name: 'body' }] }));
  return dir;
}

test('readLayers：齐全 → 路径与元数据；缺 depth → 报清缺哪个；meta 缺帧 → 报错', async () => {
  const ok = layersDir(), noDepth = layersDir({ skipDepth: true }), noFrame = layersDir({ frames: [{ index: 3, depth_unit_m: 0.015 }] });
  try {
    const r = await readLayers(ok, 0);
    assert.equal(r.depthUnit, 0.015);
    assert.equal(r.objectIds.length, 1);
    assert.equal(r.files.depth, join(ok, '000000.depth.png'));
    await assert.rejects(readLayers(noDepth, 0), e => e.exitCode === EXIT.CONTRACT && e.code === 'contract.layers-missing' && /000000\.depth\.png/.test(e.message) && !/object_index/.test(e.message));
    await assert.rejects(readLayers(noFrame, 0), e => e.exitCode === EXIT.CONTRACT && e.code === 'contract.meta-frame');
  } finally { [ok, noDepth, noFrame].forEach(cleanup); }
});
