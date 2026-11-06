#!/bin/sh
# 分段静帧联系表：sh tools/still.sh S03 [步长秒=0.5]      → stills/S03/*.jpg + stills/S03_sheet.jpg
#                 sh tools/still.sh S03 at 1.2 3.4 5.0   → 只出这几个段内时刻（不拼表）
# 段内时间 t=0 是段首。会在页面报错、缺图版、画面文字不在白名单时直接失败。
set -e
LIB=${LIB:-@@LEMO_ROOT@@}
HERE=$(cd "$(dirname "$0")/.." && pwd)
SEG=$1; shift || true
[ -n "$SEG" ] || { echo "用法: sh tools/still.sh Sxx [步长|at t…]"; exit 2; }
DUR=$("$LIB/.venv/bin/python" -c "import json;s=[x for x in json.load(open('$HERE/data/timeline.json'))['segments'] if x['seg']=='$SEG'][0];print(round(s['end']-s['start'],3))")
OUT="$HERE/stills/$SEG"; mkdir -p "$OUT"
cd "$LIB"
if [ "$1" = at ]; then shift; node core/render/still.mjs "$HERE" "$@" --q "seg=$SEG" --out "$OUT" --prefix t_; exit 0; fi
STEP=${1:-0.5}
rm -f "${OUT:?}"/t_*.jpg
END=$("$LIB/.venv/bin/python" -c "print(round($DUR-0.034,3))")
node core/render/still.mjs "$HERE" --range "0:$END:$STEP" "$END" --q "seg=$SEG" --out "$OUT" --prefix t_ >/dev/null
"$LIB/.venv/bin/python" core/render/sheet.py "$HERE/stills/${SEG}_sheet.jpg" $(ls "$OUT"/t_*.jpg | sort -t_ -k2 -g) --cols 5 --w 384 >/dev/null
echo "$HERE/stills/${SEG}_sheet.jpg"
