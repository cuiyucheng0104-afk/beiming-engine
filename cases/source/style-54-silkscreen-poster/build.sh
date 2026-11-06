#!/bin/sh
# 岛屿之光 · one command rebuilds the film: events → score → mix → cue check → frames → mux
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
cd "$LIB"
node core/render/events.mjs "$HERE"                          # timeline.js → events.json (DUR + every cue)
"$PY" "$HERE/score.py"                                        # original score → out/score.wav, stems, cuelog
"$PY" "$HERE/mix.py"                                          # ambience + foley from window.EV + score → out/mix.wav
"$PY" -I "$HERE/tools/cuecheck.py"                            # visual cue vs music attack (target 0 ms)
node core/render/readcheck.mjs "$HERE"                        # every printed text stays long enough to read
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/54-silkscreen-poster.mp4" 24 2
ffmpeg -y -v error -ss 18.5 -i "$HERE/54-silkscreen-poster.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
