"""把求解结果画回原片核对：绿点=读点，红叉=模型投影（点类读点），白线=模型的桥头端柱、近侧钢轨、车顶线，黄框=科尔维特。
    python3.14 overlay_solve.py S21 → out/peek/ovs_S21.jpg（每个关键帧一格拼起来）"""
import json
import math
import sys

import cv2
import numpy as np

import calib as cb
import cammodel as cm
from solve_shot import PITCH, V, JOINT_Z

shot = sys.argv[1]
S = json.load(open(f"data/solve/{shot}.json"))
a = cb.SHOTS[shot][0]
tiles = []
for i, c in enumerate(S["cams"]):
    f = c["frame"]
    im = cv2.imread(f"ref/frames24/{f:03d}.jpg")
    pos, (yaw, pitch, roll) = c["pose"][:3], c["pose"][3:]
    pj = lambda P: cm.project(np.atleast_2d(np.asarray(P, float)), pos, yaw, pitch, roll, S["hfov"])
    def seg(A, B, col, n=40):
        P = np.linspace(A, B, n)
        q = pj(P)
        for p0, p1 in zip(q, q[1:]):
            if not (np.isnan(p0).any() or np.isnan(p1).any()) and np.abs(np.r_[p0, p1]).max() < 5000:
                cv2.line(im, tuple(int(v) for v in p0), tuple(int(v) for v in p1), col, 1, cv2.LINE_AA)
    seg((0, -cb.TRUSS_Y, 0), (0, -cb.TRUSS_Y, 12), (255, 255, 255))
    seg((pos[0] - 400, -cb.RAIL_GAUGE / 2, 0.16), (pos[0] + 400, -cb.RAIL_GAUGE / 2, 0.16), (200, 200, 200), 200)
    if S["c0"] is not None:
        xj = S["c0"] + V * (f - a) / cb.FPS
        seg((xj - 300, -cb.CAR_W / 2, cb.CAR_H), (xj + 30, -cb.CAR_W / 2, cb.CAR_H), (255, 200, 120), 200)
        for k in range(6):
            x = xj - k * PITCH
            seg((x, -cb.CAR_W / 2, JOINT_Z), (x, -cb.CAR_W / 2, cb.CAR_H), (255, 160, 80), 4)
    if S["cv"]:
        x, y, yw = S["cv"][i]["xyyaw"]
        ca, sa = math.cos(math.radians(yw)), math.sin(math.radians(yw))
        P = [(x + lx * ca - ly * sa, y + lx * sa + ly * ca, lz) for lx in (-cb.CV_LEN / 2, cb.CV_LEN / 2) for ly in (-cb.CV_W / 2, cb.CV_W / 2) for lz in (0, 1.2)]
        for j in range(8):
            for k in range(j + 1, 8):
                if bin(j ^ k).count("1") == 1:
                    seg(P[j], P[k], (0, 255, 255), 2)
    for rw in S["rows"]:
        if rw["frame"] != f:
            continue
        u, v = rw["uv"]
        cv2.circle(im, (int(u), int(v)), 5, (0, 255, 0), 2)
        if rw["pred"]:
            pu, pv = rw["pred"]
            cv2.drawMarker(im, (int(pu), int(pv)), (0, 0, 255), cv2.MARKER_CROSS, 12, 2)
        cv2.putText(im, rw["name"], (int(u) + 6, int(v) - 4), 0, 0.4, (0, 255, 0), 1)
    cv2.putText(im, f"{shot} f{f}", (8, 24), 0, 0.8, (0, 255, 255), 2)
    tiles.append(cv2.resize(im, (640, 272)))
while len(tiles) % 2:
    tiles.append(np.zeros_like(tiles[0]))
rows = [np.hstack(tiles[i:i + 2]) for i in range(0, len(tiles), 2)]
cv2.imwrite(f"out/peek/ovs_{shot}.jpg", np.vstack(rows))
print(f"out/peek/ovs_{shot}.jpg")
