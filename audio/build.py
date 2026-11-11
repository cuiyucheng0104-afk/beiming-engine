# -*- coding: utf-8 -*-
"""《北冥》声音一键重建（跨平台入口）：混音 → 门禁自检 → 打印结论。sh audio/build.sh 与 node tools/audio/build.mjs 都转到这里。

用法（任何终端，包括 Windows PowerShell；解释器由 node tools/env/py.mjs 选，与 npm 脚本同一个）：
  node tools/env/py.mjs audio/build.py                        配乐读定稿缓存（与样片逐样本一致）→ 门禁自检
  node tools/env/py.mjs audio/build.py --score                用采样库重渲配乐（需要 BEIMING_SAMPLES 或 audio/samples/；
                                                              取样：node tools/audio/fetch-samples.mjs）
  node tools/env/py.mjs audio/build.py --accept-stale-score   配乐缓存与当前乐谱对不上时仍用旧配乐（会记进 render.json）
  node tools/env/py.mjs audio/build.py --no-strict            只跑旧口径自检（problems 非空退出 1），不做门禁
  node tools/env/py.mjs audio/build.py --json                 stdout 只输出一个信封（附录 C2）；混音与自检的日志走 stderr
改时间：编辑 audio/cues.json 里各事件的 t（全局秒）和镜头切点，再跑本脚本（约 10 秒）。配乐（layer = music 的事件）例外：
        配乐的时间写在 audio/score.py，要改就改那里再加 --score。
门禁（audio/check.py --strict）：混音格式与长度、积分响度 −14 ± 0.5 LUFS（audio/cues.json 的 target 与 qa 段）、真峰值、满幅、直流、
        单声道兼容、首尾、切点爆音、经 engine/render/mux.sh 封装后的成片响度、眼镜提示音带内信噪比、分轨削波；逐项写进
        audio/check/qa.json（附录 C8），硬项不达标退出码 4。
退出码（附录 C1）：0 通过；2 用法错误；3 缺依赖（numpy 等 Python 包、ffmpeg）或缺输入；4 门禁不通过或配乐缓存与输入不一致；
        1 运行失败；130 / 143 被中断（子进程一并结束）。
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from engine.audio import _cli, _env as E  # noqa: E402

MIX_WAV = os.path.join(ROOT, 'out', 'mix.wav')
REPORT = os.path.join(HERE, 'check', 'report.json')
QA = os.path.join(HERE, 'check', 'qa.json')
DEPS = ('numpy', 'scipy', 'soundfile', 'numba', 'soxr', 'PIL')


def make_parser():
    p = _cli.ArgumentParser(prog='python audio/build.py', description='《北冥》声音一键重建：混音 → 门禁自检。退出码：0 通过；2 用法；'
                            '3 缺依赖或缺输入；4 门禁不通过或配乐缓存与输入不一致；1 运行失败。')
    p.add_argument('--score', action='store_true', help='用采样库重渲配乐（需要 BEIMING_SAMPLES 或 audio/samples/）')
    p.add_argument('--accept-stale-score', action='store_true', help='配乐缓存与当前乐谱对不上时仍用旧配乐（记进 render.json）')
    p.add_argument('--no-strict', action='store_true', help='只跑旧口径自检（problems 非空退出 1），不做门禁')
    return p


def _missing_deps():
    out = []
    for m in DEPS:
        try:
            __import__(m)
        except ImportError:
            out.append(m)
    return out


def _run(cmd, ctx, capture=False):
    """起一个子进程（同一个解释器）。被中断时（Ctrl+C；SIGTERM 由 cli.run 变成异常；或任何异常）E.run 先结束子进程和它起的
    ffmpeg / sh、等它们退出，再把异常交给 cli.run 收尾（130 / 143）：不留下还在改写 out/mix.wav、audio/check/ 的孤儿进程"""
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    # --json 时子进程的 stdout 也不能进本命令的 stdout（那里只能有一个信封）：混音日志改走 stderr
    out = subprocess.PIPE if capture else (sys.stderr if ctx.json else None)
    r = E.run(cmd, cwd=ROOT, env=env, stdout=out, encoding='utf-8' if capture else None)
    return r.returncode, r.stdout


def main(args, ctx):
    miss = _missing_deps()
    if miss:
        raise _cli.CliError('env.python-deps', f'当前 Python（{sys.executable}）缺 {"、".join(miss)}',
                            hint='npm run setup（建仓库 .venv），或 pip install -r requirements.txt；指定解释器用 PYTHON=<路径>')
    mix_flags = [f for f, on in (('--score', args.score), ('--accept-stale-score', args.accept_stale_score)) if on]
    ctx.log('== 混音（audio/mix.py' + (' ' + ' '.join(mix_flags) if mix_flags else '') + '）')
    rc, _ = _run([sys.executable, os.path.join(HERE, 'mix.py')] + mix_flags, ctx)
    if rc != 0:
        code = rc if rc in (2, 3, 4, 130, 143) else 1
        what = '配乐缓存与当前输入不一致' if rc == 4 else f'混音没跑完（mix.py 退出码 {rc}）'
        return {'exitCode': code, 'error': {'code': 'contract.score-cache' if rc == 4 else 'failure.mix', 'message': what,
                                            'hint': '原因见上面 [mix] 的输出' + ('；重渲配乐加 --score，确认沿用旧配乐加 --accept-stale-score' if rc == 4 else '')}}
    strict = not args.no_strict
    ctx.log('== 自检（audio/check.py' + (' --strict）' if strict else '）'))
    check_cmd = [sys.executable, os.path.join(HERE, 'check.py')] + (['--strict'] if strict else [])
    gate_env = None
    if strict and ctx.json:
        rc, so = _run(check_cmd + ['--json'], ctx, capture=True)
        try:
            gate_env = json.loads(so)
        except ValueError:
            gate_env = None
    elif strict:
        rc, _ = _run(check_cmd, ctx)
    else:
        rc, _ = _run(check_cmd, ctx, capture=True)          # 旧口径会把整份报告打到 stdout：这里不转出
    if not os.path.exists(REPORT):
        return {'exitCode': rc or 1, 'error': {'code': 'env.check' if rc == 3 else 'failure.check', 'message': f'自检中途出错（退出码 {rc}），没有写出 audio/check/report.json',
                                               'hint': '原因见上面 [check] 的输出；缺 ffmpeg 时装 FFmpeg ≥ 7 或设 FFMPEG 为完整路径'}}
    with open(REPORT, encoding='utf-8') as f:
        r = json.load(f)
    e, d = r['ebur128'], r.get('deliverable', {})
    lines = [f"out/mix.wav：{r['format']['seconds']:.3f} s / {r['format']['sr']} Hz / {r['format']['channels']} 声道",
             f"混音响度：I {e['I_LUFS']} LUFS · LRA {e['LRA_LU']} LU · 真峰值 {e['TP_dBTP']} dBTP"]
    if 'error' in d:
        lines.append(f"成片响度（经 mux.sh）：测不了：{d['error']}")
    else:
        i = d.get('I_internal', d.get('I_LUFS'))
        lines.append(f"成片响度（经 mux.sh）：I {i} LUFS · 真峰值 {d.get('TP_dBTP')} dBTP"
                     f"（目标 {d.get('target_I')} ±{d.get('tol_LU')} LU、真峰值 ≤ {d.get('max_TP')} dBTP：{'通过' if d.get('ok') else '没通过'}）")
    lines.append(f"提示音带内信噪比 dB：{r.get('ui_band_snr_db')}")
    lines += ['告警：' + w for w in r.get('warnings', [])] + ['没通过：' + p for p in r.get('problems', [])]
    g = r.get('gate', {})
    if strict and rc in (0, 4):
        lines.append(f"门禁：{'通过' if g.get('ok') else '没通过（' + '、'.join(g.get('hardFailures', [])) + '）'}，逐项见 audio/check/qa.json")
    for ln in lines:
        ctx.out(ln)
    outputs = [{'path': 'out/mix.wav', 'sha256': _cli.sha256_file(MIX_WAV), 'kind': 'audio'}] if os.path.exists(MIX_WAV) else []
    outputs.append({'path': 'audio/check/report.json', 'sha256': _cli.sha256_file(REPORT), 'kind': 'report'})
    if strict and os.path.exists(QA):
        outputs.append({'path': 'audio/check/qa.json', 'sha256': _cli.sha256_file(QA), 'kind': 'qa-report'})
    data = {'mix': {'seconds': r['format']['seconds'], 'integratedLUFS': e['I_LUFS'], 'truePeakDbTP': e['TP_dBTP'], 'lraLU': e['LRA_LU']},
            'deliverable': {k: d.get(k) for k in ('I_internal', 'TP_dBTP', 'ok', 'error') if k in d},
            'gate': {'strict': strict, 'ok': g.get('ok') if strict else None, 'hardFailures': g.get('hardFailures', []) if strict else [],
                     'report': 'audio/check/qa.json' if strict else None},
            'warnings': r.get('warnings', []), 'problems': r.get('problems', [])}
    if gate_env and gate_env.get('data'):
        data['gate']['summary'] = gate_env['data'].get('summary')
    if rc == 0:
        return {'data': data, 'outputs': outputs}
    if strict and rc == 4:
        return {'data': data, 'outputs': outputs, 'error': {'code': 'contract.audio-gate', 'message': '声音门禁没通过：' + '、'.join(g.get('hardFailures', [])),
                                                            'hint': '逐项原因与下一步见 audio/check/qa.json 的 checks[].message / hint'}}
    if not strict:
        return {'exitCode': rc, 'data': data, 'outputs': outputs,
                'error': {'code': 'failure.check', 'message': '旧口径自检没通过：' + '；'.join(r.get('problems', [])[:3]), 'hint': '见 audio/check/report.json'}}
    return {'exitCode': rc, 'data': data, 'outputs': outputs,
            'error': {'code': 'env.check' if rc == 3 else 'failure.check', 'message': f'自检退出码 {rc}', 'hint': '原因见上面 [check] 的输出'}}


if __name__ == '__main__':
    E.utf8_stdio()
    sys.exit(_cli.run(main, make_parser(), command='audio:build'))
