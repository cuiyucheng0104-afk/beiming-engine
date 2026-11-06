#!/bin/sh
# 一条命令重建《消失的第十三页》：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
cd "$HERE" && node tools/tl2json.mjs                                   # timeline.js → timeline.json
[ -f "$HERE/fonts/serif900.woff2" ] || python3 -I tools/fetch_fonts.py  # 字体子集（需联网，已下载则跳过）
cd "$LIB"
node core/render/events.mjs "$HERE"                                    # window.EV → events.json
"$PY" "$HERE/mix.py"                                                   # 配乐 + 拟音 + 环境 → out/mix.wav
node core/render/readcheck.mjs "$HERE"                                 # 画面文字阅读时长
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/13-halftone-dossier.mp4" 30 1
"$PY" "$HERE/tools/cuecheck.py" "$HERE/13-halftone-dossier.mp4"       # 拍点核对
ffmpeg -v error -y -ss 17.6 -i "$HERE/13-halftone-dossier.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/13-halftone-dossier.mp4"
