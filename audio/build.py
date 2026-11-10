# -*- coding: utf-8 -*-
"""《北冥》声音一键重建（跨平台入口；sh audio/build.sh 转到这里）：混音 → 门禁自检 → 打印结论。

用法（任何终端，包括 Windows PowerShell）：
  python audio/build.py                     配乐读定稿缓存（与样片逐样本一致）→ 门禁自检
  python audio/build.py --score             用采样库重渲配乐（需要 BEIMING_SAMPLES 或 audio/samples/；取样：node tools/audio/fetch-samples.mjs）
  python audio/build.py --accept-stale-score   配乐缓存与当前乐谱对不上时仍用旧配乐（会记进 render.json）
  python audio/build.py --no-strict         只跑旧口径自检（problems 非空退出 1），不做门禁
  python audio/build.py --help              本说明（不写盘）
改时间：编辑 audio/cues.json 里各事件的 t（全局秒）和镜头切点，再跑本脚本（约 10 秒）。配乐（layer = music 的事件）例外：
        配乐的时间写在 audio/score.py，要改就改那里再加 --score。
门禁（audio/check.py --strict）：混音格式与长度、积分响度 −14 ± 0.5 LUFS（audio/cues.json 的 target 与 qa 段）、真峰值、满幅、直流、
        单声道兼容、首尾、切点爆音、经 engine/render/mux.sh 封装后的成片响度、眼镜提示音带内信噪比、分轨削波；逐项写进
        audio/check/qa.json（附录 C8），硬项不达标退出码 4。
退出码（附录 C1）：0 通过；2 用法错误；3 缺依赖（ffmpeg、numpy 等）或缺输入；4 门禁不通过或配乐缓存与输入不一致；1 运行失败。
解释器：用运行本脚本的那个 Python 跑 mix.py 与 check.py（sh audio/build.sh 用 $PYTHON，默认 python3）。
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MIX_FLAGS = ('--score', '--accept-stale-score')
OWN = ('--no-strict', '-h', '--help')


def main(argv):
    if '-h' in argv or '--help' in argv:
        print(__doc__.strip())
        return 0
    bad = [a for a in argv if a not in MIX_FLAGS + OWN]
    if bad:
        print(f'错误[usage.unknown-option]：不认识的参数：{" ".join(bad)}\n提示：可用 --score、--accept-stale-score、--no-strict、--help', file=sys.stderr)
        return 2
    strict = '--no-strict' not in argv
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    py = sys.executable
    r = subprocess.run([py, os.path.join(HERE, 'mix.py')] + [a for a in argv if a in MIX_FLAGS], cwd=ROOT, env=env)
    if r.returncode != 0:
        print(f'混音没跑完（mix.py 退出码 {r.returncode}）：原因见上面的输出', file=sys.stderr)
        return r.returncode if r.returncode in (2, 3, 4, 130, 143) else 1
    rc = subprocess.run([py, os.path.join(HERE, 'check.py')] + (['--strict'] if strict else []), cwd=ROOT, env=env,
                        stdout=None if strict else subprocess.DEVNULL).returncode
    rep_path = os.path.join(HERE, 'check', 'report.json')
    if not os.path.exists(rep_path):
        print(f'自检中途出错（退出码 {rc}），没有写出 audio/check/report.json', file=sys.stderr)
        return rc or 1
    with open(rep_path, encoding='utf-8') as f:
        r = json.load(f)
    e, d = r['ebur128'], r.get('deliverable', {})
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
    if strict and rc in (0, 4):
        g = r.get('gate', {})
        print(f"门禁：{'通过' if g.get('ok') else '没通过（' + '、'.join(g.get('hardFailures', [])) + '）'}，逐项见 "
              f"{os.path.relpath(g.get('report', ''), ROOT).replace(os.sep, '/')}")
    return rc


if __name__ == '__main__':
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    sys.exit(main(sys.argv[1:]))
