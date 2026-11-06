#!/bin/sh
# 《一年的雨》一条命令重建：字体（缺时）→ 时间表 → 事件 → 配乐与拟音 → 拍点核对 → 画面 → 母带 → 自检 → 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
NAME=59-data-physical
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
[ -f core/assets/polyhaven/photo_studio_loft_hall_2k.hdr ] || sh tools/fetch.sh hdri
for l in vsco2ce vcsl freepats; do [ -d "core/audio/instruments/$l" ] || sh tools/fetch.sh instruments $l; done
NEED_FONTS=0; [ -f "$HERE/fonts.css" ] || NEED_FONTS=1
for f in $(grep -o 'fonts/[^)]*\.woff2' "$HERE/fonts.css" 2>/dev/null); do [ -f "$HERE/$f" ] || NEED_FONTS=1; done
[ "$NEED_FONTS" = 1 ] && node "$HERE/tools/fonts.mjs" "$HERE"

node "$HERE/tools/export.mjs" "$HERE"                       # timeline.js → out/timeline.json
node core/render/events.mjs "$HERE"                          # window.EV → events.json
"$PY" "$HERE/mix.py"                                         # 配乐 + 拟音 → out/mix.wav
"$PY" -I "$HERE/tools/cuecheck.py" "$HERE"                   # 画面事件 ↔ 节拍网格 ↔ 配乐：0 ms
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" 24 1

node core/render/readcheck.mjs "$HERE" > "$HERE/out/readcheck.txt" && echo "readcheck ok" || { grep -v "^OK" "$HERE/out/readcheck.txt"; exit 1; }
ffmpeg -hide_banner -nostats -i "$HERE/$NAME.mp4" -vf blackdetect=d=0.04:pix_th=0.08 -an -f null - 2>&1 | grep black_start && { echo "black frames"; exit 1; } || echo "no black frames"
ffmpeg -v error -y -ss 18.9 -i "$HERE/$NAME.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/$NAME.mp4"
