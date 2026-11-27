function upperMedian(values) {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function frameLevelDb(pcm, frame, samplesPerFrame) {
  const start = frame * samplesPerFrame;
  const end = start + samplesPerFrame;
  let squares = 0;
  for (let i = start; i < end; i++) squares += pcm[i] ** 2;
  return 20 * Math.log10(Math.max(Math.sqrt(squares / samplesPerFrame), 1) / 32768);
}

function measureSegment(visualCounts, pcm, start, end, samplesPerFrame, visualFraction, audioDropDb) {
  const levels = [];
  for (let frame = start; frame < end; frame++) levels.push(frameLevelDb(pcm, frame, samplesPerFrame));
  const visualMedian = upperMedian(Array.from(visualCounts.slice(start, end)));
  const audioMedianDb = upperMedian([...levels]);
  const visualThreshold = visualMedian * visualFraction;
  const quietThresholdDb = audioMedianDb - audioDropDb;
  const visualLowFrames = [];
  const audioQuietFrames = [];
  const hitFrames = [];
  let peakAudioFrame = start;
  for (let frame = start; frame < end; frame++) {
    const level = levels[frame - start];
    const low = visualCounts[frame] < visualThreshold;
    const quiet = level < quietThresholdDb;
    if (low) visualLowFrames.push(frame);
    if (quiet) audioQuietFrames.push(frame);
    if (low && quiet) hitFrames.push(frame);
    if (level > levels[peakAudioFrame - start]) peakAudioFrame = frame;
  }
  return {
    range: [start, end], visualMedian, audioMedianDb, visualThreshold, quietThresholdDb,
    visualLowFrames, audioQuietFrames, hitFrames, peakAudioFrame, peakAudioDb: levels[peakAudioFrame - start],
  };
}

/** Measure exact-frame overlap between low visual counts and quiet mono PCM in half-open intervals. */
export function avSameFrame(visualCounts, pcm, {
  samplesPerFrame, segments, visualFraction = 0.3, audioDropDb = 2,
} = {}) {
  if (!Array.isArray(visualCounts) && !ArrayBuffer.isView(visualCounts)) {
    throw new TypeError('Expected an array of visual counts');
  }
  if (!Number.isSafeInteger(visualCounts.length) || visualCounts.length === 0) {
    throw new RangeError('Expected at least one visual frame');
  }
  for (const count of visualCounts) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid visual count');
  }
  if (!(pcm instanceof Int16Array)) throw new TypeError('Expected signed 16-bit mono PCM');
  if (!Number.isSafeInteger(samplesPerFrame) || samplesPerFrame < 1
      || !Number.isFinite(visualFraction) || visualFraction <= 0 || visualFraction > 1
      || !Number.isFinite(audioDropDb) || audioDropDb < 0) {
    throw new RangeError('Invalid PCM window size or threshold');
  }
  if (!Array.isArray(segments) || segments.length === 0) throw new RangeError('Expected at least one segment');
  const availableFrames = Math.floor(pcm.length / samplesPerFrame);
  let previousEnd = 0;
  const measurements = [];
  for (const segment of segments) {
    if (!Array.isArray(segment) || segment.length !== 2) throw new RangeError('Expected [start, end) segments');
    const [start, end] = segment;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previousEnd || end <= start
        || end > visualCounts.length || end > availableFrames) {
      throw new RangeError('Expected ordered non-overlapping segments covered by complete video and PCM frames');
    }
    measurements.push(measureSegment(visualCounts, pcm, start, end, samplesPerFrame, visualFraction, audioDropDb));
    previousEnd = end;
  }
  const visualLowFrames = measurements.flatMap(segment => segment.visualLowFrames);
  const audioQuietFrames = measurements.flatMap(segment => segment.audioQuietFrames);
  const hitFrames = measurements.flatMap(segment => segment.hitFrames);
  return {
    metric: 'metric:av.same-frame', unit: 'ratio',
    value: visualLowFrames.length ? hitFrames.length / visualLowFrames.length : null,
    details: { hits: hitFrames.length, visualLowFrames, audioQuietFrames, hitFrames, segments: measurements },
  };
}
