import cv2, sys, numpy as np
fs, out = [int(a) for a in sys.argv[1:5]], sys.argv[5]
tiles = []
for f in fs:
    img = cv2.imread(f"ref/frames/{f:03d}.png")
    for x in range(0, 960, 20):
        c = (0, 255, 255) if x % 100 == 0 else (0, 120, 220)
        cv2.line(img, (x, 0), (x, 448), c, 1 if x % 100 else 1)
        if x % 100 == 0: cv2.putText(img, str(x), (x + 2, 12), 0, 0.4, (0, 255, 255), 1)
    for y in range(0, 448, 20):
        c = (0, 255, 255) if y % 100 == 0 else (0, 120, 220)
        cv2.line(img, (0, y), (960, y), c, 1)
        if y % 100 == 0: cv2.putText(img, str(y), (2, y - 2), 0, 0.4, (0, 255, 255), 1)
    cv2.putText(img, f"F{f}", (880, 440), 0, 0.8, (255, 255, 255), 2)
    tiles.append(img)
cv2.imwrite(out, np.vstack([np.hstack(tiles[:2]), np.hstack(tiles[2:])]))
