"""把插槽里的白模换成你的 GLB 模型（动画在插槽上，换模型不影响运镜和轨迹）。

    Blender -b out/previs.blend --python-exit-code 1 -P swap_model.py -- \\
        --slot SLOT_FlipCar --glb ~/models/saab.glb [--rot 0] [--size auto] --save out/previs_saab.blend

  --slot  SLOT_FlipCar / SLOT_HeroCar / SLOT_Driver / SLOT_Passenger / SLOT_Env
  --rot   绕 Z 轴旋转（度），把模型车头转到 +Y。glTF 车模常见需要 0 / 90 / 180 / -90，看一眼渲染就知道
  --size  auto = 缩放到与原白模同长（场景插槽默认不缩放）；数字 = 指定最长边米数；none = 不缩放

对齐规则：车/人插槽对齐到原白模的包围盒（翻滚车按中心对齐，因为物理是绕中心翻的；
本车和人按底面对齐）。原白模只隐藏不删除，删掉新模型、取消隐藏即可换回。
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.expanduser("~/.claude/skills/blender/scripts"))
import boilerplate as bp  # noqa: E402

slot_name = bp.arg_value("--slot")
glb = os.path.expanduser(bp.arg_value("--glb"))
rot = math.radians(float(bp.arg_value("--rot", "0")))
size = bp.arg_value("--size", "auto")
save = bp.arg_value("--save")
assert slot_name and os.path.exists(glb), "需要 --slot 和存在的 --glb"

slot = bpy.data.objects[slot_name]
old = next(c for c in slot.children if c.name.startswith("MODEL_"))


def world_bbox(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        if o.type in {"MESH", "CURVE", "FONT"}:
            ev = o.evaluated_get(dg)
            pts += [ev.matrix_world @ Vector(c) for c in ev.bound_box]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    return lo, hi


def local_bbox(objs, ref):
    inv = ref.matrix_world.inverted()
    lo, hi = None, None
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        if o.type in {"MESH", "CURVE", "FONT"}:
            ev = o.evaluated_get(dg)
            pts += [inv @ ev.matrix_world @ Vector(c) for c in ev.bound_box]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    return lo, hi


scene = bpy.context.scene
scene.frame_set(1)
old_objs = [old] + list(old.children_recursive)
old_lo, old_hi = local_bbox(old_objs, slot)

# 导入 GLB，所有顶层对象挂到一个新组上
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=glb)
new_objs = [o for o in bpy.data.objects if o not in before]
tops = [o for o in new_objs if o.parent not in new_objs]
group = bp.new_object(f"MODEL_{os.path.splitext(os.path.basename(glb))[0]}")
group.empty_display_type = "CUBE"
for o in tops:
    mw = o.matrix_world.copy()
    o.parent = group
    o.matrix_world = Matrix.Rotation(rot, 4, "Z") @ mw

# 缩放 + 对齐（先在世界原点处理，再挂到插槽）
lo, hi = world_bbox(new_objs)
ext = hi - lo
if size == "auto" and slot_name != "SLOT_Env":
    s = (old_hi - old_lo).y / ext.y if ext.y > 1e-6 else 1.0
elif size not in ("auto", "none"):
    s = float(size) / max(ext)
else:
    s = 1.0
group.scale = (s, s, s)
bpy.context.view_layer.update()
lo, hi = world_bbox(new_objs)
target_center = (old_lo + old_hi) / 2
if slot_name == "SLOT_FlipCar":
    shift = target_center - (lo + hi) / 2                         # 中心对齐：物理绕中心翻
elif slot_name == "SLOT_Env":
    shift = Vector((0, 0, 0))
else:
    shift = Vector((target_center.x - (lo.x + hi.x) / 2, target_center.y - (lo.y + hi.y) / 2, old_lo.z - lo.z))
group.location = shift
group.parent = slot
group.matrix_parent_inverse = Matrix.Identity(4)

for o in old_objs:
    o.hide_render = True
    o.hide_viewport = True
print(f"[swap] {slot_name}: 原白模 {old.name} 已隐藏；新模型 {group.name} 缩放 {s:.3f}，"
      f"尺寸 {[round(v * s, 2) for v in ext]}m")
if save:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(save))
    print("saved", save)
