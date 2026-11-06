#!/bin/sh
# 冰淇淋车 · 一条命令重建：字体(缺失时) → 事件 → 画面(60 fps) → 配乐与拟音 → 拍点核对 → 母带(−14 LUFS) → 读秒检查 → 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
NAME=71-memphis-diorama
cd "$LIB"
for f in NotoSansSC-400 NotoSansSC-600 NotoSansSC-800 InterTight-400 InterTight-600 InterTight-800 IBMPlexMono-400; do
  [ -f "$HERE/fonts/$f.woff2" ] || { "$PY" -I "$HERE/tools/fonts.py" "$HERE"; break; }
done
mkdir -p "$HERE/out" "$HERE/stills"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/events.mjs "$HERE"                                            # window.DUR + window.EV → events.json
node core/render/video.mjs "$HERE" --fps 60 --workers 3 --out "$HERE/out/video.mp4"
"$PY" -I "$HERE/mix.py"                                                        # → out/mix.wav + out/music_onsets.json
"$PY" -I "$HERE/tools/cuecheck.py" "$HERE" | tee "$HERE/out/cuecheck.txt"      # 画面事件 ↔ 拍点，目标 0 ms
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" 60 0
node core/render/readcheck.mjs "$HERE" > "$HERE/out/readcheck.txt" && echo "readcheck ok"
ffmpeg -v error -y -ss 16.6 -i "$HERE/$NAME.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
for s in wave:4.6 cutaway:10.5 pop:15.25; do
  ffmpeg -v error -y -ss "${s#*:}" -i "$HERE/$NAME.mp4" -frames:v 1 -q:v 2 "$HERE/stills/styleframe_${s%%:*}.jpg"
done
echo "done: $HERE/$NAME.mp4"
