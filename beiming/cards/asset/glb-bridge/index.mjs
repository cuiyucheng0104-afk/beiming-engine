// asset.glb-bridge 在 three 帧源里的实现：
// 1. 生成或解析符合 glTF 2.0 二进制规范（魔数 0x46546C67、版本 2、JSON 与 BIN 块 4 字节对齐）的 GLB 字节流；
// 2. 从 BIN 块按 bufferView 与 accessor 真实解码每个网格的顶点位置、法线、UV、索引及原始 PBR 材质，并按父子层级四元数/平移/缩放矩阵合成世界坐标与包围盒；
// 3. 校验零件命名完整性（期望零件齐全、无重名节点、无匿名网格节点、无循环父子引用与越界索引）以及右手系、+Y 向上、1 单位 = 1 米约定；
// 4. 将多零件层级真实装入 three 的父子 Group / Mesh 树（调用 updateMatrixWorld），交出根实体与各零件子实体，供镜头按零件独立驱动动画并由宿主测定屏幕锚点。

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"
const PART_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const NODE_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]*$/;

const COMPONENT_BYTES = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COUNTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const fail = (message) => {
  throw Object.assign(new RangeError(`asset.glb-bridge：${message}`), { code: 'usage.bad-argument' });
};

function safeShow(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `[${typeof v}]`;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function snapUint8Bytes(what, v) {
  if (v instanceof Uint8Array) {
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (v instanceof ArrayBuffer) {
    return new Uint8Array(v);
  }
  fail(`${what} 必须是 Uint8Array 或 ArrayBuffer`);
}

function snapValue(what, v, depth = 0) {
  if (depth > 16) fail(`${what} 嵌套层级过深`);
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${what} 必须是有限数，给的是 ${safeShow(v)}`);
    return v;
  }
  if (typeof v !== 'object') fail(`${what} 类型不合法（${typeof v}）`);
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    return snapUint8Bytes(what, v);
  }
  if (Array.isArray(v)) {
    const n = v.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      if (!(i in v)) fail(`${what} 不能是稀疏数组`);
      out[i] = snapValue(`${what}[${i}]`, v[i], depth + 1);
    }
    return out;
  }
  if (!isPlainObject(v)) fail(`${what} 必须是普通对象`);
  if (Object.getOwnPropertySymbols(v).length > 0) fail(`${what} 不能包含 Symbol 键`);
  const out = {};
  for (const k of Object.keys(v)) {
    out[k] = snapValue(`${what}.${k}`, v[k], depth + 1);
  }
  return out;
}

function checkAllowedKeys(what, obj, allowed) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${what} 包含未声明的键 ${JSON.stringify(k)}`);
  }
}

function decodeBase64Bytes(what, str) {
  if (typeof str !== 'string' || str.trim().length === 0) fail(`${what} base64 字符串不能为空`);
  let clean = str.trim();
  const dataPrefix = /^data:[^;,]+(?:;[^;,]+)*;base64,/i.exec(clean);
  if (dataPrefix) {
    clean = clean.slice(dataPrefix[0].length).trim();
  }
  if (clean.length < 4 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    fail(`${what} 不是合法的 base64 编码字符串`);
  }
  if (typeof globalThis.atob === 'function') {
    let binStr;
    try {
      binStr = globalThis.atob(clean);
    } catch {
      fail(`${what} base64 解码失败`);
    }
    const out = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) out[i] = binStr.charCodeAt(i);
    return out;
  }
  const buf = globalThis.Buffer.from(clean, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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

/**
 * 合成列主序 4x4 局部变换矩阵 M = T * R * S。
 */
function composeTrsMatrix(translation, rotation, scale) {
  const [tx, ty, tz] = translation;
  const [qx, qy, qz, qw] = rotation;
  const [sx, sy, sz] = scale;
  const len = Math.hypot(qx, qy, qz, qw);
  if (!(len > 1e-12)) fail('rotation 四元数模长不能为 0');
  const x = qx / len, y = qy / len, z = qz / len, w = qw / len;

  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function decomposeMat4(m) {
  if (!Array.isArray(m) || m.length !== 16 || m.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    fail('glTF node.matrix 必须是长度为 16 的有限数数组');
  }
  const tx = m[12], ty = m[13], tz = m[14];
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  if (!(sx > 1e-8 && sy > 1e-8 && sz > 1e-8)) fail('glTF node.matrix 包含退化的零缩放分量');

  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;

  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;

  const trace = r00 + r11 + r22;
  let qx, qy, qz, qw;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    qw = 0.25 / s;
    qx = (r21 - r12) * s;
    qy = (r02 - r20) * s;
    qz = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2.0 * Math.sqrt(1.0 + r00 - r11 - r22);
    qw = (r21 - r12) / s;
    qx = 0.25 * s;
    qy = (r01 + r10) / s;
    qz = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = 2.0 * Math.sqrt(1.0 + r11 - r00 - r22);
    qw = (r02 - r20) / s;
    qx = (r01 + r10) / s;
    qy = 0.25 * s;
    qz = (r12 + r21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + r22 - r00 - r11);
    qw = (r10 - r01) / s;
    qx = (r02 + r20) / s;
    qy = (r12 + r21) / s;
    qz = 0.25 * s;
  }
  const qLen = Math.hypot(qx, qy, qz, qw) || 1;
  return {
    translation: [tx, ty, tz],
    rotation: [qx / qLen, qy / qLen, qz / qLen, qw / qLen],
    scale: [sx, sy, sz],
  };
}

function multiplyMat4(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function transformPointMat4(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function computeBboxFromVertices(vertices, matrix = null) {
  if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length % 3 !== 0) {
    fail('网格顶点坐标数组长度必须是 3 的正整数倍');
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const pt = [vertices[i], vertices[i + 1], vertices[i + 2]];
    const [wx, wy, wz] = matrix ? transformPointMat4(matrix, pt) : pt;
    if (wx < minX) minX = wx;
    if (wy < minY) minY = wy;
    if (wz < minZ) minZ = wz;
    if (wx > maxX) maxX = wx;
    if (wy > maxY) maxY = wy;
    if (wz > maxZ) maxZ = wz;
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

function normalizeMaterialSpec(what, rawMat) {
  if (rawMat === undefined || rawMat === null) return null;
  if (!isPlainObject(rawMat)) fail(`${what} 必须是普通对象`);
  const name = typeof rawMat.name === 'string' ? rawMat.name : '';
  const pbr = isPlainObject(rawMat.pbrMetallicRoughness) ? rawMat.pbrMetallicRoughness : rawMat;
  if (rawMat.pbrMetallicRoughness !== undefined && !isPlainObject(rawMat.pbrMetallicRoughness)) {
    fail(`${what}.pbrMetallicRoughness 必须是普通对象`);
  }
  const baseColorFactor = pbr.baseColorFactor !== undefined ? pbr.baseColorFactor : [0.85, 0.87, 0.91, 1];
  if (!Array.isArray(baseColorFactor) || baseColorFactor.length !== 4 || baseColorFactor.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
    fail(`${what}.baseColorFactor 必须是 4 个 [0, 1] 内的有限数`);
  }
  const metallicFactor = pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1;
  if (typeof metallicFactor !== 'number' || !Number.isFinite(metallicFactor) || metallicFactor < 0 || metallicFactor > 1) {
    fail(`${what}.metallicFactor 必须是 [0, 1] 内的有限数`);
  }
  const roughnessFactor = pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1;
  if (typeof roughnessFactor !== 'number' || !Number.isFinite(roughnessFactor) || roughnessFactor < 0 || roughnessFactor > 1) {
    fail(`${what}.roughnessFactor 必须是 [0, 1] 内的有限数`);
  }
  const emissiveFactor = rawMat.emissiveFactor !== undefined ? rawMat.emissiveFactor : [0, 0, 0];
  if (!Array.isArray(emissiveFactor) || emissiveFactor.length !== 3 || emissiveFactor.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
    fail(`${what}.emissiveFactor 必须是 3 个 [0, 1] 内的有限数`);
  }
  const doubleSided = rawMat.doubleSided !== undefined ? rawMat.doubleSided : false;
  if (typeof doubleSided !== 'boolean') fail(`${what}.doubleSided 必须是布尔值`);
  const alphaMode = rawMat.alphaMode !== undefined ? rawMat.alphaMode : 'OPAQUE';
  if (!['OPAQUE', 'MASK', 'BLEND'].includes(alphaMode)) fail(`${what}.alphaMode 不合法`);
  const alphaCutoff = rawMat.alphaCutoff !== undefined ? rawMat.alphaCutoff : 0.5;
  if (typeof alphaCutoff !== 'number' || !Number.isFinite(alphaCutoff) || alphaCutoff < 0 || alphaCutoff > 1) {
    fail(`${what}.alphaCutoff 必须是 [0, 1] 内的有限数`);
  }
  return {
    name,
    baseColorFactor: [...baseColorFactor],
    metallicFactor,
    roughnessFactor,
    emissiveFactor: [...emissiveFactor],
    doubleSided,
    alphaMode,
    alphaCutoff,
  };
}

function normalizePartEntry(entry, index) {
  if (typeof entry === 'string') {
    if (entry.length === 0) {
      const bbox = [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05];
      return { name: '', kind: 'mesh', bbox, positions: [...boxVertices(bbox)], indices: [...BOX_INDICES], hasIndices: true, normals: null, uvs: null, material: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    }
    if (!NODE_NAME_RE.test(entry)) fail(`parts[${index}] 名称 ${JSON.stringify(entry)} 不合法`);
    const short = entry.includes('.') ? entry.split('.').pop() : entry;
    const bbox = DEFAULT_PART_BBOX[short] ?? [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05];
    return { name: entry, kind: 'mesh', bbox: [...bbox], positions: [...boxVertices(bbox)], indices: [...BOX_INDICES], hasIndices: true, normals: null, uvs: null, material: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  }
  if (!isPlainObject(entry)) fail(`parts[${index}] 必须是字符串或普通对象`);
  checkAllowedKeys(`parts[${index}]`, entry, ['name', 'kind', 'parent', 'translation', 'rotation', 'scale', 'bbox', 'positions', 'normals', 'uvs', 'indices', 'material']);
  const name = entry.name ?? '';
  if (typeof name !== 'string') fail(`parts[${index}].name 必须是字符串`);
  if (name !== '' && !NODE_NAME_RE.test(name)) fail(`parts[${index}].name ${JSON.stringify(name)} 不合法`);
  const kind = entry.kind ?? 'mesh';
  if (kind !== 'mesh' && kind !== 'group') fail(`parts[${index}].kind 只能是 "mesh" 或 "group"`);
  const short = name.includes('.') ? name.split('.').pop() : name;

  let positions = null;
  let indices = null;
  let hasIndices = false;
  let normals = null;
  let uvs = null;
  let bbox = null;

  if (entry.positions !== undefined) {
    if (!Array.isArray(entry.positions) || entry.positions.length < 9 || entry.positions.length % 3 !== 0 || entry.positions.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      fail(`parts[${index}].positions 必须是至少 3 个顶点的有限数数组（3N）`);
    }
    positions = [...entry.positions];
    bbox = computeBboxFromVertices(positions);
    const vCount = positions.length / 3;
    if (entry.indices !== undefined) {
      if (!Array.isArray(entry.indices) || entry.indices.length < 3 || entry.indices.length % 3 !== 0 || entry.indices.some((idx) => !Number.isInteger(idx) || idx < 0 || idx >= vCount)) {
        fail(`parts[${index}].indices 必须是合法的三角形顶点索引数组`);
      }
      indices = [...entry.indices];
      hasIndices = true;
    } else {
      indices = Array.from({ length: vCount }, (_, k) => k);
      hasIndices = false;
    }
  } else {
    bbox = entry.bbox ?? DEFAULT_PART_BBOX[short] ?? [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05];
    if (!Array.isArray(bbox) || bbox.length !== 6 || bbox.some((v) => typeof v !== 'number' || !Number.isFinite(v)) || !(bbox[0] < bbox[3] && bbox[1] < bbox[4] && bbox[2] < bbox[5])) {
      fail(`parts[${index}].bbox 必须是 [minX, minY, minZ, maxX, maxY, maxZ] 且 min < max`);
    }
    positions = [...boxVertices(bbox)];
    indices = [...BOX_INDICES];
    hasIndices = true;
  }

  if (entry.normals !== undefined) {
    if (!Array.isArray(entry.normals) || entry.normals.length !== positions.length || entry.normals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      fail(`parts[${index}].normals 长度必须与 positions 一致`);
    }
    normals = [...entry.normals];
  }
  if (entry.uvs !== undefined) {
    const vCount = positions.length / 3;
    if (!Array.isArray(entry.uvs) || entry.uvs.length !== vCount * 2 || entry.uvs.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      fail(`parts[${index}].uvs 长度必须为 2N`);
    }
    uvs = [...entry.uvs];
  }

  const material = normalizeMaterialSpec(`parts[${index}].material`, entry.material);

  const translation = entry.translation ?? [0, 0, 0];
  const rotation = entry.rotation ?? [0, 0, 0, 1];
  const scale = entry.scale ?? [1, 1, 1];
  if (!Array.isArray(translation) || translation.length !== 3 || translation.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    fail(`parts[${index}].translation 必须是长度为 3 的有限数数组`);
  }
  if (!Array.isArray(rotation) || rotation.length !== 4 || rotation.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    fail(`parts[${index}].rotation 必须是长度为 4 的四元数数组`);
  }
  if (!(Math.hypot(...rotation) > 1e-12)) fail(`parts[${index}].rotation 四元数模长不能为 0`);
  if (!Array.isArray(scale) || scale.length !== 3 || scale.some((s) => typeof s !== 'number' || !Number.isFinite(s) || s <= 0)) {
    fail(`parts[${index}].scale 必须是 3 个正数`);
  }
  if (entry.parent !== undefined && (typeof entry.parent !== 'string' || !NODE_NAME_RE.test(entry.parent))) {
    fail(`parts[${index}].parent 不合法`);
  }
  return { name, kind, parent: entry.parent, bbox, positions, indices, hasIndices, normals, uvs, material, translation, rotation, scale };
}

/**
 * 构造符合 glTF 2.0 标准二进制结构的 GLB 字节数组（Uint8Array）。
 */
export function buildSyntheticGlb(rawSpec = {}) {
  const spec = snapValue('spec', rawSpec);
  if (!isPlainObject(spec)) fail('spec 必须是普通对象');
  checkAllowedKeys('spec', spec, ['alias', 'expectedParts', 'parts', 'upAxis', 'unitScale', 'hand', 'prefixAlias', 'generator']);

  const alias = spec.alias ?? 'gpu';
  if (typeof alias !== 'string' || !PART_NAME_RE.test(alias)) fail(`alias ${safeShow(alias)} 不合法`);
  const upAxis = spec.upAxis ?? 'Y';
  if (upAxis !== 'Y' && upAxis !== 'Z') fail(`upAxis 只能是 "Y" 或 "Z"，给的是 ${safeShow(upAxis)}`);
  const unitScale = spec.unitScale ?? 1;
  if (!(typeof unitScale === 'number' && unitScale > 0)) fail(`unitScale 必须是正数，给的是 ${safeShow(unitScale)}`);
  const hand = spec.hand ?? 'right';
  if (hand !== 'right' && hand !== 'left') fail(`hand 只能是 "right" 或 "left"，给的是 ${safeShow(hand)}`);
  const prefixAlias = spec.prefixAlias ?? true;
  if (typeof prefixAlias !== 'boolean') fail('prefixAlias 必须是布尔值');

  const rawParts = spec.parts ?? spec.expectedParts ?? ['body', 'fan_L', 'fan_R'];
  if (!Array.isArray(rawParts) || rawParts.length < 1) fail('parts 必须是非空数组');
  const entries = rawParts.map((e, i) => normalizePartEntry(e, i));

  const nodes = [];
  const meshes = [];
  const materials = [];
  const accessors = [];
  const bufferViews = [];
  const binChunks = [];
  let binOffset = 0;

  function appendBufferView(bytes, target) {
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    binChunks.push(bytes);
    binOffset += bytes.byteLength;
    const pad = (4 - (binOffset % 4)) % 4;
    if (pad > 0) {
      binChunks.push(new Uint8Array(pad));
      binOffset += pad;
    }
    return viewIndex;
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const nodeName = e.name === ''
      ? ''
      : (prefixAlias && !e.name.includes('.') ? `${alias}.${e.name}` : e.name);

    const node = {
      ...(nodeName !== '' ? { name: nodeName } : {}),
      translation: e.translation,
      rotation: e.rotation,
      scale: e.scale,
    };

    if (e.kind === 'mesh') {
      const verts = new Float32Array(e.positions);
      const vertBytes = new Uint8Array(verts.buffer, verts.byteOffset, verts.byteLength);
      const posViewIndex = appendBufferView(vertBytes, 34962);
      const posAccessorIndex = accessors.length;
      accessors.push({
        bufferView: posViewIndex,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: verts.length / 3,
        type: 'VEC3',
        min: [e.bbox[0], e.bbox[1], e.bbox[2]],
        max: [e.bbox[3], e.bbox[4], e.bbox[5]],
      });

      const attributes = { POSITION: posAccessorIndex };

      if (e.normals) {
        const normArr = new Float32Array(e.normals);
        const normViewIndex = appendBufferView(new Uint8Array(normArr.buffer, normArr.byteOffset, normArr.byteLength), 34962);
        const normAccIndex = accessors.length;
        accessors.push({
          bufferView: normViewIndex,
          byteOffset: 0,
          componentType: 5126,
          count: normArr.length / 3,
          type: 'VEC3',
        });
        attributes.NORMAL = normAccIndex;
      }

      if (e.uvs) {
        const uvArr = new Float32Array(e.uvs);
        const uvViewIndex = appendBufferView(new Uint8Array(uvArr.buffer, uvArr.byteOffset, uvArr.byteLength), 34962);
        const uvAccIndex = accessors.length;
        accessors.push({
          bufferView: uvViewIndex,
          byteOffset: 0,
          componentType: 5126,
          count: uvArr.length / 2,
          type: 'VEC2',
        });
        attributes.TEXCOORD_0 = uvAccIndex;
      }

      const prim = { attributes, mode: 4 };

      if (e.hasIndices) {
        const idxs = new Uint16Array(e.indices);
        const idxBytes = new Uint8Array(idxs.buffer, idxs.byteOffset, idxs.byteLength);
        const idxViewIndex = appendBufferView(idxBytes, 34963);
        const idxAccessorIndex = accessors.length;
        let maxIdx = 0;
        for (let k = 0; k < idxs.length; k++) if (idxs[k] > maxIdx) maxIdx = idxs[k];
        accessors.push({
          bufferView: idxViewIndex,
          byteOffset: 0,
          componentType: 5123, // UNSIGNED_SHORT
          count: idxs.length,
          type: 'SCALAR',
          min: [0],
          max: [maxIdx],
        });
        prim.indices = idxAccessorIndex;
      }

      if (e.material) {
        const matIndex = materials.length;
        materials.push({
          ...(e.material.name ? { name: e.material.name } : {}),
          pbrMetallicRoughness: {
            baseColorFactor: e.material.baseColorFactor,
            metallicFactor: e.material.metallicFactor,
            roughnessFactor: e.material.roughnessFactor,
          },
          emissiveFactor: e.material.emissiveFactor,
          doubleSided: e.material.doubleSided,
          alphaMode: e.material.alphaMode,
          ...(e.material.alphaMode === 'MASK' ? { alphaCutoff: e.material.alphaCutoff } : {}),
        });
        prim.material = matIndex;
      }

      const meshIndex = meshes.length;
      meshes.push({
        ...(nodeName !== '' ? { name: nodeName } : {}),
        primitives: [prim],
      });
      node.mesh = meshIndex;
    }
    nodes.push(node);
  }

  // 构建父子关系与根节点索引，并做循环检测
  const rootIndices = [];
  const parentIndexMap = new Map();
  for (let i = 0; i < entries.length; i++) {
    const parentName = entries[i].parent;
    if (parentName !== undefined) {
      const pIdx = nodes.findIndex((n, idx) => idx !== i && (n.name === parentName || n.name === `${alias}.${parentName}`));
      if (pIdx < 0) fail(`节点 ${entries[i].name} 的父节点 ${parentName} 不存在`);
      nodes[pIdx].children = nodes[pIdx].children ?? [];
      nodes[pIdx].children.push(i);
      parentIndexMap.set(i, pIdx);
    } else {
      rootIndices.push(i);
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    let cur = i;
    const visited = new Set();
    while (parentIndexMap.has(cur)) {
      if (visited.has(cur)) fail('parts 父子层级存在循环引用');
      visited.add(cur);
      cur = parentIndexMap.get(cur);
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
    ...(materials.length > 0 ? { materials } : {}),
    accessors,
    bufferViews,
    ...(binOffset > 0 ? { buffers: [{ byteLength: binOffset }] } : {}),
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
  for (let i = 0; i < jsonPad; i++) out[20 + jsonRaw.byteLength + i] = 0x20;

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

function decodeFloatAccessor(accIdx, expectedType, minCount, rawAccessors, rawBufferViews, binBytes, isBinaryGlb) {
  if (!Number.isInteger(accIdx) || accIdx < 0 || accIdx >= rawAccessors.length) {
    fail(`mesh primitive 的 ${expectedType} accessor 索引 ${safeShow(accIdx)} 越界`);
  }
  const acc = rawAccessors[accIdx];
  if (!isPlainObject(acc)) fail(`accessors[${accIdx}] 必须是普通对象`);

  if (!isBinaryGlb && rawBufferViews.length === 0 && acc.bufferView === undefined && expectedType === 'VEC3') {
    if (Array.isArray(acc.min) && acc.min.length === 3 && Array.isArray(acc.max) && acc.max.length === 3) {
      const bbox = [...acc.min, ...acc.max];
      if (bbox.some((v) => typeof v !== 'number' || !Number.isFinite(v)) || !(bbox[0] < bbox[3] && bbox[1] < bbox[4] && bbox[2] < bbox[5])) {
        fail(`accessors[${accIdx}] 的 min/max 包围盒不合法`);
      }
      return { values: [...boxVertices(bbox)], bbox, synthesizedFromBounds: true };
    }
    fail(`accessors[${accIdx}] 缺少 bufferView 或合法的 min/max`);
  }

  const numComps = TYPE_COUNTS[expectedType];
  if (acc.type !== expectedType || acc.componentType !== 5126) {
    fail(`accessors[${accIdx}] 必须是 FLOAT (5126) ${expectedType}`);
  }
  if (!Number.isInteger(acc.count) || acc.count < minCount) {
    fail(`accessors[${accIdx}].count 必须是至少为 ${minCount} 的整数`);
  }
  const bvIdx = acc.bufferView;
  if (!Number.isInteger(bvIdx) || bvIdx < 0 || bvIdx >= rawBufferViews.length) {
    fail(`accessors[${accIdx}].bufferView ${safeShow(bvIdx)} 越界`);
  }
  const bv = rawBufferViews[bvIdx];
  const bvOffset = bv.byteOffset ?? 0;
  const accOffset = acc.byteOffset ?? 0;
  const elemBytes = numComps * 4;
  const stride = bv.byteStride ?? elemBytes;
  if (!Number.isInteger(accOffset) || accOffset < 0 || accOffset % 4 !== 0) {
    fail(`accessors[${accIdx}].byteOffset 必须是 4 字节对齐的非负整数`);
  }
  if (stride < elemBytes || stride % 4 !== 0 || accOffset + (acc.count - 1) * stride + elemBytes > bv.byteLength) {
    fail(`accessors[${accIdx}] 超出 bufferViews[${bvIdx}] 的 byteLength 范围`);
  }

  if (!binBytes) {
    if (isBinaryGlb) fail(`GLB 缺少 BIN 块，无法读取 accessors[${accIdx}] 顶点数据`);
    if (expectedType === 'VEC3' && Array.isArray(acc.min) && acc.min.length === 3 && Array.isArray(acc.max) && acc.max.length === 3) {
      const bbox = [...acc.min, ...acc.max];
      return { values: [...boxVertices(bbox)], bbox, synthesizedFromBounds: true };
    }
    const fallbackBox = [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05];
    return { values: [...boxVertices(fallbackBox)], bbox: fallbackBox, synthesizedFromBounds: true };
  }

  const view = new DataView(binBytes.buffer, binBytes.byteOffset, binBytes.byteLength);
  const values = new Array(acc.count * numComps);
  const baseOffset = bvOffset + accOffset;
  if (baseOffset + (acc.count - 1) * stride + elemBytes > binBytes.byteLength) {
    fail(`accessors[${accIdx}] 偏移超出 GLB BIN 块实际长度`);
  }
  for (let i = 0; i < acc.count; i++) {
    const off = baseOffset + i * stride;
    for (let c = 0; c < numComps; c++) {
      const val = view.getFloat32(off + c * 4, true);
      if (!Number.isFinite(val)) {
        fail(`accessors[${accIdx}] 第 ${i} 个元素包含非有限数坐标`);
      }
      values[i * numComps + c] = val;
    }
  }
  const bbox = expectedType === 'VEC3' ? computeBboxFromVertices(values) : null;
  return { values, bbox, synthesizedFromBounds: false };
}

function decodeIndexAccessor(accIdx, vertexCount, rawAccessors, rawBufferViews, binBytes, isBinaryGlb) {
  if (!Number.isInteger(accIdx) || accIdx < 0 || accIdx >= rawAccessors.length) {
    fail(`mesh primitive 的 indices accessor 索引 ${safeShow(accIdx)} 越界`);
  }
  const acc = rawAccessors[accIdx];
  if (!isPlainObject(acc)) fail(`accessors[${accIdx}] 必须是普通对象`);
  if (acc.type !== 'SCALAR' || ![5121, 5123, 5125].includes(acc.componentType)) {
    fail(`indices accessors[${accIdx}] 必须是 SCALAR 整数类型 (5121/5123/5125)`);
  }
  if (!Number.isInteger(acc.count) || acc.count < 3) {
    fail(`indices accessors[${accIdx}].count 必须是至少为 3 的整数`);
  }
  const bvIdx = acc.bufferView;
  if (!Number.isInteger(bvIdx) || bvIdx < 0 || bvIdx >= rawBufferViews.length) {
    fail(`accessors[${accIdx}].bufferView ${safeShow(bvIdx)} 越界`);
  }
  const bv = rawBufferViews[bvIdx];
  const bvOffset = bv.byteOffset ?? 0;
  const accOffset = acc.byteOffset ?? 0;
  const elemBytes = COMPONENT_BYTES[acc.componentType];
  const stride = bv.byteStride ?? elemBytes;
  if (!Number.isInteger(accOffset) || accOffset < 0 || accOffset % elemBytes !== 0) {
    fail(`accessors[${accIdx}].byteOffset 对齐不合法`);
  }
  if (stride < elemBytes || accOffset + (acc.count - 1) * stride + elemBytes > bv.byteLength) {
    fail(`accessors[${accIdx}] 超出 bufferViews[${bvIdx}] 的 byteLength 范围`);
  }
  if (!binBytes) {
    if (isBinaryGlb) fail(`GLB 缺少 BIN 块，无法读取 accessors[${accIdx}] 索引数据`);
    return [...BOX_INDICES];
  }
  const view = new DataView(binBytes.buffer, binBytes.byteOffset, binBytes.byteLength);
  const baseOffset = bvOffset + accOffset;
  if (baseOffset + (acc.count - 1) * stride + elemBytes > binBytes.byteLength) {
    fail(`accessors[${accIdx}] 索引偏移超出 GLB BIN 块实际长度`);
  }
  const indices = new Array(acc.count);
  for (let i = 0; i < acc.count; i++) {
    const off = baseOffset + i * stride;
    const idx = acc.componentType === 5121
      ? view.getUint8(off)
      : acc.componentType === 5123
        ? view.getUint16(off, true)
        : view.getUint32(off, true);
    if (idx >= vertexCount) {
      fail(`accessors[${accIdx}] 第 ${i} 个顶点索引 ${idx} 超出顶点总数 ${vertexCount}`);
    }
    indices[i] = idx;
  }
  return indices;
}

function normalizeGlbCarrier(input) {
  if (input === null || input === undefined) {
    fail('inspectGlb 输入必须是 GLB 字节流、base64 字符串或 glTF JSON 普通对象');
  }
  if (typeof input === 'string') {
    return { kind: 'binary', bytes: decodeBase64Bytes('glb', input) };
  }
  if (typeof input !== 'object') {
    fail('inspectGlb 输入必须是 GLB 字节流、base64 字符串或 glTF JSON 普通对象');
  }
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return { kind: 'binary', bytes: snapUint8Bytes('glbBytes', input) };
  }
  if (Array.isArray(input)) {
    const arr = snapValue('glbBytes', input);
    if (arr.length < 20 || arr.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
      fail('inspectGlb 字节数组输入必须是长度不少于 20 的 [0, 255] 整数数组');
    }
    return { kind: 'binary', bytes: new Uint8Array(arr) };
  }
  if (isPlainObject(input)) {
    const obj = snapValue('gltfJson', input);
    if (typeof obj.base64 === 'string' && Object.keys(obj).length === 1) {
      return { kind: 'binary', bytes: decodeBase64Bytes('glb.base64', obj.base64) };
    }
    if (Array.isArray(obj.bytes) && Object.keys(obj).length === 1) {
      if (obj.bytes.length < 20 || obj.bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
        fail('glb.bytes 必须是长度不少于 20 的 [0, 255] 整数数组');
      }
      return { kind: 'binary', bytes: new Uint8Array(obj.bytes) };
    }
    return { kind: 'json', gltf: obj };
  }
  fail('inspectGlb 输入必须是 Uint8Array、ArrayBuffer、字节数组、base64 或 glTF JSON 普通对象');
}

/**
 * 解析并检查 GLB 二进制（Uint8Array / ArrayBuffer / base64 / 字节数组）或 glTF 2.0 JSON 对象。
 */
export function inspectGlb(input) {
  const carrier = normalizeGlbCarrier(input);
  let gltf = null;
  let byteLength = 0;
  let hasBinChunk = false;
  let binByteLength = 0;
  let binBytes = null;
  let isBinaryGlb = false;

  if (carrier.kind === 'binary') {
    isBinaryGlb = true;
    const bytes = carrier.bytes;
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
    if (jsonLen === 0 || jsonLen % 4 !== 0 || 20 + jsonLen > byteLength) fail(`GLB JSON 块长度 ${jsonLen} 非 4 字节对齐或越界`);

    let jsonText;
    try {
      jsonText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + jsonLen));
    } catch {
      fail('GLB JSON 块包含非法的 UTF-8 字节序列');
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      fail(`GLB JSON 块解析失败：${err.message}`);
    }
    gltf = snapValue('gltfJson', parsed);

    const restOffset = 20 + jsonLen;
    if (restOffset < byteLength) {
      if (restOffset + 8 > byteLength) fail('GLB BIN 块头部截断');
      const binLen = view.getUint32(restOffset, true);
      const binType = view.getUint32(restOffset + 4, true);
      if (binType !== CHUNK_BIN) fail(`GLB 第二块必须是 BIN (0x004e4942)，实际 0x${binType.toString(16)}`);
      if (binLen % 4 !== 0 || restOffset + 8 + binLen !== byteLength) {
        fail(`GLB BIN 块长度 ${binLen} 非 4 字节对齐或与文件尾不符`);
      }
      hasBinChunk = true;
      binByteLength = binLen;
      binBytes = bytes.subarray(restOffset + 8, restOffset + 8 + binLen);
    }
  } else {
    gltf = carrier.gltf;
  }

  if (!isPlainObject(gltf)) fail('glTF 根对象必须是普通对象');
  if (!isPlainObject(gltf.asset) || gltf.asset.version !== '2.0') {
    fail('glTF asset.version 必须是 "2.0"');
  }
  const extras = isPlainObject(gltf.asset.extras) ? gltf.asset.extras : {};
  if (gltf.asset.extras !== undefined && !isPlainObject(gltf.asset.extras)) {
    fail('glTF asset.extras 必须是普通对象');
  }

  if (gltf.buffers !== undefined && !Array.isArray(gltf.buffers)) fail('glTF buffers 必须是数组');
  if (gltf.bufferViews !== undefined && !Array.isArray(gltf.bufferViews)) fail('glTF bufferViews 必须是数组');
  if (gltf.accessors !== undefined && !Array.isArray(gltf.accessors)) fail('glTF accessors 必须是数组');
  if (gltf.meshes !== undefined && !Array.isArray(gltf.meshes)) fail('glTF meshes 必须是数组');
  if (gltf.materials !== undefined && !Array.isArray(gltf.materials)) fail('glTF materials 必须是数组');
  if (gltf.nodes !== undefined && !Array.isArray(gltf.nodes)) fail('glTF nodes 必须是数组');
  if (gltf.scenes !== undefined && !Array.isArray(gltf.scenes)) fail('glTF scenes 必须是数组');

  const rawBuffers = gltf.buffers ?? [];
  const rawBufferViews = gltf.bufferViews ?? [];
  const rawAccessors = gltf.accessors ?? [];
  const rawMeshes = gltf.meshes ?? [];
  const rawMaterials = gltf.materials ?? [];
  const rawNodes = gltf.nodes ?? [];
  const rawScenes = gltf.scenes ?? [];

  for (let i = 0; i < rawBuffers.length; i++) {
    const b = rawBuffers[i];
    if (!isPlainObject(b) || !Number.isInteger(b.byteLength) || b.byteLength < 0) {
      fail(`glTF buffers[${i}].byteLength 必须是非负整数`);
    }
    if (b.uri !== undefined) {
      if (typeof b.uri !== 'string' || !/^data:[^;,]+(?:;[^;,]+)*;base64,/i.test(b.uri)) {
        fail(`glTF buffers[${i}].uri 仅支持内联 data:...;base64, 数据`);
      }
      if (i === 0 && !hasBinChunk) {
        binBytes = decodeBase64Bytes(`glTF buffers[0].uri`, b.uri);
        hasBinChunk = true;
        binByteLength = binBytes.byteLength;
      }
    }
    if (b.byteLength > 0 && b.uri === undefined) {
      if (i > 0 || !hasBinChunk || b.byteLength > binByteLength) {
        fail(`GLB buffers[${i}].byteLength (${b.byteLength}) 缺少对应 BIN 块或超过 BIN 块长度 (${binByteLength})`);
      }
    }
  }
  if (isBinaryGlb && rawBufferViews.length > 0 && (!hasBinChunk || rawBuffers.length === 0)) {
    fail('GLB 含 bufferViews 时必须同时具备 buffers[0] 与 BIN 块');
  }

  for (let i = 0; i < rawBufferViews.length; i++) {
    const bv = rawBufferViews[i];
    if (!isPlainObject(bv)) fail(`glTF bufferViews[${i}] 必须是普通对象`);
    if (!Number.isInteger(bv.buffer) || bv.buffer < 0 || bv.buffer >= Math.max(1, rawBuffers.length)) {
      fail(`glTF bufferViews[${i}].buffer ${safeShow(bv.buffer)} 越界`);
    }
    const byteOffset = bv.byteOffset ?? 0;
    if (!Number.isInteger(byteOffset) || byteOffset < 0) fail(`glTF bufferViews[${i}].byteOffset 必须是非负整数`);
    if (!Number.isInteger(bv.byteLength) || bv.byteLength < 1) fail(`glTF bufferViews[${i}].byteLength 必须是正整数`);
    if (bv.byteStride !== undefined && (!Number.isInteger(bv.byteStride) || bv.byteStride < 4 || bv.byteStride > 252 || bv.byteStride % 4 !== 0)) {
      fail(`glTF bufferViews[${i}].byteStride ${safeShow(bv.byteStride)} 不合法`);
    }
    const declaredBufLen = rawBuffers[bv.buffer]?.byteLength ?? (hasBinChunk ? binByteLength : Infinity);
    const maxLen = hasBinChunk ? Math.min(declaredBufLen, binByteLength) : declaredBufLen;
    if (byteOffset + bv.byteLength > maxLen) {
      fail(`glTF bufferViews[${i}] 范围 [${byteOffset}, ${byteOffset + bv.byteLength}) 超出 buffer 长度 ${maxLen}`);
    }
  }

  for (let i = 0; i < rawAccessors.length; i++) {
    const acc = rawAccessors[i];
    if (!isPlainObject(acc)) fail(`glTF accessors[${i}] 必须是普通对象`);
    if (acc.bufferView !== undefined || rawBufferViews.length > 0 || isBinaryGlb) {
      if (!Number.isInteger(acc.bufferView) || acc.bufferView < 0 || acc.bufferView >= rawBufferViews.length) {
        fail(`glTF accessors[${i}].bufferView ${safeShow(acc.bufferView)} 越界`);
      }
      const compBytes = COMPONENT_BYTES[acc.componentType];
      const typeCount = TYPE_COUNTS[acc.type];
      if (!compBytes || !typeCount) fail(`glTF accessors[${i}] 的 componentType 或 type 不合法`);
      if (!Number.isInteger(acc.count) || acc.count < 1) fail(`glTF accessors[${i}].count 必须是正整数`);
      const accOffset = acc.byteOffset ?? 0;
      if (!Number.isInteger(accOffset) || accOffset < 0) fail(`glTF accessors[${i}].byteOffset 必须是非负整数`);
      const bv = rawBufferViews[acc.bufferView];
      const elemBytes = compBytes * typeCount;
      const stride = bv.byteStride ?? elemBytes;
      if (stride < elemBytes || accOffset + (acc.count - 1) * stride + elemBytes > bv.byteLength) {
        fail(`glTF accessors[${i}] 越出 bufferViews[${acc.bufferView}] 边界`);
      }
    }
  }

  const decodedMaterials = new Array(rawMaterials.length);
  for (let i = 0; i < rawMaterials.length; i++) {
    decodedMaterials[i] = normalizeMaterialSpec(`glTF materials[${i}]`, rawMaterials[i]);
  }

  const decodedMeshes = new Array(rawMeshes.length);
  for (let i = 0; i < rawMeshes.length; i++) {
    const m = rawMeshes[i];
    if (!isPlainObject(m)) fail(`glTF meshes[${i}] 必须是普通对象`);
    if (!Array.isArray(m.primitives) || m.primitives.length < 1) {
      fail(`glTF meshes[${i}].primitives 必须是非空数组`);
    }
    const primitives = new Array(m.primitives.length);
    const allVertices = [];
    let mMinX = Infinity, mMinY = Infinity, mMinZ = Infinity;
    let mMaxX = -Infinity, mMaxY = -Infinity, mMaxZ = -Infinity;

    for (let p = 0; p < m.primitives.length; p++) {
      const prim = m.primitives[p];
      if (!isPlainObject(prim) || !isPlainObject(prim.attributes)) {
        fail(`glTF meshes[${i}].primitives[${p}].attributes 必须是普通对象`);
      }
      const posIdx = prim.attributes.POSITION;
      const { values: vertices, bbox, synthesizedFromBounds } = decodeFloatAccessor(posIdx, 'VEC3', 3, rawAccessors, rawBufferViews, binBytes, isBinaryGlb);
      const vertexCount = vertices.length / 3;

      let normals = null;
      if (prim.attributes.NORMAL !== undefined) {
        const normRes = decodeFloatAccessor(prim.attributes.NORMAL, 'VEC3', vertexCount, rawAccessors, rawBufferViews, binBytes, isBinaryGlb);
        if (normRes.values.length === vertices.length) normals = normRes.values;
      }

      let uvs = null;
      if (prim.attributes.TEXCOORD_0 !== undefined) {
        const uvRes = decodeFloatAccessor(prim.attributes.TEXCOORD_0, 'VEC2', vertexCount, rawAccessors, rawBufferViews, binBytes, isBinaryGlb);
        if (uvRes.values.length === vertexCount * 2) uvs = uvRes.values;
      }

      const hasIndices = prim.indices !== undefined || synthesizedFromBounds;
      const indices = prim.indices !== undefined
        ? decodeIndexAccessor(prim.indices, vertexCount, rawAccessors, rawBufferViews, binBytes, isBinaryGlb)
        : (synthesizedFromBounds ? [...BOX_INDICES] : Array.from({ length: vertexCount }, (_, k) => k));

      let material = null;
      if (prim.material !== undefined) {
        if (!Number.isInteger(prim.material) || prim.material < 0 || prim.material >= decodedMaterials.length) {
          fail(`glTF meshes[${i}].primitives[${p}].material 索引 ${safeShow(prim.material)} 越界`);
        }
        material = decodedMaterials[prim.material];
      }

      for (let k = 0; k < vertices.length; k++) allVertices.push(vertices[k]);
      if (bbox[0] < mMinX) mMinX = bbox[0];
      if (bbox[1] < mMinY) mMinY = bbox[1];
      if (bbox[2] < mMinZ) mMinZ = bbox[2];
      if (bbox[3] > mMaxX) mMaxX = bbox[3];
      if (bbox[4] > mMaxY) mMaxY = bbox[4];
      if (bbox[5] > mMaxZ) mMaxZ = bbox[5];

      primitives[p] = { vertices, normals, uvs, indices, hasIndices, bbox, material };
    }

    const firstPrim = primitives[0];
    const unionBbox = Number.isFinite(mMinX) ? [mMinX, mMinY, mMinZ, mMaxX, mMaxY, mMaxZ] : [...firstPrim.bbox];
    decodedMeshes[i] = {
      primitives,
      vertices: allVertices,
      normals: firstPrim.normals,
      uvs: firstPrim.uvs,
      indices: firstPrim.indices,
      hasIndices: firstPrim.hasIndices,
      bbox: unionBbox,
      material: firstPrim.material,
    };
  }

  // 校验节点数组、children 引用合法性、单父节点约束与无环性
  const parentOf = new Map();
  for (let i = 0; i < rawNodes.length; i++) {
    const n = rawNodes[i];
    if (!isPlainObject(n)) fail(`glTF nodes[${i}] 必须是普通对象`);
    if (n.name !== undefined && typeof n.name !== 'string') fail(`glTF nodes[${i}].name 必须是字符串`);
    if (n.mesh !== undefined) {
      if (!Number.isInteger(n.mesh) || n.mesh < 0 || n.mesh >= rawMeshes.length) {
        fail(`glTF nodes[${i}].mesh 索引 ${safeShow(n.mesh)} 越界`);
      }
    }
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) fail(`glTF nodes[${i}].children 必须是数组`);
      for (const childIdx of n.children) {
        if (!Number.isInteger(childIdx) || childIdx < 0 || childIdx >= rawNodes.length) {
          fail(`glTF nodes[${i}].children 包含越界节点索引 ${safeShow(childIdx)}`);
        }
        if (childIdx === i) fail(`glTF nodes[${i}] 的 children 包含自身（自环）`);
        if (parentOf.has(childIdx)) fail(`glTF 节点 ${childIdx} 被多个父节点同时引用`);
        parentOf.set(childIdx, i);
      }
    }
  }

  for (let i = 0; i < rawNodes.length; i++) {
    let cur = i;
    const visited = new Set();
    while (parentOf.has(cur)) {
      if (visited.has(cur)) fail('glTF 节点层级存在循环父子引用');
      visited.add(cur);
      cur = parentOf.get(cur);
    }
  }

  if (gltf.scene !== undefined) {
    if (!Number.isInteger(gltf.scene) || gltf.scene < 0 || gltf.scene >= rawScenes.length) {
      fail(`glTF scene 索引 ${safeShow(gltf.scene)} 越界`);
    }
  }
  for (let i = 0; i < rawScenes.length; i++) {
    const s = rawScenes[i];
    if (!isPlainObject(s)) fail(`glTF scenes[${i}] 必须是普通对象`);
    if (s.nodes !== undefined) {
      if (!Array.isArray(s.nodes)) fail(`glTF scenes[${i}].nodes 必须是数组`);
      for (const rIdx of s.nodes) {
        if (!Number.isInteger(rIdx) || rIdx < 0 || rIdx >= rawNodes.length) {
          fail(`glTF scenes[${i}].nodes 包含越界节点索引 ${safeShow(rIdx)}`);
        }
      }
    }
  }

  const activeSceneIndex = rawScenes.length > 0 ? (gltf.scene ?? 0) : null;
  const reachableNodes = new Set();
  if (activeSceneIndex !== null) {
    const activeScene = rawScenes[activeSceneIndex];
    const queue = Array.isArray(activeScene?.nodes) ? [...activeScene.nodes] : [];
    while (queue.length > 0) {
      const idx = queue.shift();
      if (reachableNodes.has(idx)) continue;
      reachableNodes.add(idx);
      const children = rawNodes[idx]?.children;
      if (Array.isArray(children)) {
        for (const cIdx of children) queue.push(cIdx);
      }
    }
  } else {
    for (let i = 0; i < rawNodes.length; i++) reachableNodes.add(i);
  }

  const alias = typeof extras.alias === 'string' && extras.alias.length > 0
    ? extras.alias
    : (typeof rawScenes[activeSceneIndex ?? 0]?.name === 'string' && rawScenes[activeSceneIndex ?? 0].name.length > 0 ? rawScenes[activeSceneIndex ?? 0].name : 'asset');
  const upAxis = extras.upAxis ?? 'Y';
  const unitScale = extras.unitScale ?? 1;
  const hand = extras.hand ?? 'right';

  const localMatrices = new Array(rawNodes.length);
  const nodeTrs = new Array(rawNodes.length);
  const nodes = new Array(rawNodes.length);

  for (let i = 0; i < rawNodes.length; i++) {
    const n = rawNodes[i];
    if (n.matrix !== undefined) {
      if (n.translation !== undefined || n.rotation !== undefined || n.scale !== undefined) {
        fail(`glTF nodes[${i}] 不能同时指定 matrix 与 translation/rotation/scale`);
      }
      const trs = decomposeMat4(n.matrix);
      nodeTrs[i] = trs;
      localMatrices[i] = [...n.matrix];
    } else {
      const translation = n.translation !== undefined ? n.translation : [0, 0, 0];
      const rotation = n.rotation !== undefined ? n.rotation : [0, 0, 0, 1];
      const scale = n.scale !== undefined ? n.scale : [1, 1, 1];
      if (!Array.isArray(translation) || translation.length !== 3 || translation.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        fail(`glTF nodes[${i}].translation 必须是长度为 3 的有限数数组`);
      }
      if (!Array.isArray(rotation) || rotation.length !== 4 || rotation.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        fail(`glTF nodes[${i}].rotation 必须是长度为 4 的四元数数组`);
      }
      if (!Array.isArray(scale) || scale.length !== 3 || scale.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
        fail(`glTF nodes[${i}].scale 必须是 3 个正数`);
      }
      nodeTrs[i] = { translation: [...translation], rotation: [...rotation], scale: [...scale] };
      localMatrices[i] = composeTrsMatrix(translation, rotation, scale);
    }
  }

  const worldMatrices = new Array(rawNodes.length);
  function getWorldMatrix(idx) {
    if (worldMatrices[idx]) return worldMatrices[idx];
    const pIdx = parentOf.get(idx);
    worldMatrices[idx] = pIdx !== undefined
      ? multiplyMat4(getWorldMatrix(pIdx), localMatrices[idx])
      : localMatrices[idx];
    return worldMatrices[idx];
  }

  const meshNodes = [];
  const unnamedMeshNodes = [];
  const seenNames = new Set();
  const duplicateNames = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < rawNodes.length; i++) {
    const n = rawNodes[i];
    const inActiveScene = reachableNodes.has(i);
    const rawName = typeof n.name === 'string' ? n.name.trim() : '';
    const partName = stripAliasPrefix(rawName, alias);
    const hasMesh = n.mesh !== undefined;
    const meshData = hasMesh ? decodedMeshes[n.mesh] : null;
    const bbox = meshData ? [...meshData.bbox] : [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05];
    const vertices = meshData ? [...meshData.vertices] : [];
    const normals = meshData?.normals ? [...meshData.normals] : null;
    const uvs = meshData?.uvs ? [...meshData.uvs] : null;
    const indices = meshData ? [...meshData.indices] : [];
    const hasIndices = meshData ? Boolean(meshData.hasIndices) : false;
    const material = meshData?.material ? { ...meshData.material, baseColorFactor: [...meshData.material.baseColorFactor], emissiveFactor: [...meshData.material.emissiveFactor] } : null;
    const primitives = meshData
      ? meshData.primitives.map((pr) => ({
        vertices: [...pr.vertices],
        normals: pr.normals ? [...pr.normals] : null,
        uvs: pr.uvs ? [...pr.uvs] : null,
        indices: [...pr.indices],
        hasIndices: Boolean(pr.hasIndices),
        bbox: [...pr.bbox],
        material: pr.material
          ? {
            ...pr.material,
            baseColorFactor: [...pr.material.baseColorFactor],
            emissiveFactor: [...pr.material.emissiveFactor],
          }
          : null,
      }))
      : [];
    const worldMatrix = getWorldMatrix(i);
    const worldBbox = hasMesh ? computeBboxFromVertices(vertices, worldMatrix) : computeBboxFromVertices([...boxVertices(bbox)], worldMatrix);

    if (inActiveScene && hasMesh) {
      if (worldBbox[0] < minX) minX = worldBbox[0];
      if (worldBbox[1] < minY) minY = worldBbox[1];
      if (worldBbox[2] < minZ) minZ = worldBbox[2];
      if (worldBbox[3] > maxX) maxX = worldBbox[3];
      if (worldBbox[4] > maxY) maxY = worldBbox[4];
      if (worldBbox[5] > maxZ) maxZ = worldBbox[5];
    }

    const parentIdx = parentOf.get(i);
    const trs = nodeTrs[i];
    const info = {
      index: i,
      name: rawName,
      partName,
      hasMesh,
      inActiveScene,
      parentIndex: parentIdx !== undefined ? parentIdx : null,
      parent: parentIdx !== undefined ? (rawNodes[parentIdx]?.name ?? '') : null,
      children: Array.isArray(n.children) ? [...n.children] : [],
      translation: trs.translation,
      rotation: trs.rotation,
      scale: trs.scale,
      bbox,
      worldBbox,
      localMatrix: localMatrices[i],
      worldMatrix,
      vertices,
      normals,
      uvs,
      indices,
      hasIndices,
      material,
      primitives,
    };
    nodes[i] = info;

    if (inActiveScene) {
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
  }

  const assetWorldBbox = Number.isFinite(minX) ? [minX, minY, minZ, maxX, maxY, maxZ] : [0, 0, 0, 0, 0, 0];

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
    materials: decodedMaterials,
    partNames: meshNodes.filter((n) => n.partName !== '').map((n) => n.partName),
    unnamedMeshNodes,
    duplicateNames,
    worldBbox: assetWorldBbox,
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

  let isInspected = false;
  if (isPlainObject(input)) {
    const fmtDesc = Object.getOwnPropertyDescriptor(input, 'format');
    if (fmtDesc && Object.hasOwn(fmtDesc, 'value') && fmtDesc.value === 'glb-inspection/0.1') {
      isInspected = true;
    }
  }
  const inspection = isInspected
    ? snapValue('inspection', input)
    : inspectGlb(input);

  const alias = opts.alias ?? inspection.alias;
  if (typeof alias !== 'string' || !PART_NAME_RE.test(alias)) fail(`opts.alias ${safeShow(alias)} 不合法`);
  const strictParts = opts.strictParts ?? true;
  const allowExtraParts = opts.allowExtraParts ?? false;
  const requireYUp = opts.requireYUp ?? true;
  const requireUnitMeter = opts.requireUnitMeter ?? true;
  if (typeof strictParts !== 'boolean' || typeof allowExtraParts !== 'boolean' || typeof requireYUp !== 'boolean' || typeof requireUnitMeter !== 'boolean') {
    fail('opts 布尔开关必须是 boolean');
  }
  if (opts.throwOnError !== undefined && typeof opts.throwOnError !== 'boolean') {
    fail('opts.throwOnError 必须是 boolean');
  }

  const actualMeshParts = inspection.meshNodes
    .filter((n) => n.name !== '')
    .map((n) => stripAliasPrefix(n.name, alias));

  const matchedParts = expectedParts.filter((p) => actualMeshParts.includes(p));
  const missingParts = expectedParts.filter((p) => !actualMeshParts.includes(p));
  const extraParts = actualMeshParts.filter((p) => !expectedParts.includes(p));
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
    actualParts: actualMeshParts,
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

const IDENTITY_MAT4 = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function makeFallbackObject3D(name, isMesh = false, bbox = [-0.05, -0.05, -0.05, 0.05, 0.05, 0.05], geomInfo = null, matInfo = null) {
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
    matrix: { elements: [...IDENTITY_MAT4] },
    matrixWorld: { elements: [...IDENTITY_MAT4] },
    ...(isMesh && geomInfo ? {
      geometry: {
        attributes: {
          position: {
            array: geomInfo.posArray,
            itemSize: 3,
            count: geomInfo.posArray.length / 3,
          },
          ...(geomInfo.normArray ? {
            normal: {
              array: geomInfo.normArray,
              itemSize: 3,
              count: geomInfo.normArray.length / 3,
            },
          } : {}),
          ...(geomInfo.uvArray ? {
            uv: {
              array: geomInfo.uvArray,
              itemSize: 2,
              count: geomInfo.uvArray.length / 2,
            },
          } : {}),
        },
        index: geomInfo.indexArray ? {
          array: geomInfo.indexArray,
          itemSize: 1,
          count: geomInfo.indexArray.length,
        } : null,
      },
      material: {
        isMaterial: true,
        isMeshStandardMaterial: true,
        name: matInfo?.name ?? '',
        color: {
          r: matInfo?.baseColorFactor?.[0] ?? 0.85,
          g: matInfo?.baseColorFactor?.[1] ?? 0.87,
          b: matInfo?.baseColorFactor?.[2] ?? 0.91,
        },
        opacity: matInfo?.baseColorFactor?.[3] ?? 1,
        transparent: (matInfo?.alphaMode === 'BLEND') || ((matInfo?.baseColorFactor?.[3] ?? 1) < 1),
        metalness: matInfo?.metallicFactor ?? 1,
        roughness: matInfo?.roughnessFactor ?? 1,
        doubleSided: matInfo?.doubleSided ?? false,
        userData: { gltfMaterial: matInfo ?? null },
      },
    } : {}),
    userData: { bbox: [...bbox] },
    add(child) {
      if (child.parent && child.parent !== obj) {
        const idx = child.parent.children.indexOf(child);
        if (idx >= 0) child.parent.children.splice(idx, 1);
      }
      child.parent = obj;
      children.push(child);
      return obj;
    },
    updateMatrix() {
      const t = [this.position.x, this.position.y, this.position.z];
      const r = [this.quaternion.x, this.quaternion.y, this.quaternion.z, this.quaternion.w];
      const s = [this.scale.x, this.scale.y, this.scale.z];
      this.matrix.elements = composeTrsMatrix(t, r, s);
    },
    updateMatrixWorld() {
      this.updateMatrix();
      if (this.parent && this.parent.matrixWorld?.elements) {
        this.matrixWorld.elements = multiplyMat4(this.parent.matrixWorld.elements, this.matrix.elements);
      } else {
        this.matrixWorld.elements = [...this.matrix.elements];
      }
      for (const c of children) c.updateMatrixWorld?.(true);
    },
    getWorldPosition(target) {
      this.updateMatrixWorld();
      const [wx, wy, wz] = [this.matrixWorld.elements[12], this.matrixWorld.elements[13], this.matrixWorld.elements[14]];
      if (target && typeof target.set === 'function') {
        target.set(wx, wy, wz);
        return target;
      }
      return { x: wx, y: wy, z: wz, toArray() { return [wx, wy, wz]; } };
    },
    traverse(fn) {
      fn(obj);
      for (const c of children) c.traverse(fn);
    },
    dispose() {},
  };
  return obj;
}

function validateHostCtx(rawCtx) {
  if (!isPlainObject(rawCtx)) fail('ctx 必须是普通对象');
  const { THREE } = rawCtx;
  if (THREE !== undefined) {
    if (THREE === null || typeof THREE !== 'object') {
      fail('ctx.THREE 必须是有效的渲染库对象');
    }
    for (const k of ['Group', 'BufferGeometry', 'Float32BufferAttribute', 'MeshBasicMaterial', 'Mesh']) {
      if (typeof THREE[k] !== 'function') fail(`ctx.THREE.${k} 必须是构造函数`);
    }
  }
  return { THREE };
}

function createThreeMaterial(THREE, matInfo) {
  const StdMat = typeof THREE?.MeshStandardMaterial === 'function' ? THREE.MeshStandardMaterial : null;
  const BasicMat = THREE?.MeshBasicMaterial;
  const linearSpace = THREE?.LinearSRGBColorSpace;
  const doubleSide = THREE?.DoubleSide;

  const r = matInfo?.baseColorFactor?.[0] ?? 0.85;
  const g = matInfo?.baseColorFactor?.[1] ?? 0.87;
  const b = matInfo?.baseColorFactor?.[2] ?? 0.91;
  const a = matInfo?.baseColorFactor?.[3] ?? 1;
  const metalness = matInfo?.metallicFactor ?? 1;
  const roughness = matInfo?.roughnessFactor ?? 1;

  let material;
  if (StdMat) {
    material = new StdMat({
      metalness,
      roughness,
      opacity: a,
      transparent: (matInfo?.alphaMode === 'BLEND') || a < 1,
    });
  } else {
    material = new BasicMat({
      opacity: a,
      transparent: (matInfo?.alphaMode === 'BLEND') || a < 1,
    });
    material.metalness = metalness;
    material.roughness = roughness;
  }

  if (matInfo?.name) material.name = matInfo.name;
  if (material.color && typeof material.color.setRGB === 'function') {
    if (linearSpace !== undefined) {
      material.color.setRGB(r, g, b, linearSpace);
    } else {
      material.color.setRGB(r, g, b);
    }
  }
  if (matInfo?.emissiveFactor && material.emissive && typeof material.emissive.setRGB === 'function') {
    const [er, eg, eb] = matInfo.emissiveFactor;
    if (linearSpace !== undefined) {
      material.emissive.setRGB(er, eg, eb, linearSpace);
    } else {
      material.emissive.setRGB(er, eg, eb);
    }
  }
  if (matInfo?.alphaMode === 'MASK') {
    material.alphaTest = matInfo.alphaCutoff ?? 0.5;
  }
  if (matInfo?.doubleSided && doubleSide !== undefined) {
    material.side = doubleSide;
  }
  material.userData = {
    ...(material.userData ?? {}),
    gltfMaterial: matInfo ?? null,
    baseColorFactor: [r, g, b, a],
    metallicFactor: metalness,
    roughnessFactor: roughness,
  };
  return material;
}

function buildThreeHierarchy(THREE, inspection, alias, globalScale) {
  const disposables = [];
  const root = THREE ? new THREE.Group() : makeFallbackObject3D(alias, false);
  root.name = alias;
  root.scale.set(globalScale, globalScale, globalScale);

  const nodeObjects = new Array(inspection.nodes.length);
  const nodesByName = {};
  const parts = {};
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  function buildPrimitiveMesh(meshName, prim, fallbackBbox) {
    const verts = prim.vertices?.length ? prim.vertices : [...boxVertices(prim.bbox ?? fallbackBbox)];
    const posArray = new Float32Array(verts);
    const normArray = prim.normals?.length === verts.length ? new Float32Array(prim.normals) : null;
    const uvArray = prim.uvs?.length === (verts.length / 3) * 2 ? new Float32Array(prim.uvs) : null;
    const indexArray = prim.hasIndices && prim.indices?.length ? [...prim.indices] : null;

    if (THREE) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(posArray, 3));
      if (normArray) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normArray, 3));
      }
      if (uvArray) {
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvArray, 2));
      }
      if (indexArray && typeof geometry.setIndex === 'function') {
        geometry.setIndex(indexArray);
      }
      if (!normArray && typeof geometry.computeVertexNormals === 'function') {
        geometry.computeVertexNormals();
      }
      const material = createThreeMaterial(THREE, prim.material);
      const meshObj = new THREE.Mesh(geometry, material);
      meshObj.name = meshName;
      disposables.push(geometry, material);
      return meshObj;
    }
    return makeFallbackObject3D(
      meshName,
      true,
      prim.bbox ?? fallbackBbox,
      {
        posArray,
        normArray,
        uvArray,
        indexArray: indexArray ? new Uint32Array(indexArray) : null,
      },
      prim.material,
    );
  }

  // 第一遍：为激活场景可达的每个节点创建 Group 或 Mesh，严格保留 GLB 中的全部 primitive、原始顶点属性与 PBR 材质
  for (let i = 0; i < inspection.nodes.length; i++) {
    const node = inspection.nodes[i];
    if (node.inActiveScene === false) {
      nodeObjects[i] = null;
      continue;
    }
    const partName = stripAliasPrefix(node.name, alias) || `node_${i}`;
    let obj;

    if (node.hasMesh) {
      const prims = Array.isArray(node.primitives) && node.primitives.length > 0
        ? node.primitives
        : [{
          vertices: node.vertices,
          normals: node.normals,
          uvs: node.uvs,
          indices: node.indices,
          hasIndices: node.hasIndices,
          bbox: node.bbox,
          material: node.material,
        }];

      if (prims.length === 1) {
        obj = buildPrimitiveMesh(partName, prims[0], node.bbox);
      } else {
        obj = THREE ? new THREE.Group() : makeFallbackObject3D(partName, false, node.bbox);
        for (let p = 0; p < prims.length; p++) {
          const childMesh = buildPrimitiveMesh(`${partName}_${p}`, prims[p], prims[p].bbox ?? node.bbox);
          obj.add(childMesh);
        }
      }

      const [wx0, wy0, wz0, wx1, wy1, wz1] = node.worldBbox ?? node.bbox;
      minX = Math.min(minX, wx0 * globalScale);
      minY = Math.min(minY, wy0 * globalScale);
      minZ = Math.min(minZ, wz0 * globalScale);
      maxX = Math.max(maxX, wx1 * globalScale);
      maxY = Math.max(maxY, wy1 * globalScale);
      maxZ = Math.max(maxZ, wz1 * globalScale);
      parts[partName] = obj;
    } else {
      obj = THREE ? new THREE.Group() : makeFallbackObject3D(partName, false, node.bbox);
    }

    obj.name = partName;
    obj.position.set(node.translation[0], node.translation[1], node.translation[2]);
    if (obj.quaternion?.set) obj.quaternion.set(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
    obj.scale.set(node.scale[0], node.scale[1], node.scale[2]);
    obj.userData = {
      ...(obj.userData ?? {}),
      partName,
      nodeName: node.name,
      bbox: [...node.bbox],
      worldBbox: [...(node.worldBbox ?? node.bbox)],
      worldMatrix: [...(node.worldMatrix ?? composeTrsMatrix(node.translation, node.rotation, node.scale))],
    };
    nodeObjects[i] = obj;
    if (node.name !== '' && partName !== 'root' && NODE_NAME_RE.test(partName)) {
      nodesByName[partName] = obj;
    }
  }

  // 第二遍：按 glTF 真实父子层级仅挂载激活场景可达节点到父节点或 root 下
  for (let i = 0; i < inspection.nodes.length; i++) {
    const node = inspection.nodes[i];
    const obj = nodeObjects[i];
    if (!obj) continue;
    if (node.parentIndex !== null && node.parentIndex !== undefined && nodeObjects[node.parentIndex]) {
      nodeObjects[node.parentIndex].add(obj);
    } else {
      root.add(obj);
    }
  }

  root.updateMatrixWorld?.(true);

  const worldBbox = Number.isFinite(minX) ? [minX, minY, minZ, maxX, maxY, maxZ] : [0, 0, 0, 0, 0, 0];
  return { root, parts, nodeObjects, nodesByName, worldBbox, disposables };
}

/**
 * 卡入口 create(ctx, params)
 */
export function create(rawCtx = {}, rawParams = {}) {
  const { THREE } = validateHostCtx(rawCtx);

  const params = snapValue('params', rawParams);
  if (!isPlainObject(params)) fail('params 必须是普通对象');
  checkAllowedKeys('params', params, ['glb', 'spec', 'strictParts', 'allowExtraParts', 'scale']);

  const hasExplicitSpec = params.spec !== undefined;
  const spec = hasExplicitSpec
    ? params.spec
    : {
      alias: 'gpu',
      expectedParts: ['body', 'fan_L', 'fan_R'],
      upAxis: 'Y',
      unitScale: 1,
    };
  if (!isPlainObject(spec)) fail('params.spec 必须是普通对象');
  checkAllowedKeys('params.spec', spec, ['alias', 'expectedParts', 'parts', 'upAxis', 'unitScale', 'glb', 'glbBase64']);

  const strictParts = params.strictParts ?? true;
  const allowExtraParts = params.allowExtraParts ?? false;
  const scale = params.scale ?? 1;
  if (typeof strictParts !== 'boolean') fail('params.strictParts 必须是布尔值');
  if (typeof allowExtraParts !== 'boolean') fail('params.allowExtraParts 必须是布尔值');
  if (!(typeof scale === 'number' && scale >= 0.001 && scale <= 1000)) fail(`params.scale 必须在 [0.001, 1000] 内，给的是 ${safeShow(scale)}`);

  const rawGlbInput = (params.glb !== undefined && params.glb !== null)
    ? params.glb
    : (spec.glb !== undefined && spec.glb !== null)
      ? spec.glb
      : (spec.glbBase64 !== undefined && spec.glbBase64 !== null)
        ? spec.glbBase64
        : null;

  const hasExplicitGlb = rawGlbInput !== null;
  if (!hasExplicitGlb && (!Array.isArray(spec.expectedParts) || spec.expectedParts.length < 1)) {
    fail('params.spec.expectedParts 必须是非空数组');
  }
  if (spec.expectedParts !== undefined && (!Array.isArray(spec.expectedParts) || spec.expectedParts.length < 1)) {
    fail('params.spec.expectedParts 必须是非空数组');
  }

  const glbBytes = hasExplicitGlb
    ? rawGlbInput
    : buildSyntheticGlb({
      alias: spec.alias ?? 'gpu',
      expectedParts: spec.expectedParts,
      parts: spec.parts ?? spec.expectedParts,
      upAxis: spec.upAxis ?? 'Y',
      unitScale: spec.unitScale ?? 1,
      prefixAlias: true,
    });

  const inspection = inspectGlb(glbBytes);

  let expectedParts = (hasExplicitSpec || !hasExplicitGlb)
    ? spec.expectedParts
    : undefined;
  let effectiveAlias = (hasExplicitSpec ? spec.alias : undefined) ?? inspection.alias;
  if (hasExplicitGlb && !expectedParts) {
    expectedParts = inspection.partNames;
  }
  if (!Array.isArray(expectedParts) || expectedParts.length < 1) {
    fail('GLB 资产必须至少包含一个命名网格零件');
  }

  const verdict = verifyPartNames(inspection, expectedParts, {
    alias: effectiveAlias,
    strictParts,
    allowExtraParts,
    requireYUp: true,
    requireUnitMeter: true,
    throwOnError: true,
  });

  const { root, parts, nodeObjects, nodesByName, worldBbox, disposables } = buildThreeHierarchy(THREE, inspection, verdict.alias, scale);
  root.userData = { ...(root.userData ?? {}), parts, nodes: nodesByName, verdict, inspection, worldBbox };
  root.parts = parts;
  root.nodes = nodesByName;
  root.verdict = verdict;
  root.inspection = inspection;
  root.glbBytes = glbBytes;
  root.worldBbox = worldBbox;

  const hasGeometryInSubtree = (obj) => {
    let found = false;
    obj?.traverse?.((o) => {
      if (o?.geometry?.attributes?.position) found = true;
    });
    return found;
  };
  const namedEntitiesWithGeom = Object.fromEntries(
    Object.entries(nodesByName).filter(([, obj]) => hasGeometryInSubtree(obj)),
  );

  const entities = {
    root: { object: root, root: true },
    ...namedEntitiesWithGeom,
    ...parts,
  };

  return {
    object: root,
    entities,
    apply(f, sub = 0) {
      if (typeof f !== 'number' || !Number.isInteger(f) || f < 0) fail(`帧号 f 必须是非负整数，给的是 ${safeShow(f)}`);
      if (!(typeof sub === 'number' && Number.isFinite(sub) && sub >= 0 && sub < 1)) fail(`子帧相位 sub 必须在 [0, 1) 内，给的是 ${safeShow(sub)}`);
      const t = f + sub;
      // 闭式位姿：每个节点的局部 TRS 变换只由 t = f + sub 决定，无跨帧状态
      for (let i = 0; i < inspection.nodes.length; i++) {
        const node = inspection.nodes[i];
        const obj = nodeObjects[i];
        if (!obj) continue;
        obj.position.set(node.translation[0], node.translation[1], node.translation[2]);
        if (obj.quaternion?.set) obj.quaternion.set(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
        obj.scale.set(node.scale[0], node.scale[1], node.scale[2]);
      }
      root.updateMatrixWorld?.(true);
      return { t, partCount: verdict.matchedParts.length, bbox: [...worldBbox] };
    },
    meta(f) {
      if (typeof f !== 'number' || !Number.isInteger(f) || f < 0) fail(`帧号 f 必须是非负整数，给的是 ${safeShow(f)}`);
      return {
        readings: {
          partCount: verdict.matchedParts.length,
          verified: verdict.ok ? 1 : 0,
          unitScale: inspection.unitScale,
        },
      };
    },
    dispose() {
      for (const item of disposables) {
        if (typeof item?.dispose === 'function') item.dispose();
      }
    },
  };
}
