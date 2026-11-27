"""The matching world-space probe calibration for Blender."""
import bpy


def build(ctx):
    bpy.ops.object.camera_add(location=(0, 0, 0), rotation=(1.5707963267948966, 0, 0))
    bpy.context.scene.camera = bpy.context.object
    bpy.context.object.data.clip_start = 0.1
    bpy.context.object.data.clip_end = 50
    entities = []

    def register(name, obj):
        entities.append({'name': name, 'class': 'part', 'objects': [obj]})
        return obj

    def triangle(name, at):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([ctx.to_blender(p) for p in ((-.05, -.05, 0), (.05, -.05, 0), (0, .05, 0))], [], [(0, 1, 2)])
        ob = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(ob)
        ob.location = ctx.to_blender(at)
        return register(name, ob)

    def cube(name, at):
        bpy.ops.mesh.primitive_cube_add(size=.1, location=ctx.to_blender(at))
        return register(name, bpy.context.object)

    triangle('near', (0, 0, -.5))
    triangle('edge', (0, 0, -1))
    triangle('outside', (4, 0, -.5))
    triangle('behind', (0, 0, .5))
    cube('finger', (0, .0481, -2))
    cube('contact_a', (-.05, .2, -4))
    cube('contact_b', (.0505, .2, -4))
    deform = triangle('deform', (0, 1, -3))
    lead = triangle('lead', (-1, 1, -3))
    follow = triangle('follow', (1, 1, -3))

    # A reusable mesh outside the scene, visible only through the two child instancers.
    scene = bpy.context.scene
    reusable = bpy.data.collections.new('probe payload')
    bpy.ops.mesh.primitive_cube_add(size=.5)
    payload = bpy.context.object
    scene.collection.objects.unlink(payload)
    reusable.objects.link(payload)
    assembly = register('instance_assembly', bpy.data.objects.new('probe assembly', None))
    scene.collection.objects.link(assembly)
    assembly.location = ctx.to_blender((0, 0, -6))

    def add_instance(name, x, y):
        obj = bpy.data.objects.new(name, None)
        scene.collection.objects.link(obj)
        obj.parent = assembly
        obj.location = ctx.to_blender((x, y, 0))
        obj.instance_type, obj.instance_collection = 'COLLECTION', reusable
        return obj

    add_instance('left unregistered instancer', -.75, .0625)
    right = register('instance_assembly.right', add_instance('right instancer', .75, .125))

    def state(f):
        return {'objects': {
            assembly: {'location': ctx.to_blender((f * .25, 0, -6))},
            right: {'scale': (1.5 if f == 1 else 1, 1, 1)},
            deform: {'scale': (3.78 if f == 1 else 1, 1, 1), 'location': ctx.to_blender((f * .5, 1, -3)),
                     'rotation_euler': (0, f * .15, 0)},
            lead: {'rotation_euler': (0, .7 if f >= 1 else 0, 0)},
            follow: {'rotation_euler': (0, .6 if f >= 3 else 0, 0)},
        }}
    return {'entities': entities, 'state': state}
