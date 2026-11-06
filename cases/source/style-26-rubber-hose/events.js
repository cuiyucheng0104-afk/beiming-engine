// events.js — foley events (window.EV → events.json → mix.py). Every visible action has one; all times come from timeline.js.
import { H, T, SECS } from './timeline.js';
export function buildEvents() {
  const E = [];
  const add = (t, type, o = {}) => E.push({ t: +t.toFixed(5), type, ...o });
  const B = id => SECS.find(s => s.id === id).beat;
  add(0, 'irisOpen', { d: H.pullStart });
  for (let k = 0; k < 8; k++) add(T('A', k), k % 2 ? 'tick' : 'tock');         // the clock is the metronome; the minute hand jumps on even beats
  for (const k of [1, 3, 5, 7]) add(T('A', k), 'snore', { d: B('A') * 1.6 });
  for (const k of [1, 3, 5]) add(T('B', k), 'snore', { d: B('B') * 1.4, v: .5 });
  add(H.ring, 'bell', { d: B('B') * 2.5 }); add(H.ring, 'hop'); add(T('B', 1), 'land');
  add(H.reach1, 'stretch', { d: H.grabCurtain - H.reach1 });
  add(H.grabCurtain, 'grab');
  add(H.curtainOpen, 'curtain'); add(H.curtainOpen, 'bell', { d: B('B') });
  add(H.retract1, 'zipBack');
  add(H.pillow, 'pillow');
  add(H.reach2, 'stretch', { d: H.yank - H.reach2 });
  add(H.yank, 'yank'); add(H.yank, 'bell', { d: B('B') * 1.5 }); add(H.yank + .45, 'thudSoft');
  add(H.shiver, 'shiver', { d: H.trumpet - H.shiver });
  add(H.trumpet, 'pop');
  add(H.inhale, 'inhale', { d: H.blast - H.inhale });
  add(H.blast, 'gust'); add(H.blast + .02, 'pillowFly');
  add(H.ch1, 'glyph', { i: 0 }); add(H.ch2, 'glyph', { i: 1 }); add(H.ch3, 'glyph', { i: 2 });
  for (let k = 3; k <= 11; k++) add(T('C', k), 'land', { v: .55 + .05 * (k - 3) });
  add(H.handRise, 'rise', { d: H.stop - H.handRise });
  // D: the band stop. Nothing but the projector.
  add(H.slap, 'slap'); add(H.slap, 'crunch');
  add(H.snore, 'snore', { d: B('E') * 1.4, v: .7 });
  add(H.feebleTick, 'feeble');
  add(H.peel, 'peel', { d: H.boing - H.peel }); add(H.peel, 'liftWhoosh');
  add(H.boing, 'boing'); add(H.boing, 'whistleUp', { d: .28 });
  add(H.wobble, 'boingSmall');
  add(T('F', 2), 'crouch');
  add(H.bow, 'bow');
  add(H.reachIris, 'stretch', { d: H.grabIris - H.reachIris });
  add(H.grabIris, 'grabRim'); add(H.grabIris, 'irisPull', { d: H.irisShut - H.grabIris });
  add(H.irisShut, 'irisThunk');
  for (const k of ['hop1', 'hop2', 'hop3']) add(H[k], 'wordHop');   // 剧 终 THE END land one after another, the clock hops
  add(H.wink, 'blink'); add(H.wink, 'wordHop');
  add(H.hatPop, 'hatPop');
  // cue markers (not sounds): the visual hit points, for cuecheck
  for (const [k, t] of Object.entries(H)) add(t, 'cue', { id: k });
  return E.sort((a, b) => a.t - b.t);
}
