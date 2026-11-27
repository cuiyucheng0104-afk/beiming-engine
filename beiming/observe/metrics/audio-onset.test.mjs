import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beatOnsetHit } from './audio-onset.mjs';

function pcmWindows(amplitudes, trailingSamples = 0) {
  const pcm = new Int16Array(amplitudes.length * 160 + trailingSamples);
  for (const [window, amplitude] of amplitudes.entries()) {
    for (let i = window * 160; i < (window + 1) * 160; i++) {
      pcm[i] = i % 2 ? amplitude : -amplitude;
    }
  }
  pcm.fill(32767, amplitudes.length * 160);
  return pcm;
}

test('onset hit counts repeated events and uses the union of inclusive frame windows', () => {
  const pcm = pcmWindows([0, 2000, 0, 2000, 0, 0], 159);
  const options = { fps: 100, frames: 6, eventFrames: [5, 2, 2, 0, 4] };
  const result = beatOnsetHit(pcm, options);
  assert.deepEqual(result, {
    metric: 'metric:beat.onset-hit', unit: 'ratio', value: 4 / 5,
    details: {
      hits: 4, events: 5, hitFrames: [2, 2, 0, 4], onsetsMs: [10, 30],
      randomBaseline: 5 / 6, lift: 4 / 5 - 5 / 6, baselineFrames: [0, 6],
    },
  });
});

test('onset runs use their strongest jump and minimum gap keeps the first accepted onset', () => {
  const pcm = pcmWindows([0, 16, 512, 32767, 0, 2000, 0, 2000]);
  const options = { fps: 100, frames: 10, eventFrames: [3, 5, 7], toleranceFrames: 0 };
  assert.deepEqual(beatOnsetHit(pcm, options).details.onsetsMs, [30, 50, 70]);
  const grouped = beatOnsetHit(pcm, { ...options, minGapMs: 30 });
  assert.deepEqual(grouped.details.onsetsMs, [30, 70]);
  assert.deepEqual(grouped.details.hitFrames, [3, 7]);
  assert.equal(grouped.details.randomBaseline, 2 / 10);
});

test('onset times use the video origin, drop both out-of-film peaks and include frame zero', () => {
  const pcm = pcmWindows([0, 2000, 0, 2000, 0, 2000, 0, 2000]);
  const options = { fps: '100/1', frames: 4, eventFrames: [0, 3], audioOffsetMs: -30 };
  const result = beatOnsetHit(pcm, options);
  assert.deepEqual(result.details.onsetsMs, [0, 20]);
  assert.deepEqual(result.details.hitFrames, [0, 3]);
  assert.equal(result.details.randomBaseline, 1);

  const startsLoud = pcmWindows([32767, 0]);
  assert.deepEqual(beatOnsetHit(startsLoud, { ...options, audioOffsetMs: 0 }).details.onsetsMs, []);
  assert.deepEqual(beatOnsetHit(startsLoud, { ...options, audioOffsetMs: 9 }).details.onsetsMs, []);
  assert.deepEqual(beatOnsetHit(startsLoud, { ...options, audioOffsetMs: 10 }).details.onsetsMs, [10]);
  assert.deepEqual(beatOnsetHit(startsLoud, { ...options, audioOffsetMs: 10, jump: 4 }).details.onsetsMs, []);
});

test('onset hit compares a rational frame rate with a brute-force B3 baseline', () => {
  const pcm = pcmWindows([0, 1000, 0, 500, 0, 700, 0, 1000, 0, 0, 0, 300]);
  const options = { fps: '30000/1001', frames: 25, eventFrames: [0, 2, 4, 10], toleranceFrames: 1 };
  const onsetsMs = [10, 30, 50, 70, 110];
  const hits = frame => onsetsMs.some(ms => Math.abs(frame * 1000 - ms * (30000 / 1001)) <= 1000);
  const result = beatOnsetHit(pcm, options);
  assert.deepEqual(result.details.onsetsMs, onsetsMs);
  assert.deepEqual(result.details.hitFrames, options.eventFrames.filter(hits));
  assert.equal(result.details.randomBaseline, Array.from({ length: options.frames }, (_, i) => i).filter(hits).length / options.frames);
  assert.equal(beatOnsetHit(pcm, { ...options, frames: Number.MAX_SAFE_INTEGER }).details.randomBaseline, 5 / Number.MAX_SAFE_INTEGER);

  const last = Number.MAX_SAFE_INTEGER;
  const nearEnd = beatOnsetHit(pcmWindows([0, 500, 0, 500, 0, 500]), {
    fps: 1000, frames: last, toleranceFrames: 0, audioOffsetMs: last - 51, eventFrames: [last - 1, last - 2],
  });
  assert.deepEqual(nearEnd.details.hitFrames, [last - 1]);
  assert.equal(nearEnd.details.randomBaseline, 3 / last);
});

test('onset hit returns zero for silence or no events and rejects malformed input', () => {
  const options = { fps: 30, frames: 30, eventFrames: [3] };
  const silence = beatOnsetHit(new Int16Array(320), options);
  assert.equal(silence.value, 0);
  assert.deepEqual(silence.details.onsetsMs, []);
  assert.equal(silence.details.randomBaseline, 0);
  const empty = beatOnsetHit(pcmWindows([0, 3000]), { ...options, eventFrames: [] });
  assert.equal(empty.value, 0);
  assert.equal(empty.details.events, 0);
  assert.ok(empty.details.randomBaseline > 0);

  const pcm = pcmWindows([0, 3000]);
  assert.throws(() => beatOnsetHit(Float32Array.of(0), options), TypeError);
  for (const invalid of [{ frames: 0 }, { fps: '30/0' }, { fps: true }, { eventFrames: [30] },
    { eventFrames: [-1] }, { eventFrames: Array(1) }, { eventFrames: [0.5] }, { jump: NaN },
    { minGapMs: -1 }, { toleranceFrames: -1 }, { audioOffsetMs: 0.5 }]) {
    assert.throws(() => beatOnsetHit(pcm, { ...options, ...invalid }), RangeError);
  }
});
