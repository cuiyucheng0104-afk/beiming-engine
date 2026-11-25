// Pure-function event-driven thrust impulse field along a 3D spine arclength.

function badArgument(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function requireCondition(condition, message) {
  if (!condition) throw badArgument(message);
}

function requireNumber(value, field, min = -Infinity, max = Infinity) {
  requireCondition(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `Invalid ${field}`);
  return value;
}

function parseRate(fps) {
  if (typeof fps === 'string') {
    const match = /^(\d+)\/(\d+)$/.exec(fps);
    requireCondition(Boolean(match), 'Invalid fps');
    const num = Number(match[1]);
    const den = Number(match[2]);
    requireCondition(den > 0, 'Invalid fps');
    return requireNumber(num / den, 'fps', Number.MIN_VALUE);
  }
  return requireNumber(fps, 'fps', Number.MIN_VALUE);
}

export function clamp(x, min = 0, max = 1) {
  return x < min ? min : x > max ? max : x;
}

export function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function attackDecayPulse(t, t0, attack, release) {
  if (t < t0) return 0;
  if (t < t0 + attack) return smoothstep(t0, t0 + attack, t);
  return Math.exp(-(t - t0 - attack) / release);
}

function normalizeDir(dir) {
  requireCondition(Array.isArray(dir) && dir.length === 3 && dir.every((v) => typeof v === 'number' && Number.isFinite(v)), 'Invalid dir');
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  requireCondition(len > 1e-12, 'Invalid dir: zero vector');
  return [dir[0] / len, dir[1] / len, dir[2] / len];
}

function validateEvent(event) {
  requireCondition(event && typeof event === 'object' && !Array.isArray(event), 'Invalid impulse event');
  const t0 = requireNumber(event.t0, 't0');
  let t1;
  if (event.t1 !== undefined) {
    t1 = requireNumber(event.t1, 't1');
  } else if (event.duration !== undefined) {
    const duration = requireNumber(event.duration, 'duration', Number.MIN_VALUE);
    t1 = t0 + duration;
  } else {
    throw badArgument('Impulse event requires t1 or duration');
  }
  requireCondition(t1 > t0, 'Impulse event requires t1 > t0');
  const dir = normalizeDir(event.dir);
  const reach = event.reach === undefined ? 26 : requireNumber(event.reach, 'reach', Number.MIN_VALUE);
  const whip = event.whip === undefined ? 0 : requireNumber(event.whip, 'whip', 0);
  const tailFade = event.tailFade === undefined ? 0 : requireNumber(event.tailFade, 'tailFade', 0);
  const amp = event.amp === undefined ? 1 : requireNumber(event.amp, 'amp');
  if (event.envelope !== undefined) {
    requireCondition(
      event.envelope === 'smooth-window' || event.envelope === 'attack-decay' || event.envelope === 'cosine',
      'Invalid envelope',
    );
  }
  if (event.terms !== undefined) {
    requireCondition(Array.isArray(event.terms) && event.terms.length > 0, 'Invalid terms');
  }
  if (event.fn !== undefined) {
    requireCondition(typeof event.fn === 'function', 'Invalid fn');
  }
  return { t0, t1, dir, reach, whip, tailFade, amp };
}

function evalScalarTerm(term, t, t0, t1) {
  const amp = term.amp === undefined ? 1 : requireNumber(term.amp, 'amp');
  const kind = term.envelope ?? 'smooth-window';
  const dur = t1 - t0;
  let value;

  if (kind === 'cosine') {
    const u = clamp((t - t0) / dur, 0, 1);
    value = amp * 0.5 * (1 - Math.cos(2 * Math.PI * u));
  } else if (kind === 'attack-decay') {
    const attackStart = term.attackStart === undefined ? t0 : requireNumber(term.attackStart, 'attackStart');
    const attack = term.attack === undefined ? Math.max(1e-4, dur * 0.15) : requireNumber(term.attack, 'attack', Number.MIN_VALUE);
    const release = term.release === undefined ? Math.max(1e-4, dur * 0.35) : requireNumber(term.release, 'release', Number.MIN_VALUE);
    value = amp * attackDecayPulse(t, attackStart, attack, release);
  } else {
    const riseStart = term.riseStart === undefined ? t0 : requireNumber(term.riseStart, 'riseStart');
    const riseEnd = term.riseEnd === undefined ? t0 + dur * 0.25 : requireNumber(term.riseEnd, 'riseEnd');
    const fallStart = term.fallStart === undefined ? t0 + dur * 0.65 : requireNumber(term.fallStart, 'fallStart');
    const fallEnd = term.fallEnd === undefined ? t1 : requireNumber(term.fallEnd, 'fallEnd');
    value = amp * smoothstep(riseStart, riseEnd, t) * (1 - smoothstep(fallStart, fallEnd, t));
  }

  if (term.dip) {
    const { start, end, scale } = term.dip;
    requireNumber(start, 'dip.start');
    requireNumber(end, 'dip.end');
    requireNumber(scale, 'dip.scale');
    value *= 1 - scale * smoothstep(start, end, t);
  }
  return value;
}

/** Evaluate scalar impulse envelope amplitude (metres) at local event time t. */
export function evalEventEnvelope(event, t) {
  const { t0, t1, tailFade } = validateEvent(event);
  requireNumber(t, 'time');
  if (t <= t0 || t >= t1) return 0;

  let base = 0;
  if (typeof event.fn === 'function') {
    base = event.fn(t);
  } else if (Array.isArray(event.terms)) {
    for (const term of event.terms) base += evalScalarTerm(term, t, t0, t1);
  } else {
    base = evalScalarTerm(event, t, t0, t1);
  }

  if (tailFade > 0) {
    base *= 1 - smoothstep(t1 - tailFade, t1, t);
  }
  return base;
}

/** Evaluate summed 3D displacement offset (metres) at (time, arclength). */
export function impulseDisplacementAt(events, time, arclength = 0, bodyLength = 100) {
  requireCondition(Array.isArray(events), 'Invalid events');
  requireNumber(time, 'time');
  requireNumber(arclength, 'arclength', 0);
  requireNumber(bodyLength, 'bodyLength', Number.MIN_VALUE);

  let ox = 0;
  let oy = 0;
  let oz = 0;
  let activeCount = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const { t0, t1, dir, reach, whip, tailFade } = validateEvent(ev);
    const tEnd = t1 + (whip > 0 ? Math.min(bodyLength, reach * 2.2) / whip : 0);
    if (time <= t0 || time >= tEnd) continue;
    const localTime = whip > 0 ? time - arclength / whip : time;
    if (localTime <= t0 || localTime >= t1) continue;

    let mag = 0;
    if (typeof ev.fn === 'function') {
      mag = ev.fn(localTime);
    } else if (Array.isArray(ev.terms)) {
      for (const term of ev.terms) mag += evalScalarTerm(term, localTime, t0, t1);
    } else {
      mag = evalScalarTerm(ev, localTime, t0, t1);
    }
    if (tailFade > 0) {
      mag *= 1 - smoothstep(t1 - tailFade, t1, localTime);
    }

    const q = arclength / reach;
    const decay = Math.exp(-q * q);
    const scale = mag * decay;
    ox += dir[0] * scale;
    oy += dir[1] * scale;
    oz += dir[2] * scale;
    activeCount += 1;
  }

  return { offset: [ox, oy, oz], activeCount };
}

/** Evaluate 3D velocity offset (m/s) via symmetric central difference. */
export function impulseVelocityAt(events, time, arclength = 0, bodyLength = 100, dt = 5e-4) {
  requireNumber(dt, 'velocityDt', 1e-7, 1);
  if (Array.isArray(events) && events.length === 0) {
    requireNumber(time, 'time');
    requireNumber(arclength, 'arclength', 0);
    requireNumber(bodyLength, 'bodyLength', Number.MIN_VALUE);
    return [0, 0, 0];
  }
  const plus = impulseDisplacementAt(events, time + dt, arclength, bodyLength).offset;
  const minus = impulseDisplacementAt(events, time - dt, arclength, bodyLength).offset;
  const inv = 1 / (2 * dt);
  return [(plus[0] - minus[0]) * inv, (plus[1] - minus[1]) * inv, (plus[2] - minus[2]) * inv];
}

/** Evaluate impulse displacement and velocity across an array of arclength stations. */
export function evaluateImpulseStations(events, time, arclengths, bodyLength = 100, dt = 5e-4) {
  requireCondition(Array.isArray(arclengths), 'Invalid arclengths');
  return arclengths.map((s) => {
    const { offset, activeCount } = impulseDisplacementAt(events, time, s, bodyLength);
    const velocity = impulseVelocityAt(events, time, s, bodyLength, dt);
    return { s, offset, velocity, activeCount };
  });
}

/** Standard card/0.1 data evaluate entry. */
export function evaluate(ctx, params, frame = ctx?.frame ?? 0, sub = ctx?.sub ?? 0) {
  requireCondition(ctx && typeof ctx === 'object', 'Invalid ctx');
  requireCondition(params && typeof params === 'object', 'Invalid params');
  requireCondition(Array.isArray(params.events), 'Invalid events');

  const fps = parseRate(ctx.fps ?? 60);
  const tick = requireNumber(frame, 'frame') + requireNumber(sub, 'sub', 0, 1);
  const time = requireNumber(ctx.time ?? ctx.uTime ?? tick / fps, 'time');
  const arclength = requireNumber(params.arclength ?? 0, 'arclength', 0);
  const bodyLength = requireNumber(params.bodyLength ?? 100, 'bodyLength', Number.MIN_VALUE);
  const velocityDt = requireNumber(params.velocityDt ?? 5e-4, 'velocityDt', 1e-7, 1);

  const { offset, activeCount } = impulseDisplacementAt(params.events, time, arclength, bodyLength);
  const velocity = impulseVelocityAt(params.events, time, arclength, bodyLength, velocityDt);
  const result = { time, arclength, offset, velocity, activeCount };
  if (Array.isArray(ctx.arclengths)) {
    result.stations = evaluateImpulseStations(params.events, time, ctx.arclengths, bodyLength, velocityDt);
  }

  return {
    impulse: result,
    readings: {
      activeCount,
      offsetNormM: Math.hypot(offset[0], offset[1], offset[2]),
      speedMps: Math.hypot(velocity[0], velocity[1], velocity[2]),
    },
  };
}
