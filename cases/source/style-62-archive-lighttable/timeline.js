// 《十二秒》 the single timeline. 96 BPM, one beat = 0.625 s. Every key action is written in beats.
// index.html (picture), tools/export.mjs -> out/timeline.json -> mix.py (score + foley) and tools/cuecheck.py read it.
export const BPM = 96, BEAT = 60 / BPM, DUR = 19.75;
export const b = n => +(n * BEAT).toFixed(5);

// [beat] of every key action
export const BEATS = {
  flick1: 0, flick2: 0.5, lightOn: 1,      // ballast starter: two flickers, then steady
  tag1: 3,                                  // plate tag pins on
  drop1: 4,                                 // loupe lands on the negative
  develop: 5, devDone: 8,                   // develop front: negative -> positive inside the lens
  dive1: 6, inLens: 10,                     // push into the lens
  ruler: 11,                                // the ruler is laid on the ground plane
  bracket: 13,                              // "离地" caliper
  count: 16,                                // counter lands on 120 ft
  rise1: 16.25, lift1: 17,                  // rise out of the lens, loupe lifts
  glideEnd: 18,                             // both records on the table; hush
  light12: 20,                              // after the hush: card A, "12 秒" lit (the most important sound)
  cardB: 20.5,                              // card B
  underline: 21.5,                          // "Success four flights" underlined on the telegram
  dimB: 23,                                 // card B steps back
  cardsOut: 25,                             // cards wipe out, glide back to the plate
  drop2: 26,                                // loupe lands again
  enter: 28,                                // the rim has passed the frame: inside the photograph
  title: 28,                                // 十二秒
};
export const HIT = Object.fromEntries(Object.entries(BEATS).map(([k, v]) => [k, b(v)]));

// ruler ticks: [feet, beat] — 8ths, then 16ths, then 32nds into the landing (the acceleration)
export const TICKS = [
  [0, 12], [10, 12.5], [20, 13], [30, 13.5], [40, 14], [50, 14.25], [60, 14.5], [70, 14.75],
  [80, 15], [90, 15.25], [100, 15.5], [105, 15.625], [110, 15.75], [115, 15.875], [120, 16],
];
// silence window (near-silence: room tone only)
export const HUSH = [b(18), b(20)];
// Morse for "1 2" on the sounder, unit = a 16th: [beat, length in units]
const U = 0.25, MORSE = { '1': '.----', '2': '..---' };
export const SOUNDER = (() => {
  const out = []; let at = 21;                         // starts with the underline phrase
  for (const ch of ['1', '2']) {
    for (const s of MORSE[ch]) { const n = s === '.' ? 1 : 2; out.push([at, n]); at += (n + 1) * U; }
    at += 2 * U;
  }
  return out;
})();
