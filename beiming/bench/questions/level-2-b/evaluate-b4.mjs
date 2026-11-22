// 二级第二批 4 道题（5-1、18-1、18-2、15-2）的判分核验辅助：read* 调 observe 的真实实现出读数，score 照题目文件 scoring[].args 里的线判。
// 只用来核「参考读数过自己的题、反例判不过」；正式的跑题器是另一个工作包。
// 读数按指标名归拢：{ 'music.align': {…}, … }，交的是原始量（时刻、帧号、逐帧矩阵、每帧占比）；偏差、中位数、命中率、随机基线由判分线自己重算，读数里自带的汇总不认。
// 读数不可信：数组必须密实（没有空洞、没有附加属性）、元素都是有限数；缺项、null、NaN、字符串一律算这条线不过，不抛错。
// 帧号一律是题目时间线上的：第 0 帧是成片第一帧，有效窗口是 [0, deliverable.frames)，由题目定，读数改不了；参考片的绝对帧号要先换过来。
// 灰度帧是 Uint8Array（宽×高），彩色帧是 { width, height, rgba }（显示空间 sRGB，原点左上）；坏帧由 observe 报 RangeError。
import { align } from '../../../observe/align.mjs';
import { colorPalette, motionZoomPan } from '../../../observe/metrics/index.mjs';

const num = Number.isFinite; // 不做类型转换：null、字符串、BigInt 都不是数
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 密实数组：键的个数对得上（没有附加属性），每个下标都真的有值（空洞和附加属性正好抵掉个数的也拦），every 跳过空洞所以逐下标查
function dense(list, minLen = 1, ok = () => true) {
  if (!Array.isArray(list) || !(list.length >= minLen) || Reflect.ownKeys(list).length !== list.length + 1) return false;
  for (let i = 0; i < list.length; i++) if (!Object.hasOwn(list, i) || !ok(list[i])) return false;
  return true;
}
/** 至少 minLen 个元素、没有空洞和附加属性、元素都是有限数的普通数组 */
export const denseFinite = (list, minLen = 1) => dense(list, minLen, num);
const rising = (list) => denseFinite(list) && list.every((value, i) => i === 0 || value > list[i - 1]);
const within = (value, [low, high]) => num(value) && value >= low && value <= high;
export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length === 0 ? null : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const nearest = (at, marks) => (marks.length ? Math.min(...marks.map((mark) => Math.abs(mark - at))) : null);

/* ---------------- 读数 ---------------- */

/** 5-1：配乐对成片的偏移与拉伸（20 毫秒能量包络互相关）。搜索范围 searchStretch 比题面的范围宽，超限的拉伸才量得出来 */
export function readMusicAlign({ filmEnvelope, trackEnvelope, fps }, { searchStretch, stepSec }) {
  const out = align({ stretch: { filmEnvelope, trackEnvelope, fps, stepSec, stretchRange: searchStretch } });
  if (!out.ok) throw new Error(`对位没算出来：${out.error.message}`);
  const { corr, stretch, offsetSec } = out.stretch;
  return { corr, stretch, offsetSec };
}

/**
 * 5-1、18-2：每个事件（帧号）离最近的一个记号（重击峰、运镜起点）多少帧，tol 帧内算命中。
 * randomRate 是随机对照：在 [from, to) 里任取一帧当事件，tol 帧内有记号的比例（各记号前后 tol 帧的并集除以总帧数）。
 */
export function readHits(eventFrames, markFrames, [from, to], tol) {
  const offsetsFrames = eventFrames.map((event) => nearest(event, markFrames));
  let covered = 0, next = from;
  for (const mark of [...markFrames].sort((a, b) => a - b)) {
    const low = Math.max(next, Math.ceil(mark - tol)), high = Math.min(to, Math.floor(mark + tol) + 1);
    if (high > low) { covered += high - low; next = high; }
  }
  return { offsetsFrames, hitRate: offsetsFrames.filter((d) => d !== null && d <= tol).length / eventFrames.length, randomRate: covered / (to - from) };
}

/**
 * 18-1：每块字幕出现的时刻减离它最近的旁白起声（秒），回绝对值的中位数；tol 秒内算对上。
 * randomRate 是随机对照：在 [0, spanSec) 里任取一个时刻，tol 秒内有起声的比例（各起声前后 tol 秒的并集除以总长）。
 */
export function readSubtitleLag(appearSec, onsetsSec, spanSec, tol) {
  const lags = appearSec.map((at) => nearest(at, onsetsSec));
  let covered = 0, end = 0;
  for (const onset of [...onsetsSec].sort((a, b) => a - b)) {
    const low = Math.max(end, onset - tol, 0), high = Math.min(onset + tol, spanSec);
    if (high > low) { covered += high - low; end = high; }
  }
  return { subtitleLagSec: lags.includes(null) ? null : median(lags),
    hitRate: lags.filter((lag) => lag !== null && lag <= tol).length / appearSec.length, randomRate: covered / spanSec };
}

/**
 * 18-1：每帧里和 color 落在同一个色格（每通道分 binLevels 档）的像素占比。
 * colorPalette 的主色数给到全帧像素数，帧里出现的每个色值都在表里，再照色格归并；先截前几十个主色会漏掉同一色格里的细分色值。
 */
export function readBaseShare(frames, { color, binLevels }) {
  const bin = (channel) => Math.floor(channel * binLevels / 256);
  const target = [1, 3, 5].map((i) => bin(parseInt(color.slice(i, i + 2), 16)));
  return { shares: frames.map((frame) => {
    const pixels = frame?.width * frame?.height;
    // 占比乘回像素数是整数个像素，按个数加，不攒浮点误差
    return colorPalette(frame ?? {}, pixels).details.palette.filter(({ rgb }) => rgb.every((channel, i) => bin(channel) === target[i]))
      .reduce((count, { share }) => count + Math.round(share * pixels), 0) / pixels;
  }) };
}

/**
 * 18-2：[from, to) 里逐帧估相邻两帧的缩放与平移，连着 minRunFrames 对以上不是恒等的算一次运镜，回每次运镜的起始帧号
 * （运动从这一帧开始，下一帧才看得出位移）。frameAt(k) 回第 k 帧的灰度。
 */
export function readMoveStarts(frameAt, [from, to], [width, height], { maxPan, scales, minRunFrames }) {
  const starts = [];
  let previous = frameAt(from), run = 0;
  for (let k = from + 1; k < to; k++) {
    const current = frameAt(k);
    const { scale, dx, dy } = motionZoomPan(previous, current, width, height, { maxPan, scales }).value;
    run = scale !== 1 || dx !== 0 || dy !== 0 ? run + 1 : 0;
    if (run === minRunFrames) starts.push(k - minRunFrames);
    previous = current;
  }
  return starts;
}

/** 15-2：每对灰度帧估出的缩放与平移；error 是估出的变换下的平均灰度差，stillError 是不动时的 */
export function readLock(pairs, [width, height], { maxPan }) {
  return { pairs: pairs.map((pair) => {
    const [a, b] = pair ?? [];
    const { value, details } = motionZoomPan(a, b, width, height, { maxPan });
    return { ...value, error: details.meanAbsError,
      stillError: motionZoomPan(a, b, width, height, { maxPan: 0, scales: [1] }).details.meanAbsError };
  }) };
}

/**
 * 15-2：逐帧的相机矩阵（每帧 { world, proj }，各是 16 个有限数的普通数组）和第 0 帧逐分量比。
 * changedAt 是第一处和第 0 帧不同、或者矩阵不完整（缺帧、不是 16 个有限数）的帧号，全相同是 null。
 * frames 是帧数；cameras 不是数组、或者数组的键数对不上（有空洞，或者挂了 fps 之类的附加属性）时回 null。
 */
export function readCameraStatic(cameras) {
  if (!Array.isArray(cameras)) return { frames: null, changedAt: null };
  const matrix = (m) => denseFinite(m, 16) && m.length === 16;
  const same = (a, b) => a.every((value, i) => value === b[i]);
  // findIndex 不跳过空洞；第 0 帧自己不完整时在第 0 帧就停
  const changed = cameras.findIndex((cam) => !(plain(cam) && matrix(cam.world) && matrix(cam.proj)
    && same(cam.world, cameras[0].world) && same(cam.proj, cameras[0].proj)));
  return { frames: Reflect.ownKeys(cameras).length === cameras.length + 1 ? cameras.length : null, changedAt: changed === -1 ? null : changed };
}

/* ---------------- 判分 ---------------- */

// 5-1、18-2：事件（硬切、触发词的帧号）减去题面规定的提前量 leadFrames 是应起帧，每个应起帧 tolFrames 帧内都有记号，且比随机基线高出 minLiftOverRandom。
// 题目给了 eventFrames 的（5-1 的硬切），量到的事件帧号必须就是这几个；给了 moves 的，记号必须正好那么多个，按先后和事件一一对应，没给的取离得最近的记号。
// 窗口是题目的 [0, frames)：事件、应起帧、记号三样都得落在里面，随机基线也按它算。读数可以不报 range，报了就必须正好是这个窗口（报宽了会摊薄基线）。
function hits(r, a, frames) {
  if (!(Number.isInteger(frames) && frames > 0) || !rising(r.eventFrames) || r.eventFrames.length !== a.events.length || !rising(r.markFrames)
    || (a.eventFrames !== undefined && !r.eventFrames.every((frame, i) => frame === a.eventFrames[i]))
    || (r.range !== undefined && !(denseFinite(r.range, 2) && r.range.length === 2 && r.range[0] === 0 && r.range[1] === frames))) return false;
  const expected = r.eventFrames.map((frame, i) => frame - (a.leadFrames?.[i] ?? 0));
  if (![r.eventFrames, expected, r.markFrames].every((list) => list.every((frame) => frame >= 0 && frame < frames))) return false;
  if (a.moves !== undefined && r.markFrames.length !== a.moves) return false;
  const { offsetsFrames, randomRate } = readHits(expected, r.markFrames, [0, frames], a.tolFrames);
  const offsets = a.moves === undefined ? offsetsFrames : expected.map((frame, i) => Math.abs(r.markFrames[i] - frame));
  return offsets.every((d) => d <= a.tolFrames) && 1 - randomRate >= a.minLiftOverRandom;
}
// 18-1 字幕：字幕与起声的时刻都落在成片时长里，才重算中位数、命中率和随机基线
function subtitles(r, a) {
  if (!denseFinite(r.appearSec) || !denseFinite(r.onsetsSec) || !(num(r.spanSec) && r.spanSec > 0)
    || ![...r.appearSec, ...r.onsetsSec].every((at) => at >= 0 && at <= r.spanSec)) return false;
  const { subtitleLagSec, hitRate, randomRate } = readSubtitleLag(r.appearSec, r.onsetsSec, r.spanSec, a.maxSubtitleLagSec);
  return subtitleLagSec <= a.maxSubtitleLagSec && hitRate - randomRate >= a.minLiftOverRandom;
}
// 18-1 淡出：minScenes 个场景之间至少 minScenes − 1 处边界；至少这么多处各自在范围里，中位数也在（参考是平台重压版，个别边界量不准）
const fades = (r, a) => denseFinite(r.fadeFrames, a.minScenes - 1) && r.fadeFrames.every((frames) => frames >= 0)
  && r.fadeFrames.filter((frames) => within(frames, a.fadeFrames)).length >= a.minScenes - 1 && within(median(r.fadeFrames), a.fadeFrames);
// 18-1 首尾留白：每个场景一个开头留白、一个结尾留白，至少 minScenes 个场景，各按中位数判
const pauses = (r, a) => [[r.leadSec, a.minLeadSec], [r.tailSec, a.minTailSec]].every(([gaps, min]) =>
  denseFinite(gaps, a.minScenes) && gaps.length === r.leadSec.length && gaps.every((gap) => gap >= 0) && median(gaps) >= min);
// 每条线只在 args 给了的时候判，一条都没给不算过
const lines = (checks) => checks.some(([given]) => given) && checks.every(([given, ok]) => !given || ok());
const JUDGES = {
  'music.align': (r, a) => within(r.corr, [a.minCorr, 1]) && within(r.stretch, a.stretch),
  'beat.onset-hit': hits,
  'narration.timing': (r, a, frames) => lines([
    [a.maxSubtitleLagSec !== undefined, () => subtitles(r, a)],
    [a.fadeFrames !== undefined, () => fades(r, a)],
    [a.minLeadSec !== undefined, () => pauses(r, a)],
    [a.events !== undefined, () => hits(r, a, frames)],
  ]),
  'color.palette': (r, a) => denseFinite(r.shares, a.minScenes) && r.shares.every((share) => within(share, a.share)),
  'meta.camera-static': (r, a) => {
    const { frames, changedAt } = readCameraStatic(r.cameras);
    return frames === a.frames && changedAt === null;
  },
  // 估出不动（缩放 scale、平移不超过 maxPanPx）时，估出的变换下的误差和不动时的误差是同一个数，差不得超过 maxErrorGap
  'motion.zoom-pan': (r, a) => dense(r.pairs, a.pairs.length, (pair) => plain(pair) && pair.scale === a.scale && num(pair.dx) && num(pair.dy)
    && Math.hypot(pair.dx, pair.dy) <= a.maxPanPx && num(pair.error) && pair.error >= 0 && num(pair.stillError) && Math.abs(pair.error - pair.stillError) <= a.maxErrorGap),
};

/** 照题目的 scoring 逐条判：回每条过没过、过了的权重之和、是不是满分。没给读数、读数不是对象、不认识的指标都算不过。帧窗口取题目的 deliverable.frames */
export function score(question, readings) {
  const given = plain(readings) ? readings : {};
  const passes = (metric, args) => {
    // 读数不可信：判分线里抛了错（带取值器的对象、大到摊不开的数组）也只算这条不过
    try {
      return Object.hasOwn(JUDGES, metric) && Object.hasOwn(given, metric) && plain(given[metric]) && JUDGES[metric](given[metric], args, question.deliverable?.frames) === true;
    } catch { return false; }
  };
  const items = question.scoring.map(({ metric, args = {}, weight }) => ({ metric, weight, pass: passes(metric, args) }));
  return { items, score: items.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0), pass: items.every((item) => item.pass) };
}
