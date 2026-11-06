#!/bin/sh
# 涨潮一米 · 白模投影 — one command rebuild:  sh build.sh      (FETCH=1 sh build.sh re-downloads the open data)
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
NAME=58-white-model
mkdir -p "$HERE/material" "$HERE/data" "$HERE/out" "$HERE/stills"

# 1. open data (public domain): DataSF building footprints (PDDL), USGS 3DEP topobathy DEM; NOAA datums are in tools/prep.py
if [ "${FETCH:-0}" = "1" ] || [ ! -f "$HERE/material/dem.tif" ]; then
  curl -sfL -m 180 -G 'https://data.sfgov.org/resource/ynuv-fyni.geojson' \
    --data-urlencode '$where=within_box(shape, 37.8350, -122.3860, 37.8020, -122.3530)' --data-urlencode '$limit=50000' \
    --data-urlencode '$select=sf16_bldgid,gnd_min_m,hgt_median_m,peak_1st_m,median_1st_m,shape,data_as_of' -o "$HERE/material/ti_buildings.geojson"
  curl -sfL -m 120 -G 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage' \
    --data-urlencode 'bbox=-122.3860,37.8020,-122.3530,37.8350' --data-urlencode 'bboxSR=4326' --data-urlencode 'imageSR=32610' \
    --data-urlencode 'size=1460,1840' --data-urlencode 'format=tiff' --data-urlencode 'pixelType=F32' \
    --data-urlencode 'interpolation=RSP_BilinearInterpolation' --data-urlencode 'f=json' -o "$HERE/material/dem.json"
  curl -sfL -m 180 "$("$PY" -I -c "import json,sys;print(json.load(open(sys.argv[1]))['href'])" "$HERE/material/dem.json")" -o "$HERE/material/dem.tif"
fi
"$PY" -I "$HERE/tools/prep.py" > "$HERE/out/prep.log"          # data/model.json, terrain.bin, key.bin, stats.json (every number on screen)
for f in NotoSansSC-300 NotoSansSC-500 InterTight-200 InterTight-400 IBMPlexMono-400; do
  [ -f "$HERE/fonts/$f.woff2" ] || { "$PY" -I "$HERE/tools/fonts.py" "$HERE"; break; }
done

# 2. timeline -> events -> picture -> score + foley -> master
cd "$LIB"
node "$HERE/tools/export.mjs" "$HERE"
node core/render/events.mjs "$HERE"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$PY" "$HERE/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" 24 1

# 3. checks and poster
"$PY" -I "$HERE/tools/cuecheck.py" "$HERE"
node core/render/readcheck.mjs "$HERE" > "$HERE/out/readcheck.txt" && echo "readcheck ok"
ffmpeg -v error -y -ss 17.6 -i "$HERE/$NAME.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/$NAME.mp4"
