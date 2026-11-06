#!/bin/sh
LIB=@@LEMO_ROOT@@
# One command: 灵感送达 (Desktop Flythrough), 1920×1080, 30 fps, 19.733 s, no voice, no subtitles.
#   sh build.sh            the whole film → 77-desktop-flythrough.mp4 + poster.jpg
# Steps: the clock (timeline.js → out/timeline.json) → events and camera speed from the page → score, foley, mix → picture → master
#        → reading-time check → cue check (0 ms) → poster.
# Fonts are already in fonts/ (tools/cjk_fonts.sh rebuilds the Chinese subset from Google Fonts); samples come from $LIB (CC0).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${LIB_OVERRIDE:-$LIB}; export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
NAME=77-desktop-flythrough
FPS=30
POSTER=13.7                                   # the ride-along: the bulb on the paper plane, crossing the desk
WORKERS=${WORKERS:-3}
mkdir -p "$HERE/out" "$HERE/music"
cd "$LIB"

# the clock, the page's events and the camera's speed
node "$HERE/tools/tl.mjs"
node core/render/events.mjs "$HERE" --out "$HERE/out/events.json"
node "$HERE/tools/camspeed.mjs" "$HERE/out/camspeed.json"

# score (also music/harmony.json and music/cues.json), foley from the events, the mix (about -16 LUFS; mux.sh masters to -14)
"$PY" -I "$HERE/audio/compose.py"
"$PY" -I "$HERE/audio/foley.py" "$HERE/out/events.json" "$HERE/out/camspeed.json" "$HERE/music/harmony.json" "$HERE/out/timeline.json" "$HERE/out/sfx.wav"
"$PY" -I "$HERE/audio/mix.py" "$HERE/music/score.wav" "$HERE/out/sfx.wav" "$HERE/out/timeline.json" "$HERE/out/mix.wav"

# picture and master (no grain: vector print on a light ground)
node core/render/video.mjs "$HERE" --fps $FPS --workers $WORKERS --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" $FPS 0

# checks: reading time of every word in the world; every cue on the 16th grid
node core/render/readcheck.mjs "$HERE" > "$HERE/out/readcheck.txt" && echo "readcheck ok" || { tail -20 "$HERE/out/readcheck.txt"; exit 1; }
python3 "$HERE/tools/cuecheck.py" > "$HERE/out/cuecheck.txt" && tail -1 "$HERE/out/cuecheck.txt" || { cat "$HERE/out/cuecheck.txt"; exit 1; }

ffmpeg -v error -y -ss $POSTER -i "$HERE/$NAME.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/$NAME.mp4"
