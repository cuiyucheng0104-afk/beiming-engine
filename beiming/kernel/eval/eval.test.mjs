import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContracts } from '../contracts/validate.mjs';
import { eventsTable, renderingOf, shotInput } from './input.mjs';
import { stream, streamName } from './rng.mjs';
import { clampShotSample, decodeTracks, encodeTracks, evalClosedForm, expandEventFrames, interpQuat, interpVec3, slerpQuat } from './index.mjs';
import { globalFrame, hold, shutterSubs } from './time.mjs';

test('全片帧号 = 镜头局部帧号 + 起始帧', () => {
  assert.equal(globalFrame(50, 100), 150);
  assert.equal(globalFrame(0, 49), 49);
  assert.throws(() => globalFrame(1.5, 0), RangeError);
  assert.throws(() => globalFrame(3, -1), RangeError);
});

test('hold(f, n) = f − (f mod n)', () => {
  for (let f = 0; f < 20; f++) for (let n = 1; n < 6; n++) assert.equal(hold(f, n), f - (f % n));
  assert.equal(hold(7, 2), 6);
  assert.throws(() => hold(3, 0), RangeError);
  assert.throws(() => hold(-1, 2), RangeError);
});

test('子帧采样落在 [0, 快门角 ÷ 360) 里，中点在窗口中点', () => {
  assert.deepEqual(shutterSubs(0, 1), [0]);
  assert.deepEqual(shutterSubs(180, 1), [0.25]);
  assert.deepEqual(shutterSubs(180, 2), [0.125, 0.375]);
  for (const [angle, n] of [[180, 8], [360, 16], [90, 3]]) {
    const subs = shutterSubs(angle, n);
    assert.equal(subs.length, n);
    assert.ok(subs.every((s) => s >= 0 && s < angle / 360));
    assert.ok(Math.abs(subs.reduce((a, b) => a + b) / n - angle / 720) < 1e-12);
  }
  assert.throws(() => shutterSubs(361, 1), RangeError);
  assert.throws(() => shutterSubs(180, 0), RangeError);
});

test('流名是四段，参数必须正好两段', () => {
  assert.equal(streamName(20261118, 's02', 'scatter/rock.03'), '20261118/s02/scatter/rock.03');
  for (const bad of ['scatter', 'a/b/c', 'a /b', '/b', 'a/']) assert.throws(() => streamName(1, 's01', bad), RangeError);
  assert.throws(() => streamName(-1, 's01', 'a/b'), RangeError);
});

test('同名的流出同样的序列，和别的流、取数先后无关', () => {
  const take = (s, n) => Array.from({ length: n }, () => s.u32());
  const alone = take(stream('7/s01/a/b'), 16);
  const x = stream('7/s01/a/b'), y = stream('7/s01/a/c');
  const mixed = [];
  for (let i = 0; i < 16; i++) { y.next(); mixed.push(x.u32()); }
  assert.deepEqual(mixed, alone);
  assert.notDeepEqual(take(stream('7/s01/a/c'), 16), alone);
  assert.equal(x.name, '7/s01/a/b');
  // name 只读：镜头代码改不了
  assert.throws(() => { x.name = 'other'; }, TypeError);
  // 钉住算法：改了出数方法，这个数会变
  assert.deepEqual(take(stream('20261118/s02/scatter/rock.03'), 2), PINNED);
  const s = stream('1/s01/a/b');
  for (let i = 0; i < 1000; i++) { const v = s.next(); assert.ok(v >= 0 && v < 1); }
});

test('加删无关对象不改变其余对象的命名随机流', () => {
  const sampleObjects = ids => Object.fromEntries(ids.map(id => {
    const rng = stream(streamName(7, 's01', `scatter/${id}`));
    return [id, Array.from({ length: 4 }, () => rng.u32())];
  }));
  const baseline = sampleObjects(['rock', 'tree']);
  const { cloud, ...afterAddition } = sampleObjects(['cloud', 'rock', 'tree']);
  assert.equal(cloud.length, 4);
  assert.deepEqual(afterAddition, baseline);
  assert.deepEqual(sampleObjects(['tree']), { tree: baseline.tree });
});

const filmDefaults = {
  format: 'film/3.0',
  style: { view: { scene: 'agx-mhc', display: 'srgb' } },
  predicates: { base: ['floor@1'] },
  delivery: { master: 'h264-crf14-bt709' },
};

function assertEventContracts(validate, film, table) {
  assert.deepEqual(validate(film), { contract: 'film', schemaErrors: [], violations: {} });
  const expected = { contract: 'events', schemaErrors: [], violations: {} };
  assert.deepEqual(validate(table), expected);
  assert.deepEqual(validate({ format: 'events-check/0.1', events: table, film }), expected);
}

test('镜头输入：片子标识、画幅、帧率加这个镜头的条目，原样；全片资产、事件表、贴在这个镜头上的叠加层、画风令牌有才带', async () => {
  const film = {
    ...filmDefaults,
    id: 'f_x', output: { size: [640, 360], fps: '24/1', frames: 20 },
    shots: [
      { id: 's01', in: 0, out: 10, source: 'three', host: 'page', mode: 'native-code', entry: 'a.js', colorRef: 'scene', seed: 7 },
      { id: 's02', in: 10, out: 20, source: 'blender', host: 'cycles', mode: 'build-script', entry: 'b.py', colorRef: 'scene', renderer: { source: 'core', host: 'offscreen', mode: 'cards-data' } },
    ],
  };
  const input = shotInput(film, 's01');
  assert.deepEqual(input, { film: 'f_x', output: { size: [640, 360], fps: '24/1' }, shot: film.shots[0] });
  const { validate } = await loadContracts();
  assert.deepEqual(validate(input, 'source', 'shot-input.schema.json').schemaErrors, []);
  // 交出去的是副本：改它不动片子描述
  input.output.size[0] = 1; input.shot.seed = 8;
  assert.deepEqual([film.output.size[0], film.shots[0].seed], [640, 7]);
  // 带 renderer 的条目不改写：顶层那一套和 renderer 对象都在；出帧用的那一套由读的人自己取
  const kept = shotInput(film, 's02').shot;
  assert.deepEqual(kept, film.shots[1]);
  assert.deepEqual([renderingOf(kept).source, renderingOf(film.shots[0]).source], ['core', 'three']);
  assert.throws(() => shotInput(film, 's09'), RangeError);

  const rich = { ...film, style: { ...film.style, tokens: { ink: '#1A1A1A' } }, assets: { vo: 'asset:vo@1' }, overlays: [{ id: 'tag', shot: 's02', anchor: 'screen', pos: [0.5, 0.5], text: 'x', in: 12, out: 15 }] };
  const table = eventsTable(rich);
  assertEventContracts(validate, rich, table);
  const full = shotInput(rich, 's02', table);
  assert.deepEqual([full.assets, full.events, full.overlays, full.tokens], [rich.assets, table, rich.overlays, rich.style.tokens]);
  assert.deepEqual(validate(full, 'source', 'shot-input.schema.json').schemaErrors, []);
  assert.deepEqual(Object.keys(shotInput(rich, 's01', table)), ['film', 'output', 'shot', 'assets', 'events', 'tokens']);
});

test('事件表：命名条目和切点条目，按帧号再按标识排；展开时刻算式', async () => {
  const film = eventFilm([10, 20, 30], [
    { id: 'late', frame: 'cut(20)', shot: 's03', audio: 'hit.low' }, { id: 'early', frame: 4, shot: 's01' },
  ]);
  const table = eventsTable(film);
  assert.deepEqual(table.events, [
    { id: 'early', frame: 4, sub: 0, shot: 's01', kind: 'named', from: 'film' },
    { id: 'cut.10', frame: 10, sub: 0, kind: 'cut', from: 'film' },
    { id: 'cut.20', frame: 20, sub: 0, kind: 'cut', from: 'film' },
    { id: 'late', frame: 20, sub: 0, shot: 's03', kind: 'named', from: 'film', audio: 'hit.low', sync: 'onset' },
  ]);
  const { validate } = await loadContracts();
  assertEventContracts(validate, film, table);
  const singleShot = eventFilm([30]);
  const empty = eventsTable(singleShot);
  assert.deepEqual(empty.events, []);
  assertEventContracts(validate, singleShot, empty);
});

const PINNED = [3805304422, 282460036];

const eventFilm = (ends, events) => ({
  ...filmDefaults,
  id: 'demo', output: { size: [640, 360], fps: '24/1', frames: ends.at(-1) },
  shots: ends.map((out, i) => ({
    id: `s0${i + 1}`, in: ends[i - 1] ?? 0, out,
    source: 'three', host: 'page', mode: 'native-code', colorRef: 'scene', entry: 'shot.js',
  })),
  ...(events ? { events } : {}),
});
const filmFor = events => eventFilm([180, 240], events);

test('数字切点与带偏移的前向引用通过片子描述和事件表契约', async () => {
  const film = {
    ...filmFor([
      { id: 'tail', frame: 'event(cue) - 2', shot: 's02', audio: 'hit', sync: 'pcenter' },
      { id: 'cue', frame: 'cut(180) + 12' }, { id: 'start', frame: 0 }, { id: 'lead', frame: 'cut(180) - 1' },
      { id: 'echo', frame: 'event(lead) + 1' }, { id: 'same', frame: 'event(cue)' },
    ]),
    assets: { vo: 'asset:vo@1' },
    overlays: [{ id: 'tag', shot: 's02', anchor: 'screen', pos: [0.5, 0.5], text: 'x', in: 'event(cue)', out: 'cut(180) + 60' }],
    audio: { narration: [{ id: 'line', at: 'event(cue)', asset: 'vo' }] },
  };
  const table = eventsTable(film);
  assert.deepEqual(table.events.map(e => [e.id, e.frame]), [
    ['start', 0], ['lead', 179], ['cut.180', 180], ['echo', 180],
    ['tail', 190], ['cue', 192], ['same', 192],
  ]);
  assert.equal(table.events[4].sync, 'pcenter');
  const { validate } = await loadContracts();
  assertEventContracts(validate, film, table);
  const reversed = { ...film, events: film.events.toReversed() };
  const reordered = eventsTable(reversed);
  assert.deepEqual(reordered, table);
  assertEventContracts(validate, reversed, reordered);
});

for (const [title, events, reason] of [
  ['镜头名切点', [{ id: 'a', frame: 'cut(s02) + 12' }], 'invalid_expression'],
  ['首镜镜头名切点', [{ id: 'a', frame: 'cut(s01)' }], 'invalid_expression'],
  ['第 0 帧切点', [{ id: 'a', frame: 'cut(0)' }], 'undefined_cut'],
  ['数字不在切点', [{ id: 'a', frame: 'cut(179)' }], 'undefined_cut'],
  ['事件未定义', [{ id: 'a', frame: 'event(constructor)' }], 'undefined_event'],
  ['循环引用', [{ id: 'a', frame: 'event(b)' }, { id: 'b', frame: 'event(a)' }], 'event_cycle'],
  ['展开为负帧', [{ id: 'a', frame: 'cut(180) - 181' }], 'negative_frame'],
  ['超出全片帧数', [{ id: 'a', frame: 'cut(180) + 60' }], 'frame_out_of_range'],
  ['超出所属镜头', [{ id: 'a', frame: 180, shot: 's01' }], 'frame_out_of_range'],
  ['所属镜头未定义', [{ id: 'a', frame: 0, shot: 'none' }], 'undefined_shot'],
  ['重复命名', [{ id: 'a', frame: 1 }, { id: 'a', frame: 2 }], 'duplicate_event'],
]) {
  test(`事件表拒绝${title}`, () => {
    assert.throws(() => eventsTable(filmFor(events)), { code: 'contract.bad-value', reason });
  });
}

test('切点要求两个镜头在同一帧交界', () => {
  const film = filmFor([{ id: 'a', frame: 'cut(180)' }]);
  for (const out of [179, 181]) {
    film.shots[0].out = out;
    assert.throws(() => eventsTable(film), { code: 'contract.bad-value', reason: 'invalid_shot_range' });
  }
  const singleShot = eventFilm([240], film.events);
  assert.throws(() => eventsTable(singleShot), { code: 'contract.bad-value', reason: 'undefined_cut' });
});

test('叠加层或旁白含非法时刻时拒绝生成事件表', () => {
  const film = filmFor([]);
  const overlay = { id: 'tag', shot: 's02', anchor: 'screen', pos: [0.5, 0.5], text: 'x', in: 180, out: 240 };
  const badExpression = { code: 'contract.bad-value', reason: 'invalid_expression' };
  const notACut = { code: 'contract.bad-value', reason: 'undefined_cut' };
  assert.throws(() => eventsTable({ ...film, overlays: [{ ...overlay, in: 'cut(s02)' }] }), badExpression);
  assert.throws(() => eventsTable({ ...film, overlays: [{ ...overlay, out: 'cut(240)' }] }), notACut);
  const narration = [{ id: 'line', at: 'cut(s02)', asset: 'vo' }];
  assert.throws(() => eventsTable({ ...film, audio: { narration } }), badExpression);
});

test('时刻算式严格消费整串，检查十进制整数和空格', () => {
  for (const frame of ['180', 'event(2)', 'cut(0180)', 'event(a.b)', 'cut(180)+2', 'cut(180) + 02',
    'cut(180) + 0', 'event(a) + -2', 'cut(180)\n', 'cut(180) + 1 + 2']) {
    assert.throws(() => eventsTable(filmFor([{ id: 'x', frame }])), { code: 'contract.bad-value', reason: 'invalid_expression' });
  }
});

test('长前向引用链和对象自带的方法名也能展开', () => {
  const count = 12000;
  const events = Array.from({ length: count }, (_, i) => ({ id: `e${i}`, frame: `event(e${i + 1})` }));
  events.push({ id: `e${count}`, frame: 'event(constructor)' }, { id: 'constructor', frame: 8 });
  const frames = expandEventFrames(filmFor(events));
  assert.equal(Object.keys(frames).length, events.length);
  assert.ok(events.every(({ id }) => frames[id] === 8));
});

const identity = [0, 0, 0, 1];
const sampleTracks = {
  weight: { type: 'scalar', samples: [-0, 1.5] },
  pos: { type: 'vec3', samples: [[1, 2, 3], [4, 5, 6]] },
  rot: { type: 'quat', samples: [identity] },
  camera: { type: 'camera', samples: [{ pos: [2, 4, 8], quat: identity, fovDeg: 45 }] },
  bounds: { type: 'bbox', samples: [{ min: [-1, -2, -3], max: [1, 2, 3] }] },
};

test('五种轨道紧凑排列，索引可序列化，重编码逐字节相等', () => {
  const meta = { fps: '24/1' };
  const { bin, indexJson } = encodeTracks(sampleTracks, meta);
  assert.equal(bin.byteLength, 104);
  assert.deepEqual(indexJson.tracks.map(t => [t.name, t.stride, t.offset, t.count]), [
    ['bounds', 6, 0, 1], ['camera', 8, 24, 1], ['pos', 3, 56, 2], ['rot', 4, 80, 1], ['weight', 1, 96, 2],
  ]);
  const decoded = decodeTracks(JSON.parse(JSON.stringify(indexJson)), bin);
  assert.deepEqual(decoded, sampleTracks);
  assert.deepEqual(encodeTracks(decoded, meta), { bin, indexJson });
  assert.deepEqual(encodeTracks(Object.fromEntries(Object.entries(sampleTracks).reverse()), meta), { bin, indexJson });
});

test('独立字节样例钉住小端 float32、负零和单精度舍入', () => {
  const { bin, indexJson } = encodeTracks({ x: { type: 'scalar', samples: [1, -0, 1 / 3] } });
  assert.deepEqual([...bin], [0, 0, 128, 63, 0, 0, 0, 128, 171, 170, 170, 62]);
  const padded = new Uint8Array(14);
  padded.set(bin, 1);
  assert.deepEqual(decodeTracks(indexJson, padded.subarray(1, 13)).x.samples, [1, -0, Math.fround(1 / 3)]);
});

test('空轨道、空索引和特殊轨道名可往返', () => {
  for (const tracks of [{}, { ['__proto__']: { type: 'vec3', samples: [] } }]) {
    const { bin, indexJson } = encodeTracks(tracks);
    assert.equal(bin.length, 0);
    assert.deepEqual(decodeTracks(indexJson, bin), tracks);
  }
});

test('编码拒绝非有限数、单精度溢出和缺失分量', () => {
  for (const n of [NaN, Infinity, -Infinity, 1e39, '1']) {
    assert.throws(() => encodeTracks({ x: { type: 'scalar', samples: [n] } }), RangeError);
  }
  assert.throws(() => encodeTracks({ x: { type: 'vec3', samples: [[1, 2]] } }), TypeError);
  assert.throws(() => encodeTracks({ x: { type: 'constructor', samples: [] } }), RangeError);
});

test('解码拒绝二进制里的 NaN 与正负无穷', () => {
  const { bin, indexJson } = encodeTracks({ x: { type: 'scalar', samples: [0] } });
  for (const word of [0x7fc00001, 0x7f800000, 0xff800000]) {
    new DataView(bin.buffer).setUint32(0, word, true);
    assert.throws(() => decodeTracks(indexJson, bin), RangeError);
  }
});

test('解码拒绝截短数据与多余字节', () => {
  const { bin, indexJson } = encodeTracks(sampleTracks);
  for (const bytes of [bin.subarray(0, -1), new Uint8Array(bin.length + 4)]) {
    assert.throws(() => decodeTracks(indexJson, bytes), RangeError);
  }
});

test('索引逐段校验对齐、重叠、空洞、重名、计数和步长', () => {
  const { bin, indexJson } = encodeTracks(sampleTracks);
  for (const change of [{ offset: 25 }, { offset: 20 }, { offset: 28 }, { count: -1 }, { count: 0.5 },
    { count: 2 ** 53 }, { stride: 3 }, { name: 'bounds' }, { type: 'unknown' }]) {
    const broken = structuredClone(indexJson);
    Object.assign(broken.tracks[1], change);
    assert.throws(() => decodeTracks(broken, bin), RangeError);
  }
});

test('轨道索引保存 JSON 元数据副本并拒绝无法序列化的值', () => {
  const meta = { labels: ['first'], clock: { fps: '24/1' } };
  const { indexJson } = encodeTracks({}, meta);
  meta.labels.push('second');
  meta.clock.fps = '30/1';
  assert.deepEqual(indexJson.meta, { labels: ['first'], clock: { fps: '24/1' } });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [cyclic, 1n, undefined, NaN, () => {}]) {
    assert.throws(() => encodeTracks({}, { value }), { name: 'TypeError', message: /轨道元数据无法序列化为 JSON/ });
  }
});

test('解码明确报告空索引项并拒绝多余字段', () => {
  const { bin, indexJson } = encodeTracks(sampleTracks);
  const [, ...rest] = indexJson.tracks;
  assert.throws(() => decodeTracks({ ...indexJson, tracks: [null, ...rest] }, bin), {
    name: 'TypeError', message: /轨道索引第 1 项必须是对象/,
  });
  const extra = { ...indexJson.tracks[0], extra: true };
  assert.throws(() => decodeTracks({ ...indexJson, tracks: [extra, ...rest] }, bin), {
    name: 'TypeError', message: /轨道索引第 1 项的字段必须为/,
  });
});

test('末帧和单帧镜头保留快门相位', () => {
  for (const sub of shutterSubs(360, 16)) {
    assert.equal(clampShotSample(0, sub, 3), sub);
    assert.equal(clampShotSample(2, sub, 3), 2 + sub);
    assert.equal(clampShotSample(0, sub, 1), sub);
  }
});

test('非法局部帧、相位与镜头长度被拒绝', () => {
  for (const args of [[-1, 0, 3], [3, 0, 3], [1.2, 0, 3], [0, -0.1, 3], [0, 1, 3], [0, NaN, 3], [0, 0, 0]]) {
    assert.throws(() => clampShotSample(...args), RangeError);
  }
});

test('闭式函数拿到局部帧号与相位之和，末帧的快门窗口保持展开', () => {
  const square = t => t * t;
  assert.equal(evalClosedForm(square, 1, 0.5, 3), 2.25);
  assert.equal(evalClosedForm(square, 2, 0.5, 3), 6.25);
  const times = shutterSubs(180, 4).map(sub => evalClosedForm(t => t, 47, sub, 48));
  assert.deepEqual(times, [47.0625, 47.1875, 47.3125, 47.4375]);
  assert.equal(times.reduce((sum, t) => sum + t, 0) / times.length, 47.25);
});

test('三维样本的半帧是精确中点，硬切两侧各取本镜头的位置', () => {
  const a = [[2, -2, 4], [8, 6, -4]];
  const b = [[20, 40, 60], [40, 60, 80]];
  assert.deepEqual(interpVec3(a, 0, 0.5, 2), [5, 2, 0]);
  assert.deepEqual(interpVec3(a, 1, 0.9, 2), a[1]);
  assert.deepEqual(interpVec3([...a, ...b], 1, 0.9, 2), a[1]);
  assert.deepEqual(interpVec3(b, 0, 0.25, 2), [25, 45, 65]);
});

test('球面插值走等角速度短弧，反号的终点表示同一路径', () => {
  const end = [0, 0, Math.sin(Math.PI / 3), Math.cos(Math.PI / 3)];
  for (const t of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
    const q = slerpQuat(identity, end, t);
    assert.ok(Math.abs(q[2] - Math.sin(t * Math.PI / 3)) < 1e-12);
    assert.ok(Math.abs(q[3] - Math.cos(t * Math.PI / 3)) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6);
    assert.deepEqual(slerpQuat(identity, end.map(v => -v), t), q);
  }
});

test('互为负号和几乎共线的单位四元数都保持单位范数', () => {
  assert.deepEqual(slerpQuat(identity, identity.map(v => -v), 0.5), identity);
  const q = interpQuat([identity, [0, 0, 0.00001, 1]], 0, 0.5, 2);
  assert.ok(q[2] > 0 && q[2] < 0.00001);
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6);
});

test('末帧的四元数只读当前样本，零长度四元数拒绝求值', () => {
  const samples = [identity, [0, 0, 1, 0]];
  assert.deepEqual(interpQuat(samples, 1, 0.75, 2), samples[1]);
  assert.deepEqual(interpQuat([...samples, null], 1, 0.75, 2), samples[1]);
  assert.throws(() => slerpQuat(identity, [0, 0, 0, 0], 0.5), RangeError);
});
