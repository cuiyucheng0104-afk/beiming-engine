#!/bin/sh
# 《落成之夜》一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
node "$HERE/tools/dump_timeline.mjs"                                   # 1. 唯一时间源 → timeline.json
cd "$LIB"
node core/render/events.mjs "$HERE"                                    # 2. 画面事件（window.EV）→ events.json
"$PY" "$HERE/music/score.py"                                           # 3. 原创配乐 → out/score.wav + music/score.json
"$PY" "$HERE/tools/cuecheck.py"                                        # 4. 拍点核对（画面 ↔ 配乐 ↔ 帧网格）
"$PY" "$HERE/mix.py"                                                   # 5. 拟音 + 环境床 + 配乐 → out/mix.wav
node core/render/readcheck.mjs "$HERE"                                 # 6. 画面内文字读时
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"    # 7. 逐帧渲染
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/18-art-deco.mp4" 24 2   # 8. 混流：−14 LUFS，轻颗粒
node core/render/still.mjs "$HERE" 18.9 --out "$HERE/out/still" --prefix poster_   # 9. 海报
cp "$HERE/out/still/poster_18.9.jpg" "$HERE/poster.jpg"
"$PY" "$HERE/tools/motioncheck.py" "$HERE/out/video.mp4" || true       # 10. 画面动作落点自检（帧差峰值）
