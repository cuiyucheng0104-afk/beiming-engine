#!/bin/sh
# 豹变 · 门禁（子代理规范第三节）：全部 PASS 才算这一版"能交"。所有渲染都在 5090 上。
#   sh tools/gate.sh <影片目录>
# 产出 films/<版本>/_work/gate/：GATE.md（结论表）、gate.json、main/（26 个关键时刻静帧 + sheet.jpg）、det/、4k/
# 退出码 0 = 全部通过；1 = 有不通过项（看 GATE.md）
set -e
. "$(dirname "$0")/rog_common.sh"
V=$(film_name "$1")
G=$ROOT/films/$V/_work/gate; rm -rf "$G"; mkdir -p "$G"
cd "$ROOT"
# G0 静态检查：确定性红线
grep -rnE 'Math\.random|Date\.now|performance\.now|new Date\(' "films/$V" --include='*.js' --include='*.html' --include='*.mjs' --exclude-dir=_work > "$G/g0.txt" 2>/dev/null || true
TIMES="0.5 2.0 3.6 4.1 4.6 5.5 7.5 9.5 10.8 11.6 12.8 14.0 15.0 16.5 18.0 19.5 20.8 21.8 23.5 25.0 26.4 26.9 27.6 28.6 29.3 29.9"
set +e
sh "$TOOLS/rog_stills.sh" "films/$V" $TIMES --tag gate_main --out "$G/main"; echo $? > "$G/main.rc"
sh "$TOOLS/rog_stills.sh" "films/$V" 5.5 16.5 25.0 --tag gate_det --out "$G/det" --no-sync; echo $? > "$G/det.rc"
sh "$TOOLS/rog_stills.sh" "films/$V" 4.6 16.5 27.6 --size 3840x2080 --tag gate_4k --out "$G/4k" --no-sync; echo $? > "$G/4k.rc"
set -e
"$PY" "$TOOLS/gate_metrics.py" "$G" "$V" "$TIMES"
