"""Evaluate the film's metre-scale box meshes, choreography and face lighting without a host scene."""
import importlib.util
import json
import math
from pathlib import Path
import sys

ENGINE = Path(__file__).resolve().parents[3]


def module(name, *parts):
    spec = importlib.util.spec_from_file_location(name, ENGINE.joinpath(*parts))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


choreo = module('choreo', 'sources', 'blender', 'choreo.py')
bake = module('bake', 'sources', 'blender', 'bake.py')
studio = module('studio', 'cards', 'lighting', 'studio', 'index.py')
library = module('library', 'cards', 'material', 'library', 'index.py')


def mesh(solid):
    # Same local extents are translated through baking, projection and contact measurement.
    c, h = solid['center'], solid['half']
    vertices = [[c[j] + (1 if i & (1 << j) else -1) * h[j] for j in range(3)] for i in range(8)]
    faces = []
    for a, b, d, e in [(0, 4, 6, 2), (1, 3, 7, 5), (0, 1, 5, 4), (2, 6, 7, 3), (0, 2, 3, 1), (4, 5, 7, 6)]:
        faces.extend(([a, b, d], [a, d, e]))
    return {'vertices': vertices, 'faces': faces}


def assembly(shot, cards, solids, seed, fps):
    names = [s['id'] for s in solids]
    centers = [s['center'] for s in solids]
    if 'assembly.dsl' in cards:
        baked = bake.bake({'recipe': shot['params']['recipe'], 'meshes': {s['id']: mesh(s) for s in solids}})
        centers = [bake.transform(baked['parts'][name]['matrix4x4'], c) for name, c in zip(names, centers)]
    parts = [dict(id=name, rest_pos=pos, order=i) for i, (name, pos) in enumerate(zip(names, centers))]
    if 'assembly.schedule' not in cards:
        return centers, lambda f: centers
    s = cards['assembly.schedule']
    if s['spinDeg'] != 0:
        raise ValueError('This axial seating witness requires unrotated contact faces')
    table = choreo.schedule_assembly(parts, fps=fps, seed=seed, start_frame=s['startFrame'],
                                     gap_frames=s['gapFrames'], fly_frames=s['flyFrames'],
                                     offset_m=s['offsetM'], spin_deg=s['spinDeg'])['parts']
    rows = {r['id']: r for r in table}

    def sample(f):
        return [choreo.eval_snap_motion(f, r['t0'], r['fly_frames'], r['rest_pos'], r['rest_rot_deg'],
                                        r['start_offset'], r['start_rot_deg'])['position'] for r in (rows[n] for n in names)]
    return centers, sample


def explosion(shot, cards, solids):
    centers = [s['center'] for s in solids]
    if 'assembly.explode' not in cards:
        return centers, lambda f: centers
    parts = [dict(id=s['id'], rest_pos=s['center'], group=s.get('group', '')) for s in solids]
    config = cards['assembly.explode']
    phase = config['phase']
    start, peak, end = phase['startFrame'], phase['endFrame'], shot['params']['returnFrame']

    def sample(f):
        fraction = (f - start) / (peak - start) if f <= peak else (end - f) / (end - peak)
        progress = phase['from'] + (phase['to'] - phase['from']) * min(max(fraction, 0), 1)
        poses = choreo.eval_explode(parts, progress, scale_m=config['scaleM'], group_offsets=config['groupOffsets'])
        return [poses[s['id']] for s in solids]
    return centers, sample


def irradiance(lamp, point, normal):
    # Deterministic area-light centre quadrature at a diffuse witness (linear scene units).
    delta = [x - c for x, c in zip(lamp['position'], point)]
    r = math.hypot(*delta)
    axis = [x / r for x in delta]
    incident = max(0, math.fsum(x*y for x, y in zip(axis, normal)))
    emitted = max(0, -math.fsum(x*y for x, y in zip(axis, lamp['normal'])))
    return lamp['watts'] * emitted * incident / (math.pi * r*r)


def luma(rgb):
    return sum(w * x for w, x in zip((0.2126, 0.7152, 0.0722), rgb))


def face_shades(rig, material, center, half, exposure):
    # Six actual projected faces, sampled at face centres. Convert incident irradiance to
    # outgoing diffuse radiance, add the material's emission, then apply fixed film exposure.
    result = []
    for axis in range(3):
        for sign in (-1, 1):
            n = [sign if j == axis else 0 for j in range(3)]
            p = [c + h*v for c, h, v in zip(center, half, n)]
            rgb = [material['emissionStrength']] * 3
            for lamp in rig.values():
                diffuse = irradiance(lamp, p, n) / math.pi
                rgb = [v + diffuse*t for v, t in zip(rgb, lamp['color'])]
            result.append(exposure * luma([v*t for v, t in zip(rgb, material['baseColor'])]))
    return result


def evaluate(film, disabled):
    shot, = film['shots']
    cards = {c['use'].split('@')[0]: c['params'] for c in shot['cards'] if c['use'].split('@')[0] != disabled}
    solids = shot['params']['solids']
    assembling = film['exam'] == '3-1'
    if assembling:
        rest, sample = assembly(shot, cards, solids, film['seed'], film['output']['fps'])
    else:
        rest, sample = explosion(shot, cards, solids)
        if 'mat.library' in cards:
            assignments = library.validate_assignments(cards['mat.library']['assignments'])
            materials = [library.get_material_spec(assignments[s['id']]) for s in solids]
        else:
            materials = [dict(baseColor=(.18, .18, .18), emissionStrength=0)] * len(solids)
    frames = []
    for f in range(shot['out'] - shot['in']):
        rig = studio.solve(cards['light.studio'], f) if 'light.studio' in cards else {}
        gray = [irradiance(rig[k], (0, 0, 0), (0, 0, 1)) * luma(rig[k]['color']) if k in rig else 0 for k in ('key', 'fill')]
        pos = sample(f)
        row = dict(positions=pos, keyFill=gray)
        if not assembling:
            row['faceShades'] = [face_shades(rig, mat, c, solid['half'], shot['params']['exposure'])
                                 for mat, c, solid in zip(materials, pos, solids)]
        frames.append(row)
    return {'rest': rest, 'frames': frames}


if __name__ == '__main__':
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    json.dump(evaluate(**json.load(sys.stdin)), sys.stdout, allow_nan=False, separators=(',', ':'))
