#!/bin/sh
# 一条命令重建《宝箱怪》：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
node "$HERE/tools/dump_tl.mjs"                                   # timeline.js → timeline.json
node core/render/events.mjs "$HERE"                              # window.EV → events.json
"$LIB/.venv/bin/python" "$HERE/mix.py"                           # 配乐 + 拟音 → out/mix.wav
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/29-pixel-rpg.mp4" 24 0
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py"                # 拍点 / 静默 / 画面突变核对
ffmpeg -v error -y -ss 16.0 -i "$HERE/29-pixel-rpg.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/29-pixel-rpg.mp4"
