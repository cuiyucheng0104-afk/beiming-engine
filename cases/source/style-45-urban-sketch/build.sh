#!/bin/sh
# 早餐铺开门 — rebuild everything with one command: sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
node "$HERE/tools/dump.mjs"                                     # timeline.js → out/timeline.json
"$LIB/.venv/bin/python" "$HERE/music/score.py"                   # score → out/music.wav + onsets
cd "$LIB"
node core/render/events.mjs "$HERE"                             # window.EV → events.json
node "$HERE/tools/cuecheck.mjs"                                 # picture vs music on the beat grid, target 0 ms
node core/render/readcheck.mjs "$HERE"                          # handwriting stays long enough to read
"$LIB/.venv/bin/python" "$HERE/mix.py"                           # foley + ambience + music → out/mix.wav
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/45-urban-sketch.mp4" 24 1   # light grain on cream paper
ffmpeg -v error -y -ss 15.4 -i "$HERE/45-urban-sketch.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/45-urban-sketch.mp4"
