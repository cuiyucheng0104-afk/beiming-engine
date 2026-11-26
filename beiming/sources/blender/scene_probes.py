"""Capture evaluated probe inputs while the worker owns the scene pose."""
import numpy as np


def camera_at(scene, depsgraph, axis, rigid, size):
    cam = scene.camera.evaluated_get(depsgraph)
    rot, pos = rigid(cam.matrix_world)
    view = np.eye(4)
    view[:3, :3] = (axis @ rot).T
    view[:3, 3] = -(rot.T @ pos)
    p = cam.calc_matrix_camera(depsgraph, x=size[0], y=size[1])
    return view, {'view': view.T.reshape(-1).tolist(), 'left': (p[0][2] - 1) / p[0][0], 'right': (p[0][2] + 1) / p[0][0],
                  'bottom': (p[1][2] - 1) / p[1][1], 'top': (p[1][2] + 1) / p[1][1],
                  'near': cam.data.clip_start, 'far': cam.data.clip_end}


def narrow_budget(points, triangles, view, camera):
    """Count triangles fully in view in numpy and send only clipping-boundary triangles over IPC."""
    p = points @ view[:3, :3].T + view[:3, 3]
    x, y, d = p[:, 0], p[:, 1], -p[:, 2]
    planes = np.stack((d - camera['near'], camera['far'] - d, x - camera['left'] * d, camera['right'] * d - x,
                       y - camera['bottom'] * d, camera['top'] * d - y), axis=1)
    inside_count, boundary = 0, []
    for start in range(0, len(triangles), 20000):
        faces = triangles[start:start + 20000]
        sides = planes[faces] >= 0
        inside = sides.all(axis=(1, 2))
        outside = ~sides.any(axis=1).all(axis=1)
        boundary.append(faces[~(inside | outside)])
        good = faces[inside]
        sx, sy = x[good] / d[good], y[good] / d[good]
        area = (sx[:, 1] - sx[:, 0]) * (sy[:, 2] - sy[:, 0]) - (sy[:, 1] - sy[:, 0]) * (sx[:, 2] - sx[:, 0])
        inside_count += int(np.count_nonzero(np.abs(area) > 1e-14))
    remainder = np.concatenate(boundary).reshape(-1) if boundary else np.empty(0, dtype=np.int32)
    used, indices = np.unique(remainder, return_inverse=True)
    return inside_count, points[used], indices


def snapshot(scene, depsgraph, plan, entities, axis, rigid, size):
    names_by_mesh, poses = {}, {}
    kind = plan['kind']
    camera_probe = kind in ('probe.near-clip', 'probe.tri-budget')
    if camera_probe:
        view, camera = camera_at(scene, depsgraph, axis, rigid, size)
    need_meshes = kind != 'probe.joint-vel'
    targets = [(name, plan.get('bone')) for name in plan['of']]
    targets += [(name, plan.get('againstBone')) for name in plan.get('against', [])]
    for name, bone_name in targets:
        entry = entities[name]
        roots = entry['_roots']
        if len(roots) == 1:
            obj = scene.objects[roots[0]].evaluated_get(depsgraph)
            key = name
            if bone_name:
                bone = obj.pose.bones.get(bone_name) if obj.type == 'ARMATURE' else None
                if bone is None:
                    continue
                key = f'{name}#{bone_name}'
                relative = bone.parent.matrix.inverted_safe() @ bone.matrix if bone.parent else bone.matrix
                world = obj.matrix_world @ bone.matrix
            else:
                relative, world = obj.matrix_local, obj.matrix_world
            position = axis @ np.array(world.translation)
            pose = {'position': position.tolist(), 'rotation': list(relative.to_quaternion().normalized())}
            if kind == 'probe.deform':
                rotation = axis @ np.array(world.to_quaternion().to_matrix()) @ axis.T
                inverse = np.eye(4)
                inverse[:3, :3] = rotation.T
                inverse[:3, 3] = -(rotation.T @ position)
                pose['rootInverse'] = inverse.T.reshape(-1).tolist()
            poses[key] = pose
        if need_meshes:
            for obj_name in entry['_objects']:
                names_by_mesh.setdefault(obj_name, []).append(name)

    meshes, inside = [], 0
    if need_meshes:
        for instance in depsgraph.object_instances:
            # Do not retain bpy's instance wrapper across iterator steps.
            obj = instance.object
            original = obj.original
            owner = instance.parent.original if instance.is_instance else original
            names = names_by_mesh.get(owner.name, [])
            if obj.type != 'MESH' or not (names or plan.get('allScene')):
                continue
            if not camera_probe and instance.is_instance:
                continue
            visible = (instance.show_self and not (owner.hide_render or original.hide_render)
                       and owner.visible_camera and original.visible_camera)
            if camera_probe and not visible:
                continue
            mesh = obj.to_mesh()
            if mesh is None:
                continue
            try:
                local = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
                mesh.vertices.foreach_get('co', local)
                m = np.array(instance.matrix_world, dtype=np.float64)
                points = (local.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]) @ axis.T
                triangles = np.empty(0, dtype=np.int32)
                if kind not in ('probe.ground', 'probe.footslide'):
                    mesh.calc_loop_triangles()
                    triangles = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
                    mesh.loop_triangles.foreach_get('vertices', triangles)
                if kind == 'probe.tri-budget':
                    count, points, triangles = narrow_budget(points, triangles.reshape(-1, 3), view, camera)
                    inside += count
                    if not len(triangles):
                        continue
                instance_id = '.'.join(str(x) for x in instance.persistent_id) if instance.is_instance else ''
                meshes.append({'id': ':'.join((owner.name, original.name, instance_id)), 'names': names,
                               'vertices': points.tolist(), 'indices': triangles.tolist(), 'visible': visible})
            finally:
                obj.to_mesh_clear()

    result = {'poses': poses, 'meshes': meshes}
    if camera_probe:
        result.update(camera=camera, insideTriangles=inside)
    return result
