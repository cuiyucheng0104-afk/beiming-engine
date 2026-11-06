#!/bin/sh
# 《大坝》一条命令重建：sh build.sh
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
M="$HERE/material"

# 1. 素材（缺什么下什么；全部为美国联邦政府作品 / 公有领域，来源见 CREDITS）
mkdir -p "$M/raw" "$M/photos" "$M/doc" "$M/models"
get() { [ -s "$2" ] || { echo "fetch $2"; curl -sfL -m 900 -A "StyleTestBot/1.0" -o "$2" "$1"; sleep 2; }; }
get "https://archive.org/download/BoulderD1931_2/BoulderD1931_2.mp4" "$M/raw/BoulderD1931_2.mp4"
get "https://archive.org/download/hooverdam00unit_3/hooverdam00unit_3.pdf" "$M/doc/hooverdam00unit_3.pdf"
C=https://upload.wikimedia.org/wikipedia/commons
get "$C/d/d9/Ansel_Adams_-_National_Archives_79-AAB-01.jpg" "$M/photos/adams_dam.jpg"
get "$C/8/8b/%22Apache_Indians_employed_as_high-scalers_on_the_construction_of_Hoover_Dam.%22_-_NARA_-_293746.jpg" "$M/photos/apache_scalers.jpg"
get "$C/5/5d/Grouting_crew_at_work_on_upper_levels_of_Arizona_abutment._The_grout_mixture_is_being_introduced_into_50-foot_holes..._-_NARA_-_293937.jpg" "$M/photos/grouting_crew.jpg"
get "$C/5/55/High-scalers_working_on_Arizona_abutment_-_NARA_-_293766.jpg" "$M/photos/highscalers_az.jpg"
get "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx" "$M/models/u2net_human_seg.onnx"

# 2. 素材 → 统一印刷调色的 assets/（片段、文件页、照片、剪影）
[ -f "$HERE/assets/clips.json" ] || "$PY" -I "$HERE/tools/prep.py" all
for c in pair bent hat sit; do [ -f "$HERE/assets/cut_$c.png" ] || { "$PY" -I "$HERE/tools/prep.py" cuts; break; }; done

# 3. 时间线 → 事件 → 阅读时长检查 → 画面
cd "$LIB"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/events.mjs "$HERE"
node core/render/readcheck.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"

# 4. 配乐 + 拟音 + 环境 → 混音 → −14 LUFS 母带（颗粒 4）
"$PY" "$HERE/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/68-kino-montage.mp4" 24 4

# 5. 海报与拍点核对
ffmpeg -v error -y -ss 17.6 -i "$HERE/68-kino-montage.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
"$PY" "$HERE/cuecheck.py"
