// 联系表与切点条带：把一串帧拼成带帧号角标的网格 PNG，或把每个切点前后各 3 帧拼成横向条带 PNG，同时给出切点两侧的差值。
//   buildContactSheet(options)  网格联系表；按 pick 指定帧号，或按 count 均匀抽样
//   buildCutStrips(options)     每个切点 c 取 [c-3, c-2, c-1, c, c+1, c+2]，越界的钳到 [0, 总帧数-1] 并标 clamped
// 帧来源二选一：
//   frames: [PNG 路径...]，第 i 项是帧号 start + i（start 默认 0）；
//   video + fps：视频路径和抽帧帧率（字符串 "30/1" 或正数，帧每秒），由 ffmpeg 按帧率重采样后第 n 帧是帧号 n。
// 切点来源任选：cuts（整数帧号数组）、transitions（片子描述 transitions[]，取 at）、events（events/0.1 或它的 events 数组，取 kind 是 cut 的 frame）。
// 返回 { ok: true, summary, outputs }：summary 是给代理读的文字摘要，序列化后 estimateTokens ≤ 300；outputs 是写出的文件路径。
// 参数不对返回 { ok: false, error: { code, message } }，不抛异常。
// 像素口径：PNG 按显示空间 sRGB 的 8 位码值读写，不做线性化；亮度用 Rec.709 权重直接作用在码值上，再除以 255，范围 [0, 1]。
// 子进程只用 spawnSync 直接传参数组，不经 shell，带超时。输出里不含时间戳。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';
import { estimateTokens } from './query.mjs';

export const SUMMARY_TOKEN_LIMIT = 300;
export const STRIP_OFFSETS = Object.freeze([-3, -2, -1, 0, 1, 2]);
// 切点判读的阈值，单位是归一化亮度（0 到 1）的逐像素平均绝对差
export const WEAK_CUT = 0.02;
export const GHOST_RATIO = 0.5;
const FFMPEG_TIMEOUT_MS = 120000;
const MAX_CELLS = 100;

class SheetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const bad = (message) => new SheetError('usage.bad-argument', message);

function guard(run) {
  try { return run(); }
  catch (error) {
    if (error instanceof SheetError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: 'usage.bad-argument', message: String(error?.message ?? error).slice(0, 160) } };
  }
}

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGB8 图像编码成 PNG（8 位、真彩色、无隔行、每行滤波 0） */
export function encodePng({ width, height, rgb }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** 读 PNG 的宽高（IHDR），不解码像素 */
export function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('ascii', 12, 16) !== 'IHDR') throw bad('不是 PNG 文件');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// PNG 的隔行顺序，每项是 [起点 x, 起点 y, 横向步长, 纵向步长]。
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const BACKGROUND = 32;
const composite = (value, alpha) => Math.round(value * alpha + BACKGROUND * (1 - alpha));

function readChunks(buf) {
  const idat = [];
  let palette, transparency;
  for (let p = 8; p + 12 <= buf.length;) {
    const len = buf.readUInt32BE(p), end = p + 8 + len;
    const kind = buf.toString('ascii', p + 4, p + 8);
    if (end + 4 > buf.length || crc32(buf.subarray(p + 4, end)) !== buf.readUInt32BE(end)) throw bad(`PNG ${kind} 块截断或 CRC32 不符`);
    const data = buf.subarray(p + 8, end);
    if (kind === 'IHDR' && (p !== 8 || len !== 13)) throw bad('PNG IHDR 不合法');
    if (kind === 'IDAT') idat.push(data);
    if (kind === 'PLTE') palette = data;
    if (kind === 'tRNS') transparency = data;
    if (kind === 'IEND') {
      if (len || end + 4 !== buf.length || !idat.length) throw bad('PNG IEND 或 IDAT 不完整');
      return { idat, palette, transparency };
    }
    p = end + 4;
  }
  throw bad('PNG 缺少完整 IEND');
}

function unfilter(row, previous, bpp, filter) {
  if (filter > 4) throw bad(`PNG 行滤波 ${filter} 不合法`);
  if (!filter) return;
  for (let i = 0; i < row.length; i++) {
    const a = i < bpp ? 0 : row[i - bpp];
    const b = previous?.[i] ?? 0, c = previous?.[i - bpp] ?? 0;
    const prediction = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
    row[i] += prediction;
  }
}

/** 依 PNG 位深解包样本，在显示码值空间合成到联系表的灰底，再返回 RGB8。 */
export function decodePng(buf) {
  const [width, height] = pngSize(buf);
  const { idat, palette, transparency } = readChunks(buf);
  const depth = buf[24], type = buf[25], interlace = buf[28];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const depths = type === 0 ? [1, 2, 4, 8, 16] : type === 3 ? [1, 2, 4, 8] : [8, 16];
  if (!width || !height || !channels || !depths.includes(depth) || buf[26] || buf[27] || interlace > 1) throw bad('PNG IHDR 像素格式不合法');
  if (type === 3 && (!palette?.length || palette.length % 3 || palette.length / 3 > 2 ** depth)) throw bad('PNG 调色板不合法');
  const max = 2 ** depth - 1;
  const bpp = Math.ceil(channels * depth / 8);
  const passes = (interlace ? ADAM7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const cols = Math.ceil((width - x) / dx), rows = Math.ceil((height - y) / dy);
    return { x, y, dx, dy, cols, rows, stride: Math.ceil(cols * channels * depth / 8) };
  }).filter(p => p.cols > 0 && p.rows > 0);
  const length = passes.reduce((n, p) => n + p.rows * (1 + p.stride), 0);
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: length });
  if (raw.length !== length) throw bad('PNG 像素数据长度不符');
  const rgb = new Uint8Array(width * height * 3);
  let offset = 0;
  for (const pass of passes) {
    let previous;
    for (let y = pass.y; y < height; y += pass.dy) {
      const filter = raw[offset++];
      const row = raw.subarray(offset, offset + pass.stride);
      offset += pass.stride;
      unfilter(row, previous, bpp, filter);
      previous = row;
      const sample = i => {
        if (depth === 16) return row.readUInt16BE(i * 2);
        if (depth === 8) return row[i];
        const bit = i * depth;
        return (row[bit >> 3] >> (8 - depth - bit % 8)) & max;
      };
      let base = 0;
      for (let x = pass.x; x < width; x += pass.dx, base += channels) {
        const index = sample(base);
        if (type === 3 && index * 3 >= palette.length) throw bad('PNG 调色板索引越界');
        let alpha = 1;
        if (type === 4 || type === 6) alpha = sample(base + channels - 1) / max;
        else if (type === 3) alpha = (transparency?.[index] ?? 255) / 255;
        else if (transparency && Array.from({ length: channels }, (_, k) => sample(base + k) === transparency.readUInt16BE(k * 2)).every(Boolean)) alpha = 0;
        const dest = (y * width + x) * 3;
        for (let k = 0; k < 3; k++) {
          const value = type === 3 ? palette[index * 3 + k] : sample(base + (channels < 3 ? 0 : k)) * 255 / max;
          rgb[dest + k] = composite(value, alpha);
        }
      }
    }
  }
  return { width, height, rgb };
}

// ---------- 5x7 位图字模（只有数字和减号），每行 5 位，高位在左 ----------

const GLYPHS = {
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], 1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], 3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], 5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], 7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], 9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '-': [0, 0, 0, 0x1f, 0, 0, 0],
};

/** 在 RGB8 画布上画一块帧号角标：黑底白字，scale 是每个字模点占几个像素；返回角标宽高 */
export function drawLabel(img, x0, y0, text, scale = 1) {
  const s = String(text);
  const w = (s.length * 6 + 1) * scale, h = 9 * scale;
  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    img.rgb.fill(v, (y * img.width + x) * 3, (y * img.width + x) * 3 + 3);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x0 + x, y0 + y, 0);
  [...s].forEach((ch, i) => {
    const rows = Object.hasOwn(GLYPHS, ch) ? GLYPHS[ch] : GLYPHS['-'];
    rows.forEach((bits, r) => {
      for (let c = 0; c < 5; c++) {
        if (!(bits & (0x10 >> c))) continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          put(x0 + (1 + i * 6 + c) * scale + dx, y0 + (1 + r) * scale + dy, 255);
        }
      }
    });
  });
  return [w, h];
}

// ---------- 像素运算 ----------

/** 面积平均缩放到 w×h */
export function resize(src, w, h) {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * src.height) / h), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * src.width) / w), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
        const i = (yy * src.width + xx) * 3;
        r += src.rgb[i]; g += src.rgb[i + 1]; b += src.rgb[i + 2]; n++;
      }
      out.set([Math.round(r / n), Math.round(g / n), Math.round(b / n)], (y * w + x) * 3);
    }
  }
  return { width: w, height: h, rgb: out };
}

function blit(dst, src, x0, y0) {
  for (let y = 0; y < src.height; y++) {
    dst.rgb.set(src.rgb.subarray(y * src.width * 3, (y + 1) * src.width * 3), ((y0 + y) * dst.width + x0) * 3);
  }
}

function canvas(width, height, gray) {
  return { width, height, rgb: new Uint8Array(width * height * 3).fill(gray) };
}

function lumaPlane(img) {
  const out = new Float64Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = (0.2126 * img.rgb[i * 3] + 0.7152 * img.rgb[i * 3 + 1] + 0.0722 * img.rgb[i * 3 + 2]) / 255;
  }
  return out;
}

/** 平均亮度，[0, 1] */
export function meanLuma(img) {
  return lumaPlane(img).reduce((s, v) => s + v, 0) / (img.width * img.height);
}

/** 两帧逐像素亮度平均绝对差，[0, 1]；尺寸不同时把第二帧缩到第一帧的尺寸 */
export function frameDiff(a, b) {
  const bb = a.width === b.width && a.height === b.height ? b : resize(b, a.width, a.height);
  const la = lumaPlane(a), lb = lumaPlane(bb);
  let s = 0;
  for (let i = 0; i < la.length; i++) s += Math.abs(la[i] - lb[i]);
  return s / la.length;
}

// ---------- 帧来源 ----------

function parseFps(fps) {
  if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) return String(fps);
  if (typeof fps === 'string' && /^[1-9]\d*(\/[1-9]\d*)?$/.test(fps)) return fps;
  throw bad('fps 必须是正数或 "分子/分母" 写法的字符串，单位帧每秒');
}

function ffmpegBin() {
  const v = (process.env.FFMPEG ?? '').trim();
  return v || 'ffmpeg';
}

export function runFfmpeg(args, maxBuffer) {
  const r = spawnSync(ffmpegBin(), args, { shell: false, windowsHide: true, timeout: FFMPEG_TIMEOUT_MS, maxBuffer, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ENOENT') throw new SheetError('env.ffmpeg-missing', '找不到 ffmpeg；装 FFmpeg 或设 FFMPEG 为可执行文件路径');
  if (r.error?.code === 'ETIMEDOUT') throw new SheetError('timeout.ffmpeg', `ffmpeg 超过 ${FFMPEG_TIMEOUT_MS / 1000} 秒没跑完`);
  if (r.error || r.status !== 0) throw new SheetError('failure.ffmpeg', `ffmpeg 执行失败：${String(r.stderr ?? r.error?.message ?? '').trim().split('\n').pop()?.slice(0, 120)}`);
  return r.stdout;
}

function videoSource(path, fps) {
  const rate = parseFps(fps);
  const input = resolve(path);
  // 按帧率重采样后缩成 1×1 灰度，字节数就是帧数
  const count = runFfmpeg(['-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-vf', `fps=fps=${rate},scale=1:1`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], 64 * 1024 * 1024).length;
  if (count === 0) throw bad('视频里没有可读的帧');
  const load = (wanted) => {
    const list = [...new Set(wanted)].sort((a, b) => a - b);
    const head = runFfmpeg(['-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-vf', `fps=fps=${rate}`, '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', '-'], 256 * 1024 * 1024);
    const [width, height] = pngSize(head);
    const select = list.map((n) => `eq(n\\,${n})`).join('+');
    const size = width * height * 4;
    const raw = runFfmpeg(['-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-vf', `fps=fps=${rate},select=${select}`, '-fps_mode', 'passthrough',
      '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], size * list.length + 1024);
    if (raw.length !== size * list.length) throw bad(`ffmpeg 交回 ${raw.length / size} 帧，要的是 ${list.length} 帧`);
    return new Map(list.map((n, i) => {
      const rgb = new Uint8Array(width * height * 3);
      for (let p = i * size, dest = 0; dest < rgb.length; p += 4) {
        const alpha = raw[p + 3] / 255;
        for (let k = 0; k < 3; k++) rgb[dest++] = composite(raw[p + k], alpha);
      }
      return [n, { width, height, rgb }];
    }));
  };
  return { first: 0, count, load };
}

function pngSource(frames, start = 0) {
  if (!Array.isArray(frames) || frames.length === 0 || !frames.every((p) => typeof p === 'string' && p !== '')) throw bad('frames 必须是非空的 PNG 路径数组');
  if (!Number.isInteger(start) || start < 0) throw bad('start 必须是非负整数帧号');
  const load = (wanted) => new Map([...new Set(wanted)].map((n) => {
    let buf;
    try { buf = readFileSync(resolve(frames[n - start])); } catch { throw bad(`读不到第 ${n} 帧的 PNG：${basename(frames[n - start])}`); }
    try { return [n, decodePng(buf)]; }
    catch (error) { throw bad(`第 ${n} 帧 ${basename(frames[n - start])}：${error.message}`); }
  }));
  return { first: start, count: frames.length, load };
}

function source(options) {
  if (options.video !== undefined) {
    if (typeof options.video !== 'string' || options.video === '') throw bad('video 必须是视频文件路径');
    return videoSource(options.video, options.fps);
  }
  if (options.frames !== undefined) return pngSource(options.frames, options.start ?? 0);
  throw bad('要给 frames（PNG 路径数组）或 video 加 fps');
}

/** 从 cuts、transitions 或 events 里收切点帧号，去重排序 */
export function collectCuts({ cuts, transitions, events } = {}) {
  const out = [];
  if (cuts !== undefined) {
    if (!Array.isArray(cuts)) throw bad('cuts 必须是整数帧号数组');
    out.push(...cuts);
  }
  if (transitions !== undefined) {
    if (!Array.isArray(transitions)) throw bad('transitions 必须是数组');
    out.push(...transitions.map((t) => t?.at));
  }
  if (events !== undefined) {
    const list = Array.isArray(events) ? events : events?.events;
    if (!Array.isArray(list)) throw bad('events 必须是 events/0.1 对象或它的 events 数组');
    out.push(...list.filter((e) => e?.kind === 'cut').map((e) => e.frame));
  }
  if (!out.every((f) => Number.isInteger(f) && f >= 0)) throw bad('切点必须是非负整数帧号');
  return [...new Set(out)].sort((a, b) => a - b);
}

// ---------- 摘要预算 ----------

function withinSummary(obj) {
  const text = JSON.stringify(obj);
  return estimateTokens(text) <= SUMMARY_TOKEN_LIMIT && text.length <= SUMMARY_TOKEN_LIMIT * 3.5;
}

/** 把整数序列压成区段写法，例如 [0,5,10,15] → "0-15/5" */
export function compactFrames(list) {
  const parts = [];
  for (let i = 0; i < list.length;) {
    let j = i + 1;
    const step = list[i + 1] - list[i];
    while (j + 1 < list.length && list[j + 1] - list[j] === step) j++;
    if (j - i >= 2) { parts.push(`${list[i]}-${list[j]}${step === 1 ? '' : `/${step}`}`); i = j + 1; }
    else { parts.push(String(list[i])); i++; }
  }
  return parts.join(',');
}

function cellSize(frame, cellWidth) {
  if (!Number.isInteger(cellWidth) || cellWidth < 16 || cellWidth > 1024) throw bad('cellWidth 必须是 16 到 1024 的整数像素');
  return [cellWidth, Math.max(1, Math.round((frame.height * cellWidth) / frame.width))];
}

function prepareOut(out, what) {
  if (typeof out !== 'string' || out === '') throw bad(`${what} 必须是输出路径`);
  const p = resolve(out);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

// ---------- 联系表 ----------

/**
 * options: frames | video+fps，out（PNG 路径），pick（帧号数组）或 count（均匀抽几帧，默认 12），
 *   columns（列数，默认取 ceil(sqrt(格数))），cellWidth（每格宽，像素，默认 160），gap（格间距，像素，默认 2）
 */
export function buildContactSheet(options = {}) {
  return guard(() => {
    const src = source(options);
    const last = src.first + src.count - 1;
    let picks;
    if (options.pick !== undefined) {
      if (!Array.isArray(options.pick) || options.pick.length === 0 || !options.pick.every((f) => Number.isInteger(f) && f >= src.first && f <= last)) {
        throw bad(`pick 必须是 ${src.first} 到 ${last} 之间的整数帧号`);
      }
      picks = [...options.pick];
    } else {
      const n = options.count ?? 12;
      if (!Number.isInteger(n) || n < 1) throw bad('count 必须是正整数');
      const k = Math.min(n, src.count);
      picks = k === 1 ? [src.first] : Array.from({ length: k }, (_, i) => src.first + Math.round((i * (src.count - 1)) / (k - 1)));
    }
    if (picks.length > MAX_CELLS) throw bad(`联系表最多 ${MAX_CELLS} 格`);
    const columns = options.columns ?? Math.ceil(Math.sqrt(picks.length));
    if (!Number.isInteger(columns) || columns < 1) throw bad('columns 必须是正整数');
    const gap = options.gap ?? 2;
    if (!Number.isInteger(gap) || gap < 0 || gap > 64) throw bad('gap 必须是 0 到 64 的整数像素');
    const out = prepareOut(options.out, 'out');
    const images = src.load(picks);
    const [cw, ch] = cellSize(images.get(picks[0]), options.cellWidth ?? 160);
    const cols = Math.min(columns, picks.length), rows = Math.ceil(picks.length / cols);
    const sheet = canvas(cols * cw + (cols + 1) * gap, rows * ch + (rows + 1) * gap, BACKGROUND);
    const scale = cw >= 256 ? 2 : 1;
    picks.forEach((f, i) => {
      const x = gap + (i % cols) * (cw + gap), y = gap + Math.floor(i / cols) * (ch + gap);
      blit(sheet, resize(images.get(f), cw, ch), x, y);
      drawLabel(sheet, x, y, f, scale);
    });
    writeFileSync(out, encodePng(sheet));
    const layout = { kind: 'contact', size: [sheet.width, sheet.height], grid: [cols, rows], cell: [cw, ch], gap,
      order: 'row-major', totalFrames: src.count };
    const file = basename(out), frames = compactFrames(picks);
    const range = { frames: `${picks[0]}..${picks.at(-1)}`, framesTruncated: true };
    // outputs 与 cells 始终带有完整值，摘要优先为格位映射保留空间。
    const summary = [
      { ...layout, file, frames }, { ...layout, fileTruncated: true, frames },
      { ...layout, file, ...range }, { ...layout, fileTruncated: true, ...range },
    ].find(withinSummary);
    return { ok: true, summary, outputs: [out], cells: picks.map((frame, i) => ({ frame, col: i % cols, row: Math.floor(i / cols) })) };
  });
}

// ---------- 切点条带 ----------

const r4 = (v) => Number(v.toFixed(4));

/** 切点判读：weak 是切点两侧几乎没变（疑似假切）；ghost 是切后一帧还在大变（疑似重影或叠化残留） */
export function cutFlags({ cutDiff, postDiff }) {
  const flags = [];
  if (cutDiff < WEAK_CUT) flags.push('weak');
  if (postDiff >= WEAK_CUT && postDiff > GHOST_RATIO * cutDiff) flags.push('ghost');
  return flags;
}

/**
 * options: frames | video+fps，cuts | transitions | events，outDir（条带目录），cellWidth（默认 160），gap（默认 2）
 * 每个切点写一张 cut-<帧号>.png；切点左侧画一条 4 像素红线标出切口。
 */
export function buildCutStrips(options = {}) {
  return guard(() => {
    const src = source(options);
    const cuts = collectCuts(options);
    if (cuts.length === 0) throw bad('没有切点：给 cuts、transitions 或带 cut 条目的 events');
    if (typeof options.outDir !== 'string' || options.outDir === '') throw bad('outDir 必须是输出目录');
    const dir = resolve(options.outDir);
    mkdirSync(dir, { recursive: true });
    const lo = src.first, hi = src.first + src.count - 1;
    const plans = cuts.map((c) => {
      if (c < lo || c > hi) throw bad(`切点 ${c} 不在 ${lo} 到 ${hi} 之间`);
      const wanted = STRIP_OFFSETS.map((d) => c + d);
      const frames = wanted.map((f) => Math.min(hi, Math.max(lo, f)));
      return { cut: c, frames, clamped: frames.some((f, i) => f !== wanted[i]) };
    });
    const images = src.load(plans.flatMap((p) => p.frames));
    const gap = options.gap ?? 2;
    if (!Number.isInteger(gap) || gap < 0 || gap > 64) throw bad('gap 必须是 0 到 64 的整数像素');
    const [cw, ch] = cellSize(images.get(plans[0].frames[0]), options.cellWidth ?? 160);
    const scale = cw >= 256 ? 2 : 1;
    const outputs = [];
    const rows = plans.map(({ cut, frames, clamped }) => {
      const strip = canvas(frames.length * cw + (frames.length + 1) * gap, ch + 2 * gap, BACKGROUND);
      frames.forEach((f, i) => {
        const x = gap + i * (cw + gap);
        blit(strip, resize(images.get(f), cw, ch), x, gap);
        drawLabel(strip, x, gap, f, scale);
      });
      const cutX = gap + 3 * (cw + gap) - Math.min(gap, 2) - 2;
      for (let y = 0; y < strip.height; y++) for (let x = Math.max(0, cutX); x < Math.min(strip.width, cutX + 4); x++) strip.rgb.set([255, 0, 0], (y * strip.width + x) * 3);
      const file = join(dir, `cut-${cut}.png`);
      writeFileSync(file, encodePng(strip));
      outputs.push(file);
      const [, pre2, pre1, at, post1] = frames.map((f) => images.get(f));
      const diffs = { lumaJump: r4(meanLuma(at) - meanLuma(pre1)), preDiff: r4(frameDiff(pre2, pre1)), cutDiff: r4(frameDiff(pre1, at)), postDiff: r4(frameDiff(at, post1)) };
      return { cut, pair: [frames[2], frames[3]], frames, ...(clamped ? { clamped } : {}), ...diffs, flags: cutFlags(diffs) };
    });
    const head = (list, cut) => ({ kind: 'cut-strips', cell: [cw, ch], offsets: STRIP_OFFSETS, totalCuts: rows.length, returnedCuts: list.length, truncated: cut, cuts: list });
    // 有异常标记的切点排在前面，预算不够时先丢正常切点
    const order = [...rows].sort((a, b) => b.flags.length - a.flags.length || Number(Boolean(b.clamped)) - Number(Boolean(a.clamped)) || a.cut - b.cut);
    let summary = head([], true);
    for (let n = 1; n <= order.length; n++) {
      const candidate = head(order.slice(0, n), n < order.length);
      if (!withinSummary(candidate)) break;
      summary = candidate;
    }
    return { ok: true, summary, outputs };
  });
}
