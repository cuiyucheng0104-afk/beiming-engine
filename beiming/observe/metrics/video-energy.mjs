// 成片视频文件的噪点残差与边缘锯齿量测封装（O8 视频入口）。
// 用 ffprobe 查宽高与总帧数，用 ffmpeg 流式解码 8 位灰度亮度平面（不落临时图片文件），
// 短片全量解码，长片按确定性首/中/尾三段连续窗口分段量测后聚合（取最差值与最大闪烁），避免 4K 长片爆内存。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { aliasEdge, noiseResidual } from './energy-rulers.mjs';

export const DEFAULT_MAX_FRAMES = 60;
const MIN_MAX_FRAMES = 9;
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

/**
 * 流式解码 8 位灰度帧平面，只保留落入目标连续段的帧；每段满帧立即回调并释放该段缓冲，控制内存上界。
 */
async function streamGraySegments(filePath, width, height, segments, onSegment) {
  const frameBytes = width * height;
  const child = spawn('ffmpeg', [
    '-nostdin', '-hide_banner', '-v', 'error',
    '-i', resolve(filePath),
    '-map', '0:v:0',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const closed = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? accept() : reject(new Error(`ffmpeg: ${stderr}`))));
  });

  let frameIndex = 0;
  let segIdx = 0;
  let offset = 0;
  let currentBuf = null;
  let segFrames = [];

  try {
    await Promise.all([closed, (async () => {
      for await (const chunk of child.stdout) {
        let pos = 0;
        while (pos < chunk.length) {
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
            if (seg !== null && frameIndex === seg[1]) {
              onSegment(seg, segFrames);
              segFrames = [];
              segIdx++;
            }
          }
        }
      }
      if (segIdx < segments.length && segFrames.length > 0) {
        onSegment([segments[segIdx][0], frameIndex], segFrames);
        segFrames = [];
      }
    })()]);
  } finally {
    if (child.exitCode === null) child.kill();
  }
  return frameIndex;
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
    const { width, height, totalFrames } = await probeVideo(filePath);
    if (totalFrames < 2) {
      return {
        value: null,
        details: {
          status: 'insufficient-frames',
          staticRatio: 0,
          staticPixels: 0,
          totalPixels: 0,
          pairs: 0,
          sampledFrames: totalFrames,
          totalFrames,
          width,
          height,
          segments: [],
        },
      };
    }
    const plan = planSegments(totalFrames, maxFrames);
    const segResults = [];
    const decoded = await streamGraySegments(filePath, width, height, plan, ([start, end], frames) => {
      if (frames.length < 2) return;
      const r = noiseResidual(frames, rulerOpts);
      segResults.push({ start, end, frames: frames.length, r });
    });
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
          totalFrames: decoded || totalFrames,
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
    const { width, height, totalFrames } = await probeVideo(filePath);
    const plan = planSegments(totalFrames, maxFrames);
    const segResults = [];
    const decoded = await streamGraySegments(filePath, width, height, plan, ([start, end], frames) => {
      if (frames.length < 1) return;
      const r = aliasEdge(frames, rulerOpts);
      segResults.push({ start, end, frames: frames.length, r });
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
    return {
      value,
      details: {
        status,
        jaggedness: value,
        edgePixels,
        edgeRatio: sampledFrames ? edgePixels / (width * height * sampledFrames) : 0,
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
