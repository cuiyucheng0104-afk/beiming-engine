// E5 choreography descriptors use metres, frames and XYZ Euler angles in degrees.
const zero = [0, 0, 0];

function number(value) {
  if (!Number.isFinite(value)) throw new TypeError('expected a finite number');
  return value;
}

function vector(value) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError('expected a three-component vector');
  return Array.from(value, number);
}

/** Sample one scheduled part. t0 and fly_frames come directly from the E5 schedule. */
export function evalSnapMotion(frame, {
  t0, fly_frames, rest_pos, rest_rot_deg, start_offset, start_rot_deg, overshoot = 0.045, settle_frames = 6,
}) {
  const elapsed = number(frame) - number(t0);
  if (number(fly_frames) <= 0 || number(overshoot) < 0 || number(settle_frames) < 0) {
    throw new RangeError('invalid flight or settling interval');
  }
  const rest = vector(rest_pos), rotation = vector(rest_rot_deg);
  const offset = vector(start_offset), initial = vector(start_rot_deg);
  if (elapsed <= 0) return { position: rest.map((v, k) => v + offset[k]), rotation_deg: initial };
  if (elapsed >= fly_frames) return { position: rest, rotation_deg: rotation };

  const settle = Math.min(settle_frames, fly_frames / 2);
  const contact = fly_frames - settle;
  let remaining;
  if (elapsed <= contact) {
    remaining = (1 - elapsed / contact) ** 3;
  } else {
    const u = (elapsed - contact) / settle;
    remaining = -overshoot * Math.sin(2 * Math.PI * u) * Math.exp(-3 * u) * (1 - u) ** 2;
  }
  return {
    position: rest.map((v, k) => v + offset[k] * remaining),
    rotation_deg: rotation.map((v, k) => v + (initial[k] - v) * remaining),
  };
}

// Preserve the low bits of each intermediate sum like Python's math.fsum.
// Cancellation near the centroid can otherwise reverse a part's radial direction.
function sumAxis(rows, axis) {
  const partials = [];
  for (const { position } of rows) {
    let x = position[axis], count = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const high = x + y;
      const low = y - (high - x);
      if (low !== 0) partials[count++] = low;
      x = high;
    }
    partials.length = count;
    partials.push(x);
  }
  let high = partials.pop();
  while (partials.length) {
    const x = high, y = partials.pop();
    high = x + y;
    const low = y - (high - x);
    if (low !== 0) {
      // Round a halfway case toward the remaining same-sign residual.
      const correction = 2 * low;
      if (Math.sign(partials.at(-1)) === Math.sign(low) && (high + correction) - high === correction) {
        high += correction;
      }
      break;
    }
  }
  return high;
}

/** Return each part's world position for a clamped unitless explosion progress. */
export function evalExplode(parts, progress, {
  axis_weights = [1, 1, 1], scale_m = 1, center = null, group_offsets = {},
} = {}) {
  const seen = new Set();
  if (!Array.isArray(parts)) throw new TypeError('expected a list of parts');
  const rows = parts.map(({ id, rest_pos, group = '' }) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(id) || seen.has(id)) {
      throw new TypeError('expected unique entity identifiers');
    }
    seen.add(id);
    return { id, position: vector(rest_pos), group };
  });
  const fraction = Math.max(0, Math.min(1, number(progress)));
  const weights = vector(axis_weights);
  if (number(scale_m) < 0 || weights.some(w => w < 0)) throw new RangeError('negative explosion scale or weight');
  if (!rows.length || !fraction) return Object.fromEntries(rows.map(({ id, position }) => [id, position]));
  const origin = center === null ? zero.map((_, k) => sumAxis(rows, k) / rows.length) : vector(center);
  return Object.fromEntries(rows.map(({ id, position, group }) => {
    const delta = position.map((v, k) => v - origin[k]);
    const length = Math.hypot(...delta);
    const offset = group_offsets && Object.hasOwn(group_offsets, group) ? vector(group_offsets[group]) : zero;
    return [id, position.map((v, k) => {
      const radial = length ? delta[k] / length : 0;
      return v + fraction * (scale_m * radial * weights[k] + offset[k]);
    })];
  }));
}
