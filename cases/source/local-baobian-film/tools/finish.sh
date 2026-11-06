#!/bin/sh
# 豹变 · 一版的收尾：5090 渲整片 → 配乐对位并截 30 秒、首尾淡入淡出 → 封装（−14 LUFS，线性增益）→ 成片检查
#   sh tools/finish.sh <版本名，如 A_shuimo> [--mux-only]
#   --mux-only：不重渲，直接用已有的 out/<版本>_video.mp4 重新配乐和封装（只改了 audio.json 或封装工具时用）
# films/<版本>/audio.json 可写的键（都可省）：
#   "offset": 秒   直接指定从配乐第几秒开始截；不写就按 "anchor"（默认 21.0 秒，S5 起跳）把最大涌起对上去
#   "fade_in": 秒（默认 0.4）
#   "fade_out_st": 片内秒数（默认 28.3）、"fade_out_d": 秒（默认 1.7）、"fade_out_curve": ffmpeg afade 曲线名（默认 tri 线性，
#     常用 qsin、hsin、esin、log、exp）。配乐在片尾还在往上走时，把淡出提前、拉长，或换一条曲线，别让它被掐断
# 产出：out/豹变_<版本>.mp4、out/check_<版本>/（tile.jpg 取第 0、36、72 … 684 帧，即每 1.5 秒一格；report.txt）
set -e
. "$(dirname "$0")/rog_common.sh"
V=$(film_name "$1"); cd "$ROOT"; [ -d films/$V ] || { echo "没有 films/$V" >&2; exit 2; }
if [ "$2" = "--mux-only" ]; then
  [ -s out/${V}_video.mp4 ] || { echo "没有 out/${V}_video.mp4，不能只封装" >&2; exit 2; }
  log "只重新封装 $V（不重渲）"
else
  sh tools/rog_render.sh films/$V --workers 6 --out out/${V}_video.mp4
fi
[ -s audio/$V.wav ] || { echo "没有配乐 audio/$V.wav" >&2; exit 3; }
aj() { [ -f films/$V/audio.json ] && "$PY" -c "import json;v=json.load(open('films/$V/audio.json')).get('$1');print('' if v is None else v)" || true; }
ANCHOR=$(aj anchor); [ -n "$ANCHOR" ] || ANCHOR=21.0
OFF=$(aj offset); [ -n "$OFF" ] || OFF=$("$PY" tools/audio_align.py audio/$V.wav --anchor $ANCHOR --dur 30)
FI=$(aj fade_in); [ -n "$FI" ] || FI=0.4
FOS=$(aj fade_out_st); [ -n "$FOS" ] || FOS=28.3
FOD=$(aj fade_out_d); [ -n "$FOD" ] || FOD=1.7
FOC=$(aj fade_out_curve); [ -n "$FOC" ] || FOC=tri
ffmpeg -y -loglevel error -ss $OFF -t 30 -i audio/$V.wav -af "afade=t=in:d=$FI,afade=t=out:st=$FOS:d=$FOD:curve=$FOC" -ar 48000 audio/${V}_30.wav
MUXLOG=$(sh engine/render/mux.sh out/${V}_video.mp4 audio/${V}_30.wav "out/豹变_${V}.mp4" 24 0)
echo "$MUXLOG"
C=out/check_$V; mkdir -p $C   # 只覆盖 tile.jpg 和 report.txt，终检代理写在这里的 QA.md 和证据要留着
# 有限范围 BT.709 转回 RGB 时用精确取整；ffmpeg 默认的快速转换会让画面整体暗约 2 级
ffmpeg -y -loglevel error -i "out/豹变_${V}.mp4" -vf "select=not(mod(n\,36)),scale=480:-2:in_range=limited:in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,tile=5x4" -fps_mode vfr -frames:v 1 $C/tile.jpg
{
  echo "配乐截取起点 ${OFF}s，锚点 ${ANCHOR}s；淡入 ${FI}s，淡出从 ${FOS}s 起 ${FOD}s（曲线 ${FOC}）"
  echo "$MUXLOG" | head -1
  ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=codec_name,width,height,nb_read_frames,r_frame_rate,pix_fmt,color_range,color_space,color_primaries,color_transfer -of compact "out/豹变_${V}.mp4"
  ffprobe -v error -show_entries format=duration,size -of compact "out/豹变_${V}.mp4"
  ffmpeg -hide_banner -nostats -i "out/豹变_${V}.mp4" -af ebur128=peak=true -f null - 2>&1 | grep -E '^\s+(I|LRA|Peak):' | head -3
  ffmpeg -hide_banner -i "out/豹变_${V}.mp4" -vf blackdetect=d=0.5:pix_th=0.05 -an -f null - 2>&1 | grep -o 'black_start.*' || echo "无 0.5 秒以上黑场"
} | tee $C/report.txt
