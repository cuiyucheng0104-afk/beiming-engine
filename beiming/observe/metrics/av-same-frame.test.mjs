import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avSameFrame } from './av-same-frame.mjs';

function pcmFromLevels(levels) {
  return Int16Array.from(levels.flatMap(level => [level, -level]));
}

test('reports exact-frame overlap over visual-low frames with separate segment baselines', () => {
  const visualCounts = new Uint32Array([100, 100, 100, 100, 20, 30, 999, 30, 10, 10, 10, 2, 3]);
  const pcm = pcmFromLevels([1000, 1000, 1000, 1000, 100, 100, 0, 2000, 2000, 2000, 2000, 4000, 2000]);
  const result = avSameFrame(visualCounts, pcm, {
    samplesPerFrame: 2,
    segments: [[0, 6], [7, 13]],
  });
  assert.equal(result.metric, 'metric:av.same-frame');
  assert.equal(result.unit, 'ratio');
  assert.equal(result.value, 1 / 2);
  assert.equal(result.details.hits, 1);
  assert.deepEqual(result.details.visualLowFrames, [4, 11]);
  assert.deepEqual(result.details.audioQuietFrames, [4, 5]);
  assert.deepEqual(result.details.hitFrames, [4]);
  const [first, second] = result.details.segments;
  assert.deepEqual(first.range, [0, 6]);
  assert.equal(first.visualMedian, 100);
  assert.equal(first.audioMedianDb, 20 * Math.log10(1000 / 32768));
  assert.deepEqual(first.hitFrames, [4]);
  assert.deepEqual(second.range, [7, 13]);
  assert.equal(second.visualMedian, 10);
  assert.equal(second.audioMedianDb, 20 * Math.log10(2000 / 32768));
  assert.deepEqual(second.hitFrames, []);
  assert.equal(second.peakAudioFrame, 11);
  assert.equal(second.peakAudioDb, 20 * Math.log10(4000 / 32768));
});

test('rejects a one-frame offset in either direction without crossing segment boundaries', () => {
  const visual = [10, 10, 1, 10, 10, 1, 10, 10, 10, 10];
  const segments = [[0, 5], [5, 10]];
  for (const [audioQuietFrames, hits] of [
    [[2, 5], [2, 5]],
    [[1, 4], []],
    [[3, 6], []],
  ]) {
    const pcm = pcmFromLevels(visual.map((_, i) => audioQuietFrames.includes(i) ? 100 : 1000));
    const result = avSameFrame(visual, pcm, { samplesPerFrame: 2, segments });
    assert.deepEqual(result.details.hitFrames, hits);
    assert.equal(result.value, hits.length / 2);
  }
});

test('uses upper median, strict thresholds and finite dBFS for silence', () => {
  const result = avSameFrame([0, 3, 10, 10], pcmFromLevels([0, 0, 0, 0]), {
    samplesPerFrame: 2,
    segments: [[0, 4]],
    audioDropDb: 0,
  });
  assert.equal(result.details.segments[0].visualMedian, 10);
  assert.equal(result.details.segments[0].audioMedianDb, 20 * Math.log10(1 / 32768));
  assert.deepEqual(result.details.visualLowFrames, [0]);
  assert.deepEqual(result.details.audioQuietFrames, []);
  assert.equal(result.value, 0);

  const flat = avSameFrame([0, 0], pcmFromLevels([0, 0]), { samplesPerFrame: 2, segments: [[0, 2]] });
  assert.equal(flat.value, null);
  assert.deepEqual(flat.details.visualLowFrames, []);
});

test('rejects invalid visual counts, PCM and incomplete or overlapping windows', () => {
  const opts = { samplesPerFrame: 2, segments: [[0, 2]] };
  const pcm = new Int16Array(4);
  const sparse = new Array(2);
  sparse[0] = 1;
  assert.throws(() => avSameFrame(sparse, pcm, opts), RangeError);
  assert.throws(() => avSameFrame([1, -1], pcm, opts), RangeError);
  assert.throws(() => avSameFrame([1, 2], [0, 0, 0, 0], opts), TypeError);
  assert.throws(() => avSameFrame([1, 2], new Int16Array(3), opts), RangeError);
  assert.throws(() => avSameFrame([1, 2], pcm, { ...opts, samplesPerFrame: 1.5 }), RangeError);
  assert.throws(() => avSameFrame([1, 2], pcm, { ...opts, segments: [[0, 2], [1, 2]] }), RangeError);
  assert.throws(() => avSameFrame([1, 2], pcm, { ...opts, segments: [[0, 3]] }), RangeError);
  assert.throws(() => avSameFrame([1, 2], pcm, { ...opts, visualFraction: 1.1 }), RangeError);
  assert.throws(() => avSameFrame([1, 2], pcm, { ...opts, audioDropDb: -1 }), RangeError);
});
