// 渲染底盘（对拍阶梯第 2 级）的测试。纯逻辑部分任何机器都跑；端到端部分要取得到 ThreeRT 源码、编得出它的渲染程序
// （git、cargo、npm、显卡），缺了就跳过并写明缺什么；BEIMING_CHASSIS_E2E=1 时缺工具链算失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import { test } from 'node:test';
import { polygonIrradiance } from '../fncheck/checks.mjs';
import { PATCH } from './build.mjs';
import { CYCLES, GATES, discPixels, rectMean, runLevel2 } from './level2.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';
const ROUGHNESS = ['0.05', '0.10', '0.20', '0.30', '0.40', '0.50', '0.60', '0.70', '0.80', '0.90', '1.00'];

test('Cycles 读数：两套各 11 档粗糙度共 22 个，带来源说明，单次散射随粗糙度单调变暗，没有本机路径', () => {
  for (const d of ['GGX', 'MULTI_GGX']) assert.deepEqual(Object.keys(CYCLES[d]), ROUGHNESS);
  const ggx = ROUGHNESS.map(r => CYCLES.GGX[r]);
  for (let k = 1; k < ggx.length; k++) assert.ok(ggx[k] < ggx[k - 1]);
  for (const r of ROUGHNESS) assert.ok(Math.abs(CYCLES.MULTI_GGX[r] - 1) < 1e-3);
  assert.match(CYCLES.source.renderer, /Blender 5\.2\.3.*e13b728c6880/);
  assert.match(CYCLES.source.script_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(CYCLES.image, { width: 128, height: 128, sphere_radius_px: 51.2, inner_disc_frac: 0.9, pixels: 6676 });
  assert.doesNotMatch(JSON.stringify(CYCLES), /\/Users\/|\/home\/|[A-Z]:\\|192\.168\./);
});

test('内盘掩码与 Cycles 的读数口径相同：128×128、像素中心离画面中心小于 0.9×51.2 像素的正好 6676 个', () => {
  const px = discPixels(128, 128, 0.9 * 51.2);
  assert.equal(px.length, 6676);
  assert.ok(px.every(i => i >= 0 && i < 128 * 128));
});

test('解析值：区域缩成一点时等于形状因子；正对的方形灯与闭式解一致；对称区域上灯左右翻转读数不变', () => {
  const L = 3, albedo = 0.5;
  const light = { center: [0, 0, 2], u: [0.1, 0, 0], v: [0, 0.1, 0] };
  const corners = [[-0.1, -0.1, 2], [0.1, -0.1, 2], [0.1, 0.1, 2], [-0.1, 0.1, 2]];
  const point = rectMean({ L, albedo, light, half: 1e-6 });
  assert.ok(Math.abs(point / (albedo / Math.PI * L * polygonIrradiance([0, 0, 0], [0, 0, 1], corners)) - 1) < 1e-9);
  // ThreeRT 自带测试里的闭式解：边长 s、高 h 的正对方形灯，X = s / 2h
  const X = 0.2 / 2 / 2, E = 4 * L * (X / Math.sqrt(1 + X * X)) * Math.atan(X / Math.sqrt(1 + X * X));
  assert.ok(Math.abs(point / (albedo * E / Math.PI) - 1) < 1e-9);
  const tilted = { center: [0.8, 0, 0.9], u: [0.15, 0, -0.13], v: [0, 0.2, 0] };
  const mirrored = { center: [-0.8, 0, 0.9], u: [-0.15, 0, -0.13], v: [0, 0.2, 0] };
  const a = rectMean({ L, albedo, light: tilted, half: 0.1 }), b = rectMean({ L, albedo, light: mirrored, half: 0.1 });
  assert.ok(a > 0 && Math.abs(a / b - 1) < 1e-9);
});

test('判据：白炉 ±0.5%，解析场景 0.2% 且在 3 个标准误之内', () => {
  assert.deepEqual(GATES, { furnaceRel: 5e-3, analyticRel: 2e-3, analyticSE: 3 });
});

test('补丁：只改 ThreeRT 的内核着色器与拼接着色器的 gpu.rs；头部注明 ThreeRT 的 MIT 许可与版权人；不含本机路径', () => {
  const text = fs.readFileSync(PATCH, 'utf8');
  const files = [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].map(m => m[1]);
  assert.deepEqual([...new Set(files)].sort(), ['renderer/shaders/pathtrace.wgsl', 'renderer/src/gpu.rs']);
  const head = text.slice(0, text.indexOf('diff --git'));
  assert.match(head, /Meshy LLC/);
  assert.ok(head.includes('SPDX-License-' + 'Identifier: MIT')); // 拆开写：许可扫描会把连着写的标签当成本文件的许可
  assert.doesNotMatch(text, /\/Users\/|\/home\/|192\.168\./);
});

test('端到端：第 2 级（构建、白炉对 Cycles、解析场景、负对照、确定性）', { timeout: 7_200_000 }, async t => {
  let rep;
  try {
    rep = await runLevel2({ allowFetch: E2E, log: s => t.diagnostic(s) });
  } catch (e) {
    if (e.missing && !E2E) { t.skip(`缺工具链：${e.missing}`); return; }
    throw e;
  }
  await t.test('构建：提交号对、我方着色器逐字节相同、ThreeRT 自带的漫反射白炉读数不变', () => {
    assert.equal(rep.threert.commit, 'c946cc96bdb08979224e851a7fc67a066b1b456b');
    assert.equal(rep.threert.shaders.length, 4);
    for (const s of rep.threert.shaders) assert.equal(s.copied, s.repo, s.file);
    const d = rep.diffuseFurnace;
    t.diagnostic(`漫反射白炉：补丁前 ${d.before}，补丁后 ${d.after}，逐字节相同 ${d.identical}，逐像素最大差 ${d.maxAbsDiff}`);
    assert.equal(d.statusBefore, 'pass');
    assert.equal(d.status, 'pass');
    assert.ok(Math.abs(d.after / d.before - 1) < 1e-6);
  });
  await t.test('白炉：22 个读数都在 Cycles 的 ±0.5% 之内，噪声远小于门限，换相机距离读数不变', () => {
    assert.equal(rep.furnace.rows.length, 22);
    for (const r of rep.furnace.rows) {
      t.diagnostic(`${r.distribution} ${r.roughness}: 我方 ${r.ours.toFixed(6)} ± ${r.se.toExponential(1)}  Cycles ${r.cycles.toFixed(6)}  相对差 ${r.rel.toExponential(2)}`);
      assert.ok(Math.abs(r.rel) <= GATES.furnaceRel, `${r.distribution} ${r.roughness} 相对差 ${r.rel}`);
      assert.ok(r.se / r.cycles < GATES.furnaceRel / 10, `${r.distribution} ${r.roughness} 标准误 ${r.se}`);
    }
    assert.ok(rep.furnace.camera.maxRelChange < GATES.furnaceRel / 10, `换相机距离的最大变化 ${rep.furnace.camera.maxRelChange}`);
  });
  await t.test('解析场景：正对与斜向两种几何，像素均值对解析值 0.2% 以内且在 3 个标准误之内', () => {
    assert.deepEqual(rep.analytic.map(a => a.name), ['正对', '斜向']);
    for (const a of rep.analytic) {
      t.diagnostic(`${a.name}: 我方 ${a.mean.toExponential(6)} ± ${a.se.toExponential(2)}（${a.seeds} 个种子）  解析 ${a.exact.toExponential(6)}  相对差 ${a.rel.toExponential(2)}  ${a.z.toFixed(2)} 个标准误`);
      assert.ok(Math.abs(a.rel) <= GATES.analyticRel, `${a.name} 相对差 ${a.rel}`);
      assert.ok(Math.abs(a.z) <= GATES.analyticSE, `${a.name} 差 ${a.z} 个标准误`);
    }
  });
  await t.test('负对照：闭包、面光、补丁里的多重重要性采样各故意改错一项，对应读数必须超出门限', () => {
    assert.deepEqual(rep.negative.map(n => n.target), ['closure', 'area_light', 'mis']);
    for (const n of rep.negative) {
      t.diagnostic(`${n.name}: 最大相对差 ${n.worstRel.toExponential(2)}（门限 ${n.gate}）`);
      assert.ok(Math.abs(n.worstRel) > n.gate, n.name);
    }
  });
  await t.test('确定性：同一种子渲两遍，输出逐字节相同', () => {
    assert.equal(rep.determinism.identical, true, `最大差 ${rep.determinism.maxAbsDiff}`);
  });
});
