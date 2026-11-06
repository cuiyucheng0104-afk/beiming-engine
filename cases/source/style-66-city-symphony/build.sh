#!/bin/sh
# 城市的一天 —— 一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
cd "$HERE"
[ -d material/raw ] || { echo "material/raw 缺素材：按 material/urls.txt 下载（CC0/PD，见 CREDITS）"; exit 1; }
node tools/export_timeline.mjs                      # timeline.js → timeline.json
"$PY" tools/prep.py -j 3                            # 素材 → 底片（变速、帧融合、调色、熄灯）
"$PY" tools/music.py                                # 配乐 → out/music.wav + out/score.json
cd "$LIB"
node core/render/events.mjs "$HERE"                 # window.EV → events.json
"$PY" "$HERE/mix.py"                                # 配乐 + 环境 + 拟音 → out/mix.wav
"$PY" "$HERE/tools/cuecheck.py"                     # 拍点核对
node core/render/readcheck.mjs "$HERE"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/66-city-symphony.mp4" 24 0
ffmpeg -v error -y -ss 12.8 -i "$HERE/66-city-symphony.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/66-city-symphony.mp4"
