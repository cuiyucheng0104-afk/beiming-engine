#!/bin/sh
# 一条命令重建《零点密码》：事件 → 配乐与拟音 → 逐帧渲染 → 母带混流（−14 LUFS）→ 海报 → 自检
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/17-spy-titles.mp4" 24 4
# 颗粒噪声让 crf 19 的成片偏大：只重压视频（crf 23），音轨原样拷贝，响度不变
ffmpeg -v error -y -i "$HERE/17-spy-titles.mp4" -map 0 -c:v libx264 -preset slow -crf 23 -c:a copy -movflags +faststart "$HERE/out/_film.mp4" && mv "$HERE/out/_film.mp4" "$HERE/17-spy-titles.mp4"
ffmpeg -v error -y -ss 19.4 -i "$HERE/17-spy-titles.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
node core/render/readcheck.mjs "$HERE"
"$LIB/.venv/bin/python" -I "$HERE/tools/cuecheck.py"
