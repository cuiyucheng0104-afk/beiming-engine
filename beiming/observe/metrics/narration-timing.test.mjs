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

const emptyRoi = { frames: new Uint8Array(), width: 1, height: 1 };

test('scene ink uses the first threshold crossing and first minimum; audio uses the first audible window after 200 ms', () => {
  const counts = new Uint16Array(90).fill(100);
  counts[31] = 95;
  counts[32] = 94;
  counts[35] = counts[36] = 2;
  const pcm = new Int16Array(32000);
  pcm.fill(500, 160 * 119, 160 * 120);
  pcm.fill(500, 160 * 125);
  const v = narrationTiming(pcm, {...emptyRoi, sceneInk: {counts, pauseStartsSec: [1]}}).value;
  assert.deepEqual(v.sceneTransitions, [{ pauseStartSec: 1, fadeStartFrame: 32, fadeEndFrame: 35,
    fadeFrames: 3, nextAudibleSec: 1.25, pauseToFadeEndSec: 35 / 30 - 1, fadeEndToAudioSec: 1.25 - 35 / 30 }]);
});

test('no decline, incomplete reference and silence give missing observations', () => {
  const counts = new Uint16Array(90).fill(100);
  const v = narrationTiming(new Int16Array(32000), {...emptyRoi, sceneInk: {counts, pauseStartsSec: [0.1, 1]}}).value;
  for (const t of v.sceneTransitions) {
    assert.equal(t.fadeStartFrame, null);
    assert.equal(t.nextAudibleSec, null);
    assert.equal(t.fadeEndToAudioSec, null);
  }
});

test('three-frame motion threshold is strict; joins 0.2s gaps and splits 0.3s gaps', () => {
  const meanDifferences = [0, 3, 3, 0.6, 0.6, 0.6, 0, 3, 3, 0, 0, 0, 0, 0, 0, 1, 1, 1, 99];
  const run = d => narrationTiming(new Int16Array(), {...emptyRoi,
    regionalMotion: {meanDifferences: d, startSec: 2}}).value.motionIntervals;
  assert.deepEqual(run(meanDifferences), [{startSec: 2, endSec: 2.3}, {startSec: 2.5, endSec: 2.6}]);
  assert.deepEqual(run(new Uint8Array(10)), []);
  assert.throws(() => run([0, NaN, 2]), RangeError);
});

test('the first regional frame has no predecessor', () => {
  assert.throws(() => narrationTiming(new Int16Array(), {...emptyRoi,
    regionalMotion: { meanDifferences: [3, 0, 0], startSec: 0 }}), RangeError);
});

test('a grid anchor of 1.15 s starts listening at 1.35 s; off-grid anchors floor', () => {
  const pcm = new Int16Array(32000);
  pcm.fill(500, 134 * 160, 136 * 160);
  const value = narrationTiming(pcm, {...emptyRoi, sceneInk: {
    counts: new Uint8Array(90), pauseStartsSec: [1.1499999, 1.15, 1.159],
  }}).value;
  assert.deepEqual(value.sceneTransitions.map(s => s.nextAudibleSec), [1.34, 1.35, 1.35]);
});

test('a 1.2 s fade anchor uses reference frame 6, while the preceding fractional frame uses 5', () => {
  const counts = new Uint16Array(95).fill(100);
  counts[5] = 1000;
  const v = narrationTiming(new Int16Array(), {...emptyRoi, sceneInk: {counts, pauseStartsSec: [1.1999999, 1.2]}}).value;
  assert.deepEqual(v.sceneTransitions.map(t => t.fadeStartFrame), [20, null]);
});
