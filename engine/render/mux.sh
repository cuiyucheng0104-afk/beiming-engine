#!/bin/sh
# 北冥引擎 · 音画封装：sh engine/render/mux.sh video.mp4 mix.wav out.mp4 [fps=24] [grain=0]
# 响度：两遍 loudnorm，线性增益（不压动态）到 −14 LUFS / 真峰值 −1.2 dBTP；音频短于画面时补静音。
# grain > 0 时在封装阶段再叠一层胶片颗粒；北冥的颗粒已在页面里画在显示层之下，所以默认 0。
set -e
V="$1"; A="$2"; O="$3"; FPS="${4:-24}"; GR="${5:-0}"
[ -f "$V" ] && [ -f "$A" ] && [ -n "$O" ] || { echo "用法：sh engine/render/mux.sh video.mp4 mix.wav out.mp4 [fps] [grain]" >&2; exit 2; }

# 第一遍：测响度
J=$(ffmpeg -hide_banner -nostats -i "$A" -af loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json -f null - 2>&1 | sed -n '/{/,/}/p')
g() { echo "$J" | grep "\"$1\"" | sed 's/.*: "\(.*\)".*/\1/'; }
LN="loudnorm=I=-14:TP=-1.2:LRA=11:measured_I=$(g input_i):measured_TP=$(g input_tp):measured_LRA=$(g input_lra):measured_thresh=$(g input_thresh):offset=$(g target_offset):linear=true"

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
PAD=$(awk -v a="$(dur "$A")" -v v="$(dur "$V")" 'BEGIN { if (a < v - 0.02) printf ",apad=whole_dur=%s", v }')

VF="fps=$FPS"
[ "$GR" = "0" ] || VF="$VF,noise=c0s=$GR:allf=t"

# 第二遍：按测量值线性归一化，与画面一起编码
ffmpeg -y -loglevel error -i "$V" -i "$A" \
  -filter_complex "[0:v]$VF,format=yuv420p[v];[1:a]$LN,aresample=48000$PAD[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 19 -r "$FPS" \
  -c:a aac -b:a 256k -movflags +faststart -shortest "$O"

echo "$O"
ffmpeg -hide_banner -nostats -i "$O" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|LRA|Peak):" | head -3
