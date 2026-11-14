#!/bin/sh
# 北冥引擎 · 一键重建《北冥》：静帧样张 → 混音 → 逐帧视频 → 音画封装 → 网页版 → 单文件 HTML
#   sh build.sh                 1920×1040
#   sh build.sh --4k            3840×2080 原生 4K
#   sh build.sh --no-audio      沿用 out/mix.wav
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"
PY=${PYTHON:-python3}
SIZE=1920x1040; WORKERS=${WORKERS:-2}; AUDIO=1; TAG=""
for a in "$@"; do
  case "$a" in
    --4k) SIZE=3840x2080; WORKERS=${WORKERS_4K:-8}; TAG=_4k ;;
    --no-audio) AUDIO=0 ;;
  esac
done
OUT=out; mkdir -p $OUT/stills

echo "== 1/6 静帧样张（每 1 秒一张）"
rm -f $OUT/stills/s_*.jpg
node engine/render/still.mjs . --range 0:29:1 29.8 --size 1920x1040 --out $OUT/stills --prefix s_
$PY tools/contact_sheet.py $OUT/contact_sheet.jpg $(ls $OUT/stills/s_*.jpg | sort -t_ -k2 -n) --cols 6 --w 320

if [ "$AUDIO" = 1 ]; then
  echo "== 2/6 混音"
  PYTHON=$PY sh audio/build.sh
fi
[ -f $OUT/mix.wav ] || { echo "缺少 out/mix.wav"; exit 1; }

echo "== 3/6 逐帧渲染（$SIZE，24 fps，$WORKERS 路并行）"
node engine/render/video.mjs . --size $SIZE --fps 24 --workers $WORKERS --out $OUT/video$TAG.mp4

echo "== 4/6 音画封装（颗粒已在页面里画好，封装不再加）"
sh engine/render/mux.sh $OUT/video$TAG.mp4 $OUT/mix.wav $OUT/beiming$TAG.mp4 24 0
cp -f $OUT/beiming$TAG.mp4 $OUT/beiming_30s$TAG.mp4

echo "== 5/6 网页版（两遍 9 Mbps）"
PL=$(mktemp -d)/x264
ffmpeg -v error -y -i $OUT/beiming$TAG.mp4 -vf scale=1920:-2 -c:v libx264 -preset slow -b:v 9000k -pass 1 -passlogfile "$PL" -an -f null /dev/null
ffmpeg -v error -y -i $OUT/beiming$TAG.mp4 -vf scale=1920:-2 -c:v libx264 -preset slow -b:v 9000k -maxrate 14000k -bufsize 18000k -pass 2 -passlogfile "$PL" \
  -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart $OUT/beiming_web.mp4

echo "== 6/6 单文件 HTML"
$PY tools/make_html.py $OUT/beiming_web.mp4 $OUT/beiming.html

ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_read_frames -show_entries format=duration -of default=nw=1 $OUT/beiming$TAG.mp4
echo "完成：$OUT/beiming$TAG.mp4"
