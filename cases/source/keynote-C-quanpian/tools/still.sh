#!/bin/sh
# 出单帧（全片时间）：sh tools/still.sh <t> [<t> …] [--q 'ss=1'] [--size 960x540]  → out/stills/t_<t>.jpg
LIB=${LIB:-@@LEMO_ROOT@@}
HERE=$(cd "$(dirname "$0")/.." && pwd)
[ -n "$1" ] || { echo "usage: sh tools/still.sh <t> [<t> ...] [--q k=v] [--size WxH]" >&2; exit 2; }
mkdir -p "$HERE/out/stills"; cd "$LIB" && node core/render/still.mjs "$HERE" "$@" --out "$HERE/out/stills"
