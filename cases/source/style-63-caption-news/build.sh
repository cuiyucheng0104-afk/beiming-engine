#!/bin/sh
# 《会用工具的海獭》一条命令重建：字体 → 素材预处理 → 拍点导出 → 画面 → 配乐/拟音 → 拍点核对 → 读速核对 → 母带 → 海报 → 自检
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"; export PY
NAME=63-caption-news
[ -s "$HERE/material/raw/float.jpg" ] && [ -s "$HERE/material/raw/kenyon_1969.pdf" ] || { echo "material/raw 缺素材：按 CREDITS 里的 URL 下载"; exit 1; }
sh "$HERE/tools/fonts.sh" >/dev/null
[ -s "$HERE/assets/img/raft.jpg" ] && [ -s "$HERE/assets/img/hook.jpg" ] || sh "$HERE/tools/prep.sh"
for l in freepats vsco2ce vcsl; do [ -d "$LIB/core/audio/instruments/$l" ] || (cd "$LIB" && sh tools/fetch.sh instruments $l); done
cd "$LIB"
node core/render/events.mjs "$HERE"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 30 --workers ${WORKERS:-3} --out "$HERE/out/video.mp4"
"$PY" "$HERE/audio/mix.py"
"$PY" "$HERE/tools/cuecheck.py" > "$HERE/out/cuecheck.txt"; tail -1 "$HERE/out/cuecheck.txt"
node core/render/readcheck.mjs "$HERE" --step 0.04 > "$HERE/out/readcheck.txt"; echo "readcheck ok"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/$NAME.mp4" 30 1
node core/render/still.mjs "$HERE" 12.5 --prefix poster_ --out "$HERE/out"
cp "$HERE/out/poster_12.5.jpg" "$HERE/poster.jpg"
sh "$HERE/tools/final_check.sh" "$HERE/$NAME.mp4"
echo "done: $HERE/$NAME.mp4"
