#!/bin/zsh
# 一键流水线：从源码重建 → 门禁验证 → 运动曲线；加 render 再出成片和左右对比视频。
#   ./run.sh            重建 + 验证 + 曲线（约 1 分钟）
#   ./run.sh render     再渲染 241 帧，合成 out/previs_whitebox.mp4 与 out/compare_side_by_side.mp4
# 任何一步失败（含门禁不达标）都以非 0 退出。
set -e
setopt pipefail                 # 管道里 Blender 失败不能被 grep 吞掉
cd ${0:A:h}
B=/Applications/Blender.app/Contents/MacOS/Blender
PY=python3.14

[[ -f data/timebase_24.json && -d ref/frames24 ]] || $PY decimate.py

echo "== 1/3 重建场景"
$B -b --factory-startup --python-exit-code 1 -P build.py -- --save out/previs.blend 2>&1 | grep -E "^\[physics\]|saved|Error|Traceback"
echo "== 2/3 门禁验证"
$B -b out/previs.blend --python-exit-code 1 -P verify.py 2>&1 | grep -E "中位|物理|VERIFY"
echo "== 3/3 运动曲线 → out/motion_curve.png"
$PY motion_chart.py

if [[ "$1" == "render" ]]; then
  echo "== 渲染 → out/frames24/（同名覆盖）"
  $B -b out/previs.blend -o //frames24/f_#### -F PNG -a >/dev/null 2>&1
  N=$(ls out/frames24/f_0*.png | wc -l | tr -d ' ')
  [[ $N == $($PY -c "import calib; print(calib.FRAMES)") ]] || { echo "渲染帧数 $N 不对"; exit 1; }
  ffmpeg -v error -y -framerate 24 -i out/frames24/f_%04d.png -c:v libx264 -pix_fmt yuv420p -crf 18 out/previs_whitebox.mp4
  ffmpeg -v error -y -i ref/reference24.mp4 -i out/previs_whitebox.mp4 \
    -filter_complex "[0:v]crop=784:448:88:0[a];[a][1:v]hstack=inputs=2[v]" -map "[v]" -map "0:a?" \
    -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a aac out/compare_side_by_side.mp4
  echo "成片 out/previs_whitebox.mp4，对比 out/compare_side_by_side.mp4"
fi
echo "== 全部通过"
