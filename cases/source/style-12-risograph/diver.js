// The diver: one flat silhouette on the pink plate (no outlines), far limbs as a 70 % pink tint for depth,
// a paper-white swim cap (zero ink = knockout). Forward kinematics, local origin = hips, facing +x.
import { g, ink, line, circle, blob } from './draw.js';
import { track, lerp, clamp } from '/core/lib.js';

export const KO = { ctx: null };   // when set, the paper cap is also drawn here (an opaque knockout mask)
const PINK = [1, 0, 0], FAR = [.7, 0, 0], PAPER = 'rgb(0,0,0)';

// a direction `a` radians from the body's "down" towards its "forward", for a body tilted by R
const dirR = (R, a) => [-Math.sin(R) * Math.cos(a) + Math.cos(R) * Math.sin(a), Math.cos(R) * Math.cos(a) + Math.sin(R) * Math.sin(a)];
const add = (p, d, l) => [p[0] + d[0] * l, p[1] + d[1] * l];

// pose: {R, curl, neck, th:[near,far], kn:[..], sh:[..], el:[..], point}
export function joints(P, s) {
  const R = P.R || 0, R2 = R + (P.curl || 0), R3 = R2 + (P.neck || 0);
  const hip = [0, 0];
  const waist = add(hip, dirR(R, Math.PI), .14 * s);
  const sho = add(waist, dirR(R2, Math.PI), .16 * s);
  const head = add(sho, dirR(R3, Math.PI), (.03 + .062) * s);
  const legs = [0, 1].map(i => {
    const a = P.th[i], k = P.kn[i];
    const knee = add(hip, dirR(R, a), .245 * s), ank = add(knee, dirR(R, a - k), .245 * s);
    const fa = a - k + lerp(Math.PI / 2, .12, P.point || 0);
    return { knee, ank, toe: add(ank, dirR(R, fa), .075 * s) };
  });
  const arms = [0, 1].map(i => {
    const a = P.sh[i], e = P.el[i];
    const elb = add(sho, dirR(R2, a), .17 * s), wr = add(elb, dirR(R2, a + e), .15 * s);
    return { elb, wr, hand: add(wr, dirR(R2, a + e), .05 * s) };
  });
  return { R, R2, R3, hip, waist, sho, head, legs, arms };
}

function leg(L, hip, s, c) {
  line([hip, L.knee], .085 * s, c); line([L.knee, L.ank], .06 * s, c); line([L.ank, L.toe], .036 * s, c);
}
function arm(A, sho, s, c) {
  line([sho, A.elb], .052 * s, c); line([A.elb, A.wr], .043 * s, c); line([A.wr, A.hand], .036 * s, c);
}

export function figure(P, s) {
  const J = joints(P, s);
  // far side first, as a tint
  arm(J.arms[1], J.sho, s, FAR); leg(J.legs[1], J.hip, s, FAR);
  // torso: pelvis + chest, as one smooth shape
  const f1 = dirR(J.R, Math.PI / 2), f2 = dirR(J.R2, Math.PI / 2), u2 = dirR(J.R2, Math.PI);
  const P2 = (o, d, l) => add(o, d, l);
  const d1 = dirR(J.R, 0);
  blob([
    P2(add(J.hip, d1, .04 * s), f1, -.06 * s), P2(add(J.hip, d1, .045 * s), f1, .045 * s),
    P2(J.hip, f1, .065 * s), P2(J.waist, f1, .055 * s),
    P2(add(J.waist, u2, .08 * s), f2, .075 * s), P2(add(J.sho, u2, -.01 * s), f2, .06 * s),
    P2(add(J.sho, u2, .03 * s), f2, .0), P2(add(J.sho, u2, -.005 * s), f2, -.065 * s),
    P2(add(J.waist, u2, .06 * s), f2, -.06 * s), P2(J.waist, f1, -.055 * s), P2(J.hip, f1, -.075 * s),
  ], PINK);
  line([J.sho, J.head], .05 * s, PINK);   // neck
  // head + cap (paper knockout over the top-back) + a small nose
  const hr = .062 * s;
  circle(J.head[0], J.head[1], hr, PINK);
  const fh = dirR(J.R3, Math.PI / 2);
  circle(J.head[0] + fh[0] * hr * .92, J.head[1] + fh[1] * hr * .92 + 0, hr * .22, PINK);
  const ang = Math.atan2(fh[1], fh[0]);
  const cap = G => {
    G.save(); G.beginPath(); G.arc(J.head[0], J.head[1], hr * .97, 0, Math.PI * 2); G.clip();
    G.translate(J.head[0], J.head[1]); G.rotate(ang);
    G.fillStyle = PAPER; G.beginPath(); G.moveTo(hr * .55, -hr * .25); G.lineTo(hr * .2, -hr * 2); G.lineTo(-hr * 2, -hr * 2); G.lineTo(-hr * 2, hr * .7); G.lineTo(-hr * .6, hr * .55); G.closePath(); G.fill();
    G.restore();
  };
  cap(g);
  // overprint mode: the cap must also knock out whatever lies beneath (both plates), or the head reads hollow
  if (KO.ctx) { KO.ctx.save(); KO.ctx.setTransform(g.getTransform()); cap(KO.ctx); KO.ctx.restore(); }
  // near limbs on top, solid
  leg(J.legs[0], J.hip, s, PINK); arm(J.arms[0], J.sho, s, PINK);
  return J;
}

// ── poses ──
export const STAND = { R: 0, curl: 0, neck: 0, th: [.03, -.03], kn: [.05, .05], sh: [.1, -.06], el: [.2, .15], point: 0 };

// run cycle: a leg's phase φ in [0,1): footfall at φ = 0 (foot ahead), stance to .4, swing back to 1
const LEG = track([[0, [.55, .15]], [.2, [.05, .35]], [.4, [-.55, .25]], [.6, [-.25, 1.9]], [.85, [.85, 1.1]], [1, [.55, .15]]]);
const ARM = track([[0, [-.7, 1.2]], [.5, [.45, 1.5]], [1, [-.7, 1.2]]]);
export function runPose(ph, lean = .25) {
  const p0 = ((ph % 1) + 1) % 1, p1 = (p0 + .5) % 1;
  const [t0, k0] = LEG(p0), [t1, k1] = LEG(p1), [s0, e0] = ARM(p0), [s1, e1] = ARM(p1);
  // the near arm swings opposite the near leg
  return { R: lean, curl: .05, neck: -.1, th: [t0, t1], kn: [k0, k1], sh: [s1, s0], el: [e1, e0], point: .2 };
}

// takeoff → tuck → open, by action time τ (s); rotation separate
const DIVE = track([
  //        curl  neck  th0   th1   kn0   kn1   sh0   sh1   el0   el1   point
  [0.00, [.10, -.1, .35, .25, .7, .6, 1.2, 1.0, .5, .5, .3]],
  [0.15, [-.05, -.2, -.08, -.12, .02, .02, 2.95, 2.85, .05, .05, 1]],
  [0.36, [.9, .5, 2.5, 2.4, 2.65, 2.6, .45, .35, 1.0, 1.05, 1]],
  [0.92, [.95, .55, 2.55, 2.45, 2.7, 2.65, .5, .4, 1.0, 1.05, 1]],
  [1.14, [-.05, .05, .0, .0, .0, .0, 3.1, 3.1, .0, .0, 1]],
  [2.00, [-.05, .05, .0, .0, .0, .0, 3.14, 3.14, .0, .0, 1]],
]);
const ROT = track([[0, [.18]], [.15, [.38]], [.36, [1.45]], [.92, [3 * Math.PI - .85]], [1.14, [3 * Math.PI]], [2, [3 * Math.PI]]]);
export function divePose(tau) {
  const v = DIVE(clamp(tau, 0, 2));
  return { R: ROT(clamp(tau, 0, 2))[0], curl: v[0], neck: v[1], th: [v[2], v[3]], kn: [v[4], v[5]], sh: [v[6], v[7]], el: [v[8], v[9]], point: v[10] };
}
export const ENTRY = divePose(2);   // straight line, head down, arms overhead
