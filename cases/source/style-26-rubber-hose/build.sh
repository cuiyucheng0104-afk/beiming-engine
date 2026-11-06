#!/bin/sh
# One command rebuild of 闹钟起床号: timeline → events → score → mix → frames → mux → checks
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
cd "$LIB"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node --input-type=module -e "import * as T from '$HERE/timeline.js'; import fs from 'fs'; fs.writeFileSync('$HERE/timeline.json', JSON.stringify(T.EXPORT, null, 1));"
node core/render/events.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/music/score.py"
"$LIB/.venv/bin/python" "$HERE/mix.py"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/26-rubber-hose.mp4" 24 3
ffmpeg -v error -y -ss 11.0 -i "$HERE/26-rubber-hose.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
node core/render/readcheck.mjs "$HERE"
"$LIB/.venv/bin/python" "$HERE/cuecheck.py"
