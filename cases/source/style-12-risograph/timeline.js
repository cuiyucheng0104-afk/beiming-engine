// 跳水 — the single source of time. Page, score, mixer and cue check all read these numbers.
// 90 BPM: 1 beat = 2/3 s = 16 frames at 24 fps, an 8th = 8 frames, a 16th = 4 frames → every beat lands on a whole frame.
export const BPM = 90, BEAT = 60 / BPM, BAR = 4 * BEAT, FPS = 24;
export const DUR = 19.5;
export const bt = b => b * BEAT;                    // beat → seconds

// shots: [name, start beat]
export const SHOTS = [['print', 0], ['run', 5], ['flight', 12], ['freeze', 18], ['splash', 20], ['ripple', 24]];

// run-up footfalls: quarters → eighths → sixteenths (the acceleration)
export const STEPS = [5, 6, 7, 8, 8.5, 9, 9.5, 10, 10.5, 10.75, 11, 11.25, 11.5, 11.75];

// every hit point, in beats
export const HIT = {
  feed: 0,          // paper feed starts, cyan roller begins
  plateIn: 1,       // cyan plate lands: water + sun appear
  title: 2,         // 「跳水」 double-hit printed
  runCut: 5,        // cut to the run
  takeoff: 12,      // push off the platform edge (bar 4 downbeat)
  violet: 15,       // halo drops: pink body overprints the cyan sun → first violet
  freeze: 18,       // cut: time stops above the water; silence
  drip: 19,         // the one distant sound in the silence
  entry: 20,        // ENTRY: plates snap into register, violet splash, knockout 「扑通」 (bar 6 downbeat)
  drops: [21, 21.5, 22, 23],
  rippleCut: 24,    // shape match cut to top-down ripples (bar 7 downbeat)
  rings: [24, 25, 26],
  headUp: 26,       // the diver surfaces
  plateOut: 27,     // cyan plate lifted away
  final: 28,        // last beat: the wave (bar 8 downbeat)
};
// flight: a few airy turns, on the half-time grid
export const SPINS = [13, 14.5, 16];

export const shotAt = t => { let k = 0; for (let i = 0; i < SHOTS.length; i++) if (t >= bt(SHOTS[i][1]) - 1e-9) k = i; return [SHOTS[k][0], bt(SHOTS[k][1]), k]; };
