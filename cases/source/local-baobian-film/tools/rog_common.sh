#!/bin/sh
# 豹变 · 5090 工具的公共部分（被其他脚本 . 引入，不单独执行）
# 5090 是共用机器：只动 D:\beiming\project\baobian-film 和 D:\beiming\transfer 下以 baobian_ 开头的文件，不动任何别人的进程。
TOOLS=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$TOOLS")
PY="$ROOT/.venv/bin/python"
KEY="-o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -i $HOME/.ssh/id_ed25519"
HOST=ROG@@@ROG_HOST@@
RPROJ_WIN='D:\beiming\project\baobian-film'
RPROJ_WSL=/mnt/d/beiming/project/baobian-film
RXFER_WSL=/mnt/d/beiming/transfer
export COPYFILE_DISABLE=1

log() { printf '[%s] %s\n' "$(date +%T)" "$*" >&2; }

# rps '<PowerShell 片段>'：在 5090 上执行，带渲染环境（Vulkan、Chrome、node、ffmpeg），工作目录是工程根；退出码透传
rps() {
  sh "$TOOLS/rps.sh" "\$env:BEIMING_ANGLE='vulkan'; \$env:BEIMING_CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; \$env:Path='C:\\Program Files\\nodejs;D:\\Apps\\FFmpeg\\ffmpeg-9.0.2-full_build\\bin;'+\$env:Path; Set-Location '$RPROJ_WIN'; $1; exit \$LASTEXITCODE"
}

# 目录锁（mkdir 原子）；超过 STALE 秒的锁视为上次异常退出留下的，清掉
lock() {
  L=$1; STALE=${2:-1800}; n=0
  while ! mkdir "$L" 2>/dev/null; do
    if [ -d "$L" ] && [ $(( $(date +%s) - $(stat -f %m "$L") )) -gt "$STALE" ]; then log "清理过期锁 $L"; rmdir "$L" 2>/dev/null || true; continue; fi
    n=$((n + 1)); [ $((n % 6)) -eq 1 ] && log "等锁 $L（别的任务在用）"; sleep 5
  done
}
unlock() { rmdir "$1" 2>/dev/null || true; }

# GPU 利用率（%）
gpu_util() { rps 'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits' 2>/dev/null | tr -dc 0-9; }

# 影片目录名规范化：films/A_shuimo 或 A_shuimo → A_shuimo
film_name() { basename "${1%/}"; }
