#!/bin/sh
# 豹变 · 在 5090 上渲静帧并取回（所有自检、评审都用它，Mac 不跑渲染）
#   sh tools/rog_stills.sh <影片目录> [t ...] [--range a:b:step] [--size 1920x1040] [--query k=v] [--tag 名字] [--out 本地目录] [--no-sync]
# 默认取回到 films/<版本>/_work/stills/<tag>/，同时写 render.log（含 GPU、DUR、每帧耗时、页面报错）和带时间标签的 sheet.jpg。
# 同一部片子的同步+渲染串行（片子锁）；不同片子可以同时渲。退出码 = 5090 上 still.mjs 的退出码。
set -e
. "$(dirname "$0")/rog_common.sh"
V=$(film_name "$1"); shift
TIMES=""; RANGE=""; SIZE=1920x1040; Q=""; TAG=""; OUT=""; SYNC=1
while [ $# -gt 0 ]; do case "$1" in
  --range) RANGE=$2; shift 2;; --size) SIZE=$2; shift 2;; --query) Q=$2; shift 2;; --tag) TAG=$2; shift 2;;
  --out) OUT=$2; shift 2;; --no-sync) SYNC=0; shift;; -*) echo "不认识的参数 $1" >&2; exit 2;; *) TIMES="$TIMES $1"; shift;; esac; done
[ -n "$TIMES$RANGE" ] || { echo "要给时刻或 --range" >&2; exit 2; }
TAG=${TAG:-s$(date +%H%M%S)_$$}; OUT=${OUT:-$ROOT/films/$V/_work/stills/$TAG}
mkdir -p "$OUT"
lock "/tmp/baobian_film_$V.lock" 1800
trap 'unlock "/tmp/baobian_film_$V.lock"' EXIT
[ $SYNC = 1 ] && sh "$TOOLS/rog_sync.sh" "films/$V"

ARGS="films\\$V$TIMES --size $SIZE --out out\\stills\\$V\\$TAG"
[ -n "$RANGE" ] && ARGS="$ARGS --range $RANGE"
[ -n "$Q" ] && ARGS="$ARGS --query $Q"
log "5090 渲静帧 $V [$TAG] $SIZE"
set +e
rps "if (Test-Path out\\stills\\$V\\$TAG) { Remove-Item -Recurse -Force out\\stills\\$V\\$TAG }; & node.exe engine\\render\\still.mjs $ARGS 2>&1 | ForEach-Object { [Console]::Out.WriteLine(\"\$_\") }" > "$OUT/render.log" 2>&1
RC=$?
set -e
grep -v -E 'CLIXML|<Objs|^\s*$' "$OUT/render.log" | tail -n 40 >&2 || true
scp $KEY -q "$HOST:D:/beiming/project/baobian-film/out/stills/$V/$TAG/*.jpg" "$OUT/" 2>/dev/null || log "没有取回任何静帧"
N=$(ls "$OUT"/*.jpg 2>/dev/null | wc -l | tr -d ' ')
[ "$N" -gt 0 ] && "$PY" "$TOOLS/sheet.py" "$OUT" --out "$OUT/sheet.jpg" >/dev/null 2>&1 || true
log "取回 $N 张 → $OUT（退出码 $RC）"
exit $RC
