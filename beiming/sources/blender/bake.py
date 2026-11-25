"""Bake world-space Y-up triangle proxies into relative rigid transforms, in metres."""
import hashlib
import itertools
import json
import math
import sys
from collections import Counter
from pathlib import Path

# Blender's script loader need not put the script directory on sys.path.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from query import TriangleNode, bounds, cross, dot, normal, project_triangle, sub


IDENTITY = ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))
FIELDS = {
    'slide': ('onto', 'dir', 'push', 'quantile'), 'seat': ('onto', 'dir', 'maxExtra', 'tol', 'step'),
    'fit': ('onto', 'rangeX', 'rangeY', 'rangeZ', 'tol', 'touchTol'), 'move': ('delta',),
    'attach': ('parent',), 'rot': ('pivot', 'axis', 'angleDeg'), 'mirror': ('ref',),
}


def number(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError('expected a finite number')
    return value


def vector(value):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError('expected a three-component vector')
    return tuple(map(number, value))


def scale(v, s):
    return tuple(x * s for x in v)


def unit(v):
    length = math.hypot(*v)
    if not length:
        raise ValueError('direction/axis must not be zero')
    return tuple(x / length for x in v)


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def transform(m, v):
    return tuple(dot(row, v) + row[3] for row in m[:3])


def compose(a, b):
    return tuple(tuple(sum(x * y for x, y in zip(row, col)) for col in zip(*b)) for row in a)


def translation(v):
    return tuple((*row[:3], t) for row, t in zip(IDENTITY[:3], v)) + (IDENTITY[3],)


def rotation(pivot, axis, angle):
    c, s = math.cos(angle), math.sin(angle)
    # Form the columns by rotating each basis vector, then keep the pivot fixed.
    columns = [add(add(scale(e, c), scale(cross(axis, e), s)), scale(axis, dot(axis, e) * (1-c)))
               for e in (row[:3] for row in IDENTITY[:3])]
    return tuple((*row, x - dot(row, pivot)) for row, x in zip(zip(*columns), pivot)) + (IDENTITY[3],)


def ray_triangle(origin, direction, tri):
    """Möller–Trumbore, including edge/vertex hits from either side."""
    a, b, c = tri
    e1, e2 = sub(b, a), sub(c, a)
    h = cross(direction, e2)
    det = dot(e1, h)
    if abs(det) <= 1e-14 * math.hypot(*normal(tri)):
        return None
    offset = sub(origin, a)
    u = dot(offset, h) / det
    q = cross(offset, e1)
    v = dot(direction, q) / det
    if min(u, v, 1-u-v) < -1e-12:
        return None
    distance = dot(e2, q) / det
    return max(0., distance) if distance >= -1e-12 else None


def ray_entry(box, p, direction, upper):
    """Conservative slab lower bound. Slack includes the triangle test's edge allowance."""
    lo, hi = -1e-12, upper
    span = max(box[i+3] - box[i] for i in range(3))
    for i, d in enumerate(direction):
        slack = 4e-12 * span + 16 * math.ulp(max(abs(p[i]), abs(box[i]), abs(box[i+3])))
        a, b = box[i] - p[i] - slack, box[i+3] - p[i] + slack
        if d == 0.:
            if a > 0 or b < 0:
                return None
        else:
            near, far = (a/d, b/d) if d > 0 else (b/d, a/d)
            lo, hi = max(lo, near), min(hi, far)
            if lo > hi:
                return None
    return lo


class Surface:
    """The same double-precision triangle primitives with optional BVH candidate selection."""
    def __init__(self, meshes, matrices, names, tree_type):
        self.points, faces, self.solid_faces = [], [], []
        for name in names:
            points, triangles = meshes[name]
            edges = Counter(tuple(sorted((a, b))) for tri in triangles for a, b in zip(tri, (*tri[1:], tri[0])))
            self.solid_faces.extend([all(n == 2 for n in edges.values())] * len(triangles))
            offset = len(self.points)
            self.points.extend(transform(matrices[name], p) for p in points)
            faces.extend(tuple(offset + i for i in f) for f in triangles)
        self.triangles = [tuple(self.points[i] for i in f) for f in faces]
        self.normals = [unit(normal(tri)) for tri in self.triangles]
        self.bounds_tree = TriangleNode([(bounds(tri), i) for i, tri in enumerate(self.triangles)])
        self.box = self.bounds_tree.box
        self.tree = None
        if tree_type:
            # BVH is float32: index in a nearby coordinate frame, then refine the hit in double.
            box = self.box
            self.center = scale(add(box[:3], box[3:]), 0.5)
            self.span = math.dist(box[:3], box[3:])
            self.tree = tree_type.FromPolygons([sub(p, self.center) for p in self.points], faces, all_triangles=True)

    def ray(self, p, direction):
        best, seed = math.inf, None
        if self.tree is not None:
            # Float BVH is a fast upper bound, not a proof that no closer grazing hit exists.
            local = sub(p, self.center)
            margin = max(self.span, math.hypot(*local)) * 2**-21
            start = sub(local, scale(direction, margin))
            _, _, seed, _ = self.tree.ray_cast(start, direction)
            if seed is not None:
                hit = ray_triangle(p, direction, self.triangles[seed])
                if hit is not None:
                    best = hit
        pending = [self.bounds_tree]
        while pending and best != 0:
            node = pending.pop()
            if ray_entry(node.box, p, direction, best) is None:
                continue
            if node.children:
                pending.extend(node.children)
            else:
                for i in node.tris:
                    if i != seed:
                        hit = ray_triangle(p, direction, self.triangles[i])
                        if hit is not None:
                            best = min(best, hit)
        return None if best == math.inf else best

    def distance(self, p):
        """Unsigned closest distance and its signed normal component (outwards positive)."""
        indices = range(len(self.triangles))
        if self.tree is not None:
            local = sub(p, self.center)
            _, _, first, rough = self.tree.find_nearest(local)
            # An edge can belong to multiple faces. Resolve ties by most informative
            # normal, then original face order, not implementation-specific BVH traversal.
            slack = max(self.span, math.hypot(*local)) * 2**-20
            indices = {first, *(row[2] for row in self.tree.find_nearest_range(local, rough + slack))}
        def candidate(i):
            delta = sub(p, project_triangle(p, self.triangles[i]))
            signed = dot(delta, self.normals[i])
            return dot(delta, delta), -abs(signed), i, signed
        squared, _, i, signed = min(map(candidate, indices))
        # An open surface can touch, but has no inside volume.
        return math.sqrt(squared), signed if self.solid_faces[i] else 0.


def contact_distances(moving, fixed, direction):
    hits = []
    for source, target, ray in ((moving, fixed, direction), (fixed, moving, scale(direction, -1))):
        hits.extend(d for p in source.points if (d := target.ray(p, ray)) is not None)
    if not hits:
        raise ValueError('no vertex ray hits along dir')
    return sorted(hits)


def counts(moving, fixed, delta, tol, touch_tol):
    inside = touching = 0
    # Moving the query point by -delta lets us reuse the moving part's surface index.
    for source, target, offset in ((moving, fixed, delta), (fixed, moving, scale(delta, -1))):
        for p in source.points:
            distance, signed = target.distance(add(p, offset))
            if signed < -max(tol, 0.6 * distance) - 1e-12:
                inside += 1
            elif distance <= touch_tol:
                touching += 1
    return inside, touching


def shared_interior(moving, fixed, delta, tol):
    # Equal cross sections can leave *every vertex* on a side wall, even with
    # volumetric overlap. As in the query source, try the center of the shared
    # AABB as a witness; box overlap alone is never considered penetration.
    lo = [max(moving.box[i]+d, fixed.box[i]) for i, d in enumerate(delta)]
    hi = [min(moving.box[i+3]+d, fixed.box[i+3]) for i, d in enumerate(delta)]
    if any(b-a <= 2*tol for a, b in zip(lo, hi)):
        return False
    center = scale(add(lo, hi), 0.5)
    for surface, point in ((fixed, center), (moving, sub(center, delta))):
        distance, signed = surface.distance(point)
        if signed >= -max(tol, 0.6 * distance) - 1e-12:
            return False
    return True


def sample_count(extent, step):
    if step <= 0 or extent < 0:
        raise ValueError('expected nonnegative range and positive step')
    count = extent / step
    if count >= 1_000_000:
        raise ValueError('too many grid samples')
    return math.floor(count + 1e-10) + 1


def grid(value, units):
    if type(value) in (int, float) and value == 0:
        return (0.,)
    lo, hi, step = scale(vector(value), units)
    return tuple(lo + i*step for i in range(sample_count(hi-lo, step)))


def contact_move(st, moving, fixed, units):
    def length(key, default):
        # Defaults are specified in metres even when authored lengths use millimetres.
        v = number(st[key])*units if key in st else default
        if v < 0:
            raise ValueError(f'{key} must be nonnegative')
        return v

    op = st['op']
    if op == 'fit':
        tol, touch_tol = length('tol', 0.00035), length('touchTol', 0.0004)
        axes = [grid(st[k], units) for k in ('rangeX', 'rangeY', 'rangeZ')]
        if math.prod(map(len, axes)) > 1_000_000:
            raise ValueError('too many fit candidates')
        best = None
        for delta in itertools.product(*axes):
            inside, touch = counts(moving, fixed, delta, tol, touch_tol)
            if not inside and not shared_interior(moving, fixed, delta, tol):
                score = (-touch, sum(map(abs, delta)), delta)
                if best is None or score < best:
                    best = score
        if best is None:
            raise ValueError('no non-penetrating fit candidate')
        return best[2]

    direction = unit(vector(st['dir']))
    hits = contact_distances(moving, fixed, direction)
    first = hits[0]
    if op == 'slide':
        q = number(st.get('quantile', 0))
        if not 0 <= q <= 1:
            raise ValueError('quantile must be in [0,1]')
        t = q*(len(hits)-1)
        i = math.floor(t)
        depth = hits[i] + (t-i)*(hits[math.ceil(t)]-hits[i]) + units*number(st.get('push', 0))
    else:
        tol, extra, step = length('tol', 0.00035), length('maxExtra', 0.03), length('step', 0.00025)
        allowed = math.floor((len(moving.points) + len(fixed.points)) * 0.0015)
        depth = first
        # Include maxExtra itself when it is not an integral multiple of the step.
        n = sample_count(extra, step)
        for offset in itertools.chain((i*step for i in range(n)), (extra,)):
            candidate = first + min(extra, offset)
            delta = scale(direction, candidate)
            inside, _ = counts(moving, fixed, delta, tol, 0.)
            if inside > allowed or shared_interior(moving, fixed, delta, tol):
                break
            depth = candidate
    return scale(direction, depth)


def parse_step(raw):
    if isinstance(raw, list) and len(raw) >= 2:
        target, op, *args = raw
        if (not isinstance(op, str) or op not in FIELDS) and isinstance(target, str) and target in FIELDS:
            op, target = target, op
        if not isinstance(op, str) or op not in FIELDS or len(args) > len(FIELDS[op]):
            raise ValueError('unknown operation or extra arguments')
        raw = {'op': op, 'target': target, **dict(zip(FIELDS[op], args))}
    if not isinstance(raw, dict) or raw.get('op') not in FIELDS:
        raise ValueError('unknown assembly operation')
    if set(raw).difference({'op', 'target', *FIELDS[raw['op']]}):
        raise ValueError(f"unknown argument for {raw['op']}")
    return raw


def load_meshes(raw, units):
    if not isinstance(raw, dict) or not raw:
        raise ValueError('supply a non-empty meshes object')
    meshes = {}
    for name, mesh in sorted(raw.items()):
        if not name.strip() or name.strip() != name or any(c in ',+*:/\\' or ord(c) < 32 for c in name):
            raise ValueError('invalid part name')
        vertices = [scale(vector(p), units) for p in mesh['vertices']]
        faces = mesh['faces']
        if not faces or not vertices:
            raise ValueError(f'empty mesh: {name}')
        for f in faces:
            if not isinstance(f, list) or len(f) != 3 or any(type(i) is not int or not 0 <= i < len(vertices) for i in f):
                raise ValueError(f'expected triangle indices: {name}')
            if not math.hypot(*normal(tuple(vertices[i] for i in f))):
                raise ValueError(f'degenerate triangle: {name}')
        meshes[name] = vertices, faces
    return meshes


def clean(n):
    r = round(n, 9)
    return int(r) if r == int(r) else r


class Assembly:
    def __init__(self, recipe, raw_meshes, tree_type):
        self.units = {'mm': 0.001, 'm': 1.0}[recipe.get('units', 'm')]
        self.meshes = load_meshes(raw_meshes, self.units)
        self.matrices = dict.fromkeys(self.meshes, IDENTITY)
        self.parents = dict.fromkeys(self.meshes)
        self.touched = set()
        self.center_x = number(recipe['centerX'])*self.units if 'centerX' in recipe else None
        self.tree_type = tree_type
        if 'root' in recipe:
            root = recipe['root']
            if root not in self.meshes:
                raise ValueError(f'unknown root: {root}')
            self.touched.add(root)

    def select(self, spec):
        if isinstance(spec, list):
            matches = [k for item in spec for k in self.select(item)]
        elif isinstance(spec, str):
            matches = []
            for item in map(str.strip, spec.split(',')):
                if item == '*':
                    matches.extend(k for k in self.meshes if k in self.touched)
                    continue
                name = item.removesuffix('+')
                if name not in self.meshes:
                    raise ValueError(f'unknown part: {name}')
                group = [name]
                if name != item:
                    for parent in group:
                        group.extend(k for k, v in self.parents.items() if v == parent)
                matches.extend(group)
        else:
            raise ValueError('expected a part selector')
        return list(dict.fromkeys(matches))

    def attach(self, names, parent, *, keep_internal=False):
        # Contact moves an assembled group. An explicit attach assigns each named child.
        k = parent
        while k is not None:
            if k in names:
                raise ValueError('attachment cycle')
            k = self.parents[k]
        for k in names:
            if not keep_internal or self.parents[k] not in names:
                self.parents[k] = parent

    def center(self, names):
        box = bounds(transform(self.matrices[k], p) for k in names for p in self.meshes[k][0])
        if box is None:
            raise ValueError('cannot measure an empty selector')
        return scale(add(box[:3], box[3:]), 0.5)

    def apply(self, st):
        op, names = st['op'], self.select(st['target'])
        tx = None
        if op in ('slide', 'seat', 'fit'):
            anchors = [k for k in self.select(st['onto']) if k not in names]
            if not names or not anchors:
                raise ValueError(f'{op} needs separate moving and fixed parts')
            surfaces = [Surface(self.meshes, self.matrices, ks, self.tree_type) for ks in (names, anchors)]
            tx = translation(contact_move(st, *surfaces, self.units))
            self.attach(names, anchors[0], keep_internal=True)
        elif op == 'attach':
            parents = self.select(st['parent'])
            if len(parents) != 1:
                raise ValueError('attach needs one parent')
            self.attach(names, parents[0])
        elif op == 'move':
            tx = translation(scale(vector(st['delta']), self.units))
        elif op == 'rot':
            tx = rotation(scale(vector(st['pivot']), self.units), unit(vector(st['axis'])), math.radians(number(st['angleDeg'])))
        else:
            if self.center_x is None:
                raise ValueError('mirror requires recipe.centerX')
            x, y, z = self.center(self.select(st['ref']))
            tx = translation(sub((2*self.center_x-x, y, z), self.center(names)))
        if tx is not None:
            for k in names:
                self.matrices[k] = compose(tx, self.matrices[k])
        self.touched.update(names)
        summary = {'op': op, 'targets': names}
        if tx is not None:
            summary['matrix4x4'] = [[clean(x) for x in row] for row in tx]
        return summary


def bake(payload, tree_type=None):
    recipe = payload['recipe']
    assembly = Assembly(recipe, payload.get('meshes', recipe.get('meshes')), tree_type)
    if not isinstance(recipe.get('steps'), list):
        raise ValueError('recipe.steps must be an array')
    steps = []
    for i, raw in enumerate(recipe['steps']):
        try:
            steps.append(assembly.apply(parse_step(raw)))
        except (ValueError, KeyError, TypeError) as e:
            raise ValueError(f'step {i}: {e}') from e
    parts = {k: {'matrix4x4': [[clean(x) for x in row] for row in m], 'parent': assembly.parents[k],
                 'touched': k in assembly.touched} for k, m in assembly.matrices.items()}
    encoded = json.dumps(recipe, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
    return {'format': 'asm-baked/0.1', 'recipeSha256': hashlib.sha256(encoded).hexdigest(), 'parts': parts, 'steps': steps}


if __name__ == '__main__':
    tree = None
    if '--' in sys.argv:
        from mathutils.bvhtree import BVHTree
        tree, args = BVHTree, sys.argv[sys.argv.index('--')+1:]
    else:
        args = sys.argv[1:]
    source, destination = map(Path, args)
    result = bake(json.loads(source.read_text(encoding='utf-8')), tree)
    destination.write_bytes((json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode())
