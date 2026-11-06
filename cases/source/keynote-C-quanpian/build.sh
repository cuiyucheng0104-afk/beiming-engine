#!/bin/sh
# 方案 C《打开》全片 180 s：一条命令出整片 → sh build.sh
#   SIZE=960x540 SS=1 sh build.sh   低成本管线验证（半分辨率、1× 超采样；输出 out/C-quanpian_preview.mp4，不覆盖成片）
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
mkdir -p "$HERE/out"
SIZE=${SIZE:-1920x1080}; Q=""; [ -n "$SS" ] && Q="ss=$SS"
FINAL="$HERE/C-quanpian.mp4"; [ "$SIZE" = "1920x1080" ] && [ -z "$SS" ] || FINAL="$HERE/out/C-quanpian_preview.mp4"
cd "$LIB"
node core/render/events.mjs "$HERE"                                                  # timeline.js + 共用层 + 各章 events() → events.json
"$LIB/.venv/bin/python" "$HERE/mix.py"                                               # 开头原混音 + music.wav + sfx/*.json → 侧链 → −14 LUFS → out/mix.wav
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --size "$SIZE" ${Q:+--q "$Q"} --out "$HERE/out/video.mp4"
sh "$HERE/tools/mux.sh" "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$FINAL"          # 不再 loudnorm（mix.py 已母带处理；开头逐位不变）
[ "$FINAL" = "$HERE/C-quanpian.mp4" ] && ffmpeg -y -loglevel error -ss 179.5 -i "$FINAL" -frames:v 1 -q:v 2 "$HERE/poster.jpg"   # 海报 = 结尾锁定的封面（片名 + 选定方向 · 开始洽谈）
# 自检
node "$HERE/tools/probe_full.mjs"                                                    # 逐帧书页/台灯/各章状态 + 画面文字
"$LIB/.venv/bin/python" "$HERE/tools/cuecheck.py" "$FINAL" | tail -12 || true
[ "$FINAL" = "$HERE/C-quanpian.mp4" ] && "$LIB/.venv/bin/python" "$HERE/tools/kaitoucheck.py" "$FINAL" || true
echo "done: $FINAL"
