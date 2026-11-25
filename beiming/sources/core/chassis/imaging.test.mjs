// 成像一路第 2 级（imaging.mjs）的测试。纯逻辑部分任何机器都跑；端到端部分要 cargo 与显卡，缺了就跳过并写明缺什么；
// BEIMING_CHASSIS_E2E=1 时缺工具链算失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { OUT, sourceKey } from './build.mjs';
import { CORNER, GATES, GLOSSY, GLOSSY_REF, KNIFE_CASES, NEGATIVE, clampedSky, cornerBounces, cornerQuads, filterCdf, geometryOk, glossyPack, mirrorBounces, mirrorQuads, regionReading, runImaging, viewBounces } from './imaging.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';

test('判据：刀口每列 4 个标准误，夹取 3 个标准误、标准误为 0 时相对 1e-5，滤光泽 4 个合并标准误、判得出要超过 5 个；刀口七组，负对照七项', () => {
  assert.deepEqual(GATES, { knifeSE: 4, clampSE: 3, clampRel: 1e-5, glossySE: 4, glossyDistinct: 5 });
  assert.equal(KNIFE_CASES.length, 7);
  assert.equal(NEGATIVE.length, 7);
});

test('滤光泽：场景与读数口径对上 Cycles 一侧的记录，区域读数的标准误照种子间方差算', () => {
  const sc = GLOSSY_REF.source.scene;
  assert.deepEqual(sc.resolution, [GLOSSY.w, GLOSSY.h]);
  assert.deepEqual(sc.region, GLOSSY.region);
  assert.deepEqual(GLOSSY_REF.rows.map(r => r.blur_glossy), [0, GLOSSY.blur]);
  // 换轴之后地面在 y = 0、法线朝 +y；板的法线是 Cycles 一侧记下的那个（换轴 (x, y, z) → (x, z, −y)）
  const p = glossyPack(), [floor, plate] = p.meshes;
  for (const [i, v] of [0, 1, 0].entries()) assert.ok(Math.abs(floor.normals[i] - v) < 1e-15);
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(floor.positions[3 * k + 1]) < 1e-15);
  const n = sc.plate_normal;
  for (const [i, v] of [n[0], n[2], -n[1]].entries()) assert.ok(Math.abs(plate.normals[i] - v) < 1e-12, `${plate.normals[i]} 对 ${v}`);
  // 两个种子、两个像素：均值是四个数的平均；种子间方差各是 0.5、2，标准误 sqrt((0.5 + 2) / 2) / 2
  const img = vals => Float32Array.from(vals.flatMap(v => [v, v, v]));
  const r = regionReading([img([1, 2]), img([2, 4])], { w: 2, region: [0, 1] });
  assert.equal(r.mean, 1.5);
  assert.ok(Math.abs(r.se - Math.sqrt(0.5 / 2)) < 1e-12);
});

test('夹取的手算值照 Cycles：三个分量之和超过 3 × 上限时按比例缩；白天空每个分量夹到上限，没超的不动', () => {
  assert.deepEqual(clampedSky([1, 1, 1], 0.2).map(x => +x.toFixed(12)), [0.2, 0.2, 0.2]);
  const c = clampedSky([1, 0.5, 0.25], 0.2);
  for (const [k, v] of [1, 0.5, 0.25].entries()) assert.ok(Math.abs(c[k] - v * (0.6 / 1.75)) < 1e-15);
  assert.deepEqual(clampedSky([1, 0.5, 0.25], 1), [1, 0.5, 0.25]);
});

test('几何：单面镜每条相机射线恰好反射一次、直角反射器恰好两次，离开时都朝上；视锥放宽后追踪认得出别的次数', () => {
  const m = mirrorBounces(), c = cornerBounces();
  assert.ok(geometryOk(m, 1), JSON.stringify(m));
  assert.ok(geometryOk(c, 2), JSON.stringify(c));
  assert.equal(c.count[2], 65 * 65);
  // 负对照：视角放宽到 tan = 0.5，有的射线只打到一面镜子；单面镜视角放大到镜子外，有的射线一次都不反射
  assert.ok(!geometryOk(viewBounces(cornerQuads(), CORNER.cam, 0.5, 1, 16), 2));
  assert.ok(!geometryOk(viewBounces(mirrorQuads(), [0, 0, 3], 30, 1, 16), 1));
});

test('连续滤波函数的累积分布：两端是 0 与 1，对称，盒式是线性的', () => {
  for (const [kind, w] of KNIFE_CASES) {
    const F = filterCdf(kind, w);
    assert.equal(F(-100), 0);
    assert.equal(F(100), 1);
    assert.ok(Math.abs(F(0) - 0.5) < 1e-9, `${kind} ${w}`);
    assert.ok(Math.abs(F(0.3) + F(-0.3) - 1) < 1e-9, `${kind} ${w}`);
  }
  assert.ok(Math.abs(filterCdf('box', 3)(0.75) - 0.75) < 1e-9);
});

test('端到端：成像一路的第 2 级（刀口剖面、几何、夹取、滤光泽、逐位相同、负对照）', { timeout: 7_200_000 }, async t => {
  // runImaging 一上来就编渲染程序：不设 E2E、又没有编好的，就不在这里现编（CI 上从头编要好几分钟，编完才发现没有显卡）
  if (!E2E && !fs.existsSync(path.join(OUT, 'bin', `core-render-${sourceKey([])}${process.platform === 'win32' ? '.exe' : ''}`))) {
    t.skip('没有编好的渲染程序（设 BEIMING_CHASSIS_E2E=1 现编）');
    return;
  }
  let rep;
  try {
    rep = await runImaging({ log: s => t.diagnostic(s) });
  } catch (e) {
    if (e.missing && !E2E) { t.skip(`缺工具链：${e.missing}`); return; }
    throw e;
  }
  t.diagnostic(`显卡：${rep.adapter}（${rep.backend}）`);
  await t.test('刀口：七组每列对 Cycles 滤波表给出的分布不超过 4 个标准误', () => {
    assert.equal(rep.knife.length, 7);
    for (const c of rep.knife) {
      t.diagnostic(`${c.name}: 最差第 ${c.worst.column} 列 ${c.worst.z.toFixed(2)} 个标准误；对连续滤波函数最差 ${c.continuousWorst.z.toFixed(2)}（只记录）`);
      assert.ok(c.ok, `${c.name} 最差 ${c.worst.z}`);
    }
  });
  await t.test('几何：单面镜一次、直角反射器两次', () => {
    assert.deepEqual(rep.geometry, { mirror: true, corner: true });
  });
  await t.test('夹取：逐通道对手算值，不该起作用的上限与不夹逐位相同', () => {
    assert.equal(rep.clamp.cases.length, 8);
    for (const c of rep.clamp.cases) {
      t.diagnostic(`${c.name}: ${c.ok ? '过' : '不过'}`);
      assert.ok(c.ok, c.name);
    }
  });
  await t.test('滤光泽：关与开各对 Cycles 不超过 4 个合并标准误，开与关之差两边都超过 5 个', () => {
    assert.equal(rep.glossy.length, 3);
    for (const c of rep.glossy) assert.ok(c.ok, c.name);
  });
  await t.test('逐位相同：盒式宽 1 显式给出、两个上限给 0、滤光泽给 0', () => {
    assert.equal(rep.bitwise.length, 3);
    for (const c of rep.bitwise) assert.ok(c.ok, c.name);
  });
  await t.test('负对照：七项每项故意改错一处，对应的一项必须不过', () => {
    assert.equal(rep.negative.length, NEGATIVE.length);
    for (const n of rep.negative) {
      t.diagnostic(`${n.name}: ${n.rows.map(r => `${r.name} ${r.ok ? '过' : '不过'}（${r.reading}）`).join('；')}`);
      assert.ok(n.caught, n.name);
    }
  });
  assert.ok(rep.ok);
});
