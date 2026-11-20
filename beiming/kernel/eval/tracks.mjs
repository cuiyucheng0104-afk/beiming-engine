// 索引中的 offset 以字节计，stride 以每个样本的 float32 分量数计。
const strides = { scalar: 1, vec3: 3, quat: 4, camera: 8, bbox: 6 };
const bytesPerFloat = Float32Array.BYTES_PER_ELEMENT;
const trackKeys = ['name', 'type', 'stride', 'offset', 'count'];

function copyMetadata(meta) {
  try {
    const json = JSON.stringify(meta, (_, value) => {
      if (value === null || ['object', 'string', 'boolean'].includes(typeof value) || Number.isFinite(value)) {
        return value;
      }
      throw new TypeError('元数据值必须能表示为 JSON');
    });
    return JSON.parse(json);
  } catch (cause) {
    throw new TypeError('轨道元数据无法序列化为 JSON', { cause });
  }
}

function strideOf(type) {
  if (typeof type !== 'string' || !Object.hasOwn(strides, type)) throw new RangeError(`未知轨道类型 ${type}`);
  return strides[type];
}

function vector(value, width) {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value)) || value.length !== width) {
    throw new TypeError(`轨道样本需要 ${width} 个分量`);
  }
  return value;
}

function components(type, sample) {
  switch (type) {
    case 'scalar': return [sample];
    case 'camera': return [...vector(sample.pos, 3), ...vector(sample.quat, 4), sample.fovDeg];
    case 'bbox': return [...vector(sample.min, 3), ...vector(sample.max, 3)];
    default: return vector(sample, strides[type]);
  }
}

function sampleOf(type, row) {
  switch (type) {
    case 'scalar': return row[0];
    case 'camera': return { pos: row.slice(0, 3), quat: row.slice(3, 7), fovDeg: row[7] };
    case 'bbox': return { min: row.slice(0, 3), max: row.slice(3) };
    default: return row;
  }
}

/** 按轨道名排序写入连续的小端样本。meta 是调用方提供的 JSON 元数据。 */
export function encodeTracks(trackMap, meta = {}) {
  let size = 0;
  const tracks = Object.keys(trackMap).sort().map(name => {
    const { type, samples } = trackMap[name];
    const stride = strideOf(type);
    if (!Array.isArray(samples)) throw new TypeError(`轨道 ${name} 的 samples 必须是数组`);
    const offset = size;
    size += samples.length * stride * bytesPerFloat;
    return { name, type, stride, offset, count: samples.length };
  });
  const bin = new Uint8Array(size);
  const view = new DataView(bin.buffer);
  let cursor = 0;
  for (const { name, type } of tracks) {
    for (const sample of trackMap[name].samples) {
      for (const n of components(type, sample)) {
        if (!Number.isFinite(n) || !Number.isFinite(Math.fround(n))) throw new RangeError(`轨道 ${name} 含非有限 float32`);
        view.setFloat32(cursor, n, true);
        cursor += bytesPerFloat;
      }
    }
  }
  return { indexJson: { format: 'tracks/0.1', meta: copyMetadata(meta), tracks }, bin };
}

/** 用给定字节视图的边界解码，索引必须恰好覆盖整个视图。 */
export function decodeTracks(indexJson, bin) {
  if (indexJson?.format !== 'tracks/0.1' || !Array.isArray(indexJson.tracks)) throw new TypeError('轨道索引格式错误');
  if (!(bin instanceof Uint8Array)) throw new TypeError('轨道数据必须是 Uint8Array');
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const names = new Set();
  let cursor = 0;
  const entries = Array.from(indexJson.tracks, (entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`轨道索引第 ${i + 1} 项必须是对象`);
    }
    const keys = Reflect.ownKeys(entry);
    if (keys.length !== trackKeys.length || keys.some(key => !trackKeys.includes(key))) {
      throw new TypeError(`轨道索引第 ${i + 1} 项的字段必须为 ${trackKeys.join('、')}`);
    }
    const { name, type, offset, stride, count } = entry;
    if (typeof name !== 'string' || names.has(name)) throw new RangeError(`轨道名无效或重复 ${name}`);
    names.add(name);
    if (stride !== strideOf(type) || !Number.isSafeInteger(count) || count < 0) throw new RangeError(`轨道 ${name} 的步长或样本数错误`);
    if (offset !== cursor || count > (view.byteLength - cursor) / (stride * bytesPerFloat)) {
      throw new RangeError(`轨道 ${name} 的字节偏移或长度错误`);
    }
    const samples = Array.from({ length: count }, () => {
      const row = Array.from({ length: stride }, () => {
        const n = view.getFloat32(cursor, true);
        if (!Number.isFinite(n)) throw new RangeError(`轨道 ${name} 含非有限 float32`);
        cursor += bytesPerFloat;
        return n;
      });
      return sampleOf(type, row);
    });
    return [name, { type, samples }];
  });
  if (cursor !== bin.byteLength) throw new RangeError('轨道索引与字节长度不符');
  return Object.fromEntries(entries);
}
