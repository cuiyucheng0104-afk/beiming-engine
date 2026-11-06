#!/bin/sh
# 豹变 · 在 5090 上重新生成一段配乐（MiniMax-Music3，纯音乐），带锁，一次只跑一个
#   sh tools/rog_music.sh <版本> "<英文描述>" [时长秒=44] [--seed N] [--bpm N]
# 结果先写到 audio/<版本>_try.wav；够 31 秒才替换 audio/<版本>.wav（旧的备份为 audio/<版本>_prev.wav），并重出分析报告。
set -e
. "$(dirname "$0")/rog_common.sh"
V=$1; P=$2; D=${3:-44}; shift 3 2>/dev/null || shift $#
cd "$ROOT"
lock /tmp/baobian_music.lock 1800
trap 'unlock /tmp/baobian_music.lock' EXIT
bash "$HOME/Desktop/见龙/tools/rog_ai.sh" music "$P" "$D" "audio/${V}_try.wav" "$@"
L=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "audio/${V}_try.wav")
if awk -v d="$L" 'BEGIN{exit !(d>=31)}'; then
  [ -f "audio/$V.wav" ] && mv "audio/$V.wav" "audio/${V}_prev.wav"
  mv "audio/${V}_try.wav" "audio/$V.wav"
  OFF=$("$PY" tools/audio_align.py "audio/$V.wav" --anchor 21.0 2>/dev/null)
  "$PY" tools/audio_report.py "audio/$V.wav" --offset "$OFF" --png "audio/${V}_curve.png" | tee "audio/${V}_report.txt"
  echo "已替换 audio/$V.wav（${L}s），旧的在 audio/${V}_prev.wav"
else
  echo "只生成了 ${L}s，不够 31 秒，未替换（试试换 --seed 或把时长写长）"; exit 4
fi
