// T−15 · the single source of time for picture, sound and checks.
// Film time f (s). Countdown T = f − T0. 60 BPM: one beat = one second = one tick; beat k sits at f = k.
const TL = {
  FPS: 30, DUR: 19.8, T0: 15.0, BPM: 60,
  // re-layouts (whole beats)
  MCC_OPEN: 1.0,          // T−14: the control room opens full frame (same window, not frame-synced)
  GRID: 2.0,              // T−13: 3×3 grid, clock to the centre, seven standby slots
  // the grid fills on the count: one camera per tick (whole beats)
  OPEN: { v8: 3, pao: 4, fair: 5, srm: 6, flag: 7, gantry: 8, mlp: 9 },
  // hard digital punch-ins (whole beats)
  PUNCH: { mlp: 10, pao: 11 },
  // the picture assembles: each cell wipes to its own tile of camera 913, accelerating: triplets in beat 12, sextuplets in beat 13
  // (every swap lands on a whole film frame at 30 fps: 1/3 s = 10 frames, 1/6 s = 5 frames)
  SWAP: [['v8', 12.0], ['pao', 12 + 1 / 3], ['fair', 12 + 2 / 3], ['srm', 13.0], ['flag', 13 + 1 / 6], ['gantry', 13 + 2 / 6], ['mlp', 13.5], ['mcc', 13 + 4 / 6]],
  SILENCE: [14.05, 15.0], // after the T−1 tick: one silent beat
  MERGE: 15.0,            // T−0: many into one + clock inversion + control strip FLIGHT
  CUT: 17.0,              // T+2: hard cut to the wide shot
  TICKS: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19],
  // event flags (land on whole beats)
  FLAGS: [
    { id: 'hboi', cell: 'v8', t0: 3.0, t1: 7.7, zh: '氢燃尽点火器', en: 'H2 IGNITERS · T−12' },
    { id: 'rs25', cell: 'mlp', t0: 9.0, t1: 13.5, zh: 'RS-25 ×4 启动', en: 'ENGINE START · T−6.36' },
    { id: 'srb', cell: 'full', t0: 16.0, t1: 99, zh: '助推器点火', en: 'SRB ×2 · T−0' }
  ],
  // camera frame ranges (film frames come from tools/prep.sh; material/sync.json holds the source mapping)
  CAMS: { mcc: [0.9, 14.05], v8: [2.9, 12.45], pao: [3.9, 12.95], fair: [4.9, 13.45], srm: [5.9, 13.65], flag: [6.9, 13.85],
          gantry: [7.9, 13.95], mlp: [8.9, 14.05], hero: [11.9, 17.1], cs5: [16.9, 19.9] }
};
if (typeof module !== 'undefined') module.exports = TL;
if (typeof window !== 'undefined') window.TL = TL;
