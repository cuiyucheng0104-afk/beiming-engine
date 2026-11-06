#!/bin/sh
# 地球的一秒 — 一条命令重建：sh build.sh
set -e
LIB=@@LEMO_ROOT@@
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
cd "$LIB"
node "$HERE/tools/export_timeline.mjs"                                 # timeline.js → timeline.json（唯一时间源）
node core/render/events.mjs "$HERE"                                     # window.EV → events.json
"$LIB/.venv/bin/python" "$HERE/mix.py"                                  # 配乐 + 拟音 + 环境 → out/mix.wav, out/cues.json
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py" > "$HERE/out/cuecheck.txt" && tail -1 "$HERE/out/cuecheck.txt"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/23-dataviz.mp4" 24 0
ffmpeg -v error -y -ss 19.4 -i "$HERE/23-dataviz.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
