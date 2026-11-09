#!/bin/sh
# {{TITLE}} · 一键出片：关键帧静帧 → 声音 → 逐帧视频 → 音画封装 → ffprobe 核对。产物全在 films/{{NAME}}/out/（不提交）。
#   sh films/{{NAME}}/build.sh                 按 film.json 的画幅
#   sh films/{{NAME}}/build.sh --size 3840x2080  原生 4K（构图不变，引擎按高度放大）
#   PYTHON=/path/to/python sh films/{{NAME}}/build.sh   指定装了 requirements.txt 的 Python
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
REL=${HERE#"$ROOT"/}
PY=${PYTHON:-python3}
OUT="$REL/out"; mkdir -p "$OUT/stills"

FPS=$(node -e "console.log(require('./$REL/film.json').fps)")
DUR=$(node -e "console.log(require('./$REL/film.json').dur)")
SIZE=$(node -e "console.log(require('./$REL/film.json').size.join('x'))")
[ "$1" = "--size" ] && SIZE="$2"

echo "== 1/4 关键帧（开头 / 中段 / 结尾）"
node engine/render/still.mjs "$REL" 0 "$(node -e "console.log(($DUR/2).toFixed(2))")" "$(node -e "console.log(($DUR-1/$FPS).toFixed(3))")" --size "$SIZE" --out "$OUT/stills"

echo "== 2/4 声音"
"$PY" "$REL/sound.py"

echo "== 3/4 逐帧渲染（$SIZE，$FPS fps）"
node engine/render/video.mjs "$REL" --size "$SIZE" --fps "$FPS" --out "$OUT/video.mp4"

echo "== 4/4 音画封装"
sh engine/render/mux.sh "$OUT/video.mp4" "$OUT/mix.wav" "$OUT/film.mp4" "$FPS" 0

ffprobe -v error -count_frames -show_entries stream=codec_type,width,height,r_frame_rate,nb_read_frames,sample_rate,channels -show_entries format=duration -of default=nw=1 "$OUT/film.mp4"
echo "完成：$OUT/film.mp4（应有 $(node -e "console.log(Math.round($DUR*$FPS))") 帧）"
