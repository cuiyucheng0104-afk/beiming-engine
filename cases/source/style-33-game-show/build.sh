#!/bin/sh
# 一条命令重建《节奏猜动物》：sh build.sh
set -e
LIB=@@LEMO_ROOT@@
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
node "$HERE/tools/export.mjs"                                                   # timeline.mjs → timeline.json
node core/render/events.mjs "$HERE"                                            # 页面 EV → events.json
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/mix.py"                                         # 配乐 + 拟音 + 玩具嗓 → out/mix.wav
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/33-game-show.mp4" 24 0
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py" "$HERE/33-game-show.mp4"    # 拍点核对
ffmpeg -v error -y -ss 14.4 -i "$HERE/33-game-show.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
