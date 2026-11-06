#!/bin/sh
# 方案 B《片库之夜》20 秒开头：一条命令重建。素材预处理 → 事件表 → 画面 → 配乐与音效 → 母带合成 → 海报 → 对拍自检
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
export RENDER_SLOTS=${RENDER_SLOTS:-4}
mkdir -p "$HERE/out"
PY="$LIB/.venv/bin/python"
"$PY" "$HERE/tools/prep.py"
cd "$LIB"
node core/render/events.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 30 --workers 3 --out "$HERE/out/video.mp4"
"$PY" "$HERE/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/B-kaitou.mp4" 30 1
node core/render/still.mjs "$HERE" 17.2 --out "$HERE/out" >/dev/null
"$PY" -c "from PIL import Image; Image.open('$HERE/out/t_17.2.jpg').save('$HERE/poster.jpg', quality=92)"
"$PY" -c "import soundfile as sf; a,sr=sf.read('$HERE/out/stems/foley.wav'); b,_=sf.read('$HERE/out/stems/taps.wav'); sf.write('$HERE/out/stems/foley_taps.wav',a+b,sr,subtype='FLOAT')"
"$PY" "$HERE/tools/cuecheck.py" | grep -E "【|共"
