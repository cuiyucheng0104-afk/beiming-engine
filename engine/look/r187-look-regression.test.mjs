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
import { patchVertex } from '../shade/patch.js';
import { PATCH_MISS, patchMiss } from '../render/lib/patch-check.mjs';

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
  assert.deepEqual([report.idMap.idDiffCount, report.idMap.widthAlphaDiffCount, report.idMap.pass], [0, 0, true]);
  assert.ok(report.idMap.sides.length === 2 && report.idMap.sides.every(s => s.pass && s.idsMissing.length === 0 && s.highSegmentPixels > 0));
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
  assert.equal(core.overallPass, false, '170 对 170 的自比不能判成双版本回归通过');
  const addons = await runR187LookRegression({ builds: { 187: { addons: '/node_modules/three/examples/jsm/' } } });
  assert.deepEqual(addons.revisions, { golden: '170', candidate: '187', goldenAddons: '170', candidateAddons: '170' }, 'r187 的核配 r170 的 OutputPass');
  assert.match(addons.error ?? '', /^env\.three-revision-mismatch：.*待测页的 three 实报 r187、OutputPass 来自 r170/);
  assert.equal(addons.overallPass, false);
});

test('S6-8 命令行入口：不认识的参数 exit 2', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'engine/look/r187-look-regression.mjs'), '--not-a-s6-option'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /不认识的参数/);
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

test('FX22-2 渲染器认得补丁没命中的报错：三种写法都归到 failure.shader-error（退出码 1），别的报错不归', () => {
  for (const msg of ['s6：着色器锚点缺失「#include <begin_vertex>」（three r187，本模块支持 r170 / r187）', 'toon：投影量化锚点缺失（three r188）：return mix( 1.0, shadow, shadowIntensity );', 'toon：软阴影采样锚点缺失（three r188）：vogelDiskSample( 0, 5, phi )', 'compose：FINAL_FS 里找不到纸纹取样那一行，锚点变体对不上了']) {
    assert.match(msg, PATCH_MISS);
    const e = patchMiss(`Error: ${msg}\n    at inject (patch.js:26:36)`, '第 3 帧：');
    assert.deepEqual([e.code, e.exitCode], ['failure.shader-error', 1]);
    assert.ok(e.message.startsWith('第 3 帧：着色器补丁没命中（构建失败）：') && e.message.includes(msg) && !e.message.includes('at inject'), e.message);
    assert.match(e.hint, /不能用 --allow-gl-errors 放行/);
  }
  assert.equal(patchMiss('TypeError: x is not a function'), null);
  assert.equal(patchMiss(undefined), null);
});

test('FX22-3 两版页面里故意改错一段着色器原文：renderer.compile、look.render、单独的 ID 图三条编译路径都同步抛错并点名锚点', async t => {
  const names = Object.keys(CORRUPTIONS);
  assert.deepEqual(names, ['toon-light', 'toon-begin-vertex', 'toon-beginnormal', 'shadow-return', 'depth-begin-vertex', 'pcf-kernel']);
  const res = await verifyShaderPatchBuild({ corruptions: [null, ...names] });
  if (res.skipped) return t.skip(res.skipped);
  const [clean, ...broken] = res.runs;
  assert.equal(clean.failed, false, `不改时两版三条路径都不该出错：${JSON.stringify(clean.results)}`);
  assert.deepEqual(clean.results.map(r => [r.revision, r.stages]), [['170', { compile: null, look: null, ids: null }], ['187', { compile: null, look: null, ids: null }]]);
  for (const b of broken) {
    const c = CORRUPTIONS[b.corrupt];
    assert.equal(b.failed, true, `${b.corrupt}（${c.what}）：构建应当失败`);
    assert.deepEqual(b.results.map(r => r.revision), ['170', '187']);
    for (const r of b.results) for (const [stage, err] of Object.entries(r.stages)) {
      // 阴影深度材质只在渲阴影时编译：renderer.compile 与单独的 ID 图不碰它，整条后期链（先渲阴影）必须抛
      if (c.shadowOnly && stage !== 'look') { assert.equal(err, null, `${b.corrupt} r${r.revision} ${stage}`); continue; }
      assert.ok(err && err.includes(c.anchor), `${b.corrupt} r${r.revision} 的 ${stage} 路径应当抛错并点名「${c.anchor}」，实际：${err}`);
      assert.match(err, PATCH_MISS);
      assert.match(err, /^s6：/, '报错带材质族的名字');
    }
  }
});

test('FX22-4 构建命令：夹具影片不改时正常出图；改错一段片段原文后，错误不管从哪里冒出来，渲染器都以非零码退出、点名锚点、不留图', async t => {
  if ((await run()).skipped) return t.skip((await run()).skipped);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-fx22-'));
  const still = (name, query, ...more) => {
    const out = path.join(dir, name), r = spawnSync(process.execPath, [path.join(ROOT, 'engine/render/still.mjs'), 'engine/look/fixtures/patch-miss', '--frame', '0', '--size', '320x240', '--out', out, ...(query ? ['--query', query] : []), ...more], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    return { status: r.status, stderr: r.stderr, png: fs.existsSync(path.join(out, 'f000000.png')) };
  };
  try {
    const ok = still('ok', '');
    assert.deepEqual([ok.status, ok.png], [0, true], `夹具影片本身要能出图：${ok.stderr}`);
    const light = /错误\[failure\.shader-error\]：.*着色器补丁没命中（构建失败）：s6：着色器锚点缺失「vec3 outgoingLight = reflectedLight\.directDiffuse/;
    for (const [name, query, want, ...more] of [
      ['load', 'corrupt=toon-light', light],                                        // 置 READY 之前预热时抛
      ['frame', 'corrupt=toon-light&when=frame', light],                            // render(t) 里抛
      ['console', 'corrupt=toon-light&when=console', light],                        // 页面自己接住、只打到控制台
      ['allow', 'corrupt=toon-light&when=console', light, '--allow-gl-errors'],     // --allow-gl-errors 不放行
      ['normal', 'corrupt=toon-beginnormal&when=frame', /错误\[failure\.shader-error\]：.*着色器锚点缺失「#include <beginnormal_vertex>」/],
      ['depth', 'corrupt=depth-begin-vertex&when=frame', /错误\[failure\.shader-error\]：.*着色器锚点缺失「#include <begin_vertex>」/],
      ['pcf', 'corrupt=pcf-kernel&when=frame', /错误\[failure\.shader-error\]：.*软阴影采样锚点缺失/],
    ]) {
      const r = still(name, query, ...more);
      assert.equal(r.status, 1, `${name}（${query}）应当以退出码 1 失败，实际 ${r.status}：${r.stderr.slice(-400)}`);
      assert.match(r.stderr, want, `${name}：报错里要点名缺的锚点`);
      assert.equal(r.png, false, `${name}：不能留下一张没打补丁的图`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
