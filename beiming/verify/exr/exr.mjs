import { deflateSync, inflateSync } from 'node:zlib';
import { endianness } from 'node:os';

const components = {
  color: ['R', 'G', 'B', 'A'], depth: ['Z'], objectId: ['id', 'coverage'],
  normal: ['X', 'Y', 'Z'], motion: ['X', 'Y'], denoiseAlbedo: ['R', 'G', 'B'],
  denoiseNormal: ['X', 'Y', 'Z'],
  // 输出通道契约 3.1 的八个光路通道（可选）
  ...Object.fromEntries(['diffuseDirect', 'diffuseIndirect', 'glossyDirect', 'glossyIndirect', 'transmissionDirect', 'transmissionIndirect', 'emission', 'environment'].map((n) => [n, ['R', 'G', 'B']])),
};

export function isPassChannel(name) {
  const parts = name.split('.');
  if (parts.length !== 2) return false;
  const [layer, component] = parts;
  if (Object.hasOwn(components, layer)) return components[layer].includes(component);
  return /^lightgroup:[a-z0-9][a-z0-9-]*$/.test(layer) && ['R', 'G', 'B'].includes(component);
}

const magic = 20000630;
const zero = Buffer.alloc(1);
const text = (name) => Buffer.from(`${name}\0`);
function integer(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
}
function attribute(name, type, value) {
  return Buffer.concat([text(name), text(type), integer(value.length), value]);
}
function check(condition, reason) {
  if (!condition) throw new Error(`EXR: ${reason}`);
}

// ZIPS 先分离偶、奇字节，再做相邻差分。压缩未变短时按规范写原行。
function zip(row) {
  const delta = Buffer.allocUnsafe(row.length);
  const half = row.length / 2;
  for (let i = 0; i < half; i++) {
    delta[i] = row[2 * i];
    delta[half + i] = row[2 * i + 1];
  }
  for (let i = delta.length - 1; i > 0; i--) delta[i] += 128 - delta[i - 1];
  const packed = deflateSync(delta);
  return packed.length < row.length ? packed : row;
}
function unzip(packed, length) {
  const delta = inflateSync(packed, { maxOutputLength: length });
  check(delta.length === length, '扫描线长度不符');
  for (let i = 1; i < length; i++) delta[i] += delta[i - 1] - 128;
  const row = Buffer.allocUnsafe(length);
  for (let i = 0; i < length / 2; i++) {
    row[2 * i] = delta[i];
    row[2 * i + 1] = delta[length / 2 + i];
  }
  return row;
}

// 平面按从上到下、从左到右排列。编号用 Uint32Array，其余用 Float32Array。
export function writeExr({ width, height, channels, compression = 0 }) {
  check([width, height].every(n => Number.isInteger(n) && n > 0 && n <= 0x7fffffff), '无效尺寸');
  check(compression === 0 || compression === 2, '不支持的压缩方式');
  const names = Object.keys(channels).sort();
  check(names.length > 0, '缺少通道');
  const entries = [];
  const planes = names.map(name => {
    check(/^[\x20-\x7e]{1,255}$/.test(name), '无效通道名');
    const data = channels[name];
    const unsigned = name === 'objectId.id' || data instanceof Uint32Array;
    check(data instanceof (unsigned ? Uint32Array : Float32Array) && data.length === width * height, `无效通道数据 ${name}`);
    check(!isPassChannel(name) || unsigned === (name === 'objectId.id'), `通道类型不符 ${name}`);
    entries.push(text(name), integer(unsigned ? 0 : 2), Buffer.alloc(4), integer(1), integer(1));
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return endianness() === 'LE' ? bytes : Buffer.from(bytes).swap32();
  });
  const window = Buffer.concat([integer(0), integer(0), integer(width - 1), integer(height - 1)]);
  const one = integer(0x3f800000);
  const header = Buffer.concat([
    integer(magic), integer(names.some(n => n.length > 31) ? 0x402 : 2),
    attribute('channels', 'chlist', Buffer.concat([...entries, zero])),
    attribute('compression', 'compression', Buffer.from([compression])),
    attribute('dataWindow', 'box2i', window), attribute('displayWindow', 'box2i', window),
    attribute('lineOrder', 'lineOrder', zero), attribute('pixelAspectRatio', 'float', one),
    attribute('screenWindowCenter', 'v2f', Buffer.alloc(8)), attribute('screenWindowWidth', 'float', one), zero,
  ]);
  const offsets = Buffer.alloc(height * 8);
  const chunks = [header, offsets];
  let offset = header.length + offsets.length;
  for (let y = 0; y < height; y++) {
    const row = Buffer.concat(planes.map(p => p.subarray(y * width * 4, (y + 1) * width * 4)));
    const payload = compression === 2 ? zip(row) : row;
    offsets.writeBigUInt64LE(BigInt(offset), y * 8);
    chunks.push(integer(y), integer(payload.length), payload);
    offset += 8 + payload.length;
  }
  return Buffer.concat(chunks);
}

class Cursor {
  constructor(data) { this.data = data; this.pos = 0; }
  take(size) {
    check(size >= 0 && size <= this.data.length - this.pos, '数据截断');
    this.pos += size;
    return this.data.subarray(this.pos - size, this.pos);
  }
  word() { return this.take(4).readInt32LE(); }
  name() {
    const end = this.data.indexOf(0, this.pos);
    check(end >= this.pos && end - this.pos <= 255, '无效名称');
    return this.take(end - this.pos + 1).subarray(0, -1).toString();
  }
}

export function readExr(bytes, { requiredChannels = [] } = {}) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cursor = new Cursor(data);
  check(cursor.word() === magic && [2, 0x402].includes(cursor.word()), '仅支持单部件扫描线 v2');
  const attrs = new Map();
  for (let name; (name = cursor.name());) {
    check(!attrs.has(name), `重复属性 ${name}`);
    attrs.set(name, { type: cursor.name(), value: cursor.take(cursor.word()) });
  }
  function attr(name, type, length) {
    const entry = attrs.get(name);
    check(entry?.type === type && (length === undefined || entry.value.length === length), `无效属性 ${name}`);
    return entry.value;
  }
  attr('displayWindow', 'box2i', 16);
  attr('pixelAspectRatio', 'float', 4);
  attr('screenWindowCenter', 'v2f', 8);
  attr('screenWindowWidth', 'float', 4);
  check(attr('lineOrder', 'lineOrder', 1)[0] <= 1, '无效扫描线顺序');
  const window = attr('dataWindow', 'box2i', 16);
  const minY = window.readInt32LE(4);
  const width = window.readInt32LE(8) - window.readInt32LE() + 1;
  const height = window.readInt32LE(12) - minY + 1;
  const compression = attr('compression', 'compression', 1)[0];
  check((compression === 0 || compression === 2) && width > 0 && height > 0, '压缩或窗口无效');
  const list = new Cursor(attr('channels', 'chlist'));
  const types = new Map();
  for (let name; (name = list.name());) {
    const type = list.word();
    list.take(4);
    check(!types.has(name) && (type === 2 || type === 0) && list.word() === 1 && list.word() === 1, `无效通道 ${name}`);
    types.set(name, type);
  }
  check(types.size > 0 && list.pos === list.data.length, '无效通道表');
  for (const name of requiredChannels) check(types.has(name), `缺少通道 ${name}`);
  const table = cursor.take(height * 8);
  const chunkStart = cursor.pos;
  const channels = Object.create(null);
  const rowBytes = width * 4 * types.size;
  for (let y = 0; y < height; y++) {
    cursor.pos = Number(table.readBigUInt64LE(y * 8));
    check(cursor.pos >= chunkStart && cursor.word() === y + minY, '扫描线偏移或行号无效');
    const payload = cursor.take(cursor.word());
    check(payload.length === rowBytes || (compression === 2 && payload.length < rowBytes), '扫描线长度不符');
    const row = payload.length === rowBytes ? payload : unzip(payload, rowBytes);
    let pos = 0;
    for (const [name, type] of types) {
      if (y === 0) channels[name] = new (type === 2 ? Float32Array : Uint32Array)(width * height);
      const dest = Buffer.from(channels[name].buffer, y * width * 4, width * 4);
      row.copy(dest, 0, pos, pos + dest.length);
      if (endianness() !== 'LE') dest.swap32();
      pos += dest.length;
    }
  }
  return { width, height, channels, compression };
}
