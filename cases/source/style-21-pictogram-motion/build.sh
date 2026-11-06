#!/bin/sh
# 一天 · ONE DAY — one command rebuilds the film from source.
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node "$HERE/tools/export_timeline.mjs"                                   # timeline.js → timeline.json
cd "$LIB"
node core/render/events.mjs "$HERE"                                       # window.EV → events.json
"$LIB/.venv/bin/python" "$HERE/mix.py"                                    # score + foley + ambience → out/mix.wav, out/report.txt
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/21-pictogram-motion.mp4" 24 1
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py"                        # picture ↔ music cue check
ffmpeg -v error -y -ss 17.6 -i "$HERE/21-pictogram-motion.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/21-pictogram-motion.mp4"
