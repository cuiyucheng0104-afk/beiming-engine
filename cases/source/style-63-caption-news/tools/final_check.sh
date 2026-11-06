#!/bin/sh
# 成片自检：时长、帧率、响度（ebur128）、黑帧（blackdetect）
F=$1
ffprobe -v error -show_entries format=duration:stream=codec_type,r_frame_rate -of compact "$F"
ffmpeg -hide_banner -nostats -i "$F" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|LRA|Peak):" | head -3
echo "black segments: $(ffmpeg -hide_banner -nostats -i "$F" -vf blackdetect=d=0.03:pix_th=0.08 -an -f null - 2>&1 | grep -c black_start)"
