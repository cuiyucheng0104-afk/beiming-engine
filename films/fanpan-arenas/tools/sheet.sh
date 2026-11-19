#!/usr/bin/env bash
# 把几套场景的截图拼成一张总览：每格左上角标场景名、地址参数、谁做的、怎么做的。要装 ImageMagick 7（magick、montage）。
#   bash films/fanpan-arenas/tools/sheet.sh <截图所在目录> <输出文件> <截图文件名（不带目录）> <名字|标题|说明> ...
# 例（tools/shot.mjs --clean 存的纯场景图，裁掉下面空出来的手牌区）：
#   CROP=1280x545+0+0 bash films/fanpan-arenas/tools/sheet.sh films/fanpan-arenas/out/shots films/fanpan-arenas/out/overview.jpg desktop-high-clean.png \
#     'harvest|丰收麦场 ?arena=harvest|谁做的：…｜怎么做的：…' 'sea|珊瑚龙宫 ?arena=sea|…'
# 环境变量：CROP 先裁一刀；COLS 每行几格（默认 2）；FONT 中文字体文件（默认问 fontconfig 要一个简体中文粗体）
set -euo pipefail
dir=$1; out=$2; shot=$3; shift 3; tmp=$(mktemp -d); i=0; files=()
font=${FONT:-$(fc-match -f '%{file}' ':lang=zh-cn:bold')}
for spec in "$@"; do
  IFS='|' read -r name title note <<<"$spec"
  f="$tmp/$(printf %02d $i).png"
  magick "$dir/$name/$shot" ${CROP:+-crop "$CROP" +repage} \
    \( -size 1280x74 xc:'#000000b8' \) -gravity northwest -composite \
    -font "$font" -fill '#ffe9a8' -pointsize 26 -annotate +16+6 "$title" \
    -fill '#e8e8f0' -pointsize 17 -annotate +16+44 "$note" "$f"
  files+=("$f"); i=$((i+1))
done
montage "${files[@]}" -tile "${COLS:-2}x" -geometry +6+6 -background '#0a0a14' "$out"
rm -rf "$tmp"; echo "总览图 $out"
