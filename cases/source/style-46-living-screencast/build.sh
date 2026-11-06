#!/bin/sh
# 《逃跑的周报》一键重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
cd "$LIB"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/events.mjs "$HERE"                                          # window.EV → events.json
"$LIB/.venv/bin/python" "$HERE/mix.py"                                        # 配乐 + 拟音 → out/mix.wav, out/score.json
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py" > "$HERE/out/cuecheck.txt"   # 拍点核对（偏差 > 0.5 ms 即失败）
tail -1 "$HERE/out/cuecheck.txt"
node core/render/readcheck.mjs "$HERE"                                        # 片名与标注的阅读时长
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/46-living-screencast.mp4" 30 0
node core/render/still.mjs "$HERE" 11.9 --prefix po_ --out "$HERE/out" && cp "$HERE/out/po_11.9.jpg" "$HERE/poster.jpg"
echo "built $HERE/46-living-screencast.mp4"
