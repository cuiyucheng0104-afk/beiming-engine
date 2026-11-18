import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadContracts } from '../contracts/validate.mjs';
import { shotInput } from './input.mjs';
import { stream, streamName } from './rng.mjs';
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
  // 钉住算法：改了出数方法，这个数会变
  assert.deepEqual(take(stream('20261118/s02/scatter/rock.03'), 2), PINNED);
  const s = stream('1/s01/a/b');
  for (let i = 0; i < 1000; i++) { const v = s.next(); assert.ok(v >= 0 && v < 1); }
});

test('镜头输入：片子标识、画幅、帧率加这个镜头的条目；带 renderer 时出帧者那一套换到顶层', async () => {
  const film = {
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
  const swapped = shotInput(film, 's02').shot;
  assert.deepEqual([swapped.source, swapped.host, swapped.mode, 'entry' in swapped, 'renderer' in swapped], ['core', 'offscreen', 'cards-data', false, false]);
  assert.throws(() => shotInput(film, 's09'), RangeError);
});

const PINNED = [3805304422, 282460036];
