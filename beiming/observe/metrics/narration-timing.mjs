// 16 kHz signed mono PCM, 30 fps one-byte grayscale caption ROI, shared time origin.
const WINDOW = 160;
const QUIET_ENERGY = WINDOW * 32768 ** 2 * 10 ** (-45 / 10);

function readPauses(pcm) {
  const pauses = [], onsetWindows = [];
  const count = Math.floor(pcm.length / WINDOW);
  let quiet = 0;
  for (let i = 0; i <= count; i++) {
    if (i < count) {
      let energy = 0;
      for (let k = i * WINDOW; k < (i + 1) * WINDOW; k++) energy += pcm[k] ** 2;
      if (energy < QUIET_ENERGY) {
        quiet++;
        continue;
      }
    }
    if (quiet >= 25) {
      pauses.push({ startSec: (i - quiet) / 100, durationSec: quiet / 100 });
      if (i < count) onsetWindows.push(i);
    }
    quiet = 0;
  }
  return { pauses, onsetWindows };
}

function readCaptions(frames, width, height) {
  const size = width * height;
  const count = frames.length / size;
  const changeFrames = [], blanks = [];
  if (count === 0) return { changeFrames, blanks };
  let prev = new Uint32Array(Math.ceil(width / 2));
  let next = new Uint32Array(prev.length);
  let previousInk = 0, blankLength = 0, lastChange = -7;
  for (let i = 0; i < count; i++) {
    let ink = 0;
    next.fill(0);
    let pixel = i * size;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++, pixel++) {
        if (frames[pixel] >= 110) continue;
        ink++;
        if (x % 2 === 0) next[x / 2]++;
      }
    }
    let change = 0;
    for (let x = 0; x < next.length; x++) change += Math.abs(next[x] - prev[x]);
    if (i > 0 && i - lastChange > 6 && change > Math.max(40, Math.max(ink, previousInk) / 8)) {
      changeFrames.push(i);
      lastChange = i;
    }
    if (ink < 20) blankLength++;
    else {
      if (blankLength >= 3) blanks.push({ startFrame: i - blankLength, endFrame: i });
      blankLength = 0;
    }
    previousInk = ink;
    [prev, next] = [next, prev];
  }
  if (blankLength >= 3) blanks.push({ startFrame: count - blankLength, endFrame: count });
  return { changeFrames, blanks };
}

function align(blanks, onsets, videoFrames) {
  const interior = blanks.filter(({ startFrame, endFrame }) => startFrame > 0 && endFrame < videoFrames);
  const matches = [];
  let nearest = 0;
  for (const { endFrame } of interior) {
    if (onsets.length === 0) break;
    // 300 ticks/second puts both clocks on integers and keeps the 0.4 s boundary exact.
    const appear = endFrame * 10;
    while (nearest + 1 < onsets.length &&
      Math.abs(appear - onsets[nearest + 1] * 3) < Math.abs(appear - onsets[nearest] * 3)) nearest++;
    const delta = appear - onsets[nearest] * 3;
    if (Math.abs(delta) < 120) {
      matches.push({ appearFrame: endFrame, onsetSec: onsets[nearest] / 100, offsetSec: delta / 300 });
    }
  }
  const offsets = matches.map(m => m.offsetSec).sort((a, b) => a - b);
  return { candidates: interior.length, matches, medianSec: offsets[Math.floor(offsets.length / 2)] ?? null,
    minSec: offsets[0] ?? null, maxSec: offsets.at(-1) ?? null };
}

export function narrationTiming(pcm, { frames, width, height, sampleRate = 16000, fps = 30 } = {}) {
  if (!(pcm instanceof Int16Array) || !(frames instanceof Uint8Array)) throw new TypeError('Expected Int16 PCM and Uint8 ROI');
  if (sampleRate !== 16000 || fps !== 30) throw new RangeError('Expected 16 kHz audio and 30 fps video');
  const size = width * height;
  if (![width, height, size].every(n => Number.isSafeInteger(n) && n > 0) || frames.length % size !== 0) {
    throw new RangeError('Invalid caption ROI dimensions or incomplete frame');
  }
  const videoFrames = frames.length / size;
  const { pauses, onsetWindows } = readPauses(pcm);
  const { blanks, changeFrames } = readCaptions(frames, width, height);
  return { metric: 'metric:narration.timing', unit: 's',
    value: { pauses, onsetsSec: onsetWindows.map(i => i / 100), changeFrames, blanks, alignment: align(blanks, onsetWindows, videoFrames) },
    details: { sampleRate, fps, width, height, audioWindows: Math.floor(pcm.length / WINDOW), videoFrames } };
}
