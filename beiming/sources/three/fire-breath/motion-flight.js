// All distances in metres. These are the flight director's sparse rail marks, not sampled poses.
import { compileRail, monotoneCubic, sweepSpineAt } from '../../../cards/motion/sweep-body/index.mjs';
import { impulseDisplacementAt, smoothstep } from '../../../cards/motion/impulse/index.mjs';
import { bakeTrajectory, queryBakedTable } from '../../../cards/time/bake/index.mjs';

export const add = (a, b, k = 1) => a.map((n, i) => n + k * b[i]);
export const scale = (v, k) => v.map((n) => n * k);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
export const unit = (v) => scale(v, 1 / (Math.hypot(...v) || 1));
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a, b, t) => add(scale(a, 1 - t), b, t);
export const off = (params, id) => new Set(params.disableCards ?? []).has(id);
export const lengths = [172, 150];
const routes = [
  [
    [42, -10, 54, 13],
    [42.75, -5, 62, 10],
    [43.3, -11.5, 71.5, 2.5],
    [null, -13.5, 77.5, -11],
    [43.95, -14, 86.5, -30],
    [null, -13, 97, -49],
    [44.6, -12.5, 100.5, -66],
    [null, -5.5, 100.5, -82],
    [45.15, 10, 98.5, -88],
    [null, 21.5, 96.5, -84],
    [45.7, 27.5, 94.5, -70],
    [null, 30.5, 88.5, -54],
    [46.4, 27.5, 84, -40],
    [47, 17, 78.5, -33.5],
    [47.5, 6, 72.5, -27.5],
    [47.9, -8, 66, -20.5],
    [48.32, -21, 59.5, -9],
    [48.78, -25.8, 54.5, 6],
    [49.18, -18.5, 54.5, 16.5],
    [49.5, -11.3, 63.2, 17],
  ],
  [
    [42, 24, 54, 13],
    [42.75, 18, 62, 10],
    [43.3, 22.5, 71.5, 2.5],
    [null, 26, 77.5, -11],
    [43.95, 27, 86.5, -30],
    [null, 31, 97, -49],
    [44.55, 33, 106.5, -66],
    [null, 27, 113.5, -83],
    [45.15, 10, 116, -91],
    [null, -9, 116, -86],
    [45.75, -19, 113, -69],
    [null, -21, 104, -52],
    [46.4, -21.5, 93, -38],
    [46.9, -19, 80.5, -24],
    [47.4, -10, 67.5, -9],
    [null, 2.5, 55, 6.5],
    [null, 9.5, 46, 20],
    [48.3, 11.5, 43, 26.5],
    [null, 17, 40, 34.5],
    [49.1, 23.5, 44.5, 35.5],
    [49.5, 27.5, 53, 28.5],
  ],
];
const rails = routes.map((r, i) =>
  compileRail(
    {
      controlPoints: r.map((k) => k.slice(1)),
      timeKeyMode: 'cpIndex',
      timeKeys: r.flatMap(([t], j) => (t === null ? [] : [[t, j]])),
      sRef: [47.3, i ? 1074.6 : 992.1],
    },
    { bodyLength: lengths[i] },
  ),
);
const evade = [
  {
    dir: unit([-0.72, 0.62, 0.3]),
    amp: 10,
    reach: 60,
    whip: 70,
    tailFade: 0.3,
    t0: 46.55,
    t1: 49.1,
    envelope: 'smooth-window',
    riseStart: 46.55,
    riseEnd: 47.2,
    fallStart: 47.75,
    fallEnd: 49,
  },
];
export function railPoint(i, t, d = 0) {
  const r = rails[i];
  return r.pathAt(r.sOf(t) - d);
}
const craneMarks = [
  [44.4, 0, 17, 69, 42],
  [45.6, 0.25, 17.3, 68, 27],
  [46.4, 0.4, 17.5, 67, 25],
  [47.2, 0.2, 17, 67.7, 27],
  [47.8, -0.2, 16.3, 69, 38],
  [48.4, -0.6, 15.5, 71, 56],
  [49.95, -0.9, 15.85, 72.4, 54.6],
];
const crane = [1, 2, 3, 4].map((i) =>
  monotoneCubic(
    craneMarks.map((k) => k[0]),
    craneMarks.map((k) => k[i]),
  ),
);
const cranePosition = (t) => [
  crane[0](t) + 0.2 * Math.sin(0.21 * t),
  crane[1](t) + 0.1 * Math.sin(0.33 * t + 1),
  crane[2](t),
];
const headAt = (i, t, active) =>
  add(railPoint(i, t), i && active ? impulseDisplacementAt(evade, t, 0, lengths[i]).offset : [0, 0, 0]);
function gazeAt(t, active) {
  const rival = headAt(1, t, active),
    lead = unit(add(headAt(1, t + 0.12, active), rival, -1));
  const fire = smoothstep(46, 46.4, t) * (1 - smoothstep(47.9, 48.25, t)),
    leadWeight = 0.95 * fire,
    rivalWeight = 0.9 * (1 - fire),
    weight = leadWeight + rivalWeight;
  return {
    target: mix(rival, mix(add(rival, lead, 6), [-40, 60, -1], smoothstep(47.05, 47.5, t)), leadWeight / weight),
    weight,
  };
}
export function cameraAt(t, p) {
  const w = 0.3 - 0.13 * smoothstep(46.5, 47.5, t),
    active = !off(p, 'motion.impulse');
  const base = t > 47.6 ? 0.04 + 0.06 * smoothstep(47.6, 48.3, t) : 0.04 + 0.02 * (1 - smoothstep(45.4, 47.6, t));
  let target = scale([2.4, 42, -46], base);
  for (let j = -3; j <= 3; j++)
    for (let i = 0; i < 2; i++)
      target = add(target, headAt(i, t + j * w, active), ((1 - base) * (4 - Math.abs(j))) / 32);
  return {
    position: cranePosition(t),
    target,
    fov: crane[3](t),
    near: 0.5,
    far: 6000,
    trim: [0.004 * Math.sin(0.47 * t), 0.005 * Math.sin(0.31 * t + 2), 0.004 * Math.sin(0.23 * t)],
  };
}
function bodyAt(i, t, p, onlySocket = false) {
  const active = !off(p, 'motion.impulse'),
    bank = !off(p, 'motion.roll-bank'),
    k = i ? 3.1 / 3.6 : 1;
  const options = {
    bodyLength: lengths[i],
    segments: i ? 264 : 300,
    swimAmplitude: off(p, 'motion.swim') ? 0 : 1,
    swimPhaseDeg: i ? 120.32 : 0,
    impulses: i && active ? evade : [],
    viewRollWeight: bank ? 1 : 0,
    observerPos: cranePosition,
    bankGain: bank ? 0.42 : 0,
    ...(!i && { aim: { sampleTarget: (s) => gazeAt(s, active), scaleK: k } }),
  };
  const body = sweepSpineAt(rails[i], t, options);
  let spine = body.nodes;
  const h = spine[0],
    straight = off(p, 'motion.sweep-body');
  if (straight) spine = spine.map((n) => ({ ...h, s: n.s, pos: add(h.pos, h.tan, n.s) }));
  if (!bank)
    spine = spine.map((n) => {
      const bin = unit(cross(n.tan, [0, 1, 0]));
      return { ...n, bin, nor: unit(cross(bin, n.tan)) };
    });
  const neck = spine[0],
    tangent = scale(neck.tan, -1);
  let front = tangent;
  if (!i) {
    let avg = [0, 0, 0],
      gain = 0;
    for (let j = -2; j <= 2; j++) {
      const gaze = gazeAt(t + 0.07 * j, active),
        w = (gaze.weight * (3 - Math.abs(j))) / 9;
      avg = add(avg, gaze.target, w);
      gain += w;
    }
    avg = scale(avg, 1 / gain);
    const target = unit(add(avg, neck.pos, -1)),
      cos = Math.min(1, Math.max(-1, dot(target, tangent))),
      angle = Math.acos(cos),
      turn = Math.min(1.08, gain * angle) * (1 - smoothstep(2.6, 3.05, angle));
    front = add(scale(tangent, Math.cos(turn)), unit(add(target, tangent, -cos)), Math.sin(turn));
  }
  const Y = unit(add(neck.nor, front, -dot(neck.nor, front))),
    X = unit(cross(Y, front)),
    phase = i ? 2.1 : 0;
  const pitch =
      0.02 * Math.sin(t * 0.8 + phase) - (i ? 0 : 0.5 * smoothstep(46.05, 46.5, t) * (1 - smoothstep(47.8, 48.25, t))),
    roll = 0.05 * Math.sin(0.55 * t + phase),
    yaw = 0.04 * Math.sin(0.41 * t + 1 + phase);
  const rotate = ([x, y, z]) => {
    [x, z] = [x * Math.cos(yaw) + z * Math.sin(yaw), z * Math.cos(yaw) - x * Math.sin(yaw)];
    [x, y] = [x * Math.cos(roll) - y * Math.sin(roll), x * Math.sin(roll) + y * Math.cos(roll)];
    [y, z] = [y * Math.cos(pitch) - z * Math.sin(pitch), y * Math.sin(pitch) + z * Math.cos(pitch)];
    return add(add(scale(X, x), Y, y), front, z);
  };
  const head = add(neck.pos, front, 2.75 * k - (i ? 0 : 0.7 * (1 - smoothstep(46.5, 46.7, t)))),
    up = rotate([0, 1, 0]),
    forward = rotate([0, 0, 1]),
    mouth = add(add(head, up, -1.155 * (i ? 1 : k)), forward, 5.225 * (i ? 1 : k));
  return { head, mouth, up, forward, ...(!onlySocket && { spine, speed: body.speed }) };
}
export const envelope = (t) => smoothstep(46.5, 46.65, t) * (1 - smoothstep(47.75, 48.1, t));
export const bodiesAt = (t, p) => [bodyAt(0, t, p), bodyAt(1, t, p)];
// Bake emitter sockets from the physical rail/aim solver once per choreography variant.
// The independent fixed-step wind spring drives whisker and canopy deflection.
const emitterTables = new Map();
export function wakeTable(p) {
  const key = ['motion.impulse', 'motion.sweep-body', 'motion.swim', 'motion.roll-bank']
    .map((id) => Number(off(p, id)))
    .join('');
  if (!emitterTables.has(key)) {
    const table = { emP: [], emD: [], emB: [] };
    for (let i = 0; i < 12; i++) {
      const t = 46.4 + (2.1 * i) / 11,
        b = bodyAt(0, t, p, true);
      table.emP.push(...b.mouth);
      table.emD.push(...unit(add(b.forward, b.up, -0.62)));
      table.emB.push(envelope(t));
    }
    emitterTables.set(key, table);
  }
  return emitterTables.get(key);
}
const wind = bakeTrajectory({
  t0: 45,
  duration: 5,
  sampleHz: 30,
  substeps: 3,
  initialState: [0, 0],
  step: ([x, v], t, dt) => {
    const a = 15 * (Math.sin(t * 4.3) + 0.4 * Math.cos(t * 9.1) - x) - 3 * v;
    return [x + dt * v, v + dt * a];
  },
});
export const windAt = (t, p) => (off(p, 'time.bake') ? 0 : queryBakedTable(wind, t)[0]);
