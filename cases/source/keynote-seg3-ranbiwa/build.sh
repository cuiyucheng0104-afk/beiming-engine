#!/bin/sh
# 片段三「燃比娃与揭晓」一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
"$LIB/.venv/bin/python" "$HERE/tools/prep.py"
cd "$LIB"
node core/render/events.mjs "$HERE"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/seg3-ranbiwa.mp4" 30 1
ffmpeg -y -loglevel error -ss 34.8 -i "$HERE/seg3-ranbiwa.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/seg3-ranbiwa.mp4"
