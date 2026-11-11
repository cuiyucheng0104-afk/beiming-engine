// 北冥引擎 · 原生层 · 交付：交付档位、响度测量与增益、母版 / 网页版的 FFmpeg 参数。原生入口（engine/render/native.mjs）调用；
// 纯函数部分（档位、解析、增益规划、参数拼装）不碰文件，可单测。
//
// 交付档位（docs/decisions/2026-11-10-industrial-baseline.md D07；P05 的 engine/production/profiles.json 落地后改读那里）
//   PROFILES[名] = { width, height, fps, video: { codec, profile, level, pixFmt, crf, maxrate, bufsize },
//                    color: { primaries, transfer, matrix, range }, audio: { rate, channels, kbps, lufs, tol, tpMax }, web: bool }
//   resolveProfile(spec, override) → { name, source, ...档位 }   film.json 指定 > 命令行 --profile > 按尺寸与帧率推断；
//                                   都对不上时用 web 档的色彩与声音规格、作品自己的尺寸帧率（custom-<宽>x<高>p<fps>），并给出提示
//   checkProfileFit(spec, p)       作品尺寸 / 帧率与档位不符 → 返回问题列表（入口按契约不通过处理，exit 4）
// 响度（ITU-R BS.1770 / EBU R128，FFmpeg ebur128 滤镜）
//   loudnessArgs(file) / parseEbur128(stderr) → { I, LRA, TP, maxM, maxS }   积分响度、响度范围、真峰值、最大瞬时 / 短期响度
//   planGain(measured, audio)      → { gainDb, expectedI, expectedTP, limitedByPeak, ok, reason }
//                                   线性增益（volume 滤镜，不做动态处理）：先对准目标响度，真峰值留 0.5 dB 给 AAC 编码余量
//   judgeLoudness(m, audio)        成片复测：积分响度在目标 ± 容差内、真峰值不高于上限 → { ok, problems }
// 编码参数（不经 sh / mux.sh，Windows PowerShell 直接可用）
//   metadataArgs({ title, aigc, producer, produceId })  成片元数据：title；film.json 的 aigc.contains 为真时按仓库统一写法写隐式标识
//                                   （tools/compliance/lib/aigc.mjs 的 ffmpegMetadataArgs：comment = AIGC{…} 含 AI 生成画面，
//                                   GB 45438 文件元数据写法，决定 D11；显式标识写在作品说明与 player.html 里）
//   masterArgs({ video, pcm, gainDb, out, audio, meta })   母版：原生视频轨逐位复制 + 混音 PCM 增益后编 AAC
//   webArgs({ master, pcm, gainDb, out, p, sourceColor, meta })   网页版：由母版视频编 H.264 High、yuv420p、BT.709 有限范围并写全
//                                   四个色彩标签、GOP = 2 秒、faststart；声音从 PCM 直接编（不做 AAC 转 AAC）
//   colorFilter(sourceColor)       母版已是 BT.709 tv 时不做转换；是全范围 / BT.601 时用 colorspace 滤镜一次转到 BT.709 tv
//                                   （4:2:0 上比 scale 单步更准，见 routes/directing/craft/video.md §4.5）
import { EXPLICIT, ffmpegMetadataArgs } from '../../tools/compliance/lib/aigc.mjs';

export const PROFILES = Object.freeze({
  'web-1080p24': { width: 1920, height: 1080, fps: 24, web: true },
  'master-1080p24': { width: 1920, height: 1080, fps: 24, web: false },
  'uhd-2160p24': { width: 3840, height: 2160, fps: 24, web: true },
  'vertical-1080x1920-30': { width: 1080, height: 1920, fps: 30, web: true },
  'broadcast-1080p25': { width: 1920, height: 1080, fps: 25, web: true, audio: { lufs: -23, tol: 0.5, tpMax: -1.0 } },
  'beiming-1040p24': { width: 1920, height: 1040, fps: 24, web: true },
});
const BASE = {
  video: { codec: 'libx264', profile: 'high', pixFmt: 'yuv420p', preset: 'slow', crf: 18 },
  color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
  audio: { rate: 48000, channels: 2, kbps: 192, masterKbps: 320, lufs: -14, tol: 1.0, tpMax: -1.0 },
};

// H.264 Level 按宏块吞吐挑；码率上限按画面大小
function videoFor(width, height, fps) {
  const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  const level = mbps <= 245760 ? '4.1' : mbps <= 522240 ? '5.1' : '5.2';
  const big = width * height > 2560 * 1440;
  return { ...BASE.video, level, maxrate: big ? '60M' : '20M', bufsize: big ? '120M' : '40M', gop: 2 * fps, keyintMin: fps };
}

export function profileByName(name, { width, height, fps } = {}) {
  const p = PROFILES[name];
  if (!p) return null;
  return { name, width: p.width, height: p.height, fps: p.fps, web: p.web, video: videoFor(p.width, p.height, p.fps), color: { ...BASE.color }, audio: { ...BASE.audio, ...(p.audio || {}) } };
}

export function resolveProfile(spec, override) {
  const want = override || spec.profile;
  if (want) {
    const p = profileByName(want);
    if (!p) return { error: `未知的交付档位 ${want}`, hint: `可用：${Object.keys(PROFILES).join('、')}` };
    return { ...p, source: override ? '--profile' : spec.profileSource || 'film.json' };
  }
  for (const name of Object.keys(PROFILES)) {
    const p = PROFILES[name];
    if (p.web && p.width === spec.width && p.height === spec.height && p.fps === spec.fps) return { ...profileByName(name), source: '按尺寸与帧率推断' };
  }
  return {
    name: `custom-${spec.width}x${spec.height}p${spec.fps}`, width: spec.width, height: spec.height, fps: spec.fps, web: true,
    video: videoFor(spec.width, spec.height, spec.fps), color: { ...BASE.color }, audio: { ...BASE.audio }, source: '自定义（沿用 web-1080p24 的色彩与声音规格）',
    note: '作品尺寸 / 帧率不属于任何标准档位；要交付标准档就改 film.json 的 size / fps，或写明 output.profile',
  };
}

export function checkProfileFit(spec, p) {
  const problems = [];
  if (p.width !== spec.width || p.height !== spec.height) problems.push(`画面 ${spec.width}×${spec.height} 与档位 ${p.name} 的 ${p.width}×${p.height} 不符`);
  if (p.fps !== spec.fps) problems.push(`帧率 ${spec.fps} 与档位 ${p.name} 的 ${p.fps} 不符`);
  return problems;
}

// 作品自己的声音目标（v2 audio 段）覆盖档位默认
export function audioTarget(p, specAudio = {}) {
  const a = { ...p.audio };
  if (typeof specAudio.targetLUFS === 'number') a.lufs = specAudio.targetLUFS;
  if (typeof specAudio.truePeakDbTP === 'number') a.tpMax = specAudio.truePeakDbTP;
  return a;
}

export const loudnessArgs = file => ['-hide_banner', '-nostats', '-v', 'verbose', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'];

export function parseEbur128(text) {
  const tail = text.slice(text.lastIndexOf('Summary:'));
  const num = re => { const m = re.exec(tail); return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN; };
  const out = { I: num(/\bI:\s+(-?[\d.]+|-inf)\s+LUFS/), LRA: num(/\bLRA:\s+(-?[\d.]+)\s+LU\b/), TP: num(/\bPeak:\s+(-?[\d.]+|-inf)\s+dBFS/), maxM: -Infinity, maxS: -Infinity };
  for (const m of text.matchAll(/\bM:\s*(-?[\d.]+)\s+S:\s*(-?[\d.]+)/g)) { out.maxM = Math.max(out.maxM, +m[1]); out.maxS = Math.max(out.maxS, +m[2]); }
  if (!Number.isFinite(out.I) && out.I !== -Infinity) throw new Error('ebur128 没有输出积分响度（输入里没有可测的音轨？）');
  return out;
}

export function planGain(m, a, headroom = 0.5) {
  if (m.I === -Infinity || !Number.isFinite(m.I)) return { gainDb: 0, expectedI: m.I, expectedTP: m.TP, limitedByPeak: false, ok: false, reason: '混音是静音或测不出积分响度' };
  let gainDb = a.lufs - m.I, limitedByPeak = false;
  if (m.TP + gainDb > a.tpMax - headroom) { gainDb = a.tpMax - headroom - m.TP; limitedByPeak = true; }
  const expectedI = m.I + gainDb, expectedTP = m.TP + gainDb;
  const ok = Math.abs(expectedI - a.lufs) <= a.tol;
  return {
    gainDb: Math.round(gainDb * 100) / 100, expectedI, expectedTP, limitedByPeak, ok,
    reason: ok ? '' : `混音峰值太高：把响度推到 ${a.lufs} LUFS 会让真峰值超过 ${a.tpMax} dBTP，按峰值限住后只有 ${expectedI.toFixed(1)} LUFS`,
  };
}

export function judgeLoudness(m, a) {
  const problems = [];
  if (!(Math.abs(m.I - a.lufs) <= a.tol)) problems.push(`积分响度 ${m.I} LUFS 不在 ${a.lufs}±${a.tol} 内`);
  if (!(m.TP <= a.tpMax)) problems.push(`真峰值 ${m.TP} dBTP 高于 ${a.tpMax}`);
  return { ok: problems.length === 0, problems };
}

const volume = gainDb => `volume=${gainDb.toFixed(2)}dB`;

export const AIGC_LABEL = EXPLICIT.visual;
export function metadataArgs({ title, aigc, producer = '北冥引擎（北冥原生 · BNE）', produceId } = {}) {
  const m = [];
  if (title) m.push('-metadata', `title=${title}`);
  if (aigc?.contains) m.push(...ffmpegMetadataArgs({ producer, produceId: produceId || title || 'film', kinds: Array.isArray(aigc.kinds) && aigc.kinds.length ? aigc.kinds : ['visual'] }));
  return m;
}

export function masterArgs({ video, pcm, gainDb, out, audio, durSeconds, meta = [] }) {
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', video];
  if (pcm) a.push('-i', pcm, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', `${volume(gainDb)},aresample=${audio.rate}`,
    '-ac', String(audio.channels), '-c:a', 'aac', '-b:a', `${audio.masterKbps}k`, '-t', String(durSeconds));
  else a.push('-map', '0:v:0', '-c:v', 'copy');
  a.push(...meta, '-movflags', '+faststart', '-f', 'mp4', out);
  return a;
}

export function colorFilter(src = {}) {
  const is709tv = src.color_space === 'bt709' && src.color_range === 'tv' && src.color_primaries === 'bt709';
  if (is709tv) return { filter: null, note: '母版已是 BT.709 有限范围，视频像素不做色彩转换' };
  const ispace = src.color_space === 'bt709' ? 'bt709' : 'bt470bg';
  const irange = src.color_range === 'pc' ? 'pc' : 'tv';
  return {
    filter: `colorspace=space=bt709:ispace=${ispace}:range=tv:irange=${irange}:primaries=bt709:iprimaries=bt709:trc=bt709:itrc=bt709`,
    note: `母版色彩标签为 ${src.color_space || '未标'} / ${src.color_range || '未标'}，按 ${ispace} / ${irange} 解读后转到 BT.709 有限范围`,
  };
}

export function webArgs({ master, pcm, gainDb, out, p, audio, sourceColor, durSeconds, meta = [] }) {
  const v = p.video, c = p.color;
  const cf = colorFilter(sourceColor);
  const vf = [cf.filter, `format=${v.pixFmt}`].filter(Boolean).join(',');
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', master];
  // 输入都放在前面（ffmpeg 的输入选项必须紧贴各自的 -i）；无声作品补一条静音立体声，交付件始终有音轨
  if (pcm) a.push('-i', pcm);
  else a.push('-f', 'lavfi', '-t', String(durSeconds), '-i', `anullsrc=r=${audio.rate}:cl=stereo`);
  a.push('-map', '0:v:0', '-map', '1:a:0', '-vf', vf, '-c:v', v.codec, '-preset', v.preset, '-crf', String(v.crf), '-profile:v', v.profile, '-level:v', v.level,
    '-maxrate', v.maxrate, '-bufsize', v.bufsize, '-g', String(v.gop), '-keyint_min', String(v.keyintMin), '-pix_fmt', v.pixFmt,
    '-color_primaries', c.primaries, '-color_trc', c.transfer, '-colorspace', c.matrix, '-color_range', c.range);
  if (pcm) a.push('-af', `${volume(gainDb)},aresample=${audio.rate}`);
  a.push('-ac', String(audio.channels), '-ar', String(audio.rate), '-c:a', 'aac', '-b:a', `${audio.kbps}k`, '-t', String(durSeconds), ...meta, '-movflags', '+faststart', '-f', 'mp4', out);
  return { args: a, colorNote: cf.note };
}

// ffprobe 结果 → run.json 的 output 段（数字存数值，不存字符串）
export function describeVideo(probe) {
  const v = probe.streams?.find(s => s.codec_type === 'video') || {};
  const s = probe.streams?.find(x => x.codec_type === 'audio') || null;
  const [n, d] = String(v.r_frame_rate || '0/1').split('/').map(Number);
  return {
    width: v.width, height: v.height, fps: d ? n / d : null, frames: Number(v.nb_read_frames ?? v.nb_frames ?? NaN),
    codec: v.codec_name, profile: v.profile, level: v.level, pixFmt: v.pix_fmt,
    color: { primaries: v.color_primaries ?? null, transfer: v.color_transfer ?? null, matrix: v.color_space ?? null, range: v.color_range ?? null },
    audio: s ? { codec: s.codec_name, rate: Number(s.sample_rate), channels: s.channels } : null,
    duration: Number(probe.format?.duration), bytes: Number(probe.format?.size),
  };
}

export const probeArgs = file => ['-v', 'error', '-count_frames', '-show_entries',
  'stream=codec_type,codec_name,profile,level,width,height,r_frame_rate,nb_read_frames,pix_fmt,color_range,color_space,color_transfer,color_primaries,sample_rate,channels:format=duration,size',
  '-of', 'json', file];

// 成片规格核对：尺寸、帧率、帧数、时长、音轨、色彩标签（网页版还要求 BT.709 tv 与 yuv420p）
export function judgeVideo(d, { width, height, fps, frames, dur }, { web = false, audio = true, p } = {}) {
  const problems = [];
  if (d.width !== width || d.height !== height) problems.push(`尺寸 ${d.width}×${d.height}，应为 ${width}×${height}`);
  if (Math.abs((d.fps ?? 0) - fps) > 1e-6) problems.push(`帧率 ${d.fps}，应为 ${fps}`);
  if (d.frames !== frames) problems.push(`完整解码 ${d.frames} 帧，应为 ${frames}`);
  if (!(Math.abs(d.duration - dur) <= 0.5 / fps + 0.03)) problems.push(`时长 ${d.duration} 秒，应为 ${dur}`);
  if (audio && !(d.audio?.codec === 'aac')) problems.push('缺 AAC 音轨');
  if (web) {
    if (d.pixFmt !== p.video.pixFmt) problems.push(`像素格式 ${d.pixFmt}，应为 ${p.video.pixFmt}`);
    for (const [k, want] of Object.entries(p.color)) if (d.color[k] !== want) problems.push(`色彩 ${k} = ${d.color[k] ?? '未标'}，应为 ${want}`);
    if (audio && (d.audio?.rate !== p.audio.rate || d.audio?.channels !== p.audio.channels)) problems.push(`音频 ${d.audio?.rate} Hz / ${d.audio?.channels} 声道，应为 ${p.audio.rate} Hz 立体声`);
  }
  return problems;
}
