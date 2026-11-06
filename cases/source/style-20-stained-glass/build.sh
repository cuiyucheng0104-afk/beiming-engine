#!/bin/sh
# 一条命令重建《浴火》：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
node "$HERE/tools/export_timeline.mjs"                    # 1. timeline.js -> timeline.json（唯一时间源）
"$PY" "$HERE/music/score.py"                              # 2. 原创配乐 stems（72 BPM，D 多利亚 -> D 大调）
cd "$LIB"
node core/render/events.mjs "$HERE"                       # 3. window.EV -> events.json（拟音与视觉 cue）
node core/render/readcheck.mjs "$HERE"                    # 4. 画面文字阅读时长
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"   # 5. 逐帧渲染
"$PY" "$HERE/mix.py"                                      # 6. 拟音 + 配乐 + 静默 -> out/mix.wav
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/20-stained-glass.mp4" 24 2   # 7. 混流，两遍 loudnorm -14 LUFS
node "$HERE/tools/statecheck.mjs" "$HERE"                 # 8a. 画面 cue 逐帧核对（目标 0 ms）
"$PY" "$HERE/tools/cuecheck.py" "$HERE/20-stained-glass.mp4"   # 8b. 成片拍点核对（网格/乐谱/画面/音轨）
node core/render/still.mjs "$HERE" 17.9 --prefix poster_ --out "$HERE/out" && cp "$HERE/out/poster_17.9.jpg" "$HERE/poster.jpg"   # 9. 海报
