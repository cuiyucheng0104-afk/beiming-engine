// WP2.3：作品可选 stateKey 只在 YUV 路径复用相邻重复帧；缺省、null 与 RGBA 零行为变化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFrames } from '../../engine/offscreen/frames.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const collect = async ({ work, format = 'yuv420p', calls }) => {
  const host = {
    async renderFrameYuv(_work, f) { calls?.push(f); return Uint8Array.of(Math.floor(f / 2), 255); },
    async renderFrame(_work, f) { calls?.push(f); return Uint8Array.of(f, 255); },
  };
  const out = [];
  await renderFrames({ host, work, from: 0, to: 6, inflight: 3, format, onFrame: (_f, px) => out.push([...px]) });
  return out;
};

test('stateKey：相同相邻 key 跳过 YUV 渲染，字节与逐帧完整渲染一致', async () => {
  const work = { stateKey: f => String(Math.floor(f / 2)) }, calls = [];
  const reused = await collect({ work, calls });
  const full = await collect({ work: {} });
  assert.deepEqual(calls, [0, 2, 4]);
  assert.deepEqual(reused, full);
});

test('stateKey：null 不缓存、key 改变立即重渲；RGBA 与缺省契约完全走原路径', async () => {
  for (const work of [{}, { stateKey: () => null }, { stateKey: f => String(f) }]) {
    const calls = [];
    await collect({ work, calls });
    assert.deepEqual(calls, [0, 1, 2, 3, 4, 5]);
  }
  const calls = [], work = { stateKey: () => { throw new Error('RGBA 不应读取 stateKey'); } };
  const out = await collect({ work, format: 'rgba', calls });
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(out.map(x => x[0]), [0, 1, 2, 3, 4, 5]);
});

test('真实 GPU + x264：stateKey 复用与逐帧重渲的 YUV、MP4 全部逐字节相同', { timeout: 120000 }, async t => {
  let host, tmp;
  try {
    const { loadGpu } = await import('../../engine/offscreen/load.mjs');
    const { createHost } = await import('../../engine/offscreen/host.mjs');
    const { startEncoder } = await import('../../engine/offscreen/encode.mjs');
    const gpu = await loadGpu();
    host = await createHost({ gpu, width: 64, height: 36 });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-state-key-'));
    const work = await host.load(fileURLToPath(new URL('./fixtures/state-key-work.mjs', import.meta.url)));
    const run = async name => {
      const frames = [];
      const enc = startEncoder({ width: 64, height: 36, fps: 24, out: path.join(tmp, `${name}.mp4`), encoder: 'x264', pixFmt: 'yuv420p' });
      await renderFrames({ host, work, from: 0, to: 6, inflight: 3, format: 'yuv420p', onFrame: async (_f, px) => { frames.push(Buffer.from(px)); await enc.write(px); } });
      await enc.finish();
      return { frames, mp4: fs.readFileSync(path.join(tmp, `${name}.mp4`)) };
    };
    const reused = await run('reused');
    work.stateKey = null;
    const full = await run('full');
    assert.equal(reused.frames.length, full.frames.length);
    for (let f = 0; f < full.frames.length; f++) assert.ok(reused.frames[f].equals(full.frames[f]), `第 ${f} 帧 YUV 逐字节相同`);
    assert.ok(reused.mp4.equals(full.mp4), 'MP4 码流逐字节相同');
  } catch (e) {
    if (String(e.code).startsWith('env.')) return t.skip(`GPU / FFmpeg 不可用：${e.message}`);
    throw e;
  } finally {
    host?.dispose();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
});
