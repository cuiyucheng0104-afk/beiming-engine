#!/bin/sh
# Noto Sans SC (OFL) subset to the film's Chinese glyphs via the Google Fonts CSS API (&text=), saved into fonts/.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
CH=$(cat "$HERE/tools/chars.txt")
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$CH")
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
for W in 700 900; do
  URL=$(curl -sfL -A "$UA" "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@$W&text=$ENC" | grep -o 'https://[^)]*' | head -1)
  curl -sfL -o "$HERE/fonts/NotoSansSC-$W.woff2" "$URL"
done
echo "cjk subset: $(printf %s "$CH" | wc -m) chars"
