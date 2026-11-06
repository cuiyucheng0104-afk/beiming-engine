#!/bin/sh
# 一条命令重建《一滴颜料变锦鲤》：sh build.sh
set -e
LIB=@@LEMO_ROOT@@
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
cd "$HERE"
[ -f fonts.css ] || node tools/fetch_fonts.mjs "$HERE"          # 一次性（需联网），字体子集已随工程保存
[ -f paper.png ] || "$PY" tools/paper.py "$HERE"
node tools/tl2json.mjs "$HERE"                                  # timeline.js → timeline.json
cd "$LIB"
node core/render/events.mjs "$HERE"                             # window.EV → events.json
"$PY" "$HERE/mix.py"                                            # 配乐 + 拟音 → out/mix.wav
"$PY" "$HERE/tools/cuecheck.py" "$HERE"                         # 画面 ↔ 音乐拍点核对（偏差 0 ms 才继续）
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 60 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/02-watercolor.mp4" 60 1
ffmpeg -y -loglevel error -ss 15.6 -i "$HERE/02-watercolor.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done → $HERE/02-watercolor.mp4"
