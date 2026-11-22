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

test('audio.event-mix：mix、snap、audit 用同一套事件校验：字符串、null、布尔的 sub，片头之前、片尾之后、不是安全整数的帧号，有空洞的数组、不是对象的条目，三个入口都报 usage.bad-argument', () => {
  const c = card({ fadeMs: 0 }), bad = (fn, what) => assert.throws(fn, { name: 'RangeError', code: 'usage.bad-argument' }, what);
  const bed = c.mix(BEATS, { frames: 120 }).channels, pulse = { samples: { pulse: ones(1) } };
  // 数值 0.5 落在第 3000 个采样点；字符串 "0.5" 以前会拼成 "10.5"，晚 18000 个采样点
  assert.equal(c.mix([{ id: 'x', frame: 1, sub: 0.5, audio: 'pulse' }], { frames: 24, ...pulse }).channels[0].findIndex((v) => v !== 0), 3000);
  for (const sub of ['0.5', '0', '', null, true, false, [0.5], NaN, Infinity, 1, -0.1]) {
    bad(() => c.mix([{ id: 'x', frame: 1, sub, audio: 'pulse' }], { frames: 24, ...pulse }), `mix 的 sub ${JSON.stringify(sub)}`);
    bad(() => c.audit(bed, [{ id: 'x', frame: 18, sub, audio: 'click' }]), `audit 的 sub ${JSON.stringify(sub)}`);
  }
  // 片头之前的事件以前被 audit 按距离算成命中；全片 120 帧，第 120 帧已经出了片尾
  for (const frame of [-1, 120, 1.5, NaN, Infinity, 2 ** 53, '18', null, true, undefined]) {
    bad(() => c.mix([{ id: 'x', frame, audio: 'click' }], { frames: 120 }), `mix 的帧号 ${frame}`);
    bad(() => c.audit(bed, [{ id: 'x', frame, audio: 'click' }]), `audit 的帧号 ${frame}`);
    bad(() => c.snap([frame], bed), `snap 的帧号 ${frame}`);
  }
  // 不带 audio 的条目不出声，写错了照样拒
  bad(() => c.mix([{ id: 'note', frame: -1 }], { frames: 120 }));
  bad(() => c.audit(bed, [{ id: 'note', frame: 5, sub: '0.5' }]));
  const holes = [{ id: 'a', frame: 6, audio: 'click' }, , { id: 'b', frame: 18, audio: 'click' }]; // eslint-disable-line no-sparse-arrays
  for (const events of [holes, [null], [18], ['x'], [[]], null, undefined, 18, 'x', {}, { events: null }, { frames: 120, events: holes }]) {
    bad(() => c.mix(events, { frames: 120 }), `mix 的事件 ${JSON.stringify(events)}`);
    bad(() => c.audit(bed, events), `audit 的事件 ${JSON.stringify(events)}`);
  }
  for (const frames of [[6, , 18], null, undefined, 18, { length: 1, 0: 6 }]) bad(() => c.snap(frames, bed), `snap 的帧号表 ${JSON.stringify(frames)}`); // eslint-disable-line no-sparse-arrays
  // 采样率：snap、audit 也可以不写，写了就得是 48000
  for (const sampleRate of [44100, 0, NaN, '48000']) {
    bad(() => c.snap([6], bed, { sampleRate }));
    bad(() => c.audit(bed, [], { sampleRate }));
  }
  // 合法的照常：片头第 0 帧、片尾最后一帧、sub 不写或写 0
  assert.deepEqual(c.snap([0, 119], bed, { sampleRate: 48000 }), [6, 102]);
  assert.deepEqual(c.audit(bed, [{ id: 'a', frame: 6, audio: 'click' }, { id: 'b', frame: 119, sub: 0, audio: 'click' }, { id: 'cut.8', frame: 8 }], { sampleRate: 48000 }).rows.map((r) => r.frame), [6, 119]);
});

test('audio.event-mix：建卡时参数不是有限的数、容差或收尾是负数、起音门槛不是正数都报 usage.bad-argument，不让无穷大的容差把命中率刷满', () => {
  const bad = (params) => assert.throws(() => card(params), { name: 'RangeError', code: 'usage.bad-argument' }, JSON.stringify(params));
  for (const key of Object.keys(DEFAULTS)) for (const value of [NaN, Infinity, '2', null]) bad({ [key]: value });
  for (const params of [{ toleranceFrames: -1 }, { fadeMs: -1 }, { onsetFloor: 0 }, { onsetFloor: -0.1 }]) bad(params);
  assert.ok(card({ toleranceFrames: 0, fadeMs: 0 }));
});

test('audio.event-mix：片尾、空洞和选项：audit、snap 和 mix 认同一个全片帧数，snap 交出的帧号都在全片里，声道数组有空洞、选项写法不对三个入口都报 usage.bad-argument', () => {
  const c = card({ fadeMs: 0 }), bad = (fn, what) => assert.throws(fn, { name: 'RangeError', code: 'usage.bad-argument' }, what);
  // 48 帧的配乐，鼓点在第 12 和第 24 帧；正片可以比配乐短
  const pcm = c.mix([12, 24].map((frame) => ({ id: `k-${frame}`, frame, audio: 'kick' })), { frames: 48 }).channels;
  const at12 = [{ id: 'x', frame: 12, audio: 'click' }], at23 = [{ id: 'y', frame: 23, audio: 'click' }];
  assert.equal(c.audit(pcm, { frames: 24, events: at12 }).hitRate, 1);
  assert.equal(c.mix({ frames: 24, events: at12 }).placements[0].sample, 24000);
  // 全片只有 12 帧：第 12 帧在片外，mix 和 audit 一起拒；全片帧数写在事件表里、选项里都算，选项的优先
  for (const [events, opts] of [[{ frames: 12, events: at12 }, undefined], [at12, { frames: 12 }], [{ frames: 24, events: at12 }, { frames: 12 }]]) {
    bad(() => c.mix(events, opts), `mix 全片 12 帧 ${JSON.stringify(opts)}`);
    bad(() => c.audit(pcm, events, opts), `audit 全片 12 帧 ${JSON.stringify(opts)}`);
  }
  bad(() => c.snap([12], pcm, { frames: 12 }));
  // 全片 24 帧：片尾之后（第 24 帧）的那下鼓点不算起音，随机基线的分母是 24 不是 48
  const short = c.audit(pcm, { frames: 24, events: at23 });
  assert.deepEqual([short.hits, short.baseline], [0, 5 / 24]);
  assert.equal(c.audit(pcm, at23).hits, 1);
  assert.deepEqual(c.snap([23], pcm, { frames: 24 }), [12]);
  assert.deepEqual(c.snap([23], pcm), [24]);
  // 事件表、选项里的全片帧数写了就得是正的安全整数，被选项盖掉的也查
  for (const frames of [0, -1, 1.5, NaN, Infinity, 2 ** 53, '24', null, true]) {
    bad(() => c.mix(at12, { frames }), `mix 的 frames ${frames}`);
    bad(() => c.audit(pcm, at12, { frames }), `audit 的 frames ${frames}`);
    bad(() => c.snap([12], pcm, { frames }), `snap 的 frames ${frames}`);
    bad(() => c.mix({ frames, events: at12 }, { frames: 24 }), `mix 的事件表 frames ${frames}`);
    bad(() => c.audit(pcm, { frames, events: at12 }, { frames: 24 }), `audit 的事件表 frames ${frames}`);
  }

  // 全片帧数大得离谱：mix 开不出缓冲，报带 code 的错；snap、audit 不逐帧扫，照常交结果
  bad(() => c.mix(at12, { frames: Number.MAX_SAFE_INTEGER }), 'mix 的全片帧数开不出缓冲');
  assert.deepEqual(c.snap([Number.MAX_SAFE_INTEGER - 1], pcm, { frames: Number.MAX_SAFE_INTEGER }), [24]);
  assert.deepEqual([c.audit(pcm, at12, { frames: Number.MAX_SAFE_INTEGER }).baseline, c.audit(pcm, at12, { frames: 1e9, toleranceFrames: 1e300 }).baseline], [10 / Number.MAX_SAFE_INTEGER, 1]);
  bad(() => create(null, DEFAULTS));
  bad(() => create({ fps: '24/1' }, null));

  // 24 帧的配乐，唯一的起音在第 47760 个采样点（第 23.88 帧）：四舍五入是第 24 帧，已经出了片尾，收回第 23 帧
  const tail = new Float32Array(RATE).fill(1, 47760);
  assert.deepEqual(c.onsets([tail]), [47760]);
  const snapped = c.snap([23, 0], [tail]);
  assert.deepEqual(snapped, [23, 23]);
  assert.equal(c.mix(snapped.map((frame) => ({ id: 'x', frame, audio: 'click' })), { frames: 24 }).placements.length, 2);
  assert.equal(c.audit([tail], snapped.map((frame) => ({ id: 'x', frame, audio: 'click' }))).hitRate, 1);
  // windowFrames：吸过去要挪的帧数超过它的留在原地；toleranceFrames：这一次审计换一个容差
  assert.deepEqual(c.snap([20, 19, 0], [tail], { windowFrames: 3 }), [23, 19, 0]);
  assert.deepEqual(c.snap([23, 22], [tail], { windowFrames: 0.01 }), [23, 22]);
  bad(() => c.snap([23, 22], [tail], { windowFrames: 0 }), '零窗口');
  assert.deepEqual([undefined, { toleranceFrames: 0 }, { toleranceFrames: 3 }].map((opts) => c.audit([tail], [{ id: 'x', frame: 21, audio: 'click' }], opts).hits), [0, 0, 1]);

  // 声道数组有空洞：some、every 会跳过空位，以前 mix 悄悄丢掉右声道，snap、audit 抛不带 code 的 TypeError
  const one = pcm[0], noRight = [one], noLeft = [, one]; // eslint-disable-line no-sparse-arrays
  noRight.length = 2;
  for (const holed of [noRight, noLeft]) {
    bad(() => c.mix(at12, { frames: 24, bed: holed }), 'mix 的配乐有空洞');
    bad(() => c.mix([{ id: 'x', frame: 1, audio: 'wide' }], { frames: 24, samples: { wide: holed } }), 'mix 的音效有空洞');
    bad(() => c.onsets(holed), 'onsets 的声道有空洞');
    bad(() => c.snap([12], holed), 'snap 的声道有空洞');
    bad(() => c.audit(holed, at12), 'audit 的声道有空洞');
  }
  for (const bed of [null, 0, '', false, {}]) bad(() => c.mix(at12, { frames: 24, bed }), `mix 的配乐 ${JSON.stringify(bed)}`);

  // 选项：要是普通对象；windowFrames 写了就得是正的有限数（0 也不收），toleranceFrames 是不小于 0 的有限数，哪个入口都查
  const entries = { mix: (opts) => c.mix(at12, opts), snap: (opts) => c.snap([12], pcm, opts), audit: (opts) => c.audit(pcm, at12, opts) };
  for (const [name, call] of Object.entries(entries)) {
    for (const opts of [null, 5, 'x', true, [], new Map()]) bad(() => call(opts), `${name} 的选项 ${JSON.stringify(opts)}`);
    for (const key of ['windowFrames', 'toleranceFrames']) for (const value of [-1, NaN, Infinity, '2', null, true]) bad(() => call({ frames: 24, [key]: value }), `${name} 的 ${key} ${value}`);
    bad(() => call({ frames: 24, windowFrames: 0 }), `${name} 的 windowFrames 0`);
    for (const samples of [null, 5, 'x', []]) bad(() => call({ frames: 24, samples }), `${name} 的 samples ${JSON.stringify(samples)}`);
    assert.ok(call({ frames: 24, sampleRate: 48000, windowFrames: 0.01, toleranceFrames: 0 }), `${name} 收合法的选项`);
  }
});

test('audio.event-mix：正片比声音短时，起音只在正片那一段里找：片尾之后再响也压不掉片内的起音', () => {
  const c = card(), at12 = { frames: 24, events: [{ id: 'x', frame: 12, audio: 'click' }] };
  // 60 帧的声音、24 帧的正片，第 12 帧一下 0.2 的脉冲；两段只差片尾之后第 30 帧的一个采样
  const quiet = new Float32Array(60 * 2000), loud = new Float32Array(60 * 2000);
  quiet[24000] = loud[24000] = 0.2;
  loud[60000] = 1;
  // 整段找的话门槛跟着那一下强音走，片内的脉冲不到它的 onsetFloor 倍
  assert.deepEqual([c.onsets([quiet]), c.onsets([loud])], [[24000], [60000]]);
  for (const pcm of [quiet, loud]) {
    const seen = c.audit([pcm], at12);
    assert.deepEqual([seen.hits, seen.hitRate, seen.rows[0].delta, seen.baseline], [1, 1, 0, 5 / 24]);
    assert.deepEqual(c.snap([12, 0], [pcm], { frames: 24 }), [12, 12]);
  }
  // 不给全片帧数就是整段声音：强音算数
  assert.deepEqual(c.snap([12], [loud]), [30]);
  // 正片 25 帧是 50000 个采样点，最后一步只有 80 个（49920 起）：这一步里的起音算数，片外第一个采样点（50000）的不算
  const at = (sample) => { const pcm = new Float32Array(60 * 2000); pcm[sample] = 0.2; return [pcm]; }, at24 = [{ id: 'x', frame: 24, audio: 'click' }];
  assert.deepEqual(c.onsets([at(49920)[0].subarray(0, 50000)]), [49920]);
  assert.deepEqual([c.audit(at(49920), at24, { frames: 25 }).hits, c.snap([24], at(49920), { frames: 25 })], [1, [24]]);
  assert.equal(c.audit(at(50000), at24, { frames: 25 }).hits, 0);
  assert.throws(() => c.snap([24], at(50000), { frames: 25 }), { name: 'RangeError', code: 'usage.bad-argument' });
  // 最后那一步只加实际有的采样、不折成整步：一直响着的 110 赫兹长音，不管片尾停在一步里的哪儿，都只有开头那一个起音
  const tone = Float32Array.from({ length: 24240 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 110 * i) / RATE));
  for (let length = 24000; length <= 24240; length++) assert.deepEqual(c.onsets([tone.subarray(0, length)]), [0], `长音 ${length} 个采样点`);
});
