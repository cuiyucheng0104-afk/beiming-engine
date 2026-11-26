import assert from 'node:assert/strict';
import test from 'node:test';
import { pitchF0 } from './audio-pitch.mjs';

const sampleRate = 16000;
const pcm = Int16Array.from({ length: sampleRate }, (_, i) =>
  i < sampleRate / 2 ? 0 : Math.round(4000 * Math.sin(2 * Math.PI * i / 80)));

test('200 Hz solo tone in the selected time slice', () => {
  const { metric, unit, value, details } = pitchF0(pcm, { sampleRate, startSec: 0.5, endSec: 1 });
  assert.equal(metric, 'metric:pitch.f0');
  assert.equal(unit, 'Hz');
  assert.ok(value.voicedFrames > 20);
  assert.equal(value.voicedFrames, details.analyzedFrames);
  assert.deepEqual(value.frequencyRangeHz, [200, 200]);
  assert.deepEqual(value.noteCounts, { G3: value.voicedFrames });
  const cents = 100 * Math.abs(69 + 12 * Math.log2(200 / 440) - 55);
  assert.deepEqual(value.absoluteCents, { median: cents, p95: cents, max: cents, within25Fraction: 0 });
});

test('silence, low energy and short slices yield an empty pitch summary', () => {
  for (const [audio, endSec] of [[pcm, 0.4], [new Int16Array(16000).fill(10), 1], [pcm, 0.04]]) {
    const { value } = pitchF0(audio, { sampleRate, startSec: 0, endSec });
    assert.deepEqual(value, { voicedFrames: 0, frequencyRangeHz: null, noteCounts: {}, absoluteCents: null });
  }
});

test('requires signed mono samples and a bounded, explicit solo interval', () => {
  const opts = { sampleRate, startSec: 0, endSec: 1 };
  assert.throws(() => pitchF0(new Uint8Array(16000), opts), TypeError);
  for (const invalid of [{}, { ...opts, sampleRate: 0 }, { ...opts, startSec: -1 },
    { ...opts, endSec: 1.1 }, { ...opts, endSec: 0 }, { ...opts, endSec: NaN }]) {
    assert.throws(() => pitchF0(pcm, invalid), RangeError);
  }
});

function measureTone(signal) {
  const samples = Int16Array.from({ length: sampleRate }, (_, i) =>
    Math.round(4000 * signal(2 * Math.PI * i / sampleRate)));
  return pitchF0(samples, { sampleRate, startSec: 0, endSec: 0.5 });
}

test('upper-register sine waves retain their first period across sampling phases', () => {
  for (const hz of [300, 317, 333, 375, 415, 440, 450]) {
    const { value, details } = measureTone(t => Math.sin(hz * t + 0.71));
    assert.equal(value.voicedFrames, details.analyzedFrames);
    for (const estimate of value.frequencyRangeHz) {
      assert.ok(Math.abs(estimate / hz - 1) < 0.016, `${hz} Hz measured as ${estimate}`);
    }
    if (hz === 440) assert.deepEqual(value.noteCounts, { A4: value.voicedFrames });
  }
});

test('a strong second harmonic does not displace a resolvable fundamental', () => {
  const { value, details } = measureTone(t => Math.sin(200 * t) * 0.18 + Math.sin(400 * t));
  assert.deepEqual(value.noteCounts, { G3: details.analyzedFrames });
});

test('both public entry points forward the three audio measurements', async () => {
  const [metrics, observe] = await Promise.all([import('./index.mjs'), import('../index.mjs')]);
  for (const name of ['beatOnsetHit', 'pitchF0', 'avSameFrame']) {
    assert.equal(typeof metrics[name], 'function');
    assert.equal(observe[name], metrics[name]);
  }
});
