// B 路线 GLB 结构检查（engine/native/bridge/validate.mjs，审查 R09）：用手搓的小 GLB 覆盖——
// 不带法线的模型能过（不再 TypeError）；UV 访问器越出自己的 bufferView、逆绑定矩阵含 NaN、缺 POSITION、文件被截断都给出可读原因；
// 命令行：文件不存在 exit 2，结构不合格 exit 4。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateGLBBuffer } from '../../engine/native/bridge/validate.mjs';

const ENTRY = fileURLToPath(new URL('../../engine/native/bridge/validate.mjs', import.meta.url));

function glb(json, bin) {
  const pad = (b, c) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, c)]);
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20), b = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const chunk = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, buf]); };
  return Buffer.concat([header, chunk(j, 0x4e4f534a), chunk(b, 0x004e4942)]);
}
const floats = a => Buffer.from(new Float32Array(a).buffer);

// 一个三角形：POSITION + TEXCOORD_0，没有 NORMAL；可选再挂一个蒙皮的逆绑定矩阵
function triangle({ uvCount = 3, ibm = null, dropPosition = false } = {}) {
  const pos = floats([0, 0, 0, 1, 0, 0, 0, 1, 0]), uv = floats([0, 0, 1, 0, 0, 1]);
  const parts = [pos, uv], views = [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }];
  const accessors = [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
    { bufferView: 1, componentType: 5126, count: uvCount, type: 'VEC2' },
  ];
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'tri', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: dropPosition ? { TEXCOORD_0: 1 } : { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ name: 'm', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }], accessors, bufferViews: views };
  if (ibm) {
    parts.push(floats(ibm));
    views.push({ buffer: 0, byteOffset: 60, byteLength: 64 });
    accessors.push({ bufferView: 2, componentType: 5126, count: 1, type: 'MAT4' });
    json.nodes.push({ name: 'joint' });
    json.skins = [{ joints: [1], inverseBindMatrices: 2 }];
  }
  const bin = Buffer.concat(parts);
  json.buffers = [{ byteLength: bin.length }];
  return glb(json, bin);
}
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('不带 NORMAL 的模型能通过（R09：不再在 get(undefined) 上 TypeError）', () => {
  const s = validateGLBBuffer(triangle());
  assert.equal(s.sceneTriangles, 1);
  assert.equal(s.accessorsChecked, 2);
});

test('UV 访问器越出自己的 bufferView（哪怕没越出整个 BIN 块）要报出来', () => {
  assert.throws(() => validateGLBBuffer(triangle({ uvCount: 4 })), /访问器 1 越出自己的 bufferView/);
});

test('逆绑定矩阵含 NaN 要报出来（所有访问器都读，含 MAT4）', () => {
  assert.doesNotThrow(() => validateGLBBuffer(triangle({ ibm: I4 })));
  const bad = [...I4]; bad[5] = NaN;
  assert.throws(() => validateGLBBuffer(triangle({ ibm: bad })), /不是有限数/);
});

test('缺 POSITION、文件被截断、动画期望不符：给出可读原因', () => {
  assert.throws(() => validateGLBBuffer(triangle({ dropPosition: true })), /缺 POSITION/);
  const t = triangle();
  assert.throws(() => validateGLBBuffer(t.subarray(0, t.length - 8)), /文件被截断|长度/);
  assert.throws(() => validateGLBBuffer(triangle(), { animated: true }), /恰好一段动画/);
  assert.throws(() => validateGLBBuffer(triangle(), { maxBytes: 100 }), /超过上限/);
});

test('命令行：不存在的文件 exit 2；不合格 exit 4；合格 exit 0 且 --json 只出一个对象', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bne-glb-'));
  try {
    const ok = join(dir, 'ok.glb'), bad = join(dir, 'bad.glb');
    writeFileSync(ok, triangle());
    writeFileSync(bad, triangle({ uvCount: 4 }));
    assert.equal(spawnSync(process.execPath, [ENTRY, join(dir, 'none.glb')], { timeout: 30000 }).status, 2);
    assert.equal(spawnSync(process.execPath, [ENTRY, bad], { timeout: 30000 }).status, 4);
    const r = spawnSync(process.execPath, [ENTRY, ok, '--json'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
