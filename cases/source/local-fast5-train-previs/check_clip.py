"""穿模检查：逐帧检查镜头相机和画面里的人物有没有钻进模型。
    Blender -b out/previs.blend --python-exit-code 1 -P check_clip.py [-- --frames 1-48]
判定方法：从测试点向 6 个方向打射线，若多数方向首先打到的是某个物体的背面（法线和射线同向），说明点在这个物体内部。
  相机：在任何物体内部，或离最近表面 < 0.12 m（近裁剪会把面切开）→ 穿模。
  人物：头、胸、腹、骨盆 4 个躯干部位的中心在车辆/火车/桥/地面内部，且这个部位在当帧镜头画面里 → 穿模。
  四肢搭在车上、坐进座舱属于正常接触，不算。
结果写到 out/clip_report.json，终端按镜头汇总；有穿模就以非 0 退出（run.sh 里只报告不拦截）。"""
import json
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

ROOT = os.path.dirname(os.path.abspath(bpy.data.filepath)) + "/.."
sys.path.insert(0, ROOT)
import calib as cb  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
fr = (1, cb.FRAMES)
if "--frames" in argv:
    a, b = argv[argv.index("--frames") + 1].split("-")
    fr = (int(a), int(b))

sc = bpy.context.scene
DIRS = [Vector(v) for v in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
SKIP = {"CAR_TEAR_CUTTER"}
TORSO = ("head", "chest", "abdomen", "pelvis")


def first_hit(dg, o, d, skip_prefix=()):
    """沿 d 打射线，跳过挖刀和指定前缀的物体；返回 (物体名, 是否背面, 距离)"""
    origin = o.copy()
    travelled = 0.0
    for _ in range(8):
        hit, loc, nrm, _, ob, _ = sc.ray_cast(dg, origin, d, distance=300.0)
        if not hit:
            return None, False, 1e9
        dist = (loc - origin).length
        travelled += dist
        if ob.name in SKIP or ob.name.startswith(skip_prefix):
            origin = loc + d * 1e-3
            continue
        return ob.name, nrm.dot(d) > 0, travelled
    return None, False, 1e9


NEAREST = [None]


def inside(dg, p, skip_prefix=()):
    votes, dmin = {}, 1e9
    for d in DIRS:
        name, back, dist = first_hit(dg, p, d, skip_prefix)
        if dist < dmin:
            NEAREST[0] = name
        dmin = min(dmin, dist)
        if name and back:
            votes[name] = votes.get(name, 0) + 1
    name = max(votes, key=votes.get) if votes else None
    return (name if name and votes[name] >= 4 else None), dmin


report = {}
for f in range(fr[0], fr[1] + 1):
    sc.frame_set(f)
    dg = bpy.context.evaluated_depsgraph_get()
    shot = cb.shot_of(f)
    cam = bpy.data.objects[f"CAM_{shot}"]
    pos = cam.matrix_world.translation.copy()
    obj, dmin = inside(dg, pos)
    rec = report.setdefault(shot, {"cam_inside": [], "cam_close": [], "person_inside": []})
    if obj:
        rec["cam_inside"].append([f, obj])
    elif dmin < 0.12:
        rec["cam_close"].append([f, round(dmin, 3), NEAREST[0]])
    for who in ("brian", "dom"):
        for part in TORSO:
            o = bpy.data.objects.get(f"{who}_{part}")
            if o is None:
                continue
            p = o.matrix_world.translation.copy()
            c = world_to_camera_view(sc, cam, p)
            if not (c.z > 0 and -0.05 < c.x < 1.05 and -0.05 < c.y < 1.05):
                continue
            if p.z < 0.05:
                rec["person_inside"].append([f, who, part, "地面"])
                continue
            ob, _ = inside(dg, p, skip_prefix=("brian_", "dom_"))
            if ob:
                rec["person_inside"].append([f, who, part, ob])

os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
json.dump(report, open(os.path.join(ROOT, "out/clip_report.json"), "w"), ensure_ascii=False, indent=1)
bad = 0
print(" 镜头  相机在模型内  相机贴面  人物躯干穿模")
for k, r in sorted(report.items()):
    n1, n2, n3 = len(r["cam_inside"]), len(r["cam_close"]), len({(x[0], x[1]) for x in r["person_inside"]})
    bad += n1 + n2 + n3
    if n1 or n2 or n3:
        ex = (r["cam_inside"][:2] or r["cam_close"][:2] or r["person_inside"][:2])
        print(f" {k}   {n1:4d}帧      {n2:4d}帧      {n3:4d}帧   例：{ex}")
print(f"CLIP 共 {bad} 处（帧 {fr[0]}–{fr[1]}）")
raise SystemExit(1 if bad else 0)
