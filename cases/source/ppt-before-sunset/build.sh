#!/bin/sh
# 一条命令重建《日落之前》故事介绍片（配音在 配音/wav，配乐在 音乐/；重配音：python3 tools/minimax_tts.py 配音/lines.json 配音/wav --force --only id1,id2）
# 成片出完后移到 ~/Desktop/上影ppt/（覆盖旧版）
cd "$(dirname "$0")/film" && rm -rf out/frames && /usr/local/bin/python3 build.py all &&
  mv -f ../日落之前_故事介绍.mp4 ../日落之前_故事介绍_手机版.mp4 ../日落之前_故事介绍.srt "$HOME/Desktop/上影ppt/"
