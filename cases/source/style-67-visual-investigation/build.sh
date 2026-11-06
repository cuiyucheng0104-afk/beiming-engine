#!/bin/sh
# 大桥的五十九分钟 · one-command rebuild:  sh build.sh   (needs the library at LIB, ffmpeg, network for the first run)
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
# material (public domain) — fetched only when missing
mkdir -p "$HERE/material/raw"
[ -f "$HERE/material/raw/tacoma.ogv" ] || curl -sL -o "$HERE/material/raw/tacoma.ogv" "https://upload.wikimedia.org/wikipedia/commons/f/f2/Tacoma_Narrows_Bridge_destruction.ogv"
[ -f "$HERE/material/raw/noaa_1940-11-07.jpg" ] || curl -sL -o "$HERE/material/raw/noaa_1940-11-07.jpg" "https://upload.wikimedia.org/wikipedia/commons/5/5b/Storm_system_weather_analysis%2C_November_7%2C_1940.jpg"
[ -d "$HERE/assets/fall" ] || sh "$HERE/tools/prep.sh"
[ -f "$HERE/fonts/sans700.woff2" ] || "$PY" "$HERE/tools/fonts.py"
cd "$LIB"
node "$HERE/tools/tl.mjs" "$HERE"                       # timeline.js → timeline.json
node core/render/events.mjs "$HERE"                      # window.EV → events.json
node core/render/readcheck.mjs "$HERE"
"$PY" "$HERE/mix.py"                                     # score + foley → out/mix.wav
"$PY" "$HERE/tools/cuecheck.py"                          # events and sound on the 90 BPM grid
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/out/_mux.mp4" 30 0
# loudness trim: mux lands within ±0.5 LU of −14; one linear gain step (video copied) puts the film on −14.0 (true peak kept ≤ −1.0 dB)
MI=$(ffmpeg -hide_banner -nostats -i "$HERE/out/_mux.mp4" -af ebur128=peak=true -f null - 2>&1 | awk '$1 == "I:" { i = $2 } $1 == "Peak:" { p = $2 } END { print i, p }')
GAIN=$(echo "$MI" | awk '{ g = -14.0 - $1; if ($2 + g > -1.0) g = -1.0 - $2; printf "%.2f", g }')
echo "loudness trim: measured $MI → gain $GAIN dB"
ffmpeg -v error -y -i "$HERE/out/_mux.mp4" -map 0 -c:v copy -af "volume=${GAIN}dB" -c:a aac -b:a 256k -movflags +faststart "$HERE/67-visual-investigation.mp4"
rm -f "$HERE/out/_mux.mp4"
ffmpeg -hide_banner -nostats -i "$HERE/67-visual-investigation.mp4" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|LRA|Peak):"
"$PY" "$HERE/tools/cuecheck.py" "$HERE/67-visual-investigation.mp4"   # + picture cuts on the beat
ffmpeg -v error -y -ss 18.9 -i "$HERE/67-visual-investigation.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/67-visual-investigation.mp4"
