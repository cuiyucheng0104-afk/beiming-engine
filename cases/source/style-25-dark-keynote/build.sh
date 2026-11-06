#!/bin/sh
# 《Lumen》一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
node "$HERE/tools/dump.mjs"                                            # 1. timeline.js → timeline.json（唯一时间源）
cd "$LIB"
node core/render/events.mjs "$HERE"                                    # 2. 画面事件 window.EV → events.json
"$PY" "$HERE/mix.py"                                                   # 3. 原创配乐 + 拟音 + 环境 → out/mix.wav, out/score.json
"$PY" "$HERE/tools/cuecheck.py" "$HERE/out/mix.wav"                    # 4. 拍点核对（画面 ↔ 声音 ↔ 节拍网格）
node core/render/readcheck.mjs "$HERE"                                 # 5. 画面内文字阅读时长
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"   # 6. 逐帧渲染
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/25-dark-keynote.mp4" 24 0   # 7. 合成 −14 LUFS，无颗粒
ffmpeg -v error -y -ss 19.3 -i "$HERE/25-dark-keynote.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"     # 8. 海报帧
echo "done: $HERE/25-dark-keynote.mp4"
