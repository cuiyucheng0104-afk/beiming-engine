import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveServed, startServer } from './host.mjs';
import { clipStats, lumaStats, measureEntity, toScreen } from './measure.js';

// 相机在原点看向 −Z，竖直视场角 90 度，画面 200 × 100：投影矩阵第 6 个数是 1，第 1 个数是 高 ÷ 宽
const VIEW = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PROJ = [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.002002, -1, 0, 0, -0.2002002, 0];
const SIZE = [200, 100];

test('投到屏幕：原点在左上角，y 向下，深度是沿 −Z 的分量', () => {
  assert.deepEqual(toScreen(VIEW, PROJ, SIZE, [0, 0, -5]), { screen: [100, 50], depth: 5, w: 5 });
  const up = toScreen(VIEW, PROJ, SIZE, [0, 5, -5]);
  assert.ok(Math.abs(up.screen[1]) < 1e-9 && up.screen[0] === 100);
  const right = toScreen(VIEW, PROJ, SIZE, [2.5, 0, -5]);
  assert.ok(Math.abs(right.screen[0] - 125) < 1e-9);
  // 相机往 +X 挪 1 米（view 是相机矩阵的逆，平移是 −1），世界原点前方的点往左偏
  const moved = [...VIEW]; moved[12] = -1;
  assert.ok(toScreen(moved, PROJ, SIZE, [0, 0, -5]).screen[0] < 100);
});

test('实体的包围盒、屏占和平面深度范围', () => {
  const m = measureEntity(VIEW, PROJ, SIZE, [[-1, -1, -4], [1, 1, -4], [-1, 1, -6], [1, -1, -6]]);
  assert.deepEqual(m.bbox3d, [-1, -1, -6, 1, 1, -4]);
  assert.deepEqual(m.depth, [4, 6]);
  assert.deepEqual(m.bbox2d.map((v) => Math.round(v * 1e6) / 1e6), [87.5, 37.5, 112.5, 62.5]);
  assert.ok(Math.abs(m.pxArea - (25 * 25) / (200 * 100)) < 1e-12);
  // 一半在画面外：屏占只算画面里的那部分
  const half = measureEntity(VIEW, PROJ, SIZE, [[-20, -1, -5], [0, 1, -5]]);
  assert.ok(Math.abs(half.pxArea - (100 * 20) / (200 * 100)) < 1e-12);
});

test('画面统计：Rec.709 亮度的百分位；溢出和压死按通道判', () => {
  const px = new Float32Array(100 * 4);
  for (let i = 0; i < 100; i++) px.set(i < 90 ? [0, 0, 0, 1] : i < 99 ? [0.5, 0.5, 0.5, 1] : [50, 50, 50, 1], i * 4);
  const s = lumaStats(px);
  assert.deepEqual(Object.keys(s), ['p1', 'p50', 'p99']);
  assert.deepEqual([s.p1, s.p50], [0, 0]);
  assert.ok(Math.abs(s.p99 - 0.5) < 1e-6);
  assert.ok(Math.abs(lumaStats(new Float32Array([0, 1, 0, 1])).p50 - 0.7152) < 1e-6);
  assert.deepEqual(clipStats(px), { clipHigh: 0.01, clipLow: 0.9 });
  // 只有一个通道到 1 也算溢出；有一个通道大于 0 就不算压死
  assert.deepEqual(clipStats(new Float32Array([1, 0, 0, 1, 0, 0.001, 0, 1])), { clipHigh: 0.5, clipLow: 0 });
});

test('静态服务只放行本系统的代码、three 和锁定的字体（含 routes/c-style/fonts 的分片与清单），跳不出去', () => {
  assert.match(resolveServed('/beiming/host/page/runtime.js'), /beiming[\\/]host[\\/]page[\\/]runtime\.js$/);
  assert.match(resolveServed('/node_modules/three-webgpu/build/three.module.js?x=1'), /three\.module\.js$/);
  assert.match(resolveServed('/routes/c-style/fonts/fonts.json'), /routes[\\/]c-style[\\/]fonts[\\/]fonts\.json$/);
  assert.match(resolveServed('/routes/c-style/fonts/mashanzheng-00.woff2'), /routes[\\/]c-style[\\/]fonts[\\/]mashanzheng-00\.woff2$/);
  for (const bad of [
    '/package.json', '/beiming/../package.json', '/beiming/%2e%2e/%2e%2e/etc/passwd', '/engine/render/lib/gpu.mjs', '/beiming/README.md', '/%zz',
    '/routes/c-style/fonts/OFL.txt', '/routes/c-style/fonts/fetch.mjs', '/routes/c-style/fonts/README.md', '/routes/c-style/fonts/../fonts.json',
  ]) {
    assert.equal(resolveServed(bad), null, bad);
  }
});

test('静态服务照真实路径再判一遍：放行目录里的符号链接指到目录外面的、文件不存在的都是 404', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'fonts'));
  await mkdir(join(root, 'routes/c-style/fonts'), { recursive: true });
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'fonts/ok.woff2'), 'ok');
  await writeFile(join(root, 'routes/c-style/fonts/mashanzheng-00.woff2'), 'shard0');
  await writeFile(join(root, 'routes/c-style/fonts/fonts.json'), '{"ok":true}');
  await writeFile(join(root, 'routes/c-style/fonts/OFL.txt'), 'ofl');
  await writeFile(join(root, 'outside/secret.woff2'), 'secret');
  await writeFile(join(root, 'outside/secret.json'), '{"secret":true}');
  await writeFile(join(root, 'fonts/notes.md'), 'notes');
  try {
    await symlink(join(root, 'outside/secret.woff2'), join(root, 'fonts/leak.woff2'));
    await symlink(join(root, 'outside'), join(root, 'fonts/dir'));
    await symlink(join(root, 'fonts/ok.woff2'), join(root, 'fonts/alias.woff2'));
    await symlink(join(root, 'fonts/notes.md'), join(root, 'fonts/notes.woff2'));
    await symlink(join(root, 'outside/secret.woff2'), join(root, 'routes/c-style/fonts/leak.woff2'));
    await symlink(join(root, 'routes/c-style/fonts/OFL.txt'), join(root, 'routes/c-style/fonts/ofl.woff2'));
  } catch (e) {
    t.skip(`这台机器建不了符号链接：${e.code}`);
    return;
  }
  // 链接指到放行目录里面的同类文件照常给，交回的是真实路径
  const ok = await realpath(join(root, 'fonts/ok.woff2'));
  const shardOk = await realpath(join(root, 'routes/c-style/fonts/mashanzheng-00.woff2'));
  const jsonOk = await realpath(join(root, 'routes/c-style/fonts/fonts.json'));
  assert.deepEqual([resolveServed('/fonts/ok.woff2', root), resolveServed('/fonts/alias.woff2', root)], [ok, ok]);
  assert.deepEqual([resolveServed('/routes/c-style/fonts/mashanzheng-00.woff2', root), resolveServed('/routes/c-style/fonts/fonts.json', root)], [shardOk, jsonOk]);
  const bad = [
    '/fonts/leak.woff2', '/fonts/dir/secret.woff2', '/fonts/notes.woff2', '/fonts/none.woff2',
    '/routes/c-style/fonts/leak.woff2', '/routes/c-style/fonts/ofl.woff2', '/routes/c-style/fonts/OFL.txt', '/routes/c-style/fonts/other.json',
  ];
  for (const url of bad) assert.equal(resolveServed(url, root), null, url);

  const server = await startServer(root);
  t.after(() => server.close());
  const get = async (url) => { const res = await fetch(server.origin + url); return [res.status, await res.text()]; };
  assert.deepEqual(await get('/fonts/alias.woff2'), [200, 'ok']);
  for (const url of bad) assert.deepEqual(await get(url), [404, ''], url);
});
