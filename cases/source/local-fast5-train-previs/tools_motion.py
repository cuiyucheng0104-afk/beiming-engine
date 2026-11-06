"""粗看每个镜头的相机运动：相邻帧 ORB 特征 + RANSAC 仿射，报告平均平移/旋转/缩放（整幅画面，含运动物体，仅作分类）。"""
import json
import cv2
import numpy as np

shots = json.load(open("data/shots.json"))
orb = cv2.ORB_create(1500)
bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
for k, (a, b) in shots.items():
    tx, ty, rot, sc, n = [], [], [], [], 0
    prev = None
    for f in range(a, b + 1):
        g = cv2.imread(f"ref/frames24/{f:03d}.jpg", 0)
        kp, des = orb.detectAndCompute(g, None)
        if prev is not None and des is not None and prev[1] is not None:
            m = bf.match(prev[1], des)
            if len(m) > 30:
                p0 = np.float32([prev[0][x.queryIdx].pt for x in m]); p1 = np.float32([kp[x.trainIdx].pt for x in m])
                A, inl = cv2.estimateAffinePartial2D(p0, p1, ransacReprojThreshold=2.0)
                if A is not None:
                    s = np.hypot(A[0, 0], A[1, 0]); r = np.degrees(np.arctan2(A[1, 0], A[0, 0]))
                    tx.append(A[0, 2] + (s - 1) * 640); ty.append(A[1, 2] + (s - 1) * 272); rot.append(r); sc.append(s); n += inl.sum() / len(m)
        prev = (kp, des)
    if tx:
        print(f"{k} {a:3d}-{b:3d}  dx/帧 {np.median(tx):6.1f}  dy/帧 {np.median(ty):6.1f}  滚转 {np.median(rot):5.2f}°  缩放 {np.median(sc):.4f}  内点率 {n / len(tx):.2f}")
