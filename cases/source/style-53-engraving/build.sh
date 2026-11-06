#!/bin/sh
# 博物志·鹦鹉螺 (copperplate engraving) — rebuild everything with one command: sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
node "$HERE/tools/dump.mjs"                                          # timeline.js → out/timeline.json
cd "$LIB"
node core/render/events.mjs "$HERE"                                  # window.EV → events.json
"$LIB/.venv/bin/python" "$HERE/mix.py"                               # score + foley + rooms → out/mix.wav, out/onsets.json
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py"                    # picture vs beat grid vs score vs measured audio (target 0 ms)
node core/render/readcheck.mjs "$HERE"                               # every engraved word stays long enough to read
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/53-engraving.mp4" 24 1   # light grain on cream paper
ffmpeg -v error -y -ss 19.5 -i "$HERE/53-engraving.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/53-engraving.mp4"
