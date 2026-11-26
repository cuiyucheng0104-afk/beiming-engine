import assert from 'node:assert/strict';
import test from 'node:test';
import { stillMatch } from './still-match.mjs';

const width = 2, height = 2;
const options = { width, height };
const query = Uint8Array.of(20, 30, 40, 50);
const flat = (n) => Uint8Array.of(n, n, n, n);

test('still.match reports exact mean absolute error, the earliest tie, and a separated runner-up', () => {
  const frames = Array.from({ length: 24 }, () => flat(100));
  frames[1] = Uint8Array.of(20, 31, 42, 50);
  frames[2] = frames[1];
  frames[11] = frames[1];
  frames[12] = Uint8Array.of(20, 29, 41, 52);
  frames[13] = frames[12];
  const reading = stillMatch(query, frames, options);
  assert.deepEqual(reading, { metric: 'metric:still.match', value: 1, unit: 'frames', details: {
    best: { frame: 1, meanAbsError: 0.75 }, runnerUp: { frame: 12, meanAbsError: 1 }, offset: null,
  } });
  const bytes = Buffer.concat([Buffer.of(255), ...frames.map(frame => Buffer.from(frame)), Buffer.of(0)]);
  const packed = bytes.subarray(1, -1);
  Object.defineProperty(packed, 'subarray', { value() { throw new Error('custom method called'); } });
  assert.deepEqual(stillMatch(query, packed, options), reading);
  assert.deepEqual(stillMatch(query, frames, { ...options, exclusionRadius: 0 }).details.runnerUp,
    { frame: 2, meanAbsError: 0.75 });
  assert.deepEqual(stillMatch(query, [query], options).details, {
    best: { frame: 0, meanAbsError: 0 }, runnerUp: null, offset: null,
  });
});

test('still.match estimates integer displacement from the query to the chosen frame when requested', () => {
  const width = 16, height = 12, dx = 2, dy = -1;
  const still = Uint8Array.from({ length: width * height }, (_, i) => (137 * i + 13 * (i % width) ** 2) % 253);
  const shifted = Uint8Array.from(still, (_, i) => {
    const x = i % width - dx, y = Math.floor(i / width) - dy;
    return x >= 0 && x < width && y >= 0 && y < height ? still[y * width + x] : 0;
  });
  const frames = [new Uint8Array(still.length).fill(255), shifted];
  const reading = stillMatch(still, frames, { width, height, maxPan: 3 });
  assert.equal(reading.value, 1);
  assert.ok(reading.details.best.meanAbsError > 0);
  assert.deepEqual(reading.details.offset, { dx, dy, meanAbsError: 0 });
  const identity = stillMatch(still, still, { width, height, maxPan: 0 });
  assert.deepEqual(identity.details.offset, { dx: 0, dy: 0, meanAbsError: 0 });
});

test('still.match rejects empty, malformed or mismatched gray input', () => {
  const bad = { code: 'usage.bad-argument' };
  for (const invalid of [[], Array(1), [null], [flat(0), new Uint8Array(3)], new Uint8Array(0),
    new Uint8Array(5), new Uint16Array(4), new Proxy([query], {}),
    Object.setPrototypeOf(Array(1), Object.assign(Object.create(Array.prototype), { 0: query }))]) {
    assert.throws(() => stillMatch(query, invalid, options), bad);
  }
  for (const invalid of [new Uint8Array(3), new Uint16Array(4), null]) {
    assert.throws(() => stillMatch(invalid, query, options), bad);
  }
  const getter = [query];
  Object.defineProperty(getter, 0, { get() { throw new Error('getter called'); } });
  assert.throws(() => stillMatch(query, getter, options), bad);
  for (const invalid of [null, { width: 0, height: 2 }, { width: 2, height: 1.5 },
    { ...options, exclusionRadius: -1 }, { ...options, maxPan: NaN }, { ...options, unknown: true }]) {
    assert.throws(() => stillMatch(query, query, invalid), bad);
  }
});
