const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function estimateWindow(pcm, start, size, minLag, maxLag) {
  let energy = 0;
  for (let i = start; i < start + size; i++) energy += pcm[i] ** 2;
  if (energy <= 100 * size) return null;

  const first = minLag - 1;
  const last = Math.min(maxLag + 1, pcm.length - start - size);
  const scores = new Float64Array(last - first + 1);
  for (let lag = first; lag <= last; lag++) {
    let product = 0;
    let shiftedEnergy = 0;
    for (let i = start; i < start + size; i++) {
      const shifted = pcm[i + lag];
      product += pcm[i] * shifted;
      shiftedEnergy += shifted * shifted;
    }
    scores[lag - first] = product / Math.sqrt(energy * shiftedEnergy + 1e-9);
  }

  let bestLag = null;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const i = lag - first;
    const score = scores[i];
    const left = scores[i - 1], right = scores[i + 1];
    if (score <= 0.85 || score < left || (lag < maxLag && score < right)) continue;

    // Fit the peak position, then measure correlation on the fractionally shifted PCM.
    // Interpolating only the peak height biases the comparison between different periods.
    let peak = score;
    if (right !== undefined && score >= right && left + right < 2 * score) {
      const delta = (right - left) / (2 * (2 * score - left - right));
      const neighbor = Math.sign(delta);
      const fraction = Math.abs(delta);
      let product = 0;
      let shiftedEnergy = 0;
      for (let k = start; k < start + size; k++) {
        const sample = pcm[k + lag];
        const shifted = sample + fraction * (pcm[k + lag + neighbor] - sample);
        product += pcm[k] * shifted;
        shiftedEnergy += shifted * shifted;
      }
      peak = Math.max(score, product / Math.sqrt(energy * shiftedEnergy + 1e-9));
    }
    if (peak > bestScore + 1e-6) {
      bestScore = peak;
      bestLag = lag;
    }
  }
  return bestLag;
}

// Estimate pitch on an explicitly selected solo passage of signed 16-bit mono PCM.
export function pitchF0(pcm, { sampleRate, startSec, endSec } = {}) {
  if (!(pcm instanceof Int16Array)) throw new TypeError('Expected signed 16-bit mono PCM');
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 900) throw new RangeError('Expected sampleRate >= 900 Hz');
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 ||
      endSec <= startSec || endSec > pcm.length / sampleRate) throw new RangeError('Invalid solo interval');

  const size = Math.floor(0.04 * sampleRate);
  const minLag = Math.floor(sampleRate / 450);
  const maxLag = Math.floor(sampleRate / 150);
  const noteCounts = {};
  const deviations = [];
  let minHz = Infinity;
  let maxHz = 0;
  let analyzedFrames = 0;
  for (let t = startSec; t + 0.04 < endSec; t += 0.02) {
    const start = Math.floor(t * sampleRate);
    // Every candidate lag needs a complete shifted window at the end of the PCM.
    if (start + size + maxLag > pcm.length) break;
    analyzedFrames++;
    const lag = estimateWindow(pcm, start, size, minLag, maxLag);
    if (lag === null) continue;
    const hz = sampleRate / lag;
    minHz = Math.min(minHz, hz);
    maxHz = Math.max(maxHz, hz);
    const midi = 69 + 12 * Math.log2(hz / 440);
    const semitone = Math.round(midi);
    const note = NOTES[semitone % 12] + (Math.floor(semitone / 12) - 1);
    noteCounts[note] = (noteCounts[note] ?? 0) + 1;
    deviations.push(100 * Math.abs(midi - semitone));
  }
  deviations.sort((a, b) => a - b);
  const voicedFrames = deviations.length;
  return {
    metric: 'metric:pitch.f0', unit: 'Hz',
    value: {
      voicedFrames, frequencyRangeHz: voicedFrames ? [minHz, maxHz] : null, noteCounts,
      absoluteCents: voicedFrames ? {
        median: deviations[Math.floor(voicedFrames / 2)],
        p95: deviations[Math.floor(voicedFrames * 0.95)],
        max: deviations[voicedFrames - 1],
        within25Fraction: deviations.filter(cents => cents <= 25).length / voicedFrames,
      } : null,
    },
    details: { sampleRate, startSec, endSec, analyzedFrames },
  };
}
