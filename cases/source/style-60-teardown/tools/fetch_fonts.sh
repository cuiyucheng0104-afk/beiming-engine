#!/bin/sh
# 从 Google Fonts CSS API 用 &text= 子集化下载字体（OFL），放到 fonts/。只在 fonts/ 缺文件时由 build.sh 调用。
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
CJK='按钮行程凸轮齿数弹簧有效圈笔芯球珠每次一转代码模型尺寸为实测·'
LAT='0123456789 .×°Ømm·MD-'
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
get() { # family css-name out
  url=$(curl -fsS -A "$UA" "https://fonts.googleapis.com/css2?family=$1:wght@400;500&text=$(enc "$2")" | grep -o 'https://fonts.gstatic.com[^)]*' | head -1)
  curl -fsS -A "$UA" "$url" -o "$HERE/fonts/$3"
}
mkdir -p "$HERE/fonts"
get 'Noto+Sans+SC' "$CJK" NotoSansSC-sub.woff2
get 'JetBrains+Mono' "$LAT" JetBrainsMono-sub.woff2
ls -l "$HERE/fonts"
