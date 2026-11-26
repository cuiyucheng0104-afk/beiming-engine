const WINDOW_SAMPLES = 160;
const WINDOW_MS = 10;
const SILENCE = -4;

function fpsRatio(fps) {
  if (typeof fps === 'string' && /^\d+\/\d+$/.test(fps)) {
    const [numerator, denominator] = fps.split('/').map(Number);
    if ([numerator, denominator].every(n => Number.isSafeInteger(n) && n > 0)) {
      return [BigInt(numerator), BigInt(denominator)];
    }
  }
  if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) {
    const [decimal, exponent = '0'] = String(fps).split('e');
    const [whole, fractional = ''] = decimal.split('.');
    const scale = Number(exponent) - fractional.length;
    return [BigInt(whole + fractional) * 10n ** BigInt(Math.max(0, scale)), 10n ** BigInt(Math.max(0, -scale))];
  }
  throw new RangeError('Expected a positive fps or fraction');
}

function detectOnsets(pcm, { jump, minGapMs, audioOffsetMs, inFilm }) {
  const windows = Math.floor(pcm.length / WINDOW_SAMPLES);
  if (windows > 0 && !Number.isSafeInteger(audioOffsetMs + (windows - 1) * WINDOW_MS)) {
    throw new RangeError('Audio times must be safe integer milliseconds');
  }
  const onsets = [];
  let previous = SILENCE;
  let peakWindow = -1;
  let peakJump = 0;
  function emitPeak() {
    const ms = peakWindow * WINDOW_MS + audioOffsetMs;
    if (inFilm(ms) && (!onsets.length || ms - onsets.at(-1) >= minGapMs)) onsets.push(ms);
    peakWindow = -1;
    peakJump = 0;
  }
  for (let window = 0; window < windows; window++) {
    let squares = 0;
    const start = window * WINDOW_SAMPLES;
    for (let i = start; i < start + WINDOW_SAMPLES; i++) squares += pcm[i] * pcm[i];
    const level = Math.max(SILENCE, Math.log10(Math.sqrt(squares / WINDOW_SAMPLES) / 32768));
    // With a sufficient audio delay, the first window has preceding silence on the video timeline.
    const delta = window === 0 && audioOffsetMs < WINDOW_MS ? 0 : level - previous;
    previous = level;
    if (delta > jump) {
      if (delta >= peakJump) {
        peakWindow = window;
        peakJump = delta;
      }
    } else if (peakWindow >= 0) emitPeak();
  }
  if (peakWindow >= 0) emitPeak();
  return onsets;
}

function inWindows(windows, frame) {
  let low = 0;
  let high = windows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (windows[middle][1] < frame) low = middle + 1;
    else high = middle;
  }
  return low < windows.length && windows[low][0] <= frame;
}

/** Measure event-frame hits against 16 kHz mono Int16 PCM on the video timeline. */
export function beatOnsetHit(pcm, {
  eventFrames, fps, frames, toleranceFrames = 1, jump = 0.25, minGapMs = 0, audioOffsetMs = 0,
} = {}) {
  if (!(pcm instanceof Int16Array)) throw new TypeError('Expected 16 kHz mono Int16 PCM');
  const [numerator, denominator] = fpsRatio(fps);
  if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isSafeInteger(toleranceFrames) || toleranceFrames < 0
    || !Number.isFinite(jump) || jump < 0 || !Number.isFinite(minGapMs) || minGapMs < 0 || !Number.isSafeInteger(audioOffsetMs)) {
    throw new RangeError('Invalid film length, onset tolerance, jump, gap or audio offset');
  }
  const events = Array.isArray(eventFrames) && Array.from(eventFrames);
  if (!events || events.some(frame => !Number.isSafeInteger(frame) || frame < 0 || frame >= frames)) {
    throw new RangeError('Expected a list of in-film integer event frames');
  }

  // Compare in integer time units so a rational fps cannot move an inclusive window boundary.
  const frameUnits = 1000n * denominator;
  const filmEnd = BigInt(frames) * frameUnits;
  const tolerance = BigInt(toleranceFrames) * frameUnits;
  const onsetsMs = detectOnsets(pcm, { jump, minGapMs, audioOffsetMs,
    inFilm: ms => ms >= 0 && BigInt(ms) * numerator < filmEnd,
  });
  const windows = [];
  for (const ms of onsetsMs) {
    const onset = BigInt(ms) * numerator;
    const start = onset <= tolerance ? 0 : Number((onset - tolerance + frameUnits - 1n) / frameUnits);
    const end = Math.min(frames - 1, Number((onset + tolerance) / frameUnits));
    if (start > end) continue;
    const previous = windows.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = end;
    else windows.push([start, end]);
  }
  const coveredFrames = windows.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
  const hitFrames = events.filter(frame => inWindows(windows, frame));
  const hitRate = events.length ? hitFrames.length / events.length : 0;
  const randomBaseline = coveredFrames / frames;
  return { metric: 'metric:beat.onset-hit', unit: 'ratio', value: hitRate,
    details: { hits: hitFrames.length, events: events.length, hitFrames, onsetsMs, randomBaseline,
      lift: hitRate - randomBaseline, baselineFrames: [0, frames] },
  };
}
