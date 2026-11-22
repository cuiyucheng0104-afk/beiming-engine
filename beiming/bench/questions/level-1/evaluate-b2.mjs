// 一级 4 道题（29-1、28-1、23-1、01-1）的判分核验辅助：read* 调 observe/metrics 的真实指标出读数，score 照题目文件（或题号）scoring[].args 里的线判，并核基础门。
// 只用来核「参考读数过自己的题、反例判不过」；正式的跑题器是另一个工作包。
// 读数按指标名归拢：{ 'layout.edges': {…}, …, base: {…} }。帧是 { width, height, rgba }（显示空间 sRGB，原点左上）；包围盒是 [x0, y0, x1, y1] 像素。
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { audioLoudness, blackFreezeDup, deliverSpec, layoutEdges, loopClosurePsnr, pixelBbox } from '../../../observe/metrics/index.mjs';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** 一道题里同一个指标的几条判分的 args 并成一份，给 read* 用 */
export const argsOf = (question, metric) => Object.assign({}, ...question.scoring.filter((item) => item.metric === metric).map((item) => item.args));

/* ---------------- 读数 ---------------- */

/**
 * 29-1 的一帧。逐行数不是底色的像素，过 rowFill 的行算内容行；内容行连成的段和题面的段 bands（[上沿, 下沿)，行号）逐沿相减，
 * 取绝对值就是 edgeErrorsPx（每段上、下两个数，像素）；段数对不上是 null。
 * 每段再在自己的行里逐列数，过 rowFill 的列算内容列：最左的内容列离第 0 列、最右的离最后一列各差几列就是 sideErrorsPx（每段左、右两个数）；
 * 通栏的段两个数都是 0。lineColorError 是分隔线中间几行 coreRows 对 color 的最大通道差（级）。
 * size 是题目 deliverable 的 [宽, 高]：画面尺寸和它不一样时，题面的行号、通栏的右沿都对不上，量不了，四样都是 null。
 */
export function readLayout(frame, { background, backgroundTol, rowFill, bands, coreRows, color }, size) {
  const { width, height } = frame;
  if (width !== size[0] || height !== size[1]) return { bands: null, edgeErrorsPx: null, sideErrorsPx: null, lineColorError: null };
  /** 每个矩形里不是底色的像素数 */
  const filled = (rects) => layoutEdges(frame, { tol: backgroundTol, regions: rects.map((rect) => ({ ...rect, color: rgb(background) })) })
    .details.regions.map((region) => region.mismatch);
  const seen = [];
  filled(Array.from({ length: height }, (_, y) => ({ x: 0, y, width, height: 1 }))).forEach((count, y) => {
    if (count < rowFill * width) return;
    if (seen.at(-1)?.[1] === y) seen.at(-1)[1] = y + 1;
    else seen.push([y, y + 1]);
  });
  const sides = bands.flatMap(([top, bottom]) => {
    const cols = filled(Array.from({ length: width }, (_, x) => ({ x, y: top, width: 1, height: bottom - top }))).map((count) => count >= rowFill * (bottom - top));
    return cols.includes(true) ? [cols.indexOf(true), width - 1 - cols.lastIndexOf(true)] : [null, null];
  });
  const core = { x: 0, y: coreRows[0], width, height: coreRows[1] - coreRows[0], color: rgb(color) };
  return {
    bands: seen,
    edgeErrorsPx: seen.length === bands.length ? seen.flatMap(([top, bottom], i) => [Math.abs(top - bands[i][0]), Math.abs(bottom - bands[i][1])]) : null,
    sideErrorsPx: sides,
    lineColorError: layoutEdges(frame, { regions: [core] }).details.regions[0].maxError,
  };
}

/**
 * 28-1：每帧包围盒占画面的宽、高和四边留白，回各项在全部帧里最差的值（比例）。frames 是给了几帧的包围盒。
 * 有一帧的包围盒不成形（不是四个有限数、空盒、左右或上下颠倒、出画），整份读数作废：比例都是 null
 */
export function readFraming(boxes, [width, height]) {
  const list = Array.isArray(boxes) ? Array.from(boxes) : [];
  const sound = list.length > 0 && list.every((box) => Array.isArray(box) && box.length === 4 && box.every(fin)
    && box[0] >= 0 && box[0] < box[2] && box[2] <= width && box[1] >= 0 && box[1] < box[3] && box[3] <= height);
  const each = sound ? list.map(([x0, y0, x1, y1]) => ({ w: (x1 - x0) / width, h: (y1 - y0) / height,
    lr: Math.min(x0, width - x1) / width, tb: Math.min(y0, height - y1) / height })) : [];
  const worst = (pick, key) => (each.length ? pick(...each.map((e) => e[key])) : null);
  return { frames: list.length, maxW: worst(Math.max, 'w'), minH: worst(Math.min, 'h'), maxH: worst(Math.max, 'h'),
    minMarginLr: worst(Math.min, 'lr'), minMarginTb: worst(Math.min, 'tb') };
}

/** 首尾闭合：第 a 帧对第 b 帧、对相邻帧的 PSNR（dB）。两帧逐像素相同时是正无穷 */
export function readClosure(first, last, second) {
  const { value, details } = loopClosurePsnr(first, last, second);
  return { closurePsnr: value, adjacentPsnr: details.adjacentPsnr };
}

/** 23-1：[from, to) 里和第 0 帧 PSNR 最高的帧号。frameAt(k) 回第 k 帧 */
export function readNearest(frameAt, [from, to]) {
  const first = frameAt(0);
  let nearest = null, best = -Infinity;
  for (let k = from; k < to; k++) {
    const psnr = loopClosurePsnr(first, frameAt(k), first).value;
    if (psnr > best) { best = psnr; nearest = k; }
  }
  return { nearest };
}

/** 28-1：像素估出的包围盒和元数据的包围盒逐边相减，回抽到的帧里最大的差（像素）；一帧都没抽是 null。samples 是 [{ frame, box }] */
export function readPixelBoxes(samples, background, tol) {
  const diffs = samples.flatMap(({ frame, box }) => {
    const [x, y, w, h] = pixelBbox(frame, rgb(background), tol).value;
    return [x, y, x + w, y + h].map((edge, i) => Math.abs(edge - box[i]));
  });
  return { maxDiffPx: diffs.length ? Math.max(...diffs) : null };
}

/** 第一条音轨有没有、声道数和声道布局；没有音轨是 hasAudio: false、0 个声道。缺 ffprobe 时回 null */
async function audioTrack(file) {
  try {
    const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,channel_layout', '-of', 'json', resolve(file)]);
    const [stream] = JSON.parse(stdout).streams ?? [];
    const audioChannels = stream?.channels ?? 0;
    return { hasAudio: audioChannels > 0, audioChannels, audioLayout: stream?.channel_layout ?? null };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

/**
 * 01-1：成片文件读回规格与色彩标签（外加声道数）、响度与真峰值、黑帧冻结重复帧。
 * hasAudio 是有没有音轨，顶层和 deliver.spec 里各写一份：有是 true，没有是 false。没有音轨时不去量响度：声道数是 0，响度和真峰值是 null。
 * 缺 ffmpeg / ffprobe 时对应的读数是 null（判不过），hasAudio 也是 null：没探过，不说成没有
 */
export async function readMaster(file, frameArgs) {
  const track = await audioTrack(file);
  const [spec, loudness, frames] = await Promise.all([deliverSpec(file), track?.hasAudio ? audioLoudness(file) : { value: null }, blackFreezeDup(file, frameArgs)]);
  return {
    hasAudio: track ? track.hasAudio : null,
    'deliver.spec': spec.value && track ? { ...spec.value, ...track } : null,
    'audio.loudness': { lufs: loudness.value, truePeakDbtp: loudness.details?.truePeakDbtp ?? null },
    'frame.black-freeze-dup': frames.value,
  };
}

/* ---------------- 判分 ---------------- */

// 读数和线两边都得是有限数才比：null、undefined、NaN、字符串一律不过，不让 null <= 0.7 这种比较把缺测当成 0 放过去
const le = (x, max) => fin(x) && fin(max) && x <= max;
const ge = (x, min) => fin(x) && fin(min) && x >= min;
const ratio = (x) => ge(x, 0) && le(x, 1);
/** PSNR 读数：不小于 0 的有限数（8 位画面两帧差到头是 0 dB），或者两帧逐像素相同时的正无穷（是量出来的数，照常比）。别的都算缺测 */
const psnr = (x) => ge(x, 0) || x === Infinity;
/** PSNR 换回误差幅度（均方根误差除以 255）；正无穷换成 0 */
const amplitude = (db) => 10 ** (-db / 20);
// 换算的舍入余量。差正好是 1.1 倍的两帧，经 PSNR 的对数来回一趟算出 1.1000000000000003，不留余量会把压线的判成越线
const RATIO_EPS = 1e-12, DB_EPS = 1e-9;
/** 误差读数的数组：真数组，正好 n 个槽，没有空洞和多余的属性，每个槽是不小于 0 的有限数 */
const errorList = (list, n) => Array.isArray(list) && list.length === n && Reflect.ownKeys(list).length === n + 1
  && Array.from({ length: n }, (_, i) => i).every((i) => Object.hasOwn(list, i) && ge(list[i], 0));
/** 读数里的数组成不成形，按指标列。没量出来（null、undefined）不算不成形，由判分那一项自己判不过 */
const SHAPES = {
  'layout.edges': (r, a) => [r.edgeErrorsPx, r.sideErrorsPx].every((list) => list == null || errorList(list, 2 * a.bands.length)),
};
/** 一项判分里的几条线：args 里给了哪条判哪条；一条都没给不算过 */
const lines = (...pairs) => {
  const given = pairs.filter(([arg]) => arg !== undefined);
  return given.length > 0 && given.every(([, holds]) => holds());
};

const CHANNELS = { none: 0, mono: 1, stereo: 2 };
/** 成片读回的规格（deliverSpec 的读数加声道数 audioChannels）和题目的 deliverable 逐项相等 */
function sameSpec(r, { size, fps, frames, audio }) {
  const [num, den] = fps.split('/').map(Number);
  return r.width === size[0] && r.height === size[1] && r.fps === num / den && r.frames === frames
    && Object.hasOwn(CHANNELS, audio) && r.audioChannels === CHANNELS[audio];
}

const JUDGES = {
  // 上下沿和左右沿共用一条线 maxEdgeErrorPx：每段上、下、左、右四条沿都不能超
  'layout.edges': (r, a) => lines(
    [a.maxEdgeErrorPx, () => [r.edgeErrorsPx, r.sideErrorsPx].every((list) => errorList(list, 2 * a.bands.length) && list.every((e) => le(e, a.maxEdgeErrorPx)))],
    [a.maxLevels, () => ge(r.lineColorError, 0) && le(r.lineColorError, a.maxLevels)]),
  // 题面要 100% 的帧：给了包围盒的帧数要正好是全片帧数
  'meta.bbox-limits': (r, a, { deliverable }) => r.frames === deliverable.frames && [r.maxW, r.maxH, r.minMarginLr, r.minMarginTb].every(ratio)
    && le(r.maxW, a.maxW) && le(r.maxH, a.maxH) && ge(r.minMarginLr, a.minMarginLr) && ge(r.minMarginTb, a.minMarginTb),
  // maxRatio 比的是均方根误差之比，由两个 PSNR 换算
  'loop.closure-psnr': (r, a) => lines(
    [a.expect, () => Number.isInteger(a.expect) && r.nearest === a.expect],
    [a.marginDb, () => psnr(r.closurePsnr) && psnr(r.adjacentPsnr) && fin(a.marginDb) && r.closurePsnr >= r.adjacentPsnr - a.marginDb - DB_EPS],
    [a.maxRatio, () => psnr(r.closurePsnr) && psnr(r.adjacentPsnr) && fin(a.maxRatio) && amplitude(r.closurePsnr) <= a.maxRatio * amplitude(r.adjacentPsnr) * (1 + RATIO_EPS)]),
  'pixel.bbox': (r, a) => ge(r.maxDiffPx, 0) && le(r.maxDiffPx, a.tolPx),
  // 规格连同声道数一起对：题面要立体声，单声道和没有音轨都不算
  'deliver.spec': (r, a, { deliverable }) => sameSpec(r, deliverable) && typeof a.color === 'string'
    && ['color_space', 'color_transfer', 'color_primaries'].every((tag) => r[tag] === a.color),
  'audio.loudness': (r, a) => ge(r.lufs, a.lufs?.[0]) && le(r.lufs, a.lufs?.[1]) && le(r.truePeakDbtp, a.maxTruePeakDbtp),
  'frame.black-freeze-dup': (r) => r.blackFrames === 0 && r.freezeSegments === 0 && r.duplicateFrames === 0,
};

/** 对象自己的属性；不是对象、没有这个属性回 undefined */
const own = (object, key) => (isObj(object) && Object.hasOwn(object, key) ? object[key] : undefined);
/** 读数不成形、判的时候出错，都按不过算，不往外抛 */
const holds = (check) => {
  try { return check() === true; } catch { return false; }
};

/** 题号对题目文件名。冻结的题号写法不带前导零，1-1 和文件名 01-1 是同一道题 */
const FILES = { '29-1': '29-1', '28-1': '28-1', '23-1': '23-1', '1-1': '01-1', '01-1': '01-1' };
/** 给的是题号就读同目录的题目文件，别的原样回；不认识的题号回 null */
const questionOf = (given) => (typeof given !== 'string' ? given
  : Object.hasOwn(FILES, given) ? JSON.parse(readFileSync(new URL(`./${FILES[given]}.json`, import.meta.url), 'utf8')) : null);

/**
 * 照题目判一份读数，回 { id, score, pass, basePass, scoringPass, malformed, base, items }。
 * 第一个参数给题目对象，或者这四道题的题号（'29-1'、'28-1'、'23-1'、'1-1'，'01-1' 也认）。各字段的意思（契约语义）：
 * - items、score、scoringPass 只管 scoring[]：items 是每一项过没过，score 是过了的项的权重和（满分 1），scoringPass 是每一项都过。
 *   没有读数、没有判法、读数缺项或不是数的项不过。「参考片的读数在自己的题上得满分」说的是这一层。
 * - base、basePass 是基础门，逐条列在 base 里：第一条 deliverable 是成片读回的规格 readings.base.spec（宽、高、帧率、帧数、声道数）
 *   和题目的 deliverable 逐项相等；后面每条是题目的一条 basePredicates，要 readings.base.predicates[谓词原文] 是 'pass'。
 *   谓词的判定由调用方拿每帧元数据和成片量测交 verify 的 evaluateAssertion 得出，这里不重判；没给、'fail'、'skipped' 都不算过：没判过不当成过。
 *   所以只有成片、没有每帧元数据的参考片，basePass 是 false。
 * - pass = basePass && scoringPass，是整题合格。负对照、容差校准要看整题合不合格用 pass，只看判分线用 scoringPass 和 score。
 * - malformed：读数里有给了却不成形的数组（空洞、伪数组、字符串、带多余属性、槽数不对、槽里是负数或不是数）。这份读数整份作废：
 *   每一项都不过，score 是 0，不给别的项部分分。数组成形只是数值超差、或者没量出来（null），不算，照常逐项判。
 * - 题号不认识、第一个参数不是题目：id 是 null，score 是 0，都不合格，base 和 items 是空的，不往外抛。题目对象本身合不合契约归 validateQuestion 管，这里不重验。
 */
export function score(questionOrId, readings) {
  try {
    return judge(questionOf(questionOrId), readings);
  } catch {
    return { id: null, score: 0, pass: false, basePass: false, scoringPass: false, malformed: false, base: [], items: [] };
  }
}

function judge(question, readings) {
  const malformed = question.scoring.some(({ metric, args = {} }) => holds(() => isObj(own(readings, metric)) && Object.hasOwn(SHAPES, metric) && !SHAPES[metric](own(readings, metric), args)));
  const items = question.scoring.map(({ metric, args = {}, weight }) => ({ metric, weight,
    pass: !malformed && holds(() => isObj(own(readings, metric)) && Object.hasOwn(JUDGES, metric) && JUDGES[metric](own(readings, metric), args, question)) }));
  const gate = (key) => own(own(readings, 'base'), key);
  const base = [{ check: 'deliverable', pass: holds(() => isObj(gate('spec')) && sameSpec(gate('spec'), question.deliverable)) },
    ...question.basePredicates.map((text) => ({ check: text, pass: holds(() => own(gate('predicates'), text) === 'pass') }))];
  const basePass = base.every((check) => check.pass), scoringPass = items.every((item) => item.pass);
  return { id: question.id, score: items.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0), pass: basePass && scoringPass, basePass, scoringPass, malformed, base, items };
}
