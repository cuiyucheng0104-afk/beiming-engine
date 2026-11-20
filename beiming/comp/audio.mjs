// 合成收尾的声音：只读展开后的事件表（events/0.1），按事件帧号精确到采样点放置音色，混成 48000 Hz 立体声，
// 再做响度归一与真峰值限制。音色库是纯 JS 的确定性合成（带种子的噪声），不依赖任何外部音频文件；
// 也可以挂外部脚本产出的 WAV 音轨。
//
// 口径：
//   采样率 48000 Hz，两声道，样本是 [-1, 1] 的 32 位浮点（满刻度 = 0 dBFS）。
//   事件时刻 → 采样点：round((frame + sub) × 48000 × den / num)。
//   sync=onset 把音色的起音点对到事件采样点；sync=pcenter 把音色的听感重心对上去。
//   各音色听感重心离起音点多远是本模块暂定的数（待探针：听感重心相对起音的提前量），写在 VOICES 里。
//   ebur128 复量四倍过采样限幅后的 48 kHz 母带。短瞬态受限时逐步调整输入增益和峰值余量。
//   最终集成响度落在目标 ±1 LU，真峰值 ≤ truePeak。全零静音保留原始样本。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { CompError, bad, parseFps, runTool, tools } from './stitch.mjs';

const contracts = await loadContracts();

export function checkContract(value, format) {
  if (value?.format !== format) throw bad(`输入须为 ${format}`);
  const { schemaErrors, violations } = contracts.validate(value);
  const issues = [...schemaErrors, ...Object.entries(violations).map(([id, errors]) => `${id} ${errors.join('，')}`)];
  if (issues.length) throw bad(`${format} 契约核对不上：${issues.join('；')}`);
}

export function readEvents(input, film) {
  let events = input;
  if (typeof input === 'string') {
    try { events = JSON.parse(readFileSync(input, 'utf8')); }
    catch (err) { throw bad(`无法读取事件表 ${input}：${err.message}`); }
  }
  if (film) checkContract({ format: 'events-check/0.1', film, events }, 'events-check/0.1');
  else checkContract(events, 'events/0.1');
  return events;
}

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const LIMITER_MARGIN_DB = 1.6;
/** 限制器在 4 倍采样率上做：alimiter 只看样本峰值，升采样后的样本峰值逼近真峰值 */
export const OVERSAMPLE = 4;

/** 带种子的 32 位随机流（mulberry32），出 [-1, 1) 的数 */
export function noise(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const db = (x) => 10 ** (x / 20);

function stereo(length) {
  return { left: new Float32Array(length), right: new Float32Array(length) };
}

/** 往下扫的正弦：f(t) = f1 + (f0 − f1)·e^(−t/τf)，包络 e^(−t/τa)，起音 attack 秒线性上升 */
function sweptHit({ seconds, f0, f1, tauF, tauA, attack, gain, click, seed }) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = stereo(n);
  const rnd = noise(seed);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f = f1 + (f0 - f1) * Math.exp(-t / tauF);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    const env = Math.min(1, t / attack) * Math.exp(-t / tauA);
    const tick = t < 0.004 ? click * rnd() * (1 - t / 0.004) : 0;
    const v = gain * (env * Math.sin(phase) + tick);
    out.left[i] = v;
    out.right[i] = v;
  }
  return out;
}

/** 一阶低通滤过的噪声；cutoff(t) 给截止频率（Hz），env(t) 给包络，pan(t) ∈ [−1, 1] */
function filteredNoise({ seconds, cutoff, env, pan, gain, seed, tone }) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = stereo(n);
  const rnd = noise(seed);
  let y = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const k = 1 - Math.exp((-2 * Math.PI * cutoff(t)) / SAMPLE_RATE);
    y += k * (rnd() - y);
    let v = y;
    if (tone) {
      phase += (2 * Math.PI * tone(t)) / SAMPLE_RATE;
      v += 0.35 * Math.sin(phase);
    }
    v *= gain * env(t);
    const p = pan(t);
    out.left[i] = v * Math.sqrt((1 - p) / 2);
    out.right[i] = v * Math.sqrt((1 + p) / 2);
  }
  return out;
}

/**
 * 音色库。每个音色：make() 出两声道样本；onset 是起音点的样本下标，pcenter 是听感重心的样本下标（暂定，待探针）。
 * onset 从音色开头播放。显式峰值对齐用左右声道的最大绝对振幅定位。
 */
export const VOICES = Object.freeze({
  'hit.low': {
    make: () => sweptHit({ seconds: 1.2, f0: 120, f1: 45, tauF: 0.06, tauA: 0.35, attack: 0.002, gain: 0.9, click: 0.25, seed: 0x1a2b }),
    onset: 0, pcenter: Math.round(0.012 * SAMPLE_RATE),
  },
  'hit.soft': {
    make: () => sweptHit({ seconds: 0.6, f0: 300, f1: 180, tauF: 0.03, tauA: 0.12, attack: 0.005, gain: 0.5, click: 0.08, seed: 0x2b3c }),
    onset: 0, pcenter: Math.round(0.015 * SAMPLE_RATE),
  },
  whoosh: {
    make: () => filteredNoise({
      seconds: 0.9, seed: 0x3c4d, gain: 0.8,
      cutoff: (t) => 300 + 5000 * Math.sin((Math.PI * t) / 0.9) ** 2,
      env: (t) => Math.sin((Math.PI * t) / 0.9) ** 2,
      pan: (t) => -0.6 + (1.2 * t) / 0.9,
    }),
    onset: 0, pcenter: Math.round(0.45 * SAMPLE_RATE),
  },
  riser: {
    make: () => filteredNoise({
      seconds: 2, seed: 0x4d5e, gain: 0.6,
      cutoff: (t) => 400 + 6000 * (t / 2) ** 2,
      env: (t) => (t / 2) ** 2,
      pan: () => 0,
      tone: (t) => 200 + 1400 * (t / 2) ** 2,
    }),
    onset: 0, pcenter: 2 * SAMPLE_RATE,
  },
});

/** 垫底：silence 是全零；room 是 −60 dBFS 左右的低通噪声，整片铺满 */
export function bed(kind, length, seed = 0x5e6f) {
  const out = stereo(length);
  if (kind === 'silence' || kind == null) return out;
  if (kind !== 'room') throw bad(`垫底只有 silence、room，给的是 ${kind}`);
  const l = noise(seed), r = noise(seed + 1);
  let yl = 0, yr = 0;
  const k = 1 - Math.exp((-2 * Math.PI * 800) / SAMPLE_RATE);
  for (let i = 0; i < length; i++) {
    yl += k * (l() - yl);
    yr += k * (r() - yr);
    out.left[i] = yl * db(-52);
    out.right[i] = yr * db(-52);
  }
  return out;
}

/** 全片时长（采样点）：frames × 48000 × den / num，四舍五入 */
export function filmSamples(frames, fps) {
  const { num, den } = parseFps(fps);
  return Math.round((frames * SAMPLE_RATE * den) / num);
}

/** 事件时刻 → 采样点 */
export function eventSample(frame, sub, fps) {
  const { num, den } = parseFps(fps);
  return Math.round(((frame + (sub ?? 0)) * SAMPLE_RATE * den) / num);
}

function addInto(mix, src, at, gain = 1) {
  const from = Math.max(0, -at);
  const to = Math.min(src.left.length, mix.left.length - at);
  for (let i = from; i < to; i++) {
    mix.left[at + i] += src.left[i] * gain;
    mix.right[at + i] += src.right[i] * gain;
  }
  return { from, to, clippedHead: from, clippedTail: src.left.length - Math.max(from, to) };
}

/**
 * 按事件表混音。只读 events/0.1 里带 audio 的条目。
 * input 接受文件路径或展开表对象。mode=track 只放给定 tracks。
 * 混音选项 sync='peak' 以实际峰值对齐；事件文件仍使用冻结的 onset/pcenter 枚举。
 * 返回 { left, right, placements: [{ id, audio, sync, frame, sample, start }], length }
 */
export function mixEvents(input, { bed: bedKind = 'silence', tracks = [], mode = 'script', sync: alignment } = {}) {
  const events = readEvents(input);
  if (!['script', 'track'].includes(mode)) throw bad(`未知混音模式 ${mode}`);
  if (alignment !== undefined && alignment !== 'peak') throw bad('显式峰值对齐只收 peak');
  const length = filmSamples(events.frames, events.fps);
  const mix = bed(mode === 'track' ? 'silence' : bedKind, length);
  const placements = [];
  const cache = new Map();
  for (const e of mode === 'track' ? [] : events.events) {
    if (!e.audio) continue;
    if (!Object.hasOwn(VOICES, e.audio)) throw bad(`事件 ${e.id} 要的音色 ${e.audio} 不在音色库里：只有 ${Object.keys(VOICES).join('、')}`);
    const voice = VOICES[e.audio];
    if (!cache.has(e.audio)) {
      const samples = voice.make();
      let peak = 0;
      if (alignment === 'peak') {
        const level = (i) => Math.max(Math.abs(samples.left[i]), Math.abs(samples.right[i]));
        for (let i = 1; i < samples.left.length; i++) if (level(i) > level(peak)) peak = i;
      }
      cache.set(e.audio, { samples, peak });
    }
    const { samples, peak } = cache.get(e.audio);
    const sync = alignment ?? e.sync;
    const sample = eventSample(e.frame, e.sub, events.fps);
    const start = sample - (sync === 'peak' ? peak : voice[sync]);
    const r = addInto(mix, samples, start);
    placements.push({ id: e.id, audio: e.audio, sync, frame: e.frame, sample, start, clippedHead: r.clippedHead, clippedTail: r.clippedTail });
  }
  for (const t of tracks) {
    if (!Number.isInteger(t.at) || t.at < 0) throw bad(`外部音轨的 at 必须是非负整数帧号，给的是 ${t.at}`);
    const wav = readWav(readFileSync(t.path));
    const start = eventSample(t.at, 0, events.fps);
    const r = addInto(mix, wav, start, db(t.gainDb ?? 0));
    placements.push({ id: `track.${placements.length}`, audio: 'track', sync: 'onset', frame: t.at, sample: start, start, clippedHead: r.clippedHead, clippedTail: r.clippedTail });
  }
  return { left: mix.left, right: mix.right, length, placements };
}

/** 两声道浮点样本 → 32 位浮点 WAV 字节 */
export function writeWav({ left, right }) {
  const n = left.length;
  const data = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) {
    data.writeFloatLE(left[i], i * 8);
    data.writeFloatLE(right[i], i * 8 + 4);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(3, 20);
  head.writeUInt16LE(CHANNELS, 22);
  head.writeUInt32LE(SAMPLE_RATE, 24);
  head.writeUInt32LE(SAMPLE_RATE * CHANNELS * 4, 28);
  head.writeUInt16LE(CHANNELS * 4, 32);
  head.writeUInt16LE(32, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** WAV 字节 → 两声道浮点样本。收 PCM 16、24、32 位整数和 32 位浮点，单声道复制成两声道；采样率必须是 48000 Hz */
export function readWav(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw bad('不是 WAV 文件');
  let at = 12, fmt = null, data = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    at = body + size + (size & 1);
  }
  if (!fmt || !data) throw bad('WAV 缺 fmt 或 data 段');
  if (fmt.rate !== SAMPLE_RATE) throw bad(`WAV 的采样率是 ${fmt.rate} Hz，只收 ${SAMPLE_RATE} Hz`);
  if (fmt.channels !== 1 && fmt.channels !== 2) throw bad(`WAV 只收单声道或两声道，给的是 ${fmt.channels} 声道`);
  const bytes = fmt.bits / 8;
  const read = fmt.format === 3 && fmt.bits === 32 ? (o) => data.readFloatLE(o)
    : fmt.format === 1 && fmt.bits === 16 ? (o) => data.readInt16LE(o) / 32768
      : fmt.format === 1 && fmt.bits === 24 ? (o) => data.readIntLE(o, 3) / 8388608
        : fmt.format === 1 && fmt.bits === 32 ? (o) => data.readInt32LE(o) / 2147483648
          : null;
  if (!read) throw bad(`WAV 的样本格式不支持（格式码 ${fmt.format}，${fmt.bits} 位）`);
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const out = stereo(frames);
  for (let i = 0; i < frames; i++) {
    const o = i * bytes * fmt.channels;
    out.left[i] = read(o);
    out.right[i] = fmt.channels === 2 ? read(o + bytes) : out.left[i];
  }
  return out;
}

/** 用 ffmpeg ebur128 量一个文件（第一条音频流）：{ integrated: LUFS, truePeak: dBTP }；全零的 truePeak 是 −Infinity */
export function measureLoudness(file, { timeoutMs } = {}) {
  const { stderr } = runTool(tools().ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', 'ebur128=peak=true', '-f', 'null', '-'], { timeoutMs, what: `量响度 ${file}` });
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const i = /\bI:\s*(-?[\d.]+|-inf|nan)\s*LUFS/.exec(summary);
  const p = /True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(summary);
  if (!i || !p) throw new CompError('failure.ffmpeg', `ebur128 没有交出汇总：${file}`);
  const val = (s) => (s === '-inf' || s === 'nan' ? -Infinity : Number(s));
  return { integrated: val(i[1]), truePeak: val(p[1]) };
}

function scaled({ left, right }, gain) {
  const l = new Float32Array(left.length), r = new Float32Array(right.length);
  for (let i = 0; i < left.length; i++) {
    l[i] = left[i] * gain;
    r[i] = right[i] * gain;
  }
  return { left: l, right: r };
}

/**
 * 母带：响度归一 + 真峰值限制。mix 是 mixEvents 的结果，workDir 放中间文件。
 * target：{ loudness: LUFS（默认 −14）, truePeak: dBTP（默认 −1） }
 * 返回 { path, passes: [{ gainDb, integrated, truePeak }], integrated, truePeak, silent, ceilingDb }
 */
export function masterAudio(mix, workDir, { loudness = -14, truePeak = -1, timeoutMs } = {}) {
  if (!Number.isFinite(loudness) || !Number.isFinite(truePeak)) throw bad('audio.loudness、audio.truePeak 必须是有限数');
  const rawPath = join(workDir, 'mix.wav');
  writeFileSync(rawPath, writeWav(mix));
  const first = measureLoudness(rawPath, { timeoutMs });
  const passes = [{ step: 'measure', gainDb: 0, ...first }];
  const out = join(workDir, 'master.wav');
  let ceilingDb = truePeak - LIMITER_MARGIN_DB;
  if (first.truePeak === -Infinity) {
    writeFileSync(out, writeWav(mix));
    return { path: out, passes, ...first, silent: true, ceilingDb };
  }
  let limit = db(ceilingDb);
  if (limit < 0.0625 || limit > 1) throw bad(`限制器天花板 ${ceilingDb.toFixed(2)} dBTP 超出 alimiter 的范围`);
  let gainDb = loudness - first.integrated;
  let last = first;
  for (let pass = 1; pass <= 10; pass++) {
    const pre = join(workDir, 'gain.wav');
    writeFileSync(pre, writeWav(scaled(mix, db(gainDb))));
    runTool(tools().ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', pre,
      '-af', `aresample=${SAMPLE_RATE * OVERSAMPLE},alimiter=limit=${limit.toFixed(6)}:attack=5:release=50:level=false:latency=true,aresample=${SAMPLE_RATE}`,
      '-c:a', 'pcm_f32le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-bitexact', '-map_metadata', '-1', out], { timeoutMs, what: '限制器' });
    last = measureLoudness(out, { timeoutMs });
    passes.push({ step: `limit-${pass}`, gainDb, ...last });
    const error = loudness - last.integrated;
    // ebur128 精确到 0.1 LU，给 AAC 复量在 ±1 LU 验收窗内留出 0.2 LU。
    if (last.integrated >= loudness - 0.8 && last.integrated <= loudness + 0.8 && last.truePeak <= truePeak) break;
    // 瞬态已经受限时，再推输入增益作用很小。按实测峰值逐步使用预留余量。
    if (pass < 10 && pass >= 3 && error > 0.5 && last.truePeak >= ceilingDb - 0.3) {
      ceilingDb = Math.min(truePeak - 0.3, ceilingDb + 0.3);
      limit = db(ceilingDb);
    }
    gainDb += error;
  }
  for (let trim = 1; trim <= 4 && Math.abs(last.integrated - loudness) <= 1 && last.truePeak <= truePeak; trim++) {
    const aacPeak = Math.max(
      ...['320k', '192k'].map((bitrate) => {
        const aac = join(workDir, `aac-${bitrate}.m4a`);
        runTool(tools().ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', out,
          '-c:a', 'aac', '-b:a', bitrate, '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), aac], { timeoutMs, what: 'AAC 真峰值预检' });
        return measureLoudness(aac, { timeoutMs }).truePeak;
      }),
    );
    if (aacPeak <= truePeak) break;
    const stepDb = Math.max(-0.5, Math.min(-0.1, truePeak - aacPeak - 0.1));
    writeFileSync(out, writeWav(scaled(readWav(readFileSync(out)), db(stepDb))));
    last = measureLoudness(out, { timeoutMs });
    passes.push({ step: `aac-trim-${trim}`, gainDb: stepDb, ...last });
  }
  if (Math.abs(last.integrated - loudness) > 1 || last.truePeak > truePeak) {
    throw new CompError('contract.delivery-mismatch',
      `母带不达标：集成响度 ${last.integrated} LUFS（目标 ${loudness} ± 1），真峰值 ${last.truePeak} dBTP（上限 ${truePeak}）`);
  }
  return { path: out, passes, integrated: last.integrated, truePeak: last.truePeak, silent: false, ceilingDb };
}
