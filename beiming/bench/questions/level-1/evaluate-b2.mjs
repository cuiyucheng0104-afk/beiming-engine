// 一级 4 道题（29-1、28-1、23-1、01-1）的判分核验辅助：read* 调 observe/metrics 的真实指标出读数，score 照题目文件 scoring[].args 里的线判。
// 只用来核「参考读数过自己的题、反例判不过」；正式的跑题器是另一个工作包。
// 读数按指标名归拢：{ 'layout.edges': {…}, … }。帧是 { width, height, rgba }（显示空间 sRGB，原点左上）；包围盒是 [x0, y0, x1, y1] 像素。
import { audioLoudness, blackFreezeDup, deliverSpec, layoutEdges, loopClosurePsnr, pixelBbox } from '../../../observe/metrics/index.mjs';

const num = Number.isFinite;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** 一道题里同一个指标的几条判分的 args 并成一份，给 read* 用 */
export const argsOf = (question, metric) => Object.assign({}, ...question.scoring.filter((item) => item.metric === metric).map((item) => item.args));

/* ---------------- 读数 ---------------- */

/**
 * 29-1 的一帧：逐行数不是底色的像素，过 rowFill 的行算内容行；内容行连成的段和题面的段 bands（[上沿, 下沿)，行号）逐沿相减就是边界误差。
 * 段数对不上时 edgeErrorsPx 是 null。lineColorError 是分隔线中间几行 coreRows 对 color 的最大通道差（级）。
 */
export function readLayout(frame, { background, backgroundTol, rowFill, bands, coreRows, color }) {
  const { width, height } = frame;
  const rows = layoutEdges(frame, { tol: backgroundTol,
    regions: Array.from({ length: height }, (_, y) => ({ x: 0, y, width, height: 1, color: rgb(background) })) }).details.regions;
  const seen = [];
  rows.forEach(({ mismatch }, y) => {
    if (mismatch < rowFill * width) return;
    if (seen.at(-1)?.[1] === y) seen.at(-1)[1] = y + 1;
    else seen.push([y, y + 1]);
  });
  const core = { x: 0, y: coreRows[0], width, height: coreRows[1] - coreRows[0], color: rgb(color) };
  return {
    bands: seen,
    edgeErrorsPx: seen.length === bands.length ? seen.flatMap(([top, bottom], i) => [top - bands[i][0], bottom - bands[i][1]]) : null,
    lineColorError: layoutEdges(frame, { regions: [core] }).details.regions[0].maxError,
  };
}

/** 28-1：每帧包围盒占画面的宽、高和四边留白，回各项在全部帧里最差的值（比例） */
export function readFraming(boxes, [width, height]) {
  const each = boxes.map(([x0, y0, x1, y1]) => ({ w: (x1 - x0) / width, h: (y1 - y0) / height,
    lr: Math.min(x0, width - x1) / width, tb: Math.min(y0, height - y1) / height }));
  const worst = (pick, key) => (each.length ? pick(...each.map((e) => e[key])) : null);
  return { frames: each.length, maxW: worst(Math.max, 'w'), minH: worst(Math.min, 'h'), maxH: worst(Math.max, 'h'),
    minMarginLr: worst(Math.min, 'lr'), minMarginTb: worst(Math.min, 'tb') };
}

/** 首尾闭合：第 a 帧对第 b 帧、对相邻帧的 PSNR（dB） */
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

/** 28-1：像素估出的包围盒和元数据的包围盒逐边相减，回抽到的帧里最大的差（像素）。samples 是 [{ frame, box }] */
export function readPixelBoxes(samples, background, tol) {
  const diffs = samples.flatMap(({ frame, box }) => {
    const [x, y, w, h] = pixelBbox(frame, rgb(background), tol).value;
    return [x, y, x + w, y + h].map((edge, i) => Math.abs(edge - box[i]));
  });
  return { maxDiffPx: diffs.length ? Math.max(...diffs) : null };
}

/** 01-1：成片文件读回规格与色彩标签、响度与真峰值、黑帧冻结重复帧。缺 ffmpeg / ffprobe 时对应的读数是 null（判不过） */
export async function readMaster(file, frameArgs) {
  const [spec, loudness, frames] = await Promise.all([deliverSpec(file), audioLoudness(file), blackFreezeDup(file, frameArgs)]);
  return {
    'deliver.spec': spec.value,
    'audio.loudness': loudness.value === null ? null : { lufs: loudness.value, truePeakDbtp: loudness.details.truePeakDbtp },
    'frame.black-freeze-dup': frames.value,
  };
}

/* ---------------- 判分 ---------------- */

// 每条线只在 args 给了的时候判；读数缺项或不是数一律不过
const JUDGES = {
  'layout.edges': (r, a) =>
    (a.maxEdgeErrorPx === undefined || (r.edgeErrorsPx?.length === 2 * a.bands.length && r.edgeErrorsPx.every((e) => num(e) && Math.abs(e) <= a.maxEdgeErrorPx)))
    && (a.maxLevels === undefined || (num(r.lineColorError) && r.lineColorError <= a.maxLevels)),
  'meta.bbox-limits': (r, a) => r.frames > 0 && r.maxW <= a.maxW && r.maxH <= a.maxH && r.minMarginLr >= a.minMarginLr && r.minMarginTb >= a.minMarginTb,
  // 两帧完全相同时 PSNR 是正无穷，照常比；maxRatio 比的是均方根误差之比，由两个 PSNR 换算
  'loop.closure-psnr': (r, a) =>
    (a.expect === undefined || r.nearest === a.expect)
    && (a.marginDb === undefined || r.closurePsnr >= r.adjacentPsnr - a.marginDb)
    && (a.maxRatio === undefined || 10 ** ((r.adjacentPsnr - r.closurePsnr) / 20) <= a.maxRatio),
  'pixel.bbox': (r, a) => num(r.maxDiffPx) && r.maxDiffPx <= a.tolPx,
  'deliver.spec': (r, a, { deliverable }) => {
    const [fpsNum, fpsDen] = deliverable.fps.split('/').map(Number);
    return r.width === deliverable.size[0] && r.height === deliverable.size[1] && r.fps === fpsNum / fpsDen && r.frames === deliverable.frames
      && ['color_space', 'color_transfer', 'color_primaries'].every((tag) => r[tag] === a.color);
  },
  'audio.loudness': (r, a) => num(r.lufs) && r.lufs >= a.lufs[0] && r.lufs <= a.lufs[1] && typeof r.truePeakDbtp === 'number' && r.truePeakDbtp <= a.maxTruePeakDbtp,
  'frame.black-freeze-dup': (r) => r.blackFrames === 0 && r.freezeSegments === 0 && r.duplicateFrames === 0,
};

/** 照题目的 scoring 判一份读数：回 { id, score, pass, items: [{ metric, weight, pass }] }。满分是 1；有一项不过 pass 就是 false。没有读数、没有判法的项不过 */
export function score(question, readings) {
  const items = question.scoring.map(({ metric, args = {}, weight }) => {
    const reading = readings[metric];
    return { metric, weight, pass: Boolean(reading) && JUDGES[metric]?.(reading, args, question) === true };
  });
  return { id: question.id, score: items.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0), pass: items.every((item) => item.pass), items };
}
