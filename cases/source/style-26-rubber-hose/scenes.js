// scenes.js — one continuous bedroom; the story state is a function of time, the shots only choose the camera.
import * as T from './toon.js';
import { P, clock, CLK, bugle, sleeperHead, sleeperArm, curledBody, pillow, quilt, nightstand, bed, curtain, frameProp, slippers, fatGlyph } from './chars.js';
import { paintBedroom, drawBG, FLOOR_Y, NS, BED_X, WIN } from './bg.js';
import { clamp, lerp, seg, ss, eio, eo, ei, back, spring, hash, TAU } from '/core/lib.js';
import { H, T as TB, beatsAt, shotAt, DUR, secAt } from './timeline.js';
import { glove } from './parts.js';

let BG = null, sg = null;
export function initScenes(g) { sg = g; T.init(sg.canvas); BG = paintBedroom(); T.init(sg.canvas); }

const CLK_X = NS.x, CLK_Y = FLOOR_Y - 214;          // clock stands on the nightstand top
const DIAL = [CLK_X, CLK_Y + CLK.cy];                // dial centre in world
const HEAD = [1212, 642], SHOULDER = [1292, 666];
const twos = t => Math.floor(t * 12 + 1e-6) / 12;
const between = (t, a, b) => t >= a && t < b;
const B144 = 5 / 12, B180 = 1 / 3;

// —— breathing: an extreme on every beat, all props in phase, frozen on the band stop ——
// the dance peak: from danceMax the whole room moves at full tilt (×3 of the opening amplitude and more), easing off as the hand rises
function danceBoost(t) { const tt = Math.min(t, H.stop - 1e-4); return 1 + .55 * ss(seg(tt, H.danceMax - 1 / 24, H.danceMax)) * (1 - .45 * ss(seg(tt, H.handRise, H.handTop))); }
function breathAmp(t) {
  if (t < H.ring) return .05;
  if (t < H.trumpet) return .06;
  if (t < H.stop) return lerp(.08, .15, ss(seg(t, H.blast, H.danceMax))) * danceBoost(t);
  if (t < H.slap) return .15 * danceBoost(t);
  if (t < H.boing) return .015;
  if (t < H.irisShut) return .055;
  return .07;   // the end roundel breathes harder on the beat
}
function breathPhase(t) { const tt = between(t, H.stop, H.slap) ? H.stop - 1e-4 : t; return Math.cos(TAU * beatsAt(tt)); }
const breath = (t, k = 1) => 1 + breathAmp(t) * k * breathPhase(t);
// a hop on every beat (used when the room dances in the bugle section)
function hop(t) { if (!between(t, H.blast, H.slap)) return 0; const tt = t >= H.stop ? H.stop - 1e-4 : t, b = beatsAt(tt); return Math.pow(Math.abs(Math.sin(Math.PI * b)), .7) * ss(seg(tt, H.blast, H.danceMax)) * danceBoost(tt); }

// —— cameras ——
function camera(t) {
  const sh = shotAt(t)[1];
  if (sh === 'open') {
    const u = eio(seg(t, H.pullStart, H.pullEnd));
    return { x: lerp(DIAL[0], 1010, u), y: lerp(DIAL[1], 640, u), z: Math.exp(lerp(Math.log(2.9), Math.log(1.25), u)) };   // ends on a medium-full: the clock ≈ 1/3 of the frame height
  }
  if (sh === 'ring') {   // medium, truck left with the arm, truck back
    const go = ss(seg(t, H.reach1, H.grabCurtain)), back_ = ss(seg(t, H.curtainOpen + .1, H.cutBed - .05));
    return { x: lerp(lerp(880, 600, go), 820, back_), y: 600, z: 1.5 };
  }
  if (sh === 'bed') return { x: 1390, y: 650, z: lerp(1.0, 1.04, seg(t, H.cutBed, H.trumpet)) };
  if (sh === 'bugle') { const u = eio(seg(t, H.trumpet, H.handRise)); return { x: lerp(1060, 1110, u), y: lerp(600, 545, u), z: lerp(1.12, 1.52, u) }; }
  if (sh === 'slap') {
    // wide enough for the whole glove and the sleeper's roll-over, then a fast push onto the pancake for its feeble tick
    const k = Math.exp(-(t - H.slap) * 7), f = Math.floor(t * 24), p = eo(seg(t, H.snore + B144 * .5, H.feebleTick));
    return { x: lerp(1045, 925, p) + (hash(f * 1.3) - .5) * 30 * k, y: lerp(720, 770, p) + (hash(f * 2.7) - .5) * 40 * k + 14 * k, z: lerp(1.6, 2.1, p) + .04 * seg(t, H.feebleTick, H.boing) };
  }
  // boing: tilt up with the rise, then hold for the bow and the iris
  const u = eo(seg(t, H.boing, H.wobble + .1));
  return { x: lerp(930, 920, u), y: lerp(660, 585, u), z: lerp(1.75, 1.42, u) };
}
const W2S = (c, x, y) => [960 + (x - c.x) * c.z, 540 + (y - c.y) * c.z];
function setCam(c) { T.BASE.splice(0, 6, c.z, 0, 0, c.z, 960 - c.x * c.z, 540 - c.y * c.z); T.reset(); }

// —— the clock's acting, as a function of character time ——
function clockState(t) {
  const st = { x: CLK_X, y: CLK_Y, t, minutes: 420, eyes: { type: 'open', lx: 0, ly: 0 }, mouth: { type: 'smile' }, armL: { x: -150, y: -128, hand: 'open', bend: 18 }, armR: { x: 150, y: -128, hand: 'open', bend: -18 } };
  const b = breath(t); st.sy = b; st.sx = 2 - b;
  if (t < H.ring) {   // countdown 6:56 → 6:59, ticking eyes
    const k = Math.floor(beatsAt(t) + 1e-6); st.minutes = 416 + Math.floor(k / 2);
    st.eyes.lx = k % 2 ? .55 : -.25; st.eyes.ly = k % 2 ? -.6 : .2;
    st.armL = { x: -128, y: -96, hand: 'fist', bend: 26 }; st.armR = { x: 128, y: -96, hand: 'fist', bend: -26 };
    if (t > TB('A', 6)) { st.eyes = { type: 'wide', lx: .3, ly: -.8 }; st.mouth = { type: 'grin' }; }
    return st;
  }
  if (t < H.cutBed) {
    const jump = Math.sin(Math.PI * clamp((t - H.ring) / B144)) * 70;
    st.y -= jump; st.ring = 1; st.handSpin = 0; st.eyes = { type: 'wide', lx: -.6 }; st.mouth = { type: 'open', open: .7 };
    st.legL = { x: -54, y: jump > 5 ? -16 : 0 }; st.legR = { x: 54, y: jump > 5 ? -16 : 0 };
    // left arm: stretch to the curtain edge, hold, yank, spring back
    const sh = [-(CLK.R - 14), CLK.cy + 18];
    const target = [(WIN.x0 + 178 - CLK_X) / st.sx, (430 - st.y) / st.sy];
    const reach = ss(seg(t, H.reach1, H.grabCurtain)), yank = seg(t, H.curtainOpen, H.curtainOpen + B144 * .5), ret = spring(seg(t, H.retract1 - .1, H.cutBed) * 2.2);
    let gx = lerp(-150, target[0], reach), gy = lerp(-128, target[1], reach);
    if (t >= H.curtainOpen) { gx = lerp(target[0] + 170 * ei(yank), -150, t >= H.retract1 - .1 ? ret : 0); gy = lerp(target[1] + 20 * yank, -128, t >= H.retract1 - .1 ? ret : 0); }
    const mid = [(sh[0] + gx) / 2, Math.min(sh[1], gy) - 90 * reach * (1 - (t >= H.retract1 - .1 ? ret : 0))];
    st.armL = { x: gx, y: gy, hand: t >= H.grabCurtain && t < H.retract1 ? 'grab' : 'open', via: [mid], rot: Math.PI + .2, flip: false };
    if (between(t, H.grabCurtain, H.curtainOpen)) { st.legL = { x: -64, y: 0, bend: -14 }; st.legR = { x: 64, y: 0, bend: 14 }; st.eyes = { type: 'squeeze', side: 1 }; st.mouth = { type: 'grin' }; }   // anticipation
    if (t >= H.curtainOpen) { st.ring = t < H.retract1 ? 1 : 0; st.lean = -.06; st.eyes = { type: 'open', lx: 1, ly: .2 }; st.mouth = { type: 'smile' }; }
    return st;
  }
  if (t < H.trumpet) {   // the blanket yank
    st.eyes = { type: 'open', lx: 1, ly: .3 }; st.mouth = { type: 'smile' };
    const sh = [CLK.R - 14, CLK.cy + 18];
    const tgt = [(1830 - CLK_X) / st.sx, (712 - CLK_Y) / st.sy];
    const reach = ss(seg(t, H.reach2, H.yank - B144 * .2)), yank = eo(seg(t, H.yank, H.yank + B144 * .6)), ret = ss(seg(t, H.shiver, H.shiver + B144 * 1.5));
    let gx = lerp(150, tgt[0], reach), gy = lerp(-128, tgt[1], reach);
    if (t >= H.yank) { gx = lerp(tgt[0], -230, yank); gy = lerp(tgt[1], -300, yank); gx = lerp(gx, 150, ret); gy = lerp(gy, -128, ret); }
    const lift = 160 * reach * (1 - ret);
    st.armR = { x: gx, y: gy, hand: between(t, H.yank - B144 * .2, H.shiver) ? 'grab' : 'open', via: [[(sh[0] + gx) * .45, Math.min(sh[1], gy) - lift]], flip: true };
    if (between(t, H.yank - B144 * .5, H.yank)) { st.eyes = { type: 'squeeze', side: -1 }; st.mouth = { type: 'grin' }; }
    if (between(t, H.yank, H.shiver)) { st.lean = .08; st.mouth = { type: 'grin' }; st.eyes = { type: 'happy' }; }
    if (t >= H.shiver) { st.eyes = { type: 'open', lx: .9, ly: 0, lid: .35 }; st.mouth = { type: 'frown' }; st.brows = 'angry'; }
    return st;
  }
  if (t < H.slap) {   // the bugle
    const tt = t >= H.stop ? H.stop - 1e-4 : t;
    const inh = ss(seg(tt, H.inhale, H.blast)), note = between(tt, H.blast, H.stop) ? Math.exp(-((beatsAt(tt) * 2) % 1) * 3) : 0;
    const k = 1 + inh * .14 - (tt >= H.blast ? .1 : 0) + note * .05;
    st.sx = (2 - breath(tt)) * k; st.sy = breath(tt) * k * (1 - note * .03);
    st.y -= hop(tt) * 26;
    st.cheeks = tt >= H.inhale ? lerp(1, 1.5, inh) + note * .25 : 0;
    st.mouth = { type: tt >= H.inhale ? 'none' : 'grin' };
    st.eyes = tt >= H.blast ? { type: 'squeeze', side: 1 } : { type: 'open', lx: .6 };
    if (tt >= H.blast && Math.floor(beatsAt(tt)) % 2) st.eyes = { type: 'happy' };
    st.brows = tt >= H.blast ? 'up' : null;
    const pop_ = back(seg(tt, H.trumpet, H.trumpet + .12), 2.5);
    st.armR = { x: 64, y: CLK.cy + 52, hand: 'grab', bend: 30, front: true, rot: -.2 };
    st.armL = { x: -60, y: CLK.cy + 70, hand: 'grab', bend: -30, front: true, rot: .2 };
    st.bugle = { k: pop_, flare: 1 + note * .35 };
    st.lean = -.04 - note * .03;
    if (t >= H.stop) { st.eyes = { type: 'wide', lx: .25, ly: -1 }; st.cheeks = 1.1; st.brows = 'up'; }   // the band stops: eyes up at the hand
    return st;
  }
  if (t < H.boing) {   // pancake
    st.sx = lerp(1.95, 1.82, ss(seg(t, H.slap, H.snore))); st.sy = lerp(.17, .23, ss(seg(t, H.slap, H.snore))) + .04 * Math.exp(-(t - H.slap) * 9) * Math.cos((t - H.slap) * 60);
    st.eyes = { type: 'x' }; st.mouth = { type: 'wavy', open: .5 }; st.bellFlop = 1; st.armL = { x: -165, y: -40, hand: 'open', bend: 10 }; st.armR = { x: 165, y: -40, hand: 'open', bend: -10 };
    if (t >= H.feebleTick) {   // the feeble tick: the dial shudders and the eyes squeeze out on stalks
      const u = t - H.feebleTick, sh = Math.exp(-u * 5);
      st.x += (Math.floor(t * 24) % 2 ? 7 : -7) * sh; st.handSpin = Math.sin(u * 70) * .25 * sh;
      st.popEyes = Math.min(1.12, back(clamp(u / (3 / 24)), 2.6)) * (1 - ss(seg(t, H.boing - 2 / 24, H.boing)));
      st.eyeJit = Math.sin(u * 30) * .3 * sh;
      st.sy *= 1 + .12 * sh * Math.cos(u * 50);
    }
    if (t >= H.peel) { const u = ss(seg(t, H.peel, H.boing)); st.sy = lerp(st.sy, .34, u); st.sx = lerp(st.sx, 1.6, u); st.lean = -.12 * u; }
    st.legL = { x: -60, y: 0 }; st.legR = { x: 60, y: 0 };
    return st;
  }
  // boing back, bow, grab the iris
  const u = t - H.boing;
  const s = u < 2 / 24 ? lerp(.34, 1.5, u * 12) : 1 + .5 * Math.exp(-u * 5) * Math.cos((u - 2 / 24) * 22);
  st.sy = s * breath(t); st.sx = 1 / Math.sqrt(s) * (2 - breath(t));
  st.bellFlop = Math.max(0, .9 * Math.exp(-u * 4) * Math.cos(u * 18));
  st.eyes = u < B144 ? { type: 'wide', lx: 0, ly: -.3 } : { type: 'open', lx: .1, ly: .1 };
  st.mouth = { type: u < B144 ? 'o' : 'grin' };
  st.handSpin = u < B144 * 2 ? (1 - u / (B144 * 2)) * 6 : 0;
  if (between(t, TB('F', 2), H.bow)) { st.sy *= .86; st.sx *= 1.08; st.lean = -.05; }   // anticipation: rock back
  if (between(t, H.bow, H.reachIris)) {   // a deep bow toward the camera (~35°, pivot = the feet): the top foreshortens and comes closer
    const k = back(seg(t, H.bow, H.bow + 3 / 24), 1.8) * (1 - ss(seg(t, H.reachIris - 2 / 24, H.reachIris)));
    st.sy *= 1 - .3 * k; st.sx *= 1 + .14 * k; st.k = 1 + .06 * k; st.lean = 0; st.bellFlop = -.75 * k;
    st.eyes = { type: 'happy' }; st.mouth = { type: 'smile', w: 44 }; st.handSpin = 0;
    st.armR = { x: lerp(150, -40, k), y: lerp(-128, CLK.cy + 80, k), hand: 'open', bend: 24, front: true, rot: Math.PI };            // across the belly
    st.armL = { x: lerp(-150, -300, k), y: lerp(-128, -150, k), hand: 'open', bend: 34, rot: Math.PI + .5 };                      // swept out, palm open
    st.legL = { x: -52, y: 0 }; st.legR = { x: 52, y: 0 };
  }
  st.irisArm = t >= H.reachIris;
  if (t >= H.irisShut) {
    st.eyes = { type: 'open', lx: .1, ly: .1, winkR: t >= H.wink && t < H.wink + B144 * 1.5 }; st.mouth = { type: 'grin' };
    const bb = beatsAt(t) - beatsAt(H.irisShut);
    if (bb >= 1) { const ph = bb % 1; st.y -= Math.pow(Math.sin(Math.PI * ph), .9) * 14; const c = Math.exp(-ph * 10); st.sy *= 1 - .07 * c; st.sx *= 1 + .07 * c; }
    if (t >= H.hatPop) { const u = clamp((t - H.hatPop) / (B144 * .85)); st.bellLift = Math.sin(Math.PI * u) * 46; st.bellFlop = -.35 * Math.sin(Math.PI * u) + (u >= 1 ? .18 * Math.exp(-(t - H.hatPop - B144 * .85) * 9) : 0); st.eyes = { type: 'wide', lx: 0, ly: -.9 }; st.mouth = { type: 'o' }; }
  }
  return st;
}

// —— the sleeper's state ——
function sleeperState(t) {
  const s = { snore: .5 + .5 * Math.cos(Math.PI * beatsAt(Math.min(t, between(t, H.stop, H.slap) ? H.stop : t))), pillowOver: 0, quilt: 1, curled: 0, capBlow: 0, arm: null, shiv: 0, rot: -.18 };
  if (t >= H.pillow) s.pillowOver = ss(seg(t, H.pillow, H.pillow + B144 * .7));
  if (between(t, H.pillow, H.pillow + B144 * .9)) { const u = ss(seg(t, H.pillow, H.pillow + B144 * .7)); s.arm = { hand: [lerp(1300, HEAD[0] - 40, u), lerp(690, HEAD[1] - 70 * u, u)], type: 'grab', ang: -2.4, k: 1.3 }; }
  if (t >= H.yank) { s.quilt = 0; s.curled = 1; }
  if (between(t, H.yank, H.yank + .45)) s.quiltFly = seg(t, H.yank, H.yank + .45);
  if (between(t, H.shiver, H.trumpet + 1e-3)) { s.shiv = (Math.floor(t * 12) % 2 ? 4 : -4); s.snore = .2; }
  if (t >= H.blast && t < H.slap) { s.capBlow = 1; s.pillowOver = 0; s.pillowFly = seg(t, H.blast, H.blast + .5); }
  if (t >= H.blast) s.pillowGone = true;
  if (between(t, H.blast, H.slap)) { const tt = Math.min(t, H.stop - 1e-4); s.shiv = Math.sin(beatsAt(tt) * Math.PI * 2) * 6; s.rot = -.18 + Math.sin(beatsAt(tt) * Math.PI) * .05 - hop(tt) * .05; }
  // the slap arm: rise behind the clock, hold, smash, pat, retract
  if (between(t, H.handRise, H.slap)) {
    const tt = Math.min(t, H.stop), u = back(seg(tt, H.handRise, H.handTop), 1.4);
    s.arm = { hand: [lerp(1300, 990, u), lerp(690, 300, u)], type: 'open', ang: lerp(-1.6, -2.6, u), k: lerp(1.4, 2.3, u), via: [[lerp(1290, 1130, u), lerp(660, 570, u)]] };
  }
  if (between(t, H.slap, H.boing)) {
    const lift = t >= H.peel ? ei(seg(t, H.peel, H.boing)) : 0, pat = between(t, H.snore, H.snore + B144) ? Math.sin(Math.PI * seg(t, H.snore, H.snore + B144 * .6)) * 14 : 0;
    const hx = lerp(CLK_X + 190, 1300, lift), hy = lerp(CLK_Y - 50, 300, lift) - pat;
    s.arm = { hand: [hx, hy], type: 'open', ang: Math.PI + .08, k: 2.4, flip: true, via: [[lerp(1180, 1300, lift), lerp(600, 500, lift)]] };
    const rl = seg(t, H.snore, H.snore + 4 / 12);   // t is already on twos: 4 drawings
    s.rot = -.1 + .62 * eio(rl); s.hx = 54 * eio(rl); s.hy = -46 * Math.sin(Math.PI * rl); s.hsq = 1 - .1 * Math.sin(Math.PI * rl);
    s.snore = t >= H.snore ? .5 + .5 * Math.cos(Math.PI * beatsAt(t)) : .2;
  }
  return s;
}

// —— draw the world ——
function drawWorld(t, tc, cam) {
  const g = sg;
  // background (squashes around the floor line at the dance peak)
  const sq = between(t, H.blast, H.slap) ? (breathPhase(t)) * .018 * ss(seg(Math.min(t, H.stop), H.blast, H.danceMax)) * danceBoost(t) * danceBoost(t) : 0;   // ≈ ±4.3% at the peak
  drawBG(g, BG, cam, sq, FLOOR_Y);
  setCam(cam); T.frame(tc); setCam(cam);
  const bp = breath(tc), hp_ = hop(tc);
  frameProp(1660, 300 - hp_ * 20, breath(tc, .8));
  // curtains (the yank opens both panels; they sway on the beat)
  const open = t < H.curtainOpen ? 0 : clamp(eo(seg(t, H.curtainOpen, H.curtainOpen + 3 / 24)) + .08 * Math.exp(-(t - H.curtainOpen) * 4) * Math.sin((t - H.curtainOpen) * 18));
  const sway = (bp - 1) * 4 + (t >= H.curtainOpen ? .4 * Math.exp(-(t - H.curtainOpen) * 3) : 0);
  curtain(WIN.x0 - 130, WIN.y0 - 66, 330, 560, { open, dir: 1, sway });
  curtain(WIN.x1 + 130, WIN.y0 - 66, 330, 560, { open, dir: -1, sway });
  if (open > 0) { T.g.setTransform(1, 0, 0, 1, 0, 0); g.save(); g.setTransform(cam.z, 0, 0, cam.z, 960 - cam.x * cam.z, 540 - cam.y * cam.z); g.globalAlpha = .16 * clamp(open); g.fillStyle = '#FFFFFF'; g.beginPath(); g.moveTo(WIN.x0, WIN.y0); g.lineTo(WIN.x1, WIN.y0); g.lineTo(1850, FLOOR_Y + 60); g.lineTo(1150, FLOOR_Y + 60); g.closePath(); g.fill(); g.restore(); }
  // bed + sleeper
  const S_ = sleeperState(tc), bedHop = hp_ * 22;
  T.push(); T.translate(0, -bedHop);
  bed(BED_X, FLOOR_Y, breath(tc, .6));
  if (!S_.pillowGone && S_.pillowOver < .5) pillow(HEAD[0] - 10, HEAD[1] + 26, 190, 62, -.04);
  if (S_.pillowGone && !S_.pillowFly) pillow(HEAD[0] - 10, HEAD[1] + 26, 190, 62, -.04);
  if (S_.curled) curledBody(1440, 706, { shiv: S_.shiv });
  if (S_.quilt) quilt(1262, 660, { len: 650 });
  sleeperHead(HEAD[0] + S_.shiv * .5 + (S_.hx || 0), HEAD[1] + (S_.hy || 0), { t: tc, snore: S_.snore, rot: S_.rot, capBlow: S_.capBlow, sx: 2 - (S_.hsq || 1), sy: S_.hsq || 1 });
  if (S_.pillowOver >= .5 && !S_.pillowGone) pillow(HEAD[0] + 6, HEAD[1] - 26, 200, 70, -.25 + S_.shiv * .01, 1.05);
  if (S_.pillowFly != null && S_.pillowFly < 1) { const u = S_.pillowFly; pillow(HEAD[0] + 260 * u, HEAD[1] - 40 - 340 * u + 300 * u * u, 200, 70, -.25 + u * 4, 1); }
  if (S_.arm && !between(tc, H.handRise, H.boing)) sleeperArm(SHOULDER, S_.arm.hand, S_.arm);
  T.pop();
  if (S_.quiltFly != null) { const u = eo(S_.quiltFly); quilt(lerp(1262, 560, u), lerp(660, 260, u) - Math.sin(u * Math.PI) * 160, { len: 650, rot: -u * 1.4, sx: 1 - .3 * u, sy: 1 - .2 * u }); }
  // nightstand + slippers + clock
  T.push(); T.translate(0, -hp_ * 26);
  nightstand(NS.x, FLOOR_Y, breath(tc, .7));
  T.pop();
  slippers(1250, FLOOR_Y + 70 - hp_ * 30, breath(tc, .8));
  const C = clockState(tc);
  if (C.bugle) { const k = C.bugle.k, sxk = C.sx, syk = C.sy; C.extra = () => { if (k > .02) bugle(18, CLK.cy + 44, -.12, k * 1.05, C.bugle.flare); }; }
  if (C.irisArm) C.armL = null;
  clock(C);
  // the sleeper's slap arm is in front of the clock
  if (S_.arm && between(tc, H.handRise, H.boing)) sleeperArm(SHOULDER, S_.arm.hand, S_.arm);
  return C;
}

// —— the bugle's words: 起 床 啦！ hop out of the bell, one per beat ——
const WORD = ['起', '床', '啦！'], SLOTS = [[1175, 404], [1300, 388], [1425, 404]];
function drawWords(t, cam) {
  if (!between(t, H.ch1, H.slap)) return;
  const g = sg, tt = Math.min(t, H.stop - 1e-4), tc = twos(tt);
  g.save(); g.setTransform(cam.z, 0, 0, cam.z, 960 - cam.x * cam.z, 540 - cam.y * cam.z);
  const hits = [H.ch1, H.ch2, H.ch3], bell = [CLK_X + 175, CLK_Y + CLK.cy + 20];
  for (let i = 0; i < 3; i++) {
    if (tc < hits[i]) continue;
    const u = clamp((tc - hits[i]) / .25), e = eo(u);
    let x = lerp(bell[0], SLOTS[i][0], e), y = lerp(bell[1], SLOTS[i][1], e) - Math.sin(u * Math.PI) * 90;
    const k = lerp(.3, 1, back(u, 2.2));
    const b = beatsAt(tc) - i * .5, wave = Math.pow(Math.abs(Math.sin(Math.PI * b)), .8) * 22 * (u >= 1 ? 1 : 0);
    const sq = u >= 1 ? 1 + .08 * Math.cos(TAU * b) : 1;
    fatGlyph(g, WORD[i], x + (i === 2 ? 20 : 0), y - wave, 106 * k * (i === 1 ? 1.12 : 1), i === 1 ? { sx: 2 - sq, sy: sq, rot: 0, font: 'ZCOOL KuaiLe', ow: .1 } : { sx: 2 - sq, sy: sq, rot: (i - 1) * .08 });
  }
  g.restore();
}
export function wordsBox(t) {
  if (!between(t, H.ch1, H.slap)) return [];
  const cam = camera(t), a = W2S(cam, 1110, 330), b = W2S(cam, 1545, 470);
  return [{ id: 'shout', text: '起床啦！', x0: a[0], y0: a[1], x1: b[0], y1: b[1] }];
}

// —— iris (film-as-object): a hole in black ink, centred on the clock's dial ——
function irisRadius(t) {
  if (t < H.pullStart) return lerp(300, 1300, ei(seg(t, 0, H.pullStart)) * .4 + eo(seg(t, 0, H.pullStart)) * .6);
  if (t < H.reachIris) return 2000;
  if (t < H.grabIris) return lerp(1300, 680, eo(seg(t, H.reachIris, H.grabIris)));
  if (t < H.irisShut) return lerp(680, 330, ei(seg(t, H.grabIris, H.irisShut)));
  return 330 + 10 * Math.exp(-(t - H.irisShut) * 9) * Math.cos((t - H.irisShut) * 40);
}
function drawIris(t, cam, C) {
  const r = irisRadius(t); if (r > 1250) return null;
  const [cx, cy] = W2S(cam, DIAL[0], CLK_Y + CLK.cy * (C ? C.sy : 1) - 10);
  const g = sg; g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = P.ink; g.beginPath(); g.rect(0, 0, 1920, 1080); g.arc(cx, cy, Math.max(1, r), 0, TAU, true); g.fill('evenodd');
  g.strokeStyle = P.ink; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke();
  g.restore();
  return [cx, cy, r];
}
// the clock's left arm grabs the iris rim and pulls it shut (drawn in screen space over the iris)
function irisArm(t, cam, C, iris) {
  if (!C || !C.irisArm || !iris) return;
  const [cx, cy, r] = iris;
  const sh = W2S(cam, CLK_X - (CLK.R - 14) * C.sx, CLK_Y + (CLK.cy + 18) * C.sy);
  const reach = ss(seg(t, H.reachIris, H.grabIris));
  const ang = Math.PI + .12, rim = [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
  const hand = t < H.grabIris ? [lerp(sh[0] - 60, rim[0] + 12, reach), lerp(sh[1] + 20, rim[1], reach)] : [rim[0] + 12, rim[1]];
  if (t >= H.irisShut + B144 * 1.2) return;   // let go once the roundel has settled
  T.BASE.splice(0, 6, 1, 0, 0, 1, 0, 0); T.reset();
  const mid = [(sh[0] + hand[0]) / 2, Math.min(sh[1], hand[1]) - 60 * (1 - seg(t, H.grabIris, H.irisShut))];
  T.shape(chRibbon([sh, mid, hand]), { fill: P.ink, lw: T.S.lw * .8 });
  glove(hand[0], hand[1], Math.PI, t >= H.grabIris ? 'grab' : 'open', 1.05 * cam.z, { flip: true });
}
import { ribbon } from './parts.js';
const chRibbon = pts => ribbon(T.spline(pts, false, 10), 14 * 1.42, 14 * 1.42);

// —— end roundel: double white ring, dot-and-ring ornaments, banner with 剧终, THE END under it ——
function endCard(t, iris) {
  if (t < H.irisShut || !iris) return;
  const g = sg, [cx, cy, r] = iris;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = P.white; g.lineWidth = 7; g.beginPath(); g.arc(cx, cy, r + 14, 0, TAU); g.stroke();
  g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, r + 30, 0, TAU); g.stroke();
  for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + i * Math.PI / 2, x = cx + Math.cos(a) * (r + 52), y = cy + Math.sin(a) * (r + 52); g.fillStyle = P.white; g.beginPath(); g.arc(x, y, 6, 0, TAU); g.fill(); g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, 13, 0, TAU); g.stroke(); }
  // banner across the bottom of the roundel
  const by = cy + r * .62, bw = 520, bh = 132;
  g.fillStyle = P.ink; g.strokeStyle = P.white; g.lineWidth = 5;
  g.beginPath(); g.moveTo(cx - bw / 2 - 60, by - bh / 2 + 18); g.lineTo(cx - bw / 2, by - bh / 2); g.lineTo(cx + bw / 2, by - bh / 2); g.lineTo(cx + bw / 2 + 60, by - bh / 2 + 18); g.lineTo(cx + bw / 2 + 24, by); g.lineTo(cx + bw / 2 + 60, by + bh / 2 - 6); g.lineTo(cx + bw / 2, by + bh / 2); g.lineTo(cx - bw / 2, by + bh / 2); g.lineTo(cx - bw / 2 - 60, by + bh / 2 - 6); g.lineTo(cx - bw / 2 - 24, by); g.closePath(); g.fill(); g.stroke();
  g.lineWidth = 2; g.strokeRect(cx - bw / 2 + 12, by - bh / 2 + 12, bw - 24, bh - 24);
  // traveling wave: every beat from G1 each word lands (squash to .85) and hops, one after the other
  const bb = beatsAt(twos(t)) - beatsAt(H.irisShut);
  const hopOf = i => { const q = bb - i * .16; if (q < 1) return [0, 1]; const ph = q % 1; return [Math.pow(Math.sin(Math.PI * ph), .9) * 30, 1 - .15 * Math.exp(-ph * 9)]; };
  ['剧', '终'].forEach((ch, i) => { const [hy, sq] = hopOf(i); fatGlyph(g, ch, cx + (i ? 72 : -72), by - 4 - hy + 52 * (1 - sq), 104, { sx: 2 - sq, sy: sq }); });
  g.fillStyle = P.white; g.font = '60px Limelight'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  ['THE', 'END'].forEach((w, i) => { const [hy, sq] = hopOf(i + 2); g.save(); g.translate(cx + (i ? 92 : -92), cy + r + 118 - hy); g.scale(2 - sq, sq); g.fillText(w, 0, 0); g.restore(); });
  g.restore();
}
export function endBoxes(t) {
  if (t < H.irisShut) return [];
  const cam = camera(t), [cx, cy] = W2S(cam, DIAL[0], CLK_Y + CLK.cy - 10), r = 330, by = cy + r * .62;
  return [{ id: 'end-zh', text: '剧终', x0: cx - 180, y0: by - 70, x1: cx + 180, y1: by + 66 }, { id: 'end-en', text: 'THE END', x0: cx - 180, y0: cy + r + 66, x1: cx + 180, y1: cy + r + 126 }];
}

// —— impact burst on the slap ——
function slapBurst(t, cam) {
  if (!between(t, H.slap, H.slap + 4 / 24)) return;
  const g = sg, [cx, cy] = W2S(cam, CLK_X, CLK_Y - 40), k = 1 + (t - H.slap) * 6;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.strokeStyle = P.ink; g.lineCap = 'round';
  for (let i = 0; i < 14; i++) { const a = i / 14 * TAU + .2, r0 = 260 * k, r1 = r0 + 70 + (i % 3) * 30; g.lineWidth = 9 - (i % 3) * 2; g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * .55); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1 * .55); g.stroke(); }
  g.restore();
}
// speed lines while the hand comes down (the frame before the slap) and while the clock boings up
function speedLines(t, cam) {
  const g = sg;
  if (between(t, H.boing, H.boing + 4 / 24)) {
    const [cx, cy] = W2S(cam, CLK_X, CLK_Y - 120);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.strokeStyle = P.ink; g.lineCap = 'round';
    for (let i = -3; i <= 3; i++) { g.lineWidth = 6; g.beginPath(); g.moveTo(cx + i * 60, cy + 220); g.lineTo(cx + i * 60, cy + 360 + Math.abs(i) * 20); g.stroke(); }
    g.restore();
  }
}

export function renderScene(t) {
  const tc = twos(t), cam = camera(t), g = sg;
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 1920, 1080);
  const C = drawWorld(t, tc, cam);
  drawWords(t, cam);
  slapBurst(t, cam); speedLines(t, cam);
  const iris = drawIris(t, cam, C);
  irisArm(tc, cam, C, iris);
  endCard(t, iris);
  T.BASE.splice(0, 6, 1, 0, 0, 1, 0, 0); T.reset();
}
export const cam = camera;
