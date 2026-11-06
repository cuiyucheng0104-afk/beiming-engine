#!/bin/sh
# 灯塔守夜 · 一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
cd "$LIB"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node "$HERE/timeline.js"                                              # 唯一时间源 → timeline.json
node core/render/events.mjs "$HERE"                                   # window.EV → events.json
"$LIB/.venv/bin/python" "$HERE/mix.py"                                # 配乐 + 拟音 + 环境 → out/mix.wav
node core/render/readcheck.mjs "$HERE"                                # 题签阅读时长
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/15-woodcut.mp4" 24 3
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py" "$HERE/15-woodcut.mp4"   # 拍点核对（0 ms 目标）
ffmpeg -v error -y -ss 13.6 -i "$HERE/15-woodcut.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/15-woodcut.mp4"
