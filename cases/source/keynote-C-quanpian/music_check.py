"""music.wav 自检（作曲自用）：时长 / 采样率 / 削波 / 20 s 前为零 / 静默拍真静 / 每小节第一拍的起音（librosa 起音检测）/
最强拍是不是全片最强 / 各章响度（BS.1770 短时）/ 低频占比 / 与开头配乐在 20 s 两侧的电平衔接。
用法：$LIB/.venv/bin/python music_check.py [music.wav] [开头分轨目录（可选：含 drums/music/lead.wav）]
退出码：0 = 全部通过；1 = 有不通过项"""
import os, sys, json
import numpy as np, soundfile as sf, librosa
from scipy.signal import sosfilt, butter
HERE = os.path.dirname(os.path.abspath(__file__))
P = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'music.wav')
x, sr = sf.read(P, dtype='float32', always_2d=True)
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
def bt(bar, beat=1): return (bar - 1) * 2 + (beat - 1) * .5
SIL = next(e for e in EV if e['type'] == 'silence' and e.get('chap') == 'ch4'); S0, S1 = SIL['t'], SIL['until']
PEAK = next(e['t'] for e in EV if e['type'] == 'peak')
CLOSE = next(e['t'] for e in EV if e['type'] == 'book_close')
fails = []
def ok(cond, msg):
    print(('  通过  ' if cond else '  不通过 ') + msg)
    if not cond: fails.append(msg)

print('== 规格')
ok(sr == 48000 and x.shape[1] == 2, f'采样率 {sr} Hz、{x.shape[1]} 声道')
ok(abs(len(x) / sr - 180.0) < 1e-6, f'时长 {len(x) / sr:.6f} s（{len(x)} 采样）')
ok(np.isfinite(x).all(), '无 NaN / Inf')
pk = float(np.abs(x).max()); ok(pk < 1.0, f'峰值 {20 * np.log10(pk):.2f} dBFS，削波采样 {int((np.abs(x) >= 1).sum())} 个')
ok(float(np.abs(x[:20 * sr]).max()) == 0, '0–20 s 全零（开头的配乐在原混音里）')
sil = x[int(S0 * sr):int(S1 * sr) - int(.004 * sr)]
ok(float(np.abs(sil).max()) == 0, f'静默拍 {S0:.3f}–{S1:.3f} s：最大值 {float(np.abs(sil).max()):.2e}（含混响尾巴）')
tail = x[int(179.9 * sr):]; ok(float(np.abs(x[-int(.005 * sr):]).max()) == 0, f'片尾最后 5 ms 为零，179.9 s 后峰值 {20 * np.log10(np.abs(tail).max() + 1e-12):.1f} dBFS')

print('== 拍点网格（每小节第一拍；两种起音检测，容差 ±20 ms）')
mono = x.mean(1); y = librosa.resample(mono, orig_sr=sr, target_sr=22050); HOP = 64; FR = 22050 / HOP
# (1) librosa 谱通量起音 + 回溯到能量起点（onset_detect backtrack=True）：每个第一拍附近有没有检出的起音
oenv = librosa.onset.onset_strength(y=y, sr=22050, hop_length=HOP)
rmsf = librosa.feature.rms(y=y, frame_length=256, hop_length=HOP)[0]
pk_ = librosa.onset.onset_detect(onset_envelope=oenv, sr=22050, hop_length=HOP, backtrack=False, delta=.02, wait=8)
on = librosa.frames_to_time(librosa.onset.onset_backtrack(pk_, rmsf), sr=22050, hop_length=HOP)
# (2) 时域能量起音：2 ms 帧对数能量，第一拍 ±20 ms 内最陡的上升点，且上升后 15 ms 比上升前 20 ms 高 ≥ 3 dB
f2 = int(.002 * sr); E = np.log10(np.add.reduceat(mono ** 2, np.arange(0, len(mono), f2)) / f2 + 1e-12) * 10
miss = []; offs = []; offs2 = []
for bar in range(11, 90):
    t = bt(bar)
    d = on - t; i = int(np.argmin(np.abs(d))); o1 = float(d[i]) * 1000
    k0 = int(t * sr / f2); w = 10
    rs = [E[k:k + 5].mean() - E[k - 8:k - 1].mean() for k in range(k0 - w, k0 + w + 1)]   # 起点之后 10 ms 对之前 14 ms 的能量差
    j = int(np.argmax(rs)); kk = k0 - w + j; rise = float(rs[j]); o2 = (kk - k0) * f2 / sr * 1000
    offs.append(o1); offs2.append(o2)
    good = (abs(o1) <= 20) or (abs(o2) <= 20 and rise >= 3)
    if not good: miss.append((bar, round(o1, 1), round(o2, 1), round(float(rise), 1)))
offs = np.array(offs); offs2 = np.array(offs2)
print(f'  (1) librosa 起音（回溯）：79 个第一拍里 {int((np.abs(offs) <= 20).sum())} 个在 ±20 ms 内，偏差中位 {np.median(offs[np.abs(offs) <= 20]):+.1f} ms')
print(f'  (2) 时域能量起音：偏差中位 {np.median(offs2):+.1f} ms，最大 |{np.abs(offs2).max():.1f}| ms')
ok(not miss, f'每小节第一拍都有起音（两种检测都没检出的：{miss or "无"}）')
# 反证：拍点网格之外（每拍中间的位置不算）不应出现比第一拍更强的系统性偏移 —— 用全频包络的节拍相位直方图
e = oenv; ph = (np.arange(len(e)) / FR) % .5
hist = [float(e[(ph >= a_) & (ph < a_ + .0125) & (np.arange(len(e)) / FR > 20)].mean()) for a_ in np.arange(0, .5, .0125)]
k = int(np.argmax(hist)); print(f'  起音包络按拍相位折叠：最强相位 = 拍后 {k * 12.5:.1f}–{k * 12.5 + 12.5:.1f} ms（应在 0 附近）')
ok(k <= 1 or k >= 39, '能量集中在拍点上（相位 0 ±12.5 ms）')

print('== 能量（400 ms 短时 RMS，dBFS）')
w = int(.4 * sr); hop = int(.05 * sr)
e2 = (x ** 2).mean(1); cs = np.r_[0, np.cumsum(e2)]
st = np.array([(cs[i + w] - cs[i]) / w for i in range(0, len(e2) - w, hop)]); tst = np.arange(len(st)) * hop / sr
db = 10 * np.log10(st + 1e-12)
im = int(np.argmax(db)); ok(PEAK - .05 <= tst[im] <= PEAK + .4, f'全片最强的 400 ms 窗起点在 {tst[im]:.2f} s（{db[im]:.1f} dBFS）；最强拍 = {PEAK} s')
CH = [('二 主歌', 11, 31), ('  2c 守护', 20, 25), ('三 间奏', 31, 49), ('四 副歌', 49, 62), ('五 桥段', 62, 74), ('六 尾奏前段', 74, 85), ('七 结尾', 85, 89)]
for nm, b0, b1 in CH:
    sel = (tst >= bt(b0)) & (tst < bt(b1) - .4)
    seg = x[int(bt(b0) * sr):int(bt(b1) * sr)]; rms = 10 * np.log10((seg ** 2).mean() + 1e-12)
    print(f'  {nm:<8} 第 {b0}–{b1 - 1} 小节  平均 {rms:6.1f} dBFS  短时最大 {db[sel].max():6.1f}')
# 低频占比：20–120 Hz 与 120 Hz 以上
def band(sig, lo, hi):
    s = butter(4, [lo, hi], 'band', fs=sr, output='sos') if lo > 0 else butter(4, hi, 'low', fs=sr, output='sos'); return sosfilt(s, sig)
m20 = mono[20 * sr:]
lo_ = 10 * np.log10((band(m20, 20, 120) ** 2).mean() + 1e-12); hi_ = 10 * np.log10((band(m20, 120, 16000) ** 2).mean() + 1e-12)
pr_ = 10 * np.log10((band(m20, 2500, 6000) ** 2).mean() + 1e-12)
print(f'  20–120 Hz 相对 120 Hz–16 kHz：{lo_ - hi_:+.1f} dB；2.5–6 kHz（留给拟音的频段）相对：{pr_ - hi_:+.1f} dB')
ok(lo_ - hi_ < 0, '低频不压过中高频')
# 合书后余音
t_after = [(CLOSE + k, 10 * np.log10((x[int((CLOSE + k) * sr):int((CLOSE + k + .25) * sr)] ** 2).mean() + 1e-12)) for k in (0, .5, 1, 1.5, 2, 2.5, 3, 3.5)]
print('  合书后余音：' + '  '.join(f'{t:.1f}s {v:.0f}' for t, v in t_after))

if len(sys.argv) > 2:
    print('== 与开头配乐的衔接（同一套增益：开头分轨 drums + .95·music + 1.05·lead）')
    d_ = sys.argv[2]
    st_ = [sf.read(os.path.join(d_, k + '.wav'), dtype='float32', always_2d=True)[0] for k in ('drums', 'music', 'lead')]
    op = st_[0] + .95 * st_[1] + 1.05 * st_[2]
    def r(sig, a, b): s = sig[int(a * sr):int(b * sr)]; return 10 * np.log10((s ** 2).mean() + 1e-12)
    print(f'  开头 16–20 s（主题两小节）{r(op, 16, 19.9):.1f} dBFS · 开头 8–15.5 s（主歌）{r(op, 8, 15.5):.1f}')
    print(f'  全片 20–26 s（2a）{r(x, 20, 26):.1f} · 26–38 s（2b）{r(x, 26, 38):.1f} · 100–104 s（副歌主题）{r(x, 100, 104):.1f} · 116–120 s {r(x, 116, 120):.1f}')
print('== 结论：' + ('全部通过' if not fails else f'{len(fails)} 项不通过'))
sys.exit(1 if fails else 0)
