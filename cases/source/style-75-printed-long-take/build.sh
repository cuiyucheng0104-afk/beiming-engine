#!/bin/sh
# 雪夜小站 — Printed Long Take. One command rebuilds the film from source:
#   events → score + foley + mix → picture (30 fps) → master (−14 LUFS) → checks (reading time, cues) → poster
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
NAME=75-printed-long-take
FPS=30                                   # STYLE.md §5: printed-long-take outputs 30 fps
POSTER=18.6                              # 归 cut into the sky, the red below
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
# the font: Noto Serif SC 700 subset to the one character the film prints (Google Fonts css2 &text=归, OFL)
[ -f "$HERE/fonts/NotoSerifSC-700-gui.woff2" ] || {
  URL=$(curl -s -A "Mozilla/5.0 (Macintosh) Chrome/120" "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@700&text=%E5%BD%92" | sed -n 's/.*url(\([^)]*\)).*/\1/p')
  curl -s -o "$HERE/fonts/NotoSerifSC-700-gui.woff2" "$URL"; }
for l in vcsl vsco2ce; do [ -d "core/audio/instruments/$l" ] || sh tools/fetch.sh instruments $l; done

node core/render/events.mjs "$HERE"
node "$HERE/tools/probe.mjs" "$HERE"
"$PY" "$HERE/mix.py"
node core/render/video.mjs "$HERE" --fps $FPS --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" $FPS 0
node core/render/readcheck.mjs "$HERE" > "$HERE/out/readcheck.txt" && echo "readcheck ok" || { tail -5 "$HERE/out/readcheck.txt"; exit 1; }
"$PY" "$HERE/tools/cuecheck.py" > "$HERE/out/cuecheck.txt" && tail -1 "$HERE/out/cuecheck.txt" || { grep BAD "$HERE/out/cuecheck.txt"; exit 1; }
ffmpeg -v error -y -ss $POSTER -i "$HERE/$NAME.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/$NAME.mp4"
