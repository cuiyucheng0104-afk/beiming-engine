#!/bin/sh
# 一次性：从 Google Fonts CSS API 用 &text= 取子集，存进 fonts/（渲染时不联网）
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
get() { # family file text
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$3")
  css=$(curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=$1&text=$enc")
  url=$(printf '%s' "$css" | grep -o 'https://[^)]*' | head -1)
  [ -n "$url" ] || { echo "no url for $1"; exit 1; }
  curl -s -A "$UA" -o "$HERE/fonts/$2" "$url"; echo "$2 <- $url"
}
CJK="接住躲开刷牙关灯通第晚安！＋"
get "ZCOOL+QingKe+HuangYou" zcool_qk.woff2 "$CJK"
get "Noto+Sans+SC:wght@900" notosc900.woff2 "$CJK"
get "Titan+One" titan.woff2 "SPEEDUPBOSXZz!0123456789+ "
