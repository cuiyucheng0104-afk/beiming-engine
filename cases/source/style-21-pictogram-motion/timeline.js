// 一天 · ONE DAY — the single source of time for picture, score, foley and checks.
// One tempo for the whole film (STYLE.md §5): 120 BPM, 1 beat = 0.5 s = 12 frames at 24 fps.
// The pace ladder is made by card length (4 → 2 → 1 → ½ beats), never by changing tempo.
export const BPM = 120, BEAT = 60 / BPM, FPS = 24, BAR = 4;
export const bt = (b) => +(b * BEAT).toFixed(6);

// chapters → hue keys (palette in engine.js)
export const CHAP = {
  morning: { zh: '早', en: 'MORNING' },
  noon: { zh: '午', en: 'DAYTIME' },
  dusk: { zh: '晚', en: 'EVENING' },
  night: { zh: '夜', en: 'NIGHT' },
};

// mode: lock | track (lateral long take) | scroll (vertical rows) | flash (½-beat run) | night
// tin: transition INTO this card (on its first beat)
// sfx: [u (beats from card start), type, gain] — the poses key their actions on the same u
export const CARDS = [
  { zh: '起床', en: 'WAKE UP', clock: '06:30', pk: 'gold', ch: 'morning', b0: 0, beats: 4, pose: 'wake', mode: 'lock', tin: 'open',
    sfx: [[0, 'alarm', .55], [1, 'cloth', .8], [2, 'stretch', .7]] },
  { zh: '刷牙', en: 'BRUSH', clock: '06:45', pk: 'orange', ch: 'morning', b0: 4, beats: 4, pose: 'brush', mode: 'lock', tin: 'rows',
    sfx: [[.5, 'scrub', .7], [1, 'scrub', .6], [1.5, 'scrub', .7], [2, 'scrub', .6], [2.5, 'scrub', .7], [3, 'scrub', .6], [3.5, 'rinse', .6]] },
  { zh: '跑步', en: 'RUN', clock: '07:10', pk: 'gold', ch: 'morning', b0: 8, beats: 4, pose: 'run', mode: 'lock', tin: 'cols', push: true,
    sfx: [[0, 'step', .8], [.5, 'step', .7], [1, 'step', .8], [1.5, 'step', .7], [2, 'step', .8], [2.5, 'step', .7], [3, 'step', .8], [3.5, 'zoom', .9]] },
  { zh: '地铁', en: 'COMMUTE', clock: '08:20', pk: 'orange', ch: 'morning', b0: 12, beats: 2, pose: 'subway', mode: 'track', tin: 'push',
    sfx: [[0, 'chime', .4], [.5, 'rail', .7], [.75, 'rail', .5], [1.5, 'rail', .7], [1.75, 'rail', .5]] },
  { zh: '打字', en: 'TYPE', clock: '09:30', pk: 'blue', ch: 'noon', b0: 14, beats: 2, pose: 'type', mode: 'track', tin: 'whip',
    sfx: [[.25, 'key', .6], [.5, 'key', .7], [.75, 'key', .6], [1, 'key', .7], [1.25, 'key', .6], [1.5, 'key', .7], [1.75, 'enter', .7]] },
  { zh: '开会', en: 'MEET', clock: '11:00', pk: 'blue', ch: 'noon', b0: 16, beats: 2, pose: 'meet', mode: 'track', tin: 'whip',
    sfx: [[.5, 'tap', .7], [1, 'tap', .8], [1.5, 'raise', .6]] },
  { zh: '吃饭', en: 'LUNCH', clock: '12:30', pk: 'blue', ch: 'noon', b0: 18, beats: 2, pose: 'eat', mode: 'track', tin: 'whip',
    sfx: [[.5, 'chop', .7], [1, 'clink', .7], [1.5, 'chop', .7]] },
  { zh: '骑车', en: 'RIDE', clock: '18:00', pk: 'violet', ch: 'dusk', b0: 20, beats: 1, pose: 'bike', mode: 'scroll', tin: 'scroll',
    sfx: [[.5, 'bell', .7]] },
  { zh: '买菜', en: 'SHOP', clock: '18:30', pk: 'violet', ch: 'dusk', b0: 21, beats: 1, pose: 'shop', mode: 'scroll', tin: 'scroll',
    sfx: [[.5, 'beep', .6]] },
  { zh: '做饭', en: 'COOK', clock: '19:10', pk: 'violet', ch: 'dusk', b0: 22, beats: 1, pose: 'cook', mode: 'scroll', tin: 'scroll',
    sfx: [[0, 'sizzle', .7], [.5, 'toss', .7]] },
  { zh: '洗碗', en: 'WASH UP', clock: '20:00', pk: 'violet', ch: 'dusk', b0: 23, beats: 1, pose: 'dish', mode: 'scroll', tin: 'scroll',
    sfx: [[0, 'splash', .6], [.5, 'clink', .6]] },
  { zh: '洗澡', en: 'SHOWER', clock: '20:40', pk: 'rose', ch: 'dusk', b0: 24, beats: .5, pose: 'shower', mode: 'flash', tin: 'rows', sfx: [[0, 'spray', .6]] },
  { zh: '吹头', en: 'DRY', clock: '21:00', pk: 'violet', ch: 'dusk', b0: 24.5, beats: .5, pose: 'dryer', mode: 'flash', tin: 'flip', sfx: [[0, 'whir', .5]] },
  { zh: '晾衣', en: 'HANG', clock: '21:15', pk: 'rose', ch: 'dusk', b0: 25, beats: .5, pose: 'hang', mode: 'flash', tin: 'quarter', sfx: [[0, 'hanger', .6]] },
  { zh: '浇花', en: 'WATER', clock: '21:30', pk: 'violet', ch: 'dusk', b0: 25.5, beats: .5, pose: 'plant', mode: 'flash', tin: 'cols', sfx: [[0, 'pour', .6]] },
  { zh: '喝水', en: 'DRINK', clock: '21:45', pk: 'rose', ch: 'dusk', b0: 26, beats: .5, pose: 'drink', mode: 'flash', tin: 'rows', sfx: [[0, 'gulp', .6]] },
  { zh: '拉伸', en: 'STRETCH', clock: '22:00', pk: 'violet', ch: 'dusk', b0: 26.5, beats: .5, pose: 'stretch', mode: 'flash', tin: 'flip', sfx: [[0, 'stretch', .5]] },
  { zh: '刷手机', en: 'SCROLL', clock: '22:20', pk: 'rose', ch: 'dusk', b0: 27, beats: .5, pose: 'phone', mode: 'flash', tin: 'quarter', sfx: [[0, 'tapglass', .6]] },
  { zh: '读书', en: 'READ', clock: '22:40', pk: 'violet', ch: 'dusk', b0: 27.5, beats: .5, pose: 'read', mode: 'flash', tin: 'cols', sfx: [[0, 'page', .6]] },
  { zh: '睡觉', en: 'SLEEP', clock: '23:00', pk: 'ink', ch: 'night', b0: 28, beats: 9, pose: 'sleep', mode: 'night', tin: 'iris',
    sfx: [[0, 'tick', .9], [1, 'bookclose', .7], [1, 'tick', .8], [2, 'cloth', .5], [2, 'tick', .8], [2.5, 'tick', .75], [3, 'tick', .8], [3, 'cloth', .4], [3.25, 'tock', .8]] },   // last sound before the hush: b31.25; b31.5–32 is empty
];
CARDS.forEach((c, i) => { c.n = i + 1; c.t0 = bt(c.b0); c.t1 = bt(c.b0 + c.beats); });
export const N = CARDS.length;

// night section (beats, absolute)
export const NIGHT = {
  stop: 28,          // everything cut, one tick
  close: 29,         // the book closes
  lie0: 30, lie1: 31.25,   // sit on the bed, lie down
  count0: 30, count1: 31.5,  // 0.00 → 0.99
  hush: 31.5,        // half a beat of true silence
  slam: 32,          // "1 天" — the most important sound in the film
  rowsStop: [33, 33.5, 34, 34.5, 35, 35.5],   // pattern rows stop one by one
  hudOut: [35, 36.5],
  end: 37,
};
export const DUR = bt(NIGHT.end);   // 18.5 s

// camera / transition windows (seconds relative to the cut)
export const WIN = {
  whip: [-0.09, 0.06],    // lateral long take: one screen per cut; the beat frame is the single smeared frame (≈9/10 of the way, trailing into the new station), its neighbours are at rest
  scroll: [-0.125, 0.125],// vertical row scroll
  push: [-0.25, 0.0],     // push into a motif cell, lands exactly on the cut
  card: [-0.125, 0.125],  // grid transitions between locked cards, midpoint on the beat
  flash: [-0.0625, 0.0625], // ½-beat run
  iris: [-0.125, 0.125],
};

// every event the mixer plays, generated from the cards: cut accents + foley + night cues
export function events() {
  const ev = [];
  for (const c of CARDS) {
    ev.push({ t: c.t0, type: 'cut', card: c.n, mode: c.mode, tin: c.tin, pk: c.pk, ch: c.ch, beats: c.beats });
    for (const [u, type, g] of c.sfx) ev.push({ t: bt(c.b0 + u), type, gain: g, card: c.n });
  }
  // camera moves that make a sound
  for (const c of CARDS) {
    if (c.tin === 'whip') ev.push({ t: c.t0, type: 'whoosh', gain: .8, dur: 0.34 });   // the air of the pan is longer than the move; its loudest point sits on the beat
    if (c.tin === 'scroll') ev.push({ t: c.t0, type: 'swipe', gain: .6 });
  }
  ev.push({ t: bt(NIGHT.slam), type: 'slam', gain: 1 });
  NIGHT.rowsStop.forEach((b, i) => ev.push({ t: bt(b), type: 'rowstop', gain: .5 - i * .04, row: i }));
  ev.push({ t: bt(NIGHT.hudOut[0]), type: 'hudout', gain: .4, dur: bt(NIGHT.hudOut[1] - NIGHT.hudOut[0]) });
  ev.sort((a, b) => a.t - b.t);
  return ev;
}

// all text that appears on screen (for the font subset)
export const TEXT = () => CARDS.map(c => c.zh + c.en + c.clock).join('') + Object.values(CHAP).map(c => c.zh + c.en).join('') +
  '一天ONE DAY0123456789.:/·→天 ';
