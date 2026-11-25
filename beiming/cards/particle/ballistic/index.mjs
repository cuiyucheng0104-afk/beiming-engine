// Positions use metres in a right-handed Y-up frame. Matrices are column-major.
const f32 = Math.fround;
const pools = ['flame', 'soft', 'smoke', 'glow'];
const fields = new Set(['position', 'velocity', 'birth', 'life', 'gravity', 'drag', 'sizeM', 'groundY', 'restitution', 'fan', 'pull', 'seed']);

function requireValue(condition, field) {
  if (!condition) throw Object.assign(new TypeError(`Invalid ${field}`), { code: 'usage.bad-argument' });
}
function number(x, field, min = -Infinity, max = Infinity) {
  requireValue(Number.isFinite(x) && x >= min && x <= max, field);
  return x;
}
function vector(v, n, field) {
  requireValue(Array.isArray(v) && v.length === n && Array.from(v).every(Number.isFinite), field);
}
function checkParticle(p) {
  requireValue(p && typeof p === 'object' && Object.keys(p).every(k => fields.has(k)), 'particle');
  vector(p.position, 3, 'position');
  vector(p.velocity, 3, 'velocity');
  number(p.life, 'life', Number.MIN_VALUE);
  for (const key of ['birth', 'gravity', 'groundY']) if (key in p) number(p[key], key);
  for (const key of ['drag', 'fan', 'pull']) if (key in p) number(p[key], key, 0);
  for (const key of ['seed', 'restitution']) if (key in p) number(p[key], key, 0, 1);
  if ('sizeM' in p) number(p.sizeM, 'sizeM', Number.MIN_VALUE);
}

// First and second time integrals of exp(-drag*t). Near zero the second
// integral would lose precision twice through subtraction.
function sample(p, age) {
  const k = p.drag ?? 0;
  const kt = k * age;
  const drift = kt < 0.02 ? age * (1 - kt / 2 + kt * kt / 6) : -Math.expm1(-kt) / k;
  const fall = kt < 0.02 ? age * age * (0.5 - kt / 6) : (age - drift) / k;
  const world = p.position.map((origin, i) => origin + p.velocity[i] * drift);
  world[1] += (p.gravity ?? 0) * fall;
  if (p.groundY !== undefined && world[1] < p.groundY) {
    world[1] = p.groundY + (p.groundY - world[1]) * (p.restitution ?? 0.35);
  }
  return { world, drift };
}

/** Evaluate one birth in world coordinates at a non-negative age in seconds. */
export function ballisticPoint(p, age) {
  checkParticle(p);
  return sample(p, number(age, 'age', 0)).world;
}

export function shapeStep(timeOrMeta, stepFps = 12) {
  const time = typeof timeOrMeta === 'number' ? timeOrMeta : timeOrMeta?.uTime;
  return Math.floor(f32(f32(number(time, 'time')) * f32(number(stepFps, 'stepFps', Number.MIN_VALUE))));
}

function transform(matrix, point, w) {
  return [0, 1, 2, 3].map(i => matrix[i] * point[0] + matrix[4 + i] * point[1] + matrix[8 + i] * point[2] + matrix[12 + i] * w);
}
function checkView(camera, viewport) {
  vector(camera?.matrixWorldInverse, 16, 'view matrix');
  vector(camera?.projectionMatrix, 16, 'projection matrix');
  vector(viewport, 2, 'viewport');
  requireValue(viewport.every(n => n > 0), 'viewport');
}
function pixel(p, world, drift, camera, viewport) {
  const view = camera.matrixWorldInverse;
  const centre = transform(view, world, 1);
  if (p.fan > 0) {
    const [x, y, z] = transform(view, p.velocity, 0);
    const speed = Math.hypot(x, y, z);
    const axial = speed > 0.001 ? Math.abs(z) / speed : 0;
    const u = Math.max(0, Math.min(1, (axial - 0.45) / 0.51));
    const seed = f32(p.seed ?? 0);
    const angle = f32(seed * f32(43.73));
    const phase = f32(seed * f32(91.31));
    const radius = Math.sqrt(phase - Math.floor(phase)) * p.fan * u * u * (3 - 2 * u) * drift;
    centre[0] += radius * Math.cos(angle);
    centre[1] += radius * Math.sin(angle) * 0.7;
  }
  if (p.pull > 0) centre[2] += Math.min(p.pull, -centre[2] / 2);
  const [x, y, , w] = transform(camera.projectionMatrix, centre, 1);
  return w === 0 ? null : [(1 + x / w) * viewport[0] / 2, (1 - y / w) * viewport[1] / 2];
}

function liveSample(p, now, camera, viewport) {
  const age = f32(now) - f32(p.birth ?? 0);
  const norm = f32(f32(age) / f32(Math.max(p.life, 0.0001)));
  if (f32(age) < 0 || norm >= 1 || p.life <= 0) return null;
  const { world, drift } = sample(p, age);
  return { world, age, ...(camera ? { px: pixel(p, world, drift, camera, viewport) } : {}) };
}

function rate(fps) {
  if (typeof fps === 'string') {
    const match = /^(\d+)\/(\d+)$/.exec(fps);
    requireValue(match, 'fps');
    fps = Number(match[1]) / Number(match[2]);
  }
  return number(fps, 'fps', Number.MIN_VALUE);
}

/** Kernel form (inputs, params, frame, sub) or a frame/time in the context. */
export function evaluate(ctx, params, frame = ctx?.frame ?? 0, sub = ctx?.sub ?? 0) {
  requireValue(ctx && Array.isArray(params?.particles), 'particles');
  const fps = rate(ctx.fps ?? 24);
  const tick = number(frame, 'frame') + number(sub, 'sub', 0, 1);
  const time = number(ctx.time ?? ctx.uTime ?? tick / fps, 'time');
  const globalTime = time + number(ctx.shot?.in ?? 0, 'shot.in') / fps;
  const step = shapeStep(globalTime, number(params.stepFps ?? 12, 'stepFps', 0.01, 1000));
  const viewport = ctx.viewport ?? ctx.size;
  if (ctx.camera) checkView(ctx.camera, viewport);
  const particles = [];
  for (const [slot, p] of params.particles.entries()) {
    checkParticle(p);
    const point = liveSample(p, time, ctx.camera, viewport);
    if (point) particles.push({ slot, ...point });
  }
  return { particles, readings: { alive: particles.length, shapeStep: step } };
}

/** Replay the occupied slots of an ordered birth log. Clears take effect
 * after births_before writes, including clears following the final write. */
export function replayBirthFrame(birth, meta, options = {}) {
  requireValue(Array.isArray(birth?.records) && meta && Number.isInteger(meta.frame), 'frame log');
  const now = number(meta.uTime, 'uTime');
  checkView(meta.camera, meta.viewport);
  requireValue(options && typeof options === 'object' && !Array.isArray(options), 'options');
  const dragScale = number(options.dragScale ?? 1, 'dragScale', 0);
  const gravOffset = number(options.gravOffset ?? 0, 'gravOffset');
  requireValue(options.noFan === undefined || typeof options.noFan === 'boolean', 'noFan');
  const slots = pools.map(() => new Map());
  const clears = new Map();
  requireValue(Array.isArray(birth.events ?? []), 'events');
  for (const event of birth.events ?? []) {
    requireValue(event && typeof event.type === 'string' && Number.isInteger(event.frame), 'event');
    if (event.type !== 'clear' || event.frame > meta.frame) continue;
    const pool = pools.indexOf(event.pool);
    const i = event.births_before;
    requireValue(pool >= 0 && Number.isInteger(i) && i >= 0 && i <= birth.records.length, 'clear');
    if (!clears.has(i)) clears.set(i, []);
    clears.get(i).push(pool);
  }
  for (let i = 0; i <= birth.records.length; i++) {
    for (const pool of clears.get(i) ?? []) slots[pool].clear();
    if (i === birth.records.length) break;
    const row = birth.records[i];
    requireValue(row && Number.isInteger(row.frame), 'birth frame');
    if (row.frame > meta.frame) break;
    const pool = pools.indexOf(row.pool);
    requireValue(pool >= 0 && Number.isInteger(row.slot) && row.slot >= 0, 'slot');
    slots[pool].set(row.slot, row.raw);
  }
  const particles = [];
  for (const [pool, occupied] of slots.entries()) {
    for (const slot of Array.from(occupied.keys()).sort((a, b) => a - b)) {
      const raw = occupied.get(slot);
      vector(raw, 24, 'birth record');
      const p = {
        position: raw.slice(0, 3), seed: raw[3], velocity: raw.slice(4, 7), life: raw[7], birth: raw[8],
        drag: Math.max(0, raw[16]) * dragScale, gravity: raw[17] + gravOffset,
        fan: pool <= 1 && !options.noFan ? raw[23] : 0, pull: pool === 3 ? raw[23] : 0,
      };
      const point = liveSample(p, now, meta.camera, meta.viewport);
      if (point) particles.push({ pool, slot, ...point });
    }
  }
  return particles;
}

export { replayBirthFrame as replayFrame };
