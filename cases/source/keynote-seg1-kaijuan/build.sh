#!/bin/sh
# 片段一「开卷」一条命令重建：事件表 → 画面 → 配乐与音效 → 母带合成 → 自检
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
mkdir -p "$HERE/out"
cd "$LIB"
node core/render/events.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/seg1-kaijuan.mp4" 30 1
node core/render/still.mjs "$HERE" 30.9 --out "$HERE/out" >/dev/null
"$LIB/.venv/bin/python" -c "from PIL import Image; Image.open('$HERE/out/t_30.9.jpg').save('$HERE/poster.jpg', quality=92)"
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py" "$HERE/seg1-kaijuan.mp4" | tail -2
