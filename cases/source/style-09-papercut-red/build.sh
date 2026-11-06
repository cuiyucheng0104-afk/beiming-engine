#!/bin/sh
# 鲤鱼跃龙门 — one command rebuild: events → score + foley mix → frames → master (−14 LUFS, no grain) → cue check
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${LIB_OVERRIDE:-$LIB}; export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/09-papercut-red.mp4" 24 0
node core/render/readcheck.mjs "$HERE"
"$LIB/.venv/bin/python" -I "$HERE/tools/cuecheck.py" "$HERE"
ffmpeg -y -v error -ss 18.6 -i "$HERE/09-papercut-red.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/09-papercut-red.mp4"
