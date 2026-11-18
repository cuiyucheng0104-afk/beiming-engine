// M7 T2 测试：同源真实作品（films/chendu/offscreen.mjs）在 Chrome WebGPU 与 Node + Dawn 对拍，
// 以及 WebGPU 交互式预览工作台（film.json 自动探测、零读回 present 色彩对齐、切镜定位与调试视图切换）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../engine/render/lib/server.mjs';
import { chromeArgs, chromeExecutable, defaultAngle } from '../../engine/render/lib/gpu.mjs';
import { WEBGPU_ARGS } from '../../tools/offscreen/compare.mjs';
import { extractWorkQuery } from '../../engine/offscreen/preview.js';
import { diffRgba } from '../../engine/offscreen/diff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('extractWorkQuery：过滤宿主自身参数，合并 &q= 与透传查询参数', () => {
  const q = extractWorkQuery('?work=/films/chendu/offscreen.mjs&size=960x540&fps=24&f=72&api=1&q=msaa%3D0%26animatic%3D1&notext=1');
  assert.equal(q.has('work'), false);
  assert.equal(q.has('size'), false);
  assert.equal(q.has('api'), false);
  assert.equal(q.get('msaa'), '0');
  assert.equal(q.get('animatic'), '1');
  assert.equal(q.get('notext'), '1');
});

test('真实多镜头作品 films/chendu/offscreen.mjs：Chrome WebGPU 与 Node + Dawn 同源对拍过门', { timeout: 200000 }, t => {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, 'tools/offscreen/compare.mjs'), 'films/chendu/offscreen.mjs', '--frames', '0,72', '--size', '480x270', '--query', 'msaa=0&notext=1', '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 180000 },
  );
  const env = JSON.parse(r.stdout);
  if (r.status === 3) return t.skip(`浏览器 WebGPU 不可用：${env.error?.message}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(env.ok, true);
  assert.equal(env.data.frames.length, 2);
  for (const fr of env.data.frames) {
    assert.equal(fr.ok, true, JSON.stringify(fr));
    assert.ok(fr.psnr === null || fr.psnr >= 50, JSON.stringify(fr));
  }
});

test('WebGPU 审片工作台：自动读 film.json、零读回 present 色彩与 renderFrame 对齐、支持跳帧与调试视图', { timeout: 200000 }, async t => {
  const srv = createServer({ root: ROOT });
  const { url } = await srv.listen(0);
  let browser = null;
  try {
    const { chromium } = await import('playwright-core');
    try {
      browser = await chromium.launch({ executablePath: chromeExecutable(), args: [...chromeArgs(defaultAngle()), ...WEBGPU_ARGS] });
    } catch (e) {
      if (/Executable doesn't exist|browserType\.launch/i.test(String(e?.message ?? e))) {
        return t.skip(`无头浏览器不可用：${String(e?.message ?? e).split('\n')[0]}`);
      }
      throw e;
    }
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e?.message ?? e)));
    await page.goto(`${url}lab/offscreen/index.html?work=/films/chendu/offscreen.mjs&size=320x180&f=72&msaa=0`);
    await page.waitForFunction(() => window.READY === true, null, { timeout: 60000 });
    const previewErr = (await page.evaluate(() => window.PREVIEW_ERROR ?? null)) ?? pageErrors[0] ?? null;
    if (previewErr && /WebGPU|adapter/i.test(previewErr)) {
      return t.skip(`WebGPU 适配器不可用：${previewErr}`);
    }
    assert.equal(previewErr, null);

    // 1. 验证自动探测 film.json（片名、2 个镜头、2 个声画事件）
    const info = await page.evaluate(() => ({
      title: window.previewPlayer.filmMeta?.title,
      shots: window.previewPlayer.shots.length,
      events: window.previewPlayer.events.length,
      frame: window.previewPlayer.getFrame(),
      playing: window.previewPlayer.isPlaying(),
    }));
    assert.equal(info.title, '晨渡');
    assert.equal(info.shots, 2);
    assert.equal(info.events, 2);
    assert.equal(info.frame, 72);
    assert.equal(info.playing, false);

    // 2. 校验显示画布 viewCtx 像素与 renderFrame() sRGB 目标逐字节一致（零 Linux Vulkan OpaqueFD 交换链异常）
    const { shownB64, readbackB64 } = await page.evaluate(async () => {
      const { host, work, viewCtx } = window.previewPlayer;
      const shown = new Uint8Array(viewCtx.getImageData(0, 0, 320, 180).data.buffer);
      const px = await host.renderFrame(work, 72);
      return { shownB64: shown.toBase64(), readbackB64: px.toBase64() };
    });
    const presentPx = new Uint8Array(Buffer.from(shownB64, 'base64'));
    const readbackPx = new Uint8Array(Buffer.from(readbackB64, 'base64'));
    const colorDiff = diffRgba(presentPx, readbackPx, { width: 320, height: 180 });
    assert.equal(colorDiff.identical, true, `工作台显示画布应与 renderFrame 逐字节一致：${JSON.stringify(colorDiff)}`);

    // 3. 验证跳帧与切换后期调试视图（line 墨线遮罩）改变画面
    const dbgB64 = await page.evaluate(async () => {
      await window.previewPlayer.seek(96);
      await window.previewPlayer.setDebugView('line');
      const d = window.previewPlayer.viewCtx.getImageData(0, 0, 320, 180).data;
      return new Uint8Array(d.buffer).toBase64();
    });
    const dbgPx = new Uint8Array(Buffer.from(dbgB64, 'base64'));
    const viewDiff = diffRgba(presentPx, dbgPx, { width: 320, height: 180 });
    assert.equal(viewDiff.identical, false);
    assert.ok(viewDiff.differPixels > 1000, '切换到墨线调试视图并跳到第 96 帧后画面应明显变化');
  } finally {
    await browser?.close().catch(() => {});
    await srv.close();
  }
});
