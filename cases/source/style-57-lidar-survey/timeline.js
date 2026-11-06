// 《火山口》 the one timeline. Picture (index.html), score + foley (mix.py via timeline.json) and the cue check read these numbers.
// 84 BPM, 4/4: one beat = 0.7142857 s, one bar = 2.857 s. Every key action sits on a beat (tools/cuecheck.py).
export const BPM = 84;
export const BEAT = 60 / BPM;
export const b = n => n * BEAT;
export const FPS = 24;
export const DUR = 463 / FPS;           // 19.2917 s = 27 beats + one frame of tail

// picture cues, in beats
export const HIT = {
  scan: 1,         // scan line enters the photo (north edge): photo -> points
  crane: 4,        // bar 2: the camera starts to crane down and tilt; "vertical x1.5" note appears
  scanEnd: 5,      // the scan leaves the south edge: the photo is gone, point counter lands
  cond: 12,        // bar 4: impact, the condensing front leaves the dome summit
  trace: 14,       // the ring crest starts to light up (traced), four marimba steps
  traceEnd: 16,
  condEnd: 16,     // bar 5: front reaches the window edge; the solid is complete
  sil: 17,         // music stops: near silence (air only)
  cut: 20,         // bar 6: THE SECTION - first sound after the silence
  cutDone: 22,     // cut plane has reached the section line; chart drawn
  roll: 22,        // reading rolls 0 -> 97
  land: 24,        // bar 7: reading lands; rising pull-back starts
  wind: 26,        // place ambience returns (L-cut to the end)
  end: 27,
};
export const T = Object.fromEntries(Object.entries(HIT).map(([k, v]) => [k, b(v)]));

// camera keys: t, target x (east), y (up, display), z (= -north), distance, heading (deg, 0 = looking north), pitch (deg down), fov
export const CAM = [
  [b(0),  -20,  90,  -30, 1300,  0, 89.5, 34],   // 1 locked nadir, slow push
  [b(4),  -15,  95,  -32, 1160, -3, 88.5, 34],   // 2 crane down + tilt + orbit begins
  [b(8),   10, 110,  -45,  990, -28, 54, 34],
  [b(12),  30, 130,  -50,  900, 20, 34, 34],     // 3 low-oblique push as the front leaves the summit (from the south-west)
  [b(16),  45, 135,  -50,  760, 34, 25, 34],
  [b(20),  48, 135,  -51,  700, 44, 24, 34],     // 4 slow push + creep round through the silence (the camera never stops)
  [b(24), 190, 150,  -64,  640, -6, 9.5, 34],    // 5 arc + push to the section, facing it from the south
  [b(27), 150, 110,  -20, 1000,  6, 33, 34],     // 6 rising pull-back
];
