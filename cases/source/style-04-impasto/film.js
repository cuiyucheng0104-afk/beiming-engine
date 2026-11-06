// 红色自行车 — shots. Every frame is repainted from strokes; only what the story moves, moves.
import { Impasto, Strokes, hex } from './engine/impasto.js';
import { T, DUR, WORLD, camera, skyCam, bikePose, bikeX, riderState, wheelAngle, crankAngle, lightAt, events, SCRAPES } from './timeline.js';
import { buildSky, buildField, buildFringe, buildScrapes, buildSun, fieldRev } from './scene.js';
import { drawBike, spray } from './bike.js';

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const ss = k => { k = clamp(k); return k * k * (3 - 2 * k); };
const SKY_TINT = [.95, .99, 1.05], FIELD_TINT = [1.04, .98, .9];   // overcast sky cool grey; field grey-brown

let E, P = {}, dyn;
export async function setup(canvas) {
  E = new Impasto(canvas, { W: 1920, H: 1080, ss: 2 }); dyn = new Strokes(4096);
  const sky = buildSky(), field = buildField();
  P.sky = { b: E.batch(sky.strokes.data()), tex: E.texture(sky.ref.ctx.canvas), w: sky.w, h: sky.h };
  P.field = { b: E.batch(field.strokes.data()), tex: E.texture(field.ref.ctx.canvas), w: field.w, h: field.h };
  P.scr = E.batch(buildScrapes().data()); P.sun = E.batch(buildSun().data());
  P.fringe = E.batch(buildFringe().data());
  window.DUR = DUR; window.EV = events();
  window.STATS = { sky: sky.strokes.n, field: field.strokes.n };
  return frame;
}

function frame(t) {
  const cam = camera(t), scam = skyCam(t, cam);
  const L = lightAt(t);
  E.begin([.42, .38, .33]);
  // ---- sky: overcast grey until the knife opens it
  const so = { t, cam: scam, grey: 1, reveal: 0, revDur: .22, tint: SKY_TINT, run: .6 };
  E.under(P.sky.tex, P.sky.w, P.sky.h, { ...so, reveal: T.scrape1, revC: [2560, 1000, 2200] });
  E.draw(P.sky.b, { ...so, hgt: .75, widMul: 1.15 });   // wider sky strokes overlap: raking light lands on ridges, not in gaps
  E.draw(P.scr, { t, cam: scam, grey: 0, appear: 0, appDur: .16, run: .45, hgt: .5 });   // low ridges: the knife ends don't read as cracks under the raking light
  E.draw(P.sun, { t, cam: scam, grey: 0, appear: 0, appDur: .2, run: .3, hgt: .25 });
  // ---- field
  // the gold re-lay freezes on the brake cut (9.375): nothing spreads behind him during the silence
  const tf = t >= T.brake && t < T.scrape1 ? T.stop + .9 : t;   // at the cut his trail is already finished; then nothing moves
  const fo = { t: tf, cam, grey: 1, reveal: 0, revDur: .26, tint: FIELD_TINT, run: .7 };
  E.under(P.field.tex, P.field.w, P.field.h, { ...fo, t, reveal: T.scrape1 + .2, revC: [3690, 1100, 2400] });
  E.draw(P.field.b, fo);
  // ---- the opening knife: one fat stroke of grey paint pressed in (macro), stays in the field
  dyn.push({ x: 640, y: 1840, ang: -1.36, len: 260, wid: 92, c: hex('#d6a442'), c2: hex('#9a6a24'), type: 0, seed: 4.2, hgt: 1.7, skew: .5, rev: fieldRev(640, 1840) });
  E.drawNow(dyn.data(), { t: tf, cam, grey: 1, reveal: 0, revDur: .26, tint: FIELD_TINT, appear: 0, appDur: .38, run: .9 }); dyn.clear();
  // ---- wheel spray of gold paint
  if (t > T.enter - .2 && t < T.stop + .6) {
    spray(dyn, t, bikeX, WORLD.ROAD, T.enter - .6, T.brake + .2, 22);
    if (dyn.n) E.drawNow(dyn.data(), { t, cam, grey: 0, run: 0 }); dyn.clear();
  }
  // ---- the bicycle
  const bp = bikePose(t), rs = riderState(t);
  const dark = t >= T.away ? ss(seg(t, T.away, T.away + .8)) * .9 : ss(seg(t, T.rake - .3, T.rake + .6)) * .35;
  drawBike(dyn, bp.x, bp.y, bp.s, { wheel: wheelAngle(t), crank: crankAngle(t), stand: rs.stand, foot: rs.foot, head: rs.head, lean: bp.ang - rs.brakeLean * .03 + rs.foot * -.035, dark, time: t, speed: t < T.stop ? 600 : 0 },
    { bike: 0, rider: T.scrape1 + .1, jaw: T.lookUp + .12 });
  const fade = 1 - ss(seg(t, T.last - .6, T.last));   // swallowed by the sun
  E.drawNow(dyn.data(), { t, cam, grey: 1, reveal: 0, revDur: .3, tint: FIELD_TINT, run: 0, alpha: fade, hgt: bp.s < .5 ? .6 : 1 }); dyn.clear();
  // ---- near stalks in front of the wheels
  E.draw(P.fringe, { t: tf, cam, grey: 1, reveal: 0, revDur: .26, tint: FIELD_TINT, run: .2 });
  E.finish({ ...L, norm: 3.2, shin: 24, ao: 1.2, vig: .26, contrast: 1.04, weave: .1, ground: [.42, .38, .33], lightCol: [1, .92, .78] });
}
