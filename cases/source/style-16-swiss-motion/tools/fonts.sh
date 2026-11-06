#!/bin/sh
# 下载并子集化字体（Google Fonts css2 API 的 &text= 子集，OFL）。只在字体缺失或文字变化时需要运行。
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
CJK=$(node -e "import('$HERE/timeline.js').then(m=>{const s=new Set(Object.values(m.TXT).flat().join('')+'0123456789');process.stdout.write([...s].filter(c=>c.charCodeAt(0)>0x2000&&c!=='—'&&c!=='·').join(''))})")
LAT=' !"#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz—·×'
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
enc() { python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
get() {   # family wght text out
  css=$(curl -sf -A "$UA" "https://fonts.googleapis.com/css2?family=$1:wght@$2&text=$(enc "$3")")
  url=$(printf '%s' "$css" | grep -o 'https://[^)]*' | head -1)
  curl -sf -A "$UA" -o "$HERE/fonts/$4" "$url"; echo "$4 $(wc -c < "$HERE/fonts/$4") bytes"
}
for w in 500 700 800; do get Archivo $w "$LAT" archivo-$w.woff2; done
for w in 500 700; do get Noto+Sans+SC $w "$CJK" notosc-$w.woff2; done
echo "CJK: $CJK"
