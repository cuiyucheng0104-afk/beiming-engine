// B6：二级第二批 4 道题（5-1、18-1、18-2、15-2）的标准负对照核验。每道题三种故意做错：关掉题面要用的卡、整体错位 2 帧、换成随机拍点。
// 每道题一个小的参数化信号模型（包络、逐帧低频电平、旁白电平、灰度帧、彩色帧、逐帧相机矩阵），都在题目自己的 deliverable 时间线上现造；
// 读数全部从造出来的信号量回来（observe 的对位、切点、缩放平移、主色，加本文件几个照题面口径写的小检测器），不手填。
// 正对照是模型的默认参数；负对照只把同目录夹具 <题号>-<种类>.json 里 perturbation 写的参数换掉，别的一概不动，再交给 evaluate-b4 的正式 score（不传第三个参数）。
// 没有原片媒体和题目资产：配乐、旁白、画面都是确定性的合成信号，只用来核「判分线拦不拦得住这三种错」，不是做题。
// 15-2 的逐帧相机矩阵是帧元数据，由模型的机位直接写出，不经检测器；别的读数都是从信号里检测出来的。
// 「关卡」的口径：题面 needs 里的 audio.align、camera.cue-kf、camera.drift、page.det2d 四张卡还没入库，没有卡文件可对；
// 关掉一张卡，照题面 brief 和 controls.negative 的写法解释成「这张卡管的那件事没人做」，一张卡可以对着模型的不止一个参数。
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { telemetry } from '../../../observe/index.mjs';
import { parseFps } from '../../../verify/predicates.mjs';
import { median, readBaseShare, readLock, readMoveStarts, readMusicAlign, score } from '../../questions/level-2-b/evaluate-b4.mjs';

export const B6_QUESTION_IDS = ['5-1', '18-1', '18-2', '15-2'];
export const B6_NEGATIVE_KINDS = ['disable-card', 'shift-2f', 'random-beats'];
export const B6_FORMAT = 'bench-negative/0.1';

const json = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
export const loadQuestion = (id) => json(`../../questions/level-2-b/${id}.json`);
export const loadControl = (id) => json(`./${id}.json`);
const argsOf = (q, pick) => q.scoring.find(({ args }) => pick(args)).args;
const fpsOf = (q) => { const { num, den } = parseFps(q.deliverable.fps); return Number(num) / Number(den); };

/* ---------------- 合成信号的零件 ---------------- */

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
// 连续的纹理（两层格点噪声），任意坐标可取值；shot 换一套格点，就是另一个镜头的画面
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
  return 0.7 * layer(x / 9, y / 9) + 0.3 * layer(x / 3, y / 3);
}
// 和 motionZoomPan 一个变换模型：以帧中心为原点缩放 scale，再平移 (dx, dy)；noise 是画面里的东西自己在动带来的起伏（均匀噪声的全幅）
function grayFrame([width, height], { scale = 1, dx = 0, dy = 0, noise = 0, seed = 1, shot = 0 } = {}) {
  const cx = (width - 1) / 2, cy = (height - 1) / 2, rand = rng(seed), gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = 30 + 195 * texture((x - cx - dx) / scale + cx, (y - cy - dy) / scale + cy, shot) + noise * (rand() - 0.5);
    gray[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
  }
  return gray;
}
// 一条 10 毫秒一格的旁白电平（dBFS）：说话 −18 上下，停顿 −60 上下
const LEVEL_STEP_SEC = 0.01;
function narrationLevel(sentences, spanSec, seed) {
  const rand = rng(seed);
  return Array.from({ length: Math.round(spanSec / LEVEL_STEP_SEC) }, (_, i) => {
    const at = (i + 0.5) * LEVEL_STEP_SEC;
    return (sentences.some(([from, to]) => at >= from && at < to) ? -18 : -60) + 4 * (rand() - 0.5);
  });
}

/* ---------------- 照题面口径的小检测器 ---------------- */

// 旁白的说话段：被低于 pauseDb、不短于 minPauseSec 的停顿隔开；回每段的 [起声, 收声]（秒）
function speechSpans(levelDb, { pauseDb, minPauseSec }) {
  const spans = [], minQuiet = Math.round(minPauseSec / LEVEL_STEP_SEC);
  let from = null, quiet = 0;
  levelDb.forEach((level, i) => {
    if (level >= pauseDb) { from ??= i; quiet = 0; } else if (from !== null && ++quiet === minQuiet) { spans.push([from, i - quiet + 1]); from = null; }
  });
  if (from !== null) spans.push([from, levelDb.length - quiet]);
  // 格数乘步长再取到毫秒：0.01 的整数倍在二进制里不精确，不取整会带一串尾数
  return spans.map((span) => span.map((step) => Math.round(step * LEVEL_STEP_SEC * 1000) / 1000));
}
// 逐帧低频电平里高出中位数 riseDb 以上的局部峰，回帧号
function lowBandPeaks(levelDb, riseDb) {
  const floor = median(levelDb) + riseDb;
  return levelDb.flatMap((level, f) => (level >= floor && level > (levelDb[f - 1] ?? -Infinity) && level >= (levelDb[f + 1] ?? -Infinity) ? [f] : []));
}
// 一条逐帧序列里连着在变的段，回 [第一处变化的帧, 最后一处变化的帧]
function changeRuns(series) {
  const runs = [];
  for (let k = 1; k < series.length; k++) {
    if (series[k] === series[k - 1]) continue;
    if (runs.length && runs.at(-1)[1] === k - 1) runs.at(-1)[1] = k; else runs.push([k, k]);
  }
  return runs;
}

/* ---------------- 5-1：配乐对位，重击落在硬切上 ---------------- */

// 题目自带配乐的替身：30.04 秒，十下低频重击（配乐自己的时间，秒）。最后一下在 25.83 秒，原样铺上去落在第 620 帧，离第 624 帧的硬切 4 帧；
// 拉伸 1.009、平移 −0.02 秒之后落在第 625 帧（离硬切 1 帧，和题面写的参考读数一个量级）。偏晚还是偏早是任选的：
// 容差就是 2 帧，错位 2 帧拦不拦得住只看正对照原来偏在哪一边（正好压在硬切上时两边都拦不住），所以只有偏晚的那一份负对照。
const TRACK = { sec: 30.04, hitsSec: [1.46, 4.18, 6.94, 9.62, 12.38, 15.14, 17.86, 20.62, 23.34, 25.83], cutFrame: 624, noise: 0.333 };
const BASE_5_1 = { stretch: 1.009, offsetSec: -0.02, audioShiftFrames: 0, hitTrigger: 'track', seed: null };

function measure51(q, p) {
  const fps = fpsOf(q), { frames } = q.deliverable;
  const alignArgs = argsOf(q, (a) => a.stretch !== undefined), hitArgs = argsOf(q, (a) => a.eventFrames !== undefined);
  const step = alignArgs.stepSec, shiftSec = p.audioShiftFrames / fps;
  // 成片里每下重击的时刻：照对位之后的配乐来，或者换成随机拍点
  const hitsSec = p.hitTrigger === 'random-beats' ? randomBeats(p.seed, TRACK.hitsSec.length, [0, frames], 6).map((frame) => frame / fps)
    : TRACK.hitsSec.map((at) => p.offsetSec + p.stretch * at + shiftSec);
  // 20 毫秒能量包络：配乐是平滑的起伏加重击处的重音；成片音轨是它照参数平移、拉伸之后的起伏，加成片里重击处的重音，再叠上不相关的声音
  const m = Math.round(TRACK.sec / step), n = Math.round(frames / fps / step), bed = rng(5), other = rng(11);
  const raw = Array.from({ length: m + 4 }, () => bed());
  const smooth = Array.from({ length: m }, (_, k) => (raw[k] + raw[k + 1] + raw[k + 2] + raw[k + 3] + raw[k + 4]) / 5);
  const accents = (times, length) => { const at = new Set(times.map((sec) => Math.round(sec / step))); return (k) => (k < length && at.has(k) ? 0.5 : 0); };
  const trackAccent = accents(TRACK.hitsSec, m), filmAccent = accents(hitsSec, n);
  const trackEnvelope = smooth.map((value, k) => value + trackAccent(k));
  const filmEnvelope = Array.from({ length: n }, (_, i) => {
    const k = (i * step - p.offsetSec - shiftSec) / step / p.stretch, k0 = Math.floor(k);
    return (k0 >= 0 && k0 + 1 < m ? smooth[k0] + (smooth[k0 + 1] - smooth[k0]) * (k - k0) : 0.5) + filmAccent(i) + TRACK.noise * (other() - 0.5);
  });
  // 逐帧的低频（120 Hz 以下）电平：底噪 −30 dB 上下，重击那一帧高 14 dB，后一帧是余音
  const low = rng(7), hitFrames = new Set(hitsSec.map((sec) => Math.round(sec * fps)));
  const lowDb = Array.from({ length: frames }, (_, f) => -30 + 3 * (low() - 0.5) + (hitFrames.has(f) ? 14 : hitFrames.has(f - 1) ? 4 : 0));
  // 画面：两个镜头，第 624 帧硬切；镜头里只有细微的起伏
  const size = [48, 27];
  const planes = Array.from({ length: frames }, (_, f) => grayFrame(size, { shot: f < TRACK.cutFrame ? 1 : 2, noise: 6, seed: f + 1 }));
  const seen = telemetry({ width: size[0], height: size[1], frames: planes, rangeMode: 'full' });
  if (!seen.ok) throw new Error(`切点没量出来：${seen.error.message}`);
  return {
    'music.align': readMusicAlign({ filmEnvelope, trackEnvelope, fps }, alignArgs),
    'beat.onset-hit': { eventFrames: seen.detectedCuts, markFrames: lowBandPeaks(lowDb, hitArgs.riseDb), range: [0, frames] },
  };
}

/* ---------------- 18-1：旁白讲解场景的版式与字幕节奏 ---------------- */

// 题目自带旁白的替身：五个场景各 6 秒，每场两句；[起声, 收声] 是离场景起点的秒。句间停顿 0.4 秒以上，场景首尾各留 0.4 秒以上
const NARRATION = { sceneFrames: 180, sentences: [
  [[0.52, 2.71], [3.14, 5.48]], [[0.46, 2.35], [2.88, 5.55]], [[0.61, 2.93], [3.37, 5.51]], [[0.43, 2.48], [3.05, 5.44]], [[0.5, 2.8], [3.26, 5.47]],
] };
const PAGE = { size: [80, 45], bandRows: 9, base: '#F4F0E9', text: '#1A1714', plain: '#7F8790',
  content: ['#3C6C9C', '#B95348', '#2F7D5B', '#8A5FA8', '#C28A2E'], contentBox: [34, 18] };
const BASE_18_1 = { subtitleTrigger: 'narration', subtitleShiftFrames: 0, sceneFadeFrames: [3, 4, 3, 4], pageCanvas: true, seed: null };
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function measure181(q, p) {
  const fps = fpsOf(q), { frames } = q.deliverable, spanSec = frames / fps;
  const lagArgs = argsOf(q, (a) => a.maxSubtitleLagSec !== undefined), paletteArgs = argsOf(q, (a) => a.color !== undefined);
  const scenes = NARRATION.sentences.length, sceneOf = (k) => Math.min(scenes - 1, Math.floor(k / NARRATION.sceneFrames));
  const spoken = NARRATION.sentences.flatMap((list, s) => list.map(([from, to]) => [from, to].map((sec) => s * NARRATION.sceneFrames / fps + sec)));
  // 声音：旁白电平里量起声和收声
  const speech = speechSpans(narrationLevel(spoken, spanSec, 18), lagArgs);
  const onsetsSec = speech.map(([from]) => from);
  // 字幕块出现的帧：跟着旁白时是起声之后的第一个帧边界（字不抢在声音前面）；不跟旁白时是等间隔，或者随机拍点
  const blocks = spoken.length;
  const trigger = { narration: () => spoken.map(([from]) => Math.ceil(from * fps - 1e-6)),
    'fixed-interval': () => Array.from({ length: blocks }, (_, i) => Math.round((i + 0.5) * frames / blocks)),
    'random-beats': () => randomBeats(p.seed, blocks, [0, frames], 2) }[p.subtitleTrigger]().map((frame) => frame + p.subtitleShiftFrames);
  // 画面：页面铺底色时底色占满，没铺时只剩字幕条是底色；每场一块内容色块，场景末尾若干帧淡出；字幕条里是当前这块字幕的深色字
  const [width, height] = PAGE.size, bandTop = height - PAGE.bandRows, [boxW, boxH] = PAGE.contentBox;
  const base = rgbOf(PAGE.base), text = rgbOf(PAGE.text), plain = rgbOf(PAGE.plain);
  const frameAt = (k) => {
    const rgba = new Uint8Array(width * height * 4).fill(255), s = sceneOf(k), ground = p.pageCanvas ? base : plain;
    const put = (x, y, rgb) => rgba.set(rgb, (y * width + x) * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, y >= bandTop ? base : ground);
    const left = (s + 1) * NARRATION.sceneFrames - k, fade = p.sceneFadeFrames[s] ?? 0;
    const alpha = s < scenes - 1 && left <= fade ? left / (fade + 1) : 1;
    const color = rgbOf(PAGE.content[s]).map((channel, c) => Math.round(ground[c] + (channel - ground[c]) * alpha));
    for (let y = 6; y < 6 + boxH; y++) for (let x = 8; x < 8 + boxW; x++) put(x, y, color);
    const block = trigger.findLastIndex((frame) => frame <= k);
    if (block >= 0 && sceneOf(trigger[block]) === s) for (let i = 0; i < 60 + 6 * block; i++) put(4 + (i % 72), bandTop + 2 + Math.floor(i / 72) * 2, text);
    return { width, height, rgba };
  };
  // 逐帧两个量：内容区的亮度和（场景边界和淡出看它），字幕条里深色像素的个数（字幕更替看它）
  const contentSum = [], bandDark = [];
  for (let k = 0; k < frames; k++) {
    const { rgba } = frameAt(k);
    let sum = 0, dark = 0;
    for (let i = 0; i < width * height; i++) {
      const luma = rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2];
      if (i < bandTop * width) sum += luma; else if (luma < 180) dark++;
    }
    contentSum.push(sum); bandDark.push(dark);
  }
  const appearSec = [0, ...bandDark].flatMap((dark, k, list) => (k > 0 && dark > 0 && dark !== list[k - 1] ? [(k - 1) / fps] : []));
  // 场景边界是旧场景淡到最低之后的那一帧；连着变了几帧，减掉切过去的那一下就是淡出的帧数
  const boundaries = changeRuns(contentSum);
  const fadeFrames = boundaries.map(([first, last]) => last - first);
  const edges = [0, ...boundaries.map(([, last]) => last / fps), spanSec];
  const perScene = edges.slice(1).map((end, s) => ({ start: edges[s], end, said: speech.filter(([from]) => from >= edges[s] && from < end) }));
  const gap = (value) => Math.round(value * 1000) / 1000;
  const samples = perScene.map(({ start, end }) => frameAt(Math.round((start + end) / 2 * fps)));
  return {
    'narration.timing': { appearSec, onsetsSec, spanSec, fadeFrames,
      leadSec: perScene.map(({ start, said }) => gap(said[0][0] - start)), tailSec: perScene.map(({ end, said }) => gap(end - said.at(-1)[1])) },
    'color.palette': readBaseShare(samples, paletteArgs),
  };
}

/* ---------------- 18-2：旁白触发词驱动的地图快速运镜 ---------------- */

// 题目自带旁白的替身：三句，后两句的起声就是两个命名触发点（第 240、546 帧）。每次快速运镜 45 帧、每帧横移 2 像素，别的时候机位不动
const MAP = { sentences: [[1, 6.4], [8, 12.9], [18.2, 19.6]], cueSentence: { cue_a: 1, cue_b: 2 }, size: [64, 36], moveFrames: 45, pxPerFrame: 2 };
const BASE_18_2 = { moveTrigger: 'cue-minus-lead', moveShiftFrames: 0, seed: null };

function measure182(q, p) {
  const fps = fpsOf(q), { frames } = q.deliverable, args = q.scoring[0].args;
  const onsets = speechSpans(narrationLevel(MAP.sentences, frames / fps, 182), { pauseDb: -45, minPauseSec: 0.25 }).map(([from]) => from);
  const eventFrames = args.events.map((cue) => Math.round(onsets[MAP.cueSentence[cue]] * fps));
  // 运镜的起始关键帧：触发点减提前量；关掉这张卡就起在触发词上；或者换成随机拍点
  const starts = { 'cue-minus-lead': () => eventFrames.map((frame, i) => frame - args.leadFrames[i]), 'on-cue': () => [...eventFrames],
    'random-beats': () => randomBeats(p.seed, args.moves, [0, frames - MAP.moveFrames], MAP.moveFrames + 2 * args.minRunFrames) }[p.moveTrigger]()
    .map((frame) => frame + p.moveShiftFrames);
  const frameAt = (k) => grayFrame(MAP.size, { dx: -MAP.pxPerFrame * starts.reduce((sum, start) => sum + Math.max(0, Math.min(MAP.moveFrames, k - start)), 0) });
  return { 'narration.timing': { eventFrames, markFrames: readMoveStarts(frameAt, [0, frames], MAP.size, args), range: [0, frames] } };
}

/* ---------------- 15-2：锁死机位 ---------------- */

// 相机：平移按像素记，换进世界矩阵的平移分量；推近乘在投影矩阵的两个焦距分量上。画面照同一组数变换，画面里的东西自己在动（noise）。
// preLockPanPx 是模型的假设：锁机位生效之前机位在别处，横向差 2 像素。锁死的机位本身整体错位几帧都看不出来，「错位 2 帧」拦得住靠的是这个假设
const LOCK = { size: [216, 122], noise: 10, pxToWorld: 0.01, drift: { scale: 1.02, dx: -5, dy: 2 }, preLockPanPx: 2, beats: 6,
  world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 4, 1], proj: [1.3, 0, 0, 0, 0, 2.3, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2, 0] };
const BASE_15_2 = { cameraPath: 'locked', lockShiftFrames: 0, seed: null };

function measure152(q, p) {
  const { frames } = q.deliverable, args = argsOf(q, (a) => a.pairs !== undefined), last = frames - 1;
  // 随机拍点：每个拍点机位跳一步（横或竖 1 到 2 像素），跳完留在那里
  const rand = p.cameraPath === 'random-beats' ? rng(p.seed + 1) : null;
  const jumps = rand ? randomBeats(p.seed, LOCK.beats, [1, frames], 2).map((frame) => {
    const px = (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 2));
    return rand() < 0.5 ? { frame, dx: px, dy: 0 } : { frame, dx: 0, dy: px };
  }) : [];
  const pose = (k) => {
    // 锁机位晚生效的那几帧，机位还在锁定前的位置上
    if (k < p.lockShiftFrames) return { scale: 1, dx: LOCK.preLockPanPx, dy: 0 };
    if (p.cameraPath === 'drift') return { scale: 1 + (LOCK.drift.scale - 1) * k / last, dx: LOCK.drift.dx * k / last, dy: LOCK.drift.dy * k / last };
    return jumps.filter(({ frame }) => frame <= k).reduce((at, { dx, dy }) => ({ scale: 1, dx: at.dx + dx, dy: at.dy + dy }), { scale: 1, dx: 0, dy: 0 });
  };
  const cameras = Array.from({ length: frames }, (_, k) => {
    const { scale, dx, dy } = pose(k), world = [...LOCK.world], proj = [...LOCK.proj];
    world[12] -= dx * LOCK.pxToWorld; world[13] += dy * LOCK.pxToWorld; proj[0] *= scale; proj[5] *= scale;
    return { world, proj };
  });
  const frameAt = (k) => grayFrame(LOCK.size, { ...pose(k), noise: LOCK.noise, seed: k + 1 });
  return { 'meta.camera-static': { cameras }, 'motion.zoom-pan': readLock(args.pairs.map((pair) => pair.map(frameAt)), LOCK.size, args) };
}

/* ---------------- 正对照与负对照 ---------------- */

// 几个选做法的参数只认这些值；写错的值报错，不落进哪个默认分支
const MODES = { hitTrigger: ['track', 'random-beats'], subtitleTrigger: ['narration', 'fixed-interval', 'random-beats'],
  moveTrigger: ['cue-minus-lead', 'on-cue', 'random-beats'], cameraPath: ['locked', 'drift', 'random-beats'] };
const MODELS = { '5-1': [BASE_5_1, measure51], '18-1': [BASE_18_1, measure181], '18-2': [BASE_18_2, measure182], '15-2': [BASE_15_2, measure152] };

/**
 * 一道题的信号模型照参数造信号、量读数。perturbation 只能改模型已有的参数：参数名不认识、选做法的参数值不认识都报错（不让写错的夹具悄悄退回正对照）。
 * 种子只有随机拍点用：用了随机拍点必须给整数种子，没用就不能给。
 */
export function measure(questionId, perturbation = {}, seed = null) {
  if (!Object.hasOwn(MODELS, questionId)) throw new RangeError(`没有这道题的信号模型：${questionId}`);
  const [base, run] = MODELS[questionId];
  const unknown = Object.keys(perturbation).filter((key) => !Object.hasOwn(base, key) || key === 'seed');
  if (unknown.length) throw new RangeError(`${questionId} 的信号模型没有这些参数：${unknown.join('、')}`);
  const params = { ...base, ...perturbation, seed };
  const badMode = Object.keys(MODES).filter((key) => Object.hasOwn(params, key) && !MODES[key].includes(params[key]));
  if (badMode.length) throw new RangeError(`${questionId} 的信号模型不认这些参数的值：${badMode.join('、')}`);
  if (Object.values(params).includes('random-beats') !== Number.isSafeInteger(seed)) throw new RangeError('随机拍点要整数种子，别的做法不带种子');
  return { params, readings: run(loadQuestion(questionId), params) };
}
const judged = (questionId, measured) => ({ questionId, ...measured, verdict: score(loadQuestion(questionId), measured.readings) });

/** 正对照：默认参数的信号，量出读数，过正式判分 */
export const buildPositiveBaseline = (questionId) => judged(questionId, measure(questionId));

/** 一份负对照（夹具对象或它的 id）：正对照的信号上只换夹具 perturbation 里的参数，量出读数，过正式判分 */
export function evaluateNegativeControl(controlOrId) {
  const control = typeof controlOrId === 'string' ? loadControl(controlOrId) : controlOrId;
  return { control, ...judged(control.questionId, measure(control.questionId, control.perturbation, control.seed)) };
}

export const evaluateAllB6Negatives = () => B6_QUESTION_IDS.flatMap((id) => B6_NEGATIVE_KINDS.map((kind) => evaluateNegativeControl(`${id}-${kind}`)));
