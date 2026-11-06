#!/bin/sh
# 《按一下》一条命令重建：时间轴 → 事件 → 画面 → 配乐/拟音/混音 → 拍点核对 → 母带 → 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
[ -f "$HERE/fonts/NotoSansSC-sub.woff2" ] || sh "$HERE/tools/fetch_fonts.sh"
node "$HERE/tools/export.mjs"
cd "$LIB"
node core/render/events.mjs "$HERE"
node core/render/readcheck.mjs "$HERE"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/mix.py"
node "$HERE/tools/cuecheck.mjs"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/60-teardown.mp4" 24 1
node core/render/still.mjs "$HERE" 12.25 --prefix poster_ --out "$HERE/out"
cp "$HERE/out/poster_12.25.jpg" "$HERE/poster.jpg"
echo "done → $HERE/60-teardown.mp4"
