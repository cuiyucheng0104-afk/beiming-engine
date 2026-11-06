#!/bin/sh
# 《鹤出留白》一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
echo "1/7 时间轴 → timeline.json";      node "$HERE/tools/tl.mjs" > "$HERE/timeline.json"
echo "2/7 画面事件 → events.json";      node core/render/events.mjs "$HERE"
echo "3/7 配乐（古琴/箫/木鱼/鼓/锣）";  "$PY" "$HERE/music/score.py" "$HERE"
echo "4/7 拟音 + 混音 → out/mix.wav";   "$PY" "$HERE/mix.py" "$HERE"
echo "5/7 渲染 456 帧";                 node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
echo "6/7 合成（−14 LUFS，无颗粒：宣纸纹理在着色器里）"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/03-ink-wash.mp4" 24 0
echo "7/7 海报 + 自检"
node core/render/still.mjs "$HERE" 18.0 --out "$HERE/out" --prefix poster_ && cp "$HERE/out/poster_18.0.jpg" "$HERE/poster.jpg"
node core/render/readcheck.mjs "$HERE"
"$PY" "$HERE/tools/cuecheck.py" "$HERE" "$HERE/03-ink-wash.mp4"
echo done
