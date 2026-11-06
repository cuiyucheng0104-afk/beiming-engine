#!/bin/bash
# 一键重建成片：帧 + 混音 + 合成（约 6 分钟）
cd "$(dirname "$0")/film" && rm -rf out/frames && /usr/local/bin/python3 build.py all
