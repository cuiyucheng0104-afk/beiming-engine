#!/bin/sh
# 一伞三景 — one-command rebuild: events → score/foley/mix → frames → master (−14 LUFS) → poster → cue check
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
cd "$LIB"
mkdir -p "$HERE/out"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/mix.py"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/08-ukiyoe.mp4" 24 0
node core/render/still.mjs "$HERE" 19.6 --out "$HERE/out" --prefix poster_
"$LIB/.venv/bin/python" -c "from PIL import Image; Image.open('$HERE/out/poster_19.6.jpg').convert('RGB').save('$HERE/poster.jpg', quality=92)"
node "$HERE/tools/cuecheck.mjs" "$HERE"
node core/render/readcheck.mjs "$HERE"
