#!/bin/sh
# 明日早晨 — one command rebuilds the film: timeline → events → score/foley mix → cue check → frames → master → poster
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
cd "$LIB"
node "$HERE/tools/tl.mjs"                                   # timeline.js → timeline.json (score, mix, checks read it)
node core/render/events.mjs "$HERE"                         # window.EV → events.json
"$PY" "$HERE/mix.py"                                        # score + foley + ambience → out/mix.wav
"$PY" "$HERE/tools/cuecheck.py"                             # every visual hit vs its music note (0 ms target)
node core/render/readcheck.mjs "$HERE"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/48-midcentury-toon.mp4" 24 1
ffmpeg -v error -y -ss 17.75 -i "$HERE/48-midcentury-toon.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/48-midcentury-toon.mp4"
