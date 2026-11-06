#!/bin/sh
# 0.2 s frame strips of the key actions from the finished film → out/strip_<name>.jpg
F=$(cd "$(dirname "$0")/.." && pwd); V="$F/56-briefing-board.mp4"; PY=${LIB:-@@LEMO_ROOT@@}/.venv/bin/python
strip() { name=$1; t0=$2; mkdir -p "$F/out/strip"; i=0; files=""
  while [ $i -lt 8 ]; do t=$(printf "%.2f" "$(echo "$t0 + $i * 0.2" | bc)"); o="$F/out/strip/${name}_$i.jpg"
    ffmpeg -loglevel error -y -ss $t -i "$V" -frames:v 1 -q:v 3 "$o"; files="$files $o"; i=$((i+1)); done
  "$PY" "${LIB:-@@LEMO_ROOT@@}/core/render/sheet.py" "$F/out/strip_$name.jpg" $files --cols 4 --w 480; }
strip landing 0.0
strip loads 10.4
strip verdict 13.2
strip erase 14.6
