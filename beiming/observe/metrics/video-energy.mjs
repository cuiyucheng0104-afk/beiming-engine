// 成片视频文件的噪点残差与边缘锯齿量测封装（O8 视频入口）。
// 用 ffprobe 查总帧数，用 ffmpeg 以自定界 Y4M 单通道灰度流（yuv4mpegpipe + gray，-fps_mode passthrough）
// 读取按显示矩阵自动旋转后的真实解码尺寸与 8 位灰度亮度平面（不落临时图片文件）；
// 短片全量解码，长片按确定性首/中/尾三段连续窗口分段量测后聚合（取最差值与最大闪烁），避免 4K 长片爆内存。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { aliasEdge, noiseResidual } from './energy-rulers.mjs';

export const DEFAULT_MAX_FRAMES = 60;
const MIN_MAX_FRAMES = 9;
const MAX_Y4M_LINE = 4096;
const NOISE_OPTS = ['maxFrames', 'roi', 'block', 'motionThreshold', 'maxShift'];
const ALIAS_OPTS = ['maxFrames', 'roi', 'edgeThreshold'];

function bad(message) {
  throw Object.assign(new RangeError(message), { code: 'usage.bad-argument' });
}

function validateInputs(filePath, opts, allowed) {
  if (typeof filePath !== 'string' || !filePath.trim()) bad('文件路径须为非空字符串');
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) bad('选项须为对象');
  for (const key of Object.keys(opts)) {
    if (!allowed.includes(key)) bad(`未知选项 ${key}`);
  }
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  if (!Number.isSafeInteger(maxFrames) || maxFrames < MIN_MAX_FRAMES) {
    bad(`maxFrames 须为不少于 ${MIN_MAX_FRAMES} 的安全整数`);
  }
  const rulerOpts = {};
  for (const key of Object.keys(opts)) {
    if (key !== 'maxFrames' && opts[key] !== undefined) rulerOpts[key] = opts[key];
  }
  return { maxFrames, rulerOpts };
}

function validateRulerOpts(rulerOpts) {
  if (rulerOpts.maxShift !== undefined && (!Number.isSafeInteger(rulerOpts.maxShift) || rulerOpts.maxShift < 0)) {
    bad('maxShift 须为非负安全整数');
  }
  if (rulerOpts.block !== undefined && (!Number.isInteger(rulerOpts.block) || rulerOpts.block < 4)) {
    bad('block 须为不小于 4 的整数');
  }
  if (rulerOpts.motionThreshold !== undefined && (!Number.isFinite(rulerOpts.motionThreshold) || rulerOpts.motionThreshold < 0)) {
    bad('无效参数 motionThreshold');
  }
  if (rulerOpts.edgeThreshold !== undefined && (!Number.isFinite(rulerOpts.edgeThreshold) || rulerOpts.edgeThreshold < 0)) {
    bad('无效参数 edgeThreshold');
  }
}

function resolveRegion(width, height, roi) {
  if (roi === undefined) return { x: 0, y: 0, width, height };
  if (
    roi === null || typeof roi !== 'object' || Array.isArray(roi)
    || ![roi.x, roi.y, roi.width, roi.height].every(Number.isInteger)
    || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0
    || roi.x + roi.width > width || roi.y + roi.height > height
  ) {
    bad('roi 须为画面内的整数像素框');
  }
  return roi;
}

/** 规划确定性采样窗口：短片全量解码，长片取首/中/尾三段互不重叠的连续帧段（每段至少 3 帧） */
function planSegments(totalFrames, maxFrames) {
  if (totalFrames <= maxFrames) return [[0, totalFrames]];
  const segLen = Math.floor(maxFrames / 3);
  const midStart = Math.floor((totalFrames - segLen) / 2);
  return [
    [0, segLen],
    [midStart, midStart + segLen],
    [totalFrames - segLen, totalFrames],
  ];
}

async function probeVideo(filePath) {
  const child = spawn('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=width,height,nb_read_frames,nb_frames',
    '-of', 'json', resolve(filePath),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? accept() : reject(new Error(`ffprobe: ${stderr}`))));
  });
  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream) throw new Error('缺少视频轨');
  const width = Number(stream.width);
  const height = Number(stream.height);
  const totalFrames = Number(stream.nb_read_frames) || Number(stream.nb_frames);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('视频尺寸无效');
  }
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) {
    throw new Error('缺少视频帧');
  }
  return { width, height, totalFrames };
}

function parseY4mStreamHeader(line) {
  if (!line.startsWith('YUV4MPEG2 ')) throw new Error(`无效 Y4M 流头：${line.slice(0, 64)}`);
  const wm = /\bW(\d+)\b/.exec(line);
  const hm = /\bH(\d+)\b/.exec(line);
  const width = wm ? Number(wm[1]) : 0;
  const height = hm ? Number(hm[1]) : 0;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`无效 Y4M 尺寸：${line.slice(0, 64)}`);
  }
  return { width, height };
}

/**
 * 以 Y4M（yuv4mpegpipe + gray）流式解码 8 位灰度帧平面：
 * 直接从 ffmpeg 写出的 YUV4MPEG2 头取真实显示宽高（自动对齐任意旋转矩阵），
 * 仅保留落入目标连续段的帧并在每段满帧时立即回调释放缓冲，控制内存上界。
 */
async function streamGraySegments(filePath, segments, { onHeader, onSegment }) {
  const child = spawn('ffmpeg', [
    '-nostdin', '-hide_banner', '-v', 'error',
    '-i', resolve(filePath),
    '-map', '0:v:0',
    '-fps_mode', 'passthrough',
    '-strict', '-1',
    '-f', 'yuv4mpegpipe', '-pix_fmt', 'gray', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stoppedEarly = false;
  let spawnError = null;
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const closed = new Promise((accept, reject) => {
    child.once('error', (err) => {
      spawnError = err;
      reject(err);
    });
    child.once('close', (code) => {
      if (stoppedEarly || code === 0) accept();
      else reject(new Error(`ffmpeg: ${stderr}`));
    });
  });

  let state = 'header';
  let lineChunks = [];
  let lineLen = 0;
  let width = 0;
  let height = 0;
  let frameBytes = 0;
  let frameIndex = 0;
  let segIdx = 0;
  let offset = 0;
  let currentBuf = null;
  let segFrames = [];
  let headerParsed = false;
  let earlyAbort = false;

  const takeLine = (chunk, pos) => {
    const nl = chunk.indexOf(0x0a, pos);
    if (nl === -1) {
      const slice = chunk.subarray(pos);
      lineLen += slice.length;
      if (lineLen > MAX_Y4M_LINE) throw new Error('Y4M 头行过长');
      lineChunks.push(slice);
      return { line: null, nextPos: chunk.length };
    }
    const slice = chunk.subarray(pos, nl);
    lineLen += slice.length;
    if (lineLen > MAX_Y4M_LINE) throw new Error('Y4M 头行过长');
    lineChunks.push(slice);
    const line = Buffer.concat(lineChunks).toString('ascii').replace(/\r$/, '');
    lineChunks = [];
    lineLen = 0;
    return { line, nextPos: nl + 1 };
  };

  let readerError = null;
  try {
    const reader = (async () => {
      try {
        for await (const chunk of child.stdout) {
          let pos = 0;
          while (pos < chunk.length) {
            if (state === 'header') {
              const { line, nextPos } = takeLine(chunk, pos);
              pos = nextPos;
              if (line === null) break;
              ({ width, height } = parseY4mStreamHeader(line));
              frameBytes = width * height;
              headerParsed = true;
              if (onHeader && onHeader({ width, height }) === false) {
                earlyAbort = true;
                stoppedEarly = true;
                child.stdout.destroy();
                if (child.exitCode === null) child.kill();
                return;
              }
              state = 'frame-hdr';
            } else if (state === 'frame-hdr') {
              const { line, nextPos } = takeLine(chunk, pos);
              pos = nextPos;
              if (line === null) break;
              if (!line.startsWith('FRAME')) throw new Error(`无效 Y4M 帧头：${line.slice(0, 32)}`);
              offset = 0;
              state = 'frame-data';
            } else {
              const need = frameBytes - offset;
              const take = Math.min(need, chunk.length - pos);
              const seg = segIdx < segments.length ? segments[segIdx] : null;
              const keep = seg !== null && frameIndex >= seg[0] && frameIndex < seg[1];
              if (keep) {
                if (offset === 0) currentBuf = new Uint8Array(frameBytes);
                currentBuf.set(chunk.subarray(pos, pos + take), offset);
              }
              offset += take;
              pos += take;
              if (offset === frameBytes) {
                if (keep) {
                  segFrames.push({ width, height, luma: currentBuf });
                  currentBuf = null;
                }
                frameIndex++;
                offset = 0;
                state = 'frame-hdr';
                if (seg !== null && frameIndex === seg[1]) {
                  onSegment(seg, segFrames, width, height);
                  segFrames = [];
                  segIdx++;
                }
              }
            }
          }
        }
        if (headerParsed && !earlyAbort && segIdx < segments.length && segFrames.length > 0) {
          onSegment([segments[segIdx][0], frameIndex], segFrames, width, height);
          segFrames = [];
        }
      } catch (err) {
        readerError = err;
        stoppedEarly = true;
        child.stdout.destroy();
        if (child.exitCode === null) child.kill();
      }
    })();

    await Promise.all([closed, reader]);
    if (readerError) throw readerError;
    if (!headerParsed && !spawnError) throw new Error('缺少视频帧');
  } finally {
    if (child.exitCode === null) child.kill();
  }
  return { width, height, decoded: frameIndex, aborted: earlyAbort };
}

async function measure(metric, unit, run) {
  try {
    return { metric, unit, ...await run() };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { metric, value: null, details: { code: 'tool-missing', tool: error.path ?? 'ffmpeg' }, unit };
  }
}

export function videoNoiseResidual(filePath, opts = {}) {
  const { maxFrames, rulerOpts } = validateInputs(filePath, opts, NOISE_OPTS);
  return measure('metric:noise.residual', 'code8', async () => {
    validateRulerOpts(rulerOpts);
    const probed = await probeVideo(filePath);
    if (probed.totalFrames < 2) {
      // 仅读 Y4M 流头即终止（0 帧解码），确保单帧旋转视频也回报与 ffmpeg 显示矩阵一致的宽高
      const { width, height } = await streamGraySegments(filePath, [], {
        onHeader({ width: w, height: h }) {
          resolveRegion(w, h, rulerOpts.roi);
          return false;
        },
        onSegment() {},
      });
      return {
        value: null,
        details: {
          status: 'insufficient-frames',
          staticRatio: 0,
          staticPixels: 0,
          totalPixels: 0,
          pairs: 0,
          sampledFrames: probed.totalFrames,
          totalFrames: probed.totalFrames,
          width,
          height,
          segments: [],
        },
      };
    }
    const plan = planSegments(probed.totalFrames, maxFrames);
    const segResults = [];
    let effectiveOpts = rulerOpts;
    let insufficientResolution = false;

    const { width, height, decoded } = await streamGraySegments(filePath, plan, {
      onHeader({ width: w, height: h }) {
        const reg = resolveRegion(w, h, rulerOpts.roi);
        if (rulerOpts.block === undefined) {
          const shortSide = Math.min(reg.width, reg.height);
          if (shortSide < 4) {
            insufficientResolution = true;
            return false;
          }
          if (shortSide < 8) effectiveOpts = { ...rulerOpts, block: shortSide };
        }
        return true;
      },
      onSegment([start, end], frames) {
        if (frames.length < 2) return;
        const r = noiseResidual(frames, effectiveOpts);
        segResults.push({ start, end, frames: frames.length, r });
      },
    });

    if (insufficientResolution) {
      return {
        value: null,
        details: {
          status: 'insufficient-resolution',
          staticRatio: 0,
          staticPixels: 0,
          totalPixels: 0,
          pairs: 0,
          sampledFrames: 0,
          totalFrames: probed.totalFrames,
          width,
          height,
          segments: [],
        },
      };
    }
    if (decoded < 2 || segResults.length === 0) {
      return {
        value: null,
        details: {
          status: 'insufficient-frames',
          staticRatio: 0,
          staticPixels: 0,
          totalPixels: 0,
          pairs: 0,
          sampledFrames: decoded,
          totalFrames: decoded || probed.totalFrames,
          width,
          height,
          segments: [],
        },
      };
    }
    const okSegs = segResults.filter((s) => s.r.status === 'ok' && s.r.value !== null);
    const value = okSegs.length ? Math.max(...okSegs.map((s) => s.r.value)) : null;
    const status = okSegs.length ? 'ok' : 'no-static-region';
    const staticPixels = segResults.reduce((sum, s) => sum + s.r.staticPixels, 0);
    const totalPixels = segResults.reduce((sum, s) => sum + s.r.totalPixels, 0);
    const pairs = segResults.reduce((sum, s) => sum + s.r.pairs, 0);
    const sampledFrames = segResults.reduce((sum, s) => sum + s.frames, 0);
    const first = segResults[0].r;
    return {
      value,
      details: {
        status,
        staticRatio: totalPixels ? staticPixels / totalPixels : 0,
        staticPixels,
        totalPixels,
        pairs,
        block: first.block,
        motionThreshold: first.motionThreshold,
        maxShift: first.maxShift,
        sampledFrames,
        totalFrames: decoded,
        width,
        height,
        segments: segResults.map((s) => ({
          start: s.start,
          end: s.end,
          value: s.r.value,
          status: s.r.status,
          staticRatio: s.r.staticRatio,
        })),
      },
    };
  });
}

export function videoAliasEdge(filePath, opts = {}) {
  const { maxFrames, rulerOpts } = validateInputs(filePath, opts, ALIAS_OPTS);
  return measure('metric:alias.edge', 'px', async () => {
    validateRulerOpts(rulerOpts);
    const probed = await probeVideo(filePath);
    const plan = planSegments(probed.totalFrames, maxFrames);
    const segResults = [];
    const { width, height, decoded } = await streamGraySegments(filePath, plan, {
      onHeader({ width: w, height: h }) {
        resolveRegion(w, h, rulerOpts.roi);
        return true;
      },
      onSegment([start, end], frames) {
        if (frames.length < 1) return;
        const r = aliasEdge(frames, rulerOpts);
        segResults.push({ start, end, frames: frames.length, r });
      },
    });
    if (decoded < 1 || segResults.length === 0) throw new Error('缺少视频帧');
    const okSegs = segResults.filter((s) => s.r.status === 'ok');
    const value = okSegs.length ? Math.max(...okSegs.map((s) => s.r.value)) : 0;
    const status = okSegs.length ? 'ok' : 'no-edges';
    const flickers = segResults.map((s) => s.r.flicker).filter((f) => typeof f === 'number' && Number.isFinite(f));
    const flicker = flickers.length ? Math.max(...flickers) : null;
    const edgePixels = segResults.reduce((sum, s) => sum + s.r.edgePixels, 0);
    const detailPixels = Math.max(...segResults.map((s) => s.r.detailPixels));
    const sampledFrames = segResults.reduce((sum, s) => sum + s.frames, 0);
    const first = segResults[0].r;
    const areaW = rulerOpts.roi?.width ?? width;
    const areaH = rulerOpts.roi?.height ?? height;
    return {
      value,
      details: {
        status,
        jaggedness: value,
        edgePixels,
        edgeRatio: sampledFrames ? edgePixels / (areaW * areaH * sampledFrames) : 0,
        flicker,
        flickerUnit: first.flickerUnit,
        detailPixels,
        edgeThreshold: first.edgeThreshold,
        sampledFrames,
        totalFrames: decoded,
        width,
        height,
        segments: segResults.map((s) => ({
          start: s.start,
          end: s.end,
          value: s.r.value,
          status: s.r.status,
          edgePixels: s.r.edgePixels,
          flicker: s.r.flicker,
        })),
      },
    };
  });
}
