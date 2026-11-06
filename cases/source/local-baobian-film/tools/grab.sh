#!/bin/sh
# 豹变 · 从成片里按帧号抽 PNG（精确取整的 YUV→RGB）
#   sh tools/grab.sh <成片.mp4> <输出目录> <帧号> [帧号 …]      → <输出目录>/f<帧号>.png
# 成片是有限范围 BT.709。ffmpeg 默认的快速转换会让画面整体暗约 2 级，和门禁静帧比会误报"偏暗"，所以抽帧一律用这个脚本。
set -e
M="$1"; D="$2"; shift 2
[ -f "$M" ] && [ -n "$D" ] && [ $# -gt 0 ] || { echo "用法：sh tools/grab.sh 成片.mp4 输出目录 帧号 [帧号 …]" >&2; exit 2; }
mkdir -p "$D"
for N in "$@"; do
  ffmpeg -y -loglevel error -i "$M" -vf "select=eq(n\,$N),scale=flags=accurate_rnd+full_chroma_int,format=rgb24" -fps_mode vfr -frames:v 1 -update 1 "$D/f$N.png"
done
echo "$D"
