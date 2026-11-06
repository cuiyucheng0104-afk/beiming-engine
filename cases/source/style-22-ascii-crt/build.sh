#!/bin/sh
# whale.exe 一键重建：时间轴 → 事件 → 配乐 → 混音 → 逐帧渲染 → 混流/响度 → 海报 → 拍点核对
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
mkdir -p "$HERE/out/stems"
node "$HERE/tools/export_timeline.mjs"
cd "$LIB"
node core/render/events.mjs "$HERE"
"$PY" "$HERE/score.py"
"$PY" "$HERE/mix.py"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/22-ascii-crt.mp4" 24 0
node core/render/still.mjs "$HERE" 15.3 --out "$HERE/out" --prefix poster_
cp "$HERE/out/poster_15.3.jpg" "$HERE/poster.jpg"
"$PY" "$HERE/tools/cuecheck.py" "$HERE/22-ascii-crt.mp4"
