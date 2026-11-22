// 合成收尾第二段：编码预设。母版 h264-crf14-bt709、网页 web、预览 preview。
// 三档都在滤镜链末尾挂 setparams，并在输出参数里写齐 BT.709 有限范围四项标注。
// 可复现：libx264 固定线程数、关闭非确定性、固定 GOP（2 秒一个关键帧、不按场景插关键帧），封装去掉版本串与时间戳。
// 显卡编码器只给预览档，并且只在 tier 是 preview 或 draft 时收；终渲（final）传了就报错。
import { startPipe } from './sink.mjs';
import { CompError, bad, parseFps, rawCommand, runTool, tools } from './stitch.mjs';

export const SETPARAMS = 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
export const COLOR_TAGS = Object.freeze(['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']);
export const TIERS = Object.freeze(['preview', 'draft', 'final']);
export const HW_ENCODERS = Object.freeze(['h264_nvenc', 'hevc_nvenc', 'h264_videotoolbox', 'hevc_videotoolbox', 'h264_qsv', 'h264_amf']);

const X264_THREADS = 4;

export const PRESETS = Object.freeze({
  'h264-crf14-bt709': Object.freeze({ crf: 14, preset: 'medium', audioBitrate: '320k', faststart: false }),
  web: Object.freeze({ crf: 20, preset: 'medium', audioBitrate: '192k', faststart: true, maxrate: '8M', bufsize: '16M', profile: 'high' }),
  preview: Object.freeze({ crf: 23, preset: 'veryfast', audioBitrate: '128k', faststart: true, hwBitrate: '8M' }),
});

/**
 * 一个输出的编码参数（不含输入、不含 -map）。
 * opts：{ preset, fps: "num/den", tier, hwEncoder?, audio: 有没有音轨 }
 */
export function outputArgs({ preset, fps, tier = 'final', hwEncoder, audio = false }) {
  const p = PRESETS[preset];
  if (!p) throw bad(`没有编码预设 ${preset}：只有 ${Object.keys(PRESETS).join('、')}`);
  if (!TIERS.includes(tier)) throw bad(`档位只能是 ${TIERS.join('、')}，给的是 ${tier}`);
  const { num, den } = parseFps(fps);
  const gop = Math.max(1, Math.round((2 * num) / den));
  const args = [];
  if (hwEncoder) {
    if (tier !== 'preview' && tier !== 'draft') throw bad(`终渲（tier=${tier}）不收显卡编码器 ${hwEncoder}：母版与网页档只用 libx264，保证逐位可复现`);
    if (preset !== 'preview') throw bad(`显卡编码器只给预览档，${preset} 档不收`);
    if (!HW_ENCODERS.includes(hwEncoder)) throw bad(`不认识的显卡编码器 ${hwEncoder}：只收 ${HW_ENCODERS.join('、')}`);
    args.push('-c:v', hwEncoder, '-b:v', p.hwBitrate, '-g', String(gop));
  } else {
    args.push('-c:v', 'libx264', '-preset', p.preset, '-crf', String(p.crf),
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-x264-params', `threads=${X264_THREADS}:lookahead-threads=1:non-deterministic=0`);
    if (p.profile) args.push('-profile:v', p.profile);
    if (p.maxrate) args.push('-maxrate', p.maxrate, '-bufsize', p.bufsize);
  }
  args.push('-pix_fmt', 'yuv420p', ...COLOR_TAGS, '-r', `${num}/${den}`);
  if (audio) args.push('-c:a', 'aac', '-b:a', p.audioBitrate, '-ar', '48000', '-ac', '2');
  args.push('-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact');
  if (p.faststart) args.push('-movflags', '+faststart');
  return args;
}

/**
 * 一次 ffmpeg 出若干个成片：拼接图后面 split 成几路，每路挂 setparams 再编码。
 * graph 是 stitchGraph 的结果；outputs：[{ preset, path }]；audioPath：已母带处理的 WAV（可以没有）。
 * 返回 ffmpeg 参数数组（纯函数，不跑）。
 */
export function encodeCommand({ graph, outputs, audioPath, tier = 'final', hwEncoder }) {
  if (!Array.isArray(outputs) || outputs.length === 0) throw bad('至少要一个输出');
  const fps = `${graph.fps.num}/${graph.fps.den}`;
  const n = outputs.length;
  const labels = outputs.map((_, i) => `enc${i}`);
  const split = n > 1
    ? `[${graph.label}]split=${n}${labels.map((l) => `[pre${l}]`).join('')};${labels.map((l) => `[pre${l}]${SETPARAMS}[${l}]`).join(';')}`
    : `[${graph.label}]${SETPARAMS}[${labels[0]}]`;
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...graph.inputs.flat()];
  const audioIndex = graph.inputs.length;
  if (audioPath) args.push('-i', audioPath);
  args.push('-filter_complex', `${graph.filter};${split}`);
  outputs.forEach((o, i) => {
    args.push('-map', `[${labels[i]}]`);
    if (audioPath) args.push('-map', `${audioIndex}:a:0`);
    args.push(...outputArgs({ preset: o.preset, fps, tier, hwEncoder, audio: Boolean(audioPath) }), '-frames:v', String(graph.frames), o.path);
  });
  return args;
}

async function encodeToSinks({ graph, outputs, audioPath, tier, hwEncoder, timeoutMs, sinkFactory }) {
  if (typeof sinkFactory !== 'function') throw bad('sinkFactory 必须是函数');
  if (!Array.isArray(outputs) || !outputs.length) throw bad('至少要一个输出');
  const fps = `${graph.fps.num}/${graph.fps.den}`;
  const controller = new globalThis.AbortController();
  const sourceArgs = rawCommand(graph);
  const sinks = [];
  let source;
  async function distribute() {
    for await (const chunk of source.stream) {
      controller.signal.throwIfAborted();
      await Promise.all(sinks.map(async (sink) => sink.write(chunk)));
    }
  }
  try {
    for (const output of outputs) {
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'yuv420p',
        '-video_size', graph.size.join('x'), '-framerate', fps, '-i', 'pipe:0'];
      if (audioPath) args.push('-i', audioPath);
      args.push('-map', '0:v:0');
      if (audioPath) args.push('-map', '1:a:0');
      args.push('-vf', `setsar=1,${SETPARAMS}`, ...outputArgs({ preset: output.preset, fps, tier, hwEncoder, audio: Boolean(audioPath) }));
      const sink = await sinkFactory({ ...output, args, timeoutMs, expectedFrames: graph.frames });
      if (typeof sink?.abort === 'function') sinks.push(sink);
      if (!['write', 'finish', 'abort'].every((key) => typeof sink?.[key] === 'function')) throw bad('输出端必须提供 write、finish 和 abort');
    }
    source = startPipe(tools().ffmpeg, sourceArgs, 'read', controller, timeoutMs);
    // 慢端的 write 可能要等 abort 才结束。整个分发循环共用一次中止监听。
    const interrupted = Promise.withResolvers();
    const onAbort = () => interrupted.reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try { await Promise.race([distribute(), interrupted.promise]); }
    finally { controller.signal.removeEventListener('abort', onAbort); }
    await source.closed;
    controller.signal.throwIfAborted();
    await Promise.all(sinks.map(async (sink) => sink.finish()));
    return sourceArgs;
  } catch (e) {
    const error = controller.signal.reason ?? (e instanceof CompError ? e : new CompError('failure.ffmpeg', `流式编码失败：${e.message}`));
    controller.abort(error);
    await Promise.allSettled(sinks.map(async (sink) => sink.abort()));
    await source?.closed;
    throw error;
  }
}

/** 默认同步编码；注入工厂时返回 Promise，按最慢输出端的背压分发同一份 yuv420p 字节。 */
export function encode(opts) {
  if (opts.sinkFactory !== undefined) return encodeToSinks(opts);
  const args = encodeCommand(opts);
  runTool(tools().ffmpeg, args, { timeoutMs: opts.timeoutMs, what: '编码成片' });
  return args;
}

/** ffprobe 读一个成片：视频流的编码、尺寸、像素格式、四项色彩标注、帧数（数包）、时长；音频流的采样率、声道 */
export function probeMedia(file, { timeoutMs } = {}) {
  const { stdout } = runTool(tools().ffprobe, ['-v', 'error', '-count_packets', '-show_entries',
    'stream=codec_type,codec_name,profile,width,height,pix_fmt,color_range,color_space,color_primaries,color_transfer,r_frame_rate,nb_read_packets,duration,sample_rate,channels:format=duration',
    '-of', 'json', file], { timeoutMs, what: `读媒体信息 ${file}` });
  const j = JSON.parse(stdout.toString('utf8'));
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  const a = (j.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!v) throw new CompError('contract.delivery-mismatch', `${file} 里没有视频流`);
  return {
    video: {
      codec: v.codec_name, profile: v.profile ?? null, width: v.width, height: v.height, pixFmt: v.pix_fmt,
      colorRange: v.color_range ?? null, colorSpace: v.color_space ?? null, colorPrimaries: v.color_primaries ?? null, colorTransfer: v.color_transfer ?? null,
      rate: v.r_frame_rate, frames: Number(v.nb_read_packets), duration: Number(v.duration),
    },
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels, duration: Number(a.duration) } : null,
    duration: Number(j.format?.duration),
  };
}

/** MP4 顶层盒子的次序；faststart 等于 moov 在 mdat 前面 */
export function topLevelBoxes(buf) {
  const out = [];
  let at = 0;
  while (at + 8 <= buf.length) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(at + 8));
    else if (size === 0) size = buf.length - at;
    if (size < 8) break;
    out.push(type);
    at += size;
  }
  return out;
}

export function isFaststart(buf) {
  const boxes = topLevelBoxes(buf);
  const moov = boxes.indexOf('moov');
  const mdat = boxes.indexOf('mdat');
  return moov >= 0 && mdat >= 0 && moov < mdat;
}
