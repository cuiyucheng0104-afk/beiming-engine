#!/bin/zsh
# 渲染指定帧，把渲染画面的边缘描成红线叠到原片上：overlay.sh start end step out.jpg [cols]（24fps 帧号）
cd ${0:A:h}
B=/Applications/Blender.app/Contents/MacOS/Blender
FR=$(python3.14 -c "print(','.join(str(f) for f in range($1,$2+1,$3)))")
$B -b out/previs.blend -o //ov/f_#### -F PNG -f $FR >/dev/null 2>&1
python3.14 - "$1" "$2" "$3" "$4" "${5:-3}" <<'PY'
import sys, cv2, numpy as np
a, b, st, out, cols = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], int(sys.argv[5])
tiles = []
for f in range(a, b + 1, st):
    r = cv2.imread(f"ref/frames24/{f:03d}.png")[:, 88:872]
    m = cv2.imread(f"out/ov/f_{f:04d}.png")
    e = cv2.dilate(cv2.Canny(cv2.cvtColor(m, cv2.COLOR_BGR2GRAY), 40, 120), np.ones((2, 2), np.uint8))
    o = r.copy(); o[e > 0] = (0, 0, 255)
    cv2.putText(o, str(f), (10, 34), 0, 1.1, (0, 255, 255), 2)
    tiles.append(cv2.resize(o, (392, 224)))
while len(tiles) % cols: tiles.append(np.zeros_like(tiles[0]))
cv2.imwrite(out, np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]))
PY
