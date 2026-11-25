"""S12 scene queries. The geometry and F9 helpers can also run in plain Python."""
import heapq
import math
from collections import Counter, defaultdict
from functools import cached_property
from itertools import combinations, count, product


LIMIT = 50
# BVHTree uses float32. Treat numerical noise at the surface as touch, not penetration.
SURFACE_EPS = 1e-8


def sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])


def dot(a, b):
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def lerp(a, b, t):
    return tuple(x + (y-x)*t for x, y in zip(a, b))


def dist2(a, b):
    d = sub(a, b)
    return dot(d, d)


def bounds(points):
    axes = tuple(zip(*points))
    return tuple(map(min, axes)) + tuple(map(max, axes)) if axes else None


def union(boxes):
    return bounds(p for b in boxes if b is not None for p in (b[:3], b[3:]))


def box_dist2(a, b):
    return sum(max(0., a[i]-b[i+3], b[i]-a[i+3])**2 for i in range(3))


def candidate_pairs(of, against=None):
    """Keep the requested a/b direction, emitting each unordered pair once."""
    if against is None:
        yield from combinations(of, 2)
        return
    order = {name: i for i, name in enumerate(of)}
    right = set(against)
    for a, b in product(of, against):
        # A reversed pair could only have been emitted by an earlier left-hand entity.
        if a != b and (a not in right or order.get(b, order[a]) >= order[a]):
            yield a, b


def item(a, value, at, b=None):
    numbers = (value, *at)
    if not all(map(math.isfinite, numbers)):
        raise ValueError(f'{a} 的查询数值必须有限')
    out = {'a': a, 'value': value + 0., 'unit': 'm', 'at': [v + 0. for v in at]}
    if b is not None:
        out['b'] = b
    return out


def finish(kind, items):
    ordered = sorted(items, key=lambda i: (-i['value'], i['a'].encode('utf-8'), i.get('b', '').encode('utf-8')))
    result = {'kind': kind, 'items': ordered[:LIMIT]}
    if len(ordered) > LIMIT:
        result['truncated'] = len(ordered) - LIMIT
    return result


def edges(tri):
    a, b, c = tri
    return ((a, b), (b, c), (c, a))


def normal(tri):
    a, b, c = tri
    return cross(sub(b, a), sub(c, a))


def centroid(points):
    return tuple(math.fsum(axis)/len(points) for axis in zip(*points))


def in_face(p, tri, n):
    # Dot products scale with |n|². Allow a roundoff-sized slack at shared edges.
    return all(dot(cross(sub(b, a), sub(p, a)), n) >= -1e-14*dot(n, n) for a, b in edges(tri))


def segment_face(a, b, tri, n):
    """Parameter where a non-coplanar segment pierces a triangle, including edges."""
    delta = sub(b, a)
    denom = dot(n, delta)
    if denom == 0:
        return None
    t = dot(n, sub(tri[0], a))/denom
    if 0. <= t <= 1. and in_face(lerp(a, b, t), tri, n):
        return t
    return None


def project_segment(p, a, b):
    d = sub(b, a)
    length2 = dot(d, d)
    t = dot(sub(p, a), d)/length2 if length2 else 0.
    return lerp(a, b, min(1., max(0., t)))


def project_triangle(p, tri):
    n = normal(tri)
    n2 = dot(n, n)
    if n2:
        t = dot(sub(p, tri[0]), n)/n2
        q = sub(p, tuple(t*v for v in n))
        if in_face(q, tri, n):
            return q
    return min((project_segment(p, a, b) for a, b in edges(tri)), key=lambda q: dist2(p, q))


def edge_points(a, b, c, d):
    """Interior/interior closest points. Endpoints are covered by vertex/face tests."""
    u, v, w = sub(b, a), sub(d, c), sub(c, a)
    n = cross(u, v)
    denom = dot(n, n)
    if denom:
        s, t = dot(cross(w, v), n)/denom, dot(cross(w, u), n)/denom
        if 0. <= s <= 1. and 0. <= t <= 1.:
            return lerp(a, b, s), lerp(c, d, t)
    return None


def triangle_gap(a, b):
    """Squared surface distance and the closest point on each triangle."""
    ea, eb = edges(a), edges(b)
    na, nb = normal(a), normal(b)
    for source, target, n in ((ea, b, nb), (eb, a, na)):
        for p, q in source:
            t = segment_face(p, q, target, n)
            if t is not None:
                hit = lerp(p, q, t)
                return 0., hit, hit
    candidates = [(p, project_triangle(p, b)) for p in a] + [(project_triangle(p, a), p) for p in b]
    for (p, q), (r, s) in product(ea, eb):
        closest = edge_points(p, q, r, s)
        if closest is not None:
            candidates.append(closest)
    p, q = min(candidates, key=lambda pair: dist2(*pair))
    return dist2(p, q), p, q


class TriangleNode:
    """Double-precision bounds for rejecting whole batches of triangle pairs."""
    def __init__(self, rows):
        self.box = union(b for b, _tri in rows)
        self.size = len(rows)
        if self.size <= 4:
            self.tris, self.children = [tri for _b, tri in rows], ()
        else:
            axis = max(range(3), key=lambda i: self.box[i+3]-self.box[i])
            rows.sort(key=lambda row: row[0][axis]+row[0][axis+3])
            mid = self.size//2
            self.children = (TriangleNode(rows[:mid]), TriangleNode(rows[mid:]))


def surface_gap(a, b, best):
    """Branch and bound. AABB distances are lower bounds, triangle distances upper bounds."""
    heap, order = [], count()

    def push(x, y):
        lower = box_dist2(x.box, y.box)
        if lower < best[0]:
            heapq.heappush(heap, (lower, next(order), x, y))

    push(a, b)
    while heap:
        lower, _serial, x, y = heapq.heappop(heap)
        if lower >= best[0]:
            break
        if x.children and (not y.children or x.size >= y.size):
            for child in x.children:
                push(child, y)
        elif y.children:
            for child in y.children:
                push(x, child)
        else:
            for t, u in product(x.tris, y.tris):
                hit = triangle_gap(t, u)
                if hit[0] < best[0]:
                    best = hit
                    if hit[0] == 0.:
                        return best
    return best


class Mesh:
    def __init__(self, points, indices):
        self.points, self.indices = points, indices
        self.box = bounds(points)

    @cached_property
    def faces(self):
        return [tuple(self.points[i] for i in ids) for ids in self.indices]

    @cached_property
    def tree(self):
        return TriangleNode([(bounds(tri), tri) for tri in self.faces])

    @cached_property
    def closed(self):
        counts = Counter(tuple(sorted(e)) for tri in self.indices for e in edges(tri))
        return bool(counts) and all(n == 2 for n in counts.values())

    def _bvh(self, origin):
        from mathutils.bvhtree import BVHTree
        return BVHTree.FromPolygons([sub(p, origin) for p in self.points], self.indices, all_triangles=True)

    @cached_property
    def world_bvh(self):
        return self._bvh((0., 0., 0.))

    @cached_property
    def origin(self):
        return lerp(self.box[:3], self.box[3:], .5)

    @cached_property
    def local_bvh(self):
        return self._bvh(self.origin)

    @cached_property
    def size(self):
        return max(self.box[i+3]-self.box[i] for i in range(3))

    def nearest(self, p):
        # Use Blender's triangle index as a seed, then measure on that triangle in double precision.
        _point, _normal, index, _distance = self.local_bvh.find_nearest(sub(p, self.origin))
        return project_triangle(p, self.faces[index]) if index is not None else self.faces[0][0]

    def inside(self, p):
        # Odd/even ray crossings work regardless of the input normals or mirrored transforms.
        # Take a majority to handle rays grazing a triangulated edge or vertex.
        local = sub(p, self.origin)
        eps = math.ldexp(self.size, -22)
        votes = 0
        for direction in ((1., .431, .217), (.183, 1., .727), (.653, .159, 1.)):
            unit = tuple(v/math.hypot(*direction) for v in direction)
            start, odd = local, False
            while True:
                hit, _normal, index, _distance = self.local_bvh.ray_cast(start, unit)
                if index is None:
                    break
                odd = not odd
                start = tuple(max(0., dot(sub(hit, start), unit))*v + x + eps*v for x, v in zip(start, unit))
            votes += odd
        return votes >= 2


def overlap_candidates(a, b):
    return sorted(a.world_bvh.overlap(b.world_bvh)) if box_dist2(a.box, b.box) == 0. else []


def intersection_samples(source, target, hits):
    """Sample crossed edges and interiors bounded by intersection segments."""
    cuts = defaultdict(set)
    face_hits = defaultdict(set)
    for i, j in hits:
        src, tri = source.faces[i], target.faces[j]
        ns, nt = normal(src), normal(tri)
        for a, b in edges(source.indices[i]):
            lo, hi = sorted((a, b))
            p, q = source.points[lo], source.points[hi]
            t = segment_face(p, q, tri, nt)
            if t is not None:
                cuts[lo, hi].add(t)
                face_hits[i].add(lerp(p, q, t))
        for p, q in edges(tri):
            t = segment_face(p, q, src, ns)
            if t is not None:
                face_hits[i].add(lerp(p, q, t))
    for (i, j), ts in cuts.items():
        ends = sorted({0., 1., *ts})
        for a, b in zip(ends, ends[1:]):
            yield lerp(source.points[i], source.points[j], (a+b)*.5)
    for points in face_hits.values():
        yield centroid(points)


def penetration(a, b, hits, threshold):
    """Largest sampled distance to the other surface from strictly inside a closed mesh."""
    shared = tuple(max(a.box[i], b.box[i]) for i in range(3)) + tuple(min(a.box[i], b.box[i]) for i in range(3, 6))
    if any(shared[i] > shared[i+3] for i in range(3)):
        return None
    depth, at = max(threshold, SURFACE_EPS), None
    for source, target, overlaps in ((a, b, hits), (b, a, [(j, i) for i, j in hits])):
        if not target.closed:
            continue
        samples = dict.fromkeys(p for tri in source.faces for p in (*tri, centroid(tri)))
        samples.update(dict.fromkeys(intersection_samples(source, target, overlaps)))
        for p in samples:
            if any(p[i] <= target.box[i] or p[i] >= target.box[i+3] for i in range(3)):
                continue
            distance = math.sqrt(dist2(p, target.nearest(p)))
            if distance > depth and target.inside(p):
                depth, at = distance, p
    # Coincident solids can put all surface samples on the boundary. A point strictly inside
    # both closed meshes also proves volumetric overlap. Include it at every tolerance.
    if a.closed and b.closed and all(shared[i] < shared[i+3] for i in range(3)):
        center = lerp(shared[:3], shared[3:], .5)
        distance = min(math.sqrt(dist2(center, m.nearest(center))) for m in (a, b))
        if distance > depth and a.inside(center) and b.inside(center):
            depth, at = distance, center
    return (depth, at) if at is not None else None


def contact_gap(a, b, hits):
    # BVH overlaps seed zero-distance candidates. The double-precision search also covers
    # coplanar contacts and the edge/edge minimum between two separated meshes.
    for i, j in hits:
        gap = triangle_gap(a.faces[i], b.faces[j])
        if gap[0] == 0.:
            return gap
    p = a.faces[0][0]
    q = b.nearest(p)
    best = surface_gap(a.tree, b.tree, (dist2(p, q), p, q))
    if best[0] and box_dist2(a.box, b.box) == 0. and (a.closed or b.closed):
        overlap = penetration(a, b, hits, 0.)
        if overlap is not None:
            return 0., overlap[1], overlap[1]
    return best


def evaluated_mesh(obj, matrix, convert, triangulate):
    if obj.type not in {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META', 'CURVES'}:
        return None
    mesh = obj.to_mesh()
    if mesh is None:
        return None
    try:
        # The evaluated Blender matrix and vertices are float32. Accumulate the world transform
        # in double precision so nearby surfaces far from the origin retain their spacing.
        m = tuple(tuple(row) for row in matrix)[:3]
        points = [convert(tuple(dot(row, v.co)+row[3] for row in m)) for v in mesh.vertices]
        indices = []
        if triangulate:
            mesh.calc_loop_triangles()
            for tri in mesh.loop_triangles:
                ids = tuple(tri.vertices)
                n = normal(tuple(points[i] for i in ids))
                if dot(n, n) > 0.:
                    indices.append(ids)
        return Mesh(points, indices) if points else None
    finally:
        obj.to_mesh_clear()


def scene_meshes(scene, depsgraph, roots, convert, triangulate):
    """Assign evaluated objects and each generated instance to all matching entity roots."""
    by_root = defaultdict(list)
    direct = set()

    def add(obj, ancestor, matrix):
        owners = []
        while ancestor is not None:
            if ancestor.name in roots:
                owners.append(ancestor.name)
            ancestor = ancestor.parent
        if owners:
            mesh = evaluated_mesh(obj, matrix, convert, triangulate)
            if mesh is not None:
                for name in owners:
                    by_root[name].append(mesh)

    for instance in depsgraph.object_instances:
        obj = instance.object
        if instance.is_instance:
            add(obj, instance.parent.original, instance.matrix_world)
        else:
            direct.add(obj.original.name)
            add(obj, obj.original, instance.matrix_world)
    # Viewport-disabled objects can be absent from object_instances. Their geometry still
    # belongs to the declared assembly, as in the frame metadata.
    if len(direct) < len(scene.objects):
        for obj in scene.objects:
            if obj.name not in direct:
                ev = obj.evaluated_get(depsgraph)
                add(ev, obj, ev.matrix_world)
    return by_root


def pair_measure(kind, a, b, tol):
    pairs = [(box_dist2(x.box, y.box), x, y) for x, y in product(a, b) if x is not y and x.indices and y.indices]
    if kind == 'intersect':
        best, at = tol, None
        for lower, x, y in pairs:
            if lower == 0.:
                hit = penetration(x, y, overlap_candidates(x, y), best)
                if hit is not None:
                    best, at = hit
        return (best, at) if at is not None else None

    best = math.inf, None, None
    for lower, x, y in sorted(pairs, key=lambda row: row[0]):
        if lower >= best[0]:
            break
        measured = contact_gap(x, y, overlap_candidates(x, y))
        if measured[0] < best[0]:
            best = measured
    return (math.sqrt(best[0]), lerp(best[1], best[2], .5)) if best[1] is not None else None


def run_query(plan, scene, depsgraph, entities, anchors, ignored, convert):
    kind, names, tol = plan['kind'], plan['of'], plan['tol']
    if kind == 'anchor':
        items = [item(a, math.hypot(*p), p) for a, p in anchors.items()]
        anchored = {a.split('#', 1)[0] for a in anchors}
        for a in names:
            if a not in anchored:
                row = entities[a]
                roots = row['_roots'] or row['_objects']
                obj = scene.objects.get(roots[0]) if roots else None
                p = convert(obj.evaluated_get(depsgraph).matrix_world.translation) if obj is not None else (0., 0., 0.)
                items.append(item(f'{a}#origin', math.hypot(*p), p))
        return finish(kind, items)

    paired = kind in {'intersect', 'contact'}
    against = plan.get('against')
    if paired and (not names or against == [] or (against is None and len(names) < 2)):
        return finish(kind, ())
    wanted = set(names).union(against or ()) if paired else names
    pairs = candidate_pairs(names, against) if paired else ()
    roots = {o for name in wanted for o in entities[name]['_objects']}
    meshes = scene_meshes(scene, depsgraph, roots, convert, paired) if roots else {}
    by_name = {name: list(dict.fromkeys(m for o in entities[name]['_objects'] for m in meshes.get(o, ()))) for name in wanted}
    boxes = {name: union(m.box for m in ms) for name, ms in by_name.items()}
    items = []
    for a in names if not paired else ():
        box = boxes[a]
        if box is None:
            continue
        if kind == 'bbox3d':
            items.append(item(a, math.dist(box[:3], box[3:]), box))
        elif -box[1] > tol:
            low = min((p for m in by_name[a] for p in m.points), key=lambda p: (p[1], p[0], p[2]))
            items.append(item(a, -low[1], low))
    for a, b in pairs:
        if kind == 'intersect' and frozenset((a, b)) in ignored:
            continue
        if boxes[a] is None or boxes[b] is None or (kind == 'intersect' and box_dist2(boxes[a], boxes[b]) > 0.):
            continue
        measured = pair_measure(kind, by_name[a], by_name[b], tol)
        if measured is not None:
            items.append(item(a, *measured, b=b))
    return finish(kind, items)
