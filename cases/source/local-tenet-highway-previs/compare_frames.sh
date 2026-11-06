#!/bin/zsh
# 渲染指定帧并与原片同区域裁剪成左右对比拼图：compare_frames.sh start end step out.png（24fps 帧号）
cd ${0:A:h}
B=/Applications/Blender.app/Contents/MacOS/Blender
FR=$(python3.14 -c "print(','.join(str(f) for f in range($1,$2+1,$3)))")
$B -b out/previs.blend -o //cmp/f_#### -F PNG -f $FR >/dev/null 2>&1
python3.14 - "$1" "$2" "$3" "$4" <<'PY'
import sys, subprocess, cv2, numpy as np
a, b, st, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
subprocess.run(["python3.14", "crops.py", "ref", str(a), str(b), str(st), "out/_r.png", "1"], check=True)
subprocess.run(["python3.14", "crops.py", "out/cmp", str(a), str(b), str(st), "out/_m.png", "1"], check=True)
r, m = cv2.imread("out/_r.png"), cv2.imread("out/_m.png")
pairs = np.hstack([r, m]); H = 182; n = pairs.shape[0] // H
tiles = [pairs[i * H:(i + 1) * H] for i in range(n)]
cols = 3
while len(tiles) % cols: tiles.append(np.zeros_like(tiles[0]))
cv2.imwrite(out, np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]))
PY
