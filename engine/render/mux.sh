#!/bin/sh
# 北冥引擎 · 音画封装：sh engine/render/mux.sh video.mp4 mix.wav out.mp4 [fps] [grain=0]
#
# 响度：用 ebur128（与最后核对用的是同一把尺）测积分响度和真峰值，整段乘同一个增益到 −14 LUFS，不压动态。
#   编成 AAC 后真峰值仍超过 −1.2 dBTP 时，才在 4 倍过采样上用前瞻限幅器削掉超出的峰，再测一次把积分响度补回 −14。
#   不用 loudnorm：短片上它的第一遍会把片尾约 3 秒重复计入（《北冥》的 mix.wav 测偏响约 0.9 LU，成片只有 −14.9），
#   响度范围大于目标、或线性增益后峰值放不下时，它还会悄悄退回动态压缩。
# 时长：音频按画面时长（帧数 ÷ 帧率）补静音或截断，不用 -shortest（音频短几毫秒就会丢掉最后一帧）。
# 帧率：不传 fps 就用输入视频的帧率；传了但与输入不一致直接报错（fps 滤镜会静默丢帧或重复帧）。
# 色彩：矩阵换算成有限范围 BT.709 并写明标记（矩阵 bt709、范围 tv）；原色与传递特性按输入的标记保留，没有标记写 bt709
#   （video.mjs 的产物就是 1-1-1、tv）。YUV 输入有范围标记按标记，没有按 H.264 的默认值有限范围；矩阵 bt709、bt470bg、
#   smpte170m、fcc、smpte240m、bt2020nc 按标记换算，没有矩阵标记按 BT.601（截图的矩阵）——旧版 video.mjs 在 FFmpeg ≤ 7.0 下的
#   产物正是“有限范围、BT.601、无标记”。RGB 输入（像素格式 rgb / bgr / gbr…，例如 libx264rgb 产出的 gbr）直接换算。
#   swscale 换算不了的矩阵（bt2020c、ycgco、ictcp 等）不换算：画面原样重新编码、保留输入的全部标记（与旧版 mux.sh 相同），并给出提示。
#   从成片取帧去比静帧时请精确解码，例如 -vf scale=in_range=tv:in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=rgb24；
#   FFmpeg 默认的快速 yuv→rgb 会把有限范围画面整体读暗约 2 级（码流本身没问题，播放器显示也不受影响）。
# grain > 0 时在封装阶段再叠一层胶片颗粒；北冥的颗粒已在页面里画在显示层之下，所以默认 0。
# grain = 0 且输入已是完整标记的有限范围 BT.709（video.mjs 的产物）时，画面直接拷贝，不重新编码。
# 最后核对成片：帧数与输入一致、|I + 14| ≤ 0.5 LU、真峰值 ≤ −1.2 dBTP。
# 退出码：2 用法或参数不符，3 读不出画面或响度，4 响度不达标，5 帧数不符；FFmpeg 本身出错时按 set -e 非零退出。
# 换行应当是 LF。万一按 CRLF 检出（Windows 上 Git 默认 core.autocrlf=true），下面两行去掉 CR 后原样重跑本脚本：
#   第一行的赋值在 CRLF 下会把 CR 带进值里；第二行以 # 结尾，多出来的 CR 落进注释，所以它在 CRLF 下照样能执行。
_lf=1
[ "$_lf" = 1 ] || { [ -r "$0" ] && echo "[提示] $0 是 CRLF 换行：已去掉 CR 后运行（建议按 LF 重新检出）" >&2 && exec sh -c "$(tr -d '\r' < "$0")" "$0" "$@"; echo "$0 是 CRLF 换行，读不到脚本文件去掉 CR：请按 LF 检出（git config core.autocrlf false 后重新检出）" >&2; exit 2; } #
set -e
V="$1"; A="$2"; O="$3"; FPS="${4:-}"; GR="${5:-0}"
[ -f "$V" ] && [ -f "$A" ] && [ -n "$O" ] || { echo "用法：sh engine/render/mux.sh video.mp4 mix.wav out.mp4 [fps] [grain]" >&2; exit 2; }
TI=-14; TTP=-1.2; TOL=0.5; LIM=0.81   # 目标积分响度、真峰值上限、允许偏差；限幅线 0.81 ≈ −1.8 dBFS，给 AAC 编码留余量
T=$(mktemp -d "${TMPDIR:-/tmp}/beiming-mux.XXXXXX")
trap 'rm -rf "$T"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

die() { echo "mux.sh：$1" >&2; exit "${2:-1}"; }
meas() { ffmpeg -hide_banner -nostats -i "$1" -vn -af ebur128=peak=true:framelog=quiet -f null - 2>&1; }
field() { printf '%s\n' "$1" | awk -v k="$2" '$1 == k { v = $2 } END { print v }'; }
calc() { awk "BEGIN { printf \"%.2f\", $1 }"; }
vprobe() { ffprobe -v error -select_streams v:0 -show_entries "stream=$1" -of default=nw=1:nk=1 "$2"; }
frames() { ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of default=nw=1:nk=1 "$1" | head -1 | tr -cd '0-9'; }

# 画面：帧率、帧数、时长
RATE=$(vprobe r_frame_rate "$V")
VFPS=$(awk -v r="$RATE" 'BEGIN { n = split(r, p, "/"); v = (n == 2) ? ((p[2] + 0 > 0) ? p[1] / p[2] : 0) : p[1] + 0; printf "%.6f", v }')
awk -v v="$VFPS" 'BEGIN { exit !(v > 0) }' || die "读不出画面帧率：${V}（r_frame_rate=${RATE}）" 3
if [ -n "$FPS" ]; then
  awk -v a="$FPS" -v b="$VFPS" 'BEGIN { d = a - b; exit !(a + 0 > 0 && d < 0.001 && d > -0.001) }' ||
    die "fps=$FPS 与输入视频的帧率 $RATE 不一致：fps 滤镜会静默丢帧或重复帧。不传第 4 个参数就按输入帧率封装" 2
fi
NF=$(frames "$V")
case "$NF" in ''|*[!0-9]*) die "数不出画面帧数：$V" 3 ;; esac
[ "$NF" -gt 0 ] || die "画面没有帧：$V" 3
VD=$(awk -v n="$NF" -v f="$VFPS" 'BEGIN { printf "%.6f", n / f }')

# 声音：先对齐到画面时长（48 kHz，补静音或截断），之后的测量和增益都针对成片里真正出现的那段
ffmpeg -y -loglevel error -i "$A" -vn -af "aresample=48000,apad=whole_dur=$VD,atrim=end=$VD" -c:a pcm_f32le "$T/a0.wav"
M=$(meas "$T/a0.wav") || die "测响度失败：$A" 3
I0=$(field "$M" I:); P0=$(field "$M" Peak:)
[ -n "$I0" ] && [ -n "$P0" ] || die "测不出响度：$A" 3
awk -v i="$I0" 'BEGIN { exit !(i > -69) }' || die "音频几乎是静音（${I0} LUFS），测不出可用的响度：$A" 3

enc() { ffmpeg -y -loglevel error -i "$T/a0.wav" -af "$1" -c:a aac -b:a 256k "$T/a.m4a"; }   # 按滤镜链 $1 编成成片用的 AAC
lim() { echo "volume=${1}dB,aresample=192000,alimiter=limit=$LIM:attack=1:release=60:level=0:latency=1,aresample=48000"; }
G=$(calc "$TI - ($I0)")
enc "volume=${G}dB"
P1=$(field "$(meas "$T/a.m4a")" Peak:)
LIMITED=0
if awk -v p="$P1" -v t="$TTP" 'BEGIN { exit !(p > t) }'; then
  # 线性增益后 AAC 的真峰值放不下：过采样限幅。限幅会带走响度（峰越多带走越多），
  # 按测得的差值补增益重做，直到积分响度落在 ±0.1 LU 内，最多 5 次
  LIMITED=1
  n=0
  while :; do
    enc "$(lim "$G")"
    I2=$(field "$(meas "$T/a.m4a")" I:)
    n=$((n + 1))
    awk -v i="$I2" -v t="$TI" 'BEGIN { d = i - t; exit !(d <= 0.1 && d >= -0.1) }' && break
    [ "$n" -lt 5 ] || break
    G=$(calc "$G + ($TI) - ($I2)")
  done
fi

# 色彩（见开头说明）：INM 是换算用的输入矩阵；rgb 表示 RGB 像素格式，keep 表示换算不了、原样编码
PF=$(vprobe pix_fmt "$V"); R=$(vprobe color_range "$V"); CS=$(vprobe color_space "$V")
PRI=$(vprobe color_primaries "$V"); TRC=$(vprobe color_transfer "$V")
PRI0=$PRI; TRC0=$TRC   # 下面会把缺省标记补成 bt709，这里留一份原样，用来判断能否直接拷贝画面
case "$R" in pc) INR=full ;; tv|unknown|unspecified|'') INR=limited ;; *) die "不认识的输入色彩范围：$R" 3 ;; esac
case "$PF" in
  rgb*|bgr*|gbr*|argb|abgr|0rgb|0bgr|x2rgb*|x2bgr*) INM=rgb ;;
  *) case "$CS" in
       bt709) INM=bt709 ;;
       bt470bg|smpte170m|unknown|unspecified|reserved*|'') INM=bt601 ;;
       fcc) INM=fcc ;;
       smpte240m) INM=smpte240m ;;
       bt2020nc|bt2020_ncl) INM=bt2020 ;;
       *) INM=keep ;;
     esac ;;
esac
# 原色、传递特性：保留输入的标记，没有标记按 bt709；名字与 setparams 的写法一致（ffprobe 打印的就是这套名字）
case "$PRI" in
  unknown|unspecified|reserved*|'') PRI=bt709 ;;
  bt709|bt470m|bt470bg|smpte170m|smpte240m|film|bt2020|smpte428|smpte431|smpte432|jedec-p22|ebu3213) ;;
  *) die "不认识的输入原色标记：$PRI" 3 ;;
esac
case "$TRC" in
  unknown|unspecified|reserved*|'') TRC=bt709 ;;
  bt709|bt470m|bt470bg|smpte170m|smpte240m|linear|log100|log316|iec61966-2-4|bt1361e|iec61966-2-1|bt2020-10|bt2020-12|smpte2084|smpte428|arib-std-b67) ;;
  *) die "不认识的输入传递特性标记：$TRC" 3 ;;
esac
case "$TRC" in bt470m) ETRC=gamma22 ;; bt470bg) ETRC=gamma28 ;; *) ETRC=$TRC ;; esac   # 编码器选项对这两个用另一种写法
GRAIN=""
[ "$GR" = "0" ] || GRAIN=",noise=c0s=$GR:allf=t"   # c0 是亮度；RGB 输入要换算成 YUV 之后再加，否则加在 G 通道上
SWS="out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int"
TAG="setparams=range=tv:color_primaries=$PRI:color_trc=$TRC:colorspace=bt709"
case "$INM" in
  keep)
    echo "[提示] 输入矩阵 $CS 用 swscale 换算不了：画面不换算，按原矩阵与输入标记原样编码（输出不是 BT.709）" >&2
    VF="fps=$RATE$GRAIN,format=yuv420p"; ENCTAGS=""
    COLOR="按输入原样（矩阵 ${CS}，未换算）" ;;
  rgb)
    VF="fps=$RATE,scale=$SWS,format=yuv420p$GRAIN,$TAG"
    ENCTAGS="-colorspace bt709 -color_primaries $PRI -color_trc $ETRC -color_range tv"
    COLOR="有限范围 BT.709（由 RGB 换算；原色 ${PRI}、传递特性 ${TRC}）" ;;
  *)
    VF="fps=$RATE$GRAIN,scale=in_range=$INR:in_color_matrix=$INM:$SWS,format=yuv420p,$TAG"
    ENCTAGS="-colorspace bt709 -color_primaries $PRI -color_trc $ETRC -color_range tv"
    COLOR="有限范围 BT.709（输入 ${CS:-无矩阵标记}/${R:-无范围标记}；原色 ${PRI}、传递特性 ${TRC}）" ;;
esac

# 不加颗粒、且输入已是完整标记的有限范围 BT.709（video.mjs 的产物就是这样）时，画面直接拷贝，
# 不再重新编码：否则 video.mjs 的 crf 14 之上又叠一代有损。其他输入照旧换算并重新编码。
COPY=0
if [ "$GR" = "0" ] && [ "$PF" = yuv420p ] && [ "$R" = tv ] && [ "$CS" = bt709 ] && [ "$PRI0" = bt709 ] && [ "$TRC0" = bt709 ]; then
  COPY=1
  COLOR="有限范围 BT.709（输入已完整标记，画面直接拷贝，未重新编码）"
fi

# 封装：画面按输入帧数输出，声音直接拷贝上面核对过的 AAC。
if [ "$COPY" = 1 ]; then
  ffmpeg -y -loglevel error -i "$V" -i "$T/a.m4a" \
    -map 0:v:0 -map 1:a:0 -c:v copy -frames:v "$NF" \
    -c:a copy -movflags +faststart "$O"
else
  # crf 18：有限范围的信号幅度小一些，同一 crf 下码率会降；实测 crf 18 时与旧版全范围 crf 19 对基线静帧的误差持平
  # shellcheck disable=SC2086   # ENCTAGS 故意按空格拆成多个参数（里面的值都是上面白名单里的名字，没有空格）
  ffmpeg -y -loglevel error -i "$V" -i "$T/a.m4a" \
    -filter_complex "[0:v]$VF[v]" -map "[v]" -map 1:a:0 \
    -c:v libx264 -preset slow -crf 18 -r "$RATE" -frames:v "$NF" \
    $ENCTAGS \
    -c:a copy -movflags +faststart "$O"
fi

# 核对成片
NO=$(frames "$O")
MO=$(meas "$O") || die "测成片响度失败：$O" 3
IO=$(field "$MO" I:); LO=$(field "$MO" LRA:); PO=$(field "$MO" Peak:)
echo "$O"
echo "  画面：$NO 帧（输入 $NF 帧，$RATE fps，${VD} 秒），$COLOR"
echo "  响度：原 ${I0} LUFS、真峰值 ${P0} dBTP → 整段增益 ${G} dB$( [ "$LIMITED" = 1 ] && echo '；线性增益后 AAC 峰值超限，加了 4 倍过采样限幅' )"
echo "    I:    $IO LUFS"
echo "    LRA:  $LO LU"
echo "    Peak: $PO dBFS"
[ "$NO" = "$NF" ] || die "成片 $NO 帧，与输入画面 $NF 帧不一致：$O" 5
awk -v i="$IO" -v p="$PO" -v ti="$TI" -v tp="$TTP" -v tol="$TOL" 'BEGIN { d = i - ti; exit !(i != "" && p != "" && d <= tol && d >= -tol && p <= tp) }' ||
  die "成片响度不达标：I=${IO} LUFS（目标 ${TI}±${TOL}）、真峰值 ${PO} dBTP（上限 ${TTP}）：$O" 4
