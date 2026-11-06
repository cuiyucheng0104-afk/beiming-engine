#!/bin/sh
# 一条命令重建《种子扫描》：时间线 → 事件 → 配乐与拟音 → 拍点核对 → 渲染 → 混流（−14 LUFS）
set -e
LIB=@@LEMO_ROOT@@
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node "$HERE/tools/export_tl.mjs"
cd "$LIB"
node core/render/events.mjs "$HERE"
"$PY" "$HERE/mix.py"
"$PY" "$HERE/tools/cuecheck.py" "$HERE"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/52-hologram-hud.mp4" 24 0
ffmpeg -v error -y -ss 18.0 -i "$HERE/52-hologram-hud.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/52-hologram-hud.mp4"
