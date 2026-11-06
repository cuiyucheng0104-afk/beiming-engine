#!/bin/sh
# 一封信的旅程 — one command rebuilds the film: events → score/foley mix → cue check → frames → mux (−14 LUFS) → poster
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
"$LIB/.venv/bin/python" "$HERE/cuecheck.py" | tail -1
node core/render/readcheck.mjs "$HERE" | grep -c OK
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/24-iso-infographic.mp4" 24 0
ffmpeg -v error -y -ss 18.9 -i "$HERE/24-iso-infographic.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/24-iso-infographic.mp4"
