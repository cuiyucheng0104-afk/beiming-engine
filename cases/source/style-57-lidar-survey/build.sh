#!/bin/sh
# 《火山口》 one-command rebuild: (data) -> timeline -> events -> video -> score/foley/mix -> master -> checks -> poster
# FETCH=1 sh build.sh   also re-downloads the USGS 3DEP points + NAIP photo and rebuilds data/ and fonts/
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
TPY="$HERE/tools/.venv/bin/python"

if [ "${FETCH:-0}" = 1 ] || [ ! -f "$HERE/data/pts.bin" ]; then
  [ -x "$TPY" ] || { uv venv "$HERE/tools/.venv" -q && uv pip install -q -p "$TPY" laspy lazrs numpy scipy pillow fonttools brotli; }
  "$TPY" -I "$HERE/tools/fetch_ept.py" CA_SierraNevada_13_B22 -119.0455 37.9292 700 18 "$HERE/material/ept16"
  mkdir -p "$HERE/material/photo"
  curl -s -m 120 "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox=-13252971.90,4568541.51,-13251196.98,4570316.43&bboxSR=3857&imageSR=3857&size=2048,2048&format=jpg&f=image" -o "$HERE/material/photo/naip.jpg"
  "$TPY" -I "$HERE/tools/build_data.py" 90
  cp "$HERE/material/photo/naip.jpg" "$HERE/data/photo.jpg"
  "$TPY" -I "$HERE/tools/fonts.py"
fi

cd "$LIB"
node "$HERE/tools/export.mjs"
node core/render/events.mjs "$HERE"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$PY" "$HERE/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/out/muxed.mp4" 24 0
# STYLE.md section 2: points are fine detail, so encode at a higher CRF. One generation from the master render,
# audio stream copied bit-for-bit from the loudness-normalised mux (loudness unchanged). Target 15-25 Mbps.
ffmpeg -y -v error -i "$HERE/out/video.mp4" -i "$HERE/out/muxed.mp4" -map 0:v -map 1:a -vf "fps=24,format=yuv420p" \
  -c:v libx264 -preset slow -crf 26 -r 24 -c:a copy -movflags +faststart -shortest "$HERE/57-lidar-survey.mp4"
ffprobe -v error -select_streams v -show_entries stream=bit_rate -of default=nw=1 "$HERE/57-lidar-survey.mp4"

# checks
"$PY" -I "$HERE/tools/cuecheck.py"
node core/render/readcheck.mjs "$HERE"
ffmpeg -hide_banner -nostats -i "$HERE/57-lidar-survey.mp4" -vf blackdetect=d=0.05:pix_th=0.06 -an -f null - 2>&1 | grep black_start && { echo "black frames found"; exit 1; } || echo "blackdetect: no black frames"
ffprobe -v error -show_entries format=duration -of default=nw=1 "$HERE/57-lidar-survey.mp4"
ffmpeg -v error -ss 17.6 -i "$HERE/57-lidar-survey.mp4" -frames:v 1 -q:v 2 -y "$HERE/poster.jpg"
echo "done: $HERE/57-lidar-survey.mp4"
