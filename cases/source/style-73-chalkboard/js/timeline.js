// The single time source of the film: tempo, frame grid and the beat of every cue.
// Picture (film.js), score and foley (mix.py, via events.json) and the cue check (cuecheck.py) all read these numbers.
export const BPM = 108, FPS = 30, BEAT = 60 / BPM;
// a beat number → seconds, snapped to the frame grid (30 fps: one beat = 16.67 frames, so every cue sits on a frame)
export const tq = b => Math.round(b * BEAT * FPS) / FPS;
export const DUR = 19.9;

// every visual hit, by beat (4/4, b0 = bar 1 beat 1)
export const B = {
  // A · the triangle (close, push in)
  legA: 0, legB: 1, hyp: 2, rightAngle: 3, labA: 4, labB: 4.5, labC: 5,
  // B · three squares grow, two are filled orange (pull back)
  sqA: 6, sqB: 7, sqC: 8, fillA: 9.5, fillB1: 10.5, fillB2: 11.125,
  // C · cracked into cells, two chalk paths, 24 cells slide in, accelerating
  crack: [12, 12.25, 12.5, 12.75, 13, 13.25], paths: 13.5,
  land: [15, 16, 16.5, 17, 17.5, 18, 18.25, 18.5, 18.75, 19, 19.25, 19.5, 19.75, 20,
         20.125, 20.25, 20.375, 20.5, 20.625, 20.75, 20.875, 21, 21.125, 21.25],
  // silence · the last cell lifts off and glides, slowing down
  hush: 21.5, lastLift: 21.5,
  // the peak: the 25th cell drops into the centre of c²  (bar 7, beat 1)
  peak: 24,
  // E · whip to the right board, the equation, the pupil's circle, the lesson's name
  whip: 25.5, eqA: 26, eqPlus: 26.75, eqB: 27, eqEq: 27.75, eqC: 28, circle: 28.5, title: 29,
  // F · the name is finished in the close shot; then the pull to the wall; the damp cloth wipes the proof
  // (entering from the seam side while the camera is still settling); the streak dries; the bell
  pull: 32, pullEnd: 33.25, wipe0: 32.5, wipe1: 34.25, close: 34.25, bell: 34.75,
};
