#!/bin/sh
# 重新生成 fonts/ 里的字体子集（显示层 + 片名用）。
# 用 Google Fonts CSS2 API 的 &text= 参数，只取用到的字；文字改了就改下面三行再跑一遍：
#   sh fonts/fetch_fonts.sh
# 三个字体都是 SIL OFL 1.1，许可见 fonts/LICENSE.md。
set -eu
cd "$(dirname "$0")"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

# 显示层与副标题用到的全部汉字和符号（多留了几个备用字，免得小改文案就要重抓）
SC_TEXT='05:54 远洋聘书·回复截止06:00 识别中…未能识别 导航·吴淞口23km AI眼镜·品牌短片·概念样片 提醒距还有分钟已发送0123456789%'
# 数字与西文（Barlow，DIN 风格的数字）
LAT_TEXT='0123456789:·…%. kmAIKM'
# 片名
TITLE_TEXT='北冥'

enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote("".join(sorted(set(sys.argv[1])))))' "$1"; }

# $1=CSS 查询串  $2=输出文件名前缀；按 CSS 里出现的顺序下载，每个 weight 一个文件
grab() {
  css=$(curl -sS -m 30 -A "$UA" "https://fonts.googleapis.com/css2?$1&display=block")
  echo "$css" | awk -v pre="$2" '
    /font-weight:/ { gsub(/[^0-9]/, "", $2); w = $2 }
    /src: url\(/  { match($0, /url\([^)]*\)/); u = substr($0, RSTART + 4, RLENGTH - 5); print pre "-" w ".woff2 " u }' |
  while read -r name url; do
    curl -sS -m 60 -A "$UA" -o "$name" "$url"
    echo "$name  $(wc -c < "$name" | tr -d ' ') 字节"
  done
}

# Noto Sans SC 取可变字体子集（字重轴 300–500：Light / Regular / Medium 都在这一个文件里）
grab "family=Noto+Sans+SC:wght@300..500&text=$(enc "$SC_TEXT")" NotoSansSC-var
mv NotoSansSC-var-*.woff2 NotoSansSC-var.woff2
grab "family=Barlow:wght@300;400;500&text=$(enc "$LAT_TEXT")" Barlow
grab "family=Ma+Shan+Zheng&text=$(enc "$TITLE_TEXT")" MaShanZheng
ls -la *.woff2
