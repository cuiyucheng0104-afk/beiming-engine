#!/bin/sh
# OFL 字体子集（Google Fonts CSS API &text=）：main.js 与 timeline.js 里出现的每个字符。FORCE=1 重新下载。
set -e
H=$(cd "$(dirname "$0")/.." && pwd); D=$H/fonts; mkdir -p "$D"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
TXT=$(python3 -c "
import urllib.parse
s=open('$H/main.js',encoding='utf8').read()+open('$H/timeline.js',encoding='utf8').read()
c=sorted(set(ch for ch in s if ord(ch)>=0x20))+list('0123456789%+·—–−≈×“”…')
print(urllib.parse.quote(''.join(sorted(set(c)))))")
font() { [ -s "$D/$2" ] && [ -z "$FORCE" ] && return 0
  url=$(curl -fsS -A "$UA" "https://fonts.googleapis.com/css2?$1&text=$TXT" | grep -o 'https://[^)]*' | head -1); curl -fsS -o "$D/$2" "$url"; echo "$2"; }
font "family=Noto+Sans+SC:wght@900" sc900.woff2
font "family=Noto+Sans+SC:wght@500" sc500.woff2
font "family=Inter+Tight:wght@800" it800.woff2
font "family=Inter+Tight:wght@500" it500.woff2
for f in notosanssc intertight; do [ -s "$D/OFL-$f.txt" ] || curl -fsS -o "$D/OFL-$f.txt" "https://raw.githubusercontent.com/google/fonts/main/ofl/$f/OFL.txt"; done
ls -la "$D"
