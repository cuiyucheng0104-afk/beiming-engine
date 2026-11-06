"""门禁：定量核对预演，有一项不达标就以非 0 退出（run.sh 靠它判红绿）。

1. 投影误差：翻滚车车身中心正下方的路面点投影回 CAM_POV，与原片人工读点比像素误差（阈值见 data/gate.json）。
2. 倒放逻辑：镜头 2 开头车倒扣，结尾车正着、随本车前进。
3. 物理：build.py 写的 out/physics.json 里，超限帧（加速度、角速度、z'' < -g）只能是 gate.json 里登记过的已知帧。

    Blender -b out/previs.blend --python-exit-code 1 -P verify.py
"""
import json
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

ROOT = os.path.dirname(os.path.abspath(bpy.data.filepath)) + "/.."
sys.path.insert(0, ROOT)
import calib as cb  # noqa: E402
from flip_keys import PICKS as picks  # noqa: E402

gate = json.load(open(os.path.join(ROOT, "data/gate.json")))
phys = json.load(open(os.path.join(ROOT, "out/physics.json")))
scene = bpy.context.scene
flip, cam = bpy.data.objects["SLOT_FlipCar"], bpy.data.objects["CAM_POV"]
W, H = scene.render.resolution_x, scene.render.resolution_y
fails = []
if scene.render.fps != cb.FPS or scene.frame_end != cb.FRAMES:
    fails.append(f"场景时间基准 {scene.render.fps}fps/{scene.frame_end} 帧，应为 {cb.FPS}/{cb.FRAMES}（blend 过期？）")

print(" frame  原片(u,v)    模型(u,v)    误差px   车 up.z")
errs = []
for f, (u, v) in sorted(picks.items()):
    scene.frame_set(f)
    p = flip.matrix_world.translation
    c = world_to_camera_view(scene, cam, Vector((p.x, p.y, 0.0)))
    mu, mv = c.x * W + cb.X_OFF, (1 - c.y) * H
    up = (flip.matrix_world.to_3x3() @ Vector((0, 0, 1))).z
    e = ((mu - u) ** 2 + (mv - v) ** 2) ** 0.5
    errs.append(e)
    print(f" {f:4d}  ({u:3d},{v:3d})   ({mu:5.0f},{mv:4.0f})   {e:5.1f}   {up:5.2f}")
med, mx = sorted(errs)[len(errs) // 2], max(errs)
print(f"中位误差 {med:.1f}px，最大 {mx:.1f}px（画面宽 784px；门槛 {gate['median_px']} / {gate['max_px']}）")
if med > gate["median_px"] or mx > gate["max_px"]:
    fails.append(f"投影误差超门槛：中位 {med:.1f}、最大 {mx:.1f}")

scene.frame_set(cb.F30_TO_24[60])
if (flip.matrix_world.to_3x3() @ Vector((0, 0, 1))).z > -0.9:
    fails.append("镜头 2 开头（原 30fps 第 60 帧）应倒扣")
scene.frame_set(cb.FRAMES - 1)
a = flip.matrix_world.translation.copy()
scene.frame_set(cb.FRAMES)
b = flip.matrix_world.translation.copy()
if (flip.matrix_world.to_3x3() @ Vector((0, 0, 1))).z < 0.9 or b.y - a.y < 0.3:
    fails.append("结尾应正着、随本车前进")

bad = sorted({f for f in phys["over"]} | {f for f, _ in phys["faster_than_g"]})
new = [f for f in bad if f not in gate["known_physics_frames"]]
print(f"物理：最大加速度 {phys['a_max']} m/s² @{phys['a_max_frame']}，最大角速度 {phys['w_max']} rad/s @{phys['w_max_frame']}；"
      f"超限帧 {bad}（已登记 {gate['known_physics_frames']}）")
if new:
    fails.append(f"出现未登记的物理超限帧 {new}")
print("VERIFY", "OK" if not fails else fails)
if fails:
    raise SystemExit(1)
