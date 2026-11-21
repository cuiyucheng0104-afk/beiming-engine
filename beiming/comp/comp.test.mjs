// 合成收尾的测试：纯函数的值域与口径，加上真实调用本机 ffmpeg / ffprobe 的拼接、编码、混音母带与交付六件套。
// 夹具（EXR / PNG 帧序列、合成 .cube）都在系统临时目录里现做，跑完删掉；不读写 comp/lut/。不出声。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { eventsTable } from '../kernel/eval/index.mjs';
import {
  CompError, PIECES, SETPARAMS, VOICES, contactFrames, deliver, encode, encodeCommand, escapeFilterValue, eventSample,
  filmSamples, finishFilters, framePath, isFaststart, masterAudio, measureLoudness, mixEvents, normalizeShot, outputArgs,
  parseFps, probeMedia, readWav, renderRaw, runTool, shaperValue, srgbEncode, stitchGraph, tools, topLevelBoxes,
  verifyDeliveryBundle, writeWav,
} from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FILM_MIN = JSON.parse(readFileSync(join(here, '../kernel/contracts/examples/film-min/film.json'), 'utf8'));
const LOCK_MIN = JSON.parse(readFileSync(join(here, '../kernel/contracts/lock/examples/minimal.json'), 'utf8'));
const LOCK_FULL = JSON.parse(readFileSync(join(here, '../kernel/contracts/lock/examples/check-full.json'), 'utf8')).lock;
const SHAPER = Object.freeze({ minEv: -10, maxEv: 6.5, mid: 0.18 });
const frozen = await loadContracts();
const minimal = JSON.parse(readFileSync(join(here, '../kernel/contracts/film/examples/minimal.json'), 'utf8'));

const ff = (args) => {
  const out = args.pop();
  const r = spawnSync(tools().ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args, ...(out.includes('%') ? ['-start_number', '0'] : []), out], { shell: false, windowsHide: true, timeout: 120000 });
  if (r.status !== 0) throw new Error(`ffmpeg 夹具失败：${r.stderr}`);
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const code = (c) => (e) => e instanceof CompError && e.code === c;

/** n³ 格点的 .cube：f(r, g, b) → [r', g', b']，输入都在 [0, 1] */
function cube(path, n, f) {
  const lines = [`LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    lines.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' '));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

/** 常数线性值的 EXR 序列（count 帧，w×h 像素） */
function constantExr(dir, value, count, [w, h] = [64, 36]) {
  mkdirSync(dir, { recursive: true });
  ff(['-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=30`, '-frames:v', String(count),
    '-vf', `format=gbrpf32le,geq=r='${value}':g='${value}':b='${value}'`, '-c:v', 'exr', '-compression', 'zip16', join(dir, 'f.%04d.exr')]);
  return join(dir, 'f.%04d.exr');
}

/** Y 平面的平均值（yuv420p 原始帧，第 k 帧） */
function lumaMean(raw, [w, h], k) {
  const frame = (w * h * 3) / 2;
  const y = raw.subarray(k * frame, k * frame + w * h);
  return y.reduce((a, v) => a + v, 0) / y.length;
}

let HAS_FFMPEG = false;
try {
  const bin = tools();
  HAS_FFMPEG = spawnSync(bin.ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }).status === 0
    && spawnSync(bin.ffprobe, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }).status === 0;
} catch (e) { if (e?.code !== 'env.ffmpeg-missing') throw e; }
const NEED_FFMPEG = { skip: !HAS_FFMPEG && '环境缺少 ffmpeg / ffprobe' };

function stubSeq(dir, ext, count) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `f.${String(i).padStart(4, '0')}.${ext}`), '');
  return join(dir, `f.%04d.${ext}`);
}

let root, fx;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'beiming-comp-test-'));
  // 路径里故意带空格、逗号、引号、方括号（非 Windows 再带冒号），检查滤镜参数的转义
  const odd = process.platform === 'win32' ? "lut dir, it's [a]" : "lut dir, it's [a]:b";
  mkdirSync(join(root, odd), { recursive: true });
  const identity = join(root, odd, 'identity.cube');
  cube(identity, 17, (r, g, b) => [r, g, b]);
  const warm = join(root, odd, 'warm.cube');
  cube(warm, 17, (r, g, b) => [Math.min(1, r ** 0.9 * 1.02), g ** 0.95, b * 0.92]);
  const size = [320, 180];
  if (!HAS_FFMPEG) {
    fx = {
      identity, warm, size,
      s01: stubSeq(join(root, 's01'), 'exr', 180),
      s02: stubSeq(join(root, 's02'), 'png', 120),
      gray: stubSeq(join(root, 'gray'), 'exr', 4),
      grayPng: stubSeq(join(root, 'graypng'), 'png', 4),
    };
    return;
  }
  // 片子 film-min 的两镜头：s01 场景参考（线性 EXR，高动态），s02 显示参考（显示编码的 PNG）
  mkdirSync(join(root, 's01'));
  mkdirSync(join(root, 's02'));
  ff(['-f', 'lavfi', '-i', `testsrc2=s=${size[0]}x${size[1]}:r=30`, '-frames:v', '180',
    '-vf', "format=gbrpf32le,geq=r='4*pow(r(X,Y),2.2)':g='2*pow(g(X,Y),2.2)':b='pow(b(X,Y),2.2)'", '-c:v', 'exr', '-format', 'half', '-compression', 'zip16', join(root, 's01', 'f.%04d.exr')]);
  ff(['-f', 'lavfi', '-i', `testsrc=s=${size[0]}x${size[1]}:r=30`, '-frames:v', '120', '-pix_fmt', 'rgb24', join(root, 's02', 'f.%04d.png')]);
  fx = {
    identity, warm, size,
    s01: join(root, 's01', 'f.%04d.exr'), s02: join(root, 's02', 'f.%04d.png'),
    gray: constantExr(join(root, 'gray'), 0.18, 4),
    grayPng: (() => {
      mkdirSync(join(root, 'graypng'));
      ff(['-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=30', '-frames:v', '4', '-vf', 'format=rgb24,geq=r=128:g=128:b=128', '-pix_fmt', 'rgb24', join(root, 'graypng', 'f.%04d.png')]);
      return join(root, 'graypng', 'f.%04d.png');
    })(),
  };
});
after(() => rmSync(root, { recursive: true, force: true }));

function smallFilm() {
  const film = structuredClone(FILM_MIN);
  film.output.size = [...fx.size];
  return film;
}
function lockFor(lutPath) {
  const lock = structuredClone(LOCK_MIN);
  for (const name of ['comp.finish', 'audio.master']) lock.cards[name] = LOCK_FULL.cards[name];
  lock.seeds.s01 = FILM_MIN.shots[0].seed;
  lock.seeds.s02 = FILM_MIN.shots[1].seed;
  lock.shots = LOCK_FULL.shots;
  lock.sources.three = LOCK_FULL.sources.three;
  lock.templates['delivery-web'] = LOCK_FULL.templates['delivery-web'];
  lock.view = { 'agx-mhc': `sha256:${sha(readFileSync(lutPath))}` };
  return lock;
}
const framesFor = () => ({ s01: { pattern: fx.s01 }, s02: { pattern: fx.s02 } });

describe('纯函数口径', () => {
  test('帧率解析：分子/分母，别的写法报 usage.bad-argument', () => {
    assert.deepEqual(parseFps('30000/1001'), { num: 30000, den: 1001 });
    assert.throws(() => parseFps('30'), code('usage.bad-argument'));
    assert.throws(() => parseFps('0/1'), code('usage.bad-argument'));
  });

  test('滤镜参数两级转义：\\ \' : [ ] , ; 都被转义', () => {
    assert.equal(escapeFilterValue('a:b'), 'a\\\\:b');
    assert.equal(escapeFilterValue("it's"), "it\\\\\\'s");
    assert.equal(escapeFilterValue('x,y[z];w'), 'x\\,y\\[z\\]\\;w');
    assert.equal(escapeFilterValue('plain/path.cube'), 'plain/path.cube');
  });

  test('对数整形：中灰落在 −minEv/(maxEv−minEv)，上下夹到 [0, 1]，非法参数报错', () => {
    assert.ok(Math.abs(shaperValue(0.18, SHAPER) - 10 / 16.5) < 1e-12);
    assert.equal(shaperValue(0, SHAPER), 0);
    assert.equal(shaperValue(1e6, SHAPER), 1);
    assert.throws(() => stitchGraph({ shots: [{ id: 's01', in: 0, out: 4, colorRef: 'scene', pattern: fx.gray }], size: [64, 36], fps: '30/1', view: { lutPath: fx.identity, shaper: { minEv: 2, maxEv: 1, mid: 0.18 } } }), code('usage.bad-argument'));
  });

  test('sRGB 编码：0.18 → 0.4614，0、1 不动，超出夹住', () => {
    assert.ok(Math.abs(srgbEncode(0.18) - 0.46135) < 1e-4);
    assert.equal(srgbEncode(0), 0);
    assert.ok(Math.abs(srgbEncode(1) - 1) < 1e-12);
    assert.ok(Math.abs(srgbEncode(7) - 1) < 1e-12);
  });

  test('收尾层：强度 0 不挂滤镜；颗粒带固定种子；出值域报错', () => {
    assert.deepEqual(finishFilters({ grain: 0, vignette: 0 }, 7), { rgb: null, yuv: null });
    assert.deepEqual(finishFilters(undefined, 7), { rgb: null, yuv: null });
    const f = finishFilters({ grain: 0.04, vignette: 0.2 }, 7802);
    assert.equal(f.yuv, 'noise=all_seed=7802:c0s=4:c0f=t');
    assert.match(f.rgb, /^vignette=angle=0\.20943951\d*:mode=forward:eval=init:dither=0$/);
    assert.throws(() => finishFilters({ grain: 1.5 }), code('usage.bad-argument'));
  });

  test('帧序列：%0Nd 展开；缺帧、区间、colorRef、transfer 不合法都报错', () => {
    assert.equal(framePath('a/f.%04d.exr', 12), 'a/f.0012.exr');
    assert.throws(() => normalizeShot({ id: 's01', in: 0, out: 9, colorRef: 'display', pattern: fx.gray }), /缺第 4 帧/);
    assert.throws(() => normalizeShot({ id: 's01', in: 4, out: 4, colorRef: 'display', pattern: fx.gray }), code('usage.bad-argument'));
    assert.throws(() => normalizeShot({ id: 's01', in: 0, out: 4, colorRef: 'hdr', pattern: fx.gray }), code('usage.bad-argument'));
    assert.throws(() => normalizeShot({ id: 's01', in: 0, out: 4, colorRef: 'scene', pattern: fx.grayPng }), /必须是线性光/);
    assert.equal(normalizeShot({ id: 's01', in: 0, out: 4, colorRef: 'display', pattern: fx.grayPng }).transfer, 'srgb');
  });

  test('拼接图：只收硬切；镜头要首尾相接；场景镜头没给 .cube 显式报错', () => {
    const shots = [
      { id: 'a', in: 0, out: 2, colorRef: 'display', pattern: fx.gray },
      { id: 'b', in: 2, out: 4, colorRef: 'display', pattern: fx.gray },
    ];
    const base = { shots, size: [64, 36], fps: '30/1' };
    assert.throws(() => stitchGraph({ ...base, transitions: [{ id: 'x', at: 2, type: 'dissolve' }] }), /只做硬切/);
    assert.throws(() => stitchGraph({ ...base, transitions: [{ id: 'x', at: 3, type: 'cut' }] }), /不是镜头交界/);
    assert.throws(() => stitchGraph({ ...base, shots: [shots[0], { ...shots[1], in: 3, out: 5 }] }), /应接在上一镜头/);
    assert.throws(() => stitchGraph({ ...base, shots: [{ ...shots[0], colorRef: 'scene' }] }), /view\.lutPath/);
    assert.throws(() => stitchGraph({ ...base, size: [63, 36] }), /正偶数/);
    const g = stitchGraph({ ...base, transitions: [{ id: 'cut-2', at: 2, type: 'cut' }] });
    assert.match(g.filter, /concat=n=2:v=1:a=0/);
    assert.equal(g.frames, 4);
  });

  test('母版、网页档参数：libx264、CRF、yuv420p、BT.709 四项标注、固定 GOP、确定性线程', () => {
    const m = outputArgs({ preset: 'h264-crf14-bt709', fps: '30/1', audio: true }).join(' ');
    for (const s of ['-c:v libx264', '-crf 14', '-pix_fmt yuv420p', '-color_range tv', '-colorspace bt709', '-color_primaries bt709', '-color_trc bt709', '-g 60', '-keyint_min 60', '-sc_threshold 0', 'non-deterministic=0', '-ar 48000']) {
      assert.ok(m.includes(s), `母版参数缺 ${s}`);
    }
    assert.ok(!m.includes('faststart'));
    const w = outputArgs({ preset: 'web', fps: '30/1' }).join(' ');
    for (const s of ['-crf 20', '-movflags +faststart', '-color_trc bt709', '-maxrate 8M']) assert.ok(w.includes(s), `网页参数缺 ${s}`);
  });

  test('编码命令：每一路输出前都挂 setparams（BT.709 有限范围）', () => {
    const graph = stitchGraph({ shots: [{ id: 'a', in: 0, out: 4, colorRef: 'display', pattern: fx.gray }], size: [64, 36], fps: '30/1' });
    const args = encodeCommand({ graph, outputs: [{ preset: 'h264-crf14-bt709', path: 'm.mp4' }, { preset: 'web', path: 'w.mp4' }] });
    const fc = args[args.indexOf('-filter_complex') + 1];
    assert.equal(SETPARAMS, 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709');
    assert.equal(fc.split(SETPARAMS).length - 1, 2);
    assert.match(fc, /split=2\[preenc0\]\[preenc1\];\[preenc0\]setparams=[^;]+\[enc0\];\[preenc1\]setparams=[^;]+\[enc1\]$/);
  });

  test('显卡编码器：终渲拒收，预览档在 draft / preview 收，母版档不收，不认识的不收', () => {
    assert.throws(() => outputArgs({ preset: 'preview', fps: '30/1', tier: 'final', hwEncoder: 'h264_nvenc' }), /终渲/);
    assert.throws(() => outputArgs({ preset: 'h264-crf14-bt709', fps: '30/1', tier: 'final', hwEncoder: 'h264_nvenc' }), /终渲/);
    assert.throws(() => outputArgs({ preset: 'h264-crf14-bt709', fps: '30/1', tier: 'draft', hwEncoder: 'h264_nvenc' }), /只给预览档/);
    assert.throws(() => outputArgs({ preset: 'preview', fps: '30/1', tier: 'draft', hwEncoder: 'libfoo' }), /不认识/);
    const a = outputArgs({ preset: 'preview', fps: '30/1', tier: 'draft', hwEncoder: 'h264_videotoolbox' }).join(' ');
    assert.ok(a.includes('-c:v h264_videotoolbox') && a.includes('-color_trc bt709') && !a.includes('libx264'));
    assert.ok(outputArgs({ preset: 'preview', fps: '30/1', tier: 'preview', hwEncoder: 'h264_nvenc' }).includes('h264_nvenc'));
  });

  test('事件 → 采样点：30/1 的第 192 帧是 307200；30000/1001 按有理数取整', () => {
    assert.equal(eventSample(192, 0, '30/1'), 307200);
    assert.equal(filmSamples(300, '30/1'), 480000);
    assert.equal(eventSample(5, 0, '30000/1001'), Math.round((5 * 48000 * 1001) / 30000));
    assert.equal(eventSample(0, 0.5, '24/1'), 1000);
  });

  test('音色库：至少五种（含垫底），同参数两次生成逐样本相同，峰值不过满刻度', () => {
    for (const name of ['hit.low', 'hit.soft', 'whoosh', 'riser']) {
      const a = VOICES[name].make(), b = VOICES[name].make();
      assert.ok(a.left.length > 0 && a.left.every((v, i) => v === b.left[i] && Number.isFinite(v) && Math.abs(v) <= 1), name);
    }
    const ev = { format: 'events/0.1', film: 'f', fps: '30/1', frames: 30, events: [] };
    assert.ok(mixEvents(ev).left.every((v) => v === 0));
    const room = mixEvents(ev, { bed: 'room' });
    assert.ok(room.left.some((v) => v !== 0) && room.left.every((v) => Math.abs(v) < 0.01));
  });

  test('事件混音：film-min 的 hit.low 起音点精确落在第 307200 个采样点；pcenter 提前；未知音色报错', () => {
    const events = eventsTable(FILM_MIN);
    const mix = mixEvents(events);
    assert.equal(mix.length, 480000);
    assert.deepEqual(mix.placements.map((p) => [p.id, p.sample, p.start]), [['title', 307200, 307200]]);
    assert.ok(mix.left.subarray(0, 307200).every((v) => v === 0));
    assert.ok(mix.left.subarray(307200, 307300).some((v) => v !== 0));
    const p = structuredClone(events);
    p.events[1].sync = 'pcenter';
    assert.equal(mixEvents(p).placements[0].start, 307200 - VOICES['hit.low'].pcenter);
    p.events[1].audio = 'gong.big';
    assert.throws(() => mixEvents(p), /不在音色库里/);
  });

  test('WAV 读写：浮点往返逐样本相同；16 位单声道复制成两声道；非 48000 Hz 拒收', () => {
    const src = { left: Float32Array.from([0, 0.5, -0.25]), right: Float32Array.from([1, -1, 0.125]) };
    const back = readWav(writeWav(src));
    assert.deepEqual([...back.left], [...src.left]);
    assert.deepEqual([...back.right], [...src.right]);
    const pcm = writeWav(src);
    pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt16LE(16, 34);
    pcm.writeInt16LE(16384, 44); pcm.writeInt16LE(-32768, 46);
    const mono = readWav(pcm);
    assert.equal(mono.left[0], 0.5);
    assert.equal(mono.right[1], -1);
    const r44 = writeWav(src);
    r44.writeUInt32LE(44100, 24);
    assert.throws(() => readWav(r44), /48000/);
  });

  test('外部音轨：按帧号挂到采样点，带增益', () => {
    const p = join(root, 'ext.wav');
    writeFileSync(p, writeWav({ left: Float32Array.from([0.5, 0.5]), right: Float32Array.from([0.25, 0.25]) }));
    const ev = { format: 'events/0.1', film: 'f', fps: '30/1', frames: 60, events: [] };
    const mix = mixEvents(ev, { tracks: [{ path: p, at: 30, gainDb: -6.0206 }] });
    assert.equal(mix.placements[0].sample, 48000);
    assert.ok(Math.abs(mix.left[48000] - 0.25) < 1e-4 && Math.abs(mix.right[48001] - 0.125) < 1e-4);
    assert.equal(mix.left[47999], 0);
  });

  test('MP4 顶层盒子与 faststart 判定', () => {
    const box = (type, len = 8) => { const b = Buffer.alloc(len); b.writeUInt32BE(len, 0); b.write(type, 4, 'latin1'); return b; };
    assert.deepEqual(topLevelBoxes(Buffer.concat([box('ftyp', 16), box('moov'), box('mdat', 12)])), ['ftyp', 'moov', 'mdat']);
    assert.equal(isFaststart(Buffer.concat([box('ftyp'), box('moov'), box('mdat')])), true);
    assert.equal(isFaststart(Buffer.concat([box('ftyp'), box('mdat'), box('moov')])), false);
  });

  test('联系表抽帧：等分取中，300 帧取 12 张', () => {
    assert.deepEqual(contactFrames(300), [12, 37, 62, 87, 112, 137, 162, 187, 212, 237, 262, 287]);
    assert.deepEqual(contactFrames(3), [0, 1, 2]);
  });
});

describe('真实 ffmpeg：分流、收尾、硬切', NEED_FFMPEG, () => {
  const one = (pattern, colorRef, extra = {}) => ({ shots: [{ id: 's01', in: 0, out: 4, colorRef, pattern }], size: [64, 36], fps: '30/1', ...extra });

  test('scene 分流：线性 0.18 → 对数整形 → 合成 .cube（四面体，路径带特殊字符）→ Y 码值对得上', () => {
    const g = stitchGraph(one(fx.gray, 'scene', { view: { lutPath: fx.identity, shaper: SHAPER } }));
    assert.match(g.filter, /lut3d=file=.+:interp=tetrahedral/);
    const raw = renderRaw(g);
    assert.equal(raw.length, ((64 * 36 * 3) / 2) * 4);
    const expected = 16 + 219 * shaperValue(0.18, SHAPER);
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(lumaMean(raw, [64, 36], k) - expected) <= 1, `第 ${k} 帧 Y=${lumaMean(raw, [64, 36], k)}，期望 ${expected}`);
  });

  test('display 分流：线性 0.18 只做 sRGB 编码（Y≈117），不过整形和查找表；sRGB PNG 直通（Y≈126）', () => {
    const g = stitchGraph(one(fx.gray, 'display', { view: { lutPath: fx.identity, shaper: SHAPER } }));
    assert.ok(!/lut3d|log\(/.test(g.filter));
    const y = lumaMean(renderRaw(g), [64, 36], 0);
    assert.ok(Math.abs(y - (16 + 219 * srgbEncode(0.18))) <= 1, `Y=${y}`);
    const yp = lumaMean(renderRaw(stitchGraph(one(fx.grayPng, 'display'))), [64, 36], 0);
    assert.ok(Math.abs(yp - (16 + (219 * 128) / 255)) <= 1, `Y=${yp}`);
  });

  test('收尾层关掉（grain=0、vignette=0）：滤镜图里没有收尾滤镜，逐像素等于分流后输入', () => {
    const view = { lutPath: fx.identity, shaper: SHAPER };
    const off = stitchGraph(one(fx.gray, 'scene', { view, finish: { grain: 0, vignette: 0 } }));
    const bare = stitchGraph(one(fx.gray, 'scene', { view, finishOff: true }));
    assert.ok(!/vignette|noise/.test(off.filter));
    const a = renderRaw(off), b = renderRaw(bare);
    assert.equal(sha(a), sha(b));
    const on = renderRaw(stitchGraph(one(fx.gray, 'scene', { view, finish: { grain: 0.04, vignette: 0.2 }, seed: 7 })));
    assert.notEqual(sha(on), sha(a));
  });

  test('颗粒确定性：同种子逐位相同，换种子不同，逐帧变化', () => {
    const spec = (seed) => one(fx.gray, 'display', { finish: { grain: 0.04, vignette: 0 }, seed });
    const a = renderRaw(stitchGraph(spec(7802))), b = renderRaw(stitchGraph(spec(7802))), c = renderRaw(stitchGraph(spec(7803)));
    assert.equal(sha(a), sha(b));
    assert.notEqual(sha(a), sha(c));
    const frame = (64 * 36 * 3) / 2;
    assert.notEqual(sha(a.subarray(0, frame)), sha(a.subarray(frame, 2 * frame)));
  });

  test('两镜头硬切（scene + display）：帧数相加，切点正好在第 2 帧换画面', () => {
    const shots = [
      { id: 'a', in: 0, out: 2, colorRef: 'scene', pattern: fx.gray },
      { id: 'b', in: 2, out: 4, colorRef: 'display', pattern: fx.gray },
    ];
    const raw = renderRaw(stitchGraph({ shots, size: [64, 36], fps: '30/1', view: { lutPath: fx.identity, shaper: SHAPER }, transitions: [{ id: 'c', at: 2, type: 'cut' }] }));
    const ys = [0, 1, 2, 3].map((k) => lumaMean(raw, [64, 36], k));
    assert.equal(raw.length, ((64 * 36 * 3) / 2) * 4);
    assert.ok(Math.abs(ys[1] - (16 + 219 * shaperValue(0.18, SHAPER))) <= 1 && Math.abs(ys[2] - (16 + 219 * srgbEncode(0.18))) <= 1, ys.join(','));
  });

  test('母版编码：ffprobe 逐字段核 BT.709 有限范围四项、yuv420p、帧数与时长', () => {
    const shots = [
      { id: 'a', in: 0, out: 2, colorRef: 'scene', pattern: fx.gray },
      { id: 'b', in: 2, out: 4, colorRef: 'display', pattern: fx.gray },
    ];
    const graph = stitchGraph({ shots, size: [64, 36], fps: '30/1', view: { lutPath: fx.warm, shaper: SHAPER } });
    const out = join(root, 'enc.mp4');
    encode({ graph, outputs: [{ preset: 'h264-crf14-bt709', path: out }] });
    const p = probeMedia(out);
    assert.deepEqual(
      [p.video.codec, p.video.pixFmt, p.video.colorRange, p.video.colorSpace, p.video.colorPrimaries, p.video.colorTransfer, p.video.frames, p.video.rate],
      ['h264', 'yuv420p', 'tv', 'bt709', 'bt709', 'bt709', 4, '30/1'],
    );
    assert.ok(Math.abs(p.video.duration - 4 / 30) < 1 / 60);
    assert.equal(p.audio, null);
  });
});

describe('真实 ffmpeg：母带与交付六件套', NEED_FFMPEG, () => {
  test('film-min 事件音轨母带：ebur128 集成响度在 [−15, −13] LUFS、真峰值 ≤ −1 dBTP，起音点不漂（互相关滞后 0 个采样点）', () => {
    const work = mkdtempSync(join(root, 'audio-'));
    const mix = mixEvents(eventsTable(FILM_MIN));
    const m = masterAudio(mix, work, { loudness: -14, truePeak: -1 });
    assert.equal(m.silent, false);
    const meas = measureLoudness(m.path);
    assert.ok(meas.integrated >= -15 && meas.integrated <= -13, `I=${meas.integrated}`);
    assert.ok(meas.truePeak <= -1, `TP=${meas.truePeak}`);
    const w = readWav(readFileSync(m.path));
    assert.equal(w.left.length, 480000);
    // 4 倍升降采样的 sinc 滤波在起音前留一点预振铃：起音前 1 毫秒以外必须全零，1 毫秒以内低于 −40 dBFS
    assert.ok(w.left.subarray(0, 307200 - 48).every((v) => v === 0));
    assert.ok(w.left.subarray(307200 - 48, 307200).every((v) => Math.abs(v) < 0.01));
    const gain = 10 ** (m.passes.at(-1).gainDb / 20);
    let best = null;
    for (let lag = -8; lag <= 8; lag++) {
      let e = 0;
      for (let i = 307200; i < 309200; i++) e += (w.left[i + lag] - mix.left[i] * gain) ** 2;
      if (!best || e < best.e) best = { lag, e };
    }
    assert.equal(best.lag, 0);
  });

  test('限制器真的压峰：安静的音底加尖峰，归一要抬 6 dB 以上（尖峰 0.9 抬过天花板 0.74），真峰值仍压在天花板（−2.6 dBTP）附近、不过 −1 dBTP', () => {
    const n = 4 * 48000;
    const left = new Float32Array(n);
    for (let i = 0; i < n; i++) left[i] = 0.05 * Math.sin((2 * Math.PI * 1000 * i) / 48000) + (i % 24000 < 48 ? 0.9 : 0);
    const work = mkdtempSync(join(root, 'limit-'));
    const m = masterAudio({ left, right: Float32Array.from(left), length: n }, work, { loudness: -14, truePeak: -1 });
    assert.ok(m.passes[1].gainDb > 6, `增益 ${m.passes[1].gainDb} dB`);
    assert.equal(m.ceilingDb, -2.6);
    const meas = measureLoudness(m.path);
    assert.ok(meas.integrated >= -15 && meas.integrated <= -13, `I=${meas.integrated}`);
    assert.ok(meas.truePeak <= -2.0, `TP=${meas.truePeak}`);
  });

  let first;
  test('交付 film-min（320×180）：六件套齐全、SHA-256 独立复算通过、母版四项标注与响度实测达标', () => {
    const film = smallFilm();
    const out = join(root, 'deliver-a');
    first = deliver({ film, events: eventsTable(film), lock: lockFor(fx.warm), frames: framesFor(), view: { lutPath: fx.warm, shaper: SHAPER }, outDir: out });
    assert.deepEqual(Object.keys(first.files).sort(), Object.values(PIECES).sort());
    const v = verifyDeliveryBundle(out, { reportSha256: first.files['report.json'].sha256 });
    assert.equal(Object.keys(v.files).length, 6);
    for (const [k, f] of Object.entries(first.files)) assert.equal(v.files[k].sha256, f.sha256);
    const pm = probeMedia(join(out, 'master.mp4'));
    assert.deepEqual([pm.video.colorRange, pm.video.colorSpace, pm.video.colorPrimaries, pm.video.colorTransfer, pm.video.pixFmt, pm.video.frames], ['tv', 'bt709', 'bt709', 'bt709', 'yuv420p', 300]);
    assert.ok(Math.abs(pm.video.duration - 10) < 1 / 60);
    assert.deepEqual([pm.audio.codec, pm.audio.sampleRate, pm.audio.channels], ['aac', 48000, 2]);
    const pw = probeMedia(join(out, 'web.mp4'));
    assert.deepEqual([pw.video.colorRange, pw.video.colorSpace, pw.video.colorPrimaries, pw.video.colorTransfer, pw.video.frames], ['tv', 'bt709', 'bt709', 'bt709', 300]);
    assert.ok(isFaststart(readFileSync(join(out, 'web.mp4'))));
    const loud = measureLoudness(join(out, 'master.mp4'));
    assert.ok(loud.integrated >= -15 && loud.integrated <= -13 && loud.truePeak <= -1, JSON.stringify(loud));
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    assert.equal(report.ok, true);
    assert.ok(report.checks.length >= 25);
    const run = readFileSync(join(out, 'run.json'), 'utf8');
    assert.ok(!run.includes(root), 'run.json 里不得有本机路径');
    assert.deepEqual(readFileSync(join(out, 'film.lock')), Buffer.from(`${JSON.stringify(lockFor(fx.warm), null, 2)}\n`));
    const png = readFileSync(join(out, 'contact.png'));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 540]);
  });

  test('M09/S03 同锁重建传入外部 seed 与事件表路径，六件仍逐字节相同', () => {
    const film = smallFilm();
    const events = join(root, 'events.json');
    writeFileSync(events, JSON.stringify(eventsTable(film)));
    const again = deliver({ film, events, seed: 5, lock: lockFor(fx.warm), frames: framesFor(), view: { lutPath: fx.warm, shaper: SHAPER }, outDir: join(root, 'deliver-b') });
    assert.deepEqual(again.files, first.files);
    const run = JSON.parse(readFileSync(join(again.dir, 'run.json')));
    assert.deepEqual(run.finish.filters.map((f) => f.yuv), [7802, 7803].map((n) => `noise=all_seed=${n}:c0s=4:c0f=t`));
  });

  test('M07 默认复验逐件检出删除、单字节修改和缩减交付清单', () => {
    const dir = first.dir;
    const verify = () => verifyDeliveryBundle(dir);
    const reject = () => assert.throws(verify, code('contract.delivery-mismatch'));
    assert.throws(() => verifyDeliveryBundle(dir, { reportSha256: '0'.repeat(64) }), code('contract.delivery-mismatch'));
    for (const name of Object.values(PIECES)) {
      const path = join(dir, name), bytes = readFileSync(path);
      try {
        unlinkSync(path);
        reject();
        const modified = Buffer.from(bytes);
        modified[modified.length - 1] ^= 1;
        if (name === PIECES.report || name === PIECES.run) modified[modified.length - 1] = 32;
        writeFileSync(path, modified);
        reject();
      } finally { writeFileSync(path, bytes); }
    }
    const path = join(dir, PIECES.report), bytes = readFileSync(path);
    const contact = join(dir, PIECES.contact), png = readFileSync(contact);
    try {
      const report = JSON.parse(bytes);
      delete report.files[PIECES.contact];
      report.delivery.contact = false;
      unlinkSync(contact);
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      reject();
    } finally { writeFileSync(contact, png); writeFileSync(path, bytes); }
    assert.deepEqual(verify().files, first.files);
  });

  test('M10 关闭 web/contact 后向原目录重跑，在写入前拒绝冲突', () => {
    const film = smallFilm();
    delete film.delivery.web;
    delete film.delivery.contact;
    assert.throws(() => deliver({ film, events: eventsTable(film), lock: lockFor(fx.warm), frames: framesFor(), view: { lutPath: fx.warm, shaper: SHAPER }, outDir: first.dir }), /输出目录必须为空/);
    assert.deepEqual(verifyDeliveryBundle(first.dir).files, first.files);
  });

  test('交付前置核对：查找表哈希和锁文件不符、事件表不是这部片子的、母版预设不认识，都在出片前拒收', () => {
    const film = smallFilm();
    const base = { film, events: eventsTable(film), frames: framesFor(), view: { lutPath: fx.warm, shaper: SHAPER }, outDir: join(root, 'deliver-x') };
    assert.throws(() => deliver({ ...base, lock: lockFor(fx.identity) }), code('contract.delivery-mismatch'));
    assert.throws(() => deliver({ ...base, lock: lockFor(fx.warm), events: { ...base.events, frames: 299 } }), /对不上/);
    const f2 = structuredClone(film); f2.delivery.master = 'h265-crf18';
    assert.throws(() => deliver({ ...base, film: f2, events: eventsTable(f2), lock: lockFor(fx.warm) }), /不认识/);
    assert.throws(() => deliver({ ...base, lock: lockFor(fx.warm), view: {} }), /view\.lutPath/);
  });
});

function audioDelivery(fps, frames, event, mode = 'script') {
  const film = structuredClone(minimal);
  film.output = { fps, frames, size: [32, 16] };
  film.shots[0].out = frames;
  film.audio = { mode, loudness: -14, truePeak: -1 };
  film.events = event ? [event] : [];
  const lock = structuredClone(LOCK_MIN);
  lock.cards['audio.master'] = LOCK_FULL.cards['audio.master'];
  lock.view['agx-mhc'] = `sha256:${sha(readFileSync(fx.warm))}`;
  return { film, events: eventsTable(film), lock, frames: framesFor(), view: { lutPath: fx.warm, shaper: SHAPER } };
}

describe('独立复核回归', () => {
  test('M01 32×16 的 EXR 超白在原尺寸、放大和缩小后仍为 2，整形后 Y≈181', NEED_FFMPEG, () => {
    const pattern = constantExr(join(root, 'white'), 2, 1, [32, 16]);
    const shots = [{ id: 'hdr', in: 0, out: 1, colorRef: 'scene', pattern }];
    const view = { lutPath: fx.identity, shaper: { mid: 1, minEv: -2, maxEv: 2 } };
    for (const size of [[32, 16], [64, 32], [16, 8]]) {
      const graph = stitchGraph({ shots, size, fps: '30/1', view });
      const prefix = graph.filter.split(",geq=r='clip((log")[0];
      const { stdout } = runTool(tools().ffmpeg, ['-v', 'error', ...graph.inputs.flat(), '-filter_complex', `${prefix}[linear]`, '-map', '[linear]', '-frames:v', '1', '-f', 'rawvideo', '-']);
      assert.equal(stdout.length, size[0] * size[1] * 12);
      for (let at = 0; at < stdout.length; at += 4) assert.equal(stdout.readFloatLE(at), 2);
      assert.ok(renderRaw(graph).subarray(0, size[0] * size[1]).every((y) => Math.abs(y - 181) <= 1));
    }
  });

  test('M02 终渲传入硬编在读取输入和创建输出之前报参数错误', () => {
    const outDir = join(root, 'bad-hw');
    assert.throws(() => deliver({ tier: 'final', hwEncoder: 'h264_nvenc', outDir }), (e) => code('usage.bad-argument')(e) && /终渲/.test(e.message));
    assert.equal(existsSync(outDir), false);
  });

  test('M03 空事件表交付精确长度的双声道全零母带和静音 AAC', NEED_FFMPEG, () => {
    const base = audioDelivery('30/1', 60);
    const mix = mixEvents({ ...base.events, frames: 300 });
    const m = masterAudio(mix, mkdtempSync(join(root, 'silence-')));
    assert.equal(m.silent, true);
    const wav = readWav(readFileSync(m.path));
    for (const ch of [wav.left, wav.right]) {
      assert.equal(ch.length, 480000);
      assert.ok(ch.every((v) => v === 0));
    }
    const bundle = deliver({ ...base, outDir: join(root, 'silent-film') });
    assert.equal(bundle.report.ok, true);
    assert.equal(measureLoudness(join(bundle.dir, PIECES.master)).truePeak, -Infinity);
    assert.equal(probeMedia(join(bundle.dir, PIECES.master)).audio.channels, 2);
  });

  test('M04 riser 从第 0 或 90 帧起音，显式峰值对齐命中最大振幅', () => {
    for (const frame of [0, 90]) {
      const film = smallFilm();
      film.events = [{ id: 'rise', audio: 'riser', frame, sync: 'onset' }];
      const events = eventsTable(film);
      const mix = mixEvents(events), sample = 1600 * frame;
      assert.equal(mix.placements[0].start, sample);
      assert.equal(mix.left.findIndex((v) => v !== 0), sample + 1);
      if (frame === 90) {
        const peak = mixEvents(events, { sync: 'peak' });
        assert.equal(peak.left.reduce((max, v, i, a) => Math.abs(v) > Math.abs(a[max]) ? i : max, 0), sample);
      }
    }
  });

  for (const [fps, frames] of [['27/1', 54], ['30/1', 66], ['30/1', 300]]) {
    test(`M05 ${fps} 共 ${frames} 帧，仅末帧 hit.low 的 WAV、母版与网页片 AAC 均达标`, NEED_FFMPEG, () => {
      const film = smallFilm();
      film.output.size = [40, 24];
      film.delivery = { master: 'h264-crf14-bt709', web: true };
      film.events = [{ id: 'last', frame: frames - 1, audio: 'hit.low', sync: 'onset' }];
      const base = frames !== 300 ? audioDelivery(fps, frames, film.events[0]) : { film, events: eventsTable(film), lock: lockFor(fx.warm), frames: framesFor(), view: { lutPath: fx.warm, shaper: SHAPER } };
      base.film.delivery = { master: 'h264-crf14-bt709', web: true };
      const bundle = deliver({ ...base, outDir: join(root, `last-${fps.replace('/', '_')}-${frames}`) });
      const run = JSON.parse(readFileSync(join(bundle.dir, PIECES.run)));
      assert.equal(run.steps[0].placements[0].sample, Math.round((frames - 1) * 48000 * parseFps(fps).den / parseFps(fps).num));
      for (const m of [
        run.steps[0].passes.at(-1),
        measureLoudness(join(bundle.dir, PIECES.master)),
        measureLoudness(join(bundle.dir, PIECES.web)),
      ]) {
        assert.ok(m.integrated >= -15 && m.integrated <= -13 && m.truePeak <= -1, JSON.stringify(m));
      }
    });
  }

  test('M06 track 模式已有 WAV 与带声事件并存，只交付给定音轨', NEED_FFMPEG, () => {
    const base = audioDelivery('24/1', 48, { id: 'hit', frame: 12, audio: 'hit.low' }, 'track');
    const track = join(root, 'tone.wav');
    ff(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=2', track]);
    const tracks = [{ path: track, at: 0 }];
    const mix = mixEvents(base.events, { mode: 'track', bed: 'room', tracks });
    assert.deepEqual(mix.left, readWav(readFileSync(track)).left);
    const bundle = deliver({ ...base, tracks, bed: 'room', outDir: join(root, 'track') });
    const run = JSON.parse(readFileSync(join(bundle.dir, PIECES.run)));
    assert.deepEqual(run.steps[0].placements.map((p) => [p.audio, p.sample]), [['track', 0]]);
  });

  test('M08 冻结 film、events、lock 与配对校验在出片前执行', () => {
    const film = smallFilm(), lock = lockFor(fx.warm), events = eventsTable(film);
    const base = { film, events, lock, outDir: join(root, 'invalid-contract') };
    const check = frozen.validate({ format: 'lock-check/0.1', film, lock });
    assert.deepEqual(check.schemaErrors, []);
    assert.deepEqual(check.violations, {});
    assert.throws(() => deliver({ ...base, lock: { ...lock, view: {} } }), /LK9/);
    assert.throws(() => deliver({ ...base, lock: { ...lock, issuer: 'unknown' } }), /issuer/);
    assert.throws(() => deliver({ ...base, film: { ...film, other: true } }), /film\/3.0/);
    assert.throws(() => deliver({ ...base, events: { ...events, events: [] } }), /EV4/);
    assert.equal(existsSync(base.outDir), false);
  });

  test('M09 未写镜头种子时采用冻结算例派生的颗粒种子', NEED_FFMPEG, () => {
    const base = audioDelivery('24/1', 48);
    base.film.seed = base.lock.seeds.film = 7800;
    base.lock.seeds.s01 = 2013376959;
    base.film.style.finish = { grain: 0.12 };
    base.lock.cards['comp.finish'] = LOCK_FULL.cards['comp.finish'];
    const bundle = deliver({ ...base, seed: 5, outDir: join(root, 'derived') });
    const run = JSON.parse(readFileSync(join(bundle.dir, PIECES.run)));
    assert.match(run.steps.find((s) => s.step === 'encode').args.join(' '), /all_seed=2013376959:c0s=12/);
    base.lock.seeds.s01++;
    assert.throws(() => deliver(base), /LK12/);
  });

  test('M11 子进程启动前拒绝无效超时，有限正整数实际生效', () => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5]) {
      assert.throws(() => runTool('missing-comp-tool', [], { timeoutMs }), code('usage.bad-argument'));
    }
    assert.throws(() => runTool(process.execPath, ['-e', 'setTimeout(()=>{},1000)'], { timeoutMs: 20 }), code('timeout.ffmpeg'));
  });

  test('S01 四个交付错误码的错误信封符合冻结登记和退出码', () => {
    for (const [name, exitCode] of [['env.ffmpeg-missing', 3], ['timeout.ffmpeg', 124], ['failure.ffmpeg', 1], ['contract.delivery-mismatch', 4]]) {
      const envelope = { format: 'envelope/0.1', ok: false, exitCode, error: { code: name, message: '测试', hint: '检查输入' }, outputs: [], data: {}, diagnostics: [], cost: { tokens: 0, wallMs: 0, gpuSeconds: 0 }, next: [] };
      const r = frozen.validate(envelope);
      assert.deepEqual([r.schemaErrors, r.violations], [[], {}]);
    }
  });

  test('S02/S03 两个公开入口对文件与对象均执行 EV7', () => {
    const base = audioDelivery('24/1', 48, { id: 'hit', frame: 12, audio: 'hit.low' });
    const path = join(root, 'input-events.json');
    writeFileSync(path, JSON.stringify(base.events));
    assert.deepEqual(mixEvents(path), mixEvents(base.events));
    base.events.events[0].frame = 48;
    writeFileSync(path, JSON.stringify(base.events));
    for (const input of [path, base.events]) {
      assert.throws(() => mixEvents(input), /EV7/);
      assert.throws(() => deliver({ ...base, events: input }), /EV7/);
    }
  });

  test('S04 constructor 作为未登记音色给出参数错误', () => {
    const base = audioDelivery('24/1', 48, { id: 'unknown', frame: 0, audio: 'constructor' });
    assert.throws(() => mixEvents(base.events), code('usage.bad-argument'));
  });

  test('场景参考在 25/1、24000/1001、30000/1001 下缩放 120 帧奇偶明暗逐帧零错位', NEED_FFMPEG, () => {
    const seqDir = mkdtempSync(join(root, 'alt-exr-'));
    const pattern = join(seqDir, 'f.%04d.exr');
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=32x16:r=30', '-frames:v', '120',
      '-vf', "format=gbrpf32le,geq=r='if(mod(N,2),2,0.5)':g='if(mod(N,2),2,0.5)':b='if(mod(N,2),2,0.5)'",
      '-c:v', 'exr', '-compression', 'zip16', pattern]);
    const view = { lutPath: fx.identity, shaper: { mid: 1, minEv: -2, maxEv: 2 } };
    for (const fps of ['25/1', '24000/1001', '30000/1001']) {
      const base = audioDelivery(fps, 120);
      base.film.output.size = [46, 22];
      base.film.delivery = { master: 'h264-crf14-bt709', web: true, contact: false };
      base.lock.view['agx-mhc'] = `sha256:${sha(readFileSync(fx.identity))}`;
      const shots = [{ id: 's01', in: 0, out: 120, colorRef: 'scene', pattern }];
      const raw = renderRaw(stitchGraph({ shots, size: [46, 22], fps, view }));
      const frameBytes = 46 * 22 * 1.5;
      assert.equal(raw.length, 120 * frameBytes, fps);
      const bundle = deliver({ ...base, view, frames: { s01: { pattern } }, outDir: join(root, `alt-${fps.replace('/', '_')}`) });
      for (const file of [PIECES.master, PIECES.web]) {
        const decoded = runTool(tools().ffmpeg, ['-v', 'error', '-i', join(bundle.dir, file), '-f', 'rawvideo', '-pix_fmt', 'gray', '-']).stdout;
        assert.equal(decoded.length, 120 * 46 * 22, `${fps} ${file}`);
        for (let f = 0; f < 120; f++) {
          const y = decoded[f * 46 * 22 + 11 * 46 + 23];
          assert.equal(y > 125, f % 2 === 1, `${fps} ${file} frame ${f} got Y=${y}`);
        }
      }
    }
  });
});
