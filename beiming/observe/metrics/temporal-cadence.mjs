import { deliverSpec, readSignalFrames } from './video-audio.mjs';

async function signal(file, filter, tag) {
  const values = [];
  await readSignalFrames(file, filter + ',format=yuv444p,signalstats', (frame, tags) => {
    const value = tags.get('lavfi.signalstats.' + tag);
    if (frame !== values.length || !Number.isFinite(value)) throw new Error('Missing ' + tag + ' at frame ' + frame);
    values.push(value);
  });
  return values;
}

export async function regionalFlicker(filePath, { startFrame = 1 } = {}) {
  if (!Number.isSafeInteger(startFrame) || startFrame < 0) throw new RangeError('Invalid startFrame');
  const value = {};
  try {
    for (const [region, name] of ['left', 'center', 'right'].entries()) {
      const left = 'floor(iw*' + region + '/3)';
      const right = 'floor(iw*' + (region + 1) + '/3)';
      const samples = await signal(filePath, 'crop=' + right + '-' + left + ':ih:' + left + ':0:exact=1', 'YAVG');
      const hits = [];
      for (let i = Math.max(1, startFrame); i + 1 < samples.length; i++) {
        const before = samples[i] - samples[i - 1];
        const after = samples[i] - samples[i + 1];
        const jump = Math.min(Math.abs(before), Math.abs(after));
        if (jump > 8 && Math.sign(before) === Math.sign(after) && Math.abs(before - after) < jump / 2) hits.push(i);
      }
      value[name] = hits;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { metric: 'metric:regionalFlicker', unit: 'frames', value: null, details: { code: 'tool-missing', tool: error.path } };
  }
  return { metric: 'metric:regionalFlicker', unit: 'frames', value, details: { startFrame } };
}

function upperMedian(numbers) {
  numbers.sort((a, b) => a - b);
  return numbers[Math.floor(numbers.length / 2)] ?? null;
}

export async function onTwosCadence(filePath, { cuts = [], crop } = {}) {
  const metric = 'metric:onTwosCadence';
  const unit = 'ratio';
  const spec = await deliverSpec(filePath);
  if (!spec.value) return { metric, unit, value: null, details: spec.details };
  const { fps, width, height, frames } = spec.value;
  if (fps !== 30) throw new RangeError('Expected a 30 fps edit of 24 fps source frames');
  if (!Array.isArray(cuts) || cuts.some((n, i) => !Number.isSafeInteger(n) || n <= (cuts[i - 1] ?? 0) || n >= frames)) {
    throw new RangeError('Expected strictly increasing interior cut frames');
  }
  let filter = 'null';
  if (crop) {
    const { x, y, width: w, height: h } = crop;
    if (![x,y,w,h].every(Number.isSafeInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) {
      throw new RangeError('Invalid crop');
    }
    filter = 'crop=' + [w,h,x,y].join(':');
  }
  let diffs;
  try { diffs = await signal(filePath, filter, 'YDIF'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { metric, unit, value: null, details: { code: 'tool-missing', tool: error.path } };
  }
  const phases = Array.from({length: 5}, () => []);
  const value = [];
  let start = 0;
  for (const end of [...cuts, diffs.length]) {
    const odd = [], even = [];
    for (let n = start + 1; n < end; n++) {
      phases[n % 5].push(diffs[n]);
      const previous = Math.floor((n - 1) * 4 / 5);
      if (previous === Math.floor(n * 4 / 5)) continue;
      (previous % 2 ? odd : even).push(diffs[n]);
    }
    const oddToEven = upperMedian(odd), evenToOdd = upperMedian(even);
    const ratio = oddToEven === null || evenToOdd === null ? null : oddToEven / Math.max(0.01, evenToOdd);
    value.push({start, end, oddToEven, evenToOdd, ratio});
    start = end;
  }
  return { metric, unit, value, details: { phaseMedians: phases.map(upperMedian),
    phaseOneRepeats: phases[1].filter(d => d < 0.1).length, phaseOneFrames: phases[1].length } };
}
