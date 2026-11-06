#!/bin/zsh
# 一键流水线：装配时间轴 → 从源码重建场景 → 门禁验证；加 render 再出成片和左右对比视频。
#   ./run.sh            装配 + 重建 + 验证
#   ./run.sh render     再渲染 646 帧，合成 out/previs_whitebox.mp4 与 out/compare_side_by_side.mp4
# 逐镜头求解（solve_shot.py）较慢，不在这里跑；改了读点后单独跑：python3.14 solve_shot.py S21 …
set -e
setopt pipefail
cd ${0:A:h}
B=/Applications/Blender.app/Contents/MacOS/Blender
PY=/opt/homebrew/bin/python3.14

echo "== 1/3 装配时间轴与相机"
$PY timeline.py | grep -E "作弊量|^  S|缺相机"
$PY fit_pose.py | tail -1
echo "== 2/3 重建场景"
$B -b --factory-startup --python-exit-code 1 -P build.py -- --save out/previs.blend 2>&1 | grep -E "saved|Error|Traceback"
echo "== 3/3 门禁验证"
$B -b out/previs.blend --python-exit-code 1 -P verify.py 2>&1 | grep -E "^ S|镜头|全片|VERIFY"
echo "== 穿模检查（只报告）"
$B -b out/previs.blend -P check_clip.py 2>&1 | grep -E "^ S|CLIP" || true

if [[ "$1" == "render" ]]; then
  echo "== 渲染 → out/frames24/（同名覆盖）"
  $B -b out/previs.blend -o //frames24/f_#### -F PNG -a >/dev/null 2>&1
  N=$(ls out/frames24/f_0*.png | wc -l | tr -d ' ')
  [[ $N == $($PY -c "import calib; print(calib.FRAMES)") ]] || { echo "渲染帧数 $N 不对"; exit 1; }
  ffmpeg -v error -y -framerate 24 -i out/frames24/f_%04d.png -c:v libx264 -pix_fmt yuv420p -crf 18 out/previs_whitebox.mp4
  ffmpeg -v error -y -i ref/reference24.mp4 -i out/previs_whitebox.mp4 \
    -filter_complex "[0:v][1:v]hstack=inputs=2[v]" -map "[v]" -map "0:a?" \
    -c:v libx264 -pix_fmt yuv420p -crf 20 -c:a aac out/compare_side_by_side.mp4
  echo "成片 out/previs_whitebox.mp4，对比 out/compare_side_by_side.mp4"
fi
echo "== 全部通过"
