// 时间遥测：在八分之一分辨率的亮度平面上读帧间运动能量、横向运动重心、硬切、静止段、亮度分位与闪烁，外加可选的声音摘要。
//   telemetry(input, request)   同步执行；input 三选一：
//     { width, height, frames, fps?, rangeMode? }  亮度平面序列，每帧是长 width × height 的类型化数组，行优先、原点左上
//     { kinematics }                               engine/render/events.mjs 写出的 kinematics.json 对象，读 tracks.screen
//     { videoPath, scaleDiv?, width?, height?, fps? }  视频文件，由 ffmpeg 缩到 1/scaleDiv（缺省 8，边长取偶数且不小于 32）后抽亮度平面；
//                                                  width、height 直接指定平面像素数；fps 只照抄进回答，不探测
//     三种都可带 audio: { loudnessLufs?, truePeakDbtp?, events?, onsets? }，events 与 onsets 成对给，每项是帧号或带 frame 的对象
//   request.range: [起帧, 止帧]（含端点）只摘要这一段；切点与静止的判定仍按整段序列的统计量。
// 口径：rangeMode 是平面的码值范围，tv（16 到 235，缺省）、full（0 到 255）、linear（0 到 1 的浮点，Float32Array 的缺省）；
//   亮度、对比度（p95 减 p05）、分位数、帧间差都归一化到 0 到 1；motion 是帧间差除以 max(0.025, 第 92 百分位 × 1.35) 后钳到 1；
//   横向重心 -1 是画面最左、1 是最右，只在帧间差超过 0.018 的像素上按差值加权，再做 0.35 比 0.65 的指数平滑。
// 算法与 engine/render/events.mjs 的 kinematics 一致：平面先做 3×3 均值再求帧间绝对差；差值大于 0.065 且大于前后邻帧较小者（不低于 0.012）的 3.8 倍判硬切，
//   硬切帧的 motion 沿用前一帧；差值小于 max(0.0018, 中位数 × 0.18) 判静止。
// 成功返回 { ok: true, source, fps, size, range, frames, detectedCuts, holdSpans, holdFrames, motion, motionPan, luma, contrast, lumaPercentiles?, flicker, audio?, counts, truncated }：
//   holdSpans   [[起帧, 止帧], ...]，连续至少 2 帧静止；holdFrames 是静止帧总数
//   motionPan   只看连续运动帧（不是硬切、不静止、不在闪烁段里）：start、end 是首末运动帧的重心，frames 是这两帧的帧号
//   flicker     平均亮度的一阶差分正负交替且两步都超过 0.04 算一次逐帧翻转（硬切帧与其后一帧不计）；另检隔帧频闪（步长 2 交替且跨度内无硬切）；
//               连续至少 3 次翻转成一段 spans，reversalRate 是翻转次数除以（帧数 - 2），maxAmplitude 是翻转两侧较小那一步的最大值
//   audio       响度、真峰值照抄；onsetOffsets 的 delta 是离事件最近的起音帧减事件帧（正数是声音晚到），maxOnsetFrameDelta 取绝对值最大的
// 参数不对返回 { ok: false, error: { code, message } }，不抛异常；ffmpeg 的错误码同联系表（env.ffmpeg-missing、timeout.ffmpeg、failure.ffmpeg）。
// 预算：回答序列化后 estimateTokens ≤ 600，只回统计量与截过的列表；列表被截时 truncated 为 true，counts 是截断前的总数。

import { resolve } from 'node:path';
import { fail, fit, runs, shape } from './curves.mjs';
import { runFfmpeg } from './sheet.mjs';

// 归一化帧间差（0 到 1）的阈值，照抄 kinematics 算法
const ACTIVE_DIFF = 0.018;
const PAN_MIN_WEIGHT = 0.25;
const CUT_DIFF = 0.065;
const CUT_RATIO = 3.8;
const CUT_FLOOR = 0.012;
const HOLD_DIFF = 0.0018;
const HOLD_RATIO = 0.18;
// 闪烁：归一化平均亮度的最小翻转步长，与成段所需的连续翻转次数
export const FLICKER_AMPLITUDE = 0.04;
export const FLICKER_REVERSALS = 3;
const HOLD_SPAN_FRAMES = 2;
// 码值范围 → [黑位, 满幅]
const RANGE_MODES = { tv: [16, 219], full: [0, 255], linear: [0, 1] };
// shortcut: 视频的全部平面一次读进内存，上限 512 MiB（1080p 的 1/8 平面约 1.6 万帧）；更长的片子要改成流式读或分段给 range
const VIDEO_BUFFER_BYTES = 512 * 1024 * 1024;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const positiveInt = (v) => Number.isInteger(v) && v > 0;

function planesFromVideo({ videoPath, scaleDiv = 8, width, height }, range) {
  if (typeof videoPath !== 'string' || videoPath === '') throw new Error('videoPath 要是视频文件路径');
  if (!(Number.isFinite(scaleDiv) && scaleDiv >= 1 && scaleDiv <= 32)) throw new Error('scaleDiv 要在 1 到 32 之间，缺省 8');
  const side = (given, axis) => {
    if (given === undefined) return `max(32\\,trunc(round(i${axis}/${scaleDiv})/2)*2)`;
    if (!positiveInt(given)) throw new Error('width、height 要是正整数（亮度平面的像素数）');
    return String(given);
  };
  // 统一转成 tv 范围的 8 位 YUV 再取 Y 平面，每帧一张 PGM，头里自带宽高
  const out = runFfmpeg(['-nostdin', '-v', 'error', '-i', resolve(videoPath), '-map', '0:v:0',
    '-vf', `scale=w=${side(width, 'w')}:h=${side(height, 'h')}:flags=area:out_range=tv,format=yuv420p,extractplanes=y`,
    ...(range ? ['-frames:v', String(range[1] + 1)] : []), '-fps_mode', 'passthrough', '-c:v', 'pgm', '-f', 'image2pipe', '-'], VIDEO_BUFFER_BYTES);
  const frames = [];
  let w = 0, h = 0;
  for (let pos = 0; pos < out.length;) {
    const head = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(out.toString('latin1', pos, pos + 40));
    if (!head) throw new Error('ffmpeg 交回的不是 8 位 PGM 序列');
    [w, h] = [Number(head[1]), Number(head[2])];
    pos += head[0].length;
    frames.push(out.subarray(pos, pos + w * h));
    pos += w * h;
  }
  if (!frames.length) throw new Error('视频里没有可读的帧');
  return { width: w, height: h, frames, rangeMode: 'tv' };
}

function fromPlanes({ width: w, height: h, frames, rangeMode }) {
  if (!positiveInt(w) || !positiveInt(h)) throw new Error('width、height 要是正整数（亮度平面的像素数）');
  if (!Array.isArray(frames) || !frames.length) throw new Error('frames 要是非空的亮度平面数组');
  const mode = rangeMode ?? (frames[0] instanceof Float32Array ? 'linear' : 'tv');
  if (!Object.hasOwn(RANGE_MODES, mode)) throw new Error(`rangeMode 要是 ${Object.keys(RANGE_MODES).join('、')} 之一`);
  const [black, scale] = RANGE_MODES[mode];
  const yLen = w * h, n = frames.length;
  const blur = (src) => {
    const dst = new Float32Array(yLen);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1) * w, y1 = y * w, y2 = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1), x2 = Math.min(w - 1, x + 1);
        dst[y1 + x] = (src[y0 + x0] + src[y0 + x] + src[y0 + x2] + src[y1 + x0] + src[y1 + x] + src[y1 + x2]
          + src[y2 + x0] + src[y2 + x] + src[y2 + x2]) / 9;
      }
    }
    return dst;
  };
  const s = { luma: [], contrast: [], p05: [], p50: [], p95: [], pan: [], motion: new Array(n).fill(0), cut: new Array(n).fill(0), hold: new Array(n).fill(0) };
  const rawDiff = [], hist = new Uint32Array(256);
  let prev = null, lastPan = 0;
  for (const [f, plane] of frames.entries()) {
    if (!ArrayBuffer.isView(plane) || plane.length !== yLen) throw new Error(`第 ${f} 帧要是长 ${yLen} 的类型化数组`);
    hist.fill(0);
    let sum = 0;
    for (let i = 0; i < yLen; i++) {
      const v = Math.min(255, Math.max(0, Math.round((plane[i] - black) * (255 / scale))));
      sum += v;
      hist[v]++;
    }
    const quantile = (q) => {
      for (let i = 0, acc = 0; i < 256; i++) { acc += hist[i]; if (acc >= yLen * q) return i / 255; }
      return 1;
    };
    const [p05, p50, p95] = [quantile(0.05), quantile(0.5), quantile(0.95)];
    s.luma.push(sum / (yLen * 255));
    s.contrast.push(p95 - p05);
    s.p05.push(p05); s.p50.push(p50); s.p95.push(p95);

    const cur = blur(plane);
    let dSum = 0, wxSum = 0, wActive = 0;
    if (prev) {
      for (let i = 0; i < yLen; i++) {
        const d = Math.abs(cur[i] - prev[i]) / scale;
        dSum += d;
        if (d > ACTIVE_DIFF) {
          wxSum += d * (((i % w) / Math.max(1, w - 1)) * 2 - 1);
          wActive += d;
        }
      }
      if (wActive > PAN_MIN_WEIGHT) lastPan = lastPan * 0.35 + (wxSum / wActive) * 0.65;
    }
    if (!Number.isFinite(sum + dSum)) throw new Error(`第 ${f} 帧含非有限亮度`);
    rawDiff.push(dSum / yLen);
    s.pan.push(Math.max(-1, Math.min(1, lastPan)));
    prev = cur;
  }
  // 分离硬切巨跳与连续运动
  const sorted = rawDiff.slice(1).sort((x, y) => x - y);
  const med = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0.01;
  const p92 = sorted.length ? sorted[Math.floor(sorted.length * 0.92)] : 0.05;
  for (let f = 1; f < n; f++) {
    const before = f > 1 ? rawDiff[f - 1] : med, after = f + 1 < n ? rawDiff[f + 1] : med;
    if (rawDiff[f] > CUT_DIFF && rawDiff[f] > Math.max(CUT_FLOOR, Math.min(before, after)) * CUT_RATIO) {
      s.cut[f] = 1;
      s.motion[f] = s.motion[f - 1];
    } else {
      s.motion[f] = Math.min(1, rawDiff[f] / Math.max(0.025, p92 * 1.35));
      if (rawDiff[f] < Math.max(HOLD_DIFF, med * HOLD_RATIO)) s.hold[f] = 1;
    }
  }
  if (n > 1) s.motion[0] = s.motion[1];
  return s;
}

function fromKinematics(kin) {
  const screen = kin?.tracks?.screen;
  if (!isPlain(screen) || !Array.isArray(screen.luma) || !screen.luma.length) throw new Error('kinematics 要有非空的 tracks.screen.luma');
  const n = screen.luma.length;
  const column = (key) => {
    const list = screen[key] ?? new Array(n).fill(0);
    if (!Array.isArray(list) || list.length !== n || !list.every(Number.isFinite)) throw new Error(`kinematics 的 tracks.screen.${key} 要是 ${n} 个有限数`);
    return list;
  };
  const cut = [...column('cut')];
  if (Array.isArray(kin.detectedCuts)) for (const f of kin.detectedCuts) if (Number.isInteger(f) && f >= 0 && f < n) cut[f] = 1;
  return { luma: column('luma'), contrast: column('contrast'), motion: column('motion'), pan: column('x'), cut, hold: column('hold') };
}

function readAudio(audio) {
  if (audio === undefined) return null;
  if (!isPlain(audio)) throw new Error('audio 要是对象：loudnessLufs、truePeakDbtp、events、onsets');
  const head = { loudnessLufs: round(audio.loudnessLufs, 2), truePeakDbtp: round(audio.truePeakDbtp, 2) };
  if (audio.events === undefined && audio.onsets === undefined) return { head, offsets: [] };
  const frameOf = (x) => (isPlain(x) ? x.frame : x);
  if (![audio.events, audio.onsets].every((list) => Array.isArray(list) && list.map(frameOf).every(Number.isFinite))) {
    throw new Error('audio.events 与 audio.onsets 要成对给：数组，每项是帧号或带 frame 的对象');
  }
  const onsets = audio.onsets.map(frameOf);
  const offsets = audio.events.map((e, i) => {
    const frame = frameOf(e);
    const nearest = onsets.reduce((best, o) => (Math.abs(o - frame) < Math.abs(best - frame) ? o : best), Infinity);
    return { id: String(e?.id ?? `#${i}`).slice(0, 24), frame, delta: round(nearest - frame, 3) };
  });
  // 偏得最多的排前面，截断时先丢对得准的
  offsets.sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0));
  return { head: { ...head, events: offsets.length, maxOnsetFrameDelta: offsets.length && offsets[0].delta !== null ? Math.abs(offsets[0].delta) : null }, offsets };
}

/** 时间遥测入口；任何非法输入都返回结构化错误，不抛异常 */
export function telemetry(input, request = {}) {
  try {
    if (!isPlain(input)) throw new Error('要给亮度平面序列（width、height、frames）、{ kinematics } 或 { videoPath }');
    if (!isPlain(request)) throw new Error('request 要是对象');
    const { range } = request;
    if (range !== undefined && !(Array.isArray(range) && range.length === 2 && range.every(Number.isInteger) && range[0] >= 0 && range[0] <= range[1])) {
      throw new Error('range 要是 [起帧, 止帧]：非负整数，起不大于止');
    }
    const audio = readAudio(input.audio);
    let s, source, size, { fps } = input;
    if (input.kinematics !== undefined) {
      s = fromKinematics(input.kinematics);
      source = 'kinematics';
      fps ??= input.kinematics.fps;
      size = input.kinematics.sampleSize;
    } else {
      const planes = input.videoPath !== undefined ? planesFromVideo(input, range) : input;
      s = fromPlanes(planes);
      source = input.videoPath !== undefined ? 'video' : 'planes';
      size = [planes.width, planes.height];
    }
    if (fps !== undefined && !(Number.isFinite(fps) && fps > 0)) throw new Error('fps 要是正数，单位帧每秒');
    const n = s.luma.length;
    const [a, b] = range ?? [0, n - 1];
    if (b >= n) throw new Error(`range 超出序列的 0 到 ${n - 1} 帧`);
    const list = Array.from({ length: b - a + 1 }, (_, i) => a + i);

    const flip = new Uint8Array(n);
    const flip2 = new Uint8Array(n);
    let flips = 0, maxAmplitude = 0;
    for (let f = a + 2; f <= b; f++) {
      if (s.cut[f] || s.cut[f - 1]) continue;
      const d1 = s.luma[f] - s.luma[f - 1], d0 = s.luma[f - 1] - s.luma[f - 2];
      const amplitude = Math.min(Math.abs(d1), Math.abs(d0));
      if (d1 * d0 < 0 && amplitude > FLICKER_AMPLITUDE) {
        flip[f] = 1;
        flips++;
        maxAmplitude = Math.max(maxAmplitude, amplitude);
      }
    }
    // 隔帧频闪（步长 2 交替，例如两帧亮两帧暗），跨度内含硬切或已被逐帧翻转覆盖时不重复计
    for (let f = a + 4; f <= b; f++) {
      if (s.cut[f] || s.cut[f - 1] || s.cut[f - 2] || s.cut[f - 3]) continue;
      const d1 = s.luma[f] - s.luma[f - 2], d0 = s.luma[f - 2] - s.luma[f - 4];
      const amplitude = Math.min(Math.abs(d1), Math.abs(d0));
      if (d1 * d0 < 0 && amplitude > FLICKER_AMPLITUDE) {
        flip2[f] = 1;
        if (!flip[f]) {
          flips++;
          maxAmplitude = Math.max(maxAmplitude, amplitude);
        }
      }
    }
    // 翻转帧的前一帧（隔帧频闪为前两帧）是第一个极值，一并算进闪烁段并合并重叠段
    const rawFlicker = [
      ...runs(flip, FLICKER_REVERSALS).map(([x, y]) => [x - 1, y]),
      ...runs(flip2, FLICKER_REVERSALS).map(([x, y]) => [x - 2, y]),
    ].sort((x, y) => x[0] - y[0]);
    const flickerSpans = [];
    for (const span of rawFlicker) {
      const prev = flickerSpans.at(-1);
      if (prev && span[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], span[1]);
      else flickerSpans.push([...span]);
    }
    const inFlicker = new Uint8Array(n);
    for (const [x, y] of flickerSpans) for (let f = Math.max(0, x); f <= Math.min(n - 1, y); f++) inFlicker[f] = 1;
    const cuts = list.filter((f) => s.cut[f]);
    const holds = runs(s.hold.map((v, f) => v && f >= a && f <= b), HOLD_SPAN_FRAMES);
    const moving = list.filter((f) => f > 0 && !s.cut[f] && !s.hold[f] && !inFlicker[f]);

    const stat = (values, frames = list) => {
      if (!frames.length) return { min: null, max: null, mean: null };
      let min = Infinity, max = -Infinity, sum = 0;
      for (let i = 0; i < frames.length; i++) {
        const v = values[frames[i]];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      return { min: round(min), max: round(max), mean: round(sum / frames.length) };
    };
    const turns = (values, frames, kinds, cap) => shape(frames.map((f) => values[f])).peaks.filter((p) => kinds.includes(p.kind))
      .sort((x, y) => y.prominence - x.prominence).slice(0, cap).sort((x, y) => x.index - y.index)
      .map((p) => ({ frame: frames[p.index], value: round(values[frames[p.index]]) }));
    const fixed = {
      ok: true, source, fps: fps ?? null, size: Array.isArray(size) ? size.slice(0, 2) : null, range: [a, b], frames: list.length,
      luma: stat(s.luma), contrast: stat(s.contrast),
      ...(s.p05 && { lumaPercentiles: { p05: stat(s.p05), p50: stat(s.p50), p95: stat(s.p95) } }),
    };
    const motion = { ...stat(s.motion), maxFrame: list.reduce((best, f) => (s.motion[f] > s.motion[best] ? f : best), a) };
    const motionPan = { start: round(s.pan[moving[0]]), end: round(s.pan[moving.at(-1)]), ...stat(s.pan, moving),
      frames: moving.length ? [moving[0], moving.at(-1)] : null };
    const counts = { cuts: cuts.length, holdSpans: holds.length, flickerSpans: flickerSpans.length };
    return fit((cap) => {
      const longest = (spans) => [...spans].sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, cap).sort((x, y) => x[0] - y[0]);
      return {
        ...fixed,
        detectedCuts: cuts.slice(0, cap * 3), holdSpans: longest(holds), holdFrames: list.filter((f) => s.hold[f]).length,
        motion: { ...motion, peaks: turns(s.motion, list, ['max'], Math.min(5, cap)) },
        motionPan: { ...motionPan, peaks: turns(s.pan, moving, ['max', 'min'], Math.min(3, cap)) },
        flicker: { detected: flickerSpans.length > 0, reversalRate: round(flips / Math.max(1, list.length - 2)), maxAmplitude: round(maxAmplitude), spans: longest(flickerSpans) },
        ...(audio && { audio: { ...audio.head, onsetOffsets: audio.offsets.slice(0, cap) } }),
        counts, truncated: cuts.length > cap * 3 || holds.length > cap || flickerSpans.length > cap || (audio?.offsets.length ?? 0) > cap,
      };
    }, [12, 8, 5, 3, 1, 0]);
  } catch (error) {
    return fail(error);
  }
}
