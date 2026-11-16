// 离屏出片 · 出片宿主与流水线读回（engine/offscreen/{load,host,frames}.mjs）：真的在 Node + Dawn 里渲演示作品 lab/offscreen/ink.mjs。
// 没装可选依赖（webgpu、three-webgpu）或拿不到 GPU 适配器时整组跳过，跳过原因写在用例名后面。
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { renderFrames } from '../../engine/offscreen/frames.mjs';

const W = 320, H = 180, WORK = fileURLToPath(new URL('../../lab/offscreen/ink.mjs', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 16);
let gpu = null, why = null;
before(async () => {
  try { gpu = await loadGpu(); (await createHost({ gpu, width: 64, height: 64 })).dispose(); } catch (e) { why = String(e?.message ?? e).split('\n')[0]; }
});
const skipped = () => `离屏出片不可用：${why}`;
const fresh = async () => { const host = await createHost({ gpu, width: W, height: H }); return { host, work: await host.load(WORK) }; };

test('同一帧渲两次逐字节相同；尺寸是 RGBA8', async t => {
  if (why) return t.skip(skipped());
  const { host, work } = await fresh();
  const a = Buffer.from(await host.renderFrame(work, 7)), b = Buffer.from(await host.renderFrame(work, 7));
  assert.equal(a.length, W * H * 4);
  assert.ok(a.equals(b));
  host.dispose();
});

test('随机访问：只渲第 30 帧 = 从第 0 帧顺序渲到 30 的第 30 帧', async t => {
  if (why) return t.skip(skipped());
  const one = await fresh(), seq = await fresh();
  const direct = Buffer.from(await one.host.renderFrame(one.work, 30));
  let last;
  for (let f = 0; f <= 30; f++) last = Buffer.from(await seq.host.renderFrame(seq.work, f));
  assert.ok(direct.equals(last));
  one.host.dispose(); seq.host.dispose();
});

test('流水线读回：在途 1 帧与 3 帧，输出逐字节相同，且各帧互不相同', async t => {
  if (why) return t.skip(skipped());
  const run = async inflight => {
    const { host, work } = await fresh(), h = [];
    await renderFrames({ host, work, from: 0, to: 12, inflight, onFrame: (f, px) => { h[f] = sha(px); } });
    host.dispose();
    return h;
  };
  const a = await run(1), b = await run(3);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 12);   // 作品在转、纸纹一拍二沸腾：12 帧互不相同
});

test('renderFrames 按帧号顺序回调，onFrame 返回的 Promise 会被等待', async t => {
  if (why) return t.skip(skipped());
  const { host, work } = await fresh(), order = [];
  let busy = false;
  await renderFrames({ host, work, from: 2, to: 8, inflight: 3, onFrame: async f => {
    assert.equal(busy, false, '上一帧的 onFrame 还没结束就调了下一帧');
    busy = true; await new Promise(r => setTimeout(r, 5)); order.push(f); busy = false;
  } });
  assert.deepEqual(order, [2, 3, 4, 5, 6, 7]);
  host.dispose();
});

test('renderFrames：inflight 不是 ≥ 1 的数抛 RangeError（不需要 GPU）', async () => {
  await assert.rejects(renderFrames({ host: null, work: null, from: 0, to: 1, inflight: 0, onFrame() {} }), RangeError);
});
