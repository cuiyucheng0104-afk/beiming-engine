import { stream, streamName } from './rng.mjs';

const zero = [0, 0, 0];
const entityId = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const filmId = /^[a-z][a-z0-9_-]*$/;
const shotId = /^[a-z][a-z0-9-]*$/;

function finite(value) {
  if (!Number.isFinite(value)) throw new TypeError('expected a finite number');
  return value;
}

function vector(row) {
  if (!Array.isArray(row) || row.length !== 3) throw new TypeError('expected a three-component vector');
  return Array.from(row, finite);
}

function unit(row) {
  const length = Math.hypot(...row);
  return length ? row.map(x => x / length) : [0, 1, 0];
}

function sortDistance(position) {
  // A permuted or signed copy of the same vector must tie on distance.
  return Math.hypot(...position.map(Math.abs).sort((a, b) => a - b));
}

function frame(value, min) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`expected an integer frame of at least ${min}`);
  return value;
}

function frameRate(fps) {
  let n, d;
  if (typeof fps === 'string' && /^\d+\/\d+$/.test(fps)) {
    [n, d] = fps.split('/').map(BigInt);
  } else if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) {
    // Use the number's decimal representation, as E5 does with Fraction(str(fps)).
    const [decimal, exponent = '0'] = String(fps).split('e');
    const [integer, fraction = ''] = decimal.split('.');
    const scale = Number(exponent) - fraction.length;
    n = BigInt(integer + fraction) * 10n ** BigInt(Math.max(0, scale));
    d = 10n ** BigInt(Math.max(0, -scale));
  } else {
    throw new TypeError('expected a positive frame rate or fraction');
  }
  if (n === 0n || d === 0n) throw new RangeError('expected a positive frame rate');
  let a = n, b = d;
  while (b) [a, b] = [b, a % b];
  return `${n / a}/${d / a}`;
}

// E5 orders group names by Unicode code point. Entity ids only use ASCII.
function compareGroups(a, b) {
  if (a === b) return 0;
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const delta = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (delta) return delta;
  }
  return left.length - right.length;
}

function replayDraws(samples, id) {
  const row = Object.hasOwn(samples, id) ? samples[id] : undefined;
  if (!Array.isArray(row) || row.length !== 6) throw new TypeError(`expected six replay draws for ${id}`);
  const values = Array.from(row, finite);
  if (values.some(value => value < 0 || value >= 1)) throw new RangeError(`replay draws for ${id} must be in [0, 1)`);
  return values;
}

/** Build E5-compatible snap descriptors and a shot-local arrival event table. */
export function scheduleAssembly(parts, {
  groups = [], fps = 30, seed = 42, start_frame = 0, gap_frames = 3, fly_frames = 18,
  offset_m = 1, spin_deg = 30, film = 'assembly', shot = null, startSamples,
} = {}) {
  if (typeof film !== 'string' || !filmId.test(film) || (shot !== null && (typeof shot !== 'string' || !shotId.test(shot)))) {
    throw new TypeError('invalid film or shot id');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('expected a uint32 seed');
  if (!Array.isArray(parts)) throw new TypeError('expected a list of parts');
  if (!Array.isArray(groups) || Array.from(groups).some(g => typeof g !== 'string') || new Set(groups).size !== groups.length) {
    throw new TypeError('expected unique string group names');
  }
  if (startSamples !== undefined && (startSamples === null || typeof startSamples !== 'object' || Array.isArray(startSamples))) {
    throw new TypeError('expected a record of replay draws by part id');
  }
  const rate = frameRate(fps);
  frame(start_frame, 0); frame(gap_frames, 0); frame(fly_frames, 1);
  if (finite(offset_m) < 0 || finite(spin_deg) < 0) throw new RangeError('expected nonnegative offset and spin');
  const lastArrival = parts.length ? start_frame + (parts.length - 1) * gap_frames + fly_frames : start_frame;
  const frames = frame(lastArrival + 1, 1);

  const priorities = new Map(groups.map((group, i) => [group, i]));
  const seen = new Set();
  const ordered = Array.from(parts, ({ id, group = '', order = 0, rest_pos, rest_rot_deg = zero }) => {
    if (typeof id !== 'string' || !entityId.test(id) || seen.has(id)) throw new TypeError('expected unique entity identifiers');
    if (typeof group !== 'string') throw new TypeError('expected a string group name');
    seen.add(id);
    const position = vector(rest_pos);
    return { id, group, priority: priorities.get(group) ?? groups.length, order: finite(order),
      distance: sortDistance(position), rest_pos: position, rest_rot_deg: vector(rest_rot_deg) };
  });
  ordered.sort((a, b) => a.priority - b.priority || compareGroups(a.group, b.group) || a.order - b.order ||
    a.distance - b.distance || (a.id < b.id ? -1 : 1));

  const rows = ordered.map(({ id, rest_pos, rest_rot_deg }, i) => {
    const t0 = start_frame + i * gap_frames;
    const rng = startSamples === undefined ? stream(streamName(seed, shot ?? film, `assembly/${id}`)) : undefined;
    const draws = rng ? Array.from({ length: 6 }, () => rng.next()) : replayDraws(startSamples, id);
    const jitter = draws.slice(0, 3).map(draw => -1 + 2 * draw);
    const radial = unit(rest_pos.some(x => x !== 0) ? rest_pos : jitter);
    const direction = unit(radial.map((x, k) => x + 0.25 * jitter[k]));
    const start_offset = direction.map(x => x * offset_m);
    const start_rot_deg = rest_rot_deg.map((x, k) => finite(x + (-spin_deg + 2 * spin_deg * draws[k + 3])));
    return { id, t0, fly_frames, arrive: t0 + fly_frames, rest_pos, rest_rot_deg, start_offset, start_rot_deg };
  });
  const events = rows.map(({ id, arrive }) => ({ id: `arrive.${id}`, frame: arrive, sub: 0, kind: 'arrive',
    from: 'tracks', entity: id, ...(shot === null ? {} : { shot }) }));
  events.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : 1));
  return { parts: rows, events: { format: 'events/0.1', film, fps: rate, frames, events } };
}
