#!/bin/sh
# 《冷冻柜》一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
P=$(cd "$(dirname "$0")" && pwd)
cd "$LIB"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/events.mjs "$P"                      # timeline.js → main.js → events.json
LIB="$LIB" .venv/bin/python "$P/mix.py"               # 配乐 + 拟音 + 环境声 → out/mix.wav、out/stems/、out/score_cues.json
.venv/bin/python "$P/tools/cuecheck.py"               # 拍点核对（画面 ↔ 配乐 ↔ 真实起音）
node core/render/video.mjs "$P" --workers 3 --out "$P/out/video.mp4"
sh core/render/mux.sh "$P/out/video.mp4" "$P/out/mix.wav" "$P/28-scifi-toon.mp4" 24 2   # −14 LUFS
ffmpeg -v error -y -ss 8.9 -i "$P/28-scifi-toon.mp4" -frames:v 1 -q:v 2 "$P/poster.jpg"
.venv/bin/python "$P/tools/cuecheck.py" "$P/28-scifi-toon.mp4"
