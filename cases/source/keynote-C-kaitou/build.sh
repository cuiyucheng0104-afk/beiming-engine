#!/bin/sh
# 方案 C《打开》20 秒开头：一条命令重建 → sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
mkdir -p "$HERE/out"
cd "$LIB"
node core/render/events.mjs "$HERE"                                   # timeline.js → events.json
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
"$LIB/.venv/bin/python" "$HERE/mix.py"                                # 配乐 + 拟音 + 环境 → out/mix.wav
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/C-kaitou.mp4" 30 0
ffmpeg -y -loglevel error -ss 19.9 -i "$HERE/C-kaitou.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
# 自检：逐帧状态采样 + 音画对拍
node "$HERE/tools/probe.mjs"
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py" "$HERE/C-kaitou.mp4" | tail -1
echo "done: $HERE/C-kaitou.mp4"
