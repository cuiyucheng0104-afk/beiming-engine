// audio.event-mix 的自测：算得出标准答案的小例子上看采样点位置、防削波、起音检测和命中率审计。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from './comp.mjs';

const RATE = 48000;
const DEFAULTS = { gainDb: 0, ceilingDb: -1, fadeMs: 2, toleranceFrames: 2, onsetFloor: 0.1 };
const card = (params = {}, ctx = {}) => create({ fps: '24/1', seed: 7, ...ctx }, { ...DEFAULTS, ...params }).object;
const ones = (n) => new Float32Array(n).fill(1);
/** 大数组不交给 deepEqual：不等时它要把两边整个打印出来 */
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const within = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} 应在 ${b} ± ${tol}`);
/** 每秒两下的鼓点（正好 12 帧一下），从第 6 帧起 */
const BEATS = Array.from({ length: 9 }, (_, k) => ({ id: `beat-${k}`, frame: 6 + 12 * k, audio: 'kick' }));

test('audio.event-mix：事件时刻精确到采样点：24 帧每秒第 10 帧、子帧相位 0.5 落在第 21000 个采样点，那之前全是 0', () => {
  const out = card({ gainDb: -6 }).mix([{ id: 'tap', frame: 10, sub: 0.5, audio: 'unit' }, { id: 'note', frame: 3 }], { frames: 24, samples: { unit: ones(480) } });
  assert.deepEqual(out.placements, [{ id: 'tap', audio: 'unit', frame: 10, sub: 0.5, sample: 21000, clippedTail: 0 }]);
  const [left, right] = out.channels;
  assert.equal(left.length, RATE);
  assert.ok(left.subarray(0, 21000).every((v) => v === 0) && left.subarray(21480).every((v) => v === 0));
  within(left[21000], 10 ** (-6 / 20), 1e-6);
  assert.ok(same(left, right));
  // 尾巴 2 毫秒（96 个采样点）线性收到 0
  within(left[21000 + 479] / left[21000], 1 / 96, 1e-6);
  within(left[21000 + 432] / left[21000], 0.5, 1e-6);
  // 30000/1001 帧每秒：第 30 帧是 48048 个采样点
  assert.equal(card({}, { fps: '30000/1001' }).mix([{ id: 'tap', frame: 30, audio: 'click' }], { frames: 60 }).placements[0].sample, 48048);
});

test('audio.event-mix：分数帧率下正好半个采样点的时刻进一，不被中间的浮点数带偏：30000/1001、第 20 帧、子帧相位 0.3125 是第 32533 个采样点', () => {
  // 精确值 20.3125 × 48000 × 1001 ÷ 30000 = 32532.5；先算每帧多少采样点再乘会得到 32532.499…
  const out = card({ fadeMs: 0 }, { fps: '30000/1001' }).mix([{ id: 'tap', frame: 20, sub: 0.3125, audio: 'pulse' }], { frames: 60, samples: { pulse: ones(1) } });
  assert.equal(out.placements[0].sample, 32533);
  assert.equal(out.channels[0].findIndex((v) => v !== 0), 32533);
  assert.equal(out.channels[0].length, Math.round((60 * RATE * 1001) / 30000));
});

test('audio.event-mix：两声道的声音和配乐各走各的声道；被片尾截断的声音照样收尾；事件表可以整张交进来', () => {
  const c = card({ fadeMs: 0 }), bed = [new Float32Array(RATE).fill(0.1), new Float32Array(RATE).fill(-0.1)];
  const table = { format: 'events/0.1', film: 'f_demo', fps: '24/1', frames: 24, events: [{ id: 'cut.12', frame: 12, sub: 0, kind: 'cut', from: 'film' }, { id: 'pan', frame: 23, sub: 0, kind: 'named', from: 'film', audio: 'wide', sync: 'onset' }] };
  const out = c.mix(table, { bed, samples: { wide: [ones(4000).fill(0.5), ones(4000).fill(0.25)] } });
  assert.deepEqual(out.placements, [{ id: 'pan', audio: 'wide', frame: 23, sub: 0, sample: 46000, clippedTail: 2000 }]);
  within(out.channels[0][46000], 0.6, 1e-6);
  within(out.channels[1][46000], 0.15, 1e-6);
  within(out.channels[0][100], 0.1, 1e-6);
  within(card().mix(table, { samples: { wide: ones(4000) } }).channels[0][RATE - 1], 1 / 96 * 10 ** (-1 / 20), 1e-6);
});

test('audio.event-mix：混完峰值超过上限时整体降到正好压线，没超就不动', () => {
  const loud = card().mix([{ id: 'a', frame: 1, audio: 'unit' }, { id: 'b', frame: 1, audio: 'unit' }], { frames: 12, samples: { unit: ones(480) } });
  within(loud.peakDb, -1, 1e-6);
  within(loud.scaleDb, -1 - 20 * Math.log10(2), 1e-6);
  within(Math.max(...loud.channels[0]), 10 ** (-1 / 20), 1e-6);
  const quiet = card({ gainDb: -12 }).mix([{ id: 'a', frame: 1, audio: 'unit' }], { frames: 12, samples: { unit: ones(480) } });
  assert.equal(quiet.scaleDb, 0);
  within(quiet.peakDb, -12, 1e-6);
});

test('audio.event-mix：起音检测：每秒两下的鼓点垫着长音，量出的起音离真值不到 5 毫秒，一下不多一下不少', () => {
  const c = card(), pad = Float32Array.from({ length: 5 * RATE }, (_, i) => 0.05 * Math.sin((2 * Math.PI * 220 * i) / RATE));
  const bed = c.mix(BEATS, { frames: 120, bed: [pad] }).channels, found = c.onsets(bed);
  assert.equal(found.length, BEATS.length);
  found.forEach((s, k) => within(s / RATE, (6 + 12 * k) / 24, 0.005));
  assert.deepEqual(c.onsets([new Float32Array(RATE)]), []);
});

test('audio.event-mix：左右反相的立体声不会互相抵消：起音、吸附和命中率都和单声道、同相的一样', () => {
  const c = card(), [left] = c.mix(BEATS, { frames: 120 }).channels, flipped = left.map((v) => -v);
  const found = c.onsets([left]);
  assert.equal(found.length, BEATS.length);
  assert.deepEqual(c.onsets([left, flipped]), found);
  assert.deepEqual(c.onsets([left, left]), found);
  assert.deepEqual(c.snap([0, 50], [left, flipped]), [6, 54]);
  assert.equal(c.audit([left, flipped], [{ id: 'on', frame: 18, audio: 'click' }]).hitRate, 1);
  // 只有一个声道有声音也找得到
  assert.deepEqual(c.onsets([left, new Float32Array(left.length)]), found);
});

test('audio.event-mix：snap 把帧号吸到最近的起音上；audit 量命中率，随机基线是全片离起音不超过 2 帧的帧所占的比例', () => {
  const c = card(), bed = c.mix(BEATS, { frames: 120 }).channels;
  assert.deepEqual(c.snap([0, 11, 13, 50, 119], bed), [6, 6, 18, 54, 102]);
  const on = c.audit(bed, [18, 54, 102].map((frame) => ({ id: `on-${frame}`, frame, audio: 'click' })));
  assert.deepEqual([on.total, on.hits, on.hitRate], [3, 3, 1]);
  on.rows.forEach((r) => within(r.delta, 0, 0.12));
  // 9 个起音各占 5 帧（前后各 2 帧），全片 120 帧
  within(on.baseline, 45 / 120, 1e-9);
  const off = c.audit(bed, [12, 21, 56, 60].map((frame) => ({ id: `off-${frame}`, frame, audio: 'click' })));
  assert.deepEqual([off.total, off.hits, off.hitRate], [4, 1, 0.25]);
  // 第 12、60 帧正好夹在两个起音正中间，各差 6 帧
  assert.deepEqual(off.rows.map((r) => Math.abs(Math.round(r.delta))), [6, 3, 2, 6]);
  assert.deepEqual(card({ toleranceFrames: 6 }).audit(bed, [{ id: 'far', frame: 12, audio: 'click' }]).hits, 1);
});

test('audio.event-mix：同样的输入混两遍逐个样本相同；换种子只换点击音色的噪声', () => {
  const run = (seed) => card({}, { seed }).mix([...BEATS, { id: 'tap', frame: 30, audio: 'click' }], { frames: 120 }).channels[0];
  assert.ok(same(run(7), run(7)));
  assert.ok(!same(run(7), run(8)));
  assert.ok(same(card({}, { seed: 7 }).voices.kick, card({}, { seed: 8 }).voices.kick));
});

test('audio.event-mix：没有的声音、帧号出了全片或者不是有限的整数、没给总帧数、声道不一样长、空的或者带非有限数的样本、采样率不是 48000、帧率写法不对、没有起音可吸都报 usage.bad-argument', () => {
  const c = card(), bad = (fn) => assert.throws(fn, { name: 'RangeError', code: 'usage.bad-argument' });
  const one = (event, opts) => () => c.mix([{ id: 'x', frame: 1, audio: 'click', ...event }], { frames: 12, ...opts });
  bad(one({ audio: 'gong' }));
  for (const frame of [12, -1, 1.5, NaN, Infinity, '1']) bad(one({ frame }));
  for (const sub of [1, -0.1, NaN, Infinity]) bad(one({ sub }));
  for (const gainDb of [NaN, Infinity]) bad(one({ gainDb }));
  for (const frames of [undefined, 0, 1.5, NaN, 2 ** 53]) bad(one({}, { frames }));
  bad(one({ audio: 'odd' }, { samples: { odd: [ones(10), ones(11)] } }));
  bad(() => c.mix([], { frames: 12, bed: [[0, 1, 2]] }));
  // 空样本、带 NaN 或无穷的样本：音效、配乐、拿去找起音的声音都一样
  for (const dud of [new Float32Array(0), Float32Array.of(0, NaN, 0), Float32Array.of(0, Infinity)]) {
    bad(one({ audio: 'probe' }, { samples: { probe: dud } }));
    bad(one({ audio: 'probe' }, { samples: { probe: [ones(dud.length), dud] } }));
    bad(one({}, { bed: [dud] }));
    bad(() => c.onsets([dud]));
    bad(() => c.audit([dud], []));
  }
  // 这张卡只做 48000 赫兹：采样率可以不写，写了就得是 48000
  for (const sampleRate of [44100, 0, -48000, NaN, '48000']) {
    bad(one({}, { sampleRate }));
    bad(() => card({}, { sampleRate }));
  }
  assert.equal(one({}, { sampleRate: 48000 })().placements[0].sample, 2000);
  assert.equal(card({}, { sampleRate: 48000 }).mix([{ id: 'x', frame: 1, audio: 'click' }], { frames: 12 }).placements[0].sample, 2000);
  for (const fps of ['24', '0/1', '24/0', 'abc', undefined]) bad(() => card({}, { fps }));
  bad(() => c.snap([3], [new Float32Array(RATE)]));
});
