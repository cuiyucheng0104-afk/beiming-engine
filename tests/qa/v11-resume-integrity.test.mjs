import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { framemd5, miniRepo, skip } from '../render/helpers.mjs';
import { ffmpeg } from './helpers.mjs';

test('V11 QA 续跑只复用视频、灰度与旁注仍配套的分片', { skip }, async t => {
  const fixture = miniRepo('page');
  t.after(fixture.cleanup);
  const { renderRange } = await import(pathToFileURL(fixture.script('lib/chunks.mjs')));
  const { openFilm, closeServer } = await import(pathToFileURL(fixture.script('page.mjs')));
  t.after(closeServer);
  const w = 64, h = 64, fps = 24, chunks = [[0, 3], [3, 6]];
  const openOptions = { w, h, gpu: 'software-ok', angle: 'swiftshader', pageQa: true, render: { fps } };
  const outputs = ['master', 'web'].map(kind => ({ kind, vf: 'format=yuv420p', args: ['-c:v', 'libx264', '-preset', 'ultrafast'] }));
  const opts = { dir: fixture.film, w, h, fps, chunks, workers: 1, intermediate: 'png', outputs, workDir: fixture.base,
    openOptions, qaSpec: { width: w, height: h, fps, frames: 6 }, keepQaParts: true, key: 'resume', signal: new AbortController().signal, live: new Set() };
  const original = await renderRange(opts);
  const master = original.files.master[0], web = original.files.web[0], gray = master + '.gray', sidecar = master + '.json';
  const pixels = framemd5(master), black = join(fixture.base, 'black.mp4');
  ffmpeg(['-i', master, '-vf', 'drawbox=color=black:t=fill', ...outputs[0].args, black]);
  const blackPixels = framemd5(black);
  assert.equal(blackPixels.length, pixels.length);
  assert.notDeepEqual(blackPixels, pixels);

  // 同帧区间、同依赖、同像素的另一份真实旁注，只有页面上报的 QA 不同。
  const donorDir = join(fixture.base, 'donor');
  fs.mkdirSync(donorDir);
  const firstFilm = await openFilm(fixture.film, openOptions);
  await firstFilm.page.evaluate(() => { window.TEXTS = () => []; });
  const donor = await renderRange({ ...opts, workDir: donorDir, firstFilm });
  const donorSidecar = donor.files.master[0] + '.json';
  const readMeta = () => JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  assert.deepEqual(framemd5(donor.files.master[0]), pixels);
  assert.notDeepEqual(JSON.parse(fs.readFileSync(donorSidecar, 'utf8')).pageQa, readMeta().pageQa);

  async function resume(reused) {
    const result = await renderRange({ ...opts, reuse: true });
    assert.deepEqual([result.stats.reusedChunks, result.stats.renderedFrames], [reused, 3 * (2 - reused)]);
    assert.deepEqual(framemd5(master), pixels);
    assert.deepEqual(framemd5(web), pixels);
    assert.deepEqual(result.qaRecords, original.qaRecords);
  }
  await t.test('完好缓存整批复用', () => resume(2));
  for (const [name, file, damage] of [
    ['同规格全黑母版', master, () => fs.copyFileSync(black, master)],
    ['同规格全黑附加输出', web, () => fs.copyFileSync(black, web)],
    ['等长灰度像素被改', gray, () => { const bytes = fs.readFileSync(gray); bytes[0] ^= 255; fs.writeFileSync(gray, bytes); }],
    ['交换同区间的整份旁注', sidecar, () => fs.copyFileSync(donorSidecar, sidecar)],
    ['改动旁注页面记录', sidecar, () => { const meta = readMeta(); meta.pageQa.info.hasTexts = true; fs.writeFileSync(sidecar, JSON.stringify(meta)); }],
    ['改动合法格式的帧哈希', sidecar, () => { const meta = readMeta(); meta.hashes[0] = '0'.repeat(64); fs.writeFileSync(sidecar, JSON.stringify(meta)); }],
  ]) await t.test(name, async () => {
    const before = fs.readFileSync(file);
    damage();
    assert.ok(!before.equals(fs.readFileSync(file)));
    try { await resume(1); } catch (e) { fs.writeFileSync(file, before); throw e; }
  });
  await t.test('缺校验值的旧缓存重建一次后可复用', async () => {
    fs.unlinkSync(sidecar + '.sha256');
    await resume(1);
    await resume(2);
  });
  await t.test('读分片期间取消会保留原始取消原因', async t => {
    const ac = new AbortController(), reason = new Error('取消续跑');
    const createReadStream = fs.createReadStream;
    t.mock.method(fs, 'createReadStream', (file, options) => {
      const stream = createReadStream(file, options);
      if (file === master) stream.once('data', () => ac.abort(reason));
      return stream;
    });
    await assert.rejects(renderRange({ ...opts, reuse: true, signal: ac.signal }), e => e === reason);
  });
  await t.test('发布校验值失败会报错，清理临时文件后可续跑', async t => {
    const first = { ...opts, chunks: [chunks[0]], qaSpec: { ...opts.qaSpec, frames: 3 }, workDir: donorDir };
    const seal = donorSidecar + '.sha256';
    fs.unlinkSync(seal);
    const reason = new Error('校验值改名失败'), rename = fs.renameSync;
    const publish = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === seal) throw reason;
      rename(from, to);
    });
    await assert.rejects(renderRange(first), e => e === reason);
    assert.equal(fs.existsSync(seal + '.tmp'), false);
    publish.mock.restore();
    const retry = await renderRange({ ...first, reuse: true });
    assert.equal(retry.stats.renderedFrames, 3);
  });
  await t.test('临时 QA 和普通持久化分片都跳过文件哈希', async t => {
    const createReadStream = fs.createReadStream, reads = [];
    t.mock.method(fs, 'createReadStream', (file, options) => {
      if (file.startsWith(donorDir)) reads.push(file);
      return createReadStream(file, options);
    });
    await renderRange({ ...opts, keepQaParts: false, workDir: donorDir });
    assert.deepEqual(reads, donor.files.master.map(file => file + '.gray'), '只为画面分析读取灰度文件');
    reads.length = 0;
    await renderRange({ ...opts, qaSpec: null, workDir: donorDir });
    await renderRange({ ...opts, qaSpec: null, workDir: donorDir, reuse: true });
    assert.deepEqual(reads, []);
  });
});
