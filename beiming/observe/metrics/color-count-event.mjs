import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify, types } from 'node:util';
import { ffmpegBins } from '../../../tools/env/lib/ffmpeg.mjs';

const METRIC = 'metric:color.count-event';
const UNIT = 'frames';
const EVENT_KEYS = ['lagFrames', 'minCoveragePercent', 'dropRatio'];
const VIDEO_KEYS = [...EVENT_KEYS, 'color', 'similarity', 'roi', 'exclude'];
const RECT_KEYS = ['x', 'y', 'width', 'height'];
const DECODE_ARGS = ['-nostdin', '-hide_banner', '-v', 'error', '-xerror'];
const exec = promisify(execFile);

function bad(message) {
  throw Object.assign(new RangeError(message), { code: 'usage.bad-argument' });
}

function checkOptions(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) bad('选项须为对象');
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) bad(`未知选项 ${key}`);
  }
}

function bounded(value, low, high, name) {
  if (!Number.isFinite(value) || value < low || value > high) bad(`${name} 须在 [${low}, ${high}] 内`);
}

function eventOptions({ lagFrames = 2, minCoveragePercent = 0.02, dropRatio = 0.5 }) {
  if (!Number.isSafeInteger(lagFrames) || lagFrames < 1) bad('lagFrames 须为正整数');
  bounded(minCoveragePercent, 0, 100, 'minCoveragePercent');
  bounded(dropRatio, 0, 1, 'dropRatio');
  return { lagFrames, minCoveragePercent, dropRatio };
}

function countEvents(coveragePercent, { lagFrames, minCoveragePercent, dropRatio }) {
  const value = [];
  let lastAboveThresholdFrame = null;
  let previousDrop = false;
  for (const [frame, current] of coveragePercent.entries()) {
    if (current > minCoveragePercent) lastAboveThresholdFrame = frame;
    const before = frame >= lagFrames ? coveragePercent[frame - lagFrames] : 0;
    const drop = before > minCoveragePercent && current < before * dropRatio;
    if (drop && !previousDrop) value.push(frame);
    previousDrop = drop;
  }
  return { metric: METRIC, value, unit: UNIT, details: { coveragePercent, lastAboveThresholdFrame } };
}

/** Apply the event thresholds to a sequence of measurements in percent (0 to 100). */
export function detectColorCountEvents(coveragePercent, options = {}) {
  checkOptions(options, EVENT_KEYS);
  const settings = eventOptions(options);
  if (types.isProxy(coveragePercent) || !Array.isArray(coveragePercent) || coveragePercent.length === 0) {
    bad('须提供至少一帧占比的数组');
  }
  const coverage = [];
  for (let frame = 0; frame < coveragePercent.length; frame++) {
    const slot = Object.getOwnPropertyDescriptor(coveragePercent, frame);
    if (!slot || !Object.hasOwn(slot, 'value')) bad(`第 ${frame} 帧缺少占比值`);
    bounded(slot.value, 0, 100, '帧占比');
    coverage.push(slot.value);
  }
  return countEvents(coverage, settings);
}

function rectangle(rect, name) {
  checkOptions(rect, RECT_KEYS);
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1
    || !Number.isSafeInteger(x + width) || !Number.isSafeInteger(y + height)) bad(`${name} 须为整数像素矩形`);
  return { x, y, width, height };
}

function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

async function displayRegion(ffmpeg, path) {
  // framecrc reports decoded dimensions after FFmpeg applies the display rotation.
  const { stdout } = await exec(ffmpeg, [...DECODE_ARGS, '-i', path,
    '-map', '0:v:0', '-frames:v', '1', '-f', 'framecrc', '-'], { windowsHide: true });
  const size = /^#dimensions 0:\s*(\d+)x(\d+)\s*$/m.exec(stdout);
  if (!size || !/^0,\s*\S+/m.test(stdout)) throw new Error('ffmpeg: 缺少解码视频帧');
  return { x: 0, y: 0, width: Number(size[1]), height: Number(size[2]) };
}

function matchingPixels(bytes, start, end) {
  let count = 0;
  for (let i = start; i < end; i++) {
    if (bytes[i] === 0) count++;
  }
  return count;
}

function matchingInRegion(chunk, start, length, frameOffset, roi, exclude) {
  if (!exclude) return matchingPixels(chunk, start, start + length);
  const { width } = roi;
  let count = 0;
  // Keep the excluded rectangle in display coordinates, even when the buffer splits a row.
  for (let i = 0; i < length;) {
    const x = (frameOffset + i) % width;
    const y = Math.floor((frameOffset + i) / width) + roi.y;
    const rowLength = Math.min(length - i, width - x);
    const startX = x + roi.x;
    const at = start + i;
    if (y < exclude.y || y >= exclude.y + exclude.height) {
      count += matchingPixels(chunk, at, at + rowLength);
    } else {
      const left = Math.min(rowLength, Math.max(0, exclude.x - startX));
      const right = Math.min(rowLength, Math.max(0, exclude.x + exclude.width - startX));
      count += matchingPixels(chunk, at, at + left) + matchingPixels(chunk, at + right, at + rowLength);
    }
    i += rowLength;
  }
  return count;
}

async function measureVideo(ffmpeg, path, filter, roi, exclude) {
  const child = spawn(ffmpeg, [...DECODE_ARGS, '-i', path, '-map', '0:v:0', '-vf', filter,
    '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let spawnError;
  child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8192); });
  child.once('error', error => { spawnError = error; });
  const closed = new Promise(done => child.once('close', done));
  const coveragePercent = [];
  const area = roi.width * roi.height;
  let offset = 0;
  let matched = 0;
  try {
    for await (const chunk of child.stdout) {
      for (let start = 0; start < chunk.length;) {
        const length = Math.min(chunk.length - start, area - offset);
        matched += matchingInRegion(chunk, start, length, offset, roi, exclude);
        offset += length;
        start += length;
        if (offset === area) {
          coveragePercent.push(matched / area * 100);
          offset = 0;
          matched = 0;
        }
      }
    }
    const code = await closed;
    if (spawnError) throw spawnError;
    if (code !== 0) throw new Error(`ffmpeg: ${stderr.trim() || `退出码 ${code}`}`);
    if (offset || !coveragePercent.length) throw new Error('ffmpeg: 颜色掩码缺帧或被截断');
    return coveragePercent;
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) child.kill();
    await closed;
  }
}

/** Measure color coverage from the first video stream and detect abrupt drops. */
export async function colorCountEvent(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) bad('文件路径须为非空字符串');
  checkOptions(options, VIDEO_KEYS);
  const settings = eventOptions(options);
  const { color, similarity = 0.16 } = options;
  if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) bad('color 须为 #RRGGBB');
  bounded(similarity, 0.01, 1, 'similarity');
  const requested = options.roi === undefined ? null : rectangle(options.roi, 'roi');
  const exclude = options.exclude === undefined ? null : rectangle(options.exclude, 'exclude');
  if (requested && exclude && !contains(requested, exclude)) bad('exclude 须落在 roi 内');
  const { ffmpeg } = ffmpegBins();
  const path = resolve(filePath);
  try {
    const display = await displayRegion(ffmpeg, path);
    const roi = requested ?? display;
    if (!contains(display, roi)) bad('roi 超出解码画面');
    if (exclude && !contains(roi, exclude)) bad('exclude 须落在 roi 内');
    // Crop in the source format. Explicit scale keeps RGB conversion after the crop.
    // colorkey replaces the original alpha with its binary RGB match mask.
    const crop = requested ? `crop=${roi.width}:${roi.height}:${roi.x}:${roi.y}:exact=1,scale=iw:ih,` : '';
    const filter = `${crop}format=rgba,colorkey=0x${color.slice(1)}:${similarity}:0,alphaextract`;
    const coverage = await measureVideo(ffmpeg, path, filter, roi, exclude);
    const result = countEvents(coverage, settings);
    return { ...result, details: { ...result.details, displaySize: [display.width, display.height], roi, exclude } };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { metric: METRIC, value: null, unit: UNIT, details: { code: 'tool-missing', tool: 'ffmpeg' } };
  }
}
