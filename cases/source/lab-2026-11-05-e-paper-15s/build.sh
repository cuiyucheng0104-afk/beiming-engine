#!/bin/sh
# Optional POSIX rebuild. The delivered film was produced on the RTX workstation.
set -eu
cd "$(dirname "$0")"
PYTHON=${PYTHON:-python3}
node engine/render/video.mjs . --size 3840x2080 --fps 24 --workers 4 --out out/video_4k.mp4
"$PYTHON" audio/make.py
ffmpeg -v error -nostdin -y -i out/video_4k.mp4 -i out/mix.wav -vf 'scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p' -c:v libx264 -preset medium -crf 16 -colorspace bt709 -color_trc bt709 -color_primaries bt709 -color_range tv -c:a aac -b:a 256k -ar 48000 -t 15 -movflags +faststart delivery/paper-rivers_E_4k.mp4
ffmpeg -v error -nostdin -y -i delivery/paper-rivers_E_4k.mp4 -vf scale=1920:1040 -pix_fmt yuv420p -c:v libx264 -preset medium -crf 19 -colorspace bt709 -color_trc bt709 -color_primaries bt709 -color_range tv -c:a copy -movflags +faststart delivery/paper-rivers_E_preview.mp4
"$PYTHON" tools/deliver.py
