// 北冥引擎 · 原生层 · 资产桥：GLB 二进制结构检查（Node，不依赖浏览器和 three）。
// 检查文件大小、glTF 2 头部、访问器与索引越界、有限值、蒙皮权重和、骨骼引用、内嵌纹理、PBR 材质、
// 动画名 / 时长 / 严格递增时间 / 首尾一致（循环片段）。由 examples/raea/tools/export-kun-validate.mjs 通用化而来。
//
//   validateGLB(path, expect) → 结构摘要 { bytes, megabytes, sceneTriangles, vertices, nodes, materials, embeddedTextures,
//                                           skinnedMeshes, morphMeshes, jointCount, extensionsUsed, animations, meshBreakdown }
//   expect = {
//     maxBytes = 20e6        文件上限（十进制字节）
//     animated = false       true 时要求恰好一段动画，并按下列字段核对
//     clip, duration         动画名与时长（秒）
//     loop = true            每条通道首尾值一致（误差 < 1e-6）；非循环动作写 false
//     nodes = []             必须有动画通道的节点名
//     skinnedMin = 0         至少多少个蒙皮网格
//     skinnedNodes = []      必须带 skin 的节点名
//     notAnimated = []       不允许有动画通道的节点名（例如不许用整体漂浮冒充形变）
//     pbr = true             材质必须是普通 PBR（非 unlit）
//   }
//   命令行：node engine/native/bridge/validate.mjs <x.glb> [--expect '{"animated":true,"clip":"Swim"}']
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export async function validateGLB(path, { maxBytes = 20_000_000, animated = false, clip, duration, loop = true, nodes = [], skinnedMin = 0, skinnedNodes = [], notAnimated = [], pbr = true } = {}) {
  const file = await readFile(path);
  assert(file.length < maxBytes, `Asset must be below ${maxBytes} bytes`);
  assert.equal(file.readUInt32LE(0), 0x46546c67, 'Not a binary glTF (GLB)');
  assert.equal(file.readUInt32LE(4), 2);
  assert.equal(file.readUInt32LE(8), file.length);
  let gltf, binary;
  for (let offset = 12; offset < file.length;) {
    const length = file.readUInt32LE(offset), type = file.readUInt32LE(offset + 4);
    const chunk = file.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) gltf = JSON.parse(chunk.toString());
    if (type === 0x004e4942) binary = chunk;
    offset += length + 8;
  }
  assert(gltf && binary);
  assert(!gltf.extensionsRequired?.length, 'No required vendor/compression extensions');
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const widths = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
  const read = { 5121: 'readUInt8', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' };
  const values = i => {
    const a = gltf.accessors[i], view = gltf.bufferViews[a.bufferView];
    assert(view && !a.sparse);
    const n = components[a.type], width = widths[a.componentType], stride = view.byteStride || width * n;
    assert(n && width);
    const start = (view.byteOffset || 0) + (a.byteOffset || 0);
    assert(start + (a.count - 1) * stride + n * width <= binary.length);
    const out = new Float64Array(a.count * n);
    for (let row = 0; row < a.count; row++) for (let k = 0; k < n; k++) {
      const value = binary[read[a.componentType]](start + row * stride + k * width);
      assert(Number.isFinite(value), `Nonfinite accessor ${i}`);
      out[row * n + k] = a.normalized ? value / (a.componentType === 5121 ? 255 : 65535) : value;
    }
    return out;
  };
  const cache = new Map();
  const get = i => { if (!cache.has(i)) cache.set(i, values(i)); return cache.get(i); };
  let sceneTriangles = 0, vertices = 0, skinnedMeshes = 0, morphMeshes = 0;
  const meshBreakdown = [];
  for (const node of gltf.nodes) if (node.mesh !== undefined) {
    let triangles = 0;
    const mesh = gltf.meshes[node.mesh];
    for (const p of mesh.primitives) {
      assert.equal(p.mode ?? 4, 4);
      const count = gltf.accessors[p.attributes.POSITION].count;
      get(p.attributes.POSITION); if (p.attributes.NORMAL !== undefined) get(p.attributes.NORMAL);
      vertices += count;
      if (p.indices !== undefined) { const indices = get(p.indices); for (const ix of indices) assert(ix < count); triangles += indices.length / 3; }
      else triangles += count / 3;
      if (node.skin !== undefined) {
        const w = get(p.attributes.WEIGHTS_0), j = get(p.attributes.JOINTS_0), skin = gltf.skins[node.skin];
        for (let v = 0; v < count; v++) {
          assert(Math.abs(w[v * 4] + w[v * 4 + 1] + w[v * 4 + 2] + w[v * 4 + 3] - 1) < 1e-5, 'Invalid skin weight sum');
          for (let k = 0; k < 4; k++) assert(j[v * 4 + k] < skin.joints.length);
        }
      }
      for (const t of p.targets || []) for (const a of Object.values(t)) get(a);
    }
    sceneTriangles += triangles;
    if (node.skin !== undefined) skinnedMeshes++;
    if (mesh.primitives.some(p => p.targets?.length)) morphMeshes++;
    meshBreakdown.push({ name: node.name, triangles });
  }
  const animations = (gltf.animations || []).map(a => {
    let duration = 0, maxLoopError = 0;
    const paths = {}, targets = [];
    for (const c of a.channels) {
      const s = a.samplers[c.sampler], times = get(s.input), data = get(s.output);
      assert.equal(times[0], 0);
      for (let i = 1; i < times.length; i++) assert(times[i] > times[i - 1]);
      duration = Math.max(duration, times[times.length - 1]);
      const width = data.length / times.length;
      for (let k = 0; k < width; k++) maxLoopError = Math.max(maxLoopError, Math.abs(data[k] - data[data.length - width + k]));
      paths[c.target.path] = (paths[c.target.path] || 0) + 1;
      targets.push({ name: gltf.nodes[c.target.node].name, path: c.target.path, keys: times.length, interpolation: s.interpolation || 'LINEAR' });
    }
    if (loop) assert(maxLoopError < 1e-6, 'Clip endpoints must match');
    return { name: a.name, duration, channels: a.channels.length, paths, maxLoopError, targets };
  });
  if (pbr) for (const material of gltf.materials || []) {
    assert(material.pbrMetallicRoughness, 'Expected plain PBR material');
    assert(!material.extensions?.KHR_materials_unlit, 'Unexpected unlit material');
  }
  for (const image of gltf.images || []) assert(image.bufferView !== undefined && !image.uri, 'Textures must be embedded');
  if (animated) {
    assert.equal(animations.length, 1, 'Expected exactly one animation clip');
    if (clip !== undefined) assert.equal(animations[0].name, clip);
    if (duration !== undefined) assert.equal(animations[0].duration, duration);
    assert(skinnedMeshes >= skinnedMin, `Expected at least ${skinnedMin} skinned meshes`);
    const names = animations[0].targets.map(t => t.name);
    for (const n of nodes) assert(names.includes(n), `Missing ${n} animation`);
    for (const n of skinnedNodes) assert(gltf.nodes.some(x => x.name === n && x.skin !== undefined), `Missing skin on ${n}`);
    for (const n of notAnimated) assert(!names.includes(n), `${n} must not be animated`);
  }
  return { bytes: file.length, megabytes: file.length / 1e6, sceneTriangles, vertices, nodes: gltf.nodes.length, materials: gltf.materials?.length || 0, embeddedTextures: gltf.images?.length || 0, skinnedMeshes, morphMeshes, jointCount: gltf.skins?.[0]?.joints.length || 0, extensionsUsed: gltf.extensionsUsed || [], animations, meshBreakdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--expect');
  console.log(JSON.stringify(await validateGLB(process.argv[2], i > 0 ? JSON.parse(process.argv[i + 1]) : {}), null, 2));
}
