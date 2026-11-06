#!/bin/sh
# 一条命令重建《积木小屋变船》：事件 → 画面 → 配乐与拟音 → 拍点核对 → 母带（−14 LUFS）→ 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
"$LIB/.venv/bin/python" "$HERE/cuecheck.py"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/37-brick-toy.mp4" 24 1
ffmpeg -v error -y -ss 14.4 -i "$HERE/37-brick-toy.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/37-brick-toy.mp4"
