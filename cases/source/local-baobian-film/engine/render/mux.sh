#!/bin/sh
# 北冥引擎 · 音画封装：sh engine/render/mux.sh video.mp4 mix.wav out.mp4 [fps=24] [grain=0]
# 响度：先测积分响度和真峰值，整段乘同一个增益到 −14 LUFS，不压动态。增益后真峰值会超过 −1.2 dBTP 时，
#   只在 4 倍过采样上用前瞻限幅器削掉超出的峰，再测一次，把积分响度补回 −14。音频短于画面时补静音。
#   不用 loudnorm：配乐的响度范围大于目标 LRA、或者真峰值放不下时，它会悄悄退回动态压缩。
# 色彩：页面截图是全范围 BT.601（JPEG）。封装时转成有限范围 BT.709，并写明标记（1-1-1、tv），
#   不同的播放器、剪辑软件和平台读出来的颜色才一致。
# grain > 0 时在封装阶段再叠一层胶片颗粒。北冥的颗粒已经在页面里画在显示层之下，所以默认 0。
set -e
V="$1"; A="$2"; O="$3"; FPS="${4:-24}"; GR="${5:-0}"
[ -f "$V" ] && [ -f "$A" ] && [ -n "$O" ] || { echo "用法：sh engine/render/mux.sh video.mp4 mix.wav out.mp4 [fps] [grain]" >&2; exit 2; }
TI=-14; TTP=-1.2; LIM=0.81   # 目标积分响度、真峰值上限；限幅线 0.81 ≈ −1.8 dBFS，给 AAC 编码留余量
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

meas() { ffmpeg -hide_banner -nostats -i "$1" -af ebur128=peak=true:framelog=quiet -f null - 2>&1; }
field() { echo "$1" | awk -v k="$2" '$1 == k { v = $2 } END { print v }'; }
calc() { awk "BEGIN { printf \"%.2f\", $1 }"; }

# 第一遍：测响度，算整段增益
M=$(meas "$A"); I0=$(field "$M" I:); P0=$(field "$M" Peak:)
[ -n "$I0" ] && [ -n "$P0" ] || { echo "测不出响度：$A" >&2; exit 3; }
G=$(calc "$TI - ($I0)")
NEED=$(awk "BEGIN { print ($P0 + $G > $TTP) ? 1 : 0 }")
af() {
  if [ "$NEED" = 1 ]; then echo "volume=${1}dB,aresample=192000,alimiter=limit=$LIM:attack=1:release=60:level=0:latency=1,aresample=48000"
  else echo "volume=${1}dB,aresample=48000"; fi
}
ffmpeg -y -loglevel error -i "$A" -af "$(af "$G")" -c:a pcm_f32le "$T/a.wav"
# 限幅会带走一点响度：再测一次，按差值补增益重做（只做一次）
if [ "$NEED" = 1 ]; then
  I1=$(field "$(meas "$T/a.wav")" I:)
  G=$(calc "$G + ($TI) - ($I1)")
  ffmpeg -y -loglevel error -i "$A" -af "$(af "$G")" -c:a pcm_f32le "$T/a.wav"
fi
M2=$(meas "$T/a.wav")
echo "响度：原 ${I0} LUFS、真峰值 ${P0} dBTP → 整段增益 ${G} dB$( [ "$NEED" = 1 ] && echo "，峰值超限，过采样限幅" )；处理后 $(field "$M2" I:) LUFS、LRA $(field "$M2" LRA:) LU、真峰值 $(field "$M2" Peak:) dBTP"

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
PAD=$(awk -v a="$(dur "$T/a.wav")" -v v="$(dur "$V")" 'BEGIN { if (a < v - 0.02) printf ",apad=whole_dur=%s", v }')

# 输入的色彩范围和矩阵：有标记按标记，没有标记按北冥截图（全范围 BT.601）处理
R=$(ffprobe -v error -select_streams v:0 -show_entries stream=color_range -of csv=p=0 "$V")
CS=$(ffprobe -v error -select_streams v:0 -show_entries stream=color_space -of csv=p=0 "$V")
case "$R" in tv) INR=limited ;; *) INR=full ;; esac
case "$CS" in bt709) INM=bt709 ;; *) INM=bt601 ;; esac

VF="fps=$FPS"
[ "$GR" = "0" ] || VF="$VF,noise=c0s=$GR:allf=t"
VF="$VF,scale=in_range=$INR:in_color_matrix=$INM:out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"

# 第二遍：与画面一起编码
ffmpeg -y -loglevel error -i "$V" -i "$T/a.wav" \
  -filter_complex "[0:v]$VF[v];[1:a]aresample=48000$PAD[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 18 -r "$FPS" \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 256k -movflags +faststart -shortest "$O"

echo "$O"
ffmpeg -hide_banner -nostats -i "$O" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|LRA|Peak):" | head -3
