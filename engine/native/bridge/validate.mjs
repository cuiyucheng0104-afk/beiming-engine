#!/usr/bin/env node
// 北冥引擎 · 原生层 · 资产桥：GLB 二进制结构检查（Node，不依赖浏览器和 three）。
// 检查文件大小、glTF 2 头部与分块、**全部**访问器（含 TEXCOORD_n、COLOR_n、蒙皮逆绑定矩阵、morph、动画）：
// bufferView 落在 buffer 内、访问器落在自己的 bufferView 内（不是整个 BIN 块）、分量类型合法、浮点值有限；
// 索引越界、蒙皮权重和、关节号越界、逆绑定矩阵数与关节数一致、内嵌纹理、PBR 材质、
// 动画名 / 时长 / 严格递增时间 / 首尾一致（循环片段）。缺必需属性时给出带名字的说明，不抛 TypeError。
// 由 examples/raea/tools/export-kun-validate.mjs 通用化而来。
//
//   validateGLB(path, expect) → 结构摘要 { bytes, megabytes, sceneTriangles, vertices, nodes, materials, embeddedTextures,
//                                           skinnedMeshes, morphMeshes, jointCount, extensionsUsed, animations, meshBreakdown, accessorsChecked }
//   validateGLBBuffer(buf, expect)  同上，输入是字节（测试用）
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
//   命令行：node engine/native/bridge/validate.mjs <x.glb> [--expect '{"animated":true,"clip":"Swim"}'] [--json]
//   退出码：0 通过 · 2 用法（缺参数、文件不存在、--expect 不是 JSON）· 4 结构检查不通过
import { readFile } from 'node:fs/promises';
import { EXIT, bind, exitWith, fail, log } from '../cli.mjs';
import { defineCommand, isMain, runCli } from '../../../tools/lib/cli.mjs';

class GLBError extends Error {}
const check = (ok, message) => { if (!ok) throw new GLBError(message); };

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const WIDTHS = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const READ = { 5120: 'readInt8', 5121: 'readUInt8', 5122: 'readInt16LE', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

export async function validateGLB(path, expect = {}) {
  let file;
  try { file = await readFile(path); } catch (e) { throw new GLBError(`读不了 ${path}：${e.code || e.message}`); }
  return validateGLBBuffer(file, expect);
}

export function validateGLBBuffer(file, { maxBytes = 20_000_000, animated = false, clip, duration, loop = true, nodes = [], skinnedMin = 0, skinnedNodes = [], notAnimated = [], pbr = true } = {}) {
  check(file.length < maxBytes, `文件 ${file.length} 字节，超过上限 ${maxBytes}`);
  check(file.length >= 20, '文件太短，不是 GLB');
  check(file.readUInt32LE(0) === 0x46546c67, '不是二进制 glTF（GLB 魔数不对）');
  check(file.readUInt32LE(4) === 2, `glTF 版本是 ${file.readUInt32LE(4)}，要求 2`);
  check(file.readUInt32LE(8) === file.length, '头部记录的长度与文件长度不符（文件被截断？）');
  let gltf, binary;
  for (let offset = 12; offset < file.length;) {
    check(offset + 8 <= file.length, '分块头越界');
    const length = file.readUInt32LE(offset), type = file.readUInt32LE(offset + 4);
    check(offset + 8 + length <= file.length, '分块长度越界');
    const chunk = file.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) { try { gltf = JSON.parse(chunk.toString()); } catch (e) { throw new GLBError(`JSON 分块不是合法 JSON：${e.message}`); } }
    if (type === 0x004e4942) binary = chunk;
    offset += length + 8;
  }
  check(gltf, '缺 JSON 分块');
  check(!gltf.extensionsRequired?.length, `用了必需扩展 ${gltf.extensionsRequired?.join('、')}（原生端不保证支持压缩 / 厂商扩展）`);
  const accessors = gltf.accessors || [], views = gltf.bufferViews || [];
  check(!(gltf.buffers || []).some(b => b.uri), '有外部 buffer（GLB 应自包含）');
  const bufLen = binary?.length ?? 0;
  views.forEach((v, i) => {
    check(v.buffer === 0, `bufferView ${i} 不在内嵌 BIN 里`);
    check((v.byteOffset || 0) + v.byteLength <= bufLen, `bufferView ${i} 越出 BIN 块（${(v.byteOffset || 0) + v.byteLength} > ${bufLen}）`);
  });

  // 逐个访问器：落在自己的 bufferView 内、分量类型合法、浮点值有限
  const cache = new Map();
  const values = i => {
    if (cache.has(i)) return cache.get(i);
    const a = accessors[i];
    check(a, `访问器 ${i} 不存在`);
    const n = COMPONENTS[a.type], width = WIDTHS[a.componentType];
    check(n && width, `访问器 ${i} 的类型 ${a.type} / 分量 ${a.componentType} 不合法`);
    check(!a.sparse, `访问器 ${i} 是 sparse（不支持）`);
    check(Number.isInteger(a.count) && a.count >= 0, `访问器 ${i} 的 count 不合法`);
    const out = new Float64Array(a.count * n);
    if (a.bufferView === undefined) { cache.set(i, out); return out; }   // 规范允许：全 0
    const view = views[a.bufferView];
    check(view, `访问器 ${i} 指向不存在的 bufferView ${a.bufferView}`);
    const elem = n * width, stride = view.byteStride || elem;
    check(stride >= elem, `访问器 ${i} 的 byteStride ${stride} 小于元素大小 ${elem}`);
    const off = a.byteOffset || 0;
    check(a.count === 0 || off + (a.count - 1) * stride + elem <= view.byteLength, `访问器 ${i} 越出自己的 bufferView ${a.bufferView}（需要 ${off + (a.count - 1) * stride + elem} 字节，view 只有 ${view.byteLength}）`);
    const start = (view.byteOffset || 0) + off;
    for (let row = 0; row < a.count; row++) for (let k = 0; k < n; k++) {
      const value = binary[READ[a.componentType]](start + row * stride + k * width);
      check(Number.isFinite(value), `访问器 ${i}（${a.name || a.type}）第 ${row} 项不是有限数`);
      out[row * n + k] = a.normalized ? Math.max(value / NORM[a.componentType], -1) : value;
    }
    cache.set(i, out);
    return out;
  };
  for (let i = 0; i < accessors.length; i++) values(i);

  const meshName = (node, mi) => node?.name || gltf.meshes[mi]?.name || `mesh ${mi}`;
  let sceneTriangles = 0, vertices = 0, skinnedMeshes = 0, morphMeshes = 0;
  const meshBreakdown = [];
  for (const node of gltf.nodes || []) if (node.mesh !== undefined) {
    let triangles = 0;
    const mesh = gltf.meshes[node.mesh];
    check(mesh, `节点 ${node.name} 指向不存在的网格 ${node.mesh}`);
    for (const p of mesh.primitives) {
      const label = meshName(node, node.mesh);
      check((p.mode ?? 4) === 4, `${label}：只支持三角形图元（mode 4）`);
      check(p.attributes?.POSITION !== undefined, `${label}：缺 POSITION 属性`);
      const count = accessors[p.attributes.POSITION].count;
      for (const [attr, ai] of Object.entries(p.attributes)) check(accessors[ai]?.count === count, `${label}：属性 ${attr} 的顶点数 ${accessors[ai]?.count} 与 POSITION 的 ${count} 不符`);
      vertices += count;
      if (p.indices !== undefined) { const indices = values(p.indices); for (const ix of indices) check(ix < count, `${label}：索引 ${ix} 越界（只有 ${count} 个顶点）`); triangles += indices.length / 3; }
      else triangles += count / 3;
      if (node.skin !== undefined) {
        const skin = gltf.skins?.[node.skin];
        check(skin, `${label}：指向不存在的 skin ${node.skin}`);
        check(p.attributes.WEIGHTS_0 !== undefined && p.attributes.JOINTS_0 !== undefined, `${label}：蒙皮网格缺 WEIGHTS_0 / JOINTS_0`);
        const w = values(p.attributes.WEIGHTS_0), j = values(p.attributes.JOINTS_0);
        for (let v = 0; v < count; v++) {
          check(Math.abs(w[v * 4] + w[v * 4 + 1] + w[v * 4 + 2] + w[v * 4 + 3] - 1) < 2e-3, `${label}：第 ${v} 个顶点的蒙皮权重和不是 1`);
          for (let k = 0; k < 4; k++) check(j[v * 4 + k] < skin.joints.length, `${label}：第 ${v} 个顶点引用了不存在的关节 ${j[v * 4 + k]}`);
        }
      }
      for (const t of p.targets || []) for (const [attr, ai] of Object.entries(t)) check(accessors[ai]?.count === count, `${label}：morph 属性 ${attr} 顶点数不符`);
    }
    sceneTriangles += triangles;
    if (node.skin !== undefined) skinnedMeshes++;
    if (mesh.primitives.some(p => p.targets?.length)) morphMeshes++;
    meshBreakdown.push({ name: node.name, triangles });
  }
  for (const [si, skin] of (gltf.skins || []).entries()) {
    for (const j of skin.joints) check(gltf.nodes?.[j], `skin ${si} 引用了不存在的节点 ${j}`);
    if (skin.inverseBindMatrices !== undefined) {
      const a = accessors[skin.inverseBindMatrices];
      check(a?.type === 'MAT4', `skin ${si} 的逆绑定矩阵不是 MAT4`);
      check(a.count === skin.joints.length, `skin ${si}：逆绑定矩阵 ${a.count} 个，关节 ${skin.joints.length} 个`);
    }
  }
  const animations = (gltf.animations || []).map((a, ai) => {
    let dur = 0, maxLoopError = 0;
    const paths = {}, targets = [];
    for (const c of a.channels) {
      const s = a.samplers[c.sampler];
      check(s, `动画 ${a.name || ai} 的通道引用了不存在的 sampler`);
      check(gltf.nodes?.[c.target.node], `动画 ${a.name || ai} 的通道指向不存在的节点 ${c.target.node}`);
      const times = values(s.input), data = values(s.output);
      check(times.length > 0 && times[0] === 0, `动画 ${a.name || ai}：时间要从 0 开始`);
      for (let i = 1; i < times.length; i++) check(times[i] > times[i - 1], `动画 ${a.name || ai}：时间不是严格递增`);
      dur = Math.max(dur, times[times.length - 1]);
      const width = data.length / times.length;
      for (let k = 0; k < width; k++) maxLoopError = Math.max(maxLoopError, Math.abs(data[k] - data[data.length - width + k]));
      paths[c.target.path] = (paths[c.target.path] || 0) + 1;
      targets.push({ name: gltf.nodes[c.target.node].name, path: c.target.path, keys: times.length, interpolation: s.interpolation || 'LINEAR' });
    }
    if (loop) check(maxLoopError < 1e-6, `动画 ${a.name || ai} 首尾值不一致（${maxLoopError}）：循环动作的最后一帧要回到第一帧`);
    return { name: a.name, duration: dur, channels: a.channels.length, paths, maxLoopError, targets };
  });
  if (pbr) for (const material of gltf.materials || []) {
    check(material.pbrMetallicRoughness, `材质 ${material.name} 不是普通 PBR`);
    check(!material.extensions?.KHR_materials_unlit, `材质 ${material.name} 是 unlit`);
  }
  for (const image of gltf.images || []) check(image.bufferView !== undefined && !image.uri, `贴图 ${image.name || ''} 没有内嵌（GLB 要自包含）`);
  if (animated) {
    check(animations.length === 1, `要求恰好一段动画，实际 ${animations.length} 段`);
    if (clip !== undefined) check(animations[0].name === clip, `动画名是 ${animations[0].name}，要求 ${clip}`);
    if (duration !== undefined) check(animations[0].duration === duration, `动画时长 ${animations[0].duration}，要求 ${duration}`);
    check(skinnedMeshes >= skinnedMin, `蒙皮网格 ${skinnedMeshes} 个，要求至少 ${skinnedMin}`);
    const names = animations[0].targets.map(t => t.name);
    for (const n of nodes) check(names.includes(n), `缺节点 ${n} 的动画通道`);
    for (const n of skinnedNodes) check((gltf.nodes || []).some(x => x.name === n && x.skin !== undefined), `节点 ${n} 没有蒙皮`);
    for (const n of notAnimated) check(!names.includes(n), `节点 ${n} 不允许有动画通道`);
  }
  return { bytes: file.length, megabytes: file.length / 1e6, sceneTriangles, vertices, nodes: gltf.nodes?.length || 0, materials: gltf.materials?.length || 0, embeddedTextures: gltf.images?.length || 0, skinnedMeshes, morphMeshes, jointCount: gltf.skins?.[0]?.joints.length || 0, extensionsUsed: gltf.extensionsUsed || [], animations, meshBreakdown, accessorsChecked: accessors.length };
}

export const command = defineCommand({
  name: 'native:validate',
  summary: 'GLB 二进制结构检查（不依赖浏览器和 three）',
  usage: ["node engine/native/bridge/validate.mjs <x.glb> [--expect '<JSON>'] [--json]"],
  description: '--expect 的字段见文件开头注释：animated、clip、duration、loop、nodes、skinnedMin、skinnedNodes、notAnimated、pbr、maxBytes。',
  positionals: [{ name: 'glb', label: '<x.glb>', describe: '要检查的 GLB 文件' }],
  options: { expect: { type: 'string', arg: '<JSON>', describe: '结构期望（JSON），例 \'{"animated":true,"clip":"Swim"}\'' } },
  exitCodes: { 0: '通过', 2: '用法错误（缺参数、文件不存在、--expect 不是 JSON）', 4: '结构检查不通过' },
  async run(ctx) {
    bind(ctx);
    const file = ctx.args.glb;
    let expect = {};
    if (ctx.opts.expect) { try { expect = JSON.parse(ctx.opts.expect); } catch (e) { throw fail(EXIT.USAGE, 'bad-value', `--expect 不是合法 JSON：${e.message}`, '例：--expect \'{"animated":true,"clip":"Idle"}\''); } }
    let summary;
    try { summary = await validateGLB(file, expect); }
    catch (e) {
      if (/读不了/.test(e.message)) throw fail(EXIT.USAGE, 'no-file', e.message, '确认文件路径（相对当前目录）');
      throw fail(EXIT.CONTRACT, 'glb', `${file} 结构检查不通过：${e.message}`, '修好导出脚本或模型后重导');
    }
    log(JSON.stringify(summary, null, 2));
    log(`通过：${summary.sceneTriangles} 三角面，${summary.accessorsChecked} 个访问器，${summary.animations.length} 段动画`);
    return { data: summary };
  },
});

if (isMain(import.meta.url)) await exitWith(runCli(command));
