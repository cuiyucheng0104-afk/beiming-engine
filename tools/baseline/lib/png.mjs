// 北冥仓库 · 最小 PNG 编解码（只靠 Node 自带 zlib，不引 npm 依赖）。
// 解码：8 位深、非隔行，灰度 / 灰度+α / RGB / RGBA / 调色板都支持（无头 Chrome 的截图是 8 位 RGB 或 RGBA）。
// 编码：8 位 RGB，用于差异图与接触印。
//
//   decodePNG(buf)            → { width, height, rgb }   rgb 是去掉 α 的 RGB 字节（截图背景不透明，α 恒为 255）
//   encodePNG({ width, height, rgb }) → Buffer
//   pixelSha256(img)          → 像素哈希：sha256("RGB8 <宽>x<高>\n" + RGB 字节)。只看像素，不受 PNG 压缩参数影响，
//                               所以换了浏览器的 PNG 编码器、像素没变时哈希也不变
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePNG(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG 文件（文件头不对）');
  let off = 8, width = 0, height = 0, depth = 0, ctype = -1, interlace = 0, palette = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) throw new Error(`PNG 数据块 ${type} 被截断`);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height) throw new Error('PNG 缺 IHDR');
  if (depth !== 8) throw new Error(`只支持 8 位深 PNG（这张是 ${depth} 位）`);
  if (interlace) throw new Error('不支持隔行 PNG');
  const ch = CHANNELS[ctype];
  if (!ch) throw new Error(`不认识的 PNG 颜色类型 ${ctype}`);
  if (ctype === 3 && !palette) throw new Error('调色板 PNG 缺 PLTE');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) throw new Error('PNG 像素数据不完整');
  const rgb = Buffer.allocUnsafe(width * height * 3);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let p = 0, o = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    switch (ft) {
      case 0: for (let x = 0; x < stride; x++) cur[x] = raw[p + x]; break;
      case 1:
        for (let x = 0; x < stride; x++) cur[x] = (raw[p + x] + (x >= ch ? cur[x - ch] : 0)) & 255;
        break;
      case 2: for (let x = 0; x < stride; x++) cur[x] = (raw[p + x] + prev[x]) & 255; break;
      case 3:
        for (let x = 0; x < stride; x++) cur[x] = (raw[p + x] + (((x >= ch ? cur[x - ch] : 0) + prev[x]) >> 1)) & 255;
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          cur[x] = (raw[p + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        }
        break;
      default: throw new Error(`第 ${y} 行的 PNG 过滤类型 ${ft} 不合法`);
    }
    p += stride;
    if (ctype === 2) { rgb.set(cur, o); o += stride; }
    else if (ctype === 6) for (let x = 0; x < stride; x += 4) { rgb[o++] = cur[x]; rgb[o++] = cur[x + 1]; rgb[o++] = cur[x + 2]; }
    else if (ctype === 0) for (let x = 0; x < stride; x++) { rgb[o++] = cur[x]; rgb[o++] = cur[x]; rgb[o++] = cur[x]; }
    else if (ctype === 4) for (let x = 0; x < stride; x += 2) { rgb[o++] = cur[x]; rgb[o++] = cur[x]; rgb[o++] = cur[x]; }
    else for (let x = 0; x < stride; x++) { const i = cur[x] * 3; rgb[o++] = palette[i]; rgb[o++] = palette[i + 1]; rgb[o++] = palette[i + 2]; }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, rgb };
}

let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePNG({ width, height, rgb }) {
  if (rgb.length !== width * height * 3) throw new Error('encodePNG：RGB 字节数与宽高不符');
  const stride = width * 3, raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy ? rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

export function pixelSha256({ width, height, rgb }) {
  return crypto.createHash('sha256').update(`RGB8 ${width}x${height}\n`).update(rgb).digest('hex');
}
