#!/bin/sh
# 北冥引擎 · 重建《北冥》10 秒样片（兼容壳）：转调统一出片命令，不再自己拼管线。
#   sh build.sh                 1920×1040（档位 beiming-1040p24）
#   sh build.sh --4k            3840×2080 原生 4K
#   sh build.sh --no-audio      沿用 out/mix.wav
#   sh build.sh --json          stdout 只输出统一出片命令的 JSON 信封
#   sh build.sh --help          只打印用法
# 实际做的事在 tools/film/beiming.mjs：node tools/film/cli.mjs build films/beiming-10s --page . --out-root out/beiming
#   --profile beiming-1040p24 --audio audio/build.sh；产物与 run.json、QA 报告在 out/beiming/<run-id>/，
#   再按旧文件名复制到 out/（video[_4k].mp4、beiming[_4k].mp4、beiming_web.mp4、beiming.html、contact_sheet.jpg、mix.wav）。
# 新作品不要用这个脚本：npm run new -- <a|b|c> <名字> 建作品，再 npm run film -- build films/<名字>。
# Windows（PowerShell）不用经过 sh：node tools/film/beiming.mjs（或 npm run beiming:build），参数相同。
# 环境变量：WORKERS / WORKERS_4K（并行路数）、PYTHON（装了 requirements.txt 的 Python）、BEIMING_ANGLE / BEIMING_CHROME / BEIMING_READY_TIMEOUT。
# 退出码与统一出片命令相同：0 成功 · 1 运行失败 · 2 用法错误 · 3 缺环境 · 4 契约 / QA 不通过 · 5 被占用 · 124 超时 · 130/143 中断。
# 参数与 WORKERS 在这里先查一遍（不用起 Node 就能报用法错误），tools/film/beiming.mjs 里还会再查。
# 换行应当是 LF。万一按 CRLF 检出（Windows 上 Git 默认 core.autocrlf=true），下面两行去掉 CR 后原样重跑本脚本：
#   第一行的赋值在 CRLF 下会把 CR 带进值里；第二行以 # 结尾，多出来的 CR 落进注释，所以它在 CRLF 下照样能执行。
_lf=1
[ "$_lf" = 1 ] || { [ -r "$0" ] && echo "[提示] $0 是 CRLF 换行：已去掉 CR 后运行（建议按 LF 重新检出）" >&2 && exec sh -c "$(tr -d '\r' < "$0")" "$0" "$@"; echo "$0 是 CRLF 换行，读不到脚本文件去掉 CR：请按 LF 检出（git config core.autocrlf false 后重新检出）" >&2; exit 2; } #
FOURK=0
for a in "$@"; do
  case "$a" in
    --4k) FOURK=1 ;;
    --no-audio|--json|--help|-h) ;;
    *) echo "不认识的参数：${a}（可用：--4k --no-audio --json --help）" >&2; exit 2 ;;
  esac
done
if [ -n "${WORKERS:-}" ]; then _w=$WORKERS; elif [ "$FOURK" = 1 ]; then _w=${WORKERS_4K:-8}; else _w=4; fi
case "$_w" in ''|*[!0-9]*|0) echo "WORKERS / WORKERS_4K 必须是正整数（收到 ${_w}）" >&2; exit 2 ;; esac
ROOT=$(cd "$(dirname "$0")" && pwd) || exit 1
command -v node >/dev/null 2>&1 || { echo "找不到 node：先安装 Node.js ≥ 22（见 README 的环境要求）" >&2; exit 3; }
exec node "$ROOT/tools/film/beiming.mjs" "$@"
