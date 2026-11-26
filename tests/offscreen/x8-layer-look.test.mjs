import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { deliver, PIECES, probeMedia, runTool, tools, verifyDeliveryBundle } from '../../beiming/comp/index.mjs';
import { composeLayerLookFilm } from '../../beiming/comp/layer-look.mjs';

import { eventsTable } from '../../beiming/kernel/eval/index.mjs';
import { decodePng, encodePng } from '../../beiming/observe/sheet.mjs';
import { chromeArgs } from '../../engine/render/lib/gpu.mjs';
import { createServer } from '../../engine/render/lib/server.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLE = 'tests/offscreen/fixtures/x8-layer-look';
const fixture = (name) => join(ROOT, SAMPLE, name);
const json = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function usableMediaTools() {
  try {
    const { ffmpeg, ffprobe } = tools();
    return [ffmpeg, ffprobe].every((bin) => spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 15000 }).status === 0);
  } catch (error) {
    if (error?.code !== 'env.ffmpeg-missing') throw error;
    return false;
  }
}

async function renderInPage(browser, url, frame) {
  const page = await browser.newPage();
  try {
    await page.goto(url + SAMPLE + '/frame.html');
    await page.waitForFunction(() => typeof window.renderX8Sample === 'function', null, { timeout: 10000 });
    const req = frame && {
      ...frame,
      layers: Object.fromEntries(Object.entries(frame.layers).map(([name, bytes]) => [name, bytes.toString('base64')])),
    };
    const { backend, pixels } = await page.evaluate((input) => window.renderX8Sample(input), req);
    return { backend, rgb: Buffer.from(pixels, 'base64') };
  } finally {
    await page.close();
  }
}

function deliveryFixture(root, size, depthUnitM) {
  const film = json('beiming/kernel/contracts/film/examples/minimal.json');
  const lock = json('beiming/kernel/contracts/lock/examples/minimal.json');
  const shot = { ...film.shots[0], colorRef: 'display' };
  film.output = { size, fps: '24/1', frames: 3 };
  film.shots = [{ ...shot, id: 'other', in: 0, out: 2, seed: 120 }, { ...shot, in: 2, out: 3 }];
  film.transitions = [{ id: 'cut-2', at: 2, type: 'cut' }];
  film.delivery = { ...film.delivery, web: true, contact: true };
  lock.seeds.other = 120;
  lock.shots.other = { shutterSamples: 1 };
  const [width, height] = size;
  for (const [i, value] of [[0, 48], [1, 128]]) {
    const rgb = Buffer.alloc(width * height * 3, value);
    writeFileSync(join(root, `other-${i}.png`), encodePng({ width, height, rgb }));
  }
  copyFileSync(fixture('000000.png'), join(root, 'source-7.png'));
  const frames = {
    other: { pattern: join(root, 'other-%01d.png') },
    s01: {
      pattern: join(root, 'source-%01d.png'), start: 7, kind: 'png', transfer: 'srgb',
      auxiliaryLayers: {
        depthUnitM,
        depth: [fixture('000000.depth.png')],
        objectId: [fixture('000000.object_index.png')],
        normal: [fixture('000000.view_normal.png')],
      },
    },
  };
  return { film, lock, events: eventsTable(film), frames };
}

function meanDelta(a, b) {
  assert.equal(a.length, b.length);
  return a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
}

function decodedMaster(bundle) {
  return runTool(tools().ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', join(bundle.dir, PIECES.master),
    '-threads:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout;
}

test('X8 真机 SwiftShader 重渲入库像素并通过新 comp 入口交付硬切六件套', { timeout: 120_000 }, async (t) => {
  const requireRender = process.env.BEIMING_X8_REQUIRE_RENDER === '1';
  if (!usableMediaTools()) {
    if (requireRender) assert.fail('X8 真渲染需要 FFmpeg 和 ffprobe');
    return t.skip('环境缺少 FFmpeg 或 ffprobe');
  }
  const server = createServer({ root: ROOT });
  const { url } = await server.listen();
  t.after(() => server.close());
  let browser;
  try {
    browser = await chromium.launch({ args: [...chromeArgs('swiftshader'), '--enable-unsafe-swiftshader'] });
  } catch (error) {
    if (!requireRender && /Executable doesn't exist/.test(error.message)) return t.skip('本机未装 Playwright Chrome Headless Shell');
    throw error;
  }
  t.after(() => browser.close());

  const golden = json(SAMPLE + '/golden.json');
  const config = json(SAMPLE + '/meta.json');
  const { rgb: reference, width, height } = decodePng(readFileSync(fixture('golden.png')));
  assert.deepEqual([width, height], golden.size);
  assert.equal(golden.pixelFormat, 'rgb24');
  assert.equal(sha256(reference), golden.sha256);
  const first = await renderInPage(browser, url);
  const second = await renderInPage(browser, url);
  assert.match(first.backend, /SwiftShader/i);
  assert.deepEqual(second, first);
  const platform = { platform: process.platform, arch: process.arch, browser: browser.version(), backend: first.backend };
  const canonical = Object.entries(platform).every(([key, value]) => golden[key] === value);
  const hash = sha256(first.rgb);
  if (canonical) assert.equal(hash, golden.sha256);
  else assert.ok(meanDelta(first.rgb, reference) <= 0.5, '未登记的平台仍要在入库样本的 RGB8 平均误差内');
  t.diagnostic(JSON.stringify({ ...platform, hash, canonical, goldenSha256: golden.sha256 }));

  const root = mkdtempSync(join(tmpdir(), 'beiming-x8-real-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = join(root, 'styled');
  const options = deliveryFixture(root, golden.size, config.frames[0].depth_unit_m);
  const untouched = deliver({ ...options, outDir: join(root, 'untouched') });
  const expectedFiles = Object.values(PIECES).sort();
  const calls = [];
  const styled = await composeLayerLookFilm({
    ...options, outDir,
    layerLook: { shotId: 's01', renderFrame: async (frame) => {
      calls.push([frame.shotId, frame.frame, frame.time]);
      const { rgb } = await renderInPage(browser, url, frame);
      assert.deepEqual(rgb, first.rgb);
      return rgb;
    } },
  });
  assert.deepEqual(calls, [['s01', 0, 0]]);
  assert.ok(readdirSync(root).every((name) => !name.startsWith('.beiming-')));
  assert.deepEqual(readdirSync(styled.dir).sort(), expectedFiles);
  const checked = verifyDeliveryBundle(styled.dir, { reportSha256: styled.files[PIECES.report].sha256 });
  assert.deepEqual(checked.files, styled.files);
  for (const name of expectedFiles) {
    const bytes = readFileSync(join(styled.dir, name));
    assert.deepEqual(styled.files[name], { bytes: bytes.length, sha256: sha256(bytes) }, name);
  }
  for (const name of [PIECES.master, PIECES.web]) {
    const { video } = probeMedia(join(styled.dir, name));
    assert.deepEqual([video.frames, video.rate, video.pixFmt, video.colorRange, video.colorSpace, video.colorPrimaries, video.colorTransfer],
      [3, '24/1', 'yuv420p', 'tv', 'bt709', 'bt709', 'bt709']);
  }

  const frameBytes = width * height * 3;
  const before = decodedMaster(untouched);
  const after = decodedMaster(styled);
  assert.equal(after.length, frameBytes * 3);
  assert.equal(before.length, after.length);
  for (const frame of [0, 1]) {
    const start = frameBytes * frame;
    const end = start + frameBytes;
    assert.deepEqual(after.subarray(start, end), before.subarray(start, end), '另一镜头的解码像素必须保持不变');
    assert.ok(Math.abs(after[start] - (frame === 0 ? 48 : 128)) <= 2, '另一镜头逐帧心跳顺序不变');
  }
  const cut = 2 * frameBytes;
  const styledDelta = meanDelta(before.subarray(cut), after.subarray(cut));
  assert.ok(styledDelta >= 2, '硬切后目标镜头的分层风格化必须进入母版');
  t.diagnostic(JSON.stringify({ unchangedFrames: 2, styledFrames: 1, styledDelta, bundle: styled.files }));
});
