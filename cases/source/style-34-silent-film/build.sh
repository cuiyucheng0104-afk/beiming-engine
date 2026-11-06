#!/bin/sh
# 《追帽子》一条命令重建：timeline → 事件 → 配乐+拟音混音 → 逐帧渲染 → 封装(−14 LUFS) → 拍点核对 → 海报
LIB=@@LEMO_ROOT@@
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB
[ -f "$LIB/core/render/video.mjs" ] || { echo "set LIB to the library folder"; exit 1; }
PY="$LIB/.venv/bin/python"
node "$HERE/tools/dump_timeline.mjs"
cd "$LIB"
node core/render/events.mjs "$HERE"
"$PY" "$HERE/mix.py"
export RENDER_SLOTS=${RENDER_SLOTS:-4}
node core/render/video.mjs "$HERE" --fps 24 --workers 3 --out "$HERE/out/video.mp4"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/34-silent-film.mp4" 24 1
"$PY" "$HERE/tools/cuecheck.py" "$HERE/34-silent-film.mp4"
"$PY" -c "import json;h=json.load(open('$HERE/timeline.json'))['hit'];json.dump([{'t0':h['card1'],'t1':h['silence'],'text':'那顶帽子……'},{'t0':h['card2'],'t1':h['bow'],'text':'原来是猴子的'}],open('$HERE/out/cues.json','w'),ensure_ascii=False)"
"$PY" core/render/srt.py "$HERE/out/cues.json" "$HERE/34-silent-film.srt"
ffmpeg -y -loglevel error -ss 14.35 -i "$HERE/34-silent-film.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "done: $HERE/34-silent-film.mp4"
