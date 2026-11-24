// 渲染底盘（对拍阶梯第 2 级）的测试。纯逻辑部分任何机器都跑；端到端部分要编得出 ../path/ 的渲染程序、取得到上游的
// 场景打包工具（git、cargo、npm、显卡），缺了就跳过并写明缺什么；BEIMING_CHASSIS_E2E=1 时缺工具链算失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { test } from 'node:test';
import { polygonIrradiance } from '../fncheck/checks.mjs';
import { COMMIT, KERNEL, SHADERS, singleCopyProblems, sourceKey } from './build.mjs';
import { CYCLES, DIFFUSE, GATES, PRINCIPLED, analyticOk, discPixels, negativeOk, negativeTolerance, passedByFloor, rectMean, runLevel2 } from './level2.mjs';

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

test('电介质与混合白炉的 Cycles 读数：金属度 0 的 11 档与金属度 0.5 的 3 档，做法与金属白炉相同且核对过，没有本机路径', () => {
  const keys = [...['0.00', '0.10', '0.20', '0.30', '0.40', '0.50', '0.60', '0.70', '0.80', '0.90', '1.00'].map(r => `0.00/${r}`), '0.50/0.20', '0.50/0.50', '0.50/0.80'];
  assert.deepEqual(Object.keys(PRINCIPLED.readings), keys);
  for (const k of keys) assert.ok(Math.abs(PRINCIPLED.readings[k] - 1) < 2e-3, k);
  assert.match(PRINCIPLED.source.renderer, /Blender 5\.2\.3.*e13b728c6880/);
  assert.match(PRINCIPLED.source.script_sha256, /^[0-9a-f]{64}$/);
  // 金属白炉的脚本没变：同一份做法
  assert.equal(PRINCIPLED.source.base_script_sha256, CYCLES.source.script_sha256);
  assert.equal(PRINCIPLED.source.method_check.reading, CYCLES.GGX['0.50']);
  assert.equal(PRINCIPLED.source.principled_defaults.distribution, 'MULTI_GGX');
  assert.deepEqual(PRINCIPLED.image, CYCLES.image);
  assert.doesNotMatch(JSON.stringify(PRINCIPLED), /\/Users\/|\/home\/|[A-Z]:\\|192\.168\./);
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

test('判据：白炉 ±0.5%，解析场景 0.2% 以内，且在 3 个标准误或相对 2e-6 以内；靠那条底才过的要提示', () => {
  assert.deepEqual(GATES, { furnaceRel: 5e-3, analyticRel: 2e-3, analyticSE: 3, analyticFloor: 2e-6 });
  const a = (rel, z) => analyticOk({ rel, z });
  assert.deepEqual([a(1.9e-6, 3.9), a(2.1e-6, 3.9), a(2e-5, 2.9), a(3e-3, 0.1), a(-1.9e-6, -9)], [true, false, true, false, true]);
  assert.deepEqual([[1.9e-6, 3.9], [1.9e-6, 2.9], [2.1e-6, 3.9]].map(([rel, z]) => passedByFloor({ rel, z })), [true, false, false]);
});

test('负对照的判法：粗的三项读数在门外且落在登记值的 ±5% 之内；细的几项要解析场景的判法判它不过，读数在登记值的 ±30% 之内', () => {
  const coarse = { gate: 2e-3, near: 1e-2 }, fine = { fine: true, gate: 2e-6, near: 2e-5 };
  assert.deepEqual([negativeTolerance(coarse), negativeTolerance(fine)], [0.05, 0.3]);
  assert.deepEqual([1.04e-2, 1.06e-2, 1.9e-3].map(worstRel => negativeOk({ ...coarse, worstRel })), [true, false, false]);
  const rows = (rel, z) => [{ rel: 1e-7, z: 0.2 }, { rel, z }];
  assert.equal(negativeOk({ ...fine, worstRel: 2.5e-5, rows: rows(2.5e-5, 12) }), true);
  assert.equal(negativeOk({ ...fine, worstRel: 2.7e-5, rows: rows(2.7e-5, 12) }), false, '读数偏出登记值 30%');
  assert.equal(negativeOk({ ...fine, worstRel: 2.0e-5, rows: rows(2.0e-5, 1.4) }), false, '判法没有判它不过（噪声里看不出来）');
});

test('内核源码的来源：来源说明写了上游与固定提交，上游许可全文在，每个源文件第一行注明来源，不含本机路径', () => {
  const read = f => fs.readFileSync(path.join(KERNEL, f), 'utf8');
  const prov = read('PROVENANCE.md'), third = fs.readFileSync(path.join(KERNEL, '..', '..', '..', '..', 'THIRD-PARTY.md'), 'utf8');
  assert.ok(prov.includes('https://github.com/meshy-dev/ThreeRT'));
  assert.ok(prov.includes(COMMIT));
  assert.match(prov, /MIT/);
  const lic = read('LICENSE-upstream.txt');
  assert.match(lic, /^MIT License/);
  assert.match(lic, /Meshy LLC/);
  assert.match(lic, /Permission is hereby granted, free of charge/);
  const sources = ['src', 'shaders'].flatMap(d => fs.readdirSync(path.join(KERNEL, d)).map(f => `${d}/${f}`));
  // 从上游 pathtrace.wgsl 按阶段分出来的几段，来源行写的是上游那一个文件
  const split = ['closure', 'film', 'integrator', 'intersect', 'light', 'shader', 'volume'].map(n => `shaders/${n}.wgsl`);
  // 照 Cycles 移植的两个哈希文件不是上游 ThreeRT 的：Apache-2.0，版权与许可写在文件头
  const cycles = ['shaders/hash.wgsl', 'src/cycles_hash.rs'];
  // 北冥新写的文件（不是上游的，也没有照 Cycles 取东西）：MIT，文件头写版权人
  const own = ['src/pack.rs'];
  assert.equal(sources.length, 35);
  // （下面的正则里有许可标识的字样，它不是本文件的许可声明：让许可覆盖的扫描跳过这一段。）
  // REUSE-IgnoreStart
  for (const f of cycles) {
    assert.match(read(f), /^\/\/ SPDX-FileCopyrightText: 2011-2022 Blender Foundation\n(\/\/ SPDX-FileCopyrightText: .*\n)*\/\/ SPDX-License-Identifier: Apache-2\.0\n/, f);
    assert.ok(prov.includes(`\`${f}\``), `来源说明里没有 ${f}`);
  }
  // 带着照 Cycles 取的名字、数值或函数骨架的六个着色器：第一行仍是上游的来源，其后的文件头是多方许可
  for (const [f, id] of Object.entries({ integrator: 'MIT AND Apache-2.0', sample: 'MIT AND Apache-2.0', closure: 'MIT AND Apache-2.0', pathtrace: 'MIT AND Apache-2.0', intersect: 'MIT AND Apache-2.0', shader: 'MIT AND Apache-2.0 AND BSD-3-Clause' })) {
    const text = read(`shaders/${f}.wgsl`);
    assert.ok(text.split('\n').slice(1, 7).includes(`// SPDX-License-Identifier: ${id}`), `${f}.wgsl 的文件头`);
    assert.match(text, /^\/\/ SPDX-FileCopyrightText: 2011-2022 Blender Foundation$/m, f);
    assert.ok(prov.includes(`| \`shaders/${f}.wgsl\` | MIT`), `来源说明「照 Cycles 取的部分」里没有 ${f}.wgsl`);
  }
  // Rust 一侧带着同一类内容（着色器里那一份在 CPU 上的镜像）的三个文件，同样的文件头
  for (const f of ['src/gpu.rs', 'src/sample.rs', 'src/scene.rs']) {
    const text = read(f);
    assert.deepEqual(text.split('\n').slice(1, 5), ['// SPDX-FileCopyrightText: 2026 Meshy LLC', '// SPDX-FileCopyrightText: 2011-2022 Blender Foundation', '// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine', '// SPDX-License-Identifier: MIT AND Apache-2.0'], `${f} 的文件头`);
    assert.ok(prov.includes(`| \`${f}\` | MIT 与 Apache-2.0 |`), `来源说明「照 Cycles 取的部分」里没有 ${f}`);
    assert.ok(third.includes(`\`${path.basename(f)}\`（`), `第三方清单核心那一条里没有 ${f}`);
  }
  assert.doesNotMatch(prov, /除 `cycles_hash\.rs` 之外的全部/);
  assert.match(read('shaders/pathtrace.wgsl').split('\n').slice(0, 12).join('\n'), /ObjectExt 的字段名 receiver_light_set、lightgroup/);
  for (const f of own) {
    assert.match(read(f), /^\/\/ SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine\n\/\/ SPDX-License-Identifier: MIT\n/, f);
    assert.ok(prov.includes(`\`${f}\``), `来源说明里没有 ${f}`);
    assert.doesNotMatch(read(f), /\/Users\/|\/home\/[a-z]|192\.168\./, f);
  }
  // REUSE-IgnoreEnd
  for (const f of sources.filter(f => !cycles.includes(f) && !own.includes(f))) {
    const first = read(f).split('\n', 1)[0], from = split.includes(f) ? 'shaders/pathtrace.wgsl' : f;
    assert.ok(first.startsWith('// 源自 ThreeRT') && first.includes(COMMIT) && first.includes(`renderer/${from}`) && first.includes('MIT') && first.includes('Meshy LLC') && first.includes('PROVENANCE.md'), f);
    assert.ok(prov.includes(`\`${f}\``) || prov.includes(`\`${path.basename(f)}\``), `来源说明的文件对照里没有 ${f}`);
    assert.doesNotMatch(read(f), /\/Users\/|\/home\/[a-z]|192\.168\./, f);
  }
});

test('内核的包名与程序名不用上游项目名；五个移植的着色器仓库里只有一份，内核直接读它', () => {
  const cargo = fs.readFileSync(path.join(KERNEL, 'Cargo.toml'), 'utf8');
  assert.match(cargo, /^name = "beiming-core-path"$/m);
  assert.match(cargo, /^\[\[bin\]\]\nname = "core-render"$/m);
  assert.equal(SHADERS.length, 5);
  assert.deepEqual(singleCopyProblems(), []);
  for (const f of SHADERS) assert.ok(fs.existsSync(path.join(KERNEL, '..', 'shaders', f)), f);
  // 程序按源码内容的摘要命名，负对照的改错也算进摘要
  assert.match(sourceKey(), /^[0-9a-f]{16}$/);
  assert.equal(sourceKey(), sourceKey([]));
  assert.notEqual(sourceKey([{ file: 'path/src/lib.rs', from: 'a', to: 'b' }]), sourceKey());
});

test('漫反射白炉的记录：按显卡各记一个，没记过的显卡按相对 1e-6 比', () => {
  assert.equal(DIFFUSE.tolerance, 1e-6);
  for (const v of Object.values(DIFFUSE.recorded)) assert.ok(Math.abs(v - 1) < 0.02);
});

test('端到端：第 2 级（构建、白炉对 Cycles、解析场景、负对照、确定性）', { timeout: 7_200_000 }, async t => {
  let rep;
  try {
    rep = await runLevel2({ allowFetch: E2E, log: s => t.diagnostic(s) });
  } catch (e) {
    if (e.missing && !E2E) { t.skip(`缺工具链：${e.missing}`); return; }
    throw e;
  }
  await t.test('构建：从仓库内的源码编，上游的提交号对，上游自带的漫反射白炉过且均值与记录相等', () => {
    assert.equal(rep.core.source, 'beiming/sources/core/path');
    assert.equal(rep.core.shaders.length, SHADERS.length);
    assert.equal(rep.upstream.commit, COMMIT);
    const d = rep.diffuseFurnace;
    t.diagnostic(`漫反射白炉：${d.adapter}（${d.backend}）均值 ${d.mean}，记录 ${d.recorded}，${d.rule}`);
    assert.equal(d.status, 'pass');
    assert.equal(d.matches, true);
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
  await t.test('解析场景：正对、斜向、近灯、灯后有板四种几何各 32 个种子，像素均值对解析值 0.2% 以内，且在 3 个标准误或相对 2e-6 以内', () => {
    assert.deepEqual(rep.analytic.map(a => [a.name, a.seeds]), [['正对', 32], ['斜向', 32], ['近灯', 32], ['灯后有板', 32]]);
    for (const a of rep.analytic) {
      t.diagnostic(`${a.name}: 我方 ${a.mean.toExponential(6)} ± ${a.se.toExponential(2)}（${a.seeds} 个种子）  解析 ${a.exact.toExponential(6)}  相对差 ${a.rel.toExponential(2)}  ${a.z.toFixed(2)} 个标准误`);
      if (passedByFloor(a)) t.diagnostic(`提示 ${a.name} 超过了 ${GATES.analyticSE} 个标准误，是按相对 ${GATES.analyticFloor} 的底过的`);
      assert.ok(analyticOk(a), `${a.name} 相对差 ${a.rel}，差 ${a.z} 个标准误`);
    }
  });
  await t.test('电介质与混合白炉：原理化 BSDF 14 个读数都在 Cycles 的 ±0.5% 之内，噪声远小于门限', () => {
    assert.equal(rep.principled.rows.length, 14);
    assert.equal(rep.principled.rows.length, Object.keys(PRINCIPLED.readings).length);
    for (const r of rep.principled.rows) {
      t.diagnostic(`金属度 ${r.metalness} 粗糙度 ${r.roughness}: 我方 ${r.ours.toFixed(6)} ± ${r.se.toExponential(1)}  Cycles ${r.cycles.toFixed(6)}  相对差 ${r.rel.toExponential(2)}`);
      assert.ok(Math.abs(r.rel) <= GATES.furnaceRel, `${r.key} 相对差 ${r.rel}`);
      assert.ok(r.se / r.cycles < GATES.furnaceRel / 10, `${r.key} 标准误 ${r.se}`);
    }
  });
  await t.test('Pharr 自发光球：32 个种子，像素均值对 Le/(1 − 反照率) 0.2% 以内，且在 3 个标准误或相对 2e-6 以内', () => {
    assert.deepEqual(rep.emissive.map(a => [a.name, a.seeds]), [['Pharr 自发光球', 32]]);
    for (const a of rep.emissive) {
      t.diagnostic(`${a.name}: 我方 ${a.mean.toPrecision(7)} ± ${a.se.toExponential(2)}  解析 ${a.exact}  相对差 ${a.rel.toExponential(2)}  ${a.z.toFixed(2)} 个标准误`);
      assert.ok(analyticOk(a), `${a.name} 相对差 ${a.rel}，差 ${a.z} 个标准误`);
    }
  });
  await t.test('负对照：闭包、面光、接线、原理化 BSDF 故意改错十一项，每项必须不过，读数落在登记值的容差之内（粗的八项 ±5%，细的三项 ±30%）', () => {
    assert.deepEqual(rep.negative.map(n => n.target), ['closure', 'area_light', 'mis', 'area_light_fine', 'mis_origin', 'mis_occluder', 'dielectric_fresnel', 'layering', 'diffuse', 'pick', 'emission']);
    for (const n of rep.negative) {
      t.diagnostic(`${n.name}: 最大相对差 ${n.worstRel.toExponential(2)}（门限 ${n.gate}，登记值 ${n.near}，容差 ±${negativeTolerance(n) * 100}%）`);
      assert.ok(negativeOk(n), n.name);
    }
  });
  await t.test('确定性：同一种子渲两遍，输出逐字节相同', () => {
    assert.equal(rep.determinism.identical, true, `最大差 ${rep.determinism.maxAbsDiff}`);
  });
});
