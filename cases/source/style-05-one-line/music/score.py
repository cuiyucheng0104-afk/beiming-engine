"""配乐：一把竖琴独奏（VCSL 真实采样），一条不断的旋律线跟着笔走；城市段加一段低音提琴拨弦（唯一的第二音色，
VSCO 2 CE 采样 + pluck.py 物理建模叠层）；重启那一声叠一个 pluck.py 竖琴泛音。G 大调。
所有音符时刻取自 out/timeline.json（timeline.js 导出）：关键音符就落在画面事件所在的拍上。
python music/score.py → out/music.wav + out/notes.json"""
import sys, os, json, numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as PL
from core.audio.sfx import SR, add, lp

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
TL = json.load(open(os.path.join(ROOT, 'out', 'timeline.json')))
HT, SECS, DUR = TL['HT'], {s['id']: s for s in TL['SECS']}, TL['DUR']
def B(sec, b):
    bt = SECS[sec]['beatT']; i = int(b); f = b - i
    return bt[-1] if i >= len(bt) - 1 else bt[i] + f * (bt[i + 1] - bt[i])

S.seed(5)
N = int((DUR + 1.0) * SR)
harp = np.zeros((N, 2), np.float32); bass = np.zeros((N, 2), np.float32)
notes = []                         # (t, 乐器, 音高, 对应画面事件)
PAN = .12                          # 竖琴在画家右手边一点

def h(t, p, v=.6, dur=2.2, hit=None, gain=1.0, pan=PAN):
    for pp in (p if isinstance(p, (list, tuple)) else [p]):
        add(harp, S.note('harp', pp, dur, vel=v), t, gain, pan)
    notes.append((round(t, 5), 'harp', p, hit))

# ---------- A 杯（0–4 s，120 BPM）：八分音符跟着笔的拐角 ----------
h(HT['enter'], ['G2', 'G4'], .62, 3.0, 'enter')
h(B('A', .5), 'A4', .48, 1.2)
h(HT['saucer'], 'B4', .58, 1.6, 'saucer')
h(B('A', 2.5), 'A4', .45, 1.0)
h(HT['cupBase'], 'G4', .55, 1.6, 'cupBase')
h(HT['rimL'], ['C3', 'D5'], .6, 2.0, 'rimL')
h(B('A', 4.5), 'C5', .46, 1.0)
h(HT['rimR'], 'B4', .55, 1.4, 'rimR')
h(B('A', 5.5), 'A4', .45, 1.0)
h(HT['handle'], ['D3', 'E5'], .62, 1.8, 'handle')
h(B('A', 6.5), 'D5', .48, 1.0)
h(HT['rimBack'], 'B4', .55, 1.4, 'rimBack')
h(B('A', 7.5), 'A4', .44, 1.6)
# ---------- B 热气 → 鸟（4–8 s）：长音慢慢上行，鸟成形是本段最高音 ----------
h(HT['steam'], ['G2', 'D4'], .5, 3.5, 'steam')
h(B('B', 1), 'G4', .46, 2.0)
h(HT['curl1'], ['E3', 'B4'], .52, 2.4, 'curl1')
h(B('B', 3), 'D5', .5, 2.0)
h(HT['wingR'], ['C3', 'G5'], .66, 3.0, 'wingR')
h(HT['body'], 'E5', .52, 1.6, 'body')
h(HT['wingL'], ['A2', 'C5'], .55, 2.0, 'wingL')
h(B('B', 7), 'B4', .48, 1.2)
h(B('B', 7.5), 'A4', .46, 1.2)
# ---------- C 城市（8–12 s，120→180 BPM）：竖琴八分 → 十六分，低音提琴拨弦每拍 ----------
mel = ['G4', 'B4', 'D5', 'B4', 'A4', 'C5', 'E5', 'C5', 'B4', 'D5', 'G5', 'D5', 'C5', 'E5', 'A5', 'E5', 'D5', 'F#5', 'A5', 'F#5']
bl = ['G2', 'B2', 'C3', 'D3', 'E3', 'D3', 'C3', 'B2', 'A2', 'D3']
k = 0
for b in range(10):
    t0, t1 = B('C', b), B('C', b + 1); hit = f'c{b}'
    sub = 2 if b < 7 else 4                                   # 最后三拍改十六分：加速到顶
    for j in range(sub):
        t = t0 + (t1 - t0) * j / sub
        p = mel[k % len(mel)] if sub == 2 else ['D5', 'G5', 'B5', 'G5'][j] if b < 9 else ['E5', 'A5', 'C6', 'A5'][j]
        h(t, p, (.56 if j == 0 else .44) + .02 * b, .9 if sub == 2 else .5, hit if j == 0 else None)
        k += 1
    # 低音提琴拨弦：采样 + 物理建模叠一层指腹的「噗」
    x = S.note('contrabass_pizz', bl[b], 1.0, vel=.66 + .02 * b)
    add(bass, x, t0, 1.0, -.15)
    y = PL.pluck('upright_bass_pizz', bl[b], .9, vel=.6)
    add(bass, y, t0, .35, -.15)
    notes.append((round(t0, 5), 'contrabass_pizz', bl[b], hit))

# ---------- 停笔（12.0–13.5）：音乐总线清零 ----------
# ---------- D 收拢（13.5–17.875，96 BPM）：一声低音重启，然后慢慢上行到全片最高音 ----------
h(HT['resume'], ['G2', 'G3'], .82, 4.0, 'resume', gain=1.25)
add(harp, PL.pluck('harp', 'G4', 3.5, vel=.7, harmonic=True), HT['resume'], .55, PAN)   # 物理建模泛音：钟一样的光
h(HT['nape'], 'B3', .5, 2.0, 'nape')
h(HT['collar'], ['E2', 'D4'], .52, 2.4, 'collar')
h(HT['chin'], 'G4', .55, 2.0, 'chin')
h(HT['smile'], ['C3', 'B4'], .6, 3.0, 'smile')           # 微笑：最温柔的一句
h(B('D', 4.5), 'A4', .42, 1.6)
h(HT['nose'], ['D3', 'D5'], .58, 2.4, 'nose')
h(B('D', 5.5), 'C5', .44, 1.6)
h(HT['eye'], ['E3', 'E5'], .6, 2.4, 'eye')
h(B('D', 6.5), 'F#5', .5, 1.8)
# 合拢：全片最高音 D6，琶音的 G 大三和弦托在下面，长鸣
# 合拢前 1/4 拍的小渐强：十六分上行琶音 G5–A5–B5–C6，力度一路抬高，把耳朵推到 D6 上
for j, (pp, vv) in enumerate([('G5', .40), ('A5', .46), ('B5', .52), ('C6', .58)]):
    h(HT['close'] - .25 + .0625 * j, pp, vv, .9, gain=.75 + .12 * j)
h(HT['close'], 'D6', .86, 5.0, 'close', gain=1.4)             # D6 比上一版高约 3 dB（力度 .72→.86 + 增益）：揭示要有落点
add(harp, S.chord('harp', ['G2', 'D3', 'G3', 'B3', 'D4', 'G4'], 5.0, .62, strum=.045), HT['close'], 1.05, PAN)
h(B('E', 1), 'B5', .36, 3.0)

mix = harp * 1.0 + bass * .9
mix = S.room(mix, size=.42, mix=.2)
# 静默：音乐总线（含混响尾巴）在停笔那一帧清零，15 ms 淡出；重启时直接进
a, b = int(HT['stop'] * SR), int(HT['resume'] * SR); f = int(.015 * SR)
g = np.ones(len(mix), np.float32); g[a:b] = 0; g[a - f:a] = np.linspace(1, 0, f)
mix *= g[:, None]
mix = mix / (np.abs(mix).max() + 1e-9) * .85
os.makedirs(os.path.join(ROOT, 'out'), exist_ok=True)
sf.write(os.path.join(ROOT, 'out', 'music.wav'), mix.astype(np.float32), SR)
json.dump(notes, open(os.path.join(ROOT, 'out', 'notes.json'), 'w'))
print('music.wav', round(len(mix) / SR, 2), 's,', len(notes), 'notes')
print('\n'.join(S.credits(['harp', 'contrabass_pizz'])))
