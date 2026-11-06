// The single time source: tempo, beat grid, sections and every cue. Picture, score, foley and checks all read this.
// 72 BPM -> one beat = 0.8333 s = exactly 20 frames at 24 fps, so every beat, half beat and quarter beat lands on a whole frame.
export const BPM = 72;
export const BEAT = 60 / BPM;
export const FPS = 24;
export const b = n => n * BEAT;
export const BEATS = 23;
export const DUR = b(BEATS);           // 19.1667 s

export const SECS = [
  { id: 'dawn',    b0: 0,  b1: 5,  note: 'dark hall, the rose wakes petal by petal' },
  { id: 'phoenix', b0: 5,  b1: 11, note: 'the phoenix is lit; wings; the floor patch' },
  { id: 'fire',    b0: 11, b1: 15, note: 'fire and cracks, cutting faster' },
  { id: 'silence', b0: 15, b1: 17, note: 'shatter, then near silence' },
  { id: 'mend',    b0: 17, b1: 21, note: 'lead grows along the cracks, a weld per half beat' },
  { id: 'noon',    b0: 21, b1: 23, note: 'the whole window blazes' },
];

// cue -> beat (or list of beats)
export const CUE = {
  petals: [1, 2, 3, 3.5, 4, 4.5, 4.75],     // PETAL_GROUPS lit left to right (accelerating into the reveal)
  reveal: 5,                                // centre medallion lit: the phoenix
  flaps: [6, 7],                            // wing down-strokes land
  tiltDown: 8,                              // camera starts down the shafts
  topdown: 9,                               // top-down floor (cut inside the shaft glare)
  patchMove: 10,                            // the sun moves, the patch slides
  whip: 10.5,                               // from the floor, whip-tilt up
  ignite: 11,                               // fire lit; camera lands on the window
  cracks: [12, 13, 13.5, 14, 14.5, 14.75],  // each crack = a cut
  shatter: 15,                              // the break; music and reverb hard-stop
  firstWeld: 17,                            // the first sound after the silence
  welds: [17.5, 18, 18.5, 19, 19.5, 20, 20.5],
  carve: 20,                                // carved inscription lit by a band of light
  blaze: 21,                                // noon: the whole window
  end: 23,
};
export const T = Object.fromEntries(Object.entries(CUE).map(([k, v]) => [k, Array.isArray(v) ? v.map(b) : b(v)]));
