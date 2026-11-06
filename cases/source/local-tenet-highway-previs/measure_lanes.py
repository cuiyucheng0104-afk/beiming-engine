"""在 S2（43-206）逐帧检测车道线，求消失点。输出 out/vp.csv: frame,vp_x,vp_y,n_lines"""
import cv2, numpy as np, csv, sys
W, H = 960, 448
rows = []
for f in range(43, 207):
    img = cv2.imread(f"ref/frames/{f:03d}.png")
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # 路面区域：画面下半部，避开仪表台（最下 ~18%）
    mask = np.zeros_like(g); mask[int(H*0.42):int(H*0.80), :] = 255
    e = cv2.Canny(cv2.GaussianBlur(g, (5, 5), 0), 60, 160) & mask
    lines = cv2.HoughLinesP(e, 1, np.pi/360, 40, minLineLength=35, maxLineGap=12)
    segs = []
    if lines is not None:
        for x1, y1, x2, y2 in lines.reshape(-1, 4).astype(float):
            if x2 == x1: continue
            k = (y2 - y1) / (x2 - x1)
            if 0.12 < abs(k) < 3:          # 车道线是斜线，排除水平的天桥/墙边
                segs.append((x1, y1, x2, y2))
    # 最小二乘求所有线的公共交点
    A, b = [], []
    for x1, y1, x2, y2 in segs:
        n = np.array([y2 - y1, x1 - x2], float); n /= np.linalg.norm(n)
        A.append(n); b.append(n @ np.array([x1, y1], float))
    if len(A) >= 3:
        A, b = np.array(A), np.array(b)
        vp, *_ = np.linalg.lstsq(A, b, rcond=None)
        res = np.abs(A @ vp - b)
        keep = res < np.percentile(res, 60) + 3          # 去离群，再算一次
        vp, *_ = np.linalg.lstsq(A[keep], b[keep], rcond=None)
        rows.append((f, round(vp[0], 1), round(vp[1], 1), int(keep.sum())))
    else:
        rows.append((f, "", "", len(A)))
with open("out/vp.csv", "w") as fh:
    w = csv.writer(fh); w.writerow(["frame", "vp_x", "vp_y", "n"]); w.writerows(rows)
for r in rows[::8]: print(r)
