# 生成一个测试用 GLB：车头朝 +X（故意和场景的 +Y 不同），长 4.4m，用来测换模型脚本
import bpy, bmesh
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
me = bpy.data.meshes.new("TestCar"); bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0); bmesh.ops.scale(bm, vec=(4.4, 1.8, 1.0), verts=bm.verts)
nose = bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.4, radius2=0.0, depth=0.8)
bmesh.ops.rotate(bm, cent=(0,0,0), matrix=__import__("mathutils").Matrix.Rotation(-1.5708, 3, "Y"), verts=nose["verts"])
bmesh.ops.translate(bm, vec=(2.6, 0, 0), verts=nose["verts"])
bm.to_mesh(me); bm.free()
o = bpy.data.objects.new("TestCar", me); bpy.context.scene.collection.objects.link(o)
m = bpy.data.materials.new("Green"); m.diffuse_color = (0.1, 0.8, 0.2, 1); o.data.materials.append(m)
bpy.ops.export_scene.gltf(filepath="out/test_car.glb", export_format="GLB")
