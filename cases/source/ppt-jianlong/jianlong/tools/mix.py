"""《见龙》混音：旁白按时间表落位 + 配乐 + 音效（侧链压低）→ −14 LUFS、真峰值 ≤ −1 dBTP。
用法：$LIB/.venv/bin/python tools/mix.py                 → out/mix.wav（全片 194.5 s）
      $LIB/.venv/bin/python tools/mix.py --seg S03      → out/segs/S03_mix.wav（只混这一段，时间从段首起）
规则：
  · 旁白：timeline.json 每段 vo.start 落位，不改速度；先做压缩（峰均比大），再按 RMS 对齐。
  · 配乐：music/score.wav（全片长，作曲负责）；没有就只混旁白和音效并提示。
  · 音效：sfx/Sxx.json，事件 t 为段内秒；由 tools/sfx_kit.py 合成。
  · 侧链：旁白在说话时，音乐压低 DUCK_MUSIC（12 dB），音效压低 DUCK_SFX（5 dB）；起 60 ms、放 450 ms。
  · 母带：先限幅（加增益后峰值 ≤ −4 dBFS），再 ffmpeg 两遍 loudnorm（线性模式）到 −14 LUFS / TP −3.0（给 AAC 编码过冲留余量，成片实测 ≤ −1 dBTP），再实测 ebur128 打印。成片 mux.sh 还会再校一遍。
"""
import json, os, sys, subprocess, re, numpy as np, soundfile as sf, soxr
from scipy.ndimage import uniform_filter1d
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, 'tools'))
import sfx_kit
SR = 48000
WAV = '@@WORKSPACE_ROOT@@/Desktop/见龙/旁白v2/wav'   # 第二版旁白（2026-11-03，音色 Chinese (Mandarin)_Sincere_Adult）；旧版在 旁白/wav
VOICE_RMS_DB = -20.0      # 旁白压缩后的目标 RMS（dBFS，母带前）
MUSIC_DB = -6.0           # 配乐相对旁白的基准电平（未压低时）
DUCK_MUSIC = 12.0         # 旁白下音乐压低 dB（规范 §3）
DUCK_SFX = 5.0            # 旁白下音效压低 dB（规范 §3）
TP_MIX = -3.0             # 混音母带真峰值目标（返修第 12 条：−2.2 → −3.0，并在 loudnorm 前加限幅；AAC 过冲约 +0.6 dB）


def load_mono(p):
    x, sr = sf.read(p, dtype='float32', always_2d=True); x = x.mean(1)
    return soxr.resample(x, sr, SR) if sr != SR else x


def load_stereo(p):
    x, sr = sf.read(p, dtype='float32', always_2d=True)
    if x.shape[1] == 1: x = np.repeat(x, 2, 1)
    return soxr.resample(x[:, :2], sr, SR) if sr != SR else x[:, :2]


def rms_db(x): return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


def comp(x, thr_db=-24, ratio=3.0, win=0.01):
    """向量化的 RMS 压缩（不逐样本循环），给旁白压峰"""
    e = np.sqrt(uniform_filter1d(x ** 2, int(win * SR)) + 1e-12); ed = 20 * np.log10(e)
    gdb = np.where(ed > thr_db, (thr_db + (ed - thr_db) / ratio) - ed, 0.0)
    g = 10 ** (uniform_filter1d(gdb, int(0.02 * SR)) / 20)
    return x * g


def follower(x, att=0.06, rel=0.45):
    """侧链包络 0..1：说话时为 1"""
    e = np.sqrt(uniform_filter1d(x ** 2, int(0.02 * SR)) + 1e-12)
    on = (20 * np.log10(e) > VOICE_RMS_DB - 18).astype(np.float32)
    # 先放后起：用不对称平滑
    out = np.empty_like(on); a, r = 1 / (att * SR), 1 / (rel * SR); v = 0.0
    step = 64
    for i in range(0, len(on), step):
        tgt = on[i:i + step].max(); v += (tgt - v) * min(1, (a if tgt > v else r) * step); out[i:i + step] = v
    return out


def main():
    args = sys.argv[1:]; seg = args[args.index('--seg') + 1] if '--seg' in args else None
    tl = json.load(open(f'{HERE}/data/timeline.json')); segs = tl['segments']
    if seg:
        s = next(x for x in segs if x['seg'] == seg); T0, T1 = s['start'], s['end']; out = f'{HERE}/out/segs/{seg}_mix.wav'
    else:
        T0, T1 = 0.0, tl['total']; out = f'{HERE}/out/mix.wav'
    os.makedirs(os.path.dirname(out), exist_ok=True)
    N = int(round((T1 - T0) * SR))
    voice = np.zeros(N); music = np.zeros((N, 2)); fx = np.zeros((N, 2))
    # 旁白
    for s in segs:
        v = s.get('vo')
        if not v: continue
        x = comp(load_mono(f"{WAV}/{v['id']}.wav")); x *= 10 ** ((VOICE_RMS_DB - rms_db(x[np.abs(x) > 1e-3])) / 20)
        a = int(round((v['start'] - T0) * SR))
        lo, hi = max(0, a), min(N, a + len(x))
        if hi > lo: voice[lo:hi] += x[lo - a:hi - a]
    # 配乐
    sp = f'{HERE}/music/score.wav'
    if os.path.exists(sp):
        m = load_stereo(sp); a = int(round(T0 * SR)); m = m[a:a + N]
        music[:len(m)] = m * 10 ** ((VOICE_RMS_DB + MUSIC_DB - rms_db(m + 1e-9)) / 20) if len(m) else 0
        print('配乐：', sp)
    else:
        print('提示：还没有 music/score.wav，本次只混旁白与音效')
    # 音效
    nev = 0
    for s in segs:
        if s['end'] <= T0 or s['start'] >= T1: continue
        p = f"{HERE}/sfx/{s['seg']}.json"
        if not os.path.exists(p): continue
        for e in json.load(open(p)).get('events', []):
            x = sfx_kit.render(e); a = int(round((s['start'] + e['t'] - T0) * SR))
            lo, hi = max(0, a), min(N, a + len(x))
            if hi > lo: fx[lo:hi] += x[lo - a:hi - a]; nev += 1
    # 侧链
    d = follower(voice)[:, None]
    music *= 10 ** (-DUCK_MUSIC * d / 20); fx *= 10 ** (-DUCK_SFX * d / 20)
    mixd = music + fx + voice[:, None]
    pk = np.abs(mixd).max()
    if pk > 0.98: mixd *= 0.98 / pk
    tmp = out + '.pre.wav'; sf.write(tmp, mixd.astype(np.float32), SR, subtype='FLOAT')
    # 返修第 12 条：先按整轨响度算出 loudnorm 要加的增益，把峰值限在"加增益后 −4.0 dBFS"以下（alimiter，真峰值余量靠 TP 目标 −3.0 再兜），
    # 这样 mux.sh 的线性 loudnorm 几乎不再加增益，AAC 过冲后成片真峰值约 −2 dBTP（原来 −1.3，余量只有 0.3 dB）
    def measure(p):
        m = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', p, '-af', f'loudnorm=I=-14:TP={TP_MIX}:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
        return json.loads(m[m.rindex('{'):m.rindex('}') + 1])
    j = measure(tmp)
    if float(j['input_i']) > -70:
        lim = 10 ** ((-4.0 - (-14.0 - float(j['input_i']))) / 20)
        if lim < 1:
            tmp2 = out + '.lim.wav'
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-af', f'alimiter=limit={lim:.5f}:attack=2:release=60:level=disabled:asc=1', '-c:a', 'pcm_f32le', tmp2], check=True)
            os.replace(tmp2, tmp); j = measure(tmp)
    if float(j['input_i']) < -70:
        os.replace(tmp, out); print('静音，未做响度'); return
    af = (f"loudnorm=I=-14:TP={TP_MIX}:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}"
          f":measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true:print_format=summary")
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-af', af, '-ar', str(SR), '-c:a', 'pcm_s24le', out], check=True)
    os.remove(tmp)
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    I = re.findall(r'I:\s+(-?[\d.]+) LUFS', r)[-1]; TP = re.findall(r'Peak:\s+(-?[\d.]+) dBFS', r)[-1]
    print(f'{out}  {T1 - T0:.2f}s  音效 {nev} 个  响度 {I} LUFS  真峰值 {TP} dBTP')
    if abs(float(I) + 14) > 1 or float(TP) > -1: print('警告：响度或真峰值不合格（目标 −14±1 LUFS，≤ −1 dBTP）')


if __name__ == '__main__':
    main()
