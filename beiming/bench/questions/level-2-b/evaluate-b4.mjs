// 二级第二批 4 道题（5-1、18-1、18-2、15-2）的判分核验辅助：read* 调 observe 的真实实现出读数，score 照题目文件 scoring[].args 里的线判。
// 只用来核「参考读数过自己的题、反例判不过」；正式的跑题器是另一个工作包。
// 读数按指标名归拢：{ 'music.align': {…}, … }。灰度帧是 Uint8Array（宽×高），彩色帧是 { width, height, rgba }（显示空间 sRGB，原点左上）。
import { align } from '../../../observe/align.mjs';
import { colorPalette, motionZoomPan } from '../../../observe/metrics/index.mjs';

const num = Number.isFinite;
const within = (value, [low, high]) => num(value) && value >= low && value <= high;
const median = (values) => {
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
 * randomRate 是随机对照：在 [from, to) 里任取一帧当事件，tol 帧内有记号的比例。
 */
export function readHits(eventFrames, markFrames, [from, to], tol) {
  const offsetsFrames = eventFrames.map((event) => nearest(event, markFrames));
  let covered = 0;
  for (let frame = from; frame < to; frame++) if (markFrames.some((mark) => Math.abs(mark - frame) <= tol)) covered++;
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

/** 18-1：各场景边界淡出帧数的中位数 */
export const readFades = (fadeFrames) => ({ fadeFramesMedian: median(fadeFrames) });

/** 18-1：每帧里和 color 落在同一个色格（每通道分 binLevels 档）的像素占比，从 colorPalette 的前 k 个主色里加 */
export function readBaseShare(frames, { color, binLevels, k }) {
  const bin = (channel) => Math.floor(channel * binLevels / 256);
  const target = [1, 3, 5].map((i) => bin(parseInt(color.slice(i, i + 2), 16)));
  return { shares: frames.map((frame) => colorPalette(frame, k).details.palette
    .filter(({ rgb }) => rgb.every((channel, i) => bin(channel) === target[i])).reduce((sum, { share }) => sum + share, 0)) };
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
  return { pairs: pairs.map(([a, b]) => {
    const { value, details } = motionZoomPan(a, b, width, height, { maxPan });
    return { ...value, error: details.meanAbsError,
      stillError: motionZoomPan(a, b, width, height, { maxPan: 0, scales: [1] }).details.meanAbsError };
  }) };
}

/** 15-2：逐帧的相机矩阵（每帧 { world, proj }，各 16 个数）和第 0 帧逐分量比，changedAt 是第一处不同的帧号，全相同是 null */
export function readCameraStatic(cameras) {
  const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  const changed = cameras.findIndex(({ world, proj }) => !same(world, cameras[0].world) || !same(proj, cameras[0].proj));
  return { frames: cameras.length, changedAt: changed === -1 ? null : changed };
}

/* ---------------- 判分 ---------------- */

// 事件全部命中，且命中率比随机基线高出 minLiftOverRandom
const hits = (r, a) => r.offsetsFrames?.length === a.events.length && r.hitRate === 1 && num(r.randomRate) && r.hitRate - r.randomRate >= a.minLiftOverRandom;
// 每条线只在 args 给了的时候判，一条都没给不算过；读数缺项或不是数一律不过
const lines = (checks) => checks.some(([given]) => given) && checks.every(([given, ok]) => !given || ok());
const JUDGES = {
  'music.align': (r, a) => num(r.corr) && r.corr >= a.minCorr && within(r.stretch, a.stretch),
  'beat.onset-hit': hits,
  'narration.timing': (r, a) => lines([
    [a.maxSubtitleLagSec !== undefined, () => num(r.subtitleLagSec) && r.subtitleLagSec <= a.maxSubtitleLagSec && num(r.randomRate) && r.hitRate - r.randomRate >= a.minLiftOverRandom],
    [a.fadeFrames !== undefined, () => within(r.fadeFramesMedian, a.fadeFrames)],
    [a.events !== undefined, () => hits(r, a)],
  ]),
  'color.palette': (r, a) => r.shares?.length > 0 && r.shares.every((share) => within(share, a.share)),
  'meta.camera-static': (r, a) => r.frames === a.frames && r.changedAt === null,
  'motion.zoom-pan': (r, a) => r.pairs?.length >= a.pairs.length
    && r.pairs.every((pair) => pair.scale === a.scale && num(pair.dx) && num(pair.dy) && Math.hypot(pair.dx, pair.dy) <= a.maxPanPx),
};

/** 照题目的 scoring 逐条判：回每条过没过、过了的权重之和、是不是满分。没给读数或不认识的指标算不过 */
export function score(question, readings) {
  const items = question.scoring.map(({ metric, args = {}, weight }) =>
    ({ metric, weight, pass: Boolean(readings[metric] && JUDGES[metric]?.(readings[metric], args)) }));
  return { items, score: items.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0), pass: items.every((item) => item.pass) };
}
