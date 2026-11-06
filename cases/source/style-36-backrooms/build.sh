#!/bin/sh
# 一条命令重建《交接录像》：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
cd "$LIB"
node core/render/events.mjs "$HERE"                                   # 1. 页面时间线 → events.json（画面与声音同源）
"$LIB/.venv/bin/python" "$HERE/mix.py"                                # 2. 嗡鸣 / 提示音 / 镇流器 / drone / 冲击 / 拟音 → out/mix.wav
node "$HERE/tools/cuecheck.mjs"                                       # 3. 拍点核对（画面实测 + 声音放置 + 混音实测，目标 0 ms）
node core/render/readcheck.mjs "$HERE"                                # 4. 画内文字停留时间
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"   # 5. 逐帧渲染（460 帧）
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/36-backrooms.mp4" 24 0   # 6. 合成，−14 LUFS；VHS 噪声已在画面里，不加颗粒
ffmpeg -y -loglevel error -ss 15.8 -i "$HERE/36-backrooms.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"   # 7. 海报
