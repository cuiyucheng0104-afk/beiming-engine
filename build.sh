#!/bin/sh
# 北冥引擎 · 一键重建《北冥》：静帧样张 → 混音 → 逐帧视频 → 音画封装 → 网页版 → 单文件 HTML
#   sh build.sh                 1920×1040
#   sh build.sh --4k            3840×2080 原生 4K
#   sh build.sh --no-audio      沿用 out/mix.wav
# 不认识的参数直接报错（例如把 --4k 写成 --4K）。
# 环境变量：
#   WORKERS       逐帧渲染的并行路数。设了就以它为准（--4k 也不覆盖）；没设时 1080p 用 4 路、--4k 用 WORKERS_4K
#   WORKERS_4K    --4k 且没设 WORKERS 时的路数，默认 8
#   PYTHON        Python 解释器，默认 python3（混音、接触印样张、单文件 HTML 用）
#   BEIMING_ANGLE / BEIMING_CHROME / BEIMING_READY_TIMEOUT   GPU 后端、浏览器、等页面就绪的上限，见 engine/render/page.mjs
# 最后核对：成片与网页版的帧数都等于逐帧渲染的帧数（video.mjs 已核对它等于影片时长 × 24），成片时长 = 帧数 ÷ 24；不符非零退出。
# 换行应当是 LF。万一按 CRLF 检出（Windows 上 Git 默认 core.autocrlf=true），下面两行去掉 CR 后原样重跑本脚本：
#   第一行的赋值在 CRLF 下会把 CR 带进值里；第二行以 # 结尾，多出来的 CR 落进注释，所以它在 CRLF 下照样能执行。
#   调用的子脚本（audio/build.sh、engine/render/mux.sh）也经 run_sh 去掉 CR 再交给 sh。
_lf=1
[ "$_lf" = 1 ] || { [ -r "$0" ] && echo "[提示] $0 是 CRLF 换行：已去掉 CR 后运行（建议按 LF 重新检出）" >&2 && exec sh -c "$(tr -d '\r' < "$0")" "$0" "$@"; echo "$0 是 CRLF 换行，读不到脚本文件去掉 CR：请按 LF 检出（git config core.autocrlf false 后重新检出）" >&2; exit 2; } #
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"
PY=${PYTHON:-python3}
# 跑一个 sh 子脚本：内容去掉 CR 后交给 sh -c，$0 仍是子脚本自己的路径（它们靠 $0 找自己所在的目录）。LF 文件内容不变
run_sh() {
  _src=$(tr -d '\r' < "$1") || { echo "读不了 $1" >&2; exit 1; }
  _f=$1; shift
  sh -c "$_src" "$_f" "$@"
}
FPS=24; SIZE=1920x1040; AUDIO=1; TAG=""; FOURK=0
for a in "$@"; do
  case "$a" in
    --4k) SIZE=3840x2080; TAG=_4k; FOURK=1 ;;
    --no-audio) AUDIO=0 ;;
    *) echo "不认识的参数：${a}（可用：--4k --no-audio）" >&2; exit 2 ;;
  esac
done
if [ -z "${WORKERS:-}" ]; then
  if [ "$FOURK" = 1 ]; then WORKERS=${WORKERS_4K:-8}; else WORKERS=4; fi
fi
case "$WORKERS" in ''|*[!0-9]*|0) echo "WORKERS / WORKERS_4K 必须是正整数（收到 ${WORKERS}）" >&2; exit 2 ;; esac
OUT=out; mkdir -p $OUT/stills
PL=$(mktemp -d "${TMPDIR:-/tmp}/beiming-x264.XXXXXX")   # 两遍编码的 passlog，退出时删掉
trap 'rm -rf "$PL"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
nframes() { ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of default=nw=1:nk=1 "$1" | head -1 | tr -cd '0-9'; }

echo "== 1/6 静帧样张（每 0.5 秒一张）"
node engine/render/still.mjs . --range 0:9.5:0.5 9.95 --size 1920x1040 --out $OUT/stills --prefix s_
$PY tools/contact_sheet.py $OUT/contact_sheet.jpg $(ls $OUT/stills/s_*.jpg | sort -t_ -k2 -n) --cols 4 --w 480

if [ "$AUDIO" = 1 ]; then
  echo "== 2/6 混音"
  PYTHON=$PY; export PYTHON
  run_sh audio/build.sh
fi
[ -f $OUT/mix.wav ] || { echo "缺少 out/mix.wav"; exit 1; }

echo "== 3/6 逐帧渲染（${SIZE}，$FPS fps，$WORKERS 路并行）"
node engine/render/video.mjs . --size $SIZE --fps $FPS --workers $WORKERS --out $OUT/video$TAG.mp4

echo "== 4/6 音画封装（颗粒已在页面里画好，封装不再加）"
run_sh engine/render/mux.sh $OUT/video$TAG.mp4 $OUT/mix.wav $OUT/beiming$TAG.mp4 $FPS 0

echo "== 5/6 网页版（两遍 9 Mbps；声音直接拷贝封装时核对过响度的 AAC）"
WVF="scale=1920:-2:in_range=limited:out_range=limited:in_color_matrix=bt709:out_color_matrix=bt709,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
ffmpeg -v error -y -i $OUT/beiming$TAG.mp4 -vf "$WVF" -c:v libx264 -preset slow -b:v 9000k -pass 1 -passlogfile "$PL/x264" -an -f null /dev/null
ffmpeg -v error -y -i $OUT/beiming$TAG.mp4 -vf "$WVF" -c:v libx264 -preset slow -b:v 9000k -maxrate 14000k -bufsize 18000k -pass 2 -passlogfile "$PL/x264" \
  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -c:a copy -movflags +faststart $OUT/beiming_web.mp4

echo "== 6/6 单文件 HTML"
$PY tools/make_html.py $OUT/beiming_web.mp4 $OUT/beiming.html

ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_read_frames -show_entries format=duration -of default=nw=1 $OUT/beiming$TAG.mp4
NV=$(nframes $OUT/video$TAG.mp4); NB=$(nframes $OUT/beiming$TAG.mp4); NW=$(nframes $OUT/beiming_web.mp4)
[ -n "$NV" ] && [ "$NB" = "$NV" ] && [ "$NW" = "$NV" ] || { echo "帧数不一致：逐帧渲染 ${NV}、成片 ${NB}、网页版 $NW" >&2; exit 1; }
D=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 $OUT/beiming$TAG.mp4)
awk -v d="$D" -v n="$NV" -v f="$FPS" 'BEGIN { e = d - n / f; exit !(e < 0.05 && e > -0.05) }' || { echo "成片时长 ${D} 秒，与 $NV 帧 ÷ $FPS 不符" >&2; exit 1; }
echo "完成：$OUT/beiming$TAG.mp4（$NV 帧，${D} 秒；网页版同帧数）"
