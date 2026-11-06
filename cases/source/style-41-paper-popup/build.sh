#!/bin/sh
# 一条命令重建《纸龙》：事件 → 配乐与拟音 → 拍点核对 → 逐帧渲染 → 混流母带（−14 LUFS）→ 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
mkdir -p "$HERE/out"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
"$LIB/.venv/bin/python" "$HERE/cuecheck.py"
node core/render/video.mjs "$HERE" --fps 60 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/41-paper-popup.mp4" 60 1
ffmpeg -y -v error -ss 16.75 -i "$HERE/41-paper-popup.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/41-paper-popup.mp4"
