// 成像一路第 2 级（imaging.mjs）的测试。纯逻辑部分任何机器都跑；端到端部分要 cargo 与显卡，缺了就跳过并写明缺什么；
// BEIMING_CHASSIS_E2E=1 时缺工具链算失败。
import assert from 'node:assert/strict';
import process from 'node:process';
import { test } from 'node:test';
import { CORNER, GATES, KNIFE_CASES, NEGATIVE, clampedSky, cornerBounces, cornerQuads, filterCdf, geometryOk, mirrorBounces, mirrorQuads, runImaging, viewBounces } from './imaging.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';

test('判据：刀口每列 4 个标准误，夹取 3 个标准误、标准误为 0 时相对 1e-5；刀口七组，负对照六项', () => {
  assert.deepEqual(GATES, { knifeSE: 4, clampSE: 3, clampRel: 1e-5 });
  assert.equal(KNIFE_CASES.length, 7);
  assert.equal(NEGATIVE.length, 6);
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

test('端到端：成像一路的第 2 级（刀口剖面、几何、夹取、逐位相同、负对照）', { timeout: 7_200_000 }, async t => {
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
  await t.test('逐位相同：盒式宽 1 显式给出、两个上限给 0', () => {
    for (const c of rep.bitwise) assert.ok(c.ok, c.name);
  });
  await t.test('负对照：六项每项故意改错一处，对应的一项必须不过', () => {
    assert.equal(rep.negative.length, NEGATIVE.length);
    for (const n of rep.negative) {
      t.diagnostic(`${n.name}: ${n.rows.map(r => `${r.name} ${r.ok ? '过' : '不过'}（${r.reading}）`).join('；')}`);
      assert.ok(n.caught, n.name);
    }
  });
  assert.ok(rep.ok);
});
