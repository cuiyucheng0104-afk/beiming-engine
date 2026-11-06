#!/bin/sh
# 打印 0.25 s 一格的瞬时响度（M，400 ms 窗）
ffmpeg -nostats -i "$1" -af ebur128=metadata=1,ametadata=print:key=lavfi.r128.M -f null - 2>&1 | grep -E "pts_time|r128.M" | paste - - | awk '{split($0,a,"pts_time:"); split(a[2],b," "); split($0,c,"M="); printf "%.2f %.1f\n", b[1], c[2]}'
