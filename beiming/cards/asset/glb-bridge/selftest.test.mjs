import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildSyntheticGlb, create, inspectGlb, verifyPartNames } from './index.mjs';

test('asset.glb-bridge 自测：GLB 二进制（magic/version/JSON+BIN 对齐）解析与零件名 100% 保留', () => {
  const glb = buildSyntheticGlb({
    alias: 'gpu',
    expectedParts: ['body', 'fan_L', 'fan_R'],
    upAxis: 'Y',
    unitScale: 1,
    prefixAlias: true,
  });

  assert.ok(glb instanceof Uint8Array);
  assert.equal(glb.byteLength % 4, 0, 'GLB 总字节数应 4 字节对齐');

  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67, 'GLB 魔数应为 glTF');
  assert.equal(view.getUint32(4, true), 2, 'GLB 版本应为 2');
  assert.equal(view.getUint32(8, true), glb.byteLength, 'GLB 头部长度应与实际字节数一致');

  const info = inspectGlb(glb);
  assert.equal(info.format, 'glb-inspection/0.1');
  assert.equal(info.hasBinChunk, true);
  assert.equal(info.upAxis, 'Y');
  assert.equal(info.unitScale, 1);
  assert.deepEqual(info.partNames, ['body', 'fan_L', 'fan_R']);
  assert.deepEqual(info.unnamedMeshNodes, []);
  assert.deepEqual(info.duplicateNames, []);

  const verdict = verifyPartNames(glb, ['body', 'fan_L', 'fan_R'], {
    alias: 'gpu',
    strictParts: true,
    throwOnError: true,
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.matchedParts, ['body', 'fan_L', 'fan_R']);
  assert.deepEqual(verdict.missingParts, []);
  assert.deepEqual(verdict.extraParts, []);
});

test('asset.glb-bridge 自测：真实父子层级（mount -> blade）、原始三角网格顶点、PBR 材质与世界坐标 [10, 2, 0] 保真', () => {
  const halfSqrt2 = Math.SQRT1_2;
  const glb = buildSyntheticGlb({
    alias: 'rotor',
    prefixAlias: false,
    parts: [
      {
        name: 'mount',
        kind: 'group',
        translation: [10, 0, 0],
        rotation: [0, 0, halfSqrt2, halfSqrt2], // +90° 绕 Z 轴
        scale: [2, 2, 2],
      },
      {
        name: 'housing',
        kind: 'mesh',
        parent: 'mount',
        translation: [0, 0, 0],
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        material: {
          name: 'housing_mat',
          baseColorFactor: [0.7, 0.7, 0.75, 1],
          metallicFactor: 0.4,
          roughnessFactor: 0.6,
        },
      },
      {
        name: 'blade',
        kind: 'mesh',
        parent: 'mount',
        translation: [1, 0, 0],
        positions: [0, 0, 0, 0.5, 0, 0, 0, 0.5, 0],
        indices: [0, 1, 2],
        material: {
          name: 'blade_pbr',
          baseColorFactor: [0.2, 0.6, 0.9, 1],
          metallicFactor: 0.85,
          roughnessFactor: 0.25,
        },
      },
    ],
  });

  // 仅通过 params.glb 传入真实 GLB（未改默认 gpu spec），应按资产自身零件表装载
  const handle = create({ THREE }, { glb });
  const blade = handle.object.parts.blade;
  const mount = handle.object.nodes.mount;

  assert.ok(mount && blade, '应生成 mount 父节点与 blade 网格节点');
  assert.equal(blade.parent, mount, 'blade 的父节点必须是 mount 而非卡根');
  assert.equal(blade.geometry.attributes.position.count, 3, '单个三角网格必须保留原始 3 个顶点，不得替换为 36 顶点包围盒');
  assert.equal(blade.material.metalness, 0.85, '应保留原始 PBR metallicFactor');
  assert.equal(blade.material.roughness, 0.25, '应保留原始 PBR roughnessFactor');

  const worldPos = blade.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(worldPos.x - 10) < 1e-5, `blade 世界 X 应为 10，实际 ${worldPos.x}`);
  assert.ok(Math.abs(worldPos.y - 2) < 1e-5, `blade 世界 Y 应为 2，实际 ${worldPos.y}`);
  assert.ok(Math.abs(worldPos.z - 0) < 1e-5, `blade 世界 Z 应为 0，实际 ${worldPos.z}`);

  handle.dispose();
});

test('asset.glb-bridge 自测：缺零件、重名节点、匿名网格、删 BIN 块、越界子节点与非法 UTF-8 均以 usage.bad-argument 拒绝', () => {
  // 1. 缺少 fan_R
  const missingGlb = buildSyntheticGlb({
    alias: 'gpu',
    parts: ['body', 'fan_L'],
  });
  const missingVerdict = verifyPartNames(missingGlb, ['body', 'fan_L', 'fan_R']);
  assert.equal(missingVerdict.ok, false);
  assert.deepEqual(missingVerdict.missingParts, ['fan_R']);
  assert.throws(
    () => verifyPartNames(missingGlb, ['body', 'fan_L', 'fan_R'], { throwOnError: true }),
    (err) => err?.code === 'usage.bad-argument' && /缺少零件 fan_R/.test(err.message),
  );

  // 2. 重名节点
  const dupGlb = buildSyntheticGlb({
    alias: 'gpu',
    parts: ['body', 'fan_L', 'fan_L', 'fan_R'],
  });
  const dupVerdict = verifyPartNames(dupGlb, ['body', 'fan_L', 'fan_R']);
  assert.equal(dupVerdict.ok, false);
  assert.deepEqual(dupVerdict.duplicateParts, ['fan_L']);

  // 3. 匿名网格节点
  const unnamedGlb = buildSyntheticGlb({
    alias: 'gpu',
    parts: ['body', 'fan_L', 'fan_R', { name: '', kind: 'mesh' }],
  });
  const unnamedVerdict = verifyPartNames(unnamedGlb, ['body', 'fan_L', 'fan_R'], { allowExtraParts: true });
  assert.equal(unnamedVerdict.ok, false);
  assert.deepEqual(unnamedVerdict.unnamedNodes, [3]);

  // 4. 坐标系或单位不合约定（Z 向上或厘米制 0.01）
  const zUpGlb = buildSyntheticGlb({
    alias: 'gpu',
    parts: ['body', 'fan_L', 'fan_R'],
    upAxis: 'Z',
    unitScale: 0.01,
  });
  assert.throws(
    () => create({}, { glb: zUpGlb, spec: { alias: 'gpu', expectedParts: ['body', 'fan_L', 'fan_R'] } }),
    (err) => err?.code === 'usage.bad-argument' && /坐标系朝向错误/.test(err.message) && /单位尺度错误/.test(err.message),
  );

  // 5. 保留声明的 36 字节内嵌缓冲但删除 BIN 块
  const validGlb = buildSyntheticGlb({ alias: 'gpu', parts: ['body'] });
  const dv = new DataView(validGlb.buffer, validGlb.byteOffset, validGlb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const strippedBin = validGlb.slice(0, 20 + jsonLen);
  new DataView(strippedBin.buffer).setUint32(8, strippedBin.byteLength, true);
  assert.throws(
    () => inspectGlb(strippedBin),
    (err) => err?.code === 'usage.bad-argument',
  );

  // 6. 父组包含不存在的子节点索引
  assert.throws(
    () => inspectGlb({
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'mount', children: [99] }],
    }),
    (err) => err?.code === 'usage.bad-argument' && /越界节点索引/.test(err.message),
  );

  // 7. JSON 块包含非法 UTF-8 字节序列
  const badUtf8Glb = validGlb.slice();
  badUtf8Glb[22] = 0xff;
  badUtf8Glb[23] = 0xfe;
  assert.throws(
    () => inspectGlb(badUtf8Glb),
    (err) => err?.code === 'usage.bad-argument' && /UTF-8/.test(err.message),
  );
});

test('asset.glb-bridge 自测：create 交出 three 层级与零件实体，过 L2 纯函数门且拒绝稀疏数组与 NaN', () => {
  const handle = create({}, {
    spec: {
      alias: 'gpu',
      expectedParts: ['body', 'fan_L', 'fan_R'],
      upAxis: 'Y',
      unitScale: 1,
    },
  });

  assert.equal(handle.object.name, 'gpu');
  assert.deepEqual(Object.keys(handle.object.parts), ['body', 'fan_L', 'fan_R']);
  assert.ok(handle.entities.root.root);
  assert.equal(handle.entities.body.name, 'body');
  assert.equal(handle.entities.fan_L.name, 'fan_L');
  assert.equal(handle.entities.fan_R.name, 'fan_R');

  const frames = [0, 12, 24, 48, 72];
  const forward = frames.map((f) => handle.apply(f, 0.25));
  const reversed = [...frames].reverse().map((f) => handle.apply(f, 0.25)).reverse();
  const single = handle.apply(48, 0.25);

  assert.deepEqual(forward, reversed);
  assert.deepEqual(single, forward[3]);
  assert.deepEqual(handle.meta(24), {
    readings: {
      partCount: 3,
      verified: 1,
      unitScale: 1,
    },
  });

  handle.dispose();

  const sparse = ['body', , 'fan_L']; // eslint-disable-line no-sparse-arrays
  assert.throws(
    () => verifyPartNames(buildSyntheticGlb(), sparse),
    (err) => err?.code === 'usage.bad-argument',
  );
  assert.throws(
    () => create({}, { scale: Number.NaN }),
    (err) => err?.code === 'usage.bad-argument',
  );
});
