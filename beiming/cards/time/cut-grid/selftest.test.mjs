// time.cut-grid 的自测：手算得出答案的几组拍点和时长。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { evaluate } from './evaluate.mjs';

const DEFAULTS = { marksAre: 'cuts', gridFrames: 12, minShotFrames: 12, offsetFrames: 0, startFrame: 0, endFrame: 0 };
const cuts = (marks, params = {}, f = 0, sub = 0) => evaluate({ fps: '24/1', shot: { id: 's01', in: 0, frames: 240 } }, { ...DEFAULTS, ...params, marks }, f, sub).cuts;

test('time.cut-grid：想切的位置对到最近的网格点，正好在两格中间取后一格；切点条目的 id 是 cut.<帧号>', () => {
  const c = cuts([10, 29, 30, 100]);
  assert.deepEqual(c.frames, [12, 24, 36, 96]);
  assert.equal(c.end, null);
  assert.deepEqual(c.events[0], { id: 'cut.12', frame: 12, sub: 0, kind: 'cut', from: 'film' });
  assert.deepEqual(c.events.map((e) => e.frame), c.frames);
});

test('time.cut-grid：镜头时长累加成切点，最后一个累加是片尾；带小数的时长也对成整数帧', () => {
  assert.deepEqual([cuts([31, 22, 47], { marksAre: 'durations' }).frames, cuts([31, 22, 47], { marksAre: 'durations' }).end], [[36, 48], 96]);
  assert.deepEqual(cuts([30.5, 17.25, 40], { marksAre: 'durations' }).frames, [36, 48]);
});

test('time.cut-grid：离上一个切点不到最短镜头长的往后挪到够长的第一个网格点，切点一个不少', () => {
  assert.deepEqual(cuts([3, 13, 14, 15]).frames, [12, 24, 36, 48]);
  assert.deepEqual(cuts([24, 30], { minShotFrames: 30 }).frames, [36, 72]);
});

test('time.cut-grid：offsetFrames 是网格的相位；startFrame 是第一个镜头的起点', () => {
  assert.deepEqual(cuts([10, 29, 100], { offsetFrames: 5 }).frames, [17, 29, 101]);
  assert.deepEqual(cuts([100, 130], { startFrame: 96 }).frames, [108, 132]);
});

test('time.cut-grid：给了 endFrame，最后一个镜头也要够长，放不下报错', () => {
  assert.equal(cuts([24, 48], { endFrame: 60 }).end, 60);
  assert.throws(() => cuts([24, 48], { endFrame: 59 }), RangeError);
  assert.throws(() => cuts([31, 22, 47], { marksAre: 'durations', endFrame: 50 }), RangeError);
});

test('time.cut-grid：这一刻在第几个镜头、离前后切点各几帧', () => {
  assert.deepEqual([cuts([24, 48], {}, 5).shot, cuts([24, 48], {}, 5).sinceFrames, cuts([24, 48], {}, 5).untilFrames], [0, 5, 19]);
  assert.deepEqual([cuts([24, 48], {}, 24).shot, cuts([24, 48], {}, 24, 0.5).sinceFrames, cuts([24, 48], {}, 24, 0.5).untilFrames], [1, 0.5, 23.5]);
  assert.deepEqual([cuts([24, 48], {}, 60).shot, cuts([24, 48], {}, 60).untilFrames], [2, null]);
});

test('time.cut-grid：非首镜头（shot.in 是 96）：默认 marks 是镜头局部帧号，交出的切点加上 96；f 也是局部帧号，局部第 12 帧正好到切点', () => {
  const at = (params, f, sub = 0) => evaluate({ fps: '24/1', shot: { id: 's02', in: 96, frames: 240 } }, { ...DEFAULTS, marks: [12, 48], ...params }, f, sub).cuts;
  const c = at({}, 12);
  assert.deepEqual([c.frames, c.events.map((e) => [e.id, e.frame]), c.shot, c.sinceFrames, c.untilFrames], [[108, 144], [['cut.108', 108], ['cut.144', 144]], 1, 0, 36]);
  assert.deepEqual([at({}, 0).shot, at({}, 0).sinceFrames, at({}, 0).untilFrames, at({}, 11, 0.5).untilFrames], [0, 0, 12, 0.5]);
  assert.equal(at({ endFrame: 60 }, 0).end, 156);
  assert.deepEqual([at({ marks: [31, 22, 47], marksAre: 'durations' }, 0).frames, at({ marks: [31, 22, 47], marksAre: 'durations' }, 0).end], [[132, 144], 192]);
  // origin 是 film：marks、startFrame 是全片帧号，交出去不再加；这一刻还是全片第 96 + f 帧
  const g = at({ origin: 'film', marks: [108, 144], startFrame: 96 }, 12);
  assert.deepEqual([g.frames, g.shot, g.sinceFrames, g.untilFrames], [[108, 144], 1, 0, 36]);
  assert.deepEqual([at({ origin: 'film', marks: [108, 144], startFrame: 96 }, 0).sinceFrames, at({ origin: 'film' }, 0).frames, at({ origin: 'film' }, 0).shot], [0, [12, 48], 2]);
});

test('time.cut-grid：不经宿主直接调，步长等帧数参数不合规矩报 usage.bad-argument，不交 NaN 也不交负步长算出来的数', () => {
  const bad = (params) => assert.throws(() => cuts([10, 29], params), (e) => e instanceof RangeError && e.code === 'usage.bad-argument', JSON.stringify(params));
  for (const gridFrames of [0, -12, 1.5, NaN, Infinity, '12', undefined]) bad({ gridFrames });
  for (const minShotFrames of [0, -1, 2.5, NaN]) bad({ minShotFrames });
  bad({ offsetFrames: -1 });
  bad({ startFrame: 0.5 });
  bad({ endFrame: NaN });
  bad({ origin: 'scene' });
});

test('time.cut-grid：不经宿主直接调，整数参数的上下限和卡文件里写的一样：正好在限上能算，超出一格报 usage.bad-argument', () => {
  const { params } = JSON.parse(fs.readFileSync(new URL('./card.json', import.meta.url), 'utf8'));
  const ranged = Object.entries(params).filter(([, p]) => p.type === 'integer');
  assert.deepEqual(ranged.map(([name]) => name), ['gridFrames', 'minShotFrames', 'offsetFrames', 'startFrame', 'endFrame']);
  for (const [name, { range: [lo, hi] }] of ranged) {
    for (const v of [lo, hi]) assert.ok(cuts([10, 29], { [name]: v }).frames.length === 2, `${name} = ${v}`);
    for (const v of [lo - 1, hi + 1]) assert.throws(() => cuts([10, 29], { [name]: v }), (e) => e instanceof RangeError && e.code === 'usage.bad-argument', `${name} = ${v}`);
  }
});

test('time.cut-grid：位置不是从小到大、时长不大于 0、marksAre 写了别的值都报错', () => {
  assert.throws(() => cuts([30, 10]), RangeError);
  assert.throws(() => cuts([10, 0], { marksAre: 'durations' }), RangeError);
  assert.throws(() => cuts([10], { marksAre: 'beats' }), RangeError);
});
