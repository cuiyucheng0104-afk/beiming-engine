// 契约 6 的独立读回核对。所有观测取自包文件；源场景计数由调用方从 Blender IPC 提供。
import Ajv2020 from 'ajv/dist/2020.js';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { checks } from '../../kernel/contracts/scene-pack/check.mjs';
import errorSchema from '../../kernel/contracts/errors/schema/errors.schema.json' with { type: 'json' };
import recordSchema from '../../kernel/contracts/scene-pack/schema/scene-pack-check.schema.json' with { type: 'json' };
import packSchema from '../../kernel/contracts/scene-pack/schema/scene-pack.schema.json' with { type: 'json' };

const ajv = new Ajv2020({ strict: false, schemas: [errorSchema, packSchema, recordSchema] });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
function need(condition, message) {
  if (!condition) throw new Error(message);
}
function validate(schema, value) {
  const valid = ajv.getSchema(schema.$id);
  need(valid(value), `${schema.title} schema: ${ajv.errorsText(valid.errors)}`);
}
function check(id, record) {
  const errors = checks[id](record);
  if (errors.length) throw new Error(`${id}: ${errors.join('；')}`);
}

async function inventory(dir) {
  const files = [];
  async function walk(prefix) {
    for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(`${path}/`);
      else {
        need(entry.isFile(), `SP1: ${path} 不是普通文件`);
        files.push({ path, bytes: (await stat(join(dir, path))).size });
      }
    }
  }
  await walk('');
  return files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

function packDigest(files, hashes) {
  return `sha256:${sha(files.map(({ path }) => `${hashes.get(path)}  ${path}\n`).join(''))}`;
}

// 拆开 JSON 和 BIN 后按 glTF 2.0 重新生成对齐、块头和总长度，给 SP6 算写回字节的摘要。
function glb(bytes) {
  need(bytes.length >= 28 && bytes.toString('ascii', 0, 4) === 'glTF' && bytes.readUInt32LE(4) === 2 &&
    bytes.readUInt32LE(8) === bytes.length, 'GLB 文件头无效');
  const end = 20 + bytes.readUInt32LE(12);
  need(end % 4 === 0 && end + 8 <= bytes.length && bytes.toString('ascii', 16, 20) === 'JSON' &&
    bytes.toString('ascii', end + 4, end + 8) === 'BIN\0', 'GLB 必须包含 JSON 和 BIN 块');
  const bin = bytes.subarray(end + 8);
  need(bytes.readUInt32LE(end) === bin.length && bin.length % 4 === 0, 'GLB BIN 块长度错误');
  const doc = JSON.parse(bytes.toString('utf8', 20, end));
  const buffer = doc.buffers?.[0];
  need(doc.asset?.version === '2.0' && doc.buffers?.length === 1 && buffer.uri === undefined &&
    Number.isSafeInteger(buffer.byteLength) && buffer.byteLength >= 0 && Math.ceil(buffer.byteLength / 4) * 4 === bin.length,
  'GLB 必须包含单个嵌入的 glTF 2.0 缓冲区');
  const json = Buffer.from(JSON.stringify(doc)), pad = Buffer.alloc((4 - json.length % 4) % 4, 32);
  const header = Buffer.alloc(20), chunk = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + pad.length + bin.length, 8);
  header.writeUInt32LE(json.length + pad.length, 12); header.write('JSON', 16);
  chunk.writeUInt32LE(bin.length); chunk.write('BIN\0', 4);
  const rewrittenHash = createHash('sha256').update(header).update(json).update(pad).update(chunk).update(bin).digest('hex');
  return { doc, bin, rewrittenHash };
}

/** glTF 访问器的偏移量以字节计；索引支持三种无符号宽度，顶点允许交错布局。 */
function accessor({ doc, bin }, index, vector) {
  const a = doc.accessors?.[index], v = doc.bufferViews?.[a?.bufferView];
  const bytes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[a?.componentType];
  need(a && v?.buffer === 0 && !a.sparse && !a.normalized && bytes && Number.isSafeInteger(a.count) && a.count > 0 &&
    (vector ? a.type === 'VEC3' && a.componentType === 5126 : a.type === 'SCALAR' && a.componentType !== 5126),
  `GLB 访问器 ${index} 类型或计数无效`);
  const width = bytes * (vector ? 3 : 1), stride = v.byteStride ?? width, offset = a.byteOffset ?? 0, base = v.byteOffset ?? 0;
  need([base, offset, stride, v.byteLength].every((n) => Number.isSafeInteger(n) && n >= 0) && stride >= width &&
    offset + (a.count - 1) * stride + width <= v.byteLength && base + v.byteLength <= doc.buffers[0].byteLength,
  `GLB 访问器 ${index} 越界`);
  return { count: a.count, at: (i, component = 0) => {
    const start = base + offset + stride * i + component * bytes;
    return vector ? bin.readFloatLE(start) : bin.readUIntLE(start, bytes);
  } };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => a.map((v, i) => v - b[i]);
function geometry(parsed, pack) {
  const { doc } = parsed;
  const meshes = new Map((doc.meshes ?? []).map((m) => [m.name, m]));
  need(meshes.size === doc.meshes?.length && meshes.size === pack.geometry.meshes.length, 'GLB 网格名或个数与清单不一致');
  const meshTris = [], samples = [];
  for (const mesh of pack.geometry.meshes) {
    const prims = meshes.get(mesh.name)?.primitives;
    need(prims?.length === 1 && (prims[0].mode ?? 4) === 4, `GLB 网格 ${mesh.name} 必须有一个三角形图元`);
    const { attributes, indices } = prims[0];
    const pos = accessor(parsed, attributes.POSITION, true), normals = accessor(parsed, attributes.NORMAL, true);
    const ix = accessor(parsed, indices, false);
    need(pos.count === normals.count && ix.count === mesh.tris * 3, `GLB ${mesh.name} 三角形或每角法线数不符`);
    meshTris.push(ix.count / 3);
    for (let i = 0; i < pos.count; i++) {
      const length = Math.hypot(normals.at(i), normals.at(i, 1), normals.at(i, 2));
      if (Math.abs(length - 1) > 1e-5 || !Number.isFinite(length) ||
          !Number.isFinite(pos.at(i) + pos.at(i, 1) + pos.at(i, 2))) throw new Error(`GLB ${mesh.name} 顶点或单位法线无效`);
    }
    // 每个网格取一个面积非零的三角形作几何法线探针。即使所有面都退化，仍核对全部索引。
    let sample;
    for (let i = 0; i < ix.count; i += 3) {
      const a = ix.at(i), b = ix.at(i + 1), c = ix.at(i + 2);
      if (Math.max(a, b, c) >= pos.count) throw new Error(`GLB ${mesh.name} 顶点索引越界`);
      if (sample) continue;
      const point = (v) => [pos.at(v), pos.at(v, 1), pos.at(v, 2)];
      const p = point(a), e1 = sub(point(b), p), e2 = sub(point(c), p), n = cross(e1, e2);
      if (Math.hypot(...n) > 0) sample = { e1, e2, n };
    }
    samples.push(sample);
  }
  return { meshTris, samples, counts: { skins: doc.skins?.length ?? 0, animations: doc.animations?.length ?? 0,
    morphTargets: doc.meshes.reduce((sum, m) => sum + m.primitives.reduce((n, p) => n + (p.targets?.length ?? 0), 0), 0) } };
}

function normalProbe(m, det, { e1, e2, n }) {
  // 世界坐标下的两条边；平移在顶点相减时抵消。余子式矩阵的列是另外两列的叉积。
  const cols = [m.slice(0, 3), m.slice(4, 7), m.slice(8, 11)];
  const mul = (columns, v) => [0, 1, 2].map((i) => columns[0][i] * v[0] + columns[1][i] * v[1] + columns[2][i] * v[2]);
  const raw = cross(mul(cols, e1), mul(cols, e2));
  const transformed = mul([cross(cols[1], cols[2]), cross(cols[2], cols[0]), cross(cols[0], cols[1])], n);
  const length = Math.hypot(...transformed);
  return { raw, used: transformed.map((v) => v * Math.sign(det) / length) };
}

// 四种读法都从打开的文件描述符取字节。单帧重开，顺序、乱序和重复访问共用另一个描述符。
async function frameReads(path, table, shape) {
  const [count, ...dims] = shape, per = 4 * dims.reduce((a, b) => a * b, 1), bytes = Buffer.alloc(per), reads = [];
  async function observe(handle, frame, mode) {
    for (let at = 0; at < per;) {
      const { bytesRead } = await handle.read(bytes, at, per - at, frame * per + at);
      need(bytesRead > 0, `SP8: ${table} 第 ${frame} 帧数据不全`);
      at += bytesRead;
    }
    reads.push({ table, frame, mode, digest: `sha256:${sha(bytes)}` });
  }
  for (let frame = 0; frame < count; frame++) {
    const fd = await open(path, 'r');
    try { await observe(fd, frame, 'single'); } finally { await fd.close(); }
  }
  const fd = await open(path, 'r');
  try {
    for (let frame = 0; frame < count; frame++) await observe(fd, frame, 'sequential');
    // 固定交错访问首尾，重复核验无需依赖随机种子。
    for (let i = 0; i < count; i++) await observe(fd, i % 2 ? (i - 1) / 2 : count - 1 - i / 2, 'shuffled');
    await observe(fd, 0, 'repeat');
    await observe(fd, 0, 'repeat');
  } finally { await fd.close(); }
  return reads;
}

function frameTables(record, data, samples) {
  const { pack } = record, fr = pack.frames, instances = [], frameInstances = [], normalProbes = [];
  const rows = data.get(pack.instances.file);
  for (let i = 0; i < rows.length; i += 16) instances.push([0, 4, 8, 12].map((j) => rows.readUInt32LE(i + j)));
  record.tables = { instances, frameInstances };
  check('SP9', record);
  const probes = new Set([0, Math.floor((fr.count - 1) / 2), fr.count - 1]);
  const watts = fr.lights.fields.includes('watts') ? Array.from({ length: fr.count }, () => []) : undefined;
  for (const name of ['instances', 'camera', 'lights']) {
    const { fields, file, shape } = fr[name], bytes = data.get(file);
    const width = shape.at(-1), rowsPerFrame = shape.length === 3 ? shape[1] : 1;
    for (let frame = 0; frame < fr.count; frame++) for (let row = 0; row < rowsPerFrame; row++) {
      let offset = 4 * width * (frame * rowsPerFrame + row);
      for (const field of fields) {
        if (field === 'mat16') {
          const m = Array.from({ length: 16 }, (_, i) => bytes.readFloatLE(offset + i * 4));
          need(m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1, `SP8: ${file} 非仿射矩阵`);
          if (name === 'instances') {
            const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
            need(det !== 0, `SP3: 第 ${frame} 帧第 ${row} 行行列式为零`);
            frameInstances.push({ frame, row, mat16: m });
            const sample = samples[instances[row][0]];
            if (sample && probes.has(frame)) normalProbes.push({ row, frame, ...normalProbe(m, det, sample) });
          }
          offset += 64;
        } else {
          const v = bytes.readFloatLE(offset);
          const ok = field === 'watts' ? v >= 0 : v > 0 && (field !== 'fovY' || v < Math.PI);
          need(ok, `SP8: ${file} 第 ${frame} 帧 ${field} 的值越界`);
          if (field === 'watts') watts[frame].push(v);
          if (field === 'watts' && frame === 0 && 'watts' in pack.lights[row]) {
            need(v === pack.lights[row].watts, `SP2: ${pack.lights[row].name} 首帧功率与清单不符`);
          }
          offset += 4;
        }
      }
    }
  }
  record.normalProbes = normalProbes;
  return watts;
}

function reconcile(record, meshTris, frameWatts, source) {
  const { pack, tables } = record, powered = pack.lights.filter((l) => 'watts' in l);
  const lightWatts = Object.fromEntries(powered.map((l) => [l.name, l.watts]));
  const stats = { meshes: meshTris.length, meshTris, instances: tables.instances.length,
    instanceTris: tables.instances.reduce((s, row) => s + meshTris[row[0]], 0), lights: pack.lights.length, lightWatts,
    frames: pack.frames.count };
  if (source !== undefined) {
    for (const k of ['meshes', 'instances', 'instanceTris', 'lights']) need(source?.[k] === stats[k], `Blender ${k} 与包不符`);
    need(same(meshTris, source.meshTris), 'Blender 逐网格三角形数与 GLB 不符');
    need(Array.isArray(source.frames) && source.frames.length === stats.frames && source.frames.every(Number.isSafeInteger), 'Blender 帧数与包不符');
    if (pack.ext?.['blender.sourceFrames']) need(same(source.frames, pack.ext['blender.sourceFrames']), 'Blender 源帧号与包不符');
    need(source.lightWatts && same(Object.keys(lightWatts).sort(), Object.keys(source.lightWatts).sort()), 'SP2: Blender 灯名与包不符');
    record.exportLights = powered.map(({ name, watts }) => ({ name, sourceWatts: source.lightWatts[name], packWatts: watts }));
    if (frameWatts || source.frameLightWatts !== undefined) {
      need(Array.isArray(frameWatts) && Array.isArray(source.frameLightWatts) && source.frameLightWatts.length === frameWatts.length &&
        frameWatts.every((row, i) => same(row, source.frameLightWatts[i])), 'SP2: Blender 逐帧灯光功率与包不符');
    }
    check('SP2', record);
  }
  return stats;
}

/** 读回 scene-pack/0.1，失败抛出条文号或具体的结构/对账错误。 */
export async function verifyScenePackDir(packDir, { blenderStats, secondPassDir } = {}) {
  const inventoryRows = await inventory(packDir), files = inventoryRows.map((f) => f.path);
  need(files.includes('pack.json'), 'SP1: 缺少 pack.json');
  const manifest = await readFile(join(packDir, 'pack.json'));
  const pack = JSON.parse(manifest.toString('utf8'));
  validate(packSchema, pack);
  for (const entries of [pack.geometry.meshes, pack.materials, pack.lights]) {
    need(new Set(entries.map((entry) => entry.name)).size === entries.length, '清单里的网格、材质和灯各自必须有唯一名字');
  }
  const record = { format: 'scene-pack-check/0.1', pack, files: inventoryRows };
  // 先查引用和长度，再使用清单中的相对路径及表维度。
  check('SP1', record);
  check('SP8', record);
  const data = new Map(), before = new Map(), after = new Map();
  for (const { path, bytes } of inventoryRows) {
    const b = path === 'pack.json' ? manifest : await readFile(join(packDir, path));
    need(b.length === bytes, `SP8: 读取时 ${path} 长度改变`);
    data.set(path, b); before.set(path, sha(b));
  }
  const parsed = glb(data.get(pack.geometry.file));
  const { meshTris, samples, counts } = geometry(parsed, pack);
  record.geometry = counts;
  after.set(pack.geometry.file, parsed.rewrittenHash);
  after.set('pack.json', sha(`${JSON.stringify(pack, null, 1)}\n`));
  record.reads = [];
  for (const [name, table] of [['static', pack.instances], ...Object.entries(pack.frames).filter(([k]) => k !== 'count')]) {
    const bytes = data.get(table.file), rewritten = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i += 4) {
      if (name === 'static') rewritten.writeUInt32LE(bytes.readUInt32LE(i), i);
      else {
        const value = bytes.readFloatLE(i);
        if (!Number.isFinite(value)) throw new Error(`SP8: ${table.file} 第 ${i / 4} 个数不是有限数`);
        rewritten.writeFloatLE(value, i);
      }
    }
    after.set(table.file, sha(rewritten));
    if (name !== 'static') {
      for (const observation of await frameReads(join(packDir, table.file), name, table.shape)) record.reads.push(observation);
    }
  }
  const frameWatts = frameTables(record, data, samples);
  const stats = reconcile(record, meshTris, frameWatts, blenderStats);
  const digest = packDigest(inventoryRows, before);
  record.roundTrip = { before: digest, after: packDigest(inventoryRows, after) };
  validate(recordSchema, record);
  for (const id of Object.keys(checks)) check(id, record);
  if (secondPassDir !== undefined) {
    const second = await inventory(secondPassDir);
    need(same(files, second.map((f) => f.path)), 'SP1: 两遍导出的文件集合不同');
    for (const path of files) {
      const other = await readFile(join(secondPassDir, path));
      need(sha(other) === before.get(path) && other.equals(data.get(path)), `两遍导出 ${path} 字节不同`);
    }
  }
  return { pack, record, files, digest, stats };
}
