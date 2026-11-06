#!/bin/sh
# 一条命令重建《港口集市》：时间轴 → 事件 → 配乐与拟音 → 逐帧渲染（60 fps）→ 混音封装（−14 LUFS）→ 拍点核对
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
node "$HERE/tools/export_timeline.mjs"
cd "$LIB"
node core/render/events.mjs "$HERE"
"$PY" "$HERE/mix.py"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 60 --workers ${WORKERS:-3} --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/31-hd-2d.mp4" 60 0
ffmpeg -v error -y -ss 16.9 -i "$HERE/31-hd-2d.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
"$PY" "$HERE/tools/cuecheck.py" "$HERE/31-hd-2d.mp4"
