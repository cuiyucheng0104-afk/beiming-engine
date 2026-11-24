// B5（第一部分）：一级 4 道公开考题（01-1、23-1、28-1、29-1）的标准负对照核验。每道题三种故意做错：关掉题面要用的卡、整体错位 2 帧、换成随机拍点。
// 每道题一个参数化合成信号模型（逐帧亮度平面、双声道混音包络、转台环绕帧序列、环绕取景与逐帧包围盒、分屏版式帧序列），都在题目自己的 deliverable 时间线上现造；
// 读数全部从造出来的信号经真实检测器与 evaluate-b2 的 readLayout、readFraming、readClosure、readNearest、readPixelBoxes（底层调 observe/metrics）量回来，基础谓词经 verify/predicates 的 evaluateAssertion 如实求值，绝不手填分数。
// 正对照是模型的默认参数；负对照只把同目录夹具 <题号>-<种类>.json 里 perturbation 写的参数换掉，别的一概不动，再交给 evaluate-b2 的正式 score。
// 入口分两个：evaluateNegativeControl 是正式核验，夹具先过 validateNegativeControl（栏位、类型、id，关的卡和改的参数照 CONTROLS 逐份对）再量；evaluatePerturbedModel 是模型实验（撤销改动、反向错位、换种子），
// 参数同样验类型。两个入口量回来的读数有空数组、空对象或非有限数时都直接抛错，不交给判分。
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

const json = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
export const loadQuestion = (id) => {
  const slug = id === '1-1' ? '01-1' : id;
  if (!B5_L1_QUESTION_IDS.includes(slug)) throw new RangeError(`没有登记这道一级题：${String(id)}`);
  return json(`../../questions/level-1/${slug}.json`);
};
// 只读登记过的 12 份；别的 id 不去读盘（字符串入口和对象入口一个口径，也不让 id 当路径用）
export function loadControl(id) {
  if (!B5_L1_QUESTION_IDS.some((qid) => B5_NEGATIVE_KINDS.some((kind) => id === `${qid}-${kind}`))) {
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

// 随机拍点：[from, to) 里取 count 个帧号，两两至少隔 gap 帧，回升序
function randomBeats(seed, count, [from, to], gap = 1) {
  const rand = rng(seed), beats = [];
  while (beats.length < count) {
    const frame = from + Math.floor(rand() * (to - from));
    if (beats.every((other) => Math.abs(other - frame) >= gap)) beats.push(frame);
  }
  return beats.sort((a, b) => a - b);
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

const MASTER_01 = deepFreeze({ planeSize: [16, 9], rawLufs: -9.5, rawPeakDbtp: 0.8, masteredLufs: -14.1, masteredPeakDbtp: -1.7, beats: 36 });
const BASE_01_1 = deepFreeze({ colorTags: true, audioMaster: true, videoShiftFrames: 0, frameMotion: 'continuous', seed: null });

// 逐帧亮度平面检测黑帧、连续静止冻结段与重复帧（口径与 frame.black-freeze-dup 一致）
function detectBlackFreezeDup(planes, { blackLevel, blackPercent, freezeDiff, freezeFrames, duplicateDiff }) {
  const black = [], freezes = [];
  let duplicateFrames = 0, freezeStart = null, freezeLen = 0;
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
    if (mad <= freezeDiff) {
      freezeStart ??= k - 1;
      freezeLen++;
    } else {
      if (freezeLen >= freezeFrames) freezes.push({ in: freezeStart, out: freezeStart + freezeLen });
      freezeStart = null;
      freezeLen = 0;
    }
  }
  if (freezeLen >= freezeFrames) freezes.push({ in: freezeStart, out: freezeStart + freezeLen });
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

  // 音频包络：逐帧双声道均方能量与真峰值，启用 audio.master 时归一到 -14.1 LUFS / -1.7 dBTP，关掉时保留未母带处理的混音总线电平
  const bed = rng(101);
  const targetLufs = p.audioMaster ? MASTER_01.masteredLufs : MASTER_01.rawLufs;
  const targetPeak = p.audioMaster ? MASTER_01.masteredPeakDbtp : MASTER_01.rawPeakDbtp;
  let energySum = 0, maxPeakLin = 0;
  const targetLin = 10 ** (targetLufs / 20), peakCapLin = 10 ** (targetPeak / 20);
  for (let k = 0; k < frames; k++) {
    const jitter = 1 + 0.04 * (bed() - 0.5);
    const rms = targetLin * jitter;
    energySum += rms * rms;
    const localPeak = k === 360 ? peakCapLin : Math.min(peakCapLin, rms * 1.414);
    if (localPeak > maxPeakLin) maxPeakLin = localPeak;
  }
  const lufs = Math.round(10 * Math.log10(energySum / frames) * 10) / 10;
  const truePeakDbtp = Math.round(20 * Math.log10(maxPeakLin) * 10) / 10;
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

function measure231(q, p) {
  const { size: [width, height], frames } = q.deliverable;
  if (Math.abs(p.loopShiftFrames) >= frames / 2) throw new RangeError('23-1 的错位帧数超出半圈搜索窗口');
  const stepDeg = 360 / frames;
  const totalDeg = p.orbitDegrees + p.loopShiftFrames * stepDeg;
  const beats = p.orbitMode === 'random-beats' ? randomBeats(p.seed, TURN_23.beats, [2, frames - 1], 4) : [];
  const rand = p.orbitMode === 'random-beats' ? rng(p.seed + 1) : null;
  // 随机拍点：后半段里有一个拍点回到 0° 附近（使最像第 0 帧的帧号落在它上面而不是第 71 帧），末帧跳到半圈附近
  const secondHalf = beats.filter((b) => b >= 36 && b <= frames - 3);
  const nearBeat = rand && secondHalf.length ? secondHalf[Math.floor(rand() * secondHalf.length)] : 54;
  const beatAngles = beats.map((b) => (b === nearBeat ? 358 + (rand() - 0.5) : 35 + Math.floor(rand() * 280)));
  const endAngle = rand ? 155 + Math.floor(rand() * 50) : 0;

  const degAt = (k) => {
    if (p.orbitMode !== 'random-beats') return (k * totalDeg) / frames;
    if (k === 0) return 0;
    if (k === 1) return stepDeg;
    if (k === frames - 1) return endAngle;
    if (k === nearBeat) return 358.5;
    let idx = -1;
    for (let i = 0; i < beats.length; i++) if (beats[i] <= k) idx = i;
    return idx >= 0 ? beatAngles[idx] : stepDeg * 2;
  };
  const frameAt = (k) => turnFrame(degAt(k));
  const search = argsOf(q, 'loop.closure-psnr').search;
  const orbitSeen = p.orbitMode === 'random-beats' ? endAngle : totalDeg;
  const measured = {
    output: { size: [width, height], fps: q.deliverable.fps, frames, colorTag: 'bt709' },
    blackFrames: [],
    freezes: [],
    cuts: [],
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

  const frameAt = (k) => {
    const box = trueBoxAt(k), { deg } = poseAt(k), theta = (deg * Math.PI) / 180;
    const cx = Math.round((box[0] + box[2]) / 2);
    const stripe = cx + Math.round(140 * Math.sin(theta));
    return paint(W, H, ORBIT_28.bgRgb, [
      [...box, ORBIT_28.bodyRgb],
      [stripe - 20, box[1] + 40, stripe + 20, box[3] - 40, ORBIT_28.stripeRgb],
    ]);
  };

  const metaBoxes = Array.from({ length: frames }, (_, k) => metaBoxAt(k));
  const samples = ORBIT_28.samples.map((k) => ({ frame: frameAt(k), box: metaBoxes[k] }));
  const orbitSeen = p.orbitMode === 'random-beats' ? poseAt(frames - 1).deg : p.orbitDegrees;
  const measured = {
    output: { size: [W, H], fps: q.deliverable.fps, frames, colorTag: 'bt709' },
    blackFrames: [],
    freezes: [],
    cuts: [],
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

const LAYOUT_29 = deepFreeze({ bgRgb: [9, 9, 6], panelRgb: [128, 110, 90], dividerBaseRgb: [0xCB, 0xFB, 0x03], pulseBaseStart: 298, pulseLen: 2, beats: 12 });
const BASE_29_1 = deepFreeze({ panelMarginPx: 44, dividerColorDelta: 1, transitionShiftFrames: 0, pulseTrigger: 'scheduled', seed: null });

function measure291(q, p) {
  const { size: [W, H], frames } = q.deliverable;
  const args = argsOf(q, 'layout.edges'), sampleFrame = args.frame;
  if (Math.abs(p.transitionShiftFrames) >= frames || p.panelMarginPx >= 300 || p.dividerColorDelta > 200) {
    throw new RangeError('29-1 的参数超出版式允许范围');
  }
  const beats = p.pulseTrigger === 'random-beats' ? randomBeats(p.seed, LAYOUT_29.beats, [10, frames - 10], 20) : [];
  let topBand = [p.panelMarginPx, 652], bottomBand = [698, H - p.panelMarginPx], sideInsetPx = 0, colorDelta = p.dividerColorDelta;
  if (p.pulseTrigger === 'random-beats') {
    const dist = Math.min(...beats.map((b) => Math.abs(b - sampleFrame)));
    sideInsetPx = 6 + (dist % 25);
    colorDelta = 10 + ((beats[0] + dist) % 40);
  } else {
    // 中场面板脉冲默认发生在 [298, 300)，第 300 帧已恢复到位；整体晚 2 帧（transitionShiftFrames = 2）时脉冲落到 [300, 302)，第 300 帧上下两个面板向下偏移 2 像素
    const pulseStart = LAYOUT_29.pulseBaseStart + p.transitionShiftFrames;
    const inPulse = sampleFrame >= pulseStart && sampleFrame < pulseStart + LAYOUT_29.pulseLen;
    const shiftPx = inPulse ? 2 : 0;
    topBand = [p.panelMarginPx + shiftPx, 652 + shiftPx];
    bottomBand = [698 + shiftPx, H - p.panelMarginPx + shiftPx];
  }
  const dividerColor = [LAYOUT_29.dividerBaseRgb[0], Math.max(0, LAYOUT_29.dividerBaseRgb[1] - colorDelta), LAYOUT_29.dividerBaseRgb[2]];
  const frame300 = paint(W, H, LAYOUT_29.bgRgb, [
    [sideInsetPx, topBand[0], W - sideInsetPx, topBand[1], LAYOUT_29.panelRgb],
    [0, 673, W, 677, dividerColor],
    [sideInsetPx, bottomBand[0], W - sideInsetPx, bottomBand[1], LAYOUT_29.panelRgb],
  ]);
  const layout = readLayout(frame300, args, [W, H]);
  const names = ['panel_top', 'divider', 'panel_bottom'];
  const entities = Array.isArray(layout.bands) && layout.bands.length === 3
    ? names.map((name, idx) => ({
      name,
      bbox2d: [layout.sideErrorsPx[idx * 2], layout.bands[idx][0], W - layout.sideErrorsPx[idx * 2 + 1], layout.bands[idx][1]],
    }))
    : [];
  const meta = { size: [W, H], entities };
  const measured = {
    output: { size: [W, H], fps: q.deliverable.fps, frames, colorTag: 'bt709' },
    blackFrames: [],
    freezes: [],
    frames: Array.from({ length: frames }, (_, frame) => ({ frame, meta })),
  };
  return {
    base: buildBaseEvidence(q, measured),
    'layout.edges': layout,
  };
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
  checkPerturbation(questionId, perturbation);
  const [base, run] = MODELS[questionId];
  checkSeed(Object.values(perturbation).includes('random-beats'), seed);
  const params = globalThis.structuredClone({ ...base, ...perturbation, seed });
  return globalThis.structuredClone({ params, readings: run(loadQuestion(questionId), params) });
}

function assertMeasured(value, path) {
  const entries = Array.isArray(value) ? Object.entries(Array.from(value)) : isPlain(value) ? Object.entries(value) : null;
  if (entries === null) {
    const okLeaf = Number.isFinite(value) || (typeof value === 'string' && value.trim().length > 0);
    if (!okLeaf) throw new RangeError(`读数 ${path} 不是有效的有限数或非空标签：${String(value)}`);
    return;
  }
  if (entries.length === 0) throw new RangeError(`读数 ${path} 是空的，没量到东西，不交给判分`);
  for (const [key, item] of entries) assertMeasured(item, `${path}.${key}`);
}

export function evaluatePerturbedModel(questionId, perturbation = {}, seed = null) {
  const measured = measure(questionId, perturbation, seed);
  assertMeasured(measured.readings, questionId);
  return { questionId, ...measured, verdict: score(loadQuestion(questionId), measured.readings) };
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
    trace: (r) => r[LOOP].nearest === 70 && r[LOOP].closurePsnr >= r[LOOP].adjacentPsnr,
  },
  '23-1-random-beats': {
    cards: [],
    perturbation: { orbitMode: 'random-beats' },
    trace: (r, base) => r[LOOP].nearest !== 71 && r[LOOP].nearest !== 70 && r[LOOP].closurePsnr < r[LOOP].adjacentPsnr - 10
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
    trace: (r, base) => same(r[EDGES].edgeErrorsPx, [2, 2, 0, 0, 2, 2]) && same(r[EDGES].sideErrorsPx, [0, 0, 0, 0, 0, 0])
      && r[EDGES].lineColorError === base[EDGES].lineColorError,
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
