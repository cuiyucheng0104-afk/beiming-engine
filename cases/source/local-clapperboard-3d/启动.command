#!/bin/bash
# 双击本文件即可在本地预览「电影场记板 3D」。关闭此终端窗口即停止服务器。
cd "$(dirname "$0")" || exit 1
PORT=8000
echo "正在启动本地预览服务器 (端口 $PORT)…"
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1
open "http://localhost:$PORT/index.html"
echo ""
echo "已在浏览器打开:  http://localhost:$PORT/index.html"
echo "需要联网加载 three.js (CDN)。"
echo "按 Ctrl+C 或关闭此窗口即可停止。"
echo ""
wait $SERVER_PID
