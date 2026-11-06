"""读点用放大图：python3.14 zoom.py 帧号 x0 y0 x1 y1 [网格步长] → 打印输出路径 out/peek/z_帧号_x0_y0_x1_y1.jpg
坐标一律用 1280×544 参考坐标；底图取 2560 宽高清帧，放大后画网格并标注参考坐标。"""
import sys
import cv2

f, x0, y0, x1, y1 = (int(v) for v in sys.argv[1:6])
step = int(sys.argv[6]) if len(sys.argv) > 6 else 10
im = cv2.imread(f"ref/hi24/{f:03d}.jpg")
crop = im[y0 * 2:y1 * 2, x0 * 2:x1 * 2]
s = 1200 / crop.shape[1]
crop = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
k = s * 2                                   # 参考坐标 1px → 放大图像素
for x in range((x0 // step + 1) * step, x1, step):
    X = int((x - x0) * k); big = x % (step * 5) == 0
    cv2.line(crop, (X, 0), (X, crop.shape[0]), (0, 255, 255) if big else (0, 140, 140), 1)
    if big: cv2.putText(crop, str(x), (X + 2, 14), 0, 0.45, (0, 255, 255), 1)
for y in range((y0 // step + 1) * step, y1, step):
    Y = int((y - y0) * k); big = y % (step * 5) == 0
    cv2.line(crop, (0, Y), (crop.shape[1], Y), (0, 255, 255) if big else (0, 140, 140), 1)
    if big: cv2.putText(crop, str(y), (2, Y - 2), 0, 0.45, (0, 255, 255), 1)
out = f"out/peek/z_{f:03d}_{x0}_{y0}_{x1}_{y1}.jpg"
cv2.imwrite(out, crop)
print(out)
