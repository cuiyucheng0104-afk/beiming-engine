#!/bin/sh
# 豹变 · 把工程同步到 5090（增量）
#   sh tools/rog_sync.sh <影片目录，如 films/A_shuimo>
# 共享部分（engine/ fonts/ films/_lib/ package.json）按内容哈希，变了才传；node_modules 按 package-lock.json 哈希，变了才传；
# 影片目录每次整目录替换（不含 _work/），先解到临时目录再换上去，避免渲染读到一半的文件。
set -e
. "$(dirname "$0")/rog_common.sh"
V=$(film_name "$1"); [ -f "$ROOT/films/$V/index.html" ] || { echo "没有 films/$V/index.html" >&2; exit 2; }
TAG=baobian_$(date +%s)_$$
X=${TMPDIR:-/tmp}/baobian_xfer; mkdir -p "$X"
lock /tmp/baobian_sync.lock 600
trap 'unlock /tmp/baobian_sync.lock' EXIT

cd "$ROOT"
SH=$(find engine fonts films/_lib package.json -type f ! -name '.DS_Store' | LC_ALL=C sort | xargs shasum | shasum | cut -c1-16)
NH=$(shasum package-lock.json | cut -c1-16)
REMOTE=$(ssh $KEY $HOST "wsl -e cat $RPROJ_WSL/.shared.sha $RPROJ_WSL/.nm.sha" 2>/dev/null | tr -d '\r' || true)
RS=$(echo "$REMOTE" | sed -n 1p); RN=$(echo "$REMOTE" | sed -n 2p)

LIST="$X/$TAG.list"; : > "$LIST"; NEWS=0; NEWN=0
[ "$RS" = "$SH" ] || { NEWS=1; find engine fonts films/_lib package.json package-lock.json -type f ! -name '.DS_Store' >> "$LIST"; log "共享部分有变化，一起传"; }
[ "$RN" = "$NH" ] || { NEWN=1; find node_modules -type f >> "$LIST"; log "node_modules 有变化，一起传"; }
find "films/$V" -path "films/$V/_work" -prune -o -type f ! -name '.DS_Store' -print >> "$LIST"
tar --no-mac-metadata --no-xattrs -cf "$X/$TAG.tar" -T "$LIST"

cat > "$X/$TAG.sh" <<EOF
set -e
P=$RPROJ_WSL; I=\$P/.incoming_$TAG
mkdir -p \$I && tar -xf $RXFER_WSL/$TAG.tar -C \$I
swap() { [ -d \$I/\$1 ] || return 0; mkdir -p \$(dirname \$P/\$1); rm -rf \$P/\$1.old; [ -d \$P/\$1 ] && mv \$P/\$1 \$P/\$1.old; mv \$I/\$1 \$P/\$1; rm -rf \$P/\$1.old; }
for d in engine fonts films/_lib node_modules films/$V; do swap \$d; done
for f in package.json package-lock.json; do [ -f \$I/\$f ] && mv -f \$I/\$f \$P/\$f; done
[ $NEWS = 1 ] && echo $SH > \$P/.shared.sha
[ $NEWN = 1 ] && echo $NH > \$P/.nm.sha
rm -rf \$I $RXFER_WSL/$TAG.tar $RXFER_WSL/$TAG.sh
EOF
scp $KEY -q "$X/$TAG.tar" "$X/$TAG.sh" "$HOST:D:/beiming/transfer/"
ssh $KEY $HOST "wsl -e sh $RXFER_WSL/$TAG.sh"
log "已同步 films/$V（$(du -h "$X/$TAG.tar" | cut -f1)）"
rm -f "$X/$TAG.tar" "$X/$TAG.sh" "$LIST"
