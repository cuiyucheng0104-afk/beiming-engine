// 离屏出片 · WP1.3 着色器管线磁盘缓存（load.mjs 的 configureShaderCacheEnv）：纯函数与真 GPU 往返验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureShaderCacheEnv } from '../../engine/offscreen/load.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'engine/offscreen/cli.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'beiming-shader-cache-'));

test('默认把 NVIDIA / Mesa 驱动着色器缓存规范到 <root>/.cache/offscreen-shader-cache 并创建目录', () => {
  const dir = tmp();
  try {
    const env = {};
    const res = configureShaderCacheEnv(env, { root: dir });
    assert.equal(res.enabled, true);
    assert.equal(env.__GL_SHADER_DISK_CACHE, '1');
    assert.equal(env.__GL_SHADER_DISK_CACHE_SKIP_CLEANUP, '1');
    assert.equal(env.__GL_SHADER_DISK_CACHE_PATH, join(dir, '.cache', 'offscreen-shader-cache', 'nvidia'));
    assert.equal(env.MESA_SHADER_CACHE_DIR, join(dir, '.cache', 'offscreen-shader-cache', 'mesa'));
    assert.equal(existsSync(env.__GL_SHADER_DISK_CACHE_PATH), true);
    assert.equal(existsSync(env.MESA_SHADER_CACHE_DIR), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('尊重用户显式环境变量：BEIMING_SHADER_CACHE=0 关闭；已有路径或禁用标志不覆盖', () => {
  const dir = tmp();
  try {
    const offEnv = { BEIMING_SHADER_CACHE: '0' };
    const offRes = configureShaderCacheEnv(offEnv, { root: dir });
    assert.equal(offRes.enabled, false);
    assert.equal(offEnv.__GL_SHADER_DISK_CACHE_PATH, undefined);
    assert.equal(offEnv.MESA_SHADER_CACHE_DIR, undefined);

    const customEnv = {
      __GL_SHADER_DISK_CACHE: '0',
      MESA_SHADER_CACHE_DISABLE: 'true',
    };
    configureShaderCacheEnv(customEnv, { root: dir });
    assert.equal(customEnv.__GL_SHADER_DISK_CACHE, '0');
    assert.equal(customEnv.__GL_SHADER_DISK_CACHE_PATH, undefined);
    assert.equal(customEnv.MESA_SHADER_CACHE_DIR, undefined);

    const presetEnv = {
      __GL_SHADER_DISK_CACHE_PATH: '/custom/nv',
      MESA_SHADER_CACHE_DIR: '/custom/mesa',
    };
    configureShaderCacheEnv(presetEnv, { root: dir });
    assert.equal(presetEnv.__GL_SHADER_DISK_CACHE_PATH, '/custom/nv');
    assert.equal(presetEnv.MESA_SHADER_CACHE_DIR, '/custom/mesa');

    const customDir = join(dir, 'my-cache');
    const dirEnv = { BEIMING_SHADER_CACHE_DIR: customDir };
    configureShaderCacheEnv(dirEnv, { root: dir });
    assert.equal(dirEnv.__GL_SHADER_DISK_CACHE_PATH, join(customDir, 'nvidia'));
    assert.equal(dirEnv.MESA_SHADER_CACHE_DIR, join(customDir, 'mesa'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('目录不可写（mkdir 抛错）时静默降级，不抛错也不写入无效路径', () => {
  const env = {};
  const res = configureShaderCacheEnv(env, {
    root: '/nonexistent-ro-root',
    mkdir() { const e = new Error('EROFS'); e.code = 'EROFS'; throw e; },
  });
  assert.equal(res.enabled, true);
  assert.equal(env.__GL_SHADER_DISK_CACHE_PATH, undefined);
  assert.equal(env.MESA_SHADER_CACHE_DIR, undefined);
});

const probeGpu = spawnSync(process.execPath, ['--input-type=module', '-e',
  "try { const { loadGpu } = await import('./engine/offscreen/load.mjs'); const { createHost } = await import('./engine/offscreen/host.mjs'); (await createHost({ gpu: await loadGpu(), width: 64, height: 64 })).dispose(); } catch(e) { console.error(e.message); process.exitCode=e.code?.startsWith('env.')?3:1; }"],
{ cwd: ROOT, encoding: 'utf8', timeout: 60000 });
const noGpu = probeGpu.status === 3 && `离屏出片不可用：${probeGpu.stderr.trim()}`;

test('真实 GPU：指定 BEIMING_SHADER_CACHE_DIR 连续两轮出静帧，像素逐字节相同', { skip: noGpu, timeout: 180000 }, () => {
  const dir = tmp();
  const cacheDir = join(dir, 'cache');
  const out1 = join(dir, 's1'), out2 = join(dir, 's2');
  try {
    const cleanEnv = { ...process.env, BEIMING_SHADER_CACHE_DIR: cacheDir };
    delete cleanEnv.__GL_SHADER_DISK_CACHE;
    delete cleanEnv.__GL_SHADER_DISK_CACHE_PATH;
    delete cleanEnv.MESA_SHADER_CACHE_DIR;
    const r1 = spawnSync(process.execPath, [CLI, 'stills', 'lab/offscreen/ink.mjs', '--out', out1, '--frames', '0,3', '--size', '320x180', '--json'], { cwd: ROOT, env: cleanEnv, encoding: 'utf8', timeout: 120000 });
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = spawnSync(process.execPath, [CLI, 'stills', 'lab/offscreen/ink.mjs', '--out', out2, '--frames', '0,3', '--size', '320x180', '--json'], { cwd: ROOT, env: cleanEnv, encoding: 'utf8', timeout: 120000 });
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(JSON.parse(r2.stdout).data.frameHashes, JSON.parse(r1.stdout).data.frameHashes);
    assert.equal(existsSync(join(cacheDir, 'nvidia')), true);
    assert.ok(readdirSync(cacheDir).length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
