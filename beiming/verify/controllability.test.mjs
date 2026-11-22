// 可控与可复现两项回归作业的测试：帧对比较、局部性回归、加锁重建回归、看板行，外加页面宿主实渲的端到端核验。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startSource } from '../host/page/host.mjs';
import { shotInput } from '../kernel/eval/input.mjs';
import { applyFilmWrite } from '../kernel/patch-apply.mjs';
import {
  P8_DIFF_LEVEL,
  P8_MAX_DIFF_FRAC,
  P8_PSNR_MIN_DB,
  appendControllabilityRow,
  buildControllabilityRow,
  compareFramePair,
  runLocalityTest,
  runRebuildTest,
} from './controllability.mjs';
import * as verifyIndex from './index.mjs';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const CONTRACTS = join(HERE, '../kernel/contracts');
const FIXTURES = join(HERE, '../kernel/conformance/fixtures');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const assembly = await readJson(join(CONTRACTS, 'film/examples/assembly.json'));
const assemblyLock = await readJson(join(CONTRACTS, 'lock/examples/assembly.json'));
const MARGIN = 'shots/s01/cards/cam/params/margin';
const patchOf = (path, value, rev = 0) => ({ format: 'patch/0.1', rev, ops: [{ op: 'set', path, value }] });

function synthFrame(width, height, fillFn, Type = Float32Array) {
  const color = new Type(width * height * 3);
  for (let i = 0; i < width * height; i++) color.set(fillFn(i % width, Math.floor(i / width)), i * 3);
  return { width, height, channels: 3, color };
}
const flat = (v, Type) => synthFrame(4, 4, () => [v, v, v], Type);

/** 04 §3.5 样例的替身渲染器：s01 的画面只跟 margin 走，s02 的画面只跟 underline 走 */
async function renderAssembly(film) {
  const margin = film.shots.find((s) => s.id === 's01').cards.find((c) => c.as === 'cam').params.margin;
  const underline = film.shots.find((s) => s.id === 's02').params.underline ? 1 : 0;
  return Array.from({ length: film.output.frames }, (_, f) => {
    const v = f < 180 ? margin * ((f + 1) / 180) : 0.25 + 0.1 * underline + (f - 180) / 1200;
    return { frame: f, shot: f < 180 ? 's01' : 's02', ...synthFrame(8, 8, () => [v, v * 0.5, 0.1]) };
  });
}
/** 改完之后（margin 已是 0.82）才动手脚的渲染器：只有 after 那一遍被 tamper 碰到 */
const tampered = (tamper) => async (film) => {
  const out = await renderAssembly(film);
  if (film.shots[0].cards.find((c) => c.as === 'cam').params.margin === 0.82) tamper(out);
  return out;
};

test('V14-1 index.mjs 导出与 P8 阈值常量齐全', () => {
  assert.equal(P8_PSNR_MIN_DB, 50);
  assert.equal(P8_MAX_DIFF_FRAC, 0.001);
  assert.equal(P8_DIFF_LEVEL, 5 / 255);
  for (const name of ['compareFramePair', 'runLocalityTest', 'runRebuildTest', 'buildControllabilityRow', 'appendControllabilityRow', 'P8_PSNR_MIN_DB', 'P8_MAX_DIFF_FRAC', 'P8_DIFF_LEVEL']) {
    assert.ok(name in verifyIndex, `verify/index.mjs 应导出 ${name}`);
  }
});

test('V14-2 帧对比较：哈希档看字节，容差档看 PSNR 与超差像素比例；坏输入一律抛错', () => {
  const same = compareFramePair(synthFrame(40, 25, () => [0.5, 0.5, 0.5]), synthFrame(40, 25, () => [0.5, 0.5, 0.5]));
  assert.deepEqual([same.identical, same.mse, same.psnrDb, same.gt5Pixels, same.fracGt5, same.totalPixels], [true, 0, Infinity, 0, 0, 1000]);
  assert.equal(same.sha256A, same.sha256B);
  assert.match(same.sha256A, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(same));

  // 1000 个像素里 2 个超 5/255（0.2% > 0.1%）：整体 PSNR 远高于 50 dB，只有超差像素比例拦得住；同一个像素两个通道超差只算一个像素
  const a = synthFrame(40, 25, () => [0.5, 0.5, 0.5]), b = synthFrame(40, 25, () => [0.5, 0.5, 0.5]);
  b.color[0] += 6 / 255;
  b.color[1] += 6 / 255;
  b.color[3] += 6 / 255;
  const spike = compareFramePair(a, b);
  assert.ok(spike.psnrDb >= 50, `PSNR 应不低于 50，得到 ${spike.psnrDb}`);
  assert.deepEqual([spike.identical, spike.gt5Pixels, spike.fracGt5], [false, 2, 0.002]);
  assert.ok(Math.abs(spike.maxAbsDiff - 6 / 255) < 1e-6);
  // 超差线可调：线抬到 7/255 就一个都不算
  assert.equal(compareFramePair(a, b, { diffLevel: 7 / 255 }).gt5Pixels, 0);
  // 正好差 5/255 不算超差（严格大于）
  assert.equal(compareFramePair(flat(0, Uint8Array), flat(5, Uint8Array)).gt5Pixels, 0);
  assert.equal(compareFramePair(flat(0, Uint8Array), flat(6, Uint8Array)).fracGt5, 1);

  // 8 位整数按 ÷255 归一：全图差 255 是 MSE 1、PSNR 0 dB
  for (const Type of [Uint8Array, Uint8ClampedArray]) {
    const u8 = compareFramePair(flat(0, Type), flat(255, Type));
    assert.deepEqual([u8.mse, u8.psnrDb, u8.maxAbsDiff], [1, 0, 1]);
  }
  // +0 与 −0：值相等、字节不同。哈希档算不同，容差档算零差
  const zero = compareFramePair(flat(0), flat(-0));
  assert.deepEqual([zero.identical, zero.mse, zero.psnrDb], [false, 0, Infinity]);
  // 普通数组也收；channels 不写时照长度推
  const plain = compareFramePair({ width: 2, height: 1, color: [0, 0.5] }, { width: 2, height: 1, color: [0, 0.5] });
  assert.equal(plain.identical, true);

  const good = flat(0.5);
  const bad = (patch) => ({ ...good, ...patch });
  assert.throws(() => compareFramePair(good, bad({ color: Float32Array.from(good.color, (v, i) => (i === 7 ? NaN : v)) })), RangeError);
  assert.throws(() => compareFramePair(bad({ color: Float32Array.from(good.color, (v, i) => (i === 0 ? Infinity : v)) }), good), RangeError);
  assert.throws(() => compareFramePair(good, synthFrame(2, 8, () => [0.5, 0.5, 0.5])), /尺寸/);
  assert.throws(() => compareFramePair(good, bad({ color: good.color.subarray(3) })), RangeError);
  assert.throws(() => compareFramePair(good, bad({ width: 0 })), RangeError);
  assert.throws(() => compareFramePair(good, bad({ height: 1.5 })), RangeError);
  assert.throws(() => compareFramePair({ width: 2, height: 2, channels: 2, color: new Float32Array(8) }, { width: 2, height: 2, channels: 2, color: new Float32Array(8) }), RangeError);
  assert.throws(() => compareFramePair(good, null), TypeError);
  assert.throws(() => compareFramePair(good, bad({ color: 'x'.repeat(48) })), TypeError);
  // 稀疏数组、非数的元素
  const sparse = Array.from(good.color);
  delete sparse[5];
  assert.throws(() => compareFramePair(bad({ color: Array.from(good.color) }), bad({ color: sparse })), TypeError);
  assert.throws(() => compareFramePair(bad({ color: Array.from(good.color) }), bad({ color: Array.from(good.color, (v, i) => (i ? v : '0.5')) })), TypeError);
  // 两边数组类型不同：字节没法比
  assert.throws(() => compareFramePair(good, flat(0.5, Float64Array)), TypeError);
  assert.throws(() => compareFramePair(good, good, { diffLevel: -1 }), RangeError);
});

test('V14-3 04 §3.5 样例：改 shots/s01/cards/cam/params/margin（0.9 -> 0.82）只变 [0, 180) 帧，[180, 300) 零泄漏', async () => {
  const before = structuredClone(assembly), patch = patchOf(MARGIN, 0.82), seen = [];
  const res = await runLocalityTest({
    film: assembly,
    patch,
    renderFilm: async (film, info) => {
      seen.push([info.phase, film.shots[0].cards[1].params.margin]);
      const out = await renderAssembly(film);
      film.shots.length = 0; // 交过去的是副本：渲染器改它不影响判定，也不影响调用方的片子
      return out;
    },
  });
  assert.deepEqual(seen, [['before', 0.9], ['after', 0.82]]);
  assert.deepEqual(assembly, before, '不改调用方的片子描述');
  assert.deepEqual(patch, patchOf(MARGIN, 0.82), '不改调用方的补丁');
  assert.deepEqual([res.format, res.pass, res.reason, res.filmId, res.tier], ['locality-regression/0.1', true, 'ok', 'f_8k2', 'hash']);
  assert.deepEqual(res.paths, [MARGIN]);
  assert.deepEqual(res.predicted, { shots: ['s01'], frameRanges: [[0, 180]], frameCount: 180 });
  assert.equal(res.totalFrames, 300);
  assert.deepEqual(res.changedFrames, Array.from({ length: 180 }, (_, f) => f));
  assert.deepEqual(res.leakedFrames, []);
  assert.equal(res.unchangedOutsideCount, 120);
  assert.ok(Object.isFrozen(res) && Object.isFrozen(res.predicted.frameRanges[0]));
  assert.doesNotThrow(() => JSON.stringify(res));
});

test('V14-4 局部性的负向防线：串扰、假无变化、镜头标记越界、缺帧、NaN、尺寸篡改、坏补丁全部判红', async () => {
  const patch = patchOf(MARGIN, 0.82);
  const run = (renderFilm, extra = {}) => runLocalityTest({ film: assembly, patch, renderFilm, ...extra });

  // 第 180 帧（s02 首帧）被污染一个分量
  const leaked = await run(tampered((out) => { out[180].color[0] += 0.05; }));
  assert.deepEqual([leaked.pass, leaked.reason, leaked.leakedFrames], [false, 'leaked-outside-affects', [180]]);
  assert.equal(leaked.changedFrames.length, 181);
  assert.equal(leaked.unchangedOutsideCount, 119);
  // 末帧只差一个末位（哈希档）：逐字节判，照样是泄漏；同一份画面在容差档不算显著变化
  const ulp = tampered((out) => { out[299].color[5] = Math.fround(out[299].color[5] + 1e-7); });
  assert.deepEqual((await run(ulp)).leakedFrames, [299]);
  const tolerant = await run(ulp, { tier: 'tolerance' });
  assert.deepEqual([tolerant.pass, tolerant.leakedFrames, tolerant.tier], [true, [], 'tolerance']);
  // 容差档下 s02 出了超线的差，照样是泄漏
  const loud = await run(tampered((out) => { out[200].color.fill(0.9); }), { tier: 'tolerance' });
  assert.deepEqual([loud.pass, loud.leakedFrames], [false, [200]]);
  // 帧号落在预测区间里，帧自己标的镜头却不在预测镜头里
  const mislabeled = await run(tampered((out) => { out[100].shot = 's02'; }));
  assert.deepEqual([mislabeled.pass, mislabeled.leakedFrames], [false, [100]]);

  // 空壳渲染器不理 margin：一帧没变。缺省判红，allowNoOp 才放行
  const constant = async (film) => Array.from({ length: film.output.frames }, (_, f) => ({ frame: f, ...flat(0.2) }));
  const noop = await run(constant);
  assert.deepEqual([noop.pass, noop.reason, noop.changedFrames], [false, 'no-frames-changed', []]);
  assert.deepEqual([(await run(constant, { allowNoOp: true })).pass, (await run(constant, { allowNoOp: true })).reason], [true, 'ok']);

  // 帧不齐、帧号越界、重复、不是数组
  await assert.rejects(() => run(async (film) => (await renderAssembly(film)).slice(0, 299)), /缺第 299 帧/);
  await assert.rejects(() => run(async (film) => [...await renderAssembly(film), { frame: 300, ...flat(0) }]), RangeError);
  await assert.rejects(() => run(async (film) => { const out = await renderAssembly(film); out[5].frame = 4; return out; }), /重复|缺第/);
  await assert.rejects(() => run(async () => null), TypeError);
  // NaN、改完之后尺寸变了
  await assert.rejects(() => run(tampered((out) => { out[7].color[0] = NaN; })), RangeError);
  await assert.rejects(() => run(tampered((out) => { Object.assign(out[7], synthFrame(4, 8, () => [0, 0, 0])); })), /尺寸/);

  // 补丁作用不上、片子描述不过契约、档位不认识
  await assert.rejects(() => runLocalityTest({ film: assembly, patch: patchOf('shots/s09/params/x', 1), renderFilm: renderAssembly }), /补丁/);
  await assert.rejects(() => runLocalityTest({ film: assembly, patch: { ...patch, rev: 'x' }, renderFilm: renderAssembly }), /补丁/);
  await assert.rejects(() => runLocalityTest({ film: { ...assembly, format: 'film/2.0' }, patch, renderFilm: renderAssembly }), /film\/3\.0/);
  await assert.rejects(() => runLocalityTest({ film: { ...assembly, shots: [] }, patch, renderFilm: renderAssembly }), /契约/);
  await assert.rejects(() => run(renderAssembly, { tier: 'loose' }), RangeError);
  await assert.rejects(() => runLocalityTest({ film: assembly, patch }), TypeError);
});

test('V14-5 预测区间跨着没受影响的镜头时，按片子描述的镜头表收紧：夹在中间的镜头变了算泄漏', async () => {
  // 三个镜头，s02 的 colorRef 改成 display：style/view/scene 只影响 s01 和 s03，explainParam 给的区间是 [0, 107) 整段
  const film = await readJson(join(FIXTURES, 'film.json'));
  film.shots[1].colorRef = 'display';
  const render = (touchS02) => async (f) => Array.from({ length: f.output.frames }, (_, n) => {
    const shot = f.shots.find((s) => s.in <= n && n < s.out);
    const v = shot.colorRef === 'scene' || touchS02 ? f.style.view.scene.length / 20 : 0.3;
    return { frame: n, ...flat(v + n / 1000) }; // 帧上不标镜头
  });
  const patch = patchOf('style/view/scene', 'aces');
  const clean = await runLocalityTest({ film, patch, renderFilm: render(false) });
  assert.deepEqual(clean.predicted, { shots: ['s01', 's03'], frameRanges: [[0, 107]], frameCount: 58 });
  assert.deepEqual([clean.pass, clean.changedFrames.length, clean.unchangedOutsideCount], [true, 58, 49]);
  const crossed = await runLocalityTest({ film, patch, renderFilm: render(true) });
  assert.deepEqual([crossed.pass, crossed.reason, crossed.leakedFrames.length, crossed.leakedFrames[0], crossed.leakedFrames.at(-1)], [false, 'leaked-outside-affects', 49, 49, 97]);

  // 一个补丁两处改动：预测取并集。改 s01 的 margin 加 s02 的 underline，300 帧全在预测里
  const both = { format: 'patch/0.1', rev: 0, ops: [{ op: 'set', path: MARGIN, value: 0.82 }, { op: 'set', path: 'shots/s02/params/underline', value: false }] };
  const union = await runLocalityTest({ film: assembly, patch: both, renderFilm: renderAssembly });
  assert.deepEqual(union.predicted, { shots: ['s01', 's02'], frameRanges: [[0, 180], [180, 300]], frameCount: 300 });
  assert.deepEqual([union.pass, union.changedFrames.length, union.paths], [true, 300, [MARGIN, 'shots/s02/params/underline']]);
});

/** 两遍重渲的替身：第二遍的每一帧先过 second(帧, 帧号) */
const twice = (second = () => {}) => async (film, lock, { run }) => Array.from({ length: film.output.frames }, (_, f) => {
  const frame = { frame: f, ...flat(0.5, Float64Array) };
  if (run === 2) second(frame, f);
  return frame;
});
const shift = (db) => (frame) => { frame.color = frame.color.map((v) => v + 10 ** (-db / 20)); };

test('V14-6 加锁重建：哈希档逐帧逐位相同，容差档守住 P8（PSNR >= 50 dB 且超差像素 <= 0.1%）', async () => {
  const film = structuredClone(assembly), lock = structuredClone(assemblyLock), runs = [];
  const ok = await runRebuildTest({
    film,
    lock,
    renderLocked: async (f, l, info) => {
      runs.push([info.run, f.id, l.film]);
      const out = await twice()(f, l, info);
      f.shots.length = 0; // 两遍各拿一份副本，上一遍改了也带不到下一遍
      l.seeds.s01 = 0;
      return out;
    },
  });
  assert.deepEqual(runs, [[1, 'f_8k2', 'f_8k2'], [2, 'f_8k2', 'f_8k2']]);
  assert.deepEqual([film, lock], [assembly, assemblyLock], '不改调用方的片子描述和锁');
  assert.deepEqual(ok, {
    format: 'rebuild-regression/0.1', pass: true, reason: 'ok', filmId: 'f_8k2', rev: 7, tier: 'hash-same-machine',
    totalFrames: 300, identicalFrames: 300, failedFrames: [], mismatchedDeliverables: [], worstPsnrDb: Infinity, worstFracGt5: 0,
  });
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.failedFrames));

  // 哈希档：第 17 帧差一个字节
  const oneByte = twice((frame, f) => { if (f === 17) new Uint8Array(frame.color.buffer)[0] ^= 1; });
  for (const tier of ['hash', 'hash-same-machine']) {
    const r = await runRebuildTest({ film, lock, renderLocked: oneByte, tier });
    assert.deepEqual([r.pass, r.reason, r.failedFrames, r.identicalFrames], [false, 'frames-differ', [17], 299]);
  }
  // 同一份差别在容差档远在线内
  assert.equal((await runRebuildTest({ film, lock, renderLocked: oneByte, tier: 'tolerance' })).pass, true);

  // 容差档：整帧均匀偏移。PSNR 49.5 dB 判红，50.5 dB 判过（哈希档下 50.5 dB 也是红）
  const low = await runRebuildTest({ film, lock, renderLocked: twice(shift(49.5)), tier: 'tolerance' });
  assert.deepEqual([low.pass, low.reason, low.failedFrames.length, low.identicalFrames, low.worstFracGt5], [false, 'outside-tolerance', 300, 0, 0]);
  assert.ok(Math.abs(low.worstPsnrDb - 49.5) < 1e-6, `最差 PSNR 应是 49.5，得到 ${low.worstPsnrDb}`);
  const high = await runRebuildTest({ film, lock, renderLocked: twice(shift(50.5)), tier: 'tolerance' });
  assert.deepEqual([high.pass, high.reason, high.failedFrames], [true, 'ok', []]);
  assert.ok(Math.abs(high.worstPsnrDb - 50.5) < 1e-6);
  assert.equal((await runRebuildTest({ film, lock, renderLocked: twice(shift(50.5)) })).pass, false);
  // 门限可调：线抬到 51 dB，50.5 dB 也不过
  assert.equal((await runRebuildTest({ film, lock, renderLocked: twice(shift(50.5)), tier: 'tolerance', psnrMinDb: 51 })).pass, false);

  // 容差档：PSNR 不低于 50 dB，可 1000 个像素里有 2 个超 5/255（0.2% > 0.1%）
  const big = (run2) => async (f, l, { run }) => Array.from({ length: f.output.frames }, (_, n) => {
    const frame = { frame: n, ...synthFrame(40, 25, () => [0.5, 0.5, 0.5]) };
    if (run === 2 && n === 3) run2(frame.color);
    return frame;
  });
  const speck = await runRebuildTest({ film, lock, renderLocked: big((c) => { c[0] += 6 / 255; c[3] += 6 / 255; }), tier: 'tolerance' });
  assert.deepEqual([speck.pass, speck.reason, speck.failedFrames, speck.worstFracGt5], [false, 'outside-tolerance', [3], 0.002]);
  assert.ok(speck.worstPsnrDb >= 50);
  // 只有 1 个像素超差（0.1%，正好在线上）判过
  assert.equal((await runRebuildTest({ film, lock, renderLocked: big((c) => { c[0] += 6 / 255; }), tier: 'tolerance' })).pass, true);

  // 交付件的哈希表：哈希档逐键一致，多一键、少一键、值不同都判红
  const withFiles = (second) => async (f, l, info) => ({ frames: await twice()(f, l, info), deliverables: info.run === 1 ? { 'master.mp4': 'sha256:aa', 'contact.png': 'sha256:bb' } : second });
  assert.equal((await runRebuildTest({ film, lock, renderLocked: withFiles({ 'contact.png': 'sha256:bb', 'master.mp4': 'sha256:aa' }) })).pass, true);
  const drift = await runRebuildTest({ film, lock, renderLocked: withFiles({ 'master.mp4': 'sha256:ab', 'web.mp4': 'sha256:cc' }) });
  assert.deepEqual([drift.pass, drift.reason, drift.mismatchedDeliverables, drift.identicalFrames], [false, 'deliverable-mismatch', ['contact.png', 'master.mp4', 'web.mp4'], 300]);
  await assert.rejects(() => runRebuildTest({ film, lock, renderLocked: withFiles(null) }), TypeError);
});

test('V14-7 加锁重建的拒收：缺锁、锁格式错、片号或修订号对不上、缺帧、NaN、两遍交回同一块缓冲区', async () => {
  const film = assembly, lock = assemblyLock;
  const run = (over) => runRebuildTest({ film, lock, renderLocked: twice(), ...over });
  await assert.rejects(() => run({ lock: undefined }), /锁/);
  await assert.rejects(() => run({ lock: null }), /锁/);
  await assert.rejects(() => run({ lock: film }), /lock\/1\.0/);
  await assert.rejects(() => run({ lock: { ...lock, seeds: undefined } }), /契约/);
  await assert.rejects(() => run({ lock: { ...lock, film: 'f_other' } }), /f_other/);
  await assert.rejects(() => run({ film: { ...film, format: 'film/2.0' } }), /film\/3\.0/);
  await assert.rejects(() => run({ tier: 'exact' }), RangeError);
  await assert.rejects(() => run({ renderLocked: undefined }), TypeError);

  // 片子描述带着修订号（补丁入口交回的）：和锁的 rev 对不上就拒，对上了才渲
  let calls = 0;
  const counting = async (...args) => { calls++; return twice()(...args); };
  const rev1 = applyFilmWrite(assembly, patchOf(MARGIN, 0.82), { rev: 0 }).film;
  await assert.rejects(() => run({ film: rev1, renderLocked: counting }), /修订号/);
  assert.equal(calls, 0, '拒收发生在渲染之前');
  const rev7 = applyFilmWrite(assembly, patchOf(MARGIN, 0.82, 6), { rev: 6 }).film;
  assert.deepEqual([(await run({ film: rev7, renderLocked: counting })).pass, calls], [true, 2]);

  await assert.rejects(() => run({ renderLocked: async (...a) => (await twice()(...a)).slice(1) }), /缺第 0 帧/);
  await assert.rejects(() => run({ renderLocked: twice((frame, f) => { if (f === 9) frame.color[0] = NaN; }) }), RangeError);
  await assert.rejects(() => run({ renderLocked: twice((frame, f) => { if (f === 9) Object.assign(frame, synthFrame(2, 2, () => [0, 0, 0], Float64Array)); }) }), /尺寸/);
  // 把第一遍的结果缓存下来原样再交一遍，不是独立重渲
  let cached;
  await assert.rejects(() => run({ renderLocked: async (...a) => (cached ??= await twice()(...a)) }), /同一块缓冲区/);
});

test('V14-8 看板的「可控与可复现」行：结构、总判定、追加落盘', async () => {
  const locality = await runLocalityTest({ film: assembly, patch: patchOf(MARGIN, 0.82), renderFilm: renderAssembly });
  const rebuild = await runRebuildTest({ film: assembly, lock: assemblyLock, renderLocked: twice() });
  const at = '2026-11-22T12:00:00.000Z';
  const row = buildControllabilityRow({ filmId: 'f_8k2', recordedAt: at, l2PassRate: 1, locality, rebuild, legacyNightlyPass: true });
  assert.deepEqual(row, {
    format: 'controllability-row/0.1', filmId: 'f_8k2', recordedAt: at, l2PassRate: 1,
    locality: { pass: true, reason: 'ok', tier: 'hash', paths: [MARGIN], totalFrames: 300, predictedFrames: 180, changedFrames: 180, leakedFrames: 0 },
    rebuild: { pass: true, reason: 'ok', tier: 'hash-same-machine', rev: 7, totalFrames: 300, identicalFrames: 300, failedFrames: 0, worstPsnrDb: null, worstFracGt5: 0 },
    legacyNightlyPass: true, overallPass: true,
  });
  assert.ok(Object.isFrozen(row) && Object.isFrozen(row.locality) && Object.isFrozen(row.locality.paths));
  assert.deepEqual(JSON.parse(JSON.stringify(row)), row, '写成 JSON 再读回来是同一份');

  // 总判定：给了的检查项全过才过；只给一项也行；一项都没给不出行
  const only = buildControllabilityRow({ filmId: 'f_8k2', recordedAt: at, locality });
  assert.deepEqual([only.overallPass, only.rebuild, only.l2PassRate, only.legacyNightlyPass], [true, null, null, null]);
  const redLocality = await runLocalityTest({ film: assembly, patch: patchOf(MARGIN, 0.82), renderFilm: tampered((out) => { out[180].color[0] += 0.05; }) });
  const redRebuild = await runRebuildTest({ film: assembly, lock: assemblyLock, renderLocked: twice(shift(49.5)), tier: 'tolerance' });
  const worst = buildControllabilityRow({ filmId: 'f_8k2', recordedAt: at, locality: redLocality, rebuild: redRebuild });
  assert.deepEqual([worst.overallPass, worst.locality.leakedFrames, worst.rebuild.failedFrames], [false, 1, 300]);
  assert.ok(Math.abs(worst.rebuild.worstPsnrDb - 49.5) < 1e-6);
  for (const over of [{ rebuild: redRebuild }, { locality: redLocality }, { l2PassRate: 0.99 }, { legacyNightlyPass: false }]) {
    assert.equal(buildControllabilityRow({ filmId: 'f_8k2', recordedAt: at, locality, rebuild, ...over }).overallPass, false, JSON.stringify(Object.keys(over)));
  }
  const refuse = (over, why) => assert.throws(() => buildControllabilityRow({ filmId: 'f_8k2', recordedAt: at, locality, rebuild, ...over }), why);
  refuse({ locality: null, rebuild: null }, /至少/);
  refuse({ filmId: '' }, TypeError);
  refuse({ filmId: 'f_other' }, /f_other/);
  refuse({ recordedAt: 'yesterday' }, RangeError);
  refuse({ recordedAt: undefined }, RangeError);
  refuse({ l2PassRate: 1.2 }, RangeError);
  refuse({ l2PassRate: '1' }, RangeError);
  refuse({ legacyNightlyPass: 'yes' }, TypeError);
  refuse({ locality: { ...locality, format: 'x' } }, TypeError);
  refuse({ rebuild: { pass: true } }, TypeError);
  // 报告自相矛盾：写着通过，却带着泄漏帧或没过的帧
  refuse({ locality: { ...redLocality, pass: true } }, /矛盾/);
  refuse({ rebuild: { ...redRebuild, pass: true } }, /矛盾/);
  refuse({ locality: { ...locality, changedFrames: [] } }, /矛盾/);

  const dir = await mkdtemp(join(tmpdir(), 'beiming-v14-row-'));
  try {
    const file = join(dir, 'board', 'controllability.jsonl');
    assert.equal(await appendControllabilityRow(file, row), row);
    await appendControllabilityRow(file, worst);
    const lines = (await readFile(file, 'utf8')).split('\n');
    assert.deepEqual([lines.length, lines[2]], [3, '']);
    assert.deepEqual([JSON.parse(lines[0]), JSON.parse(lines[1])], [row, JSON.parse(JSON.stringify(worst))]);
    // 只收 buildControllabilityRow 交回的行：手拼的、读回来改过的都不收
    await assert.rejects(() => appendControllabilityRow(file, { ...row }), TypeError);
    await assert.rejects(() => appendControllabilityRow(file, { ...row, overallPass: true, locality: null }), TypeError);
    assert.equal((await readFile(file, 'utf8')).split('\n').length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- 页面宿主实渲 ----------

/** 只有二进制确实不在（没装、路径不存在）才跳过；别的错（起来之后的运行时错在内）照常抛，算失败 */
async function startOrSkip(t, start = startSource) {
  try {
    return await start();
  } catch (err) {
    if (err?.code !== 'ENOENT' && !/executable doesn't exist|ENOENT/i.test(String(err?.message))) throw err;
    t.skip('本机没有无头浏览器（二进制不存在），跳过实渲');
    return null;
  }
}

/** 一致性测试的校准片裁成两个镜头、每个 3 帧、160 × 90：两个镜头都是「匀速方块」，s02 不设背景。锁里跟着去掉 s03 */
async function calibPair() {
  const film = await readJson(join(FIXTURES, 'film.json')), lock = await readJson(join(FIXTURES, 'lock.json'));
  film.output = { ...film.output, size: [160, 90], frames: 6 };
  film.shots = film.shots.slice(0, 2);
  Object.assign(film.shots[0], { in: 0, out: 3 });
  Object.assign(film.shots[1], { in: 3, out: 6 });
  film.events = [{ id: 'mark1', frame: 1, shot: 's01' }, { id: 'mark2', frame: 4, shot: 's02' }];
  delete lock.seeds.s03;
  delete lock.shots.s03;
  return { film, lock };
}

/** 经帧源接口把全片逐镜头逐帧渲出来：每个镜头一个新会话，颜色层从层文件读回 32 位浮点 */
async function renderOnPage(source, film, lock) {
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-v14-'));
  try {
    const frames = [];
    for (const shot of film.shots) {
      const session = await source.open(shotInput(film, shot.id), { lock, tier: 'final', workspace: join(workspace, shot.id), filmDir: FIXTURES });
      try {
        for (let f = shot.in; f < shot.out; f++) {
          const { color } = (await session.render(f - shot.in, {}, ['color'])).layers;
          const bytes = await readFile(join(workspace, shot.id, color.file));
          frames.push({ frame: f, shot: shot.id, width: color.shape[1], height: color.shape[0], channels: color.shape[2], color: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)) });
        }
      } finally {
        await session.close();
      }
    }
    return frames;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('V14-9 页面宿主实渲：双镜头局部性（改谁只变谁）与加锁重渲（两个帧源进程逐位相同）', async (t) => {
  const source = await startOrSkip(t);
  if (!source) return;
  const { film, lock } = await calibPair();
  try {
    // 改 s01 的快门角只变 [0, 3)；改 s02 的背景只变 [3, 6)。另一个镜头一帧都不许变
    for (const [path, value, shot, range] of [['shots/s01/shutter/angleDeg', 90, 's01', [0, 3]], ['shots/s02/params/background', true, 's02', [3, 6]]]) {
      const res = await runLocalityTest({ film, patch: patchOf(path, value), renderFilm: (f) => renderOnPage(source, f, null) });
      assert.deepEqual(res.predicted, { shots: [shot], frameRanges: [range], frameCount: 3 }, path);
      assert.deepEqual([res.pass, res.reason, res.changedFrames, res.leakedFrames, res.unchangedOutsideCount], [true, 'ok', [range[0], range[0] + 1, range[0] + 2], [], 3], path);
    }
    // 负对照：改完之后连 s02 的背景也跟着变（串扰），实渲出来的 [3, 6) 全是泄漏
    const crossed = await runLocalityTest({
      film,
      patch: patchOf('shots/s01/shutter/angleDeg', 90),
      renderFilm: (f, { phase }) => {
        if (phase === 'after') f.shots[1].params.background = true;
        return renderOnPage(source, f, null);
      },
    });
    assert.deepEqual([crossed.pass, crossed.reason, crossed.leakedFrames], [false, 'leaked-outside-affects', [3, 4, 5]]);
  } finally {
    await source.stop();
  }

  // 加锁重渲：每一遍起一个新的帧源进程（新的浏览器），带同一份锁
  const fresh = (perturb = () => {}) => async (f, l, info) => {
    const src = await startSource();
    try {
      perturb(f, info);
      return await renderOnPage(src, f, l);
    } finally {
      await src.stop();
    }
  };
  const rebuilt = await runRebuildTest({ film, lock, renderLocked: fresh() });
  assert.deepEqual(
    [rebuilt.pass, rebuilt.reason, rebuilt.tier, rebuilt.totalFrames, rebuilt.identicalFrames, rebuilt.failedFrames, rebuilt.worstPsnrDb],
    [true, 'ok', 'hash-same-machine', 6, 6, [], Infinity],
  );
  // 负对照：第二遍的 s01 快门角被动过，实渲出来的 [0, 3) 对不上
  const drifted = await runRebuildTest({ film, lock, renderLocked: fresh((f, { run }) => { if (run === 2) f.shots[0].shutter.angleDeg = 90; }) });
  assert.deepEqual([drifted.pass, drifted.reason, drifted.failedFrames, drifted.identicalFrames], [false, 'frames-differ', [0, 1, 2], 3]);

  const row = buildControllabilityRow({ filmId: film.id, recordedAt: new Date().toISOString(), rebuild: rebuilt });
  assert.deepEqual([row.overallPass, row.rebuild.rev, row.rebuild.worstPsnrDb], [true, null, null]);
});

test('V14-10 帧源起不来：二进制不存在才跳过，别的错照常失败；BEIMING_CHROME 指到不存在的路径时实渲用例优雅跳过', async () => {
  const skipped = [], t = { skip: (why) => skipped.push(why) };
  const fails = (make) => async () => { throw make(); };
  assert.equal(await startOrSkip(t, async () => 'source'), 'source');
  assert.equal(await startOrSkip(t, fails(() => Object.assign(new Error('spawn chrome ENOENT'), { code: 'ENOENT' }))), null);
  assert.equal(await startOrSkip(t, fails(() => new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell"))), null);
  assert.equal(await startOrSkip(t, fails(() => new Error("browserType.launch: Failed to launch chromium because executable doesn't exist at /nonexistent/chrome"))), null);
  assert.equal(skipped.length, 3);
  await assert.rejects(() => startOrSkip(t, fails(() => new Error('页面运行时没装起来：超时'))), /没装起来/);
  await assert.rejects(() => startOrSkip(t, fails(() => new TypeError('boom'))), TypeError);
  assert.equal(skipped.length, 3);

  // 真起一个子进程只跑 V14-9：浏览器路径不存在，应当跳过 1 条、失败 0 条、退出码 0
  // 去掉测试运行器给子进程设的 NODE_TEST_CONTEXT：带着它，里面这层 node --test 一条用例都不跑就退出 0
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^V14-9 ', SELF], {
    encoding: 'utf8', env: { ...env, BEIMING_CHROME: join(tmpdir(), 'beiming-v14-no-such-chrome') }, timeout: 120000,
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /^# skipped 1$/m);
  assert.match(child.stdout, /^# fail 0$/m);
  assert.match(child.stdout, /^# pass 0$/m);
});
