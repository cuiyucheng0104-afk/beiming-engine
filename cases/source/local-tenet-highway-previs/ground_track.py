"""把 flip_keys.PICKS（翻滚车车身中心正下方的路面读点）投影到路面，打印它相对本车相机的坐标。

    python3.14 ground_track.py      → 同时写 out/flip_track.csv：frame,t,X,Yrel,yaw,pitch（24fps 帧号）

标定和相机朝向都来自 calib.py（唯一来源）；投影公式是 calib.ground_point。
"""
import csv

import calib as cb
from flip_keys import PICKS

if __name__ == "__main__":
    rows = []
    for f, (u, v) in sorted(PICKS.items()):
        yaw, pitch = cb.cam_at(f)
        g = cb.ground_point(u, v, yaw, pitch)
        if g is None:
            continue
        rows.append((f, round(cb.t_of(f), 3), round(cb.CAM_X + g[0], 2), round(g[1], 2), round(yaw, 2), round(pitch, 2)))
    with open("out/flip_track.csv", "w") as fh:
        w = csv.writer(fh)
        w.writerow(["frame", "t", "X", "Yrel", "yaw", "pitch"])
        w.writerows(rows)
    print(" frame     t      X(m)   前方(m)   yaw  pitch")
    for r in rows:
        print(f" {r[0]:4d}  {r[1]:5.2f}  {r[2]:6.2f}  {r[3]:7.2f}  {r[4]:5.1f} {r[5]:4.1f}")
