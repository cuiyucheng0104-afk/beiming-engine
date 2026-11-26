import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { evalExplode, evalSnapMotion } from './assembly-motion.mjs';
import { decodeTracks } from './tracks.mjs';

const flight = {
  t0: 2, fly_frames: 12, rest_pos: [0.25, -0.5, 1], rest_rot_deg: [10, 0, -20],
  start_offset: [2, -1, 0.5], start_rot_deg: [40, -10, 0],
};
const parts = [
  { id: 'left.pin', group: 'outer', rest_pos: [-2, -1, 1] },
  { id: '__proto__', group: 'center', rest_pos: [0, 0, 0] },
  { id: 'missing', rest_pos: [0, 0, 0] },
  { id: 'empty', group: '', rest_pos: [0, 0, 0] },
  { id: 'right.pin', group: 'outer', rest_pos: [2, 1, -1] },
];
const shots = {
  left: flight,
  right: { ...flight, t0: 5, overshoot: 0 },
  straight: { ...flight, t0: 8, settle_frames: 0 },
  short: { ...flight, t0: 0, fly_frames: 3, settle_frames: 20 },
};
const spreads = {
  centroid: {},
  groups: { scale_m: 0, group_offsets: { '': [1, 2, 3], undefined: [4, 5, 6] } },
  weighted: { axis_weights: [0, 2, 1], scale_m: 1.5, group_offsets: { center: [0.5, 0, 0] } },
  explicit: { center: [2, -3, 4], group_offsets: { outer: [1, 0, -0.5] } },
};
const frames = Array.from({ length: 49 }, (_, i) => i / 2 - 2);

test('E6: offsets stagger groups, flight contacts, rebounds and settles', () => {
  const x = (t, shape) => evalSnapMotion(t, shape).position[0];
  assert.equal(x(2, flight), 2.25);
  assert.ok(x(4, flight) < x(4, shots.right));
  assert.equal(x(8, flight), 0.25);
  assert.ok(x(9, flight) < 0.25);
  assert.equal(x(12, shots.right), 0.25);
  assert.deepEqual(evalSnapMotion(22, flight), { position: flight.rest_pos, rotation_deg: flight.rest_rot_deg });
});

test('E6: weighted axes, centred part, group offset and input-order independence', () => {
  assert.deepEqual(evalExplode(parts, 1).__proto__, [0, 0, 0]);
  const groups = evalExplode(parts, 1, spreads.groups);
  assert.deepEqual(groups.missing, [0, 0, 0]);
  assert.deepEqual(groups.empty, [1, 2, 3]);
  const out = evalExplode(parts, 1, spreads.weighted);
  assert.deepEqual(out.__proto__, [0.5, 0, 0]);
  assert.equal(out['right.pin'][0], 2);
  assert.deepEqual(evalExplode([...parts].reverse(), 1, spreads.weighted), out);
  assert.deepEqual(evalExplode([], 1), {});
  const cancellation = [1e16, 1, -1e16, 0.25].map((x, i) => ({ id: String(i), rest_pos: [x, 0, 0] }));
  assert.equal(evalExplode(cancellation, 1)['3'][0], -0.75);
});

test('E6: reject malformed positions, duplicate identifiers and invalid intervals', () => {
  for (const bad of [{ fly_frames: 0 }, { settle_frames: -1 }, { start_offset: [1, NaN, 3] },
    { rest_pos: Array(3) }, { rest_rot_deg: undefined }, { start_rot_deg: undefined }, { overshoot: Infinity }]) {
    assert.throws(() => evalSnapMotion(0, { ...flight, ...bad }));
  }
  assert.throws(() => evalExplode([parts[0], parts[0]], 0));
  assert.throws(() => evalExplode([{ ...parts[0], id: 'a\n' }], 1));
  assert.throws(() => evalExplode(parts, 0.1, { axis_weights: [0, -1, 2] }));
  assert.throws(() => evalExplode(parts, 0.1, { group_offsets: { outer: null } }));
});

const pythonTracks = `
import json, runpy, sys
api = runpy.run_path(sys.argv[1])
shots, spreads, parts, frames = json.loads(sys.argv[2])
tracks = {}
def record(name, row):
    tracks.setdefault(name, {"type": "vec3", "samples": []})["samples"].append(row)
for f in frames:
    for name, spec in shots.items():
        pose = api["eval_snap_motion"](f, **spec)
        for field, value in pose.items():
            record(name + "/" + field, value)
    for name, spec in spreads.items():
        for part, value in api["eval_explode"](parts, f / 15, **spec).items():
            record(name + "/" + part, value)
api["write_tracks"](sys.argv[3], tracks)
`;
test('E6: JS independently evaluates all E5 float32 reference tracks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-e6-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = relative => fileURLToPath(new URL(relative, import.meta.url));
  await promisify(execFile)(process.execPath, [path('../../jobs/python/py.mjs'), '-I', '-B', '-c',
    pythonTracks, path('../../sources/blender/choreo.py'), JSON.stringify([shots, spreads, parts, frames]), root]);
  const truth = decodeTracks(JSON.parse(await readFile(join(root, 'tracks.json'), 'utf8')), await readFile(join(root, 'tracks.bin')));
  let comparisons = 0, maxPositionError = 0;
  for (const [index, frame] of frames.entries()) {
    const actual = {};
    for (const [name, spec] of Object.entries(shots)) {
      for (const [field, value] of Object.entries(evalSnapMotion(frame, spec))) actual[name + '/' + field] = value;
    }
    for (const [name, spec] of Object.entries(spreads)) {
      for (const [id, value] of Object.entries(evalExplode(parts, frame / 15, spec))) actual[name + '/' + id] = value;
    }
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(truth).sort());
    for (const [name, vector] of Object.entries(actual)) {
      const track = truth[name];
      assert.equal(track.samples.length, frames.length);
      const error = Math.hypot(...vector.map((v, k) => v - track.samples[index][k]));
      assert.ok(error <= 1e-5, name + ' at ' + frame + ' error ' + error);
      if (!name.endsWith('/rotation_deg')) {
        maxPositionError = Math.max(maxPositionError, error);
        comparisons++;
      }
    }
  }
  t.diagnostic(comparisons + ' positions, maximum Euclidean error ' + maxPositionError + ' m');
});

test('E6: centroid uses E5 identifier order and rejects an overflowing canonical sum', async () => {
  const example = [['a', 1e308], ['c', 1e308], ['b', -1e308], ['d', 0]]
    .map(([id, x]) => ({ id, rest_pos: [x, 0, 0] }));
  const overflowing = example.map((p, i) => ({ ...p, id: 'abcd'[i] }));
  const solve = `
import json, runpy, sys
explode = runpy.run_path(sys.argv[1])["eval_explode"]
example, overflowing = json.loads(sys.argv[2])
print(json.dumps(explode(example, 1)["d"]))
try:
    explode(overflowing, 1)
except OverflowError:
    pass
else:
    raise AssertionError("E5 should reject an overflowing canonical sum")
`;
  const path = relative => fileURLToPath(new URL(relative, import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [path('../../jobs/python/py.mjs'), '-I', '-B', '-c',
    solve, path('../../sources/blender/choreo.py'), JSON.stringify([example, overflowing])]);
  const expected = JSON.parse(stdout);
  assert.deepEqual(expected, [-1, 0, 0]);
  assert.deepEqual(evalExplode(example, 1).d, expected);
  assert.deepEqual(evalExplode([...example].reverse(), 1).d, expected);
  assert.throws(() => evalExplode(overflowing, 1), RangeError);
});
