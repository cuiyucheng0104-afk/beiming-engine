#!/bin/sh
# 一条命令重建《擒纵机构》：事件 → 配乐与拟音 → 拍点核对 → 画面 → 母带（−14 LUFS）→ 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
[ -f "$HERE/fonts/fonts.css" ] || python3 "$HERE/tools/fonts.py"
cd "$LIB"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
"$LIB/.venv/bin/python" "$HERE/cuecheck.py"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/19-blueprint.mp4" 24 1
ffmpeg -v error -y -ss 18.9 -i "$HERE/19-blueprint.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/19-blueprint.mp4"
