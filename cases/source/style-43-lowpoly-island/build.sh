#!/bin/sh
# 风车的一天 — 一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
mkdir -p "$HERE/out"
node core/render/events.mjs "$HERE"                                   # timeline.js → window.EV → events.json
node "$HERE/probe.mjs" "$HERE"                                        # 逐帧画面状态 → out/probe.json
"$LIB/.venv/bin/python" "$HERE/mix.py"                                # 配乐 + 拟音 + 环境 → out/mix.wav
"$LIB/.venv/bin/python" "$HERE/cuecheck.py"                           # 拍点核对（目标 0 ms）
node core/render/readcheck.mjs "$HERE"                                # 画面文字停留时长
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/43-lowpoly-island.mp4" 24 0
node core/render/still.mjs "$HERE" 19.2 --out "$HERE/out" --prefix poster_ >/dev/null && cp "$HERE/out/poster_19.2.jpg" "$HERE/poster.jpg"
