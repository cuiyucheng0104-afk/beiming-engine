#!/bin/sh
# 《那一脚》 one-command rebuild: fonts → events → picture → score/foley mix → master (−14 LUFS) → beat check
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
python3 "$HERE/tools/fonts.py"
cd "$LIB"
node core/render/events.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/tools/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/69-telestrator.mp4" 30 2
node core/render/still.mjs "$HERE" 14.9 --out "$HERE/stills" && cp "$HERE/stills/t_14.9.jpg" "$HERE/poster.jpg"
node "$HERE/tools/cuecheck.mjs" "$HERE"
