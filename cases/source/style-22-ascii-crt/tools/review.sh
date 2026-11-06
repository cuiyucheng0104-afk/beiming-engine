#!/bin/sh
# 复查：每秒一帧联系表 + 关键动作 0.2 s 帧条 → 输出到 $2（默认 out/review）
F=${1:-22-ascii-crt.mp4}; OUT=${2:-out/review}
PY=@@LEMO_ROOT@@/.venv/bin/python; SH=@@LEMO_ROOT@@/core/render/sheet.py
mkdir -p "$OUT/sheet" "$OUT/strip"
ffmpeg -y -v error -i "$F" -vf "fps=1,scale=640:-1" -start_number 0 "$OUT/sheet/s_%02d.jpg"
$PY $SH "$OUT/contact.jpg" "$OUT"/sheet/s_*.jpg --cols 5 --w 384 >/dev/null
strip() { ffmpeg -y -v error -ss "$1" -to "$2" -i "$F" -vf "fps=5,scale=480:-1" "$OUT/strip/$3_%02d.jpg"; $PY $SH "$OUT/strip_$3.jpg" "$OUT"/strip/$3_*.jpg --cols 4 --w 480 >/dev/null; }
strip 5.3 6.7 shat; strip 12.9 14.3 brch; strip 14.9 16.3 cyan; strip 18.8 19.875 off
echo "$OUT"
