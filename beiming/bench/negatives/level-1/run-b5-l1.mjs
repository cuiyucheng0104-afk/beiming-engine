// B5（第一部分）：一级 4 道公开考题（01-1、23-1、28-1、29-1）的标准负对照核验。每道题三种故意做错：关掉题面要用的卡、整体错位 2 帧、换成随机拍点。
// 每道题一个参数化合成信号模型（逐帧亮度平面、双声道混音包络、转台环绕帧序列、环绕取景与逐帧包围盒、分屏版式帧序列），都在题目自己的 deliverable 时间线上现造；
// 读数全部从造出来的信号经真实检测器与 evaluate-b2 的 readLayout、readFraming、readClosure、readNearest、readPixelBoxes（底层调 observe/metrics）量回来，基础谓词经 verify/predicates 的 evaluateAssertion 如实求值，绝不手填分数。
// 正对照是模型的默认参数；负对照只把同目录夹具 <题号>-<种类>.json 里 perturbation 写的参数换掉，别的一概不动，再交给 evaluate-b2 的正式 score。
// 入口分两个：evaluateNegativeControl 是正式核验，夹具先过 validateNegativeControl（栏位、类型、id，关的卡和改的参数照 CONTROLS 逐份对）再量；evaluatePerturbedModel 是模型实验（撤销改动、反向错位、换种子），
// 参数同样验类型（公开题号 1-1 与内部登记名 01-1 统一归一）。两个入口量回来的读数有空数组、空对象或非有限数时都直接抛错（唯 loop.closure-psnr 的两帧逐像素完全一致产生正无穷 PSNR 照 evaluate-b2 放行），不交给判分。
// 每次核验互不相干：本文件的常量表都冻住，回给调用方的参数和读数是另拷的一份，改它动不到下一次核验。
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { checkAssertion, evaluateAssertion, parseFps, scopeRange } from '../../../verify/predicates.mjs';
import {
  argsOf,
  readClosure,
  readFraming,
  readLayout,
  readNearest,
  readPixelBoxes,
  score,
} from '../../questions/level-1/evaluate-b2.mjs';

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};
export const B5_L1_QUESTION_IDS = deepFreeze(['01-1', '23-1', '28-1', '29-1']);
export const B5_QUESTION_IDS = B5_L1_QUESTION_IDS;
export const B5_NEGATIVE_KINDS = deepFreeze(['disable-card', 'shift-2f', 'random-beats']);
export const B5_FORMAT = 'bench-negative/0.1';

const isPlain = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const typeName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
const isFloatChannel = (c) => c instanceof Float32Array || c instanceof Float64Array;

const json = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const normalizeQuestionId = (id) => (id === '1-1' ? '01-1' : id);
export const loadQuestion = (id) => {
  const slug = normalizeQuestionId(id);
  if (!B5_L1_QUESTION_IDS.includes(slug)) throw new RangeError(`没有登记这道一级题：${String(id)}`);
  return json(`../../questions/level-1/${slug}.json`);
};
// 只读登记过的 12 份；别的 id 不去读盘（字符串入口和对象入口一个口径，也不让 id 当路径用）
export function loadControl(id) {
  if (typeof id !== 'string' || !B5_L1_QUESTION_IDS.some((qid) => B5_NEGATIVE_KINDS.some((kind) => id === `${qid}-${kind}`))) {
    throw new RangeError(`没有登记这份负对照：${String(id)}`);
  }
  const control = validateNegativeControl(json(`./${id}.json`));
  if (control.id !== id) throw new RangeError(`${id}.json 里写的 id 是 ${control.id}`);
  return control;
}
const fpsOf = (q) => {
  const { num, den } = parseFps(q.deliverable.fps);
  return Number(num) / Number(den);
};
const CHANNELS = deepFreeze({ none: 0, mono: 1, stereo: 2 });

/* ---------------- 合成信号与基础门求值零件 ---------------- */

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

// 合成 RGBA 帧：先铺底色，再依次画矩形 [x0, y0, x1, y1, [r, g, b]]（按 32 位像素整行填充，避免百万次逐像素拷贝）
function paint(width, height, bg, rects = []) {
  const rgba = new Uint8Array(width * height * 4);
  const u32 = new Uint32Array(rgba.buffer);
  const pack = ([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  u32.fill(pack(bg));
  for (const [x0, y0, x1, y1, color] of rects) {
    const cx0 = Math.max(0, Math.min(width, x0)), cx1 = Math.max(0, Math.min(width, x1));
    const cy0 = Math.max(0, Math.min(height, y0)), cy1 = Math.max(0, Math.min(height, y1));
    if (cx0 >= cx1 || cy0 >= cy1) continue;
    const word = pack(color);
    for (let y = cy0; y < cy1; y++) u32.fill(word, y * width + cx0, y * width + cx1);
  }
  return { width, height, rgba };
}

// 与 FFmpeg rawvideo rgba -> format=yuv444p,signalstats 逐位一致的 8 位受限范围 YUV 换算与矩形网格解析差分（免全画幅缓冲分配）
const rgbToYuv = ([r, g, b]) => [
  ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16,
  ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128,
  ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128,
];

function analyzeRectFrames(width, height, bgRgb, rectFrames) {
  const bgYuv = rgbToYuv(bgRgb), totalArea = width * height;
  const blackFrames = [], freezes = [], cuts = [];
  let start = 0;
  const close = (end) => {
    if (end - start + 1 >= 3) freezes.push({ in: start, out: end + 1 });
  };
  const clampRects = (rects) => rects.flatMap(([x0, y0, x1, y1, rgb]) => {
    const cx0 = Math.max(0, Math.min(width, x0)), cx1 = Math.max(0, Math.min(width, x1));
    const cy0 = Math.max(0, Math.min(height, y0)), cy1 = Math.max(0, Math.min(height, y1));
    return cx0 < cx1 && cy0 < cy1 ? [[cx0, cy0, cx1, cy1, rgbToYuv(rgb)]] : [];
  });
  const yuvAt = (x, y, rects) => {
    for (let r = rects.length - 1; r >= 0; r--) {
      const [x0, y0, x1, y1, yuv] = rects[r];
      if (x >= x0 && x < x1 && y >= y0 && y < y1) return yuv;
    }
    return bgYuv;
  };
  let prevRects = null;
  for (let k = 0; k < rectFrames.length; k++) {
    const curRects = clampRects(rectFrames[k]);
    const xs = [...new Set([0, width, ...curRects.flatMap(([x0, , x1]) => [x0, x1]), ...(prevRects ?? []).flatMap(([x0, , x1]) => [x0, x1])])].sort((a, b) => a - b);
    const ys = [...new Set([0, height, ...curRects.flatMap(([, y0, , y1]) => [y0, y1]), ...(prevRects ?? []).flatMap(([, y0, , y1]) => [y0, y1])])].sort((a, b) => a - b);
    let darkArea = 0, dy = 0, du = 0, dv = 0;
    for (let yi = 0; yi < ys.length - 1; yi++) {
      const y = ys[yi], h = ys[yi + 1] - y;
      if (h <= 0) continue;
      for (let xi = 0; xi < xs.length - 1; xi++) {
        const x = xs[xi], w = xs[xi + 1] - x;
        if (w <= 0) continue;
        const area = w * h, c = yuvAt(x, y, curRects);
        if (c[0] <= 32) darkArea += area;
        if (prevRects !== null) {
          const p = yuvAt(x, y, prevRects);
          if (c !== p) {
            dy += Math.abs(c[0] - p[0]) * area;
            du += Math.abs(c[1] - p[1]) * area;
            dv += Math.abs(c[2] - p[2]) * area;
          }
        }
      }
    }
    if ((darkArea * 100) / totalArea >= 98) blackFrames.push(k);
    if (prevRects !== null) {
      const ydif = dy / totalArea, maxDif = Math.max(dy, du, dv) / totalArea;
      if (ydif > 24) cuts.push(k);
      if (maxDif > 0.15) {
        close(k - 1);
        start = k;
      }
    }
    prevRects = curRects;
  }
  if (rectFrames.length > 0) close(rectFrames.length - 1);
  return { blackFrames, freezes, cuts };
}

function dropComparisonUnit(text) {
  const masked = text.replace(/"[^"]*"/g, (quoted) => `"${'_'.repeat(quoted.length - 2)}"`);
  const hit = /((?:>=|<=)\s*-?\d+(?:\.\d+)?|\bin\s*\[[^\][]*\])\s*(?:deg|mm|f|s)(?=\s*(?:@|$))/.exec(masked);
  return hit ? text.slice(0, hit.index + hit[1].length) + text.slice(hit.index + hit[0].length) : text;
}

function cmpHolds(value, cmp) {
  if (!cmp || !Number.isFinite(value)) return false;
  if (cmp.op === '>=') return value >= cmp.value;
  if (cmp.op === '<=') return value <= cmp.value;
  if (cmp.op === 'in') return value >= cmp.lo && value <= cmp.hi;
  return false;
}

// 基础谓词如实求值：已上线谓词走 verify/predicates.mjs 的 evaluateAssertion，planned 几何/环绕谓词从合成信号的包围盒与环绕角逐帧核对
function evaluateBasePredicate(text, film, measured) {
  const stripped = dropComparisonUnit(text);
  const checked = checkAssertion(stripped);
  if (checked.ok) {
    return evaluateAssertion(stripped, film, measured).status === 'pass' ? 'pass' : 'fail';
  }
  const onlyPlanned = Boolean(checked.assertion)
    && checked.errors.length > 0
    && checked.errors.every((e) => e.evidence === 'predicate.planned');
  if (!onlyPlanned) return 'fail';
  const a = checked.assertion, bound = checked.bound, range = scopeRange(a.scope, film);
  if (!range) return 'fail';
  if (a.name === 'bbox_w' || a.name === 'bbox_h' || a.name === 'margin_lr' || a.name === 'margin_tb') {
    const entityName = bound.entity?.kind === 'ident' ? bound.entity.name : null;
    if (!entityName || !a.cmp || !Array.isArray(measured?.frames)) return 'fail';
    const inRange = measured.frames.filter((f) => Number.isInteger(f?.frame) && f.frame >= range[0] && f.frame < range[1]);
    if (!inRange.length) return 'fail';
    for (const f of inRange) {
      const [w, h] = f.meta?.size ?? [];
      const ent = f.meta?.entities?.find((e) => e?.name === entityName);
      if (!(w > 0) || !(h > 0) || !Array.isArray(ent?.bbox2d) || ent.bbox2d.length !== 4) return 'fail';
      const [x0, y0, x1, y1] = ent.bbox2d;
      const val = a.name === 'bbox_w' ? (x1 - x0) / w
        : a.name === 'bbox_h' ? (y1 - y0) / h
        : a.name === 'margin_lr' ? Math.min(x0, w - x1) / w
        : Math.min(y0, h - y1) / h;
      if (!cmpHolds(val, a.cmp)) return 'fail';
    }
    return 'pass';
  }
  if (a.name === 'orbit_total') {
    const cam = bound.camera?.kind === 'ident' ? bound.camera.name : null;
    const subj = bound.subject?.kind === 'ident' ? bound.subject.name : null;
    if (!cam || !subj || !a.cmp) return 'fail';
    const deg = measured?.orbitTotalDeg?.[`${cam}:${subj}`];
    return cmpHolds(deg, a.cmp) ? 'pass' : 'fail';
  }
  return 'fail';
}

function buildBaseEvidence(q, measured) {
  const fps = fpsOf(q), { size: [width, height], frames, audio } = q.deliverable;
  const film = { output: { size: [width, height], fps: q.deliverable.fps, frames }, shots: [{ id: 's01', in: 0, out: frames }] };
  const predicates = Object.fromEntries(q.basePredicates.map((text) => [text, evaluateBasePredicate(text, film, measured)]));
  return {
    spec: { width, height, fps, frames, audioChannels: CHANNELS[audio] },
    predicates,
  };
}

/* ---------------- 01-1：成片交付与母带规格 ---------------- */

const MASTER_01 = deepFreeze({ planeSize: [16, 9], sampleRate: 48000, beats: 36 });
const BASE_01_1 = deepFreeze({ colorTags: true, audioMaster: true, videoShiftFrames: 0, frameMotion: 'continuous', seed: null });

const [L1_K1_B0, L1_K1_B1, L1_K1_B2, L1_K1_A1, L1_K1_A2] = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
const [L1_K2_B0, L1_K2_B1, L1_K2_B2, L1_K2_A1, L1_K2_A2] = [1, -2, 1, -1.99004745483398, 0.99007225036621];
const L1_TP_PHASES = [1, 2, 3].map((phase) => Float64Array.from({ length: 12 }, (_, k) => {
  const x = k - 5 - phase / 4;
  return (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos((Math.PI * x) / 6));
}));
const [L1_P1_0, L1_P1_1, L1_P1_2, L1_P1_3, L1_P1_4, L1_P1_5, L1_P1_6, L1_P1_7, L1_P1_8, L1_P1_9, L1_P1_10, L1_P1_11] = L1_TP_PHASES[0];
const [L1_P2_0, L1_P2_1, L1_P2_2, L1_P2_3, L1_P2_4, L1_P2_5, L1_P2_6, L1_P2_7, L1_P2_8, L1_P2_9, L1_P2_10, L1_P2_11] = L1_TP_PHASES[1];
const [L1_P3_0, L1_P3_1, L1_P3_2, L1_P3_3, L1_P3_4, L1_P3_5, L1_P3_6, L1_P3_7, L1_P3_8, L1_P3_9, L1_P3_10, L1_P3_11] = L1_TP_PHASES[2];
const L1_TP_MAX_L1 = Math.max(...L1_TP_PHASES.map((ker) => ker.reduce((s, w) => s + Math.abs(w), 0)));

export function synthesize011AudioTrack(framesOrQuestionId, fps, opts) {
  let frames = framesOrQuestionId, frameRate = fps, cfg;
  if (typeof framesOrQuestionId === 'string') {
    const slug = normalizeQuestionId(framesOrQuestionId);
    if (slug !== '01-1') throw new RangeError(`synthesize011AudioTrack 只接受 01-1（或公开题号 1-1），收到：${framesOrQuestionId}`);
    if (fps !== undefined && !isPlain(fps)) throw new TypeError('按题号调用 synthesize011AudioTrack 时第二个参数要是普通配置对象');
    if (opts !== undefined && !isPlain(opts)) throw new TypeError('synthesize011AudioTrack 的配置参数要是普通对象');
    const q = loadQuestion(slug);
    frames = q.deliverable.frames;
    frameRate = fpsOf(q);
    cfg = { ...fps, ...opts };
  } else {
    if (typeof frameRate === 'string') {
      const parsed = parseFps(frameRate);
      if (!parsed) throw new RangeError('synthesize011AudioTrack 的帧率格式不合法');
      frameRate = Number(parsed.num) / Number(parsed.den);
    }
    if (opts !== undefined && !isPlain(opts)) throw new TypeError('synthesize011AudioTrack 的配置参数要是普通对象');
    cfg = opts ?? {};
  }
  const { audioMaster = true } = cfg;
  if (typeof audioMaster !== 'boolean') throw new TypeError('synthesize011AudioTrack 的 audioMaster 要是布尔值');
  if (!Number.isInteger(frames) || frames <= 0 || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new RangeError('synthesize011AudioTrack 的帧数与帧率要是正数');
  }
  const rate = MASTER_01.sampleRate, total = Math.round((frames / frameRate) * rate);
  const left = new Float32Array(total), right = new Float32Array(total);
  const baseAmp = audioMaster ? 0.1972 : 0.3348;
  const spikeExtra = audioMaster ? 0.625 : 0.7615;
  const period = 240;
  const baseL = new Float32Array(period), baseR = new Float32Array(period);
  for (let i = 0; i < period; i++) {
    const t = (2 * Math.PI * i) / rate;
    baseL[i] = Math.cos(1000 * t);
    baseR[i] = Math.cos(1000 * t + 0.25);
  }
  const spikeCenter = 6 * rate, spikeHalf = 960, fade = 480;
  for (let i = 0, p = 0; i < total; i++) {
    let env = baseAmp;
    const d = Math.abs(i - spikeCenter);
    if (d < spikeHalf) env += spikeExtra * (0.5 + 0.5 * Math.cos((Math.PI * d) / spikeHalf));
    if (i < fade) env *= i / fade;
    else if (i >= total - fade) env *= (total - 1 - i) / fade;
    left[i] = baseL[p] * env;
    right[i] = baseR[p] * env;
    if (++p === period) p = 0;
  }
  return { sampleRate: rate, channels: [left, right] };
}

// 按 ITU-R BS.1770-4 两阶段门控（-70 LUFS 绝对门 + -10 LU 相对门）与 4 倍过采样实测立体声/单声道 PCM 响度与真峰值
export function measureAudioLoudness(trackOrChannels, sampleRate = MASTER_01.sampleRate) {
  const channels = Array.isArray(trackOrChannels) ? trackOrChannels : trackOrChannels?.channels;
  const sr = Array.isArray(trackOrChannels) ? sampleRate : (trackOrChannels?.sampleRate ?? sampleRate);
  if (sr !== MASTER_01.sampleRate) throw new RangeError(`measureAudioLoudness 只支持 ${MASTER_01.sampleRate} Hz 采样率`);
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2
    || channels.some((c) => !isFloatChannel(c) || c.length !== channels[0].length)) {
    throw new RangeError('measureAudioLoudness 需要 1 或 2 个等长浮点声道样本数组');
  }
  const block = 0.4 * sr, step = 0.1 * sr, n = channels[0].length;
  if (n < block) throw new RangeError('measureAudioLoudness 至少需要 400 毫秒样本');
  const numChunks = Math.floor(n / step), chunkPower = new Float64Array(numChunks);
  let peak = 0;
  for (const c of channels) {
    let x1 = 0, x2 = 0, u1 = 0, u2 = 0, y1 = 0, y2 = 0;
    for (let ch = 0, base = 0; ch < numChunks; ch++, base += step) {
      let sumSq = 0;
      for (let i = base, end = base + step; i < end; i++) {
        const x = c[i];
        if (!Number.isFinite(x)) throw new RangeError('measureAudioLoudness 的 PCM 样本包含非有限数');
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
        const u = L1_K1_B0 * x + L1_K1_B1 * x1 + L1_K1_B2 * x2 - L1_K1_A1 * u1 - L1_K1_A2 * u2;
        x2 = x1; x1 = x;
        const y = L1_K2_B0 * u + L1_K2_B1 * u1 + L1_K2_B2 * u2 - L1_K2_A1 * y1 - L1_K2_A2 * y2;
        u2 = u1; u1 = u; y2 = y1; y1 = y;
        sumSq += y * y;
      }
      chunkPower[ch] += sumSq / block;
    }
    for (let i = numChunks * step; i < n; i++) {
      if (!Number.isFinite(c[i])) throw new RangeError('measureAudioLoudness 的 PCM 样本包含非有限数');
      peak = Math.max(peak, Math.abs(c[i]));
    }
  }
  for (const c of channels) {
    for (let b = 0; b < n; b += 64) {
      const bEnd = Math.min(n, b + 64), wLo = Math.max(0, b - 5), wHi = Math.min(n - 1, bEnd + 5);
      let blockMax = 0;
      for (let j = wLo; j <= wHi; j++) blockMax = Math.max(blockMax, Math.abs(c[j]));
      if (blockMax * L1_TP_MAX_L1 <= peak) continue;
      for (let i = b; i < bEnd; i++) {
        if (i >= 5 && i + 6 < n) {
          const c0 = c[i - 5], c1 = c[i - 4], c2 = c[i - 3], c3 = c[i - 2], c4 = c[i - 1], c5 = c[i];
          const c6 = c[i + 1], c7 = c[i + 2], c8 = c[i + 3], c9 = c[i + 4], c10 = c[i + 5], c11 = c[i + 6];
          const v1 = Math.abs(c0 * L1_P1_0 + c1 * L1_P1_1 + c2 * L1_P1_2 + c3 * L1_P1_3 + c4 * L1_P1_4 + c5 * L1_P1_5 + c6 * L1_P1_6 + c7 * L1_P1_7 + c8 * L1_P1_8 + c9 * L1_P1_9 + c10 * L1_P1_10 + c11 * L1_P1_11);
          const v2 = Math.abs(c0 * L1_P2_0 + c1 * L1_P2_1 + c2 * L1_P2_2 + c3 * L1_P2_3 + c4 * L1_P2_4 + c5 * L1_P2_5 + c6 * L1_P2_6 + c7 * L1_P2_7 + c8 * L1_P2_8 + c9 * L1_P2_9 + c10 * L1_P2_10 + c11 * L1_P2_11);
          const v3 = Math.abs(c0 * L1_P3_0 + c1 * L1_P3_1 + c2 * L1_P3_2 + c3 * L1_P3_3 + c4 * L1_P3_4 + c5 * L1_P3_5 + c6 * L1_P3_6 + c7 * L1_P3_7 + c8 * L1_P3_8 + c9 * L1_P3_9 + c10 * L1_P3_10 + c11 * L1_P3_11);
          if (v1 > peak) peak = v1;
          if (v2 > peak) peak = v2;
          if (v3 > peak) peak = v3;
        } else {
          for (const ker of L1_TP_PHASES) {
            let v = 0;
            for (let k = 0; k < 12; k++) {
              const j = i + k - 5;
              if (j >= 0 && j < n) v += c[j] * ker[k];
            }
            peak = Math.max(peak, Math.abs(v));
          }
        }
      }
    }
  }
  const numBlocks = numChunks - 3, blocks = new Float64Array(numBlocks), blockLufs = new Float64Array(numBlocks);
  let absSum = 0, absCount = 0;
  for (let b = 0; b < numBlocks; b++) {
    const p = chunkPower[b] + chunkPower[b + 1] + chunkPower[b + 2] + chunkPower[b + 3];
    blocks[b] = p;
    const lj = p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity;
    blockLufs[b] = lj;
    if (lj > -70) { absSum += p; absCount++; }
  }
  // 无任何 400 ms 窗越过 -70 LUFS 绝对门限时对齐正式 audioLoudness（FFmpeg ebur128 汇总口径 -70.0 LUFS）
  let rawLufs = -70;
  if (absCount > 0) {
    const relGate = -0.691 + 10 * Math.log10(absSum / absCount) - 10;
    let relSum = 0, relCount = 0;
    for (let b = 0; b < numBlocks; b++) {
      if (blockLufs[b] > -70 && blockLufs[b] > relGate) { relSum += blocks[b]; relCount++; }
    }
    if (relCount > 0) rawLufs = -0.691 + 10 * Math.log10(relSum / relCount);
  }
  const rawTp = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  return {
    loudnessLufs: Number.isFinite(rawLufs) ? Math.round(rawLufs * 100) / 100 : rawLufs,
    truePeakDbtp: Number.isFinite(rawTp) ? Math.round(rawTp * 100) / 100 : rawTp,
  };
}

function measure011Audio(track) {
  const { loudnessLufs, truePeakDbtp } = measureAudioLoudness(track);
  return {
    lufs: Number.isFinite(loudnessLufs) ? Math.round(loudnessLufs * 10) / 10 : loudnessLufs,
    truePeakDbtp: Number.isFinite(truePeakDbtp) ? Math.round(truePeakDbtp * 10) / 10 : truePeakDbtp,
  };
}

// 逐帧亮度平面检测黑帧、连续静止冻结段与重复帧（严格对齐 observe/metrics/video-audio.mjs 的 blackFreezeDup 闭区间计数 end - start + 1 >= freezeFrames）
function detectBlackFreezeDup(planes, { blackLevel, blackPercent, freezeDiff, freezeFrames, duplicateDiff }) {
  const black = [], freezes = [];
  let duplicateFrames = 0, start = 0;
  const close = (end) => {
    if (end - start + 1 >= freezeFrames) freezes.push({ in: start, out: end + 1 });
  };
  for (let k = 0; k < planes.length; k++) {
    const plane = planes[k];
    let dark = 0;
    for (let i = 0; i < plane.length; i++) if (plane[i] <= blackLevel) dark++;
    if ((dark * 100) / plane.length >= blackPercent) black.push(k);
    if (k === 0) continue;
    const prev = planes[k - 1];
    let diffSum = 0;
    for (let i = 0; i < plane.length; i++) diffSum += Math.abs(plane[i] - prev[i]);
    const mad = diffSum / plane.length;
    if (mad <= duplicateDiff) duplicateFrames++;
    if (mad > freezeDiff) {
      close(k - 1);
      start = k;
    }
  }
  if (planes.length > 0) close(planes.length - 1);
  return {
    black,
    freezes,
    summary: { blackFrames: black.length, freezeSegments: freezes.length, duplicateFrames },
  };
}

function measure011(q, p) {
  const { size: [width, height], frames } = q.deliverable, fps = fpsOf(q);
  const frameArgs = argsOf(q, 'frame.black-freeze-dup');
  const [pw, ph] = MASTER_01.planeSize;
  const beats = p.frameMotion === 'random-beats' ? randomBeats(p.seed, MASTER_01.beats, [2, frames - 6], 2) : [];
  const activeFrames = new Set(beats.flatMap((b) => Array.from({ length: 1 + (b % 4) }, (_, d) => b + d)));
  let stepPose = 1;
  const poseTable = p.frameMotion === 'random-beats'
    ? Array.from({ length: frames }, (_, k) => {
      if (k > 0 && activeFrames.has(k)) stepPose += 7;
      return stepPose;
    })
    : null;
  // 画面轨道：continuous 逐帧连续运动；random-beats 只在随机拍点短窗内运动、其余区间画面静止；videoShiftFrames 把画面在交付容器里整体错位，露出的首尾空槽是未渲染黑场
  const planes = Array.from({ length: frames }, (_, k) => {
    const shifted = k - p.videoShiftFrames;
    const plane = new Uint8Array(pw * ph);
    if (shifted < 0 || shifted >= frames) {
      for (let i = 0; i < plane.length; i++) plane[i] = 6 + ((k * 7 + i * 3) % 15);
      return plane;
    }
    const pose = poseTable ? poseTable[shifted] : shifted;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        plane[y * pw + x] = Math.round(128 + 85 * Math.sin(2 * Math.PI * (x / pw + pose / 90)) + 25 * Math.cos(2 * Math.PI * (y / ph + pose / 110)));
      }
    }
    return plane;
  });
  const detected = detectBlackFreezeDup(planes, frameArgs);
  // 错位大到把整条画面都推出容器时，没有有效画面，不交给判分
  if (detected.black.length >= frames) throw new RangeError('01-1 的画面错位超出全片总帧数');

  // 音频轨道：合成 48 kHz 立体声 PCM 并按 ITU-R BS.1770-4 与 4 倍过采样真峰值实测（启用 audio.master 母带后为 -14.1 LUFS / -1.7 dBTP，关闭时保留 -9.5 LUFS / 0.8 dBTP）
  const { lufs, truePeakDbtp } = measure011Audio(synthesize011AudioTrack(frames, fps, { audioMaster: p.audioMaster }));
  const colorTag = p.colorTags ? 'bt709' : 'unknown';

  const measured = {
    output: { size: [width, height], fps: q.deliverable.fps, frames, colorTag },
    blackFrames: detected.black,
    freezes: detected.freezes,
    audio: { loudnessLufs: lufs, truePeakDbtp },
  };
  return {
    base: buildBaseEvidence(q, measured),
    'deliver.spec': {
      width,
      height,
      fps,
      frames,
      color_space: 'bt709',
      color_transfer: colorTag,
      color_primaries: colorTag,
      color_range: 'tv',
      audioChannels: 2,
      audioLayout: 'stereo',
    },
    'audio.loudness': { lufs, truePeakDbtp },
    'frame.black-freeze-dup': detected.summary,
  };
}

/* ---------------- 23-1：无缝转台循环 ---------------- */

const TURN_23 = deepFreeze({ size: [64, 16], beats: 12 });
const BASE_23_1 = deepFreeze({ orbitDegrees: 360, loopShiftFrames: 0, orbitMode: 'uniform', seed: null });

function turnFrame(degrees) {
  const [width, height] = TURN_23.size, rgba = new Uint8Array(width * height * 4).fill(255);
  const rad = (degrees * Math.PI) / 180;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const phi = (2 * Math.PI * x) / width + y * 0.15;
      const level = Math.round(128 + 85 * Math.sin(phi + rad) + 30 * Math.cos(2 * phi - rad));
      const idx = (y * width + x) * 4;
      rgba[idx] = level;
      rgba[idx + 1] = level;
      rgba[idx + 2] = level;
    }
  }
  return { width, height, rgba };
}

function build231Angles(q, p) {
  const { frames } = q.deliverable;
  if (Math.abs(p.loopShiftFrames) >= frames / 2) throw new RangeError('23-1 的错位帧数超出半圈搜索窗口');
  const stepDeg = 360 / frames;
  const closeFrame = frames - 1 - p.loopShiftFrames;
  const underDeg = p.orbitDegrees + p.loopShiftFrames * stepDeg;
  const beats = p.orbitMode === 'random-beats' ? randomBeats(p.seed, TURN_23.beats, [2, frames - 1], 4) : [];
  const rand = p.orbitMode === 'random-beats' ? rng(p.seed + 1) : null;
  // 随机拍点：后半段里有一个拍点回到 0° 附近（使最像第 0 帧的帧号落在它上面而不是第 71 帧），末帧跳到半圈附近
  const secondHalf = beats.filter((b) => b >= 36 && b <= frames - 3);
  const nearBeat = rand && secondHalf.length ? secondHalf[Math.floor(rand() * secondHalf.length)] : 54;
  const beatAngles = beats.map((b) => (b === nearBeat ? 358 + (rand() - 0.5) : 35 + Math.floor(rand() * 280)));
  const endAngle = rand ? 155 + Math.floor(rand() * 50) : 0;

  // 正向错位（如 shift-2f 为 2）让整圈在 closeFrame（第 69 帧）提前转满 p.orbitDegrees，余下帧每帧缓滑 +0.4°（总转角 360.8° 仍在 [359, 361] 内）；反向错位按单调欠转求值
  const degAt = (k) => {
    if (p.orbitMode !== 'random-beats') {
      if (p.loopShiftFrames > 0) {
        return k <= closeFrame ? (k / closeFrame) * p.orbitDegrees : p.orbitDegrees + 0.4 * (k - closeFrame);
      }
      return (k * underDeg) / frames;
    }
    if (k === 0) return 0;
    if (k === 1) return stepDeg;
    if (k === frames - 1) return endAngle;
    if (k === nearBeat) return 358.5;
    let idx = -1;
    for (let i = 0; i < beats.length; i++) if (beats[i] <= k) idx = i;
    return idx >= 0 ? beatAngles[idx] : stepDeg * 2;
  };
  const orbitSeen = p.orbitMode === 'random-beats'
    ? endAngle
    : (p.loopShiftFrames > 0 ? p.orbitDegrees + 0.4 * p.loopShiftFrames : underDeg);
  return { degAt, orbitSeen };
}

function measure231(q, p) {
  const { size: [width, height], frames } = q.deliverable;
  const { degAt, orbitSeen } = build231Angles(q, p);
  const rendered = Array.from({ length: frames }, (_, k) => turnFrame(degAt(k)));
  const frameAt = (k) => rendered[k];
  // 提取 8 位灰度平面并同步实测黑帧、连续静止冻结段与原始像素 YDIF > 24 切点，与 blackFreezeDup 及 cutYdif(file, 24) 完全一致
  const area = TURN_23.size[0] * TURN_23.size[1], cuts = [];
  const planes = rendered.map(({ rgba }, k) => {
    const plane = new Uint8Array(area);
    let diffSum = 0;
    const prev = k > 0 ? rendered[k - 1].rgba : null;
    for (let i = 0; i < area; i++) {
      const v = rgba[i * 4];
      plane[i] = v;
      if (prev !== null) diffSum += Math.abs(v - prev[i * 4]);
    }
    if (prev !== null && diffSum / area > 24) cuts.push(k);
    return plane;
  });
  const still = detectBlackFreezeDup(planes, { blackLevel: 32, blackPercent: 98, freezeDiff: 0.15, freezeFrames: 3, duplicateDiff: 0 });
  const search = argsOf(q, 'loop.closure-psnr').search;
  const measured = {
    output: { size: [width, height], fps: q.deliverable.fps, frames, colorTag: 'bt709' },
    blackFrames: still.black,
    freezes: still.freezes,
    cuts,
    orbitTotalDeg: { 'camera:subject': orbitSeen },
  };
  return {
    base: buildBaseEvidence(q, measured),
    'loop.closure-psnr': {
      ...readNearest(frameAt, search),
      ...readClosure(frameAt(0), frameAt(frames - 1), frameAt(1)),
    },
  };
}

// 导出 23-1 渲染帧的 8 位灰度亮度平面，供单测编码为无损成片与正式 cutYdif / blackFreezeDup 逐帧对拍
export function synthesize231Planes(perturbation = {}, seed = null) {
  checkPerturbation('23-1', perturbation);
  checkSeed(Object.values(perturbation).includes('random-beats'), seed);
  const q = loadQuestion('23-1');
  const p = globalThis.structuredClone({ ...BASE_23_1, ...perturbation, seed });
  const { frames } = q.deliverable;
  const { degAt } = build231Angles(q, p);
  const area = TURN_23.size[0] * TURN_23.size[1];
  return Array.from({ length: frames }, (_, k) => {
    const { rgba } = turnFrame(degAt(k));
    const plane = new Uint8Array(area);
    for (let i = 0; i < area; i++) plane[i] = rgba[i * 4];
    return plane;
  });
}

/* ---------------- 28-1：环绕取景 ---------------- */

const ORBIT_28 = deepFreeze({ bgHex: '#6E6C6C', bgRgb: [110, 108, 108], bodyRgb: [30, 30, 40], stripeRgb: [200, 180, 160], samples: [0, 72, 144, 216], beats: 12 });
const BASE_28_1 = deepFreeze({ subjectHeightPx: 560, orbitDegrees: 360, metaShiftFrames: 0, orbitMode: 'uniform', seed: null });

function measure281(q, p) {
  const { size: [W, H], frames } = q.deliverable;
  if (Math.abs(p.metaShiftFrames) >= frames || p.subjectHeightPx >= H) throw new RangeError('28-1 的参数超出画幅或总帧数');
  const beats = p.orbitMode === 'random-beats' ? randomBeats(p.seed, ORBIT_28.beats, [2, frames - 1], 12) : [];
  const rand = p.orbitMode === 'random-beats' ? rng(p.seed + 1) : null;
  const beatPoses = beats.map(() => ({
    deg: 40 + Math.floor(rand() * 280),
    heightPx: 632 + Math.floor(rand() * 56),
  }));

  const poseAt = (k) => {
    if (p.orbitMode !== 'random-beats') {
      return { deg: (k * p.orbitDegrees) / frames, heightPx: p.subjectHeightPx };
    }
    if (k === 0) return { deg: 0, heightPx: p.subjectHeightPx };
    if (k === 1) return { deg: 360 / frames, heightPx: p.subjectHeightPx };
    let idx = -1;
    for (let i = 0; i < beats.length; i++) if (beats[i] <= k) idx = i;
    return idx >= 0 ? beatPoses[idx] : { deg: 360 / frames, heightPx: p.subjectHeightPx };
  };

  const trueBoxAt = (k) => {
    const { deg, heightPx } = poseAt(k), theta = (deg * Math.PI) / 180;
    const cx = 960 + Math.round(72 * Math.sin(4 * theta));
    const halfW = 260 + Math.round(30 * Math.cos(theta));
    const halfH = Math.round(heightPx / 2);
    return [cx - halfW, Math.round(H / 2) - halfH, cx + halfW, Math.round(H / 2) + halfH];
  };
  const metaBoxAt = (k) => trueBoxAt(((k - p.metaShiftFrames) % frames + frames) % frames);

  const rectsAt = (k) => {
    const box = trueBoxAt(k), { deg } = poseAt(k), theta = (deg * Math.PI) / 180;
    const cx = Math.round((box[0] + box[2]) / 2);
    const stripe = cx + Math.round(140 * Math.sin(theta));
    return [
      [...box, ORBIT_28.bodyRgb],
      [stripe - 20, box[1] + 40, stripe + 20, box[3] - 40, ORBIT_28.stripeRgb],
    ];
  };
  const frameAt = (k) => paint(W, H, ORBIT_28.bgRgb, rectsAt(k));

  const metaBoxes = Array.from({ length: frames }, (_, k) => metaBoxAt(k));
  const samples = ORBIT_28.samples.map((k) => ({ frame: frameAt(k), box: metaBoxes[k] }));
  const orbitSeen = p.orbitMode === 'random-beats' ? poseAt(frames - 1).deg : p.orbitDegrees;
  const video = analyzeRectFrames(W, H, ORBIT_28.bgRgb, Array.from({ length: frames }, (_, k) => rectsAt(k)));
  const measured = {
    output: { size: [W, H], fps: q.deliverable.fps, frames, colorTag: 'bt709' },
    blackFrames: video.blackFrames,
    freezes: video.freezes,
    cuts: video.cuts,
    orbitTotalDeg: { 'camera:subject': orbitSeen },
    frames: metaBoxes.map((bbox2d, frame) => ({ frame, meta: { size: [W, H], entities: [{ name: 'subject', bbox2d }] } })),
  };
  return {
    base: buildBaseEvidence(q, measured),
    'meta.bbox-limits': readFraming(metaBoxes, [W, H]),
    'loop.closure-psnr': readClosure(frameAt(0), frameAt(frames - 1), frameAt(1)),
    'pixel.bbox': readPixelBoxes(samples, ORBIT_28.bgHex, 16),
  };
}

/* ---------------- 29-1：上下分屏版式 ---------------- */

const LAYOUT_29 = deepFreeze({
  bgRgb: [9, 9, 6],
  panelRgb: [128, 110, 90],
  dividerBaseRgb: [0xCB, 0xFB, 0x03],
  pulseBaseStart: 298,
  pulseLen: 2,
  pulseColorDelta: 24,
  beats: 12,
});
const BASE_29_1 = deepFreeze({ panelMarginPx: 44, dividerColorDelta: 1, transitionShiftFrames: 0, pulseTrigger: 'scheduled', seed: null });

function build291Timeline(q, p) {
  const { size: [W, H], frames } = q.deliverable;
  if (Math.abs(p.transitionShiftFrames) >= frames || p.panelMarginPx >= 300 || p.dividerColorDelta > 200) {
    throw new RangeError('29-1 的参数超出版式允许范围');
  }
  const beats = p.pulseTrigger === 'random-beats' ? randomBeats(p.seed, LAYOUT_29.beats, [10, frames - 10], 20) : [];
  const pulseStart = LAYOUT_29.pulseBaseStart + p.transitionShiftFrames;

  // 逐帧生成当帧真实矩形与对应 meta，绝不跨帧复用：scheduled 模式下全片 600 帧几何恒定，[pulseStart, pulseStart+2) 仅做分隔线绿通道色阶脉冲
  const frameSpecAt = (frame) => {
    const topBand = [p.panelMarginPx, 652];
    const bottomBand = [698, H - p.panelMarginPx];
    let sideInsetPx = 0, colorDelta = p.dividerColorDelta;
    if (p.pulseTrigger === 'random-beats') {
      const dist = Math.min(...beats.map((b) => Math.abs(b - frame)));
      sideInsetPx = 6 + (dist % 25);
      colorDelta = 10 + ((beats[0] + dist) % 40);
    } else if (frame >= pulseStart && frame < pulseStart + LAYOUT_29.pulseLen) {
      colorDelta = Math.max(p.dividerColorDelta, LAYOUT_29.pulseColorDelta);
    }
    const dividerColor = [LAYOUT_29.dividerBaseRgb[0], Math.max(0, LAYOUT_29.dividerBaseRgb[1] - colorDelta), LAYOUT_29.dividerBaseRgb[2]];
    // 面板内容带逐帧微幅连续明度变化（第 300 抽样帧恰为基准色，帧间 YDIF ~ 1.8..3.6 > 0.15 不触发冻结且远低于 24 切点阈值，与底色差 > 84 远超容差 32）
    const panelDrift = (frame % 3) * 2;
    const panelColor = [LAYOUT_29.panelRgb[0] + panelDrift, LAYOUT_29.panelRgb[1] + panelDrift, LAYOUT_29.panelRgb[2] + panelDrift];
    const pieces = [
      ['panel_top', [sideInsetPx, topBand[0], W - sideInsetPx, topBand[1]], panelColor],
      ['divider', [0, 673, W, 677], dividerColor],
      ['panel_bottom', [sideInsetPx, bottomBand[0], W - sideInsetPx, bottomBand[1]], panelColor],
    ];
    return {
      rects: pieces.map(([, box, rgb]) => [...box, rgb]),
      meta: {
        size: [W, H],
        entities: pieces.map(([name, bbox2d]) => ({ name, bbox2d })),
      },
    };
  };

  const paintFrame = (frame) => paint(W, H, LAYOUT_29.bgRgb, frameSpecAt(frame).rects);
  return { W, H, frames, frameSpecAt, paintFrame };
}

function measure291(q, p) {
  const args = argsOf(q, 'layout.edges'), sampleFrame = args.frame;
  const { W, H, frames, frameSpecAt, paintFrame } = build291Timeline(q, p);
  if (!Number.isInteger(sampleFrame) || sampleFrame < 0 || sampleFrame >= frames) {
    throw new RangeError('29-1 的抽样帧超出全片范围');
  }
  const specs = Array.from({ length: frames }, (_, frame) => frameSpecAt(frame));
  const video = analyzeRectFrames(W, H, LAYOUT_29.bgRgb, specs.map((s) => s.rects));
  const layout = readLayout(paintFrame(sampleFrame), args, [W, H]);
  const measured = {
    output: { size: [W, H], fps: q.deliverable.fps, frames, colorTag: 'bt709' },
    blackFrames: video.blackFrames,
    freezes: video.freezes,
    cuts: video.cuts,
    frames: specs.map((s, frame) => ({ frame, meta: s.meta })),
  };
  return {
    base: buildBaseEvidence(q, measured),
    'layout.edges': layout,
  };
}

export function inspect291Frames(perturbation = {}, seed = null, sampleFrames = []) {
  if (!Array.isArray(sampleFrames)) throw new TypeError('inspect291Frames 的 sampleFrames 要是数组');
  checkPerturbation('29-1', perturbation);
  checkSeed(Object.values(perturbation).includes('random-beats'), seed);
  const q = loadQuestion('29-1');
  const params = globalThis.structuredClone({ ...BASE_29_1, ...perturbation, seed });
  const args = argsOf(q, 'layout.edges');
  const { W, H, frames, frameSpecAt, paintFrame } = build291Timeline(q, params);
  const sampledLayouts = Object.fromEntries(Array.from(sampleFrames).map((f) => {
    if (!Number.isInteger(f) || f < 0 || f >= frames) throw new RangeError(`29-1 抽样帧越界：${String(f)}`);
    return [f, readLayout(paintFrame(f), args, [W, H])];
  }));
  return globalThis.structuredClone({
    frames: Array.from({ length: frames }, (_, frame) => ({ frame, meta: frameSpecAt(frame).meta })),
    sampledLayouts,
  });
}

/* ---------------- 正对照与负对照入口 ---------------- */

const MODES = deepFreeze({
  frameMotion: ['continuous', 'random-beats'],
  orbitMode: ['uniform', 'random-beats'],
  pulseTrigger: ['scheduled', 'random-beats'],
});
const MODELS = deepFreeze({
  '01-1': [BASE_01_1, measure011],
  '23-1': [BASE_23_1, measure231],
  '28-1': [BASE_28_1, measure281],
  '29-1': [BASE_29_1, measure291],
});

function checkPerturbation(questionId, perturbation) {
  const slug = normalizeQuestionId(questionId);
  if (!Object.hasOwn(MODELS, slug)) throw new RangeError(`没有这道题的信号模型：${String(questionId)}`);
  if (!isPlain(perturbation)) throw new TypeError(`${questionId} 的 perturbation 要是普通对象，给的是 ${typeName(perturbation)}`);
  const [base] = MODELS[slug];
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
      const intKey = key.endsWith('Frames') || key.endsWith('Px') || key.endsWith('Delta');
      if (!(intKey ? Number.isSafeInteger(value) : Number.isFinite(value))) reject(RangeError, intKey ? '要是安全整数' : '要是有限数');
      if ((key === 'orbitDegrees' || key === 'subjectHeightPx' || key === 'panelMarginPx') && value <= 0) reject(RangeError, '要是正数');
      if (key === 'dividerColorDelta' && value < 0) reject(RangeError, '不能是负数');
    }
  }
}

function checkSeed(usesRandomBeats, seed) {
  if (seed !== null && typeof seed !== 'number') throw new TypeError(`种子要是整数或 null，给的是 ${typeName(seed)}`);
  if (usesRandomBeats ? !Number.isSafeInteger(seed) : seed !== null) throw new RangeError('随机拍点要整数种子，别的做法不带种子');
}

export function measure(questionId, perturbation = {}, seed = null) {
  const slug = normalizeQuestionId(questionId);
  checkPerturbation(questionId, perturbation);
  const [base, run] = MODELS[slug];
  checkSeed(Object.values(perturbation).includes('random-beats'), seed);
  const params = globalThis.structuredClone({ ...base, ...perturbation, seed });
  return globalThis.structuredClone({ params, readings: run(loadQuestion(slug), params) });
}

function assertMeasured(value, path, parentKey = '', lastKey = '') {
  const entries = Array.isArray(value) ? Object.entries(Array.from(value)) : isPlain(value) ? Object.entries(value) : null;
  if (entries === null) {
    const allowInfPsnr = parentKey === 'loop.closure-psnr' && (lastKey === 'closurePsnr' || lastKey === 'adjacentPsnr') && value === Infinity;
    const okLeaf = Number.isFinite(value) || allowInfPsnr || (typeof value === 'string' && value.trim().length > 0);
    if (!okLeaf) throw new RangeError(`读数 ${path} 不是有效的有限数或非空标签：${String(value)}`);
    return;
  }
  if (entries.length === 0) throw new RangeError(`读数 ${path} 是空的，没量到东西，不交给判分`);
  for (const [key, item] of entries) assertMeasured(item, `${path}.${key}`, lastKey, key);
}

export function evaluatePerturbedModel(questionId, perturbation = {}, seed = null) {
  const slug = normalizeQuestionId(questionId);
  const measured = measure(questionId, perturbation, seed);
  assertMeasured(measured.readings, slug);
  return { questionId: slug, ...measured, verdict: score(loadQuestion(slug), measured.readings) };
}

export const buildPositiveBaseline = (questionId) => evaluatePerturbedModel(questionId);

/* ---------------- 12 份一级负对照各自的口径 ---------------- */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kept = (r, base, pick) => same(pick(r), pick(base));
const SPEC = 'deliver.spec', LOUD = 'audio.loudness', BFD = 'frame.black-freeze-dup';
const LOOP = 'loop.closure-psnr', BBOX = 'meta.bbox-limits', PIXEL = 'pixel.bbox', EDGES = 'layout.edges';

const CONTROLS = deepFreeze({
  '01-1-disable-card': {
    cards: ['deliver.encode', 'audio.master'],
    perturbation: { colorTags: false, audioMaster: false },
    trace: (r, base) => r[SPEC].color_transfer === 'unknown' && r[SPEC].color_primaries === 'unknown'
      && r[LOUD].lufs > -13.5 && r[LOUD].truePeakDbtp > -1 && kept(r, base, (x) => x[BFD]),
  },
  '01-1-shift-2f': {
    cards: [],
    perturbation: { videoShiftFrames: 2 },
    trace: (r, base) => r[BFD].blackFrames === 2 && r[BFD].freezeSegments === 0 && r[BFD].duplicateFrames === 0
      && kept(r, base, (x) => [x[SPEC], x[LOUD]]),
  },
  '01-1-random-beats': {
    cards: [],
    perturbation: { frameMotion: 'random-beats' },
    trace: (r, base) => r[BFD].blackFrames === 0 && r[BFD].freezeSegments > 0 && r[BFD].duplicateFrames > 0
      && kept(r, base, (x) => [x[SPEC], x[LOUD]]),
  },
  '23-1-disable-card': {
    cards: ['camera.orbit'],
    perturbation: { orbitDegrees: 350 },
    trace: (r, base) => r[LOOP].nearest === 71 && r[LOOP].closurePsnr < r[LOOP].adjacentPsnr - 8 && r[LOOP].adjacentPsnr > base[LOOP].adjacentPsnr,
  },
  '23-1-shift-2f': {
    cards: [],
    perturbation: { loopShiftFrames: 2 },
    trace: (r) => r[LOOP].nearest === 69 && r[LOOP].closurePsnr >= r[LOOP].adjacentPsnr,
  },
  '23-1-random-beats': {
    cards: [],
    perturbation: { orbitMode: 'random-beats' },
    trace: (r, base) => r[LOOP].nearest !== 71 && r[LOOP].nearest !== 69 && r[LOOP].closurePsnr < r[LOOP].adjacentPsnr - 10
      && Math.abs(r[LOOP].adjacentPsnr - base[LOOP].adjacentPsnr) < 1e-9,
  },
  '28-1-disable-card': {
    cards: ['camera.orbit', 'camera.fit'],
    perturbation: { subjectHeightPx: 720, orbitDegrees: 240 },
    trace: (r, base) => r[BBOX].minH > 0.7 && r[BBOX].maxH === r[BBOX].minH && r[LOOP].closurePsnr < r[LOOP].adjacentPsnr - 5
      && kept(r, base, (x) => x[PIXEL]),
  },
  '28-1-shift-2f': {
    cards: [],
    perturbation: { metaShiftFrames: 2 },
    trace: (r, base) => r[PIXEL].maxDiffPx === 14 && kept(r, base, (x) => [x[BBOX], x[LOOP]]),
  },
  '28-1-random-beats': {
    cards: [],
    perturbation: { orbitMode: 'random-beats' },
    trace: (r, base) => r[BBOX].minH < 0.7 && r[BBOX].maxH > 0.7 && r[LOOP].closurePsnr < r[LOOP].adjacentPsnr - 5
      && kept(r, base, (x) => x[PIXEL]),
  },
  '29-1-disable-card': {
    cards: ['layout.panels', 'deliver.encode'],
    perturbation: { panelMarginPx: 48, dividerColorDelta: 12 },
    trace: (r) => same(r[EDGES].edgeErrorsPx, [4, 0, 0, 0, 0, 4]) && same(r[EDGES].sideErrorsPx, [0, 0, 0, 0, 0, 0])
      && r[EDGES].lineColorError === 12,
  },
  '29-1-shift-2f': {
    cards: [],
    perturbation: { transitionShiftFrames: 2 },
    trace: (r) => same(r[EDGES].edgeErrorsPx, [0, 0, 0, 0, 0, 0]) && same(r[EDGES].sideErrorsPx, [0, 0, 0, 0, 0, 0])
      && r[EDGES].lineColorError === LAYOUT_29.pulseColorDelta,
  },
  '29-1-random-beats': {
    cards: [],
    perturbation: { pulseTrigger: 'random-beats' },
    trace: (r) => same(r[EDGES].edgeErrorsPx, [0, 0, 0, 0, 0, 0]) && r[EDGES].sideErrorsPx[0] >= 6
      && r[EDGES].lineColorError >= 10,
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
  if (!B5_L1_QUESTION_IDS.includes(questionId) || !B5_NEGATIVE_KINDS.includes(kind) || id !== `${questionId}-${kind}`) {
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

export const evaluateAllB5L1Negatives = () => B5_L1_QUESTION_IDS.flatMap((id) => B5_NEGATIVE_KINDS.map((kind) => evaluateNegativeControl(`${id}-${kind}`)));
