#!/bin/sh
# 一条命令重建《懂你的人》故事介绍片（旁白已在 旁白/wav，重配音见 tools/minimax_tts.py）
LIB=$HOME/lemo-opuscar
cd "$(dirname "$0")/film" && rm -rf out/frames && "$LIB/.venv/bin/python" build.py all
