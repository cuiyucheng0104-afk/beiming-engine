#!/bin/sh
# 港口一日 · 一条命令重建：事件 → 配乐与拟音 → 逐帧渲染 → 混音封装（−14 LUFS）→ 拍点核对 → 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/42-tilt-shift.mp4" 24 1
"$LIB/.venv/bin/python" -I "$HERE/tools/cuecheck.py" "$HERE/42-tilt-shift.mp4"
ffmpeg -v error -y -ss 18.9 -i "$HERE/42-tilt-shift.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/42-tilt-shift.mp4"
