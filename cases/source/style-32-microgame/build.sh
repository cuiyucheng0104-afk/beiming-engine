#!/bin/sh
# 一条命令重建《四连关》：时间线 → 事件 → 配乐与拟音 → 拍点核对 → 逐帧渲染 → 混音封装 → 海报
set -e
LIB=@@LEMO_ROOT@@
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
cd "$LIB"
node "$HERE/tools/dump_timeline.mjs"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/32-microgame.mp4" 24 0
ffmpeg -y -loglevel error -ss 16.70 -i "$HERE/32-microgame.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done → $HERE/32-microgame.mp4"
