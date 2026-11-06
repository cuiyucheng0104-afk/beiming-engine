#!/bin/sh
# 一根线的早晨 — 一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
node "$HERE/tools/dump.mjs"                                     # timeline.js → out/timeline.json
cd "$LIB"
node core/render/events.mjs "$HERE"                             # window.EV → events.json（笔速轨、拐角、画面事件实测时刻）
"$LIB/.venv/bin/python" "$HERE/music/score.py"                   # 竖琴独奏 + 拨弦低音提琴 → out/music.wav
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py"                # 画面事件 vs 音乐 vs 拍点，目标 0 ms
"$LIB/.venv/bin/python" "$HERE/mix.py"                           # 笔声 + 拟音 + 环境 + 音乐 → out/mix.wav
node core/render/readcheck.mjs "$HERE"                          # 落款停留时间够读
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/05-one-line.mp4" 24 0   # grain 0：纸纹已在渲染里
node core/render/still.mjs "$HERE" 19.2 --q 'nopen=1' --out "$HERE/out/poster" && cp "$HERE/out/poster/t_19.2.jpg" "$HERE/poster.jpg"
