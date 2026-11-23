// 真实 page/S3 证据（T8 集成测试注册本函数）。锁文件走宿主的内容哈希；读取落盘的 RGBA32F，不信卡自报的颜色或帧哈希。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { loadQuestion } from '../../../bench/negatives/level-2-b/run-b6.mjs';
import { readBaseShare, score } from '../../../bench/questions/level-2-b/evaluate-b4.mjs';
import { loadCards, startSource } from '../../../host/page/host.mjs';
import { digestOf, runPureFunctionGate } from '../../../verify/l2.mjs';

const here = dirname(fileURLToPath(import.meta.url)), dirs = ['cards/mechanism/page-det2d'];
const question = loadQuestion('18-1'), { size, fps, frames } = question.deliverable;
const scale = 1 / 12, [width, height] = size.map((x) => x * scale), rate = 30;
const mid = [150, 450, 750], boundaries = [300, 600];
const rgb8 = (v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
function display(bytes) {
  const raw = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(raw.length, width * height * 4);
  const rgba = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 4) {
    for (let c = 0; c < 3; c++) { const v = raw[i + c]; assert.ok(v >= 0 && v <= 1); rgba[i + c] = rgb8(v); }
    assert.equal(raw[i + 3], 1, '纸底应完全不透明'); rgba[i + 3] = 255;
  }
  return { width, height, rgba };
}
function pixel(frame, x, y) { const i = 4 * (y * width + x); return [...frame.rgba.subarray(i, i + 3)]; }
function hasSubtitle(frame) {
  for (let i = 4 * 60 * width; i < frame.rgba.length; i += 4) if (Math.max(...frame.rgba.subarray(i, i + 3)) < 80) return true;
  return false;
}

// 和画面在同一条时间线的合成立体声，不是题目缺席的原旁白。每帧 1600 采样，按 RMS 检测起声/收声。
function speechSpans() {
  const block = 48000 / rate, pcm = new Float32Array(frames * block * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const sec = i / 48000 % 10;
    if (sec >= 0.5 && sec < 9.5) pcm[i * 2] = pcm[i * 2 + 1] = 0.25 * Math.sin(2 * Math.PI * 240 * i / 48000);
  }
  const spans = []; let start = null;
  for (let f = 0; f <= frames; f++) {
    let sum = 0;
    if (f < frames) for (let i = f * block * 2; i < (f + 1) * block * 2; i++) sum += pcm[i] ** 2;
    if (sum / (2 * block) >= 10 ** (-45 / 10)) start ??= f;
    else if (start !== null) { spans.push([start, f]); start = null; }
  }
  return spans;
}

export async function verifyPageEvidence(t) {
  const library = await loadCards(dirs), { card, sha256 } = library['page.det2d'];
  let src;
  try { src = await startSource({ cards: dirs }); }
  catch (e) {
    if (!/executable (?:doesn't|does not) exist(?:s)? at/i.test(e.message)) throw e;
    t.skip('未安装指定的 Chromium；只跳过真实浏览器子测'); return;
  }
  let root, sequence = 0;
  try {
    root = await mkdtemp(join(tmpdir(), 'det2d-'));
    const open = async (mode = 'native-code', shotParams = {}, params = {}) => {
      const workspace = join(root, String(sequence++));
      const shot = { id: 'explain', in: 0, out: frames, source: 'three', host: 'page', mode, colorRef: 'display', cards: [{ as: 'page', use: 'page.det2d@1', params }],
        ...(mode === 'native-code' && { entry: 'sample.shot.mjs', params: shotParams }) };
      const lock = { seeds: { explain: 1 }, shots: { explain: { shutterSamples: 1 } }, cards: { 'page.det2d': { version: card.version, impl: card.livesIn, sha256 } } };
      const session = await src.open({ film: 'detpage', output: { size, fps }, shot }, { lock, tier: 'final', workspace, filmDir: here });
      return { close: () => session.close(), async sample(f) {
        const { layers, meta } = await session.render(f, { scale }, ['color', 'meta']);
        const bytes = await readFile(join(workspace, layers.color.file));
        assert.equal(`sha256:${digestOf(bytes)}`, layers.color.hash);
        return { bytes, meta };
      } };
    };

    await assert.rejects(() => open('cards-data', {}, { font: 'https://example.invalid/remote.woff2' }), { code: 'usage.bad-argument' });
    const fixed = await open('cards-data');
    try {
      const { bytes, meta } = await fixed.sample(0), { rgba } = display(bytes);
      assert.deepEqual(meta.ext['page.load'].applyOrder, ['tracks', 'page']);
      assert.ok(rgba.every((v, i) => v === [244, 240, 233, 255][i % 4]), '固定装载脚本只装机制就应得到整帧纸底');
      t.diagnostic(`three/page ${meta.source.version ?? src.caps().version}；${meta.source.gpu}`);
    } finally { await fixed.close(); }

    // 校准用登记场景的 11 级 LDR 灰、8 块颜色；本机制是显示参考，不把 HDR 梯子截断冒充通过。
    const swatches = JSON.parse(await readFile(new URL('../../../calib/probe-gray-chart/scene.json', import.meta.url), 'utf8')).objects
      .filter(({ id }) => id.startsWith('ldr-') || id.startsWith('card-')).map(({ emissionLinear }) => emissionLinear.map(rgb8));
    assert.equal(swatches.length, 19);
    const panels = swatches.map((rgb, i) => ({ name: `chip${i}`, rect: [96 + 84 * i, 120, 168 + 84 * i, 240], fill: '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('') }));
    const calibration = await open('native-code', { panels });
    try {
      const frame = display((await calibration.sample(0)).bytes);
      for (const [i, expected] of swatches.entries()) {
        const x = 8 + 7 * i;
        assert.deepEqual(pixel(frame, x, 12), expected, `色片 ${i} 左边界`);
        assert.deepEqual(pixel(frame, x + 5, 12), expected, `色片 ${i} 右边界`);
        assert.deepEqual(pixel(frame, x + 6, 12), [244, 240, 233], `色片 ${i} 的外沿不能串色`);
      }
    } finally { await calibration.close(); }

    const shots = new Map(), session = await open('native-code', { probe: true });
    try {
      // 两侧各多看一帧，淡出长度从颜色变化量回，不取面板的声明。字幕起收也从墨迹量。
      const sampleFrames = [...new Set([...mid, ...[0, 300, 600].flatMap((f) => [14, 15, 284, 285].map((k) => f + k)),
        ...boundaries.flatMap((f) => Array.from({ length: 7 }, (_, i) => f - 6 + i))])];
      for (const f of sampleFrames) {
        const { bytes, meta } = await session.sample(f);
        assert.equal(meta.ext['page.load'].cards[0].calledVia, 'cards.use');
        const frame = display(bytes);
        assert.deepEqual(pixel(frame, 0, 0), [244, 240, 233]);
        if (mid.includes(f)) {
          assert.deepEqual(meta.texts.map((x) => x.text), [`AI ${mid.indexOf(f) + 1}`]);
          assert.ok(hasSubtitle(frame));
        }
        shots.set(f, frame);
      }
    } finally { await session.close(); }

    const spans = speechSpans(); assert.equal(spans.length, 3);
    const appearSec = [], fadeFrames = [], edges = [0];
    for (const [on, off] of spans) {
      assert.ok(!hasSubtitle(shots.get(on - 1)) && hasSubtitle(shots.get(on)), '起声的同帧应出现整块字幕');
      assert.ok(hasSubtitle(shots.get(off - 1)) && !hasSubtitle(shots.get(off)), '收声后字幕应撤掉');
      appearSec.push(on / rate);
    }
    for (const f of boundaries) {
      const reds = Array.from({ length: 7 }, (_, i) => pixel(shots.get(f - 6 + i), 20, 23)[0]);
      assert.equal(reds[0], reds[1]);
      let count = 0;
      for (let i = 2; i < reds.length - 1; i++) if (reds[i] > reds[i - 1]) count++;
      assert.ok(reds.at(-1) < reds.at(-2), '场景应在淡出末尾切换');
      fadeFrames.push(count); edges.push(f);
    }
    edges.push(frames);
    const args = question.scoring.find((line) => line.metric === 'color.palette').args;
    const palette = readBaseShare(mid.map((f) => shots.get(f)), args);
    const timing = { spanSec: frames / rate, onsetsSec: spans.map(([f]) => f / rate), appearSec, fadeFrames,
      leadSec: spans.map(([f], i) => (f - edges[i]) / rate), tailSec: spans.map(([, f], i) => (edges[i + 1] - f) / rate) };
    const verdict = score(question, { 'color.palette': palette, 'narration.timing': timing });
    assert.deepEqual(fadeFrames, [4, 4]); assert.equal(verdict.score, 1, JSON.stringify({ verdict, palette, timing }));

    const hashes = new Map();
    const gate = await runPureFunctionGate({ async open() {
      const s = await open();
      return { close: s.close, async render(f) { const { bytes } = await s.sample(f); hashes.set(f, digestOf(bytes)); return bytes; } };
    } }, [14, 150, 298, 450, 750], { compare: 'hash' });
    assert.ok(gate.ok && gate.bitExact, JSON.stringify(gate.mismatches));
    assert.equal(new Set(hashes.values()).size, gate.frames.length, '不能用静帧通过逐帧比对');
    t.diagnostic(`18-1 score=${verdict.score}，三场纸色占比 ${palette.shares.map((s) => s.toFixed(4)).join(' / ')}，淡出 ${fadeFrames.join('/')} 帧；L2 ${gate.frames.length} 帧三序逐字节相同`);
  } finally { try { await src.stop(); } finally { if (root) await rm(root, { recursive: true, force: true }); } }
}
