#!/bin/sh
# 分段自检：一条命令出这一章的 mp4（画面 + 从全片混音里切出的声音）和每 0.5 s 一格的联系表。
# 用法：sh tools/seg.sh <段>      段 = ch2 | ch3 | ch4 | ch5 | ch67 | ch2.b（小段，见 timeline.js CH.*.parts）| 20:30（秒）
#       可选环境变量：SIZE=960x540（低成本预览，默认 1920x1080）、SS=1（超采样，默认 2）、WORKERS=2
# 产物：out/seg/<段>.mp4、out/seg/<段>_sheet.jpg（格子上的数字 = 全片时间）、out/seg/<段>_mix.wav（全片混音，含全部章节当前的 sfx）
set -e
LIB=${LIB:-@@LEMO_ROOT@@}; export LIB
HERE=$(cd "$(dirname "$0")/.." && pwd)
SEG="$1"; [ -n "$SEG" ] || { echo "usage: sh tools/seg.sh ch2|ch3.ink|20:30" >&2; exit 2; }
NAME=$(echo "$SEG" | tr ':' '-'); O="$HERE/out/seg"; mkdir -p "$O"
R=$(node --input-type=module -e "
const m = await import('$HERE/src/timeline.js'); const q = '$SEG'; let r;
let x = /^([\d.]+):([\d.]+)\$/.exec(q); if (x) r = [+x[1], +x[2]];
else { x = /^(ch\d+)(?:\.(\w+))?\$/.exec(q); if (!x || !m.CH[x[1]]) { console.error('认不出段 ' + q); process.exit(2); } r = x[2] ? m.partRange(x[1], x[2]) : m.CH[x[1]].range; }
console.log(r[0] + ' ' + (r[1] - r[0]));")
A0=${R% *}; DUR=${R#* }
echo "seg $SEG: $A0 s 起，$DUR s"
cd "$LIB"
node core/render/events.mjs "$HERE" --out "$O/${NAME}_events.json"                      # 全片事件（不带 seg）→ 混音用
"$LIB/.venv/bin/python" "$HERE/mix.py" --events "$O/${NAME}_events.json" --out "$O/${NAME}_mix.wav" | tail -1
export RENDER_SLOTS=${RENDER_SLOTS:-4}
Q="seg=$SEG"; [ -n "$SS" ] && Q="$Q&ss=$SS"
node core/render/video.mjs "$HERE" --fps 30 --workers "${WORKERS:-2}" --q "$Q" --size "${SIZE:-1920x1080}" --out "$O/${NAME}_video.mp4" | tail -1
sh "$HERE/tools/mux.sh" "$O/${NAME}_video.mp4" "$O/${NAME}_mix.wav" "$O/$NAME.mp4" "$A0" "$DUR" | head -1
rm -f "$O/${NAME}_video.mp4"
# 联系表：每 0.5 s 一格，格名 = 全片时间
F="$O/.${NAME}_frames"; rm -rf "$F"; mkdir -p "$F"
ffmpeg -v error -i "$O/$NAME.mp4" -vf "fps=2,scale=320:-2" -start_number 0 "$F/%05d.jpg"
( cd "$F" && for f in *.jpg; do i=${f%.jpg}; t=$(awk -v a="$A0" -v i="$i" 'BEGIN{printf "%.1f", a + (i + 0) * 0.5}'); mv "$f" "t_$t.jpg"; done )
ls "$F"/t_*.jpg | sort -t_ -k2 -n | xargs "$LIB/.venv/bin/python" core/render/sheet.py "$O/${NAME}_sheet.jpg" --cols 8 --w 320 >/dev/null
rm -rf "$F"
echo "done: $O/$NAME.mp4  $O/${NAME}_sheet.jpg"
