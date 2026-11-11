#!/bin/sh
# 《北冥》声音一键重建：混音 → 门禁自检（响度 / 真的跑一遍 mux.sh 测成片响度 / 频段 / 提示音是否被盖住 / 环境声空洞 / 画图）
# 用法：sh audio/build.sh            配乐用缓存（与样片逐样本一致）
#       sh audio/build.sh --score    用采样库重渲配乐（需要 BEIMING_SAMPLES 或 audio/samples/；取样：node tools/audio/fetch-samples.mjs）
#       sh audio/build.sh --accept-stale-score   配乐缓存与当前乐谱对不上时仍用旧配乐（记进 render.json）
#       sh audio/build.sh --no-strict             只跑旧口径自检（problems 非空退出 1）
#       sh audio/build.sh --help                  完整说明（不写盘）
# 改时间：编辑 audio/cues.json 里各事件的 t（全局秒）和镜头切点，再跑本脚本（约 10 秒）。
#         配乐（layer = music 的事件）例外：配乐的时间写在 audio/score.py，要改就改那里再加 --score。
# 门禁没通过时打印逐项原因（audio/check/qa.json）并以退出码 4 结束；配乐缓存与乐谱对不上也是 4；缺依赖 3。
# 实现在 audio/build.py；解释器由 tools/env/py.mjs 选（PYTHON / BEIMING_PY / .venv / python3 …，与 npm 脚本同一个）。
# 不需要 sh 的写法（Windows PowerShell 也一样）：node tools/audio/build.mjs，或 node tools/env/py.mjs audio/build.py
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
exec node "$HERE/../tools/env/py.mjs" "$HERE/build.py" "$@"
