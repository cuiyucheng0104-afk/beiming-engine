#!/bin/sh
# 一滴池塘水 · one command rebuilds the film from source.
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
[ -f "$HERE/plates/A.jpg" ] || "$PY" -I "$HERE/tools/plates.py"            # graded plates from material/
"$PY" -I "$HERE/tools/striae.py" '[700,1680]' '[2000,1778]' "$HERE/out/striae_check.jpg"
"$PY" -I "$HERE/tools/marks_A.py" "$HERE/out/marks_check.jpg"
[ -f "$HERE/fonts/NotoSansSC-400.woff2" ] || "$PY" -I "$HERE/tools/fonts.py" "$HERE"
cd "$LIB"
node "$HERE/tools/tl.mjs" "$HERE"
node core/render/events.mjs "$HERE"
"$PY" "$HERE/tools/cuecheck.py" "$HERE"
node core/render/readcheck.mjs "$HERE"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$PY" "$HERE/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/61-microscope.mp4" 24 1
ffmpeg -loglevel error -y -ss 11.6 -i "$HERE/61-microscope.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/61-microscope.mp4"
