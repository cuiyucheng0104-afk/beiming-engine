// T7：overlay.cursor、audio.event-mix、audio.align 三张卡的汇总验收：
//   一、卡文件过契约校验和泄露扫描，目录、落点、形状、考题和任务书的表一致，注册表找得到，默认参数过卡内的结构定义；
//   二、29-2 式的用例（原创）：点击吸到配乐起音上，点击之后 2 帧切画面；用观察工具从叠了光标的画面和真值起音上量切点和命中率；
//   三、5-1 式的用例（原创，考题编号不带前导零）：现成配乐对到 30 秒的正片上，拉伸比 1.009，用观察工具的对位复核拉伸比、偏移和重击落点；
//   四、确定性：两个用例各做两遍，声音和事件的摘要相同；
//   五、负向：不吸附的点击过不了命中率门槛，改了切画面的延迟切点就对不上，拉伸比出界必须报错，非首镜头的读数对着全片帧。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { align, telemetry } from '../observe/index.mjs';
import { create as createAlign } from './audio/align/comp.mjs';
import { create as createMix } from './audio/event-mix/comp.mjs';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import { dataValidators } from './sweep-schema.mjs';
import { create as createCursor } from './two-d/overlay-cursor/comp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEIMING = dirname(HERE);
const T7_DIRS = ['two-d/overlay-cursor', 'audio/event-mix', 'audio/align'];
// 任务书的表：目录、类别、挂着的考题；三张都落在合成一侧，形状是 create
const T7_SPEC = {
  'overlay.cursor': ['two-d/overlay-cursor', 'two-d', ['29-2']],
  'audio.event-mix': ['audio/event-mix', 'audio', ['29-2']],
  'audio.align': ['audio/align', 'audio', ['5-1']],
};
const RATE = 48000, FPS = '24/1';
const readCard = (id) => JSON.parse(readFileSync(join(HERE, T7_SPEC[id][0], 'card.json'), 'utf8'));
/** 卡文件的默认参数，再盖上这个用例写的 */
const params = (id, given = {}) => resolveParams(readCard(id), given);
const sha = (...parts) => parts.reduce((h, p) => h.update(typeof p === 'string' ? p : Buffer.from(p.buffer, p.byteOffset, p.byteLength)), createHash('sha256')).digest('hex');
const within = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what}${a} 应在 ${b} ± ${tol}`);
/** 20 毫秒一步的均方根包络，观察工具的对位吃这个 */
const envelope = (x) => Array.from({ length: Math.floor(x.length / 960) }, (_, k) => { let s = 0; for (let i = k * 960; i < (k + 1) * 960; i++) s += x[i] * x[i]; return Math.sqrt(s / 960); });

// ---------- 一、卡文件 ----------

test('T7-1 三张卡文件存在且全部通过 validateCard 与零泄露扫描', () => {
  for (const d of T7_DIRS) {
    const file = join(HERE, d, 'card.json');
    assert.ok(existsSync(file), `缺少卡文件: ${file}`);
    const raw = readFileSync(file, 'utf8');
    assert.deepEqual(scanCardLeaks(raw), []);
    // 泄露扫描扫原文（重复键里夹带的也查得到），结构校验收解析后的对象
    assert.deepEqual(validateCard(JSON.parse(raw)), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, d);
    for (const f of readdirSync(join(HERE, d))) assert.deepEqual(scanCardLeaks(readFileSync(join(HERE, d, f), 'utf8')), [], `${d}/${f}`);
  }
  assert.deepEqual(scanCardLeaks(readFileSync(fileURLToPath(import.meta.url), 'utf8')), [], '这份测试自己');
});

test('T7-2 目录、类别、落点、形状、考题和任务书的表一致；标 reproduced；入口和自测在卡目录里；注册表找得到，默认参数过卡内的结构定义', async () => {
  const cards = Object.keys(T7_SPEC).map(readCard), registry = createCardRegistry(cards, { allowReproduced: true });
  for (const card of cards) {
    const [dir, kind, exams] = T7_SPEC[card.id], [impl] = card.impl;
    assert.deepEqual([card.kind, card.livesIn, card.impl.length, impl.livesIn, impl.shape, card.exams], [kind, ['comp'], 1, 'comp', 'create', exams], card.id);
    assert.deepEqual([impl.entry, impl.selftest], [`cards/${dir}/comp.mjs`, `cards/${dir}/selftest.test.mjs`], card.id);
    assert.ok(existsSync(join(BEIMING, impl.entry)) && existsSync(join(BEIMING, impl.selftest)), `${card.id} 的入口和自测文件在`);
    assert.deepEqual(Object.keys(await import(join(BEIMING, impl.entry))), ['create'], `${card.id} 只有一个卡入口`);
    assert.deepEqual(card.status.map((s) => s.level), ['reproduced'], card.id);
    assert.equal(registry.getCard(card.id)?.id, card.id);
    assert.ok(registry.searchCards({ kind: card.kind, livesIn: 'comp', q: card.title }).some((c) => c.id === card.id), `按标题搜不到 ${card.id}`);
    const resolved = params(card.id);
    assert.deepEqual(Object.keys(resolved), Object.keys(card.params), card.id);
    for (const [name, check] of dataValidators(card)) assert.equal(check(resolved[name]), true, `${card.id} 的 ${name}：${JSON.stringify(check.errors)}`);
  }
});

// ---------- 二、29-2：点击踩起音，点击之后 2 帧切画面 ----------

// 15 秒、24 帧每秒的界面演示：配乐每分钟 123 拍（一拍约 11.7 帧，落不到整数帧上），鼓点轻重不一，垫两个长音；分镜想要的 11 次点击不在拍子上
const S29 = { frames: 360, size: [160, 90], beatFrames: (60 / 123) * 24, wanted: [20, 47, 80, 108, 139, 171, 203, 230, 262, 297, 331] };
const BEATS = Array.from({ length: 30 }, (_, k) => 6 + k * S29.beatFrames).map((t, k) => ({ id: `beat-${k}`, frame: Math.floor(t), sub: t - Math.floor(t), audio: 'kick', gainDb: -2 * (k % 3) }));
const TRUE_ONSETS = BEATS.map((b) => b.frame + b.sub);

/** 整条 29-2 的链：合成配乐 → 找起音、把点击吸上去 → 光标卡排点击和切点 → 点击音效混到配乐上 */
function scene29({ snap = true, cutDelayFrames = 2 } = {}) {
  const mix = createMix({ fps: FPS, seed: 2902 }, params('audio.event-mix')).object;
  const pad = Float32Array.from({ length: S29.frames * 2000 }, (_, i) => 0.04 * Math.sin((2 * Math.PI * 220 * i) / RATE) + 0.03 * Math.sin((2 * Math.PI * 331 * i) / RATE));
  const bed = mix.mix(BEATS, { frames: S29.frames, bed: [pad] }).channels;
  const frames = snap ? mix.snap(S29.wanted, bed) : S29.wanted;
  const clicks = frames.map((frame, i) => ({ id: `click-${String(i).padStart(2, '0')}`, frame, x: 0.2 + 0.06 * i, y: 0.3 + 0.04 * ((i * 7) % 9) }));
  const cursor = createCursor({ size: S29.size }, params('overlay.cursor', { clicks, cutDelayFrames, sizeFrac: 0.03, rippleFrac: 0.12 }));
  const final = mix.mix(cursor.object.events, { frames: S29.frames, bed });
  return { mix, bed, clicks, cursor, final };
}

/** 成片的亮度平面：底色在每个切点上换一次明暗，上面叠光标 */
function lumaPlanes(cursor, cuts) {
  const [w, h] = S29.size;
  return Array.from({ length: S29.frames }, (_, f) => {
    const rgba = new Uint8ClampedArray(w * h * 4).fill(cuts.filter((c) => c <= f).length % 2 ? 150 : 50);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    cursor.object.draw(f, rgba);
    return Uint8Array.from({ length: w * h }, (_, i) => Math.round(0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]));
  });
}
/** 观察工具量：画面上的切点，和每次点击离最近的真值起音差几帧 */
function observe29({ cursor, clicks }, cuts) {
  const seen = telemetry({ width: S29.size[0], height: S29.size[1], frames: lumaPlanes(cursor, cuts), fps: 24, audio: { events: clicks.map((c) => ({ id: c.id, frame: c.frame })), onsets: TRUE_ONSETS } });
  assert.equal(seen.ok, true, JSON.stringify(seen.error));
  assert.equal(seen.audio.onsetOffsets.length, clicks.length, '每次点击都有读数，没被截掉');
  return seen;
}
const TOL = 2;
const hitRate = (seen) => seen.audio.onsetOffsets.filter((o) => Math.abs(o.delta) <= TOL).length / seen.audio.onsetOffsets.length;
/** 随机基线：全片的整数帧里，离某个真值起音不超过 2 帧的占多少 */
const BASELINE = Array.from({ length: S29.frames }, (_, f) => Math.min(...TRUE_ONSETS.map((t) => Math.abs(t - f)))).filter((d) => d <= TOL).length / S29.frames;

test('T7-3 29-2：11 次点击吸到起音上，命中率不低于 80%，比随机基线（约 34%）高出至少 40 个百分点；观察工具从画面上量到的切点正好都在点击之后 2 帧', async (t) => {
  const run = scene29(), { cursor, clicks, final, mix } = run, cuts = cursor.object.pairs.map((p) => p.cutFrame);
  assert.equal(clicks.length, 11);
  // 点击之后 2 帧切：事件对、事件表契约、画面上量到的切点三处都对
  for (const p of cursor.object.pairs) assert.equal(p.cutFrame - p.clickFrame, 2, p.id);
  const judged = (await loadContracts()).validate({ format: 'events/0.1', film: 'f_t7_click', fps: FPS, frames: S29.frames, events: cursor.object.events });
  assert.deepEqual([judged.schemaErrors, judged.violations], [[], {}]);
  const seen = observe29(run, cuts);
  assert.deepEqual(seen.detectedCuts, clicks.map((c) => c.frame + 2));
  const cutCheck = align({ cuts: { reference: clicks.map((c) => c.frame + 2), actual: seen.detectedCuts, maxDeltaFrames: 0 } }).cuts;
  assert.deepEqual([cutCheck.maxAbsDelta, cutCheck.missedCount, cutCheck.extraCount], [0, 0, 0]);

  // 命中率：观察工具量点击离真值起音（合成配乐时定的时刻，不是卡自己找的）差几帧
  within(BASELINE, 0.34, 0.02, '随机基线 ');
  const rate = hitRate(seen);
  assert.ok(rate >= 0.8, `命中率 ${rate}`);
  assert.ok(rate - BASELINE >= 0.4, `命中率 ${rate} 只比基线 ${BASELINE} 高 ${rate - BASELINE}`);
  assert.ok(seen.audio.maxOnsetFrameDelta <= TOL);
  t.diagnostic(`29-2 实测：命中 ${rate * 11}/11，随机基线 ${BASELINE.toFixed(4)}，点击离起音最多 ${seen.audio.maxOnsetFrameDelta} 帧，切点 ${JSON.stringify(seen.detectedCuts)}`);
  // 卡自己在混完的声音上审计，结论一致
  const audit = mix.audit(final.channels, cursor.object.events);
  assert.deepEqual([audit.total, audit.hitRate], [11, rate]);
  within(audit.baseline, BASELINE, 0.02, '卡量的基线 ');

  // 点击音效精确落在点击帧的采样点上（24 帧每秒一帧 2000 个采样点），混完没削波
  assert.deepEqual(final.placements.map((p) => [p.id, p.sample]), clicks.map((c) => [c.id, c.frame * 2000]));
  assert.ok(final.peakDb <= -1 + 1e-9);
  const at = clicks[3].frame * 2000;
  assert.ok(Math.abs(final.channels[0][at] - run.bed[0][at]) > 0.05, '点击帧的采样点上多了点击声');
});

test('T7-4 29-2 的负向：不吸附的点击过不了门槛；切画面的延迟改成 3 帧，画面上的切点就不在点击之后 2 帧', (t) => {
  const loose = scene29({ snap: false }), rate = hitRate(observe29(loose, loose.cursor.object.pairs.map((p) => p.cutFrame)));
  assert.ok(rate < 0.8 && rate - BASELINE < 0.4, `不吸附的命中率 ${rate}，基线 ${BASELINE}`);
  t.diagnostic(`29-2 不吸附对照：命中 ${Math.round(rate * 11)}/11`);
  assert.ok(loose.mix.audit(loose.final.channels, loose.cursor.object.events).hitRate < 0.8);

  const late = scene29({ cutDelayFrames: 3 }), seen = observe29(late, late.cursor.object.pairs.map((p) => p.cutFrame));
  const check = align({ cuts: { reference: late.clicks.map((c) => c.frame + 2), actual: seen.detectedCuts, maxDeltaFrames: 0 } }).cuts;
  assert.equal(check.missedCount, 11);
});

// ---------- 三、5-1：现成配乐对到正片上 ----------

// 30 秒、24 帧每秒的正片，两个硬切在第 96 和第 576 帧；配乐 26 秒，十下不等距的低频重击，首尾两下相隔 20 ÷ 1.009 秒，
// 第一下在 1.52 ÷ 1.009 秒：正好对上要放慢到 1.009 倍、从 2.48 秒切入。另垫 440 赫兹长音和每四分之一秒一下的高频短音
const S05 = { frames: 720, cuts: [96, 576], stretch: 1.009, offsetSec: 2.48 };
const HIT_SECS = [0, 0.11, 0.2, 0.33, 0.41, 0.52, 0.6, 0.74, 0.86, 1].map((u) => (1.52 + u * 20) / S05.stretch);
function track05() {
  const mix = createMix({ fps: FPS, seed: 501 }, params('audio.event-mix', { gainDb: -2 })).object;
  const tick = Float32Array.from({ length: 480 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 6000 * i) / RATE) * Math.exp(-i / 100));
  const bed = Float32Array.from({ length: 26 * RATE }, (_, i) => 0.03 * Math.sin((2 * Math.PI * 440 * i) / RATE));
  const events = [
    ...HIT_SECS.map((t, i) => ({ id: `hit-${i}`, frame: Math.floor(t * 24), sub: t * 24 - Math.floor(t * 24), audio: 'kick' })),
    ...Array.from({ length: 104 }, (_, k) => ({ id: `tick-${k}`, frame: Math.floor((0.07 + k / 4) * 24), sub: ((0.07 + k / 4) * 24) % 1, audio: 'tick', gainDb: 2 })),
  ];
  return mix.mix(events, { frames: 26 * 24, bed: [bed], samples: { tick } }).channels;
}
const anchors05 = (last = S05.cuts[1]) => [{ frame: S05.cuts[0], hit: 0 }, { frame: last, hit: -1 }];
/** 不用卡的找法，另量一遍最后一下低频重击在第几帧：10 毫秒的滑动平均当低通，取平均值的绝对值在片尾 10 秒里最大的位置 */
function lastHitFrame(x) {
  let sum = 0, top = 0, at = 0;
  for (let i = x.length - 10 * RATE; i < x.length; i++) {
    sum += x[i] - x[i - 480];
    if (Math.abs(sum) > top) { top = Math.abs(sum); at = i; }
  }
  return (at / RATE) * 24;
}

test('T7-5 5-1：拉伸比 1.009、落在 [0.97, 1.03] 里，最后一下低频重击离硬切帧不超过 2 帧；观察工具的对位读回的拉伸比、偏移和切点一致，相关不低于 0.5', (t) => {
  const card = createAlign({ fps: FPS }, params('audio.align')).object, src = track05();
  const out = card.align(src, { frames: S05.frames, anchors: anchors05() });
  assert.ok(out.stretch >= 0.97 && out.stretch <= 1.03);
  within(out.stretch, S05.stretch, 0.0005, '卡的拉伸比 ');
  within(out.offsetSec, S05.offsetSec, 0.005, '卡的偏移 ');
  assert.equal(out.splice, null);
  assert.equal(out.channels[0].length, S05.frames * 2000);

  // 重击落点：卡自己量一遍，测试另量一遍
  const landed = card.hits(out.channels).map((t) => t * 24);
  assert.equal(landed.length, HIT_SECS.length);
  within(landed[0], S05.cuts[0], 2, '第一下重击 ');
  within(landed.at(-1), S05.cuts[1], 2, '最后一下重击 ');
  within(lastHitFrame(out.channels[0]), S05.cuts[1], 2, '另量的最后一下重击 ');

  // 观察工具复核：包络互相关读拉伸比和偏移，切点对齐读落点
  const seen = align({
    stretch: { filmEnvelope: envelope(out.channels[0]), trackEnvelope: envelope(src[0]), stepSec: 0.02, fps: 24 },
    cuts: { reference: S05.cuts, actual: [Math.round(landed[0]), Math.round(landed.at(-1))], maxDeltaFrames: 2 },
  });
  assert.equal(seen.ok, true, JSON.stringify(seen.error));
  assert.ok(seen.stretch.reliable && seen.stretch.corr >= 0.5, `相关 ${seen.stretch.corr}`);
  assert.ok(seen.stretch.stretch >= 0.97 && seen.stretch.stretch <= 1.03);
  within(seen.stretch.stretch, out.stretch, 0.001, '观察工具读的拉伸比 ');
  within(seen.stretch.offsetSec, out.offsetSec, 0.021, '观察工具读的偏移 ');
  assert.deepEqual([seen.cuts.missedCount, seen.cuts.extraCount], [0, 0]);
  assert.ok(seen.cuts.maxAbsDelta <= 2);
  t.diagnostic(`5-1 实测：卡的拉伸比 ${out.stretch.toFixed(5)}、偏移 ${out.offsetSec.toFixed(4)} 秒；首尾重击落在第 ${landed[0].toFixed(2)}、${landed.at(-1).toFixed(2)} 帧，另量的最后一下在第 ${lastHitFrame(out.channels[0]).toFixed(2)} 帧；观察工具读回 ${JSON.stringify(seen.stretch)}`);
});

test('T7-6 5-1 的负向：硬切挪到要 5% 拉伸的地方就报错，不悄悄变速；卡文件的范围放不宽；开了 splice 才剪接一次，落点照样不超过 2 帧', () => {
  const src = track05(), refused = { name: 'RangeError', code: 'usage.bad-argument' };
  const card = createAlign({ fps: FPS }, params('audio.align')).object;
  assert.throws(() => card.align(src, { frames: S05.frames, anchors: anchors05(596) }), refused);
  assert.throws(() => card.align(src, { frames: S05.frames, anchors: anchors05(556) }), refused);
  assert.throws(() => card.align(src, { frames: S05.frames, stretch: 1.05 }), refused);
  assert.throws(() => params('audio.align', { stretchMax: 1.05 }), /stretchMax/);
  assert.throws(() => params('audio.align', { stretchMin: 0.9 }), /stretchMin/);
  assert.throws(() => createAlign({ fps: FPS }, { ...params('audio.align'), stretchMax: 1.05 }), refused);

  const spliced = createAlign({ fps: FPS }, params('audio.align', { splice: true })).object, out = spliced.align(src, { frames: S05.frames, anchors: anchors05(496) });
  assert.ok(out.splice && out.stretch >= 0.97 && out.stretch <= 1.03);
  within(out.stretch, 1, 0.002);
  within(spliced.hits(out.channels).at(-1) * 24, 496, 2);
  within(lastHitFrame(out.channels[0]), 496, 2);
});

// ---------- 四、确定性；非首镜头 ----------

test('T7-7 三张卡确定性可重放：两个用例各做两遍，声音、事件和画面读数的摘要相同', () => {
  const digest29 = () => { const r = scene29(); return sha(r.final.channels[0], r.final.channels[1], JSON.stringify([r.cursor.object.events, r.cursor.object.pairs, r.final.placements, [0, 100, 359].map((f) => r.cursor.object.at(f))])); };
  const digest05 = () => { const out = createAlign({ fps: FPS }, params('audio.align', { splice: true })).object.align(track05(), { frames: S05.frames, anchors: anchors05(496) }); return sha(out.channels[0], out.channels[1], JSON.stringify([out.stretch, out.offsetSec, out.splice, out.anchors])); };
  assert.equal(digest29(), digest29());
  assert.equal(digest05(), digest05());
  // 画面：同一帧单独画和顺着画到这一帧，像素相同
  const { cursor } = scene29(), [w, h] = S29.size, alone = new Uint8ClampedArray(w * h * 4), inOrder = new Uint8ClampedArray(w * h * 4);
  for (let f = 0; f <= 140; f++) { inOrder.fill(0); cursor.object.draw(f, inOrder); }
  cursor.object.draw(140, alone);
  assert.equal(sha(alone), sha(inOrder));
});

test('T7-8 非首镜头：meta(f) 的 f 是镜头局部帧号，读数对着全片第 shot.in + f 帧', () => {
  const { clicks } = scene29(), given = { clicks, sizeFrac: 0.03, rippleFrac: 0.12 };
  const whole = createCursor({ size: S29.size }, params('overlay.cursor', given)), shotIn = clicks[4].frame - 3;
  const shot = createCursor({ size: S29.size, shot: { id: 's02', in: shotIn, frames: 60 } }, params('overlay.cursor', given));
  for (const f of [0, 3, 5, 20]) assert.deepEqual(shot.meta(f), whole.meta(shotIn + f));
  assert.equal(shot.meta(3).readings.pressed, 1);
  assert.equal(shot.meta(2).readings.pressed, 0);
  assert.deepEqual(shot.object.events, whole.object.events, '事件条目的帧号是全片帧号，不跟着镜头变');
});
