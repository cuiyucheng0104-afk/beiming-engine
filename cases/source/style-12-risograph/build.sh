#!/bin/sh
# 跳水 — one command rebuilds the film: timeline → events → score/foley mix → frames → mux → checks → poster
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
cd "$LIB"
node "$HERE/tools/tl.mjs"                                                  # timeline.js → timeline.json
node core/render/events.mjs "$HERE"                                        # DUR + EV → events.json
"$PY" "$HERE/mix.py"                                                       # score + foley + ambience → out/mix.wav
"$PY" "$HERE/tools/onsets.py" "$HERE/out/mix.wav" "$HERE/out/onsets.json"
node "$HERE/tools/cuecheck.mjs" "$HERE"                                    # every visual hit vs its music cue (0 ms)
node core/render/readcheck.mjs "$HERE"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/12-risograph.mp4" 24 0   # grain is in the print, none at mux
node core/render/still.mjs "$HERE" 13.75 --out "$HERE/out" --prefix poster_
"$PY" -c "from PIL import Image; Image.open('$HERE/out/poster_13.75.jpg').save('$HERE/poster.jpg', quality=93)"
echo "done: $HERE/12-risograph.mp4"
