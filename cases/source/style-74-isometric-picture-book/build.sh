#!/bin/sh
# 面包店的早晨 — one command rebuilds the film: sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB RENDER_SLOTS=${RENDER_SLOTS:-4}
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
NAME=74-isometric-picture-book
FPS=30
cd "$LIB"
for l in vsco2ce vcsl freepats; do [ -d "core/audio/instruments/$l" ] || sh tools/fetch.sh instruments $l; done
node core/render/events.mjs "$HERE"                                   # timeline.js → events.json
"$PY" "$HERE/mix.py" "$HERE"                                          # score + foley + beds → out/mix.wav, out/cues.json
node "$HERE/tools/cuecheck.mjs" "$HERE" > "$HERE/out/cuecheck.txt" || { tail -20 "$HERE/out/cuecheck.txt"; exit 1; }
tail -1 "$HERE/out/cuecheck.txt"
node core/render/readcheck.mjs "$HERE" > "$HERE/out/readcheck.txt" || { cat "$HERE/out/readcheck.txt"; exit 1; }
node "$HERE/tools/motion_check.mjs" "$HERE" --fps $FPS
node core/render/video.mjs "$HERE" --fps $FPS --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" $FPS 0
node core/render/still.mjs "$HERE" 15.8 --out "$HERE/out" --prefix poster_ >/dev/null
cp "$HERE/out/poster_15.8.jpg" "$HERE/poster.jpg"
echo "done: $HERE/$NAME.mp4"
