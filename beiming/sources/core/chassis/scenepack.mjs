// 北冥 · 场景包写出器（测试用）：确定地写出场景包契约 scene-pack/0.1 的包（pack.json、自己拼的 GLB、实例表、每帧状态表），
// 给 core-render 的 pack-info、render-pack 当输入。同样的输入写出逐字节相同的文件。
// 这里只造两个自己定的小包：覆盖清单全部字段的 fullPack（镜像实例、一个实体占多行、三种灯、景深相机、四种图案节点），
// 与左右对称的 symmetricPack（左边原件、右边镜像件、正中一盏灯）；坏包在测试里从它们改出来。
// 另有 requiredPaths：照契约的结构定义（schema/scene-pack.schema.json）里的 required，列出一份清单里每个必填字段的路径。
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

// ------------------------------------------------------------------------------------------------ 矩阵（列主序）

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** 先按 (sx, sy, sz) 缩放、再平移到 (x, y, z) */
export const scaleThenTranslate = (sx, sy, sz, x, y, z) => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1];
/** 绕 x 轴转 a 弧度，再平移 */
export const rotX = (a, x, y, z) => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, x, y, z, 1];

// ------------------------------------------------------------------------------------------------ GLB

const pad4 = (buf, fill) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4), fill)]) : buf);
const f32 = values => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
const u32 = values => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32LE(v, i * 4)); return b; };

/** 网格 [{ name, positions, normals, indices }] 拼成 GLB：每个网格一个三角形图元，POSITION、NORMAL、32 位下标 */
export function glb(meshes) {
  const parts = [], views = [], accessors = [];
  let offset = 0;
  const view = (buf) => { views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length }); parts.push(buf); offset += buf.length; return views.length - 1; };
  const gltfMeshes = meshes.map(m => {
    const n = m.positions.length / 3;
    const lo = [0, 1, 2].map(c => Math.min(...m.positions.filter((_, i) => i % 3 === c)));
    const hi = [0, 1, 2].map(c => Math.max(...m.positions.filter((_, i) => i % 3 === c)));
    accessors.push({ bufferView: view(f32(m.positions)), componentType: 5126, count: n, type: 'VEC3', min: lo, max: hi });
    accessors.push({ bufferView: view(f32(m.normals)), componentType: 5126, count: n, type: 'VEC3' });
    accessors.push({ bufferView: view(u32(m.indices)), componentType: 5125, count: m.indices.length, type: 'SCALAR' });
    const a = accessors.length - 3;
    return { name: m.name, primitives: [{ attributes: { POSITION: a, NORMAL: a + 1 }, indices: a + 2, mode: 4 }] };
  });
  const bin = pad4(Buffer.concat(parts), 0);
  const json = pad4(Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: 'beiming chassis scenepack' }, buffers: [{ byteLength: bin.length }], bufferViews: views, accessors, meshes: gltfMeshes })), 0x20);
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, data]); };
  return Buffer.concat([head, chunk('JSON', json), chunk('BIN\0', bin)]);
}

// ------------------------------------------------------------------------------------------------ 包

/**
 * 写出一个包。spec：{ manifest, meshes（同 glb 的输入，次序同 manifest.geometry.meshes）, rows（实例表的行，[网格, 材质, 实体, 镜像]）,
 * tables: { instances, camera, lights }（每张表按行主序摊平的数）, layout?（文件放在哪里照的清单，默认就是 manifest）}。
 * 返回包里每个文件的 { path, bytes }，按路径排序。
 */
export function writePack(dir, spec) {
  // layout：文件放在哪里照这一份清单（删了字段的清单写出去时，文件仍照原样放）
  const m = spec.layout ?? spec.manifest;
  const files = new Map([
    ['pack.json', Buffer.from(`${JSON.stringify(spec.manifest, null, 1)}\n`)],
    [m.geometry.file, glb(spec.meshes)],
    [m.instances.file, u32(spec.rows.flat())],
    [m.frames.instances.file, f32(spec.tables.instances)],
    [m.frames.camera.file, f32(spec.tables.camera)],
    [m.frames.lights.file, f32(spec.tables.lights)],
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [p, b] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), b);
  }
  return [...files].map(([p, b]) => ({ path: p, bytes: b.length })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** 一块斜板：在 xy 上 0.8 m 见方，z = -0.5 x，正面（逆时针）朝 (0.5, 0, 1) 那一侧；每角法线都是正面的单位法线 */
export function ramp(name = 'ramp') {
  const n = [0.5, 0, 1].map(c => c / Math.hypot(0.5, 1));
  return {
    name,
    positions: [-0.4, -0.4, 0.2, 0.4, -0.4, -0.2, 0.4, 0.4, -0.2, -0.4, 0.4, 0.2],
    normals: [...n, ...n, ...n, ...n],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

/** y = 0 上 4 m 见方的地面，正面朝 +y */
export function floor(name = 'floor') {
  return { name, positions: [-2, 0, 2, 2, 0, 2, 2, 0, -2, -2, 0, -2], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 3] };
}

const SOURCE = { exporter: 'chassis/scenepack@0.1', blender: '5.2.3', sha256: '0'.repeat(64) };
const UNITS = { meter: 1, up: 'Y', hand: 'right' };
const mesh = (m) => ({ name: m.name, tris: m.indices.length / 3, attrs: ['position', 'cornerNormal'] });

/**
 * 覆盖清单全部字段的包，两帧：地面；斜板原件与镜像件（实体各一）；一个实体占两行；带四种图案节点的材质；矩形面光（带灯光链接
 * 与组名）、点光、平行光，灯表带 watts 列；带景深的相机；ext。第 1 帧里占两行的那个实体挪了位置。
 */
export function fullPack() {
  const meshes = [ramp(), floor()];
  const rows = [[1, 0, 1, 0], [0, 1, 2, 0], [0, 1, 3, 1], [0, 0, 4, 0], [0, 0, 4, 0]];
  const names = ['floor', 'kit.left', 'kit.right', 'kit.arm', 'kit.arm'];
  const place = (k) => [
    IDENTITY,
    translate(-1, 0.5, 0),
    scaleThenTranslate(-1, 1, 1, 1, 0.5, 0),
    translate(-0.3, 1.2 + 0.1 * k, -0.5),
    translate(0.3, 1.2 + 0.1 * k, -0.5),
  ].flat();
  const camera = k => [...rotX(-0.15, 0, 1, 4 + 0.1 * k), 0.7, 4, 2.8];
  const lights = k => [[...rotX(-Math.PI / 2, 0, 3, 0), 300 + 10 * k], [...translate(1.5, 2, 1.5), 40], [...IDENTITY, 0]].flat();
  const manifest = {
    format: 'scene-pack/0.1',
    id: 'pack:chassis-full@1',
    units: UNITS,
    geometry: { file: 'geometry.glb', meshes: meshes.map(mesh) },
    instances: { file: 'instances.u32', shape: [rows.length, 4], names, class: names.map(() => 'part') },
    materials: [
      { name: 'matte', closure: 'surface', params: { baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.8 } },
      {
        name: 'lined', closure: 'surface', params: { baseColor: [0.02, 0.02, 0.02], metallic: 0, roughness: 0.6 },
        pattern: [
          { node: 'bevel', radius: 0.004, samples: 4, out: 'normal' },
          { node: 'ao', distance: 0.01, samples: 8, onlyLocal: false, out: 'ao' },
          { node: 'smoothstep', in: 'ao', edges: [0.5, 0.9], out: 'line' },
          { node: 'mix', by: 'line', set: { baseColor: [0.8, 0.8, 0.8], roughness: 0.4 } },
        ],
      },
    ],
    lights: [
      { name: 'key', type: 'area-rect', size: [1.2, 0.8], watts: 300, color: [1, 0.95, 0.9], visibleToCamera: false, link: ['kit.*', 'floor'], group: 'key-light' },
      { name: 'bulb', type: 'point', watts: 40, color: [1, 1, 1], visibleToCamera: false },
      { name: 'sun', type: 'sun', dir: [0, 0.8, 0.6], irradiance: 2, color: [1, 1, 0.95], visibleToCamera: false },
    ],
    world: { color: [0.01, 0.01, 0.012], visibleToCamera: true },
    camera: { type: 'persp', near: 0.05, far: 50, sensorHeight: 0.024 },
    frames: {
      count: 2,
      instances: { file: 'frames/instances.f32', shape: [2, rows.length, 16], fields: ['mat16'] },
      camera: { file: 'frames/camera.f32', shape: [2, 19], fields: ['mat16', 'fovY', 'focusDist', 'fstop'] },
      lights: { file: 'frames/lights.f32', shape: [2, 3, 17], fields: ['mat16', 'watts'] },
    },
    source: SOURCE,
    ext: { 'chassis.note': '测试用的小包' },
  };
  return { manifest, meshes, rows, tables: { instances: [...place(0), ...place(1)], camera: [...camera(0), ...camera(1)], lights: [...lights(0), ...lights(1)] } };
}

/**
 * 左右对称的包：同一块斜板，左边原件在 x = -0.6，右边是它对 x = 0 平面的镜像（矩阵把 x 取反，第四列标 1）；
 * 正中一盏矩形面光、相机在正中朝 -z。镜像的那一半照对了，画面左右两半的平均亮度在噪声内相等。
 */
export function symmetricPack() {
  const meshes = [ramp()];
  const rows = [[0, 0, 1, 0], [0, 0, 2, 1]];
  const manifest = {
    format: 'scene-pack/0.1',
    id: 'pack:chassis-mirror@1',
    units: UNITS,
    geometry: { file: 'geometry.glb', meshes: meshes.map(mesh) },
    instances: { file: 'instances.u32', shape: [2, 4], names: ['left', 'right'], class: ['part', 'part'] },
    materials: [{ name: 'matte', closure: 'surface', params: { baseColor: [0.8, 0.8, 0.8], metallic: 0, roughness: 1 } }],
    lights: [{ name: 'key', type: 'area-rect', size: [1, 1], watts: 30, color: [1, 1, 1], visibleToCamera: false }],
    world: { color: [0, 0, 0], visibleToCamera: true },
    camera: { type: 'persp', near: 0.05, far: 50 },
    frames: {
      count: 1,
      instances: { file: 'frames/instances.f32', shape: [1, 2, 16], fields: ['mat16'] },
      camera: { file: 'frames/camera.f32', shape: [1, 17], fields: ['mat16', 'fovY'] },
      lights: { file: 'frames/lights.f32', shape: [1, 1, 16], fields: ['mat16'] },
    },
    source: SOURCE,
  };
  return { manifest, meshes, rows, tables: { instances: [...translate(-0.6, 0, 0), ...scaleThenTranslate(-1, 1, 1, 0.6, 0, 0)], camera: [...translate(0, 0, 3), 0.6], lights: translate(0, 0, 2) } };
}

/**
 * 前后错开的两块板（输出通道的边缘测试用）。相机在 (0, 0, 3) 朝 -z，fovY 0.6。后板（实体 1）10 m 见方，绕 y 轴转 PLATES.tilt、
 * 过 (0, 0, -1)，铺满画面；前板（实体 2）在 z = 0，右边是一条斜边（从 (0.25, -3) 到 (-0.25, 3)），挡住画面左边一大半。
 * 两块板的几何与 PLATES 里的数一致，测试照它们自己求交。
 */
export const PLATES = { camera: [0, 0, 3], fovY: 0.6, tilt: 0.3, backAt: -1, front: [[-3, -3], [0.25, -3], [-0.25, 3], [-3, 3]] };
export function platesPack({ worldVisible = true } = {}) {
  const front = { name: 'front', positions: PLATES.front.flatMap(([x, y]) => [x, y, 0]), normals: Array(4).fill([0, 0, 1]).flat(), indices: [0, 1, 2, 0, 2, 3] };
  const back = { name: 'back', positions: [-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0], normals: Array(4).fill([0, 0, 1]).flat(), indices: [0, 1, 2, 0, 2, 3] };
  const [c, s] = [Math.cos(PLATES.tilt), Math.sin(PLATES.tilt)];
  const rows = [[0, 0, 1, 0], [1, 0, 2, 0]];
  const manifest = {
    format: 'scene-pack/0.1',
    id: 'pack:chassis-plates@1',
    units: UNITS,
    geometry: { file: 'geometry.glb', meshes: [back, front].map(mesh) },
    instances: { file: 'instances.u32', shape: [2, 4], names: ['back', 'front'], class: ['part', 'part'] },
    materials: [{ name: 'matte', closure: 'surface', params: { baseColor: [0.8, 0.8, 0.8], metallic: 0, roughness: 1 } }],
    lights: [{ name: 'key', type: 'area-rect', size: [1, 1], watts: 30, color: [1, 1, 1], visibleToCamera: false }],
    world: { color: [0.2, 0.2, 0.2], visibleToCamera: worldVisible },
    camera: { type: 'persp', near: 0.05, far: 50 },
    frames: {
      count: 1,
      instances: { file: 'frames/instances.f32', shape: [1, 2, 16], fields: ['mat16'] },
      camera: { file: 'frames/camera.f32', shape: [1, 17], fields: ['mat16', 'fovY'] },
      lights: { file: 'frames/lights.f32', shape: [1, 1, 16], fields: ['mat16'] },
    },
    source: SOURCE,
  };
  const tilted = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, PLATES.backAt, 1];
  return { manifest, meshes: [back, front], rows, tables: { instances: [...tilted, ...IDENTITY], camera: [...translate(...PLATES.camera), PLATES.fovY], lights: translate(0, 0, 2) } };
}

// ------------------------------------------------------------------------------------------------ 必填字段

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const deref = (root, ref) => ref.replace(/^#\//, '').split('/').reduce((s, k) => s[k], root);
const join = (at, k) => (at ? `${at}.${k}` : k);

/** 结构定义里 if 用到的那几样关键字（const、required、properties、not、contains）：v 满不满足 s */
function matches(s, v, root) {
  if (s.$ref && !matches(deref(root, s.$ref), v, root)) return false;
  if ('const' in s && !same(s.const, v)) return false;
  if (s.required && !(isObject(v) && s.required.every(k => k in v))) return false;
  if (s.properties && isObject(v) && !Object.entries(s.properties).every(([k, p]) => !(k in v) || matches(p, v[k], root))) return false;
  if (s.not && matches(s.not, v, root)) return false;
  if (s.contains && !(Array.isArray(v) && v.some(x => matches(s.contains, x, root)))) return false;
  return true;
}

/** 照结构定义走一遍 value：凡是某一层的 required（含 if / then / else、allOf、$ref 里的）列到、value 里又有的字段，记下它的路径 */
export function requiredPaths(schema, value) {
  const out = new Set();
  const walk = (s, v, at) => {
    if (s.$ref) walk(deref(schema, s.$ref), v, at);
    if (s.required && isObject(v)) for (const k of s.required) if (k in v) out.add(join(at, k));
    if (s.properties && isObject(v)) for (const [k, p] of Object.entries(s.properties)) if (k in v) walk(p, v[k], join(at, k));
    if (s.items && Array.isArray(v)) v.forEach((x, i) => walk(s.items, x, `${at}[${i}]`));
    for (const a of s.allOf ?? []) walk(a, v, at);
    if (s.if) {
      const branch = matches(s.if, v, schema) ? s.then : s.else;
      if (branch) walk(branch, v, at);
    }
  };
  walk(schema, value, '');
  return [...out];
}

/** 按 requiredPaths 的路径（如 lights[2].watts）删掉清单里的那个字段，返回删过的副本 */
export function withoutField(manifest, at) {
  const copy = JSON.parse(JSON.stringify(manifest));
  const keys = at.match(/[^.[\]]+/g).map(k => (/^\d+$/.test(k) ? Number(k) : k));
  const parent = keys.slice(0, -1).reduce((o, k) => o[k], copy);
  delete parent[keys.at(-1)];
  return copy;
}
