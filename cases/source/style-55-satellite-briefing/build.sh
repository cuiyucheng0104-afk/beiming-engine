#!/bin/sh
# 一条命令重建《后退的冰川》：数据 → 字体 → 时间轴 → 事件 → 画面 → 配乐与混音 → 母带 → 检查 → 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
# 影像已在 material/（来源见 material/fetch_log.txt；重新下载：$PY -I tools/fetch_plate.py detail 2048 material/plates <scene…>）
"$PY" -I "$HERE/tools/prep.py" "$HERE"
[ -f "$HERE/fonts/NotoSerifSC-600.woff2" ] || "$PY" -I "$HERE/tools/fonts.py" "$HERE"
node "$HERE/tools/export.mjs"
cd "$LIB"
node core/render/events.mjs "$HERE"
"$PY" -I "$HERE/tools/cuecheck.py" "$HERE"
RENDER_SLOTS=${RENDER_SLOTS:-4} node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
"$PY" "$HERE/mix.py"
"$PY" -I "$HERE/tools/audiocheck.py" "$HERE"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/55-satellite-briefing.mp4" 24 1
node core/render/readcheck.mjs "$HERE" || true
ffmpeg -v error -y -ss 17.6 -i "$HERE/55-satellite-briefing.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/55-satellite-briefing.mp4"
