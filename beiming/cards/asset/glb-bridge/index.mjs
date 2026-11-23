// asset.glb-bridge 在 three 帧源里的实现：
// 1. 生成或解析符合 glTF 2.0 二进制规范（魔数 0x46546C67、版本 2、JSON 与 BIN 块 4 字节对齐）的 GLB 字节流；
// 2. 校验零件命名完整性（期望零件齐全、无重名节点、无匿名网格节点）以及右手系、+Y 向上、1 单位 = 1 米约定；
// 3. 将多零件层级装入 three 的 Group / Mesh 树，交出根实体与各零件子实体，供镜头按零件独立驱动动画并由宿主测定屏幕锚点。

const node = globalThis.process;
const isProxy = node?.versions?.node
  ? (node.getBuiltinModule?.('node:util/types') ?? await import('node:util/types')).isProxy
  : () => false;

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"
const PART_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const NODE_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]*$/;

const fail = (message) => {
  throw Object.assign(new RangeError(`asset.glb-bridge：${message}`), { code: 'usage.bad-argument' });
};

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || isProxy(v) || Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function snapValue(what, v, depth = 0) {
  if (depth > 16) fail(`${what} 嵌套层级过深`);
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${what} 必须是有限数，给的是 ${v}`);
    return v;
  }
  if (typeof v !== 'object') fail(`${what} 类型不合法（${typeof v}）`);
  if (isProxy(v)) fail(`${what} 不能是 Proxy`);
  if (v instanceof Uint8Array) {
    if (isProxy(v.buffer) || Object.getPrototypeOf(v) !== Uint8Array.prototype) fail(`${what} 必须是原生 Uint8Array`);
    return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  }
  if (v instanceof ArrayBuffer) {
    if (Object.getPrototypeOf(v) !== ArrayBuffer.prototype) fail(`${what} 必须是原生 ArrayBuffer`);
    return new Uint8Array(v.slice(0));
  }
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) fail(`${what} 必须是普通数组`);
    const props = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(props);
    const n = props.length?.value;
    if (!Number.isInteger(n) || keys.length !== n + 1) fail(`${what} 不能是稀疏数组或带额外属性`);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = props[i];
      if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail(`${what}[${i}] 必须是可枚举的自有数据属性`);
      out[i] = snapValue(`${what}[${i}]`, d.value, depth + 1);
    }
    return out;
  }
  if (!isPlainObject(v)) fail(`${what} 必须是普通对象`);
  const props = Object.getOwnPropertyDescriptors(v);
  const keys = Reflect.ownKeys(props);
  const out = {};
  for (const k of keys) {
    if (typeof k !== 'string') fail(`${what} 不能包含 Symbol 键`);
    const d = props[k];
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail(`${what}.${k} 不能是访问器或不可枚举属性`);
    out[k] = snapValue(`${what}.${k}`, d.value, depth + 1);
  }
  return out;
}

function checkAllowedKeys(what, obj, allowed) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${what} 包含未声明的键 ${JSON.stringify(k)}`);
  }
}

const DEFAULT_PART_BBOX = {
  body: [-0.135, -0.058, -0.022, 0.135, 0.058, 0.022],
  fan_L: [-0.105, -0.042, 0.022, -0.015, 0.042, 0.032],
  fan_R: [0.015, -0.042, 0.022, 0.105, 0.042, 0.032],
};

function boxVertices([x0, y0, z0, x1, y1, z1]) {
  return new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
}

const BOX_INDICES = new Uint16Array([
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4,
  2, 3, 7, 2, 7, 6,
  0, 4, 7, 0, 7, 3,
  1, 2, 6, 1, 6, 5,
]);

function normalizePartEntry(entry, index) {
  if (typeof entry === 'string') {
    if (entry.length === 0) return { name: '', kind: 'mesh', bbox: [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05], translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    if (!NODE_NAME_RE.test(entry)) fail(`parts[${index}] 名称 ${JSON.stringify(entry)} 不合法`);
    const short = entry.includes('.') ? entry.split('.').pop() : entry;
    const bbox = DEFAULT_PART_BBOX[short] ?? [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05];
    return { name: entry, kind: 'mesh', bbox: [...bbox], translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  }
  if (!isPlainObject(entry)) fail(`parts[${index}] 必须是字符串或普通对象`);
  checkAllowedKeys(`parts[${index}]`, entry, ['name', 'kind', 'parent', 'translation', 'rotation', 'scale', 'bbox']);
  const name = entry.name ?? '';
  if (typeof name !== 'string') fail(`parts[${index}].name 必须是字符串`);
  if (name !== '' && !NODE_NAME_RE.test(name)) fail(`parts[${index}].name ${JSON.stringify(name)} 不合法`);
  const kind = entry.kind ?? 'mesh';
  if (kind !== 'mesh' && kind !== 'group') fail(`parts[${index}].kind 只能是 "mesh" 或 "group"`);
  const short = name.includes('.') ? name.split('.').pop() : name;
  const bbox = entry.bbox ?? DEFAULT_PART_BBOX[short] ?? [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05];
  if (!Array.isArray(bbox) || bbox.length !== 6 || !(bbox[0] < bbox[3] && bbox[1] < bbox[4] && bbox[2] < bbox[5])) {
    fail(`parts[${index}].bbox 必须是 [minX, minY, minZ, maxX, maxY, maxZ] 且 min < max`);
  }
  const translation = entry.translation ?? [0, 0, 0];
  const rotation = entry.rotation ?? [0, 0, 0, 1];
  const scale = entry.scale ?? [1, 1, 1];
  if (!Array.isArray(translation) || translation.length !== 3) fail(`parts[${index}].translation 必须是长度为 3 的数组`);
  if (!Array.isArray(rotation) || rotation.length !== 4) fail(`parts[${index}].rotation 必须是长度为 4 的四元数数组`);
  if (!Array.isArray(scale) || scale.length !== 3 || scale.some((s) => s <= 0)) fail(`parts[${index}].scale 必须是 3 个正数`);
  if (entry.parent !== undefined && (typeof entry.parent !== 'string' || !NODE_NAME_RE.test(entry.parent))) {
    fail(`parts[${index}].parent 不合法`);
  }
  return { name, kind, parent: entry.parent, bbox, translation, rotation, scale };
}

/**
 * 构造符合 glTF 2.0 标准二进制结构的 GLB 字节数组（Uint8Array）。
 */
export function buildSyntheticGlb(rawSpec = {}) {
  const spec = snapValue('spec', rawSpec);
  if (!isPlainObject(spec)) fail('spec 必须是普通对象');
  checkAllowedKeys('spec', spec, ['alias', 'expectedParts', 'parts', 'upAxis', 'unitScale', 'hand', 'generator', 'prefixAlias']);

  const alias = spec.alias ?? 'gpu';
  if (typeof alias !== 'string' || !PART_NAME_RE.test(alias)) fail(`alias ${JSON.stringify(alias)} 不合法`);
  const upAxis = spec.upAxis ?? 'Y';
  if (upAxis !== 'Y' && upAxis !== 'Z') fail(`upAxis 只能是 "Y" 或 "Z"，给的是 ${JSON.stringify(upAxis)}`);
  const unitScale = spec.unitScale ?? 1;
  if (!(typeof unitScale === 'number' && unitScale > 0)) fail(`unitScale 必须是正数，给的是 ${unitScale}`);
  const hand = spec.hand ?? 'right';
  if (hand !== 'right' && hand !== 'left') fail(`hand 只能是 "right" 或 "left"`);
  const prefixAlias = spec.prefixAlias === true;

  const rawList = spec.parts ?? spec.expectedParts ?? ['body', 'fan_L', 'fan_R'];
  if (!Array.isArray(rawList) || rawList.length < 1) fail('parts 或 expectedParts 至少要有一项');
  const entries = rawList.map((item, idx) => normalizePartEntry(item, idx));

  const meshes = [];
  const accessors = [];
  const bufferViews = [];
  const binChunks = [];
  let binOffset = 0;

  const nodes = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const nodeName = e.name === '' ? '' : (prefixAlias && !e.name.includes('.') ? `${alias}.${e.name}` : e.name);
    const node = {
      ...(nodeName !== '' ? { name: nodeName } : {}),
      translation: e.translation,
      rotation: e.rotation,
      scale: e.scale,
    };
    if (e.kind === 'mesh') {
      const verts = boxVertices(e.bbox);
      const vertBytes = new Uint8Array(verts.buffer, verts.byteOffset, verts.byteLength);
      const idxBytes = new Uint8Array(BOX_INDICES.buffer, BOX_INDICES.byteOffset, BOX_INDICES.byteLength);

      const posViewIndex = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: vertBytes.byteLength, target: 34962 });
      binChunks.push(vertBytes);
      binOffset += vertBytes.byteLength;

      const idxViewIndex = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: idxBytes.byteLength, target: 34963 });
      binChunks.push(idxBytes);
      binOffset += idxBytes.byteLength;

      const pad = (4 - (binOffset % 4)) % 4;
      if (pad > 0) {
        binChunks.push(new Uint8Array(pad));
        binOffset += pad;
      }

      const posAccessorIndex = accessors.length;
      accessors.push({
        bufferView: posViewIndex,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: 8,
        type: 'VEC3',
        min: [e.bbox[0], e.bbox[1], e.bbox[2]],
        max: [e.bbox[3], e.bbox[4], e.bbox[5]],
      });

      const idxAccessorIndex = accessors.length;
      accessors.push({
        bufferView: idxViewIndex,
        byteOffset: 0,
        componentType: 5123, // UNSIGNED_SHORT
        count: BOX_INDICES.length,
        type: 'SCALAR',
        min: [0],
        max: [7],
      });

      const meshIndex = meshes.length;
      meshes.push({
        ...(nodeName !== '' ? { name: nodeName } : {}),
        primitives: [{ attributes: { POSITION: posAccessorIndex }, indices: idxAccessorIndex, mode: 4 }],
      });
      node.mesh = meshIndex;
    }
    nodes.push(node);
  }

  // 构建父子关系与根节点索引
  const rootIndices = [];
  for (let i = 0; i < entries.length; i++) {
    const parentName = entries[i].parent;
    if (parentName !== undefined) {
      const pIdx = nodes.findIndex((n, idx) => idx !== i && (n.name === parentName || n.name === `${alias}.${parentName}`));
      if (pIdx < 0) fail(`节点 ${entries[i].name} 的父节点 ${parentName} 不存在`);
      nodes[pIdx].children = nodes[pIdx].children ?? [];
      nodes[pIdx].children.push(i);
    } else {
      rootIndices.push(i);
    }
  }

  const gltf = {
    asset: {
      version: '2.0',
      generator: typeof spec.generator === 'string' ? spec.generator : 'beiming-glb-bridge/1.0',
      extras: { alias, upAxis, unitScale, hand },
    },
    scene: 0,
    scenes: [{ name: alias, nodes: rootIndices }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binOffset }],
  };

  const encoder = new TextEncoder();
  const jsonRaw = encoder.encode(JSON.stringify(gltf));
  const jsonPad = (4 - (jsonRaw.byteLength % 4)) % 4;
  const jsonChunkLen = jsonRaw.byteLength + jsonPad;
  const binPad = (4 - (binOffset % 4)) % 4;
  const binChunkLen = binOffset + binPad;
  const totalLength = 12 + 8 + jsonChunkLen + (binChunkLen > 0 ? 8 + binChunkLen : 0);

  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLength, true);

  view.setUint32(12, jsonChunkLen, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonRaw, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonRaw.byteLength + i] = 0x20; // JSON 块用空格补齐 4 字节

  if (binChunkLen > 0) {
    const binHeaderOffset = 20 + jsonChunkLen;
    view.setUint32(binHeaderOffset, binChunkLen, true);
    view.setUint32(binHeaderOffset + 4, CHUNK_BIN, true);
    let cursor = binHeaderOffset + 8;
    for (const chunk of binChunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
  }
  return out;
}

function stripAliasPrefix(name, alias) {
  if (typeof name !== 'string' || name.length === 0) return '';
  if (alias && name.startsWith(`${alias}.`)) return name.slice(alias.length + 1);
  if (name.includes('.')) return name.split('.').pop();
  return name;
}

/**
 * 解析并检查 GLB 二进制（Uint8Array / ArrayBuffer）或 glTF 2.0 JSON 对象。
 */
export function inspectGlb(input) {
  if (input === null || input === undefined) fail('inspectGlb 输入不能为空');
  let gltf = null;
  let byteLength = 0;
  let hasBinChunk = false;
  let binByteLength = 0;

  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = snapValue('glbBytes', input);
    byteLength = bytes.byteLength;
    if (byteLength < 20) fail(`GLB 长度不足 20 字节（实际 ${byteLength}）`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== GLB_MAGIC) fail(`GLB 魔数错误：期望 0x46546c67 ("glTF")，实际 0x${magic.toString(16)}`);
    const version = view.getUint32(4, true);
    if (version !== GLB_VERSION) fail(`GLB 版本不支持：期望 2，实际 ${version}`);
    const declaredLen = view.getUint32(8, true);
    if (declaredLen !== byteLength) fail(`GLB 头部声明长度 ${declaredLen} 与实际字节数 ${byteLength} 不一致`);

    const jsonLen = view.getUint32(12, true);
    const jsonType = view.getUint32(16, true);
    if (jsonType !== CHUNK_JSON) fail(`GLB 首块必须是 JSON (0x4e4f534a)，实际 0x${jsonType.toString(16)}`);
    if (jsonLen % 4 !== 0 || 20 + jsonLen > byteLength) fail(`GLB JSON 块长度 ${jsonLen} 非 4 字节对齐或越界`);

    const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + jsonLen));
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      fail(`GLB JSON 块解析失败：${err.message}`);
    }
    gltf = snapValue('gltfJson', parsed);

    let offset = 20 + jsonLen;
    if (offset < byteLength) {
      if (offset + 8 > byteLength) fail('GLB BIN 块头部截断');
      const chunkLen = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      if (chunkType !== CHUNK_BIN) fail(`GLB 第二块必须是 BIN (0x004e4942)，实际 0x${chunkType.toString(16)}`);
      if (chunkLen % 4 !== 0 || offset + 8 + chunkLen > byteLength) fail(`GLB BIN 块长度 ${chunkLen} 越界或未对齐`);
      hasBinChunk = true;
      binByteLength = chunkLen;
    }
  } else {
    gltf = snapValue('gltfJson', input);
    if (!isPlainObject(gltf)) fail('inspectGlb 输入必须是 GLB 字节流或 glTF JSON 普通对象');
  }

  if (!isPlainObject(gltf.asset) || gltf.asset.version !== '2.0') {
    fail('glTF asset.version 必须是 "2.0"');
  }
  const extras = isPlainObject(gltf.asset.extras) ? gltf.asset.extras : {};
  const alias = typeof extras.alias === 'string' ? extras.alias : (gltf.scenes?.[0]?.name ?? 'asset');
  const upAxis = extras.upAxis ?? 'Y';
  const unitScale = extras.unitScale ?? 1;
  const hand = extras.hand ?? 'right';

  const rawNodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const rawMeshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  const rawAccessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];

  const parentOf = new Map();
  rawNodes.forEach((n, idx) => {
    if (Array.isArray(n?.children)) {
      for (const childIdx of n.children) parentOf.set(childIdx, idx);
    }
  });

  const nodes = [];
  const meshNodes = [];
  const unnamedMeshNodes = [];
  const seenNames = new Set();
  const duplicateNames = [];

  for (let i = 0; i < rawNodes.length; i++) {
    const n = rawNodes[i];
    if (!isPlainObject(n)) fail(`glTF nodes[${i}] 必须是普通对象`);
    const rawName = typeof n.name === 'string' ? n.name.trim() : '';
    const partName = stripAliasPrefix(rawName, alias);
    const hasMesh = Number.isInteger(n.mesh) && n.mesh >= 0 && n.mesh < rawMeshes.length;

    let bbox = [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05];
    if (hasMesh) {
      const mesh = rawMeshes[n.mesh];
      const posIdx = mesh?.primitives?.[0]?.attributes?.POSITION;
      const acc = Number.isInteger(posIdx) ? rawAccessors[posIdx] : null;
      if (Array.isArray(acc?.min) && acc.min.length === 3 && Array.isArray(acc?.max) && acc.max.length === 3) {
        bbox = [...acc.min, ...acc.max];
      }
    }

    const parentIdx = parentOf.get(i);
    const info = {
      index: i,
      name: rawName,
      partName,
      hasMesh,
      parent: parentIdx !== undefined ? (rawNodes[parentIdx]?.name ?? '') : null,
      translation: Array.isArray(n.translation) && n.translation.length === 3 ? [...n.translation] : [0, 0, 0],
      rotation: Array.isArray(n.rotation) && n.rotation.length === 4 ? [...n.rotation] : [0, 0, 0, 1],
      scale: Array.isArray(n.scale) && n.scale.length === 3 ? [...n.scale] : [1, 1, 1],
      bbox,
    };
    nodes.push(info);

    if (rawName === '') {
      if (hasMesh) unnamedMeshNodes.push(i);
    } else {
      if (seenNames.has(partName) || seenNames.has(rawName)) {
        if (!duplicateNames.includes(partName)) duplicateNames.push(partName);
      }
      seenNames.add(partName);
      seenNames.add(rawName);
    }
    if (hasMesh) meshNodes.push(info);
  }

  return {
    format: 'glb-inspection/0.1',
    version: 2,
    byteLength,
    hasBinChunk,
    binByteLength,
    alias,
    upAxis,
    unitScale,
    hand,
    nodes,
    meshNodes,
    partNames: meshNodes.filter((n) => n.partName !== '').map((n) => n.partName),
    unnamedMeshNodes,
    duplicateNames,
  };
}

/**
 * 核对 GLB 或节点树是否完整保留了期望零件列表与右手 Y 向上米制约定。
 */
export function verifyPartNames(input, rawExpectedParts, rawOpts = {}) {
  const expectedParts = snapValue('expectedParts', rawExpectedParts);
  const opts = snapValue('opts', rawOpts);
  if (!Array.isArray(expectedParts) || expectedParts.length < 1 || expectedParts.some((p) => typeof p !== 'string' || !PART_NAME_RE.test(p))) {
    fail('expectedParts 必须是非空的合法零件名数组');
  }
  if (new Set(expectedParts).size !== expectedParts.length) {
    fail('expectedParts 里不能有重复的零件名');
  }
  if (!isPlainObject(opts)) fail('opts 必须是普通对象');
  checkAllowedKeys('opts', opts, ['alias', 'strictParts', 'allowExtraParts', 'requireYUp', 'requireUnitMeter', 'throwOnError']);

  const inspection = isPlainObject(input) && input.format === 'glb-inspection/0.1'
    ? snapValue('inspection', input)
    : inspectGlb(input);

  const alias = opts.alias ?? inspection.alias;
  const strictParts = opts.strictParts ?? true;
  const allowExtraParts = opts.allowExtraParts ?? false;
  const requireYUp = opts.requireYUp ?? true;
  const requireUnitMeter = opts.requireUnitMeter ?? true;

  const actualParts = inspection.meshNodes
    .filter((n) => n.name !== '')
    .map((n) => stripAliasPrefix(n.name, alias));

  const matchedParts = expectedParts.filter((p) => actualParts.includes(p));
  const missingParts = expectedParts.filter((p) => !actualParts.includes(p));
  const extraParts = actualParts.filter((p) => !expectedParts.includes(p));
  const duplicateParts = [...inspection.duplicateNames];
  const unnamedNodes = [...inspection.unnamedMeshNodes];
  const coordErrors = [];

  if (requireYUp && inspection.upAxis !== 'Y') {
    coordErrors.push(`坐标系朝向错误：期望 +Y 向上，实际为 ${inspection.upAxis}`);
  }
  if (requireUnitMeter && inspection.unitScale !== 1) {
    coordErrors.push(`单位尺度错误：期望 1 单位 = 1 米（unitScale=1），实际为 ${inspection.unitScale}`);
  }
  if (inspection.hand !== 'right') {
    coordErrors.push(`手性错误：期望右手系（right），实际为 ${inspection.hand}`);
  }

  const ok = missingParts.length === 0
    && duplicateParts.length === 0
    && unnamedNodes.length === 0
    && coordErrors.length === 0
    && (!strictParts || allowExtraParts || extraParts.length === 0);

  const verdict = {
    ok,
    alias,
    upAxis: inspection.upAxis,
    unitScale: inspection.unitScale,
    expectedParts: [...expectedParts],
    actualParts,
    matchedParts,
    missingParts,
    extraParts,
    duplicateParts,
    unnamedNodes,
    coordErrors,
  };

  if (!ok && opts.throwOnError) {
    const reasons = [];
    if (missingParts.length) reasons.push(`缺少零件 ${missingParts.join('、')}`);
    if (!allowExtraParts && extraParts.length) reasons.push(`多出未声明零件 ${extraParts.join('、')}`);
    if (duplicateParts.length) reasons.push(`存在重名节点 ${duplicateParts.join('、')}`);
    if (unnamedNodes.length) reasons.push(`存在匿名网格节点（索引 ${unnamedNodes.join('、')}）`);
    if (coordErrors.length) reasons.push(coordErrors.join('；'));
    fail(`零件桥校验未通过：${reasons.join('；')}`);
  }

  return verdict;
}

function makeFallbackObject3D(name, isMesh = false, bbox = [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05]) {
  const children = [];
  const obj = {
    name,
    isObject3D: true,
    isGroup: !isMesh,
    isMesh,
    visible: true,
    parent: null,
    children,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; }, toArray() { return [this.x, this.y, this.z]; } },
    quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; }, toArray() { return [this.x, this.y, this.z, this.w]; } },
    scale: { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; }, toArray() { return [this.x, this.y, this.z]; } },
    userData: { bbox: [...bbox] },
    add(child) {
      child.parent = obj;
      children.push(child);
      return obj;
    },
    traverse(fn) {
      fn(obj);
      for (const c of children) c.traverse(fn);
    },
    dispose() {},
  };
  return obj;
}

function buildThreeHierarchy(THREE, inspection, alias, globalScale) {
  const disposables = [];
  const root = THREE ? new THREE.Group() : makeFallbackObject3D(alias, false);
  root.name = alias;
  root.scale.set(globalScale, globalScale, globalScale);

  const parts = {};
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const node of inspection.meshNodes) {
    const partName = stripAliasPrefix(node.name, alias);
    const [x0, y0, z0, x1, y1, z1] = node.bbox;
    minX = Math.min(minX, (x0 + node.translation[0]) * globalScale);
    minY = Math.min(minY, (y0 + node.translation[1]) * globalScale);
    minZ = Math.min(minZ, (z0 + node.translation[2]) * globalScale);
    maxX = Math.max(maxX, (x1 + node.translation[0]) * globalScale);
    maxY = Math.max(maxY, (y1 + node.translation[1]) * globalScale);
    maxZ = Math.max(maxZ, (z1 + node.translation[2]) * globalScale);

    let mesh;
    if (THREE) {
      const geometry = new THREE.BufferGeometry();
      const verts = boxVertices(node.bbox);
      const posArray = new Float32Array(BOX_INDICES.length * 3);
      for (let i = 0; i < BOX_INDICES.length; i++) {
        const vi = BOX_INDICES[i] * 3;
        posArray[i * 3] = verts[vi];
        posArray[i * 3 + 1] = verts[vi + 1];
        posArray[i * 3 + 2] = verts[vi + 2];
      }
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(posArray, 3));
      geometry.computeVertexNormals();
      const material = new THREE.MeshBasicMaterial({ color: 0xd8dee9 });
      mesh = new THREE.Mesh(geometry, material);
      disposables.push(geometry, material);
    } else {
      mesh = makeFallbackObject3D(partName, true, node.bbox);
    }
    mesh.name = partName;
    mesh.position.set(node.translation[0], node.translation[1], node.translation[2]);
    if (mesh.quaternion?.set) mesh.quaternion.set(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
    mesh.scale.set(node.scale[0], node.scale[1], node.scale[2]);
    mesh.userData = { ...(mesh.userData ?? {}), partName, nodeName: node.name, bbox: [...node.bbox] };
    root.add(mesh);
    parts[partName] = mesh;
  }

  const worldBbox = Number.isFinite(minX) ? [minX, minY, minZ, maxX, maxY, maxZ] : [0, 0, 0, 0, 0, 0];
  return { root, parts, worldBbox, disposables };
}

/**
 * 卡入口 create(ctx, params)
 */
export function create(rawCtx = {}, rawParams = {}) {
  if (rawCtx === null || typeof rawCtx !== 'object' || isProxy(rawCtx) || Array.isArray(rawCtx)) {
    fail('ctx 必须是普通对象');
  }
  const ctxProps = Object.getOwnPropertyDescriptors(rawCtx);
  for (const k of Reflect.ownKeys(ctxProps)) {
    if (typeof k !== 'string') fail('ctx 不能包含 Symbol 键');
    if (!Object.hasOwn(ctxProps[k], 'value') || !ctxProps[k].enumerable) fail(`ctx.${k} 必须是可枚举的自有数据属性`);
  }
  const THREE = ctxProps.THREE?.value;
  if (THREE !== undefined && (THREE === null || typeof THREE !== 'object' || isProxy(THREE))) {
    fail('ctx.THREE 必须是有效的渲染库对象');
  }

  const params = snapValue('params', rawParams);
  if (!isPlainObject(params)) fail('params 必须是普通对象');
  checkAllowedKeys('params', params, ['spec', 'strictParts', 'allowExtraParts', 'scale', 'glb']);

  const spec = params.spec ?? {
    alias: 'gpu',
    expectedParts: ['body', 'fan_L', 'fan_R'],
    upAxis: 'Y',
    unitScale: 1,
  };
  if (!isPlainObject(spec)) fail('params.spec 必须是普通对象');
  checkAllowedKeys('params.spec', spec, ['alias', 'expectedParts', 'parts', 'upAxis', 'unitScale']);

  const strictParts = params.strictParts ?? true;
  const allowExtraParts = params.allowExtraParts ?? false;
  const scale = params.scale ?? 1;
  if (typeof strictParts !== 'boolean') fail('params.strictParts 必须是布尔值');
  if (typeof allowExtraParts !== 'boolean') fail('params.allowExtraParts 必须是布尔值');
  if (!(typeof scale === 'number' && scale >= 0.001 && scale <= 1000)) fail(`params.scale 必须在 [0.001, 1000] 内，给的是 ${scale}`);

  const expectedParts = spec.expectedParts;
  if (!Array.isArray(expectedParts) || expectedParts.length < 1) fail('params.spec.expectedParts 必须是非空数组');

  const glbBytes = params.glb !== undefined
    ? snapValue('params.glb', params.glb)
    : buildSyntheticGlb({
      alias: spec.alias ?? 'gpu',
      expectedParts,
      parts: spec.parts ?? expectedParts,
      upAxis: spec.upAxis ?? 'Y',
      unitScale: spec.unitScale ?? 1,
      prefixAlias: true,
    });

  const inspection = inspectGlb(glbBytes);
  const verdict = verifyPartNames(inspection, expectedParts, {
    alias: spec.alias ?? inspection.alias,
    strictParts,
    allowExtraParts,
    requireYUp: true,
    requireUnitMeter: true,
    throwOnError: true,
  });

  const { root, parts, worldBbox, disposables } = buildThreeHierarchy(THREE, inspection, verdict.alias, scale);
  root.userData = { ...(root.userData ?? {}), parts, verdict, inspection, worldBbox };
  root.parts = parts;
  root.verdict = verdict;
  root.inspection = inspection;
  root.glbBytes = glbBytes instanceof Uint8Array ? glbBytes : null;
  root.worldBbox = worldBbox;

  const entities = {
    root: { object: root, root: true },
    ...Object.fromEntries(Object.entries(parts).map(([name, mesh]) => [name, mesh])),
  };

  return {
    object: root,
    entities,
    apply(f, sub = 0) {
      if (!Number.isInteger(f) || f < 0) fail(`帧号 f 必须是非负整数，给的是 ${f}`);
      if (!(typeof sub === 'number' && Number.isFinite(sub) && sub >= 0 && sub < 1)) fail(`子帧相位 sub 必须在 [0, 1) 内，给的是 ${sub}`);
      const t = f + sub;
      // 闭式位姿：每个零件的变换只由 t = f + sub 决定，无跨帧状态
      for (const node of inspection.meshNodes) {
        const partName = stripAliasPrefix(node.name, verdict.alias);
        const mesh = parts[partName];
        if (!mesh) continue;
        mesh.position.set(node.translation[0], node.translation[1], node.translation[2]);
      }
      return { t, partCount: verdict.matchedParts.length, bbox: [...worldBbox] };
    },
    meta(f) {
      if (!Number.isInteger(f) || f < 0) fail(`帧号 f 必须是非负整数，给的是 ${f}`);
      return {
        readings: {
          partCount: verdict.matchedParts.length,
          verified: verdict.ok ? 1 : 0,
          unitScale: inspection.unitScale,
        },
      };
    },
    dispose() {
      for (const d of disposables) d.dispose?.();
    },
  };
}
