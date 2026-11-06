#!/bin/sh
# 《本周天气》一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
"$PY" -I "$HERE/tools/prep.py" "$HERE"                       # 素材统一 duotone 调色 → assets/
[ -s "$HERE/fonts/sanssc900.woff2" ] || sh "$HERE/tools/fonts.sh"   # OFL 字体子集（需联网一次）
cd "$LIB"
node core/render/events.mjs "$HERE"                          # timeline.js → window.EV → events.json
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$PY" "$HERE/mix.py"                                        # 配乐 + 拟音 → out/mix.wav
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/70-news-package.mp4" 24 0
"$PY" "$HERE/tools/cuecheck.py" "$HERE" "$HERE/70-news-package.mp4"   # 卡点核对
ffmpeg -v error -y -ss 17.9 -i "$HERE/70-news-package.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
