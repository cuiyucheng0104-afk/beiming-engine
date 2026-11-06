#!/bin/sh
# 棱光 PRISM · 一条命令重建：timeline → 配乐 → 事件 → 拟音混音 → 逐帧渲染 → 母带（−14 LUFS）→ 拍点核对 → 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
cd "$LIB"
PY="$LIB/.venv/bin/python"
node "$HERE/tools/dump_timeline.mjs"                    # timeline.js → timeline.json（配乐/混音读同一份数字）
"$PY" "$HERE/music/score.py"                            # → music/score.wav + stems + score.json
node core/render/events.mjs "$HERE"                     # window.EV → events.json
"$PY" "$HERE/mix.py"                                    # 配乐 + 拟音 + 空气底 → out/mix.wav
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/44-glass-product.mp4" 24 0
"$PY" "$HERE/tools/cuecheck.py"                         # 画面事件 ↔ 拍点 ↔ 实测起音
node core/render/readcheck.mjs "$HERE"
ffmpeg -y -v error -ss 17.0 -i "$HERE/44-glass-product.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/44-glass-product.mp4"
