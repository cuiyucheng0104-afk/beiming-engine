// chars.js — the cast of 闹钟起床号: the alarm clock (the whole clock is the body), the sleeper, and the living bedroom props.
// Character-local coordinates, y down. Origin of the clock = the ground between its feet.
import * as T from './toon.js';
import { P, ribbon, union, fillLocal, pieEye, brow, mouth, glove, shoe, hose } from './parts.js';
import { clamp, lerp, TAU, hash } from '/core/lib.js';
const { shape, stroke, ell, arc, spline, noodle, quad, push, pop, translate, rotate, scale, dot, S, rr, rect } = T;
export { P };

// ———————————————————— Alarm clock ————————————————————
export const CLK = { R: 112, cy: -190, legY: -88 };
// p: { x, y, k, sx, sy, lean, minutes, ring (0..1 bell shake), t, eyes, mouth, brows, armL, armR, legL, legR, cheeks, bellFlop, handSpin }
export function clock(p) {
  const { R, cy } = CLK, t = p.t || 0;
  push(); translate(p.x, p.y); scale(p.k || 1); scale(p.sx || 1, p.sy || 1); if (p.lean) rotate(p.lean);
  const ring = p.ring || 0, jit = ring ? (hash(Math.floor(t * 24) * 3.7) - .5) * 2 : 0;
  // legs + shoes
  for (const s of [-1, 1]) {
    const L = p[s < 0 ? 'legL' : 'legR'] || { x: s * 44, y: 0 };
    hose([s * 42, CLK.legY], [L.x, L.y - 9], L.bend ?? s * 6, 15);
  }
  for (const s of [-1, 1]) { const L = p[s < 0 ? 'legL' : 'legR'] || { x: s * 44, y: 0 }; shoe(L.x - s * 6, L.y, L.dir ?? s, 1.05, L.ang || 0); }
  // arms behind the body
  const arm = (key, s) => {
    const A = p[key]; if (!A) return;
    const sh = [s * (R - 14), cy + 18];
    let ang;
    if (A.via) { const c = spline([sh, ...A.via, [A.x, A.y]], false, 10); shape(ribbon(c, 14, 14), { fill: P.ink, lw: S.lw * .8 }); const q = c[c.length - 3]; ang = A.rot ?? Math.atan2(A.y - q[1], A.x - q[0]); }
    else { hose(sh, [A.x, A.y], A.bend ?? s * -16, 14); ang = A.rot ?? Math.atan2(A.y - sh[1], A.x - sh[0]); }
    glove(A.x, A.y, ang, A.hand || 'open', A.hk || 1.05, { flip: A.flip ?? s < 0 });
  };
  for (const [key, s] of [['armL', -1], ['armR', 1]]) if (p[key] && !p[key].front) arm(key, s);
  // bells + hammer (the clock's "hair": they carry the mood)
  const flop = p.bellFlop || 0;
  for (const s of [-1, 1]) {
    const a = (-90 + s * (42 + flop * 30)) * Math.PI / 180 + jit * .08 * s;
    const bx = Math.cos(a) * (R + 12), by = cy + Math.sin(a) * (R + 12);
    push(); translate(bx, by - (p.bellLift || 0)); rotate(a + Math.PI / 2 + jit * .12 + (p.bellLift || 0) * .004 * s);
    stroke([[0, 20], [0, 6]], S.lw * 1.3);
    shape([...arc(0, -6, 46, 40, Math.PI, TAU, 20), [46, -2], [-46, -2]], { fill: P.dark, shade: () => fillLocal([[14, -60], [60, -60], [60, 4], [20, 4]], P.ink) });
    shape(ell(0, -48, 8, 6), { fill: P.dark, lw: S.lw * .8 });
    shape(ribbon(arc(-8, -10, 30, 26, Math.PI * 1.1, Math.PI * 1.45, 6), 6, 3), { fill: P.light, stroke: false, boil: .3 });
    pop();
  }
  { // hammer between the bells
    const ha = -Math.PI / 2 + Math.sin(t * TAU * 18) * .45 * ring;
    const hx = Math.cos(ha) * (R + 34), hy = cy + Math.sin(ha) * (R + 34);
    stroke([[0, cy - R + 4], [hx, hy]], S.lw * .9); shape(ell(hx, hy, 9, 9), { fill: P.dark, lw: S.lw * .8 });
  }
  // case + dial
  shape(ell(0, cy, R, R, 64), { fill: P.dark, shade: () => fillLocal(arc(0, cy, R + 4, R + 4, -Math.PI * .32, Math.PI * .62, 20).concat([[R * 2, cy]]), P.ink) });
  const D = R - 18;
  shape(ell(0, cy, D, D, 60), {
    fill: P.white, lw: S.lw * .9, shade: () => {
      // one hard light-grey form-shadow band on the side away from the upper-left light
      const c = arc(0, cy, D + 2, D + 2, -Math.PI * .42, Math.PI * .58, 22), inner = arc(D * .34, cy + D * .06, D * .78, D * .96, Math.PI * .58, -Math.PI * .42, 22);
      fillLocal([...c, ...inner], P.light);
    }
  });
  // highlight on the case (upper left)
  shape(ribbon(arc(0, cy, R - 8, R - 8, Math.PI * 1.08, Math.PI * 1.42, 8), 7, 3), { fill: P.light, stroke: false, boil: .3 });
  // hour ticks
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU - Math.PI / 2, r0 = D - (i % 3 ? 7 : 13), r1 = D - 2; if (i === 0 || i === 6) continue; stroke([[Math.cos(a) * r0, cy + Math.sin(a) * r0], [Math.cos(a) * r1, cy + Math.sin(a) * r1]], S.lw * (i % 3 ? .55 : .9), { boil: .4 }); }
  // face: pie eyes in the upper dial, mouth in the lower dial
  const E = p.eyes || {};
  const ex = 30, ey = cy - 30, erx = 21, ery = 29;
  if (p.popEyes > .3) { /* the eyes have popped out of the pancake: drawn after the body */ }
  else if (E.type === 'x') { for (const s of [-1, 1]) { stroke([[s * ex - 13, ey - 13], [s * ex + 13, ey + 13]], S.lw * 1.1); stroke([[s * ex + 13, ey - 13], [s * ex - 13, ey + 13]], S.lw * 1.1); } }
  else for (const s of [-1, 1]) pieEye(s * ex, ey, erx, ery, { ...E, type: s > 0 && E.winkR ? 'happy' : E.type, lidCol: P.white, side: -s });
  if (p.brows) for (const s of [-1, 1]) brow(s * ex, ey - ery - 14, 26, p.brows, s);
  // hands (minute + hour), pivot = the nose
  const m = p.minutes ?? 420, spin = p.handSpin || 0;
  const am = (m % 60) / 60 * TAU - Math.PI / 2 + spin * 1.0, ah = (m / 720) * TAU - Math.PI / 2 + spin * .37;
  const hand = (a, L, w) => shape(ribbon([[0, cy], [Math.cos(a) * L, cy + Math.sin(a) * L]], w, w * .45), { fill: P.ink, lw: S.lw * .5, boil: .4 });
  hand(ah, D * .5, 9); hand(am, D * .8, 6);
  // cheeks (puffed when blowing)
  if (p.cheeks) for (const s of [-1, 1]) shape(ell(s * 52, cy + 34, 22 * p.cheeks, 18 * p.cheeks), { fill: P.white, lw: S.lw * .7 });
  const Mo = p.mouth || { type: 'smile' };
  if (Mo.type !== 'none') mouth(0, cy + 42, Mo.w ?? 54, Mo.type, Mo);
  dot(0, cy, 8);   // nose = hand pivot
  for (const [key, s] of [['armL', -1], ['armR', 1]]) if (p[key] && p[key].front) arm(key, s);
  if (p.extra) p.extra();
  pop();
  // eyes squeezed out of the flattened dial on springy stalks (drawn unsquashed, so they stay round)
  const pe = p.popEyes || 0;
  if (pe > .3) {
    const sx = p.sx || 1, sy = p.sy || 1, k = p.k || 1, by0 = p.y + cy * sy * k;
    for (const s of [-1, 1]) {
      const bx = p.x + s * 30 * sx * k, ex2 = bx + s * 26 * pe, ey2 = by0 - 92 * pe;
      stroke(spline([[bx, by0], [bx + s * 6 * pe, by0 - 50 * pe], [ex2, ey2]], false, 8), S.lw * 1.1);
      pieEye(ex2, ey2, 27 * (.7 + .3 * pe), 35 * (.7 + .3 * pe), { type: 'wide', lx: -s * .5 + (p.eyeJit || 0), ly: .2, lidCol: P.white, side: -s });
    }
  }
}

// Bugle (a small brass horn): mouthpiece at the origin, bell along +x
export function bugle(x, y, ang, k = 1, flare = 1) {
  push(); translate(x, y); rotate(ang); scale(k);
  shape(rr(-6, -7, 18, 14, 5), { fill: P.dark, lw: S.lw * .8 });
  shape([[10, -6], [100, -9], [100, 9], [10, 6]], { fill: P.pale, shade: () => fillLocal([[10, 1], [100, 2], [100, 12], [10, 8]], P.light) });
  // a loop of tubing under the pipe
  stroke(spline([[30, 6], [44, 32], [74, 34], [86, 8]], false, 6), S.lw * 2.4);
  stroke(spline([[30, 6], [44, 32], [74, 34], [86, 8]], false, 6), S.lw * .9, { line: P.pale });
  const fl = 46 * flare;
  shape([[98, -9], [128, -14 - fl * .2], [150, -fl], [156, -fl], [156, fl], [150, fl], [128, 14 + fl * .2], [98, 9]], { fill: P.pale, shade: () => fillLocal([[100, 3], [160, 8], [160, fl + 4], [100, 12]], P.light) });
  shape(ell(156, 0, 11, fl, 30), { fill: P.ink, lw: S.lw * .8 });
  shape(ribbon([[110, -10], [140, -fl * .7]], 4, 2), { fill: P.white, stroke: false, boil: .3 });
  pop();
}

// ———————————————————— The sleeper ————————————————————
// Head on the pillow, seen from the side of the bed: origin = head centre. o = { t, snore 0..1, rot, capBlow 0..1, shut, sx, sy }
export function sleeperHead(x, y, o = {}) {
  const sn = o.snore ?? 0;
  push(); translate(x, y); rotate(o.rot ?? -.18); scale(o.sx || 1, o.sy || 1);
  // nightcap: cone trailing over the pillow, tassel ball; blown straight back by the bugle
  const blow = o.capBlow || 0, tw = Math.sin((o.t || 0) * 9) * 4 * blow;
  const tip = [lerp(-118, 150, blow), lerp(-38, -96, blow) + tw], mid = [lerp(-70, 70, blow), lerp(-92, -82, blow)];
  const capPts = [[-58, -24], ...quad([-50, -40], mid, tip, 10).slice(1), [tip[0] + 4, tip[1] + 6], ...quad(tip, [mid[0] + 18, mid[1] + 26], [48, -40], 10).slice(1), [52, -26]];
  shape(capPts, { fill: P.pale, shade: () => { for (let i = 0; i < 5; i++) { const u0 = .15 + i * .18; const a = quad([-50, -40], mid, tip, 10), b = quad(tip, [mid[0] + 18, mid[1] + 26], [48, -40], 10).reverse(); const k = Math.floor(u0 * 10), k2 = Math.min(10, k + 1); fillLocal([a[k], a[k2], b[k2], b[k]], P.mid); } } });
  shape(ell(tip[0] + 2, tip[1] + 4, 17, 17), { fill: P.white, shade: () => fillLocal(ell(tip[0] + 9, tip[1] + 10, 13, 13), P.light) });
  // ear + head
  shape(ell(-50, 10, 15, 20), { fill: P.white });
  shape(ell(0, 0, 66, 60, 56), { fill: P.white, shade: () => fillLocal(ell(34, 14, 50, 58), P.light) });
  // cap brim over the forehead
  shape(rr(-60, -46, 118, 26, 12), { fill: P.white, shade: () => fillLocal(rect(20, -50, 50, 32), P.light) });
  // closed eyes, big nose, snoring mouth, stubble ticks
  for (const s of [-1, 1]) { if (o.wake) pieEye(s * 18 + 14, -6, 13, 17, { type: 'open', lx: .3 }); else stroke(arc(s * 18 + 14, -4, 12, 7, Math.PI * .1, Math.PI * .9, 10), S.lw * .9); }
  shape(ell(40, 16, 26, 21), { fill: P.white, shade: () => fillLocal(ell(50, 22, 18, 16), P.light) });
  mouth(16, 40, 26 + sn * 6, 'o', { open: .55 + sn * .7 });
  for (const [a, b] of [[-14, 36], [-6, 46], [34, 50]]) stroke([[a, b], [a + 3, b + 4]], S.lw * .5, { boil: .5 });
  pop();
}
// The sleeper's arm (hose from the shoulder under the blanket) with a big glove
export function sleeperArm(sh, hand, o = {}) {
  if (o.via) { const c = spline([sh, ...o.via, hand], false, 10); shape(ribbon(c, 18, 18), { fill: P.ink, lw: S.lw * .8 }); }
  else hose(sh, hand, o.bend ?? 30, 18);
  glove(hand[0], hand[1], o.ang ?? -1.2, o.type || 'open', o.k || 1.6, { flip: o.flip });
}
// Curled-up sleeper in striped pyjamas (after the blanket is gone). origin = hip. shiv = shiver offset
export function curledBody(x, y, o = {}) {
  push(); translate(x + (o.shiv || 0), y);
  // legs folded up, socks
  for (const [hx, kx, fx, s] of [[30, 120, 150, .9], [10, 105, 120, 1]]) {
    hose([hx, -10], [kx, -70], -10, 22, P.white);
    hose([kx, -70], [fx, 0], -8, 22, P.white);
    shape(ell(fx + 12, 2, 30, 16), { fill: P.white, shade: () => fillLocal(rect(fx + 18, -20, 30, 40), P.light) });
  }
  const body = spline([[-120, -40], [-60, -82], [20, -78], [70, -40], [60, 8], [-20, 18], [-110, 4]], true, 8);
  shape(body, { fill: P.white, shade: () => { for (let i = -140; i < 100; i += 30) fillLocal([[i, -100], [i + 13, -100], [i + 33, 30], [i + 20, 30]], P.mid); } });
  pop();
}
// Pillow: origin = centre
export function pillow(x, y, w = 170, h = 64, rot = 0, sq = 1) {
  push(); translate(x, y); rotate(rot); scale(1, sq);
  shape(spline([[-w / 2, -h / 2], [0, -h / 2 - 8], [w / 2, -h / 2], [w / 2 + 8, 0], [w / 2, h / 2], [0, h / 2 + 6], [-w / 2, h / 2], [-w / 2 - 8, 0]], true, 6), { fill: P.white, shade: () => fillLocal(rect(-w / 2, h * .1, w, h), P.pale) });
  for (const [cx, cy, a] of [[-w / 2, -h / 2, .7], [w / 2, -h / 2, -.7], [w / 2, h / 2, .7], [-w / 2, h / 2, -.7]]) stroke([[cx, cy], [cx + Math.cos(a) * 12 * Math.sign(-cx), cy + 10 * Math.sign(-cy)]], S.lw * .6);
  pop();
}
// Quilt: lumpy cover, origin = top-left at the sleeper's neck. lift: 0..1 (yanked away to the left), fly: rotation while flying
export function quilt(x, y, o = {}) {
  const L = o.len ?? 680;
  push(); translate(x, y); if (o.rot) rotate(o.rot); scale(o.sx || 1, o.sy || 1);
  const top = spline([[0, 0], [L * .22, -38], [L * .5, -30], [L * .66, -70], [L * .82, -40], [L, -22]], false, 8);
  const pts = [...top, [L + 16, 30], [L + 10, 140], [-10, 140], [-14, 30]];
  shape(pts, {
    fill: P.pale, shade: () => {
      for (let i = 0; i < 10; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2) fillLocal(rect(i * L / 10, -80 + j * 55, L / 10, 55), P.light);
      fillLocal(rect(-20, 70, L + 40, 90), P.mid);
    }
  });
  stroke([[-10, 70], [L + 12, 70]], S.lw * .7);
  pop();
}

// ———————————————————— Living props ————————————————————
// breath b: stretch factor around the base (1 = rest)
export function nightstand(x, y, b = 1) {
  push(); translate(x, y); scale(2 - b, b);
  for (const s of [-1, 1]) shape(rr(s * 78 - 9, -40, 18, 40, 6), { fill: P.dark });
  shape(rr(-100, -200, 200, 168, 10), { fill: P.dmid, shade: () => fillLocal(rect(54, -210, 60, 190), P.dark) });
  shape(rr(-84, -170, 168, 56, 6), { fill: P.mid, lw: S.lw * .7 }); dot(0, -142, 7);
  shape(rr(-84, -104, 168, 56, 6), { fill: P.mid, lw: S.lw * .7 }); dot(0, -76, 7);
  shape(rr(-116, -214, 232, 22, 8), { fill: P.dark });
  pop();
}
export function bed(x, y, b = 1, o = {}) {
  // x = headboard post centre, y = floor
  push(); translate(x, y); scale(2 - b, b);
  const L = 820;
  // mattress + sheet
  shape(rr(10, -300, L - 20, 120, 18), { fill: P.dmid, shade: () => fillLocal(rect(10, -230, L, 60), P.dark) });
  shape(rr(4, -312, L - 8, 40, 16), { fill: P.white, shade: () => fillLocal(rect(0, -292, L, 30), P.pale) });
  // legs
  for (const lx of [40, L - 40]) shape(rr(lx - 14, -180, 28, 180, 8), { fill: P.dark });
  // headboard (left) + footboard (right), turned posts with round knobs
  const board = (bx, hgt) => {
    shape(rr(bx - 20, -hgt, 40, hgt, 10), { fill: P.dark });
    shape(ell(bx, -hgt - 18, 26, 24), { fill: P.dark, shade: () => fillLocal(ell(bx + 10, -hgt - 12, 18, 18), P.ink) });
    shape(ribbon(arc(bx - 2, -hgt - 20, 18, 16, Math.PI * 1.1, Math.PI * 1.45, 6), 6, 3), { fill: P.light, stroke: false, boil: .3 });
  };
  board(0, 560); board(L, 420);
  pop();
}
export function curtain(x, y, w, h, o = {}) {
  // x = rod end at the window side (curtain hangs from the rod top y), w = width; open 0..1 (bunches toward the outside edge)
  const open = o.open || 0, dir = o.dir || 1, sway = o.sway || 0;
  const cw = lerp(w, w * .32, open);
  push(); translate(x, y);
  const folds = 5, pts = [];
  for (let i = 0; i <= folds * 2; i++) { const u = i / (folds * 2); pts.push([dir * u * cw, (i % 2) * 8]); }
  const bot = []; for (let i = folds * 2; i >= 0; i--) { const u = i / (folds * 2); bot.push([dir * (u * cw * (1 + sway * .12) + sway * 14 * u), h + (i % 2) * 14 - u * 8]); }
  shape([...pts, ...bot], {
    fill: P.pale, shade: () => {
      for (let i = 0; i < folds; i++) { const u0 = (i * 2 + 1) / (folds * 2), u1 = (i * 2 + 1.8) / (folds * 2); fillLocal([[dir * u0 * cw, 0], [dir * u1 * cw, 0], [dir * u1 * cw * (1 + sway * .12), h + 10], [dir * u0 * cw * (1 + sway * .12), h + 10]], P.light); }
    }
  });
  for (let i = 1; i < folds * 2; i += 2) { const u = i / (folds * 2); stroke([[dir * u * cw, 8], [dir * u * cw * (1 + sway * .12), h - 6]], S.lw * .45, { boil: .6 }); }
  // tie-back sash when open
  if (open > .6) shape(rr(dir > 0 ? -6 : -cw * 1.05 - 6, h * .55, cw * 1.05 + 12, 22, 8), { fill: P.dmid, lw: S.lw * .7 });
  pop();
}
export function frameProp(x, y, b = 1) {   // oval picture frame on the wall: a little sailboat on a calm sea
  push(); translate(x, y); scale(2 - b, b);
  shape(ell(0, 0, 92, 116), { fill: P.dark });
  shape(ell(0, 0, 70, 94), { fill: P.light, shade: () => { fillLocal(rect(-80, 30, 160, 80), P.mid); fillLocal([[-20, 28], [30, 28], [20, 40], [-12, 40]], P.dark); fillLocal([[4, 24], [4, -40], [34, 24]], P.white); fillLocal([[0, 24], [0, -28], [-26, 24]], P.pale); } });
  pop();
}
export function slippers(x, y, b = 1) {
  push(); translate(x, y); scale(2 - b, b);
  for (const dx of [0, 70]) { shape(spline([[dx - 30, 0], [dx - 34, -12], [dx - 10, -26], [dx + 30, -20], [dx + 34, -4], [dx + 10, 4]], true, 6), { fill: P.dmid, shade: () => fillLocal(rect(dx + 8, -30, 40, 40), P.dark) }); shape(ell(dx - 4, -18, 20, 9), { fill: P.ink, lw: S.lw * .6 }); }
  pop();
}

// Fat retro lettering in the scene (white face, heavy ink outline, ink drop shadow down-right)
export function fatGlyph(g, ch, x, y, size, o = {}) {
  g.save(); g.translate(x, y); if (o.rot) g.rotate(o.rot); g.scale(o.sx || 1, o.sy || 1);
  g.font = `${size}px "${o.font || 'ZCOOL QingKe HuangYou'}"`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  const ow = size * (o.ow ?? .14);
  g.fillStyle = P.ink; g.strokeStyle = P.ink; g.lineWidth = ow * 2;
  g.strokeText(ch, size * .06, size * .07); g.fillText(ch, size * .06, size * .07);
  g.strokeText(ch, 0, 0);
  g.fillStyle = o.fill || P.white; g.fillText(ch, 0, 0);
  g.restore();
}
