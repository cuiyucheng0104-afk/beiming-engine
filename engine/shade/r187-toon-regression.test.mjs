// S5 回归测试：three r187 卡通着色栈对 r170 金标准的实渲 PSNR 对拍、负对照分辨力与回归报告校验
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { runR187ToonRegression, judgeToonRegression, compareFrames, TOON_PSNR_GATE_DB, TOON_MAX_FRAC_GT1, TOON_MAX_FRAC_GT5 } from './r187-toon-regression.mjs';
import { QW, QH, REGIONS } from './r187-toon-regression.scene.mjs';
import { inject, quantizeShadow } from './patch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGION_IDS = ['bands-rim-fill-sky', 'shadow-deform', 'surface-layers', 'instanced-tints'];
const GOLDEN = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'engine/shade/r187-toon-regression.golden.json'), 'utf8'));

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
  assert.ok(TOON_PSNR_GATE_DB >= 45 && TOON_MAX_FRAC_GT1 <= 0.001 && TOON_MAX_FRAC_GT5 <= 0.001);
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
  const regions = REGION_IDS;
  // 最后两条是变体路径的正对照：不改参数、只渲一个子区，必须与金标准对得上（裁剪或通道写错时消融会全体「拦住」，靠它们报出来）
  assert.deepEqual(res.cases.map(c => c.id), ['frame', ...regions, 'id-frame', ...regions.map(r => 'id:' + r), 'same-color', 'same-id']);
  for (const c of res.cases) assert.ok(c.fracGt1 <= TOON_MAX_FRAC_GT1, `${c.id}：差 > 1 级的像素 ${c.fracGt1} 超过 ${TOON_MAX_FRAC_GT1}`);
  // 契约点名的特性每项至少一条消融
  for (const id of ['abl-band3', 'abl-feather', 'abl-edge-noise', 'abl-rim-core-back', 'abl-rim-core-lit', 'abl-rim-break', 'abl-fill', 'abl-sky', 'abl-patch', 'abl-paint-stroke', 'abl-paint-grain', 'abl-mural', 'abl-inst-tint', 'abl-id-outline-w', 'abl-id-instance'])
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
  assert.ok(report.layoutChecks.length === 8 && report.layoutChecks.every(c => c.pass === true && c.alphaDiffCount === 0), '报告里要有两版各四条拼图布局核对，物体 / 实例 ID 零差异');
  assert.equal(report.goldenAnchor.pass, true);
  assert.equal(report.goldenAnchor.baseline, GOLDEN().baseline, '报告对的是当前这份冻结金标准');
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
  assert.deepEqual(compareFrames(a, b, { width: 4, region: full }), { psnrDb: 99, exactMatch: true, maxAbsDiff: 0, fracGt1: 0, fracGt5: 0, pass: true });
  b[(1 * 4 + 2) * 4] = 110;   // 像素 (2, 1) 的 R 差 10 级
  const m = compareFrames(a, b, { width: 4, region: full });
  assert.ok(Math.abs(m.psnrDb - 10 * Math.log10(255 * 255 * 48 / 100)) < 1e-9, '读数不舍入');
  assert.deepEqual([m.exactMatch, m.maxAbsDiff, m.fracGt1, m.fracGt5, m.pass], [false, 10, 0.0625, 0.0625, false]);
  assert.equal(compareFrames(a, b, { width: 4, region: { x: 0, y: 2, w: 4, h: 2 } }).exactMatch, true, '差在区域外');
  b[(1 * 4 + 2) * 4] = 100; b[(1 * 4 + 2) * 4 + 3] = 0;   // 只有 alpha 不同：三通道看不到，四通道看得到
  assert.equal(compareFrames(a, b, { width: 4, region: full }).exactMatch, true);
  assert.equal(compareFrames(a, b, { width: 4, region: full, channels: 4 }).maxAbsDiff, 100);
  // 判门用未舍入的读数。临界反例：320 × 240，28 个像素只有 R 差 128、另 1 个差 124 → 44.99667 dB，四舍五入是 45，但没到 45
  const p = new Uint8Array(320 * 240 * 4), whole = { width: 320, region: { x: 0, y: 0, w: 320, h: 240 } };
  const withDiffs = (...ds) => { const q = p.slice(); ds.forEach((d, i) => { q[i * 4] = d; }); return q; };
  const n128 = n => Array(n).fill(128);
  const edge = compareFrames(p, withDiffs(...n128(28), 124), { ...whole, minPsnrDb: 45 });
  assert.ok(Math.abs(edge.psnrDb - 44.9966723194) < 1e-9, `PSNR ${edge.psnrDb}`);
  assert.ok(edge.fracGt1 <= TOON_MAX_FRAC_GT1, '这个反例只卡 PSNR，像素占比是过的');
  assert.equal(edge.pass, false, '44.99667 dB 不能过 45 dB 的门');
  assert.equal(compareFrames(p, withDiffs(...n128(28), 122), { ...whole, minPsnrDb: 45 }).pass, true, '那一个像素差 122 级时是 45.0012 dB，刚过');
  // 默认门是 50 dB：9 个像素差 128、另 1 个差 50 → 49.99599 dB（四舍五入是 50.00）不过；另 1 个差 48 → 50.00167 dB 过；同一张图按 45 dB 的门是过的
  assert.equal(TOON_PSNR_GATE_DB, 50);
  const edge50 = compareFrames(p, withDiffs(...n128(9), 50), whole);
  assert.ok(Math.abs(edge50.psnrDb - 49.9959898830) < 1e-9, `PSNR ${edge50.psnrDb}`);
  assert.ok(edge50.fracGt1 <= TOON_MAX_FRAC_GT1 && edge50.fracGt5 <= TOON_MAX_FRAC_GT5, '这个反例只卡 PSNR');
  assert.equal(edge50.pass, false, '49.99599 dB 不能过 50 dB 的门');
  assert.equal(compareFrames(p, withDiffs(...n128(9), 50), { ...whole, minPsnrDb: 50 }).pass, false);
  assert.equal(compareFrames(p, withDiffs(...n128(9), 48), whole).pass, true);
  assert.equal(compareFrames(p, withDiffs(...n128(9), 50), { ...whole, minPsnrDb: 45 }).pass, true);
  // 差 > 5 级的像素占比也进判定：只有 1 个像素差 6 级（1 / 76800 ≈ 0.00001302），上限 0.000013 时不过，默认上限与 0.0000131 时过
  const one6 = compareFrames(p, withDiffs(6), { ...whole, maxFracGt5: 0.000013 });
  assert.equal(one6.fracGt5, 1 / 76800);
  assert.ok(one6.psnrDb >= TOON_PSNR_GATE_DB && one6.fracGt1 <= TOON_MAX_FRAC_GT1, '这个反例只卡差 > 5 级的占比');
  assert.equal(one6.pass, false, 'fracGt5 超过 maxFracGt5 不能过门');
  assert.equal(compareFrames(p, withDiffs(6), { ...whole, maxFracGt5: 0.0000131 }).pass, true);
  assert.equal(compareFrames(p, withDiffs(6), whole).pass, true);
  assert.equal(compareFrames(p, withDiffs(6), { ...whole, maxFracGt1: 0.000013 }).pass, false, 'maxFracGt1 同样可调');
});

test('S5-7 拼图布局：两版的四个法线 / ID 子区各自对得上单独渲的 320 × 240 参照（最大差 ≤ 1 级），且含预期的物体 / 实例 ID', async (t) => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  assert.deepEqual(res.layoutChecks.map(c => c.id), ['r170', 'r187'].flatMap(v => REGION_IDS.map(r => `${v}:${r}`)));
  // 物体 ID：球 + 绳结；地面 + 芦苇 + 球 + 环；四个表面层物体各是自己那一族的 1 号；地面 + 12 个实例
  assert.deepEqual(res.layoutChecks.slice(0, 4).map(c => c.idsExpected), [2, 4, 1, 13]);
  for (const c of res.layoutChecks) {
    assert.ok(c.maxAbsDiff <= 1 && c.fracGt1 === 0, `${c.id}：拼图里的子区与独立参照不一致（psnr=${c.psnrDb}，最大差 ${c.maxAbsDiff} 级）：子区视口 / 裁剪没对上，或这个子区没画进去`);
    assert.deepEqual(c.idsMissing, [], `${c.id}：通道里找不到这些物体 / 实例 ID`);
    assert.equal(c.alphaDiffCount, 0, `${c.id}：拼图里的物体 / 实例 ID（alpha）与独立参照有 ${c.alphaDiffCount} 个像素不同；ID 是离散值，不留容差`);
    assert.equal(c.pass, true);
  }
});

test('S5-8 冻结的 r170 金标准（不随待测代码重生）：64 段着色器源码与 uniform 初值的摘要没变', async () => {
  const { shaderDigests } = await import('./r187-toon-regression.golden.mjs');
  const now = shaderDigests(), frozen = GOLDEN();
  assert.equal(Object.keys(now).length, 16, '4 族材质 × 4 组参数，每组卡通 / 深度的顶点与片元共 4 段');
  for (const [k, d] of Object.entries(frozen.shaders)) assert.deepEqual(now[k], d, `${k}：r170 下的着色器源码或 uniform 初值变了。不是有意改画面就是回退；有意改的按 docs/style-baselines/POLICY.md 审批后重冻`);
  assert.deepEqual(Object.keys(now), Object.keys(frozen.shaders));
});

test('S5-8b uniform 初值摘要按 WebGL 实传的单精度算：float64 末位漂移（Node 22 / 24 的 Math.pow 差 1 ULP）不改摘要，单精度分得出的改动照拦', async () => {
  const { shaderDigests } = await import('./r187-toon-regression.golden.mjs');
  const base = shaderDigests(), uniforms = d => Object.values(d).map(x => x.uniforms);
  for (const k of [1 + 1e-15, 1 - 1e-15]) assert.deepEqual(shaderDigests(x => x * k), base, `所有 uniform 浮点初值乘 ${k} 后摘要应当不变`);
  const moved = shaderDigests(x => x + 1e-5);
  for (const [k, d] of Object.entries(base)) {
    assert.notEqual(moved[k].uniforms, d.uniforms, `${k}：uniform 初值挪了 1e-5，摘要没变`);
    assert.equal(moved[k].shaders, d.shaders, `${k}：只动 uniform 初值不该改着色器源码摘要`);
  }
  assert.equal(new Set(uniforms(base)).size > 1, true);
});

test('S5-9 冻结的 r170 金标准：实渲的 r170 彩色帧四个子区对冻结缩略图都在容差内；缩略图比对分得出分档线移动', async (t) => {
  const { thumb, thumbDiff, THUMB_GATE } = await import('./r187-toon-regression.golden.mjs');
  // 不要浏览器的部分：320 × 240 的两色画面，分界线横移 6 像素（分档阈值漂移的样子）必须超出容差
  const frame = edge => { const f = new Uint8Array(320 * 240 * 4); for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) f.fill(x < edge ? 200 : 90, (y * 320 + x) * 4, (y * 320 + x) * 4 + 3); return f; };
  const whole = { x: 0, y: 0 }, ref = thumb(frame(150), 320, whole);
  assert.deepEqual(thumbDiff(thumb(frame(150), 320, whole), ref), { maxBlockDiff: 0, meanBlockDiff: 0, pass: true });
  const moved = thumbDiff(thumb(frame(156), 320, whole), ref);
  assert.ok(moved.maxBlockDiff > THUMB_GATE.maxBlockDiff && moved.meanBlockDiff > THUMB_GATE.meanBlockDiff && !moved.pass, JSON.stringify(moved));
  assert.equal(thumbDiff(ref, new Uint8Array(0)).pass, false, '没冻结过或文件坏了算变了');
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  const g = res.goldenAnchor;
  assert.equal(g.shaders, 64);
  assert.deepEqual(g.shadersChanged, [], 'r170 下的着色器源码或 uniform 初值变了');
  assert.deepEqual(g.regions.map(r => r.id), REGION_IDS);
  for (const r of g.regions) assert.equal(r.pass, true, `${r.id}：r170 实渲对冻结缩略图的块均值差（最大 ${r.maxBlockDiff}、平均 ${r.meanBlockDiff} 级）超过容差 ${JSON.stringify(THUMB_GATE)}：r170 的画面变了`);
  assert.equal(g.pass, true);
});

test('S5-10 错版不算过门：候选页的 three 实报不是 r187（这里指到 r170 的构建）时报 env.three-revision-mismatch', async (t) => {
  const res = await runR187ToonRegression({ builds: { 187: '/node_modules/three/build/three.module.js' } });
  if (res.skipped) return t.skip(res.skipped);
  assert.deepEqual(res.revisions, { golden: '170', candidate: '170' });
  assert.match(res.error ?? '', /^env\.three-revision-mismatch：/);
  assert.equal(res.overallPass, false, '170 对 170 的自比不能判成双版本回归通过');
});

test('S5-11 命令行入口：经符号链接路径启动也进命令行，不认识的参数 exit 2', (t) => {
  const real = path.join(ROOT, 'engine/shade/r187-toon-regression.mjs');
  const bad = file => spawnSync(process.execPath, [file, '--not-a-s5-option'], { encoding: 'utf8' });
  assert.equal(bad(real).status, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-link-')), link = path.join(dir, 'r187-toon-regression.mjs');
  try {
    try { fs.symlinkSync(real, link); } catch (e) { return t.skip(`这台机器建不了符号链接：${e.code}`); }
    const r = bad(link);
    assert.equal(r.status, 2, `经符号链接启动应当 exit 2，实际 ${r.status}：${r.stderr}`);
    assert.match(r.stderr, /不认识的参数/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S5-12 离散的物体 ID 精确匹配：拼图读回里的 ID 227 改成 226（只差 1 级）时报缺 227、整体不过门', async (t) => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  const r = REGIONS.find(q => q.id === 'surface-layers'), W = QW * 2;
  const tamper = side => {
    const id = Buffer.from(res.frames[side].base.id); let hit = 0;
    for (let y = r.y; y < r.y + QH; y++) for (let x = r.x; x < r.x + QW; x++) { const i = (y * W + x) * 4 + 3; if (id[i] === 227) { id[i] = 226; hit++; } }
    assert.ok(hit >= 16, `${side}：表面层子区里应当有物体 ID 227`);
    return { ...res.frames, [side]: { ...res.frames[side], base: { ...res.frames[side].base, id } } };
  };
  assert.equal(judgeToonRegression(res).overallPass, true, '不改时重判与实渲结论一致');
  for (const [side, tag] of [['golden', 'r170'], ['candidate', 'r187']]) {
    const out = judgeToonRegression({ ...res, frames: tamper(side) });
    const c = out.layoutChecks.find(q => q.id === `${tag}:surface-layers`);
    assert.deepEqual(c.idsMissing, [227], `${tag}：226 不能顶替 227`);
    assert.ok(c.alphaDiffCount >= 16 && c.maxAbsDiff <= 1, 'RGB 法线没动，只有 alpha 差 1 级');
    assert.equal(c.pass, false);
    assert.equal(out.overallPass, false);
  }
});
