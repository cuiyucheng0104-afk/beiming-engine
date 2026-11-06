// 大桥的五十九分钟 · the single time source. Everything (picture, events, score, foley, checks) reads these beats.
// 90 BPM, 4/4, 30 fps: one beat = 0.6667 s = 20 frames; every event sits on a quarter-beat (5 frames).
(function (G) {
  const BPM = 90, FPS = 30, BEATS = 29;
  const SPB = 60 / BPM;
  const T = b => Math.round(b * SPB * FPS) / FPS;   // beat → seconds, snapped to the frame (exact for quarter-beats)
  // sections: [start beat, end beat]
  const SEC = { open: [0, 5], grid: [5, 12], mag: [12, 18], sync: [18, 20], brk: [20, 29] };
  // named visual hits (beats)
  const AT = {
    freeze: 0, ringOpen: 0.25, clockOpen: 0.5, noaaIn: 1, card0In: 1.5, sweep: 2, rewind: 3, rewind2: 4,
    grid: 5, col2: 5.5, c0930: 6.5, film: 7.5,
    mag: 12, ring: 12, loupe: 13.5, labels: 14, unfreeze: 15, accel: 15, accel2: 17,
    sync: 18, syncLine: 18, silence: 19,
    brk: 20, head: 22, c1110: 24, back: 26, badge: 28, end: 29,
  };
  // event clock keyframes: [beat, minutes after 00:00 PST on 1940-11-07]
  const CLOCK = [[0, 662], [3, 662], [5, 450], [6.5, 570], [7.5, 603], [12, 607], [18, 662], [20, 662], [24, 662], [24, 670], [29, 670]];   // S5 runs in real seconds and jumps at b24 (index.html sBreak)
  // sound / cue events (beats). type names are what mix.py understands.
  const EV = [
    { b: 0, type: 'freeze' }, { b: 0.25, type: 'pencil', d: 0.5 }, { b: 0.5, type: 'tick' },
    { b: 1, type: 'shutter' }, { b: 1, type: 'paper' },
    { b: 1.5, type: 'card', n: 7 },
    { b: 2, type: 'sweep' },
    { b: 3, type: 'rewind', d: SPB * 2 },
    { b: 4, type: 'splice' },
    { b: 5, type: 'cut' }, { b: 5, type: 'shutter' },
    { b: 5.5, type: 'shutter' }, { b: 5.5, type: 'card', n: 10 },
    { b: 6.5, type: 'snap' }, { b: 6.5, type: 'card', n: 12 },
    { b: 7.5, type: 'shutter' }, { b: 7.5, type: 'card', n: 10 },
    { b: 12, type: 'freeze' }, { b: 12, type: 'pencil', d: 0.556 }, { b: 12.5, type: 'key' },
    { b: 13.5, type: 'loupe' }, { b: 13.5, type: 'stress', d: SPB * 4.5 },
    { b: 14, type: 'paper' },
    { b: 15, type: 'unfreeze' },
    { b: 18, type: 'cut' }, { b: 18, type: 'pencil', d: 0.6 },
    { b: 19, type: 'silence' },
    { b: 20, type: 'break' }, { b: 20, type: 'card', n: 10 },
    { b: 22, type: 'paper' },
    { b: 21.5, type: 'second' }, { b: 23, type: 'second' },
    { b: 24, type: 'card', n: 10 }, { b: 24, type: 'jump' }, { b: 25.5, type: 'second' },
    { b: 26, type: 'freeze' }, { b: 26, type: 'pencil', d: 0.5 },
    { b: 28, type: 'badge' },
  ];
  G.TL = { BPM, FPS, BEATS, SPB, T, SEC, AT, CLOCK, EV, DUR: T(BEATS) };
})(typeof window !== 'undefined' ? window : globalThis);
