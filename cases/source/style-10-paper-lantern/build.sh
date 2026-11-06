#!/bin/sh
# 一条命令重建《夜班火车回家》：事件 → 拍点核对 → 画面 → 配乐/拟音 → 母带 → 海报
set -e
LIB=@@LEMO_ROOT@@
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
cd "$LIB"
node core/render/events.mjs "$HERE"                                   # timeline.js → window.EV → events.json
"$PY" "$HERE/mix.py"                                                  # 配乐 + 拟音 + 环境 → out/mix.wav
node "$HERE/tools/probe.mjs" "$HERE"                                  # 视觉事件真实起点
"$PY" "$HERE/tools/cuecheck.py" "$HERE"                               # 画面/声音 vs 拍点（0 ms）
node core/render/readcheck.mjs "$HERE"                                # 画面内文字停留时长
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/10-paper-lantern.mp4" 30 1
ffmpeg -y -loglevel error -ss 17.75 -i "$HERE/10-paper-lantern.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done → $HERE/10-paper-lantern.mp4"
