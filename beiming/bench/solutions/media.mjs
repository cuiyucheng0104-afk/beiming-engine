// B20 标准答案工程的跨平台 FFmpeg / FFprobe 真实编解码与信号读回工具。
// 所有子进程一律 windowsHide: true、不经 shell；编码规格由 deliver.encode 技术卡给出，
// 色彩标签显式写进容器与 H.264 VUI（BT.709），音轨采用 48 kHz 无损 ALAC 消除 AAC priming 偏移。
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { create as createEncode } from '../../cards/delivery/encode/comp.mjs';

export const SAMPLE_RATE = 48000;

export const ffmpegBin = () => process.env.FFMPEG || 'ffmpeg';
export const ffprobeBin = () => process.env.FFPROBE || 'ffprobe';

export function hasMediaTools() {
  for (const bin of [ffmpegBin(), ffprobeBin()]) {
    const res = spawnSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true });
    if (res.error || res.status !== 0) return false;
  }
  return true;
}

export function encodeSpecFor(size, fps, master = 'h264-crf14-bt709') {
  const handle = createEncode({ size, fps }, { master });
  const spec = handle.object;
  handle.dispose();
  return spec;
}

export function bt709Args(spec) {
  const range = spec.range === 'limited' ? 'tv' : 'pc';
  const x264 = `colorprim=${spec.primaries}:transfer=${spec.transfer}:colormatrix=${spec.matrix}`;
  return [
    '-colorspace', spec.matrix,
    '-color_trc', spec.transfer,
    '-color_primaries', spec.primaries,
    '-color_range', range,
    '-x264-params', x264,
  ];
}

export function runExecSync(bin, args, { input, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const res = spawnSync(bin, args, { input, maxBuffer, windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${bin} 失败 (code=${res.status}): ${String(res.stderr ?? '').slice(-2048)}`);
  }
  return res.stdout;
}

export function runFfmpegSync(args, opts = {}) {
  return runExecSync(ffmpegBin(), ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args], opts);
}

/** 写 48 kHz 16-bit PCM WAV（1 或 2 声道 Float32Array，范围 [-1, 1]） */
export function writeWav48k(filePath, channels, sampleRate = SAMPLE_RATE) {
  const list = Array.isArray(channels) ? channels : [channels];
  const chCount = list.length;
  const samples = list[0].length;
  const dataBytes = samples * chCount * 2;
  const buf = Buffer.allocUnsafe(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(chCount, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * chCount * 2, 28);
  buf.writeUInt16LE(chCount * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < chCount; c++) {
      const clamped = Math.max(-1, Math.min(1, list[c][i]));
      const val = Math.max(-32768, Math.min(32767, Math.round(clamped * 32767)));
      buf.writeInt16LE(val, off);
      off += 2;
    }
  }
  writeFileSync(filePath, buf);
  return filePath;
}

/** 写 FFMETADATA1 章节表（TIMEBASE=1/1000，精确整毫秒） */
export function writeFfmetadataChapters(filePath, chaptersMs, totalMs) {
  const lines = [';FFMETADATA1'];
  for (let i = 0; i < chaptersMs.length; i++) {
    const start = Math.round(chaptersMs[i]);
    const end = i + 1 < chaptersMs.length ? Math.round(chaptersMs[i + 1]) : Math.round(totalMs);
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=Chapter ${i + 1}`);
  }
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

/**
 * 流式把逐帧原始像素写入 FFmpeg 编码为标准 BT.709 MP4（单帧缓冲复用，避免堆内 GB 级分配）。
 * writeFrames(push) 负责依次调用 await push(buffer) 写入 frames 帧。
 */
export async function encodeRawFramesStream({
  outPath,
  inSize,
  outSize,
  pixFmt = 'rgba',
  fps,
  spec,
  audioPath = null,
  chaptersPath = null,
  crf = null,
  gop = null,
  preset = 'ultrafast',
  writeFrames,
}) {
  const [inW, inH] = inSize;
  const [outW, outH] = outSize;
  const needsScale = inW !== outW || inH !== outH;
  const colorConvert = pixFmt === 'gray'
    ? (needsScale ? `scale=${outW}:${outH}:flags=neighbor,format=yuv420p` : 'format=yuv420p')
    : (needsScale
      ? `scale=${outW}:${outH}:flags=neighbor:out_color_matrix=bt709:out_range=tv,format=yuv420p`
      : 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p');

  const args = [
    '-nostdin', '-hide_banner', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', pixFmt, '-s', `${inW}x${inH}`, '-r', String(fps), '-i', 'pipe:0',
  ];
  let nextInput = 1;
  let audioIdx = null;
  let chapterIdx = null;
  if (audioPath) {
    args.push('-i', resolve(audioPath));
    audioIdx = nextInput++;
  }
  if (chaptersPath) {
    args.push('-f', 'ffmetadata', '-i', resolve(chaptersPath));
    chapterIdx = nextInput++;
  }
  args.push('-map', '0:v:0');
  if (audioIdx !== null) args.push('-map', `${audioIdx}:a:0`);
  if (chapterIdx !== null) args.push('-map_metadata', String(chapterIdx), '-map_chapters', String(chapterIdx));

  args.push(
    '-vf', colorConvert,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf ?? spec.crf),
    ...(gop !== null ? ['-g', String(gop)] : []),
    '-pix_fmt', spec.pixelFormat,
    ...bt709Args(spec),
    ...(audioIdx !== null ? ['-c:a', 'alac'] : []),
    '-movflags', '+faststart',
    resolve(outPath),
  );

  const child = spawn(ffmpegBin(), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });

  const done = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) accept();
      else reject(new Error(`ffmpeg 编码失败 (code=${code}): ${stderr}`));
    });
  });

  const push = (buf) => {
    // 拷贝当前帧字节，防止调用方复用同一缓冲在下一次循环中覆写尚未刷出管道的队列帧
    const copy = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const owned = Buffer.allocUnsafe(copy.length);
    copy.copy(owned);
    if (child.stdin.write(owned)) return null;
    return new Promise((accept, reject) => {
      const onDrain = () => { cleanup(); accept(); };
      const onErr = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        child.stdin.off('drain', onDrain);
        child.stdin.off('error', onErr);
      };
      child.stdin.once('drain', onDrain);
      child.stdin.once('error', onErr);
    });
  };

  try {
    await writeFrames(push);
    child.stdin.end();
    await done;
  } catch (err) {
    if (child.exitCode === null) child.kill();
    throw err;
  }
  return outPath;
}

/** 用单次 FFmpeg select 解码指定帧号列表（返回 Map<frameIndex, { width, height, rgba }>） */
export function decodeSelectedFramesRgb(filePath, frameIndices, [width, height]) {
  const unique = [...new Set(frameIndices)].sort((a, b) => a - b);
  if (!unique.length) return new Map();
  const expr = unique.map((n) => `eq(n\\,${n})`).join('+');
  const raw = runFfmpegSync([
    '-i', resolve(filePath),
    '-vf', `select='${expr}',format=rgba`,
    '-vsync', '0',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], { maxBuffer: unique.length * width * height * 4 + 1024 * 1024 });
  const stride = width * height * 4;
  if (raw.length !== unique.length * stride) {
    throw new Error(`解码帧字节数不符: 期望 ${unique.length * stride}, 实际 ${raw.length}`);
  }
  const map = new Map();
  for (let i = 0; i < unique.length; i++) {
    const slice = new Uint8Array(stride);
    slice.set(raw.subarray(i * stride, (i + 1) * stride));
    map.set(unique[i], { width, height, rgba: slice });
  }
  return map;
}

/** 解码全部帧为灰度（可选缩放到 [outW, outH] 加速运动与淡出分析） */
export function decodeAllFramesGray(filePath, [outW, outH], expectedFrames) {
  const raw = runFfmpegSync([
    '-i', resolve(filePath),
    '-vf', `scale=${outW}:${outH}:flags=area,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { maxBuffer: expectedFrames * outW * outH + 4 * 1024 * 1024 });
  const stride = outW * outH;
  const count = Math.floor(raw.length / stride);
  const frames = new Array(count);
  for (let i = 0; i < count; i++) {
    const plane = new Uint8Array(stride);
    plane.set(raw.subarray(i * stride, (i + 1) * stride));
    frames[i] = plane;
  }
  return frames;
}

/** 解码指定帧号列表为灰度帧（Map<frameIndex, Uint8Array>） */
export function decodeSelectedFramesGray(filePath, frameIndices, [width, height]) {
  const unique = [...new Set(frameIndices)].sort((a, b) => a - b);
  if (!unique.length) return new Map();
  const expr = unique.map((n) => `eq(n\\,${n})`).join('+');
  const raw = runFfmpegSync([
    '-i', resolve(filePath),
    '-vf', `select='${expr}',format=gray`,
    '-vsync', '0',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { maxBuffer: unique.length * width * height + 1024 * 1024 });
  const stride = width * height;
  if (raw.length !== unique.length * stride) {
    throw new Error(`解码灰度帧字节数不符: 期望 ${unique.length * stride}, 实际 ${raw.length}`);
  }
  const map = new Map();
  for (let i = 0; i < unique.length; i++) {
    const plane = new Uint8Array(stride);
    plane.set(raw.subarray(i * stride, (i + 1) * stride));
    map.set(unique[i], plane);
  }
  return map;
}

/** 解码音轨为 48 kHz 单声道 Float32Array（用于包络/低频重击/旁白起收声量测） */
export function decodeAudioMono48k(filePath) {
  const raw = runFfmpegSync([
    '-i', resolve(filePath),
    '-map', '0:a:0',
    '-ar', String(SAMPLE_RATE),
    '-ac', '1',
    '-f', 'f32le', '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
  const aligned = new Uint8Array(raw.length & ~3);
  aligned.set(raw.subarray(0, aligned.length));
  return new Float32Array(aligned.buffer);
}

function gcdInt(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

/** 将 ffprobe 实测有理数帧率规约成标准分数串（如 "30/1"、"24/1"、"30000/1001"） */
export function formatFpsFraction(fpsNum, fpsDen) {
  if (!Number.isInteger(fpsNum) || !Number.isInteger(fpsDen) || fpsNum <= 0 || fpsDen <= 0) return null;
  const g = gcdInt(fpsNum, fpsDen);
  return `${fpsNum / g}/${fpsDen / g}`;
}

/** 与 runner.mjs 同口径的 ffprobe 成片规格核验（异步非阻塞，可与指标并行执行） */
export async function probeDeliverableSpecAsync(filePath) {
  const args = [
    '-v', 'error',
    '-count_frames',
    '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,nb_read_frames,channels,channel_layout,color_space,color_transfer,color_primaries,color_range',
    '-of', 'json',
    resolve(filePath),
  ];
  const out = await new Promise((accept, reject) => {
    const child = spawn(ffprobeBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr = (stderr + c).slice(-2048); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) accept(stdout);
      else reject(new Error(`ffprobe 失败 (code=${code}): ${stderr}`));
    });
  });
  const streams = JSON.parse(out).streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) return null;
  const [fpsNum, fpsDen] = String(v.avg_frame_rate).split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    fpsNum,
    fpsDen,
    fps: fpsDen ? fpsNum / fpsDen : null,
    fpsFraction: formatFpsFraction(fpsNum, fpsDen),
    frames: Number(v.nb_read_frames),
    audio: Boolean(a),
    audioChannels: a?.channels ?? 0,
    audioLayout: a?.channel_layout ?? null,
    color_space: v.color_space ?? null,
    color_transfer: v.color_transfer ?? null,
    color_primaries: v.color_primaries ?? null,
    color_range: v.color_range ?? null,
  };
}

/** 与 runner.mjs 同口径的 ffprobe 成片规格核验（同步版本） */
export function probeDeliverableSpec(filePath) {
  const out = runExecSync(ffprobeBin(), [
    '-v', 'error',
    '-count_frames',
    '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,nb_read_frames,channels,channel_layout,color_space,color_transfer,color_primaries,color_range',
    '-of', 'json',
    resolve(filePath),
  ]);
  const streams = JSON.parse(String(out)).streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) return null;
  const [fpsNum, fpsDen] = String(v.avg_frame_rate).split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    fpsNum,
    fpsDen,
    fps: fpsDen ? fpsNum / fpsDen : null,
    fpsFraction: formatFpsFraction(fpsNum, fpsDen),
    frames: Number(v.nb_read_frames),
    audio: Boolean(a),
    audioChannels: a?.channels ?? 0,
    audioLayout: a?.channel_layout ?? null,
    color_space: v.color_space ?? null,
    color_transfer: v.color_transfer ?? null,
    color_primaries: v.color_primaries ?? null,
    color_range: v.color_range ?? null,
  };
}
