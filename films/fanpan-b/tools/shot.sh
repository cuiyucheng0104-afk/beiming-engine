#!/bin/sh
# 出一张 B 版草图帧并量一下（仓库根目录）：sh films/fanpan-b/tools/shot.sh [prep]
# 原生运行时的位置按本机实际改（npm run env:doctor -- --route b 会报）；量法脚本借用 C 版 tools/ 里的那一个（只是量图，不是画面素材）
set -e
export RAEA_BIN=${RAEA_BIN:-$HOME/.cache/beiming/raea/0.1.4/linux-x64/raea/bin/raea}
if [ "$1" = prep ]; then node films/fanpan-b/bake.mjs && node engine/native/prepare.mjs films/fanpan-b 2>&1 | tail -1; fi
node engine/render/native.mjs films/fanpan-b --at 72 --max-gpu-util 60 2>&1 | grep -E "错误|提示|ERROR|APPLIED" | tail -4
d=$(ls -d films/fanpan-b/out/2026*/ | tail -1)
mkdir -p films/fanpan-b/out/work
cp "$d/stills/f000072.png" films/fanpan-b/out/work/b72.png
node tools/env/py.mjs films/fanpan-c/tools/measure1.py films/fanpan-b/out/work/b72.png
