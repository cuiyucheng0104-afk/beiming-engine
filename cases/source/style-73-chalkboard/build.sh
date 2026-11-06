#!/bin/sh
LIB=@@LEMO_ROOT@@
# One command: 《三个正方形》 Three Squares (chalkboard style sample, 19.9 s, 30 fps, no voice).
# Steps: fonts and chalk recordings (downloaded once; OFL / CC0, see CREDITS), chalk grains, events from the picture,
# score + foley + mix, picture, master to -14 LUFS, reading-time check, cue check, poster.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
NAME=73-chalkboard
FPS=30
POSTER=13.6                                          # c² just filled, the triangle and the emptied squares under it
export RENDER_SLOTS=${RENDER_SLOTS:-4}
cd "$LIB"

# fonts: single-line EMS Delight / Casual Hand (OFL) for the Latin chalk; a 4-glyph subset of LXGW WenKai TC (OFL,
# Google Fonts &text=) used only by the stroke-data check page (index.html?lab=hz)
EMS=https://gitlab.com/oskay/svg-fonts/-/raw/master/fonts/EMS
for f in EMSDelight EMSCasualHand; do [ -f "$HERE/fonts/$f.svg" ] || curl -sfL -o "$HERE/fonts/$f.svg" "$EMS/$f.svg"; done
if [ ! -f "$HERE/fonts/wenkai-ref.woff2" ]; then
  U=$(curl -s -A "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36" \
    "https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC&text=%E5%8B%BE%E8%82%A1%E5%AE%9A%E7%90%86" | grep -oE "https://fonts.gstatic.com[^)]+")
  curl -sfL -o "$HERE/fonts/wenkai-ref.woff2" "$U"
fi

# chalk recordings from Wikimedia Commons (CC0), cut into grains (foley/)
C=https://upload.wikimedia.org/wikipedia/commons
mkdir -p "$HERE/material" "$HERE/out"
[ -f "$HERE/material/chalk-on-chalkboard.wav" ] || curl -sfL -o "$HERE/material/chalk-on-chalkboard.wav" "$C/8/81/264944_chalk-on-chalkboard.wav"
[ -f "$HERE/material/Chalkboard-writing.ogg" ]  || curl -sfL -o "$HERE/material/Chalkboard-writing.ogg" "$C/3/36/Chalkboard-writing.ogg"
[ -f "$HERE/foley/index.json" ] || "$PY" -I "$HERE/tools/foley_lib.py" "$HERE/foley" \
  fat="$HERE/material/chalk-on-chalkboard.wav" tom="$HERE/material/Chalkboard-writing.ogg"

# events from the picture (strokes, landings, whip, wipe, cues), then the score, foley and mix placed on them
node core/render/events.mjs "$HERE"
"$PY" "$HERE/mix.py"
"$PY" "$HERE/tools/cuecheck.py" "$HERE" > "$HERE/out/cuecheck.txt" && tail -1 "$HERE/out/cuecheck.txt"

# picture and master (mux.sh brings the mix to -14 LUFS and adds a light grain)
node core/render/video.mjs "$HERE" --fps $FPS --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" $FPS 1

# reading time of every word on the board (window.TEXTS)
node core/render/readcheck.mjs "$HERE" > "$HERE/out/readcheck.txt" && echo "readcheck ok" || { tail -20 "$HERE/out/readcheck.txt"; exit 1; }

# poster
node core/render/still.mjs "$HERE" $POSTER --out "$HERE/out" --prefix poster_
cp "$HERE/out/poster_$POSTER.jpg" "$HERE/poster.jpg"
echo "done: $HERE/$NAME.mp4"
