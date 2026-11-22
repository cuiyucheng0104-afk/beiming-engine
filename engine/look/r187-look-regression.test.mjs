// S6 回归测试：three r187 的编号图与后期链对 r170 金标准的实渲对拍、冻结金标准、负对照与逐道消融，
// 以及片段补丁没命中算构建失败（FX22）：node --test engine/look/r187-look-regression.test.mjs
// 没有无头 Chrome 或没装 r187（可选依赖 three-webgpu）时，要浏览器的用例显式跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { runR187LookRegression, judgeLookRegression, verifyShaderPatchBuild, compareIdMaps, ID_CHANNEL_TOL } from './r187-look-regression.mjs';
import { W, H, STAGES, VARIANTS, EXPECT_IDS, IDS, CORRUPTIONS } from './r187-look-regression.scene.mjs';
import { thumb, thumbDiff, decodeIds, THUMB_GATE, THUMB_SKIP } from './r187-look-regression.golden.mjs';
import { TOON_PSNR_GATE_DB, TOON_MAX_FRAC_GT1, TOON_MAX_FRAC_GT5 } from '../shade/r187-toon-regression.mjs';
import { inject, patchVertex, quantizeShadow } from '../shade/patch.js';
import { anchoredFinalFs, FINAL_FS } from './compose.js';
import { PATCH_TAG, patchMiss, isPatchModule, readPatchErrors, patchSink } from '../render/lib/patch-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GOLDEN = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'engine/look/r187-look-regression.golden.json'), 'utf8'));
const POST = ['outline', 'fog', 'bloom', 'grade', 'kuwahara', 'paper', 'vignette', 'grain'];
const ID_BRANCHES = ['instance', 'shared', 'group', 'cutout', 'cut-uv', 'vertex', 'width', 'alpha', 'soft', 'own', 'false', 'noid'];

let RUN = null;
const run = () => RUN ??= runR187LookRegression();   // 实渲只跑一遍，几条用例共用；只跑不要浏览器的用例时不启动

test('S6-1 r187 对 r170：ID 图与逐级 / 整帧后期实渲过门，两页零告警，落盘报告与当前标定场景一致', async t => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  assert.deepEqual(res.revisions, { golden: '170', candidate: '187', goldenAddons: '170', candidateAddons: '187' }, 'three 与 three/addons/ 两页各自成套');
  assert.ok(TOON_PSNR_GATE_DB >= 50 && TOON_MAX_FRAC_GT1 <= 0.001 && TOON_MAX_FRAC_GT5 <= 0.001);
  assert.equal(res.consoleWarnings.length, 0, `存在非预期告警: ${res.consoleWarnings.join('; ')}`);
  assert.deepEqual(res.cases.map(c => c.id), [...STAGES.map(s => s.id), 'same-final'], '逐级（debug 视图、只开一道）、整帧与变体路径正对照都比到');
  for (const s of ['view-line', 'view-bloom', 'view-paper', 'view-kuwahara', 'final', ...POST.map(k => 'solo-' + k)]) assert.ok(STAGES.some(q => q.id === s), `缺 ${s}`);
  for (const c of res.cases) {
    assert.equal(c.pass, true, `${c.id} 未过门: psnr=${c.psnrDb} fracGt1=${c.fracGt1} fracGt5=${c.fracGt5}`);
    assert.ok(c.psnrDb >= TOON_PSNR_GATE_DB && c.fracGt1 <= TOON_MAX_FRAC_GT1 && c.fracGt5 <= TOON_MAX_FRAC_GT5);
  }
  assert.equal(res.idMap.pass, true);
  assert.equal(res.versionGatePass, true);
  assert.equal(res.overallPass, true);
  // 落盘报告与当前代码是同一套门、同一批项目（读数随机器变，不比）
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/quality/r187-look-regression.json'), 'utf8'));
  assert.deepEqual(report.gate, res.gate, '改了门限或画幅：node engine/look/r187-look-regression.mjs --write 重出报告');
  for (const k of ['cases', 'negativeControls', 'ablations']) assert.deepEqual(report[k].map(c => [c.id, c.what]), res[k].map(c => [c.id, c.what]), `报告的 ${k} 与当前标定场景不一致：重出报告`);
});

test('S6-2 ID 图：离散编号（低 11 位 / 高位两段）r187 对 r170 逐像素零差，预期编号都在、没有多的，线宽 / 可见度过门', async t => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  const m = res.idMap;
  assert.equal(m.idDiffCount, 0, `r187 与 r170 的 ID 图有 ${m.idDiffCount} 个像素编号不同；编号是离散值，不留容差`);
  assert.equal(m.widthAlphaDiffCount, 0);
  assert.ok(m.widthMaxAbsDiff <= ID_CHANNEL_TOL && m.alphaMaxAbsDiff <= ID_CHANNEL_TOL);
  assert.equal(m.rebuilt.pass, true, '重建场景再渲一遍，ID 图不变');
  assert.deepEqual(m.sides.map(s => s.id), ['r170', 'r187']);
  for (const s of m.sides) {
    assert.deepEqual(s.idsMissing, [], `${s.id}：ID 图里找不到这些编号`);
    assert.deepEqual(s.idsUnexpected, [], `${s.id}：ID 图里多出这些编号`);
    assert.equal(s.idsExpected, 12);
    assert.deepEqual([s.ball.widthOff, s.ball.alphaOff], [0, 0], `${s.id}：球的线宽系数 / 可见度不是给定值`);
    assert.ok(s.ball.open >= 1000 && s.ball.behindGlass >= 1000, `${s.id}：球露出的与被半透明玻璃半挡的两部分都要在`);
    assert.equal(s.pass, true);
  }
  // 高位段确实写进了第二个通道：编号 2047 / 2048 / 2049 的半浮点原值是 (2047, 0) / (0, 1) / (1, 1)，球（2101）是 (53, 1)
  assert.deepEqual([EXPECT_IDS.includes(2047), EXPECT_IDS.includes(2048), EXPECT_IDS.includes(2049), IDS.ball], [true, true, true, 2101]);
  const HALF = { 0: 0, 1: 0x3c00, 53: 0x52a0, 2047: 0x67ff };
  for (const side of ['golden', 'candidate']) {
    const px = res.frames[side].base.id, { id } = decodeIds(px), seen = {};
    for (let i = 0; i < id.length; i++) seen[id[i]] ??= [px[i * 4], px[i * 4 + 1]];
    assert.deepEqual([seen[2047], seen[2048], seen[2049], seen[2101]], [[HALF[2047], HALF[0]], [HALF[0], HALF[1]], [HALF[1], HALF[1]], [HALF[53], HALF[1]]], `${side}：低 / 高两段的原值`);
  }
});

test('S6-3 负对照明显跌破门限；逐道消融：只关一道后期、只改坏 ID 图的一个分支，都过不了门', async t => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  assert.ok(res.negativeControls.length >= 3, '至少 3 组负对照');
  for (const n of res.negativeControls) {
    assert.equal(n.pass, false, `负对照 ${n.id} 必须判不过`);
    assert.ok(n.psnrDb < 35 && n.caught, `负对照 ${n.id} PSNR 应明显跌破门限，实测 ${n.psnrDb}`);
  }
  assert.deepEqual(res.ablations.map(a => a.id), [...POST.map(k => 'abl-' + k), ...ID_BRANCHES.map(k => 'abl-id-' + k)], '每道后期、ID 图的每个分支各一条消融');
  for (const a of res.ablations) {
    assert.equal(a.pass, false, `消融 ${a.id}（${a.what}）必须过不了门`);
    assert.equal(a.caught, true);
    if (VARIANTS[a.id].pass === 'id') assert.ok(Math.max(a.idDiffCount, a.widthAlphaDiffCount) >= 1000, `消融 ${a.id} 只动了 ${Math.max(a.idDiffCount, a.widthAlphaDiffCount)} 个像素：让这个分支在标定画面里占更多像素`);
    else assert.ok(a.fracGt1 >= 5 * TOON_MAX_FRAC_GT1 || a.psnrDb < 40, `消融 ${a.id} 离门限太近（psnr=${a.psnrDb} fracGt1=${a.fracGt1}）：让这一道在标定画面里更显眼`);
  }
});

test('S6-4 落盘回归报告 docs/quality/r187-look-regression.{json,md} 结构完整且脱敏合规', () => {
  const jsonPath = path.join(ROOT, 'docs/quality/r187-look-regression.json'), mdPath = path.join(ROOT, 'docs/quality/r187-look-regression.md');
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8')), md = fs.readFileSync(mdPath, 'utf8');
  assert.deepEqual(report.revisions, { golden: '170', candidate: '187', goldenAddons: '170', candidateAddons: '187' });
  assert.equal(report.overallPass, true);
  assert.equal(report.versionGatePass, true);
  assert.deepEqual(report.moduleLoads, { golden: { outputPass: ['/node_modules/three/examples/jsm/postprocessing/OutputPass.js'], foreign: [] }, candidate: { outputPass: ['/node_modules/three-webgpu/examples/jsm/postprocessing/OutputPass.js'], foreign: [] } });
  assert.deepEqual([report.idMap.idDiffCount, report.idMap.idLoDiffCount, report.idMap.idHiDiffCount, report.idMap.nonFiniteCount, report.idMap.widthAlphaDiffCount, report.idMap.pass], [0, 0, 0, 0, 0, true]);
  assert.ok(report.idMap.sides.length === 2 && report.idMap.sides.every(s => s.pass && s.rawOff === 0 && s.idsMissing.length === 0 && s.highSegmentPixels > 0));
  assert.ok(report.cases.length === STAGES.length + 1 && report.cases.every(c => c.pass === true && c.psnrDb >= 50 && c.fracGt1 <= 0.001 && c.fracGt5 <= 0.001));
  assert.ok(report.negativeControls.length >= 3 && report.negativeControls.every(n => n.caught === true && n.psnrDb < 35));
  assert.ok(report.ablations.length === POST.length + ID_BRANCHES.length && report.ablations.every(a => a.caught === true));
  assert.equal(report.goldenAnchor.pass, true);
  assert.equal(report.goldenAnchor.baseline, GOLDEN().baseline, '报告对的是当前这份冻结金标准');
  assert.equal(report.consoleWarnings.length, 0);
  assert.ok(report.notes.length >= 3 && md.includes('## 两版之间的差异与处理'));
  assert.doesNotMatch(JSON.stringify(report) + '\n' + md, /\/Users\/|\/home\/|lab:\/\//);
});

test('S6-5 冻结的 r170 金标准（不随待测代码重生）：着色器摘要、缩略图与编号像素数；缩略图分得出整片偏色与高频没了', async t => {
  // 不要浏览器的部分：均值管颜色，粗糙度管均值看不出的高频
  const flat = v => new Uint8Array(W * H * 4).fill(v), noisy = (v, amp) => { const f = flat(v); for (let i = 0; i < f.length; i += 4) { const d = ((i / 4 * 2654435761) >>> 0) % (2 * amp + 1) - amp; f[i] = f[i + 1] = f[i + 2] = v + d; } return f; };
  assert.deepEqual(thumbDiff(thumb(flat(120)), thumb(flat(120))), { maxBlockDiff: 0, meanBlockDiff: 0, maxRoughDiff: 0, meanRoughDiff: 0, pass: true });
  const shifted = thumbDiff(thumb(flat(126)), thumb(flat(120)));
  assert.ok(shifted.maxBlockDiff === 6 && shifted.maxRoughDiff === 0 && !shifted.pass, '整片亮 6 级：均值超出容差');
  const grainOff = thumbDiff(thumb(flat(120)), thumb(noisy(120, 3)));
  assert.ok(grainOff.maxBlockDiff <= 1 && grainOff.meanRoughDiff > 10 * THUMB_GATE.meanRoughDiff && !grainOff.pass, `±3 级的颗粒没了：均值看不出，粗糙度超出容差 ${JSON.stringify(grainOff)}`);
  assert.equal(thumbDiff(thumb(flat(120)), new Uint8Array(0)).pass, false, '没冻结过或文件坏了算变了');
  const frozen = GOLDEN();
  assert.equal(frozen.three, '170');
  assert.ok(frozen.shaders.length >= 30 && frozen.shaders.every(d => /^[0-9a-f]{64}$/.test(d)), '冻结了标定场景在 r170 下编译的全部着色器源码的摘要');
  assert.deepEqual(Object.keys(frozen.thumbs), STAGES.map(s => s.id).filter(id => !THUMB_SKIP.includes(id)));
  assert.deepEqual(Object.keys(frozen.ids).map(Number), EXPECT_IDS, '冻结的编号就是标定场景预期的编号');
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  const g = res.goldenAnchor;
  assert.deepEqual(g.shadersChanged, { added: 0, removed: 0 }, 'r170 下编译的着色器源码变了。不是有意改画面就是回退；有意改的按 docs/style-baselines/POLICY.md 审批后重冻');
  assert.equal(g.shaders, frozen.shaders.length);
  for (const f of g.frames) assert.equal(f.pass, true, `${f.id}：r170 实渲对冻结缩略图 ${JSON.stringify(f)} 超过容差 ${JSON.stringify(THUMB_GATE)}：r170 的画面变了`);
  for (const i of g.ids) assert.equal(i.pass, true, `编号 ${i.id}：冻结 ${i.frozen} 像素，现在 ${i.now}`);
  assert.equal(g.pass, true);
});

test('S6-6 两版一起漂移时互比照样全等，靠冻结的金标准报出来；只有一版变了由互比报出来', async t => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  assert.equal(judgeLookRegression(res).overallPass, true, '不改时重判与实渲结论一致');
  const both = edit => judgeLookRegression({ ...res, frames: Object.fromEntries(['golden', 'candidate'].map(s => [s, { ...res.frames[s], base: { ...res.frames[s].base, ...edit(res.frames[s].base) } }])) });
  // 整帧一起亮 6 级
  const brighter = both(b => ({ final: b.final.map(v => Math.min(255, v + 6)) }));
  assert.equal(brighter.cases.find(c => c.id === 'final').exactMatch, true, '两版一起变，互比仍然逐字节相同');
  assert.equal(brighter.goldenAnchor.frames.find(f => f.id === 'final').pass, false);
  assert.equal(brighter.overallPass, false);
  // ID 图里躯干 + 头（2103）一起变成叶片的编号（2104）
  const regroup = b => { const id = b.id.slice(), d = decodeIds(id).id, src = d.indexOf(IDS.leaf); let hit = 0; for (let i = 0; i < d.length; i++) if (d[i] === IDS.body) { id[i * 4] = id[src * 4]; id[i * 4 + 1] = id[src * 4 + 1]; hit++; } assert.ok(hit >= 1000); return { id }; };
  const merged = both(regroup);
  assert.deepEqual([merged.idMap.idDiffCount, merged.idMap.sides[0].idsMissing, merged.idMap.sides[1].idsMissing], [0, [IDS.body], [IDS.body]]);
  assert.deepEqual(merged.goldenAnchor.ids.filter(i => !i.pass).map(i => i.id), [IDS.body, IDS.leaf], '编号没了、另一个编号的像素数涨了，冻结的金标准都报');
  assert.equal(merged.overallPass, false);
  // 着色器源码一起改了一个字符
  const drift = judgeLookRegression({ ...res, shaders: res.shaders.map((s, i) => i === 0 ? s + ' ' : s) });
  assert.deepEqual(drift.goldenAnchor.shadersChanged, { added: 1, removed: 1 });
  assert.equal(drift.overallPass, false);
  // 只有 r187 这边 20 个像素的编号变了：互比报出来，不留容差
  const one = judgeLookRegression({ ...res, frames: { ...res.frames, candidate: { ...res.frames.candidate, base: { ...res.frames.candidate.base, id: (() => {
    const id = res.frames.candidate.base.id.slice(), d = decodeIds(id).id, src = d.indexOf(IDS.pebbles); let left = 20;
    for (let i = 0; i < d.length && left; i++) if (d[i] === IDS.ball) { id[i * 4] = id[src * 4]; left--; }
    return id;
  })() } } } });
  assert.deepEqual([one.idMap.idDiffCount, one.idMap.pass, one.overallPass], [20, false, false]);
  assert.equal(compareIdMaps(res.frames.golden.base.id, res.frames.golden.base.id).pass, true);
});

test('S6-7 错版不算过门：待测页的 three 或 three/addons/ 有一样不是 r187 时报 env.three-revision-mismatch', async t => {
  const core = await runR187LookRegression({ builds: { 187: { three: '/node_modules/three/build/three.module.js' } } });
  if (core.skipped) return t.skip(core.skipped);
  assert.deepEqual(core.revisions, { golden: '170', candidate: '170', goldenAddons: '170', candidateAddons: '187' });
  assert.match(core.error ?? '', /^env\.three-revision-mismatch：/);
  assert.deepEqual([core.versionGatePass, core.overallPass], [false, false], '170 对 170 的自比不能判成双版本回归通过');
  assert.deepEqual(core.moduleLoads.candidate.foreign, ['/node_modules/three/build/three.module.js'], '待测页实际请求了 r170 的核');
  const addons = await runR187LookRegression({ builds: { 187: { addons: '/node_modules/three/examples/jsm/' } } });
  assert.deepEqual(addons.revisions, { golden: '170', candidate: '187', goldenAddons: '170', candidateAddons: '170' }, 'r187 的核配 r170 的 OutputPass');
  assert.match(addons.error ?? '', /^env\.three-revision-mismatch：.*待测页的 three 实报 r187、OutputPass 来自 r170/);
  assert.deepEqual([addons.versionGatePass, addons.overallPass], [false, false]);
  assert.deepEqual(addons.moduleLoads.candidate.outputPass, ['/node_modules/three/examples/jsm/postprocessing/OutputPass.js'], '版本取自这一页实际发出的请求');
  assert.ok(addons.moduleLoads.candidate.foreign.length >= 2, 'r170 的 OutputPass 连同它自己引的文件都算请求到了另一版的包');
  // import map 两样都对，页面里另有一处按写死的路径加载了 r170 的 OutputPass（等于 engine 里的导入绕过了 import map）：静态服务照实记下，不算过门
  const direct = await runR187LookRegression({ builds: { 187: { direct: '/node_modules/three/examples/jsm/postprocessing/OutputPass.js' } } });
  assert.deepEqual(direct.revisions, { golden: '170', candidate: '187', goldenAddons: '170', candidateAddons: '170+187' }, 'candidateAddons 照实报两版都加载了');
  assert.match(direct.error ?? '', /^env\.three-revision-mismatch：.*待测页的 three 实报 r187、OutputPass 来自 r170\+187（都要 r187），另请求了 \d+ 个另一版包里的文件/);
  assert.ok(direct.moduleLoads.candidate.foreign.includes('/node_modules/three/examples/jsm/postprocessing/OutputPass.js'));
  assert.deepEqual([direct.moduleLoads.golden.foreign, direct.versionGatePass, direct.overallPass], [[], false, false]);
  // 反过来：r170 页捎带加载了 r187 的包
  const stray = await runR187LookRegression({ builds: { 170: { direct: '/node_modules/three-webgpu/examples/jsm/postprocessing/Pass.js' } } });
  assert.deepEqual([stray.revisions.goldenAddons, stray.moduleLoads.golden.foreign.includes('/node_modules/three-webgpu/examples/jsm/postprocessing/Pass.js'), stray.versionGatePass, stray.overallPass], ['170', true, false, false]);
});

test('S6-8 命令行入口：不认识的参数 exit 2', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'engine/look/r187-look-regression.mjs'), '--not-a-s6-option'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /不认识的参数/);
});

test('S6-9 ID 判定按原始通道比：低 / 高两段各比各的，四个通道有一个不是有限数就不过', async t => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  const N = W * H, id = decodeIds(res.frames.candidate.base.id).id;
  const judge = (edit, sides = ['candidate']) => judgeLookRegression({ ...res, frames: Object.fromEntries(['golden', 'candidate'].map(s => [s, sides.includes(s) ? { ...res.frames[s], base: { ...res.frames[s].base, id: edit(res.frames[s].base.id.slice()) } } : res.frames[s]])) });
  const each = (want, max, fn) => px => { let hit = 0; for (let i = 0; i < N && hit < max; i++) if (id[i] === want) { fn(px, i * 4); hit++; } assert.ok(hit >= 100, `编号 ${want} 只有 ${hit} 个像素`); return px; };
  // 编号 2048 的 128 个像素从 (低, 高) = (0, 1) 写成 (2048, 0)：两个通道都错，合起来的编号还是 2048
  const swapped = judge(each(2048, 128, (px, o) => { px[o] = 0x6800; px[o + 1] = 0; }));
  assert.deepEqual(decodeIds(Uint16Array.of(0x6800, 0, 0, 0)).id[0], 2048);
  assert.deepEqual([swapped.idMap.idDiffCount, swapped.idMap.idLoDiffCount, swapped.idMap.idHiDiffCount, swapped.idMap.pass, swapped.overallPass], [128, 128, 128, false, false]);
  // 两版一起写成 (2048, 0)：互比全等，各版自己的核对报出来（低段必须是 0..2047 的整数）
  const both = judge(each(2048, 128, (px, o) => { px[o] = 0x6800; px[o + 1] = 0; }), ['golden', 'candidate']);
  assert.deepEqual([both.idMap.idDiffCount, both.idMap.sides.map(s => s.rawOff), both.idMap.pass, both.overallPass], [0, [128, 128], false, false]);
  // 躯干的线宽写成半浮点 NaN、可见度写成 Infinity：一版坏、两版一起坏都不过（NaN 不能被比较吞成 0）
  for (const [what, ch, bits] of [['线宽 NaN', 2, 0x7e00], ['可见度 Infinity', 3, 0x7c00], ['低段 NaN', 0, 0x7e00], ['高段 -Infinity', 1, 0xfc00]]) for (const sides of [['candidate'], ['golden', 'candidate']]) {
    const bad = judge(each(IDS.body, 500, (px, o) => { px[o + ch] = bits; }), sides);
    assert.deepEqual([bad.idMap.nonFiniteCount, bad.idMap.pass, bad.overallPass], [500, false, false], `${what}（${sides.join(' + ')}）`);
  }
  assert.deepEqual([res.idMap.idLoDiffCount, res.idMap.idHiDiffCount, res.idMap.nonFiniteCount, res.idMap.sides.map(s => s.rawOff)], [0, 0, 0, [0, 0]], '没改时都是 0');
});

test('S6-10 版本门看两张渲染页实际发出的模块请求：绕过 import map 加载了另一版的模块不算过门', async t => {
  const res = await run();
  if (res.skipped) return t.skip(res.skipped);
  const OUT = 'examples/jsm/postprocessing/OutputPass.js', own = { golden: '/node_modules/three/', candidate: '/node_modules/three-webgpu/' };
  for (const side of ['golden', 'candidate']) {
    assert.ok(res.loads[side].includes(own[side] + OUT) && res.loads[side].includes(own[side] + 'build/three.module.js'), `${side} 页实际请求了自己那一版的 three 与 OutputPass`);
    assert.deepEqual(res.loads[side].filter(p => p.startsWith(own[side === 'golden' ? 'candidate' : 'golden'])), [], `${side} 页没有请求另一版的包`);
    assert.deepEqual(res.moduleLoads[side], { outputPass: [own[side] + OUT], foreign: [] });
  }
  assert.equal(res.versionGatePass, true);
  const judge = loads => judgeLookRegression({ ...res, loads: { ...res.loads, ...loads } });
  // engine/look 里的导入写成直指 r170 的相对路径：r187 页的 import map 没问题，实际加载的却是 r170 的 OutputPass
  const bypass = judge({ candidate: res.loads.candidate.map(p => p === own.candidate + OUT ? own.golden + OUT : p) });
  assert.deepEqual(bypass.revisions, { golden: '170', candidate: '187', goldenAddons: '170', candidateAddons: '170' }, 'candidateAddons 照实报错载的那一版');
  assert.deepEqual([bypass.moduleLoads.candidate.foreign, bypass.versionGatePass, bypass.overallPass], [[own.golden + OUT], false, false]);
  // 两版的 OutputPass 都加载了、r170 页捎带请求了 r187 的包、哪一版的 OutputPass 都没请求：都不过
  const extra = judge({ candidate: [...res.loads.candidate, own.golden + 'examples/jsm/postprocessing/Pass.js'] });
  assert.deepEqual([extra.revisions.candidateAddons, extra.versionGatePass, extra.overallPass], ['187', false, false]);
  const cross = judge({ golden: [...res.loads.golden, own.candidate + OUT] });
  assert.deepEqual([cross.revisions.goldenAddons, cross.versionGatePass, cross.overallPass], ['170+187', false, false]);
  const none = judge({ candidate: res.loads.candidate.filter(p => !p.endsWith(OUT)) });
  assert.deepEqual([none.revisions.candidateAddons, none.versionGatePass, none.overallPass], ['?', false, false]);
});

// ───────── FX22：片段补丁没命中算构建失败 ─────────

test('FX22-1 patchVertex：给了 vertexNormal 钩子而着色器里没有 #include <beginnormal_vertex> 时抛错（以前悄悄不打这段补丁）', () => {
  const v = THREE.ShaderLib.toon.vertexShader, hook = { vertexNormal: 'objectNormal = normalize( objectNormal );\n' };
  assert.match(patchVertex(v, hook, {}, 'fx22'), /#include <beginnormal_vertex>\nobjectNormal = normalize\( objectNormal \);/);
  const inlined = v.replace('#include <beginnormal_vertex>', THREE.ShaderChunk.beginnormal_vertex);   // 上游把这处 #include 展开成原文：three 照常编译
  assert.throws(() => patchVertex(inlined, hook, {}, 'fx22'), /fx22：着色器锚点缺失「#include <beginnormal_vertex>」/);
  // 没给这个钩子的不要求有这个锚点（makeDepthMaterial 给阴影深度材质传的就是空的 vertexNormal）
  assert.equal(patchVertex(inlined, { vertexNormal: '', vertexBegin: 'transformed.x += 1.0;\n' }, {}, 'fx22'), patchVertex(inlined, { vertexBegin: 'transformed.x += 1.0;\n' }, {}, 'fx22'));
});

test('FX22-2 渲染器只认 patch.js 模块里的记录与机器前缀：patch.js / compose.js 抛的错归到 failure.shader-error（退出码 1），普通文字、页面自己塞的记录一概不归', async () => {
  const table = () => inject.patchErrors(), thrown = fn => { try { fn(); } catch (e) { return e; } assert.fail('应当抛错'); };
  // 真抛一遍：消息带机器前缀，名字是 ShaderPatchError，同时记进 patch.js 模块闭包里的补丁错误记录（函数名、缺的锚点、消息）
  for (const [anchor, text, run] of [
    ['#include <begin_vertex>', /^\[BEIMING_SHADER_PATCH_ERROR\] s6：着色器锚点缺失「#include <begin_vertex>」（three r170，本模块支持 r170 \/ r187）$/, () => inject('void main() {}', '#include <begin_vertex>', 'x', 'after', 's6')],
    ['#include <shadowmap_pars_fragment>', /^\[BEIMING_SHADER_PATCH_ERROR\] toon：着色器锚点缺失「#include <shadowmap_pars_fragment>」/, () => quantizeShadow('void main() {}', 'a', 'b', 'toon')],
    // compose.js 的纸纹变体借 inject 报：同一个错误类、同一份记录（以前自己拼一个同名的错、自己往全局表里记）
    ['float pp = texture2D(tPaper, gl_FragCoord.xy / uPaperSize).r;', /^\[BEIMING_SHADER_PATCH_ERROR\] compose 纸纹锚点变体对不上了：着色器锚点缺失「float pp = texture2D\(tPaper, gl_FragCoord\.xy \/ uPaperSize\)\.r」（three r170/, () => anchoredFinalFs('void main(){}')],
  ]) {
    const before = table().length, err = thrown(run), rec = table().at(-1);
    assert.match(err.message, text);
    assert.ok(err.message.startsWith(PATCH_TAG + ' ') && err.name === 'ShaderPatchError');
    assert.equal(table().length, before + 1, '抛一次记一条');
    assert.deepEqual(rec, { fn: 'inject', anchor, message: err.message });
    for (const src of [`Error: ${err.message}\n    at inject (patch.js:26:36)`, `ShaderPatchError: ${err.message}`, [rec], [rec, rec]]) {
      const e = patchMiss(src, '第 3 帧：'), body = err.message.slice(PATCH_TAG.length + 1);
      assert.deepEqual([e.code, e.exitCode], ['failure.shader-error', 1]);
      assert.ok(e.message.startsWith(`第 3 帧：着色器补丁没命中（构建失败）：${body}`) && !e.message.includes('at inject') && !e.message.includes(PATCH_TAG), e.message);
      assert.equal(e.message.endsWith('（共 2 处）'), Array.isArray(src) && src.length === 2);
      assert.match(e.hint, /不能用 --allow-gl-errors 放行/);
    }
  }
  // 不带机器前缀的文字不认：作品自己的日志、以前靠中文字样匹配的那几句，都不是补丁没命中
  for (const text of ['字幕变体对不上了，用默认字幕', 's6：着色器锚点缺失「#include <begin_vertex>」', 'toon：投影量化锚点缺失（three r188）', 'toon：软阴影采样锚点缺失', 'TypeError: x is not a function', undefined, '']) assert.equal(patchMiss(text), null, String(text));
  assert.equal(patchMiss([]), null, '记录表是空的 = 没出过错');
  // 记录不看排第几：前面混进空消息、不带机器前缀的，后面真的照样判、只数真的；一条带前缀的都没有就不判
  const real = table().at(-1), junk = [{ message: '' }, { message: '字幕变体对不上了' }, {}, null];
  assert.deepEqual([patchMiss([...junk, real])?.code, patchMiss([...junk, real])?.message.includes('（共'), patchMiss([real, ...junk, real])?.message.endsWith('（共 2 处）'), patchMiss(junk)], ['failure.shader-error', false, true, null]);
  // compose 纸纹变体：注释里先出现同一句原文，替换照样落在生效的那一句上
  const note = '// float pp = texture2D(tPaper, gl_FragCoord.xy / uPaperSize).r;\n/* uniform vec2 uRes, uPaperSize; */\n';
  assert.equal(anchoredFinalFs(note + FINAL_FS), note + anchoredFinalFs());
  // 记录在 patch.js 的模块闭包里，页面代码没有写它的入口：读到的是副本，改它、清它、往以前那个全局符号键上塞合成记录、
  // 把读出口换掉，都动不到已经记下的，也加不进一条新的
  const n = table().length, last = table().at(-1), SYM = Symbol.for('beiming.shaderPatchErrors'), had = Object.hasOwn(globalThis, SYM);
  assert.ok(n >= 3);
  try {
    table().length = 0; table().push({ fn: 'x', anchor: 'x', message: 'x' }); table()[n - 1].message = '改掉';
    (globalThis[SYM] ??= []).push({ fn: 'inject', anchor: 'A', message: `${PATCH_TAG} QA synthetic, no shader call` });
    assert.throws(() => { 'use strict'; inject.patchErrors = () => []; }, TypeError);
    assert.throws(() => Object.defineProperty(inject, 'patchErrors', { value: () => [] }), TypeError);
    assert.deepEqual([table().length, table().at(-1)], [n, last]);
  } finally { if (!had) delete globalThis[SYM]; }
  assert.equal(globalThis[SYM], undefined, 'patch.js / compose.js 不再往 globalThis 上挂记录');
  // 渲染器的读法（在页面里执行）：按页面请求过的模块地址 import 同一个实例；不是 patch.js 的地址不认，加载不了的当没有
  const here = new URL('../shade/patch.js', import.meta.url).href;
  assert.deepEqual([isPatchModule(here), isPatchModule('http://127.0.0.1:1/engine/shade/patch.js?v=2'), isPatchModule('http://127.0.0.1:1/engine/shade/toon.js'), isPatchModule('http://127.0.0.1:1/x?f=/shade/patch.js'), isPatchModule('不是地址')], [true, true, false, false, false]);
  assert.deepEqual(await readPatchErrors({ urls: [here, new URL('./no-such-module.js', import.meta.url).href] }), table());
  assert.deepEqual([await readPatchErrors({ urls: [] }), await readPatchErrors({ urls: null, re: 'x' })], [[], []]);
  assert.equal(patchMiss(await readPatchErrors({ urls: [here] })).code, 'failure.shader-error');
});

test('FX22-2b 登记口：同一个 patch.js 带上 #片段 导入是另一个模块实例，它记的错渲染器靠登记口读到；登记口只补渲染器认下来的地址的 #片段，blob: / data: 地址内容与原文逐字相同才读；登记口换不掉，口令不对读不出', async () => {
  const here = new URL('../shade/patch.js', import.meta.url).href, source = fs.readFileSync(fileURLToPath(here), 'utf8'), nodeFetch = globalThis.fetch;
  // 这里没有页面：把登记口直接放到这个进程的 globalThis 上，之后才求值的 patch.js 实例会来登记（上面那个早求值了，不在里面）
  patchSink({ secret: 's6-key', source });
  const sink = globalThis.__bmShadePatchSink, frag = here + '#s6-sink', other = await import(frag), main = () => inject.patchErrors();
  assert.notEqual(other.inject, inject, '带 #片段的地址是另一个模块实例，各记各的');
  assert.throws(() => other.inject('void main(){}', '#include <nope>', 'x', 'after', 's6-sink'), /s6-sink：着色器锚点缺失「#include <nope>」/);
  const rec = other.inject.patchErrors();
  assert.deepEqual(rec.map(r => [r.fn, r.anchor]), [['inject', '#include <nope>']]);
  assert.deepEqual(await sink.read('s6-key'), [{ url: frag, genuine: null }], '登记的是这个实例自己的模块地址（带着 #片段）');
  // 渲染器认下来 patch.js 这个地址（这里直接给）之后，登记口补上它带 #片段 的那个实例；同一个实例只读一次
  assert.deepEqual(await readPatchErrors({ urls: [here], secret: 's6-key' }), [...main(), ...rec]);
  assert.deepEqual(await readPatchErrors({ urls: [here, frag], secret: 's6-key' }), [...main(), ...rec], '按地址 import 到的是同一个模块实例：只读一次，不翻倍');
  assert.deepEqual(await readPatchErrors({ urls: [], secret: 's6-key' }), [], '渲染器没认下来的地址，登记了也不读');
  assert.deepEqual([await readPatchErrors({ urls: [here], secret: 'wrong' }), await readPatchErrors({ urls: [here] }), await sink.read()], [main(), main(), []], '口令不对读不出登记口');
  // 页面换不掉、删不掉登记口，也清不掉登记过的地址
  assert.throws(() => { globalThis.__bmShadePatchSink = null; }, TypeError);
  assert.throws(() => { delete globalThis.__bmShadePatchSink; }, TypeError);
  assert.throws(() => Object.defineProperty(globalThis, '__bmShadePatchSink', { value: null }), TypeError);
  assert.throws(() => { sink.read = async () => []; }, TypeError);
  (await sink.read('s6-key')).length = 0;
  // 合成的冒充不了：直接塞读出口（单塞、配上真的 patch.js 地址）不收；自造的报错模块（data: / blob:）内容不是 patch.js 的原文，不读，
  // 页面事后把 fetch 换成「问什么都回原文」也没用；页面没加载过的 …/shade/patch.js 地址不读（渲染器不去 import）；
  // patch.js 的地址换个 #片段 读到的是一个没出过错的新实例。注销后仍按创建时的 Blob 正文核验。
  const FAKE = { fn: 'inject', anchor: 'A', message: `${PATCH_TAG} QA synthetic, no shader call` }, fakeCode = `export const inject = { patchErrors: () => [${JSON.stringify(FAKE)}] };`;
  const data = code => 'data:text/javascript,' + encodeURIComponent(code), blob = code => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  assert.deepEqual((await import(data(fakeCode))).inject.patchErrors(), [FAKE], '这个自造模块 import 得到、也报得出合成记录');
  const gone = blob(fakeCode), revokedSource = blob(source), unknown = 'blob:' + crypto.randomUUID();
  const fakes = [data(fakeCode), data(fakeCode + '///shade/patch.js'), blob(fakeCode), gone, unknown, 'data:text/javascript;base64,!'];
  const genuine = [data(source), 'data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#instance', blob(source), revokedSource + '#instance'];
  const unloaded = ['http://127.0.0.1:1/copy/shade/patch.js#alias', new URL('./no-such/shade/patch.js', import.meta.url).href, '不是地址'];
  URL.revokeObjectURL(gone);
  URL.revokeObjectURL(revokedSource);
  globalThis.fetch = async () => new Response(source);
  try {
    for (const args of [[() => [FAKE]], [() => [FAKE], frag], [null], [here + '#s6-forge'], ...[...fakes, ...genuine, ...unloaded].map(u => [u])]) sink.register(...args);
    assert.deepEqual(await sink.read('s6-key'), [{ url: frag, genuine: null }, { url: here + '#s6-forge', genuine: null },
      ...fakes.map(url => ({ url, genuine: false })), ...genuine.map(url => ({ url, genuine: true })), ...unloaded.map(url => ({ url, genuine: null }))]);
    assert.deepEqual(await readPatchErrors({ urls: [here], secret: 's6-key' }), [...main(), ...rec], '合成的一条都没混进来（这里 Node import 不了 blob: 与带裸导入的 data: 模块，认下来的那三个读不出东西）');
  } finally { globalThis.fetch = nodeFetch; }
  assert.equal(Object.keys(globalThis).includes('__bmShadePatchSink'), false, '不可枚举');
});

test('FX22-3 两版页面里故意改错一段着色器原文：renderer.compile、look.render、单独的 ID 图三条编译路径都同步抛错并点名锚点', async t => {
  const names = Object.keys(CORRUPTIONS);
  assert.deepEqual(names, ['toon-light', 'toon-begin-vertex', 'toon-beginnormal', 'shadow-return', 'shadow-return-first', 'shadow-param-rename', 'shadow-return-comment', 'shadow-comment-space', 'depth-begin-vertex', 'pcf-kernel']);
  const res = await verifyShaderPatchBuild({ corruptions: [null, ...names] });
  if (res.skipped) return t.skip(res.skipped);
  const [clean, ...broken] = res.runs;
  assert.equal(clean.failed, false, `不改时两版三条路径都不该出错：${JSON.stringify(clean.results)}`);
  assert.deepEqual(clean.results.map(r => [r.revision, r.stages, r.recorded]), [['170', { compile: null, look: null, ids: null }, null], ['187', { compile: null, look: null, ids: null }, null]]);
  for (const b of broken) {
    const c = CORRUPTIONS[b.corrupt];
    assert.equal(b.failed, true, `${b.corrupt}（${c.what}）：构建应当失败`);
    assert.deepEqual(b.results.map(r => [r.revision, r.recorded]), [['170', 'failure.shader-error'], ['187', 'failure.shader-error']], `${b.corrupt}：页面把错都接住了，渲染器照样从 patch.js 模块里读到记录`);
    for (const r of b.results) for (const [stage, err] of Object.entries(r.stages)) {
      // 阴影深度材质只在渲阴影时编译：renderer.compile 与单独的 ID 图不碰它，整条后期链（先渲阴影）必须抛
      if (c.shadowOnly && stage !== 'look') { assert.equal(err, null, `${b.corrupt} r${r.revision} ${stage}`); continue; }
      assert.ok(err && err.includes(c.anchor), `${b.corrupt} r${r.revision} 的 ${stage} 路径应当抛错并点名「${c.anchor}」，实际：${err}`);
      assert.ok(err.startsWith(PATCH_TAG + ' s6：'), `报错带机器前缀与材质族的名字：${err}`);
      assert.equal(patchMiss(err)?.code, 'failure.shader-error');
    }
  }
});

// 用正式的出图命令渲夹具影片的第 0 帧：退出码、报错、留没留图
const stillIn = dir => (name, query, ...more) => {
  const out = path.join(dir, name), r = spawnSync(process.execPath, [path.join(ROOT, 'engine/render/still.mjs'), 'engine/look/fixtures/patch-miss', '--frame', '0', '--size', '320x240', '--out', out, ...(query ? ['--query', query] : []), ...more], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  return { status: r.status, stderr: r.stderr, png: fs.existsSync(path.join(out, 'f000000.png')), file: path.join(out, 'f000000.png') };
};

test('FX22-4 构建命令：夹具影片不改时正常出图；改错一段片段原文后，错误不管从哪里冒出来，渲染器都以非零码退出、点名锚点、不留图', async t => {
  if ((await run()).skipped) return t.skip((await run()).skipped);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-fx22-')), still = stillIn(dir);
  try {
    const ok = still('ok', '');
    assert.deepEqual([ok.status, ok.png], [0, true], `夹具影片本身要能出图：${ok.stderr}`);
    const ok187 = still('ok187', 'three=187');   // 夹具换成 r187 那一套（?three=187）
    assert.deepEqual([ok187.status, ok187.png], [0, true], `夹具影片换成 r187 也要能出图：${ok187.stderr}`);
    // 作品自己的日志里带着「变体对不上了」这样的字样（console.info / console.warn），与着色器无关：照常出图
    const chatty = still('chatty', 'log=1');
    assert.deepEqual([chatty.status, chatty.png], [0, true], `普通日志不能被当成补丁没命中：${chatty.stderr.slice(-400)}`);
    assert.doesNotMatch(chatty.stderr, /failure\.shader-error/);
    // 页面往以前那个全局符号键上塞一条合成记录、再往 console.error 打一行带机器前缀的字：记录只认 patch.js 模块闭包里的，着色器没出错就照常出图
    for (const more of [[], ['--samples', '4']]) {
      const forge = still('forge' + more.length, 'forge=1', ...more);
      assert.deepEqual([forge.status, forge.png], [0, true], `页面伪造的记录不能判构建失败（${more.join(' ')}）：${forge.stderr.slice(-400)}`);
      assert.doesNotMatch(forge.stderr, /failure\.shader-error/);
    }
    const light = /错误\[failure\.shader-error\]：.*着色器补丁没命中（构建失败）：s6：着色器锚点缺失「vec3 outgoingLight = reflectedLight\.directDiffuse/;
    for (const [name, query, want, ...more] of [
      ['load', 'corrupt=toon-light', light],                                        // 置 READY 之前预热时抛
      ['frame', 'corrupt=toon-light&when=frame', light],                            // render(t) 里抛
      ['console', 'corrupt=toon-light&when=console', light],                        // 页面自己接住、只打到控制台
      ['allow', 'corrupt=toon-light&when=console', light, '--allow-gl-errors'],     // --allow-gl-errors 不放行
      ['normal', 'corrupt=toon-beginnormal&when=frame', /错误\[failure\.shader-error\]：.*着色器锚点缺失「#include <beginnormal_vertex>」/],
      ['depth', 'corrupt=depth-begin-vertex&when=frame', /错误\[failure\.shader-error\]：.*着色器锚点缺失「#include <begin_vertex>」/],
      ['pcf', 'corrupt=pcf-kernel&when=frame', /错误\[failure\.shader-error\]：.*软阴影采样锚点缺失/],
      ['first', 'corrupt=shadow-return-first&when=frame', /错误\[failure\.shader-error\]：.*投影量化锚点缺失/],          // 几处同名锚点只坏头一处
      ['swallow', 'corrupt=toon-light&when=swallow', light],                        // 页面接住后什么都不打、照常画回退帧
      ['swallow-ss', 'corrupt=toon-light&when=swallow', light, '--samples', '4'],   // 同上，走超采样的 GPU 直出路径（lib/yuv.mjs，帧末只调 check()）
      ['swallow-first', 'corrupt=shadow-return-first&when=swallow', /错误\[failure\.shader-error\]：.*投影量化锚点缺失/],
      ['rename', 'corrupt=shadow-param-rename&when=frame', /错误\[failure\.shader-error\]：.*投影量化锚点缺失/],          // 头一个 getShadow 的形参连同返回一起改名
      ['frame-ss', 'corrupt=toon-light&when=frame', light, '--samples', '4'],        // render(t) 里抛，走超采样：同一个错误码（以前这一路是 failure.render-throw）
      ['swallow-mute', 'corrupt=toon-light&when=swallow&mute=1', light],            // 页面接住、画回退帧，console.error 也被页面静音
      // 只在 ID 图回调里冒出来的补丁错，页面接住 + 静音 console.error + 超采样（lib/yuv.mjs 的 GPU 直出）：帧落盘之前读同一份致命记录
      ['id-callback-mute-ss', 'probe=id-callback&when=swallow&mute=1', /错误\[failure\.shader-error\]：.*s6-id-callback：着色器锚点缺失「#include <color_fragment>」/, '--samples', '4'],
      ['id-callback', 'probe=id-callback', /错误\[failure\.shader-error\]：.*s6-id-callback：着色器锚点缺失「#include <color_fragment>」/],   // 只在 ID 图里冒出来的补丁错
      // 同上，但出错的 inject 来自 patch.js 的另一个模块实例（地址带 #片段：请求地址里没有它；patch%2Ejs：同一个文件的另一种写法，按路径认不出）：
      // 错记在那个实例里，渲染器靠登记口照样读到；超采样四个子帧各记一条，读出来正好 4 条（两路读法不重复算）
      ['id-callback-frag', 'probe=id-callback&when=swallow&mute=1&patch=/engine/shade/patch.js%23calibration', /错误\[failure\.shader-error\]：.*s6-id-callback：着色器锚点缺失「#include <color_fragment>」/],
      ['id-callback-frag-ss', 'probe=id-callback&when=swallow&mute=1&patch=/engine/shade/patch.js%23calibration', /错误\[failure\.shader-error\]：.*s6-id-callback：着色器锚点缺失「#include <color_fragment>」.*（共 4 处）/, '--samples', '4'],
      ['id-callback-alias', 'probe=id-callback&when=swallow&mute=1&patch=/engine/shade/patch%252Ejs', /错误\[failure\.shader-error\]：.*s6-id-callback：着色器锚点缺失「#include <color_fragment>」/],
      ['first-187', 'three=187&corrupt=shadow-return-first&when=swallow', /错误\[failure\.shader-error\]：.*投影量化锚点缺失（three r187）/],   // r187 那一套：五处里只坏头一处
      // 合法 GLSL、语义没变的改写（头一处返回里夹一段块注释；函数头与返回各用一段块注释顶替空格）：投影块不是对拍过的原文了，两版都判失败
      // （以前按文本数返回，核过了却漏换头一处，退出码 0、图里头一个 getShadow 的投影没量化）
      ['comment', 'corrupt=shadow-return-comment&when=swallow', /错误\[failure\.shader-error\]：.*投影量化锚点缺失（three r170）：投影块 shadowmap_pars_fragment 不是对拍过的原文/],
      ['comment-187', 'three=187&corrupt=shadow-return-comment&when=swallow', /错误\[failure\.shader-error\]：.*投影量化锚点缺失（three r187）/],
      ['comment-space', 'corrupt=shadow-comment-space&when=swallow', /错误\[failure\.shader-error\]：.*投影量化锚点缺失（three r170）/],
      ['comment-space-187', 'three=187&corrupt=shadow-comment-space&when=swallow', /错误\[failure\.shader-error\]：.*投影量化锚点缺失（three r187）/, '--samples', '4'],
    ]) {
      const r = still(name, query, ...more);
      assert.equal(r.status, 1, `${name}（${query}）应当以退出码 1 失败，实际 ${r.status}：${r.stderr.slice(-400)}`);
      assert.match(r.stderr, want, `${name}：报错里要点名缺的锚点`);
      assert.equal(r.png, false, `${name}：不能留下一张没打补丁的图`);
    }
    // render(t) 照常画完、返回之后 4 毫秒才冒出来的补丁错（页面里没等的异步活），页面接住、静音、画回退帧：出帧前那次读记录已经过了，
    // 截图之后再读一次。要么判失败不留图；要么错冒出来时图已经截完，留下的是没受影响的那一帧。不能留下回退帧（以前单采样退出码 0、留的就是它）
    const late = still('late', 'late=4&mute=1');
    assert.ok(late.status === 1 ? !late.png && /错误\[failure\.shader-error\]：.*s6-late：着色器锚点缺失/.test(late.stderr) : late.status === 0 && fs.readFileSync(late.file).equals(fs.readFileSync(ok.file)),
      `late：退出码 ${late.status}，${late.png ? '留了图' : '没留图'}：${late.stderr.slice(-400)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('FX22-6 原始投影锚点与 CSP 正文核验，两版在单采样和四倍采样下都执行正式出图命令', async t => {
  if ((await run()).skipped) return t.skip((await run()).skipped);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-fx22-')), still = stillIn(dir);
  try {
    for (const rev of [170, 187]) for (const samples of [1, 4]) {
      const render = (name, query) => still(`${rev}-${samples}-${name}`, `three=${rev}&${query}`, '--samples', String(samples));
      for (const suffix of ['', '&expr=1']) await t.test(`r${rev} ×${samples} 唯一锚点在死分支${suffix}`, () => {
        const miss = render(suffix ? 'dead-expr' : 'dead', 'pars=dead-only&when=swallow&mute=1' + suffix);
        assert.deepEqual([miss.status, miss.png], [1, false], miss.stderr);
        assert.match(miss.stderr, /错误\[failure\.shader-error\]：.*着色器锚点缺失「#include <shadowmap_pars_fragment>」/);
      });
      await t.test(`r${rev} ×${samples} CSP 下的健康页`, () => {
        const clean = render('clean', ''), forge = render('forge', 'csp=1&forge=1');
        assert.deepEqual([clean.status, clean.png], [0, true], clean.stderr);
        assert.deepEqual([forge.status, forge.png], [0, true], forge.stderr);
        assert.ok(fs.readFileSync(clean.file).equals(fs.readFileSync(forge.file)), '与同版本、同采样的正常 PNG 逐字节相等');
      });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('FX22-5 构建命令（四审两项与交付前红队四项）：材质参数里的注释、假锚点不把补丁引到不生效的地方；空消息的读出口挡不住真的补丁错，合成的读出口冒充不了补丁错；页面挡住 fetch、换地址加载 patch.js 也读得到', async t => {
  if ((await run()).skipped) return t.skip((await run()).skipped);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-fx22-')), still = stillIn(dir), same = (a, b) => a.png && fs.readFileSync(a.file).equals(fs.readFileSync(b.file));
  const fails = (r, want, what) => {
    assert.equal(r.status, 1, `${what} 应当以退出码 1 失败，实际 ${r.status}：${r.stderr.slice(-400)}`);
    assert.match(r.stderr, new RegExp('错误\\[failure\\.shader-error\\]：.*' + want.source), `${what}：报错里要点名锚点`);
    assert.equal(r.png, false, `${what}：不能留图`);
  };
  const ID_MISS = /s6-id-callback：着色器锚点缺失「#include <color_fragment>」/;
  try {
    for (const rev of ['170', '187']) {
      const three = rev === '187' ? 'three=187&' : '', ok = still('ok' + rev, three.slice(0, -1));
      assert.deepEqual([ok.status, ok.png], [0, true], `r${rev} 夹具影片本身要能出图：${ok.stderr.slice(-400)}`);
      // 材质的片元参数里先在注释里提到投影块的 #include（块注释 / 行注释）：补丁落在生效的那一条上，出的图与不带这段参数时逐字节相同
      // （以前量化过的投影块整段写进注释里，生效的那条 #include 展开成没量化的原版，退出码 0、图是错的）
      for (const pars of ['block', 'line']) {
        const r = still(`pars-${pars}-${rev}`, `${three}pars=${pars}`);
        assert.deepEqual([r.status, same(r, ok)], [0, true], `r${rev} pars=${pars}：要照常出图且与正常帧相同：${r.stderr.slice(-400)}`);
      }
      // 写在片元参数的预处理死分支里：钩子文本里的不当锚点，补丁照样落在原来那一条上，图与正常帧相同
      const dead = still(`pars-dead-${rev}`, `${three}pars=dead`);
      assert.deepEqual([dead.status, same(dead, ok)], [0, true], `r${rev} pars=dead：要照常出图且与正常帧相同：${dead.stderr.slice(-400)}`);
      // 片元参数把原来的锚点全盖住、在死分支里另写一套（行续接的注释、three 的 0 次循环展开）：补丁不落进死分支，构建失败或图与正常帧相同
      for (const pars of ['hide-splice', 'hide-unroll']) {
        const r = still(`pars-${pars}-${rev}`, `${three}pars=${pars}&when=swallow&mute=1`);
        assert.ok(r.status === 1 ? !r.png && /错误\[failure\.shader-error\]/.test(r.stderr) : r.status === 0 && same(r, ok), `r${rev} pars=${pars}：退出码 ${r.status}，${r.png ? '留了图' : '没留图'}：${r.stderr.slice(-400)}`);
      }
      // 生效的那条被注释掉：没有可打的地方，构建失败
      fails(still(`pars-off-${rev}`, `${three}pars=off&when=swallow&mute=1`), /着色器锚点缺失「#include <shadowmap_pars_fragment>」/, `r${rev} pars=off`);
      // HTTP 模块由宿主核验，blob: 和 data: 的源码在页面内核验。三条路径均可在 connect-src 'none' 下读取真实错误。
      for (const addr of ['/engine/shade/patch.js%23calibration', '/engine/shade//patch.js', 'blob', 'data'])
        fails(still(`csp-${rev}-${encodeURIComponent(addr)}`, `${three}csp=1&probe=id-callback&when=swallow&mute=1&patch=${addr}`), ID_MISS, `r${rev} csp ${addr}`);
      for (const more of [[], ['--samples', '4']]) {
        // 页面先往登记口塞只回空消息的读出口，真的补丁错记在 patch.js#calibration 那个实例里，页面接住、静音、画回退帧：照样判失败，只数真的
        const junk = still(`junk-${rev}-${more.length}`, `${three}junk=1&probe=id-callback&when=swallow&mute=1&patch=/engine/shade/patch.js%23calibration`, ...more);
        fails(junk, ID_MISS, `r${rev} junk ${more.join(' ')}`);
        assert.equal(/（共 4 处）/.test(junk.stderr), more.length > 0, `r${rev} junk ${more.join(' ')}：空消息不计数：${junk.stderr.slice(-300)}`);
        // 着色器一切正常，页面往登记口塞合成的读出口 / 自造的报错模块：不判失败，图与正常帧相同
        const forge = still(`forge-${rev}-${more.length}`, `${three}forge=1`, ...more);
        assert.deepEqual([forge.status, forge.png, more.length > 0 || same(forge, ok)], [0, true, true], `r${rev} forge ${more.join(' ')}：合成的记录不能判构建失败：${forge.stderr.slice(-400)}`);
        assert.doesNotMatch(forge.stderr, /failure\.shader-error/);
      }
    }
    // patch.js 的原文装进 blob: 地址再导入（不是 patch.js 的路径，请求记录里认不出）：是引擎的原文，它记的错照样读到
    fails(still('blob', 'probe=id-callback&when=swallow&mute=1&patch=blob'), ID_MISS, 'patch=blob');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
