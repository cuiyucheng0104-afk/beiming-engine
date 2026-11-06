#!/bin/sh
# 《见龙》一条命令重建整片：sh build.sh
# 产出：jianlong.mp4（1920×1080，30 fps，5835 帧，194.5 s，−14 LUFS，真峰值 ≤ −1 dBTP）、jianlong.srt、poster.jpg（默认取 8.6 s 片名完整时）
# 整片画面渲染约 70 s（4 个 worker），混音约 1 分钟，封装约 2 分钟；请放后台跑。素材/深度/字幕/字体已在工程里；要从原图重做，先跑 sh build.sh prep。
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "LIB 不对：$LIB"; exit 1; }
PY="$LIB/.venv/bin/python"
# 时间表唯一来源是 ~/Desktop/见龙/timeline.json，这里只同步一份给页面读（不要手改 data/timeline.json）
cp "$HERE/../timeline.json" "$HERE/data/timeline.json"
if [ "$1" = prep ]; then
  "$PY" "$HERE/tools/prep.py"; "$PY" "$HERE/tools/depth.py"; "$PY" "$HERE/tools/voenv.py"; "$PY" "$HERE/tools/fonts.py"
fi
"$PY" "$HERE/tools/subs.py"
"$PY" "$HERE/tools/textcheck.py"
cd "$LIB"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/events.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 30 --workers 4 --out "$HERE/out/video.mp4"
"$PY" "$HERE/tools/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/jianlong.mp4" 30 1
node core/render/still.mjs "$HERE" ${POSTER_T:-8.6} --out "$HERE/out" --prefix poster_ >/dev/null && cp "$HERE/out/poster_${POSTER_T:-8.6}.jpg" "$HERE/poster.jpg"
# 实测：帧数、时长、响度、真峰值
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -show_entries format=duration -of compact "$HERE/jianlong.mp4"
ffmpeg -hide_banner -nostats -i "$HERE/jianlong.mp4" -vn -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|Peak):" | tail -2
echo "$HERE/jianlong.mp4"
