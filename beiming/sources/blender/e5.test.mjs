import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeTracks, encodeTracks } from '../../kernel/eval/tracks.mjs';
import { findBlender } from './host.mjs';

const exec = promisify(execFile);
const pythonCli = fileURLToPath(new URL('../../../tools/env/py.mjs', import.meta.url));
const choreo = fileURLToPath(new URL('./choreo.py', import.meta.url));
const pythonPrelude = `
import json
import runpy
import sys
from pathlib import Path

api = runpy.run_path(sys.argv[1])
`;

function python(code, ...args) {
  return exec(process.execPath, [pythonCli, '-I', '-B', '-c', pythonPrelude + code, choreo, ...args]);
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'beiming-e5-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function readTracks(dir) {
  return {
    indexJson: JSON.parse(await readFile(join(dir, 'tracks.json'), 'utf8')),
    bin: await readFile(join(dir, 'tracks.bin')),
  };
}

const sampleTracks = {
  'z-vec': { type: 'vec3', samples: [[0.1, -Math.PI, 8], [0, 1.5, -32]] },
  'q-rotation': { type: 'quat', samples: [[0, 0, 1, 0], [0, 0, 0, 1]] },
  'a-camera': { type: 'camera', samples: [{ pos: [-12, 0.5, 1.25], quat: [0, 0, 0, 1], fovDeg: 38.7 }] },
  'f-bounds': { type: 'bbox', samples: [{ min: [-1, -0.75, 0], max: [1, 0.75, Math.PI] }] },
  'e-empty': { type: 'vec3', samples: [] },
  's-scalar': { type: 'scalar', samples: [1 / 3, -0.625, 1.25e-21] },
};
const meta = { fps: '30/1', evidence: { units: '米', frames: 2 } };

test('E5: Python writes deterministic little-endian tracks and Node decodes every type', async (t) => {
  const root = await tempDir(t);
  const input = join(root, 'spec.json');
  await writeFile(input, JSON.stringify({ sampleTracks, meta }));
  await python(`
source = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
tracks, meta = source['sampleTracks'], source['meta']
assert 'bpy' not in sys.modules
api['write_tracks'](Path(sys.argv[3]) / 'first', tracks, meta)
api['write_tracks'](Path(sys.argv[3]) / 'second', dict(reversed(list(tracks.items()))), meta)
`, input, root);
  const firstDir = join(root, 'first');
  const secondDir = join(root, 'second');
  const actual = await readTracks(firstDir);
  const expected = encodeTracks(sampleTracks, meta);
  assert.deepEqual(actual.indexJson, expected.indexJson);
  assert.deepEqual(actual.bin, Buffer.from(expected.bin));
  assert.deepEqual(decodeTracks(actual.indexJson, actual.bin), decodeTracks(expected.indexJson, expected.bin));
  for (const name of ['tracks.json', 'tracks.bin']) {
    assert.deepEqual(await readFile(join(firstDir, name)), await readFile(join(secondDir, name)), name);
  }
});

test('E5: Python decodes Node tracks and rejects inconsistent or non-finite payloads', async (t) => {
  const root = await tempDir(t);
  const { indexJson, bin } = encodeTracks(sampleTracks, meta);
  await Promise.all([
    writeFile(join(root, 'tracks.json'), JSON.stringify(indexJson)),
    writeFile(join(root, 'tracks.bin'), bin),
  ]);
  const { stdout } = await python(`
import copy
import struct

root = Path(sys.argv[2])
index = json.loads((root / 'tracks.json').read_text(encoding='utf-8'))
payload = (root / 'tracks.bin').read_bytes()
decode = api['decode_tracks']
expected = decode(index, payload)
print(json.dumps(expected, allow_nan=False))
# JSON numbers such as 1.0 and 1 have the same semantics in the Node decoder.
integral = copy.deepcopy(index)
for track in integral['tracks']:
    for field in ('offset', 'count', 'stride'):
        track[field] = float(track[field])
assert decode(integral, payload) == expected

def reject(label, fn, *args):
    try:
        fn(*args)
    except (TypeError, ValueError, OverflowError):
        return
    raise AssertionError(label)

reject('trailing byte', decode, index, payload + b'\\0')
reject('truncated payload', decode, index, payload[:-1])
reject('non-finite binary float', decode, index, struct.pack('<f', float('nan')) + payload[4:])
for field, value in [('offset', 4), ('offset', False), ('count', -1), ('count', True),
                     ('stride', 99), ('stride', 8.5), ('extra', True)]:
    malformed = copy.deepcopy(index)
    malformed['tracks'][0][field] = value
    reject(field, decode, malformed, payload)
for value in (float('inf'), float('nan'), 1e40, True, '0'):
    reject('not a finite float32', api['encode_tracks'], {'a': {'type': 'scalar', 'samples': [value]}})
`, root);
  assert.deepEqual(JSON.parse(stdout), decodeTracks(indexJson, bin));
});

const authoredInputs = String.raw`
import json
import runpy
import sys
from pathlib import Path
sys.dont_write_bytecode = True
api = runpy.run_path(sys.argv[-3])

# This fixture adapter extracts setup data and scalar curve parameters, not
# frame outputs. The original frame evaluators are disabled before setup.
import ast
import hashlib
import math


def authored_tree(source):
    return {node.name: node for node in ast.parse(source.read_text(encoding='utf-8')).body
            if isinstance(node, ast.FunctionDef)}


def assignments(tree, name):
    return [node.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
            and any(ast.unparse(target) == name for target in node.targets)]


def numbers(node, width=float):
    items = [n for n in ast.walk(node) if isinstance(n, ast.Constant) and type(n.value) is width]
    return [n.value for n in sorted(items, key=lambda n: (n.lineno, n.col_offset))]


def authored_flight(trees):
    ease_power, = [x for x in numbers(trees['ease'], int) if x > 1]
    turn_fraction, arc_gain = numbers(trees['part_matrix'])
    return dict(ease_power=ease_power, turn_fraction=turn_fraction, arc_gain=arc_gain)


def read_parts(parts, variant, flight):
    mode = {'settle': 'arrive', 'spin': 'revolve', 'rock': 'rock'}
    result = []
    for p in parts:
        matrix = api['_ref_affine'](p['M'])
        if variant == 'pre_basis':
            rest = api['_ref_translate'](api['_REF_IDENTITY'], p['base'])
            basis = matrix
        else:
            rest, basis = matrix, api['_REF_IDENTITY']
        moves = [dict(flight, start=m['t0'], duration=m['fly'], pivot=list(m['P']), offset=list(m['E']),
                      side=list(m['S']), axis=tuple(m['axis']), angle=m['ang'], turn=mode[m['kind']])
                 for m in p['moves']]
        result.append(dict(id='part:' + p['key'], bone=p.get('bone'), rest=rest, basis=basis,
                           corners=[tuple(c) for c in p['bb']], moves=moves))
    return result


def articulated_setup(scene, trees):
    """Translate the initialized rest rig to joint chains and two-link goals."""
    rig, pose, timing = scene.RIG, scene.POSE, scene.CHAN
    start, hit = rig['t_pose'], scene.T_HIT
    X, Y, Z = api['_REF_AXES']
    J = rig['J']
    mirror = rig['mirx']  # rest reflection; no original frame evaluation
    radians = math.radians
    channels = {}
    snap = trees['snap']
    lead = next(x for x in numbers(snap) if 0 < x < 0.5 and x not in [d.value for d in snap.args.defaults])
    smooth_weight, power_weight = numbers(snap.body[-2].body[-1])
    back = snap.args.defaults[0].value
    gain, decay, period = [x for x in numbers(assignments(trees['chan'], 'reb')[0]) if x > 0]
    reb = dict(kind='sine_decay', start=start + hit, gain=gain, decay=decay, frequency=1 / period)
    head_gain, = [n.right.value for n in ast.walk(trees['chan']) if isinstance(n, ast.BinOp)
                  and isinstance(n.op, ast.Mult) and isinstance(n.left, ast.Name) and n.left.id == 'reb']
    for name, (lower, upper) in timing.items():
        span = dict(start=start + lower, duration=upper - lower)
        if name.startswith('foot') or name in ('skirt', 'sideL'):
            channels[name] = [dict(span, kind='smooth')]
        elif name in ('root', 'armL'):
            sw, pw, *exponent = numbers(assignments(trees['chan'], "c['" + name + "']")[0])
            channels[name] = [dict(span, kind='smooth', gain=sw),
                              dict(span, kind='power', gain=pw, power=(exponent or [2])[0]), reb]
        else:
            channels[name] = [dict(span, kind='anticipate', lead=lead, back=back,
                                   smooth_weight=smooth_weight, power_weight=power_weight),
                              dict(reb, gain=gain * head_gain if name == 'head' else gain)]
    wind_ratio, = numbers(assignments(trees['bones'], 't')[0])
    channels['wind'] = [dict(kind='bump', start=start, duration=timing['root'][1] * wind_ratio, power=2)]
    joints = []

    def joint(name, parent, pivot, rotations, moves=()):
        joints.append(dict(id=name, parent=parent, pivot=pivot, rotations=rotations, moves=moves))

    def euler(name):
        return [(axis, radians(pose[name].get(component, 0.)), name)
                for axis, component in [(Z, 'yaw'), (X, 'pitch'), (Y, 'roll')]]

    def q_axis(key, channel, factor=1.):
        axis, angle = rig[key].to_axis_angle()  # rest quaternion, independent of frame
        return (api['_ref_unit'](axis), angle * factor, channel)

    joint('root', None, J['root'], euler('root'), [(pose['root']['move'], 'root'), (pose['root']['wind'], 'wind')])
    joint('chest', 'root', J['chest'], euler('chest'))
    joint('head', 'chest', J['head'], euler('head'))
    for name, (pivot, axis) in rig['skirt'].items():
        joint(name, 'root', pivot, [(axis, radians(pose['skirt'][name]), name if name in channels else 'skirt')])
    el = rig['hinge_e']
    joint('uarmL', 'chest', J['shoulder'], [q_axis('qL', 'armL')])
    joint('farmL', 'uarmL', J['elbow'], [(el, radians(pose['armL']['elbow']), 'armL')])
    joint('padL', 'chest', J['shoulder'], [q_axis('qLpad', 'armL', pose['armL']['pad'])])
    pivot, axis = rig['peg']
    joint('shield', 'farmL', pivot, [(axis, radians(pose['shield']['spin']), 'armL')])
    joint('uarmR', 'chest', mirror(J['shoulder']), [q_axis('qR', 'armR')])
    joint('farmR', 'uarmR', mirror(J['elbow']), [((el.x, -el.y, -el.z), radians(pose['aim']['elbow']), 'armR')])
    joint('padR', 'chest', mirror(J['shoulder']), [q_axis('qRpad', 'armR', pose['aim']['pad'])])
    extension, = numbers(assignments(trees['_ik'], 'd')[0])
    pole = rig['pole']
    limbs = []
    for side in ('L', 'R'):
        channel = 'foot' + side
        fp = pose[channel]
        right = side == 'R'
        limbs.append(dict(ids=['thigh' + side, 'shin' + side, channel], parent='root', channel=channel,
                          hip=mirror(J['hip']) if right else J['hip'], foot=mirror(J['ankle']) if right else J['ankle'],
                          pole=(-pole.x, pole.y, pole.z) if right else pole, lengths=(rig['l1'], rig['l2']),
                          extension=extension, yaw=radians(fp['yaw']), move=fp['move'], lift=fp['lift'],
                          pole_share=0.5, parent_yaw=radians(pose['root']['yaw']), parent_channel='root'))
    return dict(start=start, controls=api['reference_controls'](channels), joints=joints, limbs=limbs)


def hinge_setup(scene, info, trees):
    fold_start = info['t_done'] + scene.T_BEAT
    open_start = fold_start + scene.T_FOLD + scene.T_HOLDC
    open_hit = open_start + scene.T_OHIT
    open_end = open_start + scene.T_OPEN
    close = dict(kind='smooth', start=fold_start, duration=scene.T_FOLD)
    _, attack, reb = sorted(assignments(trees['wing'], 'ko'), key=lambda node: node.lineno)
    peak, exponent = numbers(attack)
    amplitude, angular = numbers(reb)
    damping, = [n for n in numbers(reb, int) if n > 1]
    release = open_end - open_hit
    opening = dict(kind='handoff', start=open_hit,
                   before=dict(kind='smooth', start=open_start, duration=scene.T_OHIT,
                               degree=5, gain=peak, power=exponent),
                   after=dict(kind='cos_decay', start=open_hit, duration=release,
                              frequency=angular / 2, decay=1 / damping, gain=amplitude))
    # Damped opening is a residual around one after its impact.
    actual_open = dict(kind='sum', terms=[opening, dict(kind='step', start=open_hit)])
    close_residual = dict(kind='product', terms=[close, dict(kind='complement', term=actual_open)])
    controls = api['reference_controls']({'close': [close_residual], 'open': [actual_open]})
    joints = [dict(id=key, pivot=b['pivot'], rotations=[(api['_ref_unit'](b['axis']), math.radians(b[channel]), channel)
                                                       for channel in ('close', 'open')])
              for key, b in scene.ROBOT['bones'].items()]
    ramp, = numbers(assignments(trees['spin_angle'], 'a')[0])
    root_turn = dict(start=open_end + scene.T_PRE, duration=scene.T_SPIN, axis=api['_REF_AXES'][2],
                     ramp=ramp, angle=math.tau)
    return dict(start=fold_start, joints=joints, controls=controls), root_turn


def _view_controls(trees, hold_half, boundaries, margin):
    # Translate authored scalar expressions into endpoint values, without
    # executing the source function or evaluating any frame of the source.
    ops = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b,
           ast.Mult: lambda a, b: a * b}

    def endpoint(node, u):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return node.value
        if isinstance(node, ast.Name) and node.id in ('prog', 'w'):
            return u
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return -endpoint(node.operand, u)
        if isinstance(node, ast.BinOp) and type(node.op) in ops:
            return ops[type(node.op)](endpoint(node.left, u), endpoint(node.right, u))
        raise ValueError('unsupported authored view expression')

    tree = trees['cam_dir']
    first = sorted(assignments(tree, '(az, el, mg)'), key=lambda node: node.lineno)
    if not first:
        first = [next(node.value for node in tree.body if isinstance(node, ast.Return))]

    def shape(expr, u):
        value = tuple(endpoint(x, u) for x in expr.elts)
        return value if len(value) == 3 else (*value, margin)

    keys = [(hold_half, shape(first[0], 0), 1)]
    weights = sorted(assignments(tree, 'w'), key=lambda node: node.lineno)
    assert len(first) == len(boundaries) and len(weights) == len(boundaries) - 1
    for i, (f, expr) in enumerate(zip(boundaries, first)):
        exponent = weights[i - 1].right.value if i and isinstance(weights[i - 1], ast.BinOp) and isinstance(weights[i - 1].op, ast.Pow) else 1
        assert math.dist(shape(expr, 0), keys[-1][1]) < 1e-12
        keys.append((f, shape(expr, 1), exponent))
    return keys


def reference_camera_spec(scene, info, variant, source_path, _manifest):
    # Authored view/optics controls only. No evaluated camera rows or truth
    # enter the solver. Scene-space corners are supplied by the motion rig.
    done, start = info['t_done'], scene.T_HOLD / 2
    trees = authored_tree(source_path)
    spec = dict(height=info['height'], aspect=16 / 9, sensor_width=36,
                fit_stride=2, fit_window=14, distance_window=9, height_window=12,
                smooth_passes=3, shake=(4.5, 24, 2.7, 3.4, .4, .6))
    if variant == 'pre_basis':
        settle, accent = scene.T_BEAT, scene.T_BEAT + scene.T_HIT
        authored = scene.CAM_POSE
        defaults = {arg.arg: value.value for arg, value in
                    zip(trees['camera_fit'].args.args[-len(trees['camera_fit'].args.defaults):], trees['camera_fit'].args.defaults)}
        return dict(spec, lens=defaults['lens'], fit_end=done + scene.FIT_TAIL,
                    views=_view_controls(trees, start, [done], defaults['margin']),
                    pose_start=done, curve='blend', poses=[
                        (settle, authored['start'], 'smooth', 1),
                        (accent, authored['hit'], 'smooth', 1.6),
                        (scene.T_HERO, authored['end'], 'out', 2)],
                    impulses=[(done + settle + t, amount) for t, amount in scene.SHAKE])
    fold = done + scene.T_BEAT
    opening = fold + scene.T_FOLD + scene.T_HOLDC
    accent = opening + scene.T_OHIT
    orbit = opening + scene.T_OPEN + scene.T_PRE
    poses = [(t, (*lens_free[:4], scene.LENS, lens_free[4]) if lens_free is not None else None)
             for t, lens_free in scene.CLOSE]
    return dict(spec, lens=scene.LENS, fit_end=orbit, pose_start=orbit,
                curve='spline', poses=poses, ground=.06, impulses=[(accent, scene.SHAKE)],
                views=_view_controls(trees, start, [done, fold, opening, accent, orbit], None))


def l17_inputs(truth, out):
    import bpy
    import importlib.util
    import os

    manifest = json.loads((truth / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['format'] == 'own-choreo-truth/1'
    assert bpy.app.build_hash.decode('ascii') == manifest['blender']['build_hash'], 'Blender build differs from truth'
    library = truth.parents[2].resolve()
    source_path = None
    for relative, digest in manifest['source_sha256'].items():
        file = (library / relative).resolve(strict=True)
        assert file.is_relative_to(library) and hashlib.sha256(file.read_bytes()).hexdigest() == digest, relative
        if file.name == 'scene.py':
            assert source_path is None
            source_path = file
    assert source_path is not None, 'missing authored scene in manifest'
    harness_path, = truth.parents[1].glob('packs/*/run_l17.py')
    harness = runpy.run_path(str(harness_path))
    film, mesh = manifest['film'], manifest['mesh_input']
    project = source_path.parents[1]
    assert (harness['FILMS'][film] / 'build' / source_path.name).resolve() == source_path
    # Honour caller-supplied roots, then authored project-local inputs, then
    # the external loader's native fallback. Never store a workstation path.
    for key, suffix in [('GK_STL', 'stl'), ('KS_STL', 'stl'), ('KS_CACHE', 'ks_kit_cache')]:
        fallback = project / 'inputs' / suffix
        if fallback.is_dir():
            os.environ.setdefault(key, str(fallback))
    os.environ.pop('GK_POSE', None)
    sys.argv = [sys.argv[0], '--', '--lo'] if mesh['mode'] == 'cache-lo' else [sys.argv[0]]
    spec = importlib.util.spec_from_file_location('l17_authored_scene', source_path)
    scene = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scene)
    scene.SEED = manifest['seed']
    assert harness['mesh_inputs'](film, mesh['mode'], scene) == mesh, 'mesh inputs differ from truth'
    trees = authored_tree(source_path)
    flight = authored_flight(trees)
    variant = 'pre_basis' if hasattr(scene, 'rig') else 'post_basis'
    fit_parts = None

    def saved_fit(parts, _info):
        nonlocal fit_parts
        assert fit_parts is None
        fit_parts = read_parts(parts, variant, flight)
        return None

    def forbidden(*_args, **_kwargs):
        raise AssertionError('fixture setup must not invoke the original per-frame evaluator')

    for name in ('pose', 'part_matrix', 'bones', 'chan', 'wing', 'spin_angle', 'RWf',
                 'cam_dir', 'camera_anim', 'camera_at', 'fx_setup', 'events'):
        if hasattr(scene, name):
            setattr(scene, name, forbidden)
    scene.camera_fit = saved_fit if variant == 'pre_basis' else forbidden
    _, parts, info = scene.build()
    if variant == 'pre_basis':
        scene.rig(parts, info)
        rig = articulated_setup(scene, trees)
        root_turn = None
    else:
        rig, root_turn = hinge_setup(scene, info, trees)
    frame_count = info['t_done'] + scene.T_HERO
    spec = dict(parts=read_parts(parts, variant, flight), root=api['_ref_affine'](info['root_world']),
                frame_count=frame_count, ground=scene.GROUND[0], rig=rig, root_turn=root_turn, fit_parts=fit_parts,
                float32_affines=variant == 'pre_basis')
    tracks, corners_at = api['reference_motion'](spec)
    camera = reference_camera_spec(scene, info, variant, source_path, manifest)
    # The original setup supplies exact (not event-table-rounded) authored
    # flight and rig inputs. Frame evaluators are still forbidden.
    assembled = math.ceil(max(move['start'] + move['duration']
                              for part in spec['parts'] for move in part['moves']))
    metadata = {'axis': 'XYZ Z-up', 'unit': 'm', 'fps': scene.FPS, 'assembledFrame': assembled}

    def camera_tracks(sliding):
        camera_rows, target, unshaken = api['reference_camera'](camera, corners_at, frame_count, use_sliding_max=sliding)
        return {'camera': {'type': 'camera', 'samples': camera_rows},
                'camera:target': {'type': 'vec3', 'samples': target},
                'camera:unshaken': {'type': 'vec3', 'samples': unshaken}}

    api['write_tracks'](out / 'actual', tracks | camera_tracks(True), metadata)
    api['write_tracks'](out / 'no_window', camera_tracks(False), metadata)
    # Shorten an authored nonzero flight; the same position comparator must fail.
    moving = min((part for part in spec['parts'] if part['moves'] and math.hypot(*part['moves'][0]['offset']) > 0),
                 key=lambda part: part['moves'][0]['start'])
    move, *following = moving['moves']
    wrong = dict(moving, moves=[dict(move, duration=move['duration'] * 0.6), *following])
    mutated, _ = api['reference_motion'](dict(spec, parts=[wrong]))
    api['write_tracks'](out / 'short_flight', mutated, metadata)
    print('E5_INPUTS_OK')


l17_inputs(Path(sys.argv[-2]), Path(sys.argv[-1]))
`;

const oracleInputs = String.raw`
import ast
import hashlib
import json
from pathlib import Path
import struct
import sys
import zipfile
from array import array

truth, out = map(Path, sys.argv[1:])
manifest = json.loads((truth / 'manifest.json').read_text(encoding='utf-8'))
for key in ('part_matrices.npz', 'camera_track.json', 'events.json'):
    raw = (truth / key).read_bytes()
    assert len(raw) == manifest['files'][key]['bytes']
    assert hashlib.sha256(raw).hexdigest() == manifest['files'][key]['sha256']


def npy(archive, name):
    with archive.open(name + '.npy') as stream:
        assert stream.read(6) == b'\x93NUMPY'
        version = stream.read(2)
        assert version in (b'\x01\x00', b'\x02\x00')
        n = int.from_bytes(stream.read(2 if version[0] == 1 else 4), 'little')
        header = ast.literal_eval(stream.read(n).decode('ascii').strip())
        assert header['fortran_order'] is False
        return header['descr'], header['shape'], stream.read()


frames, part_count = manifest['frame_count'], manifest['part_count']
with zipfile.ZipFile(truth / 'part_matrices.npz') as archive:
    dtype, shape, raw = npy(archive, 'frames')
    assert (dtype, shape) == ('<i4', (frames,))
    assert struct.unpack(f'<{frames}i', raw) == tuple(range(frames))
    dtype, shape, raw = npy(archive, 'part_names')
    assert dtype.startswith('<U') and shape == (part_count,)
    width = 4 * int(dtype[2:])
    assert width > 0 and len(raw) == width * part_count
    names = [raw[i:i + width].decode('utf-32-le').rstrip(chr(0)) for i in range(0, len(raw), width)]
    assert len(set(names)) == part_count and all(names)
    dtype, shape, raw = npy(archive, 'matrices')
    assert (dtype, shape) == ('<f8', (frames, part_count, 4, 4))
    assert len(raw) == frames * part_count * 128

# Keep expected values float64; only the actual path is quantized by the codec.
positions = array('d')
for row in struct.iter_unpack('<16d', raw):
    positions.extend((row[3], row[7], row[11]))
if sys.byteorder == 'big':
    positions.byteswap()
(out / 'expected.bin').write_bytes(positions.tobytes())
(out / 'names.json').write_text(json.dumps(names), encoding='utf-8')
`;

const POSITION_LIMIT_M = 0.01 / 1000;
const DISTANCE_LIMIT = 0.001;

async function decoded(dir) {
  const { indexJson, bin } = await readTracks(dir);
  return decodeTracks(indexJson, bin);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function vectorDistance(a, b) {
  return Math.hypot(...a.map((n, i) => n - b[i]));
}

function compareParts(tracks, names, expected, count) {
  let max = 0;
  let worst;
  for (const [name, { type, samples }] of Object.entries(tracks)) {
    const part = names.indexOf(name);
    assert.ok(part >= 0, `unknown part track ${name}`);
    assert.equal(type, 'vec3', name);
    assert.equal(samples.length, count, name);
    for (let frame = 0; frame < count; frame++) {
      const at = (frame * names.length + part) * 24;
      const point = samples[frame];
      const delta = Math.hypot(point[0] - expected.readDoubleLE(at),
        point[1] - expected.readDoubleLE(at + 8), point[2] - expected.readDoubleLE(at + 16));
      assert.ok(Number.isFinite(delta), `invalid position at ${name} frame ${frame}`);
      if (delta > max) {
        max = delta;
        worst = `${name} frame ${frame}`;
      }
    }
  }
  assert.ok(max <= POSITION_LIMIT_M, `part position error ${max * 1000} mm at ${worst}`);
  return max;
}

function compareCamera(tracks, expected) {
  const { camera, 'camera:target': target, 'camera:unshaken': unshaken } = tracks;
  assert.equal(camera.type, 'camera');
  for (const track of [target, unshaken]) assert.equal(track.type, 'vec3');
  for (const track of [camera, target, unshaken]) assert.equal(track.samples.length, expected.length);
  let pos = 0;
  let rel = 0;
  let quat = 0;
  let fov = 0;
  for (const [i, row] of expected.entries()) {
    assert.equal(row.frame, i);
    const actual = camera.samples[i];
    const aim = target.samples[i];
    const stable = unshaken.samples[i];
    pos = Math.max(pos, vectorDistance(actual.pos, row.position_m),
      vectorDistance(stable, row.unshaken_position_m), vectorDistance(aim, row.target_m));
    const want = vectorDistance(row.unshaken_position_m, row.target_m);
    rel = Math.max(rel, Math.abs(vectorDistance(stable, aim) / want - 1));
    const [w, x, y, z] = row.quaternion_wxyz;
    quat = Math.max(quat, Math.min(vectorDistance(actual.quat, [x, y, z, w]),
      vectorDistance(actual.quat, [-x, -y, -z, -w])));
    fov = Math.max(fov, Math.abs(actual.fovDeg - row.fov_y_rad * 180 / Math.PI));
  }
  assert.ok(rel <= DISTANCE_LIMIT, `camera distance relative error ${rel * 100}%`);
  assert.ok(pos <= POSITION_LIMIT_M, `camera position error ${pos * 1000} mm`);
  assert.ok(quat <= 1e-5, `camera orientation error ${quat}`);
  assert.ok(fov <= 1e-4, `camera vertical FOV error ${fov} deg`);
  return { pos, rel };
}

function compareEvents(events, meta, manifest) {
  assert.equal(events.fps, manifest.fps);
  assert.equal(events.fps, meta.fps);
  assert.equal(events.total_frames, manifest.frame_count);
  assert.equal(events.seed, manifest.seed);
  assert.equal(meta.assembledFrame, events.assembled_frame);
  function inRange(frame) {
    assert.ok(Number.isFinite(frame) && frame >= 0 && frame < events.total_frames, `invalid event frame ${frame}`);
  }
  inRange(events.assembled_frame);
  for (const row of [...events.parts, ...events.bundles]) {
    inRange(row.start);
    inRange(row.arrive);
    assert.ok(row.arrive >= row.start && row.arrive <= events.assembled_frame);
  }
  for (const row of [...events.camera_shake, ...events.bursts]) inRange(row.frame);
  for (const row of events.trails) {
    inRange(row.start);
    inRange(row.end);
    inRange(row.peak);
    assert.ok(row.start <= row.peak && row.peak <= row.end);
  }
}

function rejectMutation(t, label, check, pattern) {
  assert.throws(check, (error) => {
    assert.match(error.message, pattern);
    t.diagnostic(`${label}: ${error.message}`);
    return true;
  });
}

const truthRoot = process.env.BEIMING_L17_TRUTH_DIR;
test('E5: L17 parts and camera agree on every local reference frame', {
  skip: !truthRoot && 'BEIMING_L17_TRUTH_DIR is not configured',
  timeout: 180_000,
}, async (t) => {
  const blender = process.env.BLENDER_BIN || findBlender();
  assert.ok(blender, 'the configured L17 truth replay needs Blender');
  const root = await tempDir(t);
  const assets = join(root, 'assets.py');
  const oracle = join(root, 'oracle.py');
  await Promise.all([writeFile(assets, authoredInputs), writeFile(oracle, oracleInputs)]);
  const dirs = await readdir(truthRoot, { withFileTypes: true });
  const refs = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const path = resolve(truthRoot, entry.name);
    try {
      const manifest = await readJson(join(path, 'manifest.json'));
      if (manifest.format === 'own-choreo-truth/1') refs.push({ path, manifest });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  assert.equal(refs.length, 2, 'L17 truth requires both reference exports');
  assert.equal(new Set(refs.map(({ manifest }) => manifest.film)).size, 2, 'L17 references must be distinct');
  for (const [i, { path, manifest }] of refs.entries()) {
    await t.test(manifest.film, async () => {
      const result = join(root, `run-${i}`);
      const { stdout, stderr } = await exec(blender, ['-b', '--factory-startup', '--python-exit-code', '1',
        '-P', assets, '--', choreo, path, result], { timeout: 120_000 });
      assert.match(stdout, /E5_INPUTS_OK/, stderr);
      // Load oracle payloads only after the independent solver has emitted tracks.
      await exec(process.execPath, [pythonCli, '-I', '-B', oracle, path, result]);
      const names = (await readJson(join(result, 'names.json'))).map((n) => `part:${n}`);
      const positions = await readFile(join(result, 'expected.bin'));
      const events = await readJson(join(path, 'events.json'));
      const { frames: cameras, fps } = await readJson(join(path, 'camera_track.json'));
      const count = manifest.frame_count;
      assert.equal(fps, manifest.fps);
      assert.equal(cameras.length, count);
      assert.equal(positions.byteLength, count * names.length * 24);
      const { indexJson, bin } = await readTracks(join(result, 'actual'));
      compareEvents(events, indexJson.meta, manifest);
      const actual = decodeTracks(indexJson, bin);
      const parts = Object.fromEntries(Object.entries(actual).filter(([name]) => name.startsWith('part:')));
      assert.deepEqual(Object.keys(parts).sort(), [...names].sort());
      assert.equal(Object.keys(actual).length, names.length + 3);
      const worstPart = compareParts(parts, names, positions, count);
      const worstCamera = compareCamera(actual, cameras);
      t.diagnostic(`${manifest.film}: ${count * names.length} part positions, max ${(worstPart * 1000).toFixed(6)} mm; ` +
        `${count} camera frames, max ${(worstCamera.pos * 1000).toFixed(6)} mm, ` +
        `distance ${(worstCamera.rel * 100).toFixed(6)}%`);

      const shortFlight = await decoded(join(result, 'short_flight'));
      assert.equal(Object.keys(shortFlight).length, 1);
      rejectMutation(t, `${manifest.film} shortened flight`, () => compareParts(shortFlight, names, positions, count), /part position error/);
      const noWindow = await decoded(join(result, 'no_window'));
      rejectMutation(t, `${manifest.film} no sliding maximum`, () => compareCamera(noWindow, cameras), /camera distance relative error/);
    });
  }
});
