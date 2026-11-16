// 独立审查回归：在途拒绝必须可清理、GPU 错误不得成功、无适配器退出 3、预览不得跨源导入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHost } from '../../engine/offscreen/host.mjs';
import * as preview from '../../engine/offscreen/preview.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = (script, args, env) => spawnSync(process.execPath, [join(ROOT, script), ...args, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } });

test('后续读回先拒绝、前帧回调等待：由调用者接住，不产生未处理拒绝', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { renderFrames } from './engine/offscreen/frames.mjs';
    const host = { renderFrame(_, f) { return f === 2 ? Promise.reject(new Error('readback failed')) : Promise.resolve(new Uint8Array(4)); } };
    try { await renderFrames({host,work:{},from:0,to:4,inflight:3,onFrame:()=>new Promise(r=>setTimeout(r,20))}); process.exitCode=2; }
    catch(e) { if(e.message!=='readback failed')throw e; console.log('caught'); }
  `], { cwd: ROOT, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /caught/);
  assert.doesNotMatch(r.stderr, /unhandledRejection|PromiseRejectionHandledWarning/);
});

test('无适配器：createHost 报 env.webgpu-unavailable，不回退到没有画布的 WebGL', async t => {
  const { loadGpu } = await import('../../engine/offscreen/load.mjs');
  let gpu;
  try { gpu = await loadGpu(); }
  catch (e) { if (e.code === 'env.offscreen-deps') return t.skip(e.message); throw e; }
  const prev = navigator.gpu;
  Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => null }, configurable: true });
  try {
    await assert.rejects(createHost({ gpu, width: 64, height: 64 }), e => e.code === 'env.webgpu-unavailable');
  } finally { Object.defineProperty(navigator, 'gpu', { value: prev, configurable: true }); }
});

test('预览 URL 规范化后仍必须同源：拒绝协议相对、反斜杠和绝对外站 URL', () => {
  assert.equal(typeof preview.resolvePreviewWork, 'function');
  const base = 'http://127.0.0.1:8080/lab/offscreen/index.html';
  for (const s of ['//other.invalid/x.mjs', '/\\other.invalid/x.mjs', 'https://other.invalid/x.mjs']) {
    assert.throws(() => preview.resolvePreviewWork(s, base), /同源/);
  }
  assert.equal(preview.resolvePreviewWork('/lab/offscreen/ink.mjs', base), 'http://127.0.0.1:8080/lab/offscreen/ink.mjs');
});

// CI 的 windows-paths 任务不装 FFmpeg、也不装浏览器：环境缺失要报 env.*（退出 3，测试据此跳过），不能报内部错误。
test('没有 FFmpeg：offscreen render 报 env.ffmpeg 退出 3，不是 failure.internal', t => {
  const out = join(tmpdir(), `beiming-offscreen-noff-${process.pid}.mp4`);
  const r = run('engine/offscreen/cli.mjs', ['render', 'lab/offscreen/ink.mjs', '--frames', '0:1', '--size', '64x64', '--out', out], { FFMPEG: '/nonexistent/ffmpeg' });
  const e = JSON.parse(r.stdout);
  if (r.status === 3 && e.error.code !== 'env.ffmpeg') return t.skip(`离屏出片不可用：${e.error.message}`);
  assert.equal(r.status, 3, r.stderr);
  assert.equal(e.error.code, 'env.ffmpeg');
});

test('没有无头浏览器：offscreen-compare 报 env.browser 退出 3，不是 failure.internal', t => {
  const r = run('tools/offscreen/compare.mjs', ['lab/offscreen/ink.mjs', '--frames', '0', '--size', '64x64'], { PLAYWRIGHT_BROWSERS_PATH: '/nonexistent', BEIMING_CHROME: '' });
  const e = JSON.parse(r.stdout);
  if (r.status === 3 && e.error.code !== 'env.browser') return t.skip(`离屏对拍不可用：${e.error.message}`);
  assert.equal(r.status, 3, r.stderr);
  assert.equal(e.error.code, 'env.browser');
});
