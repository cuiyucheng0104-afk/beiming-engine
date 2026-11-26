import assert from 'node:assert/strict';
import test from 'node:test';
import { narrationTiming } from './narration-timing.mjs';

const width = 20, height = 6;
function measure(pcm, pattern) {
  const frames = Uint8Array.from({length: width * height * pattern.length}, (_, i) =>
    pattern[Math.floor(i / (width * height))] === 'x' ? 109 : 110);
  return narrationTiming(pcm, { frames, width, height }).value;
}

test('25 quiet windows qualify, 24 do not; trailing silence has no following onset', () => {
  const pcm = new Int16Array(160 * 77 + 19).fill(185);
  pcm.fill(184, 0, 25 * 160);
  pcm.fill(0, 26 * 160, 50 * 160);
  pcm.fill(0, 52 * 160);
  const v = measure(pcm, '...');
  assert.deepEqual(v.pauses, [{ startSec: 0, durationSec: 0.25 }, { startSec: 0.52, durationSec: 0.25 }]);
  assert.deepEqual(v.onsetsSec, [0.25]);
});

test('debounce allows a change on the seventh frame; blank ends align with audio', () => {
  const pattern = '...xxxx...xxxxxxxxxx...';
  const pcm = new Int16Array(16000);
  pcm.fill(200, 160 * 33);
  const v = measure(pcm, pattern);
  assert.deepEqual(v.changeFrames, [3, 10, 20]);
  assert.deepEqual(v.blanks, [{ startFrame: 0, endFrame: 3 }, { startFrame: 7, endFrame: 10 },
    { startFrame: 20, endFrame: 23 }]);
  assert.equal(v.alignment.candidates, 1);
  assert.equal(v.alignment.matches.length, 1);
  assert.ok(Math.abs(v.alignment.medianSec - 1 / 300) < 1e-12);
  assert.equal(measure(new Int16Array(16000), pattern).alignment.matches.length, 0);
});

test('appearance exactly 400 ms from a voice onset is outside the matching window', () => {
  const pcm = new Int16Array(16000);
  pcm.fill(200, 160 * 30);
  const v = measure(pcm, '...xxxxxxxxxxxxxxx...xxxxxxx...');
  assert.equal(v.blanks[1].endFrame, 21);
  assert.equal(v.alignment.candidates, 1);
  assert.deepEqual(v.alignment.matches, []);
  assert.equal(v.alignment.medianSec, null);
});

test('rejects incompatible samples, ROI sizes and incomplete frames', () => {
  const input = { frames: new Uint8Array(11), width: 3, height: 2 };
  assert.throws(() => narrationTiming(new Uint8Array(), input), TypeError);
  assert.throws(() => narrationTiming(new Int16Array(), input), RangeError);
  assert.throws(() => narrationTiming(new Int16Array(), {...input, width: 0}), RangeError);
});

test('two blank frames do not split a caption and six-frame jitter is suppressed', () => {
  const v = measure(new Int16Array(), '...xxxxxx..xxxxxxxxx');
  assert.deepEqual(v.blanks, [{ startFrame: 0, endFrame: 3 }]);
  assert.deepEqual(v.changeFrames, [3, 11]);
});

test('matches the only blank when both ends of a clip already show captions', () => {
  const pcm = new Int16Array(16000);
  pcm.fill(200, 30 * 160);
  const v = measure(pcm, 'xxxxxx...xxxx');
  assert.deepEqual(v.blanks, [{ startFrame: 6, endFrame: 9 }]);
  assert.equal(v.alignment.candidates, 1);
  assert.deepEqual(v.alignment.matches, [{ appearFrame: 9, onsetSec: 0.3, offsetSec: 0 }]);
});
