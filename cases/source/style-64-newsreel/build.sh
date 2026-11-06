#!/bin/sh
# One command rebuilds 64-newsreel.mp4 from the material in material/ (downloaded once; see CREDITS).
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
node "$HERE/tools/export_timeline.mjs"                       # timeline.js -> timeline.json
"$PY" -I "$HERE/tools/prep.py"                               # material -> graded assets, map projection
cd "$LIB"
node core/render/readcheck.mjs "$HERE"                       # every on-screen text long enough to read
node core/render/events.mjs "$HERE"                          # window.EV -> events.json
"$PY" "$HERE/audio/mix.py"                                   # score + foley -> out/mix.wav, out/cues.json
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$PY" -I "$HERE/tools/cuecheck.py"                           # picture and music on the same beats
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/out/muxed.mp4" 24 0   # -14 LUFS audio (two-pass loudnorm)
# final picture: grain 7 added once onto the renderer's output, capped bitrate (grain alone would push it past 40 Mb/s)
ffmpeg -y -v error -i "$HERE/out/video.mp4" -i "$HERE/out/muxed.mp4" -map 0:v -map 1:a \
  -vf "fps=24,noise=c0s=7:allf=t,format=yuv420p" -c:v libx264 -preset slow -crf 18 -maxrate 18M -bufsize 36M -r 24 \
  -c:a copy -movflags +faststart "$HERE/64-newsreel.mp4"
ffmpeg -hide_banner -nostats -i "$HERE/64-newsreel.mp4" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|LRA|Peak):" | head -3
node core/render/still.mjs "$HERE" 18.2 --prefix poster_ --out "$HERE/out"
cp "$HERE/out/poster_18.2.jpg" "$HERE/poster.jpg"
echo "done: $HERE/64-newsreel.mp4"
