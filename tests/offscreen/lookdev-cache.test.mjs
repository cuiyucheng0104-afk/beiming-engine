// WP5：lookdev 同帧快照跳过 scene 与 ink:ids，换帧失效；缓存结果与完整重渲逐字节相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { createGpuTimer, attachGpuTimer, detachGpuTimer } from '../../engine/offscreen/gputimer.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/look-work.mjs`;
const DEFAULTS = JSON.parse(readFileSync(`${ROOT}engine/style/beiming-original.v1.json`, 'utf8')).lookDefaults.params;
const W = 320, H = 180;

test('lookdev 快照：重复帧 scene/ink:ids 为 0，输出逐字节等于完整重渲；换令牌立即重渲', { timeout: 120000 }, async t => {
  let host;
  try {
    const gpu = await loadGpu();
    globalThis.__LOOK = { defaults: DEFAULTS, p: { t: 0, grade: { exposure: 1.6 } }, ss: 1, msaa: 0 };
    host = await createHost({ gpu, width: W, height: H });
  } catch (e) {
    if (String(e.code).startsWith('env.')) return t.skip(`离屏出片不可用：${e.message}`);
    throw e;
  }
  const work = await host.load(FIXTURE);
  const draw = async (token, exposure) => {
    globalThis.__OFFSCREEN_LOOKDEV_CACHE = token;
    globalThis.__LOOKDEV = { grade: { exposure } };
    const timer = createGpuTimer(host.device);
    attachGpuTimer(host.renderer, timer); timer.mark('pre');
    const pending = host.renderFrame(work, 0); timer.end();
    const px = Buffer.from(await pending);
    detachGpuTimer(host.renderer);
    const timing = await timer.read(); timer.dispose();
    return { px, spans: Object.fromEntries(timing.spans.map(s => [s.label, s.ms])) };
  };
  try {
    await draw(null, 1.6);   // 预热与着色器编译
    const full = await draw(null, 1.9);
    await draw(42, 1.3);     // 建立快照
    const cached = await draw(42, 1.9);
    assert.ok(cached.px.equals(full.px), '后期改参后的缓存帧与完整重渲逐字节相同');
    assert.equal(cached.spans.scene, 0, 'scene GPU 耗时为 0');
    assert.equal(cached.spans['ink:ids'], 0, 'ink:ids GPU 耗时为 0');
    const next = await draw(43, 1.9);
    assert.ok(next.px.equals(full.px), '换帧后完整重渲仍逐字节相同');
    assert.ok(next.spans.scene > 0, '换令牌后 scene 必须重渲');
    assert.ok(next.spans['ink:ids'] > 0, '换令牌后 ink:ids 必须重渲');
  } finally {
    globalThis.__LOOK = undefined; globalThis.__LOOKDEV = null; globalThis.__OFFSCREEN_LOOKDEV_CACHE = null;
    detachGpuTimer(host.renderer); host.dispose();
  }
});
