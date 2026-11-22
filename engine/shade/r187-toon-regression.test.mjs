// S5 回归测试：three r187 卡通着色栈对 r170 金标准的实渲 PSNR 对拍、负对照分辨力与回归报告校验
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { runR187ToonRegression, compareFrames, TOON_PSNR_GATE_DB, TOON_MAX_FRAC_GT1 } from './r187-toon-regression.mjs';
import { inject, quantizeShadow } from './patch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let RUN = null;
const run = () => RUN ??= runR187ToonRegression();   // 实渲只跑一遍，几条用例共用；只跑不要浏览器的用例时不启动

test('S5-1 r187 对 r170 卡通着色四类核心特性实渲过 PSNR 门，且负对照必被拦截', async (t) => {
  const res = await run();
  if (res.skipped) {
    t.skip(res.skipped);
    return;
  }
  assert.equal(res.revisions.golden, '170');
  assert.equal(res.revisions.candidate, '187');
  assert.ok(TOON_PSNR_GATE_DB >= 45);
  assert.equal(res.consoleWarnings.length, 0, `存在非预期告警: ${res.consoleWarnings.join('; ')}`);
  assert.ok(res.cases.length >= 4, '至少覆盖 4 类卡通着色子场景');
  for (const item of res.cases) {
    assert.equal(item.pass, true, `${item.id} 未过 PSNR 门: psnr=${item.psnrDb}`);
    assert.ok(item.psnrDb >= TOON_PSNR_GATE_DB, `${item.id} PSNR ${item.psnrDb} < ${TOON_PSNR_GATE_DB}`);
  }
  assert.ok(res.negativeControls.length >= 3, '至少 3 组负对照');
  for (const neg of res.negativeControls) {
    assert.equal(neg.pass, false, `负对照 ${neg.id} 必须判不过`);
    assert.ok(neg.psnrDb < 35, `负对照 ${neg.id} PSNR 应明显跌破门限，实测 ${neg.psnrDb}`);
  }
  assert.equal(res.overallPass, true);
  // 落盘报告与当前代码是同一套门、同一批项目（读数随机器变，不比）
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/quality/r187-toon-regression.json'), 'utf8'));
  assert.deepEqual(report.gate, res.gate, '改了门限或画幅：node engine/shade/r187-toon-regression.mjs --write 重出报告');
  for (const k of ['cases', 'negativeControls', 'ablations']) assert.deepEqual(report[k].map(c => [c.id, c.what]), res[k].map(c => [c.id, c.what]), `报告的 ${k} 与当前标定场景不一致：重出报告`);
});

test('S5-6 整帧之外逐子区都比到（彩色与法线 / ID 通道各四个）；逐特性消融：只关一项特性就过不了门', async (t) => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  const regions = ['bands-rim-fill-sky', 'shadow-deform', 'surface-layers', 'instanced-tints'];
  assert.deepEqual(res.cases.map(c => c.id), ['frame', ...regions, 'id-frame', ...regions.map(r => 'id:' + r)]);
  for (const c of res.cases) assert.ok(c.fracGt1 <= TOON_MAX_FRAC_GT1, `${c.id}：差 > 1 级的像素 ${c.fracGt1} 超过 ${TOON_MAX_FRAC_GT1}`);
  // 契约点名的特性每项至少一条消融
  for (const id of ['abl-band3', 'abl-feather', 'abl-edge-noise', 'abl-rim-core', 'abl-rim-break', 'abl-fill', 'abl-sky', 'abl-patch', 'abl-paint-stroke', 'abl-paint-grain', 'abl-mural', 'abl-inst-tint', 'abl-id-outline-w', 'abl-id-instance'])
    assert.ok(res.ablations.some(a => a.id === id), `缺消融 ${id}`);
  for (const a of res.ablations) {
    assert.equal(a.pass, false, `消融 ${a.id}（${a.what}）必须过不了门：psnr=${a.psnrDb} fracGt1=${a.fracGt1}`);
    assert.ok(a.fracGt1 >= 5 * TOON_MAX_FRAC_GT1 || a.psnrDb < 40, `消融 ${a.id} 离门限太近（psnr=${a.psnrDb} fracGt1=${a.fracGt1}）：让这项特性在标定画面里占更多像素`);
  }
});

test('S5-2 落盘回归报告 docs/quality/r187-toon-regression.{json,md} 结构完整且脱敏合规', () => {
  const jsonPath = path.join(ROOT, 'docs/quality/r187-toon-regression.json');
  const mdPath = path.join(ROOT, 'docs/quality/r187-toon-regression.md');
  assert.equal(fs.existsSync(jsonPath), true);
  assert.equal(fs.existsSync(mdPath), true);
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(report.revisions.golden, '170');
  assert.equal(report.revisions.candidate, '187');
  assert.equal(report.overallPass, true);
  assert.ok(Array.isArray(report.cases) && report.cases.length >= 4);
  assert.ok(Array.isArray(report.negativeControls) && report.negativeControls.length >= 3);
  assert.ok(Array.isArray(report.ablations) && report.ablations.length >= 14 && report.ablations.every(a => a.caught === true));
  const raw = fs.readFileSync(jsonPath, 'utf8') + '\n' + fs.readFileSync(mdPath, 'utf8');
  assert.doesNotMatch(raw, /\/Users\/|\/home\/|lab:\/\//);
});

test('S5-3 版本告警：r170 / r187 两页零告警（S5-1 已断言），没对拍过的版本（r187 构建改号 999）照旧告警', async (t) => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  assert.equal(res.unknownRevisionWarnings.length, 1, `应当只有一条版本告警：${res.unknownRevisionWarnings.join('; ')}`);
  assert.match(res.unknownRevisionWarnings[0], /engine\/shade 只在 three r170 \/ r187 上对拍过，当前 r999：锚点不匹配时会直接报错/);
});

test('S5-4 quantizeShadow：r170 的投影块与改动前逐字相同；r187 的块换回软阴影核；r187 式的块里采样锚点没了就报错', async (t) => {
  const frag = THREE.ShaderLib.toon.fragmentShader, keep = THREE.ShaderChunk.shadowmap_pars_fragment;
  const ANCHOR = 'return mix( 1.0, shadow, shadowIntensity );', quant = 'return mix( 1.0, smoothstep( a, b, shadow ), shadowIntensity );';
  // 改动前的实现：只把返回值过 smoothstep
  assert.equal(quantizeShadow(frag, 'a', 'b', 't'), inject(frag, '#include <shadowmap_pars_fragment>', keep.replaceAll(ANCHOR, quant), 'replace', 't'));
  assert.doesNotMatch(quantizeShadow(frag, 'a', 'b', 't'), /TOON_CMP/);
  const src187 = path.join(ROOT, 'node_modules/three-webgpu/src/renderers/shaders/ShaderChunk/shadowmap_pars_fragment.glsl.js');
  if (!fs.existsSync(src187)) return t.skip('env.three-r187-missing：没装可选依赖 three-webgpu');
  const { default: chunk187 } = await import(pathToFileURL(src187).href);
  try {
    THREE.ShaderChunk.shadowmap_pars_fragment = chunk187;
    const out = quantizeShadow(frag, 'a', 'b', 't');
    assert.match(out, /#define TOON_CMP\( ox, oy \) texture\( shadowMap, vec3\( toonUv/);
    assert.doesNotMatch(out, /vogelDiskSample\( 0, 5, phi \)/, '二维投影的 Vogel 采样被换掉');
    assert.match(out, /vogelDiskSample\( i, 5, phi \)/, '点光源的采样不动');
    assert.equal(out.split(quant).length - 1, chunk187.split(ANCHOR).length - 1, '每个 getShadow 的返回值都量化');
    THREE.ShaderChunk.shadowmap_pars_fragment = chunk187.replace('vogelDiskSample( 0, 5, phi )', 'vogelDiskSample( 0, 8, phi )');
    assert.throws(() => quantizeShadow(frag, 'a', 'b', 't6'), /t6：软阴影采样锚点缺失/);
  } finally { THREE.ShaderChunk.shadowmap_pars_fragment = keep; }
});

test('S5-5 compareFrames：逐字节相同记 99 dB；有差时 PSNR、最大差与占比按区域算', () => {
  const a = new Uint8Array(4 * 4 * 4).fill(100), b = a.slice();
  const full = { x: 0, y: 0, w: 4, h: 4 };
  assert.deepEqual(compareFrames(a, b, { width: 4, region: full }), { psnrDb: 99, exactMatch: true, maxAbsDiff: 0, fracGt1: 0, fracGt5: 0 });
  b[(1 * 4 + 2) * 4] = 110;   // 像素 (2, 1) 的 R 差 10 级
  const m = compareFrames(a, b, { width: 4, region: full });
  assert.equal(m.psnrDb, Math.round(1000 * Math.log10(255 * 255 * 48 / 100)) / 100);
  assert.deepEqual([m.exactMatch, m.maxAbsDiff, m.fracGt1, m.fracGt5], [false, 10, 0.0625, 0.0625]);
  assert.equal(compareFrames(a, b, { width: 4, region: { x: 0, y: 2, w: 4, h: 2 } }).exactMatch, true, '差在区域外');
  b[(1 * 4 + 2) * 4] = 100; b[(1 * 4 + 2) * 4 + 3] = 0;   // 只有 alpha 不同：三通道看不到，四通道看得到
  assert.equal(compareFrames(a, b, { width: 4, region: full }).exactMatch, true);
  assert.equal(compareFrames(a, b, { width: 4, region: full, channels: 4 }).maxAbsDiff, 100);
});
