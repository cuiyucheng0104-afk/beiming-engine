#!/usr/bin/env node
// 北冥引擎 · 音画封装（Node 实现，三个平台都不需要 sh；engine/render/mux.sh 是调用它的兼容壳）
//   node engine/render/lib/mux.mjs <video.mp4> <mix.wav | -> <out.mp4> [fps] [grain]
//        [--frames N] [--profile web-1080p24] [--film films/x] [--aigc visual,voice] [--aigc-tool 名字] [--json]   完整选项：--help
//
// 响度：用 ebur128（与最后核对用的是同一把尺，BS.1770）测积分响度和真峰值，整段乘同一个增益到目标（默认 −14 LUFS），不压动态。
//   编成 AAC 后真峰值仍高于（上限 − 0.2）dBTP 时，才在 4 倍过采样上用前瞻限幅器削掉超出的峰，再测一次把积分响度补回目标。
//   不用 loudnorm：短片上它的第一遍会把片尾约 3 秒重复计入（《北冥》的 mix.wav 测偏响约 0.9 LU，成片只有 −14.9），
//   响度范围大于目标、或线性增益后峰值放不下时，它还会悄悄退回动态压缩。
// 时长：音频按画面时长（帧数 ÷ 帧率）补静音或截断，不用 -shortest（音频短几毫秒就会丢掉最后一帧）。
// 帧率与帧数：不传 fps 就用输入视频的帧率；传了但与输入不一致、或 --frames 与输入帧数不一致，直接失败（退出码 4）——
//   不用 fps 滤镜“修正”，那会静默丢帧或重复帧。重编码时也按输入的帧原样编（-fps_mode passthrough）。
// 色彩：grain = 0 且输入已是完整标记的有限范围 BT.709（video.mjs 的产物）时，画面直接拷贝，不重新编码（不叠第二代有损）。
//   其他输入换算成有限范围 BT.709 并写明标记：原色与传递特性按输入的标记保留，没有标记写 bt709；YUV 输入有范围标记按标记，
//   没有按 H.264 默认的有限范围；矩阵 bt709、bt470bg、smpte170m、fcc、smpte240m、bt2020nc 按标记换算，没有矩阵标记按 BT.601；
//   RGB 输入（rgb / bgr / gbr…）直接换算。swscale 换算不了的矩阵（bt2020c、ycgco、ictcp 等）不换算，原样编码并保留标记。
// grain > 0 时在封装阶段再叠一层胶片颗粒（北冥的颗粒已在页面里画好，默认 0）。
// AIGC 隐式标识（决定 D11，docs/rights/aigc.md）：作品声明含 AI 生成内容时（--film 读 film.json 的 aigc.contains，或 --aigc
//   直接给出类别），用 tools/compliance/lib/aigc.mjs 的 ffmpegMetadataArgs 写进 mp4 的 comment 元数据：AIGC{…} 加一句人读说明；
//   ProduceID 是 <作品 id>@<运行号>（--produce-id 可指定）。不含（contains=false、--aigc none、两者都没写）就不写。
// 输出先写 <输出目录>/.<名>.partial-<pid>.mp4，核对通过才改名；失败不留半成品。最后核对：帧数与输入一致、
//   |I − 目标| ≤ 0.5 LU、真峰值 ≤ 上限（默认 −1.0 dBTP，D07）。
// 退出码：0 成功 · 2 用法 · 3 缺 FFmpeg · 4 输入不合规（帧率、帧数、静音、读不出）或成片响度 / 帧数不达标 · 1 FFmpeg 出错。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, runCli } from '../../../tools/lib/cli.mjs';
import { ffmpegMetadataArgs, EXPLICIT } from '../../../tools/compliance/lib/aigc.mjs';
import { RenderError } from './errors.mjs';
import { renderCommand, positiveNumber } from './command.mjs';
import { preflight, FFMPEG, run, must, probe } from './ffmpeg.mjs';
import { resolveProfile } from './profiles.mjs';
import { sha256File, repoPath, environment, runId as makeRunId } from './record.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** 隐式标识里的制作方（法律主体待补，docs/rights/register.md R12；与 tools/compliance/aigc.mjs 的默认值相同） */
export const AIGC_PRODUCER = '北冥引擎 Beiming Engine';
const KINDS = Object.keys(EXPLICIT);

// ebur128 摘要里取某一项（与 mux.sh 的 awk 相同：取最后一次出现的“键 值”）
export function field(text, key) {
  let v = null;
  for (const line of String(text).split('\n')) { const t = line.trim().split(/\s+/); if (t[0] === key) v = t[1]; }
  return v;
}
const fix2 = x => x.toFixed(2);
async function measure(file, signal) {
  const r = await run(FFMPEG(), ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { signal });
  if (r.code !== 0) throw new RenderError('contract.loudness-measure', `测响度失败：${file}`, { hint: '文件读不出声音：检查混音是否完整' });
  return { I: field(r.stderr, 'I:'), LRA: field(r.stderr, 'LRA:'), Peak: field(r.stderr, 'Peak:') };
}

/** 封装：返回 { out, video{…}, loudness{…}, comment }；metadata 是要原样拼进 ffmpeg 的 -metadata 参数（AIGC 标识，见 aigcMetadata） */
export async function mux({ video, audio, out, fps = null, frames = null, grain = 0, target = -14, tolerance = 0.5, truePeak = -1.0, metadata = [], signal, log }) {
  const LIM = 0.81, AIM = truePeak - 0.2;   // 限幅线 0.81 ≈ −1.8 dBFS，给 AAC 编码留余量；触发限幅的线比上限再低 0.2 dB
  if (!fs.existsSync(video)) throw new RenderError('usage.input-missing', `找不到画面文件：${video}`, { hint: '先用 node engine/render/video.mjs 出无声视频' });
  if (audio !== null && !fs.existsSync(audio)) throw new RenderError('usage.input-missing', `找不到声音文件：${audio}`, { hint: '无声片把音频写成 -' });
  const v = (await probe(video, { signal })).video;
  if (!v) throw new RenderError('contract.no-video', `${video} 里没有画面`, { hint: '第一个参数要是视频文件' });
  const RATE = v.rate, VFPS = v.fps, NF = v.frames;
  if (!(VFPS > 0)) throw new RenderError('contract.input-fps', `读不出画面帧率：${video}（r_frame_rate=${RATE}）`, { hint: '重新生成画面文件' });
  if (!(Number.isInteger(NF) && NF > 0)) throw new RenderError('contract.input-frames', `数不出画面帧数：${video}`, { hint: '重新生成画面文件' });
  if (fps !== null && Math.abs(fps - VFPS) >= 0.001) {
    throw new RenderError('contract.input-fps-mismatch', `期望 ${fps} fps，输入视频是 ${RATE}（${NF} 帧）：不能用 fps 滤镜“修正”，那会静默丢帧或重复帧`, {
      hint: '按正确的帧率重渲画面（video.mjs --fps / --profile），或去掉期望帧率按输入封装',
    });
  }
  if (frames !== null && frames !== NF) {
    throw new RenderError('contract.input-frames-mismatch', `期望 ${frames} 帧，输入视频是 ${NF} 帧（${RATE} fps）`, { hint: '画面帧数要等于 film.json 的 frameCount：重渲画面' });
  }
  if (Math.abs(v.avgFps - VFPS) > 0.001 * VFPS) {
    throw new RenderError('contract.input-vfr', `输入视频不是恒定帧率（r_frame_rate ${RATE}，平均 ${v.avgFps.toFixed(3)} fps）`, { hint: '时间戳不均匀：重渲画面，不要拼接帧率不同的片段' });
  }
  const VD = (NF / VFPS).toFixed(6);
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-mux-'));
  const partial = path.join(path.dirname(out), `.${path.basename(out, path.extname(out))}.partial-${process.pid}.mp4`);
  try {
    // 声音：对齐到画面时长（48 kHz，补静音或截断），之后的测量和增益都针对成片里真正出现的那段
    let loud = null, G = null, LIMITED = false, I0 = null, P0 = null;
    if (audio !== null) {
      await must(FFMPEG(), ['-y', '-loglevel', 'error', '-i', audio, '-vn', '-af', `aresample=48000,apad=whole_dur=${VD},atrim=end=${VD}`, '-c:a', 'pcm_f32le', path.join(T, 'a0.wav')], '对齐声音', { signal });
      const m0 = await measure(path.join(T, 'a0.wav'), signal);
      I0 = m0.I; P0 = m0.Peak;
      if (I0 === null || P0 === null) throw new RenderError('contract.loudness-measure', `测不出响度：${audio}`, { hint: '文件读不出声音：检查混音是否完整' });
      if (!(Number(I0) > -69)) throw new RenderError('contract.audio-silent', `音频几乎是静音（${I0} LUFS），测不出可用的响度：${audio}`, { hint: '检查混音是否真的出了声；无声片把音频写成 -' });
      const enc = filter => must(FFMPEG(), ['-y', '-loglevel', 'error', '-i', path.join(T, 'a0.wav'), '-af', filter, '-c:a', 'aac', '-b:a', '256k', path.join(T, 'a.m4a')], '编 AAC', { signal });
      const lim = g => `volume=${g}dB,aresample=192000,alimiter=limit=${LIM}:attack=1:release=60:level=0:latency=1,aresample=48000`;
      G = fix2(target - Number(I0));
      await enc(`volume=${G}dB`);
      const P1 = (await measure(path.join(T, 'a.m4a'), signal)).Peak;
      if (Number(P1) > AIM) {
        // 线性增益后 AAC 的真峰值放不下：过采样限幅。限幅会带走响度，按测得的差值补增益重做，直到落在 ±0.1 LU 内，最多 5 次
        LIMITED = true;
        for (let n = 1; ; n++) {
          await enc(lim(G));
          const I2 = Number((await measure(path.join(T, 'a.m4a'), signal)).I);
          if (Math.abs(I2 - target) <= 0.1 || n >= 5) break;
          G = fix2(Number(G) + target - I2);
        }
      }
      loud = { I0, P0, gain: G, limited: LIMITED };
    }

    // 色彩（见开头说明）
    const PF = v.pixFmt, R = v.color.range, CS = v.color.space;
    let PRI = v.color.primaries, TRC = v.color.transfer;
    const PRI0 = PRI, TRC0 = TRC;
    const INR = R === 'pc' ? 'full' : ['tv', 'unknown', 'unspecified', ''].includes(R) ? 'limited' : null;
    if (!INR) throw new RenderError('contract.input-color', `不认识的输入色彩范围：${R}`, { hint: '输入要是有限范围（tv）或全范围（pc）的 YUV / RGB' });
    const isRgb = /^(rgb|bgr|gbr|argb|abgr|0rgb|0bgr|x2rgb|x2bgr)/.test(PF);
    const INM = isRgb ? 'rgb' : CS === 'bt709' ? 'bt709' : /^(bt470bg|smpte170m|unknown|unspecified|reserved.*|)$/.test(CS) ? 'bt601'
      : CS === 'fcc' ? 'fcc' : CS === 'smpte240m' ? 'smpte240m' : ['bt2020nc', 'bt2020_ncl'].includes(CS) ? 'bt2020' : 'keep';
    if (/^(unknown|unspecified|reserved.*|)$/.test(PRI)) PRI = 'bt709';
    else if (!['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'film', 'bt2020', 'smpte428', 'smpte431', 'smpte432', 'jedec-p22', 'ebu3213'].includes(PRI)) throw new RenderError('contract.input-color', `不认识的输入原色标记：${PRI}`, { hint: '按 BT.709 重新生成画面' });
    if (/^(unknown|unspecified|reserved.*|)$/.test(TRC)) TRC = 'bt709';
    else if (!['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'linear', 'log100', 'log316', 'iec61966-2-4', 'bt1361e', 'iec61966-2-1', 'bt2020-10', 'bt2020-12', 'smpte2084', 'smpte428', 'arib-std-b67'].includes(TRC)) throw new RenderError('contract.input-color', `不认识的输入传递特性标记：${TRC}`, { hint: '按 BT.709 重新生成画面' });
    const ETRC = TRC === 'bt470m' ? 'gamma22' : TRC === 'bt470bg' ? 'gamma28' : TRC;
    const GRAIN = Number(grain) ? `,noise=c0s=${grain}:allf=t` : '';
    const SWS = 'out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int';
    const TAG = `setparams=range=tv:color_primaries=${PRI}:color_trc=${TRC}:colorspace=bt709`;
    let VF, ENCTAGS, COLOR;
    if (INM === 'keep') {
      log?.warn(`输入矩阵 ${CS} 用 swscale 换算不了：画面不换算，按原矩阵与输入标记原样编码（输出不是 BT.709）`, 'color-keep');
      VF = `format=yuv420p${GRAIN}`; ENCTAGS = []; COLOR = `按输入原样（矩阵 ${CS}，未换算）`;
      if (GRAIN) VF = `null${GRAIN},format=yuv420p`;
    } else if (INM === 'rgb') {
      VF = `scale=${SWS},format=yuv420p${GRAIN},${TAG}`; ENCTAGS = ['-colorspace', 'bt709', '-color_primaries', PRI, '-color_trc', ETRC, '-color_range', 'tv'];
      COLOR = `有限范围 BT.709（由 RGB 换算；原色 ${PRI}、传递特性 ${TRC}）`;
    } else {
      VF = `${GRAIN ? `null${GRAIN},` : ''}scale=in_range=${INR}:in_color_matrix=${INM}:${SWS},format=yuv420p,${TAG}`;
      ENCTAGS = ['-colorspace', 'bt709', '-color_primaries', PRI, '-color_trc', ETRC, '-color_range', 'tv'];
      COLOR = `有限范围 BT.709（输入 ${CS || '无矩阵标记'}/${R || '无范围标记'}；原色 ${PRI}、传递特性 ${TRC}）`;
    }
    const COPY = !Number(grain) && PF === 'yuv420p' && R === 'tv' && CS === 'bt709' && PRI0 === 'bt709' && TRC0 === 'bt709';
    if (COPY) COLOR = '有限范围 BT.709（输入已完整标记，画面直接拷贝，未重新编码）';

    const meta = Array.isArray(metadata) ? metadata : [];
    const comment = meta.length ? meta[1].replace(/^comment=/, '') : null;
    const aIn = audio !== null ? ['-i', path.join(T, 'a.m4a')] : [];
    const aMap = audio !== null ? ['-map', '1:a:0', '-c:a', 'copy'] : [];
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    if (COPY) {
      await must(FFMPEG(), ['-y', '-loglevel', 'error', '-i', video, ...aIn, '-map', '0:v:0', ...(audio !== null ? ['-map', '1:a:0'] : []), '-c:v', 'copy', '-frames:v', String(NF),
        ...(audio !== null ? ['-c:a', 'copy'] : []), ...meta, '-movflags', '+faststart', partial], '封装', { signal });
    } else {
      await must(FFMPEG(), ['-y', '-loglevel', 'error', '-i', video, ...aIn, '-filter_complex', `[0:v]${VF}[v]`, '-map', '[v]', ...aMap.slice(0, 2),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-fps_mode', 'passthrough', '-frames:v', String(NF), ...ENCTAGS,
        ...aMap.slice(2), ...meta, '-movflags', '+faststart', partial], '封装（重编码画面）', { signal });
    }

    // 核对成片
    const o = await probe(partial, { signal });
    const NO = o.video?.frames;
    const result = { video: { ...o.video, frames: NO, inputFrames: NF, rate: RATE, seconds: Number(VD), colorNote: COLOR, copied: COPY }, loudness: null, comment };
    if (audio !== null) {
      const mo = await measure(partial, signal);
      result.loudness = { ...loud, I: mo.I, LRA: mo.LRA, truePeak: mo.Peak, target, tolerance, truePeakMax: truePeak };
    }
    log?.info(`${out}\n  画面：${NO} 帧（输入 ${NF} 帧，${RATE} fps，${VD} 秒），${COLOR}`
      + (result.loudness ? `\n  响度：原 ${I0} LUFS、真峰值 ${P0} dBTP → 整段增益 ${G} dB${LIMITED ? '；线性增益后 AAC 峰值超限，加了 4 倍过采样限幅' : ''}`
        + `\n    I:    ${result.loudness.I} LUFS\n    LRA:  ${result.loudness.LRA} LU\n    Peak: ${result.loudness.truePeak} dBFS` : '\n  声音：无（无声片）')
      + (comment ? `\n  comment：${comment}` : ''));
    if (NO !== NF) throw new RenderError('contract.output-frames', `成片 ${NO} 帧，与输入画面 ${NF} 帧不一致：${out}`, { hint: '封装丢帧或补帧：带上日志报告' });
    if (result.loudness) {
      const I = Number(result.loudness.I), P = Number(result.loudness.truePeak);
      if (!(Math.abs(I - target) <= tolerance && P <= truePeak)) {
        throw new RenderError('contract.loudness', `成片响度不达标：I=${result.loudness.I} LUFS（目标 ${target}±${tolerance}）、真峰值 ${result.loudness.truePeak} dBTP（上限 ${truePeak}）：${out}`, {
          hint: '混音的峰值余量不够：回到混音阶段把真峰值压到 −1.5～−2 dBTP 再封装',
        });
      }
    }
    fs.renameSync(partial, out);
    return { out, ...result };
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
    fs.rmSync(partial, { force: true });
  }
}

/** 读作品描述（目录或 film.json）：只取 id 与 aigc；读不了 → usage.film-json */
function readFilmJson(p) {
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'film.json') : p;
  try { return { file, json: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) {
    throw new RenderError('usage.film-json', `读不了作品描述 ${file}：${e.code === 'ENOENT' ? '文件不存在' : e.message}`, { hint: '--film 写作品目录（films/<名字>）或它的 film.json' });
  }
}

/**
 * AIGC 隐式标识的 ffmpeg 参数（D11）：返回 { args, comment, kinds, tools, produceId }；不含 AI 生成内容时 args 为空。
 *   kinds：--aigc 给出的类别（visual / voice / music；none 表示不含）优先，其次 film.json 的 aigc.kinds，再默认 visual
 *   film：film.json 的内容（取 aigc.contains、aigc.kinds、aigc.tools 与 id）
 */
export function aigcMetadata({ film = null, kinds = [], tools = [], produceId = null, runId = null, producer = AIGC_PRODUCER } = {}) {
  const bad = kinds.filter(k => k !== 'none' && !KINDS.includes(k));
  if (bad.length) throw new RenderError('usage.bad-value', `--aigc 只能取 ${[...KINDS, 'none'].join(' / ')}（收到 ${bad.join('、')}）`, { hint: '例：--aigc visual,voice；不含 AI 生成内容写 --aigc none' });
  if (kinds.includes('none') && kinds.length > 1) throw new RenderError('usage.bad-value', '--aigc none 不能与别的类别同时写', { hint: '去掉 none，或只写 none' });
  const declared = film?.aigc && typeof film.aigc === 'object' ? film.aigc : null;
  const contains = kinds.length ? !kinds.includes('none') : declared?.contains === true;
  if (!contains) return { args: [], comment: null, kinds: [], tools: [], produceId: null };
  const k = kinds.length ? kinds : (Array.isArray(declared?.kinds) && declared.kinds.length ? declared.kinds.filter(x => KINDS.includes(x)) : []);
  const t = tools.length ? tools : (Array.isArray(declared?.tools) ? declared.tools.map(String) : []);
  const id = produceId ?? `${typeof film?.id === 'string' && film.id ? film.id : 'beiming'}@${runId ?? 'norun'}`;
  const finalKinds = k.length ? k : ['visual'];
  const args = ffmpegMetadataArgs({ producer, produceId: id, kinds: finalKinds, tools: t });
  return { args, comment: args[1].slice('comment='.length), kinds: finalKinds, tools: t, produceId: id };
}

export const command = renderCommand({
  name: 'engine/render/lib/mux.mjs',
  summary: '把无声视频与混音封装成成片：响度按 BS.1770 实测线性归一到目标，画面能拷贝就拷贝；音频写 - 表示无声片',
  usage: ['node engine/render/lib/mux.mjs <video.mp4> <mix.wav | -> <out.mp4> [fps] [grain] [选项]'],
  positionals: [
    { name: 'video', label: '<video.mp4>', describe: '无声视频（video.mjs 的产物）' },
    { name: 'audio', label: '<mix.wav | ->', describe: '混音；写 - 表示无声片' },
    { name: 'out', label: '<out.mp4>', describe: '成片' },
    { name: 'fpsArg', label: '[fps]', describe: '期望帧率（与 --fps 相同；兼容 mux.sh 的写法）', required: false },
    { name: 'grainArg', label: '[grain]', describe: '颗粒强度（与 --grain 相同；默认 0，画面拷贝）', required: false },
  ],
  options: {
    fps: { type: 'number', arg: '<n>', describe: '期望的帧率：与输入不一致退出码 4' },
    frames: { type: 'integer', min: 1, arg: '<N>', describe: '期望的帧数：与输入不一致退出码 4' },
    grain: { type: 'number', min: 0, arg: '<强度>', describe: '封装时叠的颗粒（默认 0，画面拷贝不重编码）' },
    profile: { type: 'string', arg: '<档位>', describe: '响度目标取自交付档位（默认 −14 LUFS、真峰值 ≤ −1.0 dBTP）' },
    'target-lufs': { type: 'number', arg: '<LUFS>', describe: '积分响度目标（覆盖档位）' },
    'true-peak': { type: 'number', arg: '<dBTP>', describe: '真峰值上限（覆盖档位）' },
    film: { type: 'string', arg: '<作品目录|film.json>', describe: '从作品描述取 AIGC 声明（aigc.contains / kinds / tools）与作品 id' },
    aigc: { type: 'list', split: ',', arg: '<类别>', describe: `AIGC 类别：${KINDS.join(' / ')}，逗号分隔；none 表示不含（覆盖 film.json）` },
    'aigc-tool': { type: 'list', arg: '<名字>', describe: '生成工具（写进标识的人读说明，可重复；覆盖 film.json 的 aigc.tools）' },
    'produce-id': { type: 'string', arg: '<作品@运行号>', describe: '标识里的 ProduceID（默认 <作品 id>@<运行号>）' },
  },
  examples: [
    'node engine/render/lib/mux.mjs out/video.mp4 out/mix.wav out/beiming.mp4 24 0',
    'node engine/render/lib/mux.mjs films/x/out/video.mp4 films/x/out/mix.wav films/x/out/x.mp4 --frames 192 --film films/x',
    'node engine/render/lib/mux.mjs films/x/out/video.mp4 - films/x/out/x.mp4        无声片',
  ],
}, async ({ opts, args, log, signal }) => {
  const num = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new RenderError('usage.bad-value', `${label} 必须是非负数（收到「${v}」）`, { hint: '例：… out.mp4 24 0' });
    return n;
  };
  const fpsP = num(args.fpsArg, '第 4 个参数 fps'), grainP = num(args.grainArg, '第 5 个参数 grain');
  if (fpsP !== null && !(fpsP > 0)) throw new RenderError('usage.bad-value', `fps 必须大于 0（收到 ${args.fpsArg}）`);
  positiveNumber(opts.fps, '--fps');
  if (fpsP !== null && opts.fps !== null && fpsP !== opts.fps) throw new RenderError('usage.conflict', `位置参数 fps=${fpsP} 与 --fps ${opts.fps} 不一致`, { hint: '只写一处' });
  if (grainP !== null && opts.grain !== null && grainP !== opts.grain) throw new RenderError('usage.conflict', `位置参数 grain=${grainP} 与 --grain ${opts.grain} 不一致`, { hint: '只写一处' });
  const profile = opts.profile ? resolveProfile(opts.profile, REPO) : null;
  for (const m of profile?.warnings ?? []) log.warn(m, 'profiles', '档位表归作品描述包维护：engine/production/profiles.json');
  const film = opts.film ? readFilmJson(path.resolve(opts.film)).json : null;
  const ff = preflight();
  const env = environment(REPO, { ffmpegVersion: ff.version });
  const meta = aigcMetadata({ film, kinds: opts.aigc, tools: opts['aigc-tool'], produceId: opts['produce-id'], runId: makeRunId(env) });
  const target = opts['target-lufs'] ?? profile?.audio.targetLUFS ?? -14;
  const r = await mux({
    video: path.resolve(args.video), audio: args.audio === '-' ? null : path.resolve(args.audio), out: path.resolve(args.out),
    fps: opts.fps ?? fpsP ?? null, frames: opts.frames ?? null, grain: opts.grain ?? grainP ?? 0,
    target, tolerance: Math.min(0.5, profile?.audio.toleranceLU ?? 0.5), truePeak: opts['true-peak'] ?? profile?.audio.truePeakDbTP ?? -1.0,
    metadata: meta.args, signal, log,
  });
  const sha = await sha256File(r.out);
  return {
    outputs: [{ path: repoPath(REPO, r.out), sha256: sha, kind: 'master' }],
    data: { video: r.video, loudness: r.loudness, aigc: meta.comment ? { comment: meta.comment, kinds: meta.kinds, tools: meta.tools, produceId: meta.produceId } : null },
  };
});

if (isMain(import.meta.url)) await runCli(command);
