#!/bin/sh
# One command rebuild of T−15 (65-countdown).
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
sh "$HERE/material/fetch.sh"                      # NASA excerpts (only the seconds used; skipped if present)
sh "$HERE/tools/prep.sh"                          # synced, graded frames named by film frame number
python3 "$HERE/tools/fetch_fonts.py"              # OFL fonts + CJK subset
cd "$LIB"
node core/render/events.mjs "$HERE"               # window.EV (from timeline.js) → events.json
node core/render/readcheck.mjs "$HERE"            # every on-screen text long enough to read
"$PY" "$HERE/mix.py"                              # score + ticks + foley + launch → out/mix.wav
"$PY" "$HERE/tools/beatcheck.py"                  # every visual event on its musical cue (0 ms)
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/65-countdown.mp4" 30 1
ffmpeg -v error -y -ss 15.6 -i "$HERE/65-countdown.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/65-countdown.mp4"
