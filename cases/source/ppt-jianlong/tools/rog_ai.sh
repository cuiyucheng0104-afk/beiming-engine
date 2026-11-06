#!/bin/bash
# 从 Mac 调用 ROG 5090 上的深度估计 / 文生音乐(WSL pipeline 账户,环境在 /data/ai)
#   rog_ai.sh depth <本地图片或文件夹> <本地输出文件或文件夹>
#   rog_ai.sh music "<描述>" <时长秒> <本地输出.wav> [额外参数: --seed 7 --bpm 60 --key "D minor" --lyrics-file 本地歌词.txt ...]
# 说明: 描述走 stdin 传入, 避免 Windows cmd 的编码/引号问题; 额外参数里不要含空格或特殊字符(--key 请写 Dminor)。
set -euo pipefail
SSH=(ssh -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519" ROG@@@ROG_HOST@@)
SCP=(scp -q -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519")
run_wsl() { "${SSH[@]}" "wsl -d Ubuntu-24.04 -u pipeline -- bash -s"; }
case "${1:-}" in
  depth)
    src="$2"; dst="$3"; id="rogai_$$"
    "${SSH[@]}" "cmd /c mkdir D:\\Transfer\\$id" >/dev/null 2>&1 || true
    "${SCP[@]}" -r "$src" "ROG@@@ROG_HOST@@:D:/Transfer/$id/in" 
    if [ -d "$src" ]; then o="/mnt/d/Transfer/$id/out"; else o="/mnt/d/Transfer/$id/out.png"; fi
    run_wsl <<EOS
cd /data/ai/depth-anything-v2 && venv/bin/python bin/depth16.py /mnt/d/Transfer/$id/in $o 2>&1 | grep -E '^\[(ok|done|load)'
EOS
    if [ -d "$src" ]; then mkdir -p "$dst"; "${SCP[@]}" -r "ROG@@@ROG_HOST@@:D:/Transfer/$id/out/*" "$dst/"; else "${SCP[@]}" "ROG@@@ROG_HOST@@:D:/Transfer/$id/out.png" "$dst"; fi
    "${SSH[@]}" "cmd /c rmdir /s /q D:\\Transfer\\$id" >/dev/null 2>&1 || true ;;
  music)
    prompt="$2"; dur="$3"; out="$4"; shift 4; extra="$*"; id="rogai_$$"
    run_wsl <<EOS
cd /data/ai/minimax-music3 && export PYTHONUNBUFFERED=1
venv/bin/python bin/music3.py $(printf %q "$prompt") -d $dur -o /mnt/d/Transfer/$id.wav $extra 2>&1 | tr '\r' '\n' | grep --line-buffered -E '^\[(done|info|load)|Error|Traceback'
EOS
    "${SCP[@]}" "ROG@@@ROG_HOST@@:D:/Transfer/$id.wav" "$out"
    "${SSH[@]}" "cmd /c del D:\\Transfer\\$id.wav" >/dev/null 2>&1 || true ;;
  *) sed -n 2,6p "$0"; exit 1 ;;
esac
