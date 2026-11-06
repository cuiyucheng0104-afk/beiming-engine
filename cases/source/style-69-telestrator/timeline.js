// 《那一脚》 timeline: the single source of time for picture, score, foley and checks.
// One beat = 14 frames at 30 fps (BPM 900/7 ≈ 128.57), so every beat and eighth lands on a whole frame.
export const FPS = 30, SRC_FPS = 25;
export const BPM = 900 / 7;
export const BEAT = 60 / BPM;                 // 0.466667 s
export const b = n => Math.round(n * 14 * 1e6) / 1e6 / FPS;   // n beats → seconds, exactly frame n×14 / 30
export const DUR = b(42.5);                   // 19.8333 s = 595 frames

// source ("match footage") times, seconds
export const SRC = { pass1: 14 / 30, recv10: 1.0, thru: 1.40, recv9: 3.10, strike: 3.78, goal: 4.36, gkLand: 4.62 };
const VS = 0.68 / b(2);                       // slow play 0.7286×: reception lands on beat 22, strike on beat 24
const VF = (SRC.goal - SRC.strike) / b(2);    // ball flight 0.621×
export const SEG = [
  { id: 'live',   t0: 0,      t1: b(6.5), cam: 'A', kind: 'play',   s0: 0,    v: 1,  mode: 'live' },
  { id: 'rew',    t0: b(6.5), t1: b(8),   cam: 'A', kind: 'rew',    s0: b(6.5), s1: 1.06, mode: 'ana' },
  { id: 'f1',     t0: b(8),   t1: b(16),  cam: 'A', kind: 'freeze', s: 1.06, mode: 'ana' },
  { id: 'slow',   t0: b(16),  t1: b(24),  cam: 'T', kind: 'play',   s0: 1.06, v: VS, mode: 'ana' },
  { id: 'f2',     t0: b(24),  t1: b(26),  cam: 'T', kind: 'freeze', s: SRC.strike, mode: 'ana' },
  { id: 'split',  t0: b(26),  t1: b(28),  kind: 'split', s1: SRC.strike, vA: .85, vB: .7, mode: 'rep' },
  { id: 'fsplit', t0: b(28),  t1: b(34),  kind: 'splitfreeze', s: SRC.strike, mode: 'rep' },
  { id: 'flight', t0: b(34),  t1: b(36),  cam: 'T', kind: 'play',   s0: SRC.strike, v: VF, mode: 'rep' },
  { id: 'goal',   t0: b(36),  t1: b(38),  cam: 'T', kind: 'play',   s0: SRC.goal, v: 1, mode: 'rep' },
  { id: 'hero',   t0: b(38),  t1: b(40),  cam: 'H', kind: 'play',   s0: 5.45, v: .6, mode: 'rep' },
  { id: 'end',    t0: b(40),  t1: DUR,    cam: 'H', kind: 'freeze', s: 5.45 + .6 * b(2), mode: 'rep' },
];
export const WIPES = [0, b(26), b(34)];       // centre of the yellow band crossing the frame
export const WIPE_D = .34;

// Key visual hits: every one must land on the beat grid (beat or eighth) and on a music hit of the same name.
export const HITS = {
  wipe_in: 0, pass1: b(1), thru_live: b(3), rewind: b(6.5),
  freeze1: b(8), ring10: b(8.5), thruLine: b(9), arrow1: b(10), ringsDef: b(10), space: b(10.5), label1: b(11), ring9: b(12), runLine: b(12.5), arrow2: b(14),
  resume: b(16), thru_slow: b(17), recv9: b(22), strike: b(24),
  wipe_split: b(26), freezeSplit: b(28), ringsSplit: b(28.5), sight: b(29), label2: b(29.5),
  cut_silence: b(33.5), wipe_back: b(34), goal: b(36), hero: b(38), title: b(38), sub: b(38.5), final: b(40),
};
export function segAt(t) { for (const s of SEG) if (t >= s.t0 - 1e-9 && t < s.t1 - 1e-9) return s; return SEG[SEG.length - 1]; }
