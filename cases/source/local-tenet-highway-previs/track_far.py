"""跟踪远处橙色高楼（模板匹配，逐帧更新），换算 S2 的偏航/俯仰。输出 out/cam_s2.csv

历史工具：在 30fps 原片（ref/frames）上测的；结果已换算成 24fps 帧号并入 data/cam_track.csv，
预演只读后者。重跑它不会影响 build.py。
"""
import cv2, numpy as np, csv, math
F = 1290.0
g = lambda f: cv2.cvtColor(cv2.imread(f"ref/frames/{f:03d}.png"), cv2.COLOR_BGR2GRAY)
x, y, w, h = 560, 30, 90, 70                      # 第 43 帧的橙楼区域
tpl = g(43)[y:y + h, x:x + w]
pos = {43: (x + w / 2, y + h / 2)}
for f in range(44, 207):
    img = g(f)
    cx, cy = pos[f - 1]
    x0, y0 = int(max(cx - w / 2 - 50, 0)), int(max(cy - h / 2 - 30, 0))
    x1, y1 = int(min(cx + w / 2 + 50, 960)), int(min(cy + h / 2 + 30, 448))
    r = cv2.matchTemplate(img[y0:y1, x0:x1], tpl, cv2.TM_CCOEFF_NORMED)
    _, score, _, (mx, my) = cv2.minMaxLoc(r)
    nx, ny = x0 + mx + w / 2, y0 + my + h / 2
    if score < 0.8:                                   # 被遮挡：用最后的好模板在整条顶部重新找
        band = img[0:160, 88:872]
        r2 = cv2.matchTemplate(band, tpl, cv2.TM_CCOEFF_NORMED)
        _, s2, _, (mx2, my2) = cv2.minMaxLoc(r2)
        if s2 > score:
            score, nx, ny = s2, 88 + mx2 + w / 2, my2 + h / 2
    pos[f] = (nx, ny)
    tx, ty = int(nx - w / 2), int(ny - h / 2)
    if score > 0.85 and 0 <= ty and ty + h <= 448 and 88 <= tx and tx + w <= 872:
        tpl = img[ty:ty + h, tx:tx + w]
    if f % 12 == 0: print(f, round(nx), round(ny), round(score, 2))
x43, y43 = pos[43]
YAW0, PITCH0 = 2.3, 1.6                            # 第 52 帧用消失点算出的初始偏航（向右）与俯仰（向下）
with open("out/cam_s2.csv", "w") as fh:
    wr = csv.writer(fh); wr.writerow(["frame", "yaw_right_deg", "pitch_down_deg"])
    for f in range(43, 207):
        px, py = pos[f]
        wr.writerow([f, round(YAW0 + math.degrees(math.atan((x43 - px) / F)), 2),
                     round(PITCH0 + math.degrees(math.atan((y43 - py) / F)), 2)])
# 抽查：把跟踪框画回去
tiles = []
for f in (150, 170, 185, 206):
    im = cv2.imread(f"ref/frames/{f:03d}.png"); px, py = pos[f]
    cv2.rectangle(im, (int(px - w / 2), int(py - h / 2)), (int(px + w / 2), int(py + h / 2)), (0, 0, 255), 2)
    cv2.putText(im, str(f), (800, 430), 0, 0.8, (255, 255, 255), 2); tiles.append(im)
cv2.imwrite("out/track_check.png", np.vstack([np.hstack(tiles[:2]), np.hstack(tiles[2:])]))
