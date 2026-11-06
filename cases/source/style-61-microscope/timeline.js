// 一滴池塘水 · the single time source. 90 BPM, 4/4; every designed event is a beat number (b) on this grid.
export const BPM = 90, BEAT = 60 / BPM, BAR = 4 * BEAT;
export const b = n => +(n * BEAT).toFixed(6);
export const DUR = b(29.5);                       // 19.667 s
export const B = {                                // beats
  drop: 1,          // the drop lands on the slide
  dive: 4.5,        // the dive starts
  x10: 6,           // ×10  the drop fills the frame
  breath1: 7.5,     // focus breath: the eyepiece ring closes in (field A)
  x100: 9,          // ×100 field A
  breath2: 11.5,    // focus breath: A → B
  x400: 12,         // ×400 field B lands
  sweep0: 12.5, sweep1: 15,   // the focal plane crosses the frame
  ring0: 14, ring1: 15,       // the ring is drawn round the central nodule
  scan0: 15, land1: 17,       // the striae scan; reading lands
  hush: 18, first: 20,        // silence; the first sound after it (and the pull back B → A)
  count0: 21, land2: 24,      // counting starts; the count lands
  climb: 24, x1: 25.5,        // the climb back; ×1
  title: 25.5, final: 27,     // the title is written; the final chord
};
export const T = Object.fromEntries(Object.entries(B).map(([k, v]) => [k, b(v)]));
