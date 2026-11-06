import cv2, sys
f, out = int(sys.argv[1]), sys.argv[2]
img = cv2.imread(f"ref/frames/{f:03d}.png")
img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
H, W = img.shape[:2]
for x in range(0, W, 40):
    c = (0, 255, 255) if x % 200 == 0 else (0, 140, 255)
    cv2.line(img, (x, 0), (x, H), c, 1)
    if x % 200 == 0: cv2.putText(img, str(x // 2), (x + 2, 14), 0, 0.45, (0, 255, 255), 1)
for y in range(0, H, 40):
    c = (0, 255, 255) if y % 200 == 0 else (0, 140, 255)
    cv2.line(img, (0, y), (W, y), c, 1)
    cv2.putText(img, str(y // 2), (2, y - 2), 0, 0.45, (0, 255, 255), 1)
cv2.imwrite(out, img)
