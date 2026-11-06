#!/bin/sh
# 一条命令重建《TEMPO》：时间线 → 事件 → 配乐与拟音 → 拍点核对 → 逐帧渲染 → 混合与响度 → 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
[ -f "$HERE/fonts/archivo-800.woff2" ] || sh "$HERE/tools/fonts.sh"
node "$HERE/tools/export_timeline.mjs"
cd "$LIB"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/16-swiss-motion.mp4" 24 0
node core/render/still.mjs "$HERE" 19.5 --out "$HERE/out/poster"
cp "$HERE/out/poster/t_19.5.jpg" "$HERE/poster.jpg"
echo "done → $HERE/16-swiss-motion.mp4"
