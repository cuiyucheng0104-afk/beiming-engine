#!/bin/sh
# 豹变 · 在 RTX 5090 上渲整片：增量同步 → 5090 渲染（Vulkan，6 worker）→ 取回 mp4
#   sh tools/rog_render.sh <影片目录> [--size 1920x1040] [--workers 6] [--out out/<版本>_video.mp4]
# 整片渲染全局串行（一次只渲一部，计时才可信，也不压垮共用机器）；GPU 利用率 > 60% 时每 60 秒再看，最多等 60 分钟。
# 从同步到 5090 渲完一直持有片子锁：别的任务这时同步同一部片子，会把 5090 上的影片目录整个换掉，正在加载的页面会读到一半。
# 渲之前先删掉 5090 上的旧成片，渲染失败就按退出码退出，不会把上次的旧片取回来。
set -e
. "$(dirname "$0")/rog_common.sh"
V=$(film_name "$1"); shift
SIZE=1920x1040; WK=6; OUT=""
while [ $# -gt 0 ]; do case "$1" in --size) SIZE=$2; shift 2;; --workers) WK=$2; shift 2;; --out) OUT=$2; shift 2;; *) echo "不认识 $1" >&2; exit 2;; esac; done
OUT=${OUT:-out/${V}_video.mp4}; case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT";; esac
lock /tmp/baobian_render.lock 7200
trap 'unlock /tmp/baobian_render.lock' EXIT
n=0; while :; do
  U=$(gpu_util); [ "${U:-0}" -le 60 ] && break
  n=$((n + 1)); [ $n -ge 60 ] && { log "GPU 忙了 60 分钟，放弃"; exit 3; }
  log "GPU 利用率 $U%，60 秒后再看"; sleep 60
done
lock "/tmp/baobian_film_$V.lock" 1800
trap 'unlock "/tmp/baobian_film_$V.lock"; unlock /tmp/baobian_render.lock' EXIT
sh "$TOOLS/rog_sync.sh" "films/$V"
R="out\\video\\${V}_${SIZE}.mp4"
LOGF=$(mktemp -t baobian_render)
log "5090 渲染 $V $SIZE ×$WK"
set +e
rps "New-Item -ItemType Directory -Force out\\video | Out-Null; if (Test-Path $R) { Remove-Item -Force $R }; \$sw=[Diagnostics.Stopwatch]::StartNew(); & node.exe engine\\render\\video.mjs films\\$V --fps 24 --size $SIZE --workers $WK --out $R 2>&1 | ForEach-Object { [Console]::Out.WriteLine(\"\$_\") }; \$c=\$LASTEXITCODE; [Console]::Out.WriteLine(('5090 用时 {0:N1} 秒' -f \$sw.Elapsed.TotalSeconds)); exit \$c" > "$LOGF" 2>&1
RC=$?
set -e
grep -v -E 'CLIXML|<Objs' "$LOGF" || true
rm -f "$LOGF"
unlock "/tmp/baobian_film_$V.lock"
[ $RC -eq 0 ] || { log "5090 渲染失败（退出码 $RC）"; exit $RC; }
mkdir -p "$(dirname "$OUT")"
scp $KEY -q "$HOST:D:/beiming/project/baobian-film/out/video/${V}_${SIZE}.mp4" "$OUT"
log "取回 $OUT"
