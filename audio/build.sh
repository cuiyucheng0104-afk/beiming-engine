#!/bin/sh
# 《北冥》声音一键重建：混音 → 自检（响度 / mux.sh 线性归一化模拟 / 频段 / 提示音是否被盖住 / 画图）
# 用法：sh audio/build.sh            配乐用缓存（与样片逐样本一致）
#       sh audio/build.sh --score    用采样库重渲配乐（需要 BEIMING_SAMPLES）
# 改时间：编辑 audio/cues.json 里各事件的 t（全局秒），再跑本脚本（约 10 秒）。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PYTHON:-python3}
"$PY" "$HERE/mix.py" "$@"
"$PY" "$HERE/check.py" > /dev/null
"$PY" - "$HERE/check/report.json" <<'PYEOF'
import json, sys
r = json.load(open(sys.argv[1], encoding='utf-8'))
e, m = r['ebur128'], r['mux_loudnorm']
print(f"out/mix.wav：{r['format']['seconds']:.3f} s / {r['format']['sr']} Hz / {r['format']['channels']} 声道")
print(f"响度：I {e['I_LUFS']} LUFS · LRA {e['LRA_LU']} LU · 真峰值 {e['TP_dBTP']} dBTP（{m['normalization_type']}）")
print(f"提示音带内信噪比 dB：{r.get('ui_band_snr_db')}")
PYEOF
