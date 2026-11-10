#!/bin/sh
# 北冥引擎 · 音画封装（兼容壳）：sh engine/render/mux.sh video.mp4 mix.wav out.mp4 [fps] [grain] [选项…]
# 实现在 engine/render/lib/mux.mjs（Node，Windows 上不需要 sh：直接 node engine/render/lib/mux.mjs …）。参数原样转交，
# 退出码、输出与选项（--frames、--profile、--aigc、--json、--help …）都以 mux.mjs 为准，见 engine/render/README.md「封装」。
# 用 PATH 里的 node（与 build.sh 调 still.mjs、video.mjs 时相同）。
# 换行应当是 LF。万一按 CRLF 检出（Windows 上 Git 默认 core.autocrlf=true），下面两行去掉 CR 后原样重跑本脚本：
#   第一行的赋值在 CRLF 下会把 CR 带进值里；第二行以 # 结尾，多出来的 CR 落进注释，所以它在 CRLF 下照样能执行。
_lf=1
[ "$_lf" = 1 ] || { [ -r "$0" ] && echo "[提示] $0 是 CRLF 换行：已去掉 CR 后运行（建议按 LF 重新检出）" >&2 && exec sh -c "$(tr -d '\r' < "$0")" "$0" "$@"; echo "$0 是 CRLF 换行，读不到脚本文件去掉 CR：请按 LF 检出（git config core.autocrlf false 后重新检出）" >&2; exit 2; } #
HERE=$(cd "$(dirname "$0")" && pwd) || exit 2
[ -f "$HERE/lib/mux.mjs" ] || { echo "mux.sh：找不到 $HERE/lib/mux.mjs（engine/render 不完整）" >&2; exit 3; }
exec node "$HERE/lib/mux.mjs" "$@"
