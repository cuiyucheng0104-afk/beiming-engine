#!/bin/sh
# 从零重现成片：sh build.sh（任意目录运行均可）
LIB=@@LEMO_ROOT@@
set -e
P="$(cd "$(dirname "$0")" && pwd)"; N=sanda-baigujing; PY="$LIB/.venv/bin/python"
cd "$LIB"
node core/render/events.mjs "$P"                                        # 1. 时间线 → events.json（音效 / 锣鼓卡点）
LIB="$LIB" "$PY" "$P/mix.py"                                            # 2. 拟音 + 锣鼓击节 + 环境 → mix.wav（仅音效，无配音无配乐）
"$PY" "$P/tools/cues.py" && "$PY" core/render/srt.py "$P/out/cues.json" "$P/$N.srt"   # 3. 字幕
node core/render/video.mjs "$P" --fps 24 --workers 3 --out "$P/out/video24.mp4"        # 4. 逐帧渲染（约 6–7 分钟）
CRF=23 sh "$P/tools/mux.sh" "$P/out/video24.mp4" "$P/mix.wav" "$P/$N.mp4" 24 2   # 5. 合成：loudnorm −14 LUFS / −2 dBTP，颗粒 2，CRF 23
still() { for i in 1 2 3; do node core/render/still.mjs "$@" && return 0; echo "retry $i"; done; return 1; }
still "$P" 0 --q 'test=poster' --prefix poster_ --out "$P/out/st" && cp "$P/out/st/poster_0.jpg" "$P/poster.jpg"   # 6. 海报
