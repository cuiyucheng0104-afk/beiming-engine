#!/bin/sh
# 追电车的夏天 —— 一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
PY="$LIB/.venv/bin/python"
mkdir -p "$HERE/out"
cd "$LIB"
node "$HERE/tools/tl.mjs"                                    # timeline.js → timeline.json（唯一时间源）
node core/render/events.mjs "$HERE"                          # window.EV → events.json
"$PY" "$HERE/music/score.py"                                 # 原创配乐 → out/music.wav + stems + music_cues.json
"$PY" "$HERE/mix.py"                                         # 拟音 + 环境床 + 配乐 → out/mix.wav
"$PY" "$HERE/tools/cuecheck.py" "$HERE"                      # 拍点核对（目标 0 ms）
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/27-cel-anime-80s.mp4" 24 2
node core/render/still.mjs "$HERE" 16.6 --prefix poster_ --out "$HERE/out"
ffmpeg -y -loglevel error -i "$HERE/out/poster_16.6.jpg" -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/27-cel-anime-80s.mp4"
