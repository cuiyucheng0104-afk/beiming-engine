"""Deterministic Blender choreography in North coordinates (+Y up, metres, degrees).

Solvers and the tracks codec run without Blender. Only apply_object_pose needs
mathutils; callers can sample any frame or subframe without playback state.
"""

from collections import deque
from fractions import Fraction
from itertools import product
import json
import math
from pathlib import Path
import random
import re
import struct


_STRIDES = {"scalar": 1, "vec3": 3, "quat": 4, "camera": 8, "bbox": 6}
_INDEX_KEYS = {"name", "type", "stride", "offset", "count"}
_ZERO = (0.0, 0.0, 0.0)
_ENTITY = re.compile(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*")


def _number(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("expected a finite number")
    return value


def _vector(value, width=3):
    if not isinstance(value, (list, tuple)) or len(value) != width:
        raise ValueError(f"expected a vector of width {width}")
    return tuple(_number(x) for x in value)


def _samples_of(kind, sample):
    if kind == "scalar":
        return (_number(sample),)
    if kind == "camera":
        return (*_vector(sample["pos"]), *_vector(sample["quat"], 4), _number(sample["fovDeg"]))
    if kind == "bbox":
        return (*_vector(sample["min"]), *_vector(sample["max"]))
    return _vector(sample, _STRIDES[kind])


def _sample_from(kind, row):
    if kind == "scalar":
        return row[0]
    if kind == "camera":
        return {"pos": row[:3], "quat": row[3:7], "fovDeg": row[7]}
    if kind == "bbox":
        return {"min": row[:3], "max": row[3:]}
    return row


def encode_tracks(track_map, meta=None):
    """Return (index dict, bytes) with JS UTF-16 name order and little-endian floats."""
    if not isinstance(track_map, dict) or any(not isinstance(k, str) for k in track_map):
        raise ValueError("track_map needs string track names")
    index = {"format": "tracks/0.1", "meta": json.loads(json.dumps({} if meta is None else meta, allow_nan=False)), "tracks": []}
    bin_data = bytearray()
    for name in sorted(track_map, key=lambda s: s.encode("utf-16-be", "surrogatepass")):
        track = track_map[name]
        if not isinstance(track, dict):
            raise ValueError(f"invalid track {name!r}")
        kind, samples = track.get("type"), track.get("samples")
        if not isinstance(kind, str) or kind not in _STRIDES or not isinstance(samples, (list, tuple)):
            raise ValueError(f"invalid track type or samples for {name!r}")
        stride = _STRIDES[kind]
        index["tracks"].append(dict(name=name, type=kind, stride=stride, offset=len(bin_data), count=len(samples)))
        packer = struct.Struct(f"<{stride}f")
        for sample in samples:
            try:
                bin_data.extend(packer.pack(*_samples_of(kind, sample)))
            except (KeyError, TypeError, ValueError, OverflowError, struct.error) as exc:
                raise ValueError(f"invalid float32 sample in {name!r}") from exc
    return index, bytes(bin_data)


def decode_tracks(index_json, bin_bytes):
    """Read a contiguous tracks/0.1 byte view; reject holes, duplicates and nonfinite values."""
    if isinstance(index_json, (str, bytes)):
        index_json = json.loads(index_json)
    if (not isinstance(index_json, dict) or index_json.get("format") != "tracks/0.1"
            or not isinstance(index_json.get("tracks"), list)):
        raise ValueError("invalid tracks index")
    data = memoryview(bin_bytes).cast("B")
    out, cursor = {}, 0
    for entry in index_json["tracks"]:
        if not isinstance(entry, dict) or entry.keys() != _INDEX_KEYS:
            raise ValueError("invalid track index fields")
        name, kind = entry["name"], entry["type"]
        stride, offset, count = entry["stride"], entry["offset"], entry["count"]
        if (not isinstance(name, str) or name in out or not isinstance(kind, str)
                or kind not in _STRIDES or any(type(x) not in (int, float) for x in (stride, offset, count))
                or stride != _STRIDES[kind] or offset != cursor or not 0 <= count <= 2**53 - 1 or int(count) != count):
            raise ValueError("invalid track name, type or bounds")
        stride, count = int(stride), int(count)
        end = cursor + 4 * stride * count
        if end > len(data):
            raise ValueError("track data truncated")
        samples = []
        for row in struct.iter_unpack(f"<{stride}f", data[cursor:end]):
            if not all(map(math.isfinite, row)):
                raise ValueError(f"nonfinite float32 sample in {name!r}")
            samples.append(_sample_from(kind, list(row)))
        out[name] = {"type": kind, "samples": samples}
        cursor = end
    if cursor != len(data):
        raise ValueError("trailing track bytes")
    return out


def write_tracks(out_dir, track_map, meta=None):
    """Write tracks.json and tracks.bin; return their paths."""
    index, data = encode_tracks(track_map, meta)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    index_path, bin_path = out_dir / "tracks.json", out_dir / "tracks.bin"
    index_path.write_bytes((json.dumps(index, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8"))
    bin_path.write_bytes(data)
    return index_path, bin_path


def _unit(v):
    length = math.hypot(*v)
    return tuple(x / length for x in v) if length else (0.0, 1.0, 0.0)


def _parts(parts):
    seen = set()
    for p in parts:
        name = p["id"]
        if not isinstance(name, str) or not _ENTITY.fullmatch(name) or name in seen:
            raise ValueError("part id must be unique and match the entity syntax")
        seen.add(name)
        yield p, name, _vector(p["rest_pos"])


def schedule_assembly(parts, groups=None, fps=30, seed=42, *, start_frame=0,
                      gap_frames=3, fly_frames=18, offset_m=1.0, spin_deg=30.0,
                      film="assembly", shot=None):
    """Sort by group priority, explicit order, distance from origin, then id.

    Offset and rotation use independent, per-part seeded streams so reordering
    input (or adding a part) does not change the others' starting poses.
    """
    fps = Fraction(str(fps))
    if fps <= 0 or not isinstance(film, str) or not re.fullmatch(r"[a-z][a-z0-9_-]*", film):
        raise ValueError("invalid fps or film id")
    if shot is not None and (not isinstance(shot, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", shot)):
        raise ValueError("invalid shot id")
    if any(type(x) is not int for x in (start_frame, gap_frames, fly_frames)) or min(start_frame, gap_frames) < 0 or fly_frames < 1:
        raise ValueError("expected nonnegative integer start/gap and positive integer flight")
    if min(_number(offset_m), _number(spin_deg)) < 0:
        raise ValueError("offset and spin amplitudes must be nonnegative")
    group_order = {name: i for i, name in enumerate(groups or ())}

    def key(row):
        p, name, pos = row
        group = p.get("group", "")
        return (group_order.get(group, len(group_order)), group, _number(p.get("order", 0)), math.hypot(*pos), name)

    table, events = [], []
    for i, (p, name, rest) in enumerate(sorted(_parts(parts), key=key)):
        at = start_frame + i * gap_frames
        rng = random.Random(f"{seed}/assembly/{name}")
        jitter = tuple(rng.uniform(-1, 1) for _ in range(3))
        radial = _unit(rest) if any(rest) else _unit(jitter)
        direction = _unit(tuple(x + 0.25 * j for x, j in zip(radial, jitter)))
        rotation = _vector(p.get("rest_rot_deg", _ZERO))
        arrival = at + fly_frames
        table.append(dict(id=name, t0=at, fly_frames=fly_frames, arrive=arrival,
                          rest_pos=rest, rest_rot_deg=rotation,
                          start_offset=tuple(x * offset_m for x in direction),
                          start_rot_deg=tuple(x + rng.uniform(-spin_deg, spin_deg) for x in rotation)))
        event = {"id": f"arrive.{name}", "frame": arrival, "sub": 0, "kind": "arrive", "from": "tracks", "entity": name}
        if shot is not None:
            event["shot"] = shot
        events.append(event)
    events.sort(key=lambda e: (e["frame"], e["id"]))
    return {"parts": table, "events": {"format": "events/0.1", "film": film, "fps": f"{fps.numerator}/{fps.denominator}",
                                       "frames": max((e["frame"] for e in events), default=start_frame) + 1, "events": events}}


def eval_snap_motion(t, t0, fly_frames, rest_pos, rest_rot_deg, start_offset, start_rot_deg,
                     overshoot=0.045, settle_frames=6):
    """Smooth flight, then a windowed damped rebound inside the flight interval.

    Time is in frames; start_rot_deg is the absolute initial XYZ Euler pose.
    The final half at most can be reserved for settling; zero settling keeps
    the smooth flight without ringing. Endpoints are returned exactly.
    """
    elapsed = _number(t) - _number(t0)
    if _number(fly_frames) <= 0 or _number(overshoot) < 0 or _number(settle_frames) < 0:
        raise ValueError("invalid flight or settling interval")
    rest, rotation, offset, initial = map(_vector, (rest_pos, rest_rot_deg, start_offset, start_rot_deg))
    if elapsed <= 0:
        return {"position": tuple(x + y for x, y in zip(rest, offset)), "rotation_deg": initial}
    if elapsed >= fly_frames:
        return {"position": rest, "rotation_deg": rotation}
    settle = min(settle_frames, fly_frames / 2)
    contact = fly_frames - settle
    if elapsed <= contact:
        u = elapsed / contact
        remaining = (1 - u)**3
    else:
        u = (elapsed - contact) / settle
        remaining = -overshoot * math.sin(math.tau * u) * math.exp(-3 * u) * (1 - u)**2
    return {"position": tuple(x + dx * remaining for x, dx in zip(rest, offset)),
            "rotation_deg": tuple(x + (a - x) * remaining for x, a in zip(rotation, initial))}


def eval_explode(parts, progress, axis_weights=(1, 1, 1), scale_m=1.0, center=None, *, group_offsets=None):
    """Move radially out from the centroid (or explicit centre), plus group offsets.

    Each part follows a straight line, so its displacement from rest is
    monotone for increasing progress. A part exactly at the centre has no
    radial direction and moves only by its group offset.
    """
    rows = list(_parts(parts))
    progress = min(max(_number(progress), 0), 1)
    weights = _vector(axis_weights)
    if min(weights) < 0 or _number(scale_m) < 0:
        raise ValueError("axis weights and scale must be nonnegative")
    if not rows or progress == 0:
        return {name: pos for _, name, pos in rows}
    if center is None:
        # Sort before summation: the centroid is also independent of input order.
        ordered = [row[2] for row in sorted(rows, key=lambda row: row[1])]
        center = tuple(math.fsum(axis) / len(rows) for axis in zip(*ordered))
    else:
        center = _vector(center)
    out = {}
    for p, name, pos in rows:
        delta = tuple(x - origin for x, origin in zip(pos, center))
        radial = _unit(delta) if any(delta) else _ZERO
        group = _vector((group_offsets or {}).get(p.get("group"), _ZERO))
        out[name] = tuple(x + progress * (scale_m * a * w + b) for x, a, w, b in zip(pos, radial, weights, group))
    return out


def _sin_deg(deg):
    if deg % 180 == 0:
        return 0.0
    return math.sin(math.radians(deg))


def _cos_deg(deg):
    if (deg - 90) % 180 == 0:
        return 0.0
    return math.cos(math.radians(deg))


def _window_max(values, radius):
    """Centered, edge-truncated moving maximum, linear in frame count."""
    candidates = deque()
    right = 0
    for i in range(len(values)):
        while right < min(len(values), i + radius + 1):
            while candidates and values[candidates[-1]] <= values[right]:
                candidates.pop()
            candidates.append(right)
            right += 1
        while candidates[0] < i - radius:
            candidates.popleft()
        yield values[candidates[0]]


def solve_dynamic_camera_fit(frame_bboxes, azimuth_deg, elevation_deg, fov_y_deg, aspect,
                             margin=0.9, window_frames=15, smooth_alpha=0.15, ground_y=0.0,
                             ground_clearance_m=0.05, near_clip_m=0.05, use_sliding_max=True, *, orbit=False):
    """Solve a perspective pose per frame from the eight world AABB corners.

    The centred max anticipates expansion; EMA damps motion and the final
    raw-distance guard preserves framing. In the no-max control, only the
    near/ground bounds are enforced after EMA. If an upward-looking shot
    would go underground, level the whole sequence rather than jump angles.
    """
    for value in (azimuth_deg, elevation_deg, fov_y_deg, aspect, margin, smooth_alpha,
                  ground_y, ground_clearance_m, near_clip_m):
        _number(value)
    if (not 0 < fov_y_deg < 180 or aspect <= 0 or not 0 < margin <= 1
            or not 0 < smooth_alpha <= 1 or type(window_frames) is not int or window_frames < 0
            or ground_clearance_m < 0 or near_clip_m <= 0):
        raise ValueError("invalid camera optics, window, smoothing or clearance")
    boxes = [(_vector(b["min"]), _vector(b["max"])) for b in frame_bboxes]
    if any(any(a > b for a, b in zip(lo, hi)) for lo, hi in boxes):
        raise ValueError("inverted camera bounding box")
    if not boxes:
        return []
    floor = ground_y + ground_clearance_m
    sa, ca = _sin_deg(azimuth_deg), _cos_deg(azimuth_deg)
    ky = margin * math.tan(math.radians(fov_y_deg) / 2)
    kx = ky * aspect

    def solve(elevation):
        se, ce = _sin_deg(elevation), _cos_deg(elevation)
        targets, raw, hard = [], [], []
        for lo, hi in boxes:
            tx, ty, tz = (a / 2 + b / 2 for a, b in zip(lo, hi))
            if se == 0:
                ty = max(ty, floor)
            targets.append((tx, ty, tz))
            dist, nearest = -math.inf, -math.inf
            for xx, yy, zz in product(*zip(lo, hi)):
                x, y, z = xx - tx, yy - ty, zz - tz
                if orbit:
                    radius = math.hypot(x, z)
                    nearest = max(nearest, y * se + radius * abs(ce))
                    dist = max(dist, y * se + radius * math.hypot(ce, 1 / kx))
                    for sign in (-1, 1):
                        dist = max(dist, y * (se + sign * ce / ky) + radius * abs(ce - sign * se / ky))
                else:
                    h = x * sa + z * ca
                    back = h * ce + y * se
                    nearest = max(nearest, back)
                    dist = max(dist, back + max(abs(x * ca - z * sa) / kx, abs(y * ce - h * se) / ky))
            bound = max(near_clip_m, nearest + near_clip_m)
            if se > 0:
                bound = max(bound, (floor - ty) / se)
            hard.append(bound)
            raw.append(max(bound, dist))
        values = _window_max(raw, window_frames) if use_sliding_max else raw
        sh, ch = _sin_deg(elevation / 2), _cos_deg(elevation / 2)
        sa2, ca2 = _sin_deg(azimuth_deg / 2), _cos_deg(azimuth_deg / 2)
        quat = (-ca2 * sh, sa2 * ch, sa2 * sh, ca2 * ch)
        out, ema = [], None
        for i, value in enumerate(values):
            ema = value if ema is None else smooth_alpha * value + (1 - smooth_alpha) * ema
            distance = max(ema, raw[i] if use_sliding_max else hard[i])
            target = targets[i]
            horizontal = distance * ce
            pos = (target[0] + horizontal * sa, target[1] + distance * se, target[2] + horizontal * ca)
            if not all(map(math.isfinite, (*pos, distance))):
                raise ValueError("camera pose is nonfinite")
            out.append(dict(position=pos, target=target, distance=distance, fovYDeg=fov_y_deg, quaternion=quat))
        return out

    poses = solve(elevation_deg)
    if _sin_deg(elevation_deg) < 0 and any(row["position"][1] < floor for row in poses):
        return solve(0)
    return poses


def eval_camera_shake(f, impulses, decay_frames=8.0, freq_hz=18.0, fps=30.0,
                      amp_pos_m=0.02, amp_rot_deg=0.8, enabled=True):
    """Sum causal, damped position and rotation impulses, in world axes."""
    if not enabled or (amp_pos_m == 0 and amp_rot_deg == 0):
        return {"position": _ZERO, "rotation_deg": _ZERO}
    if min(_number(decay_frames), _number(fps)) <= 0 or min(_number(freq_hz), _number(amp_pos_m), _number(amp_rot_deg)) < 0:
        raise ValueError("invalid camera shake parameters")
    position, rotation = [], []
    for impulse in impulses:
        dt = _number(f) - _number(impulse["frame"])
        strength = _number(impulse.get("strength", 1))
        if dt < 0 or strength == 0:
            continue
        strength *= math.exp(-dt / decay_frames)
        phase = dt * math.tau * freq_hz / fps
        s = math.sin(phase + 0.4)
        c = math.cos(phase * 1.26)
        r = math.sin(phase * 0.83 + 0.9)
        position.append((0.6 * s * strength, c * strength, 0.2 * r * strength))
        rotation.append((0.4 * c * strength, 0.3 * r * strength, s * strength))

    def sum_axes(rows, amp):
        return tuple(math.fsum(axis) * amp for axis in zip(*rows)) if rows and amp else _ZERO

    return {"position": sum_axes(position, amp_pos_m), "rotation_deg": sum_axes(rotation, amp_rot_deg)}


def apply_object_pose(obj, position, rotation_deg=None):
    """Apply an absolute parent-local North transform to a Blender object."""
    x, y, z = _vector(position)
    obj.location = (x, -z, y)
    if rotation_deg is not None:
        from mathutils import Euler, Matrix

        basis = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
        rot = Euler(tuple(map(math.radians, _vector(rotation_deg))), "XYZ").to_matrix()
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = (basis @ rot @ basis.transposed()).to_quaternion()


def _ref_camera_smooth(u):
    u = min(1, max(0, u))
    return u * u * (3 - 2 * u)


def _ref_camera_blend(a, b, u):
    return tuple(x + (y - x) * u for x, y in zip(a, b))


def _ref_camera_boxcar(values, radius):
    for i in range(len(values)):
        window = values[max(0, i - radius):i + radius + 1]
        yield sum(window) / len(window)


def _ref_camera_spline(keys, elapsed):
    if elapsed <= keys[0][0]:
        return keys[0][1]
    if elapsed >= keys[-1][0]:
        return keys[-1][1]
    i = next(i for i in range(len(keys) - 1) if elapsed < keys[i + 1][0])
    t0, p0 = keys[i]
    t1, p1 = keys[i + 1]
    duration = t1 - t0
    u = (elapsed - t0) / duration
    before = keys[i - 1] if i else None
    after = keys[i + 2] if i + 2 < len(keys) else None
    # Convert neighbouring secants to cubic Bézier control offsets.
    d0 = duration / (3 * (t1 - before[0])) if before else 0
    d1 = duration / (3 * (after[0] - t0)) if after else 0
    c0 = tuple(x + (y - z) * d0 for x, y, z in zip(p0, p1, before[1])) if before else p0
    c1 = tuple(x - (y - z) * d1 for x, y, z in zip(p1, after[1], p0)) if after else p1
    l0, l1, l2 = (_ref_camera_blend(a, b, u) for a, b in ((p0, c0), (c0, c1), (c1, p1)))
    return _ref_camera_blend(_ref_camera_blend(l0, l1, u), _ref_camera_blend(l1, l2, u), u)


def reference_camera(spec, corners_at, frame_count, *, use_sliding_max=True):
    """Evaluate a z-up staged camera rig from authored optical/motion controls.

    Unlike AABB-centred fit, this rig can balance the top/bottom constraints
    by solving for target height, follow moving oriented-box corners, and
    hand off to authored hero poses. `views` holds (frame, az/el/margin,
    smoothstep exponent) keys, `corners_at` gives world corners at a frame.
    No observed frame/pose is needed as input.
    """
    lens, aspect, sensor = (spec[key] for key in ("lens", "aspect", "sensor_width"))
    cadence = spec["fit_stride"]
    views = spec["views"]

    def view(frame):
        for (a, start, _), (b, end, exponent) in zip(views, views[1:]):
            if frame <= b:
                return _ref_camera_blend(start, end, _ref_camera_smooth((frame - a) / (b - a)) ** exponent)
        return views[-1][1]

    def basis(az, el):
        a, e = map(math.radians, (az, el))
        sa, ca, se, ce = math.sin(a), math.cos(a), math.sin(e), math.cos(e)
        return (ca, sa, 0), (-sa * se, ca * se, ce), (sa * ce, -ca * ce, se)

    fit_end = spec["fit_end"]
    heights, distances = [], []
    for f in range(0, fit_end + 1, cadence):
        az, el, margin = view(f)
        right, up, back = basis(az, el)
        kx = sensor * margin / (2 * lens)
        ky = kx / aspect
        top = bottom = side = -math.inf
        for x, y, z in corners_at(f):
            horiz = x * right[0] + y * right[1]
            vert = x * up[0] + y * up[1] + z * up[2]
            depth = x * back[0] + y * back[1] + z * back[2]
            top = max(top, depth + vert / ky)
            bottom = max(bottom, depth - vert / ky)
            side = max(side, depth + abs(horiz) / kx)
        height = (top - bottom) * ky / (2 * up[2])
        distance = max(top - height * up[2] / ky, side) - height * back[2]
        heights.extend([height] * cadence)
        distances.extend([distance] * cadence)
    heights, distances = heights[:fit_end + 1], distances[:fit_end + 1]
    if use_sliding_max:
        distances = list(_window_max(distances, spec["fit_window"]))
    for _ in range(spec["smooth_passes"]):
        heights = list(_ref_camera_boxcar(heights, spec["height_window"]))
        distances = list(_ref_camera_boxcar(distances, spec["distance_window"]))

    scale = spec["height"]
    shots = spec["poses"]
    switch = spec["pose_start"]
    guide = None
    if spec["curve"] == "spline":
        az, el, _ = view(switch)
        full = (az, el, distances[-1] / scale, heights[-1] / scale, lens, 0)
        guide = [(f, full if pose is None else pose) for f, pose in shots]

    cameras, targets, unshaken = [], [], []
    for f in range(frame_count):
        az, el, _ = view(f)
        i = min(f, fit_end)
        pose = (az, el, distances[i] / scale, heights[i] / scale, lens, 0)
        if f > switch:
            elapsed = f - switch
            if guide:
                pose = _ref_camera_spline(guide, elapsed)
            else:
                for j, (b, dest, curve, power) in enumerate(shots):
                    a, start = (shots[j - 1][0], shots[j - 1][1]) if j else (0, pose)
                    if elapsed <= b or j == len(shots) - 1:
                        u = min(1, (elapsed - a) / (b - a))
                        w = _ref_camera_smooth(u) ** power if curve == "smooth" else 1 - (1 - u) ** power
                        pose = _ref_camera_blend(start, dest, w)
                        break
        az, el, distance, height, focal, pan = pose
        distance, height, pan = distance * scale, height * scale, pan * scale
        floor = spec.get("ground")
        if floor is not None and height + distance * math.sin(math.radians(el)) < floor:
            el = math.degrees(math.asin(max(-1, min(1, (floor - height) / distance))))
        right, _, back = basis(az, el)
        target = (right[0] * pan, right[1] * pan, height)
        pos = tuple(x + distance * z for x, z in zip(target, back))
        offset = [0.0, 0.0, 0.0]
        for t, amount in spec.get("impulses", ()):
            dt = f - t
            decay, horizon, omega_x, omega_z, phase_x, balance = spec["shake"]
            if 0 <= dt < horizon:
                amp = amount * scale * math.exp(-dt / decay)
                offset[0] += amp * balance * math.sin(dt * omega_x + phase_x)
                offset[2] += amp * math.cos(dt * omega_z)
        a, x = math.radians(az) / 2, math.radians(90 - el) / 2
        ca, sa, cx, sx = math.cos(a), math.sin(a), math.cos(x), math.sin(x)
        cameras.append({"pos": tuple(p + d for p, d in zip(pos, offset)),
                        "quat": (ca * sx, sa * sx, sa * cx, ca * cx),
                        "fovDeg": math.degrees(2 * math.atan(sensor / (2 * focal * aspect)))})
        targets.append(target)
        unshaken.append(pos)
    return cameras, targets, unshaken


# Independent affine solver for authored flight stages, joint controls and root motion.
# Model-space affines store twelve row-major components.

_REF_IDENTITY = (1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.)
_REF_AXES = ((1., 0., 0.), (0., 1., 0.), (0., 0., 1.))


def _ref_dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _ref_cross(a, b):
    x, y, z = a
    p, q, r = b
    return (y * r - z * q, z * p - x * r, x * q - y * p)


def _ref_unit(v):
    length = math.hypot(*v)
    if not length:
        raise ValueError('zero-length direction')
    return tuple(x / length for x in v)


def _ref_affine(rows):
    return tuple(x for row in rows[:3] for x in row)


def _ref_translate(matrix, offset):
    x, y, z = offset
    a, b, c, d, e, f, g, h, i, j, k, m = matrix
    return (a, b, c, d + x, e, f, g, h + y, i, j, k, m + z)


def _ref_point(matrix, point):
    x, y, z = point
    a, b, c, d, e, f, g, h, i, j, k, m = matrix
    return (a * x + b * y + c * z + d, e * x + f * y + g * z + h, i * x + j * y + k * z + m)


def _ref_product(left, right):
    a, b, c, d, e, f, g, h, i, j, k, m = left
    n, o, p, q, r, s, t, u, v, w, x, y = right
    return (
        a*n + b*r + c*v, a*o + b*s + c*w, a*p + b*t + c*x, a*q + b*u + c*y + d,
        e*n + f*r + g*v, e*o + f*s + g*w, e*p + f*t + g*x, e*q + f*u + g*y + h,
        i*n + j*r + k*v, i*o + j*s + k*w, i*p + j*t + k*x, i*q + j*u + k*y + m,
    )


def _ref_rotation(axis, angle):
    x, y, z = _ref_unit(axis)
    s, c = math.sin(angle), math.cos(angle)
    k = 1 - c
    return (c+x*x*k, x*y*k-z*s, x*z*k+y*s, 0.,
            y*x*k+z*s, c+y*y*k, y*z*k-x*s, 0.,
            z*x*k-y*s, z*y*k+x*s, c+z*z*k, 0.)


def _ref_anchor(rotation, before, after):
    """A rigid transform mapping the point `before` to `after`."""
    rotated = _ref_point(rotation, before)
    return _ref_translate(rotation, tuple(b - a for a, b in zip(rotated, after)))


_REF_FLOAT = struct.Struct('<f')


def _ref_f32(x):
    return _REF_FLOAT.unpack(_REF_FLOAT.pack(x))[0]


def _ref_fvector(v):
    return tuple(map(_ref_f32, v))


def _ref_fdot(a, b):
    # An affine compatibility mode preserves float32 operand precision while
    # accumulating the rounded products before committing the result.
    return sum(_ref_f32(x * y) for x, y in zip(a, b))


def _ref_fadd(a, b, scale=1.):
    scale = _ref_f32(scale)
    return _ref_fvector(x + _ref_f32(y * scale) for x, y in zip(a, b))


def _ref_fcross(a, b):
    x, y, z = a
    p, q, r = b
    return _ref_fvector((_ref_f32(y*r)-_ref_f32(z*q),
                         _ref_f32(z*p)-_ref_f32(x*r),
                         _ref_f32(x*q)-_ref_f32(y*p)))


def _ref_funit(v):
    size = _ref_f32(math.sqrt(sum(x*x for x in v)))
    return _ref_fvector(x * _ref_f32(1. / size) for x in v)


def _ref_fpoint(matrix, point):
    return _ref_fvector(_ref_fdot(matrix[i:i+4], (*point, 1.)) for i in (0, 4, 8))


def _ref_fproduct(a, b):
    columns = [(*b[i::4], float(i == 3)) for i in range(4)]
    return _ref_fvector(_ref_fdot(a[i:i+4], col) for i in (0, 4, 8) for col in columns)


def _ref_frotation(axis, angle):
    f = _ref_f32
    pi = f(math.pi)
    turn = _ref_f32(math.tau)
    phase = f(math.fmod(f(f(angle) + pi), turn))
    phase = f((f(phase + turn) if phase < 0. else phase) - pi)
    s, c = f(math.sin(phase)), f(math.cos(phase))
    x, y, z = _ref_funit(axis)
    k = f(1 - c)
    xx, yy, zz, xy, xz, yz = (f(f(a*b)*k) for a,b in ((x,x), (y,y), (z,z), (x,y), (x,z), (y,z)))
    xs, ys, zs = f(x*s), f(y*s), f(z*s)
    return _ref_fvector((c+xx, xy-zs, xz+ys, 0., xy+zs, c+yy, yz-xs, 0., xz-ys, yz+xs, c+zz, 0.))


def _ref_fanchor(rotation, before, after):
    shift = _ref_translate(_REF_IDENTITY, _ref_fvector(-x for x in before))
    return _ref_fproduct(_ref_translate(rotation, after), shift)


def _ref_clamp(n):
    return max(0., min(n, 1.))


def _ref_flight(part, frame, floor, single=False):
    mul = _ref_fproduct if single else _ref_product
    point = _ref_fpoint if single else _ref_point
    rotation = _ref_frotation if single else _ref_rotation
    anchor = _ref_fanchor if single else _ref_anchor
    local = part['rest']
    active = False
    for move in part['moves']:
        u = (frame - move['start']) / move['duration']
        if u >= 1:
            continue
        active = True
        remaining = (1 - _ref_clamp(u)) ** move['ease_power']
        turn = 1 - (1 - _ref_clamp(u / move['turn_fraction'])) ** move['ease_power']
        profile = move['turn']
        progress = {'arrive': 1 - turn, 'revolve': turn, 'rock': 4 * turn * (1 - turn)}[profile]
        arc = move['arc_gain'] * (1 - remaining) * remaining * remaining
        if single:
            offset = _ref_fvector(x * _ref_f32(remaining) for x in move['offset'])
            side = _ref_fvector(x * _ref_f32(arc) for x in move['side'])
            destination = _ref_fadd(_ref_fadd(offset, side), move['pivot'])
        else:
            destination = tuple(p + a * remaining + b * arc for p, a, b in
                                zip(move['pivot'], move['offset'], move['side']))
        if single:
            # Preserve the authored transform layers: a large rest offset
            # and its inverse can cancel after each matrix product.
            rotate = mul(_ref_translate(rotation(move['axis'], move['angle'] * progress), destination),
                         _ref_translate(_REF_IDENTITY, (-x for x in move['pivot'])))
        else:
            rotate = anchor(rotation(move['axis'], move['angle'] * progress), move['pivot'], destination)
        local = mul(rotate, local)
    local = mul(part['basis'], local)
    if active:
        low = min(point(local, corner)[2] for corner in part['corners'])
        if low < floor:
            shift = (0., 0., floor - low)
            local = mul(_ref_translate(_REF_IDENTITY, _ref_fvector(shift)), local) if single else _ref_translate(local, shift)
    return local


def _ref_add(a, b, scale=1.):
    return tuple(x + y * scale for x, y in zip(a, b))


def _ref_limb_frame(direction, normal, single=False):
    unit = _ref_funit if single else _ref_unit
    cross = _ref_fcross if single else _ref_cross
    x = unit(direction)
    z = unit(cross(x, normal))
    y = cross(z, x)
    return x, y, z


def _ref_limb_elbow(hip, foot, pole, lengths, extension, single=False):
    add = _ref_fadd if single else _ref_add
    unit = _ref_funit if single else _ref_unit
    dot = _ref_fdot if single else _ref_dot
    cross = _ref_fcross if single else _ref_cross
    reach = add(foot, hip, -1.)
    along = unit(reach)
    away = unit(add(pole, along, -dot(along, pole)))
    normal = cross(along, away)
    upper, lower = lengths
    distance = min(math.sqrt(dot(reach, reach)), extension * (upper + lower))
    projection = (upper * upper - lower * lower + distance * distance) / (2 * distance)
    height = math.sqrt(max(0., upper * upper - projection * projection))
    joint = add(add(hip, along, projection), away, height)
    end = add(hip, along, distance)
    return joint, _ref_limb_frame(add(joint, hip, -1.), normal, single), _ref_limb_frame(add(end, joint, -1.), normal, single)


def _ref_change_basis(old, new, single=False):
    dot = _ref_fdot if single else _ref_dot
    matrix = tuple(component for n in zip(*new) for component in (*(dot(n, o) for o in zip(*old)), 0.))
    return _ref_fvector(matrix) if single else matrix


def _ref_spin_fraction(u, ramp):
    """Integral of a trapezoidal speed profile, normalized to one turn."""
    u = _ref_clamp(u)
    return (u*u/(2*ramp) if u < ramp else
            1-ramp-(1-u)**2/(2*ramp) if u > 1-ramp else u-ramp/2) / (1-ramp)


def _ref_ease(progress, degree):
    p = _ref_clamp(progress)
    if degree == 3:
        return p*p*(3-2*p)
    return p*p*p*(10+p*(-15+6*p))


def reference_controls(channels):
    """Compile scalar authored envelopes for joint or other continuous drivers.

    Each channel sums independently timed terms. A product term composes
    envelopes, e.g. multiply a closing hinge by the complement of its opening.
    """
    def sample(term, frame):
        kind = term['kind']
        gain = term.get('gain', 1.)
        if kind == 'sum':
            return gain * sum(sample(child, frame) for child in term['terms'])
        if kind == 'product':
            return gain * math.prod(sample(child, frame) for child in term['terms'])
        if kind == 'complement':
            return gain * (1 - sample(term['term'], frame))
        elapsed = frame - term['start']
        p = elapsed / term.get('duration', 1.)
        if kind == 'smooth':
            return gain * _ref_ease(p, term.get('degree', 3)) ** term.get('power', 1.)
        if kind == 'power':
            return gain * _ref_clamp(p) ** term['power']
        if kind == 'bump':
            return gain * math.sin(math.pi * p) ** term.get('power', 1.) if 0. < p < 1. else 0.
        if kind == 'anticipate':
            if p <= 0.:
                return 0.
            lead = term['lead']
            if p < lead:
                return -gain * term['back'] * math.sin(math.pi * p / lead)
            v = _ref_clamp((p - lead) / (1 - lead))
            return gain * (term['smooth_weight'] * _ref_ease(v, 3) + term['power_weight'] * v*v)
        if kind in ('sine_decay', 'cos_decay'):
            wave = math.sin if kind == 'sine_decay' else math.cos
            return gain * math.exp(-p / term['decay']) * wave(math.tau * p * term['frequency']) if p >= 0. else 0.
        if kind == 'handoff':
            return sample(term['before'] if elapsed < 0. else term['after'], frame)
        if kind == 'step':
            return gain if elapsed >= 0. else 0.
        raise ValueError(f'unknown control curve {kind}')

    return lambda frame: {name: sum(sample(term, frame) for term in terms)
                          for name, terms in channels.items()}


def _ref_joint_solver(spec, single=False):
    """Resolve ordered rigid chains and optional planted two-link limbs."""
    if not spec:
        return lambda frame: {}
    mul = _ref_fproduct if single else _ref_product
    add = _ref_fadd if single else _ref_add
    point = _ref_fpoint if single else _ref_point
    rotate = _ref_frotation if single else _ref_rotation
    anchor = _ref_fanchor if single else _ref_anchor
    arms = spec.get('limbs', ())
    baselines = [_ref_limb_elbow(leg['hip'], leg['foot'], leg['pole'], leg['lengths'], leg['extension'], single)
                 for leg in arms]

    def solve(frame):
        if frame <= spec['start']:
            return {}
        value = spec['controls'](frame)
        rigid = {}
        for joint in spec['joints']:
            pivot = joint['pivot']
            rotation = _REF_IDENTITY
            for axis, angle, channel in joint['rotations']:
                rotation = mul(rotation, rotate(axis, angle * value[channel]))
            destination = pivot
            for move, channel in joint.get('moves', ()):
                destination = add(destination, move, value[channel])
            rigid[joint['id']] = mul(rigid.get(joint.get('parent'), _REF_IDENTITY), anchor(rotation, pivot, destination))
        for leg, (joint0, above0, below0) in zip(arms, baselines):
            progress = value[leg['channel']]
            yaw = leg['yaw'] * progress
            foot0, hip0 = leg['foot'], leg['hip']
            foot = add(foot0, leg['move'], progress)
            foot = add(foot, _REF_AXES[2], leg['lift'] * math.sin(math.pi * _ref_clamp(progress)))
            hip = point(rigid[leg['parent']], hip0)
            pole_turn = rotate(_REF_AXES[2], leg['pole_share'] * (yaw + leg['parent_yaw'] * value[leg['parent_channel']]))
            pole = point(pole_turn, leg['pole'])
            joint, above, below = _ref_limb_elbow(hip, foot, pole, leg['lengths'], leg['extension'], single)
            a, b, c = leg['ids']
            rigid[a] = anchor(_ref_change_basis(above0, above, single), hip0, hip)
            rigid[b] = anchor(_ref_change_basis(below0, below, single), joint0, joint)
            rigid[c] = anchor(rotate(_REF_AXES[2], yaw), foot0, foot)
        return rigid
    return solve


def reference_motion(spec):
    """Build part position tracks and a random-access stream of posed bound corners.

    Authored inputs are rest affines, flight controls, a scalar joint driver and
    optional root turn. No frame matrices are supplied. The camera can use an
    alternate list of parts before geometry splits, in which case it fits the
    unarticulated assembly.
    """
    root, floor = spec['root'], spec['ground']
    turn = spec.get('root_turn')
    single = spec.get('float32_affines', False)
    joint_at = _ref_joint_solver(spec.get('rig'), single)
    fit_joint_at = _ref_joint_solver(spec.get('rig'))
    alternate = spec.get('fit_parts')
    parts = spec['parts']

    def world(frame, posed_parts, animated, use_float=False):
        mul = _ref_fproduct if use_float else _ref_product
        joints = (joint_at(frame) if use_float else fit_joint_at(frame)) if animated else {}
        rw = root
        if animated and turn and frame > turn['start']:
            u = (frame - turn['start']) / turn['duration']
            rotation = _ref_rotation(turn['axis'], turn['angle'] * _ref_spin_fraction(u, turn['ramp']))
            rw = _ref_product(rotation, root)
        static = {}
        for part in posed_parts:
            local = _ref_flight(part, frame, floor, use_float)
            bone = part.get('bone')
            key = (bone, local)
            if key not in static:
                static[key] = mul(rw, mul(joints[bone], local) if bone in joints else local)
            yield part, static[key]

    def corners_at(frame):
        for part, matrix in world(frame, parts if alternate is None else alternate, alternate is None):
            for corner in part['corners']:
                yield _ref_point(matrix, corner)

    tracks = {part['id']: {'type': 'vec3', 'samples': []} for part in parts}
    for frame in range(spec['frame_count']):
        for part, matrix in world(frame, parts, True, single):
            tracks[part['id']]['samples'].append((matrix[3], matrix[7], matrix[11]))
    return tracks, corners_at
