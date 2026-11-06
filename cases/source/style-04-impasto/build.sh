#!/bin/sh
# 红色自行车 — rebuild everything with one command: sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
node "$HERE/tools/dump.mjs"                                    # timeline → out/timeline.json
"$LIB/.venv/bin/python" "$HERE/music/score.py"                  # score (sampler + synthesized brushes)
cd "$LIB"
node core/render/events.mjs "$HERE"                            # window.EV → events.json
node "$HERE/tools/cuecheck.mjs"                                # picture vs music, target 0 ms
"$LIB/.venv/bin/python" "$HERE/mix.py"                          # foley + ambience + mix → out/mix.wav
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/04-impasto.mp4" 24 0   # no grain: keeps the knife edges
ffmpeg -v error -y -ss 15.4 -i "$HERE/04-impasto.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"   # poster: the raking-light wide
