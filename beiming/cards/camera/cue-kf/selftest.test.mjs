// 原创的两句旁白和一张无素材的平面。所有时刻均为帧号，测试不读私有文件，也不依赖 GPU。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three-webgpu';
import { evaluate as narration } from '../../time/narration/evaluate.mjs';
import { evaluate } from './evaluate.mjs';

const a = { cue: 'cue_a', durationFrames: 45, from: [0, 0], to: [90, 0] };
const b = { cue: 'cue_b', durationFrames: 45, from: [90, 0], to: [90, -90] };
const moves = [a, b], events = { cue_a: 240, cue_b: 546 };
const at = (f, sub = 0) => evaluate({ events }, { moves }, f, sub);
const near = (v, expected) => assert.ok(Math.abs(v - expected) < 1e-9, `${v} ≠ ${expected}`);
const bad = (fn) => assert.throws(fn, { code: 'usage.bad-argument' });

// B4 报第一对运动帧中较早的那一帧。这里不读 speed/事件时间，把实际输出的平移取整为像素，连着 6 对有位移才报。
function pixelStarts(sequence, n = 600) {
  const starts = [];
  let previous, run = 0;
  for (let f = 0; f < n; f++) {
    const { matrix } = sequence(f), xy = [12, 13].map((k) => Math.round(matrix[k]));
    run = previous && xy.some((v, i) => v !== previous[i]) ? run + 1 : 0;
    if (run === 6) starts.push(f - 6);
    previous = xy;
  }
  return starts;
}

test('camera.cue-kf：默认起在词上；指定提前量时起在词前，换词时间后两次起点独立地跟着改', () => {
  const lead = [{ ...a, cueOffsetFrames: -15 }, { ...b, cueOffsetFrames: -27 }];
  const seq = (events, moves) => (f) => evaluate({ events }, { moves }, f, 0);
  assert.deepEqual(pixelStarts(at), [240, 546]);
  assert.deepEqual(pixelStarts(seq(events, lead)), [225, 519]);
  assert.deepEqual(pixelStarts(seq({ cue_a: 200, cue_b: 510 }, lead)), [185, 483]);
  assert.deepEqual(pixelStarts(seq(events, lead.map((m) => ({ ...m, cueOffsetFrames: m.cueOffsetFrames + 2 })))), [227, 521]);
});

test('camera.cue-kf：真实旁白命名条目、全片事件文档和宿主的局部 f 在非首镜头解出相同子帧轨迹', () => {
  const shot = { id: 'map', in: 120, frames: 600 }, fps = '30/1';
  const timing = { scenes: [{ scene: 'map', startSec: 4 }], words: [{ scene: 'map', word: 'fold', startSec: 6, endSec: 6.5 }] };
  const { cues } = narration({ shot, fps }, { timing, anticipationSec: 0, triggers: [{ id: 'cue_a', scene: 'map', phrase: 'fold' }] }, 60, 0);
  const cut = { id: 'cut.120', kind: 'cut', frame: 120, sub: 0, from: 'film' };
  const doc = { format: 'events/0.1', film: 'map', fps, frames: 720, events: [cut, { ...cues.events[0], shot: 'map', audio: 'tick.low', sync: 'onset' }] };
  const localized = doc.events.map(({ id, kind, frame, sub }) => ({ id, kind, f: frame - shot.in, sub }));
  for (const f of [0, 59, 60, 61, 80, 105]) {
    const sample = (events) => evaluate({ fps, size: [640, 360], seed: 7, shot, events }, { moves: [a] }, f, 0.25);
    const viaMap = sample({ cue_a: 180 });
    for (const source of [doc, doc.events, localized, cues.events]) assert.deepEqual(sample(source), viaMap);
    if (f < 60) assert.equal(viaMap.panX, 0);
    if (f >= 60) assert.ok(viaMap.panX > 0);
  }
  const fractional = { events: [{ ...localized[1], sub: 0.5 }] }, p = { moves: [a] };
  assert.equal(evaluate(fractional, p, 60, 0.25).panX, 0);
  assert.equal(evaluate(fractional, p, 60, 0.5).panX, 0);
  assert.ok(evaluate(fractional, p, 60, 0.75).panX > 0);
  bad(() => evaluate({ events: doc }, { moves: [{ ...a, cue: cut.id }] }, 0, 0));
});

test('camera.cue-kf：端点与空段保持，子帧缓动，加速后减速，乱序重复求值逐位一致', () => {
  assert.equal(evaluate.length, 4);
  assert.deepEqual(evaluate({}, { moves: [] }, 42, 0), at(0));
  const samples = [240, 241, 262, 263, 284, 285].map((f) => at(f));
  const [start, next, mid, midNext, penultimate, end] = samples;
  assert.equal(start.panX, 0);
  assert.equal(end.panX, 90);
  assert.equal(end.speed, 0);
  assert.deepEqual(end, at(500));
  assert.equal(at(239, 0.99).speed, 0);
  assert.ok(next.panX >= 1 && midNext.panX - mid.panX > next.panX - start.panX);
  near(next.panX, end.panX - penultimate.panX);
  assert.deepEqual(at(262, 0.5).panX, 45);
  const delta = (at(260, 0.501).panX - at(260, 0.499).panX) / 0.002;
  assert.ok(Math.abs(at(260, 0.5).speed - delta) < 1e-7);
  const baseline = JSON.stringify(samples);
  for (const ix of [5, 3, 0, 2, 4, 1]) assert.deepEqual(at([240, 241, 262, 263, 284, 285][ix]), samples[ix]);
  assert.equal(JSON.stringify(samples), baseline);
  end.matrix[0] = 0;
  end.camera.pos[0] = 0;
  assert.equal(at(285).matrix[0], 1);
  assert.notEqual(at(285).camera.pos[0], 0);
});

test('camera.cue-kf：pan、zoom 与 4×4 矩阵等价于页面相机在地图上的投影；纯变焦也有速度', () => {
  const size = [960, 540], move = { ...a, from: [-42, 15], to: [18, -37], zoomFrom: 0.75, zoomTo: 2 };
  const params = { moves: [move, { ...b, from: move.to, to: move.to, zoomTo: 1.25 }] };
  for (const f of [0, 240, 251, 262, 285, 400, 550, 599]) {
    const s = evaluate({ events, size }, params, f, 0.5), { pos, quat, fovDeg } = s.camera, [w, h] = size;
    assert.deepEqual(s.camera, s.tracks.camera);
    const camera = new PerspectiveCamera(fovDeg, w / h, 0.1, 100);
    camera.position.fromArray(pos); camera.quaternion.fromArray(quat); camera.updateMatrixWorld();
    // 用页面相机实际投点，不取 card 的单位换算或变焦函数。
    const rest = new PerspectiveCamera(40, w / h, 0.1, 100), mapPoint = new Vector3(1, 0.5, -10);
    const screen = (c) => { const p = mapPoint.clone().project(c); return [p.x * w / 2, -p.y * h / 2]; };
    const [x, y] = screen(rest), [sx, sy] = screen(camera), m = s.matrix;
    assert.equal(m.length, 16);
    near(sx, m[0] * x + m[4] * y + m[12]); near(sy, m[1] * x + m[5] * y + m[13]);
    near(sx, (x - s.panX) * s.zoom); near(sy, (y - s.panY) * s.zoom);
    if (f === 0) assert.equal(s.zoom, 0.75);
    if (f === 400) assert.equal(s.zoom, 2);
    if (f === 550) assert.ok(s.speed > 0 && s.zoom < 2);
    if (f === 599) assert.equal(s.zoom, 1.25);
  }
});

test('camera.cue-kf：拒绝无名/写死起点、歧义/重叠、稀疏数组、未知属性和非有限数', () => {
  const e = { id: 'cue_a', kind: 'named', frame: 240, sub: 0, from: 'film' };
  for (const patch of [{ startFrame: 24 }, { cue: 240 }, { cue: 'missing' }, { durationFrames: 0 }, { durationFrames: 2.5 },
    { cueOffsetFrames: null }, { cueOffsetFrames: Infinity }, { zoomFrom: NaN }, { zoomTo: 0 }, { from: [1, Infinity] },
    { to: Object.assign(Array(2), { 1: 2 }) }, { to: Object.assign([0, 1], { x: 1 }) }, { from: [0, 1, 2] }]) bad(() => evaluate({ events }, { moves: [{ ...a, ...patch }] }, 0, 0));
  for (const m of [[a, a], [a, { ...b, from: [0, 0] }], [a, { ...b, zoomFrom: 2 }], Array(1)]) bad(() => evaluate({ events }, { moves: m }, 0, 0));
  for (const input of [{ extra: true }, { events: { cue_a: NaN } }, { events: [{ ...e, f: 1 }] }, { events: [e, e] }, { events: [{ ...e, extra: 5 }] },
    { events: [{ ...e, sub: 1 }] }, { shot: { in: NaN } }, { size: [2, Infinity] }]) bad(() => evaluate(input, { moves: [] }, 0, 0));
  for (const [f, sub] of [[-1, 0], [NaN, 0], [0, Infinity], [0, 1], [0, -0.1]]) bad(() => evaluate({}, { moves: [] }, f, sub));
});

test('camera.cue-kf：边界各层拒收非普通对象、已撤销或抛错的 Proxy 和访问器，不执行一次 getter 或隐式格式化', () => {
  let calls = 0;
  const trap = () => { calls++; throw Error('不得调用'); };
  const accessor = (obj, key) => Object.defineProperty(obj, key, { enumerable: true, get: trap });
  const rev = Proxy.revocable([], { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  rev.revoke();
  const poison = new Proxy({}, { getPrototypeOf() { throw new Error('陷阱异常'); } });
  const unformatted = { toString: trap, valueOf: trap };
  const p = { moves: [a] }, i = { events };
  for (const input of [new Date(), Object.create({}), rev.proxy, poison, { shot: new Map() }, { events: new Set() },
    { events: [Object.create({})] }, { events: [rev.proxy] }, { events: { cue_a: unformatted } },
    { events: accessor({}, 'cue_a') }, { events: [accessor({ kind: 'named', f: 7, sub: 0 }, 'id')] }, accessor({}, 'events')]) bad(() => evaluate(input, p, 0, 0));
  for (const params of [new Date(), poison, accessor({}, 'moves'), { moves: rev.proxy }, { moves: [Object.create(a)] }, { moves: [accessor({ ...a }, 'cue')] },
    { moves: [{ ...a, from: new Float64Array([0, 0]) }] }, { moves: [{ ...a, to: accessor([1, 2], '1') }] }, { moves: [{ ...a, zoomFrom: unformatted }] }]) bad(() => evaluate(i, params, 0, 0));
  bad(() => evaluate(i, p, unformatted, 0));
  assert.equal(calls, 0);
});
