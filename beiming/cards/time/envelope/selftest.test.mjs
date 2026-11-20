// time.envelope 的自测：三段直线上的几个点和手算的比。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from './evaluate.mjs';

const params = { at: 12, attackFrames: 4, holdFrames: 2, releaseFrames: 8 };
const value = (f, sub = 0, p = params) => evaluate({}, p, f, sub).envelope.value;

test('time.envelope：起 4 帧、保持 2 帧、落 8 帧', () => {
  assert.deepEqual([11, 12, 14, 16, 18, 22, 26, 40].map((f) => value(f)), [0, 0, 0.5, 1, 1, 0.5, 0, 0]);
});

test('time.envelope：子帧相位算在时刻里', () => {
  assert.equal(value(13, 0.5), 0.375);
});

test('time.envelope：起的帧数是 0 时在起点直接是 1；三段都是 0 时只有起点那一刻是 1', () => {
  assert.deepEqual([11, 12, 13].map((f) => value(f, 0, { ...params, attackFrames: 0 })), [0, 1, 1]);
  assert.deepEqual([11, 12, 13].map((f) => value(f, 0, { at: 12, attackFrames: 0, holdFrames: 0, releaseFrames: 0 })), [0, 1, 0]);
});
