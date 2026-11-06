#!/bin/sh
# 封装：画面 + 已母带处理的 mix.wav → mp4（不再 loudnorm：响度与真峰值在 mix.py 里已经做好，且开头 0–20 s 必须与原片逐位一致）
# 视频参数与 $LIB/core/render/mux.sh 相同（fps=30、yuv420p、x264 slow crf 19、AAC 256k、grain 0）
# 用法：sh tools/mux.sh video.mp4 mix.wav out.mp4 [音频起点秒 音频时长秒]   （分段：从全片混音里切出这一段）
set -e
V="$1"; A="$2"; O="$3"; SS="${4:-0}"; D="$5"
[ -f "$V" ] && [ -f "$A" ] && [ -n "$O" ] || { echo "usage: sh tools/mux.sh video.mp4 mix.wav out.mp4 [ss dur]" >&2; exit 2; }
if [ -n "$D" ]; then AIN="-ss $SS -t $D -i"; else AIN="-i"; fi
# shellcheck disable=SC2086
ffmpeg -y -loglevel error -i "$V" $AIN "$A" -filter_complex "[0:v]fps=30,format=yuv420p[v];[1:a]aresample=48000[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 19 -r 30 -c:a aac -b:a 256k -movflags +faststart -shortest "$O.tmp.mp4"
mv "$O.tmp.mp4" "$O"
echo "$O"
ffmpeg -hide_banner -nostats -i "$O" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|Peak):" | head -2
