#!/bin/sh
# One command rebuild: timeline → events → picture → score/foley/mix → master (−14 LUFS) → poster → cue check
set -e
LIB=@@LEMO_ROOT@@
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node "$HERE/tools/export_timeline.mjs"
cd "$LIB"
node core/render/events.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/01-crayon-book.mp4" 24 0
ffmpeg -y -loglevel error -ss 15.2 -i "$HERE/01-crayon-book.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py" "$HERE"
