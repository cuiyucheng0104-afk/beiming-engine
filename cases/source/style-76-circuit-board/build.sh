#!/bin/sh
# 《叮咚》 Ding-Dong — circuit-board style, one command:  sh build.sh
# Steps: frame scan, sound events, score + foley + mix (≈ −16 LUFS, true peak < −3 dBTP), picture (30 fps),
# master (mux.sh two-pass loudnorm to −14 LUFS in one go), cue check, reading check, poster.
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
NAME=76-circuit-board
FPS=30
POSTER=17.9
cd "$LIB"
mkdir -p "$HERE/out"
node "$HERE/tools/framescan.mjs" "$HERE"                       # every frame renders without a page error
node core/render/events.mjs "$HERE"                            # window.EV -> events.json
"$PY" "$HERE/mix.py"                                           # score, foley, mix -> out/mix.wav, out/score.json
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps $FPS --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" $FPS 1
node "$HERE/tools/cuecheck.mjs" "$HERE" > "$HERE/out/cuecheck.txt" && tail -1 "$HERE/out/cuecheck.txt" || { tail -5 "$HERE/out/cuecheck.txt"; exit 1; }
node core/render/readcheck.mjs "$HERE" > "$HERE/out/readcheck.txt" && echo "readcheck ok" || { tail -20 "$HERE/out/readcheck.txt"; exit 1; }
node core/render/still.mjs "$HERE" $POSTER --out "$HERE/out/still" --prefix p_
cp "$HERE/out/still/p_$POSTER.jpg" "$HERE/poster.jpg"
echo "done: $HERE/$NAME.mp4"
