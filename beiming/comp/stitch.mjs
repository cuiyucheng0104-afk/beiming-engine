// 合成收尾第一段：按镜头的帧序列拼成一条硬切的视频滤镜图，按 colorRef 分流做显示变换，再挂收尾层（暗角、颗粒），
// 最后换成有限范围 BT.709 的 yuv420p。只拼参数、只起 ffmpeg，不读写别的组件的目录。
//
// 颜色口径：
//   scene   线性光（场景线性，Rec.709 原色）→ 以 mid 为中灰的 log2 整形，[minEv, maxEv] 线性映到 [0, 1] 并夹住 → lut3d（四面体插值）→ 显示编码
//   display 线性编码的显示参考值（0..1）→ sRGB 分段传递函数 → 显示编码；不过场景色调映射
//   帧文件是 PNG 且 transfer 是 srgb 时，像素已经是显示编码，display 分支直通；scene 镜头不收显示编码的帧
// 收尾层：暗角在显示编码的 RGB 上做（镜头角 = vignette × π/3 rad），颗粒在最终 yuv420p 的亮度平面上做（ffmpeg noise，固定种子、逐帧变化，
//   幅度 = round(grain × 100)，单位是 8 位码值的噪声强度；只加在亮度上，色度不动；种子用 all_seed，本机 FFmpeg 8 的 c0_seed 不生效）。grain、vignette 都是 0 时一个收尾滤镜都不挂，滤镜图等于分流加格式换算。
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { FFMPEG, FFPROBE } from '../../engine/render/lib/ffmpeg.mjs';

export class CompError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'CompError';
    this.code = code;
    this.hint = hint;
  }

  static toolTimeout(what, timeoutMs) {
    return new CompError('timeout.ffmpeg', `${what}：超过 ${timeoutMs} 毫秒没有结束，已终止`);
  }

  static toolUnavailable(bin, error, what = bin) {
    return new CompError('env.ffmpeg-missing', `${what}：无法运行 ${bin}（${error.code ?? error.message}）`, '装 FFmpeg ≥ 7，或设 FFMPEG / FFPROBE 为完整路径');
  }
}

export const bad = (message, hint = '') => new CompError('usage.bad-argument', message, hint);

export const tools = () => ({ ffmpeg: FFMPEG(), ffprobe: FFPROBE() });

const DEFAULT_TIMEOUT_MS = 600000;

/**
 * 起一个外部程序：参数数组直传，不经 shell，带超时，Windows 上不弹窗。
 * 返回 { stdout, stderr }（stdout 是 Buffer）；起不来、超时、非零退出都抛 CompError。
 */
export function runTool(bin, args, { cwd, input, timeoutMs = DEFAULT_TIMEOUT_MS, what = bin } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw bad('timeoutMs 必须是有限正整数');
  const r = spawnSync(bin, args, {
    cwd, input, shell: false, windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL',
    maxBuffer: 1 << 30, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const stderr = r.stderr ? r.stderr.toString('utf8') : '';
  if (r.error?.code === 'ETIMEDOUT') throw CompError.toolTimeout(what, timeoutMs);
  if (r.error) throw CompError.toolUnavailable(bin, r.error, what);
  if (r.status !== 0) throw new CompError('failure.ffmpeg', `${what}：${bin} 退出码 ${r.status ?? r.signal}：${stderr.trim().split('\n').slice(-3).join(' | ')}`);
  return { stdout: r.stdout ?? Buffer.alloc(0), stderr };
}

/** 帧率字符串 "num/den" → { num, den }；不合 T 契约写法的报错 */
export function parseFps(fps) {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(fps));
  if (!m) throw bad(`帧率要写成 "分子/分母"，给的是 ${JSON.stringify(fps)}`);
  return { num: Number(m[1]), den: Number(m[2]) };
}

/** 滤镜选项值的两级转义（先选项级 \ ' :，再滤镜图级 \ ' [ ] , ;），路径里有空格、冒号、逗号、引号都能原样传给 ffmpeg */
export function escapeFilterValue(value) {
  const level1 = String(value).replace(/[\\':]/g, (c) => `\\${c}`);
  return level1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

const num = (x) => {
  if (!Number.isFinite(x)) throw bad(`滤镜参数必须是有限数，给的是 ${x}`);
  return Number(x.toPrecision(12)).toString();
};

// sRGB 分段编码（IEC 61966-2-1），输入先夹到 [0, 1]
const SRGB = (c) => `if(lte(clip(${c}(X,Y),0,1),0.0031308),12.92*clip(${c}(X,Y),0,1),1.055*pow(clip(${c}(X,Y),0,1),1/2.4)-0.055)`;

/** display 分支：线性显示参考值 → sRGB 编码 */
export function displayEncodeFilter() {
  return `geq=r='${SRGB('r')}':g='${SRGB('g')}':b='${SRGB('b')}'`;
}

/** scene 分支的对数整形：y = clip((log2(max(x, ε) / mid) − minEv) / (maxEv − minEv), 0, 1)；ε = mid·2^(minEv−1) 防 log(0) */
export function shaperFilter(shaper) {
  if (!shaper || typeof shaper !== 'object') throw bad('scene 镜头要显式给对数整形参数 shaper = { minEv, maxEv, mid }');
  const { minEv, maxEv, mid } = shaper;
  if (![minEv, maxEv, mid].every(Number.isFinite) || !(maxEv > minEv) || !(mid > 0)) {
    throw bad(`对数整形参数不合法：要求 maxEv > minEv、mid > 0，给的是 ${JSON.stringify(shaper)}`);
  }
  const eps = mid * 2 ** (minEv - 1);
  const ch = (c) => `clip((log(max(${c}(X,Y),${num(eps)})/${num(mid)})/log(2)-(${num(minEv)}))/${num(maxEv - minEv)},0,1)`;
  return `geq=r='${ch('r')}':g='${ch('g')}':b='${ch('b')}'`;
}

/** 对数整形的同一公式（JS 侧，给测试和报告算预期值） */
export function shaperValue(x, { minEv, maxEv, mid }) {
  const eps = mid * 2 ** (minEv - 1);
  return Math.min(1, Math.max(0, (Math.log2(Math.max(x, eps) / mid) - minEv) / (maxEv - minEv)));
}

/** 线性 → sRGB 编码（JS 侧，同上） */
export function srgbEncode(x) {
  const c = Math.min(1, Math.max(0, x));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** 显示编码 RGB（[0, 1]）→ 有限范围 BT.709 yuv420p 的唯一一次换算 */
export const TO_YUV709 = 'scale=out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p';

/** 收尾层参数 → 两段滤镜；强度都是 0 时两段都是 null */
export function finishFilters(finish = {}, seed = 0) {
  const grain = finish?.grain ?? 0;
  const vignette = finish?.vignette ?? 0;
  for (const [k, v] of [['grain', grain], ['vignette', vignette]]) {
    if (!Number.isFinite(v) || v < 0 || v > 1) throw bad(`style.finish.${k} 的值域是 [0, 1]，给的是 ${v}`);
  }
  if (!Number.isInteger(seed) || seed < 0) throw bad(`颗粒种子必须是非负整数，给的是 ${seed}`);
  const strength = Math.round(grain * 100);
  return {
    rgb: vignette > 0 ? `vignette=angle=${num(vignette * Math.PI / 3)}:mode=forward:eval=init:dither=0` : null,
    yuv: strength > 0 ? `noise=all_seed=${seed % 2147483647}:c0s=${strength}:c0f=t` : null,
  };
}

/** 帧序列里第 i 个文件的路径：pattern 里的 %d / %0Nd 换成 start + i */
export function framePath(pattern, index) {
  return pattern.replace(/%(0?)(\d*)d/, (_, zero, width) => String(index).padStart(width ? Number(width) : 0, zero ? '0' : ' '));
}

function sequenceKind(seq) {
  if (seq.kind) return seq.kind;
  if (/\.exr$/i.test(seq.pattern)) return 'exr';
  if (/\.png$/i.test(seq.pattern)) return 'png';
  throw bad(`认不出帧序列的格式：${seq.pattern}（只收 .exr、.png）`);
}

function normalizeOverlay({ id, in: from }, overlay, count, checkFiles) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) throw bad(`镜头 ${id} 的 overlay 必须是对象`);
  const { pattern, start = 0, kind = 'png', opacity = 1 } = overlay;
  if (kind !== 'png' || typeof pattern !== 'string' || !/\.png$/i.test(pattern)) throw bad(`镜头 ${id} 的 overlay 只收 PNG 序列`);
  const width = /^[^%]*%0([1-9]\d*)d[^%]*$/.exec(basename(pattern))?.[1];
  if (!width || Number(width) > 255 || pattern.includes('\0') || dirname(pattern).includes('%')) {
    throw bad(`镜头 ${id} 的 overlay 文件名需要一个有效的 %0Nd 占位符`);
  }
  // image2 用 int 保存帧编号。
  if (!Number.isInteger(start) || start < 0 || start + count - 1 > 2147483647) {
    throw bad(`镜头 ${id} 的 overlay 帧编号必须在 [0, 2147483647] 内`);
  }
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) throw bad(`镜头 ${id} 的 overlay.opacity 必须在 (0, 1]`);
  if (checkFiles) {
    for (let i = 0; i < count; i++) {
      const file = framePath(pattern, start + i);
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw bad(`镜头 ${id} 的 overlay 缺第 ${from + i} 帧的 PNG 文件：${file}`);
    }
  }
  return { pattern, start, kind, opacity };
}

/**
 * 校验并规范化一个镜头的帧序列描述。
 * shot：{ id, in, out, colorRef, pattern, start?, kind?, transfer?, overlay? }
 *   overlay：{ pattern, start?, kind?: 'png', opacity? }，显示编码的直通透明度 PNG。
 *   pattern 带 %0Nd；start 是第一个文件的编号（默认 0，镜头局部帧号）；kind 是 exr 或 png；
 *   transfer 是 linear 或 srgb（exr 默认 linear，png 默认 srgb）。
 */
export function normalizeShot(shot, { checkFiles = true } = {}) {
  if (!shot || typeof shot.id !== 'string') throw bad('镜头描述缺 id');
  if (!Number.isInteger(shot.in) || !Number.isInteger(shot.out) || shot.out <= shot.in || shot.in < 0) {
    throw bad(`镜头 ${shot.id} 的区间 [in, out) 不合法：[${shot.in}, ${shot.out})`);
  }
  if (shot.colorRef !== 'scene' && shot.colorRef !== 'display') throw bad(`镜头 ${shot.id} 的 colorRef 只能是 scene 或 display，给的是 ${shot.colorRef}`);
  if (typeof shot.pattern !== 'string' || !/%0?\d*d/.test(shot.pattern)) throw bad(`镜头 ${shot.id} 的帧序列 pattern 要带 %0Nd`);
  const kind = sequenceKind(shot);
  if (kind !== 'exr' && kind !== 'png') throw bad(`镜头 ${shot.id} 的帧格式只收 exr、png，给的是 ${kind}`);
  const transfer = shot.transfer ?? (kind === 'exr' ? 'linear' : 'srgb');
  if (transfer !== 'linear' && transfer !== 'srgb') throw bad(`镜头 ${shot.id} 的 transfer 只能是 linear 或 srgb`);
  if (shot.colorRef === 'scene' && transfer !== 'linear') throw bad(`场景参考镜头 ${shot.id} 的帧必须是线性光，给的是显示编码的帧`);
  const start = shot.start ?? 0;
  if (!Number.isInteger(start) || start < 0) throw bad(`镜头 ${shot.id} 的 start 必须是非负整数`);
  const count = shot.out - shot.in;
  if (checkFiles) {
    for (let i = 0; i < count; i++) {
      const p = framePath(shot.pattern, start + i);
      if (!existsSync(p)) throw bad(`镜头 ${shot.id} 缺第 ${shot.in + i} 帧（全片帧号）的文件：${p}`);
    }
  }
  const normalized = { id: shot.id, in: shot.in, out: shot.out, colorRef: shot.colorRef, pattern: shot.pattern, start, kind, transfer, count };
  if (shot.overlay !== undefined) normalized.overlay = normalizeOverlay(shot, shot.overlay, count, checkFiles);
  return normalized;
}

/** 一个镜头的分流滤镜（不含输入标签）：转 32 位浮点 RGB、截帧、缩放到成片尺寸，再按 colorRef 走显示变换 */
export function branchFilter(shot, { size, fps, view, index = 0 }) {
  const [w, h] = size;
  const head = [
    'format=gbrpf32le',
    `trim=end_frame=${shot.count}`,
    'setpts=PTS-STARTPTS',
  ];
  const resize = `scale=${w}:${h}:flags=bicubic`;
  if (shot.colorRef === 'scene') {
    if (!view?.lutPath) {
      throw bad(`场景参考镜头 ${shot.id} 要显式给 .cube 查找表 view.lutPath`, '查找表由显示变换的查找表目录提供，本模块不内置；把文件路径传进来');
    }
    if (!existsSync(view.lutPath)) throw bad(`查找表不存在：${view.lutPath}`);
    // xstack 在浮点平面右下方接上目标大小的空帧，因此 W-w、H-h 是原尺寸。
    // geq 在原图上按像素中心双线性采样，保留负值与超白。裁出目标区域后再整形。
    const x = `clip((X+0.5)*(W-${w})/${w}-0.5,0,W-${w}-1)`;
    const y = `clip((Y+0.5)*(H-${h})/${h}-0.5,0,H-${h}-1)`;
    const sample = (c) => `if(lt(X,${w})*lt(Y,${h}),${c}(${x},${y}),0)`;
    const floatResize = `${head.join(',')}[src${index}];nullsrc=s=${w}x${h}:r=${fps.num}/${fps.den},format=gbrpf32le[canvas${index}];`
      + `[src${index}][canvas${index}]xstack=layout=0_0|w0_h0:shortest=1,format=gbrpf32le,`
      + `geq=r='${sample('r')}':g='${sample('g')}':b='${sample('b')}',crop=${w}:${h}:0:0`;
    return [floatResize, shaperFilter(view.shaper), `lut3d=file=${escapeFilterValue(view.lutPath)}:interp=tetrahedral`].join(',');
  }
  return shot.transfer === 'linear' ? [...head, resize, displayEncodeFilter()].join(',') : [...head, resize].join(',');
}

/**
 * 拼接图：返回 { inputs, filter, label }。
 *   inputs  每个底图镜头一组参数（输入编号 = 镜头下标），可选的 PNG 叠加序列随后按镜头顺序追加
 *   filter  -filter_complex 的串；末尾输出 [label]，像素格式 yuv420p、有限范围 BT.709 矩阵（色彩标注由编码那步挂 setparams）
 * spec：{ shots, size: [宽, 高]（像素）, fps: "num/den", view: { lutPath, shaper }, finish: { grain, vignette }, transitions, seed, checkFiles }
 * 硬切之外的转场报错；镜头必须首尾相接、从 0 帧起。
 */
export function stitchGraph(spec) {
  const { shots, size, view, finish, transitions = [], seed = 0, checkFiles = true, finishOff = false } = spec;
  if (!Array.isArray(shots) || shots.length === 0) throw bad('至少要一个镜头');
  if (!Array.isArray(size) || size.length !== 2 || !size.every((v) => Number.isInteger(v) && v > 0 && v % 2 === 0)) {
    throw bad(`成片尺寸要两个正偶数（像素，yuv420p 要求），给的是 ${JSON.stringify(size)}`);
  }
  const fps = parseFps(spec.fps);
  const list = shots.map((s) => normalizeShot(s, { checkFiles }));
  let at = 0;
  for (const s of list) {
    if (s.in !== at) throw bad(`镜头 ${s.id} 的 in 是 ${s.in}，应接在上一镜头的 out ${at} 上`);
    at = s.out;
  }
  const cuts = new Set(list.slice(1).map((s) => s.in));
  for (const t of transitions) {
    if (t.type !== 'cut') throw bad(`转场 ${t.id} 的类型是 ${t.type}：本模块只做硬切`);
    if (!cuts.has(t.at)) throw bad(`转场 ${t.id} 的帧 ${t.at} 不是镜头交界`);
  }
  const sequenceInput = ({ start, pattern }) => [
    '-f', 'image2', '-framerate', `${fps.num}/${fps.den}`, '-start_number', String(start), '-i', pattern,
  ];
  const inputs = list.map(sequenceInput);
  const filters = list.map((s) => finishOff ? { rgb: null, yuv: null } : finishFilters(finish, spec.shotSeeds?.[s.id] ?? seed));
  const parts = list.map((s, i) => {
    let display = `[${i}:v]${branchFilter(s, { size, fps, view, index: i })}`;
    if (s.overlay) {
      const layer = inputs.length;
      inputs.push(sequenceInput(s.overlay));
      const alpha = s.overlay.opacity < 1 ? `,colorchannelmixer=aa=${num(s.overlay.opacity)}` : '';
      display += `,format=rgba[base${i}];[${layer}:v]trim=end_frame=${s.count},setpts=PTS-STARTPTS,`
        + `scale=${size.join(':')}:flags=bicubic,format=rgba,setsar=1${alpha}[layer${i}];`
        + `[base${i}][layer${i}]overlay=0:0:format=auto:shortest=1`;
    }
    const chain = [display, 'setsar=1', filters[i].rgb, TO_YUV709, filters[i].yuv].filter(Boolean);
    return `${chain.join(',')}[b${i}]`;
  });
  const joined = list.length > 1 ? `${list.map((_, i) => `[b${i}]`).join('')}concat=n=${list.length}:v=1:a=0` : '[b0]null';
  parts.push(`${joined}[vout]`);
  return { inputs, filter: parts.join(';'), label: 'vout', frames: at, fps, size, shots: list, finish: filters[0], shotFilters: filters };
}

export function rawCommand(graph) {
  return ['-hide_banner', '-nostdin', '-v', 'error', ...graph.inputs.flat(), '-filter_complex', graph.filter,
    '-map', `[${graph.label}]`, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'];
}

/** 跑一张拼接图，输出原始 yuv420p 字节（测试与核对用；不编码） */
export function renderRaw(graph, { timeoutMs } = {}) {
  return runTool(tools().ffmpeg, rawCommand(graph), { timeoutMs, what: '拼接出原始帧' }).stdout;
}
