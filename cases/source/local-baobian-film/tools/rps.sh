#!/bin/sh
# 在 ROG 5090 上执行一段 PowerShell（UTF-8 输出，经 -EncodedCommand 传入，避免 cmd 吃引号）
# 用法：rps.sh '脚本'  或  rps.sh < 脚本.ps1（脚本较长时请 scp .ps1 后用 -File 执行）
S="${1:-$(cat)}"
P='[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference="SilentlyContinue"; '"$S"
B=$(printf '%s' "$P" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
exec ssh -o IdentitiesOnly=yes -o ConnectTimeout=10 -i ~/.ssh/id_ed25519 ROG@@@ROG_HOST@@ "powershell -NoProfile -NonInteractive -EncodedCommand $B"
