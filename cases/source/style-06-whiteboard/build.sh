#!/bin/sh
# 一条命令重建《天为什么是蓝的》：字形骨架 → 事件 → 配乐与拟音 → 卡点核对 → 逐帧渲染 → 混流 → 海报
set -e
LIB=@@LEMO_ROOT@@
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
"$PY" -I "$HERE/tools/glyphs.py" "$HERE/fonts/NotoSansSC-w100-subset.ttf" '天为什么是蓝的？光波长短，最容易被散射白空气分子' "$HERE/fonts/glyphs.json"
cd "$LIB"
node core/render/events.mjs "$HERE"
"$PY" "$HERE/mix.py"
"$PY" "$HERE/tools/cuecheck.py"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/06-whiteboard.mp4" 24 1
node core/render/still.mjs "$HERE" 19.45 --out "$HERE/out/poster"
ffmpeg -y -loglevel error -i "$HERE/out/poster/t_19.45.jpg" -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/06-whiteboard.mp4"
