#!/bin/sh
LIB=@@LEMO_ROOT@@
# 渔夫还珠 · shadow-puppet style sample — one command rebuilds the film from source.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
PY="$LIB/.venv/bin/python"
node "$HERE/tools/timeline_json.mjs"                                   # timeline.js → out/timeline.json
cd "$LIB"
node core/render/events.mjs "$HERE"                                    # window.EV → events.json
"$PY" "$HERE/music/score.py"                                           # original score → out/stems/*.wav
"$PY" "$HERE/mix.py"                                                   # foley + score → out/mix.wav
"$PY" "$HERE/tools/cuecheck.py" > "$HERE/out/cuecheck.txt" || { cat "$HERE/out/cuecheck.txt"; exit 1; }
node core/render/readcheck.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/07-shadow-puppet.mp4" 24 2
node core/render/still.mjs "$HERE" 10.7 --prefix poster_ --out "$HERE/out" && cp "$HERE/out/poster_10.7.jpg" "$HERE/poster.jpg"
echo "done → $HERE/07-shadow-puppet.mp4"
