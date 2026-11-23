import assert from 'node:assert/strict';
import test from 'node:test';
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

test('asset.glb-bridge 自测：缺零件、重名节点、匿名网格节点、非 Y 向上或非米制必须检出并拒绝', () => {
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

  // 5. 损坏魔数
  const badBytes = new Uint8Array(glbHeaderBroken());
  assert.throws(
    () => inspectGlb(badBytes),
    (err) => err?.code === 'usage.bad-argument' && /魔数错误/.test(err.message),
  );
});

function glbHeaderBroken() {
  const b = new Uint8Array(24);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x12345678, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, 24, true);
  return b.buffer;
}

test('asset.glb-bridge 自测：create 交出 three 层级与零件实体，且过 L2 纯函数门（顺序 / 逆序 / 跳帧一致）', () => {
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
});

test('asset.glb-bridge 自测：零陷阱拦截 Proxy、getter、稀疏数组与 NaN', () => {
  let traps = 0;
  const proxySpec = new Proxy({ expectedParts: ['body'] }, {
    get() {
      traps++;
      return ['body'];
    },
  });
  assert.throws(
    () => buildSyntheticGlb(proxySpec),
    (err) => err?.code === 'usage.bad-argument',
  );

  const getterParams = {};
  Object.defineProperty(getterParams, 'spec', {
    enumerable: true,
    get() {
      traps++;
      return { expectedParts: ['body'] };
    },
  });
  assert.throws(
    () => create({}, getterParams),
    (err) => err?.code === 'usage.bad-argument',
  );

  const sparse = ['body', , 'fan_L']; // eslint-disable-line no-sparse-arrays
  assert.throws(
    () => verifyPartNames(buildSyntheticGlb(), sparse),
    (err) => err?.code === 'usage.bad-argument',
  );

  assert.throws(
    () => create({}, { scale: Number.NaN }),
    (err) => err?.code === 'usage.bad-argument',
  );
  assert.equal(traps, 0, '任何 Proxy 或 getter 陷阱都不得被触发');
});
