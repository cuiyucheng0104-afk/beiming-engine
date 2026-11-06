#!/bin/sh
# 《十年》 TEN YEARS — transit-map style film. One command rebuilds everything:
#   sh build.sh      fonts → events → score + foley mix → cue check → picture → master → reading-time check → poster
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"; NAME=72-transit-map; FPS=30
export SSL_CERT_FILE=${SSL_CERT_FILE:-/etc/ssl/cert.pem}
cd "$LIB"
# fonts (OFL): Inter + Noto Sans SC subset through the Google Fonts CSS API (&text=)
[ -f "$HERE/fonts/NotoSC.woff2" ] && [ -f "$HERE/fonts/Inter.ttf" ] || python3 "$HERE/tools/fonts.py"
# sampled instruments (CC0 packs of the library), fetched once
for l in vcsl vsco2ce; do [ -d "core/audio/instruments/$l" ] || sh tools/fetch.sh instruments $l; done
# events from the picture, then the score and foley placed on them, then the picture-vs-score cue check
node core/render/events.mjs "$HERE"
"$PY" "$HERE/mix.py"
python3 "$HERE/tools/cuecheck.py" > "$HERE/out/cuecheck.txt" || { tail -5 "$HERE/out/cuecheck.txt"; exit 1; }
tail -1 "$HERE/out/cuecheck.txt"
# picture (30 fps, STYLE.md §5) and master (-14 LUFS, light grain)
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps $FPS --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" $FPS 1
# reading time of every printed line meant to be read (window.TEXTS)
node core/render/readcheck.mjs "$HERE" > "$HERE/out/readcheck.txt" && echo "readcheck ok" || { grep BAD "$HERE/out/readcheck.txt"; exit 1; }
# poster: the ring has closed, four-colour shock rings, "you are here"
ffmpeg -v error -y -ss 16.9 -i "$HERE/$NAME.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/$NAME.mp4"
