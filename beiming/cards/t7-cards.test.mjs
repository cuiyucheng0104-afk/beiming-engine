// T7：overlay.cursor、audio.event-mix、audio.align 三张卡的汇总验收：
//   一、卡文件过契约校验和泄露扫描，目录、落点、形状、考题和任务书的表一致，注册表找得到，默认参数过卡内的结构定义；
//   二、29-2 式的用例（原创）：点击吸到配乐起音上，点击之后 2 帧切画面；用观察工具从叠了光标的画面和真值起音上量切点和命中率；
//   三、5-1 式的用例（原创，考题编号不带前导零）：现成配乐对到 30 秒的正片上，拉伸比 1.009，用观察工具的对位复核拉伸比、偏移和重击落点；
//   四、确定性：两个用例各做两遍，声音和事件的摘要相同；
//   五、负向：不吸附的点击过不了命中率门槛，改了切画面的延迟切点就对不上，拉伸比出界必须报错；
//   六、一审的反例：点击表写镜头局部帧号、事件交全片帧号，分数帧率的采样点和合成收尾逐点一致，写法不对的参数和数据一律报 usage.bad-argument，左右反相的立体声不漏检。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eventSample, filmSamples } from '../comp/audio.mjs';
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

test('T7-2 目录、类别、落点、形状、考题和任务书的表一致；标 reproduced 或 measured；入口和自测在卡目录里；注册表找得到，默认参数过卡内的结构定义', async () => {
  const cards = Object.keys(T7_SPEC).map(readCard), registry = createCardRegistry(cards, { allowReproduced: true });
  for (const card of cards) {
    const [dir, kind, exams] = T7_SPEC[card.id], [impl] = card.impl;
    assert.deepEqual([card.kind, card.livesIn, card.impl.length, impl.livesIn, impl.shape, card.exams], [kind, ['comp'], 1, 'comp', 'create', exams], card.id);
    assert.deepEqual([impl.entry, impl.selftest], [`cards/${dir}/comp.mjs`, `cards/${dir}/selftest.test.mjs`], card.id);
    assert.ok(existsSync(join(BEIMING, impl.entry)) && existsSync(join(BEIMING, impl.selftest)), `${card.id} 的入口和自测文件在`);
    assert.deepEqual(Object.keys(await import(pathToFileURL(join(BEIMING, impl.entry)).href)), ['create'], `${card.id} 只有一个卡入口`);
    assert.equal(card.status.length, 1, card.id);
    assert.ok(['reproduced', 'measured'].includes(card.status[0].level), card.id);
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

test('T7-8 双镜头：点击表写镜头局部帧号，两个镜头交出的全片事件拼起来和整片一条镜头的一样；at、draw、meta 收局部帧号', async () => {
  const { clicks, cursor: whole } = scene29(), look = { sizeFrac: 0.03, rippleFrac: 0.12 };
  // 在第 5 次点击之前 3 帧切成两个镜头，各自的点击表减去自己的起始帧
  const shotIn = clicks[4].frame - 3, shots = [{ id: 's01', in: 0, frames: shotIn }, { id: 's02', in: shotIn, frames: S29.frames - shotIn }];
  const local = (shot) => clicks.filter((c) => c.frame >= shot.in && c.frame < shot.in + shot.frames).map((c) => ({ ...c, frame: c.frame - shot.in }));
  const [first, second] = shots.map((shot) => createCursor({ size: S29.size, shot }, params('overlay.cursor', { ...look, clicks: local(shot) })));
  assert.deepEqual([local(shots[0]).length, local(shots[1]).length, local(shots[1])[0].frame], [4, 7, 3]);
  assert.deepEqual([...first.object.events, ...second.object.events], whole.object.events);
  assert.deepEqual([...first.object.pairs, ...second.object.pairs], whole.object.pairs);
  const judged = (await loadContracts()).validate({ format: 'events/0.1', film: 'f_t7_shots', fps: FPS, frames: S29.frames, events: [...first.object.events, ...second.object.events] });
  assert.deepEqual([judged.schemaErrors, judged.violations], [[], {}]);

  // 第二个镜头的局部第 3 帧就是那次点击：读数、摆法和整片那条镜头在全片第 shotIn + 3 帧上的一样
  assert.deepEqual([2, 3].map((f) => second.meta(f).readings.pressed), [0, 1]);
  const here = second.object.at(3), there = whole.object.at(shotIn + 3);
  within(here.x, there.x, 1e-9);
  within(here.y, there.y, 1e-9);
  assert.deepEqual([here.pressed, here.scale, here.ripple], [there.pressed, there.scale, there.ripple]);
  const [w, h] = S29.size, rgba = new Uint8ClampedArray(w * h * 4), box = second.object.draw(3, rgba);
  assert.ok(rgba.some((v) => v > 0) && Math.abs((box[0] + box[2]) / 2 - there.x) < 1e-9, '按局部帧号画出来的光标在点击的位置上');

  // 一审的反例：镜头从第 120 帧起，局部第 6 帧点击、2 帧后切，交出去的是全片第 126、128 帧
  const r1 = createCursor({ size: S29.size, shot: { id: 's02', in: 120, frames: 48 } }, params('overlay.cursor', { clicks: [{ id: 'tap', frame: 6, x: 0.5, y: 0.5 }] }));
  assert.deepEqual(r1.object.events.map((e) => [e.id, e.frame]), [['tap', 126], ['cut.128', 128]]);
  assert.deepEqual([r1.meta(5).readings.pressed, r1.meta(6).readings.pressed], [0, 1]);
  // 照全片帧号写的点击表在非首镜头里落到镜头外：拒掉，不悄悄把点击声和切点写到别处
  assert.throws(() => createCursor({ size: S29.size, shot: shots[1] }, params('overlay.cursor', { ...look, clicks: clicks.slice(4) })), { code: 'usage.bad-argument' });
});

// ---------- 六、一审的反例 ----------

test('T7-9 分数帧率：混音的落点和全片长度逐点等于合成收尾的 eventSample、filmSamples，正好半个采样点的时刻不提前', () => {
  const pulse = Float32Array.of(1), subs = [0, 0.125, 0.3125, 0.5, 0.6875, 0.999];
  for (const fps of ['24/1', '25/1', '30000/1001', '24000/1001', '60000/1001']) {
    const events = Array.from({ length: 240 }, (_, frame) => subs.map((sub, k) => ({ id: `p-${frame}-${k}`, frame, sub, audio: 'pulse' }))).flat();
    const out = createMix({ fps, seed: 0 }, params('audio.event-mix', { fadeMs: 0 })).object.mix(events, { frames: 240, samples: { pulse } });
    assert.equal(out.channels[0].length, filmSamples(240, fps), fps);
    const off = out.placements.filter((p) => p.sample !== eventSample(p.frame, p.sub, fps));
    assert.deepEqual(off, [], `${fps}：${off.length} 个落点和 eventSample 不一样`);
  }
  const [at] = createMix({ fps: '30000/1001' }, params('audio.event-mix')).object.mix([{ id: 'tap', frame: 20, sub: 0.3125, audio: 'pulse' }], { frames: 60, samples: { pulse } }).placements;
  assert.deepEqual([at.sample, eventSample(20, 0.3125, '30000/1001')], [32533, 32533]);
});

test('T7-10 写法不对的参数和数据：照卡文件解析参数再建卡，三张卡都报 usage.bad-argument，不交出事件、静音或带 NaN 的声音', () => {
  const refused = (fn, what) => assert.throws(fn, { name: 'RangeError', code: 'usage.bad-argument' }, what);
  // overlay.cursor：点击表的结构定义和 create 的入口两处口径一致
  const [[, clicksOk]] = dataValidators(readCard('overlay.cursor')), tap = { id: 'tap', frame: 6, x: 0.5, y: 0.5 };
  const cursorWith = (clicks) => () => createCursor({ size: [256, 144] }, params('overlay.cursor', { clicks }));
  assert.equal(cursorWith([tap])().object.events.length, 2);
  for (const [what, clicks] of Object.entries({ 空点击表: [], 'x 出了画面': [{ ...tap, x: 1.25 }], '缺 y': [{ id: 'tap', frame: 6, x: 0.5 }], 'id 写法不对': [{ ...tap, id: 'Tap' }], 负帧号: [{ ...tap, frame: -1 }] })) {
    assert.equal(clicksOk(clicks), false, `结构定义该拒：${what}`);
    refused(cursorWith(clicks), what);
  }
  refused(cursorWith([{ ...tap, y: NaN }]), 'y 是 NaN');

  // audio.event-mix：负帧号、空样本、带 NaN 的样本、不是 48000 的采样率
  const mix = createMix({ fps: FPS, seed: 1 }, params('audio.event-mix')).object, ev = { id: 'x', frame: 1, audio: 'probe' }, probe = new Float32Array(48).fill(0.5);
  assert.equal(mix.mix([ev], { frames: 12, samples: { probe }, sampleRate: 48000 }).placements.length, 1);
  refused(() => mix.mix([{ ...ev, frame: -1 }], { frames: 12, samples: { probe } }), '负帧号');
  refused(() => mix.mix([{ ...ev, frame: Infinity }], { frames: 12, samples: { probe } }), '帧号无穷');
  refused(() => mix.mix([{ ...ev, sub: NaN }], { frames: 12, samples: { probe } }), '子帧相位 NaN');
  refused(() => mix.mix([ev], { frames: 12, samples: { probe: new Float32Array(0) } }), '空样本');
  refused(() => mix.mix([ev], { frames: 12, samples: { probe: Float32Array.of(0.5, NaN) } }), '样本带 NaN');
  refused(() => mix.mix([ev], { frames: 12, samples: { probe: Float32Array.of(Infinity) } }), '样本带无穷');
  for (const sampleRate of [44100, 0, -1]) refused(() => mix.mix([ev], { frames: 12, samples: { probe }, sampleRate }), `采样率 ${sampleRate}`);
  refused(() => createMix({ fps: FPS, sampleRate: 44100 }, params('audio.event-mix')), 'ctx 的采样率');
  // 二审的反例：字符串的子帧相位不再拼成 "10.5" 晚 18000 个采样点；mix、snap、audit 对同一条事件口径一致
  assert.equal(mix.mix([{ ...ev, sub: 0.5 }], { frames: 24, samples: { probe } }).placements[0].sample, 3000);
  const { bed: bed29 } = scene29(), kicked = mix.mix([{ id: 'k', frame: 0, audio: 'kick' }], { frames: 24 }).channels;
  for (const sub of ['0.5', null, true]) {
    refused(() => mix.mix([{ ...ev, sub }], { frames: 24, samples: { probe } }), `mix 的子帧相位 ${JSON.stringify(sub)}`);
    refused(() => mix.audit(bed29, [{ ...ev, frame: 20, sub }]), `audit 的子帧相位 ${JSON.stringify(sub)}`);
  }
  // 第 0 帧就有起音：片头之前的第 -1 帧离它只差 1 帧，以前被 audit 算成命中
  assert.equal(mix.audit(kicked, [{ ...ev, frame: 0 }]).hitRate, 1);
  for (const frame of [-1, 24, 1.5, '1']) {
    refused(() => mix.mix([{ ...ev, frame }], { frames: 24, samples: { probe } }), `mix 的帧号 ${frame}`);
    refused(() => mix.audit(kicked, [{ ...ev, frame, sub: 0 }]), `audit 的帧号 ${frame}`);
    refused(() => mix.snap([frame], kicked), `snap 的帧号 ${frame}`);
  }
  refused(() => mix.audit(bed29, [null]), 'audit 的条目不是对象');
  refused(() => mix.audit(bed29, { frames: S29.frames }), 'audit 的事件表没有 events');
  // 三审的反例一：同一段 24 帧的配乐、同一个第 12 帧的事件，事件表写全片 12 帧时 mix 和 audit 一起拒，不再只有 audit 算成满分
  const at12 = [{ ...ev, frame: 12 }], long = mix.mix([{ id: 'k', frame: 12, audio: 'kick' }], { frames: 24 }).channels;
  assert.equal(mix.mix({ frames: 24, events: at12 }, { samples: { probe } }).placements[0].sample, 24000);
  assert.equal(mix.audit(long, { frames: 24, events: at12 }).hitRate, 1);
  refused(() => mix.mix({ frames: 12, events: at12 }, { samples: { probe } }), 'mix：事件表全片 12 帧，第 12 帧在片外');
  refused(() => mix.audit(long, { frames: 12, events: at12 }), 'audit：事件表全片 12 帧，第 12 帧在片外');
  refused(() => mix.audit(long, at12, { frames: 12 }), 'audit：选项全片 12 帧，第 12 帧在片外');
  // 反例二：起音在第 47760 个采样点（第 23.88 帧）时 snap 交回第 23 帧，不是片外的第 24 帧；交回的帧号 mix、audit 都收
  const tail = [new Float32Array(RATE).fill(1, 47760)], snapped = mix.snap([23], tail);
  assert.deepEqual(snapped, [23]);
  assert.equal(mix.mix([{ ...ev, frame: snapped[0] }], { frames: 24, samples: { probe } }).placements.length, 1);
  assert.equal(mix.audit(tail, [{ ...ev, frame: snapped[0] }]).hitRate, 1);
  // 反例三：右声道是空洞的声道数组，混音卡的三个入口和对位卡都拒，不悄悄丢掉一轨、不抛没有 code 的 TypeError
  const holed = [long[0]];
  holed.length = 2;
  refused(() => mix.mix(at12, { frames: 24, samples: { probe }, bed: holed }), 'mix 的配乐右声道是空洞');
  refused(() => mix.snap([12], holed), 'snap 的声道有空洞');
  refused(() => mix.audit(holed, at12), 'audit 的声道有空洞');
  refused(() => createAlign({ fps: FPS }, params('audio.align')).object.align(holed, { frames: 24 }), 'align 的声道有空洞');
  refused(() => createAlign({ fps: FPS }, params('audio.align')).object.hits(holed), 'hits 的声道有空洞');
  // 反例四：选项里的 windowFrames、toleranceFrames 写了就得合法，三个入口都查；选项本身要是对象
  for (const opts of [{ windowFrames: -1 }, { windowFrames: NaN }, { windowFrames: '2' }, { toleranceFrames: -1 }, { toleranceFrames: Infinity }, null, 'x']) {
    refused(() => mix.mix(at12, opts === null || typeof opts !== 'object' ? opts : { frames: 24, samples: { probe }, ...opts }), `mix 的选项 ${JSON.stringify(opts)}`);
    refused(() => mix.snap([12], long, opts), `snap 的选项 ${JSON.stringify(opts)}`);
    refused(() => mix.audit(long, at12, opts), `audit 的选项 ${JSON.stringify(opts)}`);
  }
  assert.deepEqual(mix.snap([12, 0], long, { windowFrames: 2 }), [12, 0]);
  // 四审的反例一：windowFrames 写了就得是正的有限数，0 也不收；混音卡的 audit、snap、mix 和对位卡的 align、hits 一个口径
  const aligner = createAlign({ fps: FPS }, params('audio.align')).object;
  for (const windowFrames of [-1, 0, NaN, '2', null]) {
    refused(() => mix.audit(long, at12, { windowFrames }), `audit 的 windowFrames ${windowFrames}`);
    refused(() => mix.snap([12], long, { windowFrames }), `snap 的 windowFrames ${windowFrames}`);
    refused(() => mix.mix(at12, { frames: 24, samples: { probe }, windowFrames }), `mix 的 windowFrames ${windowFrames}`);
    refused(() => aligner.align(long, { frames: 24, windowFrames }), `align 的 windowFrames ${windowFrames}`);
    refused(() => aligner.hits(long, { windowFrames }), `hits 的 windowFrames ${windowFrames}`);
  }
  assert.deepEqual(mix.snap([12, 0], long, { windowFrames: 0.01 }), [12, 0]);
  assert.equal(mix.audit(long, at12, { windowFrames: 0.01 }).hitRate, 1);
  assert.equal(aligner.align(long, { frames: 24, windowFrames: 0.01 }).stretch, 1);
  // 四审的反例二：正片 24 帧、声音 60 帧，第 12 帧一下 0.2 的脉冲；片尾之后第 30 帧的采样从 0 改成 1，片内第 12 帧的审计和吸附不变
  const quiet = new Float32Array(60 * 2000), loud = new Float32Array(60 * 2000);
  quiet[24000] = loud[24000] = 0.2;
  loud[60000] = 1;
  for (const [name, pcm] of [['片尾之后是 0', quiet], ['片尾之后是 1', loud]]) {
    const seen = mix.audit([pcm], { frames: 24, events: at12 });
    assert.deepEqual([seen.hits, seen.hitRate, seen.rows[0].delta], [1, 1, 0], name);
    assert.deepEqual(mix.snap([12], [pcm], { frames: 24 }), [12], name);
  }
  // 五审的反例：正片 25 帧是 50000 个采样点，不是 5 毫秒一步（240 个）的整数倍，最后一步只有 80 个采样点（49920 起）。成对锁住：49920 在片内要命中，50000 是片外第一个采样点要排除
  const at24 = [{ ...ev, frame: 24 }], film25 = { frames: 25 }, pulses = (...at) => {
    const pcm = new Float32Array(60 * 2000);
    for (const [sample, level] of at) pcm[sample] = level;
    return [pcm];
  };
  const inside = mix.audit(pulses([49920, 0.2]), at24, film25);
  assert.equal(inside.hits, 1, '第 49920 个采样点的脉冲在片内最后一步里');
  within(inside.rows[0].delta, 0.96, 1e-9, '第 49920 个采样点的脉冲离第 24 帧 ');
  assert.deepEqual(mix.snap([24], pulses([49920, 0.2]), film25), [24]);
  // 不靠人造脉冲：自带的点击混在第 24 帧、子帧相位 0.96，落点就是 49920，混出来的声音原样交回审计和吸附
  const last = [{ id: 'c', frame: 24, sub: 0.96, audio: 'click' }], mixed = mix.mix(last, film25);
  assert.deepEqual([mixed.placements[0].sample, mixed.channels[0].length], [49920, 50000]);
  assert.deepEqual([mix.audit(mixed.channels, last, film25).hits, mix.snap([24], mixed.channels, film25)], [1, [24]]);
  const outside = mix.audit(pulses([50000, 0.2]), at24, film25);
  assert.deepEqual([outside.hits, outside.rows[0].delta], [0, Infinity], '第 50000 个采样点已经在片外');
  refused(() => mix.snap([24], pulses([50000, 0.2]), film25), '片内没有起音，片外第一个采样点的脉冲不算');
  // 片外第一个采样点再响，也不压掉片内第 12 帧那一下轻的
  const both = mix.audit(pulses([24000, 0.2], [50000, 1]), [...at12, ...at24], film25);
  assert.deepEqual([both.hits, both.rows.map((r) => r.delta)], [1, [0, -12]]);
  assert.deepEqual(mix.snap([12, 24], pulses([24000, 0.2], [50000, 1]), film25), [12, 12]);
  // 六审的反例之一：垫着 0.1 的 600 赫兹底音时，第 49920 个采样点那一下 0.8 的点击照样要找到。最后一步只有 80 个采样点，能量加起来比前一整步的底音还少，不能因此当成没涨
  const bedded = pulses([49920, 0.8]);
  for (let i = 0; i < bedded[0].length; i++) bedded[0][i] += 0.1 * Math.sin((2 * Math.PI * 600 * i) / RATE);
  for (const [frames, to] of [[26, 25], [25, 24]]) {
    assert.deepEqual(mix.onsets(bedded.map((c) => c.subarray(0, frames * 2000))), [0, 49920], `正片 ${frames} 帧`);
    assert.deepEqual([mix.audit(bedded, last, { frames }).hits, mix.snap([23], bedded, { frames })], [1, [to]], `正片 ${frames} 帧`);
  }
  // 六审的反例之二：混进去的落点和量出来的起音是同一个采样点，一帧不差（toleranceFrames 是 0）也要算命中，差值正好是 0
  const exact = mix.audit(mixed.channels, last, { ...film25, toleranceFrames: 0 });
  assert.deepEqual([mix.onsets(mixed.channels), exact.hits, exact.rows[0].delta], [[49920], 1, 0]);
  // 七审的反例之一：同一段底音加点击，起音门槛从 0.1 调到 0.6。片尾那 80 个采样点和整步照每个采样点的平均能量比涨幅：片头涨 0.005，片尾涨 0.008，是全片最大的，照样留下
  const strict = createMix({ fps: FPS, seed: 1 }, params('audio.event-mix', { onsetFloor: 0.6 })).object;
  assert.deepEqual(strict.onsets(bedded.map((c) => c.subarray(0, 50000))), [0, 49920], 'onsetFloor 0.6');
  assert.deepEqual([strict.audit(bedded, last, film25).hits, strict.snap([23], bedded, film25)], [1, [24]], 'onsetFloor 0.6');
  // 七审的反例之二：默认门槛，第 24000 到 24240 个采样点那一步的底音响到 0.26，片尾的点击还在门槛上面
  const bumped = [Float32Array.from(bedded[0], (v, i) => (i >= 24000 && i < 24240 ? 0.26 * Math.sin((2 * Math.PI * 600 * i) / RATE) : v))];
  assert.deepEqual(mix.onsets(bumped.map((c) => c.subarray(0, 50000))), [0, 24000, 49920]);
  assert.deepEqual([mix.audit(bumped, last, film25).hits, mix.snap([23], bumped, film25)], [1, [24]]);
  // 只有底音、没有点击：片尾不多出起音
  const plain = [Float32Array.from({ length: 50000 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 600 * i) / RATE))];
  assert.deepEqual([mix.onsets(plain), strict.onsets(plain), mix.audit(plain, last, film25).hits], [[0], [0], 0]);
  // 七审的反例之三、之四：分数帧率下给全片每个整数帧各放一个事件，逐条量出的命中率和随机基线是同一个数（60000/1001 帧每秒容差 2 帧是 3/305，120000/1001 帧每秒一帧不差是 1/201）
  for (const [fps, frames, at, toleranceFrames, hits] of [['60000/1001', 305, 240240, 2, 3], ['120000/1001', 201, 79680, 0, 1]]) {
    const frac = createMix({ fps, seed: 1 }, params('audio.event-mix')).object, pcm = frac.mix([], { frames }).channels;
    pcm[0][at] = pcm[1][at] = 0.5;
    const seen = frac.audit(pcm, Array.from({ length: frames }, (_, frame) => ({ ...ev, frame })), { frames, toleranceFrames });
    assert.deepEqual([frac.onsets(pcm), seen.hits, seen.hitRate, seen.baseline], [[at], hits, hits / frames, hits / frames], fps);
  }

  // audio.align：界是硬的闭区间；偏移不是有限数、总帧数不是正的安全整数
  const card = createAlign({ fps: FPS }, params('audio.align')).object, src = [new Float32Array(RATE).fill(0.25)];
  for (const stretch of [0.97, 1.03]) assert.equal(card.align(src, { frames: 24, stretch }).stretch, stretch);
  for (const stretch of [0.9699999995, 1.0300000005, 0.969, 1.031, NaN]) refused(() => card.align(src, { frames: 24, stretch }), `拉伸比 ${stretch}`);
  for (const offsetSec of [NaN, Infinity]) refused(() => card.align(src, { frames: 1, offsetSec }), `偏移 ${offsetSec}`);
  for (const frames of [0, 1.5, 2 ** 53]) refused(() => card.align(src, { frames }), `总帧数 ${frames}`);
  assert.ok(card.align(src, { frames: 1, offsetSec: 0.01 }).channels.every((ch) => ch.every(Number.isFinite)));
});

test('T7-11 左右反相的立体声：29-2 的吸附和 5-1 的按重击对位都和单声道的结果一样', () => {
  const flip = (x) => x.map((v) => -v);
  // 29-2：配乐右声道取反，找到的起音、吸到的帧、审计的命中率都不变
  const { mix, bed, cursor } = scene29(), antiphase = [bed[0], flip(bed[0])];
  assert.ok(mix.onsets([bed[0]]).length >= 11);
  assert.deepEqual(mix.onsets(antiphase), mix.onsets([bed[0]]));
  assert.deepEqual(mix.snap(S29.wanted, antiphase), mix.snap(S29.wanted, bed));
  assert.equal(mix.audit(antiphase, cursor.object.events).hitRate, mix.audit(bed, cursor.object.events).hitRate);
  // 5-1：配乐右声道取反，十下重击照样找到，对位的拉伸比和偏移不变，右声道还是左声道取反
  const card = createAlign({ fps: FPS }, params('audio.align')).object, [left] = track05(), mono = card.align([left], { frames: S05.frames, anchors: anchors05() });
  assert.deepEqual(card.hits([left, flip(left)]), card.hits([left]));
  assert.equal(card.hits([left]).length, HIT_SECS.length);
  const out = card.align([left, flip(left)], { frames: S05.frames, anchors: anchors05() });
  assert.deepEqual([out.stretch, out.offsetSec], [mono.stretch, mono.offsetSec]);
  within(card.hits(out.channels).at(-1) * 24, S05.cuts[1], 2, '反相立体声对完的最后一下重击 ');
  assert.ok(out.channels[1].every((v, i) => v === -out.channels[0][i]));
});
