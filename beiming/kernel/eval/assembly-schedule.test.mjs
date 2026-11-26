import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { evalSnapMotion } from './assembly-motion.mjs';
import { scheduleAssembly } from './assembly-schedule.mjs';
import { decodeTracks } from './tracks.mjs';

const parts = [
  { id: 'z', group: 'first', order: -2, rest_pos: [4, 0, 0] },
  { id: 'tie.right', group: 'first', rest_pos: [0.5, 0, 0], rest_rot_deg: [10, 20, -30] },
  { id: 'tie.left', group: 'first', rest_pos: [-0.5, 0, 0] },
  { id: '__proto__', group: 'first', rest_pos: [0, 0, 0] },
  { id: 'axes.first', group: 'first', rest_pos: [1 / 103, 10 / 109, 1 / 107] },
  { id: 'axes.second', group: 'first', rest_pos: [1 / 107, 1 / 103, 10 / 109] },
  { id: 'rim', group: 'outer', rest_pos: [0, 0.2, 0.1] },
  { id: 'base', rest_pos: [0, 0, 0] },
  { id: 'inner', group: 'zebra', rest_pos: [0, 0, 1] },
  { id: 'astral', group: '\u{10000}', rest_pos: [0, 0, -1] },
  { id: 'bmp', group: '\uE000', rest_pos: [0, 1, 0] },
];
const added = { id: 'new', order: -3, group: 'first', rest_pos: [0, -1, 0] };
const options = { groups: ['first', 'outer'], fps: '60000/2002', seed: 135,
  start_frame: 2, gap_frames: 3, fly_frames: 9, offset_m: 0.7, spin_deg: 22,
  film: 'assembly_test', shot: 's-01' };

const path = relative => fileURLToPath(new URL(relative, import.meta.url));

test('E6: E5 order assigns arrival frames and tied events sort by id', () => {
  const plan = scheduleAssembly(parts, options);
  assert.deepEqual(plan.parts.map(p => p.id), ['z', '__proto__', 'axes.first', 'axes.second', 'tie.left', 'tie.right',
    'rim', 'base', 'inner', 'bmp', 'astral']);
  assert.deepEqual(plan.parts.map(p => [p.t0, p.fly_frames, p.arrive]),
    plan.parts.map((_, i) => [2 + i * 3, 9, 11 + i * 3]));
  assert.deepEqual(plan.events, { format: 'events/0.1', film: 'assembly_test', fps: '30000/1001', frames: 42,
    events: plan.parts.map(p => ({ id: `arrive.${p.id}`, frame: p.arrive, sub: 0, kind: 'arrive', from: 'tracks', entity: p.id, shot: 's-01' })) });
  const tied = scheduleAssembly(parts, { ...options, gap_frames: 0, shot: undefined });
  assert.deepEqual(tied.events.events.map(e => e.id), parts.map(p => `arrive.${p.id}`).sort());
  assert.ok(tied.events.events.every(e => e.frame === 11 && !Object.hasOwn(e, 'shot')));
});

test('E6: named JS streams are reproducible, independent per part and do not mutate inputs', () => {
  const input = structuredClone([parts, options]);
  const base = scheduleAssembly(...input);
  assert.deepEqual(input, [parts, options]);
  assert.deepEqual(scheduleAssembly([...parts].reverse(), options), base);
  const bigger = scheduleAssembly([added, ...parts], options);
  const startingPose = ({ start_offset, start_rot_deg }) => [start_offset, start_rot_deg];
  const rows = new Map(bigger.parts.map(p => [p.id, p]));
  assert.equal(rows.get('z').t0, base.parts[0].t0 + options.gap_frames);
  for (const part of base.parts) assert.deepEqual(startingPose(rows.get(part.id)), startingPose(part));
  assert.notDeepEqual(scheduleAssembly(parts, { ...options, seed: options.seed + 1 }).parts.map(startingPose), base.parts.map(startingPose));
});

test('E6: validate replay draws, catalogue fields and exact frame counts', () => {
  const only = [{ id: '__proto__', rest_pos: [0, 0, 0], rest_rot_deg: [5, 10, -15] }];
  const fixed = scheduleAssembly(only, { startSamples: { ['__proto__']: [0.5, 0.5, 0.5, 0, 0.5, 0.75] } });
  assert.deepEqual(fixed.parts[0].start_offset, [0, 1, 0]);
  assert.deepEqual(fixed.parts[0].start_rot_deg, [-25, 10, 0]);
  assert.deepEqual(scheduleAssembly([], { fps: 2.5e-7, start_frame: 4 }), {
    parts: [], events: { format: 'events/0.1', film: 'assembly', fps: '1/4000000', frames: 5, events: [] },
  });
  for (const bad of [{ parts: [only[0], only[0]] }, { parts: [{ id: 'a\n', rest_pos: [1, 2, 3] }] },
    { parts: [{ id: 'a', rest_pos: Array(3) }] }, { opts: { groups: ['first', 'first'] } },
    { opts: { fly_frames: 0 } }, { opts: { start_frame: Number.MAX_SAFE_INTEGER } },
    { opts: { shot: 's_01' } }, { opts: { fps: '3/0' } }, { opts: { seed: -1 } },
    { opts: { startSamples: {} } }, { opts: { startSamples: { ['__proto__']: [0, 0, 0, 0, 0, 1] } } },
    { opts: { startSamples: { ['__proto__']: Array(6) } } }, { opts: { sortRadii: {} } },
    { opts: { sortRadii: { ['__proto__']: -1 } } }, { opts: { sortRadii: { ['__proto__']: '0' } } }]) {
    assert.throws(() => scheduleAssembly(bad.parts ?? only, bad.opts));
  }
});

test('E6: rounded radii keep E5 arrival order at floating-point ties and near ties', async t => {
  const pythonSort = `
import json, math, random, runpy, sys
from decimal import Decimal, localcontext
schedule = runpy.run_path(sys.argv[1])['schedule_assembly']
fixed = [{"id": "a", "rest_pos": [0.9957517706705998, 0.3214918090928829, 0.1742994276716352]},
         {"id": "z", "rest_pos": [0.8094320037659292, 0.6856228510439116, 0]}]
rng = random.Random(5902)
batch = []
for i in range(256):
    group = f"r{i:03}"
    scale = 2.0 ** (-1074, -1022, -500, -3, 0, 3, 500, 1022)[i % 8]
    parts = [rng.uniform(-1.0, 1.0) * scale for _ in range(3)]
    radius = math.hypot(*parts)
    for suffix, pos in [('b', parts), ('a', [radius, 0, 0]),
                        ('c', [math.nextafter(radius, 0.0), 0, 0]),
                        ('d', [math.nextafter(radius, math.inf), 0, 0])]:
        batch.append(dict(id=f"{group}.{suffix}", group=group, rest_pos=pos))
maximum = sys.float_info.max
extreme = [dict(id='a', rest_pos=[maximum, maximum, 0]),
           dict(id='z', rest_pos=[maximum, 0, 0]),
           dict(id='m', rest_pos=[0, -maximum, -maximum]),
           dict(id='y', rest_pos=[-maximum, 0, 1.0])]

def exact_radius(part):
    axes = [abs(value) for value in part['rest_pos'] if value]
    if len(axes) < 2:
        return next(iter(axes), 0)
    with localcontext() as context:
        context.prec = 2200
        return float(sum(Decimal(value) ** 2 for value in axes).sqrt())

def check(parts):
    radii = {p['id']: math.hypot(*p['rest_pos']) for p in parts}
    radii = {id: value if math.isfinite(value) else 'Infinity' for id, value in radii.items()}
    actual = schedule(parts, offset_m=0, spin_deg=0)['events']
    exact = sorted(parts, key=lambda p: (p.get('group', ''), exact_radius(p), p['id']))
    return parts, radii, actual, [p['id'] for p in exact]

print(json.dumps([check(items) for items in (fixed, batch, extreme)]))
`;
  const { stdout } = await promisify(execFile)(process.execPath, [path('../../jobs/python/py.mjs'), '-I', '-B', '-c',
    pythonSort, path('../../sources/blender/choreo.py')]);
  const options = { offset_m: 0, spin_deg: 0 };
  const cases = JSON.parse(stdout);
  const [fixed, , fixedEvents] = cases[0];
  assert.deepEqual(scheduleAssembly(fixed, options).events, fixedEvents);
  let checked = 0;
  for (const [items, sortRadii, expected, exactOrder] of cases) {
    for (const order of [items, [...items].reverse()]) {
      const native = scheduleAssembly(order, options);
      assert.deepEqual(native.parts.map(p => p.id), exactOrder);
      assert.deepEqual(scheduleAssembly(order, { ...options, sortRadii }).events, expected);
      checked += items.length;
    }
  }
  t.diagnostic(`${checked} arrivals checked against exact rounding and Python E5 replay`);
});

const pythonOracle = `
import json, math, random, runpy, sys
from pathlib import Path
api = runpy.run_path(sys.argv[1])
cases, moments = json.loads(sys.argv[2])
results = []
for i, (parts, options) in enumerate(cases):
    schedule = api['schedule_assembly'](parts, **options)
    samples = {}
    radii = {}
    for part in parts:
        name = part['id']
        rng = random.Random(f"{options['seed']}/assembly/{name}")
        samples[name] = [rng.random() for _ in range(6)]
        radii[name] = math.hypot(*part['rest_pos'])
    tracks = {}
    for row in schedule['parts']:
        name = row['id']
        shape = {key: value for key, value in row.items() if key not in ('id', 'arrive')}
        poses = [api['eval_snap_motion'](f, **shape) for f in moments]
        for field in ('position', 'rotation_deg'):
            tracks[f"{name}/{field}"] = {'type': 'vec3', 'samples': [pose[field] for pose in poses]}
    api['write_tracks'](Path(sys.argv[3]) / str(i), tracks)
    results.append([schedule, samples, radii])
print(json.dumps(results))
`;

test('E6: JS replays Python E5 seed draws and matches every scheduled position and arrival', async t => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-e6-schedule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    [parts, options], [[...parts].reverse(), options], [[added, ...parts], options],
    [parts, { ...options, gap_frames: 0, fps: 23.976, offset_m: 0, spin_deg: 0, shot: undefined }],
    [[], options],
  ];
  const orderedFrames = Array.from({ length: 193 }, (_, i) => (i - 4) / 4);
  const moments = [...orderedFrames.filter((_, i) => i % 2 === 0).reverse(),
    ...orderedFrames.filter((_, i) => i % 2), 2.25, 0, 11];
  const { stdout } = await promisify(execFile)(process.execPath, [path('../../jobs/python/py.mjs'), '-I', '-B', '-c',
    pythonOracle, path('../../sources/blender/choreo.py'), JSON.stringify([cases, moments]), root]);
  const results = JSON.parse(stdout);
  let count = 0, worst = 0;
  const shapeOf = ({ start_offset, start_rot_deg, ...row }) => row;
  for (const [i, [items, opts]] of cases.entries()) {
    const [reference, startSamples, sortRadii] = results[i];
    const plan = scheduleAssembly(items, { ...opts, startSamples, sortRadii });
    assert.deepEqual(plan.parts.map(shapeOf), reference.parts.map(shapeOf));
    assert.deepEqual(plan.events, reference.events);
    const dir = join(root, String(i));
    const tracks = decodeTracks(JSON.parse(await readFile(join(dir, 'tracks.json'), 'utf8')), await readFile(join(dir, 'tracks.bin')));
    assert.equal(Object.keys(tracks).length, items.length * 2);
    for (const [k, row] of plan.parts.entries()) {
      for (const field of ['start_offset', 'start_rot_deg']) {
        const error = Math.hypot(...row[field].map((v, axis) => v - reference.parts[k][field][axis]));
        assert.ok(error <= 1e-12, `${row.id}/${field}: ${error}`);
      }
      for (const [j, frame] of moments.entries()) {
        const pose = evalSnapMotion(frame, row);
        for (const [field, vector] of Object.entries(pose)) {
          const expected = tracks[`${row.id}/${field}`].samples[j];
          const error = Math.hypot(...vector.map((v, k) => v - expected[k]));
          assert.ok(error <= 1e-5, `${row.id}/${field} at ${frame}: ${error}`);
          if (field === 'position') { count++; worst = Math.max(worst, error); }
        }
      }
    }
  }
  assert.equal(count, cases.reduce((total, [items]) => total + items.length, 0) * moments.length);
  t.diagnostic(`${count} E5 position samples, maximum Euclidean error ${(worst * 1000).toFixed(8)} mm`);
});
