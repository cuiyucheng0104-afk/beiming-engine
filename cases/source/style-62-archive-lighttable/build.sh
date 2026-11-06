#!/bin/sh
# 《十二秒》 one-command rebuild: textures -> timeline -> events -> score/foley/mix -> picture -> master -> checks
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
"$PY" -I "$HERE/tools/prep.py" "$HERE"                       # textures from material/ (public-domain scans)
node "$HERE/tools/export.mjs"                                # timeline.js -> out/timeline.json
cd "$LIB"
node core/render/events.mjs "$HERE"                          # window.EV -> events.json
"$PY" "$HERE/mix.py"                                         # score + foley + beds -> out/mix.wav
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/62-archive-lighttable.mp4" 24 1
node core/render/still.mjs "$HERE" 18.9 --prefix poster_ --out "$HERE/out"
cp "$HERE/out/poster_18.9.jpg" "$HERE/poster.jpg"
"$PY" -I "$HERE/tools/cuecheck.py" "$HERE"
node core/render/readcheck.mjs "$HERE"
