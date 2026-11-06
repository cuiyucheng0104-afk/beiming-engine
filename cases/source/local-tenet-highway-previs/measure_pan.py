"""S2 逐帧摇镜：远景 ORB 特征匹配 → 帧间旋转（像素位移 / f）。输出 out/pan.csv: frame,yaw_deg,pitch_deg"""
import cv2, numpy as np, csv, math
F = 1290.0
orb = cv2.ORB_create(1500)
def feats(f):
    g = cv2.cvtColor(cv2.imread(f"ref/frames/{f:03d}.png"), cv2.COLOR_BGR2GRAY)
    m = np.zeros_like(g); m[10:185, 92:868] = 255          # 远景：天空/楼/天桥（地平线以上）
    return orb.detectAndCompute(g, m)
bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
yaw, pitch, rows = 0.0, 0.0, [(43, 0.0, 0.0, 0)]
k0, d0 = feats(43)
for f in range(44, 207):
    k1, d1 = feats(f)
    n = 0; dx = dy = 0.0
    if d0 is not None and d1 is not None:
        ms = bf.match(d0, d1)
        if len(ms) >= 8:
            a = np.float32([k0[m.queryIdx].pt for m in ms]); b = np.float32([k1[m.trainIdx].pt for m in ms])
            M, inl = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC, ransacReprojThreshold=2.0)
            if M is not None and inl.sum() >= 8:
                c = np.array([480.0, 224.0, 1.0])            # 取画面中心的位移，去掉前进造成的放大分量
                dx, dy = (M @ c) - c[:2]; n = int(inl.sum())
    # 远景向左移 = 相机向右摇（yaw 记为向右为正）
    yaw += math.degrees(math.atan(-dx / F)); pitch += math.degrees(math.atan(dy / F))
    rows.append((f, round(yaw, 2), round(pitch, 2), n))
    k0, d0 = k1, d1
with open("out/pan.csv", "w") as fh:
    w = csv.writer(fh); w.writerow(["frame", "yaw_right_deg", "pitch_down_deg", "inliers"]); w.writerows(rows)
for r in rows[::10]: print(r)
print(rows[-1])
