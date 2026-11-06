#!/bin/sh
# 分段出片：sh tools/seg.sh S03   → out/segs/S03.mp4（画面 + 本段旁白/音效/配乐，30 fps，−14 LUFS）
# 步骤：分段画面（video.mjs ?seg=S03 --workers 2）→ 分段混音（mix.py --seg）→ mux.sh 封装 → 黑帧检查。
# 超过 2 分钟的段请放后台跑。只读共用件，不改任何别人的文件。
set -e
LIB=${LIB:-@@LEMO_ROOT@@}
HERE=$(cd "$(dirname "$0")/.." && pwd)
SEG=$1; [ -n "$SEG" ] || { echo "用法: sh tools/seg.sh Sxx"; exit 2; }
mkdir -p "$HERE/out/segs"
cd "$LIB"
node core/render/video.mjs "$HERE" --fps 30 --workers ${WORKERS:-2} --q "seg=$SEG" --out "$HERE/out/segs/${SEG}_v.mp4"
"$LIB/.venv/bin/python" "$HERE/tools/mix.py" --seg "$SEG"
sh core/render/mux.sh "$HERE/out/segs/${SEG}_v.mp4" "$HERE/out/segs/${SEG}_mix.wav" "$HERE/out/segs/${SEG}.mp4" 30 1
# 黑帧 / 纯色帧检查（≥0.1 s 的整屏墨色会被列出来；开场黑场是设计内的，自己判断）
ffmpeg -hide_banner -nostats -i "$HERE/out/segs/${SEG}.mp4" -vf "blackdetect=d=0.1:pix_th=0.12" -an -f null - 2>&1 | grep -o "black_start.*" || echo "无黑帧段"
echo "$HERE/out/segs/${SEG}.mp4"
