"""俯视位置图：两辆车每个时刻的位置和姿态、本车机位朝向，叠在实测的路面布局上。

    Blender -b out/previs.blend --python-exit-code 1 -P plan.py -- --out out/plan.png
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.expanduser("~/.claude/skills/blender/scripts"))
import boilerplate as bp  # noqa: E402

scene = bpy.context.scene
TIMES = [1.4, 3.97, 4.5, 5.0, 5.5, 6.0, 6.5, 7.5, 8.83, 9.6]
hero, flip, cam = (bpy.data.objects[n] for n in ("SLOT_HeroCar", "SLOT_FlipCar", "CAM_POV"))
for n in ("bridge_deck", "bridge_rail", "slope", "MODEL_Driver", "MODEL_Passenger"):
    for o in bpy.data.objects:
        if o.name.startswith(n) or o.name.startswith("bridge_") or o.name.startswith("lamp_"):
            o.hide_render = True
for o in list(hero.children_recursive):
    if o.type == "MESH":
        o.hide_render = True
for o in flip.children_recursive:
    o.hide_render = True


def mat(name, rgb):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    return m


def text(s, loc, size, rgb):
    cu = bpy.data.curves.new("txt", "FONT")
    cu.body, cu.size, cu.align_x = s, size, "CENTER"
    o = bp.new_object("label", cu)
    o.location, o.rotation_euler = loc, (0, 0, math.radians(90))
    o.color = (*rgb, 1)
    return o


body = bpy.data.objects["flip_body"]
placed = []
for t in TIMES:
    f = int(round(t * scene.render.fps)) + 1
    scene.frame_set(f)
    # 翻滚车：复制物理凸包，按当时的位姿摆放（看得出朝向和翻滚状态）
    up = (flip.matrix_world.to_3x3() @ Vector((0, 0, 1))).z
    col = (0.95, 0.45, 0.1, 1) if up > 0.5 else ((0.6, 0.2, 0.05, 1) if up < -0.5 else (0.9, 0.7, 0.2, 1))
    for part in [o for o in flip.children_recursive if o.type == "MESH"]:
        dup = part.copy()
        world = part.matrix_world.copy()
        dup.parent = None
        dup.matrix_world = world
        scene.collection.objects.link(dup)
        dup.hide_render = False
        if part.name.startswith(("flip_body", "flip_cabin")):
            dup.color = col
        else:
            m = part.active_material
            dup.color = m.diffuse_color if m else col
    fp = flip.matrix_world.translation.copy()
    if all((fp - q).length > 3.0 for q in placed):
        text(f"{t:.1f}s", (fp.x + 2.6, fp.y, 2), 1.3, (0.55, 0.2, 0.0))
    else:
        text(f"{t:.1f}s", (fp.x + 2.6 + 1.6 * sum((fp - q).length <= 3.0 for q in placed), fp.y, 2), 1.3,
             (0.55, 0.2, 0.0))
    placed.append(fp)
    # 本车：轮廓 + 机位视野楔形
    hp = hero.matrix_world.translation
    bp.mesh_from_bmesh("hero_box", lambda bm: __import__("bmesh").ops.create_cube(bm, size=1.0))
    hb = bpy.data.objects[-1] if False else [o for o in scene.objects if o.name.startswith("hero_box")][-1]
    hb.scale, hb.location = (1.85, 4.8, 0.4), (hp.x, hp.y, 0.3)
    hb.color = (0.2, 0.35, 0.7, 1)
    text(f"{t:.1f}s", (hp.x - 2.4, hp.y, 2), 1.3, (0.05, 0.12, 0.45))
    if t < 6.85 or t > 8.8:                               # S2 / S4 的机位朝向
        fwd = cam.matrix_world.to_3x3() @ Vector((0, 0, -1))
        yaw = math.atan2(fwd.x, fwd.y)
        L = 9.0                                            # 机位朝向线
        w = bp.mesh_from_bmesh("aim", lambda bm: __import__("bmesh").ops.create_cube(bm, size=1.0))
        w.scale = (0.18, L, 0.1)
        w.rotation_euler = (0, 0, -yaw)
        w.location = (hp.x + math.sin(yaw) * L / 2, hp.y + math.cos(yaw) * L / 2, 0.35)
        w.color = (0.1, 0.25, 0.9, 1)

# 图例（尽量用系统中文字体）
legend = ("俯视位置图（实测路面布局）  蓝=本车（相机车）  橙=翻滚车：浅橙 正着 / 黄 侧着 / 深橙 倒扣  "
          "蓝线=镜头朝向  数字=成片时刻  车沿 → 方向行驶")
lt = text(legend, (-9.5, 85.0, 2), 1.5, (0.1, 0.1, 0.1))
for fp in ("/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc",
           "/System/Library/Fonts/PingFang.ttc"):
    if os.path.exists(fp):
        try:
            lt.data.font = bpy.data.fonts.load(fp)
            break
        except RuntimeError:
            continue

# 正交俯视相机：路沿画面横向展开
cd = bpy.data.cameras.new("PlanCam")
cd.type, cd.ortho_scale = "ORTHO", 150
pc = bp.new_object("PlanCam", cd)
pc.location, pc.rotation_euler = (2.0, 85.0, 200.0), (0, 0, math.radians(90))
scene.camera = pc
for m in scene.timeline_markers:
    m.camera = pc
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "FLAT"
scene.display.shading.color_type = "OBJECT"
for o in scene.objects:
    if o.type == "MESH" and tuple(o.color) == (1, 1, 1, 1):
        m = o.active_material
        o.color = m.diffuse_color if m else (0.7, 0.7, 0.7, 1)
        if m and m.name.startswith("road"):
            o.color = (0.25, 0.25, 0.27, 1)
        if m and m.name.startswith("line"):
            o.color = (0.95, 0.95, 0.95, 1)
scene.render.resolution_x, scene.render.resolution_y = 2000, 560
scene.render.film_transparent = False
scene.frame_set(1)
out = bp.arg_value("--out", "out/plan.png")
scene.render.filepath = os.path.abspath(out)
bpy.ops.render.render(write_still=True)
print("plan ->", out)
