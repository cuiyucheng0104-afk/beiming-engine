#!/bin/sh
# 悬索桥为何不倒 — one command rebuilds the film from source:  sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
export RENDER_SLOTS=${RENDER_SLOTS:-4}

# objects (cut-out + prints) from the downloaded public-domain HAER photos, only if missing
if [ ! -f "$HERE/kit/objects/cable.png" ]; then
  "$PY" -I "$HERE/kit/tools/cable_mask.py" "$HERE/material/raw/cable.jpg" "$HERE/material/derived/cable_mask.png"
  "$PY" -I "$HERE/kit/tools/prep_object.py" "$HERE/material/raw/cable.jpg" cable --mask "$HERE/material/derived/cable_mask.png" --erode 1 --max 3840 --sat .85
  "$PY" -I "$HERE/kit/tools/make_print.py" "$HERE/material/raw/tower.jpg" print_tower --crop 75,135,1880,2620 --w 1805
  "$PY" -I "$HERE/kit/tools/make_print.py" "$HERE/material/raw/bay.jpg" print_bay --crop 51,107,3627,2697 --w 2400
fi
# the hazy aerial overview: a crop that keeps the headland, tones stretched so it reads on the final wall
if ! grep -q '"levels": "1.5,99.7"' "$HERE/kit/objects/print_elev.json" 2>/dev/null; then
  "$PY" -I "$HERE/kit/tools/make_print.py" "$HERE/material/raw/elev.jpg" print_elev --crop 64,1400,3690,2600 --w 2400 --levels 1.5,99.7 --gamma 1.4
fi

cd "$LIB"
node "$HERE/scenes/gen_scene.mjs"                       # timeline.js → scenes/film.json + audio/timeline.json
node core/render/events.mjs "$HERE"                     # window.EV → events.json
"$PY" "$HERE/audio/mix.py"                              # score + foley + room → out/mix.wav, audio/score.json
node "$HERE/tools/cuecheck.mjs"                         # every visual hit on the grid, with its sound
node core/render/readcheck.mjs "$HERE"                  # reading time of every board text
node "$HERE/tools/camcheck.mjs" "$HERE"                 # the secondary layer stays hidden until the reveal
node "$HERE/tools/rescheck.mjs"                         # no photo upsampled
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/56-briefing-board.mp4" 24 1
ffmpeg -y -loglevel error -ss 19.70 -i "$HERE/56-briefing-board.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/56-briefing-board.mp4"
