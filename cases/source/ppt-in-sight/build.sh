#!/bin/sh
# 一条命令重建《IN SIGHT 目之所及》故事介绍片（配音已在 配音/wav；重配音：python3 tools/minimax_tts.py 配音/lines.json 配音/wav --force）
cd "$(dirname "$0")/film" && rm -rf out/frames && /usr/local/bin/python3 build.py all
