// 最小 PNG 读写（只用 Node 自带的 zlib）：底板准入检查要逐像素读 alpha，又不想为此依赖 Python 或第三方包。
//   readPngInfo(buf) → { width, height, bitDepth, colorType, interlace, chunks: ['IHDR', 'sRGB', ...], srgb, gamma, iccp, text }
//   decodePng(buf)   → { width, height, channels: 4, data: Uint8Array(RGBA, 8 位) }   支持色彩类型 0/2/3/4/6、位深 8/16（16 位取高字节）
//                      不支持隔行扫描（Adam7）与位深 1/2/4 的灰度：直接抛错，提示先转成 8 位非隔行 PNG
//   encodePng({ width, height, data, channels = 4 }) → Buffer   8 位 RGBA / RGB / 灰度，滤波 0；测试夹具用
// 纯函数，不碰文件系统。
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export class PngError extends Error { constructor(m) { super(m); this.name = 'PngError'; } }

function* chunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new PngError('不是 PNG 文件（文件头不对）');
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new PngError(`PNG 被截断（${type} 块不完整）`);
    yield { type, data: buf.subarray(p + 8, p + 8 + len) };
    p += 12 + len;
    if (type === 'IEND') return;
  }
  throw new PngError('PNG 没有 IEND（文件不完整）');
}

export function readPngInfo(buf) {
  const info = { chunks: [], srgb: null, gamma: null, iccp: null, text: {} };
  for (const c of chunks(buf)) {
    info.chunks.push(c.type);
    if (c.type === 'IHDR') Object.assign(info, { width: c.data.readUInt32BE(0), height: c.data.readUInt32BE(4), bitDepth: c.data[8], colorType: c.data[9], interlace: c.data[12] });
    else if (c.type === 'sRGB') info.srgb = c.data[0];
    else if (c.type === 'gAMA') info.gamma = c.data.readUInt32BE(0) / 100000;
    else if (c.type === 'iCCP') info.iccp = c.data.toString('latin1', 0, Math.max(0, c.data.indexOf(0)));
    else if (c.type === 'tEXt') { const z = c.data.indexOf(0); if (z > 0) info.text[c.data.toString('latin1', 0, z)] = c.data.toString('latin1', z + 1); }
  }
  if (!info.width) throw new PngError('PNG 缺 IHDR');
  return info;
}

const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

export function decodePng(buf) {
  let ihdr = null, plte = null, trns = null; const idat = [];
  for (const c of chunks(buf)) {
    if (c.type === 'IHDR') ihdr = c.data;
    else if (c.type === 'PLTE') plte = c.data;
    else if (c.type === 'tRNS') trns = c.data;
    else if (c.type === 'IDAT') idat.push(c.data);
  }
  if (!ihdr) throw new PngError('PNG 缺 IHDR');
  const W = ihdr.readUInt32BE(0), H = ihdr.readUInt32BE(4), depth = ihdr[8], ct = ihdr[9], inter = ihdr[12];
  const ch = CHANNELS[ct];
  if (!ch) throw new PngError(`不认识的 PNG 色彩类型 ${ct}`);
  if (inter) throw new PngError('不支持隔行扫描（Adam7）的 PNG：先另存为非隔行');
  if (depth !== 8 && depth !== 16) throw new PngError(`不支持位深 ${depth}：先转成 8 位 PNG`);
  if (ct === 3 && !plte) throw new PngError('索引色 PNG 缺 PLTE');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ch * depth / 8, stride = W * bpp;
  if (raw.length < H * (stride + 1)) throw new PngError('PNG 像素数据不完整');
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = row[i];
      cur[i] = f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : f === 4 ? x + paeth(a, b, c) : (() => { throw new PngError(`第 ${y} 行的滤波类型 ${f} 不合法`); })();
    }
    for (let x = 0; x < W; x++) {
      const s = x * bpp, o = (y * W + x) * 4;
      const v = k => cur[s + k * (depth / 8)];      // 16 位取高字节
      if (ct === 6) { out[o] = v(0); out[o + 1] = v(1); out[o + 2] = v(2); out[o + 3] = v(3); }
      else if (ct === 2) { out[o] = v(0); out[o + 1] = v(1); out[o + 2] = v(2); out[o + 3] = 255; }
      else if (ct === 0) { out[o] = out[o + 1] = out[o + 2] = v(0); out[o + 3] = 255; }
      else if (ct === 4) { out[o] = out[o + 1] = out[o + 2] = v(0); out[o + 3] = v(1); }
      else { const i = cur[s]; out[o] = plte[i * 3]; out[o + 1] = plte[i * 3 + 1]; out[o + 2] = plte[i * 3 + 2]; out[o + 3] = trns && i < trns.length ? trns[i] : 255; }
    }
    prev.set(cur);
  }
  return { width: W, height: H, channels: 4, data: out };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng({ width, height, data, channels = 4 }) {
  const ct = { 1: 0, 3: 2, 4: 6 }[channels];
  if (ct === undefined) throw new PngError(`encodePng 只支持 1 / 3 / 4 通道，收到 ${channels}`);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = ct;
  const stride = width * channels, raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
