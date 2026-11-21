// time.seeded 的自测：每帧的数就是那条命名随机流里对应位置的数，先算哪一帧都一样。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stream } from '../../../kernel/eval/rng.mjs';
import { evaluate } from './evaluate.mjs';

const inputs = { seed: 7803, shot: { id: 's02', in: 180, frames: 120 } };
const params = { purpose: 'jitter', object: 'all', count: 4 };

test('time.seeded：第 3 帧的 4 个数是流 7803/s02/jitter/all 的第 12 到 15 个数', () => {
  const s = stream('7803/s02/jitter/all'), all = Array.from({ length: 16 }, () => s.next());
  assert.deepEqual(evaluate(inputs, params, 3, 0).seeded.values, all.slice(12, 16));
  assert.deepEqual(evaluate(inputs, params, 0, 0).seeded.values, all.slice(0, 4));
});

test('time.seeded：倒着算、重复算、带子帧相位算都是同一组数；数都在 [0, 1)', () => {
  const forward = [0, 1, 2, 3, 4].map((f) => evaluate(inputs, params, f, 0).seeded.values);
  const backward = [4, 3, 2, 1, 0].map((f) => evaluate(inputs, params, f, 0.5).seeded.values).reverse();
  assert.deepEqual(backward, forward);
  assert.ok(forward.flat().every((v) => v >= 0 && v < 1));
  assert.equal(new Set(forward.flat()).size, 20);
});

test('time.seeded：换一个用途、对象、镜头或种子就是另一条流', () => {
  const base = evaluate(inputs, params, 0, 0).seeded.values;
  for (const other of [evaluate(inputs, { ...params, purpose: 'pick' }, 0, 0), evaluate(inputs, { ...params, object: 'hero' }, 0, 0), evaluate({ ...inputs, seed: 7804 }, params, 0, 0), evaluate({ seed: 7803, shot: { id: 's03' } }, params, 0, 0)]) {
    assert.notDeepEqual(other.seeded.values, base);
  }
});
