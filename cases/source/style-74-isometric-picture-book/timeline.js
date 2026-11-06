// 面包店的早晨 — the one timeline. Picture (film.js), score + foley (mix.py, via events.json) and the cue check all read it.
// 100 BPM, 4/4: beat 0.6 s = 18 frames, eighth 0.3 s = 9 frames, eighth-triplet 0.2 s = 6 frames at 30 fps,
// so every hit below lands exactly on a frame.
export const FPS = 30, BPM = 100, BEAT = 60 / BPM, BAR = 4 * BEAT;
const r3 = x => Math.round(x * 1000) / 1000;
export const at = (bar, beat = 1, sub = 0) => r3((bar - 1) * BAR + (beat - 1) * BEAT + sub);   // bar.beat (+ seconds)
export const DUR = at(9, 2);   // 8 bars + one beat of ring-out = 19.8 s

export const T = {
  title: [at(1, 2), at(1, 2, .2), at(1, 2, .4)],        // 清 晨 6:00 land on triplets
  lampOff: at(1, 4),
  lid0: at(2, 1), wall0: at(2, 2), lidFlat: at(2, 3), wall1: at(2, 3, .3), lidGone: at(3, 1),
  groove: at(3, 1),
  lights: [at(3, 2), at(3, 3), at(3, 4)],                 // order lighting: table, oven, shelf
  w1: [at(4, 1), at(4, 1, .2)], knead: [at(4, 1), at(4, 2)],
  walk1: [at(4, 2, .3), at(5, 1)], arrow1: [at(4, 2, .3), at(4, 3, .3)],
  w2: [at(5, 1), at(5, 1, .2)], ovenOpen: at(5, 1), ovenDing: at(5, 2),
  walk2: [at(5, 2), at(5, 4, .3)], arrow2: [at(5, 2), at(5, 3)],
  shelf: at(5, 4, .3), w3: [at(5, 4, .3), at(5, 4, .5)],
  hush0: at(6, 1), hush1: at(6, 3),                       // the silence
  twitch: [at(6, 2, -.2), at(6, 2)],                      // the first chair hops in the silence (lift, drop back)
  chairs: [at(6, 3), at(6, 4), at(7, 1), at(7, 1, .3), at(7, 2), at(7, 2, .2), at(7, 2, .4), at(7, 3)],
  climax: at(7, 3),
  flip: at(8, 1), spot: at(8, 2), walk3: [at(8, 2), at(9, 1)], door: at(8, 3), arrive: at(9, 1),
};
// footfalls on eighths (a walk from a to b: strikes at a + 0.3k, k = 1..n, the last one is the stop)
export const steps = ([a, b]) => { const s = []; for (let t = a + .3; t <= b + 1e-6; t += .3) s.push(r3(t)); return s; };
export const STEPS = { baker1: steps(T.walk1), baker2: steps(T.walk2), guest: steps(T.walk3) };

// the event list for the mixer and the cue check (sound = what the picture shows at that frame)
export function EVENTS() {
  const E = [];
  const e = (t, type, o = {}) => E.push({ t: r3(t), type, ...o });
  T.title.forEach((t, i) => e(t, 'type', { k: i, word: 'title', big: i < 2 ? 1 : 1, num: i === 2 ? 1 : 0 }));
  e(T.lampOff, 'lamp');
  e(T.lid0, 'lid_up'); e(T.wall0, 'walls'); e(T.lidFlat, 'lid_flat'); e(T.lidFlat + .1, 'lid_glide');
  T.lights.forEach((t, i) => e(t, 'light', { k: i }));
  T.lights.forEach((t, i) => e(t, 'type', { k: 0, word: 'n' + (i + 1), num: 1, accent: 1 }));
  T.w1.forEach((t, i) => e(t, 'type', { k: i, word: 'w1' }));
  T.knead.forEach((t, i) => e(t, 'knead', { k: i }));
  e(T.walk1[0], 'lift');
  STEPS.baker1.forEach((t, i) => e(t, 'step', { who: 'baker', k: i }));
  e(T.arrow1[0], 'arrow', { k: 0 });
  T.w2.forEach((t, i) => e(t, 'type', { k: i, word: 'w2' }));
  e(T.ovenOpen, 'oven_open'); e(T.ovenDing, 'oven_ding');
  STEPS.baker2.forEach((t, i) => e(t, 'step', { who: 'baker', k: i }));
  e(T.arrow2[0], 'arrow', { k: 1 });
  e(T.shelf, 'shelf');
  T.w3.forEach((t, i) => e(t, 'type', { k: i, word: 'w3' }));
  e(T.hush0, 'hush'); e(T.twitch[0], 'twitch_up'); e(T.twitch[1], 'twitch'); e(T.hush1, 'hush_end');
  T.chairs.forEach((t, i) => e(t, 'chair', { k: i }));
  e(T.flip, 'flip'); e(T.spot, 'spot');
  STEPS.guest.forEach((t, i) => e(t, 'step', { who: 'guest', k: i }));
  e(T.door, 'chime'); e(T.arrive, 'arrive');
  E.sort((a, b) => a.t - b.t);
  E.unshift({ t: 0, type: 'timeline', BPM, BEAT, BAR, FPS, DUR, T });
  return E;
}
