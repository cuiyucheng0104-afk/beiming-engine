#!/bin/sh
# 《北冥》声音一键重建：混音 → 自检（响度 / 真的跑一遍 mux.sh 测成片响度 / 频段 / 提示音是否被盖住 / 环境声空洞 / 画图）
# 用法：sh audio/build.sh            配乐用缓存（与样片逐样本一致）
#       sh audio/build.sh --score    用采样库重渲配乐（需要 BEIMING_SAMPLES）
# 改时间：编辑 audio/cues.json 里各事件的 t（全局秒）和镜头切点，再跑本脚本（约 10 秒）。
#         配乐（layer = music 的事件）例外：配乐的时间写在 audio/score.py，要改就改那里再加 --score。
# 自检没通过（成片响度离目标超过 ±0.3 LU、真峰值高于 −1.0 dBTP、mux.sh 跑不通或跑不了、格式不对）时，打印原因并以非零退出。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PYTHON:-python3}
"$PY" "$HERE/mix.py" "$@"
RC=0
"$PY" "$HERE/check.py" > /dev/null || RC=$?
[ -f "$HERE/check/report.json" ] || { echo "自检中途出错（退出码 ${RC}），没有写出 audio/check/report.json" >&2; [ "$RC" -ne 0 ] || RC=1; exit "$RC"; }
"$PY" - "$HERE/check/report.json" <<'PYEOF'
import json, sys
r = json.load(open(sys.argv[1], encoding='utf-8'))
e, m, d = r['ebur128'], r['mux_loudnorm'], r.get('deliverable', {})
print(f"out/mix.wav：{r['format']['seconds']:.3f} s / {r['format']['sr']} Hz / {r['format']['channels']} 声道")
print(f"混音响度：I {e['I_LUFS']} LUFS · LRA {e['LRA_LU']} LU · 真峰值 {e['TP_dBTP']} dBTP")
if 'error' in d:
    print(f"成片响度（经 mux.sh）：测不了：{d['error']}")
else:
    i = d.get('I_internal', d.get('I_LUFS'))
    print(f"成片响度（经 mux.sh）：I {i} LUFS · 真峰值 {d.get('TP_dBTP')} dBTP"
          f"（目标 {d.get('target_I')} ±{d.get('tol_LU')} LU、真峰值 ≤ {d.get('max_TP')} dBTP：{'通过' if d.get('ok') else '没通过'}）")
print(f"提示音带内信噪比 dB：{r.get('ui_band_snr_db')}")
for w in r.get('warnings', []):
    print('告警：' + w)
for p in r.get('problems', []):
    print('没通过：' + p)
PYEOF
exit "$RC"
