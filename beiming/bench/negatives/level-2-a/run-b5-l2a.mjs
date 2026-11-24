// B5（第二部分）：二级第一批 4 道公开考题（23-2、27-1、29-2、30-1）的标准负对照核验。每道题三种故意做错：关掉题面要用的卡、整体错位 2 帧、换成随机拍点。
// 每道题一个参数化信号/行为模型（逐帧强对比灰度画面、48 kHz 立体声合成 PCM 音轨、10 毫秒对数均方根音量包络、时间线双拍速行为求值回调），都在题目自己的 deliverable 时间线上现造；
// 读数全部从造出来的信号或行为量回来（原始像素帧间 YDIF 与 observe 的 telemetry 双重校验检切点、ITU-R BS.1770-4 K 加权积分响度与 4 倍过采样真峰值实测、10 毫秒音量跳变检起音、间隔聚类加网格扫描估拍长与相位、time.timeline 在 80 与 96 BPM 下的纯行为重求值），零硬编码读数、不手填分数。
// 30-1 严格遵守 2026-11-23 管理员裁定：只做纯行为 BPM 扰动检查（80 -> 96 BPM 重求值），零源码静态扫描。
// 正对照是模型的默认参数；负对照只把同目录夹具 <题号>-<种类>.json 里 perturbation 写的参数换掉，别的一概不动，再交给 evaluate-b3 的正式 evaluate（本模块按统一口径记作 score）。
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { evaluate as evaluateTimeline } from '../../../cards/time/timeline/evaluate.mjs';
import { telemetry } from '../../../observe/index.mjs';
import { parseFps } from '../../../verify/predicates.mjs';
import { evaluate as score } from '../../questions/level-2-a/evaluate-b3.mjs';

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};
export const B5_L2A_QUESTION_IDS = deepFreeze(['23-2', '27-1', '29-2', '30-1']);
export const B5_QUESTION_IDS = B5_L2A_QUESTION_IDS;
export const B5_NEGATIVE_KINDS = deepFreeze(['disable-card', 'shift-2f', 'random-beats']);
export const B5_FORMAT = 'bench-negative/0.1';

const json = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
export const loadQuestion = (id) => {
  if (!B5_L2A_QUESTION_IDS.includes(id)) throw new RangeError(`没有登记这道二级题：${String(id)}`);
  return json(`../../questions/level-2-a/${id}.json`);
};
// 只读登记过的 12 份；别的 id 不去读盘（字符串入口和对象入口一个口径，也不让 id 当路径用）
export function loadControl(id) {
  if (!B5_L2A_QUESTION_IDS.some((qid) => B5_NEGATIVE_KINDS.some((kind) => id === `${qid}-${kind}`))) {
    throw new RangeError(`没有登记这份负对照：${id}`);
  }
  const control = validateNegativeControl(json(`./${id}.json`));
  if (control.id !== id) throw new RangeError(`${id}.json 里写的 id 是 ${control.id}`);
  return control;
}
const fpsOf = (q) => {
  const { num, den } = parseFps(q.deliverable.fps);
  return Number(num) / Number(den);
};

/* ---------------- 合成信号与照题面口径的检测零件 ---------------- */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 随机拍点：无放回 Floyd 抽样，在 [from, to) 里取 count 个两两至少隔 gap 帧的整数帧号，O(count) 零重试必终止，回升序
function randomBeats(seed, count, [from, to], gap = 1) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(count) || count < 0 || !Number.isInteger(gap) || gap < 1) {
    throw new RangeError('randomBeats 的区间、拍点数与最小间隔要是合法整数');
  }
  if (count === 0) return [];
  const slack = (to - from) - (count - 1) * (gap - 1);
  if (slack < count) throw new RangeError('randomBeats 的帧区间放不下这么多带间隔的拍点');
  const rand = rng(seed), picked = new Set();
  for (let j = slack - count; j < slack; j++) {
    const r = Math.floor(rand() * (j + 1));
    picked.add(picked.has(r) ? j : r);
  }
  return [...picked].sort((a, b) => a - b).map((u, i) => from + u + i * (gap - 1));
}

// 连续纹理（两层格点噪声），shot 换一套格点就是另一个镜头的画面
function texture(x, y, shot = 0) {
  const lattice = (ix, iy) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(shot, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const layer = (u, v) => {
    const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
    const top = lattice(iu, iv) + (lattice(iu + 1, iv) - lattice(iu, iv)) * fu;
    const bottom = lattice(iu, iv + 1) + (lattice(iu + 1, iv + 1) - lattice(iu, iv + 1)) * fu;
    return top + (bottom - top) * fv;
  };
  return 0.7 * layer(x / 7, y / 7) + 0.3 * layer(x / 3, y / 3);
}

// 相邻镜头奇偶交替落在 [36, 106] 与 [150, 220] 两个强对比亮度带：镜头切换处原始像素 YDIF > 100 >> 24，镜内帧间底噪 MAD ~ 1.33（既不误触冻结也不误触切点，且全像素 > 32 零黑帧）
function grayFrame([width, height], { shot = 0, noise = 4, seed = 1 } = {}) {
  const rand = rng(seed), gray = new Uint8Array(width * height);
  const base = (shot & 1) === 0 ? 36 : 150;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = base + 70 * texture(x, y, shot) + noise * (rand() - 0.5);
      gray[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return gray;
}

export function synthesizePlanes(size, frames, plannedCuts = []) {
  if (!Array.isArray(size) || size.length !== 2 || !size.every((n) => Number.isInteger(n) && n > 0)) {
    throw new RangeError('synthesizePlanes 的画幅 size 要是两个正整数');
  }
  if (!Number.isInteger(frames) || frames <= 0) throw new RangeError('synthesizePlanes 的总帧数要是正整数');
  const sorted = [...new Set(plannedCuts)].filter((f) => f > 0 && f < frames).sort((a, b) => a - b);
  let shot = 1, ptr = 0;
  return Array.from({ length: frames }, (_, f) => {
    while (ptr < sorted.length && f >= sorted[ptr]) {
      shot++;
      ptr++;
    }
    return grayFrame(size, { shot, noise: 4, seed: f + 1 });
  });
}

// 合成镜头切换画面，用与 cutYdif(video, 24) 同口径的原始像素帧间 MAD > 24 实测切点，并与 observe 的 telemetry 交叉核对一致
function detectCutsFromPlanes(size, frames, plannedCuts, ydifThreshold = 24) {
  const planes = synthesizePlanes(size, frames, plannedCuts);
  const area = size[0] * size[1], ydifCuts = [];
  for (let f = 1; f < planes.length; f++) {
    const cur = planes[f], prev = planes[f - 1];
    let diffSum = 0;
    for (let i = 0; i < area; i++) diffSum += Math.abs(cur[i] - prev[i]);
    if (diffSum / area > ydifThreshold) ydifCuts.push(f);
  }
  const seen = telemetry({ width: size[0], height: size[1], frames: planes, rangeMode: 'full' });
  if (!seen.ok) throw new Error(`切点没量出来：${seen.error.message}`);
  if (!seen.truncated && JSON.stringify(ydifCuts) !== JSON.stringify(seen.detectedCuts)) {
    throw new Error(`YDIF 切点 ${JSON.stringify(ydifCuts)} 与 telemetry 切点 ${JSON.stringify(seen.detectedCuts)} 不一致`);
  }
  return ydifCuts;
}

/* ---------------- 48 kHz 立体声 PCM 合成与 ITU-R BS.1770-4 响度 / 4× 真峰值实测 ---------------- */

export const AUDIO_SAMPLE_RATE = 48000;
const BS1770_BLOCK = 0.4 * AUDIO_SAMPLE_RATE;
const BS1770_STEP = 0.1 * AUDIO_SAMPLE_RATE;
const TP_OVERSAMPLE = 4;
const TP_TAPS = 12;
// 48000 Hz 下 ITU-R BS.1770-4 K 加权两级二阶滤波器系数 [b0, b1, b2, a1, a2]（高频搁架 + RLB 高通）
const [K1_B0, K1_B1, K1_B2, K1_A1, K1_A2] = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
const [K2_B0, K2_B1, K2_B2, K2_A1, K2_A2] = [1, -2, 1, -1.99004745483398, 0.99007225036621];
// 4 倍过采样的第 1、2、3 分数相（12 抽头汉宁窗 sinc 插值核；第 0 相恰为整数采样点本身）
const TP_PHASES = [1, 2, 3].map((phase) => Float64Array.from({ length: TP_TAPS }, (_, k) => {
  const x = k - TP_TAPS / 2 + 1 - phase / TP_OVERSAMPLE;
  const win = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TP_TAPS / 2));
  return (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * win;
}));
const [P1_0, P1_1, P1_2, P1_3, P1_4, P1_5, P1_6, P1_7, P1_8, P1_9, P1_10, P1_11] = TP_PHASES[0];
const [P2_0, P2_1, P2_2, P2_3, P2_4, P2_5, P2_6, P2_7, P2_8, P2_9, P2_10, P2_11] = TP_PHASES[1];
const [P3_0, P3_1, P3_2, P3_3, P3_4, P3_5, P3_6, P3_7, P3_8, P3_9, P3_10, P3_11] = TP_PHASES[2];
const TP_MAX_L1 = Math.max(...TP_PHASES.map((ker) => ker.reduce((sum, w) => sum + Math.abs(w), 0)));

const AUDIO_DEFAULTS_BY_QID = deepFreeze({
  '23-2': { bpm: 120, seed: 232 },
  '27-1': { bpm: 150, seed: 271 },
  '29-2': { bpm: 120, seed: 292 },
  '30-1': { bpm: 80, seed: 301 },
});

// 合成确定性 48 kHz 立体声多音与节拍包络 PCM 音轨：既支持 (frames, fps, opts)，也支持直接传题号 ('27-1' / '30-1', opts)
export function synthesizeAudioTrack(framesOrQuestionId, fps, opts = {}) {
  let frames = framesOrQuestionId, rate = fps, cfg = opts;
  if (typeof framesOrQuestionId === 'string') {
    const q = loadQuestion(framesOrQuestionId);
    frames = q.deliverable.frames;
    rate = fpsOf(q);
    cfg = { ...AUDIO_DEFAULTS_BY_QID[framesOrQuestionId], ...(fps && typeof fps === 'object' ? fps : opts) };
  } else if (typeof rate === 'string') {
    const { num, den } = parseFps(rate);
    rate = Number(num) / Number(den);
  }
  const { bpm = 120, gainDb = 0, seed = 1 } = cfg ?? {};
  if (!Number.isInteger(frames) || frames <= 0 || !Number.isFinite(rate) || rate <= 0) {
    throw new RangeError('synthesizeAudioTrack 的帧数与帧率要是正数');
  }
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(gainDb)) {
    throw new RangeError('synthesizeAudioTrack 的 bpm 与 gainDb 不合法');
  }
  const total = Math.round((frames / rate) * AUDIO_SAMPLE_RATE);
  const left = new Float32Array(total), right = new Float32Array(total);
  const gain = 10 ** (gainDb / 20);
  const period = 2400;
  const baseL = new Float32Array(period), baseR = new Float32Array(period);
  const shift = ((seed >>> 0) % 24) * 100;
  for (let i = 0; i < period; i++) {
    const t = (2 * Math.PI * ((i + shift) % period)) / AUDIO_SAMPLE_RATE;
    baseL[i] = 0.132 * Math.cos(220 * t) + 0.082 * Math.cos(440 * t) + 0.048 * Math.cos(660 * t);
    baseR[i] = 0.132 * Math.cos(220 * t + 0.3) + 0.082 * Math.cos(440 * t - 0.25) + 0.048 * Math.cos(660 * t + 0.2);
  }
  const envLen = Math.max(1, Math.round((60 / bpm) * AUDIO_SAMPLE_RATE));
  const envTable = new Float32Array(envLen);
  for (let i = 0; i < envLen; i++) {
    const u = i / envLen;
    const accent = (0.5 - 0.5 * Math.cos(2 * Math.PI * u)) ** 14;
    envTable[i] = gain * (0.78 + 2.34 * accent);
  }
  const fade = Math.min(480, Math.floor(total / 8));
  for (let i = 0, p = 0, e = 0; i < total; i++) {
    let env = envTable[e];
    if (i < fade) env *= i / fade;
    else if (i >= total - fade) env *= (total - 1 - i) / fade;
    left[i] = baseL[p] * env;
    right[i] = baseR[p] * env;
    if (++p === period) p = 0;
    if (++e === envLen) e = 0;
  }
  return { sampleRate: AUDIO_SAMPLE_RATE, channels: [left, right] };
}

// 按 ITU-R BS.1770-4 实测立体声/单声道 PCM 的 K 加权门限积分响度（LUFS）与 4 倍过采样真峰值（dBTP）
export function measureAudioLoudness(trackOrChannels, sampleRate = AUDIO_SAMPLE_RATE) {
  const channels = Array.isArray(trackOrChannels) ? trackOrChannels : trackOrChannels?.channels;
  const sr = Array.isArray(trackOrChannels) ? sampleRate : (trackOrChannels?.sampleRate ?? sampleRate);
  if (sr !== AUDIO_SAMPLE_RATE) throw new RangeError(`measureAudioLoudness 只支持 ${AUDIO_SAMPLE_RATE} Hz 采样率`);
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2
    || channels.some((c) => !ArrayBuffer.isView(c) || c.length !== channels[0].length)) {
    throw new RangeError('measureAudioLoudness 需要 1 或 2 个等长声道样本数组');
  }
  const n = channels[0].length;
  if (n < BS1770_BLOCK) throw new RangeError('measureAudioLoudness 至少需要 400 毫秒样本');
  const numChunks = Math.floor(n / BS1770_STEP);
  const chunkPower = new Float64Array(numChunks);
  let peak = 0;

  for (const c of channels) {
    let x1 = 0, x2 = 0, u1 = 0, u2 = 0, y1 = 0, y2 = 0;
    const limit = numChunks * BS1770_STEP;
    for (let ch = 0, base = 0; ch < numChunks; ch++, base += BS1770_STEP) {
      let sumSq = 0;
      for (let i = base, end = base + BS1770_STEP; i < end; i++) {
        const x = c[i];
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
        const u = K1_B0 * x + K1_B1 * x1 + K1_B2 * x2 - K1_A1 * u1 - K1_A2 * u2;
        x2 = x1; x1 = x;
        const y = K2_B0 * u + K2_B1 * u1 + K2_B2 * u2 - K2_A1 * y1 - K2_A2 * y2;
        u2 = u1; u1 = u; y2 = y1; y1 = y;
        sumSq += y * y;
      }
      chunkPower[ch] += sumSq / BS1770_BLOCK;
    }
    for (let i = limit; i < n; i++) {
      const ax = Math.abs(c[i]);
      if (ax > peak) peak = ax;
    }
  }

  // 4 倍过采样真峰值：利用 12 抽头核 L1 范数精确跳过不可能超越当前峰值的 64 样本静默/低幅块，零近似误差
  for (const c of channels) {
    for (let b = 0; b < n; b += 64) {
      const bEnd = b + 64 < n ? b + 64 : n;
      const wLo = b >= 5 ? b - 5 : 0, wHi = bEnd + 5 < n ? bEnd + 5 : n - 1;
      let blockMax = 0;
      for (let j = wLo; j <= wHi; j++) {
        const av = c[j] < 0 ? -c[j] : c[j];
        if (av > blockMax) blockMax = av;
      }
      if (blockMax * TP_MAX_L1 <= peak) continue;
      for (let i = b; i < bEnd; i++) {
        if (i >= 5 && i + 6 < n) {
          const c0 = c[i - 5], c1 = c[i - 4], c2 = c[i - 3], c3 = c[i - 2], c4 = c[i - 1], c5 = c[i];
          const c6 = c[i + 1], c7 = c[i + 2], c8 = c[i + 3], c9 = c[i + 4], c10 = c[i + 5], c11 = c[i + 6];
          const v1 = Math.abs(c0 * P1_0 + c1 * P1_1 + c2 * P1_2 + c3 * P1_3 + c4 * P1_4 + c5 * P1_5 + c6 * P1_6 + c7 * P1_7 + c8 * P1_8 + c9 * P1_9 + c10 * P1_10 + c11 * P1_11);
          const v2 = Math.abs(c0 * P2_0 + c1 * P2_1 + c2 * P2_2 + c3 * P2_3 + c4 * P2_4 + c5 * P2_5 + c6 * P2_6 + c7 * P2_7 + c8 * P2_8 + c9 * P2_9 + c10 * P2_10 + c11 * P2_11);
          const v3 = Math.abs(c0 * P3_0 + c1 * P3_1 + c2 * P3_2 + c3 * P3_3 + c4 * P3_4 + c5 * P3_5 + c6 * P3_6 + c7 * P3_7 + c8 * P3_8 + c9 * P3_9 + c10 * P3_10 + c11 * P3_11);
          if (v1 > peak) peak = v1;
          if (v2 > peak) peak = v2;
          if (v3 > peak) peak = v3;
        } else {
          for (let p = 0; p < 3; p++) {
            const ker = TP_PHASES[p];
            let v = 0;
            for (let k = 0; k < TP_TAPS; k++) {
              const j = i + k - 5;
              if (j >= 0 && j < n) v += c[j] * ker[k];
            }
            const av = Math.abs(v);
            if (av > peak) peak = av;
          }
        }
      }
    }
  }

  const numBlocks = numChunks - 3;
  const blocks = new Float64Array(numBlocks);
  let rolling = chunkPower[0] + chunkPower[1] + chunkPower[2];
  let absSum = 0, absCount = 0;
  for (let b = 0; b < numBlocks; b++) {
    rolling += chunkPower[b + 3];
    blocks[b] = rolling;
    if (rolling > 0 && -0.691 + 10 * Math.log10(rolling) > -70) {
      absSum += rolling;
      absCount++;
    }
    rolling -= chunkPower[b];
  }
  let rawLufs = -Infinity;
  if (absCount > 0) {
    const relGate = -0.691 + 10 * Math.log10(absSum / absCount) - 10;
    let relSum = 0, relCount = 0;
    for (let b = 0; b < numBlocks; b++) {
      const p = blocks[b];
      if (p > 0 && -0.691 + 10 * Math.log10(p) > relGate) {
        relSum += p;
        relCount++;
      }
    }
    rawLufs = -0.691 + 10 * Math.log10(relSum / relCount);
  }
  const rawTp = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  return {
    loudnessLufs: Number.isFinite(rawLufs) ? Math.round(rawLufs * 100) / 100 : rawLufs,
    truePeakDbtp: Number.isFinite(rawTp) ? Math.round(rawTp * 100) / 100 : rawTp,
  };
}

// 把合成音轨编码为 16-bit 小端 PCM WAV 字节流，供外部复核与 observe/audioLoudness 交叉验证
export function encodeWavPcm16(trackOrChannels, sampleRate = AUDIO_SAMPLE_RATE) {
  const channels = Array.isArray(trackOrChannels) ? trackOrChannels : trackOrChannels?.channels;
  const sr = Array.isArray(trackOrChannels) ? sampleRate : (trackOrChannels?.sampleRate ?? sampleRate);
  if (!Array.isArray(channels) || (channels.length !== 1 && channels.length !== 2)) {
    throw new RangeError('encodeWavPcm16 需要单声道或立体声样本');
  }
  const chCount = channels.length, n = channels[0].length;
  const blockAlign = chCount * 2, dataBytes = n * blockAlign;
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);
  const writeTag = (off, str) => { for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i); };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, chCount, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0, off = 44; i < n; i++) {
    for (let c = 0; c < chCount; c++, off += 2) {
      const sample = Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767)));
      view.setInt16(off, sample, true);
    }
  }
  return buf;
}

const shotsAt = (cuts, frames) => [0, ...cuts].map((start, i) => ({ in: start, out: cuts[i] ?? frames }));

// 合成 10 毫秒一格的对数均方根音量包络（满幅 0，底噪 -3.6 上下，起音脉冲跳到 -0.45）
function buildLogRmsEnvelope(onsetMsList, durationMs, seed) {
  const windows = Math.round(durationMs / 10), rand = rng(seed);
  const pulse = new Set(onsetMsList.map((ms) => Math.round(ms / 10)));
  return Array.from({ length: windows }, (_, w) => (pulse.has(w) ? -0.45 : -3.6) + 0.04 * (rand() - 0.5));
}

// 从 10 毫秒对数音量包络检起音（与 evaluate-b3 的 onsets 同口径：连续越过 jump 的 10 毫秒窗归为同一次起音，取跳变最大的那一窗）
function detectOnsetsFromEnvelope(levels, jump, durationMs) {
  const deltas = levels.map((lv, w) => Math.max(0, lv - (w > 0 ? levels[w - 1] : lv)));
  const found = [];
  for (let w = 0; w < deltas.length;) {
    if (deltas[w] <= jump) { w++; continue; }
    let best = w;
    while (w < deltas.length && deltas[w] > jump) {
      if (deltas[w] >= deltas[best]) best = w;
      w++;
    }
    const ms = best * 10;
    if (ms >= 0 && ms < durationMs) found.push(ms);
  }
  return found;
}

function offGrid(at, period, phase = 0) {
  const into = (((at - phase) % period) + period) % period;
  return Math.min(into, period - into);
}

// 从强起音列表聚类加网格扫描估拍长与相位（与 evaluate-b3 的 beatOf 同口径）
function estimateBeatGrid(onsetsMs) {
  if (onsetsMs.length < 2) return null;
  const diffs = onsetsMs.slice(1).map((ms, i) => ms - onsetsMs[i]);
  const step = onsetsMs.every((ms) => ms % 10 === 0) ? 10 : 1;
  const seeds = [...new Set([...diffs, ...diffs.slice(1).map((d, i) => Math.round((d + diffs[i]) / (2 * step)) * step)])].filter((c) => c > 0);
  const bestSeed = seeds.map((c) => {
    const members = diffs.filter((d) => Math.abs(d - c) <= Math.max(30, Math.round(c * 0.15)));
    const mean = Math.round(members.reduce((s, d) => s + d, 0) / (members.length * step)) * step || c;
    const err = members.reduce((s, d) => s + Math.abs(d - c), 0) / members.length;
    return { c, count: members.length, err, mean };
  }).sort((a, b) => b.count - a.count || a.err - b.err || a.c - b.c)[0];
  if (!bestSeed) return null;
  const rough = bestSeed.mean, tol = Math.min(30, Math.floor(rough / 4));
  let best = null;
  for (let p = Math.max(1, rough - 30); p <= rough + 30; p++) {
    const q = p % step === 0 ? step : 1;
    const phases = Array.from({ length: Math.ceil(p / q) }, (_, i) => i * q);
    for (const ph of phases) {
      let hits = 0, sq = 0, exact = 0;
      for (const ms of onsetsMs) {
        const d = offGrid(ms, p, ph);
        if (d <= tol) { hits++; sq += d * d; if (d === 0) exact++; }
      }
      const cand = { p, ph, hits, sq, exact, dist: Math.abs(p - rough) };
      if (!best || cand.hits > best.hits || (cand.hits === best.hits && cand.sq < best.sq)
        || (cand.hits === best.hits && cand.sq === best.sq && cand.exact > best.exact)
        || (cand.hits === best.hits && cand.sq === best.sq && cand.exact === best.exact
          && (cand.dist < best.dist || (cand.dist === best.dist && (cand.p < best.p || (cand.p === best.p && cand.ph < best.ph)))))) {
        best = cand;
      }
    }
  }
  return { periodMs: best.p, phaseMs: best.ph };
}

/* ---------------- 23-2：章节落拍 ---------------- */

const CHAPTER_23_2 = deepFreeze({
  planeSize: [32, 18],
  cutFrames: [48, 192, 336, 432, 528],
  unquantizedMs: [0, 2000, 8083, 14000, 18000, 22000],
  strongOnsetsMs: [
    10, 480, 980, 1480, 2480, 2980, 3480, 3980, 4480, 4980, 5480, 5980, 6200, 6480, 6980, 7480, 7980, 8480, 9480,
    10480, 10980, 11230, 11480, 11980, 12480, 12690, 12980, 13480, 13980, 14480, 14980, 15480, 15980, 16480, 17480,
    17980, 18480, 18980, 19480, 19980, 20980, 21980, 22480, 22980, 23480, 23730, 23980, 24480, 25480, 25980, 26350,
    26730, 27110, 27480, 27860,
  ],
});
const BASE_23_2 = deepFreeze({ chapterTrigger: 'beat-grid', chapterShiftFrames: 0, seed: null });

function measure232(q, p) {
  const [width, height] = q.deliverable.size, fps = fpsOf(q), { frames } = q.deliverable, durationMs = (frames * 1000) / fps;
  const shiftMs = Math.round(((p.chapterShiftFrames * 1000) / fps) * 1e5) / 1e5;
  let chaptersMs, plannedCuts;
  if (p.chapterTrigger === 'unquantized') {
    const tailMs = CHAPTER_23_2.unquantizedMs.slice(1).map((ms) => Math.round((ms + shiftMs) * 1e5) / 1e5).filter((ms) => ms > 0 && ms < durationMs);
    chaptersMs = tailMs.length ? [0, ...tailMs] : [];
    plannedCuts = tailMs.map((ms) => Math.round((ms * fps) / 1000));
  } else {
    const rawCuts = p.chapterTrigger === 'random-beats'
      ? randomBeats(p.seed, CHAPTER_23_2.cutFrames.length, [24, frames - 24], 36)
      : CHAPTER_23_2.cutFrames;
    plannedCuts = rawCuts.map((f) => f + p.chapterShiftFrames).filter((f) => f > 0 && f < frames);
    chaptersMs = plannedCuts.length ? [0, ...plannedCuts.map((f) => Math.round(((f * 1000) / fps) * 1e5) / 1e5)] : [];
  }
  const cuts = detectCutsFromPlanes(CHAPTER_23_2.planeSize, frames, plannedCuts);
  const envelope = buildLogRmsEnvelope(CHAPTER_23_2.strongOnsetsMs, durationMs, 232);
  const strongOnsetsMs = detectOnsetsFromEnvelope(envelope, 0.35, durationMs);
  const beat = estimateBeatGrid(strongOnsetsMs);
  return {
    width,
    height,
    fps,
    frames,
    colorTag: 'bt709',
    blackFrames: [],
    freezes: [],
    cuts,
    shots: shotsAt(cuts, frames),
    chaptersMs,
    beat,
    strongOnsetsMs,
  };
}

/* ---------------- 27-1：网格拍点剪辑 ---------------- */

const GRID_27_1 = deepFreeze({
  planeSize: [32, 32],
  audioBpm: 150,
  audioSeed: 271,
  gridCuts: [96, 144, 168, 192, 240, 252, 264, 276, 288, 336, 384, 432, 456],
  equalCuts: [36, 73, 109, 146, 182, 219, 255, 291, 328, 364, 401, 437, 474],
});
const BASE_27_1 = deepFreeze({ cutSchedule: 'beat-grid', cutShiftFrames: 0, seed: null });

function measure271(q, p) {
  const [width, height] = q.deliverable.size, fps = fpsOf(q), { frames } = q.deliverable;
  const rawCuts = p.cutSchedule === 'equal-interval'
    ? GRID_27_1.equalCuts
    : p.cutSchedule === 'random-beats'
    ? randomBeats(p.seed, GRID_27_1.gridCuts.length, [12, frames - 12], 12)
    : GRID_27_1.gridCuts;
  const plannedCuts = rawCuts.map((f) => f + p.cutShiftFrames).filter((f) => f > 0 && f < frames);
  const cuts = detectCutsFromPlanes(GRID_27_1.planeSize, frames, plannedCuts);
  const audio = measureAudioLoudness(synthesizeAudioTrack(frames, fps, { bpm: GRID_27_1.audioBpm, seed: GRID_27_1.audioSeed }));
  return {
    width,
    height,
    fps,
    frames,
    colorTag: 'bt709',
    blackFrames: [],
    freezes: [],
    shots: shotsAt(cuts, frames),
    cuts,
    loudnessLufs: audio.loudnessLufs,
    truePeakDbtp: audio.truePeakDbtp,
  };
}

/* ---------------- 29-2：点击踩起音 ---------------- */

const CLICK_29_2 = deepFreeze({
  planeSize: [32, 40],
  onsetClicks: [108, 200, 228, 257, 273, 290, 302, 318, 347, 472, 525],
  equalClicks: [50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550],
  onsetsMs: [
    20, 110, 180, 570, 750, 990, 1020, 1250, 2080, 2460, 2620, 3390, 3430, 3580, 4100, 4170, 4530, 4660, 4710, 4860,
    5130, 5480, 5870, 5990, 6520, 6600, 7160, 7600, 7720, 7780, 7830, 8160, 8320, 8470, 8530, 8640, 8690, 8750, 9040,
    9100, 9230, 9410, 9600, 9660, 9690, 9720, 9820, 9890, 9980, 10040, 10100, 10140, 10230, 10260, 10530, 10550, 10600,
    10660, 10740, 11040, 11110, 11170, 11230, 11320, 11490, 11550, 11610, 11770, 11990, 12060, 12240, 12740, 12810,
    13280, 13390, 14130, 14350, 14510, 14620, 14720, 14790, 15070, 15260, 15470, 15640, 15700, 16010, 16050, 16140,
    16310, 16390, 16520, 16570, 16780, 17430, 17500, 17570, 17710, 17820, 17900, 18090, 18190, 18250, 18280, 18310,
    18330, 18410, 18470, 19220,
  ],
});
const BASE_29_2 = deepFreeze({ clickTrigger: 'onsets', cutLagFrames: 2, clickShiftFrames: 0, seed: null });

function measure292(q, p) {
  const [width, height] = q.deliverable.size, fps = fpsOf(q), { frames } = q.deliverable, durationMs = (frames * 1000) / fps;
  if (p.cutLagFrames >= 30) throw new RangeError('29-2 的切点滞后帧数超出允许范围');
  const rawClicks = p.clickTrigger === 'equal-interval'
    ? CLICK_29_2.equalClicks
    : p.clickTrigger === 'random-beats'
    ? randomBeats(p.seed, CLICK_29_2.onsetClicks.length, [12, frames - 16], 12)
    : CLICK_29_2.onsetClicks;
  const clicks = rawClicks.map((f) => f + p.clickShiftFrames).filter((f) => f > 0 && f + p.cutLagFrames < frames);
  const plannedCuts = clicks.map((f) => f + p.cutLagFrames);
  const cuts = detectCutsFromPlanes(CLICK_29_2.planeSize, frames, plannedCuts);
  const envelope = buildLogRmsEnvelope(CLICK_29_2.onsetsMs, durationMs, 292);
  const onsetsMs = detectOnsetsFromEnvelope(envelope, 0.25, durationMs);
  return {
    width,
    height,
    fps,
    frames,
    eventsFps: q.deliverable.fps,
    eventsFrames: frames,
    colorTag: 'bt709',
    blackFrames: [],
    freezes: [],
    shots: shotsAt(cuts, frames),
    clicks,
    cuts,
    onsetsMs,
  };
}

/* ---------------- 30-1：一张节拍表（纯行为 BPM 扰动检查，零源码扫描） ---------------- */

const TABLE_30_1 = deepFreeze({
  planeSize: [32, 18],
  audioSeed: 301,
  cuts: [216, 576, 864, 1224, 1656],
  beats: [12, 20, 28.5, 32, 36, 38, 40, 48, 52, 54.5, 56, 62, 66, 68, 76, 84, 90, 92, 112, 115.5],
});
const BASE_30_1 = deepFreeze({ bpmFollow: 'linked', beatSchedule: 'beat-table', eventShiftFrames: 0, seed: null });

// 构造 30-1 的纯行为时间线求值回调（可直接传入 evaluate-b3 的 read30_1）
export function build301Resolver(q, p) {
  const { frames } = q.deliverable, fps = fpsOf(q), baseBpm = q.scoring[1].args.baseBpm;
  const baseBeatFrames = (fps * 60) / baseBpm;
  const beats = p.beatSchedule === 'random-beats'
    ? randomBeats(p.seed, TABLE_30_1.beats.length, [18, frames - 20], 15).map((f) => f / baseBeatFrames)
    : TABLE_30_1.beats;
  return ({ frameAtBeat, frameAtSeconds }) => {
    const beatEvents = beats.map((beat, i) => {
      const id = `m${String(i + 1).padStart(2, '0')}`;
      const hardcodedFrame = Math.round(beat * baseBeatFrames) + p.eventShiftFrames;
      const frame = p.bpmFollow === 'hardcoded' ? hardcodedFrame : frameAtBeat(beat, p.eventShiftFrames);
      return { id, frame };
    }).filter((e) => e.frame >= 0 && e.frame < frames);
    return {
      beatEvents,
      absoluteEvents: [{ id: 'title_enter', frame: frameAtSeconds(2) }],
    };
  };
}

function evalTimelineAtBpm(q, resolveEvents, bpm) {
  const fpsFraction = q.deliverable.fps, fps = fpsOf(q), { frames } = q.deliverable;
  const beatFrames = (fps * 60) / bpm;
  const step = evaluateTimeline({ fps: fpsFraction, shot: { in: 0 } }, { holdFrames: 1, beatFrames }, 1, 0).time;
  const timelineAt = (frame, sub = 0) => evaluateTimeline({ fps: fpsFraction, shot: { in: 0 } }, { holdFrames: 1, beatFrames }, frame, sub).time;
  const frameAtBeat = (beat, offsetFrames = 0) => Math.round(beat / step.beat) + offsetFrames;
  const frameAtSeconds = (seconds) => Math.round(seconds / step.seconds);
  return resolveEvents({ bpm, fps, fpsFraction, frames, beatFrames, timelineAt, frameAtBeat, frameAtSeconds });
}

function measure301(q, p) {
  const [width, height] = q.deliverable.size, fps = fpsOf(q), { frames } = q.deliverable;
  const { baseBpm, probeBpm } = q.scoring[1].args;
  const resolveEvents = build301Resolver(q, p);
  const baseOut = evalTimelineAtBpm(q, resolveEvents, baseBpm);
  const probeOut = evalTimelineAtBpm(q, resolveEvents, probeBpm);
  const complete = baseOut.beatEvents.length === TABLE_30_1.beats.length && probeOut.beatEvents.length === TABLE_30_1.beats.length;
  const cuts = detectCutsFromPlanes(TABLE_30_1.planeSize, frames, TABLE_30_1.cuts);
  const audio = measureAudioLoudness(synthesizeAudioTrack(frames, fps, { bpm: baseBpm, seed: TABLE_30_1.audioSeed }));
  return {
    width,
    height,
    fps,
    frames,
    colorTag: 'bt709',
    blackFrames: [],
    freezes: [],
    cuts,
    shots: shotsAt(cuts, frames),
    loudnessLufs: audio.loudnessLufs,
    truePeakDbtp: audio.truePeakDbtp,
    baseBpm,
    probeBpm,
    beatEvents: complete ? baseOut.beatEvents : [],
    probeBeatEvents: complete ? probeOut.beatEvents : [],
    absoluteEvents: baseOut.absoluteEvents,
    probeAbsoluteEvents: probeOut.absoluteEvents,
  };
}

/* ---------------- 正对照与负对照入口 ---------------- */

const MODES = deepFreeze({
  chapterTrigger: ['beat-grid', 'unquantized', 'random-beats'],
  cutSchedule: ['beat-grid', 'equal-interval', 'random-beats'],
  clickTrigger: ['onsets', 'equal-interval', 'random-beats'],
  bpmFollow: ['linked', 'hardcoded'],
  beatSchedule: ['beat-table', 'random-beats'],
});
const MODELS = deepFreeze({
  '23-2': [BASE_23_2, measure232],
  '27-1': [BASE_27_1, measure271],
  '29-2': [BASE_29_2, measure292],
  '30-1': [BASE_30_1, measure301],
});

const isPlain = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const typeName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

function checkPerturbation(questionId, perturbation) {
  if (!Object.hasOwn(MODELS, questionId)) throw new RangeError(`没有这道题的信号模型：${String(questionId)}`);
  if (!isPlain(perturbation)) throw new TypeError(`${questionId} 的 perturbation 要是普通对象，给的是 ${typeName(perturbation)}`);
  const [base] = MODELS[questionId];
  for (const [key, value] of Object.entries(perturbation)) {
    if (key === 'seed' || !Object.hasOwn(base, key)) throw new RangeError(`${questionId} 的信号模型没有这个参数：${key}`);
    const want = base[key], reject = (Kind, rule) => { throw new Kind(`${questionId} 的参数 ${key} ${rule}，给的是 ${typeName(value)} ${JSON.stringify(value) ?? String(value)}`); };
    if (typeof want === 'string') {
      if (typeof value !== 'string') reject(TypeError, '要是字符串');
      if (!MODES[key].includes(value)) reject(RangeError, `只认 ${MODES[key].join('、')}`);
    } else if (typeof want === 'boolean') {
      if (typeof value !== 'boolean') reject(TypeError, '要是布尔值');
    } else {
      if (typeof value !== 'number') reject(TypeError, '要是数');
      if (!(key.endsWith('Frames') ? Number.isSafeInteger(value) : Number.isFinite(value))) {
        reject(RangeError, key.endsWith('Frames') ? '要是整数帧' : '要是有限数');
      }
      if (key === 'cutLagFrames' && value < 0) reject(RangeError, '不能是负数');
    }
  }
}

function checkSeed(usesRandomBeats, seed) {
  if (seed !== null && typeof seed !== 'number') throw new TypeError(`种子要是整数或 null，给的是 ${typeName(seed)}`);
  if (usesRandomBeats ? !Number.isSafeInteger(seed) : seed !== null) throw new RangeError('随机拍点要整数种子，别的做法不带种子');
}

export function measure(questionId, perturbation = {}, seed = null) {
  checkPerturbation(questionId, perturbation);
  const [base, run] = MODELS[questionId];
  checkSeed(Object.values(perturbation).includes('random-beats'), seed);
  const params = globalThis.structuredClone({ ...base, ...perturbation, seed });
  return globalThis.structuredClone({ params, readings: run(loadQuestion(questionId), params) });
}

const ALLOW_EMPTY_ARRAY_KEYS = new Set(['blackFrames', 'freezes']);
function assertMeasured(value, path, lastKey = '') {
  const entries = Array.isArray(value) ? Object.entries(Array.from(value)) : isPlain(value) ? Object.entries(value) : null;
  if (entries === null) {
    const okLeaf = Number.isFinite(value) || (typeof value === 'string' && value.trim().length > 0);
    if (!okLeaf) throw new RangeError(`读数 ${path} 不是有效的有限数或非空标签：${String(value)}`);
    return;
  }
  if (entries.length === 0 && !(Array.isArray(value) && ALLOW_EMPTY_ARRAY_KEYS.has(lastKey))) {
    throw new RangeError(`读数 ${path} 是空的，没量到东西，不交给判分`);
  }
  for (const [key, item] of entries) assertMeasured(item, `${path}.${key}`, key);
}

export function evaluatePerturbedModel(questionId, perturbation = {}, seed = null) {
  const measured = measure(questionId, perturbation, seed);
  assertMeasured(measured.readings, questionId);
  return { questionId, ...measured, verdict: score(loadQuestion(questionId), measured.readings) };
}

export const buildPositiveBaseline = (questionId) => evaluatePerturbedModel(questionId);

/* ---------------- 12 份二级第一批负对照各自的口径 ---------------- */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kept = (r, base, pick) => same(pick(r), pick(base));
const later = (frames, by) => frames.map((frame) => frame + by);
const scattered = (marks, baseMarks) => marks.length === baseMarks.length && new Set(marks.map((mark, i) => Math.round((mark - baseMarks[i]) * 1e6))).size > 1;
const framesOf = (events) => events.map((e) => e.frame);

const CONTROLS = deepFreeze({
  '23-2-disable-card': {
    cards: ['time.cut-grid'],
    perturbation: { chapterTrigger: 'unquantized' },
    trace: (r, base) => same(r.chaptersMs, CHAPTER_23_2.unquantizedMs) && kept(r, base, (x) => [x.strongOnsetsMs, x.beat]),
  },
  '23-2-shift-2f': {
    cards: [],
    perturbation: { chapterShiftFrames: 2 },
    trace: (r, base, q) => r.chaptersMs[0] === 0
      && r.chaptersMs.slice(1).every((ms, i) => Math.abs(ms - base.chaptersMs[i + 1] - (2 * 1000) / fpsOf(q)) < 1e-3)
      && same(r.cuts, later(base.cuts, 2)) && kept(r, base, (x) => [x.strongOnsetsMs, x.beat]),
  },
  '23-2-random-beats': {
    cards: [],
    perturbation: { chapterTrigger: 'random-beats' },
    trace: (r, base) => r.chaptersMs[0] === 0 && scattered(r.chaptersMs.slice(1), base.chaptersMs.slice(1))
      && !same(r.chaptersMs, CHAPTER_23_2.unquantizedMs) && kept(r, base, (x) => [x.strongOnsetsMs, x.beat]),
  },
  '27-1-disable-card': {
    cards: ['time.cut-grid', 'time.timeline'],
    perturbation: { cutSchedule: 'equal-interval' },
    trace: (r, base) => same(r.cuts, GRID_27_1.equalCuts) && kept(r, base, (x) => [x.loudnessLufs, x.truePeakDbtp]),
  },
  '27-1-shift-2f': {
    cards: [],
    perturbation: { cutShiftFrames: 2 },
    trace: (r, base) => same(r.cuts, later(base.cuts, 2)) && kept(r, base, (x) => [x.loudnessLufs, x.truePeakDbtp]),
  },
  '27-1-random-beats': {
    cards: [],
    perturbation: { cutSchedule: 'random-beats' },
    trace: (r, base) => scattered(r.cuts, base.cuts) && !same(r.cuts, GRID_27_1.equalCuts)
      && kept(r, base, (x) => [x.loudnessLufs, x.truePeakDbtp]),
  },
  '29-2-disable-card': {
    cards: ['overlay.cursor', 'audio.event-mix'],
    perturbation: { cutLagFrames: 0, clickTrigger: 'equal-interval' },
    trace: (r, base) => same(r.clicks, CLICK_29_2.equalClicks) && same(r.cuts, r.clicks) && kept(r, base, (x) => x.onsetsMs),
  },
  '29-2-shift-2f': {
    cards: [],
    perturbation: { clickShiftFrames: 2 },
    trace: (r, base) => same(r.clicks, later(base.clicks, 2)) && same(r.cuts, later(base.cuts, 2)) && kept(r, base, (x) => x.onsetsMs),
  },
  '29-2-random-beats': {
    cards: [],
    perturbation: { clickTrigger: 'random-beats' },
    trace: (r, base) => scattered(r.clicks, base.clicks) && !same(r.clicks, CLICK_29_2.equalClicks)
      && same(r.cuts, later(r.clicks, 2)) && kept(r, base, (x) => x.onsetsMs),
  },
  '30-1-disable-card': {
    cards: ['time.timeline'],
    perturbation: { bpmFollow: 'hardcoded' },
    trace: (r, base) => same(r.beatEvents, base.beatEvents) && same(r.probeBeatEvents, r.beatEvents)
      && kept(r, base, (x) => [x.absoluteEvents, x.probeAbsoluteEvents]),
  },
  '30-1-shift-2f': {
    cards: [],
    perturbation: { eventShiftFrames: 2 },
    trace: (r, base) => same(framesOf(r.beatEvents), later(framesOf(base.beatEvents), 2))
      && same(framesOf(r.probeBeatEvents), later(framesOf(base.probeBeatEvents), 2))
      && kept(r, base, (x) => [x.absoluteEvents, x.probeAbsoluteEvents]),
  },
  '30-1-random-beats': {
    cards: [],
    perturbation: { beatSchedule: 'random-beats' },
    trace: (r, base) => scattered(framesOf(r.beatEvents), framesOf(base.beatEvents))
      && !same(r.probeBeatEvents, r.beatEvents)
      && kept(r, base, (x) => [x.absoluteEvents, x.probeAbsoluteEvents]),
  },
});

const CONTROL_FIELDS = ['format', 'id', 'questionId', 'kind', 'disabledCards', 'seed', 'description', 'perturbation', 'expectedFailedMetrics'];
const nonEmptyText = (value, name) => {
  if (typeof value !== 'string') throw new TypeError(`${name} 要是字符串，给的是 ${typeName(value)}`);
  if (!value.trim()) throw new RangeError(`${name} 是空的`);
};

export function validateNegativeControl(control) {
  if (!isPlain(control)) throw new TypeError(`负对照夹具要是普通对象，给的是 ${typeName(control)}`);
  const missing = CONTROL_FIELDS.filter((field) => !Object.hasOwn(control, field));
  const extra = Object.keys(control).filter((field) => !CONTROL_FIELDS.includes(field));
  if (missing.length) throw new TypeError(`负对照夹具少了这几栏：${missing.join('、')}`);
  if (extra.length) throw new RangeError(`负对照夹具多了这几栏：${extra.join('、')}`);
  const { format, id, questionId, kind, disabledCards, seed, description, perturbation, expectedFailedMetrics } = control;
  if (format !== B5_FORMAT) throw new RangeError(`format 只认 ${B5_FORMAT}`);
  if (!B5_L2A_QUESTION_IDS.includes(questionId) || !B5_NEGATIVE_KINDS.includes(kind) || id !== `${questionId}-${kind}`) {
    throw new RangeError(`没有登记这份负对照：${String(id)}（题号 ${String(questionId)}，种类 ${String(kind)}）`);
  }
  const q = loadQuestion(questionId);
  if (!Array.isArray(disabledCards) || !Array.from(disabledCards).every((card) => typeof card === 'string')) {
    throw new TypeError(`${id} 的 disabledCards 要是字符串数组`);
  }
  const rule = CONTROLS[id];
  if (!same([...disabledCards].sort(), [...rule.cards].sort())) {
    throw new RangeError(`${id} 的 disabledCards 只认 ${JSON.stringify(rule.cards)}：关卡的那份点名它关的卡，不多不少，别的种类是空数组`);
  }
  nonEmptyText(description, `${id} 的 description`);

  checkPerturbation(questionId, perturbation);
  const changed = Object.entries(perturbation);
  if (!changed.length) throw new RangeError(`${id} 的 perturbation 是空的，没写改了哪个参数`);
  if (!changed.every(([key, value]) => Object.hasOwn(rule.perturbation, key) && same(value, rule.perturbation[key]))
    || (kind !== 'disable-card' && changed.length !== Object.keys(rule.perturbation).length)) {
    throw new RangeError(`${id} 的 perturbation 只认 ${JSON.stringify(rule.perturbation)}${kind === 'disable-card' ? '（可以只带其中几个）' : ''}，别的参数、别的值不是这一类故障`);
  }
  checkSeed(kind === 'random-beats', seed);

  if (!Array.isArray(expectedFailedMetrics) || !Array.from(expectedFailedMetrics).every(isPlain)) {
    throw new TypeError(`${id} 的 expectedFailedMetrics 要是对象的数组`);
  }
  if (!expectedFailedMetrics.length) throw new RangeError(`${id} 的 expectedFailedMetrics 是空的`);
  for (const expected of expectedFailedMetrics) {
    if (Object.keys(expected).sort().join() !== 'metric,scoring,why') {
      throw new RangeError(`${id} 的 expectedFailedMetrics 每项正好是 scoring、metric、why 三栏`);
    }
    if (typeof expected.scoring !== 'number') {
      throw new TypeError(`${id} 的 expectedFailedMetrics.scoring 要是判分线的下标，给的是 ${typeName(expected.scoring)}`);
    }
    if (!Number.isSafeInteger(expected.scoring) || !Object.hasOwn(q.scoring, expected.scoring) || q.scoring[expected.scoring].metric !== expected.metric) {
      throw new RangeError(`${id} 的 expectedFailedMetrics：题面第 ${expected.scoring} 条判分线不是 ${String(expected.metric)}`);
    }
    nonEmptyText(expected.why, `${id} 的 expectedFailedMetrics.why`);
  }
  if (new Set(expectedFailedMetrics.map(({ scoring }) => scoring)).size !== expectedFailedMetrics.length) {
    throw new RangeError(`${id} 的 expectedFailedMetrics 同一条判分线写了两遍`);
  }
  return control;
}

export function evaluateNegativeControl(controlOrId) {
  const control = typeof controlOrId === 'string' ? loadControl(controlOrId) : validateNegativeControl(controlOrId);
  const judged = evaluatePerturbedModel(control.questionId, control.perturbation, control.seed);
  const failed = judged.verdict.items.flatMap((item, index) => (item.pass ? [] : [index]));
  const failedAsDeclared = failed.join() === control.expectedFailedMetrics.map(({ scoring }) => scoring).sort((a, b) => a - b).join()
    && CONTROLS[control.id].trace(judged.readings, measure(control.questionId).readings, loadQuestion(control.questionId));
  return { control, ...judged, failedAsDeclared };
}

export const evaluateAllB5L2aNegatives = () => B5_L2A_QUESTION_IDS.flatMap((id) => B5_NEGATIVE_KINDS.map((kind) => evaluateNegativeControl(`${id}-${kind}`)));
