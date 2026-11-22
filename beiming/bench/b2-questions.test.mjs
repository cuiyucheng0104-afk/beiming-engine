// B2：一级 4 道考题（29-1、28-1、23-1、01-1）契约校验与参考片/原作反例自动判分核验
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { registered } from '../verify/predicates.mjs';
import { projectPublicQuestion, scanQuestionLeaks, validateQuestion } from './index.mjs';
import { argsOf, readClosure, readFraming, readLayout, readMaster, readNearest, readPixelBoxes, score } from './questions/level-1/evaluate-b2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 文件名照规划文档的题号；01-1 文件里的 id 是 1-1：冻结的题号写法不带前导零（题目文件契约 5.1）
const IDS = { '29-1': '29-1', '28-1': '28-1', '23-1': '23-1', '01-1': '1-1' };
const rawOf = (name) => readFileSync(join(HERE, 'questions/level-1', `${name}.json`), 'utf8');
const question = (name) => JSON.parse(rawOf(name));
const ref = (name) => JSON.parse(readFileSync(join(HERE, 'refs/level-1', `${name}.json`), 'utf8'));
const failed = (verdict) => verdict.items.filter((item) => !item.pass).map((item) => item.metric);

/** 合成帧：先铺底色，再依次画矩形 [x0, y0, x1, y1, [r, g, b]] */
function paint(width, height, bg, rects = []) {
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1, color] of [[0, 0, width, height, bg], ...rects]) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set(color, (y * width + x) * 4);
  }
  return { width, height, rgba };
}

test('B2-1 一级 4 道考题文件存在且原文与对象均通过 B1 validateQuestion（0 错误、0 违反、0 泄露）', () => {
  const expected = {
    '29-1': { size: [1080, 1350], fps: '30/1', frames: 600, audio: 'none', needs: ['layout.panels', 'deliver.encode'] },
    '28-1': { size: [1920, 824], fps: '24/1', frames: 288, audio: 'none', needs: ['camera.orbit', 'camera.fit', 'deliver.encode'] },
    '23-1': { size: [720, 1080], fps: '24/1', frames: 72, audio: 'none', needs: ['camera.orbit', 'deliver.encode'] },
    '01-1': { size: [1920, 1080], fps: '30/1', frames: 1104, audio: 'stereo', needs: ['deliver.encode', 'audio.master'] },
  };
  for (const [name, id] of Object.entries(IDS)) {
    const file = join(HERE, 'questions/level-1', `${name}.json`);
    assert.ok(existsSync(file), `缺少题目文件: ${file}`);
    const raw = rawOf(name);
    for (const input of [raw, JSON.parse(raw)]) {
      const verdict = validateQuestion(input);
      assert.deepEqual(verdict, { ok: true, schemaErrors: [], violations: {}, leaks: [] }, `${name} 校验未过: ${JSON.stringify(verdict)}`);
    }
    const pub = projectPublicQuestion(JSON.parse(raw));
    assert.equal(pub.id, id);
    assert.equal(pub.level, 1);
    const { needs, ...deliverable } = expected[name];
    assert.deepEqual(pub.deliverable, deliverable);
    assert.deepEqual(pub.needs, needs);
    assert.equal(pub.scoring.reduce((sum, item) => sum + item.weight, 0), 1, `${name} 权重和不是 1`);
    assert.equal(pub.calibration.status, 'uncalibrated');
    for (const text of pub.basePredicates) assert.ok(registered(text.match(/^[A-Za-z_.]+/)[0]), `${name} 的 ${text} 没登记`);
    // 参考都指向仓库里脱敏的读数夹具（相对 beiming/）
    assert.ok(pub.refs.length > 0);
    for (const path of pub.refs) assert.ok(existsSync(join(HERE, '..', path)), `${name} 的参考 ${path} 不存在`);
  }
  assert.equal(question('28-1').assets.subject, 'calib/mech-head-proxy@1');
});

test('B2-2 题目与读数夹具不带私有路径、原包文件名和商业专名', () => {
  const files = [...Object.keys(IDS).map((name) => join(HERE, 'questions/level-1', `${name}.json`)),
    ...readdirSync(join(HERE, 'refs/level-1')).map((name) => join(HERE, 'refs/level-1', name))];
  assert.ok(files.length >= 8);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.deepEqual(scanQuestionLeaks(text), [], file);
    assert.doesNotMatch(text, /rtx|5090|nvidia|geforce|rog\b|android|residence|higgsfield|\.mp4|[0-9a-f]{16}/i, file);
  }
});

test('B2-3 29-1：参考片读数满分；合成版式过真实 layoutEdges 满分，边界偏 1 像素或分隔线偏色判不过', () => {
  const q = question('29-1'), args = argsOf(q, 'layout.edges');
  const fixture = ref('29-1-reference');
  assert.deepEqual(fixture.readings['layout.edges'].edgeErrorsPx, [0, 0, 0, 0, 0, 0]);
  assert.ok(fixture.readings['layout.edges'].lineColorError <= 4);
  assert.deepEqual(score(q, fixture.readings), { id: '29-1', score: 1, pass: true,
    items: [{ metric: 'layout.edges', weight: 0.5, pass: true }, { metric: 'layout.edges', weight: 0.5, pass: true }] });

  const bg = [9, 9, 6], panel = [128, 110, 90];
  const layout = ({ top = [44, 652], bottom = [698, 1306], line = [673, 677], color = [0xCB, 0xFB, 0x03] } = {}) =>
    ({ 'layout.edges': readLayout(paint(1080, 1350, bg, [[0, top[0], 1080, top[1], panel], [0, bottom[0], 1080, bottom[1], panel], [0, line[0], 1080, line[1], color]]), args) });
  const exact = layout();
  assert.deepEqual(exact['layout.edges'], { bands: [[44, 652], [673, 677], [698, 1306]], edgeErrorsPx: [0, 0, 0, 0, 0, 0], lineColorError: 0 });
  assert.equal(score(q, exact).score, 1);
  // 线色差正好 4 级还过，5 级不过
  assert.equal(score(q, layout({ color: [0xCB, 0xFB - 4, 0x03 + 4] })).score, 1);
  const tinted = score(q, layout({ color: [0xCB, 0xFB - 5, 0x03] }));
  assert.deepEqual([tinted.pass, tinted.score], [false, 0.5]);
  // 每条边界各偏 1 像素
  for (const shifted of [{ top: [45, 652] }, { top: [44, 651] }, { top: [45, 653] }, { bottom: [697, 1306] }, { bottom: [698, 1307] }, { line: [672, 676] }, { line: [673, 678] }]) {
    const verdict = score(q, layout(shifted));
    assert.equal(verdict.pass, false, JSON.stringify(shifted));
    assert.equal(verdict.items[0].pass, false, JSON.stringify(shifted));
  }
  // 少一段（没画分隔线）
  assert.equal(score(q, layout({ line: [673, 673] })).score, 0);
  assert.equal(score(q, {}).score, 0);
});

test('B2-4 28-1：原作读数判不过（289 帧高度全超 70%，首尾 27.7 dB 低于相邻帧 37.6 dB 减 1 dB）；合规的合成环绕过真实指标满分', () => {
  const q = question('28-1');
  const original = ref('28-1-negative');
  const framing = original.readings['meta.bbox-limits'], closure = original.readings['loop.closure-psnr'];
  assert.equal(framing.frames, 289);
  assert.ok(framing.minH > 0.70 && original.violatingFrames.maxH === 289);
  assert.ok(Math.abs(closure.closurePsnr - 27.7) < 0.05 && Math.abs(closure.adjacentPsnr - 37.6) < 0.05);
  assert.ok(closure.closurePsnr < closure.adjacentPsnr - 1);
  assert.deepEqual(score(q, original.readings), { id: '28-1', score: 0, pass: false, items: [
    { metric: 'meta.bbox-limits', weight: 0.5, pass: false }, { metric: 'loop.closure-psnr', weight: 0.3, pass: false }, { metric: 'pixel.bbox', weight: 0.2, pass: false }] });

  // 合成环绕：头是一块深色矩形，宽随角度变，里面一条亮带随角度左右摆；首尾对称
  const W = 1920, H = 824, grey = [110, 108, 108];
  const boxAt = (k, height = 560) => {
    const angle = 2 * Math.PI * k / 288, half = Math.round(300 + 50 * Math.cos(angle));
    return [960 - half, (H - height) / 2, 960 + half, (H + height) / 2];
  };
  const frameAt = (k, box = boxAt(k)) => {
    const stripe = 960 + Math.round(200 * Math.sin(2 * Math.PI * k / 288));
    return paint(W, H, grey, [[...box, [30, 30, 40]], [stripe - 20, box[1] + 40, stripe + 20, box[3] - 40, [200, 180, 160]]]);
  };
  const boxes = Array.from({ length: 288 }, (_, k) => boxAt(k));
  const samples = [0, 72, 144, 216].map((k) => ({ frame: frameAt(k), box: boxes[k] }));
  const good = {
    'meta.bbox-limits': readFraming(boxes, [W, H]),
    'loop.closure-psnr': readClosure(frameAt(0), frameAt(287), frameAt(1)),
    'pixel.bbox': readPixelBoxes(samples, '#6E6C6C', 16),
  };
  assert.equal(good['meta.bbox-limits'].frames, 288);
  assert.equal(good['pixel.bbox'].maxDiffPx, 0);
  assert.deepEqual(score(q, good), { id: '28-1', score: 1, pass: true, items: [
    { metric: 'meta.bbox-limits', weight: 0.5, pass: true }, { metric: 'loop.closure-psnr', weight: 0.3, pass: true }, { metric: 'pixel.bbox', weight: 0.2, pass: true }] });
  // 头太高（高 600 像素，占 72.8%）：只有取景那一项不过
  assert.deepEqual(failed(score(q, { ...good, 'meta.bbox-limits': readFraming(boxes.map((_, k) => boxAt(k, 600)), [W, H]) })), ['meta.bbox-limits']);
  // 只转了半圈：末帧对不上第 0 帧
  assert.deepEqual(failed(score(q, { ...good, 'loop.closure-psnr': readClosure(frameAt(0), frameAt(144), frameAt(1)) })), ['loop.closure-psnr']);
  // 元数据说谎：报的包围盒每边比画面里的小 20 像素
  const lying = samples.map(({ frame, box }) => ({ frame, box: [box[0] + 20, box[1] + 20, box[2] - 20, box[3] - 20] }));
  assert.deepEqual(failed(score(q, { ...good, 'pixel.bbox': readPixelBoxes(lying, '#6E6C6C', 16) })), ['pixel.bbox']);
});

test('B2-5 23-1：72 帧与 60 帧两条参考转台读数满分；合成转台过真实 loopClosurePsnr 满分，少转、多转、末帧跳开判不过', () => {
  const q = question('23-1');
  const fixture = ref('23-1-reference');
  assert.deepEqual(score(q, fixture.readings), { id: '23-1', score: 1, pass: true,
    items: [{ metric: 'loop.closure-psnr', weight: 0.5, pass: true }, { metric: 'loop.closure-psnr', weight: 0.5, pass: true }] });
  // 头部转台：同一套判分，帧号按 60 帧换算
  const [head] = fixture.variants;
  const q60 = structuredClone(q);
  Object.assign(q60.deliverable, head.deliverable);
  Object.assign(q60.scoring[0].args, { search: [30, 60], expect: 59 });
  q60.scoring[1].args.b = 59;
  assert.equal(validateQuestion(q60).ok, true);
  assert.equal(score(q60, head.readings).score, 1);
  // 72 帧的题拿 60 帧的读数来判：最像的帧不是第 71 帧
  assert.equal(score(q, head.readings).pass, false);

  // 合成转台：一条横向正弦条纹，相位就是转过的角度
  const turn = (degrees) => {
    const rgba = new Uint8Array(64 * 8 * 4).fill(255);
    for (let i = 0; i < 64 * 8; i++) rgba.fill(Math.round(128 + 100 * Math.sin(2 * Math.PI * (i % 64) / 64 + degrees * Math.PI / 180)), i * 4, i * 4 + 3);
    return { width: 64, height: 8, rgba };
  };
  const measure = (frameAt) => ({ 'loop.closure-psnr': { ...readNearest(frameAt, argsOf(q, 'loop.closure-psnr').search), ...readClosure(frameAt(0), frameAt(71), frameAt(1)) } });
  const sweep = (total) => (k) => turn(k * total / 72);
  const loop = measure(sweep(360));
  assert.equal(loop['loop.closure-psnr'].nearest, 71);
  assert.equal(score(q, loop).score, 1);
  // 少转到 350°：末帧离第 0 帧约 15°，是相邻帧差的 3 倍
  const under = score(q, measure(sweep(350)));
  assert.deepEqual([under.pass, under.items.map((item) => item.pass)], [false, [true, false]]);
  // 多转到 370°：最像第 0 帧的成了第 70 帧
  const over = score(q, measure(sweep(370)));
  assert.deepEqual([over.pass, over.items.map((item) => item.pass)], [false, [false, true]]);
  // 末帧跳到半圈处
  assert.equal(score(q, measure((k) => (k === 71 ? turn(180) : turn(k * 5)))).score, 0);
});

test('B2-6 01-1：重制片终版读回满分；缺色彩标签、响度超差、真峰值超标、带黑帧的读数都判不过', () => {
  const q = question('01-1');
  const fixture = ref('01-1-reference');
  assert.equal(q.id, fixture.question);
  assert.deepEqual(score(q, fixture.readings), { id: '1-1', score: 1, pass: true, items: [
    { metric: 'deliver.spec', weight: 0.25, pass: true }, { metric: 'audio.loudness', weight: 0.5, pass: true }, { metric: 'frame.black-freeze-dup', weight: 0.25, pass: true }] });
  const mutate = (metric, patch) => score(q, { ...fixture.readings, [metric]: { ...fixture.readings[metric], ...patch } });
  const { preview } = fixture;
  // 预演版的读回记录：三样各自判不过
  assert.deepEqual(failed(mutate('deliver.spec', Object.fromEntries(preview.missingColorTags.map((tag) => [tag, null])))), ['deliver.spec']);
  assert.deepEqual(failed(mutate('audio.loudness', preview['audio.loudness'])), ['audio.loudness']);
  assert.deepEqual(failed(mutate('frame.black-freeze-dup', { blackFrames: preview.blackFrames.length })), ['frame.black-freeze-dup']);
  for (const [metric, patch] of [
    ['deliver.spec', { color_space: 'bt470bg' }], ['deliver.spec', { frames: 1103 }], ['deliver.spec', { fps: 29.97 }], ['deliver.spec', { width: 1280, height: 720 }],
    ['audio.loudness', { lufs: -13.4 }], ['audio.loudness', { lufs: -14.6 }], ['audio.loudness', { lufs: -Infinity }], ['audio.loudness', { truePeakDbtp: -0.9 }],
    ['frame.black-freeze-dup', { freezeSegments: 1 }], ['frame.black-freeze-dup', { duplicateFrames: 1 }],
  ]) assert.deepEqual(failed(mutate(metric, patch)), [metric], JSON.stringify(patch));
  // 线上的值还过
  assert.equal(mutate('audio.loudness', { lufs: -14.5, truePeakDbtp: -1 }).score, 1);
  assert.equal(mutate('audio.loudness', { lufs: -13.5 }).score, 1);
});

test('B2-7 01-1：合成成片过真实 deliverSpec、audioLoudness、blackFreezeDup 满分；不带标签、过响、开头一秒黑场的成片三项都判不过', async (t) => {
  if (['ffmpeg', 'ffprobe'].some((tool) => spawnSync(tool, ['-version']).error?.code === 'ENOENT')) return t.skip('环境缺少音视频工具');
  // 同一套判分线，画面缩到 64×36：1104 帧的 1080p 逐帧量要几十秒
  const q = question('01-1');
  q.deliverable.size = [64, 36];
  const dir = mkdtempSync(join(tmpdir(), 'b2-'));
  const encode = (name, video, amplitude, tags) => {
    const file = join(dir, name);
    const build = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', video,
      '-f', 'lavfi', '-i', `aevalsrc=${amplitude}*sin(2*PI*997*t)|${amplitude}*sin(2*PI*997*t):s=48000:d=36.8`,
      '-frames:v', '1104', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...tags, '-c:a', 'alac', file]);
    assert.equal(build.status, 0, build.stderr.toString());
    return file;
  };
  try {
    // 三项标签要另经 x264 参数写进码流，只给 ffmpeg 的输出选项读回来缺传递函数和原色（案例 01 预演版踩过）
    const bt709 = ['-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
    // 横向正弦条纹每帧挪 4°：每一帧都在动，没有重复帧
    const moving = "color=gray:s=64x36:r=30:d=36.8,geq=lum='128+100*sin(2*PI*(X/W+N/90))':cb=128:cr=128";
    // 两个声道同相的 997 Hz 正弦，幅度 −14 dBFS，响度就是 −14 LUFS
    const good = await readMaster(encode('good.mp4', moving, 0.1995, bt709), argsOf(q, 'frame.black-freeze-dup'));
    assert.deepEqual(score(q, good), { id: '1-1', score: 1, pass: true, items: [
      { metric: 'deliver.spec', weight: 0.25, pass: true }, { metric: 'audio.loudness', weight: 0.5, pass: true }, { metric: 'frame.black-freeze-dup', weight: 0.25, pass: true }] }, JSON.stringify(good));
    const bad = await readMaster(encode('bad.mp4', `${moving},drawbox=w=iw:h=ih:color=black:t=fill:enable='lt(n,30)'`, 0.95, []), argsOf(q, 'frame.black-freeze-dup'));
    assert.deepEqual(score(q, bad), { id: '1-1', score: 0, pass: false, items: [
      { metric: 'deliver.spec', weight: 0.25, pass: false }, { metric: 'audio.loudness', weight: 0.5, pass: false }, { metric: 'frame.black-freeze-dup', weight: 0.25, pass: false }] }, JSON.stringify(bad));
    assert.equal(bad['deliver.spec'].frames, 1104);
    assert.equal(bad['frame.black-freeze-dup'].blackFrames, 30);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
