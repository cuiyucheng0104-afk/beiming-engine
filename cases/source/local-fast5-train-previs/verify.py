"""门禁：在重建好的 Blender 场景里，用每个镜头的相机把主时间轴世界里的物体投回画面，和读点比像素误差。
    Blender -b out/previs.blend --python-exit-code 1 -P verify.py
这里检验的是"一个世界 + 25 台相机"能不能同时解释所有读点（逐镜头求解只保证单镜头自洽）。
可比的读点：端柱底、科尔维特车轮/车头尾/中心、卡车中心、布莱恩。阈值在 data/gate.json。"""
import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

ROOT = os.path.dirname(os.path.abspath(bpy.data.filepath)) + "/.."
sys.path.insert(0, ROOT)
import calib as cb  # noqa: E402
import cammodel as cm  # noqa: E402

sc = bpy.context.scene
W, H = sc.render.resolution_x, sc.render.resolution_y
import human as hm  # noqa: E402
import poses as ps  # noqa: E402
import world as wd  # noqa: E402

# 读点：v1 → v2 → v3 逐版合并（同帧同名新版覆盖），见 picks_io.py
import picks_io  # noqa: E402
picks = picks_io.all_shots()
DOM_SHOTS = {"S02", "S05", "S06"}
HUMAN = set(hm.NAMES) | {"brian", "brian_head", "brian_pelvis"}   # 人物点是姿态拟合的输入，只报告不卡门禁（否则自己验自己）
gate = json.load(open(os.path.join(ROOT, "data/gate.json")))
cv, tr, br, pn, ty, bx = (bpy.data.objects[n] for n in ("SLOT_Corvette", "SLOT_Truck", "SLOT_Brian", "SLOT_Panel", "SLOT_Tire", "SLOT_Box"))
fails, per_shot, allerr = [], {}, []

# 自检：Blender 相机与 cammodel 投影约定一致（取 S21 首帧）
f0 = cb.SHOTS["S21"][0]
sc.frame_set(f0)
cam = bpy.data.objects["CAM_S21"]
keys = json.load(open(os.path.join(ROOT, "data/cams.json")))["S21"]["keys"]
k = next(r for r in keys if r[0] == f0)
P = Vector((0.0, -cb.TRUSS_Y, 5.0))
c = world_to_camera_view(sc, cam, P)
a = (c.x * W, (1 - c.y) * H)
b = cm.project([tuple(P)], k[1:4], k[4], k[5], k[6], k[7])[0]
if math.dist(a, b) > 1.0:
    fails.append(f"Blender 相机与 cammodel 投影不一致：{a} vs {tuple(b)}")

cams_src = {k: c["src"] for k, c in json.load(open(os.path.join(ROOT, "data/cams.json"))).items()}
detail = {}
for s in picks:
    shot = s["shot"]
    if cams_src.get(shot) == "rig":          # 特写机位是按描述摆的构图，不参与门禁
        continue
    cam = bpy.data.objects[f"CAM_{shot}"]
    for kf in s["keys"]:
        f = kf["frame"]
        sc.frame_set(f)
        mc, mt = cv.matrix_world, tr.matrix_world
        def near(lx):
            # 科尔维特近侧车轮：取离相机更近的一侧
            pa, pb = mc @ Vector((lx, 0.72, 0)), mc @ Vector((lx, -0.72, 0))
            return pa if (pa - cam.matrix_world.translation).length < (pb - cam.matrix_world.translation).length else pb
        model = {
            "portal_base": Vector((0, -cb.TRUSS_Y, 0)),
            "cv_fw": near(cb.CV_WB / 2), "cv_rw": near(-cb.CV_WB / 2),
            "cv_nose": mc @ Vector((cb.CV_LEN / 2, 0, 0.55)), "cv_tail": mc @ Vector((-cb.CV_LEN / 2, 0, 0.55)),
            "cv_c": mc @ Vector((0, 0, 0.6)), "tr_c": mt @ Vector((0, 0, 0)), "brian": br.matrix_world.translation,
            "brian_pelvis": br.matrix_world.translation,
            # S23 读的是货厢（中心、两端）；S21 的 e1 起爆前是顶在端柱上的驾驶室前上角，起爆后是拟合用的车架角点
            "dbr_c": (bx if shot == "S23" else tr).matrix_world @ Vector((0, 0, 0)),
            "dbr_e1": (bx.matrix_world @ Vector((2.25, 0, 0))) if shot == "S23" else
                      mt @ Vector((cb.TRUCK_LEN / 2, -cb.TRUCK_W / 2, 1.3)),
            "dbr_e2": (bx.matrix_world @ Vector((-2.25, 0, 0))) if shot == "S23" else mt @ Vector((-cb.TRUCK_LEN / 2, 0, 0)),
            "pnl_c": pn.matrix_world @ Vector((0, 0, 0)), "pnl_latch": pn.matrix_world @ Vector((-2.5, 0, -1.2)),
            "pnl_e1": pn.matrix_world @ Vector((-2.5, 0, 1.2)), "pnl_e2": pn.matrix_world @ Vector((-2.5, 0, -1.2)),
            "tire_c": ty.matrix_world @ Vector((0, 0, 0)),
        }
        J = hm.fk(ps.q_at("dom" if shot in DOM_SHOTS else "brian", f))
        for jn in hm.NAMES:
            model[jn] = Vector(J[jn])
        model["brian_head"] = model["head"]
        for p in kf["picks"]:
            if p["name"] not in model:
                continue
            c = world_to_camera_view(sc, cam, model[p["name"]])
            if c.z <= 0:
                e = 999.0
            else:
                e = math.dist((c.x * W, (1 - c.y) * H), (p["u"], p["v"]))
            detail.setdefault(shot, []).append((round(min(e, 999.0)), f, p["name"]))
for shot, d in detail.items():
    # 分三类：几何（车、桥、火车）卡门禁；人物关节、爆炸碎片单独统计
    geo = sorted(e for e, f, nm in d if nm not in HUMAN and not nm.startswith(("dbr", "pnl", "tire")))
    if geo:
        per_shot[shot] = (geo[len(geo) // 2], geo[-1], len(geo))
        allerr += geo
for cat, sel in (("人物关节", lambda nm: nm in HUMAN), ("爆炸碎片", lambda nm: nm.startswith(("dbr", "pnl", "tire")))):
    es = sorted(e for d in detail.values() for e, f, nm in d if sel(nm))
    if es:
        print(f"{cat}：中位 {es[len(es) // 2]:.1f}px，90 分位 {es[int(len(es) * 0.9)]:.1f}px（{len(es)} 个点，只报告不卡门禁）")
        for shot, d in sorted(detail.items()):
            e2 = sorted(e for e, f, nm in d if sel(nm))
            if e2:
                byn = {}
                for e, f, nm in d:
                    if sel(nm):
                        byn.setdefault(nm, []).append(e)
                print(f"   {shot}: 中位 {e2[len(e2) // 2]:.0f}px（{len(e2)} 点）  " + "  ".join(f"{n} {sorted(v)[len(v) // 2]:.0f}" for n, v in sorted(byn.items())))
print(" 镜头   中位px   最大px   点数（几何点）")
for k, (md, mx, n) in sorted(per_shot.items()):
    flag = "  ← 超门槛" if md > gate["shot_median_px"] and k not in gate["known_bad_shots"] else ""
    worst = sorted((x for x in detail[k] if x[2] not in HUMAN and not x[2].startswith(("dbr", "pnl", "tire"))), reverse=True)[:3]
    print(f" {k}   {md:6.1f}  {mx:7.1f}   {n:3d}{flag}   最差: " + ", ".join(f"{nm}@{f}={e}" for e, f, nm in worst))
    if flag:
        fails.append(f"{k} 中位误差 {md:.1f}px")
allerr.sort()
med = allerr[len(allerr) // 2]
print(f"全片中位误差 {med:.1f}px（{len(allerr)} 个点；门槛 {gate['median_px']}）")
if med > gate["median_px"]:
    fails.append(f"全片中位误差 {med:.1f}px")
print("VERIFY", "OK" if not fails else fails)
if fails:
    raise SystemExit(1)
