#!/bin/sh
# 全片字体子集：按 src/shared/texts.js 的白名单（+占位卡字）从 Google Fonts CSS API 取子集，存进 fonts/。
# 开头原有的三份子集（Inter-700/800-sub、NotoSansSC-700-sub）不动，开头只用它们，保证 0–20 s 逐像素不变。
# 新字族：SC（Noto Sans SC 700）、SCM（Noto Sans SC 500，小字用）、InterF（Inter 500/700/800，全部 ASCII）。
# 用法：sh tools/fonts.sh   （改了 texts.js 之后重跑；需要联网）
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
CH=$(node --input-type=module -e "import('$HERE/src/shared/texts.js').then(m => process.stdout.write(encodeURIComponent(m.allChars() + '0123456789.,:;|·×—-–()（）《》，、？。 ')))")
ASCII=$(node -e "let s='';for(let i=32;i<127;i++)s+=String.fromCharCode(i);s+='×·｜—–';process.stdout.write(encodeURIComponent(s))")
get() {  # family weight text out
  url=$(curl -sf -A "$UA" "https://fonts.googleapis.com/css2?family=$1:wght@$2&text=$3" | grep -o 'https://[^)]*' | head -1)
  [ -n "$url" ] || { echo "fonts.sh: Google Fonts 没有返回 $1 $2" >&2; exit 1; }
  curl -sf -A "$UA" -o "$HERE/fonts/$4" "$url"; echo "fonts/$4 $(wc -c < "$HERE/fonts/$4") bytes"
}
get "Noto+Sans+SC" 700 "$CH" SC-700.woff2
get "Noto+Sans+SC" 500 "$CH" SC-500.woff2
for w in 500 700 800; do get "Inter" $w "$ASCII" InterF-$w.woff2; done
